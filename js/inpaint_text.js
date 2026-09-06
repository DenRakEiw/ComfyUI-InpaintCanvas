/**
 * Text layers for the Inpaint Canvas editor: the bundled fonts (js/fonts, OFL / Apache
 * licensed, see fonts.json and licenses/), fonts the user uploads to
 * input/inpaint_canvas/fonts, and the renderer that turns a text description into a
 * canvas at twice the layer's size (downscaled when composited, so edges stay crisp
 * after scaling).
 */
import { api } from "../../scripts/api.js";

const FONT_DIR = new URL("./fonts/", import.meta.url);
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export const TEXT_DEFAULTS = {
    content: "Text", font: "Roboto", fontRef: null, size: 64, color: "#ffffff", bold: false, italic: false,
    align: "left", lineHeight: 1.2, letterSpacing: 0, outline: 0, outlineColor: "#000000", res: 2,
};
export const FONT_CATEGORIES = { sans: "Sans serif", serif: "Serif", display: "Display", script: "Script", hand: "Handwriting", mono: "Monospace", user: "Your fonts" };

let bundled = null;        // [{family, file, category, variable, license}] from fonts.json
let user = [];             // [{family, ref}] from input/inpaint_canvas/fonts
const faces = new Map();   // family -> Promise<FontFace|null>

function viewUrl(ref) {
    return api.apiURL("/view?" + new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }));
}

/** "PlayfairDisplay[wght].ttf" -> "PlayfairDisplay", "My_Font-Regular.otf" -> "My Font" */
export function familyOf(filename) {
    return String(filename || "").replace(FONT_EXT, "").replace(/\[.*?\]/g, "").replace(/[-_ ]?(Regular|Variable|VF)$/i, "").replace(/[-_]+/g, " ").trim() || String(filename || "font");
}

/** Load the bundled manifest and the user's uploaded fonts (once; refresh re-reads the server). */
export async function loadFontList({ refresh = false } = {}) {
    if (!bundled || refresh) {
        try { bundled = await (await fetch(new URL("fonts.json", FONT_DIR))).json(); } catch (err) { console.warn("Inpaint Canvas: fonts.json missing", err); bundled = []; }
        try {
            const r = await api.fetchApi("/inpaint_canvas/fonts");
            user = r.status === 200 ? (await r.json()).filter((f) => f && f.filename).map((f) => ({ family: familyOf(f.filename), ref: f })) : [];
        } catch (_) { user = []; }
    }
    return fontList();
}

export function fontList() {
    return [
        ...(bundled || []).map((f) => ({ family: f.family, category: f.category || "sans", variable: !!f.variable, ref: null })),
        ...user.map((u) => ({ family: u.family, category: "user", variable: false, ref: u.ref })),
    ];
}

/** Register an uploaded font file; returns its list entry. */
export function addUserFont(ref) {
    const f = { family: familyOf(ref.filename), ref };
    user = user.filter((u) => u.family !== f.family).concat(f);
    faces.delete(f.family);
    return { family: f.family, category: "user", variable: false, ref };
}

/** Make a font available to canvas text (FontFace); resolves to null when it cannot be loaded. */
export function ensureFont(family, ref = null) {
    if (!family) return Promise.resolve(null);
    if (faces.has(family)) return faces.get(family);
    const b = (bundled || []).find((f) => f.family === family);
    const u = user.find((f) => f.family === family);
    const src = b ? new URL(b.file, FONT_DIR).href : (u ? viewUrl(u.ref) : (ref && ref.filename ? viewUrl(ref) : null));
    if (!src) return Promise.resolve(null);
    const p = (async () => {
        try {
            // variable fonts carry their weight axis; static ones get bold synthesised by the browser
            const face = new FontFace(family, `url("${src}")`, { weight: b && b.variable ? "100 900" : "400" });
            await face.load();
            document.fonts.add(face);
            return face;
        } catch (err) {
            console.warn("Inpaint Canvas: font not loaded", family, err);
            faces.delete(family);
            return null;
        }
    })();
    faces.set(family, p);
    return p;
}

/**
 * Render a text description to a canvas at `res` times the image scale. Returns
 * { canvas, res, missing } where missing says the font was not available and a
 * fallback was used.
 */
export async function renderText(t, res = 2) {
    const face = await ensureFont(t.font, t.fontRef);
    const family = face ? t.font : "sans-serif";
    const size = Math.max(1, +t.size || 1) * res;
    const font = `${t.italic ? "italic " : ""}${t.bold ? "700" : "400"} ${size}px "${family}", sans-serif`;
    const lines = String(t.content ?? "").split("\n");
    if (!lines.length) lines.push("");
    const meas = document.createElement("canvas").getContext("2d");
    meas.font = font;
    const spacing = `${(+t.letterSpacing || 0) * res}px`;
    try { meas.letterSpacing = spacing; } catch (_) { /* older browsers: no tracking */ }
    const widths = lines.map((l) => meas.measureText(l || " ").width);
    const m = meas.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent || size * 0.8;
    const descent = m.fontBoundingBoxDescent || size * 0.25;
    const lh = size * (+t.lineHeight || 1.2);
    const ow = Math.max(0, +t.outline || 0) * res;
    const pad = Math.ceil(size * 0.15 + ow);
    const W = Math.max(1, Math.ceil(Math.max(1, ...widths) + pad * 2));
    const H = Math.max(1, Math.ceil(ascent + descent + lh * (lines.length - 1) + pad * 2));
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.font = font;
    try { ctx.letterSpacing = spacing; } catch (_) { /* ignore */ }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    lines.forEach((line, i) => {
        const w = widths[i];
        const x = t.align === "center" ? (W - w) / 2 : (t.align === "right" ? W - pad - w : pad);
        const y = pad + ascent + i * lh;
        if (ow > 0) { ctx.lineWidth = ow * 2; ctx.strokeStyle = t.outlineColor || "#000000"; ctx.strokeText(line, x, y); }
        ctx.fillStyle = t.color || "#ffffff";
        ctx.fillText(line, x, y);
    });
    return { canvas, res, missing: !face && !!t.font };
}
