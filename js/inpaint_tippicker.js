// Generated from DenRakEiw/scumble renderer/editor/inpaint_tippicker.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The brush tip popover (PLAN_0_1_31 §4 step 10): opened from the tip thumbnail in the options bar, it lists every tip
// with a stroke preview, the recently used ones first and a search over names and source files. A click picks a tip and
// leaves the popover open (the thumbnail and the brush ring follow at once); a double click or Enter picks and closes;
// Esc, a click beside it or the thumbnail again close it.
//
// The previews are drawn here and never through the editor's stroke code: `stampDab`, `tipStamp` and `dabMask` keep a
// single cache entry each (and `stampDab` the last stroke's angle), which a preview would evict mid-stroke. A tip is
// drawn from a small copy (`tipMini`, its long side MINI px) cached on the tip object, since a .abr tip may be thousands
// of pixels a side; the previews are cached there too, keyed by what they show. The host's `saveBrushTips` stores named fields
// only, so neither cache reaches the brush store.

import { THEME } from "./inpaint_theme.js";

export const RECENT_KEY = "ipc.recentTips";   // localStorage: the recent tip ids, newest first
export const RECENT_MAX = 8;                  // shown
export const RECENT_KEEP = 32;                // stored: a removed tip leaves a hole the older ones fill
export const ROUND_ID = "round";              // the built-in dab in the recent list (its brushTipId is "")
export const PREVIEW_W = 140, PREVIEW_H = 34;  // a row's stroke preview in CSS pixels
export const CHIP = 36;                        // a recent tip's square in CSS pixels
const MINI = 96;

/** The built-in round dab as a list entry. */
export const ROUND_ENTRY = Object.freeze({ id: "", name: "Round", source: "", builtIn: true });

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/** The stored recent tip ids, newest first ("round" for the built-in dab); ids of removed tips are the reader's to skip. */
export function recentTipIds() {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
        return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).slice(0, RECENT_KEEP) : [];
    } catch (_) { return []; }
}

/** Put a tip at the front of the recent list ("" is the round dab). Returns the list. */
export function noteRecentTip(id) {
    const key = id || ROUND_ID;
    const list = [key, ...recentTipIds().filter((x) => x !== key)].slice(0, RECENT_KEEP);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
    return list;
}

/** The entries whose name or source file holds every word of `query` (case-insensitive), in their order. */
export function matchTips(tips, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return tips.slice();
    return tips.filter((t) => {
        const hay = `${t.name || ""} ${t.source || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/** The group a tip is listed under: its source file, "Images" for a tip from an image, "Built in" for the round dab. */
export function tipGroup(t) {
    return t.builtIn ? "Built in" : (t.source || "Images");
}

/** The entries in groups (first appearance decides a group's place; a tip keeps its place inside its group). */
export function groupTips(tips) {
    const groups = new Map();
    for (const t of tips) {
        const g = tipGroup(t);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(t);
    }
    return [...groups].map(([name, list]) => ({ name, tips: list }));
}

/** The tip with its long side at most MINI px, cached on the tip (its canvas never changes). */
export function tipMini(tip) {
    const src = tip.canvas;
    if (tip._mini && tip._mini.src === src) return tip._mini.c;
    const k = Math.min(1, MINI / Math.max(1, src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, w, h);
    tip._mini = { src, c };
    return c;
}

let roundMini = null;
/** The round dab at MINI px for a hardness, drawn as `dabMask` draws it. */
function roundDab(hardness) {
    const h = Math.max(0, Math.min(1, +hardness || 0));
    if (roundMini && roundMini.h === h) return roundMini.c;
    const c = document.createElement("canvas");
    c.width = MINI; c.height = MINI;
    const g = c.getContext("2d");
    const r = MINI / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(Math.max(0, Math.min(0.97, h)), "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, MINI, MINI);
    roundMini = { h, c };
    return c;
}

function tint(g, w, h, color) {
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
}

/**
 * A stroke with the tip across the canvas: one S-shaped wave whose size swells from a third to the full size and back,
 * as a pen's pressure would, stamped at the tip's spacing (a quarter of the size for the round dab, as the editor stamps
 * it), turned along the path when `follow` is on, tinted with `color`. `tip` null is the round dab at `hardness`.
 */
export function drawTipStroke(canvas, tip, { hardness = 0.8, follow = false, color = "#e8e8e8", spacing = 0.25 } = {}) {
    const w = canvas.width, h = canvas.height;
    const g = canvas.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const src = tip ? tipMini(tip) : roundDab(hardness);
    const aspect = src.width / src.height;
    const sp = tip ? (tip.spacing || spacing) : 0.25;
    const smax = h * 0.55;                     // the long side at the widest point
    const amp = h * 0.24;
    const pad = smax * 0.2 + 2;
    const at = (t) => [pad + (w - 2 * pad) * t, h / 2 - amp * Math.sin(2 * Math.PI * t)];
    const sizeAt = (t) => smax * (0.35 + 0.65 * Math.sin(Math.PI * t));
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    const stamp = (x, y, s, angle) => {
        const dw = aspect >= 1 ? s : s * aspect, dh = aspect >= 1 ? s / aspect : s;
        if (angle) {
            g.save();
            g.translate(x, y);
            g.rotate(angle);
            g.drawImage(src, -dw / 2, -dh / 2, dw, dh);
            g.restore();
        } else {
            g.drawImage(src, x - dw / 2, y - dh / 2, dw, dh);
        }
    };
    const N = 400;
    let [px, py] = at(0);
    let carry = 0;
    stamp(px, py, sizeAt(0), 0);
    for (let i = 1; i <= N; i++) {
        const t = i / N;
        const [x, y] = at(t);
        const d = Math.hypot(x - px, y - py);
        carry += d;
        const s = sizeAt(t);
        const step = Math.max(1, s * sp);
        if (carry >= step) {
            carry = 0;
            stamp(x, y, s, follow && tip ? Math.atan2(y - py, x - px) : 0);
        }
        px = x; py = y;
    }
    tint(g, w, h, color);
    return canvas;
}

/** The tip fitted into the canvas and tinted: the thumbnail's picture, for the recent squares. */
export function drawTipGlyph(canvas, tip, { hardness = 0.8, color = "#e8e8e8" } = {}) {
    const w = canvas.width, h = canvas.height;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, w, h);
    const src = tip ? tipMini(tip) : roundDab(hardness);
    const k = Math.min((w - 4) / src.width, (h - 4) / src.height, tip ? 4 : (h * 0.7) / src.height);
    const dw = src.width * k, dh = src.height * k;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    tint(g, w, h, color);
    return canvas;
}

let roundPreview = null;
/** The stroke preview of a tip at w x h device pixels, cached by what it shows (colour, spacing, follow, hardness). */
export function strokePreview(tip, w, h, opts) {
    const key = `${w}x${h}|${opts.color}|${tip ? (tip.spacing || 0) : opts.hardness}|${tip && opts.follow ? 1 : 0}`;
    const cached = tip ? tip._preview : roundPreview;
    if (cached && cached.key === key) return cached.c;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    drawTipStroke(c, tip, opts);
    if (tip) tip._preview = { key, c }; else roundPreview = { key, c };
    return c;
}

/**
 * The popover of one editor. `ed` gives it `brushTips`, `brushTipId`, `setBrushTip(id)`, `activeHardness()`,
 * `tipRotate`, `tipFile` (the import input) and `root` (where it is placed).
 */
export class TipPicker {
    constructor(ed) {
        this.ed = ed;
        this.el = null;
        this.anchor = null;
        this.rows = [];
        this.cursor = -1;
        this._timer = 0;
    }

    get isOpen() { return !!this.el; }

    open(anchor) {
        if (this.el) return;
        const ed = this.ed;
        this.anchor = anchor || null;
        this.cursor = -1;
        const pop = el("div", "ipc-tippop");
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-label", "Brush tips");
        const head = el("div", "ipc-tp-head");
        this.search = document.createElement("input");
        this.search.type = "search";
        this.search.placeholder = "Search tips";
        this.search.title = "Search the names and the files the tips came from; every word has to match. Arrow keys move, Enter picks and closes.";
        this.search.spellcheck = false;
        this.search.addEventListener("input", () => this.render());
        this.search.addEventListener("keydown", (e) => this.onKey(e));
        head.appendChild(this.search);
        const imp = el("button", "ipc-ib ipc-small", "Import…");
        imp.type = "button";
        imp.title = "Import brush tips from a Photoshop .abr file or from images";
        imp.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (ed.tipFile) ed.tipFile.click(); this.focusSearch(); });
        head.appendChild(imp);
        pop.appendChild(head);
        this.recentBox = el("div", "ipc-tp-sec");
        this.recentBox.appendChild(el("div", "ipc-tp-label", "Recent"));
        this.recentEl = el("div", "ipc-tp-recent");
        this.recentBox.appendChild(this.recentEl);
        pop.appendChild(this.recentBox);
        this.countEl = el("div", "ipc-tp-label");
        pop.appendChild(this.countEl);
        this.listEl = el("div", "ipc-tp-list");
        pop.appendChild(this.listEl);
        pop.appendChild(el("div", "ipc-tp-foot", "Click picks a tip, a double click or Enter picks it and closes."));
        // the editor's own handlers stay out of it (a wheel here scrolls the list, not the view)
        for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu"]) pop.addEventListener(type, (e) => e.stopPropagation());
        // a press anywhere in it leaves the focus in the search field: on a heading, a gap or a button the focus would
        // go to the editor, whose shortcuts take the next key (Backspace removes the layer); clicks still fire
        pop.addEventListener("mousedown", (e) => { if (e.target !== this.search) e.preventDefault(); });
        ed.root.appendChild(pop);
        this.el = pop;
        if (this.anchor) this.anchor.classList.add("ipc-open");
        this.render();
        this.place();
        this._outside = (e) => {
            if (!this.el) return;
            if (this.el.contains(e.target) || (this.anchor && this.anchor.contains(e.target))) return;
            // the label around the anchor forwards its click to the anchor, which toggles: closing here would reopen it
            if (this.anchor && e.target === this.anchor.closest("label")) return;
            const onPicture = e.target === this.ed.canvas;
            this.close();
            // a press on the picture only closes it: no dab, no selection, no move
            if (onPicture) { e.preventDefault(); e.stopPropagation(); }
        };
        window.addEventListener("pointerdown", this._outside, true);
        try { this.search.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }

    /** Under the anchor, inside the editor, as tall as the room below allows. */
    place() {
        if (!this.el) return;
        const root = this.ed.root.getBoundingClientRect();
        const r = this.anchor ? this.anchor.getBoundingClientRect() : { left: root.left + 60, bottom: root.top + 60 };
        const w = this.el.offsetWidth || 360;
        const left = Math.max(4, Math.min(r.left - root.left, root.width - w - 4));
        const top = Math.max(4, r.bottom - root.top + 6);
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
        this.el.style.maxHeight = `${Math.max(180, Math.min(560, root.height - top - 12))}px`;
    }

    close() {
        clearTimeout(this._timer);
        if (this._outside) window.removeEventListener("pointerdown", this._outside, true);
        this._outside = null;
        if (!this.el) return;
        const hadFocus = this.el.contains(document.activeElement);
        this.el.remove();
        // nothing of it is kept: the rows' canvases and the tips they list go with it
        this.el = this.search = this.recentBox = this.recentEl = this.countEl = this.listEl = null;
        this.rows = [];
        this.cursor = -1;
        if (this.anchor) this.anchor.classList.remove("ipc-open");
        this.anchor = null;
        if (hadFocus && this.ed.root) { try { this.ed.root.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    }

    focusSearch() {
        if (this.search) { try { this.search.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    }

    /** What a preview shows besides the tip. */
    previewOpts() {
        const ed = this.ed;
        return {
            color: THEME.tipGlyph,
            hardness: typeof ed.activeHardness === "function" ? ed.activeHardness() : (ed.hardness ?? 0.8),
            follow: !!ed.tipRotate,
        };
    }

    entries() { return [ROUND_ENTRY, ...(this.ed.brushTips || [])]; }

    /** The whole content again: the library or the query changed. */
    render() {
        if (!this.el) return;
        clearTimeout(this._timer);
        this.cursor = -1;
        const all = this.entries();
        const query = this.search.value.trim();
        const shown = matchTips(all, query);
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const opts = this.previewOpts();
        // recent: only without a query (a search is for the whole library)
        this.recentEl.innerHTML = "";
        const byId = new Map(all.map((t) => [t.id || ROUND_ID, t]));
        const recent = recentTipIds().map((id) => byId.get(id)).filter(Boolean).slice(0, RECENT_MAX);
        this.recentBox.hidden = !recent.length || !!query;
        for (const t of recent) {
            const b = el("button", "ipc-tp-chip");
            b.type = "button";
            b.dataset.id = t.id;
            b.title = t.name;
            const cv = document.createElement("canvas");
            cv.width = CHIP * dpr; cv.height = CHIP * dpr;
            cv.style.width = `${CHIP - 4}px`; cv.style.height = `${CHIP - 4}px`;
            drawTipGlyph(cv, t.builtIn ? null : t, opts);
            b.appendChild(cv);
            b.addEventListener("click", () => this.pick(t.id, false));
            b.addEventListener("dblclick", () => this.pick(t.id, true));
            this.recentEl.appendChild(b);
        }
        this.countEl.textContent = query ? `${shown.length} of ${all.length} tips` : (all.length === 1 ? "Tips" : `All tips · ${all.length}`);
        this.listEl.innerHTML = "";
        this.rows = [];
        for (const group of groupTips(shown)) {
            const gh = el("div", "ipc-tp-group", group.name);
            gh.title = group.name;
            this.listEl.appendChild(gh);
            for (const t of group.tips) {
                const row = el("div", "ipc-tp-row");
                row.dataset.id = t.id;
                const size = t.builtIn ? "the built-in soft dab; Hardness sets its edge" : `${t.canvas.width} × ${t.canvas.height} px${t.spacing ? `, spacing ${Math.round(t.spacing * 100)} %` : ""}`;
                row.title = `${t.name}: ${size}`;
                const cv = document.createElement("canvas");
                cv.width = PREVIEW_W * dpr; cv.height = PREVIEW_H * dpr;
                cv.style.width = `${PREVIEW_W}px`; cv.style.height = `${PREVIEW_H}px`;
                row.appendChild(cv);
                row.appendChild(el("span", "ipc-tp-name", t.name));
                row.addEventListener("click", () => this.pick(t.id, false));
                row.addEventListener("dblclick", () => this.pick(t.id, true));
                this.listEl.appendChild(row);
                this.rows.push({ tip: t, row, cv, drawn: false });
            }
        }
        if (!shown.length) this.listEl.appendChild(el("div", "ipc-tp-empty", `No tip matches "${query}".`));
        else if (all.length === 1 && !query) this.listEl.appendChild(el("div", "ipc-tp-empty", "Import a Photoshop .abr or an image to add tips."));
        this.markActive();
        this.paintPreviews(opts);
    }

    /** The previews in display order, a slice per task so a library of hundreds does not hold the window. */
    paintPreviews(opts) {
        const todo = this.rows.slice();
        const step = () => {
            if (!this.el) return;
            const t0 = performance.now();
            while (todo.length && performance.now() - t0 < 12) {
                const r = todo.shift();
                if (!r.row.isConnected) continue;
                const src = strokePreview(r.tip.builtIn ? null : r.tip, r.cv.width, r.cv.height, opts);
                r.cv.getContext("2d").drawImage(src, 0, 0);
                r.drawn = true;
            }
            if (todo.length) this._timer = setTimeout(step, 0);
        };
        step();
    }

    /** The active tip highlighted (a click elsewhere, the select or set_brush changed it). */
    markActive() {
        if (!this.el) return;
        const id = this.ed.brushTipId || "";
        for (const r of this.rows) r.row.classList.toggle("ipc-active", (r.tip.id || "") === id);
        for (const b of this.recentEl.children) b.classList.toggle("ipc-active", (b.dataset.id || "") === id);
    }

    pick(id, close) {
        this.ed.setBrushTip(id || "");
        this.markActive();
        if (close) this.close(); else this.focusSearch();
    }

    /** The first arrow starts next to the active tip (or at an end when it is not listed). */
    moveCursor(delta) {
        if (!this.rows.length) return;
        let from = this.cursor;
        if (from < 0) {
            const active = this.rows.findIndex((r) => r.row.classList.contains("ipc-active"));
            from = active >= 0 ? active : (delta > 0 ? -1 : this.rows.length);
        }
        this.cursor = Math.max(0, Math.min(this.rows.length - 1, from + delta));
        this.rows.forEach((r, i) => r.row.classList.toggle("ipc-cursor", i === this.cursor));
        const row = this.rows[this.cursor].row;
        if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }

    /**
     * Keys in the search field: arrows move through the list, Enter picks the row under the cursor (the first match
     * of a query when there is none) and closes; Enter with neither only closes (Esc is the editor's).
     */
    onKey(e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            this.moveCursor(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const r = this.cursor >= 0 ? this.rows[this.cursor] : (this.search.value.trim() ? this.rows[0] : null);
            if (r) this.pick(r.tip.id, true); else this.close();
        }
        if (e.key !== "Escape") e.stopPropagation();
    }
}
