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
 *   canvas: string|null,
 *   psd: string,
 *   ora: string,
 *   oraRead: string[],
 *   reader: number
 * }} BlendRow
 */

export const BLENDS = Object.freeze([
    Object.freeze({ id: "normal", label: "Normal", group: "normal", op: 0, canvas: "source-over", psd: "norm", ora: "svg:src-over", oraRead: [], reader: 1 }),
    Object.freeze({ id: "multiply", label: "Multiply", group: "darken", op: 5, canvas: "multiply", psd: "mul ", ora: "svg:multiply", oraRead: [], reader: 1 }),
    Object.freeze({ id: "screen", label: "Screen", group: "lighten", op: 6, canvas: "screen", psd: "scrn", ora: "svg:screen", oraRead: [], reader: 1 }),
    Object.freeze({ id: "overlay", label: "Overlay", group: "contrast", op: 7, canvas: "overlay", psd: "over", ora: "svg:overlay", oraRead: [], reader: 1 }),
    Object.freeze({ id: "darken", label: "Darken", group: "darken", op: 8, canvas: "darken", psd: "dark", ora: "svg:darken", oraRead: [], reader: 1 }),
    Object.freeze({ id: "lighten", label: "Lighten", group: "lighten", op: 9, canvas: "lighten", psd: "lite", ora: "svg:lighten", oraRead: [], reader: 1 }),
    Object.freeze({ id: "soft-light", label: "Soft light", group: "contrast", op: 10, canvas: "soft-light", psd: "sLit", ora: "svg:soft-light", oraRead: [], reader: 1 }),
    Object.freeze({ id: "hard-light", label: "Hard light", group: "contrast", op: 11, canvas: "hard-light", psd: "hLit", ora: "svg:hard-light", oraRead: [], reader: 1 }),
    Object.freeze({ id: "linear-light", label: "Linear light", group: "contrast", op: 13, canvas: null, psd: "lLit", ora: "scumble:linear-light", oraRead: ["krita:linear_light", "krita:linear light"], reader: 2 }),
    Object.freeze({ id: "difference", label: "Difference", group: "inversion", op: 12, canvas: "difference", psd: "diff", ora: "svg:difference", oraRead: [], reader: 1 }),
]);

export const BLEND_MODES = Object.freeze(BLENDS.map((r) => r.id));

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

const CANVAS_OPS = new Map(BLENDS.filter((r) => r.canvas !== null).map((r) => [r.id, r.canvas]));

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

const LABELS = new Map(BLENDS.map((r) => [r.id, r.label]));

/**
 * Returns the human-readable label for a blend mode id.
 * @param {string} id
 * @returns {string}
 */
export function blendLabel(id) {
    return LABELS.get(id) || id;
}
