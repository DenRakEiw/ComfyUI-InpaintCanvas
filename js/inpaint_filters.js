// Inpaint Canvas - filter layers (grain, sharpen, blur, levels, curves,
// brightness / contrast, hue / saturation, colour balance, black & white,
// invert, LUT, vignette).
//
// A filter layer has no pixels of its own: it takes everything composited below
// it (an image-sized canvas) and returns a filtered canvas of the same size. The
// editor caches that result per layer and applies mask, opacity and blend mode
// like for any other layer. Everything here is plain Canvas 2D / pixel loops;
// blurs go through ctx.filter (GPU). Kept separate from inpaint_canvas.js so the
// editor file does not grow with every filter. The point adjustments below are
// 256-entry tables and 3x3 matrices, one pass over the pixels each; the curves
// editor control lives in inpaint_curves.js.

import { curveDefaults, curvesToTables, buildCurvesControl } from "./inpaint_curves.js";

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

/** Deterministic 32-bit RNG (mulberry32) so grain does not change on every recompute. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------------------------
// grain
// ---------------------------------------------------------------------------

// Film stocks: grain character (amount, grain size in px on a ~2000 px image,
// colour share of the noise) plus a parametric colour character ("look":
// saturation, contrast, warmth, tint, fade, an optional channel mix and a
// black-and-white weighting). Approximations of how the stocks are described,
// not measurements. A real film LUT below a grain layer is still the more
// faithful colour rendering; the look here is meant to get close quickly.
const NEG = "Colour negative", SLIDE = "Slide", BW = "Black & white", CINE = "Cine", FX = "Special & artistic";
export const GRAIN_PRESETS = [
    { id: "custom", label: "Custom" },
    // colour negative
    { id: "ektar100", group: NEG, label: "Kodak Ektar 100", amount: 10, size: 1.1, speckle: 36, chroma: 20, look: { sat: 25, contrast: 10, warmth: 6 } },
    { id: "portra160", group: NEG, label: "Kodak Portra 160", amount: 12, size: 1.2, speckle: 36, chroma: 25, look: { sat: -6, contrast: -4, warmth: 8, fade: 3 } },
    { id: "portra400", group: NEG, label: "Kodak Portra 400", amount: 18, size: 1.5, speckle: 36, chroma: 30, look: { sat: -3, contrast: -4, warmth: 9, fade: 4 } },
    { id: "portra800", group: NEG, label: "Kodak Portra 800", amount: 28, size: 1.9, speckle: 36, chroma: 35, look: { sat: 2, contrast: 0, warmth: 10, fade: 3 } },
    { id: "gold200", group: NEG, label: "Kodak Gold 200", amount: 20, size: 1.5, speckle: 36, chroma: 45, look: { sat: 15, contrast: 6, warmth: 16 } },
    { id: "colorplus200", group: NEG, label: "Kodak ColorPlus 200", amount: 24, size: 1.6, speckle: 36, chroma: 50, look: { sat: 10, contrast: 8, warmth: 12 } },
    { id: "ultramax400", group: NEG, label: "Kodak UltraMax 400", amount: 26, size: 1.7, speckle: 36, chroma: 50, look: { sat: 18, contrast: 6, warmth: 10 } },
    { id: "fujic200", group: NEG, label: "Fujifilm 200 (C200)", amount: 22, size: 1.5, speckle: 36, chroma: 45, look: { sat: 8, contrast: 4, warmth: -3, tint: -6 } },
    { id: "superia400", group: NEG, label: "Fujifilm Superia 400", amount: 24, size: 1.6, speckle: 36, chroma: 50, look: { sat: 12, contrast: 6, warmth: -5, tint: -8 } },
    { id: "pro400h", group: NEG, label: "Fujifilm Pro 400H", amount: 18, size: 1.5, speckle: 36, chroma: 25, look: { sat: -5, contrast: -4, warmth: -6, tint: -6, fade: 3 } },
    { id: "lomo800", group: NEG, label: "Lomography Color 800", amount: 34, size: 2.0, speckle: 36, chroma: 55, look: { sat: 20, contrast: 8, warmth: 10 } },
    { id: "agfavista200", group: NEG, label: "Agfa Vista 200", amount: 22, size: 1.5, speckle: 36, chroma: 45, look: { sat: 15, contrast: 8, warmth: 4 } },
    // slide
    { id: "ektachrome100", group: SLIDE, label: "Kodak Ektachrome E100", amount: 9, size: 1.0, speckle: 24, chroma: 12, look: { sat: 15, contrast: 12, warmth: -2 } },
    { id: "kodachrome64", group: SLIDE, label: "Kodachrome 64", amount: 12, size: 1.1, speckle: 24, chroma: 10, look: { sat: 10, contrast: 16, warmth: 6, mix: [1.08, -0.04, -0.04, 0, 1, 0, 0, -0.04, 1.04] } },
    { id: "velvia50", group: SLIDE, label: "Fujifilm Velvia 50", amount: 9, size: 1.0, speckle: 24, chroma: 15, look: { sat: 40, contrast: 18, warmth: 2 } },
    { id: "provia100f", group: SLIDE, label: "Fujifilm Provia 100F", amount: 9, size: 1.0, speckle: 24, chroma: 12, look: { sat: 12, contrast: 10, warmth: -3 } },
    { id: "astia100f", group: SLIDE, label: "Fujifilm Astia 100F", amount: 10, size: 1.0, speckle: 24, chroma: 12, look: { sat: -5, contrast: 2, warmth: 4 } },
    // black and white (mono = luminance weights r, g, b)
    { id: "panf50", group: BW, label: "Ilford Pan F Plus 50", amount: 6, size: 0.9, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 15 } },
    { id: "tmax100", group: BW, label: "Kodak T-Max 100", amount: 10, size: 1.1, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 5 } },
    { id: "acros100", group: BW, label: "Fujifilm Acros 100 II", amount: 9, size: 1.0, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 5 } },
    { id: "fp4", group: BW, label: "Ilford FP4 Plus 125", amount: 14, size: 1.3, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 8 } },
    { id: "kentmere400", group: BW, label: "Kentmere Pan 400", amount: 30, size: 1.8, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 6 } },
    { id: "tmax400", group: BW, label: "Kodak T-Max 400", amount: 20, size: 1.5, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 8 } },
    { id: "trix400", group: BW, label: "Kodak Tri-X 400", amount: 32, size: 1.9, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 15 } },
    { id: "hp5", group: BW, label: "Ilford HP5 Plus 400", amount: 28, size: 1.8, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 5 } },
    { id: "delta400", group: BW, label: "Ilford Delta 400", amount: 20, size: 1.5, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 8 } },
    { id: "xp2", group: BW, label: "Ilford XP2 Super 400", amount: 16, size: 1.4, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 0 } },
    { id: "fomapan400", group: BW, label: "Fomapan 400", amount: 34, size: 2.0, speckle: 60, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 10 } },
    { id: "delta3200", group: BW, label: "Ilford Delta 3200", amount: 55, size: 2.8, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 12 } },
    { id: "tmax3200", group: BW, label: "Kodak T-Max P3200", amount: 50, size: 2.6, speckle: 40, chroma: 0, look: { mono: [0.3, 0.59, 0.11], contrast: 10 } },
    { id: "ortho80", group: BW, label: "Ilford Ortho Plus 80 (red goes dark)", amount: 8, size: 1.0, speckle: 60, chroma: 0, look: { mono: [0.05, 0.65, 0.30], contrast: 12 } },
    { id: "rolleiir400", group: BW, label: "Rollei Infrared 400 (foliage bright, sky dark)", amount: 24, size: 1.6, speckle: 60, chroma: 0, look: { mono: [0.85, 0.35, -0.2], contrast: 20 } },
    // cine
    { id: "vision3_50d", group: CINE, label: "Kodak Vision3 50D", amount: 9, size: 1.0, speckle: 30, chroma: 25, look: { sat: -4, contrast: -8, fade: 5 } },
    { id: "vision3_250d", group: CINE, label: "Kodak Vision3 250D", amount: 14, size: 1.3, speckle: 30, chroma: 30, look: { sat: -5, contrast: -8, fade: 5 } },
    { id: "vision3_500t", group: CINE, label: "Kodak Vision3 500T (daylight, uncorrected)", amount: 26, size: 1.8, speckle: 30, chroma: 40, look: { sat: -4, contrast: -8, warmth: -14, tint: 3, fade: 5 } },
    { id: "cinestill50d", group: CINE, label: "CineStill 50D", amount: 10, size: 1.1, speckle: 30, chroma: 25, look: { sat: 5, contrast: 4, warmth: 3 } },
    { id: "cinestill400d", group: CINE, label: "CineStill 400D", amount: 22, size: 1.6, speckle: 30, chroma: 35, look: { sat: 5, contrast: 2, warmth: 5 } },
    { id: "cinestill800t", group: CINE, label: "CineStill 800T (daylight, teal cast)", amount: 34, size: 2.1, speckle: 30, chroma: 45, look: { sat: 0, contrast: 2, warmth: -15, tint: 4 } },
    // special and artistic (channel mix: rows r', g', b' from r, g, b)
    { id: "lomopurple", group: FX, label: "LomoChrome Purple (greens to purple)", amount: 26, size: 1.7, speckle: 40, chroma: 50, look: { sat: 15, contrast: 6, mix: [0.55, 0.45, 0, 0.1, 0.15, 0.75, 0.15, 0.85, 0] } },
    { id: "lomoturquoise", group: FX, label: "LomoChrome Turquoise (reds to blue, blues to gold)", amount: 26, size: 1.7, speckle: 40, chroma: 50, look: { sat: 15, contrast: 6, mix: [0.25, 0.05, 0.7, 0.05, 0.9, 0.05, 0.75, 0.2, 0.05] } },
    { id: "lomometropolis", group: FX, label: "LomoChrome Metropolis (muted, contrasty)", amount: 30, size: 1.8, speckle: 40, chroma: 40, look: { sat: -35, contrast: 20, warmth: -4, fade: 2 } },
    { id: "aerochrome", group: FX, label: "Kodak Aerochrome (false-colour infrared)", amount: 14, size: 1.3, speckle: 40, chroma: 20, look: { sat: 20, contrast: 8, mix: [0.15, 0.85, 0, 0.75, 0, 0.25, 0.35, 0, 0.65] } },
    { id: "redscale", group: FX, label: "Redscale (shot through the base)", amount: 30, size: 1.8, speckle: 40, chroma: 40, look: { sat: 10, contrast: 10, mix: [0.9, 0.35, 0, 0.3, 0.5, 0.05, 0.1, 0.05, 0.1] } },
    { id: "xpro", group: FX, label: "Cross-processed slide (E-6 in C-41)", amount: 22, size: 1.5, speckle: 40, chroma: 40, look: { sat: 30, contrast: 30, warmth: 5, tint: -10, fade: -2 } },
    { id: "expired", group: FX, label: "Expired colour negative", amount: 34, size: 2.0, speckle: 40, chroma: 55, look: { sat: -20, contrast: -6, warmth: 4, tint: 8, fade: 12 } },
    { id: "instant", group: FX, label: "Instant film (SX-70 style)", amount: 8, size: 2.5, speckle: 40, chroma: 20, look: { sat: -10, contrast: -10, warmth: 12, fade: 10 } },
];

const LOOK_DEFAULT = { sat: 0, contrast: 0, warmth: 0, tint: 0, fade: 0 };

/** Parametric colour character of a preset, applied in place on RGBA pixel data, mixed by `strength` (0..1). */
function applyLook(px, look, strength) {
    if (!look || strength <= 0) return;
    const L = { ...LOOK_DEFAULT, ...look };
    const mix = Array.isArray(L.mix) && L.mix.length === 9 ? L.mix : null;
    const mono = Array.isArray(L.mono) && L.mono.length === 3 ? L.mono : null;
    const satK = 1 + L.sat / 100, conK = 1 + L.contrast / 100, fade = L.fade / 100;
    const wR = 1 + L.warmth / 300, wB = 1 - L.warmth / 300, tG = 1 - L.tint / 300;
    for (let i = 0; i < px.length; i += 4) {
        let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const r0 = r, g0 = g, b0 = b;
        if (mix) { const nr = mix[0] * r + mix[1] * g + mix[2] * b, ng = mix[3] * r + mix[4] * g + mix[5] * b, nb = mix[6] * r + mix[7] * g + mix[8] * b; r = nr; g = ng; b = nb; }
        if (mono) { const sum = mono[0] + mono[1] + mono[2] || 1; const l = (mono[0] * r + mono[1] * g + mono[2] * b) / sum; r = g = b = l; }
        r *= wR; b *= wB; g *= tG;
        if (!mono && satK !== 1) { const l = 0.299 * r + 0.587 * g + 0.114 * b; r = l + (r - l) * satK; g = l + (g - l) * satK; b = l + (b - l) * satK; }
        if (conK !== 1) { r = 0.5 + (r - 0.5) * conK; g = 0.5 + (g - 0.5) * conK; b = 0.5 + (b - 0.5) * conK; }
        if (fade) { r = fade + r * (1 - fade * 1.2); g = fade + g * (1 - fade * 1.2); b = fade + b * (1 - fade * 1.2); }
        if (strength < 1) { r = r0 + (r - r0) * strength; g = g0 + (g - g0) * strength; b = b0 + (b - b0) * strength; }
        px[i] = clamp255(r * 255); px[i + 1] = clamp255(g * 255); px[i + 2] = clamp255(b * 255);
    }
}

function applyGrain(src, p, info) {
    const W = src.width, H = src.height;
    const amount = (p.amount ?? 25) / 100;
    const size = Math.max(0.5, (p.size ?? 1.5) * (info.scale || 1));
    // chroma: 0 = luminance grain only, 100 = independent noise per channel (old layers stored a "mono" flag)
    const chroma = Math.min(1, Math.max(0, (p.chroma ?? (p.mono === false ? 100 : 0)) / 100));
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    const lookStrength = Math.min(1, Math.max(0, (p.look_strength ?? 100) / 100));
    if (p.look && lookStrength > 0) {
        const img0 = octx.getImageData(0, 0, W, H);
        applyLook(img0.data, p.look, lookStrength);
        octx.putImageData(img0, 0, 0);
    }
    if (amount <= 0) return out;
    // The noise field depends only on size, speckle, colour share, seed and the
    // canvas size (or the plate and its scale), never on the picture: it is cached
    // per layer (info.cache) so amount, look and opacity changes only pay for the
    // final pixel loop.
    const cache = info.cache || {};
    const usePlate = !!(info.plate && info.plate.width);
    const sigma = Math.max(0, Math.min(0.5, (p.speckle ?? 25) / 100 * 0.5));
    const sc = Math.max(0.1, (p.plate_scale ?? 1) * (info.scale || 1));
    const noiseKey = JSON.stringify(usePlate ? ["plate", info.plateKey || "", sc, W, H] : ["synth", size, sigma, chroma, String(info.seed || "grain"), W, H]);
    let nz, center = 128, gain = 1.3;
    if (usePlate) { center = info.plateMean ?? 128; gain = 40 / Math.max(8, info.plateStd ?? 40); }   // plates come with their own contrast
    if (cache.noiseKey === noiseKey && cache.noise) {
        nz = cache.noise;
    } else {
        const big = makeCanvas(W, H);
        const bctx = big.getContext("2d");
        if (usePlate) {
            // a real grain plate (scan of a uniformly exposed film) replaces the synthetic noise,
            // tiled at plate_scale (1 = plate pixels 1:1) and centred on its mean
            const pat = bctx.createPattern(info.plate, "repeat");
            try { pat.setTransform(new DOMMatrix().scale(sc, sc)); } catch (_) { /* old browsers */ }
            bctx.fillStyle = pat;
            bctx.fillRect(0, 0, W, H);
        } else {
            // noise at grain resolution (never finer than a pixel), scaled up with smoothing: soft, film-like clumps
            const gs = Math.max(1, size);
            const nw = Math.max(1, Math.round(W / gs)), nh = Math.max(1, Math.round(H / gs));
            const noise = makeCanvas(nw, nh);
            const nctx = noise.getContext("2d");
            const nd = nctx.createImageData(nw, nh);
            const d = nd.data;
            const rand = rng(hashString(String(info.seed || "grain")));
            // Real grain plates measure skewed and heavy-tailed (bright specks on a darker
            // ground: skew 0.5-0.9, kurtosis 3.2-5.4 on fotokorn's scans, black-and-white
            // stocks the most). A standardised lognormal reproduces that: sigma 0.3 gives
            // skew ~0.95 / kurtosis ~4.6, sigma 0.12 stays close to gaussian. Samples come
            // from a 64k table so the per-pixel work is one random number and a lookup.
            const e1 = Math.exp(sigma * sigma / 2), norm = Math.sqrt((Math.exp(sigma * sigma) - 1) * Math.exp(sigma * sigma)) || 1;
            const gauss = () => { const u = Math.max(1e-12, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
            const TN = 65536;
            const table = new Float32Array(TN);
            for (let i = 0; i < TN; i++) table[i] = (sigma > 0.005 ? (Math.exp(sigma * gauss()) - e1) / norm : gauss()) * 40;
            const sample = () => table[(rand() * TN) | 0];
            for (let i = 0; i < d.length; i += 4) {
                const g = sample();
                if (chroma <= 0) { d[i] = d[i + 1] = d[i + 2] = 128 + g; }
                else {
                    // luminance grain shared by all channels plus a per-channel part (colour negative films)
                    d[i] = 128 + g * (1 - chroma) + sample() * chroma;
                    d[i + 1] = 128 + g * (1 - chroma) + sample() * chroma;
                    d[i + 2] = 128 + g * (1 - chroma) + sample() * chroma;
                }
                d[i + 3] = 255;
            }
            nctx.putImageData(nd, 0, 0);
            bctx.imageSmoothingEnabled = gs > 1;
            bctx.drawImage(noise, 0, 0, W, H);
        }
        nz = bctx.getImageData(0, 0, W, H).data;
        cache.noiseKey = noiseKey;
        cache.noise = nz;
    }
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;
    const k = amount * gain;
    for (let i = 0; i < px.length; i += 4) {
        // grain is strongest in the midtones, weaker in deep shadows and highlights
        const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        const w = k * (0.35 + 0.65 * (1 - Math.abs(2 * lum - 1)));
        px[i] = clamp255(px[i] + (nz[i] - center) * w);
        px[i + 1] = clamp255(px[i + 1] + (nz[i + 1] - center) * w);
        px[i + 2] = clamp255(px[i + 2] + (nz[i + 2] - center) * w);
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/** Mean and high-pass standard deviation of a grain plate, from a 512 px sample (for centring and gain). */
export function plateStats(img) {
    const w = Math.min(512, img.naturalWidth || img.width), h = Math.min(512, img.naturalHeight || img.height);
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; s += l; s2 += l * l; n++; }
    const mean = s / n;
    return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

// ---------------------------------------------------------------------------
// sharpen (unsharp mask)
// ---------------------------------------------------------------------------

function applySharpen(src, p, info) {
    const W = src.width, H = src.height;
    const amount = (p.amount ?? 100) / 100;
    const radius = Math.max(0.3, (p.radius ?? 1.5) * (info.scale || 1));
    const threshold = p.threshold ?? 0;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    if (amount <= 0) return out;
    const blurred = makeCanvas(W, H);
    const bctx = blurred.getContext("2d");
    try { bctx.filter = `blur(${radius}px)`; } catch (_) { /* no filter support */ }
    bctx.drawImage(src, 0, 0);
    bctx.filter = "none";
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;
    const bl = bctx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < px.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const diff = px[i + c] - bl[i + c];
            if (Math.abs(diff) < threshold) continue;
            px[i + c] = clamp255(px[i + c] + diff * amount);
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// levels
// ---------------------------------------------------------------------------

function levelsTable(p) {
    const inB = p.inBlack ?? 0, inW = p.inWhite ?? 255, gamma = Math.max(0.1, p.gamma ?? 1);
    const outB = p.outBlack ?? 0, outW = p.outWhite ?? 255;
    const t = new Uint8ClampedArray(256);
    const span = Math.max(1, inW - inB);
    for (let i = 0; i < 256; i++) {
        let v = (i - inB) / span;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        v = Math.pow(v, 1 / gamma);
        t[i] = outB + v * (outW - outB);
    }
    return t;
}

function applyLevels(src, p) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    const t = levelsTable(p);
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) { px[i] = t[px[i]]; px[i + 1] = t[px[i + 1]]; px[i + 2] = t[px[i + 2]]; }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// 3D LUT (.cube)
// ---------------------------------------------------------------------------

/** Parse a .cube file into {size, data: Float32Array(size^3 * 3), title}. Red varies fastest. */
export function lutFromCube(text) {
    let size = 0, title = "";
    let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
    const values = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const up = line.toUpperCase();
        if (up.startsWith("TITLE")) { title = line.slice(5).trim().replace(/^"|"$/g, ""); continue; }
        if (up.startsWith("LUT_3D_SIZE")) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
        if (up.startsWith("LUT_1D_SIZE")) throw new Error("1D LUTs are not supported, use a 3D .cube");
        if (up.startsWith("DOMAIN_MIN")) { domainMin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
        if (up.startsWith("DOMAIN_MAX")) { domainMax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
        if (/^[-+0-9.eE\s]+$/.test(line)) {
            const parts = line.split(/\s+/).map(Number);
            if (parts.length >= 3) values.push(parts[0], parts[1], parts[2]);
        }
    }
    if (!size || values.length < size * size * size * 3) throw new Error("not a valid 3D .cube file");
    const data = new Float32Array(size * size * size * 3);
    for (let i = 0; i < data.length; i++) {
        const c = i % 3;
        const v = (values[i] - domainMin[c]) / ((domainMax[c] - domainMin[c]) || 1);
        data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return { size, data, title };
}

/** Bake a LUT into an RGB canvas (width size*size, height size): x = r + b * size, y = g. Lossless as PNG. */
export function lutToCanvas(lut) {
    const N = lut.size;
    const c = makeCanvas(N * N, N);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(N * N, N);
    const d = img.data;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        const src = ((b * N + g) * N + r) * 3;
        const dst = (g * N * N + (b * N + r)) * 4;
        d[dst] = Math.round(lut.data[src] * 255);
        d[dst + 1] = Math.round(lut.data[src + 1] * 255);
        d[dst + 2] = Math.round(lut.data[src + 2] * 255);
        d[dst + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

/** Read a LUT back from the canvas / image written by lutToCanvas. */
export function lutFromImage(img, size) {
    const N = size || img.height || img.naturalHeight;
    const c = makeCanvas(N * N, N);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, N * N, N).data;
    const data = new Float32Array(N * N * N * 3);
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
        const dst = ((b * N + g) * N + r) * 3;
        const src = (g * N * N + (b * N + r)) * 4;
        data[dst] = d[src] / 255; data[dst + 1] = d[src + 1] / 255; data[dst + 2] = d[src + 2] / 255;
    }
    return { size: N, data };
}

function applyLut(src, p, info) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    const lut = info.lut;
    const strength = (p.strength ?? 100) / 100;
    if (!lut || !lut.data || strength <= 0) return out;
    const N = lut.size, data = lut.data;
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;
    const scale = (N - 1) / 255;
    const N2 = N * N;
    for (let i = 0; i < px.length; i += 4) {
        const fr = px[i] * scale, fg = px[i + 1] * scale, fb = px[i + 2] * scale;
        const r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
        const r1 = r0 < N - 1 ? r0 + 1 : r0, g1 = g0 < N - 1 ? g0 + 1 : g0, b1 = b0 < N - 1 ? b0 + 1 : b0;
        const tr = fr - r0, tg = fg - g0, tb = fb - b0;
        for (let c = 0; c < 3; c++) {
            const c000 = data[((b0 * N + g0) * N + r0) * 3 + c], c100 = data[((b0 * N + g0) * N + r1) * 3 + c];
            const c010 = data[((b0 * N + g1) * N + r0) * 3 + c], c110 = data[((b0 * N + g1) * N + r1) * 3 + c];
            const c001 = data[((b1 * N + g0) * N + r0) * 3 + c], c101 = data[((b1 * N + g0) * N + r1) * 3 + c];
            const c011 = data[((b1 * N + g1) * N + r0) * 3 + c], c111 = data[((b1 * N + g1) * N + r1) * 3 + c];
            const c00 = c000 + (c100 - c000) * tr, c10 = c010 + (c110 - c010) * tr;
            const c01 = c001 + (c101 - c001) * tr, c11 = c011 + (c111 - c011) * tr;
            const c0 = c00 + (c10 - c00) * tg, c1 = c01 + (c11 - c01) * tg;
            const v = (c0 + (c1 - c0) * tb) * 255;
            px[i + c] = clamp255(px[i + c] + (v - px[i + c]) * strength);
        }
        void N2;
    }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// vignette
// ---------------------------------------------------------------------------

function applyVignette(src, p) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const amount = (p.amount ?? 40) / 100;
    if (amount <= 0) return out;
    const size = (p.size ?? 60) / 100;          // where the darkening starts, as a fraction of the half diagonal
    const softness = Math.max(0.02, (p.softness ?? 50) / 100);
    const cx = W / 2, cy = H / 2;
    const rMax = Math.hypot(cx, cy);
    const r0 = rMax * size * (1 - softness * 0.5);
    const r1 = Math.min(rMax * 1.15, r0 + rMax * softness);
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${amount})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return out;
}

// ---------------------------------------------------------------------------
// point adjustments: shared helpers
// ---------------------------------------------------------------------------

/** Copy of `src` plus its pixel data, for the one-pass adjustments below. */
function openPixels(src) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    const img = octx.getImageData(0, 0, W, H);
    return { out, octx, img, px: img.data };
}

/** Apply one 256-entry table to all three channels (or three tables, one per channel). */
function applyTables(src, tr, tg = tr, tb = tr) {
    const { out, octx, img, px } = openPixels(src);
    for (let i = 0; i < px.length; i += 4) { px[i] = tr[px[i]]; px[i + 1] = tg[px[i + 1]]; px[i + 2] = tb[px[i + 2]]; }
    octx.putImageData(img, 0, 0);
    return out;
}

function copyCanvas(src) {
    const out = makeCanvas(src.width, src.height);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
}

// Rec. 601 luma, the weights the rest of the file uses too.
const LR = 0.299, LG = 0.587, LB = 0.114;

// ---------------------------------------------------------------------------
// hue / saturation / lightness
// ---------------------------------------------------------------------------

/** 3x3 row-major matrix: hue rotation (SVG feColorMatrix hueRotate) followed by a saturation scale. */
function hueSatMatrix(hueDeg, satK) {
    const a = hueDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    // SVG feColorMatrix hueRotate / saturate (Rec. 709 luma 0.213 / 0.715 / 0.072)
    const Hm = [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ];
    const Sm = [
        0.213 + 0.787 * satK, 0.715 - 0.715 * satK, 0.072 - 0.072 * satK,
        0.213 - 0.213 * satK, 0.715 + 0.285 * satK, 0.072 - 0.072 * satK,
        0.213 - 0.213 * satK, 0.715 - 0.715 * satK, 0.072 + 0.928 * satK,
    ];
    const M = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) M[r * 3 + col] = Sm[r * 3] * Hm[col] + Sm[r * 3 + 1] * Hm[3 + col] + Sm[r * 3 + 2] * Hm[6 + col];
    return M;
}

/** Photoshop-style lightness: positive blends towards white, negative towards black. */
function lightnessTable(l) {
    const t = new Uint8ClampedArray(256);
    const k = Math.max(-1, Math.min(1, l / 100));
    for (let i = 0; i < 256; i++) t[i] = k >= 0 ? i + (255 - i) * k : i * (1 + k);
    return t;
}

function applyHueSat(src, p) {
    const hue = p.hue ?? 0, sat = p.saturation ?? 0, light = p.lightness ?? 0;
    if (!hue && !sat && !light) return copyCanvas(src);
    const satK = Math.max(0, 1 + sat / 100);
    const M = hueSatMatrix(hue, satK);
    const m00 = M[0], m01 = M[1], m02 = M[2], m10 = M[3], m11 = M[4], m12 = M[5], m20 = M[6], m21 = M[7], m22 = M[8];
    const { out, octx, img, px } = openPixels(src);
    if (hue || sat) {
        for (let i = 0; i < px.length; i += 4) {
            const r = px[i], g = px[i + 1], b = px[i + 2];
            px[i] = m00 * r + m01 * g + m02 * b;          // Uint8ClampedArray rounds and clamps
            px[i + 1] = m10 * r + m11 * g + m12 * b;
            px[i + 2] = m20 * r + m21 * g + m22 * b;
        }
    }
    if (light) {
        const t = lightnessTable(light);
        for (let i = 0; i < px.length; i += 4) { px[i] = t[px[i]]; px[i + 1] = t[px[i + 1]]; px[i + 2] = t[px[i + 2]]; }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// brightness / contrast
// ---------------------------------------------------------------------------

/**
 * Brightness lifts (or lowers) with the ends protected: +100 takes black to
 * ~100 and mid grey to ~200 while white stays white (negative: mirrored, black
 * stays black). Contrast pivots around mid grey like Photoshop's legacy
 * control: slope 1 / (1 - c) above zero (+50 doubles, +100 is nearly a
 * threshold), 1 + c below (-100 is flat mid grey).
 */
function brightnessContrastTable(brightness, contrast) {
    const t = new Uint8ClampedArray(256);
    const b = Math.max(-1, Math.min(1, (brightness ?? 0) / 100)) * 0.4;
    const c = Math.max(-1, Math.min(1, (contrast ?? 0) / 100));
    const slope = c >= 0 ? 1 / (1 - c * 0.98) : 1 + c;
    for (let i = 0; i < 256; i++) {
        let v = i / 255;
        if (b > 0) v += b * (1 - v * v);
        else if (b < 0) v += b * (1 - (1 - v) * (1 - v));
        v = 0.5 + (v - 0.5) * slope;
        t[i] = v * 255;
    }
    return t;
}

function applyBrightnessContrast(src, p) {
    if (!(p.brightness ?? 0) && !(p.contrast ?? 0)) return copyCanvas(src);
    return applyTables(src, brightnessContrastTable(p.brightness, p.contrast));
}

// ---------------------------------------------------------------------------
// colour balance
// ---------------------------------------------------------------------------

/**
 * Tone weights on luma like Photoshop / GIMP: shadows fade out around 0.45,
 * highlights fade in around 0.55, midtones peak at 0.5. Because the shift of a
 * pixel depends only on its luma, the three per-channel offsets (and the
 * luminosity correction) are three 256-entry tables indexed by luma. +100 on
 * the midtones moves mid grey by about 100 levels (Photoshop's reach), before
 * the luminosity correction pulls the other two channels down.
 */
function colorBalanceTables(p) {
    const K = 0.4 * 255 / 100;
    const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const dR = new Float32Array(256), dG = new Float32Array(256), dB = new Float32Array(256);
    const s = [p.shadows_cr ?? 0, p.shadows_mg ?? 0, p.shadows_yb ?? 0];
    const m = [p.mid_cr ?? 0, p.mid_mg ?? 0, p.mid_yb ?? 0];
    const h = [p.high_cr ?? 0, p.high_mg ?? 0, p.high_yb ?? 0];
    const preserve = p.preserve !== false;
    for (let i = 0; i < 256; i++) {
        const l = i / 255;
        const ws = cl01(0.5 - (l - 0.333) * 4);
        const wh = cl01(0.5 + (l - 0.667) * 4);
        const wm = cl01(0.5 + (l - 0.333) * 4) * cl01(0.5 - (l - 0.667) * 4);
        let r = (s[0] * ws + m[0] * wm + h[0] * wh) * K;
        let g = (s[1] * ws + m[1] * wm + h[1] * wh) * K;
        let b = (s[2] * ws + m[2] * wm + h[2] * wh) * K;
        if (preserve) { const dl = LR * r + LG * g + LB * b; r -= dl; g -= dl; b -= dl; }
        dR[i] = r; dG[i] = g; dB[i] = b;
    }
    return { dR, dG, dB };
}

function applyColorBalance(src, p) {
    const keys = ["shadows_cr", "shadows_mg", "shadows_yb", "mid_cr", "mid_mg", "mid_yb", "high_cr", "high_mg", "high_yb"];
    if (keys.every((k) => !(p[k] ?? 0))) return copyCanvas(src);
    const { dR, dG, dB } = colorBalanceTables(p);
    const { out, octx, img, px } = openPixels(src);
    for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const l = (LR * r + LG * g + LB * b + 0.5) | 0;
        px[i] = r + dR[l]; px[i + 1] = g + dG[l]; px[i + 2] = b + dB[l];
    }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------

function applyCurves(src, p, info) {
    const tables = curvesToTables(p.curves);
    const { out, octx, img, px } = openPixels(src);
    // luma histogram of the input for the curve editor (every 4th pixel is plenty)
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 16) hist[(LR * px[i] + LG * px[i + 1] + LB * px[i + 2] + 0.5) | 0]++;
    if (info && info.cache) info.cache.histogram = hist;
    if (!tables) return out;
    const tr = tables.r, tg = tables.g, tb = tables.b;
    for (let i = 0; i < px.length; i += 4) { px[i] = tr[px[i]]; px[i + 1] = tg[px[i + 1]]; px[i + 2] = tb[px[i + 2]]; }
    octx.putImageData(img, 0, 0);
    return out;
}

function curvesControl(layer, param, callbacks) {
    return buildCurvesControl(layer, param, callbacks, { histogram: () => (layer._fxCache && layer._fxCache.histogram) || null });
}

// ---------------------------------------------------------------------------
// gaussian blur
// ---------------------------------------------------------------------------

/**
 * ctx.filter blur on a canvas padded with mirrored copies of the source, so
 * the picture edges blur into themselves instead of into transparency; the
 * result is cropped back and the (all but exactly opaque) fringe is backed
 * with the source so alpha stays 255.
 */
function applyBlur(src, p, info) {
    const W = src.width, H = src.height;
    const sigma = Math.max(0, (p.radius ?? 4) * (info.scale || 1));
    if (sigma < 0.05) return copyCanvas(src);
    const pad = Math.min(W, H, Math.ceil(sigma * 3) + 2);
    const PW = W + 2 * pad, PH = H + 2 * pad;
    const padded = makeCanvas(PW, PH);
    const pctx = padded.getContext("2d");
    pctx.drawImage(src, pad, pad);
    // mirrored strips: left / right, top / bottom, then the four corners
    pctx.save(); pctx.translate(pad, 0); pctx.scale(-1, 1); pctx.drawImage(src, 0, 0, pad, H, 0, pad, pad, H); pctx.restore();
    pctx.save(); pctx.translate(PW, 0); pctx.scale(-1, 1); pctx.drawImage(src, W - pad, 0, pad, H, 0, pad, pad, H); pctx.restore();
    pctx.save(); pctx.translate(0, pad); pctx.scale(1, -1); pctx.drawImage(src, 0, 0, W, pad, pad, 0, W, pad); pctx.restore();
    pctx.save(); pctx.translate(0, PH); pctx.scale(1, -1); pctx.drawImage(src, 0, H - pad, W, pad, pad, 0, W, pad); pctx.restore();
    pctx.save(); pctx.translate(pad, pad); pctx.scale(-1, -1); pctx.drawImage(src, 0, 0, pad, pad, 0, 0, pad, pad); pctx.restore();
    pctx.save(); pctx.translate(PW, pad); pctx.scale(-1, -1); pctx.drawImage(src, W - pad, 0, pad, pad, 0, 0, pad, pad); pctx.restore();
    pctx.save(); pctx.translate(pad, PH); pctx.scale(-1, -1); pctx.drawImage(src, 0, H - pad, pad, pad, 0, 0, pad, pad); pctx.restore();
    pctx.save(); pctx.translate(PW, PH); pctx.scale(-1, -1); pctx.drawImage(src, W - pad, H - pad, pad, pad, 0, 0, pad, pad); pctx.restore();
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    try { octx.filter = `blur(${sigma}px)`; } catch (_) { /* no filter support: unblurred copy */ }
    octx.drawImage(padded, -pad, -pad);
    octx.filter = "none";
    octx.globalCompositeOperation = "destination-over";
    octx.drawImage(src, 0, 0);
    octx.globalCompositeOperation = "source-over";
    return out;
}

// ---------------------------------------------------------------------------
// black & white
// ---------------------------------------------------------------------------

/** Pure hue (0..360) as r, g, b in 0..1. */
function hueToRgb(hue) {
    const h = (((hue % 360) + 360) % 360) / 60, x = 1 - Math.abs((h % 2) - 1);
    const k = Math.floor(h) % 6;
    return k === 0 ? [1, x, 0] : k === 1 ? [x, 1, 0] : k === 2 ? [0, 1, x] : k === 3 ? [0, x, 1] : k === 4 ? [x, 0, 1] : [1, 0, x];
}

/** Weighted mono (weights normalised, so 30/59/11 and 60/118/22 are the same) with a midtone tint mixed in by strength. */
function applyBlackWhite(src, p) {
    let wr = p.red ?? 30, wg = p.green ?? 59, wb = p.blue ?? 11;
    const sum = wr + wg + wb;
    if (sum > 0) { wr /= sum; wg /= sum; wb /= sum; } else { wr = LR; wg = LG; wb = LB; }
    const strength = Math.max(0, Math.min(1, (p.tint_strength ?? 0) / 100));
    const { out, octx, img, px } = openPixels(src);
    if (strength <= 0) {
        for (let i = 0; i < px.length; i += 4) { const l = wr * px[i] + wg * px[i + 1] + wb * px[i + 2]; px[i] = l; px[i + 1] = l; px[i + 2] = l; }
    } else {
        // tint: push the channels apart around the luma, strongest in the midtones (a duotone / sepia look)
        const t = hueToRgb(p.tint_hue ?? 35);
        const A = 0.35 * 255 * strength;
        const tr = (t[0] - 0.5) * A, tg = (t[1] - 0.5) * A, tb = (t[2] - 0.5) * A;
        for (let i = 0; i < px.length; i += 4) {
            const l = wr * px[i] + wg * px[i + 1] + wb * px[i + 2];
            const shape = l < 127.5 ? l / 127.5 : (255 - l) / 127.5;
            px[i] = l + tr * shape; px[i + 1] = l + tg * shape; px[i + 2] = l + tb * shape;
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// invert
// ---------------------------------------------------------------------------

const INVERT_TABLE = (() => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = 255 - i; return t; })();
function applyInvert(src) { return applyTables(src, INVERT_TABLE); }

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const FILTERS = {
    grain: {
        label: "Film / Grain",
        params: [
            { key: "preset", label: "Film", type: "select", options: GRAIN_PRESETS, default: "custom" },
            { key: "look_strength", label: "Look", min: 0, max: 100, step: 1, default: 100, unit: "%", keepPreset: true },
            { key: "amount", label: "Grain", min: 0, max: 100, step: 1, default: 25, unit: "%" },
            { key: "size", label: "Size", min: 0.5, max: 6, step: 0.1, default: 1.5, unit: "px", notWithPlate: true },
            { key: "speckle", label: "Speckle", min: 0, max: 100, step: 1, default: 25, unit: "%", notWithPlate: true },
            { key: "chroma", label: "Colour", min: 0, max: 100, step: 1, default: 0, unit: "%", notWithPlate: true },
            { key: "plate_scale", label: "Plate", min: 0.25, max: 4, step: 0.05, default: 1, unit: "×", onlyWithPlate: true, keepPreset: true },
        ],
        presets: GRAIN_PRESETS,
        plate: true,
        apply: applyGrain,
    },
    sharpen: {
        label: "Sharpen",
        params: [
            { key: "amount", label: "Amount", min: 0, max: 300, step: 5, default: 100, unit: "%" },
            { key: "radius", label: "Radius", min: 0.3, max: 12, step: 0.1, default: 1.5, unit: "px" },
            { key: "threshold", label: "Threshold", min: 0, max: 64, step: 1, default: 0 },
        ],
        apply: applySharpen,
    },
    blur: {
        label: "Gaussian blur",
        params: [
            { key: "radius", label: "Radius", min: 0, max: 64, step: 0.5, default: 4, unit: "px" },
        ],
        apply: applyBlur,
    },
    levels: {
        label: "Levels",
        params: [
            { key: "inBlack", label: "In black", min: 0, max: 254, step: 1, default: 0 },
            { key: "inWhite", label: "In white", min: 1, max: 255, step: 1, default: 255 },
            { key: "gamma", label: "Gamma", min: 0.1, max: 4, step: 0.02, default: 1 },
            { key: "outBlack", label: "Out black", min: 0, max: 255, step: 1, default: 0 },
            { key: "outWhite", label: "Out white", min: 0, max: 255, step: 1, default: 255 },
        ],
        apply: applyLevels,
    },
    curves: {
        label: "Curves",
        params: [
            { key: "curves", label: "Curves", type: "custom", default: curveDefaults() },
        ],
        control: curvesControl,
        apply: applyCurves,
    },
    brightness_contrast: {
        label: "Brightness / Contrast",
        params: [
            { key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, default: 0 },
            { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, default: 0 },
        ],
        apply: applyBrightnessContrast,
    },
    hue_sat: {
        label: "Hue / Saturation",
        params: [
            { key: "hue", label: "Hue", min: -180, max: 180, step: 1, default: 0, unit: "°" },
            { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, default: 0, unit: "%" },
            { key: "lightness", label: "Lightness", min: -100, max: 100, step: 1, default: 0, unit: "%" },
        ],
        apply: applyHueSat,
    },
    color_balance: {
        label: "Colour balance",
        params: [
            { key: "shadows_cr", label: "Shadows C–R", min: -100, max: 100, step: 1, default: 0 },
            { key: "shadows_mg", label: "Shadows M–G", min: -100, max: 100, step: 1, default: 0 },
            { key: "shadows_yb", label: "Shadows Y–B", min: -100, max: 100, step: 1, default: 0 },
            { key: "mid_cr", label: "Mid C–R", min: -100, max: 100, step: 1, default: 0 },
            { key: "mid_mg", label: "Mid M–G", min: -100, max: 100, step: 1, default: 0 },
            { key: "mid_yb", label: "Mid Y–B", min: -100, max: 100, step: 1, default: 0 },
            { key: "high_cr", label: "High C–R", min: -100, max: 100, step: 1, default: 0 },
            { key: "high_mg", label: "High M–G", min: -100, max: 100, step: 1, default: 0 },
            { key: "high_yb", label: "High Y–B", min: -100, max: 100, step: 1, default: 0 },
            { key: "preserve", label: "Preserve luminosity", type: "bool", default: true },
        ],
        apply: applyColorBalance,
    },
    bw: {
        label: "Black & white",
        params: [
            { key: "red", label: "Red", min: 0, max: 200, step: 1, default: 30, unit: "%" },
            { key: "green", label: "Green", min: 0, max: 200, step: 1, default: 59, unit: "%" },
            { key: "blue", label: "Blue", min: 0, max: 200, step: 1, default: 11, unit: "%" },
            { key: "tint_hue", label: "Tint hue", min: 0, max: 360, step: 1, default: 35, unit: "°" },
            { key: "tint_strength", label: "Tint", min: 0, max: 100, step: 1, default: 0, unit: "%" },
        ],
        apply: applyBlackWhite,
    },
    invert: {
        label: "Invert",
        params: [],
        apply: applyInvert,
    },
    lut: {
        label: "LUT (.cube)",
        params: [
            { key: "strength", label: "Strength", min: 0, max: 100, step: 1, default: 100, unit: "%" },
        ],
        needsLut: true,
        apply: applyLut,
    },
    vignette: {
        label: "Vignette",
        params: [
            { key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 40, unit: "%" },
            { key: "size", label: "Size", min: 10, max: 100, step: 1, default: 60, unit: "%" },
            { key: "softness", label: "Softness", min: 2, max: 100, step: 1, default: 50, unit: "%" },
        ],
        apply: applyVignette,
    },
};

export const FILTER_IDS = Object.keys(FILTERS);

export function filterDefaults(id) {
    const out = {};
    for (const p of (FILTERS[id] || FILTERS.grain).params) out[p.key] = p.default;
    return out;
}

/**
 * Apply filter `id` to `src` (a canvas). `info`: {scale (1 = full resolution,
 * <1 for previews so radii shrink with the image), seed, lut}.
 */
export function applyFilter(id, src, params, info = {}) {
    const f = FILTERS[id];
    if (!f) return src;
    return f.apply(src, params || {}, info);
}
