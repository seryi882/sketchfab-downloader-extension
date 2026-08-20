import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_MAT4,
  mat4Multiply,
  isIdentityMat4,
  normalMatrixFromMat4,
} from "../lib/osg-scene.js";

/** Column-major TRS-ish helper: scale then translate. */
function scaleTranslate(sx, sy, sz, tx, ty, tz) {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, tx, ty, tz, 1];
}

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

test("identity is recognised", () => {
  assert.equal(isIdentityMat4(IDENTITY_MAT4), true);
  assert.equal(isIdentityMat4(scaleTranslate(1, 1, 1, 0, 0, 1)), false);
});

test("a parent transform composes onto a child", () => {
  // Nested placement is the case a flat converter loses: the child has to end
  // up at parent + child, not at either one alone.
  const parent = scaleTranslate(1, 1, 1, 10, 0, 0);
  const child = scaleTranslate(1, 1, 1, 2, 3, 0);
  const world = mat4Multiply(parent, child);
  assert.deepEqual(apply(world, [0, 0, 0]), [12, 3, 0]);
});

test("scale applies before the parent's translation", () => {
  const parent = scaleTranslate(2, 2, 2, 5, 0, 0);
  const child = scaleTranslate(1, 1, 1, 1, 0, 0);
  const world = mat4Multiply(parent, child);
  assert.deepEqual(apply(world, [0, 0, 0]), [7, 0, 0]);
});

test("a point moves by the placement's translation", () => {
  const m = scaleTranslate(1, 1, 1, -6, 1, 0);
  assert.deepEqual(apply(m, [0.5, 0, 0]), [-5.5, 1, 0]);
});

test("uniform scale leaves the normal direction unchanged", () => {
  const nm = normalMatrixFromMat4(scaleTranslate(2, 2, 2, 9, 9, 9));
  const n = [nm[0] * 1 + nm[3] * 0 + nm[6] * 0, nm[1], nm[2]];
  const len = Math.hypot(...n);
  assert.ok(Math.abs(n[0] / len - 1) < 1e-9);
});

test("non-uniform scale tilts the normal opposite to the surface", () => {
  // Stretching x by 2 must *shrink* the normal's x, or lighting goes wrong.
  // Reusing the placement matrix would do the opposite, which is the bug this
  // guards against.
  const nm = normalMatrixFromMat4(scaleTranslate(2, 1, 1, 0, 0, 0));
  const nx = nm[0];
  const ny = nm[4];
  assert.ok(nx < ny, `expected x component ${nx} to shrink relative to y ${ny}`);
});

test("a singular placement degrades instead of producing NaN", () => {
  const nm = normalMatrixFromMat4(scaleTranslate(0, 0, 0, 1, 2, 3));
  assert.ok(nm.every((v) => Number.isFinite(v)));
});

test("translation alone does not affect normals", () => {
  const nm = normalMatrixFromMat4(scaleTranslate(1, 1, 1, 4, 5, 6));
  assert.deepEqual([...nm], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});
