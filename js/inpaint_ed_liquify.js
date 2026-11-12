// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_liquify.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// liquify: moved out of inpaint_canvas.js (item 56 S4, docs/PLAN_SPLIT.md), text unchanged.

import { allocLiquifyWindow, freeLiquifyWindow, liquifyPreview } from "./px/kernels.js";
import { MIP_LEVELS, isTilePixels } from "./inpaint_tiles.js";
import { LiquifyField, gridStep, liquifyFalloff, thawPlane } from "./inpaint_liquify.js";
import { makeCanvas } from "./inpaint_consts.js";

let InpaintEditor = null;

export class LiquifyPart {
    // ---- liquify (PLAN_0_1_31 §5 step 5) ------------------------------------------------------------------------

    /*
     * Every stroke lands at its release as one undo step; there is no Apply. A session (`this.liq`) keeps the layer's
     * pixels as the first press found them (`orig`: a copy-on-write clone on tiles, a canvas copy on canvases) and the
     * displacement field (inpaint_liquify.js), and every stroke is baked from `orig` through the whole field, so the
     * picture is resampled once however many strokes there are and Restore gets the original bytes back. The session
     * ends when another tool is picked (Photoshop's OK), the editor closes, a new picture comes, or a press finds the
     * layer changed since the session's last write (`stamp`); undo and redo of its strokes carry the field with the
     * pixels (`snap.liq`, `liquifyRestored`).
     */

    /** The options bar's hint for Liquify. */
    liquifyHint() {
        const m = (this.liquifyOpts && this.liquifyOpts.mode) || "push";
        if (m === "push") return "Drag to push the picture along with the brush";
        if (m === "restore") return "Brush over what should go back to where the session began";
        if (m === "freeze" || m === "thaw") return m === "freeze" ? "Paint what should stay where it is; Alt thaws" : "Paint to free what was frozen; Alt freezes";
        if (m === "grow" || m === "shrink") return "Hold or drag to " + (m === "grow" ? "swell" : "pinch") + " what is under the brush; Alt " + (m === "grow" ? "pinches" : "swells");
        return "Hold or drag to turn what is under the brush; Alt turns the other way";
    }

    /** Why Liquify cannot work on `layer` (the base: null, it gets a copy), or null. */
    liquifyRefusal(layer) {
        const why = this.patchRefusal(layer, "Liquify");
        if (why) return why;
        if (layer && layer.alphaLock) return `Liquify moves transparency too: unlock the transparency of ${layer.name} first.`;
        return null;
    }

    /** Is the session `liq` still the one of `layer` as it is: nothing wrote the layer since the session's last write? */
    liquifyValid(liq, layer) {
        return !!liq && liq.layer === layer && this.layers.includes(layer) && layer.px === liq.px && layer.px.version === liq.stamp
            && liq.s === gridStep(this.width, this.height);
    }

    /** The session of `layer`: the current one while it is valid, else a new one from the layer's pixels as they are. */
    liquifySession(layer) {
        if (this.liquifyValid(this.liq, layer)) return this.liq;
        this.endLiquify();
        const px = layer.px, s = gridStep(this.width, this.height);
        this._liqSeq = (this._liqSeq || 0) + 1;
        this.liq = {
            sid: this._liqSeq, layer, px, s,
            field: new LiquifyField(px.width, px.height, s),
            orig: px.clone(),
            landed: new Map(),     // tiles: key -> { tile, version } the session last wrote there
            stamp: px.version,
            // a layer as large as the picture repeats its edge pixels outside (no transparent fringe pulled in at the picture's edge)
            clamp: layer.x === 0 && layer.y === 0 && px.width === this.width && px.height === this.height,
            thawCache: null,
            ended: false,
        };
        return this.liq;
    }

    /**
     * End the session. Its undo steps let go of their fields (nothing can use them: the session's id is gone) and the
     * budget stops counting them; its source goes, after the landing or the drop of a stroke of it still under way (a
     * drag a tool key ended, or a bake held in the pool: they read the source to the end).
     */
    endLiquify() {
        const liq = this.liq;
        if (!liq) return;
        this.liq = null;
        for (const s of this.undo.concat(this.redo)) {
            if (!s || !s.liq || s.liq.sid !== liq.sid) continue;
            s.liq = null;
            if (s.liqBytes) { s.bytes -= s.liqBytes; this.undoBytes -= s.liqBytes; s.liqBytes = 0; }
        }
        const p = this.pointer;
        if (p && p.kind === "liquify") this.freeLiquifyWindow(p);
        if (p && p.kind === "liquify" && p.liq === liq) { liq.ended = true; return; }
        liq.orig.release();
    }

    /** The bytes of the cells of `cells` that `other` does not share (a step's field against the field it sits beside). */
    liquifyCellBytes(cells, other, field) {
        let n = 0;
        for (const [key, c] of cells) if (!other || other.get(key) !== c) n++;
        return n * field.n * field.n * 8;
    }

    /**
     * How much the selection lets a node move (its alpha / 255, 0 outside the picture), or null without a selection. Read
     * per cell of the field, one read of the selection each, kept while the selection and the layer's place stay.
     */
    liquifyThaw(liq) {
        const fr = this.liquifyFreezeOf(liq.layer), sel = this.getBounds() ? this.liquifySelThaw(liq) : null;
        if (!fr || !fr.cells.size) return sel;
        const n = fr.n, sh = 8 - fr.ls, m = n - 1;
        const fCell = (key) => fr.cells.get(key) || null;
        let lk = -1, lc = null;
        const free = (i, j) => {
            const key = ((j >> sh) << 16) | (i >> sh);
            if (key !== lk) { lk = key; lc = fCell(key); }
            return lc ? 1 - lc[(j & m) * n + (i & m)] / 255 : 1;
        };
        if (!sel) {
            free.planes = (i0, j0, ow, oh) => ({ sel: null, freeze: thawPlane(fCell, n, sh, i0, j0, ow, oh) });
            return free;
        }
        const both = (i, j) => sel(i, j) * free(i, j);
        both.planes = (i0, j0, ow, oh) => ({ sel: sel.planes(i0, j0, ow, oh).sel, freeze: thawPlane(fCell, n, sh, i0, j0, ow, oh) });
        return both;
    }

    /** The selection's part of `liquifyThaw`. */
    liquifySelThaw(liq) {
        const sel = this.sel, layer = liq.layer, s = liq.s, n = 256 / s, sh = 8 - Math.log2(s), m = n - 1;
        let cache = liq.thawCache;
        if (!cache || cache.sel !== sel || cache.ver !== sel.version || cache.x !== layer.x || cache.y !== layer.y) {
            cache = liq.thawCache = { sel, ver: sel.version, x: layer.x, y: layer.y, cells: new Map() };
        }
        const cellOf = (key) => {
            let c = cache.cells.get(key);
            if (c) return c;
            const d = sel.readRect((key & 0xFFFF) * 256 + layer.x, (key >>> 16) * 256 + layer.y, 256, 256).data;
            c = new Uint8Array(n * n);
            for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) c[b * n + a] = d[(b * s * 256 + a * s) * 4 + 3];
            cache.cells.set(key, c);
            return c;
        };
        let lk = -1, lc = null;
        const fn = (i, j) => {
            const key = ((j >> sh) << 16) | (i >> sh);
            if (key !== lk) { lk = key; lc = cellOf(key); }
            return lc[(j & m) * n + (i & m)] / 255;
        };
        fn.planes = (i0, j0, ow, oh) => ({ sel: thawPlane(cellOf, n, sh, i0, j0, ow, oh), freeze: null });
        return fn;
    }

    /** The press: the session, the stroke, and the first dab of the modes that act where they are held. */
    liquifyPress(e, ix, iy) {
        let layer = this.activeLayer();
        const why = this.liquifyRefusal(layer);
        if (why) { this.setStatus(why, "info"); return; }
        let made = null;
        if (!layer) {
            // the base is never written: a copy of it, the layer "Liquify" directly above it, is liquified like any photo layer
            // from then on (on tiles it shares every tile of the base); the first stroke's undo step takes it away again
            made = this.snapshot({ kind: "layers" });
            layer = this.addLayer({ name: "Liquify", kind: "paint", ref: null, px: this.basePx.clone(), x: 0, y: 0, w: this.width, h: this.height, dirty: true });
            this.layers.splice(this.layers.indexOf(layer), 1);
            this.layers.unshift(layer);
            this.renderLayers();
            this.setStatus("The base is not edited directly: Liquify works on a copy of it, the layer Liquify.");
        }
        const liq = this.liquifySession(layer);
        let mode = (this.liquifyOpts && this.liquifyOpts.mode) || "push";
        // Alt reverses the mode for the stroke (the tone brush's habit)
        if (e.altKey) mode = { grow: "shrink", shrink: "grow", swirlcw: "swirlccw", swirlccw: "swirlcw", freeze: "thaw", thaw: "freeze" }[mode] || mode;
        const pressure = this.pressureOf(e);
        const x = ix - layer.x - 0.5, y = iy - layer.y - 0.5;
        const p = this.pointer = { kind: "liquify", layer, liq, mode, before: new Map(liq.field.cells), made, last: [ix, iy], at: [x, y], travel: 0,
            pressure, stab: this.newStabiliser(ix, iy, pressure), thaw: this.liquifyThaw(liq), strokeBox: null, dirtyView: null, tick: null, liqWin: null,
            freeze: mode === "freeze" || mode === "thaw" ? this.liquifyFreezeOf(layer, true) : null,
            freezeBefore: mode === "freeze" || mode === "thaw" ? new Map() : null };
        try {
            if (p.freeze) { this.liquifyFreezeDab(p, x, y); this.drawSoon(); return; }
            if (mode !== "push") {
                this.liquifyDab(p, x, y, null);
                // they keep acting while the button is held still: a timer, never requestAnimationFrame (it stops in a hidden window)
                const ms = InpaintEditor.liquifyRateMs;
                if (ms > 0) p.tick = setInterval(() => { if (this.pointer === p && !p.healing) this.liquifyTick(); }, ms);
            }
        } catch (err) {
            if (this.pointer === p) this.pointer = null;
            this.liquifyDrop(p, null);
            throw err;
        }
        this.drawSoon();
    }

    /** One dab at (x, y) in the layer's pixel-index positions; `delta` the push's step (null for the other modes). */
    liquifyDab(p, x, y, delta) {
        if (p.freeze) { this.liquifyFreezeDab(p, x, y); return; }
        const liq = p.liq, r = Math.max(2 * liq.s, this.brushSize / 2);
        const amount = Math.min(1, ((this.liquifyOpts ? this.liquifyOpts.strength : 50) / 100) * (p.pressure || 1));
        const box = liq.field.dab(delta ? "push" : p.mode, x, y, r, this.activeHardness(), amount, delta, p.thaw, p.before, InpaintEditor.liquifyDabKernel);
        if (!box) return;
        const L = p.layer, b = [box[0] + L.x, box[1] + L.y, box[2] + L.x, box[3] + L.y];
        const grow = (a) => (!a ? b.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
        p.strokeBox = grow(p.strokeBox);
        p.dirtyView = grow(p.dirtyView);
        this.pixelVersion++;
        this.drawSoon();
    }

    /** The timer's dab of a mode that acts where it is held (and a test's: `ed.liquifyTick()`). */
    liquifyTick() {
        const p = this.pointer;
        if (!p || p.kind !== "liquify" || p.healing || p.mode === "push" || p.freeze) return;
        try { this.liquifyDab(p, p.last[0] - p.layer.x - 0.5, p.last[1] - p.layer.y - 0.5, null); }
        catch (err) { if (this.pointer === p) this.pointer = null; this.liquifyDrop(p, null); throw err; }
    }

    /**
     * The push towards (x, y): sub-dabs of at most 0.2 r (1 - h) each, so every dab's map stays injective and the picture
     * never folds; at most `cap` of them, the rest carried to the next point (a fast flick is spread out, never skipped).
     */
    liquifyPushTo(p, x, y, cap) {
        const r = Math.max(2 * p.liq.s, this.brushSize / 2), h = Math.min(0.8, Math.max(0, this.activeHardness()));
        const step = 0.2 * r * (1 - h);
        const dx = x - p.at[0], dy = y - p.at[1], dist = Math.hypot(dx, dy);
        if (!(dist > 1e-6)) return;
        const steps = Math.ceil(dist / step), n = Math.min(steps, cap);
        const sx = dx / steps, sy = dy / steps;
        for (let k = 0; k < n; k++) {
            this.liquifyDab(p, p.at[0], p.at[1], [sx, sy]);
            p.at = [p.at[0] + sx, p.at[1] + sy];
        }
    }

    /** The points of a move (image pixels, with their pressure): pushes follow them, the other modes dab every 10 % of the radius. */
    liquifyMove(p, pts) {
        const L = p.layer;
        for (const [ix, iy, pr] of pts) {
            p.pressure = pr;
            const x = ix - L.x - 0.5, y = iy - L.y - 0.5;
            if (p.mode === "push") this.liquifyPushTo(p, x, y, 16);
            else {
                p.travel += Math.hypot(ix - p.last[0], iy - p.last[1]);
                if (p.travel >= Math.max(p.liq.s, 0.1 * this.brushSize / 2)) { p.travel = 0; this.liquifyDab(p, x, y, null); }
            }
            p.last = [ix, iy];
        }
    }

    /** The release: the push's carried rest, then the landing. */
    liquifyRelease(p) {
        if (p.tick) { clearInterval(p.tick); p.tick = null; }
        try {
            this.finishStroke(p);
            if (p.freeze) {
                // a thaw (or Alt) on the base's fresh copy froze nothing: the copy goes again, as for a stroke that lands nothing
                if (p.made && !p.froze) { this.liquifyDrop(p, null); return; }
                if (p.made) { this.pushUndoSnapshot(p.made, { label: "Liquify: copy of the base" }); this.renderLayers(); }
                if (p.liq.ended) p.liq.orig.release();
                this.freeLiquifyWindow(p);
                this.draw();
                return;
            }
            if (p.mode === "push") this.liquifyPushTo(p, p.last[0] - p.layer.x - 0.5, p.last[1] - p.layer.y - 0.5, 4096);
            const words = { push: "push", grow: "grow", shrink: "shrink", swirlcw: "swirl", swirlccw: "swirl", restore: "restore" };
            this.liquifyLand(p, "Liquify: " + (words[p.mode] || p.mode));
        } catch (err) {
            this.freeLiquifyWindow(p);
            if (!p.healing) this.liquifyDrop(p, null);
            throw err;
        }
    }

    /** Restore all (the options bar's button): the session's field scaled back to zero (inside the selection), as one step. */
    liquifyRestoreAll() {
        if (this.pointer) { if (this.pointer.healing) this.setStatus(this.heldWord(this.pointer)); return; }
        const layer = this.activeLayer(), liq = this.liq;
        const why = layer && this.liquifyRefusal(layer);
        if (why) { this.setStatus(why, "info"); return; }
        if (!layer || !this.liquifyValid(liq, layer) || liq.field.empty) {
            this.setStatus("Nothing to restore: Restore all brings back the layer as this Liquify session found it (a session ends when another tool is picked).");
            return;
        }
        const p = { kind: "liquify", layer, liq, mode: "restore", before: new Map(liq.field.cells), made: null, last: [0, 0], strokeBox: null, dirtyView: null, tick: null, liqWin: null };
        const box = liq.field.restoreAll(this.liquifyThaw(liq), p.before);
        if (!box) { this.setStatus("Nothing to restore inside the selection."); return; }
        p.strokeBox = [box[0] + layer.x, box[1] + layer.y, box[2] + layer.x, box[3] + layer.y];
        this.liquifyLand(p, "Liquify: restore all");
    }

    /**
     * The landing of a stroke: the tiles its change of the field reaches are baked from the session's source through the
     * whole field; a few here, more in the pool while the gesture is held (as a heal's blend). Returns whether it is held.
     */
    liquifyLand(p, label) {
        const liq = p.liq, px = p.layer.px;
        liq.field.prune(p.before);
        const keys = liq.field.changedTiles(p.before, Math.ceil(px.width / 256), Math.ceil(px.height / 256));
        if (!keys.size) { this.liquifyDrop(p, null); return false; }
        // every tile's nodes taken now: nothing that happens during a wait reaches the bake
        const nodes = new Map();
        for (const key of keys) nodes.set(key, liq.field.tileNodes(key & 0xFFFF, key >>> 16));
        const opts = { clamp: liq.clamp, blockMax: InpaintEditor.liquifyBlockMax || undefined };
        const t0 = performance.now();
        if (keys.size * 65536 <= InpaintEditor.liquifySyncMax) {
            let results = null;
            try { results = liq.orig.liquified(liq.s, nodes, opts); }
            catch (err) { console.warn("Inpaint Canvas: the liquify bake failed:", err); }
            if (results) this.liquifyCommit(p, results, keys, "here", t0, label, false);
            else this.liquifyDrop(p, "Liquify could not bake the stroke: nothing landed.");
            return false;
        }
        p.healing = true;
        this.pointer = p;
        this.setStatus("Liquifying...");
        const done = (async () => {
            let results = null;
            try { results = await liq.orig.liquifiedAsync(liq.s, nodes, opts); }
            catch (err) { console.warn("Inpaint Canvas: the liquify bake failed:", err); }
            if (this.pointer !== p) { this.freeLiquifyWindow(p); return; }   // the editor was closed meanwhile: the stroke was dropped there
            this.pointer = null;
            if (results) this.liquifyCommit(p, results, keys, "pool", t0, label, true);
            else this.liquifyDrop(p, "Liquify could not bake the stroke: nothing landed.");
        })();
        this.liquifyPending = done;
        this.trackEdit(done);
        done.finally(() => { if (this.liquifyPending === done) this.liquifyPending = null; });
        return true;
    }

    /**
     * Does the layer still hold what the session last left in every tile of `keys` (the tile guard)? On tiles every
     * write goes through `writable` (a new version, or a copy in the tile's place), `_share` or `_dropTile`, so a tile
     * that is the source's own, or the one the session last wrote at the version it wrote, is exactly that; on canvases
     * the pixels' version is all there is.
     */
    liquifyGuard(liq, keys) {
        const px = liq.px;
        if (!isTilePixels(px)) return px.version === liq.stamp;
        for (const key of keys) {
            const tx = key & 0xFFFF, ty = key >>> 16, t = px.tileAt(tx, ty), rec = liq.landed.get(key);
            if (rec) { if (t !== rec.tile || (t && t.version !== rec.version)) return false; }
            else if (t !== liq.orig.tileAt(tx, ty)) return false;
        }
        return true;
    }

    /** Write a baked stroke into its layer as one undo step. */
    liquifyCommit(p, results, keys, where, t0, label, tracked) {
        const liq = p.liq, layer = p.layer, px = layer.px;
        if (!this.layers.includes(layer) || layer.px !== liq.px || !this.liquifyGuard(liq, keys)) {
            this.liquifyDrop(p, this.layers.includes(layer) ? "The layer changed while Liquify was baking: nothing landed." : "The layer was deleted while Liquify was baking: nothing landed.");
            return;
        }
        // something else wrote the layer during the stroke (outside these tiles): this lands, the session starts again next time
        const clean = px.version === liq.stamp;
        // the stroke's tiles as runs along each row (a diagonal stroke across a 15k picture copied its bounding box: 60 MB of
        // a 384 MB budget for one stroke, measured), and the box around them for the layer's caches
        let box = null;
        const runs = [], sorted = Array.from(keys).sort((a, b) => a - b);
        for (let i = 0; i < sorted.length;) {
            const ty = sorted[i] >>> 16, tx0 = sorted[i] & 0xFFFF;
            let tx1 = tx0;
            while (i + 1 < sorted.length && sorted[i + 1] === ((ty << 16) | (tx1 + 1))) { i++; tx1++; }
            i++;
            const x = tx0 * 256, y = ty * 256, x1 = Math.min(px.width, (tx1 + 1) * 256), y1 = Math.min(px.height, y + 256);
            runs.push({ x, y, w: x1 - x, h: y1 - y });
            box = !box ? [x, y, x1, y1] : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x1), Math.max(box[3], y1)];
        }
        // the step first (the tiles as they are: the guard has just proved them the stroke's before), then the write
        let snap = p.made;
        if (!snap) {
            snap = this.snapshotRects(layer, runs, true);
            if (snap && !liq.ended) {
                snap.liq = { sid: liq.sid, cells: p.before };
                snap.liqBytes = this.liquifyCellBytes(p.before, liq.field.cells, liq.field);
                snap.bytes += snap.liqBytes;
            }
        }
        this.pushUndoSnapshot(snap, { tracked, label });
        px.putTiles(results, liq.orig);
        this.markLayerChanged(layer, box);
        liq.stamp = clean ? px.version : -1;
        if (isTilePixels(px)) for (const key of keys) { const t = px.tileAt(key & 0xFFFF, key >>> 16); liq.landed.set(key, { tile: t, version: t ? t.version : -1 }); }
        if (liq.ended) liq.orig.release();
        this.freeLiquifyWindow(p);
        this.releaseStrokeScratch();
        const ms = Math.round(performance.now() - t0);
        this.lastLiquify = { tiles: keys.size, box: [box[0] + layer.x, box[1] + layer.y, box[2] + layer.x, box[3] + layer.y], where, ms, stats: results.stats || null, s: liq.s };
        if (p.made) this.renderLayers(); else this.refreshLayerThumb(layer);
        this.pixelVersion++;
        this.draw();
        if (where !== "here") this.setStatus(`Liquified (${ms} ms).`);
    }

    /**
     * A stroke that lands nothing: the field goes back to where the stroke began, a copy of the base the press made goes
     * again (no step made it), and the preview leaves the screen.
     */
    liquifyDrop(p, why) {
        const liq = p.liq;
        if (p.tick) { clearInterval(p.tick); p.tick = null; }
        this.freeLiquifyWindow(p);
        liq.field = new LiquifyField(liq.field.w, liq.field.h, liq.s, new Map(p.before));
        if (p.freeze && p.freezeBefore && p.freezeBefore.size) {
            for (const [k, old] of p.freezeBefore) {
                if (old) p.freeze.cells.set(k, old);
                else p.freeze.cells.delete(k);
            }
            if (!p.freeze.cells.size && this.liqFreezes) this.liqFreezes.delete(p.layer.id);
            else this.liquifyVeilDirty(p.freeze, null);
        }
        if (p.made) {
            this.releaseSnapshot(p.made);
            if (this.layers.includes(p.layer)) {
                this.layers = this.layers.filter((l) => l !== p.layer);
                if (this.activeLayerId === p.layer.id) this.activeLayerId = null;
                // the copy's hold on the base's tiles goes with it (nothing else holds these pixels: no step made the layer)
                if (isTilePixels(p.layer.px)) p.layer.px.release();
                this.historyGen++;
                this.renderLayers();
                this.drawThumb();
                this.notifyChanged();
            }
            if (this.liq === liq) this.endLiquify();
        }
        if (liq.ended) liq.orig.release();
        this.releaseStrokeScratch();
        this.pixelVersion++;
        this.draw();
        if (why) this.setStatus(why);
    }

    /** An undo or redo put a liquify step back: the field goes with the pixels when the session is still the step's. */
    liquifyRestored(layer, snap) {
        const liq = this.liq;
        if (!liq || liq.sid !== snap.liq.sid || liq.layer !== layer || layer.px !== liq.px) return;
        liq.field = new LiquifyField(liq.field.w, liq.field.h, liq.s, new Map(snap.liq.cells));
        liq.stamp = layer.px.version;
        if (!isTilePixels(layer.px)) return;
        for (const s of snap.parts || [snap]) {
            for (let ty = s.y >> 8; ty <= (s.y + s.h - 1) >> 8; ty++) {
                for (let tx = s.x >> 8; tx <= (s.x + s.w - 1) >> 8; tx++) {
                    const t = layer.px.tileAt(tx, ty);
                    liq.landed.set((ty << 16) | tx, { tile: t, version: t ? t.version : -1 });
                }
            }
        }
    }

    /**
     * The freeze of `layer` (Liquify's mask of what stays, 5b): a byte per field node (0 free, 255 frozen) in cells per
     * tile, on the field's grid; kept per layer while the document is open, across tool switches and sessions; not in
     * undo, not in files. Made when `make`. A freeze of a layer that left the stack goes, and so does one whose layer got
     * other pixels (a flip, a turn, a crop: it would hold other content still) or whose grid changed. Its veil is one
     * canvas at a node a pixel (a coarser step above 2,048 on a side), redrawn where a dab touched it.
     */
    liquifyFreezeOf(layer, make = false) {
        const all = this.liqFreezes || (this.liqFreezes = new Map());
        for (const id of Array.from(all.keys())) if (!this.layers.some((l) => l.id === id)) all.delete(id);
        if (!layer || !layer.px) return null;
        const s = gridStep(this.width, this.height);
        let fr = all.get(layer.id) || null;
        if (fr && (fr.s !== s || fr.px !== layer.px || fr.w !== layer.px.width || fr.h !== layer.px.height)) { all.delete(layer.id); fr = null; }
        if (!fr && make) {
            const ls = Math.log2(s), nw = ((layer.px.width - 1) >> ls) + 2, nh = ((layer.px.height - 1) >> ls) + 2;
            const k = Math.max(1, Math.ceil(Math.max(nw, nh) / 2048));
            fr = { s, ls, n: 256 / s, px: layer.px, w: layer.px.width, h: layer.px.height, cells: new Map(),
                k, vw: Math.ceil(nw / k), vh: Math.ceil(nh / k), veil: null, dirty: null, drawn: 0 };
            all.set(layer.id, fr);
        }
        return fr;
    }

    /** A freeze's node, 0..255 (0 where no cell holds it). */
    liquifyFreezeAt(fr, i, j) {
        const sh = 8 - fr.ls, m = fr.n - 1, c = fr.cells.get(((j >> sh) << 16) | (i >> sh));
        return c ? c[(j & m) * fr.n + (i & m)] : 0;
    }

    /** The veil to be drawn again over nodes [i0, j0, i1, j1] (inclusive), or all of it. */
    liquifyVeilDirty(fr, box) {
        if (!box || fr.dirty === "all") { fr.dirty = "all"; return; }
        const d = fr.dirty;
        fr.dirty = !d ? box.slice() : [Math.min(d[0], box[0]), Math.min(d[1], box[1]), Math.max(d[2], box[2]), Math.max(d[3], box[3])];
    }

    /** A freeze or thaw dab at (x, y), layer pixel-index positions: freeze raises nodes to 255 w, thaw scales them by 1 - w. */
    liquifyFreezeDab(p, x, y) {
        const fr = p.freeze, s = fr.s, n = fr.n, sh = 8 - fr.ls, m = n - 1;
        const r = Math.max(2 * s, this.brushSize / 2), h = Math.min(0.8, Math.max(0, this.activeHardness()));
        const amount = Math.min(1, ((this.liquifyOpts ? this.liquifyOpts.strength : 50) / 100) * (p.pressure || 1));
        const ni = ((fr.w - 1) >> fr.ls) + 1, nj = ((fr.h - 1) >> fr.ls) + 1;
        const i0 = Math.max(0, Math.ceil((x - r) / s)), i1 = Math.min(ni, Math.floor((x + r) / s));
        const j0 = Math.max(0, Math.ceil((y - r) / s)), j1 = Math.min(nj, Math.floor((y + r) / s));
        const freeze = p.mode === "freeze", touched = new Set();
        let bi0 = Infinity, bj0 = Infinity, bi1 = -Infinity, bj1 = -Infinity;
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const w = amount * liquifyFalloff(Math.hypot(i * s - x, j * s - y) / r, h);
                if (!(w > 0)) continue;
                const key = ((j >> sh) << 16) | (i >> sh);
                let c = fr.cells.get(key);
                if (!c && !freeze) continue;
                const o = (j & m) * n + (i & m), old = c ? c[o] : 0;
                const v = freeze ? Math.max(old, Math.round(255 * w)) : Math.floor(old * (1 - w));
                if (v === old) continue;
                if (p.freezeBefore && !p.freezeBefore.has(key)) p.freezeBefore.set(key, c ? c.slice() : null);
                if (!c) { c = new Uint8Array(n * n); fr.cells.set(key, c); }
                c[o] = v; touched.add(key);
                if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
            }
        }
        if (!touched.size) return;
        for (const key of touched) if (!freeze && fr.cells.get(key).every((v) => !v)) fr.cells.delete(key);
        this.liquifyVeilDirty(fr, [bi0, bj0, bi1, bj1]);
        p.froze = true;
        // the veil is an overlay over the cached scene: a draw, not a new composite
        this.drawSoon();
    }

    /** Clear freeze (the options bar): every node of the active layer free again. */
    liquifyClearFreeze() {
        const layer = this.activeLayer(), fr = layer && this.liquifyFreezeOf(layer);
        if (!fr || !fr.cells.size) { this.setStatus("Nothing is frozen on this layer."); return; }
        this.liqFreezes.delete(layer.id);
        this.setStatus("Freeze cleared.");
        this.draw();
    }

    /** Invert freeze (the options bar): what was frozen is free and the rest of the layer frozen. */
    liquifyInvertFreeze() {
        const layer = this.activeLayer();
        const why = this.liquifyRefusal(layer);
        if (why || !layer) { this.setStatus(why || "Freeze works on a layer: pick one (on the base, Liquify first makes a copy of it).", "info"); return; }
        const fr = this.liquifyFreezeOf(layer, true), n = fr.n;
        const cx = (((fr.w - 1) >> fr.ls) + 1) >> (8 - fr.ls), cy = (((fr.h - 1) >> fr.ls) + 1) >> (8 - fr.ls);
        for (let ty = 0; ty <= cy; ty++) {
            for (let tx = 0; tx <= cx; tx++) {
                const key = (ty << 16) | tx, c = fr.cells.get(key) || new Uint8Array(n * n);
                for (let q = 0; q < c.length; q++) c[q] = 255 - c[q];
                if (c.every((v) => !v)) fr.cells.delete(key); else fr.cells.set(key, c);
            }
        }
        this.liquifyVeilDirty(fr, null);
        this.setStatus("Freeze inverted.");
        this.draw();
    }

    /** The freeze of the active layer as a red veil (image coordinates), while the tool is Liquify and Show freeze is on. */
    drawLiquifyFreeze(ctx) {
        if (this.tool !== "liquify" || !(this.liquifyOpts && this.liquifyOpts.showFreeze)) return;
        const layer = this.activeLayer(), fr = layer && this.liquifyFreezeOf(layer);
        if (!fr || !fr.cells.size) return;
        if (!fr.veil) { fr.veil = makeCanvas(fr.vw, fr.vh); fr.dirty = "all"; }
        if (fr.dirty) {
            // the touched part of the veil again: a node a pixel (every k-th node on a coarser veil), red at half its freeze
            const k = fr.k, d = fr.dirty;
            const a0 = d === "all" ? 0 : Math.max(0, Math.floor(d[0] / k)), b0 = d === "all" ? 0 : Math.max(0, Math.floor(d[1] / k));
            const a1 = d === "all" ? fr.vw - 1 : Math.min(fr.vw - 1, Math.floor(d[2] / k)), b1 = d === "all" ? fr.vh - 1 : Math.min(fr.vh - 1, Math.floor(d[3] / k));
            const w = a1 - a0 + 1, h = b1 - b0 + 1, img = new ImageData(w, h);
            for (let b = 0; b < h; b++) {
                for (let a = 0, o = b * w * 4; a < w; a++, o += 4) {
                    img.data[o] = 255;
                    img.data[o + 3] = this.liquifyFreezeAt(fr, (a0 + a) * k, (b0 + b) * k) >> 1;
                }
            }
            fr.veil.getContext("2d").putImageData(img, a0, b0);
            fr.dirty = null;
        }
        const half = fr.s / 2, S = fr.k * fr.s;
        ctx.save();
        ctx.beginPath();
        ctx.rect(layer.x, layer.y, layer.w, layer.h);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fr.veil, 0, 0, fr.vw, fr.vh, layer.x - half, layer.y - half, fr.vw * S, fr.vh * S);
        ctx.restore();
        fr.drawn++;
    }

    /** The live stroke of Liquify runs on `layer` (its preview is drawn in the screen's stroke scratch). */
    liquifyOn(layer) {
        const p = this.pointer;
        return !!(p && p.kind === "liquify" && p.layer === layer && p.strokeBox);
    }

    /** Release the stroke's window buffer (`liquifyWindow`), when it was allocated in wasm memory. */
    freeLiquifyWindow(p) {
        if (!p || !p.liqWin) return;
        const win = p.liqWin;
        p.liqWin = null;
        freeLiquifyWindow(win);
    }

    /**
     * The session's source at the view's level, over the view and a margin the field can reach, as one buffer: built once
     * per stroke (a pan or a zoom builds it again), so a frame samples an array, not the tiles.
     */
    liquifyWindow(p, vp) {
        const L = Math.max(0, Math.min(MIP_LEVELS, Math.floor(Math.log2(1 / vp.sx) + 1e-9)));
        const sig = [vp.x, vp.y, vp.w, vp.h, vp.sx, L].join(",");
        if (p.liqWin && p.liqWin.sig === sig) return p.liqWin;
        this.freeLiquifyWindow(p);
        const layer = p.layer, liq = p.liq, W = liq.field.w, H = liq.field.h, f = 1 << L;
        const M = Math.min(this.brushSize + liq.field.maxReach() + 64, 2048 * f);
        const lim = (v, hi) => Math.max(0, Math.min(hi, v));
        const x0 = lim(Math.floor(vp.x - layer.x - M), W), x1 = lim(Math.ceil(vp.x + vp.w - layer.x + M), W);
        const y0 = lim(Math.floor(vp.y - layer.y - M), H), y1 = lim(Math.ceil(vp.y + vp.h - layer.y + M), H);
        const lx0 = x0 >> L, ly0 = y0 >> L, w = Math.max(1, ((x1 + f - 1) >> L) - lx0), h = Math.max(1, ((y1 + f - 1) >> L) - ly0);
        const alloc = allocLiquifyWindow(w, h);
        const view = () => (alloc.px ? alloc.px.u8().subarray(alloc.ptr, alloc.ptr + alloc.bytes) : alloc.data);
        try {
            if (isTilePixels(liq.orig)) {
                const side = 256 >> L;
                for (let ty = Math.floor(ly0 / side); ty <= Math.floor((ly0 + h - 1) / side); ty++) {
                    for (let tx = Math.floor(lx0 / side); tx <= Math.floor((lx0 + w - 1) / side); tx++) {
                        const lb = liq.orig._levelBytes(tx, ty, L);
                        if (!lb || !lb.data) continue;
                        const data = view();
                        const a0 = Math.max(lx0, tx * side), a1 = Math.min(lx0 + w, tx * side + side);
                        const b0 = Math.max(ly0, ty * side), b1 = Math.min(ly0 + h, ty * side + side);
                        for (let b = b0; b < b1; b++) {
                            const so = lb.off + ((b - ty * side) * side + (a0 - tx * side)) * 4;
                            data.set(lb.data.subarray(so, so + (a1 - a0) * 4), ((b - ly0) * w + (a0 - lx0)) * 4);
                        }
                    }
                }
            } else {
                // the canvas backend: read once, averaged down to the level (premultiplied)
                const d = liq.orig.readRect(lx0 * f, ly0 * f, w * f, h * f).data, rw = w * f;
                const data = view();
                if (!L) data.set(d);
                else {
                    for (let b = 0; b < h; b++) {
                        for (let a = 0; a < w; a++) {
                            let A = 0, R = 0, G = 0, B = 0;
                            for (let v = 0; v < f; v++) for (let u = 0, q = ((b * f + v) * rw + a * f) * 4; u < f; u++, q += 4) {
                                const al = d[q + 3]; A += al; R += al * d[q]; G += al * d[q + 1]; B += al * d[q + 2];
                            }
                            const o = (b * w + a) * 4;
                            if (A) { data[o] = R / A + 0.5; data[o + 1] = G / A + 0.5; data[o + 2] = B / A + 0.5; data[o + 3] = A / (f * f) + 0.5; }
                        }
                    }
                }
            }
        } catch (err) {
            freeLiquifyWindow(alloc);
            throw err;
        }
        const data = view();
        p.liqWin = { sig, data, w, h, x0: lx0, y0: ly0, L, px: alloc.px, ptr: alloc.ptr, bytes: alloc.bytes };
        return p.liqWin;
    }

    /** The stroke's preview in the scratch's pixels [dx0, dy0, dx1, dy1): the source through the field as it is now. */
    drawLiquifyInto(ctx, layer, vp, [dx0, dy0, dx1, dy1]) {
        const p = this.pointer, sb = p && p.strokeBox;
        if (!sb) return;
        const u0 = Math.max(dx0, Math.floor((sb[0] - vp.x) * vp.sx)), v0 = Math.max(dy0, Math.floor((sb[1] - vp.y) * vp.sy));
        const u1 = Math.min(dx1, Math.ceil((sb[2] - vp.x) * vp.sx)), v1 = Math.min(dy1, Math.ceil((sb[3] - vp.y) * vp.sy));
        if (u1 <= u0 || v1 <= v0) return;
        try {
            const win = this.liquifyWindow(p, vp);
            const bw = u1 - u0, bh = v1 - v0, ox = vp.x + u0 / vp.sx - layer.x, oy = vp.y + v0 / vp.sy - layer.y;
            // a large box is sampled every f-th pixel and scaled up (a 1000 px brush at 1:1 took 57 ms a frame at full
            // resolution, measured at 15000 x 10000): softer while the button is down, the landing is the bake's anyway
            const f = Math.max(1, Math.ceil(Math.sqrt((bw * bh) / InpaintEditor.liquifyPreviewMax)));
            if (f === 1) {
                const img = new ImageData(bw, bh);
                liquifyPreview(win, p.liq.field, ox, oy, 1 / vp.sx, img.data, bw, bh);
                // putImageData ignores the transform and the clip: exactly these bytes, inside the part being redrawn
                ctx.putImageData(img, u0, v0);
                return;
            }
            const sw = Math.ceil(bw / f), sh = Math.ceil(bh / f), img = new ImageData(sw, sh);
            liquifyPreview(win, p.liq.field, ox, oy, f / vp.sx, img.data, sw, sh);
            let c = this._liqPreview;
            if (!c || c.width < sw || c.height < sh) { c = this._liqPreview = makeCanvas(Math.max(sw, c ? c.width : 0), Math.max(sh, c ? c.height : 0)); c._livePreview = true; }
            c.getContext("2d").putImageData(img, 0, 0);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            ctx.imageSmoothingEnabled = true;
            ctx.clearRect(u0, v0, bw, bh);
            ctx.drawImage(c, 0, 0, bw / f, bh / f, u0, v0, bw, bh);
            ctx.restore();
        } catch (err) {
            this.freeLiquifyWindow(p);
            throw err;
        }
    }
}

export function bindLiquify(C) { InpaintEditor = C; }
