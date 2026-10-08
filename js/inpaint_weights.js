// Generated from DenRakEiw/scumble renderer/editor/inpaint_weights.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Pure weights module for range selections, filter limits and UI previews (F3 / PLAN_NIK9_BUILD §3.1)
// Holds JS functions and one GLSL string with identical maths, the Limit typedef and normaliser,
// and the u16 bilinear sampling twin. No DOM at import.

/** Rec. 601 luma coefficients */
export const LUMA = Object.freeze([0.299, 0.587, 0.114]);

/**
 * Smoothstep interpolation:
 * When b <= a: hard step (x >= b ? 1 : 0);
 * Else: cubic hermite smoothstep clamped between 0 and 1.
 *
 * @param {number} a - Start of transition
 * @param {number} b - End of transition
 * @param {number} x - Input value
 * @returns {number} 0..1
 */
export function sstep(a, b, x) {
    if (b <= a) return x >= b ? 1 : 0;
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    if (t <= 1e-14) return 0;
    if (t >= 1 - 1e-14) return 1;
    return t * t * (3 - 2 * t);
}

/**
 * @typedef {Object} Limit
 * @property {"depth" | "luma" | "color"} source - Value source
 * @property {number} lo - Low cut-off (0..1)
 * @property {number} hi - High cut-off (0..1, lo <= hi)
 * @property {number} fLo - Feather below lo (>= 0)
 * @property {number} fHi - Feather above hi (>= 0)
 * @property {boolean} invert - Whether selection is inverted
 * @property {string} [color] - Reference hex colour '#rrggbb' for source "color"
 * @property {number} [tol] - Colour tolerance 0..100
 */

/**
 * Weight for a scalar value within a soft range [lo - fLo .. hi + fHi].
 *
 * @param {number} v - Scalar value 0..1
 * @param {{ lo: number, hi: number, fLo?: number, fHi?: number, invert?: boolean }} r - Range descriptor
 * @returns {number} 0..1
 */
export function rangeWeight(v, r) {
    const fLo = r.fLo || 0;
    const fHi = r.fHi || 0;
    const wLo = fLo > 0 ? sstep(r.lo - fLo, r.lo, v) : (v >= r.lo ? 1 : 0);
    const wHi = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, v)) : (v <= r.hi ? 1 : 0);
    const w = wLo * wHi;
    return r.invert ? 1 - w : w;
}

/**
 * Converts sRGB (0..1) to film.points opponent colour space [L, r - L, b - L].
 *
 * @param {number} r - Red 0..1
 * @param {number} g - Green 0..1
 * @param {number} b - Blue 0..1
 * @returns {[number, number, number]} [L, a, b]
 */
export function opp(r, g, b) {
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    return [L, r - L, b - L];
}

/**
 * Colour similarity metric identical to film.points:
 * exp(-d2 / (2 * s^2)), d2 = dL^2 + 4 * (da^2 + db^2), s = 0.04 + (tol / 100) * 0.6.
 *
 * @param {number} r - Red 0..1
 * @param {number} g - Green 0..1
 * @param {number} b - Blue 0..1
 * @param {[number, number, number] | number[]} ref - Opponent reference colour [L, a, b]
 * @param {number} tol - Tolerance 0..100
 * @returns {number} 0..1
 */
export function colourSimilarity(r, g, b, ref, tol) {
    const o3 = opp(r, g, b);
    const d0 = o3[0] - ref[0];
    const d1 = o3[1] - ref[1];
    const d2 = o3[2] - ref[2];
    const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
    const s = 0.04 + Math.max(0, Math.min(1, (tol || 0) / 100)) * 0.6;
    return Math.exp(-dd / (2 * s * s));
}

/**
 * Parses '#rrggbb' or '#rgb' to [r, g, b] in 0..1.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
    if (!hex || typeof hex !== "string") return [1, 1, 1];
    const clean = hex.replace(/^#/, "");
    if (clean.length === 6) {
        return [
            parseInt(clean.slice(0, 2), 16) / 255,
            parseInt(clean.slice(2, 4), 16) / 255,
            parseInt(clean.slice(4, 6), 16) / 255,
        ];
    }
    if (clean.length === 3) {
        return [
            parseInt(clean[0] + clean[0], 16) / 255,
            parseInt(clean[1] + clean[1], 16) / 255,
            parseInt(clean[2] + clean[2], 16) / 255,
        ];
    }
    return [1, 1, 1];
}

/**
 * Evaluates the source value 0..1 for a given Limit descriptor.
 *
 * @param {Limit} limit
 * @param {number} r - Red 0..1
 * @param {number} g - Green 0..1
 * @param {number} b - Blue 0..1
 * @param {number} [mapValue=0] - Depth / feature map value 0..1
 * @returns {number} 0..1
 */
export function sourceValue(limit, r, g, b, mapValue = 0) {
    if (!limit) return 0;
    if (limit.source === "depth") {
        return Math.max(0, Math.min(1, mapValue));
    }
    if (limit.source === "luma") {
        return Math.max(0, Math.min(1, 0.299 * r + 0.587 * g + 0.114 * b));
    }
    if (limit.source === "color") {
        const rgb = hexToRgb(limit.color || "#ffffff");
        const ref = opp(rgb[0], rgb[1], rgb[2]);
        return colourSimilarity(r, g, b, ref, limit.tol ?? 30);
    }
    return 0;
}

/**
 * Calculates final weight 0..1 by passing the evaluated source value through rangeWeight.
 *
 * @param {Limit} limit
 * @param {number} r - Red 0..1
 * @param {number} g - Green 0..1
 * @param {number} b - Blue 0..1
 * @param {number} [mapValue=0] - Feature map value 0..1
 * @returns {number} 0..1
 */
export function limitWeight(limit, r, g, b, mapValue = 0) {
    if (!limit) return 1;
    const v = sourceValue(limit, r, g, b, mapValue);
    return rangeWeight(v, limit);
}

/**
 * Precomputes an 8-bit lookup table of weights for an 8-bit luma source.
 *
 * @param {{ lo: number, hi: number, fLo?: number, fHi?: number, invert?: boolean }} r
 * @returns {Uint8Array} 256 bytes
 */
export function weightTable(r) {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        t[i] = Math.round(255 * rangeWeight(i / 255, r));
    }
    return t;
}

/**
 * Normalises an input limit descriptor into a clean, validated Limit object.
 * Returns null for null/false. Clamps values to [0, 1], swaps lo > hi,
 * and validates source type. Always returns a fresh object.
 *
 * @param {any} v
 * @returns {Limit | null}
 */
export function normalizeLimit(v) {
    if (!v || v === false) return null;
    if (typeof v !== "object") throw new Error("limit must be an object");

    const source = v.source;
    if (source !== "depth" && source !== "luma" && source !== "color") {
        throw new Error("limit.source must be depth, luma or color");
    }

    let lo = Math.max(0, Math.min(1, Number(v.lo ?? 0)));
    let hi = Math.max(0, Math.min(1, Number(v.hi ?? 1)));
    if (lo > hi) {
        const tmp = lo;
        lo = hi;
        hi = tmp;
    }

    const fLo = Math.max(0, Math.min(1, Number(v.fLo ?? 0)));
    const fHi = Math.max(0, Math.min(1, Number(v.fHi ?? 0)));
    const invert = !!v.invert;

    /** @type {Limit} */
    const res = { source, lo, hi, fLo, fHi, invert };

    if (source === "color") {
        res.color = typeof v.color === "string" ? v.color : "#ffffff";
        res.tol = Math.max(0, Math.min(100, Number(v.tol ?? 30)));
    }

    return res;
}

/**
 * Bilinear sampling of a 16-bit unsigned integer map (0..65535) with pixel centres at +0.5
 * and edge clamping.
 *
 * @param {Uint16Array} data - Map buffer
 * @param {number} w - Map width
 * @param {number} h - Map height
 * @param {number} px - X coordinate in map space
 * @param {number} py - Y coordinate in map space
 * @returns {number} Sampled value normalised to 0..1
 */
export function u16Bilinear(data, w, h, px, py) {
    if (!data || w <= 0 || h <= 0) return 0;

    // Coordinate relative to pixel centers (center of pixel 0 is at +0.5)
    const u = px - 0.5;
    const v = py - 0.5;

    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const fx = u - x0;
    const fy = v - y0;

    // Clamp coordinates to grid bounds
    const cx0 = Math.max(0, Math.min(w - 1, x0));
    const cx1 = Math.max(0, Math.min(w - 1, x1));
    const cy0 = Math.max(0, Math.min(h - 1, y0));
    const cy1 = Math.max(0, Math.min(h - 1, y1));

    const s00 = data[cy0 * w + cx0] / 65535;
    const s10 = data[cy0 * w + cx1] / 65535;
    const s01 = data[cy1 * w + cx0] / 65535;
    const s11 = data[cy1 * w + cx1] / 65535;

    const top = s00 + fx * (s10 - s00);
    const bot = s01 + fx * (s11 - s01);

    return top + fy * (bot - top);
}

/**
 * GLSL functions mirroring the JS formulas with a w_ prefix to avoid collisions.
 */
export const WEIGHTS_GLSL = `
const vec3 W_LUMA = vec3(0.299, 0.587, 0.114);

float w_sstep(float a, float b, float x) {
    if (b <= a) return x >= b ? 1.0 : 0.0;
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

float w_range(float v, vec4 r /* lo, hi, fLo, fHi */, bool inv) {
    float wLo = r.z > 0.0 ? w_sstep(r.x - r.z, r.x, v) : (v >= r.x ? 1.0 : 0.0);
    float wHi = r.w > 0.0 ? (1.0 - w_sstep(r.y, r.y + r.w, v)) : (v <= r.y ? 1.0 : 0.0);
    float w = wLo * wHi;
    return inv ? 1.0 - w : w;
}

vec3 w_opp(vec3 c) {
    float L = dot(c, W_LUMA);
    return vec3(L, c.r - L, c.b - L);
}

float w_colour(vec3 c, vec3 ref /* opp */, float tol) {
    vec3 o3 = w_opp(c);
    vec3 dc = o3 - ref;
    float d2 = dc.x * dc.x + 4.0 * (dc.y * dc.y + dc.z * dc.z);
    float s = 0.04 + clamp(tol / 100.0, 0.0, 1.0) * 0.6;
    return exp(-d2 / (2.0 * s * s));
}

// source: 0 = depth, 1 = luma, 2 = color
float w_limit(int source, vec3 c, float mapV, vec4 r, bool inv, vec3 ref, float tol) {
    float v = 0.0;
    if (source == 0) {
        v = mapV;
    } else if (source == 1) {
        v = dot(c, W_LUMA);
    } else {
        v = w_colour(c, ref, tol);
    }
    return w_range(v, r, inv);
}
`;
