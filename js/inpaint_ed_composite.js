// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_composite.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the composite draw, groups, the layer stack walk, drawLayer, flatten and its bands: moved out of inpaint_canvas.js (item 56 S10, docs/PLAN_SPLIT.md), text unchanged.

import { CANVAS_MAX_PIXELS, TILE_SIZE, isTilePixels } from "./inpaint_tiles.js";
import { encodeBands, encodeRows, partsUsable } from "./inpaint_encode.js";
import { uploadBlob, uploadCanvas } from "./inpaint_upload.js";
import { EMULATED_BLENDS, canvasOp, seedOfLayer } from "./blend_modes.js";
import { failKind } from "./inpaint_status.js";
import { cpuDab, makeCanvas } from "./inpaint_consts.js";
import { drawMesh } from "./inpaint_mesh.js";
import { NO_PROGRAM } from "./inpaint_load.js";

let InpaintEditor = null;

export class CompositePart {
    /** The visible composite at image resolution, cached: eyedropper, clone, bucket and wand read it. */
    compositeCanvas(opts = {}) {
        const key = JSON.stringify(opts);
        const c = this.flatCache;
        if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        const canvas = this.flattenToCanvas(opts);
        this.flatCache = { version: this.compositeVersion, key, canvas };
        return canvas;
    }

    drawComposite(ctx, opts = {}) {
        if (!this.base) return;
        const skipFilters = !!opts.skipFilters;
        const below = opts.baseOnly ? [] : opts.upTo == null ? this.layers : this.layers.slice(0, Math.max(0, opts.upTo));
        const hasFilters = !opts.controlOnly && below.some((l) => this.shown(l) && ((!skipFilters && l.kind === "filter") || this.matchActive(l)));
        // In a region pass the target canvas is already the filter input: no full-size copy.
        if (this.viewPass || !hasFilters) { this.drawLayersInto(ctx, opts); return; }
        // Filters need the composite below them at image resolution: build it offscreen first.
        if (!this.flatCanvas || this.flatCanvas.width !== this.width || this.flatCanvas.height !== this.height) this.flatCanvas = makeCanvas(this.width, this.height);
        const fctx = this.flatCanvas.getContext("2d");
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.globalAlpha = 1;
        fctx.globalCompositeOperation = "source-over";
        fctx.clearRect(0, 0, this.width, this.height);
        this.drawLayersInto(fctx, opts);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.flatCanvas, 0, 0);
    }

    /** `upTo`: the composite of the layers below that index only (C6 c1: what a filter layer there takes as its input); `baseOnly`: the base alone (C6 c2f: the peek). */
    drawLayersInto(ctx, { forRun = false, controlOnly = false, upTo = null, baseOnly = false, skipFilters = false } = {}) {
        const skip = skipFilters;
        if (controlOnly) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, this.width, this.height);
        } else {
            const bs = this.basePx;
            const vp = this.viewPass;
            // C5: the base of a tile document draws the part the view shows from its own tiles, like
            // every other plain layer since C3 (d). It was the one source left on displaySource in a
            // region pass, and so the one that still made a whole-image mirror and a Skia pyramid
            // (572 MB and 188 MB at 15000 x 10000) as soon as a filter layer put the pass on Canvas 2D.
            if (bs && vp && isTilePixels(bs)) this.drawTilesInto(ctx, bs, 0, 0, this.width, this.height, vp);
            else if (bs) ctx.drawImage(this.displaySource(bs, vp ? vp.sx : 1, !!(vp && vp.screen)), 0, 0, this.width, this.height);
        }
        let chain = null;   // filter layers that follow each other keep the composite on the GPU
        const end = baseOnly ? 0 : upTo == null ? this.layers.length : Math.max(0, Math.min(this.layers.length, upTo));
        // clipping (PLAN_0_1_31 §6 step 3): a clipped layer is drawn only when this pass drew its base, through the base's
        // coverage, made once per base for the layers clipped to it
        const drawn = new Set();
        let cov = null;
        const coverage = (b) => { if (!cov || cov.base !== b) cov = { base: b, canvas: this.clipCoverage(ctx, b) }; return cov.canvas; };
        this._walkDepth = (this._walkDepth || 0) + 1;
        try {
            for (let i = 0; i < end; i++) {
                const layer = this.layers[i];
                if (this.compareShow && layer.kind === "result" && layer.id !== this.compareShow) continue;
                if ((!this.shown(layer) && !(this.compareShow && layer.id === this.compareShow)) || !layer.px) continue;
                const cb = controlOnly ? null : this.clipBaseOf(layer, i);
                if (cb && !drawn.has(cb)) continue;
                if (skip && layer.clip) {
                    const target = controlOnly ? null : this.clipTargetOf(layer, i);
                    if (target && target.kind === "filter" && !drawn.has(target)) continue;
                }
                if (layer.kind === "filter") {
                    if (!controlOnly && !skip) { chain = this.applyFilterLayer(ctx, layer, i, forRun, chain, this.nextIsFilterLayer(i, forRun, end), cb ? () => coverage(cb) : null); drawn.add(layer); }
                    continue;
                }
                const ctrl = this.isControl(layer);
                if (controlOnly && !ctrl) continue;
                if (forRun && (ctrl || this.isReference(layer))) continue;
                chain = this.flushFilterChain(ctx, chain);
                drawn.add(layer);
                if (cb || (!controlOnly && EMULATED_BLENDS.has(layer.blend))) { this.blendEmulated(ctx, layer.blend, (lc) => { this.drawLayer(lc, layer, { skipFilters: skip }); }, layer.opacity, cb ? coverage(cb) : null, seedOfLayer(layer.id)); continue; }
                ctx.globalAlpha = layer.opacity;
                ctx.globalCompositeOperation = controlOnly ? "source-over" : canvasOp(layer.blend);
                this.drawLayer(ctx, layer, { skipFilters: skip });
            }
            chain = this.flushFilterChain(ctx, chain);
        } finally {
            this._walkDepth--;
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    /**
     * Clipping: the unclipped layer below this layer in the same group that it targets.
     */
    clipTargetOf(layer, i = this.layers.indexOf(layer)) {
        if (!layer || !layer.clip) return null;
        for (let j = i - 1; j >= 0; j--) {
            const b = this.layers[j];
            if (b.clip) continue;
            // a clip does not reach out of its group: the base is in the same one (a reference is in none and draws nothing)
            if (!this.isReference(b) && (b.group || null) !== (layer.group || null)) return null;
            return b;
        }
        return null;
    }

    /**
     * Clipping (PLAN_0_1_31 §6 step 3): the layer a clipped layer (`clip`) is clipped to, its base: the nearest layer below
     * it that is not clipped, when that is a layer of pixels. Null for a layer drawn as it is: not clipped, or a clip
     * without effect (below it only clipped layers and the picture, or a filter layer as the base). A walk of the stack
     * draws a clipped layer only where the base is, and not at all when the walk left the base out (hidden, a reference
     * in a run): `drawLayersInto`, `glViewComposite` and `stackPlan` do it the same way.
     */
    clipBaseOf(layer, i = this.layers.indexOf(layer)) {
        const b = this.clipTargetOf(layer, i);
        return b && b.kind === "filter" ? null : b;
    }

    // ---- groups as folders (PLAN_0_1_31 §6 step 5) ------------------------------------------------------------------

    /**
     * A group is a folder and nothing more (pass-through: no opacity, blend or mask of its own): `this.groups` holds
     * `{ id, name, visible, locked, collapsed, parent }` and a layer names its innermost group in `layer.group`. A group
     * changes the picture only by hiding its layers, so every walk of the stack asks `shown(l)` where it asked
     * `l.visible`, and every edit asks `isLocked(l)`. The layers of a group sit together in the stack (references do not
     * count: they are in no group and may sit anywhere); `normalizeGroups` keeps it so after every change.
     */
    groupById(id) {
        if (!id) return null;
        for (const g of this.groups) if (g.id === id) return g;
        return null;
    }

    /** The group `id` and the groups it is in, innermost first. */
    groupsOf(id) {
        const out = [];
        for (let g = this.groupById(id); g && out.length <= this.groups.length; g = this.groupById(g.parent)) out.push(g);
        return out;
    }

    /** Whether a layer is drawn: its own eye and the eyes of every group it is in. */
    shown(l) {
        if (!l.visible) return false;
        if (!l.group) return true;
        for (const g of this.groupsOf(l.group)) if (!g.visible) return false;
        return true;
    }

    /** Whether a layer is locked, by its own lock or by a group's. */
    isLocked(l) {
        if (!l) return false;
        if (l.locked) return true;
        if (!l.group) return false;
        for (const g of this.groupsOf(l.group)) if (g.locked) return true;
        return false;
    }

    /** Whether a layer (or a group, by its `parent`) is in group `gid`, at any depth. */
    inGroup(l, gid) {
        const start = l && (l.group !== undefined ? l.group : l.parent);
        return !!start && this.groupsOf(start).some((g) => g.id === gid);
    }

    /** The layers of a group (and of the groups in it), bottom first. */
    groupLayers(gid) {
        return this.layers.filter((l) => !this.isReference(l) && this.inGroup(l, gid));
    }

    groupsCopy() {
        return this.groups.map((g) => ({ id: g.id, name: g.name, visible: g.visible !== false, locked: !!g.locked, collapsed: !!g.collapsed, parent: g.parent || null }));
    }

    /**
     * Keep the groups sound after any change of the stack: an unknown group id or a reference's group is dropped, a
     * layer apart from its group's run of layers leaves that group (and the ones inside it), a group without layers
     * goes. Pass-through groups make this cheap to get wrong only in the panel: leaving a group changes the picture
     * only when the group was hidden. True when it changed anything.
     */
    normalizeGroups() {
        if (this.holdGroups > 0) return false;   // layers are still being added (a PSD opening, a state loading)
        let changed = false;
        if (!this.groups.length) {
            for (const l of this.layers) if (l.group) { l.group = null; changed = true; }
            if (this.activeGroupId) this.activeGroupId = null;
            return changed;
        }
        const byId = new Map(this.groups.map((g) => [g.id, g]));
        for (const g of this.groups) {
            if (g.parent && !byId.has(g.parent)) { g.parent = null; changed = true; }
            // a cycle (never made here; a damaged file): the group goes to the top level
            const seen = new Set([g.id]);
            for (let p = byId.get(g.parent); p; p = byId.get(p.parent)) {
                if (seen.has(p.id)) { g.parent = null; changed = true; break; }
                seen.add(p.id);
            }
        }
        const chainOf = (id) => { const c = []; for (let g = byId.get(id); g; g = byId.get(g.parent)) c.unshift(g.id); return c; };
        const closed = new Set(), used = new Set();
        let open = [];
        for (const l of this.layers) {
            if (this.isReference(l)) { if (l.group) { l.group = null; changed = true; } continue; }
            if (l.group && !byId.has(l.group)) { l.group = null; changed = true; }
            let chain = l.group ? chainOf(l.group) : [];   // outermost first
            const cut = chain.findIndex((id) => closed.has(id));
            if (cut >= 0) { chain = chain.slice(0, cut); l.group = chain.length ? chain[chain.length - 1] : null; changed = true; }
            let k = 0;
            while (k < open.length && k < chain.length && open[k] === chain[k]) k++;
            for (let q = k; q < open.length; q++) closed.add(open[q]);
            open = chain;
            for (const id of chain) used.add(id);
        }
        const before = this.groups.length;
        this.groups = this.groups.filter((g) => used.has(g.id));
        if (this.groups.length !== before) changed = true;
        if (this.activeGroupId && !used.has(this.activeGroupId)) this.activeGroupId = null;
        return changed;
    }

    /** Stack order changed: what every change of the layer list does after it. */
    layersRestacked() {
        this.normalizeGroups();
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /**
     * Put layers (the selected ones by default) into a new group (Ctrl+G), one "layers" undo step. The group takes the
     * place of the topmost of them, inside the deepest group that holds all of them; a group whose layers are all among
     * them goes in whole (nested), every other layer moves in by itself, in the order of the stack. The new group is
     * selected (its layers).
     */
    groupLayersNow(layers = this.selectedLayers(), { name = null } = {}) {
        const pick = this.layers.filter((l) => layers.includes(l) && !this.isReference(l));
        if (!pick.length) { this.setStatus("Select the layers to group (a reference is in no group)."); return null; }
        if (this.pending) this.cancelPending();
        const picked = new Set(pick);
        const chains = pick.map((l) => this.groupsOf(l.group).map((g) => g.id).reverse());   // outermost first
        const common = [];
        for (let k = 0; chains.every((c) => k < c.length && c[k] === chains[0][k]); k++) common.push(chains[0][k]);
        const parent = common.length ? common[common.length - 1] : null;
        // where the block goes: above what is left of the topmost layer's unit (its own group within `parent`), or where
        // that layer was when all of the unit moves
        const topChain = chains[chains.length - 1].slice(common.length);
        const unit = topChain.length ? topChain[0] : null;
        const rest = this.layers.filter((l) => !picked.has(l));
        const unitRest = unit ? rest.filter((l) => this.inGroup(l, unit)) : [];
        const topAt = this.layers.indexOf(pick[pick.length - 1]);
        const at = unitRest.length ? rest.indexOf(unitRest[unitRest.length - 1]) + 1 : rest.filter((l) => this.layers.indexOf(l) < topAt).length;
        // which groups go in whole: the outermost group below `parent` on a layer's chain whose layers are all picked
        const whole = new Map();
        pick.forEach((l, i) => {
            const c = chains[i].slice(common.length);
            whole.set(l, c.find((id) => this.groupLayers(id).every((x) => picked.has(x))) || null);
        });
        this.pushUndo({ kind: "layers", label: "Group layers" });
        this.groupCounter = (this.groupCounter || 0) + 1;
        let n = this.groups.length + 1;
        while (this.groups.some((g) => g.name === `Group ${n}`)) n++;
        const g = { id: "G" + Date.now().toString(36) + this.groupCounter, name: name || `Group ${n}`, visible: true, locked: false, collapsed: false, parent };
        this.groups.push(g);
        for (const l of pick) {
            const w = whole.get(l);
            if (w) this.groupById(w).parent = g.id;
            else l.group = g.id;
        }
        this.layers = [...rest.slice(0, at), ...pick, ...rest.slice(at)];
        this.normalizeGroups();
        const ids = pick.map((l) => l.id);
        this.activeLayerId = ids[ids.length - 1];
        this.layerSel = new Set(ids.length > 1 ? ids : []);
        this.layerAnchorId = this.activeLayerId;
        this.activeGroupId = g.id;
        this.layersRestacked();
        this.updateSubbar();
        this.setStatus(`${g.name}: ${pick.length} layer${pick.length > 1 ? "s" : ""} grouped. The eye and the lock of its row count for all of them; Ctrl+Z takes it back.`);
        return g;
    }

    /** Dissolve a group: its layers and groups go to the group around it, where they are. One "layers" undo step. */
    ungroup(gid) {
        const g = this.groupById(gid);
        if (!g) { this.setStatus("No such group."); return false; }
        this.pushUndo({ kind: "layers", label: "Ungroup" });
        // a hidden or locked group gave its layers and groups that state; they keep it as their own
        for (const l of this.layers) if (l.group === g.id) {
            l.group = g.parent || null;
            if (!g.visible) l.visible = false;
            if (g.locked) l.locked = true;
        }
        for (const s of this.groups) if (s.parent === g.id) {
            s.parent = g.parent || null;
            if (!g.visible) s.visible = false;
            if (g.locked) s.locked = true;
        }
        this.groups = this.groups.filter((x) => x !== g);
        if (this.activeGroupId === g.id) this.activeGroupId = null;
        this.layersRestacked();
        this.setStatus(`${g.name} ungrouped.`);
        return true;
    }

    /** Delete a group with its layers, one "layers" undo step; refused while one of them is locked. */
    removeGroup(gid) {
        const g = this.groupById(gid);
        if (!g) { this.setStatus("No such group."); return 0; }
        const members = this.groupLayers(g.id);
        const locked = members.filter((l) => this.isLocked(l));
        if (locked.length) { this.setStatus(`${locked.map((l) => l.name).join(", ")} ${locked.length > 1 ? "are" : "is"} locked. Unlock first.`); return 0; }
        if (this.pending && members.includes(this.pending.layer)) this.cancelPending();
        this.pushUndo({ kind: "layers", label: "Delete group" });
        this.layers = this.layers.filter((l) => !members.includes(l));
        if (members.some((l) => l.id === this.activeLayerId)) this.activeLayerId = null;
        this.layerSel = new Set();
        const gone = new Set([g.id, ...this.groups.filter((s) => this.inGroup(s, g.id)).map((s) => s.id)]);
        this.groups = this.groups.filter((s) => !gone.has(s.id));
        this.layersRestacked();
        this.renderHistory();
        this.setStatus(`${g.name} deleted with ${members.length} layer${members.length === 1 ? "" : "s"}. Ctrl+Z takes it back.`);
        return members.length;
    }

    /**
     * A group's switch: `visible`, `locked` or `collapsed`. Like a layer's eye and lock, no undo step; saved with the
     * document. Locking a group ends a transform pending on one of its layers.
     */
    setGroupFlag(gid, key, value) {
        const g = this.groupById(gid);
        if (!g || !["visible", "locked", "collapsed"].includes(key)) return false;
        const v = !!value;
        if (!!g[key] === v) return false;
        g[key] = v;
        if (key === "locked" && v && this.pending && this.inGroup(this.pending.layer, g.id)) this.cancelPending();
        if (key === "visible") { this.visibilityChanged(); return true; }
        this.renderLayers();
        if (key === "locked") this.updateSubbar();
        this.notifyChanged();
        return true;
    }

    renameGroup(gid, name) {
        const g = this.groupById(gid);
        const v = String(name || "").trim();
        if (!g || !v || v === g.name) return false;
        this.pushUndo({ kind: "layers", label: "Rename group" });
        g.name = v;
        this.renderLayers(); this.notifyChanged();
        return true;
    }

    /** A click on a group's row selects its layers (Ctrl adds them to the selection); the row shows as selected. */
    clickGroupRow(g, e) {
        const members = this.groupLayers(g.id);
        if (!members.length) return;
        const ids = members.map((l) => l.id);
        const ctrl = e && (e.ctrlKey || e.metaKey);
        const cur = ctrl ? this.selectedLayers().map((l) => l.id) : [];
        const all = [...new Set([...cur, ...ids])];
        this.selectLayers(all, { active: ids[ids.length - 1] });
        this.activeGroupId = g.id;
        this.renderLayers();
    }

    /**
     * Move layers or a group in the panel (drag and drop), one "layers" undo step. `what`: `{ layer }` or `{ group }`;
     * `onto`: `{ layer }` or `{ group }` (a group's row), `above` as the panel shows it. Onto a layer's row the moved
     * item joins that layer's group; onto a group's row, above goes next to the group, below goes into it at its top.
     */
    dropInLayers(what, onto, above) {
        const g = what.group ? this.groupById(what.group) : null;
        const src = what.layer ? this.layers.find((l) => l.id === what.layer) : null;
        if (!g && !src) return false;
        const block = g ? this.groupLayers(g.id) : [src];
        if (!block.length) return false;
        const tLayer = onto.layer ? this.layers.find((l) => l.id === onto.layer) : null;
        const tGroup = onto.group ? this.groupById(onto.group) : null;
        if (!tLayer && !tGroup) return false;
        if (tLayer && block.includes(tLayer)) return false;
        if (g && tGroup && (tGroup === g || this.inGroup(tGroup, g.id))) return false;
        const rest = this.layers.filter((l) => !block.includes(l));
        let at, parent;
        if (tLayer) {
            const j = rest.indexOf(tLayer);
            at = above ? j + 1 : j;
            parent = tLayer.group || null;
        } else {
            const mem = rest.filter((l) => this.inGroup(l, tGroup.id));
            at = mem.length ? rest.indexOf(mem[mem.length - 1]) + 1 : rest.length;
            parent = above ? (tGroup.parent || null) : tGroup.id;
        }
        const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
        // a drop next to where it already is changes nothing that shows: no step, no change (review F26)
        const sameParent = g ? (g.parent || null) === parent : this.isReference(src) || (src.group || null) === parent;
        if (sameParent && this.sameStackOrder(src, next)) return false;
        this.pushUndo({ kind: "layers", label: "Layer order" });
        if (g) g.parent = parent;
        else if (!this.isReference(src)) src.group = parent;
        this.layers = next;
        this.layersRestacked();
        return true;
    }

    /**
     * Whether the stack `next` shows the layers in the order they have now: the whole stack, or only the references'
     * order when `moved` is a reference (they are no part of the picture, so their place among the other layers is not).
     */
    sameStackOrder(moved, next) {
        const seen = (arr) => (moved && this.isReference(moved) ? arr.filter((l) => this.isReference(l)) : arr);
        const a = seen(next), b = seen(this.layers);
        return a.length === b.length && a.every((l, k) => l === b[k]);
    }

    /** Whether reorderLayer(srcId, targetId, above) would move anything (a reference row's drop marker). */
    reorderMoves(srcId, targetId, above) {
        const src = this.layers.find((l) => l.id === srcId), t = this.layers.find((l) => l.id === targetId);
        if (!src || !t || src === t) return false;
        // where dropInLayers puts it: next to the target in the stack without it
        const rest = this.layers.filter((l) => l !== src);
        const at = rest.indexOf(t) + (above ? 1 : 0);
        const next = [...rest.slice(0, at), src, ...rest.slice(at)];
        return !this.sameStackOrder(src, next) || (!this.isReference(src) && (src.group || null) !== (t.group || null));
    }

    /**
     * One step up (+1) or down (-1) through the tree (Ctrl+] / Ctrl+[): past the next layer of the same group, into a
     * group that starts next to it (at its near end), or out of its own group when it is at that group's end. False
     * when it cannot move.
     */
    stepLayer(l, dir) {
        const i = this.layers.indexOf(l);
        const j = i + dir;
        const n = this.layers[j];
        const own = l.group ? this.groupById(l.group) : null;
        if (!n || (own && !this.isReference(n) && !this.inGroup(n, own.id))) {
            if (!own || this.isReference(l)) return false;
            l.group = own.parent || null;   // out of its group, in place
            return true;
        }
        if (this.isReference(n) || this.isReference(l) || (n.group || null) === (l.group || null)) {
            this.layers[i] = n; this.layers[j] = l;
            return true;
        }
        // `n` is in a group inside the layer's own (or any group, at the top level): into the outermost of them
        const chain = this.groupsOf(n.group);
        const k = own ? chain.findIndex((x) => x.id === own.id) : chain.length;
        l.group = chain[k - 1].id;
        return true;
    }

    /**
     * The coverage of a clipping base in a pass onto `ctx`: the base drawn alone at its opacity (its pixels' alpha
     * through its mask, whatever its blend mode) into a scratch of `ctx`'s canvas size with its transform, returned
     * in canvas pixels. One scratch per depth of the walk, so a walk nested in a filter's statistics keeps it.
     */
    clipCoverage(ctx, base) {
        const cv = ctx.canvas, W = cv.width, H = cv.height;
        const screen = !!(this.viewPass && this.viewPass.screen);
        const key = (screen ? "gpu" : "cpu") + (this._walkDepth || 0);
        const m = this._walkScratches || (this._walkScratches = new Map());
        let c = m.get(key);
        if (!c || c.width !== W || c.height !== H) { c = screen ? makeCanvas(W, H) : cpuDab(null, W, H); m.set(key, c); }
        const x = c.getContext("2d");
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        x.clearRect(0, 0, W, H);
        x.setTransform(ctx.getTransform());
        x.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
        // on the screen the opacity goes into the scratch (`destination-in` takes it from there); off the screen the kernel
        // multiplies it into the mask (`_clipAlpha`, mul255 as the workers do: drawn in, it came out 3 levels apart)
        const op = Math.max(0, Math.min(1, base.opacity ?? 1));
        x.globalAlpha = screen ? op : 1;
        c._clipAlpha = screen ? 255 : Math.round(op * 255);
        this.drawLayer(x, base);
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        return c;
    }

    drawLayer(ctx, layer, opts = {}) {
        const p = this.pending;
        if (p && p.layer === layer) {
            const fine = !this.pointer;
            const n = this.pendingSubdivisions(p, fine);
            // while the view is drawn, a tile layer's GPU copy (displaySource's `screen`), not its CPU mirror
            const px = this.viewPass && this.viewPass.screen ? this.displaySource(this.layerPixels(layer, true), 1, true) : this.layerPixels(layer, true);
            if (p.mode === "rotate") {
                const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(p.angle);
                ctx.drawImage(px, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
                ctx.restore();
            } else {
                drawMesh(ctx, px, (u, v) => this.pendingDst(p, u, v), n, n);
            }
            return;
        }
        const vp = this.viewPass;
        const gesture = this.pointer && this.pointer.layer === layer;
        // C6 (c2d): only a paint or mask stroke puts pixels on the screen that are not in the tiles; a move, a scale or a
        // smudge leaves them there (the smudge writes into the tiles), so those gestures draw the tiles like any frame
        // (a liquify stroke on the screen only, once it has moved something: every other pass draws the tiles, since a stroke
        // is not in the document until it lands; and before its first dab a skipped tile shortcut would reach the mirror)
        const painting = gesture && (this.pointer.kind === "layerpaint" || this.pointer.kind === "maskpaint" || (!!vp && !!vp.screen && this.liquifyOn(layer)));
        const full = ctx.canvas.width === this.width && ctx.canvas.height === this.height;
        const matched = this.matchActive(layer) && !gesture && (vp || full);
        // C3: a plain tile-backed layer in a region pass draws the part of itself the view shows, at
        // the view's level, straight from its tiles. A mask, a colour match or a live stroke has
        // prepared a canvas, and the canvas backend keeps the display pyramid.
        if (vp && !matched && !painting && !this.liveMask(layer) && isTilePixels(layer.px)) {
            this.drawTilesInto(ctx, layer.px, layer.x, layer.y, layer.w, layer.h, vp);
            return;
        }
        // C5: the layer a live stroke runs on, and a layer whose transparency mask sits on the same
        // tile grid, in a region pass: composed inside the region only, at the pass's resolution.
        // layerWithStroke and `_masked` below are canvases as large as the layer, filled from the
        // layer's display mirror. C6 (c2): the screen keeps its scratch for a live stroke (layerRegionView:
        // a dab redraws only its box); every other pass, and a masked layer without a stroke, composes the
        // layer into a scratch of the pass target's size (drawLayerPass), whatever the pass's size.
        const liquify = !!vp && vp.screen && this.liquifyOn(layer);
        if (vp && !matched && (this.liveStrokeOn(layer) || liquify || (this.liveMask(layer) && this.tileMaskOf(layer)))) {
            if (!(vp.screen && (this.liveStrokeOn(layer) || liquify))) { this.drawLayerPass(ctx, layer, vp); return; }
            const live = this.layerRegionView(layer, vp);
            if (live) { ctx.drawImage(live, vp.x, vp.y, vp.w, vp.h); return; }
            // a region that is not whole destination pixels: the layer as it is for this frame
            if (liquify) { this.drawLayerPass(ctx, layer, vp); return; }
        }
        // C6 (c) 7b: a colour-matched layer on tiles, in any region pass, is matched in the part its region shows, from its
        // tiles and its mask at the pass's level: no display mirror, no Skia pyramid, no `_masked`
        if (matched && vp && this.matchFromTiles(layer)) {
            const e = this.matchedRegionView(layer, vp, ctx.canvas);
            if (!e) return;
            if (!e.plain) ctx.drawImage(e.canvas, 0, 0, e.sw, e.sh, e.x, e.y, e.w, e.h);
            else if (this.liveMask(layer)) this.drawLayerPass(ctx, layer, vp);
            else this.drawTilesInto(ctx, layer.px, layer.x, layer.y, layer.w, layer.h, vp);
            return;
        }
        // C6 (b3): a sampled pass (the wand's and the bucket's boxes, a plugin's flatten) matches the part of the
        // layer its region shows, not the whole layer (the canvas backend; tiles take matchedRegionView above)
        if (matched && vp && vp.sample) {
            const part = this.layerMatchedPart(layer, ctx.canvas, vp);
            if (part) ctx.drawImage(part.canvas, part.x, part.y, part.w, part.h);
            return;
        }
        const src = matched ? this.layerMatchedPixels(layer, ctx.canvas, vp, opts) : this.layerPixels(layer, true);
        ctx.drawImage(this.displaySource(src, vp ? (layer.w * vp.sx) / src.width : 1, !!(vp && vp.screen)), layer.x, layer.y, layer.w, layer.h);
    }

    flattenToCanvas(opts = {}) {
        // E5: Chromium makes a canvas above its limit without complaint and draws nothing into it; a picture of nothing
        // must not be saved, uploaded or sent to a model
        if (this.huge) throw new Error(`this ${this.width} × ${this.height} document is larger than any canvas (268 MP): it is written as PNG, PSD or ORA at its full size, and read in boxes`);
        const prev = this.viewPass;
        this.viewPass = null;   // exports, runs and uploads always see the full-resolution composite
        try {
            const c = makeCanvas(this.width, this.height);
            this.drawComposite(c.getContext("2d"), opts);
            return c;
        } finally {
            this.viewPass = prev;
        }
    }

    /**
     * How the full-resolution composite is read in bands (docs/PLAN_BCE.md §E2): `{ reach }` when a band composited with
     * that margin above and below equals the whole flatten there (`boxReach`: pointwise layers 0, a blur its radius), or
     * null when only the whole flatten gives those pixels (a colour-matched layer, a scaled one, a filter that reads the
     * whole picture) and the caller keeps its canvas. Only on tiles, and only with the pool's PNG parts.
     */
    bandPlan(opts = { forRun: true }) {
        if (!this.tileMode || !this.base || !partsUsable() || InpaintEditor.bands === false) return null;
        const o = { forRun: !!opts.forRun, upTo: opts.upTo == null ? null : opts.upTo };
        let reach = this.boxReach([0, 0, this.width, this.height], o), inexact = false;
        if (!Number.isFinite(reach)) {
            // B item 7 part 3: a colour-matched layer is the one reason left for no margin that the stack path takes (its
            // statistics from point samples of the tiles); the bands are then the program's, or nothing (`stackOnly`: no
            // region pass falls in for them, the caller keeps its whole flatten)
            if (!this.huge && InpaintEditor.stacks !== false && this.stackPlan({ ...o, filters: true })) return { reach: 0, rows: 0, inexact: true, stackOnly: true };
            // E5: above the canvas limit there is no whole flatten to take instead. The bands are then what a region pass
            // at full resolution draws: a colour-matched layer with the statistics the screen uses (`sampledMatchStats`,
            // at most a few levels from the whole flatten's, docs/PLAN_BCE.md §C6 c 7c), a scaled layer resampled per band
            if (!this.huge) return null;
            reach = this.boxReach([0, 0, this.width, this.height], { ...o, loose: true });
            inexact = true;
        }
        // a wide margin (a film look's halation is 1.2 % of the long side: 544 px at 15000) is composited twice per band,
        // so the bands grow with it; never more than a canvas holds
        const r = Math.ceil(reach);
        let rows = Math.max(TILE_SIZE, Math.min(2048, Math.ceil((2 * r) / TILE_SIZE) * TILE_SIZE));
        while (rows > TILE_SIZE && this.width * (rows + 2 * r) > CANVAS_MAX_PIXELS / 2) rows -= TILE_SIZE;
        if (this.width * (rows + 2 * r) > CANVAS_MAX_PIXELS) return null;
        return { reach: r, rows, inexact };
    }

    /**
     * The rows `y0` to `y1` of the full-resolution composite as RGBA8 (a typed array of its own): a region pass at level
     * 0 over those rows and `reach` more on either side, drawn into a CPU canvas and read there. The pass's own canvas is
     * never read back itself: a hundred `getImageData` calls on canvases of the GPU make Chromium put every new canvas
     * in software (CLAUDE.md, traps).
     */
    readBand(y0, y1, opts, reach = 0) {
        const W = this.width;
        const kt = Math.min(reach, y0), kb = Math.min(reach, this.height - y1);
        const big = this.sampleRegion("image", [0, y0 - kt, W, y1 + kb], 1, { ...opts, pad: 0 });
        const c = document.createElement("canvas");
        c.width = W; c.height = y1 - y0;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        try {
            ctx.drawImage(big, 0, -kt);
            return ctx.getImageData(0, 0, W, y1 - y0).data;
        } finally {
            big.width = 1; big.height = 1;
            c.width = 1; c.height = 1;
        }
    }

    /**
     * The composite as a PNG written in bands: `{ blob, hash, width, height }`, or null when it cannot be (`bandPlan`)
     * and the caller flattens into a canvas. `each(data, y0, y1)` sees every band before it goes to the workers (the
     * flatten writes its new base from them). The picture must not change while its bands are read: a change restarts
     * the read once, a second one fails it.
     */
    async encodeComposite(opts = { forRun: true }, { hash = false, texts = null, chunks = null, each = null, progress = null } = {}) {
        if (opts && opts.forRun) await this.relightSettled();
        // B item 1: a plain stack is composited by the workers that pack it, from the tiles; `each` wants the rows here
        const stack = each ? null : await this.stackSource(opts);
        if (stack) {
            try {
                const r = await encodeRows(stack.source, { hash, texts, chunks, progress });
                if (r) return { ...r, width: this.width, height: this.height, stack: stack.layers };
            } finally { stack.release(); }
        }
        const plan = this.bandPlan(opts);
        if (!plan) return null;
        for (let round = 0; ; round++) {
            const version = this.compositeVersion;
            const changed = () => this.compositeVersion !== version;
            // B item 7 part 2: with filter layers in an otherwise plain stack the workers composite the bands and the GPU
            // filters their bytes (`programBand`); `bandSource` falls back to the region pass band by band
            const bands = await this.bandSource(opts, plan);
            if (!bands) return null;
            try {
                const r = await encodeBands(this.width, this.height, async (y0, y1) => {
                    if (changed()) throw new Error("the picture changed");
                    const data = await bands.read(y0, y1);
                    if (each) each(data, y0, y1);
                    return data;
                }, { hash, texts, chunks, progress, rows: bands.rows });
                if (!r) return null;
                if (changed()) throw new Error("the picture changed");
                return { ...r, width: this.width, height: this.height, program: bands.program(), programTiming: bands.timing() };
            } catch (err) {
                if (String(err && err.message).includes(NO_PROGRAM)) return null;   // a matched stack without its program: the caller flattens whole
                if (!/the picture changed/.test(String(err && err.message))) throw err;
                if (round >= 1) throw new Error("the picture changed while it was written; try again");
            } finally {
                bands.release();
            }
        }
    }

    /**
     * How the bands of the composite are read (`bandPlan` said they can be): `{ rows, read(y0, y1), program(), release() }`.
     * A stack with filter layers that `stackPlan` takes is held as a program and read through `programBand`; everything
     * else, and every band after the GPU path failed, is the region pass (`readBand`). `program()` says how many bands
     * came the new way. With the plan's `stackOnly` (a colour-matched layer, B item 7 part 3) there is no region pass
     * to fall back on: null when no program can be held, and a failed band throws NO_PROGRAM to the caller.
     */
    async bandSource(opts, plan) {
        const o = { forRun: !!opts.forRun, upTo: opts.upTo == null ? null : opts.upTo };
        let prog = this.huge ? null : await this.holdStack(this.stackPlan({ ...o, filters: true }), o);
        if (prog && !prog.steps) { prog.release(); prog = null; }
        const rows = prog ? this.programRows(prog, this.width) : 0;
        if (prog && !rows) { prog.release(); prog = null; }
        if (!prog && plan.stackOnly) return null;
        let done = 0;
        const reader = prog ? this.programReader(prog) : null, timing = prog ? prog.timing : null;
        return {
            rows: prog ? rows : plan.rows,
            read: async (y0, y1) => {
                if (prog) {
                    try {
                        const data = await reader.read([0, y0, this.width, y1], null, y1 < this.height ? [0, y1, this.width, Math.min(this.height, y1 + rows)] : null);
                        done++;
                        return data;
                    }
                    catch (err) {
                        if (!String(err && err.message).includes(NO_PROGRAM)) throw err;
                        prog.release(); prog = null;
                        if (plan.stackOnly) throw err;
                    }
                }
                // a band of the program's height fits a canvas whenever one of the plan's does: the rows are at most the plan's cap
                return this.readBand(y0, y1, opts, plan.reach);
            },
            program: () => done,
            timing: () => (timing ? Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])) : null),
            release: () => { if (prog) { prog.release(); prog = null; } },
        };
    }

    /** Upload the composite as a PNG named by its hash: in bands when it can be read that way (E2), else from a canvas. */
    async uploadComposite(opts, prefix) {
        const r = await this.encodeComposite(opts, { hash: true });
        if (r) return { ref: await uploadBlob(r.blob, `${prefix}_${r.hash}.png`), hash: r.hash };
        return uploadCanvas(this.flattenToCanvas(opts), prefix);
    }

    maskToCanvas() {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        const src = this.sel.readRect(0, 0, this.width, this.height).data;
        const out = ctx.createImageData(this.width, this.height);
        const d = out.data;
        for (let i = 0; i < src.length; i += 4) {
            const a = src[i + 3];
            d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        return c;
    }

    /**
     * Bake the visible layers into the base. It is a `canvas` step, like a merge into the base: with
     * no step and the history kept, an older `layers` step put the baked layers back on top of a
     * base that already held them (a multiply layer applied twice).
     */
    flatten() { return this.trackEdit(this.flattenNow()); }   // undo waits for the upload (see extendCanvas)

    async flattenNow() {
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        if (!this.base || !this.layers.length) return;
        if (this.pending) this.cancelPending();
        let before = null, pushed = false;
        try {
            this.setStatus("Flattening ...");
            before = this.snapshot({ kind: "canvas" });
            // E2: the upload and the new base from the same bands, without a canvas of the picture
            let px = null, ref, hash;
            const banded = await this.encodeComposite({ forRun: true }, {
                hash: true,
                each: (data, y0, y1) => {
                    if (y0 === 0) { if (px) px.release(); px = this.pixels.Layer.empty(this.width, this.height); }
                    px.writeRect({ data, width: this.width, height: y1 - y0 }, 0, y0);
                },
            });
            if (banded) {
                hash = banded.hash;
                ref = await uploadBlob(banded.blob, `n${this.node.id}_base_${hash}.png`);
            } else {
                if (px) px.release();
                const flat = this.flattenToCanvas({ forRun: true });
                ({ ref, hash } = await uploadCanvas(flat, `n${this.node.id}_base`));
                px = this.pixels.Layer.fromCanvas(flat);   // C6 (d): not the upload decoded again
            }
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label: "Flatten" });
            this.layers = this.layers.filter((l) => this.isControl(l) || this.isReference(l));
            this.activeLayerId = null;
            this.refsMutated();
            this.base = { ref, px };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus("Flattened into base layer (control and reference layers kept; Ctrl+Z takes it back).");
        } catch (err) {
            if (!pushed) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }
}

export function bindComposite(C) { InpaintEditor = C; }
