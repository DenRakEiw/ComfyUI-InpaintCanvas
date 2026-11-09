// Generated from DenRakEiw/scumble renderer/editor/px/px.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Loader and memory helpers for the px kernels (crates/px, docs/PLAN_BCE.md §B1).
 *
 * The module exports plain functions over its linear memory; nothing here is generated.
 * One instance per thread, own memory each, no shared wasm memory. A kernel call is: take
 * in and out blocks from an arena, one `set`, one call, one `subarray` (or a copy) out.
 *
 * The classic wasm bug is a stale view: `memory.buffer` changes identity whenever memory
 * grows, and every typed array made over the old buffer is detached (length 0). `px.u8()`,
 * `px.f32()` and `px.u32()` check the identity and re-create the view, so call them after
 * anything that could have allocated, never keep one across `alloc` / `take`.
 */

export const PX_ABI = 39;

// arithmetic, not `& -n`: sizes above 2 GB do not survive a 32-bit bitwise operator
const roundUp = (n, to) => Math.ceil(n / to) * to;

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The first output buffer of `deflate_part` for `n` bytes: their worst case, stored blocks. miniz_oxide ends a block
 * after 31,745 bytes of literals (stored with 5 bytes of overhead each), not 65,535, so noise in all four channels
 * needs about 5 bytes per 31 KB plus the flush's own; the 64 cover the sync marker and the bits around it. Too small
 * is only slower (`deflate_part` answers -1 and the caller doubles it), never shorter.
 */
const storedCap = (n) => n + Math.ceil(n / 31744) * 5 + 64;

/** A stopwatch over `laps`: each call adds the milliseconds since the one before (or since it was made) to `laps[key]`. */
function lapper(laps) {
    let t = clock();
    return (key) => { const t1 = clock(); laps[key] = (laps[key] || 0) + (t1 - t); t = t1; };
}

/** Parses `#rrggbb` or `#rgb` into `[r, g, b]` in `0..1` (`inpaint_weights.js` `hexToRgb`). */
function rangeHexToRgb01(hex) {
    if (!hex || typeof hex !== "string") return [1, 1, 1];
    const clean = hex.replace(/^#/, "");
    if (clean.length === 6) {
        return [
            parseInt(clean.slice(0, 2), 16) / 255,
            parseInt(clean.slice(2, 4), 16) / 255,
            parseInt(clean.slice(4, 6), 16) / 255,
        ];
    }
    if (clean.length === 3) {
        return [
            parseInt(clean[0] + clean[0], 16) / 255,
            parseInt(clean[1] + clean[1], 16) / 255,
            parseInt(clean[2] + clean[2], 16) / 255,
        ];
    }
    return [1, 1, 1];
}

// ---- call counters (docs/PLAN_WASM_BUILD.md §3.4) --------------------------------------------------------------------
// One counter per kernel export and thread, so a gate step or a worker's timing can say which Rust kernels ran and how
// often. They live here, not on an instance: kernels.js `releaseIfLarge` replaces the instance and the counts go on.
// Not counted: the loader's own exports (`px_alloc`, `px_free`, `px_abi_version`, `px_simd`) and the size helpers
// (`*_bytes`, `*_cap`), which do no pixel work.
// The split (docs/PLAN_WASM_K1.md S1): while `pxTimed()` is on, a kernel call's milliseconds go into its entry's `ms`
// and the copies and allocations of the `Px` methods into `LAPS`. `ever` (calls since the thread loaded the module) and
// `firstMs` (the thread's first call of that export, when it was timed) are never reset; `pxCalls(true)` is the one
// reset point of everything else. Off, a kernel call costs its count and nothing more.
const UNCOUNTED = /^px_|_bytes$|_cap$/;
const CALLS = new Map();   // export name -> { n, ever, ms, firstMs }
const MB = 1048576;
const LAPS = { copyIn: 0, copyInMB: 0, copyInSharedMB: 0, copyOut: 0, copyOutMB: 0, alloc: 0, grewMB: 0 };
const SAB = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : null;   // absent in a page that is not isolated
let TIMED = false;

/** This thread's px kernel calls since the last reset: `{ <export name>: count }` of the ones called at least once (a copy); `reset` clears them, their milliseconds and the laps. */
export function pxCalls(reset = false) {
    const out = {};
    for (const [name, c] of CALLS) {
        if (c.n) out[name] = c.n;
        if (reset) { c.n = 0; c.ms = 0; }
    }
    if (reset) for (const k in LAPS) LAPS[k] = 0;
    return out;
}

/** This thread's switch for the split's clocks (off at load): `on` sets it. Returns the current value. */
export function pxTimed(on) {
    if (on !== undefined) TIMED = !!on;
    return TIMED;
}

/**
 * The split since the last `pxCalls(true)` (a fresh object): `ms` the milliseconds by export, `first` the exports whose
 * first call on this thread fell since the reset (its milliseconds, null when that call was not timed), and the laps:
 * `copyIn` / `copyOut` the milliseconds of the copies into and out of wasm memory with their MB (`copyInSharedMB` the
 * part read from a SharedArrayBuffer), `alloc` the milliseconds in `px_alloc` and `grewMB` what memory grew in it.
 * Everything but `first` is booked only while `pxTimed()` is on.
 */
export function pxLaps() {
    const ms = {}, first = {};
    for (const [name, c] of CALLS) {
        if (c.ms > 0) ms[name] = c.ms;
        if (c.n && c.n === c.ever) first[name] = c.firstMs;   // every call of it since the load fell since the reset
    }
    return { ms, first, ...LAPS };
}

/**
 * A copy made outside the `Px` methods (inpaint_worker.js `mipsRust`), booked as `key` ("copyIn" | "copyOut") with its
 * `bytes`; `shared` when a copy in read from a SharedArrayBuffer. The caller times it, and only while `pxTimed()`.
 */
export function pxLapAdd(key, ms, bytes = 0, shared = false) {
    if (key !== "copyIn" && key !== "copyOut") throw new Error("px: no lap " + key);
    LAPS[key] += ms;
    LAPS[key + "MB"] += bytes / MB;
    if (shared && key === "copyIn") LAPS.copyInSharedMB += bytes / MB;
}

// a copy timed from `t`: in from the buffer `from`, or out
function lapIn(t, bytes, from) {
    LAPS.copyIn += clock() - t;
    LAPS.copyInMB += bytes / MB;
    if (SAB !== null && from instanceof SAB) LAPS.copyInSharedMB += bytes / MB;
}

function lapOut(t, bytes) {
    LAPS.copyOut += clock() - t;
    LAPS.copyOutMB += bytes / MB;
}

/** Whether `v` is an array of bytes as the twins read them: a Uint8Array (a Buffer too) or a Uint8ClampedArray. */
const isBytes = (v) => v instanceof Uint8Array || v instanceof Uint8ClampedArray;

const LIQUIFY_MODE_ID = { push: 0, grow: 1, shrink: 2, swirlcw: 3, swirlccw: 4, restore: 5 };

/** The bytes of RGBA8 a per-pixel kernel takes from `src` (K27): its length when it is bytes of whole pixels, else 0. */
const rgbaBytes = (src) => (isBytes(src) && src.length > 0 && src.length % 4 === 0 ? src.length : 0);

/** `Px.alloc` found no room: the memory cannot grow any further. kernels.js replaces the instance and runs the twin. */
export class PxOutOfMemory extends Error {
    constructor(bytes) {
        super(`px: out of memory allocating ${bytes} bytes`);
        this.name = "PxOutOfMemory";
        this.bytes = bytes;
    }
}

// A trap (`WebAssembly.RuntimeError`) or a wasm stack overflow (`RangeError`, which also leaves Rust's shadow stack
// pointer wrong) thrown by an export poisons its instance. The module has no imports, so either can only come from wasm
// (docs/PLAN_WASM_K1.md §0.3.3). The first one is kept on the `Px` as `trapped`; kernels.js replaces the instance.
function trapMark(owner, e) {
    if (!owner.trapped && (e instanceof WebAssembly.RuntimeError || e instanceof RangeError)) owner.trapped = e;
    return e;
}

/**
 * The instance's exports, every function wrapped: a trap marked on `owner` (`trapMark`), and a kernel's calls counted
 * (and timed while `pxTimed()`); everything else as it is.
 */
function countedExports(raw, owner) {
    const out = {};
    for (const [name, value] of Object.entries(raw)) {
        if (typeof value !== "function") { out[name] = value; continue; }
        if (UNCOUNTED.test(name)) {
            out[name] = (...a) => { try { return value(...a); } catch (e) { throw trapMark(owner, e); } };
            continue;
        }
        let c = CALLS.get(name);
        if (!c) CALLS.set(name, c = { n: 0, ever: 0, ms: 0, firstMs: null });
        out[name] = (...a) => {
            c.n++; c.ever++;
            if (!TIMED) { try { return value(...a); } catch (e) { throw trapMark(owner, e); } }
            const t = clock();
            try { return value(...a); }
            catch (e) { throw trapMark(owner, e); }
            finally { const d = clock() - t; c.ms += d; if (c.ever === 1) c.firstMs = d; }
        };
    }
    return Object.freeze(out);
}

/**
 * Instantiate a px module. `source` is a URL (fetched), a `Response`, bytes (an
 * `ArrayBuffer` or a view) or a compiled `WebAssembly.Module` (what a worker is posted).
 */
export async function loadPx(source) {
    let module;
    if (source instanceof WebAssembly.Module) module = source;
    else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) module = await WebAssembly.compile(source);
    else {
        const res = typeof Response !== "undefined" && source instanceof Response ? source : await fetch(source);
        if (!res.ok) throw new Error(`px: ${res.status} for ${res.url}`);
        module = await WebAssembly.compile(await res.arrayBuffer());
    }
    const instance = await WebAssembly.instantiate(module, {});
    return new Px(instance, module);
}

export class Px {
    constructor(instance, module) {
        this.instance = instance;
        this.module = module;
        this.trapped = null;                              // the error that poisoned this instance (`trapMark`), or null
        this.raw = instance.exports;                      // the instance's own exports, uncounted
        this.exports = countedExports(instance.exports, this);   // the same, each kernel call counted (`pxCalls`), each trap marked
        this.memory = instance.exports.memory;
        const abi = this.exports.px_abi_version();
        if (abi !== PX_ABI) throw new Error(`px: module ABI ${abi}, this loader speaks ${PX_ABI}`);
        this.simd = this.exports.px_simd() === 1;
        this._buf = null;
        this._u8 = this._f32 = this._u32 = null;
    }

    _views() {
        const buf = this.memory.buffer;
        if (buf !== this._buf) {
            this._buf = buf;
            this._u8 = new Uint8Array(buf);
            this._f32 = new Float32Array(buf);
            this._u32 = new Uint32Array(buf);
        }
    }

    /** The whole memory as bytes, re-created after growth. */
    u8() { this._views(); return this._u8; }
    f32() { this._views(); return this._f32; }
    u32() { this._views(); return this._u32; }

    /** Bytes currently reserved by the instance's memory. */
    get byteLength() { return this.memory.buffer.byteLength; }

    /** A block of `bytes` (8-aligned). Throws `PxOutOfMemory` when memory cannot grow any further. */
    alloc(bytes) {
        if (!(bytes > 0)) return 0;
        let ptr;
        if (!TIMED) ptr = this.exports.px_alloc(bytes) >>> 0;   // pointers above 2 GB come back negative
        else {
            // the lap: the call and what memory grew inside it (memory.grow happens in px_alloc)
            const b0 = this.memory.buffer.byteLength, t = clock();
            ptr = this.exports.px_alloc(bytes) >>> 0;
            LAPS.alloc += clock() - t;
            LAPS.grewMB += (this.memory.buffer.byteLength - b0) / MB;
        }
        if (!ptr) throw new PxOutOfMemory(bytes);
        return ptr;
    }

    free(ptr, bytes) {
        if (ptr && bytes > 0) this.exports.px_free(ptr, bytes);
    }

    /** Copy a typed array (any element type) into memory at `ptr`, byte for byte. */
    put(ptr, data) {
        const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (!TIMED) { this.u8().set(src, ptr); return; }
        const t = clock();
        this.u8().set(src, ptr);
        lapIn(t, src.byteLength, data.buffer);
    }

    /** A view of `length` elements of `Type` at `ptr`; valid until the next allocation. */
    view(Type, ptr, length) {
        this._views();
        return new Type(this._buf, ptr, length);
    }

    /** A copy of `length` elements of `Type` at `ptr` into `into` (allocated when absent). */
    get(Type, ptr, length, into) {
        return this._out(Type, ptr, length, into);
    }

    arena(chunkBytes = 1 << 20) {
        return new PxArena(this, chunkBytes);
    }

    // ---- kernels: the signatures of kernels_js.js, one copy in and one copy out ----------------
    // Each call takes its blocks from one job arena and resets it afterwards. For data that
    // already lives in wasm memory, call `px.exports.<kernel>` with pointers instead.

    get job() {
        return this._job || (this._job = this.arena(1 << 20));
    }

    _in(arena, data, bytes = data.byteLength) {
        const ptr = arena.take(bytes);
        const src = new Uint8Array(data.buffer, data.byteOffset, bytes);
        if (!TIMED) { this.u8().set(src, ptr); return ptr; }
        const t = clock();
        this.u8().set(src, ptr);
        lapIn(t, bytes, data.buffer);
        return ptr;
    }

    _out(Type, ptr, length, out) {
        if (!TIMED) {
            const into = out || new Type(length);
            into.set(this.view(Type, ptr, length));
            return into;
        }
        const t = clock();   // a new array's allocation is part of the copy out
        const into = out || new Type(length);
        into.set(this.view(Type, ptr, length));
        lapOut(t, length * Type.BYTES_PER_ELEMENT);
        return into;
    }

    /**
     * `a.reset()` after a method's last export call. Once the instance is poisoned (a trap, or out of memory in the reset
     * itself) the reset's error is swallowed: a result already written into the caller's arrays must not be lost to it,
     * or kernels.js would run the twin over in-place data a second time (docs/PLAN_WASM_K1.md §0.3.2).
     */
    _reset(a) {
        try { a.reset(); }
        catch (err) {
            if (!this.trapped && !(err instanceof PxOutOfMemory)) throw err;
            if (!this.trapped) this.trapped = err;
        }
    }

    mipHalf(src, sw, sh, dst = null) {
        const a = this.job, n = (sw >> 1) * (sh >> 1) * 4;
        try {
            const ps = this._in(a, src, sw * sh * 4), pd = a.take(n);
            this.exports.mip_half(ps, sw, sh, pd);
            return this._out(Uint8Array, pd, n, dst);
        } finally { this._reset(a); }
    }

    mipChain(src, size, levels, out = null) {
        const a = this.job, n = this.exports.mip_chain_bytes(size, levels);
        try {
            const ps = this._in(a, src, size * size * 4), po = a.take(n);
            this.exports.mip_chain(ps, size, levels, po);
            return this._out(Uint8Array, po, n, out);
        } finally { this._reset(a); }
    }

    /** In place, like kernels_js `clampExtend`. */
    clampExtend(bytes, size, vw, vh) {
        const a = this.job, n = size * size * 4;
        try {
            const pb = this._in(a, bytes, n);
            this.exports.clamp_extend(pb, size, vw, vh);
            return this._out(Uint8Array, pb, n, new Uint8Array(bytes.buffer, bytes.byteOffset, n));
        } finally { this._reset(a); }
    }

    /**
     * The row filters of `rows` PNG lines undone (kernels_js.js `pngUnfilterRows`): `lines` in place, or with `rgba`
     * (`{ w, channels, out }`, 8-bit RGB or RGBA) the rows straight into `out` as RGBA8 and `lines` left as they were.
     * `prev` becomes the last row. Returns the lines undone.
     */
    pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba = null) {
        const a = this.job, n = rows * (rowBytes + 1);
        try {
            const pl = this._in(a, lines, n), pp = this._in(a, prev, rowBytes);
            const po = rgba ? a.take(rows * rgba.w * 4) : 0;
            const done = this.exports.png_unfilter_rows(pl, rows, rowBytes, bpp, pp, rgba ? rgba.w : 0, rgba ? rgba.channels : 0, po);
            if (done === rows) {
                if (rgba) this._out(Uint8Array, po, rows * rgba.w * 4, rgba.out);
                else this._out(Uint8Array, pl, n, lines);
                this._out(Uint8Array, pp, rowBytes, prev);
            }
            return done;
        } finally { this._reset(a); }
    }

    /** The colour match of `params` (meanS[3], meanT[3], scale[3], k) over straight RGBA8, in place (B item 7 part 3). */
    matchPixels(rgba, params) {
        const a = this.job, px = rgba.byteLength >> 2;
        try {
            const pd = this._in(a, rgba, px * 4), pp = a.take(40);
            const f = this.view(Float32Array, pp, 10);
            for (let i = 0; i < 10; i++) f[i] = params[i];
            this.exports.match_pixels(pd, px, pp);
            return this._out(Uint8Array, pd, px * 4, rgba);
        } finally { this._reset(a); }
    }

    /** The alpha channel of RGBA8 `rgba` as a 0..1 Float32Array (`out` when given, else a new one). */
    alphaToMask(rgba, out = null) {
        const a = this.job, n = rgba.length >>> 2;
        try {
            const pr = this._in(a, rgba, n * 4), po = a.take(n * 4);
            this.exports.alpha_to_mask(pr, po, n);
            return this._out(Float32Array, po, n, out);
        } finally { this._reset(a); }
    }

    /** `Math.max(a[i], b[i])` (when `b` is given) and/or `Math.min(1, Math.max(0, x))` (`clamp`) into `out` (or a new Float32Array). */
    maskMaxClamp(a, b = null, clamp = false, out = null) {
        const ar = this.job, n = a.length;
        try {
            const pa = this._in(ar, a, n * 4), pb = b ? this._in(ar, b, n * 4) : 0;
            this.exports.mask_max_clamp(pa, pb, pa, n, clamp ? 1 : 0);
            return this._out(Float32Array, pa, n, out);
        } finally { this._reset(ar); }
    }

    /** `1 - src[i]` for every float of `src`, into `out` (or a new Float32Array). */
    maskOneMinus(src, out = null) {
        const a = this.job, n = src.length;
        try {
            const ps = this._in(a, src, n * 4);
            this.exports.mask_one_minus(ps, ps, n);
            return this._out(Float32Array, ps, n, out);
        } finally { this._reset(a); }
    }

    /** Square dilation of a w x h Float32Array by r pixels; a new array. */
    dilateMask(data, w, h, r) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.dilate_mask(pd, w, h, r);
            return this._out(Float32Array, pd, n, null);
        } finally { this._reset(a); }
    }

    /** Square erosion of a w x h Float32Array by r pixels (`1 - dilate(1 - m, r)`); a new array. */
    erodeMask(data, w, h, r) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.erode_mask(pd, w, h, r);
            return this._out(Float32Array, pd, n, null);
        } finally { this._reset(a); }
    }

    /** A 0..1 Float32Array `src` as RGBA8 (`mode` 0 white, 1 luminance, 2 alpha) into `out` (or a new Uint8ClampedArray). */
    maskToRgba(src, mode = 0, out = null) {
        const a = this.job, n = src.length;
        try {
            const ps = this._in(a, src, n * 4), po = a.take(n * 4);
            this.exports.mask_to_rgba(ps, po, n, mode | 0);
            return this._out(Uint8ClampedArray, po, n * 4, out);
        } finally { this._reset(a); }
    }

    /** Bounding box `[x0, y0, x1, y1]` (right and bottom exclusive) of `src` (`w` x `h` Float32Array) where `> 0.5`, or null. */
    maskBoundsF32(src, w, h) {
        const a = this.job, n = w * h;
        if (!(n > 0)) return null;
        try {
            const ps = this._in(a, src, n * 4), pb = a.take(16);
            if (!this.exports.mask_bounds_f32(ps, w, h, pb)) return null;
            const b = this.view(Int32Array, pb, 4);
            return [b[0], b[1], b[2], b[3]];
        } finally { this._reset(a); }
    }

    /** Matches the weighted RGB mean and standard deviation of `patch` (RGBA8, in place) to `reference` under `weight` (`stitch.js` `colorMatch`). */
    colorMatchRgba(patch, reference, weight) {
        const a = this.job, n = weight.length;
        if (!(n > 0)) return false;
        try {
            const pp = this._in(a, patch, n * 4), pr = this._in(a, reference, n * 4), pw = this._in(a, weight, n * 4);
            if (!this.exports.color_match_rgba(pp, pr, pw, n)) return false;
            this._out(Uint8Array, pp, n * 4, new Uint8Array(patch.buffer, patch.byteOffset, n * 4));
            return true;
        } finally { this._reset(a); }
    }

    /** The alpha byte of each RGBA8 pixel of `rgba` replaced in `out` (or a new Uint8ClampedArray; may be `rgba`) by `Math.round(clamp01(mask[i]) * (keepAlpha ? rgba[i * 4 + 3] : 255))`. */
    blendAlpha(rgba, mask, keepAlpha = false, out = null) {
        const a = this.job, n = mask.length;
        try {
            const pr = this._in(a, rgba, n * 4), pm = this._in(a, mask, n * 4);
            this.exports.blend_alpha(pr, pm, pr, n, keepAlpha ? 1 : 0);
            return this._out(Uint8ClampedArray, pr, n * 4, out);
        } finally { this._reset(a); }
    }

    /** Area-average shrink of straight-alpha RGBA8 `rgba` (`w * h * 4` bytes) to `{ gray, alpha }` (`tw * th` Float32Arrays, `edgefit.js` `shrinkRGBA`). */
    edgefitShrink(rgba, w, h, tw, th, grayOut = null, alphaOut = null) {
        const a = this.job, nIn = w * h * 4, nOut = tw * th;
        if (!(nIn > 0 && nOut > 0)) return { gray: grayOut || new Float32Array(0), alpha: alphaOut || new Float32Array(0) };
        try {
            const pr = this._in(a, rgba, nIn), pg = a.take(nOut * 4), pa = a.take(nOut * 4);
            this.exports.edgefit_shrink(pr, w, h, tw, th, pg, pa);
            return { gray: this._out(Float32Array, pg, nOut, grayOut), alpha: this._out(Float32Array, pa, nOut, alphaOut) };
        } finally { this._reset(a); }
    }

    /** Bilinear inverse-affine warp of RGBA8 `src` (`w * h * 4` bytes) through `m` (`[a00, a01, tx, a10, a11, ty]`, `edgefit.js` `warpRGBA`). */
    warpRgba(src, w, h, m, out = null) {
        const a = this.job, n = w * h * 4;
        if (!(n > 0)) return out || new Uint8ClampedArray(0);
        try {
            const ps = this._in(a, src, n), po = a.take(n);
            this.exports.warp_rgba(ps, po, w, h, m[0], m[1], m[2], m[3], m[4], m[5]);
            return this._out(Uint8ClampedArray, po, n, out);
        } finally { this._reset(a); }
    }

    /** Per-pixel source-bounds coverage mask (`w * h` Float32Array) for `m` (`[a00, a01, tx, a10, a11, ty]`, `edgefit.js` `warpCoverage`). */
    warpCoverage(w, h, m, out = null) {
        const a = this.job, n = w * h;
        if (!(n > 0)) return out || new Float32Array(0);
        try {
            const po = a.take(n * 4);
            this.exports.warp_coverage(po, w, h, m[0], m[1], m[2], m[3], m[4], m[5]);
            return this._out(Float32Array, po, n, out);
        } finally { this._reset(a); }
    }

    /** Box blurs of up to three radii (rows then columns each) over a w x h Float32Array; a new array. */
    boxBlurs(data, w, h, radii) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.box_blurs(pd, w, h, radii[0] | 0, radii[1] | 0, radii[2] | 0);
            return this._out(Float32Array, pd, n, null);
        } finally { this._reset(a); }
    }

    /**
     * `blurRGBA(src, w, h, r)` of inpaint_stroke.js (K26): straight RGBA8 premultiplied, three box passes of radius r
     * each way, back to straight bytes; a new Uint8ClampedArray. `r` is rounded as the twin rounds it. Null when the
     * kernel refuses the call (a size or radius it cannot take, a short `src`): the caller runs the twin then.
     */
    blurRGBA(src, w, h, r) { return this._dab(src, w, h, r, false, 1); }

    /**
     * `sharpenRGBA(src, w, h, r, amount)` of inpaint_stroke.js (K26), as `blurRGBA`. `amount` goes to the export as it
     * is: the wasm f64 parameter's ToNumber is the twin's arithmetic (null 0, a numeric string its number).
     */
    sharpenRGBA(src, w, h, r, amount = 1) { return this._dab(src, w, h, r, true, amount); }

    _dab(src, w, h, r, sharpen, amount) {
        const n = w * h * 4;
        r = Math.max(0, Math.round(r));
        const ri = r > 0 ? r : 0;   // NaN: no pass, as the twin's `r > 0`
        if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || ri > 0x3fffffff || !(src && src.length >= n)) return null;
        const bytes = this.exports.dab_scratch_bytes(w, h) >>> 0;
        if (!bytes) return null;
        const a = this.job;
        try {
            const ps = this._in(a, src, n), po = a.take(n), pt = a.take(bytes);
            const ok = sharpen ? this.exports.sharpen_rgba(ps, po, pt, w, h, ri, amount) : this.exports.blur_rgba(ps, po, pt, w, h, ri);
            return ok === 1 ? this._out(Uint8ClampedArray, po, n, null) : null;
        } finally { this._reset(a); }
    }

    /**
     * `toneRGBA(src, lut, protect)` of inpaint_stroke.js (K27): the stroke's 256-byte table copied in with each call
     * (never resident: a stroke makes a fresh one); a new Uint8ClampedArray. Null when the kernel does not take the call
     * (not whole bytes, no whole pixel, a table not of bytes or shorter than 256): the caller runs the twin then.
     */
    toneRGBA(src, lut, protect = false) {
        const n = rgbaBytes(src);
        if (!n || !isBytes(lut) || lut.length < 256) return null;
        const a = this.job;
        try {
            const ps = this._in(a, src, n), pl = this._in(a, lut, 256), po = a.take(n);
            return this.exports.tone_rgba(ps, po, n, pl, protect ? 1 : 0) === 1 ? this._out(Uint8ClampedArray, po, n, null) : null;
        } finally { this._reset(a); }
    }

    /**
     * `spongeRGBA(src, amount, saturate, vibrance)` of inpaint_stroke.js (K27), as `toneRGBA`: the amount clamped here as
     * the twin clamps it (`+amount || 0` into 0..1), the two switches by the twin's truthiness.
     */
    spongeRGBA(src, amount, saturate = false, vibrance = true) {
        const k = Math.max(0, Math.min(1, +amount || 0));
        const n = rgbaBytes(src);
        if (!n) return null;
        const a = this.job;
        try {
            const ps = this._in(a, src, n), po = a.take(n);
            return this.exports.sponge_rgba(ps, po, n, k, (saturate ? 1 : 0) | (vibrance ? 2 : 0)) === 1 ? this._out(Uint8ClampedArray, po, n, null) : null;
        } finally { this._reset(a); }
    }

    /**
     * Frequency separation's split, `freqSplit(I, L)` of inpaint_stroke.js (K27): `low` (as long as `src`) written in
     * place, the detail returned (a new Uint8ClampedArray). Null as `toneRGBA`, and for a `low` of another length or not
     * of bytes; `low` is only written once the kernel is done.
     */
    freqSplit(src, low) {
        const n = rgbaBytes(src);
        if (!n || !isBytes(low) || low.length !== n) return null;
        const a = this.job;
        try {
            const ps = this._in(a, src, n), pl = this._in(a, low, n), ph = a.take(n);
            if (this.exports.freq_split(ps, pl, ph, n) !== 1) return null;
            const high = this._out(Uint8ClampedArray, ph, n, null);
            this._out(Uint8Array, pl, n, new Uint8Array(low.buffer, low.byteOffset, n));
            return high;
        } finally { this._reset(a); }
    }

    /**
     * Frequency separation in one go (K27): `blurRGBA(src, w, h, r)` and `freqSplit` on it in one arena, so the blur never
     * leaves wasm memory and the detail lands in the blur's scratch (no more memory than the blur alone: about 640 MB
     * at 16 MP); `{ low, high }`, two new Uint8ClampedArrays, copied out before anything else runs. Null as `blurRGBA`,
     * and for a `src` not exactly w x h pixels.
     */
    freqSeparate(src, w, h, r) {
        const n = w * h * 4;
        r = Math.max(0, Math.round(r));
        const ri = r > 0 ? r : 0;   // NaN: no pass, as the twin's `r > 0`
        if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || ri > 0x3fffffff || rgbaBytes(src) !== n) return null;
        const bytes = this.exports.dab_scratch_bytes(w, h) >>> 0;   // two f32 planes: more than the n bytes of the detail
        if (!bytes) return null;
        const a = this.job;
        try {
            const ps = this._in(a, src, n), po = a.take(n), pt = a.take(bytes);
            if (this.exports.blur_rgba(ps, po, pt, w, h, ri) !== 1 || this.exports.freq_split(ps, po, pt, n) !== 1) return null;
            return { low: this._out(Uint8ClampedArray, po, n, null), high: this._out(Uint8ClampedArray, pt, n, null) };
        } finally { this._reset(a); }
    }

    /** Computes max - min over each texel's 4x4 block of a w x h Uint16Array; a new array. */
    rangeMax(src, w, h, out = null) {
        const a = this.job, n = w * h;
        try {
            const ps = this._in(a, src, n * 2);
            const po = a.take(n * 2);
            this.exports.range_max(ps, w, h, po);
            return this._out(Uint16Array, po, n, out);
        } finally { this._reset(a); }
    }

    /**
     * Surface normals from u16 height field: n = normalize(-dz/dx, -dz/dy, 1.0)
     * after Gaussian blur with sigma; packed as RGBA8 (n * 127.5 + 127.5, A=255).
     */
    heightNormals(depth, w, h, scale, sigma, out = null) {
        const a = this.job, n = w * h;
        try {
            const ps = this._in(a, depth, n * 2);
            const po = a.take(n * 4);
            this.exports.height_normals(ps, w, h, scale, sigma, po);
            return this._out(Uint8Array, po, n * 4, out);
        } finally { this._reset(a); }
    }

    /**
     * Marches shadow rays through u16 depth height field.
     * Visibility map into `out` (0=shadow, 255=lit): a full-size `out` takes the rows at row0 * w. With a `key` the depth
     * map stays resident in this instance (`_slot`, kind "relight_depth"): the stripes of one march copy it once (K12).
     */
    shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out = null, key = null) {
        const bandRows = Math.min(rows, h - row0);
        const a = this.job, n = w * h, nOut = w * bandRows;
        try {
            const pd = key !== null && key !== undefined ? this._slot("relight_depth", String(key), depth, n * 2) : this._in(a, depth, n * 2);
            const pl = this._in(a, new Float32Array(light), 16);
            const po = a.take(nOut);
            this.exports.shadow_march(pd, w, h, scale, pl, radius, taps, steps, bias, row0, bandRows, po);
            if (out && out.length >= w * h && row0 > 0) {
                const target = out.subarray(row0 * w, (row0 + bandRows) * w);
                return this._out(Uint8Array, po, nOut, target);
            }
            return this._out(Uint8Array, po, nOut, out);
        } finally { this._reset(a); }
    }

    distTransform(feature, w, h, out = null) {
        const a = this.job, n = w * h;
        try {
            const pf = this._in(a, feature, n), po = a.take(n * 4), pt = a.take(this.exports.dist_scratch_bytes(w, h));
            this.exports.dist_transform(pf, w, h, po, pt);
            return this._out(Float32Array, po, n, out);
        } finally { this._reset(a); }
    }

    flood(rgba, w, h, sx, sy, tolerance = 32, contiguous = true, out = null) {
        const a = this.job, n = w * h;
        let pairs = Math.max(4096, n >> 4);
        try {
            const pr = this._in(a, rgba, n * 4), po = a.take(n);
            for (;;) {
                const pstack = a.take(pairs * 8);
                const count = this.exports.flood(pr, w, h, sx, sy, tolerance, contiguous ? 1 : 0, po, pstack, pairs);
                if (count >= 0) {
                    const mask = this._out(Uint8Array, po, n, out);
                    mask.count = count;
                    return mask;
                }
                pairs *= 2;
            }
        } finally { this._reset(a); }
    }

    /**
     * `growMask` and `maskBounds` of the result in one call: the selection `d` (RGBA8) grown or shrunk in place;
     * `cells` (optional Uint8Array of `((w + 255) >> 8) * ((h + 255) >> 8)` bytes) gets each 256² cell's state
     * (0 empty, 1 occupied and changed, 2 occupied and unchanged). Returns the result's bounds [x0, y0, x1, y1] or null.
     */
    growMask(d, w, h, n, cells = null) {
        const a = this.job, bytes = w * h * 4;
        const nCells = cells ? ((w + 255) >> 8) * ((h + 255) >> 8) : 0;
        try {
            const pd = this._in(a, d, bytes), pb = a.take(16), pc = nCells > 0 ? a.take(nCells) : 0;
            const any = this.exports.grow_mask(pd, w, h, n, pb, pc);
            this._out(Uint8Array, pd, bytes, new Uint8Array(d.buffer, d.byteOffset, bytes));
            if (cells && nCells > 0) this._out(Uint8Array, pc, nCells, new Uint8Array(cells.buffer, cells.byteOffset, nCells));
            if (!any) return null;
            const b = this.view(Int32Array, pb, 4);
            return [b[0], b[1], b[2], b[3]];
        } finally { this._reset(a); }
    }

    /**
     * The flood job: the region around (sx, sy) clipped to `sel` (RGBA8 or null), drawn as 255 / 0 alpha bytes when
     * `outKind === 1` (`Uint8Array` of `w * h`) or as the colour `rgb` (0xRRGGBB) otherwise (`Uint8ClampedArray` of
     * `w * h * 4`). `use(view, count, bounds, cells)` gets the shape and the 256² cell occupancy (`Uint8Array` of
     * `((w + 255) >> 8) * ((h + 255) >> 8)` bytes, 1 occupied, 0 empty) as views over wasm memory (valid only inside
     * the call: an ImageData over `view` goes to putImageData without a copy) and its result is returned.
     */
    floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use, outKind = 4) {
        const a = this.job, n = w * h, bytes = n * 4;
        const nCells = ((w + 255) >> 8) * ((h + 255) >> 8);
        const kind = outKind === 1 ? 1 : 4;
        let pairs = Math.max(4096, n >> 4);
        try {
            const pr = this._in(a, rgba, bytes), ps = sel ? this._in(a, sel, bytes) : 0, pi = a.take(20), pc = a.take(nCells);
            for (;;) {
                const pst = a.take(pairs * 8);
                if (this.exports.flood_shape(pr, w, h, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous ? 1 : 0, ps, rgb >>> 0, kind, pst, pairs, pi, pc) >= 0) break;
                pairs *= 2;
            }
            const info = this.view(Int32Array, pi, 5);
            const bounds = info[3] < 0 ? null : [info[1], info[2], info[3], info[4]];
            const view = kind === 1 ? new Uint8Array(this.memory.buffer, pr, n) : new Uint8ClampedArray(this.memory.buffer, pr, bytes);
            const cells = new Uint8Array(this.memory.buffer, pc, nCells);
            return use(view, info[0], bounds, cells);
        } finally { this._reset(a); }
    }

    /**
     * One `size`² tile of the selection combined with an alpha source (kernels_js.js `selCombine`, the same bytes and
     * extent). `dst` is the tile's RGBA8 as it is, read and never written here; null for a tile that does not exist yet
     * (its alpha taken as 0). The source is what an AlphaSource view gives: `src` from pixel `off`, `stride` pixels a
     * row, `kind` 1 alpha bytes or 4 RGBA8 (0 and 2 read no buffer). Returns the extent [x0, y0, x1, y1] of the combined
     * tile, or null when it holds no pixel; only then is `write()` called, once, for the bytes the whole combined tile
     * is copied into (the tile made writable).
     */
    selCombine(dst, size, src, off, stride, kind, bw, bh, mode, rgb, write) {
        const a = this.job, n = size * size * 4;
        const bpp = kind === 4 ? 4 : kind === 1 ? 1 : 0;
        // what the twin refuses by length (kernels_js.js `selRefused`): a view shorter than its region would otherwise
        // be read past its end, into whatever follows it in the same buffer
        if (dst && !(dst.length >= n)) throw new Error("px: sel_combine: a tile too small");
        if (bpp && bw > 0 && bh > 0 && (!src || !(stride >= bw) || !(off >= 0) || src.length < (off + (bh - 1) * stride + bw) * bpp)) {
            throw new Error("px: sel_combine: a source too small");
        }
        try {
            let ps = 0, sStride = stride;
            if (bpp && bw > 0 && bh > 0) {
                const span = ((bh - 1) * stride + bw) * bpp, packed = bw * bh * bpp;
                if (span <= 2 * packed) {
                    // the span from the region's first pixel to its last, gaps included (a tile's rows: one copy)
                    ps = this._in(a, new Uint8Array(src.buffer, src.byteOffset + off * bpp, span), span);
                } else {
                    // a long row (a band's alpha): the region's rows packed, `bw` pixels a row
                    ps = a.take(packed);
                    sStride = bw;
                    const t = TIMED ? clock() : 0, u8 = this.u8(), row = bw * bpp;
                    for (let y = 0; y < bh; y++) {
                        const at = src.byteOffset + (off + y * stride) * bpp;
                        u8.set(new Uint8Array(src.buffer, at, row), ps + y * row);
                    }
                    if (TIMED) lapIn(t, packed, src.buffer);
                }
            }
            const pd = dst ? this._in(a, dst, n) : a.take(n), pe = a.take(16);
            const r = this.exports.sel_combine(pd, size, ps, sStride, kind, bw, bh, mode | (dst ? 0 : 8), rgb >>> 0, pe);
            if (r === 2) throw new Error(`px: sel_combine refused a tile of ${size} (${bw} x ${bh}, kind ${kind}, mode ${mode})`);
            if (!r) return null;
            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];
            const into = write(true);
            this._out(Uint8Array, pd, n, new Uint8Array(into.buffer, into.byteOffset, n));
            return ext;
        } finally { this._reset(a); }
    }

    /**
     * One `size`² tile of the selection inverted in the `bw` x `bh` corner (kernels_js.js `maskInvert`, the same bytes
     * and extent; K11, docs/PLAN_WASM_BUILD.md §4.3). `tile` is the tile's RGBA8 as it is, read and never written here.
     * Returns the extent [x0, y0, x1, y1] of the inverted tile, or null when it holds no pixel; only then is
     * `write(true)` called, once, for the bytes the whole inverted tile is copied into.
     */
    maskInvert(tile, size, bw, bh, rgb, write) {
        const a = this.job, n = size * size * 4;
        if (!tile || !(tile.length >= n)) throw new Error("px: mask_invert: a tile too small");
        try {
            const pd = this._in(a, tile, n), pe = a.take(16);
            const r = this.exports.mask_invert(pd, size, bw, bh, rgb >>> 0, pe);
            if (r === 2) throw new Error(`px: mask_invert refused a tile of ${size} (${bw} x ${bh})`);
            if (!r) return null;
            const e = this.view(Int32Array, pe, 4), ext = [e[0], e[1], e[2], e[3]];
            const into = write(true);
            this._out(Uint8Array, pd, n, new Uint8Array(into.buffer, into.byteOffset, n));
            return ext;
        } finally { this._reset(a); }
    }

    /**
     * A table that stays in this instance's memory while the instance lives (the resampler's weights and the canvas
     * round trip): copied in on first use, keyed by the array itself.
     */
    _resident(data) {
        const kept = this._kept || (this._kept = new Map());
        let ptr = kept.get(data);
        if (!ptr) {
            ptr = this.alloc(data.byteLength);
            this.put(ptr, data);
            kept.set(data, ptr);
        }
        return ptr;
    }

    /**
     * One block per `kind` that stays in this instance's memory between calls (docs/PLAN_WASM_BUILD.md §3.2, "Resident
     * data"): the first `bytes` of `data` copied in when `key` or the size differs from the slot's, the old block freed
     * first. The caller's key names the data (a worker gets a new view of a SharedArrayBuffer with every message, so no
     * array identity survives between jobs): relight's depth map by its data version and size (K12).
     */
    _slot(kind, key, data, bytes = data.byteLength) {
        const slots = this._slots || (this._slots = new Map());
        const s = slots.get(kind);
        if (s && s.key === key && s.bytes === bytes) return s.ptr;
        if (s) { slots.delete(kind); this.free(s.ptr, s.bytes); }
        const ptr = this.alloc(bytes);
        this.put(ptr, new Uint8Array(data.buffer, data.byteOffset, bytes));
        slots.set(kind, { key, ptr, bytes });
        return ptr;
    }

    /**
     * `resampleBlock` of inpaint_resample.js (the same arguments and bytes): the block and the map in, `vw` x `vh`
     * pixels out into `out` at `off` with `stride` bytes a row; the weight table and the round trip stay resident.
     */
    resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh, weights, taps) {
        const a = this.job;
        try {
            const pb = this._in(a, block, bw * bh * 4);
            const pm = a.take(48);
            this.view(Float64Array, pm, 6).set(fx);
            const pw = this._resident(weights), prt = rt ? this._resident(rt) : 0;
            const n = vw * vh * 4, po = a.take(n);
            const count = this.exports.resample_block(pb, bw, bh, bx, by, pm, pw, taps, alpha ? 1 : 0, rgb >>> 0, prt, po, X0, Y0, vw, vh) >>> 0;
            const src = this.view(Uint8Array, po, n), row = vw * 4, t = TIMED ? clock() : 0;
            if (stride === row) out.set(src, off);
            else for (let j = 0; j < vh; j++) out.set(src.subarray(j * row, j * row + row), off + j * stride);
            if (TIMED) lapOut(t, n);
            return count;
        } finally { this._reset(a); }
    }

    /**
     * `liquifyBlock` of inpaint_liquify.js (the same arguments and bytes, K28): the block and the dense nodes in,
     * `vw` x `vh` pixels out into `out` at `off` with `stride` bytes a row; the bicubic weight table and the round trip
     * stay resident. Returns `null` when the arguments are outside the kernel's contract (the wrapper then runs the twin).
     */
    liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh, weights) {
        if (!(s === 1 || s === 2 || s === 4 || s === 8)) return null;
        if (!(bw >= 4 && bh >= 4 && vw > 0 && vh > 0 && nw >= 2)) return null;
        const ls = 31 - Math.clz32(s);
        const gx0 = (X0 >> ls) - nx0, gx1 = ((X0 + vw - 1) >> ls) - nx0 + 1;
        const gy0 = (Y0 >> ls) - ny0, gy1 = ((Y0 + vh - 1) >> ls) - ny0 + 1;
        const needNodes = (gy1 * nw + gx1 + 1) * 2;
        if (gx0 < 0 || gx1 >= nw || gy0 < 0 || !(nodes instanceof Int32Array) || nodes.length < needNodes) return null;
        const blockBytes = bw * bh * 4, row = vw * 4;
        if (!block || block.byteLength < blockBytes || !out || off < 0 || stride < row || out.byteLength < off + (vh - 1) * stride + row) return null;
        const a = this.job;
        try {
            const pb = this._in(a, block, blockBytes);
            const pn = this._in(a, nodes, needNodes * 4);
            const pw = this._resident(weights), prt = rt ? this._resident(rt) : 0;
            const n = vw * vh * 4, po = a.take(n);
            const count = this.exports.liquify_block(pb, bw, bh, bx, by, pn, needNodes, nw, nx0, ny0, s, pw, prt, po, X0, Y0, vw, vh) >>> 0;
            const src = this.view(Uint8Array, po, n), t = TIMED ? clock() : 0;
            if (stride === row) out.set(src, off);
            else for (let j = 0; j < vh; j++) out.set(src.subarray(j * row, j * row + row), off + j * stride);
            if (TIMED) lapOut(t, n);
            return count;
        } finally { this._reset(a); }
    }

    /**
     * `previewBlock` of inpaint_liquify.js (the same arguments and bytes, K29): `win` (`{ px, ptr, data, w, h, x0, y0, L }`)
     * is read where `px.alloc` put it (`win.ptr` on `this`, or copied from `win.data` when `win` is a plain buffer in
     * tests); the field's dense nodes over the box are taken with `field.nodes` and `bw` x `bh` RGBA8 pixels are written
     * into `out`. Returns `true` when done, `false` when the arguments lie outside the kernel's contract.
     */
    liquifyPreview(win, field, ox, oy, inv, out, bw, bh) {
        if (!win || !field || !out) return false;
        const s = field.s, ww = win.w, wh = win.h, lw = field.w, lh = field.h, L = win.L;
        if (!(s === 1 || s === 2 || s === 4 || s === 8)) return false;
        if (!(ww > 0 && wh > 0 && lw > 0 && lh > 0 && bw > 0 && bh > 0 && L >= 0 && L <= 16)) return false;
        if (!(inv > 0 && Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(inv))) return false;
        const winBytes = ww * wh * 4, outBytes = bw * bh * 4;
        if (out.byteLength < outBytes) return false;
        const held = win.px === this && win.ptr > 0;
        if (win.px && !held) return false;
        if (held ? win.ptr + winBytes > this.byteLength : (!win.data || win.data.byteLength < winBytes)) return false;
        const xmax = field.ni * s, ymax = field.nj * s;
        const x0 = Math.max(0, Math.min(xmax, Math.max(0, ox + 0.5 * inv) - 0.5));
        const x1 = Math.max(x0, Math.min(xmax, Math.min(lw, ox + (bw - 0.5) * inv) - 0.5));
        const y0 = Math.max(0, Math.min(ymax, Math.max(0, oy + 0.5 * inv) - 0.5));
        const y1 = Math.max(y0, Math.min(ymax, Math.min(lh, oy + (bh - 0.5) * inv) - 0.5));
        const nx0 = Math.floor(x0 / s), nx1 = Math.floor(x1 / s) + 1, nw = nx1 - nx0 + 1;
        const ny0 = Math.floor(y0 / s), ny1 = Math.floor(y1 / s) + 1, nh = ny1 - ny0 + 1;
        const nodes = typeof field.nodes === "function" ? field.nodes(nx0, ny0, nw, nh) : null;
        if (!(nodes instanceof Int32Array) || nodes.length < nw * nh * 2) return false;
        const a = this.job;
        try {
            const pwin = held ? win.ptr : this._in(a, win.data, winBytes);
            const pn = this._in(a, nodes, nodes.byteLength);
            const po = a.take(outBytes);
            const ok = this.exports.liquify_preview(pwin, ww, wh, win.x0 | 0, win.y0 | 0, L >>> 0, lw, lh, s, pn, nodes.length, nw, nx0, ny0, ox, oy, inv, po, bw, bh) >>> 0;
            if (!ok) return false;
            this._out(Uint8Array, po, outBytes, new Uint8Array(out.buffer, out.byteOffset, outBytes));
            return true;
        } finally { this._reset(a); }
    }

    /**
     * `liquifyDabNodes` of inpaint_liquify.js (the same arguments and nodes, K31): when `src` is a `LiquifyField`
     * (`LiquifyField.dab`), `field.nodes` fills the arena's input block in wasm memory directly (after every arena block
     * is taken, so no view is held across an allocation) and `field._writeDense` scatters the changed rows directly from
     * a view of the arena's output block; when `src` and `out` are `Int32Array`s (standalone calls), copies in and out.
     * Returns the changed node count (`0..ow*oh`), or `null` when the arguments lie outside the kernel's contract.
     */
    liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {
        const modeId = LIQUIFY_MODE_ID[mode];
        if (modeId === undefined) return null;
        if (!(s === 1 || s === 2 || s === 4 || s === 8)) return null;
        if (!(sw > 0 && ow > 0 && oh > 0 && ni > 0 && nj > 0 && r > 0 && amount > 0)) return null;
        const hVal = Math.min(0.8, Math.max(0, +h || 0));
        const dx = modeId === 0 ? +dxStep : 0, dy = modeId === 0 ? +dyStep : 0;
        if (modeId === 0 && !(dx || dy)) return null;
        if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && Number.isFinite(hVal) && Number.isFinite(amount) && Number.isFinite(dx) && Number.isFinite(dy))) return null;
        if (!(box instanceof Int32Array) || box.length < 4) return null;
        const i1 = i0 + ow - 1, j1 = j0 + oh - 1, restore = modeId === 5;
        if (i0 < 0 || j0 < 0 || i0 < si0 || j0 < sj0 || i1 - si0 >= sw) return null;
        const planeBytes = ow * oh, need = planeBytes * 2;
        if ((sel && (!isBytes(sel) || sel.byteLength < planeBytes)) || (freeze && (!isBytes(freeze) || freeze.byteLength < planeBytes))) return null;
        if (src && typeof src.nodes === "function") {
            const field = src, sh = field._dabSh | 0, before = out && typeof out.get === "function" ? out : null;
            if (!(sh > 0 && j1 - sj0 < sh && (restore || (i1 - si0 + 1 < sw && j1 - sj0 + 1 < sh)))) return null;
            const sNeed = sw * sh * 2, a = this.job;
            try {
                const ps = a.take(sNeed * 4), po = a.take(need * 4);
                const psel = sel ? this._in(a, sel, planeBytes) : 0;
                const pfrz = freeze ? this._in(a, freeze, planeBytes) : 0;
                const pbox = a.take(16);
                const sView = this.view(Int32Array, ps, sNeed), tIn = TIMED ? clock() : 0;
                const got = field.nodes(si0, sj0, sw, sh, sView);
                if (!(got instanceof Int32Array) || got.length < sNeed) return null;
                if (got.buffer !== this.memory.buffer || got.byteOffset !== ps) sView.set(got.subarray(0, sNeed));
                if (TIMED) lapIn(tIn, sNeed * 4, null);
                const count = this.exports.liquify_dab(modeId, ps, sw, sh, si0, sj0, s, ni, nj, cx, cy, r, hVal, amount, dx, dy, psel, pfrz, i0, j0, ow, oh, po, pbox) >>> 0;
                if (count === 0xffffffff) return null;
                if (count > 0) {
                    const b = this.view(Int32Array, pbox, 4);
                    box[0] = b[0]; box[1] = b[1]; box[2] = b[2]; box[3] = b[3];
                    if (typeof field._writeDense === "function") {
                        const tOut = TIMED ? clock() : 0;
                        field._writeDense(this.view(Int32Array, po, need), i0, j0, ow, b[0], b[1], b[2], b[3], before, restore);
                        if (TIMED) lapOut(tOut, (b[2] - b[0] + 1) * (b[3] - b[1] + 1) * 8);
                    }
                }
                return count;
            } finally { this._reset(a); }
        }
        if (!(src instanceof Int32Array) || !(out instanceof Int32Array) || out.length < need) return null;
        const sh = Math.floor(src.length / (sw * 2));
        if (!(j1 - sj0 < sh && (restore || (i1 - si0 + 1 < sw && j1 - sj0 + 1 < sh)))) return null;
        const sNeed = sw * sh * 2, a = this.job;
        try {
            const ps = this._in(a, src, sNeed * 4), po = a.take(need * 4);
            const psel = sel ? this._in(a, sel, planeBytes) : 0;
            const pfrz = freeze ? this._in(a, freeze, planeBytes) : 0;
            const pbox = a.take(16);
            const count = this.exports.liquify_dab(modeId, ps, sw, sh, si0, sj0, s, ni, nj, cx, cy, r, hVal, amount, dx, dy, psel, pfrz, i0, j0, ow, oh, po, pbox) >>> 0;
            if (count === 0xffffffff) return null;
            this._out(Int32Array, po, need, out.length === need ? out : out.subarray(0, need));
            if (count > 0) {
                const b = this.view(Int32Array, pbox, 4);
                box[0] = b[0]; box[1] = b[1]; box[2] = b[2]; box[3] = b[3];
            }
            return count;
        } finally { this._reset(a); }
    }

    /** One smudge dab (kernels_js.js `smudgeDab`): `dst` and `carry` in place. */
    smudgeDab(dst, src, carry, mask, strength, keep, flags = 0) {
        const a = this.job, n = mask.length;
        try {
            const pd = this._in(a, dst, n * 4), ps = this._in(a, src, n * 4), pc = this._in(a, carry, n * 8), pm = this._in(a, mask, n);
            this.exports.smudge_dab(pd, ps, pc, pm, n, strength >>> 0, keep >>> 0, flags >>> 0);
            this._out(Uint16Array, pc, n * 4, carry);
            return this._out(Uint8Array, pd, n * 4, dst);
        } finally { this._reset(a); }
    }

    /** The healing brush's Poisson blend over a box (kernels_js.js `poissonBlend`); `info` (4 ints) optional. */
    poissonBlend(dst, src, mask, w, h, out = null, info = null) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, dst, n * 4), ps = this._in(a, src, n * 4), pm = this._in(a, mask, n), po = a.take(n * 4), pi = a.take(16);
            this.exports.poisson_blend(pd, ps, pm, w, h, po, pi);
            if (info) info.set(this.view(Int32Array, pi, 4));
            return this._out(Uint8Array, po, n * 4, out);
        } finally { this._reset(a); }
    }

    compositeTile(dst, srcs, ops, alphas, masks = null) {
        const a = this.job, px = dst.byteLength >> 2, n = srcs.length;
        try {
            const pd = this._in(a, dst);
            const psrcs = a.take(4 * n), pmasks = a.take(4 * n), pops = a.take(n), palphas = a.take(n);
            const sp = [], mp = [];
            for (let i = 0; i < n; i++) {
                sp.push(this._in(a, srcs[i], px * 4));
                mp.push(masks && masks[i] ? this._in(a, masks[i], px) : 0);
            }
            const u32 = this.u32(), u8 = this.u8();
            for (let i = 0; i < n; i++) {
                u32[(psrcs >>> 2) + i] = sp[i];
                u32[(pmasks >>> 2) + i] = mp[i];
                u8[pops + i] = ops[i];
                u8[palphas + i] = alphas[i];
            }
            this.exports.composite_tile(pd, px, n, psrcs, pops, palphas, pmasks);
            return this._out(Uint8Array, pd, px * 4, dst);
        } finally { this._reset(a); }
    }

    /**
     * One tile of `px` pixels (`src` straight RGBA8, `op` an OPS number, `alpha` 0..255, optional `mask` of `px`
     * coverage bytes) composited over `dst` (`px * 4` straight RGBA8 bytes, or null when the destination tile does not
     * exist yet), keeping `dst` (or 0) untouched where `src` has alpha 0 or `mask` is 0 (`compositeStroke` in
     * `inpaint_tiles.js`, K36). Returns 0 when no pixel changed, 1 when changed and non-empty (calling `write(true)`
     * once for the buffer all `px * 4` bytes are copied into), 2 when changed and every pixel has alpha 0 afterwards.
     */
    compositeMaskedTile(dst, src, op, alpha, mask, px, write) {
        const a = this.job, n = px * 4;
        if (!Number.isInteger(px) || px <= 0 || px > 4096 * 4096) throw new Error(`px: composite_masked_tile: refused ${px} pixels`);
        if (!src || !(src.length >= n)) throw new Error("px: composite_masked_tile: a source too small");
        if (dst && !(dst.length >= n)) throw new Error("px: composite_masked_tile: a tile too small");
        if (mask && !(mask.length >= px)) throw new Error("px: composite_masked_tile: a mask too small");
        if (typeof write !== "function") throw new Error("px: composite_masked_tile: no write callback");
        try {
            const pd = dst ? this._in(a, dst, n) : a.take(n);
            const ps = this._in(a, src, n);
            const pm = mask ? this._in(a, mask, px) : 0;
            const r = this.exports.composite_masked_tile(pd, dst ? 1 : 0, ps, px, op | 0, alpha | 0, pm);
            if (r === 3) throw new Error(`px: composite_masked_tile: refused ${px} pixels`);
            if (r === 1) {
                const into = write(true);
                this._out(Uint8Array, pd, n, new Uint8Array(into.buffer, into.byteOffset, n));
            }
            return r;
        } finally { this._reset(a); }
    }

    pngFilterRows(rgba, w, rows, prev = null, out = null) {
        const a = this.job, n = rows * (1 + 4 * w);
        try {
            const pr = this._in(a, rgba, rows * 4 * w), pp = prev ? this._in(a, prev, 4 * w) : 0, po = a.take(n);
            this.exports.png_filter_rows(pr, w, rows, pp, po);
            return this._out(Uint8Array, po, n, out);
        } finally { this._reset(a); }
    }

    /**
     * PackBits of the four channels of `rows` rows of RGBA8 for a PSD (docs/PLAN_BCE.md §E4), the bytes of
     * inpaint_export.js `packBits`: `[{ lens, data }]` for R, G, B, A, `lens` each row's packed length as big-endian
     * u16 (the table a PSD puts in front of a channel), `data` the packed rows one after the other. Copies.
     */
    psdPackRows(rgba, w, rows) {
        const a = this.job;
        try {
            const pr = this._in(a, rgba, rows * 4 * w);
            const cap = this.exports.psd_pack_rows_cap(w, rows), po = a.take(cap), pl = a.take(rows * 2);
            const out = [];
            for (let ch = 0; ch < 4; ch++) {
                const n = this.exports.psd_pack_rows(pr, w, rows, ch, po, cap, pl);
                if (n < 0) throw new Error("px: psd_pack_rows ran out of room");
                const t = TIMED ? clock() : 0;
                out.push({ lens: this.u8().slice(pl, pl + rows * 2), data: this.u8().slice(po, po + n) });
                if (TIMED) lapOut(t, rows * 2 + n);
            }
            return out;
        } finally { this._reset(a); }
    }

    /**
     * One part of a PNG's zlib stream (docs/PLAN_BCE.md §E2, K3): `rows` rows of RGBA8 filtered (`pngFilterRows`),
     * deflated raw at `level` (every part but the `last` ending on a sync flush, so the parts of a picture are one
     * deflate stream when written one after the other) and framed in wasm as an `IDAT` chunk (`png_chunk_frame`).
     * `{ bytes, adler, raw, chunk, crc }`: `chunk` the whole framed IDAT chunk (a copy), `bytes` its deflated payload
     * (`chunk.subarray(8, 8 + written)`), `crc` the chunk's CRC-32 over type and data, `adler` the Adler-32 of its
     * `raw` filtered bytes alone (joined by `adlerCombine`). `laps` (optional, on `pngPart` below): the milliseconds of
     * `copyIn` (the rows into memory), `filter`, `adler`, `deflate` (summed over its retries), `chunk` and `copyOut`
     * are added to its fields.
     */
    /** A whole zlib stream of `bytes` (a TIFF strip, inpaint_tiff.js): `78 9C`, one final deflate part, the Adler-32. */
    zlib(bytes, level) {
        const a = this.job, n = bytes.length;
        try {
            const pi = this._in(a, bytes, n);
            const adler = this.exports.adler32(pi, n, 1) >>> 0;
            let cap = storedCap(n);
            for (;;) {
                const po = a.take(cap);
                const written = this.exports.deflate_part(pi, n, level, 1, po, cap);
                if (written >= 0) {
                    const t = TIMED ? clock() : 0;
                    const out = new Uint8Array(written + 6);
                    out[0] = 0x78; out[1] = 0x9C;
                    out.set(this.u8().subarray(po, po + written), 2);
                    if (TIMED) lapOut(t, written);
                    out[written + 2] = adler >>> 24; out[written + 3] = (adler >>> 16) & 255; out[written + 4] = (adler >>> 8) & 255; out[written + 5] = adler & 255;
                    return out;
                }
                cap *= 2;
            }
        } finally { this._reset(a); }
    }

    crc32(bytes, start = 0) {
        const a = this.job, n = bytes.byteLength;
        try {
            const ps = n > 0 ? this._in(a, bytes, n) : 0;
            return this.exports.crc32(ps, n, start >>> 0) >>> 0;
        } finally { this._reset(a); }
    }

    pngChunkFrame(buf, dataLen = buf.byteLength - 12, kind = 0x49444154) {
        const a = this.job, n = dataLen + 12;
        try {
            const pb = this._in(a, buf, n);
            const crc = this.exports.png_chunk_frame(pb, dataLen, kind >>> 0) >>> 0;
            this._out(Uint8Array, pb, n, new Uint8Array(buf.buffer, buf.byteOffset, n));
            return crc;
        } finally { this._reset(a); }
    }

    pngPart(rgba, w, rows, prev, level, last, laps = null) {
        const a = this.job, n = rows * (1 + 4 * w);
        const lap = laps ? lapper(laps) : null;
        try {
            const pr = this._in(a, rgba, rows * 4 * w), pp = prev ? this._in(a, prev, 4 * w) : 0, pf = a.take(n);
            if (lap) lap("copyIn");
            this.exports.png_filter_rows(pr, w, rows, pp, pf);
            if (lap) lap("filter");
            const adler = this.exports.adler32(pf, n, 1) >>> 0;
            if (lap) lap("adler");
            let cap = storedCap(n);
            for (;;) {
                const po = a.take(cap + 12);
                const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap);
                if (lap) lap("deflate");
                if (written >= 0) {
                    const crc = this.exports.png_chunk_frame(po, written, 0x49444154) >>> 0;
                    if (lap) lap("chunk");
                    const t = TIMED ? clock() : 0;
                    const chunk = this.u8().slice(po, po + written + 12);
                    const bytes = chunk.subarray(8, 8 + written);
                    if (TIMED) lapOut(t, written + 12);
                    if (lap) lap("copyOut");
                    return { bytes, adler, raw: n, chunk, crc };
                }
                cap *= 2;
            }
        } finally { this._reset(a); }
    }

    /**
     * Byte capacity of `lines` for a standard `PART_BYTES` (`8 MB`) part of a `w`-wide 8-bit RGBA PNG
     * (`partRows(w) * (1 + 4 * w)`), or 0 when `w <= 0` (K7, docs/PLAN_WASM_BUILD.md §4.2).
     */
    pngPartLinesCap(w) {
        if (!Number.isInteger(w) || w <= 0 || w > 0x3fffffff) return 0;
        return this.exports.png_part_lines_cap(w) >>> 0;
    }

    /**
     * Decode one inflated part (`lines`, a whole number of `1 + 4 * w`-byte scanlines) of a `w`-wide 8-bit RGBA PNG
     * (K7, docs/PLAN_WASM_BUILD.md §4.2). When `rt` (the 65,536-byte CPU-canvas round-trip table) is given it stays
     * resident in this instance (`_resident`). `laps` (optional) records `copyIn`, `decode`, `copyOut` in ms.
     */
    pngPartDecode(lines, w, prev = null, rt = null, out = null, laps = null) {
        if (!lines || !Number.isInteger(w) || w <= 0 || w > 0x3fffffff) return { code: -4 };
        const lLen = lines.byteLength;
        const rowBytes = w * 4, stride = rowBytes + 1;
        if (lLen === 0 || lLen % stride !== 0) return { code: -4 };
        if (prev != null && prev.byteLength < rowBytes) return { code: -4 };
        if (rt != null && rt.byteLength < 65536) return { code: -4 };
        const rows = lLen / stride;
        const outBytes = rows * rowBytes;
        if (out != null && out.byteLength < outBytes) return { code: -4 };
        const a = this.job, lap = laps ? lapper(laps) : null;
        try {
            const prt = rt ? this._resident(rt) : 0;
            const pl = this._in(a, lines, lLen);
            const pp = prev ? this._in(a, prev, rowBytes) : 0;
            const po = a.take(outBytes), pi = a.take(20);
            if (lap) lap("copyIn");
            const code = this.exports.png_part_decode(pl, lLen, w, pp, prt, po, pi);
            if (lap) lap("decode");
            if (code < 0) return { code };
            const info = this.view(Uint32Array, pi, 5);
            const adler = info[1] >>> 0, firstFilter = info[2] >>> 0, opaque = info[3] === 1, needsPrev = info[4] === 1;
            if (needsPrev) {
                if (lap) lap("copyOut");
                return { code, rows, adler, firstFilter, opaque: false, needsPrev: true, out: null, prev: null };
            }
            const dst = this._out(Uint8Array, po, outBytes, out);
            const lastRow = prev
                ? this._out(Uint8Array, pp, rowBytes, prev)
                : this._out(Uint8Array, pl + (rows - 1) * stride + 1, rowBytes, null);
            if (lap) lap("copyOut");
            return { code, rows, adler, firstFilter, opaque, needsPrev: false, out: dst, prev: lastRow };
        } finally { this._reset(a); }
    }

    /**
     * Finish a part whose `pngPartDecode` answered `needsPrev: true` once `prev` (`4 * w` unfiltered bytes from the
     * row above) is ready (K7, docs/PLAN_WASM_BUILD.md §4.2). `laps` (optional) records `copyIn`, `finish`, `copyOut`.
     */
    pngPartFinish(lines, rows, w, prev, rt = null, out = null, laps = null) {
        if (!lines || !prev || !Number.isInteger(w) || w <= 0 || w > 0x3fffffff || !Number.isInteger(rows) || rows <= 0) {
            return { code: -4 };
        }
        const lLen = lines.byteLength;
        const rowBytes = w * 4, stride = rowBytes + 1;
        if (lLen !== rows * stride || prev.byteLength < rowBytes) return { code: -4 };
        if (rt != null && rt.byteLength < 65536) return { code: -4 };
        const outBytes = rows * rowBytes;
        if (out != null && out.byteLength < outBytes) return { code: -4 };
        const a = this.job, lap = laps ? lapper(laps) : null;
        try {
            const prt = rt ? this._resident(rt) : 0;
            const pl = this._in(a, lines, lLen);
            const pp = this._in(a, prev, rowBytes);
            const po = a.take(outBytes), pi = a.take(20);
            if (lap) lap("copyIn");
            const code = this.exports.png_part_finish(pl, rows, w, pp, prt, po, pi);
            if (lap) lap("finish");
            if (code < 0) return { code };
            const info = this.view(Uint32Array, pi, 5);
            const firstFilter = info[2] >>> 0, opaque = info[3] === 1;
            const dst = this._out(Uint8Array, po, outBytes, out);
            this._out(Uint8Array, pp, rowBytes, prev);
            if (lap) lap("copyOut");
            return { code, rows, firstFilter, opaque, needsPrev: false, out: dst, prev };
        } finally { this._reset(a); }
    }

    /**
     * Per-tile minimum, maximum, and edge flag over a depth map (`map` and optional `rmax`, `mw` x `mh` u16) for a
     * `W` x `H` document in `tile`² tiles (K21, docs/PLAN_WASM_BUILD.md §4.8). Copies only the map row window `[wy0..wy1]`
     * that each document tile row `ty` can read, never the whole map at once. `min` / `max` clamp the 2-texel window on
     * both sides to `[0, mw - 1] x [0, mh - 1]`; `edge` is set only when the unclamped window meets the map.
     */
    mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {
        if (!map || !(mw > 0) || !(mh > 0) || !(W > 0) || !(H > 0) || !(tile > 0) || !Array.isArray(xf) || xf.length < 6) {
            throw new Error("mapTileStats: bad arguments");
        }
        const [m0, m1, m2, m3, m4, m5] = xf;
        if (!Number.isFinite(m0) || !Number.isFinite(m1) || !Number.isFinite(m2) || !Number.isFinite(m3) || !Number.isFinite(m4) || !Number.isFinite(m5)) {
            throw new Error("mapTileStats: non-finite xf");
        }
        if (map.length < mw * mh) throw new Error("mapTileStats: short map");
        const hasRmax = rmax != null && rmax.length > 0;
        if (hasRmax && rmax.length < mw * mh) throw new Error("mapTileStats: short rmax");
        const thr = hasRmax ? Math.max(0, Math.min(0xffffffff, Math.floor(Number(thresh) || 0))) : 0;
        const cols = Math.ceil(W / tile);
        const rows = Math.ceil(H / tile);
        const min = new Uint16Array(cols * rows);
        const max = new Uint16Array(cols * rows);
        const edge = new Uint8Array(cols * rows);
        const a = this.job;
        for (let ty = 0; ty < rows; ty++) {
            const y0 = ty * tile;
            const y1 = Math.min(H, (ty + 1) * tile);
            const ry00 = m1 * 0 + m3 * y0 + m5;
            const ry10 = m1 * W + m3 * y0 + m5;
            const ry01 = m1 * 0 + m3 * y1 + m5;
            const ry11 = m1 * W + m3 * y1 + m5;
            const ryMin = Math.min(ry00, ry10, ry01, ry11);
            const ryMax = Math.max(ry00, ry10, ry01, ry11);
            const wy0 = Number.isFinite(ryMin) ? Math.max(0, Math.min(mh - 1, Math.floor(ryMin - 2))) : 0;
            const wy1 = Number.isFinite(ryMax) ? Math.max(0, Math.min(mh - 1, Math.ceil(ryMax + 2))) : mh - 1;
            const wh = wy1 - wy0 + 1;
            const wLen = wh * mw;
            const wStart = wy0 * mw;
            try {
                const pm = this._in(a, map.subarray(wStart, wStart + wLen), wLen * 2);
                const pr = hasRmax ? this._in(a, rmax.subarray(wStart, wStart + wLen), wLen * 2) : 0;
                const pMin = a.take(cols * 2);
                const pMax = a.take(cols * 2);
                const pEdge = a.take(cols);
                const ok = this.exports.map_tile_stats(
                    pm, pr, mw, mh, wy0, wh, W, y0, y1, tile,
                    m0, m1, m2, m3, m4, m5, thr,
                    pMin, pMax, pEdge
                );
                if (!ok) throw new Error("map_tile_stats: refused");
                const rowOff = ty * cols;
                const t = TIMED ? clock() : 0;
                min.set(this.view(Uint16Array, pMin, cols), rowOff);
                max.set(this.view(Uint16Array, pMax, cols), rowOff);
                edge.set(this.view(Uint8Array, pEdge, cols), rowOff);
                if (TIMED) lapOut(t, cols * 5);
            } finally { this._reset(a); }
        }
        return { min, max, edge, cols, rows };
    }

    /**
     * Evaluates the `"compute"`-class tiles (`classes[tx] === 2` or `"compute"`, or every column when `classes` is
     * null) of one document tile row `ty` (`[y0, y1)` clipped to `[ty * tile, min((ty + 1) * tile, H))`) over a depth
     * map (`map`, `mw` x `mh` u16, affine transform `xf`) and optional joint-bilateral snap (`snap = [sigmaR, tau]`,
     * `guide`, `pic`) (K22, docs/PLAN_WASM_BUILD.md §4.8). Copies only the map/guide row window `[wy0..wy1]` that tile
     * row `ty` can read, and slices each partial tile out of wasm memory. Returns `{ tiles, bounds, alphaSum }`, or
     * `null` when the arguments lie outside the kernel's contract (the wrapper then runs the JS twin).
     */
    rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert = false, snap = null, guide = null, pic = null, classes = null, tile = 256) {
        if (!map || !limit || !(mw > 0) || !(mh > 0) || !(W > 0) || !(H > 0) || !(tile > 0 && tile <= 4096) || !(ty >= 0) || !(y0 < y1) || !Array.isArray(xf) || xf.length < 6) {
            throw new Error("rangeTilesDepth: bad arguments");
        }
        const [m0, m1, m2, m3, m4, m5] = xf;
        const lo = +limit.lo || 0, hi = +limit.hi || 0, fLo = +limit.fLo || 0, fHi = +limit.fHi || 0;
        const sigmaR = Array.isArray(snap) && snap.length >= 2 ? +snap[0] || 0 : 0;
        const tau = Array.isArray(snap) && snap.length >= 2 ? +snap[1] || 0 : 0;
        if (![m0, m1, m2, m3, m4, m5, lo, hi, fLo, fHi, sigmaR, tau].every(Number.isFinite)) {
            throw new Error("rangeTilesDepth: non-finite parameters");
        }
        if (map.length < mw * mh) throw new Error("rangeTilesDepth: short map");

        const cols = Math.ceil(W / tile);
        if (classes && classes.length < cols) throw new Error("rangeTilesDepth: short classes");
        const clsBytes = new Uint8Array(cols);
        let nCompute = 0, minTx = cols, maxTx = -1;
        for (let tx = 0; tx < cols; tx++) {
            const c = classes ? classes[tx] : 2;
            if (c === 2 || c === "compute") {
                clsBytes[tx] = 2;
                if (tx < minTx) minTx = tx;
                maxTx = tx;
                nCompute++;
            }
        }
        const tileY0 = ty * tile;
        const tileY1 = Math.min(tileY0 + tile, H);
        const ry0 = Math.max(tileY0, y0);
        const ry1 = Math.min(tileY1, y1);

        let gBytes = null;
        if (guide) {
            const gd = guide.data || guide;
            const gw = guide.w != null ? guide.w | 0 : mw;
            const gh = guide.h != null ? guide.h | 0 : mh;
            if (!gd || gw !== mw || gh !== mh) throw new Error("rangeTilesDepth: bad guide");
            gBytes = gd instanceof Uint8Array ? gd : new Uint8Array(gd.buffer, gd.byteOffset, gd.byteLength);
            if (gBytes.length < mw * mh * 4) throw new Error("rangeTilesDepth: short guide");
        }
        let pBytes = null, picX0 = 0, picY0 = 0, picW = 0, picH = 0;
        if (pic && pic.data && (pic.w | 0) > 0 && (pic.h | 0) > 0) {
            if ((pic.x0 | 0) < 0 || (pic.y0 | 0) < 0) throw new Error("rangeTilesDepth: bad pic origin");
            picX0 = pic.x0 | 0;
            picY0 = pic.y0 | 0;
            picW = pic.w | 0;
            picH = pic.h | 0;
            const pd = pic.data;
            pBytes = pd instanceof Uint8Array ? pd : new Uint8Array(pd.buffer, pd.byteOffset, pd.byteLength);
            if (pBytes.length < picW * picH * 4) throw new Error("rangeTilesDepth: short pic");
        }
        if (nCompute === 0 || !(ry0 < ry1)) {
            return { tiles: [], bounds: null, alphaSum: 0 };
        }
        const snapOn = sigmaR > 0 && gBytes !== null && pBytes !== null;

        const rx0 = minTx * tile;
        const rx1 = Math.min((maxTx + 1) * tile, W);
        const ry00 = m1 * rx0 + m3 * ry0 + m5;
        const ry10 = m1 * rx1 + m3 * ry0 + m5;
        const ry01 = m1 * rx0 + m3 * ry1 + m5;
        const ry11 = m1 * rx1 + m3 * ry1 + m5;
        const wy0 = Math.max(0, Math.min(mh - 1, Math.floor(Math.min(ry00, ry10, ry01, ry11) - 2)));
        const wy1 = Math.max(0, Math.min(mh - 1, Math.ceil(Math.max(ry00, ry10, ry01, ry11) + 2)));
        const wh = wy1 - wy0 + 1;
        const wLen = wh * mw;
        const wStart = wy0 * mw;
        const tileBytes = tile * tile;
        const flags = (limit.invert ? 1 : 0) | (invert ? 2 : 0);

        const a = this.job;
        try {
            const pm = this._in(a, map.subarray(wStart, wStart + wLen), wLen * 2);
            const pg = snapOn ? this._in(a, gBytes.subarray(wStart * 4, (wStart + wLen) * 4), wLen * 4) : 0;
            const pp = snapOn ? this._in(a, pBytes.subarray(0, picW * picH * 4), picW * picH * 4) : 0;
            const pCls = this._in(a, clsBytes, cols);
            const pParams = a.take(12 * 8);
            const pv = this.view(Float64Array, pParams, 12);
            pv[0] = m0; pv[1] = m1; pv[2] = m2; pv[3] = m3; pv[4] = m4; pv[5] = m5;
            pv[6] = lo; pv[7] = hi; pv[8] = fLo; pv[9] = fHi; pv[10] = snapOn ? sigmaR : 0; pv[11] = tau;
            const pAlpha = a.take(nCompute * tileBytes);
            const pStatus = a.take(cols);
            const pInfo = a.take(5 * 8);

            const ok = this.exports.range_tiles_depth(
                pm, pg, pp, mw, mh, wy0, wh,
                picX0, picY0, picW, picH,
                W, H, ty, y0, y1, tile,
                pCls, pParams, flags,
                pAlpha, pStatus, pInfo
            );
            if (!ok) throw new Error("range_tiles_depth: refused");

            const t = TIMED ? clock() : 0;
            const st = this.view(Uint8Array, pStatus, cols);
            const info = this.view(Float64Array, pInfo, 5);
            const u8 = this.u8();
            const tiles = [];
            let slot = 0;
            for (let tx = 0; tx < cols; tx++) {
                const s = st[tx];
                if (s === 2) {
                    tiles.push({ tx, ty, full: true });
                } else if (s === 1) {
                    const at = pAlpha + slot * tileBytes;
                    tiles.push({ tx, ty, alpha: u8.slice(at, at + tileBytes).buffer });
                    slot++;
                }
            }
            if (TIMED) lapOut(t, slot * tileBytes + cols + 40);
            const bounds = info[1] >= 0 ? [info[1], info[2], info[3], info[4]] : null;
            return { tiles, bounds, alphaSum: info[0] };
        } finally { this._reset(a); }
    }

    /**
     * Evaluates one document tile row `ty` (`[y0, y1)` clipped to `[ty * tile, min((ty + 1) * tile, H))`) over a
     * `(y1 - y0)`-row RGBA8 band `rgba` (`W * (y1 - y0) * 4` bytes) for `"luma"` or `"color"` range selection (K23,
     * docs/PLAN_WASM_BUILD.md §4.8). Copies only the single tile row's `[ry0, ry1)` RGBA8 slice (`(ry1 - ry0) * W * 4`
     * bytes, at most 15.4 MB at 15000 x 256, never the 61.4 MB band) into wasm memory and slices each partial tile out.
     * Returns `{ tiles, bounds, alphaSum }`.
     */
    rangeTilesRgba(rgba, W, H, ty, y0, y1, limit, invert = false, tile = 256) {
        if (!rgba || !limit || !(W > 0) || !(H > 0) || !(tile > 0 && tile <= 4096) || !(ty >= 0) || !(y0 >= 0) || !(y0 < y1) || !(y1 <= H)) {
            throw new Error("rangeTilesRgba: bad arguments");
        }
        const u8 = rgba instanceof Uint8Array
            ? rgba
            : (rgba.buffer instanceof ArrayBuffer || (SAB && rgba.buffer instanceof SAB))
                ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
                : (rgba instanceof ArrayBuffer || (SAB && rgba instanceof SAB))
                    ? new Uint8Array(rgba)
                    : null;
        if (!u8 || u8.length < (y1 - y0) * W * 4) throw new Error("rangeTilesRgba: short rgba");

        const isColor = limit.source === "color" || (limit.source !== "luma" && limit.color != null);
        const lo = limit.lo == null ? 0 : +limit.lo;
        const hi = limit.hi == null ? 0 : +limit.hi;
        const fLo = limit.fLo == null ? 0 : +limit.fLo;
        const fHi = limit.fHi == null ? 0 : +limit.fHi;
        const tol = limit.tol == null ? 30 : +limit.tol;
        let refL = 0, refA = 0, refB = 0;
        if (isColor) {
            const [r, g, b] = rangeHexToRgb01(limit.color || "#ffffff");
            refL = 0.299 * r + 0.587 * g + 0.114 * b;
            refA = r - refL;
            refB = b - refL;
        }
        if (![lo, hi, fLo, fHi, refL, refA, refB, tol].every(Number.isFinite)) {
            throw new Error("rangeTilesRgba: non-finite parameters");
        }

        const tileY0 = ty * tile;
        const tileY1 = Math.min(tileY0 + tile, H);
        const ry0 = Math.max(tileY0, y0);
        const ry1 = Math.min(tileY1, y1);
        if (!(ry0 < ry1)) {
            return { tiles: [], bounds: null, alphaSum: 0 };
        }

        const cols = Math.ceil(W / tile);
        const tileBytes = tile * tile;
        const rowStart = (ry0 - y0) * W * 4;
        const rowBytes = (ry1 - ry0) * W * 4;
        const rowSlice = u8.subarray(rowStart, rowStart + rowBytes);
        const mode = isColor ? 1 : 0;
        const flags = (limit.invert ? 1 : 0) | (invert ? 2 : 0);

        const a = this.job;
        try {
            const pRgba = this._in(a, rowSlice, rowBytes);
            const pParams = a.take(8 * 8);
            const pv = this.view(Float64Array, pParams, 8);
            pv[0] = lo; pv[1] = hi; pv[2] = fLo; pv[3] = fHi;
            pv[4] = refL; pv[5] = refA; pv[6] = refB; pv[7] = tol;
            const pAlpha = a.take(cols * tileBytes);
            const pStatus = a.take(cols);
            const pInfo = a.take(5 * 8);

            const ok = this.exports.range_tiles_rgba(
                pRgba, W, H, ty, ry0, ry1, tile,
                mode, pParams, flags,
                pAlpha, pStatus, pInfo
            );
            if (!ok) throw new Error("range_tiles_rgba: refused");

            const t = TIMED ? clock() : 0;
            const st = this.view(Uint8Array, pStatus, cols);
            const info = this.view(Float64Array, pInfo, 5);
            const mem = this.u8();
            const tiles = [];
            let slot = 0;
            for (let tx = 0; tx < cols; tx++) {
                const s = st[tx];
                if (s === 2) {
                    tiles.push({ tx, ty, full: true });
                } else if (s === 1) {
                    const at = pAlpha + slot * tileBytes;
                    tiles.push({ tx, ty, alpha: mem.slice(at, at + tileBytes).buffer });
                    slot++;
                }
            }
            if (TIMED) lapOut(t, slot * tileBytes + cols + 40);
            const bounds = info[1] >= 0 ? [info[1], info[2], info[3], info[4]] : null;
            return { tiles, bounds, alphaSum: info[0] };
        } finally { this._reset(a); }
    }

    /**
     * Unpacks one TIFF strip or tile of uncompressed (`1`), LZW (`5`) or PackBits (`32773`) bytes `src` into `out`
     * (`need` bytes, allocated when absent), stopping as soon as `need` bytes are written (`inpaint_tiff.js`
     * `unpackStrip`, K16). Throws the reader's refusal on truncated or damaged streams.
     */
    tiffUnpack(compression, src, need, out = null, name = "strip") {
        if (need instanceof Uint8Array) { out = need; need = out.byteLength; }
        if (!(compression === 1 || compression === 5 || compression === 32773) || !ArrayBuffer.isView(src) || !Number.isInteger(need) || need < 0) {
            throw tiffUnpackError(-1, name);
        }
        let dst = null;
        if (out != null) {
            if (!ArrayBuffer.isView(out) || out.byteLength < need) throw tiffUnpackError(-1, name);
            dst = out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        }
        const a = this.job, len = src.byteLength;
        try {
            const ps = len > 0 ? this._in(a, src, len) : 0, po = need > 0 ? a.take(need) : 0;
            const rc = this.exports.tiff_unpack(compression, ps, len, po, need) | 0;
            if (rc < 0) throw tiffUnpackError(rc, name);
            if (need === 0) return out || new Uint8Array(0);
            this._out(Uint8Array, po, need, dst ? (dst.length === need ? dst : dst.subarray(0, need)) : (dst = new Uint8Array(need)));
            return out || dst;
        } finally { this._reset(a); }
    }

    /**
     * Multiplies the alpha channel of `rgba` (`w * h * 4` RGBA8 bytes, in place) by the depth limit weight over `map`
     * (`mw` x `mh` u16, affine transform `xf`) and optional joint-bilateral snap (`snap = [sigmaR, tau]`, `guide`,
     * optional `col` reference RGBA8) in chunks of at most 256 rows (K25, docs/PLAN_WASM_BUILD.md §4.8).
     * When `col` is null and `guide` is given, the snap reference colour is sampled from `guide` at `(mx, my)`.
     */
    limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) {
        if (!rgba || !(map instanceof Uint16Array) || !limit || !(mw > 0) || !(mh > 0) || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0 || !Number.isInteger(x0) || !Number.isInteger(y0) || (!Array.isArray(xf) && !ArrayBuffer.isView(xf)) || xf.length < 6) {
            throw new Error("limitAlphaRows: bad arguments");
        }
        if (map.length < mw * mh) throw new Error("limitAlphaRows: short map");
        const u8 = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray
            ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
            : (rgba.buffer instanceof ArrayBuffer || (SAB && rgba.buffer instanceof SAB))
                ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
                : (rgba instanceof ArrayBuffer || (SAB && rgba instanceof SAB))
                    ? new Uint8Array(rgba)
                    : null;
        const needBytes = w * h * 4;
        if (!u8 || u8.length < needBytes) throw new Error("limitAlphaRows: short rgba");

        let cBytes = null;
        if (col != null) {
            cBytes = col instanceof Uint8Array || col instanceof Uint8ClampedArray
                ? new Uint8Array(col.buffer, col.byteOffset, col.byteLength)
                : (col.buffer instanceof ArrayBuffer || (SAB && col.buffer instanceof SAB))
                    ? new Uint8Array(col.buffer, col.byteOffset, col.byteLength)
                    : (col instanceof ArrayBuffer || (SAB && col instanceof SAB))
                        ? new Uint8Array(col)
                        : null;
            if (!cBytes || cBytes.length < needBytes) throw new Error("limitAlphaRows: short col");
        }

        const m0 = +xf[0], m1 = +xf[1], m2 = +xf[2], m3 = +xf[3], m4 = +xf[4], m5 = +xf[5];
        const lo = limit.lo == null ? 0 : +limit.lo;
        const hi = limit.hi == null ? 1 : +limit.hi;
        const fLo = limit.fLo == null ? 0 : +limit.fLo;
        const fHi = limit.fHi == null ? 0 : +limit.fHi;
        let sigmaR = 0, tau = 0;
        if (snap != null) {
            if ((!Array.isArray(snap) && !ArrayBuffer.isView(snap)) || snap.length < 2) {
                throw new Error("limitAlphaRows: snap must have 2 elements");
            }
            sigmaR = snap[0] == null ? 0 : +snap[0];
            tau = snap[1] == null ? 0 : +snap[1];
        }
        if (![m0, m1, m2, m3, m4, m5, lo, hi, fLo, fHi, sigmaR, tau].every(Number.isFinite)) {
            throw new Error("limitAlphaRows: non-finite parameters");
        }

        let gBytes = null;
        if (guide != null) {
            const gRaw = guide.data || guide;
            const gw = guide.w != null ? guide.w | 0 : mw;
            const gh = guide.h != null ? guide.h | 0 : mh;
            if (!gRaw || gw !== mw || gh !== mh) throw new Error("limitAlphaRows: bad guide");
            gBytes = gRaw instanceof Uint8Array || gRaw instanceof Uint8ClampedArray
                ? new Uint8Array(gRaw.buffer, gRaw.byteOffset, gRaw.byteLength)
                : (gRaw.buffer instanceof ArrayBuffer || (SAB && gRaw.buffer instanceof SAB))
                    ? new Uint8Array(gRaw.buffer, gRaw.byteOffset, gRaw.byteLength)
                    : (gRaw instanceof ArrayBuffer || (SAB && gRaw instanceof SAB))
                        ? new Uint8Array(gRaw)
                        : null;
            if (!gBytes || gBytes.length < mw * mh * 4) throw new Error("limitAlphaRows: short guide");
        }
        if (w === 0 || h === 0) return rgba;

        const snapOn = !!(sigmaR > 0 && gBytes);
        const colIsRgba = !!(cBytes && cBytes.buffer === u8.buffer && cBytes.byteOffset === u8.byteOffset);
        const flags = limit.invert ? 1 : 0;
        const rx0 = x0, rx1 = x0 + w;

        for (let cy = 0; cy < h; cy += 256) {
            const ch = Math.min(256, h - cy);
            const cy0 = y0 + cy;
            const cy1 = cy0 + ch;
            const ry00 = m1 * rx0 + m3 * cy0 + m5;
            const ry10 = m1 * rx1 + m3 * cy0 + m5;
            const ry01 = m1 * rx0 + m3 * cy1 + m5;
            const ry11 = m1 * rx1 + m3 * cy1 + m5;
            const ryMin = Math.min(ry00, ry10, ry01, ry11);
            const ryMax = Math.max(ry00, ry10, ry01, ry11);
            const wy0 = Number.isFinite(ryMin) ? Math.max(0, Math.min(mh - 1, Math.floor(ryMin - 2))) : 0;
            const wy1 = Number.isFinite(ryMax) ? Math.max(0, Math.min(mh - 1, Math.ceil(ryMax + 2))) : mh - 1;
            const wh = wy1 - wy0 + 1;
            const wLen = wh * mw;
            const wStart = wy0 * mw;
            const chunkOff = cy * w * 4;
            const chunkBytes = ch * w * 4;
            const subRgba = u8.subarray(chunkOff, chunkOff + chunkBytes);

            const a = this.job;
            try {
                const pRgba = this._in(a, subRgba, chunkBytes);
                const pCol = snapOn && cBytes
                    ? (colIsRgba ? pRgba : this._in(a, cBytes.subarray(chunkOff, chunkOff + chunkBytes), chunkBytes))
                    : 0;
                const pm = this._in(a, map.subarray(wStart, wStart + wLen), wLen * 2);
                const pg = snapOn ? this._in(a, gBytes.subarray(wStart * 4, (wStart + wLen) * 4), wLen * 4) : 0;
                const pParams = a.take(12 * 8);
                const pv = this.view(Float64Array, pParams, 12);
                pv[0] = m0; pv[1] = m1; pv[2] = m2; pv[3] = m3; pv[4] = m4; pv[5] = m5;
                pv[6] = lo; pv[7] = hi; pv[8] = fLo; pv[9] = fHi; pv[10] = snapOn ? sigmaR : 0; pv[11] = tau;

                const ok = this.exports.limit_alpha_rows(
                    pRgba, pCol, pm, pg,
                    mw, mh, wy0, wh,
                    x0, cy0, w, ch,
                    pParams, flags
                );
                if (!ok) throw new Error("limit_alpha_rows: refused");
                this._out(Uint8Array, pRgba, chunkBytes, subRgba);
            } catch (err) {
                if (cy > 0 && err && typeof err === "object") err.doneRows = cy;
                throw err;
            } finally { this._reset(a); }
        }
        return rgba;
    }
}

const TIFF_TRUNCATED = "the file ends early (it is truncated, or not a TIFF)";

function tiffUnpackError(code, name = "strip") {
    let msg;
    if (code === -2) msg = `${TIFF_TRUNCATED}: ${name} holds fewer bytes than its rows`;
    else if (code === -3) msg = "this TIFF uses the old-style LZW of before TIFF 6, which is not read; save it again with LZW or ZIP compression";
    else if (code === -4) msg = "damaged LZW data in the TIFF (a code before any literal)";
    else if (code === -5) msg = "damaged LZW data in the TIFF (a code beyond the table)";
    else msg = `unsupported TIFF strip unpack (code ${code})`;
    const err = new Error(msg);
    err.code = code;
    return err;
}

/**
 * A bump allocator on top of `px_alloc` for one job: `take(bytes)` per buffer, `reset()`
 * when the job is done. The first chunk is kept across resets (grown to the largest job
 * seen), so a steady stream of same-sized jobs allocates once.
 */
export class PxArena {
    constructor(px, chunkBytes = 1 << 20) {
        this.px = px;
        this.chunkBytes = chunkBytes;
        this.chunks = [];          // { ptr, size, used }
        this.peak = 0;
        this.jobBytes = 0;
    }

    // blocks of 16 KB and more start on a page, like px_alloc's: a tile copied between a JS
    // buffer and a block 8 bytes past a page start hits 4K aliasing (16x slower copies)
    take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8) {
        if (!(bytes > 0)) return 0;
        this.jobBytes += roundUp(bytes, align) + align;   // room for the padding in front, too
        for (const c of this.chunks) {
            const at = roundUp(c.used, align);
            if (at + bytes <= c.size) {
                c.used = at + bytes;
                return c.ptr + at;
            }
        }
        const size = Math.max(this.chunkBytes, roundUp(bytes, 8));
        const ptr = this.px.alloc(size);
        this.chunks.push({ ptr, size, used: bytes });
        return ptr;
    }

    /** Forget every block of the job. Extra chunks are freed; one chunk that fits the job stays. */
    reset() {
        this.peak = Math.max(this.peak, this.jobBytes);
        this.jobBytes = 0;
        if (this.chunks.length > 1) {
            for (const c of this.chunks) this.px.free(c.ptr, c.size);
            this.chunks = [];
            const size = Math.max(this.chunkBytes, roundUp(this.peak, 8));
            this.chunks.push({ ptr: this.px.alloc(size), size, used: 0 });
        } else if (this.chunks.length) {
            this.chunks[0].used = 0;
        }
    }

    dispose() {
        for (const c of this.chunks) this.px.free(c.ptr, c.size);
        this.chunks = [];
    }
}
