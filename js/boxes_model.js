// Generated from DenRakEiw/scumble renderer/editor/boxes_model.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The Boxes model, shared by the app's Boxes plugin (plugins/boxes/main.js) and the node's editor (inpaint_boxes.js):
// a box held to its shape, the changes over a list (one undo step each is the caller's), the selection as a box, what a
// run would do with the boxes in its crop, the geometry map, the command fields and the panel's warning lines. Pure
// functions over plain data, no DOM and no document: whatever is app- or node-specific comes in as arguments (the
// picture's size, a reference layer by key, whether the prompt names a box, the crop and the selection). No page-level
// side effects: ComfyUI imports every module of the node (docs/PLAN_NODE_BOXES.md B3).
//
// A box (image pixels, [l, t, r, b], r and b exclusive):
//   { id, kind: "new" | "keep" | "move" | "remove" | "from", rect, src, layer, desc, text, colour }
// rect: where the element goes (a Keep or Remove box: where it is); src: Keep / Move / Remove where the element is now,
// From the part of the reference layer (in image pixels where the layer sits; null = the whole layer); layer: From's
// reference layer id; text: a Text box's words (a New box), else null; colour: the box's slot in boxes_tool.js PALETTE.

import { BOX_ID, KINDS, DESC_MAX, toFrame, idWords, foldDesc, smallBox, smallNote } from "./boxes.js";
import { fold } from "./boxes_format.js";
import { colourSlot, nextColour } from "./boxes_tool.js";

/** The panel's help line. */
export const HELP = "Boxes tell a model that takes them (FLUX 3 Image, Ideogram 4) where things go. New: what the description says, in the box. Keep: an element stays where it is. Move: from its source box to this one. Remove: taken out, the background filled. From reference: a reference layer (or a part of it) placed in the box. Text: the words rendered in the box. Positions are image pixels; a run measures the boxes in the crop it sends and leaves out one outside it. A box sets place and size, not a hard edge. Ideogram 4 takes New, Text and Keep boxes; Move, Remove and From reference stay out of its runs.";
/** The kinds as the panel names them (Text: a New box with words). */
export const KIND_LABELS = { new: "New", keep: "Keep", move: "Move", remove: "Remove", from: "From reference", text: "Text" };
/** An @img token in a description or the prompt (global: reset lastIndex after exec, or use tokenOf). */
export const TOKEN = /@img([1-9][0-9]*)\b/g;
/** The ids a box gets by default, by its kind, and Selection -> box's edit_n: such a box is named after its words. */
export const DEFAULT_ID = /^(?:box|keep|move|remove|ref|edit)_[1-9][0-9]*$/;

const num = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);

/** A rectangle argument ([l, t, r, b] or { x, y, w, h }) as whole image pixels, or an error naming `what`. */
export function rectOf(v, what) {
    let r = v;
    if (v && typeof v === "object" && !Array.isArray(v)) r = [num(v.x), num(v.y), num(v.x) + num(v.w), num(v.y) + num(v.h)];
    if (!Array.isArray(r) || r.length !== 4) throw new Error(`${what} must be [left, top, right, bottom] in image pixels (or { x, y, w, h })`);
    const out = r.map((x) => Math.round(Number(num(x))));
    if (!out.every(Number.isFinite)) throw new Error(`${what} holds a value that is not a number`);
    if (out[2] <= out[0] || out[3] <= out[1]) throw new Error(`${what} is empty: right must be past left and bottom past top`);
    return out;
}

/** The next free id with that base: box_1, box_2 .. */
export function nextId(boxes, base = "box") {
    const used = new Set(boxes.map((b) => b.id));
    let n = 1;
    while (used.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
}

/** The words an id is made from (S3e): a Text box's words (their first two: a sign's text), else its description. */
export const wordsOf = (b) => idWords(b.text, { first: true }) || idWords(b.desc);

/** `r` moved aside by a fifth of the picture (`size` { width, height }; right, else left, else down, else up), so a box turned into Move does not lie on its source. */
export function aside(size, r) {
    const dx = Math.round(size.width / 5), dy = Math.round(size.height / 5);
    if (r[2] + dx <= size.width) return [r[0] + dx, r[1], r[2] + dx, r[3]];
    if (r[0] - dx >= 0) return [r[0] - dx, r[1], r[2] - dx, r[3]];
    if (r[3] + dy <= size.height) return [r[0], r[1] + dy, r[2], r[3] + dy];
    if (r[1] - dy >= 0) return [r[0], r[1] - dy, r[2], r[3] - dy];
    return r.slice();
}

/**
 * A box held to its shape: `input` the fields given, `opts.base` the box it changes (null for a new one), `opts.boxes`
 * the document's boxes. The id matches BOX_ID and is unique in the document; a keep / move / remove box needs a source;
 * a from box a reference layer; a new box has neither. `text` makes a Text box (a new box whose words are rendered).
 * Without an id given, the id comes from the words of the description (S3e: "a red scarf" -> red_scarf_1): a new box's,
 * and a box's whose id is still a default one (box_1, edit_2) when its description or text changes, unless the prompt
 * names it as <id>; an id once made from words stays. `idBase` is the default when there are no words.
 * The document's side: `opts.size` { width, height }, `opts.referenceId(key)` the id of the reference layer a key names
 * (throws for a layer that is none), `opts.promptNames(id)` whether the prompt names the box as <id>.
 */
export function normaliseBox(input, { base = null, boxes = [], idBase = null, size, referenceId, promptNames = () => false } = {}) {
    const a = input || {};
    const kind = a.kind != null ? String(a.kind) : base ? base.kind : "new";
    if (!KINDS.has(kind)) throw new Error(`kind "${kind}" is not new, keep, move, remove or from`);
    let rect = a.rect != null ? rectOf(a.rect, "rect") : base ? base.rect : null;
    if (!rect) throw new Error("rect is required: [left, top, right, bottom] in image pixels");
    let src = a.src !== undefined ? (a.src == null ? null : rectOf(a.src, "src")) : base ? base.src : null;
    let layer = a.layer !== undefined ? (a.layer == null ? null : referenceId(a.layer)) : base ? base.layer : null;
    if (kind === "new") { src = null; layer = null; }
    else if (kind === "from") {
        src = src || null;
        if (!layer) throw new Error("a From reference box needs layer, the reference layer");
    } else {
        layer = null;
        // a New or From box turned into Keep / Move / Remove: the element is where the box is (a From box's src is
        // a part of its reference layer, not a place in the picture)
        if (base && (base.kind === "new" || base.kind === "from") && a.src === undefined) src = (kind !== "move" && a.rect != null ? rect : base.rect).slice();
        if (!src) throw new Error(`a ${kind} box needs src, where the element is now: [left, top, right, bottom]`);
        // turned into Move with the target on its source: the target steps aside, so the two can be told apart
        if (kind === "move" && base && base.kind !== "move" && a.rect == null && rect.every((v, i) => v === src[i])) rect = aside(size, src);
    }
    const desc = a.desc !== undefined ? fold(a.desc) : base ? base.desc || "" : "";
    if (desc.length > DESC_MAX) throw new Error(`desc is longer than ${DESC_MAX} characters`);
    const text = a.text !== undefined ? (a.text == null ? null : String(a.text).replace(/\s+/g, " ").trim()) : base ? base.text || null : null;
    if (text != null && kind !== "new") throw new Error("only a New box renders text");
    let id;
    const others = base ? boxes.filter((b) => b.id !== base.id) : boxes;
    if (a.id != null && String(a.id).trim() !== "") id = String(a.id).trim();
    else if (!base) id = nextId(boxes, wordsOf({ desc, text }) || idBase || (kind === "from" ? "ref" : kind === "new" ? "box" : kind));
    else {
        id = base.id;
        const words = wordsOf({ desc, text });
        const changed = desc !== (base.desc || "") || text !== (base.text == null ? null : base.text);
        if (changed && words && DEFAULT_ID.test(base.id) && !promptNames(base.id)) id = nextId(others, words);
    }
    if (!BOX_ID.test(id)) throw new Error(`the id "${id}" is not lowercase words and a number joined by underscores (knight_1, red_scarf_2), or is a picture's name (ref_image_1)`);
    if (others.some((b) => b.id === id)) throw new Error(`the id ${id} is already used by another box`);
    // every box its own colour, given when it is made and kept through every change (a box from before colours
    // keeps the one its place in the list gave it); a duplicate is a new box and gets a new one
    const colour = base ? colourSlot(base, boxes) : nextColour(boxes);
    return { id, kind, rect, src, layer, desc, text, colour };
}

// ---- changes over a list (the caller writes the result as one undo step) -------------------------------------------

/** `boxes` with a new box from `input` at the end: { boxes, box }. `ctx` as normaliseBox's document side, plus idBase. */
export function addBox(boxes, input, ctx = {}) {
    const box = normaliseBox(input, { ...ctx, base: null, boxes });
    return { boxes: [...boxes, box], box };
}

/** `boxes` with box `id` changed by `patch` (only the given fields): { boxes, box }; the box may come back renamed. */
export function setBox(boxes, id, patch, ctx = {}) {
    const i = boxes.findIndex((b) => b.id === id);
    if (i < 0) throw new Error(`no box ${id}`);
    const box = normaliseBox(patch, { ...ctx, base: boxes[i], boxes });
    const next = boxes.slice();
    next[i] = box;
    return { boxes: next, box };
}

/** `boxes` without box `id`. */
export function removeBox(boxes, id) {
    if (!boxes.some((b) => b.id === id)) throw new Error(`no box ${id}`);
    return boxes.filter((b) => b.id !== id);
}

/** The first @img token of `text` ({ label: "img1" }), or null. */
export function tokenOf(text) {
    const m = new RegExp(TOKEN.source).exec(String(text || ""));
    return m ? { label: "img" + m[1] } : null;
}

/**
 * The selection's bounds ({ x, y, w, h }) as a box's input: a New box with the prompt as its description; when the
 * prompt names a reference with @img (`layerByLabel(label)` finds the layer, or null), a From box of that layer (the
 * whole layer into the selection), the prompt still its description. Added with idBase "edit".
 */
export function selectionInput(bounds, prompt, layerByLabel, { id } = {}) {
    const { x, y, w, h } = bounds;
    const t = tokenOf(prompt);
    const ref = t && layerByLabel ? layerByLabel(t.label) : null;
    // the id from the prompt's words (red_door_1), edit_n when it has none
    return { id: id || undefined, kind: ref ? "from" : "new", rect: [x, y, x + w, y + h], layer: ref ? ref.id : undefined, desc: prompt };
}

// ---- what a run would do with the boxes (S3c) ---------------------------------------------------------------------

/** The rectangles a run measures in the crop: the target, and the source of a Keep, Move or Remove box (a From box's part lies in its layer). */
export const placed = (b) => (b.kind === "new" || b.kind === "from" ? [b.rect] : [b.rect, b.src]).filter(Array.isArray);
/** Where a box changes pixels: the target of a New, Text, From or Move box, Move's source, Remove's place; a Keep box nowhere. */
export const changes = (b) => (b.kind === "keep" ? [] : b.kind === "remove" ? [b.src || b.rect] : b.kind === "move" ? [b.rect, b.src] : [b.rect]).filter(Array.isArray);
const within = (r, f, tol = 0) => r[0] >= f[0] - tol && r[1] >= f[1] - tol && r[2] <= f[2] + tol && r[3] <= f[3] + tol;

/**
 * What Generate would do with the boxes now: `out` the ones it leaves out (outside its crop, or a sliver of it, by
 * the run's own toFrame), `cut` the ones its edge cuts, `spill` (with Paste on "selection") the ones that change
 * pixels outside the selection, where the paste cuts the result away, `small` (S3e) the ones that place something
 * in a box under 48 px a side at the size the crop is sent at. `crop` { x, y, w, h, emitted, paste } in image pixels,
 * `sel` the selection's bounding box [x0, y0, x1, y1] (2 px of slack for the soft edge). Null without a crop, a
 * selection or boxes.
 */
export function cropCheck(boxes, crop, sel) {
    if (!crop || !sel || !boxes || !boxes.length) return null;
    const f = [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h];
    const sentAt = Array.isArray(crop.emitted) ? crop.emitted : [crop.w, crop.h];
    const out = [], cut = [], spill = [], small = [];
    for (const b of boxes) {
        const rs = placed(b);
        if (rs.some((r) => !toFrame(r, crop))) { out.push(b.id); continue; }
        if (rs.some((r) => !within(r, f))) cut.push(b.id);
        if (crop.paste !== "crop" && changes(b).some((r) => !within(r, sel, 2))) spill.push(b.id);
        if (b.kind !== "keep" && b.kind !== "remove" && smallBox(toFrame(b.rect, crop), sentAt)) small.push(b.id);
    }
    return { crop, out, cut, spill, small };
}

/** The New boxes (not Text) without a description: the model would have to guess what goes there (S3e). */
export const bareOf = (boxes) => boxes.filter((b) => b.kind === "new" && b.text == null && !b.desc).map((b) => b.id);
/** The boxes a run of the recipe leaves out by their kind: Ideogram 4's caption has no Move, Remove or From (main's boxes.js). */
export const unplacedOf = (boxes, schema) => (schema === "ideogram4" ? boxes.filter((b) => b.kind === "move" || b.kind === "remove" || b.kind === "from").map((b) => b.id) : []);

const names = (ids) => `${ids.length === 1 ? "Box" : "Boxes"} ${ids.join(", ")}`;

/**
 * The panel's warning lines, [text, offersPasteWholeCrop] each: the boxes a recipe's format leaves out (`unplaced`,
 * `name` the recipe), the New boxes without a description, and cropCheck's findings (`chk`, or null).
 */
export function warningLines(chk, bare, unplaced = [], name = "") {
    const lines = [];
    if (unplaced.length) lines.push([`${names(unplaced)} ${unplaced.length === 1 ? "does" : "do"} not go with ${name}: Ideogram 4 places New, Text and Keep boxes only (Keep on an edit).`, false]);
    if (bare.length) lines.push([`${names(bare)} ${bare.length === 1 ? "has" : "have"} no description: the model does not know what goes there. Describe ${bare.length === 1 ? "it in its row" : "them in their rows"}.`, false]);
    if (chk && chk.small.length) lines.push([smallNote(chk.small), false]);
    if (chk && chk.out.length) lines.push([`${names(chk.out)} ${chk.out.length === 1 ? "lies" : "lie"} outside the crop Generate sends and ${chk.out.length === 1 ? "is" : "are"} left out.`, false]);
    if (chk && chk.cut.length) lines.push([`${names(chk.cut)} ${chk.cut.length === 1 ? "reaches" : "reach"} past the crop's edge: Generate sends the part inside it.`, false]);
    if (chk && chk.spill.length) lines.push([`${names(chk.spill)} ${chk.spill.length === 1 ? "reaches" : "reach"} outside the selection: Generate pastes the result inside the selection only and would cut ${chk.spill.length === 1 ? "it" : "them"} there.`, true]);
    return lines;
}

// ---- the picture changed its geometry: the boxes move with it --------------------------------------------------------

/**
 * A rectangle through the affine map `m` = [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f): the bounding box
 * of its four corners, whole pixels, at least 1 px each way. Anything that is not a rectangle comes back as it is.
 */
export function mapBox(r, m) {
    if (!Array.isArray(r)) return r;
    const [a, b, c, d, e, f] = m;
    const xs = [], ys = [];
    for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) { xs.push(a * x + c * y + e); ys.push(b * x + d * y + f); }
    const out = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
    if (out[2] <= out[0]) out[2] = out[0] + 1;
    if (out[3] <= out[1]) out[3] = out[1] + 1;
    return out;
}

/** Every box through `m`, as new objects (never the old ones: an undo restores the old list). A From box's src lies in its layer and maps with it. */
export const mapBoxes = (boxes, m) => boxes.map((x) => ({ ...x, rect: mapBox(x.rect, m), src: mapBox(x.src, m) }));

// ---- what a box says -----------------------------------------------------------------------------------------------

/** The desc a run gets: an @img token becomes a {@layer:id} marker the app resolves (`labels`: label -> layer id). */
export function runDesc(b, labels) {
    return (b.desc || "").replace(TOKEN, (m, n) => (labels.has("img" + n) ? `{@layer:${labels.get("img" + n)}}` : m));
}

/** The desc for the clipboard: an @img token as the model's picture name (<ref_image_k>, k the reference's number). */
export function clipDesc(b) {
    const words = b.text != null ? `text reading "${b.text}"${b.desc ? ", " + b.desc : ""}` : b.desc || "";
    return words.replace(TOKEN, (m, n) => `<ref_image_${n}>`);
}

// ---- what a prompt carries (canvas_state, docs/PLAN_NODE_BOXES.md §4) ------------------------------------------------

/** The id the selection's box gets (the app's S1): the prompt's telling words, else "edit", then "_1". */
export const selectionBoxIdOf = (prompt) => `${idWords(foldDesc(prompt)) || "edit"}_1`;

/**
 * The document's boxes as canvas_state carries them while the Boxes switch is on: `rect` in document pixels; `src` of a
 * Keep, Move or Remove box in document pixels, of a From box in fractions of its layer's frame as shown
 * ({ x: l.x, y: l.y, w: l.w, h: l.h }: a layer the transform tool scaled keeps its pixels, so the fraction is one of its
 * picture as uploaded; [0, 0, 1, 1] without a src), with `ref` the index of that layer among `refs` (the reference
 * layers this run sends, in order); `desc` folded and cut at DESC_MAX; `text` on a New box only. A From box whose layer
 * is not among `refs`, or whose part lies outside its layer, is left out with a note. Returns { boxes, notes }.
 */
export function promptPayload(list, refs, { where = "references this run sends" } = {}) {
    const notes = [];
    const ids = (refs || []).map((l) => l.id);
    const out = [];
    for (const b of list || []) {
        if (!b || typeof b.id !== "string" || !Array.isArray(b.rect)) continue;
        const o = { id: b.id, kind: b.kind, rect: b.rect.slice() };
        if (b.kind === "from") {
            const k = ids.indexOf(b.layer);
            if (k < 0) { notes.push(`Box ${b.id}: its reference layer is not among the ${where}, so the box was not sent.`); continue; }
            const l = refs[k];
            const src = Array.isArray(b.src) ? toFrame(b.src, { x: l.x, y: l.y, w: l.w, h: l.h }) : [0, 0, 1, 1];
            if (!src) { notes.push(`Box ${b.id}: its source lies outside the reference layer, so the box was not sent.`); continue; }
            o.src = src;
            o.ref = k;
        } else if (b.kind !== "new") o.src = Array.isArray(b.src) ? b.src.slice() : null;
        o.desc = foldDesc(b.desc);
        if (b.kind === "new" && b.text != null) o.text = String(b.text);
        out.push(o);
    }
    return { boxes: out, notes };
}

// ---- the commands' fields ------------------------------------------------------------------------------------------

/** The parameters the box commands share (boxes.add / boxes.set in the app, boxes_add / boxes_set in the node). */
export const FIELDS = {
    kind: { type: "string", description: "new (an element added in the box), keep, move, remove (an element of the picture), from (a reference layer placed in the box)", enum: ["new", "keep", "move", "remove", "from"] },
    rect: { type: "array", items: { type: "number" }, description: "[left, top, right, bottom] in image pixels (or { x, y, w, h }): where the element goes; for remove, where it was" },
    src: { type: "array", items: { type: "number" }, description: "keep / move / remove: where the element is now; from: the part of the reference layer, in image pixels where the layer sits (omit for the whole layer)" },
    layer: { type: "string", description: "from only: the reference layer (id, name or a unique part of it)" },
    desc: { type: "string", description: `what the element is, at most ${DESC_MAX} characters; a reference as @img1` },
    text: { type: "string", description: "new only: words to render in the box (the box becomes a Text box)" },
};
