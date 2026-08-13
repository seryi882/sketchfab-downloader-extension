/**
 * Shared settings widgets for popup + page panel.
 * Job dirty = textures / devMode only (theme & lang apply immediately).
 */

export function isJobDirty(pending, applied) {
  return (
    !!pending.textures !== !!applied.textures ||
    !!pending.devMode !== !!applied.devMode
  );
}

export function paintSettingsFlash(el, { dirty, appliedOk, t, lang }) {
  if (!el) return;
  const keep = el.classList.contains("settings-flash") ? "settings-flash " : "";
  if (dirty) {
    el.hidden = false;
    el.className = keep + "show dirty";
    el.textContent = t(lang, "settingsDirty");
    return;
  }
  if (appliedOk) {
    el.hidden = false;
    el.className = keep + "show ok";
    el.textContent = t(lang, "settingsSaved");
    return;
  }
  el.hidden = true;
  el.className = keep.trim();
  el.textContent = "";
}

export function formatJobStatus(prefs, t, lang) {
  const p = prefs || {};
  const pack = p.packMode === "glb" ? t(lang, "packGlb") : t(lang, "packFull");
  const size =
    p.maxTextureEdge === 2048
      ? t(lang, "texSize2k")
      : p.maxTextureEdge === 4096
        ? t(lang, "texSize4k")
        : t(lang, "texSizeOrig");
  return t(lang, "jobStatus", {
    tex: p.textures ? t(lang, "jobOn") : t(lang, "jobOff"),
    dev: p.devMode ? t(lang, "jobOn") : t(lang, "jobOff"),
    pack,
    size,
  });
}

/**
 * Pill group (theme / pack / resolution).
 * @param {HTMLElement} host
 * @param {{ items: {code:string,label:string}[], get: () => string, onPick: (code:string) => void }} opts
 */
export function bindPillSwitch(host, { items, get, onPick }) {
  if (!host) return () => {};
  const paint = () => {
    const cur = get();
    host.innerHTML = "";
    host.className = "sf-lang";
    host.setAttribute("role", "group");
    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sf-lang-btn" + (cur === it.code ? " active" : "");
      btn.dataset.value = it.code;
      btn.textContent = it.label;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (get() === it.code) return;
        onPick(it.code);
      });
      host.appendChild(btn);
    }
  };
  paint();
  return paint;
}

export function bindThemeSwitch(host, { getTheme, onPick, t, lang }) {
  return bindPillSwitch(host, {
    items: [
      { code: "light", label: t(lang, "themeLight") },
      { code: "dark", label: t(lang, "themeDark") },
    ],
    get: getTheme,
    onPick,
  });
}
