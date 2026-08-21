import test from "node:test";
import assert from "node:assert/strict";
import {
  collectAnimations,
  collectSkeletons,
  decodeChannelCurve,
  decodeKeyframeArray,
  decomposeMatrix,
  normalizeQuaternions,
  stackedTRS,
} from "../lib/skin.js";
import {
  deinterleave,
  prefixSum,
  quatAccumulate,
  decodeSpherical,
} from "../lib/osg-codec.js";
import { findAxisConversion } from "../lib/osg-scene.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function bone(name, opts = {}) {
  return {
    Name: name,
    Matrix: opts.matrix || IDENTITY,
    InvBindMatrixInSkeletonSpace: opts.invBind || IDENTITY,
    UpdateCallbacks: [
      {
        "osgAnimation.UpdateBone": {
          Name: opts.animName || name,
          StackedTransforms: [
            { "osgAnimation.StackedTranslate": { Translate: opts.t || [0, 0, 0] } },
            { "osgAnimation.StackedQuaternion": { Quaternion: opts.q || [0, 0, 0, 1] } },
            { "osgAnimation.StackedScale": { Scale: opts.s || [1, 1, 1] } },
          ],
        },
      },
    ],
    Children: opts.children || [],
  };
}

function scene(skeletonChildren, placement) {
  return {
    "osg.Node": {
      Children: [
        {
          "osg.MatrixTransform": {
            Name: "GLTF_SceneRootNode",
            // Sketchfab's Y-up → viewer Z-up wrapper.
            Matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
            Children: [
              {
                "osg.MatrixTransform": {
                  Name: "Placement",
                  Matrix: placement || IDENTITY,
                  Children: [
                    {
                      "osgAnimation.Skeleton": {
                        Name: "Sk",
                        Matrix: IDENTITY,
                        Children: skeletonChildren,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

test("collectSkeletons reads the bone tree and keeps names unique", () => {
  const tree = scene([
    { "osgAnimation.Bone": bone("root", { children: [{ "osgAnimation.Bone": bone("child") }] }) },
  ]);
  const { skeletons, boneByName } = collectSkeletons(tree);
  assert.equal(skeletons.length, 1);
  assert.equal(skeletons[0].bones.length, 2);
  assert.equal(skeletons[0].roots.length, 1);
  assert.equal(skeletons[0].roots[0].name, "root");
  assert.equal(skeletons[0].roots[0].children[0].name, "child");
  assert.ok(boneByName.has("child"));
});

test("skeleton placement accumulates transforms but skips the axis conversion", () => {
  const placement = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, -3, 1];
  const tree = scene([{ "osgAnimation.Bone": bone("root") }], placement);
  const { skeletons } = collectSkeletons(tree, findAxisConversion(tree));
  const w = skeletons[0].worldMatrix;
  // Placement survives; the conversion must not be folded in, or the rig
  // would be turned twice relative to the baked vertices.
  assert.deepEqual([w[12], w[13], w[14]], [2, 0, -3]);
  assert.deepEqual([w[0], w[5], w[10]], [1, 1, 1]);
});

test("without a conversion node every transform counts as placement", () => {
  const placement = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, -3, 1];
  const tree = scene([{ "osgAnimation.Bone": bone("root") }], placement);
  const { skeletons } = collectSkeletons(tree, null);
  const w = skeletons[0].worldMatrix;
  // The wrapper's quarter turn now applies: (2, 0, -3) → (2, 3, 0).
  assert.deepEqual([w[12], w[13], w[14]], [2, 3, 0]);
});

test("a mesh under the skeleton is not mistaken for a bone", () => {
  const tree = scene([
    { "osgAnimation.Bone": bone("root") },
    { "osg.MatrixTransform": { Name: "MeshHolder", Matrix: IDENTITY, Children: [] } },
  ]);
  const { skeletons } = collectSkeletons(tree);
  assert.equal(skeletons[0].roots.length, 1);
  assert.equal(skeletons[0].bones.length, 1);
});

test("every bone carries its inverse bind matrix", () => {
  const invBind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -2, -3, 1];
  const tree = scene([{ "osgAnimation.Bone": bone("root", { invBind }) }]);
  const { boneByName } = collectSkeletons(tree);
  assert.deepEqual(boneByName.get("root").invBind, invBind);
});

test("stackedTRS reads translate/rotate/scale", () => {
  const trs = stackedTRS(bone("b", { t: [1, 2, 3], q: [0, 0, 0, 1], s: [2, 2, 2] }));
  assert.deepEqual(trs.translation, [1, 2, 3]);
  assert.deepEqual(trs.scale, [2, 2, 2]);
});

test("stackedTRS falls back to the matrix for unsupported stacked types", () => {
  const b = {
    Name: "b",
    Matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1],
    UpdateCallbacks: [
      {
        "osgAnimation.UpdateBone": {
          StackedTransforms: [{ "osgAnimation.StackedRotateAxis": { Axis: [0, 1, 0] } }],
        },
      },
    ],
  };
  assert.deepEqual(stackedTRS(b).translation, [5, 6, 7]);
});

test("decomposeMatrix recovers translation, rotation and scale", () => {
  // 90° about Z, scale 2, translated
  const m = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1];
  const d = decomposeMatrix(m);
  assert.deepEqual(d.translation, [1, 2, 3]);
  for (const s of d.scale) assert.ok(Math.abs(s - 2) < 1e-6);
  assert.ok(Math.abs(Math.hypot(...d.rotation) - 1) < 1e-6);
  assert.ok(Math.abs(Math.abs(d.rotation[2]) - Math.SQRT1_2) < 1e-6);
});

// --- animations ---

test("collectAnimations finds every animation", () => {
  const tree = {
    "osg.Node": {
      Children: [
        {
          "osgAnimation.BasicAnimationManager": {
            Animations: [
              { "osgAnimation.Animation": { Name: "walk", Channels: [] } },
              { "osgAnimation.Animation": { Name: "run", Channels: [] } },
            ],
          },
        },
      ],
    },
  };
  assert.deepEqual(collectAnimations(tree).map((a) => a.Name), ["walk", "run"]);
});

function f32Buffer(values) {
  return Float32Array.from(values).buffer;
}

test("plain keyframe arrays pass through untouched", () => {
  const bin = f32Buffer([1, 2, 3, 4, 5, 6]);
  const part = { ItemSize: 3, Array: { Float32Array: { Offset: 0, Size: 2 } } };
  const out = decodeKeyframeArray(bin, part, {}, false, false, 3);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6]);
});

test("packed time keys prepend the origin and accumulate deltas", () => {
  const bin = f32Buffer([0.1, 0.1, 0.1]);
  const part = { ItemSize: 1, Array: { Float32Array: { Offset: 0, Size: 3 } } };
  // channel_mode 16 = prepend origin for scalar time
  const out = decodeKeyframeArray(bin, part, { channel_mode: 16, ot: 0.5 }, true, false, 1);
  assert.equal(out.length, 4);
  const expected = [0.5, 0.6, 0.7, 0.8];
  out.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5, `${v} != ${expected[i]}`));
});

test("compressed packed vec3 keys de-interleave, dequantize, then accumulate", () => {
  // planar: all x, then all y, then all z
  const bin = Uint16Array.from([10, 20, 0, 0, 0, 0]).buffer;
  const part = { ItemSize: 3, Array: { Uint16Array: { Offset: 0, Size: 2 } } };
  const userData = {
    channel_mode: 1 | 4, // dequantize + prepend origin
    bx: 1, by: 0, bz: 0,
    hx: 0.5, hy: 1, hz: 1,
    ox: 100, oy: 0, oz: 0,
  };
  const out = decodeKeyframeArray(bin, part, userData, true, true, 3);
  assert.equal(out.length, 9);
  assert.deepEqual(Array.from(out.slice(0, 3)), [100, 0, 0]);
  assert.deepEqual(Array.from(out.slice(3, 6)), [106, 0, 0]);
  assert.deepEqual(Array.from(out.slice(6, 9)), [117, 0, 0]);
});

test("spherical quaternion keys decode to unit quaternions", () => {
  const bin = Uint16Array.from([120, 300, 40, 90, 260, 20]).buffer;
  const part = { ItemSize: 3, Array: { Uint16Array: { Offset: 0, Size: 2 } } };
  const userData = {
    channel_mode: 8 | 4, // spherical + prepend origin
    epsilon: 0.25,
    nphi: 720,
    ox: 0, oy: 0, oz: 0, ow: 1,
  };
  const out = decodeKeyframeArray(bin, part, userData, true, true, 4);
  assert.equal(out.length, 12);
  for (let i = 0; i < out.length; i += 4) {
    const len = Math.hypot(out[i], out[i + 1], out[i + 2], out[i + 3]);
    assert.ok(Math.abs(len - 1) < 1e-4, `quaternion ${i / 4} length ${len}`);
  }
});

test("decodeChannelCurve maps osgAnimation names to glTF paths", () => {
  const bin = f32Buffer([0, 1, /* values */ 1, 2, 3, 4, 5, 6]);
  const channel = {
    Name: "translate",
    TargetName: "spine",
    KeyFrames: {
      Time: { ItemSize: 1, Array: { Float32Array: { Offset: 0, Size: 2 } } },
      Key: { ItemSize: 3, Array: { Float32Array: { Offset: 8, Size: 2 } } },
    },
  };
  const curve = decodeChannelCurve(bin, "osgAnimation.Vec3LerpChannel", channel);
  assert.equal(curve.path, "translation");
  assert.equal(curve.target, "spine");
  assert.equal(curve.itemSize, 3);
  assert.deepEqual(Array.from(curve.times), [0, 1]);
  assert.deepEqual(Array.from(curve.values), [1, 2, 3, 4, 5, 6]);
});

test("decodeChannelCurve skips channels glTF cannot target", () => {
  const bin = f32Buffer([0, 1, 2, 3]);
  const mk = (name) => ({
    Name: name,
    TargetName: "spine",
    KeyFrames: {
      Time: { ItemSize: 1, Array: { Float32Array: { Offset: 0, Size: 2 } } },
      Key: { ItemSize: 1, Array: { Float32Array: { Offset: 8, Size: 2 } } },
    },
  });
  assert.equal(decodeChannelCurve(bin, "osgAnimation.Vec3LerpChannel", mk("mystery")), null);
});

test("a scalar channel decodes as a morph weight curve", () => {
  // The channel's Name is a weight index, not a transform component, so the
  // path comes from the channel being scalar rather than from a name lookup.
  const bin = f32Buffer([0, 1, 2, 3]);
  const curve = decodeChannelCurve(bin, "osgAnimation.FloatLerpChannel", {
    Name: "0",
    TargetName: "target_12_0_0",
    KeyFrames: {
      Time: { ItemSize: 1, Array: { Float32Array: { Offset: 0, Size: 2 } } },
      Key: { ItemSize: 1, Array: { Float32Array: { Offset: 8, Size: 2 } } },
    },
  });
  assert.ok(curve, "expected a curve");
  assert.equal(curve.path, "weights");
  assert.equal(curve.itemSize, 1);
  assert.equal(curve.target, "target_12_0_0");
});

// --- codec primitives ---

test("deinterleave converts planar streams to interleaved items", () => {
  const src = Float32Array.from([1, 2, 10, 20, 100, 200]);
  const out = deinterleave(src, new Float32Array(6), 3);
  assert.deepEqual(Array.from(out), [1, 10, 100, 2, 20, 200]);
});

test("prefixSum accumulates per component", () => {
  const arr = Float32Array.from([1, 2, 1, 2, 1, 2]);
  assert.deepEqual(Array.from(prefixSum(arr, 2)), [1, 2, 2, 4, 3, 6]);
});

test("quatAccumulate composes each key onto the previous", () => {
  // 45° about Z, applied twice, gives 90° about Z
  const q45 = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  const arr = Float32Array.from([...q45, ...q45]);
  quatAccumulate(arr);
  assert.ok(Math.abs(arr[6] - Math.SQRT1_2) < 1e-6, `z ${arr[6]}`);
  assert.ok(Math.abs(arr[7] - Math.SQRT1_2) < 1e-6, `w ${arr[7]}`);
});

test("decodeSpherical keeps the tangent handedness branch intact", () => {
  // itemSize 4 without a third component is the tangent path: sign in bit 1024
  const out = new Float32Array(8);
  decodeSpherical(Uint16Array.from([100 | 1024, 50, 100, 50]), out, 4, 0.25, 720, false);
  assert.equal(out[3], -1);
  assert.equal(out[7], 1);
  for (const base of [0, 4]) {
    const len = Math.hypot(out[base], out[base + 1], out[base + 2]);
    assert.ok(Math.abs(len - 1) < 1e-4, `direction ${base} length ${len}`);
  }
});

test("normalizeQuaternions repairs zero-length keys", () => {
  const v = Float32Array.from([0, 0, 0, 0, 2, 0, 0, 0]);
  normalizeQuaternions(v);
  assert.deepEqual(Array.from(v.slice(0, 4)), [0, 0, 0, 1]);
  assert.deepEqual(Array.from(v.slice(4, 8)), [1, 0, 0, 0]);
});

test("a bone records the name its animation channels use", () => {
  const tree = scene([{ "osgAnimation.Bone": bone("bone_00_01") }]);
  const { skeletons } = collectSkeletons(tree);
  assert.equal(skeletons[0].bones[0].animName, "bone_00_01");
});

test("animName follows the update callback when it differs from the bone", () => {
  // Models imported from FBX come back with the callback carrying a different
  // suffix from the bone node, and channels address the callback. Matching on
  // the bone name alone loses every clip on those models.
  const tree = scene([
    { "osgAnimation.Bone": bone("bone_00_01", { animName: "bone_00_12" }) },
  ]);
  const { skeletons } = collectSkeletons(tree);
  const b = skeletons[0].bones[0];
  assert.equal(b.name, "bone_00_01");
  assert.equal(b.animName, "bone_00_12");
});

test("a bone with no update callback falls back to its own name", () => {
  const tree = scene([
    { "osgAnimation.Bone": { Name: "plain", Matrix: IDENTITY, Children: [] } },
  ]);
  const { skeletons } = collectSkeletons(tree);
  assert.equal(skeletons[0].bones[0].animName, "plain");
});
