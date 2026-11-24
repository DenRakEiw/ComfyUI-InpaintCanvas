// Generated from scumble-app/scumble renderer/editor/inpaint_surface.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Deep paint's surface maps from the decomposition (docs/PLAN_SURFACE_PAINT.md §3.1, SP3): the model's albedo A,
// shading S and residual R at its size (long side 768) become the document's shading and residual maps at the work
// size (long side up to 4096), and MoGe-2's normals its normal map. Plain functions on typed arrays, no DOM: the pool's
// worker runs `surfaceMaps` (op "surface_maps"), tools/surface_test.js the same code under Node.
//
// The model's S and R are "up to scale" (Marigold's model_index.json), and its own A * S + R misses the picture by 9-19
// levels on average (SP0), so:
//   1. a least-squares fit I ~ a * A * S + b * R on the model's size, in linear light (`fitScale`; SP0 found a = 1.5-2.4,
//      b = 1.5-2.6), sets the scale: S' = a S, R' = b R ("model", the default). The model's residual is colourless
//      (highlights, sparkle, fine texture); where b R' reaches the picture (3-41 % of the channel values on SP0's
//      pictures) A clamps at 0 and paint would add light instead of covering: SP5's "Keep reflections" scales R there.
//      Not taken: "excess", the light's scale from the low-residual half (`fitDiffuse`) and R' = max(0, I - A S'),
//      what the diffuse light does not explain. The model's albedo is blurred and its colour a little off, so that
//      residual held the albedo's error in the complementary colour (the orange car's came out teal, a purple face
//      paint blue: SP3's look, docs/measurements/sp3_2026-11-13/); it stays for tools/surface_test.js's comparison;
//   2. S' and R' go up to the work size by a bilinear step and a guided filter with the picture's grey as the guide (the
//      light's edges follow the picture's), S' normalised by its largest value first (stored as `sScale`, so the 16-bit
//      map holds 0..1 and a bright highlight's light above 1 is kept);
//   3. R is made exact: A_up = clamp((I - R_up) / S_up, 0, 1), R = I - A_up * S_q with S_q the stored (quantised) S, so
//      A * S + R gives the picture back up to R's own 16-bit step, and every later formula is the identity where
//      nothing is painted. R stays in [0, I]: A_up <= (I - R_up) / S_up wherever it is not clamped, so R >= R_up >= 0.
"use strict";

/** sRGB byte -> linear 0..1 (a 256-entry table). */
export const SRGB_TO_LIN = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 255; t[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
    return t;
})();

/** linear 0..1 -> sRGB 0..255 as a float (no rounding). */
export function linToSrgb255(v) {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
}

/**
 * The scale fit of step 1: minimise sum (I - a * A * S - b * R)^2 over every channel of every pixel (I linear from the
 * RGBA bytes). -> { a, b } with a > 0 and b >= 0 (b fit again alone at 0 when the joint fit made it negative).
 */
export function fitScale(rgba, albedo, shading, residual, n) {
    let xx = 0, xy = 0, yy = 0, xi = 0, yi = 0;
    for (let p = 0; p < n; p++) {
        for (let c = 0; c < 3; c++) {
            const k = 3 * p + c;
            const x = albedo[k] * shading[k], y = residual[k], i = SRGB_TO_LIN[rgba[4 * p + c]];
            xx += x * x; xy += x * y; yy += y * y; xi += x * i; yi += y * i;
        }
    }
    const det = xx * yy - xy * xy;
    let a = det > 1e-12 ? (xi * yy - yi * xy) / det : (xx > 0 ? xi / xx : 1);
    let b = det > 1e-12 ? (yi * xx - xi * xy) / det : 0;
    if (!(b >= 0)) { b = 0; a = xx > 0 ? xi / xx : 1; }
    if (!(a > 1e-6)) a = 1;
    return { a, b };
}

/**
 * The light's scale of step 1: minimise sum (I - a * A * S)^2 over the channel values whose pixel has a residual (the
 * sum of its three channels) at most the median's. -> a > 0
 */
export function fitDiffuse(rgba, albedo, shading, residual, n) {
    const rs = new Float32Array(n);
    for (let p = 0; p < n; p++) rs[p] = residual[3 * p] + residual[3 * p + 1] + residual[3 * p + 2];
    const med = Float32Array.from(rs).sort()[n >> 1];
    let xx = 0, xi = 0;
    for (let p = 0; p < n; p++) {
        if (rs[p] > med) continue;
        for (let c = 0; c < 3; c++) {
            const k = 3 * p + c, x = albedo[k] * shading[k];
            xx += x * x; xi += x * SRGB_TO_LIN[rgba[4 * p + c]];
        }
    }
    const a = xx > 0 ? xi / xx : 1;
    return a > 1e-6 ? a : 1;
}

/** R' = max(0, I - A * a S) per channel at the model's size (interleaved RGB). */
export function excessResidual(rgba, albedo, shading, a, n) {
    const out = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) {
        for (let c = 0; c < 3; c++) {
            const k = 3 * p + c, v = SRGB_TO_LIN[rgba[4 * p + c]] - albedo[k] * shading[k] * a;
            out[k] = v > 0 ? v : 0;
        }
    }
    return out;
}

/** One channel `c` of an interleaved RGB Float32Array, times `k`. */
function channel(src, n, c, k) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = src[3 * i + c] * k;
    return out;
}

/** Bilinear resize of one float plane (pixel centres at +0.5, edges clamped). */
export function resizePlane(src, w, h, W, H) {
    if (w === W && h === H) return Float32Array.from(src);
    const out = new Float32Array(W * H);
    const sx = w / W, sy = h / H;
    for (let y = 0; y < H; y++) {
        let fy = (y + 0.5) * sy - 0.5;
        if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < W; x++) {
            let fx = (x + 0.5) * sx - 0.5;
            if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
            const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
            out[y * W + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
        }
    }
    return out;
}

/** A guided filter without the final clamp (He et al.; means by `box`): q = mean(a) I + mean(b). */
function guided(I, p, w, h, r, eps, box) {
    const n = w * h;
    const mI = box(I, w, h, [r]), mP = box(p, w, h, [r]);
    const Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mIp = box(Ip, w, h, [r]), mII = box(II, w, h, [r]);
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const av = (mIp[i] - mI[i] * mP[i]) / (mII[i] - mI[i] * mI[i] + eps);
        a[i] = av; b[i] = mP[i] - av * mI[i];
    }
    const mA = box(a, w, h, [r]), mB = box(b, w, h, [r]);
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
    return q;
}

/** The guided filter's radius at the work size: about the upsampling factor, at least 2. */
export function guideRadius(mw, gw) {
    return Math.max(2, Math.round(gw / mw));
}

export const GUIDE_EPS = 1e-3;

/**
 * Steps 1-3. msg: { albedo, shading, residual (Float32Array mw*mh*3, the model's), model (RGBA bytes mw*mh, the
 * model's input), mw, mh, picture (RGBA bytes gw*gh, the work-size picture), gw, gh, box(data, w, h, radii), mode? ("model", the default, or "excess": step 1) }
 * -> { shading: Uint16Array(gw*gh*3) (S / sScale), residual: Uint16Array(gw*gh*3), sScale, a, b, r, identity:
 * { maxLevels, meanLevels } (the picture rebuilt as A * S + R from the stored maps, in sRGB levels against its bytes),
 * clampedA (the share of channel values where A_up hit 0 or 1), zeroA (where it hit 0: the reflections took all) }.
 */
export function surfaceMaps({ albedo, shading, residual, model, mw, mh, picture, gw, gh, box, mode = "model" }) {
    const nm = mw * mh, n = gw * gh;
    let a, b, res;
    if (mode === "model") {
        ({ a, b } = fitScale(model, albedo, shading, residual, nm));
        res = residual;
    } else {
        a = fitDiffuse(model, albedo, shading, residual, nm);
        b = null;
        res = excessResidual(model, albedo, shading, a, nm);
    }
    // the work-size picture: linear RGB and the guide (sRGB grey 0..1, as the depth map's guide)
    const grey = new Float32Array(n);
    for (let i = 0; i < n; i++) grey[i] = (picture[4 * i] * 0.299 + picture[4 * i + 1] * 0.587 + picture[4 * i + 2] * 0.114) / 255;
    const r = guideRadius(mw, gw);
    // S' up and its largest value (the stored scale)
    const sUp = [0, 1, 2].map((c) => guided(grey, resizePlane(channel(shading, nm, c, a), mw, mh, gw, gh), gw, gh, r, GUIDE_EPS, box));
    const rUp = [0, 1, 2].map((c) => guided(grey, resizePlane(channel(res, nm, c, b == null ? 1 : b), mw, mh, gw, gh), gw, gh, r, GUIDE_EPS, box));
    let sMax = 0;
    for (const p of sUp) for (let i = 0; i < n; i++) { if (p[i] < 0) p[i] = 0; if (p[i] > sMax) sMax = p[i]; }
    const sScale = sMax > 1e-6 ? sMax : 1;
    const S = new Uint16Array(n * 3), R = new Uint16Array(n * 3);
    let clamped = 0, zero = 0, maxLv = 0, sumLv = 0;
    for (let c = 0; c < 3; c++) {
        const sp = sUp[c], rp = rUp[c];
        for (let i = 0; i < n; i++) {
            const k = 3 * i + c;
            const sq = Math.round((sp[i] / sScale) * 65535);
            S[k] = sq;
            const s = (sq / 65535) * sScale;           // the light as the map gives it back
            const I = SRGB_TO_LIN[picture[4 * i + c]];
            const rUpV = rp[i] > 0 ? rp[i] : 0;
            let A = s > 1e-7 ? (I - rUpV) / s : 1;
            if (A <= 0) { A = 0; clamped++; zero++; } else if (A >= 1) { A = 1; clamped++; }
            let rv = I - A * s;
            if (rv < 0) rv = 0;                        // float noise only (A * s <= I - rUpV <= I)
            const rq = Math.round(rv * 65535);
            R[k] = rq;
            // the identity from the stored maps: A_d = clamp((I - R_d) / S_d), rebuilt = A_d * S_d + R_d
            const rd = rq / 65535;
            let Ad = s > 1e-7 ? (I - rd) / s : 1;
            if (Ad < 0) Ad = 0; else if (Ad > 1) Ad = 1;
            const lv = Math.abs(linToSrgb255(Ad * s + rd) - picture[4 * i + c]);
            if (lv > maxLv) maxLv = lv;
            sumLv += lv;
        }
    }
    return { shading: S, residual: R, sScale, a, b, r, identity: { maxLevels: maxLv, meanLevels: sumLv / (3 * n) }, clampedA: clamped / (3 * n), zeroA: zero / (3 * n) };
}

/**
 * MoGe-2's normals and mask as an rgba8 map's bytes: (n + 1) / 2 * 255 per axis (the camera's frame: x right, y down,
 * z away from the viewer), the mask (0..1) * 255 in A.
 */
export function packNormals(normal, mask, n) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
            const v = Math.round((normal[3 * i + c] + 1) * 127.5);
            out[4 * i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        const m = Math.round(mask[i] * 255);
        out[4 * i + 3] = m < 0 ? 0 : m > 255 ? 255 : m;
    }
    return out;
}

/**
 * MoGe-2's point map (camera space: x right, y down, z away from the viewer, three floats a pixel) as an rgb16 map's
 * data and its meta (Wrap's perspective, docs/PLAN_SURFACE_PAINT.md): each channel stored as (p - lo) / (hi - lo) over
 * the pixels the mask keeps (0 elsewhere), and `f`, the focal length in the map's pixels, the median of
 * (u - w / 2) z / x and (v - h / 2) z / y over kept pixels far enough from the centre (the principal point taken as the
 * picture's centre). Null when the mask keeps too few pixels or no focal length can be read.
 * @param {Float32Array} points
 * @param {ArrayLike<number>} mask
 * @param {number} w
 * @param {number} h
 */
export function packPoints(points, mask, w, h) {
    const n = w * h;
    if (!points || points.length < 3 * n) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    // a point is kept where the mask keeps it, in front of the camera, and all three of its numbers are finite (one
    // infinite X made its channel's span infinite and flattened every other point's X to 0)
    const ok = (i) => mask[i] >= 0.5 && points[3 * i + 2] > 0 && Number.isFinite(points[3 * i]) && Number.isFinite(points[3 * i + 1]) && Number.isFinite(points[3 * i + 2]);
    let kept = 0;
    for (let i = 0; i < n; i++) {
        if (!ok(i)) continue;
        kept++;
        for (let c = 0; c < 3; c++) { const v = points[3 * i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
    if (kept < 16) return null;
    const fs = [];
    const step = Math.max(1, Math.floor(Math.sqrt(n / 20000)));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (!ok(i)) continue;
        const X = points[3 * i], Y = points[3 * i + 1], Z = points[3 * i + 2];
        const du = x + 0.5 - w / 2, dv = y + 0.5 - h / 2;
        if (Math.abs(du) > w * 0.1 && Math.abs(X) > 1e-9) { const f = du * Z / X; if (f > 0 && Number.isFinite(f)) fs.push(f); }
        if (Math.abs(dv) > h * 0.1 && Math.abs(Y) > 1e-9) { const f = dv * Z / Y; if (f > 0 && Number.isFinite(f)) fs.push(f); }
    }
    if (fs.length < 8) return null;
    fs.sort((a, b) => a - b);
    const f = fs[Math.floor(fs.length / 2)];
    const data = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) {
        if (!ok(i)) continue;
        for (let c = 0; c < 3; c++) {
            const span = hi[c] - lo[c];
            const v = span > 0 ? Math.round(((points[3 * i + c] - lo[c]) / span) * 65535) : 0;
            data[3 * i + c] = v < 0 ? 0 : v > 65535 ? 65535 : v;
        }
    }
    return { data, meta: { lo, hi, f } };
}

/**
 * A depth map's raw disparity (1 / z, near high) from a points map (packPoints), for a document without Depth Anything:
 * the depth map's own convention, so the guided filter and everything that reads the depth map take it as they are.
 * Sampled at the rw x rh pixel centres of the document (W x H), each through `inv` (the points map's xf inverted: a
 * document point to the map's unit square), nearest neighbour (a bilinear sample across the mask's border would mix a
 * kept point with the 0 of a dropped one, a near halo around the sky). A pixel the mask drops (`mask`, the normals map's
 * alpha bytes at the same size, or the all-zero point packPoints writes there) and a pixel outside the map get the
 * farthest kept disparity. -> { raw, lo, hi, kept } or null when fewer than 16 pixels are kept.
 * @param {{ data: Uint16Array, w: number, h: number, meta: { lo: number[], hi: number[] } }} pm
 * @param {Uint8Array|Uint8ClampedArray|null} mask rgba8 bytes of pm.w x pm.h (alpha read), or null
 * @param {number[]} inv
 * @param {number} W
 * @param {number} H
 * @param {number} rw
 * @param {number} rh
 */
export function disparityFromPoints(pm, mask, inv, W, H, rw, rh) {
    if (!pm || !pm.data || !pm.meta || !pm.w || !pm.h) return null;
    const w = pm.w, h = pm.h, d = pm.data;
    const z0 = pm.meta.lo[2], zs = (pm.meta.hi[2] - pm.meta.lo[2]) / 65535;
    const useMask = !!(mask && mask.length >= w * h * 4);
    const raw = new Float32Array(rw * rh);
    const hit = new Uint8Array(rw * rh);
    let kept = 0, lo = Infinity, hi = -Infinity;
    for (let v = 0; v < rh; v++) {
        const dy = (v + 0.5) * H / rh;
        for (let u = 0; u < rw; u++) {
            const dx = (u + 0.5) * W / rw;
            const sx = inv[0] * dx + inv[2] * dy + inv[4], sy = inv[1] * dx + inv[3] * dy + inv[5];
            const mx = Math.floor(sx * w), my = Math.floor(sy * h);
            if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
            const i = my * w + mx;
            if (useMask ? mask[i * 4 + 3] < 128 : (d[i * 3] === 0 && d[i * 3 + 1] === 0 && d[i * 3 + 2] === 0)) continue;
            const z = z0 + d[i * 3 + 2] * zs;
            if (!(z > 0)) continue;
            const t = v * rw + u, disp = 1 / z;
            raw[t] = disp; hit[t] = 1; kept++;
            if (disp < lo) lo = disp;
            if (disp > hi) hi = disp;
        }
    }
    if (kept < 16) return null;
    for (let t = 0; t < raw.length; t++) if (!hit[t]) raw[t] = lo;
    return { raw, lo, hi, kept };
}

/** The model's size for a picture of W x H: the long side 768 (or the picture's, if smaller), both sides at least 16. */
export function surfaceModelSize(W, H, long = 768) {
    const s = Math.min(1, long / Math.max(W, H));
    return [Math.max(16, Math.round(W * s)), Math.max(16, Math.round(H * s))];
}

/**
 * Stay on surface (Deep paint's brush): how far a point may lie off the line through two others to its sides and
 * still be the same surface, in the lengths one map pixel has at its depth. On a plane the disparity 1 / z is linear in
 * the pixel, however the plane is tilted, so a continuous surface is near 0 and an object in front of it is its
 * distance in such lengths (an arm 8 cm before a wall 3 m away: about 19).
 */
export const REGION_TOL = 2;
/** And how far a neighbour may lie from the pixel itself, in the same lengths: a surface seen at up to about 85 degrees. */
export const REGION_STEP = 12;
/**
 * The reach of the test, in map pixels to each side: between direct neighbours it finds a jump in depth; over this
 * reach it also finds the crease where an object stands on the surface (a cup on a table, a hand on a wall), which the
 * model smooths over a few pixels.
 */
export const REGION_SPAN = 4;

/**
 * The surface under a pixel of MoGe-2's points map: the pixels reached from (mx, my) over neighbours (left, right, up,
 * down) between which the surface goes on. Two neighbours c and q are one surface when the disparity's step between
 * them is at most REGION_STEP and its second difference centred on each of the two is at most `tol`, both in units of
 * d / f (one map pixel's length at that depth, as a disparity); the second difference is taken between direct
 * neighbours and over REGION_SPAN pixels to each side. The long reach leaves a margin of that many pixels free at every
 * border, so the region then grows back over at most as many steps by the direct neighbours' test alone: up to the
 * jump in depth, and no further than the reach onto an object that touches the surface. A start inside such a margin
 * (or on something narrower than the reach) begins from what the direct test reaches around it, and with a shorter
 * reach when that finds next to nothing. A pixel the mask drops (the sky) is one surface with the dropped pixels
 * around it. Only what is connected is reached: a part of the same surface behind something that cuts it in two is
 * another region (two ways to follow it there were tried and dropped, docs/BUGS.md).
 * -> { mask (255 on the surface), w, h, count }, or null when the map cannot say
 * @param {{ data: Uint16Array, w: number, h: number, meta: { lo: number[], hi: number[], f: number } }} pmap packPoints' map
 * @param {{ data: Uint8Array|Uint8ClampedArray, w: number, h: number }|null} nmap the normals map, for its mask (same size), or null
 * @param {number} mx the pixel, in the map's own pixels
 * @param {number} my
 * @param {number} tol
 */
export function surfaceRegion(pmap, nmap, mx, my, tol = REGION_TOL) {
    const meta = pmap && pmap.meta;
    if (!meta || !pmap.data || !Array.isArray(meta.lo) || !Array.isArray(meta.hi) || !(meta.f > 0)) return null;
    const w = pmap.w, h = pmap.h, n = w * h, pd = pmap.data;
    if (!(w > 0) || !(h > 0) || pd.length < 3 * n) return null;
    const useMask = !!(nmap && nmap.data && nmap.w === w && nmap.h === h);
    const zlo = meta.lo[2], zsp = meta.hi[2] - meta.lo[2];
    // the disparity of each kept pixel, 0 for a dropped one
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const kept = useMask ? nmap.data[4 * i + 3] >= 128 : (pd[3 * i] | pd[3 * i + 1] | pd[3 * i + 2]) !== 0;
        if (!kept) continue;
        const z = zlo + (pd[3 * i + 2] / 65535) * zsp;
        if (z > 0) d[i] = 1 / z;
    }
    const sx = Math.min(w - 1, Math.max(0, Math.floor(mx))), sy = Math.min(h - 1, Math.max(0, Math.floor(my)));
    const seed = sy * w + sx, sky = !(d[seed] > 0);
    const f = meta.f;
    // the second difference centred on pixel i at (x, y), `k` pixels to each side along the axis of `step` (1 or w): fine
    // when it is within `tol`, or when a side is beyond the map or dropped
    const straight = (i, pos, len, step, k, unit) => {
        if (pos < k || pos + k >= len) return true;
        const a = d[i - k * step], b = d[i + k * step];
        return !(a > 0) || !(b > 0) || Math.abs(a - 2 * d[i] + b) <= tol * unit;
    };
    // c -> q, neighbours along the axis of `step`, c at `pos` of `len` on that axis and q at `qpos`; `span`: the reach
    const joins = (c, q, pos, qpos, len, step, span) => {
        const dc = d[c], dq = d[q];
        if (sky) return !(dq > 0);
        if (!(dq > 0)) return false;
        const unit = Math.max(dc, dq) / f;
        if (Math.abs(dq - dc) > REGION_STEP * unit) return false;
        if (!straight(c, pos, len, step, 1, unit) || !straight(q, qpos, len, step, 1, unit)) return false;
        return span < 2 || (straight(c, pos, len, step, span, unit) && straight(q, qpos, len, step, span, unit));
    };
    const mask = new Uint8Array(n), stack = new Int32Array(n);
    let count = 0;
    // flood from the pixels on `stack[0 .. top)` (already marked) with reach `span`; `steps` > 0 limits how far it goes
    const flood = (top, span, steps) => {
        let from = 0, end = top, round = 0;
        // a queue in rounds, so `steps` counts the distance
        while (from < end && (!steps || round < steps)) {
            for (let s = from; s < end; s++) {
                const c = stack[s], x = c % w, y = (c - x) / w;
                if (x + 1 < w && !mask[c + 1] && joins(c, c + 1, x, x + 1, w, 1, span)) { mask[c + 1] = 255; stack[top++] = c + 1; count++; }
                if (x > 0 && !mask[c - 1] && joins(c, c - 1, x, x - 1, w, 1, span)) { mask[c - 1] = 255; stack[top++] = c - 1; count++; }
                if (y + 1 < h && !mask[c + w] && joins(c, c + w, y, y + 1, h, w, span)) { mask[c + w] = 255; stack[top++] = c + w; count++; }
                if (y > 0 && !mask[c - w] && joins(c, c - w, y, y - 1, h, w, span)) { mask[c - w] = 255; stack[top++] = c - w; count++; }
            }
            from = end; end = top; round++;
        }
        return top;
    };
    const spans = sky ? [1] : [REGION_SPAN, 2, 1].filter((s, i, a) => s >= 1 && a.indexOf(s) === i);
    // from the start alone first; when that finds next to nothing (the start lies in a border's margin), from what the
    // direct test reaches around it; then the same with a shorter reach (something narrower than the reach)
    const tries = [];
    for (const span of spans) { tries.push([span, false]); if (span > 1) tries.push([span, true]); }
    for (let t = 0; t < tries.length; t++) {
        const [span, around] = tries[t];
        mask.fill(0);
        count = 1;
        mask[seed] = 255; stack[0] = seed;
        let top = around ? flood(1, 1, span) : 1;
        top = flood(top, span, 0);
        if (span > 1) flood(top, 1, span);   // back to the borders
        // something to paint on: a patch a few reaches wide (the last try is taken as it is)
        if (count >= 16 * span * span) break;
    }
    return { mask, w, h, count };
}
