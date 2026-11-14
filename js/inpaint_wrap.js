// Generated from DenRakEiw/scumble renderer/editor/inpaint_wrap.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Deep paint's wrap (docs/PLAN_SURFACE_PAINT.md §3.3, SP7): a flat picture (a logo, a pattern) laid onto the surface the
// picture shows, by arc length from the decal's centre. No DOM at import (plain functions, tested in Node).
//
// The surface's slope comes from the normals map alone: along a row the surface rises dz/dx = -nx / nz, so one pixel of
// the picture is ds/dx = sqrt(1 + (nx / nz)^2) pixels of surface (a column the same with ny). Summed from the centre c
// along each row that gives u, along each column v (trapezoids between pixel centres); the decal's pixel for (x, y) is
// the one at (u, v) turned back by the decal's angle and divided by its scale. On a cylinder seen side on that is exact
// (x = c + R sin(s / R)); a surface curved both ways (a face) gets a distortion that shows. The projection is taken as
// orthographic, so a strongly foreshortened plane is not stretched back.

import { xfInv } from "./inpaint_resample.js";

/** |nz| below this is taken as this (ds/dx at most about 6.7): a silhouette's normal lies in the picture's plane. */
export const WRAP_NZ_MIN = 0.15;

/**
 * The map's frame in the document: a vector of the map's own frame (x right, y down in its pixels) into document
 * directions, as unit columns [ax, ay, bx, by] of `xf`'s linear part (a quarter turn or a mirror moves only `xf`).
 * @param {any} map
 */
export function mapFrame(map) {
    const xf = map.xf || [map.w, 0, 0, map.h, 0, 0];
    const la = Math.hypot(xf[0], xf[1]) || 1, lb = Math.hypot(xf[2], xf[3]) || 1;
    return [xf[0] / la, xf[1] / la, xf[2] / lb, xf[3] / lb];
}

/**
 * The surface's length per picture pixel along x and y at each pixel centre of `box` ([x0, y0, x1, y1], document
 * pixels): `{ gx, gy }` (Float32Array, w * h). Where the map's mask (A) says no surface, 1 (flat).
 * @param {any} map an rgba8 normals map ((n + 1) / 2, the mask in A)
 * @param {number[]} box
 */
export function wrapSlopes(map, box) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    const [ax, ay, bx, by] = mapFrame(map);
    // the map's bilinear at each document pixel centre (sampleMapPx's step, its inverse taken once)
    const mw = map.w, mh = map.h, md = map.data;
    const inv = xfInv(map.xf || [mw, 0, 0, mh, 0, 0]);
    const s = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
        const py = y0 + y + 0.5;
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const px = x0 + x + 0.5;
            const qu = (inv[0] * px + inv[2] * py + inv[4]) * mw - 0.5, qv = (inv[1] * px + inv[3] * py + inv[5]) * mh - 0.5;
            const fx0 = Math.floor(qu), fy0 = Math.floor(qv), fx = qu - fx0, fy = qv - fy0;
            const cx0 = fx0 < 0 ? 0 : fx0 > mw - 1 ? mw - 1 : fx0, cx1 = fx0 + 1 < 0 ? 0 : fx0 + 1 > mw - 1 ? mw - 1 : fx0 + 1;
            const cy0 = fy0 < 0 ? 0 : fy0 > mh - 1 ? mh - 1 : fy0, cy1 = fy0 + 1 < 0 ? 0 : fy0 + 1 > mh - 1 ? mh - 1 : fy0 + 1;
            const i00 = 4 * (cy0 * mw + cx0), i10 = 4 * (cy0 * mw + cx1), i01 = 4 * (cy1 * mw + cx0), i11 = 4 * (cy1 * mw + cx1);
            for (let c = 0; c < 4; c++) {
                const top = md[i00 + c] + (md[i10 + c] - md[i00 + c]) * fx, bot = md[i01 + c] + (md[i11 + c] - md[i01 + c]) * fx;
                s[c] = (top + (bot - top) * fy) / 255;
            }
            if (s[3] < 0.5) { gx[i] = 1; gy[i] = 1; continue; }
            // a byte of 128 is 0.0039, not 0: within one byte of the middle the normal has no slope (a flat wall stays flat)
            let mx = 2 * s[0] - 1, my = 2 * s[1] - 1;
            if (Math.abs(mx) < 1 / 255) mx = 0;
            if (Math.abs(my) < 1 / 255) my = 0;
            const nz = Math.max(WRAP_NZ_MIN, Math.abs(2 * s[2] - 1));
            const dx = mx * ax + my * bx, dy = mx * ay + my * by;   // the normal's x, y in the document's directions
            gx[i] = Math.sqrt(1 + (dx / nz) * (dx / nz));
            gy[i] = Math.sqrt(1 + (dy / nz) * (dy / nz));
        }
    }
    return { gx, gy };
}

/**
 * The surface's length per picture pixel from MoGe-2's points (perspective): across pixel x of a row the length between
 * the points at its left and right edges, |P(x + 1, y + 0.5) - P(x, y + 0.5)| (a column the same), divided by the
 * length one picture pixel has at the decal centre's depth seen face on, z_c / f (f the focal length in document
 * pixels). A surface face on at the centre's depth is 1 a pixel, one further away longer (the decal gets smaller
 * there), a tilted one 1 / cos of its tilt as with the normals. Where the normals' mask is off, 1. `{ gx, gy }` or null
 * when the points or the centre are unusable.
 * @param {any} pmap an rgb16 points map with meta { lo, hi, f } (packPoints)
 * @param {any} nmap the normals map, for its mask (or null)
 * @param {number[]} box
 * @param {number} cx the decal's centre, document pixels
 * @param {number} cy
 */
export function wrapSlopesPoints(pmap, nmap, box, cx, cy) {
    const meta = pmap && pmap.meta;
    if (!meta || !Array.isArray(meta.lo) || !Array.isArray(meta.hi) || !(meta.f > 0)) return null;
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    const pw = pmap.w, ph = pmap.h, pd = pmap.data, lo = meta.lo, sp = [meta.hi[0] - lo[0], meta.hi[1] - lo[1], meta.hi[2] - lo[2]];
    const inv = xfInv(pmap.xf || [pw, 0, 0, ph, 0, 0]);
    const xf = pmap.xf || [pw, 0, 0, ph, 0, 0];
    // document pixels per map pixel (a turn or a mirror keeps it): the focal length in document pixels
    const docPerMap = Math.sqrt(Math.abs(xf[0] * xf[3] - xf[1] * xf[2]) / (pw * ph));
    const f = meta.f * docPerMap;
    const P = (dx, dy, out) => {
        const qu = (inv[0] * dx + inv[2] * dy + inv[4]) * pw - 0.5, qv = (inv[1] * dx + inv[3] * dy + inv[5]) * ph - 0.5;
        const fx0 = Math.floor(qu), fy0 = Math.floor(qv), fx = qu - fx0, fy = qv - fy0;
        const cx0 = fx0 < 0 ? 0 : fx0 > pw - 1 ? pw - 1 : fx0, cx1 = fx0 + 1 < 0 ? 0 : fx0 + 1 > pw - 1 ? pw - 1 : fx0 + 1;
        const cy0 = fy0 < 0 ? 0 : fy0 > ph - 1 ? ph - 1 : fy0, cy1 = fy0 + 1 < 0 ? 0 : fy0 + 1 > ph - 1 ? ph - 1 : fy0 + 1;
        const i00 = 3 * (cy0 * pw + cx0), i10 = 3 * (cy0 * pw + cx1), i01 = 3 * (cy1 * pw + cx0), i11 = 3 * (cy1 * pw + cx1);
        for (let c = 0; c < 3; c++) {
            const top = pd[i00 + c] + (pd[i10 + c] - pd[i00 + c]) * fx, bot = pd[i01 + c] + (pd[i11 + c] - pd[i01 + c]) * fx;
            out[c] = lo[c] + ((top + (bot - top) * fy) / 65535) * sp[c];
        }
        return out;
    };
    const c0 = P(cx, cy, [0, 0, 0]);
    if (!(c0[2] > 0)) return null;
    const unit = c0[2] / f;
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    const a = [0, 0, 0], b = [0, 0, 0];
    // the normals' mask (A), nearest map pixel, its inverse taken once
    const nInv = nmap && nmap.data ? xfInv(nmap.xf || [nmap.w, 0, 0, nmap.h, 0, 0]) : null;
    const masked = nInv ? (dx, dy) => {
        const u = Math.floor((nInv[0] * dx + nInv[2] * dy + nInv[4]) * nmap.w), v = Math.floor((nInv[1] * dx + nInv[3] * dy + nInv[5]) * nmap.h);
        const mx = u < 0 ? 0 : u > nmap.w - 1 ? nmap.w - 1 : u, my = v < 0 ? 0 : v > nmap.h - 1 ? nmap.h - 1 : v;
        return nmap.data[4 * (my * nmap.w + mx) + 3] < 128;
    } : () => false;
    for (let y = 0; y < h; y++) {
        const py = y0 + y + 0.5;
        for (let x = 0; x < w; x++) {
            const i = y * w + x, px = x0 + x + 0.5;
            if (masked(px, py)) { gx[i] = 1; gy[i] = 1; continue; }
            // at least 0.05: at the picture's edge both samples clamp to one map column (a length of 0 would repeat one
            // decal column as a smear)
            P(px - 0.5, py, a); P(px + 0.5, py, b);
            gx[i] = Math.max(0.05, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / unit);
            P(px, py - 0.5, a); P(px, py + 0.5, b);
            gy[i] = Math.max(0.05, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / unit);
        }
    }
    return { gx, gy };
}

/**
 * Surface coordinates of every pixel centre of a w x h box: u along each row, v along each column, signed, in surface
 * pixels from the point (cx, cy) (box pixels, real). Trapezoids between pixel centres; the centre's own pixel gets its
 * offset times its slope.
 * @param {Float32Array} gx
 * @param {Float32Array} gy
 * @param {number} w
 * @param {number} h
 * @param {number} cx
 * @param {number} cy
 */
export function wrapCoords(gx, gy, w, h, cx, cy) {
    const u = new Float32Array(w * h), v = new Float32Array(w * h);
    const ic = Math.max(0, Math.min(w - 1, Math.floor(cx))), jc = Math.max(0, Math.min(h - 1, Math.floor(cy)));
    for (let y = 0; y < h; y++) {
        const r = y * w;
        u[r + ic] = (ic + 0.5 - cx) * gx[r + ic];
        for (let x = ic + 1; x < w; x++) u[r + x] = u[r + x - 1] + 0.5 * (gx[r + x - 1] + gx[r + x]);
        for (let x = ic - 1; x >= 0; x--) u[r + x] = u[r + x + 1] - 0.5 * (gx[r + x + 1] + gx[r + x]);
    }
    for (let x = 0; x < w; x++) {
        v[jc * w + x] = (jc + 0.5 - cy) * gy[jc * w + x];
        for (let y = jc + 1; y < h; y++) v[y * w + x] = v[(y - 1) * w + x] + 0.5 * (gy[(y - 1) * w + x] + gy[y * w + x]);
        for (let y = jc - 1; y >= 0; y--) v[y * w + x] = v[(y + 1) * w + x] - 0.5 * (gy[(y + 1) * w + x] + gy[y * w + x]);
    }
    return { u, v };
}

/**
 * The box around the decal's centre that its wrapped pixels can reach: the surface is never shorter than the picture, so
 * a disc of half the decal's diagonal (in document pixels, after its scale) holds them; clamped to the picture.
 * @param {{ cx: number, cy: number, w: number, h: number }} place the decal's centre and size in document pixels
 * @param {number} W
 * @param {number} H
 * @returns {number[]|null}
 */
export function wrapBox(place, W, H, grow = 1) {
    const r = 0.5 * Math.hypot(place.w, place.h) * Math.max(1, grow) + 2;
    const x0 = Math.max(0, Math.floor(place.cx - r)), y0 = Math.max(0, Math.floor(place.cy - r));
    const x1 = Math.min(W, Math.ceil(place.cx + r)), y1 = Math.min(H, Math.ceil(place.cy + r));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/**
 * How much larger than its placed size a decal can land on the points' route: a surface nearer than the decal's centre
 * is shorter per picture pixel (z / z_c), so the decal covers more pixels there. z_c (the centre's depth) over the
 * nearest kept point's depth (`meta.lo[2]`), at most 4. 1 when the points cannot say.
 * @param {any} pmap a points map (packPoints)
 * @param {number} cx document pixels
 * @param {number} cy
 */
export function wrapGrow(pmap, cx, cy) {
    const meta = pmap && pmap.meta;
    if (!meta || !Array.isArray(meta.lo) || !Array.isArray(meta.hi) || !pmap.data) return 1;
    const pw = pmap.w, ph = pmap.h;
    const inv = xfInv(pmap.xf || [pw, 0, 0, ph, 0, 0]);
    const u = Math.max(0, Math.min(pw - 1, Math.floor((inv[0] * cx + inv[2] * cy + inv[4]) * pw)));
    const v = Math.max(0, Math.min(ph - 1, Math.floor((inv[1] * cx + inv[3] * cy + inv[5]) * ph)));
    const zc = meta.lo[2] + (pmap.data[3 * (v * pw + u) + 2] / 65535) * (meta.hi[2] - meta.lo[2]);
    if (!(zc > 0) || !(meta.lo[2] > 0)) return 1;
    return Math.max(1, Math.min(4, zc / meta.lo[2]));
}

/**
 * The decal wrapped onto the surface over `box`: straight RGBA (w * h * 4), bilinear from the decal's premultiplied
 * pixels, nothing outside the decal, times the region's alpha (`sel`, one byte per pixel of the box, or null).
 * @param {{ map: any, box: number[], decal: { data: ArrayLike<number>, width: number, height: number },
 *   place: { cx: number, cy: number, w: number, h: number, angle?: number }, sel?: Uint8Array|null, points?: any }} o
 *   place: the decal's centre and its size in document pixels; angle in degrees, clockwise on the screen
 */
/**
 * A decal at half its size: each pixel the alpha-weighted mean of a 2 x 2 block (its premultiplied mean), the alpha the
 * block's mean with pixels past an odd edge counted transparent, so pixel j covers the source's pixels 2j and 2j + 1.
 * @param {{ data: ArrayLike<number>, width: number, height: number }} src straight RGBA
 */
export function halveDecal(src) {
    const sw = src.width, sh = src.height, d = src.data;
    const w = Math.ceil(sw / 2), h = Math.ceil(sh / 2);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
            const xx = 2 * x + (k & 1), yy = 2 * y + (k >> 1);
            if (xx >= sw || yy >= sh) continue;
            const i = 4 * (yy * sw + xx), al = d[i + 3];
            r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
        }
        const o = 4 * (y * w + x);
        if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
        out[o + 3] = Math.round(a / 4);
    }
    return { data: out, width: w, height: h };
}

/**
 * The decal's level for a placement `place.w` x `place.h`: halved while it stays at least twice the placed size on both
 * axes, so the bilinear read below never skips source pixels (a 1,302 px text placed 237 px wide read every fifth pixel:
 * stair-stepped edges). -> { level, k } with 2^k source pixels per level pixel
 */
export function decalLevel(decal, place) {
    let level = decal, k = 0;
    while (decal.width / (1 << (k + 1)) >= place.w && decal.height / (1 << (k + 1)) >= place.h && level.width > 1 && level.height > 1) {
        level = halveDecal(level);
        k++;
    }
    return { level, k };
}

export function wrapDecal({ map, box, decal, place, sel = null, points = null }) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0, h = y1 - y0;
    // the points' perspective when the document has them, else the normals' orthographic slopes
    const { gx, gy } = (points && wrapSlopesPoints(points, map, box, place.cx, place.cy)) || wrapSlopes(map, box);
    const { u, v } = wrapCoords(gx, gy, w, h, place.cx - x0, place.cy - y0);
    const dw0 = decal.width, dh0 = decal.height;
    const sx = place.w / dw0, sy = place.h / dh0;
    // a decal placed much smaller than its pixels is read from a halved copy (decalLevel), in the source's coordinates
    const { level, k } = decalLevel(decal, place);
    const dw = level.width, dh = level.height, d = level.data, step = 1 << k;
    const th = ((place.angle || 0) * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
    const out = new Uint8ClampedArray(w * h * 4);
    const px = (xx, yy, c) => d[4 * (yy * dw + xx) + c];
    for (let i = 0; i < w * h; i++) {
        const m = sel ? sel[i] : 255;
        if (!m) continue;
        // turned back by the angle, then into the decal's pixels (its centre at its middle)
        const ur = co * u[i] + si * v[i], vr = -si * u[i] + co * v[i];
        const s0 = ur / sx + dw0 / 2 - 0.5, t0 = vr / sy + dh0 / 2 - 0.5;
        if (s0 < -0.5 || t0 < -0.5 || s0 > dw0 - 0.5 || t0 > dh0 - 0.5) continue;
        const s = (s0 + 0.5) / step - 0.5, t = (t0 + 0.5) / step - 0.5;
        const sa = Math.floor(s), ta = Math.floor(t), fs = s - sa, ft = t - ta;
        let pr = 0, pg = 0, pb = 0, pa = 0;
        for (let k = 0; k < 4; k++) {
            const xx = sa + (k & 1), yy = ta + (k >> 1);
            if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue;   // outside: transparent
            const wt = ((k & 1) ? fs : 1 - fs) * ((k >> 1) ? ft : 1 - ft);
            if (!wt) continue;
            const a = px(xx, yy, 3) * wt;
            pr += px(xx, yy, 0) * a; pg += px(xx, yy, 1) * a; pb += px(xx, yy, 2) * a; pa += a;
        }
        if (pa <= 0) continue;
        const o = 4 * i;
        out[o] = Math.round(pr / pa); out[o + 1] = Math.round(pg / pa); out[o + 2] = Math.round(pb / pa);
        out[o + 3] = Math.round((pa * m) / 255);
    }
    return out;
}
