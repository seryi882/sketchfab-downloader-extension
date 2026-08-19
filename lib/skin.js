/**
 * Skeleton and skin extraction from Sketchfab osgjs scenes.
 *
 * A rigged model stores its armature as an osgAnimation.Skeleton subtree of
 * osgAnimation.Bone nodes, and wraps every skinned mesh in an
 * osgAnimation.RigGeometry carrying per-vertex Bones/Weights plus a BoneMap
 * (bone name -> the index those Bones values use).
 */

const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 product a x b (b applied first). */
function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Bind-pose TRS for a bone, from its UpdateBone stacked transforms. */
export function stackedTRS(bone) {
  const callbacks = bone.UpdateCallbacks || [];
  let stack = null;
  for (const cb of callbacks) {
    const update =
      cb && (cb["osgAnimation.UpdateBone"] || cb["osgAnimation.UpdateMatrixTransform"]);
    if (update && update.StackedTransforms) {
      stack = update.StackedTransforms;
      break;
    }
  }
  if (!stack) return decomposeMatrix(bone.Matrix);

  let translation = null;
  let rotation = null;
  let scale = null;
  let unsupported = false;
  for (const entry of stack) {
    const key = Object.keys(entry)[0];
    const v = entry[key];
    if (key === "osgAnimation.StackedTranslate") translation = v.Translate;
    else if (key === "osgAnimation.StackedQuaternion") rotation = v.Quaternion;
    else if (key === "osgAnimation.StackedScale") scale = v.Scale;
    else unsupported = true;
  }
  // StackedRotateAxis / StackedMatrix would need composing in stack order; the
  // bone's own Matrix already holds the composed result, so fall back to it.
  if (unsupported) return decomposeMatrix(bone.Matrix);

  return {
    translation: translation ? Array.from(translation) : [0, 0, 0],
    rotation: rotation ? Array.from(rotation) : [0, 0, 0, 1],
    scale: scale ? Array.from(scale) : [1, 1, 1],
  };
}

/** Decompose a column-major 4x4 into TRS (assumes no shear). */
export function decomposeMatrix(m) {
  if (!m || m.length < 16) {
    return { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  }
  const translation = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // Negative determinant means one axis is mirrored; fold it into X.
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;

  const r = [
    sx ? m[0] / sx : 0, sx ? m[1] / sx : 0, sx ? m[2] / sx : 0,
    sy ? m[4] / sy : 0, sy ? m[5] / sy : 0, sy ? m[6] / sy : 0,
    sz ? m[8] / sz : 0, sz ? m[9] / sz : 0, sz ? m[10] / sz : 0,
  ];
  const trace = r[0] + r[4] + r[8];
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (r[5] - r[7]) / s;
    y = (r[6] - r[2]) / s;
    z = (r[1] - r[3]) / s;
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    w = (r[5] - r[7]) / s;
    x = 0.25 * s;
    y = (r[3] + r[1]) / s;
    z = (r[6] + r[2]) / s;
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    w = (r[6] - r[2]) / s;
    x = (r[3] + r[1]) / s;
    y = 0.25 * s;
    z = (r[7] + r[5]) / s;
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    w = (r[1] - r[3]) / s;
    x = (r[6] + r[2]) / s;
    y = (r[7] + r[5]) / s;
    z = 0.25 * s;
  }
  return { translation, rotation: [x, y, z, w], scale: [sx, sy, sz] };
}

/**
 * Walk the scene and collect every skeleton with its bone hierarchy.
 *
 * @param {object} osgjs
 * @param {object|null} axisNode the axis-conversion wrapper, so it is not
 *   mistaken for placement — see findAxisConversion() in osg-scene.js
 * @returns {{skeletons: Array, boneByName: Map<string, object>}}
 *   Each skeleton is { json, roots, bones, worldMatrix }; a bone is
 *   { name, json, trs, invBind, children, skeleton }.
 */
export function collectSkeletons(osgjs, axisNode = null) {
  const skeletons = [];
  const boneByName = new Map();

  function readBone(json, skeleton) {
    const bone = {
      name: json.Name || "",
      json,
      trs: stackedTRS(json),
      invBind: json.InvBindMatrixInSkeletonSpace || null,
      children: [],
      skeleton,
    };
    skeleton.bones.push(bone);
    // Names are unique per model in Sketchfab exports (they carry a numeric
    // suffix); first writer wins if a model ever breaks that.
    if (bone.name && !boneByName.has(bone.name)) boneByName.set(bone.name, bone);
    for (const child of json.Children || []) {
      if (!child || typeof child !== "object") continue;
      const sub = child["osgAnimation.Bone"] || child["osg.Bone"];
      if (sub) bone.children.push(readBone(sub, skeleton));
    }
    return bone;
  }

  // Bones nest under the skeleton, sometimes via plain transforms; descend
  // through anything that is not itself a bone to find the roots.
  function findRootBones(node, skeleton, depth) {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (const v of node) findRootBones(v, skeleton, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "osgAnimation.Bone" || key === "osg.Bone") {
        skeleton.roots.push(readBone(value, skeleton));
        continue; // readBone already consumed this subtree
      }
      findRootBones(value, skeleton, depth + 1);
    }
  }

  // The axis-conversion wrapper is handled once for the whole model, by the
  // vertex data and the rig root alike, so it must not be accumulated here as
  // if it were placement.
  function hasMatrix(value) {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value.Matrix) || value.Matrix.length !== 16) return false;
    return value !== axisNode;
  }

  // Bone transforms are local to their skeleton, but the per-character
  // placement lives in the osg.MatrixTransform chain above it — and the bind
  // matrices already bake that in. Accumulate it so the rig can be placed.
  function walk(node, depth, acc) {
    if (!node || typeof node !== "object" || depth > 80) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1, acc);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "osgAnimation.Bone" || key === "osg.Bone") continue;
      if (key === "osgAnimation.Skeleton" || key === "osg.Skeleton") {
        const worldMatrix = hasMatrix(value) ? mat4Multiply(acc, value.Matrix) : acc;
        const skeleton = { json: value, roots: [], bones: [], worldMatrix };
        skeletons.push(skeleton);
        findRootBones(value.Children || [], skeleton, 0);
        // Keep walking for meshes and any nested skeletons.
        for (const [k, v] of Object.entries(value)) {
          if (k === "Children") continue;
          walk(v, depth + 1, worldMatrix);
        }
        walk(value.Children || [], depth + 1, worldMatrix);
        continue;
      }
      walk(value, depth + 1, hasMatrix(value) ? mat4Multiply(acc, value.Matrix) : acc);
    }
  }

  walk(osgjs, 0, IDENTITY_MAT4);
  return { skeletons, boneByName };
}
