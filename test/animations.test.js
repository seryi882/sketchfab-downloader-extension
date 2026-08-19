import test from "node:test";
import assert from "node:assert/strict";
import { animationUrls, isGzip } from "../lib/sf-api.js";

test("animationUrls builds one gzip URL per clip", () => {
  const info = {
    files: [{ osgjsUrl: "https://media.sketchfab.com/models/UID/HASH/files/F/file.binz" }],
    options: { animation: { order: ["a".repeat(32), "b".repeat(32)] } },
  };
  const urls = animationUrls(info);
  assert.equal(urls.length, 2);
  assert.equal(
    urls[0].url,
    `https://media.sketchfab.com/models/UID/HASH/animations/${"a".repeat(32)}.bin.gz`
  );
  assert.equal(urls[0].uid, "a".repeat(32));
});

test("animationUrls is empty for a model with no clips", () => {
  assert.deepEqual(
    animationUrls({ files: [{ osgjsUrl: "https://x/files/y/file.binz" }], options: {} }),
    []
  );
  assert.deepEqual(animationUrls({}), []);
});

test("animationUrls ignores malformed uids and duplicates", () => {
  const info = {
    files: [{ osgjsUrl: "https://m/models/U/H/files/F/file.binz" }],
    options: { animation: { order: ["nope", "c".repeat(32), "c".repeat(32)] } },
  };
  assert.equal(animationUrls(info).length, 1);
});

test("isGzip only accepts a real gzip header", () => {
  assert.equal(isGzip(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])), true);
  // What fetch() hands back once the CDN's Content-Encoding has been honoured.
  assert.equal(isGzip(Uint8Array.from([0xf8, 0x93, 0x00, 0x01])), false);
  assert.equal(isGzip(Uint8Array.from([0x1f])), false);
  assert.equal(isGzip(null), false);
});
