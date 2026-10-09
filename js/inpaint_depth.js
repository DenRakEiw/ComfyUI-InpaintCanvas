// Generated from DenRakEiw/scumble renderer/editor/inpaint_depth.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// The depth map mathematics for Depth Anything V2 Small (Nik-9 Parity R1-S3a).
// Model sizing (DPT aspect-keeping multiple-of-14), working sizes, disparity range,
// far conversion, bilinear upsampling, and the guided filter (He et al.).
// No DOM references here: runs under plain Node, in Web Workers, and in the renderer.

export const WORK_MAX = 4096;   // the map follows the picture up to this long side (the user, 2026-10-09: larger pictures, larger maps)
export const STALE_DIFF = 6;
export const GUIDE = { r: 2, eps: 1e-3 };
export const LONG_CAP = 2058;
export const DEPTH_LARGE = 1568;   // 14 * 112, the large route long side (PLAN_NIK9_BUILD.md R2-S7)
export const RANGE_BAND_ROWS = 1024;

/**
 * Python's round(): round-half-to-even.
 * E.g. 54.5 -> 54, 55.5 -> 56, -54.5 -> -54.
 *
 * @param {number} x
 * @returns {number}
 */
export function roundHalfEven(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (Math.abs(diff - 0.5) < 1e-9) {
        return (f % 2 === 0) ? f : f + 1;
    }
    return Math.round(x);
}

/**
 * Compute DPT model input size with keep_aspect_ratio and multiple of 14,
 * then optionally capped on the long side.
 * The scale nearer to 1 wins: shrinking puts the short side at 518, enlarging the long side.
 *
 * @param {number} W
 * @param {number} H
 * @param {{ short?: number, multiple?: number, cap?: number | null }} [opts]
 * @returns {[number, number]}
 */
export function modelSize(W, H, { short = 518, multiple = 14, cap = LONG_CAP } = {}) {
    let scale;
    if (W <= short && H <= short) {
        scale = short / Math.max(W, H);
    } else if (W >= short && H >= short) {
        scale = short / Math.min(W, H);
    } else {
        scale = Math.abs(1 - short / W) < Math.abs(1 - short / H) ? short / W : short / H;
    }

    let mw = Math.max(multiple, roundHalfEven((W * scale) / multiple) * multiple);
    let mh = Math.max(multiple, roundHalfEven((H * scale) / multiple) * multiple);

    if (cap != null && Math.max(mw, mh) > cap) {
        const capScale = cap / Math.max(mw, mh);
        mw = Math.max(multiple, roundHalfEven((mw * capScale) / multiple) * multiple);
        mh = Math.max(multiple, roundHalfEven((mh * capScale) / multiple) * multiple);
    }
    return [mw, mh];
}

/**
 * Compute the document's working map size capped at max (default WORK_MAX),
 * keeping aspect ratio.
 *
 * @param {number} W
 * @param {number} H
 * @param {number} [max]
 * @returns {[number, number]}
 */
export function workSize(W, H, max = WORK_MAX) {
    const m = Math.max(W, H);
    if (m <= max) return [W, H];
    const s = max / m;
    return [Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))];
}

/**
 * Compute disparity range [lo, hi] using a 4096-bin histogram.
 *
 * @param {Float32Array} d raw disparity array
 * @param {number} [pLo] default 0.005 (0.5%)
 * @param {number} [pHi] default 0.995 (99.5%)
 * @returns {{ lo: number, hi: number }}
 */
export function disparityRange(d, pLo = 0.005, pHi = 0.995) {
    let min = Infinity, max = -Infinity;
    const n = d.length;
    for (let i = 0; i < n; i++) {
        const v = d[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (min === max || !Number.isFinite(min) || !Number.isFinite(max)) {
        return { lo: min, hi: max };
    }

    const B = 4096;
    const inv = B / (max - min);
    const bins = new Uint32Array(B);
    for (let i = 0; i < n; i++) {
        let b = ((d[i] - min) * inv) | 0;
        if (b < 0) b = 0; else if (b >= B) b = B - 1;
        bins[b]++;
    }

    const tLo = n * pLo, tHi = n * pHi;
    let sum = 0, lo = min, hi = max;
    let foundLo = false;
    for (let b = 0; b < B; b++) {
        const count = bins[b];
        if (!foundLo && sum + count >= tLo) {
            const frac = count > 0 ? (tLo - sum) / count : 0;
            lo = min + ((b + frac) / B) * (max - min);
            foundLo = true;
        }
        if (sum + count >= tHi) {
            const frac = count > 0 ? (tHi - sum) / count : 0;
            hi = min + ((b + frac) / B) * (max - min);
            break;
        }
        sum += count;
    }
    return { lo, hi };
}

/**
 * Convert disparity array to u16 far map: near (hi) -> 0, far (lo) -> 65535.
 *
 * @param {Float32Array} d
 * @param {number} lo
 * @param {number} hi
 * @returns {Uint16Array}
 */
export function farU16(d, lo, hi) {
    const n = d.length;
    const out = new Uint16Array(n);
    const range = hi - lo;
    const inv = range > 1e-12 ? 1 / range : 0;
    for (let i = 0; i < n; i++) {
        let t = (d[i] - lo) * inv;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        out[i] = Math.round(65535 * (1 - t));
    }
    return out;
}

/**
 * Bilinear resize for float32 arrays with pixel centres and clamped edges.
 *
 * @param {Float32Array} src
 * @param {number} w input width
 * @param {number} h input height
 * @param {number} W2 output width
 * @param {number} H2 output height
 * @returns {Float32Array}
 */
export function bilinearResize(src, w, h, W2, H2) {
    const out = new Float32Array(W2 * H2);
    const xRatio = w / W2;
    const yRatio = h / H2;

    const x0 = new Int32Array(W2);
    const x1 = new Int32Array(W2);
    const wx = new Float32Array(W2);
    for (let x = 0; x < W2; x++) {
        const sx = (x + 0.5) * xRatio - 0.5;
        let ix = Math.floor(sx);
        if (ix < 0) ix = 0; else if (ix > w - 1) ix = w - 1;
        let ix1 = ix + 1;
        if (ix1 > w - 1) ix1 = w - 1;
        x0[x] = ix;
        x1[x] = ix1;
        let f = sx - Math.floor(sx);
        if (f < 0) f = 0; else if (f > 1) f = 1;
        wx[x] = f;
    }

    for (let y = 0; y < H2; y++) {
        const sy = (y + 0.5) * yRatio - 0.5;
        let iy = Math.floor(sy);
        if (iy < 0) iy = 0; else if (iy > h - 1) iy = h - 1;
        let iy1 = iy + 1;
        if (iy1 > h - 1) iy1 = h - 1;
        let fy = sy - Math.floor(sy);
        if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
        const row0 = iy * w;
        const row1 = iy1 * w;
        const outRow = y * W2;
        const invFy = 1 - fy;

        for (let x = 0; x < W2; x++) {
            const ix0 = x0[x], ix1 = x1[x], fx = wx[x];
            const top = (1 - fx) * src[row0 + ix0] + fx * src[row0 + ix1];
            const bot = (1 - fx) * src[row1 + ix0] + fx * src[row1 + ix1];
            out[outRow + x] = invFy * top + fy * bot;
        }
    }
    return out;
}

/**
 * Guided filter (He et al.): means by `box`, q = mean_a * I + mean_b.
 *
 * @param {Float32Array} I guide image (floats 0..1)
 * @param {Float32Array} p input image to filter (floats 0..1)
 * @param {number} w width
 * @param {number} h height
 * @param {number} r radius in working pixels
 * @param {number} eps regularization parameter
 * @param {(data: Float32Array, w: number, h: number, radii: number[]) => Float32Array} box box blur function
 * @returns {Float32Array}
 */
export function guidedFilter(I, p, w, h, r, eps, box) {
    const n = w * h;
    const meanI = box(I, w, h, [r]);
    const meanP = box(p, w, h, [r]);

    const Ip = new Float32Array(n);
    const II = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const iv = I[i];
        Ip[i] = iv * p[i];
        II[i] = iv * iv;
    }
    const meanIp = box(Ip, w, h, [r]);
    const meanII = box(II, w, h, [r]);

    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const mi = meanI[i];
        const covIp = meanIp[i] - mi * meanP[i];
        const varI = meanII[i] - mi * mi;
        const av = covIp / (varI + eps);
        a[i] = av;
        b[i] = meanP[i] - av * mi;
    }

    const meanA = box(a, w, h, [r]);
    const meanB = box(b, w, h, [r]);

    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let v = meanA[i] * I[i] + meanB[i];
        if (v < 0) v = 0; else if (v > 1) v = 1;
        q[i] = v;
    }
    return q;
}

/**
 * Compute the guided far map as Uint16Array.
 *
 * @param {{
 *   raw: Float32Array,
 *   rw: number,
 *   rh: number,
 *   grey: Uint8Array,
 *   gw: number,
 *   gh: number,
 *   r: number,
 *   eps: number,
 *   lo?: number,
 *   hi?: number
 * }} msg
 * @param {(data: Float32Array, w: number, h: number, radii: number[]) => Float32Array} box
 * @returns {Uint16Array}
 */
export function guidedFar({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }, box) {
    if (lo == null || hi == null) {
        const bounds = disparityRange(raw);
        if (lo == null) lo = bounds.lo;
        if (hi == null) hi = bounds.hi;
    }

    const nRaw = rw * rh;
    const farF32 = new Float32Array(nRaw);
    const range = hi - lo;
    const invRange = range > 1e-12 ? 1 / range : 0;
    for (let i = 0; i < nRaw; i++) {
        let t = (raw[i] - lo) * invRange;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        farF32[i] = 1 - t;
    }

    const p = (rw === gw && rh === gh) ? farF32 : bilinearResize(farF32, rw, rh, gw, gh);

    const nWork = gw * gh;
    const I = new Float32Array(nWork);
    const inv255 = 1 / 255;
    for (let i = 0; i < nWork; i++) I[i] = grey[i] * inv255;

    const scale = gw / rw;
    const rWork = Math.max(1, Math.round(r * scale));

    const q = guidedFilter(I, p, gw, gh, rWork, eps, box);

    const u16 = new Uint16Array(nWork);
    for (let i = 0; i < nWork; i++) {
        u16[i] = Math.round(q[i] * 65535);
    }
    return u16;
}
