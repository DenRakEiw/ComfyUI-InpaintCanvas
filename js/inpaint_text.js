// Generated from DenRakEiw/scumble renderer/editor/inpaint_text.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Text layers for the Inpaint Canvas editor: the bundled fonts (js/fonts, OFL / Apache
 * licensed, see fonts.json and licenses/), fonts the user uploads to
 * input/inpaint_canvas/fonts, and the renderer that turns a text description into a
 * canvas at twice the layer's size (downscaled when composited, so edges stay crisp
 * after scaling).
 */
import { api } from "./host.js";

const FONT_DIR = new URL("./fonts/", import.meta.url);
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export const TEXT_DEFAULTS = {
    content: "Text", font: "Roboto", fontRef: null, size: 64, color: "#ffffff", bold: false, italic: false,
    align: "left", lineHeight: 1.2, letterSpacing: 0, outline: 0, outlineColor: "#000000", res: 2,
};
export const FONT_CATEGORIES = { sans: "Sans serif", serif: "Serif", display: "Display", script: "Script", hand: "Handwriting", mono: "Monospace", user: "Your fonts" };

let bundled = null;        // [{family, file, category, variable, license}] from fonts.json
let user = [];             // [{family, ref}] from input/inpaint_canvas/fonts
// a bundled family, or a font file's key (fileKey) -> Promise<the CSS family to draw with | null>
const faces = new Map();
let fileFaces = 0;         // a font from a file is registered under a name of its own: ipc-font-1, ipc-font-2, ...
const loaded = new Map();  // a key of `faces` -> the CSS family, once its face loaded (fontCss)

function viewUrl(ref) {
    return api.apiURL("/view?" + new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }));
}

/** A font file's key in `faces`: its type, subfolder and name, as the file mirror keys it. */
function fileKey(ref) {
    return `file:${ref.type || "input"}/${ref.subfolder || ""}/${ref.filename}`;
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
    faces.delete(fileKey(ref));   // the upload overwrites a file of the same name: its old face is stale
    return { family: f.family, category: "user", variable: false, ref };
}

/** Load a FontFace under `name` into `faces[key]`: the promise of `name`, or of null when it does not load. */
function loadFace(key, name, src, weight, what) {
    const p = (async () => {
        try {
            const face = new FontFace(name, `url("${src}")`, { weight });
            await face.load();
            document.fonts.add(face);
            loaded.set(key, name);
            return name;
        } catch (err) {
            console.warn("Inpaint Canvas: font not loaded", what, err);
            faces.delete(key);
            loaded.delete(key);
            return null;
        }
    })();
    faces.set(key, p);
    return p;
}

/** A font file (a font the user added), under a name no other file has. */
function fileFont(ref, family) {
    const key = fileKey(ref);
    return faces.get(key) || loadFace(key, `ipc-font-${++fileFaces}`, viewUrl(ref), "400", `${family} (${ref.filename})`);
}

/**
 * Make a text's font available to canvas text (a FontFace); resolves to the CSS family to draw it with, or null when
 * it cannot be loaded. The layer's own file (`ref`, a font the user added) comes first, and only when it does not load
 * does the family decide (the bundled font of that name, then the user's font of that name): two files can give one
 * family, since an open imports a document's "MyFont.ttf" as "MyFont (1).ttf" when the file mirror holds other bytes
 * under that name, and the layer keeps its family, so a search by family found whichever file the user list had
 * (docs/BUGS.md, the .scumble review). For the same reason a file is registered under a name of its own and not its
 * family: two faces of one family in `document.fonts` are drawn from whichever the browser matches first.
 */
export function ensureFont(family, ref = null) {
    if (!family) return Promise.resolve(null);
    const own = ref && ref.filename ? fileFont(ref, family) : Promise.resolve(null);
    return own.then((name) => {
        if (name) return name;
        const b = (bundled || []).find((f) => f.family === family);
        // variable fonts carry their weight axis; static ones get bold synthesised by the browser
        if (b) return faces.get(family) || loadFace(family, family, new URL(b.file, FONT_DIR).href, b.variable ? "100 900" : "400", family);
        const u = user.find((f) => f.family === family);
        return u && !(ref && ref.filename && fileKey(u.ref) === fileKey(ref)) ? fileFont(u.ref, family) : null;
    });
}

/**
 * The CSS family a text shows in once its font has loaded: the name its own file was registered under (a font the user
 * added, `ensureFont`), else its family. For what draws the text outside `renderText`: the editor's text field.
 */
export function fontCss(t) {
    if (!t) return "sans-serif";
    const own = t.fontRef && t.fontRef.filename ? loaded.get(fileKey(t.fontRef)) : null;
    if (own) return own;
    if (loaded.has(t.font)) return loaded.get(t.font);   // a bundled font, under its family
    const u = user.find((f) => f.family === t.font);     // a user font found by its family, under its file's name
    return (u && loaded.get(fileKey(u.ref))) || t.font || "sans-serif";
}

/** A text's free angle in degrees, clockwise on screen, in (-180, 180]; 0 when it has none (PLAN_0_1_31 §7, 23b). */
export function textAngle(t) {
    let a = +(t && t.angle);
    if (!Number.isFinite(a)) return 0;
    a = ((a % 360) + 360) % 360;
    if (a > 180) a -= 360;
    return Math.abs(a) < 1e-6 ? 0 : Math.round(a * 1e6) / 1e6;
}

/**
 * Where an upright text of uw x uh (render pixels) lands when it is mirrored (`flip`), turned by quarters (`turn`) and
 * by its free `angle`, about its centre: `{ W, H, m, start }`, the canvas it needs, the canvas transform that draws the
 * upright text into it (the mirror first, then the turn and the angle), and where the upright top left, the corner the
 * text starts at, lands. With no angle it is exactly what `turned()` makes of the upright pixels (W and H swapped on an
 * odd turn, the start corner a corner of the canvas).
 */
export function textFrame(uw, uh, t) {
    const turn = ((t && t.turn) | 0) & 3, f = t && t.flip ? -1 : 1, a = textAngle(t);
    let c, s;
    if (!a) { c = [1, 0, -1, 0][turn]; s = [0, 1, 0, -1][turn]; } else { const r = (a + 90 * turn) * Math.PI / 180; c = Math.cos(r); s = Math.sin(r); }
    const W = a ? Math.max(1, Math.ceil(Math.abs(uw * c) + Math.abs(uh * s) - 1e-6)) : (turn & 1 ? uh : uw);
    const H = a ? Math.max(1, Math.ceil(Math.abs(uw * s) + Math.abs(uh * c) - 1e-6)) : (turn & 1 ? uw : uh);
    // T(W / 2, H / 2) R S(f, 1) T(-uw / 2, -uh / 2)
    const m = [c * f, s * f, -s, c, W / 2 - (c * f * uw / 2 - s * uh / 2), H / 2 - (s * f * uw / 2 + c * uh / 2)];
    return { W, H, m, start: [m[4], m[5]] };
}

/**
 * Render a text description to a canvas at `res` times the image scale. Returns
 * { canvas, res, missing, box, oriented } where missing says the font was not available and a
 * fallback was used, `box` is the upright text's size [uw, uh] in render pixels, and `oriented`
 * says the canvas already holds the text mirrored and turned as its description says: a text
 * with a free angle is drawn at it as vectors (never resampled); one without comes upright, and
 * the caller turns its pixels exactly (`textFrame`).
 */
export async function renderText(t, res = 2) {
    const face = await ensureFont(t.font, t.fontRef);
    const family = face || "sans-serif";
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
    const angled = !!textAngle(t);
    const frame = angled ? textFrame(W, H, t) : null;
    const canvas = document.createElement("canvas");
    canvas.width = frame ? frame.W : W; canvas.height = frame ? frame.H : H;
    const ctx = canvas.getContext("2d");
    if (frame) ctx.setTransform(...frame.m);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // nothing left on the context of a canvas the layer adopts (PLAN_BCE §C1 rule 11)
    return { canvas, res, missing: !face && !!t.font, box: [W, H], oriented: angled };
}
