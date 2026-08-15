import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewerMaterials } from "../lib/sf-api.js";
import {
  classifyTextureName,
  findViewerSpec,
  chooseAlbedoName,
  shouldSkipUntexturedShell,
} from "../lib/osgjs2gltf.js";

function tex(uid, enable = true) {
  return { enable, texture: { uid } };
}

test("parseViewerMaterials uses DiffusePBR and BumpMap, not specular as albedo", () => {
  const info = {
    options: {
      materials: {
        m1: {
          name: "lambert2SG",
          channels: {
            AlbedoPBR: { enable: false, texture: { uid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
            DiffusePBR: tex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true),
            SpecularPBR: tex("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", true),
            BumpMap: tex("cccccccccccccccccccccccccccccccc", true),
            NormalMap: { enable: false, texture: { uid: "cccccccccccccccccccccccccccccccc" } },
          },
        },
      },
    },
  };
  const map = parseViewerMaterials(info);
  const spec = map.get("lambert2SG");
  assert.ok(spec);
  assert.equal(spec.albedoUid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(spec.normalUid, "cccccccccccccccccccccccccccccccc");
  assert.equal(spec.specularUid, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.notEqual(spec.albedoUid, spec.specularUid);
});

test("classifyTextureName matches NormalMap / SpecularMap substrings", () => {
  assert.equal(classifyTextureName("Archer_NormalMap.png"), "normal");
  assert.equal(classifyTextureName("Archer_SpecularMap.png"), "specular");
  assert.equal(classifyTextureName("Body_D.png"), "albedo");
});

test("findViewerSpec matches StateSet-style names", () => {
  const vm = new Map();
  vm.set("lambert2SG", { name: "lambert2SG" });
  const hit = findViewerSpec(vm, null, "lambert2SG");
  assert.ok(hit);
  assert.equal(hit.spec.name, "lambert2SG");
});

test("chooseAlbedoName promotes a large unknown specular atlas over a tiny diffuse", () => {
  const list = [
    { name: "textures/Image2.png", width: 400, height: 401, fromDescramble: false },
    { name: "textures/pant_final.png", width: 4096, height: 4096, fromDescramble: true },
  ];
  assert.equal(
    chooseAlbedoName("Image2.png", "pant_final.png", list),
    "pant_final.png"
  );
});

test("chooseAlbedoName does not steal a named SpecularMap", () => {
  const list = [
    { name: "textures/Body_D.png", width: 2048, height: 2048, fromDescramble: true },
    { name: "textures/Archer_SpecularMap.png", width: 4096, height: 4096 },
  ];
  assert.equal(
    chooseAlbedoName("Body_D.png", "Archer_SpecularMap.png", list),
    "Body_D.png"
  );
});

test("shouldSkipUntexturedShell keeps hair that has an opacity atlas", () => {
  assert.equal(
    shouldSkipUntexturedShell(
      { albedoUid: null, opacityUid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "hair:Group49590SG",
      null
    ),
    false
  );
  assert.equal(
    shouldSkipUntexturedShell(
      { albedoUid: null, opacityUid: null },
      "hair:Group49590SG",
      null
    ),
    true
  );
});

test("a visible refractive glass cover is exported, not skipped", () => {
  // vpcm2_glass_cover: opacity factor 1, type 'refraction'. The old name-based
  // /glass/i rule dropped the mesh, so the model lost its glossy screen.
  const info = {
    options: {
      materials: {
        g1: {
          name: "vpcm2_glass_cover",
          channels: {
            AlbedoPBR: tex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true),
            Opacity: { enable: true, factor: 1, type: "refraction" },
          },
        },
      },
    },
  };
  const spec = parseViewerMaterials(info).get("vpcm2_glass_cover");
  assert.equal(spec.skipMesh, false, "visible glass must survive export");
  assert.equal(spec.transmission, true, "and be marked for KHR_materials_transmission");
});

test("an invisible glass shell is still skipped", () => {
  const info = {
    options: {
      materials: {
        g1: {
          name: "window_glass",
          channels: {
            AlbedoPBR: tex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true),
            Opacity: { enable: true, factor: 0, type: "alphaBlend" },
          },
        },
      },
    },
  };
  const spec = parseViewerMaterials(info).get("window_glass");
  assert.equal(spec.skipMesh, true, "a fully transparent veil must still be dropped");
});

test("a non-refractive named glass shell is still skipped", () => {
  const info = {
    options: {
      materials: {
        g1: {
          name: "glass_rim",
          channels: {
            AlbedoPBR: tex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true),
            Opacity: { enable: true, factor: 1, type: "alphaBlend" },
          },
        },
      },
    },
  };
  const spec = parseViewerMaterials(info).get("glass_rim");
  assert.equal(spec.skipMesh, true);
});
