// Inpaint Canvas - layered canvas editor living inside a ComfyUI node.
//
// Responsibilities of this file:
//   * build the in-node editor (layers, selection tools, pan/zoom)
//   * persist the canvas state in the workflow (widget value)
//   * on queue: flatten the visible layers + selection mask, upload both,
//     and put a small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle)
//     and pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "InpaintCanvas";
const STITCH_CLASS = "InpaintCanvasStitch";
const SUBFOLDER = "inpaint_canvas";
const MAX_UNDO = 30;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function viewUrl(ref) {
    const p = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder || "",
        type: ref.type || "input",
    });
    return api.apiURL("/view?" + p.toString());
}

function loadImageEl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Inpaint Canvas: could not load " + src));
        img.src = src;
    });
}

function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function hashBlob(blob) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadBlob(blob, filename, { overwrite = true, type = "input" } = {}) {
    const form = new FormData();
    form.append("image", new File([blob], filename, { type: "image/png" }));
    form.append("subfolder", SUBFOLDER);
    form.append("type", type);
    if (overwrite) form.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (resp.status !== 200) {
        throw new Error("Inpaint Canvas: upload failed (" + resp.status + ")");
    }
    const data = await resp.json();
    return { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: data.type || type };
}

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function button(label, title, onClick) {
    const b = el("button", "ipc-btn", label);
    b.type = "button";
    b.title = title || label;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return b;
}

// ---------------------------------------------------------------------------
// styles (injected once)
// ---------------------------------------------------------------------------

const STYLE = `
.ipc-root { display:flex; flex-direction:column; width:100%; height:100%; min-height:200px; box-sizing:border-box;
  background:#1e1e1e; color:#ddd; font: 12px/1.3 system-ui, sans-serif; border-radius:6px; overflow:hidden; outline:none; }
.ipc-root:focus { box-shadow: inset 0 0 0 1px #4a90d9; }
.ipc-bar { display:flex; flex-wrap:wrap; gap:4px; align-items:center; padding:4px 6px; background:#2a2a2a; border-bottom:1px solid #111; }
.ipc-bar .ipc-sep { width:1px; height:18px; background:#444; margin:0 3px; }
.ipc-btn { background:#3a3a3a; color:#ddd; border:1px solid #555; border-radius:4px; padding:2px 8px; cursor:pointer; font:inherit; }
.ipc-btn:hover { background:#4a4a4a; }
.ipc-btn.ipc-active { background:#2f5f9f; border-color:#4a90d9; color:#fff; }
.ipc-bar label { display:flex; align-items:center; gap:4px; color:#aaa; }
.ipc-bar input[type=range] { width:80px; }
.ipc-body { display:flex; flex:1; min-height:0; }
.ipc-view { flex:1; position:relative; overflow:hidden; min-width:0; cursor:crosshair;
  background-color:#2b2b2b;
  background-image: linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),
    linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%);
  background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
.ipc-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }
.ipc-view.ipc-pan { cursor:grab; }
.ipc-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center;
  color:#888; pointer-events:none; padding:20px; }
.ipc-layers { width:190px; display:flex; flex-direction:column; background:#252525; border-left:1px solid #111; }
.ipc-layers h4 { margin:0; padding:5px 8px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#999; background:#2a2a2a; border-bottom:1px solid #111; }
.ipc-list { flex:1; overflow:auto; }
.ipc-layer { display:flex; flex-direction:column; gap:3px; padding:5px 6px; border-bottom:1px solid #1a1a1a; }
.ipc-layer.ipc-selected { background:#2f3a48; }
.ipc-layer .ipc-row { display:flex; align-items:center; gap:4px; }
.ipc-layer .ipc-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:default; }
.ipc-layer .ipc-eye { width:22px; text-align:center; cursor:pointer; opacity:.9; }
.ipc-layer .ipc-eye.ipc-off { opacity:.3; }
.ipc-layer .ipc-del { cursor:pointer; color:#c66; padding:0 3px; }
.ipc-layer input[type=range] { width:100%; margin:0; }
.ipc-status { padding:3px 8px; background:#2a2a2a; border-top:1px solid #111; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

function injectStyle() {
    if (document.getElementById("ipc-style")) return;
    const s = document.createElement("style");
    s.id = "ipc-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

class InpaintEditor {
    constructor(node) {
        this.node = node;
        this.width = 0;
        this.height = 0;
        this.base = null;            // { ref, img }
        this.layers = [];            // { id, name, ref, img, x, y, w, h, opacity, visible }
        this.selection = null;       // canvas WxH, red pixels where selected
        this.view = { scale: 1, x: 0, y: 0 };
        this.tool = "brush";
        this.brushSize = 40;
        this.undo = [];
        this.redo = [];
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.uploaded = { baseHash: null, baseRef: null, maskHash: null, maskRef: null };
        this.seenResults = new Set();
        this.layerCounter = 0;
        this.pointer = null;         // active gesture
        this.lassoPoints = null;
        this.status = "";

        this.buildDom();
    }

    // ---- DOM -------------------------------------------------------------

    buildDom() {
        injectStyle();
        const root = el("div", "ipc-root");
        root.tabIndex = 0;
        this.root = root;

        // toolbar
        const bar = el("div", "ipc-bar");
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.accept = "image/*";
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", () => {
            const f = this.fileInput.files && this.fileInput.files[0];
            if (f) this.loadFile(f);
            this.fileInput.value = "";
        });
        bar.appendChild(this.fileInput);
        bar.appendChild(button("Load", "Load an image as the base layer (or paste / drop one)", () => this.fileInput.click()));
        bar.appendChild(el("span", "ipc-sep"));

        this.toolButtons = {};
        const tools = [
            ["brush", "Brush", "Paint selection (B)"],
            ["rect", "Rect", "Rectangle selection (R)"],
            ["lasso", "Lasso", "Lasso selection (L)"],
            ["erase", "Erase", "Erase from selection (E)"],
        ];
        for (const [id, label, title] of tools) {
            const b = button(label, title, () => this.setTool(id));
            this.toolButtons[id] = b;
            bar.appendChild(b);
        }
        const sizeLabel = el("label", null, "Size");
        this.sizeInput = document.createElement("input");
        this.sizeInput.type = "range";
        this.sizeInput.min = 2;
        this.sizeInput.max = 400;
        this.sizeInput.value = this.brushSize;
        this.sizeInput.addEventListener("input", () => { this.brushSize = +this.sizeInput.value; this.draw(); });
        sizeLabel.appendChild(this.sizeInput);
        bar.appendChild(sizeLabel);
        bar.appendChild(el("span", "ipc-sep"));
        bar.appendChild(button("Clear", "Clear selection", () => this.clearSelection()));
        bar.appendChild(button("Invert", "Invert selection", () => this.invertSelection()));
        bar.appendChild(button("Undo", "Undo selection change (Ctrl+Z)", () => this.undoSelection()));
        bar.appendChild(el("span", "ipc-sep"));
        bar.appendChild(button("Fit", "Fit canvas to view (F)", () => this.fitView()));
        bar.appendChild(button("Flatten", "Merge all visible layers into the base layer", () => this.flatten()));
        root.appendChild(bar);

        // body
        const body = el("div", "ipc-body");
        this.viewEl = el("div", "ipc-view");
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d");
        this.viewEl.appendChild(this.canvas);
        this.dropHint = el("div", "ipc-drop", "Load, paste (Ctrl+V) or drop an image here.\nThen paint a selection and queue the prompt.");
        this.dropHint.style.whiteSpace = "pre-line";
        this.viewEl.appendChild(this.dropHint);
        body.appendChild(this.viewEl);

        const layersPanel = el("div", "ipc-layers");
        layersPanel.appendChild(el("h4", null, "Layers"));
        this.layerList = el("div", "ipc-list");
        layersPanel.appendChild(this.layerList);
        body.appendChild(layersPanel);
        root.appendChild(body);

        this.statusEl = el("div", "ipc-status", "");
        root.appendChild(this.statusEl);

        this.bindEvents();
        this.setTool("brush");
        this.renderLayers();
        this.setStatus("No image loaded.");

        this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        this.resizeObserver.observe(this.viewEl);
    }

    bindEvents() {
        const root = this.root;
        const stop = (e) => e.stopPropagation();
        // Keep litegraph from reacting to interactions inside the editor.
        for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
            root.addEventListener(type, stop);
        }
        root.addEventListener("contextmenu", (e) => e.preventDefault());
        root.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.target === this.canvas) this.onWheel(e);
        }, { passive: false });

        root.addEventListener("keydown", (e) => {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
            e.stopPropagation();
            this.onKey(e);
        });
        root.addEventListener("keyup", stop);
        root.addEventListener("paste", (e) => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.loadFile(item.getAsFile());
                    return;
                }
            }
        });

        this.viewEl.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f && f.type.startsWith("image/")) this.loadFile(f);
        });

        this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
    }

    setStatus(text) {
        this.status = text;
        this.statusEl.textContent = text;
    }

    setTool(tool) {
        this.tool = tool;
        for (const [id, b] of Object.entries(this.toolButtons)) {
            b.classList.toggle("ipc-active", id === tool);
        }
    }

    onKey(e) {
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? this.redoSelection() : this.undoSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); this.redoSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); this.clearSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "i") { e.preventDefault(); this.invertSelection(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        switch (k) {
            case "b": this.setTool("brush"); break;
            case "r": this.setTool("rect"); break;
            case "l": this.setTool("lasso"); break;
            case "e": this.setTool("erase"); break;
            case "f": this.fitView(); break;
            case "[": this.brushSize = Math.max(2, Math.round(this.brushSize / 1.2)); this.sizeInput.value = this.brushSize; this.draw(); break;
            case "]": this.brushSize = Math.min(400, Math.round(this.brushSize * 1.2)); this.sizeInput.value = this.brushSize; this.draw(); break;
            case " ": this.spaceDown = true; this.viewEl.classList.add("ipc-pan"); e.preventDefault(); break;
        }
        if (k === " ") {
            const up = (ev) => { if (ev.key === " ") { this.spaceDown = false; this.viewEl.classList.remove("ipc-pan"); window.removeEventListener("keyup", up, true); } };
            window.addEventListener("keyup", up, true);
        }
    }

    // ---- geometry --------------------------------------------------------

    resizeCanvas() {
        const rect = this.viewEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        // The DOM widget may be CSS-scaled by the graph zoom; measure the real box.
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            const hadImage = this.width > 0;
            const wasFit = this._fitted;
            this.canvas.width = w;
            this.canvas.height = h;
            if (hadImage && wasFit) this.fitView(); else this.draw();
        }
    }

    toCanvasPx(e) {
        const rect = this.canvas.getBoundingClientRect();
        return [
            (e.clientX - rect.left) * (this.canvas.width / rect.width),
            (e.clientY - rect.top) * (this.canvas.height / rect.height),
        ];
    }

    toImage(e) {
        const [cx, cy] = this.toCanvasPx(e);
        return [(cx - this.view.x) / this.view.scale, (cy - this.view.y) / this.view.scale];
    }

    fitView() {
        if (!this.width) return;
        const pad = 12;
        const sw = (this.canvas.width - pad * 2) / this.width;
        const sh = (this.canvas.height - pad * 2) / this.height;
        const s = Math.max(0.01, Math.min(sw, sh));
        this.view.scale = s;
        this.view.x = (this.canvas.width - this.width * s) / 2;
        this.view.y = (this.canvas.height - this.height * s) / 2;
        this._fitted = true;
        this.draw();
    }

    onWheel(e) {
        if (!this.width) return;
        const [cx, cy] = this.toCanvasPx(e);
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(40, Math.max(0.02, this.view.scale * factor));
        this.view.x = cx - (cx - this.view.x) * (ns / this.view.scale);
        this.view.y = cy - (cy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.draw();
    }

    // ---- pointer gestures -----------------------------------------------

    onPointerDown(e) {
        this.root.focus({ preventScroll: true });
        if (!this.width) return;
        const pan = e.button === 1 || this.spaceDown || e.button === 2;
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const [cx, cy] = this.toCanvasPx(e);
        if (pan) {
            this.pointer = { kind: "pan", startX: cx, startY: cy, vx: this.view.x, vy: this.view.y };
            return;
        }
        if (e.button !== 0) return;
        const [ix, iy] = this.toImage(e);
        this.pushUndo();
        if (this.tool === "brush" || this.tool === "erase") {
            this.pointer = { kind: "paint", last: [ix, iy] };
            this.paintDab(ix, iy, ix, iy);
        } else if (this.tool === "rect") {
            this.pointer = { kind: "rect", start: [ix, iy], cur: [ix, iy] };
        } else if (this.tool === "lasso") {
            this.pointer = { kind: "lasso" };
            this.lassoPoints = [[ix, iy]];
        }
        this.draw();
    }

    onPointerMove(e) {
        if (!this.width) return;
        const [ix, iy] = this.toImage(e);
        this.hover = [ix, iy];
        const p = this.pointer;
        if (!p) { this.draw(); return; }
        if (p.kind === "pan") {
            const [cx, cy] = this.toCanvasPx(e);
            this.view.x = p.vx + (cx - p.startX);
            this.view.y = p.vy + (cy - p.startY);
            this._fitted = false;
        } else if (p.kind === "paint") {
            this.paintDab(p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
        } else if (p.kind === "rect") {
            p.cur = [ix, iy];
        } else if (p.kind === "lasso") {
            this.lassoPoints.push([ix, iy]);
        }
        this.draw();
    }

    onPointerUp(e) {
        const p = this.pointer;
        if (!p) return;
        this.pointer = null;
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (p.kind === "rect") {
            const [x0, y0] = p.start;
            const [x1, y1] = p.cur;
            const sctx = this.selection.getContext("2d");
            sctx.globalCompositeOperation = "source-over";
            sctx.fillStyle = "#ff0000";
            sctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            this.markSelectionChanged();
        } else if (p.kind === "lasso") {
            const pts = this.lassoPoints;
            this.lassoPoints = null;
            if (pts && pts.length > 2) {
                const sctx = this.selection.getContext("2d");
                sctx.globalCompositeOperation = "source-over";
                sctx.fillStyle = "#ff0000";
                sctx.beginPath();
                sctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i][0], pts[i][1]);
                sctx.closePath();
                sctx.fill();
                this.markSelectionChanged();
            }
        } else if (p.kind === "paint") {
            this.markSelectionChanged();
        }
        this.draw();
    }

    paintDab(x0, y0, x1, y1) {
        const sctx = this.selection.getContext("2d");
        sctx.globalCompositeOperation = this.tool === "erase" ? "destination-out" : "source-over";
        sctx.strokeStyle = "#ff0000";
        sctx.fillStyle = "#ff0000";
        sctx.lineCap = "round";
        sctx.lineJoin = "round";
        sctx.lineWidth = this.brushSize;
        sctx.beginPath();
        sctx.moveTo(x0, y0);
        sctx.lineTo(x1 + 0.01, y1 + 0.01);
        sctx.stroke();
        sctx.globalCompositeOperation = "source-over";
    }

    // ---- selection ops ---------------------------------------------------

    pushUndo() {
        if (!this.selection) return;
        this.undo.push(this.selection.toDataURL("image/png"));
        if (this.undo.length > MAX_UNDO) this.undo.shift();
        this.redo = [];
    }

    async restoreSelection(dataUrl) {
        const img = await loadImageEl(dataUrl);
        const sctx = this.selection.getContext("2d");
        sctx.globalCompositeOperation = "source-over";
        sctx.clearRect(0, 0, this.width, this.height);
        sctx.drawImage(img, 0, 0);
        this.markSelectionChanged();
        this.draw();
    }

    async undoSelection() {
        if (!this.undo.length) return;
        this.redo.push(this.selection.toDataURL("image/png"));
        await this.restoreSelection(this.undo.pop());
    }

    async redoSelection() {
        if (!this.redo.length) return;
        this.undo.push(this.selection.toDataURL("image/png"));
        await this.restoreSelection(this.redo.pop());
    }

    clearSelection() {
        if (!this.selection) return;
        this.pushUndo();
        this.selection.getContext("2d").clearRect(0, 0, this.width, this.height);
        this.markSelectionChanged();
        this.draw();
    }

    invertSelection() {
        if (!this.selection) return;
        this.pushUndo();
        const sctx = this.selection.getContext("2d");
        const data = sctx.getImageData(0, 0, this.width, this.height);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
            d[i + 3] = 255 - d[i + 3];
        }
        sctx.putImageData(data, 0, 0);
        this.markSelectionChanged();
        this.draw();
    }

    markSelectionChanged() {
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.uploaded.maskHash = null;
        this.notifyChanged();
    }

    selectionBounds() {
        if (!this.selection) return null;
        const d = this.selection.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (d[(y * this.width + x) * 4 + 3] > 127) {
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                }
            }
        }
        if (x1 < 0) return null;
        return [x0, y0, x1 + 1, y1 + 1];
    }

    // ---- layers ----------------------------------------------------------

    async setBase(ref, img, { keepLayers = true } = {}) {
        const sizeChanged = img.naturalWidth !== this.width || img.naturalHeight !== this.height;
        this.base = { ref, img };
        this.width = img.naturalWidth;
        this.height = img.naturalHeight;
        if (!keepLayers || sizeChanged) this.layers = [];
        if (!this.selection || sizeChanged) {
            this.selection = makeCanvas(this.width, this.height);
            this.undo = [];
            this.redo = [];
        }
        this.uploaded.baseHash = null;
        this.uploaded.baseRef = null;
        this.dropHint.style.display = "none";
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.renderLayers();
        this.fitView();
        this.setStatus(`${this.width} x ${this.height}`);
        this.notifyChanged();
    }

    async loadFile(file) {
        if (!file) return;
        try {
            this.setStatus("Uploading " + file.name + " ...");
            const blob = file;
            const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".png"])[0];
            const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_").replace(/\.[a-z0-9]+$/i, "") + ext;
            const ref = await uploadBlob(blob, safeName, { overwrite: false });
            const img = await loadImageEl(viewUrl(ref));
            await this.setBase(ref, img, { keepLayers: false });
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    addLayer(layer) {
        this.layerCounter += 1;
        layer.id = layer.id || ("L" + Date.now().toString(36) + this.layerCounter);
        if (layer.visible == null) layer.visible = true;
        if (layer.opacity == null) layer.opacity = 1;
        this.layers.push(layer);
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.draw();
        this.notifyChanged();
    }

    removeLayer(id) {
        this.layers = this.layers.filter((l) => l.id !== id);
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.draw();
        this.notifyChanged();
    }

    async addResults(results) {
        for (const r of results || []) {
            if (!r || !r.filename) continue;
            const key = (r.subfolder || "") + "/" + r.filename;
            if (this.seenResults.has(key)) continue;
            this.seenResults.add(key);
            try {
                const ref = { filename: r.filename, subfolder: r.subfolder || SUBFOLDER, type: r.type || "output" };
                const img = await loadImageEl(viewUrl(ref));
                if (!this.width) {
                    await this.setBase(ref, img, { keepLayers: false });
                    continue;
                }
                const n = this.layers.length + 1;
                this.addLayer({ name: "Result " + n, ref, img, x: r.x || 0, y: r.y || 0, w: r.width || img.naturalWidth, h: r.height || img.naturalHeight });
                this.setStatus(`Result ${n} added at ${r.x},${r.y} (${r.width} x ${r.height})`);
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err));
            }
        }
    }

    renderLayers() {
        const list = this.layerList;
        list.innerHTML = "";
        const rows = [];
        for (let i = this.layers.length - 1; i >= 0; i--) rows.push(this.layers[i]);
        for (const layer of rows) {
            const row = el("div", "ipc-layer");
            const top = el("div", "ipc-row");
            const eye = el("span", "ipc-eye" + (layer.visible ? "" : " ipc-off"), "👁");
            eye.title = "Toggle visibility";
            eye.addEventListener("click", (e) => {
                e.stopPropagation();
                layer.visible = !layer.visible;
                this.uploaded.baseHash = null;
                this.renderLayers();
                this.draw();
                this.notifyChanged();
            });
            top.appendChild(eye);
            const name = el("span", "ipc-name", layer.name);
            name.title = `${layer.w} x ${layer.h} at ${layer.x},${layer.y}`;
            top.appendChild(name);
            const del = el("span", "ipc-del", "✕");
            del.title = "Delete layer";
            del.addEventListener("click", (e) => { e.stopPropagation(); this.removeLayer(layer.id); });
            top.appendChild(del);
            row.appendChild(top);
            const op = document.createElement("input");
            op.type = "range";
            op.min = 0; op.max = 100; op.value = Math.round(layer.opacity * 100);
            op.title = "Opacity";
            op.addEventListener("input", () => { layer.opacity = op.value / 100; this.uploaded.baseHash = null; this.draw(); });
            op.addEventListener("change", () => this.notifyChanged());
            row.appendChild(op);
            list.appendChild(row);
        }
        if (this.base) {
            const row = el("div", "ipc-layer");
            const top = el("div", "ipc-row");
            top.appendChild(el("span", "ipc-eye", "👁"));
            const name = el("span", "ipc-name", "Base");
            name.title = this.base.ref ? this.base.ref.filename : "";
            top.appendChild(name);
            row.appendChild(top);
            list.appendChild(row);
        } else {
            list.appendChild(el("div", "ipc-layer", "No image"));
        }
    }

    // ---- compositing -----------------------------------------------------

    drawComposite(ctx) {
        if (!this.base) return;
        ctx.drawImage(this.base.img, 0, 0);
        for (const layer of this.layers) {
            if (!layer.visible || !layer.img) continue;
            ctx.globalAlpha = layer.opacity;
            ctx.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
        }
        ctx.globalAlpha = 1;
    }

    flattenToCanvas() {
        const c = makeCanvas(this.width, this.height);
        this.drawComposite(c.getContext("2d"));
        return c;
    }

    maskToCanvas() {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        const src = this.selection.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        const out = ctx.createImageData(this.width, this.height);
        const d = out.data;
        for (let i = 0; i < src.length; i += 4) {
            const a = src[i + 3];
            d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        return c;
    }

    async flatten() {
        if (!this.base || !this.layers.length) return;
        try {
            this.setStatus("Flattening ...");
            const flat = this.flattenToCanvas();
            const blob = await canvasToBlob(flat);
            const hash = await hashBlob(blob);
            const ref = await uploadBlob(blob, `n${this.node.id}_base_${hash}.png`);
            const img = await loadImageEl(viewUrl(ref));
            this.layers = [];
            this.base = { ref, img };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.draw();
            this.notifyChanged();
            this.setStatus("Flattened into base layer.");
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.base) return;
        const s = this.view.scale;
        ctx.setTransform(s, 0, 0, s, this.view.x, this.view.y);
        ctx.imageSmoothingEnabled = s < 1;
        this.drawComposite(ctx);

        // selection overlay
        ctx.globalAlpha = 0.4;
        ctx.drawImage(this.selection, 0, 0);
        ctx.globalAlpha = 1;

        // crop preview (selection bbox + padding)
        if (this.selectionDirty) {
            this.cachedBounds = this.selectionBounds();
            this.selectionDirty = false;
        }
        const padding = this.getPadding();
        if (this.cachedBounds) {
            const [x0, y0, x1, y1] = this.cachedBounds;
            const bx0 = Math.max(0, x0 - padding), by0 = Math.max(0, y0 - padding);
            const bx1 = Math.min(this.width, x1 + padding), by1 = Math.min(this.height, y1 + padding);
            ctx.save();
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#4a90d9";
            ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
            ctx.restore();
        }

        // gesture previews
        const p = this.pointer;
        if (p && p.kind === "rect") {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#fff";
            ctx.setLineDash([4 / s, 3 / s]);
            ctx.strokeRect(p.start[0], p.start[1], p.cur[0] - p.start[0], p.cur[1] - p.start[1]);
            ctx.restore();
        }
        if (this.lassoPoints && this.lassoPoints.length > 1) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#fff";
            ctx.beginPath();
            ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
            for (const [x, y] of this.lassoPoints) ctx.lineTo(x, y);
            ctx.stroke();
            ctx.restore();
        }
        if (this.hover && (this.tool === "brush" || this.tool === "erase") && !(p && p.kind === "pan")) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = this.tool === "erase" ? "#ffd166" : "#fff";
            ctx.beginPath();
            ctx.arc(this.hover[0], this.hover[1], this.brushSize / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    getPadding() {
        const w = this.node.widgets && this.node.widgets.find((x) => x.name === "padding");
        return w ? +w.value || 0 : 0;
    }

    // ---- persistence -----------------------------------------------------

    notifyChanged() {
        // Let the graph know the widget value changed (undo/redo, dirty flag).
        try { this.node.graph && this.node.graph.setDirtyCanvas && this.node.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
        try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (_) { /* ignore */ }
    }

    getValue() {
        if (!this.base) return "{}";
        if (!this.selectionDataUrl && this.selection) {
            this.selectionDataUrl = this.selection.toDataURL("image/png");
        }
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: this.base.ref,
            layers: this.layers.map((l) => ({
                id: l.id, name: l.name, ref: l.ref, x: l.x, y: l.y, w: l.w, h: l.h,
                opacity: l.opacity, visible: l.visible,
            })),
            selection: this.selectionDataUrl,
            seen: Array.from(this.seenResults).slice(-200),
        });
    }

    async setValue(value) {
        let state = null;
        try { state = typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch (_) { state = null; }
        if (!state || !state.base) return;
        try {
            const img = await loadImageEl(viewUrl(state.base));
            await this.setBase(state.base, img, { keepLayers: false });
            for (const l of state.layers || []) {
                try {
                    const limg = await loadImageEl(viewUrl(l.ref));
                    this.layers.push({ id: l.id, name: l.name, ref: l.ref, img: limg, x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false });
                } catch (err) {
                    console.warn("Inpaint Canvas: layer missing", l.ref, err);
                }
            }
            for (const key of state.seen || []) this.seenResults.add(key);
            if (state.selection) {
                const sel = await loadImageEl(state.selection);
                this.selection.getContext("2d").drawImage(sel, 0, 0);
                this.selectionDirty = true;
            }
            this.renderLayers();
            this.draw();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not restore canvas: " + (err.message || err));
        }
    }

    /** Called when the prompt is built: upload flattened image + mask, return the prompt JSON. */
    async serializeForPrompt() {
        if (!this.base) return "{}";
        const id = this.node.id;
        // flattened base
        let baseRef = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !baseRef) {
            let blob, hash;
            if (!this.layers.some((l) => l.visible) && this.base.ref) {
                baseRef = this.base.ref;
                hash = "orig:" + this.base.ref.filename;
            } else {
                blob = await canvasToBlob(this.flattenToCanvas());
                hash = await hashBlob(blob);
                baseRef = await uploadBlob(blob, `n${id}_base_${hash}.png`);
            }
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = baseRef;
        }
        // selection mask
        let maskRef = this.uploaded.maskRef;
        if (!this.uploaded.maskHash || !maskRef) {
            const blob = await canvasToBlob(this.maskToCanvas());
            const hash = await hashBlob(blob);
            maskRef = await uploadBlob(blob, `n${id}_mask_${hash}.png`);
            this.uploaded.maskHash = hash;
            this.uploaded.maskRef = maskRef;
        }
        this.setStatus("Queued: " + (this.cachedBounds ? "selection " + this.cachedBounds.join(",") : "no selection, full image"));
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            layers: this.layers.length,
        });
    }
}

// ---------------------------------------------------------------------------
// extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "inpaint.InpaintCanvas",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_CLASS) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const editor = new InpaintEditor(this);
                this.inpaintEditor = editor;
                const widget = this.addDOMWidget("canvas_state", "INPAINT_CANVAS", editor.root, {
                    getValue: () => editor.getValue(),
                    setValue: (v) => { editor.setValue(v); },
                    getMinHeight: () => 320,
                    hideOnZoom: false,
                });
                widget.serializeValue = async () => editor.serializeForPrompt();
                editor.widget = widget;
                // Redraw the crop preview whenever padding changes.
                const pad = this.widgets && this.widgets.find((w) => w.name === "padding");
                if (pad) {
                    const cb = pad.callback;
                    pad.callback = function () { const x = cb ? cb.apply(this, arguments) : undefined; editor.draw(); return x; };
                }
                const [w, h] = this.size;
                this.setSize([Math.max(w, 760), Math.max(h, 640)]);
                return r;
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output) {
                onExecuted?.apply(this, arguments);
                if (output && output.inpaint_result && this.inpaintEditor) {
                    this.inpaintEditor.addResults(output.inpaint_result);
                }
            };

            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                try { this.inpaintEditor?.resizeObserver?.disconnect(); } catch (_) { /* ignore */ }
                return onRemoved?.apply(this, arguments);
            };
        }

        if (nodeData.name === STITCH_CLASS) {
            // Standalone stitch node: route its result to the canvas it came from.
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output) {
                onExecuted?.apply(this, arguments);
                for (const r of (output && output.inpaint_result) || []) {
                    const target = r.canvas_node != null ? app.graph.getNodeById(+r.canvas_node) : null;
                    if (target && target.inpaintEditor) target.inpaintEditor.addResults([r]);
                }
            };
        }
    },

    setup() {
        // The result back-link is a cycle from the graph's point of view. Strip it
        // from the prompt and pass the source node instead; the backend expands an
        // ephemeral stitch node that reads from that source.
        const origQueue = api.queuePrompt;
        api.queuePrompt = async function (number, prompt, ...rest) {
            const output = prompt && prompt.output;
            if (output) {
                for (const node of Object.values(output)) {
                    if (node.class_type !== NODE_CLASS) continue;
                    const link = node.inputs && node.inputs.result;
                    if (Array.isArray(link)) {
                        node.inputs.result_source = `${link[0]}:${link[1]}`;
                        delete node.inputs.result;
                    } else if (node.inputs) {
                        delete node.inputs.result_source;
                    }
                }
            }
            return origQueue.call(this, number, prompt, ...rest);
        };
    },
});
