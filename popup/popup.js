import {
  getLang,
  setLang,
  t,
  createLangSwitch,
  updateLangSwitch,
} from "../lib/i18n.js";
import { downloadModelInBackground } from "../lib/run-download.js";
import { saveZip } from "../lib/save.js";
import { readLastRunLog, setDevModeCache } from "../lib/devlog.js";
import {
  loadPrefs,
  savePrefs,
  applyTheme,
  jobFlagsFromPrefs,
} from "../lib/settings.js";
import {
  isJobDirty,
  paintSettingsFlash as paintFlash,
  formatJobStatus,
  bindThemeSwitch,
  bindPillSwitch,
} from "../lib/ui-settings.js";
import { progressFromMessage, saveTextFile } from "../lib/ui-progress.js";

const meta = document.getElementById("meta");
const statusEl = document.getElementById("status");
const btnDl = document.getElementById("btn-dl");
const btnBulk = document.getElementById("btn-bulk");
const titleEl = document.getElementById("title");
const taglineEl = document.getElementById("tagline");
const hintEl = document.getElementById("hint");
const ghLink = document.getElementById("gh-link");
const langHost = document.getElementById("lang-switch");
const devToggle = document.getElementById("dev-toggle");
const devLabel = document.getElementById("dev-label");
const devPanel = document.getElementById("dev-panel");
const devLogEl = document.getElementById("dev-log");
const devLogTitle = document.getElementById("dev-log-title");
const btnCopyLog = document.getElementById("btn-copy-log");
const btnSaveLog = document.getElementById("btn-save-log");
const btnClearLog = document.getElementById("btn-clear-log");
const readyEl = document.getElementById("ready");
const progressWrap = document.getElementById("progress");
const progressBar = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const tabDl = document.getElementById("tab-dl");
const tabSet = document.getElementById("tab-set");
const paneDl = document.getElementById("pane-dl");
const paneSet = document.getElementById("pane-set");
const texToggle = document.getElementById("tex-toggle");
const texLabel = document.getElementById("tex-label");
const texHint = document.getElementById("tex-hint");
const devHint = document.getElementById("dev-hint");
const settingsTitle = document.getElementById("settings-title");
const ghLinkSettings = document.getElementById("gh-link-settings");
const themeSwitch = document.getElementById("theme-switch");
const themeLabel = document.getElementById("theme-label");
const langLabel = document.getElementById("lang-label");
const btnSaveSettings = document.getElementById("btn-save-settings");
const settingsSaveHint = document.getElementById("settings-save-hint");
const settingsFlash = document.getElementById("settings-flash");
const jobStatusEl = document.getElementById("job-status");
const packSwitch = document.getElementById("pack-switch");
const packLabel = document.getElementById("pack-label");
const packHint = document.getElementById("pack-hint");
const resSwitch = document.getElementById("res-switch");
const resLabel = document.getElementById("res-label");
const resHint = document.getElementById("res-hint");

let lang = "en";
let switching = false;
let applied = {
  textures: false,
  theme: "light",
  lang: "en",
  devMode: false,
  packMode: "full",
  maxTextureEdge: 0,
};
let pendingTex = false;
let pendingDev = false;
let appliedOk = false;
let paintTheme = () => {};
let paintPack = () => {};
let paintRes = () => {};
let liveLog = [];
let currentTab = "dl";
let devMode = false;

function setStatus(msg, cls) {
  statusEl.textContent = msg || "";
  statusEl.className = cls || "";
  const pct = progressFromMessage(msg);
  if (pct != null) setProgress(pct);
}

function setProgress(pct) {
  const n = Math.max(0, Math.min(100, pct | 0));
  progressWrap.classList.add("show");
  progressBar.style.width = n + "%";
  progressLabel.textContent = n + "%";
}

function hideProgress() {
  progressWrap.classList.remove("show");
  progressBar.style.width = "0%";
  progressLabel.textContent = "0%";
}

function renderDevPanel() {
  document.body.classList.toggle("dev", devMode);
  devLabel.textContent = t(lang, "devMode");
  devLogTitle.textContent = t(lang, "devLogTitle");
  btnCopyLog.textContent = t(lang, "copyLog");
  if (btnSaveLog) btnSaveLog.textContent = t(lang, "saveLog");
  btnClearLog.textContent = t(lang, "clearLog");
  devPanel.classList.toggle("show", devMode);
  if (hintEl) hintEl.style.display = devMode ? "" : "none";
  if (devMode) {
    devLogEl.textContent = liveLog.join("\n") || "—";
    devLogEl.scrollTop = devLogEl.scrollHeight;
  }
}

async function copyLogToClipboard() {
  const text = devLogEl.textContent || liveLog.join("\n") || "";
  try {
    await navigator.clipboard.writeText(text);
    setStatus(t(lang, "logCopied"), "ok");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    setStatus(t(lang, "logCopied"), "ok");
  }
}

function appendLiveLog(line) {
  liveLog.push(line);
  if (liveLog.length > 400) liveLog = liveLog.slice(-400);
  if (devMode) {
    devLogEl.textContent = liveLog.join("\n");
    devLogEl.scrollTop = devLogEl.scrollHeight;
  }
}

function showTab(name) {
  currentTab = name === "set" ? "set" : "dl";
  const onSet = currentTab === "set";
  tabDl.classList.toggle("active", !onSet);
  tabSet.classList.toggle("active", onSet);
  tabDl.setAttribute("aria-selected", onSet ? "false" : "true");
  tabSet.setAttribute("aria-selected", onSet ? "true" : "false");
  paneDl.classList.toggle("active", !onSet);
  paneSet.classList.toggle("active", onSet);
}

function applyStaticI18n() {
  document.documentElement.lang = lang;
  titleEl.textContent = t(lang, "appName");
  taglineEl.innerHTML = `<span class="dot">●</span> ${t(lang, "tagline")}`;
  btnDl.textContent = t(lang, "btnDownload");
  btnBulk.textContent = t(lang, "btnBulk");
  hintEl.textContent = t(lang, "popupHint");
  ghLink.textContent = t(lang, "github");
  if (tabDl) tabDl.textContent = t(lang, "tabDownload");
  if (tabSet) tabSet.textContent = t(lang, "tabSettings");
  if (settingsTitle) settingsTitle.textContent = t(lang, "settingsTitle");
  if (texLabel) texLabel.textContent = t(lang, "optTextures");
  if (texHint) texHint.textContent = t(lang, "optTexturesHint");
  if (devHint) devHint.textContent = t(lang, "optDevHint");
  if (ghLinkSettings) ghLinkSettings.textContent = t(lang, "githubRepo");
  if (readyEl) readyEl.textContent = t(lang, "readyDownload");
  if (themeLabel) themeLabel.textContent = t(lang, "optTheme");
  if (langLabel) langLabel.textContent = t(lang, "language");
  if (btnSaveSettings) btnSaveSettings.textContent = t(lang, "saveSettings");
  if (settingsSaveHint) settingsSaveHint.textContent = t(lang, "settingsSaveHint");
  if (packLabel) packLabel.textContent = t(lang, "optPack");
  if (packHint) packHint.textContent = t(lang, "packHint");
  if (resLabel) resLabel.textContent = t(lang, "optTexSize");
  if (resHint) resHint.textContent = t(lang, "texSizeHint");
  if (jobStatusEl) {
    jobStatusEl.textContent = formatJobStatus(applied, t, lang);
  }
  updateLangSwitch(langHost, lang);
  applyTheme(document.documentElement, applied.theme);
  applyTheme(document.body, applied.theme);
  paintTheme = bindThemeSwitch(themeSwitch, {
    getTheme: () => applied.theme,
    onPick: (code) => persistInstant({ theme: code }),
    t,
    lang,
  });
  paintPack = bindPillSwitch(packSwitch, {
    items: [
      { code: "full", label: t(lang, "packFull") },
      { code: "glb", label: t(lang, "packGlb") },
    ],
    get: () => applied.packMode,
    onPick: (code) => persistInstant({ packMode: code }),
  });
  paintRes = bindPillSwitch(resSwitch, {
    items: [
      { code: "0", label: t(lang, "texSizeOrig") },
      { code: "2048", label: t(lang, "texSize2k") },
      { code: "4096", label: t(lang, "texSize4k") },
    ],
    get: () => String(applied.maxTextureEdge || 0),
    onPick: (code) => persistInstant({ maxTextureEdge: Number(code) || 0 }),
  });
  renderDevPanel();
  paintSettingsFlash();
}

function paintSettingsFlash() {
  paintFlash(settingsFlash, {
    dirty: isJobDirty(
      { textures: pendingTex, devMode: pendingDev },
      applied
    ),
    appliedOk,
    t,
    lang,
  });
}

async function persistInstant(partial) {
  const next = await savePrefs(partial);
  applied = next;
  lang = next.lang;
  devMode = next.devMode === true;
  applyTheme(document.documentElement, next.theme);
  applyTheme(document.body, next.theme);
  applyStaticI18n();
  return next;
}

async function applyJobPrefs() {
  const next = await savePrefs({
    textures: pendingTex,
    devMode: pendingDev,
  });
  applied = next;
  pendingTex = next.textures === true;
  pendingDev = next.devMode === true;
  devMode = next.devMode === true;
  setDevModeCache(devMode);
  if (texToggle) texToggle.checked = pendingTex;
  if (devToggle) devToggle.checked = pendingDev;
  appliedOk = true;
  applyStaticI18n();
  return next;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isSketchfabModelUrl(url) {
  return /sketchfab\.com\/(?:3d-models\/[^/?#]+-|models\/)[a-f0-9]{32}/i.test(
    url || ""
  );
}

async function refresh() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    meta.textContent = t(lang, "noActiveTab");
    readyEl.textContent = t(lang, "noActiveTab");
    btnDl.disabled = true;
    return;
  }

  if (!isSketchfabModelUrl(tab.url)) {
    meta.innerHTML = t(lang, "openModelOrBulk");
    readyEl.textContent = t(lang, "openModelOrBulk").replace(/<[^>]+>/g, "");
    btnDl.disabled = true;
    setStatus("");
    return;
  }

  meta.textContent = tab.url;
  readyEl.textContent = t(lang, "readyDownload");
  btnDl.disabled = false;
  setStatus(t(lang, "readyDownload"));

  try {
    const ping = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: "ping" }),
      new Promise((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
    if (ping && ping.uid) {
      meta.textContent = `${t(lang, "uidLabel")}: ${ping.uid}\n${tab.url}`;
      if (ping.busy) {
        readyEl.textContent = t(lang, "downloadRunning");
        setStatus(t(lang, "downloadRunning"), "warn");
      }
    }
  } catch (_) {
    if (devMode) setStatus(t(lang, "modelDetected"), "ok");
  }
}

btnDl.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.url || !isSketchfabModelUrl(tab.url)) return;
  btnDl.disabled = true;
  liveLog = [];
  appendLiveLog(`start ${new Date().toISOString()} url=${tab.url}`);
  setProgress(4);
  readyEl.textContent = t(lang, "downloading");
  setStatus(t(lang, "working"));

  try {
    chrome.tabs.sendMessage(tab.id, { action: "openPanel" }).catch(() => {});
  } catch (_) {}

  try {
    const saved = await loadPrefs();
    applied = saved;
    pendingTex = !!(texToggle && texToggle.checked);
    pendingDev = !!(devToggle && devToggle.checked);
    if (isJobDirty({ textures: pendingTex, devMode: pendingDev }, saved)) {
      setStatus(t(lang, "settingsDirty"), "warn");
    }
    const flags = jobFlagsFromPrefs(saved);
    appendLiveLog("settings textures=" + (flags.downloadTextures ? "on" : "off"));
    // Prefer page pipeline: content script dumps WebGL-captured textures first
    let pageResult = null;
    try {
      pageResult = await Promise.race([
        chrome.tabs.sendMessage(tab.id, {
          action: "downloadCurrent",
          downloadTextures: flags.downloadTextures,
          devMode: flags.devMode,
          packMode: flags.packMode,
          maxTextureEdge: flags.maxTextureEdge,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("page timeout")), 15 * 60 * 1000)
        ),
      ]);
    } catch (pageErr) {
      appendLiveLog(
        `page download unavailable: ${
          pageErr && pageErr.message ? pageErr.message : pageErr
        }`
      );
      pageResult = null;
    }

    if (pageResult && pageResult.ok) {
      setProgress(100);
      readyEl.textContent = t(lang, "downloadOk");
      setStatus(
        `✅ ${pageResult.name || ""}\n${pageResult.zipName || ""}`,
        "ok"
      );
      appendLiveLog(
        `done via page (WebGL capture) ${pageResult.zipName || ""}`
      );
      return;
    }
    if (pageResult && pageResult.error) {
      appendLiveLog(`page error: ${pageResult.error}`);
      // fall through to popup-side download without captures
      setStatus(t(lang, "pageBusy"));
    }

    const result = await downloadModelInBackground(
      tab.url,
      (m) => {
        setStatus(m);
        if (devMode) appendLiveLog(m);
      },
      {
        devMode: flags.devMode,
        downloadTextures: flags.downloadTextures,
        packMode: flags.packMode,
        maxTextureEdge: flags.maxTextureEdge,
        onLog: (entry) => {
          if (!entry) return;
          appendLiveLog(
            `[${entry.level || "info"}] ${entry.msg}${
              entry.data ? " " + JSON.stringify(entry.data) : ""
            }`
          );
        },
      }
    );

    if (!result.savedByBackground && result.zip) {
      appendLiveLog("client-side save fallback");
      await saveZip(result.zip, result.zipName);
    }

    if (result.logText) {
      liveLog = result.logText.split("\n");
      renderDevPanel();
    }

    setProgress(100);
    readyEl.textContent = t(lang, "downloadOk");
    setStatus(
      `✅ ${result.name}\n${result.zipName}${
        result.zipBytes ? ` (${result.zipBytes} B)` : ""
      }`,
      "ok"
    );
    appendLiveLog(`done ${result.zipName} bytes=${result.zipBytes || "?"}`);
  } catch (e) {
    let msg = e.message || String(e);
    if (/context invalidated/i.test(msg)) {
      msg = t(lang, "errContextInvalid");
    }
    readyEl.textContent = msg;
    setStatus(`❌ ${msg}`, "warn");
    appendLiveLog(`ERROR ${msg}`);
    if (e.logText) {
      liveLog = String(e.logText).split("\n");
      renderDevPanel();
    }
  } finally {
    btnDl.disabled = false;
  }
});

btnBulk.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openBulkPage" });
});

tabDl.addEventListener("click", () => showTab("dl"));
tabSet.addEventListener("click", () => showTab("set"));

if (btnSaveSettings) {
  btnSaveSettings.addEventListener("click", async () => {
    try {
      const next = await applyJobPrefs();
      setStatus(t(lang, "settingsSaved"), "ok");
      paintSettingsFlash();
      appendLiveLog(
        "applied settings textures=" +
          (next.textures ? "on" : "off") +
          " dev=" +
          (next.devMode ? "on" : "off") +
          " theme=" +
          next.theme
      );
    } catch (e) {
      appliedOk = false;
      setStatus("Apply failed: " + (e && e.message ? e.message : e), "warn");
      if (settingsFlash) {
        settingsFlash.hidden = false;
        settingsFlash.className = "settings-flash show dirty";
        settingsFlash.textContent =
          "Apply failed: " + (e && e.message ? e.message : e);
      }
    }
  });
}

if (texToggle) {
  texToggle.addEventListener("change", () => {
    pendingTex = !!texToggle.checked;
    appliedOk = false;
    paintSettingsFlash();
  });
}
if (devToggle) {
  devToggle.addEventListener("change", () => {
    pendingDev = !!devToggle.checked;
    appliedOk = false;
    paintSettingsFlash();
  });
}

btnCopyLog.addEventListener("click", () => copyLogToClipboard());
if (btnSaveLog) {
  btnSaveLog.addEventListener("click", () => {
    saveTextFile(
      `sf-dl-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`,
      liveLog.join("\n") || ""
    );
    setStatus(t(lang, "logSaved"), "ok");
  });
}

btnClearLog.addEventListener("click", () => {
  liveLog = [];
  renderDevPanel();
});

async function init() {
  const prefs = await loadPrefs();
  applied = prefs;
  lang = prefs.lang;
  pendingTex = prefs.textures === true;
  pendingDev = prefs.devMode === true;
  devMode = prefs.devMode === true;
  applyTheme(document.documentElement, prefs.theme);
  applyTheme(document.body, prefs.theme);
  setDevModeCache(devMode);
  if (texToggle) {
    texToggle.checked = pendingTex;
    texToggle.disabled = false;
  }
  if (devToggle) devToggle.checked = pendingDev;

  if (devMode) {
    const last = await readLastRunLog();
    if (last.text) {
      liveLog = last.text.split("\n");
    }
  }

  langHost.appendChild(
    createLangSwitch(lang, async (code) => {
      if (switching) return;
      switching = true;
      try {
        await persistInstant({ lang: code === "ru" ? "ru" : "en" });
        await setLang(applied.lang);
      } finally {
        switching = false;
      }
    })
  );
  applyStaticI18n();
  await refresh();
}

init();
