// Generated from DenRakEiw/scumble renderer/editor/boxes_format.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The FLUX 3 rows of the document's boxes for the clipboard ("Copy rows" in the Boxes panel of the app's plugin and of
// the node's editor), measured against the whole picture. A run does not use this: the app's main process writes the
// rows it sends after it knows the crop and the final order of the pictures (electron/main/providers/boxes.js), the
// node's nodes.py through boxes_rows.py. This is a small copy of that formatter for the text a user pastes into another
// tool, kept to the same vectors by tools/boxes_test.js. Pure functions, no DOM; shared by both hosts
// (docs/PLAN_NODE_BOXES.md B3, moved here from plugins/boxes/format.js).
//
// docs.bfl.ai/flux_3: a box is [top, left, bottom, right] on a 0 to 1000 grid of the picture; an edit's row is
// { id, from, src_bbox, tgt_bbox, desc } (the picture itself is <ref_image_0>, the other pictures <ref_image_k>), a new
// image's row { id, bbox, desc }; the instruction names each element as <id>.

/** A rectangle in image pixels ([l, t, r, b]) on the 0 to 1000 grid of `frame` ({ x, y, w, h }) as [top, left, bottom, right]. */
export function grid(rectPx, frame) {
    const c = (v) => Math.max(0, Math.min(1, v));
    const f = [c((rectPx[0] - frame.x) / frame.w), c((rectPx[1] - frame.y) / frame.h), c((rectPx[2] - frame.x) / frame.w), c((rectPx[3] - frame.y) / frame.h)];
    const g = (v) => Math.max(0, Math.min(1000, Math.round(v * 1000)));
    let t = g(f[1]), l = g(f[0]), b = g(f[3]), r = g(f[2]);
    if (b <= t) { if (t >= 1000) t = 999; b = t + 1; }
    if (r <= l) { if (l >= 1000) l = 999; r = l + 1; }
    return [t, l, b, r];
}

/** True when the rectangle has no part inside the frame (the app leaves such a box out of a run with a note). */
export function outside(rectPx, frame) {
    if (!Array.isArray(rectPx)) return true;
    const l = Math.max(rectPx[0], frame.x), t = Math.max(rectPx[1], frame.y);
    const r = Math.min(rectPx[2], frame.x + frame.w), b = Math.min(rectPx[3], frame.y + frame.h);
    return !(r - l >= frame.w / 1000 && b - t >= frame.h / 1000);
}

/** The longest description a row carries (main's DESC_MAX). */
const DESC_MAX = 400;

/** A description as a row carries it: one line, at most 400 characters. */
export const fold = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, DESC_MAX);

/**
 * The rows of an edit against `frame` (the picture): `nameOf(layerId)` gives a from box's picture name
 * ("ref_image_2") or null when that layer is not a shown reference (the box is skipped with a note). `descOf(box)`
 * is the description as the row carries it (the panel resolves @img tokens before). Returns { rows, notes }.
 */
export function rowsFlux3(boxes, frame, { nameOf, descOf = (b) => fold(b.desc), frameName = "ref_image_0" } = {}) {
    const rows = [], notes = [];
    for (const b of boxes || []) {
        const desc = descOf(b);
        if (b.kind !== "new" && b.kind !== "from" && outside(b.src, frame)) { notes.push(`${b.id}: its source lies outside the picture.`); continue; }
        if (outside(b.rect, frame)) { notes.push(`${b.id} lies outside the picture.`); continue; }
        switch (b.kind) {
            case "new": rows.push({ id: b.id, from: null, src_bbox: null, tgt_bbox: grid(b.rect, frame), desc }); break;
            case "keep": rows.push({ id: b.id, from: frameName, src_bbox: grid(b.src, frame), tgt_bbox: grid(b.src, frame), desc }); break;
            case "move": rows.push({ id: b.id, from: frameName, src_bbox: grid(b.src, frame), tgt_bbox: grid(b.rect, frame), desc }); break;
            case "remove": rows.push({ id: b.id, from: frameName, src_bbox: grid(b.src, frame), tgt_bbox: null, desc }); break;
            case "from": {
                const name = nameOf ? nameOf(b.layer) : null;
                if (!name) { notes.push(`${b.id}: its reference layer is not shown.`); continue; }
                // the whole reference when no part of it is named; a part is measured in the layer's own frame
                const src = b.src && b.layerFrame ? grid(b.src, b.layerFrame) : [0, 0, 1000, 1000];
                rows.push({ id: b.id, from: name, src_bbox: src, tgt_bbox: grid(b.rect, frame), desc });
                break;
            }
            default: break;
        }
    }
    return { rows, notes };
}

/**
 * The rows of a new image (Generate new): only New boxes (a Text box among them) have a place in a picture that does
 * not exist yet; the notes say the same as main's refusals (electron/main/providers/boxes.js rowsFlux3).
 */
export function rowsText(boxes, frame, { descOf = (b) => fold(b.desc) } = {}) {
    const rows = [], notes = [];
    for (const b of boxes || []) {
        if (b.kind === "from") { notes.push(`${b.id}: on a new image FLUX 3 places New and Text boxes only (from: a New box whose description names the reference picture places it).`); continue; }
        if (b.kind !== "new") { notes.push(`${b.id}: a new image has no source to keep, move or remove (${b.kind}).`); continue; }
        if (outside(b.rect, frame)) { notes.push(`${b.id} lies outside the picture.`); continue; }
        rows.push({ id: b.id, bbox: grid(b.rect, frame), desc: descOf(b) });
    }
    return { rows, notes };
}

// ---- the caption: a copy of main's clauseOf .. captionFlux3 (electron/main/providers/boxes.js), same vectors ---------

/** Words that open an instruction: a description that starts with one goes into the caption as it is ("make the tiger pink"). */
const VERB = /^(?:add|bring|brighten|change|darken|draw|fill|give|insert|lighten|make|paint|place|put|recolou?r|render|replace|show|swap|turn|use|write)\b/i;

/** A description as a clause of the caption: one line, no closing stop, a capital that only opened the sentence lowered (an acronym keeps its case). */
function clauseOf(s) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim().replace(/[\s.!;:,]+$/, "");
    return /^(?:[A-Z][a-z]|A(?=\s))/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** `s` without a leading verb of the kind's own ("move the lamp" -> "the lamp"), so the clause does not say it twice. */
const dropVerb = (s, re) => s.replace(re, "").trim();

/** Where a box lies in the frame (a grid box), in words by thirds of the frame; over three quarters each way "over most of the picture". */
export function whereWords(g) {
    if (!Array.isArray(g) || g.length !== 4) return "";
    if (g[2] - g[0] >= 750 && g[3] - g[1] >= 750) return "over most of the picture";
    const third = (mid, lo, hi) => (mid * 3 < 1000 ? lo : mid * 3 > 2000 ? hi : "");
    const v = third((g[0] + g[2]) / 2, "top", "bottom"), h = third((g[1] + g[3]) / 2, "left", "right");
    return v && h ? `at the ${v} ${h}` : v ? `at the ${v}` : h ? `on the ${h}` : "in the middle";
}

/** Which way a Move box goes (grids), in words: a tenth of the frame makes a direction, half the area again ", larger" / ", smaller". */
export function wayWords(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return "to its new box";
    const dy = (b[0] + b[2] - a[0] - a[2]) / 2, dx = (b[1] + b[3] - a[1] - a[3]) / 2;
    const v = dy <= -100 ? "up" : dy >= 100 ? "down" : "";
    const h = dx <= -100 ? "to the left" : dx >= 100 ? "to the right" : "";
    const way = v && h ? `${v} and ${h}` : v || h || "to its new box";
    const area = (g) => Math.max(1, (g[2] - g[0]) * (g[3] - g[1]));
    const k = area(b) / area(a);
    return k >= 1.5 ? `${way}, larger` : k <= 1 / 1.5 ? `${way}, smaller` : way;
}

/** The caption's clause for one box and its row: what happens to it, named as <id>, and where. */
function clauseFlux3(b, row) {
    const d = clauseOf(row.desc), id = `<${b.id}>`;
    switch (b.kind) {
        case "new": {
            const where = whereWords(row.tgt_bbox || row.bbox);
            return d ? `${VERB.test(d) ? d : "place " + d} ${id} ${where}` : `fill the area ${id} ${where} so it fits the picture`;
        }
        case "from": {
            const where = whereWords(row.tgt_bbox), pic = `<${row.from}>`;
            return d ? `${VERB.test(d) ? d : "place " + d} ${id} from ${pic} ${where}` : `place what ${pic} shows as ${id} ${where}`;
        }
        case "move": return `move ${dropVerb(d, /^move\b/i) || "the element"} ${id} ${wayWords(row.src_bbox, row.tgt_bbox)}`;
        case "remove": return `remove ${dropVerb(d, /^(?:remove|erase|delete)\b/i) || "the element"} ${id} ${whereWords(row.src_bbox)}`;
        case "keep": return `keep ${dropVerb(d, /^keep\b/i) || "the element"} ${id} as it is`;
        default: return "";
    }
}

/** The clause of a box whose description is the prompt itself (the selection's box): only where, the prompt says what. */
function placeOnly(b, row) {
    const where = whereWords(row.tgt_bbox || row.bbox);
    return b.kind === "from" && row.from ? `<${row.from}> goes in <${b.id}> ${where}` : `the change goes in <${b.id}> ${where}`;
}

/**
 * The caption the rows go with: the prompt as it is, then one sentence per box it does not name by `<id>` with its
 * description and its place in words (a box whose description is the prompt, cut at 400 or not, only where); `frame`
 * the picture's name on an edit, null on a new image ("In <frame>, " opens the first sentence, "Leave the rest of the
 * picture as it is." closes an edit whose prompt is empty or one box's description).
 */
export function captionFlux3(prompt, boxes, rows, frame) {
    const text = String(prompt == null ? "" : prompt).replace(/\s+/g, " ").trim();
    const byId = new Map((rows || []).map((r) => [r.id, r]));
    const told = (boxes || []).filter((b) => b && byId.has(b.id) && !text.includes(`<${b.id}>`));
    const plain = (s) => clauseOf(s).toLowerCase();
    const whole = plain(text);
    const isPrompt = (d) => { const a = plain(d); return !!a && (a === whole || (a.length >= DESC_MAX - 10 && whole.length > a.length && whole.startsWith(a))); };
    const said = !!text && told.some((b) => isPrompt(byId.get(b.id).desc));
    const clauses = told.map((b) => (isPrompt(byId.get(b.id).desc) ? placeOnly(b, byId.get(b.id)) : clauseFlux3(b, byId.get(b.id)))).filter(Boolean);
    if (clauses.length && frame && !text.includes(`<${frame}>`)) clauses[0] = `In <${frame}>, ${clauses[0]}`;
    const sentences = clauses.map((s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
    if (frame && byId.size && (!text || said)) sentences.push("Leave the rest of the picture as it is.");
    const head = text && sentences.length && !/[.!?]$/.test(text) ? `${text}.` : text;
    return [head, ...sentences].filter(Boolean).join(" ");
}

/** The prompt with the caption's sentences (captionFlux3); `edit` false for a new image (no frame). */
export function instructionFlux3(prompt, boxes, rows, { edit = true, frameName = "ref_image_0" } = {}) {
    return captionFlux3(prompt, boxes, rows, edit ? frameName : null);
}

/** The clipboard text: the instruction, a space and the JSON rows, as a run sends it. Returns { text, rows, notes }. */
export function clipboardText(prompt, boxes, frame, { mode = "edit", nameOf, descOf } = {}) {
    const got = mode === "new" ? rowsText(boxes, frame, { descOf }) : rowsFlux3(boxes, frame, { nameOf, descOf });
    const instruction = instructionFlux3(prompt, boxes, got.rows, { edit: mode !== "new" });
    return { text: got.rows.length ? `${instruction} ${JSON.stringify(got.rows)}` : instruction, rows: got.rows, notes: got.notes };
}
