import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOsgjsToGlb } from "../lib/osgjs2gltf.js";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  )
);

/** One triangle per material name, all sharing a single image. */
function scene(names) {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const idx = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(verts.byteLength + idx.byteLength);
  bin.set(new Uint8Array(verts.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), verts.byteLength);

  // Float32Array views must start on a 4-byte boundary, so the index block is
  // padded before the UVs rather than packed tight.
  const uvOffset = (bin.byteLength + 3) & ~3;
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bin2 = new Uint8Array(uvOffset + uv.byteLength);
  bin2.set(bin, 0);
  bin2.set(new Uint8Array(uv.buffer), uvOffset);

  return {
    bin: bin2,
    osgjs: {
      "osg.Node": {
        Name: "root",
        Children: names.map((n) => ({
          "osg.Geometry": {
            Name: n,
            PrimitiveSetList: [
              {
                DrawElementsUInt: {
                  Indices: {
                    Array: { Uint16Array: { Offset: verts.byteLength, Size: 3 } },
                    ItemSize: 1,
                    Type: "ELEMENT_ARRAY_BUFFER",
                  },
                  Mode: "TRIANGLES",
                },
              },
            ],
            VertexAttributeList: {
              Vertex: {
                Array: { Float32Array: { Offset: 0, Size: 3 } },
                ItemSize: 3,
                Type: "ARRAY_BUFFER",
              },
              TexCoord0: {
                Array: { Float32Array: { Offset: uvOffset, Size: 3 } },
                ItemSize: 2,
                Type: "ARRAY_BUFFER",
              },
            },
          },
        })),
      },
    },
  };
}

const TEX_UID = "3e340a3cbe1348c489f7a48af9039d5b";
const textures = [{ uid: TEX_UID, name: "albedo_pot_strip.png", data: PNG_1X1 }];

/** A viewer material bound to the shared image with the given wrap mode. */
function material(name, wrap) {
  return [
    name,
    {
      id: name,
      name,
      albedoUid: TEX_UID,
      textureWraps: { [TEX_UID]: wrap },
      texCoordUnits: { [TEX_UID]: 0 },
      metallicFactor: 0,
      roughnessFactor: 0.9,
      baseColorFactor: [1, 1, 1, 1],
    },
  ];
}

test("a repeating texture reuses the default sampler", async () => {
  const { osgjs, bin } = scene(["Mat"]);
  const vm = new Map([material("Mat", { wrapS: "REPEAT", wrapT: "REPEAT" })]);
  const res = await convertOsgjsToGlb(osgjs, bin, null, textures, vm);
  assert.equal(res.json.samplers.length, 1, "no extra sampler for the default");
  assert.equal(res.json.textures[0].sampler, 0);
});

test("clamp and mirror each get their own sampler", async () => {
  const { osgjs, bin } = scene(["Clamped", "Mirrored"]);
  const vm = new Map([
    material("Clamped", { wrapS: "CLAMP_TO_EDGE", wrapT: "CLAMP_TO_EDGE" }),
    material("Mirrored", { wrapS: "MIRRORED_REPEAT", wrapT: "MIRRORED_REPEAT" }),
  ]);
  const res = await convertOsgjsToGlb(osgjs, bin, null, textures, vm);
  const wraps = res.json.samplers.map((s) => `${s.wrapS}/${s.wrapT}`);
  assert.ok(wraps.includes("33071/33071"), "CLAMP_TO_EDGE");
  assert.ok(wraps.includes("33648/33648"), "MIRRORED_REPEAT");
});

test("one image used at two wrap modes becomes two textures, one source", async () => {
  // A glTF texture is an image plus a sampler. Sharing the texture entry would
  // silently give both materials whichever wrap mode was written first.
  const { osgjs, bin } = scene(["Clamped", "Repeating"]);
  const vm = new Map([
    material("Clamped", { wrapS: "CLAMP_TO_EDGE", wrapT: "CLAMP_TO_EDGE" }),
    material("Repeating", { wrapS: "REPEAT", wrapT: "REPEAT" }),
  ]);
  const res = await convertOsgjsToGlb(osgjs, bin, null, textures, vm);
  assert.equal(res.json.textures.length, 2);
  assert.equal(res.json.images.length, 1, "the image itself is embedded once");
  const samplers = new Set(res.json.textures.map((t) => t.sampler));
  assert.equal(samplers.size, 2);
});

test("mixed wrap axes are kept apart", async () => {
  const { osgjs, bin } = scene(["Mat"]);
  const vm = new Map([material("Mat", { wrapS: "CLAMP_TO_EDGE", wrapT: "REPEAT" })]);
  const res = await convertOsgjsToGlb(osgjs, bin, null, textures, vm);
  const s = res.json.samplers[res.json.textures[0].sampler];
  assert.equal(s.wrapS, 33071);
  assert.equal(s.wrapT, 10497);
});
