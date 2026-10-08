// Generated from DenRakEiw/scumble renderer/editor/inpaint_compositor.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The WebGL2 compositor (large-image plan, phase 5).
 *
 * Canvas 2D composites a layer stack by drawing each layer with a blend mode; at high
 * resolution that costs a full-size draw per layer per frame. This module does the same
 * stacking on the GPU: every source canvas becomes a texture (cached by a version the
 * editor bumps when the pixels change), and the visible region is composited in one shader
 * pass per layer into a viewport-sized framebuffer.
 *
 * What it does NOT do, on purpose: it stacks prepared layer pixels. Masks, colour match,
 * the stroke preview and pending transforms stay where they are - the editor hands over the
 * canvas it would have drawn (`layerPixels`), so every one of those features keeps working
 * unchanged. Filter layers interrupt the chain: the caller renders the stack so far, runs
 * the filter as before and starts a new chain on the result.
 *
 * The blend modes follow the W3C compositing spec and were checked against Canvas 2D over
 * every combination of colour and alpha: at most 2.3 levels apart in premultiplied values
 * (what reaches the screen), mean 0.3. Straight-alpha values differ more where alpha is
 * near zero, which is the 8-bit rounding of the stored premultiplied byte, not a different
 * picture.
 *
 * The editor keeps its Canvas 2D path. `GLCompositor.available()` decides, and the caller
 * falls back whenever this module returns null - the node runs in the user's browser and
 * must not depend on WebGL2.
 */

import { TILE_SIZE, MIP_LEVELS, GUTTER, slotSide } from "./inpaint_tiles.js";

export const BLEND_INDEX = {
    normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4,
    lighten: 5, "soft-light": 6, "hard-light": 7, difference: 8, "linear-light": 9,
};

const VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;      // x, y, w, h of the quad in clip space
out vec2 v_uv;
void main() {
    v_uv = a_pos;
    vec2 p = u_rect.xy + a_pos * u_rect.zw;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

// The blend maths and the compositing step, shared by the quad shader (one source canvas) and the
// atlas shader (one instanced quad per tile).
const BLEND_GLSL = `
uniform sampler2D u_backdrop;   // what is under this layer, straight alpha
uniform sampler2D u_source;     // the layer's pixels, premultiplied
uniform int u_mode;
uniform float u_opacity;
uniform vec2 u_size;            // framebuffer size, to sample the backdrop by position
uniform sampler2D u_clip;       // clipping (PLAN_0_1_31 6.3): the base's coverage in its alpha, by position
uniform int u_hasClip;

float bScreen(float b, float s) { return b + s - b * s; }
float bHardLight(float b, float s) { return s <= 0.5 ? b * (2.0 * s) : bScreen(b, 2.0 * s - 1.0); }
float bSoftLight(float b, float s) {
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float blend1(float b, float s) {
    if (u_mode == 1) return b * s;
    if (u_mode == 2) return bScreen(b, s);
    if (u_mode == 3) return bHardLight(s, b);   // overlay: hard-light with the arguments swapped
    if (u_mode == 4) return min(b, s);
    if (u_mode == 5) return max(b, s);
    if (u_mode == 6) return bSoftLight(b, s);
    if (u_mode == 7) return bHardLight(b, s);
    if (u_mode == 8) return abs(b - s);
    if (u_mode == 9) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);   // linear light (PLAN_0_1_31 §4 step 8)
    return s;
}

vec4 blendOver(vec4 Sp) {
    // The backdrop is a framebuffer texture: same orientation as gl_FragCoord, no flip.
    vec2 fb = gl_FragCoord.xy / u_size;
    vec4 B = texture(u_backdrop, fb);
    // a clipped layer shows where its base is: the base's coverage scales the premultiplied source, as a mask does
    if (u_hasClip == 1) Sp *= texture(u_clip, fb).a;
    // Source textures are premultiplied so that scaling interpolates the way Canvas 2D does
    // (straight alpha bleeds colour across transparent edges); the blend maths needs straight
    // values again.
    vec4 S = vec4(Sp.a > 0.0 ? Sp.rgb / Sp.a : vec3(0.0), Sp.a);
    float as = S.a * u_opacity;
    float ab = B.a;
    vec3 blended = vec3(blend1(B.r, S.r), blend1(B.g, S.g), blend1(B.b, S.b));
    vec3 cs = mix(S.rgb, blended, ab);
    float ao = as + ab * (1.0 - as);
    vec3 co = cs * as + B.rgb * ab * (1.0 - as);
    return vec4(ao > 0.0 ? co / ao : vec3(0.0), ao);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
` + BLEND_GLSL + `
void main() {
    // A layer's texture comes from a canvas, whose first row is the top, so it is sampled
    // upside down against the quad's own coordinates.
    fragColor = blendOver(texture(u_source, vec2(v_uv.x, 1.0 - v_uv.y)));
}`;

// The same for one tile of an atlas page: the vertex shader has already put v_uv inside the
// tile's own slot, gutter excluded, in the page's orientation. `u_mask` is the same for the layer's
// transparency mask, whose store has the same tile grid: the mask's alpha multiplies the source's
// premultiplied value, which is what `destination-in` with the mask does on Canvas 2D.
const ATLAS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_muv;
out vec4 fragColor;
uniform sampler2D u_mask;
uniform int u_hasMask;
// C6 (c) 7d: a colour match (the stitch's per-channel mean and spread, straight 0..255 values), applied to the unpremultiplied
// sample as matchCanvas applies it to each byte; u_match 0: none
uniform int u_match;
uniform vec3 u_meanS;
uniform vec3 u_meanT;
uniform vec3 u_mScale;
uniform float u_mK;
` + BLEND_GLSL + `
void main() {
    vec4 Sp = texture(u_source, v_uv);
    if (u_hasMask == 1) Sp *= texture(u_mask, v_muv).a;
    if (u_match == 1 && Sp.a > 0.0) {
        vec3 p = Sp.rgb / Sp.a * 255.0;
        vec3 v = (p - u_meanT) * u_mScale + u_meanS;
        Sp = vec4(clamp(p + (v - p) * u_mK, 0.0, 255.0) / 255.0 * Sp.a, Sp.a);
    }
    fragColor = blendOver(Sp);
}`;

// ---- the tile atlas (docs/PLAN_BCE.md §C3) ------------------------------------------------------

// A page holds the slots of one (pixels object, level). Its side is at most this, and at most
// `ATLAS_MAX_PER` slots a side: at level 0 a slot is 258 px, so 15 fit a side and a full page is
// 59 MB of tiles; at level 5 a slot is 10 px and a page is 160 px. The first page of a pixels
// object at a level is made no larger than the tiles asked for in that frame, so a small document
// does not pay for a page it cannot fill.
const ATLAS_PAGE_MAX = 4096;
const ATLAS_MAX_PER = 16;
// one instance is { rect(4), uv(4), muv(4) } floats
const INSTANCE_FLOATS = 12;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
// Pages are an LRU by bytes. The default is the `settings.memory.atlasMB` row in Settings ›
// Rendering; the memory watch lowers it under pressure.
const ATLAS_BUDGET_DEFAULT = 512 * 1024 * 1024;
// and an age, like the source textures: a page no composite asked for in this many composites is
// dropped whatever the budget says (the pixels of a layer that a flip or a transform replaced).
const ATLAS_STALE = 300;
// the atlas holds its pixels weakly; a host without WeakRef holds them as before, until the pages age out
const weakRef = (o) => (typeof WeakRef === "function" ? new WeakRef(o) : { deref: () => o });
/** Are the stamps of the nine tiles a slot was made from (`a`, null before its first upload) the ones now (`b`)? */
function sameNear(a, b) {
    if (!b) return true;
    if (!a) return false;
    for (let i = 0; i < 9; i++) if (a[i] !== b[i]) return false;
    return true;
}

const ATLAS_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_rect;          // the tile's rectangle in image coordinates: x, y, w, h
in vec4 a_uv;            // its interior in the page: u0, v0 (the tile's first row), du, dv
in vec4 a_muv;           // the same tile of the layer's mask, in the mask's page
uniform vec4 u_region;   // the image rectangle the output shows: x, y, w, h
out vec2 v_uv;
out vec2 v_muv;
void main() {
    // the page holds the tile's first row at the lowest v (texSubImage2D from a typed array does
    // not flip), so the quad's top edge samples v0, as a canvas source does in FS
    v_uv = vec2(a_uv.x + a_pos.x * a_uv.z, a_uv.y + (1.0 - a_pos.y) * a_uv.w);
    v_muv = vec2(a_muv.x + a_pos.x * a_muv.z, a_muv.y + (1.0 - a_pos.y) * a_muv.w);
    // image coordinates -> the region -> clip space (y up). The region is a uniform, so an instance
    // buffer survives a pan: only another set of visible tiles rebuilds it.
    vec2 q = (a_rect.xy - u_region.xy) / u_region.zw;
    vec2 qs = a_rect.zw / u_region.zw;
    // a_pos.y = 0 is the quad's bottom in clip space (the tile's last row), 1 its top
    vec2 p = vec2(q.x * 2.0 - 1.0, 1.0 - (q.y + qs.y) * 2.0) + a_pos * (qs * 2.0);
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() { fragColor = texture(u_tex, v_uv); }`;

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error("compositor shader: " + log);
    }
    return s;
}

function link(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error("compositor program: " + log);
    }
    return p;
}

// What the source textures may cost. A stack of ten layers needs ten, plus the levels a
// zoom step leaves behind; beyond that they are uploads nobody asked for again. The
// budget is in bytes because the count says nothing: one level-0 texture of a 96 MP
// source is 384 MB and 48 small ones are 12.
const TEXTURE_BUDGET = 1024 * 1024 * 1024;
const TEXTURE_CACHE = 64;   // and a plain count, so a stack of tiny sources cannot grow forever
// and an age: the map keys on the source canvases and keeps them alive, so a source no composite asked
// for in this many composites is dropped whatever the budget says (a layer's replaced pixels after a
// flip or a transform: charged only their window's bytes, they could otherwise stay for a long time)
const TEXTURE_STALE = 300;

// A source above this many pixels is not uploaded whole: the compositor keeps a window of it,
// the part the view shows plus a margin of half the view on each side (phase A item 4 of
// docs/PLAN_TILES.md). At 1:1 on a 15k document the whole source is a 600 MB upload that held
// the first frame after a zoom for 58 to 320 ms and then sat in VRAM per layer; the window is
// a few tens of MB and survives a pan inside its margin.
const WINDOW_PX = 16 * 1024 * 1024;

let SUPPORTED = null;

export class GLCompositor {
    /** Whether this host can run the compositor at all (cached; never throws). */
    static available() {
        if (SUPPORTED !== null) return SUPPORTED;
        try {
            const c = document.createElement("canvas");
            c.width = c.height = 1;
            const gl = c.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false });
            SUPPORTED = !!gl;
            if (gl && gl.getExtension("WEBGL_lose_context")) gl.getExtension("WEBGL_lose_context").loseContext();
        } catch (_) {
            SUPPORTED = false;
        }
        return SUPPORTED;
    }

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.width = this.canvas.height = 1;
        this.gl = this.canvas.getContext("webgl2", {
            alpha: true,
            premultipliedAlpha: false,   // the editor's canvases carry straight alpha
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
            desynchronized: false,
        });
        if (!this.gl) throw new Error("no WebGL2 context for the compositor");
        const gl = this.gl;
        this.prog = link(gl, VS, FS);
        this.copy = link(gl, VS, COPY_FS);
        this.atlasProg = link(gl, ATLAS_VS, ATLAS_FS);
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        for (const p of [this.prog, this.copy]) {
            const loc = gl.getAttribLocation(p, "a_pos");
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        }
        // The atlas path: one quad, one instance of { rect(4), uv(4) } per visible tile. The divisors
        // live in a vertex array of their own, so the two quad programs keep the default one untouched.
        this.inst = gl.createBuffer();
        this.vaoTiles = gl.createVertexArray();
        gl.bindVertexArray(this.vaoTiles);
        const aPos = gl.getAttribLocation(this.atlasProg, "a_pos");
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(aPos, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        for (const [name, off] of [["a_rect", 0], ["a_uv", 16], ["a_muv", 32]]) {
            const loc = gl.getAttribLocation(this.atlasProg, name);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_BYTES, off);
            gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        this.atlasU = {
            backdrop: gl.getUniformLocation(this.atlasProg, "u_backdrop"),
            source: gl.getUniformLocation(this.atlasProg, "u_source"),
            mode: gl.getUniformLocation(this.atlasProg, "u_mode"),
            opacity: gl.getUniformLocation(this.atlasProg, "u_opacity"),
            size: gl.getUniformLocation(this.atlasProg, "u_size"),
            region: gl.getUniformLocation(this.atlasProg, "u_region"),
            mask: gl.getUniformLocation(this.atlasProg, "u_mask"),
            hasMask: gl.getUniformLocation(this.atlasProg, "u_hasMask"),
            match: gl.getUniformLocation(this.atlasProg, "u_match"),
            meanS: gl.getUniformLocation(this.atlasProg, "u_meanS"),
            meanT: gl.getUniformLocation(this.atlasProg, "u_meanT"),
            mScale: gl.getUniformLocation(this.atlasProg, "u_mScale"),
            mK: gl.getUniformLocation(this.atlasProg, "u_mK"),
            clip: gl.getUniformLocation(this.atlasProg, "u_clip"),
            hasClip: gl.getUniformLocation(this.atlasProg, "u_hasClip"),
        };
        // record id -> { id, ref, levels: level -> { pages } }; the pages hold the tiles the screen showed.
        // The pixels are held weakly (C6 a): pixels a flip, a new mask or an undo replaced are in neither
        // the document nor a step, and a Map keyed on them kept every tile of them alive (2.4 GB after three
        // flips of a 15k layer) until the pages aged out. `atlasOf` finds the record of live pixels.
        this.atlas = new Map();
        this.atlasOf = new WeakMap();
        this.atlasIds = 0;
        this.nearBuf = new Float64Array(9);   // _upload: the stamps of the tiles a slot is made from (C6 a, b)
        this.atlasBytes = 0;
        this.atlasBudget = ATLAS_BUDGET_DEFAULT;
        this.atlasGen = 0;   // bumped whenever a page or a slot changes hands: cached instances are stale
        this.tileBufs = [];
        this.tileUploads = 0;
        this.gutterUploads = 0;    // slots whose gutter alone was uploaded: a neighbour changed, the tile did not
        this.staleUploads = 0;     // slots uploaded with a stale or coarse picture while their chain is in the worker (C6 b)
        this.coarseLevel = MIP_LEVELS;   // _drawLevel: where a tile without any chain yet is drawn from (null: its own level)
        this.tileDraws = 0;
        this.pagesMade = 0;
        this.pageIds = 0;          // a page's identity, so instances can be grouped by (source page, mask page)
        this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        // source canvas -> { tex, version, w, h, used }. Pyramid levels are new canvases
        // after every change, so without a cap this map would grow for the whole session.
        this.textures = new Map();
        this.frame = 0;
        this.targets = [];           // two framebuffers to ping-pong between
        this.lost = false;
        this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    }

    /** A framebuffer with its colour texture, sized w x h. */
    _target(i, w, h) {
        const gl = this.gl;
        let t = this.targets[i];
        if (!t) {
            t = { fb: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
            this.targets[i] = t;
        }
        if (t.w !== w || t.h !== h) {
            gl.bindTexture(gl.TEXTURE_2D, t.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
            t.w = w; t.h = h;
        }
        return t;
    }

    /** A 1 x 1 transparent texture: the backdrop a clipping base's coverage is drawn over. */
    _emptyTexture() {
        const gl = this.gl;
        if (this.emptyTex) return this.emptyTex;
        this.emptyTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return this.emptyTex;
    }

    /**
     * The texture for a source canvas. `version` is the editor's counter for those pixels:
     * the upload only happens when it changed, which is what makes panning cheap.
     */
    _texture(source, version) {
        const gl = this.gl;
        let entry = this.textures.get(source);
        if (!entry) {
            entry = { tex: gl.createTexture(), version: null, w: 0, h: 0 };
            this.textures.set(source, entry);
        }
        const w = source.width, h = source.height;
        if (entry.version !== version || entry.w !== w || entry.h !== h) {
            if (w > this.maxTexture || h > this.maxTexture) return null;   // the caller falls back
            gl.bindTexture(gl.TEXTURE_2D, entry.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            entry.version = version;
            entry.w = w;
            entry.h = h;
        }
        entry.used = this.frame;
        return entry.tex;
    }

    /**
     * The texture of a source for this frame, with the source rectangle it covers: the whole
     * source below WINDOW_PX, else a window around the part of it the view shows. `need` is
     * that part in source pixels ({ x, y, w, h }); a cached window is reused while it still
     * holds it and the version is unchanged. Null when the source cannot be uploaded.
     */
    _source(source, version, need) {
        const gl = this.gl;
        const sw = source.width, sh = source.height;
        if (sw * sh <= WINDOW_PX) {
            const tex = this._texture(source, version);
            return tex ? { tex, x: 0, y: 0, w: sw, h: sh } : null;
        }
        let entry = this.textures.get(source);
        if (!entry) {
            entry = { tex: gl.createTexture(), version: null, w: 0, h: 0, x: 0, y: 0, window: true };
            this.textures.set(source, entry);
        }
        // the needed rectangle, clamped to the source; nothing to draw when the layer is off screen
        const nx0 = Math.max(0, Math.floor(need.x)), ny0 = Math.max(0, Math.floor(need.y));
        const nx1 = Math.min(sw, Math.ceil(need.x + need.w)), ny1 = Math.min(sh, Math.ceil(need.y + need.h));
        if (nx1 <= nx0 || ny1 <= ny0) return { tex: null, x: 0, y: 0, w: 0, h: 0 };
        const inside = entry.version === version && entry.window && nx0 >= entry.x && ny0 >= entry.y && nx1 <= entry.x + entry.w && ny1 <= entry.y + entry.h;
        if (!inside) {
            const mx = Math.ceil((nx1 - nx0) / 2), my = Math.ceil((ny1 - ny0) / 2);
            let x = Math.max(0, nx0 - mx), y = Math.max(0, ny0 - my);
            let w = Math.min(sw, nx1 + mx) - x, h = Math.min(sh, ny1 + my) - y;
            w = Math.min(w, this.maxTexture); h = Math.min(h, this.maxTexture);
            if (w <= 0 || h <= 0) return null;
            if (!this.scratch) this.scratch = document.createElement("canvas");
            const sc = this.scratch;
            if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
            const cx = sc.getContext("2d");
            cx.setTransform(1, 0, 0, 1, 0, 0);
            cx.globalAlpha = 1;
            cx.globalCompositeOperation = "source-over";
            cx.clearRect(0, 0, w, h);
            cx.drawImage(source, x, y, w, h, 0, 0, w, h);
            gl.bindTexture(gl.TEXTURE_2D, entry.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            entry.version = version;
            entry.x = x; entry.y = y; entry.w = w; entry.h = h;
            entry.window = true;
            this.windowUploads = (this.windowUploads || 0) + 1;
        }
        entry.used = this.frame;
        return { tex: entry.tex, x: entry.x, y: entry.y, w: entry.w, h: entry.h };
    }

    /** Drop the textures that no recent frame asked for, oldest first, never this frame's. */
    _evict() {
        for (const [src, e] of this.textures) {
            if (this.frame - (e.used || 0) <= TEXTURE_STALE) continue;
            try { this.gl.deleteTexture(e.tex); } catch (_) { /* context gone */ }
            this.textures.delete(src);
        }
        let bytes = 0;
        for (const e of this.textures.values()) bytes += (e.w || 0) * (e.h || 0) * 4;
        if (bytes <= TEXTURE_BUDGET && this.textures.size <= TEXTURE_CACHE) return;
        const entries = [...this.textures.entries()].sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
        for (const [src, e] of entries) {
            if (bytes <= TEXTURE_BUDGET && this.textures.size <= TEXTURE_CACHE) break;
            if (e.used === this.frame) continue;   // the stack being drawn right now
            try { this.gl.deleteTexture(e.tex); } catch (_) { /* context gone */ }
            this.textures.delete(src);
            bytes -= (e.w || 0) * (e.h || 0) * 4;
        }
    }

    /**
     * What the cache holds, for the memory report: entries, the bytes of the source
     * textures (RGBA8, so w * h * 4) and the bytes of the two ping-pong targets.
     */
    stats() {
        let bytes = 0, windows = 0, windowBytes = 0, sourceBytes = 0;
        for (const [src, e] of this.textures) {
            const b = (e.w || 0) * (e.h || 0) * 4;
            bytes += b;
            if (e.window) { windows++; windowBytes += b; }
            sourceBytes += (src.width || 0) * (src.height || 0) * 4;   // the canvases the map keeps alive as keys
        }
        let targetBytes = 0;
        for (const t of this.targets) if (t) targetBytes += (t.w || 0) * (t.h || 0) * 4;
        const scratchBytes = this.scratch ? this.scratch.width * this.scratch.height * 4 : 0;
        let pages = 0, slots = 0, sources = 0;
        for (const rec of this.atlas.values()) {
            sources++;
            for (const entry of rec.levels.values()) for (const page of entry.pages) { pages++; slots += page.slots.size; }
        }
        const atlas = {
            pages, slots, sources, bytes: this.atlasBytes, budget: this.atlasBudget,
            uploads: this.tileUploads, gutterUploads: this.gutterUploads, staleUploads: this.staleUploads, draws: this.tileDraws, pagesMade: this.pagesMade,
        };
        return { entries: this.textures.size, bytes, sourceBytes, targetBytes, windows, windowBytes, scratchBytes, windowUploads: this.windowUploads || 0, budget: TEXTURE_BUDGET, limit: TEXTURE_CACHE, stale: TEXTURE_STALE, atlas, lost: this.lost };
    }

    /** The atlas's byte budget (settings.memory.atlasMB); pages above it are dropped LRU. */
    setAtlasBudget(bytes) {
        this.atlasBudget = Math.max(16 * 1024 * 1024, bytes | 0);
    }

    /** Drop the texture of a source the editor threw away (its atlas pages too, when it is pixels). */
    forget(source) {
        this.forgetPixels(source);
        const entry = this.textures.get(source);
        if (!entry) return;
        try { this.gl.deleteTexture(entry.tex); } catch (_) { /* context gone */ }
        this.textures.delete(source);
    }

    /**
     * The atlas entry of a pixels object at a level: its pages, newest last. Pages hold slots of
     * `slotSide(level)` px; a slot is keyed by the tile key and carries the tile's version, so a
     * tile that changed is re-uploaded and nothing else is.
     */
    _atlasAt(pixels, level) {
        let rec = this.atlasOf.get(pixels);
        if (!rec) {
            rec = { id: ++this.atlasIds, ref: weakRef(pixels), levels: new Map() };
            this.atlasOf.set(pixels, rec);
            this.atlas.set(rec.id, rec);
        }
        let entry = rec.levels.get(level);
        if (!entry) { entry = { level, pages: [] }; rec.levels.set(level, entry); }
        return entry;
    }

    /** Drop a record of the atlas with its pages; the bytes they held. */
    _dropRecord(rec) {
        let bytes = 0;
        for (const entry of rec.levels.values()) for (const page of entry.pages) { bytes += page.bytes; this._deletePage(page); }
        rec.levels.clear();
        this.atlas.delete(rec.id);
        const p = rec.ref.deref();
        if (p && this.atlasOf.get(p) === rec) this.atlasOf.delete(p);
        return bytes;
    }

    /** A new page for `entry`, holding at least `want` slots (at most ATLAS_MAX_PER a side). */
    _newPage(entry, S, want) {
        const gl = this.gl;
        const max = Math.max(1, Math.min(ATLAS_MAX_PER, Math.floor(ATLAS_PAGE_MAX / S)));
        const per = Math.max(1, Math.min(max, Math.ceil(Math.sqrt(Math.max(1, want)))));
        const side = per * S;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, side, side, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const page = { id: ++this.pageIds, tex, side, per, S, slots: new Map(), free: [], used: this.frame, bytes: side * side * 4, insts: [] };
        for (let i = per * per - 1; i >= 0; i--) page.free.push(i);
        entry.pages.push(page);
        this.atlasBytes += page.bytes;
        this.pagesMade++;
        return page;
    }

    /**
     * The slot of one tile: the page that already holds it, or a free slot in one of the entry's
     * pages, or a new page. When every page is full the least recently drawn slot of the last page
     * is taken (never one this frame). Returns { page, i } or null when nothing could be had.
     */
    _slot(entry, key, S, want) {
        for (const page of entry.pages) {
            const have = page.slots.get(key);
            if (have) { page.used = this.frame; have.used = this.frame; return { page, slot: have }; }
        }
        for (const page of entry.pages) {
            if (!page.free.length) continue;
            const slot = { i: page.free.pop(), version: -1, used: this.frame };
            page.slots.set(key, slot);
            page.used = this.frame;
            return { page, slot };
        }
        if (this.atlasBytes < this.atlasBudget) {
            const page = this._newPage(entry, S, want - this._entrySlots(entry));
            const slot = { i: page.free.pop(), version: -1, used: this.frame };
            page.slots.set(key, slot);
            return { page, slot };
        }
        // over the budget: reuse the slot of the tile that was drawn longest ago
        for (let p = entry.pages.length - 1; p >= 0; p--) {
            const page = entry.pages[p];
            let oldest = null, oldestKey = null;
            for (const [k, s] of page.slots) {
                if (s.used === this.frame) continue;
                if (!oldest || s.used < oldest.used) { oldest = s; oldestKey = k; }
            }
            if (!oldest) continue;
            page.slots.delete(oldestKey);
            const slot = { i: oldest.i, version: -1, used: this.frame };
            this.atlasGen++;
            page.slots.set(key, slot);
            page.used = this.frame;
            return { page, slot };
        }
        return null;
    }

    _entrySlots(entry) {
        let n = 0;
        for (const page of entry.pages) n += page.slots.size;
        return n;
    }

    /**
     * The instanced draws of one tile-backed layer for this frame: the visible tiles of `l.pixels`
     * at `l.level`, uploaded into atlas slots where their version changed, as one instance buffer
     * per page ({ tex, data, count }). Null when a tile could not be given a slot at all.
     */
    _tileInstances(l, region) {
        const px = l.pixels;
        const mask = l.mask || null;   // a MaskPixels of the same tile grid, or nothing
        const level = Math.max(0, Math.min(MIP_LEVELS, l.level | 0));
        const fx = l.w / px.width, fy = l.h / px.height;
        // the visible part of the layer in its own pixels
        const nx0 = Math.max(0, Math.floor((region.x - l.x) / fx));
        const ny0 = Math.max(0, Math.floor((region.y - l.y) / fy));
        const nx1 = Math.min(px.width, Math.ceil((region.x + region.w - l.x) / fx));
        const ny1 = Math.min(px.height, Math.ceil((region.y + region.h - l.y) / fy));
        if (nx1 <= nx0 || ny1 <= ny0) return [];
        const tx0 = nx0 >> 8, tx1 = (nx1 - 1) >> 8, ty0 = ny0 >> 8, ty1 = (ny1 - 1) >> 8;
        const entry = this._atlasAt(px, level);
        const mEntry = mask ? this._atlasAt(mask, level) : null;
        // The instances are in image coordinates, so a pan reuses them; only another set of visible
        // tiles, a write into the pixels, a layer that moved or an eviction rebuilds the buffers. At
        // fit on a 15k document that is 2,400 tiles to walk every frame, 1.9 ms against 0.1 from here.
        // C6 b: a chain landing from the worker moves the pixels' chainEpoch, so the slots that show a stale picture are made again
        const key = tx0 + "," + ty0 + "," + tx1 + "," + ty1 + "," + px.version + "," + (px.chainEpoch || 0) + "," + l.x + "," + l.y + "," + l.w + "," + l.h + "," + this.atlasGen
            + "," + (mask ? mask.version + ":" + (mask.chainEpoch || 0) : -1);
        if (entry.cache && entry.cache.key === key) {
            for (const g of entry.cache.groups) {
                g.page.used = this.frame;
                if (g.maskPage) g.maskPage.used = this.frame;
                for (const s of g.slots) s.used = this.frame;
            }
            return entry.cache.groups;
        }
        const want = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
        const groups = new Map();   // page pair -> { page, maskPage, data, slots }
        let cEntry = null, mcEntry = null;   // the coarse level's entries (_drawLevel), looked up once
        this._coarseUnpack = false;         // _uploadCoarse sets the unpack switches once per layer, not per slot
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                const tile = px.tileAt(tx, ty);
                if (!tile) continue;                       // a missing tile is transparent
                // a mask tile that does not exist is transparent, and a transparent mask hides
                // everything under it: that tile of the layer is not drawn at all
                const mTile = mask ? mask.tileAt(tx, ty) : null;
                if (mask && !mTile) continue;
                const key = (ty << 16) | tx;
                // C6 b: a tile with no chain yet and nothing in its slot at this level is drawn from its slot at the
                // coarse level, sampled nearest (10 px a side, not 34 at fit): a whole new layer's first frame
                const lv = this._drawLevel(px, entry, key, tx, ty, level);
                const ent = lv === level ? entry : cEntry || (cEntry = this._atlasAt(px, lv)), Sl = slotSide(lv);
                const got = this._slot(ent, key, Sl, want);
                if (!got) return null;
                const { page, slot } = got;
                if (!(lv === level ? this._upload(px, tx, ty, lv, Sl, page, slot, tile) : this._uploadCoarse(px, tx, ty, lv, Sl, page, slot, tile))) continue;
                let mPage = null, mSlot = null, mlv = level;
                if (mask) {
                    mlv = this._drawLevel(mask, mEntry, key, tx, ty, level);
                    const mEnt = mlv === level ? mEntry : mcEntry || (mcEntry = this._atlasAt(mask, mlv)), mS = slotSide(mlv);
                    const mGot = this._slot(mEnt, key, mS, want);
                    if (!mGot) return null;
                    mPage = mGot.page; mSlot = mGot.slot;
                    if (!(mlv === level ? this._upload(mask, tx, ty, mlv, mS, mPage, mSlot, mTile) : this._uploadCoarse(mask, tx, ty, mlv, mS, mPage, mSlot, mTile))) continue;
                    mSlot.used = this.frame;
                    mPage.used = this.frame;
                }
                slot.used = this.frame;
                page.used = this.frame;
                // one group per pair of pages: a draw binds one page as the source and one as the mask
                const gk = mPage ? page.id + ":" + mPage.id : page.id + ":-";
                let g = groups.get(gk);
                if (!g) { g = { page, maskPage: mPage, data: [], slots: [] }; groups.set(gk, g); }
                g.slots.push(slot);
                if (mSlot) g.slots.push(mSlot);
                // the tile's rectangle in image coordinates, clipped to the image at the last row / column
                const ox = tx << 8, oy = ty << 8;
                const vw = Math.min(TILE_SIZE, px.width - ox), vh = Math.min(TILE_SIZE, px.height - oy);
                const lf = 1 << lv, lS = slotSide(lv);
                const px0 = (slot.i % page.per) * lS + GUTTER, py0 = Math.floor(slot.i / page.per) * lS + GUTTER;
                g.data.push(
                    l.x + ox * fx, l.y + oy * fy, vw * fx, vh * fy,
                    px0 / page.side, py0 / page.side, (vw / lf) / page.side, (vh / lf) / page.side,
                );
                if (mPage) {
                    const mf = 1 << mlv, mS = slotSide(mlv);
                    const mx0 = (mSlot.i % mPage.per) * mS + GUTTER, my0 = Math.floor(mSlot.i / mPage.per) * mS + GUTTER;
                    g.data.push(mx0 / mPage.side, my0 / mPage.side, (vw / mf) / mPage.side, (vh / mf) / mPage.side);
                } else {
                    g.data.push(0, 0, 0, 0);
                }
            }
        }
        const out = [];
        for (const g of groups.values()) {
            out.push({ page: g.page, maskPage: g.maskPage, tex: g.page.tex, maskTex: g.maskPage ? g.maskPage.tex : null,
                       data: new Float32Array(g.data), count: g.data.length / INSTANCE_FLOATS, slots: g.slots });
        }
        entry.cache = { key, groups: out };
        return out;
    }

    /**
     * The level a tile of `px` is drawn at this frame (C6 b): `level`, unless the tile has no chain at all yet (its
     * stamp at `level` is coarse: a new pixels object whose chains are in the worker) and its slot at `level` holds
     * nothing, in which case `coarseLevel`: a slot of 10 px sampled nearest instead of 34 at fit, which is what
     * makes the first frame after a whole change of a large layer cheap. The slot at `level` is uploaded when the
     * chain lands (the landing moves the pixels' chainEpoch). `coarseLevel` null: every tile at `level`.
     */
    _drawLevel(px, entry, key, tx, ty, level) {
        const cl = this.coarseLevel;
        if (cl == null || level >= cl || !level || !px._stampAt) return level;
        const st = px._stampAt(tx, ty, level, true);
        if (st >= 0 || Number.isInteger(st)) return level;   // exact, or a stale chain (a picture at this level)
        for (const page of entry.pages) { const have = page.slots.get(key); if (have && have.version !== -1) return level; }
        return cl;
    }

    /**
     * A coarse slot (`_drawLevel`): the tile sampled nearest at the coarse level, uploaded once per tile version.
     * Its stamp is the coarse one `_levelBytes` gives and it records no neighbours, so the ordinary `_upload` at
     * this level replaces it once the tile's chain is exact.
     */
    _uploadCoarse(px, tx, ty, level, S, page, slot, tile) {
        const stamp = -0.5 - tile.version;
        if (slot.version === stamp && !slot.near) return true;
        const buf = this.tileBufs[level] || null;
        const bytes = px.coarseSlot(tx, ty, level, buf);
        if (!bytes) return false;
        if (!buf || buf.length < bytes.length) this.tileBufs[level] = bytes;
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, page.tex);
        if (!this._coarseUnpack) {
            // premultiplied already (see _upload); nothing between two slots of this loop uploads a canvas
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            this._coarseUnpack = true;
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot.i % page.per) * S, Math.floor(slot.i / page.per) * S, S, S, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        slot.version = stamp;
        slot.near = null;
        this.tileUploads++;
        this.staleUploads++;
        return true;
    }

    /**
     * Put a tile's bytes in its slot when the slot does not already hold that version; false when it has none.
     *
     * A slot holds more than its tile: its gutter is the edge lines of the eight neighbours
     * (`tileWithGutter`), so it is current only while their versions are the ones it was made from
     * too. A write that ends on a tile border, or an undo that puts whole tiles back, bumps only the
     * tiles it wrote, and the neighbour's slot kept the old edge line, which LINEAR sampling reads at
     * the border wherever a sample falls within half a texel of the slot's edge (C6 a: 76 levels after
     * the undo of a fill at 0.75).
     */
    _upload(px, tx, ty, level, S, page, slot, tile) {
        // C6 b: the stamps of the nine tiles the slot is made from, at this level (a tile's version where its bytes
        // are exact, negative where its chain is on its way in the worker and the bytes are a stale or coarse picture)
        const near = px.slotStamps ? px.slotStamps(tx, ty, level, true, this.nearBuf) : null;
        const self = near ? near[4] : tile.version;
        const same = slot.version === self;
        if (same && sameNear(slot.near, near)) return true;
        // the tile's exact chain is on its way and the slot already holds a picture of this place (the tile before a
        // write): it keeps showing that until the chain lands, which moves the pixels' chainEpoch and brings us back
        if (self < 0 && slot.version !== -1) return true;
        let buf = this.tileBufs[level] || null;
        // the tile itself is what the slot holds: only its gutter is made and uploaded (a stroke commit at 1:1
        // re-uploaded the ring of whole slots around it, 5 -> 10 ms a frame at 15k, measured)
        const bytes = px.tileWithGutter(tx, ty, level, buf, same, true);
        if (!bytes) return false;
        if (!buf || buf.length < bytes.length) this.tileBufs[level] = bytes;
        const gl = this.gl;
        const sx = (slot.i % page.per) * S, sy = Math.floor(slot.i / page.per) * S;
        gl.bindTexture(gl.TEXTURE_2D, page.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        // The slot's bytes are premultiplied already. Chromium applies the two unpack switches to an
        // ArrayBufferView upload as well, and a canvas source uploaded earlier in the same frame
        // leaves PREMULTIPLY on: without this the tiles are premultiplied twice and every partly
        // transparent pixel loses its colour (the anti-aliased edge of a text layer disappeared,
        // 65 levels).
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (same) {
            // rows 0 and S - 1 as they are in the slot, columns 0 and S - 1 between them copied out
            const n = S - 2;
            if (!this.gutterCol || this.gutterCol.length < n * 4) this.gutterCol = new Uint8Array(n * 4);
            const col = this.gutterCol;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, S, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes.subarray(0, S * 4));
            gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy + S - 1, S, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes.subarray((S - 1) * S * 4, S * S * 4));
            for (const x of [0, S - 1]) {
                for (let y = 1; y <= n; y++) {
                    const i = (y * S + x) * 4, o = (y - 1) * 4;
                    col[o] = bytes[i]; col[o + 1] = bytes[i + 1]; col[o + 2] = bytes[i + 2]; col[o + 3] = bytes[i + 3];
                }
                gl.texSubImage2D(gl.TEXTURE_2D, 0, sx + x, sy + 1, 1, n, gl.RGBA, gl.UNSIGNED_BYTE, col.subarray(0, n * 4));
            }
            this.gutterUploads++;
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, S, S, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            slot.version = self;
            this.tileUploads++;
            if (self < 0) this.staleUploads++;
        }
        if (near) { if (!slot.near) slot.near = new Float64Array(9); slot.near.set(near); }
        return true;
    }

    /** Draw one layer's tiles, blended with the backdrop `srcTex`, into the bound framebuffer; `clipTex` the base's coverage of a clipped layer. */
    _drawTiles(prepared, srcTex, W, H, region, clipTex = null) {
        const gl = this.gl;
        gl.useProgram(this.atlasProg);
        gl.bindVertexArray(this.vaoTiles);
        gl.uniform1i(this.atlasU.backdrop, 0);
        gl.uniform1i(this.atlasU.source, 1);
        gl.uniform1i(this.atlasU.clip, 3);
        gl.uniform1i(this.atlasU.hasClip, clipTex ? 1 : 0);
        if (clipTex) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, clipTex);
        }
        gl.uniform1i(this.atlasU.mode, BLEND_INDEX[prepared.blend] || 0);
        gl.uniform1f(this.atlasU.opacity, prepared.opacity == null ? 1 : prepared.opacity);
        gl.uniform2f(this.atlasU.size, W, H);
        gl.uniform4f(this.atlasU.region, region.x, region.y, region.w, region.h);
        gl.uniform1i(this.atlasU.mask, 2);
        const m = prepared.match;
        gl.uniform1i(this.atlasU.match, m ? 1 : 0);
        if (m) {
            gl.uniform3f(this.atlasU.meanS, m.meanS[0], m.meanS[1], m.meanS[2]);
            gl.uniform3f(this.atlasU.meanT, m.meanT[0], m.meanT[1], m.meanT[2]);
            gl.uniform3f(this.atlasU.mScale, m.scale[0], m.scale[1], m.scale[2]);
            gl.uniform1f(this.atlasU.mK, Math.max(0, Math.min(1, m.k)));
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        for (const g of prepared.tiles) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, g.tex);
            gl.uniform1i(this.atlasU.hasMask, g.maskTex ? 1 : 0);
            if (g.maskTex) {
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, g.maskTex);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
            gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.DYNAMIC_DRAW);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.count);
            this.tileDraws += g.count;
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    }

    /**
     * Drop the atlas pages of a pixels object (its pixels were replaced, or the editor threw it
     * away); the bytes they held.
     */
    forgetPixels(pixels) {
        const rec = pixels ? this.atlasOf.get(pixels) : null;
        return rec ? this._dropRecord(rec) : 0;
    }

    /**
     * Keep the atlas pages of the pixels in `keep` (a Set: what the document draws) and drop every
     * other record: pixels an undo step holds, pixels a flip, a new mask or a restore replaced, and
     * pixels already collected. The bytes the dropped pages held. (C6 a)
     */
    retainPixels(keep) {
        let bytes = 0;
        for (const rec of Array.from(this.atlas.values())) {
            const p = rec.ref.deref();
            if (!p || !keep.has(p)) bytes += this._dropRecord(rec);
        }
        return bytes;
    }

    /** The bytes the atlas holds for a pixels object (memoryReport). */
    pixelBytes(pixels) {
        const rec = pixels ? this.atlasOf.get(pixels) : null;
        if (!rec) return 0;
        let bytes = 0;
        for (const entry of rec.levels.values()) for (const page of entry.pages) bytes += page.bytes;
        return bytes;
    }

    _deletePage(page) {
        this.atlasGen++;
        this.atlasBytes -= page.bytes;
        try { this.gl.deleteTexture(page.tex); } catch (_) { /* context gone */ }
    }

    /** Pages no recent composite asked for, then the least recently used, until the budget holds. */
    _evictAtlas() {
        const all = [];
        for (const rec of Array.from(this.atlas.values())) {
            // pixels that were collected: nothing can draw them again
            if (!rec.ref.deref()) { this._dropRecord(rec); continue; }
            for (const [level, entry] of rec.levels) {
                entry.pages = entry.pages.filter((page) => {
                    if (this.frame - page.used <= ATLAS_STALE) return true;
                    this._deletePage(page);
                    return false;
                });
                if (!entry.pages.length) rec.levels.delete(level);
                else for (const page of entry.pages) all.push({ rec, level, entry, page });
            }
            if (!rec.levels.size) this._dropRecord(rec);
        }
        if (this.atlasBytes <= this.atlasBudget) return;
        all.sort((a, b) => a.page.used - b.page.used);
        for (const it of all) {
            if (this.atlasBytes <= this.atlasBudget) break;
            if (it.page.used === this.frame) continue;
            it.entry.pages = it.entry.pages.filter((p) => p !== it.page);
            this._deletePage(it.page);
            if (!it.entry.pages.length) it.rec.levels.delete(it.level);
            if (!it.rec.levels.size) this._dropRecord(it.rec);
        }
    }

    /**
     * Composite a stack.
     *
     *   spec.width / spec.height   the output size in pixels (the viewport)
     *   spec.region                { x, y, w, h } of the image the output shows
     *   spec.layers                bottom first: { source, version, x, y, w, h, opacity, blend }, or a tile
     *                              store: { pixels, mask, level, match, x, y, w, h, opacity, blend }, `match`
     *                              { meanS, meanT, scale, k } or null (C6 c 7d); `clipId` on a clipping base,
     *                              `clipTo` (that id) on a layer clipped to it (PLAN_0_1_31 §6 step 3)
     *                              in image coordinates. `source` is a canvas the caller
     *                              already prepared (mask, colour match, stroke preview).
     *
     * Returns the compositor's canvas, or null when it cannot do this stack (a source
     * larger than MAX_TEXTURE_SIZE, a lost context): the caller then uses Canvas 2D.
     */
    composite(spec) {
        if (this.lost) return null;
        const gl = this.gl;
        this.frame++;
        const W = Math.max(1, Math.round(spec.width));
        const H = Math.max(1, Math.round(spec.height));
        const region = spec.region;
        const layers = spec.layers || [];
        // every source has to fit a texture before anything is drawn: a fallback halfway
        // through would leave the caller with a half-composited picture. A large source is
        // uploaded as a window around what the view shows; the layer's rectangle is then the
        // window's, mapped back into image coordinates.
        const prepared = [];
        for (const l of layers) {
            if (!l) continue;
            if (l.pixels) {
                // a tile store: its visible tiles are uploaded into atlas slots and drawn instanced
                const tiles = this._tileInstances(l, region);
                if (!tiles) return null;
                if (tiles.length) prepared.push({ ...l, tiles });
                continue;
            }
            if (!l.source) continue;
            const sw = l.source.width, sh = l.source.height;
            const fx = l.w / sw, fy = l.h / sh;   // image pixels per source pixel
            const need = { x: (region.x - l.x) / fx, y: (region.y - l.y) / fy, w: region.w / fx, h: region.h / fy };
            const s = this._source(l.source, l.version, need);
            if (!s) return null;
            if (!s.tex) continue;   // off screen
            prepared.push({ ...l, tex: s.tex, x: l.x + s.x * fx, y: l.y + s.y * fy, w: s.w * fx, h: s.h * fy });
        }
        if (this.canvas.width !== W || this.canvas.height !== H) {
            this.canvas.width = W;
            this.canvas.height = H;
        }
        const a = this._target(0, W, H);
        const b = this._target(1, W, H);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.BLEND);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);

        // start from an empty backdrop
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        let src = a, dst = b;
        gl.useProgram(this.prog);
        const uRect = gl.getUniformLocation(this.prog, "u_rect");
        const uMode = gl.getUniformLocation(this.prog, "u_mode");
        const uOpacity = gl.getUniformLocation(this.prog, "u_opacity");
        const uSize = gl.getUniformLocation(this.prog, "u_size");
        const uHasClip = gl.getUniformLocation(this.prog, "u_hasClip");
        gl.uniform1i(gl.getUniformLocation(this.prog, "u_backdrop"), 0);
        gl.uniform1i(gl.getUniformLocation(this.prog, "u_source"), 1);
        gl.uniform1i(gl.getUniformLocation(this.prog, "u_clip"), 3);
        const loc = gl.getAttribLocation(this.prog, "a_pos");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        // Clipping (PLAN_0_1_31 §6 step 3): a base (`clipId`) leaves its coverage - itself drawn alone over nothing, at its
        // opacity - in a third target, and a layer clipped to it (`clipTo`) multiplies its source by that. A clipped layer
        // whose base drew nothing here (off screen, no tile in the view) shows nothing either.
        let covId = null;
        const cov = prepared.some((l) => l.clipTo != null) ? this._target(2, W, H) : null;
        const quadRect = (l) => {
            const sx = (l.x - region.x) / region.w, sy = (l.y - region.y) / region.h;
            const sw = l.w / region.w, sh = l.h / region.h;
            return [sx * 2 - 1, 1 - sy * 2 - sh * 2, sw * 2, sh * 2];   // clip space, y up
        };
        const coverage = (l) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, cov.fb);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const none = this._emptyTexture();
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, none);   // never the target being drawn: a sampler on it is a feedback loop
            if (l.tiles) this._drawTiles(l, none, W, H, region, null);
            else {
                gl.useProgram(this.prog);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
                gl.uniform4f(uRect, ...quadRect(l));
                gl.uniform1i(uMode, 0);
                gl.uniform1f(uOpacity, l.opacity == null ? 1 : l.opacity);
                gl.uniform2f(uSize, W, H);
                gl.uniform1i(uHasClip, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, none);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, l.tex);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
            covId = l.clipId;
            gl.useProgram(this.prog);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        };

        for (const l of prepared) {
            let clipTex = null;
            if (l.clipTo != null) {
                if (l.clipTo !== covId) continue;
                clipTex = cov.tex;
            }
            if (l.tiles) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.useProgram(this.copy);
                gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
                gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, src.tex);
                const tloc = gl.getAttribLocation(this.copy, "a_pos");
                gl.enableVertexAttribArray(tloc);
                gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                this._drawTiles(l, src.tex, W, H, region, clipTex);
                const t2 = src; src = dst; dst = t2;
                gl.useProgram(this.prog);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
                if (l.clipId != null) coverage(l);
                continue;
            }
            // the layer's rectangle in the output, then in clip space (-1..1, y up)
            const sx = (l.x - region.x) / region.w;
            const sy = (l.y - region.y) / region.h;
            const sw = l.w / region.w;
            const sh = l.h / region.h;
            const x0 = sx * 2 - 1;
            const y1 = 1 - sy * 2;            // the output's y grows downwards, clip space upwards
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            // the backdrop has to survive where the layer does not cover: copy it first
            gl.useProgram(this.copy);
            gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
            gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            const cloc = gl.getAttribLocation(this.copy, "a_pos");
            gl.enableVertexAttribArray(cloc);
            gl.vertexAttribPointer(cloc, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            // then the layer's own rectangle, blended with the backdrop under it
            gl.useProgram(this.prog);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.uniform4f(uRect, x0, y1 - sh * 2, sw * 2, sh * 2);
            gl.uniform1i(uMode, BLEND_INDEX[l.blend] || 0);
            gl.uniform1f(uOpacity, l.opacity == null ? 1 : l.opacity);
            gl.uniform2f(uSize, W, H);
            gl.uniform1i(uHasClip, clipTex ? 1 : 0);
            if (clipTex) {
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, clipTex);
            }
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, l.tex);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const t = src; src = dst; dst = t;
            if (l.clipId != null) coverage(l);
        }

        // the result to the visible canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.copy);
        gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
        gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
        const cloc2 = gl.getAttribLocation(this.copy, "a_pos");
        gl.enableVertexAttribArray(cloc2);
        gl.vertexAttribPointer(cloc2, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        this._evict();
        this._evictAtlas();
        return this.canvas;
    }

    /** Drop every cached source texture, keep the context (the next frame uploads again). */
    clear() {
        try {
            for (const e of this.textures.values()) this.gl.deleteTexture(e.tex);
        } catch (_) { /* context gone */ }
        this.textures.clear();
        for (const rec of Array.from(this.atlas.values())) this._dropRecord(rec);
        this.atlasBytes = 0;
        this.tileBufs = [];
        if (this.scratch) { this.scratch.width = this.scratch.height = 1; }
    }

    dispose() {
        const gl = this.gl;
        try {
            for (const e of this.textures.values()) gl.deleteTexture(e.tex);
            this.textures.clear();
            for (const rec of Array.from(this.atlas.values())) this._dropRecord(rec);
            this.atlasBytes = 0;
            this.tileBufs = [];
            gl.deleteBuffer(this.inst);
            gl.deleteVertexArray(this.vaoTiles);
            gl.deleteProgram(this.atlasProg);
            for (const t of this.targets) { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } }
            this.targets = [];
            if (this.emptyTex) { gl.deleteTexture(this.emptyTex); this.emptyTex = null; }
            if (this.scratch) { this.scratch.width = this.scratch.height = 0; this.scratch = null; }
            gl.deleteProgram(this.prog);
            gl.deleteProgram(this.copy);
            gl.deleteBuffer(this.quad);
            // A context is only dropped when its canvas is collected, and Chromium keeps
            // at most 16 per page: a closed editor would hold one until a major GC.
            this.canvas.width = this.canvas.height = 0;
            const ext = gl.getExtension("WEBGL_lose_context");
            if (ext) ext.loseContext();
        } catch (_) { /* context already gone */ }
        this.lost = true;
    }
}
