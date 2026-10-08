// Generated from DenRakEiw/scumble renderer/editor/inpaint_resample.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The resampler: new pixels from old ones through an affine map, tile by tile, in integer maths (PLAN_0_1_31 §7, 23b).
 * Pure, no DOM at import: the pixel classes of both backends and the pool's workers import it.
 *
 * The contract, the same in every implementation (this JS kernel, a later Rust twin, both pixel backends):
 * - A map `[a, b, c, d, e, f]` (a canvas matrix: x' = a x + c y + e, y' = b x + d y + f) sends a destination pixel
 *   INDEX (X, Y) to source pixel coordinates in which an integer is the centre of that source pixel. `pixelMap(inv)`
 *   makes one from a continuous inverse transform (destination to source, pixel corners at integers, as a canvas
 *   transform is). The map is turned into integers at 2^32 once (`toFixed`); every pixel's source position is then an
 *   exact integer sum, its tap index `floor(S / 2^32)` and its phase `floor(S / 2^24) & 255` (1/256 px).
 * - Colour: Catmull-Rom bicubic (Keys, a = -0.5; interpolating, so a map on whole pixels copies the bytes exactly: the
 *   identity, a shift, the quarter turns and the mirrors equal `resized` / `turned`), or bilinear. Weights come from a
 *   256-phase table of integers at 2^14, each phase summing to 2^14 exactly. Straight alpha is interpolated as
 *   premultiplied: alpha = round(sum w a / 2^28), colour = floor((2 sum w a c + sum w a) / (2 sum w a)), clamped; a
 *   pixel of alpha 0 carries colour 0. Every sum is an exact integer below 2^53, so the double division lands on the
 *   integer floor (the quotient is below 256 where it is not clamped and the divisor below 2^38).
 * - Masks (`alpha: true`): the alpha alone, bilinear by default (no ringing on a hard selection edge), in the class's
 *   colour (the selection's red, a layer mask's white).
 * - Bytes whose alpha is below 255 go through the canvas round trip (`canvasRoundTrip`, measured from a canvas on the
 *   main thread and handed to workers): what a tile holds must read back from a canvas unchanged.
 * - Edges: "transparent" (taps outside the source are alpha 0: an anti-aliased rotated edge) or "clamp" (the edge
 *   pixels repeat: for a base whose new frame lies inside the turned picture, no fringe at its corners).
 * - Sparse: a destination tile whose taps meet no source tile is not made; a tile that comes out empty is dropped.
 */

/** Filters: the index into the weight tables. */
export const RESAMPLE = Object.freeze({ bilinear: 0, bicubic: 1 });

const FRAC = 4294967296;       // 2^32: the map's fixed point
const PHASE = 16777216;        // 2^24: one phase step is 1/256 px
const ONE = 16384;             // 2^14: a weight table's unit
const ONE28 = 268435456;       // 2^28 = ONE * ONE
const HALF28 = 134217728;      // 2^27
const LIMIT = 4503599627370496;   // 2^52: every position sum stays below it (exact in a double and in an i64)

/**
 * The weight tables, generated the same way wherever they are needed: the polynomial in doubles in this order, each
 * weight `floor(w * 2^14 + 0.5)`, and what is missing to 2^14 added to the larger of the two middle taps.
 */
function cubicWeights() {
    const t = new Int32Array(256 * 4);
    for (let p = 0; p < 256; p++) {
        const x = p / 256;
        const w = [
            ((-x + 2) * x - 1) * x / 2,
            ((3 * x - 5) * x * x + 2) / 2,
            ((-3 * x + 4) * x + 1) * x / 2,
            (x - 1) * x * x / 2,
        ];
        let sum = 0;
        for (let k = 0; k < 4; k++) { t[p * 4 + k] = Math.floor(w[k] * ONE + 0.5); sum += t[p * 4 + k]; }
        t[p * 4 + (p < 128 ? 1 : 2)] += ONE - sum;
    }
    return t;
}

function linearWeights() {
    const t = new Int32Array(256 * 2);
    for (let p = 0; p < 256; p++) { t[p * 2] = (256 - p) * 64; t[p * 2 + 1] = p * 64; }
    return t;
}

const TABLES = [linearWeights(), cubicWeights()];
const TAPS = [2, 4];
const LEAD = [0, 1];            // taps before the one at floor(position)

/** The weight table of a filter (for tests and a twin): `taps` integers per phase, 256 phases. */
export function resampleWeights(filter) {
    return { taps: TAPS[filter], table: TABLES[filter].slice() };
}

/** The same table itself, not a copy (the Rust kernel keeps it in its memory, keyed by the array). */
export function resampleTable(filter) {
    return { taps: TAPS[filter], table: TABLES[filter] };
}

// ---- affine maps ----------------------------------------------------------------------------------

/** m after n: the map that applies n first. Both are canvas matrices [a, b, c, d, e, f]. */
export function xfMul(m, n) {
    return [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

export function xfInv(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det || !Number.isFinite(det)) throw new Error("Inpaint Canvas: a map that cannot be inverted");
    return [
        m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
    ];
}

export function xfApply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The bounding box [x0, y0, x1, y1] of the rectangle x0..x1, y0..y1 under m (not rounded). */
export function xfBox(m, x0, y0, x1, y1) {
    const p = [xfApply(m, x0, y0), xfApply(m, x1, y0), xfApply(m, x0, y1), xfApply(m, x1, y1)];
    return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
}

export const XF_IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function xfTranslate(x, y) {
    return [1, 0, 0, 1, x, y];
}

export function xfScale(sx, sy = sx) {
    return [sx, 0, 0, sy, 0, 0];
}

/**
 * A turn by `deg` degrees clockwise on screen (y down; the sign of ctx.rotate) about (cx, cy). Multiples of 90 degrees
 * get exact cosines and sines, so a quarter turn stays a permutation of whole pixels.
 */
export function xfRotate(deg, cx = 0, cy = 0) {
    let c, s;
    const q = deg / 90;
    if (Number.isInteger(q)) {
        const k = ((q % 4) + 4) % 4;
        c = [1, 0, -1, 0][k]; s = [0, 1, 0, -1][k];
    } else {
        const r = deg * Math.PI / 180;
        c = Math.cos(r); s = Math.sin(r);
    }
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

/**
 * The index map of the contract from a continuous inverse transform `inv` (destination to source, pixel corners at
 * integers): the source position of the centre of destination pixel (X, Y), minus half a pixel.
 */
export function pixelMap(inv) {
    return [inv[0], inv[1], inv[2], inv[3], (inv[0] + inv[2]) / 2 + inv[4] - 0.5, (inv[1] + inv[3]) / 2 + inv[5] - 0.5];
}

/** The map at 2^32 as six exact integers; refused when a position sum could leave the exact range. */
export function toFixed(map, outW, outH) {
    const f = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
        if (!Number.isFinite(map[i])) throw new Error("Inpaint Canvas: a resample map with a value that is not finite");
        f[i] = Math.floor(map[i] * FRAC + 0.5);
    }
    const reach = (a, c, e) => Math.abs(a) * outW + Math.abs(c) * outH + Math.abs(e) + 2 * FRAC;
    if (reach(f[0], f[2], f[4]) >= LIMIT || reach(f[1], f[3], f[5]) >= LIMIT) {
        throw new Error("Inpaint Canvas: a resample map beyond the exact range (a scale above 32 or a shift above 2^20 px)");
    }
    return f;
}

// ---- the canvas round trip ------------------------------------------------------------------------

let ROUND_TRIP = null;

/**
 * T[(a << 8) | c]: the channel value a canvas gives back for straight (c, a) put into it. Measured from a CPU canvas
 * (a GPU canvas's first read un-premultiplies 450 of the 65,536 pairs one level differently; its later reads agree
 * with this table). Main thread only (it needs `document`); a worker is handed the table.
 */
export function canvasRoundTrip() {
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

// ---- one destination block ------------------------------------------------------------------------

/**
 * The source box [x0, y0, x1, y1) (x1, y1 exclusive) whose pixels the taps of the destination block X0.., Y0.. of
 * vw x vh read: the map is affine, so the tap indices of the four corner pixels bound all of them.
 */
export function preimage(fx, X0, Y0, vw, vh, filter) {
    const n = TAPS[filter], lead = LEAD[filter];
    let ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity;
    for (const [X, Y] of [[X0, Y0], [X0 + vw - 1, Y0], [X0, Y0 + vh - 1], [X0 + vw - 1, Y0 + vh - 1]]) {
        const ix = Math.floor((fx[0] * X + fx[2] * Y + fx[4]) / FRAC), iy = Math.floor((fx[1] * X + fx[3] * Y + fx[5]) / FRAC);
        if (ix < ix0) ix0 = ix; if (ix > ix1) ix1 = ix;
        if (iy < iy0) iy0 = iy; if (iy > iy1) iy1 = iy;
    }
    return [ix0 - lead, iy0 - lead, ix1 - lead + n, iy1 - lead + n];
}

/**
 * The block of `box` gathered into `block` (RGBA, (x1 - x0) * 4 bytes a row) from a source of srcW x srcH:
 * `copyRun(sy, sx0, sx1, dst, off)` copies source pixels sx0..sx1 of row sy (all inside the source) to dst at off.
 * What lies outside the source is transparent, or the nearest edge pixel for `clamp`.
 */
export function gather(copyRun, box, srcW, srcH, clamp, block) {
    const [x0, y0, x1, y1] = box;
    const bw = x1 - x0, bh = y1 - y0, rowBytes = bw * 4;
    const a = Math.max(x0, 0), b = Math.min(x1, srcW);
    for (let r = 0; r < bh; r++) {
        let sy = y0 + r;
        const dst = r * rowBytes;
        if (sy < 0 || sy >= srcH) {
            if (!clamp) { block.fill(0, dst, dst + rowBytes); continue; }
            sy = sy < 0 ? 0 : srcH - 1;
        }
        if (b > a) copyRun(sy, a, b, block, dst + (a - x0) * 4);
        if (a > x0) {
            if (!clamp) block.fill(0, dst, dst + (Math.min(a, x1) - x0) * 4);
            else {
                // the first source pixel of the row: already in the block when the run starts at column 0 inside it
                const at = b > a ? dst + (a - x0) * 4 : -1;
                if (at < 0) copyRun(sy, 0, 1, block, dst);
                const s = at < 0 ? dst : at;
                for (let x = 0, n = Math.min(a, x1) - x0; x < n; x++) block.copyWithin(dst + x * 4, s, s + 4);
            }
        }
        if (x1 > b) {
            const from = Math.max(b, x0);
            if (!clamp) block.fill(0, dst + (from - x0) * 4, dst + rowBytes);
            else {
                const at = b > a ? dst + (b - 1 - x0) * 4 : -1;
                if (at < 0) copyRun(sy, srcW - 1, srcW, block, dst + (from - x0) * 4);
                const s = at < 0 ? dst + (from - x0) * 4 : at;
                for (let x = from - x0; x < bw; x++) block.copyWithin(dst + x * 4, s, s + 4);
            }
        }
    }
}

/**
 * The kernel: destination pixels X0.., Y0.. (vw x vh) from `block` (bw x bh RGBA at bx, by in source coordinates),
 * written to `out` at `off` with `stride` bytes a row. `fx` is `toFixed`'s map, `rgb` the mask colour as 0xBBGGRR,
 * `rt` the round-trip table or null. Returns how many pixels came out with an alpha above 0.
 */
export function resampleBlock(block, bw, bh, bx, by, fx, filter, alpha, rgb, rt, out, off, stride, X0, Y0, vw, vh) {
    const n = TAPS[filter], lead = LEAD[filter], table = TABLES[filter];
    const A = fx[0], B = fx[1], C = fx[2], D = fx[3], E = fx[4], F = fx[5];
    const maxX = bw - n, maxY = bh - n, row = bw * 4;
    const cr = rgb & 255, cg = (rgb >>> 8) & 255, cb = (rgb >>> 16) & 255;
    if (!alpha && blockOpaque(block, bw * bh)) return resampleOpaque(block, bw, bh, bx, by, fx, filter, out, off, stride, X0, Y0, vw, vh);
    let count = 0;
    for (let j = 0; j < vh; j++) {
        const Y = Y0 + j;
        let SX = A * X0 + C * Y + E, SY = B * X0 + D * Y + F;
        let o = off + j * stride;
        for (let i = 0; i < vw; i++, SX += A, SY += B, o += 4) {
            let cx = Math.floor(SX / FRAC) - lead - bx, cy = Math.floor(SY / FRAC) - lead - by;
            const wx = (Math.floor(SX / PHASE) & 255) * n, wy = (Math.floor(SY / PHASE) & 255) * n;
            // inside by construction (the block is the preimage); clamped so a caller's mistake cannot read outside
            if (cx < 0) cx = 0; else if (cx > maxX) cx = maxX;
            if (cy < 0) cy = 0; else if (cy > maxY) cy = maxY;
            let SA = 0, SR = 0, SG = 0, SB = 0;
            let p = (cy * bw + cx) * 4;
            for (let r = 0; r < n; r++, p += row) {
                let ra = 0, rr = 0, rg = 0, rb = 0;
                for (let k = 0, q = p; k < n; k++, q += 4) {
                    const a = block[q + 3];
                    if (!a) continue;
                    const wa = table[wx + k] * a;
                    ra += wa;
                    if (!alpha) { rr += wa * block[q]; rg += wa * block[q + 1]; rb += wa * block[q + 2]; }
                }
                const w = table[wy + r];
                SA += w * ra;
                if (!alpha) { SR += w * rr; SG += w * rg; SB += w * rb; }
            }
            let a = Math.floor((SA + HALF28) / ONE28);
            if (a <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
            if (a > 255) a = 255;
            count++;
            let r, g, b;
            if (alpha) { r = cr; g = cg; b = cb; }
            else {
                const d = 2 * SA;
                r = Math.floor((2 * SR + SA) / d); g = Math.floor((2 * SG + SA) / d); b = Math.floor((2 * SB + SA) / d);
                r = r < 0 ? 0 : r > 255 ? 255 : r;
                g = g < 0 ? 0 : g > 255 ? 255 : g;
                b = b < 0 ? 0 : b > 255 ? 255 : b;
            }
            if (rt && a < 255) { const t = a << 8; r = rt[t | r]; g = rt[t | g]; b = rt[t | b]; }
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
    return count;
}

function blockOpaque(block, n) {
    for (let q = 3, e = n * 4; q < e; q += 4) if (block[q] !== 255) return false;
    return true;
}

/**
 * The kernel over a block with no alpha below 255: every tap weighs its alpha 255, so sum w a = 255 * 2^28 and the
 * general colour floor((2 * 255 sum w c + 255 * 2^28) / (2 * 255 * 2^28)) is floor((sum w c + 2^27) / 2^28): the same
 * bytes without the alpha in the sums (tools/resample_test.js holds both paths to the direct arithmetic).
 */
function resampleOpaque(block, bw, bh, bx, by, fx, filter, out, off, stride, X0, Y0, vw, vh) {
    const n = TAPS[filter], lead = LEAD[filter], table = TABLES[filter];
    const A = fx[0], B = fx[1], C = fx[2], D = fx[3], E = fx[4], F = fx[5];
    const maxX = bw - n, maxY = bh - n, row = bw * 4;
    for (let j = 0; j < vh; j++) {
        const Y = Y0 + j;
        let SX = A * X0 + C * Y + E, SY = B * X0 + D * Y + F;
        let o = off + j * stride;
        for (let i = 0; i < vw; i++, SX += A, SY += B, o += 4) {
            let cx = Math.floor(SX / FRAC) - lead - bx, cy = Math.floor(SY / FRAC) - lead - by;
            const wx = (Math.floor(SX / PHASE) & 255) * n, wy = (Math.floor(SY / PHASE) & 255) * n;
            if (cx < 0) cx = 0; else if (cx > maxX) cx = maxX;
            if (cy < 0) cy = 0; else if (cy > maxY) cy = maxY;
            let SR = 0, SG = 0, SB = 0;
            let p = (cy * bw + cx) * 4;
            for (let r = 0; r < n; r++, p += row) {
                let rr = 0, rg = 0, rb = 0;
                for (let k = 0, q = p; k < n; k++, q += 4) {
                    const w = table[wx + k];
                    rr += w * block[q]; rg += w * block[q + 1]; rb += w * block[q + 2];
                }
                const w = table[wy + r];
                SR += w * rr; SG += w * rg; SB += w * rb;
            }
            let r = Math.floor((SR + HALF28) / ONE28), g = Math.floor((SG + HALF28) / ONE28), b = Math.floor((SB + HALF28) / ONE28);
            out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
            out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
            out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
            out[o + 3] = 255;
        }
    }
    return vw * vh;
}

// ---- a whole store --------------------------------------------------------------------------------

let SCRATCH = new Uint8Array(0);

function scratchOf(bytes) {
    if (SCRATCH.length < bytes) SCRATCH = new Uint8Array(Math.max(bytes, SCRATCH.length * 2));
    return SCRATCH;
}

/** A resample's options with the defaults of its pixels: a mask interpolates its alpha bilinearly in its colour. */
export function resampleOptions(opts, mask) {
    const filter = opts.filter === undefined ? (mask ? "bilinear" : "bicubic") : opts.filter;
    if (!(filter in RESAMPLE)) throw new Error(`Inpaint Canvas: no resample filter "${filter}"`);
    const edge = opts.edge || "transparent";
    if (edge !== "transparent" && edge !== "clamp") throw new Error(`Inpaint Canvas: no resample edge "${edge}"`);
    const color = opts.color || [255, 0, 0];
    return {
        filter: RESAMPLE[filter],
        alpha: opts.alpha === undefined ? !!mask : !!opts.alpha,
        rgb: ((color[2] << 16) | (color[1] << 8) | color[0]) >>> 0,
        clamp: edge === "clamp",
    };
}

/**
 * Every destination tile of outW x outH (256 x 256, row by row) from a source:
 * `src = { width, height, copyRun(sy, sx0, sx1, dst, off), has(x0, y0, x1, y1) }` (`has`: does any source pixel of
 * that box, inside the source, exist at all), `target = { tile(tx, ty, vw, vh) -> [out, off, stride], done(tx, ty,
 * count) }`. `o` is `resampleOptions`'s answer, `rt` the round-trip table or null. `tiles` limits the walk to a list
 * of [tx, ty] (a job's share); all of them by default. `kernel` is `resampleBlock` here; the editor and the pool's workers
 * pass px/kernels.js's, which is the Rust build of it once that has loaded (the same bytes).
 */
export function resampleStore(src, map, outW, outH, o, rt, target, tiles = null, kernel = resampleBlock) {
    const fx = map instanceof Float64Array ? map : toFixed(map, outW, outH);
    const cols = Math.ceil(outW / 256), rows = Math.ceil(outH / 256);
    const list = tiles || (function* () { for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) yield [tx, ty]; })();
    for (const [tx, ty] of list) {
        const X0 = tx * 256, Y0 = ty * 256;
        const vw = Math.min(256, outW - X0), vh = Math.min(256, outH - Y0);
        if (vw <= 0 || vh <= 0) continue;
        const box = preimage(fx, X0, Y0, vw, vh, o.filter);
        // the part of the box inside the source (for clamp: the edge pixels it repeats)
        const lim = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
        const inside = o.clamp
            ? [lim(box[0], src.width - 1), lim(box[1], src.height - 1), lim(box[2], src.width - 1) + 1, lim(box[3], src.height - 1) + 1]
            : [Math.max(box[0], 0), Math.max(box[1], 0), Math.min(box[2], src.width), Math.min(box[3], src.height)];
        if (inside[2] <= inside[0] || inside[3] <= inside[1] || !src.has(...inside)) continue;
        const bw = box[2] - box[0], bh = box[3] - box[1];
        const block = scratchOf(bw * bh * 4);
        gather(src.copyRun, box, src.width, src.height, o.clamp, block);
        const [out, off, stride] = target.tile(tx, ty, vw, vh);
        const count = kernel(block, bw, bh, box[0], box[1], fx, o.filter, o.alpha, o.rgb, rt, out, off, stride, X0, Y0, vw, vh);
        target.done(tx, ty, count);
    }
}
