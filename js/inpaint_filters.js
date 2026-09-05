// Inpaint Canvas - filter layers (grain, sharpen, levels, LUT, vignette).
//
// A filter layer has no pixels of its own: it takes everything composited below
// it (an image-sized canvas) and returns a filtered canvas of the same size. The
// editor caches that result per layer and applies mask, opacity and blend mode
// like for any other layer. Everything here is plain Canvas 2D / pixel loops;
// blurs go through ctx.filter (GPU). Kept separate from inpaint_canvas.js so the
// editor file does not grow with every filter.

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

// Film stocks as grain characters only (amount, grain size in px on a ~2000 px
// image, colour share of the noise). Approximations from how the stocks are
// usually described, not measurements; colour rendering is a LUT's job.
export const GRAIN_PRESETS = [
    { id: "custom", label: "Custom" },
    { id: "ektar100", label: "Kodak Ektar 100", amount: 10, size: 1.1, chroma: 20 },
    { id: "portra160", label: "Kodak Portra 160", amount: 12, size: 1.2, chroma: 25 },
    { id: "portra400", label: "Kodak Portra 400", amount: 18, size: 1.5, chroma: 30 },
    { id: "portra800", label: "Kodak Portra 800", amount: 28, size: 1.9, chroma: 35 },
    { id: "gold200", label: "Kodak Gold 200", amount: 20, size: 1.5, chroma: 45 },
    { id: "kodachrome64", label: "Kodachrome 64", amount: 12, size: 1.1, chroma: 10 },
    { id: "velvia50", label: "Fuji Velvia 50", amount: 9, size: 1.0, chroma: 15 },
    { id: "pro400h", label: "Fuji Pro 400H", amount: 18, size: 1.5, chroma: 25 },
    { id: "superia400", label: "Fuji Superia 400", amount: 24, size: 1.6, chroma: 50 },
    { id: "cinestill800t", label: "CineStill 800T", amount: 34, size: 2.1, chroma: 45 },
    { id: "tmax100", label: "Kodak T-Max 100", amount: 10, size: 1.1, chroma: 0 },
    { id: "acros100", label: "Fuji Neopan Acros 100", amount: 9, size: 1.0, chroma: 0 },
    { id: "trix400", label: "Kodak Tri-X 400", amount: 32, size: 1.9, chroma: 0 },
    { id: "hp5", label: "Ilford HP5 Plus 400", amount: 28, size: 1.8, chroma: 0 },
    { id: "delta3200", label: "Ilford Delta 3200", amount: 55, size: 2.8, chroma: 0 },
];

function applyGrain(src, p, info) {
    const W = src.width, H = src.height;
    const amount = (p.amount ?? 25) / 100;
    const size = Math.max(0.5, (p.size ?? 1.5) * (info.scale || 1));
    // chroma: 0 = luminance grain only, 100 = independent noise per channel (old layers stored a "mono" flag)
    const chroma = Math.min(1, Math.max(0, (p.chroma ?? (p.mono === false ? 100 : 0)) / 100));
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0);
    if (amount <= 0) return out;
    // noise at grain resolution, scaled up with smoothing: soft, film-like clumps
    const nw = Math.max(1, Math.round(W / size)), nh = Math.max(1, Math.round(H / size));
    const noise = makeCanvas(nw, nh);
    const nctx = noise.getContext("2d");
    const nd = nctx.createImageData(nw, nh);
    const d = nd.data;
    const rand = rng(hashString(String(info.seed || "grain")));
    for (let i = 0; i < d.length; i += 4) {
        // sum of two uniforms: triangular distribution, closer to film than flat noise
        const g = (rand() + rand() - 1) * 127;
        if (chroma <= 0) { d[i] = d[i + 1] = d[i + 2] = 128 + g; }
        else {
            // luminance grain shared by all channels plus a per-channel part (colour negative films)
            d[i] = 128 + g * (1 - chroma) + (rand() + rand() - 1) * 127 * chroma;
            d[i + 1] = 128 + g * (1 - chroma) + (rand() + rand() - 1) * 127 * chroma;
            d[i + 2] = 128 + g * (1 - chroma) + (rand() + rand() - 1) * 127 * chroma;
        }
        d[i + 3] = 255;
    }
    nctx.putImageData(nd, 0, 0);
    const big = makeCanvas(W, H);
    const bctx = big.getContext("2d");
    bctx.imageSmoothingEnabled = size > 1;
    bctx.drawImage(noise, 0, 0, W, H);
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data;
    const nz = bctx.getImageData(0, 0, W, H).data;
    const k = amount * 0.9;
    for (let i = 0; i < px.length; i += 4) {
        // grain is strongest in the midtones, weaker in deep shadows and highlights
        const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        const w = k * (0.35 + 0.65 * (1 - Math.abs(2 * lum - 1)));
        px[i] = clamp255(px[i] + (nz[i] - 128) * w);
        px[i + 1] = clamp255(px[i + 1] + (nz[i + 1] - 128) * w);
        px[i + 2] = clamp255(px[i + 2] + (nz[i + 2] - 128) * w);
    }
    octx.putImageData(img, 0, 0);
    return out;
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
// registry
// ---------------------------------------------------------------------------

export const FILTERS = {
    grain: {
        label: "Grain",
        params: [
            { key: "preset", label: "Film", type: "select", options: GRAIN_PRESETS, default: "custom" },
            { key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 25, unit: "%" },
            { key: "size", label: "Size", min: 0.5, max: 6, step: 0.1, default: 1.5, unit: "px" },
            { key: "chroma", label: "Colour", min: 0, max: 100, step: 1, default: 0, unit: "%" },
        ],
        presets: GRAIN_PRESETS,
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
