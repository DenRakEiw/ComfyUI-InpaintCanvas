// Generated from DenRakEiw/scumble renderer/editor/blend_modes.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
/**
 * Blend mode registry: single source of truth for blend modes across the editor,
 * worker jobs, WebGL compositor, PSD/ORA export/import, and document persistence.
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   group: "normal"|"darken"|"lighten"|"contrast"|"inversion"|"component",
 *   op: number,
 *   dither?: boolean,
 *   canvas: string|null,
 *   psd: string,
 *   ora: string,
 *   oraRead: string[],
 *   reader: number
 * }} BlendRow
 */

/** @type {readonly BlendRow[]} */
export const BLENDS = Object.freeze([
    // Normal
    Object.freeze({ id: "normal", label: "Normal", group: "normal", op: 0, canvas: "source-over", psd: "norm", ora: "svg:src-over", oraRead: [], reader: 1 }),
    Object.freeze({ id: "dissolve", label: "Dissolve", group: "normal", op: 0, dither: true, canvas: null, psd: "diss", ora: "scumble:dissolve", oraRead: ["krita:dissolve"], reader: 5 }),
    // Darken
    Object.freeze({ id: "darken", label: "Darken", group: "darken", op: 8, canvas: "darken", psd: "dark", ora: "svg:darken", oraRead: [], reader: 1 }),
    Object.freeze({ id: "multiply", label: "Multiply", group: "darken", op: 5, canvas: "multiply", psd: "mul ", ora: "svg:multiply", oraRead: [], reader: 1 }),
    Object.freeze({ id: "color-burn", label: "Colour burn", group: "darken", op: 21, canvas: null, psd: "idiv", ora: "svg:color-burn", oraRead: [], reader: 5 }),
    Object.freeze({ id: "linear-burn", label: "Linear burn", group: "darken", op: 16, canvas: null, psd: "lbrn", ora: "scumble:linear-burn", oraRead: ["krita:linear_burn"], reader: 5 }),
    Object.freeze({ id: "darker-color", label: "Darker colour", group: "darken", op: 28, canvas: null, psd: "dkCl", ora: "scumble:darker-color", oraRead: ["krita:darker color"], reader: 5 }),
    // Lighten
    Object.freeze({ id: "lighten", label: "Lighten", group: "lighten", op: 9, canvas: "lighten", psd: "lite", ora: "svg:lighten", oraRead: [], reader: 1 }),
    Object.freeze({ id: "screen", label: "Screen", group: "lighten", op: 6, canvas: "screen", psd: "scrn", ora: "svg:screen", oraRead: [], reader: 1 }),
    Object.freeze({ id: "color-dodge", label: "Colour dodge", group: "lighten", op: 20, canvas: null, psd: "div ", ora: "svg:color-dodge", oraRead: [], reader: 5 }),
    Object.freeze({ id: "linear-dodge", label: "Linear dodge (add)", group: "lighten", op: 15, canvas: null, psd: "lddg", ora: "scumble:linear-dodge", oraRead: ["krita:linear_dodge", "krita:add"], reader: 5 }),
    Object.freeze({ id: "lighter-color", label: "Lighter colour", group: "lighten", op: 29, canvas: null, psd: "lgCl", ora: "scumble:lighter-color", oraRead: ["krita:lighter color"], reader: 5 }),
    // Contrast
    Object.freeze({ id: "overlay", label: "Overlay", group: "contrast", op: 7, canvas: "overlay", psd: "over", ora: "svg:overlay", oraRead: [], reader: 1 }),
    Object.freeze({ id: "soft-light", label: "Soft light", group: "contrast", op: 10, canvas: "soft-light", psd: "sLit", ora: "svg:soft-light", oraRead: [], reader: 1 }),
    Object.freeze({ id: "hard-light", label: "Hard light", group: "contrast", op: 11, canvas: "hard-light", psd: "hLit", ora: "svg:hard-light", oraRead: [], reader: 1 }),
    Object.freeze({ id: "vivid-light", label: "Vivid light", group: "contrast", op: 22, canvas: null, psd: "vLit", ora: "scumble:vivid-light", oraRead: ["krita:vivid_light"], reader: 5 }),
    Object.freeze({ id: "linear-light", label: "Linear light", group: "contrast", op: 13, canvas: null, psd: "lLit", ora: "scumble:linear-light", oraRead: ["krita:linear_light", "krita:linear light"], reader: 2 }),
    Object.freeze({ id: "pin-light", label: "Pin light", group: "contrast", op: 18, canvas: null, psd: "pLit", ora: "scumble:pin-light", oraRead: ["krita:pin_light"], reader: 5 }),
    Object.freeze({ id: "hard-mix", label: "Hard mix", group: "contrast", op: 19, canvas: null, psd: "hMix", ora: "scumble:hard-mix", oraRead: ["krita:hard mix", "krita:hard_mix_photoshop"], reader: 5 }),
    // Inversion
    Object.freeze({ id: "difference", label: "Difference", group: "inversion", op: 12, canvas: "difference", psd: "diff", ora: "svg:difference", oraRead: [], reader: 1 }),
    Object.freeze({ id: "exclusion", label: "Exclusion", group: "inversion", op: 14, canvas: null, psd: "smud", ora: "scumble:exclusion", oraRead: ["svg:exclusion", "krita:exclusion"], reader: 5 }),
    Object.freeze({ id: "subtract", label: "Subtract", group: "inversion", op: 17, canvas: null, psd: "fsub", ora: "scumble:subtract", oraRead: ["krita:subtract"], reader: 5 }),
    Object.freeze({ id: "divide", label: "Divide", group: "inversion", op: 23, canvas: null, psd: "fdiv", ora: "scumble:divide", oraRead: ["krita:divide"], reader: 5 }),
    // Component
    Object.freeze({ id: "hue", label: "Hue", group: "component", op: 24, canvas: null, psd: "hue ", ora: "svg:hue", oraRead: [], reader: 5 }),
    Object.freeze({ id: "saturation", label: "Saturation", group: "component", op: 25, canvas: null, psd: "sat ", ora: "svg:saturation", oraRead: [], reader: 5 }),
    Object.freeze({ id: "color", label: "Colour", group: "component", op: 26, canvas: null, psd: "colr", ora: "svg:color", oraRead: [], reader: 5 }),
    Object.freeze({ id: "luminosity", label: "Luminosity", group: "component", op: 27, canvas: null, psd: "lum ", ora: "svg:luminosity", oraRead: [], reader: 5 }),
]);

/** @type {string[]} */
export const BLEND_MODES = /** @type {string[]} */ (/** @type {unknown} */ (Object.freeze(BLENDS.map((r) => r.id))));

/** @type {Set<string>} */
export const EMULATED_BLENDS = new Set(BLENDS.filter((r) => r.canvas === null).map((r) => r.id));

export const BLEND_OPS = Object.freeze(Object.fromEntries(BLENDS.filter((r) => r.op > 0).map((r) => [r.id, r.op])));

export const LAST_BLEND = Math.max(...BLENDS.map((r) => r.op));

export const BLEND_GROUPS = Object.freeze([
    Object.freeze({ id: "normal", label: "Normal" }),
    Object.freeze({ id: "darken", label: "Darken" }),
    Object.freeze({ id: "lighten", label: "Lighten" }),
    Object.freeze({ id: "contrast", label: "Contrast" }),
    Object.freeze({ id: "inversion", label: "Inversion" }),
    Object.freeze({ id: "component", label: "Component" }),
]);

export const PSD_BLEND = Object.freeze(Object.fromEntries(BLENDS.map((r) => [r.id, r.psd])));

export const PSD_BLENDS = Object.freeze(Object.fromEntries(BLENDS.map((r) => [r.psd, r.id])));

export const ORA_BLEND = Object.freeze(Object.fromEntries(BLENDS.map((r) => [r.id, r.ora])));

/** @type {Record<string, string>} */
const oraMap = {};
for (const r of BLENDS) {
    oraMap[r.ora] = r.id;
    for (const alt of r.oraRead) {
        oraMap[alt] = r.id;
    }
}
export const ORA_BLENDS = Object.freeze(oraMap);

export const READER_OF_BLEND = Object.freeze(Object.fromEntries(BLENDS.filter((r) => r.reader > 1).map((r) => [r.id, r.reader])));

/** @type {Map<string, string>} */
const CANVAS_OPS = new Map(/** @type {[string, string][]} */ (BLENDS.filter((r) => r.canvas !== null).map((r) => [r.id, /** @type {string} */ (r.canvas)])));

/**
 * Returns a valid Canvas 2D globalCompositeOperation string for `id`, or "source-over"
 * if `id` is null, emulated, or unknown.
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function canvasOp(id) {
    if (!id || id === "normal") return "source-over";
    return CANVAS_OPS.get(id) || "source-over";
}

/** @type {Set<string>} */
const KNOWN_IDS = new Set(BLENDS.map((r) => r.id));

/**
 * Returns `id` if known in `BLENDS`, or "normal" (with a console.warn) if unknown.
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function normalBlend(id) {
    if (id && KNOWN_IDS.has(id)) return id;
    if (id && id !== "normal") console.warn(`Inpaint Canvas: unknown blend mode "${id}", using "normal"`);
    return "normal";
}

/** @type {Map<string, string>} */
const LABELS = new Map(BLENDS.map((r) => [r.id, r.label]));

/**
 * Returns the human-readable label for a blend mode id.
 * @param {string} id
 * @returns {string}
 */
export function blendLabel(id) {
    return LABELS.get(id) || id;
}

/**
 * 32-bit integer finalizer hash (lowbias32 / hash32).
 * @param {number} x
 * @returns {number}
 */
export function lowbias32(x) {
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}

/**
 * Spatial 32-bit hash for coordinate (x, y) with a 32-bit seed.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
export function hash32(x, y, seed) {
    return lowbias32(((Math.imul(x >>> 0, 0x9E3779B1) ^ Math.imul(y >>> 0, 0x85EBCA77) ^ (seed >>> 0))) >>> 0);
}

/**
 * Deterministic 32-bit seed from layer id via 32-bit FNV-1a.
 * @param {string|number} id
 * @returns {number}
 */
export function seedOfLayer(id) {
    const s = String(id);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * 8-bit integer multiply with rounding, matching compositing kernels.
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export const mul255 = (x, y) => {
    const t = x * y + 128;
    return (t + (t >> 8)) >> 8;
};
