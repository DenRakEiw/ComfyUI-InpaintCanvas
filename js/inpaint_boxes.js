// Generated from DenRakEiw/scumble renderer/editor/inpaint_boxes.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The editor's own Boxes (docs/PLAN_NODE_BOXES.md B4): the owner of boxes where no Boxes plugin is, the ComfyUI node
// (its host member boxesInEditor is true; the app's is false and the app keeps plugins/boxes as the owner, so this
// module is never built there). The boxes live in editor.pluginData.boxes ({ version: 1, boxes: [...] }, the app's
// shape), one undo step of kind "data" per change; the editor's getValue / setValue carry them in the node's
// workflow, and serializeForPrompt sends them (boxes_model.js promptPayload) for nodes.py to write FLUX 3's rows.
// The tool is boxes_tool.js's (the same tool X as in the app), the model boxes_model.js's, the clipboard text
// boxes_format.js's. The editor routes to this module (pointer, keys, the overlay, the geometry, every change); this
// module never reaches the host itself. No page-level side effects: ComfyUI imports every module of the node.

import { el } from "./inpaint_canvas.js";
import { DESC_MAX } from "./boxes.js";
import { clipboardText, fold } from "./boxes_format.js";
import { makeTool, colourOf } from "./boxes_tool.js";
import { HELP, KIND_LABELS, nextId, addBox, setBox, removeBox, selectionInput, cropCheck, bareOf, warningLines, mapBoxes, clipDesc } from "./boxes_model.js";

/** The tool's button title in the tool column. */
export const BOXES_TOOL_TITLE = "Boxes (X): boxes for FLUX 3's box prompt. Drag to draw a box, click to select, double-click to describe it, drag to move, the handles resize; Delete removes, D duplicates, arrows nudge (Shift 10 px), Alt+click picks a box under another. The Generate pane's Boxes section lists them; box_prompt carries them.";

const NODE_HELP = "Wire the canvas output box_prompt into the prompt of a FLUX 3 node and crop_image whole into its first image: the boxes go as FLUX 3's rows (New, Keep, Move, Remove, From reference, Text). elements carries the New and Text boxes for a Flux 3 Image node's bounding_boxes on a new image (never both on an edit). " + HELP.replace(/ Ideogram 4 takes[^.]*\.$/, "");

/** [l, t, r, b] of a span fitted to a multiple as nodes.py _fit_span_to_multiple does (target_size 0). */
function fitSpan(a0, a1, limit, m) {
    const size = a1 - a0;
    let target = Math.ceil(size / m) * m;
    if (target > limit) {
        target = Math.floor(limit / m) * m;
        if (target <= 0) return [a0, a1];
    }
    const extra = target - size;
    a0 -= Math.floor(extra / 2);
    a1 = a0 + target;
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > limit) { a0 -= a1 - limit; a1 = limit; }
    return [Math.max(0, a0), a1];
}

export class EditorBoxes {
    constructor(ed) {
        this.ed = ed;
        this.switched = null;    // the note of the switch the last add turned on, until its caller has said it
        this.panel = null;       // { box, list, warn, note, key, warnKey, pending } once buildPanel ran
        const self = this;
        // the document as the tool sees it (a plugin's Document in the app)
        this.doc = {
            get id() { return ed.node && ed.node.id != null ? ed.node.id : "canvas"; },
            get loaded() { return !!ed.base; },
            get width() { return ed.width || 0; },
            get height() { return ed.height || 0; },
            editor: ed,
            draw: () => ed.draw(),
            status: (text, kind) => ed.setStatus(String(text), kind),
            layers: () => self.layerSummaries(),
            layer: (key) => self.layerOf(key),
        };
        this.tool = makeTool({ docById: () => this.doc }, {
            boxesOf: () => this.list(),
            add: (doc, input) => this.add(input),
            set: (doc, id, patch) => this.set(id, patch),
            remove: (doc, id) => this.remove(id),
            nextId,
            switchNote: () => this.takeSwitchNote(),
            frame: () => this.cropFrame(),
            sent: () => !!(ed.genSettings && ed.genSettings.boxes),
            panelShown: () => this.panelShown(),
            selChanged: () => this.highlight(),
            referenceName: (doc, id) => { const l = (ed.layers || []).find((x) => x.id === id); return l ? l.name : "(no layer)"; },
        });
    }

    // ---- the data ------------------------------------------------------------------------------------------------

    /** The boxes of the document (image pixels), as stored. */
    list() {
        const d = this.ed.pluginData && this.ed.pluginData.boxes;
        return d && Array.isArray(d.boxes) ? d.boxes : [];
    }

    /** Store `boxes` as one undo step called `label` (none: no step), then everything that shows them follows. */
    write(boxes, label) {
        const ed = this.ed;
        if (label) ed.pushUndo({ kind: "data", label });
        if (!ed.pluginData || typeof ed.pluginData !== "object") ed.pluginData = {};
        ed.pluginData.boxes = JSON.parse(JSON.stringify({ version: 1, boxes }));
        ed.notifyChanged();   // the editor calls refresh() from there
    }

    layerSummaries() {
        const labels = this.ed.refLabels ? this.ed.refLabels() : new Map();
        return (this.ed.layers || []).map((l) => ({ id: l.id, name: l.name, role: l.role || "none", visible: l.visible !== false, x: l.x, y: l.y, w: l.w, h: l.h, label: labels.has(l.id) ? "img" + labels.get(l.id) : null }));
    }

    /** A layer by id or exact name. */
    layerOf(key) {
        const k = String(key);
        const l = (this.ed.layers || []).find((x) => x.id === k) || (this.ed.layers || []).find((x) => x.name === k);
        if (!l) throw new Error(`no layer "${k}"`);
        return { id: l.id, name: l.name, role: l.role || "none", visible: l.visible !== false, x: l.x, y: l.y, w: l.w, h: l.h };
    }

    /** The document's side of normaliseBox. */
    ctx() {
        const ed = this.ed;
        return {
            size: { width: ed.width || 0, height: ed.height || 0 },
            referenceId: (key) => {
                const l = this.layerOf(key);
                if (l.role !== "reference") throw new Error(`${l.name} is not a reference layer: set its role to reference first`);
                return l.id;
            },
            promptNames: (id) => String(ed.promptText || "").includes(`<${id}>`),
        };
    }

    /** The first box of a document turns the Boxes switch on, so a drawn box is not left out without a word. */
    switchOn() {
        const ed = this.ed;
        if (!ed.genSettings || ed.genSettings.boxes) return;
        ed.genSettings.boxes = true;
        this.switched = "The Boxes switch under the prompt is on now: box_prompt carries the boxes.";
        ed.notifyChanged();
    }

    /** " " + the note when the last add turned the switch on, else "". */
    takeSwitchNote() {
        const n = this.switched;
        this.switched = null;
        return n ? " " + n : "";
    }

    add(input, { idBase = null } = {}) {
        this.switched = null;
        const before = this.list();
        const { boxes, box } = addBox(before, input, { ...this.ctx(), idBase });
        this.write(boxes, `Add box ${box.id}`);
        if (!before.length) this.switchOn();
        return box;
    }

    set(id, patch) {
        const { boxes, box } = setBox(this.list(), id, patch, this.ctx());
        this.write(boxes, `Change box ${id}`);
        if (box.id !== id) {
            if (this.tool.selected(this.doc) === id) this.tool.select(this.doc, box.id);
            if (patch && patch.id == null) this.ed.setStatus(`Box ${id} is called ${box.id} now, after its description.`);
        }
        return box;
    }

    remove(id) {
        this.write(removeBox(this.list(), id), `Remove box ${id}`);
        if (this.tool.selected(this.doc) === id) this.tool.select(this.doc, null);
    }

    clear() {
        const n = this.list().length;
        if (n) this.write([], "Clear boxes");
        this.tool.select(this.doc, null);
        return n;
    }

    /** The selection's bounds as a box: a New box with the prompt (or `desc`) as its description. */
    fromSelection({ id, desc } = {}) {
        const b = this.ed.getBounds ? this.ed.getBounds() : null;
        if (!b) throw new Error("Nothing is selected.");
        const prompt = desc != null ? String(desc) : String(this.ed.promptText || "");
        const labels = this.layerSummaries();
        return this.add(selectionInput({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }, prompt, (label) => labels.find((l) => l.label === label) || null, { id }), { idBase: "edit" });
    }

    /** The rows as the model reads them, measured against the whole picture, to the clipboard. */
    copyRows() {
        const ed = this.ed;
        const boxes = this.list();
        if (!boxes.length) { ed.setStatus("No boxes to copy."); return null; }
        const refs = ed.referenceLayers ? ed.referenceLayers() : [];
        const byId = new Map((ed.layers || []).map((l) => [l.id, l]));
        const got = clipboardText(String(ed.promptText || ""), boxes.map((b) => ({ ...b, layerFrame: b.layer && byId.has(b.layer) ? { x: byId.get(b.layer).x, y: byId.get(b.layer).y, w: byId.get(b.layer).w, h: byId.get(b.layer).h } : null })),
            { x: 0, y: 0, w: ed.width, h: ed.height }, { mode: "edit", nameOf: (id) => { const k = refs.findIndex((l) => l.id === id); return k < 0 ? null : `ref_image_${k + 1}`; }, descOf: (b) => fold(clipDesc(b)) });
        const said = `${got.rows.length} row${got.rows.length === 1 ? "" : "s"}`;
        const notes = got.notes.length ? " " + got.notes.join(" ") : "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(got.text).then(
                () => ed.setStatus(`${said} copied, measured against the whole picture (a run measures them in the crop it sends).${notes}`),
                () => ed.setStatus(`${said} could not be copied: the browser refused the clipboard.`, "warn"));
        } else {
            // ComfyUI over plain http on another machine: the browser has no clipboard API there
            ed.setStatus(`${said}: this page has no clipboard access (ComfyUI over plain http from another machine); box_prompt carries the same rows.`, "warn");
        }
        return got;
    }

    // ---- what Generate sends ---------------------------------------------------------------------------------------

    /**
     * The crop nodes.py would cut now ({ x, y, w, h, emitted, paste } in image pixels), or null without a selection:
     * the editor's crop rectangle, its span fitted to multiple_of at target_size 0 and its emitted size as nodes.py
     * scales it. For the overlay and the warnings; only nodes.py measures the rows.
     */
    cropFrame() {
        const ed = this.ed;
        if (!ed.base || !ed.getBounds || !ed.getBounds()) return null;
        const [x, y, w, h] = ed.cropRect();
        const ts = Number(ed.widgetValue("target_size", 1024)) || 0;
        const m = Math.max(1, Math.round(Number(ed.widgetValue("multiple_of", 64)) || 1));
        let [x0, x1] = [x, x + w], [y0, y1] = [y, y + h];
        if (ts <= 0) { [x0, x1] = fitSpan(x0, x1, ed.width, m); [y0, y1] = fitSpan(y0, y1, ed.height, m); }
        const cw = x1 - x0, ch = y1 - y0;
        let emitted = [cw, ch];
        if (ts > 0 && cw > 0 && ch > 0) {
            const s = ts / Math.max(cw, ch);
            emitted = [Math.max(m, Math.round(cw * s / m) * m), Math.max(m, Math.round(ch * s / m) * m)];
        }
        return { x: x0, y: y0, w: cw, h: ch, emitted, paste: ed.cropSettings && ed.cropSettings.paste === "crop" ? "crop" : "selection" };
    }

    // ---- the editor's events ---------------------------------------------------------------------------------------

    pointerEvent(e, ix, iy) {
        const ed = this.ed;
        return { x: ix, y: iy, shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!(e.ctrlKey || e.metaKey), button: e.button, pressure: e.pressure, pointerType: e.pointerType, inside: ix >= 0 && iy >= 0 && ix < ed.width && iy < ed.height, raw: e };
    }

    /** The tool's share of a pointer gesture: true when it took the event. */
    pointer(phase, e, ix, iy) {
        const ed = this.ed;
        if (phase === "down") {
            if (ed.tool !== "boxes") return false;
            if (!ed.base) { ed.setStatus("Load an image first."); return true; }
            ed.pointer = { kind: "boxes" };
            this.tool.tool.onDown(this.doc, this.pointerEvent(e, ix, iy));
            return true;
        }
        if (phase === "move") {
            if (!ed.pointer || ed.pointer.kind !== "boxes") return false;
            this.tool.tool.onMove(this.doc, this.pointerEvent(e, ix, iy));
            return true;
        }
        if (phase === "up") {
            this.tool.tool.onUp(this.doc, this.pointerEvent(e, ix, iy));
            return true;
        }
        return false;
    }

    /**
     * A key for the Boxes tool, before the editor's own: while the tool is active it answers Delete / Backspace, D, the
     * arrows and Escape for its selected box (so D never deselects and Delete never clears pixels or a layer); X
     * selects the tool from any tool. True when the key was taken.
     */
    key(e, k) {
        const ed = this.ed;
        if (ed.tool === "boxes" && this.tool.tool.onKey(this.doc, { key: e.key, lower: k, shift: !!e.shiftKey, raw: e })) { e.preventDefault(); return true; }
        if (k === "x" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && ed.tool !== "boxes") { ed.setTool("boxes"); return true; }
        return false;
    }

    /** The tool was left: a drag ends, an open description field keeps what it holds. */
    deselect() {
        if (this.tool.tool.onDeselect) this.tool.tool.onDeselect(this.doc);
    }

    /** The tool's hint, said when it is chosen. */
    selected() {
        if (!this.ed.status || !this.ed.status.startsWith("Boxes:")) this.ed.setStatus(this.tool.tool.hint);
    }

    /** The overlay (the view transform applied: image pixels). */
    draw(ctx) {
        const ed = this.ed;
        ctx.save();
        try { this.tool.tool.draw(this.doc, ctx, { scale: ed.view.scale, dpr: window.devicePixelRatio || 1, angle: ed.view.angle || 0, active: ed.tool === "boxes" }); }
        catch (err) { console.warn("Inpaint Canvas: the Boxes overlay failed", err); }
        finally { ctx.restore(); }
    }

    /**
     * The picture changed its geometry (a crop, an extension, a resize, a turn, a straighten): every box follows `A`,
     * written as new objects without a step of its own (the operation's step holds the old ones, an undo restores them
     * and never maps back).
     */
    mapGeometry(A) {
        const boxes = this.list();
        if (!boxes.length || !Array.isArray(A)) return;
        this.ed.pluginData.boxes = { version: 1, boxes: mapBoxes(boxes, A) };
    }

    // ---- the panel -----------------------------------------------------------------------------------------------------

    panelShown() {
        const p = this.panel;
        if (!p || !p.box.isConnected) return false;
        const details = p.box.closest("details");
        return (!details || details.open) && p.box.getClientRects().length > 0;
    }

    highlight() {
        const p = this.panel;
        if (!p) return;
        const id = this.tool.selected(this.doc);
        for (const row of p.list.querySelectorAll(".ipc-bx-row")) row.classList.toggle("ipc-bx-sel", row.dataset.box === id);
    }

    /** The Boxes section in the Generate pane. */
    buildPanel() {
        const ed = this.ed;
        if (!ed.addSection || this.panel) return;
        const d = ed.addSection("Boxes", false, (box) => {
            box.appendChild(el("div", "ipc-bx-help", NODE_HELP));
            const note = el("div", "ipc-bx-note", "");
            box.appendChild(note);
            const warn = el("div", "ipc-bx-warn");
            box.appendChild(warn);
            const list = el("div", "ipc-bx-list");
            box.appendChild(list);
            const buttons = el("div", "ipc-bx-buttons");
            const button = (label, title, fn) => {
                const b = el("button", "ipc-ib", label);
                b.type = "button";
                b.title = title;
                b.addEventListener("click", (e) => { e.stopPropagation(); this.run(fn); });
                buttons.appendChild(b);
            };
            button("Selection to box", "The selection's bounds as a New box with the prompt as its description", () => { const b = this.fromSelection(); ed.setStatus(`Box ${b.id} added.${this.takeSwitchNote()}`); });
            button("Clear", "Remove every box (Ctrl+Z brings them back)", () => { const n = this.clear(); ed.setStatus(n ? `${n} box${n === 1 ? "" : "es"} removed (Ctrl+Z brings them back).` : "No boxes."); });
            button("Copy rows", "The boxes as FLUX 3's rows, measured against the whole picture, to the clipboard (a run measures them in the crop it sends)", () => this.copyRows());
            box.appendChild(buttons);
            this.panel = { box, list, warn, note, key: null, warnKey: null, pending: false };
            list.addEventListener("focusout", () => { if (this.panel.pending) setTimeout(() => { if (!list.contains(document.activeElement)) this.refresh(); }, 0); });
        }, "gen");
        // the overlay shows while the section is open: opening or closing it repaints the canvas
        if (d) d.addEventListener("toggle", () => ed.draw());
        this.refresh(true);
    }

    /** Run a change from the panel, the error as a warn line. */
    run(fn) {
        try { fn(); } catch (err) { this.ed.setStatus(String((err && err.message) || err), "warn"); this.refresh(true); }
    }

    /** Everything that shows the boxes follows the data: the panel (rebuilt only when it says something else), the switch's row. */
    refresh(force = false) {
        const ed = this.ed;
        if (ed.syncBoxesRow) ed.syncBoxesRow();
        const p = this.panel;
        if (!p) return;
        const boxes = this.list();
        const on = !!(ed.genSettings && ed.genSettings.boxes);
        const crop = on && ed.base ? this.cropFrame() : null;
        const chk = crop ? cropCheck(boxes, crop, ed.getBounds()) : null;
        p.note.textContent = !on ? "Not sent: the Boxes switch under the prompt is off. The boxes stay with the workflow."
            : boxes.length ? `box_prompt carries these boxes with every run.${crop ? ` The crop is ${crop.w} x ${crop.h} px at ${crop.x}, ${crop.y} (the frame the Boxes tool shows).` : ""}`
            : "box_prompt carries the selection as one box while there are none (the Boxes switch is on).";
        const lines = warningLines(chk, on ? bareOf(boxes) : []);
        const wk = JSON.stringify(lines);
        if (wk !== p.warnKey) {
            p.warnKey = wk;
            p.warn.innerHTML = "";
            for (const [text, paste] of lines) {
                const row = el("div", "ipc-bx-warn-row", text);
                if (paste) {
                    const b = el("button", "ipc-ib", "Paste the whole crop");
                    b.type = "button";
                    b.title = "Crop > Paste on whole crop: the result of the whole crop is pasted back, so a box outside the selection keeps its change";
                    b.addEventListener("click", (e) => { e.stopPropagation(); ed.cropSettings.paste = "crop"; if (ed.syncCropControls) ed.syncCropControls(); ed.notifyChanged(); ed.setStatus("Paste is now the whole crop (Generate pane, Crop > Paste): the boxes outside the selection keep their result."); });
                    row.appendChild(b);
                }
                p.warn.appendChild(row);
            }
        }
        const refs = ed.referenceLayers ? ed.referenceLayers() : [];
        const key = JSON.stringify([boxes, refs.map((l) => [l.id, l.name])]);
        if (!force && key === p.key) return;
        // a field being edited is not rebuilt under the cursor: the next change after it blurs does it
        if (!force && p.list.contains(document.activeElement)) { p.pending = true; return; }
        p.key = key;
        p.pending = false;
        this.renderRows(boxes, refs);
    }

    renderRows(boxes, refs) {
        const ed = this.ed, list = this.panel.list;
        list.innerHTML = "";
        if (!boxes.length) { list.appendChild(el("div", "ipc-bx-empty", ed.base ? "No boxes yet. Draw one with the Boxes tool (X), or Selection to box takes the selection." : "Load an image first.")); return; }
        const field = (cls, value, title, onChange) => {
            const inp = document.createElement("input");
            inp.type = "text"; inp.className = `ipc-bx-field ${cls}`; inp.value = value == null ? "" : value; inp.title = title; inp.spellcheck = false;
            inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
            inp.addEventListener("change", () => onChange(inp.value));
            return inp;
        };
        const select = (options, value, title, onChange) => {
            const sel = document.createElement("select");
            sel.className = "ipc-sel ipc-bx-select"; sel.title = title;
            for (const [id, label] of options) { const o = document.createElement("option"); o.value = id; o.textContent = label; sel.appendChild(o); }
            sel.value = value;
            sel.addEventListener("keydown", (e) => e.stopPropagation());
            sel.addEventListener("change", () => onChange(sel.value));
            return sel;
        };
        const change = (id, patch) => this.run(() => this.set(id, patch));
        for (const b of boxes) {
            const row = el("div", "ipc-bx-row");
            row.dataset.box = b.id;
            row.style.borderLeftColor = colourOf(b, boxes);
            row.addEventListener("pointerdown", (e) => { if (!e.target.closest("input, select, button")) { this.tool.select(this.doc, b.id); this.highlight(); } });
            const head = el("div", "ipc-bx-head");
            head.appendChild(field("ipc-bx-id", b.id, "The element's name in the prompt: lowercase words and a number joined by underscores (knight_1, red_scarf_2)", (v) => change(b.id, { id: v })));
            head.appendChild(select(Object.entries(KIND_LABELS), b.text != null ? "text" : b.kind, "What the box does", (v) => {
                if (v === "text") change(b.id, { kind: "new", text: b.text || "" });
                else if (v === "from") {
                    if (!refs.length) { ed.setStatus("Add a reference layer first (a layer with the role reference, shown).", "warn"); this.refresh(true); return; }
                    change(b.id, { kind: "from", layer: b.layer && refs.some((l) => l.id === b.layer) ? b.layer : refs[0].id, text: null });
                } else change(b.id, { kind: v, text: null, ...(v !== "new" && b.kind === "new" ? { src: b.rect } : {}) });
            }));
            const del = el("button", "ipc-ib", "x");
            del.type = "button";
            del.title = "Remove this box";
            del.addEventListener("click", (e) => { e.stopPropagation(); this.run(() => this.remove(b.id)); });
            head.appendChild(del);
            row.appendChild(head);
            if (b.text != null) row.appendChild(field("ipc-bx-text", b.text, "The words rendered in the box", (v) => change(b.id, { text: v })));
            const desc = field("ipc-bx-desc", b.desc, b.text != null ? "Style and colour of the text (optional)" : `What it is (at most ${DESC_MAX} characters); a box still called box_1 takes its name from it`, (v) => change(b.id, { desc: v }));
            desc.placeholder = b.text != null ? "style of the text (optional)" : b.kind === "new" ? "what goes in the box" : b.kind === "from" ? "what to take from the reference (optional)" : "what it is";
            row.appendChild(desc);
            if (b.kind === "from") {
                const g = el("div", "ipc-bx-geo");
                g.appendChild(el("span", "ipc-bx-label", "Layer"));
                const opts = refs.map((l, i) => [l.id, `ref ${i + 1}: ${l.name}`]);
                if (!refs.some((l) => l.id === b.layer)) opts.unshift([b.layer, "(not a shown reference)"]);
                g.appendChild(select(opts, b.layer, "The reference layer placed in the box (shown reference layers)", (v) => change(b.id, { layer: v })));
                row.appendChild(g);
            }
            list.appendChild(row);
        }
        this.highlight();
    }
}
