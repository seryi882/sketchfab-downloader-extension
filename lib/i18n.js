/**
 * Simple EN/RU i18n for the extension UI.
 * Language is stored in chrome.storage.local under "sf_lang".
 */

export const LANGS = ["en", "ru"];

const STRINGS = {
  en: {
    appName: "Sketchfab Public Downloader",
    tagline: "No account · Auto keys · glTF (GLB)",
    checkingTab: "Checking current tab…",
    noActiveTab: "No active tab",
    openModelOrBulk:
      "Open a <b>public Sketchfab model</b> page, or use bulk download.",
    readyDownload: "Ready to download",
    downloadRunning: "Download already running on the page…",
    modelDetected: "Model page detected. Click download.",
    btnDownload: "Download this model",
    btnBulk: "Bulk download page…",
    popupHint:
      "Open a public model page, then download from this popup or the floating panel on the page.",
    working: "Working…",
    pageBusy: "Page script busy/unavailable — downloading from popup…",
    retryPopup: "Retrying download from extension popup…",
    saved: "Saved",
    langEn: "EN",
    langRu: "RU",
    language: "Language",
    devMode: "Dev mode",
    devModeOn: "Dev mode ON — detailed logs for this download",
    devModeOff: "Dev mode off",
    devLogTitle: "Download log",
    copyLog: "Copy log",
    saveLog: "Save log",
    clearLog: "Clear",
    logCopied: "Log copied",
    logSaved: "Log saved",
    downloading: "Downloading…",
    downloadOk: "Done",

    // Panel
    panelTitle: "Sketchfab Downloader",
    panelMeta: "Public model → glTF (GLB)",
    panelReady: "Ready.",
    panelDownload: "Download glTF ZIP",
    panelBulk: "Bulk download page…",
    starting: "Starting…",
    saving: "Saving",
    includesGlb: "(includes .glb)",
    done: "Done",
    by: "by",
    alreadyDownloading: "Already downloading…",
    uidLabel: "UID",
    captureWaiting: "Viewer: hook ready — wait until the model is fully visible…",
    captureNone: "Viewer: 0 decoded after dump (reload page, wait for full load)",
    captureCount: "Viewer blit: {n} decoded texture(s)",
    captureLastDump: "last dump {n}",
    captureDumping: "Collecting viewer-decoded textures…",
    captureUsing: "Using {n} viewer-decoded texture(s)…",
    captureFallback: "No viewer blit — public API maps may be striped…",
    captureEmbedWait: "Waiting for viewer decode blit…",
    errContextInvalid:
      "Extension was reloaded or ran out of memory. Refresh this Sketchfab page and download again (do not only Reload the extension).",
    errWorkerDied:
      "The download worker stopped (large 4K texture pack or extension reload). Refresh the page and retry.",

    // Bulk
    bulkTitle: "Sketchfab Bulk Download",
    bulkSub:
      "Paste many public model links. Each model is downloaded as a glTF (GLB) ZIP. No account / API key. Keys update automatically.",
    bulkLabel: "Sketchfab URLs or UIDs (one per line)",
    bulkPlaceholder:
      "https://sketchfab.com/3d-models/…\nhttps://sketchfab.com/3d-models/…\na1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    bulkStart: "Download all",
    bulkStop: "Stop after current",
    bulkQueue: "Queue",
    bulkQueued: "Queued",
    bulkNoLinks: "No valid Sketchfab links found.",
    bulkStopping: "Stopping after current model…",
    bulkDownloading: "Downloading",
    bulkStarting: "Starting…",
    bulkStopped: "Stopped. OK: {ok}, failed: {fail}, remaining skipped.",
    bulkFinished: "Finished. OK: {ok}, failed: {fail}.",
    github: "GitHub",
    tabDownload: "Download",
    tabSettings: "Settings",
    settingsTitle: "Settings",
    optTextures: "Download textures",
    optTexturesHint:
      "When off, only mesh/glTF is saved — much faster, no maps in the ZIP.",
    optDevHint: "Show a detailed log of the last download on the Download tab.",
    texturesOn: "Textures ON — maps are descrambled and packed",
    texturesOff: "Textures OFF — mesh only (faster)",
    githubRepo: "Project on GitHub",
    optTheme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    saveSettings: "Apply settings",
    settingsSaved: "Settings applied",
    settingsSaveHint:
      "Theme, language, archive type and texture size apply immediately. Textures and developer mode apply after Apply settings.",
    settingsDirty:
      "Unsaved texture / developer-mode changes — click Apply settings",
    jobStatus: "Textures: {tex} · Dev: {dev} · Archive: {pack} · Size: {size}",
    jobOn: "on",
    jobOff: "off",
    optPack: "Archive",
    packGlb: "GLB only",
    packFull: "Full",
    packHint: "GLB only is smaller. Full also keeps osgjs, model.gltf and loose maps.",
    optTexSize: "Texture size",
    texSizeOrig: "Original",
    texSize2k: "≤ 2K",
    texSize4k: "≤ 4K",
    texSizeHint:
      "Original always picks the largest map. 2K / 4K only apply when you choose them.",
  },
  ru: {
    appName: "Sketchfab Public Downloader",
    tagline: "Без аккаунта · Авто-ключи · glTF (GLB)",
    checkingTab: "Проверка текущей вкладки…",
    noActiveTab: "Нет активной вкладки",
    openModelOrBulk:
      "Откройте страницу <b>публичной модели Sketchfab</b> или используйте массовую загрузку.",
    readyDownload: "Готово к скачиванию",
    downloadRunning: "Скачивание уже идёт на странице…",
    modelDetected: "Страница модели обнаружена. Нажмите «Скачать».",
    btnDownload: "Скачать эту модель",
    btnBulk: "Массовая загрузка…",
    popupHint:
      "Откройте страницу публичной модели, затем скачайте из этого окна или с плавающей панели на странице.",
    working: "Работаю…",
    pageBusy: "Скрипт страницы недоступен — скачиваю из popup…",
    retryPopup: "Повторная загрузка из окна расширения…",
    saved: "Сохранено",
    langEn: "EN",
    langRu: "RU",
    language: "Язык",
    devMode: "Режим разработчика",
    devModeOn: "Dev mode ВКЛ — подробные логи этой загрузки",
    devModeOff: "Dev mode выкл",
    devLogTitle: "Лог загрузки",
    copyLog: "Копировать лог",
    saveLog: "Сохранить лог",
    clearLog: "Очистить",
    logCopied: "Лог скопирован",
    logSaved: "Лог сохранён",
    downloading: "Скачивание…",
    downloadOk: "Готово",

    panelTitle: "Sketchfab Downloader",
    panelMeta: "Публичная модель → glTF (GLB)",
    panelReady: "Готово.",
    panelDownload: "Скачать glTF ZIP",
    panelBulk: "Массовая загрузка…",
    starting: "Запуск…",
    saving: "Сохранение",
    includesGlb: "(есть .glb)",
    done: "Готово",
    by: "автор",
    alreadyDownloading: "Уже скачивается…",
    uidLabel: "UID",
    captureWaiting: "Viewer: хук готов — дождитесь полной загрузки модели…",
    captureNone: "Viewer: 0 decoded после dump (перезагрузите, дождитесь модели)",
    captureCount: "Viewer blit: decoded текстур: {n}",
    captureLastDump: "последний dump {n}",
    captureDumping: "Сбор decoded текстур из вьюера…",
    captureUsing: "Использую {n} viewer-decoded текстур…",
    captureFallback: "Нет viewer blit — карты API могут быть полосатыми…",
    captureEmbedWait: "Ожидание decode-blit во вьюере…",
    errContextInvalid:
      "Расширение перезагрузили или ему не хватило памяти. Обнови страницу модели в браузере и скачай снова (одного Reload расширения мало).",
    errWorkerDied:
      "Воркер скачивания остановился (тяжёлый пак 4K-текстур или Reload). Обнови страницу и повтори.",

    bulkTitle: "Массовая загрузка Sketchfab",
    bulkSub:
      "Вставьте много ссылок на публичные модели. Каждая скачивается как glTF (GLB) ZIP. Без аккаунта и API-ключа. Ключи обновляются автоматически.",
    bulkLabel: "Ссылки Sketchfab или UID (по одной на строку)",
    bulkPlaceholder:
      "https://sketchfab.com/3d-models/…\nhttps://sketchfab.com/3d-models/…\na1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    bulkStart: "Скачать все",
    bulkStop: "Стоп после текущей",
    bulkQueue: "Очередь",
    bulkQueued: "В очереди",
    bulkNoLinks: "Не найдено корректных ссылок Sketchfab.",
    bulkStopping: "Остановка после текущей модели…",
    bulkDownloading: "Скачивание",
    bulkStarting: "Старт…",
    bulkStopped: "Остановлено. OK: {ok}, ошибок: {fail}, остальные пропущены.",
    bulkFinished: "Готово. OK: {ok}, ошибок: {fail}.",
    github: "GitHub",
    tabDownload: "Скачать",
    tabSettings: "Настройки",
    settingsTitle: "Настройки",
    optTextures: "Скачивать текстуры",
    optTexturesHint:
      "Если выключить, сохранится только меш/glTF — быстрее, карт в ZIP не будет.",
    optDevHint: "Подробный лог последней загрузки на вкладке «Скачать».",
    texturesOn: "Текстуры ВКЛ — карты дескремблятся и пакуются",
    texturesOff: "Текстуры ВЫКЛ — только меш (быстрее)",
    githubRepo: "Проект на GitHub",
    optTheme: "Тема",
    themeLight: "Светлая",
    themeDark: "Тёмная",
    saveSettings: "Применить настройки",
    settingsSaved: "Настройки применены",
    settingsSaveHint:
      "Тема, язык, тип архива и размер текстур применяются сразу. Текстуры и режим разработчика — после «Применить настройки».",
    settingsDirty:
      "Неприменённые текстуры / dev — нажмите «Применить настройки»",
    jobStatus: "Текстуры: {tex} · Dev: {dev} · Архив: {pack} · Размер: {size}",
    jobOn: "вкл",
    jobOff: "выкл",
    optPack: "Архив",
    packGlb: "Только GLB",
    packFull: "Полный",
    packHint: "Только GLB меньше. Полный ещё кладёт osgjs, model.gltf и отдельные карты.",
    optTexSize: "Размер текстур",
    texSizeOrig: "Оригинал",
    texSize2k: "≤ 2K",
    texSize4k: "≤ 4K",
    texSizeHint:
      "Оригинал всегда берёт самую большую карту. 2K / 4K действуют только если их выбрать.",
  },
};

export async function getLang() {
  try {
    const stored = await chrome.storage.local.get("sf_lang");
    if (stored.sf_lang === "ru" || stored.sf_lang === "en") return stored.sf_lang;
  } catch (_) {}
  // Browser UI language fallback
  try {
    const nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("ru")) return "ru";
  } catch (_) {}
  return "en";
}

export async function setLang(lang) {
  const v = lang === "ru" ? "ru" : "en";
  try {
    await chrome.storage.local.set({ sf_lang: v });
  } catch (_) {}
  return v;
}

export function t(lang, key, vars) {
  const pack = STRINGS[lang] || STRINGS.en;
  let s = pack[key] ?? STRINGS.en[key] ?? key;
  if (vars && typeof s === "string") {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

/**
 * Build a small EN | RU language toggle.
 * Uses live .active state (not a stale closure) so switching back works.
 */
export function createLangSwitch(current, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "sf-lang";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Language");
  for (const code of LANGS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sf-lang-btn" + (code === current ? " active" : "");
    btn.dataset.lang = code;
    btn.textContent = code.toUpperCase();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Read current active button — do NOT close over initial `current`
      const active = wrap.querySelector(".sf-lang-btn.active");
      if (active && active.dataset.lang === code) return;
      try {
        const ret = onChange(code);
        if (ret && typeof ret.then === "function") {
          ret.catch((err) => console.warn("[sf-dl] setLang failed", err));
        }
      } catch (err) {
        console.warn("[sf-dl] setLang failed", err);
      }
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

export function updateLangSwitch(root, lang) {
  if (!root) return;
  root.querySelectorAll(".sf-lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });
}
