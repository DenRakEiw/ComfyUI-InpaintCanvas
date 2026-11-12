// Generated from DenRakEiw/scumble renderer/editor/inpaint_strokebuf.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// stroke scratch constants, the map tile stats cache, sourceTag, UploadCache and StrokeBuffer: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { resetContext } from "./inpaint_pixels.js";
import { mapTileStats, rangeMax } from "./inpaint_edges.js";
import { makeCanvas } from "./inpaint_consts.js";

// A live preview canvas above this many pixels is given back after the gesture (a 15k
// layer's is 600 MB); smaller ones are kept for the next stroke.
const STROKE_SCRATCH_KEEP_PX = 16 * 1024 * 1024;
// A stroke is applied to its target, and its clip to the selection is taken, in bands of this
// side (docs/PLAN_BCE.md §C5): a stroke across a 15000 x 10000 picture used to make a clipped
// copy of itself at the layer's resolution, two canvases of 561 MB, and one drawInto of the
// whole box (a 561 MB scratch read back in blocks, 1.3 s on tiles).
const STROKE_BAND = 1024;

// WeakMap caching { rmax, stats: Map } keyed by map.data (immutable Uint16Array) for selectRange depth tile stats (R2-S6, K21)
const RMAX_CACHE = new WeakMap();
function cachedMapTileStats(map, m, W, H, snapOn, tau) {
    let entry = RMAX_CACHE.get(map.data);
    if (!entry) {
        entry = { rmax: null, stats: new Map() };
        RMAX_CACHE.set(map.data, entry);
    }
    const thresh = snapOn ? Math.round(tau * 65535) : 0;
    const key = `${W}x${H}:${m.join(",")}:${snapOn ? 1 : 0}:${thresh}`;
    let stats = entry.stats.get(key);
    if (!stats) {
        if (snapOn && !entry.rmax) entry.rmax = rangeMax(map);
        stats = mapTileStats(map, snapOn ? entry.rmax : null, m, W, H, tau, 256);
        entry.stats.set(key, stats);
    }
    return stats;
}

// A pixel source's identity and version as a key part, "-" for none (`belowSignature`): a source replaced by another
// (an undo, a flip, a new base) is another key even where `pixelVersion` would not tell
const SOURCE_IDS = new WeakMap();
let sourceIdSeq = 0;
function sourceTag(o) {
    if (!o || typeof o !== "object") return "-";
    let id = SOURCE_IDS.get(o);
    if (id === undefined) { id = ++sourceIdSeq; SOURCE_IDS.set(o, id); }
    return `${id}.${o.version || 0}`;
}

/**
 * What an editor has uploaded, by hash. Setting `baseHash` to null (the base or a layer that is
 * part of it changed) moves the composite version on. A class with the accessor on its prototype
 * and the editor in a non-enumerable field: the accessor closures that `makeUploaded` used to put
 * on an object literal ended up in V8's allocation site for that literal, and kept the editor they
 * closed over, a closed tab with all its pixels, alive for good.
 */
class UploadCache {
    constructor(editor) {
        this.baseRef = null;
        this.maskHash = null;
        this.maskRef = null;
        this.controlHash = null;
        this.controlRef = null;
        Object.defineProperty(this, "_editor", { value: editor, enumerable: false });
        Object.defineProperty(this, "_baseHash", { value: null, writable: true, enumerable: false });
    }

    get baseHash() { return this._baseHash; }

    set baseHash(v) {
        if (v == null) {
            const ed = this._editor;
            ed.compositeVersion++;
            // the whole flatten kept for the version before is never read again: let it go now, not when the next
            // whole flatten replaces it (a box read's fallback kept 572 MB of canvas at 15000 x 10000: the C6 c1 review)
            if (ed.flatCache && ed.flatCache.version !== ed.compositeVersion) ed.flatCache = null;
        }
        this._baseHash = v;
    }
}

/**
 * A stroke's pixels while the button is down: a canvas that covers what the gesture has
 * touched so far, grown as it goes, with its origin in the target's own pixels. It used to
 * be a canvas the size of the layer per gesture (600 MB on a 15k layer, and as much again
 * for the selection clip). `ensure(x0, y0, x1, y1)` makes the buffer hold that box and
 * hands back its context translated so callers keep drawing in target pixels; `all()` is
 * the whole target (a gradient). `canvas` is null until the first dab. The target is the
 * pixels the stroke goes into (a layer's `px`, a mask's `maskPx`); only its size is read.
 * The buffer itself stays a canvas in C1 (docs/PLAN_BCE.md §C1 rule 8).
 */
class StrokeBuffer {
    constructor(target, backend = null) {
        this.tw = target.width;
        this.th = target.height;
        // On tiles the buffer is a sparse store of the target's own size: a dab allocates the tiles it
        // touches and nothing else, so a stroke across the picture never reallocates and never holds a
        // canvas of its own bounding box (561 MB at 15000 x 10000). On canvases it stays the canvas it
        // has always been, grown around the dabs (cx, cy, cw, ch), because a store of the target's size
        // would be the whole target there.
        this.px = backend && backend.tiles ? backend.Layer.empty(this.tw, this.th) : null;
        this.canvas = null;
        this.cx = 0; this.cy = 0; this.cw = 0; this.ch = 0;
        // the box every dab together has covered, in the target's own pixels
        this.x = 0; this.y = 0; this.w = 0; this.h = 0;
        // the cells of a STROKE_BAND grid over the target that a dab has drawn into. The buffer's
        // rectangle is the union of every dab, so on a diagonal stroke across a 15000 x 10000 picture
        // it is the whole picture while the dabs touched a few per cent of it: the commit and the
        // preview walk these cells, not that rectangle (docs/PLAN_BCE.md §C5).
        this.cells = new Set();
    }

    /** The padded rectangle a dab covers, clamped to the target; it marks its cells and widens the extent. */
    _rect(x0, y0, x1, y1) {
        // the canvas buffer grows in steps and wants headroom; the sparse store allocates exactly the
        // tiles a dab touches, and 32 px on every side of every dab is a third more work per drawInto.
        // Either way the callers pad their own box by what the brush reaches.
        const PAD = this.px ? 2 : 32;
        x0 = Math.max(0, Math.floor(x0) - PAD); y0 = Math.max(0, Math.floor(y0) - PAD);
        x1 = Math.min(this.tw, Math.ceil(x1) + PAD); y1 = Math.min(this.th, Math.ceil(y1) + PAD);
        if (x1 <= x0) x1 = Math.min(this.tw, x0 + 1);
        if (y1 <= y0) y1 = Math.min(this.th, y0 + 1);
        if (x1 <= x0 || y1 <= y0) return null;
        for (let cy = Math.floor(y0 / STROKE_BAND); cy <= Math.floor((y1 - 1) / STROKE_BAND); cy++) {
            for (let cx = Math.floor(x0 / STROKE_BAND); cx <= Math.floor((x1 - 1) / STROKE_BAND); cx++) this.cells.add(cy * 65536 + cx);
        }
        if (!this.w) { this.x = x0; this.y = y0; this.w = x1 - x0; this.h = y1 - y0; }
        else {
            const ux0 = Math.min(this.x, x0), uy0 = Math.min(this.y, y0);
            const ux1 = Math.max(this.x + this.w, x1), uy1 = Math.max(this.y + this.h, y1);
            this.x = ux0; this.y = uy0; this.w = ux1 - ux0; this.h = uy1 - uy0;
        }
        return [x0, y0, x1, y1];
    }

    /** Grow the canvas backend's buffer so it holds `r`, with headroom on the sides that grew. */
    _grow(r) {
        if (!this.canvas) {
            this.cx = r[0]; this.cy = r[1]; this.cw = r[2] - r[0]; this.ch = r[3] - r[1];
            this.canvas = makeCanvas(this.cw, this.ch);
            return;
        }
        if (r[0] >= this.cx && r[1] >= this.cy && r[2] <= this.cx + this.cw && r[3] <= this.cy + this.ch) return;
        // grow to the union, with headroom of a quarter on the sides that grew, so a stroke
        // that keeps going does not reallocate on every dab
        const ux0 = Math.min(this.cx, r[0]), uy0 = Math.min(this.cy, r[1]);
        const ux1 = Math.max(this.cx + this.cw, r[2]), uy1 = Math.max(this.cy + this.ch, r[3]);
        const gx = Math.ceil((ux1 - ux0) / 4), gy = Math.ceil((uy1 - uy0) / 4);
        const nx0 = r[0] < this.cx ? Math.max(0, ux0 - gx) : ux0, ny0 = r[1] < this.cy ? Math.max(0, uy0 - gy) : uy0;
        const nx1 = r[2] > this.cx + this.cw ? Math.min(this.tw, ux1 + gx) : ux1, ny1 = r[3] > this.cy + this.ch ? Math.min(this.th, uy1 + gy) : uy1;
        const c = makeCanvas(nx1 - nx0, ny1 - ny0);
        c.getContext("2d").drawImage(this.canvas, this.cx - nx0, this.cy - ny0);
        this.canvas = c;
        this.cx = nx0; this.cy = ny0; this.cw = nx1 - nx0; this.ch = ny1 - ny0;
    }

    /**
     * `fn(ctx)` draws in the target's own coordinates, inside the padded box of (x0, y0, x1, y1)
     * and clipped to it. On the tile backend that box is a `drawInto` of the sparse store, so the
     * buffer only ever holds the tiles a dab reached; on canvases it is the growing canvas the
     * buffer has always been. `fn` obeys the `drawInto` rules: it composes on the transform it is
     * given and never sets one, and it reads no pixels back from the context.
     */
    draw(x0, y0, x1, y1, fn) {
        const r = this._rect(x0, y0, x1, y1);
        if (!r) return undefined;
        if (this.px) return this.px.drawInto(r, fn);
        this._grow(r);
        const ctx = this.canvas.getContext("2d");
        ctx.save();
        try {
            resetContext(ctx);
            const clip = new Path2D();
            clip.rect(r[0] - this.cx, r[1] - this.cy, r[2] - r[0], r[3] - r[1]);
            ctx.clip(clip);
            ctx.translate(-this.cx, -this.cy);
            return fn(ctx);
        } finally {
            ctx.restore();
        }
    }

    /** The whole target, for a gesture that rebuilds itself on every move (the gradient tool). */
    all(fn) { return this.draw(0, 0, this.tw, this.th, fn); }

    /** Nothing has been drawn into the buffer yet. */
    get empty() { return !this.cells.size; }

    /**
     * The buffer's pixels over (x, y, w, h), target pixels, as ImageData, transparent wherever the buffer has none. On
     * canvases only the part inside the buffer's canvas is read: Chromium's first `getImageData` of a GPU canvas returned
     * alpha, mostly 255, for pixels outside it (the heal's box reaches a pixel past the buffer; 2026-09-28, the patch step).
     */
    bytes(x, y, w, h) {
        if (this.px) return this.px.readRect(x, y, w, h);
        const out = new ImageData(w, h);
        if (!this.canvas) return out;
        const x0 = Math.max(x, this.cx), y0 = Math.max(y, this.cy), x1 = Math.min(x + w, this.cx + this.cw), y1 = Math.min(y + h, this.cy + this.ch);
        if (x1 <= x0 || y1 <= y0) return out;
        const got = this.canvas.getContext("2d").getImageData(x0 - this.cx, y0 - this.cy, x1 - x0, y1 - y0).data, rw = (x1 - x0) * 4;
        for (let yy = y0; yy < y1; yy++) out.data.set(got.subarray((yy - y0) * rw, (yy - y0 + 1) * rw), ((yy - y) * w + (x0 - x)) * 4);
        return out;
    }

    /** A canvas holding the buffer's pixels of [x0, y0, x1, y1] (target pixels) and where its (0, 0) sits. */
    part(x0, y0, x1, y1) {
        if (this.px) return { canvas: this.px.toCanvas([x0, y0, x1, y1]), x: x0, y: y0 };
        return this.canvas ? { canvas: this.canvas, x: this.cx, y: this.cy } : null;
    }

    /** The whole buffer over the image rectangle it covers, into a context carrying the image transform. */
    drawOver(ed, ctx, layer, target, vp) {
        if (this.px) { ed.drawTilesInto(ctx, this.px, layer.x, layer.y, layer.w, layer.h, vp); return; }
        if (!this.canvas) return;
        const fx = layer.w / target.width, fy = layer.h / target.height;
        ctx.drawImage(this.canvas, layer.x + this.cx * fx, layer.y + this.cy * fy, this.cw * fx, this.ch * fy);
    }

    /** Give the tile store's display caches back when the gesture ends. */
    release() { if (this.px) this.px.releaseDisplay(); }
}

export { STROKE_BAND, STROKE_SCRATCH_KEEP_PX, StrokeBuffer, UploadCache, cachedMapTileStats, sourceTag };
