import { test } from "node:test";
import assert from "node:assert/strict";
import { khrTextureTransform } from "../lib/osgjs2gltf.js";

/**
 * Sketchfab's viewer computes `uv' = mat2(UVTransforms) * uv + UVOffset` and
 * fills that column-major mat2 with vec4(cos*sx, -sin*sy, sin*sx, cos*sy),
 * i.e. S.R -- rotate, then scale. glTF specifies translation * rotation *
 * scale, i.e. R.S. Same rotation sign, opposite order.
 */

test("offset and scale pass straight through", () => {
  const { ext, exact } = khrTextureTransform({
    offset: [0.25, 0.5], scale: [2, 3], rotation: 0,
  });
  assert.deepEqual(ext.offset, [0.25, 0.5]);
  assert.deepEqual(ext.scale, [2, 3]);
  assert.equal(ext.rotation, undefined, "an identity rotation is omitted");
  assert.equal(exact, true, "with no rotation the two orders agree");
});

test("a uniform scale with rotation is still exact", () => {
  // Scalar scaling commutes with rotation, so S.R == R.S.
  const { ext, exact } = khrTextureTransform({
    offset: [0, 0], scale: [3, 3], rotation: Math.PI / 4,
  });
  assert.equal(ext.rotation, Math.PI / 4);
  assert.deepEqual(ext.scale, [3, 3]);
  assert.equal(ext.offset, undefined, "a zero offset is omitted");
  assert.equal(exact, true);
});

test("a non-uniform scale with rotation is reported inexact", () => {
  // M01_Albedo_POT_2048 on r3_01. S.R is a shear no R'.S' equals, so
  // KHR_texture_transform cannot express it and the caller must be told.
  const { ext, exact } = khrTextureTransform({
    offset: [0.25, 0], scale: [2, 1], rotation: Math.PI / 6,
  });
  assert.equal(exact, false);
  assert.deepEqual(ext.scale, [2, 1], "still exported as the closest match");
  assert.equal(ext.rotation, Math.PI / 6);
});

test("a mirrored scale is not uniform, equal magnitudes notwithstanding", () => {
  // [-2, 2] is a reflection times a scale, and reflection does not commute
  // with rotation: S.R and R.S disagree in the off-diagonal sign.
  const { exact } = khrTextureTransform({
    offset: [0, 0], scale: [-2, 2], rotation: 1,
  });
  assert.equal(exact, false);
});

test("an identity transform emits nothing", () => {
  const { ext } = khrTextureTransform({ offset: [0, 0], scale: [1, 1], rotation: 0 });
  assert.deepEqual(ext, {});
});

/* --- the sign convention, checked against the viewer's own matrix -------- */

test("the exported transform reproduces the viewer's matrix when orders agree", () => {
  // Rebuild Sketchfab's mat2 from its shader code and glTF's R.S from the
  // spec, and require them equal for the cases we claim are exact.
  const sketchfab = (sx, sy, r) => {
    const c = Math.cos(r), s = Math.sin(r);
    // vec4(c*sx, -s*sy, s*sx, c*sy) read column-major
    return [c * sx, s * sx, -s * sy, c * sy]; // row-major [m00,m01,m10,m11]
  };
  const gltf = (sx, sy, r) => {
    const c = Math.cos(r), s = Math.sin(r);
    // rotation [[c, s], [-s, c]] times scale diag(sx, sy)
    return [c * sx, s * sy, -s * sx, c * sy];
  };
  for (const [sx, sy, r] of [[2, 3, 0], [3, 3, 0.7], [1, 1, 1.2], [-2, -2, 0.4], [-2, 2, 0.4]]) {
    const a = sketchfab(sx, sy, r), b = gltf(sx, sy, r);
    const { exact } = khrTextureTransform({ offset: [0, 0], scale: [sx, sy], rotation: r });
    if (!exact) continue;
    for (let i = 0; i < 4; i++) {
      assert.ok(
        Math.abs(a[i] - b[i]) < 1e-12,
        `scale [${sx},${sy}] rot ${r}: element ${i} ${a[i]} vs ${b[i]}`
      );
    }
  }
});

test("the inexact case really does differ, so the warning is not noise", () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const sx = 2, sy = 1;
  const sketchfab = [c * sx, s * sx, -s * sy, c * sy];
  const gltf = [c * sx, s * sy, -s * sx, c * sy];
  const differs = sketchfab.some((v, i) => Math.abs(v - gltf[i]) > 1e-9);
  assert.ok(differs, "S.R and R.S must actually diverge here");
});
