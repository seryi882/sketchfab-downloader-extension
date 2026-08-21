import { test } from "node:test";
import assert from "node:assert/strict";
import { mimeFromBytes } from "../lib/osgjs2gltf.js";

const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const gif = () => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
const webp = () => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("each format is recognised by its magic bytes", () => {
  assert.equal(mimeFromBytes(png()), "image/png");
  assert.equal(mimeFromBytes(jpeg()), "image/jpeg");
  assert.equal(mimeFromBytes(gif()), "image/gif");
  assert.equal(mimeFromBytes(webp()), "image/webp");
});

test("PNG bytes under a .jpg name are still PNG", () => {
  // The actual case: 30 of the low-poly compilation's textures are named .jpg
  // and are PNG throughout, which put image/jpeg on PNG data and cost 30
  // validator errors.
  assert.equal(mimeFromBytes(png()), "image/png");
});

test("unrecognised bytes fall back to the name", () => {
  assert.equal(mimeFromBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
});

test("a truncated header is not guessed at", () => {
  assert.equal(mimeFromBytes(Uint8Array.from([0x89, 0x50, 0x4e])), null);
  assert.equal(mimeFromBytes(new Uint8Array(0)), null);
  assert.equal(mimeFromBytes(null), null);
});

test("RIFF that is not WEBP is not claimed as WEBP", () => {
  const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(mimeFromBytes(wav), null);
});
