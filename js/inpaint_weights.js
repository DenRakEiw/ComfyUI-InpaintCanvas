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
    const wLo = fLo > 0 ? sstep(r.lo - fLo, r.lo, v) : (v >= r.lo - 1e-12 ? 1 : 0);
    const wHi = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, v)) : (v <= r.hi + 1e-12 ? 1 : 0);
    const w = wLo * wHi;
    return r.invert ? 1 - w : w;
}

/**
 * Classifies a document tile whose window texels lie in `[vMin, vMax]` (0..1) against a soft range `r`
 * (`docs/PLAN_WASM_BUILD.md` §4.8, K21). Because bilinear sampling and joint-bilateral snap are convex combinations
 * of window texels, every sample in the tile lies in `[vMin, vMax]`.
 *
 * @param {number} vMin - Minimum normalized value in the tile's window (0..1)
 * @param {number} vMax - Maximum normalized value in the tile's window (0..1)
 * @param {{ lo: number, hi: number, fLo?: number, fHi?: number, invert?: boolean }} r - Range descriptor
 * @param {boolean} [invert=false] - Additional job-level inversion (e.g. intersect mode)
 * @returns {"full" | "empty" | "compute"}
 */
export function rangeTileClass(vMin, vMax, r, invert = false) {
    if (!(vMin <= vMax) || !r) return "compute";
    const fLo = r.fLo || 0;
    const fHi = r.fHi || 0;
    const wLoMin = fLo > 0 ? sstep(r.lo - fLo, r.lo, vMin) : (vMin >= r.lo - 1e-12 ? 1 : 0);
    const wLoMax = fLo > 0 ? sstep(r.lo - fLo, r.lo, vMax) : (vMax >= r.lo - 1e-12 ? 1 : 0);
    const wHiMin = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, vMin)) : (vMin <= r.hi + 1e-12 ? 1 : 0);
    const wHiMax = fHi > 0 ? (1 - sstep(r.hi, r.hi + fHi, vMax)) : (vMax <= r.hi + 1e-12 ? 1 : 0);
    const inv = Boolean(r.invert) !== Boolean(invert);
    if (wLoMin === 1 && wHiMax === 1) return inv ? "empty" : "full";
    if (wLoMax === 0 || wHiMin === 0) return inv ? "full" : "empty";
    return "compute";
}

/**
 * Computes `{ tiles, bounds, alphaSum }` for the `"full"` (or `1`) tiles of one document tile row `ty`
 * (`docs/PLAN_WASM_BUILD.md` §4.8, K21): 255 per in-image pixel, the exact bounds and `{ tx, ty, full: true }` tiles
 * as `inpaint_worker.js` `rangeSelectJob` returns them. Shared by the window (for rows that post no job), the worker
 * (for full tiles in a row that posts a job), and tests.
 *
 * @param {number} W - Document width
 * @param {number} H - Document height
 * @param {number} ty - Tile row index
 * @param {ArrayLike<string | number>} rowClasses - Per-column class ("full"|"empty"|"compute" or 1|0|2)
 * @param {number} [tile=256] - Tile side in pixels
 * @returns {{ tiles: Array<{ tx: number, ty: number, full: boolean }>, bounds: number[] | null, alphaSum: number }}
 */
export function rangeRowBookkeeping(W, H, ty, rowClasses, tile = 256) {
    const tileY0 = ty * tile;
    const tileY1 = Math.min(tileY0 + tile, H);
    const th = Math.max(0, tileY1 - tileY0);
    const tiles = [];
    let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
    let alphaSum = 0;
    if (th > 0 && rowClasses) {
        for (let tx = 0; tx < rowClasses.length; tx++) {
            const cls = rowClasses[tx];
            if (cls !== "full" && cls !== 1) continue;
            const tileX0 = tx * tile;
            const tileX1 = Math.min(tileX0 + tile, W);
            const tw = Math.max(0, tileX1 - tileX0);
            if (tw <= 0) continue;
            alphaSum += 255 * tw * th;
            tiles.push({ tx, ty, full: true });
            if (tileX0 < bX0) bX0 = tileX0;
            if (tileY0 < bY0) bY0 = tileY0;
            if (tileX1 > bX1) bX1 = tileX1;
            if (tileY1 > bY1) bY1 = tileY1;
        }
    }
    const bounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
    return { tiles, bounds, alphaSum };
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
 * For new input (a command, the selection): a field that is not a finite number and a colour that is
 * not #rgb / #rrggbb throw with a readable message. `opts.stored` is `normalizeStoredLimit`.
 *
 * @param {any} v
 * @param {{ stored?: boolean }} [opts]
 * @returns {Limit | null}
 */
export function normalizeLimit(v, opts) {
    if (!v || v === false) return null;
    if (typeof v !== "object") throw new Error("limit must be an object");

    const source = v.source;
    if (source !== "depth" && source !== "luma" && source !== "color") {
        throw new Error("limit.source must be depth, luma or color");
    }

    const stored = !!(opts && opts.stored);
    const numField = (name, val, def) => {
        if (stored) return Number(val ?? def);
        if (val == null) return def;
        const n = typeof val === "number" ? val : (typeof val === "string" && val.trim() !== "" ? Number(val) : NaN);
        if (!Number.isFinite(n)) throw new Error(`limit.${name} must be a finite number (got ${JSON.stringify(val)})`);
        return n;
    };

    let lo = Math.max(0, Math.min(1, numField("lo", v.lo, 0)));
    let hi = Math.max(0, Math.min(1, numField("hi", v.hi, 1)));
    if (lo > hi) {
        const tmp = lo;
        lo = hi;
        hi = tmp;
    }

    const fLo = Math.max(0, Math.min(1, numField("fLo", v.fLo, 0)));
    const fHi = Math.max(0, Math.min(1, numField("fHi", v.fHi, 0)));
    const invert = !!v.invert;

    /** @type {Limit} */
    const res = { source, lo, hi, fLo, fHi, invert };

    if (source === "color") {
        if (stored) {
            res.color = typeof v.color === "string" ? v.color : "#ffffff";
        } else if (v.color != null) {
            if (typeof v.color !== "string" || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.color)) {
                throw new Error(`limit.color must be #rgb or #rrggbb (got ${JSON.stringify(v.color)})`);
            }
            res.color = v.color;
        } else {
            res.color = "#ffffff";
        }
        res.tol = Math.max(0, Math.min(100, numField("tol", v.tol, 30)));
    }

    return res;
}

/**
 * The limit a layer or a document already holds, on the draw and export paths and in the panel: no field or colour
 * throws, so a document keeps drawing as it did. Commands wrote any colour string into documents up to 0.1.52 (`ff2d2d`
 * without the #, which `hexToRgb` reads correctly); the refusal is for new input only.
 *
 * @param {any} v
 * @returns {Limit | null}
 */
export function normalizeStoredLimit(v) {
    return normalizeLimit(v, { stored: true });
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
    float wLo = r.z > 0.0 ? w_sstep(r.x - r.z, r.x, v) : (v >= r.x - 1e-5 ? 1.0 : 0.0);
    float wHi = r.w > 0.0 ? (1.0 - w_sstep(r.y, r.y + r.w, v)) : (v <= r.y + 1e-5 ? 1.0 : 0.0);
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
