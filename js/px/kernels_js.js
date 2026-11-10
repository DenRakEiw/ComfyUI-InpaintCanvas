// Generated from DenRakEiw/scumble renderer/editor/px/kernels_js.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The pixel kernels of the tile engine (docs/PLAN_BCE.md §B2). Phase B built them twice, in
 * Rust (wasm, SIMD128) and here, and measured both: Rust was 2.0 to 2.4× faster on the two
 * rows the 3× rule reads, so these are the kernels phase C ships (docs/PERFORMANCE.md §10;
 * the Rust crate is in the history of the branch px-spike). They are written to be fast
 * JavaScript, not short: word access, per-layer loops, one element kind per call site.
 * `tools/px_test.js` holds each to a plain reference and to the editor's current code.
 *
 * Every function takes its output buffer as the last argument (allocated when absent) and
 * returns it. All maths is integer, so any port gives the same bytes. Tile buffers that are
 * copied into each other should start on a 4 KB boundary: a destination 8 bytes past the
 * source modulo 4,096 makes a 256 KB copy 16× slower (4K aliasing, §10).
 */

import { BLEND_OPS } from "../blend_modes.js";
import { gaussRadii } from "../inpaint_edges.js";
import { guidedFar as guidedFarDepth } from "../inpaint_depth.js";
import { unpackStrip, unpredict, predictRgba, toRgba, paletteLut, tiffPlan, readTiffBand, readTiffBands, TIFF_BAND_BYTES, tiffPart, TIFF_JS } from "../inpaint_tiff.js";
import { packbitsRows, psdMaskRgba, psdBandRgba, psdBandMask, PSD_JS } from "../inpaint_layered.js";

export { unpackStrip, unpackStrip as tiffUnpack, unpredict, unpredict as tiffUnpredict, predictRgba, predictRgba as tiffPredictRgba, toRgba, toRgba as tiffToRgba, paletteLut, tiffPlan, readTiffBand, readTiffBands, TIFF_BAND_BYTES, tiffPart, TIFF_JS };
export { packbitsRows, psdMaskRgba, psdBandRgba, psdBandMask, PSD_JS };

export const OPS = Object.freeze({
    "source-over": 0,
    "destination-out": 1,
    "source-atop": 2,
    "destination-in": 3,
    copy: 4,
    // the blend modes (a layer's `blend`), source-over with B(backdrop, source) where both cover
    ...BLEND_OPS,
    hue: 24,
    saturation: 25,
    color: 26,
    luminosity: 27,
    "darker-color": 28,
    "lighter-color": 29,
});

// ---- element kinds and byte order --------------------------------------------------------------

// A kernel that sees both Uint8ClampedArray (ImageData.data) and Uint8Array reads through
// polymorphic element access and runs at half speed; every entry point views its byte
// inputs as Uint8Array first, which copies nothing.
const bytesOf = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// ---- mips ------------------------------------------------------------------------------------

/**
 * RGBA8 `src` (sw × sh, straight alpha) halved into `dst` ((sw >> 1) × (sh >> 1)): a 2×2
 * box weighted by alpha, colour 0 where all four samples are transparent.
 */
export function mipHalf(src, sw, sh, dst = null) {
    src = bytesOf(src);
    dst = dst ? bytesOf(dst) : new Uint8Array((sw >> 1) * (sh >> 1) * 4);
    if (LITTLE && src.byteOffset % 4 === 0 && dst.byteOffset % 4 === 0) {
        mipHalfWords(new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2), 0, sw, sh,
            new Uint32Array(dst.buffer, dst.byteOffset, dst.byteLength >> 2), 0);
    } else {
        mipHalfBytes(src, sw, sh, dst);
    }
    return dst;
}

/**
 * The same over RGBA words (little-endian: R in the low byte). `si` / `di` are word offsets.
 * Opaque blocks average R and B in one word addition: each field sum stays below 2^10, so
 * nothing carries into the next field.
 */
function mipHalfWords(s, si, sw, sh, d, di) {
    const ow = sw >> 1, oh = sh >> 1;
    let o = di;
    for (let y = 0; y < oh; y++) {
        let i = si + 2 * y * sw, j = i + sw;
        for (let x = 0; x < ow; x++, i += 2, j += 2, o++) {
            const w0 = s[i], w1 = s[i + 1], w2 = s[j], w3 = s[j + 1];
            if ((w0 & w1 & w2 & w3) >>> 24 === 255) {
                const rb = ((w0 & 0xFF00FF) + (w1 & 0xFF00FF) + (w2 & 0xFF00FF) + (w3 & 0xFF00FF) + 0x20002) >>> 2;
                const g = (((w0 >>> 8) & 255) + ((w1 >>> 8) & 255) + ((w2 >>> 8) & 255) + ((w3 >>> 8) & 255) + 2) >>> 2;
                d[o] = (rb & 0xFF00FF) | (g << 8) | 0xFF000000;
            } else if ((w0 | w1 | w2 | w3) >>> 24 === 0) {
                d[o] = 0;
            } else {
                const a0 = w0 >>> 24, a1 = w1 >>> 24, a2 = w2 >>> 24, a3 = w3 >>> 24;
                const a = a0 + a1 + a2 + a3, h = a >> 1;
                const r = ((((w0 & 255) * a0 + (w1 & 255) * a1 + (w2 & 255) * a2 + (w3 & 255) * a3) + h) / a) | 0;
                const g = (((((w0 >>> 8) & 255) * a0 + ((w1 >>> 8) & 255) * a1 + ((w2 >>> 8) & 255) * a2 + ((w3 >>> 8) & 255) * a3) + h) / a) | 0;
                const b = (((((w0 >>> 16) & 255) * a0 + ((w1 >>> 16) & 255) * a1 + ((w2 >>> 16) & 255) * a2 + ((w3 >>> 16) & 255) * a3) + h) / a) | 0;
                d[o] = r | (g << 8) | (b << 16) | (((a + 2) >> 2) << 24);
            }
        }
    }
}

/** The byte version, for big-endian hosts and buffers that do not start on a word boundary. */
function mipHalfBytes(src, sw, sh, dst) {
    const ow = sw >> 1, oh = sh >> 1, stride = sw * 4;
    let o = 0;
    for (let y = 0; y < oh; y++) {
        let i = 2 * y * stride, j = i + stride;
        for (let x = 0; x < ow; x++, i += 8, j += 8, o += 4) {
            const a0 = src[i + 3], a1 = src[i + 7], a2 = src[j + 3], a3 = src[j + 7];
            const a = a0 + a1 + a2 + a3;
            if (a === 1020) {
                dst[o] = (src[i] + src[i + 4] + src[j] + src[j + 4] + 2) >> 2;
                dst[o + 1] = (src[i + 1] + src[i + 5] + src[j + 1] + src[j + 5] + 2) >> 2;
                dst[o + 2] = (src[i + 2] + src[i + 6] + src[j + 2] + src[j + 6] + 2) >> 2;
                dst[o + 3] = 255;
            } else if (a === 0) {
                dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0;
            } else {
                const h = a >> 1;
                dst[o] = ((src[i] * a0 + src[i + 4] * a1 + src[j] * a2 + src[j + 4] * a3 + h) / a) | 0;
                dst[o + 1] = ((src[i + 1] * a0 + src[i + 5] * a1 + src[j + 1] * a2 + src[j + 5] * a3 + h) / a) | 0;
                dst[o + 2] = ((src[i + 2] * a0 + src[i + 6] * a1 + src[j + 2] * a2 + src[j + 6] * a3 + h) / a) | 0;
                dst[o + 3] = (a + 2) >> 2;
            }
        }
    }
}

export function mipChainBytes(size, levels) {
    let n = 0;
    for (let l = 1; l <= levels; l++) n += (size >> l) * (size >> l) * 4;
    return n;
}

/**
 * A square tile's RGBA8 bytes clamp-extended in place from their valid part (vw × vh) to the whole
 * size × size: the columns right of vw repeat column vw - 1 and the rows below vh repeat row vh - 1.
 * The last tile of a row or a column of the tile store gets this before its mips are built, so the
 * image's own edge does not fade by a level of mip (docs/PLAN_BCE.md §C3 a); the worker's mips job
 * runs the same code (§C6 b).
 */
export function clampExtend(bytes, size, vw, vh) {
    bytes = bytesOf(bytes);
    const w32 = LITTLE && bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2) : null;
    if (vw < size) {
        for (let y = 0; y < vh; y++) {
            const row = y * size;
            if (w32) { w32.fill(w32[row + vw - 1], row + vw, row + size); continue; }
            const i = (row + vw - 1) * 4;
            for (let x = vw; x < size; x++) {
                const j = (row + x) * 4;
                bytes[j] = bytes[i]; bytes[j + 1] = bytes[i + 1]; bytes[j + 2] = bytes[i + 2]; bytes[j + 3] = bytes[i + 3];
            }
        }
    }
    if (vh < size) {
        const last = (vh - 1) * size;
        for (let y = vh; y < size; y++) {
            if (w32) { w32.copyWithin(y * size, last, last + size); continue; }
            bytes.copyWithin(y * size * 4, last * 4, (last + size) * 4);
        }
    }
    return bytes;
}

/** The `levels` mips of a square tile, largest first, one after the other in `out`. */
export function mipChain(src, size, levels, out = null) {
    src = bytesOf(src);
    out = out ? bytesOf(out) : new Uint8Array(mipChainBytes(size, levels));
    if (LITTLE && src.byteOffset % 4 === 0 && out.byteOffset % 4 === 0) {
        const s32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
        const o32 = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
        let s = size, from = s32, fromAt = 0, at = 0;
        for (let l = 0; l < levels && s >= 2; l++) {
            mipHalfWords(from, fromAt, s, s, o32, at);
            from = o32; fromAt = at;
            at += (s >> 1) * (s >> 1);
            s >>= 1;
        }
        return out;
    }
    let s = size, offset = 0, prev = src;
    for (let l = 0; l < levels && s >= 2; l++) {
        const n = (s >> 1) * (s >> 1) * 4;
        const dst = out.subarray(offset, offset + n);
        mipHalfBytes(prev, s, s, dst);
        prev = dst;
        offset += n;
        s >>= 1;
    }
    return out;
}

// ---- distance transform ------------------------------------------------------------------------

const INF = Math.fround(1e20);
const FAR = 1e9;

/** Scratch arrays for `distTransform`, reusable across calls of the same or smaller size. */
export function distScratch(w, h) {
    const n = Math.max(w, h);
    return { n, w, f: new Float32Array(n), g: new Float64Array(n), v: new Int32Array(n), z: new Float32Array(n + 1), col: new Float32Array(w) };
}

/**
 * Squared distance of every pixel to the nearest non-zero byte of `feature` (w × h), 1e20
 * where there is none; grow, shrink and feather are thresholds and ramps over it, on a band
 * (the padded box), never the whole selection. Two separable passes:
 *
 * 1. Columns: for a binary feature the 1-D squared transform of a column is the square of
 *    the distance to the nearest feature in that column, which two sweeps (down, up) give
 *    row by row. That is what Felzenszwalb's column pass computes, bit for bit, while walking
 *    memory in row order.
 * 2. Rows: Felzenszwalb / Huttenlocher's lower envelope of parabolas, with the number types
 *    of `distanceTransform` in inpaint_raster.js (f32 storage, f64 intersections;
 *    `g[q] = f[q] + q²` once per row gives the same doubles), so both give the same f32
 *    values. About 70 % of the time is this pass, a data-dependent loop no SIMD touches.
 */
export function distTransform(feature, W, H, out = new Float32Array(W * H), scratch = null) {
    feature = bytesOf(feature);
    if (!scratch || scratch.n < Math.max(W, H) || scratch.w < W) scratch = distScratch(W, H);
    const { f, g, v, z, col } = scratch;
    col.fill(FAR, 0, W);
    for (let y = 0, row = 0; y < H; y++, row += W) {
        for (let x = 0; x < W; x++) {
            const t = feature[row + x] !== 0 ? 0 : col[x] + 1;
            col[x] = t;
            out[row + x] = t;
        }
    }
    col.fill(FAR, 0, W);
    for (let y = H - 1, row = (H - 1) * W; y >= 0; y--, row -= W) {
        for (let x = 0; x < W; x++) {
            const t = feature[row + x] !== 0 ? 0 : col[x] + 1;
            col[x] = t;
            const o = out[row + x];
            const m = o < t ? o : t;
            out[row + x] = m >= 1e8 ? INF : m * m;
        }
    }
    for (let y = 0, row = 0; y < H; y++, row += W) {
        for (let x = 0; x < W; x++) { const fx = out[row + x]; f[x] = fx; g[x] = fx + x * x; }
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < W; q++) {
            const gq = g[q];
            let vk = v[k];
            let s = (gq - g[vk]) / (2 * q - 2 * vk);
            while (s <= z[k]) {
                k--;
                vk = v[k];
                s = (gq - g[vk]) / (2 * q - 2 * vk);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < W; q++) {
            while (z[k + 1] < q) k++;
            const vk = v[k];
            out[row + q] = (q - vk) * (q - vk) + f[vk];
        }
    }
    return out;
}

// ---- flood -------------------------------------------------------------------------------------

let floodStack = new Int32Array(4096);   // grown on demand and kept, like the caller's stack of the Rust kernel

/**
 * Pixels similar to the seed (largest channel difference, alpha included, ≤ tolerance) as
 * 1 / 0 in `out`: 4-connected from the seed by a scanline fill, or every similar pixel.
 * The same set as `floodMask` in inpaint_raster.js. `out.count` is the pixels set.
 */
export function flood(data, W, H, sx, sy, tolerance = 32, contiguous = true, out = new Uint8Array(W * H)) {
    data = bytesOf(data);
    out.fill(0, 0, W * H);
    sx = Math.max(0, Math.min(W - 1, sx | 0));
    sy = Math.max(0, Math.min(H - 1, sy | 0));
    const i0 = (sy * W + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
    const tol = Math.max(0, Math.min(255, tolerance | 0));
    let count = 0;
    if (!contiguous) {
        for (let p = 0, i = 0, n = W * H; p < n; p++, i += 4) {
            if (similarAt(data, i, r0, g0, b0, a0, tol)) {
                out[p] = 1;
                count++;
            }
        }
        out.count = count;
        return out;
    }
    let stack = floodStack;
    let sp = 0;
    stack[sp++] = sx; stack[sp++] = sy;
    while (sp > 0) {
        const y = stack[--sp], x = stack[--sp];
        const row = y * W;
        let p = row + x;
        if (out[p] || !similarAt(data, p * 4, r0, g0, b0, a0, tol)) continue;
        let xl = x, xr = x;
        while (xl > 0 && !out[p - 1] && similarAt(data, (p - 1) * 4, r0, g0, b0, a0, tol)) { xl--; p--; }
        p = row + x;
        while (xr < W - 1 && !out[p + 1] && similarAt(data, (p + 1) * 4, r0, g0, b0, a0, tol)) { xr++; p++; }
        out.fill(1, row + xl, row + xr + 1);
        count += xr - xl + 1;
        for (let pass = 0; pass < 2; pass++) {
            const ny = pass === 0 ? y - 1 : y + 1;
            if (ny < 0 || ny >= H) continue;
            const nrow = ny * W;
            let inSpan = false;
            for (let i = xl; i <= xr; i++) {
                const q = nrow + i;
                const ok = !out[q] && similarAt(data, q * 4, r0, g0, b0, a0, tol);
                if (ok && !inSpan) {
                    if (sp + 2 > stack.length) {
                        const grown = new Int32Array(stack.length * 2);
                        grown.set(stack);
                        stack = floodStack = grown;
                    }
                    stack[sp++] = i; stack[sp++] = ny;
                    inSpan = true;
                } else if (!ok) inSpan = false;
            }
        }
    }
    out.count = count;
    return out;
}

function similarAt(d, i, r0, g0, b0, a0, tol) {
    let e = d[i] - r0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 1] - g0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 2] - b0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 3] - a0; if (e < 0) e = -e;
    return e <= tol;
}

/**
 * The JS flood users run: `floodMask`'s own loop in inpaint_raster.js, moved here verbatim (K1, docs/PLAN_WASM_K1.md)
 * so the flood route's twin is the code users run, not `flood` above, which it beats. The same set as `flood`; a
 * new Uint8Array, no `count`.
 */
export function floodScan(data, W, H, sx, sy, tolerance = 32, contiguous = true) {
    const out = new Uint8Array(W * H);
    sx = Math.max(0, Math.min(W - 1, sx | 0));
    sy = Math.max(0, Math.min(H - 1, sy | 0));
    const i0 = (sy * W + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
    const tol = Math.max(0, tolerance | 0);
    const similar = (i) => {
        const d = Math.abs(data[i] - r0), e = Math.abs(data[i + 1] - g0), f = Math.abs(data[i + 2] - b0), g = Math.abs(data[i + 3] - a0);
        return d <= tol && e <= tol && f <= tol && g <= tol;
    };
    if (!contiguous) {
        for (let p = 0, i = 0; p < W * H; p++, i += 4) if (similar(i)) out[p] = 1;
        return out;
    }
    // scanline flood fill with an explicit stack of spans
    const stack = [sx, sy];
    while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        let p = y * W + x;
        if (out[p] || !similar(p * 4)) continue;
        let xl = x, xr = x;
        while (xl > 0 && !out[p - 1] && similar((p - 1) * 4)) { xl--; p--; }
        p = y * W + x;
        while (xr < W - 1 && !out[p + 1] && similar((p + 1) * 4)) { xr++; p++; }
        const row = y * W;
        for (let i = xl; i <= xr; i++) out[row + i] = 1;
        for (const ny of [y - 1, y + 1]) {
            if (ny < 0 || ny >= H) continue;
            const nrow = ny * W;
            let inSpan = false;
            for (let i = xl; i <= xr; i++) {
                const q = nrow + i;
                const ok = !out[q] && similar(q * 4);
                if (ok && !inSpan) { stack.push(i, ny); inSpan = true; }
                else if (!ok) inSpan = false;
            }
        }
    }
    return out;
}

/**
 * `Px.floodShape`'s twin (px.js; jobs.rs `flood_shape`) on `floodScan`: the region around (sx, sy) clipped to `sel`
 * (RGBA8 of the same size, selected where alpha >= 128, or null), drawn as 255 / 0 alpha bytes when `outKind === 1`
 * (`Uint8Array` of `w * h`) or as `rgb` (0xRRGGBB), opaque where the region is and transparent black elsewhere
 * (`Uint8ClampedArray` of `w * h * 4`). `use(view, count, bounds, cells)` gets the shape, its pixels, its bounds
 * [x0, y0, x1, y1] (right and bottom exclusive, null when empty) and its 256² cell occupancy (`Uint8Array` of
 * `((w + 255) >> 8) * ((h + 255) >> 8)` bytes, 1 occupied, 0 empty), and its result is returned. The shape is a new
 * array: Rust draws over its own copy in wasm memory, while the caller's `rgba` may be a view over the job's
 * SharedArrayBuffer, which an ImageData refuses.
 */
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use, outKind = 4) {
    const mask = floodScan(rgba, w, h, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous);
    const s = sel ? bytesOf(sel) : null;
    const cols = (w + 255) >> 8, rows = (h + 255) >> 8;
    const cells = new Uint8Array(cols * rows);
    let count = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    if (outKind === 1) {
        const out = new Uint8Array(w * h);
        for (let y = 0, p = 0; y < h; y++) {
            let first = -1, last = 0;
            const rowC = (y >> 8) * cols;
            for (let x = 0; x < w; x++, p++) {
                if (!mask[p] || (s !== null && s[p * 4 + 3] < 128)) continue;
                out[p] = 255;
                cells[rowC + (x >> 8)] = 1;
                count++;
                if (first < 0) first = x;
                last = x;
            }
            if (first >= 0) {
                if (first < x0) x0 = first;
                if (last + 1 > x1) x1 = last + 1;
                if (y < y0) y0 = y;
                y1 = y + 1;
            }
        }
        return use(out, count, count > 0 ? [x0, y0, x1, y1] : null, cells);
    }
    const out = new Uint8ClampedArray(w * h * 4);
    rgb >>>= 0;
    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;
    // a word per pixel where the byte order allows it (the array is new, so it starts on a word)
    const words = LITTLE ? new Uint32Array(out.buffer, 0, w * h) : null;
    const word = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    for (let y = 0, p = 0; y < h; y++) {
        let first = -1, last = 0;
        const rowC = (y >> 8) * cols;
        for (let x = 0; x < w; x++, p++) {
            if (!mask[p] || (s !== null && s[p * 4 + 3] < 128)) continue;
            if (words !== null) words[p] = word;
            else { const o = p * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; }
            cells[rowC + (x >> 8)] = 1;
            count++;
            if (first < 0) first = x;
            last = x;
        }
        if (first >= 0) {
            if (first < x0) x0 = first;
            if (last + 1 > x1) x1 = last + 1;
            if (y < y0) y0 = y;
            y1 = y + 1;
        }
    }
    return use(out, count, count > 0 ? [x0, y0, x1, y1] : null, cells);
}

// ---- composite ---------------------------------------------------------------------------------

/**
 * `srcs.length` straight-alpha RGBA8 sources over the tile `dst` (in place). `ops` are OPS
 * numbers, `alphas` opacities 0..255, `masks` one byte of coverage per pixel or null.
 * Straight in and out, premultiplied 8-bit integer maths in between (Canvas 2D keeps
 * premultiplied 8-bit pixels too, so the precision is the same):
 *
 *   mul255(x, y) = round(x·y / 255), exact as t = x·y + 128, (t + (t >> 8)) >> 8
 *   dst is premultiplied once:  dp = mul255(d, da)
 *   per source: sa = mul255(s.a, opacity), sp = mul255(s.c, sa), inv = 255 − sa
 *     source-over      r = sp + mul255(dp, inv)                ra = sa + mul255(da, inv)
 *     destination-out  r = mul255(dp, inv)                     ra = mul255(da, inv)
 *     source-atop      r = mul255(sp, da) + mul255(dp, inv)    ra = mul255(sa, da) + mul255(da, inv)
 *                      (which is da exactly: two rounded terms whose exact sum is an integer)
 *     destination-in   r = mul255(dp, sa)                      ra = mul255(da, sa)
 *     copy             r = sp                                  ra = sa
 *   a mask m is coverage: r = mul255(r, m) + mul255(dp, 255 − m), the same for ra
 *   unpremultiplied once at the end: c = a == 0 ? 0 : min(255, floor((c·255 + a/2) / a))
 *
 * Every channel, alpha included, follows the same formula when the source's alpha byte is
 * taken as 255 for "sp", so a SIMD port can treat all sixteen bytes of four pixels alike.
 * The operator is chosen once per layer, not per pixel, and the common case (no mask, full
 * opacity) has loops of its own.
 *
 * The twenty-five blend modes (ops 5 to 12, docs/PLAN_BCE.md section 3b B item 7; linear light, op 13, docs/PLAN_0_1_31.md section 4 step 8;
 * ops 14 to 19 exclusion, linear dodge, linear burn, subtract, pin light, hard mix, docs/PLAN_NIK9_BUILD.md R4-S4;
 * ops 20 to 23 colour dodge, colour burn, vivid light, divide, docs/PLAN_NIK9_BUILD.md R4-S5;
 * ops 24 to 29 hue, saturation, colour, luminosity, darker colour, lighter colour, docs/PLAN_NIK9_BUILD.md R4-S6)
 * are the W3C formula rounded ONCE per channel (three rounded products were up to 1.45 levels from the exact value; this
 * is within half a level). Linear light is not a W3C mode; B = clamp(cb + 2*cs - 1, 0, 1) as Photoshop has it:
 *
 *   B16(cb, cs) = 255 * B, exact integers:
 *     multiply    b*s                          screen      65025 - (255 - b)(255 - s)
 *     hard-light  s <= 127 ? 2*b*s : 65025 - (255 - b)(510 - 2s)        overlay: b and s swapped
 *     darken, lighten, difference   255 * min, max, |b - s|
 *     linear-light  255 * clamp(b + 2s - 255, 0, 255)
 *     soft-light  s <= 127 ? 255*b - floor(((255 - 2s)*b*(255 - b) + 127) / 255)
 *                         : 255*b + floor(((2s - 255)*(SOFT_D[b] - 257*b) + 128) / 257)
 *     exclusion   b*(255 - s) + s*(255 - b)
 *     linear-dodge  255 * min(b + s, 255)
 *     linear-burn   255 * (max(b + s, 255) - 255)
 *     subtract    255 * (max(b, s) - s)
 *     pin-light   s <= 127 ? 255 * min(b, 2s) : 255 * max(b, 2s - 255)
 *     hard-mix    b + s >= 255 + (s >> 7) ? 65025 : 0     (the tie b + s = 255 as Photoshop has it: white for
 *                 s <= 127, black for s >= 128, vivid light's branch; measured on its merged fixture, R4-D2)
 *     color-dodge   b === 0 ? 0 : s >= 255 ? 65025 : min(65025, floor((130050*b + (255-s)) / (2*(255-s))))
 *     color-burn    b >= 255 ? 65025 : s === 0 ? 0 : 65025 - min(65025, floor((130050*(255-b) + s) / (2*s)))
 *     vivid-light   s <= 127 ? burn(b, 2s) : dodge(b, 2s - 255)
 *     divide        s === 0 ? (b === 0 ? 0 : 65025) : min(65025, floor((130050*b + s) / (2*s)))
 *   over an opaque backdrop:  r = floor((dp*inv*255 + sa*B16 + 32512) / 65025)
 *   else, with cb = dp unpremultiplied as at the end and ra = sa + mul255(da, inv):
 *     r = min(ra, floor((s.c*sa*(255 - da)*255 + dp*inv*65025 + sa*da*B16 + 8290687) / 16581375))
 *   The sums go up to 255^4: plain numbers and Math.floor, no `| 0`.
 */
export function compositeTile(dst, srcs, ops, alphas, masks = null) {
    const d = bytesOf(dst);
    const px = d.length >> 2;
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const a = d[i + 3];
        if (a !== 255) {
            let t = d[i] * a + 128; d[i] = (t + (t >> 8)) >> 8;
            t = d[i + 1] * a + 128; d[i + 1] = (t + (t >> 8)) >> 8;
            t = d[i + 2] * a + 128; d[i + 2] = (t + (t >> 8)) >> 8;
        }
    }
    for (let l = 0; l < srcs.length; l++) {
        const src = bytesOf(srcs[l]), op = ops[l] | 0, o = alphas[l] | 0;
        const mask = masks && masks[l] ? bytesOf(masks[l]) : null;
        if (!mask && o === 255 && op === 0) overFull(d, src, px);
        else if (!mask && o === 255 && op === 1) eraseFull(d, src, px);
        else if (op === 0) over(d, src, o, mask, px);
        else if (op === 1) erase(d, src, o, mask, px);
        else if (op === 2) atop(d, src, o, mask, px);
        else if (op === 3) keepIn(d, src, o, mask, px);
        else if (op >= 5 && op <= 29) blendOp(d, src, o, mask, px, op);
        else if (op > 29) over(d, src, o, mask, px);
        else copyOp(d, src, o, mask, px);
    }
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const a = d[i + 3];
        if (a === 0) {
            d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
        } else if (a !== 255) {
            const h = a >> 1;
            let c = ((d[i] * 255 + h) / a) | 0; d[i] = c > 255 ? 255 : c;
            c = ((d[i + 1] * 255 + h) / a) | 0; d[i + 1] = c > 255 ? 255 : c;
            c = ((d[i + 2] * 255 + h) / a) | 0; d[i + 2] = c > 255 ? 255 : c;
        }
    }
    return dst;
}

// mul255(x, y) = (t + (t >> 8)) >> 8 with t = x·y + 128, written out in every loop below

function overFull(d, s, px) {
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const sa = s[i + 3];
        if (sa === 0) continue;
        if (sa === 255) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255; continue; }
        const inv = 255 - sa;
        let t = s[i] * sa + 128, u = d[i] * inv + 128;
        d[i] = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 1] * sa + 128; u = d[i + 1] * inv + 128;
        d[i + 1] = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 2] * sa + 128; u = d[i + 2] * inv + 128;
        d[i + 2] = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        u = d[i + 3] * inv + 128;
        d[i + 3] = sa + ((u + (u >> 8)) >> 8);
    }
}

function eraseFull(d, s, px) {
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const sa = s[i + 3];
        if (sa === 0) continue;
        const inv = 255 - sa;
        let u = d[i] * inv + 128; d[i] = (u + (u >> 8)) >> 8;
        u = d[i + 1] * inv + 128; d[i + 1] = (u + (u >> 8)) >> 8;
        u = d[i + 2] * inv + 128; d[i + 2] = (u + (u >> 8)) >> 8;
        u = d[i + 3] * inv + 128; d[i + 3] = (u + (u >> 8)) >> 8;
    }
}

/** Blend the result r (premultiplied, 4 channels) with the old pixel by coverage m and store it. */
function lerpStore(d, i, r, g, b, a, m) {
    if (m !== 255) {
        const im = 255 - m;
        let t = r * m + 128, u = d[i] * im + 128; r = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = g * m + 128; u = d[i + 1] * im + 128; g = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = b * m + 128; u = d[i + 2] * im + 128; b = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = a * m + 128; u = d[i + 3] * im + 128; a = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
}

function effectiveAlpha(sa, o) {
    if (o === 255) return sa;
    const t = sa * o + 128;
    return (t + (t >> 8)) >> 8;
}

function over(d, s, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        if (sa === 0) continue;
        if (sa === 255 && m === 255) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255; continue; }
        const inv = 255 - sa;
        let t = s[i] * sa + 128, u = d[i] * inv + 128;
        const r = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 1] * sa + 128; u = d[i + 1] * inv + 128;
        const g = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 2] * sa + 128; u = d[i + 2] * inv + 128;
        const b = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        u = d[i + 3] * inv + 128;
        lerpStore(d, i, r, g, b, sa + ((u + (u >> 8)) >> 8), m);
    }
}

function erase(d, s, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        if (sa === 0) continue;
        const inv = 255 - sa;
        let u = d[i] * inv + 128; const r = (u + (u >> 8)) >> 8;
        u = d[i + 1] * inv + 128; const g = (u + (u >> 8)) >> 8;
        u = d[i + 2] * inv + 128; const b = (u + (u >> 8)) >> 8;
        u = d[i + 3] * inv + 128;
        lerpStore(d, i, r, g, b, (u + (u >> 8)) >> 8, m);
    }
}

function atop(d, s, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        if (sa === 0) continue;
        const inv = 255 - sa, da = d[i + 3];
        let t = s[i] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; let u = d[i] * inv + 128;
        const r = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 1] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; u = d[i + 1] * inv + 128;
        const g = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = s[i + 2] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; u = d[i + 2] * inv + 128;
        const b = ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8);
        t = sa * da + 128; u = da * inv + 128;
        lerpStore(d, i, r, g, b, ((t + (t >> 8)) >> 8) + ((u + (u >> 8)) >> 8), m);
    }
}

function keepIn(d, s, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        if (sa === 255) continue;
        let t = d[i] * sa + 128; const r = (t + (t >> 8)) >> 8;
        t = d[i + 1] * sa + 128; const g = (t + (t >> 8)) >> 8;
        t = d[i + 2] * sa + 128; const b = (t + (t >> 8)) >> 8;
        t = d[i + 3] * sa + 128;
        lerpStore(d, i, r, g, b, (t + (t >> 8)) >> 8, m);
    }
}

function copyOp(d, s, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        let t = s[i] * sa + 128; const r = (t + (t >> 8)) >> 8;
        t = s[i + 1] * sa + 128; const g = (t + (t >> 8)) >> 8;
        t = s[i + 2] * sa + 128; const b = (t + (t >> 8)) >> 8;
        lerpStore(d, i, r, g, b, sa, m);
    }
}

/** round(65535 · d(b / 255)) of soft-light: d = ((16b − 12)b + 4)b up to a quarter (b ≤ 63), else the square root. The crate holds the same numbers. */
const SOFT_D = new Uint16Array([
    0, 1016, 2008, 2977, 3923, 4846, 5746, 6625, 7482, 8318, 9134, 9929, 10704, 11459, 12195, 12912,
    13611, 14291, 14954, 15600, 16228, 16840, 17436, 18016, 18580, 19129, 19664, 20184, 20690, 21183, 21663, 22129,
    22584, 23026, 23457, 23876, 24284, 24682, 25070, 25448, 25817, 26176, 26527, 26870, 27205, 27532, 27852, 28166,
    28473, 28774, 29069, 29360, 29645, 29926, 30203, 30476, 30746, 31013, 31278, 31540, 31800, 32059, 32317, 32575,
    32832, 33087, 33341, 33592, 33842, 34090, 34336, 34581, 34823, 35064, 35304, 35541, 35778, 36012, 36245, 36477,
    36707, 36936, 37163, 37389, 37613, 37837, 38059, 38279, 38499, 38717, 38934, 39149, 39364, 39577, 39789, 40000,
    40210, 40419, 40627, 40834, 41040, 41244, 41448, 41651, 41852, 42053, 42253, 42452, 42650, 42847, 43043, 43238,
    43432, 43626, 43818, 44010, 44201, 44391, 44580, 44769, 44957, 45144, 45330, 45515, 45700, 45884, 46067, 46249,
    46431, 46612, 46792, 46972, 47151, 47329, 47507, 47684, 47860, 48036, 48211, 48385, 48559, 48732, 48904, 49076,
    49248, 49418, 49588, 49758, 49927, 50095, 50263, 50430, 50597, 50763, 50929, 51094, 51258, 51422, 51586, 51749,
    51911, 52073, 52235, 52396, 52556, 52716, 52876, 53035, 53193, 53351, 53509, 53666, 53823, 53979, 54135, 54290,
    54445, 54600, 54754, 54907, 55060, 55213, 55365, 55517, 55669, 55820, 55971, 56121, 56271, 56420, 56569, 56718,
    56866, 57014, 57162, 57309, 57455, 57602, 57748, 57893, 58039, 58184, 58328, 58472, 58616, 58760, 58903, 59046,
    59188, 59330, 59472, 59613, 59755, 59895, 60036, 60176, 60316, 60455, 60594, 60733, 60872, 61010, 61148, 61285,
    61422, 61559, 61696, 61832, 61968, 62104, 62240, 62375, 62510, 62644, 62779, 62913, 63046, 63180, 63313, 63446,
    63578, 63711, 63843, 63974, 64106, 64237, 64368, 64499, 64629, 64759, 64889, 65019, 65148, 65277, 65406, 65535,
]);

function hardLight(b, s) {
    return s <= 127 ? 2 * b * s : 65025 - (255 - b) * (510 - 2 * s);
}

function dodge16(b, s) {
    if (b === 0) return 0;
    if (s >= 255) return 65025;
    const d = 255 - s;
    return Math.min(65025, Math.floor((130050 * b + d) / (2 * d)));
}

function burn16(b, s) {
    if (b >= 255) return 65025;
    if (s === 0) return 0;
    return 65025 - Math.min(65025, Math.floor((130050 * (255 - b) + s) / (2 * s)));
}

/** 255 * B(cb, cs) of a blend mode, both straight 0..255: 0..65025. */
function blendOf(op, b, s) {
    switch (op) {
        case 5: return b * s;
        case 6: return 65025 - (255 - b) * (255 - s);
        case 7: return hardLight(s, b);
        case 8: return 255 * (b < s ? b : s);
        case 9: return 255 * (b > s ? b : s);
        case 10:
            if (s <= 127) return 255 * b - Math.floor(((255 - 2 * s) * b * (255 - b) + 127) / 255);
            return 255 * b + Math.floor(((2 * s - 255) * (SOFT_D[b] - b * 257) + 128) / 257);
        case 11: return hardLight(b, s);
        case 12: return 255 * (b > s ? b - s : s - b);
        case 13: { const t = b + 2 * s - 255; return 255 * (t < 0 ? 0 : t > 255 ? 255 : t); }
        case 14: return b * (255 - s) + s * (255 - b);
        case 15: return 255 * Math.min(255, b + s);
        case 16: return 255 * Math.max(0, b + s - 255);
        case 17: return 255 * Math.max(0, b - s);
        case 18: return s <= 127 ? 255 * Math.min(b, 2 * s) : 255 * Math.max(b, 2 * s - 255);
        case 19: return b + s >= 255 + (s >> 7) ? 65025 : 0;
        case 20: return dodge16(b, s);
        case 21: return burn16(b, s);
        case 22: return s <= 127 ? burn16(b, 2 * s) : dodge16(b, 2 * s - 255);
        case 23: {
            if (s === 0) return b === 0 ? 0 : 65025;
            return Math.min(65025, Math.floor((130050 * b + s) / (2 * s)));
        }
        default: return 255 * (b > s ? b - s : s - b);
    }
}

function nonsep(op, b0, b1, b2, s0, s1, s2, out) {
    let p0 = 0, p1 = 0, p2 = 0;
    let d = 1;
    let l = 0;

    if (op === 24) {
        const minS = Math.min(s0, s1, s2);
        const maxS = Math.max(s0, s1, s2);
        const satS = maxS - minS;
        if (satS === 0) {
            p0 = 0; p1 = 0; p2 = 0;
            d = 1;
        } else {
            const minB = Math.min(b0, b1, b2);
            const maxB = Math.max(b0, b1, b2);
            const satB = maxB - minB;
            p0 = (s0 - minS) * satB;
            p1 = (s1 - minS) * satB;
            p2 = (s2 - minS) * satB;
            d = satS;
        }
        l = 30 * b0 + 59 * b1 + 11 * b2;
    } else if (op === 25) {
        const minB = Math.min(b0, b1, b2);
        const maxB = Math.max(b0, b1, b2);
        const satB = maxB - minB;
        if (satB === 0) {
            p0 = 0; p1 = 0; p2 = 0;
            d = 1;
        } else {
            const minS = Math.min(s0, s1, s2);
            const maxS = Math.max(s0, s1, s2);
            const satS = maxS - minS;
            p0 = (b0 - minB) * satS;
            p1 = (b1 - minB) * satS;
            p2 = (b2 - minB) * satS;
            d = satB;
        }
        l = 30 * b0 + 59 * b1 + 11 * b2;
    } else if (op === 26) {
        p0 = s0; p1 = s1; p2 = s2;
        d = 1;
        l = 30 * b0 + 59 * b1 + 11 * b2;
    } else if (op === 27) {
        p0 = b0; p1 = b1; p2 = b2;
        d = 1;
        l = 30 * s0 + 59 * s1 + 11 * s2;
    }

    const lumP = 30 * p0 + 59 * p1 + 11 * p2;
    const lu = l * d;
    const u0 = 100 * p0 + lu - lumP;
    const u1 = 100 * p1 + lu - lumP;
    const u2 = 100 * p2 + lu - lumP;
    const un = Math.min(u0, u1, u2);
    const ux = Math.max(u0, u1, u2);

    if (un < 0) {
        const denom = 100 * (lu - un);
        out[0] = Math.floor((2 * 255 * l * (u0 - un) + denom) / (2 * denom));
        out[1] = Math.floor((2 * 255 * l * (u1 - un) + denom) / (2 * denom));
        out[2] = Math.floor((2 * 255 * l * (u2 - un) + denom) / (2 * denom));
    } else if (ux > 25500 * d) {
        const denom = 100 * (ux - lu);
        const k1 = l * (ux - lu);
        const k2 = 25500 - l;
        out[0] = Math.floor((2 * 255 * (k1 + (u0 - lu) * k2) + denom) / (2 * denom));
        out[1] = Math.floor((2 * 255 * (k1 + (u1 - lu) * k2) + denom) / (2 * denom));
        out[2] = Math.floor((2 * 255 * (k1 + (u2 - lu) * k2) + denom) / (2 * denom));
    } else {
        const denom = 100 * d;
        out[0] = Math.floor((2 * 255 * u0 + denom) / (2 * denom));
        out[1] = Math.floor((2 * 255 * u1 + denom) / (2 * denom));
        out[2] = Math.floor((2 * 255 * u2 + denom) / (2 * denom));
    }
    return out;
}

export function blend3(op, b0, b1, b2, s0, s1, s2, out) {
    if (op >= 24 && op <= 27) {
        return nonsep(op, b0, b1, b2, s0, s1, s2, out);
    }
    if (op === 28) {
        if (s0 + s1 + s2 < b0 + b1 + b2) {
            out[0] = 255 * s0;
            out[1] = 255 * s1;
            out[2] = 255 * s2;
        } else {
            out[0] = 255 * b0;
            out[1] = 255 * b1;
            out[2] = 255 * b2;
        }
        return out;
    }
    if (op === 29) {
        if (s0 + s1 + s2 > b0 + b1 + b2) {
            out[0] = 255 * s0;
            out[1] = 255 * s1;
            out[2] = 255 * s2;
        } else {
            out[0] = 255 * b0;
            out[1] = 255 * b1;
            out[2] = 255 * b2;
        }
        return out;
    }
    out[0] = blendOf(op, b0, s0);
    out[1] = blendOf(op, b1, s1);
    out[2] = blendOf(op, b2, s2);
    return out;
}

const BLEND_BUF = new Int32Array(3);

function blendOp(d, s, o, mask, px, op) {
    const bl = BLEND_BUF;
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        const sa = effectiveAlpha(s[i + 3], o);
        if (sa === 0) continue;
        const inv = 255 - sa, da = d[i + 3];
        if (da === 255) {
            blend3(op, d[i], d[i + 1], d[i + 2], s[i], s[i + 1], s[i + 2], bl);
            const k = inv * 255;
            const r = Math.floor((d[i] * k + sa * bl[0] + 32512) / 65025);
            const g = Math.floor((d[i + 1] * k + sa * bl[1] + 32512) / 65025);
            const b = Math.floor((d[i + 2] * k + sa * bl[2] + 32512) / 65025);
            lerpStore(d, i, r, g, b, 255, m);
            continue;
        }
        const t = da * inv + 128;
        const ra = sa + ((t + (t >> 8)) >> 8);
        const both = sa * da, only = sa * (255 - da) * 255, h = da >> 1, below = inv * 65025;
        let cb0 = 0, cb1 = 0, cb2 = 0;
        if (da !== 0) {
            cb0 = ((d[i] * 255 + h) / da) | 0; if (cb0 > 255) cb0 = 255;
            cb1 = ((d[i + 1] * 255 + h) / da) | 0; if (cb1 > 255) cb1 = 255;
            cb2 = ((d[i + 2] * 255 + h) / da) | 0; if (cb2 > 255) cb2 = 255;
        }
        blend3(op, cb0, cb1, cb2, s[i], s[i + 1], s[i + 2], bl);
        let r = Math.floor((s[i] * only + d[i] * below + both * bl[0] + 8290687) / 16581375);
        if (r > ra) r = ra;
        let g = Math.floor((s[i + 1] * only + d[i + 1] * below + both * bl[1] + 8290687) / 16581375);
        if (g > ra) g = ra;
        let b = Math.floor((s[i + 2] * only + d[i + 2] * below + both * bl[2] + 8290687) / 16581375);
        if (b > ra) b = ra;
        lerpStore(d, i, r, g, b, ra, m);
    }
}

let MASKED_SCRATCH = null;

function maskedTileRefused(dst, src, mask, px, write) {
    if (!Number.isInteger(px) || px <= 0 || px > 4096 * 4096) return `refused ${px} pixels`;
    const n = px * 4;
    if (!src || !(src.length >= n)) return "a source too small";
    if (dst && !(dst.length >= n)) return "a tile too small";
    if (mask && !(mask.length >= px)) return "a mask too small";
    if (typeof write !== "function") return "no write callback";
    return "";
}

/**
 * One tile of `px` pixels (`src` straight RGBA8, `op` an OPS number, `alpha` 0..255, optional `mask` of `px` coverage
 * bytes) composited over `dst` (`px * 4` straight RGBA8 bytes, or null when the destination tile does not exist yet),
 * keeping `dst` (or 0) untouched where `src` has alpha 0 or `mask` is 0 (`compositeStroke` in `inpaint_tiles.js`, K36).
 * Returns 0 when no pixel changed, 1 when changed and non-empty (calling `write(true)` once for the buffer all `px * 4`
 * bytes are copied into), 2 when changed and every pixel has alpha 0 afterwards. Rust twin: crates/px/src/composite.rs
 * `masked_tile` (`px.js` `compositeMaskedTile`).
 */
export function compositeMaskedTile(dst, src, op, alpha, mask = null, px = 65536, write = null) {
    const refused = maskedTileRefused(dst, src, mask, px, write);
    if (refused) throw new Error("px: composite_masked_tile: " + refused);
    op = (op | 0) & 255;
    alpha = (alpha | 0) & 255;
    if (!dst && op >= 1 && op <= 3) return 0;
    const s8 = bytesOf(src);
    const d8 = dst ? bytesOf(dst) : null;
    const m8 = mask ? bytesOf(mask) : null;
    let first = -1, last = -1;
    if (m8) {
        for (let i = 0; i < px; i++) {
            if (m8[i] !== 0 && s8[i * 4 + 3] !== 0) { first = i; break; }
        }
        if (first < 0) return 0;
        for (let i = px - 1; i >= first; i--) {
            if (m8[i] !== 0 && s8[i * 4 + 3] !== 0) { last = i; break; }
        }
    } else {
        for (let i = 0; i < px; i++) {
            if (s8[i * 4 + 3] !== 0) { first = i; break; }
        }
        if (first < 0) return 0;
        for (let i = px - 1; i >= first; i--) {
            if (s8[i * 4 + 3] !== 0) { last = i; break; }
        }
    }
    const span = last - first + 1, spanBytes = span * 4;
    let scratch = MASKED_SCRATCH;
    if (!scratch || scratch.length < spanBytes) {
        scratch = MASKED_SCRATCH = new Uint8Array(Math.max(256 * 256 * 4, spanBytes));
    }
    const work = scratch.subarray(0, spanBytes);
    if (d8) work.set(d8.subarray(first * 4, (last + 1) * 4));
    else work.fill(0);
    compositeTile(work, [s8.subarray(first * 4, (last + 1) * 4)], [op], [alpha], [m8 ? m8.subarray(first, last + 1) : null]);
    let changed = false, nonEmpty = false;
    for (let p = 0, i = first; p < span; p++, i++) {
        const wo = p * 4, io = i * 4;
        if (s8[io + 3] === 0 || (m8 !== null && m8[i] === 0)) {
            if (d8) {
                work[wo] = d8[io]; work[wo + 1] = d8[io + 1]; work[wo + 2] = d8[io + 2]; work[wo + 3] = d8[io + 3];
            } else {
                work[wo] = 0; work[wo + 1] = 0; work[wo + 2] = 0; work[wo + 3] = 0;
            }
        } else if (!changed) {
            if (d8) {
                if (work[wo] !== d8[io] || work[wo + 1] !== d8[io + 1] || work[wo + 2] !== d8[io + 2] || work[wo + 3] !== d8[io + 3]) changed = true;
            } else if (work[wo] !== 0 || work[wo + 1] !== 0 || work[wo + 2] !== 0 || work[wo + 3] !== 0) {
                changed = true;
            }
        }
        if (!nonEmpty && work[wo + 3] !== 0) nonEmpty = true;
    }
    if (!changed) return 0;
    if (!nonEmpty && d8) {
        for (let i = 3, e = first * 4; i < e; i += 4) if (d8[i] !== 0) { nonEmpty = true; break; }
        if (!nonEmpty) {
            for (let i = (last + 1) * 4 + 3, e = px * 4; i < e; i += 4) if (d8[i] !== 0) { nonEmpty = true; break; }
        }
    }
    if (!nonEmpty) return 2;
    const out = bytesOf(write(true));
    if (d8) {
        if (out !== d8) {
            if (first > 0) out.set(d8.subarray(0, first * 4), 0);
            if (last + 1 < px) out.set(d8.subarray((last + 1) * 4, px * 4), (last + 1) * 4);
        }
        out.set(work, first * 4);
    } else {
        if (first > 0) out.fill(0, 0, first * 4);
        out.set(work, first * 4);
        if (last + 1 < px) out.fill(0, (last + 1) * 4, px * 4);
    }
    return 1;
}

// ---- colour match (B item 7 part 3) -----------------------------------------------------------

/**
 * The colour match of a layer over straight RGBA8, in place: per channel `m = (v - meanT) * scale + meanS`,
 * `r = v + (m - v) * k`, clamped to 0..255 and rounded as `floor(r + 0.5)`, every operation in f32 (`Math.fround`),
 * which is what the Rust kernel computes, scalar and SIMD alike, so the three give the same bytes. Alpha and
 * fully transparent pixels are untouched. `params`: meanS[3], meanT[3], scale[3], k.
 */
export function matchPixels(rgba, params) {
    const d = bytesOf(rgba), f = Math.fround;
    const ms0 = f(params[0]), ms1 = f(params[1]), ms2 = f(params[2]);
    const mt0 = f(params[3]), mt1 = f(params[4]), mt2 = f(params[5]);
    const sc0 = f(params[6]), sc1 = f(params[7]), sc2 = f(params[8]), k = f(params[9]);
    const one = (v, mt, sc, ms) => {
        const m = f(f(f(v - mt) * sc) + ms);
        let r = f(v + f(f(m - v) * k));
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        return Math.floor(f(r + 0.5));
    };
    for (let i = 0, n = (d.length >> 2) << 2; i < n; i += 4) {
        if (d[i + 3] === 0) continue;
        d[i] = one(d[i], mt0, sc0, ms0);
        d[i + 1] = one(d[i + 1], mt1, sc1, ms1);
        d[i + 2] = one(d[i + 2], mt2, sc2, ms2);
    }
    return rgba;
}

// ---- PNG rows ----------------------------------------------------------------------------------

/**
 * `rows` rows of RGBA8 (`w` wide) filtered into `out` (rows × (1 + 4w) bytes): per row the
 * filter byte of None / Sub / Up / Average / Paeth with the smallest sum of absolute signed
 * values (libpng's heuristic, ties to the lower type), then the filtered row. `prev` is the
 * row above the first one; when `prev` is null the first row picks only None or Sub (P5).
 */
export function pngFilterRows(rgba, w, rows, prev = null, out = new Uint8Array(rows * (1 + 4 * w))) {
    rgba = bytesOf(rgba);
    if (prev) prev = bytesOf(prev);
    const n = w * 4;
    const zero = prev ? null : new Uint8Array(n);
    for (let y = 0; y < rows; y++) {
        const r = y * n;
        const up = y === 0 ? (prev || zero) : rgba;
        const u = y === 0 ? 0 : r - n;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
        for (let i = 0; i < n; i++) {
            const x = rgba[r + i];
            const a = i >= 4 ? rgba[r + i - 4] : 0;
            const b = up[u + i];
            const c = i >= 4 ? up[u + i - 4] : 0;
            let v = x; s0 += v < 128 ? v : 256 - v;
            v = (x - a) & 255; s1 += v < 128 ? v : 256 - v;
            v = (x - b) & 255; s2 += v < 128 ? v : 256 - v;
            v = (x - ((a + b) >> 1)) & 255; s3 += v < 128 ? v : 256 - v;
            v = (x - paeth(a, b, c)) & 255; s4 += v < 128 ? v : 256 - v;
        }
        let best = 0, min = s0;
        if (s1 < min) { best = 1; min = s1; }
        if (y > 0 || prev) {
            if (s2 < min) { best = 2; min = s2; }
            if (s3 < min) { best = 3; min = s3; }
            if (s4 < min) { best = 4; min = s4; }
        }
        const o = y * (n + 1);
        out[o] = best;
        for (let i = 0; i < n; i++) {
            const x = rgba[r + i];
            const a = i >= 4 ? rgba[r + i - 4] : 0;
            const b = up[u + i];
            const c = i >= 4 ? up[u + i - 4] : 0;
            out[o + 1 + i] = best === 0 ? x : best === 1 ? x - a : best === 2 ? x - b : best === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        }
    }
    return out;
}

function paeth(a, b, c) {
    let pa = b - c; if (pa < 0) pa = -pa;
    let pb = a - c; if (pb < 0) pb = -pb;
    let pc = a + b - 2 * c; if (pc < 0) pc = -pc;
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ---- PSD rows ----------------------------------------------------------------------------------

/** PackBits (the RLE of TIFF and PSD) of `n` bytes of `src` from `at`, every `step`-th byte; appended to `out` (an array). */
function packBitsInto(src, at, step, n, out) {
    let i = 0;
    while (i < n) {
        const v = src[at + i * step];
        let j = i;
        while (j + 1 < n && src[at + (j + 1) * step] === v && j - i < 126) j++;
        const run = j - i + 1;
        if (run >= 2) { out.push(257 - run, v); i = j + 1; continue; }
        let k = i;
        while (k < n && k - i < 128) { if (k + 1 < n && src[at + (k + 1) * step] === src[at + k * step]) break; k++; }
        if (k === i) k = i + 1;
        out.push(k - i - 1);
        for (let m = i; m < k; m++) out.push(src[at + m * step]);
        i = k;
    }
}

/**
 * PackBits of the four channels of `rows` rows of RGBA8 (`w` wide) for a PSD: `[{ lens, data }]` for R, G, B, A, with
 * `lens` each row's packed length as big-endian u16 and `data` the packed rows one after the other. The runs are the
 * ones inpaint_export.js `packBits` finds.
 */
export function psdPackRows(rgba, w, rows) {
    rgba = bytesOf(rgba);
    const out = [];
    for (let ch = 0; ch < 4; ch++) {
        const lens = new Uint8Array(rows * 2), bytes = [];
        for (let y = 0; y < rows; y++) {
            const before = bytes.length;
            packBitsInto(rgba, y * w * 4 + ch, 4, w, bytes);
            const n = bytes.length - before;
            lens[y * 2] = n >> 8; lens[y * 2 + 1] = n & 255;
        }
        out.push({ lens, data: Uint8Array.from(bytes) });
    }
    return out;
}

/** A zlib stream through the browser's native `CompressionStream("deflate")`. */
export async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- float masks of a provider run (stitch.js) -------------------------------------------------------------------

/** The alpha channel of RGBA8 bytes `rgba` as a 0..1 Float32Array (`out` when given, else a new one; `stitch.js` `maskFromAlpha`). */
export function alphaToMask(rgba, out = null) {
    const n = rgba.length >>> 2;
    const dst = out || new Float32Array(n);
    for (let i = 0, j = 3; i < n; i++, j += 4) dst[i] = rgba[j] / 255;
    return dst;
}

/**
 * Element-wise `Math.max(a[i], b[i])` (when `b` is given) and/or `Math.min(1, Math.max(0, x))` (when `clamp` is true)
 * into `out` (allocated when absent; may be `a`, never `b`).
 */
export function maskMaxClamp(a, b = null, clamp = false, out = null) {
    const n = a.length;
    const dst = out || new Float32Array(n);
    if (b && clamp) {
        for (let i = 0; i < n; i++) dst[i] = Math.min(1, Math.max(0, Math.max(a[i], b[i])));
    } else if (b) {
        for (let i = 0; i < n; i++) dst[i] = Math.max(a[i], b[i]);
    } else if (clamp) {
        for (let i = 0; i < n; i++) dst[i] = Math.min(1, Math.max(0, a[i]));
    } else if (dst !== a) {
        dst.set(a);
    }
    return dst;
}

/** `1 - src[i]` for every float of `src`, into `out` (allocated when absent; may be `src`). */
export function maskOneMinus(src, out = null) {
    const n = src.length;
    const dst = out || new Float32Array(n);
    for (let i = 0; i < n; i++) dst[i] = 1 - src[i];
    return dst;
}

/**
 * A 0..1 float mask `src` as RGBA8 bytes (`out` when given, else a new `Uint8ClampedArray`):
 * `mode` 0 white `[255, 255, 255, v]`, 1 luminance `[v, v, v, 255]` (`v = Math.round(clamp01(x) * 255)`,
 * `stitch.js` `maskToCanvas`), 2 alpha `[0, 0, 0, x > 0.5 ? 0 : 255]` (`stitch.js` `alphaMask`).
 */
export function maskToRgba(src, mode = 0, out = null) {
    const n = src.length;
    const dst = out || new Uint8ClampedArray(n * 4);
    if (mode === 2) {
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            dst[j] = 0; dst[j + 1] = 0; dst[j + 2] = 0; dst[j + 3] = src[i] > 0.5 ? 0 : 255;
        }
    } else if (mode === 1) {
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const v = Math.round(Math.min(1, Math.max(0, src[i])) * 255);
            dst[j] = v; dst[j + 1] = v; dst[j + 2] = v; dst[j + 3] = 255;
        }
    } else {
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const v = Math.round(Math.min(1, Math.max(0, src[i])) * 255);
            dst[j] = 255; dst[j + 1] = 255; dst[j + 2] = 255; dst[j + 3] = v;
        }
    }
    return dst;
}

/**
 * Bounding box `[x0, y0, x1, y1]` (right and bottom exclusive) of the pixels of a `w` x `h` float mask `src` with
 * `src[y * w + x] > 0.5`, or `null` when none are (`stitch.js` `selectionBbox`).
 */
export function maskBoundsF32(src, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!(src[row + x] > 0.5)) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * Matches the weighted RGB mean and standard deviation of `patch` (`n * 4` RGBA8 bytes, in place) to `reference`
 * (`n * 4` RGBA8 bytes) under `weight` (`n` f32, `stitch.js` `colorMatch`). Leaves `patch` untouched and returns
 * `false` when the clamped weight sum is below 64, else `true`.
 */
export function colorMatchRgba(patch, reference, weight) {
    const n = weight.length;
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.min(1, Math.max(0, weight[i]));
    if (total < 64) return false;
    const p = patch instanceof Uint8ClampedArray ? patch : new Uint8ClampedArray(patch.buffer, patch.byteOffset, n * 4);
    const stats = (d) => {
        const mean = [0, 0, 0], v = [0, 0, 0];
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const wt = weight[i];
            if (wt <= 0) continue;
            mean[0] += d[j] * wt; mean[1] += d[j + 1] * wt; mean[2] += d[j + 2] * wt;
        }
        for (let c = 0; c < 3; c++) mean[c] /= total;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const wt = weight[i];
            if (wt <= 0) continue;
            for (let c = 0; c < 3; c++) { const dd = d[j + c] - mean[c]; v[c] += dd * dd * wt; }
        }
        return { mean, std: v.map((x) => Math.sqrt(Math.max(x / total, 1e-6 * 255 * 255))) };
    };
    const r = stats(reference), t = stats(p);
    const scale = [0, 1, 2].map((c) => Math.min(2, Math.max(0.5, r.std[c] / t.std[c])));
    for (let j = 0, end = n * 4; j < end; j += 4) {
        for (let c = 0; c < 3; c++) {
            p[j + c] = Math.min(255, Math.max(0, (p[j + c] - t.mean[c]) * scale[c] + r.mean[c]));
        }
    }
    return true;
}

/**
 * The alpha byte of each RGBA8 pixel of `rgba` replaced in `out` (allocated when absent; may be `rgba`) by
 * `Math.round(clamp01(mask[i]) * (keepAlpha ? rgba[i * 4 + 3] : 255))` (`stitch.js` align copy and final alpha).
 */
export function blendAlpha(rgba, mask, keepAlpha = false, out = null) {
    const n = mask.length;
    const dst = out || new Uint8ClampedArray(n * 4);
    if (dst !== rgba) dst.set(rgba.subarray(0, n * 4));
    const clamped = dst instanceof Uint8ClampedArray ? dst : new Uint8ClampedArray(dst.buffer, dst.byteOffset, n * 4);
    if (keepAlpha) {
        for (let i = 0, j = 3; i < n; i++, j += 4) {
            const a = Math.min(1, Math.max(0, mask[i]));
            clamped[j] = Math.round(a * clamped[j]);
        }
    } else {
        for (let i = 0, j = 3; i < n; i++, j += 4) {
            const a = Math.min(1, Math.max(0, mask[i]));
            clamped[j] = Math.round(a * 255);
        }
    }
    return dst;
}

function shrinkPlane(src, w, h, tw, th, out = null) {
    const dst = out || new Float32Array(tw * th);
    if (tw === w && th === h) {
        if (dst !== src) dst.set(src.subarray(0, tw * th));
        return dst;
    }
    const fx = w / tw, fy = h / th;
    for (let y = 0; y < th; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * fy)));
        for (let x = 0; x < tw; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * fx)));
            let s = 0;
            for (let yy = y0; yy < y1; yy++) { const row = yy * w; for (let xx = x0; xx < x1; xx++) s += src[row + xx]; }
            dst[y * tw + x] = s / ((y1 - y0) * (x1 - x0));
        }
    }
    return dst;
}

/**
 * Area-average shrink of straight-alpha RGBA8 `rgba` (`w * h * 4` bytes) to unpremultiplied grayscale `gray` and
 * straight alpha `alpha` (`tw * th` Float32Arrays, `edgefit.js` `shrinkRGBA`). `a[i]` is rounded to f32 before
 * averaging while `g[i]` multiplies by the unrounded double alpha (`edgefit.js:65-67`).
 */
export function edgefitShrink(rgba, w, h, tw, th, grayOut = null, alphaOut = null) {
    const n = w * h, g = new Float32Array(n), a = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const al = rgba[j + 3] / 255;
        a[i] = al;
        g[i] = al * (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    }
    const gs = shrinkPlane(g, w, h, tw, th, grayOut), as = shrinkPlane(a, w, h, tw, th, alphaOut);
    for (let i = 0; i < gs.length; i++) gs[i] = as[i] > 1e-4 ? gs[i] / as[i] : 0;
    return { gray: gs, alpha: as };
}

/**
 * Bilinear inverse-affine warp of RGBA8 `src` (`w * h * 4` bytes) through `m` (`[a00, a01, tx, a10, a11, ty]`,
 * `edgefit.js` `warpRGBA`), into `out` (allocated as a `Uint8ClampedArray` when absent; must not alias `src`).
 */
export function warpRgba(src, w, h, m, out = null) {
    const dst = out || new Uint8ClampedArray(w * h * 4);
    const clamped = dst instanceof Uint8ClampedArray ? dst : new Uint8ClampedArray(dst.buffer, dst.byteOffset, w * h * 4);
    const [a00, a01, tx, a10, a11, ty] = m;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let X = a00 * x + a01 * y + tx, Y = a10 * x + a11 * y + ty;
        X = Math.min(w - 1, Math.max(0, X)); Y = Math.min(h - 1, Math.max(0, Y));
        const x0 = Math.min(w - 2, X | 0), y0 = Math.min(h - 2, Y | 0);
        const fx = w > 1 ? X - x0 : 0, fy = h > 1 ? Y - y0 : 0;
        const j = (Math.max(0, y0) * w + Math.max(0, x0)) * 4, dx = w > 1 ? 4 : 0, dy = h > 1 ? w * 4 : 0, o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
            clamped[o + c] = (src[j + c] * (1 - fx) + src[j + dx + c] * fx) * (1 - fy) + (src[j + dy + c] * (1 - fx) + src[j + dy + dx + c] * fx) * fy;
        }
    }
    return dst;
}

/**
 * Per-pixel source-bounds coverage mask (`w * h` Float32Array, 1 inside, 1 px ramp to 0 outside) for `m`
 * (`[a00, a01, tx, a10, a11, ty]`, `edgefit.js` `warpCoverage`).
 */
export function warpCoverage(w, h, m, out = null) {
    const dst = out || new Float32Array(w * h);
    const [a00, a01, tx, a10, a11, ty] = m;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
        const X = a00 * x + a01 * y + tx, Y = a10 * x + a11 * y + ty;
        const d = Math.min(X, w - 1 - X, Y, h - 1 - Y) + 1;
        dst[i] = d >= 1 ? 1 : d <= 0 ? 0 : d;
    }
    return dst;
}

/**
 * The running maximum of every row over [x - r, x + r] (clamped to the row), never below 0: a monotonic queue of
 * indices, so a pixel costs the same whatever the radius (a loop over the radius took 1.9 s of a run's crop,
 * docs/PERFORMANCE.md section 14). `idx` is scratch of at least w entries.
 */
function maxRows(src, dst, w, h, r, idx) {
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let head = 0, tail = 0, next = 0;
        for (let x = 0; x < w; x++) {
            for (const e = Math.min(w - 1, x + r); next <= e; next++) {
                const v = src[row + next];
                while (tail > head && src[row + idx[tail - 1]] <= v) tail--;
                idx[tail++] = next;
            }
            while (idx[head] < x - r) head++;
            const v = src[row + idx[head]];
            dst[row + x] = v > 0 ? v : 0;
        }
    }
}

/** `src` (w x h) turned on its diagonal into `dst` (h x w), in blocks so both sides stay in the cache. */
function transpose(src, dst, w, h) {
    const B = 64;
    for (let by = 0; by < h; by += B) for (let bx = 0; bx < w; bx += B) {
        const ye = Math.min(h, by + B), xe = Math.min(w, bx + B);
        for (let y = by; y < ye; y++) for (let x = bx; x < xe; x++) dst[x * h + y] = src[y * w + x];
    }
}

/** Square dilation of a w x h float mask by r pixels (a max filter: the rows, then the columns as the rows of the
 *  transposed mask); a new Float32Array. */
export function dilateMask(data, w, h, r) {
    const a = new Float32Array(w * h), b = new Float32Array(w * h), idx = new Int32Array(Math.max(w, h));
    maxRows(data, a, w, h, r, idx);
    transpose(a, b, w, h);
    maxRows(b, a, h, w, r, idx);
    transpose(a, b, h, w);
    return b;
}

/** Square erosion of a w x h float mask by r pixels (`1 - dilate(1 - m, r)` in f32); a new Float32Array. */
export function erodeMask(data, w, h, r) {
    if (r <= 0 || w <= 0 || h <= 0) return Float32Array.from(data);
    const inv = maskOneMinus(data);
    const d = dilateMask(inv, w, h, r);
    return maskOneMinus(d, d);
}

/** One box blur pass of radius r along rows (clamped edges). */
function boxRow(src, dst, w, h, r) {
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
        const n = 2 * r + 1;
        for (let x = 0; x < w; x++) {
            dst[row + x] = sum / n;
            const add = Math.min(w - 1, x + r + 1), sub = Math.max(0, x - r);
            sum += src[row + add] - src[row + sub];
        }
    }
}

/** The same along columns: one running sum per column, walked row by row (the same sums in the same order as a walk
 *  down each column, which read the mask with a stride of w). */
function boxCol(src, dst, w, h, r) {
    const sums = new Float64Array(w), n = 2 * r + 1;
    for (let k = -r; k <= r; k++) {
        const row = Math.min(h - 1, Math.max(0, k)) * w;
        for (let x = 0; x < w; x++) sums[x] += src[row + x];
    }
    for (let y = 0; y < h; y++) {
        const row = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
        for (let x = 0; x < w; x++) {
            dst[row + x] = sums[x] / n;
            sums[x] += src[add + x] - src[sub + x];
        }
    }
}

/** A box blur along rows and then along columns for every radius that is not 0; a new Float32Array. */
export function boxBlurs(data, w, h, radii) {
    const a = Float32Array.from(data), b = new Float32Array(w * h);
    for (const r of radii) {
        if (r <= 0) continue;
        boxRow(a, b, w, h, r);
        boxCol(b, a, w, h, r);
    }
    return a;
}

// ---- PNG rows read (inpaint_png.js `readPng`) -----------------------------------------------------------------------

/**
 * Undo the row filters of `rows` PNG lines: `lines` holds them one after the other, a filter-type byte and `rowBytes`
 * filtered bytes each; `bpp` is the bytes of a whole pixel; `prev` the unfiltered row above the first line (zeros at the
 * top) and the last row afterwards. In place; or with `rgba` = `{ w, channels, out }` for an 8-bit RGB (3) or RGBA (4)
 * picture, also written to `out` as RGBA8. Returns the lines undone: fewer than `rows` at an unknown filter type.
 */
export function pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba = null) {
    const stride = rowBytes + 1;
    let up = prev;
    for (let y = 0; y < rows; y++) {
        const ft = lines[y * stride], cur = lines.subarray(y * stride + 1, (y + 1) * stride);
        if (ft === 1) { for (let i = bpp; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; }
        else if (ft === 2) { for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + up[i]) & 255; }
        else if (ft === 3) { for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + up[i]) >> 1)) & 255; }
        else if (ft === 4) {
            for (let i = 0; i < rowBytes; i++) {
                const a = i >= bpp ? cur[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
                let pa = b - c; if (pa < 0) pa = -pa;
                let pb = a - c; if (pb < 0) pb = -pb;
                let pc = a + b - 2 * c; if (pc < 0) pc = -pc;
                cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            }
        } else if (ft !== 0) return y;
        up = cur;
    }
    if (rows > 0) prev.set(lines.subarray((rows - 1) * stride + 1, rows * stride));
    if (rgba) {
        const { w, channels, out } = rgba;
        for (let y = 0; y < rows; y++) {
            const src = lines.subarray(y * stride + 1, (y + 1) * stride);
            if (channels === 4) out.set(src, y * w * 4);
            else for (let x = 0, i = 0, o = y * w * 4; x < w; x++, i += 3, o += 4) { out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = 255; }
        }
    }
    return rows;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();

/** CRC-32 of `bytes`, continued from `start` (0 for a new checksum). */
export function crc32(bytes, start = 0) {
    bytes = bytesOf(bytes);
    let c = (start ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Frame `dataLen` bytes already at `buf[8..8 + dataLen]` as a PNG chunk of 4-byte `kind` (big-endian u32, e.g.
 * `0x49444154` for `"IDAT"`): length and type in `buf[0..8]`, the CRC-32 over `buf[4..8 + dataLen]` in
 * `buf[8 + dataLen..12 + dataLen]`. Returns that CRC-32.
 */
export function pngChunkFrame(buf, dataLen = buf.byteLength - 12, kind = 0x49444154) {
    buf = bytesOf(buf);
    const dv = new DataView(buf.buffer, buf.byteOffset, dataLen + 12);
    dv.setUint32(0, dataLen >>> 0);
    dv.setUint32(4, kind >>> 0);
    const crc = crc32(buf.subarray(4, 8 + dataLen), 0);
    dv.setUint32(8 + dataLen, crc);
    return crc;
}

const ADLER_MOD = 65521;
const PNG_PART_BYTES = 8 * 1048576;
const PNG_PART_MAX_ROWS = 2048; // programRows / bandPlan.rows / bandSource (inpaint_canvas.js) -> forParts (inpaint_bands.js)
export const PART_NOT_LINES = -4, PART_BAD_FILTER = -5;

/** Adler-32 of `bytes`, continued from `start` (1 for a new checksum). */
export function adler32(bytes, start = 1) {
    bytes = bytesOf(bytes);
    let a = start & 0xFFFF, b = (start >>> 16) & 0xFFFF;
    for (let i = 0; i < bytes.length; ) {
        const end = Math.min(bytes.length, i + 5552);
        for (; i < end; i++) {
            a += bytes[i];
            b += a;
        }
        a %= ADLER_MOD;
        b %= ADLER_MOD;
    }
    return ((b << 16) | a) >>> 0;
}

/**
 * Byte capacity of `lines` for a standard `PART_BYTES` (`8 MB`) part of a `w`-wide 8-bit RGBA PNG
 * (`partRows(w, 2048) * (1 + 4 * w)`), or 0 when `w <= 0` (K7, docs/PLAN_WASM_BUILD.md §4.2).
 */
export function pngPartLinesCap(w) {
    if (!Number.isInteger(w) || w <= 0 || w > 0x3fffffff) return 0;
    const rowBytes = w * 4;
    const rows = Math.max(1, Math.min(PNG_PART_MAX_ROWS, Math.floor(PNG_PART_BYTES / rowBytes)));
    return rows * (rowBytes + 1);
}

function unfilterPartInto(lines, rows, w, up0, rt, out) {
    const rowBytes = w * 4, stride = rowBytes + 1;
    let up = up0;
    for (let y = 0; y < rows; y++) {
        const ft = lines[y * stride];
        const src = lines.subarray(y * stride + 1, (y + 1) * stride);
        const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
        if (ft === 0) {
            cur.set(src);
        } else if (ft === 1) {
            cur[0] = src[0]; cur[1] = src[1]; cur[2] = src[2]; cur[3] = src[3];
            for (let i = 4; i < rowBytes; i++) cur[i] = (src[i] + cur[i - 4]) & 255;
        } else if (ft === 2) {
            for (let i = 0; i < rowBytes; i++) cur[i] = (src[i] + up[i]) & 255;
        } else if (ft === 3) {
            for (let i = 0; i < 4; i++) cur[i] = (src[i] + (up[i] >> 1)) & 255;
            for (let i = 4; i < rowBytes; i++) cur[i] = (src[i] + ((cur[i - 4] + up[i]) >> 1)) & 255;
        } else {
            for (let i = 0; i < 4; i++) cur[i] = (src[i] + up[i]) & 255;
            for (let i = 4; i < rowBytes; i++) {
                const a = cur[i - 4], b = up[i], c = up[i - 4];
                let pa = b - c; if (pa < 0) pa = -pa;
                let pb = a - c; if (pb < 0) pb = -pb;
                let pc = a + b - 2 * c; if (pc < 0) pc = -pc;
                cur[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            }
        }
        up = cur;
    }
    const lastRow = out.subarray((rows - 1) * rowBytes, rows * rowBytes);
    const savedLast = up0 ? (up0.set(lastRow), up0) : lastRow.slice();
    const n = rows * rowBytes;
    let opaque = true;
    if (rt) {
        const t = bytesOf(rt);
        for (let i = 0; i < n; i += 4) {
            const a = out[i + 3];
            if (a < 255) {
                opaque = false;
                const row = a << 8;
                out[i] = t[row | out[i]];
                out[i + 1] = t[row | out[i + 1]];
                out[i + 2] = t[row | out[i + 2]];
            }
        }
    } else {
        for (let i = 3; i < n; i += 4) {
            if (out[i] < 255) { opaque = false; break; }
        }
    }
    return { opaque, lastRow: savedLast };
}

/**
 * Decode one inflated part (`lines`, a whole number of `1 + 4 * w`-byte scanlines) of a `w`-wide 8-bit RGBA PNG (K7,
 * docs/PLAN_WASM_BUILD.md §4.2). Returns `{ code }` (`-4` not whole lines, `-5` bad filter byte), or
 * `{ code: rows, rows, adler, firstFilter, opaque, needsPrev, out, prev }`. When `prev` is null and `firstFilter` is
 * 2, 3, or 4, `lines` is left untouched and `needsPrev` is `true` (`out` and `prev` null); otherwise `out` receives
 * the `rows * w * 4` RGBA8 bytes (round-tripped through `rt` when given), and `prev` (updated in place when given, or
 * a new `4 * w`-byte `Uint8Array`) holds the last unfiltered row before `rt`.
 */
export function pngPartDecode(lines, w, prev = null, rt = null, out = null) {
    if (!lines || !Number.isInteger(w) || w <= 0 || w > 0x3fffffff) return { code: PART_NOT_LINES };
    const l = bytesOf(lines);
    const rowBytes = w * 4, stride = rowBytes + 1;
    if (l.length === 0 || l.length % stride !== 0) return { code: PART_NOT_LINES };
    if (prev != null && bytesOf(prev).length < rowBytes) return { code: PART_NOT_LINES };
    if (rt != null && bytesOf(rt).length < 65536) return { code: PART_NOT_LINES };
    const rows = l.length / stride;
    if (out != null && bytesOf(out).length < rows * rowBytes) return { code: PART_NOT_LINES };
    for (let y = 0; y < rows; y++) {
        if (l[y * stride] > 4) return { code: PART_BAD_FILTER };
    }
    const firstFilter = l[0];
    const adler = adler32(l, 1);
    if (prev == null && firstFilter >= 2) {
        return { code: rows, rows, adler, firstFilter, opaque: false, needsPrev: true, out: null, prev: null };
    }
    const dst = out || new Uint8Array(rows * rowBytes);
    const dstBytes = bytesOf(dst).subarray(0, rows * rowBytes);
    const up0 = prev != null ? bytesOf(prev).subarray(0, rowBytes) : null;
    const { opaque, lastRow } = unfilterPartInto(l, rows, w, up0, rt, dstBytes);
    return { code: rows, rows, adler, firstFilter, opaque, needsPrev: false, out: dst, prev: prev != null ? prev : lastRow };
}

/**
 * Finish a part whose `pngPartDecode` answered `needsPrev: true` once `prev` (`4 * w` unfiltered bytes from the row
 * above) is ready (K7, docs/PLAN_WASM_BUILD.md §4.2). Updates `prev` to the last unfiltered row of this part (before
 * `rt`), writes `rows * w * 4` RGBA8 bytes to `out` (applying `rt` when given), and returns
 * `{ code: rows, rows, firstFilter, opaque, needsPrev: false, out, prev }`, or `{ code }` (`< 0`).
 */
export function pngPartFinish(lines, rows, w, prev, rt = null, out = null) {
    if (!lines || !prev || !Number.isInteger(w) || w <= 0 || w > 0x3fffffff || !Number.isInteger(rows) || rows <= 0) {
        return { code: PART_NOT_LINES };
    }
    const l = bytesOf(lines), p = bytesOf(prev);
    const rowBytes = w * 4, stride = rowBytes + 1;
    if (l.length !== rows * stride || p.length < rowBytes) return { code: PART_NOT_LINES };
    if (rt != null && bytesOf(rt).length < 65536) return { code: PART_NOT_LINES };
    if (out != null && bytesOf(out).length < rows * rowBytes) return { code: PART_NOT_LINES };
    for (let y = 0; y < rows; y++) {
        if (l[y * stride] > 4) return { code: PART_BAD_FILTER };
    }
    const firstFilter = l[0];
    const dst = out || new Uint8Array(rows * rowBytes);
    const dstBytes = bytesOf(dst).subarray(0, rows * rowBytes);
    const { opaque } = unfilterPartInto(l, rows, w, p.subarray(0, rowBytes), rt, dstBytes);
    return { code: rows, rows, firstFilter, opaque, needsPrev: false, out: dst, prev };
}

// ---- the smudge's dab (PLAN_0_1_31 §4 step 3) ---------------------------------------------------

export const SMUDGE_ALPHA_LOCK = 1, SMUDGE_PICKUP = 2;

/**
 * One smudge dab over `mask.length` pixels (crates/px/src/smudge.rs has the formulas): `dst` the layer's straight RGBA8
 * under the dab box, written where the dab covers; `src` what the brush samples there (straight RGBA8; the layer's own
 * bytes, a copy, or the picture); `carry` a Uint16Array of 4 per pixel, premultiplied, which the brush holds from dab to
 * dab; `strength` and `keep` 0..65536; `flags` SMUDGE_ALPHA_LOCK, SMUDGE_PICKUP (the first dab: the carry takes `src`,
 * nothing is laid down). Integer arithmetic only, each division floored, so the Rust kernel gives the same bytes.
 * Returns `dst`.
 */
export function smudgeDab(dst, src, carry, mask, strength, keep, flags = 0) {
    const d = bytesOf(dst), s = bytesOf(src);
    const n = Math.min(mask.length, d.length >> 2, s.length >> 2, carry.length >> 2);
    const st = Math.min(65536, strength >>> 0), kp = Math.min(65536, keep >>> 0), lock = (flags & SMUDGE_ALPHA_LOCK) !== 0;
    const lerp = (x, w) => Math.floor((x * w + 32768) / 65536);
    const pre = (c, a) => Math.floor((c * a * 257 + 127) / 255);
    const sp = [0, 0, 0, 0], cp = [0, 0, 0, 0], tp = [0, 0, 0, 0], nt = [0, 0, 0, 0], px = [0, 0, 0, 0];
    const straight = (q, out, o) => {
        const a = q[3], a8 = Math.floor((a + 128) / 257);
        if (a8 <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; return; }
        for (let c = 0; c < 3; c++) { const v = Math.floor((q[c] * 255 + Math.floor(a / 2)) / a); out[o + c] = v > 255 ? 255 : v; }
        out[o + 3] = a8;
    };
    for (let k = 0; k < n; k++) {
        const o = k * 4, sa = s[o + 3];
        sp[0] = pre(s[o], sa); sp[1] = pre(s[o + 1], sa); sp[2] = pre(s[o + 2], sa); sp[3] = sa * 257;
        if (flags & SMUDGE_PICKUP) { for (let c = 0; c < 4; c++) carry[o + c] = sp[c]; continue; }
        const a = Math.floor((st * mask[k] + 127) / 255);
        for (let c = 0; c < 4; c++) cp[c] = carry[o + c];
        if (a > 0) {
            const ta = d[o + 3];
            tp[0] = pre(d[o], ta); tp[1] = pre(d[o + 1], ta); tp[2] = pre(d[o + 2], ta); tp[3] = ta * 257;
            for (let c = 0; c < 4; c++) nt[c] = tp[c] + lerp(cp[c] - tp[c], a);
            if (!lock) straight(nt, d, o);
            else if (ta > 0) {
                // the colour of what was laid down, at the alpha the layer had
                straight(nt, px, 0);
                if (px[3] > 0) { d[o] = px[0]; d[o + 1] = px[1]; d[o + 2] = px[2]; }
            }
        }
        for (let c = 0; c < 4; c++) {
            const p = sp[c] + lerp(cp[c] - sp[c], a);
            carry[o + c] = p + lerp(cp[c] - p, kp);
        }
    }
    return dst;
}

// ---- the healing brush's Poisson blend (PLAN_0_1_31 §5 step 1) -------------------------------------

export const POISSON_TOL = 1 / 32, POISSON_MAX_CYCLES = 30, POISSON_MIN_ALPHA = 8;
// P_FREE: an unknown whose 4-connected region touches no FIXED cell keeps the start and stays out of the solve
const P_NONE = 0, P_FIXED = 1, P_UNKNOWN = 2, P_FREE = 3, P_PRE = 2, P_POST = 2, P_COARSEST = 40, P_MAX_LEVELS = 24, P_ALPHA_MAX = 4;
const P_INV = [0, 1, 0.5, 1 / 3, 0.25];

/** One grid of the solver: `w` x `h` cells inside a ring of NONE padding (crates/px/src/poisson.rs `Level`). */
function poissonLevel(w, h, coarse) {
    const stride = w + 2, cells = stride * (h + 2);
    return { w, h, stride, cells, state: new Uint8Array(cells), nb: new Uint8Array(cells), u: new Float32Array(cells * 3), f: coarse ? new Float32Array(cells * 3) : null, cc: null, spans: null, rows: null };
}

function poissonFinish(lv) {
    const { w, h, stride: s, state, nb } = lv, spans = [], rows = [0];
    for (let y = 0; y < h; y++) {
        const row = (y + 1) * s + 1;
        let x = 0;
        while (x < w) {
            if (state[row + x] !== P_UNKNOWN) { x++; continue; }
            const x0 = x;
            while (x < w && state[row + x] === P_UNKNOWN) {
                const i = row + x;
                nb[i] = (state[i - 1] !== P_NONE) + (state[i + 1] !== P_NONE) + (state[i - s] !== P_NONE) + (state[i + s] !== P_NONE);
                x++;
            }
            spans.push(x0, x);
        }
        rows.push(spans.length >> 1);
    }
    lv.spans = Uint32Array.from(spans);
    lv.rows = Uint32Array.from(rows);
}

/** The next coarser grid; its values are the mean of the children of the cell's own kind (the boundary for the start). */
function poissonCoarser(lv) {
    const w1 = (lv.w + 1) >> 1, h1 = (lv.h + 1) >> 1, c = poissonLevel(w1, h1, true), acc = [0, 0, 0];
    for (let y1 = 0; y1 < h1; y1++) {
        for (let x1 = 0; x1 < w1; x1++) {
            let st = P_NONE;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const x = 2 * x1 + dx, y = 2 * y1 + dy;
                    if (x < lv.w && y < lv.h) { const v = lv.state[(y + 1) * lv.stride + x + 1]; if (v === P_FIXED || (v === P_UNKNOWN && st === P_NONE)) st = v; }
                }
            }
            const j = (y1 + 1) * c.stride + x1 + 1;
            c.state[j] = st;
            if (st === P_NONE) continue;
            acc[0] = 0; acc[1] = 0; acc[2] = 0;
            let n = 0;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const x = 2 * x1 + dx, y = 2 * y1 + dy;
                    if (x >= lv.w || y >= lv.h) continue;
                    const i = (y + 1) * lv.stride + x + 1;
                    if (lv.state[i] !== st) continue;
                    for (let ch = 0; ch < 3; ch++) acc[ch] += lv.u[3 * i + ch];
                    n++;
                }
            }
            for (let ch = 0; ch < 3; ch++) c.u[3 * j + ch] = acc[ch] / n;
        }
    }
    poissonFinish(c);
    return c;
}

function poissonSweep(lv, color, track) {
    const { h, stride: s, nb, u, f, spans, rows } = lv;
    let mx = 0;
    for (let y = 0; y < h; y++) {
        const row = (y + 1) * s + 1;
        for (let k = rows[y], ke = rows[y + 1]; k < ke; k++) {
            const x1 = spans[2 * k + 1];
            let x = spans[2 * k];
            x += (x + y + color) & 1;
            for (; x < x1; x += 2) {
                const i = row + x, n = P_INV[nb[i]];
                for (let c = 0; c < 3; c++) {
                    const sum = u[3 * (i - 1) + c] + u[3 * (i + 1) + c] + u[3 * (i - s) + c] + u[3 * (i + s) + c];
                    const fv = f ? f[3 * i + c] : 0;
                    const v = (fv + sum) * n;
                    if (track) { const dv = Math.abs(v - u[3 * i + c]); if (dv > mx) mx = dv; }
                    u[3 * i + c] = v;
                }
            }
        }
    }
    return mx;
}

function poissonRestrict(fine, c) {
    const s = fine.stride, fu = fine.u, ff = fine.f, acc = [0, 0, 0];
    for (let y1 = 0; y1 < c.h; y1++) {
        for (let k = c.rows[y1], ke = c.rows[y1 + 1]; k < ke; k++) {
            for (let x1 = c.spans[2 * k], xe = c.spans[2 * k + 1]; x1 < xe; x1++) {
                acc[0] = 0; acc[1] = 0; acc[2] = 0;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const x = 2 * x1 + dx, y = 2 * y1 + dy;
                        if (x >= fine.w || y >= fine.h) continue;
                        const i = (y + 1) * s + x + 1;
                        if (fine.state[i] !== P_UNKNOWN) continue;
                        const n = fine.nb[i];
                        for (let ch = 0; ch < 3; ch++) {
                            const sum = fu[3 * (i - 1) + ch] + fu[3 * (i + 1) + ch] + fu[3 * (i - s) + ch] + fu[3 * (i + s) + ch];
                            const fv = ff ? ff[3 * i + ch] : 0;
                            acc[ch] += (fv + sum) - n * fu[3 * i + ch];
                        }
                    }
                }
                const j = (y1 + 1) * c.stride + x1 + 1;
                for (let ch = 0; ch < 3; ch++) { c.f[3 * j + ch] = acc[ch]; c.u[3 * j + ch] = 0; }
            }
        }
    }
}

/** The coarse grid bilinearly at the fine grid's unknowns into `into` (f32, 3 a cell); a NONE neighbour mirrors the parent. */
function poissonInterp(c, fine, into) {
    const cs = c.stride, cu = c.u, cst = c.state;
    for (let y = 0; y < fine.h; y++) {
        const row = (y + 1) * fine.stride + 1, py = (y >> 1) + 1, vy = y & 1 ? py + 1 : py - 1;
        for (let k = fine.rows[y], ke = fine.rows[y + 1]; k < ke; k++) {
            for (let x = fine.spans[2 * k], xe = fine.spans[2 * k + 1]; x < xe; x++) {
                const px = (x >> 1) + 1, hx = x & 1 ? px + 1 : px - 1;
                const p = py * cs + px, hh = py * cs + hx, vv = vy * cs + px, dd = vy * cs + hx, i = row + x;
                for (let ch = 0; ch < 3; ch++) {
                    const ep = cu[3 * p + ch];
                    const eh = cst[hh] === P_NONE ? ep : cu[3 * hh + ch];
                    const ev = cst[vv] === P_NONE ? ep : cu[3 * vv + ch];
                    const ed = cst[dd] === P_NONE ? ep : cu[3 * dd + ch];
                    into[3 * i + ch] = (9 * ep + 3 * eh + 3 * ev + ed) * 0.0625;
                }
            }
        }
    }
}

/**
 * The coarse correction added to the fine grid, scaled per channel by the step that minimises the error's energy
 * along it (alpha = r.c / c.Ac, within 0..P_ALPHA_MAX): a coarse grid whose boundary moved inward corrects too little,
 * by up to 2.6 times on the coarse grids of a thin diagonal stroke. The fine grid's `cc` holds the interpolated
 * correction (0 outside the unknowns, which is all it ever writes).
 */
function poissonCorrect(c, fine, track) {
    const s = fine.stride, fu = fine.u, ff = fine.f, cc = fine.cc;
    poissonInterp(c, fine, cc);
    const rc = [0, 0, 0], cac = [0, 0, 0];
    for (let y = 0; y < fine.h; y++) {
        const row = (y + 1) * s + 1;
        for (let k = fine.rows[y], ke = fine.rows[y + 1]; k < ke; k++) {
            for (let x = fine.spans[2 * k], xe = fine.spans[2 * k + 1]; x < xe; x++) {
                const i = row + x, n = fine.nb[i];
                for (let ch = 0; ch < 3; ch++) {
                    const sum = fu[3 * (i - 1) + ch] + fu[3 * (i + 1) + ch] + fu[3 * (i - s) + ch] + fu[3 * (i + s) + ch];
                    const fv = ff ? ff[3 * i + ch] : 0;
                    const r = (fv + sum) - n * fu[3 * i + ch];
                    const ci = cc[3 * i + ch];
                    const ac = n * ci - (cc[3 * (i - 1) + ch] + cc[3 * (i + 1) + ch] + cc[3 * (i - s) + ch] + cc[3 * (i + s) + ch]);
                    rc[ch] += r * ci;
                    cac[ch] += ci * ac;
                }
            }
        }
    }
    const al = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
        if (cac[ch] > 0) { const a = rc[ch] / cac[ch]; al[ch] = a <= 0 ? 0 : a >= P_ALPHA_MAX ? P_ALPHA_MAX : a; }
    }
    let mx = 0;
    for (let y = 0; y < fine.h; y++) {
        const row = (y + 1) * s + 1;
        for (let k = fine.rows[y], ke = fine.rows[y + 1]; k < ke; k++) {
            for (let x = fine.spans[2 * k], xe = fine.spans[2 * k + 1]; x < xe; x++) {
                const i = row + x;
                for (let ch = 0; ch < 3; ch++) {
                    const e = al[ch] * cc[3 * i + ch];
                    if (track) { const dv = Math.abs(e); if (dv > mx) mx = dv; }
                    fu[3 * i + ch] = fu[3 * i + ch] + e;
                }
            }
        }
    }
    return mx;
}

/** Marks P_FREE every 4-connected region of unknowns with no FIXED neighbour (poisson.rs `free_regions`). */
function poissonFreeRegions(lv) {
    const s = lv.stride, state = lv.state, seen = new Uint8Array(lv.cells), stack = [], region = [];
    for (let y = 0; y < lv.h; y++) {
        for (let x = 0; x < lv.w; x++) {
            const i0 = (y + 1) * s + x + 1;
            if (state[i0] !== P_UNKNOWN || seen[i0]) continue;
            let anchored = false;
            region.length = 0;
            stack.push(i0);
            seen[i0] = 1;
            while (stack.length) {
                const i = stack.pop();
                region.push(i);
                for (const j of [i - 1, i + 1, i - s, i + s]) {
                    const v = state[j];
                    if (v === P_FIXED) anchored = true;
                    else if (v === P_UNKNOWN && !seen[j]) { seen[j] = 1; stack.push(j); }
                }
            }
            if (!anchored) for (const i of region) state[i] = P_FREE;
        }
    }
}

/** One V-cycle with `levels[top]` as its finest grid; the largest update at level 0. */
function poissonVcycle(levels, top) {
    const n = levels.length;
    let mx = 0;
    for (let l = top; l < n - 1; l++) {
        for (let r = 0; r < P_PRE; r++) for (let color = 0; color < 2; color++) { const m = poissonSweep(levels[l], color, l === 0); if (m > mx) mx = m; }
        poissonRestrict(levels[l], levels[l + 1]);
    }
    for (let r = 0; r < P_COARSEST; r++) for (let color = 0; color < 2; color++) { const m = poissonSweep(levels[n - 1], color, n === 1); if (m > mx) mx = m; }
    for (let l = n - 2; l >= top; l--) {
        const m = poissonCorrect(levels[l + 1], levels[l], l === 0);
        if (m > mx) mx = m;
        for (let r = 0; r < P_POST; r++) for (let color = 0; color < 2; color++) { const m2 = poissonSweep(levels[l], color, l === 0); if (m2 > mx) mx = m2; }
    }
    return mx;
}

/**
 * The healing brush's gradient-domain blend over a `w` x `h` box (crates/px/src/poisson.rs has the method): `dst` the
 * picture before the stroke, `src` the patch the brush clones (straight RGBA8), `mask` a byte per pixel (> 0: heal
 * there). Per RGB channel the correction `u` is harmonic where the mask covers and `dst - src` on the pixels around it
 * where both are at least POISSON_MIN_ALPHA in alpha; the box edge and clearer pixels hold nothing (Neumann). `out` gets
 * floor(src + u + 0.5) with src's alpha where the mask covers (0 0 0 0 where src is transparent) and dst's bytes
 * elsewhere; `info` (4 ints, optional) the pixels healed, the V-cycles, the levels, and 1 when the cycles ran out
 * before it settled (the caller keeps what it had). Doubles over f32 storage in the order of the Rust kernel, so both
 * give the same bytes. Returns `out`.
 */
export function poissonBlend(dst, src, mask, w, h, out = new Uint8Array(w * h * 4), info = null) {
    const d = bytesOf(dst), sr = bytesOf(src), o8 = bytesOf(out);
    if (info) info.fill(0);
    if (!w || !h) return out;
    const top = poissonLevel(w, h, false), { stride: s, state, u } = top;
    let unknowns = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const k = y * w + x, i = (y + 1) * s + x + 1;
            if (mask[k] > 0) { state[i] = P_UNKNOWN; unknowns++; }
            else if (d[4 * k + 3] >= POISSON_MIN_ALPHA && sr[4 * k + 3] >= POISSON_MIN_ALPHA) {
                state[i] = P_FIXED;
                for (let c = 0; c < 3; c++) u[3 * i + c] = d[4 * k + c] - sr[4 * k + c];
            }
        }
    }
    if (!unknowns) { o8.set(d.subarray(0, w * h * 4)); return out; }
    poissonFreeRegions(top);
    poissonFinish(top);
    const acc = [0, 0, 0];
    let count = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y + 1) * s + x + 1;
            if (state[i] === P_FIXED && (state[i - 1] === P_UNKNOWN || state[i + 1] === P_UNKNOWN || state[i - s] === P_UNKNOWN || state[i + s] === P_UNKNOWN)) {
                for (let c = 0; c < 3; c++) acc[c] += u[3 * i + c];
                count++;
            }
        }
    }
    if (count > 0) {
        const start = new Float32Array(3);
        for (let c = 0; c < 3; c++) start[c] = acc[c] / count;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y + 1) * s + x + 1; if (state[i] === P_UNKNOWN || state[i] === P_FREE) u.set(start, 3 * i); }
    }
    const solve = top.spans.length > 0;
    const levels = [top];
    while (levels.length < P_MAX_LEVELS) {
        const last = levels[levels.length - 1];
        if (last.w <= 3 && last.h <= 3) break;
        const next = poissonCoarser(last);
        if (!next.spans.length) break;
        levels.push(next);
    }
    const n = levels.length;
    for (let l = 0; l < n - 1; l++) levels[l].cc = new Float32Array(levels[l].cells * 3);
    // the start (full multigrid): each coarse grid holds the problem itself, the mean of its children's boundary;
    // the coarsest is solved, each finer one starts from the one below and gets a V-cycle, whose coarse grids then
    // hold corrections (a fixed cell's correction is 0)
    let cycles = 0, last = solve ? Infinity : 0;
    if (solve && n > 1) {
        for (let r = 0; r < P_COARSEST; r++) for (let color = 0; color < 2; color++) poissonSweep(levels[n - 1], color, false);
        for (let l = n - 2; l >= 0; l--) {
            poissonInterp(levels[l + 1], levels[l], levels[l].u);
            levels[l + 1].u.fill(0);
            const m = poissonVcycle(levels, l);
            if (l === 0) { cycles = 1; last = m; }
        }
    }
    while (cycles < POISSON_MAX_CYCLES && !(last < POISSON_TOL)) { cycles++; last = poissonVcycle(levels, 0); }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const k = y * w + x, o = 4 * k, i = (y + 1) * s + x + 1;
            if (state[i] !== P_UNKNOWN && state[i] !== P_FREE) { o8[o] = d[o]; o8[o + 1] = d[o + 1]; o8[o + 2] = d[o + 2]; o8[o + 3] = d[o + 3]; continue; }
            const a = sr[o + 3];
            if (!a) { o8[o] = 0; o8[o + 1] = 0; o8[o + 2] = 0; o8[o + 3] = 0; continue; }
            for (let c = 0; c < 3; c++) {
                const v = Math.floor(sr[o + c] + u[3 * i + c] + 0.5);
                o8[o + c] = v <= 0 ? 0 : v >= 255 ? 255 : v;
            }
            o8[o + 3] = a;
        }
    }
    if (info) { info[0] = unknowns; info[1] = cycles; info[2] = levels.length; info[3] = last < POISSON_TOL ? 0 : 1; }
    return out;
}

/**
 * Computes max - min over each texel's 4x4 block of a w x h Uint16Array (separable).
 * @param {Uint16Array} src
 * @param {number} w
 * @param {number} h
 * @param {Uint16Array} [out]
 * @returns {Uint16Array}
 */
export function rangeMax(src, w, h, out = null) {
    const res = out || new Uint16Array(w * h);
    if (!src || w <= 0 || h <= 0) return res;

    const rowMax = new Uint16Array(w * h);
    const rowMin = new Uint16Array(w * h);

    // Pass 1: horizontal 4-tap [-1, 0, 1, 2]
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let mx = 0, mn = 65535;
            for (let i = -1; i <= 2; i++) {
                const cx = Math.max(0, Math.min(w - 1, x + i));
                const v = src[row + cx];
                if (v > mx) mx = v;
                if (v < mn) mn = v;
            }
            rowMax[row + x] = mx;
            rowMin[row + x] = mn;
        }
    }

    // Pass 2: vertical 4-tap over Pass 1 results
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let mx = 0, mn = 65535;
            for (let j = -1; j <= 2; j++) {
                const cy = Math.max(0, Math.min(h - 1, y + j));
                const cRow = cy * w;
                const vMax = rowMax[cRow + x];
                const vMin = rowMin[cRow + x];
                if (vMax > mx) mx = vMax;
                if (vMin < mn) mn = vMin;
            }
            res[row + x] = mx - mn;
        }
    }
    return res;
}

// ---- Relight kernels (PLAN_RELIGHT_BUILD.md sec 4.3 / 5.2) ------------------------------------------

/**
 * Computes surface normals from u16 height field: n = normalize(-dz/dx, -dz/dy, 1.0)
 * after optional Gaussian blur with sigma. Packed as RGBA8 (n * 127.5 + 127.5, A=255).
 *
 * @param {Uint16Array} depth - u16 depth map (w * h)
 * @param {number} w - map width
 * @param {number} h - map height
 * @param {number} scale - scale factor mapping u16 depth to z height
 * @param {number} sigma - Gaussian smoothing standard deviation
 * @param {Uint8Array} [out] - output buffer (w * h * 4)
 * @returns {Uint8Array} packed RGBA8 normals
 */
export function heightNormals(depth, w, h, scale, sigma, out = null) {
    const dst = out || new Uint8Array(w * h * 4);
    let heights = new Float32Array(w * h);
    const inv65535 = scale / 65535.0;

    for (let i = 0; i < w * h; i++) {
        heights[i] = (65535.0 - depth[i]) * inv65535;
    }

    if (sigma > 0) {
        const radii = gaussRadii(sigma);
        heights = boxBlurs(heights, w, h, radii);
    }

    for (let y = 0; y < h; y++) {
        const rowOffset = y * w;
        const yTop = Math.max(0, y - 1);
        const yBottom = Math.min(h - 1, y + 1);
        const rowTop = yTop * w;
        const rowBottom = yBottom * w;
        const dyStep = yBottom > yTop ? (yBottom - yTop) : 1;

        for (let x = 0; x < w; x++) {
            const xLeft = Math.max(0, x - 1);
            const xRight = Math.min(w - 1, x + 1);
            const dxStep = xRight > xLeft ? (xRight - xLeft) : 1;

            const dzdx = (heights[rowOffset + xRight] - heights[rowOffset + xLeft]) / dxStep;
            const dzdy = (heights[rowBottom + x] - heights[rowTop + x]) / dyStep;

            const nx = -dzdx;
            const ny = -dzdy;
            const nz = 1.0;
            const len = Math.hypot(nx, ny, nz) || 1.0;

            const outOffset = (rowOffset + x) * 4;
            dst[outOffset + 0] = Math.max(0, Math.min(255, Math.round((nx / len) * 127.5 + 127.5)));
            dst[outOffset + 1] = Math.max(0, Math.min(255, Math.round((ny / len) * 127.5 + 127.5)));
            dst[outOffset + 2] = Math.max(0, Math.min(255, Math.round((nz / len) * 127.5 + 127.5)));
            dst[outOffset + 3] = 255;
        }
    }

    return dst;
}

/**
 * Precomputed Vogel disc points in unit circle.
 * @param {number} n
 * @returns {Array<[number, number]>}
 */
export function relightVogel(n) {
    const N = 16;
    const ga = 2.39996323;
    const taps = [];
    for (let i = 0; i < N; i++) {
        const r = Math.sqrt((i + 0.5) / N);
        const theta = i * ga;
        taps.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
    return taps.slice(0, Math.max(1, Math.min(16, n || 16)));
}

/**
 * Marches shadow rays through the u16 depth height field.
 *
 * @param {Uint16Array} depth - u16 depth map (w * h)
 * @param {number} w - map width
 * @param {number} h - map height
 * @param {number} scale - scale factor mapping u16 depth to z height
 * @param {number[]|Float32Array} light - [lx, ly, lz, kind] where kind: 0=point, 1=sun, 2=spot
 * @param {number} radius - light source radius in map pixels for soft shadows
 * @param {number} taps - number of light sample taps (1..16)
 * @param {number} steps - number of march steps per ray (1..64)
 * @param {number} bias - height bias in z to avoid self-shadowing
 * @param {number} row0 - start row
 * @param {number} rows - number of rows to compute
 * @param {Uint8Array} [out] - output buffer (length >= w * rows)
 * @returns {Uint8Array} visibility map (0=shadow, 255=lit)
 */
export function shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out = null) {
    const bandRows = Math.min(rows, h - row0);
    const dst = out || new Uint8Array(w * bandRows);

    const lx = Number(light[0]) || 0;
    const ly = Number(light[1]) || 0;
    const lz = Number(light[2]) || 0;
    const kind = Number(light[3]) || 0;

    const nTaps = Math.max(1, Math.min(16, Number.isFinite(Number(taps)) ? Math.round(Number(taps)) : 4));
    const nSteps = Math.max(1, Math.min(64, Number.isFinite(Number(steps)) ? Math.round(Number(steps)) : 32));
    const r = Math.max(0, Number(radius) || 0);
    const zBias = Math.max(0, Number.isFinite(Number(bias)) ? Number(bias) : 0);
    const disc = relightVogel(nTaps);
    const longSide = Math.max(w, h);
    const sunDist = longSide * 1.5;
    const inv65535 = scale / 65535.0;
    const invSteps = 1.0 / nSteps;

    const tapX = new Float64Array(nTaps);
    const tapY = new Float64Array(nTaps);
    const tapZ = new Float64Array(nTaps);
    if (kind === 1) {
        const lLen = Math.hypot(lx, ly, lz) || 1.0;
        const normLx = lx / lLen;
        const normLy = ly / lLen;
        const normLz = lz / lLen;
        for (let t = 0; t < nTaps; t++) {
            const jx = disc[t][0] * (r / longSide);
            const jy = disc[t][1] * (r / longSide);
            const dirX = normLx + jx;
            const dirY = normLy + jy;
            const dirZ = normLz;
            const dLen = Math.hypot(dirX, dirY, dirZ) || 1.0;
            tapX[t] = (dirX / dLen) * sunDist;
            tapY[t] = (dirY / dLen) * sunDist;
            tapZ[t] = (dirZ / dLen) * sunDist;
        }
    } else {
        for (let t = 0; t < nTaps; t++) {
            tapX[t] = lx + disc[t][0] * r;
            tapY[t] = ly + disc[t][1] * r;
            tapZ[t] = lz;
        }
    }

    for (let rIdx = 0; rIdx < bandRows; rIdx++) {
        const y = row0 + rIdx;
        const rowOffset = y * w;
        const outRowOffset = (dst.length >= w * h) ? y * w : rIdx * w;

        for (let x = 0; x < w; x++) {
            const z0 = (65535.0 - depth[rowOffset + x]) * inv65535;
            const px = x;
            const py = y;
            const pz = z0 + zBias;
            let litCount = 0;

            for (let t = 0; t < nTaps; t++) {
                let tx, ty, tz;
                if (kind === 1) {
                    tx = px + tapX[t];
                    ty = py + tapY[t];
                    tz = pz + tapZ[t];
                } else {
                    tx = tapX[t];
                    ty = tapY[t];
                    tz = tapZ[t];
                }

                const rdx = tx - px;
                const rdy = ty - py;
                const rdz = tz - pz;
                let blocked = false;

                const stepX = rdx * invSteps;
                const stepY = rdy * invSteps;
                const stepZ = rdz * invSteps;
                let sx = px + stepX;
                let sy = py + stepY;
                let sz = pz + stepZ;

                for (let s = 1; s <= nSteps; s++) {
                    if (rdz >= 0 && sz > scale) {
                        break;
                    }

                    const cx = sx + 0.5;
                    const cy = sy + 0.5;
                    if (cx < 0 || cy < 0) {
                        break;
                    }
                    const ix = cx | 0;
                    const iy = cy | 0;
                    if (ix >= w || iy >= h) {
                        break;
                    }

                    const mapZ = (65535.0 - depth[iy * w + ix]) * inv65535;
                    if (mapZ > sz + zBias) {
                        blocked = true;
                        break;
                    }

                    sx += stepX;
                    sy += stepY;
                    sz += stepZ;
                }

                if (!blocked) litCount++;
            }

            dst[outRowOffset + x] = Math.round((litCount / nTaps) * 255);
        }
    }

    return dst;
}


// ---- the selection's combine (docs/PLAN_WASM_BUILD.md §4.3, K5) -------------------------------------------------------

/** The kinds of an AlphaSource view (inpaint_raster.js): nothing covered, an alpha byte a pixel, all covered, RGBA8. */
export const SEL_NONE = 0, SEL_ALPHA = 1, SEL_FULL = 2, SEL_RGBA = 4;

let SEL_TABLES = null;

/** T[mode][(d << 8) | s]: the combined alpha of inpaint_raster.js `combineAlpha`, one table per mode of SEL_MODES. */
function selTables() {
    if (SEL_TABLES) return SEL_TABLES;
    const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };
    const t = [new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536)];
    for (let d = 0; d < 256; d++) {
        for (let s = 0; s < 256; s++) {
            const i = (d << 8) | s, m = mul255(d, s);
            t[0][i] = s;
            t[1][i] = d + s - m;
            t[2][i] = Math.max(0, d - m);
            t[3][i] = m;
        }
    }
    SEL_TABLES = t;
    return t;
}

/** Arguments selCombine refuses (sel.rs answers REFUSED for the same): a message, or "" when they are in range. */
function selRefused(dst, size, src, off, stride, kind, bw, bh, mode) {
    if (!(mode >= 0 && mode <= 3) || (mode | 0) !== mode) return `mode ${mode}`;
    if (kind !== SEL_NONE && kind !== SEL_ALPHA && kind !== SEL_FULL && kind !== SEL_RGBA) return `source kind ${kind}`;
    if (!(size > 0 && size <= 4096) || !(bw >= 0 && bw <= size) || !(bh >= 0 && bh <= size)) return `${bw} x ${bh} in a tile of ${size}`;
    if (!dst || dst.length < size * size * 4) return "a tile too small";
    if ((kind === SEL_ALPHA || kind === SEL_RGBA) && bw > 0 && bh > 0) {
        const bpp = kind === SEL_RGBA ? 4 : 1;
        if (!(stride >= bw) || !(off >= 0) || !src || src.length < (off + (bh - 1) * stride + bw) * bpp) return "a source too small";
    }
    return "";
}

/**
 * Whether the `bw` x `bh` source region holds any alpha above 0 (`off` and `stride` in pixels, `kind` as selCombine
 * takes it). kernels.js asks it on the twins' route before it makes a missing tile; the Rust route asks the combine
 * itself (sel_combine reports whether the tile holds a pixel), so it has no Rust twin.
 */
export function alphaAny(src, off, stride, kind, bw, bh) {
    if (!(bw > 0 && bh > 0)) return false;
    if (kind === SEL_FULL) return true;
    if (kind !== SEL_ALPHA && kind !== SEL_RGBA) return false;
    const s = bytesOf(src), bpp = kind === SEL_RGBA ? 4 : 1, a = kind === SEL_RGBA ? 3 : 0;
    for (let y = 0; y < bh; y++) {
        for (let p = (off + y * stride) * bpp + a, e = p + bw * bpp; p < e; p += bpp) if (s[p]) return true;
    }
    return false;
}

/**
 * One tile of the selection (`size`² RGBA8, straight alpha, in place) combined with an alpha source under `mode` (0
 * replace, 1 add, 2 subtract, 3 intersect: inpaint_raster.js SEL_MODES), the maths of inpaint_raster.js `combineRows`:
 * a covered pixel (combined alpha above 0) gets the colour `rgb` (0xRRGGBB) and that alpha, the others 0, 0, 0, 0; only
 * the `bw` x `bh` pixels from the tile's corner, the rest of the tile kept. The source region starts at pixel `off` of
 * `src`, `stride` pixels a row: SEL_ALPHA a byte a pixel, SEL_RGBA four (its alpha read), SEL_NONE all 0 and SEL_FULL all
 * 255 (`src` unread). Returns the extent of the whole tile afterwards as inpaint_tiles.js `tileExtent` finds it, [x0,
 * y0, x1, y1] in the tile's pixels, or null when no pixel of the tile has alpha. Throws for arguments out of range. Rust
 * twin: crates/px/src/sel.rs (px.js `selCombine`, which takes a missing tile as `dst` null).
 */
export function selCombine(dst, size, src, off, stride, kind, bw, bh, mode, rgb) {
    const refused = selRefused(dst, size, src, off, stride, kind, bw, bh, mode);
    if (refused) throw new Error("selCombine: " + refused);
    const d8 = bytesOf(dst);
    const T = selTables()[mode];
    // no buffer read when no pixel is combined (bw or bh 0), as sel.rs, which then needs no source
    const s = (kind === SEL_ALPHA || kind === SEL_RGBA) && bw > 0 && bh > 0 ? bytesOf(src) : null;
    const sa = kind === SEL_FULL ? 255 : 0;   // the source alpha without a buffer
    const bpp = kind === SEL_RGBA ? 4 : 1, sOff = kind === SEL_RGBA ? 3 : 0;
    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;
    let x0 = size, y0 = -1, x1 = -1, y1 = -1;
    const words = LITTLE && (d8.byteOffset & 3) === 0;
    const d32 = words ? new Uint32Array(d8.buffer, d8.byteOffset, size * size) : null;
    const RGB = ((b << 16) | (g << 8) | r) >>> 0;
    for (let y = 0; y < size; y++) {
        let first = -1, last = -1, from = 0;
        if (y < bh && bw > 0) {
            from = bw;
            let sp = (off + y * stride) * bpp + sOff;
            if (words) {
                const row = y * size;
                for (let x = 0, o = row; x < bw; x++, o++, sp += bpp) {
                    const a = T[((d32[o] >>> 24) << 8) | (s === null ? sa : s[sp])];
                    if (a) {
                        d32[o] = ((a << 24) | RGB) >>> 0;
                        if (first < 0) first = x;
                        last = x;
                    } else d32[o] = 0;
                }
            } else {
                for (let x = 0, o = y * size * 4; x < bw; x++, o += 4, sp += bpp) {
                    const a = T[(d8[o + 3] << 8) | (s === null ? sa : s[sp])];
                    if (a) {
                        d8[o] = r; d8[o + 1] = g; d8[o + 2] = b; d8[o + 3] = a;
                        if (first < 0) first = x;
                        last = x;
                    } else {
                        d8[o] = 0; d8[o + 1] = 0; d8[o + 2] = 0; d8[o + 3] = 0;
                    }
                }
            }
        }
        // the rest of the row, read for the extent only: its first and its last pixel with alpha
        const at = y * size * 4 + 3;
        let x = from;
        while (x < size && !d8[at + x * 4]) x++;
        if (x < size) {
            if (first < 0) first = x;
            let e = size - 1;
            while (e > x && !d8[at + e * 4]) e--;
            last = e;
        }
        if (first >= 0) {
            if (y0 < 0) y0 = y;
            y1 = y;
            if (first < x0) x0 = first;
            if (last > x1) x1 = last;
        }
    }
    return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

function invertRefused(tile, size, bw, bh) {
    if (!Number.isInteger(size) || size <= 0 || size > 4096) return true;
    if (!Number.isInteger(bw) || !Number.isInteger(bh) || bw < 0 || bh < 0 || bw > size || bh > size) return true;
    return !tile || tile.length < size * size * 4;
}

/**
 * One `size`² tile of the selection (`tile`, RGBA8 in place) inverted in its `bw` x `bh` corner (`rgb` 0xRRGGBB;
 * K11, docs/PLAN_WASM_BUILD.md §4.3). Returns the tile's extent [x0, y0, x1, y1] afterwards, or null when it holds no
 * pixel. Rust twin: crates/px/src/sel.rs `mask_invert` (`px.js` `maskInvert`).
 */
export function maskInvert(tile, size, bw, bh, rgb) {
    if (invertRefused(tile, size, bw, bh)) {
        throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);
    }
    const d8 = bytesOf(tile);
    const r = (rgb >>> 16) & 255, g = (rgb >>> 8) & 255, b = rgb & 255;
    let x0 = size, y0 = -1, x1 = -1, y1 = -1;
    const words = LITTLE && (d8.byteOffset & 3) === 0;
    const d32 = words ? new Uint32Array(d8.buffer, d8.byteOffset, size * size) : null;
    const RGB = ((b << 16) | (g << 8) | r) >>> 0;
    for (let y = 0; y < size; y++) {
        let first = -1, last = -1, from = 0;
        if (y < bh && bw > 0) {
            from = bw;
            if (words) {
                const row = y * size;
                for (let x = 0, o = row; x < bw; x++, o++) {
                    const a = 255 - (d32[o] >>> 24);
                    if (a) {
                        d32[o] = ((a << 24) | RGB) >>> 0;
                        if (first < 0) first = x;
                        last = x;
                    } else d32[o] = 0;
                }
            } else {
                for (let x = 0, o = y * size * 4; x < bw; x++, o += 4) {
                    const a = 255 - d8[o + 3];
                    if (a) {
                        d8[o] = r; d8[o + 1] = g; d8[o + 2] = b; d8[o + 3] = a;
                        if (first < 0) first = x;
                        last = x;
                    } else {
                        d8[o] = 0; d8[o + 1] = 0; d8[o + 2] = 0; d8[o + 3] = 0;
                    }
                }
            }
        }
        const at = y * size * 4 + 3;
        let x = from;
        while (x < size && !d8[at + x * 4]) x++;
        if (x < size) {
            if (first < 0) first = x;
            let e = size - 1;
            while (e > x && !d8[at + e * 4]) e--;
            last = e;
        }
        if (first >= 0) {
            if (y0 < 0) y0 = y;
            y1 = y;
            if (first < x0) x0 = first;
            if (last > x1) x1 = last;
        }
    }
    return y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * Per-tile minimum, maximum, and edge flag over a depth map (`map` and optional `rmax`, `mw` x `mh` u16) for a
 * `W` x `H` document in `tile`² tiles (K21, docs/PLAN_WASM_BUILD.md §4.8). Rust twin: crates/px/src/range.rs
 * (`px.js` `mapTileStats`).
 */
export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {
    if (!map || !(mw > 0) || !(mh > 0) || !(W > 0) || !(H > 0) || !(tile > 0) || !Array.isArray(xf) || xf.length < 6) {
        throw new Error("mapTileStats: bad arguments");
    }
    const [m0, m1, m2, m3, m4, m5] = xf;
    if (!Number.isFinite(m0) || !Number.isFinite(m1) || !Number.isFinite(m2) || !Number.isFinite(m3) || !Number.isFinite(m4) || !Number.isFinite(m5)) {
        throw new Error("mapTileStats: non-finite xf");
    }
    if (map.length < mw * mh) throw new Error("mapTileStats: short map");
    const hasRmax = rmax != null && rmax.length > 0;
    if (hasRmax && rmax.length < mw * mh) throw new Error("mapTileStats: short rmax");
    const thr = hasRmax ? Math.max(0, Math.min(0xffffffff, Math.floor(Number(thresh) || 0))) : 0;

    const cols = Math.ceil(W / tile);
    const rows = Math.ceil(H / tile);
    const min = new Uint16Array(cols * rows);
    const max = new Uint16Array(cols * rows);
    const edge = new Uint8Array(cols * rows);

    for (let ty = 0; ty < rows; ty++) {
        const y0 = ty * tile;
        const y1 = Math.min(H, (ty + 1) * tile);
        const rowOff = ty * cols;
        for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * tile;
            const x1 = Math.min(W, (tx + 1) * tile);

            const x00 = m0 * x0 + m2 * y0 + m4;
            const y00 = m1 * x0 + m3 * y0 + m5;
            const x10 = m0 * x1 + m2 * y0 + m4;
            const y10 = m1 * x1 + m3 * y0 + m5;
            const x01 = m0 * x0 + m2 * y1 + m4;
            const y01 = m1 * x0 + m3 * y1 + m5;
            const x11 = m0 * x1 + m2 * y1 + m4;
            const y11 = m1 * x1 + m3 * y1 + m5;

            const mx0 = Math.min(x00, x10, x01, x11);
            const my0 = Math.min(y00, y10, y01, y11);
            const mx1 = Math.max(x00, x10, x01, x11);
            const my1 = Math.max(y00, y10, y01, y11);

            const rx0 = Math.floor(mx0 - 2);
            const ry0 = Math.floor(my0 - 2);
            const rx1 = Math.ceil(mx1 + 2);
            const ry1 = Math.ceil(my1 + 2);
            const meetsMap = rx0 <= mw - 1 && rx1 >= 0 && ry0 <= mh - 1 && ry1 >= 0;

            const ix0 = Math.max(0, Math.min(mw - 1, rx0));
            const iy0 = Math.max(0, Math.min(mh - 1, ry0));
            const ix1 = Math.max(0, Math.min(mw - 1, rx1));
            const iy1 = Math.max(0, Math.min(mh - 1, ry1));

            let lo = 65535;
            let hi = 0;
            let hasEdge = 0;

            for (let my = iy0; my <= iy1; my++) {
                const row = my * mw;
                for (let mx = ix0; mx <= ix1; mx++) {
                    const idx = row + mx;
                    const v = map[idx];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                    if (meetsMap && !hasEdge && hasRmax && rmax[idx] > thr) {
                        hasEdge = 1;
                    }
                }
            }

            const outIdx = rowOff + tx;
            min[outIdx] = lo;
            max[outIdx] = hi;
            edge[outIdx] = hasEdge;
        }
    }

    return { min, max, edge, cols, rows };
}

function rangeSstep(a, b, x) {
    if (b <= a) return x >= b ? 1 : 0;
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    if (t <= 1e-14) return 0;
    if (t >= 1 - 1e-14) return 1;
    return t * t * (3 - 2 * t);
}

function rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert) {
    const wLo = fLo > 0 ? rangeSstep(lo - fLo, lo, v) : (v >= lo - 1e-12 ? 1 : 0);
    const wHi = fHi > 0 ? (1 - rangeSstep(hi, hi + fHi, v)) : (v <= hi + 1e-12 ? 1 : 0);
    const w = wLo * wHi;
    return limitInvert ? 1 - w : w;
}

function rangeU16Bilinear(data, w, h, px, py) {
    const u = px - 0.5;
    const v = py - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = u - x0;
    const fy = v - y0;
    const cx0 = Math.max(0, Math.min(w - 1, x0));
    const cx1 = Math.max(0, Math.min(w - 1, x1));
    const cy0 = Math.max(0, Math.min(h - 1, y0));
    const cy1 = Math.max(0, Math.min(h - 1, y1));
    const s00 = data[cy0 * w + cx0] / 65535;
    const s10 = data[cy0 * w + cx1] / 65535;
    const s01 = data[cy1 * w + cx0] / 65535;
    const s11 = data[cy1 * w + cx1] / 65535;
    const top = s00 + fx * (s10 - s00);
    const bot = s01 + fx * (s11 - s01);
    return top + fy * (bot - top);
}

const _expBuf = new ArrayBuffer(8);
const _expDV = new DataView(_expBuf);
const EXP_LN2HI = 6.93147180369123816490e-01; // 0x3fe62e42, 0xfee00000
const EXP_LN2LO = 1.90821492927058770002e-10; // 0x3dea39ef, 0x35793c76
const EXP_INVLN2 = 1.44269504088896338700e+00; // 0x3ff71547, 0x652b82fe
const EXP_P1 = 1.66666666666666019037e-01; // 0x3FC55555, 0x5555553E
const EXP_P2 = -2.77777777770155933842e-03; // 0xBF66C16C, 0x16BEBD93
const EXP_P3 = 6.61375632143793436117e-05; // 0x3F11566A, 0xAF25DE2C
const EXP_P4 = -1.65339022054652515390e-06; // 0xBEBBBD41, 0xC5D26BF1
const EXP_P5 = 4.13813679705723846039e-08; // 0x3E663769, 0x72BEA4D0
const EXP_1P1023 = 8.98846567431158e+307; // 0x7fe0000000000000 (2^1023)
const EXP_SUBNORM_MUL = 2.0041683600089728e-292; // 0x0360000000000000 (2^-969)

/**
 * Port of `compiler_builtins` / `libm::exp` (`e_exp.c` + `scalbn`, IEEE 754 `f64`) as compiled into `px.wasm` and
 * `px_scalar.wasm`, so the JS twin and Rust kernel produce identical `f64` bits across all V8 versions (Node and
 * Electron).
 */
export function libmExp(x) {
    _expDV.setFloat64(0, x, true);
    let hx = _expDV.getUint32(4, true);
    const sign = hx >>> 31;
    hx &= 0x7fffffff;

    if (hx >= 0x4086232b) {
        if (Number.isNaN(x)) return x;
        if (x > 709.782712893383973096) return x * EXP_1P1023;
        if (x < -745.13321910194110842) return 0.0;
    }

    let hi = 0.0;
    let lo = 0.0;
    let k = 0;
    if (hx > 0x3fd62e42) {
        if (hx >= 0x3ff0a2b2) {
            k = (EXP_INVLN2 * x + (sign ? -0.5 : 0.5)) | 0;
        } else {
            k = 1 - sign - sign;
        }
        hi = x - k * EXP_LN2HI;
        lo = k * EXP_LN2LO;
        x = hi - lo;
    } else if (hx > 0x3e300000) {
        k = 0;
        hi = x;
        lo = 0.0;
    } else {
        return 1.0 + x;
    }

    const xx = x * x;
    const c = x - xx * (EXP_P1 + xx * (EXP_P2 + xx * (EXP_P3 + xx * (EXP_P4 + xx * EXP_P5))));
    let y = 1.0 + (x * c / (2.0 - c) - lo + hi);
    if (k === 0) return y;

    let n = k;
    if (n > 1023) {
        y *= EXP_1P1023;
        n -= 1023;
        if (n > 1023) {
            y *= EXP_1P1023;
            n -= 1023;
            if (n > 1023) n = 1023;
        }
    } else if (n < -1022) {
        y *= EXP_SUBNORM_MUL;
        n += 969;
        if (n < -1022) {
            y *= EXP_SUBNORM_MUL;
            n += 969;
            if (n < -1022) n = -1022;
        }
    }
    _expDV.setUint32(0, 0, true);
    _expDV.setUint32(4, ((1023 + n) << 20) >>> 0, true);
    return y * _expDV.getFloat64(0, true);
}

function rangeSnapField(mdata, w, h, gdata, gw, gh, mx, my, pr, pg, pb, sigmaR, tau) {
    if (!(sigmaR > 0) || !gdata) {
        return rangeU16Bilinear(mdata, w, h, mx, my);
    }
    const u = mx - 0.5;
    const v = my - 0.5;
    const ix = Math.floor(u);
    const iy = Math.floor(v);

    let lo = 65535;
    let hi = 0;
    for (let dy = -1; dy <= 2; dy++) {
        const y = Math.max(0, Math.min(h - 1, iy + dy));
        const row = y * w;
        for (let dx = -1; dx <= 2; dx++) {
            const x = Math.max(0, Math.min(w - 1, ix + dx));
            const val = mdata[row + x];
            if (val < lo) lo = val;
            if (val > hi) hi = val;
        }
    }

    const range = hi / 65535 - lo / 65535;
    const k = rangeSstep(tau, 2 * tau, range);
    if (k <= 0) {
        return rangeU16Bilinear(mdata, w, h, mx, my);
    }

    const inv2SigmaR2 = 0.5 / (sigmaR * sigmaR);
    let num = 0;
    let den = 0;
    for (let dy = -1; dy <= 2; dy++) {
        const ty = iy + dy;
        const distY = v - ty;
        const distY2 = distY * distY;
        const cy = Math.max(0, Math.min(h - 1, ty));
        const gy = Math.max(0, Math.min(gh - 1, ty));
        const mrow = cy * w;
        const grow = gy * gw;
        for (let dx = -1; dx <= 2; dx++) {
            const tx = ix + dx;
            const distX = u - tx;
            const distSpatial2 = distX * distX + distY2;
            const cx = Math.max(0, Math.min(w - 1, tx));
            const gx = Math.max(0, Math.min(gw - 1, tx));
            const gIdx = (grow + gx) * 4;
            const gr = gdata[gIdx] / 255;
            const gg = gdata[gIdx + 1] / 255;
            const gb = gdata[gIdx + 2] / 255;
            const dr = pr - gr;
            const dg = pg - gg;
            const db = pb - gb;
            const distColor2 = dr * dr + dg * dg + db * db;
            const wSpatial = libmExp(-0.5 * distSpatial2);
            const wColor = libmExp(-distColor2 * inv2SigmaR2);
            const weight = wSpatial * wColor;
            const mVal = mdata[mrow + cx] / 65535;
            num += weight * mVal;
            den += weight;
        }
    }

    const bil = rangeU16Bilinear(mdata, w, h, mx, my);
    if (!(den > 1e-6)) return bil;
    const snapped = num / den;
    return bil + k * (snapped - bil);
}

/**
 * Evaluates the `"compute"`-class tiles (`classes[tx] === 2` or `"compute"`, or every column when `classes` is null)
 * of one document tile row `ty` (`[y0, y1)` clipped to `[ty * tile, min((ty + 1) * tile, H))`) over a depth map
 * (`map`, `mw` x `mh` u16, affine transform `xf`) and optional joint-bilateral snap (`snap = [sigmaR, tau]`, `guide`,
 * `pic`) (K22, docs/PLAN_WASM_BUILD.md §4.8). Rust twin: crates/px/src/range.rs `range_tiles_depth` (`px.js`
 * `rangeTilesDepth`).
 */
export function rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert = false, snap = null, guide = null, pic = null, classes = null, tile = 256) {
    if (!map || !limit || !(mw > 0) || !(mh > 0) || !(W > 0) || !(H > 0) || !(tile > 0 && tile <= 4096) || !(ty >= 0) || !(y0 < y1) || !Array.isArray(xf) || xf.length < 6) {
        throw new Error("rangeTilesDepth: bad arguments");
    }
    const [m0, m1, m2, m3, m4, m5] = xf;
    const lo = +limit.lo || 0, hi = +limit.hi || 0;
    const fLo = +limit.fLo || 0, fHi = +limit.fHi || 0;
    const limitInvert = !!limit.invert;
    const jobInvert = !!invert;
    const sigmaR = Array.isArray(snap) && snap.length >= 2 ? +snap[0] || 0 : 0;
    const tau = Array.isArray(snap) && snap.length >= 2 ? +snap[1] || 0 : 0;
    if (![m0, m1, m2, m3, m4, m5, lo, hi, fLo, fHi, sigmaR, tau].every(Number.isFinite)) {
        throw new Error("rangeTilesDepth: non-finite parameters");
    }
    if (map.length < mw * mh) throw new Error("rangeTilesDepth: short map");
    const cols = Math.ceil(W / tile);
    if (classes && classes.length < cols) throw new Error("rangeTilesDepth: short classes");

    let gBytes = null, gw = mw, gh = mh;
    if (guide) {
        const gd = guide.data || guide;
        gw = guide.w != null ? guide.w | 0 : mw;
        gh = guide.h != null ? guide.h | 0 : mh;
        if (!gd || gw !== mw || gh !== mh) throw new Error("rangeTilesDepth: bad guide");
        gBytes = bytesOf(gd);
        if (gBytes.length < mw * mh * 4) throw new Error("rangeTilesDepth: short guide");
    }
    let pBytes = null, picX0 = 0, picY0 = 0, picX1 = 0, picY1 = 0, picW = 0;
    if (pic && pic.data && (pic.w | 0) > 0 && (pic.h | 0) > 0) {
        if ((pic.x0 | 0) < 0 || (pic.y0 | 0) < 0) throw new Error("rangeTilesDepth: bad pic origin");
        pBytes = bytesOf(pic.data);
        picX0 = pic.x0 | 0;
        picY0 = pic.y0 | 0;
        picW = pic.w | 0;
        const picH = pic.h | 0;
        if (pBytes.length < picW * picH * 4) throw new Error("rangeTilesDepth: short pic");
        picX1 = picX0 + picW;
        picY1 = picY0 + picH;
    }
    const snapOn = sigmaR > 0 && gBytes !== null && pBytes !== null;

    const tileY0 = ty * tile;
    const tileY1 = Math.min(tileY0 + tile, H);
    const tiles = [];
    let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
    let alphaSum = 0;

    for (let tx = 0; tx < cols; tx++) {
        if (classes) {
            const cls = classes[tx];
            if (cls !== 2 && cls !== "compute") continue;
        }
        const tileX0 = tx * tile;
        const tileX1 = Math.min(tileX0 + tile, W);
        const alpha = new Uint8Array(tile * tile);
        let zeros = 0, fulls = 0;
        let tMinX = tile, tMinY = tile, tMaxX = -1, tMaxY = -1;

        for (let py = 0; py < tile; py++) {
            const y = tileY0 + py;
            if (y < y0 || y >= y1 || y >= H) {
                zeros += tile;
                continue;
            }
            const pyOffset = py * tile;
            const pyCentre = y + 0.5;
            for (let px = 0; px < tile; px++) {
                const x = tileX0 + px;
                if (x >= W) {
                    zeros++;
                    continue;
                }
                const pxCentre = x + 0.5;
                const mx = m0 * pxCentre + m2 * pyCentre + m4;
                const my = m1 * pxCentre + m3 * pyCentre + m5;
                let v;
                if (snapOn && x >= picX0 && x < picX1 && y >= picY0 && y < picY1) {
                    const pOffset = ((y - picY0) * picW + (x - picX0)) * 4;
                    const pr = pBytes[pOffset] / 255;
                    const pg = pBytes[pOffset + 1] / 255;
                    const pb = pBytes[pOffset + 2] / 255;
                    v = rangeSnapField(map, mw, mh, gBytes, gw, gh, mx, my, pr, pg, pb, sigmaR, tau);
                } else {
                    v = rangeU16Bilinear(map, mw, mh, mx, my);
                }
                const w = rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert);
                const a = Math.round(255 * (jobInvert ? 1 - w : w));
                alpha[pyOffset + px] = a;
                alphaSum += a;
                if (a === 0) {
                    zeros++;
                } else {
                    if (a === 255) fulls++;
                    if (px < tMinX) tMinX = px;
                    if (px > tMaxX) tMaxX = px;
                    if (py < tMinY) tMinY = py;
                    if (py > tMaxY) tMaxY = py;
                }
            }
        }

        if (zeros === tile * tile) continue;
        if (fulls === tile * tile && (tileX1 - tileX0) === tile && (tileY1 - tileY0) === tile) {
            tiles.push({ tx, ty, full: true });
            bX0 = Math.min(bX0, tileX0);
            bY0 = Math.min(bY0, tileY0);
            bX1 = Math.max(bX1, tileX0 + tile);
            bY1 = Math.max(bY1, tileY0 + tile);
        } else {
            tiles.push({ tx, ty, alpha: alpha.buffer });
            bX0 = Math.min(bX0, tileX0 + tMinX);
            bY0 = Math.min(bY0, tileY0 + tMinY);
            bX1 = Math.max(bX1, tileX0 + tMaxX + 1);
            bY1 = Math.max(bY1, tileY0 + tMaxY + 1);
        }
    }

    const bounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
    return { tiles, bounds, alphaSum };
}

const RANGE_LUMA_R = new Float64Array(256);
const RANGE_LUMA_G = new Float64Array(256);
const RANGE_LUMA_B = new Float64Array(256);
const RANGE_INV255 = new Float64Array(256);
const RANGE_OPP_R = new Float64Array(256);
const RANGE_OPP_G = new Float64Array(256);
const RANGE_OPP_B = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    RANGE_LUMA_R[i] = 0.299 * i;
    RANGE_LUMA_G[i] = 0.587 * i;
    RANGE_LUMA_B[i] = 0.114 * i;
    const u = i / 255;
    RANGE_INV255[i] = u;
    RANGE_OPP_R[i] = 0.299 * u;
    RANGE_OPP_G[i] = 0.587 * u;
    RANGE_OPP_B[i] = 0.114 * u;
}

function rangeHexToRgb01(hex) {
    if (!hex || typeof hex !== "string") return [1, 1, 1];
    const clean = hex.replace(/^#/, "");
    if (clean.length === 6) {
        return [
            parseInt(clean.slice(0, 2), 16) / 255,
            parseInt(clean.slice(2, 4), 16) / 255,
            parseInt(clean.slice(4, 6), 16) / 255,
        ];
    }
    if (clean.length === 3) {
        return [
            parseInt(clean[0] + clean[0], 16) / 255,
            parseInt(clean[1] + clean[1], 16) / 255,
            parseInt(clean[2] + clean[2], 16) / 255,
        ];
    }
    return [1, 1, 1];
}

/**
 * Evaluates one document tile row `ty` (`[y0, y1)` clipped to `[ty * tile, min((ty + 1) * tile, H))`) over a
 * `(y1 - y0)`-row RGBA8 band `rgba` (`W * (y1 - y0) * 4` bytes) for `"luma"` (three 256-entry `f64` product tables)
 * or `"color"` (opponent colour similarity with `libmExp`) range selection (K23, docs/PLAN_WASM_BUILD.md §4.8).
 * Rust twin: crates/px/src/range.rs `range_tiles_rgba` (`px.js` `rangeTilesRgba`).
 */
export function rangeTilesRgba(rgba, W, H, ty, y0, y1, limit, invert = false, tile = 256) {
    if (!rgba || !limit || !(W > 0) || !(H > 0) || !(tile > 0 && tile <= 4096) || !(ty >= 0) || !(y0 >= 0) || !(y0 < y1) || !(y1 <= H)) {
        throw new Error("rangeTilesRgba: bad arguments");
    }
    const u8 = bytesOf(rgba);
    if (!u8 || u8.length < (y1 - y0) * W * 4) throw new Error("rangeTilesRgba: short rgba");

    const isColor = limit.source === "color" || (limit.source !== "luma" && limit.color != null);
    const lo = limit.lo == null ? 0 : +limit.lo;
    const hi = limit.hi == null ? 0 : +limit.hi;
    const fLo = limit.fLo == null ? 0 : +limit.fLo;
    const fHi = limit.fHi == null ? 0 : +limit.fHi;
    const tol = limit.tol == null ? 30 : +limit.tol;
    const limitInvert = !!limit.invert;
    const jobInvert = !!invert;
    let refL = 0, refA = 0, refB = 0;
    if (isColor) {
        const [r, g, b] = rangeHexToRgb01(limit.color || "#ffffff");
        refL = 0.299 * r + 0.587 * g + 0.114 * b;
        refA = r - refL;
        refB = b - refL;
    }
    if (![lo, hi, fLo, fHi, refL, refA, refB, tol].every(Number.isFinite)) {
        throw new Error("rangeTilesRgba: non-finite parameters");
    }

    const tileY0 = ty * tile;
    const tileY1 = Math.min(tileY0 + tile, H);
    const ry0 = Math.max(tileY0, y0);
    const ry1 = Math.min(tileY1, y1);
    if (!(ry0 < ry1)) {
        return { tiles: [], bounds: null, alphaSum: 0 };
    }

    const s = 0.04 + Math.max(0, Math.min(1, (tol || 0) / 100)) * 0.6;
    const twoS2 = 2 * s * s;

    const cols = Math.ceil(W / tile);
    const tiles = [];
    let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
    let alphaSum = 0;

    for (let tx = 0; tx < cols; tx++) {
        const tileX0 = tx * tile;
        const tileX1 = Math.min(tileX0 + tile, W);
        const alpha = new Uint8Array(tile * tile);
        let zeros = 0, fulls = 0;
        let tMinX = tile, tMinY = tile, tMaxX = -1, tMaxY = -1;

        for (let py = 0; py < tile; py++) {
            const y = tileY0 + py;
            if (y < y0 || y >= y1 || y >= H) {
                zeros += tile;
                continue;
            }
            const pyOffset = py * tile;
            const rowOffset = (y - y0) * W;
            for (let px = 0; px < tile; px++) {
                const x = tileX0 + px;
                if (x >= W) {
                    zeros++;
                    continue;
                }
                const offset = (rowOffset + x) * 4;
                const rb = u8[offset];
                const gb = u8[offset + 1];
                const bb = u8[offset + 2];
                let v;
                if (!isColor) {
                    v = (RANGE_LUMA_R[rb] + RANGE_LUMA_G[gb] + RANGE_LUMA_B[bb]) / 255;
                } else {
                    const L = RANGE_OPP_R[rb] + RANGE_OPP_G[gb] + RANGE_OPP_B[bb];
                    const d0 = L - refL;
                    const d1 = (RANGE_INV255[rb] - L) - refA;
                    const d2 = (RANGE_INV255[bb] - L) - refB;
                    const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
                    v = libmExp(-dd / twoS2);
                }
                const w = rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert);
                const a = Math.round(255 * (jobInvert ? 1 - w : w));
                alpha[pyOffset + px] = a;
                alphaSum += a;
                if (a === 0) {
                    zeros++;
                } else {
                    if (a === 255) fulls++;
                    if (px < tMinX) tMinX = px;
                    if (px > tMaxX) tMaxX = px;
                    if (py < tMinY) tMinY = py;
                    if (py > tMaxY) tMaxY = py;
                }
            }
        }

        if (zeros === tile * tile) continue;
        if (fulls === tile * tile && (tileX1 - tileX0) === tile && (tileY1 - tileY0) === tile) {
            tiles.push({ tx, ty, full: true });
            bX0 = Math.min(bX0, tileX0);
            bY0 = Math.min(bY0, tileY0);
            bX1 = Math.max(bX1, tileX0 + tile);
            bY1 = Math.max(bY1, tileY0 + tile);
        } else {
            tiles.push({ tx, ty, alpha: alpha.buffer });
            bX0 = Math.min(bX0, tileX0 + tMinX);
            bY0 = Math.min(bY0, tileY0 + tMinY);
            bX1 = Math.max(bX1, tileX0 + tMaxX + 1);
            bY1 = Math.max(bY1, tileY0 + tMaxY + 1);
        }
    }

    const bounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
    return { tiles, bounds, alphaSum };
}

/**
 * Multiplies the alpha channel of `rgba` (`w * h * 4` RGBA8 bytes, in place) by the depth limit weight over `map`
 * (`mw` x `mh` u16, affine transform `xf`) and optional joint-bilateral snap (`snap = [sigmaR, tau]`, `guide`,
 * optional `col` reference RGBA8) in chunks of at most 256 rows (K25, docs/PLAN_WASM_BUILD.md §4.8).
 * When `col` is null and `guide` is given, the snap reference colour is sampled from `guide` at `(mx, my)`.
 * Rust twin: crates/px/src/range.rs `limit_alpha_rows` (`px.js` `limitAlphaRows`).
 */
export function limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) {
    if (!rgba || !(map instanceof Uint16Array) || !limit || !(mw > 0) || !(mh > 0) || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0 || !Number.isInteger(x0) || !Number.isInteger(y0) || (!Array.isArray(xf) && !ArrayBuffer.isView(xf)) || xf.length < 6) {
        throw new Error("limitAlphaRows: bad arguments");
    }
    if (map.length < mw * mh) throw new Error("limitAlphaRows: short map");
    const u8 = ArrayBuffer.isView(rgba)
        ? bytesOf(rgba)
        : (rgba instanceof ArrayBuffer ? new Uint8Array(rgba) : null);
    const needBytes = w * h * 4;
    if (!u8 || u8.length < needBytes) throw new Error("limitAlphaRows: short rgba");

    let cBytes = null;
    if (col != null) {
        cBytes = ArrayBuffer.isView(col)
            ? bytesOf(col)
            : (col instanceof ArrayBuffer ? new Uint8Array(col) : null);
        if (!cBytes || cBytes.length < needBytes) throw new Error("limitAlphaRows: short col");
    }

    const m0 = +xf[0], m1 = +xf[1], m2 = +xf[2], m3 = +xf[3], m4 = +xf[4], m5 = +xf[5];
    const lo = limit.lo == null ? 0 : +limit.lo;
    const hi = limit.hi == null ? 1 : +limit.hi;
    const fLo = limit.fLo == null ? 0 : +limit.fLo;
    const fHi = limit.fHi == null ? 0 : +limit.fHi;
    const limitInvert = !!limit.invert;
    let sigmaR = 0, tau = 0;
    if (snap != null) {
        if ((!Array.isArray(snap) && !ArrayBuffer.isView(snap)) || snap.length < 2) {
            throw new Error("limitAlphaRows: snap must have 2 elements");
        }
        sigmaR = snap[0] == null ? 0 : +snap[0];
        tau = snap[1] == null ? 0 : +snap[1];
    }
    if (![m0, m1, m2, m3, m4, m5, lo, hi, fLo, fHi, sigmaR, tau].every(Number.isFinite)) {
        throw new Error("limitAlphaRows: non-finite parameters");
    }

    let gBytes = null;
    if (guide != null) {
        const gRaw = guide.data || guide;
        const gw = guide.w != null ? guide.w | 0 : mw;
        const gh = guide.h != null ? guide.h | 0 : mh;
        if (!gRaw || gw !== mw || gh !== mh) throw new Error("limitAlphaRows: bad guide");
        gBytes = ArrayBuffer.isView(gRaw)
            ? bytesOf(gRaw)
            : (gRaw instanceof ArrayBuffer ? new Uint8Array(gRaw) : null);
        if (!gBytes || gBytes.length < mw * mh * 4) throw new Error("limitAlphaRows: short guide");
    }
    if (w === 0 || h === 0) return rgba;

    const snapOn = !!(sigmaR > 0 && gBytes);
    const maxX = mw - 1, maxY = mh - 1;

    for (let cy = 0; cy < h; cy += 256) {
        const ch = Math.min(256, h - cy);
        for (let ry = 0; ry < ch; ry++) {
            const y = cy + ry;
            const py = y0 + y + 0.5;
            let off = y * w * 4;
            for (let x = 0; x < w; x++, off += 4) {
                const px = x0 + x + 0.5;
                const mx = m0 * px + m2 * py + m4;
                const my = m1 * px + m3 * py + m5;
                let mv;
                if (snapOn) {
                    let pr, pg, pb;
                    if (cBytes) {
                        pr = cBytes[off] / 255;
                        pg = cBytes[off + 1] / 255;
                        pb = cBytes[off + 2] / 255;
                    } else {
                        const gx = Math.max(0, Math.min(maxX, Math.floor(mx)));
                        const gy = Math.max(0, Math.min(maxY, Math.floor(my)));
                        const gOff = (gy * mw + gx) * 4;
                        pr = gBytes[gOff] / 255;
                        pg = gBytes[gOff + 1] / 255;
                        pb = gBytes[gOff + 2] / 255;
                    }
                    mv = rangeSnapField(map, mw, mh, gBytes, mw, mh, mx, my, pr, pg, pb, sigmaR, tau);
                } else {
                    mv = rangeU16Bilinear(map, mw, mh, mx, my);
                }
                const v = Math.max(0, Math.min(1, mv));
                const wVal = rangeWeightScalar(v, lo, hi, fLo, fHi, limitInvert);
                u8[off + 3] = Math.max(0, Math.min(255, Math.round(u8[off + 3] * wVal)));
            }
        }
    }
    return rgba;
}

// ---- depth map guided filter (K24) --------------------------------------------------------------

/**
 * The depth map's guided filter (`inpaint_depth.js` `guidedFar`, K24): accepts either an options object
 * `{ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }` (with optional `out` as the second argument) or positional
 * `(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null)`. Writes `gw * gh` `u16` values into `out` (or a new
 * `Uint16Array`) and returns it.
 */
export function guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null) {
    let msg;
    if (raw && typeof raw === "object" && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) {
        msg = raw;
        if (rw instanceof Uint16Array) out = rw;
    } else {
        msg = { raw, rw, rh, grey, gw, gh, r, eps, lo, hi };
    }
    const res = guidedFarDepth(msg, boxBlurs);
    if (out) {
        out.set(res);
        return out;
    }
    return res;
}


