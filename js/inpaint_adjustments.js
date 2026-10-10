// Generated from DenRakEiw/scumble renderer/editor/inpaint_adjustments.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
/**
 * Vibrance, Gradient Map, Threshold, and Posterize adjustment filters.
 *
 * Pure mathematical functions and GLSL shader twins.
 * No DOM at import: runs under plain Node, in Web Workers, and in the renderer.
 * Pure ASCII.
 */

export const LUMA_601 = [0.299, 0.587, 0.114];

export const GRADIENT_MAP_PRESETS = {
    cyberpunk: ["#051026", "#00e5ff", "#ff0077"],
    sunset: ["#1a0525", "#b71540", "#f6b93b", "#fcf8ec"],
    teal_orange: ["#0a2228", "#2c7873", "#d98236", "#fbe3b5"],
    sepia: ["#1c120c", "#704214", "#c29b62", "#f4ecd8"],
    infrared: ["#080820", "#400060", "#ff4060", "#ffffff"],
    bw_contrast: ["#000000", "#202020", "#c0c0c0", "#ffffff"],
};

/**
 * Convert hex string #rgb or #rrggbb to [r, g, b] in 0..1.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
    if (typeof hex !== "string") return [0, 0, 0];
    const s = hex.replace(/^#/, "");
    if (s.length === 3) {
        const r = parseInt(s[0] + s[0], 16) / 255;
        const g = parseInt(s[1] + s[1], 16) / 255;
        const b = parseInt(s[2] + s[2], 16) / 255;
        return [r, g, b];
    }
    if (s.length >= 6) {
        const r = parseInt(s.slice(0, 2), 16) / 255;
        const g = parseInt(s.slice(2, 4), 16) / 255;
        const b = parseInt(s.slice(4, 6), 16) / 255;
        return [r, g, b];
    }
    return [0, 0, 0];
}

/**
 * Pure vibrance math for a single pixel.
 *
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {number} [vibrance=0] -100..100
 * @param {number} [saturation=0] -100..100
 * @returns {[number, number, number]}
 */
export function vibrancePixel(r, g, b, vibrance = 0, saturation = 0) {
    const luma = LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx - mn;
    const vAmt = vibrance / 100.0;
    const sAmt = saturation / 100.0;
    let vFactor = vAmt > 0.0 ? vAmt * (1.0 - sat) : vAmt * sat;
    if (r > g && g > b) vFactor *= 0.5;
    const factor = Math.max(-1.0, Math.min(3.0, vFactor + sAmt));
    const k = 1.0 + factor;
    const resR = Math.max(0.0, Math.min(1.0, luma + (r - luma) * k));
    const resG = Math.max(0.0, Math.min(1.0, luma + (g - luma) * k));
    const resB = Math.max(0.0, Math.min(1.0, luma + (b - luma) * k));
    return [resR, resG, resB];
}

/**
 * Check if vibrance parameters are identity (no change).
 *
 * @param {any} params
 * @returns {boolean}
 */
export function vibranceIdentity(params) {
    if (!params || typeof params !== "object") return true;
    const v = params.vibrance != null ? +params.vibrance : 0;
    const s = params.saturation != null ? +params.saturation : 0;
    return v === 0 && s === 0;
}

export const VIBRANCE_GLSL = `
vec4 shade(vec4 c, vec2 uv) {
    float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float vAmt = u_vibrance / 100.0;
    float sAmt = u_saturation / 100.0;
    float vFactor = vAmt > 0.0 ? vAmt * (1.0 - sat) : vAmt * sat;
    if (c.r > c.g && c.g > c.b) vFactor *= 0.5;
    float factor = clamp(vFactor + sAmt, -1.0, 3.0);
    vec3 res = clamp(mix(vec3(luma), c.rgb, 1.0 + factor), 0.0, 1.0);
    return vec4(res, c.a);
}
`;

export const VIBRANCE_UNIFORMS = {
    u_vibrance: "float",
    u_saturation: "float",
};

/**
 * @param {any} params
 * @returns {{ u_vibrance: number, u_saturation: number }}
 */
export function vibranceUniforms(params) {
    const p = params || {};
    return {
        u_vibrance: p.vibrance != null ? +p.vibrance : 0,
        u_saturation: p.saturation != null ? +p.saturation : 0,
    };
}

/**
 * Interpolate gradient stops at position t in [0, 1].
 *
 * @param {Array<[number, number, number]>} stops
 * @param {number} t
 * @returns {[number, number, number]}
 */
export function sampleGradient(stops, t) {
    const n = stops.length;
    if (n === 0) return [0, 0, 0];
    if (n === 1) return stops[0];
    const clampedT = Math.max(0.0, Math.min(1.0, t));
    if (n === 2) {
        const a = stops[0], b = stops[1];
        return [
            a[0] + (b[0] - a[0]) * clampedT,
            a[1] + (b[1] - a[1]) * clampedT,
            a[2] + (b[2] - a[2]) * clampedT,
        ];
    }
    if (n === 3) {
        if (clampedT < 0.5) {
            const u = clampedT * 2.0;
            const a = stops[0], b = stops[1];
            return [
                a[0] + (b[0] - a[0]) * u,
                a[1] + (b[1] - a[1]) * u,
                a[2] + (b[2] - a[2]) * u,
            ];
        }
        const u = (clampedT - 0.5) * 2.0;
        const a = stops[1], b = stops[2];
        return [
            a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u,
        ];
    }
    const seg1 = 1.0 / 3.0;
    const seg2 = 2.0 / 3.0;
    if (clampedT < seg1) {
        const u = clampedT * 3.0;
        const a = stops[0], b = stops[1];
        return [
            a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u,
        ];
    }
    if (clampedT < seg2) {
        const u = (clampedT - seg1) * 3.0;
        const a = stops[1], b = stops[2];
        return [
            a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u,
        ];
    }
    const u = (clampedT - seg2) * 3.0;
    const a = stops[2], b = stops[3];
    return [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
    ];
}

/**
 * Pure gradient map math for a single pixel.
 *
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {any} [params]
 * @returns {[number, number, number]}
 */
export function gradientMapPixel(r, g, b, params) {
    const p = params || {};
    const presetId = p.preset || "cyberpunk";
    let hexStops;
    if (presetId === "custom") {
        hexStops = [p.shadow || "#000000", p.highlight || "#ffffff"];
    } else {
        hexStops = GRADIENT_MAP_PRESETS[presetId] || GRADIENT_MAP_PRESETS.cyberpunk;
    }
    const stops = hexStops.map(hexToRgb);
    const luma = Math.max(0.0, Math.min(1.0, LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b));
    const t = p.reverse ? (1.0 - luma) : luma;
    const grad = sampleGradient(stops, t);
    const op = (p.opacity != null ? Math.max(0, Math.min(100, +p.opacity)) : 100) / 100.0;
    return [
        Math.max(0.0, Math.min(1.0, r + (grad[0] - r) * op)),
        Math.max(0.0, Math.min(1.0, g + (grad[1] - g) * op)),
        Math.max(0.0, Math.min(1.0, b + (grad[2] - b) * op)),
    ];
}

/**
 * @param {any} params
 * @returns {boolean}
 */
export function gradientMapIdentity(params) {
    if (!params || typeof params !== "object") return false;
    return params.opacity != null && +params.opacity === 0;
}

export const GRADIENT_MAP_GLSL = `
vec4 shade(vec4 c, vec2 uv) {
    float luma = clamp(dot(c.rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
    float t = u_reverse ? (1.0 - luma) : luma;
    vec3 grad;
    if (u_numStops == 2) {
        grad = mix(u_stop0, u_stop1, t);
    } else if (u_numStops == 3) {
        if (t < 0.5) {
            grad = mix(u_stop0, u_stop1, t * 2.0);
        } else {
            grad = mix(u_stop1, u_stop2, (t - 0.5) * 2.0);
        }
    } else {
        if (t < (1.0 / 3.0)) {
            grad = mix(u_stop0, u_stop1, t * 3.0);
        } else if (t < (2.0 / 3.0)) {
            grad = mix(u_stop1, u_stop2, (t - (1.0 / 3.0)) * 3.0);
        } else {
            grad = mix(u_stop2, u_stop3, (t - (2.0 / 3.0)) * 3.0);
        }
    }
    vec3 res = mix(c.rgb, grad, u_opacity / 100.0);
    return vec4(clamp(res, 0.0, 1.0), c.a);
}
`;

export const GRADIENT_MAP_UNIFORMS = {
    u_stop0: "vec3",
    u_stop1: "vec3",
    u_stop2: "vec3",
    u_stop3: "vec3",
    u_numStops: "int",
    u_opacity: "float",
    u_reverse: "bool",
};

/**
 * @param {any} params
 * @returns {{ u_stop0: [number, number, number], u_stop1: [number, number, number], u_stop2: [number, number, number], u_stop3: [number, number, number], u_numStops: number, u_opacity: number, u_reverse: boolean }}
 */
export function gradientMapUniforms(params) {
    const p = params || {};
    const presetId = p.preset || "cyberpunk";
    let hexStops;
    if (presetId === "custom") {
        hexStops = [p.shadow || "#000000", p.highlight || "#ffffff"];
    } else {
        hexStops = GRADIENT_MAP_PRESETS[presetId] || GRADIENT_MAP_PRESETS.cyberpunk;
    }
    const stops = hexStops.map(hexToRgb);
    const stop0 = stops[0] || [0, 0, 0];
    const stop1 = stops[1] || stop0;
    const stop2 = stops[2] || stop1;
    const stop3 = stops[3] || stop2;
    const numStops = stops.length;
    const opacity = p.opacity != null ? Math.max(0, Math.min(100, +p.opacity)) : 100;
    const reverse = !!p.reverse;
    return {
        u_stop0: stop0,
        u_stop1: stop1,
        u_stop2: stop2,
        u_stop3: stop3,
        u_numStops: numStops,
        u_opacity: opacity,
        u_reverse: reverse,
    };
}

/**
 * Pure threshold math for a single pixel.
 *
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {number} [level=128] 1..254
 * @returns {[number, number, number]}
 */
export function thresholdPixel(r, g, b, level = 128) {
    const luma = LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b;
    const threshold = level / 255.0;
    const v = luma >= threshold ? 1.0 : 0.0;
    return [v, v, v];
}

export const THRESHOLD_GLSL = `
vec4 shade(vec4 c, vec2 uv) {
    float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    vec3 res = luma >= (u_level / 255.0) ? vec3(1.0) : vec3(0.0);
    return vec4(res, c.a);
}
`;

export const THRESHOLD_UNIFORMS = {
    u_level: "float",
};

/**
 * @param {any} params
 * @returns {{ u_level: number }}
 */
export function thresholdUniforms(params) {
    const p = params || {};
    const level = p.level != null ? +p.level : 128;
    return {
        u_level: Math.max(1, Math.min(254, level)),
    };
}

/**
 * Pure posterize math for a single pixel.
 *
 * @param {number} r 0..1
 * @param {number} g 0..1
 * @param {number} b 0..1
 * @param {number} [levels=4] 2..32
 * @returns {[number, number, number]}
 */
export function posterizePixel(r, g, b, levels = 4) {
    const stepVal = Math.max(2, Math.min(32, Math.round(levels))) - 1;
    const outR = Math.min(1.0, Math.max(0.0, Math.floor(r * stepVal + 0.5) / stepVal));
    const outG = Math.min(1.0, Math.max(0.0, Math.floor(g * stepVal + 0.5) / stepVal));
    const outB = Math.min(1.0, Math.max(0.0, Math.floor(b * stepVal + 0.5) / stepVal));
    return [outR, outG, outB];
}

export const POSTERIZE_GLSL = `
vec4 shade(vec4 c, vec2 uv) {
    float stepVal = max(2.0, u_levels) - 1.0;
    vec3 res = floor(c.rgb * stepVal + 0.5) / stepVal;
    return vec4(clamp(res, 0.0, 1.0), c.a);
}
`;

export const POSTERIZE_UNIFORMS = {
    u_levels: "float",
};

/**
 * @param {any} params
 * @returns {{ u_levels: number }}
 */
export function posterizeUniforms(params) {
    const p = params || {};
    const levels = p.levels != null ? +p.levels : 4;
    return {
        u_levels: Math.max(2, Math.min(32, levels)),
    };
}

/**
 * Canvas creation helper: no DOM at import time.
 *
 * @param {number} w
 * @param {number} h
 * @returns {any}
 */
function makeCanvas(w, h) {
    if (typeof document !== "undefined" && document.createElement) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, w | 0);
        c.height = Math.max(1, h | 0);
        return c;
    }
    // @ts-ignore
    if (typeof OffscreenCanvas !== "undefined") {
        // @ts-ignore
        return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
    }
    throw new Error("No canvas implementation available in this environment");
}

/**
 * @param {any} src
 * @returns {{ out: any, octx: any, img: any, px: Uint8ClampedArray }}
 */
function openPixels(src) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    if (!octx) throw new Error("Could not get 2d context");
    octx.drawImage(src, 0, 0);
    const img = octx.getImageData(0, 0, W, H);
    return { out, octx, img, px: img.data };
}

/**
 * @param {any} src
 * @returns {any}
 */
function copyCanvas(src) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    if (octx) octx.drawImage(src, 0, 0);
    return out;
}

/**
 * Apply vibrance and saturation adjustment to canvas src.
 *
 * @param {any} src
 * @param {any} params
 * @returns {any}
 */
export function applyVibrance(src, params) {
    if (vibranceIdentity(params)) return copyCanvas(src);
    const { out, octx, img, px } = openPixels(src);
    const p = params || {};
    const vibrance = p.vibrance != null ? Math.max(-100, Math.min(100, +p.vibrance)) : 0;
    const saturation = p.saturation != null ? Math.max(-100, Math.min(100, +p.saturation)) : 0;
    const vAmt = vibrance / 100.0;
    const sAmt = saturation / 100.0;

    for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255.0;
        const g = px[i + 1] / 255.0;
        const b = px[i + 2] / 255.0;
        const luma = LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx - mn;
        let vFactor = vAmt > 0.0 ? vAmt * (1.0 - sat) : vAmt * sat;
        if (r > g && g > b) vFactor *= 0.5;
        const factor = Math.max(-1.0, Math.min(3.0, vFactor + sAmt));
        const k = 1.0 + factor;
        const outR = Math.max(0.0, Math.min(1.0, luma + (r - luma) * k));
        const outG = Math.max(0.0, Math.min(1.0, luma + (g - luma) * k));
        const outB = Math.max(0.0, Math.min(1.0, luma + (b - luma) * k));
        px[i] = Math.round(outR * 255.0);
        px[i + 1] = Math.round(outG * 255.0);
        px[i + 2] = Math.round(outB * 255.0);
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/**
 * Apply gradient map adjustment to canvas src.
 *
 * @param {any} src
 * @param {any} params
 * @returns {any}
 */
export function applyGradientMap(src, params) {
    if (gradientMapIdentity(params)) return copyCanvas(src);
    const { out, octx, img, px } = openPixels(src);
    const p = params || {};
    const presetId = p.preset || "cyberpunk";
    let hexStops;
    if (presetId === "custom") {
        hexStops = [p.shadow || "#000000", p.highlight || "#ffffff"];
    } else {
        hexStops = GRADIENT_MAP_PRESETS[presetId] || GRADIENT_MAP_PRESETS.cyberpunk;
    }
    const stops = hexStops.map(hexToRgb);
    const numStops = stops.length;
    const stop0 = stops[0] || [0, 0, 0];
    const stop1 = stops[1] || stop0;
    const stop2 = stops[2] || stop1;
    const stop3 = stops[3] || stop2;
    const reverse = !!p.reverse;
    const opacity = p.opacity != null ? Math.max(0, Math.min(100, +p.opacity)) : 100;
    const op = opacity / 100.0;

    for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255.0;
        const g = px[i + 1] / 255.0;
        const b = px[i + 2] / 255.0;
        const luma = Math.max(0.0, Math.min(1.0, LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b));
        const t = reverse ? (1.0 - luma) : luma;
        let gr = 0, gg = 0, gb = 0;
        if (numStops === 2) {
            gr = stop0[0] + (stop1[0] - stop0[0]) * t;
            gg = stop0[1] + (stop1[1] - stop0[1]) * t;
            gb = stop0[2] + (stop1[2] - stop0[2]) * t;
        } else if (numStops === 3) {
            if (t < 0.5) {
                const u = t * 2.0;
                gr = stop0[0] + (stop1[0] - stop0[0]) * u;
                gg = stop0[1] + (stop1[1] - stop0[1]) * u;
                gb = stop0[2] + (stop1[2] - stop0[2]) * u;
            } else {
                const u = (t - 0.5) * 2.0;
                gr = stop1[0] + (stop2[0] - stop1[0]) * u;
                gg = stop1[1] + (stop2[1] - stop1[1]) * u;
                gb = stop1[2] + (stop2[2] - stop1[2]) * u;
            }
        } else {
            if (t < (1.0 / 3.0)) {
                const u = t * 3.0;
                gr = stop0[0] + (stop1[0] - stop0[0]) * u;
                gg = stop0[1] + (stop1[1] - stop0[1]) * u;
                gb = stop0[2] + (stop1[2] - stop0[2]) * u;
            } else if (t < (2.0 / 3.0)) {
                const u = (t - (1.0 / 3.0)) * 3.0;
                gr = stop1[0] + (stop2[0] - stop1[0]) * u;
                gg = stop1[1] + (stop2[1] - stop1[1]) * u;
                gb = stop1[2] + (stop2[2] - stop1[2]) * u;
            } else {
                const u = (t - (2.0 / 3.0)) * 3.0;
                gr = stop2[0] + (stop3[0] - stop2[0]) * u;
                gg = stop2[1] + (stop3[1] - stop2[1]) * u;
                gb = stop2[2] + (stop3[2] - stop2[2]) * u;
            }
        }
        const outR = r + (gr - r) * op;
        const outG = g + (gg - g) * op;
        const outB = b + (gb - b) * op;
        px[i] = Math.round(Math.max(0.0, Math.min(1.0, outR)) * 255.0);
        px[i + 1] = Math.round(Math.max(0.0, Math.min(1.0, outG)) * 255.0);
        px[i + 2] = Math.round(Math.max(0.0, Math.min(1.0, outB)) * 255.0);
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/**
 * Apply threshold adjustment to canvas src.
 *
 * @param {any} src
 * @param {any} params
 * @returns {any}
 */
export function applyThreshold(src, params) {
    const { out, octx, img, px } = openPixels(src);
    const p = params || {};
    const level = p.level != null ? Math.max(1, Math.min(254, +p.level)) : 128;
    const threshold = level / 255.0;

    for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255.0;
        const g = px[i + 1] / 255.0;
        const b = px[i + 2] / 255.0;
        const luma = LUMA_601[0] * r + LUMA_601[1] * g + LUMA_601[2] * b;
        const v = luma >= threshold ? 255 : 0;
        px[i] = v;
        px[i + 1] = v;
        px[i + 2] = v;
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/**
 * Apply posterize adjustment to canvas src.
 *
 * @param {any} src
 * @param {any} params
 * @returns {any}
 */
export function applyPosterize(src, params) {
    const { out, octx, img, px } = openPixels(src);
    const p = params || {};
    const levels = p.levels != null ? Math.max(2, Math.min(32, Math.round(+p.levels))) : 4;
    const stepVal = levels - 1;

    for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255.0;
        const g = px[i + 1] / 255.0;
        const b = px[i + 2] / 255.0;
        const outR = Math.floor(r * stepVal + 0.5) / stepVal;
        const outG = Math.floor(g * stepVal + 0.5) / stepVal;
        const outB = Math.floor(b * stepVal + 0.5) / stepVal;
        px[i] = Math.round(Math.max(0.0, Math.min(1.0, outR)) * 255.0);
        px[i + 1] = Math.round(Math.max(0.0, Math.min(1.0, outG)) * 255.0);
        px[i + 2] = Math.round(Math.max(0.0, Math.min(1.0, outB)) * 255.0);
    }
    octx.putImageData(img, 0, 0);
    return out;
}
