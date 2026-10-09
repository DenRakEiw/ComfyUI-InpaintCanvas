// Generated from DenRakEiw/scumble renderer/editor/inpaint_maps.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Document-level derived picture maps (depth, guide, sky mask).
// Maps carry a unit-square-to-document-pixels affine transform `xf` and are never resampled on a turn.
// Document maps are immutable in their data; changes or new versions produce a new DocMap.

import { u16Bilinear } from "./inpaint_weights.js";
import { xfInv, xfApply, xfScale, xfMul } from "./inpaint_resample.js";
import { gaussBlur } from "./inpaint_edges.js";

const snapNum = (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-6 ? r : v; };
export const snapXf = (m) => [m[0], m[1], m[2], m[3], snapNum(m[4]), snapNum(m[5])];

let seq = 0;

/**
 * @typedef {{
 *   kind: string,
 *   w: number,
 *   h: number,
 *   data: Uint16Array,
 *   guide: Uint8Array | null,
 *   xf: number[],
 *   meta: object,
 *   ref: { filename: string, subfolder: string, type: string } | null,
 *   guideRef: { filename: string, subfolder: string, type: string } | null,
 *   version: number,
 *   dataVersion: number,
 *   guideVersion: number
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
 * @param {ArrayLike<number>} [guide]
 * @returns {DocMap}
 */
export function makeMap(kind, w, h, data, xf, meta = {}, guide = null) {
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

    let u8Guide = null;
    if (guide) {
        const glen = len * 4;
        if (typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
            if (guide.buffer instanceof SharedArrayBuffer) {
                u8Guide = guide;
            } else {
                const sab = new SharedArrayBuffer(glen);
                u8Guide = new Uint8Array(sab);
                u8Guide.set(guide.subarray ? guide.subarray(0, glen) : guide);
            }
        } else {
            u8Guide = new Uint8Array(glen);
            u8Guide.set(guide.subarray ? guide.subarray(0, glen) : guide);
        }
    }

    const defaultXf = [w, 0, 0, h, 0, 0];
    const mapXf = Array.isArray(xf) && xf.length === 6 ? Array.from(xf) : defaultXf;
    const v = ++seq;
    return {
        kind: String(kind || "depth"),
        w: w | 0,
        h: h | 0,
        data: u16,
        guide: u8Guide || null,
        xf: mapXf,
        meta: meta ? { ...meta } : {},
        ref: null,
        guideRef: null,
        version: v,
        dataVersion: v,
        guideVersion: v,
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
 * Create a new DocMap derived from an existing one, sharing unchanged buffers.
 * Inherits ref/dataVersion if data is unchanged, guideRef/guideVersion if guide is unchanged.
 * @param {DocMap} map
 * @param {object} [patch]
 * @returns {DocMap}
 */
export function deriveMap(map, patch = {}) {
    if (!map) return null;
    const v = ++seq;
    const w = patch.w !== undefined ? (patch.w | 0) : map.w;
    const h = patch.h !== undefined ? (patch.h | 0) : map.h;
    const dataChanged = patch.data !== undefined && patch.data !== map.data;
    const guideChanged = patch.guide !== undefined && patch.guide !== map.guide;

    let data = map.data;
    let dataVersion = map.dataVersion;
    let ref = map.ref;
    if (dataChanged) {
        data = patch.data;
        if (data && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" && !(data.buffer instanceof SharedArrayBuffer)) {
            const len = w * h;
            const sab = new SharedArrayBuffer(len * 2);
            const u16 = new Uint16Array(sab);
            u16.set(data.subarray ? data.subarray(0, len) : data);
            data = u16;
        }
        dataVersion = v;
        ref = patch.ref !== undefined ? patch.ref : null;
    } else if (patch.ref !== undefined) {
        ref = patch.ref;
    }

    let guide = map.guide;
    let guideVersion = map.guideVersion;
    let guideRef = map.guideRef;
    if (guideChanged) {
        guide = patch.guide;
        if (guide && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined" && !(guide.buffer instanceof SharedArrayBuffer)) {
            const glen = w * h * 4;
            const sab = new SharedArrayBuffer(glen);
            const u8 = new Uint8Array(sab);
            u8.set(guide.subarray ? guide.subarray(0, glen) : guide);
            guide = u8;
        }
        guideVersion = v;
        guideRef = patch.guideRef !== undefined ? patch.guideRef : null;
    } else if (patch.guideRef !== undefined) {
        guideRef = patch.guideRef;
    }

    return {
        kind: patch.kind || map.kind,
        w,
        h,
        data,
        guide,
        xf: patch.xf ? Array.from(patch.xf) : map.xf,
        meta: patch.meta ? { ...patch.meta } : { ...map.meta },
        ref,
        guideRef,
        version: v,
        dataVersion,
        guideVersion,
    };
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
 * Returns a sampler value compatible with F7 WebGL upload:
 * Uint8Array viewing map.guide's RGBA bytes.
 * @param {DocMap} map
 */
export function guideView(map) {
    if (!map || !map.guide) return null;
    return {
        data: map.guide,
        width: map.w,
        height: map.h,
        channels: 4,
        static: true,
        key: `${map.kind}:${map.guideVersion}:guide`,
    };
}

/**
 * Serialize map metadata and reference for persistence.
 * @param {DocMap} map
 */
export function mapToJSON(map) {
    if (!map) return null;
    const out = {
        ref: map.ref || null,
        guide: map.guideRef || null,
        w: map.w,
        h: map.h,
        xf: Array.from(map.xf),
        enc: "u16rg",
        meta: map.meta ? JSON.parse(JSON.stringify(map.meta)) : {},
    };
    if (map.guide || map.guideRef) {
        out.genc = "rgba8";
    }
    return out;
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

        let guide = null;
        if (j.guide) {
            try {
                const gimg = await loadImage(j.guide);
                if (gimg) {
                    const gcanvas = document.createElement("canvas");
                    gcanvas.width = j.w;
                    gcanvas.height = j.h;
                    const gctx = gcanvas.getContext("2d");
                    gctx.drawImage(gimg, 0, 0, j.w, j.h);
                    const gimgData = gctx.getImageData(0, 0, j.w, j.h);
                    guide = new Uint8Array(gimgData.data.buffer, gimgData.data.byteOffset, gimgData.data.byteLength);
                }
            } catch (gerr) {
                console.warn("mapFromJSON guide load failed:", gerr);
                guide = null;
            }
        }

        const map = makeMap(kind, j.w, j.h, data, j.xf, j.meta, guide);
        map.ref = j.ref;
        if (guide) {
            map.guideRef = j.guide;
        }
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

/**
 * Sample a selection canvas/buffer into a map-sized Float32Array (0..1 per texel).
 * Per texel: its document center through xf -> bilinear sample in selCanvas's alpha / 255.
 *
 * @param {HTMLCanvasElement | OffscreenCanvas | { width: number, height: number, data: ArrayLike<number> }} selCanvas - Doc-frame alpha at scale s
 * @param {number} s - Scale factor of selCanvas relative to document pixels
 * @param {DocMap} map - Target document map
 * @returns {Float32Array}
 */
export function selectionOnMap(selCanvas, s, map) {
    if (!map || map.w <= 0 || map.h <= 0) return new Float32Array(0);
    const mw = map.w | 0;
    const mh = map.h | 0;
    const out = new Float32Array(mw * mh);
    if (!selCanvas || s <= 0) return out;

    let selData, selW = 0, selH = 0, channels = 4, alphaOffset = 3;
    if (typeof HTMLCanvasElement !== "undefined" && selCanvas instanceof HTMLCanvasElement) {
        selW = selCanvas.width | 0;
        selH = selCanvas.height | 0;
        if (selW <= 0 || selH <= 0) return out;
        const ctx = selCanvas.getContext("2d", { willReadFrequently: true }) || selCanvas.getContext("2d");
        if (!ctx) return out;
        selData = ctx.getImageData(0, 0, selW, selH).data;
        channels = 4;
        alphaOffset = 3;
    } else if (typeof OffscreenCanvas !== "undefined" && selCanvas instanceof OffscreenCanvas) {
        selW = selCanvas.width | 0;
        selH = selCanvas.height | 0;
        if (selW <= 0 || selH <= 0) return out;
        const ctx = selCanvas.getContext("2d", { willReadFrequently: true }) || selCanvas.getContext("2d");
        if (!ctx) return out;
        selData = ctx.getImageData(0, 0, selW, selH).data;
        channels = 4;
        alphaOffset = 3;
    } else if (selCanvas.data && typeof selCanvas.width === "number" && typeof selCanvas.height === "number") {
        selW = selCanvas.width | 0;
        selH = selCanvas.height | 0;
        if (selW <= 0 || selH <= 0) return out;
        selData = selCanvas.data;
        channels = selData.length === selW * selH ? 1 : 4;
        alphaOffset = channels === 4 ? 3 : 0;
    } else if (selCanvas.getContext) {
        selW = selCanvas.width | 0;
        selH = selCanvas.height | 0;
        if (selW <= 0 || selH <= 0) return out;
        const ctx = selCanvas.getContext("2d");
        if (!ctx) return out;
        selData = ctx.getImageData(0, 0, selW, selH).data;
        channels = 4;
        alphaOffset = 3;
    } else {
        return out;
    }

    const xf = map.xf || [mw, 0, 0, mh, 0, 0];
    const stride = selW * channels;

    const stepX = (xf[0] / mw) * s;
    const stepY = (xf[1] / mw) * s;
    const ux0 = 0.5 / mw;

    for (let ty = 0; ty < mh; ty++) {
        const uy = (ty + 0.5) / mh;
        let px = (xf[0] * ux0 + xf[2] * uy + xf[4]) * s;
        let py = (xf[1] * ux0 + xf[3] * uy + xf[5]) * s;
        const rowOff = ty * mw;

        for (let tx = 0; tx < mw; tx++) {
            const u = px - 0.5;
            const v = py - 0.5;
            const x0 = Math.floor(u);
            const y0 = Math.floor(v);
            const x1 = x0 + 1;
            const y1 = y0 + 1;
            const fx = u - x0;
            const fy = v - y0;

            const inX0 = x0 >= 0 && x0 < selW;
            const inX1 = x1 >= 0 && x1 < selW;
            const inY0 = y0 >= 0 && y0 < selH;
            const inY1 = y1 >= 0 && y1 < selH;

            const a00 = (inX0 && inY0) ? selData[y0 * stride + x0 * channels + alphaOffset] : 0;
            const a10 = (inX1 && inY0) ? selData[y0 * stride + x1 * channels + alphaOffset] : 0;
            const a01 = (inX0 && inY1) ? selData[y1 * stride + x0 * channels + alphaOffset] : 0;
            const a11 = (inX1 && inY1) ? selData[y1 * stride + x1 * channels + alphaOffset] : 0;

            const top = a00 + fx * (a10 - a00);
            const bot = a01 + fx * (a11 - a01);
            const val = (top + fy * (bot - top)) / 255;
            out[rowOff + tx] = val <= 0 ? 0 : (val >= 1 ? 1 : val);

            px += stepX;
            py += stepY;
        }
    }

    return out;
}

/**
 * Edit a document map inside the selection weight field.
 * Always returns a new Uint16Array, never modifies the input map.data.
 * Attaches metadata properties `median` and `texelsChanged`.
 *
 * Operations:
 *   flatten: v' = mix(v, m, w) with m = value ?? weighted median of v under w (weights >= 0.5 count)
 *   offset:  v' = clamp(v + w * value * 65535, 0, 65535) (value -1..1)
 *   smooth:  v' = mix(v, gauss(v, 3 texels), w * value)  (value 0..1, gauss over boxBlurs on an f32 copy)
 *
 * @param {DocMap} map
 * @param {Float32Array | ArrayLike<number>} weight - Per-texel weight 0..1
 * @param {"flatten" | "offset" | "smooth"} op
 * @param {number} [value]
 * @returns {Uint16Array & { median?: number, texelsChanged?: number }}
 */
export function editMap(map, weight, op, value) {
    if (!map || !map.data || map.w <= 0 || map.h <= 0) {
        throw new Error("Invalid map passed to editMap");
    }
    const len = (map.w | 0) * (map.h | 0);
    const src = map.data;
    const out = new Uint16Array(len);
    let changed = 0;

    if (op === "flatten") {
        let m;
        if (value != null && !Number.isNaN(Number(value))) {
            const clamped = Math.max(0, Math.min(1, Number(value)));
            m = Math.round(clamped * 65535);
        } else {
            // Weighted median of v under w (weights >= 0.5 count)
            const hist = new Float64Array(65536);
            let totalW = 0;
            for (let i = 0; i < len; i++) {
                const w = weight[i];
                if (w >= 0.5) {
                    hist[src[i]] += w;
                    totalW += w;
                }
            }
            if (totalW > 0) {
                const half = totalW * 0.5;
                let cum = 0;
                m = 0;
                for (let k = 0; k < 65536; k++) {
                    cum += hist[k];
                    if (cum >= half) {
                        m = k;
                        break;
                    }
                }
            } else {
                let fallbackW = 0;
                for (let i = 0; i < len; i++) {
                    const w = weight[i];
                    if (w > 0) {
                        hist[src[i]] += w;
                        fallbackW += w;
                    }
                }
                if (fallbackW > 0) {
                    const half = fallbackW * 0.5;
                    let cum = 0;
                    m = 0;
                    for (let k = 0; k < 65536; k++) {
                        cum += hist[k];
                        if (cum >= half) {
                            m = k;
                            break;
                        }
                    }
                } else {
                    m = 0;
                }
            }
        }

        for (let i = 0; i < len; i++) {
            const w = weight[i];
            if (w > 0) {
                const v = src[i];
                const nv = Math.max(0, Math.min(65535, Math.round(v + w * (m - v))));
                out[i] = nv;
                if (nv !== v) changed++;
            } else {
                out[i] = src[i];
            }
        }
        out.median = m / 65535;
        out.texelsChanged = changed;
        return out;
    }

    if (op === "offset") {
        const val = Number(value) || 0;
        const dv = val * 65535;
        for (let i = 0; i < len; i++) {
            const w = weight[i];
            if (w > 0) {
                const v = src[i];
                const nv = Math.max(0, Math.min(65535, Math.round(v + w * dv)));
                out[i] = nv;
                if (nv !== v) changed++;
            } else {
                out[i] = src[i];
            }
        }
        out.texelsChanged = changed;
        return out;
    }

    if (op === "smooth") {
        const factor = value == null ? 1 : Math.max(0, Math.min(1, Number(value)));
        const f32 = new Float32Array(len);
        for (let i = 0; i < len; i++) f32[i] = src[i];
        const blurred = gaussBlur(f32, map.w, map.h, 3);
        for (let i = 0; i < len; i++) {
            const w = weight[i];
            if (w > 0) {
                const v = src[i];
                const b = blurred[i];
                const eff = w * factor;
                const nv = Math.max(0, Math.min(65535, Math.round(v + eff * (b - v))));
                out[i] = nv;
                if (nv !== v) changed++;
            } else {
                out[i] = src[i];
            }
        }
        out.texelsChanged = changed;
        return out;
    }

    throw new Error(`Unknown editMap op: ${op}`);
}

export const SAMPLE_GLSL = `float u16At(sampler2D t, ivec2 p) { vec2 v = texelFetch(t, clamp(p, ivec2(0), textureSize(t, 0) - 1), 0).rg * 255.0; return (v.x + 256.0 * v.y) / 65535.0; }
float u16Bilinear(sampler2D t, vec2 px) { vec2 q = px - 0.5; ivec2 i = ivec2(floor(q)); vec2 f = q - floor(q); return mix(mix(u16At(t, i), u16At(t, i + ivec2(1, 0)), f.x), mix(u16At(t, i + ivec2(0, 1)), u16At(t, i + ivec2(1, 1)), f.x), f.y); }`;

