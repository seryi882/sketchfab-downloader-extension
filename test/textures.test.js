import { test } from "node:test";
import assert from "node:assert/strict";
import { isDescramblable, pickBestImage } from "../lib/sf-api.js";

function im(w, h, extra = {}) {
  return { width: w, height: h, url: `${w}.jpg`, size: w * h, ...extra };
}

test("no maxEdge keeps the largest map", () => {
  const best = pickBestImage([im(512, 512), im(2048, 2048), im(8192, 8192)]);
  assert.equal(best.width, 8192);
});

test("explicit 2048 picks 2048 when present", () => {
  const best = pickBestImage(
    [im(512, 512), im(2048, 2048), im(8192, 8192)],
    2048
  );
  assert.equal(best.width, 2048);
});

test("explicit 2048 with only larger maps picks the smallest larger", () => {
  const best = pickBestImage([im(4096, 4096), im(8192, 8192)], 2048);
  assert.equal(best.width, 4096);
});

test("garbage maxEdge does not downscale", () => {
  const best = pickBestImage([im(512, 512), im(8192, 8192)], "nope");
  assert.equal(best.width, 8192);
});

test("explicit 4096 picks 4096 when present", () => {
  const best = pickBestImage(
    [im(2048, 2048), im(4096, 4096), im(8192, 8192)],
    4096
  );
  assert.equal(best.width, 4096);
});

test("same resolution prefers PNG over JPEG", () => {
  const best = pickBestImage([
    im(2048, 2048, { url: "a.jpg", size: 900000 }),
    im(2048, 2048, { url: "a.png", size: 800000 }),
  ]);
  assert.ok(best.url.endsWith(".png"));
});

// --- texture protection: only power-of-two variants can be descrambled ---

test("a protected map that is not power-of-two loses to one that is", () => {
  const best = pickBestImage([
    { width: 800, height: 100, url: "orig.png", size: 12510, pk: 46634 },
    { width: 512, height: 64, url: "pot.png", size: 23906, pk: 46634 },
  ]);
  assert.equal(best.width, 512);
});

test("the raw original is skipped even when it is a multiple of 8", () => {
  // 1600x200 and 8000x1000 are both 8px-aligned but neither is power-of-two,
  // and neither descrambles.
  assert.equal(pickBestImage([
    { width: 1600, height: 200, url: "a.png", size: 10, pk: 7 },
    { width: 1024, height: 128, url: "b.png", size: 10, pk: 7 },
  ]).width, 1024);
  assert.equal(pickBestImage([
    { width: 8000, height: 1000, url: "a.png", size: 10, pk: 7 },
    { width: 4096, height: 512, url: "b.png", size: 10, pk: 7 },
  ]).width, 4096);
});

test("unprotected maps are kept whatever their size", () => {
  const best = pickBestImage([
    { width: 800, height: 100, url: "big.png", size: 100, pk: null },
    { width: 512, height: 64, url: "small.png", size: 100, pk: null },
  ]);
  assert.equal(best.width, 800);
});

test("all-unusable protected maps still return the largest rather than nothing", () => {
  const best = pickBestImage([
    { width: 800, height: 100, url: "a.png", size: 10, pk: 1 },
    { width: 400, height: 50, url: "b.png", size: 10, pk: 1 },
  ]);
  assert.equal(best.width, 800);
});

test("a texture-level key still protects variants that omit their own", () => {
  const best = pickBestImage(
    [
      { width: 800, height: 100, url: "big.png", size: 10 },
      { width: 512, height: 64, url: "small.png", size: 10 },
    ],
    0,
    46634
  );
  assert.equal(best.width, 512);
});

test("maxEdge still applies within the descramblable maps", () => {
  const best = pickBestImage(
    [
      { width: 4096, height: 512, url: "a.png", size: 10, pk: 7 },
      { width: 2048, height: 256, url: "b.png", size: 10, pk: 7 },
      { width: 512, height: 64, url: "c.png", size: 10, pk: 7 },
    ],
    2048
  );
  assert.equal(best.width, 2048);
});

test("isDescramblable accepts only power-of-two protected maps", () => {
  assert.equal(isDescramblable({ width: 2048, height: 256, pk: 5 }), true);
  assert.equal(isDescramblable({ width: 4096, height: 512, pk: 5 }), true);
  assert.equal(isDescramblable({ width: 8000, height: 1000, pk: 5 }), false);
  assert.equal(isDescramblable({ width: 1600, height: 200, pk: 5 }), false);
  assert.equal(isDescramblable({ width: 800, height: 100, pk: 5 }), false);
  assert.equal(isDescramblable({ width: 1600, height: 201, pk: 5 }), false);
  // no key means it was never scrambled, so size does not matter
  assert.equal(isDescramblable({ width: 800, height: 100, pk: null }), true);
});
