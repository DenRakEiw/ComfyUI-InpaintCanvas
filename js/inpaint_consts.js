// Generated from DenRakEiw/scumble renderer/editor/inpaint_consts.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the editor's constants, roles, the brush size scale and makeCanvas: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { pixelsOptions } from "./inpaint_pixels.js";

/**
 * The pixel backend a new editor takes (docs/PLAN_BCE.md §C2 step b): the host's choice when it made
 * one (Scumble passes --tiles / SCUMBLE_TILES / settings.tiles / its default, on, through setPixelsOptions),
 * else the browser's switch localStorage "inpaint_canvas.tiles" = "1" (the ComfyUI node; off by default).
 */
function editorTileMode() {
    const o = pixelsOptions();
    if (typeof o.tiles === "boolean") return { on: o.tiles, from: o.tilesFrom || "host" };
    try { if (localStorage.getItem("inpaint_canvas.tiles") === "1") return { on: true, from: "localStorage" }; } catch (_) { /* no storage */ }
    return { on: false, from: "default" };
}

/**
 * Two hosts run this editor: Scumble (renderer/editor/host.js, the editor is the window) and
 * the ComfyUI node (its js/host.js, the editor is an overlay over the graph). Where they word
 * a text differently the host's `text` table answers; the fallback is Scumble's wording.
 */
function hostText(key, fallback) {
    return (host.text && host.text[key]) || fallback;
}

const NODE_CLASS = "InpaintCanvas";
const STITCH_CLASS = "InpaintCanvasStitch";
const MAX_UNDO = 30;
const MAX_UNDO_BYTES = 384 * 1024 * 1024;   // rect undo copies: older steps are dropped past this
const MAX_SNAPSHOTS = 8;                    // named snapshots of the whole document (the Undo history section)
/**
 * What a layer holds of an edit still in progress: the "before" of a slider or preview, a text edit, a colour match drag,
 * a choice list's hover, a relight nudge or wheel burst with its flush and timer. Never part of an undo step, a named
 * snapshot or a copy: a record holding one would bring the edit back half done (docs/PLAN_RELIGHT_FIXES.md F3).
 */
const LAYER_PENDING_KEYS = ["_undoPending", "_textUndo", "_matchUndo", "_hoverSnap", "_nudgePending", "_wheelPending", "_wheelLabel",
    "_flushNudge", "_flushWheel", "_nudgeRelightTimer", "_wheelRelightTimer"];
/** Said when a run holds the document (the app's host; the node's sets no `providerPending`). */
const RUN_GOING_TEXT = "A run is still going on this document: wait for it, or Cancel.";
/**
 * The layer kinds this version reads (getValue writes them). A layer of another kind with a file loads as pixels and
 * keeps its kind; one without a file can only come from a newer version, and setValue leaves it out with a word.
 */
const LAYER_KINDS = new Set(["result", "paint", "image", "text", "filter"]);
/**
 * A load's note (setValue: layers left out) rides on the next LOAD_NOTE_LINES plain status lines, for LOAD_NOTE_MS at
 * most and until the user acts: the host's own lines right after a load ("Last session restored.", then "Opened ..." or
 * "Reopened ...") would otherwise write over it unseen. An error or warning line stays as it is (and keeps the carry
 * for the line after it), so a caller that compares its own line (generate's Realism Pass sentence) still finds it.
 */
const LOAD_NOTE_LINES = 2;
const LOAD_NOTE_MS = 20000;
/** The Relight panel's Style choices on the Magnific route (commands.js relight takes the same). */
export const RELIGHT_STYLES = ["standard", "darker_but_realistic", "clean", "smooth", "brighter", "contrasted_n_hdr", "just_composition"];
/** The Relight panel's Light type choices on the Bria route; none picked is "From the lights" (commands.js relight takes the same). */
export const RELIGHT_LIGHT_TYPES = [
    "soft overcast daylight lighting", "midday", "blue hour light", "low-angle sunlight", "sunrise light", "spotlight on subject", "overcast light",
    "cloud-filtered lighting", "fog-diffused lighting", "moonlight lighting", "starlight nighttime", "soft bokeh lighting", "harsh studio lighting",
];

/**
 * The status line of a load that left layers out: `newer` of a kind this version does not know, `failed` filter layers
 * that would not load, `missing` the names of pixel layers whose file would not, `redrawn` those of text layers whose
 * file would not and that were drawn again from their text.
 */
function leftOutText(newer, failed, missing = [], redrawn = []) {
    const parts = [];
    if (newer > 0) {
        const one = newer === 1;
        // neutral words, so the node's build says nothing wrong; a host may name itself (text.newerApp)
        parts.push(`${newer} layer${one ? "" : "s"} saved by ${hostText("newerApp", "a newer version")} ${one ? "was" : "were"} left out: this version cannot show ${one ? "it" : "them"}, and the next save drops ${one ? "it" : "them"}.`);
    }
    if (failed > 0) parts.push(`${failed} filter layer${failed === 1 ? "" : "s"} could not be read and ${failed === 1 ? "was" : "were"} left out.`);
    // a pixel layer whose file would not load (gone from the store, or not a picture): named, the first few
    if (missing.length) {
        const n = missing.length, one = n === 1;
        const names = missing.slice(0, 3).map((s) => `"${s}"`).join(", ") + (n > 3 ? ` and ${n - 3} more` : "");
        parts.push(`${n} layer${one ? "" : "s"} could not be read and ${one ? "was" : "were"} left out: ${names}.`);
    }
    // a text layer whose file would not load: drawn again from its text
    if (redrawn.length) {
        const n = redrawn.length, one = n === 1;
        const names = redrawn.slice(0, 3).map((s) => `"${s}"`).join(", ") + (n > 3 ? ` and ${n - 3} more` : "");
        parts.push(`${n} text layer${one ? "" : "s"} could not be read and ${one ? "was" : "were"} drawn again from ${one ? "its" : "their"} text: ${names}.`);
    }
    return parts.join(" ");
}
/** What an undo step is called in the Undo history when its site gives no label of its own. */
const UNDO_LABELS = {
    layerrect: "Layer pixels", layer: "Layer pixels", layerfull: "Layer", selection: "Selection", transform: "Transform", transforms: "Transform layers",
    mask: "Layer mask", match: "Colour match", filter: "Filter", text: "Text", layers: "Layers", canvas: "Canvas",
    turn: "Assistant turn taken back", data: "Plugin data", maps: "Depth map",
};

const DOC_TURN_LABELS = { 1: "Rotate canvas 90° clockwise", "-1": "Rotate canvas 90° counter-clockwise", 2: "Rotate canvas 180°", h: "Flip canvas horizontally", v: "Flip canvas vertically" };

const MASK_RGB = [255, 255, 255];           // a layer mask's colour where it lets through (the selection's is red)
const REMOVE_MARK = "#ff3c78";              // the Remove tool's stroke, shown half transparent until the fill lands
const PYRAMID_MIN_PX = 1 << 20;             // sources below 1 MP are drawn straight, no levels
const PYRAMID_LEVELS = 8;
const FLOOD_COARSE_PX = 2048;               // the wand's and the bucket's first pass runs on a composite this large
const FLOOD_WHOLE_SHARE = 0.4;              // a region box above this share of the image is flooded in one pass over the whole image
const SNAP_CANVAS_PX = 16 * 1024 * 1024;   // a selection undo step up to this many pixels is a pixels copy, above it a PNG
const SEL_BOX_MAX_PX = 64 * 1024 * 1024;    // the selection's PNG holds its box up to this size, above it the whole mask (written in parts)
// a PSD read on the pool (readPsdOnPool): bands its worker may have posted before this window acknowledged them (the route
// psdWindow overrides it, 0 = unpaced; K20b review K20b-T1)
const PSD_WINDOW = 8;
const SYNC_ENCODE_PX = 16 * 1024 * 1024;    // above this the selection PNG for getValue is encoded off the main thread
const HANDLE_PX = 9;
const SIDE_DEFAULT_PX = 320;               // the side panel's width (item 17: the user drags it between the two below)
const SIDE_MIN_PX = 310;                   // an expanded layer row fits from here, beside the list's and the pane's scrollbars
const SIDE_MAX_SHARE = 0.6;                // of the editor's body: the picture keeps the rest
const RULER_PX = 18;
const CURSOR_CLASSES = ["ipc-scale", "ipc-scale-ne", "ipc-scale-x", "ipc-scale-y", "ipc-rotate"];

// the tone brush's dab through the smudge engine: the whole of its curve at every dab, nothing carried (§4 step 9)
const TONE_DAB = Object.freeze({ strength: 100, length: 0 });
// the largest box frequency separation takes at once (two float copies of it are 32 bytes a pixel)
const FREQ_MAX_PX = 16e6;
const ROLES = ["none", "reference", "scribble", "lineart", "depth", "pose", "canny", "other"];
// Outputs after the setting slots, in the node's order (only the node shows outputs). The
// backend declares them after setting_8, the frontend shows them right after the connected
// settings (see syncSettingOutputs) and the queuePrompt wrapper maps the visible slot to the
// backend slot. Outputs that are neither fixed, setting nor tail (e.g. the former
// reference_images) are removed from loaded workflows. box_prompt: the prompt with FLUX 3's
// box rows and caption (the plain prompt while the Boxes switch is off); elements: the New and Text boxes in
// ComfyUI core's bounding-box shape (docs/PLAN_NODE_BOXES.md D2-D4).
const TAIL_OUTPUTS = [
    { name: "box_prompt", type: "STRING", label: "box_prompt" },
    { name: "elements", type: "ARRAY", label: "elements" },
];
const REF_DEFAULTS = { fit: "pad" };
const REF_FITS = ["pad", "crop", "stretch"];

/**
 * The largest brush, in image pixels (PLAN_0_1_31 §4 step 7): 400 until 0.1.31, then measured at 15000 x 10000 on the
 * regional path (docs/PERFORMANCE.md §15): a 1,000 px clone 17 to 24 ms a move and a smudge 31 to 41 ms, 2,000 px 53 to
 * 89 ms. The Size slider maps it logarithmically (brushSizeToSlider), so 2 to 40 px keep the room they had.
 */
export const BRUSH_MAX = 1000;
const SIZE_STEPS = 1000;
/** A brush size (2..BRUSH_MAX px) as the Size slider's position (0..1000), and back: logarithmic. */
export function brushSizeToSlider(size) { return Math.round(SIZE_STEPS * Math.log(Math.max(2, Math.min(BRUSH_MAX, size)) / 2) / Math.log(BRUSH_MAX / 2)); }
export function sliderToBrushSize(v) { return Math.max(2, Math.min(BRUSH_MAX, Math.round(2 * Math.pow(BRUSH_MAX / 2, Math.max(0, Math.min(SIZE_STEPS, +v || 0)) / SIZE_STEPS)))); }

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

/**
 * A canvas of w x h the CPU keeps: `c` when it has that size, else a new one. A brush dab ends in a tile scratch, which
 * is on the CPU too, so a dab canvas on the GPU was a readback at every draw (PLAN_0_1_31 §4 step 2).
 */
function cpuDab(c, w, h = w) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (c && c.width === w && c.height === h) return c;
    const n = makeCanvas(w, h);
    n.getContext("2d", { willReadFrequently: true });
    return n;
}

/** A patch's Blend below 100 %: the blend's RGB (`out`) pulled back towards the plain copy (`raw`, RGBA) by `b` (0..1) where the mask is set. */
function patchMix(out, raw, mask, b) {
    for (let k = 0, n = mask.length; k < n; k++) {
        if (!mask[k]) continue;
        const o = 4 * k;
        for (let c = o; c < o + 3; c++) out[c] = Math.round(raw[c] + b * (out[c] - raw[c]));
    }
}

/** The mean colour of the RGBA bytes whose alpha is at least 8, or null when there are none (heal). */
function meanRGB(d) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return n ? [r / n, g / n, b / n] : null;
}

/** What a shown reference is called in the list and on the canvas: its prompt token's label in the app, its place in the node. */
function refBadge(i) {
    return host.refTokens ? "img" + (i + 1) : "ref " + (i + 1);
}

export { CURSOR_CLASSES, DOC_TURN_LABELS, FLOOD_COARSE_PX, FLOOD_WHOLE_SHARE, FREQ_MAX_PX, HANDLE_PX, LAYER_KINDS, LAYER_PENDING_KEYS, LOAD_NOTE_LINES, LOAD_NOTE_MS, MASK_RGB, MAX_SNAPSHOTS, MAX_UNDO, MAX_UNDO_BYTES, NODE_CLASS, PSD_WINDOW, PYRAMID_LEVELS, PYRAMID_MIN_PX, REF_DEFAULTS, REF_FITS, REMOVE_MARK, ROLES, RULER_PX, RUN_GOING_TEXT, SEL_BOX_MAX_PX, SIDE_DEFAULT_PX, SIDE_MAX_SHARE, SIDE_MIN_PX, SNAP_CANVAS_PX, STITCH_CLASS, SYNC_ENCODE_PX, TAIL_OUTPUTS, TONE_DAB, UNDO_LABELS, cpuDab, editorTileMode, hostText, leftOutText, makeCanvas, meanRGB, patchMix, refBadge };
