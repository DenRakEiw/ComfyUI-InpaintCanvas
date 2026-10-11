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
 * `setKernels("js")` forces the twins in this thread (the benchmark, tools/px_jobs.py). wasm memory never shrinks, so
 * after a call that grew the instance past RELEASE_BYTES (a flood over a whole 15k picture takes about 0.8 GB) the
 * instance is replaced by a fresh one of the same compiled module and the old memory is collected.
 */
import * as J from "./kernels_js.js";
import { loadPx, Px } from "./px.js";
import { resampleBlock as resampleBlockJS, resampleTable } from "../inpaint_resample.js";

export { OPS, mipChainBytes, deflate, SMUDGE_ALPHA_LOCK, SMUDGE_PICKUP, POISSON_TOL, POISSON_MAX_CYCLES } from "./kernels_js.js";

const RELEASE_BYTES = 256 * 1048576;

let PX = null;
let MODE = "rust";
let LOADING = null;

/** Resolves to the Rust kernels of this thread, or null when they cannot load (the twins then run). */
export function kernelsReady() {
    if (!LOADING) {
        LOADING = loadPx(new URL("./px.wasm", import.meta.url)).then((px) => { PX = px; return px; }).catch((err) => {
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
/** The loaded Rust instance when this thread uses it, else null. */
export function rustPx() { return MODE === "rust" ? PX : null; }

/** After a call on a large buffer: let go of the grown memory. */
export function releaseIfLarge() {
    if (PX && PX.byteLength > RELEASE_BYTES) PX = new Px(new WebAssembly.Instance(PX.module, {}), PX.module);
}

/** The resampler's kernel (inpaint_resample.js `resampleBlock`, its twin): Rust once loaded, the same bytes either way. */
export function resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh) {
    const p = rustPx();
    if (!p) return resampleBlockJS(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh);
    const w = resampleTable(filter);
    return p.resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh, w.table, w.taps);
}

export function mipHalf(src, sw, sh, dst = null) {
    const p = rustPx();
    return p ? p.mipHalf(src, sw, sh, dst) : J.mipHalf(src, sw, sh, dst);
}

export function mipChain(src, size, levels, out = null) {
    const p = rustPx();
    return p ? p.mipChain(src, size, levels, out) : J.mipChain(src, size, levels, out);
}

export function clampExtend(bytes, size, vw, vh) {
    const p = rustPx();
    return p ? p.clampExtend(bytes, size, vw, vh) : J.clampExtend(bytes, size, vw, vh);
}

export function distTransform(feature, W, H, out = null, scratch = null) {
    const p = rustPx();
    if (!p) return J.distTransform(feature, W, H, out || new Float32Array(W * H), scratch);
    try { return p.distTransform(feature, W, H, out); } finally { releaseIfLarge(); }
}

/** The row filters of PNG lines undone (the stream reader, inpaint_png.js): see kernels_js.js `pngUnfilterRows`. */
export function pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba = null) {
    const p = rustPx();
    if (!p) return J.pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba);
    try { return p.pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba); } finally { releaseIfLarge(); }
}

/** Square dilation of a float mask by r pixels (a provider run's masks, stitch.js); a new Float32Array. */
export function dilateMask(data, w, h, r) {
    const p = rustPx();
    if (!p) return J.dilateMask(data, w, h, r);
    try { return p.dilateMask(data, w, h, r); } finally { releaseIfLarge(); }
}

/** Box blurs of up to three radii over a float mask (the passes of stitch.js' gaussian); a new Float32Array. */
export function boxBlurs(data, w, h, radii) {
    const p = rustPx();
    if (!p) return J.boxBlurs(data, w, h, radii);
    try { return p.boxBlurs(data, w, h, radii); } finally { releaseIfLarge(); }
}

export function compositeTile(dst, srcs, ops, alphas, masks = null) {
    const p = rustPx();
    return p ? p.compositeTile(dst, srcs, ops, alphas, masks) : J.compositeTile(dst, srcs, ops, alphas, masks);
}

/** One smudge dab: `dst` (straight RGBA8) and `carry` (premultiplied u16) in place (PLAN_0_1_31 §4 step 3). */
export function smudgeDab(dst, src, carry, mask, strength, keep, flags = 0) {
    const p = rustPx();
    return p ? p.smudgeDab(dst, src, carry, mask, strength, keep, flags) : J.smudgeDab(dst, src, carry, mask, strength, keep, flags);
}

/** The healing brush's Poisson blend over a box (PLAN_0_1_31 §5 step 1): `out` straight RGBA8, `info` [healed, cycles, levels]. */
export function poissonBlend(dst, src, mask, w, h, out = null, info = null) {
    const p = rustPx();
    if (!p) return J.poissonBlend(dst, src, mask, w, h, out || new Uint8Array(w * h * 4), info);
    try { return p.poissonBlend(dst, src, mask, w, h, out, info); } finally { releaseIfLarge(); }
}

export function matchPixels(rgba, params) {
    const p = rustPx();
    return p ? p.matchPixels(rgba, params) : J.matchPixels(rgba, params);
}

export function psdPackRows(rgba, w, rows) {
    const p = rustPx();
    return p ? p.psdPackRows(rgba, w, rows) : J.psdPackRows(rgba, w, rows);
}

export function pngFilterRows(rgba, w, rows, prev = null, out = null) {
    const p = rustPx();
    return p ? p.pngFilterRows(rgba, w, rows, prev, out) : J.pngFilterRows(rgba, w, rows, prev, out || undefined);
}

/** Computes max - min over each texel's 4x4 block of a w x h Uint16Array. */
export function rangeMax(src, w, h, out = null) {
    const p = rustPx();
    if (!p) return J.rangeMax(src, w, h, out);
    try { return p.rangeMax(src, w, h, out); } finally { releaseIfLarge(); }
}

