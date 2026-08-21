import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOsgjsToGlb, shouldSkipUntexturedShell } from "../lib/osgjs2gltf.js";
import { parseViewerMaterials } from "../lib/sf-api.js";

/**
 * A solid, untextured panel whose name happens to contain "glass".
 *
 * A robot's tinted faceplate is exactly this: one quad, a material with a
 * colour and no albedo texture. It was being dropped by a name test that
 * assumed anything called glass without a texture was an invisible rim shell.
 */
function glassScene(name = "Head_Glass_0") {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const idx = new Uint8Array([0, 1, 2, 0, 2, 3]);
  const bin = new Uint8Array(verts.byteLength + idx.byteLength);
  bin.set(new Uint8Array(verts.buffer), 0);
  bin.set(idx, verts.byteLength);
  return {
    bin,
    osgjs: {
      "osg.Node": {
        Name: "root",
        Children: [{
          "osg.Geometry": {
            Name: name,
            PrimitiveSetList: [{
              DrawElementsUByte: {
                Indices: {
                  Array: { Uint8Array: { Offset: verts.byteLength, Size: 6, File: "model_file.bin" } },
                  ItemSize: 1, Type: "ELEMENT_ARRAY_BUFFER",
                },
                Mode: "TRIANGLES",
              },
            }],
            VertexAttributeList: {
              Vertex: {
                Array: { Float32Array: { Offset: 0, Size: 4, File: "model_file.bin" } },
                ItemSize: 3, Type: "ARRAY_BUFFER",
              },
            },
          },
        }],
      },
    },
  };
}

/** A viewer material with a solid tint and no textures at all. */
const solidTint = (name, color, extra = {}) =>
  parseViewerMaterials({
    options: {
      materials: {
        m1: {
          name,
          channels: {
            AlbedoPBR: { enable: true, factor: 1, color },
            MetalnessPBR: { enable: true, factor: 0 },
            ...extra,
          },
        },
      },
    },
  });

test("an untextured glass panel survives conversion", async () => {
  const { osgjs, bin } = glassScene();
  const res = await convertOsgjsToGlb(osgjs, bin, bin, [], solidTint("Glass", [0, 0, 0]));
  assert.equal(res.geometryCount, 1, "the faceplate is kept");
  assert.equal(res.json.meshes.length, 1);
});

test("its tint comes through rather than defaulting to white", async () => {
  const { osgjs, bin } = glassScene();
  const res = await convertOsgjsToGlb(osgjs, bin, bin, [], solidTint("Glass", [0, 0, 0]));
  const mat = res.json.materials[res.json.meshes[0].primitives[0].material];
  assert.deepEqual(mat.pbrMetallicRoughness.baseColorFactor, [0, 0, 0, 1]);
});

test("a mesh the viewer marks invisible is still skipped", () => {
  // The real signal, as opposed to a guess about the name. Asserted on the
  // decision function rather than through a conversion: what matters is that
  // evidence from the viewer still drops a mesh now the name test is gone.
  const vm = solidTint("Glass", [0, 0, 0], {
    Opacity: { enable: true, factor: 0, type: "alphaBlend" },
  });
  const spec = vm.get("Glass");
  assert.equal(spec.skipMesh, true, "opacity 0 means the viewer is not drawing it");
  assert.equal(shouldSkipUntexturedShell(spec, "Glass", "Head_Glass_0", "TRIANGLES"), true);
});

test("a visible glass material is not skipped, textured or not", () => {
  const spec = solidTint("Glass", [0, 0, 0]).get("Glass");
  assert.equal(spec.skipMesh, false);
  assert.equal(shouldSkipUntexturedShell(spec, "Glass", "Head_Glass_0", "TRIANGLES"), false);
});

test("the name alone decides nothing", async () => {
  // Same geometry, innocuous name: identical outcome either way.
  for (const name of ["Head_Glass_0", "Head_Panel_0"]) {
    const { osgjs, bin } = glassScene(name);
    const res = await convertOsgjsToGlb(osgjs, bin, bin, [], solidTint("Glass", [0.2, 0.2, 0.2]));
    assert.equal(res.geometryCount, 1, name);
  }
});

test("refractive glass at opacity 0 is transmissive, not invisible", () => {
  // Sketchfab's refractive opacity runs opposite to an alpha blend: factor 0 is
  // clear glass. Reading it as invisible dropped the mesh before
  // KHR_materials_transmission could be written, leaving that export dead --
  // a fixture built to exercise it never once reached the output.
  const spec = solidTint("M14_Transmission_Glass", [1, 1, 1], {
    Opacity: { enable: true, factor: 0, type: "refraction" },
  }).get("M14_Transmission_Glass");
  assert.equal(spec.transmission, true);
  assert.equal(spec.skipMesh, false, "clear glass is still geometry");
});

test("an alpha-blended mesh at opacity 0 really is invisible", () => {
  // The same number means the opposite thing under the other opacity model,
  // which is why the exception is scoped to refraction alone.
  const spec = solidTint("Veil", [1, 1, 1], {
    Opacity: { enable: true, factor: 0, type: "alphaBlend" },
  }).get("Veil");
  assert.equal(spec.transmission, false);
  assert.equal(spec.skipMesh, true);
});
