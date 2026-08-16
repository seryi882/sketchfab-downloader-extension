/**
 * Thin service worker:
 * - Relays panel ↔ offscreen (heavy decrypt / descramble / ZIP)
 * - Keeps itself alive while a job runs
 * 4K texture packs OOM the SW; the offscreen page has a real heap.
 */
import {
  clearSessionLog,
  devLog,
  formatSessionLog,
  isDevMode,
  persistLastRunLog,
  setDevModeCache,
} from "./lib/devlog.js";

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch (e) {
    console.warn("[sf-dl] port.postMessage failed", e);
  }
}

let panelPort = null;
let keepTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  keepTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch (_) {}
  }, 15000);
}

function stopKeepAlive() {
  if (keepTimer) {
    clearInterval(keepTimer);
    keepTimer = null;
  }
}

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing && existing.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["BLOBS"],
      justification:
        "Decrypt model binaries and descramble textures (too large for the service worker)",
    });
  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    if (/already exists|duplicate/i.test(m)) return;
    throw e;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sf-pipeline") return;

  let running = false;
  panelPort = port;
  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.action !== "download") return;
    if (running) {
      post(port, { type: "error", error: "Already downloading in background" });
      return;
    }
    running = true;
    startKeepAlive();
    const url = msg.url;
    const captures = Array.isArray(msg.capturedTextures)
      ? msg.capturedTextures
      : [];
    const wantDev =
      msg.devMode === true || msg.devMode === false
        ? !!msg.devMode
        : await isDevMode();
    setDevModeCache(wantDev);
    clearSessionLog();

    const emitProgress = (text) => {
      post(port, { type: "progress", text: String(text || "") });
      if (wantDev) {
        devLog("info", String(text || ""));
        post(port, {
          type: "log",
          entry: { level: "info", msg: String(text || ""), t: Date.now() },
        });
      }
    };

    try {
      devLog("info", "Pipeline start", {
        url,
        devMode: wantDev,
        captures: captures.length,
      });
      emitProgress("Background: starting…");
      emitProgress("Opening offscreen worker (needed for 2K/4K texture packs)…");
      await ensureOffscreen();

      const payload = {
        target: "offscreen",
        action: "download",
        url,
        capturedTextures: captures,
        devMode: wantDev,
      };
      if (msg.downloadTextures === true || msg.downloadTextures === false) {
        payload.downloadTextures = msg.downloadTextures === true;
      }
      if (msg.packMode === "glb" || msg.packMode === "full") {
        payload.packMode = msg.packMode;
      }
      if (
        msg.maxTextureEdge === 0 ||
        msg.maxTextureEdge === 2048 ||
        msg.maxTextureEdge === 4096
      ) {
        payload.maxTextureEdge = msg.maxTextureEdge;
      }
      let result;
      for (let attempt = 0; attempt < 8; attempt++) {
        result = await new Promise((resolve) => {
          chrome.runtime.sendMessage(payload, (res) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({ ok: false, retry: true, error: err.message });
              return;
            }
            resolve(res || { ok: false, error: "Offscreen download failed" });
          });
        });
        if (result && result.ok) break;
        if (!result || !result.retry || attempt === 7) {
          throw new Error((result && result.error) || "Offscreen download failed");
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      await persistLastRunLog();
      post(port, {
        type: "done",
        saved: true,
        downloadId: result.downloadId,
        zipBytes: result.zipBytes || 0,
        zipName: result.zipName,
        name: result.name,
        author: result.author,
        hasGlb: !!result.hasGlb,
        fileCount: result.fileCount || 0,
        logText: wantDev ? formatSessionLog() : "",
      });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const stack = e && e.stack ? e.stack : "";
      devLog("error", "Pipeline failed", { message, stack });
      await persistLastRunLog();
      post(port, {
        type: "error",
        error: message,
        stack: wantDev ? stack : undefined,
        logText: wantDev ? formatSessionLog() : "",
      });
    } finally {
      running = false;
      stopKeepAlive();
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.action) {
    if (msg && msg.source === "sf-offscreen" && panelPort) {
      if (msg.type === "progress") {
        post(panelPort, { type: "progress", text: msg.text || "" });
        devLog("info", String(msg.text || ""));
        post(panelPort, {
          type: "log",
          entry: { level: "info", msg: String(msg.text || ""), t: Date.now() },
        });
      }
    }
    return false;
  }

  if (msg.action === "openBulkPage") {
    const url = chrome.runtime.getURL("bulk/bulk.html");
    chrome.tabs.create({ url }).then(
      (tab) => sendResponse({ ok: true, tabId: tab.id }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  // The offscreen document builds the ZIP blob but has no chrome.downloads,
  // so it hands the blob URL here for the actual save.
  if (msg.action === "saveZip") {
    chrome.downloads.download(
      {
        url: msg.url,
        filename: msg.filename || "sketchfab-model.zip",
        saveAs: true,
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err || downloadId === undefined || downloadId === null) {
          const message = (err && err.message) || "chrome.downloads.download returned no id";
          devLog("error", "Save failed", { message });
          sendResponse({ ok: false, error: message });
          return;
        }
        devLog("info", "Save started", { downloadId, filename: msg.filename });
        sendResponse({ ok: true, downloadId });
      }
    );
    return true;
  }

  if (msg.action === "getDevMode") {
    isDevMode().then((on) => sendResponse({ ok: true, devMode: on }));
    return true;
  }

  if (msg.action === "setDevMode") {
    import("./lib/devlog.js").then(async ({ setDevMode }) => {
      const on = await setDevMode(!!msg.on);
      sendResponse({ ok: true, devMode: on });
    });
    return true;
  }

  if (msg.action === "getLastLog") {
    import("./lib/devlog.js").then(async ({ readLastRunLog }) => {
      const last = await readLastRunLog();
      sendResponse({ ok: true, ...last });
    });
    return true;
  }

  return false;
});
