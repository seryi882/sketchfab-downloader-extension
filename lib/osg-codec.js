/**
 * Low-level decoders for Sketchfab's osgjs binary payloads, ported from the
 * viewer bundle.
 *
 * Geometry attributes and animation curves share these primitives, so they
 * live here rather than being duplicated: the spherical decoder in particular
 * is easy to get subtly wrong, and the geometry path (normals/tangents) and
 * the animation path (packed quaternions) exercise different branches of it.
 */

/** Varint stream → Int32Array/Uint32Array (zigzag-decoded when signed). */
export function decodeVarint(bytes, count, typeName) {
  const signed = typeName[0] !== "U";
  const result = signed ? new Int32Array(count) : new Uint32Array(count);
  let a = 0;
  let o = 0;
  while (a < count) {
    let s = 0;
    let l = 0;
    do {
      s |= (bytes[o] & 127) << l;
      l += 7;
    } while ((bytes[o++] & 128) !== 0);
    result[a++] = s;
  }
  if (signed) {
    for (let u = 0; u < count; u++) {
      const c = result[u];
      result[u] = (c >> 1) ^ -(c & 1); // zigzag decode
    }
  }
  return result;
}

/** In-place zigzag delta decode from startIdx onwards. */
export function deltaDecodeInPlace(arr, startIdx) {
  const start = startIdx || 0;
  let prev = arr[start];
  for (let i = start + 1; i < arr.length; i++) {
    const v = arr[i];
    prev = arr[i] = prev + ((v >> 1) ^ -(v & 1));
  }
  return arr;
}

/** output[i][j] = bbl[j] + encoded[i][j] * h[j] */
export function dequantize(encoded, output, bbl, h, itemSize) {
  const count = encoded.length / itemSize;
  for (let i = 0; i < count; i++) {
    const base = i * itemSize;
    for (let j = 0; j < itemSize; j++) {
      output[base + j] = bbl[j] + encoded[base + j] * h[j];
    }
  }
  return output;
}

/**
 * Planar → interleaved. Compressed streams store all X, then all Y, then all
 * Z; every consumer wants them interleaved per item.
 */
export function deinterleave(src, dst, itemSize) {
  const count = src.length / itemSize;
  for (let i = 0; i < count; i++) {
    const base = i * itemSize;
    for (let j = 0; j < itemSize; j++) dst[base + j] = src[i + count * j];
  }
  return dst;
}

/** In-place prefix sum over items of `itemSize` components. */
export function prefixSum(arr, itemSize) {
  const n = itemSize || 1;
  for (let i = 1, count = arr.length / n; i < count; i++) {
    const prev = (i - 1) * n;
    const cur = i * n;
    for (let j = 0; j < n; j++) arr[cur + j] += arr[prev + j];
  }
  return arr;
}

/**
 * In-place cumulative Hamilton product: q[i] = q[i-1] * q[i].
 * Packed quaternion curves store deltas relative to the previous key.
 */
export function quatAccumulate(arr) {
  for (let i = 1, count = arr.length / 4; i < count; i++) {
    const p = 4 * (i - 1);
    const c = 4 * i;
    const ax = arr[p];
    const ay = arr[p + 1];
    const az = arr[p + 2];
    const aw = arr[p + 3];
    const bx = arr[c];
    const by = arr[c + 1];
    const bz = arr[c + 2];
    const bw = arr[c + 3];
    arr[c] = ax * bw + ay * bz - az * by + aw * bx;
    arr[c + 1] = -ax * bz + ay * bw + az * bx + aw * by;
    arr[c + 2] = ax * by - ay * bx + az * bw + aw * bz;
    arr[c + 3] = -ax * bx - ay * by - az * bz + aw * bw;
  }
  return arr;
}

/**
 * Spherical decoder shared by normals/tangents and packed quaternions.
 *
 * Two encoded components address a point on the unit sphere. With
 * `hasThirdComponent` a third component carries a half-angle, turning that
 * direction into a unit quaternion (axis * sin, cos) — this is the form
 * QuatSlerpChannelCompressed* uses. Without it, itemSize 4 means a tangent
 * whose handedness rides in bit 1024 of the first component.
 */
export function decodeSpherical(encoded, output, itemSize, epsilon, nphi, hasThirdComponent) {
  epsilon = epsilon || 0.25;
  nphi = nphi || 720;
  const PI = 3.14159265359;
  const HALF_ANGLE_STEP = 4.7938362584151635e-5;
  const cosEps = Math.cos(0.01745329251 * epsilon);
  const dPhi = PI / (nphi - 1);
  const dGamma = 1.57079632679 / (nphi - 1);
  const stride = hasThirdComponent ? 3 : 2;
  const count = encoded.length / stride;

  for (let i = 0; i < count; i++) {
    const outIdx = i * itemSize;
    const inIdx = i * stride;
    let S = encoded[inIdx];
    const x = encoded[inIdx + 1];

    if (itemSize === 4 && !hasThirdComponent) {
      output[outIdx + 3] = S & 1024 ? -1 : 1;
      S &= ~1024;
    }

    const A0 = S * dPhi;
    const R = Math.cos(A0);
    const w = Math.sin(A0);
    const A1 = A0 + dGamma;
    let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
    if (E > 1) E = 1;
    else if (E < -1) E = -1;
    const P = (6.28318530718 * x) / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));

    const dx = w * Math.cos(P);
    const dy = w * Math.sin(P);
    const dz = R;

    if (hasThirdComponent) {
      const half = HALF_ANGLE_STEP * encoded[inIdx + 2];
      const s = Math.sin(half);
      output[outIdx] = s * dx;
      output[outIdx + 1] = s * dy;
      output[outIdx + 2] = s * dz;
      output[outIdx + 3] = Math.cos(half);
    } else {
      output[outIdx] = dx;
      output[outIdx + 1] = dy;
      output[outIdx + 2] = dz;
    }
  }
  return output;
}
