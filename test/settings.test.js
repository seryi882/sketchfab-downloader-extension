import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePrefs, jobFlagsFromPrefs } from "../lib/settings.js";
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
