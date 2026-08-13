/**
 * Page-world viewer inject (v1.6).
 *
 * Sketchfab unscrambles protected textures in a fullscreen GPU blit:
 *   g.renderInto = function(e,i,r){ gl.drawArrays(gl.TRIANGLES, 0, 6) }
 * called while an FBO of size (image.width, image.height) is bound.
 *
 * We rewrite that viewer bundle BEFORE it runs and readPixels immediately
 * after the blit. No login / Download API.
 *
 * Protocol (same as before, source: sf-dl-hook):
 *   → sf-tex-dump | sf-tex-ping | sf-tex-clear
 *   ← sf-tex-status { count, decoded, patches }
 *   ← sf-tex-event { event:'capture', detail }
 *   ← sf-tex-dump-item { capture: { dataBase64, uid, name, ... } }
 *   ← sf-tex-dump-done { count, bytes, patches }
 */
(function () {
  if (window.__sfViewerInjectInstalled) return;
  window.__sfViewerInjectInstalled = true;

  const MIN = 128;
  const MAX_DIM = 4096;
  const MAX_STORE = 80;
  const MAX_PENDING = 40;
  const MAX_SIDE = 2048;
  const MAX_DUMP_BYTES = 32 * 1024 * 1024;

  /** @type {Map<string, object>} */
  const store = new Map();
  const pending = [];
  let pumpBusy = false;
  let dumpInFlight = false;
  const patchLog = [];
  let patchedBundles = 0;
  const uploadedUids = new Set();

  function log(...a) {
    try {
      console.debug("[sf-dl-inject]", ...a);
    } catch (_) {}
  }

  function emit(payload) {
    try {
      window.postMessage(payload, "*");
    } catch (_) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
    } catch (_) {}
  }

  function allHex32(url) {
    if (!url) return [];
    const out = [];
    const re = /[a-f0-9]{32}/gi;
    let m;
    while ((m = re.exec(String(url)))) {
      const id = m[0].toLowerCase();
      if (out.indexOf(id) === -1) out.push(id);
    }
    return out;
  }

  function uidFromUrl(url) {
    const ids = allHex32(url);
    if (!ids.length) return null;
    const fileId = fileUidFromUrl(url);
    // …/{modelUid}/{mid}/{setUid}/{imageUid}.jpeg — set uid is last folder, not file
    for (let i = ids.length - 1; i >= 0; i--) {
      if (ids[i] !== fileId) return ids[i];
    }
    return ids[ids.length - 1];
  }

  function fileUidFromUrl(url) {
    if (!url) return null;
    try {
      const base = (new URL(url, location.href).pathname.split("/").pop() || "")
        .split("?")[0]
        .toLowerCase();
      const stem = base.replace(/\.(png|jpe?g|webp|gif)$/i, "");
      return /^[a-f0-9]{32}$/.test(stem) ? stem : null;
    } catch {
      return null;
    }
  }

  function isTextureUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!/sketchfab\.com|media\.sketchfab/i.test(url)) return false;
    return /\/textures?\//i.test(url) || /\/[a-f0-9]{32}\.(png|jpe?g|webp)/i.test(url);
  }

  function nameFromUrl(url) {
    if (!url) return null;
    try {
      return (new URL(url, location.href).pathname.split("/").pop() || "").split(
        "?"
      )[0];
    } catch {
      return null;
    }
  }

  function looksScrambled(rgba, w, h) {
    if (!rgba || w < 32 || h < 32) return false;
    let sum = 0,
      sum2 = 0,
      n = 0;
    const sw = Math.min(w, 96);
    const sh = Math.min(h, 96);
    for (let y = 0; y < sh; y += 3) {
      for (let x = 0; x < sw; x += 3) {
        const i = (y * w + x) * 4;
        if (i + 2 >= rgba.length) continue;
        const v = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
        sum += v;
        sum2 += v * v;
        n++;
      }
    }
    if (n < 30) return false;
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    return variance < 150 && mean > 10 && mean < 230;
  }

  function flipY(src, w, h) {
    const out = new Uint8Array(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      out.set(src.subarray(y * row, y * row + row), (h - 1 - y) * row);
    }
    return out;
  }

  function storeKey(meta) {
    return (
      (meta.uid && "uid:" + meta.uid) ||
      (meta.name && "name:" + String(meta.name).toLowerCase()) ||
      "sz:" + meta.width + "x" + meta.height + ":" + (meta.sha || meta.from)
    );
  }

  function notifyStatus() {
    const uids = [];
    for (const c of store.values()) {
      if (c.uid) uids.push(c.uid);
    }
    emit({
      source: "sf-dl-hook",
      type: "sf-tex-status",
      count: store.size,
      decoded: store.size,
      pending: pending.length,
      uids,
      uploadedUids: [...uploadedUids],
      patches: patchLog.slice(),
      patchedBundles,
      ready: true,
      kind: "blit",
      frame: (location.pathname || "").slice(0, 80),
    });
  }

  function toBase64(u8) {
    const CHUNK = 0x8000;
    let s = "";
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(
        null,
        u8.subarray(i, Math.min(i + CHUNK, u8.length))
      );
    }
    return btoa(s);
  }

  async function encodeRgba(rgba, w, h) {
    let tw = w,
      th = h;
    if (tw > MAX_SIDE || th > MAX_SIDE) {
      const s = MAX_SIDE / Math.max(tw, th);
      tw = Math.max(1, (tw * s) | 0);
      th = Math.max(1, (th * s) | 0);
    }
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (tw === w && th === h) {
      const img = ctx.createImageData(w, h);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    } else {
      const full = document.createElement("canvas");
      full.width = w;
      full.height = h;
      const fctx = full.getContext("2d");
      const img = fctx.createImageData(w, h);
      img.data.set(rgba);
      fctx.putImageData(img, 0, 0);
      ctx.drawImage(full, 0, 0, tw, th);
    }
    const mime = tw * th >= 512 * 512 ? "image/jpeg" : "image/png";
    const blob = await new Promise((res, rej) => {
      try {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("blob"))), mime, 0.92);
      } catch (e) {
        rej(e);
      }
    });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: tw,
      height: th,
      mime,
    };
  }

  async function pumpEncode() {
    if (pumpBusy) return;
    pumpBusy = true;
    while (pending.length) {
      const job = pending.shift();
      try {
        const enc = await encodeRgba(job.rgba, job.w, job.h);
        job.rgba = null;
        const key = storeKey({
          uid: job.uid,
          name: job.name,
          width: enc.width,
          height: enc.height,
          from: "viewer-blit",
        });
        const prev = store.get(key);
        const b64 = toBase64(enc.bytes);
        if (store.size >= MAX_STORE && !store.has(key)) {
          const first = store.keys().next().value;
          store.delete(first);
        }
        // Keep overwritten pixels (Body_D used to vanish when the next 2048 reused lastImg)
        if (prev && prev.dataBase64 && prev.dataBase64 !== b64) {
          store.set(
            "orphan:" + Date.now() + ":" + (prev.byteLength || 0),
            prev
          );
        }
        store.set(key, {
            uid: job.uid,
            name: job.name,
            url: job.url,
            width: enc.width,
            height: enc.height,
            from: "viewer-blit",
            scrambledHint: !!job.scrambled,
            mime: enc.mime,
            byteLength: enc.bytes.length,
            dataBase64: b64,
          });
          emit({
            source: "sf-dl-hook",
            type: "sf-tex-event",
            event: "capture",
            detail: {
              uid: job.uid,
              name: job.name,
              width: enc.width,
              height: enc.height,
              from: "viewer-blit",
              kind: "blit",
              scrambled: !!job.scrambled,
              count: store.size,
            },
          });
          notifyStatus();
      } catch (e) {
        log("encode fail", e);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    pumpBusy = false;
  }

  /**
   * Called from patched viewer after decode blit. FBO still bound.
   * Signatures:
   *   (gl, destTex, w, h)
   *   (gl, destTex, w, h, htmlImage)
   */
  window.__sfOnDecodeBlit = function (gl, a, b, c, d) {
    try {
      if (!gl || typeof gl.readPixels !== "function") return;
      let w = 0,
        h = 0,
        img = null;
      if (d && typeof d === "object" && (d.src || d.naturalWidth || d.width)) {
        img = d;
        w = b | 0;
        h = c | 0;
      } else {
        w = b | 0;
        h = c | 0;
      }
      if (!w || !h) {
        const vp = gl.getParameter(gl.VIEWPORT);
        w = vp[2] | 0;
        h = vp[3] | 0;
      }
      if (w < MIN || h < MIN || w > MAX_DIM || h > MAX_DIM) return;
      if (pending.length >= MAX_PENDING) return;

      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // Do not flip: official Sketchfab PNGs match raw readPixels (Y-up FBO).
      // An extra flip made every blit upside-down in Blender.
      const rgba = pixels;
      const scrambled = looksScrambled(rgba, w, h);

      const url = img && (img.src || img.currentSrc);
      const uid = uidFromUrl(url);
      let name = nameFromUrl(url);
      if (img && img.__sfName) name = img.__sfName;
      const fileUid = fileUidFromUrl(url);

      pending.push({
        rgba,
        w,
        h,
        uid: uid || fileUid,
        name,
        url,
        scrambled,
      });
      pumpEncode();
    } catch (e) {
      log("blit fail", e);
    }
  };

  /**
   * Primary capture path (no bundle rewrite / no blob: CSP):
   * after drawArrays(TRIANGLES,0,6) into an FBO the size of a texture.
   * Viewer decode pass does exactly that. Installed on the prototype at
   * document_start (MAIN world) so it exists before the first getContext.
   */
  /**
   * FIFO of HTMLImages per resolution. Same-size maps (many 2048 albedos)
   * decode sequentially: texImage2D(img) then drawArrays(6).
   * A single "last image" overwrites Body with Equip and Body_D never lands.
   */
  const imgQueueBySize = new Map();

  function imageFromTexArgs(args) {
    let src = null;
    if (args.length === 6) src = args[5];
    else if (args.length >= 9) src = args[args.length - 1];
    if (!src || typeof src !== "object") return null;
    if (src.src || src.currentSrc || src.naturalWidth || src.width) return src;
    return null;
  }

  function enqueueImg(src) {
    if (!src) return;
    const url = src.src || src.currentSrc || "";
    // Skip UI/icons — they would desync the FIFO from decode blits
    if (!isTextureUrl(url)) return;
    const iw = src.naturalWidth || src.width || 0;
    const ih = src.naturalHeight || src.height || 0;
    if (!iw || !ih) return;
    const k = iw + "x" + ih;
    let q = imgQueueBySize.get(k);
    if (!q) {
      q = [];
      imgQueueBySize.set(k, q);
    }
    q.push(src);
    const setUid = uidFromUrl(url);
    if (setUid) uploadedUids.add(setUid);
    emit({
      source: "sf-dl-hook",
      type: "sf-tex-event",
      event: "upload",
      detail: {
        uid: setUid,
        name: nameFromUrl(url),
        width: iw,
        height: ih,
        from: "texImage2D",
        kind: "upload",
        count: store.size,
      },
    });
  }

  function takeImgForSize(w, h) {
    const k = w + "x" + h;
    const q = imgQueueBySize.get(k);
    if (q && q.length) return q.shift();
    return null;
  }

  function isPow2(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  function maybeBlit(gl) {
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (!fb) return;
    const vp = gl.getParameter(gl.VIEWPORT);
    const w = vp[2] | 0;
    const h = vp[3] | 0;
    if (w < MIN || h < MIN || w > MAX_DIM || h > MAX_DIM) return;
    const img = takeImgForSize(w, h);
    if (!img && !(isPow2(w) && isPow2(h))) return;
    // Never pass a stale image of a different size — that stole Body_D's slot
    window.__sfOnDecodeBlit(gl, null, w, h, img);
  }

  function hookDrawProto(proto, label) {
    if (!proto || proto.__sfDrawBlit) return;
    proto.__sfDrawBlit = true;

    const oTex = proto.texImage2D;
    if (typeof oTex === "function") {
      proto.texImage2D = function (...args) {
        try {
          enqueueImg(imageFromTexArgs(args));
        } catch (_) {}
        return oTex.apply(this, args);
      };
    }

    const oComp = proto.compressedTexImage2D;
    if (typeof oComp === "function") {
      proto.compressedTexImage2D = function (...args) {
        try {
          enqueueImg(imageFromTexArgs(args));
        } catch (_) {}
        return oComp.apply(this, args);
      };
    }

    const oDraw = proto.drawArrays;
    if (typeof oDraw === "function") {
      proto.drawArrays = function (mode, first, count) {
        const ret = oDraw.apply(this, arguments);
        try {
          if ((count | 0) === 6 && (first | 0) === 0 && (mode === this.TRIANGLES || mode === 4)) {
            maybeBlit(this);
          }
        } catch (_) {}
        return ret;
      };
    }

    const oDrawE = proto.drawElements;
    if (typeof oDrawE === "function") {
      proto.drawElements = function (mode, count) {
        const ret = oDrawE.apply(this, arguments);
        try {
          if ((count | 0) === 6 && (mode === this.TRIANGLES || mode === 4)) {
            maybeBlit(this);
          }
        } catch (_) {}
        return ret;
      };
    }

    const oBlit = proto.blitFramebuffer;
    if (typeof oBlit === "function") {
      proto.blitFramebuffer = function () {
        const ret = oBlit.apply(this, arguments);
        try {
          maybeBlit(this);
        } catch (_) {}
        return ret;
      };
    }
  }

  if (window.WebGLRenderingContext) {
    hookDrawProto(WebGLRenderingContext.prototype, "webgl");
  }
  if (window.WebGL2RenderingContext) {
    hookDrawProto(WebGL2RenderingContext.prototype, "webgl2");
  }
  patchLog.push("drawArrays-hook");

  // ---- Optional: rewrite viewer JS for extra naming (may fail CSP) ----
  function isViewerUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) return false;
    return (
      /static\.sketchfab\.com\/static\/builds\/web\/dist\/.+\.js/i.test(url) ||
      /standaloneViewer/i.test(url)
    );
  }

  function applyPatches(src) {
    if (!src || src.length < 200) return { text: src, hits: [] };
    let text = src;
    const hits = [];

    const rules = [
      {
        id: "renderInto-body",
        re: /(\w)\.renderInto=function\((\w+),(\w+),(\w+)\)\{(\w+)\.drawArrays\(\5\.TRIANGLES,0,6\)\}/g,
        repl:
          '$1.renderInto=function($2,$3,$4){$5.drawArrays($5.TRIANGLES,0,6);try{window.__sfOnDecodeBlit&&window.__sfOnDecodeBlit($5,$2,$3,$4)}catch(__sf){}}',
      },
      {
        // Inside (prepare(), renderInto(), deleteFbo()) comma chain — must stay an expression
        id: "renderInto-call-image",
        re: /(\w)\.renderInto\((\w+),(\w+),(\w+),\2,\3,\4\)/g,
        repl:
          '$1.renderInto($2,$3,$4,$2,$3,$4),(window.__sfOnDecodeBlit&&window.__sfOnDecodeBlit(t,$2,$3,$4,x))',
      },
      // looser: any drawArrays(TRIANGLES,0,6) after renderInto=
      {
        id: "draw-6-generic",
        re: /(\.renderInto=function\([^)]*\)\{)([^}]*?)(\w+)\.drawArrays\(\3\.TRIANGLES,0,6\)/g,
        repl:
          '$1$2$3.drawArrays($3.TRIANGLES,0,6);try{window.__sfOnDecodeBlit&&window.__sfOnDecodeBlit($3)}catch(__sf){}',
      },
    ];

    for (const rule of rules) {
      if (rule.id === "draw-6-generic" && hits.indexOf("renderInto-body") >= 0) {
        continue;
      }
      rule.re.lastIndex = 0;
      if (!rule.re.test(text)) continue;
      rule.re.lastIndex = 0;
      const next = text.replace(rule.re, rule.repl);
      if (next !== text) {
        text = next;
        hits.push(rule.id);
      }
    }
    return { text, hits };
  }

  function rewriteScriptUrl(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send(null);
      if (xhr.status !== 200 || !xhr.responseText) return null;
      const { text, hits } = applyPatches(xhr.responseText);
      if (!hits.length) {
        log("no patches for", url.split("/").pop());
        return null;
      }
      patchedBundles++;
      for (const h of hits) {
        if (patchLog.indexOf(h) === -1) patchLog.push(h);
      }
      log("patched", url.split("/").pop(), hits);
      emit({
        source: "sf-dl-hook",
        type: "sf-tex-event",
        event: "patched",
        detail: { file: url.split("/").pop(), hits, count: store.size },
      });
      notifyStatus();
      const blob = new Blob([text], { type: "application/javascript" });
      return URL.createObjectURL(blob);
    } catch (e) {
      log("rewrite fail", url, e);
      return null;
    }
  }

  try {
    const proto = HTMLScriptElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (desc && desc.set && desc.get) {
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return desc.get.call(this);
        },
        set: function (v) {
          const url = String(v || "");
          if (isViewerUrl(url) && !this.dataset.sfPatched) {
            const blobUrl = rewriteScriptUrl(url);
            if (blobUrl) {
              this.dataset.sfPatched = "1";
              this.dataset.sfOrig = url;
              return desc.set.call(this, blobUrl);
            }
          }
          return desc.set.call(this, v);
        },
      });
    }
  } catch (e) {
    log("src hook fail", e);
  }

  // Catch createElement('script') + setAttribute('src')
  try {
    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (
        this.tagName === "SCRIPT" &&
        String(name).toLowerCase() === "src" &&
        isViewerUrl(String(value || "")) &&
        !this.dataset.sfPatched
      ) {
        const blobUrl = rewriteScriptUrl(String(value));
        if (blobUrl) {
          this.dataset.sfPatched = "1";
          this.dataset.sfOrig = String(value);
          return origSetAttr.call(this, name, blobUrl);
        }
      }
      return origSetAttr.apply(this, arguments);
    };
  } catch (e) {
    log("setAttribute hook fail", e);
  }

  // ---- dump API ----
  function dumpAll() {
    if (dumpInFlight) {
      emit({
        source: "sf-dl-hook",
        type: "sf-tex-dump-done",
        count: 0,
        busy: true,
        patches: patchLog.slice(),
      });
      return;
    }
    dumpInFlight = true;
    const waitEncode = () =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          if (!pumpBusy && pending.length === 0) {
            resolve();
            return;
          }
          if (Date.now() - t0 > 12000) {
            resolve();
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });

    waitEncode().then(() => {
      let sent = 0;
      let sentBytes = 0;
      const items = [...store.values()].sort((a, b) => {
        const sa = (a.scrambledHint ? 0 : 100) + (a.uid ? 20 : 0);
        const sb = (b.scrambledHint ? 0 : 100) + (b.uid ? 20 : 0);
        return sb - sa;
      });
      for (const c of items) {
        if (!c.dataBase64 || c.dataBase64.length < 32) continue;
        // Keep named/uid maps even if variance heuristic is unsure (normals look "flat")
        if (c.scrambledHint && !c.uid && !c.name && sent >= 2) continue;
        if (sentBytes + (c.byteLength || 0) > MAX_DUMP_BYTES) break;
        emit({
          source: "sf-dl-hook",
          type: "sf-tex-dump-item",
          capture: {
            uid: c.uid || null,
            name: c.name || null,
            url: c.url || null,
            width: c.width || 0,
            height: c.height || 0,
            from: "viewer-blit",
            scrambledHint: !!c.scrambledHint,
            mime: c.mime || "image/jpeg",
            byteLength: c.byteLength || 0,
            dataBase64: c.dataBase64,
            pngBase64: c.dataBase64,
          },
        });
        sent++;
        sentBytes += c.byteLength || 0;
      }
      dumpInFlight = false;
      emit({
        source: "sf-dl-hook",
        type: "sf-tex-dump-done",
        count: sent,
        bytes: sentBytes,
        patches: patchLog.slice(),
        patchedBundles,
        stored: store.size,
      });
    });
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== "sf-dl-hook") return;
    if (
      d.type === "sf-tex-dump-item" ||
      d.type === "sf-tex-dump-done" ||
      d.type === "sf-tex-status" ||
      d.type === "sf-tex-event"
    ) {
      return;
    }
    if (d.type === "sf-tex-ping") {
      notifyStatus();
      return;
    }
    if (d.type === "sf-tex-clear") {
      store.clear();
      notifyStatus();
      return;
    }
    if (d.type === "sf-tex-dump") {
      dumpAll();
    }
  });

  notifyStatus();
  log("installed viewer-inject", location.href);
})();
