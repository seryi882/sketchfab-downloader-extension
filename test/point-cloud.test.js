import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOsgjsToGlb } from "../lib/osgjs2gltf.js";

/**
 * A point cloud as Sketchfab stores one: a single osg.Geometry drawing straight
 * from the vertex array with DrawArrays/POINTS, carrying nothing but position
 * and colour. Shape taken from a point cloud that uploads, processes and
 * renders on Sketchfab.
 */
function pointCloudScene(count = 4) {
  const verts = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    verts[i * 3] = i;
    verts[i * 3 + 1] = i * 2;
    verts[i * 3 + 2] = i * 3;
  }
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count * 4; i++) colors[i] = (i * 7) % 256;

  const bin = new Uint8Array(verts.byteLength + colors.byteLength);
  bin.set(new Uint8Array(verts.buffer), 0);
  bin.set(colors, verts.byteLength);

  const osgjs = {
    "osg.Node": {
      Name: "root",
      Children: [
        {
          "osg.Geometry": {
            Name: "cloud",
            PrimitiveSetList: [
              { DrawArrays: { UniqueID: 5, Count: count, First: 0, Mode: "POINTS" } },
            ],
            VertexAttributeList: {
              Vertex: {
                Array: { Float32Array: { Offset: 0, Size: count, File: "model_file.bin" } },
                ItemSize: 3,
                Type: "ARRAY_BUFFER",
              },
              Color: {
                Array: {
                  Uint8Array: { Offset: verts.byteLength, Size: count, File: "model_file.bin" },
                },
                ItemSize: 4,
                Type: "ARRAY_BUFFER",
              },
            },
          },
        },
      ],
    },
  };
  return { osgjs, bin, count };
}

test("a point cloud converts instead of throwing", async () => {
  // Before: "No triangle geometries found in osgjs". Sketchfab renders these
  // fine, so refusing them was a gap in the converter, not a limitation.
  const { osgjs, bin, count } = pointCloudScene();
  const res = await convertOsgjsToGlb(osgjs, bin, null, []);
  assert.equal(res.geometryCount, 1);
  const prim = res.json.meshes[0].primitives[0];
  assert.equal(prim.mode, 0, "glTF POINTS");
  assert.equal(prim.indices, undefined, "POINTS draws unindexed");
  assert.equal(res.json.accessors[prim.attributes.POSITION].count, count);
});

test("a point cloud keeps its vertex colours", async () => {
  // Colour is normally dropped as an engine tint. On a point cloud it is the
  // only surface information there is, so dropping it leaves a grey blob.
  const { osgjs, bin, count } = pointCloudScene();
  const res = await convertOsgjsToGlb(osgjs, bin, null, []);
  const prim = res.json.meshes[0].primitives[0];
  const acc = res.json.accessors[prim.attributes.COLOR_0];
  assert.ok(acc, "COLOR_0 must survive");
  assert.equal(acc.count, count);
  assert.equal(acc.type, "VEC4");
  assert.equal(acc.componentType, 5121, "unsigned byte");
  assert.equal(acc.normalized, true, "integer colours must be normalized");
});

/** The same scene as a triangle mesh, with colours supplied by `fill`. */
async function triangleWithColors(fill) {
  const { osgjs, bin } = pointCloudScene();
  const count = 4;
  const colors = new Uint8Array(count * 4);
  fill(colors);
  bin.set(colors, count * 3 * 4);

  const idx = new Uint16Array([0, 1, 2]);
  const withIdx = new Uint8Array(bin.byteLength + idx.byteLength);
  withIdx.set(bin, 0);
  withIdx.set(new Uint8Array(idx.buffer), bin.byteLength);

  const geom = osgjs["osg.Node"].Children[0]["osg.Geometry"];
  geom.PrimitiveSetList = [
    {
      DrawElementsUInt: {
        Indices: {
          Array: { Uint16Array: { Offset: bin.byteLength, Size: 3 } },
          ItemSize: 1,
          Type: "ELEMENT_ARRAY_BUFFER",
        },
        Mode: "TRIANGLES",
      },
    },
  ];
  const res = await convertOsgjsToGlb(osgjs, withIdx, null, []);
  return res.json.meshes[0].primitives[0];
}

test("a constant tint is still dropped on a triangle mesh", async () => {
  // Sketchfab attaches a Color attribute to most geometries whether or not the
  // author painted one. Blender multiplies baseColorTexture by COLOR_0, so
  // exporting an unpainted tint makes a textured model look wrong.
  const prim = await triangleWithColors((c) => c.fill(128));
  assert.equal(prim.mode, 4);
  assert.ok(prim.indices !== undefined, "triangles stay indexed");
  assert.equal(prim.attributes.COLOR_0, undefined);
});

test("genuine vertex colour survives on a triangle mesh", async () => {
  // A painted mesh has no other record of its colour, and variation is what
  // separates it from the engine tint.
  const prim = await triangleWithColors((c) => {
    for (let i = 0; i < c.length; i++) c[i] = (i * 37) % 256;
  });
  assert.equal(prim.mode, 4);
  const acc = prim.attributes.COLOR_0;
  assert.ok(acc !== undefined, "painted colour must survive");
});

test("a single-colour point cloud keeps its colour anyway", async () => {
  // Variation is the test for triangle meshes; for a point cloud the colour is
  // the only surface information there is, uniform or not.
  const { osgjs, bin, count } = pointCloudScene();
  bin.fill(200, count * 3 * 4);
  const res = await convertOsgjsToGlb(osgjs, bin, null, []);
  const prim = res.json.meshes[0].primitives[0];
  assert.equal(prim.mode, 0);
  assert.ok(prim.attributes.COLOR_0 !== undefined);
});
