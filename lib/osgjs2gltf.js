import { decodePngRgba, encodePngRgba } from './descramble.js';

// --- Browser helpers (Uint8Array instead of Node Buffer) ---
function concatBytes(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function pad4(bytes, fill = 0) {
  const n = Math.ceil(bytes.length / 4) * 4;
  if (n === bytes.length) return bytes;
  const out = new Uint8Array(n);
  out.fill(fill);
  out.set(bytes);
  return out;
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function typedToBytes(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// --- Sketchfab binary decoders (extracted from viewer JS) ---

function decodeVarint(bytes, count, typeName) {
    const signed = typeName[0] !== 'U';
    const result = signed ? new Int32Array(count) : new Uint32Array(count);
    let a = 0, o = 0;
    while (a < count) {
        let s = 0, l = 0;
        do { s |= (bytes[o] & 127) << l; l += 7; } while ((bytes[o++] & 128) !== 0);
        result[a++] = s;
    }
    if (signed) {
        for (let u = 0; u < count; u++) {
            const c = result[u];
            result[u] = (c >> 1) ^ -(c & 1); // zigzag decode
        }
    }
    return result;
}

function deltaDecodeInPlace(arr, startIdx) {
    const start = startIdx || 0;
    let prev = arr[start];
    for (let i = start + 1; i < arr.length; i++) {
        const v = arr[i];
        prev = arr[i] = prev + (v >> 1 ^ -(v & 1));
    }
    return arr;
}

function dequantize(encoded, output, bbl, h, itemSize) {
    const count = encoded.length / itemSize;
    for (let i = 0; i < count; i++) {
        const base = i * itemSize;
        for (let j = 0; j < itemSize; j++) {
            output[base + j] = bbl[j] + encoded[base + j] * h[j];
        }
    }
    return output;
}

function decodeNormals(encoded, output, itemSize, epsilon, nphi, hasThirdComponent) {
    epsilon = epsilon || 0.25;
    nphi = nphi || 720;
    const PI = 3.14159265359;
    const cosEps = Math.cos(0.01745329251 * epsilon);
    const dPhi = PI / (nphi - 1);
    const dGamma = 1.57079632679 / (nphi - 1);
    const stride = hasThirdComponent ? 3 : 2;
    const count = encoded.length / stride;

    for (let i = 0; i < count; i++) {
        const outIdx = i * itemSize;
        const inIdx = i * stride;
        let S = encoded[inIdx];
        let x = encoded[inIdx + 1];

        if (itemSize === 4 && !hasThirdComponent) {
            output[outIdx + 3] = (S & 1024) ? -1 : 1;
            S &= ~1024;
        }

        const A0 = S * dPhi;
        const R = Math.cos(A0);
        const w = Math.sin(A0);
        const A1 = A0 + dGamma;
        let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
        if (E > 1) E = 1; else if (E < -1) E = -1;
        const P = 6.28318530718 * x / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));

        output[outIdx] = w * Math.cos(P);
        output[outIdx + 1] = w * Math.sin(P);
        output[outIdx + 2] = R;
    }
    return output;
}

function implicitDecode(encoded, output, startIdx, useExpected) {
    let r = encoded[2]; // expectedIndex
    const maskLen = encoded[1];
    const headerLen = 3;
    const maskView = encoded.subarray(headerLen, maskLen + headerLen);
    const masks = new Uint32Array(maskView.buffer, maskView.byteOffset, maskLen);
    let idx = startIdx;
    const padBits = maskLen * 32 - output.length;

    for (let u = 0; u < maskLen; u++) {
        const c = masks[u];
        let h = u * 32; // output position (independent of d)
        const dStart = (u === maskLen - 1) ? padBits : 0;
        for (let d = dStart; d < 32; d++, h++) {
            if (h >= output.length) break;
            if (c & ((-2147483648) >>> d)) {
                output[h] = encoded[idx++];
            } else {
                output[h] = useExpected ? r : r++;
            }
        }
    }
    return output;
}

function expectedRenumber(arr, state) {
    let n = state[0];
    for (let a = 0; a < arr.length; a++) {
        const o = n - arr[a];
        arr[a] = o;
        if (n <= o) n = o + 1;
    }
    state[0] = n;
    return arr;
}

// Index buffers narrower than 32-bit must be widened before delta/watermark
// decode, otherwise the arithmetic wraps (e.g. a Uint8 index buffer).
function widenIndices(arr) {
    if (arr instanceof Uint32Array || arr instanceof Int32Array) return arr;
    return Int32Array.from(arr);
}

function triStripToTriangles(indices) {
    if (indices.length < 3) return new Uint32Array(0);
    const tris = [];
    for (let i = 0; i < indices.length - 2; i++) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue; // degenerate
        if (i % 2 === 0) {
            tris.push(a, b, c);
        } else {
            tris.push(b, a, c); // flip winding on odd
        }
    }
    return new Uint32Array(tris);
}

// Loose triangle list (already in triangle order): drop degenerate triangles
function looseTrianglesToTriangles(indices) {
    const tris = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue; // degenerate
        tris.push(a, b, c);
    }
    return new Uint32Array(tris);
}

// Parallelogram predictor: reconstructs vertex positions from residuals + strip topology
function parallelogramPredict(data, itemSize, stripIndices) {
    const vertCount = data.length / itemSize;
    const visited = new Uint8Array(vertCount);
    const numStrip = stripIndices.length - 1;

    visited[stripIndices[0]] = 1;
    visited[stripIndices[1]] = 1;
    visited[stripIndices[2]] = 1;

    for (let i = 2; i < numStrip; i++) {
        const a = stripIndices[i - 2];
        const b = stripIndices[i - 1];
        const c = stripIndices[i];
        const d = stripIndices[i + 1];

        if (visited[d] !== 1) {
            visited[d] = 1;
            const ai = a * itemSize;
            const bi = b * itemSize;
            const ci = c * itemSize;
            const di = d * itemSize;
            for (let j = 0; j < itemSize; j++) {
                // parallelogram: d = d_residual + b + c - a
                data[di + j] = data[di + j] + data[bi + j] + data[ci + j] - data[ai + j];
            }
        }
    }
    return data;
}

// --- osgjs parser ---

function asArrayBuffer(src) {
    if (!src) return null;
    if (src instanceof ArrayBuffer) return src;
    if (src.buffer instanceof ArrayBuffer) {
        // TypedArray or DataView or Node Buffer
        if (typeof src.byteOffset === 'number' && typeof src.byteLength === 'number'
            && !(src instanceof ArrayBuffer)) {
            return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
        }
        return src.buffer;
    }
    if (src instanceof Uint8Array) return src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    return src;
}

function readBufferArray(binData, vb, typeName) {
    const offset = vb.Offset || 0;
    const size = vb.Size;
    const itemSize = vb.ItemSize || 1;

    if (vb.Encoding === 'varint') {
        return decodeVarint(new Uint8Array(binData, offset), size * itemSize, typeName);
    }

    const types = {
        Float32Array: Float32Array, Int32Array: Int32Array,
        Uint32Array: Uint32Array, Uint16Array: Uint16Array,
        Uint8Array: Uint8Array, Int16Array: Int16Array
    };
    const TypedArr = types[typeName];
    if (!TypedArr) throw new Error(`Unknown type: ${typeName}`);
    return new TypedArr(binData, offset, size * itemSize);
}

function processGeometry(geom, polyBin, wireBin, sharedState) {
    const userData = sharedState || {};
    const result = { name: geom.Name || 'unnamed', attributes: {}, indices: null, mode: 'TRIANGLES', material: null };
    const meta = {};

    // Parse UserDataContainer
    const udc = geom.UserDataContainer;
    if (udc && udc.Values) {
        for (const v of udc.Values) {
            const val = v.Value;
            meta[v.Name] = isNaN(Number(val)) ? val : Number(val);
        }
    }

    // Process primitives
    const primList = geom.PrimitiveSetList || [];
    const DELTA = 1, EXPECTED = 2, IMPLICIT = 4, TRIANGLE_ATTR = 16;
    const triMode = meta.triangle_mode || 0;
    const hasTriAttr = (meta.attributes || 0) & TRIANGLE_ATTR;
    const triChunks = [];
    // The "expected"/high-watermark counter is shared across all of a geometry's
    // primitives and processed in list order: the strip advances it, then the
    // loose-triangle set continues from the same value. A fresh counter per
    // primitive corrupts the loose-triangle indices.
    const expState = [0];
    for (const prim of primList) {
        const drawType = Object.keys(prim)[0];
        const draw = prim[drawType];
        const idxInfo = draw.Indices;
        if (!idxInfo) continue;
        if (draw.Mode !== 'TRIANGLE_STRIP' && draw.Mode !== 'TRIANGLES') continue;

        const arrInfo = idxInfo.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const isWireframe = arrDef.File && arrDef.File.includes('wireframe');
        const binSrc = isWireframe ? wireBin : polyBin;
        if (!binSrc) continue;

        const isStrip = draw.Mode === 'TRIANGLE_STRIP';
        let indices = widenIndices(readBufferArray(asArrayBuffer(binSrc), { ...arrDef, ItemSize: 1 }, arrType));

        if (!hasTriAttr) {
            // Indices stored directly (not delta/watermark encoded).
            if (isStrip) { result.stripIndices = indices; triChunks.push(triStripToTriangles(indices)); }
            else triChunks.push(looseTrianglesToTriangles(indices));
            continue;
        }

        let out = indices, startIdx = 0;
        if ((triMode & IMPLICIT) && isStrip) {
            startIdx = 3 + indices[1]; // IMPLICIT_HEADER_LENGTH + mask_length
            out = new Int32Array(indices[0]);
        }
        if (triMode & DELTA) deltaDecodeInPlace(indices, startIdx);
        if ((triMode & IMPLICIT) && isStrip) implicitDecode(indices, out, startIdx, !!(triMode & EXPECTED));
        if (triMode & EXPECTED) expectedRenumber(out, expState);

        if (isStrip) {
            result.stripIndices = out; // kept for parallelogram vertex prediction
            triChunks.push(triStripToTriangles(out));
        } else {
            triChunks.push(looseTrianglesToTriangles(out));
        }
    }

    let total = 0;
    for (const c of triChunks) total += c.length;
    if (total) {
        const merged = new Uint32Array(total);
        let o = 0;
        for (const c of triChunks) { merged.set(c, o); o += c.length; }
        result.indices = merged;
        result.mode = 'TRIANGLES';
    }

    // Process vertex attributes
    if (!result.indices) return result;
    const vaList = geom.VertexAttributeList || {};
    for (const [attrName, attrDef] of Object.entries(vaList)) {
        const arrInfo = attrDef.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const isWireframe = arrDef.File && arrDef.File.includes('wireframe');
        const binSrc = isWireframe ? wireBin : polyBin;
        if (!binSrc) continue;

        const itemSize = attrDef.ItemSize || 1;
        let data = readBufferArray(asArrayBuffer(binSrc), { ...arrDef, ItemSize: itemSize }, arrType);
        const count = arrDef.Size;
        const attrFlags = meta.attributes || 0;

        if (attrName === 'Vertex') {
            const vtxMode = meta.vertex_mode || 0;
            // Apply parallelogram prediction if flag set and strip indices available
            if ((vtxMode & 2) && result.stripIndices) {
                parallelogramPredict(data, itemSize, result.stripIndices);
            }
            // Dequantize if quantized
            if ((attrFlags & 1) || (vtxMode & 1)) {
                const prefix = 'vtx_';
                if (meta[prefix + 'bbl_x'] !== undefined) {
                    const bbl = [meta[prefix + 'bbl_x'], meta[prefix + 'bbl_y']];
                    const h = [meta[prefix + 'h_x'], meta[prefix + 'h_y']];
                    if (itemSize === 3) {
                        bbl.push(meta[prefix + 'bbl_z']);
                        h.push(meta[prefix + 'h_z']);
                    }
                    const floats = new Float32Array(data.length);
                    dequantize(data, floats, bbl, h, itemSize);
                    data = floats;
                }
            }
            result.attributes.POSITION = { data, itemSize, count };
        } else if (attrName === 'Normal') {
            if (attrFlags & 2) {
                const floats = new Float32Array(count * 3);
                decodeNormals(data, floats, 3, meta.epsilon, meta.nphi);
                result.attributes.NORMAL = { data: floats, itemSize: 3, count };
            } else {
                result.attributes.NORMAL = { data, itemSize, count };
            }
        } else if (attrName === 'Tangent') {
            if (attrFlags & 32) {
                const floats = new Float32Array(count * 4);
                decodeNormals(data, floats, 4, meta.epsilon, meta.nphi);
                result.attributes.TANGENT = { data: floats, itemSize: 4, count };
            }
        } else if (attrName.startsWith('TexCoord')) {
            const uvSuffix = attrName.replace('TexCoord', '');
            const prefix = `uv_${uvSuffix}_`;
            const uvMode = meta[`uv_${uvSuffix}_mode`] !== undefined ? meta[`uv_${uvSuffix}_mode`] : (meta.vertex_mode || 0);
            // Apply parallelogram prediction
            if ((uvMode & 2) && result.stripIndices) {
                parallelogramPredict(data, itemSize, result.stripIndices);
            }
            // Dequantize
            if (meta[prefix + 'bbl_x'] !== undefined && ((attrFlags & 4) || (uvMode & 1))) {
                const bbl = [meta[prefix + 'bbl_x'], meta[prefix + 'bbl_y']];
                const h = [meta[prefix + 'h_x'], meta[prefix + 'h_y']];
                const floats = new Float32Array(data.length);
                dequantize(data, floats, bbl, h, itemSize);
                data = floats;
            } else if (!(data instanceof Float32Array)) {
                data = new Float32Array(data);
            }
            // Official Sketchfab glTF keeps OSG UVs as-is (UDIM U may sit in
            // [1,2]; V is not flipped). Sampler is REPEAT, same as official.
            // Drop all-zero UV channels (common empty lightmap slots)
            let anyNonZero = false;
            for (let i = 0; i < data.length; i++) {
                if (data[i] > 1e-6 && data[i] < 1 - 1e-6) { anyNonZero = true; break; }
                if (data[i] > 1e-6) { anyNonZero = true; break; }
            }
            // keep if any variation OR any value not exactly 0
            if (!anyNonZero) {
                let maxAbs = 0;
                for (let i = 0; i < data.length; i++) {
                    const a = Math.abs(data[i]);
                    if (a > maxAbs) maxAbs = a;
                }
                if (maxAbs < 1e-6) {
                    // truly empty — skip
                    continue;
                }
            }
            // Store with original osgjs name; will remap to continuous indices later
            result.attributes[`_TC_${uvSuffix}`] = { data, itemSize: itemSize || 2, count };
        } else if (attrName === 'Color') {
            // Always skip Sketchfab Color attributes. They are usually a constant
            // engine tint (often pink + alpha≈0.5). Blender multiplies
            // baseColorTexture * COLOR_0, which makes textured models look
            // untextured / transparent / wrong. True vertex-color meshes are rare
            // on Sketchfab viewer data.
        }
    }

    // Material + texture refs from StateSet
    const stateSet = geom.StateSet;
    if (stateSet && stateSet['osg.StateSet']) {
        const ss = stateSet['osg.StateSet'];
        // Maya/OBJ uploads often have no osg.Material — name is on the StateSet
        // (e.g. lambert2SG). Viewer materials use that same name.
        if (ss.Name) result.stateSetName = String(ss.Name);
        const attrList = ss.AttributeList || [];
        for (const attr of attrList) {
            if (attr['osg.Material']) {
                result.material = attr['osg.Material'];
                if (attr['osg.Material'].Name) {
                    result.materialName = String(attr['osg.Material'].Name);
                }
            }
        }
        if (!result.materialName && result.stateSetName) {
            result.materialName = result.stateSetName;
        }
        // TextureAttributeList: [[{ "osg.Texture": { File: "..." } }, states], ...]
        const texFiles = [];
        const tal = ss.TextureAttributeList || [];
        for (const unit of tal) {
            const entries = Array.isArray(unit) ? unit : [unit];
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') continue;
                const tex = entry['osg.Texture'] || entry['osg.Texture2D'];
                if (tex && tex.File) texFiles.push(String(tex.File));
            }
        }
        if (texFiles.length) result.textureFiles = texFiles;
    }
    // Fallback material name from geometry name: "...MI_1011801_10111_Body_0"
    if (!result.materialName && result.name) {
        const m = String(result.name).match(/MI_[A-Za-z0-9_]+/i);
        if (m) result.materialName = m[0].replace(/_\d+$/, '');
    }

    // OSG / viewer is Z-up. Official Sketchfab glTF bakes Y-up:
    // (x, y, z) → (x, z, -y)  == rotate −90° about X.
    // Doing it on the vertices (not a parent matrix) matches official mesh
    // bounds and stands the model up in Blender without extra nodes.
    for (const key of ['POSITION', 'NORMAL', 'TANGENT']) {
        const attr = result.attributes[key];
        if (!attr || !attr.data || (attr.itemSize || 0) < 3) continue;
        const d = attr.data;
        const s = attr.itemSize;
        for (let i = 0; i < d.length; i += s) {
            const y = d[i + 1];
            d[i + 1] = d[i + 2];
            d[i + 2] = -y;
        }
    }

    return result;
}

// --- Texture helpers ---

/** Basename of a texture path, strip optional "32hexuid_" prefix from download naming. */
function textureBasename(filename) {
    let base = String(filename || '').split('/').pop();
    base = base.replace(/^[a-f0-9]{32}_/i, '');
    return base;
}

/**
 * Channel from Sketchfab-style suffixes: _D _N _ORM _E _AO _S _M _AN …
 * Prefer suffix over loose token matching (Body_N must be normal, not "body" albedo).
 */
export function classifyTextureName(filename) {
    const base = textureBasename(filename).toLowerCase();
    if (!base) return 'unknown';
    const stem = base.replace(/\.[^.]+$/, '');
    const packed = stem.replace(/[^a-z0-9]+/g, '');
    // Substrings first (Archer_NormalMap, Archer_SpecularMap — no _n / _s suffix)
    if (/normalmap|normal_map|bumpmap|bump_map/.test(packed) || /(?:^|_)(nrm|norm)(?:_|$)/.test(stem)) {
        return 'normal';
    }
    if (/specularmap|specmap|spec_map/.test(packed) || /(?:^|_)(spec|specular)(?:_|$)/.test(stem)) {
        return 'specular';
    }
    if (/metallicroughness|metalrough|mrao/.test(packed) || /(?:^|_)(orm)(?:_|$)/.test(stem)) {
        return 'metalrough';
    }
    if (/(?:^|_)(rough|roughness|metal|metallic)(?:_|$)/.test(stem)) return 'metalrough';
    if (/basecolor|base_color|albedo|diffuse/.test(packed)) return 'albedo';
    if (/emissive|emission/.test(packed) || /(?:^|_)(emit|glow)(?:_|$)/.test(stem)) return 'emissive';
    if (/ambientocclusion|occlusion/.test(packed) || /(?:^|_)(ao)(?:_|$)/.test(stem)) return 'occlusion';
    if (/lightmap/.test(packed) || /(?:^|_)(lm)(?:_|$)/.test(stem)) return 'lightmap';
    if (/opacity|alphamask|cutout|glowmask/.test(packed)) return 'alpha';

    // Strong Sketchfab/game suffixes
    if (/_(orm|mrao|metallicroughness|metalrough)$/i.test(stem)) return 'metalrough';
    if (/_(normal|nrm|norm)$/i.test(stem) || /_n$/i.test(stem)) return 'normal';
    if (/_(diffuse|albedo|basecolor|base_color|col)$/i.test(stem) || /_d$/i.test(stem)) return 'albedo';
    if (/_(emissive|emission|emit|glow)$/i.test(stem) || /_e$/i.test(stem)) return 'emissive';
    if (/_(ao|occlusion|ambientocclusion)$/i.test(stem) || /_ao$/i.test(stem)) return 'occlusion';
    if (/_(lightmap|lm)$/i.test(stem) || /lm_final/i.test(stem)) return 'lightmap';
    if (/_(opacity|alpha|mask|cutout|glowmask)$/i.test(stem) || /_(an|m)$/i.test(stem)) return 'alpha';
    if (/_s$/i.test(stem) || /_(spec|specular)$/i.test(stem)) return 'specular';

    const norm = `_${stem.replace(/[^a-z0-9]+/g, '_')}_`;
    const has = (...words) => words.some((w) => norm.includes(`_${w}_`));
    if (has('lightmap', 'lm')) return 'lightmap';
    if (has('ao', 'occlusion', 'cavity')) return 'occlusion';
    if (has('normal', 'nrm', 'norm')) return 'normal';
    if (has('metal', 'metallic', 'rough', 'roughness', 'orm', 'mrao')) return 'metalrough';
    if (has('emissive', 'emiss', 'emit', 'glow')) return 'emissive';
    if (has('albedo', 'diffuse', 'basecolor', 'atlas', 'diff')) return 'albedo';
    if (has('spec', 'specular')) return 'specular';
    return 'unknown';
}

/**
 * Normalize material / texture identity for fuzzy matching.
 * Do NOT strip multi-digit suffixes like Equip_02 — only a single trailing
 * instance index (_0 … _9) used on mesh names.
 */
function identityKey(name) {
    let s = String(name || '');
    s = s.split('/').pop();
    s = s.replace(/^[a-f0-9]{32}_/i, '');
    s = s.replace(/\.[^.]+$/, '');
    s = s.replace(/^MI_/i, '').replace(/^T_/i, '').replace(/^TX_/i, '');
    // strip trailing channel tokens
    s = s.replace(/_(d|n|orm|mrao|e|ao|s|m|an|normal|diffuse|albedo|emissive|glowmask|mask|opacity)$/i, '');
    // mesh instance index only (…_0), keep …_01 / …_02 asset ids
    s = s.replace(/_(\d)$/, '');
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function mimeFromName(filename) {
    const base = String(filename || '').split('/').pop().toLowerCase();
    if (base.endsWith('.png')) return 'image/png';
    if (base.endsWith('.webp')) return 'image/webp';
    if (base.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
}

function findTextureBytes(filename, textureFiles) {
    if (!filename || !textureFiles) return null;
    if (textureFiles[filename]) return { data: textureFiles[filename], key: filename };
    const base = filename.split('/').pop();
    if (textureFiles[base]) return { data: textureFiles[base], key: base };
    const bare = textureBasename(filename);
    if (textureFiles[bare]) return { data: textureFiles[bare], key: bare };
    if (textureFiles['textures/' + bare]) {
        return { data: textureFiles['textures/' + bare], key: 'textures/' + bare };
    }
    // Match by texture UID embedded in path/name
    const uidM = String(filename).match(/([a-f0-9]{32})/i);
    if (uidM) {
        const uid = uidM[1].toLowerCase();
        for (const [k, v] of Object.entries(textureFiles)) {
            if (k.toLowerCase().includes(uid)) return { data: v, key: k };
        }
    }
    // Basename / identity key
    const stem = bare.replace(/\.[^.]+$/, '').toLowerCase();
    const id = identityKey(bare);
    for (const [k, v] of Object.entries(textureFiles)) {
        const kb = textureBasename(k).toLowerCase();
        if (kb === bare.toLowerCase() || kb === stem + '.png' || kb === stem + '.jpg') {
            return { data: v, key: k };
        }
        if (id && identityKey(kb) === id && classifyTextureName(kb) === classifyTextureName(bare)) {
            return { data: v, key: k };
        }
    }
    return null;
}

/**
 * Pick channel maps for a material/geometry name from the downloaded texture list.
 * Sketchfab rarely stores File paths in osgjs for modern models — only material names
 * like MI_…_Body, while downloads are T_…_Body_D.png / _N.png / _ORM.png.
 */
function mapTexturesForName(matName, geomName, textureList) {
    const list = textureList || [];
    if (!list.length) return null;

    const targets = [];
    if (matName) targets.push(identityKey(matName));
    if (geomName) {
        const g = String(geomName);
        const mi = g.match(/MI_[A-Za-z0-9_]+/i);
        if (mi) targets.push(identityKey(mi[0]));
        targets.push(identityKey(g));
    }
    const uniqTargets = [...new Set(targets.filter(Boolean))];

    // Score each texture against material identity
    const scored = list.map((t) => {
        const base = textureBasename(t.name);
        const tid = identityKey(base);
        let score = 0;
        for (const tgt of uniqTargets) {
            if (!tgt || !tid) continue;
            if (tid === tgt) score = Math.max(score, 100);
            else if (tid.endsWith(tgt) || tgt.endsWith(tid)) score = Math.max(score, 80);
            else if (tid.includes(tgt) || tgt.includes(tid)) score = Math.max(score, 60);
            else {
                // token overlap (Body, Head, Equip_01, …)
                const tt = new Set(tgt.split('_').filter((x) => x.length > 2 && !/^\d+$/.test(x)));
                const ti = tid.split('_').filter((x) => x.length > 2 && !/^\d+$/.test(x));
                let hit = 0;
                for (const x of ti) if (tt.has(x)) hit++;
                if (hit >= 2) score = Math.max(score, 40 + hit * 5);
                else if (hit === 1 && ti.length <= 3) score = Math.max(score, 25);
            }
        }
        return { base, cls: classifyTextureName(base), score, name: t.name };
    });

    const bestByClass = {};
    for (const s of scored) {
        // albedo can be a looser match; other channels need a stronger name match
        // so random *_E / *_N from another part don't attach to Body/Head.
        const need = s.cls === 'albedo' || s.cls === 'unknown' ? 25 : 55;
        if (s.score < need) continue;
        const prev = bestByClass[s.cls];
        if (!prev || s.score > prev.score) bestByClass[s.cls] = s;
    }

    // If nothing matched material name, leave empty (caller may use global)
    if (!Object.keys(bestByClass).length) return null;

    const map = {};
    if (bestByClass.albedo) map.albedo = bestByClass.albedo.base;
    if (bestByClass.normal) map.normal = bestByClass.normal.base;
    if (bestByClass.metalrough) map.metalness = bestByClass.metalrough.base;
    if (bestByClass.emissive) map.emissive = bestByClass.emissive.base;
    if (bestByClass.occlusion) map.occlusion = bestByClass.occlusion.base;
    // Only treat explicit opacity/cutout as alpha — NOT Hair_M / GlowMask
    // (those would force alphaMode=MASK and "eat" the mesh in Blender).
    if (bestByClass.alpha && bestByClass.alpha.score >= 80) {
        const n = bestByClass.alpha.base.toLowerCase();
        if (/opacity|cutout|alphamask|alpha_mask|_opacity/.test(n)) {
            map.alpha = bestByClass.alpha.base;
        }
    }
    // unknown high-score as last-resort albedo
    if (!map.albedo && bestByClass.unknown && bestByClass.unknown.score >= 60) {
        map.albedo = bestByClass.unknown.base;
    }
    return Object.keys(map).length ? map : null;
}

/**
 * Resolve a texture set/image uid to a downloaded texture basename.
 */
function resolveUidToBase(uid, textureList) {
    if (!uid) return null;
    const u = String(uid).toLowerCase();
    for (const t of textureList || []) {
        if (t.uid && String(t.uid).toLowerCase() === u) return textureBasename(t.name);
        if (t.imageUids && t.imageUids.some((id) => String(id).toLowerCase() === u)) {
            return textureBasename(t.name);
        }
        if (t.name && t.name.toLowerCase().includes(u)) return textureBasename(t.name);
    }
    return null;
}

export function findViewerSpec(vm, matName, geomName) {
    if (!vm) return null;
    if (matName && vm.has(matName)) return { spec: vm.get(matName), via: 'viewer-uid' };
    const keys = [];
    vm.forEach((_, k) => keys.push(k));
    const tryNames = [matName, geomName].filter(Boolean);
    for (const raw of tryNames) {
        const id = identityKey(raw);
        if (!id || id === 'unnamed') continue;
        for (const k of keys) {
            if (identityKey(k) === id) return { spec: vm.get(k), via: 'stateset' };
        }
    }
    return null;
}

function sampleLum(rgba, w, h, u, v) {
    let x = Math.round(u * (w - 1));
    let y = Math.round(v * (h - 1));
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= w) x = w - 1;
    if (y >= h) y = h - 1;
    const o = (y * w + x) * 4;
    return (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
}

async function bakeOpacityIntoAlbedo(albedoBytes, alphaBytes) {
    const a = await decodePngRgba(albedoBytes);
    const m = await decodePngRgba(alphaBytes);
    if (!a.width || !m.width) return null;
    const out = new Uint8ClampedArray(a.rgba);
    const same = a.width === m.width && a.height === m.height;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const o = (y * a.width + x) * 4;
            const lum = same
                ? (m.rgba[o] * 77 + m.rgba[o + 1] * 150 + m.rgba[o + 2] * 29) >> 8
                : sampleLum(m.rgba, m.width, m.height, x / (a.width - 1 || 1), y / (a.height - 1 || 1));
            out[o + 3] = Math.round((out[o + 3] * lum) / 255);
        }
    }
    return encodePngRgba(out, a.width, a.height);
}

/**
 * Build per-geometry texture maps.
 * Priority: viewer material channels (uid) > osg File refs > name heuristics.
 * @param {Map|object|null} viewerMaterials - from parseViewerMaterials
 */
function buildTextureMaps(geometries, textureList, textureFiles, viewerMaterials) {
    const byClass = {
        albedo: [], normal: [], metalrough: [], emissive: [],
        occlusion: [], alpha: [], lightmap: [], unknown: [], specular: [],
    };
    const list = textureList || [];
    for (const t of list) {
        const base = textureBasename(t.name);
        const cls = classifyTextureName(base);
        if (!byClass[cls]) byClass[cls] = [];
        byClass[cls].push(base);
    }

    const pickFirst = (...groups) => {
        for (const g of groups) {
            if (g && g.length) return g[0];
        }
        return null;
    };
    // Never pick specular/normal/ORM as albedo. Never list[0].
    const albedoSafeUnknown = (byClass.unknown || []).filter((n) => {
        const c = classifyTextureName(n);
        return c === 'unknown' || c === 'albedo';
    });
    const global = {
        albedo: pickFirst(byClass.albedo, albedoSafeUnknown),
        normal: pickFirst(byClass.normal),
        metalness: null,
        emissive: null,
        occlusion: null,
        alpha: null,
        metallicFactor: 0,
        roughnessFactor: 0.9,
        normalFlipY: true,
        baseColorFactor: [1, 1, 1, 1],
        via: 'classify',
    };

    const vm = viewerMaterials instanceof Map
        ? viewerMaterials
        : viewerMaterials
          ? new Map(Object.entries(viewerMaterials))
          : null;

    const perGeom = geometries.map((geom) => {
        const matName = geom.materialName || null;

        // 0) Viewer material channels (authoritative, by texture uid — filenames lie)
        let found = findViewerSpec(vm, matName, geom.name);
        if (!found && vm && vm.size === 1) {
            const only = vm.values().next().value;
            if (only && !only.skipMesh) found = { spec: only, via: 'single' };
        }
        if (found && found.spec) {
            const spec = found.spec;
            if (spec.skipMesh) {
                return { skip: true };
            }
            const albedo = resolveUidToBase(spec.albedoUid, list);
            let metalTex = resolveUidToBase(spec.metalnessUid, list);
            let metallicFactor = spec.metallicFactor != null ? spec.metallicFactor : 0;
            // Sketchfab often points MetalnessPBR at a *_D color/id map, not ORM.
            // Dropping it must also drop factor=1, or hair cards go chrome.
            if (metalTex && classifyTextureName(metalTex) === 'albedo') metalTex = null;
            if (spec.metalnessUid && !metalTex) metallicFactor = 0;
            const map = {
                albedo,
                normal: resolveUidToBase(spec.normalUid, list),
                metalness: metalTex,
                emissive: resolveUidToBase(spec.emitUid, list),
                occlusion: resolveUidToBase(spec.aoUid, list),
                alpha: resolveUidToBase(spec.opacityUid, list),
                metallicFactor,
                roughnessFactor: spec.roughnessFactor != null ? spec.roughnessFactor : 0.9,
                normalFlipY: !!spec.normalFlipY,
                // DiffuseColor 0.8 leftover must not multiply a real albedo
                baseColorFactor: albedo ? [1, 1, 1, 1] : (spec.baseColorFactor || [1, 1, 1, 1]),
                opacityEnable: !!spec.opacityEnable,
                opacityFactor: spec.opacityFactor,
                opacityType: spec.opacityType,
                via: found.via,
            };
            // Only name-fallback when the viewer pointed at a uid we failed to resolve.
            // Hair_03 / untextured shells have albedoUid=null — do not steal Hair_D.
            if (!map.albedo && spec.albedoUid) {
                const byName = mapTexturesForName(matName, geom.name, list);
                if (byName && byName.albedo) map.albedo = byName.albedo;
                if (byName && byName.normal && !map.normal) map.normal = byName.normal;
            }
            // Untextured hair/line shells (viewer albedo uid is empty). Keeping
            // them binds a leftover gray quad or steals Hair_D via the name path.
            if (
                !map.albedo &&
                !spec.albedoUid &&
                /hair|line|brow|lash/i.test(String(matName || geom.name || ''))
            ) {
                return { skip: true };
            }
            return map;
        }

        // 1) Explicit File refs from osgjs (rare)
        if (geom.textureFiles && geom.textureFiles.length) {
            const map = {
                metallicFactor: 0,
                roughnessFactor: 0.9,
                normalFlipY: true,
                baseColorFactor: [1, 1, 1, 1],
            };
            for (const ref of geom.textureFiles) {
                const hit = findTextureBytes(ref, textureFiles);
                if (!hit) continue;
                const base = textureBasename(hit.key);
                const cls = classifyTextureName(base);
                if (cls === 'normal') map.normal = base;
                else if (cls === 'metalrough') map.metalness = base;
                else if (cls === 'emissive') map.emissive = base;
                else if (cls === 'occlusion') map.occlusion = base;
                else if (cls === 'lightmap' || cls === 'specular') { /* skip */ }
                else map.albedo = base;
            }
            if (map.albedo || map.normal) return map;
        }

        // 2) Name heuristics — albedo (+ normal only), never auto-ORM
        const byName = mapTexturesForName(geom.materialName, geom.name, list);
        if (byName) {
            return {
                albedo: byName.albedo || global.albedo,
                normal: byName.normal || null,
                metalness: null, // don't invent ORM
                emissive: byName.emissive || null,
                occlusion: null,
                alpha: byName.alpha || null,
                metallicFactor: 0,
                roughnessFactor: 0.9,
                normalFlipY: true,
                baseColorFactor: [1, 1, 1, 1],
                via: 'classify',
            };
        }

        return global.albedo
            ? { ...global }
            : {
                metallicFactor: 0,
                roughnessFactor: 0.9,
                normalFlipY: true,
                baseColorFactor: [1, 1, 1, 1],
            };
    });

    return { global, perGeom };
}

// --- glTF builder ---

function buildGLTF(geometries, textureMap, textureFiles, perGeomMaps, options = {}) {
    const externalTextures = !!options.externalTextures;
    const gltf = {
        asset: { version: '2.0', generator: 'sketchfab-osgjs-converter' },
        scene: 0,
        scenes: [{ nodes: [] }],
        nodes: [],
        meshes: [],
        accessors: [],
        bufferViews: [],
        buffers: [],
        materials: [],
        textures: [],
        images: [],
        samplers: []
    };

    const binChunks = [];
    let byteOffset = 0;

    function addAccessor(data, type, componentType, count, itemSize, normalized) {
        const typeMap = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };
        let buf;
        // Prefer view over copy when already the right TypedArray
        if (componentType === 5126) {
            buf = data instanceof Float32Array ? data : new Float32Array(data.buffer ? data : Array.from(data));
        } else if (componentType === 5125) {
            buf = data instanceof Uint32Array ? data : new Uint32Array(data.buffer ? data : Array.from(data));
        } else if (componentType === 5123) {
            buf = data instanceof Uint16Array ? data : new Uint16Array(data.buffer ? data : Array.from(data));
        } else if (componentType === 5121) {
            buf = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data : Array.from(data));
        } else {
            buf = new Float32Array(data);
        }

        const bytes = typedToBytes(buf);
        const padded = pad4(bytes, 0);

        const bvIdx = gltf.bufferViews.length;
        // Indices (SCALAR + 5125/5123) must not have byteStride
        const isIndex = type === 'SCALAR' && (componentType === 5125 || componentType === 5123);
        gltf.bufferViews.push({
            buffer: 0, byteOffset, byteLength: bytes.length,
            ...(!isIndex && itemSize > 1 ? { byteStride: itemSize * buf.BYTES_PER_ELEMENT } : {})
        });

        const min = [], max = [];
        for (let j = 0; j < itemSize; j++) { min.push(Infinity); max.push(-Infinity); }
        for (let i = 0; i < count; i++) {
            for (let j = 0; j < itemSize; j++) {
                const v = buf[i * itemSize + j];
                if (v < min[j]) min[j] = v;
                if (v > max[j]) max[j] = v;
            }
        }

        const accIdx = gltf.accessors.length;
        gltf.accessors.push({
            bufferView: bvIdx, byteOffset: 0, componentType,
            count, type: typeMap[itemSize] || 'SCALAR',
            min, max,
            ...(normalized ? { normalized: true } : {})
        });

        binChunks.push(padded);
        byteOffset += padded.length;
        return accIdx;
    }

    // Sampler: linear filtering + REPEAT (UDIM-style UVs already wrapped to [0,1]).
    // Avoid MIPMAP minFilter — embedded images have no precomputed mips; some
    // importers sample badly with LINEAR_MIPMAP_LINEAR on GLB buffer images.
    gltf.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 });

    // Cache filename → texture index so multi-material shares images
    const texIndexCache = Object.create(null);

    // Optional sync placeholder — flipNormalY applied later async-free via preprocessed textureFiles
    function addImage(filename, opts = {}) {
        if (!filename || !textureFiles) return -1;
        // Prefer pre-flipped normal map when requested (keys registered as name.__flipY)
        let hit = null;
        if (opts.flipNormalY) {
          const bare = textureBasename(filename);
          hit =
            findTextureBytes(filename + '.__flipY', textureFiles) ||
            findTextureBytes(bare + '.__flipY', textureFiles) ||
            findTextureBytes('textures/' + bare + '.__flipY', textureFiles);
        }
        if (!hit) hit = findTextureBytes(filename, textureFiles);
        if (!hit) return -1;
        const imgData = hit.data;
        const keyName = hit.key.replace(/\.__flipY$/, '');
        const bare = textureBasename(keyName) + (opts.flipNormalY ? '_flipY' : '');
        const mimeType = mimeFromName(keyName);
        const imgIdx = gltf.images.length;

        // External .gltf mode: reference textures/ on disk (Blender loads these reliably)
        if (externalTextures) {
            const uriBare = textureBasename(keyName);
            gltf.images.push({
                uri: 'textures/' + uriBare,
                mimeType,
                name: uriBare,
            });
            return imgIdx;
        }

        // Embedded GLB mode
        const raw = imgData instanceof Uint8Array ? imgData : new Uint8Array(imgData);
        const padded = pad4(raw, 0);
        const bvIdx = gltf.bufferViews.length;
        // Image bufferViews: no byteStride; byteLength = unpadded image size
        gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: raw.length });
        byteOffset += padded.length;
        binChunks.push(padded);
        gltf.images.push({ bufferView: bvIdx, mimeType, name: bare });
        return imgIdx;
    }

    function addTexture(filename, opts = {}) {
        if (!filename) return -1;
        const flip = !!opts.flipNormalY;
        const cacheKey = String(filename).split('/').pop().toLowerCase() + (flip ? '|fy' : '');
        if (texIndexCache[cacheKey] !== undefined) return texIndexCache[cacheKey];
        const imgIdx = addImage(filename, opts);
        if (imgIdx < 0) {
            texIndexCache[cacheKey] = -1;
            return -1;
        }
        const texIdx = gltf.textures.length;
        gltf.textures.push({ source: imgIdx, sampler: 0 });
        texIndexCache[cacheKey] = texIdx;
        return texIdx;
    }

    /**
     * Build a glTF PBR material from viewer channel specs.
     * Defaults match Sketchfab lit/PBR: metalness 0, no invented ORM maps.
     */
    function makeMaterial(name, map) {
        const metalF = map && typeof map.metallicFactor === 'number' ? map.metallicFactor : 0;
        const roughF = map && typeof map.roughnessFactor === 'number' ? map.roughnessFactor : 0.9;
        const baseF = (map && map.baseColorFactor) || [1, 1, 1, 1];
        const hasMetalMap = !!(map && map.metalness);
        const material = {
            name: name || 'Material',
            doubleSided: true,
            pbrMetallicRoughness: {
                baseColorFactor: baseF.slice(0, 4),
                // If a metal/rough texture is present, factors multiply the texture
                metallicFactor: hasMetalMap ? (metalF > 0 ? metalF : 1.0) : metalF,
                roughnessFactor: hasMetalMap ? 1.0 : roughF,
            }
        };
        if (map && map.via) {
            material.extras = { via: map.via };
        }

        if (map) {
            if (map.albedo) {
                const idx = addTexture(map.albedo);
                if (idx >= 0) {
                    material.pbrMetallicRoughness.baseColorTexture = { index: idx, texCoord: 0 };
                }
            }
            if (map.metalness) {
                const idx = addTexture(map.metalness);
                if (idx >= 0) {
                    material.pbrMetallicRoughness.metallicRoughnessTexture = {
                        index: idx,
                        texCoord: 0,
                    };
                }
            }
            if (map.normal) {
                // flipY handled when packing texture bytes (see flipNormalMapY)
                const idx = addTexture(map.normal, { flipNormalY: !!map.normalFlipY });
                if (idx >= 0) material.normalTexture = { index: idx, texCoord: 0, scale: 1 };
            }
            if (map.emissive) {
                const idx = addTexture(map.emissive);
                if (idx >= 0) {
                    material.emissiveTexture = { index: idx, texCoord: 0 };
                    material.emissiveFactor = [1, 1, 1];
                }
            }
            if (map.occlusion) {
                const idx = addTexture(map.occlusion);
                if (idx >= 0) material.occlusionTexture = { index: idx, texCoord: 0, strength: 1 };
            }
            // Opacity / cutout from viewer material
            const opType = String(map.opacityType || '');
            if (map.opacityEnable && /dither/i.test(opType)) {
                // Dithered hair cards: albedo (Hair_AO) and opacity (Hair_M) are
                // different atlases / UV sets. Official export uses BLEND, no bake.
                material.alphaMode = 'BLEND';
            } else if (map.opacityEnable && map.alpha) {
                if (opType === 'mask' || /mask|cutout/i.test(opType)) {
                    material.alphaMode = 'MASK';
                    material.alphaCutoff = 0.5;
                } else if (opType === 'alphaBlend' || opType === 'blend' || opType === 'additive' || !opType) {
                    material.alphaMode = 'BLEND';
                } else {
                    material.alphaMode = 'OPAQUE';
                }
            } else if (map.alpha && /opacity|cutout|alphamask/i.test(map.alpha)) {
                material.alphaMode = 'MASK';
                material.alphaCutoff = 0.5;
            } else {
                material.alphaMode = 'OPAQUE';
            }
        }

        return material;
    }

    // Material cache keyed by map signature
    const matCache = Object.create(null);
    function materialIndexFor(map, geomName) {
        const key = map
            ? [
                'a:' + (map.albedo || ''),
                'n:' + (map.normal || ''),
                'm:' + (map.metalness || ''),
                'e:' + (map.emissive || ''),
                'o:' + (map.occlusion || ''),
                'mf:' + (map.metallicFactor != null ? map.metallicFactor : ''),
                'rf:' + (map.roughnessFactor != null ? map.roughnessFactor : ''),
                'fy:' + (map.normalFlipY ? 1 : 0),
                'al:' + (map.alpha || ''),
                'oe:' + (map.opacityEnable ? 1 : 0),
                'ot:' + (map.opacityType || ''),
              ].join('|')
            : '__default__';
        if (matCache[key] !== undefined) return matCache[key];
        const mat = makeMaterial(geomName || 'Material', map);
        const idx = gltf.materials.length;
        gltf.materials.push(mat);
        matCache[key] = idx;
        return idx;
    }

    // Ensure at least one material exists (fallback if no meshes pass filters)
    if (!textureMap) textureMap = null;

    const meshNodes = [];
    let geomI = 0;
    for (const geom of geometries) {
        if (!geom.indices || !geom.attributes.POSITION) { geomI++; continue; }

        const map = (perGeomMaps && perGeomMaps[geomI]) || textureMap;
        // Skip glass / invisible rim shells (viewer opacity 0 or additive ghost)
        if (map && map.skip) { geomI++; continue; }
        const gname = geom.name || '';
        if (/glass/i.test(gname) || /rim_?hero/i.test(gname)) {
            // only keep if material explicitly has solid albedo
            if (!map || !map.albedo) { geomI++; continue; }
        }
        const matName =
            geom.materialName ||
            geom.name ||
            ('Material_' + geomI);
        const matIdx = materialIndexFor(map, matName);

        const primitive = { attributes: {}, material: matIdx, mode: 4 };

        // Indices
        const idx = geom.indices;
        const idxType = idx.BYTES_PER_ELEMENT === 4 ? 5125 : 5123;
        primitive.indices = addAccessor(idx, 'SCALAR', idxType, idx.length, 1);

        // Attributes — only standard glTF attribute names (skip junk COLOR_0 already)
        for (const [name, attr] of Object.entries(geom.attributes)) {
            if (name.startsWith('_')) continue;
            // Prefer TEXCOORD_0 only if present; skip empty higher sets already dropped
            const ct = attr.componentType || 5126;
            const norm = attr.normalized || false;
            primitive.attributes[name] = addAccessor(
                attr.data,
                name === 'SCALAR' ? 'SCALAR' : `VEC${attr.itemSize}`,
                ct,
                attr.count,
                attr.itemSize,
                norm
            );
        }

        // Safety: if no TEXCOORD_0 but material uses textures, Blender won't show maps
        if (
            !primitive.attributes.TEXCOORD_0 &&
            map &&
            (map.albedo || map.normal || map.metalness)
        ) {
            // synthesize 0,0 UVs so importers still bind the image node
            const nVerts = geom.attributes.POSITION.count;
            const zeros = new Float32Array(nVerts * 2);
            primitive.attributes.TEXCOORD_0 = addAccessor(zeros, 'VEC2', 5126, nVerts, 2, false);
        }

        // Remove byteStride from index bufferViews (safety)
        const idxBV = gltf.accessors[primitive.indices].bufferView;
        delete gltf.bufferViews[idxBV].byteStride;

        // One mesh + node per geometry — Blender multi-material on a single
        // multi-primitive mesh is flaky; separate objects import textures reliably.
        const meshIdx = gltf.meshes.length;
        const meshName = (geom.name || matName || ('Mesh_' + geomI)).slice(0, 64);
        gltf.meshes.push({ name: meshName, primitives: [primitive] });
        const nodeIdx = gltf.nodes.length;
        gltf.nodes.push({ name: meshName, mesh: meshIdx });
        meshNodes.push(nodeIdx);
        geomI++;
    }

    if (meshNodes.length) {
        // Vertices are already Y-up. Identity parent keeps the official name.
        const root = gltf.nodes.length;
        gltf.nodes.push({
            name: 'Sketchfab_model',
            children: meshNodes.slice(),
        });
        gltf.scenes[0].nodes = [root];
    } else {
        gltf.meshes.push({ primitives: [] });
        gltf.nodes.push({ mesh: 0, name: 'root' });
        gltf.scenes[0].nodes = [gltf.nodes.length - 1];
    }

    // If no images were attached but we have texture files, force-embed first albedo-like
    if (!gltf.images.length && textureFiles && textureMap && textureMap.albedo) {
        // rebuild default material with texture attempt already done — nothing more
    }

    // Drop empty optional arrays (some strict validators dislike empty textures[])
    if (!gltf.images.length) {
        delete gltf.images;
        delete gltf.textures;
        delete gltf.samplers;
    }

    const binBuffer = concatBytes(binChunks);
    gltf.buffers.push({ byteLength: binBuffer.length });

    return { json: gltf, bin: binBuffer };
}

// --- Recursive scene traversal ---

function buildUidMap(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.UniqueID !== undefined && Object.keys(obj).length > 1) {
        map[obj.UniqueID] = obj;
    }
    for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(c => buildUidMap(c, map));
        else if (typeof v === 'object') buildUidMap(v, map);
    }
}

function resolveRefs(obj, uidMap) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.UniqueID !== undefined && Object.keys(obj).length === 1) {
        const resolved = uidMap[obj.UniqueID];
        if (resolved) return resolved;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) {
            obj[k] = v.map(c => typeof c === 'object' ? resolveRefs(c, uidMap) : c);
        } else if (typeof v === 'object') {
            obj[k] = resolveRefs(v, uidMap);
        }
    }
    return obj;
}

function isWireframeGeom(geom) {
    if (!geom) return false;
    const prims = geom.PrimitiveSetList || [];
    return prims.some((p) => {
        const dt = Object.values(p)[0];
        return dt && dt.Mode === 'LINES';
    });
}

/** Unwrap SourceGeometry / Morph / plain Geometry dict into osg.Geometry payload. */
function extractMeshGeometry(wrapper) {
    if (!wrapper || typeof wrapper !== 'object') return null;
    // Direct geometry
    if (wrapper.PrimitiveSetList && wrapper.VertexAttributeList) return wrapper;
    if (wrapper['osg.Geometry']) return wrapper['osg.Geometry'];
    // RigGeometry / MorphGeometry hold the mesh under SourceGeometry
    const src = wrapper.SourceGeometry;
    if (src && typeof src === 'object') {
        if (src['osg.Geometry']) return src['osg.Geometry'];
        if (src.PrimitiveSetList && src.VertexAttributeList) return src;
        for (const [k, v] of Object.entries(src)) {
            if (k.startsWith('osg.') && v && typeof v === 'object' && v.VertexAttributeList) {
                return v;
            }
        }
    }
    return null;
}

function collectGeometries(node, polyBin, wireBin) {
    const uidMap = {};
    buildUidMap(node, uidMap);
    resolveRefs(node, uidMap);

    const results = [];
    const seen = new Set();
    const sharedState = { expectedState: [0] };
    const stats = { rig: 0, geom: 0, morph: 0, wire: 0, skip: 0, errors: [] };

    function acceptGeometry(geom, label) {
        if (!geom) return;
        if (isWireframeGeom(geom)) {
            stats.wire++;
            return;
        }
        const uid = geom.UniqueID;
        const key = uid !== undefined ? 'id:' + uid : 'obj:' + (geom.Name || label || results.length);
        if (seen.has(key)) return;
        // Also de-dupe by object identity via UniqueID only; Name-only keys may collide
        if (uid !== undefined) seen.add(key);
        else seen.add(key);

        try {
            const result = processGeometry(geom, polyBin, wireBin, sharedState);
            if (result.indices && result.attributes.POSITION) {
                // Remap _TC_* to continuous TEXCOORD_0, TEXCOORD_1, ...
                const tcKeys = Object.keys(result.attributes)
                    .filter((k) => k.startsWith('_TC_'))
                    .sort();
                let tcIdx = 0;
                for (const k of tcKeys) {
                    result.attributes[`TEXCOORD_${tcIdx++}`] = result.attributes[k];
                    delete result.attributes[k];
                }
                results.push(result);
            } else {
                stats.skip++;
            }
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            stats.errors.push(`${geom.Name || label || '?'}: ${msg}`);
            console.warn(`  Warning: skipping ${geom.Name || label}: ${msg}`);
        }
    }

    /**
     * Full tree walk (not only Children). Sketchfab skinned models put meshes in
     * osgAnimation.RigGeometry.SourceGeometry.osg.Geometry — those are NOT
     * direct Children of osg.Node, so a Children-only walk finds nothing.
     */
    function walk(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 60) return;

        if (Array.isArray(obj)) {
            for (const item of obj) walk(item, depth + 1);
            return;
        }

        // Skinned mesh wrapper (Sketchfab / OSG animation)
        if (obj['osgAnimation.RigGeometry'] || obj['osg.RigGeometry']) {
            const rig = obj['osgAnimation.RigGeometry'] || obj['osg.RigGeometry'];
            stats.rig++;
            const mesh = extractMeshGeometry(rig);
            acceptGeometry(mesh, 'RigGeometry');
            // Walk other fields except SourceGeometry (already handled)
            for (const [k, v] of Object.entries(rig)) {
                if (k === 'SourceGeometry') continue;
                walk(v, depth + 1);
            }
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'osgAnimation.RigGeometry' || k === 'osg.RigGeometry') continue;
                walk(v, depth + 1);
            }
            return;
        }

        // Morph targets
        if (obj['osgAnimation.MorphGeometry'] || obj['osg.MorphGeometry']) {
            const morph = obj['osgAnimation.MorphGeometry'] || obj['osg.MorphGeometry'];
            stats.morph++;
            const mesh = extractMeshGeometry(morph) || morph;
            acceptGeometry(mesh, 'MorphGeometry');
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'osgAnimation.MorphGeometry' || k === 'osg.MorphGeometry') continue;
                walk(v, depth + 1);
            }
            // still walk morph internals except duplicate source
            for (const [k, v] of Object.entries(morph)) {
                if (k === 'SourceGeometry') continue;
                walk(v, depth + 1);
            }
            return;
        }

        if (obj['osg.Geometry']) {
            stats.geom++;
            acceptGeometry(obj['osg.Geometry'], 'Geometry');
        }

        for (const v of Object.values(obj)) {
            walk(v, depth + 1);
        }
    }

    walk(node, 0);

    if (!results.length) {
        const errBits = [
            `rig=${stats.rig}`,
            `geom=${stats.geom}`,
            `morph=${stats.morph}`,
            `wire=${stats.wire}`,
            `skip=${stats.skip}`,
        ];
        if (stats.errors.length) {
            errBits.push('errors=' + stats.errors.slice(0, 3).join(' | '));
        }
        console.warn('collectGeometries: no meshes', errBits.join(', '));
    }

    return results;
}


function packGlb(json, bin) {
  const j = JSON.parse(JSON.stringify(json));
  if (j.buffers && j.buffers[0]) delete j.buffers[0].uri;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(j));
  const jsonPadded = pad4(jsonBytes, 0x20);
  const binPadded = pad4(bin, 0);
  const totalLen = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const glb = new Uint8Array(totalLen);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  let o = 12;
  dv.setUint32(o, jsonPadded.length, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4;
  glb.set(jsonPadded, o); o += jsonPadded.length;
  dv.setUint32(o, binPadded.length, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4;
  glb.set(binPadded, o);
  return glb;
}

function indexTextureFiles(textureList) {
  const textureFiles = {};
  if (!textureList || !textureList.length) return textureFiles;
  for (const t of textureList) {
    const base = t.name.split('/').pop();
    const bare = textureBasename(base);
    textureFiles[base] = t.data;
    textureFiles[bare] = t.data;
    textureFiles[t.name] = t.data;
    textureFiles['textures/' + base] = t.data;
    textureFiles['textures/' + bare] = t.data;
    if (t.originalName) {
      textureFiles[t.originalName] = t.data;
      textureFiles['textures/' + t.originalName] = t.data;
    }
    const uidM = base.match(/^([a-f0-9]{32})_/i);
    if (uidM) textureFiles[uidM[1].toLowerCase()] = t.data;
    if (t.uid) textureFiles[String(t.uid).toLowerCase()] = t.data;
    const anyUid = t.name.match(/([a-f0-9]{32})/i);
    if (anyUid) textureFiles[anyUid[1].toLowerCase()] = t.data;
  }
  return textureFiles;
}

/**
 * Flip green channel of a normal map (Sketchfab NormalMap.flipY).
 * Uses OffscreenCanvas when available (Chrome extension SW / pages).
 */
export async function flipNormalMapY(bytes) {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return bytes; // can't flip — leave as-is
  }
  try {
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 1] = 255 - d[i + 1];
    }
    ctx.putImageData(img, 0, 0);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await outBlob.arrayBuffer());
  } catch (_) {
    return bytes;
  }
}

/**
 * Convert Sketchfab osgjs + bins (+ optional textures) to GLB (+ optional external glTF).
 * @param {Map|object|null} viewerMaterials - from parseViewerMaterials(info)
 */
export async function convertOsgjsToGlb(osgjs, polyBin, wireBin, textureList, viewerMaterials = null) {
  const poly = polyBin instanceof Uint8Array
    ? polyBin.buffer.slice(polyBin.byteOffset, polyBin.byteOffset + polyBin.byteLength)
    : polyBin;
  const wire = !wireBin ? null
    : (wireBin instanceof Uint8Array
      ? wireBin.buffer.slice(wireBin.byteOffset, wireBin.byteOffset + wireBin.byteLength)
      : wireBin);

  const geometries = collectGeometries(osgjs, poly, wire);
  if (!geometries.length) {
    throw new Error(
      'No triangle geometries found in osgjs (checked osg.Geometry, RigGeometry.SourceGeometry, MorphGeometry)'
    );
  }

  // Pre-flip normal maps (Sketchfab NormalMap.flipY: true → OpenGL/glTF convention)
  const list = (textureList || []).map((t) => ({ ...t }));
  const needFlipUids = new Set();
  let flipAllNormals = true; // default: flip *_N maps for glTF
  if (viewerMaterials) {
    const vm = viewerMaterials instanceof Map ? viewerMaterials : new Map(Object.entries(viewerMaterials));
    let anySpec = false;
    for (const spec of vm.values()) {
      if (!spec) continue;
      anySpec = true;
      if (spec.normalFlipY && spec.normalUid) {
        needFlipUids.add(String(spec.normalUid).toLowerCase());
      }
    }
    // If materials say flipY explicitly for some, only flip those; else keep flipAllNormals
    if (anySpec && needFlipUids.size > 0) flipAllNormals = false;
  }
  for (const t of list) {
    const bare = textureBasename(t.name);
    const uids = [t.uid, ...(t.imageUids || [])].filter(Boolean).map((x) => String(x).toLowerCase());
    const nameIsNormal = /_n\.(png|jpe?g|webp)$/i.test(bare) || /normal/i.test(bare);
    const uidMatch = uids.some((u) => needFlipUids.has(u));
    const shouldFlip = uidMatch || (flipAllNormals && nameIsNormal);
    if (shouldFlip) {
      t._flipYData = await flipNormalMapY(t.data);
    }
  }

  const textureFiles = indexTextureFiles(list);
  // Register flipped normals under name.__flipY for addImage(..., {flipNormalY:true})
  for (const t of list) {
    if (t._flipYData) {
      const bare = textureBasename(t.name);
      textureFiles[t.name + '.__flipY'] = t._flipYData;
      textureFiles[bare + '.__flipY'] = t._flipYData;
      textureFiles['textures/' + bare + '.__flipY'] = t._flipYData;
      // also make flip path work when looking up by bare + '.__flipY'
      textureFiles[bare + '.__flipY'] = t._flipYData;
    }
  }

  const { global: textureMap, perGeom: perGeomMaps } = buildTextureMaps(
    geometries,
    list,
    textureFiles,
    viewerMaterials
  );

  // glTF reads alpha from baseColorTexture.A. Bake only when albedo + opacity
  // share an atlas (alphaBlend / mask). Sketchfab "dithering" hair uses a
  // second atlas (Hair_M) on another UV — baking it into Hair_AO punches holes.
  const bakedDone = new Map();
  for (const map of perGeomMaps) {
    if (!map || map.skip || !map.albedo || !map.alpha || !map.opacityEnable) continue;
    if (/dither/i.test(String(map.opacityType || ''))) continue;
    const bakeKey = map.albedo + '|' + map.alpha;
    if (bakedDone.has(bakeKey)) {
      map.albedo = bakedDone.get(bakeKey);
      continue;
    }
    const aHit = findTextureBytes(map.albedo, textureFiles);
    const mHit = findTextureBytes(map.alpha, textureFiles);
    if (!aHit || !mHit) continue;
    try {
      const baked = await bakeOpacityIntoAlbedo(aHit.data, mHit.data);
      if (!baked) continue;
      const bakedName =
        textureBasename(map.albedo).replace(/\.[^.]+$/, '') + '_alpha.png';
      textureFiles[bakedName] = baked;
      textureFiles['textures/' + bakedName] = baked;
      list.push({ name: 'textures/' + bakedName, data: baked });
      bakedDone.set(bakeKey, bakedName);
      map.albedo = bakedName;
    } catch (_) {}
  }

  // 1) Embedded GLB
  const embedded = buildGLTF(geometries, textureMap, textureFiles, perGeomMaps, {
    externalTextures: false,
  });
  const glb = packGlb(embedded.json, embedded.bin);
  const textureEmbedCount =
    (embedded.json.images && embedded.json.images.length) || 0;

  // Count non-skipped meshes
  const meshCount = (embedded.json.meshes && embedded.json.meshes.length) || 0;

  // 2) External glTF
  const external = buildGLTF(geometries, textureMap, textureFiles, perGeomMaps, {
    externalTextures: true,
  });
  external.json.buffers = [
    {
      byteLength: external.bin.length,
      uri: 'model.bin',
    },
  ];
  const jsonText = new TextEncoder().encode(
    JSON.stringify(external.json, null, 2)
  );

  const textureAliases = [];
  const usedBare = new Set(
    (external.json.images || [])
      .map((im) => (im.uri || '').replace(/^textures\//, ''))
      .filter(Boolean)
  );
  for (const t of list) {
    const bare = textureBasename(t.name);
    if (usedBare.has(bare)) {
      textureAliases.push({ from: t.name, to: 'textures/' + bare, data: t.data });
    }
  }

  return {
    glb,
    geometryCount: meshCount || geometries.length,
    json: embedded.json,
    textureEmbedCount,
    gltfExternal: {
      jsonText,
      bin: external.bin instanceof Uint8Array ? external.bin : new Uint8Array(external.bin),
      textureAliases,
    },
  };
}

export async function convertOsgjsToGlbFromFiles(fileMap, viewerMaterials = null, textureList = null) {
  // fileMap: { 'file.osgjs': text/bytes, 'model_file.bin': bytes, ... , textures/* }
  let osgjsRaw = fileMap['file.osgjs'];
  if (!osgjsRaw) throw new Error('file.osgjs missing');
  if (osgjsRaw instanceof Uint8Array) osgjsRaw = new TextDecoder().decode(osgjsRaw);
  const osgjs = typeof osgjsRaw === 'string' ? JSON.parse(osgjsRaw) : osgjsRaw;
  const poly = fileMap['model_file.bin'];
  if (!poly) throw new Error('model_file.bin missing');
  const wire = fileMap['model_file_wireframe.bin'] || null;
  const textures = [];
  if (Array.isArray(textureList)) {
    for (const t of textureList) {
      if (t && t.data) textures.push(t);
    }
  } else {
    for (const [name, data] of Object.entries(fileMap)) {
      if (name.startsWith('textures/') && data instanceof Uint8Array) {
        textures.push({ name, data });
      }
    }
  }
  return convertOsgjsToGlb(osgjs, poly, wire, textures, viewerMaterials);
}
