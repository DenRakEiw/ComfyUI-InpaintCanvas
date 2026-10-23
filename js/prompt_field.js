// Generated from DenRakEiw/scumble renderer/editor/prompt_field.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The prompt field of the app (item 26, docs/PLAN_REFS.md 26c and C4): a contenteditable that the rest of the editor
// reads like the textarea it replaces (`value`, the selection, `setSelectionRange`, `input` and `change`), and that
// draws each @img token of the prompt as a chip: a round thumbnail, the label, a chevron. The text stays a plain
// string (reftokens.js C1); the DOM is only its drawing, built again from the text whenever the two would differ.
//
// Plain typing is left to the browser, so dead keys, IMEs and the caret keep their own feel. Every edit that could touch
// a chip or leave markup behind is made here on the string and drawn again: Enter, a delete next to a chip, paste, cut,
// typing over a selection. A chip is one unit: the caret steps over it, Backspace and Delete take it whole. Where no
// text stands next to a chip, a text node holding one U+200B (a guard) gives Chromium a place for the caret; the string
// never holds one. The field keeps its own undo, since the browser's does not survive a redraw.
//
// In the node's FILES (tools/build_node.py), although only the app builds it (its host's `refTokens`). Nothing touches
// `document` or `window` at import time, so tools/prompt_field_test.js runs the helpers in plain Node.

import { parse, normalize, hasTokens, diffRange, mapOffset, TOKEN } from "./reftokens.js";

export { diffRange, mapOffset };

/** The caret guard: an invisible character Chromium can put the caret beside. Never part of the text. */
export const GUARD = String.fromCharCode(0x200b);
const GUARDS = new RegExp(GUARD, "g");
// besides white space, the characters after which an @ starts a word: brackets and the opening quotes (" ' „ “ ‚ «)
const OPENERS = new Set(["(", "[", "{", "\"", "'", String.fromCharCode(0x201e), String.fromCharCode(0x201c), String.fromCharCode(0x201a), String.fromCharCode(0xab)]);

/**
 * A text as the field holds it: line breaks as LF, no caret guards, every token's prefix in lower case (C1 `normalize`).
 * @param {unknown} text
 * @returns {string}
 */
export function sanitize(text) {
    return normalize(String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(GUARDS, ""));
}

/**
 * Does offset `i` start a word, so that an @ typed there may open the picker? At the start of the text, after white
 * space (a line break too), an opening bracket or an opening quote; `mail@` is no word start.
 * @param {string} text
 * @param {number} i
 */
export function atWordStart(text, i) {
    if (i <= 0) return true;
    const c = String(text == null ? "" : text)[i - 1];
    return c === undefined || /\s/.test(c) || OPENERS.has(c);
}

let segmenter;
function graphemes() {
    if (segmenter === undefined) {
        try { segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch (_) { segmenter = null; }
    }
    return segmenter;
}
// no grapheme is longer than this: one step never segments a long text whole
const WINDOW = 64;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** where the grapheme that ends at offset i starts */
function graphemeStart(text, i) {
    if (i <= 0) return 0;
    const seg = graphemes();
    if (!seg) return i - (i >= 2 && isLow(text.charCodeAt(i - 1)) && isHigh(text.charCodeAt(i - 2)) ? 2 : 1);
    const from = Math.max(0, i - WINDOW);
    let last = 0;
    for (const g of seg.segment(text.slice(from, i))) last = g.index;
    return from + last;
}

/** where the grapheme that starts at offset i ends */
function graphemeEnd(text, i) {
    if (i >= text.length) return text.length;
    const seg = graphemes();
    if (!seg) return i + (i + 1 < text.length && isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? 2 : 1);
    for (const g of seg.segment(text.slice(i, i + WINDOW))) return i + g.segment.length;
    return i + 1;
}

/**
 * What Backspace deletes and ArrowLeft steps over from `caret`: a whole chip when one ends there (or holds the caret),
 * else one grapheme. `segs` is the field's render plan (`renderPlan`): only the tokens it draws as chips are units, so a
 * token still being typed goes a character at a time.
 * @param {string} text
 * @param {number} caret
 * @param {ReturnType<typeof renderPlan> | null} segs
 * @returns {[number, number]}
 */
export function unitBefore(text, caret, segs) {
    const s = String(text == null ? "" : text);
    const c = Math.max(0, Math.min(Number(caret) || 0, s.length));
    for (const g of segs || []) if (g.type === "chip" && g.start < c && c <= g.end) return [g.start, g.end];
    return [graphemeStart(s, c), c];
}

/**
 * What Delete deletes and ArrowRight steps over from `caret`, as `unitBefore` the other way.
 * @param {string} text
 * @param {number} caret
 * @param {ReturnType<typeof renderPlan> | null} segs
 * @returns {[number, number]}
 */
export function unitAfter(text, caret, segs) {
    const s = String(text == null ? "" : text);
    const c = Math.max(0, Math.min(Number(caret) || 0, s.length));
    for (const g of segs || []) if (g.type === "chip" && g.start <= c && c < g.end) return [g.start, g.end];
    return [c, graphemeEnd(s, c)];
}

/** @typedef {{ text: string, start: number, end: number }} FieldState */

const copyState = (e) => ({ text: String(e.text), start: e.start, end: e.end });

/**
 * The field's own undo (C4). Entries are whole states `{text, start, end}`; a step is recorded with the state before
 * and after it. Typing ("type") and deleting ("delete") merge into the step before when they follow it within
 * `mergeMs` with the caret where that step left it, and typing breaks at white space, so an undo takes back a word, as
 * in a textarea. Every other kind is a step of its own. At most `cap` steps are kept.
 */
export class EditHistory {
    constructor({ cap = 200, mergeMs = 1000 } = {}) {
        this.cap = cap;
        this.mergeMs = mergeMs;
        /** @type {FieldState[]} */
        this.undoStack = [];
        /** @type {FieldState[]} */
        this.redoStack = [];
        // the step that is still open for merging: its kind, when it was last extended, the state it left
        this.last = null;
    }

    get undoCount() { return this.undoStack.length; }
    get redoCount() { return this.redoStack.length; }

    /**
     * One edit, `prev` -> `next`. Returns true when it became a step of its own, false when it merged into the one
     * before or changed no text (a caret move is no step).
     * @param {FieldState} prev
     * @param {FieldState} next
     * @param {string} [kind] "type" and "delete" merge; anything else ("set", "paste", "line", ...) does not
     * @param {number} [now]
     */
    record(prev, next, kind = "set", now = Date.now()) {
        if (!prev || !next || prev.text === next.text) return false;
        const merging = kind === "type" || kind === "delete";
        let space = false;
        if (kind === "type") {
            const d = diffRange(prev.text, next.text);
            space = /^\s/.test(next.text.slice(d.start, d.endB));
        }
        const l = this.last;
        if (merging && l && l.kind === kind && now - l.time < this.mergeMs && l.next.text === prev.text
            && l.next.start === prev.start && l.next.end === prev.end && !(space && !l.space)) {
            this.last = { kind, time: now, next: copyState(next), space };
            return false;
        }
        this.undoStack.push(copyState(prev));
        if (this.undoStack.length > this.cap) this.undoStack.splice(0, this.undoStack.length - this.cap);
        this.redoStack.length = 0;
        this.last = merging ? { kind, time: now, next: copyState(next), space } : null;
        return true;
    }

    /**
     * The state before the last step, or null when there is none; `cur` goes onto the redo stack.
     * @param {FieldState} cur
     */
    undo(cur) {
        if (!this.undoStack.length) return null;
        const e = this.undoStack.pop();
        this.redoStack.push(copyState(cur));
        this.last = null;
        return copyState(e);
    }

    /**
     * The state the last undo left, or null; `cur` goes back onto the undo stack.
     * @param {FieldState} cur
     */
    redo(cur) {
        if (!this.redoStack.length) return null;
        const e = this.redoStack.pop();
        this.undoStack.push(copyState(cur));
        this.last = null;
        return copyState(e);
    }

    /** No steps any more (a document opened, a snapshot restored). */
    reset() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.last = null;
    }

    /**
     * Every kept state through a text-to-text function (a remap of the tokens, docs/PLAN_REFS.md C2), its caret carried
     * through the change (`mapOffset`); no step is added. So an undo after a remap gives the older text with the tokens
     * that name the same pictures now.
     * @param {(text: string) => string} fn
     */
    map(fn) {
        for (const stack of [this.undoStack, this.redoStack]) {
            for (const e of stack) {
                const t = fn(e.text);
                if (typeof t !== "string" || t === e.text) continue;
                e.start = mapOffset(e.start, e.text, t);
                e.end = mapOffset(e.end, e.text, t);
                e.text = t;
            }
        }
        this.last = null;
    }
}

/**
 * `over`: past the route's cap (the host's refLayout), `sentAs`: the name the route gives its picture (null unknown).
 * @typedef {{ id: string, label: number | null, name: string, visible: boolean, thumb: string | null, sentAs: string | null, over?: boolean }} Descriptor
 * `cap`: the reference layers the route takes (null: none declared), `none`: why none goes with this recipe, `local`: a
 * ComfyUI recipe (its crop_image batch; with a `cap` its graph was traced and each descriptor's `sentAs` is the name
 * the graph gives the picture, 26e), `refuse`: why a token cannot go although the pictures do (the hover card and the
 * bar say it, the chip stays live), `show(id)`: a hidden reference shown the way its eye shows it (26c2's swap menu).
 * @typedef {{ refs: Descriptor[], cap: number | null, none: string | null, local?: boolean, refuse?: string | null, canAdd: boolean, reason: (id: string) => string, show?: (id: string) => void }} RefContext
 */

/**
 * The picker's rows for what was typed after the @ (26c2): the shown references whose `img<n>` or name holds every
 * word of the query, in list order. Hidden ones are not listed (they cannot be sent).
 * @param {RefContext | null} ctx
 * @param {string} query
 * @returns {Descriptor[]}
 */
export function pickerRows(ctx, query) {
    const words = String(query == null ? "" : query).toLowerCase().split(/\s+/).filter(Boolean);
    const refs = ((ctx && ctx.refs) || []).filter((d) => d.label != null);
    return refs.filter((d) => {
        const hay = `img${d.label} ${d.name || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The count at the right of the reference bar (26c2): how many shown references go, against what the recipe takes.
 * @param {RefContext | null} ctx
 * @returns {{ text: string, title: string, over: boolean }}
 */
export function barCount(ctx) {
    const c = ctx || EMPTY_CONTEXT;
    const n = (c.refs || []).filter((d) => d.label != null).length;
    if (c.none) return { text: "This recipe sends no reference images", title: c.none, over: false };
    // a local recipe whose graph could not be traced: no count known, the pictures ride in its crop_image batch
    if (c.local && c.cap == null) return { text: `${n} in crop_image`, title: "A ComfyUI recipe takes the shown reference layers in its crop_image batch, after the crop" + (c.refuse ? "; an @img token: " + c.refuse : "") + ".", over: false };
    const why = c.refuse ? `; an @img token: ${c.refuse}` : "";
    if (c.cap != null) return { text: `${n} of ${c.cap} for this recipe`, title: `This recipe takes ${plural(c.cap, "reference image", "reference images")}${why}.`, over: n > c.cap };
    return { text: plural(n, "reference image", "reference images"), title: c.refuse ? `An @img token: ${c.refuse}.` : "", over: false };
}

/**
 * The line of the hover card under the name (26c2): what the token goes out as, or why it does not.
 * @param {{ state: string, label: string, reason: string, ref: Descriptor | null }} st a chipState
 * @param {RefContext | null} ctx
 */
export function cardLine(st, ctx) {
    if (st.state !== "live") return st.reason ? `${st.label} \u00b7 ${st.reason}` : st.label;
    const d = st.ref;
    if (d && d.sentAs) return `${st.label} \u00b7 sent as ${d.sentAs}`;
    if (ctx && ctx.local) return `${st.label} \u00b7 in the crop_image batch${ctx.refuse ? "; " + ctx.refuse : ""}`;
    if (ctx && ctx.refuse) return `${st.label} \u00b7 ${ctx.refuse}`;
    return st.label;
}

/** a name cut for a chip: at most 14 characters (graphemes), the last an ellipsis when it was longer */
function cut(name, n = 14) {
    const s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    const seg = graphemes();
    const a = seg ? Array.from(seg.segment(s), (g) => g.segment) : Array.from(s);
    return a.length > n ? a.slice(0, n - 1).join("") + String.fromCharCode(0x2026) : a.join("");
}

/**
 * How a token is drawn (C4): `live` when a shown reference holds its label, `broken` when none does or its layer is
 * gone, `inactive` for a parked token whose layer is still a reference (hidden, or without pixels yet). A live token is
 * `none` when the recipe sends no reference image and `over` when its picture is past the recipe's cap (26c2). `label`
 * is what the chip says, `reason` why it does not go as it is, `ref` the reference's descriptor.
 * @param {{ n?: number, id?: string }} seg a token of `parse`
 * @param {RefContext | null} ctx
 * @returns {{ state: "live" | "over" | "none" | "inactive" | "broken", label: string, reason: string, ref: Descriptor | null }}
 */
export function chipState(seg, ctx) {
    const refs = (ctx && ctx.refs) || [];
    if (seg.n != null) {
        const d = refs.find((r) => r.label === seg.n);
        if (d && ctx.none) return { state: "none", label: "img" + seg.n, reason: ctx.none, ref: d };
        if (d && d.over) {
            const cap = ctx.cap;
            return { state: "over", label: "img" + seg.n, reason: cap != null ? `this recipe takes ${plural(cap, "reference image", "reference images")}` : "past what this recipe takes", ref: d };
        }
        if (d) return { state: "live", label: "img" + seg.n, reason: "", ref: d };
        return { state: "broken", label: "img" + seg.n, reason: `no reference img${seg.n}`, ref: null };
    }
    const d = refs.find((r) => r.id === seg.id);
    if (d) {
        const reason = d.label != null ? `written for a hidden reference: it is img${d.label} now, name it as @img${d.label}`
            : d.visible ? "no pixels: this reference is not loaded" : "hidden: show it under References to send it";
        return { state: "inactive", label: cut(d.name || "reference"), reason, ref: d };
    }
    let why = "deleted";
    try { why = (ctx && typeof ctx.reason === "function" && ctx.reason(seg.id)) || why; } catch (_) { /* the default */ }
    return { state: "broken", label: "img?", reason: why, ref: null };
}

/**
 * @typedef {{ type: "text", text: string, start: number, end: number }} TextPiece
 * @typedef {{ type: "chip", text: string, token: string, start: number, end: number, n?: number, id?: string, state: string, label: string, reason: string, ref: Descriptor | null }} ChipPiece
 */

/**
 * The text as the field draws it: plain runs and chips with their offsets, in order. A token that overlaps `open`
 * ([start, end], the token being typed) stays text, so typing @img1 and then 2 gives @img12 and not a chip and a "2".
 * @param {string} text
 * @param {RefContext | null} ctx
 * @param {[number, number] | null} [open]
 * @returns {(TextPiece | ChipPiece)[]}
 */
export function renderPlan(text, ctx, open = null) {
    /** @type {(TextPiece | ChipPiece)[]} */
    const out = [];
    let at = 0;
    const addText = (t, start) => {
        const last = out[out.length - 1];
        if (last && last.type === "text") { last.text += t; last.end += t.length; }
        else out.push({ type: "text", text: t, start, end: start + t.length });
    };
    for (const seg of parse(text)) {
        const start = at, end = at + seg.text.length;
        at = end;
        if (seg.type === "token" && !(open && start < open[1] && end > open[0])) {
            const token = "@img" + seg.text.slice(4);
            /** @type {ChipPiece} */
            const chip = { type: "chip", text: seg.text, token, start, end, ...chipState(seg, ctx) };
            if ("n" in seg) chip.n = seg.n; else chip.id = seg.id;
            out.push(chip);
        } else addText(seg.text, start);
    }
    return out;
}

/**
 * What the DOM holds for a plan, child by child: text runs, guards where no text stands next to a chip (the start,
 * after a line break, between two chips, before a line break, the end), chips, and a trailing <br> when the text is
 * empty or ends in a line break (the last line has no height without it).
 */
function layoutOf(plan) {
    const items = [];
    for (let i = 0; i < plan.length; i++) {
        const s = plan[i];
        if (s.type === "text") { items.push({ kind: "text", text: s.text, start: s.start, end: s.end }); continue; }
        const prev = plan[i - 1], next = plan[i + 1];
        if (!prev || (prev.type === "text" && prev.text.endsWith("\n"))) items.push({ kind: "guard", at: s.start });
        items.push({ kind: "chip", seg: s, start: s.start, end: s.end, sig: chipSig(s) });
        if (!next || next.type === "chip" || next.text.startsWith("\n")) items.push({ kind: "guard", at: s.end });
    }
    const last = plan[plan.length - 1];
    if (!last || (last.type === "text" && last.text.endsWith("\n"))) items.push({ kind: "br" });
    return items;
}

const chipSig = (s) => [s.token, s.state, s.label, s.reason, s.ref ? s.ref.name : ""].join("\u0001");
const itemSig = (it) => (it.kind === "text" ? "t" + it.text : it.kind === "chip" ? "c" + it.sig : it.kind === "guard" ? "g" : "br");

function isChip(n) { return !!n && n.nodeType === 1 && n.classList && n.classList.contains("ipc-chip"); }

/** what a child of the field stands for, in the terms of itemSig: anything render() does not make is "x" */
function nodeSig(n) {
    if (n.nodeType === 3) return n.data === GUARD ? "g" : n.data.includes(GUARD) ? "x" : "t" + n.data;
    if (isChip(n)) return "c" + (n._sig || "");
    if (n.nodeName === "BR" && n.hasAttribute("data-trail")) return "br";
    return "x";
}

/**
 * What the DOM of the field reads as, up to the point (stopNode, stopOff) when one is given: text nodes without their
 * guards, a chip as its token, a trailing <br> as nothing and any other <br> as a line break, and whatever else a
 * native edit left behind by its children (a <div> starting a line). `dirty` says the DOM held such markup.
 */
function measure(root, stopNode = null, stopOff = 0) {
    let text = "", dirty = false, stop = false;
    const visit = (parent) => {
        const kids = parent.childNodes;
        for (let i = 0; i < kids.length && !stop; i++) {
            if (parent === stopNode && i === stopOff) { stop = true; return; }
            const c = kids[i];
            if (c.nodeType === 3) {
                if (c === stopNode) { text += c.data.slice(0, stopOff).replace(GUARDS, ""); stop = true; return; }
                text += c.data.replace(GUARDS, "");
            } else if (isChip(c)) {
                if (stopNode && (c === stopNode || c.contains(stopNode))) {
                    // a point on the chip: its start at the very front, else its end
                    const front = (c === stopNode && stopOff === 0) || (c.firstChild && c.firstChild.contains(stopNode));
                    if (!front) text += c.dataset.token || "";
                    stop = true;
                    return;
                }
                text += c.dataset.token || "";
            } else if (c.nodeName === "BR") {
                if (c === stopNode) { stop = true; return; }
                if (!c.hasAttribute("data-trail")) { text += "\n"; dirty = true; }
            } else if (c.nodeType === 1) {
                dirty = true;
                if (c.nodeName === "DIV" && text && !text.endsWith("\n")) text += "\n";
                visit(c);
            }
        }
        if (parent === stopNode) stop = true;
    };
    visit(root);
    return { text, dirty };
}

/** the offset in a text node's data before which `k` characters that are not guards stand */
function domIndex(data, k) {
    let c = 0;
    for (let i = 0; i < data.length; i++) {
        if (c === k) return i;
        if (data[i] !== GUARD) c++;
    }
    return data.length;
}

const EMPTY_CONTEXT = { refs: [], cap: null, none: null, canAdd: false, reason: () => "deleted" };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The field (C4). `el` is the contenteditable the editor keeps as `promptInput`. `refs()` answers the RefContext the
 * chips are drawn from; `popupRoot`, `addReferences` and `preview` are for the picker, the bar and the hover card
 * (26c2).
 */
export class PromptField {
    constructor({ placeholder = "", refs = null, popupRoot = null, addReferences = null, preview = null } = {}) {
        this.refs = typeof refs === "function" ? refs : () => EMPTY_CONTEXT;
        this.popupRoot = popupRoot;
        this.addReferencesFn = addReferences;
        this.preview = preview;
        this.text = "";
        this.anchor = 0;          // the selection as model offsets, kept while the field has no focus (as a textarea's)
        this.focusOff = 0;
        this.open = null;         // [start, end] of the token being typed, drawn as text until the caret leaves it
        this.composing = false;
        this.queued = [];         // the setText calls that came during a composition, in order
        this.dirty = false;       // a native edit left markup render() does not make
        this.pre = null;          // the state before the edit in progress (beforeinput, compositionstart)
        this.nativePending = false;
        this.firing = false;
        this.pointerHeld = false;
        this.fromPointer = false;
        this.renderAfterPointer = false;
        this.autoSpace = null;    // the offset of a space the field put between a typed word and a chip (spaced)
        this.focusText = null;
        this.history = new EditHistory();
        this.plan = [];
        this.runs = [];
        this.destroyed = false;
        const el = document.createElement("div");
        el.className = "ipc-pf";
        el.contentEditable = "plaintext-only";
        el.setAttribute("role", "textbox");
        el.setAttribute("aria-multiline", "true");
        el.spellcheck = false;
        el.setAttribute("autocorrect", "off");
        el.setAttribute("autocapitalize", "off");
        el.setAttribute("translate", "no");
        el.dataset.placeholder = String(placeholder || "");
        this.el = el;
        this.defineApi();
        this.bindEvents();
        this.render();
    }

    // ---- the textarea's API on the element --------------------------------------------------------------------------

    defineApi() {
        const f = this;
        Object.defineProperties(this.el, {
            value: {
                configurable: true,
                get() { return f.composing ? f.pendingValue() : f.nativePending ? sanitize(measure(f.el).text) : f.text; },
                set(v) { f.setText(v, { history: "push" }); },
            },
            selectionStart: {
                configurable: true,
                get() { return f.readSel()[0]; },
                set(v) { const e = f.readSel()[1]; f.setSelectionRange(v, Math.max(Number(v) || 0, e)); },
            },
            selectionEnd: {
                configurable: true,
                get() { return f.readSel()[1]; },
                set(v) { const s = f.readSel()[0]; f.setSelectionRange(Math.min(s, Number(v) || 0), v); },
            },
            selectionDirection: {
                configurable: true,
                get() { f.readSel(); return f.focusOff < f.anchor ? "backward" : "forward"; },
            },
            setSelectionRange: { configurable: true, value: (s, e, dir) => f.setSelectionRange(s, e, dir) },
            select: { configurable: true, value: () => f.setSelectionRange(0, f.text.length) },
            placeholder: {
                configurable: true,
                get() { return f.el.dataset.placeholder || ""; },
                set(v) { f.el.dataset.placeholder = String(v == null ? "" : v); },
            },
            disabled: {
                configurable: true,
                get() { return f.el.getAttribute("aria-disabled") === "true"; },
                set(v) {
                    f.el.contentEditable = v ? "false" : "plaintext-only";
                    if (v) f.el.setAttribute("aria-disabled", "true"); else f.el.removeAttribute("aria-disabled");
                },
            },
        });
    }

    hasFocus() {
        return typeof document !== "undefined" && document.activeElement === this.el;
    }

    /** The model offsets of the document selection when it lies in the field, [anchor, focus]; else null. */
    domSel() {
        const s = document.getSelection();
        if (!s || !s.anchorNode || !this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
        return [this.domToOffset(s.anchorNode, s.anchorOffset), this.domToOffset(s.focusNode, s.focusOffset)];
    }

    /** The selection [start, end]: read from the document while the field has the focus, else the one it kept. */
    readSel() {
        if (this.hasFocus()) {
            const d = this.domSel();
            if (d) { this.anchor = d[0]; this.focusOff = d[1]; }
        }
        const n = this.text.length;
        this.anchor = clamp(this.anchor, 0, n);
        this.focusOff = clamp(this.focusOff, 0, n);
        return [Math.min(this.anchor, this.focusOff), Math.max(this.anchor, this.focusOff)];
    }

    /** an offset inside a chip goes to the chip's nearer edge, or to its end (`toEnd`: text typed into it) */
    snap(off, toEnd = false) {
        for (const g of this.plan) if (g.type === "chip" && g.start < off && off < g.end) return toEnd || off - g.start > g.end - off ? g.end : g.start;
        return off;
    }

    /**
     * As a textarea's: stored, and put into the document only when the field has the focus (placing the document
     * selection in a contenteditable focuses it, which would take the focus from the assistant's chat during an
     * agent's set_prompt).
     */
    setSelectionRange(start, end, dir = "none") {
        const n = this.text.length;
        let a = clamp(Number(start) || 0, 0, n);
        const b = clamp(end == null ? a : Number(end) || 0, 0, n);
        if (a > b) a = b;
        const s = this.snap(a), e = this.snap(b);
        if (dir === "backward") { this.anchor = e; this.focusOff = s; } else { this.anchor = s; this.focusOff = e; }
        if (this.hasFocus()) this.applySel();
        this.markSel();
    }

    /** anchor and focus as given (an arrow key with Shift moves only the focus) */
    setSel(anchor, focus) {
        const n = this.text.length;
        this.anchor = this.snap(clamp(anchor, 0, n));
        this.focusOff = this.snap(clamp(focus, 0, n));
        if (this.hasFocus()) this.applySel();
        this.markSel();
    }

    /** the kept selection into the document */
    applySel() {
        const s = document.getSelection();
        if (!s) return;
        const [an, ao] = this.offsetToDom(this.anchor), [fn, fo] = this.offsetToDom(this.focusOff);
        if (s.anchorNode === an && s.anchorOffset === ao && s.focusNode === fn && s.focusOffset === fo) return;
        try { s.setBaseAndExtent(an, ao, fn, fo); } catch (_) { /* a node that just left the field */ }
    }

    /** The model offset of a DOM point in the field: the length of what the field reads before it. */
    domToOffset(node, o) {
        if (node === this.el && !this.dirty) {
            // the common case after a render: the runs know where each child starts
            const kid = this.el.childNodes[o];
            if (!kid) return this.text.length;
            const r = this.runs.find((x) => x.node === kid);
            if (r) return r.start;
        }
        if (node && node.nodeType === 3 && node.parentNode === this.el && !this.nativePending && !this.composing) {
            const r = this.runs.find((x) => x.node === node);
            if (r) return r.start + node.data.slice(0, o).replace(GUARDS, "").length;
        }
        return measure(this.el, node, o).text.length;
    }

    /** The DOM point for a model offset; at a chip's edge the guard beside it wins over the text. */
    offsetToDom(off) {
        let pick = null;
        for (const r of this.runs) {
            if (r.kind === "chip" || off < r.start || off > r.end) continue;
            if (r.kind === "guard") { pick = r; break; }
            if (!pick) pick = r;
        }
        if (!pick) {
            // an offset inside a chip (never one render leaves): the chip's nearer edge, not the field's start
            const chip = this.runs.find((r) => r.kind === "chip" && r.start < off && off < r.end);
            return chip ? this.offsetToDom(off - chip.start <= chip.end - off ? chip.start : chip.end) : [this.el, 0];
        }
        if (pick.kind === "guard") return [pick.node, Math.min(1, pick.node.data.length)];
        return [pick.node, domIndex(pick.node.data, off - pick.start)];
    }

    /** chips inside the selection get an outline: ::selection does not paint them */
    markSel() {
        const s = Math.min(this.anchor, this.focusOff), e = Math.max(this.anchor, this.focusOff);
        for (const r of this.runs) if (r.kind === "chip") r.node.classList.toggle("ipc-in-sel", s < e && r.start >= s && r.end <= e);
    }

    /** the state for the undo: the text and the selection */
    state() {
        const [s, e] = this.readSel();
        return { text: this.text, start: s, end: e };
    }

    // ---- drawing -----------------------------------------------------------------------------------------------------

    /** the context for the chips; asked only when the text has a token (the editor may not be built yet) */
    context() {
        if (!hasTokens(this.text)) return EMPTY_CONTEXT;
        try { return this.refs() || EMPTY_CONTEXT; } catch (_) { return EMPTY_CONTEXT; }
    }

    /**
     * The DOM from the text. When the field already holds exactly what the text draws as (a native edit that typed
     * into a run), only the runs are read again; otherwise the children are built anew and the selection put back.
     * A selection end that a chip formed around goes to the chip's edge (`typed`: to its end, after what was typed).
     */
    render({ typed = false } = {}) {
        if (this.destroyed) return;
        if (this.composing) { this.needRender = true; return; }
        this.needRender = false;
        const plan = renderPlan(this.text, this.context(), this.open);
        const items = layoutOf(plan);
        this.plan = plan;
        this.anchor = this.snap(this.anchor, typed);
        this.focusOff = this.snap(this.focusOff, typed);
        const el = this.el;
        const kids = el.childNodes;
        const same = !this.dirty && kids.length === items.length && items.every((it, i) => itemSig(it) === nodeSig(kids[i]));
        this.runs = [];
        if (same) {
            items.forEach((it, i) => { if (it.kind !== "br") this.runs.push(this.run(it, kids[i])); });
        } else {
            const frag = document.createDocumentFragment();
            for (const it of items) {
                let node;
                if (it.kind === "text") node = document.createTextNode(it.text);
                else if (it.kind === "guard") node = document.createTextNode(GUARD);
                else if (it.kind === "chip") node = this.chipNode(it.seg, it.sig);
                else { node = document.createElement("br"); node.setAttribute("data-trail", ""); }
                frag.appendChild(node);
                if (it.kind !== "br") this.runs.push(this.run(it, node));
            }
            el.replaceChildren(frag);
            this.dirty = false;
            if (this.hasFocus()) this.applySel();
        }
        el.classList.toggle("ipc-pf-empty", !this.text);
        this.markSel();
        this.afterRender();
    }

    /** A swap menu follows its chip into the new DOM (or closes when the chip is gone); a card of a gone chip goes. */
    afterRender() {
        const s = this.session;
        if (s && s.mode === "swap") {
            const r = this.runs.find((x) => x.kind === "chip" && x.start === s.start && x.node.dataset.token === s.token);
            if (!r) this.endSession();
            else if (r.node !== s.chip) { s.chip.classList.remove("ipc-open"); s.chip = r.node; r.node.classList.add("ipc-open"); }
        }
        if (this.cardFor && !this.cardFor.isConnected) this.hideCard(true);
    }

    run(it, node) {
        if (it.kind === "guard") return { kind: "guard", node, start: it.at, end: it.at };
        return { kind: it.kind, node, start: it.start, end: it.end };
    }

    chipNode(seg, sig) {
        const c = document.createElement("span");
        c.className = "ipc-chip";
        c.contentEditable = "false";
        c.draggable = false;
        c.dataset.token = seg.token;
        c.dataset.state = seg.state;
        c.dataset.scTrigger = "@";
        c.dataset.scMentionType = "img";
        const key = seg.ref ? seg.ref.id : seg.id || "";
        if (key) c.dataset.scMentionKey = key;
        const name = seg.ref && seg.ref.name ? seg.ref.name : "";
        c.setAttribute("aria-label", `reference ${seg.label}${name && name !== seg.label ? ", " + name : ""}${seg.reason ? ": " + seg.reason : ""}`);
        // no title: the hover card is the tooltip (a title would show beside it); the reason stays readable here
        if (seg.reason) c.dataset.reason = seg.reason;
        c._sig = sig;
        const at = document.createElement("span");
        at.className = "ipc-chip-at";
        at.textContent = "@";
        const av = document.createElement("img");
        av.className = "ipc-chip-av";
        av.alt = "";
        av.draggable = false;
        const thumb = seg.ref && seg.ref.thumb;
        if (thumb) av.src = thumb; else av.hidden = true;
        const lab = document.createElement("span");
        lab.className = "ipc-chip-label";
        lab.textContent = seg.label;
        const chev = document.createElement("button");
        chev.type = "button";
        chev.className = "ipc-chip-chev";
        chev.tabIndex = -1;
        chev.setAttribute("aria-label", "Swap");
        chev.setAttribute("aria-haspopup", "listbox");
        // a press on the chevron keeps the caret where it is; a click opens the chip's swap menu, or closes it again
        chev.addEventListener("mousedown", (e) => e.preventDefault());
        chev.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.el.getAttribute("aria-disabled") === "true") return;
            if (this.session && this.session.mode === "swap" && this.session.chip === c) this.endSession();
            else this.openSwap(c);
        });
        c.append(at, av, lab, chev);
        return c;
    }

    /** The chips drawn again when a reference changed (a state, a label, a name); a thumbnail alone is swapped in place. */
    refresh() {
        if (this.destroyed) return;
        if (this.bar) this.bar.refresh();
        if (this.composing) { this.needRender = true; return; }
        this.render();
        this.updateThumbs();
        // the picker's rows follow the references (a name, a label, the layout's "sent as")
        if (this.session && this.session.mode === "insert" && this.picker) this.followSession();
    }

    /** The thumbnails of the chips of these layers (all when no ids are given) from the context, without a render. */
    updateThumbs(ids = null) {
        if (this.destroyed) return;
        if (this.bar) this.bar.refresh();
        if (!this.runs.some((r) => r.kind === "chip")) return;
        const ctx = this.context();
        const want = ids ? new Set(ids) : null;
        for (const r of this.runs) {
            if (r.kind !== "chip") continue;
            const key = r.node.dataset.scMentionKey;
            if (!key || (want && !want.has(key))) continue;
            const d = ctx.refs.find((x) => x.id === key);
            const img = r.node.querySelector("img.ipc-chip-av");
            if (!img) continue;
            const thumb = d && d.thumb;
            if (thumb) { if (img.getAttribute("src") !== thumb) img.src = thumb; img.hidden = false; }
            else img.hidden = true;
        }
    }

    // ---- writing -----------------------------------------------------------------------------------------------------

    /**
     * The text set from code (C4): no input or change event, as a textarea's value. `keepCaret`: the selection is
     * carried through the change (`mapOffset`); else it goes to the end, as a textarea's does. `history`: "push" makes
     * the write a step of the field's undo (Upsample, Revert, an agent's set_prompt), "reset" empties the undo (a
     * document opened, a snapshot restored), a text-to-text function is applied to the undo's states without a step (a
     * remap). "reset" and a remap reach the undo even when the text stays the same (a remap may change only what an
     * older state names). Writes during a composition wait for its end and are replayed in order there: an explicit
     * write replaces the composed text, a remap is applied to whatever stands then.
     */
    setText(text, { keepCaret = false, history = "push" } = {}) {
        if (this.destroyed) return;
        const next = sanitize(text);
        if (this.composing) {
            this.queued.push({ text: next, keepCaret, history });
            return;
        }
        const remap = typeof history === "function";
        if (history === "reset") this.history.reset();
        else if (remap) this.history.map(history);
        if (next === this.text) return;
        const [ps, pe] = this.readSel();
        const s = keepCaret ? mapOffset(ps, this.text, next) : next.length;
        const e = keepCaret ? mapOffset(pe, this.text, next) : next.length;
        if (history !== "reset" && !remap) this.history.record({ text: this.text, start: ps, end: pe }, { text: next, start: s, end: e }, "set");
        const backward = this.focusOff < this.anchor;
        // a remap keeps a session on its @ (or its chip); any other write ends it
        const sess = this.session;
        if (sess && remap) {
            sess.start = mapOffset(sess.start, this.text, next);
            if (sess.end != null) sess.end = mapOffset(sess.end, this.text, next);
            if (sess.mode === "swap") sess.token = null;
        } else if (sess) this.endSession();
        this.text = next;
        this.open = null;
        this.autoSpace = null;
        this.anchor = backward ? e : s;
        this.focusOff = backward ? s : e;
        if (sess && remap && sess.mode === "swap") {
            // the chip's token may have a new number now: the menu follows the chip that starts where it started
            const seg = renderPlan(next, this.context(), null).find((g) => g.type === "chip" && g.start === sess.start);
            if (seg) { sess.token = seg.token; sess.end = seg.end; } else this.endSession();
        }
        this.render();
        if (this.hasFocus()) this.applySel();
        if (this.session && this.session.mode === "insert") this.followSession();
    }

    /** While composing: the text the queued writes will leave, on what the DOM holds now (the editor reads this). */
    pendingValue() {
        let t = sanitize(measure(this.el).text);
        for (const q of this.queued) t = typeof q.history === "function" ? sanitize(q.history(t)) : q.text;
        return t;
    }

    /** an input event for an edit made here (the browser's own is cancelled with the beforeinput) */
    fire(inputType, data = null) {
        this.firing = true;
        try { this.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data })); } finally { this.firing = false; }
    }

    /**
     * The token being typed after an edit that left the caret at `caret`: the one that ends at the caret when the edit
     * started inside it, or when it was the one being typed before (a Backspace in @img12 keeps @img1 open).
     */
    openAfter(prevText, next, caret) {
        const { start } = diffRange(prevText, next);
        let at = 0;
        for (const seg of parse(next)) {
            const s = at, e = at + seg.text.length;
            at = e;
            if (seg.type !== "token" || e !== caret) continue;
            if ((s <= start && start < e) || (this.open && this.open[0] === s)) return [s, e];
        }
        return null;
    }

    /**
     * One edit made here: [s, t) of the text becomes `ins`, the caret after it, one undo step (merged by `kind`), the
     * DOM drawn again and an input event of `inputType`.
     */
    edit(s, t, ins, kind, inputType, data = null) {
        // an edit in the text closes a chip's swap menu (its chip may move or go)
        if (this.session && this.session.mode === "swap") this.endSession();
        const prev = this.pre || this.state();
        this.pre = null;
        const clean = String(ins == null ? "" : ins).replace(/\r\n?/g, "\n").replace(GUARDS, "");
        const { pre, post } = this.spaced(s, t, clean);
        const next = normalize(this.text.slice(0, s) + pre + clean + post + this.text.slice(t));
        const caret = s + pre.length + clean.length;
        this.autoSpace = post && kind === "type" ? caret : null;
        if (next === this.text) { this.setSel(caret, caret); return false; }
        this.history.record(prev, { text: next, start: caret, end: caret }, kind);
        this.open = kind === "type" || kind === "delete" ? this.openAfter(this.text, next, caret) : null;
        this.text = next;
        this.anchor = this.focusOff = caret;
        this.render({ typed: !!clean });
        if (this.hasFocus()) this.applySel();
        this.fire(inputType, data);
        if (!this.hasFocus()) this.el.dispatchEvent(new Event("change", { bubbles: true }));
        if (kind === "type" || kind === "delete") this.afterEdit(inputType, data);
        return true;
    }

    /**
     * The spaces text inserted at [s, t) needs against a chip: a word character right before a chip's @ or right after
     * its end would make the token plain text (C1: `x@img1` is none), so a space goes between. Typing against a chip
     * then keeps the chip instead of turning it into text and back at every letter.
     */
    spaced(s, t, ins) {
        const W = /[\w-]/;
        const chipAt = (key, at) => this.plan.some((g) => g.type === "chip" && g[key] === at);
        return {
            pre: ins && W.test(ins[0]) && chipAt("end", s) ? " " : "",
            post: ins && W.test(ins[ins.length - 1]) && chipAt("start", t) ? " " : "",
        };
    }

    /**
     * Would deleting [a, b) glue a word character to a chip? `@img1jacket` and `cat@img1` are no tokens (C1), and
     * `@img1 2` would become `@img12`: the chip would turn into text or into another number.
     */
    glues(a, b) {
        const W = /[\w-]/;
        const left = this.text[a - 1], right = this.text[b];
        return this.plan.some((g) => g.type === "chip" && ((g.end === a && right !== undefined && W.test(right)) || (g.start === b && left !== undefined && W.test(left))));
    }

    /** a range widened to whole chips */
    widen(a, b) {
        for (const g of this.plan) {
            if (g.type !== "chip") continue;
            if (a > g.start && a < g.end) a = g.start;
            if (b > g.start && b < g.end) b = g.end;
        }
        return [a, b];
    }

    undo() {
        const e = this.history.undo(this.state());
        if (!e) return false;
        this.restore(e, "historyUndo");
        return true;
    }

    redo() {
        const e = this.history.redo(this.state());
        if (!e) return false;
        this.restore(e, "historyRedo");
        return true;
    }

    restore(e, inputType) {
        this.endSession();
        this.text = e.text;
        this.open = null;
        this.autoSpace = null;
        this.anchor = e.start;
        this.focusOff = e.end;
        this.render();
        if (this.hasFocus()) this.applySel();
        this.markSel();
        this.fire(inputType);
    }

    // ---- events ------------------------------------------------------------------------------------------------------

    bindEvents() {
        const el = this.el;
        el.addEventListener("beforeinput", (e) => this.onBeforeInput(e));
        el.addEventListener("input", (e) => this.onInput(e));
        el.addEventListener("keydown", (e) => this.onKeyDown(e));
        el.addEventListener("paste", (e) => this.onPaste(e));
        el.addEventListener("copy", (e) => this.onCopy(e, false));
        el.addEventListener("cut", (e) => this.onCopy(e, true));
        el.addEventListener("compositionstart", () => this.onCompositionStart());
        el.addEventListener("compositionend", () => this.onCompositionEnd());
        el.addEventListener("focus", () => this.onFocus());
        el.addEventListener("blur", () => this.onBlur());
        el.addEventListener("mousedown", (e) => {
            const chip = e.button === 0 && e.target && e.target.closest ? e.target.closest(".ipc-chip") : null;
            if (chip && el.contains(chip)) {
                // a chip holds no caret (the browser would leave it in the chip's label, where no key reaches the
                // field): a press puts it beside the chip, on the side that was pressed; the chevron keeps it where it is
                e.preventDefault();
                this.hideCard(true);
                if (e.target.closest(".ipc-chip-chev")) return;
                const r = this.runs.find((x) => x.node === chip);
                if (!r) return;
                const box = chip.getBoundingClientRect();
                const off = e.clientX < box.left + box.width / 2 ? r.start : r.end;
                if (!this.hasFocus()) el.focus({ preventScroll: true });
                this.setSel(e.shiftKey ? this.anchor : off, off);
                this.hideCard(true);
                // a press that moves on drags the chip to another place in the text (the pointer's own drag: the
                // browser's would need the press it was just denied)
                if (!e.shiftKey && el.getAttribute("aria-disabled") !== "true") {
                    this.chipDrag = { start: r.start, end: r.end, x: e.clientX, y: e.clientY, moved: false };
                    window.addEventListener("mousemove", this.onChipMove, true);
                    window.addEventListener("mouseup", this.onChipUp, true);
                }
                return;
            }
            // the browser puts the caret where the press was: a focus that comes with it keeps that caret
            this.fromPointer = true;
            this.pointerHeld = true;
            setTimeout(() => { this.fromPointer = false; }, 0);
            window.addEventListener("mouseup", this.onPointerUp, true);
        });
        // the hover card of a chip (the bar's chips have their own listeners)
        el.addEventListener("pointerover", (e) => {
            const chip = e.target && e.target.closest ? e.target.closest(".ipc-chip") : null;
            if (chip && el.contains(chip) && !this.chipDrag) this.hoverStart(chip, e);
        });
        el.addEventListener("pointerout", (e) => {
            const chip = e.target && e.target.closest ? e.target.closest(".ipc-chip") : null;
            if (chip && el.contains(chip)) this.hoverEnd(chip, e.relatedTarget);
        });
        // a selection dragged in the field moves (Ctrl: copies), dragged out copies its text; pictures dropped here
        // become reference layers named where they fell; a chip is dragged by the pointer (above), not by the browser
        el.addEventListener("dragstart", (e) => this.onDragStart(e));
        el.addEventListener("dragover", (e) => this.onDragOver(e));
        el.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) this.hideDropCaret(); });
        el.addEventListener("drop", (e) => this.onDrop(e));
        el.addEventListener("dragend", () => { this.drag = null; this.hideDropCaret(); });
        this.onChipMove = (e) => {
            const d = this.chipDrag;
            if (!d) return;
            if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
            d.moved = true;
            el.classList.add("ipc-pf-dragging");
            const off = this.pointOffset(e.clientX, e.clientY);
            if (off == null) this.hideDropCaret(); else this.showDropCaret(off);
        };
        this.onChipUp = (e) => {
            const d = this.chipDrag;
            this.endChipDrag();
            if (!d || !d.moved) return;
            const off = this.pointOffset(e.clientX, e.clientY);
            if (off != null) this.moveRange(d.start, d.end, off, false);
        };
        this.onSelChange = () => this.selectionChanged();
        this.onPointerUp = () => {
            window.removeEventListener("mouseup", this.onPointerUp, true);
            this.pointerHeld = false;
            if (this.renderAfterPointer) { this.renderAfterPointer = false; this.render(); }
            // what the drag left: a caret on a chip goes beside it (no selectionchange follows the release)
            if (this.hasFocus()) this.selectionChanged();
        };
    }

    /** Can the browser type this itself? A collapsed caret in a text run of the field, and a text without markup. */
    nativeTypingOK(e) {
        if (this.dirty) return false;
        const data = e.data;
        if (typeof data !== "string" || !data || /[\r\n]/.test(data) || data.includes(GUARD)) return false;
        const s = document.getSelection();
        return !!(s && s.isCollapsed && s.anchorNode && s.anchorNode.nodeType === 3 && s.anchorNode.parentNode === this.el);
    }

    /**
     * What a delete of `type` takes from a collapsed caret at `s`, widened to whole chips. Every delete is made here:
     * Chromium gives a plaintext-only field no target ranges for them (measured 2026-09-29), and a native one next to a
     * chip or a guard would take the guard or leave its own <br>. Words and lines as Windows takes them: Ctrl+Backspace
     * the word before and the space after it, Ctrl+Delete the word after and its space.
     */
    deleteRange(type, s, t) {
        const text = this.text;
        if (s !== t) return this.widen(s, t);
        if (type === "deleteContentBackward") return unitBefore(text, s, this.plan);
        if (type === "deleteContentForward") return unitAfter(text, s, this.plan);
        const lineStart = text.lastIndexOf("\n", s - 1) + 1;
        let lineEnd = text.indexOf("\n", s);
        if (lineEnd < 0) lineEnd = text.length;
        let r;
        if (type === "deleteWordBackward") r = [s - (/(\S+\s*|\s+)$/.exec(text.slice(0, s)) || [""])[0].length, s];
        else if (type === "deleteWordForward") r = [s, s + (/^(\S+\s*|\s+)/.exec(text.slice(s)) || [""])[0].length];
        else if (/Backward$/.test(type)) r = [s === lineStart ? Math.max(0, s - 1) : lineStart, s];   // a line's start: its break
        else if (/Forward$/.test(type)) r = [s, s === lineEnd ? Math.min(text.length, s + 1) : lineEnd];
        else r = [lineStart, lineEnd];   // deleteEntireSoftLine and the rest
        return this.widen(r[0], r[1]);
    }

    /** a target range of the event in model offsets, or null */
    targetRange(e) {
        const r = typeof e.getTargetRanges === "function" ? e.getTargetRanges()[0] : null;
        if (!r || !this.el.contains(r.startContainer) || !this.el.contains(r.endContainer)) return null;
        const a = this.domToOffset(r.startContainer, r.startOffset), b = this.domToOffset(r.endContainer, r.endOffset);
        return [Math.min(a, b), Math.max(a, b)];
    }

    onBeforeInput(e) {
        const type = e.inputType || "";
        if (type === "insertCompositionText" || this.composing) return;   // not cancelable; the composition path
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        // a space typed where the field put one before a chip steps over it (as an editor steps over a closing bracket)
        if (type === "insertText" && e.data === " " && s === t && this.autoSpace === s && this.text[s] === " ") {
            e.preventDefault();
            this.pre = null;
            this.autoSpace = null;
            this.setSel(s + 1, s + 1);
            return;
        }
        const sp = type === "insertText" ? this.spaced(s, t, e.data || "") : null;
        if (type === "insertText" && s === t && !sp.pre && !sp.post && this.nativeTypingOK(e)) { this.nativePending = true; return; }
        e.preventDefault();
        if (this.el.getAttribute("aria-disabled") === "true") { this.pre = null; return; }
        switch (type) {
            case "insertText":
            case "insertReplacementText": {
                const d = e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
                this.edit(s, t, d, "type", type, d);
                break;
            }
            case "insertParagraph":
            case "insertLineBreak":
                this.edit(s, t, "\n", "line", "insertLineBreak");
                break;
            case "insertFromPaste":
            case "insertFromPasteAsQuotation":
            case "insertFromYank":
            case "insertFromDrop": {
                const d = e.dataTransfer ? e.dataTransfer.getData("text/plain") : e.data || "";
                if (!d) { this.pre = null; break; }
                // a drop lands where it was dropped; 26c1 copies a dragged selection (26c2 moves it)
                const at = type === "insertFromDrop" ? this.targetRange(e) : null;
                const [a, b] = at ? this.widen(at[0], at[0]) : [s, t];
                this.edit(a, b, d, "paste", type, null);
                break;
            }
            case "deleteByCut":
                if (s !== t) this.edit(s, t, "", "cut", type); else this.pre = null;
                break;
            case "deleteByDrag":
                this.pre = null;   // the source stays; a drop copies (26c2 moves)
                break;
            case "historyUndo": this.pre = null; this.undo(); break;
            case "historyRedo": this.pre = null; this.redo(); break;
            default: {
                if (!type.startsWith("delete")) { this.pre = null; break; }   // format* and the rest: nothing
                const [a, b] = this.deleteRange(type, s, t);
                if (a === b) { this.pre = null; break; }
                if (this.glues(a, b)) {
                    // the space that keeps a chip apart from a word is stepped over, as the one typing puts there;
                    // a longer range goes and leaves one space
                    if (s === t && !/\S/.test(this.text.slice(a, b))) { this.pre = null; const c = /Backward/.test(type) ? a : b; this.setSel(c, c); break; }
                    this.edit(a, b, " ", "delete", type);
                    break;
                }
                this.edit(a, b, "", "delete", type);
            }
        }
    }

    onInput(e) {
        if (this.firing) return;   // our own event
        if (e.isComposing || this.composing) return;
        this.nativePending = false;
        const m = measure(this.el);
        const next = normalize(m.text);
        if (m.dirty) this.dirty = true;
        const d = this.domSel();
        const caret = d ? d[1] : next.length;
        const prev = this.pre || { text: this.text, start: this.anchor, end: this.focusOff };
        this.pre = null;
        if (next === this.text && !this.dirty) { this.render(); return; }
        const kind = /^delete/.test(e.inputType || "") ? "delete" : "type";
        this.history.record(prev, { text: next, start: caret, end: caret }, kind);
        // the space the field put before a chip moves with a word typed in front of it
        if (this.autoSpace != null) {
            const at = prev.start <= this.autoSpace ? this.autoSpace + next.length - this.text.length : this.autoSpace;
            this.autoSpace = next[at] === " " && at === caret ? at : null;
        }
        if (this.session && this.session.mode === "swap") this.endSession();
        this.open = this.openAfter(this.text, next, caret);
        this.text = next;
        if (d) { this.anchor = d[0]; this.focusOff = d[1]; } else this.anchor = this.focusOff = caret;
        // an @ typed in front of "img1" makes a chip around the caret: the caret goes after it
        this.render({ typed: kind === "type" });
        this.afterEdit(e.inputType || "", e.data);
    }

    onKeyDown(e) {
        if (e.isComposing || e.keyCode === 229 || this.composing) return;
        const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
        const k = e.key;
        this.hideCard(true);
        if (this.popupOpen()) {
            // the picker's keys come first: ↑ ↓ move (with wrap), Enter and Tab insert, Esc closes it (and only it)
            const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
            if (plain && (k === "ArrowDown" || k === "ArrowUp")) { e.preventDefault(); this.picker.move(k === "ArrowDown" ? 1 : -1); return; }
            if (plain && !e.shiftKey && (k === "Enter" || k === "Tab")) {
                const it = this.picker.current();
                if (it) { e.preventDefault(); this.pickItem(it); return; }
                this.endSession();   // nothing to pick: the key does what it does without the picker
            }
            if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.endSession(); return; }
        }
        if (ctrl && !e.shiftKey && (k === "z" || k === "Z")) { e.preventDefault(); this.undo(); return; }
        if (ctrl && (k === "y" || k === "Y" || (e.shiftKey && (k === "z" || k === "Z")))) { e.preventDefault(); this.redo(); return; }
        if (k === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (this.el.getAttribute("aria-disabled") === "true") return;
            const [s, t] = this.readSel();
            this.pre = { text: this.text, start: s, end: t };
            this.edit(s, t, "\n", "line", "insertLineBreak");
            return;
        }
        if ((k === "ArrowLeft" || k === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            this.arrow(k === "ArrowLeft" ? -1 : 1, e.shiftKey);
        }
    }

    /** ArrowLeft / ArrowRight: a grapheme or a whole chip; without Shift a selection collapses to its side */
    arrow(dir, shift) {
        const [s, t] = this.readSel();
        // a selection ends a picker session (it would end at the selectionchange anyway, after the step)
        if (shift && this.session && this.session.mode === "insert") this.endSession();
        // the token being typed is left: it becomes a chip first, and the step goes over the whole of it (the @word of
        // a picker session stays text: the session follows the caret)
        if (this.open && !(this.session && this.session.mode === "insert")) { this.open = null; this.render(); }
        if (!shift && s !== t) { const c = dir < 0 ? s : t; this.setSel(c, c); return; }
        const f = this.focusOff;
        const u = dir < 0 ? unitBefore(this.text, f, this.plan) : unitAfter(this.text, f, this.plan);
        const nf = dir < 0 ? u[0] : u[1];
        if (shift) this.setSel(this.anchor, nf); else this.setSel(nf, nf);
        this.leaveOpen();
    }

    onPaste(e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.el.getAttribute("aria-disabled") === "true") return;
        // text wins (a copy from a word processor brings a picture of the text too); pictures alone become reference
        // layers, named at the caret
        const d = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        if (!d) {
            const files = imageFiles(e.clipboardData);
            if (files.length) this.addReferences(files);
            return;
        }
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        this.edit(s, t, d, "paste", "insertFromPaste");
    }

    /** a chip copies as its token, whatever the hidden "@" and the label say */
    onCopy(e, cut) {
        const [s, t] = this.readSel();
        e.stopPropagation();
        if (s === t) return;
        e.preventDefault();
        if (e.clipboardData) e.clipboardData.setData("text/plain", this.text.slice(s, t));
        if (cut && this.el.getAttribute("aria-disabled") !== "true") {
            this.pre = { text: this.text, start: s, end: t };
            this.edit(s, t, "", "cut", "deleteByCut");
        }
    }

    onCompositionStart() {
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        this.composing = true;
    }

    onCompositionEnd() {
        this.composing = false;
        const m = measure(this.el);
        const next = normalize(m.text);
        if (m.dirty) this.dirty = true;
        const d = this.domSel();
        const caret = d ? d[1] : next.length;
        const prev = this.pre || { text: this.text, start: this.anchor, end: this.focusOff };
        this.pre = null;
        const changed = next !== this.text;
        if (changed) {
            this.history.record(prev, { text: next, start: caret, end: caret }, "type");
            this.open = this.openAfter(this.text, next, caret);
            this.text = next;
        }
        if (d) { this.anchor = d[0]; this.focusOff = d[1]; } else this.anchor = this.focusOff = caret;
        if (this.session && this.session.mode === "swap" && changed) this.endSession();
        this.render({ typed: true });
        if (this.session && this.session.mode === "insert") this.followSession();
        // the writes that came while composing, in order: an explicit one replaces the composed text, a remap applies
        // to what stands then
        const q = this.queued;
        this.queued = [];
        for (const op of q) {
            if (typeof op.history === "function") this.setText(op.history(this.text), { keepCaret: true, history: op.history });
            else this.setText(op.text, { keepCaret: op.keepCaret, history: op.history });
        }
        // the editor reads the text from the input event; the last one came while composing
        if (changed || q.length) this.fire("insertFromComposition", null);
    }

    onFocus() {
        this.focusText = this.text;
        document.addEventListener("selectionchange", this.onSelChange);
        // a focus from code puts back the selection the field kept, as a textarea's does; a click keeps its own caret
        if (!this.fromPointer) this.applySel();
    }

    onBlur() {
        document.removeEventListener("selectionchange", this.onSelChange);
        this.hideCard(true);
        // the file dialog of "+ Add reference" takes the focus: its session stays open through it
        if (!this.choosing && !this.adding) {
            this.closePopups();
            if (this.open) { this.open = null; this.render(); }
        }
        const was = this.focusText;
        this.focusText = null;
        if (was != null && was !== this.text) this.el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /** The caret left the token being typed: it becomes a chip. */
    leaveOpen() {
        // a picker session keeps its @word as text and follows the caret itself
        if (this.session && this.session.mode === "insert") {
            if (this.pointerHeld) this.renderAfterPointer = true; else this.followSession();
            return;
        }
        if (!this.open) return;
        const c = this.anchor === this.focusOff ? this.focusOff : -1;
        if (c === this.open[1]) return;
        this.open = null;
        if (this.pointerHeld) this.renderAfterPointer = true; else this.render();
    }

    selectionChanged() {
        if (!this.hasFocus() || this.composing || this.nativePending) return;
        const s = document.getSelection();
        const d = this.domSel();
        if (!s || !d) return;
        this.anchor = d[0];
        this.focusOff = d[1];
        // a caret the browser put between two elements or into a chip (its label is a text node too) goes to its
        // place, a guard or a text run of the field; a selection being dragged is left alone
        const loose = s.anchorNode && (s.anchorNode.nodeType !== 3 || s.anchorNode.parentNode !== this.el);
        if (s.isCollapsed && loose && !this.pointerHeld) {
            this.anchor = this.focusOff = this.snap(d[1]);
            this.applySel();
        }
        this.markSel();
        if (this.autoSpace != null && !(this.anchor === this.autoSpace && this.focusOff === this.autoSpace)) this.autoSpace = null;
        this.leaveOpen();
    }

    // ---- 26c2: the @ picker, the swap menu, adding references, the hover card ------------------------------------

    /** Is a popup of the field open (the picker, the swap menu)? The editor's Escape closes it before anything else. */
    popupOpen() { return !!(this.picker && this.picker.isOpen); }

    /** Close the field's popups: the picker or the swap menu, and the hover card. */
    closePopups() {
        this.endSession();
        this.hideCard(true);
    }

    /** the context for the picker, the bar and the card, asked whatever the text holds */
    fullContext() {
        try { return this.refs() || EMPTY_CONTEXT; } catch (_) { return EMPTY_CONTEXT; }
    }

    /** the @word a picker session types in: from its @ to the first white space after it */
    sessionWord(start) {
        const m = /^[^\s]*/.exec(this.text.slice(start + 1));
        return [start, start + 1 + (m ? m[0].length : 0)];
    }

    /**
     * After an edit the user made (typed here or by the browser): an @ typed at a word start opens the picker (from the
     * input event and never from a key: @ is AltGr+Q on a German keyboard); a running session follows the caret.
     */
    afterEdit(inputType, data) {
        if (this.composing || this.destroyed) return;
        if (this.session && this.session.mode === "insert") { this.followSession(); return; }
        if (inputType !== "insertText" || data !== "@") return;
        const [s, t] = this.readSel();
        if (s !== t || this.text[s - 1] !== "@" || !atWordStart(this.text, s - 1)) return;
        this.openPicker(s - 1);
    }

    /** The @ picker at `start` (the @), filtered by what is typed after it. */
    openPicker(start) {
        this.endSession();
        // `tail`: what already stood after the @ when it was typed (an @ typed in front of a word or a chip): a pick
        // replaces only what the session typed, never that
        this.session = { mode: "insert", start, tail: this.sessionWord(start)[1] - (start + 1) };
        this.picker = new RefPicker(this, "insert");
        this.followSession();
    }

    /**
     * The session after a caret move or an edit: it ends when the @ is gone, the caret leaves the @word or white space
     * is typed; else the rows follow the query (the text between the @ and the caret). The @word is drawn as text while
     * the session runs (`open`), so a typed "@img1" is no chip before it is picked.
     */
    followSession() {
        const s = this.session;
        if (!s || s.mode !== "insert") return;
        const lost = () => this.text[s.start] !== "@" || !atWordStart(this.text, s.start);
        // while pictures load for it, the session keeps its @ whatever the caret does
        if (this.adding) { if (lost()) this.endSession(); return; }
        const [a, b] = this.readSel();
        const we = this.sessionWord(s.start)[1];
        if (lost() || a !== b || b <= s.start || b > we) { this.endSession(); return; }
        // what a pick replaces: the @ and what the session typed after it (not the word or chip that stood there)
        s.end = Math.max(b, we - (s.tail || 0));
        s.query = this.text.slice(s.start + 1, b);
        const want = [s.start, s.end];
        if (!this.open || this.open[0] !== want[0] || this.open[1] !== want[1]) { this.open = want; this.render(); }
        this.picker.show(this.pickerItems(), this.anchorRect(s.start), s.query);
    }

    /** The rows of the @ picker: the references the query matches, then "+ Add reference". */
    pickerItems() {
        const ctx = this.fullContext();
        const q = this.session ? this.session.query || "" : "";
        const items = pickerRows(ctx, q).map((d) => ({ kind: "ref", ref: d, n: d.label }));
        items.push({ kind: "add", disabled: !ctx.canAdd, title: ctx.canAdd ? "Add an image as a reference layer and name it here" : "Load an image first" });
        const hidden = (ctx.refs || []).filter((d) => d.label == null).length;
        this.picker.note = hidden ? `${plural(hidden, "hidden reference is", "hidden references are")} not listed` : "";
        return items;
    }

    /** The swap menu of a chip: the other shown references, "Show <name>" for a hidden one, "Remove from prompt". */
    openSwap(chip) {
        const r = this.runs.find((x) => x.node === chip);
        if (!r) return;
        const seg = this.plan.find((g) => g.type === "chip" && g.start === r.start);
        if (!seg) return;
        this.endSession();
        this.hideCard(true);
        this.session = { mode: "swap", start: seg.start, end: seg.end, token: seg.token, chip };
        this.picker = new RefPicker(this, "swap");
        const ctx = this.fullContext();
        const items = (ctx.refs || []).filter((d) => d.label != null && !(seg.n != null && d.label === seg.n)).map((d) => ({ kind: "ref", ref: d, n: d.label }));
        const own = seg.ref || (seg.id ? (ctx.refs || []).find((d) => d.id === seg.id) : null);
        if (own && own.label == null && !own.visible && typeof ctx.show === "function") items.push({ kind: "show", ref: own });
        items.push({ kind: "remove" });
        chip.classList.add("ipc-open");
        this.picker.show(items, chip.getBoundingClientRect(), null);
    }

    /** Where the picker hangs: a collapsed range at the offset (the @), else the field. */
    anchorRect(off) {
        try {
            const [n, o] = this.offsetToDom(off);
            const rg = document.createRange();
            rg.setStart(n, o);
            rg.collapse(true);
            const rect = rg.getClientRects()[0];
            if (rect && (rect.height || rect.width)) return rect;
        } catch (_) { /* the field's box */ }
        return this.el.getBoundingClientRect();
    }

    /** The session ended: the picker closed, the @word drawn as the text it is. */
    endSession() {
        const s = this.session;
        this.session = null;
        if (this.picker) { const p = this.picker; this.picker = null; p.close(); }
        if (s && s.chip) s.chip.classList.remove("ipc-open");
        if (s && s.mode === "insert" && this.open) {
            // what was typed after the @ stays text only while the caret stands at its end, as any token being typed
            const c = this.anchor === this.focusOff ? this.focusOff : -1;
            this.open = c === this.open[1] && hasTokens(this.text.slice(this.open[0], this.open[1])) ? this.open : null;
            if (!this.destroyed) this.render();
        }
    }

    /** A row of the picker or the swap menu was chosen. */
    pickItem(item) {
        const s = this.session;
        if (!s || !item || item.disabled) return;
        if (item.kind === "add") { this.chooseFiles(); return; }
        if (item.kind === "show") {
            this.endSession();
            const ctx = this.fullContext();
            // the eye's path: the layer is shown and its parked token comes back as @img<n> (the editor's remap)
            try { ctx.show(item.ref.id); } catch (_) { /* the layer went meanwhile */ }
            return;
        }
        if (s.mode === "swap") {
            this.endSession();
            if (item.kind === "remove") this.removeToken(s.start, s.end);
            else this.replaceWith(s.start, s.end, "@img" + item.n, { spaces: false });
            return;
        }
        const end = s.end != null ? s.end : s.start + 1;
        this.endSession();
        this.replaceWith(s.start, end, "@img" + item.n);
    }

    /**
     * [a, b) of the text becomes `token`, one undo step. `spaces`: a space before it when it does not start a word and
     * one after it unless white space follows, so the token stays a token (C1); the caret goes after the space.
     */
    replaceWith(a, b, token, { spaces = true } = {}) {
        [a, b] = this.widen(a, b);
        const pre = spaces && !atWordStart(this.text, a) ? " " : "";
        const after = this.text[b];
        const post = spaces && (after === undefined || !/\s/.test(after)) ? " " : "";
        this.pre = { text: this.text, start: a, end: b };
        this.edit(a, b, pre + token + post, "pick", "insertReplacementText");
    }

    /** A token taken out of the text with one of the spaces around it, one undo step. */
    removeToken(a, b) {
        const t = this.text;
        let s = a, e = b;
        if (t[e] === " ") e++;
        else if (t[s - 1] === " ") s--;
        this.pre = { text: t, start: a, end: b };
        if (this.glues(s, e)) this.edit(s, e, " ", "pick", "deleteContent");
        else this.edit(s, e, "", "pick", "deleteContent");
    }

    /**
     * `@img<n>` at the kept selection (the reference bar), one undo step, the field focused with the caret after it. At
     * the end of the text when the field never had a caret.
     */
    insertToken(n, { replace = null } = {}) {
        const [s, t] = replace || this.readSel();
        this.endSession();
        this.replaceWith(s, t, "@img" + n);
        this.focus();
    }

    /** The field focused with its kept selection, without scrolling the panel. */
    focus() {
        if (this.hasFocus() || this.destroyed) return;
        try { this.el.focus({ preventScroll: true }); } catch (_) { /* detached */ }
        this.applySel();
    }

    /** The file dialog of "+ Add reference" (the picker's row, the bar's "+"); the session stays open through it. */
    chooseFiles() {
        if (!this.fullContext().canAdd) return;
        if (!this.fileInput) {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*,.tif,.tiff";
            inp.multiple = true;
            inp.style.display = "none";
            inp.addEventListener("change", () => {
                const files = Array.from(inp.files || []);
                inp.value = "";
                this.choosing = false;
                if (files.length) this.addReferences(files);
                else this.endSession();
            });
            // the dialog closed without a file: the picker closes and the @ stays
            inp.addEventListener("cancel", () => { this.choosing = false; this.endSession(); this.focus(); });
            (this.popupRoot || this.el).appendChild(inp);
            this.fileInput = inp;
        }
        this.choosing = true;
        this.fileInput.click();
    }

    /**
     * Pictures as new reference layers (C4's `addReferences`), their tokens where the @ of the session was typed, else at
     * the kept selection (a paste, a drop, the bar's "+"). Answers the new layers' ids.
     * @param {File[]} files
     * @returns {Promise<string[]>}
     */
    async addReferences(files) {
        const fn = this.addReferencesFn;
        const list = Array.from(files || []);
        if (!fn || !list.length || !this.fullContext().canAdd) { this.endSession(); return []; }
        // the focus goes back to the field afterwards only when nobody took it meanwhile (a click on the canvas while a
        // large picture loads keeps the editor's keys working)
        const before = document.activeElement;
        this.adding = true;
        let ids = [];
        try { ids = (await fn(list)) || []; } catch (_) { ids = []; } finally { this.adding = false; }
        if (this.destroyed) return ids;
        const ctx = this.fullContext();
        const tokens = ids.map((id) => (ctx.refs || []).find((d) => d.id === id)).filter((d) => d && d.label != null).map((d) => "@img" + d.label);
        const s = this.session && this.session.mode === "insert" ? this.session : null;
        const range = s ? [s.start, s.end != null ? s.end : s.start + 1] : this.readSel();
        this.endSession();
        if (tokens.length) {
            this.replaceWith(range[0], range[1], tokens.join(" "));
            const now = document.activeElement;
            if (now === before || !now || now === document.body) this.focus();
        }
        return ids;
    }

    // ---- the hover card ------------------------------------------------------------------------------------------

    /**
     * A chip of the field or the bar under the pointer: after 400 ms its card (a larger picture, the layer's name, what
     * it is sent as or why not). Not while a button is held or a popup is open.
     */
    hoverStart(node, e) {
        if (this.cardFor === node) { clearTimeout(this.cardHide); return; }
        this.hideCard(true);
        if ((e && e.buttons) || this.popupOpen() || this.destroyed) return;
        this.cardFor = node;
        this.cardTimer = setTimeout(() => this.showCard(node), 400);
    }

    /** The pointer left for `to`: the card goes unless it went to the chip or the card itself. */
    hoverEnd(node, to) {
        if (to && ((this.card && this.card.contains(to)) || (node && node.contains(to)))) return;
        clearTimeout(this.cardTimer);
        clearTimeout(this.cardHide);
        // a short grace, so the pointer can cross to the card
        this.cardHide = setTimeout(() => this.hideCard(true), this.card ? 120 : 0);
    }

    /** what a chip node of the field or the bar stands for: the chip state and the layer's id */
    cardInfo(node) {
        const ctx = this.fullContext();
        if (node.classList.contains("ipc-refbar-chip")) {
            const d = (ctx.refs || []).find((x) => x.id === node.dataset.id);
            if (!d) return null;
            if (d.label == null) return { st: { state: "inactive", label: cut(d.name || "reference"), reason: d.visible ? "no pixels: this reference is not loaded" : "hidden: show it under References to send it", ref: d }, ctx };
            return { st: chipState({ n: d.label }, ctx), ctx };
        }
        const r = this.runs.find((x) => x.node === node);
        const seg = r && this.plan.find((g) => g.type === "chip" && g.start === r.start);
        return seg ? { st: chipState(seg.n != null ? { n: seg.n } : { id: seg.id }, ctx), ctx } : null;
    }

    showCard(node) {
        if (this.destroyed || !node.isConnected || this.popupOpen()) { this.cardFor = null; return; }
        const info = this.cardInfo(node);
        if (!info) { this.cardFor = null; return; }
        const { st, ctx } = info;
        const root = this.popupRoot || document.body;
        const card = mk("div", "ipc-refcard");
        card.setAttribute("role", "tooltip");
        card.dataset.state = st.state;
        if (st.ref && typeof this.preview === "function") {
            const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
            const cv = document.createElement("canvas");
            cv.width = cv.height = Math.round(160 * dpr);
            cv.className = "ipc-refcard-pic";
            try { this.preview(st.ref.id, cv); card.appendChild(cv); } catch (_) { /* no picture */ }
        }
        const name = st.ref && st.ref.name ? st.ref.name : st.label;
        card.appendChild(mk("div", "ipc-refcard-name", name));
        card.appendChild(mk("div", "ipc-refcard-line", cardLine(st, ctx)));
        for (const type of ["pointerdown", "click", "wheel", "contextmenu"]) card.addEventListener(type, (e) => e.stopPropagation());
        card.addEventListener("mousedown", (e) => e.preventDefault());
        card.addEventListener("pointerenter", () => clearTimeout(this.cardHide));
        card.addEventListener("pointerleave", (e) => this.hoverEnd(node, e.relatedTarget));
        root.appendChild(card);
        this.card = card;
        placeBox(card, root, node.getBoundingClientRect(), 4);
    }

    hideCard(now = false) {
        clearTimeout(this.cardTimer);
        clearTimeout(this.cardHide);
        if (!now) return;
        if (this.card) this.card.remove();
        this.card = null;
        this.cardFor = null;
    }

    // ---- moving text and chips, dropping pictures ------------------------------------------------------------------

    endChipDrag() {
        this.chipDrag = null;
        window.removeEventListener("mousemove", this.onChipMove, true);
        window.removeEventListener("mouseup", this.onChipUp, true);
        this.el.classList.remove("ipc-pf-dragging");
        this.hideDropCaret();
    }

    /**
     * The text offset at a point of the field, or null outside it: beside a chip on the side the point is on, else
     * where the browser would put the caret, never inside a chip.
     */
    pointOffset(x, y) {
        const b = this.el.getBoundingClientRect();
        if (x < b.left || x > b.right || y < b.top || y > b.bottom) return null;
        const hit = document.elementFromPoint(x, y);
        const chip = hit && hit.closest ? hit.closest(".ipc-chip") : null;
        if (chip && this.el.contains(chip)) {
            const r = this.runs.find((q) => q.node === chip);
            if (r) { const cb = chip.getBoundingClientRect(); return x < cb.left + cb.width / 2 ? r.start : r.end; }
        }
        let node = null, off = 0;
        if (typeof document.caretPositionFromPoint === "function") {
            const p = document.caretPositionFromPoint(x, y);
            if (p) { node = p.offsetNode; off = p.offset; }
        } else if (typeof document.caretRangeFromPoint === "function") {
            const rg = document.caretRangeFromPoint(x, y);
            if (rg) { node = rg.startContainer; off = rg.startOffset; }
        }
        if (!node || !this.el.contains(node)) return this.text.length;
        return this.snap(clamp(this.domToOffset(node, off), 0, this.text.length));
    }

    /** a thin line where a drop would land */
    showDropCaret(off) {
        const root = this.popupRoot || document.body;
        if (!this.dropCaret) {
            this.dropCaret = mk("div", "ipc-pf-dropcaret");
            root.appendChild(this.dropCaret);
        }
        const r = this.anchorRect(off), rb = root.getBoundingClientRect();
        const h = Math.max(14, Math.min(24, r.height || 18));
        Object.assign(this.dropCaret.style, { left: `${r.left - rb.left - 1}px`, top: `${r.top - rb.top + ((r.height || h) - h) / 2}px`, height: `${h}px` });
    }

    hideDropCaret() {
        if (this.dropCaret) this.dropCaret.remove();
        this.dropCaret = null;
    }

    onDragStart(e) {
        const t = e.target;
        if (t && t.nodeType === 1 && t.closest && t.closest(".ipc-chip")) { e.preventDefault(); return; }
        const [a, b] = this.readSel();
        if (a === b || !e.dataTransfer) return;
        this.drag = [a, b];
        this.hideCard(true);
        e.dataTransfer.setData("text/plain", this.text.slice(a, b));
        e.dataTransfer.setData(RANGE_TYPE, "1");
        e.dataTransfer.effectAllowed = "copyMove";
    }

    onDragOver(e) {
        const dt = e.dataTransfer;
        if (!dt) return;
        const types = Array.from(dt.types || []);
        const inner = !!this.drag && types.includes(RANGE_TYPE);
        if (!types.includes("Files") && !inner && !types.includes("text/plain")) return;
        // ours: the editor's drop handlers (a picture onto the canvas's root) stay out
        e.preventDefault();
        e.stopPropagation();
        if (this.el.getAttribute("aria-disabled") === "true") { dt.dropEffect = "none"; return; }
        dt.dropEffect = inner && !e.ctrlKey ? "move" : "copy";
        const off = this.pointOffset(e.clientX, e.clientY);
        if (off == null) this.hideDropCaret(); else this.showDropCaret(off);
    }

    onDrop(e) {
        const dt = e.dataTransfer;
        if (!dt) return;
        e.preventDefault();
        e.stopPropagation();
        this.hideDropCaret();
        const inner = this.drag;
        this.drag = null;
        if (this.el.getAttribute("aria-disabled") === "true") return;
        const off = this.pointOffset(e.clientX, e.clientY);
        const at = off == null ? this.text.length : off;
        const files = imageFiles(dt);
        if (files.length) {
            this.endSession();
            this.setSel(at, at);
            this.focus();
            this.addReferences(files);
            return;
        }
        if (inner && Array.from(dt.types || []).includes(RANGE_TYPE)) { this.moveRange(inner[0], inner[1], at, e.ctrlKey); return; }
        const d = dt.getData("text/plain");
        if (!d) return;
        this.pre = { text: this.text, start: at, end: at };
        this.edit(at, at, d, "paste", "insertFromDrop");
        this.focus();
    }

    /**
     * [a, b) of the text moved (or, `copy`, copied) to offset `to`, one undo step, the moved text selected after it. The
     * gap it leaves loses one of two spaces, and it gets a space against a word on either side at its new place, so a
     * chip stays a chip (C1).
     */
    moveRange(a, b, to, copy = false) {
        [a, b] = this.widen(a, b);
        to = this.snap(to);
        if (a === b || (!copy && to >= a && to <= b)) { this.setSel(to, to); return false; }
        const piece = this.text.slice(a, b);
        let rest = copy ? this.text : this.text.slice(0, a) + this.text.slice(b);
        let at = !copy && to > b ? to - (b - a) : to;
        if (!copy && rest[a - 1] === " " && rest[a] === " ") { rest = rest.slice(0, a) + rest.slice(a + 1); if (at > a) at--; }
        const W = /[\w-]/;
        const pre = at > 0 && W.test(rest[at - 1]) && !/^\s/.test(piece) ? " " : "";
        // against a word, or against a token's @ when the piece ends in a word character (C1: "red@img1" is no token)
        const post = at < rest.length && !/\s$/.test(piece) && (W.test(rest[at]) || (W.test(piece[piece.length - 1]) && TOKEN_AT.test(rest.slice(at)))) ? " " : "";
        const next = normalize(rest.slice(0, at) + pre + piece + post + rest.slice(at));
        if (next === this.text) { this.setSel(to, to); return false; }
        const s = at + pre.length, e = s + piece.length;
        if (this.session) this.endSession();
        const had = this.hasFocus();
        this.history.record(this.state(), { text: next, start: s, end: e }, copy ? "paste" : "move");
        this.text = next;
        this.open = null;
        this.autoSpace = null;
        this.anchor = s;
        this.focusOff = e;
        this.render();
        this.focus();
        if (this.hasFocus()) this.applySel();
        this.fire("insertFromDrop");
        if (!had) this.el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    destroy() {
        this.destroyed = true;
        document.removeEventListener("selectionchange", this.onSelChange);
        window.removeEventListener("mouseup", this.onPointerUp, true);
        this.endChipDrag();
        this.closePopups();
        if (this.fileInput) { this.fileInput.remove(); this.fileInput = null; }
        if (this.bar) this.bar.destroy();
        this.bar = null;
        this.refs = () => EMPTY_CONTEXT;
        this.addReferencesFn = null;
        this.preview = null;
    }
}

/** a token right at the start of a string (C1's grammar) */
const TOKEN_AT = new RegExp("^" + TOKEN);

/** the drag data type that marks a selection dragged inside the field (moved, not copied) */
const RANGE_TYPE = "application/x-scumble-range";

/**
 * The pictures of a paste or a drop: image files (and TIFFs, which a browser may type as nothing), from the files or
 * the file items.
 * @param {DataTransfer | null} dt
 * @returns {File[]}
 */
export function imageFiles(dt) {
    if (!dt) return [];
    const isImage = (f) => !!f && ((f.type || "").startsWith("image/") || /\.tiff?$/i.test(f.name || ""));
    let files = Array.from(dt.files || []).filter(isImage);
    if (!files.length && dt.items) {
        files = Array.from(dt.items).filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(isImage);
    }
    return files;
}

function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

/**
 * A popup under a rect (or above it when less than `room` px are free below), inside `root`: positions relative to
 * the root's box, as the brush tips' picker does.
 */
function placeBox(box, root, rect, gap = 6, room = 200) {
    const rb = root.getBoundingClientRect();
    const w = box.offsetWidth || 240, h = box.offsetHeight || 120;
    const left = clamp(rect.left - rb.left, 4, Math.max(4, rb.width - w - 4));
    const below = rb.bottom - rect.bottom;
    const top = below < Math.min(room, h + gap + 4) && rect.top - rb.top > below ? rect.top - rb.top - h - gap : rect.bottom - rb.top + gap;
    box.style.left = `${left}px`;
    box.style.top = `${clamp(top, 4, Math.max(4, rb.height - h - 4))}px`;
}

/**
 * The popover of the @ picker and of a chip's swap menu (26c2), built like the brush tips' picker
 * (inpaint_tippicker.js): absolute in the field's popup root, its presses kept from the editor, closed by a press
 * outside it. It never takes the focus: its keys come from the field's keydown (`key`), so the caret stays in the text.
 */
export class RefPicker {
    constructor(field, mode) {
        this.field = field;
        this.mode = mode;
        this.el = null;
        this.items = [];
        this.cursor = -1;
        this.note = "";
    }

    get isOpen() { return !!this.el; }

    build() {
        const pop = mk("div", "ipc-refpop");
        pop.setAttribute("role", "listbox");
        pop.setAttribute("aria-label", this.mode === "swap" ? "Swap the reference" : "Reference images");
        pop.dataset.mode = this.mode;
        this.head = mk("div", "ipc-rp-head");
        this.list = mk("div", "ipc-rp-list");
        this.noteEl = mk("div", "ipc-rp-note");
        pop.append(this.head, this.list, this.noteEl);
        if (this.mode === "insert") pop.appendChild(mk("div", "ipc-rp-foot", "\u2191\u2193 Navigate \u00b7 \u23ce Insert \u00b7 Esc Close"));
        for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu"]) pop.addEventListener(type, (e) => e.stopPropagation());
        // a press in it keeps the focus (and the caret) in the field
        pop.addEventListener("mousedown", (e) => e.preventDefault());
        (this.field.popupRoot || document.body).appendChild(pop);
        this.el = pop;
        this.outside = (e) => {
            if (!this.el || this.el.contains(e.target)) return;
            const f = this.field;
            // a press in the field moves the caret: the session follows it (or ends); the swap chip's chevron toggles
            if (this.mode === "insert" && (f.el.contains(e.target) || f.adding)) return;
            if (this.mode === "swap" && f.session && f.session.chip && f.session.chip.contains(e.target) && e.target.closest(".ipc-chip-chev")) return;
            f.endSession();
        };
        window.addEventListener("pointerdown", this.outside, true);
    }

    /** The rows (and the anchor) of now; the cursor stays on the same row when it is still there. */
    show(items, rect, query) {
        if (!this.el) this.build();
        const prev = this.items[this.cursor];
        this.items = items;
        // the cursor stays on its row: a reference, or another row the user moved to; else the first reference (in the
        // @ picker Enter and Tab never open the file dialog on their own: with no reference listed they do what they do)
        const same = !prev ? -1 : prev.kind === "ref" ? items.findIndex((it) => it.kind === "ref" && it.ref.id === prev.ref.id)
            : this.moved ? items.findIndex((it) => it.kind === prev.kind) : -1;
        const first = this.mode === "insert" ? items.findIndex((it) => it.kind === "ref" && !it.disabled) : items.findIndex((it) => !it.disabled);
        this.cursor = same >= 0 && !items[same].disabled ? same : first;
        this.head.textContent = this.mode === "swap" ? "Swap for" : query ? `@${query}` : "Reference images";
        this.head.classList.toggle("ipc-rp-query", this.mode === "insert" && !!query);
        this.list.replaceChildren(...items.map((it, i) => this.row(it, i)));
        if (!items.some((it) => it.kind === "ref") && this.mode === "insert") this.list.prepend(mk("div", "ipc-rp-empty", query ? `No reference matches "${query}"` : this.note ? "No shown reference images" : "No reference images yet"));
        this.noteEl.textContent = this.note || "";
        this.noteEl.hidden = !this.note;
        this.mark();
        if (rect) placeBox(this.el, this.field.popupRoot || document.body, rect, 6, 200);
    }

    row(it, i) {
        const b = mk("button", "ipc-rp-row");
        b.type = "button";
        b.tabIndex = -1;
        b.dataset.kind = it.kind;
        b.setAttribute("role", "option");
        if (it.disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
        if (it.title) b.title = it.title;
        if (it.kind === "ref") {
            const d = it.ref;
            b.dataset.id = d.id;
            const av = mk("img", "ipc-rp-av");
            av.alt = "";
            av.draggable = false;
            if (d.thumb) av.src = d.thumb; else av.hidden = true;
            b.append(av, mk("span", "ipc-rp-label", "img" + d.label), mk("span", "ipc-rp-name", d.name || ""));
            if (d.sentAs) b.appendChild(mk("span", "ipc-rp-sent", d.sentAs));
            if (d.over) b.appendChild(mk("span", "ipc-rp-over", "over"));
        } else if (it.kind === "add") b.append(mk("span", "ipc-rp-plus", "+"), mk("span", "ipc-rp-name", "Add reference"));
        else if (it.kind === "show") b.append(mk("span", "ipc-rp-plus", "\u25c9"), mk("span", "ipc-rp-name", `Show ${cut(it.ref.name || "reference", 24)}`));
        else b.append(mk("span", "ipc-rp-plus", "\u00d7"), mk("span", "ipc-rp-name", "Remove from prompt"));
        // the mouse picks a row only when it moves: a list that opens under a resting pointer (Chromium sends a move
        // of no distance after the layout) keeps its first row for Enter
        b.addEventListener("pointermove", (e) => {
            if (it.disabled || (!e.movementX && !e.movementY) || this.cursor === i) return;
            this.cursor = i;
            this.moved = true;
            this.mark();
        });
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.field.pickItem(it); });
        return b;
    }

    mark() {
        if (!this.list) return;
        const rows = this.list.querySelectorAll(".ipc-rp-row");
        rows.forEach((r, i) => r.classList.toggle("ipc-rp-cur", i === this.cursor));
        const cur = rows[this.cursor];
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
    }

    /** ↑ / ↓ with wrap over the rows that can be chosen */
    move(d) {
        const n = this.items.length;
        if (!n) return;
        this.moved = true;
        let i = this.cursor < 0 && d < 0 ? 0 : this.cursor;
        for (let k = 0; k < n; k++) {
            i = (i + d + n) % n;
            if (!this.items[i].disabled) { this.cursor = i; break; }
        }
        this.mark();
    }

    /** the row under the cursor, or null */
    current() {
        const it = this.items[this.cursor];
        return it && !it.disabled ? it : null;
    }

    close() {
        if (this.outside) window.removeEventListener("pointerdown", this.outside, true);
        this.outside = null;
        if (this.el) this.el.remove();
        this.el = this.head = this.list = this.noteEl = null;
        this.items = [];
        this.cursor = -1;
    }
}

/**
 * The reference bar above the prompt (26c2): a chip per reference in list order (a hidden one dimmed, not insertable),
 * a "+" that adds pictures as references, and the count against what the recipe takes. A click names the reference at
 * the field's kept caret.
 */
export class RefBar {
    constructor(field, { mount } = {}) {
        this.field = field;
        field.bar = this;
        const bar = mk("div", "ipc-refbar");
        this.chips = mk("div", "ipc-refbar-chips");
        this.add = mk("button", "ipc-refbar-add", "+");
        this.add.type = "button";
        this.add.tabIndex = -1;
        this.add.setAttribute("aria-label", "Add reference");
        this.count = mk("span", "ipc-refbar-count");
        bar.append(this.chips, this.add, this.count);
        // presses stay out of the editor (its root click takes the focus) and keep the caret in the field
        bar.addEventListener("mousedown", (e) => { e.preventDefault(); field.hideCard(true); });
        bar.addEventListener("click", (e) => {
            e.stopPropagation();
            const t = e.target && e.target.closest ? e.target : null;
            if (!t) return;
            if (t.closest(".ipc-refbar-add")) { if (!this.add.disabled) field.chooseFiles(); return; }
            const chip = t.closest(".ipc-refbar-chip");
            if (!chip || chip.dataset.state === "hidden") return;
            field.insertToken(+chip.dataset.label);
        });
        bar.addEventListener("pointerover", (e) => {
            const chip = e.target && e.target.closest ? e.target.closest(".ipc-refbar-chip") : null;
            if (chip) field.hoverStart(chip, e);
        });
        bar.addEventListener("pointerout", (e) => {
            const chip = e.target && e.target.closest ? e.target.closest(".ipc-refbar-chip") : null;
            if (chip) field.hoverEnd(chip, e.relatedTarget);
        });
        this.el = bar;
        if (mount) mount.insertBefore(bar, mount.firstChild);
        this.sig = null;
        this.refresh();
    }

    /** Drawn again from the field's context; nothing is touched when nothing changed. */
    refresh() {
        if (!this.el) return;
        const ctx = this.field.fullContext();
        const refs = ctx.refs || [];
        const cnt = barCount(ctx);
        const sig = JSON.stringify([refs.map((d) => [d.id, d.label, d.name, d.visible, d.thumb, d.sentAs, !!d.over]), cnt, ctx.canAdd, ctx.none, ctx.refuse || null]);
        if (sig === this.sig) return;
        this.sig = sig;
        this.chips.replaceChildren(...refs.map((d) => {
            const st = d.label == null ? "hidden" : chipState({ n: d.label }, ctx).state;
            const b = mk("button", "ipc-refbar-chip");
            b.type = "button";
            b.tabIndex = -1;
            b.dataset.id = d.id;
            b.dataset.state = st;
            if (d.label != null) b.dataset.label = String(d.label);
            const av = mk("img", "ipc-chip-av");
            av.alt = "";
            av.draggable = false;
            if (d.thumb) av.src = d.thumb; else av.hidden = true;
            b.appendChild(av);
            if (d.label == null) b.appendChild(eyeOff());
            b.appendChild(mk("span", "ipc-chip-label", d.label != null ? "img" + d.label : cut(d.name || "reference")));
            b.setAttribute("aria-label", d.label != null ? `name img${d.label}, ${d.name || "reference"}, in the prompt` : `${d.name || "reference"}: hidden`);
            if (d.label == null) b.setAttribute("aria-disabled", "true");
            return b;
        }));
        this.add.disabled = !ctx.canAdd;
        this.add.title = ctx.canAdd ? "Add images as reference layers and name them in the prompt" : "Load an image first";
        this.count.textContent = cnt.text;
        this.count.title = cnt.title;
        this.count.classList.toggle("ipc-refbar-over", cnt.over);
        this.el.classList.toggle("ipc-refbar-empty", !refs.length);
    }

    destroy() {
        if (this.el) this.el.remove();
        this.el = null;
    }
}

/** the eye with a stroke through it (a hidden reference in the bar), the path of the editor's own eyeOff icon */
function eyeOff() {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "ipc-refbar-eye");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    for (const d of ["M4 4l16 16", "M10 6.3A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.4", "M6.6 8.6C4 10.4 2 12 2 12s4 6 10 6a10 10 0 003-.5"]) {
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", d);
        s.appendChild(p);
    }
    return s;
}
