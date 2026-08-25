import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANGS, STRINGS, t } from "../lib/i18n.js";

test("all supported UI languages provide the same translation keys", () => {
  assert.deepEqual(LANGS, ["en", "ru", "zh"]);
  const expected = Object.keys(STRINGS.en).sort();
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), expected, lang);
    for (const key of expected) {
      assert.equal(typeof STRINGS[lang][key], "string", `${lang}.${key}`);
      assert.notEqual(STRINGS[lang][key], "", `${lang}.${key}`);
    }
  }
});

test("Chinese translations and placeholders are resolved", () => {
  assert.equal(t("zh", "language"), "语言");
  assert.equal(
    t("zh", "bulkFinished", { ok: 3, fail: 1 }),
    "全部完成。成功：3，失败：1。"
  );
});

test("manifest metadata has valid English, Russian, and Chinese locales", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_appName__");
  assert.equal(manifest.description, "__MSG_appDescription__");

  for (const locale of ["en", "ru", "zh_CN"]) {
    const messages = JSON.parse(
      await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), "utf8")
    );
    assert.ok(messages.appName.message, locale);
    assert.ok(messages.appDescription.message, locale);
  }
});
