// Generated from DenRakEiw/scumble renderer/editor/inpaint_edges.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Pure edge mathematics module for snap sampling, detail tile fusion and edge tile detection (R2-S2 / PLAN_NIK9_BUILD sec 3.3)
// Holds JS functions and SNAP_GLSL with identical maths. No DOM at import.

import { u16Bilinear, sstep } from "./inpaint_weights.js";
import { boxBlurs, rangeMax as rangeMaxKernel } from "./px/kernels.js";
import { xfBox } from "./inpaint_resample.js";

/** Default edge snap depth threshold (R2-S3) */
export const SNAP_TAU = 0.02;

/** Default snap strength in UI (R2-D2) */
export const SNAP_DEFAULT = 50;

/**
 * Maps a snap strength (0..100) to [sigmaR, tau], or null when strength is 0.
 * @param {number} strength - Strength 0..100
 * @returns {[number, number] | null}
 */
export function snapParams(strength) {
    const s = Math.max(0, Math.min(100, Number(strength) || 0));
    if (s <= 0) return null;
    const sigmaR = 0.25 + (0.04 - 0.25) * (s / 100);
    return [sigmaR, SNAP_TAU];
}

/**
 * Fetch normalized uint16 depth at (x, y) with clamping.
 * @param {Uint16Array} mapData
 * @param {number} mw
 * @param {number} mh
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function u16At(mapData, mw, mh, x, y) {
    const cx = Math.max(0, Math.min(mw - 1, x));
    const cy = Math.max(0, Math.min(mh - 1, y));
    return mapData[cy * mw + cx] / 65535;
}

/**
 * Fetch guide RGB (0..1) at integer (x, y) with clamping.
 * @param {Uint8Array|Uint8ClampedArray} guideData
 * @param {number} gw
 * @param {number} gh
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number]}
 */
export function snapRgb(guideData, gw, gh, x, y) {
    const cx = Math.max(0, Math.min(gw - 1, x));
    const cy = Math.max(0, Math.min(gh - 1, y));
    const idx = (cy * gw + cx) * 4;
    return [guideData[idx] / 255, guideData[idx + 1] / 255, guideData[idx + 2] / 255];
}

/**
 * Joint bilateral snap of a depth sample guided by full-resolution colour.
 * The JS twin of SNAP_GLSL.
 *
 * @param {{ data: Uint16Array, w: number, h: number }} map
 * @param {{ data: Uint8Array|Uint8ClampedArray, w?: number, h?: number } | Uint8Array|Uint8ClampedArray | null} guide
 * @param {number} mx - Continuous map X pixel coordinate (centre at +0.5)
 * @param {number} my - Continuous map Y pixel coordinate (centre at +0.5)
 * @param {number} r - Reference red colour 0..1
 * @param {number} g - Reference green colour 0..1
 * @param {number} b - Reference blue colour 0..1
 * @param {number} sigmaR - Range standard deviation in colour space (<= 0 falls back to bilinear)
 * @param {number} tau - Depth threshold for edge detection
 * @returns {number} Normalized depth value in 0..1
 */
export function snapField(map, guide, mx, my, r, g, b, sigmaR, tau) {
    const mData = /** @type {Uint16Array} */ (map && map.data ? map.data : map);
    // @ts-ignore
    const mw = map.w, mh = map.h;
    const bil = u16Bilinear(mData, mw, mh, mx, my);
    if (!sigmaR || sigmaR <= 0) return bil;

    const qx = mx - 0.5;
    const qy = my - 0.5;
    const i0x = Math.floor(qx);
    const i0y = Math.floor(qy);

    let lo = 1.0, hi = 0.0;
    for (let j = -1; j <= 2; j++) {
        for (let i = -1; i <= 2; i++) {
            const d = u16At(mData, mw, mh, i0x + i, i0y + j);
            if (d < lo) lo = d;
            if (d > hi) hi = d;
        }
    }

    const k = sstep(tau, 2.0 * tau, hi - lo);
    if (k <= 0) return bil;

    const gData = /** @type {Uint8Array|Uint8ClampedArray|null} */ (guide ? (/** @type {any} */ (guide).data || guide) : null);
    if (!gData) return bil;
    // @ts-ignore
    const gw = (guide && /** @type {any} */ (guide).w) || mw;
    // @ts-ignore
    const gh = (guide && /** @type {any} */ (guide).h) || mh;

    let sw = 0.0, sd = 0.0;
    const inv = 0.5 / (sigmaR * sigmaR);

    for (let j = -1; j <= 2; j++) {
        for (let i = -1; i <= 2; i++) {
            const px = i0x + i;
            const py = i0y + j;
            const ddx = px - qx;
            const ddy = py - qy;
            const [gr, gg, gb] = snapRgb(gData, gw, gh, px, py);
            const er = r - gr;
            const eg = g - gg;
            const eb = b - gb;
            const distSpatial2 = ddx * ddx + ddy * ddy;
            const distColor2 = er * er + eg * eg + eb * eb;
            const w = Math.exp(-0.5 * distSpatial2) * Math.exp(-distColor2 * inv);
            sw += w;
            sd += w * u16At(mData, mw, mh, px, py);
        }
    }

    const val = sw > 1e-6 ? sd / sw : bil;
    return bil + k * (val - bil);
}

/**
 * GLSL functions for edge snap sampling.
 * Needs F7's SAMPLE_GLSL and F3's w_sstep.
 */
export const SNAP_GLSL = `
vec3 snapRgb(sampler2D g, ivec2 p) {
    return texelFetch(g, clamp(p, ivec2(0), textureSize(g, 0) - 1), 0).rgb;
}

float snapField(sampler2D map, sampler2D guide, vec2 mpx, vec3 c, vec2 snap) {
    float bil = u16Bilinear(map, mpx);
    if (snap.x <= 0.0) return bil;
    vec2 q = mpx - 0.5;
    ivec2 i0 = ivec2(floor(q));
    float lo = 1.0, hi = 0.0;
    for (int j = -1; j <= 2; j++) {
        for (int i = -1; i <= 2; i++) {
            float d = u16At(map, i0 + ivec2(i, j));
            lo = min(lo, d);
            hi = max(hi, d);
        }
    }
    float k = w_sstep(snap.y, 2.0 * snap.y, hi - lo);
    if (k <= 0.0) return bil;
    float sw = 0.0, sd = 0.0, inv = 0.5 / (snap.x * snap.x);
    for (int j = -1; j <= 2; j++) {
        for (int i = -1; i <= 2; i++) {
            ivec2 p = i0 + ivec2(i, j);
            vec2 dd = vec2(p) - q;
            vec3 e = c - snapRgb(guide, p);
            float w = exp(-0.5 * dot(dd, dd)) * exp(-dot(e, e) * inv);
            sw += w;
            sd += w * u16At(map, p);
        }
    }
    return mix(bil, sw > 1e-6 ? sd / sw : bil, k);
}
`;

/**
 * Calculates equal bounding boxes for tile splitting in the detail pass.
 * Every tile has the picture's aspect ratio to ensure identical DirectML tensor shape.
 *
 * @param {number} W - Document width
 * @param {number} H - Document height
 * @param {number} grid - 2 for 2x2 or 3 for 3x3
 * @param {number} [overlap=0.25] - Overlap fraction (0..1)
 * @returns {Array<{ x0: number, y0: number, x1: number, y1: number }>}
 */
export function tileBoxes(W, H, grid, overlap = 0.25) {
    const g = Math.max(1, Math.round(grid) || 2);
    if (g === 1) return [{ x0: 0, y0: 0, x1: W, y1: H }];
    const Tw = Math.round(W / (g - (g - 1) * overlap));
    const Th = Math.round(H / (g - (g - 1) * overlap));
    const boxes = [];
    for (let j = 0; j < g; j++) {
        const y0 = Math.round(j * (H - Th) / (g - 1));
        const y1 = y0 + Th;
        for (let i = 0; i < g; i++) {
            const x0 = Math.round(i * (W - Tw) / (g - 1));
            const x1 = x0 + Tw;
            boxes.push({ x0, y0, x1, y1 });
        }
    }
    return boxes;
}

/**
 * Target dimensions [wf, hf] for the fused depth grid.
 *
 * @param {number} W - Document width
 * @param {number} H - Document height
 * @param {Array<{ x0: number, y0: number, x1: number, y1: number }>} boxes - Tile boxes
 * @param {number} [modelShort=518] - Model short side
 * @returns {[number, number]}
 */
export function fusedSize(W, H, boxes, modelShort = 518) {
    const Tw = boxes && boxes.length ? (boxes[0].x1 - boxes[0].x0) : W;
    const Th = boxes && boxes.length ? (boxes[0].y1 - boxes[0].y0) : H;
    const sf = Math.min(1, modelShort / Math.min(Tw, Th));
    let wf = Math.round(W * sf);
    let hf = Math.round(H * sf);
    const maxDim = Math.max(wf, hf);
    if (maxDim > 4096) {
        const cap = 4096 / maxDim;
        wf = Math.round(wf * cap);
        hf = Math.round(hf * cap);
    }
    return [Math.max(1, wf), Math.max(1, hf)];
}

/**
 * Robust least-squares scale and shift fit: a * t + b ~ g.
 * Drops residuals above the 90th percentile in a second pass.
 *
 * @param {Float32Array|number[]} t - Input tile values
 * @param {Float32Array|number[]} g - Target global values
 * @param {number} n - Number of elements
 * @param {Uint8Array|boolean[]|null} [mask=null] - Optional inclusion mask
 * @returns {{ a: number, b: number, r2: number, used: number }}
 */
export function fitScaleShift(t, g, n, mask = null) {
    let sumT = 0, sumG = 0, count = 0;
    for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        sumT += t[i];
        sumG += g[i];
        count++;
    }
    if (count < 2) return { a: 1, b: 0, r2: 0, used: count };

    const meanT = sumT / count;
    const meanG = sumG / count;

    let sTT = 0, sTG = 0, sGG = 0;
    for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        const dt = t[i] - meanT;
        const dg = g[i] - meanG;
        sTT += dt * dt;
        sTG += dt * dg;
        sGG += dg * dg;
    }

    if (sTT < 1e-12) return { a: 0, b: meanG, r2: 0, used: count };

    let a = sTG / sTT;
    let b = meanG - a * meanT;

    // Second pass: drop residuals above the 90th percentile
    const res = new Float32Array(count);
    let rIdx = 0;
    for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        res[rIdx++] = Math.abs(g[i] - (a * t[i] + b));
    }
    res.sort();
    const p90 = res[Math.min(count - 1, Math.floor(0.9 * count))];

    let sumT2 = 0, sumG2 = 0, count2 = 0;
    for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) continue;
        const r = Math.abs(g[i] - (a * t[i] + b));
        if (r <= p90) {
            sumT2 += t[i];
            sumG2 += g[i];
            count2++;
        }
    }

    if (count2 >= 2) {
        const meanT2 = sumT2 / count2;
        const meanG2 = sumG2 / count2;
        let sTT2 = 0, sTG2 = 0, sGG2 = 0;
        for (let i = 0; i < n; i++) {
            if (mask && !mask[i]) continue;
            const r = Math.abs(g[i] - (a * t[i] + b));
            if (r <= p90) {
                const dt = t[i] - meanT2;
                const dg = g[i] - meanG2;
                sTT2 += dt * dt;
                sTG2 += dt * dg;
                sGG2 += dg * dg;
            }
        }
        if (sTT2 >= 1e-12) {
            a = sTG2 / sTT2;
            b = meanG2 - a * meanT2;
            const r2 = (sTT2 > 0 && sGG2 > 0) ? Math.max(0, Math.min(1, (sTG2 * sTG2) / (sTT2 * sGG2))) : 0;
            return { a, b, r2, used: count2 };
        }
    }

    const r2 = (sTT > 0 && sGG > 0) ? Math.max(0, Math.min(1, (sTG * sTG) / (sTT * sGG))) : 0;
    return { a, b, r2, used: count };
}

/**
 * Three box radii approximating Gaussian blur (Peter Kovesi's method).
 * @param {number} sigma - Standard deviation
 * @returns {[number, number, number]}
 */
export function gaussRadii(sigma) {
    if (sigma <= 0) return [0, 0, 0];
    const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
    const mm = Math.round(mIdeal);
    const r0 = ((0 < mm ? wl : wu) - 1) / 2;
    const r1 = ((1 < mm ? wl : wu) - 1) / 2;
    const r2 = ((2 < mm ? wl : wu) - 1) / 2;
    return [r0, r1, r2];
}

/**
 * Gaussian blur of a single-channel float buffer using Kovesi box blurs with clamped edges.
 * @param {Float32Array} data
 * @param {number} w
 * @param {number} h
 * @param {number} sigma
 * @returns {Float32Array}
 */
export function gaussBlur(data, w, h, sigma) {
    if (sigma <= 0) return data instanceof Float32Array ? data.slice() : new Float32Array(data);
    const radii = gaussRadii(sigma);
    return boxBlurs(data, w, h, radii);
}

/**
 * Resamples single-channel Float32Array data using bilinear interpolation.
 * @param {Float32Array} srcData
 * @param {number} sw
 * @param {number} sh
 * @param {Float32Array} dstData
 * @param {number} dw
 * @param {number} dh
 * @returns {Float32Array}
 */
function resampleBilinearF32(srcData, sw, sh, dstData, dw, dh) {
    const scaleX = sw / dw;
    const scaleY = sh / dh;
    for (let dy = 0; dy < dh; dy++) {
        const sy = (dy + 0.5) * scaleY - 0.5;
        const y0 = Math.floor(sy);
        const y1 = y0 + 1;
        const fy = sy - y0;
        const cy0 = Math.max(0, Math.min(sh - 1, y0));
        const cy1 = Math.max(0, Math.min(sh - 1, y1));
        const row0 = cy0 * sw;
        const row1 = cy1 * sw;
        const dRow = dy * dw;
        for (let dx = 0; dx < dw; dx++) {
            const sx = (dx + 0.5) * scaleX - 0.5;
            const x0 = Math.floor(sx);
            const x1 = x0 + 1;
            const fx = sx - x0;
            const cx0 = Math.max(0, Math.min(sw - 1, x0));
            const cx1 = Math.max(0, Math.min(sw - 1, x1));
            const s00 = srcData[row0 + cx0];
            const s10 = srcData[row0 + cx1];
            const s01 = srcData[row1 + cx0];
            const s11 = srcData[row1 + cx1];
            const top = s00 + fx * (s10 - s00);
            const bot = s01 + fx * (s11 - s01);
            dstData[dRow + dx] = top + fy * (bot - top);
        }
    }
    return dstData;
}

/**
 * Fuses global depth pass and detail tiles into a single coherent high-resolution depth map.
 *
 * @param {{ data: Float32Array, w: number, h: number }} global - Coarse global pass
 * @param {Array<{ box: { x0: number, y0: number, x1: number, y1: number }, data: Float32Array, w: number, h: number }>} tiles - Detail tiles
 * @param {number} W - Original document width
 * @param {number} H - Original document height
 * @param {number} wf - Fused width
 * @param {number} hf - Fused height
 * @param {{ sigmaLow?: number }} [opts]
 * @returns {{ data: Float32Array, fits: Array<{ a: number, b: number, r2: number, dropped: boolean }> }}
 */
export function fuseTiles(global, tiles, W, H, wf, hf, { sigmaLow } = {}) {
    const sf = wf / W;
    const sg = global.w / W;
    const sLow = sigmaLow != null ? sigmaLow : 1.5 * (sf / sg);

    // Gf = bilinear(global -> wf x hf)
    const Gf = new Float32Array(wf * hf);
    resampleBilinearF32(global.data, global.w, global.h, Gf, wf, hf);

    // Gf_low = gauss(Gf, sigmaLow)
    const Gf_low = gaussBlur(Gf, wf, hf, sLow);

    const sumWHi = new Float32Array(wf * hf);
    const sumW = new Float32Array(wf * hf);
    const fits = [];

    for (let tIdx = 0; tIdx < tiles.length; tIdx++) {
        const tile = tiles[tIdx];
        const bx0 = Math.round(tile.box.x0 * sf);
        const by0 = Math.round(tile.box.y0 * sf);
        const bx1 = Math.round(tile.box.x1 * sf);
        const by1 = Math.round(tile.box.y1 * sf);
        const bw = bx1 - bx0;
        const bh = by1 - by0;

        if (bw <= 0 || bh <= 0) {
            fits.push({ a: 1, b: 0, r2: 0, dropped: true });
            continue;
        }

        // Ti = bilinear(tile -> its box on the fused grid)
        const Ti = new Float32Array(bw * bh);
        resampleBilinearF32(tile.data, tile.w, tile.h, Ti, bw, bh);

        // Gi from Gf
        const Gi = new Float32Array(bw * bh);
        for (let y = 0; y < bh; y++) {
            const gRow = (by0 + y) * wf;
            const iRow = y * bw;
            for (let x = 0; x < bw; x++) {
                Gi[iRow + x] = Gf[gRow + (bx0 + x)];
            }
        }

        // fit on gauss(Ti, sigmaLow) against Gf
        const Ti_low = gaussBlur(Ti, bw, bh, sLow);
        const fit = fitScaleShift(Ti_low, Gi, bw * bh);

        const dropped = fit.a <= 0 || fit.r2 < 0.5;
        fits.push({ a: fit.a, b: fit.b, r2: fit.r2, dropped });

        if (dropped) continue;

        // Hi = (a*Ti + b) - gauss(a*Ti + b, sigmaLow)
        const a = fit.a, b = fit.b;
        const Ti_scaled = new Float32Array(bw * bh);
        for (let k = 0; k < bw * bh; k++) {
            Ti_scaled[k] = a * Ti[k] + b;
        }
        const Ti_scaled_low = gaussBlur(Ti_scaled, bw, bh, sLow);

        // Raised cosine overlap weights
        // Find overlap with adjacent tiles in doc space
        let oxLeft = 0, oxRight = 0, oyTop = 0, oyBot = 0;
        for (let oIdx = 0; oIdx < tiles.length; oIdx++) {
            if (oIdx === tIdx) continue;
            const ob = tiles[oIdx].box;
            // Overlapping in Y?
            if (ob.y0 < tile.box.y1 && ob.y1 > tile.box.y0) {
                if (ob.x0 < tile.box.x0 && ob.x1 > tile.box.x0) {
                    oxLeft = Math.max(oxLeft, Math.round((ob.x1 - tile.box.x0) * sf));
                }
                if (ob.x1 > tile.box.x1 && ob.x0 < tile.box.x1) {
                    oxRight = Math.max(oxRight, Math.round((tile.box.x1 - ob.x0) * sf));
                }
            }
            // Overlapping in X?
            if (ob.x0 < tile.box.x1 && ob.x1 > tile.box.x0) {
                if (ob.y0 < tile.box.y0 && ob.y1 > tile.box.y0) {
                    oyTop = Math.max(oyTop, Math.round((ob.y1 - tile.box.y0) * sf));
                }
                if (ob.y1 > tile.box.y1 && ob.y0 < tile.box.y1) {
                    oyBot = Math.max(oyBot, Math.round((tile.box.y1 - ob.y0) * sf));
                }
            }
        }

        const rampX = new Float32Array(bw);
        for (let x = 0; x < bw; x++) {
            let wx = 1.0;
            if (oxLeft > 0 && x < oxLeft) {
                wx = Math.min(wx, 0.5 * (1 - Math.cos((Math.PI * (x + 0.5)) / oxLeft)));
            }
            if (oxRight > 0 && x >= bw - oxRight) {
                const dist = bw - 0.5 - x;
                wx = Math.min(wx, 0.5 * (1 - Math.cos((Math.PI * dist) / oxRight)));
            }
            rampX[x] = wx;
        }

        const rampY = new Float32Array(bh);
        for (let y = 0; y < bh; y++) {
            let wy = 1.0;
            if (oyTop > 0 && y < oyTop) {
                wy = Math.min(wy, 0.5 * (1 - Math.cos((Math.PI * (y + 0.5)) / oyTop)));
            }
            if (oyBot > 0 && y >= bh - oyBot) {
                const dist = bh - 0.5 - y;
                wy = Math.min(wy, 0.5 * (1 - Math.cos((Math.PI * dist) / oyBot)));
            }
            rampY[y] = wy;
        }

        for (let y = 0; y < bh; y++) {
            const wy = rampY[y];
            const gRow = (by0 + y) * wf;
            const iRow = y * bw;
            for (let x = 0; x < bw; x++) {
                const w = rampX[x] * wy;
                const hi = Ti_scaled[iRow + x] - Ti_scaled_low[iRow + x];
                sumWHi[gRow + bx0 + x] += w * hi;
                sumW[gRow + bx0 + x] += w;
            }
        }
    }

    // out = gauss(Gf, sigmaLow) + sum(w * Hi) / max(sum(w), 1e-6)
    const out = new Float32Array(wf * hf);
    for (let i = 0; i < wf * hf; i++) {
        const w = sumW[i];
        const detail = w > 1e-6 ? sumWHi[i] / w : 0;
        out[i] = Gf_low[i] + detail;
    }
    return { data: out, fits };
}

/**
 * Computes max - min over each texel's 4x4 block (separable).
 * Used as cached input for edgeTiles.
 *
 * @param {{ data: Uint16Array, w: number, h: number }} map
 * @returns {Uint16Array}
 */
export function rangeMax(map) {
    if (!map || !map.data || !map.w || !map.h) return new Uint16Array(0);
    return rangeMaxKernel(map.data, map.w, map.h);
}

/**
 * Flags 256x256 document tiles that cross significant depth edges.
 *
 * @param {{ data: Uint16Array, w: number, h: number }} map - Depth map
 * @param {Uint16Array|{ data: Uint16Array }} rmax - Precomputed rangeMax buffer
 * @param {number[]|null} xfInvToMap - Doc px -> map px affine transform (or null)
 * @param {number} W - Document width
 * @param {number} H - Document height
 * @param {number} tau - Threshold fraction (e.g. 0.02)
 * @param {number} [tile=256] - Tile size in document pixels
 * @returns {Uint8Array}
 */
export function edgeTiles(map, rmax, xfInvToMap, W, H, tau, tile = 256) {
    const cols = Math.ceil(W / tile);
    const rows = Math.ceil(H / tile);
    const out = new Uint8Array(cols * rows);
    const thresh = Math.round(tau * 65535);
    const mw = map.w, mh = map.h;
    // @ts-ignore
    const rData = rmax.data || rmax;

    const xf = xfInvToMap || [mw / W, 0, 0, mh / H, 0, 0];

    for (let ty = 0; ty < rows; ty++) {
        const y0 = ty * tile;
        const y1 = Math.min(H, (ty + 1) * tile);
        for (let tx = 0; tx < cols; tx++) {
            const x0 = tx * tile;
            const x1 = Math.min(W, (tx + 1) * tile);

            const [mx0, my0, mx1, my1] = xfBox(xf, x0, y0, x1, y1);
            // plus 2 texels
            const ix0 = Math.max(0, Math.floor(mx0 - 2));
            const iy0 = Math.max(0, Math.floor(my0 - 2));
            const ix1 = Math.min(mw - 1, Math.ceil(mx1 + 2));
            const iy1 = Math.min(mh - 1, Math.ceil(my1 + 2));

            let hasEdge = false;
            for (let my = iy0; my <= iy1 && !hasEdge; my++) {
                const row = my * mw;
                for (let mx = ix0; mx <= ix1; mx++) {
                    if (rData[row + mx] > thresh) {
                        hasEdge = true;
                        break;
                    }
                }
            }
            if (hasEdge) {
                out[ty * cols + tx] = 1;
            }
        }
    }
    return out;
}
