// Generated from DenRakEiw/scumble renderer/editor/inpaint_filters_gl.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// WebGL2 path for the filter layers: the point adjustments (levels, curves, brightness /
// contrast, hue / saturation, colour balance, black & white, invert), the 3D LUT and the
// grain run as one fragment shader pass instead of a getImageData / putImageData loop
// over every pixel. applyFilter() in inpaint_filters.js asks applyFilterGL() first and
// falls back to the CPU code when this returns null (no WebGL2, a side longer than the
// texture limit, a context loss, a GL error). Pictures larger than the drawing buffer
// Chromium grants (about 33 MP) are rendered in tiles, see renderTiled(). The maths mirrors the CPU functions, including their 8-bit
// quantisation between steps, so both paths give the same picture within rounding.
//
// Blur, sharpen and vignette stay in inpaint_filters.js: they already run through
// ctx.filter and gradients, which the browser accelerates.
//
// Shared with the ComfyUI node since C0 (docs/BUILD_NODE.md), together with the applyFilter
// hook in inpaint_filters.js; without WebGL2 the CPU paths run.

import { curvesToTables } from "./inpaint_curves.js";
import { levelsTable, brightnessContrastTable, hueSatMatrix, lightnessTable, colorBalanceTables, hueToRgb, LOOK_DEFAULT, grainNoiseCanvas, colourStats } from "./inpaint_filters.js";

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_src;
uniform sampler2D u_table;     // 256 x 1 RGBA8: one 8-bit table per channel
uniform sampler2D u_offsets;   // 256 x 1 RGBA32F: colour balance offsets by luma, in 0..255 units
uniform sampler2D u_noise;     // W x H RGBA8: the grain field
uniform sampler3D u_lut;       // N x N x N RGBA8, red fastest
uniform vec2 u_size;
uniform vec2 u_tile;
uniform int u_mode;            // 0 tables, 1 matrix (+ table), 2 colour balance, 3 black & white, 4 lut, 5 grain
uniform mat3 u_matrix;
uniform bool u_useTable;
uniform vec3 u_weights;
uniform vec3 u_tint;
uniform float u_strength;
uniform float u_lutN;
uniform float u_k;             // grain: amount * gain
uniform float u_center;        // grain: noise centre, 0..255
uniform bool u_lookOn;
uniform bool u_useMix;
uniform mat3 u_mix;
uniform bool u_useMono;
uniform vec3 u_mono;
uniform vec3 u_wb;             // warmth red, tint green, warmth blue factors
uniform float u_satK;
uniform float u_conK;
uniform float u_fade;
uniform float u_lookStrength;
uniform vec3 u_meanS;          // colour match: mean of what is below, 0..255
uniform vec3 u_meanT;          // mean of the layer itself
uniform vec3 u_mScale;         // spread ratio per channel, clamped 0.5..2 by the caller
uniform float u_mStrength;
uniform vec3 u_nMean;          // normalise: the layer's mean colour, 0..1
uniform vec3 u_nLo;            // its 1 % and 99 % levels, 0..1
uniform vec3 u_nHi;
uniform float u_nAmount;
uniform int u_nMode;           // 0 colours towards the mean, 1 everything, 2 stretch levels
uniform bool u_dstTop;         // the target's first row is the image's top (a surface) instead of its bottom (the drawing buffer)
out vec4 o;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// 8-bit rounding like a Uint8ClampedArray store between two CPU passes
vec3 q8(vec3 c) { return floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }

vec3 tables(vec3 c) {
    vec3 i = (floor(c * 255.0 + 0.5) + 0.5) / 256.0;
    return vec3(texture(u_table, vec2(i.r, 0.5)).r, texture(u_table, vec2(i.g, 0.5)).g, texture(u_table, vec2(i.b, 0.5)).b);
}

vec3 look(vec3 c) {
    vec3 c0 = c;
    if (u_useMix) c = u_mix * c;
    if (u_useMono) { float l = dot(u_mono, c); c = vec3(l); }
    c *= u_wb;
    if (!u_useMono && u_satK != 1.0) { float l = dot(c, LUMA); c = l + (c - l) * u_satK; }
    if (u_conK != 1.0) c = 0.5 + (c - 0.5) * u_conK;
    if (u_fade != 0.0) c = u_fade + c * (1.0 - u_fade * 1.2);
    if (u_lookStrength < 1.0) c = c0 + (c - c0) * u_lookStrength;
    return clamp(c, 0.0, 1.0);
}

void main() {
    vec2 uv = (gl_FragCoord.xy + u_tile) / u_size;
    vec2 suv = vec2(uv.x, u_dstTop ? uv.y : 1.0 - uv.y);
    vec4 s = texture(u_src, suv);
    vec3 c = s.rgb;
    if (u_mode == 0) {
        c = tables(c);
    } else if (u_mode == 1) {
        c = q8(u_matrix * c);
        if (u_useTable) c = tables(c);
    } else if (u_mode == 2) {
        float l = floor(dot(c * 255.0, LUMA) + 0.5);
        vec3 d = texture(u_offsets, vec2((l + 0.5) / 256.0, 0.5)).rgb;
        c = (c * 255.0 + d) / 255.0;
    } else if (u_mode == 3) {
        float l = dot(c * 255.0, u_weights);
        float shape = l < 127.5 ? l / 127.5 : (255.0 - l) / 127.5;
        c = (vec3(l) + u_tint * shape) / 255.0;
    } else if (u_mode == 4) {
        vec3 t = texture(u_lut, (c * (u_lutN - 1.0) + 0.5) / u_lutN).rgb;
        c = c + (t - c) * u_strength;
    } else if (u_mode == 6) {
        if (s.a > 0.0) {
            vec3 p = c * 255.0;
            vec3 v = (p - u_meanT) * u_mScale + u_meanS;
            c = clamp(p + (v - p) * u_mStrength, 0.0, 255.0) / 255.0;
        }
    } else if (u_mode == 7) {
        vec3 t;
        if (u_nMode == 0) { float y = dot(c, LUMA); float ym = dot(u_nMean, LUMA); t = vec3(y) + (u_nMean - vec3(ym)); }
        else if (u_nMode == 1) { t = u_nMean; }
        else { t = clamp((c - u_nLo) / max(u_nHi - u_nLo, vec3(1.0 / 255.0)), 0.0, 1.0); }
        c = clamp(c + (t - c) * u_nAmount, 0.0, 1.0);
    } else if (u_mode == 5) {
        if (u_lookOn) c = q8(look(c));
        if (u_k > 0.0) {
            vec3 nz = texture(u_noise, suv).rgb * 255.0;
            float lum = dot(c, LUMA);
            float w = u_k * (0.35 + 0.65 * (1.0 - abs(2.0 * lum - 1.0)));
            c = (c * 255.0 + (nz - u_center) * w) / 255.0;
        }
    }
    o = vec4(clamp(c, 0.0, 1.0), s.a);
}`;

const SUPPORTED = new Set(["levels", "curves", "brightness_contrast", "hue_sat", "color_balance", "bw", "invert", "lut", "grain", "normalize"]);

/**
 * Draw the full-screen triangle for a W x H result and return it as a 2D canvas.
 *
 * Chromium caps the WebGL drawing buffer at about 33 megapixels (5760 x 5760 on an RTX
 * 5090 with D3D11, whatever MAX_VIEWPORT_DIMS and MAX_RENDERBUFFER_SIZE say) and keeps
 * that quiet: the canvas reports the requested size, drawingBufferWidth / Height are
 * smaller, and a single pass leaves only the lower-left corner of the picture in the
 * buffer, which drawImage then stretches to full size (seen with a 10864 x 6062 image
 * and the film look). So the picture is rendered in tiles that fit the buffer: the
 * canvas takes the tile's size and u_tile shifts gl_FragCoord to the tile's origin, so
 * every fragment sees the same uv, u_size and neighbours as in a single pass.
 * Returns null after a GL error (the caller falls back to the CPU path).
 */
function renderTiled(g, uTile, uDstTop, W, H, label) {
    const { gl } = g;
    gl.uniform1i(uDstTop, 0);   // the drawing buffer's first row is the image's bottom
    STATS.passes++;
    STATS.readbacks++;
    if (g.canvas.width !== W || g.canvas.height !== H) { g.canvas.width = W; g.canvas.height = H; }
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    let tw = gl.drawingBufferWidth, th = gl.drawingBufferHeight;
    if (tw >= W && th >= H) {
        gl.viewport(0, 0, W, H);
        gl.uniform2f(uTile, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", label, "GL error", err); return null; }
        octx.drawImage(g.canvas, 0, 0);
        return out;
    }
    // Too large for the drawing buffer: render the whole picture once into a texture
    // (framebuffer attachments go up to MAX_TEXTURE_SIZE, not the drawing buffer's 33 MP)
    // and copy it out in pieces. The shader then runs once instead of once per tile.
    if (W <= g.max && H <= g.max) {
        const done = renderToTexture(g, uTile, uDstTop, W, H, label, octx);
        if (done) return out;
        if (done === null) return null;
    }
    tw = Math.max(1, Math.min(W, tw)); th = Math.max(1, Math.min(H, th));
    for (let y0 = 0; y0 < H; y0 += th) {
        for (let x0 = 0; x0 < W; x0 += tw) {
            const w = Math.min(tw, W - x0), h = Math.min(th, H - y0);
            // the canvas is exactly the tile, so buffer and canvas agree; buffer row 0 is the
            // bottom of the tile, which is image row y0 + h - 1 (the shader flips v)
            if (g.canvas.width !== w || g.canvas.height !== h) { g.canvas.width = w; g.canvas.height = h; }
            if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) { console.warn("WebGL2 filter", label, "drawing buffer too small for a", w, "x", h, "tile"); return null; }
            gl.viewport(0, 0, w, h);
            gl.uniform2f(uTile, x0, H - y0 - h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const err = gl.getError();
            if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", label, "GL error", err); return null; }
            octx.drawImage(g.canvas, 0, 0, w, h, x0, y0, w, h);
        }
    }
    return out;
}

/**
 * Render the current program into an off-screen RGBA8 texture of W x H and copy that into
 * `octx` with blitFramebuffer, in pieces the drawing buffer can hold. Returns true when it
 * worked, false to fall back to per-tile rendering, null after a GL error.
 */
function renderToTexture(g, uTile, uDstTop, W, H, label, octx) {
    const { gl } = g;
    let tex = null, fbo = null;
    try {
        tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
        fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return false;
        }
        gl.viewport(0, 0, W, H);
        gl.uniform2f(uTile, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        let err = gl.getError();
        if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", label, "GL error", err); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return null; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // the texture holds the result bottom up, like the canvas: tile y0 sits at H - y0 - h
        let tw = Math.max(1, Math.min(W, gl.drawingBufferWidth));
        let th = Math.max(1, Math.min(H, gl.drawingBufferHeight));
        for (let y0 = 0; y0 < H; y0 += th) {
            for (let x0 = 0; x0 < W; x0 += tw) {
                const w = Math.min(tw, W - x0), h = Math.min(th, H - y0);
                if (g.canvas.width !== w || g.canvas.height !== h) { g.canvas.width = w; g.canvas.height = h; }
                if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) { console.warn("WebGL2 filter", label, "drawing buffer too small for a", w, "x", h, "piece"); return null; }
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
                const sy = H - y0 - h;
                gl.blitFramebuffer(x0, sy, x0 + w, sy + h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                err = gl.getError();
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
                if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", label, "blit error", err); return null; }
                octx.drawImage(g.canvas, 0, 0, w, h, x0, y0, w, h);
            }
        }
        return true;
    } catch (err) {
        console.warn("WebGL2 filter", label, "off-screen target failed:", err.message || err);
        try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (_) { /* ignore */ }
        return false;
    } finally {
        if (fbo) { try { gl.deleteFramebuffer(fbo); } catch (_) { /* ignore */ } }
        if (tex) { try { gl.deleteTexture(tex); } catch (_) { /* ignore */ } }
    }
}

// ---- render targets: a chain of filters stays on the GPU (docs/PERFORMANCE.md, phase 5 step 2) ----
//
// What costs time in the path above is not the shader: a round trip canvas -> texture ->
// canvas costs 0.6 to 1.0 ms whatever the picture's size, because it synchronises the 2D
// canvas with the WebGL context twice, and a realistic film stack pays seven of them per
// frame (the film look alone is four: colour, halation extract, halation, grain). A
// GLSurface is an RGBA8 texture with a framebuffer, so a stage can write into one and the
// next stage read it without touching a canvas: one upload for the whole chain, one read
// back at the end.
//
// A surface is asked for with `info.chain` and can come back from applyFilterGL, runShader
// and therefore from applyFilter; the caller has to expect either and turn a surface into a
// canvas with glToCanvas() (or draw it with drawSurfaceTo()) when it needs pixels. Surfaces
// are stored top down like a canvas texture - u_dstTop flips the fragment mapping when the
// target is a surface - so nothing downstream has to know where its input came from.
//
// Lifetime: beginScope() / endScope(keep) around one run. Every surface a run acquires goes
// back into the pool at endScope except the one it returns, which the caller owns and
// releases with releaseSurface() (or hands on to the next stage). The pool keeps idle
// textures per size, capped by POOL_BUDGET.

// Measured crossover (film look + halation + grain, tools/composite_test.py's document at
// several sizes): up to about 8 MP a chain is roughly twice as fast as the canvas round
// trips, at 12 MP the two are even, and above that the chain loses - the surfaces no longer
// fit the pool, so every frame creates and destroys textures again, and each read back
// carries an extra full-size blit. A screen-resolution pass is 2 to 8 MP, so the cap keeps
// the interactive path on the chain and leaves the full-resolution renders (export, run) on
// the path they had.
const CHAIN_MAX_PIXELS = 10e6;
// What the chain is for, counted: `uploads` and `readbacks` are the round trips between the
// 2D canvas and the GPU (0.6 ms and up each, whatever the size), `passes` the shader runs.
// tools/perf_test.py and tools/composite_test.py read them through glChainStats().
const STATS = { uploads: 0, readbacks: 0, passes: 0, surfacePasses: 0, surfacesMade: 0 };

/** The round trip counters; `reset` zeroes them and returns what they were. */
export function glChainStats(reset = false) {
    const out = { ...STATS, pooledBytes: poolBytes };
    if (reset) for (const k of Object.keys(STATS)) STATS[k] = 0;
    return out;
}
const POOL_BUDGET = 320 * 1024 * 1024;     // bytes of idle surfaces kept for reuse
const POOL = new Map();                    // "w x h" -> [GLSurface]
const SCOPES = [];
let poolBytes = 0;

class GLSurface {
    constructor(gen, w, h, tex, fbo) {
        this.isGLSurface = true;
        this.gen = gen;
        this.width = w;
        this.height = h;
        this.tex = tex;
        this.fbo = fbo;
        this.pooled = false;
    }

    get bytes() { return this.width * this.height * 4; }
}

/** Is this a GPU surface rather than a canvas? */
export function isGLSurface(v) { return !!(v && v.isGLSurface); }

/** Can a chain of that size run on the GPU at all? (the editor asks before it starts one) */
export function glChainUsable(w, h) {
    const g = context();
    return !!g && w > 0 && h > 0 && w * h <= CHAIN_MAX_PIXELS && w <= g.max && h <= g.max;
}

function createSurface(g, w, h) {
    const { gl } = g;
    let tex = null, fbo = null;
    try {
        tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
        fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!ok) throw new Error("framebuffer incomplete");
        STATS.surfacesMade++;
        return new GLSurface(g.gen, w, h, tex, fbo);
    } catch (err) {
        console.warn("WebGL2 filter surface", w, "x", h, "failed:", err.message || err);
        try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (_) { /* ignore */ }
        if (fbo) { try { gl.deleteFramebuffer(fbo); } catch (_) { /* ignore */ } }
        if (tex) { try { gl.deleteTexture(tex); } catch (_) { /* ignore */ } }
        return null;
    }
}

function destroySurface(s) {
    if (!G || G.lost || !s || s.gen !== G.gen) return;
    try { G.gl.deleteFramebuffer(s.fbo); G.gl.deleteTexture(s.tex); } catch (_) { /* ignore */ }
}

function acquireSurface(g, w, h) {
    const free = POOL.get(w + "x" + h);
    let s = null;
    while (free && free.length) {
        const c = free.pop();
        poolBytes -= c.bytes;
        if (c.gen === g.gen) { s = c; break; }
        destroySurface(c);
    }
    if (!s) s = createSurface(g, w, h);
    if (!s) return null;
    s.pooled = false;
    if (SCOPES.length) SCOPES[SCOPES.length - 1].push(s);
    return s;
}

function trimPool() {
    while (poolBytes > POOL_BUDGET) {
        let biggest = null;
        for (const list of POOL.values()) if (list.length && (!biggest || list[0].bytes > biggest[0].bytes)) biggest = list;
        if (!biggest) break;
        const s = biggest.shift();
        poolBytes -= s.bytes;
        destroySurface(s);
    }
}

/** Give a surface back for reuse. Anything else (a canvas, null) is ignored. */
export function releaseSurface(s) {
    if (!isGLSurface(s) || s.pooled) return;
    if (!G || G.lost || s.gen !== G.gen) return;
    const key = s.width + "x" + s.height;
    let free = POOL.get(key);
    if (!free) POOL.set(key, free = []);
    s.pooled = true;
    free.push(s);
    poolBytes += s.bytes;
    trimPool();
}

/**
 * A census of the surface pool for the memory report (docs/PHASE6_PLAN.md step 1d):
 * idle surfaces per size, their bytes, how many belong to a context that is already
 * gone, and how many surfaces the open scopes are still holding.
 */
export function glPoolStats() {
    const gen = G ? G.gen : -1;
    const sizes = [];
    let foreign = 0, foreignBytes = 0;
    for (const [key, list] of POOL) {
        if (!list.length) continue;
        let bytes = 0;
        for (const s of list) {
            bytes += s.bytes;
            if (s.gen !== gen) { foreign++; foreignBytes += s.bytes; }
        }
        sizes.push({ size: key, count: list.length, bytes });
    }
    sizes.sort((a, b) => b.bytes - a.bytes);
    let held = 0, heldBytes = 0;
    for (const list of SCOPES) for (const s of list) { held++; heldBytes += s.bytes; }
    return { bytes: poolBytes, budget: POOL_BUDGET, sizes, foreign, foreignBytes, scopes: SCOPES.length, held, heldBytes, gen };
}

/**
 * Give the GPU everything back: the idle surfaces, the source texture and the drawing
 * buffer of the shared context. Returns the bytes it dropped. Only safe between frames -
 * ed.releaseCaches({ deep: true }) and the Free VRAM button are the callers. The next
 * filter run rebuilds what it needs.
 */
export function glReleasePool() {
    let freed = poolBytes;
    for (const list of POOL.values()) while (list.length) destroySurface(list.pop());
    POOL.clear();
    poolBytes = 0;
    if (G && !G.lost) {
        try {
            const { gl } = G;
            freed += G.canvas.width * G.canvas.height * 4 * 2;   // the drawing buffer, double buffered
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, G.texSrc);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            G.canvas.width = G.canvas.height = 1;
        } catch (_) { /* context gone */ }
    }
    return freed;
}

/** Open a scope: every surface acquired until endScope() goes back to the pool there. */
export function beginScope() { SCOPES.push([]); }

/** Close the scope; `keep` (the run's result) survives and belongs to the caller. */
export function endScope(keep) {
    const list = SCOPES.pop() || [];
    for (const s of list) if (s !== keep) releaseSurface(s);
    if (isGLSurface(keep) && SCOPES.length) SCOPES[SCOPES.length - 1].push(keep);
    return keep;
}

/** Bind the source of a pass to unit 0: a surface is already a texture, a canvas is uploaded. */
function bindSource(g, src) {
    const { gl } = g;
    gl.activeTexture(gl.TEXTURE0);
    if (isGLSurface(src)) { gl.bindTexture(gl.TEXTURE_2D, src.tex); return; }
    gl.bindTexture(gl.TEXTURE_2D, g.texSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    STATS.uploads++;
}

/** Should this pass write into a surface? */
function wantSurface(g, info, W, H) {
    return !!(info && info.chain) && W * H <= CHAIN_MAX_PIXELS && W <= g.max && H <= g.max;
}

/** Draw the current program into a pooled surface (its first row is the image's top). */
function renderToSurface(g, uTile, uDstTop, W, H, label) {
    const { gl } = g;
    const s = acquireSurface(g, W, H);
    if (!s) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.viewport(0, 0, W, H);
    gl.uniform2f(uTile, 0, 0);
    gl.uniform1i(uDstTop, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    STATS.passes++;
    STATS.surfacePasses++;
    const err = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.uniform1i(uDstTop, 0);
    if (err !== gl.NO_ERROR) { console.warn("WebGL2 filter", label, "GL error", err); releaseSurface(s); return null; }
    return s;
}

/** One pass: into a surface when the caller is chaining, otherwise into a canvas as before. */
function renderOut(g, uTile, uDstTop, W, H, label, info) {
    if (wantSurface(g, info, W, H)) {
        const s = renderToSurface(g, uTile, uDstTop, W, H, label);
        if (s) return s;
    }
    return renderTiled(g, uTile, uDstTop, W, H, label);
}

/**
 * Copy a surface into the drawing buffer and hand every piece that fits to
 * `draw(x0, y0, w, h)` (image coordinates). The blit flips y: the surface holds the image
 * top down, the drawing buffer bottom up, and drawImage flips it back.
 */
function readSurface(g, s, draw) {
    const { gl } = g;
    STATS.readbacks++;
    const W = s.width, H = s.height;
    if (g.canvas.width !== W || g.canvas.height !== H) { g.canvas.width = W; g.canvas.height = H; }
    const piece = (x0, y0, w, h) => {
        if (g.canvas.width !== w || g.canvas.height !== h) { g.canvas.width = w; g.canvas.height = h; }
        if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) { console.warn("WebGL2 surface read: drawing buffer too small for", w, "x", h); return false; }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(x0, y0 + h, x0 + w, y0, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        const err = gl.getError();
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        if (err !== gl.NO_ERROR) { console.warn("WebGL2 surface blit error", err); return false; }
        draw(x0, y0, w, h);
        return true;
    };
    if (gl.drawingBufferWidth >= W && gl.drawingBufferHeight >= H) return piece(0, 0, W, H);
    const tw = Math.max(1, Math.min(W, gl.drawingBufferWidth)), th = Math.max(1, Math.min(H, gl.drawingBufferHeight));
    for (let y0 = 0; y0 < H; y0 += th) {
        for (let x0 = 0; x0 < W; x0 += tw) {
            if (!piece(x0, y0, Math.min(tw, W - x0), Math.min(th, H - y0))) return false;
        }
    }
    return true;
}

/** A surface as a fresh 2D canvas, or null when it cannot be read back. */
export function surfaceToCanvas(s) {
    const g = context();
    if (!g || !isGLSurface(s) || s.gen !== g.gen) return null;
    const out = makeCanvas(s.width, s.height);
    const octx = out.getContext("2d");
    return readSurface(g, s, (x0, y0, w, h) => octx.drawImage(g.canvas, 0, 0, w, h, x0, y0, w, h)) ? out : null;
}

/** Whatever came out of the filter chain, as a canvas. */
export function glToCanvas(v) { return isGLSurface(v) ? (surfaceToCanvas(v) || v) : v; }

/** Draw a surface straight onto a 2D context (no intermediate canvas). */
export function drawSurfaceTo(ctx, s, dx, dy, dw, dh) {
    const g = context();
    if (!g || !isGLSurface(s) || s.gen !== g.gen) return false;
    const sx = dw / s.width, sy = dh / s.height;
    return readSurface(g, s, (x0, y0, w, h) => ctx.drawImage(g.canvas, 0, 0, w, h, dx + x0 * sx, dy + y0 * sy, w * sx, h * sy));
}

let G = null;          // the shared context, created on first use
let unavailable = false;
const lutTextures = new WeakMap();   // lut object -> { tex, gen }

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

function copyCanvas(src) {
    const out = makeCanvas(src.width, src.height);
    out.getContext("2d").drawImage(src, 0, 0);
    return out;
}

function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
    return sh;
}

function texture2d(gl, unit, filter) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

function context() {
    if (G && !G.lost) return G;
    if (unavailable) return null;
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: true, desynchronized: false });
        if (!gl) { unavailable = true; return null; }
        const gen = (G ? G.gen : 0) + 1;
        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (G && G.gl === gl) G.lost = true; });
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, "a_pos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        for (const pg of PLUGIN_GL.values()) pg.prog = null;   // programs of a lost context
        const u = {};
        for (const name of ["u_src", "u_table", "u_offsets", "u_noise", "u_lut", "u_size", "u_mode", "u_matrix", "u_useTable", "u_weights", "u_tint", "u_strength", "u_lutN", "u_k", "u_center",
            "u_lookOn", "u_useMix", "u_mix", "u_useMono", "u_mono", "u_wb", "u_satK", "u_conK", "u_fade", "u_lookStrength", "u_tile", "u_dstTop",
            "u_meanS", "u_meanT", "u_mScale", "u_mStrength", "u_nMean", "u_nLo", "u_nHi", "u_nAmount", "u_nMode"]) u[name] = gl.getUniformLocation(prog, name);
        // fixed texture units: 0 source, 1 table, 2 offsets, 3 noise, 4 lut
        const texSrc = texture2d(gl, 0, gl.NEAREST);
        const texTable = texture2d(gl, 1, gl.NEAREST);
        const texOffsets = texture2d(gl, 2, gl.NEAREST);
        gl.uniform1i(u.u_src, 0); gl.uniform1i(u.u_table, 1); gl.uniform1i(u.u_offsets, 2); gl.uniform1i(u.u_noise, 3); gl.uniform1i(u.u_lut, 4);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.disable(gl.BLEND);
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        const max = Math.min(maxTex, maxView[0], maxView[1], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        const emptyNoise = texture2d(gl, 3, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
        const emptyLut = gl.createTexture();
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_3D, emptyLut);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        G = { gl, canvas, prog, u, aPos, texSrc, texTable, texOffsets, emptyNoise, emptyLut, max, gen, lost: false, max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) };
        return G;
    } catch (err) {
        console.warn("WebGL2 filters unavailable:", err.message || err);
        unavailable = true;
        return null;
    }
}

/** Upload one 8-bit table per channel as a 256 x 1 RGBA texture (unit 1). */
function setTables(g, tr, tg = tr, tb = tr) {
    const { gl } = g;
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { data[i * 4] = tr[i]; data[i * 4 + 1] = tg[i]; data[i * 4 + 2] = tb[i]; data[i * 4 + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.texTable);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const INVERT_TABLE = (() => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = 255 - i; return t; })();

/** Column-major mat3 for GLSL from a row-major 3x3 (applied as M * c). */
function mat3(m) {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

// ---------------------------------------------------------------------------
// grain noise field (same algorithm as applyGrain in inpaint_filters.js, drawn into a
// canvas that becomes the noise texture; never read back to the CPU)
// ---------------------------------------------------------------------------

// The noise field itself comes from inpaint_filters.js (grainNoiseCanvas): one cached
// tile of cells, repeated and anchored at the image origin. Both paths must see exactly
// the same field, so there is no second implementation here.

// ---------------------------------------------------------------------------
// per-filter setup: uniforms and textures. Return false for "nothing to do" (the CPU
// path returns a plain copy there too), null to hand over to the CPU.
// ---------------------------------------------------------------------------

const SETUP = {
    levels(g, p) {
        const { gl, u } = g;
        setTables(g, levelsTable(p));
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    curves(g, p, info, src) {
        const { gl, u } = g;
        // the curve editor draws a luma histogram of the input; a 256 px thumbnail is plenty for
        // that (a chained input is a texture, which would have to be read back: no histogram then)
        if (info && info.cache && !isGLSurface(src)) {
            const s = Math.min(1, 256 / Math.max(src.width, src.height));
            const tw = Math.max(1, Math.round(src.width * s)), th = Math.max(1, Math.round(src.height * s));
            const t = makeCanvas(tw, th);
            const tctx = t.getContext("2d");
            tctx.drawImage(src, 0, 0, tw, th);
            const px = tctx.getImageData(0, 0, tw, th).data;
            const hist = new Uint32Array(256);
            for (let i = 0; i < px.length; i += 4) hist[(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] + 0.5) | 0]++;
            info.cache.histogram = hist;
        }
        const tables = curvesToTables(p.curves);
        if (!tables) return false;
        setTables(g, tables.r, tables.g, tables.b);
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    brightness_contrast(g, p) {
        const { gl, u } = g;
        if (!(p.brightness ?? 0) && !(p.contrast ?? 0)) return false;
        setTables(g, brightnessContrastTable(p.brightness, p.contrast));
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    invert(g) {
        const { gl, u } = g;
        setTables(g, INVERT_TABLE);
        gl.uniform1i(u.u_mode, 0);
        return true;
    },
    normalize(g, p, info, src) {
        const { gl, u } = g;
        const k = Math.max(0, Math.min(1, (p.amount ?? 50) / 100));
        if (!k) return false;
        // the statistics need pixels: a chained input is a texture, so the CPU path takes over there
        if (isGLSurface(src)) return null;
        const st = colourStats(src);
        gl.uniform1i(u.u_mode, 7);
        gl.uniform3f(u.u_nMean, st.mean[0] / 255, st.mean[1] / 255, st.mean[2] / 255);
        gl.uniform3f(u.u_nLo, st.lo[0] / 255, st.lo[1] / 255, st.lo[2] / 255);
        gl.uniform3f(u.u_nHi, st.hi[0] / 255, st.hi[1] / 255, st.hi[2] / 255);
        gl.uniform1f(u.u_nAmount, k);
        gl.uniform1i(u.u_nMode, p.mode === "levels" ? 2 : p.mode === "all" ? 1 : 0);
        return true;
    },
    hue_sat(g, p) {
        const { gl, u } = g;
        const hue = p.hue ?? 0, sat = p.saturation ?? 0, light = p.lightness ?? 0;
        if (!hue && !sat && !light) return false;
        const M = hue || sat ? hueSatMatrix(hue, Math.max(0, 1 + sat / 100)) : IDENTITY;
        gl.uniformMatrix3fv(u.u_matrix, false, mat3(M));
        gl.uniform1i(u.u_useTable, light ? 1 : 0);
        if (light) setTables(g, lightnessTable(light));
        gl.uniform1i(u.u_mode, 1);
        return true;
    },
    color_balance(g, p) {
        const { gl, u } = g;
        const keys = ["shadows_cr", "shadows_mg", "shadows_yb", "mid_cr", "mid_mg", "mid_yb", "high_cr", "high_mg", "high_yb"];
        if (keys.every((k) => !(p[k] ?? 0))) return false;
        const { dR, dG, dB } = colorBalanceTables(p);
        const data = new Float32Array(256 * 4);
        for (let i = 0; i < 256; i++) { data[i * 4] = dR[i]; data[i * 4 + 1] = dG[i]; data[i * 4 + 2] = dB[i]; data[i * 4 + 3] = 1; }
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, g.texOffsets);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
        gl.uniform1i(u.u_mode, 2);
        return true;
    },
    bw(g, p) {
        const { gl, u } = g;
        let wr = p.red ?? 30, wg = p.green ?? 59, wb = p.blue ?? 11;
        const sum = wr + wg + wb;
        if (sum > 0) { wr /= sum; wg /= sum; wb /= sum; } else { wr = 0.299; wg = 0.587; wb = 0.114; }
        const strength = Math.max(0, Math.min(1, (p.tint_strength ?? 0) / 100));
        let tr = 0, tg = 0, tb = 0;
        if (strength > 0) {
            const t = hueToRgb(p.tint_hue ?? 35);
            const A = 0.35 * 255 * strength;
            tr = (t[0] - 0.5) * A; tg = (t[1] - 0.5) * A; tb = (t[2] - 0.5) * A;
        }
        gl.uniform3f(u.u_weights, wr, wg, wb);
        gl.uniform3f(u.u_tint, tr, tg, tb);
        gl.uniform1i(u.u_mode, 3);
        return true;
    },
    lut(g, p, info) {
        const { gl, u } = g;
        const lut = info.lut;
        const strength = (p.strength ?? 100) / 100;
        if (!lut || !lut.data || strength <= 0) return false;
        const N = lut.size;
        if (!(N > 1) || N > g.max3d) return null;
        let entry = lutTextures.get(lut);
        if (!entry || entry.gen !== g.gen) {
            const data = new Uint8Array(N * N * N * 4);
            const src = lut.data;
            for (let i = 0, j = 0; i < N * N * N; i++, j += 3) {
                data[i * 4] = Math.max(0, Math.min(255, Math.round(src[j] * 255)));
                data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(src[j + 1] * 255)));
                data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(src[j + 2] * 255)));
                data[i * 4 + 3] = 255;
            }
            const tex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_3D, tex);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            entry = { tex, gen: g.gen };
            lutTextures.set(lut, entry);
        } else {
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_3D, entry.tex);
        }
        gl.uniform1f(u.u_lutN, N);
        gl.uniform1f(u.u_strength, strength);
        gl.uniform1i(u.u_mode, 4);
        return true;
    },
    grain(g, p, info, src) {
        const { gl, u } = g;
        const W = src.width, H = src.height;
        const amount = (p.amount ?? 25) / 100;
        const size = Math.max(0.5, (p.size ?? 1.5) * (info.scale || 1));
        const chroma = Math.min(1, Math.max(0, (p.chroma ?? (p.mono === false ? 100 : 0)) / 100));
        const lookStrength = Math.min(1, Math.max(0, (p.look_strength ?? 100) / 100));
        const lookOn = !!(p.look && lookStrength > 0);
        gl.uniform1i(u.u_lookOn, lookOn ? 1 : 0);
        if (lookOn) {
            const L = { ...LOOK_DEFAULT, ...p.look };
            const mix = Array.isArray(L.mix) && L.mix.length === 9 ? L.mix : null;
            const mono = Array.isArray(L.mono) && L.mono.length === 3 ? L.mono : null;
            gl.uniform1i(u.u_useMix, mix ? 1 : 0);
            gl.uniformMatrix3fv(u.u_mix, false, mat3(mix || IDENTITY));
            gl.uniform1i(u.u_useMono, mono ? 1 : 0);
            if (mono) { const s = mono[0] + mono[1] + mono[2] || 1; gl.uniform3f(u.u_mono, mono[0] / s, mono[1] / s, mono[2] / s); } else gl.uniform3f(u.u_mono, 0, 0, 0);
            gl.uniform3f(u.u_wb, 1 + L.warmth / 300, 1 - L.tint / 300, 1 - L.warmth / 300);
            gl.uniform1f(u.u_satK, 1 + L.sat / 100);
            gl.uniform1f(u.u_conK, 1 + L.contrast / 100);
            gl.uniform1f(u.u_fade, L.fade / 100);
            gl.uniform1f(u.u_lookStrength, lookStrength);
        }
        gl.uniform1i(u.u_mode, 5);
        if (amount <= 0) { gl.uniform1f(u.u_k, 0); return true; }
        const cache = info.cache || {};
        const usePlate = !!(info.plate && info.plate.width);
        const sigma = Math.max(0, Math.min(0.5, (p.speckle ?? 25) / 100 * 0.5));
        const sc = Math.max(0.1, (p.plate_scale ?? 1) * (info.scale || 1));
        const org = info.origin || [0, 0];
        const noiseKey = JSON.stringify(usePlate ? ["plate", info.plateKey || "", sc, W, H, org] : ["synth", size, sigma, chroma, String(info.seed || "grain"), W, H, org]);
        let center = 128, gain = 1.3;
        if (usePlate) { center = info.plateMean ?? 128; gain = 40 / Math.max(8, info.plateStd ?? 40); }
        gl.activeTexture(gl.TEXTURE3);
        if (cache.glNoise && cache.glNoise.key === noiseKey && cache.glNoise.gen === g.gen) {
            gl.bindTexture(gl.TEXTURE_2D, cache.glNoise.tex);
        } else {
            if (cache.glNoise && cache.glNoise.gen === g.gen) { try { gl.deleteTexture(cache.glNoise.tex); } catch (_) { /* ignore */ } }
            const big = grainNoiseCanvas(W, H, {
                gs: Math.max(1, size), sigma, chroma, seed: info.seed,
                plate: usePlate ? info.plate : null, plateScale: sc, origin: org,
            });
            const tex = texture2d(gl, 3, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, big);
            cache.glNoise = { key: noiseKey, tex, gen: g.gen };
        }
        gl.uniform1f(u.u_k, amount * gain);
        gl.uniform1f(u.u_center, center);
        return true;
    },
};

// ---- plugin filters: one fragment shader per registered filter (renderer/plugins.js) -------
//
// A plugin hands in GLSL that defines `vec4 shade(vec4 color, vec2 uv)` (`filter` is a
// reserved word in GLSL ES); it gets u_src
// (the input, sample neighbours with uv + vec2(dx, dy) / u_size), u_size, u_scale (1 at
// full resolution, smaller for previews) and u_seed, plus its own uniforms (declared by
// name and type, values from values(params, info) per run).

const PLUGIN_GL = new Map();   // id -> { def: { code, uniforms, values }, prog, u, failed }
const PLUGIN_TYPES = { float: "1f", int: "1i", bool: "1i", vec2: "2fv", vec3: "3fv", vec4: "4fv", sampler2D: "tex" };
const PLUGIN_TEX_UNIT = 5;     // plugin samplers start above the built-in units (0 source, 1 table, 2 offsets, 3 noise, 4 lut)
const ADHOC = new WeakMap();   // shader definition object -> program record (gl.shade for multi-pass plugin filters)

export function registerGLFilter(id, def) {
    for (const [name, type] of Object.entries(def.uniforms || {})) {
        if (!PLUGIN_TYPES[type]) throw new Error(`uniform ${name}: type must be one of ${Object.keys(PLUGIN_TYPES).join(", ")}`);
        if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`uniform "${name}" is not a valid GLSL name`);
    }
    PLUGIN_GL.set(id, { def, prog: null, u: null, failed: false });
}

export function unregisterGLFilter(id) {
    const pg = PLUGIN_GL.get(id);
    if (pg && pg.prog && G && !G.lost) { try { G.gl.deleteProgram(pg.prog); } catch (_) { /* ignore */ } }
    PLUGIN_GL.delete(id);
}

function pluginSource(def) {
    const decls = Object.entries(def.uniforms || {}).map(([n, t]) => `uniform ${t} ${n};`).join("\n");
    return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_tile;
uniform float u_scale;
uniform float u_seed;
uniform bool u_dstTop;
${decls}
out vec4 o;
${def.code}
void main() {
    vec2 uv = (gl_FragCoord.xy + u_tile) / u_size;
    vec2 suv = vec2(uv.x, u_dstTop ? uv.y : 1.0 - uv.y);
    o = shade(texture(u_src, suv), suv);
}`;
}

function pluginProgram(g, pg) {
    if (pg.prog && pg.gen === g.gen) return pg.prog;
    const { gl } = g;
    pg.gen = g.gen;
    pg.samplers = [];
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, pluginSource(pg.def)));
    gl.bindAttribLocation(prog, g.aPos, "a_pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(prog));
    pg.prog = prog;
    pg.u = {};
    for (const name of ["u_src", "u_size", "u_scale", "u_seed", "u_tile", "u_dstTop", ...Object.keys(pg.def.uniforms || {})]) pg.u[name] = gl.getUniformLocation(prog, name);
    for (const [name, type] of Object.entries(pg.def.uniforms || {})) if (type === "sampler2D") pg.samplers.push({ name, unit: PLUGIN_TEX_UNIT + pg.samplers.length, tex: null });
    return prog;
}

/**
 * Upload one plugin sampler: a canvas / ImageData / image, or { data, width, height } with a
 * Uint8(Clamped)Array (RGBA8) or a Float32Array (RGBA32F, e.g. control point tables); `linear`
 * on the value picks bilinear filtering (8-bit sources only).
 */
function uploadSampler(gl, s, v) {
    gl.activeTexture(gl.TEXTURE0 + s.unit);
    if (isGLSurface(v)) { gl.bindTexture(gl.TEXTURE_2D, v.tex); return; }   // another stage's result, already a texture
    if (!s.tex) s.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    const isFloat = !!(v && v.data instanceof Float32Array);
    const f = v && v.linear && !isFloat ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (v && v.data && v.width) {
        const w = v.width | 0, h = (v.height | 0) || 1;
        if (isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, v.data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, v.data instanceof Uint8Array ? v.data : new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength));
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v.canvas || v.image || v);
    }
}

function applyPluginGL(id, pg, src, params, info, override) {
    if (pg.failed) return null;
    const g = context();
    if (!g) return null;
    const W = src.width, H = src.height;
    if (!W || !H || W > g.max || H > g.max) return null;
    if (isGLSurface(src) && src.gen !== g.gen) return null;
    const { gl } = g;
    try {
        const prog = pluginProgram(g, pg);
        gl.useProgram(prog);
        gl.uniform1i(pg.u.u_src, 0);
        gl.uniform1f(pg.u.u_scale, info.scale || 1);
        gl.uniform1f(pg.u.u_seed, +info.seed || 0);
        const values = override || pg.def.values(params || {}, info, src) || {};
        for (const [name, type] of Object.entries(pg.def.uniforms || {})) {
            const v = values[name];
            if (v == null || pg.u[name] == null) continue;
            const setter = PLUGIN_TYPES[type];
            if (setter === "tex") continue;
            if (setter === "1f") gl.uniform1f(pg.u[name], +v);
            else if (setter === "1i") gl.uniform1i(pg.u[name], v === true ? 1 : v === false ? 0 : Math.round(+v));
            else gl["uniform" + setter](pg.u[name], Float32Array.from(v));
        }
        for (const s of pg.samplers) {
            const v = values[s.name];
            if (v == null || pg.u[s.name] == null) continue;
            uploadSampler(gl, s, v);
            gl.uniform1i(pg.u[s.name], s.unit);
        }
        gl.uniform2f(pg.u.u_size, W, H);
        bindSource(g, src);
        return renderOut(g, pg.u.u_tile, pg.u.u_dstTop, W, H, id, info);
    } catch (err) {
        console.warn("plugin WebGL2 filter", id, "failed, using the CPU path:", err.message || err);
        if (gl.isContextLost && gl.isContextLost()) g.lost = true; else pg.failed = true;
        return null;
    }
}

/**
 * Run an ad-hoc shader (`{ code, uniforms, label }`, the same contract as a filter's `glsl`
 * block) on a canvas with the given uniform values; the program is compiled once per
 * definition object. For plugin filters that need several passes (blur between shader
 * stages, halation, control points). Returns the canvas, or null without a GPU path.
 */
export function runShader(def, src, values, info = {}) {
    if (!def || typeof def.code !== "string") throw new Error("gl.shade needs { code, uniforms } with the fragment defining vec4 shade(vec4 color, vec2 uv)");
    let pg = ADHOC.get(def);
    if (!pg) {
        for (const [name, type] of Object.entries(def.uniforms || {})) {
            if (!PLUGIN_TYPES[type]) throw new Error(`uniform ${name}: type must be one of ${Object.keys(PLUGIN_TYPES).join(", ")}`);
            if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`uniform "${name}" is not a valid GLSL name`);
        }
        pg = { def: { code: def.code, uniforms: def.uniforms || {}, values: () => ({}) }, prog: null, u: null, failed: false, label: def.label || "shader" };
        ADHOC.set(def, pg);
    }
    return applyPluginGL(pg.label, pg, src, {}, info, values || {});
}

/**
 * Apply filter `id` to `src` on the GPU. Returns the filtered canvas, or null when this
 * filter or this machine is not covered (the caller then runs the CPU code).
 */
export function applyFilterGL(id, src, params, info = {}) {
    if (!SUPPORTED.has(id)) { const pg = PLUGIN_GL.get(id); return pg ? applyPluginGL(id, pg, src, params, info) : null; }
    const g = context();
    if (!g) return null;
    const W = src.width, H = src.height;
    if (!W || !H || W > g.max || H > g.max) return null;
    if (isGLSurface(src) && src.gen !== g.gen) return null;   // a surface from a context that is gone
    const { gl, u } = g;
    try {
        gl.useProgram(g.prog);
        const ok = SETUP[id](g, params || {}, info, src);
        if (ok === false) return isGLSurface(src) ? src : copyCanvas(src);   // the filter does nothing: pass the input on
        if (ok === null) return null;
        gl.uniform2f(u.u_size, W, H);
        bindSource(g, src);
        return renderOut(g, u.u_tile, u.u_dstTop, W, H, id, info);
    } catch (err) {
        console.warn("WebGL2 filter", id, "failed, using the CPU path:", err.message || err);
        if (gl.isContextLost && gl.isContextLost()) g.lost = true;
        return null;
    }
}

/**
 * The colour match of a layer (inpaint_filters.js matchCanvas) as one shader pass:
 * (value - meanT) * scale + meanS per channel, mixed in by `strength`. Returns the
 * matched canvas, or null when there is no GPU path (the caller runs the pixel loop).
 */
export function applyMatchGL(src, stats, strength, info = {}) {
    if (!stats || !stats.meanS || !stats.meanT || !stats.scale) return null;
    const g = context();
    if (!g) return null;
    const W = src.width, H = src.height;
    if (!W || !H || W > g.max || H > g.max) return null;
    const { gl, u } = g;
    try {
        gl.useProgram(g.prog);
        gl.uniform1i(u.u_mode, 6);
        gl.uniform3f(u.u_meanS, stats.meanS[0], stats.meanS[1], stats.meanS[2]);
        gl.uniform3f(u.u_meanT, stats.meanT[0], stats.meanT[1], stats.meanT[2]);
        gl.uniform3f(u.u_mScale, stats.scale[0], stats.scale[1], stats.scale[2]);
        gl.uniform1f(u.u_mStrength, Math.max(0, Math.min(1, strength)));
        gl.uniform2f(u.u_size, W, H);
        bindSource(g, src);
        return renderOut(g, u.u_tile, u.u_dstTop, W, H, "match", info);
    } catch (err) {
        console.warn("WebGL2 colour match failed, using the CPU path:", err.message || err);
        if (gl.isContextLost && gl.isContextLost()) g.lost = true;
        return null;
    }
}

/** For the settings UI and tests: is the GPU path in use? */
export function glFiltersAvailable() {
    return !!context();
}

/** Tests: run a filter on the CPU and the GPU and report the difference. */
export function compareFilterPaths(cpuApply, id, src, params, info = {}) {
    const a = cpuApply(src, params, { ...info, cache: {} });
    const b = applyFilterGL(id, src, params, { ...info, cache: {} });
    if (!b) return { id, gl: false };
    const W = src.width, H = src.height;
    const pa = a.getContext("2d").getImageData(0, 0, W, H).data, pb = b.getContext("2d").getImageData(0, 0, W, H).data;
    let max = 0, sum = 0, n = 0, over2 = 0;
    for (let i = 0; i < pa.length; i++) {
        if ((i & 3) === 3) continue;
        const d = Math.abs(pa[i] - pb[i]);
        if (d > max) max = d;
        if (d > 2) over2++;
        sum += d; n++;
    }
    return { id, gl: true, max, mean: +(sum / n).toFixed(4), over2: +(over2 / n * 100).toFixed(3) };
}
