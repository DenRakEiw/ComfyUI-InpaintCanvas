// Generated from DenRakEiw/scumble renderer/editor/inpaint_worker.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The editor's worker: everything that used to stall the main thread with a whole image
 * in hand. It runs in the ComfyUI page and in the app alike (a module worker created from
 * `import.meta.url`, so both hosts serve it from next to the editor).
 *
 * Jobs:
 *   png             one canvas -> a PNG blob, optionally with the upload hash. The main
 *                   thread only pays for createImageBitmap (25 ms on a 96 MP canvas)
 *                   instead of the 755 ms that canvas.toBlob blocks it for.
 *   export_begin / export_layer / export_finish
 *                   a layered PSD or ORA file, one layer at a time: the layer is packed
 *                   as soon as its pixels arrive, so only one layer is ever in flight and
 *                   the 3 s PackBits run happens off the main thread. A PSD layer's mask
 *                   comes as a second bitmap (`maskBitmap`, its alpha the mask).
 *   selection       grow, shrink, feather or invert the selection (up to 3.9 s on the
 *                   main thread at 96 MP).
 *   flood           the magic wand's and the bucket's region: the similar pixels around a
 *                   point, clipped to the selection, as a coloured shape.
 *   mips            the mip chains of a batch of tiles, after a change of a whole layer or
 *                   mask (2,360 chains, about 300 ms, at 15000 x 10000). The editor runs
 *                   this job in a worker of its own, so a long flood does not hold it up.
 *   png_part        one part of a PNG written in parts (inpaint_png.js): rows, as bytes or as the tiles that hold
 *                   them, filtered and deflated into a finished IDAT chunk. Stateless, so the pool runs them.
 *   hash            the short SHA-1 of a blob.
 *   psd_part        one part of a PSD's channel data: rows (bytes or tiles) as PackBits per channel.
 *   crc             CRC-32 and size of a blob (a zip entry of an ORA file).
 *   psd_read        a PSD file read here (inpaint_layered.js `readPsdStream`): its layers back band by band as RGBA
 *                   (`progress` messages), the window never runs the reader's loops (docs/PLAN_WASM_BUILD.md §7 D0).
 *   inflate_bench   byte ranges of a blob through the browser's inflater, counted and dropped: a benchmark only.
 *   png_read        a PNG file decoded as a stream, its rows back band by band (`progress` messages).
 *   tiff_band       one planned band of a TIFF (`readTiffBand`, K18): per-file `spec` and that band's slices only,
 *                   its RGBA8 transferred back.
 *   tiff_read       a TIFF file decoded as a stream (`readTiff`), for single-strip / huge bands and the fallback.
 *   image_read      any image file the browser decodes (JPEG, WebP, a PNG with a colour profile), decoded here and
 *                   read back band by band like png_read: the window never decodes or reads it.
 *   resample        one row of destination tiles of an affine resample (inpaint_resample.js): the straighten of 23b.
 *   liquify         one row of output tiles of a liquify bake (inpaint_liquify.js): PLAN_0_1_31 §5 step 5.
 *   band            a row of tiles composited, layer over layer (`compositeTile`): no caller in
 *                   the editor yet; phase R measures the kernel phase E's band export will run.
 *   poisson         the healing brush's blend over a stroke's box (`poissonBlend`, PLAN_0_1_31 §5): the picture,
 *                   the source patch and the mask as plain buffers in, the healed box back.
 *   px_probe        one kernel's calls timed one by one on this thread's instance, a posted Module's or one compiled
 *                   from bytes (a new worker's cold and warm calls, tools/px_probe.py): a diagnostic only, like
 *                   inflate_bench.
 *   px_stats        this thread's px instances and memory (kernels.js `pxInstances`), answered at once like `arena`.
 *   area_cells      the separate areas of the selection (inpaint_areas.js, CLAUDE.md item 54): its tiles' selected
 *                   pixels counted on a coarse grid and the grid's parts labelled, their boxes back.
 *
 * Pixels arrive as ImageBitmaps (transferred, never copied through structured cloning) and
 * are closed as soon as they are drawn. Every reply carries the request's id; a failure
 * comes back as { ok: false, error } and the editor falls back to the main thread.
 *
 * The pixel kernels come from px/kernels.js: the Rust build once this worker has loaded it, the
 * JS twins before and without it. `kernels: "js"` on a job forces the twins (the benchmark,
 * tools/px_jobs.py), and `routes` carries the window's route overrides (kernels.js `adoptRoutes`: the `flood` and
 * `mips` jobs take the twins where a route says so). The mips, selection, flood and band jobs reply with `timing`: the
 * milliseconds of their parts.
 */
import { PsdWriter, OraWriter } from "./inpaint_export.js";
import { floodMask, maskToColorCanvas, clipMaskToSelection, clipCoverage, growMaskBounds, invertMask, maskBounds, hexToRgb } from "./inpaint_raster.js";
import { crc32, readPng, PNG_LEVEL, NO_PARTS } from "./inpaint_png.js";
import { readTiff, readTiffBand, tiffPart } from "./inpaint_tiff.js";
import { readPsdStream, inflateAtMost } from "./inpaint_layered.js";
import { resampleStore } from "./inpaint_resample.js";
import { liquifyStore } from "./inpaint_liquify.js";
import { disparityRange } from "./inpaint_depth.js";
import { rangeRowBookkeeping } from "./inpaint_weights.js";
import { fuseTiles } from "./inpaint_edges.js";
import { mipChain, mipChainBytes, clampExtend, compositeTile, matchPixels, psdPackRows, kernelsReady, setKernels, rustPx, kernelsInUse, releaseIfLarge, deflate, resampleBlock, liquifyBlock, poissonBlend, boxBlurs, heightNormals, shadowMarch, pxCalls, floodShape, recovered, pxSplit, pxJobStart, pxJobEnd, adoptRoutes, pxTimed, pxInstances, dropPx, pxSettled, pxLapAdd, PxOutOfMemory, rangeTilesDepth, rangeTilesRgba, guidedFar, route, pngPartLinesCap, pngPartDecode, pngPartFinish, tiffKernels, psdKernels } from "./px/kernels.js";
import { Px } from "./px/px.js";
import { hash32, mul255 } from "./blend_modes.js";
import { detailRatio } from "./inpaint_relight.js";
import { countTileCells, labelParts } from "./inpaint_areas.js";

const TILE = 256, LEVELS = 5, TILE_BYTES = TILE * TILE * 4;
const now = () => performance.now();

// The tile arena's chunks (inpaint_arena.js, docs/PLAN_BCE.md §E1): index -> SharedArrayBuffer, sent by the pool before
// the first job and on every change. A job names a tile in the arena as { chunk, slot } and it is read where it lies;
// any other tile comes as { data: ArrayBuffer }, a copy, transferred.
const ARENA = new Map();

function arenaMessage(msg) {
    for (const [index, sab] of msg.added || []) ARENA.set(index, sab);
    for (const index of msg.dropped || []) ARENA.delete(index);
}

/** The bytes of a job's tile. `shared`: they are the document's own, never to be written. */
function tileBytes(t) {
    if (t.data) return { bytes: new Uint8Array(t.data, 0, TILE_BYTES), shared: false };
    const sab = ARENA.get(t.chunk);
    if (!sab) throw new Error("unknown arena chunk " + t.chunk);
    return { bytes: new Uint8Array(sab, t.slot * TILE_BYTES, TILE_BYTES), shared: true };
}

/**
 * The mip chains of a batch of tiles (docs/PLAN_BCE.md §C6 b): each tile's bytes (a copy, transferred) give
 * its chain, and an edge tile (valid part vw x vh below 256) also the chain of its clamp-extended bytes, which
 * is what the atlas and the region canvases draw. The same kernels the main thread runs, so the bytes are the
 * ones it would build. The chains and the tile buffers go back transferred (the buffers for the next batch).
 */
async function mips(msg) {
    // the `mips` route (kernels.js) sends the batch to the twins, and with it the wrappers mipsJs calls
    let p = rustPx("mips");
    const t0 = now();
    let out = null;
    if (p) {
        // a trap or an out-of-memory replaces the instance and the twins make the batch: mipsRust only reads the job's
        // tiles, so they start from the same bytes
        try { out = mipsRust(p, msg); } catch (err) { if (!recovered(p, err, "mip_chain")) throw err; p = null; }
    }
    if (!out) out = mipsJs(msg);
    out.timing = { op: "mips", kernels: p ? "rust" : "js", tiles: msg.tiles.length, kernel: now() - t0 };
    return out;
}

function mipsJs(msg) {
    const n = mipChainBytes(TILE, LEVELS);
    const chains = [], exts = [], datas = [], transfer = [];
    for (const t of msg.tiles) {
        const { bytes, shared } = tileBytes(t);
        const chain = mipChain(bytes, TILE, LEVELS, new Uint8Array(n));
        chains.push(chain.buffer);
        transfer.push(chain.buffer);
        if (t.vw < TILE || t.vh < TILE) {
            // extended in place in the job's copy; a tile in the arena is the document's, so in a copy of it
            const own = shared ? bytes.slice() : bytes;
            clampExtend(own, TILE, t.vw, t.vh);
            const ext = mipChain(own, TILE, LEVELS, new Uint8Array(n));
            exts.push(ext.buffer);
            transfer.push(ext.buffer);
        } else {
            exts.push(null);
        }
        datas.push(t.data || null);
        if (t.data) transfer.push(t.data);
    }
    return { chains, exts, datas, transfer };
}

/**
 * The same chains from the Rust kernels: each tile copied into wasm memory, its chain copied out. The copies go past
 * Px `_in` / `_out`, so a timed job books them here (`pxLapAdd`); the reset after a trap keeps the chains (Px `_reset`).
 */
function mipsRust(p, msg) {
    const n = p.exports.mip_chain_bytes(TILE, LEVELS), a = p.job, timed = pxTimed();
    const chains = [], exts = [], datas = [], transfer = [];
    try {
        const pin = a.take(TILE * TILE * 4), pout = a.take(n);
        for (const t of msg.tiles) {
            const { bytes, shared } = tileBytes(t);
            let c = timed ? now() : 0;
            p.u8().set(bytes, pin);
            if (timed) pxLapAdd("copyIn", now() - c, TILE_BYTES, shared);
            p.exports.mip_chain(pin, TILE, LEVELS, pout);
            if (timed) c = now();
            const chain = p.u8().slice(pout, pout + n);
            if (timed) pxLapAdd("copyOut", now() - c, n);
            chains.push(chain.buffer);
            transfer.push(chain.buffer);
            if (t.vw < TILE || t.vh < TILE) {
                p.exports.clamp_extend(pin, TILE, t.vw, t.vh);
                p.exports.mip_chain(pin, TILE, LEVELS, pout);
                if (timed) c = now();
                const ext = p.u8().slice(pout, pout + n);
                if (timed) pxLapAdd("copyOut", now() - c, n);
                exts.push(ext.buffer);
                transfer.push(ext.buffer);
            } else {
                exts.push(null);
            }
            datas.push(t.data || null);
            if (t.data) transfer.push(t.data);
        }
    } finally { p._reset(a); }
    return { chains, exts, datas, transfer };
}

/**
 * A row of tiles composited (docs/PLAN_BCE.md §2b, E2): `columns` of { dst, srcs: [ArrayBuffer], masks: [ArrayBuffer or
 * null] }, the same `ops` and `alphas` for every column. Each dst comes back composited, transferred.
 */
async function band(msg) {
    const t0 = now();
    const transfer = [];
    for (const col of msg.columns) {
        const dst = new Uint8Array(col.dst);
        const srcs = col.srcs.map((b) => new Uint8Array(b)), masks = col.masks.map((b) => (b ? new Uint8Array(b) : null));
        compositeTile(dst, srcs, msg.ops, msg.alphas, masks);
        transfer.push(col.dst);
    }
    return { dsts: transfer, transfer, timing: { op: "band", kernels: kernelsInUse(), tiles: msg.columns.length, kernel: now() - t0 } };
}

/** The healing brush's blend (PLAN_0_1_31 §5 step 2): `dst`, `src` (RGBA8) and `mask` (a byte a pixel) of a w x h box. */
function poissonJob(msg) {
    const t0 = now(), w = msg.w, h = msg.h;
    const out = new Uint8Array(w * h * 4), info = new Int32Array(4);
    poissonBlend(new Uint8Array(msg.dst), new Uint8Array(msg.src), new Uint8Array(msg.mask), w, h, out, info);
    return { out: out.buffer, info: Array.from(info), transfer: [out.buffer], timing: { op: "poisson", kernels: kernelsInUse(), pixels: info[0], kernel: now() - t0 } };
}

/**
 * The rows `r0` to `r0 + rows` of one tile row as RGBA8, `w` wide: `tiles` holds the row's tiles from the left (null
 * for one that does not exist: transparent). With `above`, the single row above them instead (the PNG filter's `prev`):
 * row `r0 - 1` of the same tiles, or the last row of `prevTiles`, or null for the picture's first row.
 */
export function rowsOfTiles(msg, above = false) {
    let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;
    if (above) {
        if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return null;
    }
    const w = msg.w, out = new Uint8Array(w * rows * 4);
    for (let tx = 0; tx * TILE < w; tx++) {
        const t = tiles[tx];
        if (!t) continue;
        const { bytes } = tileBytes(t);
        const n = Math.min(TILE, w - tx * TILE) * 4;
        for (let y = 0; y < rows; y++) {
            const so = (r0 + y) * TILE * 4;
            out.set(bytes.subarray(so, so + n), (y * w + tx * TILE) * 4);
        }
    }
    return out;
}

/**
 * The same tile rows gathered directly into wasm memory at `ptr` (K10b, docs/PLAN_WASM_K10.md §5.1).
 * Returns false only when `above` is true at the picture's top row (`r0 === 0 && !msg.prevTiles`).
 */
export function tilesRowsToWasm(p, msg, above, ptr) {
    let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;
    if (above) {
        if (r0 > 0) { r0--; rows = 1; }
        else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; }
        else return false;
    }
    const w = msg.w, timed = pxTimed();
    const mem = p.u8();
    mem.fill(0, ptr, ptr + w * rows * 4);
    for (let tx = 0; tx * TILE < w; tx++) {
        const t = tiles[tx];
        if (!t) continue;
        const { bytes, shared } = tileBytes(t);
        const n = Math.min(TILE, w - tx * TILE) * 4;
        const c0 = timed ? now() : 0;
        for (let y = 0; y < rows; y++) {
            const so = (r0 + y) * TILE * 4;
            mem.set(bytes.subarray(so, so + n), ptr + (y * w + tx * TILE) * 4);
        }
        if (timed) pxLapAdd("copyIn", now() - c0, n * rows, shared);
    }
    return true;
}

/**
 * The rows `Y0` to `Y0 + n` of the image out of one store of a stack: `{ x, y, w, h, tiles }`, its pixels at (x, y) of
 * the image, `tiles[lty]` the names of its tile row `lty` from the left (as `rowsOfTiles` takes them). Into `out`, `W`
 * pixels wide from the image's column `X0`: RGBA8, or with `alphaOnly` one byte a pixel, the alpha. False when no tile
 * of the store lies there.
 */
export function storeRows(store, X0, W, Y0, n, out, alphaOnly = false) {
    const sx = store.x | 0, sy = store.y | 0;
    const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);
    const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);
    if (y1 <= y0 || x1 <= x0) return false;
    let any = false;
    for (let lty = (y0 - sy) >> 8; lty * TILE < y1 - sy; lty++) {
        const names = store.tiles[lty];
        if (!names) continue;
        const ry0 = Math.max(y0, sy + lty * TILE), ry1 = Math.min(y1, sy + (lty + 1) * TILE);
        for (let ltx = (x0 - sx) >> 8; ltx * TILE < x1 - sx; ltx++) {
            const t = names[ltx];
            if (!t) continue;
            const { bytes } = tileBytes(t);
            const cx0 = Math.max(x0, sx + ltx * TILE), cx1 = Math.min(x1, sx + (ltx + 1) * TILE), k = cx1 - cx0;
            any = true;
            for (let Y = ry0; Y < ry1; Y++) {
                const so = ((Y - sy - lty * TILE) * TILE + (cx0 - sx - ltx * TILE)) * 4, o = (Y - Y0) * W + cx0 - X0;
                if (alphaOnly) for (let i = 0; i < k; i++) out[o + i] = bytes[so + i * 4 + 3];
                else out.set(bytes.subarray(so, so + k * 4), o * 4);
            }
        }
    }
    return any;
}

/**
 * The same store rows gathered directly into wasm memory at `ptr` (K10b, docs/PLAN_WASM_K10.md §5.2).
 * Returns false when no tile of the store lies in the requested row/column window.
 */
export function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) {
    const sx = store.x | 0, sy = store.y | 0;
    const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);
    const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);
    if (y1 <= y0 || x1 <= x0) return false;
    const mem = p.u8(), timed = pxTimed();
    let any = false;
    for (let lty = (y0 - sy) >> 8; lty * TILE < y1 - sy; lty++) {
        const names = store.tiles[lty];
        if (!names) continue;
        const ry0 = Math.max(y0, sy + lty * TILE), ry1 = Math.min(y1, sy + (lty + 1) * TILE);
        for (let ltx = (x0 - sx) >> 8; ltx * TILE < x1 - sx; ltx++) {
            const t = names[ltx];
            if (!t) continue;
            const { bytes, shared } = tileBytes(t);
            const cx0 = Math.max(x0, sx + ltx * TILE), cx1 = Math.min(x1, sx + (ltx + 1) * TILE), k = cx1 - cx0;
            any = true;
            const c0 = timed ? now() : 0;
            for (let Y = ry0; Y < ry1; Y++) {
                const so = ((Y - sy - lty * TILE) * TILE + (cx0 - sx - ltx * TILE)) * 4, o = (Y - Y0) * W + cx0 - X0;
                if (alphaOnly) {
                    for (let i = 0; i < k; i++) mem[ptr + o + i] = bytes[so + i * 4 + 3];
                } else {
                    mem.set(bytes.subarray(so, so + k * 4), ptr + o * 4);
                }
            }
            if (timed) pxLapAdd("copyIn", now() - c0, (ry1 - ry0) * k * (alphaOnly ? 1 : 4), shared);
        }
    }
    return any;
}

/**
 * Rows of a plain stack composited here, from the tiles where they lie (docs/PLAN_BCE.md §3b, B item 1): `stack` is
 * `{ base, layers: [{ x, y, w, h, tiles, alpha, op, mask }] }`, every store as `storeRows` takes it, a layer drawn
 * source-over or in its blend mode (`op`, the kernel's number; B item 7) at `alpha` (0..255) through its mask's alpha (a store on the layer's own grid; where the mask has no
 * tile the layer shows nothing). The rows `y` to `y + rows`, or with `above` the one row over them (null at the top),
 * `w` pixels from the image's column `x0`. `into`: a cleared buffer of that size to composite in (a part of a shared one).
 * `base` may be null: nothing below the layers (the wand's and the bucket's "sample the layer"), or, with `into`, what
 * the buffer already holds (B item 7 part 2: the layers above a filter layer go over the filtered band). A layer with
 * `sab` instead of tiles is a buffer of the same box as `into` (`msg.y0` its first row): a filter layer's result, which
 * goes over the band it was made from at the layer's opacity, in its blend mode, through its mask. A layer with
 * `match` (the ten floats of a colour match, B item 7 part 3) is matched here, on its copy of the rows, before it
 * is composited.
 */
export function rowsOfStack(msg, above = false, into = null) {
    let Y0 = msg.y | 0, n = msg.rows;
    if (above) { if (Y0 <= 0) return null; Y0--; n = 1; }
    const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;
    const dst = into || new Uint8Array(W * n * 4);
    if (st.base) storeRows(st.base, X0, W, Y0, n, dst);
    const srcs = [], alphas = [], masks = [], ops = [];
    for (const l of st.layers) {
        let src;
        if (l.sab) src = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, W * n * 4);
        else {
            src = new Uint8Array(W * n * 4);
            if (!storeRows(l, X0, W, Y0, n, src)) continue;
            if (l.match) matchPixels(src, l.match);
        }
        let mask = null;
        if (l.mask) { mask = new Uint8Array(W * n); storeRows({ x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, X0, W, Y0, n, mask, true); }
        if (l.clip) {
            // clipped (PLAN_0_1_31 §6 step 3): the base's coverage folded into the layer's mask
            const c = l.clip, cov = new Uint8Array(W * n);
            storeRows(c, X0, W, Y0, n, cov, true);
            let bm = null;
            if (c.mask) { bm = new Uint8Array(W * n); storeRows({ x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }, X0, W, Y0, n, bm, true); }
            mask = clipCoverage(cov, bm, c.alpha, mask);
        }
        if (l.dissolve != null) {
            const rowSrc = l.sab ? new Uint8Array(src) : src;
            for (let r = 0; r < n; r++) {
                const imgY = Y0 + r;
                for (let c = 0; c < W; c++) {
                    const imgX = X0 + c;
                    const idx = (r * W + c) * 4;
                    const srcA = rowSrc[idx + 3];
                    if (srcA === 0) continue;
                    const m = mask ? mask[r * W + c] : 255;
                    const cVal = mul255(mul255(srcA, l.alpha), m);
                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);
                    if (keep) {
                        rowSrc[idx + 3] = 255;
                    } else {
                        rowSrc[idx] = 0;
                        rowSrc[idx + 1] = 0;
                        rowSrc[idx + 2] = 0;
                        rowSrc[idx + 3] = 0;
                    }
                }
            }
            srcs.push(rowSrc); alphas.push(255); masks.push(null); ops.push(0);
        } else {
            srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
        }
    }
    if (srcs.length) compositeTile(dst, srcs, ops, alphas, masks);
    return dst;
}

/**
 * The same stack band gathered and composited directly in wasm memory `a` (`p.job`) (K10b, docs/PLAN_WASM_K10.md §5.2).
 * Returns the destination pointer `pd` in linear memory, or `0` when `above` is true at `y <= 0`.
 */
export function stackRowsToWasm(p, a, msg, above = false, into = null) {
    let Y0 = msg.y | 0, n = msg.rows;
    if (above) {
        if (Y0 <= 0) return 0;
        Y0--;
        n = 1;
    }
    const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;
    const px = W * n, byteLen = px * 4, timed = pxTimed();
    const pd = a.take(byteLen);
    if (st.base) {
        p.u8().fill(0, pd, pd + byteLen);
        storeRowsToWasm(p, st.base, X0, W, Y0, n, pd, false);
    } else if (into && !msg.clear) {
        const c0 = timed ? now() : 0;
        p.u8().set(into, pd);
        if (timed) pxLapAdd("copyIn", now() - c0, byteLen, true);
    } else {
        p.u8().fill(0, pd, pd + byteLen);
    }
    const maxL = st.layers.length;
    const srcPtrs = new Uint32Array(maxL);
    const maskPtrs = new Uint32Array(maxL);
    const opsArr = new Uint8Array(maxL);
    const alphasArr = new Uint8Array(maxL);
    let count = 0, scratchSrc = 0;
    for (const l of st.layers) {
        const psrc = scratchSrc || a.take(byteLen);
        if (l.sab) {
            scratchSrc = 0;
            const sabView = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, byteLen);
            const c0 = timed ? now() : 0;
            p.u8().set(sabView, psrc);
            if (timed) pxLapAdd("copyIn", now() - c0, byteLen, true);
        } else {
            p.u8().fill(0, psrc, psrc + byteLen);
            if (!storeRowsToWasm(p, l, X0, W, Y0, n, psrc, false)) {
                scratchSrc = psrc;
                continue;
            }
            scratchSrc = 0;
            if (l.match) {
                const pp = a.take(40, 4);
                const f = p.view(Float32Array, pp, 10);
                for (let i = 0; i < 10; i++) f[i] = l.match[i];
                p.exports.match_pixels(psrc, px, pp);
            }
        }
        let pm = 0;
        if (l.mask) {
            pm = a.take(px);
            p.u8().fill(0, pm, pm + px);
            storeRowsToWasm(p, { x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, X0, W, Y0, n, pm, true);
        }
        if (l.clip) {
            const c = l.clip;
            const pcov = a.take(px);
            p.u8().fill(0, pcov, pcov + px);
            storeRowsToWasm(p, c, X0, W, Y0, n, pcov, true);
            let pbm = 0;
            if (c.mask) {
                pbm = a.take(px);
                p.u8().fill(0, pbm, pbm + px);
                storeRowsToWasm(p, { x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }, X0, W, Y0, n, pbm, true);
            }
            if (p.exports.clip_coverage && route("clipCoverage") !== "js") {
                p.exports.clip_coverage(pcov, px, pbm, c.alpha, pm);
            } else {
                const covView = p.view(Uint8Array, pcov, px);
                const bmView = pbm ? p.view(Uint8Array, pbm, px) : null;
                const ownView = pm ? p.view(Uint8Array, pm, px) : null;
                clipCoverage(covView, bmView, c.alpha, ownView);
            }
            pm = pcov;
        }
        if (l.dissolve != null) {
            if (p.exports.dissolve_rows && route("dissolveRows") !== "js") {
                p.exports.dissolve_rows(psrc, W, n, X0, Y0, l.alpha, pm, l.dissolve >>> 0);
            } else {
                const srcView = p.view(Uint8Array, psrc, byteLen);
                const mView = pm ? p.view(Uint8Array, pm, px) : null;
                for (let r = 0; r < n; r++) {
                    const imgY = Y0 + r;
                    for (let c = 0; c < W; c++) {
                        const imgX = X0 + c;
                        const o = r * W + c, idx = o * 4;
                        const srcA = srcView[idx + 3];
                        if (srcA === 0) continue;
                        const m = mView ? mView[o] : 255;
                        const cVal = mul255(mul255(srcA, l.alpha), m);
                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);
                        if (keep) {
                            srcView[idx + 3] = 255;
                        } else {
                            srcView[idx] = 0;
                            srcView[idx + 1] = 0;
                            srcView[idx + 2] = 0;
                            srcView[idx + 3] = 0;
                        }
                    }
                }
            }
            srcPtrs[count] = psrc;
            alphasArr[count] = 255;
            maskPtrs[count] = 0;
            opsArr[count] = 0;
            count++;
        } else {
            srcPtrs[count] = psrc;
            alphasArr[count] = l.alpha;
            maskPtrs[count] = pm;
            opsArr[count] = l.op | 0;
            count++;
        }
    }
    if (count > 0) {
        const psrcs = a.take(count * 4, 4);
        const pmasks = a.take(count * 4, 4);
        const pops = a.take(count, 4);
        const palphas = a.take(count, 4);
        p.view(Uint32Array, psrcs, count).set(srcPtrs.subarray(0, count));
        p.view(Uint32Array, pmasks, count).set(maskPtrs.subarray(0, count));
        p.view(Uint8Array, pops, count).set(opsArr.subarray(0, count));
        p.view(Uint8Array, palphas, count).set(alphasArr.subarray(0, count));
        p.exports.composite_tile(pd, px, count, psrcs, pops, palphas, pmasks);
    }
    return pd;
}

/**
 * Rows of a stack composited into a shared buffer (B item 2: the picture a flood reads, put together by the pool):
 * `sab` holds `w` x `h` RGBA8 of the box at (`x0`, `y0`) of the image, zeroed (or `clear` asks this job to zero its
 * rows first); this job fills the rows `y` to `y + rows`.
 */
export async function stackInto(msg) {
    const t0 = now();
    const byteLen = msg.w * msg.rows * 4;
    const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4;
    const into = new Uint8Array(msg.sab, at, byteLen);
    let p = rustPx();
    if (p && msg.stack.layers.length > 0 && route("stackIntoWasm") !== "js") {
        const a = p.job;
        let ok = false;
        try {
            const pd = stackRowsToWasm(p, a, msg, false, into);
            p.get(Uint8Array, pd, byteLen, into);
            ok = true;
        } catch (err) {
            if (!recovered(p, err, "stack_into")) throw err;
        } finally {
            p._reset(a);
        }
        if (ok) {
            return {
                timing: {
                    op: "stack_into", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                },
            };
        }
        await pxSettled();
    }
    if (msg.clear) into.fill(0);   // a buffer that is used band after band (B item 7 part 2): cleared here, not on the main thread
    rowsOfStack(msg, false, into);
    return {
        timing: {
            op: "stack_into", kernels: kernelsInUse(), composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
        },
    };
}

/**
 * The samples of one store at the image pixels `xs` x `ys` (a grid), into `out`: RGBA8, or with `alphaOnly` one byte a
 * pixel. A sample outside the store, on a tile it does not have, or (with `clip`, the image's size) outside the image,
 * stays as it is. False when nothing was read.
 */
function gatherStore(store, xs, ys, out, alphaOnly = false, clip = null) {
    const sx = store.x | 0, sy = store.y | 0, nx = xs.length, ny = ys.length;
    let any = false;
    for (let j = 0; j < ny; j++) {
        const Y = ys[j] - sy;
        if (Y < 0 || Y >= store.h) continue;
        if (clip && (ys[j] < 0 || ys[j] >= clip.h)) continue;
        const names = store.tiles[Y >> 8];
        if (!names) continue;
        const ro = (Y & (TILE - 1)) * TILE;
        let last = null, bytes = null;
        for (let i = 0; i < nx; i++) {
            const X = xs[i] - sx;
            if (X < 0 || X >= store.w) continue;
            if (clip && (xs[i] < 0 || xs[i] >= clip.w)) continue;
            const t = names[X >> 8];
            if (!t) continue;
            if (t !== last) { bytes = tileBytes(t).bytes; last = t; }
            const so = (ro + (X & (TILE - 1))) * 4, o = j * nx + i;
            any = true;
            if (alphaOnly) out[o] = bytes[so + 3];
            else { out[o * 4] = bytes[so]; out[o * 4 + 1] = bytes[so + 1]; out[o * 4 + 2] = bytes[so + 2]; out[o * 4 + 3] = bytes[so + 3]; }
        }
    }
    return any;
}

/**
 * Point samples of a stack for a layer's colour-match statistics (B item 7 part 3): `xs` and `ys` (Int32 buffers)
 * name the image pixels of the grid; `stack` is `rowsOfStack`'s, the layers below the matched one with their own
 * `match` where they have one, sampled inside the image only (`image`: its size; the flatten shows nothing outside
 * it); `layer` the matched layer's store with its `mask`, or null, sampled wherever it is (the flatten's statistics
 * take the whole layer picture). Answers `{ bel, lay }`, nx × ny RGBA8 each, transferred: the composite below at the
 * samples, and the layer's own samples with its mask folded into the alpha. A sample outside a store is transparent.
 * The composite is pointwise, so the composite of the samples is the samples of the composite.
 */
export async function stackPoints(msg) {
    const t0 = now();
    const xs = new Int32Array(msg.xs), ys = new Int32Array(msg.ys), nx = xs.length, ny = ys.length, n = nx * ny;
    const clip = msg.image ? { w: msg.image[0], h: msg.image[1] } : null;
    const st = msg.stack, bel = new Uint8Array(n * 4);
    if (st.base) gatherStore(st.base, xs, ys, bel, false, clip);
    const srcs = [], alphas = [], masks = [], ops = [];
    for (const l of st.layers) {
        if (l.sab) continue;   // a filtered band cannot be sampled (a matched layer above a filter takes the region pass)
        const src = new Uint8Array(n * 4);
        if (!gatherStore(l, xs, ys, src, false, clip)) continue;
        if (l.match) matchPixels(src, l.match);
        let mask = null;
        if (l.mask) { mask = new Uint8Array(n); gatherStore({ x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, xs, ys, mask, true, clip); }
        if (l.clip) {
            const c = l.clip, cov = new Uint8Array(n);
            gatherStore(c, xs, ys, cov, true, clip);
            let bm = null;
            if (c.mask) { bm = new Uint8Array(n); gatherStore({ x: c.x, y: c.y, w: c.w, h: c.h, tiles: c.mask }, xs, ys, bm, true, clip); }
            mask = clipCoverage(cov, bm, c.alpha, mask);
        }
        if (l.dissolve != null) {
            for (let j = 0; j < ny; j++) {
                const imgY = ys[j];
                for (let i = 0; i < nx; i++) {
                    const imgX = xs[i];
                    const o = j * nx + i;
                    const idx = o * 4;
                    const srcA = src[idx + 3];
                    if (srcA === 0) continue;
                    const m = mask ? mask[o] : 255;
                    const cVal = mul255(mul255(srcA, l.alpha), m);
                    const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);
                    if (keep) {
                        src[idx + 3] = 255;
                    } else {
                        src[idx] = 0;
                        src[idx + 1] = 0;
                        src[idx + 2] = 0;
                        src[idx + 3] = 0;
                    }
                }
            }
            srcs.push(src); alphas.push(255); masks.push(null); ops.push(0);
        } else {
            srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
        }
    }
    if (srcs.length) compositeTile(bel, srcs, ops, alphas, masks);
    const lay = new Uint8Array(n * 4);
    if (msg.layer && gatherStore(msg.layer, xs, ys, lay) && msg.layer.mask) {
        const m = new Uint8Array(n);
        gatherStore({ x: msg.layer.x, y: msg.layer.y, w: msg.layer.w, h: msg.layer.h, tiles: msg.layer.mask }, xs, ys, m, true);
        for (let i = 0; i < n; i++) { const t = lay[i * 4 + 3] * m[i] + 128; lay[i * 4 + 3] = (t + (t >> 8)) >> 8; }
    }
    return { bel: bel.buffer, lay: lay.buffer, transfer: [bel.buffer, lay.buffer], timing: { op: "stack_points", kernels: kernelsInUse(), pixels: n, kernel: now() - t0 } };
}

/** The rows of a part job, whichever way they come: bytes, a stack to composite, or one store's tiles. */
function partRowsOf(msg) {
    if (msg.rgba) return new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4);
    return msg.stack ? rowsOfStack(msg) : rowsOfTiles(msg);
}

/**
 * The rows of a part job in wasm memory `a` (`p.job`), plus the optional `above` row for `png_part` (K10b,
 * docs/PLAN_WASM_K10.md §5.2).
 */
export function partPtrOf(p, a, msg, needPrev = false) {
    const byteLen = msg.w * msg.rows * 4;
    let pr = 0, pp = 0;
    if (msg.rgba) {
        pr = p._in(a, new Uint8Array(msg.rgba, 0, byteLen), byteLen);
        const tc = now();
        if (needPrev && msg.prev) {
            const prevBytes = new Uint8Array(msg.prev, 0, msg.w * 4);
            pp = p._in(a, prevBytes, prevBytes.byteLength);
        }
        return { pr, pp, tc, tp: now() };
    }
    if (msg.stack) {
        pr = stackRowsToWasm(p, a, msg, false, null);
        const tc = now();
        if (needPrev && (msg.y | 0) > 0) {
            pp = stackRowsToWasm(p, a, msg, true, null);
        }
        return { pr, pp, tc, tp: now() };
    }
    pr = a.take(byteLen);
    tilesRowsToWasm(p, msg, false, pr);
    const tc = now();
    if (needPrev && ((msg.r0 | 0) > 0 || msg.prevTiles)) {
        const cand = a.take(msg.w * 4);
        if (tilesRowsToWasm(p, msg, true, cand)) pp = cand;
    }
    return { pr, pp, tc, tp: now() };
}

/**
 * One part of a PNG's pixels (inpaint_png.js, docs/PLAN_BCE.md §E2): rows as bytes (`rgba`, optional `prev`) or as
 * tiles/stack (`tiles`, `r0`, or `stack`; `prevTiles` is ignored so parts start with None or Sub, P5), as an IDAT chunk.
 */
export async function pngPart(msg) {
    let p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const level = msg.level === undefined ? PNG_LEVEL : msg.level;
    const laps = {};   // copyIn, filter, adler, deflate, chunk, copyOut (px.js pngPart / pngPartFromPtr)
    const routeName = msg.stack ? "composeStack" : "composeTiles";
    if (!msg.rgba && route(routeName) !== "js") {
        const a = p.job;
        let r = null, tc = 0, tp = 0;
        try {
            const ptrs = partPtrOf(p, a, msg, false);
            tc = ptrs.tc;
            tp = ptrs.tp;
            r = p.pngPartFromPtr(a, ptrs.pr, msg.w, msg.rows, ptrs.pp, level, !!msg.last, laps);
        } catch (err) {
            if (!recovered(p, err, "png_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        if (r) {
            return {
                chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
                transfer: [r.chunk.buffer],
                timing: {
                    op: "png_part", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
                },
            };
        }
        p = rustPx();
        if (!p) {
            await pxSettled();
            p = rustPx();
        }
        if (!p) throw new Error(NO_PARTS);
    }
    const rgba = partRowsOf(msg);
    const tc = now();
    const prev = msg.rgba && msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null;
    const tp = now();
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, level, !!msg.last, laps);
    releaseIfLarge();
    return {
        chunk: r.chunk.buffer, adler: r.adler, raw: r.raw, crc: r.crc,
        transfer: [r.chunk.buffer],
        timing: {
            op: "png_part", kernels: "rust", composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? tc - t0 : 0, rows: tc - t0, prev: tp - tc, ...laps,
        },
    };
}

/**
 * One part of a PSD's channel data (docs/PLAN_BCE.md §E4): rows as bytes or as tiles (as `png_part` takes them),
 * PackBits per channel. `channels`: [{ lens, data }] for R, G, B, A, transferred.
 */
export async function psdPart(msg) {
    const t0 = now();
    let p = rustPx();
    if (p && !msg.rgba && route("psdPartWasm") !== "js") {
        const a = p.job;
        let packed = null, t1 = 0, t2 = 0;
        try {
            const ptrs = partPtrOf(p, a, msg, false);
            t1 = ptrs.tc;
            packed = p.psdPackRowsFromPtr(a, ptrs.pr, msg.w, msg.rows);
            t2 = now();
        } catch (err) {
            if (!recovered(p, err, "psd_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        if (packed) {
            const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
            return {
                channels,
                transfer: channels.flatMap((c) => [c.lens, c.data]),
                timing: {
                    op: "psd_part", kernels: "rust", composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, pack: t2 - t1,
                },
            };
        }
        await pxSettled();
    }
    const rgba = partRowsOf(msg);
    const t1 = now();
    const packed = psdPackRows(rgba, msg.w, msg.rows);
    const t2 = now();
    releaseIfLarge();
    const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
    return {
        channels,
        transfer: channels.flatMap((c) => [c.lens, c.data]),
        timing: {
            op: "psd_part", kernels: kernelsInUse(), composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, pack: t2 - t1,
        },
    };
}

/**
 * One strip of a TIFF (inpaint_tiff.js `tiffPart`, docs/PLAN_0_1_29.md 3d): rows as bytes, a stack or tiles (as
 * `png_part` takes them), differenced and deflated into a zlib stream by the Rust kernels (the JS twin without them).
 */
export async function tiffPartJob(msg) {
    const t0 = now();
    const level = msg.level === undefined ? PNG_LEVEL : msg.level;
    const laps = {};   // predict, deflate (px.js tiffStrip / tiffStripFromPtr, inpaint_tiff.js tiffPart)
    let p = rustPx("tiffStripWasm") && rustPx("tiffPredict");
    const composeRoute = msg.stack ? "composeStack" : "composeTiles";
    if (p && !msg.rgba && route(composeRoute) !== "js") {
        const a = p.job;
        let r = null, tc = 0;
        try {
            const ptrs = partPtrOf(p, a, msg, false);
            tc = ptrs.tc;
            r = p.tiffStripFromPtr(a, ptrs.pr, msg.w, msg.rows, level, msg.predictor, laps);
        } catch (err) {
            delete laps.predict;
            delete laps.deflate;
            if (!recovered(p, err, "tiff_part")) throw err;
        } finally {
            p._reset(a);
            releaseIfLarge();
        }
        if (r) {
            return {
                chunk: r.chunk, raw: r.raw, transfer: [r.chunk],
                timing: {
                    op: "tiff_part", kernels: kernelsInUse(), composeWasm: 1,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? tc - t0 : 0, rows: tc - t0, ...laps,
                },
            };
        }
        p = rustPx("tiffStripWasm") && rustPx("tiffPredict");
        if (!p) {
            await pxSettled();
            p = rustPx("tiffStripWasm") && rustPx("tiffPredict");
        }
    }
    const rgba = partRowsOf(msg);
    const t1 = now();
    if (p) {
        let r = null;
        try {
            r = p.tiffStrip({ rgba, w: msg.w, rows: msg.rows, predictor: msg.predictor }, level, laps);
        } catch (err) {
            delete laps.predict;
            delete laps.deflate;
            if (!recovered(p, err, "tiff_part")) throw err;
        } finally {
            releaseIfLarge();
        }
        if (r) {
            return {
                chunk: r.chunk, raw: r.raw, transfer: [r.chunk],
                timing: {
                    op: "tiff_part", kernels: kernelsInUse(), composeWasm: 0,
                    pixels: msg.w * msg.rows, kernel: now() - t0,
                    compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, ...laps,
                },
            };
        }
        await pxSettled();
    }
    const pz = rustPx();
    const r = await tiffPart({ rgba, w: msg.w, rows: msg.rows, predictor: msg.predictor }, (bytes) => (pz ? pz.zlib(bytes, level) : deflate(bytes)), laps);
    releaseIfLarge();
    return {
        chunk: r.chunk, raw: r.raw, transfer: [r.chunk],
        timing: {
            op: "tiff_part", kernels: kernelsInUse(), composeWasm: 0,
            pixels: msg.w * msg.rows, kernel: now() - t0,
            compose: msg.stack ? t1 - t0 : 0, rows: t1 - t0, ...laps,
        },
    };
}

/**
 * Decode one planned band of a TIFF (inpaint_tiff.js `readTiffBand`, docs/PLAN_WASM_BUILD.md §4.6, K18): carries only
 * `msg.spec` (per-file constants) and `msg.band` (that band's strip or tile slices), returning straight-alpha RGBA8
 * transferred back to the window.
 */
export async function tiffBandJob(msg) {
    const t0 = now();
    const spec = msg.spec, band = msg.band;
    if (!spec || !spec.info || !band) throw new Error("tiff_band: invalid spec or band");
    const spent = {};
    const rgba = await readTiffBand(msg.blob, spec, band, { spent, kernels: tiffKernels() });
    const rows = band.rows | 0, y0 = band.y0 | 0;
    const buf = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba.buffer : rgba.slice().buffer;
    return {
        rgba: buf,
        y0,
        rows,
        transfer: [buf],
        timing: {
            op: "tiff_band",
            kernels: kernelsInUse(),
            pixels: spec.info.width * rows,
            rows,
            kernel: now() - t0,
            ...spent,
        },
    };
}

/**
 * A TIFF read as a stream (inpaint_tiff.js `readTiff`), like `png_read`: `progress` messages `{ header }`, then
 * `{ rgba, y0, rows }` transferred; the reply carries what the reader found (`info`, with its notes), its timing the
 * reader's split (`readTiff`'s `spent`).
 */
async function tiffRead(msg) {
    const t0 = now();
    const spent = {};
    const info = await readTiff(msg.blob, {
        rowsPerBand: msg.rowsPerBand || TILE,
        onHeader: (h) => { self.postMessage({ id: msg.id, progress: true, header: { width: h.width, height: h.height } }); },
        onRows: (rgba, y0, rows) => { self.postMessage({ id: msg.id, progress: true, rgba: rgba.buffer, y0, rows }, [rgba.buffer]); },
        spent,
        kernels: tiffKernels(),
    });
    releaseIfLarge();
    return { info, timing: { op: "tiff_read", kernels: kernelsInUse(), pixels: info.width * info.height, kernel: now() - t0, ...spent } };
}

/**
 * A PSD read in this worker (inpaint_layered.js `readPsdStream`, docs/PLAN_WASM_BUILD.md §7 D0): the file's bytes read
 * here from the blob, so the window makes no array of them (the window has checked the size from the header's 26 bytes
 * before it queued the job); `progress` messages `{ index, mask, rgba, w, h, y0, rows }` (the band's buffer
 * transferred), a layer at a time, its pixels before its mask; the reply `{ doc }` (readPsdStream's answer), or `{ failed }` with the reader's message for a file it refuses,
 * which the window shows as its own reader would, without reading the file again. Plain JS: K20b puts the Rust reader
 * into this job. Its timing: read (the blob), channels, inflate, interleave, mask, deliver (the posts), wait (paced, below), bands.
 *
 * `msg.window` > 0 (the window's route `psdWindow`, inpaint_canvas.js `readPsdOnPool`; K20b review K20b-T1): at most that
 * many bands are posted and not yet acknowledged; the window acknowledges each band after its `writeRect` with
 * `{ op: "ack", id, n }` (`psdAck`, `n` the bands it has written), and the reader waits for that before it makes the next
 * band, so a reader faster than the window's writes cannot queue a layer's bands ahead of the window's other tasks.
 * 0 or absent: every band posted at once, as before.
 */
export async function psdRead(msg) {
    const t0 = now();
    const bytes = new Uint8Array(await msg.blob.arrayBuffer());
    const read = now() - t0;
    const spent = {};
    let inflate = 0, inflates = 0, pixels = 0, sent = 0;
    const win = Math.max(0, msg.window | 0), pace = win > 0 ? { done: 0, wake: null } : null;
    if (pace) PSD_ACKS.set(msg.id, pace);
    const caughtUp = async () => { while (sent - pace.done >= win) await new Promise((res) => { pace.wake = res; }); };
    const timing = () => ({ op: "psd_read", kernels: rustPx("psdRead") ? "rust" : "js", pixels, kernel: now() - t0, read, inflate, inflates, window: win, ...spent });
    try {
        const doc = await readPsdStream(bytes, {
            // the window's inflater (inpaint_layered.js inflateAtMost): the same bytes, stopped at the bytes kept
            inflate: async (b, cap) => { const t = now(); try { return await inflateAtMost(b, "deflate", cap); } finally { inflate += now() - t; inflates++; } },
            rowsPerBand: msg.rowsPerBand || TILE,
            onHeader: (h) => { pixels = h.width * h.height; },   // the window checked the size from the header before the job
            onRows: (index, kind, rgba, w, h, y0, rows) => {
                self.postMessage({ id: msg.id, progress: true, index, mask: kind === "mask", rgba: rgba.buffer, w, h, y0, rows }, [rgba.buffer]);
                sent++;
                return pace && sent - pace.done >= win ? caughtUp() : undefined;
            },
            spent,
            kernels: psdKernels(),
        });
        return { doc, timing: timing() };
    } catch (err) {
        return { failed: String((err && err.message) || err), timing: timing() };
    } finally {
        if (pace) PSD_ACKS.delete(msg.id);
        releaseIfLarge();
        // the file's array goes now, not at this idle worker's next collection (the answer holds no view of it)
        try { if (typeof bytes.buffer.transfer === "function") bytes.buffer.transfer(0); } catch (_) { /* detached already */ }
    }
}

/** The paced `psd_read` jobs of this thread: job id -> { done (bands the window acknowledged), wake (the waiting reader's resolve) }. */
const PSD_ACKS = new Map();

/** The window's acknowledgement of a paced `psd_read` (`{ op: "ack", id, n }`, not a job): wakes the reader when it waits. */
export function psdAck(msg) {
    const pace = PSD_ACKS.get(msg && msg.id);
    if (!pace) return;
    pace.done = Math.max(pace.done, msg.n | 0);
    const wake = pace.wake;
    pace.wake = null;
    if (wake) wake();
}

/** CRC-32 and size of a blob (a zip entry of an ORA file). */
async function crcJob(msg) {
    const t0 = now();
    const bytes = new Uint8Array(await msg.blob.arrayBuffer());
    const t1 = now();
    const crc = crc32(bytes);
    const t2 = now();
    return { crc, size: bytes.length, timing: { op: "crc", read: t1 - t0, crc: t2 - t1, kernel: t2 - t0, bytes: bytes.length } };
}

/** The inflated length of `pieces` (Uint8Arrays, in order) through one `DecompressionStream(format)`; every piece of the output goes to `onPiece` and is dropped. */
async function inflateCount(pieces, format, onPiece) {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter(), reader = ds.readable.getReader();
    let fedErr = null;
    const feed = (async () => {   // fed while the output is read, or the inflater's back-pressure would stall it
        try {
            for (const p of pieces) await writer.write(p);
            await writer.close();
        } catch (err) { fedErr = err; }
    })();
    let out = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            out += value.length;
            if (onPiece) onPiece(value);
        }
    } catch (err) {
        reader.cancel().catch(() => {});   // the feeding side stops with it
        throw err;
    }
    await feed;
    if (fedErr) throw fedErr;
    return out;
}

/**
 * A benchmark of the browser's inflater (docs/PLAN_WASM_BUILD.md K0a), no caller in the editor. `ranges`
 * ([offset, length, tail?]) of `blob` are read first (`read`), then inflated by `DecompressionStream(format)`
 * (`inflate`, "deflate" or "deflate-raw"), so the file and the inflater are timed apart. `whole`: one stream fed with
 * every range in order, as `png_read` feeds its IDAT payloads (tails ignored); otherwise one stream per range, one after
 * the other, its `tail` bytes (e.g. [3, 0], an empty final block) appended. The output is counted, never kept; with
 * `stride` > 0 (whole only) the first byte of every `stride`-byte row of it is counted too (inside `inflate`): a PNG's
 * filter types, `filters` = [none, sub, up, average, paeth, other]. A broken stream throws.
 */
async function inflateBench(msg) {
    const t0 = now();
    const format = msg.format;
    if (format !== "deflate" && format !== "deflate-raw") throw new Error("inflate_bench: format " + format);
    const ranges = msg.ranges || [];
    if (!ranges.length) throw new Error("inflate_bench: no ranges");
    const whole = !!msg.whole, stride = whole && msg.stride > 0 ? Math.floor(msg.stride) : 0;
    const inputs = [];
    let bytes = 0;
    for (const [off, len, tail] of ranges) {
        const b = new Uint8Array(await msg.blob.slice(off, off + len).arrayBuffer());
        bytes += b.length;
        inputs.push(!whole && tail && tail.length ? [b, Uint8Array.from(tail)] : [b]);
    }
    const t1 = now();
    const filters = stride ? [0, 0, 0, 0, 0, 0] : null;
    let at = 0;   // bytes of the current row seen so far (a row can straddle pieces)
    const count = stride ? (piece) => {
        for (let i = (stride - at) % stride; i < piece.length; i += stride) { const f = piece[i]; filters[f < 5 ? f : 5]++; }
        at = (at + piece.length) % stride;
    } : null;
    let out = 0;
    if (whole) out = await inflateCount(inputs.flat(), format, count);
    else for (const pieces of inputs) out += await inflateCount(pieces, format, null);
    const t2 = now();
    const reply = { out, timing: { op: "inflate_bench", format, streams: whole ? 1 : inputs.length, bytes, out, read: t1 - t0, inflate: t2 - t1, kernel: t2 - t0 } };
    if (filters) reply.filters = filters;
    return reply;
}

/**
 * A probe of a kernel's cold and warm calls (docs/PLAN_WASM_K1.md S4, M5 and M7a), no caller in the editor: `calls`
 * calls of `kernel` ("flood_shape" over a flat `size` x `size` picture, the region all of it, or "mip_chain" over a
 * random tile), each timed alone (`ms`). `source` names the instance: "thread" this thread's own (with `renew` a fresh
 * one of the same compiled module first), "posted" a new instance of the `module` the window posted, "bytes" one
 * compiled here from `bytes` (the cold reference; `compile` and `instantiate` timed). The inputs are made before the
 * clock; `pregrow` first grows the instance by what a call takes, so call 0 differs from call 1 only by the code's tier.
 */
async function pxProbe(msg) {
    const kernel = msg.kernel, source = msg.source || "thread";
    if (kernel !== "flood_shape" && kernel !== "mip_chain") throw new Error("px_probe: kernel " + kernel);
    const size = kernel === "mip_chain" ? TILE : Math.max(1, (msg.size | 0) || 2048);
    const calls = Math.max(1, msg.calls | 0);
    let p = null, compile = null, instantiate = null;
    if (source === "thread") {
        if (msg.renew) { dropPx("idle"); await pxSettled(); }
        p = rustPx();
    } else if (source === "posted" || source === "bytes") {
        let module = msg.module, t = now();
        if (source === "bytes") { module = await WebAssembly.compile(msg.bytes); compile = now() - t; t = now(); }
        if (!(module instanceof WebAssembly.Module)) throw new Error("px_probe: no module posted");
        const instance = await WebAssembly.instantiate(module, {});
        instantiate = now() - t;
        p = new Px(instance, module);
    } else throw new Error("px_probe: source " + source);
    if (!p) throw new Error("px_probe: no Rust kernels in this thread");
    let rgba = null, tile = null, chain = null;
    if (kernel === "flood_shape") rgba = new Uint8Array(size * size * 4).fill(128);
    else {
        tile = new Uint8Array(TILE_BYTES);
        for (let i = 0; i < TILE_BYTES; i++) tile[i] = (Math.random() * 256) | 0;
        chain = new Uint8Array(mipChainBytes(TILE, LEVELS));
    }
    if (msg.pregrow) {
        // what the job arena takes on the first call (the picture, its 1 MB chunk, the span stack), touched page by page
        const need = (kernel === "flood_shape" ? size * size * 4 + Math.max(4096, (size * size) >> 4) * 8 : 0) + (2 << 20);
        const ptr = p.alloc(need);
        p.u8().fill(1, ptr, ptr + need);
        p.free(ptr, need);
    }
    const ms = [];
    for (let i = 0; i < calls; i++) {
        const t = now();
        if (rgba) p.floodShape(rgba, size, size, size >> 1, size >> 1, 32, true, null, 0xff0000, (view, count) => count);
        else p.mipChain(tile, TILE, LEVELS, chain);
        ms.push(now() - t);
    }
    return { ms, compile, instantiate, bytes: p.byteLength, timing: { op: "px_probe", kernel, size, source } };
}

/**
 * A PNG file read as a stream (inpaint_png.js `readPng`, docs/PLAN_BCE.md §E2): every band of rows goes back as a
 * `progress` message (`{ rgba, y0, rows }`, transferred) as soon as it is decoded, the reply carries the header. For a
 * picture no canvas can hold (above 268 MP), which the browser's own decoder cannot hand over.
 */
async function pngRead(msg) {
    const t0 = now();
    let header = null;
    const info = await readPng(msg.blob, {
        rowsPerBand: msg.rowsPerBand || TILE,
        onHeader: (h) => { header = h; self.postMessage({ id: msg.id, progress: true, header: h }); },
        onRows: (rgba, y0, rows) => { self.postMessage({ id: msg.id, progress: true, rgba: rgba.buffer, y0, rows }, [rgba.buffer]); },
    });
    return { width: info.width, height: info.height, texts: info.texts, header, timing: { op: "png_read", kernels: kernelsInUse(), pixels: info.width * info.height, kernel: now() - t0, ...info.spent } };   // readPng's split: parse, read, write, wait, copy, unfilter, deliver
}

const PART_INFLATE_SLICE = 65536;
const PART_TAIL_0300 = new Uint8Array([0x03, 0x00]);

/**
 * Inflate one PNG part's `blob` slice through `DecompressionStream("deflate-raw")`, appending `03 00` to non-last
 * parts only (K8, docs/PLAN_WASM_BUILD.md §4.2), capped at `cap` output bytes so a crafted part cannot inflate without
 * limit.
 */
async function inflatePartAtMost(blob, last, cap) {
    const t0 = now();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const inBytes = bytes.byteLength;
    const t1 = now();
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter(), reader = ds.readable.getReader();
    let fedErr = null, stop = false;
    const feed = (async () => {
        try {
            for (let i = 0; i < bytes.length && !stop; i += PART_INFLATE_SLICE) {
                await writer.write(bytes.subarray(i, i + PART_INFLATE_SLICE));
            }
            if (!last && !stop) await writer.write(PART_TAIL_0300);
            if (!stop) await writer.close();
        } catch (err) { if (!stop) fedErr = err; }
    })();
    const parts = [];
    let n = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            n += value.byteLength;
            if (n > cap) {
                stop = true;
                reader.cancel().catch(() => {});
                const err = new Error(`the PNG part unpacks to more than ${cap} bytes`);
                err.tooLarge = true;
                throw err;
            }
            parts.push(value);
        }
    } catch (err) {
        if (!stop) { stop = true; reader.cancel().catch(() => {}); }
        throw err;
    } finally {
        try { if (typeof bytes.buffer.transfer === "function") bytes.buffer.transfer(0); } catch (_) { /* ignore */ }
    }
    await feed;
    if (fedErr) throw fedErr;
    let lines;
    if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].byteLength === parts[0].buffer.byteLength) {
        lines = parts[0];
    } else {
        lines = new Uint8Array(n);
        for (let i = 0, o = 0; i < parts.length; o += parts[i].byteLength, i++) lines.set(parts[i], o);
    }
    const t2 = now();
    return { lines, inBytes, readMs: t1 - t0, inflateMs: t2 - t1 };
}

/**
 * Inflate and decode one part of a Scumble parted PNG (K8, docs/PLAN_WASM_BUILD.md §4.2). Bounded by both IHDR (`h`)
 * and `pngPartLinesCap(w)`. When row 0 needs the previous part's last row and `prev` is not yet known, returns
 * `needsPrev: true` with `lines` transferred back so `png_part_finish` can finish it at `INTERACTIVE` priority once
 * `prev` arrives.
 */
async function pngPartRead(msg) {
    const t0 = now();
    const w = msg.w | 0, h = msg.h | 0, last = !!msg.last;
    if (!(w > 0)) throw new Error("png_part_read: invalid width");
    const stride = 1 + w * 4;
    const pCap = pngPartLinesCap(w);
    const hCap = msg.h !== undefined ? (h > 0 ? h * stride : 0) : pCap;
    const cap = Math.min(pCap, hCap);
    if (!(cap >= stride)) throw new Error("png_part_read: zero line cap");
    const { lines, inBytes, readMs, inflateMs } = await inflatePartAtMost(msg.blob, last, cap);
    const prev = msg.prev
        ? (msg.prev instanceof Uint8Array ? msg.prev : new Uint8Array(msg.prev, 0, w * 4))
        : msg.first ? new Uint8Array(w * 4) : null;
    const rt = residentRt(msg.rt ? (msg.rt instanceof Uint8Array ? msg.rt : new Uint8Array(msg.rt)) : null);
    const laps = {};
    const r = pngPartDecode(lines, w, prev, rt, null, laps);
    if (!r || r.code < 0) {
        try { if (typeof lines.buffer.transfer === "function") lines.buffer.transfer(0); } catch (_) { /* ignore */ }
        throw new Error("png_part_read: corrupt part (" + (r ? r.code : "null") + ")");
    }
    const timing = { op: "png_part_read", kernels: kernelsInUse(), pixels: w * r.rows, bytes: inBytes, rows: r.rows, kernel: now() - t0, read: readMs, inflate: inflateMs, ...laps };
    if (r.needsPrev) {
        return { rows: r.rows, adler: r.adler, firstFilter: r.firstFilter, opaque: false, needsPrev: true, lines: lines.buffer, transfer: [lines.buffer], timing };
    }
    try { if (typeof lines.buffer.transfer === "function") lines.buffer.transfer(0); } catch (_) { /* ignore */ }
    return { rows: r.rows, adler: r.adler, firstFilter: r.firstFilter, opaque: r.opaque, needsPrev: false, rgba: r.out.buffer, prev: r.prev.buffer, transfer: [r.out.buffer, r.prev.buffer], timing };
}

/**
 * Finish a PNG part whose `png_part_read` answered `needsPrev: true`, once the previous part's last unfiltered row
 * (`prev`) is ready (K8, docs/PLAN_WASM_BUILD.md §4.2).
 */
function pngPartFinishJob(msg) {
    const t0 = now();
    const w = msg.w | 0, rows = msg.rows | 0;
    const lines = msg.lines instanceof Uint8Array ? msg.lines : new Uint8Array(msg.lines);
    const prev = msg.prev instanceof Uint8Array ? msg.prev : new Uint8Array(msg.prev, 0, w * 4);
    const rt = residentRt(msg.rt ? (msg.rt instanceof Uint8Array ? msg.rt : new Uint8Array(msg.rt)) : null);
    const laps = {};
    const r = pngPartFinish(lines, rows, w, prev, rt, null, laps);
    try { if (typeof lines.buffer.transfer === "function") lines.buffer.transfer(0); } catch (_) { /* ignore */ }
    if (!r || r.code < 0) throw new Error("png_part_finish: corrupt part (" + (r ? r.code : "null") + ")");
    const timing = { op: "png_part_finish", kernels: kernelsInUse(), pixels: w * r.rows, rows: r.rows, kernel: now() - t0, ...laps };
    return { rows: r.rows, firstFilter: r.firstFilter, opaque: r.opaque, rgba: r.out.buffer, prev: r.prev.buffer, transfer: [r.out.buffer, r.prev.buffer], timing };
}

/**
 * An image file decoded by the browser in this worker and read back band by band, like `png_read` (`progress` messages
 * `{ header }`, then `{ rgba, y0, rows }` transferred). The window's way was an <img> drawn in strips into a CPU scratch
 * and read there: 1 to 4 s of blocked window for a 15000 x 10000 JPEG, WebP or PNG with a colour profile. The same
 * decoder settings an <img> gets (the colour profile applied, EXIF orientation, premultiplied) and the same kind of
 * canvas (a CPU one: `willReadFrequently`), drawn unscaled at whole-pixel offsets, so the bytes are the <img> way's.
 */
async function imageRead(msg) {
    const t0 = now();
    const bmp = await createImageBitmap(msg.blob, { imageOrientation: "from-image", premultiplyAlpha: "default", colorSpaceConversion: "default" });
    const W = bmp.width, H = bmp.height, decode = now() - t0;
    let draw = 0, read = 0;
    try {
        self.postMessage({ id: msg.id, progress: true, header: { width: W, height: H } });
        const rows = Math.max(1, msg.rowsPerBand || TILE);
        const c = new OffscreenCanvas(W, Math.min(rows, H));
        const ctx = c.getContext("2d", { willReadFrequently: true });
        for (let y0 = 0; y0 < H; y0 += rows) {
            const n = Math.min(rows, H - y0);
            const a = now();
            ctx.clearRect(0, 0, W, c.height);
            ctx.drawImage(bmp, 0, -y0, W, H);
            const b = now();
            const img = ctx.getImageData(0, 0, W, n);
            read += now() - b; draw += b - a;
            self.postMessage({ id: msg.id, progress: true, rgba: img.data.buffer, y0, rows: n }, [img.data.buffer]);
        }
        c.width = 1; c.height = 1;
    } finally {
        bmp.close();
    }
    return { width: W, height: H, timing: { op: "image_read", pixels: W * H, kernel: now() - t0, decode, draw, read } };
}

/** The short SHA-1 of a blob (the name of an uploaded file). */
async function hashJob(msg) {
    return { hash: await hashOf(msg.blob) };
}

const exports_ = new Map();   // job id -> { writer, format }

/** An ImageBitmap as a 2D canvas; the bitmap is released right away. */
function canvasOf(bitmap) {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return c;
}

/** Same short SHA-1 the editor uses to name uploaded files. */
async function hashOf(blob) {
    const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function png(bitmap, wantHash) {
    const blob = await canvasOf(bitmap).convertToBlob({ type: "image/png" });
    return { blob, hash: wantHash ? await hashOf(blob) : null };
}

/** grow / shrink / feather / invert, on the selection's pixels. */
async function selection(msg) {
    const t0 = now();
    const c = canvasOf(msg.bitmap);
    const W = c.width, H = c.height;
    let out = c;
    if (msg.kind === "feather") {
        out = new OffscreenCanvas(W, H);
        const octx = out.getContext("2d");
        octx.filter = `blur(${msg.radius}px)`;
        octx.drawImage(c, 0, 0);
        octx.filter = "none";
    } else if (msg.kind !== "invert" && msg.kind !== "grow") {
        throw new Error("unknown selection job " + msg.kind);
    }
    const ctx = out.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    const ms = { op: "selection", kind: msg.kind, kernels: kernelsInUse(), pixels: W * H, read: now() - t0 };
    // the editor would otherwise scan the whole selection for the bounds afterwards, on its own thread
    let bounds;
    if (msg.kind === "grow") {
        bounds = growMaskBounds(img.data, W, H, msg.n, { ms });
        const t = now();
        ctx.putImageData(img, 0, 0);
        ms.put = now() - t;
    } else {
        if (msg.kind === "invert") { invertMask(img.data); ctx.putImageData(img, 0, 0); }
        const tb = now();
        bounds = maskBounds(img.data, W, H);
        ms.resultBounds = now() - tb;
    }
    const bitmap = out.transferToImageBitmap();
    ms.total = now() - t0;
    return { bitmap, bounds, timing: ms };
}

/**
 * grow / shrink / feather on the selection's own tiles (docs/PLAN_BCE.md 3b, B item 3): `sel` is the mask as a store
 * (`storeRows`), the box `w` x `h` at (`x0`, `y0`) lies on the tile grid. The box is read from the tiles where they lie,
 * worked on, and cut into tiles again; only the tiles whose pixels changed go back, `{ tx, ty, data }` or
 * `{ tx, ty, empty: true }` for one that holds nothing any more. No canvas for grow and shrink; feather's blur is the
 * browser's, so it keeps one canvas here, but none on the main thread.
 */
async function selectionOverTiles(msg) {
    const t0 = now();
    const W = msg.w, H = msg.h, X0 = msg.x0 | 0, Y0 = msg.y0 | 0;
    let data = new Uint8ClampedArray(W * H * 4);
    storeRows(msg.sel, X0, W, Y0, H, data);
    const ms = { op: "selection", kind: msg.kind, kernels: kernelsInUse(), pixels: W * H, tiles: true, read: now() - t0 };
    const cols = (W + 255) >> 8, rows = (H + 255) >> 8;
    let bounds, cells = null;
    if (msg.kind === "grow") {
        cells = rustPx() ? new Uint8Array(cols * rows) : null;
        bounds = growMaskBounds(data, W, H, msg.n, { ms, cells });
    } else if (msg.kind === "feather") {
        const c = new OffscreenCanvas(W, H);
        c.getContext("2d").putImageData(new ImageData(data, W, H), 0, 0);
        // canvases of the default kind, as the job over a bitmap makes them: a CPU canvas blurs up to 7 levels differently
        const out = new OffscreenCanvas(W, H), octx = out.getContext("2d");
        octx.filter = `blur(${msg.radius}px)`;
        octx.drawImage(c, 0, 0);
        octx.filter = "none";
        data = octx.getImageData(0, 0, W, H).data;
        const tb = now();
        bounds = maskBounds(data, W, H);
        ms.resultBounds = now() - tb;
    } else throw new Error("unknown selection job " + msg.kind);
    const tc = now();
    const tiles = [], transfer = [];
    const d32 = cells ? null : new Uint32Array(data.buffer, data.byteOffset, W * H);
    const sx = msg.sel.x | 0, sy = msg.sel.y | 0;
    for (let ty = 0; ty * TILE < H; ty++) for (let tx = 0; tx * TILE < W; tx++) {
        const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
        const row = msg.sel.tiles[(Y0 + y0 - sy) >> 8];
        const name = row ? row[(X0 + x0 - sx) >> 8] : null;
        if (cells) {
            const c = cells[ty * cols + tx];
            if (c === 2) continue;
            if (!c) { if (name) tiles.push({ tx, ty, empty: true }); continue; }
        } else {
            const ob = name ? tileBytes(name).bytes : null;
            const old = ob ? new Uint32Array(ob.buffer, ob.byteOffset, TILE * TILE) : null;
            // whole pixels as words (little endian: the alpha is the top byte)
            let any = false, changed = false;
            for (let yy = 0; yy < bh && !(any && changed); yy++) {
                const o = (y0 + yy) * W + x0, so = yy * TILE;
                for (let i = 0; i < bw; i++) {
                    const v = d32[o + i];
                    if (v >>> 24) any = true;
                    if (v !== (old ? old[so + i] : 0)) changed = true;
                }
            }
            if (!changed) continue;
            if (!any) { tiles.push({ tx, ty, empty: true }); continue; }
        }
        const out = new Uint8ClampedArray(TILE * TILE * 4);
        for (let yy = 0; yy < bh; yy++) { const o = ((y0 + yy) * W + x0) * 4; out.set(data.subarray(o, o + bw * 4), yy * TILE * 4); }
        tiles.push({ tx, ty, data: out.buffer });
        transfer.push(out.buffer);
    }
    ms.cut = now() - tc;
    ms.total = now() - t0;
    return { tiles, bounds, transfer, timing: ms };
}

/**
 * The magic wand's and the bucket's region, as a shape in the requested colour. The bitmap
 * may be a box cut out of the image: `touches` says on which of its edges the region
 * arrives, so the editor can widen the box and ask again.
 */
async function flood(msg) {
    if (msg.sab) return floodOverTiles(msg);
    const t0 = now();
    const src = canvasOf(msg.bitmap);
    const W = src.width, H = src.height;
    const data = src.getContext("2d").getImageData(0, 0, W, H).data;
    // the `flood` route (kernels.js) picks the branch by the picture's size: Rust, or the users' JS loop below
    const p = rustPx("flood", W * H);
    const ms = { op: "flood", kernels: p ? "rust" : "js", pixels: W * H, read: now() - t0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    if (p) {
        // one call for the flood, the clip, the count, the bounds and the shape, drawn from wasm memory without a copy
        // (kernels.js `floodShape`: its twin after a trap, and the release of a grown instance)
        const sel = msg.selBitmap ? canvasOf(msg.selBitmap).getContext("2d").getImageData(0, 0, W, H).data : null;
        lap("clip");
        const [r, g, b] = hexToRgb(msg.color || "#ff0000");
        const res = floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds) => {
            lap("flood");
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        });
        const bb = res.bounds;
        const touches = bb ? { l: bb[0] === 0, t: bb[1] === 0, r: bb[2] === W, b: bb[3] === H } : null;
        ms.total = now() - t0;
        return { bitmap: res.bitmap, count: res.count, bounds: bb, touches, timing: ms };
    }
    const mask = floodMask(data, W, H, msg.x, msg.y, msg.tolerance, msg.contiguous);
    lap("flood");
    if (msg.selBitmap) clipMaskToSelection(mask, canvasOf(msg.selBitmap));
    lap("clip");
    let count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            if (!mask[row + x]) continue;
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    lap("bounds");
    const shape = maskToColorCanvas(mask, W, H, msg.color || "#ff0000");
    lap("shape");
    const touches = x1 < 0 ? null : { l: x0 === 0, t: y0 === 0, r: x1 === W - 1, b: y1 === H - 1 };
    const bitmap = shape.transferToImageBitmap();
    ms.total = now() - t0;
    return { bitmap, count, bounds: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], touches, timing: ms };
}

/**
 * The flood over a picture the pool composited from tiles (`stack_into`), B item 2: `sab` holds the box's RGBA8, `w` x
 * `h`; `sel` is the selection as a store (the bucket's clip), read here from its tiles. No canvas on the way in. The
 * shape goes back as a bitmap (the bucket draws it into a layer), or with `out: "tiles"` as the tiles of the box that
 * hold any of it, `[{ tx, ty, alpha }]` of 256 x 256 alpha bytes each (the box starts on the tile grid, so they are the
 * selection's own tiles, K9): the wand writes them into the mask without a canvas on the way out either.
 *
 * The kernel is kernels.js `floodShape`, so the `flood` route chooses Rust or the twin on the users' JS loop over the
 * same read (docs/PLAN_WASM_K1.md §0.1); only a thread without the Rust kernels refuses the stacks, as before.
 */
async function floodOverTiles(msg) {
    if (!rustPx()) throw new Error(NO_PARTS);
    const t0 = now();
    const W = msg.w, H = msg.h;
    const data = new Uint8Array(msg.sab, 0, W * H * 4);
    const ms = { op: "flood", kernels: rustPx("flood", W * H) ? "rust" : "js", pixels: W * H, tiles: true, read: 0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    let sel = null;
    if (msg.sel) { sel = new Uint8Array(W * H * 4); storeRows(msg.sel, msg.x0 | 0, W, msg.y0 | 0, H, sel); }
    lap("clip");
    const [r, g, b] = hexToRgb(msg.color || "#ff0000");
    const wantTiles = msg.out === "tiles";
    const res = floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds, cells) => {
        lap("flood");
        if (!wantTiles) {
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        }
        const tiles = [];
        if (bounds) {
            const cols = (W + 255) >> 8;
            for (let ty = bounds[1] >> 8; ty * TILE < bounds[3]; ty++) for (let tx = bounds[0] >> 8; tx * TILE < bounds[2]; tx++) {
                if (!cells[ty * cols + tx]) continue;
                const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
                const out = new Uint8Array(TILE * TILE);
                for (let yy = 0; yy < bh; yy++) { const o = (y0 + yy) * W + x0; out.set(view.subarray(o, o + bw), yy * TILE); }
                tiles.push({ tx, ty, alpha: out.buffer });
            }
        }
        lap("shape");
        return { count, bounds, tiles };
    }, wantTiles ? 1 : 4);
    const bb = res.bounds;
    const touches = bb ? { l: bb[0] === 0, t: bb[1] === 0, r: bb[2] === W, b: bb[3] === H } : null;
    ms.total = now() - t0;
    if (res.tiles) return { tiles: res.tiles, count: res.count, bounds: bb, touches, transfer: res.tiles.map((x) => x.alpha), timing: ms };
    return { bitmap: res.bitmap, count: res.count, bounds: bb, touches, timing: ms };
}

/**
 * One row of destination tiles of a resample (inpaint_resample.js, PLAN_0_1_31 §7): `src` names the source store's
 * tile rows the row's taps read (`{ w, h, tiles: { lty: names } }`, read where they lie, never written), `fx` the
 * fixed-point map, `o` the options, `rt` the canvas round trip measured on the main thread, `txs` the tiles of row `ty`
 * to make. Each comes back as a new buffer, transferred; a tile that came out empty does not come back.
 */
// the canvas round trip of the last resample job: every job brings a copy, and the Rust kernel keeps a table resident by
// its identity, so one copy is kept for as long as the bytes are the same
let RESAMPLE_RT = null;

function residentRt(rt) {
    if (!rt) return null;
    if (RESAMPLE_RT && RESAMPLE_RT.length === rt.length && RESAMPLE_RT.every((v, i) => v === rt[i])) return RESAMPLE_RT;
    RESAMPLE_RT = rt;
    return rt;
}

function resampleJob(msg) {
    const t0 = now();
    const { src, outW, outH, o, ty } = msg;
    const rt = residentRt(msg.rt);
    const views = new Map();
    const view = (t) => {
        const k = t.data ? t : t.chunk * 65536 + t.slot;
        let v = views.get(k);
        if (!v) { v = tileBytes(t).bytes; views.set(k, v); }
        return v;
    };
    const copyRun = (sy, x0, x1, dst, off) => {
        const names = src.tiles[sy >> 8], ly = (sy & 255) * TILE * 4;
        for (let x = x0; x < x1;) {
            const lx = x & 255, n = Math.min(x1 - x, TILE - lx), at = off + (x - x0) * 4;
            const t = names ? names[x >> 8] : null;
            if (t) dst.set(view(t).subarray(ly + lx * 4, ly + (lx + n) * 4), at);
            else dst.fill(0, at, at + n * 4);
            x += n;
        }
    };
    const tiles = [], transfer = [];
    let current = null;
    resampleStore({ width: src.w, height: src.h, copyRun, has: () => true }, Float64Array.from(msg.fx), outW, outH, o, rt, {
        tile: () => { current = new Uint8Array(TILE_BYTES); return [current, 0, TILE * 4]; },
        done: (tx, _ty, count) => { if (count) { tiles.push({ tx, data: current.buffer }); transfer.push(current.buffer); } },
    }, msg.txs.map((tx) => [tx, ty]), resampleBlock);
    return { tiles, transfer, timing: { op: "resample", kernels: kernelsInUse(), tiles: msg.txs.length, total: now() - t0 } };
}

/**
 * One row of output tiles of a liquify bake (inpaint_liquify.js, PLAN_0_1_31 §5 step 5): `src` names the source tile
 * rows the row's taps read (as a resample's), `nodes` the dense nodes of each tile of `txs` (in that order), `s` the grid
 * step, `clamp` the edge rule, `rt` the round trip, `blockMax` the gather's bound. Each tile comes back as a new buffer,
 * transferred, or `{ tx, empty: true }` when it came out transparent.
 */
function liquifyJob(msg) {
    const t0 = now();
    const { src, ty, s } = msg;
    let rt = msg.rt;
    if (rt && RESAMPLE_RT && RESAMPLE_RT.length === rt.length && RESAMPLE_RT.every((v, i) => v === rt[i])) rt = RESAMPLE_RT;
    else RESAMPLE_RT = rt;
    const views = new Map();
    const view = (t) => {
        const k = t.data ? t : t.chunk * 65536 + t.slot;
        let v = views.get(k);
        if (!v) { v = tileBytes(t).bytes; views.set(k, v); }
        return v;
    };
    const copyRun = (sy, x0, x1, dst, off) => {
        const names = src.tiles[sy >> 8], ly = (sy & 255) * TILE * 4;
        for (let x = x0; x < x1;) {
            const lx = x & 255, n = Math.min(x1 - x, TILE - lx), at = off + (x - x0) * 4;
            const t = names ? names[x >> 8] : null;
            if (t) dst.set(view(t).subarray(ly + lx * 4, ly + (lx + n) * 4), at);
            else dst.fill(0, at, at + n * 4);
            x += n;
        }
    };
    // `has`: whether any source tile lies under a box, from the names this job was given
    const has = (x0, y0, x1, y1) => {
        for (let r = y0 >> 8; r <= (y1 - 1) >> 8; r++) {
            const names = src.tiles[r];
            if (names) for (let c = x0 >> 8; c <= (x1 - 1) >> 8; c++) if (names[c]) return true;
        }
        return false;
    };
    const byTx = new Map(msg.txs.map((tx, i) => [tx, msg.nodes[i]]));
    const tiles = [], transfer = [];
    let current = null;
    const stats = liquifyStore({ width: src.w, height: src.h, copyRun, has }, s, (tx) => byTx.get(tx) || null, msg.txs.map((tx) => [tx, ty]), !!msg.clamp, rt, {
        share: (tx) => tiles.push({ tx, share: true }),
        tile: () => { current = new Uint8Array(TILE_BYTES); return [current, 0, TILE * 4]; },
        done: (tx, _ty, count) => {
            if (count) { tiles.push({ tx, data: current.buffer }); transfer.push(current.buffer); } else tiles.push({ tx, empty: true });
        },
    }, msg.blockMax || undefined, liquifyBlock);
    return { tiles, stats, transfer, timing: { op: "liquify", kernels: kernelsInUse(), tiles: msg.txs.length, total: now() - t0 } };
}

function depthGuide(msg) {
    const t0 = now();
    const raw = msg.raw instanceof Float32Array ? msg.raw : new Float32Array(msg.raw);
    const { rw, rh, gw, gh, r, eps } = msg;
    let { grey, gd, lo, hi } = msg;
    let gdBuf = null;
    if (!grey && gd) {
        const bytes = gd instanceof Uint8Array || gd instanceof Uint8ClampedArray ? gd : new Uint8Array(gd);
        gdBuf = bytes.buffer;
        const n = gw * gh;
        grey = new Uint8Array(n);
        for (let i = 0, j = 0; j < n; i += 4, j++) {
            grey[j] = Math.round(bytes[i] * 0.299 + bytes[i + 1] * 0.587 + bytes[i + 2] * 0.114);
        }
    }
    if (lo == null || hi == null) {
        const bounds = disparityRange(raw, 0.005, 0.995);
        if (lo == null) lo = bounds.lo;
        if (hi == null) hi = bounds.hi;
    }
    const u16 = guidedFar(raw, rw, rh, grey, gw, gh, r, eps, lo, hi);
    const transfer = gdBuf ? [u16.buffer, gdBuf] : [u16.buffer];
    return { u16: u16.buffer, ...(gdBuf ? { gd: gdBuf } : {}), lo, hi, transfer, timing: { op: "depth_guide", total: now() - t0 } };
}

function depthFuse(msg) {
    const t0 = now();
    const globalData = msg.global.data instanceof Float32Array ? msg.global.data : new Float32Array(msg.global.data);
    const global = { data: globalData, w: msg.global.w, h: msg.global.h };
    const tiles = (msg.tiles || []).map((t) => ({
        box: t.box,
        w: t.w,
        h: t.h,
        data: t.data instanceof Float32Array ? t.data : new Float32Array(t.data),
    }));
    const res = fuseTiles(global, tiles, msg.W, msg.H, msg.wf, msg.hf, { sigmaLow: msg.sigmaLow });
    return {
        data: res.data.buffer,
        w: msg.wf,
        h: msg.hf,
        fits: res.fits,
        transfer: [res.data.buffer],
        timing: { op: "depth_fuse", total: now() - t0 },
    };
}

export function rangeSelectJob(msg) {
    const t0 = now();
    const W = msg.W | 0, H = msg.H | 0;
    const y0 = msg.y0 | 0, y1 = msg.y1 | 0;
    const source = msg.source || "depth";
    const limit = msg.limit;
    const invert = !!msg.invert;
    const tiles = [];
    const transfer = [];
    let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
    let alphaSum = 0;

    if (source === "depth") {
        const map = msg.map;
        if (!map || !map.data) throw new Error("range_select: missing depth map data");
        const mapData = map.data instanceof Uint16Array ? map.data : new Uint16Array(map.data);
        const mapW = map.w | 0, mapH = map.h | 0;
        const m = map.m;

        const snap = msg.snap;

        let guideObj = null;
        if (msg.guide && (msg.guide.sab || msg.guide.data)) {
            const gBytes = msg.guide.sab
                ? new Uint8Array(msg.guide.sab)
                : (msg.guide.data instanceof Uint8Array
                    ? msg.guide.data
                    : new Uint8Array(msg.guide.data.buffer, msg.guide.data.byteOffset, msg.guide.data.byteLength));
            guideObj = { data: gBytes, w: msg.guide.w | 0, h: msg.guide.h | 0 };
        }

        const pic = msg.picture;
        let picObj = null;
        if (pic && (pic.sab || pic.data)) {
            const picData = pic.sab
                ? new Uint8Array(pic.sab)
                : (pic.data instanceof Uint8Array
                    ? pic.data
                    : new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.byteLength));
            picObj = {
                data: picData,
                x0: pic.x0 | 0,
                y0: pic.y0 | 0,
                w: pic.w | 0,
                h: pic.h | 0,
            };
        }

        const startTileY = Math.floor(y0 / TILE);
        const endTileY = Math.ceil(y1 / TILE);
        const rowClasses = (msg.classes && startTileY === endTileY - 1 && y0 <= startTileY * TILE && y1 >= Math.min((startTileY + 1) * TILE, H))
            ? msg.classes
            : null;
        if (rowClasses) {
            const bk = rangeRowBookkeeping(W, H, startTileY, rowClasses, TILE);
            alphaSum += bk.alphaSum;
            for (const ft of bk.tiles) tiles.push(ft);
            if (bk.bounds) {
                bX0 = Math.min(bX0, bk.bounds[0]);
                bY0 = Math.min(bY0, bk.bounds[1]);
                bX1 = Math.max(bX1, bk.bounds[2]);
                bY1 = Math.max(bY1, bk.bounds[3]);
            }
        }

        for (let ty = startTileY; ty < endTileY; ty++) {
            const res = rangeTilesDepth(mapData, mapW, mapH, m, W, H, ty, y0, y1, limit, invert, snap, guideObj, picObj, rowClasses, TILE);
            alphaSum += res.alphaSum;
            for (const t of res.tiles) {
                tiles.push(t);
                if (t.alpha) transfer.push(t.alpha);
            }
            if (res.bounds) {
                bX0 = Math.min(bX0, res.bounds[0]);
                bY0 = Math.min(bY0, res.bounds[1]);
                bX1 = Math.max(bX1, res.bounds[2]);
                bY1 = Math.max(bY1, res.bounds[3]);
            }
        }
    } else if (source === "luma" || source === "color") {
        const buf = new Uint8Array(msg.sab || msg.buffer);
        const rowLimit = limit && limit.source === source ? limit : { ...limit, source };
        const startTileY = Math.floor(y0 / TILE);
        const endTileY = Math.ceil(y1 / TILE);

        for (let ty = startTileY; ty < endTileY; ty++) {
            const res = rangeTilesRgba(buf, W, H, ty, y0, y1, rowLimit, invert, TILE);
            alphaSum += res.alphaSum;
            for (const t of res.tiles) {
                tiles.push(t);
                if (t.alpha) transfer.push(t.alpha);
            }
            if (res.bounds) {
                bX0 = Math.min(bX0, res.bounds[0]);
                bY0 = Math.min(bY0, res.bounds[1]);
                bX1 = Math.max(bX1, res.bounds[2]);
                bY1 = Math.max(bY1, res.bounds[3]);
            }
        }
    } else if (source === "logit") {
        const logits = msg.logits instanceof Float32Array ? msg.logits : new Float32Array(msg.logits.data || msg.logits);
        const n = msg.n || 256;
        const m = msg.m || [n / W, 0, 0, n / H, -0.5, -0.5];

        let clipBuf = null;
        if (msg.clip) {
            clipBuf = new Uint8Array(W * (y1 - y0));
            storeRows(msg.clip, 0, W, y0, y1 - y0, clipBuf, true);
        }

        const tileCols = Math.ceil(W / TILE);
        const startTileY = Math.floor(y0 / TILE);
        const endTileY = Math.ceil(y1 / TILE);

        const startTileX = msg.box ? Math.max(0, Math.floor(msg.box[0] / TILE)) : 0;
        const endTileX = msg.box ? Math.min(tileCols, Math.ceil(msg.box[2] / TILE)) : tileCols;

        for (let ty = startTileY; ty < endTileY; ty++) {
            const tileY0 = ty * TILE;
            const tileY1 = Math.min(tileY0 + TILE, H);
            for (let tx = startTileX; tx < endTileX; tx++) {
                const tileX0 = tx * TILE;
                const tileX1 = Math.min(tileX0 + TILE, W);

                const alpha = new Uint8Array(TILE * TILE);
                let zeros = 0, fulls = 0;
                let tMinX = TILE, tMinY = TILE, tMaxX = -1, tMaxY = -1;

                for (let py = 0; py < TILE; py++) {
                    const y = tileY0 + py;
                    if (y < y0 || y >= y1 || y >= H) {
                        zeros += TILE;
                        continue;
                    }
                    const pyOffset = py * TILE;
                    const clipRowOffset = (y - y0) * W;
                    const pyCentre = y + 0.5;

                    for (let px = 0; px < TILE; px++) {
                        const x = tileX0 + px;
                        if (x >= W) {
                            zeros++;
                            continue;
                        }
                        const pxCentre = x + 0.5;
                        const mx = m[0] * pxCentre + m[2] * pyCentre + m[4];
                        const my = m[1] * pxCentre + m[3] * pyCentre + m[5];
                        const fx = Math.min(n - 1, Math.max(0, mx));
                        const fy = Math.min(n - 1, Math.max(0, my));
                        const ix = Math.floor(fx), txFrac = fx - ix, ix1 = Math.min(n - 1, ix + 1);
                        const iy = Math.floor(fy), tyFrac = fy - iy, iy1 = Math.min(n - 1, iy + 1);
                        const r0 = iy * n, r1 = iy1 * n;
                        const v = (logits[r0 + ix] * (1 - txFrac) + logits[r0 + ix1] * txFrac) * (1 - tyFrac)
                                + (logits[r1 + ix] * (1 - txFrac) + logits[r1 + ix1] * txFrac) * tyFrac;

                        // The layer clip belongs to the object (inside = logit and clip); the inversion for
                        // intersect comes after it, or Shift+Alt keeps the layer's transparent pixels.
                        const inside = v > 0 && !(clipBuf && !clipBuf[clipRowOffset + x]);
                        const a = inside ? (invert ? 0 : 255) : (invert ? 255 : 0);

                        alpha[pyOffset + px] = a;
                        alphaSum += a;
                        if (a === 0) {
                            zeros++;
                        } else {
                            if (a === 255) fulls++;
                            if (px < tMinX) tMinX = px;
                            if (px > tMaxX) tMaxX = px;
                            if (py < tMinY) tMinY = py;
                            if (py > tMaxY) tMaxY = py;
                        }
                    }
                }

                if (zeros === TILE * TILE) {
                    continue;
                }
                if (fulls === TILE * TILE && (tileX1 - tileX0) === TILE && (tileY1 - tileY0) === TILE) {
                    tiles.push({ tx, ty, full: true });
                    bX0 = Math.min(bX0, tileX0);
                    bY0 = Math.min(bY0, tileY0);
                    bX1 = Math.max(bX1, tileX0 + TILE);
                    bY1 = Math.max(bY1, tileY0 + TILE);
                } else {
                    tiles.push({ tx, ty, alpha: alpha.buffer });
                    transfer.push(alpha.buffer);
                    bX0 = Math.min(bX0, tileX0 + tMinX);
                    bY0 = Math.min(bY0, tileY0 + tMinY);
                    bX1 = Math.max(bX1, tileX0 + tMaxX + 1);
                    bY1 = Math.max(bY1, tileY0 + tMaxY + 1);
                }
            }
        }
    } else {
        throw new Error(`unknown source "${source}"`);
    }

    const bounds = Number.isFinite(bX0) ? [bX0, bY0, bX1, bY1] : null;
    return {
        tiles,
        bounds,
        alphaSum,
        timing: { op: "range_select", source, ms: now() - t0, tiles: tiles.length },
        transfer,
    };
}

function relightNormalsJob(msg) {
    const { depth, w, h, scale, sigma } = msg;
    const depthArr = depth instanceof Uint16Array ? depth : new Uint16Array(depth);
    const normals = heightNormals(depthArr, w, h, scale, sigma);
    return { normals: normals.buffer, transfer: [normals.buffer] };
}

/**
 * One light's shadow march, or a stripe of it (K12, docs/PLAN_WASM_BUILD.md §4.5): with `out` (the march's
 * SharedArrayBuffer, w * h bytes) the rows row0.. are written there at row0 * w and only the rows go back, nothing
 * transferred; without it (one job a light: the route relightStripes 0, a page that is not isolated) they come back as a
 * buffer of their own. `key` names the depth map for the Rust sun's resident copy (px.js `_slot`). The timing: the
 * kernel's milliseconds and the rows (tools/perf_test.py's efficiency rows, the relight gate's case nk).
 */
function relightShadowJob(msg) {
    const { depth, w, h, scale, light, radius, taps, steps, bias, row0, rows, out, key } = msg;
    const depthArr = depth instanceof Uint16Array ? depth : new Uint16Array(depth);
    const t0 = now(), n = Math.min(rows, h - row0);
    const c0 = pxCalls();
    const timing = () => {
        const c1 = pxCalls();
        const ranRust = (c1.shadow_march_f64 || 0) > (c0.shadow_march_f64 || 0);
        return { op: "relight_shadow", kernels: ranRust ? "rust" : "js", w, h, row0, rows: n, kernel: now() - t0 };
    };
    if (out) {
        if (!(out instanceof Uint8Array) || out.length < w * h) throw new Error(`relight_shadow: out holds ${out && out.length} bytes, not ${w * h}`);
        shadowMarch(depthArr, w, h, scale, light, radius, taps, steps, bias, row0, rows, out, key ?? null);
        return { row0, rows: n, timing: timing() };
    }
    const vis = shadowMarch(depthArr, w, h, scale, light, radius, taps, steps, bias, row0, rows, null, key ?? null);
    return { vis: vis.buffer, row0, rows, transfer: [vis.buffer], timing: timing() };
}

/**
 * The separate areas of the selection (CLAUDE.md item 54): `sel` the selection's tiles (a store as `storeRows` takes it,
 * at (0, 0)), `W` x `H` the picture, `cell` the coarse grid's cell and `speck` the fewest pixels an area needs
 * (inpaint_areas.js). Only the tiles the store names are read, each where it lies; the reply is `labelParts`'s.
 */
function areaCellsJob(msg) {
    const t0 = now();
    const W = msg.W | 0, H = msg.H | 0, cell = Math.max(1, msg.cell | 0);
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    const counts = new Uint32Array(gw * gh);
    const store = msg.sel;
    let tiles = 0;
    for (const [row, names] of Object.entries(store.tiles || {})) {
        const oy = (+row) * TILE;
        if (!names || oy >= H) continue;
        for (let tx = 0; tx < names.length; tx++) {
            const t = names[tx];
            const ox = tx * TILE;
            if (!t || ox >= W) continue;
            countTileCells(tileBytes(t).bytes, ox, oy, Math.min(TILE, W - ox), Math.min(TILE, H - oy), cell, gw, counts);
            tiles++;
        }
    }
    const t1 = now();
    const out = labelParts(counts, gw, gh, cell, W, H, msg.speck | 0);
    return { ...out, timing: { op: "area_cells", tiles, cells: gw * gh, count: t1 - t0, label: now() - t1, total: now() - t0 } };
}

function relightRatioJob(msg) {
    const { fullPx, lowPx, ansPx, W, H, wAns, hAns } = msg;
    const full = fullPx instanceof Uint8Array ? fullPx : new Uint8Array(fullPx);
    const low = lowPx ? (lowPx instanceof Uint8Array ? lowPx : new Uint8Array(lowPx)) : null;
    const ans = ansPx instanceof Uint8Array ? ansPx : new Uint8Array(ansPx);
    const out = detailRatio(full, low, ans, W, H, wAns, hAns, boxBlurs);
    return { out: out.buffer, transfer: [out.buffer] };
}

async function run(msg) {
    setKernels(msg.kernels);
    adoptRoutes(msg.routes);
    pxTimed(!!msg.split);
    await kernelsReady();
    // never on an instance still loading: a renewal that went to the background (kernels.js `renew`) settles first, so
    // a job that needs Rust (png_part, the flood over tiles) gets it, and every job its kernels as routed
    await pxSettled();
    if (msg.op === "px_probe") return pxProbe(msg);
    if (msg.op === "relight_normals") return relightNormalsJob(msg);
    if (msg.op === "relight_shadow") return relightShadowJob(msg);
    if (msg.op === "relight_ratio") return relightRatioJob(msg);
    if (msg.op === "range_select") return rangeSelectJob(msg);
    if (msg.op === "area_cells") return areaCellsJob(msg);
    if (msg.op === "depth_guide") return depthGuide(msg);
    if (msg.op === "depth_fuse") return depthFuse(msg);
    if (msg.op === "resample") return resampleJob(msg);
    if (msg.op === "liquify") return liquifyJob(msg);
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return msg.sel ? selectionOverTiles(msg) : selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "mips") return mips(msg);
    if (msg.op === "band") return band(msg);
    if (msg.op === "poisson") return poissonJob(msg);
    if (msg.op === "png_part") return pngPart(msg);
    if (msg.op === "png_part_read") return pngPartRead(msg);
    if (msg.op === "png_part_finish") return pngPartFinishJob(msg);
    if (msg.op === "stack_into") return stackInto(msg);
    if (msg.op === "stack_points") return stackPoints(msg);
    if (msg.op === "hash") return hashJob(msg);
    if (msg.op === "psd_part") return psdPart(msg);
    if (msg.op === "png_read") return pngRead(msg);
    if (msg.op === "image_read") return imageRead(msg);
    if (msg.op === "tiff_band") return tiffBandJob(msg);
    if (msg.op === "tiff_read") return tiffRead(msg);
    if (msg.op === "psd_read") return psdRead(msg);
    if (msg.op === "tiff_part") return tiffPartJob(msg);
    if (msg.op === "crc") return crcJob(msg);
    if (msg.op === "inflate_bench") return inflateBench(msg);
    if (msg.op === "export_begin") {
        const opts = { width: msg.width, height: msg.height };
        exports_.set(msg.job, { format: msg.format, writer: msg.format === "psd" ? new PsdWriter(opts) : new OraWriter(opts) });
        return {};
    }
    if (msg.op === "export_layer") {
        const job = exports_.get(msg.job);
        if (!job) { for (const b of [msg.bitmap, msg.maskBitmap]) if (b) b.close(); throw new Error("unknown export job"); }
        if (msg.meta && msg.meta.section) { job.writer.section(msg.meta); return {}; }   // a group's record (PSD)
        // a PSD layer's mask comes as a second bitmap (its alpha the mask), `meta.mask` its flags
        const { mask, ...meta } = msg.meta;
        if (msg.maskBitmap) meta.mask = { canvas: canvasOf(msg.maskBitmap), disabled: !!(mask && mask.disabled) };
        await job.writer.layer(meta, canvasOf(msg.bitmap));
        return {};
    }
    if (msg.op === "export_finish") {
        const job = exports_.get(msg.job);
        if (!job) throw new Error("unknown export job");
        exports_.delete(msg.job);
        return { blob: await job.writer.finish(canvasOf(msg.bitmap)) };
    }
    if (msg.op === "export_cancel") {
        exports_.delete(msg.job);
        return {};
    }
    throw new Error("unknown job " + msg.op);
}

// ComfyUI imports every .js of the node's js/ into its page as an extension, this file too.
// There `self` is the window: a handler on it would answer any message posted to the page
// with an error posted to the page, which it receives again, forever. Only a worker listens.
const inWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
// A reply's `timing` also carries `pxCalls`: the Rust kernel calls of this thread during the job, by export name
// (docs/PLAN_WASM_BUILD.md §3.4), {} when only the twins ran, and `gen`, the job's measurement generation (a harness
// keeps only its own row's timings). A job posted with `split` also carries `pxSplit`: the job's milliseconds, the
// kernels' own, the copies, the allocations and the instance's renewals (kernels.js `pxSplit`). The counters and laps
// start from zero when a job starts in an idle worker; a pool worker runs one job at a time, the single worker can
// overlap jobs that wait (png, export) and then counts the other's calls and laps too, never fewer than the job's own.
// A job holds this thread's instance (`pxJobStart` / `pxJobEnd`): the idle trim never fires inside one.
let jobsInFlight = 0;
if (inWorker) self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.op === "arena") { arenaMessage(msg); return; }
    // not a job: the window's acknowledgement of a paced psd_read's bands (psdRead), handled while that job waits
    if (msg.op === "ack") { psdAck(msg); return; }
    // not a job: the memory this thread keeps between jobs (tools/px_probe.py --retention), before the counters
    if (msg.op === "px_stats") { self.postMessage({ id: msg.id, ok: true, op: "px_stats", ...pxInstances() }); return; }
    if (!jobsInFlight++) pxCalls(true);
    pxJobStart();
    const split = !!msg.split, s0 = split ? pxSplit() : null, tj = split ? now() : 0;
    try {
        const result = await run(msg);
        if (result && result.timing && typeof result.timing === "object") {
            result.timing.pxCalls = pxCalls();
            result.timing.gen = msg.gen;
            if (split) result.timing.pxSplit = { job: now() - tj, ...pxSplit(s0) };
        }
        // an ImageBitmap in the reply is transferred, never copied, and so are the buffers a job names in `transfer`
        const transfer = result && result.transfer ? result.transfer : result && result.bitmap ? [result.bitmap] : [];
        if (result) delete result.transfer;
        self.postMessage({ id: msg.id, ok: true, ...result }, transfer);
    } catch (err) {
        // a bitmap that was transferred but never drawn would leak until the worker dies
        for (const k of ["bitmap", "selBitmap"]) { try { if (msg[k] && msg[k].close) msg[k].close(); } catch (_) { /* ignore */ } }
        const reply = { id: msg.id, ok: false, error: String((err && err.message) || err) };
        // a trap or an out-of-memory the job could not recover from (a direct user's, docs/PLAN_WASM_K1.md §6 question 6):
        // the window's fallback makes this one, and a trapped instance is replaced at this thread's next call
        if (err instanceof WebAssembly.RuntimeError || err instanceof PxOutOfMemory) reply.trap = err.name;
        self.postMessage(reply);
    } finally {
        jobsInFlight--;
        pxJobEnd();
    }
};
