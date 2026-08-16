/**
 * Hidden extension page: decrypt, descramble, zip.
 * Service workers are killed on 4K texture packs (40+ maps × 64 MB RGBA).
 */
import { downloadModel } from "../lib/pipeline.js";

function emit(msg) {
  try {
    chrome.runtime.sendMessage({ source: "sf-offscreen", ...msg });
  } catch (_) {}
}

/**
 * Offscreen documents only get chrome.runtime — chrome.downloads is undefined
 * here, so lib/save.js silently fell back to clicking an <a download> in a
 * hidden, gesture-less document, which never saves anything.
 *
 * Build the blob URL here (we have a DOM) and let the service worker, which
 * does have chrome.downloads, perform the save. The URL is same-origin, so
 * only a short string crosses the message boundary.
 *
 * @param {Uint8Array} zip
 * @param {string} filename
 * @returns {Promise<number>} download id
 */
async function saveViaServiceWorker(zip, filename) {
  const blob = new Blob([zip], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  let res;
  try {
    res = await chrome.runtime.sendMessage({ action: "saveZip", url, filename });
  } catch (e) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
    throw e;
  }
  if (!res || !res.ok) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
    throw new Error((res && res.error) || "Service worker could not save the ZIP");
  }
  // Keep the blob alive until the Save As dialog is answered and the write starts.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }, 120_000);
  return res.downloadId;
}

async function runDownload(payload) {
  const url = payload.url;
  const captures = Array.isArray(payload.capturedTextures)
    ? payload.capturedTextures
    : [];
  const result = await downloadModel(
    url,
    (text) => emit({ type: "progress", text: String(text || "") }),
    {
      capturedTextures: captures,
      ...(payload.downloadTextures === true || payload.downloadTextures === false
        ? { downloadTextures: payload.downloadTextures === true }
        : {}),
      ...(payload.devMode === true || payload.devMode === false
        ? { devMode: payload.devMode === true }
        : {}),
      ...(payload.packMode === "glb" || payload.packMode === "full"
        ? { packMode: payload.packMode }
        : {}),
      ...(payload.maxTextureEdge === 0 ||
      payload.maxTextureEdge === 2048 ||
      payload.maxTextureEdge === 4096
        ? { maxTextureEdge: payload.maxTextureEdge }
        : {}),
    }
  );
  const zip =
    result.zip instanceof Uint8Array
      ? result.zip
      : new Uint8Array(result.zip || []);
  if (!zip.length) throw new Error("Pipeline returned empty ZIP");
  emit({
    type: "progress",
    text: `Saving ${result.zipName} (${zip.length} bytes)…`,
  });
  const downloadId = await saveViaServiceWorker(zip, result.zipName);
  return {
    zipName: result.zipName,
    name: result.name,
    author: result.author,
    hasGlb: !!result.hasGlb,
    fileCount: result.fileCount || 0,
    zipBytes: zip.length,
    downloadId,
    saved: true,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.action !== "download") {
    return false;
  }
  runDownload(msg)
    .then((done) => sendResponse({ ok: true, ...done }))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: e && e.message ? e.message : String(e),
        stack: e && e.stack ? e.stack : "",
      })
    );
  return true;
});
