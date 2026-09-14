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

export const OPS = Object.freeze({
    "source-over": 0,
    "destination-out": 1,
    "source-atop": 2,
    "destination-in": 3,
    copy: 4,
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
 * opacity) has loops of its own. The nine blend modes come in C6 (docs/PLAN_BCE.md §5).
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

/** A zlib stream through the browser's native `CompressionStream("deflate")`. */
export async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
