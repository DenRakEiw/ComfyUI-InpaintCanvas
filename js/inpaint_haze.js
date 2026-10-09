// Generated from DenRakEiw/scumble renderer/editor/inpaint_haze.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Dehaze mathematics (Dark Channel Prior, airlight extraction, guided transmission refinement).
// Pure ASCII, no DOM references: runs under plain Node, in Web Workers, and in the renderer.

import { boxBlurs } from "./px/kernels.js";
import { guidedFilter as guidedFilterCore } from "./inpaint_depth.js";
import { LUMA } from "./inpaint_weights.js";

/**
 * Separable 2D min filter with replicated edges using the van Herk / Gil-Werman algorithm.
 * Runs in O(1) operations per pixel independent of radius r.
 *
 * @param {Float32Array} src input float buffer of size w * h
 * @param {number} w width
 * @param {number} h height
 * @param {number} r filter radius (non-negative integer)
 * @returns {Float32Array}
 */
export function minFilter(src, w, h, r) {
    if (w <= 0 || h <= 0) return new Float32Array(0);
    if (r <= 0) return new Float32Array(src);
    const n = w * h;
    const tmp = new Float32Array(n);
    const out = new Float32Array(n);

    const maxDim = Math.max(w, h);
    const K = 2 * r + 1;
    const M = Math.ceil((maxDim + 2 * r) / K) * K;
    const pad = new Float32Array(M);
    const f = new Float32Array(M);
    const g = new Float32Array(M);

    function filter1D(input, inOff, inStride, L, output, outOff, outStride) {
        if (L <= 0) return;
        const x0 = input[inOff];
        const xEnd = input[inOff + (L - 1) * inStride];
        for (let i = 0; i < r; i++) pad[i] = x0;
        if (inStride === 1) {
            pad.set(input.subarray(inOff, inOff + L), r);
        } else {
            for (let i = 0; i < L; i++) pad[r + i] = input[inOff + i * inStride];
        }
        const curM = Math.ceil((L + 2 * r) / K) * K;
        for (let i = r + L; i < curM; i++) pad[i] = xEnd;

        const B = curM / K;
        for (let b = 0; b < B; b++) {
            const start = b * K, end = start + K - 1;
            f[start] = pad[start];
            for (let j = start + 1; j <= end; j++) {
                const pv = pad[j];
                f[j] = pv < f[j - 1] ? pv : f[j - 1];
            }
            g[end] = pad[end];
            for (let j = end - 1; j >= start; j--) {
                const pv = pad[j];
                g[j] = pv < g[j + 1] ? pv : g[j + 1];
            }
        }

        const shift = 2 * r;
        if (outStride === 1) {
            for (let i = 0; i < L; i++) {
                const gv = g[i], fv = f[i + shift];
                output[outOff + i] = gv < fv ? gv : fv;
            }
        } else {
            for (let i = 0; i < L; i++) {
                const gv = g[i], fv = f[i + shift];
                output[outOff + i * outStride] = gv < fv ? gv : fv;
            }
        }
    }

    // Row pass
    for (let y = 0; y < h; y++) {
        filter1D(src, y * w, 1, w, tmp, y * w, 1);
    }
    // Column pass
    for (let x = 0; x < w; x++) {
        filter1D(tmp, x, w, h, out, x, w);
    }
    return out;
}

/**
 * Compute the dark channel prior: minFilter(min_c(I_c / A_c), r).
 *
 * @param {Uint8Array | Uint8ClampedArray} rgba input RGBA8 bytes
 * @param {number} w width
 * @param {number} h height
 * @param {number} r radius
 * @param {[number, number, number]} [A=[1, 1, 1]] airlight color per channel (normalized 0..1)
 * @returns {Float32Array}
 */
export function darkChannel(rgba, w, h, r, A = [1, 1, 1]) {
    if (w <= 0 || h <= 0) return new Float32Array(0);
    const n = w * h;
    const invA0 = 1 / (Math.max(1e-4, A[0]) * 255);
    const invA1 = 1 / (Math.max(1e-4, A[1]) * 255);
    const invA2 = 1 / (Math.max(1e-4, A[2]) * 255);
    const minC = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const off = i * 4;
        const cr = rgba[off] * invA0;
        const cg = rgba[off + 1] * invA1;
        const cb = rgba[off + 2] * invA2;
        minC[i] = cr < cg ? (cr < cb ? cr : cb) : (cg < cb ? cg : cb);
    }
    return minFilter(minC, w, h, r);
}

/**
 * Estimate atmospheric airlight from dark channel:
 * Mean of I over the top max(16, ceil(frac * n)) dark-channel pixels,
 * each channel clamped to [0.2, 1].
 *
 * @param {Uint8Array | Uint8ClampedArray} rgba input RGBA8 bytes
 * @param {Float32Array} dark dark channel values
 * @param {number} w width
 * @param {number} h height
 * @param {number} [frac=0.001] fraction of top pixels
 * @returns {[number, number, number]}
 */
export function airlight(rgba, dark, w, h, frac = 0.001) {
    const n = w * h;
    if (n <= 0) return [0.78, 0.82, 0.86];
    const k = Math.min(n, Math.max(16, Math.ceil(frac * n)));

    const heap = new Int32Array(k);
    let heapSize = 0;

    function push(idx) {
        let i = heapSize++;
        heap[i] = idx;
        const val = dark[idx];
        while (i > 0) {
            const p = (i - 1) >> 1;
            const pIdx = heap[p];
            if (dark[pIdx] <= val) break;
            heap[i] = pIdx;
            i = p;
        }
        heap[i] = idx;
    }

    function replaceRoot(idx) {
        let i = 0;
        const val = dark[idx];
        while (true) {
            let left = (i << 1) + 1;
            if (left >= k) break;
            let right = left + 1;
            let best = (right < k && dark[heap[right]] < dark[heap[left]]) ? right : left;
            if (dark[heap[best]] >= val) break;
            heap[i] = heap[best];
            i = best;
        }
        heap[i] = idx;
    }

    for (let i = 0; i < k; i++) push(i);
    for (let i = k; i < n; i++) {
        if (dark[i] > dark[heap[0]]) replaceRoot(i);
    }

    let sumR = 0, sumG = 0, sumB = 0;
    const inv255 = 1 / 255;
    for (let j = 0; j < k; j++) {
        const off = heap[j] * 4;
        sumR += rgba[off] * inv255;
        sumG += rgba[off + 1] * inv255;
        sumB += rgba[off + 2] * inv255;
    }

    const r = Math.max(0.2, Math.min(1.0, sumR / k));
    const g = Math.max(0.2, Math.min(1.0, sumG / k));
    const b = Math.max(0.2, Math.min(1.0, sumB / k));
    return [r, g, b];
}

/**
 * Grey guided filter using boxBlurs:
 * mean_I = box(I), mean_p = box(p), corr_I = box(I*I), corr_Ip = box(I*p)
 * a = (corr_Ip - mean_I*mean_p) / (corr_I - mean_I^2 + eps)
 * b = mean_p - a*mean_I
 * q = box(a)*I + box(b)
 *
 * @param {Float32Array} I guide image (floats 0..1)
 * @param {Float32Array} p input image to filter (floats 0..1)
 * @param {number} w width
 * @param {number} h height
 * @param {number} r radius in pixels
 * @param {number} eps regularization parameter
 * @returns {Float32Array}
 */
export function guidedFilter(I, p, w, h, r, eps) {
    return guidedFilterCore(I, p, w, h, r, eps, boxBlurs);
}

let dehazeSeqCounter = 0;

/**
 * Whole-picture stats function for Dehaze filter layer.
 * Computes airlight color, quantized transmission map, and guide copy.
 *
 * @param {any} small thumbnail canvas or object with width, height, and data / getContext
 * @param {{ width: number, height: number }} [size]
 * @param {any} [ctx]
 * @returns {{ air: [number, number, number], t: Uint16Array, guide: Uint8Array, w: number, h: number, seq: number }}
 */
export function dehazeStats(small, size, ctx) {
    const sx = small && small.width;
    const sy = small && small.height;
    if (!sx || !sy) {
        return {
            air: [0.78, 0.82, 0.86],
            t: new Uint16Array(1),
            guide: new Uint8Array(4),
            w: 1,
            h: 1,
            seq: ++dehazeSeqCounter,
        };
    }

    let data = null;
    if ("data" in small && small.data) {
        data = small.data;
    } else if (typeof small.getContext === "function") {
        try {
            data = small.getContext("2d").getImageData(0, 0, sx, sy).data;
        } catch (_) {
            return {
                air: [0.78, 0.82, 0.86],
                t: new Uint16Array(1),
                guide: new Uint8Array(4),
                w: 1,
                h: 1,
                seq: ++dehazeSeqCounter,
            };
        }
    }
    if (!data) {
        return {
            air: [0.78, 0.82, 0.86],
            t: new Uint16Array(1),
            guide: new Uint8Array(4),
            w: 1,
            h: 1,
            seq: ++dehazeSeqCounter,
        };
    }

    const n = sx * sy;
    const guide = new Uint8Array(n * 4);
    guide.set(data);
    for (let i = 3; i < guide.length; i += 4) {
        guide[i] = 255;
    }

    const r = Math.max(2, Math.round(0.012 * Math.max(sx, sy)));
    const dark = darkChannel(guide, sx, sy, r);
    const air = airlight(guide, dark, sx, sy, 0.001);
    const darkA = darkChannel(guide, sx, sy, r, air);

    const tRaw = new Float32Array(n);
    const luma = new Float32Array(n);
    const inv255 = 1 / 255;
    const lw0 = LUMA[0], lw1 = LUMA[1], lw2 = LUMA[2];
    for (let i = 0; i < n; i++) {
        tRaw[i] = 1 - 0.95 * darkA[i];
        const off = i * 4;
        luma[i] = (lw0 * guide[off] + lw1 * guide[off + 1] + lw2 * guide[off + 2]) * inv255;
    }

    const tFilt = guidedFilter(luma, tRaw, sx, sy, 4 * r, 1e-3);
    const t = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
        const v = Math.min(1.0, Math.max(0.05, tFilt[i]));
        t[i] = Math.round(v * 65535);
    }

    return {
        air,
        t,
        guide,
        w: sx,
        h: sy,
        seq: ++dehazeSeqCounter,
    };
}
