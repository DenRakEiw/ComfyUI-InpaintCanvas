/**
 * Raster helpers shared by the editor's tools: flood fill / magic wand region
 * growing, colour parsing, mask-to-canvas. Pure functions on typed arrays, no
 * DOM state, kept out of inpaint_canvas.js so the tools stay small.
 */

/** A 2D canvas in the window or in a worker. */
export function makeRasterCanvas(w, h) {
    const width = Math.max(1, w | 0), height = Math.max(1, h | 0);
    if (typeof document === "undefined") return new OffscreenCanvas(width, height);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
}

/**
 * Exact euclidean distance transform (Felzenszwalb / Huttenlocher): squared distance of
 * every pixel to the nearest set pixel of `feature`. Grow and shrink of the selection use
 * it, in the editor and in the worker.
 */
export function distanceTransform(feature, W, H) {
    const INF = 1e20;
    const f = new Float32Array(Math.max(W, H));
    const d = new Float32Array(Math.max(W, H));
    const v = new Int32Array(Math.max(W, H));
    const z = new Float32Array(Math.max(W, H) + 1);
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = feature[i] ? 0 : INF;
    const edt1d = (n) => {
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < n; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    };
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) f[y] = out[y * W + x];
        edt1d(H);
        for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) f[x] = out[y * W + x];
        edt1d(W);
        for (let x = 0; x < W; x++) out[y * W + x] = d[x];
    }
    return out;
}

/** Bounding box of the selected pixels ([x0, y0, x1, y1], right and bottom exclusive), or null. */
export function maskBounds(d, W, H) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            if (d[(row + x) * 4 + 3] <= 127) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// one RGBA word of "red, fully transparent", whatever the platform's byte order is
const RED_CLEAR = (() => {
    const b = new Uint8Array(4);
    b[0] = 255; b[1] = 0; b[2] = 0; b[3] = 0;
    return new Uint32Array(b.buffer)[0];
})();

/**
 * The selection after growing (n > 0) or shrinking (n < 0) by n pixels, as RGBA bytes in
 * place: red where selected, transparent elsewhere, hard edges like Photoshop's Expand.
 * Only pixels within n of the selection's edge can change, so the distance transform runs
 * on its bounding box padded by n rather than on the whole image (3 s to under 1 s on a
 * 96 MP document with a selection covering a fifth of it).
 */
export function growMask(d, W, H, n) {
    const grow = n > 0;
    const r = Math.abs(n);
    const box = maskBounds(d, W, H);
    const words = new Uint32Array(d.buffer, d.byteOffset, W * H);
    if (!box) {
        words.fill(RED_CLEAR);   // nothing selected: nothing to grow, nothing left to shrink
        return d;
    }
    const pad = r + 2;
    const bx0 = Math.max(0, box[0] - pad), by0 = Math.max(0, box[1] - pad);
    const bx1 = Math.min(W, box[2] + pad), by1 = Math.min(H, box[3] + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    const feature = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        const src = (by0 + y) * W + bx0, dst = y * bw;
        for (let x = 0; x < bw; x++) {
            const sel = d[(src + x) * 4 + 3] > 127;
            feature[dst + x] = grow ? (sel ? 1 : 0) : (sel ? 0 : 1);
        }
    }
    const dist = distanceTransform(feature, bw, bh);
    const r2 = r * r;
    words.fill(RED_CLEAR);
    for (let y = 0; y < bh; y++) {
        const dst = (by0 + y) * W + bx0, row = y * bw;
        for (let x = 0; x < bw; x++) {
            const inside = grow ? dist[row + x] <= r2 : dist[row + x] > r2;
            if (inside) d[(dst + x) * 4 + 3] = 255;
        }
    }
    return d;
}

/** Invert a selection in place (red where selected, alpha flipped). */
export function invertMask(d) {
    for (let i = 0; i < d.length; i += 4) {
        d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
        d[i + 3] = 255 - d[i + 3];
    }
    return d;
}

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/**
 * Region of pixels similar to the one at (sx, sy): a Uint8Array (1 = inside)
 * over a W×H RGBA buffer. `tolerance` is the largest per-channel difference
 * (0..255, alpha included); `contiguous` grows a 4-connected region from the
 * seed with a scanline fill, otherwise every similar pixel of the buffer
 * counts (Photoshop's "contiguous" checkbox).
 */
export function floodMask(data, W, H, sx, sy, tolerance = 32, contiguous = true) {
    const out = new Uint8Array(W * H);
    sx = Math.max(0, Math.min(W - 1, sx | 0));
    sy = Math.max(0, Math.min(H - 1, sy | 0));
    const i0 = (sy * W + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
    const tol = Math.max(0, tolerance | 0);
    const similar = (i) => {
        const d = Math.abs(data[i] - r0), e = Math.abs(data[i + 1] - g0), f = Math.abs(data[i + 2] - b0), g = Math.abs(data[i + 3] - a0);
        return d <= tol && e <= tol && f <= tol && g <= tol;
    };
    if (!contiguous) {
        for (let p = 0, i = 0; p < W * H; p++, i += 4) if (similar(i)) out[p] = 1;
        return out;
    }
    // scanline flood fill with an explicit stack of spans
    const stack = [sx, sy];
    while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        let p = y * W + x;
        if (out[p] || !similar(p * 4)) continue;
        let xl = x, xr = x;
        while (xl > 0 && !out[p - 1] && similar((p - 1) * 4)) { xl--; p--; }
        p = y * W + x;
        while (xr < W - 1 && !out[p + 1] && similar((p + 1) * 4)) { xr++; p++; }
        const row = y * W;
        for (let i = xl; i <= xr; i++) out[row + i] = 1;
        for (const ny of [y - 1, y + 1]) {
            if (ny < 0 || ny >= H) continue;
            const nrow = ny * W;
            let inSpan = false;
            for (let i = xl; i <= xr; i++) {
                const q = nrow + i;
                const ok = !out[q] && similar(q * 4);
                if (ok && !inSpan) { stack.push(i, ny); inSpan = true; }
                else if (!ok) inSpan = false;
            }
        }
    }
    return out;
}

/** Draw a W×H mask (1 = set) as `color` (hex) into a new canvas; alpha from the mask. */
export function maskToColorCanvas(mask, W, H, color) {
    const c = makeRasterCanvas(W, H);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const [r, g, b] = hexToRgb(color);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (!mask[p]) continue;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

/** Intersect a region mask with a selection canvas (alpha > 127 = selected) in place. */
export function clipMaskToSelection(mask, selection) {
    const W = selection.width, H = selection.height;
    const s = selection.getContext("2d").getImageData(0, 0, W, H).data;
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) if (s[i] < 128) mask[p] = 0;
    return mask;
}
