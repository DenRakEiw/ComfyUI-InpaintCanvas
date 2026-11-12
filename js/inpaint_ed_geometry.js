// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_geometry.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// transform modes, layer geometry, snapping, align, flip, match edges, turn and straighten, the canvas tool and extend canvas: moved out of inpaint_canvas.js (item 56 S6, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS, scaleFilterParams } from "./inpaint_filters.js";
import { renderText } from "./inpaint_text.js";
import { uploadCanvas } from "./inpaint_upload.js";
import { XF_IDENTITY, pixelMap, xfApply, xfBox, xfInv, xfMul, xfScale, xfTranslate } from "./inpaint_resample.js";
import { fitLayerRGBA, workScale } from "./edgefit.js";
import { failKind } from "./inpaint_status.js";
import { CANVAS_MAX_SIDE, canvasSizeRefusal } from "./inpaint_sizelimit.js";
import { DOC_TURN_LABELS, HANDLE_PX, MASK_RGB, makeCanvas } from "./inpaint_consts.js";
import { autoCropFrame, boxOnPixels, composeTextOrient, frameInside, normDeg, orientChain, orientIsUp, orientOfXf, orientOps, placeXf, snapNum, snapXf, spinText, straightenXf, textTotalAngle, turnRect, turnSize, validXf, xfIsIdentity, xfOfOp } from "./inpaint_orient.js";
import { drawMesh, homography } from "./inpaint_mesh.js";

export class GeometryPart {
    setTransformMode(mode) {
        if (this.pending && this.pending.mode !== mode) this.cancelPending();
        this.transformMode = mode;
        if (mode !== "scale" && !this.pending && this.activeLayer()) this.startPending(mode);
        this.updateSubbar();
        this.draw();
    }

    // ---- pending transforms (rotate / distort / warp) ------------------------

    startPending(mode) {
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("Select a layer to transform. The base stays put."); return; }
        if (this.multiSelected()) { this.setStatus("Rotate, distort and warp take one layer: click a single layer first. Several selected layers move and scale together."); return; }
        if (layer.kind === "filter") { this.setStatus("Filter layers cannot be transformed."); return; }
        const p = { mode, layer, angle: 0 };
        const { x, y, w, h } = layer;
        if (mode === "distort") {
            p.points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        } else if (mode === "warp") {
            const n = +this.warpGridSel.value || 4;
            p.n = n;
            p.points = [];
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) p.points.push([x + w * i / n, y + h * j / n]);
        }
        this.pending = p;
        this.updateSubbar();
        this.draw();
    }

    cancelPending() {
        this.pending = null;
        this.updateSubbar();
        this.draw();
    }

    /** Destination (image coords) of the normalised layer position (u, v). */
    pendingDst(p, u, v) {
        const l = p.layer;
        if (p.mode === "rotate") {
            const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
            const px = l.x + u * l.w - cx, py = l.y + v * l.h - cy;
            const c = Math.cos(p.angle), s = Math.sin(p.angle);
            return [cx + px * c - py * s, cy + px * s + py * c];
        }
        if (p.mode === "distort") {
            if (!p.H) p.H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], p.points);
            return p.H(u, v);
        }
        if (p.mode === "warp") {
            const n = p.n;
            const fi = Math.min(n - 1e-9, u * n), fj = Math.min(n - 1e-9, v * n);
            const i = Math.floor(fi), j = Math.floor(fj);
            const fu = fi - i, fv = fj - j;
            const P = (a, b) => p.points[b * (n + 1) + a];
            const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
            return [
                (1 - fv) * ((1 - fu) * p00[0] + fu * p10[0]) + fv * ((1 - fu) * p01[0] + fu * p11[0]),
                (1 - fv) * ((1 - fu) * p00[1] + fu * p10[1]) + fv * ((1 - fu) * p01[1] + fu * p11[1]),
            ];
        }
        return [l.x + u * l.w, l.y + v * l.h];
    }

    pendingSubdivisions(p, fine) {
        if (p.mode === "rotate") return 1;
        if (p.mode === "distort") return fine ? 24 : 12;
        return fine ? p.n * 6 : p.n * 3;
    }

    pendingPointAt(p, ix, iy) {
        if (!p.points) return -1;
        const r = HANDLE_PX / this.view.scale;
        let best = -1, bestD = r * r;
        p.points.forEach(([px, py], i) => {
            const d = (px - ix) ** 2 + (py - iy) ** 2;
            if (d <= bestD) { best = i; bestD = d; }
        });
        return best;
    }

    pendingPointerDown(ix, iy, e) {
        const p = this.pending;
        if (p.mode === "rotate") {
            const l = p.layer;
            const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
            const [lx, ly] = this.toLayerLocal(l, p.angle, ix, iy);
            const handle = this.handleAt(lx, ly);
            if (handle) {
                // scale in the un-rotated frame; the corner opposite the handle stays put on screen
                this.pushUndo({ kind: "transform", id: l.id, label: "Scale" });
                this.pointer = { kind: "scale", layer: l, handle, start: [lx, ly], orig: { x: l.x, y: l.y, w: l.w, h: l.h }, keepAspect: handle.length === 2 && !e.shiftKey, angle: p.angle, center: [cx, cy] };
                return;
            }
            if (lx >= l.x && lx <= l.x + l.w && ly >= l.y && ly <= l.y + l.h) {
                this.pushUndo({ kind: "transform", id: l.id, label: "Move layer" });
                this.pointer = { kind: "move", layer: l, start: [ix, iy], orig: { x: l.x, y: l.y } };
                return;
            }
            this.pointer = { kind: "pending", start: Math.atan2(iy - cy, ix - cx), startAngle: p.angle, snap: e.shiftKey };
            return;
        }
        const idx = this.pendingPointAt(p, ix, iy);
        if (idx >= 0) {
            this.pointer = { kind: "pending", index: idx, start: [ix, iy], orig: [...p.points[idx]] };
        } else {
            this.pointer = { kind: "pending", index: -1, start: [ix, iy], orig: p.points.map((q) => [...q]) };
        }
    }

    pendingPointerMove(ix, iy, e) {
        const p = this.pending, g = this.pointer;
        if (!p || !g) return;
        if (p.mode === "rotate") {
            const cx = p.layer.x + p.layer.w / 2, cy = p.layer.y + p.layer.h / 2;
            let a = g.startAngle + (Math.atan2(iy - cy, ix - cx) - g.start);
            if (e.shiftKey || g.snap) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
            p.angle = a;
            this.updateSubbar();
            return;
        }
        const dx = ix - g.start[0], dy = iy - g.start[1];
        if (g.index >= 0) {
            p.points[g.index] = [g.orig[0] + dx, g.orig[1] + dy];
        } else {
            p.points = g.orig.map(([x, y]) => [x + dx, y + dy]);
        }
        p.H = null;
    }

    /** Bake the pending transform into the layer's pixels. */
    applyPending() {
        const p = this.pending;
        if (!p) return;
        const layer = p.layer;
        if (p.mode === "rotate" && Math.abs(p.angle) < 1e-6) { this.cancelPending(); return; }
        const label = { rotate: "Rotate", distort: "Distort", warp: "Warp" }[p.mode];
        if (layer.kind === "text" && layer.text && p.mode === "rotate") {
            // a text stays text: the angle goes into its description and the text is drawn at it (PLAN_0_1_31 §7). No draw
            // here: the render lands before the next frame, which would otherwise show the old pixels upright
            this.pending = null;
            this.updateSubbar();
            this.setTextAngle(layer, textTotalAngle(layer.text) + p.angle * 180 / Math.PI, { label }).then((ok) => {
                if (ok) this.setStatus(`${layer.name}: turned to ${Math.round(textTotalAngle(layer.text) * 10) / 10}°, still editable.`, "info");
                else this.draw();   // refused (a locked layer): the preview goes
            });
            return;
        }
        const madePixels = layer.kind === "text";
        if (madePixels) {
            // distort and warp cannot be described: the text becomes pixels (a "layers" step brings the text back)
            this.pushUndo({ kind: "layers", label });
            layer.kind = "paint";
            delete layer.text;
            layer._textToken = (layer._textToken || 0) + 1;   // a render on its way must not land on the pixels
            clearTimeout(layer._textTimer); layer._textTimer = null; layer._textRendering = 0;
            if (layer._textUndo) this.releaseSnapshot(layer._textUndo);
            layer._textUndo = null;
        } else {
            this.pushUndo({ kind: "layerfull", id: layer.id, label });
        }
        // the new pixels have no grid the mask could stay on: a live mask is baked in, a switched-off one dropped, and
        // the status says so (both went without a word until 0.1.32; the undo step above holds the mask)
        const maskNote = this.liveMask(layer) ? " Its mask is baked into the pixels (Ctrl+Z brings it back)."
            : layer.maskPx ? " Its switched-off mask was dropped (Ctrl+Z brings it back)." : "";
        if (this.liveMask(layer)) this.applyMask(layer, { silent: true, undo: false });
        else if (layer.maskPx) { layer.maskPx = null; layer.maskOff = false; layer.maskEdit = false; this.markMaskChanged(layer); }
        const n = this.pendingSubdivisions(p, true);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
            const [X, Y] = this.pendingDst(p, i / n, j / n);
            minX = Math.min(minX, X); minY = Math.min(minY, Y); maxX = Math.max(maxX, X); maxY = Math.max(maxY, Y);
        }
        minX = Math.floor(minX); minY = Math.floor(minY); maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        // the source once, after applyMask above replaced the pixels; the mesh draws it per triangle
        const src = layer.px.toCanvas();
        // Keep the layer's native resolution (pixels per image unit).
        const res = Math.max(src.width / layer.w, src.height / layer.h, 1);
        const out = makeCanvas(Math.round(bw * res), Math.round(bh * res));
        const ctx = out.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const dst = (u, v) => { const [X, Y] = this.pendingDst(p, u, v); return [(X - minX) * res, (Y - minY) * res]; };
        if (p.mode === "rotate") {
            const [X, Y] = dst(0, 0);
            ctx.save();
            ctx.translate(X, Y);
            ctx.rotate(p.angle);
            ctx.scale(layer.w * res / src.width, layer.h * res / src.height);
            ctx.drawImage(src, 0, 0);
            ctx.restore();
        } else {
            drawMesh(ctx, src, dst, n, n);
        }
        // no state is left behind on the new pixels' context (PLAN_BCE §C1 rule 11)
        ctx.imageSmoothingQuality = "low";
        // replaced, not written (another size; the "layerfull" undo PNG may still be encoding from the old pixels)
        layer.px = this.pixels.Layer.fromCanvas(out);
        layer.x = minX; layer.y = minY; layer.w = bw; layer.h = bh;
        this.pending = null;
        this.markLayerChanged(layer);
        this.renderLayers();
        this.updateSubbar();
        this.draw();
        this.setStatus((madePixels ? `${layer.name} is pixels now: a ${p.mode} cannot be kept as text (Ctrl+Z brings the text back).`
            : `${layer.name}: ${p.mode} applied (${bw} × ${bh}).`) + maskNote, "info");
    }

    /** Numeric X / Y / W / H from the transform bar. */
    setLayerGeometry() {
        const l = this.activeLayer();
        if (!l || l.kind === "filter" || this.isLocked(l)) return;
        const g = this.geoInputs;
        const x = Math.round(+g.x.value), y = Math.round(+g.y.value), w = Math.max(1, Math.round(+g.w.value)), h = Math.max(1, Math.round(+g.h.value));
        if (![x, y, w, h].every(Number.isFinite)) return;
        if (x === l.x && y === l.y && w === l.w && h === l.h) return;
        this.pushUndo({ kind: "transform", id: l.id, label: "Position and size" });
        l.x = x; l.y = y; l.w = w; l.h = h;
        this.uploaded.baseHash = null; this.uploaded.controlHash = null;
        this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /**
     * What a move or scale snaps to (item 59), `{ x, y }`: the canvas edges and centre and the guides first (for one
     * edge a tie goes to them), then the left / right edges and the centre, the top / bottom edges and the middle, of
     * every other layer the screen draws: shown (its own eye and its groups'), with pixels, not a filter layer (it covers
     * the canvas), and a clipped layer only while its base is shown too. Reference and control layers count while they
     * are shown: the canvas draws them. Each layer goes by its box, the frame the transform tool draws around it, not by
     * what is painted in it. While two results are compared (`compare` a and b) the screen draws those two, their eyes
     * aside, and no other result layer: so do the targets (drawLayersInto's `compareShow` rule). Collected at the
     * gesture's first snap and kept on the pointer `p` with a stamp of what an outside change moves (an agent's command
     * runs during a drag: a layer set, hidden or removed, an undo, a resize or an extend, a guide): made again only when
     * the stamp changes, which the dragged layers' own moves do not do. A compare's draw moves `compositeVersion`, so in
     * compare mode it is made again at each move (3 us for 50 layers, the editor gate's `list_us_50`). The layers the
     * gesture moves are left out (`moving`, or a group gesture's members).
     */
    snapTargets(p, moving) {
        const g = this.guides || {};
        const stamp = `${this.historyGen}|${this.compositeVersion}|${this.width}x${this.height}|${(g.x || []).join()}|${(g.y || []).join()}`;
        if (p && p.snapTo && p.snapTo.stamp === stamp) return p.snapTo;
        const x = [0, this.width / 2, this.width, ...(g.x || [])], y = [0, this.height / 2, this.height, ...(g.y || [])];
        const skip = new Set(p && p.group ? p.group.map((m) => m.layer) : [moving]);
        const cmp = this.compare && this.compare.a && this.compare.b ? this.compare : null;
        this.layers.forEach((l, i) => {
            if (skip.has(l) || l.kind === "filter" || !l.px || !(l.w > 0 && l.h > 0)) return;
            if (cmp && l.kind === "result" ? l.id !== cmp.a && l.id !== cmp.b : !this.shown(l)) return;
            const cb = l.clip ? this.clipBaseOf(l, i) : null;
            if (cb && !this.shown(cb)) return;
            x.push(l.x, l.x + l.w / 2, l.x + l.w);
            y.push(l.y, l.y + l.h / 2, l.y + l.h);
        });
        const out = { x, y, stamp };
        if (p) p.snapTo = out;
        return out;
    }

    /**
     * Snap the edges a scale gesture drags to the canvas edges, its centre, the guides and the
     * other layers' edges and centres (`snapTargets`, within 8 screen px), like a magnet: the
     * pointer is shifted by the snap and the scale re-applied, so a kept aspect ratio stays
     * consistent and "drag to the full picture" lands exactly. Rotated layers are not snapped
     * (their edges are not axis-aligned). Alt held skips the call (the pointer move's caller).
     */
    snapScale(p, ix, iy) {
        const l = p.layer, h = p.handle;
        const th = 8 / this.view.scale;
        const { x: tx, y: ty } = this.snapTargets(p, l);
        const nearest = (edge, targets) => { let best = null; for (const t of targets) { const d = Math.abs(edge - t); if (d <= th && (!best || d < best[0])) best = [d, t - edge, t]; } return best; };
        const edgeX = () => (h.includes("e") ? l.x + l.w : h.includes("w") ? l.x : null);
        const edgeY = () => (h.includes("s") ? l.y + l.h : h.includes("n") ? l.y : null);
        const ex = edgeX(), ey = edgeY();
        const sx = ex == null ? null : nearest(ex, tx), sy = ey == null ? null : nearest(ey, ty);
        if (!sx && !sy) return;
        this.applyScale(p, ix + (sx ? sx[1] : 0), iy + (sy ? sy[1] : 0));
        // with a kept aspect only the dominant axis lands exactly: show the lines for the edges that did
        const gx = [], gy = [];
        const ex2 = edgeX(), ey2 = edgeY();
        if (sx && ex2 != null && Math.abs(ex2 - sx[2]) <= 1) gx.push(sx[2]);
        if (sy && ey2 != null && Math.abs(ey2 - sy[2]) <= 1) gy.push(sy[2]);
        this.snapGuides = gx.length || gy.length ? { x: gx, y: gy } : null;
    }

    /**
     * Snap a moving layer's edges and centre to the canvas edges and centre, the guides and the other layers' edges and
     * centres (`snapTargets`, within 8 screen px). `p`: the gesture's pointer, which keeps the targets; Alt held skips the
     * call (the pointer move's caller). A layer with a pending rotation snaps what the screen shows: the axis-aligned
     * bounds of its turned quad and their centre (the layer's own), and the shift moves the layer by the same amount.
     */
    snapLayer(l, p = null) {
        const th = 8 / this.view.scale;
        const gx = [], gy = [];
        const { x: tx, y: ty } = this.snapTargets(p, l);
        let bx = l.x, by = l.y, bw = l.w, bh = l.h;
        const pr = this.pending;
        if (pr && pr.mode === "rotate" && pr.layer === l && Math.abs(pr.angle) > 1e-6) {
            const qs = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => this.pendingDst(pr, u, v));
            bx = Math.min(...qs.map((q) => q[0])); by = Math.min(...qs.map((q) => q[1]));
            bw = Math.max(...qs.map((q) => q[0])) - bx; bh = Math.max(...qs.map((q) => q[1])) - by;
        }
        let best = null;
        for (const a of [bx, bx + bw / 2, bx + bw]) for (const b of tx) { const d = Math.abs(a - b); if (d <= th && (!best || d < best[0])) best = [d, b - a, b]; }
        if (best) { l.x = Math.round(l.x + best[1]); gx.push(best[2]); }
        best = null;
        for (const a of [by, by + bh / 2, by + bh]) for (const b of ty) { const d = Math.abs(a - b); if (d <= th && (!best || d < best[0])) best = [d, b - a, b]; }
        if (best) { l.y = Math.round(l.y + best[1]); gy.push(best[2]); }
        this.snapGuides = gx.length || gy.length ? { x: gx, y: gy } : null;
    }

    centerLayer() {
        const l = this.activeLayer();
        if (!l || l.kind === "filter" || this.isLocked(l)) return;
        this.pushUndo({ kind: "transform", id: l.id, label: "Centre layer" });
        l.x = Math.round((this.width - l.w) / 2);
        l.y = Math.round((this.height - l.h) / 2);
        this.uploaded.baseHash = null; this.uploaded.controlHash = null;
        this.renderLayers(); this.updateSubbar(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /** The layers align and distribute move: the selected ones (filter and locked layers stay where they are), or the active one. */
    alignTargets() {
        if (this.multiSelected()) { const group = this.groupBox(); return group ? group.layers : []; }
        const l = this.activeLayer();
        return l && l.kind !== "filter" && !this.isLocked(l) ? [l] : [];
    }

    /** The box to align within: the canvas, or (several layers, `to` "selection") the box around them. */
    alignFrame(layers, to) {
        if (to === "canvas" || layers.length < 2) return { x: 0, y: 0, w: this.width, h: this.height };
        const x0 = Math.min(...layers.map((l) => l.x)), y0 = Math.min(...layers.map((l) => l.y));
        return { x: x0, y: y0, w: Math.max(...layers.map((l) => l.x + l.w)) - x0, h: Math.max(...layers.map((l) => l.y + l.h)) - y0 };
    }

    /**
     * Line the selected layers' boxes up on an edge or a centre (`how`: left, hcenter, right, top, vcenter, bottom) of
     * the box around them or of the canvas (`to`: selection or canvas; one layer always aligns to the canvas). One undo
     * step; returns the layers that moved.
     */
    alignLayers(how, { to = "selection" } = {}) {
        if (this.pending) { this.setStatus("Apply or cancel the transform first."); return []; }
        const layers = this.alignTargets();
        if (!layers.length) { this.setStatus("Select a layer to align. Filter and locked layers stay where they are."); return []; }
        const f = this.alignFrame(layers, to);
        const at = {
            left: (l) => [f.x, l.y], hcenter: (l) => [f.x + (f.w - l.w) / 2, l.y], right: (l) => [f.x + f.w - l.w, l.y],
            top: (l) => [l.x, f.y], vcenter: (l) => [l.x, f.y + (f.h - l.h) / 2], bottom: (l) => [l.x, f.y + f.h - l.h],
        }[how];
        if (!at) throw new Error(`unknown alignment ${how}`);
        return this.placeLayers(layers.map((l) => [l, ...at(l)]), layers.length > 1 ? "Align layers" : "Align layer");
    }

    /**
     * Space the selected layers with equal gaps along `axis` (x or y), in the order of their left (top) edges: within
     * the box around them (the outer two stay put; three layers at least) or across the canvas (two at least).
     */
    distributeLayers(axis, { to = "selection" } = {}) {
        if (this.pending) { this.setStatus("Apply or cancel the transform first."); return []; }
        const layers = this.alignTargets();
        const least = to === "canvas" ? 2 : 3;
        if (layers.length < least) { this.setStatus(`Select ${least} layers or more to distribute${to === "canvas" ? " across the canvas" : ""}.`); return []; }
        const f = this.alignFrame(layers, to);
        const [pos, size] = axis === "y" ? ["y", "h"] : ["x", "w"];
        const order = [...layers].sort((a, b) => a[pos] - b[pos] || a[size] - b[size]);
        const gap = (f[size] - order.reduce((s, l) => s + l[size], 0)) / (order.length - 1);
        let at = f[pos];
        const moves = order.map((l) => { const p = at; at += l[size] + gap; return axis === "y" ? [l, l.x, p] : [l, p, l.y]; });
        return this.placeLayers(moves, "Distribute layers");
    }

    /** Move layers to [layer, x, y] places (rounded) as one undo step; returns the layers that moved. */
    placeLayers(moves, label) {
        const moved = moves.map(([l, x, y]) => [l, Math.round(x), Math.round(y)]).filter(([l, x, y]) => x !== l.x || y !== l.y);
        if (!moved.length) { this.setStatus("The layers are already in place."); return []; }
        if (moved.length > 1) this.pushUndo({ kind: "transforms", ids: moved.map(([l]) => l.id), label });
        else this.pushUndo({ kind: "transform", id: moved[0][0].id, label });
        for (const [l, x, y] of moved) { l.x = x; l.y = y; }
        this.uploaded.baseHash = null; this.uploaded.controlHash = null;
        this.renderLayers(); this.updateSubbar(); this.draw(); this.drawThumb(); this.notifyChanged();
        return moved.map(([l]) => l);
    }

    /** Mirror the active layer's pixels (and mask) horizontally or vertically. */
    flipLayer(axis) {
        const l = this.activeLayer();
        if (!l || l.kind === "filter") { this.setStatus("Select a pixel layer to flip."); return; }
        if (this.isLocked(l)) { this.setStatus(`${l.name} is locked.`, "info"); return; }
        if (this.pending) this.cancelPending();
        const op = axis === "h" ? "h" : "v";
        const label = axis === "h" ? "Flip horizontally" : "Flip vertically";
        // a text layer keeps the flip in its description (the next edit renders it flipped), which only a "layers" step holds
        this.pushUndo(l.kind === "text" ? { kind: "layers", label } : { kind: "layerfull", id: l.id, label });
        // replaced, not written (the undo step holds the old pixels)
        l.px = l.px.turned(op);
        if (l.maskPx) { l.maskPx = l.maskPx.turned(op); l.maskDirty = true; }
        if (l.kind === "text" && l.text) {
            l.text = composeTextOrient(l.text, op);
            if (l._textTimer || l._textRendering) { clearTimeout(l._textTimer); l._textTimer = null; this.renderTextLayer(l); }
        }
        this.markLayerChanged(l);
        this.renderLayers(); this.draw();
        this.setStatus(`${l.name} flipped ${axis === "h" ? "horizontally" : "vertically"}.`, "info");
    }

    /**
     * Match a layer's edges to the picture under it (item 42): an inpaint result that came back slightly shifted or
     * scaled is fitted on its own edge ring (its opaque pixels near its transparent part or its mask's border) against
     * the composite of the layers below (renderer/editor/edgefit.js, the node's `_align_patch` limits), then moved or
     * resampled in one undo step. A fit that is pure translation by whole pixels moves the layer (no resampling); any
     * other bakes the matrix into the pixels as the transform tool does (a live mask baked in). Refuses with a reason in
     * the status line and the answer: a flat ring, a fit past 8 % scale or 5 % shift, no gain. `apply` false only fits.
     * `{ aligned, reason?, scale, shift, before, after, how: "moved" | "resampled" | null, centre: [dx, dy] }`.
     */
    matchEdges(layer = this.activeLayer(), { apply = true } = {}) {
        const l = layer;
        const refuse = (reason, status) => { this.setStatus(status); return { aligned: false, reason, how: null }; };
        if (!l || l.kind === "filter") return refuse("no pixel layer", "Select a pixel layer to match its edges.");
        if (this.isReference(l) || this.isControl(l)) return refuse("not part of the picture", `${l.name} is not part of the picture: there is nothing to match it to.`);
        if (this.isLocked(l)) return refuse("locked", `${l.name} is locked.`);
        const index = this.layers.indexOf(l);
        const x0 = Math.max(0, Math.floor(l.x)), y0 = Math.max(0, Math.floor(l.y));
        const x1 = Math.min(this.width, Math.ceil(l.x + l.w)), y1 = Math.min(this.height, Math.ceil(l.y + l.h));
        if (x1 - x0 < 8 || y1 - y0 < 8) return refuse("outside the canvas", `${l.name} hardly reaches into the canvas: nothing to match.`);
        if (this.pending) this.cancelPending();
        const bw = x1 - x0, bh = y1 - y0, s = workScale(bw, bh);
        const tw = Math.max(1, Math.round(bw * s)), th = Math.max(1, Math.round(bh * s));
        // the composite under the layer at the working size, and the layer itself (its mask applied) on the same grid
        const below = makeCanvas(tw, th), bctx = below.getContext("2d", { willReadFrequently: true });
        bctx.drawImage(this.sampleRegion("image", [x0, y0, x1, y1], s, { forRun: true, upTo: Math.max(0, index) }), 0, 0, tw, th);
        const own = makeCanvas(tw, th), octx = own.getContext("2d", { willReadFrequently: true });
        octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high";
        const dx = (l.x - x0) * s, dy = (l.y - y0) * s, dw = l.w * s, dh = l.h * s;
        l.px.drawTo(octx, dx, dy, dw, dh);
        if (this.liveMask(l)) { octx.globalCompositeOperation = "destination-in"; l.maskPx.drawTo(octx, dx, dy, dw, dh); octx.globalCompositeOperation = "source-over"; }
        const r = fitLayerRGBA({ baseRGBA: bctx.getImageData(0, 0, tw, th).data, layerRGBA: octx.getImageData(0, 0, tw, th).data, w: tw, h: th, fullW: bw, fullH: bh });
        const out = { aligned: r.aligned, ...(r.reason ? { reason: r.reason } : {}), scale: r.scale, shift: r.shift, before: r.before, after: r.after, how: null };
        if (r.matrix) {
            // the matrix in image coordinates: layer(A X + t) belongs at X; the layer's content at its middle moves by -(M c - c)
            const [a00, a01, t0, a10, a11, t1] = r.matrix;
            const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
            const rx = a00 * (cx - x0) + a01 * (cy - y0) + t0 - (cx - x0);
            const ry = a10 * (cx - x0) + a11 * (cy - y0) + t1 - (cy - y0);
            out.centre = [Math.round(-rx * 10) / 10, Math.round(-ry * 10) / 10];
            out.matrix = [a00, a01, t0 + a00 * -x0 + a01 * -y0 + x0, a10, a11, t1 + a10 * -x0 + a11 * -y0 + y0];
        }
        const what = { "ring too small": "the edge ring is too small to fit (under 2,000 px or 2 % of the layer)", "flat area": "the edge ring has no contrast to fit on",
            "fit out of range": "the fit found is too large to be a drift (over 8 % scale or 5 % shift)", "no gain": "it already sits as well as a fit can put it",
            "no fit found": "no fit was found" }[r.reason] || r.reason;
        if (!r.aligned) {
            this.setStatus(`${l.name}: edges not matched, ${what}. Nudge it with the move tool if it is still off.`, r.reason === "no gain" ? "info" : "warn");
            return out;
        }
        if (!apply) return out;
        const [a00, a01, t0, a10, a11, t1] = out.matrix;
        // the scale and shear over the layer's box move no corner by more than a tenth of a pixel: a pure translation
        const lin = Math.max(Math.abs(a00 - 1) * l.w + Math.abs(a01) * l.h, Math.abs(a10) * l.w + Math.abs(a11 - 1) * l.h);
        const mx = -out.centre[0], my = -out.centre[1];
        const scaleNote = `scale ${out.scale[0]} × ${out.scale[1]}, `;
        if (lin < 0.1 && Math.abs(mx - Math.round(mx)) < 0.25 && Math.abs(my - Math.round(my)) < 0.25) {
            this.placeLayers([[l, l.x - Math.round(mx), l.y - Math.round(my)]], "Match edges");
            out.how = "moved";
        } else {
            if (l.kind === "text" && l.text) {
                out.aligned = false; out.reason = "text layer";
                this.setStatus(`${l.name}: a fit was found (${scaleNote}moved ${out.centre[0]}, ${out.centre[1]} px) but a text layer can only be moved by whole pixels; turn it into pixels first or nudge it by hand.`, "info");
                return out;
            }
            const pw = l.px.width, ph = l.px.height;
            if (pw > 65535 || ph > 65535 || pw * ph > 268435456) {
                out.aligned = false; out.reason = "too large";
                this.setStatus(`${l.name} is ${pw} × ${ph} px, more than one canvas holds: its edges cannot be resampled.`, "warn");
                return out;
            }
            // the inverse: where an old layer point lands
            const det = a00 * a11 - a01 * a10, i00 = a11 / det, i01 = -a01 / det, i10 = -a10 / det, i11 = a00 / det;
            const i02 = -(i00 * t0 + i01 * t1), i12 = -(i10 * t0 + i11 * t1);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [X, Y] of [[l.x, l.y], [l.x + l.w, l.y], [l.x, l.y + l.h], [l.x + l.w, l.y + l.h]]) {
                const u = i00 * X + i01 * Y + i02, v = i10 * X + i11 * Y + i12;
                minX = Math.min(minX, u); minY = Math.min(minY, v); maxX = Math.max(maxX, u); maxY = Math.max(maxY, v);
            }
            minX = Math.floor(minX); minY = Math.floor(minY); maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
            const nw = Math.max(1, maxX - minX), nh = Math.max(1, maxY - minY);
            this.pushUndo({ kind: "layerfull", id: l.id, label: "Match edges" });
            if (this.liveMask(l)) this.applyMask(l, { silent: true, undo: false });
            else if (l.maskPx) { l.maskPx = null; l.maskOff = false; l.maskEdit = false; this.markMaskChanged(l); }
            const src = l.px.toCanvas();
            const res = Math.max(src.width / l.w, src.height / l.h, 1);
            const canvas = makeCanvas(Math.round(nw * res), Math.round(nh * res));
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            const kx = l.w / src.width, ky = l.h / src.height;
            ctx.setTransform(res * i00 * kx, res * i10 * kx, res * i01 * ky, res * i11 * ky,
                res * (i00 * l.x + i01 * l.y + i02 - minX), res * (i10 * l.x + i11 * l.y + i12 - minY));
            ctx.drawImage(src, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.imageSmoothingQuality = "low";
            l.px = this.pixels.Layer.fromCanvas(canvas);
            l.x = minX; l.y = minY; l.w = nw; l.h = nh;
            this.markLayerChanged(l);
            this.renderLayers(); this.updateSubbar(); this.draw();
            out.how = "resampled";
        }
        this.setStatus(`${l.name}: edges matched to the picture below (moved ${out.centre[0]}, ${out.centre[1]} px, ${scaleNote}edge difference ${out.before} → ${out.after}). Ctrl+Z takes it back; the move tool nudges it by hand.`, "info");
        return out;
    }

    /**
     * Pixels mirrored (`op` "h" / "v") or turned (1 clockwise, -1 counter-clockwise, 2 a half turn): `src.turned(op)`,
     * kept under this name for tools/perf_test.py and tools/px_jobs.py. On tiles the words move tile by tile
     * (PLAN_0_1_31 §7); before, 256-row bands were read, moved in JS and written with a canvas round trip.
     */
    turnedTilePixels(src, op) {
        return src.turned(op);
    }

    /**
     * The band version `turned` replaced: bands of 256 rows read with readRect, moved in JS and written into new pixels
     * of the same class ("h", "v", 1, -1). Kept to measure against (PLAN_0_1_31 §7).
     */
    turnedTilePixelsByBands(src, op) {
        const W = src.width, H = src.height, turn = op === 1 || op === -1, B = 256;
        const out = new src.constructor(turn ? H : W, turn ? W : H);
        for (let y = 0; y < H; y += B) {
            const bh = Math.min(B, H - y);
            const img = src.readRect(0, y, W, bh), s = img.data, row = W * 4;
            const s32 = new Uint32Array(s.buffer, s.byteOffset, s.length >> 2);   // a pixel is one word, whatever the byte order
            if (op === "h") {
                for (let r = 0; r < bh; r++) s32.subarray(r * W, r * W + W).reverse();
                out.writeRect(img, 0, y);
            } else if (op === "v") {
                for (let r = 0; r < bh >> 1; r++) {
                    const a = r * row, b = (bh - 1 - r) * row, t = s.slice(a, a + row);
                    s.copyWithin(a, b, b + row);
                    s.set(t, b);
                }
                out.writeRect(img, 0, H - y - bh);
            } else {
                // source rows [y, y + bh) are the new pixels' columns [H - y - bh, H - y) clockwise, [y, y + bh) counter-clockwise
                const d = new ImageData(bh, W), d32 = new Uint32Array(d.data.buffer);
                for (let r = 0; r < bh; r++) {
                    const col = op === 1 ? bh - 1 - r : r, base = r * W;
                    if (op === 1) for (let x = 0; x < W; x++) d32[x * bh + col] = s32[base + x];
                    else for (let x = 0; x < W; x++) d32[(W - 1 - x) * bh + col] = s32[base + x];
                }
                out.writeRect(d, op === 1 ? H - y - bh : y, 0);
            }
        }
        return out;
    }

    /** Rotate the active layer by 90° (dir 1 = clockwise), keeping its centre. */
    rotateLayer90(dir) {
        const l = this.activeLayer();
        if (!l || l.kind === "filter") { this.setStatus("Select a pixel layer to rotate."); return; }
        if (this.isLocked(l)) { this.setStatus(`${l.name} is locked.`, "info"); return; }
        if (this.pending) this.cancelPending();
        const label = dir === 1 ? "Rotate 90° clockwise" : "Rotate 90° counter-clockwise";
        // a text layer keeps the turn in its description (the next edit renders it turned), which only a "layers" step holds
        this.pushUndo(l.kind === "text" ? { kind: "layers", label } : { kind: "layerfull", id: l.id, label });
        // replaced, not written (the undo step holds the old pixels)
        l.px = l.px.turned(dir);
        if (l.maskPx) { l.maskPx = l.maskPx.turned(dir); l.maskDirty = true; }
        if (l.kind === "text" && l.text) {
            l.text = composeTextOrient(l.text, dir);
            if (l._textTimer || l._textRendering) { clearTimeout(l._textTimer); l._textTimer = null; this.renderTextLayer(l); }
        }
        const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
        [l.w, l.h] = [l.h, l.w];
        l.x = Math.round(cx - l.w / 2); l.y = Math.round(cy - l.h / 2);
        this.markLayerChanged(l);
        this.renderLayers(); this.updateSubbar(); this.draw();
        this.setStatus(`${l.name} rotated 90° ${dir > 0 ? "clockwise" : "counter-clockwise"}.`, "info");
    }

    /** (ix, iy) in a layer's un-rotated frame: the inverse rotation about its centre (or a given one). */
    toLayerLocal(l, angle, ix, iy, center = null) {
        const cx = center ? center[0] : l.x + l.w / 2, cy = center ? center[1] : l.y + l.h / 2;
        const c = Math.cos(-angle), s = Math.sin(-angle);
        const dx = ix - cx, dy = iy - cy;
        return [cx + dx * c - dy * s, cy + dx * s + dy * c];
    }

    /** Just outside the layer frame near a corner: the rotate zone, as in Krita and Photoshop. */
    rotateZoneAt(l, ix, iy) {
        const r = HANDLE_PX / this.view.scale;
        const outside = ix < l.x - r || ix > l.x + l.w + r || iy < l.y - r || iy > l.y + l.h + r;
        if (!outside) return false;
        const reach = 5 * r;
        return [[l.x, l.y], [l.x + l.w, l.y], [l.x, l.y + l.h], [l.x + l.w, l.y + l.h]].some(([cx, cy]) => Math.hypot(ix - cx, iy - cy) <= reach);
    }

    // ---- the whole document turned or mirrored (PLAN_0_1_31 §7, item 23a) ------------------

    /**
     * Turn (1 clockwise, -1 counter-clockwise, 2 a half turn) or mirror ("h", "v") the whole document: the base, every
     * layer with its mask and place, the selection, the guides, the saved selections, the results history and the export
     * size; text layers keep the turn in their description. One undo step. False (with a status line) when it cannot run.
     */
    turnDocument(op) {
        // one after the other (two clicks on 90° make 180°), and after every edit already under way: a second turn read
        // the size and the base before the first had put its own back, and left the selection and the layers turned twice
        const waitFor = [this._turnQueue, ...(this._pendingEdits ? Array.from(this._pendingEdits) : [])].filter(Boolean);
        const run = Promise.all(waitFor).then(() => this.turnDocumentNow(op));
        this._turnQueue = run.then(() => {}, () => {});
        return this.trackEdit(run);   // undo waits for the upload (see extendCanvas)
    }

    /** Why the document cannot be turned now (a job that would land where the picture was), or "". */
    turnBlocked() {
        // the app's Each area (eacharea.js): its areas were cut from the picture as it is, and the next one goes soon
        if (this._eachArea) return "Each area is running on this document: its areas were cut from the picture as it is. Wait for it, or stop it.";
        if (this.providerPending || this.segmentPending || this.cutoutPending || this.objectsPending || this._pointPending
            || this._loading || this._docSaving) return "Wait for the running job to finish: it would land where the picture was before the turn.";
        // a render queued on ComfyUI lands in the geometry it was made for (the app's host counts them, host.js)
        if (this._localRuns && this._localRuns.size) return "A render on your ComfyUI is still running: its result would land where the picture was. Turn the picture when it is in.";
        if (this.gestureHeld()) return "Release the button first.";
        return "";
    }

    async turnDocumentNow(op) {
        if (!Object.prototype.hasOwnProperty.call(DOC_TURN_LABELS, String(op))) throw new Error(`no document turn "${op}"`);
        if (!this.base) { this.setStatus("Load an image first."); return false; }
        const blocked = this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return false; }
        const label = DOC_TURN_LABELS[String(op)];
        let before = null, pushed = false;
        this._turning = true;   // crop, resize, extend, merge and flatten wait for it (they would replace the base)
        try {
            this.setStatus(`${label} ...`);
            if (this.pending) this.cancelPending();
            if (this.textEdit) this.endTextEdit(true);
            // every text layer's pixels as its description says, so the step below holds matching pairs; a render on its
            // way or scheduled is done now
            for (const l of this.layers) {
                if (l.kind !== "text" || !l.text || !(l._textTimer || l._textRendering)) continue;
                clearTimeout(l._textTimer); l._textTimer = null;
                await this.renderTextLayer(l);
            }
            const again = this.turnBlocked();
            if (again) { this.setStatus(again); return false; }
            const W = this.width, H = this.height, [nw, nh] = turnSize(op, W, H);
            before = this.snapshot({ kind: "canvas" });
            const gen = this.historyGen, base0 = this.basePx;
            // the base first: the upload is the only wait, and nothing else is replaced before it is done (as in crop)
            const px = this.basePx.turned(op);
            const { ref } = await this.uploadBase(px);
            // what happened meanwhile: an edit (a stroke, a selection, a merge) is in the document and not in the turn's
            // step, a drag or a transform works in the old geometry. Nothing is turned then, and the user turns again
            const busy = this.turnBlocked();
            if (this.historyGen !== gen || this.basePx !== base0 || this.width !== W || this.height !== H || this.gestureHeld() || busy) {
                if (typeof px.release === "function") px.release();
                this.releaseSnapshot(before); before = null;
                this.setStatus(busy || "The picture changed while it was being turned, so nothing was turned. Turn it again.");
                return false;
            }
            if (this.pending) this.cancelPending();
            // every new store first, then all of them at once: a failure half way leaves the document as it was
            const turned = new Map();
            for (const l of this.layers) {
                turned.set(l, { px: l.kind !== "filter" && l.px ? l.px.turned(op) : null, maskPx: l.maskPx ? l.maskPx.turned(op) : null });
            }
            const sel = this.sel.turned(op);
            for (const l of this.layers) {
                const t = turned.get(l);
                if (l.kind === "filter") {
                    // the whole canvas: the size follows, its (unused, empty) pixels stay as crop leaves them
                    l.w = nw; l.h = nh;
                } else {
                    [l.x, l.y, l.w, l.h] = turnRect(op, l.x, l.y, l.w, l.h, W, H);
                    // new pixels (the canvas step holds the old ones), turned in their own resolution
                    if (t.px) l.px = t.px;
                    if (l.kind === "text" && l.text) {
                        // the next render (an edit) puts the text in this orientation itself; the text field's pending
                        // undo step is from before the turn, whose own step holds the layer as it was
                        l.text = composeTextOrient(l.text, op);
                        if (l._textUndo) this.releaseSnapshot(l._textUndo);
                        l._textUndo = null;
                    }
                }
                if (t.maskPx) l.maskPx = t.maskPx;
            }
            this.sel = sel;
            const A = xfOfOp(op, W, H);
            this.geometrySeq++;
            this.mapExtras(A, "turn");
            this.mapGuides(A, nw, nh);
            this.docXf = snapXf(xfMul(A, this.docXf));
            this.base = { ref, px };
            this.width = nw; this.height = nh;
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label });
            // every layer's caches and files, once for the document (markLayerChanged would redraw per layer)
            for (const l of this.layers) {
                l.dirty = l.kind !== "filter";
                l.exportRef = null;
                l._maskedValid = false; l._mcache = null; l._mcacheView = null; l._mcacheSample = null;
                l._mstats = null; l._mstatsSample = null; l._mstatsSampleRun = null; l._mstatsStack = null; l._mstatsStackRun = null;
                l._fcache = null; l._fcacheView = null; l._fcacheSample = null; l._fxCache = null; l._bstats = null; l._bstatsRun = null;
                if (l.maskPx) { l.maskDirty = true; this.touchSource(l.maskPx); }
                if (l.kind !== "filter") this.touchSource(l.px);
                this.touchSource(l._masked);
            }
            this.scheduleDetachedRelease();
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.touchSource(this.sel);
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            // what was under way in the old geometry
            this.polyPoints = null; this.lassoPoints = null; this.shapePoints = null; this.shapeDrag = null;
            this.cloneSource = null; this.hover = null;
            if (this.extendInputs) for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.renderLayers(); this.renderHistory(); this.renderSelectionList(); this.renderInfo(); this.updateSubbar();
            this.fitView(); this.drawThumb();
            // plugins with image coordinates of their own (the film look's control points, 3D objects) follow
            host.changed(this, { geometry: { kind: "turn", op, m: A, from: { width: W, height: H }, to: { width: nw, height: nh } } });
            this.notifyChanged();
            // every layer's file is the old orientation now: uploaded at once, or a restored session (a crash before the
            // next edit) would put the upright files into the turned rectangles
            this.syncLayers().catch((err) => console.warn("Inpaint Canvas: the turned layers could not be stored", err));
            this.setStatus(`${label}: the picture is ${nw} × ${nh}, every layer turned with it (Ctrl+Z takes it back).`);
            return true;
        } catch (err) {
            if (!pushed && before) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
            return false;
        } finally {
            this._turning = false;
        }
    }

    /**
     * What no pixels carry, mapped forward by A (image units, from the picture now to the picture after a whole-document
     * operation; PLAN_0_1_31 §7). Each results-history entry: a map that only moves, scales, turns by quarters and mirrors
     * moves its rectangle and composes its `orient` (a restore stays exact); any other (a straighten) gives it an `xf`,
     * its file's unit square in the document, which later maps compose into and which becomes a rectangle again when a
     * chain (an undo) makes it one. Each saved selection: its `xf` (its PNG, after its legacy `orient`, to the document).
     * The export size (`kind`, the operation: "turn" swaps a fixed size on a quarter turn; "crop", "extend", "resize",
     * "straighten" let the percentage decide again; "undo" leaves it, the step puts its own back). Guides: `mapGuides`.
     */
    mapExtras(A, kind) {
        const o = orientOfXf(A);
        for (const h of this.history || []) {
            if (![h.x, h.y, h.w, h.h].every(Number.isFinite)) continue;
            if (!h.xf && o) {
                const b = xfBox(A, h.x, h.y, h.x + h.w, h.y + h.h);
                [h.x, h.y, h.w, h.h] = [snapNum(b[0]), snapNum(b[1]), snapNum(b[2] - b[0]), snapNum(b[3] - b[1])];
                const no = orientChain(h.orient, o);
                if (orientIsUp(no)) delete h.orient; else h.orient = no;
                continue;
            }
            const xf = snapXf(xfMul(A, placeXf(h)));
            const b = xfBox(xf, 0, 0, 1, 1);
            [h.x, h.y, h.w, h.h] = [snapNum(b[0]), snapNum(b[1]), snapNum(b[2] - b[0]), snapNum(b[3] - b[1])];
            const back = orientOfXf(xf);
            // quarter turns and mirrors again (a straighten and its undo): the rectangle and the orientation are exact
            if (back) { delete h.xf; if (orientIsUp(back)) delete h.orient; else h.orient = back; } else h.xf = xf;
        }
        for (const sv of this.savedSelections || []) {
            const xf = snapXf(xfMul(A, sv.xf || XF_IDENTITY));
            if (xfIsIdentity(xf)) delete sv.xf; else sv.xf = xf;
        }
        if (this.maps) {
            let anyMap = false;
            for (const map of Object.values(this.maps)) {
                if (!map || !map.xf) continue;
                map.xf = snapXf(xfMul(A, map.xf));
                anyMap = true;
            }
            if (anyMap) this.mapsVersion++;
        }
        for (const l of this.layers || []) {
            if (l && l.kind === "filter" && l.filter === "relight" && l.params && Array.isArray(l.params.lights)) {
                for (const light of l.params.lights) {
                    if (!light) continue;
                    const [nx, ny] = xfApply(A, light.x, light.y);
                    light.x = Math.round(nx);
                    light.y = Math.round(ny);
                    if (Array.isArray(light.aim)) {
                        const [ax, ay] = xfApply(A, light.aim[0], light.aim[1]);
                        light.aim[0] = Math.round(ax);
                        light.aim[1] = Math.round(ay);
                    }
                }
                if (l._relight) {
                    l._relight.vis = null;
                }
            }
        }
        // the editor's own boxes follow (the node; the app's Boxes plugin hears the geometry event instead): an undo puts
        // the snapshot's data back, so it never maps
        if (this.boxes && kind !== "undo") this.boxes.mapGeometry(A);
        const e = this._export;   // the app's export settings (host.js); the node has none
        if (e && kind === "turn" && o && (o.turn & 1)) {
            [e.width, e.height] = [e.height, e.width];
            [e.canvasW, e.canvasH] = [e.canvasH, e.canvasW];
        } else if (e && kind !== "turn" && kind !== "undo" && e.width > 0 && e.height > 0) {
            // a fixed export size of the old shape would stretch the new one: the percentage decides again
            e.width = 0; e.height = 0;
        }
    }

    /**
     * The guides mapped forward by G, a map that moves, scales, turns by quarters or mirrors (a straighten passes the shift
     * of its crop alone: a guide is not turned by a few degrees, it stays where it is on the screen): a vertical guide
     * becomes a horizontal one under a quarter turn, and one that leaves the new picture (0..nw, 0..nh) is dropped. New
     * arrays: an undo step holds the old ones.
     */
    mapGuides(G, nw, nh) {
        const g = this.guides || { x: [], y: [] };
        const swap = Math.abs(G[0]) < 1e-9 && Math.abs(G[3]) < 1e-9;
        const x = [], y = [];
        for (const a of g.x || []) { if (swap) y.push(snapNum(G[1] * a + G[5])); else x.push(snapNum(G[0] * a + G[4])); }
        for (const b of g.y || []) { if (swap) x.push(snapNum(G[2] * b + G[4])); else y.push(snapNum(G[3] * b + G[5])); }
        this.guides = { ...g, x: x.filter((v) => v >= 0 && v <= nw), y: y.filter((v) => v >= 0 && v <= nh) };
    }

    /** The export size fields as they are (a canvas step and a snapshot keep them), or null in the node. */
    exportSizeCopy() {
        const e = this._export;
        return e ? { width: e.width, height: e.height, canvasW: e.canvasW, canvasH: e.canvasH } : null;
    }

    /**
     * A canvas or turn snapshot is about to be put back: the results history and the saved selections are mapped by the
     * difference between the snapshot's map and the document's (a snapshot from before a crop moves them back, and an
     * entry made after the crop survives its undo); the guides, the export size and the plugin data the snapshot kept
     * come back as they were.
     */
    restoreGeometry(snap) {
        if (validXf(snap.xf)) {
            const D = xfMul(snap.xf, xfInv(this.docXf));
            if (!xfIsIdentity(D)) this.mapExtras(D, "undo");
            this.docXf = snap.xf.slice();
        }
        if (snap.guides) this.guides = { x: snap.guides.x.slice(), y: snap.guides.y.slice() };
        if (snap.exportSize && this._export) Object.assign(this._export, snap.exportSize);
        if (snap.pluginData !== undefined) this.pluginData = snap.pluginData ? JSON.parse(JSON.stringify(snap.pluginData)) : {};
    }

    /** What a canvas or turn snapshot keeps of the geometry besides the pixels (`restoreGeometry` puts it back). */
    geometrySnapshot() {
        const g = this.guides || { x: [], y: [] };
        return { xf: this.docXf.slice(), guides: { x: (g.x || []).slice(), y: (g.y || []).slice() }, exportSize: this.exportSizeCopy(), pluginData: this.pluginDataCopy() };
    }

    /**
     * After a whole-document operation that is not a turn (crop, extend, resize; the turn and the straighten do this in
     * their own run): the extras and the guides follow A, the document's map composes it, and the plugins hear of it.
     */
    followGeometry(kind, A, from, to) {
        this.geometrySeq++;
        this.mapExtras(A, kind);
        this.mapGuides(A, to.width, to.height);
        this.docXf = snapXf(xfMul(A, this.docXf));
        host.changed(this, { geometry: { kind, m: A, from, to } });
    }

    /** The plugins' per-document data as it is now (a copy), for a step that replaces the geometry it refers to. */
    pluginDataCopy() {
        return this.pluginData && typeof this.pluginData === "object" ? JSON.parse(JSON.stringify(this.pluginData)) : null;
    }

    /**
     * After a change of the whole picture that may keep its size (a flip, a half turn, their undo): a new composite version
     * (`makeUploaded` swaps the upload cache without one) and no cached flatten, object map or sampled stats, which a
     * size check would otherwise have caught.
     */
    dropCompositeCaches() {
        this.uploaded.baseHash = null;   // the setter bumps compositeVersion
        this.uploaded.controlHash = null;
        this.flatCache = null;
        this.objects = null;
        this.objectShapeCache.clear();
        this.hoverObjectId = 0; this.hoverObjectCanvas = null;
        this._depthOverlayCanvas = null;
        this._picStats = null;
        this._picStatsRun = null;
        this._rangeTint = null;
        this._rangeSampleCache = null;
        if (this._mapHistCache) this._mapHistCache.clear();
        if (this._simHistCache) this._simHistCache.clear();
        if (this._depthProxies) this._depthProxies.clear();
    }

    // ---- the whole document straightened and cropped in one step (PLAN_0_1_31 §7, 23b) -------------------------------

    /**
     * Turn the whole document by `angle` degrees (clockwise) about its centre and crop it to the frame `x, y, w, h` (frame
     * space: the turned picture; the largest frame of the picture's own aspect inside it when left out): the base, every
     * layer with its mask, the selection and the filter layers' masks resampled once (inpaint_resample.js, in the pool),
     * text layers turned by their description, reference layers moved, the rest (the results history, the saved
     * selections, the guides, the export size, the plugins) following. One undo step. False with a status line when it
     * cannot run. Serialised with the document's turns and waiting for every edit under way, as they do.
     */
    /** An aspect preset as a ratio w / h: "original" the picture's own, "free" null, "4:3" or "W:H" their ratio; undefined for none. */
    aspectRatio(name) {
        const s = String(name || "original").trim().toLowerCase();
        if (s === "original") return this.width / this.height;
        if (s === "free") return null;
        const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(s);
        return m && +m[1] > 0 && +m[2] > 0 ? +m[1] / +m[2] : undefined;
    }

    /** The largest frame of `ratio` (null: any) centred in the picture turned by `deg`: [x, y, w, h] in frame space. */
    fitFrame(deg, ratio) {
        return autoCropFrame(this.width, this.height, deg, ratio);
    }

    straightenDocument(opts) {
        const waitFor = [this._turnQueue, ...(this._pendingEdits ? Array.from(this._pendingEdits) : [])].filter(Boolean);
        const run = Promise.all(waitFor).then(() => this.straightenDocumentNow(opts));
        this._turnQueue = run.then(() => {}, () => {});
        return this.trackEdit(run);
    }

    async straightenDocumentNow({ angle = 0, x = null, y = null, w = null, h = null } = {}) {
        if (!this.base) { this.setStatus("Load an image first."); return false; }
        const deg = normDeg(+angle || 0);
        const W = this.width, H = this.height;
        let frame = [x, y, w, h].every((v) => v !== null && v !== undefined && Number.isFinite(+v)) ? [x, y, w, h].map((v) => Math.round(+v)) : autoCropFrame(W, H, deg, W / H);
        if (!(frame[2] >= 8 && frame[3] >= 8)) { this.setStatus("The frame would be smaller than 8 px.", "warn"); return false; }
        if (!deg && frame[0] === 0 && frame[1] === 0 && frame[2] === W && frame[3] === H) { this.setStatus("Nothing to straighten or crop."); return false; }
        if (!deg && (frame[0] < 0 || frame[1] < 0 || frame[0] + frame[2] > W || frame[1] + frame[3] > H)) { this.setStatus("A frame past the picture extends the canvas: use Extend.", "warn"); return false; }
        if (deg && !frameInside(W, H, deg, ...frame)) { this.setStatus("The frame reaches past the turned picture: keep it inside when the picture is turned.", "warn"); return false; }
        // a turned frame can be wider than the picture: no side past what a canvas draws (its area stays within the document's)
        if (frame[2] > CANVAS_MAX_SIDE || frame[3] > CANVAS_MAX_SIDE) { this.setStatus(canvasSizeRefusal(frame[2], frame[3], "The straightened picture"), "warn"); return false; }
        const blocked = this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return false; }
        const [fx, fy, nw, nh] = frame;
        const label = deg ? "Straighten and crop" : "Crop canvas";
        const A = straightenXf(W, H, deg, fx, fy), Ainv = xfInv(A);
        let before = null, pushed = false;
        const made = [];   // every new store, released when the step does not happen
        const keep = (p) => { if (p) made.push(p); return p; };
        this._turning = true;   // crop, resize, extend, merge and flatten wait for it (they would replace the base)
        try {
            this.setStatus(`${label} ...`);
            if (this.pending) this.cancelPending();
            if (this.textEdit) this.endTextEdit(true);
            for (const l of this.layers) {
                if (l.kind !== "text" || !l.text || !(l._textTimer || l._textRendering)) continue;
                clearTimeout(l._textTimer); l._textTimer = null;
                await this.renderTextLayer(l);
            }
            const again = this.turnBlocked();
            if (again) { this.setStatus(again); return false; }
            before = this.snapshot({ kind: "canvas" });
            const gen = this.historyGen, base0 = this.basePx;
            const textSeen = new Map(this.layers.filter((l) => l.kind === "text" && l.text).map((l) => [l, { json: JSON.stringify(l.text), px: l.px }]));
            // every new store, in the pool (the window keeps drawing); nothing is assigned before all of them are there
            const onCanvas = pixelMap(Ainv);
            const jobs = [];
            const basePx = keep(await this.basePx.transformedAsync(onCanvas, nw, nh, { edge: "clamp" }));
            const plan = new Map();
            for (const l of this.layers) {
                const p = {};
                plan.set(l, p);
                if (l.kind === "filter") {
                    if (l.maskPx) jobs.push(l.maskPx.transformedAsync(onCanvas, nw, nh, { color: MASK_RGB }).then((m) => { p.maskPx = keep(m); }));
                    continue;
                }
                if (this.isReference(l)) {
                    // a model's input, not part of the picture: moved (its middle mapped), not resampled
                    const [cx, cy] = xfApply(A, l.x + l.w / 2, l.y + l.h / 2);
                    p.rect = [Math.round(cx - l.w / 2), Math.round(cy - l.h / 2), l.w, l.h];
                    continue;
                }
                if (l.kind === "text" && l.text) {
                    // turned by its description and drawn at the angle, never resampled; its middle follows the picture
                    const text = spinText(l.text, deg);
                    jobs.push(renderText(text).then((r) => {
                        let px = this.pixels.Layer.fromCanvas(r.canvas);
                        if (!r.oriented) for (const op of orientOps(text)) px = px.turned(op);
                        const oldRes = l.text.res || 2;
                        let k = l.px && l.px.width > 1 ? l.w / (l.px.width / oldRes) : 1;
                        if (l.px && Math.abs(k - 1) * (l.px.width / oldRes) < 1) k = 1;
                        const tw = Math.max(1, Math.round(px.width / r.res * k)), th = Math.max(1, Math.round(px.height / r.res * k));
                        const [cx, cy] = xfApply(A, l.x + l.w / 2, l.y + l.h / 2);
                        p.text = { ...text, res: r.res, ...(r.box ? { box: r.box } : {}) };
                        p.px = keep(px);
                        p.rect = [Math.round(cx - tw / 2), Math.round(cy - th / 2), tw, th];
                        if (l.maskPx) {
                            const [nx, ny] = p.rect;
                            const inv = xfMul(xfInv([l.w / l.maskPx.width, 0, 0, l.h / l.maskPx.height, l.x, l.y]), xfMul(Ainv, [tw / px.width, 0, 0, th / px.height, nx, ny]));
                            p.maskPx = keep(l.maskPx.transformed(pixelMap(inv), px.width, px.height, { color: MASK_RGB }));
                        }
                    }));
                    continue;
                }
                if (!l.px) continue;
                const pw = l.px.width, ph = l.px.height;
                const whole = l.x === 0 && l.y === 0 && l.w === W && l.h === H && pw === W && ph === H;
                let rect, npw, nph, map, edge;
                if (whole) {
                    // a layer over the whole canvas stays one: resampled onto the new canvas like the base
                    rect = [0, 0, nw, nh]; npw = nw; nph = nh; map = onCanvas; edge = "clamp";
                } else {
                    // any other keeps its whole turned rectangle (as a crop keeps pixels) at its own resolution
                    rect = boxOnPixels(A, l.x, l.y, l.w, l.h);
                    const rx = pw / l.w, ry = ph / l.h;
                    npw = Math.max(1, Math.round(rect[2] * rx)); nph = Math.max(1, Math.round(rect[3] * ry));
                    map = pixelMap(xfMul(xfInv([l.w / pw, 0, 0, l.h / ph, l.x, l.y]), xfMul(Ainv, [rect[2] / npw, 0, 0, rect[3] / nph, rect[0], rect[1]])));
                    edge = "transparent";
                }
                p.rect = rect;
                jobs.push(l.px.transformedAsync(map, npw, nph, { edge }).then((q) => { p.px = keep(q); }));
                if (l.maskPx) jobs.push(l.maskPx.transformedAsync(map, npw, nph, { color: MASK_RGB, edge }).then((m) => { p.maskPx = keep(m); }));
            }
            let sel = null;
            jobs.push(this.sel.transformedAsync(onCanvas, nw, nh).then((m) => { sel = keep(m); }));
            await Promise.all(jobs);
            const { ref } = await this.uploadBase(basePx);
            // what happened meanwhile: an edit is in the document and not in the step, a drag works in the old geometry
            // a job or a save started meanwhile (it works in the old geometry), and a text typed or recoloured meanwhile
            // (its description is not the one the plan turned), stop it too
            const busy = this.turnBlocked();
            const textMoved = [...textSeen].some(([l, s]) => JSON.stringify(l.text) !== s.json || l.px !== s.px || l._textTimer || l._textRendering);
            if (this.historyGen !== gen || this.basePx !== base0 || this.width !== W || this.height !== H || this.gestureHeld() || busy || textMoved) {
                for (const p of made) if (typeof p.release === "function") p.release();
                made.length = 0;
                this.releaseSnapshot(before); before = null;
                this.setStatus(busy || "The picture changed while it was being straightened, so nothing was changed. Straighten it again.");
                return false;
            }
            if (this.pending) this.cancelPending();
            for (const l of this.layers) {
                const p = plan.get(l);
                if (!p) continue;
                if (l.kind === "filter") { l.w = nw; l.h = nh; if (p.maskPx) l.maskPx = p.maskPx; continue; }
                if (p.rect) [l.x, l.y, l.w, l.h] = p.rect;
                if (p.px) l.px = p.px;
                if (p.maskPx) l.maskPx = p.maskPx;
                if (p.text) { l.text = p.text; if (l._textUndo) this.releaseSnapshot(l._textUndo); l._textUndo = null; }
            }
            this.sel = sel;
            this.geometrySeq++;
            this.mapExtras(A, "straighten");
            // a guide is not turned by a few degrees: it stays where it was on the screen, shifted by the crop
            this.mapGuides(xfTranslate(-fx, -fy), nw, nh);
            this.docXf = snapXf(xfMul(A, this.docXf));
            this.base = { ref, px: basePx };
            this.width = nw; this.height = nh;
            pushed = true;
            made.length = 0;
            this.pushUndoSnapshot(before, { tracked: true, label });
            for (const l of this.layers) {
                l.dirty = l.kind !== "filter";
                l.exportRef = null;
                l._maskedValid = false; l._mcache = null; l._mcacheView = null; l._mcacheSample = null;
                l._mstats = null; l._mstatsSample = null; l._mstatsSampleRun = null; l._mstatsStack = null; l._mstatsStackRun = null;
                l._fcache = null; l._fcacheView = null; l._fcacheSample = null; l._fxCache = null; l._bstats = null; l._bstatsRun = null;
                if (l.maskPx) { l.maskDirty = true; this.touchSource(l.maskPx); }
                if (l.kind !== "filter") this.touchSource(l.px);
                this.touchSource(l._masked);
            }
            this.scheduleDetachedRelease();
            this.uploaded = this.makeUploaded();
            this.dropCompositeCaches();
            this.touchSource(this.sel);
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            this.polyPoints = null; this.lassoPoints = null; this.shapePoints = null; this.shapeDrag = null;
            this.cloneSource = null; this.hover = null;
            if (this.extendInputs) for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.renderLayers(); this.renderHistory(); this.renderSelectionList(); this.renderInfo(); this.updateSubbar();
            this.fitView(); this.drawThumb();
            host.changed(this, { geometry: { kind: "straighten", m: A, from: { width: W, height: H }, to: { width: nw, height: nh } } });
            this.notifyChanged();
            this.syncLayers().catch((err) => console.warn("Inpaint Canvas: the straightened layers could not be stored", err));
            this.setStatus(`${label}: the picture is ${nw} × ${nh}${deg ? `, turned ${Math.round(deg * 100) / 100}°` : ""} (Ctrl+Z takes it back).`);
            return true;
        } catch (err) {
            for (const p of made) if (typeof p.release === "function") p.release();
            if (!pushed && before) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
            return false;
        } finally {
            this._turning = false;
        }
    }

    // ---- canvas tool: extend by dragging the frame ---------------------------------

    // ---- the canvas frame (PLAN_0_1_31 §7, 23b): pending until Enter, Apply or a double click, reset by Esc -------------

    /**
     * The pending canvas frame or null: `{ base, x, y, w, h, angle }` in frame space (the picture turned by `angle` about
     * its centre as the Canvas tool shows it; image space at 0 degrees). It belongs to the picture it was made on: a new
     * image, a crop, a turn or the undo of one drops it. A tool switch keeps it (it is drawn in the Canvas tool only).
     */
    frame() {
        const f = this.canvasFrame;
        if (f && f.base !== this.base) { this.canvasFrame = null; this.syncFrameControls(); return null; }
        return f;
    }

    /** The frame, or the whole picture upright when there is none: what the controls and the gestures start from. */
    frameOrCanvas() {
        return this.frame() || { base: this.base, x: 0, y: 0, w: this.width, h: this.height, angle: 0 };
    }

    /** Is there a frame that would change the picture? */
    framePending() {
        const f = this.frame();
        return !!f && (!!f.angle || f.x !== 0 || f.y !== 0 || f.w !== this.width || f.h !== this.height);
    }

    /** The aspect preset as a ratio w / h (null: free), on its side when X turned it. */
    frameRatio() {
        const name = this.frameAspect || "free", c = this.frameCustom || [4, 3];
        const r = name === "custom" ? (c[0] > 0 && c[1] > 0 ? c[0] / c[1] : null) : this.aspectRatio(name);
        if (!r) return null;
        return this.frameAspectFlip ? 1 / r : r;
    }

    /**
     * Set the frame (any of x, y, w, h, angle; the rest kept): whole pixels, at least 8 a side, the angle within 45 degrees
     * either way, and at an angle inside the turned picture: a frame that would reach past it is pulled back towards
     * `prev` (the last good one) by bisection, or fitted anew when there is none.
     */
    setFrame(patch, prev = null) {
        if (!this.base) return;
        const f = { ...this.frameOrCanvas(), ...patch, base: this.base };
        f.angle = Math.max(-45, Math.min(45, Math.round((+f.angle || 0) * 100) / 100));
        f.w = Math.max(8, Math.round(f.w)); f.h = Math.max(8, Math.round(f.h)); f.x = Math.round(f.x); f.y = Math.round(f.y);
        const W = this.width, H = this.height;
        if (f.angle && !frameInside(W, H, f.angle, f.x, f.y, f.w, f.h)) {
            const from = prev && prev.angle === f.angle && frameInside(W, H, f.angle, prev.x, prev.y, prev.w, prev.h) ? prev : null;
            if (!from) {
                const [x, y, w, h] = this.fitFrame(f.angle, this.frameRatio());
                Object.assign(f, { x, y, w, h });
            } else {
                let lo = 0, hi = 1;   // how much of the way from `from` to `f` stays inside
                const at = (k, t) => Math.round(from[k] + (f[k] - from[k]) * t);
                for (let i = 0; i < 14; i++) {
                    const t = (lo + hi) / 2;
                    if (frameInside(W, H, f.angle, at("x", t), at("y", t), at("w", t), at("h", t))) lo = t; else hi = t;
                }
                for (const k of ["x", "y", "w", "h"]) f[k] = at(k, lo);
            }
        }
        this.canvasFrame = f;
        this.syncFrameControls();
        this.drawSoon();
    }

    /** The frame turned to `deg` degrees (clockwise, 45 at most either way) and fitted: the largest frame of the aspect inside. */
    setFrameAngle(deg) {
        if (!this.base) return;
        deg = Math.max(-45, Math.min(45, Math.round((+deg || 0) * 100) / 100));
        const [x, y, w, h] = this.fitFrame(deg, this.frameRatio());
        this.setFrame({ x, y, w, h, angle: deg });
        this.setStatus(this.frameStatus());
    }

    /** The frame fitted to the aspect preset at its angle: the largest such frame, centred in the (turned) picture. */
    fitFrameToAspect() {
        this.setFrameAngle(this.frameOrCanvas().angle);
    }

    /** The aspect on its side (X). */
    swapFrameAspect() {
        if (!this.frameRatio()) { this.setStatus("A free frame has no aspect to turn: pick one first."); return; }
        this.frameAspectFlip = !this.frameAspectFlip;
        this.fitFrameToAspect();
        this.syncFrameControls();
    }

    resetFrame() {
        this.canvasFrame = null;
        this.frameStraighten = false;
        this.syncFrameControls();
        this.draw();
    }

    /** What the status line says about the frame. */
    frameStatus() {
        const f = this.frameOrCanvas();
        if (!this.framePending()) return "The frame is the whole picture: drag its edges to crop or extend, drag outside it to turn the picture.";
        return `Frame ${f.w} × ${f.h}${f.angle ? `, the picture turned ${f.angle}°` : ""}: Enter, Apply or a double click inside applies it, Esc resets.`;
    }

    /** The size line of the Canvas section: the picture now, and what the frame would make of it. */
    frameInfoText() {
        if (!this.base) return "";
        const f = this.frameOrCanvas();
        return `now ${this.width} × ${this.height}` + (this.framePending() ? ` → ${f.w} × ${f.h}${f.angle ? `, ${f.angle}°` : ""}` : "");
    }

    /** Every control of the frame (the Canvas section's sides, the options bar) set from it. */
    syncFrameControls({ force = false } = {}) {
        const f = this.frame(), v = this.extendValues();
        // a field being typed in keeps what is typed, unless an apply just used it up
        const focused = !force && typeof document !== "undefined" ? document.activeElement : null;
        if (this.extendInputs) for (const k of Object.keys(this.extendInputs)) { const i = this.extendInputs[k]; if (i !== focused) i.value = v[k]; }
        const a = f ? f.angle : 0;
        if (this.frameAngleInput && this.frameAngleInput !== focused) this.frameAngleInput.value = a;
        if (this.frameAngleRange) this.frameAngleRange.value = a;
        if (this.frameAspectSel) this.frameAspectSel.value = this.frameAspect;
        if (this.frameCustomRow) this.frameCustomRow.hidden = this.tool !== "canvas" || this.frameAspect !== "custom";
        if (this.frameStraightenBtn) this.frameStraightenBtn.classList.toggle("ipc-on", !!this.frameStraighten);
        if (this.canvasInfo) this.canvasInfo.textContent = this.frameInfoText();
    }

    /**
     * Apply the pending frame. At an angle: a straighten, the picture turned and cropped in one step. Upright: sides past
     * the picture extend it (the outpainting border, selected), sides inside crop it, as the frame always did.
     */
    async applyFrame() {
        const f = this.frame();
        if (!f || !this.framePending()) { this.setStatus("Drag the frame first: its edges crop or extend, outside it turns the picture."); return false; }
        // a job that would land in the old geometry: the frame stays for when it is in
        const blocked = this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return false; }
        // taken off at once (a second Enter during the run must not apply it again), put back when the apply was refused
        this.canvasFrame = null;
        this.frameStraighten = false;
        this.syncFrameControls({ force: true });
        const base0 = this.base, W = this.width, H = this.height;
        let ok;
        if (f.angle) {
            ok = await this.straightenDocument({ angle: f.angle, x: f.x, y: f.y, w: f.w, h: f.h });
        } else {
            const v = { top: -f.y, right: f.x + f.w - W, bottom: f.y + f.h - H, left: -f.x };
            const pos = {}, neg = {};
            for (const k of Object.keys(v)) { pos[k] = Math.max(0, v[k]); neg[k] = Math.min(0, v[k]); }
            // the extend comes first and is made as one canvas: refused before either step, so the crop does not go alone;
            // a crop alone makes no such canvas (a tile document above 268 MP is cropped on its tiles)
            const extending = Object.values(pos).some((x) => x > 0);
            const tooBig = extending ? canvasSizeRefusal(W + pos.left + pos.right, H + pos.top + pos.bottom, "The frame's picture before its crop") : "";
            if (tooBig) {
                this.setStatus(tooBig, "warn");
                this.canvasFrame = f;
                this.syncFrameControls({ force: true });
                this.draw();
                return false;
            }
            if (Object.values(pos).some((x) => x > 0)) await this.extendCanvas(pos);
            if (Object.values(neg).some((x) => x < 0)) await this.cropCanvas(neg);
            ok = this.base !== base0;
        }
        if (!ok && this.base === base0 && this.width === W && this.height === H && !this.canvasFrame) this.canvasFrame = f;
        this.syncFrameControls({ force: true });
        this.draw();
        return !!ok;
    }

    /** The frame as sides in frame space (positive: added, negative: cut off): what the Canvas section shows. */
    extendValues() {
        const f = this.frameOrCanvas();
        return { top: -f.y, right: f.x + f.w - this.width, bottom: f.y + f.h - this.height, left: -f.x };
    }

    /** The frame from the Canvas section's four sides (the angle kept). */
    setFrameFromSides() {
        if (!this.extendInputs || !this.base) return;
        const v = {};
        for (const k of ["top", "right", "bottom", "left"]) v[k] = Math.round(+this.extendInputs[k].value || 0);
        // a side typed past the opposite one stops 8 px short of it: the opposite side stays where it is
        v.top = Math.max(v.top, -(this.height + v.bottom - 8)); v.left = Math.max(v.left, -(this.width + v.right - 8));
        this.setFrame({ x: -v.left, y: -v.top, w: this.width + v.left + v.right, h: this.height + v.top + v.bottom }, this.frame());
    }

    /** The Apply of the Canvas section and the old name of `applyFrame`. */
    applyCanvasFrame() { return this.applyFrame(); }

    /** Crop the canvas: negative amounts per side. Layers keep their pixels and shift; nothing is baked. */
    cropCanvas(v) { return this.trackEdit(this.cropCanvasNow(v)); }   // undo waits for the upload (see extendCanvas)

    async cropCanvasNow(v) {
        if (!this.base) return;
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        const blocked = this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return; }
        const W = this.width, H = this.height;
        const left = -Math.min(0, v.left || 0), top = -Math.min(0, v.top || 0);
        const right = -Math.min(0, v.right || 0), bottom = -Math.min(0, v.bottom || 0);
        const nw = W - left - right, nh = H - top - bottom;
        if (nw < 8 || nh < 8) { this.setStatus("The canvas would be smaller than 8 px.", "warn"); return; }
        if (!(left || top || right || bottom)) return;
        let before = null, pushed = false;
        try {
            this.setStatus(`Cropping canvas to ${nw} × ${nh} ...`);
            before = this.snapshot({ kind: "canvas" });
            if (this.pending) this.cancelPending();
            // C6 (d): on tiles the new base shares the old one's tiles; the upload reads a canvas made for it and let go
            const px = this.basePx.resized(nw, nh, { x: -left, y: -top });
            const { ref } = await this.uploadBase(px);
            for (const l of this.layers) {
                if (l.kind === "filter") {
                    l.w = nw; l.h = nh; l._fcache = null;
                    // a new object (the canvas undo step holds the old one): the old mask placed at -left, -top
                    if (l.maskPx) { l.maskPx = l.maskPx.resized(nw, nh, { x: -left, y: -top }); l.maskDirty = true; }
                } else {
                    l.x -= left; l.y -= top;
                }
            }
            // a new object (the canvas undo step holds the old one): the old selection placed at -left, -top
            this.sel = this.sel.resized(nw, nh, { x: -left, y: -top });
            this.base = { ref, px };
            this.width = nw; this.height = nh;
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label: "Crop canvas" });
            this.uploaded = this.makeUploaded();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            this.followGeometry("crop", xfTranslate(-left, -top), { width: W, height: H }, { width: nw, height: nh });
            this.renderLayers(); this.renderHistory(); this.renderInfo(); this.fitView(); this.drawThumb(); this.notifyChanged();
            this.setStatus(`Canvas cropped to ${nw} × ${nh}; the layers keep their pixels (Ctrl+Z takes it back).`);
        } catch (err) {
            if (!pushed) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }

    /** Scale the whole image (base, layers, selection) to a new size. */
    resizeImage(nw, nh, opts) { return this.trackEdit(this.resizeImageNow(nw, nh, opts)); }   // undo waits for the upload (see extendCanvas)

    /** `base`: the new base's pixels at nw x nh (an upscaler's answer) instead of the old base resampled. */
    async resizeImageNow(nw, nh, { base = null } = {}) {
        if (!this.base) return;
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        // an upscale's own landing (`base`) is let through: its paid answer is in; runUpscale checks before it asks
        const blocked = base ? "" : this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return; }
        nw = Math.round(nw); nh = Math.round(nh);
        if (!(nw >= 8 && nh >= 8) || (nw === this.width && nh === this.height)) { this.setStatus("Enter a new size."); return; }
        // the new picture is made as one canvas (S5): refused before anything is made, not an empty base
        const tooBig = canvasSizeRefusal(nw, nh, "The resized picture");
        if (tooBig) { this.setStatus(tooBig, "warn"); return; }
        const W = this.width, H = this.height, sx = nw / W, sy = nh / H;
        let before = null, pushed = false;
        try {
            this.setStatus(`Resizing to ${nw} × ${nh} ...`);
            // a filter preview shown goes back first: the sizes scaled below are the committed ones, which the step holds
            this.cancelPreviews();
            before = this.snapshot({ kind: "canvas" });
            if (this.pending) this.cancelPending();
            const nb = makeCanvas(nw, nh);
            const nctx = nb.getContext("2d");
            nctx.imageSmoothingEnabled = true;
            nctx.imageSmoothingQuality = "high";
            // C6 (d): from a canvas of the pixels, not the <img> they were decoded from (which is not kept). A scaled draw of
            // an image element and of a canvas go through different resamplers in Chromium: measured on four photos at
            // 0.37 / 0.5 / 0.8 / 1.6, 0.2 to 0.7 levels mean, at most 22, 0 to 3 % of bytes over 2 (identical at 0.5 on tiles)
            if (base) nctx.drawImage(base, 0, 0, nw, nh);
            else this.drawBaseInto(nctx, 0, 0, nw, nh);
            const { ref } = await uploadCanvas(nb, `n${this.node.id}_base`);
            const px = this.pixels.Layer.fromCanvas(nb);
            // again after the upload's wait, before anything is scaled: a hover or a slider drag begun meanwhile would be
            // scaled live and its cancel would write the unscaled values back
            this.cancelPreviews();
            let scaledFilters = 0, keptFilters = 0;
            for (const l of this.layers) {
                if (l.kind === "filter") {
                    l.w = nw; l.h = nh; l._fcache = null;
                    // item 57: its sizes in image pixels follow the picture (a 4 px blur is a 2 px one at half the size), a new
                    // params object the canvas step does not hold; relight's lights move in followGeometry. A filter of a
                    // plugin that is off keeps its values (the line says so)
                    if (!FILTERS[l.filter]) keptFilters++;
                    const scaled = scaleFilterParams(l.filter, l.params, sx, sy);
                    if (scaled) { l.params = scaled; l._fcacheView = null; l._fcacheSample = null; l._fxCacheSample = null; scaledFilters++; }
                    // a "before" an edit in progress still holds (a slider the list was rebuilt under, a hover left over)
                    // is in the new picture's sizes too, or its step would put the old ones back later
                    for (const k of ["_undoPending", "_hoverSnap"]) {
                        const snap = l[k];
                        if (!snap || snap.kind !== "filter" || !snap.params) continue;
                        const sp = scaleFilterParams(snap.filter || l.filter, snap.params, sx, sy);
                        if (sp) snap.params = sp;
                    }
                    if (l.maskPx) { const m = makeCanvas(nw, nh); const mc = m.getContext("2d"); mc.imageSmoothingEnabled = true; l.maskPx.drawTo(mc, 0, 0, nw, nh); l.maskPx = this.pixels.Mask.fromCanvas(m); l.maskDirty = true; }
                } else {
                    l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy);
                    l.w = Math.max(1, Math.round(l.w * sx)); l.h = Math.max(1, Math.round(l.h * sy));
                    l._maskedValid = false; l._mcache = null;
                }
            }
            const sel = makeCanvas(nw, nh);
            const sc = sel.getContext("2d");
            sc.imageSmoothingEnabled = true;
            this.sel.drawTo(sc, 0, 0, nw, nh);
            this.sel = this.pixels.Mask.fromCanvas(sel);
            this.base = { ref, px };
            this.width = nw; this.height = nh;
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label: base ? "Upscale image" : "Resize image" });
            this.uploaded = this.makeUploaded();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            this.followGeometry("resize", xfScale(sx, sy), { width: W, height: H }, { width: nw, height: nh });
            this.renderLayers(); this.renderHistory(); this.renderInfo(); this.fitView(); this.drawThumb(); this.notifyChanged();
            let scaledNote = scaledFilters ? ` The sizes in pixels of ${scaledFilters} filter layer${scaledFilters === 1 ? "" : "s"} scaled along.` : "";
            if (keptFilters) scaledNote += keptFilters === 1 ? " 1 filter layer of a plugin that is off kept its sizes." : ` ${keptFilters} filter layers of plugins that are off kept their sizes.`;
            this.setStatus(`Image ${base ? "upscaled" : "resized"} to ${nw} × ${nh} (Ctrl+Z takes it back). Layers keep their own resolution.${scaledNote}`);
        } catch (err) {
            if (!pushed) this.releaseSnapshot(before);
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }

    extendPending() { return this.framePending(); }

    resetExtend() { this.resetFrame(); }

    /** The frame's rectangle in frame space (image coordinates when upright; the current canvas is 0,0 .. width,height). */
    extendRect() {
        const f = this.frameOrCanvas();
        return { x: f.x, y: f.y, w: f.w, h: f.h };
    }

    /**
     * A drag of a frame handle: the side or corner follows (8 px steps upright, Alt for single pixels; whole pixels at an
     * angle), the opposite one stays; with an aspect a corner keeps it (the larger change leads) and an edge takes the
     * other side along about the middle; Shift frees the aspect.
     */
    dragFrameHandle(p, ix, iy, e) {
        const o = p.orig, h = p.handle, step = o.angle || e.altKey ? 1 : 8;
        const q = (v) => Math.round(v / step) * step;
        const dx = q(ix - p.start[0]), dy = q(iy - p.start[1]);
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (h.includes("w")) x0 = Math.min(x1 - 8, o.x + dx);
        if (h.includes("e")) x1 = Math.max(x0 + 8, o.x + o.w + dx);
        if (h.includes("n")) y0 = Math.min(y1 - 8, o.y + dy);
        if (h.includes("s")) y1 = Math.max(y0 + 8, o.y + o.h + dy);
        const r = e.shiftKey ? null : this.frameRatio();
        if (r) {
            let w = x1 - x0, hh = y1 - y0;
            if (h.length === 2) {
                if (Math.abs(w - o.w) / o.w >= Math.abs(hh - o.h) / o.h) hh = w / r; else w = hh * r;
                if (h.includes("w")) x0 = x1 - w; else x1 = x0 + w;
                if (h.includes("n")) y0 = y1 - hh; else y1 = y0 + hh;
            } else if (h === "e" || h === "w") {
                hh = w / r;
                const cy = o.y + o.h / 2; y0 = cy - hh / 2; y1 = cy + hh / 2;
            } else {
                w = hh * r;
                const cx = o.x + o.w / 2; x0 = cx - w / 2; x1 = cx + w / 2;
            }
        }
        this.setFrame({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, this.frame());
        this.setStatus(this.frameStatus());
    }

    canvasHandleAt(ix, iy) {
        if (!this.width) return null;
        const r = HANDLE_PX / this.view.scale;
        const handles = this.layerHandles(this.extendRect());
        for (const name of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
            const [cx, cy] = handles[name];
            if (Math.abs(ix - cx) <= r && Math.abs(iy - cy) <= r) return name;
        }
        return null;
    }

    // ---- outpainting ---------------------------------------------------------

    /**
     * Extend, crop, resize, merge into the base and flatten take their `canvas` step, upload the new
     * base and push the step when it lands. They are tracked (`trackEdit`), so an undo pressed during
     * the upload waits and takes the operation back; untracked, it undid the step below and the late
     * push then released that undo's redo copy (a stroke lost for good, a merged layer twice).
     */
    extendCanvas(vals = null) { return this.trackEdit(this.extendCanvasNow(vals)); }

    async extendCanvasNow(vals = null) {
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        const blocked = this.turnBlocked();
        if (blocked) { this.setStatus(blocked); return; }
        if (!this.base) { this.setStatus("Load an image first."); return; }
        if (!vals && this.extendInputs && Object.values(this.extendValues()).some((x) => x < 0)) { await this.applyCanvasFrame(); return; }
        const v = vals || this.extendValues();
        const top = Math.max(0, v.top || 0), right = Math.max(0, v.right || 0), bottom = Math.max(0, v.bottom || 0), left = Math.max(0, v.left || 0);
        if (!(top || right || bottom || left)) { this.setStatus("Enter how many pixels to add on each side (negative crops)."); return; }
        const tooBig = canvasSizeRefusal(this.width + left + right, this.height + top + bottom, "The extended picture");
        if (tooBig) { this.setStatus(tooBig, "warn"); return; }
        await this.relightSettled();   // the flatten below becomes the new base: relight's full shadow maps first (F2.7)
        const W = this.width, H = this.height;
        const nw = W + left + right, nh = H + top + bottom;
        const before = this.snapshot({ kind: "canvas" });
        let pushed = false;
        try {
            this.setStatus(`Extending canvas to ${nw} × ${nh} ...`);
            // Flatten what is visible now and fill the new border the chosen way.
            const flat = this.flattenToCanvas({ forRun: true });
            const nb = makeCanvas(nw, nh);
            const ctx = nb.getContext("2d");
            const fill = (this.extendFillSel && this.extendFillSel.value) || "average color";
            if (fill === "stretch edges") {
                ctx.imageSmoothingEnabled = true;
                if (top) ctx.drawImage(flat, 0, 0, W, 1, left, 0, W, top);
                if (bottom) ctx.drawImage(flat, 0, H - 1, W, 1, left, top + H, W, bottom);
                if (left) ctx.drawImage(flat, 0, 0, 1, H, 0, top, left, H);
                if (right) ctx.drawImage(flat, W - 1, 0, 1, H, left + W, top, right, H);
                if (top && left) ctx.drawImage(flat, 0, 0, 1, 1, 0, 0, left, top);
                if (top && right) ctx.drawImage(flat, W - 1, 0, 1, 1, left + W, 0, right, top);
                if (bottom && left) ctx.drawImage(flat, 0, H - 1, 1, 1, 0, top + H, left, bottom);
                if (bottom && right) ctx.drawImage(flat, W - 1, H - 1, 1, 1, left + W, top + H, right, bottom);
            } else if (fill === "noise") {
                const img = ctx.createImageData(nw, nh);
                const d = img.data;
                for (let i = 0; i < d.length; i += 4) { d[i] = Math.random() * 255; d[i + 1] = Math.random() * 255; d[i + 2] = Math.random() * 255; d[i + 3] = 255; }
                ctx.putImageData(img, 0, 0);
            } else {
                let color = "#808080";
                if (fill === "green") color = "#00ff00";
                else if (fill === "black") color = "#000000";
                else if (fill === "average color") {
                    // mean of a 64 px thumbnail: cheap and close enough
                    const t = makeCanvas(64, 64); const tc = t.getContext("2d"); tc.drawImage(flat, 0, 0, 64, 64);
                    const d = tc.getImageData(0, 0, 64, 64).data; let r = 0, g = 0, b = 0;
                    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
                    const n = d.length / 4; color = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
                }
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, nw, nh);
            }
            ctx.drawImage(flat, left, top);
            const { ref } = await uploadCanvas(nb, `n${this.node.id}_base`);
            const px = this.pixels.Layer.fromCanvas(nb);   // C6 (d): not the upload decoded again

            // Everything visible was baked into the new base; keep control and reference layers.
            const kept = this.layers.filter((l) => this.isControl(l) || this.isReference(l));
            for (const l of kept) {
                if (l.kind === "paint" && l.px.width === W && l.px.height === H && l.w === W && l.h === H) {
                    // a new object (the canvas undo step holds the old one): the old pixels placed at left, top
                    l.px = l.px.resized(nw, nh, { x: left, y: top });
                    l.x = 0; l.y = 0; l.w = nw; l.h = nh;
                    if (l.maskPx) { l.maskPx = l.maskPx.resized(nw, nh, { x: left, y: top }); l.maskDirty = true; l._maskedValid = false; }
                } else {
                    l.x += left; l.y += top;
                }
                l.dirty = true;
            }
            this.layers = kept;
            this.activeLayerId = null;
            this.refsMutated();
            this.base = { ref, px };
            this.width = nw; this.height = nh;
            // a new object (the canvas undo step holds the old one): the new border selected
            this.sel = this.pixels.Mask.empty(nw, nh);
            this.sel.fill(null, "#ff0000");
            this.sel.clear([left, top, left + W, top + H]);
            pushed = true;
            this.pushUndoSnapshot(before, { tracked: true, label: "Extend canvas" });
            this.uploaded = this.makeUploaded();
            this.selectionDirty = true; this.selectionLoose = false;
            this.selectionDataUrl = null; this.selectionEncoded = false;
            this.followGeometry("extend", xfTranslate(left, top), { width: W, height: H }, { width: nw, height: nh });
            for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.renderHistory();
            this.renderLayers();
            this.renderInfo();
            this.fitView();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus(`Canvas is ${nw} × ${nh}. The new border is selected; press Generate to outpaint it (Ctrl+Z takes the extension back).`);
        } catch (err) {
            if (!pushed) this.releaseSnapshot(before);   // its selection PNG is revoked, not left behind
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }
}
