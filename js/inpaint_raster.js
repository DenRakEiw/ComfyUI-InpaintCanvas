// Generated from DenRakEiw/scumble renderer/editor/inpaint_raster.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Raster helpers shared by the editor's tools: flood fill / magic wand region
 * growing, colour parsing, mask-to-canvas. Pure functions on typed arrays, no
 * DOM state, kept out of inpaint_canvas.js so the tools stay small.
 */
import { distTransform, rustPx, releaseIfLarge } from "./px/kernels.js";

/** A 2D canvas in the window or in a worker. */
export function makeRasterCanvas(w, h) {
    const width = Math.max(1, w | 0), height = Math.max(1, h | 0);
    if (typeof document === "undefined") return new OffscreenCanvas(width, height);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
}

/**
 * Exact euclidean distance transform (Felzenszwalb / Huttenlocher): squared distance of
 * every pixel to the nearest set pixel of `feature`. Grow and shrink of the selection use
 * it, in the editor and in the worker.
 */
export function distanceTransform(feature, W, H) {
    const INF = 1e20;
    const f = new Float32Array(Math.max(W, H));
    const d = new Float32Array(Math.max(W, H));
    const v = new Int32Array(Math.max(W, H));
    const z = new Float32Array(Math.max(W, H) + 1);
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = feature[i] ? 0 : INF;
    const edt1d = (n) => {
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < n; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    };
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) f[y] = out[y * W + x];
        edt1d(H);
        for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) f[x] = out[y * W + x];
        edt1d(W);
        for (let x = 0; x < W; x++) out[y * W + x] = d[x];
    }
    return out;
}

/** Bounding box of the selected pixels ([x0, y0, x1, y1], right and bottom exclusive), or null. */
export function maskBounds(d, W, H) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            if (d[(row + x) * 4 + 3] <= 127) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// one RGBA word of "red, fully transparent", whatever the platform's byte order is
const RED_CLEAR = (() => {
    const b = new Uint8Array(4);
    b[0] = 255; b[1] = 0; b[2] = 0; b[3] = 0;
    return new Uint32Array(b.buffer)[0];
})();

/**
 * The selection after growing (n > 0) or shrinking (n < 0) by n pixels, as RGBA bytes in
 * place: red where selected, transparent elsewhere, hard edges like Photoshop's Expand.
 * Only pixels within n of the selection's edge can change, so the distance transform runs
 * on its bounding box padded by n rather than on the whole image (3 s to under 1 s on a
 * 96 MP document with a selection covering a fifth of it).
 *
 * The distance transform is the tile engine's kernel (`distTransform` in px/kernels.js: Rust when
 * it has loaded, else the JS twin; the same f32 values as `distanceTransform` above in less than
 * half the time); `dist` replaces it with another of the same signature, and `ms`, when given,
 * collects the milliseconds of each part.
 */
export function growMask(d, W, H, n, { dist = distTransform, ms = null } = {}) {
    const grow = n > 0;
    const r = Math.abs(n);
    let t = ms ? performance.now() : 0;
    const lap = (key) => { if (!ms) return; const now = performance.now(); ms[key] = (ms[key] || 0) + now - t; t = now; };
    const box = maskBounds(d, W, H);
    lap("bounds");
    const words = new Uint32Array(d.buffer, d.byteOffset, W * H);
    if (!box) {
        words.fill(RED_CLEAR);   // nothing selected: nothing to grow, nothing left to shrink
        return d;
    }
    const pad = r + 2;
    const bx0 = Math.max(0, box[0] - pad), by0 = Math.max(0, box[1] - pad);
    const bx1 = Math.min(W, box[2] + pad), by1 = Math.min(H, box[3] + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    const feature = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        const src = (by0 + y) * W + bx0, dst = y * bw;
        for (let x = 0; x < bw; x++) {
            const sel = d[(src + x) * 4 + 3] > 127;
            feature[dst + x] = grow ? (sel ? 1 : 0) : (sel ? 0 : 1);
        }
    }
    lap("feature");
    const dsq = dist(feature, bw, bh);
    lap("edt");
    const r2 = r * r;
    words.fill(RED_CLEAR);
    for (let y = 0; y < bh; y++) {
        const dst = (by0 + y) * W + bx0, row = y * bw;
        for (let x = 0; x < bw; x++) {
            const inside = grow ? dsq[row + x] <= r2 : dsq[row + x] > r2;
            if (inside) d[(dst + x) * 4 + 3] = 255;
        }
    }
    lap("write");
    return d;
}

/**
 * `growMask` and the bounds of its result, in one pass through the Rust kernel when it has loaded (the scans around
 * the distance transform run there too); `ms.kernel` collects its time.
 */
export function growMaskBounds(d, W, H, n, { ms = null } = {}) {
    const p = rustPx();
    if (p) {
        const t = ms ? performance.now() : 0;
        try { return p.growMask(d, W, H, n); } finally { if (ms) ms.kernel = (ms.kernel || 0) + performance.now() - t; releaseIfLarge(); }
    }
    growMask(d, W, H, n, { ms });
    const t = ms ? performance.now() : 0;
    const bounds = maskBounds(d, W, H);
    if (ms) ms.resultBounds = (ms.resultBounds || 0) + performance.now() - t;
    return bounds;
}

/** Invert a selection in place (red where selected, alpha flipped). */
export function invertMask(d) {
    for (let i = 0; i < d.length; i += 4) {
        d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
        d[i + 3] = 255 - d[i + 3];
    }
    return d;
}

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/**
 * Region of pixels similar to the one at (sx, sy): a Uint8Array (1 = inside)
 * over a W×H RGBA buffer. `tolerance` is the largest per-channel difference
 * (0..255, alpha included); `contiguous` grows a 4-connected region from the
 * seed with a scanline fill, otherwise every similar pixel of the buffer
 * counts (Photoshop's "contiguous" checkbox).
 *
 * The Rust flood (px/kernels.js) runs when it has loaded: the same mask, 1.3 to 1.4× faster on a
 * whole 15k picture (docs/PERFORMANCE.md §12). The JS below is the fallback, and faster than
 * the flood twin in px/kernels_js.js.
 */
export function floodMask(data, W, H, sx, sy, tolerance = 32, contiguous = true) {
    const p = rustPx();
    if (p) {
        try { return p.flood(data, W, H, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous); } finally { releaseIfLarge(); }
    }
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

/** Draw a W×H mask (1 = set) as `color` (hex) into a new canvas; alpha from the mask. */
export function maskToColorCanvas(mask, W, H, color) {
    const c = makeRasterCanvas(W, H);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const [r, g, b] = hexToRgb(color);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (!mask[p]) continue;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

/** Intersect a region mask with a selection canvas (alpha > 127 = selected) in place. */
export function clipMaskToSelection(mask, selection) {
    const W = selection.width, H = selection.height;
    const s = selection.getContext("2d").getImageData(0, 0, W, H).data;
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) if (s[i] < 128) mask[p] = 0;
    return mask;
}

/**
 * The mask of a clipped layer in a stack composited from tiles (docs/PLAN_0_1_31.md §6 step 3), in place in `cov`: the
 * base's alpha bytes there (`cov`, one a pixel) through the base's mask (`baseMask`, the same, or null) at the base's
 * opacity (`alpha`, 0..255), times the layer's own mask (`own`, or null). Rounded as the compositing kernel's mul255;
 * the kernel then takes it as the layer's coverage, which is what a mask is.
 */
export function clipCoverage(cov, baseMask, alpha, own) {
    const n = cov.length;
    if (baseMask) for (let i = 0; i < n; i++) cov[i] = mul255(cov[i], baseMask[i]);
    if (alpha < 255) for (let i = 0; i < n; i++) cov[i] = mul255(cov[i], alpha);
    if (own) for (let i = 0; i < n; i++) cov[i] = mul255(cov[i], own[i]);
    return cov;
}

export const SEL_MODES = ["replace", "add", "subtract", "intersect"];

/** Exact integer formula for round(x * y / 255): matches the tile compositing kernel and Skia. */
export const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };

/** Combine an existing selection alpha `a` with a new weight `w` (both 0..255) under `mode`. */
export function combineAlpha(a, w, mode) {
    if (mode === "replace") return w;
    if (mode === "add") return a + w - mul255(a, w);
    if (mode === "subtract") return Math.max(0, a - mul255(a, w));
    if (mode === "intersect") return mul255(a, w);
    return w;
}

/**
 * Combine a rectangle of RGBA8 pixels (`dst`) with an alpha source buffer (`src`) under `mode`.
 * Transparent pixels (a = 0) are cleared to [0, 0, 0, 0] so canvas and tiles agree byte for byte.
 */
export function combineRows(dst, dOff, dStride, src, sOff, sStride, w, h, mode, color) {
    const [cr, cg, cb] = color;
    if (mode === "replace") {
        for (let y = 0; y < h; y++) {
            let dp = dOff + y * dStride;
            let sp = sOff + y * sStride;
            for (let x = 0; x < w; x++, dp += 4, sp++) {
                const a = src[sp];
                if (a) {
                    dst[dp] = cr;
                    dst[dp + 1] = cg;
                    dst[dp + 2] = cb;
                    dst[dp + 3] = a;
                } else {
                    dst[dp] = 0;
                    dst[dp + 1] = 0;
                    dst[dp + 2] = 0;
                    dst[dp + 3] = 0;
                }
            }
        }
    } else if (mode === "add") {
        for (let y = 0; y < h; y++) {
            let dp = dOff + y * dStride;
            let sp = sOff + y * sStride;
            for (let x = 0; x < w; x++, dp += 4, sp++) {
                const da = dst[dp + 3];
                const sa = src[sp];
                const a = da + sa - mul255(da, sa);
                if (a) {
                    dst[dp] = cr;
                    dst[dp + 1] = cg;
                    dst[dp + 2] = cb;
                    dst[dp + 3] = a;
                } else {
                    dst[dp] = 0;
                    dst[dp + 1] = 0;
                    dst[dp + 2] = 0;
                    dst[dp + 3] = 0;
                }
            }
        }
    } else if (mode === "subtract") {
        for (let y = 0; y < h; y++) {
            let dp = dOff + y * dStride;
            let sp = sOff + y * sStride;
            for (let x = 0; x < w; x++, dp += 4, sp++) {
                const da = dst[dp + 3];
                const sa = src[sp];
                const a = Math.max(0, da - mul255(da, sa));
                if (a) {
                    dst[dp] = cr;
                    dst[dp + 1] = cg;
                    dst[dp + 2] = cb;
                    dst[dp + 3] = a;
                } else {
                    dst[dp] = 0;
                    dst[dp + 1] = 0;
                    dst[dp + 2] = 0;
                    dst[dp + 3] = 0;
                }
            }
        }
    } else if (mode === "intersect") {
        for (let y = 0; y < h; y++) {
            let dp = dOff + y * dStride;
            let sp = sOff + y * sStride;
            for (let x = 0; x < w; x++, dp += 4, sp++) {
                const da = dst[dp + 3];
                const sa = src[sp];
                const a = mul255(da, sa);
                if (a) {
                    dst[dp] = cr;
                    dst[dp + 1] = cg;
                    dst[dp + 2] = cb;
                    dst[dp + 3] = a;
                } else {
                    dst[dp] = 0;
                    dst[dp + 1] = 0;
                    dst[dp + 2] = 0;
                    dst[dp + 3] = 0;
                }
            }
        }
    }
}

/** Determine selection mode from keyboard event modifiers: Shift+Alt -> intersect, Alt -> subtract, Shift -> add. */
export function selModeOf(e, fallback = "replace") {
    if (!e) return fallback;
    const shift = !!e.shiftKey, alt = !!e.altKey;
    if (shift && alt) return "intersect";
    if (alt) return "subtract";
    if (shift) return "add";
    return fallback;
}

/** Global composite operation and outside-clearing behavior for a selection mode. */
export function selectionGco(mode) {
    switch (mode) {
        case "subtract":
            return { op: "destination-out", clearOutside: false };
        case "intersect":
            return { op: "destination-in", clearOutside: true };
        case "add":
            return { op: "source-over", clearOutside: false };
        case "replace":
        default:
            return { op: "source-over", clearOutside: true };
    }
}

/**
 * An AlphaSource covering a rectangle with full alpha (255).
 * @param {number[]} box [x0, y0, x1, y1]
 * @returns {{ box: number[], read(rx: number, ry: number, rw: number, rh: number): Uint8Array }}
 */
export function rectSource(box) {
    const b = [box[0] | 0, box[1] | 0, box[2] | 0, box[3] | 0];
    const [bx0, by0, bx1, by1] = b;
    return {
        box: b,
        read(rx, ry, rw, rh) {
            const out = new Uint8Array(rw * rh);
            const ix0 = Math.max(rx, bx0), iy0 = Math.max(ry, by0);
            const ix1 = Math.min(rx + rw, bx1), iy1 = Math.min(ry + rh, by1);
            if (ix0 < ix1 && iy0 < iy1) {
                const fillW = ix1 - ix0;
                for (let y = iy0; y < iy1; y++) {
                    const o = (y - ry) * rw + (ix0 - rx);
                    out.fill(255, o, o + fillW);
                }
            }
            return out;
        }
    };
}

/**
 * An AlphaSource reading from a contiguous w * h Uint8Array of alpha bytes placed at (x0, y0).
 * @returns {{ box: number[], read(rx: number, ry: number, rw: number, rh: number): Uint8Array }}
 */
export function bytesSource(alpha, x0, y0, w, h) {
    const box = [x0 | 0, y0 | 0, (x0 + w) | 0, (y0 + h) | 0];
    return {
        box,
        read(rx, ry, rw, rh) {
            const out = new Uint8Array(rw * rh);
            const ix0 = Math.max(rx, x0), iy0 = Math.max(ry, y0);
            const ix1 = Math.min(rx + rw, x0 + w), iy1 = Math.min(ry + rh, y0 + h);
            if (ix0 < ix1 && iy0 < iy1) {
                const copyW = ix1 - ix0;
                for (let y = iy0; y < iy1; y++) {
                    const srcOff = (y - y0) * w + (ix0 - x0);
                    const dstOff = (y - ry) * rw + (ix0 - rx);
                    out.set(alpha.subarray(srcOff, srcOff + copyW), dstOff);
                }
            }
            return out;
        }
    };
}

/**
 * An AlphaSource reading from a collection of 256x256 tiles.
 * Supports {tx, ty, data: RGBA 256*256*4}, {tx, ty, alpha: Uint8Array(65536)}, {tx, ty, full: true}, {tx, ty, empty: true}.
 * `full` reads as 255 without an allocation.
 * @param {Array|Map|Set} tiles
 * @param {number[]} [at=[0,0]] tile 0,0 origin [x, y]
 * @param {number[]} [box=null] bounding box [x0, y0, x1, y1]
 * @returns {{ box: number[], read(rx: number, ry: number, rw: number, rh: number): Uint8Array }}
 */
export function tilesSource(tiles, at = [0, 0], box = null) {
    const [ox, oy] = at;
    const tileMap = new Map();
    let computedBox = null;
    const iter = (tiles && typeof tiles.values === "function") ? tiles.values() : (tiles || []);
    for (const t of iter) {
        const key = `${t.tx},${t.ty}`;
        tileMap.set(key, t);
        if (!box && !t.empty) {
            const x0 = ox + t.tx * 256, y0 = oy + t.ty * 256;
            const x1 = x0 + 256, y1 = y0 + 256;
            if (!computedBox) computedBox = [x0, y0, x1, y1];
            else {
                computedBox[0] = Math.min(computedBox[0], x0);
                computedBox[1] = Math.min(computedBox[1], y0);
                computedBox[2] = Math.max(computedBox[2], x1);
                computedBox[3] = Math.max(computedBox[3], y1);
            }
        }
    }
    const b = box ? [box[0] | 0, box[1] | 0, box[2] | 0, box[3] | 0] : (computedBox || [ox, oy, ox, oy]);
    return {
        box: b,
        read(rx, ry, rw, rh) {
            const out = new Uint8Array(rw * rh);
            const tx0 = Math.floor((rx - ox) / 256);
            const ty0 = Math.floor((ry - oy) / 256);
            const tx1 = Math.floor((rx + rw - 1 - ox) / 256);
            const ty1 = Math.floor((ry + rh - 1 - oy) / 256);
            for (let ty = ty0; ty <= ty1; ty++) {
                const tileY = oy + ty * 256;
                for (let tx = tx0; tx <= tx1; tx++) {
                    const t = tileMap.get(`${tx},${ty}`);
                    if (!t || t.empty) continue;
                    const tileX = ox + tx * 256;
                    const ix0 = Math.max(rx, tileX), iy0 = Math.max(ry, tileY);
                    const ix1 = Math.min(rx + rw, tileX + 256), iy1 = Math.min(ry + rh, tileY + 256);
                    if (ix0 >= ix1 || iy0 >= iy1) continue;
                    const copyW = ix1 - ix0;
                    if (t.full) {
                        for (let y = iy0; y < iy1; y++) {
                            const dstOff = (y - ry) * rw + (ix0 - rx);
                            out.fill(255, dstOff, dstOff + copyW);
                        }
                    } else if (t.alpha) {
                        const a = t.alpha instanceof ArrayBuffer ? new Uint8Array(t.alpha) : t.alpha;
                        for (let y = iy0; y < iy1; y++) {
                            const srcOff = (y - tileY) * 256 + (ix0 - tileX);
                            const dstOff = (y - ry) * rw + (ix0 - rx);
                            out.set(a.subarray(srcOff, srcOff + copyW), dstOff);
                        }
                    } else if (t.data) {
                        const d = t.data instanceof ArrayBuffer ? new Uint8ClampedArray(t.data)
                            : (ArrayBuffer.isView(t.data) ? t.data : new Uint8ClampedArray(t.data));
                        for (let y = iy0; y < iy1; y++) {
                            let srcOff = ((y - tileY) * 256 + (ix0 - tileX)) * 4 + 3;
                            let dstOff = (y - ry) * rw + (ix0 - rx);
                            for (let x = 0; x < copyW; x++, srcOff += 4, dstOff++) {
                                out[dstOff] = d[srcOff];
                            }
                        }
                    }
                }
            }
            return out;
        }
    };
}

