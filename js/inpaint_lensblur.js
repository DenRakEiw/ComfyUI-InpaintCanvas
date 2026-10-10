// Generated from DenRakEiw/scumble renderer/editor/inpaint_lensblur.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Inpaint Canvas - depth-aware lens blur and bokeh filter (R2-S15)
// Vogel disc sampling, scatter-as-gather rule, bleed suppression and specular highlight boost.
// Pure ASCII, no DOM at import.

import { registerGLFilter } from "./inpaint_filters_gl.js";
import { SAMPLE_GLSL, passToMap, rg8View, guideView } from "./inpaint_maps.js";
import { SNAP_GLSL, snapField, snapParams } from "./inpaint_edges.js";

const DUMMY_RG8 = { data: new Uint8Array([0, 0]), width: 1, height: 1, channels: 2 };
const DUMMY_RGBA8 = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, channels: 4 };

/**
 * Precompute 64-tap Vogel disc points in unit circle:
 * N = 64, golden angle = 2.39996323.
 * For i = 0..63:
 *   r = sqrt((i + 0.5) / 64.0);
 *   theta = i * 2.39996323;
 *   [r * cos(theta), r * sin(theta)]
 * @type {Array<[number, number]>}
 */
export const VOGEL_TAPS = (() => {
    const N = 64;
    const ga = 2.39996323;
    /** @type {Array<[number, number]>} */
    const taps = [];
    for (let i = 0; i < N; i++) {
        const r = Math.sqrt((i + 0.5) / 64.0);
        const theta = i * ga;
        taps.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
    return taps;
})();

/**
 * Generates n-tap Vogel disc points in unit circle.
 * @param {number} [n=64]
 * @returns {Array<[number, number]>}
 */
export function vogelDisc(n = 64) {
    const N = Math.max(1, Math.round(n) || 64);
    const ga = 2.39996323;
    /** @type {Array<[number, number]>} */
    const taps = [];
    for (let i = 0; i < N; i++) {
        const r = Math.sqrt((i + 0.5) / N);
        const theta = i * ga;
        taps.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
    return taps;
}

/**
 * Circle of confusion calculation:
 * coc(far, focus, dof, rMax) = rMax * clamp((abs(far - focus) - dof * 0.5) / max(0.001, 1.0 - dof * 0.5), 0.0, 1.0);
 *
 * @param {number} far - Depth value at sample point (0..1)
 * @param {number} focus - Focal plane depth (0..1)
 * @param {number} dof - Depth of field range (0..1)
 * @param {number} rMax - Maximum blur radius in pixels
 * @returns {number} Blur radius in pixels (0..rMax)
 */
export function coc(far, focus, dof, rMax) {
    const d = Math.abs(far - focus);
    const denom = Math.max(0.001, 1.0 - dof * 0.5);
    const t = Math.max(0.0, Math.min(1.0, (d - dof * 0.5) / denom));
    return rMax * t;
}

/**
 * Maximum reach of the lens blur filter in pixels for band planning and padding:
 * Math.ceil(rMax) + 2 where rMax = max(size.width, size.height) * (clamp(params.aperture, 0.1, 1.5) / 100.0).
 *
 * @param {Record<string, any>} [params]
 * @param {{ width?: number, height?: number, w?: number, h?: number }} [size]
 * @returns {number}
 */
export function lensBlurReach(params, size) {
    const p = params || {};
    const s = size || { width: 1024, height: 1024 };
    const apRaw = p.aperture != null ? Number(p.aperture) : 0.8;
    const aperture = Math.max(0.1, Math.min(1.5, Number.isFinite(apRaw) ? apRaw : 0.8));
    const sw = s.width || s.w || 1024;
    const sh = s.height || s.h || 1024;
    const rMax = Math.max(sw, sh) * (aperture / 100.0);
    return Math.ceil(rMax) + 2;
}

const VOGEL_GLSL = VOGEL_TAPS.map(([x, y]) => `    vec2(${x.toFixed(8)}, ${y.toFixed(8)})`).join(",\n");

/**
 * GLSL ES 3.00 shader snippet defining shade(vec4 c, vec2 uv).
 */
export const LENS_BLUR_GLSL = `
float w_sstep(float a, float b, float x) {
    if (b <= a) return x >= b ? 1.0 : 0.0;
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

${SAMPLE_GLSL}
${SNAP_GLSL}

const vec3 LENS_LUMA = vec3(0.299, 0.587, 0.114);

const vec2 VOGEL_TAPS[64] = vec2[64](
${VOGEL_GLSL}
);

float lensCoc(float far, float focus, float dof, float rMax) {
    float d = abs(far - focus);
    float denom = max(0.001, 1.0 - dof * 0.5);
    return rMax * clamp((d - dof * 0.5) / denom, 0.0, 1.0);
}

vec4 shade(vec4 c, vec2 uv) {
    if (u_hasDepth < 0.5 || u_rMax <= 0.1) return c;

    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec2 mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);
    float center_far = snapField(u_map, u_guide, mpx, c.rgb, u_snap);
    float center_coc = lensCoc(center_far, u_focus, u_dof, u_rMax);

    vec4 sum = vec4(0.0);
    float totalWeight = 0.0;
    bool centerInFocus = (center_coc <= 0.05 * u_rMax);

    for (int i = 0; i < 64; i++) {
        vec2 vogelTap = VOGEL_TAPS[i];
        vec2 delta = vogelTap * u_rMax;
        float deltaLen = length(delta);

        vec2 tap_uv = uv + delta / u_size;
        vec4 tap_c = texture(u_src, tap_uv);

        vec2 tap_pp = pictureUv(tap_uv) * u_pictureSize;
        vec2 tap_mpx = vec2(dot(u_m0.xy, tap_pp) + u_m1.x, dot(u_m0.zw, tap_pp) + u_m1.y);
        float tap_far = snapField(u_map, u_guide, tap_mpx, tap_c.rgb, u_snap);
        float tap_coc = lensCoc(tap_far, u_focus, u_dof, u_rMax);

        float weight = 0.0;
        if (tap_coc >= deltaLen) {
            weight = 1.0;
            if (centerInFocus && tap_far > center_far) {
                weight = 0.0;
            }
        }

        if (weight > 0.0) {
            if (u_highlights > 0.0) {
                float luma = dot(tap_c.rgb, LENS_LUMA);
                if (luma > u_threshold) {
                    float denomH = max(0.001, 1.0 - u_threshold);
                    float normLuma = (luma - u_threshold) / denomH;
                    float boost = normLuma * normLuma * (u_highlights / 25.0);
                    weight *= (1.0 + boost);
                }
            }
            sum += tap_c * weight;
            totalWeight += weight;
        }
    }

    if (totalWeight <= 0.0001) return c;
    return vec4(sum.rgb / totalWeight, c.a);
}
`;

/**
 * CPU twin for lens blur matching the shader formula and gather logic.
 *
 * @param {any} src
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [info]
 * @returns {any}
 */
export function applyLensBlur(src, params, info) {
    const W = src.width, H = src.height;
    const p = params || {};
    const map = info && info.maps && info.maps.depth;

    const scale = (info && info.scale) || 1;
    const full = (info && info.full) || [W, H];
    const docW = full[0], docH = full[1];
    const origin = (info && info.full && info.origin) ? info.origin : [0, 0];

    const apRaw = p.aperture != null ? Number(p.aperture) : 0.8;
    const aperture = Math.max(0.1, Math.min(1.5, Number.isFinite(apRaw) ? apRaw : 0.8));
    const rMax = Math.max(docW, docH) * (aperture / 100.0) * scale;

    /** @type {any} */
    let out;
    let octx = null;
    let srcPx;
    const isDomCanvas = typeof document !== "undefined" && typeof document.createElement === "function" && typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement;

    if (isDomCanvas) {
        out = document.createElement("canvas");
        out.width = W;
        out.height = H;
        octx = out.getContext("2d");
        if (!octx) return src;
        octx.drawImage(src, 0, 0);
        if (!map || !map.data || rMax <= 0.1) return out;
        const img = octx.getImageData(0, 0, W, H);
        srcPx = img.data;
    } else {
        const anySrc = /** @type {any} */ (src);
        const inData = anySrc.data || (anySrc.getContext && anySrc.getContext("2d")?.getImageData(0, 0, W, H)?.data);
        if (!inData) return src;
        srcPx = inData;
        out = { width: W, height: H, data: new Uint8ClampedArray(inData) };
        if (!map || !map.data || rMax <= 0.1) return out;
    }

    const outPx = isDomCanvas ? new Uint8ClampedArray(srcPx) : out.data;

    const focus = (p.focus != null ? Number(p.focus) : 30) / 100.0;
    const dof = (p.dof != null ? Number(p.dof) : 15) / 100.0;
    const highlights = p.highlights != null ? Number(p.highlights) : 20;
    const threshold = (p.threshold != null ? Number(p.threshold) : 75) / 100.0;

    const m = map ? (map.xf ? passToMap(map, scale) : [map.w / docW, 0, 0, map.h / docH, 0, 0]) : [1, 0, 0, 1, 0, 0];
    const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
    const sigmaR = snap[0], tau = snap[1];
    const guide = map.guide || null;

    const numTaps = VOGEL_TAPS.length;
    const denomH = Math.max(0.001, 1.0 - threshold);
    const hlFactor = highlights / 25.0;

    for (let y = 0; y < H; y++) {
        const row = y * W;
        const py = origin[1] + y + 0.5;
        for (let x = 0; x < W; x++) {
            const idx = (row + x) * 4;
            const px_x = origin[0] + x + 0.5;

            const mx = m[0] * px_x + m[2] * py + m[4];
            const my = m[1] * px_x + m[3] * py + m[5];

            const cr = srcPx[idx] / 255;
            const cg = srcPx[idx + 1] / 255;
            const cb = srcPx[idx + 2] / 255;

            const center_far = snapField(map, guide, mx, my, cr, cg, cb, sigmaR, tau);
            const center_coc = coc(center_far, focus, dof, rMax);
            const centerInFocus = (center_coc <= 0.05 * rMax);

            let sumR = 0, sumG = 0, sumB = 0;
            let totalWeight = 0;

            for (let i = 0; i < numTaps; i++) {
                const tap = VOGEL_TAPS[i];
                const dx = tap[0] * rMax;
                const dy = tap[1] * rMax;
                const deltaLen = Math.hypot(dx, dy);

                const sx = Math.max(0, Math.min(W - 1, Math.round(x + dx)));
                const sy = Math.max(0, Math.min(H - 1, Math.round(y + dy)));
                const sIdx = (sy * W + sx) * 4;

                const tr = srcPx[sIdx] / 255;
                const tg = srcPx[sIdx + 1] / 255;
                const tb = srcPx[sIdx + 2] / 255;

                const tap_px = origin[0] + x + dx + 0.5;
                const tap_py = origin[1] + y + dy + 0.5;
                const tap_mx = m[0] * tap_px + m[2] * tap_py + m[4];
                const tap_my = m[1] * tap_px + m[3] * tap_py + m[5];

                const tap_far = snapField(map, guide, tap_mx, tap_my, tr, tg, tb, sigmaR, tau);
                const tap_coc = coc(tap_far, focus, dof, rMax);

                let weight = 0.0;
                if (tap_coc >= deltaLen) {
                    weight = 1.0;
                    if (centerInFocus && tap_far > center_far) {
                        weight = 0.0;
                    }
                }

                if (weight > 0.0) {
                    if (highlights > 0) {
                        const luma = 0.299 * tr + 0.587 * tg + 0.114 * tb;
                        if (luma > threshold) {
                            const normLuma = (luma - threshold) / denomH;
                            const boost = normLuma * normLuma * hlFactor;
                            weight *= (1.0 + boost);
                        }
                    }
                    sumR += srcPx[sIdx] * weight;
                    sumG += srcPx[sIdx + 1] * weight;
                    sumB += srcPx[sIdx + 2] * weight;
                    totalWeight += weight;
                }
            }

            if (totalWeight > 0.0001) {
                outPx[idx] = Math.round(sumR / totalWeight);
                outPx[idx + 1] = Math.round(sumG / totalWeight);
                outPx[idx + 2] = Math.round(sumB / totalWeight);
            } else {
                outPx[idx] = srcPx[idx];
                outPx[idx + 1] = srcPx[idx + 1];
                outPx[idx + 2] = srcPx[idx + 2];
            }
            outPx[idx + 3] = srcPx[idx + 3];
        }
    }

    if (isDomCanvas && octx) {
        const outImg = octx.createImageData(W, H);
        outImg.data.set(outPx);
        octx.putImageData(outImg, 0, 0);
    }
    return out;
}

let lensBlurRegistered = false;

/**
 * Register the lens_blur filter for WebGL2 pipeline execution.
 */
export function registerLensBlurGL() {
    if (lensBlurRegistered) return;
    lensBlurRegistered = true;
    registerGLFilter("lens_blur", {
        uniforms: {
            u_map: "sampler2D",
            u_guide: "sampler2D",
            u_m0: "vec4",
            u_m1: "vec2",
            u_snap: "vec2",
            u_focus: "float",
            u_dof: "float",
            u_rMax: "float",
            u_highlights: "float",
            u_threshold: "float",
            u_hasDepth: "float",
        },
        code: LENS_BLUR_GLSL,
        values: (params, info, src) => {
            const map = (info && info.maps && info.maps.depth) || null;
            const scale = (info && info.scale) || 1;
            const full = (info && info.full) || [src.width, src.height];
            const docW = full[0], docH = full[1];
            const apRaw = params.aperture != null ? Number(params.aperture) : 0.8;
            const aperture = Math.max(0.1, Math.min(1.5, Number.isFinite(apRaw) ? apRaw : 0.8));
            const rMax = Math.max(docW, docH) * (aperture / 100.0) * scale;
            const m = map ? (map.xf ? passToMap(map, scale) : [map.w / docW, 0, 0, map.h / docH, 0, 0]) : [1, 0, 0, 1, 0, 0];
            const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
            const focus = (params.focus != null ? Number(params.focus) : 30) / 100.0;
            const dof = (params.dof != null ? Number(params.dof) : 15) / 100.0;
            const highlights = params.highlights != null ? Number(params.highlights) : 20;
            const threshold = (params.threshold != null ? Number(params.threshold) : 75) / 100.0;
            return {
                u_map: map ? rg8View(map) : DUMMY_RG8,
                u_guide: (map && map.guide) ? guideView(map) : DUMMY_RGBA8,
                u_m0: [m[0], m[2], m[1], m[3]],
                u_m1: [m[4], m[5]],
                u_snap: snap,
                u_focus: focus,
                u_dof: dof,
                u_rMax: rMax,
                u_highlights: highlights,
                u_threshold: threshold,
                u_hasDepth: (map && map.data) ? 1.0 : 0.0,
            };
        },
        skip: (p, info) => {
            if (!(info && info.maps && info.maps.depth && info.maps.depth.data)) return true;
            const full = (info && info.full) || (info && info.width ? [info.width, info.height] : [1024, 1024]);
            const apRaw = p && p.aperture != null ? Number(p.aperture) : 0.8;
            const aperture = Math.max(0.1, Math.min(1.5, Number.isFinite(apRaw) ? apRaw : 0.8));
            const scale = (info && info.scale) || 1;
            const rMax = Math.max(full[0], full[1]) * (aperture / 100.0) * scale;
            return rMax <= 0.1;
        },
    });
}

try {
    registerLensBlurGL();
} catch (_) {
    // Registered when inpaint_filters_gl.js initializes
}
