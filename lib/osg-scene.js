/**
 * Scene-graph queries over a parsed osgjs document, plus the small matrix
 * helpers they hand back.
 *
 * The converter flattens the node tree, so anything the graph says about
 * orientation has to be read out before that happens.
 */

/** Column-major 3x3s; the source → glTF axis fix is always a pure rotation. */
export const IDENTITY_MAT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The viewer's world is Z-up, glTF is Y-up: (x, y, z) → (x, z, -y). */
export const ZUP_TO_YUP_MAT3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];

/** Column-major 3x3 product a x b (b applied first). */
export function mat3Multiply(a, b) {
  const out = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[k * 3 + r] * b[c * 3 + k];
      out[c * 3 + r] = sum;
    }
  }
  return out;
}

/** Rotation/scale block of a column-major 4x4. */
export function mat3FromMat4(m) {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

/** Widen a 3x3 to a 4x4 with no translation. */
export function mat4FromMat3(m) {
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1];
}

export function mat3Transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function isIdentityMat3(m) {
  for (let i = 0; i < 9; i++) {
    if (Math.abs(m[i] - IDENTITY_MAT3[i]) > 1e-6) return false;
  }
  return true;
}

/** Outermost node carrying a transform, in scene order. */
function outermostTransform(node, depth) {
  if (!node || typeof node !== "object" || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = outermostTransform(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const value of Object.values(node)) {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray(value.Matrix) &&
      value.Matrix.length === 16
    ) {
      return value;
    }
    const hit = outermostTransform(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** True for a bare quarter turn about X: no translation, no scale, no tilt. */
function isQuarterTurnAboutX(m) {
  const eps = 1e-4;
  const near = (a, b) => Math.abs(a - b) <= eps;
  if (!near(m[12], 0) || !near(m[13], 0) || !near(m[14], 0)) return false;
  if (!near(m[0], 1) || !near(m[1], 0) || !near(m[2], 0)) return false;
  const s = m[6];
  if (!near(Math.abs(s), 1)) return false;
  return (
    near(m[4], 0) && near(m[5], 0) && near(m[8], 0) && near(m[9], -s) && near(m[10], 0)
  );
}

/**
 * Sketchfab's coordinate-conversion wrapper, when the model has one.
 *
 * An upload that arrived as glTF is Y-up, and Sketchfab wraps it in a single
 * transform that turns it into the viewer's Z-up world. Everything below stays
 * Y-up — the baked vertex data included — so a converter that assumes Z-up
 * source would turn such a model twice and lay it on its side.
 *
 * Only the outermost transform is considered, and only when it is a bare
 * quarter turn about X. Object placement carries translation or scale, and
 * mistaking that for a conversion would tilt the model rather than stand it
 * up; a model without a wrapper keeps the Z-up assumption.
 *
 * @returns {object|null} the conversion node, whose Matrix maps content → world
 */
export function findAxisConversion(osgjs) {
  const node = outermostTransform(osgjs, 0);
  if (!node || !isQuarterTurnAboutX(node.Matrix)) return null;
  return node;
}

/**
 * Rotation to bake into vertex data so the export lands in glTF's Y-up frame.
 *
 * Z-up source content needs a quarter turn. A model that arrived as glTF is
 * already Y-up below the conversion wrapper, though, and turning it again lays
 * it on its side — composing with that wrapper cancels the two out, which is
 * why the rotation is derived rather than assumed.
 *
 * @returns {{matrix: number[], node: object|null}}
 */
export function axisRotationFor(osgjs) {
  const node = findAxisConversion(osgjs);
  const conv = node ? mat3FromMat4(node.Matrix) : IDENTITY_MAT3;
  return { matrix: mat3Multiply(ZUP_TO_YUP_MAT3, conv), node };
}
