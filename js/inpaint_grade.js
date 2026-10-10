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
