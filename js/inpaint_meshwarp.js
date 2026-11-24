// Generated from scumble-app/scumble renderer/editor/inpaint_meshwarp.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The distort / warp bake by backward mapping (item 73, the review of 2026-11-16,
 * `distort-warp-mesh-seams-on-half-transparent-pixels`). Pure, no DOM: the editor and the plain-Node test import it.
 *
 * Until 0.1.59 the bake drew the layer through the canvas once per mesh triangle, each clip grown by 0.7 px so the
 * anti-aliased edges left no gap; every pixel in the overlap was drawn twice, so a half-transparent pixel there came
 * out more opaque (alpha 2a - a^2) and the mesh's grid was baked into the layer. Here every destination pixel is
 * written once, by the one triangle its centre lies in, from the source point that triangle's affine map gives it:
 * - The source rectangle [0, W] x [0, H] (pixel corners at integers) is split into the same nx x ny cells of two
 *   triangles each as the canvas mesh (`drawMesh`); `pts[j][i]` is where the source point (i W / nx, j H / ny) lands,
 *   in destination pixel coordinates (corners at integers).
 * - Inside: the destination vertices are snapped to 1/256 px and the edge functions are exact integers, so an edge two
 *   triangles share gives each pixel centre on it to exactly one of them (the tie goes by the edge's direction).
 * - The rim: one more ring of cells reaches one source pixel past the rectangle (the outer points extrapolated along
 *   the mesh), and taps outside the source are transparent: the edge fades over a pixel as a rotated edge does in the
 *   resampler ("transparent"), instead of stepping.
 * - Colour: bilinear on premultiplied values. Where a triangle shrinks the source (more than one source pixel per
 *   destination pixel by area), the taps come from box-filtered levels, two of them mixed by the fraction of the
 *   level (trilinear), so a strongly shrunk corner does not alias.
 * - Bytes below alpha 255 go through the canvas round trip `rt` (`canvasRoundTrip`), so they read back from a canvas
 *   unchanged, as the resampler's do.
 * A fold of the mesh (two triangles over the same pixel) is written by the later one.
 */

const SNAP = 256;

/** The box-filtered levels of the source, made when a triangle first needs them: premultiplied floats. */
function makeLevels(src, W, H) {
    const levels = [null];
    let pw = W, ph = H, prev = null;
    const pm = (x, y, out) => {   // premultiplied level-0 pixel
        const i = (y * W + x) * 4, a = src[i + 3];
        out[0] = src[i] * a / 255; out[1] = src[i + 1] * a / 255; out[2] = src[i + 2] * a / 255; out[3] = a;
    };
    const t = [0, 0, 0, 0];
    return (k) => {
        while (levels.length <= k) {
            if (pw <= 1 && ph <= 1) { levels.push(levels[levels.length - 1]); continue; }
            const nw = Math.max(1, Math.ceil(pw / 2)), nh = Math.max(1, Math.ceil(ph / 2));
            const d = new Float32Array(nw * nh * 4);
            for (let y = 0; y < nh; y++) {
                for (let x = 0; x < nw; x++) {
                    let r = 0, g = 0, b = 0, a = 0;
                    // a pixel past an odd edge counts as transparent: the level keeps the source's coverage
                    for (let dy = 0; dy < 2; dy++) {
                        const sy = 2 * y + dy;
                        if (sy >= ph) continue;
                        for (let dx = 0; dx < 2; dx++) {
                            const sx = 2 * x + dx;
                            if (sx >= pw) continue;
                            if (prev) { const i = (sy * pw + sx) * 4; r += prev.d[i]; g += prev.d[i + 1]; b += prev.d[i + 2]; a += prev.d[i + 3]; }
                            else { pm(sx, sy, t); r += t[0]; g += t[1]; b += t[2]; a += t[3]; }
                        }
                    }
                    const o = (y * nw + x) * 4;
                    d[o] = r / 4; d[o + 1] = g / 4; d[o + 2] = b / 4; d[o + 3] = a / 4;
                }
            }
            prev = { d, w: nw, h: nh };
            levels.push(prev);
            pw = nw; ph = nh;
        }
        return levels[k];
    };
}

/**
 * Warp `src` (straight RGBA bytes, W x H) through the mesh `pts` into a new straight RGBA buffer of outW x outH.
 * Returns the bytes (a Uint8ClampedArray); `stats`, when given, gets the count of pixels written and of pixels
 * written more than once (a fold).
 */
export function meshWarp(src, W, H, pts, nx, ny, outW, outH, rt = null, stats = null) {
    const out = new Uint8ClampedArray(outW * outH * 4);
    if (W < 1 || H < 1 || outW < 1 || outH < 1) return out;
    const seen = stats ? new Uint8Array(outW * outH) : null;
    let written = 0, twice = 0;
    // the grid with its outer ring: index i = -1 .. nx + 1, j = -1 .. ny + 1 (stored at i + 1, j + 1)
    const GX = nx + 3, GY = ny + 3;
    const SX = new Float64Array(GX * GY), SY = new Float64Array(GX * GY), DX = new Float64Array(GX * GY), DY = new Float64Array(GX * GY);
    const at = (i, j) => (j + 1) * GX + (i + 1);
    for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) { const k = at(i, j); DX[k] = pts[j][i][0]; DY[k] = pts[j][i][1]; }
        // one source pixel past the left and right edges, the destination extrapolated along the row
        const fx = nx / W;
        for (const [e, inner, ring] of [[0, 1, -1], [nx, nx - 1, nx + 1]]) {
            const ke = at(e, j), ki = at(inner, j), kr = at(ring, j);
            DX[kr] = DX[ke] + (DX[ke] - DX[ki]) * fx; DY[kr] = DY[ke] + (DY[ke] - DY[ki]) * fx;
        }
    }
    const fy = ny / H;
    for (let i = -1; i <= nx + 1; i++) {
        for (const [e, inner, ring] of [[0, 1, -1], [ny, ny - 1, ny + 1]]) {
            const ke = at(i, e), ki = at(i, inner), kr = at(i, ring);
            DX[kr] = DX[ke] + (DX[ke] - DX[ki]) * fy; DY[kr] = DY[ke] + (DY[ke] - DY[ki]) * fy;
        }
    }
    for (let j = -1; j <= ny + 1; j++) {
        const sy = j < 0 ? -1 : j > ny ? H + 1 : j / ny * H;
        for (let i = -1; i <= nx + 1; i++) {
            const k = at(i, j);
            SX[k] = i < 0 ? -1 : i > nx ? W + 1 : i / nx * W;
            SY[k] = sy;
            // snapped to 1/256 px: the edge functions below are exact integers
            DX[k] = Math.round(DX[k] * SNAP); DY[k] = Math.round(DY[k] * SNAP);
        }
    }
    const level = makeLevels(src, W, H);
    const acc = new Float64Array(4);

    // bilinear premultiplied taps of level k (0: the bytes) at source canvas position (sx, sy), into a
    const tap = (k, sx, sy, a, wgt) => {
        let lw = W, lh = H, d = null;
        if (k > 0) { const L = level(k); d = L.d; lw = L.w; lh = L.h; sx = sx * lw / W; sy = sy * lh / H; }
        const fx = sx - 0.5, fy = sy - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        for (let dy = 0; dy < 2; dy++) {
            const y = y0 + dy;
            if (y < 0 || y >= lh) continue;
            const wy = dy ? ty : 1 - ty;
            for (let dx = 0; dx < 2; dx++) {
                const x = x0 + dx;
                if (x < 0 || x >= lw) continue;
                const w = (dx ? tx : 1 - tx) * wy * wgt;
                if (!w) continue;
                const i = (y * lw + x) * 4;
                if (d) { a[0] += w * d[i]; a[1] += w * d[i + 1]; a[2] += w * d[i + 2]; a[3] += w * d[i + 3]; }
                else {
                    const al = src[i + 3] * w;
                    a[0] += al * src[i] / 255; a[1] += al * src[i + 1] / 255; a[2] += al * src[i + 2] / 255; a[3] += al;
                }
            }
        }
    };

    const tri = (ka, kb, kc) => {
        let ax = DX[ka], ay = DY[ka], bx = DX[kb], by = DY[kb], cx = DX[kc], cy = DY[kc];
        let sa = ka, sb = kb, sc = kc;
        let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (area === 0) return;
        if (area < 0) {   // a mirrored triangle (a fold, or a flipped mesh): the same pixels the other way round
            [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; [sb, sc] = [sc, sb]; area = -area;
        }
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / SNAP - 0.5)), x1 = Math.min(outW - 1, Math.ceil(Math.max(ax, bx, cx) / SNAP - 0.5));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / SNAP - 0.5)), y1 = Math.min(outH - 1, Math.ceil(Math.max(ay, by, cy) / SNAP - 0.5));
        if (x1 < x0 || y1 < y0) return;
        // E(a, b, p) = (b - a) x (p - a); a centre on an edge belongs to the triangle that runs the edge downwards (or
        // leftwards when it is level): the other triangle runs it the other way, so exactly one of them takes it
        const bias = (px, py, qx, qy) => (qy > py || (qy === py && qx < px) ? 0 : -1);
        const b0 = bias(bx, by, cx, cy), b1 = bias(cx, cy, ax, ay), b2 = bias(ax, ay, bx, by);
        // the source of each vertex; barycentric weights are the edge functions over the area
        const s0x = SX[sa], s0y = SY[sa], s1x = SX[sb], s1y = SY[sb], s2x = SX[sc], s2y = SY[sc];
        // the shrink: source area per destination area (destination in pixels), for the level
        const srcArea = Math.abs((s1x - s0x) * (s2y - s0y) - (s1y - s0y) * (s2x - s0x));
        const dstArea = area / (SNAP * SNAP);
        // below a shrink of 1.41 (half a level) the bytes alone, then level 1 mixed in up to a shrink of 2, from there
        // the usual trilinear levels: no step where neighbouring triangles shrink a little more or less
        const raw = dstArea > 0 ? 0.5 * Math.log2(srcArea / dstArea) : 0;
        const lod = raw < 0.5 ? 0 : raw < 1 ? (raw - 0.5) * 2 : raw;
        const k0 = Math.floor(lod), f = lod - k0;
        const inv = 1 / area;
        for (let Y = y0; Y <= y1; Y++) {
            const py = Y * SNAP + SNAP / 2;
            let px = x0 * SNAP + SNAP / 2;
            // E for p at the row's first centre; each step right adds -(qy - py) * SNAP
            let e0 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
            let e1 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
            let e2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
            const d0 = -(cy - by) * SNAP, d1 = -(ay - cy) * SNAP, d2 = -(by - ay) * SNAP;
            for (let X = x0; X <= x1; X++, e0 += d0, e1 += d1, e2 += d2) {
                if (e0 + b0 < 0 || e1 + b1 < 0 || e2 + b2 < 0) continue;
                const w0 = e0 * inv, w1 = e1 * inv, w2 = 1 - w0 - w1;
                const sx = w0 * s0x + w1 * s1x + w2 * s2x, sy = w0 * s0y + w1 * s1y + w2 * s2y;
                let R = 0, G = 0, B = 0, A = 0;
                if (k0 === 0 && f === 0) {
                    // the common case inline: level 0, bilinear (the same sums as `tap`)
                    const fx = sx - 0.5, fy = sy - 0.5, xa = Math.floor(fx), ya = Math.floor(fy), tx = fx - xa, ty = fy - ya;
                    for (let dy = 0; dy < 2; dy++) {
                        const yy = ya + dy;
                        if (yy < 0 || yy >= H) continue;
                        const wy = dy ? ty : 1 - ty;
                        for (let dx = 0; dx < 2; dx++) {
                            const xx = xa + dx;
                            if (xx < 0 || xx >= W) continue;
                            const i = (yy * W + xx) * 4, al = src[i + 3] * (dx ? tx : 1 - tx) * wy;
                            if (!al) continue;
                            R += al * src[i]; G += al * src[i + 1]; B += al * src[i + 2]; A += al;
                        }
                    }
                    R /= 255; G /= 255; B /= 255;
                } else {
                    acc[0] = acc[1] = acc[2] = acc[3] = 0;
                    tap(k0, sx, sy, acc, f > 0 ? 1 - f : 1);
                    if (f > 0) tap(k0 + 1, sx, sy, acc, f);
                    R = acc[0]; G = acc[1]; B = acc[2]; A = acc[3];
                }
                const o = (Y * outW + X) * 4;
                const a = A >= 255 ? 255 : Math.round(A);
                if (seen) { if (seen[Y * outW + X]) twice++; else { seen[Y * outW + X] = 1; written++; } }
                if (a <= 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
                let r = Math.round(R * 255 / A), g = Math.round(G * 255 / A), b = Math.round(B * 255 / A);
                r = r > 255 ? 255 : r; g = g > 255 ? 255 : g; b = b > 255 ? 255 : b;
                if (rt && a < 255) { const t = a << 8; r = rt[t | r]; g = rt[t | g]; b = rt[t | b]; }
                out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
            }
        }
    };

    for (let j = -1; j <= ny; j++) {
        for (let i = -1; i <= nx; i++) {
            tri(at(i, j), at(i + 1, j), at(i, j + 1));
            tri(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
        }
    }
    if (stats) { stats.written = written; stats.twice = twice; }
    return out;
}
