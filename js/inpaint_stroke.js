// Generated from DenRakEiw/scumble renderer/editor/inpaint_stroke.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * What a brush gesture does with the pointer before it paints (docs/PLAN_0_1_31.md §4 step 5): the pen's pressure through
 * a curve, and a stabiliser. Pure, no DOM, so tools/stroke_test.js runs it in plain Node.
 */

/** A pen's pressure (0..1) through the curve the options bar chose: "linear", "soft" (a light hand gives more) or "hard". */
export function pressureCurve(p, curve = "linear") {
    const v = Math.max(0, Math.min(1, +p || 0));
    return curve === "soft" ? Math.sqrt(v) : curve === "hard" ? v * v : v;
}

/**
 * A pull string (Krita's and Photoshop's "lazy" smoothing): the brush point stays where it is while the cursor moves within
 * `radius` of it, and beyond that it is pulled along the line to the cursor, `radius` behind; a trembling hand draws a
 * calm line and a corner is rounded by the string's length. The release draws the rest of the string to the cursor
 * (Krita's "finish line"). Coordinates in image pixels; the caller turns the options bar's screen pixels into them.
 */
export class Stabiliser {
    constructor(radius, x, y, pressure = 1) {
        this.r = Math.max(0, +radius || 0);
        this.x = x; this.y = y; this.p = pressure;
        this.cx = x; this.cy = y; this.cp = pressure;
    }

    /** The cursor at (x, y): the brush points to draw to, `[[x, y, pressure]]`, or none while the string is slack. */
    push(x, y, pressure = 1) {
        this.cx = x; this.cy = y; this.cp = pressure;
        const dx = x - this.x, dy = y - this.y, d = Math.hypot(dx, dy);
        if (!(d > this.r)) return [];
        const k = (d - this.r) / d;
        this.x += dx * k; this.y += dy * k; this.p = pressure;
        return [[this.x, this.y, pressure]];
    }

    /** The release: the rest of the string, to where the cursor was last (none when the brush is there already). */
    finish() {
        if (this.x === this.cx && this.y === this.cy) return [];
        this.x = this.cx; this.y = this.cy; this.p = this.cp;
        return [[this.x, this.y, this.cp]];
    }
}

// ---- the blur and sharpen brushes (PLAN_0_1_31 §4 step 6) -----------------------------------------

/** One box pass of radius r along the rows of a w x h float image of 4 channels, `src` into `dst`; the edges repeat. */
function boxRows(src, dst, w, h, r) {
    const k = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let i = -r; i <= r; i++) sum += src[row + Math.min(w - 1, Math.max(0, i)) * 4 + c];
            for (let x = 0; x < w; x++) {
                dst[row + x * 4 + c] = sum * k;
                sum += src[row + Math.min(w - 1, x + r + 1) * 4 + c] - src[row + Math.max(0, x - r) * 4 + c];
            }
        }
    }
}

/** The same down the columns. */
function boxCols(src, dst, w, h, r) {
    const k = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let i = -r; i <= r; i++) sum += src[(Math.min(h - 1, Math.max(0, i)) * w + x) * 4 + c];
            for (let y = 0; y < h; y++) {
                dst[(y * w + x) * 4 + c] = sum * k;
                sum += src[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - src[(Math.max(0, y - r) * w + x) * 4 + c];
            }
        }
    }
}

/**
 * A soft blur of straight RGBA8 (`w` x `h`): premultiplied, three box passes of radius `r` each way (close to a gaussian
 * of sigma r), back to straight bytes; colour 0 where the alpha comes out 0. A new Uint8ClampedArray.
 */
export function blurRGBA(src, w, h, r) {
    const n = w * h, a = new Float32Array(n * 4), b = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
        const al = src[i + 3] / 255;
        a[i] = src[i] * al; a[i + 1] = src[i + 1] * al; a[i + 2] = src[i + 2] * al; a[i + 3] = src[i + 3];
    }
    r = Math.max(0, Math.round(r));
    if (r > 0) for (let pass = 0; pass < 3; pass++) { boxRows(a, b, w, h, r); boxCols(b, a, w, h, r); }
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
        const al = a[i + 3];
        if (al < 0.5) continue;
        const k = 255 / al;
        out[i] = a[i] * k; out[i + 1] = a[i + 1] * k; out[i + 2] = a[i + 2] * k; out[i + 3] = al;
    }
    return out;
}

/**
 * Unsharp masking of straight RGBA8: colour + amount x (colour - its blur of radius r), clamped; the alpha stays. Pixels
 * the blur leaves transparent keep their bytes. A new Uint8ClampedArray.
 */
export function sharpenRGBA(src, w, h, r, amount = 1) {
    const bl = blurRGBA(src, w, h, r), out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
        out[i + 3] = src[i + 3];
        if (!src[i + 3] || !bl[i + 3]) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; continue; }
        for (let c = 0; c < 3; c++) out[i + c] = src[i + c] + amount * (src[i + c] - bl[i + c]);
    }
    return out;
}

/**
 * Dodge and burn (PLAN_0_1_31 §4 step 9): the tone curve of GIMP's Dodge / Burn tool (`gimp_gegl_dodgeburn` in
 * app/gegl/gimp-gegl-loops.cc, the same on 2.10 and 3.x; GPL-3.0 like this project) as a 256-entry table on the sRGB
 * values: `range` "shadows", "midtones" or "highlights", `exposure` 0..1, `burn` false for dodge. GIMP's third is the
 * literal 0.333333; its float result is clamped here, where GIMP's 8-bit layers clamp it on the write.
 */
export function toneLUT(range, exposure, burn = false) {
    const e = Math.max(0, Math.min(1, +exposure || 0)) * (burn ? -1 : 1);
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        const s = i / 255;
        let d;
        if (range === "highlights") d = s * (1 + e * 0.333333);
        else if (range === "shadows") {
            const f = 0.333333 * Math.abs(e);
            d = e >= 0 ? f + s - f * s : s < f ? 0 : (s - f) / (1 - f);
        } else d = Math.pow(s, e < 0 ? 1 - e * 0.333333 : 1 / (1 + e));
        lut[i] = Math.max(0, Math.min(255, Math.round(d * 255)));
    }
    return lut;
}

/**
 * A tone table on straight RGBA8, a new Uint8ClampedArray; the alpha stays and transparent pixels keep their bytes.
 * Per channel as GIMP does, or with `protect` (Protect tones, own): the table on the brightest channel, and the three
 * scaled alike above the table's floor lut[0] (only a shadows dodge lifts it: black goes to that grey, and a pixel a
 * level off black lands next to it, not on a saturated speck), which keeps the hue and cannot clip.
 */
export function toneRGBA(src, lut, protect = false) {
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2];
        out[i + 3] = src[i + 3];
        if (!src[i + 3]) { out[i] = r; out[i + 1] = g; out[i + 2] = b; continue; }
        if (!protect) { out[i] = lut[r]; out[i + 1] = lut[g]; out[i + 2] = lut[b]; continue; }
        const v = r > g ? (r > b ? r : b) : (g > b ? g : b), o = lut[0];
        if (!v) { out[i] = out[i + 1] = out[i + 2] = o; continue; }
        const k = (lut[v] - o) / v;
        out[i] = o + r * k; out[i + 1] = o + g * k; out[i + 2] = o + b * k;
    }
    return out;
}

/**
 * The sponge (own formula; Photoshop's is not published and GIMP has none): each channel moved from the pixel's luma
 * (BT.601 in integers) by a gain, `amount` 0..1 of the way to grey (desaturate) or up by that much (saturate). Saturating
 * stops where the first channel would clip, so the hue stays; `vibrance` scales it by 1 - the HSV saturation, so dull
 * colours gain more than vivid ones. Straight RGBA8 in, a new Uint8ClampedArray out, the alpha kept.
 */
export function spongeRGBA(src, amount, saturate = false, vibrance = true) {
    const k = Math.max(0, Math.min(1, +amount || 0));
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2];
        out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = src[i + 3];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (!src[i + 3] || mx === mn) continue;   // transparent or grey: nothing to move
        const y = (77 * r + 150 * g + 29 * b + 128) >> 8;
        let t;
        if (saturate) {
            t = 1 + k * (vibrance ? 1 - (mx - mn) / mx : 1);
            const lim = Math.min(mx > y ? (255 - y) / (mx - y) : Infinity, mn < y ? y / (y - mn) : Infinity);
            if (t > lim) t = Math.max(1, lim);
        } else t = 1 - k;
        out[i] = y + (r - y) * t; out[i + 1] = y + (g - y) * t; out[i + 2] = y + (b - y) * t;
    }
    return out;
}
