// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_display.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the display source, the pyramid and the GL compositor: moved out of inpaint_canvas.js (item 56 S10, docs/PLAN_SPLIT.md), text unchanged.

import { GLCompositor } from "./inpaint_compositor.js";
import { LayerPixels, canvasOf, displayCanvasIfMade, pixelsOptions } from "./inpaint_pixels.js";
import { MIP_LEVELS, isTilePixels } from "./inpaint_tiles.js";
import { uploadPixels } from "./inpaint_upload.js";
import { BLEND_OPS } from "./blend_modes.js";
import { PYRAMID_LEVELS, PYRAMID_MIN_PX, makeCanvas } from "./inpaint_consts.js";

let InpaintEditor = null;

export class DisplayPart {
    // ---- compositing -------------------------------------------------------

    // ---- display pyramid and viewport composite (docs/PERFORMANCE.md phase 1) ----

    /**
     * Mark a source (LayerPixels / MaskPixels, or a canvas of the editor's own caches) as
     * changed: its cached display levels are dropped and the composited scene is rebuilt on
     * the next draw. Call this wherever pixels of the base, a layer, a mask or the selection
     * are written: a write does not bump the version by itself.
     */
    touchSource(src) {
        this.pixelVersion++;
        if (src instanceof LayerPixels) { this.checkBackend(src); src.touch(); }
        else if (src) src._dispVer = (src._dispVer || 0) + 1;
    }

    /**
     * Pixels the editor was told changed must be of its own backend. Every write reaches the display
     * through touchSource / touchSourceRect, so a site that made pixels with the other backend's classes
     * (a flip, an undo restore) is found here, not only pixels handed to addLayer (C2 step b's review):
     * strict mode (dev builds, the gates) throws, otherwise a warning once.
     */
    checkBackend(p) {
        if (p.constructor.backend === this.pixels) return;
        const msg = `Inpaint Canvas: an editor on ${this.tileMode ? "tiles" : "canvases"} holds pixels of the ${this.tileMode ? "canvas" : "tile"} backend; make them with editor.pixels`;
        if (pixelsOptions().strict) throw new Error(msg);
        if (!InpaintEditor._mixWarned) { InpaintEditor._mixWarned = true; console.warn(msg); }
    }

    /**
     * Pixels of `src` changed inside a rectangle (source pixels): refresh the cached levels
     * there instead of dropping them. A brush dab would otherwise cost a full rebuild of
     * the pyramid, which is 200 ms on a 96 MP source.
     */
    touchSourceRect(pixels, x0, y0, x1, y1) {
        this.pixelVersion++;
        if (!pixels) return;
        if (pixels instanceof LayerPixels) this.checkBackend(pixels);
        // The display levels are keyed on the display canvas (C3 replaces both). Pixels without one
        // (tiles nothing has drawn yet, or whose mirror was released) have no levels to keep either:
        // touched only, so a write into a hidden layer or a tab in the background does not make a
        // mirror as large as the pixels just to find nothing to refresh (C2 step b's review).
        const src = displayCanvasIfMade(pixels);
        if (!src) { pixels.touch([x0, y0, x1, y1]); return; }
        // The GPU compositor keeps one texture per source and version, so pixels that changed
        // have to raise the version even when the cached levels are kept: without this a brush
        // stroke or an erase sits in the canvas and never reaches the screen.
        const entry = this.pyramids.get(src);
        const keep = !!(entry && entry.version === (src._dispVer || 0));
        if (pixels instanceof LayerPixels) pixels.touch([x0, y0, x1, y1]);
        else src._dispVer = (src._dispVer || 0) + 1;
        if (!keep) return;
        entry.version = src._dispVer;   // the levels are refreshed below, so they stay valid
        if (!entry.levels.length && !entry.gpu) return;
        const rx0 = Math.max(0, Math.floor(x0) - 1), ry0 = Math.max(0, Math.floor(y0) - 1);
        const rx1 = Math.min(src.width, Math.ceil(x1) + 1), ry1 = Math.min(src.height, Math.ceil(y1) + 1);
        if (rx1 <= rx0 || ry1 <= ry0) return;
        if (entry.gpu) {
            // the screen's GPU copy of a tile mirror: the rectangle copied in unscaled, from the rectangle
            // alone (a draw from the whole CPU mirror would move all of it); the levels then read the copy
            const g = entry.gpu, cx = g.getContext("2d");
            const part = pixels.displayRectSource([rx0, ry0, rx1, ry1]);
            try {
                cx.save();
                cx.setTransform(1, 0, 0, 1, 0, 0);
                cx.globalAlpha = 1;
                cx.globalCompositeOperation = "source-over";
                cx.clearRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
                cx.drawImage(part.canvas, rx0 - part.x, ry0 - part.y, rx1 - rx0, ry1 - ry0, rx0, ry0, rx1 - rx0, ry1 - ry0);
                cx.restore();
            } finally {
                if (part.temp) { part.canvas.width = 1; part.canvas.height = 1; }
            }
            g._dispVer = (g._dispVer || 0) + 1;
        }
        let prev = entry.gpu || src, px0 = rx0, py0 = ry0, px1 = rx1, py1 = ry1;
        for (let i = 0; i < entry.levels.length; i++) {
            const lvl = entry.levels[i];
            if (!lvl) break;
            // the same chain as a full build: level i is drawn from level i - 1
            const f = lvl.width / prev.width, g = lvl.height / prev.height;
            const lx0 = Math.max(0, Math.floor(px0 * f) - 1), ly0 = Math.max(0, Math.floor(py0 * g) - 1);
            const lx1 = Math.min(lvl.width, Math.ceil(px1 * f) + 1), ly1 = Math.min(lvl.height, Math.ceil(py1 * g) + 1);
            if (lx1 <= lx0 || ly1 <= ly0) break;
            const cx = lvl.getContext("2d");
            cx.save();
            cx.setTransform(1, 0, 0, 1, 0, 0);
            cx.globalAlpha = 1;
            // Replace the rectangle, alpha included: clear it and draw over the hole. This used
            // to be one drawImage with globalCompositeOperation "copy", and "copy" applies to
            // the whole canvas in Chromium: everything outside the rectangle was cleared too,
            // so after one erase stroke the display level of the layer held nothing but the
            // strip around the stroke, and a result layer vanished from the screen (not from
            // its pixels) while the eraser was nowhere near its content.
            cx.globalCompositeOperation = "source-over";
            cx.clearRect(lx0, ly0, lx1 - lx0, ly1 - ly0);
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "medium";
            // level 0 reads the pixels: through displayRectSource, which is the canvas itself on the canvas
            // backend (the same draw as always) and the rectangle alone on tiles (a draw from the whole
            // CPU mirror transfers all of it after every write, docs/PLAN_BCE.md §C2 step b)
            const part = i === 0 && !entry.gpu && pixels instanceof LayerPixels
                ? pixels.displayRectSource([Math.floor(lx0 / f) - 4, Math.floor(ly0 / g) - 4, Math.ceil(lx1 / f) + 4, Math.ceil(ly1 / g) + 4])
                : { canvas: prev, x: 0, y: 0, temp: false };
            try {
                cx.drawImage(part.canvas, lx0 / f - part.x, ly0 / g - part.y, (lx1 - lx0) / f, (ly1 - ly0) / g, lx0, ly0, lx1 - lx0, ly1 - ly0);
            } finally {
                if (part.temp) { part.canvas.width = 1; part.canvas.height = 1; }
            }
            cx.restore();
            lvl._dispVer = (lvl._dispVer || 0) + 1;   // this level's pixels changed too
            prev = lvl;
            px0 = lx0; py0 = ly0; px1 = lx1; py1 = ly1;
        }
    }

    /**
     * A cached downscaled copy of a source canvas for drawing at `scale` (destination
     * pixels per source pixel). Levels are successive halvings, so a 12k image is drawn
     * from a 1.5k copy at fit zoom instead of being resampled in full every frame.
     * Live stroke previews change every frame and are never cached. `src` is pixels or a
     * canvas; what comes back is always a canvas to draw from (C3 turns it into a level).
     *
     * `screen`: the result is drawn onto the screen on every frame (the view, its overlays, the
     * GPU compositor). A tile store's display mirror is a CPU canvas, and a draw from a CPU canvas
     * into a GPU canvas moves all of it each time (measured at 6000 × 4000, zoom 1, a filter layer
     * in the stack: 44 ms a pan frame against 3.6 on canvases), so where the mirror itself would be
     * drawn the screen gets a GPU copy of it instead, kept in the pyramid entry and refreshed by
     * rectangles with the levels (C2 step b's review). Exports and runs draw the mirror once and
     * keep nothing.
     */
    displaySource(src, scale, screen = false) {
        src = canvasOf(src);
        if (!src || src._livePreview) return src;
        const w = src.width || src.naturalWidth || 0;
        const h = src.height || src.naturalHeight || 0;
        if (!w || !h || !(scale > 0) || scale >= 0.5 || w * h < PYRAMID_MIN_PX) return screen && src._cpuMirror ? this.gpuCopy(src, w, h) : src;
        let want = 0;
        while (want + 1 < PYRAMID_LEVELS && (1 / (1 << (want + 2))) >= scale) want++;
        const entry = this.pyramidEntry(src, w, h);
        // the screen shows this source from a level now: its full-size GPU copy is not kept in VRAM (the
        // next frame at 0.5 or more makes it again, one transfer of the mirror)
        if (screen && entry.gpu) entry.gpu = null;
        for (let i = 0; i <= want; i++) {
            if (entry.levels[i]) continue;
            // one new level per frame: after a zoom step every source would otherwise build
            // its chain in the same frame (five sources at 24 MP are 200 ms). The frame uses
            // the level it has, drawSoon() comes back for the next one.
            if (this._pyramidBudget <= 0) { this._pyramidPending = true; return entry.levels[i - 1] || src; }
            this._pyramidBudget--;
            const lw = Math.max(1, Math.round(w / (1 << (i + 1))));
            const lh = Math.max(1, Math.round(h / (1 << (i + 1))));
            const c = makeCanvas(lw, lh);
            const cx = c.getContext("2d");
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "medium";
            cx.drawImage(i === 0 ? (entry.gpu || src) : entry.levels[i - 1], 0, 0, lw, lh);
            entry.levels[i] = c;
        }
        return entry.levels[want] || src;
    }

    /** The pyramid entry of a display canvas at its current version (a new, empty one after a change). */
    pyramidEntry(src, w, h) {
        const ver = src._dispVer || 0;
        let entry = this.pyramids.get(src);
        if (!entry || entry.version !== ver || entry.w !== w || entry.h !== h) {
            entry = { version: ver, w, h, levels: [], gpu: null };
            this.pyramids.set(src, entry);
        }
        return entry;
    }

    /**
     * A GPU canvas holding what the CPU display mirror `src` holds (displaySource's `screen`), made
     * with one draw per version of the mirror and refreshed by rectangles in touchSourceRect. The
     * premultiplied pixels are the ones the mirror's own upload would give, so a draw from it is the
     * draw from the mirror.
     */
    gpuCopy(src, w, h) {
        const entry = this.pyramidEntry(src, w, h);
        if (!entry.gpu) {
            const c = makeCanvas(w, h);
            c.getContext("2d").drawImage(src, 0, 0);
            entry.gpu = c;
        }
        return entry.gpu;
    }

    /**
     * The base drawn into `ctx` at `x, y, w, h` for a full-resolution use (a resize, a merge into the base): on tiles from
     * a canvas made for this draw and let go after it, not the display mirror, which `drawTo` makes and keeps (572 MB at
     * 15000 x 10000 for as long as the tab is in front).
     */
    drawBaseInto(ctx, x, y, w, h) {
        const px = this.basePx;
        if (!isTilePixels(px)) { px.drawTo(ctx, x, y, w, h); return; }
        const c = px.toCanvas();
        try { ctx.drawImage(c, x, y, w, h); } finally { c.width = 1; c.height = 1; }
    }

    /** Upload new base pixels (a PNG in the mirror); on tiles through a canvas made for it and let go. */
    async uploadBase(px) {
        return uploadPixels(px, `n${this.node.id}_base`);
    }

    /**
     * The image rectangle the view shows (a little larger), and the scale to composite it
     * at. Its size depends only on zoom, rotation and window size, never on where the view
     * sits: with a size that changes per frame the viewport canvas would be reallocated on
     * every pan step, which costs more than the composite itself. The rectangle may reach
     * outside the image; the parts outside stay empty.
     */
    viewportRegion() {
        if (!this.width || !this.canvas.width) return null;
        const W = this.canvas.width, H = this.canvas.height;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        // under the straighten preview the screen shows the picture turned: its corners back through the turn
        const tilt = this.viewTilt(), tc = Math.cos(-(tilt || 0)), ts = Math.sin(-(tilt || 0)), hx = this.width / 2, hy = this.height / 2;
        for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
            let [ix, iy] = this.canvasToImage(cx, cy);
            if (tilt) { const dx = ix - hx, dy = iy - hy; ix = hx + dx * tc - dy * ts; iy = hy + dx * ts + dy * tc; }
            if (ix < x0) x0 = ix;
            if (ix > x1) x1 = ix;
            if (iy < y0) y0 = iy;
            if (iy > y1) y1 = iy;
        }
        const pad = 4 / Math.max(0.01, this.view.scale);
        const w = Math.ceil(x1 - x0 + 2 * pad) + 1, h = Math.ceil(y1 - y0 + 2 * pad) + 1;
        if (w < 1 || h < 1) return null;
        return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w, h, scale: Math.min(1, this.view.scale) };
    }

    /**
     * The WebGL2 compositor, once per editor and only if this host has WebGL2. Null means
     * the Canvas 2D path does the work, which is also what happens after a failure.
     */
    compositor() {
        if (this._compositor !== undefined) return this._compositor;
        this._compositor = null;
        try {
            if (GLCompositor.available()) {
                this._compositor = new GLCompositor();
                // the tile atlas's budget: settings.memory.atlasMB, put on the editor by the shell
                if (this.atlasMB) this._compositor.setAtlasBudget(this.atlasMB * 1048576);
            }
        } catch (err) {
            console.warn("Inpaint Canvas: no GPU compositor, staying on Canvas 2D:", (err && err.message) || err);
        }
        return this._compositor;
    }

    /**
     * Can the GPU composite this stack? It stacks prepared layer pixels and nothing else,
     * so anything that needs Canvas 2D's own machinery stays on Canvas 2D. None of these
     * is a per-frame cost: painting and transforming are already a fraction of a
     * millisecond after phases 1 and 2, and filter layers keep their chain.
     */
    glCompositeUsable(opts) {
        if (this.compositorOff || opts.forRun || opts.controlOnly) return false;
        if (opts.baseOnly) return !!this.compositor();   // the peek: no layer is drawn, so nothing of theirs can refuse
        if (this.compareShow || this.peekBase) return false;
        if (this.pending) return false;                       // a transform draws with a mesh
        if (this.pointer && this.pointer.layer) return false;  // a live stroke preview changes every frame
        for (const l of this.layers) {
            if (!this.shown(l)) continue;
            if (l.kind === "filter") return false;             // the filter chain is step 2
            if (l.maskEdit) return false;
            const b = l.blend || "normal";
            if (b !== "normal" && !(b in BLEND_OPS)) return false;
        }
        return !!this.compositor();
    }

    /**
     * One entry of the GPU compositor's layer stack (docs/PLAN_BCE.md §C3). A tile store is handed
     * over as itself with the level to draw: the compositor uploads the visible tiles into its atlas
     * and draws them instanced, so no display mirror and no GPU copy of one is made. Anything else
     * (a canvas: a colour-matched layer, a masked layer's `_masked`, the canvas backend) keeps the
     * display pyramid.
     *
     * The level is the one whose tiles are at least as dense as the screen:
     * `floor(-log2(scale))`, clamped to the mips a tile carries.
     */
    glLayerSpec(px, x, y, w, h, opacity, blend, sx, mask = null) {   // a tile store's spec may carry `match` (C6 c 7d)
        const scale = (w * sx) / px.width;
        if (isTilePixels(px)) {
            const level = scale > 0 && Number.isFinite(scale) ? Math.max(0, Math.min(MIP_LEVELS, Math.floor(-Math.log2(scale)))) : 0;
            return { pixels: px, mask, level, x, y, w, h, opacity, blend };
        }
        const lvl = this.displaySource(px, scale, true);
        return { source: lvl, version: this.sourceVersion(lvl), x, y, w, h, opacity, blend };
    }

    /**
     * The visible region composited on the GPU. Returns the compositor's canvas, or null
     * when it could not do it (a source over MAX_TEXTURE_SIZE, a lost context).
     */
    glViewComposite(region, vw, vh, opts) {
        const comp = this.compositor();
        if (!comp) return null;
        const sx = vw / region.w;
        const layers = [];
        const base = this.basePx;
        if (base) layers.push(this.glLayerSpec(base, 0, 0, this.width, this.height, 1, "normal", sx));
        const vp = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy: vh / region.h };
        // clipping (PLAN_0_1_31 §6 step 3), as drawLayersInto: a clipped layer only over a base this pass draws, which then
        // leaves its coverage for it (`clipId` / `clipTo`)
        const specOf = new Map();
        const push = (layer, spec) => {
            const cb = this.clipBaseOf(layer);
            if (cb) {
                const bs = specOf.get(cb);
                if (!bs) return;
                if (bs.clipId == null) bs.clipId = specOf.size;
                spec.clipTo = bs.clipId;
            }
            specOf.set(layer, spec);
            layers.push(spec);
        };
        try {
            for (const layer of opts.baseOnly ? [] : this.layers) {
                if (!this.shown(layer) || !layer.px) continue;
                if (this.isControl(layer) && opts.forRun) continue;
                const opacity = layer.opacity == null ? 1 : layer.opacity, blend = layer.blend || "normal";
                if (this.matchActive(layer) && this.matchFromTiles(layer)) {
                    // C6 (c) 7d: the layer's own tiles in the atlas, matched in the atlas shader with the shared statistics:
                    // no matched canvas, no upload of one, and a strength tick is a uniform
                    const st = this.matchStats(layer, null, { ...vp, screen: true }, null);
                    const k = Math.min(1, Math.max(0, ((layer.match && layer.match.strength) || 0) / 100));
                    const spec = this.glLayerSpec(layer.px, layer.x, layer.y, layer.w, layer.h, opacity, blend, sx, this.tileMaskOf(layer));
                    spec.match = st && k > 0 ? { meanS: st.meanS, meanT: st.meanT, scale: st.scale, k } : null;
                    push(layer, spec);
                    continue;
                }
                // the statistics are the layer's shared entry (C6 c 7c): no backdrop of this pass is read for them
                const matched = this.matchActive(layer) ? this.layerMatchedPixels(layer, null, vp) : null;
                // C5: a transparency mask on the same tile grid is applied in the atlas shader, so the
                // layer's own tiles are drawn for it too. Only a colour match, a live stroke or a mask
                // of another size still needs layerPixels to prepare a canvas.
                const tileMask = matched ? null : this.tileMaskOf(layer);
                const px = matched || (this.liveMask(layer) && !tileMask ? this.layerPixels(layer, true) : layer.px);
                if (!px || px._livePreview) return null;
                push(layer, this.glLayerSpec(px, layer.x, layer.y, layer.w, layer.h, opacity, blend, sx, tileMask));
            }
            return comp.composite({ width: vw, height: vh, region, layers });
        } catch (err) {
            console.warn("Inpaint Canvas: the GPU compositor failed, staying on Canvas 2D:", (err && err.message) || err);
            this.compositorOff = true;
            return null;
        }
    }

    /**
     * A version for a source canvas that only changes when its pixels do: what
     * `touchSource` and `touchSourceRect` bump, on the original and on every pyramid level
     * they rewrite. A level rebuilt from scratch is a new canvas and starts at 0, which is
     * a fresh key in the compositor's texture cache anyway.
     */
    sourceVersion(src) {
        src = canvasOf(src);
        return src ? (src._dispVer || 0) : 0;
    }

    /**
     * Composite only what the view shows, at screen resolution, and blit that (Krita's
     * prescaled projection). Layers come from their pyramid level, filters and colour
     * match run on the small input; exports, runs and the thumbnail keep their own paths.
     */
    drawViewComposite(ctx, opts = {}) {
        const region = this.viewportRegion();
        if (!region) return;
        const vw = Math.max(1, Math.round(region.w * region.scale));
        const vh = Math.max(1, Math.round(region.h * region.scale));
        if (!this.viewCanvas || this.viewCanvas.width !== vw || this.viewCanvas.height !== vh) this.viewCanvas = makeCanvas(vw, vh);
        this._viewRegion = opts.baseOnly ? null : region;   // what viewCanvas shows (the clone overlay reads it); not the base alone
        const v = this.viewCanvas.getContext("2d");
        const sx = vw / region.w, sy = vh / region.h;
        v.setTransform(1, 0, 0, 1, 0, 0);
        v.globalAlpha = 1;
        v.globalCompositeOperation = "source-over";
        v.clearRect(0, 0, vw, vh);
        v.imageSmoothingEnabled = true;
        let gl = null;
        if (this.glCompositeUsable(opts)) {
            const prevVp = this.viewPass;
            this.viewPass = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy, screen: true };
            try {
                gl = this.glViewComposite(region, vw, vh, opts);
            } finally {
                this.viewPass = prevVp;
            }
            if (gl) {
                v.setTransform(1, 0, 0, 1, 0, 0);
                v.drawImage(gl, 0, 0);
            }
        }
        if (!gl) {
            v.setTransform(sx, 0, 0, sy, -region.x * sx, -region.y * sy);
            const prev = this.viewPass;
            this.viewPass = { x: region.x, y: region.y, w: region.w, h: region.h, sx, sy, screen: true };
            try {
                this.drawComposite(v, opts);
            } finally {
                this.viewPass = prev;
            }
        }
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.viewCanvas, region.x, region.y, region.w, region.h);
        ctx.restore();
    }
}

export function bindDisplay(C) { InpaintEditor = C; }
