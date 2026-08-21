import { test } from "node:test";
import assert from "node:assert/strict";
import { animatedTransform } from "../lib/osgjs2gltf.js";
import { stripNonIncreasingKeys, stackedTRS } from "../lib/skin.js";

const update = (name, stacked = []) => ({
  UpdateCallbacks: [
    { "osgAnimation.UpdateMatrixTransform": { Name: name, StackedTransforms: stacked } },
  ],
});

test("a transform with an update callback is animatable", () => {
  assert.equal(animatedTransform(update("Crate_7")).Name, "Crate_7");
});

test("a bone is not treated as an object animation target", () => {
  // Bones carry UpdateBone and belong to the skeleton path. Claiming them here
  // would emit a second node for a joint that already has one.
  const bone = {
    UpdateCallbacks: [{ "osgAnimation.UpdateBone": { Name: "spine", StackedTransforms: [] } }],
  };
  assert.equal(animatedTransform(bone), null);
});

test("a plain placement transform is not animatable", () => {
  assert.equal(animatedTransform({ Matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] }), null);
});

test("an unnamed callback is ignored, since no channel could address it", () => {
  assert.equal(animatedTransform({ UpdateCallbacks: [{ "osgAnimation.UpdateMatrixTransform": {} }] }), null);
});

test("non-objects are handled", () => {
  assert.equal(animatedTransform(null), null);
  assert.equal(animatedTransform("nope"), null);
});

test("stackedTRS reads an object transform's stack, not just a bone's", () => {
  const trs = stackedTRS(
    update("Crate_7", [
      { "osgAnimation.StackedTranslate": { Translate: [-6, 1, 0] } },
      { "osgAnimation.StackedQuaternion": { Quaternion: [0, 0, 0, 1] } },
      { "osgAnimation.StackedScale": { Scale: [1.7, 1.2, 0.6] } },
    ])
  );
  assert.deepEqual(trs.translation, [-6, 1, 0]);
  assert.deepEqual(trs.scale, [1.7, 1.2, 0.6]);
});

// --- key times ---

test("strictly increasing keys are returned untouched", () => {
  const times = Float32Array.from([0, 1, 2]);
  const values = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const out = stripNonIncreasingKeys(times, values, 3);
  assert.equal(out.dropped, 0);
  assert.equal(out.times, times, "expected the same array back");
});

test("a repeated instant collapses to one key", () => {
  // A clip keyed on both a 24fps and a 30fps grid lands two keys on 1/6s.
  // glTF rejects the file outright if both survive.
  const out = stripNonIncreasingKeys(
    Float32Array.from([0, 0.5, 0.5, 1]),
    Float32Array.from([0, 0, 0, 5, 5, 5, 7, 7, 7, 9, 9, 9]),
    3
  );
  assert.deepEqual([...out.times], [0, 0.5, 1]);
  assert.equal(out.dropped, 1);
});

test("the later key wins at a repeated instant", () => {
  const out = stripNonIncreasingKeys(
    Float32Array.from([0, 0.5, 0.5]),
    Float32Array.from([1, 2, 3]),
    1
  );
  assert.deepEqual([...out.values], [1, 3]);
});

test("a backwards key is dropped, not left to break the file", () => {
  const out = stripNonIncreasingKeys(
    Float32Array.from([0, 2, 1, 3]),
    Float32Array.from([0, 2, 1, 3]),
    1
  );
  assert.deepEqual([...out.times], [0, 2, 3]);
});

test("times still increase after stripping", () => {
  const out = stripNonIncreasingKeys(
    Float32Array.from([0, 0, 0, 1, 1, 2]),
    Float32Array.from([0, 1, 2, 3, 4, 5]),
    1
  );
  for (let i = 1; i < out.times.length; i++) {
    assert.ok(out.times[i] > out.times[i - 1], "times must strictly increase");
  }
});
