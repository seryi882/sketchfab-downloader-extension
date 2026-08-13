import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewerMaterials } from "../lib/sf-api.js";
import { classifyTextureName, findViewerSpec } from "../lib/osgjs2gltf.js";

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
