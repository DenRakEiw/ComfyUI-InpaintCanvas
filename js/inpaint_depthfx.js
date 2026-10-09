// Generated from DenRakEiw/scumble renderer/editor/inpaint_depthfx.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
import { registerGLFilter } from "./inpaint_filters_gl.js";
import { SAMPLE_GLSL, passToMap, rg8View, guideView, sampleMap } from "./inpaint_maps.js";
import { SNAP_GLSL, snapField, snapParams } from "./inpaint_edges.js";
import { hexToRgb } from "./inpaint_weights.js";
import { dehazeStats } from "./inpaint_haze.js";

export { dehazeStats };

const DUMMY_RG8 = { data: new Uint8Array([0, 0]), width: 1, height: 1, channels: 2 };
const DUMMY_RGBA8 = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, channels: 4 };

/**
 * Whole-picture statistics for the haze filter: extracts representative airlight color
 * from the farthest 2% of pixels in the scene below the layer.
 *
 * @param {HTMLCanvasElement | { width: number, height: number, data?: Uint8ClampedArray|Uint8Array, getContext?: Function }} small
 * @param {{ width: number, height: number }} [size]
 * @param {{ maps?: Record<string, any>, sampleMap?: Function }} [ctx]
 * @returns {{ air: [number, number, number] }} 0..1 RGB channels
 */
export function hazeStats(small, size, ctx) {
    const map = ctx && ctx.maps && ctx.maps.depth;
    if (!map || !map.data || map.w <= 0 || map.h <= 0) return { air: [0.78, 0.82, 0.86] };

    const sx = small.width, sy = small.height;
    if (!sx || !sy) return { air: [0.78, 0.82, 0.86] };

    let data = null;
    if ("data" in small && small.data) {
        data = small.data;
    } else if (typeof small.getContext === "function") {
        try {
            data = small.getContext("2d").getImageData(0, 0, sx, sy).data;
        } catch (_) {
            return { air: [0.78, 0.82, 0.86] };
        }
    }
    if (!data) return { air: [0.78, 0.82, 0.86] };

    const sampleFn = (ctx && typeof ctx.sampleMap === "function") ? ctx.sampleMap : sampleMap;
    const dw = (size && size.width) || sx;
    const dh = (size && size.height) || sy;

    const n = sx * sy;
    const farArr = new Float32Array(n);
    const hist = new Uint32Array(256);
    let validCount = 0;

    for (let j = 0; j < sy; j++) {
        const row = j * sx;
        const docY = ((j + 0.5) / sy) * dh;
        for (let i = 0; i < sx; i++) {
            const idx = row + i;
            const a = data[idx * 4 + 3];
            if (a === 0) {
                farArr[idx] = 0;
                continue;
            }
            const docX = ((i + 0.5) / sx) * dw;
            const far = sampleFn(map, docX, docY);
            farArr[idx] = far;
            const bin = Math.max(0, Math.min(255, Math.floor(far * 255.999)));
            hist[bin]++;
            validCount++;
        }
    }

    if (validCount === 0) return { air: [0.78, 0.82, 0.86] };

    // 98th percentile
    const target = Math.floor(validCount * 0.98);
    let count = 0;
    let thresholdBin = 255;
    for (let b = 0; b < 256; b++) {
        count += hist[b];
        if (count >= target) {
            thresholdBin = b;
            break;
        }
    }
    const threshold = thresholdBin / 255;

    let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
    for (let j = 0; j < sy; j++) {
        const row = j * sx;
        for (let i = 0; i < sx; i++) {
            const idx = row + i;
            const a = data[idx * 4 + 3];
            if (a > 0 && farArr[idx] >= threshold) {
                const w = a / 255;
                sumR += (data[idx * 4] / 255) * w;
                sumG += (data[idx * 4 + 1] / 255) * w;
                sumB += (data[idx * 4 + 2] / 255) * w;
                sumW += w;
            }
        }
    }

    /** @type {[number, number, number]} */
    let air;
    if (sumW <= 0) {
        air = [0.78, 0.82, 0.86];
    } else {
        air = [sumR / sumW, sumG / sumW, sumB / sumW];
    }

    const luma = air[0] * 0.299 + air[1] * 0.587 + air[2] * 0.114;
    if (luma < 0.35) {
        air = [
            air[0] * 0.5 + 0.78 * 0.5,
            air[1] * 0.5 + 0.82 * 0.5,
            air[2] * 0.5 + 0.86 * 0.5,
        ];
    }

    return { air };
}

/**
 * CPU twin for the haze filter.
 *
 * @param {HTMLCanvasElement} src
 * @param {Record<string, any>} p
 * @param {Record<string, any>} [info]
 * @returns {HTMLCanvasElement}
 */
export function applyHaze(src, p, info) {
    const W = src.width, H = src.height;
    const map = info && info.maps && info.maps.depth;
    const amount = p.amount !== undefined ? Number(p.amount) : 50;

    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const octx = out.getContext("2d");
    if (!octx) return src;
    octx.drawImage(src, 0, 0);

    if (!map || !map.data || amount <= 0) return out;

    const start = (p.start !== undefined ? Number(p.start) : 20) / 100;
    const curve = p.curve !== undefined ? Number(p.curve) : 1.0;
    const desaturate = (p.desaturate !== undefined ? Number(p.desaturate) : 30) / 100;
    const colorMode = p.color_mode || "auto";

    let air;
    if (colorMode === "custom") {
        air = hexToRgb(p.color || "#c9d3dd");
    } else {
        air = (info && info.wholeStats && info.wholeStats.air) || [0.78, 0.82, 0.86];
    }
    const airR = air[0] * 255, airG = air[1] * 255, airB = air[2] * 255;

    const u_s = start;
    const u_k = 4.0 * (amount / 100);
    const u_curve = curve;
    const u_desat = desaturate;
    const denom = Math.max(1e-3, 1.0 - u_s);

    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;

    const origin = (info && info.full) ? (info.origin || [0, 0]) : [0, 0];
    const scale = (info && info.scale) || 1;
    const m = passToMap(map, scale);
    const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
    const sigmaR = snap[0], tau = snap[1];
    const guide = map.guide || null;

    for (let y = 0; y < H; y++) {
        const py = origin[1] + y;
        const row = y * W;
        for (let x = 0; x < W; x++) {
            const idx = (row + x) * 4;
            const px_x = origin[0] + x;

            const mx = m[0] * px_x + m[2] * py + m[4];
            const my = m[1] * px_x + m[3] * py + m[5];

            const r = px[idx] / 255;
            const g = px[idx + 1] / 255;
            const b = px[idx + 2] / 255;

            const far = snapField(map, guide, mx, my, r, g, b, sigmaR, tau);
            const xVal = Math.max(0, Math.min(1, (far - u_s) / denom));
            const t = Math.exp(-u_k * Math.pow(xVal, u_curve));

            const luma = 0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2];
            const mixDesat = u_desat * (1.0 - t);

            const rFade = px[idx] + (luma - px[idx]) * mixDesat;
            const gFade = px[idx + 1] + (luma - px[idx + 1]) * mixDesat;
            const bFade = px[idx + 2] + (luma - px[idx + 2]) * mixDesat;

            px[idx] = Math.round(rFade * t + airR * (1.0 - t));
            px[idx + 1] = Math.round(gFade * t + airG * (1.0 - t));
            px[idx + 2] = Math.round(bFade * t + airB * (1.0 - t));
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

const HAZE_GLSL = `
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float w_sstep(float a, float b, float x) {
    if (b <= a) return x >= b ? 1.0 : 0.0;
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

${SAMPLE_GLSL}
${SNAP_GLSL}

vec4 shade(vec4 c, vec2 uv) {
    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec2 mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);
    float far = snapField(u_map, u_guide, mpx, c.rgb, u_snap);
    float x = clamp((far - u_s) / max(1e-3, 1.0 - u_s), 0.0, 1.0);
    float t = exp(-u_k * pow(x, u_curve));
    vec3 grey = vec3(dot(c.rgb, LUMA));
    vec3 rgb = mix(c.rgb, grey, u_desat * (1.0 - t));
    return vec4(rgb * t + u_air * (1.0 - t), c.a);
}
`;

let hazeRegistered = false;

export function registerHazeGL() {
    if (hazeRegistered) return;
    hazeRegistered = true;
    registerGLFilter("haze", {
        uniforms: {
            u_map: "sampler2D",
            u_guide: "sampler2D",
            u_m0: "vec4",
            u_m1: "vec2",
            u_snap: "vec2",
            u_air: "vec3",
            u_s: "float",
            u_k: "float",
            u_curve: "float",
            u_desat: "float",
        },
        code: HAZE_GLSL,
        values: (params, info) => {
            const map = (info && info.maps && info.maps.depth) || null;
            const scale = (info && info.scale) || 1;
            const m = map ? passToMap(map, scale) : [1, 0, 0, 1, 0, 0];
            const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
            const colorMode = params.color_mode || "auto";
            let air;
            if (colorMode === "custom") {
                air = hexToRgb(params.color || "#c9d3dd");
            } else {
                air = (info && info.wholeStats && info.wholeStats.air) || [0.78, 0.82, 0.86];
            }
            const s = (params.start !== undefined ? Number(params.start) : 20) / 100;
            const k = 4.0 * ((params.amount !== undefined ? Number(params.amount) : 50) / 100);
            const curve = params.curve !== undefined ? Number(params.curve) : 1.0;
            const desat = (params.desaturate !== undefined ? Number(params.desaturate) : 30) / 100;
            return {
                u_map: map ? rg8View(map) : null,
                u_guide: (map && map.guide) ? guideView(map) : null,
                u_m0: [m[0], m[2], m[1], m[3]],
                u_m1: [m[4], m[5]],
                u_snap: snap,
                u_air: air,
                u_s: s,
                u_k: k,
                u_curve: curve,
                u_desat: desat,
            };
        },
        skip: (p, info) => !(info && info.maps && info.maps.depth) || (p.amount !== undefined && Number(p.amount) <= 0),
    });
}

/**
 * CPU twin for the dehaze filter.
 *
 * @param {HTMLCanvasElement} src
 * @param {Record<string, any>} p
 * @param {Record<string, any>} [info]
 * @returns {HTMLCanvasElement}
 */
export function applyDehaze(src, p, info) {
    const W = src.width, H = src.height;
    const mode = (p && p.mode) || "auto";
    const map = info && info.maps && info.maps.depth;
    const amount = (p && p.amount !== undefined ? Number(p.amount) : 50) / 100;

    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const octx = out.getContext("2d");
    if (!octx) return src;
    octx.drawImage(src, 0, 0);

    if (amount <= 0 || (mode === "depth" && (!map || !map.data))) return out;

    const stats = info && info.wholeStats;
    if (mode === "auto" && (!stats || !stats.t || !stats.w || !stats.h)) return out;

    const air = (stats && stats.air) || [0.78, 0.82, 0.86];
    const density = (p && p.density !== undefined ? Number(p.density) : 100) / 100;
    const beta = 2.5 * density;
    const protect = (p && p.protect !== undefined ? Number(p.protect) : 40) / 100;
    const K = 0.25 * protect;

    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;

    const full = (info && info.full) || [W, H];
    const origin = (info && info.full && info.origin) ? info.origin : [0, 0];
    const scale = (info && info.scale) || 1;

    let m = null, snap = [0, 0], sigmaR = 0, tau = 0, guide = null;
    if (mode === "depth") {
        m = passToMap(map, scale);
        snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];
        sigmaR = snap[0];
        tau = snap[1];
        guide = map.guide || null;
    }

    const tMap = (mode === "auto") ? { data: stats.t, w: stats.w, h: stats.h } : null;
    const tGuide = (mode === "auto") ? stats.guide : null;

    for (let y = 0; y < H; y++) {
        const py = origin[1] + y + 0.5;
        const row = y * W;
        for (let x = 0; x < W; x++) {
            const idx = (row + x) * 4;
            const px_x = origin[0] + x + 0.5;

            const r = px[idx] / 255;
            const g = px[idx + 1] / 255;
            const b = px[idx + 2] / 255;

            let t;
            if (mode === "depth") {
                const mx = m[0] * px_x + m[2] * py + m[4];
                const my = m[1] * px_x + m[3] * py + m[5];
                const far = snapField(map, guide, mx, my, r, g, b, sigmaR, tau);
                t = Math.exp(-beta * far);
            } else {
                const smallX = (px_x / full[0]) * stats.w;
                const smallY = (py / full[1]) * stats.h;
                t = snapField(tMap, tGuide, smallX, smallY, r, g, b, 0.08, 0.03);
            }

            const dm = Math.max(Math.abs(r - air[0]), Math.abs(g - air[1]), Math.abs(b - air[2]));
            const scaleFactor = Math.max(K / Math.max(dm, 1e-3), 1.0);
            t = Math.min(1.0, scaleFactor * t);
            t = Math.max(t, 0.1);

            const jr = (r - air[0]) / t + air[0];
            const jg = (g - air[1]) / t + air[1];
            const jb = (b - air[2]) / t + air[2];

            const cr = Math.max(0, Math.min(1, jr));
            const cg = Math.max(0, Math.min(1, jg));
            const cb = Math.max(0, Math.min(1, jb));

            px[idx] = Math.round(Math.max(0, Math.min(255, (r + (cr - r) * amount) * 255)));
            px[idx + 1] = Math.round(Math.max(0, Math.min(255, (g + (cg - g) * amount) * 255)));
            px[idx + 2] = Math.round(Math.max(0, Math.min(255, (b + (cb - b) * amount) * 255)));
        }
    }

    octx.putImageData(img, 0, 0);
    return out;
}

const DEHAZE_GLSL = `
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float w_sstep(float a, float b, float x) {
    if (b <= a) return x >= b ? 1.0 : 0.0;
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

${SAMPLE_GLSL}
${SNAP_GLSL}

vec4 shade(vec4 c, vec2 uv) {
    vec2 pp = pictureUv(uv) * u_pictureSize;
    float t = 1.0;
    if (u_mode == 0) {
        vec2 smallPx = pictureUv(uv) * vec2(textureSize(u_t, 0));
        t = snapField(u_t, u_tguide, smallPx, c.rgb, vec2(0.08, 0.03));
    } else {
        vec2 mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);
        t = exp(-u_beta * snapField(u_map, u_guide, mpx, c.rgb, u_snap));
    }
    float K = 0.25 * u_protect;
    vec3 d = abs(c.rgb - u_air);
    float dm = max(d.r, max(d.g, d.b));
    t = min(1.0, max(K / max(dm, 1e-3), 1.0) * t);
    t = max(t, 0.1);
    vec3 J = (c.rgb - u_air) / t + u_air;
    return vec4(mix(c.rgb, clamp(J, 0.0, 1.0), u_amount), c.a);
}
`;

let dehazeRegistered = false;

export function registerDehazeGL() {
    if (dehazeRegistered) return;
    dehazeRegistered = true;
    registerGLFilter("dehaze", {
        uniforms: {
            u_t: "sampler2D",
            u_tguide: "sampler2D",
            u_map: "sampler2D",
            u_guide: "sampler2D",
            u_m0: "vec4",
            u_m1: "vec2",
            u_snap: "vec2",
            u_air: "vec3",
            u_amount: "float",
            u_beta: "float",
            u_protect: "float",
            u_mode: "int",
        },
        code: DEHAZE_GLSL,
        values: (params, info) => {
            const stats = info && info.wholeStats;
            const map = (info && info.maps && info.maps.depth) || null;
            const scale = (info && info.scale) || 1;
            const m = map ? passToMap(map, scale) : [1, 0, 0, 1, 0, 0];
            const snap = (map && map.guide) ? (snapParams(map.meta?.snap?.strength) || [0, 0]) : [0, 0];

            const air = (stats && stats.air) || [0.78, 0.82, 0.86];
            const amount = (params.amount !== undefined ? Number(params.amount) : 50) / 100;
            const mode = (params.mode === "depth") ? 1 : 0;
            const density = (params.density !== undefined ? Number(params.density) : 100) / 100;
            const beta = 2.5 * density;
            const protect = (params.protect !== undefined ? Number(params.protect) : 40) / 100;

            let tSampler = null;
            let tGuideSampler = null;
            if (stats && stats.t && stats.w && stats.h) {
                if (!stats._tBytes) {
                    stats._tBytes = stats.t instanceof Uint8Array ? stats.t : new Uint8Array(stats.t.buffer, stats.t.byteOffset, stats.t.byteLength);
                }
                tSampler = {
                    data: stats._tBytes,
                    width: stats.w,
                    height: stats.h,
                    channels: 2,
                    static: true,
                    key: "dehaze:t:" + stats.seq,
                };
                tGuideSampler = {
                    data: stats.guide,
                    width: stats.w,
                    height: stats.h,
                    channels: 4,
                    static: true,
                    key: "dehaze:g:" + stats.seq,
                };
            } else {
                tSampler = DUMMY_RG8;
                tGuideSampler = DUMMY_RGBA8;
            }

            const mapSampler = map ? rg8View(map) : DUMMY_RG8;
            const guideSampler = (map && map.guide) ? guideView(map) : DUMMY_RGBA8;

            return {
                u_t: tSampler,
                u_tguide: tGuideSampler,
                u_map: mapSampler,
                u_guide: guideSampler,
                u_m0: [m[0], m[2], m[1], m[3]],
                u_m1: [m[4], m[5]],
                u_snap: snap,
                u_air: air,
                u_amount: amount,
                u_beta: beta,
                u_protect: protect,
                u_mode: mode,
            };
        },
        skip: (p, info) => {
            if (!p) return true;
            const amount = p.amount !== undefined ? Number(p.amount) : 50;
            if (amount <= 0) return true;
            if (p.mode === "depth" && !(info && info.maps && info.maps.depth)) return true;
            if ((!p.mode || p.mode === "auto") && !(info && info.wholeStats && info.wholeStats.t)) return true;
            return false;
        },
    });
}

try {
    registerHazeGL();
    registerDehazeGL();
} catch (_) {
    // Registered when inpaint_filters_gl.js initializes
}


