/**
 * Browser WASM decrypt for Sketchfab .binz files.
 * Static key is auto-extracted from live viewer JS when possible.
 */

export const DEFAULT_STATIC_KEY = "7d61ef7c7530c12cf080fafd05e603d1aa3a92c6";

function parseWasmDataSize(wasmBytes) {
  let m = 65536;
  let d = 8;
  while (d < wasmBytes.length) {
    const v = () => wasmBytes[d++];
    const w = () => {
      let t = d,
        n = 0,
        e = 128;
      while (128 & e) {
        e = wasmBytes[d];
        n |= (127 & e) << (7 * (d - t));
        d++;
      }
      return n;
    };
    let y = w(),
      I = w(),
      h = d + I;
    if (y < 0 || y > 11 || I <= 0 || h > wasmBytes.length) break;
    if (6 === y) {
      w();
      v();
      v();
      w();
      let _ = w();
      w();
      m = _;
    }
    if (11 === y) {
      for (let Z = w(), A = 0; A !== Z && d < h; A++) {
        v();
        w();
        w();
        w();
        let U = w();
        d += U;
      }
    }
    d = h;
  }
  return m;
}

async function initWasm(wasmBytes) {
  const r = new Uint8Array(wasmBytes);
  const m = parseWasmDataSize(r);
  const u = 536870912;
  const g = 262144 + (((m + 65535) >> 16) << 16);
  let currentBreak = m;
  const memory = new WebAssembly.Memory({
    initial: g >> 16,
    maximum: u >> 16,
    shared: false,
  });
  let uint8View = new Uint8Array(memory.buffer);
  let uint32View = new Uint32Array(memory.buffer);
  const refreshViews = () => {
    uint8View = new Uint8Array(memory.buffer);
    uint32View = new Uint32Array(memory.buffer);
  };
  const env = {
    sbrk(increment) {
      const old = currentBreak;
      const newBreak = old + increment;
      const overflow = newBreak - memory.buffer.byteLength;
      if (overflow > 0) {
        memory.grow((overflow + 65535) >> 16);
        refreshViews();
      }
      currentBreak = newBreak;
      return old | 0;
    },
    time(t) {
      const r = (Date.now() / 1000) | 0;
      if (t) uint32View[t >> 2] = r;
      return r;
    },
    gettimeofday(t) {
      const n = Date.now();
      uint32View[t >> 2] = (n / 1000) | 0;
      uint32View[(t + 4) >> 2] = (n % 1000) * 1000;
    },
    abort() {
      throw new Error("WASM abort");
    },
    memory,
  };
  env.__lock = env.__unlock = env.setjmp = env.__cxa_atexit = function () {};
  const result = await WebAssembly.instantiate(r, { env });
  const ex = result.instance.exports;
  if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();
  return {
    a: ex,
    H: () => {
      refreshViews();
      return uint8View;
    },
  };
}

function b64ToBytes(b64) {
  const clean = String(b64).replace(/\\n/g, "").replace(/\n/g, "").replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function decryptBinzBytes(wasmBytes, encData, diterB, staticKey) {
  const wasm = await initWasm(wasmBytes);
  const a = wasm.a;
  const allocInput = a["heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl"];
  const reset = a["mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l"];
  const rickRolled = a["Umlja1JvbGxlZDRV"];
  const allocDiterB = a["dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI"];
  const process_ = a["GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW"];
  const advance = a["FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN"];
  const getInfo = a["bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg"];
  const getStart = a["TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT"];
  if (!allocInput || !reset || !rickRolled || !allocDiterB || !process_ || !advance || !getInfo || !getStart) {
    throw new Error("WASM exports missing (decrypt.wasm outdated?)");
  }

  const keyHex = (staticKey || DEFAULT_STATIC_KEY).slice(0, 40).toLowerCase();
  const seed = 1314 + Math.floor(9999 * Math.random());
  const collected = [];
  let running = seed;
  for (let i = 0; i < 10; i++) {
    const G = parseInt(keyHex.slice(4 * i, 4 * i + 4), 16);
    running ^= G;
    collected.push(G ^ seed);
    collected.push(running);
  }
  let xorAll = collected[19];
  for (let t = 0; t < 10; t++) xorAll ^= collected[2 * t];
  const keyArr = Array.from({ length: 10 }, (_, t) => collected[2 * t] ^ xorAll);
  const keyOff = rickRolled(seed, 40);
  let mem = wasm.H();
  for (let t = 0; t < 10; t++) {
    let h = keyArr[t].toString(16);
    h = "0".repeat(4 - h.length) + h;
    for (let n = 0; n < h.length; n++) mem[keyOff + n + 4 * t] = h.charCodeAt(n);
  }

  const diterBBytes = b64ToBytes(diterB);
  reset();
  const dOff = allocDiterB(diterBBytes.length);
  mem = wasm.H();
  for (let i = 0; i < diterBBytes.length; i++) mem[dOff + i] = diterBBytes[i];
  process_(0);

  const input = encData instanceof Uint8Array ? encData : new Uint8Array(encData);
  const chunks = [];
  for (let off = 0; off < input.length; off += 10240) {
    const len = Math.min(10240, input.length - off);
    const iOff = allocInput(len);
    mem = wasm.H();
    for (let i = 0; i < len; i++) mem[iOff + i] = input[off + i];
    let more = process_(1);
    while (more) {
      mem = wasm.H();
      const s = getStart();
      const e = getStart() + getInfo();
      chunks.push(mem.subarray(s, e).slice(0));
      advance();
      more = process_(0);
    }
  }
  if (!chunks.length) throw new Error("WASM produced no output");
  let total = 0;
  for (const c of chunks) total += c.length;
  let result = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    result.set(c, o);
    o += c.length;
  }
  // gunzip if needed
  if (result[0] === 0x1f && result[1] === 0x8b) {
    result = await gunzip(result);
  }
  return result;
}

async function gunzip(data) {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error("gzip decompress not supported in this browser");
}

export async function loadWasmBytes() {
  const url = chrome.runtime.getURL("lib/wasm/decrypt.wasm");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Failed to load decrypt.wasm");
  return new Uint8Array(await resp.arrayBuffer());
}

export function outNameFor(binzName) {
  if (binzName === "file.binz") return "file.osgjs";
  if (binzName === "model_file.binz") return "model_file.bin";
  if (binzName === "model_file_wireframe.binz") return "model_file_wireframe.bin";
  if (binzName.endsWith(".binz")) return binzName.slice(0, -5) + ".bin";
  return binzName + ".out";
}
