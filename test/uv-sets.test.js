import { test } from "node:test";
import assert from "node:assert/strict";
import { uvQuantBox } from "../lib/osgjs2gltf.js";

/**
 * Metadata as Sketchfab actually writes it for a mesh whose material carries
 * five textures: the UV attributes are TexCoord1/3/5/7/8, every unit gets a
 * bits+mode pair, and only the first gets a bounding box. Values are from a
 * model whose materials span eight texture units.
 */
const FIVE_UNIT_META = {
  attributes: 4,
  uv_0_mode: 0,
  uv_1_bbl_x: -1.98682e-8, uv_1_bbl_y: 0,
  uv_1_h_x: 0.000122085, uv_1_h_y: 0.000122085,
  uv_1_bits: 14, uv_1_mode: 3,
  uv_2_mode: 0,
  uv_3_bits: 14, uv_3_mode: 3,
  uv_4_mode: 0,
  uv_5_bits: 14, uv_5_mode: 3,
  uv_6_mode: 0,
  uv_7_bits: 14, uv_7_mode: 3,
  uv_8_bits: 14, uv_8_mode: 3,
};

test("uvQuantBox uses a unit's own box when it has one", () => {
  const box = uvQuantBox(FIVE_UNIT_META, "1");
  assert.deepEqual(box.bbl, [-1.98682e-8, 0]);
  assert.deepEqual(box.h, [0.000122085, 0.000122085]);
});

test("uvQuantBox falls back to the first boxed unit for later sets", () => {
  // Units 3/5/7/8 carry bits+mode but no box. Without the fallback they skip
  // dequantization and ship as raw 14-bit integers, ~8191x too large.
  for (const unit of ["3", "5", "7", "8"]) {
    const box = uvQuantBox(FIVE_UNIT_META, unit);
    assert.ok(box, `unit ${unit} must resolve a box`);
    assert.deepEqual(box.h, [0.000122085, 0.000122085]);
  }
});

test("uvQuantBox picks the lowest boxed unit, not the first key seen", () => {
  // Key order is not numeric order, and JS object key order puts uv_12_ before
  // uv_3_ under a lexicographic sort.
  const meta = {
    uv_12_bbl_x: 5, uv_12_bbl_y: 5, uv_12_h_x: 9, uv_12_h_y: 9,
    uv_3_bbl_x: 0, uv_3_bbl_y: 0, uv_3_h_x: 1, uv_3_h_y: 1,
    uv_18_mode: 3,
  };
  assert.deepEqual(uvQuantBox(meta, "18").h, [1, 1]);
});

test("uvQuantBox returns null when no unit carries a box", () => {
  assert.equal(uvQuantBox({ uv_1_bits: 14, uv_1_mode: 3 }, "1"), null);
});

/* --- texture unit -> glTF texCoord -------------------------------------- */
import { texCoordsForGeometry } from "../lib/osgjs2gltf.js";

test("texCoordsForGeometry leaves single-UV meshes alone", () => {
  // The common case by a wide margin: one UV set, so every binding is index 0
  // and the material cache key must not change.
  const map = { uvUnits: { albedo: 1, normal: 1 } };
  assert.deepEqual(texCoordsForGeometry(map, [1]), {});
});

test("texCoordsForGeometry maps a sparse unit onto its dense index", () => {
  // M17_TwoUVSets on r3_01: albedo samples unit 1, the lightmap samples unit 3,
  // and the mesh carries TexCoord1 + TexCoord3 -> TEXCOORD_0 + TEXCOORD_1.
  const map = { uvUnits: { albedo: 1, emissive: 3 } };
  assert.deepEqual(texCoordsForGeometry(map, [1, 3]), { emissive: 1 });
});

test("texCoordsForGeometry handles multi-digit units in numeric order", () => {
  const map = { uvUnits: { albedo: 3, normal: 12, emissive: 18 } };
  assert.deepEqual(texCoordsForGeometry(map, [3, 12, 18]), { normal: 1, emissive: 2 });
});

test("texCoordsForGeometry falls back to 0 for a unit with no UV data", () => {
  // A channel can name a unit the geometry never supplied. Index 0 is the only
  // safe answer -- a dangling texCoord would reference a missing accessor.
  const map = { uvUnits: { albedo: 1, emissive: 9 } };
  assert.deepEqual(texCoordsForGeometry(map, [1, 3]), {});
});

test("texCoordsForGeometry ignores roles with no recorded unit", () => {
  const map = { uvUnits: { albedo: 1, normal: undefined } };
  assert.deepEqual(texCoordsForGeometry(map, [1, 3]), {});
});
