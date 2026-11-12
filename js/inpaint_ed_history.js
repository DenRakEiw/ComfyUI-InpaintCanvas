// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_history.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// snapshots, undo / redo and the history step: moved out of inpaint_canvas.js (item 56 S8, docs/PLAN_SPLIT.md), text unchanged.

import { TEXT_DEFAULTS } from "./inpaint_text.js";
import { installLayerAliases } from "./inpaint_pixels.js";
import { TILE_SIZE, isTilePixels } from "./inpaint_tiles.js";
import { canvasToBlob } from "./inpaint_encode.js";
import { failKind } from "./inpaint_status.js";
import { LAYER_PENDING_KEYS, MAX_SNAPSHOTS, MAX_UNDO, MAX_UNDO_BYTES, SNAP_CANVAS_PX, UNDO_LABELS } from "./inpaint_consts.js";
import { fileGone, needImage, refKey, snapImage, tileDiffBox } from "./inpaint_load.js";

export class HistoryPart {
    // ---- undo ----------------------------------------------------------------

    /**
     * PNG of a canvas as a blob URL, encoded off the main thread; undo steps hold the promise. The
     * canvas is a `toCanvas()` view that the edit writes into next, so it is encoded as a snapshot.
     */
    snapUrl(canvas) {
        const p = canvasToBlob(canvas, { snapshot: true }).then((blob) => URL.createObjectURL(blob));
        p.catch(() => null);
        return p;
    }

    /**
     * A copy of the pixels of `layer` inside `rect` (in the target's own pixels): the undo
     * step of a brush stroke, so a stroke on a 100 MP layer costs what it covered. The step
     * holds the copy as pixels (`px`) and goes back with a "copy" blit.
     */
    snapshotRect(layer, rect, mask = false, exact = false) {
        const target = mask ? layer.maskPx : layer.px;
        if (!target) return null;
        let x, y, x1, y1;
        if (exact) {
            // the box of a step being undone or redone, taken again as it is: a margin added per round trip grew the redo
            // copy by 6 px each time, and on tiles by a whole tile
            x = rect.x; y = rect.y; x1 = rect.x + rect.w; y1 = rect.y + rect.h;
        } else {
            x = Math.max(0, Math.floor(rect.x) - 2); y = Math.max(0, Math.floor(rect.y) - 2);
            x1 = Math.min(target.width, Math.ceil(rect.x + rect.w) + 4); y1 = Math.min(target.height, Math.ceil(rect.y + rect.h) + 4);
            // C4: on tiles the box grows to the whole tiles it touches. `copyRect` shares a tile only when the copy starts on a
            // tile's corner, so a box at floor(x) - 2 copied every tile it overlapped into a new one; over whole tiles the step
            // shares them, and the stroke's own write is what copies the tiles it touches (the originals stay the step's)
            if (isTilePixels(target)) {
                x = x - (x % TILE_SIZE); y = y - (y % TILE_SIZE);
                x1 = Math.min(target.width, Math.ceil(x1 / TILE_SIZE) * TILE_SIZE); y1 = Math.min(target.height, Math.ceil(y1 / TILE_SIZE) * TILE_SIZE);
            }
        }
        const w = x1 - x, h = y1 - y;
        if (w <= 0 || h <= 0) return null;
        const copy = target.copyRect([x, y, x1, y1]);
        return { kind: "layerrect", id: layer.id, mask, x, y, w, h, px: copy, bytes: w * h * 4 };
    }

    /**
     * A layer-pixels step of several rectangles (a content-aware move's old and new place, PLAN_0_1_31 §5 step 4b): a
     * `layerrect` whose `parts` are `snapshotRect`s, each put back by its own blit (both are copies from before the edit,
     * so their order does not matter where they overlap); x y w h are the box around them. Null when none holds pixels.
     */
    snapshotRects(layer, rects, exact = false) {
        const parts = rects.map((r) => this.snapshotRect(layer, r, false, exact)).filter(Boolean);
        if (!parts.length) return null;
        const x = Math.min(...parts.map((s) => s.x)), y = Math.min(...parts.map((s) => s.y));
        const x1 = Math.max(...parts.map((s) => s.x + s.w)), y1 = Math.max(...parts.map((s) => s.y + s.h));
        return { kind: "layerrect", id: layer.id, mask: false, x, y, w: x1 - x, h: y1 - y, parts, bytes: parts.reduce((n, s) => n + s.bytes, 0) };
    }

    /**
     * The undo step of a selection change: a copy of the selection inside its extent, the
     * way a brush stroke's step is a copy of the touched rectangle. A whole-canvas PNG
     * used to be encoded per step, which on a 15k document is 150 million pixels through
     * the worker for a marquee that covers a corner. Up to SNAP_CANVAS_PX the copy is
     * pixels (`px`, a GPU blit, counted against MAX_UNDO_BYTES); above it the extent is
     * encoded as a PNG off the main thread, like the old whole-canvas step. An empty
     * selection is a step without pixels.
     */
    snapshotSelection() {
        const ext = this.selectionExtent();
        const bounds = this.selectionDirty ? undefined : this.cachedBounds;
        if (!ext) return { kind: "selection", empty: true, bytes: 0, bounds: null };
        let [x, y, x1, y1] = ext;
        // C4: on tiles the whole tiles the extent touches, so the copy shares them (see snapshotRect)
        if (isTilePixels(this.sel)) {
            x -= x % TILE_SIZE; y -= y % TILE_SIZE;
            x1 = Math.min(this.width, Math.ceil(x1 / TILE_SIZE) * TILE_SIZE); y1 = Math.min(this.height, Math.ceil(y1 / TILE_SIZE) * TILE_SIZE);
        }
        const w = x1 - x, h = y1 - y;
        const copy = this.sel.copyRect([x, y, x1, y1]);   // the extent is on whole pixels inside the selection
        // on tiles the copy shares the selection's tiles and stays pixels at any size, counted like the PNG it
        // replaces (docs/PLAN_BCE.md §C2, the final review; C4 counts the tiles a step holds alone)
        if (w * h > SNAP_CANVAS_PX) return isTilePixels(copy) ? { kind: "selection", x, y, w, h, px: copy, bytes: 0, bounds } : { kind: "selection", x, y, w, h, url: this.snapUrl(copy.toCanvas()), bytes: 0, bounds };
        return { kind: "selection", x, y, w, h, px: copy, bytes: w * h * 4, bounds };
    }

    /** Widen the box a gesture has painted over (image coordinates). */
    strokeBounds(p, x0, y0, x1, y1, pad) {
        const nx0 = Math.min(x0, x1) - pad, ny0 = Math.min(y0, y1) - pad;
        const nx1 = Math.max(x0, x1) + pad, ny1 = Math.max(y0, y1) + pad;
        const b = p.bounds;
        p.bounds = b ? [Math.min(b[0], nx0), Math.min(b[1], ny0), Math.max(b[2], nx1), Math.max(b[3], ny1)] : [nx0, ny0, nx1, ny1];
    }

    /** The box a gesture painted over, in the target canvas's own pixels, or null for all of it. */
    strokeRect(p, target) {
        if (!target || !p.bounds) return null;
        if (p.rect && target === p.layer.px) return p.rect;   // frozen at the release of a heal that blended in a worker
        const layer = p.layer;
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const [x0, y0, x1, y1] = p.bounds;
        return [(x0 - layer.x) * sx, (y0 - layer.y) * sy, (x1 - layer.x) * sx, (y1 - layer.y) * sy];
    }

    /** The undo step for a finished stroke: the touched rectangle, or the whole layer. */
    strokeUndo(p, target) {
        const layer = p.layer;
        if (!target) return null;
        // a content-aware move's two places (layer pixels), each copied (`snapshotRects`)
        if (p.undoBoxes && target === layer.px) return this.snapshotRects(layer, p.undoBoxes.map((b) => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] })));
        const box = this.strokeRect(p, target);
        const rect = box ? { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] } : { x: 0, y: 0, w: target.width, h: target.height };
        return this.snapshotRect(layer, rect, p.kind === "maskpaint");
    }

    /** Free a discarded undo step: its blob URLs, its pixels copy and its share of the memory budget. */
    /**
     * Layers an undo took out of the document (replaced by the objects of a record) let go of an edit still in progress:
     * a text edit's or a colour match drag's "before" (on canvases a blob URL), which no record holds (LAYER_PENDING_KEYS).
     */
    releaseDroppedEdits(outgoing) {
        for (const l of outgoing || []) {
            if (!l || this.layers.includes(l)) continue;
            if (l._textUndo) { this.releaseSnapshot(l._textUndo); l._textUndo = null; }
            if (l._matchUndo) { this.releaseSnapshot(l._matchUndo); l._matchUndo = null; }
        }
    }

    releaseSnapshot(snap) {
        if (!snap) return;
        this.undoBytes -= snap.bytes || 0;
        for (const k of ["url", "mask", "selection"]) {
            const v = snap[k];
            if (!v || v === true) continue;   // a layerrect step's `mask` is a flag
            if (typeof v.then === "function") v.then((u) => { if (typeof u === "string" && u.startsWith("blob:")) URL.revokeObjectURL(u); }).catch(() => {});
            else if (typeof v === "string" && v.startsWith("blob:")) URL.revokeObjectURL(v);
        }
        // C4: the step's own copies let go of their tiles (a restore that put them into the document took them out of the
        // step first); a `layers` / `canvas` step's layers and base are the document's objects by reference, never released
        for (const k of ["px", "maskPx", "selPx"]) {
            const p = snap[k];
            if (p && typeof p.release === "function") p.release();
            snap[k] = null;
        }
        // a step of several rectangles (`snapshotRects`): each part's copy
        if (Array.isArray(snap.parts)) {
            for (const s of snap.parts) if (s && s.px && typeof s.px.release === "function") { s.px.release(); s.px = null; }
            snap.parts = null;
        }
        // a turn step holds one clone per layer (turnSnapshot); a restore took them out first
        if (Array.isArray(snap.pixels)) {
            for (const p of snap.pixels) {
                if (p && p.px && typeof p.px.release === "function") p.px.release();
                if (p && p.maskPx && typeof p.maskPx.release === "function") p.maskPx.release();
            }
            snap.pixels = null;
        }
    }

    /**
     * A layer as a `layers` / `canvas` step keeps it: the pixels by reference (they are replaced,
     * never written, by the operations those steps undo), and its own copies of what the text
     * and filter controls change in place (the text description, the filter parameters, colour
     * match, LUT, plate), copied as their own undo steps copy them. A shared object brought an
     * undone text size or slider value back when an older step was undone.
     */
    snapshotLayer(l) {
        const c = { ...l };
        for (const k of LAYER_PENDING_KEYS) delete c[k];
        if (l.text) c.text = JSON.parse(JSON.stringify(l.text));
        if (l.params && typeof l.params === "object") {
            c.params = { ...l.params };
            if (Array.isArray(l.params.lights)) {
                c.params.lights = JSON.parse(JSON.stringify(l.params.lights));
            }
        }
        // a preview still shown is not the layer's value: the record holds what was committed (an undo of it brings back
        // what was clicked, not what was hovered; its guard is not in the record to put it back later)
        const committed = this.committedFilter(l);
        if (committed) { c.params = committed.params; if (committed.name) c.name = committed.name; }
        for (const k of ["match", "lut", "plate"]) if (l[k] && typeof l[k] === "object") c[k] = { ...l[k] };
        return c;
    }

    /**
     * The whole document as one step (`{kind: "turn"}`), for the assistant's "Undo this turn"
     * (docs/PLAN_ASSISTANT.md §4 A7). It is a `canvas` step plus **a copy-on-write clone of every
     * layer's pixels and mask** - a canvas step keeps the layer objects by reference, which is
     * enough for an extend or a crop (they replace pixels, never write them), but a turn is a
     * row of edits that write into the layers the document still holds. The clones cost nothing
     * to take on tiles; on the canvas backend a full copy of every layer would be 600 MB at
     * 15,000 x 10,000, so there this answers **null** and the panel says so.
     *
     * It also holds what no undo step holds: the prompt, the negative prompt, the generation and
     * crop settings and the recipe's setting values, which `set_prompt`, `set_generation`,
     * `set_crop` and `set_settings` change and no step of the editor's own covers.
     */
    turnSnapshot() {
        if (!this.tileMode || !this.sel) return null;
        const pixels = [];
        const layers = this.layers.map((l) => {
            const record = this.snapshotLayer(l);
            pixels.push({ id: l.id, px: l.px ? l.px.clone() : null, maskPx: l.maskPx ? l.maskPx.clone() : null });
            // the restore takes the clones above; the record's own references to the live pixels and the layer's caches
            // would only keep what the document replaces later alive (a named snapshot lives as long as the user wants)
            record.px = null; record.maskPx = null;
            record._masked = null; record._maskedValid = false; record._mcache = null; record._fcache = null; record._fxCache = null;
            return record;
        });
        return {
            kind: "turn",
            base: this.base,
            width: this.width,
            height: this.height,
            selPx: this.sel.clone(),
            layers,
            groups: this.groupsCopy(),
            pixels,
            activeLayerId: this.activeLayerId,
            maps: this.maps ? { ...this.maps } : {},
            ...this.geometrySnapshot(),
            doc: {
                prompt: this.promptText,
                negative: this.negativeText,
                gen: JSON.parse(JSON.stringify(this.genSettings || {})),
                crop: JSON.parse(JSON.stringify(this.cropSettings || {})),
                settings: JSON.parse(JSON.stringify(this.settings || {})),
            },
        };
    }

    /**
     * Put a turn snapshot back and leave the way back on the undo stack: the present goes on as
     * one `turn` step, so Ctrl+Z takes the restore back and redo does it again, like any step.
     * The steps the turn itself pushed stay below it; nothing is collapsed.
     */
    restoreTurn(snap, { label } = {}) {
        if (!snap || snap.kind !== "turn" || !this.tileMode) return false;
        this.cancelPreviews();   // the present pushed below holds committed values, not a hover's (historyStepNow)
        const now = this.turnSnapshot();
        if (now) this.pushUndoSnapshot(now, { label });
        this.applySnapshot(snap);
        this.scheduleDetachedRelease();
        return true;
    }

    // ---- named snapshots (the Undo history section; tiles only, not saved with the document) ----------------------

    /**
     * Keep the whole document under a name: a turn snapshot (copy-on-write clones of every layer, its mask and the
     * selection, plus the prompt and the settings), so taking one costs nothing until the document is edited on. At
     * most MAX_SNAPSHOTS; the oldest goes first. Null on the canvas backend, which cannot clone for free.
     */
    takeSnapshot(name) {
        const snap = this.turnSnapshot();
        if (!snap) return null;
        // names are unique: the panel and the commands find a snapshot by its name
        let label = String(name || "").trim() || this.nextSnapshotName();
        if (this.findSnapshot(label)) { let n = 2; while (this.findSnapshot(`${label} (${n})`)) n++; label = `${label} (${n})`; }
        const entry = { name: label, at: Date.now(), snap };
        this.snapshots.push(entry);
        let dropped = null;
        while (this.snapshots.length > MAX_SNAPSHOTS) { dropped = this.snapshots.shift(); this.releaseSnapshot(dropped.snap); }
        if (dropped) this.setStatus(`Snapshot "${label}" taken; the oldest, "${dropped.name}", was dropped (${MAX_SNAPSHOTS} at most).`);
        else this.setStatus(`Snapshot "${label}" taken.`);
        this.historyChanged();
        return entry;
    }

    /** The first free "Snapshot N" (the panel offers it as the name). */
    nextSnapshotName() {
        let n = this.snapshots.length + 1;
        while (this.findSnapshot(`Snapshot ${n}`)) n++;
        return `Snapshot ${n}`;
    }

    /** A snapshot by its name or its index in `snapshots`. */
    findSnapshot(which) {
        if (typeof which === "number") return this.snapshots[which] || null;
        return this.snapshots.find((s) => s.name === which) || null;
    }

    /**
     * Put a snapshot back as one undo step (Ctrl+Z takes it back). The snapshot stays: what goes into the document
     * is a fresh copy of it, since a restore moves the pixels it is given into the layers.
     */
    restoreSnapshot(which) {
        const entry = this.findSnapshot(which);
        if (!entry) return false;
        if (!this.restoreTurn(this.copyTurn(entry.snap), { label: `Restore "${entry.name}"` })) return false;
        this.setStatus(`Snapshot "${entry.name}" restored. Ctrl+Z takes it back.`);
        return true;
    }

    deleteSnapshot(which) {
        const entry = this.findSnapshot(which);
        if (!entry) return false;
        this.snapshots.splice(this.snapshots.indexOf(entry), 1);
        this.releaseSnapshot(entry.snap);
        this.historyChanged();
        return true;
    }

    clearSnapshots() {
        for (const s of this.snapshots) this.releaseSnapshot(s.snap);
        this.snapshots = [];
        this.historyChanged();
    }

    /** A turn snapshot to hand to applySnapshot, leaving `snap` whole: new clones and new layer records. */
    copyTurn(snap) {
        return {
            ...snap,
            selPx: snap.selPx ? snap.selPx.clone() : null,
            layers: snap.layers.map((l) => this.snapshotLayer(l)),
            pixels: (snap.pixels || []).map((p) => ({ id: p.id, px: p.px ? p.px.clone() : null, maskPx: p.maskPx ? p.maskPx.clone() : null })),
            doc: JSON.parse(JSON.stringify(snap.doc || {})),
        };
    }

    /** The undo step a site asks for, with its label (the site's, else the kind's) and, taken back, its time. */
    snapshot(step) {
        const snap = this.snapshotOf(step);
        if (snap) {
            snap.label = step.label || UNDO_LABELS[snap.kind] || snap.kind;
            if (step.at) snap.at = step.at;
        }
        return snap;
    }

    snapshotOf(step) {
        if (step.kind === "layerrect") {
            const l = this.layers.find((x) => x.id === step.id);
            if (!l) return null;
            const snap = step.parts ? this.snapshotRects(l, step.parts, true) : this.snapshotRect(l, step, step.mask, true);
            // a liquify step's other side carries the field as it is (only a liquify step: another step's redo must not
            // bring a session back over pixels its field does not describe)
            if (snap && step.liq && this.liq && this.liq.sid === step.liq.sid && this.liq.layer === l) {
                snap.liq = { sid: this.liq.sid, cells: new Map(this.liq.field.cells) };
                snap.liqBytes = this.liquifyCellBytes(this.liq.field.cells, step.liq.cells, this.liq.field);
                snap.bytes += snap.liqBytes;
            }
            return snap;
        }
        if (step.kind === "selection") return this.snapshotSelection();
        if (step.kind === "turn") return this.turnSnapshot();
        // the plugins' per-document data alone (scumble.documents.data(doc).set(patch, { undo })): a plugin's own change
        // of what it keeps with the document, no pixels; a canvas or turn step carries the same copy beside its pixels
        if (step.kind === "data") return { kind: "data", pluginData: this.pluginDataCopy() };
        if (step.kind === "maps") {
            const prev = (this.maps && this.maps[step.map]) || null;
            const target = step.prev;
            let snapBytes = 0;
            if (prev) {
                if (!target || prev.data !== target.data) snapBytes += prev.data ? prev.data.byteLength : 0;
                if (!target || prev.guide !== target.guide) snapBytes += prev.guide ? prev.guide.byteLength : 0;
            }
            return { kind: "maps", map: step.map, prev, bytes: snapBytes };
        }
        if (step.kind === "layers") return { kind: "layers", layers: this.layers.map((l) => this.snapshotLayer(l)), groups: this.groupsCopy(), activeLayerId: this.activeLayerId };
        if (step.kind === "transforms") {
            // the places of several layers moved or scaled together (a multi-selection): one step, no pixels
            const ids = step.ids || step.items.map((i) => i.id);
            const items = ids.map((id) => this.layers.find((l) => l.id === id)).filter(Boolean).map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }));
            return items.length ? { kind: "transforms", items } : null;
        }
        // On tiles a whole-layer step (and the canvas step's selection) holds a copy-on-write clone of the pixels
        // instead of a PNG: a clone shares every tile, costs nothing to take or to restore, and never materialises
        // the pixels. The PNG took a full-size CPU canvas plus a bitmap for the worker per step, and on a
        // 20000 × 12000 document its encode failed under that load, so the flip it belonged to could not be
        // undone (C2's final review). No PNG is made on tiles; the clone counts no bytes, like the PNG it
        // replaces (C4 counts the tiles a step holds alone and adds release()).
        const tiles = this.tileMode;
        if (step.kind === "canvas") {
            // base, size, selection and the layer list (shallow copies: the canvases themselves are never mutated by extend / crop, only replaced)
            const sel = tiles ? { selPx: this.sel.clone() } : { selection: this.snapUrl(this.sel.toCanvas()) };
            return { kind: "canvas", base: this.base, width: this.width, height: this.height, ...sel, layers: this.layers.map((l) => this.snapshotLayer(l)), groups: this.groupsCopy(), activeLayerId: this.activeLayerId,
                ...this.geometrySnapshot() };
        }
        const layer = this.layers.find((l) => l.id === step.id);
        if (!layer) return null;
        // on canvases the whole-layer steps stay a PNG per step (docs/PLAN_BCE.md C1 rule 7); C4 makes them tile refs
        const pixelsOf = (p) => (tiles ? { px: p.clone() } : { url: this.snapUrl(p.toCanvas()) });
        const maskOf = (m) => (!m ? { mask: null } : tiles ? { maskPx: m.clone() } : { mask: this.snapUrl(m.toCanvas()) });
        if (step.kind === "layer") return { kind: "layer", id: layer.id, ...pixelsOf(layer.px) };
        if (step.kind === "transform") return { kind: "transform", id: layer.id, x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        if (step.kind === "mask") {
            const m = layer.maskPx;
            return { kind: "mask", id: layer.id, ...(!m ? { url: null } : tiles ? { maskPx: m.clone() } : { url: this.snapUrl(m.toCanvas()) }), mw: m ? m.width : 0, mh: m ? m.height : 0, maskOff: !!layer.maskOff };
        }
        if (step.kind === "match") return { kind: "match", id: layer.id, match: { ...(layer.match || { strength: 0, source: "surroundings" }) } };
        if (step.kind === "filter") {
            const p = { ...(layer.params || {}) };
            if (Array.isArray(p.lights)) p.lights = JSON.parse(JSON.stringify(p.lights));
            return { kind: "filter", id: layer.id, filter: layer.filter, params: p, lut: layer.lut ? { ...layer.lut } : null, lutData: layer._lutData || null, plate: layer.plate ? { ...layer.plate } : null, plateImg: layer._plateImg || null, name: layer.name, _selectedLightId: layer._selectedLightId || null, _deselected: !!layer._deselected };
        }
        if (step.kind === "text") return { kind: "text", id: layer.id, text: JSON.parse(JSON.stringify(layer.text || TEXT_DEFAULTS)), ...pixelsOf(layer.px), cw: layer.px.width, ch: layer.px.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
            behind: !!layer._textRendering };
        if (step.kind === "layerfull") return { kind: "layerfull", id: layer.id, ...pixelsOf(layer.px), cw: layer.px.width, ch: layer.px.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
            ...maskOf(layer.maskPx), mw: layer.maskPx ? layer.maskPx.width : 0, mh: layer.maskPx ? layer.maskPx.height : 0, maskOff: !!layer.maskOff };
        return null;
    }

    pushUndo(step) {
        if (!this.sel) return;   // no image loaded yet: nothing to undo
        this.pushUndoSnapshot(this.snapshot(step));
    }

    /**
     * `tracked`: the push of an operation an undo waits for (`trackEdit`) after its await. It is the
     * step that undo was pressed for, so it does not count as a change the waiting undo must stop at.
     */
    // `label`: what the Undo history calls the step (the edit it takes back); else the one the snapshot carries, else
    // its kind's
    pushUndoSnapshot(snap, { tracked = false, label, fromDebounce = false } = {}) {
        if (!snap) return;
        if (!fromDebounce) this.flushPendingDebounces();
        if (!tracked) this.historyGen++;
        if (label) snap.label = label;
        if (!snap.label) snap.label = UNDO_LABELS[snap.kind] || snap.kind;
        snap.at = Date.now();
        // the redo steps go first: the budget counts them, and trimming against it while they are
        // still counted threw away older undo steps that fit once the redo steps were gone
        for (const s of this.redo) this.releaseSnapshot(s);
        this.redo = [];
        this.undo.push(snap);
        this.undoBytes += snap.bytes || 0;
        this.trimUndo();
        this.scheduleDetachedRelease();
        this.historyChanged();
    }

    /** Drop the oldest steps past the depth (the instance's maxUndo / maxUndoBytes, which the app's settings set). */
    trimUndo() {
        const steps = Math.max(1, this.maxUndo || MAX_UNDO), bytes = this.maxUndoBytes || MAX_UNDO_BYTES;
        while (this.undo.length > steps || (this.undoBytes > bytes && this.undo.length > 1)) {
            this.releaseSnapshot(this.undo.shift());
            this.undoTrimmed = true;
        }
    }

    /** A new depth: applied at once (the oldest steps past it go), and to every step after. */
    setUndoDepth({ steps, bytes } = {}) {
        if (steps != null) this.maxUndo = Math.max(1, Math.round(+steps) || MAX_UNDO);
        if (bytes != null) this.maxUndoBytes = Math.max(1048576, Math.round(+bytes) || MAX_UNDO_BYTES);
        this.trimUndo();
        this.historyChanged();
    }

    /** The undo stacks changed: the Undo history section redraws once, after the current task. */
    historyChanged() {
        if (!this.renderUndoList || this._undoListQueued) return;
        this._undoListQueued = true;
        queueMicrotask(() => { this._undoListQueued = false; try { this.renderUndoList(); } catch (err) { console.warn("undo history", err); } });
    }

    /**
     * The history as rows, oldest first, the way Photoshop lists it: a state per row, named by the edit that led to it.
     * The first row is the oldest state kept ("Start", or "Oldest kept" once steps were dropped), then one row per undo
     * step (the state after that edit; the last of them is the present), then the redo steps (states after edits that
     * were taken back). `steps` is what `stepHistory` takes to get there: negative undoes, positive redoes.
     */
    undoList() {
        const rows = [{ label: this.undoTrimmed ? "Oldest kept" : "Start", at: null, steps: -this.undo.length }];
        this.undo.forEach((s, i) => rows.push({ label: s.label || UNDO_LABELS[s.kind] || s.kind, at: s.at || null, steps: i + 1 - this.undo.length }));
        for (let j = this.redo.length - 1; j >= 0; j--) {
            const s = this.redo[j];
            rows.push({ label: s.label || UNDO_LABELS[s.kind] || s.kind, at: s.at || null, steps: this.redo.length - j });
        }
        return rows.map((r) => ({ ...r, current: r.steps === 0, future: r.steps > 0 }));
    }

    /**
     * Undo (`n` < 0) or redo (`n` > 0) that many steps, one after the other through the history queue; stops early when
     * a step does not happen (a held stroke, an edit in between). Resolves with the steps taken.
     */
    async stepHistory(n) {
        this.flushPendingDebounces();
        const redo = n > 0;
        let done = 0;
        for (let i = 0; i < Math.abs(Math.round(n) || 0); i++) {
            const stack = () => (redo ? this.redo : this.undo);
            const before = stack().length;
            if (!before) break;
            await (redo ? this.redoStep() : this.undoStep());
            if (stack().length >= before) break;
            done++;
        }
        return done;
    }

    /**
     * After the current task: the display caches of pixels that left the document into a step (a removed,
     * merged or flattened layer, the old pixels of an extend or crop), and the atlas pages of pixels that left it
     * altogether (replaced by a flip, a turn, a new mask, a restore, a new base: C6 a). See releaseDetachedDisplays.
     * A microtask, because the operations push their step first and take the pixels out of the document after it.
     * Queued by every undo step, every undo / redo, every whole change of a layer or a mask (which is what a
     * replacement ends with), by setBase (a restore goes through it: its release runs at the restore's next
     * await, when the old layers are gone) and by the basePx getter when a new base image replaces the pixels.
     */
    scheduleDetachedRelease() {
        if (!this.tileMode || this._detachQueued) return;
        this._detachQueued = true;
        queueMicrotask(() => { this._detachQueued = false; this.releaseDetachedDisplays(); });
    }

    /**
     * On tiles: pixels an undo or redo step holds that the document does not (not a layer's, a mask's, the base's
     * or the selection's) give back their display mirror and thumbnail, with the pyramid levels, the screen's GPU
     * copy and the textures keyed on them. Nothing draws such pixels; their mirror stayed for as long as the step
     * lived, so a step held tiles plus a canvas as large as the layer, twice what the canvas backend holds, and
     * only a tab in the background ever let it go (C2's final review). An undo that brings them back makes the
     * mirror again on its first frame. Returns the bytes; 0 on canvases.
     */
    releaseDetachedDisplays() {
        if (!this.tileMode) return 0;
        const live = new Set([this._basePx, this.sel]);
        for (const l of this.layers) { live.add(l.px); live.add(l.maskPx); }
        const comp = this._compositor || null;
        let freed = 0;
        // C3: the compositor's atlas pages of pixels nothing draws any more. C6 (a): every record whose pixels the
        // document does not hold, not only the ones a step holds: pixels a flip, a new mask or an undo replaced are
        // in no step (the steps hold clones), and their pages stayed until they aged out
        if (comp) freed += comp.retainPixels(live);
        for (const p of this.heldPixels()) {
            if (live.has(p) || !isTilePixels(p)) continue;
            const m = p.displayCanvasIfMade();
            if (m) {
                const entry = this.pyramids.get(m);
                if (entry) {
                    if (comp) for (const c of [...entry.levels, entry.gpu]) if (c) comp.forget(c);
                    this.pyramids.delete(m);
                }
                if (comp) comp.forget(m);
            }
            if (m || p.thumbnailCanvasIfMade()) freed += p.releaseDisplay();
        }
        return freed;
    }

    /**
     * Drop the whole history: every step is released (its blob URLs revoked, its bytes taken off
     * the budget). A plain `undo = []` left the old document's bytes on the budget for good, so
     * the tab kept one undo step, and leaked the PNG blobs of its whole-layer steps.
     */
    clearUndo() {
        this.historyGen++;
        for (const s of this.undo) this.releaseSnapshot(s);
        for (const s of this.redo) this.releaseSnapshot(s);
        this.undo = [];
        this.redo = [];
        this.undoBytes = 0;
        this.undoTrimmed = false;
        this.historyChanged();
    }

    /**
     * Put a step back, synchronously: the images it carries (`url`, `mask`, the canvas step's
     * `selection`) were decoded by `loadSnapImages` before the step was taken off its stack, and
     * come in `images`. A restore that awaited its PNG wrote over whatever was edited meanwhile.
     */
    applySnapshot(snap, images = {}) {
        if (snap.kind === "layers") {
            if (this.pending) this.cancelPending();
            // a spread carries px / maskPx and not the non-enumerable aliases: installed again
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => installLayerAliases({ ...l, _maskedValid: false, _mcache: null, _fcache: null }, this.pixels));
            this.releaseDroppedEdits(outgoing);
            // the layers that come back keep their files and are not uploaded again: one whose file left the store meanwhile
            // (a clean-up, a file removed by hand) is uploaded from its pixels
            this.recheckRestoredFiles({ layers: this.layers, outgoing });
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            this.activeLayerId = this.layers.some((l) => l.id === snap.activeLayerId) ? snap.activeLayerId : null;
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.refsMutated();   // an undo or redo of a layers step: the prompt stays, its tokens follow the ids
            this.renderLayers(); this.renderHistory(); this.draw(); this.drawThumb(); this.notifyChanged();
            return;
        }
        if (snap.kind === "transforms") {
            for (const it of snap.items) {
                const l = this.layers.find((x) => x.id === it.id);
                if (l) Object.assign(l, { x: it.x, y: it.y, w: it.w, h: it.h });
            }
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.renderLayers(); this.renderHistory(); this.draw(); this.drawThumb(); this.notifyChanged();
            return;
        }
        if (snap.kind === "data") {
            this.pluginData = snap.pluginData ? JSON.parse(JSON.stringify(snap.pluginData)) : {};
            this.renderHistory(); this.draw(); this.notifyChanged();   // the plugins hear "changed" and redraw their overlays
            return;
        }
        if (snap.kind === "maps") {
            const kind = snap.map;
            if (!this.maps) this.maps = {};
            if (snap.prev) {
                this.maps[kind] = snap.prev;
            } else {
                delete this.maps[kind];
            }
            this.mapsVersion++;
            for (const l of this.layers) {
                if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                    this.markFilterChanged(l);
                }
            }
            this.renderHistory(); this.draw(); this.notifyChanged();
            return;
        }
        if (snap.kind === "turn") {
            if (this.pending) this.cancelPending();
            if (this.textEdit) this.endTextEdit(false);
            const byId = new Map((snap.pixels || []).map((p) => [p.id, p]));
            const resized = snap.width !== this.width || snap.height !== this.height;
            this.restoreGeometry(snap);
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            if (snap.base !== this.base) this.recheckRestoredFiles({ base: snap.base });   // the layers below are all uploaded again
            this.base = snap.base;
            this.width = snap.width;
            this.height = snap.height;
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => {
                const kept = byId.get(l.id);
                const copy = installLayerAliases({ ...l, dirty: true, exportRef: null, _maskedValid: false, _mcache: null, _fcache: null, _fxCache: null }, this.pixels);
                // the clones move into the document; the step must not hand them out twice
                if (kept) {
                    if (kept.px) { copy.px = kept.px; kept.px = null; }
                    if (kept.maskPx) { copy.maskPx = kept.maskPx; kept.maskPx = null; copy.maskDirty = true; }
                }
                return copy;
            });
            this.releaseDroppedEdits(outgoing);
            snap.pixels = null;
            this.activeLayerId = this.layers.some((l) => l.id === snap.activeLayerId) ? snap.activeLayerId : null;
            const sel = snap.selPx || this.pixels.Mask.empty(this.width, this.height);
            snap.selPx = null;
            this.sel = sel;
            this.touchSource(sel);
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            if (resized) this.fitView();   // a snapshot from before a quarter turn or a crop
            this.renderSelectionList();
            // what no undo step holds: the fields set_prompt, set_generation, set_crop and
            // set_settings change; put back the way setValue puts them back
            const doc = snap.doc || {};
            if (doc.prompt !== undefined) this.setPromptText(doc.prompt, { history: "reset" });
            if (doc.negative !== undefined) this.setNegativeText(doc.negative);
            // the prompt came back with its layers: only what the snapshot does not hold is remapped
            this.refsRebuilt({ carry: true });
            // the mode stays: the recipe (the app) or the chain picked (the node) decides it, not a snapshot
            if (doc.gen) this.genSettings = { ...JSON.parse(JSON.stringify(doc.gen)), mode: this.genSettings.mode };
            if (doc.crop) { this.cropSettings = JSON.parse(JSON.stringify(doc.crop)); this.syncCropControls(); }
            if (doc.settings) this.settings = JSON.parse(JSON.stringify(doc.settings));
            this.syncGenControls();
            this.maps = snap.maps ? { ...snap.maps } : {};
            this.mapsVersion++;
            this.renderSettings();
            this.renderLayers();
            this.renderInfo();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            // the assistant's own restore hands a snapshot without a label; an undo or redo of a restore step is said by
            // historyStepNow
            if (!snap.label) this.setStatus("The assistant's turn was taken back.");
            return;
        }
        if (snap.kind === "canvas") {
            if (this.pending) this.cancelPending();
            // the selection was decoded before anything is put back: a frame drawn while it decoded
            // saw a new, empty selection, cached its display levels under the version the restored
            // one kept, and the restored selection's bounds came back empty
            const selImg = images.selection || null;   // null: its encode failed, an empty selection
            this.restoreGeometry(snap);
            this.groups = (snap.groups || []).map((g) => ({ ...g }));
            // the base comes back with its file and is not uploaded again (the layers below are, all of them)
            if (snap.base !== this.base) this.recheckRestoredFiles({ base: snap.base });
            this.base = snap.base;
            this.width = snap.width;
            this.height = snap.height;
            const outgoing = this.layers;
            this.layers = snap.layers.map((l) => installLayerAliases({ ...l, dirty: true, exportRef: null, _maskedValid: false, _mcache: null, _fxCache: null, maskDirty: !!l.maskPx }, this.pixels));
            this.releaseDroppedEdits(outgoing);
            this.activeLayerId = snap.activeLayerId;
            let sel = snap.selPx || null;   // on tiles the step's clone, taken out of the step (it is released after this)
            snap.selPx = null;
            if (!sel) {
                sel = this.pixels.Mask.empty(this.width, this.height);
                if (selImg) sel.drawInto(null, (ctx) => ctx.drawImage(selImg, 0, 0));
            }
            this.sel = sel;
            this.touchSource(sel);
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            if (this.extendInputs) for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.refsMutated();
            this.renderLayers();
            this.renderHistory();
            this.renderSelectionList();
            this.renderInfo();
            this.fitView();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus(`Canvas is ${this.width} × ${this.height} again.`);
            return;
        }
        if (snap.kind === "selection") {
            // the copy goes back where it was taken from; what was selected outside it since is
            // cleared. The display levels are refreshed inside the union of both rectangles, so
            // an undo costs the selection's extent and not a rebuild of the levels of a 15k canvas.
            const old = this.selectionExtent();
            if (snap.px) {
                this.sel.clear();
                this.sel.blit(snap.px, snap.x, snap.y, "copy");
            } else {
                const img = snap.empty ? null : needImage(images.url);
                const W = this.width, H = this.height;
                this.sel.drawInto(null, (sctx) => {
                    sctx.clearRect(0, 0, W, H);
                    if (img) sctx.drawImage(img, snap.x, snap.y);
                });
            }
            const now = snap.empty ? null : [snap.x, snap.y, snap.x + snap.w, snap.y + snap.h];
            const rect = old && now ? [Math.min(old[0], now[0]), Math.min(old[1], now[1]), Math.max(old[2], now[2]), Math.max(old[3], now[3])] : (old || now || [0, 0, 1, 1]);
            this.markSelectionChanged(snap.bounds, rect);
        } else {
            const layer = this.layers.find((l) => l.id === snap.id);
            if (!layer) return;
            if (snap.kind === "layer") {
                const pixels = layer.px, W = pixels.width, H = pixels.height;
                if (snap.px) {
                    // tiles: in place, as a "copy" of the step's clone, which shares its tiles back; a tile the
                    // step shares with the layer is left alone (its display mirror syncs only what changed), and
                    // the display levels are refreshed over the tiles that differ, not rebuilt from the whole mirror
                    const same = snap.px.width === W && snap.px.height === H;
                    const box = same ? tileDiffBox(pixels, snap.px) : null;
                    if (!same) pixels.clear();
                    pixels.blit(snap.px, 0, 0, "copy");
                    if (same) {
                        if (box) this.markLayerChanged(layer, box);
                    } else this.markLayerChanged(layer);
                } else {
                    const img = needImage(images.url);
                    // in place, from a fresh context: 0.1.11 drew with whatever a flip, a turn or a merge
                    // had left on the layer's context, and put a flipped layer back mirrored (rule 11)
                    pixels.drawInto(null, (ctx) => {
                        ctx.clearRect(0, 0, W, H);
                        ctx.drawImage(img, 0, 0);
                    });
                    this.markLayerChanged(layer);
                }
            } else if (snap.kind === "transform") {
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers();
                this.drawThumb();
                this.notifyChanged();
            } else if (snap.kind === "match") {
                layer.match = { ...snap.match };
                this.markMatchChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "filter") {
                layer.filter = snap.filter;
                layer.params = { ...(snap.params || {}) };
                if (Array.isArray(snap.params?.lights)) {
                    layer.params.lights = JSON.parse(JSON.stringify(snap.params.lights));
                }
                if (snap._selectedLightId !== undefined) {
                    layer._selectedLightId = snap._selectedLightId;
                    // Escape's "no light" belongs to the selection the step recorded; a step taken before any light was
                    // picked (id null, no flag) stays "the first light", not "none" (docs/PLAN_RELIGHT_FIXES.md F4)
                    layer._deselected = !!snap._deselected;
                } else if (layer._selectedLightId && (!layer.params.lights || !layer.params.lights.some((x) => x && x.id === layer._selectedLightId))) {
                    layer._selectedLightId = layer.params.lights && layer.params.lights[0] ? layer.params.lights[0].id : null;
                }
                layer.lut = snap.lut ? { ...snap.lut } : null;
                layer._lutData = snap.lutData || null;
                layer.plate = snap.plate ? { ...snap.plate } : null;
                layer._plateImg = snap.plateImg || null;
                layer.name = snap.name || layer.name;
                this.markFilterChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "mask") {
                layer.maskPx = snap.maskPx || (snap.url ? this.pixels.Mask.fromImage(needImage(images.url), snap.mw, snap.mh) : null);
                snap.maskPx = null;   // the document's now, not the step's to release (C4)
                layer.maskOff = !!(snap.maskOff && layer.maskPx);
                if (!layer.maskPx) layer.maskEdit = false;
                this.markMaskChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "text") {
                // a render still waiting for its font is dropped: it would put the pixels of the
                // description that is being undone on top of the restored one
                layer._textToken = (layer._textToken || 0) + 1;
                layer._textRendering = 0;
                layer.px = snap.px || this.pixels.Layer.fromImage(needImage(images.url), snap.cw, snap.ch);   // replaced: rule 2
                snap.px = null;   // the document's now (C4)
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                layer.text = JSON.parse(JSON.stringify(snap.text));
                layer._maskedValid = false;
                this.markLayerChanged(layer);
                this.renderLayers();
                // taken while a render was on its way (a redo copy of an edit not drawn yet): the
                // pixels are older than the description, so they are drawn from it again
                if (snap.behind) this.renderTextLayer(layer);
            } else if (snap.kind === "layerrect") {
                const target = snap.mask ? layer.maskPx : layer.px;
                // the touched rectangles are known: the display levels are refreshed there instead
                // of being rebuilt, which on a 15k layer cost the next frame 400 ms
                for (const s of snap.parts || [snap]) {
                    if (target && s.px) target.blit(s.px, s.x, s.y, "copy");
                    const rect = [s.x, s.y, s.x + s.w, s.y + s.h];
                    if (snap.mask) this.markMaskChanged(layer, rect); else this.markLayerChanged(layer, rect);
                }
                if (snap.liq) this.liquifyRestored(layer, snap);
                this.refreshLayerThumb(layer);   // nothing else in the list changed
            } else if (snap.kind === "layerfull") {
                layer.px = snap.px || this.pixels.Layer.fromImage(needImage(images.url), snap.cw, snap.ch);   // replaced: rule 2
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                layer.maskPx = snap.maskPx || (snap.mask ? this.pixels.Mask.fromImage(needImage(images.mask), snap.mw, snap.mh) : null);
                snap.px = null; snap.maskPx = null;   // the document's now (C4)
                layer.maskOff = !!(snap.maskOff && layer.maskPx);
                if (!layer.maskPx) layer.maskEdit = false;
                layer.maskDirty = !!layer.maskPx;
                layer._maskedValid = false;
                layer.exportRef = null;
                this.markLayerChanged(layer);
                this.renderLayers();
            }
        }
        this.draw();
    }

    /**
     * After an undo or redo that put back layers (`layers`: the layers step's, against the `outgoing` ones it replaced) or a
     * base (`base`: a canvas or turn step's) with the files they had: those steps upload nothing again, so a file that left
     * the store since (Settings › Local files › Clean up, a file removed by hand) would be named by the next save and the
     * next start and found by neither. Each file not named by what the document held a moment ago is asked for (a HEAD
     * request, after this task), and one that is gone is uploaded again from the pixels the document holds: a layer is
     * marked for the next syncLayers (started at once), the base is uploaded here. `heldEdit()` waits for it, so a
     * document save does not name the old file. Clean up keeps what the steps hold (heldFileRefs); this is the backstop.
     */
    recheckRestoredFiles({ layers = null, outgoing = [], base = null } = {}) {
        const items = [];
        if (layers) {
            // a file the replaced layers named and had stored (clean): a dirty one's upload was still to come (a canvas or
            // turn undo marks every layer so), and it goes with the layer the step replaces
            const held = new Set();
            for (const l of outgoing || []) {
                if (l && l.ref && !l.dirty) held.add(refKey(l.ref));
                if (l && l.maskRef && !l.maskDirty) held.add(refKey(l.maskRef));
            }
            for (const l of layers) {
                if (!l) continue;
                if (l.px && l.ref && !l.dirty && !held.has(refKey(l.ref))) items.push({ layer: l, key: "ref", ref: l.ref });
                if (l.maskPx && l.maskRef && !l.maskDirty && !held.has(refKey(l.maskRef))) items.push({ layer: l, key: "maskRef", ref: l.maskRef });
            }
        }
        if (base && base.ref && base.px) items.push({ base, ref: base.ref });
        if (!items.length) return;
        const run = (this._fileCheck || Promise.resolve())
            .then(() => this.runFileChecks(items))
            .catch((err) => console.warn("Inpaint Canvas: a restored file could not be stored again", err));
        this._fileCheck = run;
        run.then(() => { if (this._fileCheck === run) this._fileCheck = null; });
    }

    /** recheckRestoredFiles' requests and uploads, one item after the other; an item changed meanwhile is left alone. */
    async runFileChecks(items) {
        let layers = false, base = false;
        // not the document's any more (another undo, a delete): the step that holds it checks again when it comes back
        const live = (it) => (it.layer ? this.layers.includes(it.layer) && it.layer[it.key] === it.ref : this.base === it.base && it.base.ref === it.ref);
        for (const it of items) {
            if (this._destroyed) return;
            if (!live(it)) continue;
            if (!(await fileGone(it.ref))) continue;
            if (this._destroyed || !live(it)) continue;
            if (it.layer) {
                // an edit since marked it already, or the next syncLayers uploads it (the PNG's hash names the file)
                if (it.key === "ref") it.layer.dirty = true; else it.layer.maskDirty = true;
                layers = true;
                console.warn("Inpaint Canvas: a restored layer's file was gone; it is stored again", it.ref.filename);
            } else {
                const { ref } = await this.uploadBase(it.base.px);
                // every step that holds this base names the new file with it (the base is never written, only replaced)
                if (it.base.ref === it.ref) { it.base.ref = ref; base = true; }
                // a run or a helper meanwhile took the base itself as its picture (no layer shown): not the gone file again
                const up = this.uploaded;
                if (up && up.baseRef && refKey(up.baseRef) === refKey(it.ref)) { up.baseRef = null; up.baseHash = null; }
                console.warn("Inpaint Canvas: the restored base's file was gone; it is stored again as", ref && ref.filename);
            }
        }
        if (this._destroyed || !(layers || base)) return;
        if (layers) await this.syncLayers();
        else this.notifyChanged();   // syncLayers ends with it
    }

    /**
     * Undo and redo run one after the other. A restore needs a PNG decode, and a second Ctrl+Z
     * (key repeat, a double click) used to take its redo copy before the first restore had
     * landed, and the decodes could land out of order: the pixels ended half undone and the redo
     * stack wrong. An operation that pushed its step and writes after an await (grow, feather,
     * invert in the worker; extend, crop, resize, merge into the base and flatten, which push
     * after their upload) is waited for first, so the undo takes back what it wrote.
     *
     * The step's images are decoded while it is still on its stack; then it is taken off, its redo
     * copy made and the restore applied in one synchronous run. An edit made while the step decoded
     * (a stroke, a marquee, a layer added, a new image: anything that moves `historyGen`) stops the
     * undo with a status line instead: it used to land first and be overwritten by the restore, or
     * be the step that was undone in place of the one Ctrl+Z was pressed for. An undo pressed while
     * a stroke or a drag is held is refused too: it took back the gesture's own step, pushed at
     * pointer down, and the finished gesture had none.
     */
    // `historyGen` is read when the key is pressed, not when the queued step runs: an edit made after
    // that stops it, and so a held Ctrl+Z that is still queued never takes back a stroke made meanwhile
    flushPendingDebounces() {
        if (this.layers) {
            for (const l of this.layers) {
                if (!l) continue;
                // the field is cleared on the layer that holds it, so a flush that returns early runs once, not on every push
                const nudge = l._flushNudge, wheel = l._flushWheel;
                if (typeof nudge === "function") { l._flushNudge = null; nudge(); }
                if (typeof wheel === "function") { l._flushWheel = null; wheel(); }
            }
        }
    }

    // a nudge or wheel burst still in its 300 ms window is a step before the key press: pushed first, then `gen` is read
    undoStep() { this.flushPendingDebounces(); this.closeFlyout(); const gen = this.historyGen; return this.queueHistory(() => this.historyStepNow(false, gen)); }

    redoStep() { this.flushPendingDebounces(); this.closeFlyout(); const gen = this.historyGen; return this.queueHistory(() => this.historyStepNow(true, gen)); }

    queueHistory(fn) {
        const prev = this._historyQueue;
        const run = prev ? prev.then(fn) : fn();   // idle: starts now, as before (nothing waits a tick)
        const settled = run.then(() => {}, () => {});
        this._historyQueue = settled;
        settled.then(() => { if (this._historyQueue === settled) this._historyQueue = null; });
        return run;
    }

    /** Keep `promise` (an edit that pushed its undo step and still writes) in front of the next undo / redo. */
    trackEdit(promise) {
        const edits = this._pendingEdits || (this._pendingEdits = new Set());
        const done = promise.then(() => {}, () => {});
        edits.add(done);
        done.then(() => edits.delete(done));
        return promise;
    }

    /** A stroke, a marquee, a move or another editing drag is held (panning and guides are not edits). */
    gestureHeld() {
        const p = this.pointer;
        return !!p && !["pan", "split", "guide"].includes(p.kind);
    }

    /** Decode the images a step carries, for `applySnapshot`. */
    async loadSnapImages(snap) {
        if (snap.kind === "canvas") {
            let selection = null;
            try { selection = await snapImage(snap.selection); } catch (_) { /* its encode failed: restored as an empty selection, as before */ }
            return { selection };
        }
        // `mask` is an image only on a "layerfull" step; on a "layerrect" step it is the flag of a mask stroke
        const maskSrc = snap.kind === "layerfull" ? snap.mask : null;
        const [url, mask] = await Promise.all([snap.url ? snapImage(snap.url) : null, maskSrc ? snapImage(maskSrc) : null]);
        return { url, mask };
    }

    async historyStepNow(redo, gen = this.historyGen) {
        const word = redo ? "redo" : "undo";
        const held = () => {
            if (!this.gestureHeld()) return false;
            this.setStatus(`Release the button first: an ${word} does not interrupt a stroke or a drag.`);
            return true;
        };
        // `gen` was taken before the wait: an edit made during it is not the step this undo was pressed for
        while (this._pendingEdits && this._pendingEdits.size) await Promise.all(Array.from(this._pendingEdits));
        if (held()) return;
        // a nudge or wheel burst begun before the key press was pushed by undoStep / redoStep before `gen` was read; one
        // begun during the wait is pushed now and, like any edit made then, stops this step (the gen check below).
        // Taking `gen` again here forgot every edit made while the wait ran, and an undo ran over them.
        this.flushPendingDebounces();
        // the stacks are looked up now, not when the step was queued: an edit or a new image replaces them
        const stack = () => (redo ? this.redo : this.undo);
        const snap = stack()[stack().length - 1];
        if (!snap) return;
        let images = {}, failed = null;
        // a layerrect step's `mask` is a flag (a mask stroke), not an image: loading it as one failed every
        // undo of a mask brush stroke with "could not load true" (c6bc6a6); on tiles a canvas step holds a
        // selection clone (`selPx`) and a whole-layer step pixels clones, neither of which is decoded
        if (snap.kind === "canvas" ? !snap.selPx : snap.kind !== "layerrect" && (snap.url || snap.mask)) {
            try { images = await this.loadSnapImages(snap); } catch (err) { failed = err; }
        }
        const now = stack();
        if (gen !== this.historyGen || now[now.length - 1] !== snap) {
            // a step an edit released (a new image, a redo after an edit) has nothing left to say
            if (now.includes(snap)) this.setStatus(`Nothing ${redo ? "redone" : "undone"}: the picture changed before the ${word} could run. Press ${redo ? "Ctrl+Shift+Z" : "Ctrl+Z"} again.`);
            return;
        }
        if (held()) return;
        // a step that changes the document's geometry (a crop, an extend, a resize, a turn, Generate new's picture) is
        // refused while a job would land in the geometry it was made for, as the crop, the resize and the turn are
        // themselves (turnBlocked): an upscale of the whole picture or a Realism Pass above 1× would otherwise land its
        // answer in a document of another size (release review 2026-10-05)
        if ((snap.kind === "canvas" || snap.kind === "turn") && this.turnBlocked()) {
            this.setStatus(`Nothing ${redo ? "redone" : "undone"}: a job still running on this document would land where the picture was. Press ${redo ? "Ctrl+Shift+Z" : "Ctrl+Z"} again when it is in.`);
            return;
        }
        if (this.pending) this.cancelPending();
        now.pop();
        if (failed) {
            // a step whose pixels could not be kept (its encode failed): said, not thrown at a key handler
            console.error(`Inpaint Canvas: ${word} step could not be restored`, failed);
            this.setStatus(`That ${word} step could not be restored: ${(failed && failed.message) || failed}`, failKind(failed));
            this.releaseSnapshot(snap);
            return;
        }
        // a preview still open is not the present (a plugin's hover over a stock, a slider not let go): its committed
        // values go back first, or the other stack's copy below keeps the preview and the redo applies it
        this.cancelPreviews();
        // the present, as the other stack's step: it keeps the step's label and time, so the list reads the same
        const current = this.snapshot(snap);
        if (current) { (redo ? this.undo : this.redo).push(current); this.undoBytes += current.bytes || 0; }
        try {
            this.applySnapshot(snap, images);
            if (snap.kind === "turn") this.setStatus(`${redo ? "Redone" : "Undone"}: ${snap.label || UNDO_LABELS.turn}.`);   // the whole document changed
        } catch (err) {
            console.error(`Inpaint Canvas: ${word} step could not be restored`, err);
            this.setStatus(`That ${word} step could not be restored: ${(err && err.message) || err}`, failKind(err));
        } finally {
            this.releaseSnapshot(snap);
            this.scheduleDetachedRelease();   // what the restore took out of the document is in the other stack now
            this.historyChanged();
        }
    }
}
