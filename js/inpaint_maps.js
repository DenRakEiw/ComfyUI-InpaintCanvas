// Generated from DenRakEiw/scumble renderer/editor/inpaint_maps.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Document-level derived picture maps (depth, guide, sky mask).
// Maps carry a unit-square-to-document-pixels affine transform `xf` and are never resampled on a turn.
// Document maps are immutable in their data; changes or new versions produce a new DocMap.

import { u16Bilinear } from "./inpaint_weights.js";
import { xfInv, xfApply, xfScale, xfMul } from "./inpaint_resample.js";

const snapNum = (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-6 ? r : v; };
export const snapXf = (m) => [m[0], m[1], m[2], m[3], snapNum(m[4]), snapNum(m[5])];

let seq = 0;

/**
 * @typedef {{
 *   kind: string,
 *   w: number,
 *   h: number,
 *   data: Uint16Array,
 *   xf: number[],
 *   meta: object,
 *   ref: { filename: string, subfolder: string, type: string } | null,
 *   version: number,
 *   dataVersion: number
 * }} DocMap
 */

/**
 * Create a new document map.
 * Copies data onto a SharedArrayBuffer when crossOriginIsolated so workers can read it without copying.
 * @param {string} kind
 * @param {number} w
 * @param {number} h
 * @param {ArrayLike<number>} data
 * @param {number[]} [xf]
 * @param {object} [meta]
 * @returns {DocMap}
 */
export function makeMap(kind, w, h, data, xf, meta = {}) {
    const len = (w | 0) * (h | 0);
    let u16;
    if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
        if (data && data.buffer instanceof SharedArrayBuffer) {
            u16 = data;
        } else {
            const sab = new SharedArrayBuffer(len * 2);
            u16 = new Uint16Array(sab);
            if (data) u16.set(data.subarray ? data.subarray(0, len) : data);
        }
    } else {
        u16 = new Uint16Array(len);
        if (data) u16.set(data.subarray ? data.subarray(0, len) : data);
    }
    const defaultXf = [w, 0, 0, h, 0, 0];
    const mapXf = Array.isArray(xf) && xf.length === 6 ? Array.from(xf) : defaultXf;
    const v = ++seq;
    return {
        kind: String(kind || "depth"),
        w: w | 0,
        h: h | 0,
        data: u16,
        xf: mapXf,
        meta: meta ? { ...meta } : {},
        ref: null,
        version: v,
        dataVersion: v,
    };
}

/**
 * Pack a 16-bit map into an opaque RGBA8 canvas:
 * R = high byte (v >> 8), G = low byte (v & 255), B = 0, A = 255.
 * @param {DocMap} map
 * @returns {HTMLCanvasElement}
 */
export function packRG16(map) {
    const w = map.w, h = map.h;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(w, h);
    const d = imgData.data;
    const src = map.data;
    for (let i = 0; i < src.length; i++) {
        const v = src[i];
        const idx = i * 4;
        d[idx] = (v >> 8) & 255;
        d[idx + 1] = v & 255;
        d[idx + 2] = 0;
        d[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

/**
 * Unpack an RGBA8 buffer packed by packRG16 back to a Uint16Array.
 * @param {Uint8Array|Uint8ClampedArray|ImageData} rgba
 * @param {number} w
 * @param {number} h
 * @returns {Uint16Array}
 */
export function unpackRG16(rgba, w, h) {
    const data = rgba && rgba.data ? rgba.data : rgba;
    const len = (w | 0) * (h | 0);
    const out = new Uint16Array(len);
    for (let i = 0; i < len; i++) {
        const idx = i * 4;
        out[i] = (data[idx] << 8) | data[idx + 1];
    }
    return out;
}

/**
 * Returns a sampler value compatible with F7 WebGL upload:
 * Uint8Array viewing map.data's bytes (little-endian: R low byte, G high byte).
 * @param {DocMap} map
 */
export function rg8View(map) {
    return {
        data: new Uint8Array(map.data.buffer, map.data.byteOffset, map.data.byteLength),
        width: map.w,
        height: map.h,
        channels: 2,
        static: true,
        key: `${map.kind}:${map.dataVersion}`,
    };
}

/**
 * Serialize map metadata and reference for persistence.
 * @param {DocMap} map
 */
export function mapToJSON(map) {
    if (!map) return null;
    return {
        ref: map.ref || null,
        w: map.w,
        h: map.h,
        xf: Array.from(map.xf),
        enc: "u16rg",
        meta: map.meta ? JSON.parse(JSON.stringify(map.meta)) : {},
    };
}

/**
 * Deserialize a document map from JSON descriptor by loading its packed image.
 * @param {string} kind
 * @param {object} j
 * @param {(ref: object) => Promise<HTMLImageElement|CanvasImageSource>} loadImage
 * @returns {Promise<DocMap|null>}
 */
export async function mapFromJSON(kind, j, loadImage) {
    if (!j || !j.ref || !j.w || !j.h) return null;
    try {
        const img = await loadImage(j.ref);
        if (!img) return null;
        const canvas = document.createElement("canvas");
        canvas.width = j.w;
        canvas.height = j.h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, j.w, j.h);
        const imgData = ctx.getImageData(0, 0, j.w, j.h);
        const data = unpackRG16(imgData.data, j.w, j.h);
        const map = makeMap(kind, j.w, j.h, data, j.xf, j.meta);
        map.ref = j.ref;
        return map;
    } catch (err) {
        console.warn("mapFromJSON failed:", err);
        return null;
    }
}

/**
 * Compute the affine transform mapping a pass's input pixel at `scale` to map pixel coordinates:
 * S(w, h) * xfInv(xf) * S(1 / scale).
 * In GLSL: u_m0 = vec4(a, c, b, d), u_m1 = vec2(e, f).
 * @param {DocMap} map
 * @param {number} [scale=1]
 * @returns {number[]} 6-element affine matrix [a, b, c, d, e, f]
 */
export function passToMap(map, scale = 1) {
    const sc = scale || 1;
    const sInv = xfScale(1 / sc);
    const inv = xfInv(map.xf);
    const sMap = xfScale(map.w, map.h);
    return snapXf(xfMul(sMap, xfMul(inv, sInv)));
}

/**
 * Sample the map value at document coordinate (docX, docY) using bilinear interpolation and edge clamp.
 * @param {DocMap} map
 * @param {number} docX
 * @param {number} docY
 * @returns {number} Normalized value in 0..1
 */
export function sampleMap(map, docX, docY) {
    if (!map || !map.data || map.w <= 0 || map.h <= 0) return 0;
    const inv = xfInv(map.xf);
    const [ux, uy] = xfApply(inv, docX, docY);
    return u16Bilinear(map.data, map.w, map.h, ux * map.w, uy * map.h);
}

/**
 * Compute a 64 x 64 grey box-averaged fingerprint of an RGBA image, returned as base64 (4,096 bytes).
 * @param {Uint8Array|Uint8ClampedArray|ImageData} rgba
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
export function fingerprint(rgba, w, h) {
    const d = rgba && rgba.data ? rgba.data : rgba;
    const out = new Uint8Array(64 * 64);
    const srcW = w | 0, srcH = h | 0;
    if (!d || srcW <= 0 || srcH <= 0) return "";

    for (let gy = 0; gy < 64; gy++) {
        const y0 = Math.floor(gy * srcH / 64);
        const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * srcH / 64));
        for (let gx = 0; gx < 64; gx++) {
            const x0 = Math.floor(gx * srcW / 64);
            const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * srcW / 64));
            let sumLuma = 0;
            let count = 0;
            for (let y = y0; y < y1; y++) {
                const rowStart = y * srcW * 4;
                for (let x = x0; x < x1; x++) {
                    const idx = rowStart + x * 4;
                    const luma = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
                    sumLuma += luma;
                    count++;
                }
            }
            out[gy * 64 + gx] = count > 0 ? Math.min(255, Math.max(0, Math.round(sumLuma / count))) : 0;
        }
    }

    if (typeof globalThis.Buffer !== "undefined") {
        return globalThis.Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("base64");
    }
    let binary = "";
    for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
    return btoa(binary);
}

/**
 * Compute the mean absolute difference between two fingerprints, in 0..255 units.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function fingerprintDiff(a, b) {
    if (!a || !b) return 255;
    if (a === b) return 0;
    let bytesA, bytesB;
    if (typeof globalThis.Buffer !== "undefined") {
        bytesA = globalThis.Buffer.from(a, "base64");
        bytesB = globalThis.Buffer.from(b, "base64");
    } else {
        const binA = atob(a), binB = atob(b);
        bytesA = new Uint8Array(binA.length);
        for (let i = 0; i < binA.length; i++) bytesA[i] = binA.charCodeAt(i);
        bytesB = new Uint8Array(binB.length);
        for (let i = 0; i < binB.length; i++) bytesB[i] = binB.charCodeAt(i);
    }
    const len = Math.min(bytesA.length, bytesB.length, 4096);
    if (len === 0) return 255;
    let sum = 0;
    for (let i = 0; i < len; i++) {
        sum += Math.abs(bytesA[i] - bytesB[i]);
    }
    return +(sum / len).toFixed(4);
}
