/**
 * Simple EN/RU/ZH i18n for the extension UI.
 * Language is stored in chrome.storage.local under "sf_lang".
 */

export const LANGS = ["en", "ru", "zh"];

export const STRINGS = {
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
    langZh: "ZH",
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
    langZh: "ZH",
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
  zh: {
    appName: "Sketchfab 公共模型下载器",
    tagline: "无需账号 · 自动获取密钥 · glTF (GLB)",
    checkingTab: "正在检查当前标签页…",
    noActiveTab: "没有活动标签页",
    openModelOrBulk:
      "请打开一个 <b>Sketchfab 公共模型</b>页面，或使用批量下载。",
    readyDownload: "可以开始下载",
    downloadRunning: "页面中已有下载任务正在运行…",
    modelDetected: "已检测到模型页面，请点击下载。",
    btnDownload: "下载此模型",
    btnBulk: "打开批量下载页面…",
    popupHint:
      "打开公共模型页面后，可从此弹窗或页面上的浮动面板开始下载。",
    working: "正在处理…",
    pageBusy: "页面脚本忙碌或不可用，正在从扩展弹窗下载…",
    retryPopup: "正在从扩展弹窗重试下载…",
    saved: "已保存",
    langEn: "EN",
    langRu: "RU",
    langZh: "ZH",
    language: "语言",
    devMode: "开发者模式",
    devModeOn: "开发者模式已开启，将记录本次下载的详细日志",
    devModeOff: "开发者模式已关闭",
    devLogTitle: "下载日志",
    copyLog: "复制日志",
    saveLog: "保存日志",
    clearLog: "清空",
    logCopied: "日志已复制",
    logSaved: "日志已保存",
    downloading: "正在下载…",
    downloadOk: "下载完成",

    // Panel
    panelTitle: "Sketchfab 下载器",
    panelMeta: "公共模型 → glTF (GLB)",
    panelReady: "准备就绪。",
    panelDownload: "下载 glTF ZIP",
    panelBulk: "打开批量下载页面…",
    starting: "正在启动…",
    saving: "正在保存",
    includesGlb: "（包含 .glb）",
    done: "完成",
    by: "作者",
    alreadyDownloading: "已有下载任务正在运行…",
    uidLabel: "UID",
    captureWaiting: "查看器：捕获钩子已就绪，请等待模型完全显示…",
    captureNone: "查看器：转储后未获得已解码纹理（请刷新页面并等待模型完全加载）",
    captureCount: "查看器捕获：已解码 {n} 个纹理",
    captureLastDump: "上次转储 {n} 个",
    captureDumping: "正在收集查看器已解码的纹理…",
    captureUsing: "正在使用查看器已解码的 {n} 个纹理…",
    captureFallback: "未获得查看器捕获，公共 API 贴图可能带有条纹…",
    captureEmbedWait: "正在等待查看器解码并捕获纹理…",
    errContextInvalid:
      "扩展可能已重新加载或内存不足。请刷新此 Sketchfab 页面后重新下载（仅重新加载扩展无效）。",
    errWorkerDied:
      "下载工作进程已停止（可能由大型 4K 纹理包或扩展重新加载导致）。请刷新页面后重试。",

    // Bulk
    bulkTitle: "Sketchfab 批量下载",
    bulkSub:
      "粘贴多个公共模型链接，每个模型都会下载为 glTF (GLB) ZIP。无需账号或 API 密钥，密钥会自动更新。",
    bulkLabel: "Sketchfab 链接或 UID（每行一个）",
    bulkPlaceholder:
      "https://sketchfab.com/3d-models/…\nhttps://sketchfab.com/3d-models/…\na1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    bulkStart: "全部下载",
    bulkStop: "完成当前任务后停止",
    bulkQueue: "下载队列",
    bulkQueued: "已加入队列",
    bulkNoLinks: "未找到有效的 Sketchfab 链接。",
    bulkStopping: "将在当前模型下载完成后停止…",
    bulkDownloading: "正在下载",
    bulkStarting: "正在启动…",
    bulkStopped: "已停止。成功：{ok}，失败：{fail}，其余任务已跳过。",
    bulkFinished: "全部完成。成功：{ok}，失败：{fail}。",
    github: "GitHub",
    tabDownload: "下载",
    tabSettings: "设置",
    settingsTitle: "设置",
    optTextures: "下载纹理",
    optTexturesHint:
      "关闭后只保存网格/glTF，速度更快，ZIP 中不包含贴图。",
    optDevHint: "在“下载”标签页显示上次下载的详细日志。",
    texturesOn: "纹理已开启，将还原并打包贴图",
    texturesOff: "纹理已关闭，仅下载网格（速度更快）",
    githubRepo: "GitHub 项目",
    optTheme: "主题",
    themeLight: "浅色",
    themeDark: "深色",
    saveSettings: "应用设置",
    settingsSaved: "设置已应用",
    settingsSaveHint:
      "主题、语言、归档类型和纹理尺寸会立即生效；纹理和开发者模式需点击“应用设置”后生效。",
    settingsDirty: "纹理或开发者模式的更改尚未应用，请点击“应用设置”",
    jobStatus: "纹理：{tex} · 开发者模式：{dev} · 归档：{pack} · 尺寸：{size}",
    jobOn: "开启",
    jobOff: "关闭",
    optPack: "归档",
    packGlb: "仅 GLB",
    packFull: "完整归档",
    packHint: "仅 GLB 占用空间更小；完整归档还会保留 osgjs、model.gltf 和独立贴图。",
    optTexSize: "纹理尺寸",
    texSizeOrig: "原始尺寸",
    texSize2k: "≤ 2K",
    texSize4k: "≤ 4K",
    texSizeHint: "原始尺寸始终选择最大贴图；只有手动选择时才会限制为 2K 或 4K。",
  },
};

export async function getLang() {
  try {
    const stored = await chrome.storage.local.get(["sf_lang", "sf_prefs"]);
    if (LANGS.includes(stored.sf_lang)) return stored.sf_lang;
    if (stored.sf_prefs && LANGS.includes(stored.sf_prefs.lang)) {
      return stored.sf_prefs.lang;
    }
  } catch (_) {}
  // Browser UI language fallback
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
    const code = ui.toLowerCase();
    if (code.startsWith("zh")) return "zh";
    if (code.startsWith("ru")) return "ru";
  } catch (_) {}
  try {
    const nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("zh")) return "zh";
    if (nav.startsWith("ru")) return "ru";
  } catch (_) {}
  return "en";
}

export async function setLang(lang) {
  const v = LANGS.includes(lang) ? lang : "en";
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
 * Build a small EN | RU | ZH language toggle.
 * Uses live .active state (not a stale closure) so switching back works.
 */
export function createLangSwitch(current, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "sf-lang";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", t(current, "language"));
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
