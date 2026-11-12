// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_heal.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the heal brush, the patch tool, content-aware move, the remove tool and held edits: moved out of inpaint_canvas.js (item 56 S4, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { distTransform, poissonBlend as poissonBlendKernel } from "./px/kernels.js";
import { hexToRgb } from "./inpaint_raster.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { TILE_SIZE } from "./inpaint_tiles.js";
import { editorPool } from "./inpaint_jobs.js";
import { nextPartsSeq } from "./inpaint_encode.js";
import { fromModel, removeCrop, toModelImage, toModelMask } from "./inpaint_remove.js";
import { failKind, refusal } from "./inpaint_status.js";
import { REMOVE_MARK, cpuDab, patchMix } from "./inpaint_consts.js";
import { StrokeBuffer } from "./inpaint_strokebuf.js";

let InpaintEditor = null;

export class HealPart {
    /**
     * Heal at the release (PLAN_0_1_31 §5 step 2): the stroke's colours become the Poisson blend of the raw source patch
     * with the picture around the stroke (`poissonBlend`: the source's texture, the destination's colour and light
     * right up to the stroke's edge); the dabs' mean shift was only the preview. A stroke with up to `healSyncMax` pixels
     * to heal in a box of up to `healSyncBox` is blended here and the release goes on (false). A larger one goes to a
     * worker while the gesture stays held (the preview stays; presses, moves and shortcuts wait, an undo waits for it
     * through `trackEdit`) and commits when the blend lands (true), with the selection, the opacity, the alpha lock and
     * the box as they were at the release; without a worker the same kernel runs here. The quick heal lands as it was
     * on a scaled or fractionally placed layer, for a box above `healBlendMax`, and where the blend did not settle (info[3]:
     * a heal split into strands by the source's transparency, which the coarse grids join).
     */
    healBlend(p) {
        if (InpaintEditor.healBlend === false) return false;
        let job = null;
        try { job = this.healInputs(p); } catch (err) { console.warn("Inpaint Canvas: the heal could not read its box, keeping the quick heal:", err); }
        if (!job) return false;
        const t0 = performance.now();
        // what the last blend took, for tests and the status line: the box (image pixels), the source offset, the kernel's info
        const note = (where, info) => { this.lastHeal = { box: [job.x + p.layer.x, job.y + p.layer.y, job.w, job.h], off: job.off, unknowns: job.unknowns, where, info: info ? Array.from(info) : null, ms: Math.round(performance.now() - t0) }; };
        // the blend's colours, unless it did not settle (the quick heal stays then); a patch's Blend below 100 % mixes them
        // with the plain copy its buffer holds (`patchRun`)
        const land = (out, info, where) => {
            note(where, info);
            if (info && info[3]) { this.setStatus(`The blend did not settle here (the source splits the ${p.patch ? "patch" : "stroke"} into strands): the ${p.patch ? "plain copy" : "quick heal"} stays.`, "warn"); return; }
            if (p.patch && p.patch.blend < 1) patchMix(out, job.stroke.data, job.mask, p.patch.blend);
            this.healWrite(p, job, out);
        };
        if (job.unknowns <= InpaintEditor.healSyncMax && job.w * job.h <= InpaintEditor.healSyncBox) {
            const info = new Int32Array(4);
            try { land(poissonBlendKernel(job.dst, job.src, job.mask, job.w, job.h, null, info), info, "here"); }
            catch (err) { console.warn("Inpaint Canvas: the heal's blend failed, keeping the quick heal:", err); }
            return false;
        }
        p.healing = true;
        // what the commit reads, as it is now: the user has let go, and may deselect, move the opacity or nudge meanwhile
        // (a patch lands at full opacity: it set its own)
        if (p.opacity == null) p.opacity = this.brushOpacity;
        p.op = p.layer.alphaLock ? "source-atop" : "source-over";
        p.rect = this.strokeRect(p, p.layer.px);
        if (p.clip && this.sel) p.clipSel = this.sel.clone();
        this.pointer = p;
        this.setStatus(p.patch ? "Patching..." : "Healing...");
        const done = (async () => {
            let out = null, where = "worker", info = null;
            try {
                // the picture and the source go over (the transfer empties them here); the mask is copied, `healWrite` reads it
                const args = { dst: job.dst.buffer, src: job.src.buffer, mask: job.mask.slice().buffer, w: job.w, h: job.h };
                const m = await editorPool().run("poisson", args, [args.dst, args.src, args.mask], { priority: INTERACTIVE, group: "heal" + nextPartsSeq() });
                out = new Uint8Array(m.out);
                info = m.info;
            } catch (err) {
                // no worker (the pool is off, a worker was lost): the same kernel here, on inputs read again (the transfer took
                // them; the picture and the stroke are as they were, the gesture is held)
                if (this.pointer === p) {
                    console.warn("Inpaint Canvas: the heal's worker failed, blending here:", (err && err.message) || err);
                    try {
                        const again = this.healInputs(p);
                        if (again) { job = again; info = new Int32Array(4); out = poissonBlendKernel(job.dst, job.src, job.mask, job.w, job.h, null, info); where = "here"; }
                    } catch (err2) { console.warn("Inpaint Canvas: the heal's blend failed, keeping the quick heal:", err2); }
                }
            }
            if (this.pointer !== p) { if (p.clipSel) p.clipSel.release(); return; }   // the editor was closed meanwhile
            if (!this.layers.includes(p.layer)) {
                // the layer was deleted (or merged) from the panel meanwhile: nothing lands in a layer that is gone
                this.pointer = null;
                if (p.clipSel) { p.clipSel.release(); p.clipSel = null; }
                this.releaseStrokeScratch();
                this.historyGen++;
                this.draw();
                this.setStatus("The layer was deleted while the heal blended: nothing landed.");
                return;
            }
            let settled = false;
            try { if (out) { land(out, info, where); settled = !(info && info[3]); } }
            catch (err) { console.warn("Inpaint Canvas: the heal's blend could not be written, keeping the quick heal:", err); }
            this.pointer = null;
            try { this.commitLayerPaint(p); }
            finally { if (p.clipSel) { p.clipSel.release(); p.clipSel = null; } }
            this.draw();
            if (settled) this.setStatus(`${p.patch ? "Patched" : "Healed"} ${job.unknowns.toLocaleString()} px (${Math.round(performance.now() - t0)} ms).`);
        })();
        this.healPending = done;
        this.trackEdit(done);
        done.finally(() => { if (this.healPending === done) this.healPending = null; });
        return true;
    }

    /**
     * What the heal's blend needs over the stroke's box (the layer's pixels, which are the image's here: an unscaled layer
     * on whole pixels, else null): `dst` the picture before the stroke (it is not committed yet), `src` the raw source
     * patch (`healSource`), `mask` the stroke's coverage cut by the selection, and `stroke` the buffer's bytes the result
     * goes back into. The box is the stroke's extent and a pixel around it, the boundary the blend takes. Null when
     * nothing is covered or the box is above `healBlendMax`.
     */
    healInputs(p) {
        const layer = p.layer, s = p.stroke, cl = p.clone;
        if (!s || s.empty || !cl || !cl.dest || s.tw !== layer.w || s.th !== layer.h || layer.x !== Math.round(layer.x) || layer.y !== Math.round(layer.y)) return null;
        const x0 = Math.max(0, s.x - 1), y0 = Math.max(0, s.y - 1), x1 = Math.min(s.tw, s.x + s.w + 1), y1 = Math.min(s.th, s.y + s.h + 1);
        const w = x1 - x0, h = y1 - y0, n = w * h;
        if (w <= 0 || h <= 0 || n > InpaintEditor.healBlendMax) return null;
        const stroke = s.bytes(x0, y0, w, h);
        const sa = stroke.data, mask = new Uint8Array(n);
        let unknowns = 0;
        for (let k = 0; k < n; k++) if (sa[4 * k + 3]) mask[k] = 255;
        if (p.clip) {
            const c = this._healClip = this.clipCanvasFor(layer, layer.px, x0, y0, w, h, cpuDab(this._healClip, w, h), p.clipSel || this.sel);
            const ca = c.getContext("2d").getImageData(0, 0, w, h).data;
            for (let k = 0; k < n; k++) if (!ca[4 * k + 3]) mask[k] = 0;
        }
        for (let k = 0; k < n; k++) if (mask[k]) unknowns++;
        if (!unknowns) return null;
        const ix = x0 + layer.x, iy = y0 + layer.y;
        const guide = this.healSource(p, ix, iy, w, h);
        if (!guide) return null;
        // the preview sampled the source at the fraction, the blend at the whole pixel: where that one is clear (the
        // picture's edge, a cut-out's) there is nothing to blend, and the pixel keeps the quick heal's colour
        for (let k = 0; k < n; k++) if (mask[k] && !guide.bytes[4 * k + 3]) { mask[k] = 0; unknowns--; }
        if (!unknowns) return null;
        // bytes() hands out a buffer its next read reuses: copied at once (dest may be the source's own reader)
        const dst = new Uint8Array(cl.dest.bytes([ix, iy, ix + w, iy + h]));
        return { x: x0, y: y0, w, h, dst, src: guide.bytes, off: guide.off, mask, stroke, unknowns };
    }

    /**
     * The source patch under the box at (ix, iy), w x h image pixels, as the blend's guide ({ bytes, off }): the source at
     * the stroke's offset rounded to whole pixels (`off`; its bytes, not resampled: the dabs' preview sampled it at the
     * fraction), or drawn through the source's transform (`cloneXf`) as the dabs draw it (`off` null). Null when that
     * source box is above `healBlendMax`.
     */
    healSource(p, ix, iy, w, h) {
        const cl = p.clone, xf = cl.xf;
        if (!xf) {
            const ox = Math.round(cl.off.x), oy = Math.round(cl.off.y);
            // a patch read its guide once, over this box (`patchRun`): taken once (the worker's transfer empties it)
            const gd = cl.guide;
            if (gd) { cl.guide = null; if (gd.x === ix && gd.y === iy && gd.w === w && gd.h === h && gd.ox === ox && gd.oy === oy) return { off: [ox, oy], bytes: gd.bytes }; }
            const box = [ix + ox, iy + oy, ix + ox + w, iy + oy + h];
            return { off: [ox, oy], bytes: p.patch ? this.patchGuide(cl.src, box) : new Uint8Array(cl.src.bytes(box)) };
        }
        const S = cl.S, Dx = S.x - cl.off.x, Dy = S.y - cl.off.y, A = xf.A, Ai = xf.Ai;
        const q = [[ix, iy], [ix + w, iy], [ix, iy + h], [ix + w, iy + h]].map(([x, y]) => [S.x + A[0] * (x - Dx) + A[1] * (y - Dy), S.y + A[2] * (x - Dx) + A[3] * (y - Dy)]);
        const qx = q.map((v) => v[0]), qy = q.map((v) => v[1]);
        const sb = [Math.floor(Math.min(...qx)) - 2, Math.floor(Math.min(...qy)) - 2, Math.ceil(Math.max(...qx)) + 2, Math.ceil(Math.max(...qy)) + 2];
        if ((sb[2] - sb[0]) * (sb[3] - sb[1]) > InpaintEditor.healBlendMax) return null;
        const got = cl.src.read(sb, 0);
        const c = this._healSrc = cpuDab(this._healSrc, w, h), ctx = c.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        if (got) {
            // image point u of the box takes the source at q = S + A (u - D): the source canvas through Ai, as `cloneDab`
            const ox = got.x - S.x, oy = got.y - S.y;
            ctx.setTransform(Ai[0], Ai[2], Ai[1], Ai[3], Ai[0] * ox + Ai[1] * oy + Dx - ix, Ai[2] * ox + Ai[3] * oy + Dy - iy);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(got.canvas, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        return { off: null, bytes: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) };
    }

    /** The blend's colours into the stroke buffer where it healed, the buffer's alpha kept (it is the dabs' coverage). */
    healWrite(p, job, out) {
        const s = p.stroke, a = job.stroke.data, m = job.mask, w = job.w, h = job.h;
        for (let k = 0, n = w * h; k < n; k++) {
            if (!m[k]) continue;
            const o = 4 * k;
            a[o] = out[o]; a[o + 1] = out[o + 1]; a[o + 2] = out[o + 2];
        }
        if (!s.px) { s.canvas.getContext("2d").putImageData(job.stroke, job.x - s.cx, job.y - s.cy); return; }
        // on tiles only the tiles' worth of blocks it healed in: a write of the whole box would give the sparse buffer a
        // tile of zeros everywhere a diagonal stroke's box reaches
        const T = TILE_SIZE;
        for (let ty = Math.floor(job.y / T) * T; ty < job.y + h; ty += T) {
            for (let tx = Math.floor(job.x / T) * T; tx < job.x + w; tx += T) {
                const bx = Math.max(tx, job.x) - job.x, by = Math.max(ty, job.y) - job.y;
                const bw = Math.min(tx + T, job.x + w) - job.x - bx, bh = Math.min(ty + T, job.y + h) - job.y - by;
                let any = false;
                for (let y = by; y < by + bh && !any; y++) for (let x = bx; x < bx + bw; x++) if (m[y * w + x]) { any = true; break; }
                if (!any) continue;
                const blk = new ImageData(bw, bh);
                for (let y = 0; y < bh; y++) blk.data.set(a.subarray(((by + y) * w + bx) * 4, ((by + y) * w + bx + bw) * 4), y * bw * 4);
                s.px.writeRect(blk, job.x + bx, job.y + by);
            }
        }
    }

    /**
     * The words that refuse a patch on `layer` (the active one, null for the base), or null when it can go on. It
     * writes a layer's own pixels as the heal does (`healInputs`): not the mask or the selection the UI says is being
     * edited, not a locked, filter or text layer, and only a layer at its own size on whole pixels.
     */
    patchRefusal(layer, name = "Patch") {
        if (this.quickMask || (layer && layer.maskEdit)) return `${this.quickMask ? "Quick mask is on" : `The mask of ${layer.name} is being edited`}: ${name} works on pixels. ${this.quickMask ? "Press Q to leave it." : "Switch the mask edit off first."}`;
        if (!layer) return null;
        if (this.isLocked(layer)) return `${layer.name} is locked.`;
        if (layer.kind === "filter") return "Filter layers have no pixels. Select a paint or image layer.";
        if (layer.kind === "text") return "Text layers hold text, not pixels. Select a paint or image layer.";
        if (layer.px.width !== layer.w || layer.px.height !== layer.h || layer.x !== Math.round(layer.x) || layer.y !== Math.round(layer.y))
            return `${name} paints into a layer at its own size on whole pixels, and ${layer.name} is scaled or placed between pixels: pick another layer, or the base (${name} then paints into a new layer).`;
        return null;
    }

    /**
     * The selection as the patch takes it: `E` the extent of every pixel with alpha of at least `min` ([x0, y0, x1, y1],
     * image pixels; the move takes 128, what the ants show, the patch any alpha) and `selA` its alpha over E (row-major).
     * One read at the press: on tiles the extent is exact, on the canvas backend a padded box from the 1/16 level,
     * tightened here. Null without a selection; throws the status line's words above `healBlendMax`.
     */
    patchExtent(name = "Patch", min = 1) {
        if (!this.sel || !this.getBounds()) return null;
        const X = this.selectionExtent();
        if (!X) return null;
        const w0 = X[2] - X[0], h0 = X[3] - X[1], max = InpaintEditor.healBlendMax;
        const tooLarge = () => refusal(`${name} blends up to ${Math.round(max / 1048576)} MP of selection: ${name === "Patch" ? "patch" : "move"} it in parts.`, "warn");
        if (w0 * h0 > 2 * max) throw tooLarge();
        const d = this.sel.readRect(X[0], X[1], w0, h0).data;
        let x0 = w0, y0 = h0, x1 = -1, y1 = -1;
        for (let y = 0; y < h0; y++) {
            for (let x = 0, j = y * w0 * 4 + 3; x < w0; x++, j += 4) {
                if (d[j] < min) continue;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                y1 = y;
            }
        }
        if (x1 < 0) return null;
        const ew = x1 - x0 + 1, eh = y1 - y0 + 1;
        // the blend's box is the patch's plus the stroke buffer's margin (32 px on the canvas backend) and a pixel
        if ((ew + 70) * (eh + 70) > max) throw tooLarge();
        const selA = new Uint8Array(ew * eh);
        for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) selA[y * ew + x] = d[((y + y0) * w0 + x + x0) * 4 + 3];
        return { E: [X[0] + x0, X[1] + y0, X[0] + x1 + 1, X[1] + y1 + 1], selA };
    }

    /**
     * A press of the patch tool or the content-aware move inside the selection (PLAN_0_1_31 §5 step 4): the selection is
     * read once (`patchExtent`) and dragged as an offset. Patch Source (the default) repairs the selection with the
     * picture under the dragged outline; Destination copies what is selected to where it is dropped; Move moves it there
     * and fills its old place with LaMa; Extend copies it there. The offset stays inside the picture, and where the moved
     * box is written, inside the layer too; the work runs at the release (`patchRun`, `moveRun`).
     */
    patchPress(e, ix, iy) {
        const move = this.tool === "contentmove", name = move ? "Content-aware move" : "Patch";
        const mode = move ? (this.moveOpts && this.moveOpts.mode === "extend" ? "extend" : "move") : (this.patchOpts && this.patchOpts.mode === "destination" ? "destination" : "source");
        const layer = this.activeLayer();
        // the refusal and its kind (item 45): the layer's state plain, a missing model or a size red
        let why = this.patchRefusal(layer, name), whyKind = "info", got = null;
        if (!why && mode === "move" && !host.removeModel()) { why = "Content-aware move needs the LaMa model to fill the old place: download it in Settings › Helpers (in-app models), or set Mode to Extend."; whyKind = "warn"; }
        if (!why) {
            // the move takes the selection as the ants show it (alpha 128 and up) and lands it whole, its band blending the
            // edge: a feathered tail taken at full strength erased and copied what was selected by a few per cent
            try { got = this.patchExtent(name, move ? 128 : 1); } catch (err) { why = String((err && err.message) || err); whyKind = failKind(err); }
            if (!why && !got) why = `Nothing is selected to ${move ? "move" : "patch"}.`;
        }
        if (why) { this.setStatus(why, whyKind); return; }
        const E = got.E, ew = E[2] - E[0], eh = E[3] - E[1], span = Math.max(ew, eh);
        if (mode === "move" && span > InpaintEditor.removeMaxHole) { this.setStatus(`Content-aware move fills up to ${InpaintEditor.removeMaxHole.toLocaleString()} px across where the selection was, and this one spans ${span.toLocaleString()} px: move it in parts, or use Extend.`, "warn"); return; }
        const lim = [0, 0, this.width, this.height];
        if (layer) {
            const L = [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h];
            // written where the selection is: the spot (Source) or the old place (Move)
            if ((mode === "source" || mode === "move") && (E[0] < L[0] || E[1] < L[1] || E[2] > L[2] || E[3] > L[3])) { this.setStatus(`The selection reaches past ${layer.name}: pick a layer that covers it, or the base.`); return; }
            // written where it is dropped: inside the layer too
            if (mode !== "source") { lim[0] = Math.max(0, L[0]); lim[1] = Math.max(0, L[1]); lim[2] = Math.min(this.width, L[2]); lim[3] = Math.min(this.height, L[3]); }
        }
        if (lim[2] - lim[0] < ew || lim[3] - lim[1] < eh) { this.setStatus(`The selection is larger than ${layer ? layer.name : "the picture"}: there is nowhere to ${move ? "move" : "copy"} it to.`, "warn"); return; }
        // the preview reads the picture as it is now; above `patchPreviewMax` only the outline follows
        let src = null, maskC = null, ghost = null;
        if (ew * eh <= InpaintEditor.patchPreviewMax) {
            src = this.brushSource("all", layer);
            // on the CPU as the preview it is drawn into (a GPU canvas there was a readback at every offset)
            maskC = cpuDab(null, ew, eh);
            const mi = new ImageData(ew, eh);
            for (let k = 0; k < ew * eh; k++) mi.data[4 * k + 3] = move ? (got.selA[k] >= 128 ? 255 : 0) : got.selA[k];
            maskC.getContext("2d").putImageData(mi, 0, 0);
            if (mode !== "source") ghost = this.patchPiece(src, E, maskC);
        } else this.setStatus(`A large selection: the outline follows the drag, the ${move ? "move" : "patch"} shows when you let go.`);
        this.pointer = { kind: "patchdrag", tool: move ? "contentmove" : "patch", mode, start: [ix, iy], startPx: this.toCanvasPx(e), d: [0, 0], moved: false, E, selA: got.selA, lim, src, maskC, ghost, prevD: null };
    }

    /** The picture over `box` (inside it) cut to the selection's shape (`maskC`, the box's size), as a canvas of the box. */
    patchPiece(src, box, maskC) {
        const w = box[2] - box[0], h = box[3] - box[1];
        const c = this._patchPrev = cpuDab(this._patchPrev, w, h), ctx = c.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        const got = src.read(box, 1);
        if (got) ctx.drawImage(got.canvas, got.x - box[0], got.y - box[1]);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(maskC, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        return c;
    }

    /** The drag: a whole-pixel offset, once the pointer has moved 3 screen pixels, clamped so the moved box stays inside `lim`. */
    patchDrag(p, e, ix, iy) {
        const [cx, cy] = this.toCanvasPx(e);
        if (!p.moved && Math.hypot(cx - p.startPx[0], cy - p.startPx[1]) <= 3) return;
        p.moved = true;
        const E = p.E, L = p.lim;
        p.d = [Math.min(L[2] - E[2], Math.max(L[0] - E[0], Math.round(ix - p.start[0]))), Math.min(L[3] - E[3], Math.max(L[1] - E[1], Math.round(iy - p.start[1])))];
    }

    /**
     * The drag's preview, in image coordinates under the view: Source shows the picture the outline covers inside the
     * selection (read again when the offset changes), Destination the selected piece where it would land.
     */
    drawPatchPreview(ctx, p) {
        if (!p.src) return;
        const E = p.E, [dx, dy] = p.d;
        ctx.save();
        ctx.imageSmoothingEnabled = this.view.scale < 1;
        if (p.mode === "source") {
            if (!p.prevD || p.prevD[0] !== dx || p.prevD[1] !== dy) { this.patchPiece(p.src, [E[0] + dx, E[1] + dy, E[2] + dx, E[3] + dy], p.maskC); p.prevD = [dx, dy]; }
            if (p.moved) ctx.drawImage(this._patchPrev, E[0], E[1]);
        } else if (p.ghost && p.moved) {
            ctx.globalAlpha = 0.85;
            ctx.drawImage(p.ghost, E[0] + dx, E[1] + dy);
        }
        ctx.restore();
    }

    /** The drag ends: nothing happens without a move (a click, a cancel), else the patch runs. */
    patchRelease(p, e) {
        try {
            if (e && e.type === "pointercancel") { this.setStatus(`${p.tool === "contentmove" ? "Move" : "Patch"} cancelled.`); return; }
            if (!p.moved || (!p.d[0] && !p.d[1])) {
                this.setStatus(p.mode === "source" ? "Drag the selection to where the picture is right: the spot is patched from there when you let go." : p.mode === "move" ? "Drag the selection to where it should go." : "Drag the selection to where the copy should go.");
                return;
            }
            if (p.tool === "contentmove") this.moveRun(p); else this.patchRun(p);
        } finally { this.patchDone(p); }
    }

    /**
     * A patch's guide over `box` ([x0, y0, x1, y1] image pixels, the offset already added) as bytes of its own: the
     * picture through the reader `R`, and past the picture's edge the nearest pixel inside it. The heal's ring there would
     * read a clear source and hold nothing (Neumann), and a patch dragged against the picture's edge left that side
     * unanchored: a straight step of 2 to 3 levels across a smooth sky (the review of step 4a).
     */
    patchGuide(R, box) {
        const W = this.width, H = this.height, w = box[2] - box[0], h = box[3] - box[1];
        if (box[0] >= 0 && box[1] >= 0 && box[2] <= W && box[3] <= H) return new Uint8Array(R.bytes(box));
        const c = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(W, box[2]), Math.min(H, box[3])];
        const out = new Uint8Array(w * h * 4);
        if (c[2] <= c[0] || c[3] <= c[1]) return out;
        // bytes() hands out a buffer its next read reuses: used up here
        const got = R.bytes(c), cw = c[2] - c[0], left = c[0] - box[0], right = box[2] - c[2];
        for (let y = 0; y < h; y++) {
            const s = (Math.min(c[3] - 1, Math.max(c[1], box[1] + y)) - c[1]) * cw * 4, o = y * w * 4;
            out.set(got.subarray(s, s + cw * 4), o + left * 4);
            for (let x = 0; x < left; x++) out.set(got.subarray(s, s + 4), o + x * 4);
            for (let x = 0; x < right; x++) out.set(got.subarray(s + (cw - 1) * 4, s + cw * 4), o + (left + cw + x) * 4);
        }
        return out;
    }

    /** What a patch drag held for its preview, given back. */
    patchDone(p) {
        if (p.src && p.src.release) p.src.release();
        p.src = null; p.ghost = null; p.maskC = null;
    }

    /**
     * The patch at the release, on the heal's machinery: a stroke buffer on the target layer (a new paint layer on the
     * base) holds the plain copy of the donor (`D`, the picture at the target box + `off`) with the selection's alpha
     * (`selA`) as its coverage, and `healBlend` lays the Poisson blend of the donor with the picture around the target
     * over it (at the release, or in a worker with the gesture held), `patchMix` pulls it back by Blend, and the commit
     * is the stroke's: one "Patch" step, the soft edge applied once through the buffer's alpha (no clip: the coverage is
     * the buffer's). Source: target = the selection, donor at +d; Destination: target = the selection moved by d, donor
     * the selection itself. The selection stays where it is.
     */
    patchRun(p) {
        let layer = this.activeLayer();
        // a key during the drag may have changed what the press checked (quick mask, the active layer)
        const why = this.patchRefusal(layer);
        if (why) { this.setStatus(why, "info"); return; }
        const E = p.E, [dx, dy] = p.d, ew = E[2] - E[0], eh = E[3] - E[1];
        const dest = p.mode === "destination";
        const T = dest ? [E[0] + dx, E[1] + dy, E[2] + dx, E[3] + dy] : E.slice();
        const off = dest ? [-dx, -dy] : [dx, dy];
        if (layer && (T[0] < layer.x || T[1] < layer.y || T[2] > layer.x + layer.w || T[3] > layer.y + layer.h)) { this.setStatus(`The patch reaches past ${layer.name}: pick a layer that covers it, or the base.`); return; }
        const R = this.brushSource("all", layer);
        // the donor is read once, over the box the heal's blend will ask its guide for (`healInputs`: the stroke buffer's
        // extent, the target padded by the buffer's margin, and a pixel; inside the layer, the picture for a new one), and
        // handed to `healSource` with the offset; the plain copy is cut out of it
        const PAD = (this.pixels && this.pixels.tiles ? 2 : 32) + 1;
        const Lr = layer ? [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h] : [0, 0, this.width, this.height];
        const G = [Math.max(Lr[0], T[0] - PAD), Math.max(Lr[1], T[1] - PAD), Math.min(Lr[2], T[2] + PAD), Math.min(Lr[3], T[3] + PAD)];
        const gw = G[2] - G[0], gh = G[3] - G[1];
        const B = this.patchGuide(R, [G[0] + off[0], G[1] + off[1], G[2] + off[0], G[3] + off[1]]);
        const Q = new ImageData(ew, eh), q = Q.data, selA = p.selA;
        let any = 0;
        for (let y = 0; y < eh; y++) {
            for (let x = 0, k = y * ew, o = 4 * k, b = ((T[1] - G[1] + y) * gw + T[0] - G[0]) * 4; x < ew; x++, k++, o += 4, b += 4) {
                const a = selA[k] ? Math.round(B[b + 3] * selA[k] / 255) : 0;
                if (!a) continue;
                q[o] = B[b]; q[o + 1] = B[b + 1]; q[o + 2] = B[b + 2]; q[o + 3] = a;
                any++;
            }
        }
        if (!any) { this.setStatus("Nothing to patch from there: the picture is clear where the selection was dragged."); return; }
        if (!layer) layer = this.addPaintLayer();
        const quick = this._patchQuick = cpuDab(this._patchQuick, ew, eh);
        quick.getContext("2d").putImageData(Q, 0, 0);
        const lx = T[0] - layer.x, ly = T[1] - layer.y;
        const stroke = new StrokeBuffer(layer.px, this.pixels);
        stroke.draw(lx, ly, lx + ew, ly + eh, (ctx) => { ctx.imageSmoothingEnabled = false; ctx.drawImage(quick, lx, ly); });
        const blend = Math.max(0, Math.min(100, +((this.patchOpts || {}).blend ?? 100))) / 100;
        const g = { kind: "layerpaint", layer, stroke, clip: null, erase: false, last: [T[0], T[1]], opacity: 1, previewAlpha: 1, patch: { mode: p.mode, blend },
            clone: { src: R, dest: R, off: { x: off[0], y: off[1] }, heal: true, S: null, xf: null, guide: { x: G[0], y: G[1], w: gw, h: gh, ox: off[0], oy: off[1], bytes: B } } };
        this.strokeBounds(g, T[0], T[1], T[2], T[3], 0);
        this.strokeDirty(g, T[0], T[1], T[2], T[3], 0);
        // Blend 0 is the plain copy; else the heal's blend lands over it (here, or held in a worker until it commits)
        if (blend > 0 && this.healBlend(g)) return;
        this.commitLayerPaint(g);
        // what landed (not the new layer's line), unless the blend said it did not settle
        const h = this.lastHeal;
        if (!blend) this.setStatus(`Patched ${any.toLocaleString()} px (copied as it is: Blend 0 %).`);
        else if (!(h && h.info && h.info[3] && h.off && h.off[0] === off[0] && h.off[1] === off[1])) this.setStatus(`Patched ${any.toLocaleString()} px.`);
    }

    /**
     * The content-aware move at the release (PLAN_0_1_31 §5 step 4b): the selected piece lands at E + d with a band inside
     * its edge blended into the new place (`moveSeam`; its core lands byte for byte), and with Move its old place is
     * filled by LaMa from what surrounds it (Extend leaves it). Everything is read here (`moveInputs`); the gesture is
     * held as a Remove's while the model and the seam run (`p.remove` makes `close()` and `dropStroke` treat it so: the
     * stroke buffer shows the piece where it goes and the mark where the fill will be, half transparent), and it commits
     * as one step, "Content-aware move" or "Content-aware extend", into the active layer (a new paint layer on the base),
     * or nothing lands. The selection stays where it was.
     */
    moveRun(p) {
        let layer = this.activeLayer();
        const why = this.patchRefusal(layer, "Content-aware move");
        if (why) { this.setStatus(why, "info"); return; }
        const extend = p.mode === "extend";
        if (!extend && !host.removeModel()) { this.setStatus("Content-aware move needs the LaMa model to fill the old place: download it in Settings › Helpers (in-app models), or set Mode to Extend.", "warn"); return; }
        const t0 = performance.now();
        let job = null;
        try { job = this.moveInputs(p, layer); } catch (err) { this.setStatus(String((err && err.message) || err), failKind(err)); return; }
        if (!job) { this.setStatus("Nothing to move: the picture is clear where the selection is."); return; }
        job.whole = (this.moveOpts || {}).blend === "all";
        const made = !layer;
        if (made) layer = this.addPaintLayer();
        const { E, ew, eh, U, uw, uh, pm, piece, hole } = job;
        // the layer's place at the release: the buffer, the writes and the commit's box stay in its pixels if the layer is
        // moved while the model runs (the writes read it live before, and the mark landed where they missed it)
        const org = job.org = [layer.x, layer.y];
        const stroke = new StrokeBuffer(layer.px, this.pixels);
        // the quick version: the mark where the fill will go, then the piece where it lands over it
        const put = (img, box) => {
            const c = this._patchQuick = cpuDab(this._patchQuick, img.width, img.height);
            c.getContext("2d").putImageData(img, 0, 0);
            const lx = box[0] - org[0], ly = box[1] - org[1];
            stroke.draw(lx, ly, lx + img.width, ly + img.height, (ctx) => { ctx.imageSmoothingEnabled = false; ctx.drawImage(c, lx, ly); });
        };
        if (hole) {
            const m = new ImageData(ew, eh), [mr, mg, mb] = hexToRgb(REMOVE_MARK);
            for (let k = 0, o = 0; k < ew * eh; k++, o += 4) if (hole.mask[k]) { m.data[o] = mr; m.data[o + 1] = mg; m.data[o + 2] = mb; m.data[o + 3] = 255; }
            put(m, E);
        }
        const pv = new ImageData(uw, uh);
        for (let k = 0, o = 0; k < uw * uh; k++, o += 4) if (pm[k]) { pv.data[o] = piece[o]; pv.data[o + 1] = piece[o + 1]; pv.data[o + 2] = piece[o + 2]; pv.data[o + 3] = piece[o + 3]; }
        put(pv, U);
        const q = { kind: "layerpaint", layer, stroke, clip: null, erase: false, last: [job.T[0], job.T[1]], opacity: 1, previewAlpha: 0.5,
            move: { mode: p.mode }, remove: { src: job.R, sample: "all", made } };
        for (const b of hole ? [E, U] : [U]) { this.strokeBounds(q, b[0], b[1], b[2], b[3], 0); this.strokeDirty(q, b[0], b[1], b[2], b[3], 0); }
        // two places far apart: the undo step copies each of them, not the box around both (a move across a 15k picture
        // made one step of 533 MB by the budget's count, and every step before it went)
        const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
        if (hole && area([Math.min(E[0], U[0]), Math.min(E[1], U[1]), Math.max(E[2], U[2]), Math.max(E[3], U[3])]) > area(E) + area(U))
            q.undoBoxes = [E, U].map((b) => [b[0] - org[0], b[1] - org[1], b[2] - org[0], b[3] - org[1]]);
        // held as a Remove's: presses, moves and shortcuts wait, an undo waits for it (`trackEdit`)
        q.healing = true;
        q.op = layer.alphaLock ? "source-atop" : "source-over";
        q.rect = this.strokeRect(q, layer.px);
        this.pointer = q;
        this.setStatus(extend ? "Extending..." : this._removeReady ? "Moving..." : "Moving (the first run loads LaMa, about 10 s)...");
        const done = (async () => {
            let error = null, filled = null, seam = null, res = null;
            try {
                if (hole) {
                    res = await host.removeInApp(this, { image: hole.image, mask: hole.modelMask });
                    if (!res || !res.image) throw new Error("the model gave no picture");
                    this._removeReady = true;
                    filled = fromModel(res.image, hole.crop, { x: E[0], y: E[1], w: ew, h: eh }, hole.mask, hole.pic);
                }
                if (this.pointer === q) seam = await this.moveSeam(job, filled);
            } catch (err) { error = err; }
            if (this.pointer !== q) return;   // the editor was closed: `close` dropped it
            this.pointer = null;
            // the layer was deleted (or merged) from the panel meanwhile: nothing lands in a layer that is gone
            if (!this.layers.includes(layer)) error = error || new Error("the layer was deleted meanwhile");
            let wrote = false;
            try {
                if (!error && seam) { this.moveWrite(q, job, filled, seam.out); this.commitLayerPaint(q); wrote = true; }
            } catch (err) {
                error = error || err;
                console.warn("Inpaint Canvas: the content-aware move could not write its result:", err);
            }
            // nothing landed: an undo pressed while it waited (`trackEdit`) must not take back the edit before it
            if (!wrote) { this.dropStroke(q); this.historyGen++; }
            const why = error ? String((error && error.message) || error).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "") : null;
            // `box`: where the piece landed and the pixel around it (image pixels, x y w h), `hole` the old place (Move)
            this.lastMove = { box: [U[0], U[1], uw, uh], hole: hole ? [E[0], E[1], ew, eh] : null, off: job.d.slice(), mode: p.mode, blend: job.whole ? "all" : "edge", crop: hole ? hole.crop.slice() : null,
                band: seam ? seam.band : null, unknowns: seam ? seam.unknowns : null, where: seam ? seam.where : null, info: seam ? seam.info : null, wrote, ms: Math.round(performance.now() - t0), error: why };
            this.draw();
            const unsettled = seam && seam.info && seam.info[3];
            this.setStatus(!wrote ? `Content-aware move failed: ${why}` : unsettled ? `${extend ? "Extended" : "Moved"}, but its edge did not blend here (the picture splits it into strands): the piece lands as it was.`
                : `${extend ? "Extended" : "Moved"} ${job.pn.toLocaleString()} px (${((performance.now() - t0) / 1000).toFixed(1)} s).`, !wrote ? "error" : unsettled ? "warn" : "info");
        })();
        this.removePending = done;
        this.trackEdit(done);
        done.finally(() => { if (this.removePending === done) this.removePending = null; });
    }

    /**
     * What the content-aware move reads at the release, from the visible picture: `U` the box where the piece lands and a
     * pixel around it (inside the picture and the layer), `base` the picture there, `piece` the picture at U - d (the
     * piece with its old surroundings; past the picture's edge the edge repeated, `patchGuide`), `pm` where the piece lands
     * (the selection moved, alpha 128 and up, where the piece is not clear); with Move the hole (the selection where it is,
     * by the same rule) and the model's
     * input over its crop (`removeCrop`, as Remove's). Null when nothing lands; throws the status line's words.
     */
    moveInputs(p, layer) {
        const E = p.E, [dx, dy] = p.d, ew = E[2] - E[0], eh = E[3] - E[1], W = this.width, H = this.height, selA = p.selA;
        const T = [E[0] + dx, E[1] + dy, E[2] + dx, E[3] + dy];
        const Lr = layer ? [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h] : [0, 0, W, H];
        const inside = (b) => b[0] >= Lr[0] && b[1] >= Lr[1] && b[2] <= Lr[2] && b[3] <= Lr[3];
        if (layer && (!inside(T) || (p.mode === "move" && !inside(E)))) throw new Error(`The move reaches past ${layer.name}: pick a layer that covers it, or the base.`);
        const R = this.brushSource("all", layer);
        const U = [Math.max(Lr[0], 0, T[0] - 1), Math.max(Lr[1], 0, T[1] - 1), Math.min(Lr[2], W, T[2] + 1), Math.min(Lr[3], H, T[3] + 1)];
        const uw = U[2] - U[0], uh = U[3] - U[1];
        // bytes() hands out a buffer its next read reuses: copied at once
        const base = new Uint8Array(R.bytes(U));
        const piece = this.patchGuide(R, [U[0] - dx, U[1] - dy, U[2] - dx, U[3] - dy]);
        const pm = new Uint8Array(uw * uh);
        let pn = 0;
        for (let y = 0; y < uh; y++) {
            const ey = U[1] + y - dy - E[1];
            if (ey < 0 || ey >= eh) continue;
            for (let x = 0; x < uw; x++) {
                const ex = U[0] + x - dx - E[0], k = y * uw + x;
                if (ex < 0 || ex >= ew || selA[ey * ew + ex] < 128 || !piece[4 * k + 3]) continue;
                pm[k] = 255;
                pn++;
            }
        }
        if (!pn) return null;
        let hole = null;
        if (p.mode === "move") {
            const crop = removeCrop(E, W, H), cw = crop[2] - crop[0], ch = crop[3] - crop[1];
            const mask = new Uint8Array(ew * eh), holeCrop = new Uint8Array(cw * ch);
            for (let y = 0; y < eh; y++) {
                for (let x = 0; x < ew; x++) {
                    if (selA[y * ew + x] < 128) continue;
                    mask[y * ew + x] = 255;
                    holeCrop[(E[1] + y - crop[1]) * cw + E[0] + x - crop[0]] = 255;
                }
            }
            const C = R.bytes(crop);
            // the picture over the hole's box: the fill replaces it where the mask is (`fromModel` keeps the rest)
            const pic = new Uint8Array(ew * eh * 4);
            for (let y = 0; y < eh; y++) { const s = ((E[1] + y - crop[1]) * cw + E[0] - crop[0]) * 4; pic.set(C.subarray(s, s + ew * 4), y * ew * 4); }
            hole = { crop, mask, pic, image: toModelImage(C, cw, ch), modelMask: toModelMask(holeCrop, cw, ch) };
        }
        return { E, ew, eh, d: [dx, dy], T, U, uw, uh, base, piece, pm, pn, hole, R };
    }

    /**
     * The move's seam over U: the new place as it will be (`base`, with the fill where the old place reaches into it), a
     * band `b` px wide inside the piece's edge blended by `poissonBlend` with the piece's gradients (u = the new place
     * minus the piece's old surroundings on the ring outside, 0 at the core), the core the piece's own bytes. Here up to
     * the heal's limits (`healSyncMax`, `healSyncBox`), else in a worker. `out` is U's bytes: the blend in the band, the
     * piece in the core, the new place outside the piece; where the blend did not settle the piece lands as it is.
     */
    async moveSeam(job, filled) {
        const { E, ew, eh, U, uw, uh, base, piece, pm, hole } = job, n = uw * uh;
        const dstP = base;
        if (filled) {
            for (let y = 0; y < uh; y++) {
                const ey = U[1] + y - E[1];
                if (ey < 0 || ey >= eh) continue;
                for (let x = 0; x < uw; x++) {
                    const ex = U[0] + x - E[0];
                    if (ex < 0 || ex >= ew || !hole.mask[ey * ew + ex]) continue;
                    const s = (ey * ew + ex) * 4, o = (y * uw + x) * 4;
                    dstP[o] = filled[s]; dstP[o + 1] = filled[s + 1]; dstP[o + 2] = filled[s + 2]; dstP[o + 3] = filled[s + 3];
                }
            }
        }
        // Blend "edge": a tenth of the shorter side, 4 to 32 px, wide enough to hide a change of light, narrow enough to
        // keep the object; "all" (`job.whole`): the whole piece, Patch Destination's blend
        const b = job.whole ? null : Math.max(4, Math.min(32, Math.round(Math.min(ew, eh) / 10))), b2 = b * b;
        const d2 = job.whole ? null : distTransform(pm.map((v) => (v ? 0 : 255)), uw, uh);
        const dst = dstP.slice(), mask = new Uint8Array(n);
        let unknowns = 0;
        for (let k = 0; k < n; k++) {
            if (!pm[k]) continue;
            if (!d2 || d2[k] <= b2) { mask[k] = 255; unknowns++; continue; }
            const o = 4 * k;
            dst[o] = piece[o]; dst[o + 1] = piece[o + 1]; dst[o + 2] = piece[o + 2]; dst[o + 3] = piece[o + 3];
        }
        let out = dst, info = new Int32Array(4), where = "here";
        if (unknowns && unknowns <= InpaintEditor.healSyncMax && n <= InpaintEditor.healSyncBox) out = poissonBlendKernel(dst, piece, mask, uw, uh, null, info);
        else if (unknowns) {
            where = "worker";
            try {
                // copies go over (the transfer empties them): the originals stay for the fallback here
                const args = { dst: dst.slice().buffer, src: piece.slice().buffer, mask: mask.slice().buffer, w: uw, h: uh };
                const m = await editorPool().run("poisson", args, [args.dst, args.src, args.mask], { priority: INTERACTIVE, group: "move" + nextPartsSeq() });
                out = new Uint8Array(m.out);
                info = m.info;
            } catch (err) {
                console.warn("Inpaint Canvas: the move's seam could not run in a worker, blending here:", (err && err.message) || err);
                where = "here";
                info = new Int32Array(4);
                out = poissonBlendKernel(dst, piece, mask, uw, uh, null, info);
            }
        }
        // a blend that did not settle: the piece lands as it is, its band too
        if (info && info[3]) {
            out = dst;
            for (let k = 0; k < n; k++) if (mask[k]) { const o = 4 * k; out[o] = piece[o]; out[o + 1] = piece[o + 1]; out[o + 2] = piece[o + 2]; out[o + 3] = piece[o + 3]; }
        }
        // where the piece lands over its own old place the buffer holds the hole's alpha, 255: a piece pixel that is not
        // opaque (a picture with transparency) lies over the fill there, not in place of it
        if (hole) {
            for (let y = 0; y < uh; y++) {
                const ey = U[1] + y - E[1];
                if (ey < 0 || ey >= eh) continue;
                for (let x = 0; x < uw; x++) {
                    const k = y * uw + x, a = piece[4 * k + 3], ex = U[0] + x - E[0];
                    if (!pm[k] || a === 255 || ex < 0 || ex >= ew || !hole.mask[ey * ew + ex]) continue;
                    for (let o = 4 * k; o < 4 * k + 3; o++) out[o] = Math.round((out[o] * a + dstP[o] * (255 - a)) / 255);
                }
            }
        }
        return { out, info: Array.from(info || []), where, band: b, unknowns };
    }

    /**
     * The move's result into its stroke buffer, in two parts (a long move never makes a scratch of the union): the old
     * place (Move) takes the fill outside U, then U takes the seam's bytes where the piece lands and where the old place
     * reaches into it. `removeWrite` keeps the buffer's alpha (255 on the hole, the piece's own on the piece).
     */
    moveWrite(q, job, filled, out) {
        const { E, ew, eh, U, uw, uh, pm, hole } = job, [ox, oy] = job.org, s = q.stroke;
        if (hole) {
            const maskE = new Uint8Array(ew * eh);
            for (let y = 0; y < eh; y++) {
                const iy = E[1] + y, inU = iy >= U[1] && iy < U[3];
                for (let x = 0; x < ew; x++) {
                    const k = y * ew + x, ix = E[0] + x;
                    if (hole.mask[k] && !(inU && ix >= U[0] && ix < U[2])) maskE[k] = 255;
                }
            }
            const x = E[0] - ox, y = E[1] - oy;
            this.removeWrite(q, { x, y, w: ew, h: eh, stroke: s.bytes(x, y, ew, eh), mask: maskE, cover: maskE }, filled);
        }
        const maskU = new Uint8Array(uw * uh);
        for (let y = 0; y < uh; y++) {
            for (let x = 0; x < uw; x++) {
                const k = y * uw + x;
                if (pm[k]) { maskU[k] = 255; continue; }
                if (!hole) continue;
                const ex = U[0] + x - E[0], ey = U[1] + y - E[1];
                if (ex >= 0 && ex < ew && ey >= 0 && ey < eh && hole.mask[ey * ew + ex]) maskU[k] = 255;
            }
        }
        // read after the old place's write: its blocks reach into U, and a read before it would write the mark back
        const x = U[0] - ox, y = U[1] - oy;
        this.removeWrite(q, { x, y, w: uw, h: uh, stroke: s.bytes(x, y, uw, uh), mask: maskU, cover: maskU }, out);
    }

    /**
     * Remove at the release (PLAN_0_1_31 §5 step 3): the stroke marked a hole; the in-app LaMa model fills it from the
     * picture around it (`removeInputs`: a crop around the hole scaled to the model's 512 x 512), the fill is sampled back
     * at the hole's pixels (`fromModel`) and written into the stroke buffer (`removeWrite`), which commits as a stroke:
     * the buffer's alpha (the dabs' coverage) feathers the fill's edge, one undo step. The model runs in the main
     * process's worker thread (about 1.5 s, the first run of a session also loads it, about 9 s), and the gesture stays
     * held meanwhile as a heal's in a worker (`healBlend`): the mark stays, presses, moves and shortcuts wait, an undo
     * waits for it (`trackEdit`), and the selection, the alpha lock and the box are frozen at the release. Without an
     * answer (no model, an error, the editor closed) nothing lands (`dropStroke`).
     */
    removeRun(p) {
        const t0 = performance.now();
        let job = null;
        try { job = this.removeInputs(p); }
        catch (err) { this.dropStroke(p); this.setStatus(String((err && err.message) || err), failKind(err)); return; }
        if (!job) { this.dropStroke(p); this.setStatus("Nothing to remove: the stroke lies outside the selection or the picture."); return; }
        p.healing = true;
        p.op = p.layer.alphaLock ? "source-atop" : "source-over";
        p.rect = this.strokeRect(p, p.layer.px);
        if (p.clip && this.sel) p.clipSel = this.sel.clone();
        this.pointer = p;
        this.setStatus(this._removeReady ? "Removing..." : "Removing (the first run loads LaMa, about 10 s)...");
        const done = (async () => {
            let res = null, error = null;
            try { res = await host.removeInApp(this, { image: job.image, mask: job.modelMask }); }
            catch (err) { error = err; }
            if (this.pointer !== p) { if (p.clipSel) p.clipSel.release(); return; }   // the editor was closed: `close` dropped it
            this.pointer = null;
            // the layer was deleted (or merged) from the panel meanwhile: nothing lands in a layer that is gone
            if (!this.layers.includes(p.layer)) error = error || new Error("the layer was deleted meanwhile");
            let wrote = false;
            try {
                if (res && res.image && !error) {
                    this.removeWrite(p, job, fromModel(res.image, job.crop, { x: job.ix, y: job.iy, w: job.w, h: job.h }, job.mask));
                    this.commitLayerPaint(p);
                    wrote = true;
                    this._removeReady = true;
                } else if (!error) error = new Error("the model gave no picture");
            } catch (err) {
                error = error || err;
                console.warn("Inpaint Canvas: Remove could not write its fill:", err);
            } finally {
                if (p.clipSel) { p.clipSel.release(); p.clipSel = null; }
            }
            // nothing landed: an undo pressed while it waited (`trackEdit`) must not take back the edit before it
            if (!wrote) { this.dropStroke(p); this.historyGen++; }
            const why = error ? String((error && error.message) || error).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "") : null;
            // `box`: the hole's extent (image pixels, x y w h), what the crop was placed around
            this.lastRemove = { box: [job.hole[0], job.hole[1], job.hole[2] - job.hole[0], job.hole[3] - job.hole[1]], crop: job.crop.slice(), holes: job.holes, wrote, seconds: res ? res.seconds : null, provider: res ? res.provider : null, ms: Math.round(performance.now() - t0), error: why };
            this.draw();
            this.setStatus(wrote ? `Removed (${job.holes.toLocaleString()} px in ${((performance.now() - t0) / 1000).toFixed(1)} s).` : `Remove failed: ${why}`, wrote ? "info" : "error");
        })();
        this.removePending = done;
        this.trackEdit(done);
        done.finally(() => { if (this.removePending === done) this.removePending = null; });
    }

    /**
     * What Remove sends: the hole is every pixel the stroke covered, cut by the selection, in the layer's pixels, which
     * are the image's (the press took an unscaled layer on whole pixels only), and inside the picture; the crop around it
     * (`removeCrop`) is read from the picture the press chose (`p.remove.src`, the visible image or the layer) and scaled
     * with the hole to the model's size. `stroke` is the buffer's bytes the fill goes back into, `cover` its coverage.
     * Null when nothing is covered; throws the status line's words for a stroke wider than `removeMaxHole`.
     */
    removeInputs(p) {
        const layer = p.layer, s = p.stroke;
        if (!s || s.empty || s.tw !== layer.w || s.th !== layer.h) return null;
        const x0 = Math.max(0, s.x), y0 = Math.max(0, s.y), x1 = Math.min(s.tw, s.x + s.w), y1 = Math.min(s.th, s.y + s.h);
        const w = x1 - x0, h = y1 - y0, n = w * h;
        if (w <= 0 || h <= 0) return null;
        // the buffer's box is the dabs' drawing rectangles, a margin of 1.5 radii wider than what they covered: a box
        // twice the limit is refused before it is read, the hole's own extent is measured below
        const max = InpaintEditor.removeMaxHole;
        const tooWide = (span) => refusal(`Remove fills up to ${max.toLocaleString()} px across, and this stroke spans ${span.toLocaleString()} px: remove it in parts, or select it and use Generate.`, "warn");
        if (Math.max(w, h) > 2 * max) throw tooWide(Math.max(w, h));
        const stroke = s.bytes(x0, y0, w, h);
        const sa = stroke.data, cover = new Uint8Array(n), mask = new Uint8Array(n);
        for (let k = 0; k < n; k++) if (sa[4 * k + 3]) cover[k] = mask[k] = 255;
        if (p.clip) {
            const c = this._healClip = this.clipCanvasFor(layer, layer.px, x0, y0, w, h, cpuDab(this._healClip, w, h), p.clipSel || this.sel);
            const ca = c.getContext("2d").getImageData(0, 0, w, h).data;
            for (let k = 0; k < n; k++) if (!ca[4 * k + 3]) mask[k] = 0;
        }
        const ix = x0 + layer.x, iy = y0 + layer.y, W = this.width, H = this.height;
        // the hole: what is covered, cut by the selection and the picture; its extent sets the crop (not the buffer's box,
        // whose margin would shrink the surroundings the model sees, and differ between the backends)
        let holes = 0, hx0 = w, hy0 = h, hx1 = -1, hy1 = -1;
        for (let y = 0; y < h; y++) {
            const out = iy + y < 0 || iy + y >= H;
            for (let x = 0, k = y * w; x < w; x++, k++) {
                if (mask[k] && (out || ix + x < 0 || ix + x >= W)) mask[k] = 0;
                if (!mask[k]) continue;
                holes++;
                if (x < hx0) hx0 = x;
                if (x > hx1) hx1 = x;
                if (y < hy0) hy0 = y;
                if (y > hy1) hy1 = y;
            }
        }
        if (!holes) return null;
        const hole = [ix + hx0, iy + hy0, ix + hx1 + 1, iy + hy1 + 1];
        if (Math.max(hole[2] - hole[0], hole[3] - hole[1]) > max) throw tooWide(Math.max(hole[2] - hole[0], hole[3] - hole[1]));
        const crop = removeCrop(hole, W, H);
        const cw = crop[2] - crop[0], ch = crop[3] - crop[1];
        const holeCrop = new Uint8Array(cw * ch);
        for (let y = 0; y < h; y++) {
            const cy = iy + y - crop[1];
            if (cy < 0 || cy >= ch) continue;
            for (let x = 0; x < w; x++) {
                const cx = ix + x - crop[0];
                if (mask[y * w + x] && cx >= 0 && cx < cw) holeCrop[cy * cw + cx] = 255;
            }
        }
        // bytes() hands out a buffer its next read reuses: copied (or scaled) at once
        let pic = p.remove.src.bytes(crop);
        if (p.remove.sample === "layer") pic = this.removeOverMean(pic, holeCrop, cw, ch);
        const image = toModelImage(pic, cw, ch);
        return { x: x0, y: y0, w, h, ix, iy, hole, crop, image, modelMask: toModelMask(holeCrop, cw, ch), mask, cover, stroke, holes };
    }

    /**
     * Sample "layer": the layer's crop as the model sees it. Its clear and half-clear pixels lie over the mean colour of
     * its opaque pixels around the hole (the model takes no alpha, and a clear pixel's bytes are black to it: a fill next
     * to transparency came out dark). Throws the status line's words when nothing opaque lies around the hole.
     */
    removeOverMean(bytes, hole, w, h) {
        const n = w * h, out = new Uint8Array(n * 4);
        let r = 0, g = 0, b = 0, k = 0;
        for (let i = 0; i < n; i++) {
            if (hole[i] || bytes[4 * i + 3] !== 255) continue;
            r += bytes[4 * i]; g += bytes[4 * i + 1]; b += bytes[4 * i + 2]; k++;
        }
        if (!k) throw refusal("The active layer holds nothing opaque around the stroke to fill from: set Remove's Sample to image.");
        r /= k; g /= k; b /= k;
        for (let i = 0, o = 0; i < n; i++, o += 4) {
            const a = bytes[o + 3] / 255;
            out[o] = Math.round(bytes[o] * a + r * (1 - a));
            out[o + 1] = Math.round(bytes[o + 1] * a + g * (1 - a));
            out[o + 2] = Math.round(bytes[o + 2] * a + b * (1 - a));
            out[o + 3] = 255;
        }
        return out;
    }

    /**
     * The fill into the stroke buffer: its colours where the hole is (the buffer's alpha, the coverage, kept), and
     * nothing where the stroke covered but no fill goes (outside the picture, cut by the selection), so the mark's colour
     * never lands.
     */
    removeWrite(p, job, fill) {
        const s = p.stroke, a = job.stroke.data, m = job.mask, cov = job.cover, w = job.w, h = job.h;
        for (let k = 0, n = w * h; k < n; k++) {
            const o = 4 * k;
            if (m[k]) { a[o] = fill[o]; a[o + 1] = fill[o + 1]; a[o + 2] = fill[o + 2]; }
            else if (cov[k]) a[o] = a[o + 1] = a[o + 2] = a[o + 3] = 0;
        }
        if (!s.px) { s.canvas.getContext("2d").putImageData(job.stroke, job.x - s.cx, job.y - s.cy); return; }
        // on tiles only the blocks the stroke covered (as `healWrite`)
        const T = TILE_SIZE;
        for (let ty = Math.floor(job.y / T) * T; ty < job.y + h; ty += T) {
            for (let tx = Math.floor(job.x / T) * T; tx < job.x + w; tx += T) {
                const bx = Math.max(tx, job.x) - job.x, by = Math.max(ty, job.y) - job.y;
                const bw = Math.min(tx + T, job.x + w) - job.x - bx, bh = Math.min(ty + T, job.y + h) - job.y - by;
                let any = false;
                for (let y = by; y < by + bh && !any; y++) for (let x = bx; x < bx + bw; x++) if (cov[y * w + x]) { any = true; break; }
                if (!any) continue;
                const blk = new ImageData(bw, bh);
                for (let y = 0; y < bh; y++) blk.data.set(a.subarray(((by + y) * w + bx) * 4, ((by + y) * w + bx + bw) * 4), y * bw * 4);
                s.px.writeRect(blk, job.x + bx, job.y + by);
            }
        }
    }

    /**
     * A heal or a Remove still waiting at its release (the gesture held): its stroke is drawn over its layer until it
     * lands (a Remove's mark, a heal's quick version), so an export, a run, a document save or a thumbnail waits for it.
     */
    async heldEdit() {
        for (let h; (h = this.removePending || this.healPending || this.liquifyPending);) await h.catch(() => {});
        // an undo's restored files, stored again when they had left the store (recheckRestoredFiles; it never rejects)
        while (this._fileCheck) await this._fileCheck;
    }

    /** What the status line says while a held gesture waits (a press or a key meanwhile). */
    heldWord(p) {
        return p.kind === "liquify" ? "Liquifying: a moment." : p.move ? "Moving: a moment." : p.remove ? "Removing: a moment." : p.patch ? "Patching: a moment." : "Healing: a moment.";
    }

    /**
     * A stroke that lands nothing (Remove without a fill): the layer stays as it was, the mark goes from the screen, and a
     * paint layer the press made for it on the base goes again (it holds nothing, and no undo step made it).
     */
    dropStroke(p) {
        if (p.clipSel) { p.clipSel.release(); p.clipSel = null; }
        if (p.remove && p.remove.src && p.remove.src.release) p.remove.src.release();
        if (p.remove && p.remove.made && this.layers.includes(p.layer)) {
            this.layers = this.layers.filter((l) => l !== p.layer);
            if (this.activeLayerId === p.layer.id) this.activeLayerId = null;
            if (p.layer.name === "Paint " + this.paintCounter) this.paintCounter--;
            this.historyGen++;
            this.renderLayers();
            this.drawThumb();
            this.notifyChanged();
        }
        this.releaseStrokeScratch();
        this.pixelVersion++;
        this.draw();
    }
}

export function bindHeal(C) { InpaintEditor = C; }
