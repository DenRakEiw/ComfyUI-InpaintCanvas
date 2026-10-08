// Generated from DenRakEiw/scumble renderer/editor/inpaint_remove.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Remove (docs/PLAN_0_1_31.md §5 step 3): the geometry and the pixel moves around the in-app LaMa model, which takes a
// fixed 512 x 512 picture and mask and answers 512 x 512. The editor reads the picture under a crop box around the hole,
// this module scales the picture and the hole to the model's size and samples the model's answer back at the hole's
// pixels. Plain functions over byte arrays (no canvas, no DOM): tools/remove_test.js runs them under Node.

export const REMOVE_SIZE = 512;

/**
 * The crop box around a hole ([x0, y0, x1, y1], image pixels): square, at least `size` a side (a small spot is filled at
 * the picture's own resolution) and `context` times the hole's longer side (the model sees as much picture around the
 * hole as the hole is wide), centred on the hole, moved inside the picture, and cut to it along a side the picture is
 * shorter than. The hole always lies inside the box.
 */
export function removeCrop(hole, W, H, { size = REMOVE_SIZE, context = 2 } = {}) {
    const side = Math.max(size, Math.ceil(Math.max(hole[2] - hole[0], hole[3] - hole[1]) * context));
    const place = (a0, a1, n) => {
        const s = Math.min(side, n);
        const lo = Math.max(0, Math.min(n - s, Math.round((a0 + a1 - s) / 2)));
        return [lo, lo + s];
    };
    const [x0, x1] = place(hole[0], hole[2], W), [y0, y1] = place(hole[1], hole[3], H);
    return [x0, y0, x1, y1];
}

/**
 * Resampling weights from `nIn` samples to `nOut`: an area average where it shrinks (each input sample counts by the
 * part of it an output sample covers), a linear blend of the two nearest centres where it grows (edges clamped).
 * -> [{ i0, w: Float64Array }] per output sample, the weights summing to 1.
 */
export function resampleWeights(nIn, nOut) {
    const s = nIn / nOut, out = new Array(nOut);
    for (let o = 0; o < nOut; o++) {
        if (s >= 1) {
            const a = o * s, b = a + s, i0 = Math.floor(a), i1 = Math.min(nIn, Math.ceil(b - 1e-9));
            const w = new Float64Array(i1 - i0);
            for (let i = i0; i < i1; i++) w[i - i0] = Math.min(b, i + 1) - Math.max(a, i);
            let t = 0;
            for (let k = 0; k < w.length; k++) t += w[k];
            for (let k = 0; k < w.length; k++) w[k] /= t;
            out[o] = { i0, w };
        } else {
            const c = (o + 0.5) * s - 0.5, f0 = Math.floor(c), f = c - f0;
            const a = Math.max(0, Math.min(nIn - 1, f0)), b = Math.max(0, Math.min(nIn - 1, f0 + 1));
            out[o] = a === b ? { i0: a, w: Float64Array.of(1) } : { i0: a, w: Float64Array.of(1 - f, f) };
        }
    }
    return out;
}

/**
 * RGBA bytes of w x h to `size` x `size` (the model's input; alpha 255): rows first, then columns, through
 * `resampleWeights`. The colour bytes are taken as they are: a clear pixel's colour (0 in the stores) is black to the
 * model.
 */
export function toModelImage(src, w, h, size = REMOVE_SIZE) {
    const wx = resampleWeights(w, size), wy = resampleWeights(h, size);
    const rows = new Float32Array(h * size * 3);
    for (let y = 0; y < h; y++) {
        const row = y * w * 4, dst = y * size * 3;
        for (let o = 0; o < size; o++) {
            const { i0, w: k } = wx[o];
            let r = 0, g = 0, b = 0;
            for (let j = 0; j < k.length; j++) { const i = row + (i0 + j) * 4, q = k[j]; r += src[i] * q; g += src[i + 1] * q; b += src[i + 2] * q; }
            const d = dst + o * 3;
            rows[d] = r; rows[d + 1] = g; rows[d + 2] = b;
        }
    }
    const out = new Uint8Array(size * size * 4);
    for (let o = 0; o < size; o++) {
        const { i0, w: k } = wy[o];
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0;
            for (let j = 0; j < k.length; j++) { const i = ((i0 + j) * size + x) * 3, q = k[j]; r += rows[i] * q; g += rows[i + 1] * q; b += rows[i + 2] * q; }
            const d = (o * size + x) * 4;
            out[d] = Math.round(r); out[d + 1] = Math.round(g); out[d + 2] = Math.round(b); out[d + 3] = 255;
        }
    }
    return out;
}

/**
 * The hole (w x h bytes, not 0 = remove) to `size` x `size` for the model: an output pixel is hole where any input
 * pixel under it is, then the hole grows by `grow` output pixels (a square), so the model also repaints the rim of what
 * was brushed over (a soft edge, a shadow's fringe). -> Uint8Array(size * size), 0 or 255.
 */
export function toModelMask(hole, w, h, size = REMOVE_SIZE, grow = 3) {
    const spanOf = (nIn, o) => {
        const s = nIn / size;
        if (s >= 1) return [Math.floor(o * s), Math.min(nIn, Math.ceil((o + 1) * s - 1e-9))];
        const i = Math.min(nIn - 1, Math.floor((o + 0.5) * s));
        return [i, i + 1];
    };
    // rows: any hole pixel of the input row under each output column
    const xs = [], ys = [];
    for (let o = 0; o < size; o++) { xs.push(spanOf(w, o)); ys.push(spanOf(h, o)); }
    const rowHit = new Uint8Array(h * size);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let o = 0; o < size; o++) {
            const [a, b] = xs[o];
            for (let x = a; x < b; x++) if (hole[row + x]) { rowHit[y * size + o] = 1; break; }
        }
    }
    let m = new Uint8Array(size * size);
    for (let o = 0; o < size; o++) {
        const [a, b] = ys[o];
        for (let x = 0; x < size; x++) {
            for (let y = a; y < b; y++) if (rowHit[y * size + x]) { m[o * size + x] = 255; break; }
        }
    }
    // the growth, as two passes of a running window (a square of 2 grow + 1)
    for (let pass = 0; pass < 2 && grow > 0; pass++) {
        const next = new Uint8Array(size * size);
        for (let a = 0; a < size; a++) {
            for (let b = 0; b < size; b++) {
                const lo = Math.max(0, b - grow), hi = Math.min(size - 1, b + grow);
                let on = 0;
                for (let c = lo; c <= hi && !on; c++) on = pass === 0 ? m[a * size + c] : m[c * size + a];
                if (on) { if (pass === 0) next[a * size + b] = 255; else next[b * size + a] = 255; }
            }
        }
        m = next;
    }
    return m;
}

/**
 * The model's answer (RGBA `size` x `size` over the crop `crop` [x0, y0, x1, y1]) sampled at the pixel centres of the box
 * `box` ({ x, y, w, h } image pixels, inside the crop), bilinear, where `mask` (w x h) is set: into `out` (RGBA w x h,
 * a new array when none is given); the pixels outside the mask stay as `out` holds them.
 */
export function fromModel(model, crop, box, mask, out = null, size = REMOVE_SIZE) {
    const cw = crop[2] - crop[0], ch = crop[3] - crop[1], sx = size / cw, sy = size / ch;
    const res = out || new Uint8Array(box.w * box.h * 4);
    for (let y = 0; y < box.h; y++) {
        const v = (box.y + y - crop[1] + 0.5) * sy - 0.5;
        const v0 = Math.floor(v), fv = v - v0, r0 = Math.max(0, Math.min(size - 1, v0)), r1 = Math.max(0, Math.min(size - 1, v0 + 1));
        for (let x = 0; x < box.w; x++) {
            const k = y * box.w + x;
            if (!mask[k]) continue;
            const u = (box.x + x - crop[0] + 0.5) * sx - 0.5;
            const u0 = Math.floor(u), fu = u - u0, c0 = Math.max(0, Math.min(size - 1, u0)), c1 = Math.max(0, Math.min(size - 1, u0 + 1));
            const i00 = (r0 * size + c0) * 4, i01 = (r0 * size + c1) * 4, i10 = (r1 * size + c0) * 4, i11 = (r1 * size + c1) * 4;
            for (let c = 0; c < 3; c++) {
                const top = model[i00 + c] * (1 - fu) + model[i01 + c] * fu, bot = model[i10 + c] * (1 - fu) + model[i11 + c] * fu;
                res[k * 4 + c] = Math.round(top * (1 - fv) + bot * fv);
            }
            res[k * 4 + 3] = 255;
        }
    }
    return res;
}
