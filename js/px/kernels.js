// Generated from DenRakEiw/scumble renderer/editor/px/kernels.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The pixel kernels the editor calls: the Rust build (px.wasm, SIMD128) once it has loaded, the JS twins in
 * kernels_js.js before that and wherever it cannot load (a browser without wasm SIMD, a page whose CSP refuses wasm).
 * Both give the same bytes (tools/px_test.js), so a caller never knows which one ran.
 *
 * Rust runs wherever it measured faster on the real job, however little (the user's decision of 2026-09-17, which
 * replaced phase B's 3× rule; docs/PERFORMANCE.md §12). Each thread loads its own instance: this module starts the
 * load when it is imported, in the window and in every worker.
 *
 * `setKernels("js")` forces the twins in this thread (the benchmark, tools/px_jobs.py). Routes narrow that per kernel
 * (docs/PLAN_WASM_K1.md §1.3): `flood`, `mips` and `selCombine` (the selection's combine, K5) choose between the Rust
 * build and the twin (a flood by its size), and `releaseMB` / `keepMB` say how much grown memory an instance may keep.
 * A route only ever chooses between the same bytes. The window's overrides ride every job message (`routeOverrides`)
 * and a worker takes them (`adoptRoutes`).
 *
 * wasm memory never shrinks, so after a call that grew the instance past `releaseMB` (a flood over a whole 15k picture
 * takes about 0.8 GB) the instance is replaced by a fresh one of the same compiled module and the old memory is
 * collected. Once the thread has been idle for IDLE_MS, an instance above `keepMB` is replaced too; a worker job holds
 * the instance (`pxJobStart` / `pxJobEnd`), so that trim never fires inside one. Outside a job every Rust call through
 * the wrappers counts as activity, so the window's instance, which no job holds, is trimmed however it grew (a smudge,
 * a liquify window, the tiles' mips; docs/PLAN_WASM_BUILD.md §3.2 "Retention").
 *
 * A trap (a wasm RuntimeError, or a stack overflow: px.js marks the instance `trapped`) or running out of memory
 * (`PxOutOfMemory`) poisons only the instance: the wrapper replaces it (`recovered`) and runs the twin, the same bytes.
 */
import * as J from "./kernels_js.js";
import { loadPx, Px, PxOutOfMemory, pxLaps } from "./px.js";
import { resampleBlock as resampleBlockJS, resampleTable } from "../inpaint_resample.js";

export { OPS, mipChainBytes, deflate, SMUDGE_ALPHA_LOCK, SMUDGE_PICKUP, POISSON_TOL, POISSON_MAX_CYCLES, floodScan, SEL_NONE, SEL_ALPHA, SEL_FULL, SEL_RGBA } from "./kernels_js.js";
// this thread's Rust kernel calls by export name (px.js, docs/PLAN_WASM_BUILD.md §3.4), their clocks and the copies
// around them (docs/PLAN_WASM_K1.md §1.1); they survive a new instance
export { pxCalls, pxTimed, pxLaps, pxLapAdd, PxOutOfMemory } from "./px.js";

// ---- routes (docs/PLAN_WASM_K1.md §1.3) ---------------------------------------------------------------------------

/**
 * The routes and the kind of value each takes. "kernel": "js" or "rust". "kernelSize": also a number of pixels, Rust
 * from that size on. "mb": a number of MB >= 0, or Infinity. "count": a whole number >= 0.
 * `relightStripes` (K12, docs/PLAN_WASM_BUILD.md §4.5) is read on the window: how many stripes a full or quick shadow
 * march is cut into (0 or 1: one job a light, as before K12); absent, `STRIPES_PER_WORKER` times the pool's size
 * (inpaint_relight.js `marchOnPool`). `relightFeed` (K12b), read on the window too: how many stripes of all full marches
 * are posted to the pool at once (inpaint_relight.js `feedMarch`); absent, the pool's size + 1; 0 posts every stripe
 * at once (K12).
 */
export const ROUTE_KINDS = Object.freeze({ flood: "kernelSize", mips: "kernel", selCombine: "kernel", releaseMB: "mb", keepMB: "mb", relightStripes: "count", relightFeed: "count" });

// Today's behaviour. An absent kernel route means Rust; a measured default goes here with a comment that cites its row
// (docs/PLAN_WASM_BUILD.md §1.1 rule 4). keepMB equal to releaseMB makes the idle trim almost a no-op.
// keepMB 16 (K1b, docs/measurements/k1b_2026-10-23/run2/summary.txt): re-growing an instance costs about 0.07 ms per MB
// (M7a: 9.1 ms at 128 MB, below the wand row's spread of 16.5-38.3 ms), and after a 15k export the pool keeps 11.7 MB
// instead of 288 MB (M7b). No flood or mips entry: Rust won every A/B of M1-M4 (the flood ladder from a 0.26 MP box up).
const DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16 });

const TAKES = { kernel: '"js" or "rust"', kernelSize: '"js", "rust" or a number of pixels >= 0', mb: "a number of MB >= 0 or Infinity", count: "a whole number >= 0" };

let OVERRIDES = {};   // name -> value: setRoute (the window, a harness) or adoptRoutes (a worker, per job message)

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function validRoute(name, v) {
    if (!own(ROUTE_KINDS, name)) return false;
    const kind = ROUTE_KINDS[name], number = typeof v === "number" && v >= 0;
    if (kind === "mb") return number;
    if (kind === "count") return Number.isInteger(v) && v >= 0;
    return v === "js" || v === "rust" || (kind === "kernelSize" && number);
}

/** Overrides a route in this thread; `null` removes the override. An unknown name or a value of the wrong kind throws. */
export function setRoute(name, value) {
    if (!own(ROUTE_KINDS, name)) throw new Error("px: unknown route " + name);
    if (value === null) { delete OVERRIDES[name]; return; }
    if (!validRoute(name, value)) throw new Error(`px: route ${name} takes ${TAKES[ROUTE_KINDS[name]]}`);
    OVERRIDES[name] = value;
}

/** The route's value in force: the override, else the default; undefined for a kernel route with neither (Rust). */
export function route(name) {
    if (own(OVERRIDES, name)) return OVERRIDES[name];
    return own(DEFAULT_ROUTES, name) ? DEFAULT_ROUTES[name] : undefined;
}

/** Every route in force: the defaults with the overrides over them (a copy). */
export function kernelRoutes() { return { ...DEFAULT_ROUTES, ...OVERRIDES }; }

/** This thread's overrides alone (a copy): what a job message carries. */
export function routeOverrides() { return { ...OVERRIDES }; }

/** A worker's side of `routeOverrides`: the overrides become the valid entries of `o`, the rest dropped. Never throws. */
export function adoptRoutes(o) {
    const next = {};
    try {
        if (o && typeof o === "object") for (const name of Object.keys(o)) if (validRoute(name, o[name])) next[name] = o[name];
    } catch { /* a message is plain data; whatever was read stands */ }
    OVERRIDES = next;
}

const mb = (name) => route(name) * 1048576;

// ---- the instance -------------------------------------------------------------------------------------------------

const IDLE_MS = 2000;   // the idle trim's delay (docs/PLAN_WASM_K1.md §6 question 7)

let PX = null;
let MODE = "rust";
let LOADING = null;
let PENDING = null;   // an instance made asynchronously because the synchronous way threw; the twins run meanwhile
let SERIAL = 0;       // instances this thread has made, the first load included
let HOLDS = 0;        // worker jobs running (pxJobStart / pxJobEnd)
let TRIM = null;      // the idle trim's timer
let TOUCHED = false;  // a Rust call came while that timer ran: it counts down again when it fires
const RENEWS = { release: 0, idle: 0, trap: 0, oom: 0 };   // instances replaced, by cause
const MADE = { sync: 0, async: 0 };                        // and how their successors were made
const WARNED = new Set();

/** Resolves to the Rust kernels of this thread, or null when they cannot load (the twins then run). */
export function kernelsReady() {
    if (!LOADING) {
        LOADING = loadPx(new URL("./px.wasm", import.meta.url)).then((px) => { PX = px; SERIAL++; return px; }).catch((err) => {
            console.warn("Inpaint Canvas: the Rust pixel kernels did not load, using the JS ones:", (err && err.message) || err);
            return null;
        });
    }
    return LOADING;
}

// not in Node (tools/px_test.js imports the loader and the twins directly): there is no fetch of a file URL
if (typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined") kernelsReady();

/** "rust" (the default) or "js", for this thread. */
export function setKernels(mode) { MODE = mode === "js" ? "js" : "rust"; }
export function kernelsMode() { return MODE; }
/** What a call made now runs: "rust" only when it is wanted and loaded. */
export function kernelsInUse() { return MODE === "rust" && PX ? "rust" : "js"; }

/**
 * The loaded Rust instance when this thread uses it, else null. With a route's `name`, also null when that route sends
 * the call to the twin: "js", or a number of pixels above `size`. The global mode stays the override, and a poisoned
 * instance is replaced first.
 */
export function rustPx(name = null, size = 0) {
    if (MODE !== "rust") return null;
    if (PX && PX.trapped) renew(PX.trapped instanceof PxOutOfMemory ? "oom" : "trap", PX);
    if (!PX) return null;
    if (name !== null) {
        const r = route(name);
        if (r === "js" || (typeof r === "number" && !(size >= r))) return null;
    }
    return PX;
}

/**
 * Replaces `from` when it is still this thread's instance, counted under `why`: a new instance of the same compiled
 * module, synchronously where the thread allows it (K0b's grow_fallback ran it on the window), else in the background
 * while the twins run (a page's main thread may refuse the synchronous way, the node's Chrome).
 *
 * A poisoned instance (trap, oom) is gone either way and counted at once. A sound one (release, idle) is counted once
 * its successor is in place, and comes back should the background load fail too: in a worker the synchronous way fails
 * only when the memory cannot be reserved, the background one then most likely as well, and the thread would otherwise
 * be left on the twins for good.
 */
function renew(why, from) {
    if (!from || from !== PX) return;
    const sound = why === "release" || why === "idle";
    if (!sound) RENEWS[why] = (RENEWS[why] || 0) + 1;
    const module = from.module;
    try {
        PX = new Px(new WebAssembly.Instance(module, {}), module);
    } catch {
        PX = null;
        const job = WebAssembly.instantiate(module, {})
            .then((instance) => {
                if (PX) return;
                PX = new Px(instance, module);
                SERIAL++;
                MADE.async++;
                if (sound) RENEWS[why]++;
            })
            .catch((err) => {
                if (sound && !PX) PX = from;
                console.warn(`Inpaint Canvas: a new Rust kernel instance did not load, ${sound ? "keeping the old one" : "using the JS kernels"}:`, (err && err.message) || err);
            })
            .then(() => { if (PENDING === job) PENDING = null; });
        PENDING = job;
        return;
    }
    SERIAL++;
    MADE.sync++;
    if (sound) RENEWS[why]++;
}

/** Replaces the instance when it holds more than `limit` bytes. */
function drop(limit, why) {
    if (PX && PX.byteLength > limit) renew(why, PX);
}

/** After a call on a large buffer: let go of memory grown past `releaseMB`, then count down to the idle trim. */
export function releaseIfLarge() {
    drop(mb("releaseMB"), "release");
    if (!HOLDS) armTrim();
}

// only when there is something above keepMB to let go of; each call starts the countdown again, so an operation of many
// calls (an export's parts) trims once, IDLE_MS after its last one
function armTrim() {
    if (!PX || PX.byteLength <= mb("keepMB")) return;
    if (TRIM !== null) clearTimeout(TRIM);
    TOUCHED = false;
    TRIM = setTimeout(trimDue, IDLE_MS);
    if (TRIM && TRIM.unref) TRIM.unref();   // Node (tools/px_test.js) must not wait for it
}

// the timer: a Rust call since it was armed counts it down again, else an instance above keepMB goes
function trimDue() {
    TRIM = null;
    if (HOLDS) return;
    if (TOUCHED) armTrim();
    else drop(mb("keepMB"), "idle");
}

// After a wrapper's Rust call that does not release (the per-tile ones among them): outside a job it is activity, and
// an instance above keepMB arms the trim. No timer per call: a call while one runs only marks it, so the trim lands
// IDLE_MS to twice that after the last such call.
function touched() {
    if (HOLDS) return;
    if (TRIM !== null) TOUCHED = true;
    else armTrim();
}

/** A worker job starts: it holds the instance, and a pending trim is cancelled. */
export function pxJobStart() {
    HOLDS++;
    if (TRIM !== null) { clearTimeout(TRIM); TRIM = null; }
}

/** A worker job ends: once nothing holds the instance, the idle trim counts down. */
export function pxJobEnd() {
    HOLDS = Math.max(0, HOLDS - 1);
    if (!HOLDS) armTrim();
}

/** Replaces this thread's instance now, whatever its size (the probe, tests); the new instance, or null while it loads. */
export function dropPx(why = "idle") {
    if (PX) renew(why, PX);
    return PX;
}

/** Resolves once no asynchronous instantiation is pending (the first load included). */
export async function pxSettled() {
    if (LOADING) await LOADING;
    while (PENDING) await PENDING;
}

/** This thread's instance and what has happened to it: replacements by cause, and how their successors were made. */
export function pxInstances() {
    return {
        serial: SERIAL, bytes: PX ? PX.byteLength : 0, pending: !!PENDING, holds: HOLDS,
        release: RENEWS.release, idle: RENEWS.idle, trap: RENEWS.trap, oom: RENEWS.oom, sync: MADE.sync, async: MADE.async,
    };
}

/**
 * After a Rust call on `p` threw `err`: true when `err` is `p`'s trap or out-of-memory, and `p` is then replaced and the
 * caller runs the twin (px.js leaves the caller's arrays as they were until a method's last export call). Any other
 * error is the caller's to rethrow. Warns once per thread and kernel (`name`, else the error's message).
 */
export function recovered(p, err, name = "") {
    if (!p || !(p.trapped || err instanceof PxOutOfMemory)) return false;
    const why = p.trapped && !(p.trapped instanceof PxOutOfMemory) ? "trap" : "oom";
    renew(why, p);
    const key = why + ":" + (name || (err && err.message) || "");
    if (!WARNED.has(key)) {
        WARNED.add(key);
        console.warn(`Inpaint Canvas: the Rust pixel kernel ${name || ""} failed (${why}: ${(err && err.message) || err}); the JS one ran, the next call gets a fresh instance`);
    }
    return true;
}

/**
 * The split of this thread's px work since the last `pxCalls(true)` (px.js `pxLaps`), with the instance's bytes and its
 * serial. Without `since` it is a snapshot (it keeps the replacements' counts); with one, the report since that
 * snapshot: `bytes0` the bytes then, `renewed` the replacements since by cause.
 */
export function pxSplit(since = null) {
    const out = { ...pxLaps(), bytes: PX ? PX.byteLength : 0, inst: SERIAL };
    if (!since) {
        out.renews = { ...RENEWS };
        return out;
    }
    out.bytes0 = since.bytes;
    const renewed = {};
    for (const why of Object.keys(RENEWS)) renewed[why] = RENEWS[why] - ((since.renews && since.renews[why]) || 0);
    out.renewed = renewed;
    return out;
}

// ---- the kernels --------------------------------------------------------------------------------------------------
// One pattern, no closures, so the per-tile wrappers stay cheap: Rust when rustPx gives an instance, the twin when it
// does not or when the instance trapped (`recovered`); `releaseIfLarge` after the calls that can grow memory a lot,
// `touched` after the rest (the idle trim's activity, no allocation).

/** The resampler's kernel (inpaint_resample.js `resampleBlock`, its twin): Rust once loaded, the same bytes either way. */
export function resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh) {
    const p = rustPx();
    if (p) {
        const w = resampleTable(filter);
        try { return p.resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh, w.table, w.taps); }
        catch (err) { if (!recovered(p, err, "resample_block")) throw err; }
        finally { touched(); }
    }
    return resampleBlockJS(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh);
}

export function mipHalf(src, sw, sh, dst = null) {
    const p = rustPx("mips");
    if (p) {
        try { return p.mipHalf(src, sw, sh, dst); }
        catch (err) { if (!recovered(p, err, "mip_half")) throw err; }
        finally { touched(); }
    }
    return J.mipHalf(src, sw, sh, dst);
}

export function mipChain(src, size, levels, out = null) {
    const p = rustPx("mips");
    if (p) {
        try { return p.mipChain(src, size, levels, out); }
        catch (err) { if (!recovered(p, err, "mip_chain")) throw err; }
        finally { touched(); }
    }
    return J.mipChain(src, size, levels, out);
}

export function clampExtend(bytes, size, vw, vh) {
    const p = rustPx("mips");
    if (p) {
        try { return p.clampExtend(bytes, size, vw, vh); }
        catch (err) { if (!recovered(p, err, "clamp_extend")) throw err; }
        finally { touched(); }
    }
    return J.clampExtend(bytes, size, vw, vh);
}

export function distTransform(feature, W, H, out = null, scratch = null) {
    const p = rustPx();
    if (p) {
        try { return p.distTransform(feature, W, H, out); }
        catch (err) { if (!recovered(p, err, "dist_transform")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.distTransform(feature, W, H, out || new Float32Array(W * H), scratch);
}

/** The row filters of PNG lines undone (the stream reader, inpaint_png.js): see kernels_js.js `pngUnfilterRows`. */
export function pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba = null) {
    const p = rustPx();
    if (p) {
        try { return p.pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba); }
        catch (err) { if (!recovered(p, err, "png_unfilter_rows")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba);
}

/** Square dilation of a float mask by r pixels (a provider run's masks, stitch.js); a new Float32Array. */
export function dilateMask(data, w, h, r) {
    const p = rustPx();
    if (p) {
        try { return p.dilateMask(data, w, h, r); }
        catch (err) { if (!recovered(p, err, "dilate_mask")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.dilateMask(data, w, h, r);
}

/** Box blurs of up to three radii over a float mask (the passes of stitch.js' gaussian); a new Float32Array. */
export function boxBlurs(data, w, h, radii) {
    const p = rustPx();
    if (p) {
        try { return p.boxBlurs(data, w, h, radii); }
        catch (err) { if (!recovered(p, err, "box_blurs")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.boxBlurs(data, w, h, radii);
}

export function compositeTile(dst, srcs, ops, alphas, masks = null) {
    const p = rustPx();
    if (p) {
        try { return p.compositeTile(dst, srcs, ops, alphas, masks); }
        catch (err) { if (!recovered(p, err, "composite_tile")) throw err; }
        finally { touched(); }
    }
    return J.compositeTile(dst, srcs, ops, alphas, masks);
}

/** One smudge dab: `dst` (straight RGBA8) and `carry` (premultiplied u16) in place (PLAN_0_1_31 §4 step 3). */
export function smudgeDab(dst, src, carry, mask, strength, keep, flags = 0) {
    const p = rustPx();
    if (p) {
        try { return p.smudgeDab(dst, src, carry, mask, strength, keep, flags); }
        catch (err) { if (!recovered(p, err, "smudge_dab")) throw err; }
        finally { touched(); }
    }
    return J.smudgeDab(dst, src, carry, mask, strength, keep, flags);
}

/** The healing brush's Poisson blend over a box (PLAN_0_1_31 §5 step 1): `out` straight RGBA8, `info` [healed, cycles, levels]. */
export function poissonBlend(dst, src, mask, w, h, out = null, info = null) {
    const p = rustPx();
    if (p) {
        try { return p.poissonBlend(dst, src, mask, w, h, out, info); }
        catch (err) { if (!recovered(p, err, "poisson_blend")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.poissonBlend(dst, src, mask, w, h, out || new Uint8Array(w * h * 4), info);
}

export function matchPixels(rgba, params) {
    const p = rustPx();
    if (p) {
        try { return p.matchPixels(rgba, params); }
        catch (err) { if (!recovered(p, err, "match_pixels")) throw err; }
        finally { touched(); }
    }
    return J.matchPixels(rgba, params);
}

export function psdPackRows(rgba, w, rows) {
    const p = rustPx();
    if (p) {
        try { return p.psdPackRows(rgba, w, rows); }
        catch (err) { if (!recovered(p, err, "psd_pack_rows")) throw err; }
        finally { touched(); }
    }
    return J.psdPackRows(rgba, w, rows);
}

export function pngFilterRows(rgba, w, rows, prev = null, out = null) {
    const p = rustPx();
    if (p) {
        try { return p.pngFilterRows(rgba, w, rows, prev, out); }
        catch (err) { if (!recovered(p, err, "png_filter_rows")) throw err; }
        finally { touched(); }
    }
    return J.pngFilterRows(rgba, w, rows, prev, out || undefined);
}

/** Computes max - min over each texel's 4x4 block of a w x h Uint16Array. */
export function rangeMax(src, w, h, out = null) {
    const p = rustPx();
    if (p) {
        try { return p.rangeMax(src, w, h, out); }
        catch (err) { if (!recovered(p, err, "range_max")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.rangeMax(src, w, h, out);
}

/** Computes surface normals from u16 height field: n = normalize(-dz/dx, -dz/dy, 1.0). */
export function heightNormals(depth, w, h, scale, sigma, out = null) {
    const p = rustPx();
    if (p) {
        try { return p.heightNormals(depth, w, h, scale, sigma, out); }
        catch (err) { if (!recovered(p, err, "height_normals")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.heightNormals(depth, w, h, scale, sigma, out);
}

/**
 * Marches shadow rays through u16 depth height field. A full-size `out` takes rows row0.. at row0 * w (both kernels), so
 * the stripes of one march write into one buffer (K12). `key` names the depth map's data for the Rust sun's resident copy
 * (px.js `_slot`): the stripes of one march on one worker copy it once; the twin reads `depth` where it lies.
 */
export function shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out = null, key = null) {
    if (light && light[3] !== 1) {
        return J.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out);
    }
    const p = rustPx();
    if (p) {
        try { return p.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out, key); }
        catch (err) { if (!recovered(p, err, "shadow_march")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out);
}

/**
 * The flood job (px.js `floodShape`, kernels_js.js its twin): routed by `flood` at the picture's w * h pixels. `use`
 * runs at most once: an error after it ran (or thrown by it) is rethrown, never answered by the twin a second time.
 */
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use) {
    const p = rustPx("flood", w * h);
    if (p) {
        let used = false;
        const once = (v, n, b) => { used = true; return use(v, n, b); };
        try { return p.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, once); }
        catch (err) { if (used || !recovered(p, err, "flood_shape")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use);
}

/**
 * One tile of the selection combined with an alpha source (inpaint_tiles.js `TileMaskPixels.combine`; kernels_js.js
 * `selCombine` and its Rust twin px.js `selCombine`, routed by `selCombine`). `dst`: the tile's bytes as they are, or
 * null when the tile does not exist (its alpha taken as 0). `write()` makes the tile writable and returns its bytes: it
 * is called at most once, and only when the result may hold a pixel (the twins' route writes in place, so it calls it
 * before the combine and may then answer null: the caller drops the tile). The source as an AlphaSource view gives it
 * (`src` from pixel `off`, `stride` pixels a row, `kind` SEL_NONE / SEL_ALPHA / SEL_FULL / SEL_RGBA), `mode` 0 to 3
 * (SEL_MODES), `rgb` 0xRRGGBB. Returns the combined tile's extent [x0, y0, x1, y1] or null when it holds no pixel.
 */
export function selCombine(dst, write, src, off, stride, kind, bw, bh, mode, rgb, size = 256) {
    const p = rustPx("selCombine");
    let wrote = false;
    const once = () => { wrote = true; return write(); };
    if (p) {
        try { return p.selCombine(dst, size, src, off, stride, kind, bw, bh, mode, rgb, once); }
        catch (err) { if (wrote || !recovered(p, err, "sel_combine")) throw err; }
        finally { touched(); }
    }
    // a missing tile is made only when the source covers something it keeps: replace and add keep the source's alpha
    if (!dst && (mode >= 2 || !J.alphaAny(src, off, stride, kind, bw, bh))) return null;
    return J.selCombine(once(), size, src, off, stride, kind, bw, bh, mode, rgb);
}
