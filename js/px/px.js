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

export const PX_ABI = 21;

// arithmetic, not `& -n`: sizes above 2 GB do not survive a 32-bit bitwise operator
const roundUp = (n, to) => Math.ceil(n / to) * to;

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A stopwatch over `laps`: each call adds the milliseconds since the one before (or since it was made) to `laps[key]`. */
function lapper(laps) {
    let t = clock();
    return (key) => { const t1 = clock(); laps[key] = (laps[key] || 0) + (t1 - t); t = t1; };
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

    /** Square dilation of a w x h Float32Array by r pixels; a new array. */
    dilateMask(data, w, h, r) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.dilate_mask(pd, w, h, r);
            return this._out(Float32Array, pd, n, null);
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
     * `growMask` and `maskBounds` of the result in one call: the selection `d` (RGBA8) grown or shrunk in place.
     * Returns the result's bounds [x0, y0, x1, y1] or null.
     */
    growMask(d, w, h, n) {
        const a = this.job, bytes = w * h * 4;
        try {
            const pd = this._in(a, d, bytes), pb = a.take(16);
            const any = this.exports.grow_mask(pd, w, h, n, pb);
            this._out(Uint8Array, pd, bytes, new Uint8Array(d.buffer, d.byteOffset, bytes));
            if (!any) return null;
            const b = this.view(Int32Array, pb, 4);
            return [b[0], b[1], b[2], b[3]];
        } finally { this._reset(a); }
    }

    /**
     * The flood job: the region around (sx, sy) clipped to `sel` (RGBA8 or null), drawn as the colour `rgb`
     * (0xRRGGBB). `use(view, count, bounds)` gets the shape as a Uint8ClampedArray over wasm memory (valid only inside
     * the call: an ImageData over it goes to putImageData without a copy) and its result is returned.
     */
    floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use) {
        const a = this.job, bytes = w * h * 4;
        let pairs = Math.max(4096, (w * h) >> 4);
        try {
            const pr = this._in(a, rgba, bytes), ps = sel ? this._in(a, sel, bytes) : 0, pi = a.take(20);
            for (;;) {
                const pst = a.take(pairs * 8);
                if (this.exports.flood_shape(pr, w, h, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous ? 1 : 0, ps, rgb >>> 0, pst, pairs, pi) >= 0) break;
                pairs *= 2;
            }
            const info = this.view(Int32Array, pi, 5);
            const bounds = info[3] < 0 ? null : [info[1], info[2], info[3], info[4]];
            return use(new Uint8ClampedArray(this.memory.buffer, pr, bytes), info[0], bounds);
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
            const into = write();
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
     * One part of a PNG's zlib stream (docs/PLAN_BCE.md §E2): `rows` rows of RGBA8 filtered (`pngFilterRows`) and
     * deflated raw at `level`, every part but the `last` ending on a sync flush, so the parts of a picture are one
     * deflate stream when written one after the other. `{ bytes, adler, raw }`: the deflated part (a copy), the
     * Adler-32 of its `raw` filtered bytes alone (joined by `adlerCombine`). `laps` (optional, on `pngPart` below): the
     * milliseconds of `copyIn` (the rows into memory), `filter`, `adler`, `deflate` (summed over its retries) and
     * `copyOut` are added to its fields.
     */
    /** A whole zlib stream of `bytes` (a TIFF strip, inpaint_tiff.js): `78 9C`, one final deflate part, the Adler-32. */
    zlib(bytes, level) {
        const a = this.job, n = bytes.length;
        try {
            const pi = this._in(a, bytes, n);
            const adler = this.exports.adler32(pi, n, 1) >>> 0;
            let cap = n + Math.ceil(n / 65535) * 5 + 64;
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
            // stored blocks are the worst case: 5 bytes per 64 KB, and the flush's own
            let cap = n + Math.ceil(n / 65535) * 5 + 64;
            for (;;) {
                const po = a.take(cap);
                const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po, cap);
                if (lap) lap("deflate");
                if (written >= 0) {
                    const t = TIMED ? clock() : 0;
                    const bytes = this.u8().slice(po, po + written);
                    if (TIMED) lapOut(t, written);
                    if (lap) lap("copyOut");
                    return { bytes, adler, raw: n };
                }
                cap *= 2;
            }
        } finally { this._reset(a); }
    }
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
