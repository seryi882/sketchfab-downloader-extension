import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOsgjsToGlb, shouldSkipUntexturedShell } from "../lib/osgjs2gltf.js";

/**
 * Line geometry as Sketchfab stores it: DrawElementsUByte, mode LINES, a
 * Vertex array and nothing else. `wireframe` puts the index array in the
 * wireframe buffer, which is the only thing separating the viewer's own
 * overlay from an authored wireframe cube.
 */
function lineScene({ wireframe = false } = {}) {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const idx = new Uint8Array([0, 1, 1, 2, 2, 3, 3, 0]); // 4 segments
  const bin = new Uint8Array(verts.byteLength + idx.byteLength);
  bin.set(new Uint8Array(verts.buffer), 0);
  bin.set(idx, verts.byteLength);

  const file = wireframe ? "model_file_wireframe.bin" : "model_file.bin";
  return {
    bin,
    osgjs: {
      "osg.Node": {
        Name: "root",
        Children: [{
          "osg.Geometry": {
            Name: "L01_Lines",
            PrimitiveSetList: [{
              DrawElementsUByte: {
                Indices: {
                  Array: { Uint8Array: { Offset: verts.byteLength, Size: 8, File: file } },
                  ItemSize: 1, Type: "ELEMENT_ARRAY_BUFFER",
                },
                Mode: "LINES",
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

test("authored line geometry converts to glTF LINES", async () => {
  const { osgjs, bin } = lineScene();
  const res = await convertOsgjsToGlb(osgjs, bin, bin, []);
  assert.equal(res.geometryCount, 1);
  const prim = res.json.meshes[0].primitives[0];
  assert.equal(prim.mode, 1, "glTF LINES");
  assert.equal(res.json.accessors[prim.indices].count, 8, "4 segments kept whole");
  assert.deepEqual(Object.keys(prim.attributes), ["POSITION"]);
});

test("the viewer's wireframe overlay is still discarded", async () => {
  // Sketchfab draws one for every geometry. Accepting LINES without checking
  // which buffer the indices came from would give every mesh an edge-only
  // duplicate.
  const { osgjs, bin } = lineScene({ wireframe: true });
  await assert.rejects(
    () => convertOsgjsToGlb(osgjs, bin, bin, []),
    /No triangle geometries found/,
    "an overlay on its own leaves nothing to convert"
  );
});

test("indices are kept as segments, not unrolled", async () => {
  // Sketchfab expands LINE_STRIP and LINE_LOOP into explicit segments on
  // import -- a 49-point strip arrives as 96 indices, a 5-point loop as 10
  // with the closing edge present -- so mode 1 is all that ever arrives and
  // there is no strip to unroll.
  const { osgjs, bin } = lineScene();
  const res = await convertOsgjsToGlb(osgjs, bin, bin, []);
  const prim = res.json.meshes[0].primitives[0];
  assert.equal(res.json.accessors[prim.indices].count % 2, 0, "whole segments");
});

test("a line material is not mistaken for an untextured shell", () => {
  // The hair/lash heuristic looks for "line" among names, which a genuine line
  // material matches by definition -- and lines never carry an albedo, so
  // every one would be dropped.
  const spec = { albedoUid: null, opacityUid: null, skipMesh: false };
  assert.equal(shouldSkipUntexturedShell(spec, "ML01_Lines", "L01_Lines", "LINES"), false);
  assert.equal(shouldSkipUntexturedShell(spec, "ML04_Points", "L04_Points", "POINTS"), false);
  // Triangles keep the old behaviour.
  assert.equal(shouldSkipUntexturedShell(spec, "Hair_line", "Hair", "TRIANGLES"), true);
});

test("an invisible line mesh is still skipped", () => {
  // Only the name guess is scoped to triangles; a mesh the viewer hides stays
  // hidden whatever it is drawn with.
  const spec = { albedoUid: null, opacityUid: null, skipMesh: true };
  assert.equal(shouldSkipUntexturedShell(spec, "ML01_Lines", "L01_Lines", "LINES"), true);
});
