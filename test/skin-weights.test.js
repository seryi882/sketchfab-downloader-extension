import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeInfluences } from "../lib/osgjs2gltf.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~= ${b}`);

test("a valid vertex passes through untouched", () => {
  const [j, w] = sanitizeInfluences([3, 7, 1, 0], [0.5, 0.25, 0.25, 0], 16);
  assert.deepEqual(j, [3, 7, 1, 0]);
  assert.deepEqual(w, [0.5, 0.25, 0.25, 0]);
});

test("a zero-weight slot carries joint 0", () => {
  // Sketchfab fills all four slots with bone indices whether or not it weights
  // them. Legal for its renderer; 276,865 warnings for glTF's.
  const [j, w] = sanitizeInfluences([3, 7, 9, 4], [1, 0, 0, 0], 16);
  assert.deepEqual(j, [3, 0, 0, 0]);
  assert.deepEqual(w, [1, 0, 0, 0]);
});

test("an index past the end of the BoneMap loses its weight, not its bone", () => {
  // The real defect: clamping a stray index to 0 kept its weight, so bone 0
  // appeared twice and the remaining weights no longer summed to 1. This is
  // the vertex from mesh 18 of the low-poly compilation.
  const [j, w] = sanitizeInfluences([0, 99, 0, 0], [0.928371, 0.071629, 0, 0], 10);
  assert.deepEqual(j, [0, 0, 0, 0]);
  close(w[0], 1);
  assert.deepEqual([w[1], w[2], w[3]], [0, 0, 0]);
});

test("the same bone twice is one influence", () => {
  const [j, w] = sanitizeInfluences([5, 5, 2, 0], [0.3, 0.2, 0.5, 0], 16);
  assert.deepEqual(j, [5, 2, 0, 0]);
  close(w[0], 0.5);
  close(w[1], 0.5);
});

test("dropping an influence renormalises the rest", () => {
  const [, w] = sanitizeInfluences([1, 2, 99, 0], [0.4, 0.4, 0.2, 0], 10);
  close(w[0] + w[1], 1);
  close(w[0], 0.5);
});

test("weights that already sum to 1 are not divided", () => {
  const [, w] = sanitizeInfluences([1, 2, 0, 0], [0.7, 0.3, 0, 0], 8);
  assert.equal(w[0], 0.7);
  assert.equal(w[1], 0.3);
});

test("negative and NaN weights are dropped", () => {
  const [j, w] = sanitizeInfluences([1, 2, 3, 4], [1, -0.5, NaN, 0], 8);
  assert.deepEqual(j, [1, 0, 0, 0]);
  assert.deepEqual(w, [1, 0, 0, 0]);
});

test("a vertex with no usable influence stays unweighted", () => {
  const [j, w] = sanitizeInfluences([99, 99, 99, 99], [0.25, 0.25, 0.25, 0.25], 4);
  assert.deepEqual(j, [0, 0, 0, 0]);
  assert.deepEqual(w, [0, 0, 0, 0]);
});

test("surviving influences pack to the front", () => {
  const [j, w] = sanitizeInfluences([0, 4, 0, 6], [0, 0.5, 0, 0.5], 8);
  assert.deepEqual(j, [4, 6, 0, 0]);
  assert.deepEqual(w, [0.5, 0.5, 0, 0]);
});

test("no output vertex ever repeats a weighted joint", () => {
  // Property check over the shapes the reader can hand us.
  for (let t = 0; t < 500; t++) {
    const boneCount = 1 + (t % 12);
    const js = [0, 1, 2, 3].map(() => Math.floor(Math.random() * 20));
    const ws = [0, 1, 2, 3].map(() => (Math.random() < 0.4 ? 0 : Math.random()));
    const [j, w] = sanitizeInfluences(js, ws, boneCount);
    const used = j.filter((_, k) => w[k] > 0);
    assert.equal(new Set(used).size, used.length, `repeat in ${JSON.stringify(j)}`);
    for (let k = 0; k < 4; k++) if (w[k] === 0) assert.equal(j[k], 0);
    const sum = w.reduce((a, c) => a + c, 0);
    if (sum > 0) close(sum, 1);
  }
});
