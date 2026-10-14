// Generated from DenRakEiw/scumble renderer/editor/inpaint_sizelimit.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// What one canvas holds (docs/PLAN_0_1_48.md S5, docs/BUGS.md "Size limits"): a whole-picture landing, Resize and
// Extend make the new picture as one canvas, so their ceiling is Chromium's canvas limit on both backends, not the
// document's gigapixel. No imports: the editor, the tile engine, the app host and the commands share it.

/** Chromium's canvas area limit: a canvas above it cannot exist. */
export const CANVAS_MAX_PIXELS = 268435456;
/** Chromium's canvas side limit: a canvas of 65,536 px a side exists but draws and reads nothing (measured). */
export const CANVAS_MAX_SIDE = 65535;

const fmt = (n) => Math.round(n).toLocaleString("en-US");

/** Whether a w × h picture fits one canvas. */
export function canvasFits(w, h) {
    return w >= 1 && h >= 1 && w <= CANVAS_MAX_SIDE && h <= CANVAS_MAX_SIDE && w * h <= CANVAS_MAX_PIXELS;
}

/** The limit in words, for the end of a refusal. */
export const CANVAS_LIMIT_WORDS = "more than one canvas holds (65,535 px a side, 268 megapixels)";

/** "" when w × h fits one canvas, else "<what> would be W × H px, more than one canvas holds (...)". */
export function canvasSizeRefusal(w, h, what = "The picture") {
    return canvasFits(w, h) ? "" : `${what} would be ${fmt(w)} × ${fmt(h)} px, ${CANVAS_LIMIT_WORDS}.`;
}

/** The largest size of the same shape that fits one canvas: [w, h] itself when it fits, else scaled down. */
export function fitInCanvas(w, h) {
    if (canvasFits(w, h)) return [w, h];
    let s = Math.min(1, CANVAS_MAX_SIDE / w, CANVAS_MAX_SIDE / h, Math.sqrt(CANVAS_MAX_PIXELS / (w * h)));
    let nw = Math.max(1, Math.floor(w * s)), nh = Math.max(1, Math.floor(h * s));
    while (!canvasFits(nw, nh)) { s *= 0.999; nw = Math.max(1, Math.floor(w * s)); nh = Math.max(1, Math.floor(h * s)); }
    return [nw, nh];
}

/**
 * The largest factor of an upscaler's `spec` ({ steps } or { min, max }) whose answer of a w × h picture fits one
 * canvas (each side rounded as the answer is) and, when given, the model's own area cap `maxPixels`, or null when
 * none does.
 */
export function largestFactor(w, h, spec, maxPixels = 0) {
    const area = maxPixels > 0 ? Math.min(CANVAS_MAX_PIXELS, maxPixels) : CANVAS_MAX_PIXELS;
    const fits = (f) => { const W = Math.round(w * f), H = Math.round(h * f); return canvasFits(W, H) && W * H <= area; };
    if (!spec) return null;
    if (Array.isArray(spec.steps) && spec.steps.length) {
        const ok = spec.steps.filter((f) => fits(f));
        return ok.length ? Math.max(...ok) : null;
    }
    const min = +spec.min || 1, max = +spec.max || min;
    if (!fits(min)) return null;
    // whole factors from the bound down, never below the spec's own minimum (which may be fractional)
    let best = Math.max(min, Math.min(max, Math.floor(Math.min(CANVAS_MAX_SIDE / w, CANVAS_MAX_SIDE / h, Math.sqrt(area / (w * h))))));
    while (best > min && !fits(best)) best = Math.max(min, best - 1);
    return fits(best) ? best : min;
}
