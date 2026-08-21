import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewerMaterials } from "../lib/sf-api.js";

/** Viewer info carrying one material with the given channels. */
function info(channels) {
  return { options: { materials: { m1: { name: "Mat", channels } } } };
}

const spec = (channels) => parseViewerMaterials(info(channels)).get("Mat");

test("clearcoat is read when the channel is enabled", () => {
  const s = spec({
    ClearCoat: { enable: true, factor: 0.8, texture: { uid: "AABB" } },
    ClearCoatRoughness: { enable: true, factor: 0.1 },
  });
  assert.equal(s.clearCoat.factor, 0.8);
  assert.equal(s.clearCoat.roughness, 0.1);
  assert.equal(s.clearCoat.textureUid, "aabb");
});

test("clearcoat is ignored when the channel is off", () => {
  // Sketchfab declares the channel on every material, so a disabled one with a
  // default factor must not produce a coat the author never applied.
  const s = spec({
    ClearCoat: { enable: false, factor: 1 },
    ClearCoatRoughness: { enable: true, factor: 0.04 },
  });
  assert.equal(s.clearCoat, null);
});

test("clearcoat roughness is not borrowed by materials without a coat", () => {
  const s = spec({ ClearCoatRoughness: { enable: true, factor: 0.04 } });
  assert.equal(s.clearCoat, null);
});

test("clearcoat survives without a texture", () => {
  const s = spec({ ClearCoat: { enable: true, factor: 0.5 } });
  assert.equal(s.clearCoat.factor, 0.5);
  assert.equal(s.clearCoat.textureUid, null);
});

test("sheen reads colour and roughness when enabled", () => {
  const s = spec({
    Sheen: { enable: true, color: [0.9, 0.2, 0.1] },
    SheenRoughness: { enable: true, factor: 0.3 },
  });
  assert.deepEqual(s.sheen.colorFactor, [0.9, 0.2, 0.1]);
  assert.equal(s.sheen.roughness, 0.3);
});

test("sheen defaults to white when no colour is given", () => {
  const s = spec({ Sheen: { enable: true } });
  assert.deepEqual(s.sheen.colorFactor, [1, 1, 1]);
});

test("sheen is ignored when the channel is off", () => {
  const s = spec({
    Sheen: { enable: false, color: [1, 0, 0] },
    SheenRoughness: { enable: true, factor: 0.3 },
  });
  assert.equal(s.sheen, null);
});

test("a plain material gets neither extension", () => {
  const s = spec({ AlbedoPBR: { enable: true, texture: { uid: "CCDD" } } });
  assert.equal(s.clearCoat, null);
  assert.equal(s.sheen, null);
});

/* --- clearcoat normal map ------------------------------------------------ */

test("the clearcoat normal map is read when the coat is on", () => {
  // Values from M18_ClearCoat on r3_01: the channel only exists because it was
  // switched on by hand in Sketchfab's editor, which is why it went unread for
  // so long -- no upload format can set it.
  const s = spec({
    ClearCoat: { enable: true, factor: 1, texture: { uid: "01579247290247B3B9BA0E924BA99E0F" } },
    ClearCoatRoughness: { enable: true, factor: 0.1 },
    ClearCoatNormalMap: {
      enable: true,
      flipY: false,
      texture: { uid: "5B7891C894DE467789C78DF2246ECF6A" },
    },
  });
  assert.equal(s.clearCoat.normalTextureUid, "5b7891c894de467789c78df2246ecf6a");
  assert.equal(s.clearCoat.normalFlipY, false);
});

test("the clearcoat normal map defaults to flipped green", () => {
  // Same default as the surface normal map: absent flipY means Sketchfab's
  // convention, which is the opposite handedness to glTF.
  const s = spec({
    ClearCoat: { enable: true, factor: 1 },
    ClearCoatNormalMap: { enable: true, texture: { uid: "CCDD" } },
  });
  assert.equal(s.clearCoat.normalFlipY, true);
});

test("a clearcoat normal map on a material with no coat is ignored", () => {
  // The channel is declared on every material. Without the coat itself there is
  // no KHR_materials_clearcoat to hang it on.
  const s = spec({
    ClearCoat: { enable: false, factor: 1 },
    ClearCoatNormalMap: { enable: true, texture: { uid: "CCDD" } },
  });
  assert.equal(s.clearCoat, null);
});

test("a disabled clearcoat normal map contributes no texture", () => {
  const s = spec({
    ClearCoat: { enable: true, factor: 1 },
    ClearCoatNormalMap: { enable: false, texture: { uid: "CCDD" } },
  });
  assert.equal(s.clearCoat.normalTextureUid, null);
});
