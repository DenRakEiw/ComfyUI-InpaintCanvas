// Generated from DenRakEiw/scumble renderer/editor/inpaint_boxstack.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * A box of the picture composited from the tiles, here on the main thread and at once (docs/PLAN_0_1_31.md §4 step 2):
 * what a brush that samples the picture reads under its dab. The workers composite whole bands of a held stack for the
 * exports and the flood (`stackRows`, `rowsOfStack` in inpaint_worker.js); a brush needs a few hundred pixels of the
 * picture per pointer move and cannot wait for a job, so this is the same composite for one box, synchronous, from the
 * stores themselves: the tiles' bytes copied into a buffer per store, a colour-matched layer matched on its copy, a
 * mask's alpha, and one `compositeTile` over them (Rust SIMD in the window too; about 1 ms per megapixel per layer,
 * docs/PERFORMANCE.md). Nothing here grows with the document, and nothing touches a canvas.
 *
 * A stack is `stackPlan`'s: `[base | null, ...layers]`, each `{ px, mask, x, y, alpha, op, match }`, `px` and `mask`
 * tile pixels of the same size (the mask on the layer's grid, alpha = shown), `op` the kernel's blend number, `match`
 * the ten floats of a colour match (meanS, meanT, scale, k) or null. The worker's reading of such a stack is the model:
 * a store with no tile in the box adds nothing, a layer whose mask has no tile there shows nothing, a layer at alpha 0
 * is left out.
 */
import { compositeTile, matchPixels } from "./px/kernels.js";
import { clipCoverage } from "./inpaint_raster.js";
import { hash32, mul255 } from "./blend_modes.js";

const TILE = 256;

// Buffers kept between reads (a brush reads a box of about the same size on every move); larger ones are made per read
// and dropped, so a 2,000 px dab does not keep 16 MB a layer
const KEEP_BYTES = 4 * 1024 * 1024;
let pool = [];

function buffer(i, bytes) {
    if (bytes > KEEP_BYTES) return new Uint8Array(bytes);
    let b = pool[i];
    if (!b || b.length < bytes) b = pool[i] = new Uint8Array(Math.max(bytes, b ? b.length : 0));
    const v = b.subarray(0, bytes);
    v.fill(0);
    return v;
}

/** The buffers kept between reads are given back (a tab closed, the caches released). */
export function releaseBoxBuffers() { pool = []; }

/**
 * The bytes of one store (tile pixels `px` at (`sx`, `sy`) of the image) inside the box `X0, Y0, W, H` into `out`
 * (RGBA8, `W` wide, cleared), or with `alphaOnly` one byte a pixel, the alpha; only inside the picture (0, 0, `pw`, `ph`):
 * a layer moved partly off the canvas keeps pixels there, which the picture does not show. False when no tile of the store
 * lies there.
 */
export function storeBox(px, sx, sy, X0, Y0, W, H, out, alphaOnly = false, pw = Infinity, ph = Infinity) {
    const x0 = Math.max(X0, sx, 0), y0 = Math.max(Y0, sy, 0), x1 = Math.min(X0 + W, sx + px.width, pw), y1 = Math.min(Y0 + H, sy + px.height, ph);
    if (y1 <= y0 || x1 <= x0) return false;
    let any = false;
    for (let lty = (y0 - sy) >> 8; lty * TILE < y1 - sy; lty++) {
        const ry0 = Math.max(y0, sy + lty * TILE), ry1 = Math.min(y1, sy + (lty + 1) * TILE);
        for (let ltx = (x0 - sx) >> 8; ltx * TILE < x1 - sx; ltx++) {
            const t = px.tileAt(ltx, lty);
            if (!t) continue;
            const bytes = t.data;
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
 * The composite of `stack` over the box (`X0`, `Y0`, `W` x `H`, whole image pixels; it may reach outside the picture
 * `pw` x `ph`, which stays transparent there, whatever a layer holds beyond its edge): RGBA8, `W * H * 4` bytes, a view on a buffer the next call reuses unless the box is
 * large. `rowsOfStack` of inpaint_worker.js does the same for a band of held clones.
 */
export function compositeBox(stack, X0, Y0, W, H, pw = Infinity, ph = Infinity) {
    const n = W * H;
    const dst = buffer(0, n * 4);
    const [base, ...layers] = stack;
    if (base) storeBox(base.px, base.x | 0, base.y | 0, X0, Y0, W, H, dst, false, pw, ph);
    const srcs = [], alphas = [], masks = [], ops = [];
    let slot = 1;
    for (const l of layers) {
        if (!l || !(l.alpha > 0)) continue;
        const src = buffer(slot, n * 4);
        if (!storeBox(l.px, l.x | 0, l.y | 0, X0, Y0, W, H, src, false, pw, ph)) continue;
        slot++;
        if (l.match) matchPixels(src, l.match);
        let mask = null;
        if (l.mask) { mask = buffer(slot++, n); storeBox(l.mask, l.x | 0, l.y | 0, X0, Y0, W, H, mask, true, pw, ph); }
        if (l.clip) {
            // clipped (PLAN_0_1_31 §6 step 3): `clip` is the base's entry; where the base has no tile the layer shows nothing
            const c = l.clip, cov = buffer(slot++, n);
            if (!(c.alpha > 0) || !storeBox(c.px, c.x | 0, c.y | 0, X0, Y0, W, H, cov, true, pw, ph)) { slot--; continue; }
            let bm = null;
            if (c.mask) { bm = buffer(slot++, n); storeBox(c.mask, c.x | 0, c.y | 0, X0, Y0, W, H, bm, true, pw, ph); }
            mask = clipCoverage(cov, bm, c.alpha, mask);
        }
        if (l.dissolve != null) {
            for (let y = 0; y < H; y++) {
                const imgY = Y0 + y;
                for (let x = 0; x < W; x++) {
                    const imgX = X0 + x;
                    const o = y * W + x;
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
    if (srcs.length) compositeTile(dst, srcs, ops, alphas, masks);
    return dst;
}
