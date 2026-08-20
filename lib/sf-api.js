/**
 * Sketchfab public model helpers: UID parse, embed fetch, static key extraction.
 */

import { DEFAULT_STATIC_KEY } from "./decrypt.js";
import { descrambleImageBytes } from "./descramble.js";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

export function extractUid(text) {
  if (!text) return null;
  const m =
    text.match(/sketchfab\.com\/(?:3d-models\/[^/?#]+-|models\/)([a-f0-9]{32})/i) ||
    text.match(/\b([a-f0-9]{32})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function browserHeaders(url) {
  const h = { ...UA };
  // Sketchfab media/CDN often expects a site referer (same as the viewer)
  if (/sketchfab\.com/i.test(url)) {
    h.Referer = "https://sketchfab.com/";
    h.Accept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
  }
  return h;
}

export async function fetchText(url) {
  const resp = await fetch(url, { credentials: "omit", headers: browserHeaders(url) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

export async function fetchBytes(url) {
  const resp = await fetch(url, { credentials: "omit", headers: browserHeaders(url) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function fetchViewerInfo(uid) {
  const embedUrl = `https://sketchfab.com/models/${uid}/embed`;
  const embedHtml = await fetchText(embedUrl);
  let m = embedHtml.match(
    /id="js-dom-data-prefetched-data"><!--([\s\S]*?)-->/
  );
  if (!m) {
    m = embedHtml.match(
      /js-dom-data-prefetched-data[^>]*>\s*<!--([\s\S]*?)-->/
    );
  }
  if (!m) throw new Error("Could not read public viewer data (private/deleted model?)");
  const raw = m[1].replace(/&#34;/g, '"');
  const data = JSON.parse(raw);
  let key = `/i/models/${uid}`;
  if (!(key in data)) {
    const alt = Object.keys(data).find((k) => k.startsWith(`/i/models/${uid}`));
    if (!alt) throw new Error(`Model ${uid} not in prefetched data`);
    key = alt;
  }
  return { info: data[key], embedHtml, prefetched: data };
}

/**
 * Parse viewer material channel bindings from embed options.materials.
 * This is the authoritative mapping (AlbedoPBR / NormalMap / … by texture uid),
 * not filename heuristics.
 *
 * @returns {Map<string, object>} materialName -> channel spec
 */
export function parseViewerMaterials(info) {
  const out = new Map();
  const mats = (info && info.options && info.options.materials) || {};
  for (const [id, mat] of Object.entries(mats)) {
    if (id === "updatedAt" || !mat || typeof mat !== "object") continue;
    const name = mat.name || id;
    const ch = mat.channels || {};
    const getTex = (channel, { requireEnable = true } = {}) => {
      const c = ch[channel];
      if (!c) return null;
      if (requireEnable && !c.enable) return null;
      const t = c.texture;
      if (!t || !t.uid) return null;
      return String(t.uid).toLowerCase();
    };
    /**
     * Sketchfab reports the texture's internal format. LUMINANCE is a
     * single-channel map, so it can never already be a packed ORM; RGB/RGBA on
     * a metalness channel is what a packed one actually looks like.
     */
    const getTexFormat = (channel) => {
      const c = ch[channel];
      const t = c && c.texture;
      return t && t.internalFormat ? String(t.internalFormat).toUpperCase() : "";
    };
    const getFactor = (channel, def) => {
      const c = ch[channel];
      if (!c || c.enable === false) return def;
      const f = c.factor;
      return typeof f === "number" ? f : def;
    };
    const albedo =
      getTex("AlbedoPBR") ||
      getTex("DiffusePBR") ||
      getTex("AlbedoPBR", { requireEnable: false }) ||
      getTex("DiffusePBR", { requireEnable: false }) ||
      getTex("DiffuseColor");
    const normal =
      getTex("NormalMap") ||
      getTex("BumpMap") ||
      getTex("NormalMap", { requireEnable: false }) ||
      getTex("BumpMap", { requireEnable: false });
    const metalness = getTex("MetalnessPBR");
    const roughness = getTex("RoughnessPBR");
    const gloss = getTex("GlossinessPBR");
    const specular = getTex("SpecularPBR") || getTex("SpecularF0");
    const ao = getTex("AOPBR") || getTex("CavityPBR");
    const opacityTex = getTex("Opacity") || getTex("AlphaMask");
    const emit = getTex("EmitColor");

    const metalF = getFactor("MetalnessPBR", 0);
    const glossF = getFactor("GlossinessPBR", null);
    const roughF = getFactor("RoughnessPBR", null);
    let roughnessFactor = 0.9;
    if (typeof roughF === "number") roughnessFactor = roughF;
    else if (typeof glossF === "number") roughnessFactor = Math.max(0, Math.min(1, 1 - glossF));

    const opacity = ch.Opacity || {};
    const alphaMask = ch.AlphaMask || {};
    const opacityEnable = !!(opacity.enable || alphaMask.enable);
    const opacityFactor =
      typeof opacity.factor === "number" ? opacity.factor : 1;
    const opacityType = opacity.type || alphaMask.type || "";
    const albedoFactor = getFactor("AlbedoPBR", 1);

    /**
     * Clearcoat and sheen, which glTF carries as extensions.
     *
     * Both are declared on every material with a default value, so presence
     * proves nothing — only the enable flag separates a material that was
     * authored with a clear coat from the 26 that merely have the slot. Read
     * the companion factors only when the parent channel is on, or every
     * material picks up a stray roughness it never asked for.
     *
     * ClearCoatNormalMap can only be set in Sketchfab's own material editor --
     * no upload format carries it -- so it is absent on almost every model and
     * was long assumed to be unreachable. It is not: once set by hand it comes
     * through like any other channel, and glTF has a slot for it. Read it under
     * the same enable gate as the rest of the coat, and carry its own flipY:
     * the editor exposes a "Flip green (-Y)" toggle per normal map, and a coat
     * normal read with the wrong handedness reads as dents instead of bumps.
     */
    const clearCoatCh = ch.ClearCoat || {};
    const clearCoatNormalCh = ch.ClearCoatNormalMap || {};
    const clearCoatOn = !!clearCoatCh.enable;
    const clearCoat = clearCoatOn
      ? {
          factor: typeof clearCoatCh.factor === "number" ? clearCoatCh.factor : 1,
          roughness: getFactor("ClearCoatRoughness", 0),
          textureUid: getTex("ClearCoat"),
          normalTextureUid: getTex("ClearCoatNormalMap"),
          normalFlipY: clearCoatNormalCh.flipY !== false,
        }
      : null;

    const sheenCh = ch.Sheen || {};
    const sheenOn = !!sheenCh.enable;
    const sheenColor = Array.isArray(sheenCh.color) && sheenCh.color.length >= 3
      ? sheenCh.color.slice(0, 3)
      : [1, 1, 1];
    const sheen = sheenOn
      ? {
          colorFactor: sheenColor,
          roughness: getFactor("SheenRoughness", 0),
          textureUid: getTex("Sheen"),
        }
      : null;

    // Sketchfab's refraction opacity is real glass, not an invisible shell.
    // glTF expresses it with KHR_materials_transmission, so it can be exported
    // instead of dropped.
    const transmission = opacityEnable && /refract/i.test(opacityType);

    // Genuinely invisible: nothing to export at any opacity model.
    const invisible =
      opacityEnable &&
      (opacityFactor <= 0.01 ||
        (opacityType === "additive" && albedoFactor <= 0.01));

    // Glass / invisible shells create a "veil" if exported opaque. Name matching
    // is a blunt instrument though — a visible refractive cover (opacity factor
    // 1) hit this too and lost the model its glass. Only drop a named shell when
    // it cannot be represented faithfully.
    const namedVeil =
      opacityEnable && (/glass/i.test(name) || /rim/i.test(name));

    const skipMesh = invisible || (namedVeil && !transmission);

    /**
     * Texture unit per texture, keyed by uid.
     *
     * Sketchfab binds each channel to a GL texture unit and stores that unit's
     * UVs in the geometry's TexCoord<unit> attribute. The numbering is sparse
     * -- r3_01 uses units 0, 1, 3, 5, 7, 8, 12 and 18 -- so the unit is not a
     * UV set index and cannot be handed to glTF's texCoord as-is. Recording it
     * lets the converter map it onto whichever index that attribute landed at.
     *
     * Keyed by uid rather than by channel so the role -> channel priority
     * chains above do not have to be repeated; a uid bound to two channels at
     * different units keeps the first, which is what the shared texture would
     * sample anyway.
     */
    const texCoordUnits = {};
    /**
     * Wrap mode per texture, keyed by uid.
     *
     * The converter used to emit one global REPEAT sampler, which is right for
     * the overwhelming majority -- 102 of r3_01's 106 bound textures -- and
     * silently wrong for the rest: a clamped strip tiles instead of holding its
     * edge pixel, which looks like a UV bug rather than a sampler one.
     */
    const textureWraps = {};
    const uvTransforms = {};
    for (const c of Object.values(ch)) {
      const t = c && c.texture;
      if (!t || !t.uid) continue;
      const uid = String(t.uid).toLowerCase();
      if (typeof t.texCoordUnit === "number" && !(uid in texCoordUnits)) {
        texCoordUnits[uid] = t.texCoordUnit;
      }
      if (!(uid in textureWraps) && (t.wrapS || t.wrapT)) {
        textureWraps[uid] = { wrapS: t.wrapS || "REPEAT", wrapT: t.wrapT || "REPEAT" };
      }
      /**
       * UV transform, when the channel carries a non-identity one.
       *
       * Recorded per channel rather than per uid: the same image can be placed
       * differently on two channels, and unlike wrap mode the transform is a
       * property of the binding, not of the texture.
       */
      const uvt = c.UVTransforms;
      if (uvt && !(uid in uvTransforms)) {
        const scale = Array.isArray(uvt.scale) ? [uvt.scale[0], uvt.scale[1]] : [1, 1];
        const offset = Array.isArray(uvt.offset) ? [uvt.offset[0], uvt.offset[1]] : [0, 0];
        const rotation = typeof uvt.rotation === "number" ? uvt.rotation : 0;
        const identity =
          scale[0] === 1 && scale[1] === 1 &&
          offset[0] === 0 && offset[1] === 0 &&
          rotation === 0;
        if (!identity) uvTransforms[uid] = { scale, offset, rotation };
      }
    }

    const normalCh = ch.NormalMap || {};
    out.set(name, {
      texCoordUnits,
      textureWraps,
      uvTransforms,
      id,
      name,
      albedoUid: albedo,
      normalUid: normal,
      metalnessUid: metalness,
      roughnessUid: roughness || gloss,
      // GlossinessPBR is inverted roughness. The factor is converted above;
      // consumers of the *texture* must invert it too (see packOrmPixels).
      roughnessIsGloss: !roughness && !!gloss,
      metalnessFormat: getTexFormat("MetalnessPBR"),
      specularUid: specular,
      aoUid: ao,
      opacityUid: opacityTex,
      emitUid: emit,
      metallicFactor: typeof metalF === "number" ? metalF : 0,
      roughnessFactor,
      normalFlipY: normalCh.flipY !== false, // Sketchfab default often flipY:true
      doubleSided: true,
      opacityEnable,
      opacityFactor,
      opacityType,
      transmission,
      albedoFactor,
      clearCoat,
      sheen,
      skipMesh,
      // solid tint when no albedo texture
      baseColorFactor: (() => {
        const dc = ch.DiffuseColor || ch.DiffusePBR || {};
        const col = dc.color;
        if (Array.isArray(col) && col.length >= 3) {
          return [col[0], col[1], col[2], 1];
        }
        return [1, 1, 1, 1];
      })(),
    });
  }
  return out;
}

export function isBinzFormat(info) {
  try {
    return !!(info.files && info.files[0].p[0].b);
  } catch {
    return false;
  }
}

export function modelBinzUrls(info) {
  const osgjsUrl = info.files[0].osgjsUrl;
  return [
    osgjsUrl,
    osgjsUrl.replace("file.binz", "model_file.binz"),
    osgjsUrl.replace("file.binz", "model_file_wireframe.binz"),
  ];
}

/**
 * Animation payload URLs for a model.
 *
 * Curves are not part of file.binz — each clip is a separate gzip beside the
 * model files, named by the uid listed in options.animation.order.
 */
export function animationUrls(info) {
  const order =
    (info && info.options && info.options.animation && info.options.animation.order) || [];
  const osgjsUrl = info && info.files && info.files[0] && info.files[0].osgjsUrl;
  if (!order.length || !osgjsUrl) return [];
  const base = osgjsUrl.split("/files/")[0];
  if (!base || base === osgjsUrl) return [];
  const seen = new Set();
  const out = [];
  for (const raw of order) {
    const uid = String(raw || "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ uid, url: `${base}/animations/${uid}.bin.gz` });
  }
  return out;
}

/** gzip magic, so an already-inflated body is left alone. */
export function isGzip(bytes) {
  return !!bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate a clip payload, if it still needs it.
 *
 * The CDN serves these with `Content-Encoding: gzip`, which fetch() honours —
 * the body arrives already inflated and inflating it again throws. Trust the
 * magic bytes rather than the .gz in the URL.
 */
async function maybeGunzip(bytes) {
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream !== "function") {
    throw new Error("no DecompressionStream");
  }
  const ds = new DecompressionStream("gzip");
  const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Download and inflate every animation clip.
 *
 * Keyed as `animations/<uid>.bin` to mirror how the .binz payloads are stored
 * decompressed; the converter matches channels back by uid.
 *
 * @returns {Promise<Object<string, Uint8Array>>} empty when the model has none
 */
export async function fetchAnimations(info, onProgress) {
  const out = {};
  const clips = animationUrls(info);
  if (!clips.length) return out;
  for (const { uid, url } of clips) {
    const short = uid.slice(0, 8);
    try {
      if (onProgress) onProgress(`Downloading animation ${short}…`);
      const body = await fetchBytes(url);
      if (!body || body.length < 8) throw new Error("empty payload");
      const raw = await maybeGunzip(body);
      out[`animations/${uid}.bin`] = raw;
      if (onProgress) {
        onProgress(`  → animations/${short}.bin (${raw.length} bytes)`);
      }
    } catch (e) {
      // A missing clip costs the animation, not the model: keep going.
      if (onProgress) {
        onProgress(`  animation ${short} unavailable: ${e && e.message ? e.message : e}`);
      }
    }
  }
  return out;
}

export function getDiterB(info) {
  return info.files[0].p[0].b;
}

/**
 * Extract static 40-hex key from live viewer JS. Auto-updates when Sketchfab rotates it.
 */
export async function extractStaticKey(embedHtml, onProgress) {
  const urls = [
    ...new Set(
      [...embedHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
    ),
  ].sort((a, b) => {
    const sa = a.includes("/static/builds/web/dist/") ? 0 : 1;
    const sb = b.includes("/static/builds/web/dist/") ? 0 : 1;
    return sa - sb;
  });

  const patterns = [
    /exports\s*\.\s*k\s*:\s*\(\)\s*=>\s*\w+\}\s*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})(?:\\n)?"/,
    /\{k:\s*\(\)\s*=>\s*\w+\}[^;]*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})(?:\\n)?"/,
    /a\.d\(t,\{\s*k:\(\)=>\w+\s*\}\)[^"]{0,40}const\s+\w+\s*=\s*"([0-9a-f]{40})(?:\\n)?"/,
    /const\s+\w+\s*=\s*"([0-9a-f]{40})\\n"/,
    /const\s+\w+\s*=\s*"([0-9a-f]{40})"/,
  ];

  for (const url of urls) {
    const name = url.split("/").pop();
    let js;
    try {
      if (onProgress) onProgress(`Reading key from ${name}…`);
      js = await fetchText(url);
    } catch {
      continue;
    }
    for (const pat of patterns) {
      const mm = js.match(pat);
      if (mm && /^[0-9a-f]{40}$/i.test(mm[1])) {
        const key = mm[1].toLowerCase();
        try {
          await chrome.storage.local.set({ sf_static_key: key });
        } catch (_) {}
        return key;
      }
    }
    if (js.length < 200000) {
      const hexes = [...js.matchAll(/["']([0-9a-f]{40})(?:\\n)?["']/g)].map(
        (x) => x[1].toLowerCase()
      );
      const uniq = [...new Set(hexes)];
      if (uniq.length === 1) {
        try {
          await chrome.storage.local.set({ sf_static_key: uniq[0] });
        } catch (_) {}
        return uniq[0];
      }
    }
  }

  try {
    const stored = await chrome.storage.local.get("sf_static_key");
    if (stored.sf_static_key && /^[0-9a-f]{40}$/i.test(stored.sf_static_key)) {
      return stored.sf_static_key.toLowerCase();
    }
  } catch (_) {}
  return DEFAULT_STATIC_KEY;
}

/**
 * Pick best image variant for a texture set.
 * Prefer max resolution; among same resolution prefer PNG (lossless) over JPEG.
 */
/**
 * Protection key for the chosen variant.
 *
 * Only the variant's own key counts — Sketchfab leaves `pk` null on the
 * previews it serves unscrambled, and borrowing a sibling's key would
 * "descramble" an image that was never scrambled.
 */
function readPk(tex, im) {
  const own = im && Object.prototype.hasOwnProperty.call(im, "pk") ? im.pk : undefined;
  const raw = own === undefined ? tex && tex.pk : own;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Whether a protected variant can actually be descrambled.
 *
 * The viewer only ever uploads power-of-two textures — WebGL1 needs them for
 * mipmapping and REPEAT wrapping — so those are the only variants its
 * protection shader is ever asked to reverse, and the only ones scrambled in a
 * form that reverses. Sketchfab also keeps the raw upload at its original
 * size; that copy is stored scrambled but nothing ever unscrambles it, and
 * running the shader's permutation over it yields a patchwork.
 *
 * The permutation shuffles pixels within 8x8 tiles over a
 * floor(w/8) x floor(h/8) grid while wrapping indices modulo w*h, so an
 * off-grid size is not even a bijection: at 800x100 it reads 3040 pixels twice
 * and never reads 6368 others. Power-of-two rules that out too.
 */
export function isDescramblable(im, texPk) {
  if (!im) return false;
  if (readPk({ pk: texPk }, im) == null) return true; // never scrambled
  const w = im.width || 0;
  const h = im.height || 0;
  if (!w || !h) return true;
  return isPowerOfTwo(w) && isPowerOfTwo(h);
}

function imageEdge(im) {
  return Math.max(im && im.width ? im.width : 0, im && im.height ? im.height : 0);
}

function scoreImage(im) {
  const w = im.width || 0;
  const h = im.height || 0;
  const area = w * h || 0;
  const size = im.size || 0;
  const url = (im.url || "").toLowerCase();
  const isPng = url.endsWith(".png") || (im.options && !im.options.quality);
  return area * 10 + (isPng ? 5 : 0) + Math.min(size, 1e9) / 1e12;
}

/**
 * Pick a texture variant.
 * maxEdge 0 / omitted = original (largest). Never downscale unless the
 * caller explicitly passes 2048 or 4096.
 */
export function pickBestImage(images, maxEdge, texPk = null) {
  if (!images || !images.length) return null;
  const edge = maxEdge === 2048 || maxEdge === 4096 ? maxEdge : 0;
  const usable = [];
  for (const im of images) {
    const w = im.width || 0;
    const h = im.height || 0;
    if (w > 0 && h > 0 && (w < 32 || h < 32)) continue;
    usable.push(im);
  }
  let pool = usable.length ? usable : images.slice();
  const decodable = pool.filter((im) => isDescramblable(im, texPk));
  if (decodable.length) pool = decodable;
  if (!edge) {
    let best = null;
    for (const im of pool) {
      const score = scoreImage(im);
      if (!best || score > best._score) best = { ...im, _score: score };
    }
    return best;
  }
  const atMost = pool.filter((im) => imageEdge(im) <= edge);
  if (atMost.length) {
    let best = null;
    for (const im of atMost) {
      const score = scoreImage(im);
      if (!best || score > best._score) best = { ...im, _score: score };
    }
    return best;
  }
  let nearest = null;
  for (const im of pool) {
    const e = imageEdge(im);
    if (!e) continue;
    if (!nearest || e < imageEdge(nearest)) nearest = im;
  }
  return nearest ? { ...nearest } : null;
}

/**
 * Download public model textures (highest resolution available).
 * Indexes by texture uid for viewer material channel matching.
 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit || 1, items.length || 1));
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export async function fetchTextures(uid, onProgress, opts) {
  const maxEdge =
    opts && (opts.maxEdge === 2048 || opts.maxEdge === 4096) ? opts.maxEdge : 0;
  const concurrency = Math.max(1, (opts && opts.concurrency) || 3);
  const out = [];
  const headers = {
    ...UA,
    Referer: `https://sketchfab.com/models/${uid}/embed`,
    Accept: "application/json,image/*,*/*;q=0.8",
  };
  try {
    // Prefer optimized endpoint used by the viewer; fall back to plain.
    let results = [];
    for (const path of [
      `https://sketchfab.com/i/models/${uid}/textures?optimized=1`,
      `https://sketchfab.com/i/models/${uid}/textures`,
    ]) {
      try {
        const resp = await fetch(path, { credentials: "omit", headers });
        if (!resp.ok) continue;
        const data = await resp.json();
        results = data.results || [];
        if (results.length) {
          if (onProgress) onProgress(`Textures API: ${path.includes("optimized") ? "optimized" : "plain"} (${results.length})`);
          break;
        }
      } catch (_) {}
    }
    if (!results.length) throw new Error("no texture results");

    if (onProgress) onProgress(`Textures: ${results.length} map(s)`);
    let scrambledHints = 0;
    let done = 0;
    const total = results.length;
    // Pick variants and file names before downloading: two textures can carry
    // the same name, and resolving that inside the concurrent workers would
    // make which one keeps the plain name depend on download order — while the
    // loser silently overwrote the winner in the zip.
    const usedNames = new Set();
    const plan = results.map((tex, idx) => {
      const best = pickBestImage(tex.images || [], maxEdge, tex.pk);
      if (!best || !best.url) return null;

      const tuid = String(tex.uid || "").toLowerCase();
      let base = String(tex.name || `texture_${idx + 1}`).replace(/[^\w.\-]+/g, "_");
      const urlPath = best.url.split("?")[0];
      let ext = "";
      const mExt = base.match(/\.(png|jpe?g|webp|gif)$/i);
      if (mExt) {
        ext = mExt[0].toLowerCase().replace(".jpeg", ".jpg");
      } else {
        const uExt = (urlPath.match(/\.(png|jpe?g|webp|gif)$/i) || [])[0];
        if (uExt) ext = uExt.toLowerCase().replace(".jpeg", ".jpg");
        else ext = urlPath.includes(".png") ? ".png" : ".jpg";
        base = base + ext;
      }
      if (usedNames.has(base.toLowerCase())) {
        const stem = ext && base.toLowerCase().endsWith(ext)
          ? base.slice(0, base.length - ext.length)
          : base;
        base = `${stem}_${tuid.slice(0, 8) || idx + 1}${ext}`;
      }
      usedNames.add(base.toLowerCase());

      return { tex, best, base, tuid, pk: readPk(tex, best) };
    });

    const fetched = await mapPool(plan, concurrency, async (entry) => {
      if (!entry) return null;
      const { tex, best, base, tuid, pk } = entry;
      try {
        let bytes = await fetchBytes(best.url);
        if (!bytes || bytes.length < 32) return null;
        const isPng =
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
        const isWebp =
          bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
        if (!isPng && !isJpg && !isWebp) {
          if (onProgress) onProgress(`  skip non-image: ${base}`);
          return null;
        }
        let fromDescramble = false;
        if (pk != null && (best.width || 0) >= 64 && (best.height || 0) >= 64) {
          if (onProgress) onProgress(`  descramble start pk=${pk} ${bytes.length} B`);
          try {
            const dec = await descrambleImageBytes(bytes, pk, onProgress);
            if (dec && dec.length > 64) {
              bytes = dec;
              fromDescramble = true;
              if (onProgress) onProgress(`  descramble ok ${dec.length} B`);
            } else if (onProgress) {
              onProgress(`  descramble empty result`);
            }
          } catch (de) {
            if (onProgress) {
              onProgress(`  descramble failed: ${de && de.message ? de.message : de}`);
            }
          }
        } else if (onProgress && pk == null) {
          onProgress(`  no pk — leaving CDN bytes`);
        }
        if ((best.width || 0) >= 512 && bytes.length < 80_000 && isJpg) {
          scrambledHints++;
        }
        const imageUids = [];
        const fileNames = [];
        const addId = (id) => {
          const s = String(id || "").toLowerCase();
          if (/^[a-f0-9]{32}$/.test(s) && imageUids.indexOf(s) === -1) imageUids.push(s);
        };
        addId(tuid);
        for (const im of tex.images || []) {
          addId(im && im.uid);
          const url = (im && im.url) || "";
          const fn = (url.split("?")[0].split("/").pop() || "").toLowerCase();
          if (fn) {
            fileNames.push(fn);
            addId(fn.replace(/\.(png|jpe?g|webp|gif)$/i, ""));
          }
        }
        done++;
        if (onProgress) {
          onProgress(
            `Texture ${done}/${total}: ${base} (${best.width || "?"}x${best.height || "?"}` +
              (pk != null ? `, pk=${pk}` : "") +
              `)`
          );
        }
        return {
          name: `textures/${base}`,
          data: bytes,
          uid: tuid,
          imageUids,
          fileNames,
          originalName: base,
          width: best.width || 0,
          height: best.height || 0,
          fromDescramble,
          pk,
        };
      } catch (e) {
        if (onProgress) onProgress(`  fail ${base}: ${e.message || e}`);
        return null;
      }
    });
    for (const item of fetched) {
      if (item) out.push(item);
    }
    if (scrambledHints > 0 && onProgress) {
      onProgress(
        `  NOTE: ${scrambledHints} texture(s) look unusually small for their resolution — Sketchfab may serve protected/preview maps for this model`
      );
    }
  } catch (e) {
    if (onProgress) onProgress(`Textures unavailable: ${e.message || e}`);
  }
  return out;
}

export function sanitizeName(name) {
  return String(name || "model")
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "model";
}

function b64ToU8(b64) {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Normalize capture payload: ArrayBuffer / Uint8Array / base64 → Uint8Array */
function captureBytes(cap) {
  if (!cap) return null;
  if (cap.data instanceof Uint8Array && cap.data.length) return cap.data;
  if (cap.data instanceof ArrayBuffer && cap.data.byteLength) {
    return new Uint8Array(cap.data);
  }
  if (ArrayBuffer.isView(cap.data) && cap.data.byteLength) {
    return new Uint8Array(
      cap.data.buffer,
      cap.data.byteOffset,
      cap.data.byteLength
    );
  }
  // Cross-realm / serialized: {0:n,1:n,...} or number[]
  if (cap.data && typeof cap.data === "object" && typeof cap.data.length === "number") {
    try {
      return Uint8Array.from(cap.data);
    } catch (_) {}
  }
  if (cap.png instanceof Uint8Array && cap.png.length) return cap.png;
  if (cap.png instanceof ArrayBuffer && cap.png.byteLength) {
    return new Uint8Array(cap.png);
  }
  if (cap.dataBase64) return b64ToU8(cap.dataBase64);
  if (cap.pngBase64) return b64ToU8(cap.pngBase64);
  return null;
}

/**
 * Merge WebGL/page-captured textures over public-API downloads.
 * Captures are what the live viewer actually uploaded/fetched (often higher quality).
 *
 * @param {Array} apiTextures - from fetchTextures
 * @param {Array} captures - from page hook ({ uid, name, url, pngBase64, width, height, scrambledHint })
 * @param {(msg:string)=>void} [onProgress]
 */
export function mergeCapturedTextures(apiTextures, captures, onProgress) {
  const api = Array.isArray(apiTextures) ? apiTextures.slice() : [];
  const caps = Array.isArray(captures) ? captures : [];
  if (!caps.length) return api;

  const byUid = new Map();
  const byName = new Map();
  /** @type {object[]} */
  const pool = [];
  let decodeFail = 0;
  const indexCap = (key, cap, map) => {
    if (!key) return;
    const k = String(key).toLowerCase();
    if (!map.has(k)) map.set(k, cap);
  };
  for (const c of caps) {
    if (!c) continue;
    const bytes = captureBytes(c);
    if (!bytes || bytes.length < 32) {
      decodeFail++;
      if (onProgress) {
        onProgress(
          `  skip capture (no bytes): uid=${c.uid || "?"} name=${c.name || "?"} keys=${Object.keys(c).join(",")}`
        );
      }
      continue;
    }
    c._bytes = bytes;
    c.byteLength = bytes.length;
    pool.push(c);
    indexCap(c.uid, c, byUid);
    // Filename / image uid only — not every hex in the URL (shared folders collide)
    if (c.name) {
      const bare = String(c.name).split("/").pop().toLowerCase();
      indexCap(bare, c, byName);
      const stem = bare.replace(/\.(png|jpe?g|webp|gif)$/i, "");
      indexCap(stem, c, byName);
      if (/^[a-f0-9]{32}$/.test(stem)) indexCap(stem, c, byUid);
    }
    if (c.url) {
      try {
        const fn = String(c.url).split("?")[0].split("/").pop() || "";
        indexCap(fn.toLowerCase(), c, byName);
        const stem = fn.replace(/\.(png|jpe?g|webp|gif)$/i, "").toLowerCase();
        if (/^[a-f0-9]{32}$/.test(stem)) indexCap(stem, c, byUid);
      } catch (_) {}
    }
  }

  if (onProgress) {
    onProgress(
      `  capture pool: ${pool.length} usable / ${caps.length} raw` +
        (decodeFail ? ` (${decodeFail} failed decode)` : "")
    );
  }

  const used = new Set();
  const markUsed = (cap) => {
    used.add(cap);
    if (cap.uid) used.add("uid:" + String(cap.uid).toLowerCase());
    if (cap.name) used.add("name:" + String(cap.name).toLowerCase());
  };
  const isUsed = (cap) =>
    used.has(cap) ||
    (cap.uid && used.has("uid:" + String(cap.uid).toLowerCase())) ||
    (cap.name && used.has("name:" + String(cap.name).toLowerCase()));

  const preferCapture = (cap) => {
    const data = cap._bytes || captureBytes(cap);
    if (!data || data.length < 32) return null;
    // Prefer non-scrambled; still allow if only option and large
    if (cap.scrambledHint && data.length < 50000) return null;
    if (cap.scrambledHint) return null;
    return data;
  };

  // Sort API so unique sizes get first pick of size-matched captures
  const sizeCount = new Map();
  for (const t of api) {
    const k = (t.width || 0) + "x" + (t.height || 0);
    sizeCount.set(k, (sizeCount.get(k) || 0) + 1);
  }

  const out = [];
  let replaced = 0;

  const unmatched = [];
  for (const t of api) {
    if (t.fromDescramble) {
      out.push(t);
      replaced++; // count as recovered
      if (onProgress) {
        onProgress(`  descramble → ${t.originalName || t.name} (pk=${t.pk})`);
      }
      continue;
    }
    const uid = t.uid ? String(t.uid).toLowerCase() : "";
    const bare = String(t.originalName || t.name || "")
      .split("/")
      .pop()
      .toLowerCase();
    const stem = bare.replace(/\.(png|jpe?g|webp)$/i, "");
    let cap = null;
    let how = "";
    if (uid && byUid.get(uid) && !isUsed(byUid.get(uid))) {
      cap = byUid.get(uid);
      how = "set-uid";
    }
    if (!cap && t.imageUids) {
      for (const id of t.imageUids) {
        const hit = byUid.get(String(id).toLowerCase());
        if (hit && !isUsed(hit)) {
          cap = hit;
          how = "image-uid";
          break;
        }
      }
    }
    if (!cap && t.fileNames) {
      for (const fn of t.fileNames) {
        const hit = byName.get(String(fn).toLowerCase()) || byUid.get(String(fn).replace(/\.(png|jpe?g|webp|gif)$/i, "").toLowerCase());
        if (hit && !isUsed(hit)) {
          cap = hit;
          how = "filename";
          break;
        }
      }
    }
    if (!cap) {
      const hit = byName.get(bare) || byName.get(stem);
      if (hit && !isUsed(hit)) {
        cap = hit;
        how = "name";
      }
    }
    // Size ONLY when this resolution is unique among API maps
    if (!cap && t.width && t.height && (sizeCount.get(t.width + "x" + t.height) || 0) === 1) {
      cap =
        pool.find(
          (c) =>
            !isUsed(c) &&
            !c.scrambledHint &&
            c.width === t.width &&
            c.height === t.height
        ) || null;
      if (cap) how = "unique-size";
    }

    if (cap && !isUsed(cap)) {
      const data = preferCapture(cap);
      if (data) {
        out.push({
          ...t,
          data,
          width: cap.width || t.width,
          height: cap.height || t.height,
          fromCapture: true,
          captureFrom: cap.from || "webgl",
        });
        markUsed(cap);
        replaced++;
        if (onProgress) {
          onProgress(
            `  blit → ${t.originalName || bare} via ${how} (${cap.width || "?"}x${
              cap.height || "?"
            }, ${data.length} B)`
          );
        }
        continue;
      }
    }
    unmatched.push(t.originalName || bare);
    out.push(t);
  }

  // Always keep unmatched non-scrambled captures as extras (for manual rebinding)
  let extra = 0;
  for (const c of pool) {
    if (isUsed(c)) continue;
    if (c.scrambledHint) continue;
    const data = c._bytes || captureBytes(c);
    if (!data || data.length < 64) continue;
    let fname = (c.name || `gpu_capture_${extra}.png`).split("/").pop();
    fname = fname.replace(/[^\w.\-]+/g, "_");
    if (!/\.(png|jpe?g|webp)$/i.test(fname)) fname += ".png";
    // avoid overwrite
    fname = `gpu_${extra}_` + fname;
    out.push({
      name: `textures/${fname}`,
      data,
      uid: c.uid ? String(c.uid).toLowerCase() : "",
      originalName: fname,
      fromCapture: true,
      captureFrom: c.from || "webgl",
      width: c.width || 0,
      height: c.height || 0,
    });
    markUsed(c);
    extra++;
    if (onProgress) {
      onProgress(
        `  + extra GPU capture ${fname} (${c.width || "?"}x${c.height || "?"}, ${data.length} B)`
      );
    }
  }

  const keptApi = Math.max(0, api.length - replaced);
  if (onProgress) {
    onProgress(
      `WebGL merge: ${replaced} replaced, ${extra} extra, ${keptApi} API kept, ${out.length} total (pool ${pool.length}/${caps.length})`
    );
    if (unmatched.length) {
      onProgress(`  kept CDN (no matching blit): ${unmatched.join(", ")}`);
    }
    if (pool.length === 0 && caps.length > 0) {
      onProgress(
        `  WARNING: ${caps.length} capture(s) arrived but bytes could not be decoded (messaging?)`
      );
    } else if (replaced === 0 && extra === 0 && pool.length > 0) {
      onProgress(
        `  WARNING: all ${pool.length} capture(s) flagged scrambled — GPU may not hold clean maps`
      );
    } else if (replaced === 0 && caps.length === 0) {
      onProgress(
        `  WARNING: no GPU captures — protected CDN maps stay striped`
      );
    }
  }
  return out;
}
