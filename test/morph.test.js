import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleScalar, mergeWeightCurves } from "../lib/osgjs2gltf.js";

const curve = (times, values) => ({ times, values });

test("sampling returns keyed values exactly", () => {
  assert.equal(sampleScalar([0, 1, 2], [0, 5, 10], 1), 5);
});

test("sampling interpolates between keys", () => {
  assert.equal(sampleScalar([0, 2], [0, 10], 1), 5);
});

test("sampling clamps outside the curve", () => {
  assert.equal(sampleScalar([1, 2], [3, 4], 0), 3);
  assert.equal(sampleScalar([1, 2], [3, 4], 9), 4);
});

test("sampling survives a zero-length span", () => {
  assert.equal(sampleScalar([1, 1], [7, 9], 1), 7);
});

test("weights from several targets interleave into one output", () => {
  // glTF stores every target's weight per keyframe, so slot order has to be
  // preserved: target 1's value must not land in target 0's position.
  const merged = mergeWeightCurves(
    [
      { index: 0, curve: curve([0, 1], [0, 1]) },
      { index: 1, curve: curve([0, 1], [1, 0]) },
    ],
    2
  );
  assert.deepEqual([...merged.times], [0, 1]);
  assert.deepEqual([...merged.values], [0, 1, 1, 0]);
});

test("curves keyed at different times are resampled onto the union", () => {
  const merged = mergeWeightCurves(
    [
      { index: 0, curve: curve([0, 2], [0, 2]) },
      { index: 1, curve: curve([1], [9]) },
    ],
    2
  );
  assert.deepEqual([...merged.times], [0, 1, 2]);
  // target 0 is read at t=1 where it has no key; target 1 clamps either side
  assert.deepEqual([...merged.values], [0, 9, 1, 9, 2, 9]);
});

test("a target with no curve stays at rest instead of shifting the others", () => {
  const merged = mergeWeightCurves([{ index: 2, curve: curve([0], [1]) }], 3);
  assert.deepEqual([...merged.values], [0, 0, 1]);
});

test("an out-of-range slot is ignored rather than corrupting the output", () => {
  const merged = mergeWeightCurves(
    [
      { index: 0, curve: curve([0], [1]) },
      { index: 5, curve: curve([0], [1]) },
    ],
    2
  );
  assert.deepEqual([...merged.values], [1, 0]);
});

test("no keys at all yields no sampler", () => {
  assert.equal(mergeWeightCurves([{ index: 0, curve: curve([], []) }], 1), null);
});
