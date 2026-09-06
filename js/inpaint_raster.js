/**
 * Raster helpers shared by the editor's tools: flood fill / magic wand region
 * growing, colour parsing, mask-to-canvas. Pure functions on typed arrays, no
 * DOM state, kept out of inpaint_canvas.js so the tools stay small.
 */

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
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
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
