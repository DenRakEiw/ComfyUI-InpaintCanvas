// Generated from DenRakEiw/scumble renderer/editor/inpaint_tiles.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The tile store: the second backend of `LayerPixels` / `MaskPixels` (docs/PLAN_BCE.md §C2,
 * "C2 as built"). The same methods, argument forms and results as the canvas backend in
 * inpaint_pixels.js, over 256 × 256 tiles of straight-alpha RGBA8 in renderer memory instead of
 * one canvas. `pixelsBackend(tiles)` hands out the classes of either backend.
 *
 * What a caller has to know beyond the rules at the top of inpaint_pixels.js:
 * - Sparse: a missing tile reads as transparent, a write allocates what it touches, and a tile
 *   whose alpha is all zero after a write is dropped. `bytes()` counts allocated tiles.
 * - `clone()` shares every tile (copy on write): a tile is copied by the first write into it
 *   from any holder but the last one (`writable`), once per writer.
 * - Every write that is not a plain byte copy (drawInto, writeRect with an operation or an
 *   alpha, blit, fill with a non-string style) goes through a scratch of the rectangle: an
 *   OffscreenCanvas with a `willReadFrequently` context, which Chromium rasterises on the CPU and
 *   keeps there (a `willReadFrequently` <canvas> is moved to the GPU for good once a GPU canvas
 *   is drawn into it; measured in C2). Every canvas this module makes itself (a writeRect source,
 *   a blit source, `toCanvas`, the display mirror) is a CPU canvas too, whatever
 *   `setPixelsOptions` says. The canvas backend's canvases are rasterised on the GPU unless
 *   `setPixelsOptions({ software: true })`, and anti-aliased edges, gradients and resampling then
 *   differ (tens of levels, and any amount of un-premultiplied colour where alpha is near zero).
 *   On the CPU both backends agree to the byte, except where Skia does not rasterise exactly
 *   translation-invariantly (the scratch's origin is the rect's origin): gradients, resampled
 *   images, and the anti-aliased edges of curves and strokes, by up to tens of alpha levels
 *   (docs/PLAN_BCE.md §C2 "C2 as built"). The scratch clips without anti-aliasing: a drawInto
 *   callback clips to whole pixels only (the rules at the top of inpaint_pixels.js).
 * - Side limits: a scratch, a materialised canvas or the mirror above 65,535 px a side or 268 MP
 *   is refused with an Error (Chromium makes such a canvas without complaint and draws nothing).
 * - Bytes that enter without a canvas (writeRect "copy", fromImageData) go through the round
 *   trip a canvas applies to straight alpha (premultiply, un-premultiply), measured once from a
 *   canvas, so a read gives back what the canvas backend gives back.
 * - `canvasOf()` is a display mirror, one CPU canvas per pixels object synced from the tiles written
 *   since the last call, until C3 draws tiles (the editor's screen draws a GPU copy of it);
 *   `thumbnailCanvas()` is a small one for thumbnails that never makes the mirror.
 * - No module-level side effects: nothing touches the page until pixels are made.
 */

import { LayerPixels, MaskPixels, pixelRect, WHOLE_CANVAS_OPS, BLIT_MARGIN, reentrantPixels } from "./inpaint_pixels.js";
import { mipChain, mipChainBytes } from "./px/kernels_js.js";

export const TILE_SIZE = 256;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
/** 65,536 tiles a side: the key is (ty << 16) | tx. */
export const TILE_MAX_SIDE = 16777216;
/** Chromium's canvas area limit: a scratch or a materialised canvas above it cannot exist. */
export const CANVAS_MAX_PIXELS = 268435456;
/** Chromium's canvas side limit: a canvas of 65,536 px a side exists but draws and reads nothing (measured). */
export const CANVAS_MAX_SIDE = 65535;
/** Mips per tile: 128, 64, 32, 16, 8 px. */
export const MIP_LEVELS = 5;
const STRIP_W = 4096;              // fromImage / fromCanvas: strips 4096 wide ...
// ... and 4096 rows high for fromImage (fromCanvas reads 256 rows at a time): an image of at most 4096 px
// a side is one untranslated draw, byte for byte the canvas backend's; in 256-row strips a scaled image
// came out a few bytes apart (docs/PLAN_BCE.md §C2 "C2 as built")
const DECODE_ROWS = 4096;
const BLOCK = 4096;                // a big scratch is read back in blocks of this side
const DISPLAY_RECT_MAX_PX = 4 * 1024 * 1024;   // displayRectSource: above this the mirror is the source
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const ALPHA = 0x1000000;           // a word >= this has a non-zero alpha byte (little-endian)

let tileSeq = 0;                   // tile versions are unique across all tiles

function newTile() {
    return {
        data: new Uint8ClampedArray(TILE_BYTES),   // its own ArrayBuffer: starts on a page (§B3, 4K aliasing)
        version: ++tileSeq,
        mips: null, mipsVersion: -1,
        ext: null, extVersion: -1,
        frozen: 0,                                 // how many other pixels objects hold this tile
        _img: null, _u32: null,
    };
}

const u32Of = (t) => t._u32 || (t._u32 = new Uint32Array(t.data.buffer));
const imageDataOf = (t) => t._img || (t._img = new ImageData(t.data, TILE_SIZE, TILE_SIZE));
let ZERO_IMAGE = null;
const zeroImage = () => ZERO_IMAGE || (ZERO_IMAGE = new ImageData(TILE_SIZE, TILE_SIZE));
let THUMB_MIPS = null;             // thumbnailCanvas: the mips of a tile whose own are not cached
const thumbScratch = () => THUMB_MIPS || (THUMB_MIPS = new Uint8Array(mipChainBytes(TILE_SIZE, MIP_LEVELS)));

const LONG_MIN = -2147483648, LONG_MAX = 2147483647;

/**
 * An argument of getImageData / putImageData as Chromium converts it: a WebIDL `[EnforceRange] long`
 * (a TypeError for NaN, an infinity or a value outside the 32-bit range; fractions truncated).
 */
function enforceLong(v) {
    if (typeof v === "bigint") throw new TypeError("Value is not of type 'long'.");
    const n = Number(v);
    if (Number.isNaN(n)) throw new TypeError("Value is not of type 'long'.");
    if (!Number.isFinite(n)) throw new TypeError("Value is infinite and not of type 'long'.");
    const t = Math.trunc(n);
    if (t < LONG_MIN || t > LONG_MAX) throw new TypeError("Value is outside the 'long' value range.");
    return t + 0;   // no -0
}

const outOfMemory = () => new RangeError("Out of memory at ImageData creation");

/** A canvas of w x h must be possible: Chromium's side and area limits, as a named Error. */
function checkCanvas(w, h, what, beyond = "") {
    if (w > CANVAS_MAX_SIDE || h > CANVAS_MAX_SIDE) {
        throw new Error(`Inpaint Canvas: ${what} of ${w} × ${h} px is above Chromium's canvas limit of 65,535 px a side${beyond}`);
    }
    if (w * h > CANVAS_MAX_PIXELS) {
        throw new Error(`Inpaint Canvas: ${what} of ${w} × ${h} px is above Chromium's canvas limit of 268 MP${beyond}`);
    }
}

/**
 * A <canvas> the module fills itself (putImageData only) and hands on as a source or a view: a
 * `willReadFrequently` context, so it is rasterised on the CPU whatever `setPixelsOptions` says.
 * Nothing is ever drawn into it, which is what would move it to the GPU.
 */
function cpuCanvas(w, h, what = "a canvas", beyond = "") {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    checkCanvas(w, h, what, beyond);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d", { willReadFrequently: true });
    return c;
}

function words(bytes) {
    return LITTLE && bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2) : null;
}

// ---- the straight-alpha round trip of a canvas ---------------------------------------------------

let ROUND_TRIP = null;

/**
 * T[(a << 8) | c]: the channel value a canvas gives back for straight (c, a) put into it. Measured
 * from a CPU canvas (a GPU canvas's first read un-premultiplies 450 of the 65,536 pairs one level
 * differently; its later reads agree with this table).
 */
function roundTripTable() {
    if (ROUND_TRIP) return ROUND_TRIP;
    const c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = new ImageData(256, 256);
    for (let a = 0; a < 256; a++) {
        for (let v = 0; v < 256; v++) {
            const i = (a * 256 + v) * 4;
            img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = a;
        }
    }
    ctx.putImageData(img, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const t = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) t[i] = d[i * 4];
    c.width = 1; c.height = 1;
    ROUND_TRIP = t;
    return t;
}

/** The round trip applied to a block of a tile in place (w x h at lx, ly). */
function normalizeBlock(d, lx, ly, w, h) {
    const t = roundTripTable();
    for (let y = 0; y < h; y++) {
        for (let i = ((ly + y) * TILE_SIZE + lx) * 4, e = i + w * 4; i < e; i += 4) {
            const a = d[i + 3];
            if (a === 255) continue;
            const o = a << 8;
            d[i] = t[o | d[i]]; d[i + 1] = t[o | d[i + 1]]; d[i + 2] = t[o | d[i + 2]];
        }
    }
}

const COLORS = new Map();

/** A CSS colour as a fill of cleared pixels reads back: [r, g, b, a]. */
function probeColor(color) {
    let rgba = COLORS.get(color);
    if (rgba) return rgba;
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    rgba = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    if (COLORS.size > 64) COLORS.clear();
    COLORS.set(color, rgba);
    return rgba;
}

// ---- block helpers -------------------------------------------------------------------------------

/** Is the alpha of the w x h block at (sx, sy) of an RGBA buffer `srcW` wide all zero? */
function blockAlphaZero(src, s32, srcW, sx, sy, w, h) {
    if (s32) {
        for (let y = 0; y < h; y++) {
            for (let i = (sy + y) * srcW + sx, e = i + w; i < e; i++) if (s32[i] >= ALPHA) return false;
        }
        return true;
    }
    for (let y = 0; y < h; y++) {
        for (let i = ((sy + y) * srcW + sx) * 4 + 3, e = i + w * 4; i < e; i += 4) if (src[i]) return false;
    }
    return true;
}

/** Does the block of a tile at (lx, ly) hold the same bytes as the block of `src` at (sx, sy)? */
function blockEqual(t, src, s32, srcW, sx, sy, lx, ly, w, h) {
    const d = t.data;
    if (s32 && LITTLE) {
        const t32 = u32Of(t);
        for (let y = 0; y < h; y++) {
            let j = (ly + y) * TILE_SIZE + lx;
            for (let i = (sy + y) * srcW + sx, e = i + w; i < e; i++, j++) if (s32[i] !== t32[j]) return false;
        }
        return true;
    }
    for (let y = 0; y < h; y++) {
        let j = ((ly + y) * TILE_SIZE + lx) * 4;
        for (let i = ((sy + y) * srcW + sx) * 4, e = i + w * 4; i < e; i++, j++) if (src[i] !== d[j]) return false;
    }
    return true;
}

function tileEmpty(t) {
    if (LITTLE) {
        const a = u32Of(t);
        for (let i = 0; i < a.length; i++) if (a[i] >= ALPHA) return false;
        return true;
    }
    const d = t.data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
}

/** The exact non-transparent extent of a tile in its own pixels, cached by its version. */
function tileExtent(t) {
    if (t.extVersion === t.version) return t.ext;
    const d = t.data;
    const alphaAt = LITTLE ? ((a) => (i) => a[i] >= ALPHA)(u32Of(t)) : (i) => d[i * 4 + 3] !== 0;
    let x0 = TILE_SIZE, y0 = -1, x1 = -1, y1 = -1;
    for (let y = 0; y < TILE_SIZE; y++) {
        const row = y * TILE_SIZE;
        let first = -1;
        for (let x = 0; x < TILE_SIZE; x++) if (alphaAt(row + x)) { first = x; break; }
        if (first < 0) continue;
        if (y0 < 0) y0 = y;
        y1 = y;
        if (first < x0) x0 = first;
        for (let x = TILE_SIZE - 1; x > x1; x--) if (alphaAt(row + x)) { x1 = x; break; }
    }
    t.ext = y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    t.extVersion = t.version;
    return t.ext;
}

// ---- the scratch pool ----------------------------------------------------------------------------

const POOL = new Map();            // size class "wxh" -> free scratches
const POOL_PER_CLASS = 2;
const POOL_MAX_CLASS = 4096 * 4096;
const POOL_MAX_SIDE = 32768;       // a class of 65,536 px a side is above the side limit: exact sizes there
const POOL_MAX_TOTAL = 64 * 1024 * 1024;
let poolPixels = 0;
const SCRATCH_STATS = { created: 0, reused: 0, unpooled: 0, flipped: 0 };
let PROBE = null;

const sizeClass = (n) => { let s = 64; while (s < n) s <<= 1; return s; };

/** Clear a scratch and give its context a fresh context's state, save stack and path included. */
function resetScratch(s) {
    if (typeof s.ctx.reset === "function") s.ctx.reset();
    else { s.canvas.width = s.canvas.width; }   // assigning the width resets bitmap and state
}

/**
 * A scratch of at least w x h. An OffscreenCanvas with a `willReadFrequently` context: a
 * `willReadFrequently` <canvas> that has a GPU canvas drawn into it (a stroke buffer, a plain
 * canvas, an ImageBitmap of one, WebGL) is rasterised on the GPU from then on, reset or not,
 * which rounds untouched low-alpha pixels differently and changes every later draw (measured);
 * an OffscreenCanvas stays on the CPU. It clips without anti-aliasing, the one difference
 * measured against a CPU <canvas> (fonts, filters, shadows, patterns, gradients, images agree).
 */
function acquireScratch(w, h, what = "a draw") {
    checkCanvas(w, h, what);
    let cw = sizeClass(w), ch = sizeClass(h);
    const pooled = cw <= POOL_MAX_SIDE && ch <= POOL_MAX_SIDE && cw * ch <= POOL_MAX_CLASS;
    if (!pooled) { cw = w; ch = h; }
    const key = cw + "x" + ch;
    const list = pooled ? POOL.get(key) : null;
    let s = list && list.pop();
    if (s) {
        poolPixels -= cw * ch;
        SCRATCH_STATS.reused++;
    } else {
        let canvas;
        if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(cw, ch);
        else { canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch; }
        s = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), key, pooled, area: cw * ch };
        SCRATCH_STATS[pooled ? "created" : "unpooled"]++;
    }
    resetScratch(s);
    return s;
}

/** Is the scratch still rasterised on the CPU? (212, 24) reads back as 212 there and as 213 from a GPU canvas. */
function scratchOnCpu(s) {
    if (!PROBE) {
        PROBE = new ImageData(1, 1);
        PROBE.data[0] = 212; PROBE.data[3] = 24;
    }
    s.ctx.putImageData(PROBE, 0, 0);   // ignores whatever state the last use left
    return s.ctx.getImageData(0, 0, 1, 1).data[0] === 212;
}

function releaseScratch(s, reusable = true) {
    if (s.pooled && reusable && !scratchOnCpu(s)) {   // a guard: never measured with an OffscreenCanvas
        SCRATCH_STATS.flipped++;
        reusable = false;
    }
    if (!s.pooled || !reusable) { s.canvas.width = 1; s.canvas.height = 1; return; }
    const list = POOL.get(s.key) || [];
    if (list.length >= POOL_PER_CLASS || poolPixels + s.area > POOL_MAX_TOTAL) { s.canvas.width = 1; s.canvas.height = 1; return; }
    list.push(s);
    POOL.set(s.key, list);
    poolPixels += s.area;
}

/** The scratch pool's counters and the free canvases per size class (tests, memoryReport). */
export function scratchStats() {
    const free = {};
    for (const [k, list] of POOL) if (list.length) free[k] = list.length;
    return { ...SCRATCH_STATS, free, poolPixels };
}

// ---- the backend ---------------------------------------------------------------------------------

function checkSize(w, h) {
    if (w > TILE_MAX_SIDE || h > TILE_MAX_SIDE) {
        throw new Error(`Inpaint Canvas: ${w} × ${h} px is above the tile store's limit of 16,777,216 px a side`);
    }
    return [Math.max(1, w | 0), Math.max(1, h | 0)];
}

const tiled = (Base) => class extends Base {
    /** `new (w, h)`: transparent pixels without a tile; `new (canvas)`: the canvas read in strips. */
    constructor(w = 1, h = 1) {
        super(null);
        const canvas = w && typeof w === "object" ? w : null;
        const size = canvas ? checkSize(canvas.width, canvas.height) : checkSize(w, h);
        this._w = size[0];
        this._h = size[1];
        this._tiles = new Map();
        this._version = 0;
        this._mirror = null;
        this._mirrorDirty = null;
        this._thumb = null;
        if (canvas) this._readCanvas(canvas);
    }

    static get backend() { return TILE_BACKEND; }

    static empty(w, h) { return new this(w, h); }

    /** The canvas's pixels, read in strips; the canvas is not kept (unlike the canvas backend). */
    static fromCanvas(canvas) { return new this(canvas); }

    static fromImageData(data) {
        const p = new this(data.width, data.height);
        p.writeRect(data, 0, 0);
        return p;
    }

    /** An <img>, ImageBitmap or canvas drawn at w x h, decoded in strips through one scratch. */
    static fromImage(img, w, h) {
        const p = new this(w || img.naturalWidth || img.width, h || img.naturalHeight || img.height);
        const W = p._w, H = p._h;
        // every strip draws the whole image translated by the strip's origin, so every pixel is
        // resampled exactly as in the canvas backend's one draw
        p._strips((ctx, sx, sy) => ctx.drawImage(img, -sx, -sy, W, H));
        return p;
    }

    get width() { return this._w; }

    get height() { return this._h; }

    get version() { return this._version; }

    get tileCount() { return this._tiles.size; }

    /** The tile store has no context of its own: a call here is a missed override. */
    _context() { throw new Error("Inpaint Canvas: tile pixels have no canvas context"); }

    bytes() { return this._tiles.size * TILE_BYTES; }

    touch(rect = null) {
        this._version++;
        if (this._mirror) this._mirror._dispVer = this._version;
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return;
        for (const key of this._keysIn(r)) this._tiles.get(key).version = ++tileSeq;
    }

    // -- tiles --

    /** The tile at (tx, ty), made writable: allocated when missing (with `create`), copied when shared. */
    writable(tx, ty, create = true) {
        this._guard();
        const key = (ty << 16) | tx;
        let t = this._tiles.get(key);
        if (!t) {
            if (!create) return null;
            t = newTile();
            this._tiles.set(key, t);
        } else if (t.frozen > 0) {
            t.frozen--;
            const c = newTile();
            c.data.set(t.data);
            this._tiles.set(key, c);
            t = c;
        } else {
            t.version = ++tileSeq;
        }
        this._changed(key);
        return t;
    }

    /** The tile at (tx, ty) for reading (null when missing). Never write into it: use `writable`. */
    tileAt(tx, ty) { this._guard(); return this._tiles.get((ty << 16) | tx) || null; }

    /** The tile keys, (ty << 16) | tx. */
    tileKeys() { this._guard(); return Array.from(this._tiles.keys()); }

    /** The five mips of a tile (128 to 8 px, one after the other), built lazily by the kernel. */
    mips(tx, ty) {
        this._guard();
        const t = this._tiles.get((ty << 16) | tx);
        if (!t) return null;
        if (t.mipsVersion !== t.version) {
            t.mips = mipChain(t.data, TILE_SIZE, MIP_LEVELS, t.mips || new Uint8Array(mipChainBytes(TILE_SIZE, MIP_LEVELS)));
            t.mipsVersion = t.version;
        }
        return t.mips;
    }

    _changed(key) {
        if (this._mirrorDirty) this._mirrorDirty.add(key);
        if (this._thumb) this._thumb.dirty.add(key);
    }

    _dropTile(key) {
        const t = this._tiles.get(key);
        if (!t) return;
        if (t.frozen > 0) t.frozen--;
        this._tiles.delete(key);
        this._changed(key);
    }

    _share(key, t) {
        const old = this._tiles.get(key);
        if (old === t) return;
        if (old && old.frozen > 0) old.frozen--;
        t.frozen++;
        this._tiles.set(key, t);
        this._changed(key);
    }

    /** Keys of the allocated tiles that overlap r (whichever is fewer to walk: the grid or the map). */
    _keysIn(r) {
        const tx0 = r[0] >> 8, ty0 = r[1] >> 8, tx1 = (r[2] - 1) >> 8, ty1 = (r[3] - 1) >> 8;
        const out = [];
        if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= this._tiles.size) {
            for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                    const key = (ty << 16) | tx;
                    if (this._tiles.has(key)) out.push(key);
                }
            }
        } else {
            for (const key of this._tiles.keys()) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) out.push(key);
            }
        }
        return out;
    }

    /** Does the block [ix0, ix1) x [iy0, iy1) cover everything of the tile at (ox, oy) inside the pixels? */
    _coversTile(ox, oy, ix0, iy0, ix1, iy1) {
        return ix0 === ox && iy0 === oy && ix1 === Math.min(ox + TILE_SIZE, this._w) && iy1 === Math.min(oy + TILE_SIZE, this._h);
    }

    // -- bytes in and out --

    readRect(x, y, w, h) {
        this._guard();
        // getImageData's argument checks, in its order: conversion, a zero size, the checked int arithmetic
        x = enforceLong(x); y = enforceLong(y); w = enforceLong(w); h = enforceLong(h);
        if (!w || !h) throw new DOMException(`The source ${w ? "height" : "width"} is 0.`, "IndexSizeError");
        if (w * h < LONG_MIN || w * h > LONG_MAX) throw outOfMemory();
        if (w < 0) { if (w === LONG_MIN || x + w < LONG_MIN) throw outOfMemory(); x += w; w = -w; }
        if (h < 0) { if (h === LONG_MIN || y + h < LONG_MIN) throw outOfMemory(); y += h; h = -h; }
        if (x + w > LONG_MAX || y + h > LONG_MAX) throw outOfMemory();
        let out;
        try { out = new ImageData(w, h); } catch (_) { throw outOfMemory(); }
        const r = pixelRect([x, y, x + w, y + h], this._w, this._h);
        if (!r) return out;
        const dst = out.data;
        for (const key of this._keysIn(r)) {
            const t = this._tiles.get(key);
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            const n = (ix1 - ix0) * 4;
            for (let yy = iy0; yy < iy1; yy++) {
                const so = ((yy - oy) * TILE_SIZE + (ix0 - ox)) * 4;
                dst.set(t.data.subarray(so, so + n), ((yy - y) * w + (ix0 - x)) * 4);
            }
        }
        return out;
    }

    /**
     * The w x h block of `src` (RGBA, `srcW` wide) at (sx, sy) into the pixels at (dx, dy), replacing
     * what was there; the block lies inside both. `normalize`: the bytes did not come from a canvas
     * and get its round trip. Unchanged tiles are left alone (no copy, no version); a block of zero
     * alpha allocates nothing, and a tile it leaves empty is dropped.
     */
    _putBlock(src, srcW, sx, sy, dx, dy, w, h, normalize) {
        const s32 = words(src);
        const x1 = dx + w, y1 = dy + h;
        for (let ty = dy >> 8; ty <= (y1 - 1) >> 8; ty++) {
            for (let tx = dx >> 8; tx <= (x1 - 1) >> 8; tx++) {
                const key = (ty << 16) | tx, ox = tx << 8, oy = ty << 8;
                const ix0 = Math.max(dx, ox), ix1 = Math.min(x1, ox + TILE_SIZE);
                const iy0 = Math.max(dy, oy), iy1 = Math.min(y1, oy + TILE_SIZE);
                const bw = ix1 - ix0, bh = iy1 - iy0, bsx = sx + ix0 - dx, bsy = sy + iy0 - dy;
                const lx = ix0 - ox, ly = iy0 - oy;
                const old = this._tiles.get(key);
                const zero = blockAlphaZero(src, s32, srcW, bsx, bsy, bw, bh);
                if (!old) { if (zero) continue; }
                else if (zero && this._coversTile(ox, oy, ix0, iy0, ix1, iy1)) { this._dropTile(key); continue; }
                else if (!normalize && blockEqual(old, src, s32, srcW, bsx, bsy, lx, ly, bw, bh)) continue;
                const t = this.writable(tx, ty);
                const n = bw * 4;
                for (let yy = 0; yy < bh; yy++) {
                    const so = ((bsy + yy) * srcW + bsx) * 4;
                    t.data.set(src.subarray(so, so + n), ((ly + yy) * TILE_SIZE + lx) * 4);
                }
                if (normalize) normalizeBlock(t.data, lx, ly, bw, bh);
                if (zero && tileEmpty(t)) this._dropTile(key);
            }
        }
    }

    writeRect(data, x, y, op = "copy", alpha = 1) {
        this._guard();
        const img = data instanceof ImageData ? data : new ImageData(data.data, data.width, data.height);
        if (op === "copy" && alpha === 1) {
            x = enforceLong(x); y = enforceLong(y);   // putImageData's conversion
            const r = pixelRect([x, y, x + img.width, y + img.height], this._w, this._h);
            if (r) this._putBlock(img.data, img.width, r[0] - x, r[1] - y, r[0], r[1], r[2] - r[0], r[3] - r[1], true);
            return;
        }
        const src = cpuCanvas(img.width, img.height, "a writeRect source");   // as the canvas backend makes its source, on the CPU
        src.getContext("2d").putImageData(img, 0, 0);
        try {
            this._drawOp(src, 0, 0, img.width, img.height, x, y, op, alpha);
        } finally {
            src.width = 1; src.height = 1;
        }
    }

    // -- the scratch path --

    /** Put the tiles over r into a scratch context whose (0, 0) is r's origin. */
    _fillScratch(ctx, r) {
        for (const key of this._keysIn(r)) {
            const t = this._tiles.get(key);
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            ctx.putImageData(imageDataOf(t), ox - r[0], oy - r[1], ix0 - ox, iy0 - oy, ix1 - ix0, iy1 - iy0);
        }
    }

    /**
     * `fn(ctx)` on a scratch of r (whole pixels, inside these pixels) filled from the tiles, with a
     * fresh context's state, clipped to r when the scratch is bigger and translated by -r's origin;
     * then the scratch is written back with "copy" inside r. Returns what `fn` returns.
     */
    _scratchDraw(r, fn) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const s = acquireScratch(rw, rh, "a draw");
        const ctx = s.ctx;
        let filled = false, reusable = true;
        try {
            this._fillScratch(ctx, r);
            filled = true;
            if (s.canvas.width > rw || s.canvas.height > rh) {
                const clip = new Path2D();
                clip.rect(0, 0, rw, rh);
                ctx.clip(clip);
            }
            ctx.translate(-r[0], -r[1]);
            let back;
            this._drawing++;
            try {
                back = fn(ctx);
            } finally {
                this._drawing--;
            }
            if (back && typeof back.then === "function") {
                // what fn draws after an await would land in a scratch that is no longer ours
                reusable = false;
                throw new Error("Inpaint Canvas: a drawInto callback must be synchronous");
            }
            return back;
        } finally {
            try {
                // written back also when fn threw, as the canvas backend keeps what fn drew before
                if (filled) {
                    for (let by = 0; by < rh; by += BLOCK) {
                        for (let bx = 0; bx < rw; bx += BLOCK) {
                            const bw = Math.min(BLOCK, rw - bx), bh = Math.min(BLOCK, rh - by);
                            const img = ctx.getImageData(bx, by, bw, bh);
                            this._putBlock(img.data, bw, 0, 0, r[0] + bx, r[1] + by, bw, bh, false);
                        }
                    }
                }
            } finally {
                releaseScratch(s, reusable);
            }
        }
    }

    drawInto(rect, fn) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return undefined;
        return this._scratchDraw(r, fn);
    }

    /** The canvas backend's `_drawOp`, on a scratch of the destination rectangle. */
    _drawOp(source, sx, sy, sw, sh, dx, dy, op, alpha) {
        const r = pixelRect([dx, dy, dx + sw, dy + sh], this._w, this._h);
        if (!r) return;
        this._scratchDraw(r, (ctx) => {
            ctx.globalAlpha = alpha;
            if (op === "copy") {
                ctx.globalCompositeOperation = "source-over";
                ctx.clearRect(dx, dy, sw, sh);
            } else {
                ctx.globalCompositeOperation = op;
                if (WHOLE_CANVAS_OPS.has(op)) {   // on whole pixels, as the canvas backend clips (the scratch clips without anti-aliasing)
                    const clip = new Path2D();
                    clip.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                    ctx.clip(clip);
                }
            }
            ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh);
        });
    }

    drawTo(ctx, ...args) {
        this._guard();
        ctx.drawImage(this.canvasForDisplay(), ...args);
    }

    // -- copies between pixels --

    blit(src, dx, dy, op = "source-over", alpha = 1, srcRect = null) {
        this._guard();
        src._guard();
        const r = pixelRect(srcRect, src.width, src.height);
        if (!r) return;
        const sw = r[2] - r[0], sh = r[3] - r[1];
        if (op === "copy" && alpha === 1 && Number.isInteger(dx) && Number.isInteger(dy)) {
            if (src === this) {   // overlapping: from a copy-on-write snapshot of the source rectangle
                this.blit(this.copyRect(r), dx, dy, op, alpha);
                return;
            }
            const cx0 = Math.max(0, dx), cy0 = Math.max(0, dy);
            const cx1 = Math.min(this._w, dx + sw), cy1 = Math.min(this._h, dy + sh);
            if (cx1 <= cx0 || cy1 <= cy0) return;
            const ssx = r[0] + cx0 - dx, ssy = r[1] + cy0 - dy;
            if (src._tiles instanceof Map) {
                this._copyTiles(src, ssx, ssy, cx0, cy0, cx1 - cx0, cy1 - cy0);
            } else {
                const img = src.readRect(ssx, ssy, cx1 - cx0, cy1 - cy0);
                this._putBlock(img.data, cx1 - cx0, 0, 0, cx0, cy0, cx1 - cx0, cy1 - cy0, false);
            }
            return;
        }
        const s = src._blitSource(r, dx, dy);
        try {
            this._drawOp(s.canvas, s.sx, s.sy, sw, sh, dx, dy, op, alpha);
        } finally {
            if (s.temp) { s.canvas.width = 1; s.canvas.height = 1; }
        }
    }

    /**
     * The source rectangle of a blit as a CPU canvas, materialised with a margin of BLIT_MARGIN px
     * (2): at a whole-pixel position an unscaled draw samples nothing outside the rectangle, but Skia
     * draws a sub-rectangle of an image by another path than a whole image (measured, 2,531 bytes of
     * up to 4 levels at an alpha of 0.35 without a margin); a fractional position samples the
     * neighbours, as a draw from the whole canvas does. (The display mirror, which fractional blits
     * drew from before, is a whole-layer canvas.) `temp`: the caller frees it after the draw.
     */
    _blitSource(r, dx, dy) {
        const m = pixelRect([r[0] - BLIT_MARGIN, r[1] - BLIT_MARGIN, r[2] + BLIT_MARGIN, r[3] + BLIT_MARGIN], this._w, this._h);
        return { canvas: this._materialise(m), sx: r[0] - m[0], sy: r[1] - m[1], temp: true };
    }

    /** Copy w x h of tile pixels `src` at (sx, sy) to (dx, dy), inside both; whole tiles are shared. */
    _copyTiles(src, sx, sy, dx, dy, w, h) {
        for (let y = 0; y < h;) {
            const syy = sy + y, dyy = dy + y;
            const bh = Math.min(h - y, TILE_SIZE - (syy & 255), TILE_SIZE - (dyy & 255));
            for (let x = 0; x < w;) {
                const sxx = sx + x, dxx = dx + x;
                const bw = Math.min(w - x, TILE_SIZE - (sxx & 255), TILE_SIZE - (dxx & 255));
                this._copyTileBlock(src, sxx, syy, dxx, dyy, bw, bh);
                x += bw;
            }
            y += bh;
        }
    }

    _copyTileBlock(src, sx, sy, dx, dy, bw, bh) {
        const stx = sx >> 8, sty = sy >> 8, dtx = dx >> 8, dty = dy >> 8;
        const skey = (sty << 16) | stx, dkey = (dty << 16) | dtx;
        const st = src._tiles.get(skey), dt = this._tiles.get(dkey);
        const slx = sx & 255, sly = sy & 255, dlx = dx & 255, dly = dy & 255;
        // a whole tile on both sides (or everything up to both pixels' edges): share it
        if (slx === 0 && sly === 0 && dlx === 0 && dly === 0
            && (bw === TILE_SIZE || (sx + bw === src._w && dx + bw === this._w))
            && (bh === TILE_SIZE || (sy + bh === src._h && dy + bh === this._h))) {
            if (st) this._share(dkey, st);
            else if (dt) this._dropTile(dkey);
            return;
        }
        const n = bw * 4;
        if (!st) {
            if (!dt || blockAlphaZero(dt.data, words(dt.data), TILE_SIZE, dlx, dly, bw, bh)) return;
            const t = this.writable(dtx, dty);
            for (let y = 0; y < bh; y++) {
                const o = ((dly + y) * TILE_SIZE + dlx) * 4;
                t.data.fill(0, o, o + n);
            }
            if (tileEmpty(t)) this._dropTile(dkey);
            return;
        }
        const zero = blockAlphaZero(st.data, words(st.data), TILE_SIZE, slx, sly, bw, bh);
        if (!dt ? zero : blockEqual(dt, st.data, words(st.data), TILE_SIZE, slx, sly, dlx, dly, bw, bh)) return;
        const t = this.writable(dtx, dty);
        for (let y = 0; y < bh; y++) {
            const so = ((sly + y) * TILE_SIZE + slx) * 4;
            t.data.set(st.data.subarray(so, so + n), ((dly + y) * TILE_SIZE + dlx) * 4);
        }
        if (zero && tileEmpty(t)) this._dropTile(dkey);
    }

    copyRect(rect) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return null;
        const out = new this.constructor(r[2] - r[0], r[3] - r[1]);
        out._copyTiles(this, r[0], r[1], 0, 0, r[2] - r[0], r[3] - r[1]);
        return out;
    }

    clone() {
        this._guard();
        const out = new this.constructor(this._w, this._h);
        for (const [key, t] of this._tiles) {
            t.frozen++;
            out._tiles.set(key, t);
        }
        return out;
    }

    resized(w, h, { x = 0, y = 0 } = {}) {
        this._guard();
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            // no call site passes a fractional offset (extend and crop round theirs); the canvas
            // backend resamples one, so its draw is repeated on a materialised canvas (CPU into CPU)
            const c = cpuCanvas(w, h, "a resized canvas"), from = this.toCanvas();
            c.getContext("2d").drawImage(from, x, y);
            from.width = 1; from.height = 1;
            const out = this.constructor.fromCanvas(c);
            c.width = 1; c.height = 1;
            return out;
        }
        const out = new this.constructor(w, h);
        const dx0 = Math.max(0, x), dy0 = Math.max(0, y);
        const dx1 = Math.min(out._w, x + this._w), dy1 = Math.min(out._h, y + this._h);
        if (dx1 > dx0 && dy1 > dy0) out._copyTiles(this, dx0 - x, dy0 - y, dx0, dy0, dx1 - dx0, dy1 - dy0);
        return out;
    }

    // -- canvases out --

    /** A new canvas of r filled from the tiles. */
    _materialise(r) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const c = cpuCanvas(rw, rh, "a canvas", "; pixels that large cannot become one canvas (exports stream them per band, docs/PLAN_BCE.md §E2)");
        this._fillScratch(c.getContext("2d"), r);
        return c;
    }

    /** Always a new CPU canvas (of `rect`, or everything); refused above the canvas limits. Read-only for callers. */
    toCanvas(rect = null) {
        this._guard();
        if (!rect) return this._materialise([0, 0, this._w, this._h]);
        const r = pixelRect(rect, this._w, this._h);
        return r ? this._materialise(r) : cpuCanvas(1, 1);
    }

    /**
     * The display mirror: one canvas for the life of these pixels, synced from the tiles written
     * since the last call; its `_dispVer` is `version` (set by `touch()`). Read-only for callers (the
     * next sync overwrites what they draw). It is a CPU canvas, marked `_cpuMirror`: the editor's
     * screen draws a GPU copy of it (`displaySource`). C3 draws tiles and deletes it.
     */
    canvasForDisplay() {
        this._guard();
        if (!this._mirror) {
            const c = cpuCanvas(this._w, this._h, "a display canvas", " (C3 draws tiles)");
            // A plain value that touch() sets again, never an accessor on these pixels: a closure would keep
            // the pixels and every tile alive for as long as anything holds the canvas (the compositor's
            // texture map keys on it), long after a flip or a transform replaced them (C2 step b's review).
            c._dispVer = this._version;
            c._cpuMirror = true;
            this._mirror = c;
            this._mirrorDirty = new Set(this._tiles.keys());
        }
        if (this._mirrorDirty.size) {
            // putImageData ignores the context's state (transform, clip, alpha), so a caller that
            // left some on the mirror's context cannot bend the sync
            const ctx = this._mirror.getContext("2d");
            for (const key of this._mirrorDirty) {
                const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
                const t = this._tiles.get(key);
                ctx.putImageData(t ? imageDataOf(t) : zeroImage(), ox, oy, 0, 0, Math.min(TILE_SIZE, this._w - ox), Math.min(TILE_SIZE, this._h - oy));
            }
            this._mirrorDirty.clear();
        }
        return this._mirror;
    }

    /**
     * The rectangle of the pixels as a CPU canvas of its own, for the display pyramid's rectangle
     * refresh (inpaint_pixels.js). Not the mirror: a draw from a CPU canvas into a GPU canvas takes the
     * whole source along once its content changed (measured at 8000 × 6000: the frame after each move of
     * a small selection drag spent 104 ms refreshing the level from the mirror, 0.3 ms from the rectangle).
     */
    displayRectSource(rect) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return { canvas: cpuCanvas(1, 1), x: 0, y: 0, temp: true };
        // a big rectangle costs more to materialise than the mirror's transfer (measured: a 40 MP box per
        // move of a selection drag 260 to 320 ms against about 200 ms from the mirror)
        if ((r[2] - r[0]) * (r[3] - r[1]) > DISPLAY_RECT_MAX_PX) return { canvas: this.canvasForDisplay(), x: 0, y: 0, temp: false };
        return { canvas: this._materialise(r), x: r[0], y: r[1], temp: true };
    }

    /** The display mirror if it was made, unsynced (memoryReport, releaseCaches); null otherwise. */
    displayCanvasIfMade() {
        return this._mirror;
    }

    /**
     * A small CPU canvas of these pixels for a thumbnail, never the display mirror: a layer that nothing
     * draws (a hidden one, one in a tab that is not in front) must not get a canvas as large as itself for
     * a picture of 40 px (C2 step b's review). Each tile is averaged down by the mip kernel (alpha-weighted
     * 2 × 2 steps) to (256 >> level)², the level the largest at which the long side stays at least 256 px
     * (at most MIP_LEVELS), synced from the tiles written since the last call like the mirror. A tile whose
     * mips are cached gives them; otherwise nothing is kept on the tile. Read-only for callers.
     */
    thumbnailCanvas() {
        this._guard();
        let level = 0;
        while (level < MIP_LEVELS && (Math.max(this._w, this._h) >> (level + 1)) >= TILE_SIZE) level++;
        const cell = TILE_SIZE >> level;
        let th = this._thumb;
        if (!th || th.level !== level) {
            const f = 1 << level;
            th = this._thumb = {
                level, cell, dirty: new Set(this._tiles.keys()),
                canvas: cpuCanvas(Math.ceil(this._w / f), Math.ceil(this._h / f), "a thumbnail canvas"),
                img: new ImageData(cell, cell), zero: new ImageData(cell, cell),
            };
        }
        if (th.dirty.size) {
            const ctx = th.canvas.getContext("2d");
            const at = mipChainBytes(TILE_SIZE, level - 1), n = cell * cell * 4;
            for (const key of th.dirty) {
                const t = this._tiles.get(key);
                const ox = (key & 0xFFFF) * cell, oy = (key >>> 16) * cell;
                if (!t) { ctx.putImageData(th.zero, ox, oy); continue; }
                if (!level) { ctx.putImageData(imageDataOf(t), ox, oy); continue; }
                const mips = t.mipsVersion === t.version && t.mips ? t.mips : mipChain(t.data, TILE_SIZE, level, thumbScratch());
                th.img.data.set(mips.subarray(at, at + n));
                ctx.putImageData(th.img, ox, oy);
            }
            th.dirty.clear();
        }
        return th.canvas;
    }

    /** The thumbnail canvas if it was made (memoryReport); null otherwise. */
    thumbnailCanvasIfMade() {
        return this._thumb ? this._thumb.canvas : null;
    }

    /**
     * Drop the display mirror (and the thumbnail canvas): caches of the tiles, made again (synced from
     * every tile) by the next `canvasOf` / `thumbnailCanvas`. Returns their bytes. The caller forgets what
     * it keyed on the old canvas (the pyramid, the compositor's textures); nothing else may hold it.
     */
    releaseDisplay() {
        let bytes = 0;
        const th = this._thumb;
        if (th) {
            bytes += th.canvas.width * th.canvas.height * 4;
            this._thumb = null;
            th.canvas.width = 1; th.canvas.height = 1;
        }
        const m = this._mirror;
        if (!m) return bytes;
        bytes += m.width * m.height * 4;
        this._mirror = null;
        this._mirrorDirty = null;
        m.width = 1; m.height = 1;
        return bytes;
    }

    /** The tiles, for counting (memoryReport): never write into one (use `writable`). */
    tileList() { this._guard(); return Array.from(this._tiles.values()); }

    // -- in place --

    clear(rect = null) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return;
        for (const key of this._keysIn(r)) {
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            if (this._coversTile(ox, oy, ix0, iy0, ix1, iy1)) { this._dropTile(key); continue; }
            const lx = ix0 - ox, ly = iy0 - oy, bw = ix1 - ix0, bh = iy1 - iy0;
            const old = this._tiles.get(key);
            if (blockAlphaZero(old.data, words(old.data), TILE_SIZE, lx, ly, bw, bh)) continue;
            const t = this.writable(key & 0xFFFF, key >>> 16);
            for (let y = 0; y < bh; y++) {
                const o = ((ly + y) * TILE_SIZE + lx) * 4;
                t.data.fill(0, o, o + bw * 4);
            }
            if (tileEmpty(t)) this._dropTile(key);
        }
    }

    fill(rect, color) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return;
        if (typeof color !== "string") {   // a gradient or a pattern: the canvas backend's calls on a scratch
            this._scratchDraw(r, (ctx) => {
                ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.fillStyle = color;
                ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
            });
            return;
        }
        const rgba = probeColor(color);
        if (!rgba[3]) { this.clear(r); return; }
        const word = LITTLE ? ((rgba[3] << 24) | (rgba[2] << 16) | (rgba[1] << 8) | rgba[0]) >>> 0 : 0;
        for (let ty = r[1] >> 8; ty <= (r[3] - 1) >> 8; ty++) {
            for (let tx = r[0] >> 8; tx <= (r[2] - 1) >> 8; tx++) {
                const ox = tx << 8, oy = ty << 8;
                const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
                const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
                const t = this.writable(tx, ty);
                for (let y = iy0 - oy; y < iy1 - oy; y++) {
                    if (LITTLE) {
                        u32Of(t).fill(word, y * TILE_SIZE + ix0 - ox, y * TILE_SIZE + ix1 - ox);
                    } else {
                        for (let i = (y * TILE_SIZE + ix0 - ox) * 4, e = (y * TILE_SIZE + ix1 - ox) * 4; i < e; i += 4) {
                            t.data[i] = rgba[0]; t.data[i + 1] = rgba[1]; t.data[i + 2] = rgba[2]; t.data[i + 3] = rgba[3];
                        }
                    }
                }
            }
        }
    }

    /**
     * The non-transparent extent, exactly as the canvas backend's scan finds it. Every allocated
     * tile holds a pixel (empty ones are dropped), so only the tiles in the outermost rows and
     * columns of the tile set can hold an edge; their exact extents are cached per tile version.
     */
    bounds() {
        this._guard();
        for (;;) {
            if (!this._tiles.size) return null;
            let txMin = Infinity, txMax = -1, tyMin = Infinity, tyMax = -1;
            for (const key of this._tiles.keys()) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx < txMin) txMin = tx;
                if (tx > txMax) txMax = tx;
                if (ty < tyMin) tyMin = ty;
                if (ty > tyMax) tyMax = ty;
            }
            let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, empty = null;
            for (const [key, t] of this._tiles) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx !== txMin && tx !== txMax && ty !== tyMin && ty !== tyMax) continue;
                const e = tileExtent(t);
                if (!e) { (empty || (empty = [])).push(key); continue; }
                const ox = tx << 8, oy = ty << 8;
                if (tx === txMin && ox + e[0] < x0) x0 = ox + e[0];
                if (tx === txMax && ox + e[2] > x1) x1 = ox + e[2];
                if (ty === tyMin && oy + e[1] < y0) y0 = oy + e[1];
                if (ty === tyMax && oy + e[3] > y1) y1 = oy + e[3];
            }
            if (!empty) return [x0, y0, x1, y1];
            for (const key of empty) this._dropTile(key);   // never expected: a write left one behind
        }
    }

    // -- decoding --

    /** `draw(ctx, sx, sy)` per strip of 4096 x DECODE_ROWS on one scratch, read back into the tiles. */
    _strips(draw) {
        const W = this._w, H = this._h, rows = DECODE_ROWS;
        const s = acquireScratch(Math.min(STRIP_W, W), Math.min(rows, H), "a decode strip");
        try {
            for (let sy = 0; sy < H; sy += rows) {
                for (let sx = 0; sx < W; sx += STRIP_W) {
                    const bw = Math.min(STRIP_W, W - sx), bh = Math.min(rows, H - sy);
                    resetScratch(s);
                    draw(s.ctx, sx, sy);
                    const img = s.ctx.getImageData(0, 0, bw, bh);
                    this._putBlock(img.data, bw, 0, 0, sx, sy, bw, bh, false);
                }
            }
        } finally {
            releaseScratch(s);
        }
    }

    /** A canvas's pixels, read in strips with its own getImageData (a canvas without a 2D context is drawn). */
    _readCanvas(canvas) {
        const ctx = canvas.getContext ? canvas.getContext("2d") : null;
        if (!ctx) {
            this._strips((c, sx, sy) => c.drawImage(canvas, -sx, -sy));
            return;
        }
        const W = Math.min(this._w, canvas.width), H = Math.min(this._h, canvas.height);
        for (let sy = 0; sy < H; sy += TILE_SIZE) {
            for (let sx = 0; sx < W; sx += STRIP_W) {
                const bw = Math.min(STRIP_W, W - sx), bh = Math.min(TILE_SIZE, H - sy);
                const img = ctx.getImageData(sx, sy, bw, bh);
                this._putBlock(img.data, bw, 0, 0, sx, sy, bw, bh, false);
            }
        }
    }
};

/** Layer pixels on tiles; `instanceof LayerPixels` holds. */
export class TileLayerPixels extends tiled(LayerPixels) {}

/** A layer mask or the selection on tiles: RGBA tiles in C2 (C5 moves masks to one channel). */
export class TileMaskPixels extends tiled(MaskPixels) {}

const TILE_BACKEND = Object.freeze({ Layer: TileLayerPixels, Mask: TileMaskPixels, tiles: true });

/** The classes of a backend: `{ Layer, Mask, tiles }`, the tile store for `tiles`, else the canvas. */
export function pixelsBackend(tiles) {
    return tiles ? TILE_BACKEND : LayerPixels.backend;
}

/** Are these pixels on tiles? */
export function isTilePixels(p) {
    return p instanceof LayerPixels && p._tiles instanceof Map;
}
