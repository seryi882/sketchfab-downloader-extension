import { decodePngRgba, encodePngRgba } from './descramble.js';
import { isPackedOrmName } from './orm.js';
import {
    axisRotationFor,
    IDENTITY_MAT4,
    mat4Multiply,
    isIdentityMat4,
    normalMatrixFromMat4,
    isIdentityMat3,
    mat3Transpose,
    mat4FromMat3,
    ZUP_TO_YUP_MAT3,
    mat3Invert,
} from './osg-scene.js';
import {
    decodeVarint,
    deltaDecodeInPlace,
    dequantize,
    decodeSpherical,
} from './osg-codec.js';
import {
    collectSkeletons,
    collectAnimations,
    decodeChannelCurve,
    stackedTRS,
    stripNonIncreasingKeys,
} from './skin.js';

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

/** Rotate POSITION/NORMAL/TANGENT in place by a column-major 3x3. */
/**
 * Bake a node's world placement into its vertices.
 *
 * The converter emits a flat list of meshes with no node hierarchy, so a mesh
 * sitting under a transformed node has nowhere to inherit that transform from
 * and would land at the origin. Skinned meshes are exempt: their skeleton
 * already carries the placement, and applying it twice would double it.
 */
function applyPlacement(result, m) {
    if (!m || isIdentityMat4(m)) return;
    const nm = normalMatrixFromMat4(m);
    const pos = result.attributes.POSITION;
    if (pos && pos.data && (pos.itemSize || 0) >= 3) {
        const d = pos.data;
        const stride = pos.itemSize;
        for (let i = 0; i < d.length; i += stride) {
            const x = d[i];
            const y = d[i + 1];
            const z = d[i + 2];
            d[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
            d[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            d[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
    }
    for (const key of ['NORMAL', 'TANGENT']) {
        const attr = result.attributes[key];
        if (!attr || !attr.data || (attr.itemSize || 0) < 3) continue;
        const d = attr.data;
        const stride = attr.itemSize;
        for (let i = 0; i < d.length; i += stride) {
            const x = d[i];
            const y = d[i + 1];
            const z = d[i + 2];
            let nx = nm[0] * x + nm[3] * y + nm[6] * z;
            let ny = nm[1] * x + nm[4] * y + nm[7] * z;
            let nz = nm[2] * x + nm[5] * y + nm[8] * z;
            const len = Math.hypot(nx, ny, nz);
            if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
            d[i] = nx;
            d[i + 1] = ny;
            d[i + 2] = nz;
        }
    }
}

function applyAxisRotation(result, m) {
    if (!m || isIdentityMat3(m)) return;
    for (const key of ['POSITION', 'NORMAL', 'TANGENT']) {
        const attr = result.attributes[key];
        if (!attr || !attr.data || (attr.itemSize || 0) < 3) continue;
        // Positions take the wrapper whole, scale included. Directions must not:
        // the wrapper carries a unit scale on some models, and a normal scaled
        // to 0.01 is no longer a unit vector. A uniform scale leaves the
        // direction alone, so renormalising restores exactly what was meant.
        const isDirection = key !== 'POSITION';
        const d = attr.data;
        const stride = attr.itemSize;
        for (let i = 0; i < d.length; i += stride) {
            const x = d[i];
            const y = d[i + 1];
            const z = d[i + 2];
            let nx = m[0] * x + m[3] * y + m[6] * z;
            let ny = m[1] * x + m[4] * y + m[7] * z;
            let nz = m[2] * x + m[5] * y + m[8] * z;
            if (isDirection) {
                const len = Math.hypot(nx, ny, nz);
                if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
            }
            d[i] = nx;
            d[i + 1] = ny;
            d[i + 2] = nz;
        }
    }
}

// --- Sketchfab binary decoders (extracted from viewer JS) ---

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

/**
 * Quantization box for one UV set.
 *
 * Sketchfab names UV attributes by texture unit -- TexCoord1, TexCoord3,
 * TexCoord12 -- and writes a matching uv_<unit>_* metadata block. It emits
 * bbl/h for the first unit only; later units carry uv_<unit>_bits and
 * uv_<unit>_mode and nothing else, because they are the same base UV map
 * duplicated once per texture unit and share its box.
 *
 * Reading each unit's own box and giving up when it is absent leaves those
 * sets un-dequantized: raw 14-bit integers, ~8191x too large. Nothing
 * downstream catches it -- the file still validates and the first UV set
 * still looks right -- so the fallback matters more than its size suggests.
 */
/**
 * glTF texCoord index per material role, for one geometry's UV layout.
 *
 * The viewer records which *texture unit* a channel samples; the converter
 * renumbers a mesh's TexCoord attributes to a dense TEXCOORD_0..n. Those two
 * agree for the overwhelming majority of meshes, which carry a single UV set,
 * and disagree exactly when a mesh has more than one -- a lightmap bound to
 * the second set would otherwise be sampled with the first set's coordinates.
 *
 * Returns only the roles that need a non-zero index, so a single-UV mesh
 * yields {} and cannot fragment the material cache.
 */
/**
 * Sketchfab's UV transform as KHR_texture_transform.
 *
 * The viewer's shader computes `uv' = mat2(UVTransforms) * uv + UVOffset`, and
 * fills that mat2 (column-major) as
 *
 *   vec4(cos*sx, -sin*sy, sin*sx, cos*sy)   ->   | cos*sx   sin*sx |
 *                                                | -sin*sy  cos*sy |
 *
 * which is S.R: rotate, then scale. glTF specifies translation * rotation *
 * scale, which is R.S: scale, then rotate. The rotation sign convention is the
 * same in both, so offset, rotation and scale pass straight through, and the
 * result is *exact* whenever the two orders commute -- no rotation, or a
 * uniform scale. That covers plain tiling and offsetting, which is what UV
 * transforms are nearly always used for.
 *
 * They do not commute for a non-uniform scale combined with a rotation, and
 * that case is not merely reordered: S.R is a shear that R'.S' cannot equal
 * for any r', s' unless |sx| = |sy|, so KHR_texture_transform cannot express
 * it at all. Emitting the passthrough is still much closer than dropping the
 * transform, but the caller is told so it can say so out loud rather than
 * quietly shipping the wrong placement.
 */
/**
 * Does a Color attribute actually vary from vertex to vertex?
 *
 * Sketchfab attaches a Color attribute to most geometries whether or not the
 * author painted one, and when it is unpainted every vertex carries the same
 * engine tint. Blender multiplies baseColorTexture by COLOR_0, so exporting a
 * constant tint makes a textured model look untextured, transparent or simply
 * wrong -- which is why colour used to be dropped outright.
 *
 * Dropping it outright also loses genuine vertex colour, and a mesh painted
 * per-vertex has no other record of it. Constant-vs-varying is the difference
 * between the two cases, and it is directly measurable.
 */
function colorVaries(data, itemSize) {
    const stride = itemSize || 4;
    if (!data || data.length < stride * 2) return false;
    for (let i = stride; i < data.length; i += stride) {
        for (let c = 0; c < stride; c++) {
            if (data[i + c] !== data[c]) return true;
        }
    }
    return false;
}

export function khrTextureTransform(t) {
    const scale = t.scale || [1, 1];
    const offset = t.offset || [0, 0];
    const rotation = t.rotation || 0;
    const ext = {};
    if (offset[0] !== 0 || offset[1] !== 0) ext.offset = [offset[0], offset[1]];
    if (rotation !== 0) ext.rotation = rotation;
    if (scale[0] !== 1 || scale[1] !== 1) ext.scale = [scale[0], scale[1]];
    // S.R == R.S only when S is a true scalar. A mirrored scale such as
    // [-2, 2] has equal magnitudes but is a reflection, and reflection does not
    // commute with rotation.
    const exact = rotation === 0 || scale[0] === scale[1];
    return { ext, exact };
}

export function texCoordsForGeometry(map, uvUnits) {
    const out = {};
    const units = map && map.uvUnits;
    if (!units || !Array.isArray(uvUnits) || uvUnits.length < 2) return out;
    for (const [role, unit] of Object.entries(units)) {
        if (typeof unit !== 'number') continue;
        const i = uvUnits.indexOf(unit);
        if (i > 0) out[role] = i;
    }
    return out;
}

/** gl.ARRAY_BUFFER / gl.ELEMENT_ARRAY_BUFFER, for bufferView.target. */
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function uvQuantBox(meta, uvSuffix) {
    const own = `uv_${uvSuffix}_`;
    if (meta[own + 'bbl_x'] !== undefined) {
        return {
            bbl: [meta[own + 'bbl_x'], meta[own + 'bbl_y']],
            h: [meta[own + 'h_x'], meta[own + 'h_y']],
        };
    }
    // Lowest-numbered unit that carries a box. Sketchfab always writes one for
    // the first set in use, and the later sets are copies of it.
    let donor = null;
    for (const key of Object.keys(meta)) {
        const m = /^uv_(\d+)_bbl_x$/.exec(key);
        if (!m) continue;
        const n = Number(m[1]);
        if (donor === null || n < donor) donor = n;
    }
    if (donor === null) return null;
    const p = `uv_${donor}_`;
    return {
        bbl: [meta[p + 'bbl_x'], meta[p + 'bbl_y']],
        h: [meta[p + 'h_x'], meta[p + 'h_y']],
    };
}

function processGeometry(geom, polyBin, wireBin, sharedState, axisRotation, placement, opts = {}) {
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
    const lineChunks = [];
    for (const prim of primList) {
        const drawType = Object.keys(prim)[0];
        const draw = prim[drawType];
        const idxInfo = draw.Indices;
        /**
         * A point cloud draws straight from the vertex array: DrawArrays with
         * mode POINTS and no index buffer at all. Sketchfab accepts and renders
         * these, so the converter refusing them was a gap rather than a
         * limitation -- glTF expresses the same thing as a non-indexed
         * primitive with mode 0.
         */
        if (draw.Mode === 'POINTS') {
            result.mode = 'POINTS';
            result.pointCount = (result.pointCount || 0) + (draw.Count || 0);
            continue;
        }
        if (!idxInfo) continue;
        const isLines = draw.Mode === 'LINES';
        if (!isLines && draw.Mode !== 'TRIANGLE_STRIP' && draw.Mode !== 'TRIANGLES') continue;

        const arrInfo = idxInfo.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const isWireframe = arrDef.File && arrDef.File.includes('wireframe');
        /**
         * Sketchfab draws a LINES wireframe overlay for every geometry,
         * authored or not. The copy shares the parent's vertices and keeps only
         * its own index array, in model_file_wireframe.binz; genuine line
         * geometry indexes out of model_file.binz. That is the whole difference
         * between an authored wireframe cube and the viewer's own overlay, and
         * accepting LINES without checking it would give every triangle mesh a
         * duplicate made of edges.
         */
        if (isLines && isWireframe) continue;
        const binSrc = isWireframe ? wireBin : polyBin;
        if (!binSrc) continue;

        /**
         * Line indices are used as they are. Sketchfab expands LINE_STRIP and
         * LINE_LOOP into explicit segments on import -- a 49-point strip
         * arrives as 96 indices, a 5-point loop as 10 with the closing edge
         * already present -- so mode 1 is the only line mode that ever reaches
         * here, and there is no strip to unroll or loop to close.
         */
        if (isLines) {
            result.mode = 'LINES';
            const li = widenIndices(
                readBufferArray(asArrayBuffer(binSrc), { ...arrDef, ItemSize: 1 }, arrType)
            );
            lineChunks.push(li);
            continue;
        }

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

    if (result.mode === 'LINES') {
        let n = 0;
        for (const c of lineChunks) n += c.length;
        if (n) {
            const merged = new Uint32Array(n);
            let o = 0;
            for (const c of lineChunks) { merged.set(c, o); o += c.length; }
            result.indices = merged;
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
    //
    // A geometry with no triangles is normally not worth reading. A morph
    // target is the exception: it carries only vertex data and borrows its
    // topology from the mesh it belongs to.
    if (!result.indices && result.mode !== 'POINTS' && !opts.attributesOnly) return result;
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
                decodeSpherical(data, floats, 3, meta.epsilon, meta.nphi);
                result.attributes.NORMAL = { data: floats, itemSize: 3, count };
            } else {
                result.attributes.NORMAL = { data, itemSize, count };
            }
        } else if (attrName === 'Tangent') {
            if (attrFlags & 32) {
                const floats = new Float32Array(count * 4);
                decodeSpherical(data, floats, 4, meta.epsilon, meta.nphi);
                result.attributes.TANGENT = { data: floats, itemSize: 4, count };
            }
        } else if (attrName.startsWith('TexCoord')) {
            const uvSuffix = attrName.replace('TexCoord', '');
            const uvMode = meta[`uv_${uvSuffix}_mode`] !== undefined ? meta[`uv_${uvSuffix}_mode`] : (meta.vertex_mode || 0);
            // Apply parallelogram prediction
            if ((uvMode & 2) && result.stripIndices) {
                parallelogramPredict(data, itemSize, result.stripIndices);
            }
            // Dequantize
            const box = uvQuantBox(meta, uvSuffix);
            if (box && ((attrFlags & 4) || (uvMode & 1))) {
                const floats = new Float32Array(data.length);
                dequantize(data, floats, box.bbl, box.h, itemSize);
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
            //
            // The tint is constant by definition, so variation is the thing
            // that separates it from real authored vertex colour -- a far
            // better discriminator than the primitive mode alone, and it costs
            // one pass over an attribute already in memory.
            //
            // A point cloud is kept regardless: it has no triangles, no UVs and
            // no textures, so colour is the only surface information in the
            // file, and a single-colour cloud is still the author's intent.
            if (result.mode === 'POINTS' || colorVaries(data, itemSize)) {
                const isFloat = data instanceof Float32Array;
                result.attributes.COLOR_0 = {
                    data,
                    itemSize,
                    count,
                    componentType: isFloat ? 5126 : 5121,
                    normalized: !isFloat,
                };
            }
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

    // Baked into the vertices rather than carried on a parent matrix: it
    // matches official Sketchfab mesh bounds, and the flattened node tree has
    // nowhere to hang a transform.
    // Placement is in the viewer's own frame, so it has to land before the
    // model is turned into glTF's.
    applyPlacement(result, placement);
    if (!opts.skipAxis) applyAxisRotation(result, axisRotation);

    return result;
}

// --- Texture helpers ---

/** Basename of a texture path, strip optional "32hexuid_" prefix from download naming. */
export function textureBasename(filename) {
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
 * Resolve the PBR factors for a material, and whether its metal/rough texture
 * may be bound to metallicRoughnessTexture.
 *
 * glTF reads that texture as packed: green = roughness, blue = metalness.
 * Sketchfab's single-channel `*_metallic` map is therefore only safe to bind
 * after it has been packed with the matching roughness map — otherwise its
 * green channel drives roughness and non-metal surfaces render as mirrors.
 * Without a packed map the numeric factors from the viewer are authoritative,
 * including an explicit metallicFactor of 0.
 *
 * @param {object|null} map
 * @returns {{metallicFactor: number, roughnessFactor: number, bindTexture: boolean}}
 */
export function pbrFactors(map) {
    const metalF = map && typeof map.metallicFactor === 'number' ? map.metallicFactor : 0;
    const roughF = map && typeof map.roughnessFactor === 'number' ? map.roughnessFactor : 0.9;
    if (map && map.metalness && map.ormPacked) {
        // Factors multiply the texture, so 1.0 lets the map drive both channels.
        return { metallicFactor: 1, roughnessFactor: 1, bindTexture: true };
    }
    return { metallicFactor: metalF, roughnessFactor: roughF, bindTexture: false };
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

/**
 * The image's real format, read from its magic bytes.
 *
 * Sketchfab serves textures whose names outlived their contents: the low-poly
 * compilation ships 30 files called .jpg that are PNG all the way through,
 * because the descrambler re-encodes through a canvas and keeps the original
 * name. Trusting the extension writes a mimeType into the glTF that contradicts
 * the bytes sitting next to it -- a spec violation strict loaders may reject.
 */
export function mimeFromBytes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
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
export function resolveUidToBase(uid, textureList) {
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

function texDims(t) {
    if (!t) return { w: 0, h: 0 };
    if ((t.width || 0) > 0 && (t.height || 0) > 0) {
        return { w: t.width, h: t.height };
    }
    const d = t.data;
    if (d instanceof Uint8Array && d.length >= 24 && d[0] === 0x89 && d[1] === 0x50) {
        const w = ((d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19]) >>> 0;
        const h = ((d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23]) >>> 0;
        return { w, h };
    }
    return { w: 0, h: 0 };
}

function texMetaByName(textureList, name) {
    if (!name) return null;
    const b = textureBasename(name).toLowerCase();
    for (const t of textureList || []) {
        if (textureBasename(t.name).toLowerCase() === b) return t;
    }
    return null;
}

/**
 * Prefer a large color map on SpecularPBR when Diffuse/Albedo is a tiny
 * leftover (Maya often parks the real jeans/cloth atlas on SpecularPBR).
 * Never promote a name-classified specular/normal/ORM map.
 */
export function chooseAlbedoName(albedoName, specularName, textureList) {
    if (!specularName) return albedoName || null;
    const cls = classifyTextureName(specularName);
    if (cls === 'normal' || cls === 'metalrough' || cls === 'specular' || cls === 'alpha') {
        return albedoName || null;
    }
    const a = texMetaByName(textureList, albedoName);
    const s = texMetaByName(textureList, specularName);
    const aa = (() => {
        const d = texDims(a);
        return d.w * d.h;
    })();
    const sa = (() => {
        const d = texDims(s);
        return d.w * d.h;
    })();
    const weak = !albedoName || aa < 512 * 512;
    if (weak && sa > Math.max(aa, 1) * 2) return specularName;
    return albedoName || null;
}

/** Empty hair/line shells with no albedo AND no opacity atlas. */
export function shouldSkipUntexturedShell(spec, matName, geomName, mode) {
    if (!spec) return false;
    if (spec.skipMesh) return true;
    if (spec.albedoUid || spec.opacityUid) return false;
    /**
     * The name test below drops untextured hair and eyelash cards, and "line"
     * earns its place there because those shells are usually named for the
     * lines they draw. Genuine line geometry matches it by definition -- a
     * material called ML01_Lines on a mesh made of edges is the true positive
     * the heuristic was never meant to catch -- and lines carry no albedo, so
     * every one of them would be dropped as a shell.
     *
     * An invisible or glass mesh is still skipped above; only the name guess
     * is scoped to triangles.
     */
    if (mode === 'LINES' || mode === 'POINTS') return false;
    return /hair|line|brow|lash/i.test(String(matName || geomName || ''));
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

/**
 * Multiply an opacity map into the albedo's alpha channel.
 *
 * Reports whether the result actually carries transparency: Sketchfab ships a
 * flat white Opacity map for plenty of fully opaque materials, and exporting
 * those as BLEND makes Blender/EEVEE drop depth writes, so a solid object
 * renders see-through.
 *
 * @returns {Promise<{data: Uint8Array, hasTransparency: boolean}|null>}
 */
export async function bakeOpacityIntoAlbedo(albedoBytes, alphaBytes) {
    const a = await decodePngRgba(albedoBytes);
    const m = await decodePngRgba(alphaBytes);
    if (!a.width || !m.width) return null;
    const out = new Uint8ClampedArray(a.rgba);
    const same = a.width === m.width && a.height === m.height;
    let hasTransparency = false;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const o = (y * a.width + x) * 4;
            const lum = same
                ? (m.rgba[o] * 77 + m.rgba[o + 1] * 150 + m.rgba[o + 2] * 29) >> 8
                : sampleLum(m.rgba, m.width, m.height, x / (a.width - 1 || 1), y / (a.height - 1 || 1));
            const v = Math.round((out[o + 3] * lum) / 255);
            out[o + 3] = v;
            if (v < 250) hasTransparency = true;
        }
    }
    return {
        data: await encodePngRgba(out, a.width, a.height),
        hasTransparency,
    };
}

async function bakeTintWithAlpha(factor, alphaBytes) {
    const m = await decodePngRgba(alphaBytes);
    if (!m.width) return null;
    const r = Math.round(Math.max(0, Math.min(1, factor[0] ?? 1)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, factor[1] ?? 1)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, factor[2] ?? 1)) * 255);
    let alphaUseful = false;
    const n = m.width * m.height;
    for (let i = 0; i < n; i++) {
        if (m.rgba[i * 4 + 3] < 250) {
            alphaUseful = true;
            break;
        }
    }
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const lum = (m.rgba[o] * 77 + m.rgba[o + 1] * 150 + m.rgba[o + 2] * 29) >> 8;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = alphaUseful ? m.rgba[o + 3] : lum;
    }
    return encodePngRgba(out, m.width, m.height);
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
            if (shouldSkipUntexturedShell(spec, matName, geom.name, geom.mode)) {
                return { skip: true };
            }
            let albedo = resolveUidToBase(spec.albedoUid, list);
            const specularName = resolveUidToBase(spec.specularUid, list);
            albedo = chooseAlbedoName(albedo, specularName, list);
            const alpha = resolveUidToBase(spec.opacityUid, list);
            const usedOpacityAsAlbedo = !albedo && !!alpha;
            if (usedOpacityAsAlbedo) albedo = alpha;
            let metalTex = resolveUidToBase(spec.metalnessUid, list);
            let metallicFactor = spec.metallicFactor != null ? spec.metallicFactor : 0;
            // Sketchfab often points MetalnessPBR at a *_D color/id map, not ORM.
            // Dropping it must also drop factor=1, or hair cards go chrome.
            if (metalTex && classifyTextureName(metalTex) === 'albedo') metalTex = null;
            if (spec.metalnessUid && !metalTex) metallicFactor = 0;
            // Sketchfab serves metalness and roughness separately; the pipeline
            // packs them into one ORM map. Only a genuinely packed texture may
            // drive metallicRoughnessTexture (see pbrFactors).
            let ormPacked = false;
            if (spec.packedOrmName) {
                metalTex = spec.packedOrmName;
                ormPacked = true;
            } else if (metalTex && isPackedOrmName(metalTex)) {
                ormPacked = true;
            }
            const map = {
                albedo,
                normal: resolveUidToBase(spec.normalUid, list),
                metalness: metalTex,
                ormPacked,
                emissive: resolveUidToBase(spec.emitUid, list),
                occlusion: resolveUidToBase(spec.aoUid, list),
                alpha,
                metallicFactor,
                roughnessFactor: spec.roughnessFactor != null ? spec.roughnessFactor : 0.9,
                normalFlipY: !!spec.normalFlipY,
                // Opacity-only cards keep the viewer tint. Real albedo must not
                // be multiplied by a leftover DiffuseColor.
                baseColorFactor: usedOpacityAsAlbedo
                    ? (spec.baseColorFactor || [1, 1, 1, 1])
                    : albedo
                      ? [1, 1, 1, 1]
                      : (spec.baseColorFactor || [1, 1, 1, 1]),
                opacityEnable: !!spec.opacityEnable,
                opacityFactor: spec.opacityFactor,
                opacityType: spec.opacityType,
                transmission: !!spec.transmission,
                opacityAsAlbedo: usedOpacityAsAlbedo,
                clearCoat: spec.clearCoat
                    ? {
                        ...spec.clearCoat,
                        texture: resolveUidToBase(spec.clearCoat.textureUid, list),
                        normalTexture: resolveUidToBase(spec.clearCoat.normalTextureUid, list),
                      }
                    : null,
                sheen: spec.sheen
                    ? { ...spec.sheen, texture: resolveUidToBase(spec.sheen.textureUid, list) }
                    : null,
                doubleSided: spec.doubleSided !== false,
                // Non-identity UV transform per role, for KHR_texture_transform.
                uvTransforms: (() => {
                    const at = (uid) =>
                        uid && spec.uvTransforms ? spec.uvTransforms[uid] : undefined;
                    return {
                        albedo: at(spec.albedoUid),
                        normal: at(spec.normalUid),
                        metalness: at(spec.metalnessUid),
                        emissive: at(spec.emitUid),
                        occlusion: at(spec.aoUid),
                        clearCoat: spec.clearCoat ? at(spec.clearCoat.textureUid) : undefined,
                        sheen: spec.sheen ? at(spec.sheen.textureUid) : undefined,
                    };
                })(),
                // Wrap mode per role, so a clamped or mirrored texture keeps
                // its sampler instead of falling back to the global REPEAT.
                wraps: (() => {
                    const at = (uid) =>
                        uid && spec.textureWraps ? spec.textureWraps[uid] : undefined;
                    return {
                        albedo: at(spec.albedoUid),
                        normal: at(spec.normalUid),
                        metalness: at(spec.metalnessUid),
                        emissive: at(spec.emitUid),
                        occlusion: at(spec.aoUid),
                        clearCoat: spec.clearCoat ? at(spec.clearCoat.textureUid) : undefined,
                        sheen: spec.sheen ? at(spec.sheen.textureUid) : undefined,
                    };
                })(),
                // Which texture unit each role samples, so a material bound to
                // a second UV set can be pointed at the right TEXCOORD_n.
                uvUnits: (() => {
                    const at = (uid) =>
                        uid && spec.texCoordUnits ? spec.texCoordUnits[uid] : undefined;
                    return {
                        albedo: at(spec.albedoUid),
                        normal: at(spec.normalUid),
                        metalness: at(spec.metalnessUid),
                        emissive: at(spec.emitUid),
                        occlusion: at(spec.aoUid),
                        clearCoat: spec.clearCoat ? at(spec.clearCoat.textureUid) : undefined,
                        sheen: spec.sheen ? at(spec.sheen.textureUid) : undefined,
                    };
                })(),
                via: found.via,
            };
            /**
             * Drop wrap and transform records for roles that resolved to no
             * texture. They cannot affect the emitted material, but they are
             * part of its cache key, so leaving them in splits materials that
             * are byte-for-byte identical.
             */
            const hasTexture = {
                albedo: !!map.albedo,
                normal: !!map.normal,
                metalness: !!map.metalness,
                emissive: !!map.emissive,
                occlusion: !!map.occlusion,
                clearCoat: !!(map.clearCoat && (map.clearCoat.texture || map.clearCoat.normalTexture)),
                sheen: !!(map.sheen && map.sheen.texture),
            };
            for (const field of ['wraps', 'uvTransforms']) {
                if (!map[field]) continue;
                for (const role of Object.keys(map[field])) {
                    if (!hasTexture[role] || map[field][role] === undefined) {
                        delete map[field][role];
                    }
                }
                if (!Object.keys(map[field]).length) map[field] = null;
            }

            // Only name-fallback when the viewer pointed at a uid we failed to resolve.
            // Hair_03 / untextured shells have albedoUid=null — do not steal Hair_D.
            if (!map.albedo && spec.albedoUid) {
                const byName = mapTexturesForName(matName, geom.name, list);
                if (byName && byName.albedo) map.albedo = byName.albedo;
                if (byName && byName.normal && !map.normal) map.normal = byName.normal;
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
        samplers: [],
        skins: [],
        animations: []
    };
    // Extensions are only declared when a material actually emits one.
    const usedExtensions = new Set();
    /**
     * Sketchfab rotates then scales; glTF scales then rotates. With a
     * non-uniform scale those are different transforms and no
     * KHR_texture_transform reproduces theirs, so say so once rather than
     * shipping a silently misplaced texture.
     */
    const warnedTransforms = new Set();
    function warnInexactTransform(matName, role, t) {
        // buildGLTF runs twice, once embedded and once external. Warn from the
        // embedded pass only, or every note is printed in duplicate.
        if (externalTextures) return;
        const key = `${matName}|${role}`;
        if (warnedTransforms.has(key)) return;
        warnedTransforms.add(key);
        console.warn(
            `  Note: ${matName} ${role} combines a non-uniform scale ` +
            `[${t.scale[0]}, ${t.scale[1]}] with a ${(t.rotation * 180 / Math.PI).toFixed(1)}deg ` +
            'rotation. glTF applies scale before rotation and Sketchfab after, ' +
            'so this placement cannot be reproduced exactly; exported as the ' +
            'closest KHR_texture_transform.'
        );
    }

    const binChunks = [];
    let byteOffset = 0;

    function addAccessor(data, type, componentType, count, itemSize, normalized, opts = {}) {
        const typeMap = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4' };
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
            /**
             * target tells a loader which GL buffer this belongs in, so it can
             * upload straight to the GPU instead of inspecting every accessor
             * first. It is only meaningful for vertex and index data, so it is
             * passed in rather than inferred -- inverse bind matrices and
             * animation curves are neither, and labelling those would be wrong
             * rather than merely redundant.
             */
            ...(opts.target ? { target: opts.target } : {}),
            ...(!isIndex && !opts.noStride && itemSize > 1
                ? { byteStride: itemSize * buf.BYTES_PER_ELEMENT }
                : {})
        });

        const min = [], max = [];
        if (!opts.noMinMax) {
            for (let j = 0; j < itemSize; j++) { min.push(Infinity); max.push(-Infinity); }
            for (let i = 0; i < count; i++) {
                for (let j = 0; j < itemSize; j++) {
                    const v = buf[i * itemSize + j];
                    if (v < min[j]) min[j] = v;
                    if (v > max[j]) max[j] = v;
                }
            }
        }

        const accIdx = gltf.accessors.length;
        gltf.accessors.push({
            bufferView: bvIdx, byteOffset: 0, componentType,
            count, type: typeMap[itemSize] || 'SCALAR',
            ...(opts.noMinMax ? {} : { min, max }),
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

    /**
     * Sampler per distinct wrap pair, allocated on demand.
     *
     * Sampler 0 stays the REPEAT default and is reused for every texture that
     * does not ask for anything else, so a model with no clamped or mirrored
     * maps -- almost all of them -- ends up with exactly the samplers[] it had
     * before.
     */
    const GL_WRAP = {
        REPEAT: 10497,
        CLAMP_TO_EDGE: 33071,
        MIRRORED_REPEAT: 33648,
    };
    const samplerCache = { '10497|10497': 0 };
    function samplerFor(wrap) {
        const wrapS = GL_WRAP[wrap && wrap.wrapS] || 10497;
        const wrapT = GL_WRAP[wrap && wrap.wrapT] || 10497;
        const key = `${wrapS}|${wrapT}`;
        if (samplerCache[key] !== undefined) return samplerCache[key];
        const idx = gltf.samplers.length;
        gltf.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS, wrapT });
        samplerCache[key] = idx;
        return idx;
    }

    // Cache filename → texture index so multi-material shares images
    const texIndexCache = Object.create(null);

    // Optional sync placeholder — flipNormalY applied later async-free via preprocessed textureFiles
    /**
     * Images are cached separately from textures.
     *
     * A glTF texture is an image plus a sampler, so one image used at two wrap
     * modes is two textures -- but it must stay one image, or its bytes are
     * embedded twice and a large albedo doubles the size of the GLB.
     */
    const imgIndexCache = Object.create(null);

    function addImage(filename, opts = {}) {
        if (!filename || !textureFiles) return -1;
        const imgKey =
            String(filename).split('/').pop().toLowerCase() +
            (opts.flipNormalY ? '|fy' : '');
        if (imgIndexCache[imgKey] !== undefined) return imgIndexCache[imgKey];
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
        if (!hit) {
            imgIndexCache[imgKey] = -1;
            return -1;
        }
        const imgData = hit.data;
        const keyName = hit.key.replace(/\.__flipY$/, '');
        const bare = textureBasename(keyName) + (opts.flipNormalY ? '_flipY' : '');
        const mimeType = mimeFromBytes(imgData) || mimeFromName(keyName);
        const imgIdx = gltf.images.length;

        // External .gltf mode: reference textures/ on disk (Blender loads these reliably)
        if (externalTextures) {
            const uriBare = textureBasename(keyName);
            gltf.images.push({
                uri: 'textures/' + uriBare,
                mimeType,
                name: uriBare,
            });
            imgIndexCache[imgKey] = imgIdx;
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
        imgIndexCache[imgKey] = imgIdx;
        return imgIdx;
    }

    function addTexture(filename, opts = {}) {
        if (!filename) return -1;
        const flip = !!opts.flipNormalY;
        const sampler = samplerFor(opts.wrap);
        // A glTF texture is an image *and* a sampler, so the same image used
        // once clamped and once repeating is two textures, not one.
        const cacheKey =
            String(filename).split('/').pop().toLowerCase() +
            (flip ? '|fy' : '') +
            (sampler ? `|s${sampler}` : '');
        if (texIndexCache[cacheKey] !== undefined) return texIndexCache[cacheKey];
        const imgIdx = addImage(filename, opts);
        if (imgIdx < 0) {
            texIndexCache[cacheKey] = -1;
            return -1;
        }
        const texIdx = gltf.textures.length;
        gltf.textures.push({ source: imgIdx, sampler });
        texIndexCache[cacheKey] = texIdx;
        return texIdx;
    }

    /**
     * Build a glTF PBR material from viewer channel specs.
     * Defaults match Sketchfab lit/PBR: metalness 0, no invented ORM maps.
     */
    function makeMaterial(name, map, texCoords = {}) {
        const tc = (role) => texCoords[role] || 0;
        const wr = (role) => (map && map.wraps ? map.wraps[role] : undefined);
        /**
         * One glTF textureInfo: the index, which UV set it reads, and its
         * placement on that set. Built in one place so a role cannot pick up
         * the right sampler and the wrong transform.
         */
        const texInfo = (role, index) => {
            const info = { index, texCoord: tc(role) };
            const t = map && map.uvTransforms ? map.uvTransforms[role] : null;
            if (t) {
                const { ext, exact } = khrTextureTransform(t);
                if (Object.keys(ext).length) {
                    info.extensions = { KHR_texture_transform: ext };
                    usedExtensions.add('KHR_texture_transform');
                    if (!exact) warnInexactTransform(name, role, t);
                }
            }
            return info;
        };
        const baseF = (map && map.baseColorFactor) || [1, 1, 1, 1];
        const factors = pbrFactors(map);
        const material = {
            name: name || 'Material',
            // Unculled unless the viewer said otherwise; a map with no
            // sided-ness information keeps the old permissive default.
            doubleSided: !map || map.doubleSided !== false,
            pbrMetallicRoughness: {
                baseColorFactor: baseF.slice(0, 4),
                metallicFactor: factors.metallicFactor,
                roughnessFactor: factors.roughnessFactor,
            }
        };
        if (map && map.via) {
            material.extras = { via: map.via };
        }

        if (map) {
            if (map.albedo) {
                const idx = addTexture(map.albedo, { wrap: wr('albedo') });
                if (idx >= 0) {
                    material.pbrMetallicRoughness.baseColorTexture = texInfo('albedo', idx);
                }
            }
            if (map.metalness && factors.bindTexture) {
                const idx = addTexture(map.metalness, { wrap: wr('metalness') });
                if (idx >= 0) {
                    material.pbrMetallicRoughness.metallicRoughnessTexture = {
                        ...texInfo('metalness', idx),
                    };
                }
            }
            if (map.normal) {
                // flipY handled when packing texture bytes (see flipNormalMapY)
                const idx = addTexture(map.normal, { flipNormalY: !!map.normalFlipY, wrap: wr('normal') });
                if (idx >= 0) material.normalTexture = { ...texInfo('normal', idx), scale: 1 };
            }
            if (map.emissive) {
                const idx = addTexture(map.emissive, { wrap: wr('emissive') });
                if (idx >= 0) {
                    material.emissiveTexture = texInfo('emissive', idx);
                    material.emissiveFactor = [1, 1, 1];
                }
            }
            if (map.occlusion) {
                const idx = addTexture(map.occlusion, { wrap: wr('occlusion') });
                if (idx >= 0) material.occlusionTexture = { ...texInfo('occlusion', idx), strength: 1 };
            }
            // Opacity / cutout from viewer material
            const opType = String(map.opacityType || '');
            if (map.transmission) {
                // Sketchfab "refraction" glass. KHR_materials_transmission keeps
                // it see-through while the roughness map still drives the
                // reflection, which BLEND cannot do. Spec says stay OPAQUE.
                material.extensions = material.extensions || {};
                material.extensions.KHR_materials_transmission = { transmissionFactor: 1 };
                material.alphaMode = 'OPAQUE';
                material.doubleSided = false;
                usedExtensions.add('KHR_materials_transmission');
            } else if (map.forceOpaque) {
                // Opacity map baked out to fully opaque — see bakeOpacityIntoAlbedo
                material.alphaMode = 'OPAQUE';
            } else if (map.opacityEnable && /dither/i.test(opType)) {
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

            /**
             * Clearcoat and sheen ride along as glTF extensions. Sketchfab
             * declares both channels on every material, so these are only
             * populated when the viewer had them switched on -- see
             * parseViewerMaterials.
             */
            if (map.clearCoat) {
                const ext = { clearcoatFactor: map.clearCoat.factor };
                if (typeof map.clearCoat.roughness === 'number') {
                    ext.clearcoatRoughnessFactor = map.clearCoat.roughness;
                }
                if (map.clearCoat.texture) {
                    const idx = addTexture(map.clearCoat.texture, { wrap: wr('clearCoat') });
                    if (idx >= 0) ext.clearcoatTexture = texInfo('clearCoat', idx);
                }
                if (map.clearCoat.normalTexture) {
                    const idx = addTexture(map.clearCoat.normalTexture, {
                        flipNormalY: !!map.clearCoat.normalFlipY,
                        wrap: wr('clearCoat'),
                    });
                    if (idx >= 0) ext.clearcoatNormalTexture = texInfo('clearCoat', idx);
                }
                material.extensions = material.extensions || {};
                material.extensions.KHR_materials_clearcoat = ext;
                usedExtensions.add('KHR_materials_clearcoat');
            }
            if (map.sheen) {
                const ext = { sheenColorFactor: map.sheen.colorFactor.slice(0, 3) };
                if (typeof map.sheen.roughness === 'number') {
                    ext.sheenRoughnessFactor = map.sheen.roughness;
                }
                if (map.sheen.texture) {
                    const idx = addTexture(map.sheen.texture, { wrap: wr('sheen') });
                    if (idx >= 0) ext.sheenColorTexture = texInfo('sheen', idx);
                }
                material.extensions = material.extensions || {};
                material.extensions.KHR_materials_sheen = ext;
                usedExtensions.add('KHR_materials_sheen');
            }
        }

        return material;
    }

    // Material cache keyed by map signature
    const matCache = Object.create(null);
    function materialIndexFor(map, geomName, uvUnits) {
        // Two geometries can share every texture and still need different
        // bindings when their UV layouts differ, so the resolved indices are
        // part of the cache key. They are empty for single-UV meshes, which is
        // nearly all of them, so the key is unchanged in the common case.
        const texCoords = texCoordsForGeometry(map, uvUnits);
        const key = map
            ? [
                'a:' + (map.albedo || ''),
                'n:' + (map.normal || ''),
                'm:' + (map.metalness || ''),
                'op:' + (map.ormPacked ? 1 : 0),
                'e:' + (map.emissive || ''),
                'o:' + (map.occlusion || ''),
                'mf:' + (map.metallicFactor != null ? map.metallicFactor : ''),
                'rf:' + (map.roughnessFactor != null ? map.roughnessFactor : ''),
                'fy:' + (map.normalFlipY ? 1 : 0),
                'ds:' + (map.doubleSided === false ? 0 : 1),
                'al:' + (map.alpha || ''),
                'oe:' + (map.opacityEnable ? 1 : 0),
                'ot:' + (map.opacityType || ''),
                'cc:' + (map.clearCoat
                    ? [
                        map.clearCoat.factor,
                        map.clearCoat.roughness,
                        map.clearCoat.texture || '',
                        map.clearCoat.normalTexture || '',
                        map.clearCoat.normalFlipY ? 1 : 0,
                      ].join(',')
                    : ''),
                'sh:' + (map.sheen
                    ? [map.sheen.colorFactor.join(','), map.sheen.roughness, map.sheen.texture || ''].join(',')
                    : ''),
                'tc:' + JSON.stringify(texCoords),
                'wr:' + (map.wraps ? JSON.stringify(map.wraps) : ''),
                'ut:' + (map.uvTransforms ? JSON.stringify(map.uvTransforms) : ''),
              ].join('|')
            : '__default__';
        if (matCache[key] !== undefined) return matCache[key];
        const mat = makeMaterial(geomName || 'Material', map, texCoords);
        const idx = gltf.materials.length;
        gltf.materials.push(mat);
        matCache[key] = idx;
        return idx;
    }

    // Ensure at least one material exists (fallback if no meshes pass filters)
    if (!textureMap) textureMap = null;

    const axisRotation = options.axisRotation || ZUP_TO_YUP_MAT3;
    const AXIS_MAT4 = mat4FromMat3(axisRotation);
    // The editor orientation lives in viewer options, not the scene, so it has
    // to be re-applied here or the model arrives in whatever pose it was
    // uploaded in. Vertices already carry the axis fix A, so hanging a bare O
    // off the root would compose as O*A when the viewer's order is A*O. The
    // conjugate A*O*inv(A) puts it back in the right order, and works for
    // skinned meshes too: glTF ignores their own node transform but the joints
    // sit under this root, so the skeleton carries it for them.
    const orientationMat = options.orientation || null;
    // A true inverse, not the transpose: the axis wrapper may carry a unit
    // scale, and transposing a scaled rotation reapplies the scale instead of
    // undoing it, which is what left one model's bind pose 100x out.
    const AXIS_INVERSE_MAT4 = mat4FromMat3(
        mat3Invert(axisRotation) || mat3Transpose(axisRotation)
    );
    const rootMatrix = orientationMat
        ? mat4Multiply(mat4Multiply(AXIS_MAT4, orientationMat), AXIS_INVERSE_MAT4)
        : null;

    const meshNodes = [];
    const skinnedMeshNodes = [];
    /**
     * Separate from boneNodeIndex on purpose. Skin binding resolves names out
     * of a RigGeometry's BoneMap and must keep matching bone names exactly;
     * adding animation aliases to that map risks binding a mesh to the wrong
     * joint. Animation targets get their own lookup.
     */
    const animTargetIndex = new Map();
    /** Nodes for animated transforms, built on demand and shared by every mesh under one. */
    const animNodeByCtx = new Map();
    const animRootNodes = [];

    /**
     * The glTF node an animated transform becomes, creating it and its parents
     * if this is the first mesh to need them.
     *
     * The chain mirrors the scene: a static offset node carrying whatever sat
     * between this transform and the one above it, then the transform itself
     * holding the resting TRS an animation will overwrite. The outermost offset
     * also carries the axis fix, which meshes below here deliberately do not
     * bake into their vertices.
     */
    function nodeForAnimCtx(ctx) {
        if (!ctx) return -1;
        const cached = animNodeByCtx.get(ctx);
        if (cached !== undefined) return cached;

        const parentIdx = ctx.parent ? nodeForAnimCtx(ctx.parent) : -1;
        const offset = ctx.parent ? ctx.pre : mat4Multiply(AXIS_MAT4, ctx.pre);
        let anchor = parentIdx;
        if (!isIdentityMat4(offset)) {
            const idx = gltf.nodes.length;
            gltf.nodes.push({
                name: `${ctx.name || 'Animated'}_placement`,
                matrix: Array.from(offset),
                children: [],
            });
            if (anchor >= 0) gltf.nodes[anchor].children.push(idx);
            else animRootNodes.push(idx);
            anchor = idx;
        }

        const idx = gltf.nodes.length;
        const node = { name: ctx.name || 'Animated', children: [] };
        const trs = ctx.trs || {};
        if (trs.translation) node.translation = Array.from(trs.translation);
        if (trs.rotation) node.rotation = Array.from(trs.rotation);
        if (trs.scale) node.scale = Array.from(trs.scale);
        gltf.nodes.push(node);
        if (anchor >= 0) gltf.nodes[anchor].children.push(idx);
        else animRootNodes.push(idx);

        animNodeByCtx.set(ctx, idx);
        if (ctx.name && !animTargetIndex.has(ctx.name)) animTargetIndex.set(ctx.name, idx);
        return idx;
    }
    /**
     * Morph target name -> which mesh node it belongs to and its slot in that
     * mesh's target list. osgjs drives each target with its own scalar channel;
     * glTF wants one channel per mesh carrying every weight, so the curves have
     * to be regrouped by node before they can be written.
     */
    const morphTargetIndex = new Map();

    /**
     * Every geometry that does not reach the output, and why.
     *
     * All three of the drops this converter got wrong were silent: a faceplate,
     * a model's line geometry and its own transmission fixture each vanished
     * with nothing written down, and each was only found because someone opened
     * the file and noticed a hole. A dropped mesh should leave a trace.
     */
    const skipped = [];

    let geomI = 0;
    for (const geom of geometries) {
        // A point cloud has no index buffer by construction, so "no indices"
        // is only a reason to skip when the geometry claimed to be triangles.
        const isPoints = geom.mode === 'POINTS';
        const isLines = geom.mode === 'LINES';
        if ((!geom.indices && !isPoints) || !geom.attributes.POSITION) {
            skipped.push({ name: geom.name || `geometry_${geomI}`, reason: 'no geometry data' });
            geomI++;
            continue;
        }

        const map = (perGeomMaps && perGeomMaps[geomI]) || textureMap;
        // Skip glass / invisible rim shells (viewer opacity 0 or additive ghost)
        if (map && map.skip) {
            skipped.push({
                name: geom.name || `geometry_${geomI}`,
                reason: 'the viewer does not draw it (opacity 0)',
            });
            geomI++;
            continue;
        }
        /**
         * There is no name test here on purpose.
         *
         * Dropping anything called "glass" unless it carried an albedo texture
         * was meant to remove invisible rim shells, but it also removed real
         * glass: a robot's tinted faceplate is a solid colour with no texture,
         * so it matched the guess exactly and vanished while the viewer drew it.
         *
         * The genuine signal is already read from the viewer and applied above
         * as map.skip -- spec.skipMesh is invisible || (named veil without
         * transmission) -- which is evidence about the material rather than a
         * guess about its name.
         */
        const matName =
            geom.materialName ||
            geom.name ||
            ('Material_' + geomI);
        const matIdx = materialIndexFor(map, matName, geom.uvUnits);

        const primitive = { attributes: {}, material: matIdx, mode: isPoints ? 0 : isLines ? 1 : 4 };

        // Indices
        if (!isPoints) {
            const idx = geom.indices;
            const idxType = idx.BYTES_PER_ELEMENT === 4 ? 5125 : 5123;
            primitive.indices = addAccessor(idx, 'SCALAR', idxType, idx.length, 1, false, { target: ELEMENT_ARRAY_BUFFER });
        }

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
                norm,
                { target: ARRAY_BUFFER }
            );
        }

        // Safety: if no TEXCOORD_0 but material uses textures, Blender won't show maps
        // (a point cloud has no UVs and no textures, so there is nothing to bind)
        if (
            !isPoints &&
            !isLines &&
            !primitive.attributes.TEXCOORD_0 &&
            map &&
            (map.albedo || map.normal || map.metalness)
        ) {
            // synthesize 0,0 UVs so importers still bind the image node
            const nVerts = geom.attributes.POSITION.count;
            const zeros = new Float32Array(nVerts * 2);
            primitive.attributes.TEXCOORD_0 = addAccessor(zeros, 'VEC2', 5126, nVerts, 2, false, { target: ARRAY_BUFFER });
        }

        // Remove byteStride from index bufferViews (safety)
        if (primitive.indices !== undefined) {
            const idxBV = gltf.accessors[primitive.indices].bufferView;
            delete gltf.bufferViews[idxBV].byteStride;
        }

        // One mesh + node per geometry — Blender multi-material on a single
        // multi-primitive mesh is flaky; separate objects import textures reliably.
        const meshIdx = gltf.meshes.length;
        const meshName = (geom.name || matName || ('Mesh_' + geomI)).slice(0, 64);
        const mesh = { name: meshName, primitives: [primitive] };
        if (geom.morphTargets && geom.morphTargets.length) {
            primitive.targets = geom.morphTargets.map((t) => {
                const entry = {
                    POSITION: addAccessor(t.POSITION, 'VEC3', 5126, t.count, 3, false, { target: ARRAY_BUFFER }),
                };
                if (t.NORMAL) {
                    entry.NORMAL = addAccessor(t.NORMAL, 'VEC3', 5126, t.count, 3, false, { target: ARRAY_BUFFER });
                }
                return entry;
            });
            // Weights start at rest. The viewer's own resting values are not in
            // the scene graph, and an animation overrides them anyway.
            mesh.weights = geom.morphTargets.map(() => 0);
            mesh.extras = {
                ...(mesh.extras || {}),
                targetNames: geom.morphTargets.map((t, i) => t.name || `target_${i}`),
            };
        }
        gltf.meshes.push(mesh);
        const nodeIdx = gltf.nodes.length;
        gltf.nodes.push({ name: meshName, mesh: meshIdx });
        if (geom.morphTargets) {
            geom.morphTargets.forEach((t, i) => {
                if (t.name && !morphTargetIndex.has(t.name)) {
                    morphTargetIndex.set(t.name, {
                        node: nodeIdx,
                        index: i,
                        count: geom.morphTargets.length,
                    });
                }
            });
        }
        const animParent = geom.animCtx ? nodeForAnimCtx(geom.animCtx) : -1;
        if (animParent >= 0) gltf.nodes[animParent].children.push(nodeIdx);
        else meshNodes.push(nodeIdx);
        if (geom.boneMap) skinnedMeshNodes.push([nodeIdx, geom]);
        geomI++;
    }

    // --- Skeletons and skins ---
    // Joints are emitted as siblings of the meshes rather than as their
    // parents: glTF forbids a skinned mesh's own node from being a joint, and
    // ignores that node's transform anyway — a skinned vertex is placed purely
    // by its joints.
    const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // processGeometry bakes the axis fix into the vertices, so the rig has to
    // be turned with them. It rides on a wrapper above each root bone rather
    // than on the bone itself, so that the bone's own transform stays free.
    // Vertices arrive already rotated, so the inverse bind matrices undo it
    // before binding.

    /** Column-major 4x4 product a x b (b applied first). */
    function mat4Multiply(a, b) {
        const out = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
                out[c * 4 + r] = sum;
            }
        }
        return out;
    }

    const skeletonData = options.skeletons || null;
    const boneNodeIndex = new Map();
    const rigRootNodes = [];
    const rigRootBySkeleton = new Map();

    function emitBoneNode(bone) {
        const nodeIdx = gltf.nodes.length;
        const node = { name: bone.name || 'Bone' };
        gltf.nodes.push(node);
        if (bone.name) boneNodeIndex.set(bone.name, nodeIdx);
        if (bone.name && !animTargetIndex.has(bone.name)) animTargetIndex.set(bone.name, nodeIdx);
        if (bone.animName && !animTargetIndex.has(bone.animName)) {
            animTargetIndex.set(bone.animName, nodeIdx);
        }
        if (bone.trs) {
            node.translation = Array.from(bone.trs.translation);
            node.rotation = Array.from(bone.trs.rotation);
            node.scale = Array.from(bone.trs.scale);
        }
        const kids = [];
        for (const child of bone.children) kids.push(emitBoneNode(child));
        if (kids.length) node.children = kids;
        return nodeIdx;
    }

    if (skeletonData && skeletonData.skeletons) {
        for (const skeleton of skeletonData.skeletons) {
            if (!skeleton.roots.length) continue;
            const wrapperIdx = gltf.nodes.length;
            const wrapper = {
                name: (skeleton.json && skeleton.json.Name) || 'Skeleton',
                // Axis fix, then the character's own placement, which the
                // flattened mesh path bakes into its vertices.
                matrix: Array.from(
                    mat4Multiply(AXIS_MAT4, skeleton.worldMatrix || IDENTITY_MAT4)
                ),
                children: [],
            };
            gltf.nodes.push(wrapper);
            for (const rootBone of skeleton.roots) wrapper.children.push(emitBoneNode(rootBone));
            rigRootBySkeleton.set(skeleton, wrapperIdx);
            rigRootNodes.push(wrapperIdx);
        }
    }

    /** Skin for one rigged mesh, ordered by its own dense BoneMap. */
    function skinForGeometry(geom) {
        if (!geom.boneMap || !boneNodeIndex.size) return -1;
        const entries = Object.entries(geom.boneMap);
        let maxIdx = -1;
        for (const [, i] of entries) if (i > maxIdx) maxIdx = i;
        if (maxIdx < 0) return -1;

        const joints = new Array(maxIdx + 1).fill(-1);
        const ibm = new Float32Array((maxIdx + 1) * 16);
        let skeletonRoot = -1;
        for (const [name, i] of entries) {
            const nodeIdx = boneNodeIndex.get(name);
            if (nodeIdx === undefined || i < 0 || i > maxIdx) continue;
            joints[i] = nodeIdx;
            const bone = skeletonData.boneByName.get(name);
            const inv = bone && bone.invBind;
            ibm.set(
                inv && inv.length >= 16
                    ? mat4Multiply(inv, AXIS_INVERSE_MAT4)
                    : IDENTITY_MAT4,
                i * 16
            );
            if (skeletonRoot < 0 && bone && rigRootBySkeleton.has(bone.skeleton)) {
                skeletonRoot = rigRootBySkeleton.get(bone.skeleton);
            }
        }
        // A hole in the map would be invalid glTF; park it on the root.
        for (let i = 0; i < joints.length; i++) {
            if (joints[i] >= 0) continue;
            joints[i] = skeletonRoot >= 0 ? skeletonRoot : 0;
            ibm.set(IDENTITY_MAT4, i * 16);
        }
        const acc = addAccessor(ibm, 'MAT4', 5126, joints.length, 16, false, {
            noStride: true,
            noMinMax: true,
        });
        gltf.skins.push({
            joints,
            inverseBindMatrices: acc,
            ...(skeletonRoot >= 0 ? { skeleton: skeletonRoot } : {}),
        });
        return gltf.skins.length - 1;
    }

    for (const [nodeIdx, geom] of skinnedMeshNodes) {
        const skinIdx = skinForGeometry(geom);
        if (skinIdx >= 0) gltf.nodes[nodeIdx].skin = skinIdx;
        else {
            // No usable skin: drop the attributes so importers do not see a
            // JOINTS_0 with nothing to bind it to.
            const prim = gltf.meshes[gltf.nodes[nodeIdx].mesh].primitives[0];
            delete prim.attributes.JOINTS_0;
            delete prim.attributes.WEIGHTS_0;
        }
    }

    // Curves reuse time accessors aggressively: every bone in a Sketchfab clip
    // is usually keyed on the same timeline, so this collapses thousands of
    // identical inputs into a handful.
    const timeAccessors = [];
    function addTimeAccessor(times) {
        for (const entry of timeAccessors) {
            if (entry.data.length !== times.length) continue;
            let same = true;
            for (let i = 0; i < times.length; i++) {
                if (entry.data[i] !== times[i]) { same = false; break; }
            }
            if (same) return entry.accessor;
        }
        // Animation inputs must carry min/max, so they keep theirs.
        const accessor = addAccessor(times, 'SCALAR', 5126, times.length, 1, false, {
            noStride: true,
        });
        timeAccessors.push({ data: times, accessor });
        return accessor;
    }

    for (const anim of options.animationCurves || []) {
        const samplers = [];
        const channels = [];
        const weightsByNode = new Map();
        for (const curve of anim.curves) {
            if (curve.path === 'weights') {
                const slot = morphTargetIndex.get(curve.target);
                if (!slot) continue;
                const list = weightsByNode.get(slot.node) || { count: slot.count, entries: [] };
                list.entries.push({ index: slot.index, curve });
                weightsByNode.set(slot.node, list);
                continue;
            }
            const nodeIdx = animTargetIndex.get(curve.target);
            if (nodeIdx === undefined) continue;
            const keys = stripNonIncreasingKeys(curve.times, curve.values, curve.itemSize);
            const input = addTimeAccessor(keys.times);
            const output = addAccessor(
                keys.values,
                `VEC${curve.itemSize}`,
                5126,
                keys.times.length,
                curve.itemSize,
                false,
                { noStride: true, noMinMax: true }
            );
            /**
             * Animation interpolation is always LINEAR, and that is not a shortcut.
             *
             * osgjs types every channel by its interpolation -- Vec3LerpChannel,
             * QuatSlerpChannel, FloatLerpChannel, and the Compressed/Packed variants of
             * each -- so a stepped clip would arrive as a distinguishable type. None does.
             * The v2 fixture authored A11_StepAnimation with every keyframe set to
             * Blender's CONSTANT interpolation; it comes back from Sketchfab as a single
             * Vec3LerpChannelCompressedPacked. Across r3_01, v3_02 and v3_03 -- 9 clips,
             * 91 channels -- every one is Lerp or Slerp.
             *
             * Sketchfab's importer flattens step keys on the way in, so there is no
             * stepping left to preserve and writing anything else would be a guess.
             */
            samplers.push({ input, output, interpolation: 'LINEAR' });
            channels.push({
                sampler: samplers.length - 1,
                target: { node: nodeIdx, path: curve.path },
            });
        }
        for (const [nodeIdx, group] of weightsByNode) {
            const merged = mergeWeightCurves(group.entries, group.count);
            if (!merged) continue;
            const input = addTimeAccessor(merged.times);
            const output = addAccessor(
                merged.values, 'SCALAR', 5126, merged.values.length, 1, false,
                { noStride: true, noMinMax: true }
            );
            samplers.push({ input, output, interpolation: 'LINEAR' });
            channels.push({
                sampler: samplers.length - 1,
                target: { node: nodeIdx, path: 'weights' },
            });
        }
        if (channels.length) {
            gltf.animations.push({ name: anim.name || 'Animation', samplers, channels });
        }
    }

    if (meshNodes.length || animRootNodes.length) {
        // Vertices carry the axis fix already; the parent keeps the official name.
        const root = gltf.nodes.length;
        gltf.nodes.push({
            name: 'Sketchfab_model',
            ...(rootMatrix ? { matrix: Array.from(rootMatrix) } : {}),
            children: meshNodes.concat(rigRootNodes, animRootNodes),
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

    if (!gltf.skins.length) delete gltf.skins;
    if (!gltf.animations.length) delete gltf.animations;

    // Drop empty optional arrays (some strict validators dislike empty textures[])
    if (!gltf.images.length) {
        delete gltf.images;
        delete gltf.textures;
        delete gltf.samplers;
    }

    const binBuffer = concatBytes(binChunks);
    gltf.buffers.push({ byteLength: binBuffer.length });

    if (usedExtensions.size) {
        gltf.extensionsUsed = [...usedExtensions];
    }

    return { json: gltf, bin: binBuffer, skipped };
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

/**
 * Is this geometry the viewer's own wireframe overlay?
 *
 * Sketchfab draws one for every geometry, authored or not, and it is always
 * LINES -- so "has a LINES primitive" used to be the test. That also condemns
 * genuine line geometry, which is equally LINES and equally common in the one
 * place it matters: a model authored as edges has nothing else in it.
 *
 * The overlay keeps its indices in model_file_wireframe.binz while real
 * geometry indexes out of model_file.binz, and that survives the distinction
 * being invisible everywhere else. An overlay with no index array at all is
 * still an overlay; a LINES set indexing real geometry is not.
 */
function isWireframeGeom(geom) {
    if (!geom) return false;
    const prims = geom.PrimitiveSetList || [];
    let sawLines = false;
    for (const p of prims) {
        const dt = Object.values(p)[0];
        if (!dt || dt.Mode !== 'LINES') continue;
        sawLines = true;
        const arr = dt.Indices && dt.Indices.Array;
        const def = arr && Object.values(arr)[0];
        if (!def || !def.File || !def.File.includes('wireframe')) return false;
    }
    return sawLines;
}

/**
 * One vertex's four influences, made legal for glTF.
 *
 * Three things have to hold that Sketchfab's buffers do not guarantee:
 *
 *   - An index past the end of the BoneMap names no bone. Clamping it to 0 --
 *     which is what this did -- keeps its weight and makes bone 0 collide with
 *     itself, which is both a duplicate joint and a weight sum that no longer
 *     reaches 1. The influence has to go, not move.
 *   - A slot weighted 0 must carry joint 0. Sketchfab fills all four slots with
 *     bone indices whether or not it weights them, which is legal for its own
 *     renderer and 276,865 warnings for glTF's.
 *   - The same bone must not appear twice. Two slots naming one bone are one
 *     influence, so their weights add.
 *
 * Surviving influences pack to the front and are renormalised only if dropping
 * or merging left them short, so already-valid vertices come through untouched.
 */
export function sanitizeInfluences(js, ws, boneCount) {
    const j = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    let n = 0;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
        const idx = js[k] | 0;
        const wt = +ws[k];
        if (!(wt > 0)) continue;                        // zero, negative or NaN
        if (!(idx >= 0 && idx < boneCount)) continue;   // names no bone
        let at = -1;
        for (let m = 0; m < n; m++) if (j[m] === idx) { at = m; break; }
        if (at >= 0) {
            w[at] += wt;
        } else {
            j[n] = idx;
            w[n] = wt;
            n++;
        }
        sum += wt;
    }
    if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
        for (let k = 0; k < n; k++) w[k] /= sum;
    }
    return [j, w];
}

/**
 * Per-vertex skinning attributes from a RigGeometry.
 *
 * Bones/Weights hang off the rig wrapper rather than its SourceGeometry, and
 * the bone indices address the rig's own BoneMap, so a skin built from that
 * map can use them verbatim. glTF wants sets of four, so narrower rigs are
 * zero-padded.
 */
function readRigAttributes(rig, polyBin, vertexCount) {
    const vaList = (rig && rig.VertexAttributeList) || {};
    if (!vaList.Bones || !vaList.Weights || !rig.BoneMap) return null;

    function read(attr) {
        const arrInfo = attr.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const itemSize = attr.ItemSize || 4;
        const data = readBufferArray(
            asArrayBuffer(polyBin),
            { ...arrDef, ItemSize: itemSize },
            arrType
        );
        return { data, count: arrDef.Size, itemSize };
    }

    let bones;
    let weights;
    try {
        bones = read(vaList.Bones);
        weights = read(vaList.Weights);
    } catch (_) {
        return null;
    }
    if (bones.count !== vertexCount || weights.count !== vertexCount) return null;

    const joints = new Uint16Array(vertexCount * 4);
    const wts = new Float32Array(vertexCount * 4);
    const boneCount = Object.keys(rig.BoneMap).length;
    const n = Math.min(4, bones.itemSize);
    const srcJ = [0, 0, 0, 0];
    const srcW = [0, 0, 0, 0];
    for (let i = 0; i < vertexCount; i++) {
        for (let k = 0; k < 4; k++) {
            srcJ[k] = k < n ? bones.data[i * bones.itemSize + k] : 0;
            srcW[k] = k < n ? weights.data[i * weights.itemSize + k] : 0;
        }
        const [vj, vw] = sanitizeInfluences(srcJ, srcW, boneCount);
        for (let k = 0; k < 4; k++) {
            joints[i * 4 + k] = vj[k];
            wts[i * 4 + k] = vw[k];
        }
    }
    return {
        JOINTS_0: { data: joints, itemSize: 4, count: vertexCount, componentType: 5123 },
        WEIGHTS_0: { data: wts, itemSize: 4, count: vertexCount, componentType: 5126 },
    };
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

/**
 * Shape-key geometry hanging off a MorphGeometry, as glTF morph targets.
 *
 * osgjs stores each target as a complete replacement mesh, while glTF wants
 * displacements from the base, so the base is subtracted out. Both sides go
 * through the same placement and axis handling first; the two transforms then
 * cancel in the subtraction, leaving the displacement in the right frame.
 *
 * A target whose vertex count does not match the base is skipped rather than
 * guessed at: glTF cannot express a target of a different size, and a
 * mismatched one would corrupt the mesh.
 */
function readMorphTargets(morphNode, base, polyBin, wireBin, axisRotation, placement, skipAxis) {
    const entries = morphNode.MorphTargets || [];
    const basePos = base.attributes.POSITION;
    if (!basePos || !entries.length) return [];
    const baseNormal = base.attributes.NORMAL;
    const out = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const geom = entry['osg.Geometry'] || (entry.VertexAttributeList ? entry : null);
        if (!geom || !geom.VertexAttributeList) continue;
        let target;
        try {
            target = processGeometry(
                geom, polyBin, wireBin, {}, axisRotation, placement,
                { attributesOnly: true, skipAxis }
            );
        } catch (e) {
            continue;
        }
        const pos = target.attributes.POSITION;
        if (!pos || pos.count !== basePos.count) continue;
        const deltaPos = new Float32Array(basePos.count * 3);
        for (let i = 0; i < deltaPos.length; i++) {
            deltaPos[i] = pos.data[i] - basePos.data[i];
        }
        const rec = { name: geom.Name || '', POSITION: deltaPos, count: basePos.count };
        const nrm = target.attributes.NORMAL;
        if (baseNormal && nrm && nrm.count === baseNormal.count) {
            const deltaNrm = new Float32Array(baseNormal.count * 3);
            for (let i = 0; i < deltaNrm.length; i++) {
                deltaNrm[i] = nrm.data[i] - baseNormal.data[i];
            }
            rec.NORMAL = deltaNrm;
        }
        out.push(rec);
    }
    return out;
}

/** Linear read of a scalar curve at an arbitrary time, clamped at the ends. */
export function sampleScalar(times, values, t) {
    const n = times.length;
    if (!n) return 0;
    if (t <= times[0]) return values[0];
    if (t >= times[n - 1]) return values[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid;
    }
    const span = times[hi] - times[lo];
    const f = span > 0 ? (t - times[lo]) / span : 0;
    return values[lo] + (values[hi] - values[lo]) * f;
}

/**
 * One glTF weights sampler from a mesh's separate per-target curves.
 *
 * glTF interleaves every target's weight into a single output, so all the
 * curves have to share one timeline. Each keeps its own key times in osgjs,
 * so the union is taken and the curves that do not have a key there are
 * read at that instant instead. A target with no curve at all stays at
 * rest rather than being dropped, which would shift the remaining weights
 * onto the wrong targets.
 */
export function mergeWeightCurves(entries, targetCount) {
    const timeSet = new Set();
    for (const e of entries) {
        for (const t of e.curve.times) timeSet.add(t);
    }
    const times = [...timeSet].sort((a, b) => a - b);
    if (!times.length) return null;
    const values = new Float32Array(times.length * targetCount);
    for (const e of entries) {
        if (e.index < 0 || e.index >= targetCount) continue;
        for (let i = 0; i < times.length; i++) {
            values[i * targetCount + e.index] = sampleScalar(
                e.curve.times, e.curve.values, times[i]
            );
        }
    }
    return { times: Float32Array.from(times), values };
}

/**
 * A transform an animation drives, as opposed to one that merely places
 * something.
 *
 * Bones are excluded: they carry osgAnimation.UpdateBone and belong to the
 * skeleton path, which already owns their placement. Only a transform with an
 * UpdateMatrixTransform, and a name for a channel to address it by, is one an
 * object animation can target.
 *
 * @returns {object|null} the update callback, or null if nothing drives it
 */
export function animatedTransform(value) {
    if (!value || typeof value !== 'object') return null;
    for (const cb of value.UpdateCallbacks || []) {
        if (!cb || typeof cb !== 'object') continue;
        if (Object.keys(cb)[0] !== 'osgAnimation.UpdateMatrixTransform') continue;
        const update = cb['osgAnimation.UpdateMatrixTransform'];
        if (update && update.Name) return update;
    }
    return null;
}

function collectGeometries(node, polyBin, wireBin, axisRotation, axisNode, skeletonData = null) {
    const uidMap = {};
    buildUidMap(node, uidMap);
    resolveRefs(node, uidMap);

    const results = [];
    const seen = new Set();
    const sharedState = { expectedState: [0] };
    const stats = { rig: 0, geom: 0, morph: 0, wire: 0, skip: 0, errors: [] };

    function acceptGeometry(geom, label, rig, placement, morphNode, animCtx) {
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
            // A skinned mesh is positioned by its skeleton, so placement is only
            // baked for meshes that have no other way to get it.
            //
            // Under an animated node the axis fix moves onto that node's
            // wrapper: baking it into the vertices as well would apply it
            // twice, once here and once through the parent.
            const underAnimated = !!animCtx && !rig;
            const result = processGeometry(
                geom, polyBin, wireBin, sharedState, axisRotation,
                placement,
                { skipAxis: underAnimated }
            );
            if (underAnimated) result.animCtx = animCtx;
            if ((result.indices || result.mode === 'POINTS') && result.attributes.POSITION) {
                // Remap _TC_* to continuous TEXCOORD_0, TEXCOORD_1, ...
                //
                // Sorted numerically, not lexicographically: the suffix is a
                // sparse texture unit, so a mesh carrying units 3 and 12 would
                // otherwise order 12 first and swap the two sets.
                const tcKeys = Object.keys(result.attributes)
                    .filter((k) => k.startsWith('_TC_'))
                    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
                // Unit -> TEXCOORD index is positional, so keeping the units in
                // emit order is enough for materials to resolve their binding.
                result.uvUnits = tcKeys.map((k) => Number(k.slice(4)));
                let tcIdx = 0;
                for (const k of tcKeys) {
                    result.attributes[`TEXCOORD_${tcIdx++}`] = result.attributes[k];
                    delete result.attributes[k];
                }
                if (morphNode) {
                    const targets = readMorphTargets(
                        morphNode, result, polyBin, wireBin, axisRotation, placement,
                        underAnimated
                    );
                    if (targets.length) result.morphTargets = targets;
                }
                if (rig) {
                    const skinAttrs = readRigAttributes(
                        rig,
                        polyBin,
                        result.attributes.POSITION.count
                    );
                    if (skinAttrs) {
                        result.attributes.JOINTS_0 = skinAttrs.JOINTS_0;
                        result.attributes.WEIGHTS_0 = skinAttrs.WEIGHTS_0;
                        result.boneMap = rig.BoneMap;
                    }
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
    /**
     * The axis wrapper is applied once for the whole model, so it must not be
     * accumulated here as though it were object placement -- that would turn
     * the model twice.
     */
    /** Plain accumulation, used only for the below-skeleton path. */
    function fullPathOf(value, acc) {
        if (!value || typeof value !== 'object') return acc;
        if (!Array.isArray(value.Matrix) || value.Matrix.length !== 16) return acc;
        return mat4Multiply(acc, value.Matrix);
    }

    function placementOf(value, acc) {
        if (!value || typeof value !== 'object') return acc;
        if (!Array.isArray(value.Matrix) || value.Matrix.length !== 16) return acc;
        if (value === axisNode) return acc;
        return mat4Multiply(acc, value.Matrix);
    }

    /**
     * Descend one level, returning the placement to bake and the animated node
     * a mesh below here belongs to.
     *
     * Baking an animated node's transform into vertices would freeze it, so the
     * accumulation restarts underneath one: what has been gathered so far
     * becomes that node's own offset, and only transforms below it keep being
     * baked.
     */
    function descend(value, acc, ctx) {
        const update = value === axisNode ? null : animatedTransform(value);
        if (!update) return [placementOf(value, acc), ctx];
        return [
            IDENTITY_MAT4,
            { name: update.Name, trs: stackedTRS(value), pre: acc, parent: ctx, node: -1 },
        ];
    }

    /**
     * What a skinned mesh still needs baked, measured from its own skeleton.
     *
     * The emitted Skeleton node already carries everything above it, and the
     * bones hang off that, so a transform above the skeleton reaches the mesh
     * through the skin -- baking it as well would apply it twice. A transform
     * *between* the skeleton and the rig geometry is in no bone's path at all,
     * so nothing applies it unless the vertices do.
     *
     * Sketchfab puts real offsets there: a sculpting rig keeps every body part
     * under one, and dropping them stacked skull, ribcage and thighs on the
     * origin while the head bone sat seventeen units up.
     *
     * Null until a skeleton is entered, so a rig outside one is left alone.
     */
    function walk(obj, depth, acc, ctx, belowSkel) {
        if (!obj || typeof obj !== 'object' || depth > 60) return;

        if (Array.isArray(obj)) {
            for (const item of obj) walk(item, depth + 1, acc, ctx, belowSkel);
            return;
        }

        if (obj['osgAnimation.Skeleton'] || obj['osg.Skeleton']) {
            const skel = obj['osgAnimation.Skeleton'] || obj['osg.Skeleton'];
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'osgAnimation.Skeleton' || k === 'osg.Skeleton') continue;
                const [a2, c2] = descend(v, acc, ctx);
                walk(v, depth + 1, a2, c2, belowSkel);
            }
            for (const [, v] of Object.entries(skel)) {
                const [a2, c2] = descend(v, acc, ctx);
                walk(v, depth + 1, a2, c2, IDENTITY_MAT4);
            }
            return;
        }

        // Skinned mesh wrapper (Sketchfab / OSG animation)
        if (obj['osgAnimation.RigGeometry'] || obj['osg.RigGeometry']) {
            const rig = obj['osgAnimation.RigGeometry'] || obj['osg.RigGeometry'];
            stats.rig++;
            const mesh = extractMeshGeometry(rig);
            acceptGeometry(mesh, 'RigGeometry', rig, belowSkel, null, ctx);
            // Walk other fields except SourceGeometry (already handled)
            for (const [k, v] of Object.entries(rig)) {
                if (k === 'SourceGeometry') continue;
                { const [a2, c2] = descend(v, acc, ctx); walk(v, depth + 1, a2, c2, belowSkel && fullPathOf(v, belowSkel)); }
            }
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'osgAnimation.RigGeometry' || k === 'osg.RigGeometry') continue;
                { const [a2, c2] = descend(v, acc, ctx); walk(v, depth + 1, a2, c2, belowSkel && fullPathOf(v, belowSkel)); }
            }
            return;
        }

        // Morph targets
        if (obj['osgAnimation.MorphGeometry'] || obj['osg.MorphGeometry']) {
            const morph = obj['osgAnimation.MorphGeometry'] || obj['osg.MorphGeometry'];
            stats.morph++;
            const mesh = extractMeshGeometry(morph) || morph;
            acceptGeometry(mesh, 'MorphGeometry', null, acc, morph, ctx);
            for (const [k, v] of Object.entries(obj)) {
                if (k === 'osgAnimation.MorphGeometry' || k === 'osg.MorphGeometry') continue;
                { const [a2, c2] = descend(v, acc, ctx); walk(v, depth + 1, a2, c2, belowSkel && fullPathOf(v, belowSkel)); }
            }
            // still walk morph internals except duplicate source
            for (const [k, v] of Object.entries(morph)) {
                if (k === 'SourceGeometry') continue;
                { const [a2, c2] = descend(v, acc, ctx); walk(v, depth + 1, a2, c2, belowSkel && fullPathOf(v, belowSkel)); }
            }
            return;
        }

        if (obj['osg.Geometry']) {
            stats.geom++;
            acceptGeometry(obj['osg.Geometry'], 'Geometry', null, acc, null, ctx);
        }

        for (const v of Object.values(obj)) {
            const [a2, c2] = descend(v, acc, ctx);
            walk(v, depth + 1, a2, c2, belowSkel && fullPathOf(v, belowSkel));
        }
    }

    walk(node, 0, IDENTITY_MAT4, null, null);

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

/** Identify an animation payload by its uid, however the caller named it. */
function animBinKey(name) {
  return String(name || '')
    .split('/')
    .pop()
    .replace(/\.gz$/i, '')
    .replace(/\.bin$/i, '')
    .toLowerCase();
}

function channelFileName(channel) {
  const key = channel && channel.KeyFrames && channel.KeyFrames.Key;
  if (!key || !key.Array) return '';
  const type = Object.keys(key.Array)[0];
  return (key.Array[type] && key.Array[type].File) || '';
}

/**
 * Decode every animation channel into glTF-ready curves.
 *
 * Curves live in a per-animation payload fetched separately from the mesh
 * bins, so a model can be rigged (skin only) without them.
 *
 * @param {object} osgjs
 * @param {object|null} animationBins  name -> decompressed bytes
 */
function buildAnimationCurves(osgjs, animationBins) {
  const entries = animationBins ? Object.entries(animationBins) : [];
  if (!entries.length) return [];
  const animations = collectAnimations(osgjs);
  if (!animations.length) return [];

  const buffers = new Map();
  for (const [name, data] of entries) {
    if (!data) continue;
    buffers.set(animBinKey(name), asArrayBuffer(data));
  }
  const only = buffers.size === 1 ? [...buffers.values()][0] : null;

  const out = [];
  for (const anim of animations) {
    const curves = [];
    let failed = 0;
    for (const entry of anim.Channels || []) {
      const type = Object.keys(entry)[0];
      const channel = entry[type];
      const bin = buffers.get(animBinKey(channelFileName(channel))) || only;
      if (!bin) continue;
      try {
        const curve = decodeChannelCurve(bin, type, channel);
        if (curve) curves.push(curve);
      } catch (e) {
        failed++;
      }
    }
    if (failed) {
      console.warn(`  Warning: ${failed} animation channel(s) failed to decode`);
    }
    if (curves.length) out.push({ name: anim.Name || 'Animation', curves });
  }
  return out;
}

/**
 * Convert Sketchfab osgjs + bins (+ optional textures) to GLB (+ optional external glTF).
 * @param {Map|object|null} viewerMaterials - from parseViewerMaterials(info)
 */
export async function convertOsgjsToGlb(osgjs, polyBin, wireBin, textureList, viewerMaterials = null, animationBins = null, orientation = null) {
  const poly = polyBin instanceof Uint8Array
    ? polyBin.buffer.slice(polyBin.byteOffset, polyBin.byteOffset + polyBin.byteLength)
    : polyBin;
  const wire = !wireBin ? null
    : (wireBin instanceof Uint8Array
      ? wireBin.buffer.slice(wireBin.byteOffset, wireBin.byteOffset + wireBin.byteLength)
      : wireBin);

  // One axis decision for the whole model, read from the scene graph.
  const axis = axisRotationFor(osgjs);
  // Skeletons first: a rig geometry's placement can only be judged against what
  // its own bones already do, so the bind matrices have to be in hand before
  // any vertices are read.
  const skeletons = collectSkeletons(osgjs, axis.node);
  const geometries = collectGeometries(osgjs, poly, wire, axis.matrix, axis.node, skeletons);
  const animationCurves = skeletons.skeletons.length
    ? buildAnimationCurves(osgjs, animationBins)
    : [];
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
      if (spec.clearCoat && spec.clearCoat.normalFlipY && spec.clearCoat.normalTextureUid) {
        needFlipUids.add(String(spec.clearCoat.normalTextureUid).toLowerCase());
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

  // Opacity-only cards (hair dithering with no albedo): tint × opacity alpha.
  const tintDone = new Map();
  for (const map of perGeomMaps) {
    if (!map || map.skip || !map.opacityAsAlbedo || !map.alpha) continue;
    const tintKey =
      map.alpha +
      '|' +
      (map.baseColorFactor || []).join(',');
    if (tintDone.has(tintKey)) {
      map.albedo = tintDone.get(tintKey);
      map.baseColorFactor = [1, 1, 1, 1];
      continue;
    }
    const mHit = findTextureBytes(map.alpha, textureFiles);
    if (!mHit) continue;
    try {
      const baked = await bakeTintWithAlpha(map.baseColorFactor || [1, 1, 1, 1], mHit.data);
      if (!baked) continue;
      const bakedName =
        textureBasename(map.alpha).replace(/\.[^.]+$/, '') + '_tint.png';
      textureFiles[bakedName] = baked;
      textureFiles['textures/' + bakedName] = baked;
      list.push({ name: 'textures/' + bakedName, data: baked });
      tintDone.set(tintKey, bakedName);
      map.albedo = bakedName;
      map.baseColorFactor = [1, 1, 1, 1];
    } catch (_) {}
  }

  // glTF reads alpha from baseColorTexture.A. Bake only when albedo + opacity
  // share an atlas (alphaBlend / mask). Sketchfab "dithering" hair uses a
  // second atlas (Hair_M) on another UV — baking it into Hair_AO punches holes.
  const bakedDone = new Map();
  for (const map of perGeomMaps) {
    if (!map || map.skip || !map.albedo || !map.alpha || !map.opacityEnable) continue;
    if (/dither/i.test(String(map.opacityType || ''))) continue;
    const bakeKey = map.albedo + '|' + map.alpha;
    if (bakedDone.has(bakeKey)) {
      const prev = bakedDone.get(bakeKey);
      // null == the bake was fully opaque, so it was skipped
      if (prev) map.albedo = prev;
      else map.forceOpaque = true;
      continue;
    }
    const aHit = findTextureBytes(map.albedo, textureFiles);
    const mHit = findTextureBytes(map.alpha, textureFiles);
    if (!aHit || !mHit) continue;
    try {
      const baked = await bakeOpacityIntoAlbedo(aHit.data, mHit.data);
      if (!baked) continue;
      if (!baked.hasTransparency) {
        // Flat/opaque opacity map: keep the original albedo and export OPAQUE,
        // otherwise EEVEE renders a solid object see-through.
        bakedDone.set(bakeKey, null);
        map.forceOpaque = true;
        continue;
      }
      const bakedName =
        textureBasename(map.albedo).replace(/\.[^.]+$/, '') + '_alpha.png';
      textureFiles[bakedName] = baked.data;
      textureFiles['textures/' + bakedName] = baked.data;
      list.push({ name: 'textures/' + bakedName, data: baked.data });
      bakedDone.set(bakeKey, bakedName);
      map.albedo = bakedName;
    } catch (_) {}
  }

  // 1) Embedded GLB
  const embedded = buildGLTF(geometries, textureMap, textureFiles, perGeomMaps, {
    skeletons,
    animationCurves,
    axisRotation: axis.matrix,
    orientation,
    externalTextures: false,
  });
  const glb = packGlb(embedded.json, embedded.bin);
  const textureEmbedCount =
    (embedded.json.images && embedded.json.images.length) || 0;

  // Count non-skipped meshes
  const meshCount = (embedded.json.meshes && embedded.json.meshes.length) || 0;

  // 2) External glTF
  const external = buildGLTF(geometries, textureMap, textureFiles, perGeomMaps, {
    skeletons,
    animationCurves,
    axisRotation: axis.matrix,
    orientation,
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

  const boneCount = skeletons.skeletons.reduce((n, sk) => n + sk.bones.length, 0);
  return {
    glb,
    skippedGeometries: embedded.skipped || [],
    geometryCount: meshCount || geometries.length,
    json: embedded.json,
    textureEmbedCount,
    rig: {
      skeletons: skeletons.skeletons.length,
      bones: boneCount,
      skins: (embedded.json.skins || []).length,
      animations: (embedded.json.animations || []).length,
      channels: (embedded.json.animations || []).reduce(
        (n, a) => n + a.channels.length,
        0
      ),
    },
    gltfExternal: {
      jsonText,
      bin: external.bin instanceof Uint8Array ? external.bin : new Uint8Array(external.bin),
      textureAliases,
    },
  };
}

export async function convertOsgjsToGlbFromFiles(fileMap, viewerMaterials = null, textureList = null, orientation = null) {
  // fileMap: { 'file.osgjs': text/bytes, 'model_file.bin': bytes, ... , textures/* }
  let osgjsRaw = fileMap['file.osgjs'];
  if (!osgjsRaw) throw new Error('file.osgjs missing');
  if (osgjsRaw instanceof Uint8Array) osgjsRaw = new TextDecoder().decode(osgjsRaw);
  const osgjs = typeof osgjsRaw === 'string' ? JSON.parse(osgjsRaw) : osgjsRaw;
  const poly = fileMap['model_file.bin'];
  if (!poly) throw new Error('model_file.bin missing');
  const wire = fileMap['model_file_wireframe.bin'] || null;
  const animationBins = {};
  for (const [name, data] of Object.entries(fileMap)) {
    if (!(data instanceof Uint8Array)) continue;
    if (/(^|\/)animations\//i.test(name) || /\.bin\.gz$/i.test(name)) {
      animationBins[name] = data;
    }
  }
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
  return convertOsgjsToGlb(osgjs, poly, wire, textures, viewerMaterials, animationBins, orientation);
}
