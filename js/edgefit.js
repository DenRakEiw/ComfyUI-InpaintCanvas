// Generated from DenRakEiw/scumble renderer/editor/edgefit.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Edge fit (item 42): register a layer or a provider's answer to the picture under it on the ring where both should
// show the same thing, the way the node's `_align_patch` (nodes.py) does at stitch time with OpenCV's ECC.
//
// Edit models re-render the whole crop and often shift or slightly scale it, so contours double where the selection
// border crosses an edge. This module finds that drift with a masked affine Lucas-Kanade fit (Gauss-Newton, forward
// additive, with a gain and a bias so a colour drift does not pull the geometry) on a pyramid, at most 512 px on the
// long side, and keeps it only under the node's limits: scale within 8 %, shear under 0.03, shift under 5 % of the
// box, and the ring difference has to drop by 3 % or more. A flat ring (nothing to fit on) refuses.
//
// Plain JS on typed arrays, no DOM: it runs on the window, in the stitch worker and in plain Node
// (tools/edgefit_test.js). At 512 px a fit is a few tens of milliseconds, so it needs neither the wasm kernels nor
// OpenCV.js (about 8 MB).
//
// The matrix convention is OpenCV's `WARP_INVERSE_MAP` one, as in the node: `M = [a00, a01, tx, a10, a11, ty]` maps a
// pixel x of the base to the place in the layer that belongs there, `layer(M x) ~ base(x)`; `warpRGBA` makes
// `out(x) = src(M x)`. `scale`, `shear` and `shift` are read from M exactly as the node reads them.

export const WORK = 512;
export const LIMITS = { scale: 0.08, shear: 0.03, shift: 0.05, gain: 0.97, minRing: 2000, minRingShare: 0.02 };

/** The factor from a box of `w` x `h` to the working size (at most WORK px on the long side). */
export function workScale(w, h) { return Math.min(1, WORK / Math.max(1, w, h)); }

/** Luma (0..1) of RGBA bytes, `n` pixels. */
export function grayOf(rgba, n = rgba.length >> 2) {
    const g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    return g;
}

/**
 * Area average of a float plane `w` x `h` down to `tw` x `th` (each target pixel the mean of the source pixels whose
 * centres fall into its footprint, at least the nearest one).
 */
export function shrinkPlane(src, w, h, tw, th) {
    if (tw === w && th === h) return Float32Array.from(src);
    const out = new Float32Array(tw * th);
    const fx = w / tw, fy = h / th;
    for (let y = 0; y < th; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * fy)));
        for (let x = 0; x < tw; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * fx)));
            let s = 0;
            for (let yy = y0; yy < y1; yy++) { const row = yy * w; for (let xx = x0; xx < x1; xx++) s += src[row + xx]; }
            out[y * tw + x] = s / ((y1 - y0) * (x1 - x0));
        }
    }
    return out;
}

/** The alpha channel of RGBA bytes as floats 0..1. */
export function alphaOf(rgba, n = rgba.length >> 2) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + 3] / 255;
    return a;
}

/**
 * The luma of straight-alpha RGBA bytes shrunk by area, weighted by alpha (a transparent pixel's colour counts for
 * nothing), with its alpha shrunk beside it: `{ gray, alpha }` at `tw` x `th`.
 */
export function shrinkRGBA(rgba, w, h, tw, th) {
    const n = w * h, g = new Float32Array(n), a = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const al = rgba[j + 3] / 255;
        a[i] = al;
        g[i] = al * (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    }
    const gs = shrinkPlane(g, w, h, tw, th), as = shrinkPlane(a, w, h, tw, th);
    for (let i = 0; i < gs.length; i++) gs[i] = as[i] > 1e-4 ? gs[i] / as[i] : 0;
    return { gray: gs, alpha: as };
}

/**
 * The edge ring of a layer: the pixels at least `minAlpha` opaque that lie within `width` px of a less opaque one or of
 * the box's border (outside the box counts as transparent). A Uint8Array of 0 / 1.
 */
export function edgeRing(alpha, w, h, width, minAlpha = 0.25) {
    const INF = 1e9, d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = alpha[i] >= minAlpha ? INF : 0;
    // two-pass chamfer distance (1, 1.414) to the nearest transparent pixel, the border counting as one
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = Math.min(x + 1, y + 1, d[i]);
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + 1.414); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.414); }
        d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        let v = Math.min(w - x, h - y, d[i]);
        if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.414); if (x > 0) v = Math.min(v, d[i + w - 1] + 1.414); }
        d[i] = v;
    }
    const ring = new Uint8Array(w * h);
    for (let i = 0; i < ring.length; i++) ring[i] = d[i] > 0 && d[i] <= width ? 1 : 0;
    return ring;
}

// ---- the fit ---------------------------------------------------------------------------------------------------------

function blur121(src, w, h) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const r = y * w;
        for (let x = 0; x < w; x++) tmp[r + x] = (src[r + Math.max(0, x - 1)] + 2 * src[r + x] + src[r + Math.min(w - 1, x + 1)]) * 0.25;
    }
    for (let y = 0; y < h; y++) {
        const a = Math.max(0, y - 1) * w, b = y * w, c = Math.min(h - 1, y + 1) * w;
        for (let x = 0; x < w; x++) out[b + x] = (tmp[a + x] + 2 * tmp[b + x] + tmp[c + x]) * 0.25;
    }
    return out;
}

function erode(v, w, h, r) {
    let cur = v;
    for (let k = 0; k < r; k++) {
        const out = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            out[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
        }
        cur = out;
    }
    return cur;
}

function half(level) {
    const { w, h } = level, w2 = w >> 1, h2 = h >> 1;
    const T = new Float32Array(w2 * h2), I = new Float32Array(w2 * h2), V = new Uint8Array(w2 * h2), R = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const a = 2 * y * w + 2 * x, b = a + 1, c = a + w, d = c + 1, o = y * w2 + x;
        T[o] = (level.T[a] + level.T[b] + level.T[c] + level.T[d]) * 0.25;
        I[o] = (level.I[a] + level.I[b] + level.I[c] + level.I[d]) * 0.25;
        V[o] = level.V[a] & level.V[b] & level.V[c] & level.V[d];
        R[o] = level.R[a] + level.R[b] + level.R[c] + level.R[d] >= 2 ? 1 : 0;
    }
    return { T, I, V, R, w: w2, h: h2 };
}

/** Solve the n x n system `H x = b` (row-major, copied) by Gaussian elimination with partial pivoting; null when singular. */
function solve(H, b, n) {
    const A = Float64Array.from(H), x = Float64Array.from(b);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
        if (Math.abs(A[p * n + c]) < 1e-12) return null;
        if (p !== c) { for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
        for (let r = c + 1; r < n; r++) {
            const f = A[r * n + c] / A[c * n + c];
            if (!f) continue;
            for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
            x[r] -= f * x[c];
        }
    }
    for (let c = n - 1; c >= 0; c--) {
        let s = x[c];
        for (let k = c + 1; k < n; k++) s -= A[c * n + k] * x[k];
        x[c] = s / A[c * n + c];
    }
    return x;
}

/**
 * Gauss-Newton iterations on one pyramid level. `p` = [a00, a01, a10, a11, tx, ty, gain, bias] around the level's centre
 * (cx, cy), updated in place; `active` the parameters that move. False when the fit ran away.
 */
function iterate(L, p, cx, cy, active, iters, shrink = 2) {
    const { w, h } = L;
    const T = blur121(L.T, w, h), I = blur121(L.I, w, h), V = erode(L.V, w, h, shrink), R = L.R;
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        gx[i] = (I[i + 1] - I[i - 1]) * 0.5;
        gy[i] = (I[i + w] - I[i - w]) * 0.5;
    }
    const idx = [];
    for (let k = 0; k < 8; k++) if (active[k]) idx.push(k);
    const n = idx.length, H = new Float64Array(n * n), b = new Float64Array(n), J = new Float64Array(8), Jn = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
        H.fill(0); b.fill(0);
        let count = 0;
        const [a00, a01, a10, a11, tx, ty, gain, bias] = p;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!R[i]) continue;
            const dx = x - cx, dy = y - cy;
            const X = a00 * dx + a01 * dy + cx + tx, Y = a10 * dx + a11 * dy + cy + ty;
            if (!(X >= 0 && Y >= 0 && X < w - 1 && Y < h - 1)) continue;
            const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0, j = y0 * w + x0;
            if (!(V[j] && V[j + 1] && V[j + w] && V[j + w + 1])) continue;
            const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
            const iv = I[j] * w00 + I[j + 1] * w10 + I[j + w] * w01 + I[j + w + 1] * w11;
            const gxv = (gx[j] * w00 + gx[j + 1] * w10 + gx[j + w] * w01 + gx[j + w + 1] * w11) * gain;
            const gyv = (gy[j] * w00 + gy[j + 1] * w10 + gy[j + w] * w01 + gy[j + w + 1] * w11) * gain;
            const e = T[i] - (gain * iv + bias);
            J[0] = gxv * dx; J[1] = gxv * dy; J[2] = gyv * dx; J[3] = gyv * dy; J[4] = gxv; J[5] = gyv; J[6] = iv; J[7] = 1;
            for (let r = 0; r < n; r++) Jn[r] = J[idx[r]];
            for (let r = 0; r < n; r++) {
                const jr = Jn[r];
                b[r] += jr * e;
                for (let c = r; c < n; c++) H[r * n + c] += jr * Jn[c];
            }
            count++;
        }
        if (count < 64) return false;
        for (let r = 0; r < n; r++) for (let c = 0; c < r; c++) H[r * n + c] = H[c * n + r];
        for (let r = 0; r < n; r++) H[r * n + r] *= 1.0001;   // a little damping against a nearly singular step
        const d = solve(H, b, n);
        if (!d) return false;
        let moveA = 0, moveT = 0;
        for (let r = 0; r < n; r++) {
            const k = idx[r];
            p[k] += d[r];
            if (k < 4) moveA = Math.max(moveA, Math.abs(d[r])); else if (k < 6) moveT = Math.max(moveT, Math.abs(d[r]));
        }
        if (Math.abs(p[0] - 1) > 0.3 || Math.abs(p[3] - 1) > 0.3 || Math.abs(p[1]) > 0.3 || Math.abs(p[2]) > 0.3
            || Math.abs(p[4]) > 0.3 * w || Math.abs(p[5]) > 0.3 * h || !Number.isFinite(p[4] + p[5])) return false;
        if (moveT < 0.01 && moveA < 5e-5) break;
    }
    return true;
}

/** Mean absolute difference base / layer over the ring, the layer read through `M` (working pixels); null when nothing valid. */
function ringDiff(T, I, V, R, w, h, M) {
    const [a00, a01, tx, a10, a11, ty] = M;
    let s = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!R[i] || !V[i]) continue;
        const X = a00 * x + a01 * y + tx, Y = a10 * x + a11 * y + ty;
        if (!(X >= 0 && Y >= 0 && X < w - 1 && Y < h - 1)) continue;
        const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0, j = y0 * w + x0;
        if (!(V[j] && V[j + 1] && V[j + w] && V[j + w + 1])) continue;
        const iv = I[j] * (1 - fx) * (1 - fy) + I[j + 1] * fx * (1 - fy) + I[j + w] * (1 - fx) * fy + I[j + w + 1] * fx * fy;
        s += Math.abs(T[i] - iv); n++;
    }
    return n ? s / n : null;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4, r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

/**
 * The fit. `base` and `layer` are luma planes (0..1) of `w` x `h` working pixels; `ring` (0 / 1) where the two should
 * agree; `valid` (0 / 1, optional) where the layer's own colour can be trusted (opaque enough); `fullW` x `fullH` the
 * box at full size (the limits and the ring's minimum size are measured there, the matrix is given there).
 *
 * `{ aligned, reason?, scale: [sx, sy], shift: [tx, ty], shear, matrix, before, after }`: `matrix` the full-size
 * `[a00, a01, tx, a10, a11, ty]` with `layer(M x) ~ base(x)` (only when a fit was found), `before` / `after` the ring's
 * mean difference in levels of 255.
 */
export function fitEdges({ base, layer, ring, valid = null, w, h, fullW = w, fullH = h }) {
    const s = w / fullW;
    let ringN = 0;
    for (let i = 0; i < ring.length; i++) ringN += ring[i];
    const ringFull = ringN / (s * s);
    if (ringFull < LIMITS.minRing || ringFull < LIMITS.minRingShare * fullW * fullH) return { aligned: false, reason: "ring too small" };
    const V = valid || new Uint8Array(w * h).fill(1);
    // flat: no contrast or no gradients in two directions on the ring (a single straight edge cannot be fitted either)
    {
        const Tb = blur121(base, w, h);
        let m = 0, m2 = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!ring[i]) continue;
            const gx = (Tb[i + 1] - Tb[i - 1]) * 0.5, gy = (Tb[i + w] - Tb[i - w]) * 0.5;
            m += base[i]; m2 += base[i] * base[i]; sxx += gx * gx; syy += gy * gy; sxy += gx * gy; n++;
        }
        if (!n) return { aligned: false, reason: "ring too small" };
        m /= n; sxx /= n; syy /= n; sxy /= n;
        const std = Math.sqrt(Math.max(0, m2 / n - m * m));
        const tr = sxx + syy, det = sxx * syy - sxy * sxy, lmin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
        if (std < 0.02 || lmin < 2e-6) return { aligned: false, reason: "flat area" };
    }
    // the pyramid: halves while the short side stays at 96 px or more (the ring gets thin below), at most three levels
    const levels = [{ T: base, I: layer, V, R: ring, w, h }];
    while (levels.length < 3 && Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) >= 192) levels.push(half(levels[levels.length - 1]));
    const c0x = (w - 1) / 2, c0y = (h - 1) / 2;
    const p = [1, 0, 0, 1, 0, 0, 1, 0];
    for (let k = levels.length - 1; k >= 0; k--) {
        const L = levels[k], f = 1 << k;
        const cx = (c0x + 0.5) / f - 0.5, cy = (c0y + 0.5) / f - 0.5;
        // the translation is held in working pixels; this level's is that over f
        p[4] /= f; p[5] /= f;
        let ok = true;
        if (k === levels.length - 1) ok = iterate(L, p, cx, cy, [0, 0, 0, 0, 1, 1, 1, 1], 30, k ? 1 : 2);
        if (ok) ok = iterate(L, p, cx, cy, [1, 1, 1, 1, 1, 1, 1, 1], k ? 40 : 60, k ? 1 : 2);
        p[4] *= f; p[5] *= f;
        if (!ok) return { aligned: false, reason: "no fit found" };
    }
    // to full-size pixels with the origin at the top left: centre (c + 0.5) / s - 0.5, translation over s
    const cfx = (c0x + 0.5) / s - 0.5, cfy = (c0y + 0.5) / s - 0.5;
    const [a00, a01, a10, a11] = p, ftx = p[4] / s, fty = p[5] / s;
    const M = [a00, a01, cfx - a00 * cfx - a01 * cfy + ftx, a10, a11, cfy - a10 * cfx - a11 * cfy + fty];
    const sx = Math.hypot(M[0], M[3]), sy = Math.hypot(M[1], M[4]);
    const shear = Math.abs(M[0] * M[1] + M[3] * M[4]);
    const out = { scale: [r4(sx), r4(sy)], shift: [r1(M[2]), r1(M[5])], shear: r4(shear), matrix: M };
    if (Math.abs(sx - 1) > LIMITS.scale || Math.abs(sy - 1) > LIMITS.scale || shear > LIMITS.shear
        || Math.abs(M[2]) > LIMITS.shift * fullW || Math.abs(M[5]) > LIMITS.shift * fullH) return { aligned: false, reason: "fit out of range", ...out };
    // the gain on the working pixels: the same matrix in working coordinates
    const cwx = c0x, cwy = c0y;
    const Mw = [a00, a01, cwx - a00 * cwx - a01 * cwy + p[4], a10, a11, cwy - a10 * cwx - a11 * cwy + p[5]];
    const before = ringDiff(base, layer, V, ring, w, h, [1, 0, 0, 0, 1, 0]), after = ringDiff(base, layer, V, ring, w, h, Mw);
    if (before == null || after == null) return { aligned: false, reason: "ring too small", ...out };
    out.before = r2(before * 255); out.after = r2(after * 255);
    if (after > before * LIMITS.gain) return { aligned: false, reason: "no gain", ...out };
    return { aligned: true, ...out };
}

/**
 * RGBA bytes `w` x `h` read through `M` (`out(x) = src(M x)`, bilinear, the edge pixels repeated outside), into a new
 * Uint8ClampedArray. Straight alpha is interpolated as it is; a caller with soft alpha warps before applying it.
 */
export function warpRGBA(src, w, h, M) {
    const out = new Uint8ClampedArray(w * h * 4);
    const [a00, a01, tx, a10, a11, ty] = M;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let X = a00 * x + a01 * y + tx, Y = a10 * x + a11 * y + ty;
        X = Math.min(w - 1, Math.max(0, X)); Y = Math.min(h - 1, Math.max(0, Y));
        const x0 = Math.min(w - 2, X | 0), y0 = Math.min(h - 2, Y | 0);
        const fx = w > 1 ? X - x0 : 0, fy = h > 1 ? Y - y0 : 0;
        const j = (Math.max(0, y0) * w + Math.max(0, x0)) * 4, dx = w > 1 ? 4 : 0, dy = h > 1 ? w * 4 : 0, o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
            out[o + c] = (src[j + c] * (1 - fx) + src[j + dx + c] * fx) * (1 - fy) + (src[j + dy + c] * (1 - fx) + src[j + dy + dx + c] * fx) * fy;
        }
    }
    return out;
}

/**
 * The fit of a layer against the composite under it, both as straight-alpha RGBA bytes of the same box (`fullW` x
 * `fullH`, already at the working size `w` x `h` or larger: they are shrunk here when larger). The ring is the layer's
 * own edge: its opaque-enough pixels within `ringWidth` working px (default 6 % of the short side, at least 6) of its
 * transparent part or of the box's border.
 */
export function fitLayerRGBA({ baseRGBA, layerRGBA, w, h, fullW = w, fullH = h, ringWidth = 0 }) {
    const s = workScale(fullW, fullH);
    const tw = Math.max(1, Math.round(fullW * s)), th = Math.max(1, Math.round(fullH * s));
    let base, lay;
    if (w === tw && h === th) { base = grayOf(baseRGBA); lay = { gray: grayOf(layerRGBA), alpha: alphaOf(layerRGBA) }; }
    else { base = shrinkRGBA(baseRGBA, w, h, tw, th).gray; lay = shrinkRGBA(layerRGBA, w, h, tw, th); }
    const valid = new Uint8Array(tw * th);
    for (let i = 0; i < valid.length; i++) valid[i] = lay.alpha[i] >= 0.25 ? 1 : 0;
    const width = ringWidth || Math.max(6, Math.round(0.06 * Math.min(tw, th)));
    const ring = edgeRing(lay.alpha, tw, th, width);
    return fitEdges({ base, layer: lay.gray, ring, valid, w: tw, h: th, fullW, fullH });
}
