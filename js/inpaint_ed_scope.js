// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_scope.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The live scope and the clipping warning (item 65, docs/PLAN_0_1_57.md): the Image tab's *Scope* section shows the RGB
// and luma histogram of the visible picture, and Alt+J (View > Clipping Warning) marks pure black blue and pure white
// red on the screen. Both are views only: nothing here writes a layer, the document, an export or a run's picture.
//
// The histogram counts a sample of the whole picture at most SCOPE_LONG px on the long side (1 MP), read through
// sampleRegionSettled as the eyedropper and the filters' statistics read it, never the full document; it is taken a
// moment after the picture changed (SCOPE_WAIT) and not at all while the section is closed. The clipping warning is a
// pass over the screen's own scene canvas (the picture as the screen shows it, at the view's size), drawn over it and
// under the selection and the handles: it follows pan, zoom and turn because it is computed from what is on screen.

import { makeCanvas } from "./inpaint_consts.js";
import { THEME } from "./inpaint_theme.js";
import { el, iconButton } from "./inpaint_dom.js";

const SCOPE_LONG = 1024;   // the sample's long side: at most 1 MP whatever the document's size
const SCOPE_WAIT = 300;    // ms after the last change before the histogram is counted again
const SCOPE_W = 256, SCOPE_H = 96;   // the histogram's box in CSS px
const LR = 0.299, LG = 0.587, LB = 0.114;   // colourStats' luma (inpaint_filters.js)

/**
 * The histogram of RGBA bytes: 256 bins per channel and for luma, each pixel weighted by its alpha (colourStats' rule),
 * and the share of the picture that is pure black (all three channels 0) or pure white (all three 255).
 * @param {Uint8ClampedArray|Uint8Array} px
 */
export function scopeHistogram(px) {
    const r = new Float64Array(256), g = new Float64Array(256), b = new Float64Array(256), luma = new Float64Array(256);
    let total = 0, black = 0, white = 0;
    for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (!a) continue;
        const w = a / 255, R = px[i], G = px[i + 1], B = px[i + 2];
        total += w;
        r[R] += w; g[G] += w; b[B] += w;
        luma[Math.min(255, Math.max(0, (LR * R + LG * G + LB * B + 0.5) | 0))] += w;
        if ((R | G | B) === 0) black += w;
        else if ((R & G & B) === 255) white += w;
    }
    return { r, g, b, luma, total, black: total ? black / total : 0, white: total ? white / total : 0 };
}

// ---- the clipping warning's pass: one WebGL2 context for every editor of the page --------------------------------

const CLIP_VS = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// texelFetch on whole texels: no filtering, the screen's 8-bit values as they are (unpremultiplied at the upload)
const CLIP_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 o;
void main() {
    ivec2 sz = textureSize(u_src, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(u_src, ivec2(p.x, sz.y - 1 - p.y), 0);
    o = vec4(0.0);
    if (c.a < 0.5 / 255.0) return;
    if (max(c.r, max(c.g, c.b)) < 0.5 / 255.0) o = vec4(0.0, 0.35, 1.0, 1.0);
    else if (min(c.r, min(c.g, c.b)) > 254.5 / 255.0) o = vec4(1.0, 0.0, 0.0, 1.0);
}`;

let clipGl = null;   // { canvas, gl, prog, tex } or false once WebGL2 failed here

function clipContext() {
    if (clipGl && clipGl.gl.isContextLost()) clipGl = null;
    if (clipGl !== null) return clipGl || null;
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false });
        if (!gl) { clipGl = false; return null; }
        const shader = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, CLIP_VS));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, CLIP_FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.useProgram(prog);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        clipGl = { canvas, gl, prog, tex };
        return clipGl;
    } catch (err) {
        console.warn("Inpaint Canvas: the clipping warning runs on the CPU", err);
        clipGl = false;
        return null;
    }
}

/**
 * Let the shared pass's drawing buffer and texture go (1 x 1), once the warning is off: a screen-sized canvas and its
 * texture are kept otherwise. The next editor that turns it on computes its marks again (the owner is dropped).
 */
function shrinkClipGl() {
    if (!clipGl || clipGl.gl.isContextLost()) return;
    const { gl, canvas, tex } = clipGl;
    canvas.width = 1; canvas.height = 1;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    clipGl.owner = null;
    clipGl.seq = -1;
}

/** The marks of `src` (a canvas of W x H) on the GPU: a canvas of the same size, transparent but where it clips. */
function clipMarksGl(src, W, H) {
    const c = clipContext();
    if (!c) return null;
    const { gl, canvas, prog, tex } = c;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // both switches every time (CLAUDE.md: Chromium applies them to every upload)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.isContextLost() ? null : canvas;
}

/** The same marks on the CPU, where WebGL2 is not there: a read of the screen-sized scene into `out`. */
function clipMarksCpu(src, W, H, out) {
    const c = out && out.width === W && out.height === H ? out : makeCanvas(W, H);
    const x = c.getContext("2d", { willReadFrequently: true });
    x.setTransform(1, 0, 0, 1, 0, 0);
    // source-over with smoothing off onto a cleared canvas: `copy` with smoothing moves bytes by up to 2 levels (CLAUDE.md)
    x.globalCompositeOperation = "source-over";
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, W, H);
    x.drawImage(src, 0, 0);
    const img = x.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3], R = d[i], G = d[i + 1], B = d[i + 2];
        if (a && (R | G | B) === 0) { d[i] = 0; d[i + 1] = 89; d[i + 2] = 255; d[i + 3] = 255; }
        else if (a && (R & G & B) === 255) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
        else d[i + 3] = 0;
    }
    x.putImageData(img, 0, 0);
    return c;
}

export class ScopePart {
    // ---- the clipping warning --------------------------------------------------------------------------------------

    /** Turn the clipping warning on or off (Alt+J, View > Clipping Warning, the Scope section's button). */
    toggleClipWarning(on = !this.clipWarning) {
        this.clipWarning = !!on;
        this.dropClipMarks();
        if (this.scopeClipBtn) this.scopeClipBtn.classList.toggle("ipc-toggle-on", this.clipWarning);
        this.setStatus(this.clipWarning
            ? "Clipping warning on: pure black shows blue, pure white red (on the screen only). Alt+J turns it off."
            : "Clipping warning off.");
        this.draw();
        return this.clipWarning;
    }

    /** Let this editor's marks go; with them the shared GL pass's buffers when this editor held them. */
    dropClipMarks() {
        const k = this._clipMarks;
        this._clipMarks = null;
        if (k && k.gl && clipGl && clipGl.owner === this._clipToken) shrinkClipGl();
    }

    /**
     * The marks over the scene, drawn by drawScene right after the scene canvas, with the identity transform. Computed
     * again only when the scene was drawn again (`_sceneSeq`) or the screen changed size; one shared GL canvas serves
     * every editor, so its owner is kept with the marks: a token of the editor, not the editor (a closed one stays free).
     * `_clipForceCpu` (set by the editor gate only) takes the CPU fallback, so both paths are held to the same pixels.
     */
    drawClipWarning(ctx, W, H) {
        if (!this.clipWarning || !this.sceneCanvas) return;
        const k = this._clipMarks;
        const glKept = (m) => !!(clipGl && !clipGl.gl.isContextLost() && clipGl.owner === this._clipToken && clipGl.seq === m.seq);
        let marks = k && k.seq === this._sceneSeq && k.w === W && k.h === H && k.forced === !!this._clipForceCpu && (!k.gl || glKept(k)) ? k.canvas : null;
        if (!marks) {
            let gl = null;
            if (!this._clipForceCpu) {
                try { gl = clipMarksGl(this.sceneCanvas, W, H); } catch (err) { console.warn("Inpaint Canvas: clipping warning", err); clipGl = false; }
            }
            if (gl) {
                if (!this._clipToken) this._clipToken = {};
                clipGl.owner = this._clipToken; clipGl.seq = this._sceneSeq;
                marks = gl;
            } else {
                marks = clipMarksCpu(this.sceneCanvas, W, H, k && !k.gl ? k.canvas : null);
            }
            this._clipMarks = { seq: this._sceneSeq, w: W, h: H, canvas: marks, gl: !!gl, forced: !!this._clipForceCpu };
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(marks, 0, 0);
        ctx.restore();
    }

    // ---- the scope -------------------------------------------------------------------------------------------------

    /** The Scope section of the Image tab (built by inpaint_modal.js); closed at first, its state kept like Undo history's. */
    buildScopeSection(section) {
        let open = false;
        try { open = localStorage.getItem("ipc.scopeOpen") === "1"; } catch (_) { /* no storage */ }
        const d = section("Scope", open, (d) => {
            const wrap = el("div", "ipc-sec ipc-scope");
            const c = document.createElement("canvas");
            c.className = "ipc-scope-graph";
            c.style.width = "100%";
            c.style.maxWidth = SCOPE_W + "px";
            c.style.height = SCOPE_H + "px";
            c.style.display = "block";
            c.title = "Histogram of the visible picture: red, green and blue filled, luma as the line. Shadows left, highlights right.";
            wrap.appendChild(c);
            this.scopeCanvas = c;
            // laid out again (the Image tab shown, the tab in front, canvas only left) or a new width: draw, and count
            // if the picture changed while it could not be seen
            if (typeof ResizeObserver === "function") {
                this.scopeObserver = new ResizeObserver(() => { if (c.clientWidth > 0) { this.drawScope(); this.scopeSoon(0); } });
                this.scopeObserver.observe(c);
            }
            const row = el("div", "ipc-row ipc-scope-row");
            row.style.cssText = "display:flex; align-items:center; gap:6px; margin-top:4px; width:100%;";
            this.scopeInfo = el("span", "ipc-grow ipc-scope-info", "");
            this.scopeInfo.style.cssText = "flex:1; min-width:0; font-size:12px;";
            row.appendChild(this.scopeInfo);
            const btn = iconButton("peek", "Clipping warning (Alt+J): pure black shows blue, pure white red, on the screen only", () => { this.toggleClipWarning(); this.root.focus({ preventScroll: true }); }, "Clipping");
            btn.classList.add("ipc-small", "ipc-scope-clip");
            btn.classList.toggle("ipc-toggle-on", !!this.clipWarning);
            this.scopeClipBtn = btn;
            row.appendChild(btn);
            wrap.appendChild(row);
            d.appendChild(wrap);
        });
        d.addEventListener("toggle", () => {
            try { localStorage.setItem("ipc.scopeOpen", d.open ? "1" : "0"); } catch (_) { /* no storage */ }
            if (d.open) { this.drawScope(); this.scopeSoon(0); }
            else if (this._scopeTimer) { clearTimeout(this._scopeTimer); this._scopeTimer = null; }
        });
        this.scopeSection = d;
        this.drawScope();
    }

    /**
     * Whether the histogram is to be kept current: the section open and laid out (the Image tab shown, this tab in
     * front, not the canvas-only view) in an open editor, in a window that is visible. A headless instance, an agent's
     * edits in a background tab and the Generate tab count nothing, whatever the stored open state says.
     */
    scopeShown() {
        const c = this.scopeCanvas;
        return !!(this.scopeSection && this.scopeSection.open && this.isOpen && c && c.offsetParent !== null && c.clientWidth > 0)
            && document.visibilityState === "visible";
    }

    /** The window was hidden while the section was open: count once when it is visible again. */
    scopeWhenVisible() {
        if (this._scopeVisWait || !this.scopeSection || !this.scopeSection.open || !this.isOpen) return;
        this._scopeVisWait = true;
        document.addEventListener("visibilitychange", () => { this._scopeVisWait = false; this.scopeSoon(0); }, { once: true });
    }

    /** What the histogram depends on: the composite's version and the undo step's (a jump in the history). */
    scopeKey() {
        return `${this.compositeVersion}|${this.historyGen || 0}|${this.width}x${this.height}|${this.base ? 1 : 0}`;
    }

    /**
     * Count the histogram again `wait` ms after the first change it has not counted. Called from draw(), so every
     * change of the picture on screen reaches it; cheap when nothing changed or the section is closed. A count already
     * waiting is not pushed back: the marching ants draw every 120 ms, and a timer started again at every draw never
     * fired while a selection was shown. The count reads the picture as it is when it runs.
     */
    scopeSoon(wait = SCOPE_WAIT) {
        if (!this.scopeShown()) {
            if (document.visibilityState !== "visible") this.scopeWhenVisible();
            return;
        }
        if (this._scopeTimer) return;
        if (this._scope && this._scope.key === this.scopeKey() && !this._scopeBusy) return;
        this._scopeTimer = setTimeout(() => {
            this._scopeTimer = null;
            // a held gesture (a stroke, a light dragged on its quick map) or something pending: not now, a moment later;
            // the settled read would wait for relight's full march and composite 1 MP in the middle of the gesture
            if (this.scopeHeld()) { this.scopeSoon(); return; }
            this.updateScope().catch((err) => console.warn("Inpaint Canvas: scope", err));
        }, wait);
    }

    /** A gesture in the editor that a scope read must not run under (as the composite's upload and Resize wait for). */
    scopeHeld() {
        return !!(this.gestureHeld() || this.pending);
    }

    /**
     * Read the sample and count it. One read at a time: a change during the read counts again when it lands.
     * @returns {Promise<object|null>} the histogram (`scopeHistogram`'s) with `w`, `h` and `key`, or null
     */
    async updateScope() {
        if (!this.scopeShown() || this.scopeHeld()) return null;
        if (this._scopeBusy) { this._scopeAgain = true; return this._scopeBusy; }
        const run = (async () => {
            const key = this.scopeKey();
            if (!this.base || !this.width || !this.height) {
                this._scope = { key, hist: null };
                this.drawScope();
                return null;
            }
            const s = Math.min(1, SCOPE_LONG / Math.max(this.width, this.height));
            const src = await this.sampleRegionSettled("image", [0, 0, this.width, this.height], s, { forRun: true, display: true });   // the picture as it exports: no reference or control layer
            // the read's own CPU canvas: getImageData on a canvas the GPU holds would count towards Chromium's latch
            const w = src.width, h = src.height;
            const c = makeCanvas(w, h);
            const x = c.getContext("2d", { willReadFrequently: true });
            x.imageSmoothingEnabled = false;
            x.drawImage(src, 0, 0);
            const hist = scopeHistogram(x.getImageData(0, 0, w, h).data);
            hist.w = w; hist.h = h; hist.key = key;
            this._scope = { key, hist };
            this.drawScope();
            return hist;
        })();
        this._scopeBusy = run;
        try {
            return await run;
        } finally {
            this._scopeBusy = null;
            if (this._scopeAgain) { this._scopeAgain = false; this.scopeSoon(0); }
            else if (this._scope && this._scope.key !== this.scopeKey()) this.scopeSoon();
        }
    }

    /** Draw the last histogram into the section (or an empty box). */
    drawScope() {
        const c = this.scopeCanvas;
        if (!c) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cw = Math.max(1, Math.round((c.clientWidth || SCOPE_W) * dpr)), ch = Math.round(SCOPE_H * dpr);
        if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
        const ctx = c.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = THEME.curveBg;
        ctx.fillRect(0, 0, cw, ch);
        ctx.strokeStyle = THEME.curveGrid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < 4; i++) { const gx = Math.round(cw * i / 4) + 0.5; ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); }
        ctx.stroke();
        const hist = this._scope && this._scope.hist;
        if (!hist || !hist.total) {
            if (this.scopeInfo) this.scopeInfo.textContent = this.base ? (this._scope ? "Nothing visible." : "Counting...") : "No picture.";
            return;
        }
        // the height: the tallest bin but the two ends, so a clipped spike does not flatten the rest (the ends are
        // drawn up to the top and their shares are written below)
        let mx = 0;
        for (const a of [hist.r, hist.g, hist.b, hist.luma]) for (let i = 1; i < 255; i++) if (a[i] > mx) mx = a[i];
        if (!mx) for (const a of [hist.r, hist.g, hist.b, hist.luma]) for (const i of [0, 255]) if (a[i] > mx) mx = a[i];
        const bw = cw / 256;
        const top = (v) => ch - Math.min(1, v / mx) * (ch - 2);
        ctx.globalCompositeOperation = "lighter";
        for (const [a, col] of [[hist.r, "rgba(255,70,70,0.55)"], [hist.g, "rgba(70,220,70,0.55)"], [hist.b, "rgba(80,130,255,0.6)"]]) {
            ctx.fillStyle = col;
            for (let i = 0; i < 256; i++) {
                if (!a[i]) continue;
                const y = top(a[i]);
                ctx.fillRect(i * bw, y, bw + 0.5, ch - y);
            }
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = THEME.curveRgb;
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        for (let i = 0; i < 256; i++) { const px = (i + 0.5) * bw, y = top(hist.luma[i]); if (i) ctx.lineTo(px, y); else ctx.moveTo(px, y); }
        ctx.stroke();
        const pct = (v) => (v > 0 && v < 0.0005 ? "<0.1" : (v * 100).toFixed(1));
        if (this.scopeInfo) {
            this.scopeInfo.textContent = `Black ${pct(hist.black)} % · White ${pct(hist.white)} %`;
            this.scopeInfo.title = `Pure black (0, 0, 0) and pure white (255, 255, 255) of the visible picture, counted on ${hist.w} × ${hist.h} px`;
            this.scopeInfo.style.color = hist.black >= 0.001 || hist.white >= 0.001 ? "var(--sc-warn, #f0c674)" : "";
        }
    }
}
