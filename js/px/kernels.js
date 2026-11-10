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
import { liquifyBlock as liquifyBlockJS, previewBlock as previewBlockJS, liquifyDabNodes } from "../inpaint_liquify.js";
// the retouch brushes' twins live with the brushes (K26, K27; inpaint_stroke.js imports nothing, so no cycle)
import { blurRGBA as blurRGBATwin, sharpenRGBA as sharpenRGBATwin, toneRGBA as toneRGBATwin, spongeRGBA as spongeRGBATwin, freqSplit as freqSplitTwin } from "../inpaint_stroke.js";

export { OPS, mipChainBytes, deflate, SMUDGE_ALPHA_LOCK, SMUDGE_PICKUP, POISSON_TOL, POISSON_MAX_CYCLES, floodScan, SEL_NONE, SEL_ALPHA, SEL_FULL, SEL_RGBA, unpackStrip, unpredict, predictRgba, toRgba, paletteLut, tiffPlan, readTiffBand, readTiffBands, TIFF_BAND_BYTES, TIFF_JS, PSD_JS } from "./kernels_js.js";
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
 * at once (K12). `dabBlur` (K26): `blurRGBA` and `sharpenRGBA`, the blur and sharpen brushes and frequency separation's
 * blur, "js" for the twins in inpaint_stroke.js. `dabTone`, `dabSponge` and `freqSplit` (K27): `toneRGBA` (the dodge and
 * burn brush), `spongeRGBA` (saturate, desaturate) and frequency separation's split, the same way. `liquifyBlock`
 * (K28), `liquifyPreview` (K29) and `liquifyDab` (K30, K31): Liquify's bake, live-stroke preview and dense dab kernels
 * (`inpaint_liquify.js` `liquifyBlock`, `previewBlock`, `liquifyDabNodes`).
 * `stitchMask` (K32): the mask kernels of
 * stitch.js (`alphaToMask`, `maskMaxClamp`, `maskOneMinus`, `erodeMask`, `maskToRgba`, `maskBoundsF32`).
 * `colorMatch` and `blendAlpha` (K33): `colorMatchRgba` and `blendAlpha` of stitch.js. `edgefit`, `edgefitShrink`,
 * `warpRgba` and `warpCoverage` (K34): `edgefitShrink`, `warpRgba` and `warpCoverage` of edgefit.js. `mapTileStats`
 * (K21), `rangeDepth` and `rangeDepthSnap` (K22): `mapTileStats` and `rangeTilesDepth` (plain bilinear tiles and
 * joint-bilateral snapped tiles). `rangeLuma` and `rangeColor` (K23): `rangeTilesRgba` (luminance and colour-similarity
 * range selection over an RGBA8 band). `limitAlphaRows` (K25): `limitAlphaRows` (fill layer depth limit alpha on PSD/ORA
 * export). `guidedFar` (K24): `guidedFar` of `inpaint_depth.js` (the depth map's guided filter).
 * `compositeMaskedTile` (K36): `compositeMaskedTile` of inpaint_tiles.js `compositeStroke`.
 * `matchPixels` (K38): `matchPixels` of inpaint_filters.js `matchCanvas`, inpaint_boxstack.js and inpaint_worker.js.
 * `growMask` (K39): `growMaskBounds` of inpaint_raster.js (the selection grow / shrink job and window fallback).
 * `composeTiles` and `composeStack` (K10b): pointer gather into wasm memory for tile-store and stack `png_part` / `tiff_part` jobs.
 * `tiffUnpack`, `tiffUnpredict`, `tiffPredict`, `tiffToRgba`, and `tiffStripWasm` (K15, K17): `tiffUnpack`, `tiffUnpredict`, `tiffPredictRgba`, `tiffToRgba`, and `tiffPartJob` / `tiffStrip` of `inpaint_tiff.js`.
 * `clipCoverage`, `dissolveRows`, `psdPartWasm` and `stackIntoWasm` (K10c): clipping-group coverage and dissolve in
 * wasm memory, and pointer gather for `psd_part` and `stack_into` jobs.
 * `psdRead` (K20b): the PSD reader's band kernels (`packbitsRows`, `psdMaskRgba`, `psdBandRgba`, `psdBandMask`) in `psd_read`.
 * `psdWindow` (K20b review), read on the window: how many bands a `psd_read` job may have posted and not yet had
 * acknowledged after the window's `writeRect` (inpaint_canvas.js `readPsdOnPool`); absent, `PSD_WINDOW` (8); 0 posts every
 * band at once (K20b as first built).
 */
export const ROUTE_KINDS = Object.freeze({ flood: "kernelSize", mips: "kernel", selCombine: "kernel", maskInvert: "kernel", crc32: "kernelSize", compositeMaskedTile: "kernel", matchPixels: "kernel", growMask: "kernel", releaseMB: "mb", keepMB: "mb", relightStripes: "count", relightFeed: "count", dabBlur: "kernel", dabTone: "kernel", dabSponge: "kernel", freqSplit: "kernel", liquifyBlock: "kernel", liquifyPreview: "kernel", liquifyDab: "kernel", stitchMask: "kernel", colorMatch: "kernel", blendAlpha: "kernel", mapTileStats: "kernel", rangeDepth: "kernel", rangeDepthSnap: "kernel", rangeLuma: "kernel", rangeColor: "kernel", limitAlphaRows: "kernel", guidedFar: "kernel", edgefit: "kernel", edgefitShrink: "kernel", warpRgba: "kernel", warpCoverage: "kernel", composeTiles: "kernel", composeStack: "kernel", shadowMarch: "kernelSize", tiffUnpack: "kernel", tiffUnpredict: "kernel", tiffPredict: "kernel", tiffToRgba: "kernel", tiffStripWasm: "kernel", clipCoverage: "kernel", dissolveRows: "kernel", psdPartWasm: "kernel", stackIntoWasm: "kernel", psdRead: "kernel", psdWindow: "count" });

// Today's behaviour. An absent kernel route means Rust; a measured default goes here with a comment that cites its row
// (docs/PLAN_WASM_BUILD.md §1.1 rule 4). keepMB equal to releaseMB makes the idle trim almost a no-op.
// keepMB 16 (K1b, docs/measurements/k1b_2026-10-23/run2/summary.txt): re-growing an instance costs about 0.07 ms per MB
// (M7a: 9.1 ms at 128 MB, below the wand row's spread of 16.5-38.3 ms), and after a 15k export the pool keeps 11.7 MB
// instead of 288 MB (M7b). No flood or mips entry: Rust won every A/B of M1-M4 (the flood ladder from a 0.26 MP box up).
// No rangeDepth or rangeDepthSnap entry (K22, docs/measurements/k22_2026-11-08/summary.txt): at 15000x10000 Rust won
// rangeDepth=js:rust on range_depth (214.5 vs 331.1 ms wall, lower by 116.6 > spread 107.1; worker job 1139.6 vs
// 2013.5 ms; before/after on Rust 223.4 -> 172.1 ms wall) and rangeDepthSnap=js:rust on range_depth_snap (1174.4 vs
// 1385.3 ms wall; worker job 1802.2 vs 3541.1 ms, while the window's pre-job picture read is 912-1136 ms independent
// of the route).
// No rangeLuma or rangeColor entry (K23, docs/measurements/k23_2026-11-08/summary.txt): at 15000x10000 Rust won
// rangeLuma=js:rust on range_luma (1102.7 vs 1893.4 ms wall, lower by 790.7 > spread 392.8; worker job 1033.6 vs
// 2545.3 ms; before/after on Rust 1636.6 -> 1224.4 ms wall) and rangeColor=js:rust on range_color (1976.6 vs 3542.6 ms
// wall, lower by 1566.1 > spread 368.4; worker job 2893.4 vs 6487.6 ms; before/after on Rust 3137.6 -> 1785.7 ms wall).
// No limitAlphaRows entry (K25, docs/measurements/k25_2026-11-09/summary.txt): at 15000x10000 Rust won
// limitAlphaRows=js:rust on fill_limit (snapped path: 6213.3 vs 10880.1 ms wall, lower by 4666.9 > spread 1447.3;
// kernel row 6092.4 vs 10728.2 ms; before/after on Rust 11829.1 -> 6036.1 ms wall, 1.96x; export_test fill_limit_rows
// 11178 -> 6209 ms, 1.80x, psd_fill_limit fillRowsMs 12141 -> 6496 ms, 1.87x; plain bilinear path measured at the
// kernel row only, PX_BENCH 15000x256: twin 100.16 vs simd 85.98 / scalar 88.06 ms, 1.16x).
// No shadowMarch entry (K14, docs/measurements/k14_2026-11-09/summary.txt): at 15000x10000 (map 4096x2731) lane-free
// shadow_march_f64 with row y-march precompute (after_scalar) beat 2-lane f64x2 SIMD (after_lanes, removed) across the
// whole-operation rows (relight_one 493 [490-501] vs 599 [570-608] ms; one-job 3245 [3197-3257] vs 3530 [3511-3733] ms;
// relight_one_rep 516 [507-531] vs 576 [540-617] ms; relight_one_nofeed 468 [460-487] vs 548 [547-571] ms), won outside
// spreads over the hoisted f64 twin (after_js, shadowMarch: "js") and before (K13 scalar f64 on point/spot, f32
// shadow_march on sun) on relight_one landed (493 [490-501] vs 681 [650-709] vs 748 [748-753] ms; kernel 3648 [3626-3670]
// vs 5037 [4641-5293] vs 5616 [5606-5661] ms; one-job 3245 [3197-3257] vs 3595 [3456-3684] vs 4894 [4785-4982] ms;
// relight_one_nofeed 468 [460-487] vs 545 [510-579] vs 701 [698-788] ms) and the sun rows (relight_sun landed 170
// [166-172] vs 286 [250-309] vs 527 [506-575] ms; one-job 762 [748-850] vs 1075 [1008-1097] vs 1586 [1581-1647] ms;
// unfed 175 [174-176] vs 209 [187-213] ms; fed2 171 [169-186] vs 207 [206-272] ms), and tied after_js within spread
// (decided by the kernel row, with after_scalar ahead on every landed median) on relight_one_rep (516 [507-531] vs 539
// [490-547] ms, kernel 3860 vs 4054 ms; after_js had lower blocked 47 [40-52] vs 59.8 [58.1-63.5] ms), relight_sun_rep
// (180 [164-185] vs 193 [182-209] ms, kernel 903 [872-943] vs 1106 [1056-1108] ms outside spreads), relight_three (1009
// [965-1070] vs 1144 [1015-1212] ms, kernel 7883 vs 8990 ms, one-job 3284 [3282-3572] vs 3863 [3570-5187] ms; after_js
// had lower blocked 58 [53-59] vs 84.4 [75.3-89.3] ms), relight_nodraw (465 [463-564] vs 561 [500-602] ms, kernel 3456 vs
// 4243 ms), and relight_draw (518 [485-565] vs 546 [504-552] ms, one-job 3194 [3024-3354] vs 3608 [3392-3667] ms outside
// spreads). On after_lanes vs after_js, after_js had the lower median on relight_one_rep (539 vs 576 ms) and
// relight_one_nofeed (545 vs 548 ms); removing the f64x2 lanes flipped both to after_scalar (516 and 468 ms).
// crc32 64 (K3, docs/measurements/k3_2026-11-08/summary.txt): 64 B is about a tie decided by the kernel row (Electron V8
// size sweep: 0.075-0.100 vs 0.028-0.074 us at 16-48 B, 0.093-0.138 vs 0.156-0.235 us at 64-128 B, 1.50-2.53x; 4.97x at
// 64 KB; 4.26x on w0_bench crc32_64mb); smaller headers (PNG signature, IHDR, 4-byte chunk lengths) stay in JS.
// No tiffUnpack entry (K17, docs/measurements/k17_2026-11-09/summary.txt): at 15000x10000 Rust won tiffUnpack=js:rust
// non-overlapping on readTiffBand for LZW (openMs 5684.0 [5619.0-5775.0] vs 10541.0 [10493.0-10595.0] ms, 1.85x;
// tiff_read kernel 3028.8 vs 7857.4 ms, 2.59x; decode 2514.2 vs 7396.3 ms, 2.94x; before/after 0740aeab -> K17 openMs
// 11826.0 -> 5696.0 ms, 2.08x) and PackBits (openMs 3416.0 [3327.0-3635.0] vs 3684.0 [3638.0-3686.0] ms, 1.08x;
// tiff_read kernel 608.4 vs 796.8 ms, 1.31x; decode 110.3 vs 297.0 ms, 2.69x; before/after openMs 5967.0 -> 3622.0 ms,
// 1.65x). Uncompressed (compression === 1) is guarded in tiffUnpack to stay on J.tiffUnpack (one dst.set vs 3 copies
// across wasm: raw_strips 625-strip decode 66.6 [66.4-72.3] vs 91.9 [89.2-98.5] ms non-overlapping, 1.38x; PX_BENCH 1 MB
// strip 0.02 vs 0.05 ms; before/after raw_strips openMs 3622.0 -> 3523.0 ms, 1.03x, openSteps pixels 858.0 -> 613.0 ms,
// 1.40x).
const DEFAULT_ROUTES = Object.freeze({ releaseMB: 256, keepMB: 16, crc32: 64 });

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

/**
 * Resolves to the Rust kernels of this thread (the instance in use when it settles), or null when they cannot load
 * (the twins then run). `LOADING` keeps only whether the first load worked: a promise that resolved to the first
 * instance would keep it, and all the memory it grew, alive after a release or the idle trim replaced it (K26's review;
 * `tools/kernels_release_test.js`).
 */
export function kernelsReady() {
    if (!LOADING) {
        LOADING = loadPx(new URL("./px.wasm", import.meta.url)).then((px) => { PX = px; SERIAL++; return true; }).catch((err) => {
            console.warn("Inpaint Canvas: the Rust pixel kernels did not load, using the JS ones:", (err && err.message) || err);
            return false;
        });
    }
    return LOADING.then((ok) => (ok ? PX : null));
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

/** Liquify's bake kernel (inpaint_liquify.js `liquifyBlock`, K28): Rust once loaded, the same bytes either way. */
export function liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh) {
    const p = rustPx("liquifyBlock");
    if (p) {
        const w = resampleTable(1);
        try {
            const count = p.liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh, w.table);
            if (count !== null) return count;
        } catch (err) { if (!recovered(p, err, "liquify_block")) throw err; }
        finally { touched(); }
    }
    return liquifyBlockJS(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh);
}

/**
 * Allocate the buffer of a Liquify stroke's preview window (`inpaint_canvas.js` `liquifyWindow`, K29): in `px.alloc`
 * memory when the `liquifyPreview` route uses Rust (`{ px, ptr, bytes, data }` with `data` zeroed over wasm memory),
 * else a plain `Uint8Array`. Paired with `freeLiquifyWindow` on every way a stroke ends.
 */
export function allocLiquifyWindow(w, h) {
    const bytes = w * h * 4;
    if (!(w > 0 && h > 0 && Number.isSafeInteger(bytes))) return { px: null, ptr: 0, bytes: 0, data: new Uint8Array(0) };
    const p = rustPx("liquifyPreview");
    if (p) {
        let ptr = 0;
        try {
            ptr = p.alloc(bytes);
            const data = p.u8().subarray(ptr, ptr + bytes);
            data.fill(0);
            return { px: p, ptr, bytes, data };
        } catch (err) {
            if (ptr && !p.trapped) try { p.free(ptr, bytes); } catch { /* ignore */ }
            if (!recovered(p, err, "liquify_preview")) throw err;
        } finally {
            touched();
        }
    }
    return { px: null, ptr: 0, bytes, data: new Uint8Array(bytes) };
}

/** Release a Liquify preview window allocated by `allocLiquifyWindow` (safe to call more than once). */
export function freeLiquifyWindow(win) {
    if (!win || !win.ptr) {
        if (win) { win.px = null; win.ptr = 0; }
        return;
    }
    const p = win.px, ptr = win.ptr, bytes = win.bytes;
    win.px = null;
    win.ptr = 0;
    if (!p || p.trapped) return;
    try { p.free(ptr, bytes); }
    catch (err) { if (!recovered(p, err, "liquify_preview")) throw err; }
    finally { if (p === PX) touched(); }
}

/**
 * Liquify's live-stroke preview (`inpaint_liquify.js` `previewBlock`, K29): runs on `win.px` (never `rustPx()`, so a
 * pause that trims `PX` mid-stroke or a stroke that started on JS stays on the window's own buffer); if the mode or
 * route switches to JS mid-stroke after `win.px` grew its memory, refreshes `win.data` before running the twin.
 */
export function liquifyPreview(win, field, ox, oy, inv, out, bw, bh) {
    const p = win && win.px;
    if (p && win.ptr && !p.trapped && MODE === "rust" && route("liquifyPreview") !== "js") {
        try {
            if (p.liquifyPreview(win, field, ox, oy, inv, out, bw, bh)) return out;
        } catch (err) {
            if (!recovered(p, err, "liquify_preview")) throw err;
        } finally {
            if (p === PX) touched();
        }
    }
    previewBlockJS(win, field, ox, oy, inv, out, bw, bh);
    return out;
}

/** Liquify's dense dab kernel (`inpaint_liquify.js` `liquifyDabNodes`, K30 / K31): Rust once loaded on `push`/`grow`/`shrink`/`restore`, the same nodes either way. */
export function liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box) {
    // PLAN_WASM_BUILD.md §4.9 / §1.1 rule 4: on swirlcw and swirlccw, wasm libm cos/sin differ from V8 Math.cos/Math.sin
    // by 1 ULP on the swirl domain (9,424 / 5 M sin and 783 / 5 M cos in Electron V8 15.2; 1,658 / 5 M cos in Node V8 13.6,
    // reaching dy = 2424 vs 2423 at node (1500, 1000) on LiquifyField(2000, 2000, 1).dab("swirlccw", 1198.6129226787184, 1000, 700, 0.8, 0.6)),
    // so swirl modes route to the JS twin liquifyDabNodes while push, grow, shrink and restore run in Rust.
    if (mode === "swirlcw" || mode === "swirlccw") {
        return liquifyDabNodes(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box);
    }
    const p = rustPx("liquifyDab");
    if (p) {
        try {
            const count = p.liquifyDab(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box);
            if (count !== null) return count;
        } catch (err) { if (!recovered(p, err, "liquify_dab")) throw err; }
        finally { touched(); }
    }
    return liquifyDabNodes(mode, src, sw, si0, sj0, s, ni, nj, cx, cy, r, h, amount, dxStep, dyStep, sel, freeze, i0, j0, ow, oh, out, box);
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

/** The alpha channel of RGBA8 `rgba` as a 0..1 Float32Array (a provider run's masks, stitch.js; K32). */
export function alphaToMask(rgba, out = null) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.alphaToMask(rgba, out); }
        catch (err) { if (!recovered(p, err, "alpha_to_mask")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.alphaToMask(rgba, out);
}

/** Element-wise `Math.max(a[i], b[i])` and/or `Math.min(1, Math.max(0, x))` into `out` (stitch.js; K32). */
export function maskMaxClamp(a, b = null, clamp = false, out = null) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.maskMaxClamp(a, b, clamp, out); }
        catch (err) { if (!recovered(p, err, "mask_max_clamp")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.maskMaxClamp(a, b, clamp, out);
}

/** `1 - src[i]` for every float of `src`, into `out` (stitch.js; K32). */
export function maskOneMinus(src, out = null) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.maskOneMinus(src, out); }
        catch (err) { if (!recovered(p, err, "mask_one_minus")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.maskOneMinus(src, out);
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

/** Square erosion of a float mask by r pixels (`1 - dilate(1 - m, r)`, stitch.js; K32); a new Float32Array. */
export function erodeMask(data, w, h, r) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.erodeMask(data, w, h, r); }
        catch (err) { if (!recovered(p, err, "erode_mask")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.erodeMask(data, w, h, r);
}

/** A 0..1 float mask `src` as RGBA8 (`mode` 0 white, 1 luminance, 2 alpha) into `out` (stitch.js; K32). */
export function maskToRgba(src, mode = 0, out = null) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.maskToRgba(src, mode, out); }
        catch (err) { if (!recovered(p, err, "mask_to_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.maskToRgba(src, mode, out);
}

/** Bounding box `[x0, y0, x1, y1]` (right and bottom exclusive) of `src` (`w` x `h` Float32Array) where `> 0.5`, or null (stitch.js; K32). */
export function maskBoundsF32(src, w, h) {
    const p = rustPx("stitchMask");
    if (p) {
        try { return p.maskBoundsF32(src, w, h); }
        catch (err) { if (!recovered(p, err, "mask_bounds_f32")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.maskBoundsF32(src, w, h);
}

/** Matches the weighted RGB mean and standard deviation of `patch` (RGBA8, in place) to `reference` under `weight` (stitch.js `colorMatch`; K33). */
export function colorMatchRgba(patch, reference, weight) {
    const p = rustPx("colorMatch");
    if (p) {
        try { return p.colorMatchRgba(patch, reference, weight); }
        catch (err) { if (!recovered(p, err, "color_match_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.colorMatchRgba(patch, reference, weight);
}

/** The alpha byte of each RGBA8 pixel of `rgba` replaced in `out` (or a new Uint8ClampedArray; may be `rgba`) by `Math.round(clamp01(mask[i]) * (keepAlpha ? rgba[i * 4 + 3] : 255))` (stitch.js; K33). */
export function blendAlpha(rgba, mask, keepAlpha = false, out = null) {
    const p = rustPx("blendAlpha");
    if (p) {
        try { return p.blendAlpha(rgba, mask, keepAlpha, out); }
        catch (err) { if (!recovered(p, err, "blend_alpha")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.blendAlpha(rgba, mask, keepAlpha, out);
}

/** Area-average shrink of straight-alpha RGBA8 `rgba` (`w * h * 4` bytes) to `{ gray, alpha }` (`tw * th` Float32Arrays; edgefit.js `shrinkRGBA`, K34). */
export function edgefitShrink(rgba, w, h, tw, th, grayOut = null, alphaOut = null) {
    const p = rustPx("edgefit") && rustPx("edgefitShrink");
    if (p) {
        try { return p.edgefitShrink(rgba, w, h, tw, th, grayOut, alphaOut); }
        catch (err) { if (!recovered(p, err, "edgefit_shrink")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.edgefitShrink(rgba, w, h, tw, th, grayOut, alphaOut);
}
export { edgefitShrink as shrinkRGBA };

/** Bilinear inverse-affine warp of RGBA8 `src` (`w * h * 4` bytes) through `m` (`[a00, a01, tx, a10, a11, ty]`; edgefit.js `warpRGBA`, K34). */
export function warpRgba(src, w, h, m, out = null) {
    const p = rustPx("edgefit") && rustPx("warpRgba");
    if (p) {
        try { return p.warpRgba(src, w, h, m, out); }
        catch (err) { if (!recovered(p, err, "warp_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.warpRgba(src, w, h, m, out);
}
export { warpRgba as warpRGBA };

/** Per-pixel source-bounds coverage mask (`w * h` Float32Array) for `m` (`[a00, a01, tx, a10, a11, ty]`; edgefit.js `warpCoverage`, K34). */
export function warpCoverage(w, h, m, out = null) {
    const p = rustPx("edgefit") && rustPx("warpCoverage");
    if (p) {
        try { return p.warpCoverage(w, h, m, out); }
        catch (err) { if (!recovered(p, err, "warp_coverage")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.warpCoverage(w, h, m, out);
}

/**
 * The blur brush's filter and frequency separation's blur (inpaint_stroke.js `blurRGBA`, K26): straight RGBA8, three
 * box passes of radius r, back to straight bytes; a new Uint8ClampedArray. The twin when the route says "js", when Rust
 * refuses the call (px.js returns null) or after a trap.
 */
export function blurRGBA(src, w, h, r) {
    const p = rustPx("dabBlur");
    if (p) {
        try { const out = p.blurRGBA(src, w, h, r); if (out) return out; }
        catch (err) { if (!recovered(p, err, "blur_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return blurRGBATwin(src, w, h, r);
}

/** The sharpen brush's filter (inpaint_stroke.js `sharpenRGBA`, K26), as `blurRGBA`. */
export function sharpenRGBA(src, w, h, r, amount = 1) {
    const p = rustPx("dabBlur");
    if (p) {
        try { const out = p.sharpenRGBA(src, w, h, r, amount); if (out) return out; }
        catch (err) { if (!recovered(p, err, "sharpen_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return sharpenRGBATwin(src, w, h, r, amount);
}

/**
 * The tone brush's table on straight RGBA8 (inpaint_stroke.js `toneRGBA`, K27); a new Uint8ClampedArray. The twin when
 * the route `dabTone` says "js", when Rust refuses the call (px.js returns null) or after a trap.
 */
export function toneRGBA(src, lut, protect = false) {
    const p = rustPx("dabTone");
    if (p) {
        try { const out = p.toneRGBA(src, lut, protect); if (out) return out; }
        catch (err) { if (!recovered(p, err, "tone_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return toneRGBATwin(src, lut, protect);
}

/** The sponge (inpaint_stroke.js `spongeRGBA`, K27) on the route `dabSponge`, as `toneRGBA`. */
export function spongeRGBA(src, amount, saturate = false, vibrance = true) {
    const p = rustPx("dabSponge");
    if (p) {
        try { const out = p.spongeRGBA(src, amount, saturate, vibrance); if (out) return out; }
        catch (err) { if (!recovered(p, err, "sponge_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return spongeRGBATwin(src, amount, saturate, vibrance);
}

/**
 * Frequency separation's split (inpaint_stroke.js `freqSplit`, K27) on the route `freqSplit`: `L` written in place, the
 * detail returned. Rust writes `L` only once its kernel is done, so a trap leaves it for the twin as it was.
 */
export function freqSplit(I, L) {
    const p = rustPx("freqSplit");
    if (p) {
        try { const out = p.freqSplit(I, L); if (out) return out; }
        catch (err) { if (!recovered(p, err, "freq_split")) throw err; }
        finally { releaseIfLarge(); }
    }
    return freqSplitTwin(I, L);
}

/**
 * Frequency separation (InpaintEditor.frequencySeparation, K26 + K27): `{ low, high }` of the picture `I` (w x h straight
 * RGBA8), its blur of radius `r` and the detail. With both routes on Rust (`dabBlur`, `freqSplit`) one call in one arena
 * (px.js `freqSeparate`: the blur never leaves wasm memory; about 640 MB at 16 MP, released after); otherwise, or when
 * Rust refuses or traps, `blurRGBA` and `freqSplit` above, each on its own route: the same bytes every way.
 */
export function freqSeparate(I, w, h, r) {
    const p = rustPx("dabBlur") && rustPx("freqSplit");
    if (p) {
        try { const out = p.freqSeparate(I, w, h, r); if (out) return out; }
        catch (err) { if (!recovered(p, err, "freq_separate")) throw err; }
        finally { releaseIfLarge(); }
    }
    const low = blurRGBA(I, w, h, r);
    return { low, high: freqSplit(I, low) };
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

/**
 * One tile of `px` pixels (`src` straight RGBA8, `op` an OPS number, `alpha` 0..255, optional `mask` of `px` coverage
 * bytes) composited over `dst` (`px * 4` straight RGBA8 bytes, or null when the destination tile does not exist yet),
 * keeping `dst` (or 0) untouched where `src` has alpha 0 or `mask` is 0 (`inpaint_tiles.js` `compositeStroke`;
 * `kernels_js.js` `compositeMaskedTile` and its Rust twin `px.js` `compositeMaskedTile`, routed by
 * `compositeMaskedTile`, K36). `write(whole)` makes the tile writable and returns its bytes: called at most once, with
 * `true`, and only when the tile changed and holds at least one pixel with alpha > 0 afterwards. Returns 0 when no
 * pixel changed, 1 when changed and non-empty, 2 when changed and empty (the caller drops the tile).
 */
export function compositeMaskedTile(dst, write, src, op, alpha, mask = null, px = 65536) {
    const p = rustPx("compositeMaskedTile");
    let wrote = false;
    const once = (whole) => { wrote = true; return write(whole); };
    if (p) {
        try { return p.compositeMaskedTile(dst, src, op, alpha, mask, px, once); }
        catch (err) { if (wrote || !recovered(p, err, "composite_masked_tile")) throw err; }
        finally { touched(); }
    }
    return J.compositeMaskedTile(dst, src, op, alpha, mask, px, once);
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
    const p = rustPx("matchPixels");
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

/** The CRC-32 of `bytes`, continued from `start` (0 for a new checksum); routed by `crc32` at `bytes.byteLength` bytes (K3). */
export function crc32(bytes, start = 0) {
    const p = rustPx("crc32", bytes ? bytes.byteLength : 0);
    if (p) {
        try { return p.crc32(bytes, start); }
        catch (err) { if (!recovered(p, err, "crc32")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.crc32(bytes, start);
}

/** Frame `dataLen` bytes at `buf[8..8 + dataLen]` as a PNG chunk of 4-byte `kind` (big-endian u32); returns its CRC-32 (K3). */
export function pngChunkFrame(buf, dataLen = buf.byteLength - 12, kind = 0x49444154) {
    const p = rustPx("crc32", dataLen + 4);
    if (p) {
        try { return p.pngChunkFrame(buf, dataLen, kind); }
        catch (err) { if (!recovered(p, err, "png_chunk_frame")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.pngChunkFrame(buf, dataLen, kind);
}

/** Byte capacity of `lines` for a standard `PART_BYTES` (`8 MB`) part of a `w`-wide 8-bit RGBA PNG (K7). */
export function pngPartLinesCap(w) {
    const p = rustPx();
    if (p) {
        try { return p.pngPartLinesCap(w); }
        catch (err) { if (!recovered(p, err, "png_part_lines_cap")) throw err; }
    }
    return J.pngPartLinesCap(w);
}

/** Decode one inflated part (`lines`) of a `w`-wide 8-bit RGBA PNG (K7, docs/PLAN_WASM_BUILD.md §4.2). */
export function pngPartDecode(lines, w, prev = null, rt = null, out = null, laps = null) {
    const p = rustPx();
    if (p) {
        try { return p.pngPartDecode(lines, w, prev, rt, out, laps); }
        catch (err) { if (!recovered(p, err, "png_part_decode")) throw err; }
        finally { releaseIfLarge(); }
    }
    const t0 = laps && typeof performance !== "undefined" ? performance.now() : 0;
    const r = J.pngPartDecode(lines, w, prev, rt, out);
    if (laps && typeof performance !== "undefined") laps.decode = performance.now() - t0;
    return r;
}

/** Finish a part whose `pngPartDecode` answered `needsPrev: true` once `prev` arrives (K7, docs/PLAN_WASM_BUILD.md §4.2). */
export function pngPartFinish(lines, rows, w, prev, rt = null, out = null, laps = null) {
    const p = rustPx();
    if (p) {
        try { return p.pngPartFinish(lines, rows, w, prev, rt, out, laps); }
        catch (err) { if (!recovered(p, err, "png_part_finish")) throw err; }
        finally { releaseIfLarge(); }
    }
    const t0 = laps && typeof performance !== "undefined" ? performance.now() : 0;
    const r = J.pngPartFinish(lines, rows, w, prev, rt, out);
    if (laps && typeof performance !== "undefined") laps.finish = performance.now() - t0;
    return r;
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

const MARCH_MAX = 0x40000000;

function marchGuardOk(w, h, scale, light, radius, bias) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || !(w > 0 && h > 0 && w < MARCH_MAX && h < MARCH_MAX)) return false;
    if (!light || light.length < 4) return false;
    for (const v of [scale, light[0], light[1], light[2], light[3], radius ?? 0, bias ?? 0]) {
        const n = Number(v);
        if (!Number.isFinite(n) || !(Math.abs(n) < MARCH_MAX)) return false;
    }
    if (Number(bias ?? 0) < 0) return false;
    return true;
}

/**
 * Marches shadow rays through u16 depth height field. A full-size `out` takes rows row0.. at row0 * w (both kernels), so
 * the stripes of one march write into one buffer (K12). `key` names the depth map's data for the Rust march's resident copy
 * (px.js `_slot`): the stripes of one march on one worker copy it once; the twin reads `depth` where it lies. Non-finite
 * lights or coordinates `>= 2^30` fall back to the twin (K13).
 */
export function shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out = null, key = null) {
    if (!marchGuardOk(w, h, scale, light, radius, bias)) {
        return J.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out);
    }
    const p = rustPx("shadowMarch", w * h);
    if (p) {
        try {
            const res = p.shadowMarchF64(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out, key);
            if (res) return res;
        }
        catch (err) { if (!recovered(p, err, "shadow_march_f64")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.shadowMarch(depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out);
}

/**
 * The flood job (px.js `floodShape`, kernels_js.js its twin): routed by `flood` at the picture's w * h pixels. `use`
 * runs at most once: an error after it ran (or thrown by it) is rethrown, never answered by the twin a second time.
 */
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use, outKind = 4) {
    const p = rustPx("flood", w * h);
    if (p) {
        let used = false;
        const once = (v, n, b, c) => { used = true; return use(v, n, b, c); };
        try { return p.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, once, outKind); }
        catch (err) { if (used || !recovered(p, err, "flood_shape")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use, outKind);
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
    const once = (whole) => { wrote = true; return write(whole); };
    if (p) {
        try { return p.selCombine(dst, size, src, off, stride, kind, bw, bh, mode, rgb, once); }
        catch (err) { if (wrote || !recovered(p, err, "sel_combine")) throw err; }
        finally { touched(); }
    }
    // a missing tile is made only when the source covers something it keeps: replace and add keep the source's alpha
    if (!dst && (mode >= 2 || !J.alphaAny(src, off, stride, kind, bw, bh))) return null;
    return J.selCombine(once(), size, src, off, stride, kind, bw, bh, mode, rgb);
}

/**
 * One tile of the selection inverted in its `bw` x `bh` corner (inpaint_tiles.js `TileMaskPixels.invert`;
 * kernels_js.js `maskInvert` and its Rust twin px.js `maskInvert`, routed by `maskInvert`, K11). `tile` is the tile's
 * bytes as they are. `write(whole)` makes the tile writable and returns its bytes: on the Rust route it is called with
 * `true` only when the inverted tile holds a pixel (the whole tile is then copied out over it, so a frozen tile skips
 * its prior copy); on the JS twin route it is called before the in-place invert and may then answer null (the caller
 * drops the tile). Returns the inverted tile's extent [x0, y0, x1, y1] or null when it holds no pixel.
 */
export function maskInvert(tile, write, bw, bh, rgb, size = 256) {
    const p = rustPx("maskInvert");
    let wrote = false;
    const once = (whole) => { wrote = true; return write(whole); };
    if (p) {
        try { return p.maskInvert(tile, size, bw, bh, rgb, once); }
        catch (err) { if (wrote || !recovered(p, err, "mask_invert")) throw err; }
        finally { touched(); }
    }
    return J.maskInvert(once(), size, bw, bh, rgb);
}

/**
 * Per-tile minimum, maximum, and edge flag over a depth map (`map` and optional `rmax`, `mw` x `mh` u16) for a
 * `W` x `H` document in `tile`² tiles (K21, docs/PLAN_WASM_BUILD.md §4.8), routed by `mapTileStats`.
 */
export function mapTileStats(map, rmax, mw, mh, xf, W, H, thresh = 0, tile = 256) {
    const p = rustPx("mapTileStats");
    if (p) {
        try { return p.mapTileStats(map, rmax, mw, mh, xf, W, H, thresh, tile); }
        catch (err) { if (!recovered(p, err, "map_tile_stats")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.mapTileStats(map, rmax, mw, mh, xf, W, H, thresh, tile);
}

/**
 * Evaluates the `"compute"`-class tiles of one document tile row `ty` over a depth map and optional joint-bilateral
 * snap (K22, docs/PLAN_WASM_BUILD.md §4.8): plain bilinear tiles routed by `rangeDepth`, snapped tiles (those meeting
 * `pic` when `sigmaR > 0`, `guide`, and `pic` are given) routed by `rangeDepthSnap`. Where one route is `"rust"` and
 * the other is `"js"`, the row's compute classes split between `p.rangeTilesDepth` and `J.rangeTilesDepth` and merge in
 * column order.
 */
export function rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert = false, snap = null, guide = null, pic = null, classes = null, tile = 256) {
    const sigmaR = Array.isArray(snap) && snap.length >= 2 ? +snap[0] || 0 : 0;
    const gBytes = guide && (guide.data || guide);
    const pBytes = pic && pic.data;
    const snapActive = !!(sigmaR > 0 && gBytes && pBytes && (pic.w | 0) > 0 && (pic.h | 0) > 0);
    const pPlain = rustPx("rangeDepth");
    const pSnap = snapActive ? rustPx("rangeDepthSnap") : pPlain;

    if (pPlain && pSnap) {
        try {
            const out = pPlain.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, snap, guide, pic, classes, tile);
            if (out) return out;
        } catch (err) {
            if (!recovered(pPlain, err, "range_tiles_depth")) throw err;
        } finally { releaseIfLarge(); }
        return J.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, snap, guide, pic, classes, tile);
    }

    if (!pPlain && !pSnap) {
        return J.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, snap, guide, pic, classes, tile);
    }

    // Split routing: plain bilinear tiles on one side (`rangeDepth`) and snapped tiles on the other (`rangeDepthSnap`).
    if (!(W > 0 && H > 0 && tile > 0)) {
        return J.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, snap, guide, pic, classes, tile);
    }
    const cols = Math.ceil(W / tile);
    const tileY0 = ty * tile, tileY1 = Math.min(tileY0 + tile, H);
    const ry0 = Math.max(tileY0, y0), ry1 = Math.min(tileY1, y1);
    const picX0 = pic.x0 | 0, picY0 = pic.y0 | 0;
    const picX1 = picX0 + (pic.w | 0), picY1 = picY0 + (pic.h | 0);
    const yOverlaps = ry0 < picY1 && ry1 > picY0;
    const plainClasses = new Uint8Array(cols);
    const snapClasses = new Uint8Array(cols);
    let hasPlain = false, hasSnap = false;
    for (let tx = 0; tx < cols; tx++) {
        const cls = classes ? classes[tx] : 2;
        if (cls !== 2 && cls !== "compute") continue;
        const tileX0 = tx * tile, tileX1 = Math.min(tileX0 + tile, W);
        if (yOverlaps && tileX0 < picX1 && tileX1 > picX0) {
            snapClasses[tx] = 2;
            hasSnap = true;
        } else {
            plainClasses[tx] = 2;
            hasPlain = true;
        }
    }

    const runSide = (p, cls, withSnap) => {
        const s = withSnap ? snap : null, g = withSnap ? guide : null, pc = withSnap ? pic : null;
        if (p) {
            try {
                const out = p.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, s, g, pc, cls, tile);
                if (out) return out;
            } catch (err) {
                if (!recovered(p, err, "range_tiles_depth")) throw err;
            } finally { releaseIfLarge(); }
        }
        return J.rangeTilesDepth(map, mw, mh, xf, W, H, ty, y0, y1, limit, invert, s, g, pc, cls, tile);
    };

    if (!hasSnap) return runSide(pPlain, plainClasses, false);
    if (!hasPlain) return runSide(pSnap, snapClasses, true);

    const rPlain = runSide(pPlain, plainClasses, false);
    const rSnap = runSide(pSnap, snapClasses, true);
    const tiles = [...rPlain.tiles, ...rSnap.tiles].sort((a, b) => a.tx - b.tx);
    let bounds = null;
    if (rPlain.bounds && rSnap.bounds) {
        bounds = [
            Math.min(rPlain.bounds[0], rSnap.bounds[0]),
            Math.min(rPlain.bounds[1], rSnap.bounds[1]),
            Math.max(rPlain.bounds[2], rSnap.bounds[2]),
            Math.max(rPlain.bounds[3], rSnap.bounds[3]),
        ];
    } else {
        bounds = rPlain.bounds || rSnap.bounds;
    }
    return { tiles, bounds, alphaSum: (rPlain.alphaSum || 0) + (rSnap.alphaSum || 0) };
}

/**
 * Evaluates one document tile row `ty` (`[y0, y1)` clipped to `[ty * tile, min((ty + 1) * tile, H))`) over a
 * `(y1 - y0)`-row RGBA8 band `rgba` for `"luma"` (routed by `rangeLuma`) or `"color"` (routed by `rangeColor`) range
 * selection (K23, docs/PLAN_WASM_BUILD.md §4.8).
 */
export function rangeTilesRgba(rgba, W, H, ty, y0, y1, limit, invert = false, tile = 256) {
    const isColor = limit && (limit.source === "color" || (limit.source !== "luma" && limit.color != null));
    const p = rustPx(isColor ? "rangeColor" : "rangeLuma");
    if (p) {
        try {
            const out = p.rangeTilesRgba(rgba, W, H, ty, y0, y1, limit, invert, tile);
            if (out) return out;
        } catch (err) {
            if (!recovered(p, err, "range_tiles_rgba")) throw err;
        } finally { releaseIfLarge(); }
    }
    return J.rangeTilesRgba(rgba, W, H, ty, y0, y1, limit, invert, tile);
}

/**
 * Unpacks one TIFF strip or tile of uncompressed (`1`), LZW (`5`) or PackBits (`32773`) bytes `src` into `out`
 * (`need` bytes, allocated when absent), stopping as soon as `need` bytes are written (`inpaint_tiff.js`
 * `unpackStrip`, K16, K17, `docs/PLAN_WASM_BUILD.md` §4.6). LZW and PackBits are routed by `tiffUnpack`;
 * uncompressed (`1`) stays on the JS copy (`dst.set`) to avoid copying `src` in and `out` back across wasm.
 */
export function tiffUnpack(compression, src, need, out = null, name = "strip") {
    if (compression !== 1) {
        const p = rustPx("tiffUnpack");
        if (p) {
            try { return p.tiffUnpack(compression, src, need, out, name); }
            catch (err) { if (!recovered(p, err, "tiff_unpack")) throw err; }
            finally { releaseIfLarge(); }
        }
    }
    return J.tiffUnpack(compression, src, need, out, name);
}

/**
 * Undo horizontal differencing (Predictor 2) in place on `rows` rows of `rowBytes` stride, each `pixels` wide with
 * `per` samples per pixel at `bits` (`8` or `16`) bits per sample (`inpaint_tiff.js` `unpredict`, K15,
 * `docs/PLAN_WASM_BUILD.md` §4.6), routed by `tiffUnpredict`.
 */
export function tiffUnpredict(buf, rows, rowBytes, pixels, per, bits, le = true) {
    const p = rustPx("tiffUnpredict");
    if (p) {
        try { return p.tiffUnpredict(buf, rows, rowBytes, pixels, per, bits, le); }
        catch (err) { if (!recovered(p, err, "tiff_unpredict")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.tiffUnpredict(buf, rows, rowBytes, pixels, per, bits, le);
}

/**
 * Horizontal differencing (Predictor 2) in place on `rows` rows of `w`-wide RGBA8 (`inpaint_tiff.js` `predictRgba`, K15),
 * routed by `tiffPredict`.
 */
export function tiffPredictRgba(rgba, w, rows) {
    const p = rustPx("tiffPredict");
    if (p) {
        try { return p.tiffPredictRgba(rgba, w, rows); }
        catch (err) { if (!recovered(p, err, "tiff_predict_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.tiffPredictRgba(rgba, w, rows);
}

/**
 * Convert `rows` rows (`bufs`: one buffer for chunky, or `samples` buffers for planar) to straight-alpha RGBA8 in `out`
 * (or a fresh `Uint8Array(rows * width * 4)`; `inpaint_tiff.js` `toRgba`, K15), routed by `tiffToRgba`.
 */
export function tiffToRgba(bufs, rows, out = null, spec = {}) {
    const p = rustPx("tiffToRgba");
    if (p) {
        try { return p.tiffToRgba(bufs, rows, out, spec); }
        catch (err) { if (!recovered(p, err, "tiff_to_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.tiffToRgba(bufs, rows, out, spec);
}

/**
 * One strip of a TIFF from `{ rgba, w, rows, predictor = 2 }` (or positional `(rgba, w, rows, level, predictor, laps)`),
 * byte-identical to `tiffPart(args, (b) => p.zlib(b, level))` (`inpaint_tiff.js` `tiffPart`, K15), routed by
 * `tiffStripWasm` and `tiffPredict`.
 */
export async function tiffStrip(rgbaOrArgs, wOrLevel = 2, rowsOrLaps = null, level = 2, predictor = 2, laps = null) {
    const p = rustPx("tiffStripWasm") && rustPx("tiffPredict");
    if (p) {
        try { return p.tiffStrip(rgbaOrArgs, wOrLevel, rowsOrLaps, level, predictor, laps); }
        catch (err) { if (!recovered(p, err, "tiff_part")) throw err; }
        finally { releaseIfLarge(); }
    }
    let args = rgbaOrArgs, lvl = wOrLevel, lp = rowsOrLaps;
    if (!rgbaOrArgs || typeof rgbaOrArgs !== "object" || ArrayBuffer.isView(rgbaOrArgs) || rgbaOrArgs instanceof ArrayBuffer) {
        args = { rgba: rgbaOrArgs, w: wOrLevel, rows: rowsOrLaps, predictor };
        lvl = level;
        lp = laps;
    }
    const pz = rustPx();
    return J.tiffPart(args, (bytes) => (pz ? pz.zlib(bytes, lvl) : J.deflate(bytes)), lp);
}

const TIFF_RUST = Object.freeze({
    unpackStrip: tiffUnpack,
    unpredict: tiffUnpredict,
    predictRgba: tiffPredictRgba,
    toRgba: tiffToRgba,
    paletteLut: J.paletteLut,
});

/**
 * The TIFF kernel set for `readTiff(..., { kernels: tiffKernels() })` (K15, `docs/PLAN_WASM_BUILD.md` §4.6).
 * Each method looks up `rustPx(...)` per call so an instance swap (`releaseIfLarge` or trap recovery) mid-stream uses
 * the new instance (or falls back to `TIFF_JS` when `setKernels("js")` or a route override is active).
 */
export function tiffKernels() {
    return TIFF_RUST;
}


/**
 * Multiplies the alpha channel of `rgba` (`w * h * 4` RGBA8 bytes, in place) by the depth limit weight over `map`
 * (`mw` x `mh` u16, affine transform `xf`) and optional joint-bilateral snap (`snap = [sigmaR, tau]`, `guide`,
 * optional `col` reference RGBA8) in chunks of at most 256 rows (K25, docs/PLAN_WASM_BUILD.md §4.8), routed by
 * `limitAlphaRows`.
 */
export function limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap = null, guide = null, col = null) {
    const p = rustPx("limitAlphaRows");
    let done = 0;
    if (p) {
        try {
            return p.limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap, guide, col);
        } catch (err) {
            if (!recovered(p, err, "limit_alpha_rows")) throw err;
            done = (err && typeof err === "object" && err.doneRows > 0) ? err.doneRows : 0;
        } finally { releaseIfLarge(); }
    }
    if (done > 0 && done < h) {
        const off = done * w * 4;
        const subRgba = new Uint8Array(rgba.buffer, rgba.byteOffset + off, (h - done) * w * 4);
        const subCol = col ? new Uint8Array(col.buffer, col.byteOffset + off, (h - done) * w * 4) : null;
        J.limitAlphaRows(subRgba, map, mw, mh, xf, x0, y0 + done, w, h - done, limit, snap, guide, subCol);
        return rgba;
    }
    return J.limitAlphaRows(rgba, map, mw, mh, xf, x0, y0, w, h, limit, snap, guide, col);
}

/**
 * The depth map's guided filter (`inpaint_depth.js` `guidedFar`, K24), routed by `guidedFar`. Accepts either an options
 * object `{ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }` (with optional `out` as the second argument) or positional
 * `(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null)`.
 */
export function guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out = null) {
    const p = rustPx("guidedFar");
    if (p) {
        try {
            const res = p.guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out);
            if (res) return res;
        } catch (err) {
            if (!recovered(p, err, "guided_far")) throw err;
        } finally { releaseIfLarge(); }
    }
    return J.guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi, out);
}

/**
 * Unpack `rows` PSD PackBits rows (`rowBytes` unpacked bytes per row) from `src`, advancing by each row's big-endian
 * `u16` byte count in `lensBytes` (`inpaint_layered.js` `packbitsRows`, K20b), routed by `psdRead`.
 */
export function packbitsRows(lensBytes, src, rows, rowBytes, out = null) {
    const p = rustPx("psdRead");
    if (p) {
        try { return p.packbitsRows(lensBytes, src, rows, rowBytes, out); }
        catch (err) { if (!recovered(p, err, "packbits_rows")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.packbitsRows(lensBytes, src, rows, rowBytes, out);
}

/**
 * Place a band's mask overlap into `out` as `[255, 255, 255, alpha]` over `[ry0, ry1) × [x0, x1)` and
 * `[255, 255, 255, def]` elsewhere (`inpaint_layered.js` `psdMaskRgba`, K20b), routed by `psdRead`.
 */
export function psdMaskRgba(src, mw, sx0, w, rows, x0, x1, ry0, ry1, bits, def, out = null) {
    const p = rustPx("psdRead");
    if (p) {
        try { return p.psdMaskRgba(src, mw, sx0, w, rows, x0, x1, ry0, ry1, bits, def, out); }
        catch (err) { if (!recovered(p, err, "psd_mask_rgba")) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.psdMaskRgba(src, mw, sx0, w, rows, x0, x1, ry0, ry1, bits, def, out);
}

const PSD_RUST = Object.freeze({
    packbitsRows,
    maskRgba: psdMaskRgba,
    bandRgba(descs, w, y0, rows, depth, gray, spent = null) {
        const p = rustPx("psdRead") && rustPx("tiffUnpredict") && rustPx("tiffToRgba");
        if (p) {
            try { return p.psdBandRgba(descs, w, y0, rows, depth, gray, spent); }
            catch (err) { if (!recovered(p, err, "packbits_rows")) throw err; }
            finally { releaseIfLarge(); }
        }
        return J.psdBandRgba(descs, w, y0, rows, depth, gray, spent);
    },
    bandMask(desc, L, m, w, h, y0, rows, depth, spent = null) {
        const p = rustPx("psdRead") && rustPx("tiffUnpredict");
        if (p) {
            try { return p.psdBandMask(desc, L, m, w, h, y0, rows, depth, spent); }
            catch (err) { if (!recovered(p, err, "psd_mask_rgba")) throw err; }
            finally { releaseIfLarge(); }
        }
        return J.psdBandMask(desc, L, m, w, h, y0, rows, depth, spent);
    },
});

/**
 * The PSD band kernel set for `readPsdStream(..., { kernels: psdKernels() })` (K20b, `docs/PLAN_WASM_K20.md` §2.3).
 * Each band looks up `rustPx("psdRead")` dynamically so an instance replacement or trap recovery mid-file falls back
 * seamlessly without dropping or duplicating bands.
 */
export function psdKernels() {
    return PSD_RUST;
}


