// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_view.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the view (canvas size, coordinate maps, zoom), layer selection, layer pixels with the stroke, handles and cursors, side panes, rulers, guides and compare: moved out of inpaint_canvas.js (item 56 S10b, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { canvasOf } from "./inpaint_pixels.js";
import { THEME } from "./inpaint_theme.js";
import { CURSOR_CLASSES, HANDLE_PX, RULER_PX, SIDE_DEFAULT_PX, SIDE_MAX_SHARE, SIDE_MIN_PX, makeCanvas } from "./inpaint_consts.js";
import { el, icon, iconButton } from "./inpaint_dom.js";

export class ViewPart {
    // ---- geometry ----------------------------------------------------------

    resizeCanvas() {
        if (!this.isOpen) return;
        const rect = this.viewEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            if (this.width && this._fitted !== false) this.fitView(); else this.draw();
        }
    }

    toCanvasPx(e) {
        const rect = this.canvas.getBoundingClientRect();
        return [
            (e.clientX - rect.left) * (this.canvas.width / rect.width),
            (e.clientY - rect.top) * (this.canvas.height / rect.height),
        ];
    }

    toImage(e) {
        const [cx, cy] = this.toCanvasPx(e);
        return this.canvasToImage(cx, cy);
    }

    /** Device pixel on the canvas -> image coordinate (the view may be rotated). */
    canvasToImage(cx, cy) {
        const a = -(this.view.angle || 0), c = Math.cos(a), s = Math.sin(a);
        const dx = cx - this.view.x, dy = cy - this.view.y;
        return [(dx * c - dy * s) / this.view.scale, (dx * s + dy * c) / this.view.scale];
    }

    /** Image coordinate -> device pixel on the canvas. */
    imageToScreen(ix, iy) {
        const a = this.view.angle || 0, c = Math.cos(a), s = Math.sin(a);
        const x = ix * this.view.scale, y = iy * this.view.scale;
        return [this.view.x + x * c - y * s, this.view.y + x * s + y * c];
    }

    /** Set a context's transform to the view (optionally shifted by device pixels). */
    applyViewTransform(ctx, dx = 0, dy = 0) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(this.view.x + dx, this.view.y + dy);
        if (this.view.angle) ctx.rotate(this.view.angle);
        ctx.scale(this.view.scale, this.view.scale);
    }

    /** The straighten preview's angle in radians: the pending frame's, in the Canvas tool only (null otherwise). */
    viewTilt() {
        if (this.tool !== "canvas") return null;
        const f = this.frame();
        return f && f.angle ? f.angle * Math.PI / 180 : null;
    }

    /** Compose the straighten preview onto a context in image coordinates: the picture turned about its centre. */
    applyTilt(ctx) {
        const t = this.viewTilt();
        if (!t) return;
        ctx.translate(this.width / 2, this.height / 2);
        ctx.rotate(t);
        ctx.translate(-this.width / 2, -this.height / 2);
    }

    /**
     * The Canvas tool's frame, level over the (turned) picture: outside it darkened, a border it adds tinted, the chosen
     * lines inside it, its outline and handles, its size and angle, and the straighten line while it is drawn.
     */
    drawCanvasFrame(ctx) {
        const f = this.frameOrCanvas(), s = this.view.scale, W = this.width, H = this.height;
        ctx.save();
        const corners = [[0, 0], [this.canvas.width, 0], [0, this.canvas.height], [this.canvas.width, this.canvas.height]].map(([x, y]) => this.canvasToImage(x, y));
        const vx0 = Math.min(...corners.map((c) => c[0])), vy0 = Math.min(...corners.map((c) => c[1]));
        const vx1 = Math.max(...corners.map((c) => c[0])), vy1 = Math.max(...corners.map((c) => c[1]));
        if (this.framePending()) {
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.beginPath(); ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0); ctx.rect(f.x, f.y, f.w, f.h); ctx.fill("evenodd");
        }
        if (!f.angle && (f.x < 0 || f.y < 0 || f.x + f.w > W || f.y + f.h > H)) {
            // what an extend adds (the new border the model will fill)
            ctx.save();
            ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
            ctx.fillStyle = "rgba(124,199,255,0.22)";
            ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.rect(0, 0, W, H); ctx.fill("evenodd");
            ctx.restore();
        }
        this.drawFrameOverlay(ctx, f, s);
        ctx.lineWidth = 1 / s;
        ctx.strokeStyle = "#7cc7ff";
        ctx.setLineDash([6 / s, 4 / s]);
        ctx.strokeRect(f.x, f.y, f.w, f.h);
        ctx.setLineDash([]);
        const r = HANDLE_PX / s / 2;
        const handles = this.layerHandles({ x: f.x, y: f.y, w: f.w, h: f.h });
        ctx.fillStyle = "#7cc7ff";
        for (const name of ["nw", "ne", "sw", "se"]) { const [hx, hy] = handles[name]; ctx.fillRect(hx - r, hy - r, r * 2, r * 2); }
        ctx.fillStyle = "#1e1e1e";
        for (const name of ["n", "s", "w", "e"]) { const [hx, hy] = handles[name]; ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        ctx.font = `${12 / s}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = (txt, x, y) => { const w = ctx.measureText(txt).width + 10 / s; ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(x - w / 2, y - 8 / s, w, 16 / s); ctx.fillStyle = "#fff"; ctx.fillText(txt, x, y); };
        if (!f.angle) {
            const v = this.extendValues(), sg = (n) => (n > 0 ? "+" : "") + n;
            if (v.top) label(sg(v.top), W / 2, -v.top / 2);
            if (v.bottom) label(sg(v.bottom), W / 2, H + v.bottom / 2);
            if (v.left) label(sg(v.left), -v.left / 2, H / 2);
            if (v.right) label(sg(v.right), W + v.right / 2, H / 2);
        }
        label(`${f.w} × ${f.h}${f.angle ? `  ${f.angle}°` : ""}`, f.x + f.w / 2, f.y - 14 / s);
        const p = this.pointer;
        if (p && p.kind === "straighten") {
            const [x0, y0] = p.start, [x1, y1] = p.cur;
            ctx.lineWidth = 2 / s;
            ctx.strokeStyle = "rgba(0,0,0,0.6)";
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffd24a";
            ctx.setLineDash([5 / s, 3 / s]);
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            ctx.setLineDash([]);
            const phi = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI, off = phi - 90 * Math.round(phi / 90);
            label(`${Math.round(-off * 10) / 10}°`, x1, y1 - 14 / s);
        }
        ctx.restore();
    }

    /** The lines over the frame to compose by: thirds, the golden section, a grid, or Photoshop's diagonals. */
    drawFrameOverlay(ctx, f, s) {
        const kind = this.frameOverlay || "thirds";
        if (kind === "none") return;
        const lines = [], X = (t) => f.x + f.w * t, Y = (t) => f.y + f.h * t;
        if (kind === "thirds" || kind === "golden") {
            for (const t of kind === "thirds" ? [1 / 3, 2 / 3] : [0.381966, 0.618034]) lines.push([X(t), f.y, X(t), f.y + f.h], [f.x, Y(t), f.x + f.w, Y(t)]);
        } else if (kind === "grid") {
            // a round step of at least 32 px on the screen, from the frame's corner
            const want = 32 * (window.devicePixelRatio || 1) / s, mag = Math.pow(10, Math.floor(Math.log10(want)));
            const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= want);
            for (let x = f.x + step; x < f.x + f.w; x += step) lines.push([x, f.y, x, f.y + f.h]);
            for (let y = f.y + step; y < f.y + f.h; y += step) lines.push([f.x, y, f.x + f.w, y]);
        } else if (kind === "diagonal") {
            const m = Math.min(f.w, f.h);
            lines.push([f.x, f.y, f.x + m, f.y + m], [f.x + f.w, f.y, f.x + f.w - m, f.y + m], [f.x, f.y + f.h, f.x + m, f.y + f.h - m], [f.x + f.w, f.y + f.h, f.x + f.w - m, f.y + f.h - m]);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
        for (const [w, c] of [[3 / s, "rgba(0,0,0,0.4)"], [1 / s, "rgba(255,255,255,0.75)"]]) {
            ctx.lineWidth = w; ctx.strokeStyle = c;
            ctx.beginPath();
            for (const [a, b, c2, d] of lines) { ctx.moveTo(a, b); ctx.lineTo(c2, d); }
            ctx.stroke();
        }
        ctx.restore();
    }

    /** Rotate the view about the middle of the canvas (Krita's 4 / 6 keys). */
    rotateView(delta) {
        if (!this.width) return;
        const qx = this.canvas.width / 2, qy = this.canvas.height / 2;
        const c = Math.cos(delta), s = Math.sin(delta);
        const vx = this.view.x - qx, vy = this.view.y - qy;
        this.view.x = qx + vx * c - vy * s;
        this.view.y = qy + vx * s + vy * c;
        this.view.angle = ((this.view.angle || 0) + delta) % (Math.PI * 2);
        if (Math.abs(this.view.angle) < 1e-9) this.view.angle = 0;
        this._fitted = false;
        this.draw();
        this.setStatus(this.view.angle ? `View rotated ${Math.round(this.view.angle * 180 / Math.PI)}° (5 resets).` : "View rotation reset.");
    }

    /** Zoom to a scale about the middle of the canvas (1 = one image pixel per device pixel). */
    zoomTo(ns) {
        if (!this.width) return;
        const qx = this.canvas.width / 2, qy = this.canvas.height / 2;
        this.view.x = qx - (qx - this.view.x) * (ns / this.view.scale);
        this.view.y = qy - (qy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.draw();
        this.setStatus(`Zoom ${Math.round(ns * 100)} %.`);
    }

    fitView() {
        if (!this.width || !this.canvas.width) return;
        const pad = 24;
        const s = Math.max(0.01, Math.min((this.canvas.width - pad * 2) / this.width, (this.canvas.height - pad * 2) / this.height));
        this.view.scale = s;
        this.view.angle = 0;
        this.view.x = (this.canvas.width - this.width * s) / 2;
        this.view.y = (this.canvas.height - this.height * s) / 2;
        this._fitted = true;
        this.draw();
    }

    onWheel(e) {
        if (!this.width) return;
        if (this.tool === "lights" && this.isRelightActive()) {
            const [ix, iy] = this.toImage(e);
            const layer = this.activeLayer();
            const hit = this.hitLight(layer, ix, iy);
            if (hit && hit.light) {
                if (e.preventDefault) e.preventDefault();
                const l = hit.light;
                layer._deselected = false;
                layer._selectedLightId = l.id;
                const dir = Math.sign(-e.deltaY || 0);
                if (dir !== 0) {
                    // a wheel burst is a step of its own, as a nudge burst is (onKey); one still open ends first
                    if (!layer._wheelPending) {
                        if (typeof layer._flushNudge === "function") layer._flushNudge();
                        layer._wheelPending = this.snapshot({ kind: "filter", id: layer.id });
                        layer._wheelLabel = e.shiftKey ? "Relight: Intensity" : "Relight: Diffusion";
                    }
                    if (e.shiftKey) {
                        l.intensity = Math.max(0, Math.min(300, Math.round((l.intensity || 100) + dir * 5)));
                    } else {
                        l.diffusion = Math.max(0, Math.min(100, Math.round((l.diffusion != null ? l.diffusion : 30) + dir * 2)));
                    }
                    this.filterPreview = layer.id;
                    this.ensureRelightMaps(layer, { quick: true });
                    this.markFilterChanged(layer);
                    this.renderLayers();
                    this.draw();
                    if (layer._wheelRelightTimer) clearTimeout(layer._wheelRelightTimer);
                    const flushWheel = () => {
                        if (layer._wheelRelightTimer) { clearTimeout(layer._wheelRelightTimer); layer._wheelRelightTimer = null; }
                        layer._flushWheel = null;
                        const snap = layer._wheelPending, label = layer._wheelLabel || "Relight: Diffusion";
                        layer._wheelPending = null;
                        layer._wheelLabel = null;
                        if (this.filterPreview === layer.id) this.filterPreview = null;
                        if (!this.layers || !this.layers.includes(layer)) return;   // the layer left the document (an undo replaced it)
                        if (snap) this.pushUndoSnapshot(snap, { label, fromDebounce: true });
                        this.ensureRelightMaps(layer, { quick: false });
                        this.markFilterChanged(layer);
                        this.renderLayersUnlessEditing();
                        this.draw();
                    };
                    layer._flushWheel = flushWheel;
                    layer._wheelRelightTimer = setTimeout(flushWheel, 300);
                    return;
                }
            }
        }
        const [cx, cy] = this.toCanvasPx(e);
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(40, Math.max(0.02, this.view.scale * factor));
        this.view.x = cx - (cx - this.view.x) * (ns / this.view.scale);
        this.view.y = cy - (cy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.drawSoon();
    }

    // ---- layers: lookup ----------------------------------------------------

    activeLayer() {
        return this.layers.find((l) => l.id === this.activeLayerId) || null;
    }

    /**
     * The selected layers in stack order (bottom first): the active one and those Ctrl / Shift + clicked with it. A
     * selection counts only while it holds the active layer, so every path that sets `activeLayerId` to a layer outside
     * it (a new layer, a pick on the canvas, an undo) falls back to that one layer without clearing anything.
     */
    selectedLayers() {
        const active = this.activeLayer();
        if (!active) return [];
        if (this.layerSel.size < 2 || !this.layerSel.has(active.id)) return [active];
        const sel = this.layers.filter((l) => this.layerSel.has(l.id) && !this.isReference(l));
        return sel.length > 1 ? sel : [active];
    }

    multiSelected() { return this.selectedLayers().length > 1; }

    /** Select layers by id (the first given, or `active`, becomes the active one); an empty list selects the base. */
    selectLayers(ids, { active = null } = {}) {
        const known = new Set(this.layers.map((l) => l.id));
        const list = [...new Set(ids)].filter((id) => known.has(id));
        if (this.pending) this.cancelPending();
        this.activeLayerId = active && list.includes(active) ? active : (list[0] || null);
        this.layerSel = new Set(list.length > 1 ? list : []);
        this.layerAnchorId = this.activeLayerId;
        this.renderLayers(); this.updateSubbar(); this.draw();
        return this.selectedLayers();
    }

    /** A click on a layer row: plain selects it alone, Ctrl toggles it in the selection, Shift selects the range from the anchor. */
    clickLayerRow(layer, e) {
        if (this.pending) this.cancelPending();
        this.activeGroupId = null;
        const ctrl = e && (e.ctrlKey || e.metaKey);
        if (e && e.shiftKey && this.layerAnchorId && this.layerAnchorId !== layer.id && !this.isReference(layer)) {
            const rows = this.layers.filter((l) => !this.isReference(l));
            const a = rows.findIndex((l) => l.id === this.layerAnchorId), b = rows.indexOf(layer);
            if (a >= 0 && b >= 0) {
                this.layerSel = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
                this.activeLayerId = layer.id;
                this.renderLayers(); this.updateSubbar(); this.draw();
                return;
            }
        }
        if (ctrl && !this.isReference(layer)) {
            const sel = new Set(this.selectedLayers().map((l) => l.id));
            if (sel.has(layer.id) && sel.size > 1) {
                sel.delete(layer.id);
                if (this.activeLayerId === layer.id) this.activeLayerId = [...sel].pop();
            } else {
                sel.add(layer.id);
                this.activeLayerId = layer.id;
            }
            this.layerSel = sel.size > 1 ? sel : new Set();
            this.layerAnchorId = layer.id;
        } else {
            this.activeLayerId = layer.id;
            this.layerSel = new Set();
            this.layerAnchorId = layer.id;
        }
        this.renderLayers(); this.updateSubbar(); this.draw();
    }

    /**
     * The layers a move or scale takes together, and the box around them: null unless more than one layer is selected.
     * Filter layers (they cover the canvas) and locked ones stay where they are.
     */
    groupBox() {
        if (!this.multiSelected()) return null;
        const layers = this.selectedLayers().filter((l) => l.kind !== "filter" && !this.isLocked(l));
        if (!layers.length) return null;
        const x0 = Math.min(...layers.map((l) => l.x)), y0 = Math.min(...layers.map((l) => l.y));
        const x1 = Math.max(...layers.map((l) => l.x + l.w)), y1 = Math.max(...layers.map((l) => l.y + l.h));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, layers };
    }

    /** Map every layer of a group gesture from the box it started in to the box the gesture has dragged. */
    applyGroupBox(p) {
        const o = p.orig, b = p.layer;
        const sx = b.w / o.w, sy = b.h / o.h;
        for (const g of p.group) {
            const l = g.layer;
            const x0 = b.x + (g.x - o.x) * sx, y0 = b.y + (g.y - o.y) * sy;
            const x1 = b.x + (g.x + g.w - o.x) * sx, y1 = b.y + (g.y + g.h - o.y) * sy;
            l.x = Math.round(x0); l.y = Math.round(y0);
            l.w = Math.max(1, Math.round(x1) - l.x); l.h = Math.max(1, Math.round(y1) - l.y);
        }
    }

    /**
     * The layer's pixels as they are composited: the canvas with the in-progress
     * stroke and, when the layer has a transparency mask, multiplied by it. The
     * masked result is cached until pixels or mask change.
     * `display`: the caller only draws the result right away (the screen, the pyramid, the
     * compositor, thumbnails, a composite being built): an unmasked layer then hands out its
     * display canvas (`canvasOf`, the same canvas every frame, synced from the writes) instead of
     * a `toCanvas()` copy, which on tiles would be a whole-layer copy per frame and a new key for
     * every identity cache. Anything that keeps the canvas (an upload, an encode, a worker job)
     * leaves it false (docs/PLAN_BCE.md §C2 step b).
     */
    layerPixels(layer, display = false) {
        if (!this.liveMask(layer)) return this.layerWithStroke(layer, display);
        const p = this.pointer;
        const live = !!(p && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
        if (!live && layer._masked && layer._maskedValid) return layer._masked;
        const base = this.layerWithStroke(layer, true);   // drawn into the masked cache right here
        // during a mask stroke on this layer the mask's live preview, otherwise the mask's own
        // pixels (drawn through maskPx below); maskWithStroke would hand those back as a canvas
        const mask = p && p.kind === "maskpaint" && p.layer === layer ? this.maskWithStroke(layer) : null;
        const drawMask = (ctx, w, h) => { if (mask) ctx.drawImage(mask, 0, 0, w, h); else layer.maskPx.drawTo(ctx, 0, 0, w, h); };
        let out;
        if (live) {
            // the live copy is rebuilt inside the dab's rectangle only; destination-in would
            // clear everything outside the drawn part, so the box is a clip region
            let fresh = false;
            if (!this.maskedPreview || this.maskedPreview.width !== base.width || this.maskedPreview.height !== base.height) { this.maskedPreview = makeCanvas(base.width, base.height); this.maskedPreview._livePreview = true; fresh = true; }
            if (p.maskedOf !== this.maskedPreview) { p.maskedOf = this.maskedPreview; fresh = true; }
            out = this.maskedPreview;
            const box = fresh ? null : this.takeDirty(p, "dirtyMasked", layer, base);
            if (fresh) p.dirtyMasked = null;
            if (fresh || box) {
                const [x, y, w, h] = box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : [0, 0, out.width, out.height];
                const ctx = out.getContext("2d");
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();
                ctx.globalCompositeOperation = "source-over";
                ctx.globalAlpha = 1;
                ctx.clearRect(x, y, w, h);
                ctx.drawImage(base, x, y, w, h, x, y, w, h);
                ctx.globalCompositeOperation = "destination-in";
                drawMask(ctx, out.width, out.height);
                ctx.restore();
            }
            return out;
        }
        if (!layer._masked || layer._masked.width !== base.width || layer._masked.height !== base.height) layer._masked = makeCanvas(base.width, base.height);
        out = layer._masked;
        const ctx = out.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.drawImage(base, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        drawMask(ctx, out.width, out.height);
        ctx.globalCompositeOperation = "source-over";
        layer._maskedValid = true;
        this.touchSource(out);
        return out;
    }

    /** The layer's mask with the in-progress mask stroke applied (white = visible), as a canvas to draw from; `display` as in layerPixels. */
    maskWithStroke(layer, display = false) {
        const p = this.pointer;
        if (!p || p.kind !== "maskpaint" || p.layer !== layer) return layer.maskPx ? (display ? canvasOf(layer.maskPx) : layer.maskPx.toCanvas()) : null;
        const target = layer.maskPx;
        let fresh = false;
        if (!this.maskPreview || this.maskPreview.width !== target.width || this.maskPreview.height !== target.height) {
            this.maskPreview = makeCanvas(target.width, target.height);
            this.maskPreview._livePreview = true;
            fresh = true;
        }
        if (p.maskPreviewOf !== this.maskPreview) { p.maskPreviewOf = this.maskPreview; fresh = true; }
        const box = fresh ? null : this.takeDirty(p, "dirtyMask", layer, target);
        if (fresh) p.dirtyMask = null;
        if (fresh || box) this.refreshStrokePreview(this.maskPreview, target, p, box, p.erase ? "destination-out" : "source-over");
        return this.maskPreview;
    }

    /** Handles of a layer: corners (nw, ne, sw, se) and edge midpoints (n, e, s, w). */
    layerHandles(l) {
        return {
            nw: [l.x, l.y], ne: [l.x + l.w, l.y], sw: [l.x, l.y + l.h], se: [l.x + l.w, l.y + l.h],
            n: [l.x + l.w / 2, l.y], s: [l.x + l.w / 2, l.y + l.h], w: [l.x, l.y + l.h / 2], e: [l.x + l.w, l.y + l.h / 2],
        };
    }

    /** Which handle of the active layer is under image point (ix, iy)? */
    handleAt(ix, iy) {
        const l = (!this.pending && this.groupBox()) || this.activeLayer();
        if (!l) return null;
        const r = HANDLE_PX / this.view.scale;
        const handles = this.layerHandles(l);
        for (const name of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
            const [cx, cy] = handles[name];
            if (Math.abs(ix - cx) <= r && Math.abs(iy - cy) <= r) return name;
        }
        return null;
    }

    updateTransformCursor(ix, iy) {
        const cls = this.viewEl.classList;
        cls.remove(...CURSOR_CLASSES);
        const l = this.activeLayer();
        if (!l) return;
        let h = null, rot = false;
        if (this.pending) {
            if (this.pending.mode !== "rotate") return;
            const [lx, ly] = this.toLayerLocal(l, this.pending.angle, ix, iy);
            h = this.handleAt(lx, ly);
            rot = !h && (lx < l.x || lx > l.x + l.w || ly < l.y || ly > l.y + l.h);
        } else {
            h = this.handleAt(ix, iy);
            rot = !h && !this.multiSelected() && this.rotateZoneAt(l, ix, iy);   // a group turns one layer at a time: no rotate zone
        }
        this.setHandleCursor(h, rot);
    }

    setHandleCursor(h, rot = false) {
        const cls = this.viewEl.classList;
        cls.remove(...CURSOR_CLASSES);
        if (rot) cls.add("ipc-rotate");
        else if (h === "n" || h === "s") cls.add("ipc-scale-y");
        else if (h === "e" || h === "w") cls.add("ipc-scale-x");
        else if (h === "ne" || h === "sw") cls.add("ipc-scale-ne");
        else if (h) cls.add("ipc-scale");
    }

    updateCanvasCursor(ix, iy) {
        const h = this.canvasHandleAt(ix, iy), f = this.frameOrCanvas();
        const inside = ix >= f.x && ix <= f.x + f.w && iy >= f.y && iy <= f.y + f.h;
        // a handle scales, inside moves, outside turns; the straighten line draws with the tool's own cursor
        const drawLine = this.frameStraighten;
        this.setHandleCursor(drawLine ? null : h, !drawLine && !h && !inside);
        this.viewEl.classList.toggle("ipc-move", !drawLine && !h && inside);
    }

    showPane(id) {
        if (!this.panes || !this.panes[id]) id = "image";
        for (const [k, pane] of Object.entries(this.panes)) pane.hidden = k !== id;
        for (const [k, b] of Object.entries(this.tabButtons)) b.classList.toggle("ipc-active", k === id);
        try { localStorage.setItem("ipc.pane", id); } catch (_) { /* ignore */ }
    }

    // ---- tool groups (flyouts) ----------------------------------------------------------------

    refreshGroupButton(g) {
        if (!g.btn || g.menu) return;
        const it = g.items.find((i) => i.tool === g.current) || g.items[0];
        g.btn.innerHTML = icon(it.tool) + '<span class="ipc-tri"></span>';
        g.btn.title = it.title + "\nHover, right-click or hold for the other tools of this group.";
        g.btn.classList.toggle("ipc-active", this.tool === it.tool);
    }

    openFlyout(g, anchor) {
        if (this.flyout && this.flyout.group === g) { clearTimeout(this._flyClose); return; }
        this.closeFlyout();
        const fly = el("div", "ipc-flyout");
        const add = (iconName, label, key, title, onClick, active, toggled) => {
            const b = iconButton(iconName, title, onClick, label);
            if (key) b.appendChild(el("span", "ipc-key", key));
            if (active) b.classList.add("ipc-active");
            if (toggled) b.classList.add("ipc-toggle-on");
            fly.appendChild(b);
            return b;
        };
        for (const it of g.items) add(it.tool, it.label, it.key, it.title, () => { this.setTool(it.tool); this.closeFlyout(); }, this.tool === it.tool, false);
        if (g.items.length && g.actions.length) fly.appendChild(el("div", "ipc-sep"));
        for (const a of g.actions) {
            if (a.sep) { fly.appendChild(el("div", "ipc-sep")); continue; }
            const b = add(a.icon, a.label, a.key, a.title, () => {
                a.onClick();
                if (a.toggle) b.classList.toggle("ipc-toggle-on", !!a.toggle()); else this.closeFlyout();
            }, false, a.toggle ? !!a.toggle() : false);
            if (a.disabled) b.disabled = true;
        }
        fly.addEventListener("pointerenter", () => clearTimeout(this._flyClose));
        fly.addEventListener("pointerleave", (e) => { if (!(g.btn && g.btn.contains(e.relatedTarget))) this.scheduleFlyoutClose(); });
        for (const type of ["pointerdown", "pointerup", "click", "wheel", "contextmenu"]) fly.addEventListener(type, (e) => e.stopPropagation());
        this.root.appendChild(fly);
        const an = anchor || (g && g.btn);
        const r = an && typeof an.getBoundingClientRect === "function" ? an.getBoundingClientRect() : { right: 0, left: 0, top: 0, bottom: 0, width: 0, height: 0 };
        const rr = this.root.getBoundingClientRect();
        let left = r.right - rr.left + 6;
        // an anchor at the right edge (a row of the side panel): the flyout opens to its left
        if (left + fly.offsetWidth > rr.width - 4) left = Math.max(4, r.left - rr.left - fly.offsetWidth - 6);
        fly.style.left = `${left}px`;
        const top = Math.min(r.top - rr.top, rr.height - fly.offsetHeight - 8);
        fly.style.top = `${Math.max(4, top)}px`;
        this.flyout = { el: fly, group: g };
        if (!this._flyDocDown) {
            this._flyDocDown = (e) => {
                const t = e.target instanceof Node ? e.target : null;
                if (this.flyout && (!t || (!this.flyout.el.contains(t) && !(this.flyout.group && this.flyout.group.btn && this.flyout.group.btn.contains(t))))) this.closeFlyout();
            };
            window.addEventListener("pointerdown", this._flyDocDown, true);
        }
    }

    scheduleFlyoutClose() {
        clearTimeout(this._flyClose);
        this._flyClose = setTimeout(() => this.closeFlyout(), 160);
    }

    /**
     * The window's capturing pointerdown listener the first flyout adds (openFlyout, openChoiceList: a press outside
     * closes the flyout). It closes over the editor, so one left on the window kept a closed tab's editor with all its
     * pixels for the rest of the session; close() and destroy() take it off, and the next flyout adds it again.
     */
    dropFlyoutListener() {
        if (this._flyDocDown) window.removeEventListener("pointerdown", this._flyDocDown, true);
        this._flyDocDown = null;
    }

    /** An open question (ask) answered with null, as Cancel does: its capturing keydown listener on the window goes. */
    closeAsk() {
        const finish = this._askFinish;
        this._askFinish = null;
        if (typeof finish === "function") finish(null);
    }

    closeFlyout() {
        clearTimeout(this._flyClose);
        if (!this.flyout) return;
        const cur = this.flyout;
        this.flyout = null;
        if (typeof cur.onClose === "function") {
            try { cur.onClose(); } catch (e) { console.error("flyout onClose failed", e); }
        }
        cur.el.remove();
    }

    // ---- view: rulers, grid, guides, before/after, compare, on-canvas text ----------------------

    /**
     * The side panel's width in CSS pixels (item 17), clamped to 310 px .. 60 % of the editor's body; null = the
     * default. A variable on the document, so every tab (and the node's editor) shows the same width; `save` keeps it
     * in localStorage like the rulers. The picture is refitted (resizeCanvas) if it was fitted. Returns the width set.
     */
    setSideWidth(w, { save = true } = {}) {
        const body = this.sidePanel && this.sidePanel.parentElement;
        // a hidden or closed tab's body has no box: the window stands in for it
        const room = (body && body.getBoundingClientRect().width) || window.innerWidth;
        const max = Math.max(SIDE_MIN_PX, Math.floor(room * SIDE_MAX_SHARE));
        const px = w == null || !Number.isFinite(+w) ? SIDE_DEFAULT_PX : Math.round(Math.min(max, Math.max(SIDE_MIN_PX, +w)));
        document.documentElement.style.setProperty("--ipc-side-w", px + "px");
        this.resizeCanvas();   // at once: the ResizeObserver waits for a rendering step, which a hidden window does not take
        if (save) {
            try {
                if (px === SIDE_DEFAULT_PX) localStorage.removeItem("ipc.sideWidth"); else localStorage.setItem("ipc.sideWidth", String(px));
            } catch (_) { /* no storage */ }
        }
        return px;
    }

    /** The width kept by setSideWidth, put back on the document (not clamped to this window: the panel's max-width does that). */
    applyStoredSideWidth() {
        let w = 0;
        try { w = Math.round(+localStorage.getItem("ipc.sideWidth") || 0); } catch (_) { /* no storage */ }
        document.documentElement.style.setProperty("--ipc-side-w", (w >= SIDE_MIN_PX ? w : SIDE_DEFAULT_PX) + "px");
    }

    toggleRulers() {
        this.showRulers = !this.showRulers;
        try { localStorage.setItem("ipc.rulers", this.showRulers ? "1" : "0"); } catch (_) { /* ignore */ }
        if (this.rulersBtn) this.rulersBtn.classList.toggle("ipc-toggle-on", this.showRulers);
        this.draw();
        this.setStatus(this.showRulers ? "Rulers on. Drag guides out of them." : "Rulers off.");
    }

    toggleGrid() {
        this.showGrid = !this.showGrid;
        try { localStorage.setItem("ipc.grid", this.showGrid ? "1" : "0"); } catch (_) { /* ignore */ }
        if (this.gridBtn) this.gridBtn.classList.toggle("ipc-toggle-on", this.showGrid);
        this.draw();
    }

    /** Guide near a device pixel (within 5 css px), or null. */
    guideAt(cx, cy) {
        const th = 5 * (window.devicePixelRatio || 1);
        const g = this.guides || { x: [], y: [] };
        for (let i = 0; i < g.x.length; i++) { const [sx] = this.imageToScreen(g.x[i], 0); if (Math.abs(sx - cx) <= th && !this.view.angle) return { axis: "x", index: i }; }
        for (let i = 0; i < g.y.length; i++) { const [, sy] = this.imageToScreen(0, g.y[i]); if (Math.abs(sy - cy) <= th && !this.view.angle) return { axis: "y", index: i }; }
        return null;
    }

    /** Everything drawn on top of the scene: grid, guides, compare divider, rulers, the text editor's position. */
    drawOverlays() {
        if (!this.isOpen || !this.base) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        const dpr = window.devicePixelRatio || 1;
        const s = this.view.scale;
        this.applyViewTransform(ctx);
        if (this.showGrid) {
            let step = Math.max(1, this.gridSize || 64);
            while (step * s < 8 * dpr) step *= 2;
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.22)";
            ctx.lineWidth = 1 / s;
            ctx.beginPath();
            for (let x = 0; x <= this.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, this.height); }
            for (let y = 0; y <= this.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(this.width, y); }
            ctx.stroke();
            ctx.restore();
        }
        const g = this.guides || { x: [], y: [] };
        const p = this.pointer;
        if (g.x.length || g.y.length || (p && p.kind === "guide" && p.pos != null)) {
            ctx.save();
            ctx.strokeStyle = "#7cc7ff";
            ctx.lineWidth = 1 / s;
            ctx.beginPath();
            for (const gx of g.x) { ctx.moveTo(gx, -1e5); ctx.lineTo(gx, 1e5); }
            for (const gy of g.y) { ctx.moveTo(-1e5, gy); ctx.lineTo(1e5, gy); }
            ctx.stroke();
            if (p && p.kind === "guide" && p.pos != null && p.index < 0) {
                ctx.setLineDash([6 / s, 4 / s]);
                ctx.beginPath();
                if (p.axis === "x") { ctx.moveTo(p.pos, -1e5); ctx.lineTo(p.pos, 1e5); } else { ctx.moveTo(-1e5, p.pos); ctx.lineTo(1e5, p.pos); }
                ctx.stroke();
            }
            ctx.restore();
        }
        // a plugin draws on the picture: under the straighten preview it turns with it
        if (this.viewTilt()) {
            ctx.save();
            this.applyTilt(ctx);
            host.pluginOverlay(this, ctx);
            if (this.boxes) this.boxes.draw(ctx);
            if (this.tool === "lights" && this.isRelightActive()) this.drawLightsOverlay(ctx);
            ctx.restore();
        } else {
            host.pluginOverlay(this, ctx);
            if (this.boxes) this.boxes.draw(ctx);
            if (this.tool === "lights" && this.isRelightActive()) this.drawLightsOverlay(ctx);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (this.compare && this.compare.a && this.compare.b) {
            const split = Math.min(0.95, Math.max(0.05, this.compare.split ?? 0.5));
            const x = W * split;
            ctx.save();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
            ctx.font = `${12 * dpr}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            const name = (id) => { const l = this.layers.find((q) => q.id === id); return l ? l.name : "?"; };
            const label = (txt, lx, align) => { ctx.textAlign = align; const w = ctx.measureText(txt).width + 12 * dpr; ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(align === "right" ? lx - w : lx, 8 * dpr, w, 18 * dpr); ctx.fillStyle = "#fff"; ctx.fillText(txt, align === "right" ? lx - 6 * dpr : lx + 6 * dpr, 11 * dpr); };
            label("A · " + name(this.compare.a), x - 8 * dpr, "right");
            label("B · " + name(this.compare.b), x + 8 * dpr, "left");
            ctx.restore();
        }
        if (this.showRulers) this.drawRulers(ctx, W, H, dpr);
        if (this.textEdit) this.positionTextEdit();
    }

    drawRulers(ctx, W, H, dpr) {
        const rp = RULER_PX * dpr;
        ctx.save();
        ctx.fillStyle = THEME.rulerBg;
        ctx.fillRect(0, 0, W, rp);
        ctx.fillRect(0, 0, rp, H);
        ctx.strokeStyle = THEME.rulerEdge;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, rp + 0.5); ctx.lineTo(W, rp + 0.5); ctx.moveTo(rp + 0.5, 0); ctx.lineTo(rp + 0.5, H); ctx.stroke();
        if (!this.view.angle) {
            const s = this.view.scale;
            const cands = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
            const step = cands.find((c) => c * s >= 48 * dpr) || 10000;
            const minor = step / 5;
            ctx.fillStyle = THEME.rulerText;
            ctx.strokeStyle = THEME.rulerTick;
            ctx.font = `${9 * dpr}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            ctx.textAlign = "left";
            const [ix0] = this.canvasToImage(rp, rp), [ix1] = this.canvasToImage(W, rp);
            const [, iy0] = this.canvasToImage(rp, rp), [, iy1] = this.canvasToImage(rp, H);
            ctx.beginPath();
            for (let v = Math.floor(ix0 / minor) * minor; v <= ix1; v += minor) {
                const [sx] = this.imageToScreen(v, 0);
                if (sx < rp) continue;
                const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
                ctx.moveTo(Math.round(sx) + 0.5, rp); ctx.lineTo(Math.round(sx) + 0.5, major ? rp * 0.35 : rp * 0.7);
                if (major) ctx.fillText(String(Math.round(v)), sx + 2 * dpr, 1 * dpr);
            }
            for (let v = Math.floor(iy0 / minor) * minor; v <= iy1; v += minor) {
                const [, sy] = this.imageToScreen(0, v);
                if (sy < rp) continue;
                const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
                ctx.moveTo(rp, Math.round(sy) + 0.5); ctx.lineTo(major ? rp * 0.35 : rp * 0.7, Math.round(sy) + 0.5);
                if (major) { ctx.save(); ctx.translate(2 * dpr, sy + 2 * dpr); ctx.rotate(Math.PI / 2); ctx.fillText(String(Math.round(v)), 0, -9 * dpr); ctx.restore(); }
            }
            ctx.stroke();
        }
        ctx.fillStyle = THEME.rulerBg;
        ctx.fillRect(0, 0, rp, rp);
        ctx.restore();
    }

    setCompare(side, h) {
        if (!this.compare) this.compare = { a: null, b: null, split: 0.5 };
        this.compare[side] = h.layerId;
        if (!this.compare.a || !this.compare.b) {
            const others = this.layers.filter((l) => l.kind === "result" && l.id !== h.layerId);
            const other = others[others.length - 1];
            if (other) this.compare[side === "a" ? "b" : "a"] = other.id;
        }
        if (this.compareBtn) this.compareBtn.classList.toggle("ipc-on", !!(this.compare.a && this.compare.b));
        this.draw();
        this.setStatus(this.compare.a && this.compare.b ? "Comparing A (left) and B (right). Drag the divider; Esc ends it." : `${side.toUpperCase()} set; choose the other result too.`);
    }

    toggleCompare() {
        if (this.compare) {
            this.compare = null;
            if (this.compareBtn) this.compareBtn.classList.remove("ipc-on");
            this.draw();
            this.setStatus("Compare ended.");
            return;
        }
        const res = this.layers.filter((l) => l.kind === "result");
        if (res.length < 2) { this.setStatus("Compare needs two result layers."); return; }
        this.compare = { a: res[res.length - 2].id, b: res[res.length - 1].id, split: 0.5 };
        if (this.compareBtn) this.compareBtn.classList.add("ipc-on");
        this.draw();
        this.setStatus(`Comparing A (${res[res.length - 2].name}, left) and B (${res[res.length - 1].name}, right). Drag the divider; Ctrl / Shift+click a history thumbnail changes A / B; Esc ends it.`, "info");
    }
}
