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

import { BLEND_OPS, LAST_BLEND } from "../blend_modes.js";

export const OPS = Object.freeze({
    "source-over": 0,
    "destination-out": 1,
    "source-atop": 2,
    "destination-in": 3,
    copy: 4,
    // the blend modes (a layer's `blend`), source-over with B(backdrop, source) where both cover
    ...BLEND_OPS,
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
 * The nine blend modes (ops 5 to 12, docs/PLAN_BCE.md §3b B item 7; linear light, op 13, docs/PLAN_0_1_31.md §4 step 8)
 * are the W3C formula rounded ONCE per channel (three rounded products were up to 1.45 levels from the exact value; this
 * is within half a level). Linear light is not a W3C mode; B = clamp(cb + 2·cs − 1, 0, 1) as Photoshop has it:
 *
 *   B16(cb, cs) = 255 · B, exact integers:
 *     multiply    b·s                          screen      65025 − (255 − b)(255 − s)
 *     hard-light  s ≤ 127 ? 2·b·s : 65025 − (255 − b)(510 − 2s)        overlay: b and s swapped
 *     darken, lighten, difference   255 · min, max, |b − s|
 *     linear-light  255 · clamp(b + 2s − 255, 0, 255)
 *     soft-light  s ≤ 127 ? 255·b − floor(((255 − 2s)·b·(255 − b) + 127) / 255)
 *                         : 255·b + floor(((2s − 255)·(SOFT_D[b] − 257·b) + 128) / 257)
 *   over an opaque backdrop:  r = floor((dp·inv·255 + sa·B16 + 32512) / 65025)
 *   else, with cb = dp unpremultiplied as at the end and ra = sa + mul255(da, inv):
 *     r = min(ra, floor((s.c·sa·(255 − da)·255 + dp·inv·65025 + sa·da·B16 + 8290687) / 16581375))
 *   The sums go up to 255⁴: plain numbers and Math.floor, no `| 0`.
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
        else if (op >= 5 && op <= LAST_BLEND) blendOp(d, src, o, mask, px, op);
        else if (op > LAST_BLEND) over(d, src, o, mask, px);
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

/** 255 · B(cb, cs) of a blend mode, both straight 0..255: 0..65025. */
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
        default: return 255 * (b > s ? b - s : s - b);
    }
}

export function blend3(op, b0, b1, b2, s0, s1, s2, out) {
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
 * row above the first one, or null for zeros.
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
        if (s2 < min) { best = 2; min = s2; }
        if (s3 < min) { best = 3; min = s3; }
        if (s4 < min) { best = 4; min = s4; }
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
