/**
 * Save binary from a service worker (no URL.createObjectURL / no DOM).
 * Uses chrome.downloads + data: URL built in chunks.
 */

function bytesToBase64(u8) {
  const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  // keep chunks small — Function.apply argument limit varies by engine
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

/**
 * @param {Uint8Array|ArrayBuffer} zipBytes
 * @param {string} filename
 * @returns {Promise<number>} download id
 */
export async function saveZipInServiceWorker(zipBytes, filename) {
  const bytes =
    zipBytes instanceof Uint8Array
      ? zipBytes
      : new Uint8Array(zipBytes);

  if (!bytes.length) {
    throw new Error("ZIP is empty — nothing to save");
  }

  // ~ chrome data-URL practical limit is large but memory-bound; guard huge files
  if (bytes.length > 90 * 1024 * 1024) {
    throw new Error(
      `ZIP too large for SW data-URL save (${bytes.length} bytes). Try a smaller model.`
    );
  }

  const b64 = bytesToBase64(bytes);
  const dataUrl = `data:application/zip;base64,${b64}`;
  const name = filename || "sketchfab-model.zip";

  const id = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: name,
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (downloadId === undefined || downloadId === null) {
          reject(new Error("chrome.downloads.download returned no id"));
          return;
        }
        resolve(downloadId);
      }
    );
  });

  return id;
}
