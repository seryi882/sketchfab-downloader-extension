/**
 * Pack Sketchfab's separate metalness / roughness maps into one glTF
 * metallicRoughness texture (glTF: G = roughness, B = metalness).
 *
 * Sketchfab serves MetalnessPBR and RoughnessPBR as independent grayscale
 * maps. Binding the metalness map straight into metallicRoughnessTexture
 * makes its green channel drive roughness, so a black (non-metal) map reads
 * as roughness 0 and every surface turns into a mirror.
 *
 * The pixel math here is deliberately free of DOM APIs so it can be unit
 * tested under `node --test`; decoding/encoding lives in packOrmTexture().
 */

/** @param {string} filename */
function baseName(filename) {
  return String(filename || "")
    .split("/")
    .pop()
    .split("?")[0];
}

/** @param {string} filename */
function stemOf(filename) {
  return baseName(filename)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

/**
 * True when a filename denotes an already-packed ORM/MRAO texture, as opposed
 * to a single-channel `*_metallic` / `*_roughness` map.
 *
 * classifyTextureName() answers 'metalrough' for both, which is why binding on
 * that alone is not safe.
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isPackedOrmName(filename) {
  const stem = stemOf(filename);
  if (!stem) return false;
  const packed = stem.replace(/[^a-z0-9]+/g, "");
  if (/metallicroughness|metalroughness|metalrough|mrao|occlusionroughnessmetallic/.test(packed)) {
    return true;
  }
  // "arm" (AO/Roughness/Metallic) is a real packing convention, but it is also
  // a body part, and a false positive here rebinds a metal-only map as if it
  // were packed — the exact mirror bug this module exists to prevent. A false
  // negative only costs some roughness detail, so the ambiguous token is out.
  return /(?:^|[_-])(orm|rma)(?:[_-]|$)/.test(stem);
}

/**
 * Decide how a material's metal/rough channels should reach glTF.
 *
 * @param {object} spec - viewer material spec (see parseViewerMaterials)
 * @param {(uid: string) => (string|null)} resolve - uid -> texture basename
 * @param {(name: string) => string} [classify] - optional name classifier
 * @returns {{action: 'passthrough'|'pack'|'factors', texture?: string,
 *            metalName?: string|null, roughName?: string|null,
 *            invertRough?: boolean, reason: string}}
 */
export function planOrm(spec, resolve, classify) {
  const res = typeof resolve === "function" ? resolve : () => null;
  const s = spec || {};
  let metalName = s.metalnessUid ? res(s.metalnessUid) : null;
  const roughName = s.roughnessUid ? res(s.roughnessUid) : null;

  // Sketchfab sometimes points MetalnessPBR at a colour/id map, not a mask.
  if (metalName && typeof classify === "function" && classify(metalName) === "albedo") {
    metalName = null;
  }

  if (!metalName && !roughName) {
    return { action: "factors", reason: "no metal/rough maps" };
  }

  // roughnessUid falls back to GlossinessPBR, which is inverted roughness.
  const invertRough = !!(s.roughnessIsGloss && roughName);
  const pack = (reason) => ({
    action: "pack",
    metalName: metalName || null,
    roughName: roughName || null,
    invertRough,
    reason,
  });

  // 1. One texture wired to both channels is a packed map by construction.
  const sameUid =
    s.metalnessUid &&
    s.roughnessUid &&
    String(s.metalnessUid).toLowerCase() === String(s.roughnessUid).toLowerCase();
  if (sameUid && metalName) {
    return { action: "passthrough", texture: metalName, reason: "one texture on both channels" };
  }

  // 2. Two distinct maps always need packing.
  if (metalName && roughName) return pack("separate metal + rough");

  if (roughName) return pack("rough only");

  // Metal map with no roughness map: the only genuinely ambiguous case.
  // Prefer the format Sketchfab reports over anything in the filename.
  const fmt = String(s.metalnessFormat || "").toUpperCase();
  if (fmt === "LUMINANCE" || fmt === "ALPHA" || fmt === "LUMINANCE_ALPHA") {
    return pack("single-channel metal map (LUMINANCE)");
  }
  if (fmt === "RGB" || fmt === "RGBA") {
    return { action: "passthrough", texture: metalName, reason: `packed metal texture (${fmt})` };
  }

  // No format reported: fall back to the filename, then to packing, which is
  // the safe direction — a wrong passthrough restores the mirror bug.
  if (isPackedOrmName(metalName)) {
    return { action: "passthrough", texture: metalName, reason: "name suggests packed ORM" };
  }
  return pack("metal only");
}

/**
 * Compose the ORM pixel buffer.
 *
 * Channels follow the glTF spec: R is free (occlusion), G roughness,
 * B metalness. Grayscale sources carry the same value in every channel, so
 * the red channel is read as the source value.
 *
 * @param {{metal?: Uint8Array|Uint8ClampedArray|null,
 *          rough?: Uint8Array|Uint8ClampedArray|null,
 *          ao?: Uint8Array|Uint8ClampedArray|null,
 *          width: number, height: number,
 *          invertRough?: boolean,
 *          metalFallback?: number, roughFallback?: number}} opts
 * @returns {Uint8ClampedArray} RGBA pixels
 */
export function packOrmPixels(opts) {
  const { width, height } = opts;
  const n = width * height;
  if (!(n > 0)) throw new Error("packOrmPixels: bad dimensions");

  const metal = opts.metal || null;
  const rough = opts.rough || null;
  const ao = opts.ao || null;
  const invert = !!opts.invertRough;
  // Non-metal and fairly rough is the safe default for a missing channel.
  const metalFallback = clamp255(opts.metalFallback != null ? opts.metalFallback : 0);
  const roughFallback = clamp255(opts.roughFallback != null ? opts.roughFallback : 229);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const r = rough ? rough[p] : roughFallback;
    out[p] = ao ? ao[p] : 255;
    out[p + 1] = invert ? 255 - r : r;
    out[p + 2] = metal ? metal[p] : metalFallback;
    out[p + 3] = 255;
  }
  return out;
}

function clamp255(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : n | 0;
}

/**
 * Decode source maps, resample to a common size and encode a packed ORM PNG.
 * Requires createImageBitmap + OffscreenCanvas (offscreen document / worker).
 *
 * @param {{metal?: {data: Uint8Array}|null, rough?: {data: Uint8Array}|null,
 *          ao?: {data: Uint8Array}|null, invertRough?: boolean,
 *          maxEdge?: number}} sources
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>}
 */
export async function packOrmTexture(sources) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error("ORM packing needs createImageBitmap + OffscreenCanvas");
  }
  const metalBmp = await decode(sources.metal);
  const roughBmp = await decode(sources.rough);
  if (!metalBmp && !roughBmp) throw new Error("ORM packing: no source maps");

  const cap = sources.maxEdge && sources.maxEdge > 0 ? sources.maxEdge : Infinity;
  const width = Math.max(1, Math.min(cap, Math.max(dim(metalBmp, "width"), dim(roughBmp, "width"))));
  const height = Math.max(1, Math.min(cap, Math.max(dim(metalBmp, "height"), dim(roughBmp, "height"))));

  const packed = packOrmPixels({
    metal: metalBmp ? resample(metalBmp, width, height) : null,
    rough: roughBmp ? resample(roughBmp, width, height) : null,
    width,
    height,
    invertRough: !!sources.invertRough,
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(packed, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const data = new Uint8Array(await blob.arrayBuffer());
  closeBmp(metalBmp);
  closeBmp(roughBmp);
  return { data, width, height };
}

function dim(bmp, key) {
  return bmp ? bmp[key] || 0 : 0;
}

function closeBmp(bmp) {
  try {
    if (bmp && bmp.close) bmp.close();
  } catch (_) {}
}

async function decode(entry) {
  if (!entry || !entry.data || !entry.data.length) return null;
  try {
    return await createImageBitmap(new Blob([entry.data]));
  } catch (_) {
    return null;
  }
}

function resample(bmp, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}
