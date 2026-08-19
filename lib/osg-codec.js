/**
 * Low-level decoders for Sketchfab's osgjs binary payloads, ported from the
 * viewer bundle.
 *
 * They live apart from the converter because more than one caller needs them,
 * and because the spherical decoder in particular is easy to get subtly wrong.
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
 * Decode a direction on the unit sphere from two packed components.
 *
 * With itemSize 4 the fourth output is a tangent's handedness, which rides in
 * bit 1024 of the first component.
 */
export function decodeSpherical(encoded, output, itemSize, epsilon, nphi, hasThirdComponent) {
  epsilon = epsilon || 0.25;
  nphi = nphi || 720;
  const PI = 3.14159265359;
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

    output[outIdx] = w * Math.cos(P);
    output[outIdx + 1] = w * Math.sin(P);
    output[outIdx + 2] = R;
  }
  return output;
}
