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

    // Glass / invisible shells create a "veil" if exported opaque
    const skipMesh =
      opacityEnable &&
      (opacityFactor <= 0.01 ||
        /glass/i.test(name) ||
        /rim/i.test(name) ||
        (opacityType === "additive" && albedoFactor <= 0.01));

    const normalCh = ch.NormalMap || {};
    out.set(name, {
      id,
      name,
      albedoUid: albedo,
      normalUid: normal,
      metalnessUid: metalness,
      roughnessUid: roughness || gloss,
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
      albedoFactor,
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
function readPk(tex, im) {
  const vals = [];
  if (im && im.pk != null) vals.push(im.pk);
  if (tex && tex.pk != null) vals.push(tex.pk);
  if (tex && tex.images) {
    for (const x of tex.images) {
      if (x && x.pk != null) vals.push(x.pk);
    }
  }
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickBestImage(images) {
  if (!images || !images.length) return null;
  let best = null;
  for (const im of images) {
    const w = im.width || 0;
    const h = im.height || 0;
    if (w > 0 && h > 0 && (w < 32 || h < 32)) continue;
    const area = w * h || 0;
    const size = im.size || 0;
    const url = (im.url || "").toLowerCase();
    const isPng = url.endsWith(".png") || (im.options && !im.options.quality);
    // score: primarily area, then prefer png, then file size
    const score = area * 10 + (isPng ? 5 : 0) + Math.min(size, 1e9) / 1e12;
    if (!best || score > best._score) best = { ...im, _score: score };
  }
  if (!best) {
    for (const im of images) {
      const score = (im.size || 0) || (im.width || 0) * (im.height || 0);
      if (!best || score > best._score) best = { ...im, _score: score };
    }
  }
  return best;
}

/**
 * Download public model textures (highest resolution available).
 * Indexes by texture uid for viewer material channel matching.
 */
export async function fetchTextures(uid, onProgress) {
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
    let i = 0;
    let scrambledHints = 0;
    for (const tex of results) {
      i++;
      const best = pickBestImage(tex.images || []);
      if (!best || !best.url) continue;

      const tuid = String(tex.uid || "").toLowerCase();
      let base = String(tex.name || `texture_${i}`).replace(/[^\w.\-]+/g, "_");
      const urlPath = best.url.split("?")[0];
      let ext = "";
      const mExt = base.match(/\.(png|jpe?g|webp|gif)$/i);
      if (mExt) {
        ext = mExt[0].toLowerCase().replace(".jpeg", ".jpg");
        if (ext === ".jpeg") ext = ".jpg";
      } else {
        const uExt = (urlPath.match(/\.(png|jpe?g|webp|gif)$/i) || [])[0];
        if (uExt) ext = uExt.toLowerCase().replace(".jpeg", ".jpg");
        else ext = urlPath.includes(".png") ? ".png" : ".jpg";
        base = base + ext;
      }

      const pk = readPk(tex, best);
      if (onProgress) {
        onProgress(
          `Texture ${i}/${results.length}: ${base} (${best.width || "?"}x${best.height || "?"}` +
            (pk != null ? `, pk=${pk}` : "") +
            `)`
        );
      }
      try {
        let bytes = await fetchBytes(best.url);
        if (!bytes || bytes.length < 32) continue;
        const isPng =
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
        const isWebp =
          bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
        if (!isPng && !isJpg && !isWebp) {
          if (onProgress) onProgress(`  skip non-image: ${base}`);
          continue;
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
        // Heuristic: very small entropy in high-res maps often means protected/scrambled
        // (uniform diagonal noise). Flag for the log — mapping still proceeds.
        if ((best.width || 0) >= 512 && bytes.length < 80_000 && isJpg) {
          scrambledHints++;
        }
        // ONLY set uid + per-image uid + filename stem.
        // Do NOT index every 32-hex in the URL: model uid and a shared
        // folder id appear on ALL maps and steal blit matches (Hair_AO←Hair_M).
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
        out.push({
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
        });
      } catch (e) {
        if (onProgress) onProgress(`  fail ${base}: ${e.message || e}`);
      }
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
