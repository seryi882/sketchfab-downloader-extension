/**
 * Hidden extension page: decrypt, descramble, zip.
 * Service workers are killed on 4K texture packs (40+ maps × 64 MB RGBA).
 */
import { downloadModel } from "../lib/pipeline.js";
import { saveZip } from "../lib/save.js";

function emit(msg) {
  try {
    chrome.runtime.sendMessage({ source: "sf-offscreen", ...msg });
  } catch (_) {}
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
  await saveZip(zip, result.zipName);
  return {
    zipName: result.zipName,
    name: result.name,
    author: result.author,
    hasGlb: !!result.hasGlb,
    fileCount: result.fileCount || 0,
    zipBytes: zip.length,
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
