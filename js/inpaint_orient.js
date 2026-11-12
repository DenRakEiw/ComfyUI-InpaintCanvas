// Generated from DenRakEiw/scumble renderer/editor/inpaint_orient.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// orientation, transform-matrix, text-angle and auto-crop helpers: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { textAngle, textFrame } from "./inpaint_text.js";
import { XF_IDENTITY, xfBox, xfMul, xfRotate, xfTranslate } from "./inpaint_resample.js";

/**
 * An orientation `{ turn, flip }` (quarter turns clockwise after an optional horizontal mirror) with one more flip or turn
 * ("h", "v", 1, -1, 2) done on top of it: a text layer keeps its own as it is turned (PLAN_0_1_31 §7). A mirror reverses
 * the turns before it (H R^t = R^-t H), and "v" is a half turn after "h".
 */
function composeOrient(o, op) {
    let turn = ((o && o.turn) | 0) & 3, flip = !!(o && o.flip);
    if (op === 1) turn = (turn + 1) & 3;
    else if (op === -1) turn = (turn + 3) & 3;
    else if (op === 2) turn = (turn + 2) & 3;
    else if (op === "h") { flip = !flip; turn = (4 - turn) & 3; }
    else if (op === "v") { flip = !flip; turn = (6 - turn) & 3; }
    return { turn, flip };
}

/** The `turned` ops that bring upright pixels into orientation `o`: the mirror first, then the turn. */
function orientOps(o) {
    const ops = [], turn = ((o && o.turn) | 0) & 3;
    if (o && o.flip) ops.push("h");
    if (turn) ops.push(turn === 1 ? 1 : turn === 2 ? 2 : -1);
    return ops;
}

/** The orientation of `first` followed by `then` (both `{ turn, flip }`). */
function orientChain(first, then) {
    let r = { turn: ((first && first.turn) | 0) & 3, flip: !!(first && first.flip) };
    for (const op of orientOps(then)) r = composeOrient(r, op);
    return r;
}

const orientIsUp = (o) => !o || (!(((o.turn | 0) & 3)) && !o.flip);

/** A W x H picture's size after a flip or a turn. */
function turnSize(op, W, H) { return op === 1 || op === -1 ? [H, W] : [W, H]; }

/** A point of a W x H picture (image units, not pixel indices) after a flip or a turn: clockwise (X, Y) = (H - y, x). */
function turnPoint(op, x, y, W, H) {
    if (op === "h") return [W - x, y];
    if (op === "v") return [x, H - y];
    if (op === 2) return [W - x, H - y];
    if (op === 1) return [H - y, x];
    return [y, W - x];
}

/** A rectangle [x, y, w, h] of a W x H picture after a flip or a turn. */
function turnRect(op, x, y, w, h, W, H) {
    const [ax, ay] = turnPoint(op, x, y, W, H), [bx, by] = turnPoint(op, x + w, y + h, W, H);
    return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}

/** The canvas transform [a, b, c, d, e, f] that draws a w x h picture in orientation `o` (the mirror, then the turn). */
function orientMatrix(o, w, h) {
    let m = [1, 0, 0, 1, 0, 0], W = w, H = h;
    for (const op of orientOps(o)) {
        const t = op === "h" ? [-1, 0, 0, 1, W, 0] : op === 2 ? [-1, 0, 0, -1, W, H] : op === 1 ? [0, 1, -1, 0, H, 0] : [0, -1, 1, 0, 0, W];
        // t after m: (X, Y) = t(m(x, y))
        m = [t[0] * m[0] + t[2] * m[1], t[1] * m[0] + t[3] * m[1], t[0] * m[2] + t[2] * m[3], t[1] * m[2] + t[3] * m[3],
            t[0] * m[4] + t[2] * m[5] + t[4], t[1] * m[4] + t[3] * m[5] + t[5]];
        [W, H] = turnSize(op, W, H);
    }
    return m;
}

/** The image-to-image map of a document flip or turn of a W x H picture (image units): clockwise (x, y) -> (H - y, x). */
function xfOfOp(op, W, H) {
    if (op === "h") return [-1, 0, 0, 1, W, 0];
    if (op === "v") return [1, 0, 0, -1, 0, H];
    if (op === 2) return [-1, 0, 0, -1, W, H];
    if (op === 1) return [0, 1, -1, 0, H, 0];
    return [0, -1, 1, 0, 0, W];
}

// the signs of the linear parts of the eight orientations (orientMatrix of a unit picture): a map with one of these
// patterns only moves, scales, turns by quarters and mirrors
const ORIENT_SIGNS = [];
for (let turn = 0; turn < 4; turn++) {
    for (const flip of [false, true]) ORIENT_SIGNS.push({ o: { turn, flip }, s: orientMatrix({ turn, flip }, 1, 1).slice(0, 4).map((v) => Math.sign(v) || 0) });
}

/**
 * The orientation `{ turn, flip }` of a map whose linear part is quarter turns and mirrors with positive scales (a crop,
 * an extend, a resize, a flip, a turn and any chain of them), null for any other (a straighten).
 */
function orientOfXf(m) {
    const eps = 1e-9 * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3]));
    const s = m.slice(0, 4).map((v) => (Math.abs(v) <= eps ? 0 : Math.sign(v)));
    if (!((s[0] && s[3] && !s[1] && !s[2]) || (!s[0] && !s[3] && s[1] && s[2]))) return null;
    const hit = ORIENT_SIGNS.find((r) => r.s.every((v, i) => v === s[i]));
    return hit ? { ...hit.o } : null;
}

/** A value within a millionth of a whole number is that number: maps chained in doubles drift by 1e-12. */
const snapNum = (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-6 ? r : v; };

/** A map with its shift snapped (never its linear part: a straighten by a hundredth of a degree is no identity). */
const snapXf = (m) => [m[0], m[1], m[2], m[3], snapNum(m[4]), snapNum(m[5])];

/** Is this a usable map: six finite numbers that can be inverted? */
const validXf = (m) => Array.isArray(m) && m.length === 6 && m.every(Number.isFinite) && Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-12;

const xfIsIdentity = (m) => Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12
    && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;

/**
 * Where a results-history entry's file lies in the document: its unit square to the document. An entry that went
 * through a straighten keeps this map itself (`xf`); any other is its rectangle with its file turned into `orient`.
 */
function placeXf(h) {
    if (validXf(h.xf)) return h.xf;
    return xfMul([h.w, 0, 0, h.h, h.x, h.y], orientIsUp(h.orient) ? XF_IDENTITY : orientMatrix(h.orient, 1, 1));
}

/** An angle in degrees brought into (-180, 180]. */
const normDeg = (a) => { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; };

/**
 * A text description with one more flip or turn of its layer or the document (PLAN_0_1_31 §7): the turn and the mirror
 * compose as `composeOrient` says, and a mirror negates the free angle (H R(a) = R(-a) H); a turn leaves it.
 */
function composeTextOrient(t, op) {
    const a = textAngle(t), out = { ...t, ...composeOrient(t, op) };
    if (a) out.angle = op === "h" || op === "v" ? -a : a; else delete out.angle;
    return out;
}

/** How far a text is turned on the screen in all, its quarter turns and its free angle, in (-180, 180]. */
const textTotalAngle = (t) => normDeg(textAngle(t) + 90 * (((t && t.turn) | 0) & 3));

/**
 * A text description turned by `delta` degrees more on the screen (clockwise): whole quarters go into `turn`, what is
 * left (at most 45 degrees either way) is the free `angle`, and a turn of whole quarters keeps the exact path.
 */
function spinText(t, delta) {
    const total = textAngle(t) + delta;
    const q = Math.round(total / 90);
    let angle = total - 90 * q;
    if (Math.abs(angle) < 1e-6) angle = 0;
    const out = { ...t, turn: ((((t && t.turn) | 0) + q) % 4 + 4) & 3, flip: !!(t && t.flip) };
    if (angle) out.angle = Math.round(angle * 1e6) / 1e6; else delete out.angle;
    return out;
}

/**
 * The upright size of a text layer's render [uw, uh] (render pixels): its description's `box`, or, for a text rendered
 * before the angle existed, its pixels with the turn taken off.
 */
function textBox(l) {
    const b = l.text && l.text.box;
    if (Array.isArray(b) && b.length === 2 && b.every((v) => v > 0)) return b;
    const odd = ((l.text && l.text.turn) | 0) & 1, w = l.px ? l.px.width : 1, h = l.px ? l.px.height : 1;
    return odd ? [h, w] : [w, h];
}

/** Where the corner a text starts at (its upright top left) lies in a text layer's box, as fractions of it. */
function textStartFraction(l) {
    const [uw, uh] = textBox(l), f = textFrame(uw, uh, l.text);
    return [f.start[0] / f.W, f.start[1] / f.H];
}

/**
 * The largest frame of the aspect `ratio` (w / h; null for any) inside a W x H picture turned by `deg` degrees about its
 * centre, centred on it (PLAN_0_1_31 §7, 23b): [x, y, w, h] in frame space (the turned picture as the screen shows it,
 * image space at 0 degrees), whole pixels, rounded inwards. The free case is the known largest rectangle in a turned one.
 */
function autoCropFrame(W, H, deg, ratio = null) {
    const r = Math.abs(deg) * Math.PI / 180, C = Math.abs(Math.cos(r)), S = Math.abs(Math.sin(r));
    let w, h;
    if (ratio) {
        h = Math.min(W / (ratio * C + S), H / (ratio * S + C));
        w = ratio * h;
    } else if (S < 1e-12) {
        w = W; h = H;
    } else {
        const long = Math.max(W, H), short = Math.min(W, H);
        if (short <= 2 * S * C * long || Math.abs(S - C) < 1e-10) {
            const x = short / 2;
            [w, h] = W >= H ? [x / S, x / C] : [x / C, x / S];
        } else {
            const c2 = C * C - S * S;
            w = (W * C - H * S) / c2; h = (H * C - W * S) / c2;
        }
    }
    w = Math.max(8, Math.floor(w + 1e-6)); h = Math.max(8, Math.floor(h + 1e-6));
    // the same parity as the picture, so the frame sits exactly in the middle: a half-pixel offset put 0.5 % of the
    // fitted frames just past frameInside's slack (the 23b review)
    if ((W - w) & 1) w += w > 8 ? -1 : 1;
    if ((H - h) & 1) h += h > 8 ? -1 : 1;
    return [(W - w) / 2, (H - h) / 2, w, h];
}

/**
 * Does the frame [x, y, w, h] (frame space) lie inside a W x H picture turned by `deg` about its centre? Its centre in
 * the picture's own axes plus its half extents there, against the picture's half size (half a pixel of slack: the
 * rounding of a fitted frame).
 */
function frameInside(W, H, deg, x, y, w, h) {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), C = Math.abs(c), S = Math.abs(s);
    const dx = x + w / 2 - W / 2, dy = y + h / 2 - H / 2;
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    return Math.abs(u) + (w / 2) * C + (h / 2) * S <= W / 2 + 0.5 && Math.abs(v) + (w / 2) * S + (h / 2) * C <= H / 2 + 0.5;
}

/** The image-to-image map of a straighten: the picture turned by `deg` about its centre, then the frame's origin at 0, 0. */
const straightenXf = (W, H, deg, x, y) => xfMul(xfTranslate(-x, -y), xfRotate(deg, W / 2, H / 2));

/** The new rectangle of a layer's box under a map: its bounding box on whole pixels, outwards. */
function boxOnPixels(m, x, y, w, h) {
    const b = xfBox(m, x, y, x + w, y + h);
    const x0 = Math.floor(snapNum(b[0])), y0 = Math.floor(snapNum(b[1]));
    return [x0, y0, Math.max(1, Math.ceil(snapNum(b[2])) - x0), Math.max(1, Math.ceil(snapNum(b[3])) - y0)];
}

export { autoCropFrame, boxOnPixels, composeTextOrient, frameInside, normDeg, orientChain, orientIsUp, orientMatrix, orientOfXf, orientOps, placeXf, snapNum, snapXf, spinText, straightenXf, textBox, textStartFraction, textTotalAngle, turnRect, turnSize, validXf, xfIsIdentity, xfOfOp };
