// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_shape.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the gradient and shape tools, the eyedropper and the bucket fill: moved out of inpaint_canvas.js (item 56 S4, docs/PLAN_SPLIT.md), text unchanged.

import { OPS } from "./px/kernels.js";
import { rgbToHex } from "./inpaint_raster.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { failKind } from "./inpaint_status.js";
import { makeCanvas } from "./inpaint_consts.js";
import { StrokeBuffer } from "./inpaint_strokebuf.js";

let InpaintEditor = null;

export class ShapePart {
    /** Gradient tool: rebuild the stroke buffer as a gradient from the drag start to (ix, iy). */
    gradientDab(p, ix, iy) {
        const layer = p.layer, c = p.stroke;
        const sx = c.tw / layer.w, sy = c.th / layer.h;
        const x0 = (p.start[0] - layer.x) * sx, y0 = (p.start[1] - layer.y) * sy;
        const x1 = (ix - layer.x) * sx, y1 = (iy - layer.y) * sy;
        this.strokeDirty(p, layer.x, layer.y, layer.x + layer.w, layer.y + layer.h, 0);
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const o = this.gradientOpts || { type: "linear", to: "transparent" };
        // no bounds: a gradient covers the whole layer, and it is redrawn from nothing on every move
        c.all((ctx) => {
            ctx.globalCompositeOperation = "copy";
            ctx.fillStyle = "rgba(0,0,0,0)";
            ctx.fillRect(0, 0, c.tw, c.th);
            ctx.globalCompositeOperation = "source-over";
            if (dist < 0.5) return;
            const g = o.type === "radial" ? ctx.createRadialGradient(x0, y0, 0, x0, y0, dist) : ctx.createLinearGradient(x0, y0, x1, y1);
            const rgb = this.color.length === 7 ? `${parseInt(this.color.slice(1, 3), 16)},${parseInt(this.color.slice(3, 5), 16)},${parseInt(this.color.slice(5, 7), 16)}` : "0,0,0";
            g.addColorStop(0, `rgba(${rgb},1)`);
            g.addColorStop(1, o.to === "white" ? "rgba(255,255,255,1)" : o.to === "black" ? "rgba(0,0,0,1)" : `rgba(${rgb},0)`);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, c.tw, c.th);
        });
    }

    // ---- shape tool ---------------------------------------------------------------------
    //
    // Rectangle, ellipse and freehand are one drag: the gesture is an ordinary `layerpaint`
    // pointer whose stroke buffer is redrawn on every move, so the live preview, the clip to
    // the selection, the brush opacity and the undo step all come from the paint machinery.
    // Polygon, polyline and Bezier are clicked point by point instead, held in `shapePoints`
    // and drawn as an overlay until Enter, a double click or the first point finishes them.

    /** The layer a shape goes on: the active one, or a new paint layer over the base. */
    shapeTarget() {
        let layer = this.activeLayer();
        if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return null; }
        if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Select a paint or image layer."); return null; }
        if (layer && layer.kind === "text") { this.setStatus("Text layers hold text, not pixels. Select a paint or image layer."); return null; }
        if (!layer) layer = this.addPaintLayer();
        return layer;
    }

    shapePointerDown(ix, iy, e, isDouble) {
        const kind = this.shapeOpts.kind;
        if (kind === "rectangle" || kind === "ellipse" || kind === "freehand") {
            const layer = this.shapeTarget();
            if (!layer) return;
            const stroke = new StrokeBuffer(layer.px, this.pixels);
            this.pointer = { kind: "layerpaint", shape: kind, layer, stroke, clip: this.strokeClip(layer, layer.px),
                erase: false, start: [ix, iy], cur: [ix, iy], path: [[ix, iy]], last: [ix, iy] };
            return;
        }
        // clicked point by point
        if (!this.shapePoints) {
            if (!this.shapeTarget()) return;      // says why, and makes the paint layer early
            this.shapePoints = [{ x: ix, y: iy, hx: 0, hy: 0 }];
        } else {
            const first = this.shapePoints[0];
            const near = Math.hypot(ix - first.x, iy - first.y) <= 8 / this.view.scale;
            if ((near && this.shapePoints.length >= 2) || e.detail >= 2 || isDouble) { this.finishShape(near && this.shapePoints.length >= 2); return; }
            this.shapePoints.push({ x: ix, y: iy, hx: 0, hy: 0 });
        }
        // a Bezier point takes its handle from the drag that follows the click
        if (this.shapeOpts.kind === "bezier") this.shapeDrag = { index: this.shapePoints.length - 1 };
        this.pointer = { kind: "shapepoint" };
        this.draw();
    }

    /** Redraw the dragged shape into its stroke buffer (called on every pointer move). */
    shapeDab(p, ix, iy, e) {
        const o = this.shapeOpts;
        if (p.shape === "freehand") {
            const [lx, ly] = p.path[p.path.length - 1];
            if (Math.hypot(ix - lx, iy - ly) >= 1) p.path.push([ix, iy]);
        } else if (e && (e.shiftKey || e.ctrlKey)) {
            const dx = ix - p.start[0], dy = iy - p.start[1], m = Math.max(Math.abs(dx), Math.abs(dy));
            p.cur = [p.start[0] + Math.sign(dx || 1) * m, p.start[1] + Math.sign(dy || 1) * m];
        } else {
            p.cur = [ix, iy];
        }
        p.fromCenter = !!(e && e.altKey);
        // the shape's box, outline included (image coordinates): the buffer covers it, the
        // preview refreshes it together with the box before (the shape moves), and the undo
        // step copies the final one
        const box = this.shapeBox(p);
        const prev = p.shapeBox;
        p.shapeBox = box;
        p.bounds = null;
        this.strokeBounds(p, box[0], box[1], box[2], box[3], 0);
        const dirty = prev ? [Math.min(prev[0], box[0]), Math.min(prev[1], box[1]), Math.max(prev[2], box[2]), Math.max(prev[3], box[3])] : box;
        this.strokeDirty(p, dirty[0], dirty[1], dirty[2], dirty[3], 0);
        const sb = p.stroke, layer = p.layer;
        const sx = sb.tw / layer.w, sy = sb.th / layer.h;
        // the shape is redrawn from nothing on every move, so the rectangle it is drawn in has to
        // hold the box it had before as well: what it leaves there has to be cleared
        sb.draw((dirty[0] - layer.x) * sx, (dirty[1] - layer.y) * sy, (dirty[2] - layer.x) * sx, (dirty[3] - layer.y) * sy, (ctx) => {
            ctx.globalCompositeOperation = "copy";
            ctx.fillStyle = "rgba(0,0,0,0)";
            ctx.fillRect(sb.x, sb.y, sb.w, sb.h);
            ctx.globalCompositeOperation = "source-over";
            this.paintShape(ctx, layer, (c) => this.shapePath(c, p), p.shape !== "freehand" || o.fill);
        });
    }

    /** The box a dragged shape covers, outline included (image coordinates). */
    shapeBox(p) {
        const pad = (this.shapeOpts.width || 0) / 2 + 2;
        let x0, y0, x1, y1;
        if (p.shape === "freehand") {
            x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
            for (const [px, py] of p.path) { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
        } else {
            let ax = p.start[0], ay = p.start[1];
            const bx = p.cur[0], by = p.cur[1];
            if (p.fromCenter) { ax = p.start[0] - (bx - p.start[0]); ay = p.start[1] - (by - p.start[1]); }
            x0 = Math.min(ax, bx); y0 = Math.min(ay, by); x1 = Math.max(ax, bx); y1 = Math.max(ay, by);
        }
        return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }

    /** The path of a dragged shape, in image coordinates. */
    shapePath(ctx, p) {
        const o = this.shapeOpts;
        if (p.shape === "freehand") {
            const pts = p.path;
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            return;
        }
        let x0 = p.start[0], y0 = p.start[1], x1 = p.cur[0], y1 = p.cur[1];
        if (p.fromCenter) { x0 = p.start[0] - (x1 - p.start[0]); y0 = p.start[1] - (y1 - p.start[1]); }
        const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        if (p.shape === "ellipse") {
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else if (o.radius > 0) {
            const r = Math.min(o.radius, w / 2, h / 2);
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
        } else {
            ctx.rect(x, y, w, h);
        }
    }

    /** The path of the clicked points, straight for polygon / polyline, curved for Bezier. */
    shapePointPath(ctx, pts, closed, toCursor) {
        const bez = this.shapeOpts.kind === "bezier";
        const all = toCursor ? [...pts, { x: toCursor[0], y: toCursor[1], hx: 0, hy: 0 }] : pts;
        ctx.moveTo(all[0].x, all[0].y);
        for (let i = 1; i < all.length; i++) {
            const a = all[i - 1], b = all[i];
            if (bez && (a.hx || a.hy || b.hx || b.hy)) ctx.bezierCurveTo(a.x + a.hx, a.y + a.hy, b.x - b.hx, b.y - b.hy, b.x, b.y);
            else ctx.lineTo(b.x, b.y);
        }
        if (closed && all.length > 2) {
            const a = all[all.length - 1], b = all[0];
            if (bez && (a.hx || a.hy || b.hx || b.hy)) ctx.bezierCurveTo(a.x + a.hx, a.y + a.hy, b.x - b.hx, b.y - b.hy, b.x, b.y);
            else ctx.closePath();
        }
    }

    /**
     * Fill and outline a path on a stroke buffer sized like the layer. `build` draws the path
     * in image coordinates; the transform maps them onto the layer, so the outline width is in
     * image pixels whatever the layer's own resolution is.
     *
     * It sets an absolute transform, with the buffer's origin passed in, and that is not rule 12's
     * case (docs/PLAN_BCE.md §C1): `ctx` is always a StrokeBuffer's context from `ensure()`, never
     * one a drawInto hands out. Composing on `ensure()`'s translation instead is not the same
     * matrix: the context keeps it in float32, and the composed translation differed in 774 of
     * 1,392 measured layer / buffer combinations up to 15k (by up to 0.004 px). When C5 moves
     * stroke buffers into drawInto, this composes, and that difference is C5's to measure.
     */
    paintShape(ctx, layer, build, closed) {
        const o = this.shapeOpts;
        const sx = layer.px.width / layer.w, sy = layer.px.height / layer.h;
        ctx.save();
        // image coordinates to the layer's own pixels, composed on the transform the context
        // carries (the stroke buffer's, docs/PLAN_BCE.md §C1 rule 12), never set over it
        ctx.transform(sx, 0, 0, sy, -layer.x * sx, -layer.y * sy);
        ctx.beginPath();
        build(ctx);
        if (closed) {
            ctx.closePath();
            if (o.fill) { ctx.fillStyle = this.color; ctx.fill(); }
            if (o.stroke) { ctx.strokeStyle = o.color; ctx.lineWidth = o.width; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(); }
        } else {
            ctx.strokeStyle = o.stroke ? o.color : this.color;
            ctx.lineWidth = o.width; ctx.lineJoin = "round"; ctx.lineCap = "round";
            ctx.stroke();
        }
        ctx.restore();
    }

    /** Draw the clicked shape onto the layer and end the gesture. */
    finishShape(close) {
        const pts = this.shapePoints;
        this.shapePoints = null;
        this.shapeDrag = null;
        const kind = this.shapeOpts.kind;
        const closed = kind !== "polyline" && (close !== false);
        if (!pts || pts.length < (closed ? 3 : 2)) { this.setStatus(`A ${kind} needs at least ${closed ? "three" : "two"} points.`); this.draw(); return; }
        const layer = this.shapeTarget();
        if (!layer) { this.draw(); return; }
        if (closed && !this.shapeOpts.fill && !this.shapeOpts.stroke) { this.setStatus("Neither fill nor outline is on: nothing to draw."); this.draw(); return; }
        const stroke = new StrokeBuffer(layer.px, this.pixels);
        // the box of the points and their handles, outline included: the buffer and the undo
        // step cover that, not the layer
        const pad = (this.shapeOpts.width || 0) / 2 + 2;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const q of pts) {
            for (const [x, y] of [[q.x, q.y], [q.x + (q.hx || 0), q.y + (q.hy || 0)], [q.x - (q.hx || 0), q.y - (q.hy || 0)]]) {
                if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
            }
        }
        const box = [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad];
        const sx = layer.px.width / layer.w, sy = layer.px.height / layer.h;
        stroke.draw((box[0] - layer.x) * sx, (box[1] - layer.y) * sy, (box[2] - layer.x) * sx, (box[3] - layer.y) * sy,
            (ctx) => this.paintShape(ctx, layer, (c) => this.shapePointPath(c, pts, closed, null), closed));
        const p = { kind: "layerpaint", layer, stroke, clip: this.strokeClip(layer, layer.px), erase: false };
        this.strokeBounds(p, box[0], box[1], box[2], box[3], 0);
        const rect = this.strokeRect(p, layer.px);
        const ok = this.commitStroke(p) !== false;   // false: out of memory for pixels, which the status line says
        this.markLayerChanged(layer, rect);
        this.releaseStrokeScratch();
        this.draw();
        if (ok) this.setStatus(`${kind[0].toUpperCase() + kind.slice(1)} with ${pts.length} points drawn on ${layer.name}.`);
    }

    cancelShape() {
        this.shapePoints = null;
        this.shapeDrag = null;
    }

    /** Image-sized canvas the bucket and eyedropper look at: the visible image or the active layer alone. */
    sampleCanvas(source = "image") {
        if (source === "layer") {
            const l = this.activeLayer();
            if (!l || l.kind === "filter") return this.compositeCanvas();
            const key = "layer:" + l.id;
            const c = this.flatCache;
            if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
            const canvas = makeCanvas(this.width, this.height);
            canvas.getContext("2d").drawImage(this.layerPixels(l, true), l.x, l.y, l.w, l.h);   // drawn right away, nothing kept
            this.flatCache = { version: this.compositeVersion, key, canvas };
            return canvas;
        }
        return this.compositeCanvas();
    }

    /**
     * Eyedropper (the tool's click and Alt+click with the paint brush): the colour under (ix, iy) becomes the paint colour,
     * from what the tool bar's Sample says (the visible image or the active layer alone). Its Size (item 58) takes the one
     * pixel there or the mean of the 3 x 3 / 5 x 5 box around it: at the picture's edge only the pixels inside count, and
     * each counts by its alpha (sum(c * a) / sum(a), the mean of the premultiplied colours un-premultiplied), so a
     * transparent pixel adds nothing and a half-transparent one half; the box is "transparent" only when all of it is.
     * Point is the same rule on one pixel, the colour as it was before the Size row.
     */
    pickColor(ix, iy) {
        if (!this.width) return;
        const x = Math.max(0, Math.min(this.width - 1, Math.floor(ix))), y = Math.max(0, Math.min(this.height - 1, Math.floor(iy)));
        const r = this.eyedropperSize === 3 ? 1 : this.eyedropperSize === 5 ? 2 : 0;
        const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(this.width, x + r + 1), y1 = Math.min(this.height, y + r + 1);
        // the box composited, not the whole image (0.6 s on a 15k document)
        const d = this.sampleRegion(this.fillOpts && this.fillOpts.sample, [x0, y0, x1, y1], 1).getContext("2d").getImageData(0, 0, x1 - x0, y1 - y0).data;
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; sr += d[i] * a; sg += d[i + 1] * a; sb += d[i + 2] * a; sa += a; }
        if (sa === 0) { this.setStatus("Transparent here, nothing to pick."); return; }
        const hex = rgbToHex(Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa));
        this.color = hex;
        if (this.colorInput) this.colorInput.value = hex;
        const n = (x1 - x0) * (y1 - y0);
        this.setStatus(n > 1 ? `Colour ${hex} picked, the mean of ${n} pixels.` : `Colour ${hex} picked.`);
    }

    /** Bucket: fill the area of similar colour under (ix, iy) on the active layer, within the selection. */
    async bucketFill(ix, iy) {
        if (!this.width) return;
        let layer = this.activeLayer();
        if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
        if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Select a paint or image layer."); return; }
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const o = this.fillOpts || { tolerance: 32, contiguous: true, sample: "image" };
        const t0 = performance.now();
        const color = this.color, opacity = this.brushOpacity, alphaLocked = !!(layer && layer.alphaLock);
        const tiles = this.tileMode && InpaintEditor.bucketTiles !== false && !(alphaLocked && opacity >= 1)
            && (!layer || (isTilePixels(layer.px) && typeof layer.px.compositeFill === "function" && layer.px.width === layer.w && layer.px.height === layer.h && layer.x === Math.round(layer.x) && layer.y === Math.round(layer.y)));
        const r = await this.floodRegion(x, y, { tolerance: o.tolerance, contiguous: o.contiguous, sample: o.sample, color, clip: true, tiles });
        const fill = r.shape, n = r.count;
        if (!n) { if (r.close) fill.close(); this.setStatus("Nothing to fill here (outside the selection?)."); return; }
        if (!layer) layer = this.addPaintLayer();
        // the undo step is a copy of the box the fill can touch, in the layer's own pixels
        const target = layer.px;
        if (r.tiles && (!isTilePixels(target) || typeof target.compositeFill !== "function" || target.width !== layer.w || target.height !== layer.h || layer.x !== Math.round(layer.x) || layer.y !== Math.round(layer.y))) {
            if (r.close) fill.close();
            this.setStatus("The layer changed while filling; nothing was filled.");
            return;
        }
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const [rx, ry, rw, rh] = r.tiles && r.bounds ? [r.bounds[0], r.bounds[1], r.bounds[2] - r.bounds[0], r.bounds[3] - r.bounds[1]] : [r.x, r.y, r.w, r.h];
        const lx = (rx - layer.x) * sx, ly = (ry - layer.y) * sy, lw = rw * sx, lh = rh * sy;
        this.pushUndoSnapshot(this.snapshotRect(layer, { x: lx, y: ly, w: lw, h: lh }), { label: "Bucket fill" });
        // the fill is r.w x r.h at (r.x, r.y), scaled into the layer's pixels: it covers the box, nothing outside
        const box = [Math.floor(lx), Math.floor(ly), Math.ceil(lx + lw), Math.ceil(ly + lh)];
        const op = layer.alphaLock ? "source-atop" : "source-over";
        let memErr = null;
        if (r.tiles) {
            try {
                target.compositeFill(r.tiles, color, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), [r.x - layer.x, r.y - layer.y]);
            } catch (err) {
                if (!err || err.name !== "PixelMemoryError") throw err;
                memErr = err;
            }
        } else {
            target.drawInto(box, (ctx) => {
                ctx.globalAlpha = opacity;
                ctx.globalCompositeOperation = op;
                ctx.scale(sx, sy);   // composed on drawInto's transform, never set over it (PLAN_BCE §C1 rule 12)
                ctx.drawImage(fill, r.x - layer.x, r.y - layer.y);
            });
        }
        if (r.close) fill.close();
        this.markLayerChanged(layer, box);
        this.draw();
        if (memErr) this.setStatus(memErr.message, failKind(memErr));
        else this.setStatus(`Filled ${n.toLocaleString()} px on ${layer.name} (${Math.round(performance.now() - t0)} ms).`);
    }
}

export function bindShape(C) { InpaintEditor = C; }
