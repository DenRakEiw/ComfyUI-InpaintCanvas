// Generated from DenRakEiw/scumble renderer/editor/inpaint_limit.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Post-stage for filter layers: params.limit (F6 / R1-S7 / R2-S5).
// Runs on the GPU via LIMIT_SHADER or on the CPU via limitStageCPU.
// The colour is the filter's input (the picture below the layer, lower filter layers included);
// the guide is the picture without filters.
// No DOM at import.

import { WEIGHTS_GLSL, normalizeLimit, limitWeight, u16Bilinear, opp, hexToRgb } from "./inpaint_weights.js";
import { SAMPLE_GLSL, runShader, glToCanvas } from "./inpaint_filters_gl.js";
import { passToMap, rg8View, guideView } from "./inpaint_maps.js";
import { setLimitStage } from "./inpaint_filters.js";
import { SNAP_GLSL, snapParams, snapField } from "./inpaint_edges.js";

export const LIMIT_SHADER = {
    label: "limit",
    uniforms: {
        u_in: "sampler2D",
        u_map: "sampler2D",
        u_guide: "sampler2D",
        u_snap: "vec2",
        u_hasMap: "int",
        u_source: "int",
        u_r: "vec4",
        u_inv: "int",
        u_ref: "vec3",
        u_tol: "float",
        u_m0: "vec4",
        u_m1: "vec2",
        u_over: "int",
        u_view: "int",
    },
    code: WEIGHTS_GLSL + "\n" + SAMPLE_GLSL + "\n" + SNAP_GLSL + `
vec4 shade(vec4 c, vec2 uv) {
    vec4 i = texture(u_in, uv);
    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec2 mp = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);
    float mv = u_hasMap == 1 ? snapField(u_map, u_guide, mp, i.rgb, u_snap) : 0.0;
    float w = (u_source == 0 && u_hasMap == 0) ? 0.0 : w_limit(u_source, i.rgb, mv, u_r, u_inv == 1, u_ref, u_tol);
    if (u_view == 1) return vec4(vec3(w), 1.0);
    return u_over == 1 ? vec4(c.rgb, c.a * w) : mix(i, c, w);
}
`,
};

/**
 * Apply the limit post-stage to a filter layer output.
 * @param {any} src - Original input picture before the filter (canvas or GLSurface)
 * @param {any} out - Filter output (canvas or GLSurface)
 * @param {any} limitIn - Limit parameters descriptor
 * @param {any} [info={}] - Pass info ({ scale, origin, full, maps, limitView, cpu, chain, ... })
 * @param {any} [def=null] - Filter definition ({ over, ... })
 * @returns {any} Filtered output constrained by limit (canvas or GLSurface)
 */
export function limitStage(src, out, limitIn, info = {}, def = null) {
    if (!limitIn) return out;
    const limit = normalizeLimit(limitIn);
    if (!limit) return out;
    if (out === src) return src;
    if (limit.lo <= 0 && limit.hi >= 1 && !limit.invert) return out;
    if (limit.source === "depth" && (!info || !info.maps || !info.maps.depth)) {
        if (info) info.limitMissing = true;
        return src;
    }

    // Fills always carry the weight in their alpha (\`def.over\`); a filter does so whenever its result is
    // drawn over the picture rather than becoming the chain's surface (\`info.limitOver\`, set by the
    // caller): with \`mix(in, out, w)\` under a blend mode the picture would be blended with itself where
    // the limit is 0 (multiply darkens, screen lightens), while the painted mask leaves it alone there.
    const over = !!(def && def.over) || !!info.limitOver;
    if (!info.cpu) {
        try {
            const map = limit.source === "depth" ? (info.maps && info.maps.depth) : null;
            const m = map ? passToMap(map, info.scale || 1) : [1, 0, 0, 1, 0, 0];
            const rgb = hexToRgb(limit.color || "#ffffff");
            const ref = opp(rgb[0], rgb[1], rgb[2]);
            const sourceInt = limit.source === "depth" ? 0 : (limit.source === "luma" ? 1 : 2);
            const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
            const values = {
                u_in: src,
                u_map: map ? rg8View(map) : null,
                u_guide: (map && map.guide) ? guideView(map) : null,
                u_snap: snap,
                u_hasMap: map ? 1 : 0,
                u_source: sourceInt,
                u_r: [limit.lo, limit.hi, limit.fLo, limit.fHi],
                u_inv: limit.invert ? 1 : 0,
                u_ref: ref,
                u_tol: limit.tol ?? 30,
                u_m0: [m[0], m[2], m[1], m[3]],
                u_m1: [m[4], m[5]],
                u_over: over ? 1 : 0,
                u_view: (info && info.limitView) ? 1 : 0,
            };
            const res = runShader(LIMIT_SHADER, out, values, info);
            if (res) return res;
        } catch (err) {
            console.warn("limitStage WebGL failed, falling back to CPU:", err.message || err);
        }
    }

    return limitStageCPU(glToCanvas(src), glToCanvas(out), limit, info, over);
}

/**
 * CPU fallback for the limit post-stage.
 * @param {HTMLCanvasElement} srcCanvas
 * @param {HTMLCanvasElement} outCanvas
 * @param {import("./inpaint_weights.js").Limit} limit
 * @param {any} [info={}]
 * @param {boolean} [over=false]
 * @returns {HTMLCanvasElement}
 */
export function limitStageCPU(srcCanvas, outCanvas, limit, info = {}, over = false) {
    if (!srcCanvas || !outCanvas) return outCanvas;
    const W = outCanvas.width | 0;
    const H = outCanvas.height | 0;
    if (W <= 0 || H <= 0) return outCanvas;

    const res = document.createElement("canvas");
    res.width = W;
    res.height = H;
    const resCtx = res.getContext("2d");
    if (!resCtx) return outCanvas;

    const srcCtx = srcCanvas.getContext("2d");
    const outCtx = outCanvas.getContext("2d");
    if (!srcCtx || !outCtx) return outCanvas;

    const srcData = srcCtx.getImageData(0, 0, W, H).data;
    const outData = outCtx.getImageData(0, 0, W, H).data;
    const resImg = resCtx.createImageData(W, H);
    const resData = resImg.data;

    const map = limit.source === "depth" ? (info && info.maps && info.maps.depth) : null;
    const m = map ? passToMap(map, info.scale || 1) : null;
    const ox = (info && info.origin && info.origin[0]) || 0;
    const oy = (info && info.origin && info.origin[1]) || 0;
    const isView = !!(info && info.limitView);
    const snap = (map && map.guide) ? snapParams(map.meta?.snap?.strength) : null;
    const sigmaR = snap ? snap[0] : 0;
    const tau = snap ? snap[1] : 0;

    let ptr = 0;
    for (let y = 0; y < H; y++) {
        const py = oy + y + 0.5;
        for (let x = 0; x < W; x++, ptr += 4) {
            const iR = srcData[ptr];
            const iG = srcData[ptr + 1];
            const iB = srcData[ptr + 2];
            const iA = srcData[ptr + 3];

            const cR = outData[ptr];
            const cG = outData[ptr + 1];
            const cB = outData[ptr + 2];
            const cA = outData[ptr + 3];

            let mapVal = 0;
            if (map && m) {
                const px = ox + x + 0.5;
                const mx = m[0] * px + m[2] * py + m[4];
                const my = m[1] * px + m[3] * py + m[5];
                mapVal = (sigmaR > 0)
                    ? snapField(map, map.guide, mx, my, iR / 255, iG / 255, iB / 255, sigmaR, tau)
                    : u16Bilinear(map.data, map.w, map.h, mx, my);
            }

            const w = (limit.source === "depth" && !map)
                ? 0
                : limitWeight(limit, iR / 255, iG / 255, iB / 255, mapVal);

            if (isView) {
                const v = Math.round(w * 255);
                resData[ptr] = v;
                resData[ptr + 1] = v;
                resData[ptr + 2] = v;
                resData[ptr + 3] = 255;
            } else if (over) {
                resData[ptr] = cR;
                resData[ptr + 1] = cG;
                resData[ptr + 2] = cB;
                resData[ptr + 3] = Math.max(0, Math.min(255, Math.round(cA * w)));
            } else {
                resData[ptr] = Math.max(0, Math.min(255, Math.round(iR + (cR - iR) * w)));
                resData[ptr + 1] = Math.max(0, Math.min(255, Math.round(iG + (cG - iG) * w)));
                resData[ptr + 2] = Math.max(0, Math.min(255, Math.round(iB + (cB - iB) * w)));
                resData[ptr + 3] = Math.max(0, Math.min(255, Math.round(iA + (cA - iA) * w)));
            }
        }
    }
    resCtx.putImageData(resImg, 0, 0);
    return res;
}

/**
 * Bake limit weights into fill layer row alpha in place.
 * Evaluates the depth limit over map (or other limit sources) and multiplies alpha: alpha = round(alpha * w).
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} x0
 * @param {number} y0
 * @param {number} w
 * @param {number} h
 * @param {any} limit
 * @param {any} map
 */
export function limitAlphaRows(rgba, x0, y0, w, h, limit, map) {
    if (!rgba || !limit || w <= 0 || h <= 0) return;
    const lim = normalizeLimit(limit);
    if (!lim) return;

    // Shortcut: full range and not inverted leaves alpha untouched
    if (lim.lo <= 0 && lim.hi >= 1 && !lim.invert) return;

    // If depth limit but map or map.data is missing, effect is zero -> alpha becomes 0
    if (lim.source === "depth" && (!map || !map.data)) {
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0;
        return;
    }

    const m = (map && map.data) ? passToMap(map, 1) : null;
    const snap = (map && map.guide) ? snapParams(map.meta?.snap?.strength) : null;
    const sigmaR = snap ? snap[0] : 0;
    const tau = snap ? snap[1] : 0;
    let ptr = 0;
    for (let y = 0; y < h; y++) {
        const py = y0 + y + 0.5;
        for (let x = 0; x < w; x++, ptr += 4) {
            let mapVal = 0;
            if (map && map.data && m) {
                const px = x0 + x + 0.5;
                const mx = m[0] * px + m[2] * py + m[4];
                const my = m[1] * px + m[3] * py + m[5];
                mapVal = (sigmaR > 0)
                    ? snapField(map, map.guide, mx, my, rgba[ptr] / 255, rgba[ptr + 1] / 255, rgba[ptr + 2] / 255, sigmaR, tau)
                    : u16Bilinear(map.data, map.w, map.h, mx, my);
            }
            const wVal = (lim.source === "depth" && (!map || !map.data))
                ? 0
                : limitWeight(lim, rgba[ptr] / 255, rgba[ptr + 1] / 255, rgba[ptr + 2] / 255, mapVal);
            rgba[ptr + 3] = Math.max(0, Math.min(255, Math.round(rgba[ptr + 3] * wVal)));
        }
    }
}

setLimitStage(limitStage);
