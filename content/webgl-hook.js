/**
 * Page-world WebGL texture capture (v3).
 *
 * Goal: dump GPU texture pixels after the viewer has uploaded them.
 * Protected models: CDN files are diagonal noise; GPU may hold clean or
 * still-scrambled maps. We dump ALL large TEXTURE_2D targets, score them,
 * and prefer non-scrambled. Naming via URL uid / prefetched catalog / size.
 *
 * Protocol:
 *   → sf-tex-dump | sf-tex-ping | sf-tex-clear
 *   ← sf-tex-dump-item { capture: { dataBase64|data, ... } }
 *   ← sf-tex-dump-done { count, bytes, stats }
 *   ← sf-tex-status { count, ready }
 */
(function () {
  if (window.__sfTexHookInstalled) return;
  window.__sfTexHookInstalled = true;

  const MIN = 128;
  const MAX_DIM = 4096;
  const MAX_DUMP = 32;
  const MAX_DUMP_BYTES = 32 * 1024 * 1024;
  const MAX_SIDE = 2048;

  /** @type {Map<WebGLTexture, object>} */
  const meta = new WeakMap();
  /** Strong refs so deleteTexture cannot free before dump */
  const list = [];
  let seq = 0;
  let lastBound = null;
  let lastNamed = null;
  let dumpInFlight = false;
  /** @type {Map<string,{name:string,width?:number,height?:number}>} */
  const catalog = new Map();
  let lastStatus = -1;

  /** Decoded FBO snapshots from fullscreen passes */
  const fboSnaps = [];

  function log(...a) {
    try {
      console.debug("[sf-dl-hook]", ...a);
    } catch (_) {}
  }

  function isPow2(n) {
    return n > 0 && (n & (n - 1)) === 0;
  }

  function interesting(w, h) {
    return w >= MIN && h >= MIN && w <= MAX_DIM && h <= MAX_DIM;
  }

  function uidFromUrl(url) {
    if (!url) return null;
    const m =
      String(url).match(/\/textures\/([a-f0-9]{32})\//i) ||
      String(url).match(/\/([a-f0-9]{32})_[^/]+\./i) ||
      String(url).match(/\/([a-f0-9]{32})\//i);
    return m ? m[1].toLowerCase() : null;
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

  function isTextureUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!/sketchfab\.com|media\.sketchfab/i.test(url)) return false;
    return /\/textures?\//i.test(url) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
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

  function getMeta(tex) {
    if (!tex) return null;
    let m = meta.get(tex);
    if (!m) {
      m = {
        id: seq++,
        gl: null,
        w: 0,
        h: 0,
        src: null,
        uid: null,
        name: null,
        hasSrc: false,
        hasPixels: false,
        from: "",
        uploads: 0,
      };
      meta.set(tex, m);
      list.push(tex);
    }
    return m;
  }

  function loadCatalog() {
    try {
      const pd = window.prefetchedData;
      if (pd && typeof pd === "object") {
        for (const k of Object.keys(pd)) {
          if (!/texture/i.test(k)) continue;
          for (const tex of (pd[k] && pd[k].results) || []) {
            if (!tex || !tex.uid) continue;
            const uid = String(tex.uid).toLowerCase();
            catalog.set(uid, { name: tex.name || "", width: 0, height: 0 });
            for (const im of tex.images || []) {
              if (!im) continue;
              if (im.uid) {
                catalog.set(String(im.uid).toLowerCase(), {
                  name: tex.name || "",
                  width: im.width || 0,
                  height: im.height || 0,
                });
              }
            }
          }
        }
      }
    } catch (_) {}
    try {
      const el = document.querySelector("#js-dom-data-prefetched-data");
      if (!el) return;
      let raw = (el.innerHTML || el.textContent || "")
        .replace(/^[\s\S]*?<!--/, "")
        .replace(/-->[\s\S]*$/, "")
        .replace(/&#34;/g, '"')
        .replace(/&quot;/g, '"');
      const data = JSON.parse(raw);
      for (const k of Object.keys(data)) {
        if (!/texture/i.test(k)) continue;
        for (const tex of (data[k] && data[k].results) || []) {
          if (tex && tex.uid) {
            catalog.set(String(tex.uid).toLowerCase(), {
              name: tex.name || "",
            });
          }
        }
      }
    } catch (_) {}
  }

  function resolveName(uid, url) {
    if (uid && catalog.has(uid) && catalog.get(uid).name) {
      return catalog.get(uid).name;
    }
    return nameFromUrl(url);
  }

  function countReady() {
    let n = 0;
    for (const t of list) {
      const m = meta.get(t);
      if (m && interesting(m.w, m.h)) n++;
    }
    return n + fboSnaps.length;
  }

  function notifyStatus(force) {
    const count = countReady();
    if (!force && count === lastStatus) return;
    lastStatus = count;
    emit({
      source: "sf-dl-hook",
      type: "sf-tex-status",
      count,
      decoded: count,
      ready: true,
      frame: (location.pathname || "").slice(0, 80),
      catalog: catalog.size,
    });
  }

  function looksScrambled(rgba, w, h) {
    if (!rgba || w < 32 || h < 32) return false;
    let sum = 0,
      sum2 = 0,
      n = 0;
    const sw = Math.min(w, 96);
    const sh = Math.min(h, 96);
    // sample a grid
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
    // Stripe noise on Hulk Body_D: var ~25; real photos usually >> 200
    return variance < 150 && mean > 10 && mean < 230;
  }

  function parseArgs(args) {
    if (args.length === 6) {
      const source = args[5];
      const w =
        (source && (source.naturalWidth || source.videoWidth || source.width)) ||
        0;
      const h =
        (source &&
          (source.naturalHeight || source.videoHeight || source.height)) ||
        0;
      const src = source && (source.src || source.currentSrc || null);
      return {
        level: args[1] | 0,
        target: args[0],
        w,
        h,
        src,
        source,
        pixelUpload: !src && !!source,
      };
    }
    if (args.length >= 9) {
      return {
        level: args[1] | 0,
        target: args[0],
        w: args[3] | 0,
        h: args[4] | 0,
        src: null,
        source: null,
        pixelUpload: true,
      };
    }
    return { level: 0, target: args[0], w: 0, h: 0 };
  }

  function hookGL(proto, label) {
    if (!proto || proto.__sfV3) return;
    proto.__sfV3 = true;

    const oCreate = proto.createTexture;
    const oBind = proto.bindTexture;
    const oDel = proto.deleteTexture;
    const oTex = proto.texImage2D;
    const oSub = proto.texSubImage2D;
    const oDrawA = proto.drawArrays;
    const oDrawE = proto.drawElements;

    if (typeof oCreate === "function") {
      proto.createTexture = function () {
        const t = oCreate.apply(this, arguments);
        const m = getMeta(t);
        m.gl = this;
        m.from = label;
        return t;
      };
    }

    if (typeof oBind === "function") {
      proto.bindTexture = function (target, texture) {
        if (texture) {
          const m = getMeta(texture);
          m.gl = this;
          m.target = target;
          lastBound = texture;
        }
        return oBind.apply(this, arguments);
      };
    }

    if (typeof oDel === "function") {
      proto.deleteTexture = function (texture) {
        if (texture && meta.has(texture)) {
          // soft-delete: keep for dump
          return;
        }
        return oDel.apply(this, arguments);
      };
    }

    if (typeof oTex === "function") {
      proto.texImage2D = function (...args) {
        try {
          const p = parseArgs(args);
          const tex =
            this.getParameter(this.TEXTURE_BINDING_2D) ||
            this.getParameter(this.TEXTURE_BINDING_CUBE_MAP) ||
            lastBound;
          if (tex && p.level === 0 && interesting(p.w, p.h)) {
            const m = getMeta(tex);
            m.gl = this;
            m.w = p.w;
            m.h = p.h;
            m.uploads++;
            if (p.src && isTextureUrl(p.src)) {
              m.hasSrc = true;
              m.src = p.src;
              m.uid = uidFromUrl(p.src);
              m.name = resolveName(m.uid, p.src);
              lastNamed = tex;
            } else if (p.pixelUpload) {
              m.hasPixels = true;
              if (lastNamed) {
                const nm = meta.get(lastNamed);
                if (nm) {
                  m.uid = m.uid || nm.uid;
                  m.name = m.name || nm.name;
                  m.src = m.src || nm.src;
                }
              }
            }
            emit({
              source: "sf-dl-hook",
              type: "sf-tex-event",
              event: "capture",
              detail: {
                uid: m.uid,
                name: m.name,
                width: m.w,
                height: m.h,
                from: m.hasPixels ? "pixels-" + label : "tex-" + label,
                kind: m.hasPixels ? "decoded" : "upload",
                count: countReady(),
              },
            });
            notifyStatus(true);
          }
        } catch (e) {
          log("texImage2D", e);
        }
        return oTex.apply(this, args);
      };
    }

    if (typeof oSub === "function") {
      proto.texSubImage2D = function (...args) {
        try {
          const tex =
            this.getParameter(this.TEXTURE_BINDING_2D) || lastBound;
          if (tex && (args[1] | 0) === 0) {
            const m = getMeta(tex);
            m.gl = this;
            if (args.length === 7 && args[6]) {
              const s = args[6];
              const url = s.src || s.currentSrc;
              if (url && isTextureUrl(url)) {
                m.hasSrc = true;
                m.src = url;
                m.uid = uidFromUrl(url);
                m.name = resolveName(m.uid, url);
                m.w = s.naturalWidth || s.width || m.w;
                m.h = s.naturalHeight || s.height || m.h;
                lastNamed = tex;
              } else {
                m.hasPixels = true;
              }
            } else if (args.length >= 9) {
              m.hasPixels = true;
              if (!m.w) m.w = args[4] | 0;
              if (!m.h) m.h = args[5] | 0;
            }
          }
        } catch (_) {}
        return oSub.apply(this, args);
      };
    }

    // After fullscreen GPU blit, snapshot FBO (common texture resolve path)
    const wrapDraw = (orig, name) => {
      if (typeof orig !== "function") return orig;
      return function (...args) {
        const ret = orig.apply(this, args);
        try {
          let count = 0;
          if (name === "drawArrays") count = args[2] | 0;
          else count = args[1] | 0;
          if (count !== 3 && count !== 4 && count !== 6) return ret;
          const fb = this.getParameter(this.FRAMEBUFFER_BINDING);
          if (!fb) return ret; // skip default canvas present
          const vp = this.getParameter(this.VIEWPORT);
          const w = vp[2] | 0;
          const h = vp[3] | 0;
          if (!interesting(w, h) || !isPow2(w) || !isPow2(h)) return ret;
          if (fboSnaps.length >= 40) return ret;
          const now = performance.now();
          if (proto.__sfLastFbo && now - proto.__sfLastFbo < 4) return ret;
          proto.__sfLastFbo = now;

          const pixels = new Uint8Array(w * h * 4);
          this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, pixels);
          // flip Y
          const flipped = new Uint8Array(w * h * 4);
          const row = w * 4;
          for (let y = 0; y < h; y++) {
            flipped.set(
              pixels.subarray(y * row, y * row + row),
              (h - 1 - y) * row
            );
          }
          if (looksScrambled(flipped, w, h)) return ret;

          let hsh = 0;
          for (let i = 0; i < flipped.length; i += Math.max(128, (flipped.length / 256) | 0)) {
            hsh = (hsh * 33 + flipped[i]) | 0;
          }
          const key = w + "x" + h + ":" + hsh;
          if (fboSnaps.some((s) => s.key === key)) return ret;

          let uid = null,
            nameN = null,
            url = null;
          if (lastNamed) {
            const nm = meta.get(lastNamed);
            if (nm) {
              uid = nm.uid;
              nameN = nm.name;
              url = nm.src;
            }
          }
          fboSnaps.push({
            key,
            rgba: flipped,
            w,
            h,
            uid,
            name: nameN,
            url,
            from: "fbo-" + label,
          });
          emit({
            source: "sf-dl-hook",
            type: "sf-tex-event",
            event: "capture",
            detail: {
              uid,
              name: nameN,
              width: w,
              height: h,
              from: "fbo-" + label,
              kind: "fbo",
              count: countReady(),
            },
          });
          notifyStatus(true);
        } catch (_) {}
        return ret;
      };
    };
    if (typeof oDrawA === "function") {
      proto.drawArrays = wrapDraw(oDrawA, "drawArrays");
    }
    if (typeof oDrawE === "function") {
      proto.drawElements = wrapDraw(oDrawE, "drawElements");
    }
  }

  if (window.WebGLRenderingContext) hookGL(WebGLRenderingContext.prototype, "webgl");
  if (window.WebGL2RenderingContext) hookGL(WebGL2RenderingContext.prototype, "webgl2");

  function readTex(tex) {
    const m = meta.get(tex);
    if (!m || !m.gl || !interesting(m.w, m.h)) return null;
    const gl = m.gl;
    const w = m.w;
    const h = m.h;
    let fb = null;
    let prevFb = null;
    let prevTex = null;
    try {
      prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
      fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex,
        0
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        return null;
      }
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const flipped = new Uint8Array(w * h * 4);
      const row = w * 4;
      for (let y = 0; y < h; y++) {
        flipped.set(pixels.subarray(y * row, y * row + row), (h - 1 - y) * row);
      }
      return { rgba: flipped, w, h };
    } catch (e) {
      return null;
    } finally {
      try {
        if (fb) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb || null);
          gl.deleteFramebuffer(fb);
        }
        if (prevTex !== undefined) gl.bindTexture(gl.TEXTURE_2D, prevTex);
      } catch (_) {}
    }
  }

  function yieldTick() {
    return new Promise((r) => setTimeout(r, 0));
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
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, width: tw, height: th, mime };
  }

  /** Prefer base64 for extension messaging reliability (ArrayBuffer often arrives empty) */
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

  async function dumpStreaming() {
    if (dumpInFlight) {
      emit({
        source: "sf-dl-hook",
        type: "sf-tex-dump-done",
        count: 0,
        busy: true,
      });
      return;
    }
    dumpInFlight = true;
    loadCatalog();
    let sent = 0;
    let sentBytes = 0;
    let readFail = 0;
    let scrambledSkip = 0;
    const seen = new Set();

    try {
      // Build candidates from GPU textures + FBO snaps
      const items = [];

      for (const snap of fboSnaps) {
        items.push({
          kind: "fbo",
          score: 300 + snap.w * snap.h / 1e6,
          rgba: snap.rgba,
          w: snap.w,
          h: snap.h,
          uid: snap.uid,
          name: snap.name,
          url: snap.url,
          from: snap.from,
        });
      }

      for (const tex of list) {
        const m = meta.get(tex);
        if (!m || !interesting(m.w, m.h)) continue;
        // Prefer pixel uploads / larger / named
        let score = m.w * m.h / 1e6;
        if (m.hasPixels) score += 80;
        if (m.uid || m.name) score += 40;
        if (m.hasSrc && !m.hasPixels) score += 10; // still try — may be clean on free models
        if (isPow2(m.w) && isPow2(m.h)) score += 5;
        items.push({ kind: "tex", score, tex, m });
      }

      items.sort((a, b) => b.score - a.score);

      for (const it of items) {
        if (sent >= MAX_DUMP || sentBytes >= MAX_DUMP_BYTES) break;

        let rgba, w, h, uid, name, url, from;
        if (it.kind === "fbo") {
          rgba = it.rgba;
          w = it.w;
          h = it.h;
          uid = it.uid;
          name = it.name;
          url = it.url;
          from = it.from;
        } else {
          const read = readTex(it.tex);
          if (!read) {
            readFail++;
            continue;
          }
          rgba = read.rgba;
          w = read.w;
          h = read.h;
          uid = it.m.uid;
          name = it.m.name;
          url = it.m.src;
          from = it.m.hasPixels
            ? "gpu-pixels"
            : it.m.hasSrc
              ? "gpu-image"
              : "gpu-tex";
        }

        const scrambled = looksScrambled(rgba, w, h);
        // Skip pure noise UNLESS we have almost nothing yet (then keep as last resort)
        if (scrambled && sent >= 2) {
          scrambledSkip++;
          continue;
        }

        const key =
          (uid && "uid:" + uid) ||
          (name && "name:" + String(name).toLowerCase()) ||
          "sz:" + w + "x" + h + ":" + (from || "");
        // Allow multiple same size if different uid; skip exact key
        if (seen.has(key) && uid) continue;
        // Also dedupe identical dimensions+from if anonymous
        const szKey = "szonly:" + w + "x" + h;
        if (!uid && !name && seen.has(szKey) && scrambled) {
          scrambledSkip++;
          continue;
        }

        const enc = await encodeRgba(rgba, w, h);
        if (!enc.bytes || enc.bytes.length < 64) continue;
        if (sentBytes + enc.bytes.length > MAX_DUMP_BYTES) break;

        // Resolve name from catalog if missing
        if (uid && !name) name = resolveName(uid, url);

        let b64;
        try {
          b64 = toBase64(enc.bytes);
        } catch (e) {
          log("b64 fail", e);
          continue;
        }

        emit({
          source: "sf-dl-hook",
          type: "sf-tex-dump-item",
          capture: {
            uid: uid || null,
            name: name || null,
            url: url || null,
            width: enc.width,
            height: enc.height,
            from: from || "gpu",
            scrambledHint: !!scrambled,
            mime: enc.mime,
            byteLength: enc.bytes.length,
            // base64 is reliable across page→content→SW messaging
            dataBase64: b64,
            pngBase64: b64,
          },
        });

        seen.add(key);
        if (uid) seen.add("uid:" + uid);
        seen.add(szKey);
        sent++;
        sentBytes += enc.bytes.length;
        if (sent % 2 === 0) await yieldTick();
      }

      log("dump done", { sent, sentBytes, readFail, scrambledSkip, list: list.length, fbo: fboSnaps.length });
    } catch (e) {
      log("dump fail", e);
    } finally {
      dumpInFlight = false;
      emit({
        source: "sf-dl-hook",
        type: "sf-tex-dump-done",
        count: sent,
        bytes: sentBytes,
        readFail,
        scrambledSkip,
        tracked: list.length,
        fbo: fboSnaps.length,
      });
    }
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
      loadCatalog();
      notifyStatus(true);
      return;
    }
    if (d.type === "sf-tex-clear") {
      fboSnaps.length = 0;
      lastStatus = -1;
      notifyStatus(true);
      return;
    }
    if (d.type === "sf-tex-dump") {
      dumpStreaming().catch((e) => log(e));
    }
  });

  function boot() {
    loadCatalog();
    notifyStatus(true);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  setTimeout(boot, 2000);
  setTimeout(boot, 6000);

  let ticks = 0;
  setInterval(() => {
    if (++ticks > 100) return;
    notifyStatus(false);
  }, 2000);

  log("installed v3", location.href);
})();
