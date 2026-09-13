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
 *   is how the gates prove that no call site writes into one.
 * - `drawInto(rect, fn)`: `fn(ctx)` draws in the pixels' own coordinates; what falls outside
 *   `rect` ([x0, y0, x1, y1], null for everything) is dropped. `fn` must not read `ctx.canvas`
 *   and must not read pixels back from `ctx`: in the tile backend the context belongs to a
 *   scratch canvas of `rect`.
 * - `version` changes on `touch()`. The editor's `touchSource` / `touchSourceRect` call it
 *   after every write, which is also what refreshes the display levels.
 * - Straight alpha in and out (`ImageData`), like the canvas itself.
 */

let OPTIONS = { strict: false, copy: false };
const warned = new Set();

/** `strict`: the old property names throw instead of warning. `copy`: `toCanvas()` hands out copies. */
export function setPixelsOptions(opts = {}) {
    OPTIONS = { ...OPTIONS, ...opts };
}

export function pixelsOptions() {
    return { ...OPTIONS };
}

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
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
function resetContext(ctx) {
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
    ctx.beginPath();
}

// operations whose result outside the drawn source is "cleared": in Chromium they apply to
// the whole canvas unless a clip region holds them to the rectangle
const WHOLE_CANVAS_OPS = new Set(["copy", "destination-in", "source-in", "destination-atop", "source-out"]);

export class LayerPixels {
    /** Adopts `canvas`: it belongs to these pixels afterwards. */
    constructor(canvas) {
        this._c = canvas;
        this._ctx = null;
    }

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
        return this._context().getImageData(x, y, w, h);
    }

    /** Write ImageData at (x, y) with an operation and an alpha; "copy" replaces the rectangle. */
    writeRect(data, x, y, op = "copy", alpha = 1) {
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
     * Canvas 2D drawing into the pixels: `fn(ctx)` with the context reset to the identity
     * transform, alpha 1 and source-over, clipped to `rect` when it is not the whole area.
     * Returns what `fn` returns.
     */
    drawInto(rect, fn) {
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return undefined;
        const ctx = this._context();
        ctx.save();
        try {
            resetContext(ctx);
            if (r[0] > 0 || r[1] > 0 || r[2] < this.width || r[3] < this.height) {
                const clip = new Path2D();
                clip.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.clip(clip);
            }
            return fn(ctx);
        } finally {
            ctx.restore();
        }
    }

    /** Paint the pixels into another context; the arguments after `ctx` are drawImage's. */
    drawTo(ctx, ...args) {
        ctx.drawImage(this._c, ...args);
    }

    /**
     * Another pixels' content (its `srcRect`, all of it by default) at (dx, dy), unscaled,
     * with an operation and an alpha. "copy" replaces the destination rectangle and leaves
     * everything outside it alone.
     */
    blit(src, dx, dy, op = "source-over", alpha = 1, srcRect = null) {
        const r = pixelRect(srcRect, src.width, src.height);
        if (!r) return;
        this._drawOp(src._c, r[0], r[1], r[2] - r[0], r[3] - r[1], dx, dy, op, alpha);
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
                    const clip = new Path2D();
                    clip.rect(dx, dy, sw, sh);
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
        const r = pixelRect(rect, this.width, this.height);
        if (!r) return null;
        const w = r[2] - r[0], h = r[3] - r[1];
        const c = makeCanvas(w, h);
        c.getContext("2d").drawImage(this._c, r[0], r[1], w, h, 0, 0, w, h);
        return new this.constructor(c);
    }

    clone() {
        const c = makeCanvas(this.width, this.height);
        c.getContext("2d").drawImage(this._c, 0, 0);
        return new this.constructor(c);
    }

    /** Pixels of w x h with this content placed at (x, y): extending or cropping the canvas. */
    resized(w, h, { x = 0, y = 0 } = {}) {
        const c = makeCanvas(w, h);
        c.getContext("2d").drawImage(this._c, x, y);
        return new this.constructor(c);
    }

    /**
     * A canvas with the pixels (of `rect` only, when given) for code that needs one: exports,
     * uploads, filters, the transform mesh. Read-only (see the rules at the top).
     */
    toCanvas(rect = null) {
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

/**
 * The display pyramid's and the GPU compositor's canvas of some pixels (or the canvas they
 * were handed). Reads only, never copies: C3 replaces both machines and this with it.
 */
export function canvasOf(src) {
    return src instanceof LayerPixels ? src._c : src;
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
 * keeps (addLayer, undo, setValue); a leftover own `canvas` / `mask` value is converted.
 */
export function installLayerAliases(layer) {
    if (!layer || typeof layer !== "object") return layer;
    const own = (k) => Object.prototype.hasOwnProperty.call(layer, k);
    const canvasDesc = own("canvas") ? Object.getOwnPropertyDescriptor(layer, "canvas") : null;
    if (canvasDesc && "value" in canvasDesc) {
        const c = canvasDesc.value;
        delete layer.canvas;
        if (c) deprecatedPixels("a layer's canvas", "px");
        if (layer.px === undefined) layer.px = c ? LayerPixels.fromCanvas(c) : null;
    }
    const maskDesc = own("mask") ? Object.getOwnPropertyDescriptor(layer, "mask") : null;
    if (maskDesc && "value" in maskDesc) {
        const m = maskDesc.value;
        delete layer.mask;
        if (m) deprecatedPixels("a layer's mask canvas", "maskPx");
        if (layer.maskPx === undefined) layer.maskPx = m ? MaskPixels.fromCanvas(m) : null;
    }
    if (!own("canvas")) {
        Object.defineProperty(layer, "canvas", {
            configurable: true, enumerable: false,
            get() { deprecatedPixels("layer.canvas", "layer.px"); return this.px ? this.px.toCanvas() : null; },
            set(c) { deprecatedPixels("layer.canvas", "layer.px"); this.px = c ? LayerPixels.fromCanvas(c) : null; },
        });
    }
    if (!own("mask")) {
        Object.defineProperty(layer, "mask", {
            configurable: true, enumerable: false,
            get() { deprecatedPixels("layer.mask", "layer.maskPx"); return this.maskPx ? this.maskPx.toCanvas() : null; },
            set(c) { deprecatedPixels("layer.mask", "layer.maskPx"); this.maskPx = c ? MaskPixels.fromCanvas(c) : null; },
        });
    }
    return layer;
}
