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
 *   png_read        a PNG file decoded as a stream, its rows back band by band (`progress` messages).
 *   image_read      any image file the browser decodes (JPEG, WebP, a PNG with a colour profile), decoded here and
 *                   read back band by band like png_read: the window never decodes or reads it.
 *   resample        one row of destination tiles of an affine resample (inpaint_resample.js): the straighten of 23b.
 *   liquify         one row of output tiles of a liquify bake (inpaint_liquify.js): PLAN_0_1_31 §5 step 5.
 *   band            a row of tiles composited, layer over layer (`compositeTile`): no caller in
 *                   the editor yet; phase R measures the kernel phase E's band export will run.
 *   poisson         the healing brush's blend over a stroke's box (`poissonBlend`, PLAN_0_1_31 §5): the picture,
 *                   the source patch and the mask as plain buffers in, the healed box back.
 *
 * Pixels arrive as ImageBitmaps (transferred, never copied through structured cloning) and
 * are closed as soon as they are drawn. Every reply carries the request's id; a failure
 * comes back as { ok: false, error } and the editor falls back to the main thread.
 *
 * The pixel kernels come from px/kernels.js: the Rust build once this worker has loaded it, the
 * JS twins before and without it. `kernels: "js"` on a job forces the twins (the benchmark,
 * tools/px_jobs.py). The mips, selection, flood and band jobs reply with `timing`: the
 * milliseconds of their parts.
 */
import { PsdWriter, OraWriter } from "./inpaint_export.js";
import { floodMask, maskToColorCanvas, clipMaskToSelection, clipCoverage, growMaskBounds, invertMask, maskBounds, hexToRgb } from "./inpaint_raster.js";
import { pngChunk, crc32, readPng, PNG_LEVEL, NO_PARTS } from "./inpaint_png.js";
import { readTiff, tiffPart } from "./inpaint_tiff.js";
import { resampleStore } from "./inpaint_resample.js";
import { liquifyStore } from "./inpaint_liquify.js";
import { guidedFar } from "./inpaint_depth.js";
import { u16Bilinear, rangeWeight, LUMA, opp, colourSimilarity, hexToRgb as hexToRgb01 } from "./inpaint_weights.js";
import { mipChain, mipChainBytes, clampExtend, compositeTile, matchPixels, psdPackRows, kernelsReady, setKernels, rustPx, kernelsInUse, releaseIfLarge, deflate, resampleBlock, poissonBlend, boxBlurs } from "./px/kernels.js";

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
    const p = rustPx();
    const t0 = now();
    const out = p ? mipsRust(p, msg) : mipsJs(msg);
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

/** The same chains from the Rust kernels: each tile copied into wasm memory, its chain copied out. */
function mipsRust(p, msg) {
    const n = p.exports.mip_chain_bytes(TILE, LEVELS), a = p.job;
    const chains = [], exts = [], datas = [], transfer = [];
    try {
        const pin = a.take(TILE * TILE * 4), pout = a.take(n);
        for (const t of msg.tiles) {
            p.u8().set(tileBytes(t).bytes, pin);
            p.exports.mip_chain(pin, TILE, LEVELS, pout);
            const chain = p.u8().slice(pout, pout + n);
            chains.push(chain.buffer);
            transfer.push(chain.buffer);
            if (t.vw < TILE || t.vh < TILE) {
                p.exports.clamp_extend(pin, TILE, t.vw, t.vh);
                p.exports.mip_chain(pin, TILE, LEVELS, pout);
                const ext = p.u8().slice(pout, pout + n);
                exts.push(ext.buffer);
                transfer.push(ext.buffer);
            } else {
                exts.push(null);
            }
            datas.push(t.data || null);
            if (t.data) transfer.push(t.data);
        }
    } finally { a.reset(); }
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
function rowsOfTiles(msg, above = false) {
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
 * The rows `Y0` to `Y0 + n` of the image out of one store of a stack: `{ x, y, w, h, tiles }`, its pixels at (x, y) of
 * the image, `tiles[lty]` the names of its tile row `lty` from the left (as `rowsOfTiles` takes them). Into `out`, `W`
 * pixels wide from the image's column `X0`: RGBA8, or with `alphaOnly` one byte a pixel, the alpha. False when no tile
 * of the store lies there.
 */
function storeRows(store, X0, W, Y0, n, out, alphaOnly = false) {
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
function rowsOfStack(msg, above = false, into = null) {
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
        srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
    }
    if (srcs.length) compositeTile(dst, srcs, ops, alphas, masks);
    return dst;
}

/**
 * Rows of a stack composited into a shared buffer (B item 2: the picture a flood reads, put together by the pool):
 * `sab` holds `w` x `h` RGBA8 of the box at (`x0`, `y0`) of the image, zeroed (or `clear` asks this job to zero its
 * rows first); this job fills the rows `y` to `y + rows`.
 */
async function stackInto(msg) {
    const t0 = now();
    const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4;
    const into = new Uint8Array(msg.sab, at, msg.w * msg.rows * 4);
    if (msg.clear) into.fill(0);   // a buffer that is used band after band (B item 7 part 2): cleared here, not on the main thread
    rowsOfStack(msg, false, into);
    return { timing: { op: "stack_into", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0 } };
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
async function stackPoints(msg) {
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
        srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
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
 * One part of a PNG's pixels (inpaint_png.js, docs/PLAN_BCE.md §E2): rows as bytes (`rgba`, `prev`) or as tiles
 * (`tiles`, `prevTiles`, `r0`), filtered and deflated by the Rust kernel, as a finished IDAT chunk.
 */
async function pngPart(msg) {
    const p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const rgba = partRowsOf(msg);
    const tc = now();
    const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : msg.stack ? rowsOfStack(msg, true) : rowsOfTiles(msg, true);
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, msg.level === undefined ? PNG_LEVEL : msg.level, !!msg.last);
    releaseIfLarge();
    const chunk = pngChunk("IDAT", r.bytes);
    return { chunk: chunk.buffer, adler: r.adler, raw: r.raw, transfer: [chunk.buffer], timing: { op: "png_part", kernels: "rust", pixels: msg.w * msg.rows, kernel: now() - t0, compose: msg.stack ? tc - t0 : 0 } };
}

/**
 * One part of a PSD's channel data (docs/PLAN_BCE.md §E4): rows as bytes or as tiles (as `png_part` takes them),
 * PackBits per channel. `channels`: [{ lens, data }] for R, G, B, A, transferred.
 */
async function psdPart(msg) {
    const t0 = now();
    const rgba = partRowsOf(msg);
    const packed = psdPackRows(rgba, msg.w, msg.rows);
    releaseIfLarge();
    const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
    return { channels, transfer: channels.flatMap((c) => [c.lens, c.data]), timing: { op: "psd_part", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0 } };
}

/**
 * One strip of a TIFF (inpaint_tiff.js `tiffPart`, docs/PLAN_0_1_29.md 3d): rows as bytes, a stack or tiles (as
 * `png_part` takes them), differenced and deflated into a zlib stream by the Rust kernels (the JS twin without them).
 */
async function tiffPartJob(msg) {
    const t0 = now();
    const rgba = partRowsOf(msg);
    const p = rustPx();
    const level = msg.level === undefined ? PNG_LEVEL : msg.level;
    const r = await tiffPart({ rgba, w: msg.w, rows: msg.rows, predictor: msg.predictor }, (bytes) => (p ? p.zlib(bytes, level) : deflate(bytes)));
    releaseIfLarge();
    return { chunk: r.chunk, raw: r.raw, transfer: [r.chunk], timing: { op: "tiff_part", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0 } };
}

/**
 * A TIFF read as a stream (inpaint_tiff.js `readTiff`), like `png_read`: `progress` messages `{ header }`, then
 * `{ rgba, y0, rows }` transferred; the reply carries what the reader found (`info`, with its notes).
 */
async function tiffRead(msg) {
    const t0 = now();
    const info = await readTiff(msg.blob, {
        rowsPerBand: msg.rowsPerBand || TILE,
        onHeader: (h) => { self.postMessage({ id: msg.id, progress: true, header: { width: h.width, height: h.height } }); },
        onRows: (rgba, y0, rows) => { self.postMessage({ id: msg.id, progress: true, rgba: rgba.buffer, y0, rows }, [rgba.buffer]); },
    });
    return { info, timing: { op: "tiff_read", kernels: "js", pixels: info.width * info.height, kernel: now() - t0 } };
}

/** CRC-32 and size of a blob (a zip entry of an ORA file). */
async function crcJob(msg) {
    const bytes = new Uint8Array(await msg.blob.arrayBuffer());
    return { crc: crc32(bytes), size: bytes.length };
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
    return { width: info.width, height: info.height, texts: info.texts, header, timing: { op: "png_read", kernels: kernelsInUse(), pixels: info.width * info.height, kernel: now() - t0, unfilter: info.spent.unfilter, deliver: info.spent.deliver } };
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
    let bounds;
    if (msg.kind === "grow") {
        bounds = growMaskBounds(data, W, H, msg.n, { ms });
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
    const d32 = new Uint32Array(data.buffer, data.byteOffset, W * H);
    const sx = msg.sel.x | 0, sy = msg.sel.y | 0;
    for (let ty = 0; ty * TILE < H; ty++) for (let tx = 0; tx * TILE < W; tx++) {
        const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
        const row = msg.sel.tiles[(Y0 + y0 - sy) >> 8];
        const name = row ? row[(X0 + x0 - sx) >> 8] : null;
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
    const ms = { op: "flood", kernels: kernelsInUse(), pixels: W * H, read: now() - t0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    const p = rustPx();
    if (p) {
        // one call for the flood, the clip, the count, the bounds and the shape, drawn from wasm memory without a copy
        const sel = msg.selBitmap ? canvasOf(msg.selBitmap).getContext("2d").getImageData(0, 0, W, H).data : null;
        lap("clip");
        const [r, g, b] = hexToRgb(msg.color || "#ff0000");
        const res = p.floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds) => {
            lap("flood");
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        });
        releaseIfLarge();
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
 * hold any of it, `[{ tx, ty, data }]` of 256 x 256 RGBA8 each (the box starts on the tile grid, so they are the
 * selection's own tiles): the wand writes them into the mask without a canvas on the way out either.
 */
async function floodOverTiles(msg) {
    const p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const W = msg.w, H = msg.h;
    const data = new Uint8Array(msg.sab, 0, W * H * 4);
    const ms = { op: "flood", kernels: "rust", pixels: W * H, tiles: true, read: 0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    let sel = null;
    if (msg.sel) { sel = new Uint8Array(W * H * 4); storeRows(msg.sel, msg.x0 | 0, W, msg.y0 | 0, H, sel); }
    lap("clip");
    const [r, g, b] = hexToRgb(msg.color || "#ff0000");
    const res = p.floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds) => {
        lap("flood");
        if (msg.out !== "tiles") {
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        }
        const tiles = [];
        if (bounds) {
            for (let ty = bounds[1] >> 8; ty * TILE < bounds[3]; ty++) for (let tx = bounds[0] >> 8; tx * TILE < bounds[2]; tx++) {
                const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
                let any = false;
                for (let yy = 0; yy < bh && !any; yy++) { const o = ((y0 + yy) * W + x0) * 4 + 3; for (let xx = 0; xx < bw; xx++) if (view[o + xx * 4]) { any = true; break; } }
                if (!any) continue;
                const out = new Uint8ClampedArray(TILE * TILE * 4);
                for (let yy = 0; yy < bh; yy++) { const o = ((y0 + yy) * W + x0) * 4; out.set(view.subarray(o, o + bw * 4), yy * TILE * 4); }
                tiles.push({ tx, ty, data: out.buffer });
            }
        }
        lap("shape");
        return { count, bounds, tiles };
    });
    releaseIfLarge();
    const bb = res.bounds;
    const touches = bb ? { l: bb[0] === 0, t: bb[1] === 0, r: bb[2] === W, b: bb[3] === H } : null;
    ms.total = now() - t0;
    if (res.tiles) return { tiles: res.tiles, count: res.count, bounds: bb, touches, transfer: res.tiles.map((x) => x.data), timing: ms };
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

function resampleJob(msg) {
    const t0 = now();
    const { src, outW, outH, o, ty } = msg;
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
    }, msg.blockMax || undefined);
    return { tiles, stats, transfer, timing: { op: "liquify", tiles: msg.txs.length, total: now() - t0 } };
}

function depthGuide(msg) {
    const t0 = now();
    const u16 = guidedFar(msg, boxBlurs);
    return { u16: u16.buffer, transfer: [u16.buffer], timing: { op: "depth_guide", total: now() - t0 } };
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

        const tileCols = Math.ceil(W / TILE);
        const startTileY = Math.floor(y0 / TILE);
        const endTileY = Math.ceil(y1 / TILE);

        for (let ty = startTileY; ty < endTileY; ty++) {
            const tileY0 = ty * TILE;
            const tileY1 = Math.min(tileY0 + TILE, H);
            for (let tx = 0; tx < tileCols; tx++) {
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
                        const v = u16Bilinear(mapData, mapW, mapH, mx, my);
                        const w = rangeWeight(v, limit);
                        const a = Math.round(255 * (invert ? 1 - w : w));

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
    } else if (source === "luma" || source === "color") {
        const buf = new Uint8Array(msg.sab || msg.buffer);
        const isLuma = source === "luma";
        let colorRef = null, colorTol = 30;
        if (!isLuma) {
            const rgbRef = hexToRgb01(limit.color || "#ffffff");
            colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
            colorTol = limit.tol ?? 30;
        }

        const tileCols = Math.ceil(W / TILE);
        const startTileY = Math.floor(y0 / TILE);
        const endTileY = Math.ceil(y1 / TILE);

        for (let ty = startTileY; ty < endTileY; ty++) {
            const tileY0 = ty * TILE;
            const tileY1 = Math.min(tileY0 + TILE, H);
            for (let tx = 0; tx < tileCols; tx++) {
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
                    const rowOffset = (y - y0) * W;

                    for (let px = 0; px < TILE; px++) {
                        const x = tileX0 + px;
                        if (x >= W) {
                            zeros++;
                            continue;
                        }
                        const offset = (rowOffset + x) * 4;
                        let v;
                        if (isLuma) {
                            v = (0.299 * buf[offset] + 0.587 * buf[offset + 1] + 0.114 * buf[offset + 2]) / 255;
                        } else {
                            v = colourSimilarity(buf[offset] / 255, buf[offset + 1] / 255, buf[offset + 2] / 255, colorRef, colorTol);
                        }
                        const w = rangeWeight(v, limit);
                        const a = Math.round(255 * (invert ? 1 - w : w));

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

async function run(msg) {
    setKernels(msg.kernels);
    await kernelsReady();
    if (msg.op === "range_select") return rangeSelectJob(msg);
    if (msg.op === "depth_guide") return depthGuide(msg);
    if (msg.op === "resample") return resampleJob(msg);
    if (msg.op === "liquify") return liquifyJob(msg);
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return msg.sel ? selectionOverTiles(msg) : selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "mips") return mips(msg);
    if (msg.op === "band") return band(msg);
    if (msg.op === "poisson") return poissonJob(msg);
    if (msg.op === "png_part") return pngPart(msg);
    if (msg.op === "stack_into") return stackInto(msg);
    if (msg.op === "stack_points") return stackPoints(msg);
    if (msg.op === "hash") return hashJob(msg);
    if (msg.op === "psd_part") return psdPart(msg);
    if (msg.op === "png_read") return pngRead(msg);
    if (msg.op === "image_read") return imageRead(msg);
    if (msg.op === "tiff_read") return tiffRead(msg);
    if (msg.op === "tiff_part") return tiffPartJob(msg);
    if (msg.op === "crc") return crcJob(msg);
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
if (inWorker) self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.op === "arena") { arenaMessage(msg); return; }
    try {
        const result = await run(msg);
        // an ImageBitmap in the reply is transferred, never copied, and so are the buffers a job names in `transfer`
        const transfer = result && result.transfer ? result.transfer : result && result.bitmap ? [result.bitmap] : [];
        if (result) delete result.transfer;
        self.postMessage({ id: msg.id, ok: true, ...result }, transfer);
    } catch (err) {
        // a bitmap that was transferred but never drawn would leak until the worker dies
        for (const k of ["bitmap", "selBitmap"]) { try { if (msg[k] && msg[k].close) msg[k].close(); } catch (_) { /* ignore */ } }
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
};
