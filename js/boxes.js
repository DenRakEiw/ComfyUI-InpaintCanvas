// Generated from DenRakEiw/scumble renderer/editor/boxes.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Boxes in the prompt, the renderer's half (item 28, docs/PLAN_BOXES.md §4 and §8): geometry in image pixels turned
// into fractions of the frame a run sends (the crop of an edit, the new image of Generate new). Main's
// electron/main/providers/boxes.js writes the rows the model reads, since only main knows the final layout of the
// pictures (which slot is ref_image_k). Pure functions, no DOM, no editor: tools/boxes_test.js imports this file.
//
// A box as the request carries it (`request.boxes`):
//   { id: "edit_1",                     // BOX_ID (red_scarf_1), unique per request
//     kind: "new" | "keep" | "move" | "remove" | "from",
//     rect: [l, t, r, b],               // fractions 0..1 of the frame: the target
//     src: [l, t, r, b] | null,         // keep / move / remove: where it is in the frame; from: where it is in the reference
//     ref: null | i,                    // from: the reference's index as the {@ref:i} markers count it (0-based, the Original included)
//     desc: "...",                      // at most DESC_MAX characters, newlines folded
//     text: "SALE" }                    // new only, optional: the words a Text box renders (desc then says how they look)

/**
 * The shape of a box id: lowercase words joined by underscores, then a number (the docs' `<knight_1>`, `red_scarf_2`);
 * not a picture's name (`ref_image_1`), which the caption and the rows use for the pictures.
 */
export const BOX_ID = /^(?!ref_image_[0-9]+$)[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*_[1-9][0-9]*$/;

/** Words that say little about what a box holds, left out of an id made from its description. */
const ID_STOP = new Set(("a an the this that these those some any each every of in on at to into onto from with without by for and or but as " +
    "it its is are be was were here there very more less new please also then so ref " +
    "add bring brighten change darken draw fill give insert lighten make paint place put recolor recolour render replace " +
    "show swap turn use write move keep remove erase delete take let set").split(" "));

/** Nouns that end in -ing: they do not end a phrase the way a verb's -ing form does ("a gold ring", "a tall building"). */
const ING_NOUNS = new Set(("ring king wing sing thing string spring swing sling sting building painting ceiling clothing " +
    "evening morning wedding pudding railing sibling bedding earring awning icing lightning ending opening landing " +
    "drawing something nothing everything stuffing frosting filling dumpling herring viking").split(" "));

/** Words that say where a thing is, not what it is: they end a phrase as the stop words do ("a red ball under the chair"). */
const ID_PLACE = new Set("over under behind near next beside above below between through across around against along beneath inside outside upon toward towards".split(" "));

/** German articles and prepositions (accents dropped), so a German description is named after its noun too. */
const ID_STOP_DE = new Set("der die das den dem des ein eine einen einem einer eines auf im am unter uber neben hinter vor mit von zu zum zur und oder ist sind fur bei aus nach".split(" "));

const idStop = (w) => ID_STOP.has(w) || ID_PLACE.has(w) || ID_STOP_DE.has(w);

/**
 * The name part of an id made from a description (S3e; docs/PLAN_0_1_38.md A2): the last two words of its first
 * phrase of telling words, lowercase, accents dropped, joined by an underscore. The phrase lies in the first clause
 * that has one (up to a comma or a full stop) and ends at a stop word, a word of place (under, next ...) or a verb's
 * -ing form followed by one of those or by nothing, so the adjectives go and the noun stays: "a small black cat
 * sitting in the grass" -> "black_cat", "the white wall clock" -> "wall_clock", "A red scarf" -> "red_scarf", "make
 * the tiger pink" -> "tiger_pink", "a bright shining star" -> "shining_star", "eine rote Lampe auf dem Tisch" ->
 * "rote_lampe"; "" when it has none. `first`: the first two telling words instead, for a Text box's words, which are
 * a sign's text and not a noun phrase ("BIG SALE TODAY" -> "big_sale"). A one-letter word (the s of "dog's"), an @img
 * token, a {@...} marker and a <name> are not words of it.
 */
export function idWords(text, { first = false } = {}) {
    const s = String(text == null ? "" : text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
        .split(String.fromCharCode(223)).join("ss")
        .replace(/@img[0-9]+|\{@[^}]*\}|<[^>]*>/g, " ");
    const name = (words) => words.map((w) => w.slice(0, 16)).join("_");
    for (const clause of s.split(/[,.;:!?\n]/)) {
        const words = clause.split(/[^a-z0-9]+/).filter((w) => /^[a-z]/.test(w) && w.length > 1);
        if (first) {
            const telling = words.filter((w) => !idStop(w));
            if (telling.length) return name(telling.slice(0, 2));
            continue;
        }
        const phrase = [];
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (idStop(w)) { if (phrase.length) break; continue; }
            const verb = w.length > 4 && w.endsWith("ing") && !ING_NOUNS.has(w) && (i + 1 >= words.length || idStop(words[i + 1]));
            if (phrase.length && verb) break;
            phrase.push(w);
        }
        if (phrase.length) return name(phrase.slice(-2));
    }
    return "";
}

/** The longest description a box carries. */
export const DESC_MAX = 400;

/** The side under which a box at the emitted size is "small" (the docs: a 40 x 25 px element "often did not appear"). */
export const SMALL_PX = 48;

/** The frame of a run in image pixels, from planCrop's info (`bbox` = [x, y, w, h]). */
export function frameOf(info) {
    const b = info && info.bbox;
    return { x: b[0], y: b[1], w: b[2], h: b[3] };
}

/** A description as a row carries it: one line, trimmed, at most DESC_MAX characters. */
export function foldDesc(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, DESC_MAX);
}

/**
 * A rectangle in image pixels ([l, t, r, b], r and b exclusive) as fractions of the frame, clamped to 0..1. Null when
 * the clamped box is empty (the rectangle lies outside the frame) or thinner than 1/1000 on a side.
 */
export function toFrame(rectPx, frame) {
    if (!Array.isArray(rectPx) || rectPx.length !== 4 || !frame || !(frame.w > 0) || !(frame.h > 0)) return null;
    const [l, t, r, b] = rectPx.map(Number);
    if (![l, t, r, b].every(Number.isFinite)) return null;
    const c = (v) => Math.max(0, Math.min(1, v));
    const out = [c((l - frame.x) / frame.w), c((t - frame.y) / frame.h), c((r - frame.x) / frame.w), c((b - frame.y) / frame.h)];
    if (out[2] - out[0] < 0.001 || out[3] - out[1] < 0.001) return null;
    return out;
}

/**
 * The selection as one box (S1): `bounds` the selection's bounding box ([x0, y0, x1, y1] image pixels, x1 and y1
 * exclusive, as editor.selectionBounds() gives it; null without a selection), `frame` the crop. With a `pair` (the first @img token
 * the prompt carries, `pair.ref` its picture index) the box takes that reference's whole picture into the selection
 * (kind "from"); without one it is a New row described by the prompt. The desc keeps the prompt's {@ref:i} markers:
 * main resolves them in the rows as in the prompt. Null without a selection or when it lies outside the frame.
 */
export function selectionBox(bounds, frame, { prompt = "", pair = null } = {}) {
    if (!Array.isArray(bounds) || bounds.length !== 4) return null;
    const rect = toFrame(bounds, frame);
    if (!rect) return null;
    const desc = foldDesc(prompt);
    const from = pair && Number.isInteger(pair.ref) && pair.ref >= 0;
    // named after the prompt's words (door_red_1), so the caption names something the model can read (S3e)
    const id = `${idWords(desc) || "edit"}_1`;
    return from
        ? { id, kind: "from", rect, src: [0, 0, 1, 1], ref: pair.ref, desc }
        : { id, kind: "new", rect, src: null, ref: null, desc };
}

/** The kinds a box may have (main's boxes.js keeps the same set). */
export const KINDS = new Set(["new", "keep", "move", "remove", "from"]);

/** How a plugin's desc names a reference layer: `{@layer:L12}`, the layer's id (pluginBoxes turns it into a {@ref:i} marker). */
export const LAYER_MARK = /\{@layer:([^}\s]+)\}/g;

const pxRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(Number(v))) && Number(r[0]) < Number(r[2]) && Number(r[1]) < Number(r[3]);

/**
 * A plugin's boxes (`scumble.generate.register`, docs/PLUGINS.md "Generate"; S2 of docs/PLAN_BOXES.md) mapped into
 * the request's shape. A plugin box is the request's shape with `rect` and `src` in **image pixels** ([l, t, r, b],
 * r and b exclusive) and, on a from box, `layer` (the reference layer's id) instead of `ref`; its `src` is then where
 * the element sits in that layer as it is placed in the picture (image pixels too; null = the whole picture). A new
 * box may carry `text`, the words it renders (main writes them as each model takes words: FLUX 3 `text reading "..."`
 * before the desc, Ideogram 4 a text element). `ctx.frame` is the run's frame ({ x, y, w, h }), `ctx.references` the pictures of this run as the {@ref:i} markers
 * count them ([{ index, layerId, frame }]). `opts.taken` holds the ids already used (boxes or strings): a duplicate
 * gets the next free number (edit_1 -> edit_2). Returns { boxes, notes }: a box (or its source) outside the frame is
 * dropped with a note naming it. Throws on a malformed box (`err.code` "shape": the plugin's bug) and on a from box
 * whose layer this run does not send (`err.code` "layer", `opts.nameOf(layerId)` names it: the run refuses, as an
 * unresolvable @img token does). A desc may name a reference layer as `{@layer:<id>}` (LAYER_MARK): it becomes the
 * `{@ref:i}` marker main resolves to the model's name for that picture ("image 2"), or refuses like a from box when
 * the layer is not sent.
 */
export function pluginBoxes(list, ctx, { taken = [], nameOf = null } = {}) {
    const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
    if (list == null) return { boxes: [], notes: [] };
    if (!Array.isArray(list)) throw fail("shape", "boxes() did not return a list");
    const frame = ctx && ctx.frame;
    const where = ctx && ctx.mode === "new" ? "image" : "crop";
    const used = new Set(taken.map((b) => (typeof b === "string" ? b : b && b.id)).filter(Boolean));
    const out = [], notes = [];
    const refOf = (layerId) => (ctx && ctx.references || []).find((x) => x && x.layerId === layerId) || null;
    const descOf = (b, who) => foldDesc(b.desc).replace(LAYER_MARK, (_, id) => {
        const r = refOf(id);
        if (!r) throw fail("layer", `${who} names ${nameOf ? nameOf(id) : "layer " + id}, which is not a reference picture of this run: nothing was sent.`);
        return `{@ref:${r.index}}`;
    });
    list.forEach((b, i) => {
        const who = `Box ${b && typeof b.id === "string" ? b.id : "#" + (i + 1)}`;
        if (!b || typeof b !== "object") throw fail("shape", `${who}: not an object`);
        if (typeof b.id !== "string" || !BOX_ID.test(b.id)) throw fail("shape", `${who}: the id is not lowercase words and a number joined by underscores (knight_1, red_scarf_2)`);
        if (!KINDS.has(b.kind)) throw fail("shape", `${who}: the kind "${String(b.kind).slice(0, 20)}" is not new, keep, move, remove or from`);
        if (!pxRect(b.rect)) throw fail("shape", `${who}: rect is not [l, t, r, b] in image pixels with l < r and t < b`);
        if (b.desc != null && typeof b.desc !== "string") throw fail("shape", `${who}: desc is not a string`);
        if (b.text != null && typeof b.text !== "string") throw fail("shape", `${who}: text is not a string`);
        if (b.text != null && b.kind !== "new") throw fail("shape", `${who}: only a new box renders text`);
        let src = null, ref = null;
        if (b.kind === "from") {
            if (typeof b.layer !== "string" || !b.layer) throw fail("shape", `${who}: a from box needs layer, the reference layer's id`);
            if (b.src != null && !pxRect(b.src)) throw fail("shape", `${who}: src is not [l, t, r, b] in image pixels with l < r and t < b`);
            const r = refOf(b.layer);
            if (!r) throw fail("layer", `${who}: ${nameOf ? nameOf(b.layer) : "layer " + b.layer} is not a reference picture of this run: nothing was sent.`);
            ref = r.index;
            src = b.src == null ? [0, 0, 1, 1] : toFrame(b.src, r.frame);
            if (!src) { notes.push(`${who}: its source lies outside the reference layer, so the box was not sent.`); return; }
        } else if (b.kind !== "new") {
            if (!pxRect(b.src)) throw fail("shape", `${who}: src is not [l, t, r, b] in image pixels with l < r and t < b`);
            src = toFrame(b.src, frame);
            if (!src) { notes.push(`${who}: its source lies outside the ${where}, so the box was not sent.`); return; }
        } else if (b.src != null) throw fail("shape", `${who}: a new box has no src`);
        const rect = toFrame(b.rect, frame);
        if (!rect) { notes.push(`${who} lies outside the ${where} and was not sent.`); return; }
        let id = b.id;
        if (used.has(id)) {
            const m = /^(.*_)([1-9][0-9]*)$/.exec(id);
            let n = Number(m[2]) + 1;
            while (used.has(m[1] + n)) n++;
            id = m[1] + n;
        }
        used.add(id);
        out.push({ id, kind: b.kind, rect, src, ref, desc: descOf(b, who), ...(b.text != null ? { text: foldDesc(b.text) } : {}) });
    });
    return { boxes: out, notes };
}

/** True when `rect` (fractions) is under SMALL_PX on a side at the emitted size ([w, h] pixels). */
export function smallBox(rect, emitted) {
    if (!Array.isArray(rect) || !Array.isArray(emitted)) return false;
    const w = (rect[2] - rect[0]) * emitted[0], h = (rect[3] - rect[1]) * emitted[1];
    return w < SMALL_PX || h < SMALL_PX;
}

/** The ids of the boxes (request shape, fractions) that place something (New, From, Move's target) in a box under SMALL_PX a side as sent. */
export function smallBoxes(boxes, emitted) {
    return (boxes || []).filter((b) => b && (b.kind === "new" || b.kind === "from" || b.kind === "move") && smallBox(b.rect, emitted)).map((b) => b.id);
}

/** The note for small boxes (smallBoxes' ids), or null for none. */
export function smallNote(ids) {
    if (!ids || !ids.length) return null;
    const one = ids.length === 1;
    return `${one ? "Box" : "Boxes"} ${ids.join(", ")} ${one ? "is" : "are"} small (under ${SMALL_PX} px a side as sent): the model may not place anything there.`;
}
