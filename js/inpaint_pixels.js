// Generated from DenRakEiw/scumble renderer/editor/inpaint_pixels.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The pixels of a layer, a layer mask, the selection and the base behind one interface
 * (docs/PLAN_BCE.md C1). Every read and every write of those pixels in the editor goes
 * through a `LayerPixels` / `MaskPixels`; nothing reaches for a layer's canvas directly.
 *
 * This file holds the canvas backend: the pixels are one canvas, exactly as before C1, and
 * every method does what the call sites used to do with that canvas, so the output is the
 * same to the level. The tile store of C2 is the second backend behind the same methods.
 *
 * Rules for callers (they are what lets a second backend slot in):
 * - Write only through `writeRect`, `drawInto`, `blit`, `clear`, `fill`. A canvas handed out
 *   by `toCanvas()` is a read-only view; in the tile backend it is a copy, so a write into it
 *   is lost. `setPixelsOptions({ copy: true })` makes this backend hand out copies too, which
 *   is how the gates prove that no call site writes into one. It is valid only until the next
 *   write: in this backend it is the pixels themselves, so a caller that keeps it across an
 *   await (an encode, a worker job) and needs the pixels as they were takes them at the call
 *   (`createImageBitmap`, `clone()`, `copyRect`) and never reads the canvas again afterwards.
 * - `drawInto(rect, fn)`: `fn(ctx)` draws in the pixels' own coordinates; what falls outside
 *   `rect` ([x0, y0, x1, y1], null for everything) is dropped. `fn` must not read `ctx.canvas`
 *   and must not read pixels back from `ctx`: in the tile backend the context belongs to a
 *   scratch canvas of `rect`. For the same reason `fn` does not call `putImageData` (it ignores
 *   the transform and the clip, so it lands shifted on the scratch and unclipped here),
 *   `isPointInPath` / `isPointInStroke` (they take device coordinates), and clips only to
 *   rectangles on whole pixels (the scratch is an OffscreenCanvas, which clips without
 *   anti-aliasing; a canvas clips with it). `fn` does not read or write the pixels it draws into
 *   through their own methods (a nested write would be overwritten by the scratch, a read would
 *   not see what `fn` drew): both backends throw on that.
 * - The transform `fn` receives is not the identity by contract: it is whatever maps the pixels'
 *   own coordinates onto the canvas behind `ctx` (the identity in this backend, a translation by
 *   the rect's origin on the tile backend's scratch). `fn` and every helper it hands `ctx` to may
 *   only compose on it (`scale`, `translate`, `rotate`, `transform`, `save` / `restore`), never
 *   `setTransform` / `resetTransform`, and must not take `getTransform()` as absolute
 *   (docs/PLAN_BCE.md §C1 "C1 as built", rule 12).
 * - `version` changes on `touch()`. The editor's `touchSource` / `touchSourceRect` call it
 *   after every write, which is also what refreshes the display levels.
 * - Straight alpha in and out (`ImageData`), like the canvas itself.
 * - `drawInto`'s `fn` is synchronous: the tile backend writes its scratch back when `fn` returns.
 *   A `fn` that returns a promise throws on both backends, after what it drew before its first
 *   await is kept.
 */

let OPTIONS = { strict: false, copy: false, software: false, tiles: null, tilesFrom: null };
const warned = new Set();

/**
 * `strict`: the old property names throw instead of warning. `copy`: `toCanvas()` hands out copies.
 * `software`: every canvas this module makes gets a `willReadFrequently` context, so Chromium
 * rasterises it on the CPU like the tile backend's scratch (docs/PLAN_BCE.md §C2 "C2 as built":
 * a plain canvas is rasterised on the GPU, and anti-aliased edges, gradients and resampling then
 * differ from the CPU by tens of levels). A diagnostic switch for the contract test, off in the app.
 * `tiles`: the backend a new editor takes (docs/PLAN_BCE.md §C2 step b), null when the host set none
 * (the editor then reads localStorage "inpaint_canvas.tiles"); `tilesFrom` says what decided it.
 */
export function setPixelsOptions(opts = {}) {
    OPTIONS = { ...OPTIONS, ...opts };
}

export function pixelsOptions() {
    return { ...OPTIONS };
}

/** A canvas of w x h (at least 1 x 1), as both backends make them. */
export function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    if (OPTIONS.software) c.getContext("2d", { willReadFrequently: true });
    return c;
}

/** [x0, y0, x1, y1] on whole pixels (outward) and clamped to w x h; null when nothing is left. */
export function pixelRect(rect, w, h) {
    if (!rect) return [0, 0, w, h];
    const x0 = Math.max(0, Math.floor(rect[0])), y0 = Math.max(0, Math.floor(rect[1]));
    const x1 = Math.min(w, Math.ceil(rect[2])), y1 = Math.min(h, Math.ceil(rect[3]));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * A context as a fresh one comes: what `drawInto` hands `fn`, so a draw never depends on what
 * an earlier draw left behind (a scratch canvas of the tile backend has nothing left behind).
 * The path is part of it: `beginPath` is not undone by `restore`.
 */
export function resetContext(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 10;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "rgba(0, 0, 0, 0)";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.filter = "none";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    // the text state the font shorthand does not reset (renderText leaves letterSpacing on the
    // canvas a text layer adopts); a scratch's ctx.reset() clears all of it
    ctx.letterSpacing = "0px";
    ctx.wordSpacing = "0px";
    ctx.direction = "inherit";
    ctx.fontKerning = "auto";
    ctx.textRendering = "auto";
    ctx.fontStretch = "normal";
    ctx.fontVariantCaps = "normal";
    if ("lang" in ctx) ctx.lang = "inherit";
    ctx.beginPath();
}

/** The Error both backends throw when a drawInto callback reaches the pixels it draws into. */
export function reentrantPixels() {
    return new Error("Inpaint Canvas: a drawInto callback must not read or write the pixels it draws into");
}

// operations whose result outside the drawn source is "cleared": in Chromium they apply to
// the whole canvas unless a clip region holds them to the rectangle
export const WHOLE_CANVAS_OPS = new Set(["copy", "destination-in", "source-in", "destination-atop", "source-out"]);

/**
 * The margin a blit source is taken with around its rectangle (both backends): a draw at a
 * fractional position samples the neighbours, a draw at a whole position samples nothing outside
 * the rectangle but Skia draws a sub-rectangle of an image by another path than a whole image.
 */
export const BLIT_MARGIN = 2;

export class LayerPixels {
    /** Adopts `canvas`: it belongs to these pixels afterwards. */
    constructor(canvas) {
        this._c = canvas;
        this._ctx = null;
        this._drawing = 0;   // > 0 while a drawInto callback runs (reads and writes of these pixels throw)
    }

    _guard() {
        if (this._drawing) throw reentrantPixels();
    }

    /** The backend these pixels belong to: `{ Layer, Mask, tiles }` (inpaint_tiles.js `pixelsBackend`). */
    static get backend() { return CANVAS_BACKEND; }

    static empty(w, h) { return new this(makeCanvas(w, h)); }

    static fromCanvas(canvas) { return new this(canvas); }

    static fromImageData(data) {
        const c = makeCanvas(data.width, data.height);
        c.getContext("2d").putImageData(data instanceof ImageData ? data : new ImageData(data.data, data.width, data.height), 0, 0);
        return new this(c);
    }

    /** An <img>, ImageBitmap or canvas drawn at w x h (its natural size by default). */
    static fromImage(img, w, h) {
        const c = makeCanvas(w || img.naturalWidth || img.width, h || img.naturalHeight || img.height);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        return new this(c);
    }

    get width() { return this._c.width; }

    get height() { return this._c.height; }

    /** Changes whenever `touch()` is called; the display caches key on it. */
    get version() { return this._c._dispVer || 0; }

    _context() {
        if (!this._ctx) this._ctx = this._c.getContext("2d");
        return this._ctx;
    }

    /** Mark the pixels changed (inside `rect`, or all of them) without writing. */
    touch(rect = null) {   // the canvas backend has one version for all of it; C2 counts per tile
        this._c._dispVer = (this._c._dispVer || 0) + 1;
    }

    /** The pixels of a rectangle as ImageData; outside the pixels reads as transparent. */
    readRect(x, y, w, h) {
        this._guard();
        return this._context().getImageData(x, y, w, h);
    }

    /** Write ImageData at (x, y) with an operation and an alpha; "copy" replaces the rectangle. */
    writeRect(data, x, y, op = "copy", alpha = 1) {
        this._guard();
        const img = data instanceof ImageData ? data : new ImageData(data.data, data.width, data.height);
        if (op === "copy" && alpha === 1) {
            this._context().putImageData(img, x, y);
            return;
        }
        const src = makeCanvas(img.width, img.height);
        src.getContext("2d").putImageData(img, 0, 0);
        this._drawOp(src, 0, 0, img.width, img.height, x, y, op, alpha);
    }

    /**
     * Canvas 2D drawing into the pixels: `fn(ctx)` with the context reset to a fresh one's state
     * (alpha 1, source-over, ...) and a transform that maps the pixels' own coordinates (the
     * identity here; `fn` composes on it, never sets it: see the rules at the top), clipped to
     * `rect` when it is not the whole area. Returns what `fn` returns.
     */
    drawInto(rect, fn) {
        this._guard();
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return undefined;
        const ctx = this._context();
        ctx.save();
        this._drawing++;
        try {
            resetContext(ctx);
            if (r[0] > 0 || r[1] > 0 || r[2] < this.width || r[3] < this.height) {
                const clip = new Path2D();
                clip.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.clip(clip);
            }
            const back = fn(ctx);
            if (back && typeof back.then === "function") {
                // the tile backend throws here too: what fn draws after an await is lost there, and
                // lands unclipped here once the context is restored
                throw new Error("Inpaint Canvas: a drawInto callback must be synchronous");
            }
            return back;
        } finally {
            this._drawing--;
            ctx.restore();
        }
    }

    /** Paint the pixels into another context; the arguments after `ctx` are drawImage's. */
    drawTo(ctx, ...args) {
        this._guard();
        ctx.drawImage(this._c, ...args);
    }

    /**
     * Another pixels' content (its `srcRect`, all of it by default) at (dx, dy), unscaled,
     * with an operation and an alpha. "copy" replaces the destination rectangle and leaves
     * everything outside it alone.
     */
    blit(src, dx, dy, op = "source-over", alpha = 1, srcRect = null) {
        this._guard();
        src._guard();
        const r = pixelRect(srcRect, src.width, src.height);
        if (!r) return;
        if (src === this && op === "copy") {
            // "copy" clears the destination rectangle before it draws, which would clear the source
            // where the two overlap: copy the source rectangle first (no call site blits onto itself),
            // with a margin of 2 px, so a fractional position samples the neighbours as a draw from
            // the canvas itself does (the tile backend's blit source has the same margin)
            const m = pixelRect([r[0] - BLIT_MARGIN, r[1] - BLIT_MARGIN, r[2] + BLIT_MARGIN, r[3] + BLIT_MARGIN], this.width, this.height);
            const snap = this.copyRect(m);
            this._drawOp(snap._c, r[0] - m[0], r[1] - m[1], r[2] - r[0], r[3] - r[1], dx, dy, op, alpha);
            snap._c.width = 1;
            return;
        }
        const s = src._blitSource(r, dx, dy);   // pixels of either backend
        this._drawOp(s.canvas, s.sx, s.sy, r[2] - r[0], r[3] - r[1], dx, dy, op, alpha);
    }

    /** A canvas holding the source rectangle `r` of a blit, and where `r` sits in it. */
    _blitSource(r, dx, dy) {
        return { canvas: this._c, sx: r[0], sy: r[1] };
    }

    /** The canvas the display machinery draws (`canvasOf`); read-only. */
    canvasForDisplay() {
        this._guard();
        return this._c;
    }

    /** The display canvas as it is, without making or syncing one (memoryReport, releaseCaches). */
    displayCanvasIfMade() {
        return this._c;
    }

    /**
     * A canvas to draw the rectangle `rect` ([x0, y0, x1, y1], whole pixels) of the display pixels from,
     * and where its (0, 0) sits in these pixels: the display pyramid's rectangle refresh reads it. Here
     * the pixels' own canvas at (0, 0); the tile store hands out the rectangle alone, because a draw from
     * its whole display mirror (a CPU canvas) into a GPU level transfers the whole mirror after every
     * write (docs/PLAN_BCE.md §C2 step b). `temp`: the caller gives the canvas back after the draw.
     */
    displayRectSource(rect) {
        this._guard();
        return { canvas: this._c, x: 0, y: 0, temp: false };
    }

    /** Give the display canvas back when it is only a cache (the tile backend's mirror); the bytes. */
    releaseDisplay() {
        return 0;
    }

    _drawOp(source, sx, sy, sw, sh, dx, dy, op, alpha) {
        const ctx = this._context();
        ctx.save();
        try {
            resetContext(ctx);
            ctx.globalAlpha = alpha;
            if (op === "copy") {
                // clear the rectangle and draw over the hole: "copy" itself would clear the whole canvas
                ctx.globalCompositeOperation = "source-over";
                ctx.clearRect(dx, dy, sw, sh);
            } else {
                ctx.globalCompositeOperation = op;
                if (WHOLE_CANVAS_OPS.has(op)) {
                    // on whole pixels (outward): the tile backend's scratch clips without
                    // anti-aliasing, a canvas with it, and the two agree on whole pixels only
                    const c = pixelRect([dx, dy, dx + sw, dy + sh], this.width, this.height);
                    if (!c) return;
                    const clip = new Path2D();
                    clip.rect(c[0], c[1], c[2] - c[0], c[3] - c[1]);
                    ctx.clip(clip);
                }
            }
            ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh);
        } finally {
            ctx.restore();
        }
    }

    /** Clear a rectangle (all of it when null) to transparent. */
    clear(rect = null) {
        this._guard();
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return;
        const ctx = this._context();
        ctx.save();
        resetContext(ctx);
        ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        ctx.restore();
    }

    /** Fill a rectangle (all of it when null) with a CSS colour, replacing what was there. */
    fill(rect, color) {
        this._guard();
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return;
        const ctx = this._context();
        ctx.save();
        resetContext(ctx);
        ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        ctx.fillStyle = color;
        ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
        ctx.restore();
    }

    /** The non-transparent extent [x0, y0, x1, y1], or null when every pixel is transparent. */
    bounds() {
        this._guard();
        const W = this.width, H = this.height, STRIP = 512;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let sy = 0; sy < H; sy += STRIP) {
            const sh = Math.min(STRIP, H - sy);
            const d = this.readRect(0, sy, W, sh).data;
            for (let y = 0; y < sh; y++) {
                let row = y * W * 4 + 3;
                for (let x = 0; x < W; x++, row += 4) {
                    if (!d[row]) continue;
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (sy + y < y0) y0 = sy + y;
                    if (sy + y > y1) y1 = sy + y;
                }
            }
        }
        return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    }

    /** A copy of a rectangle as pixels of that size. */
    copyRect(rect) {
        this._guard();
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return null;
        const w = r[2] - r[0], h = r[3] - r[1];
        const c = makeCanvas(w, h);
        c.getContext("2d").drawImage(this._c, r[0], r[1], w, h, 0, 0, w, h);
        return new this.constructor(c);
    }

    clone() {
        this._guard();
        const c = makeCanvas(this.width, this.height);
        c.getContext("2d").drawImage(this._c, 0, 0);
        return new this.constructor(c);
    }

    /** Pixels of w x h with this content placed at (x, y): extending or cropping the canvas. */
    resized(w, h, { x = 0, y = 0 } = {}) {
        this._guard();
        const c = makeCanvas(w, h);
        c.getContext("2d").drawImage(this._c, x, y);
        return new this.constructor(c);
    }

    /**
     * A canvas with the pixels (of `rect` only, when given) for code that needs one: exports,
     * uploads, filters, the transform mesh. Read-only (see the rules at the top).
     */
    toCanvas(rect = null) {
        this._guard();
        if (rect) {
            const part = this.copyRect(rect);
            return part ? part._c : makeCanvas(1, 1);
        }
        return OPTIONS.copy ? this.clone()._c : this._c;
    }

    bytes() {
        return this.width * this.height * 4;
    }
}

/**
 * A layer mask or the selection. One channel is what counts (the alpha); the canvas backend
 * keeps the canvas it always was (the selection is red, a mask white where it lets through).
 */
export class MaskPixels extends LayerPixels {}

const CANVAS_BACKEND = Object.freeze({ Layer: LayerPixels, Mask: MaskPixels, tiles: false });

/**
 * The display pyramid's and the GPU compositor's canvas of some pixels (or the canvas they
 * were handed). Reads only, never copies: C3 replaces both machines and this with it. The tile
 * backend answers with its display mirror (inpaint_tiles.js).
 */
export function canvasOf(src) {
    return src instanceof LayerPixels ? src.canvasForDisplay() : src;
}

/**
 * The display canvas of some pixels if one exists, without making or syncing it (a canvas as it is):
 * what `memoryReport` / `releaseCaches` look up in the pyramid map, where `canvasOf` would build a
 * tile store's mirror just to be counted.
 */
export function displayCanvasIfMade(src) {
    return src instanceof LayerPixels ? src.displayCanvasIfMade() : src;
}

/** The backend of a layer's pixels (its `px`, else its `maskPx`), the canvas backend for none. */
function backendOf(layer) {
    const p = layer.px || layer.maskPx;
    return p instanceof LayerPixels ? p.constructor.backend : CANVAS_BACKEND;
}

/** The old property names: a warning once per name, an error in strict mode (dev builds). */
export function deprecatedPixels(oldName, newName) {
    const msg = `Inpaint Canvas: ${oldName} is gone, use ${newName}`;
    if (OPTIONS.strict) throw new Error(msg);
    if (!warned.has(oldName)) {
        warned.add(oldName);
        console.warn(msg + " (the old name works for one more release)");
    }
}

/**
 * `layer.canvas` and `layer.mask` as accessors that are not enumerable, so a spread copy of
 * a layer carries `px` / `maskPx` and never calls them. Installed on every layer the editor
 * keeps (addLayer, undo, setValue); a leftover own `canvas` / `mask` value is converted into
 * `backend` (the editor's `{ Layer, Mask }`; the backend of the layer's own pixels when not given).
 */
export function installLayerAliases(layer, backend = null) {
    if (!layer || typeof layer !== "object") return layer;
    const own = (k) => Object.prototype.hasOwnProperty.call(layer, k);
    const canvasDesc = own("canvas") ? Object.getOwnPropertyDescriptor(layer, "canvas") : null;
    if (canvasDesc && "value" in canvasDesc) {
        const c = canvasDesc.value;
        delete layer.canvas;
        if (c) deprecatedPixels("a layer's canvas", "px");
        if (layer.px === undefined) layer.px = c ? (backend || backendOf(layer)).Layer.fromCanvas(c) : null;
    }
    const maskDesc = own("mask") ? Object.getOwnPropertyDescriptor(layer, "mask") : null;
    if (maskDesc && "value" in maskDesc) {
        const m = maskDesc.value;
        delete layer.mask;
        if (m) deprecatedPixels("a layer's mask canvas", "maskPx");
        if (layer.maskPx === undefined) layer.maskPx = m ? (backend || backendOf(layer)).Mask.fromCanvas(m) : null;
    }
    if (!own("canvas")) {
        Object.defineProperty(layer, "canvas", {
            configurable: true, enumerable: false,
            get() { deprecatedPixels("layer.canvas", "layer.px"); return this.px ? this.px.toCanvas() : null; },
            // adopted into the layer's current backend; the tile backend reads the canvas and does not
            // keep it, so a write into `c` afterwards is lost there (the old name is read-only, see the top)
            set(c) { deprecatedPixels("layer.canvas", "layer.px"); this.px = c ? backendOf(this).Layer.fromCanvas(c) : null; },
        });
    }
    if (!own("mask")) {
        Object.defineProperty(layer, "mask", {
            configurable: true, enumerable: false,
            get() { deprecatedPixels("layer.mask", "layer.maskPx"); return this.maskPx ? this.maskPx.toCanvas() : null; },
            set(c) { deprecatedPixels("layer.mask", "layer.maskPx"); this.maskPx = c ? backendOf(this).Mask.fromCanvas(c) : null; },
        });
    }
    return layer;
}
