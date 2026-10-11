// Generated from DenRakEiw/scumble renderer/editor/inpaint_lensblur.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Inpaint Canvas - depth-aware lens blur and bokeh filter (R2-S15)
// Vogel disc sampling, scatter-as-gather rule, bleed suppression and specular highlight boost.
//
// The gather: a pixel averages itself (a self tap at distance 0) and the 64 disc taps whose own circle of confusion
// reaches it (tap_coc >= distance). Each sample weighs the share of its light that lands on one pixel: 1 for a
// sample in focus, 1/64 for one spread over the whole disc (each tap stands for 1/64 of it; LENS_CELL), so a blurred
// neighbour that covers part of the disc blends with an in-focus centre instead of replacing it; no tap weighs more
// than the centre's own share. Samples behind the centre are faded out while the centre is (almost) in focus
// (LENS_RAMP), so background colour does not bleed over a sharp subject. Colours are averaged premultiplied
// (straight-alpha input): a transparent tap adds no black, and the alpha is blurred with the colour. A tap reads the
// pixel nearest its point (colour and depth at that pixel's centre), on both twins alike.
// The radius is in the input's pixels: lensRadius(params, info.full), info.full already at the pass's scale.
// Pure ASCII, no DOM at import.

import { registerGLFilter } from "./inpaint_filters_gl.js";
import { SAMPLE_GLSL, passToMap, rg8View, guideView } from "./inpaint_maps.js";
import { SNAP_GLSL, snapField, snapParams } from "./inpaint_edges.js";
import { sstep } from "./inpaint_weights.js";

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

/** One tap's share of the disc as a radius, a fraction of rMax: 64 taps, so 1 / sqrt(64). */
export const LENS_CELL = 0.125;

/** The centre's circle of confusion (fraction of rMax) over which samples behind it fade in: 0 below, 1 above. */
export const LENS_RAMP = [0.05, 0.15];

/**
 * How much farther (depth, 0..1) a tap has to lie to count as behind the centre: equal depths stay equal on both
 * twins (the shader's float32 bilinear can land an ulp above the centre's own value).
 */
export const LENS_BEHIND_EPS = 1e-4;

/**
 * The aperture parameter, clamped to its range (percent of the long side).
 * @param {Record<string, any>} [params]
 * @returns {number}
 */
function apertureOf(params) {
    const apRaw = params && params.aperture != null ? Number(params.aperture) : 0.8;
    return Math.max(0.1, Math.min(1.5, Number.isFinite(apRaw) ? apRaw : 0.8));
}

/**
 * The largest blur radius of a pass in the input's pixels. `full` is the whole picture in the input's pixels
 * (`info.full`), so it already carries the pass's scale: no further `* info.scale`.
 *
 * @param {Record<string, any> | undefined} params
 * @param {number[]} full - [width, height] of the whole picture in the input's pixels
 * @returns {number}
 */
export function lensRadius(params, full) {
    return Math.max(full[0], full[1]) * (apertureOf(params) / 100.0);
}

/**
 * The weight of a sample with circle of confusion `c` (pixels): the share of its light that lands on one pixel,
 * 1 for a sample in focus (c <= cell) down to 1/64 for one spread over the whole disc (c = rMax, cell = rMax / 8).
 *
 * @param {number} c
 * @param {number} cell - rMax * LENS_CELL
 * @returns {number}
 */
export function lensWeight(c, cell) {
    const r = Math.max(c, cell);
    return (cell * cell) / (r * r);
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
    const s = size || { width: 1024, height: 1024 };
    const sw = s.width || s.w || 1024;
    const sh = s.height || s.h || 1024;
    // document pixels: a pass at scale s pads reach * s of its own, which holds its radius lensRadius(params, full)
    return Math.ceil(lensRadius(params, [sw, sh])) + 2;
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

// lensWeight in inpaint_lensblur.js: the share of a sample's light that lands on one pixel
float lensWeight(float coc, float cell) {
    float r = max(coc, cell);
    return (cell * cell) / (r * r);
}

// the specular highlight boost, for the centre and every tap alike
float lensBoost(vec3 rgb) {
    if (u_highlights <= 0.0) return 1.0;
    float luma = dot(rgb, LENS_LUMA);
    if (luma <= u_threshold) return 1.0;
    float normLuma = (luma - u_threshold) / max(0.001, 1.0 - u_threshold);
    return 1.0 + normLuma * normLuma * (u_highlights / 25.0);
}

vec4 shade(vec4 c, vec2 uv) {
    if (u_hasDepth < 0.5 || u_rMax <= 0.1) return c;

    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec2 mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);
    float center_far = snapField(u_map, u_guide, mpx, c.rgb, u_snap);
    float center_coc = lensCoc(center_far, u_focus, u_dof, u_rMax);

    float cell = u_rMax * ${LENS_CELL.toFixed(4)};
    // samples behind the centre fade in as the centre leaves focus (the foreground protection, as a ramp)
    float behind = w_sstep(${LENS_RAMP[0].toFixed(4)} * u_rMax, ${LENS_RAMP[1].toFixed(4)} * u_rMax, center_coc);

    // the self tap at distance 0; premultiplied sums (the input is straight alpha)
    float w0 = lensWeight(center_coc, cell) * lensBoost(c.rgb);
    float sumW = w0;
    float sumA = w0 * c.a;
    vec3 sumC = c.rgb * (w0 * c.a);

    for (int i = 0; i < 64; i++) {
        vec2 vogelTap = VOGEL_TAPS[i];
        vec2 delta = vogelTap * u_rMax;
        float deltaLen = length(delta);

        // the tap reads the pixel nearest its point, at that pixel's centre (colour and depth alike), so the
        // sampler has no rounding of its own left to do: the CPU twin's Math.round
        vec2 tap_uv = uv + floor(delta + 0.5) / u_size;
        vec4 tap_c = texture(u_src, tap_uv);

        vec2 tap_pp = pictureUv(tap_uv) * u_pictureSize;
        vec2 tap_mpx = vec2(dot(u_m0.xy, tap_pp) + u_m1.x, dot(u_m0.zw, tap_pp) + u_m1.y);
        float tap_far = snapField(u_map, u_guide, tap_mpx, tap_c.rgb, u_snap);
        float tap_coc = lensCoc(tap_far, u_focus, u_dof, u_rMax);

        // scatter-as-gather: the tap's own blur has to reach the centre
        if (tap_coc < deltaLen) continue;
        // never more than the centre's own share (lensWeight of the larger circle)
        float weight = lensWeight(max(tap_coc, center_coc), cell);
        if (tap_far > center_far + ${LENS_BEHIND_EPS.toFixed(6)}) weight *= behind;
        if (weight <= 0.0) continue;
        weight *= lensBoost(tap_c.rgb);
        float wa = weight * tap_c.a;
        sumW += weight;
        sumA += wa;
        sumC += tap_c.rgb * wa;
    }

    vec3 rgb = sumA > 1e-6 ? sumC / sumA : c.rgb;
    return vec4(rgb, sumA / sumW);
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
    // the whole picture in the input's pixels: the radius below is in the input's pixels at this pass's scale
    const full = (info && info.full) || [W, H];
    const docW = full[0], docH = full[1];
    const origin = (info && info.full && info.origin) ? info.origin : [0, 0];

    const rMax = lensRadius(p, full);

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
    // the specular highlight boost, for the centre and every tap alike (lensBoost in the shader)
    /** @type {(r: number, g: number, b: number) => number} */
    const boostOf = (r, g, b) => {
        if (!(highlights > 0)) return 1.0;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma <= threshold) return 1.0;
        const normLuma = (luma - threshold) / denomH;
        return 1.0 + normLuma * normLuma * hlFactor;
    };
    const cell = rMax * LENS_CELL;
    const rampLo = LENS_RAMP[0] * rMax, rampHi = LENS_RAMP[1] * rMax;
    // per tap: the whole-pixel offset of the pixel it reads (colour and depth at that pixel's centre, as the
    // shader's floor(delta + 0.5)) and its nominal distance for the scatter-as-gather rule
    const offX = new Int32Array(numTaps), offY = new Int32Array(numTaps), dist = new Float64Array(numTaps);
    for (let i = 0; i < numTaps; i++) {
        const dx = VOGEL_TAPS[i][0] * rMax, dy = VOGEL_TAPS[i][1] * rMax;
        offX[i] = Math.round(dx);
        offY[i] = Math.round(dy);
        dist[i] = Math.hypot(dx, dy);
    }

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
            const ca = srcPx[idx + 3] / 255;

            const center_far = snapField(map, guide, mx, my, cr, cg, cb, sigmaR, tau);
            const center_coc = coc(center_far, focus, dof, rMax);
            // samples behind the centre fade in as the centre leaves focus (the foreground protection, as a ramp)
            const behind = sstep(rampLo, rampHi, center_coc);

            // the self tap at distance 0; premultiplied sums (the input is straight alpha)
            const w0 = lensWeight(center_coc, cell) * boostOf(cr, cg, cb);
            let sumW = w0;
            let sumA = w0 * ca;
            let sumR = w0 * ca * srcPx[idx], sumG = w0 * ca * srcPx[idx + 1], sumB = w0 * ca * srcPx[idx + 2];

            for (let i = 0; i < numTaps; i++) {
                const deltaLen = dist[i];

                const sx = Math.max(0, Math.min(W - 1, x + offX[i]));
                const sy = Math.max(0, Math.min(H - 1, y + offY[i]));
                const sIdx = (sy * W + sx) * 4;

                const tr = srcPx[sIdx] / 255;
                const tg = srcPx[sIdx + 1] / 255;
                const tb = srcPx[sIdx + 2] / 255;

                const tap_px = origin[0] + x + offX[i] + 0.5;
                const tap_py = origin[1] + y + offY[i] + 0.5;
                const tap_mx = m[0] * tap_px + m[2] * tap_py + m[4];
                const tap_my = m[1] * tap_px + m[3] * tap_py + m[5];

                const tap_far = snapField(map, guide, tap_mx, tap_my, tr, tg, tb, sigmaR, tau);
                const tap_coc = coc(tap_far, focus, dof, rMax);

                // scatter-as-gather: the tap's own blur has to reach the centre
                if (tap_coc < deltaLen) continue;
                // never more than the centre's own share: a sample sharper than a blurred centre (where the map
                // interpolates a depth edge) stands for one point, not for its whole cell of the disc
                let weight = lensWeight(Math.max(tap_coc, center_coc), cell);
                if (tap_far > center_far + LENS_BEHIND_EPS) weight *= behind;
                if (weight <= 0.0) continue;
                weight *= boostOf(tr, tg, tb);
                const wa = weight * (srcPx[sIdx + 3] / 255);
                sumW += weight;
                sumA += wa;
                sumR += srcPx[sIdx] * wa;
                sumG += srcPx[sIdx + 1] * wa;
                sumB += srcPx[sIdx + 2] * wa;
            }

            if (sumA > 1e-6) {
                outPx[idx] = Math.round(sumR / sumA);
                outPx[idx + 1] = Math.round(sumG / sumA);
                outPx[idx + 2] = Math.round(sumB / sumA);
            } else {
                outPx[idx] = srcPx[idx];
                outPx[idx + 1] = srcPx[idx + 1];
                outPx[idx + 2] = srcPx[idx + 2];
            }
            outPx[idx + 3] = Math.round((255 * sumA) / sumW);
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
    // the flag is set after registerGLFilter went through: at import, inside the import cycle with
    // inpaint_filters_gl.js, the call can throw (its tables are not initialised yet), and the later calls
    // (inpaint_filters_gl.js after its tables, applyFilterGL) have to try again
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
            const rMax = lensRadius(params, full);   // input pixels: full carries the scale already
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
            return lensRadius(p, full) <= 0.1;
        },
    });
    lensBlurRegistered = true;
}

try {
    registerLensBlurGL();
} catch (_) {
    // Registered when inpaint_filters_gl.js initializes
}
