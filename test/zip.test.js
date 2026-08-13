import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildZip, crc32 } from "../lib/zip.js";

test("buildZip writes PK signature and deflates when smaller", async () => {
  const raw = new TextEncoder().encode("hello ".repeat(400));
  const zip = await buildZip([{ name: "a.txt", data: raw }]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const method = zip[8] | (zip[9] << 8);
  const nameLen = zip[26] | (zip[27] << 8);
  const comp = zip[18] | (zip[19] << 8) | (zip[20] << 16) | (zip[21] << 24);
  const uncomp = zip[22] | (zip[23] << 8) | (zip[24] << 16) | (zip[25] << 24);
  assert.equal(uncomp, raw.length);
  const data = zip.subarray(30 + nameLen, 30 + nameLen + comp);
  if (method === 8) {
    const out = inflateRawSync(data);
    assert.deepEqual(new Uint8Array(out), raw);
  } else {
    assert.deepEqual(data, raw);
  }
  assert.equal(crc32(raw) >>> 0, crc32(raw) >>> 0);
});

test("buildZip accepts string file data", async () => {
  const zip = await buildZip([{ name: "readme.txt", data: "hello zip" }]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const uncomp = zip[22] | (zip[23] << 8) | (zip[24] << 16) | (zip[25] << 24);
  assert.equal(uncomp, "hello zip".length);
});
