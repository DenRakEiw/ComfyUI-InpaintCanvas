// Generated from DenRakEiw/scumble renderer/editor/inpaint_mesh.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// homography and the triangle mesh draw: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

// ---------------------------------------------------------------------------
// geometry helpers for the transform tool
// ---------------------------------------------------------------------------

/** 3x3 homography mapping four source points onto four destination points. */
function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = src[i], [X, Y] = dst[i];
        A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
        const d = A[c][c] || 1e-12;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = A[r][c] / d;
            if (!f) continue;
            for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    const h = b.map((v, i) => v / (A[i][i] || 1e-12));
    return (x, y) => {
        const w = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
    };
}

/** Draw `img` so that source triangle s0..s2 lands on destination triangle d0..d2. */
function drawTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
    const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2;
    const [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(det) < 1e-9) return;
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
    const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    const d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    const e = u0 - a * x0 - c * y0;
    const f = v0 - b * x0 - d * y0;
    // Expand the clip a hair from the centroid so neighbouring triangles leave no seams.
    const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3;
    const grow = (px, py) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px + dx / l * 0.7, py + dy / l * 0.7]; };
    const g0 = grow(u0, v0), g1 = grow(u1, v1), g2 = grow(u2, v2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g0[0], g0[1]); ctx.lineTo(g1[0], g1[1]); ctx.lineTo(g2[0], g2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

/**
 * Draw `img` through a deformation: `dst(u, v)` gives the destination point for
 * the normalised source position (u, v) in [0, 1]. The image is split into an
 * nx by ny mesh of triangle pairs. `img` is a canvas (a layer's `px.toCanvas()`, taken once
 * by the caller): every triangle draws the whole of it.
 */
function drawMesh(ctx, img, dst, nx, ny) {
    const W = img.width, H = img.height;
    const pts = [];
    for (let j = 0; j <= ny; j++) {
        const row = [];
        for (let i = 0; i <= nx; i++) row.push(dst(i / nx, j / ny));
        pts.push(row);
    }
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const sx0 = i / nx * W, sx1 = (i + 1) / nx * W, sy0 = j / ny * H, sy1 = (j + 1) / ny * H;
            const d00 = pts[j][i], d10 = pts[j][i + 1], d01 = pts[j + 1][i], d11 = pts[j + 1][i + 1];
            drawTriangle(ctx, img, [sx0, sy0], [sx1, sy0], [sx0, sy1], d00, d10, d01);
            drawTriangle(ctx, img, [sx1, sy0], [sx1, sy1], [sx0, sy1], d10, d11, d01);
        }
    }
}

export { drawMesh, homography };
