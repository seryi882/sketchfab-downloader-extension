/**
 * Run the download pipeline in the extension service worker.
 * ZIP is saved by the service worker (avoids broken ArrayBuffer port transfers).
 */

/**
 * Coerce any structured-clone payload into Uint8Array (fallback path).
 * @param {any} data
 * @returns {Uint8Array|null}
 */
export function coerceToUint8Array(data) {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    try {
      const bin = atob(data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) {
    return Uint8Array.from(data);
  }
  // Cross-realm ArrayBuffer / typed array sometimes lose instanceof
  if (typeof data === "object") {
    if (typeof data.byteLength === "number" && typeof data.slice === "function") {
      try {
        return new Uint8Array(data);
      } catch (_) {}
    }
    if (typeof data.length === "number" && data.length > 0 && typeof data[0] === "number") {
      try {
        return Uint8Array.from(data);
      } catch (_) {}
    }
  }
  return null;
}

/**
 * @param {string} url
 * @param {(msg: string) => void} [onProgress]
 * @param {{ onLog?: (entry: {level:string,msg:string,data?:any}) => void, devMode?: boolean }} [opts]
 * @returns {Promise<{zipName: string, name: string, author: string, hasGlb: boolean, fileCount: number, zipBytes: number, downloadId?: number, logText?: string, zip?: Uint8Array}>}
 */
export function downloadModelInBackground(url, onProgress = () => {}, opts = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        reject(new Error("Extension context invalidated."));
        return;
      }
      port = chrome.runtime.connect({ name: "sf-pipeline" });
    } catch (e) {
      reject(new Error(e && e.message ? e.message : String(e)));
      return;
    }

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch (_) {}
      fn();
    };

    port.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;

      if (msg.type === "progress") {
        try {
          onProgress(msg.text || "");
        } catch (_) {}
        return;
      }

      if (msg.type === "log") {
        try {
          if (opts.onLog) opts.onLog(msg.entry || { level: "info", msg: msg.text });
        } catch (_) {}
        // Also mirror into progress line when dev
        if (opts.devMode && msg.entry?.msg) {
          try {
            onProgress(`[dev] ${msg.entry.msg}`);
          } catch (_) {}
        }
        return;
      }

      if (msg.type === "done") {
        // Preferred: SW already saved the file
        if (msg.saved) {
          finish(() =>
            resolve({
              zipName: msg.zipName,
              name: msg.name,
              author: msg.author,
              hasGlb: !!msg.hasGlb,
              fileCount: msg.fileCount || 0,
              zipBytes: msg.zipBytes || 0,
              downloadId: msg.downloadId,
              logText: msg.logText || "",
              savedByBackground: true,
            })
          );
          return;
        }

        // Fallback: binary still in message
        const zip = coerceToUint8Array(msg.zip);
        if (!zip || !zip.length) {
          const detail = msg.zipType || typeof msg.zip;
          finish(() =>
            reject(
              new Error(
                `Invalid ZIP payload from background (type=${detail}, keys=${
                  msg.zip && typeof msg.zip === "object"
                    ? Object.keys(msg.zip).slice(0, 8).join(",")
                    : "-"
                }). ${msg.logText ? "See dev log." : "Enable Dev mode for details."}`
              )
            )
          );
          return;
        }
        finish(() =>
          resolve({
            zip,
            zipName: msg.zipName,
            name: msg.name,
            author: msg.author,
            hasGlb: !!msg.hasGlb,
            fileCount: msg.fileCount || 0,
            zipBytes: zip.length,
            logText: msg.logText || "",
            savedByBackground: false,
          })
        );
        return;
      }

      if (msg.type === "error") {
        finish(() => {
          const err = new Error(msg.error || "Download failed");
          err.logText = msg.logText || "";
          reject(err);
        });
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      let errMsg =
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        "Background worker disconnected (service worker crashed or was killed)";
      if (/context invalidated/i.test(errMsg)) {
        errMsg =
          "Extension context invalidated. Refresh the model page after reloading the extension (large models also need the offscreen worker).";
      }
      settled = true;
      reject(new Error(errMsg));
    });

    const msg = {
      action: "download",
      url,
      devMode: !!opts.devMode,
      capturedTextures: opts.capturedTextures || opts.captures || [],
    };
    if (opts.downloadTextures === true || opts.downloadTextures === false) {
      msg.downloadTextures = opts.downloadTextures === true;
    }
    if (opts.packMode === "glb" || opts.packMode === "full") {
      msg.packMode = opts.packMode;
    }
    if (opts.maxTextureEdge === 0 || opts.maxTextureEdge === 2048 || opts.maxTextureEdge === 4096) {
      msg.maxTextureEdge = opts.maxTextureEdge;
    }
    port.postMessage(msg);
  });
}
