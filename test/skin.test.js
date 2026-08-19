import test from "node:test";
import assert from "node:assert/strict";
import { collectSkeletons, decomposeMatrix, stackedTRS } from "../lib/skin.js";
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
          Name: name,
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
