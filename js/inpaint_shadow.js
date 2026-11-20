// Generated from scumble-app/scumble renderer/editor/inpaint_shadow.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// A contact shadow from a layer's coverage (item 61, docs/PLAN_0_1_57.md): the shape, squashed toward its lowest opaque
// edge (the foot) and blurred, darkest where it touches the ground and fading with the distance from it. Procedural, no
// model. This module is the arithmetic on a coverage grid at a working scale (no DOM, no editor); the editor's side is
// `inpaint_ed_shadow.js`.
//
// The grid: `alpha` is the layer's coverage 0..1, `w` x `h` cells. The shadow below the foot is the coverage mirrored
// about the foot and squashed so the object's height maps to the reach R (`distance` % of the height), sheared
// sideways by `skew` (% of R at the far end), and faded by (1 - d / R)^1.5 with the distance d below the foot. A few rows
// above the foot (hidden behind the object where it is opaque) take the contact profile, the coverage of the bottom
// rows, so the darkest place is the foot itself and not a row under it. Two blurs, a narrow one at the contact and the
// softness at the far end, are mixed by d / R. A depth sampler, when given, fades the shadow where the ground lies much
// farther than the foot (behind the edge of a table, a wall far back).

import { gaussBlur } from "./inpaint_edges.js";

export const SHADOW_DEFAULTS = Object.freeze({ distance: 30, softness: 8, opacity: 0.8, skew: 0 });

/** The working grid's long side for the dialog's preview and for the layer that is made. */
export const SHADOW_WORK_PREVIEW = 768;
export const SHADOW_WORK = 2048;
/**
 * The most cells the shadow's own grid may have (the preview's and the layer's): a long reach, a wide softness or a
 * strong skew grow it far past the object's box (Softness 100 pads it by three times the object's height on every
 * side), so the coverage is made coarser until it fits (`shadowExtent`, `coarserCoverage`). Such a shadow is soft
 * anyway. Four float arrays and the blurs' scratch of 4 M cells are about 100 MB.
 */
export const SHADOW_MAX_CELLS = 4e6;
export const SHADOW_MAX_CELLS_PREVIEW = 1e6;

/** The coverage that counts as the object (the box and the foot). */
const SOLID = 0.5;
/** Depth: farther than the foot by more than TOL starts to fade, gone at TOL + RAMP (depth 0..1, near to far). */
const DEPTH_TOL = 0.04, DEPTH_RAMP = 0.08;
/** A shadow value below this is nothing (the layer's box is trimmed to the rest). */
const EPS = 1 / 512;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (v == null || v === "" || !Number.isFinite(+v) ? d : +v);

/**
 * The parameters made whole: distance 1..300 (% of the object's height the shadow reaches below its foot), softness
 * 0..100 (% of the height, the blur at the far end), opacity 0..1 (the layer's), skew -100..100 (% of the reach the far
 * end is shifted sideways; positive to the right).
 */
export function shadowParams(p = {}) {
    return {
        distance: clamp(num(p.distance, SHADOW_DEFAULTS.distance), 1, 300),
        softness: clamp(num(p.softness, SHADOW_DEFAULTS.softness), 0, 100),
        opacity: clamp(num(p.opacity, SHADOW_DEFAULTS.opacity), 0, 1),
        skew: clamp(num(p.skew, SHADOW_DEFAULTS.skew), -100, 100),
    };
}

/**
 * The object's box in the grid (cells with coverage >= `solid`, inclusive bounds) and its foot (the lowest such row).
 * Null when no cell is that opaque.
 */
export function alphaBox(alpha, w, h, solid = SOLID) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        let any = false;
        for (let x = 0; x < w; x++) {
            if (alpha[row + x] >= solid) {
                any = true;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
            }
        }
        if (any) { if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1, foot: y1 };
}

/** Bilinear coverage at (x, y) in cell units (cell centres on whole numbers), 0 outside the grid. */
function sample(alpha, w, h, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < -1 || yi < -1 || xi >= w || yi >= h) return 0;
    const fx = x - xi, fy = y - yi;
    const l = xi >= 0, r = xi + 1 < w, t = yi >= 0, b = yi + 1 < h;
    const i = yi * w + xi;
    const a00 = l && t ? alpha[i] : 0, a10 = r && t ? alpha[i + 1] : 0;
    const a01 = l && b ? alpha[i + w] : 0, a11 = r && b ? alpha[i + w + 1] : 0;
    const top = a00 + (a10 - a00) * fx, bot = a01 + (a11 - a01) * fx;
    return top + (bot - top) * fy;
}

/** The shadow grid's place and size for an object `box` (alphaBox) and whole parameters `p`, in coverage cells. */
function extentOf(box, p) {
    const foot = box.foot;
    const H = box.y1 - box.y0 + 1;
    const R = Math.max(1, (H * p.distance) / 100);
    const sigma = (H * p.softness) / 100;
    const sigmaCore = Math.max(0.5, sigma * 0.2);
    const k = p.skew / 100;
    const up = Math.max(2, Math.ceil(2 * sigmaCore + 0.02 * H));
    const pad = Math.ceil(3 * Math.max(sigma, sigmaCore)) + 2;
    const shift = k * R;
    const gx0 = Math.floor(box.x0 - pad + Math.min(0, shift)), gx1 = Math.ceil(box.x1 + pad + Math.max(0, shift)) + 1;
    const gy0 = Math.floor(foot - up - pad), gy1 = Math.ceil(foot + R + pad) + 1;
    return { foot, H, R, sigma, sigmaCore, k, up, gx0, gy0, gw: gx1 - gx0, gh: gy1 - gy0 };
}

/**
 * How many cells the shadow grid of this coverage would have for `params`, with the object's box: `{ cells, box }`,
 * null when the coverage has no opaque cell.
 */
export function shadowExtent(alpha, w, h, params = {}) {
    const box = alphaBox(alpha, w, h);
    if (!box) return null;
    const e = extentOf(box, shadowParams(params));
    return { cells: e.gw * e.gh, box };
}

/**
 * A coverage source made `f` times coarser (whole f x f blocks averaged, the last ones partial): `{ alpha, w, h }` and
 * the rest of `src` with its scales divided by `f`, so the image mapping (`x0 + (cell + 0.5) / sx`) still holds.
 */
export function coarserCoverage(src, f) {
    const w = Math.max(1, Math.ceil(src.w / f)), h = Math.max(1, Math.ceil(src.h / f));
    const sum = new Float32Array(w * h), n = new Float32Array(w * h);
    for (let y = 0; y < src.h; y++) {
        const row = ((y / f) | 0) * w, srow = y * src.w;
        for (let x = 0; x < src.w; x++) { const i = row + ((x / f) | 0); sum[i] += src.alpha[srow + x]; n[i] += 1; }
    }
    for (let i = 0; i < sum.length; i++) sum[i] = n[i] ? sum[i] / n[i] : 0;
    return { ...src, alpha: sum, w, h, sx: src.sx / f, sy: src.sy / f };
}

/**
 * The shadow of the coverage grid `alpha` (`w` x `h`, 0..1). `depthAt(x, y)`, optional, is the depth (0..1, near to
 * far) at a cell position of this grid (it may be asked outside it). Returns the shadow strength 0..1 on a grid of its
 * own, `{ data, w, h, x, y, box, foot, reach, trim }`: its cell (0, 0) is cell (x, y) of the coverage grid, `trim`
 * [x0, y0, x1, y1) the part above EPS in its own cells (null when nothing is). Null when the coverage has no opaque cell.
 */
export function contactShadow({ alpha, w, h, params = {}, depthAt = null, box = null }) {
    box = box || alphaBox(alpha, w, h);
    if (!box) return null;
    const p = shadowParams(params);
    const { foot, H, R, sigma, sigmaCore, k, up, gx0, gy0, gw, gh } = extentOf(box, p);
    // the contact profile: per column the most opaque of the bottom rows (a foot, a table leg, a box's lower edge)
    const cRows = Math.max(1, Math.round(0.03 * H));
    const prof = new Float32Array(w);
    for (let y = Math.max(0, foot - cRows + 1); y <= foot; y++) for (let x = 0; x < w; x++) prof[x] = Math.max(prof[x], alpha[y * w + x]);
    const src = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        const d = gy0 + gy - foot;
        if (d < -up || d > R) continue;
        const row = gy * gw;
        if (d <= 0) {
            for (let gx = 0; gx < gw; gx++) { const x = gx0 + gx; if (x >= 0 && x < w) src[row + gx] = prof[x]; }
            continue;
        }
        const fade = Math.pow(1 - d / R, 1.5);
        const sy = foot - (d * H) / R, dx = k * d;
        for (let gx = 0; gx < gw; gx++) src[row + gx] = sample(alpha, w, h, gx0 + gx - dx, sy) * fade;
    }
    const core = gaussBlur(src, gw, gh, sigmaCore);
    const soft = sigma > sigmaCore ? gaussBlur(src, gw, gh, sigma) : core;
    const out = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        const d = gy0 + gy - foot;
        const t = d <= 0 ? 0 : Math.pow(Math.min(1, d / R), 0.75);
        const row = gy * gw;
        for (let gx = 0; gx < gw; gx++) { const i = row + gx; out[i] = clamp(core[i] + (soft[i] - core[i]) * t, 0, 1); }
    }
    let footDepth = null;
    if (typeof depthAt === "function") {
        // the depth under the contact: the median over the columns the object stands on
        const cols = [];
        for (let x = box.x0; x <= box.x1; x++) if (prof[x] >= SOLID) cols.push(x);
        const step = Math.max(1, Math.floor(cols.length / 64));
        const ds = [];
        for (let i = 0; i < cols.length; i += step) { const v = depthAt(cols[i], foot); if (Number.isFinite(v)) ds.push(v); }
        ds.sort((a, b) => a - b);
        if (ds.length) footDepth = ds[ds.length >> 1];
        if (footDepth != null) {
            for (let gy = 0; gy < gh; gy++) {
                const row = gy * gw;
                for (let gx = 0; gx < gw; gx++) {
                    const i = row + gx;
                    if (out[i] < EPS) continue;
                    const dd = depthAt(gx0 + gx, gy0 + gy) - footDepth;
                    if (dd > DEPTH_TOL) out[i] *= clamp(1 - (dd - DEPTH_TOL) / DEPTH_RAMP, 0, 1);
                }
            }
        }
    }
    let tx0 = gw, ty0 = gh, tx1 = 0, ty1 = 0;
    for (let gy = 0; gy < gh; gy++) {
        const row = gy * gw;
        for (let gx = 0; gx < gw; gx++) {
            if (out[row + gx] < EPS) continue;
            if (gx < tx0) tx0 = gx;
            if (gx + 1 > tx1) tx1 = gx + 1;
            if (gy < ty0) ty0 = gy;
            ty1 = gy + 1;
        }
    }
    return { data: out, w: gw, h: gh, x: gx0, y: gy0, box, foot, reach: R, footDepth, trim: tx1 > tx0 ? [tx0, ty0, tx1, ty1] : null };
}

/**
 * The shadow grid's strength at a position of its own cells (bilinear, centres on whole numbers, 0 outside): the
 * full-size layer is sampled from it.
 */
export function shadowAt(grid, x, y) {
    return sample(grid.data, grid.w, grid.h, x, y);
}
