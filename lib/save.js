/**
 * Trigger a file download from an extension page or content script.
 * (Not for service workers — they have no URL.createObjectURL / DOM.)
 */
export async function saveZip(zipBytes, filename) {
  const bytes =
    zipBytes instanceof Uint8Array
      ? zipBytes
      : zipBytes instanceof ArrayBuffer
        ? new Uint8Array(zipBytes)
        : new Uint8Array(zipBytes || []);

  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const name = filename || "sketchfab-model.zip";

  // Prefer chrome.downloads when available (popup / bulk page)
  if (
    typeof chrome !== "undefined" &&
    chrome.downloads &&
    chrome.downloads.download
  ) {
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url, filename: name, saveAs: true },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      return;
    } catch (_) {
      // fall through to anchor
    }
  }

  // Content script / pages without downloads permission path
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
