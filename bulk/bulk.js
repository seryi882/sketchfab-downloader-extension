import { extractUid } from "../lib/sf-api.js";
import { downloadModelInBackground } from "../lib/run-download.js";
import { saveZip } from "../lib/save.js";
import {
  getLang,
  setLang,
  t,
  createLangSwitch,
  updateLangSwitch,
} from "../lib/i18n.js";
import { isDevMode } from "../lib/devlog.js";
import { getTheme, applyTheme, loadPrefs } from "../lib/settings.js";

const linksEl = document.getElementById("links");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const summaryEl = document.getElementById("summary");
const logEl = document.getElementById("log");
const titleEl = document.getElementById("title");
const subEl = document.getElementById("sub");
const labelEl = document.getElementById("label-links");
const queueTitle = document.getElementById("queue-title");
const ghLink = document.getElementById("gh-link");
const langHost = document.getElementById("lang-switch");

let stopRequested = false;
let running = false;
let lang = "en";

function applyI18n() {
  document.documentElement.lang = lang;
  document.title = t(lang, "bulkTitle");
  titleEl.textContent = t(lang, "bulkTitle");
  subEl.textContent = t(lang, "bulkSub");
  labelEl.textContent = t(lang, "bulkLabel");
  linksEl.placeholder = t(lang, "bulkPlaceholder");
  btnStart.textContent = t(lang, "bulkStart");
  btnStop.textContent = t(lang, "bulkStop");
  queueTitle.textContent = t(lang, "bulkQueue");
  ghLink.textContent = t(lang, "github");
  updateLangSwitch(langHost, lang);
}

function parseLinks(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    let url = line;
    const uid = extractUid(line);
    if (!uid) continue;
    if (!/^https?:\/\//i.test(url)) {
      url = `https://sketchfab.com/3d-models/${uid}`;
    }
    const key = uid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uid: key, url });
  }
  return out;
}

function addItem(url) {
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML = `<div class="title"></div><div class="msg"></div>`;
  div.querySelector(".title").textContent = url;
  div.querySelector(".msg").textContent = t(lang, "bulkQueued");
  logEl.prepend(div);
  return {
    el: div,
    set(msg, state) {
      div.querySelector(".msg").textContent = msg;
      div.classList.remove("ok", "err", "run");
      if (state) div.classList.add(state);
    },
  };
}

btnStop.addEventListener("click", () => {
  stopRequested = true;
  btnStop.disabled = true;
  summaryEl.textContent = t(lang, "bulkStopping");
});

btnStart.addEventListener("click", async () => {
  if (running) return;
  const items = parseLinks(linksEl.value);
  if (!items.length) {
    summaryEl.textContent = t(lang, "bulkNoLinks");
    return;
  }

  running = true;
  stopRequested = false;
  btnStart.disabled = true;
  btnStop.disabled = false;
  logEl.innerHTML = "";
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < items.length; i++) {
    if (stopRequested) break;
    const { url } = items[i];
    const row = addItem(url);
    row.set(
      `[${i + 1}/${items.length}] ${t(lang, "bulkStarting")}`,
      "run"
    );
    summaryEl.textContent = `${t(lang, "bulkDownloading")} ${i + 1} / ${
      items.length
    }…`;
    try {
      const devMode = await isDevMode();
      const prefs = await loadPrefs();
      const result = await downloadModelInBackground(
        url,
        (msg) => {
          row.set(`[${i + 1}/${items.length}] ${msg}`, "run");
        },
        {
          devMode,
          downloadTextures: prefs.textures === true,
          packMode: prefs.packMode === "glb" ? "glb" : "full",
          maxTextureEdge:
            prefs.maxTextureEdge === 2048 || prefs.maxTextureEdge === 4096
              ? prefs.maxTextureEdge
              : 0,
        }
      );
      if (!result.savedByBackground && result.zip) {
        await saveZip(result.zip, result.zipName);
      }
      row.set(
        `✅ ${result.name} — ${result.zipName}${
          result.hasGlb ? " (glb)" : ""
        }${result.zipBytes ? ` · ${result.zipBytes} B` : ""}`,
        "ok"
      );
      ok++;
    } catch (e) {
      row.set(`❌ ${e.message || e}`, "err");
      fail++;
    }
  }

  running = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  summaryEl.textContent = stopRequested
    ? t(lang, "bulkStopped", { ok, fail })
    : t(lang, "bulkFinished", { ok, fail });
});

async function init() {
  lang = await getLang();
  const theme = await getTheme();
  applyTheme(document.documentElement, theme);
  applyTheme(document.body, theme);
  langHost.appendChild(
    createLangSwitch(lang, async (code) => {
      lang = await setLang(code);
      applyI18n();
    })
  );
  applyI18n();
}

init();
