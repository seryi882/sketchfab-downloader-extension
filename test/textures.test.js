import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBestImage } from "../lib/sf-api.js";

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
