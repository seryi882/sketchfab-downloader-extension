import { test } from "node:test";
import assert from "node:assert/strict";
import { isPackedOrmName, planOrm, packOrmPixels } from "../lib/orm.js";
import { classifyTextureName, pbrFactors } from "../lib/osgjs2gltf.js";

/** uid -> basename resolver over a fake downloaded texture list */
function resolverFor(map) {
  return (uid) => map[uid] || null;
}

const M_UID = "11111111111111111111111111111111";
const R_UID = "22222222222222222222222222222222";

test("isPackedOrmName separates packed ORM from single-channel maps", () => {
  assert.equal(isPackedOrmName("vpcm2_case_ORM.png"), true);
  assert.equal(isPackedOrmName("Body_mrao.jpg"), true);
  assert.equal(isPackedOrmName("Body_MetallicRoughness.png"), true);
  // the case that shipped the bug: classifies as 'metalrough' but is metal-only
  assert.equal(isPackedOrmName("vpcm2_case_metallic.jpg"), false);
  assert.equal(isPackedOrmName("vpcm2_case_roughness.jpg"), false);
  // "arm" is a body part far more often than an AO/Roughness/Metallic pack;
  // treating one as packed would rebind a metal-only map and restore the bug.
  assert.equal(isPackedOrmName("Character_arm_metallic.png"), false);
  assert.equal(isPackedOrmName("robot_arm_roughness.jpg"), false);
  assert.equal(classifyTextureName("vpcm2_case_metallic.jpg"), "metalrough");
});

test("planOrm packs when metalness and roughness are separate maps", () => {
  const spec = { metalnessUid: M_UID, roughnessUid: R_UID };
  const plan = planOrm(
    spec,
    resolverFor({ [M_UID]: "vpcm2_case_metallic.jpg", [R_UID]: "vpcm2_case_roughness.jpg" }),
    classifyTextureName
  );
  assert.equal(plan.action, "pack");
  assert.equal(plan.metalName, "vpcm2_case_metallic.jpg");
  assert.equal(plan.roughName, "vpcm2_case_roughness.jpg");
  assert.equal(plan.invertRough, false);
});

test("planOrm passes an already-packed ORM through untouched", () => {
  const spec = { metalnessUid: M_UID };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "Body_ORM.png" }), classifyTextureName);
  assert.equal(plan.action, "passthrough");
  assert.equal(plan.texture, "Body_ORM.png");
});

test("planOrm still packs a metal-only map instead of binding it raw", () => {
  const spec = { metalnessUid: M_UID };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "case_metallic.jpg" }), classifyTextureName);
  assert.equal(plan.action, "pack");
  assert.equal(plan.roughName, null);
});

test("planOrm drops MetalnessPBR pointed at a colour map", () => {
  const spec = { metalnessUid: M_UID };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "Body_D.png" }), classifyTextureName);
  assert.equal(plan.action, "factors");
});

test("planOrm flags glossiness so it can be inverted", () => {
  const spec = { metalnessUid: M_UID, roughnessUid: R_UID, roughnessIsGloss: true };
  const plan = planOrm(
    spec,
    resolverFor({ [M_UID]: "m_metallic.jpg", [R_UID]: "m_gloss.jpg" }),
    classifyTextureName
  );
  assert.equal(plan.action, "pack");
  assert.equal(plan.invertRough, true);
});

test("packOrmPixels writes roughness to green and metalness to blue", () => {
  const px = (v) => Uint8Array.from([v, v, v, 255]);
  const out = packOrmPixels({ metal: px(20), rough: px(200), width: 1, height: 1 });
  assert.equal(out[0], 255, "red free for occlusion");
  assert.equal(out[1], 200, "green = roughness");
  assert.equal(out[2], 20, "blue = metalness");
  assert.equal(out[3], 255);
});

test("packOrmPixels inverts glossiness into roughness", () => {
  const out = packOrmPixels({
    metal: Uint8Array.from([0, 0, 0, 255]),
    rough: Uint8Array.from([230, 230, 230, 255]),
    width: 1,
    height: 1,
    invertRough: true,
  });
  assert.equal(out[1], 25, "gloss 230 -> roughness 25");
});

test("packOrmPixels defaults a missing roughness map to rough, not mirror", () => {
  const out = packOrmPixels({
    metal: Uint8Array.from([0, 0, 0, 255]),
    rough: null,
    width: 1,
    height: 1,
  });
  assert.ok(out[1] > 200, `expected a rough default, got ${out[1]}`);
  assert.equal(out[2], 0);
});

test("pbrFactors keeps viewer roughness when no packed ORM is bound", () => {
  // The shipped bug: a metal-only texture forced both factors to 1, so a black
  // metal map drove roughness to 0 and every material became a mirror.
  const f = pbrFactors({ metalness: "case_metallic.jpg", metallicFactor: 0, roughnessFactor: 0.9 });
  assert.equal(f.bindTexture, false, "must not bind a non-packed map");
  assert.equal(f.metallicFactor, 0);
  assert.equal(f.roughnessFactor, 0.9);
});

test("pbrFactors lets a packed ORM drive both channels", () => {
  const f = pbrFactors({
    metalness: "case_ORM.png",
    ormPacked: true,
    metallicFactor: 0,
    roughnessFactor: 0.9,
  });
  assert.equal(f.bindTexture, true);
  assert.equal(f.metallicFactor, 1);
  assert.equal(f.roughnessFactor, 1);
});

test("pbrFactors does not promote an explicit metallicFactor of 0", () => {
  const f = pbrFactors({ metallicFactor: 0, roughnessFactor: 0.4 });
  assert.equal(f.metallicFactor, 0);
  assert.equal(f.roughnessFactor, 0.4);
});

test("a flat white opacity map bakes to fully opaque, so BLEND is not warranted", async () => {
  const { encodePngRgba } = await import("../lib/descramble.js");
  const { bakeOpacityIntoAlbedo } = await import("../lib/osgjs2gltf.js");

  const size = 4;
  const n = size * size;
  const albedo = new Uint8ClampedArray(n * 4);
  const opaqueMask = new Uint8ClampedArray(n * 4);
  const holeMask = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    albedo.set([120, 120, 120, 255], i * 4);
    opaqueMask.set([255, 255, 255, 255], i * 4); // flat white == fully opaque
    holeMask.set([i === 0 ? 0 : 255, i === 0 ? 0 : 255, i === 0 ? 0 : 255, 255], i * 4);
  }
  const albedoPng = await encodePngRgba(albedo, size, size);

  const flat = await bakeOpacityIntoAlbedo(albedoPng, await encodePngRgba(opaqueMask, size, size));
  assert.equal(flat.hasTransparency, false, "flat white opacity must not request BLEND");

  const holed = await bakeOpacityIntoAlbedo(albedoPng, await encodePngRgba(holeMask, size, size));
  assert.equal(holed.hasTransparency, true, "a real cutout must still request BLEND");
});

test("the packer resolves uids through the converter's own resolver", async () => {
  // The pipeline used to carry a second, subtly different copy of this logic:
  // it missed Sketchfab's 32-hex filename prefix and the substring fallback, so
  // it could decline to pack a texture the converter went on to bind.
  const { resolveUidToBase, textureBasename } = await import("../lib/osgjs2gltf.js");
  assert.equal(typeof resolveUidToBase, "function", "pipeline imports this at runtime");
  assert.equal(typeof textureBasename, "function", "pipeline imports this at runtime");

  const list = [
    { name: "textures/aabbccddeeff00112233445566778899_case_metallic.jpg", uid: "M1", imageUids: [] },
    { name: "textures/case_roughness.jpg", uid: "R1", imageUids: ["R2"] },
  ];
  assert.equal(resolveUidToBase("M1", list), "case_metallic.jpg", "strips the uid prefix");
  assert.equal(resolveUidToBase("R2", list), "case_roughness.jpg", "matches via imageUids");
});

test("LUMINANCE metalness is packed, never passed through", () => {
  // Sketchfab reports the texture format. A single-channel map cannot already
  // be a packed ORM, so this outranks any filename guess.
  const spec = { metalnessUid: M_UID, metalnessFormat: "LUMINANCE" };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "case_metallic.jpg" }), classifyTextureName);
  assert.equal(plan.action, "pack");
});

test("texture format outranks an ambiguous filename", () => {
  // "arm" used to read as a packed ORM. With a reported LUMINANCE format the
  // name is never consulted, so the collision cannot resurface.
  const spec = { metalnessUid: M_UID, metalnessFormat: "LUMINANCE" };
  const plan = planOrm(
    spec,
    resolverFor({ [M_UID]: "Character_arm_ORM.png" }),
    classifyTextureName
  );
  assert.equal(plan.action, "pack", "LUMINANCE wins over an ORM-looking name");
});

test("an RGB metalness texture is a real packed ORM", () => {
  const spec = { metalnessUid: M_UID, metalnessFormat: "RGB" };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "weird_name.png" }), classifyTextureName);
  assert.equal(plan.action, "passthrough");
});

test("one texture on both channels is packed by construction", () => {
  const spec = { metalnessUid: M_UID, roughnessUid: M_UID, metalnessFormat: "RGB" };
  const plan = planOrm(spec, resolverFor({ [M_UID]: "Body_shared.png" }), classifyTextureName);
  assert.equal(plan.action, "passthrough");
  assert.equal(plan.texture, "Body_shared.png");
});

test("with no reported format the filename still decides, defaulting to pack", () => {
  const noFmt = { metalnessUid: M_UID };
  assert.equal(
    planOrm(noFmt, resolverFor({ [M_UID]: "Body_ORM.png" }), classifyTextureName).action,
    "passthrough"
  );
  assert.equal(
    planOrm(noFmt, resolverFor({ [M_UID]: "Body_metallic.png" }), classifyTextureName).action,
    "pack"
  );
});
