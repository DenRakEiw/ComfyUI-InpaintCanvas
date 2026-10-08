// Generated from DenRakEiw/scumble renderer/editor/inpaint_liquify.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Liquify (PLAN_0_1_31 §5 step 5): the displacement field, its brushes, the bake of a layer through it and the preview
 * sampler. Pure, no DOM at import: the editor, the pool's workers and tools/liquify_test.js import it.
 *
 * The contract, the same in every implementation (this JS kernel, a later Rust twin, both pixel backends):
 * - The field is a backward map in the layer's own pixels: out(X) = orig(X + D(X)) for a pixel index X, in positions
 *   where an integer is a pixel's centre (inpaint_resample.js's convention). What is read from outside the layer is
 *   transparent, or the edge pixel repeated (`clamp`: a layer as large as the picture); what is pushed past its edge is
 *   cut (the layer never grows).
 * - D lives on nodes every s px (`gridStep`: 1, 2, 4 or 8 by the picture's size): node (i, j) sits at pixel (i s, j s),
 *   its (dx, dy) are integers in 1/256 px within ±LIQUIFY_MAX. Between nodes it is bilinear in exact integers: for
 *   X = i s + fx, Y = j s + fy the four nodes weighed (s - fx)(s - fy), fx (s - fy), (s - fx) fy and fx fy sum to D in
 *   units of 2^-k px, k = 8 + 2 log2 s; the source position is SX = X 2^k + DX (below 2^31 for X < 2^16, so `>>` floors
 *   it in JS as an i32 does in Rust), its tap `SX >> k` and its phase `(SX >> (k - 8)) & 255` (1/256 px). No float
 *   enters the bake.
 * - Colour: resampleBlock's Catmull-Rom bicubic, its weight table and its integer arithmetic (premultiplied sums, a
 *   pixel of alpha 0 is 0 0 0 0, the canvas round trip `rt` below alpha 255), except that a pixel whose two phases are 0
 *   copies its source pixel's four bytes as they are: D = 0 and every whole-pixel shift give the source's bytes exactly,
 *   whatever the round trip does to bytes that did not come from a canvas.
 * - Cells: the nodes of one 256 x 256 tile, key (ty << 16) | tx, an Int32Array of (256 / s)^2 * 2 with (dx, dy)
 *   interleaved row by row; a missing cell is zero, a cell that returns to zero is dropped. Node 256 / s of a tile is
 *   the next cell's first, so the last pixel row and column of a tile interpolate towards the next tile's cells.
 * - A stroke never writes into a cell its undo step holds: `dab` and `restoreAll` take `before` (the cells at the press)
 *   and write into a copy of any cell still shared with it, so steps share every cell they did not change.
 *
 * The brushes (`dab`) are advected, never additive: a node's new D is n + D(q + n), with n what the dab moves it by and
 * D read bilinearly in doubles from the field before the dab, so two pushes carry a mark by their sum. Restore scales D
 * towards 0 and truncates towards 0, so it reaches the source's bytes exactly. With the falloff's steepest slope 1.54 /
 * (1 - h) and the caps the editor keeps (a push step at most 0.2 r (1 - h), hardness at most 0.8), every dab's map is
 * injective, and so is a stroke: the picture never folds.
 */

import { resampleTable, gather } from "./inpaint_resample.js";

const TILE = 256;
const TAPS = 4, LEAD = 1;                          // Catmull-Rom: four taps, one before floor(position)
const TABLE = resampleTable(1).table;             // the resampler's own bicubic table (256 phases x 4, at 2^14)
const ONE28 = 268435456, HALF28 = 134217728;       // 2^28, 2^27
const LOG2 = { 1: 0, 2: 1, 4: 2, 8: 3 };

/** |dx|, |dy| of a node at most 16384 px (in 1/256 px): the bake's positions stay below 2^31. */
export const LIQUIFY_MAX = 16384 * 256;

/** The modes a dab knows. */
export const LIQUIFY_MODES = Object.freeze(["push", "grow", "shrink", "swirlcw", "swirlccw", "restore"]);

/**
 * How fast the stationary modes act at full weight, per dab: grow / shrink move a node by this part of its distance
 * from the centre, swirl turns by these degrees, restore takes this part of D away. Looks, set by eye.
 */
export const LIQUIFY_RATES = Object.freeze({ grow: 0.04, swirl: 3, restore: 0.15 });

/** A bake's gathered block at most this many pixels (4 MB); a region whose source box is larger is split in four. */
export const LIQUIFY_BLOCK_MAX = 1 << 20;

/** The grid step of a picture of w x h: 1 px up to 4 MP, 2 up to 16 MP, 4 up to 256 MP, 8 above. */
export function gridStep(w, h) {
    const px = w * h;
    return px <= 4 * 1048576 ? 1 : px <= 16 * 1048576 ? 2 : px <= 256 * 1048576 ? 4 : 8;
}

/**
 * The brush's falloff at t = distance / radius: 1 inside the hard core (t <= h), then (1 - u^2)^2 with u = (t - h) /
 * (1 - h), 0 from t = 1 on. Smooth at the rim; its steepest slope is 1.54 / (1 - h) per radius.
 */
export function liquifyFalloff(t, h) {
    if (!(t < 1)) return 0;
    if (t <= h) return 1;
    const u = (t - h) / (1 - h), v = 1 - u * u;
    return v * v;
}

const clampD = (v) => (v > LIQUIFY_MAX ? LIQUIFY_MAX : v < -LIQUIFY_MAX ? -LIQUIFY_MAX : v);

/**
 * A reader of the field in doubles: `sample(x, y, out)` puts D at the pixel-index position (x, y) (continuous; bilinear
 * between the nodes, the edge nodes repeated beyond the grid) into out[0], out[1] in 1/256 px; `at(i, j, c)` is a
 * node's component (0 beyond the grid). It keeps the last cell it looked up, so a walk along a row costs a Map lookup
 * per cell, not per node. The edge repeats because a dab's advection reads there when it moves a border node to read
 * from outside the layer: a D falling to 0 over one grid step outside squashed the map there and folded the picture
 * along the layer's edge (tools/liquify_test.js).
 */
export function fieldReader(field) {
    const { s, cells } = field, sh = 8 - field.ls, m = field.n - 1, n = field.n, xmax = field.ni * s, ymax = field.nj * s;
    let lk = -1, lc = null;
    const at = (i, j, c) => {
        if (i < 0 || j < 0) return 0;
        const key = ((j >> sh) << 16) | (i >> sh);
        if (key !== lk) { lk = key; lc = cells.get(key) || null; }
        return lc ? lc[((j & m) * n + (i & m)) * 2 + c] : 0;
    };
    const sample = (x, y, out) => {
        x = x < 0 ? 0 : x > xmax ? xmax : x;
        y = y < 0 ? 0 : y > ymax ? ymax : y;
        const gx = x / s, gy = y / s, i = Math.floor(gx), j = Math.floor(gy);
        const fx = gx - i, fy = gy - j, ex = 1 - fx, ey = 1 - fy;
        out[0] = ex * ey * at(i, j, 0) + fx * ey * at(i + 1, j, 0) + ex * fy * at(i, j + 1, 0) + fx * fy * at(i + 1, j + 1, 0);
        out[1] = ex * ey * at(i, j, 1) + fx * ey * at(i + 1, j, 1) + ex * fy * at(i, j + 1, 1) + fx * fy * at(i + 1, j + 1, 1);
        return out;
    };
    return { at, sample, reset: () => { lk = -1; lc = null; } };
}

/**
 * The displacement field of one layer of w x h pixels at grid step s (see the contract at the top). `cells` may be
 * given (an undo step's map); nothing here writes into a cell `before` holds.
 */
export class LiquifyField {
    constructor(w, h, s, cells = null) {
        if (!(s in LOG2)) throw new Error(`Inpaint Canvas: no liquify grid step ${s}`);
        this.w = w; this.h = h; this.s = s;
        this.ls = LOG2[s];
        this.n = TILE >> this.ls;                    // nodes a cell holds on a side
        this.ni = ((w - 1) >> this.ls) + 1;          // the last node a pixel reads, on each axis
        this.nj = ((h - 1) >> this.ls) + 1;
        this.cells = cells || new Map();
    }

    /** A field over the same cells (they are never written in place once shared). */
    copy() { return new LiquifyField(this.w, this.h, this.s, new Map(this.cells)); }

    get empty() { return this.cells.size === 0; }

    /** The node (i, j) as [dx, dy] in 1/256 px. */
    node(i, j) {
        const r = fieldReader(this);
        return [r.at(i, j, 0), r.at(i, j, 1)];
    }

    /** The nodes (i0.., j0..), nw x nh, as one dense Int32Array (dx, dy interleaved), zero where no cell holds them. */
    nodes(i0, j0, nw, nh) {
        const a = new Int32Array(nw * nh * 2), n = this.n, sh = 8 - this.ls;
        const cx0 = Math.max(0, i0 >> sh), cx1 = (i0 + nw - 1) >> sh, cy0 = Math.max(0, j0 >> sh), cy1 = (j0 + nh - 1) >> sh;
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const c = this.cells.get((cy << 16) | cx);
                if (!c) continue;
                const a0 = Math.max(i0, cx * n), a1 = Math.min(i0 + nw, cx * n + n);
                const b0 = Math.max(j0, cy * n), b1 = Math.min(j0 + nh, cy * n + n);
                for (let j = b0; j < b1; j++) {
                    const so = ((j - cy * n) * n + (a0 - cx * n)) * 2;
                    a.set(c.subarray(so, so + (a1 - a0) * 2), ((j - j0) * nw + (a0 - i0)) * 2);
                }
            }
        }
        return a;
    }

    /** The nodes output tile (tx, ty) reads: (n + 1)^2 from node (tx n, ty n); null when they are all zero. */
    tileNodes(tx, ty) {
        const c = this.cells;
        if (!c.has((ty << 16) | tx) && !c.has((ty << 16) | (tx + 1)) && !c.has(((ty + 1) << 16) | tx) && !c.has(((ty + 1) << 16) | (tx + 1))) return null;
        const a = this.nodes(tx * this.n, ty * this.n, this.n + 1, this.n + 1);
        for (let q = 0; q < a.length; q++) if (a[q]) return a;
        return null;
    }

    /** The largest |dx| or |dy| of any node, in px (for the preview's reach). */
    maxReach() {
        let m = 0;
        for (const c of this.cells.values()) for (let q = 0; q < c.length; q++) { const v = c[q] < 0 ? -c[q] : c[q]; if (v > m) m = v; }
        return m / 256;
    }

    /** Cell `key` made writable: new when missing, a copy when `before` still holds it. */
    _writable(key, before) {
        let c = this.cells.get(key);
        if (!c) { c = new Int32Array(this.n * this.n * 2); this.cells.set(key, c); }
        else if (before && before.get(key) === c) { c = c.slice(); this.cells.set(key, c); }
        return c;
    }

    /** Write the nodes a dab computed (`list`: i, j, dx, dy, ...) and drop the cells that came back to zero. */
    _write(list, count, before, prune) {
        const n = this.n, m = n - 1, sh = 8 - this.ls;
        let lk = -1, lc = null;
        const touched = prune ? new Set() : null;
        for (let q = 0; q < count; q++) {
            const i = list[q * 4], j = list[q * 4 + 1];
            const key = ((j >> sh) << 16) | (i >> sh);
            if (key !== lk) { lk = key; lc = this._writable(key, before); if (touched) touched.add(key); }
            const o = ((j & m) * n + (i & m)) * 2;
            lc[o] = list[q * 4 + 2]; lc[o + 1] = list[q * 4 + 3];
        }
        if (touched) {
            for (const key of touched) {
                const c = this.cells.get(key);
                let zero = true;
                for (let q = 0; q < c.length && zero; q++) if (c[q]) zero = false;
                if (zero) this.cells.delete(key);
            }
        }
    }

    /** The pixels [x0, y0, x1, y1) whose output the nodes i0..i1, j0..j1 (inclusive) reach. */
    _pixelBox(i0, j0, i1, j1) {
        const s = this.s;
        return [Math.max(0, (i0 - 1) * s + 1), Math.max(0, (j0 - 1) * s + 1), Math.min(this.w, (i1 + 1) * s), Math.min(this.h, (j1 + 1) * s)];
    }

    /**
     * One dab: `mode` one of LIQUIFY_MODES, centre (cx, cy) and radius r in pixel-index positions of the layer, `hard`
     * the falloff's flat core (clamped to 0..0.8), `amount` the strength times the pressure (0..1), `delta` [dx, dy] the
     * push's step (px; push only), `thaw(i, j)` 0..1 per node or null (the selection), `before` the cells at the
     * stroke's press. Returns the pixels [x0, y0, x1, y1) whose output may have changed, or null when no node did.
     *
     *   push       n = -w delta                          (the content under the brush follows the pointer)
     *   grow       n = -w 0.04 (q - c)                   (reads nearer the centre: the content swells)
     *   shrink     n = +w 0.04 (q - c)
     *   swirlcw    n = R(-w 3 deg)(q - c) - (q - c)      (the content turns clockwise on the screen, y down)
     *   swirlccw   n = R(+w 3 deg)(q - c) - (q - c)
     *   restore    D' = trunc((1 - w 0.15) D)            (not advected; truncated towards 0, so it reaches 0)
     *
     * w = amount * falloff(|q - c| / r) * thaw; the advected modes store floor(256 n + D(q + n) + 0.5).
     */
    dab(mode, cx, cy, r, hard, amount, delta, thaw, before) {
        const s = this.s, h = Math.min(0.8, Math.max(0, hard || 0));
        if (!(r > 0) || !(amount > 0)) return null;
        const i0 = Math.max(0, Math.ceil((cx - r) / s)), i1 = Math.min(this.ni, Math.floor((cx + r) / s));
        const j0 = Math.max(0, Math.ceil((cy - r) / s)), j1 = Math.min(this.nj, Math.floor((cy + r) / s));
        if (i1 < i0 || j1 < j0) return null;
        const restore = mode === "restore", push = mode === "push";
        const grow = mode === "grow" ? -1 : mode === "shrink" ? 1 : 0;
        const turn = mode === "swirlcw" ? -1 : mode === "swirlccw" ? 1 : 0;
        if (!restore && !push && !grow && !turn) throw new Error(`Inpaint Canvas: no liquify mode "${mode}"`);
        if (push && !(delta && (delta[0] || delta[1]))) return null;
        const rd = this.reader || (this.reader = fieldReader(this));
        rd.reset();
        const list = new Float64Array((i1 - i0 + 1) * (j1 - j0 + 1) * 4);
        const D = [0, 0];
        let count = 0, bi0 = Infinity, bj0 = Infinity, bi1 = -Infinity, bj1 = -Infinity;
        for (let j = j0; j <= j1; j++) {
            const dy = j * s - cy;
            for (let i = i0; i <= i1; i++) {
                const dx = i * s - cx;
                const t = Math.sqrt(dx * dx + dy * dy) / r;
                if (!(t < 1)) continue;
                let w = amount * liquifyFalloff(t, h);
                if (thaw && w > 0) w *= thaw(i, j);
                if (!(w > 0)) continue;
                const ox = rd.at(i, j, 0), oy = rd.at(i, j, 1);
                let vx, vy;
                if (restore) {
                    const f = 1 - w * LIQUIFY_RATES.restore;
                    vx = Math.trunc(ox * f); vy = Math.trunc(oy * f);
                } else {
                    let nx, ny;
                    if (push) { nx = -w * delta[0]; ny = -w * delta[1]; }
                    else if (grow) { const g = grow * w * LIQUIFY_RATES.grow; nx = g * dx; ny = g * dy; }
                    else {
                        const a = turn * w * LIQUIFY_RATES.swirl * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
                        nx = dx * c - dy * sn - dx; ny = dx * sn + dy * c - dy;
                    }
                    rd.sample(i * s + nx, j * s + ny, D);
                    vx = clampD(Math.floor(nx * 256 + D[0] + 0.5)); vy = clampD(Math.floor(ny * 256 + D[1] + 0.5));
                }
                if (vx === ox && vy === oy) continue;
                list[count * 4] = i; list[count * 4 + 1] = j; list[count * 4 + 2] = vx; list[count * 4 + 3] = vy;
                count++;
                if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
            }
        }
        if (!count) return null;
        this._write(list, count, before, restore);
        return this._pixelBox(bi0, bj0, bi1, bj1);
    }

    /**
     * Restore all: every node scaled by (1 - thaw), truncated towards 0 (so 0 wherever nothing holds it back); without
     * `thaw` the field is emptied. Returns the pixels whose output may have changed, or null.
     */
    restoreAll(thaw, before) {
        if (!this.cells.size) return null;
        if (!thaw) {
            let bi0 = Infinity, bj0 = Infinity, bi1 = -Infinity, bj1 = -Infinity;
            for (const key of this.cells.keys()) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                bi0 = Math.min(bi0, tx * this.n); bj0 = Math.min(bj0, ty * this.n);
                bi1 = Math.max(bi1, tx * this.n + this.n - 1); bj1 = Math.max(bj1, ty * this.n + this.n - 1);
            }
            this.cells.clear();
            return this._pixelBox(bi0, bj0, bi1, bj1);
        }
        const n = this.n, list = [];
        let bi0 = Infinity, bj0 = Infinity, bi1 = -Infinity, bj1 = -Infinity;
        for (const [key, c] of this.cells) {
            const tx = key & 0xFFFF, ty = key >>> 16;
            for (let q = 0; q < n * n; q++) {
                const ox = c[q * 2], oy = c[q * 2 + 1];
                if (!ox && !oy) continue;
                const i = tx * n + (q % n), j = ty * n + ((q / n) | 0);
                const f = 1 - Math.min(1, Math.max(0, thaw(i, j)));
                const vx = Math.trunc(ox * f), vy = Math.trunc(oy * f);
                if (vx === ox && vy === oy) continue;
                list.push(i, j, vx, vy);
                if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j;
            }
        }
        if (!list.length) return null;
        this._write(list, list.length / 4, before, true);
        return this._pixelBox(bi0, bj0, bi1, bj1);
    }

    /** Drop the cells written since `before` that came back to all zero (a dab prunes only in restore: this runs once a stroke). */
    prune(before) {
        for (const [key, c] of this.cells) {
            if (before && before.get(key) === c) continue;
            let zero = true;
            for (let q = 0; q < c.length && zero; q++) if (c[q]) zero = false;
            if (zero) this.cells.delete(key);
        }
    }

    /**
     * The output tiles a change of the cells since `before` reaches, as keys (ty << 16) | tx inside tw x th tiles: every
     * cell that is not the one `before` holds (written, made or dropped), and its left, upper and upper-left neighbour
     * tiles (their last pixel column and row interpolate towards its first nodes).
     */
    changedTiles(before, tw, th) {
        const out = new Set();
        const add = (key) => {
            const tx = key & 0xFFFF, ty = key >>> 16;
            for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
                const x = tx - a, y = ty - b;
                if (x >= 0 && y >= 0 && x < tw && y < th) out.add((y << 16) | x);
            }
        };
        for (const [key, c] of this.cells) if (!before || before.get(key) !== c) add(key);
        if (before) for (const key of before.keys()) if (!this.cells.has(key)) add(key);
        return out;
    }
}

// ---- the bake ------------------------------------------------------------------------------------------------

function blockOpaque(block, n) {
    for (let q = 3, e = n * 4; q < e; q += 4) if (block[q] !== 255) return false;
    return true;
}

/**
 * The kernel: output pixels X0.., Y0.. (vw x vh, layer pixels) from `block` (bw x bh straight RGBA at bx, by), through
 * the dense nodes `nodes` (nw a row, from node (nx0, ny0); they must hold node (X >> log2 s) + 1 of every pixel), written
 * to `out` at `off` with `stride` bytes a row. `rt` the canvas round trip or null. Returns how many pixels came out with
 * an alpha above 0.
 */
export function liquifyBlock(block, bw, bh, bx, by, nodes, nw, nx0, ny0, s, rt, out, off, stride, X0, Y0, vw, vh) {
    const ls = LOG2[s], k = 8 + 2 * ls, kp = k - 8, sm = s - 1, row = bw * 4;
    const maxX = bw - TAPS, maxY = bh - TAPS;
    const opaque = blockOpaque(block, bw * bh);
    let count = 0;
    for (let j = 0; j < vh; j++) {
        const Y = Y0 + j, fy = Y & sm, gy = s - fy;
        const r0 = ((Y >> ls) - ny0) * nw * 2 - nx0 * 2, r1 = r0 + nw * 2;
        const yk = Y << k;
        let o = off + j * stride;
        for (let i = 0; i < vw; i++, o += 4) {
            const X = X0 + i, fx = X & sm, gx = s - fx;
            const a = r0 + (X >> ls) * 2, b = r1 + (X >> ls) * 2;
            const w00 = gx * gy, w10 = fx * gy, w01 = gx * fy, w11 = fx * fy;
            const SX = (X << k) + w00 * nodes[a] + w10 * nodes[a + 2] + w01 * nodes[b] + w11 * nodes[b + 2];
            const SY = yk + w00 * nodes[a + 1] + w10 * nodes[a + 3] + w01 * nodes[b + 1] + w11 * nodes[b + 3];
            const px = (SX >> kp) & 255, py = (SY >> kp) & 255;
            if (!px && !py) {
                // on a whole pixel: its bytes as they are
                let cx = (SX >> k) - bx, cy = (SY >> k) - by;
                if (cx < 0) cx = 0; else if (cx >= bw) cx = bw - 1;
                if (cy < 0) cy = 0; else if (cy >= bh) cy = bh - 1;
                const q = (cy * bw + cx) * 4;
                out[o] = block[q]; out[o + 1] = block[q + 1]; out[o + 2] = block[q + 2]; out[o + 3] = block[q + 3];
                if (block[q + 3]) count++;
                continue;
            }
            let cx = (SX >> k) - LEAD - bx, cy = (SY >> k) - LEAD - by;
            // inside by construction (the block is the region's source box); clamped so a caller's mistake cannot read outside
            if (cx < 0) cx = 0; else if (cx > maxX) cx = maxX;
            if (cy < 0) cy = 0; else if (cy > maxY) cy = maxY;
            const wx = px * TAPS, wy = py * TAPS;
            let p = (cy * bw + cx) * 4;
            if (opaque) {
                // resampleOpaque's arithmetic: every alpha is 255, so the colour needs no alpha in its sums
                let SR = 0, SG = 0, SB = 0;
                for (let r = 0; r < TAPS; r++, p += row) {
                    let rr = 0, rg = 0, rb = 0;
                    for (let t = 0, q = p; t < TAPS; t++, q += 4) {
                        const w = TABLE[wx + t];
                        rr += w * block[q]; rg += w * block[q + 1]; rb += w * block[q + 2];
                    }
                    const w = TABLE[wy + r];
                    SR += w * rr; SG += w * rg; SB += w * rb;
                }
                const cr = Math.floor((SR + HALF28) / ONE28), cg = Math.floor((SG + HALF28) / ONE28), cb = Math.floor((SB + HALF28) / ONE28);
                out[o] = cr < 0 ? 0 : cr > 255 ? 255 : cr;
                out[o + 1] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
                out[o + 2] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
                out[o + 3] = 255;
                count++;
                continue;
            }
            // resampleBlock's arithmetic: alpha interpolated as premultiplied
            let SA = 0, SR = 0, SG = 0, SB = 0;
            for (let r = 0; r < TAPS; r++, p += row) {
                let ra = 0, rr = 0, rg = 0, rb = 0;
                for (let t = 0, q = p; t < TAPS; t++, q += 4) {
                    const al = block[q + 3];
                    if (!al) continue;
                    const wa = TABLE[wx + t] * al;
                    ra += wa; rr += wa * block[q]; rg += wa * block[q + 1]; rb += wa * block[q + 2];
                }
                const w = TABLE[wy + r];
                SA += w * ra; SR += w * rr; SG += w * rg; SB += w * rb;
            }
            let al = Math.floor((SA + HALF28) / ONE28);
            if (al <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
            if (al > 255) al = 255;
            count++;
            const d = 2 * SA;
            let cr = Math.floor((2 * SR + SA) / d), cg = Math.floor((2 * SG + SA) / d), cb = Math.floor((2 * SB + SA) / d);
            cr = cr < 0 ? 0 : cr > 255 ? 255 : cr;
            cg = cg < 0 ? 0 : cg > 255 ? 255 : cg;
            cb = cb < 0 ? 0 : cb > 255 ? 255 : cb;
            if (rt && al < 255) { const tt = al << 8; cr = rt[tt | cr]; cg = rt[tt | cg]; cb = rt[tt | cb]; }
            out[o] = cr; out[o + 1] = cg; out[o + 2] = cb; out[o + 3] = al;
        }
    }
    return count;
}

let SCRATCH = new Uint8Array(0);

function scratchOf(bytes) {
    if (SCRATCH.length < bytes) SCRATCH = new Uint8Array(Math.max(bytes, SCRATCH.length * 2));
    return SCRATCH;
}

/**
 * The source box [x0, y0, x1, y1) (exclusive) the taps of the pixels rx0..rx1, ry0..ry1 read, from the nodes of their
 * tile (`nodes`, nw a row, from node (nx0, ny0)): the field is a convex sum of its nodes, so the least and the largest
 * node of the region bound every pixel's tap.
 */
export function liquifyBox(nodes, nw, nx0, ny0, ls, rx0, ry0, rx1, ry1) {
    const a0 = (rx0 >> ls) - nx0, a1 = ((rx1 - 1) >> ls) + 1 - nx0;
    const b0 = (ry0 >> ls) - ny0, b1 = ((ry1 - 1) >> ls) + 1 - ny0;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let b = b0; b <= b1; b++) {
        for (let a = a0, q = (b * nw + a0) * 2; a <= a1; a++, q += 2) {
            const x = nodes[q], y = nodes[q + 1];
            if (x < mnx) mnx = x; if (x > mxx) mxx = x;
            if (y < mny) mny = y; if (y > mxy) mxy = y;
        }
    }
    return [(((rx0 << 8) + mnx) >> 8) - LEAD, (((ry0 << 8) + mny) >> 8) - LEAD,
        ((((rx1 - 1) << 8) + mxx) >> 8) - LEAD + TAPS, ((((ry1 - 1) << 8) + mxy) >> 8) - LEAD + TAPS];
}

/**
 * The output tiles `keys` ([tx, ty]) of a layer through a field, from its source:
 * `src = { width, height, copyRun(sy, sx0, sx1, dst, off), has(x0, y0, x1, y1) }` (resampleStore's), `s` the grid step,
 * `nodesOf(tx, ty)` the dense nodes of a tile ((256 / s + 1)^2, `LiquifyField.tileNodes`) or null when they are all
 * zero, `clamp` the edge rule, `rt` the round trip or null, `target = { share(tx, ty), tile(tx, ty, vw, vh) -> [out, off,
 * stride], done(tx, ty, count) }`: `share` for a tile whose nodes are all zero (the source's own tile is the output),
 * else the kernel writes every pixel of its valid part and `done` gets the count of pixels above alpha 0. A region whose
 * source box holds more than `blockMax` pixels is split in four (a field that compresses reads a wide span): the same
 * bytes, as every pixel reads the same taps. Returns { blocks, splits, maxBlock }.
 */
export function liquifyStore(src, s, nodesOf, keys, clamp, rt, target, blockMax = LIQUIFY_BLOCK_MAX, kernel = liquifyBlock) {
    const ls = LOG2[s], n = TILE >> ls, nw = n + 1;
    const W = src.width, H = src.height;
    const stats = { blocks: 0, splits: 0, maxBlock: 0 };
    const lim = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    for (const [tx, ty] of keys) {
        const X0 = tx * TILE, Y0 = ty * TILE;
        const vw = Math.min(TILE, W - X0), vh = Math.min(TILE, H - Y0);
        if (vw <= 0 || vh <= 0) continue;
        const nodes = nodesOf(tx, ty);
        if (!nodes) { target.share(tx, ty); continue; }
        const [out, off, stride] = target.tile(tx, ty, vw, vh);
        const nx0 = tx * n, ny0 = ty * n;
        let count = 0;
        const region = (rx0, ry0, rx1, ry1) => {
            const box = liquifyBox(nodes, nw, nx0, ny0, ls, rx0, ry0, rx1, ry1);
            const bw = box[2] - box[0], bh = box[3] - box[1];
            if (bw * bh > blockMax && (rx1 - rx0 > 1 || ry1 - ry0 > 1)) {
                stats.splits++;
                const mx = rx1 - rx0 > 1 ? (rx0 + rx1) >> 1 : rx1, my = ry1 - ry0 > 1 ? (ry0 + ry1) >> 1 : ry1;
                region(rx0, ry0, mx, my);
                if (mx < rx1) region(mx, ry0, rx1, my);
                if (my < ry1) region(rx0, my, mx, ry1);
                if (mx < rx1 && my < ry1) region(mx, my, rx1, ry1);
                return;
            }
            const o = off + (ry0 - Y0) * stride + (rx0 - X0) * 4;
            // the part of the box inside the source (for clamp: the edge pixels it repeats); none: transparent
            const inside = clamp
                ? [lim(box[0], W - 1), lim(box[1], H - 1), lim(box[2] - 1, W - 1) + 1, lim(box[3] - 1, H - 1) + 1]
                : [Math.max(box[0], 0), Math.max(box[1], 0), Math.min(box[2], W), Math.min(box[3], H)];
            if (inside[2] <= inside[0] || inside[3] <= inside[1] || !src.has(...inside)) {
                for (let y = 0; y < ry1 - ry0; y++) out.fill(0, o + y * stride, o + y * stride + (rx1 - rx0) * 4);
                return;
            }
            const block = scratchOf(bw * bh * 4);
            gather(src.copyRun, box, W, H, clamp, block);
            stats.blocks++;
            if (bw * bh > stats.maxBlock) stats.maxBlock = bw * bh;
            count += kernel(block, bw, bh, box[0], box[1], nodes, nw, nx0, ny0, s, rt, out, o, stride, rx0, ry0, rx1 - rx0, ry1 - ry0);
        };
        region(X0, Y0, X0 + vw, Y0 + vh);
        target.done(tx, ty, count);
    }
    return stats;
}

// ---- the preview ---------------------------------------------------------------------------------------------

/**
 * The displaced layer as a view shows it, for the live stroke (bilinear, premultiplied; a preview, not the bake's bytes:
 * the geometry is the same field). `win = { data, w, h, x0, y0, L }` is the source at level L (straight RGBA, w x h; its
 * pixel (a, b) covers layer pixels ((x0 + a) 2^L, (y0 + b) 2^L) and the 2^L after them), read with its edge clamped.
 * `out` (RGBA bytes, bw x bh) gets the view's pixels whose centres lie at layer positions (ox + (i + 0.5) inv, oy + (j +
 * 0.5) inv) (continuous: pixel corners at integers). Positions outside the layer are transparent.
 */
export function previewBlock(win, field, ox, oy, inv, out, bw, bh) {
    const rd = fieldReader(field);
    const D = [0, 0], L2 = 1 << win.L, data = win.data, ww = win.w, wh = win.h;
    const W = field.w, H = field.h;
    for (let j = 0; j < bh; j++) {
        const cy = oy + (j + 0.5) * inv;
        let o = j * bw * 4;
        for (let i = 0; i < bw; i++, o += 4) {
            const cx = ox + (i + 0.5) * inv;
            if (cx < 0 || cy < 0 || cx >= W || cy >= H) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
            rd.sample(cx - 0.5, cy - 0.5, D);
            // the source position in the window's pixels (pixel-index positions at level L)
            const sx = (cx + D[0] / 256) / L2 - 0.5 - win.x0, sy = (cy + D[1] / 256) / L2 - 0.5 - win.y0;
            let x0 = Math.floor(sx), y0 = Math.floor(sy);
            const fx = sx - x0, fy = sy - y0;
            let x1 = x0 + 1, y1 = y0 + 1;
            x0 = x0 < 0 ? 0 : x0 >= ww ? ww - 1 : x0; x1 = x1 < 0 ? 0 : x1 >= ww ? ww - 1 : x1;
            y0 = y0 < 0 ? 0 : y0 >= wh ? wh - 1 : y0; y1 = y1 < 0 ? 0 : y1 >= wh ? wh - 1 : y1;
            const q00 = (y0 * ww + x0) * 4, q10 = (y0 * ww + x1) * 4, q01 = (y1 * ww + x0) * 4, q11 = (y1 * ww + x1) * 4;
            const w00 = (1 - fx) * (1 - fy) * data[q00 + 3], w10 = fx * (1 - fy) * data[q10 + 3];
            const w01 = (1 - fx) * fy * data[q01 + 3], w11 = fx * fy * data[q11 + 3];
            const A = w00 + w10 + w01 + w11;
            if (A < 0.5) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
            // rounded here (`| 0` of x + 0.5, every value within 0..255.5): `out` may be a clamped array, which rounds again
            out[o] = ((w00 * data[q00] + w10 * data[q10] + w01 * data[q01] + w11 * data[q11]) / A + 0.5) | 0;
            out[o + 1] = ((w00 * data[q00 + 1] + w10 * data[q10 + 1] + w01 * data[q01 + 1] + w11 * data[q11 + 1]) / A + 0.5) | 0;
            out[o + 2] = ((w00 * data[q00 + 2] + w10 * data[q10 + 2] + w01 * data[q01 + 2] + w11 * data[q11 + 2]) / A + 0.5) | 0;
            out[o + 3] = (A + 0.5) | 0;
        }
    }
}
