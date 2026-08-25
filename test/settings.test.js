import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePrefs,
  languageFromLocale,
  loadPrefs,
  savePrefs,
  prefsFromUi,
  jobFlagsFromPrefs,
} from "../lib/settings.js";
import { isJobDirty, formatJobStatus } from "../lib/ui-settings.js";
import { t } from "../lib/i18n.js";

test("normalizePrefs never caps textures unless 2048 or 4096", () => {
  assert.equal(normalizePrefs({}).maxTextureEdge, 0);
  assert.equal(normalizePrefs({ maxTextureEdge: 0 }).maxTextureEdge, 0);
  assert.equal(normalizePrefs({ maxTextureEdge: 1024 }).maxTextureEdge, 0);
  assert.equal(normalizePrefs({ maxTextureEdge: 8192 }).maxTextureEdge, 0);
  assert.equal(normalizePrefs({ maxTextureEdge: "nope" }).maxTextureEdge, 0);
  assert.equal(normalizePrefs({ maxTextureEdge: 2048 }).maxTextureEdge, 2048);
  assert.equal(normalizePrefs({ maxTextureEdge: 4096 }).maxTextureEdge, 4096);
});

test("normalizePrefs packMode is full unless glb", () => {
  assert.equal(normalizePrefs({}).packMode, "full");
  assert.equal(normalizePrefs({ packMode: "zip" }).packMode, "full");
  assert.equal(normalizePrefs({ packMode: "glb" }).packMode, "glb");
});

test("Chinese language survives preference normalization", () => {
  assert.equal(normalizePrefs({ lang: "zh" }).lang, "zh");
  assert.equal(prefsFromUi({ lang: "zh" }).lang, "zh");
  assert.equal(normalizePrefs({ lang: "unsupported" }).lang, "en");
});

test("Chinese browser locales select the Chinese UI", () => {
  assert.equal(languageFromLocale("zh-CN"), "zh");
  assert.equal(languageFromLocale("zh-Hans"), "zh");
  assert.equal(languageFromLocale("ru-RU"), "ru");
  assert.equal(languageFromLocale("en-US"), "en");
});

test("first-run preferences use the browser UI language", async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: { get: async () => ({}) } },
    i18n: { getUILanguage: () => "zh-CN" },
  };
  try {
    assert.equal((await loadPrefs()).lang, "zh");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("savePrefs persists language in canonical and legacy storage", async () => {
  const previousChrome = globalThis.chrome;
  let written = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          sf_prefs: {
            textures: false,
            theme: "light",
            lang: "en",
            devMode: false,
            packMode: "full",
            maxTextureEdge: 0,
          },
        }),
        set: async (value) => {
          written = value;
        },
      },
    },
  };
  try {
    const next = await savePrefs({ lang: "zh" });
    assert.equal(next.lang, "zh");
    assert.equal(written.sf_prefs.lang, "zh");
    assert.equal(written.sf_lang, "zh");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("jobFlagsFromPrefs mirrors applied textures/dev/pack/edge", () => {
  const flags = jobFlagsFromPrefs({
    textures: true,
    devMode: true,
    packMode: "glb",
    maxTextureEdge: 2048,
  });
  assert.equal(flags.downloadTextures, true);
  assert.equal(flags.devMode, true);
  assert.equal(flags.packMode, "glb");
  assert.equal(flags.maxTextureEdge, 2048);
});

test("isJobDirty ignores theme/lang/pack and watches textures/dev only", () => {
  assert.equal(
    isJobDirty(
      { textures: true, devMode: false },
      { textures: true, devMode: false }
    ),
    false
  );
  assert.equal(
    isJobDirty(
      { textures: true, devMode: false },
      { textures: false, devMode: false }
    ),
    true
  );
});

test("formatJobStatus includes archive and size", () => {
  const s = formatJobStatus(
    { textures: true, devMode: false, packMode: "glb", maxTextureEdge: 0 },
    t,
    "en"
  );
  assert.match(s, /Textures: on/);
  assert.match(s, /Dev: off/);
  assert.match(s, /GLB only/);
  assert.match(s, /Original/);
});
