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
  prefsFromUi,
  applyTheme,
} from "../lib/settings.js";
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

let lang = "en";
let switching = false;
let devMode = false;
let downloadTextures = false;
let theme = "light";
let pendingTheme = "light";
let pendingLang = "en";
let appliedOk = false;
let liveLog = [];
let currentTab = "dl";

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
  renderThemeSwitch();
  updateLangSwitch(langHost, pendingLang);
  applyTheme(document.documentElement, theme);
  applyTheme(document.body, theme);
  renderDevPanel();
  paintSettingsFlash();
}

function collectPendingPrefs() {
  return prefsFromUi({
    texToggle,
    devToggle,
    theme: pendingTheme,
    lang: pendingLang,
  });
}

function isDirty() {
  const p = collectPendingPrefs();
  return (
    p.textures !== downloadTextures ||
    p.devMode !== devMode ||
    p.theme !== theme ||
    p.lang !== lang
  );
}

function paintSettingsFlash() {
  if (!settingsFlash) return;
  if (isDirty()) {
    settingsFlash.hidden = false;
    settingsFlash.className = "settings-flash show dirty";
    settingsFlash.textContent = t(lang, "settingsDirty");
    return;
  }
  if (appliedOk) {
    settingsFlash.hidden = false;
    settingsFlash.className = "settings-flash show ok";
    settingsFlash.textContent = t(lang, "settingsSaved");
    return;
  }
  settingsFlash.hidden = true;
  settingsFlash.className = "settings-flash";
  settingsFlash.textContent = "";
}

async function applyPendingPrefs() {
  const snap = collectPendingPrefs();
  const next = await savePrefs(snap);
  try {
    await setLang(next.lang);
  } catch (_) {}
  downloadTextures = next.textures === true;
  theme = next.theme;
  lang = next.lang;
  pendingTheme = next.theme;
  pendingLang = next.lang;
  devMode = next.devMode === true;
  setDevModeCache(devMode);
  if (texToggle) texToggle.checked = next.textures === true;
  if (devToggle) devToggle.checked = next.devMode === true;
  applyTheme(document.documentElement, theme);
  applyTheme(document.body, theme);
  appliedOk = true;
  applyStaticI18n();
  return next;
}

function renderThemeSwitch() {
  if (!themeSwitch) return;
  themeSwitch.innerHTML = "";
  themeSwitch.className = "sf-lang";
  for (const code of ["light", "dark"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sf-lang-btn" + (pendingTheme === code ? " active" : "");
    btn.textContent = t(lang, code === "light" ? "themeLight" : "themeDark");
    btn.addEventListener("click", () => {
      pendingTheme = code;
      renderThemeSwitch();
      paintSettingsFlash();
    });
    themeSwitch.appendChild(btn);
  }
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
    if (isDirty()) {
      setStatus(t(lang, "settingsDirty"), "warn");
    }
    appendLiveLog("settings textures=" + (saved.textures ? "on" : "off"));
    // Prefer page pipeline: content script dumps WebGL-captured textures first
    let pageResult = null;
    try {
      pageResult = await Promise.race([
        chrome.tabs.sendMessage(tab.id, {
          action: "downloadCurrent",
          downloadTextures: saved.textures === true,
          devMode: saved.devMode === true,
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
        devMode: saved.devMode === true,
        downloadTextures: saved.textures === true,
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
      const next = await applyPendingPrefs();
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
    appliedOk = false;
    paintSettingsFlash();
  });
}
if (devToggle) {
  devToggle.addEventListener("change", () => {
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
  lang = prefs.lang;
  pendingLang = prefs.lang;
  devMode = prefs.devMode === true;
  downloadTextures = prefs.textures === true;
  theme = prefs.theme;
  pendingTheme = prefs.theme;
  applyTheme(document.documentElement, theme);
  applyTheme(document.body, theme);
  setDevModeCache(devMode);
  if (texToggle) {
    texToggle.checked = prefs.textures === true;
    texToggle.disabled = false;
  }
  if (devToggle) devToggle.checked = prefs.devMode === true;

  // Show last run log if any (dev mode)
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
        pendingLang = code === "ru" ? "ru" : "en";
        updateLangSwitch(langHost, pendingLang);
        paintSettingsFlash();
      } finally {
        switching = false;
      }
    })
  );
  applyStaticI18n();
  await refresh();
}

init();
