// Generated from DenRakEiw/scumble renderer/editor/inpaint_grade.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
/**
 * Colour grading mathematical foundation and table generator (PLAN_NIK9_BUILD sec 3.4 / R3-S2).
 *
 * Four ranges: shadows (sh), midtones (mid), highlights (hi), and global (glob).
 * Each range has hue (0..360), saturation (0..100), and brightness (-100..100).
 * Balance (-100..100) shifts the range split boundaries; Blending (0..100) controls the transition width.
 *
 * No DOM dependencies, pure ASCII.
 */

export const LUMA_601 = [0.299, 0.587, 0.114];
export const GRADE_RANGES = ["sh", "mid", "hi", "glob"];
export const K_TINT = 0.35 * 255;
export const K_LUM = 0.25 * 255;

/**
 * Pure hue (0..360) as [r, g, b] in 0..1.
 *
 * @param {number} hue
 * @returns {[number, number, number]}
 */
export function hueRgb(hue) {
    const h = (((hue % 360) + 360) % 360) / 60;
    const x = 1 - Math.abs((h % 2) - 1);
    const k = Math.floor(h) % 6;
    return k === 0 ? [1, x, 0] : k === 1 ? [x, 1, 0] : k === 2 ? [0, 1, x] : k === 3 ? [0, x, 1] : k === 4 ? [x, 0, 1] : [1, 0, x];
}

/**
 * Are all grading parameters at identity (all saturations and brightnesses zero)?
 *
 * @param {any} p
 * @returns {boolean}
 */
export function gradeIdentity(p) {
    if (!p || typeof p !== "object") return true;
    return !(
        (p.sh_sat && +p.sh_sat !== 0) ||
        (p.sh_lum && +p.sh_lum !== 0) ||
        (p.mid_sat && +p.mid_sat !== 0) ||
        (p.mid_lum && +p.mid_lum !== 0) ||
        (p.hi_sat && +p.hi_sat !== 0) ||
        (p.hi_lum && +p.hi_lum !== 0) ||
        (p.glob_sat && +p.glob_sat !== 0) ||
        (p.glob_lum && +p.glob_lum !== 0)
    );
}

/**
 * Standard cubic smoothstep.
 *
 * @param {number} e0
 * @param {number} e1
 * @param {number} x
 * @returns {number}
 */
function sstep(e0, e1, x) {
    if (x <= e0) return 0;
    if (x >= e1) return 1;
    const t = (x - e0) / (e1 - e0);
    return t * t * (3 - 2 * t);
}

/**
 * Range weights [ws, wm, wh] for normalized luma l in [0, 1].
 *
 * @param {number} l
 * @param {number} balance -100..100
 * @param {number} blending 0..100
 * @returns {[number, number, number]}
 */
export function gradeWeights(l, balance, blending) {
    const w = 0.02 + 0.146 * (Math.max(0, Math.min(100, blending)) / 100);
    const b = (Math.max(-100, Math.min(100, balance)) / 100) * 0.2;
    const p1 = (1 / 3) + b;
    const p2 = (2 / 3) + b;

    const ws = 1 - sstep(p1 - w, p1 + w, l);
    const wh = sstep(p2 - w, p2 + w, l);
    const wm = Math.max(0, 1 - ws - wh);
    return [ws, wm, wh];
}

/**
 * Zero-luma chromatic tint vector [r, g, b] in 0..255 units.
 *
 * @param {number} hue 0..360
 * @param {number} sat 0..100
 * @returns {[number, number, number]}
 */
export function tintOf(hue, sat) {
    const rgb = hueRgb(hue);
    const luma = LUMA_601[0] * rgb[0] + LUMA_601[1] * rgb[1] + LUMA_601[2] * rgb[2];
    const k = (Math.max(0, Math.min(100, sat || 0)) / 100) * K_TINT;
    return [
        (rgb[0] - luma) * k,
        (rgb[1] - luma) * k,
        (rgb[2] - luma) * k,
    ];
}

/**
 * Compute 256-entry channel offset lookup tables { dR, dG, dB } in 0..255 units.
 *
 * @param {any} p
 * @returns {{ dR: Float32Array, dG: Float32Array, dB: Float32Array }}
 */
export function colorGradeTables(p) {
    const dR = new Float32Array(256);
    const dG = new Float32Array(256);
    const dB = new Float32Array(256);
    if (!p || typeof p !== "object") return { dR, dG, dB };

    const balance = p.balance != null ? +p.balance : 0;
    const blending = p.blending != null ? +p.blending : 50;

    const tintSh = tintOf(p.sh_hue != null ? +p.sh_hue : 220, p.sh_sat != null ? +p.sh_sat : 0);
    const tintMid = tintOf(p.mid_hue != null ? +p.mid_hue : 30, p.mid_sat != null ? +p.mid_sat : 0);
    const tintHi = tintOf(p.hi_hue != null ? +p.hi_hue : 40, p.hi_sat != null ? +p.hi_sat : 0);
    const tintGlob = tintOf(p.glob_hue != null ? +p.glob_hue : 0, p.glob_sat != null ? +p.glob_sat : 0);

    const LSh = ((p.sh_lum != null ? +p.sh_lum : 0) / 100) * K_LUM;
    const LMid = ((p.mid_lum != null ? +p.mid_lum : 0) / 100) * K_LUM;
    const LHi = ((p.hi_lum != null ? +p.hi_lum : 0) / 100) * K_LUM;
    const LGlob = ((p.glob_lum != null ? +p.glob_lum : 0) / 100) * K_LUM;

    const shR = tintSh[0] + LSh, shG = tintSh[1] + LSh, shB = tintSh[2] + LSh;
    const midR = tintMid[0] + LMid, midG = tintMid[1] + LMid, midB = tintMid[2] + LMid;
    const hiR = tintHi[0] + LHi, hiG = tintHi[1] + LHi, hiB = tintHi[2] + LHi;
    const globR = tintGlob[0] + LGlob, globG = tintGlob[1] + LGlob, globB = tintGlob[2] + LGlob;

    for (let i = 0; i < 256; i++) {
        const l = i / 255;
        const [ws, wm, wh] = gradeWeights(l, balance, blending);
        dR[i] = ws * shR + wm * midR + wh * hiR + globR;
        dG[i] = ws * shG + wm * midG + wh * hiG + globG;
        dB[i] = ws * shB + wm * midB + wh * hiB + globB;
    }
    return { dR, dG, dB };
}

// ---------------------------------------------------------------------------
// 8-channel HSL (PLAN_NIK9_BUILD sec 3.4 / R3-S4)
// ---------------------------------------------------------------------------

export const HSL_CHANNELS = [
    { id: "red", label: "Red", hue: 0 },
    { id: "orange", label: "Orange", hue: 30 },
    { id: "yellow", label: "Yellow", hue: 60 },
    { id: "green", label: "Green", hue: 120 },
    { id: "aqua", label: "Aqua", hue: 180 },
    { id: "blue", label: "Blue", hue: 240 },
    { id: "purple", label: "Purple", hue: 270 },
    { id: "magenta", label: "Magenta", hue: 300 },
];

/**
 * Channel blend weights for hue in degrees (0..360).
 * Returns [k0, k1, w0, w1] where k0 and k1 are channel indices (0..7),
 * and w0 + w1 = 1.0 (partition of unity).
 *
 * @param {number} h
 * @returns {[number, number, number, number]}
 */
export function hslWeights(h) {
    let deg = ((h % 360) + 360) % 360;
    let k0 = 0, k1 = 1, h0 = 0, h1 = 30;
    if (deg < 30) {
        k0 = 0; k1 = 1; h0 = 0; h1 = 30;
    } else if (deg < 60) {
        k0 = 1; k1 = 2; h0 = 30; h1 = 60;
    } else if (deg < 120) {
        k0 = 2; k1 = 3; h0 = 60; h1 = 120;
    } else if (deg < 180) {
        k0 = 3; k1 = 4; h0 = 120; h1 = 180;
    } else if (deg < 240) {
        k0 = 4; k1 = 5; h0 = 180; h1 = 240;
    } else if (deg < 270) {
        k0 = 5; k1 = 6; h0 = 240; h1 = 270;
    } else if (deg < 300) {
        k0 = 6; k1 = 7; h0 = 270; h1 = 300;
    } else {
        k0 = 7; k1 = 0; h0 = 300; h1 = 360;
    }
    const t = (deg - h0) / (h1 - h0);
    const s = t * t * (3 - 2 * t);
    return [k0, k1, 1 - s, s];
}

/**
 * Are all HSL parameters at identity (all 24 channel adjustments zero)?
 *
 * @param {any} p
 * @returns {boolean}
 */
export function hslIdentity(p) {
    if (!p || typeof p !== "object") return true;
    for (const ch of HSL_CHANNELS) {
        if (p[`${ch.id}_h`] && +p[`${ch.id}_h`] !== 0) return false;
        if (p[`${ch.id}_s`] && +p[`${ch.id}_s`] !== 0) return false;
        if (p[`${ch.id}_l`] && +p[`${ch.id}_l`] !== 0) return false;
    }
    return true;
}

export const HSL_UNIFORMS = {
    u_h0: "vec4",
    u_h1: "vec4",
    u_s0: "vec4",
    u_s1: "vec4",
    u_l0: "vec4",
    u_l1: "vec4",
};

/**
 * Pack 24 HSL channel parameters into six vec4 uniforms (divided by 100).
 * Red..Green in *0 vectors, Aqua..Magenta in *1 vectors.
 *
 * @param {any} p
 * @returns {{ u_h0: [number, number, number, number], u_h1: [number, number, number, number], u_s0: [number, number, number, number], u_s1: [number, number, number, number], u_l0: [number, number, number, number], u_l1: [number, number, number, number] }}
 */
export function hslUniforms(p) {
    const q = p || {};
    const v = (k) => ((q[k] != null ? +q[k] : 0) || 0) / 100;
    return {
        u_h0: [v("red_h"), v("orange_h"), v("yellow_h"), v("green_h")],
        u_h1: [v("aqua_h"), v("blue_h"), v("purple_h"), v("magenta_h")],
        u_s0: [v("red_s"), v("orange_s"), v("yellow_s"), v("green_s")],
        u_s1: [v("aqua_s"), v("blue_s"), v("purple_s"), v("magenta_s")],
        u_l0: [v("red_l"), v("orange_l"), v("yellow_l"), v("green_l")],
        u_l1: [v("aqua_l"), v("blue_l"), v("purple_l"), v("magenta_l")],
    };
}

/**
 * Convert HSV to RGB (all inputs and outputs in 0..1).
 *
 * @param {number} h hue in degrees [0, 360)
 * @param {number} s saturation [0, 1]
 * @param {number} v value [0, 1]
 * @returns {[number, number, number]}
 */
function hsv2rgb(h, s, v) {
    const C = v * s;
    const hp = h / 60;
    const x = C * (1 - Math.abs((hp % 2) - 1));
    const m = v - C;
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = C; g = x; b = 0; }
    else if (hp < 2) { r = x; g = C; b = 0; }
    else if (hp < 3) { r = 0; g = C; b = x; }
    else if (hp < 4) { r = 0; g = x; b = C; }
    else if (hp < 5) { r = x; g = 0; b = C; }
    else { r = C; g = 0; b = x; }
    return [r + m, g + m, b + m];
}

/**
 * Apply HSL adjustments to a single RGB pixel in [0, 255] space.
 * Returns [r, g, b] in double precision [0, 255].
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {any} p
 * @returns {[number, number, number]}
 */
export function hslPixel(r, g, b, p) {
    const rf = r / 255;
    const gf = g / 255;
    const bf = b / 255;

    const mx = Math.max(rf, gf, bf);
    const mn = Math.min(rf, gf, bf);
    const C = mx - mn;

    // 1. amt = sstep(0, 0.25, C); when amt == 0, return [r, g, b]
    const amt = sstep(0, 0.25, C);
    if (amt === 0) return [r, g, b];

    // 2. HSV hue h in degrees
    let h = 0;
    if (C > 0) {
        if (mx === rf) {
            let seg = (gf - bf) / C;
            if (seg < 0) seg += 6;
            h = 60 * seg;
        } else if (mx === gf) {
            h = 60 * (((bf - rf) / C) + 2);
        } else {
            h = 60 * (((rf - gf) / C) + 4);
        }
    }
    const V = mx;
    const S = mx > 0 ? C / mx : 0;

    // 3. Channel weights
    const [k0, k1, w0, w1] = hslWeights(h);

    const q = p || {};
    const id0 = HSL_CHANNELS[k0].id;
    const id1 = HSL_CHANNELS[k1].id;

    const h0 = (q[`${id0}_h`] != null ? +q[`${id0}_h`] : 0) || 0;
    const h1 = (q[`${id1}_h`] != null ? +q[`${id1}_h`] : 0) || 0;
    const s0 = (q[`${id0}_s`] != null ? +q[`${id0}_s`] : 0) || 0;
    const s1 = (q[`${id1}_s`] != null ? +q[`${id1}_s`] : 0) || 0;
    const l0 = (q[`${id0}_l`] != null ? +q[`${id0}_l`] : 0) || 0;
    const l1 = (q[`${id1}_l`] != null ? +q[`${id1}_l`] : 0) || 0;

    // 4. dh, ds, dl
    const dh = ((w0 * h0 + w1 * h1) / 100) * 30 * amt;
    const ds = ((w0 * s0 + w1 * s1) / 100) * amt;
    const dl = ((w0 * l0 + w1 * l1) / 100) * amt;

    // 5. c1 = hsv2rgb(h + dh, S, V) (dh 0 gives c)
    let c1r = rf, c1g = gf, c1b = bf;
    if (Math.abs(dh) > 1e-9) {
        let hNew = ((h + dh) % 360 + 360) % 360;
        const [hr, hg, hb] = hsv2rgb(hNew, S, V);
        c1r = hr; c1g = hg; c1b = hb;
    }

    // 6. Y1 = luma601(c1); c2 = Y1 + (c1 - Y1) * max(0, 1 + ds)
    const Y1 = LUMA_601[0] * c1r + LUMA_601[1] * c1g + LUMA_601[2] * c1b;
    const satScale = Math.max(0, 1 + ds);
    const c2r = Y1 + (c1r - Y1) * satScale;
    const c2g = Y1 + (c1g - Y1) * satScale;
    const c2b = Y1 + (c1b - Y1) * satScale;

    // 7. Y3 = dl >= 0 ? Y1 + (1 - Y1) * dl * 0.5 : Y1 * (1 + dl * 0.5)
    //    c3 = c2 + (Y3 - Y1); clamp to 0..1
    const Y3 = dl >= 0 ? Y1 + (1 - Y1) * dl * 0.5 : Y1 * (1 + dl * 0.5);
    const dY = Y3 - Y1;
    const c3r = Math.min(1, Math.max(0, c2r + dY));
    const c3g = Math.min(1, Math.max(0, c2g + dY));
    const c3b = Math.min(1, Math.max(0, c2b + dY));

    return [c3r * 255, c3g * 255, c3b * 255];
}

export const HSL_GLSL = `
float sstep(float e0, float e1, float x) {
    return smoothstep(e0, e1, x);
}

float getHslCh(vec4 v0, vec4 v1, int idx) {
    if (idx == 0) return v0.x;
    if (idx == 1) return v0.y;
    if (idx == 2) return v0.z;
    if (idx == 3) return v0.w;
    if (idx == 4) return v1.x;
    if (idx == 5) return v1.y;
    if (idx == 6) return v1.z;
    return v1.w;
}

void getHslWeights(float deg, out int k0, out int k1, out float w0, out float w1) {
    float h0 = 0.0;
    float h1 = 30.0;
    if (deg < 30.0) {
        k0 = 0; k1 = 1; h0 = 0.0; h1 = 30.0;
    } else if (deg < 60.0) {
        k0 = 1; k1 = 2; h0 = 30.0; h1 = 60.0;
    } else if (deg < 120.0) {
        k0 = 2; k1 = 3; h0 = 60.0; h1 = 120.0;
    } else if (deg < 180.0) {
        k0 = 3; k1 = 4; h0 = 120.0; h1 = 180.0;
    } else if (deg < 240.0) {
        k0 = 4; k1 = 5; h0 = 180.0; h1 = 240.0;
    } else if (deg < 270.0) {
        k0 = 5; k1 = 6; h0 = 240.0; h1 = 270.0;
    } else if (deg < 300.0) {
        k0 = 6; k1 = 7; h0 = 270.0; h1 = 300.0;
    } else {
        k0 = 7; k1 = 0; h0 = 300.0; h1 = 360.0;
    }
    float t = (deg - h0) / (h1 - h0);
    float s = t * t * (3.0 - 2.0 * t);
    w0 = 1.0 - s;
    w1 = s;
}

vec3 hsv2rgb(float h, float s, float v) {
    float C = v * s;
    float hp = h / 60.0;
    float x = C * (1.0 - abs(mod(hp, 2.0) - 1.0));
    float m = v - C;
    vec3 rgb;
    if (hp < 1.0) rgb = vec3(C, x, 0.0);
    else if (hp < 2.0) rgb = vec3(x, C, 0.0);
    else if (hp < 3.0) rgb = vec3(0.0, C, x);
    else if (hp < 4.0) rgb = vec3(0.0, x, C);
    else if (hp < 5.0) rgb = vec3(x, 0.0, C);
    else rgb = vec3(C, 0.0, x);
    return rgb + vec3(m);
}

vec4 shade(vec4 c, vec2 uv) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float C = mx - mn;
    float amt = smoothstep(0.0, 0.25, C);
    if (amt <= 0.0) return c;

    float h = 0.0;
    if (C > 0.0) {
        if (mx == c.r) {
            float seg = (c.g - c.b) / C;
            if (seg < 0.0) seg += 6.0;
            h = 60.0 * seg;
        } else if (mx == c.g) {
            h = 60.0 * (((c.b - c.r) / C) + 2.0);
        } else {
            h = 60.0 * (((c.r - c.g) / C) + 4.0);
        }
    }
    float V = mx;
    float S = mx > 0.0 ? C / mx : 0.0;

    int k0, k1;
    float w0, w1;
    getHslWeights(h, k0, k1, w0, w1);

    float h0 = getHslCh(u_h0, u_h1, k0);
    float h1 = getHslCh(u_h0, u_h1, k1);
    float s0 = getHslCh(u_s0, u_s1, k0);
    float s1 = getHslCh(u_s0, u_s1, k1);
    float l0 = getHslCh(u_l0, u_l1, k0);
    float l1 = getHslCh(u_l0, u_l1, k1);

    float dh = (w0 * h0 + w1 * h1) * 30.0 * amt;
    float ds = (w0 * s0 + w1 * s1) * amt;
    float dl = (w0 * l0 + w1 * l1) * amt;

    vec3 c1 = c.rgb;
    if (abs(dh) > 0.00001) {
        float hNew = mod(h + dh, 360.0);
        if (hNew < 0.0) hNew += 360.0;
        c1 = hsv2rgb(hNew, S, V);
    }

    const vec3 lumaVec = vec3(0.299, 0.587, 0.114);
    float Y1 = dot(c1, lumaVec);
    float satScale = max(0.0, 1.0 + ds);
    vec3 c2 = vec3(Y1) + (c1 - vec3(Y1)) * satScale;

    float Y3 = dl >= 0.0 ? Y1 + (1.0 - Y1) * dl * 0.5 : Y1 * (1.0 + dl * 0.5);
    vec3 c3 = c2 + vec3(Y3 - Y1);

    return vec4(clamp(c3, 0.0, 1.0), c.a);
}
`;

