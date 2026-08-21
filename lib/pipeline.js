/**
 * Full download pipeline for a public Sketchfab model → glTF (GLB) ZIP.
 */
import {
  extractUid,
  fetchViewerInfo,
  isBinzFormat,
  modelBinzUrls,
  getDiterB,
  extractStaticKey,
  fetchTextures,
  fetchAnimations,
  fetchBytes,
  sanitizeName,
  parseViewerMaterials,
  mergeCapturedTextures,
  viewerOrientation,
} from "./sf-api.js";
import { decryptBinzBytes, loadWasmBytes, outNameFor } from "./decrypt.js";
import { buildZip } from "./zip.js";
import {
  convertOsgjsToGlbFromFiles,
  classifyTextureName,
  resolveUidToBase,
  textureBasename,
} from "./osgjs2gltf.js";
import { planOrm, packOrmTexture } from "./orm.js";
import { GITHUB_URL, isDownloadTextures, loadPrefs } from "./settings.js";

/**
 * Pack each material's separate metalness / roughness maps into one glTF ORM
 * texture, appending the result to the texture list and tagging the spec so
 * the converter binds it.
 *
 * Failures are non-fatal: the material falls back to numeric factors, which
 * looks flat but never turns a plastic surface into a mirror.
 *
 * @param {Map<string, object>} viewerMaterials
 * @param {Array<{name: string, data: Uint8Array, uid?: string}>} textures
 * @param {(msg: string) => void} step
 * @param {number} maxTextureEdge
 * @returns {Promise<Array>} textures, plus any packed ORM maps
 */
async function packOrmMaps(viewerMaterials, textures, step, maxTextureEdge) {
  if (!viewerMaterials || !viewerMaterials.size || !textures.length) return textures;

  // Resolve uids exactly the way the converter does, so a texture the
  // converter would bind is never one the packer failed to find.
  const byBase = new Map();
  for (const t of textures) {
    byBase.set(textureBasename(t.name).toLowerCase(), t);
  }
  const resolve = (uid) => resolveUidToBase(uid, textures);
  const entryFor = (base) =>
    base ? byBase.get(textureBasename(base).toLowerCase()) || null : null;

  const added = [];
  let packed = 0;
  let reused = 0;
  const cache = new Map();

  for (const spec of viewerMaterials.values()) {
    const plan = planOrm(spec, resolve, classifyTextureName);
    if (plan.action !== "pack") continue;

    const key = `${plan.metalName || "-"}|${plan.roughName || "-"}|${plan.invertRough ? 1 : 0}`;
    if (cache.has(key)) {
      spec.packedOrmName = cache.get(key);
      reused++;
      continue;
    }

    const metal = entryFor(plan.metalName);
    const rough = entryFor(plan.roughName);
    if (!metal && !rough) continue;

    const stem = String(plan.metalName || plan.roughName)
      .replace(/\.[^.]+$/, "")
      .replace(/_(metallic|metalness|metal|roughness|rough|gloss|glossiness)$/i, "");
    const outName = `textures/${stem}_ORM.png`;

    try {
      const result = await packOrmTexture({
        metal,
        rough,
        invertRough: plan.invertRough,
        maxEdge: maxTextureEdge,
      });
      added.push({
        name: outName,
        data: result.data,
        uid: "",
        originalName: `${stem}_ORM.png`,
        width: result.width,
        height: result.height,
        fromOrmPack: true,
      });
      byBase.set(`${stem}_ORM.png`.toLowerCase(), added[added.length - 1]);
      cache.set(key, `${stem}_ORM.png`);
      spec.packedOrmName = `${stem}_ORM.png`;
      packed++;
    } catch (e) {
      step(`  ORM pack failed for ${spec.name || "?"}: ${e && e.message ? e.message : e}`);
    }
  }

  if (packed || reused) {
    step(`  Packed ${packed} ORM map(s) from separate metal/rough maps` + (reused ? ` (${reused} shared)` : ""));
  }
  return added.length ? textures.concat(added) : textures;
}

const README_TXT = [
  "Sketchfab Public Downloader v1.0",
  "================================",
  "",
  GITHUB_URL,
  "",
  "Import the .glb: Blender → File → Import → glTF 2.0.",
  "Viewport: Z → Material Preview (Solid mode hides textures).",
  "",
  "Импорт .glb: Blender → Файл → Импорт → glTF 2.0.",
  "Вьюпорт: Z → Предпросмотр материала (режим Solid прячет текстуры).",
  "",
].join("\n");

/**
 * @param {string} pageUrl
 * @param {(msg:string)=>void} [onProgress]
 * @param {{ capturedTextures?: Array }} [options] - WebGL/page captures from content hook
 */
export async function downloadModel(pageUrl, onProgress = () => {}, options = {}) {
  const logLines = [];
  const step = (msg) => {
    const line = String(msg || "");
    logLines.push(line);
    try {
      onProgress(line);
    } catch (_) {}
  };

  try {
    const uid = extractUid(pageUrl);
    if (!uid) {
      throw new Error("Open a Sketchfab model page first (URL with model id).");
    }
    step(`UID: ${uid}`);

    step("Reading public viewer…");
    const { info, embedHtml } = await fetchViewerInfo(uid);
    const name = sanitizeName(info.name || uid);
    const author =
      (info.user && (info.user.displayName || info.user.username)) || "unknown";
    step(`Model: ${info.name || name} (by ${author})`);

    // Authoritative material channel map from the live viewer (fixes wrong ORM/"veil")
    const viewerMaterials = parseViewerMaterials(info);
    step(`Viewer materials: ${viewerMaterials.size}`);
    let skipCount = 0;
    for (const spec of viewerMaterials.values()) {
      if (spec.skipMesh) skipCount++;
    }
    if (skipCount) step(`  (${skipCount} glass/invisible material(s) will be skipped)`);

    if (!isBinzFormat(info)) {
      throw new Error(
        "This model is not in the current encrypted .binz format (or is private)."
      );
    }

    step("Extracting decrypt key (auto)…");
    const staticKey = await extractStaticKey(embedHtml, step);
    step(`Static key: ${staticKey.slice(0, 8)}… (${staticKey.length} hex)`);

    step("Loading WASM decrypt module…");
    const wasmBytes = await loadWasmBytes();
    step(`WASM loaded (${wasmBytes.length} bytes)`);

    const diterB = getDiterB(info);
    step(`diter.b length: ${String(diterB || "").length}`);
    const urls = modelBinzUrls(info);
    const decrypted = {};

    for (const url of urls) {
      const binzName = url.split("/").pop().split("?")[0];
      step(`Downloading ${binzName}…`);
      let enc;
      try {
        enc = await fetchBytes(url);
      } catch (e) {
        if (binzName.includes("wireframe")) {
          step(`Skip ${binzName} (not available)`);
          continue;
        }
        throw new Error(
          `Download ${binzName} failed: ${e && e.message ? e.message : e}`
        );
      }
      step(`Decrypting ${binzName} (${enc.length} bytes)…`);
      let plain;
      try {
        plain = await decryptBinzBytes(wasmBytes, enc, diterB, staticKey);
      } catch (e) {
        throw new Error(
          `Decrypt ${binzName} failed: ${e && e.message ? e.message : e}`
        );
      }
      const outName = outNameFor(binzName);
      decrypted[outName] = plain;
      step(`  → ${outName} (${plain.length} bytes)`);
    }

    if (!decrypted["file.osgjs"] || !decrypted["model_file.bin"]) {
      throw new Error(
        `Missing file.osgjs or model_file.bin after decrypt. Have: ${Object.keys(decrypted).join(", ")}`
      );
    }

    // Animation curves live outside the .binz set; a model without them just
    // exports its rig.
    Object.assign(decrypted, await fetchAnimations(info, step));

    let wantTextures = false;
    let packMode = "full";
    let maxTextureEdge = 0;
    try {
      const prefs = await loadPrefs();
      wantTextures = prefs.textures === true;
      packMode = prefs.packMode === "glb" ? "glb" : "full";
      maxTextureEdge = prefs.maxTextureEdge === 2048 || prefs.maxTextureEdge === 4096
        ? prefs.maxTextureEdge
        : 0;
    } catch (_) {}
    if (options.downloadTextures === true || options.downloadTextures === false) {
      wantTextures = options.downloadTextures === true;
    } else {
      try {
        wantTextures = (await isDownloadTextures()) === true;
      } catch (_) {
        wantTextures = false;
      }
    }
    if (options.packMode === "glb" || options.packMode === "full") {
      packMode = options.packMode;
    }
    if (options.maxTextureEdge === 2048 || options.maxTextureEdge === 4096) {
      maxTextureEdge = options.maxTextureEdge;
    } else if (options.maxTextureEdge === 0) {
      maxTextureEdge = 0;
    }
    step(
      "Settings: textures=" +
        (wantTextures ? "on" : "off") +
        " pack=" +
        packMode +
        (maxTextureEdge ? " maxEdge=" + maxTextureEdge : " maxEdge=original")
    );

    let textures = [];
    if (!wantTextures) {
      step("Textures: skipped (disabled in Settings)");
    } else {
      step("Downloading textures…");
      textures = await fetchTextures(uid, step, {
        maxEdge: maxTextureEdge,
        concurrency: 3,
      });
      const captures = options.capturedTextures || options.captures || [];
      if (captures.length) {
        step(`Merging ${captures.length} viewer-blit texture capture(s)…`);
        textures = mergeCapturedTextures(textures, captures, step);
      } else {
        step(
          "  (No viewer-blit captures — reload the model page AFTER enabling the extension, wait for full load)"
        );
      }
    }
    if (textures.length) {
      textures = await packOrmMaps(viewerMaterials, textures, step, maxTextureEdge);
    }
    for (const t of textures) decrypted[t.name] = t.data;
    if (textures.length) {
      const fromCap = textures.filter((t) => t.fromCapture).length;
      const fromDec = textures.filter((t) => t.fromDescramble).length;
      step(
        `  ${textures.length} texture(s) ready for GLB embed` +
          (fromDec ? ` (${fromDec} descrambled)` : "") +
          (fromCap ? ` (${fromCap} GPU-decoded)` : "")
      );
    } else {
      step("  No public textures found (GLB will be untextured)");
    }

    step("Converting osgjs → glTF (GLB)…");
    let glb;
    let rig = null;
    let gltfExternal = null;
    let geometryCount = 0;
    let textureEmbedCount = 0;
    let skippedGeometries = [];
    try {
      const result = await convertOsgjsToGlbFromFiles(
        decrypted, viewerMaterials, textures, viewerOrientation(info));
      glb = result.glb;
      rig = result.rig || null;
      gltfExternal = result.gltfExternal || null;
      geometryCount = result.geometryCount;
      textureEmbedCount =
        result.textureEmbedCount ||
        (result.json && result.json.images && result.json.images.length) ||
        0;
      step(
        `  GLB ready (${glb.length} bytes, ${geometryCount} mesh(es), ${textureEmbedCount} image(s) embedded)`
      );
      // A dropped mesh used to leave no trace at all, which is how three of
      // them went unnoticed until someone opened the file and saw a hole.
      skippedGeometries = result.skippedGeometries || [];
      for (const s of skippedGeometries) {
        step(`  skipped ${s.name}: ${s.reason}`);
      }
      if (rig && rig.bones) {
        step(
          `  Rig: ${rig.skins} skin(s), ${rig.bones} bone(s) in ${rig.skeletons} skeleton(s)` +
            (rig.animations
              ? `; ${rig.animations} animation(s), ${rig.channels} channel(s)`
              : "; no animation curves")
        );
      }
      // Log material bindings for dev mode
      if (result.json && result.json.materials) {
        for (const m of result.json.materials) {
          const p = m.pbrMetallicRoughness || {};
          const bi = p.baseColorTexture && p.baseColorTexture.index;
          const imgName = (idx) => {
            if (idx == null || !result.json.images || !result.json.textures) return "none";
            const src = result.json.textures[idx] && result.json.textures[idx].source;
            const im = result.json.images[src];
            return (im && im.name) || "none";
          };
          const ni = m.normalTexture && m.normalTexture.index;
          const via = (m.extras && m.extras.via) || "?";
          step(
            `  mat ${m.name}: metal=${p.metallicFactor} rough=${p.roughnessFactor}` +
              ` albedo=${imgName(bi)} normal=${imgName(ni)} via=${via}`
          );
        }
      }
      if (gltfExternal) {
        step(
          wantTextures
            ? "  Also packing model.gltf + model.bin (external textures)"
            : "  Also packing model.gltf + model.bin (mesh only)"
        );
      }
      if (!geometryCount) {
        step("  WARNING: GLB has 0 meshes — convert may be incomplete");
      }
    } catch (e) {
      step(
        `  glTF convert failed: ${e && e.message ? e.message : e}; packaging raw mesh (no .glb)…`
      );
      glb = null;
    }

    const files = [];
    const written = new Set();
    if (glb) {
      files.push({ name: `${name}.glb`, data: glb });
    }
    if (packMode !== "glb") {
      if (gltfExternal) {
        files.push({ name: "model.gltf", data: gltfExternal.jsonText });
        files.push({ name: "model.bin", data: gltfExternal.bin });
        written.add("model.gltf");
        written.add("model.bin");
        if (wantTextures) {
          for (const alias of gltfExternal.textureAliases || []) {
            files.push({ name: alias.to, data: alias.data });
            written.add(alias.to);
          }
        }
      }
      for (const [fname, data] of Object.entries(decrypted)) {
        if (written.has(fname)) continue;
        if (!wantTextures && /^textures\//i.test(fname)) continue;
        files.push({ name: fname, data });
        written.add(fname);
      }
    }

    const missing = wantTextures
      ? textures.filter((t) => !t.fromCapture && !t.fromDescramble)
      : [];
    if (missing.length && packMode !== "glb") {
      const lines = [
        "Textures with no pk-descramble and no viewer-blit (public CDN, often striped):",
        ...missing.map(
          (t) =>
            `  - ${t.originalName || t.name} uid=${t.uid || "?"} ${t.width || "?"}x${t.height || "?"}`
        ),
        "",
        "Maps listed above could not be decoded (no API pk, decode failed).",
        "",
      ];
      files.push({
        name: "MISSING_BLIT.txt",
        data: new TextEncoder().encode(lines.join("\n")),
      });
      step(`  MISSING_BLIT.txt: ${missing.length} map(s) still CDN`);
    }

    files.push({
      name: "README.txt",
      data: new TextEncoder().encode(README_TXT),
    });

    let wantDev = false;
    if (options.devMode === true || options.devMode === false) {
      wantDev = options.devMode === true;
    } else {
      try {
        const { isDevMode } = await import("./devlog.js");
        wantDev = await isDevMode();
      } catch (_) {
        wantDev = false;
      }
    }
    if (wantDev) {
      const logText = logLines.join("\n") + "\n";
      files.push({
        name: "download-log.txt",
        data: new TextEncoder().encode(logText),
      });
      step("  download-log.txt added (developer mode)");
    }

    const format =
      packMode === "glb"
        ? glb
          ? "glb"
          : "osgjs"
        : glb
          ? "glb+gltf+osgjs"
          : "osgjs";
    const infoJson = new TextEncoder().encode(
      JSON.stringify(
        {
          uid,
          name: info.name || name,
          author,
          source_url: pageUrl,
          project: GITHUB_URL,
          format,
          geometry_count: geometryCount,
          skipped_geometries: skippedGeometries,
          textures_downloaded: textures.length,
          textures_skipped: !wantTextures,
          pack_mode: packMode,
          max_texture_edge: maxTextureEdge || "original",
          textures_embedded_in_glb: textureEmbedCount,
          animation_count: (rig && rig.animations) || 0,
          skeleton_count: (rig && rig.skeletons) || 0,
          bone_count: (rig && rig.bones) || 0,
          files: files.map((f) => f.name),
          note: glb
            ? packMode === "glb"
              ? "Open the .glb. See README.txt."
              : "Open .glb (textures packed inside when enabled) or model.gltf. See README.txt."
            : "GLB conversion failed; use file.osgjs + model_file.bin.",
        },
        null,
        2
      )
    );
    files.push({ name: "info.json", data: infoJson });

    if (packMode === "glb") {
      step("Pack mode: GLB only (skipping osgjs / loose maps)");
    }
    step(`Building ZIP (${files.length} entries)…`);
    const zip = await buildZip(files);
    const zipName = wantTextures
      ? `${name}-${uid.slice(0, 8)}-textures.zip`
      : `${name}-${uid.slice(0, 8)}.zip`;
    step(`ZIP ready: ${zipName} (${zip.length} bytes)`);
    return {
      zip,
      zipName,
      name,
      author,
      fileCount: files.length,
      hasGlb: !!glb,
    };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    step(`ERROR: ${message}`);
    throw e instanceof Error ? e : new Error(message);
  }
}
