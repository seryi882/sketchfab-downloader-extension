/**
 * User settings. One blob in chrome.storage.local (sf_prefs).
 * Textures default OFF. What the UI shows is written only via savePrefs().
 */

const KEY = "sf_prefs";

export const GITHUB_URL =
  "https://github.com/seryi882/sketchfab-downloader-extension";

export const DEFAULT_PREFS = {
  textures: false,
  theme: "light",
  lang: "en",
  devMode: false,
};

export function normalizePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    textures: p.textures === true,
    theme: p.theme === "dark" ? "dark" : "light",
    lang: p.lang === "ru" ? "ru" : "en",
    devMode: p.devMode === true,
  };
}

export async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get([
      KEY,
      "sf_download_textures",
      "sf_theme",
      "sf_lang",
      "sf_dev_mode",
    ]);
    if (stored[KEY] && typeof stored[KEY] === "object") {
      return normalizePrefs(stored[KEY]);
    }
    return normalizePrefs({
      textures: stored.sf_download_textures === true,
      theme: stored.sf_theme,
      lang: stored.sf_lang,
      devMode: stored.sf_dev_mode === true,
    });
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

/** Hard-write the snapshot. Mirrors old keys so leftover readers stay in sync. */
export async function savePrefs(partial) {
  const current = await loadPrefs();
  const next = normalizePrefs({ ...current, ...partial });
  await chrome.storage.local.set({
    [KEY]: next,
    sf_download_textures: next.textures === true,
    sf_theme: next.theme,
    sf_lang: next.lang,
    sf_dev_mode: next.devMode === true,
  });
  return next;
}

export async function isDownloadTextures() {
  const p = await loadPrefs();
  return p.textures === true;
}

export async function setDownloadTextures(on) {
  const next = await savePrefs({ textures: on === true });
  return next.textures;
}

export async function getTheme() {
  return (await loadPrefs()).theme;
}

export async function setTheme(theme) {
  const next = await savePrefs({
    theme: theme === "dark" ? "dark" : "light",
  });
  return next.theme;
}

/**
 * Theme `el`. Never touch documentElement from a Sketchfab content script.
 */
export function applyTheme(el, theme) {
  if (!el) return;
  const v = theme === "dark" ? "dark" : "light";
  el.setAttribute("data-theme", v);
  if (el === document.documentElement || el === document.body) {
    document.documentElement.setAttribute("data-theme", v);
    if (document.body) document.body.setAttribute("data-theme", v);
    document.documentElement.style.colorScheme = v;
  }
}

/** Snapshot of whatever the settings widgets currently show. */
export function prefsFromUi({ texToggle, devToggle, theme, lang }) {
  return normalizePrefs({
    textures: !!(texToggle && texToggle.checked),
    devMode: !!(devToggle && devToggle.checked),
    theme: theme === "dark" ? "dark" : "light",
    lang: lang === "ru" ? "ru" : "en",
  });
}
