/**
 * Skeleton, skin and animation extraction from Sketchfab osgjs scenes.
 *
 * A rigged model stores its armature as an osgAnimation.Skeleton subtree of
 * osgAnimation.Bone nodes, and wraps every skinned mesh in an
 * osgAnimation.RigGeometry carrying per-vertex Bones/Weights plus a BoneMap
 * (bone name -> the index those Bones values use).
 *
 * Animation curves do NOT live in model_file.bin — they sit in a separate
 * `<animationUid>.bin.gz` fetched from the model's animations/ path, in one of
 * four encodings. decodeChannelCurve() ports the viewer's reader for all four.
 */

import {
  decodeVarint,
  deinterleave,
  dequantize,
  decodeSpherical,
  prefixSum,
  quatAccumulate,
} from "./osg-codec.js";
import { IDENTITY_MAT4, mat4Multiply } from "./osg-scene.js";

const TYPED_ARRAYS = {
  Float32Array,
  Int32Array,
  Uint32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
  Int8Array,
};

// channel_mode bits, from the viewer's channel reader.
const MODE_DEQUANTIZE = 1;
const MODE_PREPEND_ORIGIN = 4;
const MODE_SPHERICAL = 8;
const MODE_PREPEND_TIME = 16;

/** osgAnimation channel Name -> glTF animation target path. */
const CHANNEL_PATHS = {
  translate: "translation",
  translation: "translation",
  rotate: "rotation",
  rotation: "rotation",
  quaternion: "rotation",
  scale: "scale",
};

/** @param {object} node @returns {object} flattened UserDataContainer values */
export function readUserData(node) {
  const out = {};
  const values = node && node.UserDataContainer && node.UserDataContainer.Values;
  if (!values) return out;
  for (const v of values) {
    if (!v || v.Name == null) continue;
    const n = Number(v.Value);
    out[v.Name] = v.Value !== "" && Number.isFinite(n) ? n : v.Value;
  }
  return out;
}

/** Bind-pose TRS for a bone, from its UpdateBone stacked transforms. */
export function stackedTRS(bone) {
  const callbacks = bone.UpdateCallbacks || [];
  let stack = null;
  for (const cb of callbacks) {
    const update = cb && (cb["osgAnimation.UpdateBone"] || cb["osgAnimation.UpdateMatrixTransform"]);
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
/** Name on a node's animation update callback, if it has one. */
function updateCallbackName(json) {
  for (const cb of (json && json.UpdateCallbacks) || []) {
    if (!cb || typeof cb !== "object") continue;
    const value = cb[Object.keys(cb)[0]];
    if (value && value.Name) return value.Name;
  }
  return "";
}

export function collectSkeletons(osgjs, axisNode = null) {
  const skeletons = [];
  const boneByName = new Map();

  function readBone(json, skeleton) {
    const bone = {
      name: json.Name || "",
      /**
       * The name animation channels address this bone by.
       *
       * It is usually the bone's own name, but not always: models imported
       * from FBX come back with the update callback carrying a different
       * suffix from the bone node, and channels follow the callback. Matching
       * on the bone name alone silently loses every clip on those models.
       */
      animName: updateCallbackName(json) || json.Name || "",
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

  // The axis-conversion wrapper is handled once for the whole model, by
  // processGeometry and the rig root alike, so it must not be accumulated here
  // as if it were placement.
  function hasMatrix(value) {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value.Matrix) || value.Matrix.length !== 16) return false;
    return value !== axisNode;
  }

  walk(osgjs, 0, IDENTITY_MAT4);
  return { skeletons, boneByName };
}

/** Every osgAnimation.Animation in the scene, in declaration order. */
export function collectAnimations(osgjs) {
  const out = [];
  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 80) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "osgAnimation.Animation") {
        out.push(value);
        continue;
      }
      walk(value, depth + 1);
    }
  }
  walk(osgjs, 0);
  return out;
}

function readRaw(bin, def, typeName, count) {
  const offset = def.Offset || 0;
  if (def.Encoding === "varint") {
    return decodeVarint(new Uint8Array(bin, offset), count, typeName);
  }
  const Ctor = TYPED_ARRAYS[typeName];
  if (!Ctor) throw new Error(`Unknown array type: ${typeName}`);
  // Typed array views need natural alignment; copy when the offset is odd.
  if (offset % Ctor.BYTES_PER_ELEMENT !== 0) {
    const bytes = new Uint8Array(bin, offset, count * Ctor.BYTES_PER_ELEMENT);
    return new Ctor(bytes.slice().buffer);
  }
  return new Ctor(bin, offset, count);
}

/**
 * Decode one KeyFrames stream (Time or Key).
 *
 * @param {ArrayBuffer} bin decompressed animation payload
 * @param {object} part    KeyFrames.Time / KeyFrames.Key
 * @param {object} userData flattened channel UserDataContainer
 * @param {boolean} packed
 * @param {boolean} compressed
 * @param {number} itemSize components per output item (1 time, 3 vec3, 4 quat)
 */
export function decodeKeyframeArray(bin, part, userData, packed, compressed, itemSize) {
  const encodedItemSize = part.ItemSize || 1;
  const typeName = Object.keys(part.Array)[0];
  const def = part.Array[typeName];
  const size = def.Size;
  const mode = userData.channel_mode || 0;
  const prepend = !!(itemSize === 1 ? mode & MODE_PREPEND_TIME : mode & MODE_PREPEND_ORIGIN);

  // When an origin is prepended the stream holds deltas from it, so the
  // decoded run lands one item in and the origin fills slot 0.
  const out = new Float32Array((prepend ? size + 1 : size) * itemSize);
  const body = prepend ? out.subarray(itemSize) : out;

  let raw = readRaw(bin, def, typeName, encodedItemSize * size);

  if (itemSize === 4 && mode & MODE_SPHERICAL) {
    if (compressed) raw = deinterleave(raw, new Float32Array(raw.length), encodedItemSize);
    decodeSpherical(raw, body, itemSize, userData.epsilon, userData.nphi, true);
    if (prepend) {
      out[0] = userData.ox || 0;
      out[1] = userData.oy || 0;
      out[2] = userData.oz || 0;
      out[3] = userData.ow == null ? 1 : userData.ow;
      quatAccumulate(out);
    }
    return out;
  }

  if (compressed && itemSize !== 1) deinterleave(raw, body, encodedItemSize);
  else body.set(raw);

  if (packed) {
    if (itemSize === 3 && mode & MODE_DEQUANTIZE) {
      dequantize(
        body,
        body,
        [userData.bx || 0, userData.by || 0, userData.bz || 0],
        [userData.hx || 0, userData.hy || 0, userData.hz || 0],
        itemSize
      );
    }
    if (prepend) {
      if (itemSize === 3) {
        out[0] = userData.ox || 0;
        out[1] = userData.oy || 0;
        out[2] = userData.oz || 0;
      } else {
        out[0] = userData.ot || 0;
      }
      prefixSum(out, itemSize);
    }
  }
  return out;
}

/**
 * Decode one animation channel into glTF-ready curves.
 *
 * @returns {{target: string, path: string, times: Float32Array,
 *            values: Float32Array, itemSize: number} | null}
 */
export function decodeChannelCurve(bin, typeName, channel) {
  const kf = channel && channel.KeyFrames;
  if (!kf || !kf.Time || !kf.Key || !channel.TargetName) return null;

  const isQuat = typeName.indexOf("Quat") !== -1;
  const isFloat = typeName.indexOf("Float") !== -1;
  const itemSize = isQuat ? 4 : isFloat ? 1 : 3;

  /**
   * A scalar channel drives one morph target's weight. Its Name is the weight
   * index rather than a transform component, so it is TargetName that says
   * which target it belongs to -- the caller resolves that against the mesh's
   * target list and drops the curve if it matches none.
   */
  const path = isFloat
    ? "weights"
    : CHANNEL_PATHS[String(channel.Name || "").toLowerCase()];
  if (!path) return null;


  const compressed = typeName.indexOf("Compressed") !== -1;
  const packed = typeName.indexOf("Packed") !== -1;
  const userData = readUserData(channel);

  const times = decodeKeyframeArray(bin, kf.Time, userData, packed, false, 1);
  const values = decodeKeyframeArray(bin, kf.Key, userData, packed, compressed, itemSize);
  if (!times.length || values.length < times.length * itemSize) return null;

  if (isQuat) normalizeQuaternions(values);

  return { target: channel.TargetName, path, times, values, itemSize };
}

/**
 * Drop keys that do not advance the clock.
 *
 * glTF requires an animation's input times to be strictly increasing. Clips
 * that arrive through Sketchfab's FBX import can key the same instant twice --
 * a clip keyed on both a 24fps and a 30fps grid puts two keys on 1/6s -- and
 * the viewer plays it happily, so nothing upstream rejects it. Left alone it
 * produces a file no glTF reader will load.
 *
 * Where an instant repeats, the later key wins: that is the value in force from
 * that moment onward. In practice the repeated keys hold the same value and
 * nothing changes but the count.
 *
 * @returns {{times: Float32Array, values: Float32Array, dropped: number}}
 */
export function stripNonIncreasingKeys(times, values, itemSize) {
  let repeats = false;
  for (let i = 1; i < times.length; i++) {
    if (times[i] <= times[i - 1]) { repeats = true; break; }
  }
  if (!repeats) return { times, values, dropped: 0 };

  const outTimes = [];
  const outValues = [];
  for (let i = 0; i < times.length; i++) {
    if (outTimes.length && times[i] <= outTimes[outTimes.length - 1]) {
      const base = outValues.length - itemSize;
      for (let c = 0; c < itemSize; c++) outValues[base + c] = values[i * itemSize + c];
      continue;
    }
    outTimes.push(times[i]);
    for (let c = 0; c < itemSize; c++) outValues.push(values[i * itemSize + c]);
  }
  return {
    times: Float32Array.from(outTimes),
    values: Float32Array.from(outValues),
    dropped: times.length - outTimes.length,
  };
}

/** Renormalise quaternions; accumulated deltas drift slightly. */
export function normalizeQuaternions(values) {
  for (let i = 0; i < values.length; i += 4) {
    const len = Math.hypot(values[i], values[i + 1], values[i + 2], values[i + 3]);
    if (!len) {
      values[i] = 0;
      values[i + 1] = 0;
      values[i + 2] = 0;
      values[i + 3] = 1;
      continue;
    }
    values[i] /= len;
    values[i + 1] /= len;
    values[i + 2] /= len;
    values[i + 3] /= len;
  }
  return values;
}
