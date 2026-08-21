import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewerMaterials } from "../lib/sf-api.js";

/** Viewer info carrying one material with the given channels. */
const spec = (channels) =>
  parseViewerMaterials({ options: { materials: { m1: { name: "Mat", channels } } } }).get("Mat");

// Sketchfab declares both channel sets on every material and leaves the unused
// one at whatever default it shipped with, so the stale one has to be ignored.
const BOTH = (albedo, diffuse, metalEnabled) => ({
  AlbedoPBR: { enable: true, factor: 1, color: albedo },
  DiffuseColor: { enable: true, factor: 1, color: diffuse },
  MetalnessPBR: { enable: metalEnabled, factor: 0 },
});

test("under the metalness workflow the tint comes from AlbedoPBR", () => {
  // Sketchfab's own selector is isWorkflowMetalness() === MetalnessPBR.enable.
  // A material named "Black fabric" had AlbedoPBR [0,0,0] and a stale
  // DiffuseColor of [0.8,0.8,0.8]; reading the latter turned it grey.
  const s = spec(BOTH([0, 0, 0], [0.8, 0.8, 0.8], true));
  assert.deepEqual(s.baseColorFactor, [0, 0, 0, 1]);
});

test("under the specular workflow the tint comes from DiffuseColor", () => {
  const s = spec(BOTH([0, 0, 0], [0.8, 0.8, 0.8], false));
  assert.deepEqual(s.baseColorFactor, [0.8, 0.8, 0.8, 1]);
});

test("a disabled channel is skipped in favour of the next", () => {
  const s = spec({
    AlbedoPBR: { enable: false, color: [0, 0, 0] },
    DiffuseColor: { enable: true, color: [0.25, 0.5, 0.75] },
    MetalnessPBR: { enable: true, factor: 0 },
  });
  assert.deepEqual(s.baseColorFactor, [0.25, 0.5, 0.75, 1]);
});

test("a channel carrying no colour falls through", () => {
  const s = spec({
    AlbedoPBR: { enable: true, factor: 1 },
    DiffuseColor: { enable: true, color: [0.1, 0.2, 0.3] },
    MetalnessPBR: { enable: true, factor: 0 },
  });
  assert.deepEqual(s.baseColorFactor, [0.1, 0.2, 0.3, 1]);
});

test("white is the fallback when neither channel says anything", () => {
  assert.deepEqual(spec({ MetalnessPBR: { enable: true } }).baseColorFactor, [1, 1, 1, 1]);
  assert.deepEqual(spec({}).baseColorFactor, [1, 1, 1, 1]);
});

test("both workflows agree when the two channels agree", () => {
  // The common case, and why this went unnoticed: most materials set both.
  for (const metal of [true, false]) {
    assert.deepEqual(spec(BOTH([0.4, 0.4, 0.4], [0.4, 0.4, 0.4], metal)).baseColorFactor,
      [0.4, 0.4, 0.4, 1]);
  }
});
