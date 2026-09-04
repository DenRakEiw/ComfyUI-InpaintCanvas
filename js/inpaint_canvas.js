// Inpaint Canvas - layered canvas editor for ComfyUI.
//
// The node itself only shows a thumbnail and a button. The editor opens as a
// full-window overlay so it never fights litegraph for pointer or wheel
// events. Responsibilities of this file:
//   * the editor (layers, selection tools, paint tools, transform, pan/zoom, undo)
//   * persisting the canvas state in the workflow (widget value)
//   * on queue: flatten visible layers + selection mask, upload both, and put a
//     small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle) and
//     pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "InpaintCanvas";
const STITCH_CLASS = "InpaintCanvasStitch";
const SUBFOLDER = "inpaint_canvas";
const MAX_UNDO = 30;
const HANDLE_PX = 9;

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

function imageToCanvas(img, w, h) {
    const c = makeCanvas(w || img.naturalWidth, h || img.naturalHeight);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// ---------------------------------------------------------------------------
// icons (24x24, stroke based)
// ---------------------------------------------------------------------------

const ICONS = {
    select: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M11 9v6"/><path d="M8 12h6"/>',
    deselect: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M8 12h6"/>',
    loop: '<circle cx="12" cy="12" r="7" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2"/>',
    lasso: '<path d="M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5z"/><path d="M6 12.5c-1 2 0 3.5 2 3.5s3 1.5 2 4"/>',
    paint: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/><path d="M5 19c-1 0-2-1-2-2"/>',
    erase: '<path d="M4 15l8-8 6 6-5 5H8z"/><path d="M13 21h7"/>',
    fill: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M12 4v6"/><path d="M19 15c0 2-1 3-2 4-1-1-2-2-2-4 0-1 2-3 2-3s2 2 2 3z" fill="currentColor" stroke="none"/>',
    transform: '<rect x="6" y="6" width="12" height="12"/><rect x="3" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="3" y="17" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="17" width="4" height="4" fill="currentColor" stroke="none"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5"/><path d="M11 11V4.5a1.5 1.5 0 013 0V11"/><path d="M14 11V6a1.5 1.5 0 013 0v7"/><path d="M8 12v0a1.5 1.5 0 00-3 1l2 5a4 4 0 004 3h3a4 4 0 004-4v-4"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    clear: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    invert: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>',
    fit: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
    flatten: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
    load: '<path d="M4 17v3h16v-3"/><path d="M12 4v11"/><path d="M7 9l5-5 5 5"/>',
    play: '<path d="M7 4l12 8-12 8z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M10 6.3A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.4"/><path d="M6.6 8.6C4 10.4 2 12 2 12s4 6 10 6a10 10 0 003-.5"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12 8l4 4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    up: '<path d="M6 14l6-6 6 6"/>',
    down: '<path d="M6 10l6 6 6-6"/>',
};

function icon(name, size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function iconButton(name, title, onClick, label) {
    const b = el("button", "ipc-ib");
    b.type = "button";
    b.title = title;
    b.innerHTML = icon(name) + (label ? `<span>${label}</span>` : "");
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); onClick(e); });
    return b;
}

// ---------------------------------------------------------------------------
// styles (injected once)
// ---------------------------------------------------------------------------

const STYLE = `
.ipc-node { display:flex; flex-direction:column; gap:6px; width:100%; height:100%; box-sizing:border-box; padding:4px;
  color:#ccc; font:12px/1.3 system-ui, sans-serif; }
.ipc-node .ipc-thumb { flex:1; min-height:80px; width:100%; border-radius:6px; background:#1a1a1a; cursor:pointer;
  display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; }
.ipc-node .ipc-thumb canvas { max-width:100%; max-height:100%; display:block; }
.ipc-node .ipc-thumb .ipc-hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  text-align:center; color:#777; padding:12px; pointer-events:none; white-space:pre-line; }
.ipc-node .ipc-open { display:flex; align-items:center; justify-content:center; gap:8px; padding:7px 10px; border-radius:6px;
  background:#2f5f9f; color:#fff; border:1px solid #4a90d9; cursor:pointer; font:inherit; font-weight:600; }
.ipc-node .ipc-open:hover { background:#3a70b8; }
.ipc-node .ipc-status { color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.ipc-modal { position:fixed; inset:0; z-index:10000; display:flex; flex-direction:column; background:#181818; color:#ddd;
  font:13px/1.3 system-ui, sans-serif; outline:none; }
.ipc-top { display:flex; align-items:center; gap:10px; padding:6px 10px; background:#242424; border-bottom:1px solid #0d0d0d; }
.ipc-top .ipc-title { font-weight:600; margin-right:6px; }
.ipc-top .ipc-grow { flex:1; }
.ipc-top label { display:flex; align-items:center; gap:6px; color:#aaa; }
.ipc-top input[type=range] { width:140px; }
.ipc-top input[type=color] { width:34px; height:26px; padding:0; border:1px solid #4a4a4a; border-radius:5px; background:#333; cursor:pointer; }
.ipc-ib { display:inline-flex; align-items:center; justify-content:center; gap:6px; background:#333; color:#ddd; border:1px solid #4a4a4a;
  border-radius:6px; padding:5px 8px; cursor:pointer; font:inherit; min-width:32px; }
.ipc-ib:hover { background:#444; color:#fff; }
.ipc-ib.ipc-active { background:#2f5f9f; border-color:#4a90d9; color:#fff; }
.ipc-ib.ipc-toggle-on { background:#3d3d2a; border-color:#a08a2a; color:#ffd166; }
.ipc-ib.ipc-primary { background:#2f7f4f; border-color:#3fa76a; color:#fff; padding:5px 12px; }
.ipc-ib.ipc-primary:hover { background:#39955d; }
.ipc-ib.ipc-danger:hover { background:#7a2f2f; }
.ipc-body { display:flex; flex:1; min-height:0; }
.ipc-tools { display:flex; flex-direction:column; gap:4px; padding:6px; background:#202020; border-right:1px solid #0d0d0d; overflow:auto; }
.ipc-tools .ipc-ib { width:38px; height:36px; padding:0; }
.ipc-tools .ipc-sep { height:1px; background:#3a3a3a; margin:4px 2px; }
.ipc-tools .ipc-grp { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:#666; text-align:center; margin:2px 0 -1px; }
.ipc-view { flex:1; position:relative; overflow:hidden; min-width:0; cursor:crosshair;
  background-color:#2b2b2b;
  background-image: linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),
    linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%);
  background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
.ipc-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }
.ipc-view.ipc-pan { cursor:grab; }
.ipc-view.ipc-panning { cursor:grabbing; }
.ipc-view.ipc-move { cursor:move; }
.ipc-view.ipc-scale { cursor:nwse-resize; }
.ipc-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center;
  color:#888; pointer-events:none; padding:20px; white-space:pre-line; font-size:15px; }
.ipc-side { width:260px; display:flex; flex-direction:column; background:#202020; border-left:1px solid #0d0d0d; }
.ipc-side h4 { margin:0; padding:6px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#999; background:#262626; border-bottom:1px solid #0d0d0d;
  display:flex; align-items:center; gap:6px; }
.ipc-side h4 .ipc-grow { flex:1; }
.ipc-side h4 .ipc-mini { width:24px; height:22px; }
.ipc-list { flex:1; overflow:auto; min-height:120px; }
.ipc-layer { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-bottom:1px solid #161616; cursor:pointer; }
.ipc-layer:hover { background:#262b33; }
.ipc-layer.ipc-selected { background:#2b3a4f; box-shadow: inset 3px 0 0 #4a90d9; }
.ipc-layer .ipc-row { display:flex; align-items:center; gap:4px; }
.ipc-layer .ipc-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-layer .ipc-kind { font-size:10px; color:#777; text-transform:uppercase; }
.ipc-mini { display:inline-flex; align-items:center; justify-content:center; width:26px; height:24px; border-radius:4px;
  cursor:pointer; color:#bbb; background:transparent; border:none; padding:0; }
.ipc-mini:hover { background:#3a3a3a; color:#fff; }
.ipc-mini.ipc-off { color:#555; }
.ipc-mini.ipc-del:hover { color:#f66; }
.ipc-mini:disabled { opacity:.25; cursor:default; }
.ipc-layer .ipc-op { display:flex; align-items:center; gap:6px; color:#888; font-size:11px; }
.ipc-layer .ipc-op input[type=range] { flex:1; margin:0; }
.ipc-layer .ipc-op b { width:34px; text-align:right; font-weight:500; color:#bbb; }
.ipc-prompt { padding:8px; border-bottom:1px solid #0d0d0d; }
.ipc-prompt textarea { width:100%; box-sizing:border-box; min-height:96px; resize:vertical; background:#161616; color:#ddd; border:1px solid #3a3a3a;
  border-radius:6px; padding:6px 8px; font:13px/1.35 system-ui, sans-serif; }
.ipc-prompt textarea:focus { outline:none; border-color:#4a90d9; }
.ipc-info { padding:8px 10px; color:#aaa; border-top:1px solid #0d0d0d; display:grid; grid-template-columns:auto 1fr; gap:3px 10px; }
.ipc-info b { color:#ddd; font-weight:500; }
.ipc-bottom { padding:5px 10px; background:#242424; border-top:1px solid #0d0d0d; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; }
.ipc-kbd { color:#777; margin-left:auto; }
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
        this.layers = [];            // { id, name, kind, ref, canvas, x, y, w, h, opacity, visible, dirty }
        this.activeLayerId = null;   // null = base
        this.selection = null;       // canvas WxH, red pixels where selected
        this.view = { scale: 1, x: 0, y: 0 };
        this.tool = "select";
        this.brushSize = 40;
        this.color = "#ff3b30";
        this.fillEnclosed = true;
        this.promptText = "";
        this.undo = [];
        this.redo = [];
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.cachedBounds = null;
        this.uploaded = { baseHash: null, baseRef: null, maskHash: null, maskRef: null };
        this.seenResults = new Set();
        this.layerCounter = 0;
        this.paintCounter = 0;
        this.pointer = null;
        this.lassoPoints = null;
        this.hover = null;
        this.status = "No image loaded.";
        this.isOpen = false;

        injectStyle();
        this.buildNodeWidget();
        this.buildModal();
    }

    // ---- node widget (thumbnail + button) --------------------------------

    buildNodeWidget() {
        const root = el("div", "ipc-node");
        this.nodeRoot = root;
        const thumbWrap = el("div", "ipc-thumb");
        this.thumb = document.createElement("canvas");
        this.thumb.width = 4; this.thumb.height = 4;
        thumbWrap.appendChild(this.thumb);
        this.thumbHint = el("div", "ipc-hint", "No image yet.\nOpen the editor to load one.");
        thumbWrap.appendChild(this.thumbHint);
        thumbWrap.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        thumbWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
        root.appendChild(thumbWrap);

        const openBtn = el("button", "ipc-open");
        openBtn.type = "button";
        openBtn.innerHTML = icon("edit") + "<span>Open editor</span>";
        openBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        openBtn.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        root.appendChild(openBtn);

        this.nodeStatus = el("div", "ipc-status", this.status);
        root.appendChild(this.nodeStatus);

        root.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        root.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f && f.type.startsWith("image/")) this.loadFile(f);
        });
        root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

        this.thumbObserver = new ResizeObserver(() => this.drawThumb());
        this.thumbObserver.observe(thumbWrap);
    }

    drawThumb() {
        const wrap = this.thumb.parentElement;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        if (!this.base || rect.width < 4 || rect.height < 4) {
            this.thumb.width = 4; this.thumb.height = 4;
            this.thumbHint.style.display = this.base ? "none" : "flex";
            return;
        }
        this.thumbHint.style.display = "none";
        const dpr = window.devicePixelRatio || 1;
        const s = Math.min(rect.width / this.width, rect.height / this.height, 1) * dpr;
        const w = Math.max(1, Math.round(this.width * s));
        const h = Math.max(1, Math.round(this.height * s));
        if (this.thumb.width !== w || this.thumb.height !== h) {
            this.thumb.width = w; this.thumb.height = h;
        }
        this.thumb.style.width = (w / dpr) + "px";
        this.thumb.style.height = (h / dpr) + "px";
        const ctx = this.thumb.getContext("2d");
        ctx.setTransform(w / this.width, 0, 0, h / this.height, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        this.drawComposite(ctx);
        if (this.selection) {
            ctx.globalAlpha = 0.45;
            ctx.drawImage(this.selection, 0, 0);
            ctx.globalAlpha = 1;
        }
    }

    // ---- modal -------------------------------------------------------------

    buildModal() {
        const root = el("div", "ipc-modal");
        root.tabIndex = 0;
        this.root = root;

        // top bar
        const top = el("div", "ipc-top");
        top.appendChild(el("span", "ipc-title", "Inpaint Canvas"));
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.accept = "image/*";
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", () => {
            const f = this.fileInput.files && this.fileInput.files[0];
            if (f) this.loadFile(f);
            this.fileInput.value = "";
        });
        top.appendChild(this.fileInput);
        top.appendChild(iconButton("load", "Load an image as the base layer (Ctrl+V or drop also works)", () => this.fileInput.click(), "Load"));

        const sizeLabel = el("label", null, "Size");
        this.sizeInput = document.createElement("input");
        this.sizeInput.type = "range";
        this.sizeInput.min = 2; this.sizeInput.max = 400; this.sizeInput.value = this.brushSize;
        this.sizeInput.addEventListener("input", () => { this.brushSize = +this.sizeInput.value; this.sizeValue.textContent = this.brushSize + "px"; this.draw(); });
        this.sizeValue = el("span", null, this.brushSize + "px");
        sizeLabel.appendChild(this.sizeInput);
        sizeLabel.appendChild(this.sizeValue);
        top.appendChild(sizeLabel);

        const colorLabel = el("label", null, "Color");
        this.colorInput = document.createElement("input");
        this.colorInput.type = "color";
        this.colorInput.value = this.color;
        this.colorInput.title = "Paint color";
        this.colorInput.addEventListener("input", () => { this.color = this.colorInput.value; });
        colorLabel.appendChild(this.colorInput);
        top.appendChild(colorLabel);

        top.appendChild(el("span", "ipc-grow"));
        this.generateBtn = iconButton("play", "Queue the workflow (Ctrl+Enter). The result comes back as a new layer.", () => this.generate(), "Generate");
        this.generateBtn.classList.add("ipc-primary");
        top.appendChild(this.generateBtn);
        const closeBtn = iconButton("close", "Close editor (Esc)", () => this.close());
        closeBtn.classList.add("ipc-danger");
        top.appendChild(closeBtn);
        root.appendChild(top);

        // body
        const body = el("div", "ipc-body");

        const tools = el("div", "ipc-tools");
        this.toolButtons = {};
        const addTool = (id, title) => {
            const b = iconButton(id, title, () => this.setTool(id));
            this.toolButtons[id] = b;
            tools.appendChild(b);
        };
        tools.appendChild(el("div", "ipc-grp", "Select"));
        addTool("select", "Paint selection (B)");
        addTool("rect", "Rectangle selection (R)");
        addTool("lasso", "Lasso selection (L)");
        addTool("deselect", "Erase from selection (D)");
        this.loopBtn = iconButton("loop", "Close loops: a brush stroke that encloses an area selects the inside too (Photoshop-style)", () => {
            this.fillEnclosed = !this.fillEnclosed;
            this.loopBtn.classList.toggle("ipc-toggle-on", this.fillEnclosed);
            this.setStatus(this.fillEnclosed ? "Close loops on: enclosed areas get selected." : "Close loops off.");
        });
        this.loopBtn.classList.toggle("ipc-toggle-on", this.fillEnclosed);
        tools.appendChild(this.loopBtn);
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(el("div", "ipc-grp", "Layer"));
        addTool("paint", "Paint on the active layer (P). On the base it creates a paint layer.");
        addTool("erase", "Erase from the active layer (E)");
        tools.appendChild(iconButton("fill", "Fill the selection with the color on the active layer (Shift+F)", () => this.fillSelection()));
        addTool("transform", "Move / scale the active layer (T). Drag corners to scale, Shift for free aspect.");
        addTool("hand", "Pan (H, Space or middle mouse)");
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("undo", "Undo (Ctrl+Z)", () => this.undoStep()));
        tools.appendChild(iconButton("redo", "Redo (Ctrl+Shift+Z)", () => this.redoStep()));
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("clear", "Clear selection (Ctrl+D)", () => this.clearSelection()));
        tools.appendChild(iconButton("invert", "Invert selection (Ctrl+I)", () => this.invertSelection()));
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("fit", "Fit to view (F)", () => this.fitView()));
        tools.appendChild(iconButton("flatten", "Flatten all visible layers into the base", () => this.flatten()));
        body.appendChild(tools);

        this.viewEl = el("div", "ipc-view");
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d");
        this.viewEl.appendChild(this.canvas);
        this.dropHint = el("div", "ipc-drop", "Load an image, paste it (Ctrl+V) or drop it here.\nThen paint a selection and press Generate.");
        this.viewEl.appendChild(this.dropHint);
        body.appendChild(this.viewEl);

        const side = el("div", "ipc-side");
        const layersHead = el("h4", null, "Layers");
        layersHead.appendChild(el("span", "ipc-grow"));
        const addPaint = el("button", "ipc-mini");
        addPaint.type = "button";
        addPaint.title = "Add a paint layer (Ctrl+Shift+N)";
        addPaint.innerHTML = icon("plus", 16);
        addPaint.addEventListener("click", (e) => { e.stopPropagation(); this.addPaintLayer(); });
        layersHead.appendChild(addPaint);
        side.appendChild(layersHead);
        this.layerList = el("div", "ipc-list");
        side.appendChild(this.layerList);

        side.appendChild(el("h4", null, "Prompt"));
        const promptWrap = el("div", "ipc-prompt");
        this.promptInput = document.createElement("textarea");
        this.promptInput.placeholder = "Describe what should appear in the selection. Available as the node's prompt output.";
        this.promptInput.spellcheck = false;
        this.promptInput.addEventListener("input", () => { this.promptText = this.promptInput.value; });
        this.promptInput.addEventListener("change", () => this.notifyChanged());
        this.promptInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { this.promptInput.blur(); this.root.focus({ preventScroll: true }); }
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.generate(); }
        });
        promptWrap.appendChild(this.promptInput);
        side.appendChild(promptWrap);

        side.appendChild(el("h4", null, "Crop"));
        this.infoEl = el("div", "ipc-info");
        side.appendChild(this.infoEl);
        body.appendChild(side);
        root.appendChild(body);

        const bottom = el("div", "ipc-bottom");
        this.statusEl = el("span", null, this.status);
        bottom.appendChild(this.statusEl);
        bottom.appendChild(el("span", "ipc-kbd", "Wheel: zoom · Space/middle: pan · [ ]: size · Esc: close"));
        root.appendChild(bottom);

        this.bindEvents();
        this.setTool("select");
        this.renderLayers();
        this.renderInfo();
        this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        this.resizeObserver.observe(this.viewEl);
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        document.body.appendChild(this.root);
        this._docKey = (e) => {
            if (e.key === "Escape" && this.isOpen) {
                if (e.target === this.promptInput) return;
                e.stopPropagation(); e.preventDefault(); this.close();
            }
        };
        window.addEventListener("keydown", this._docKey, true);
        this.promptInput.value = this.promptText;
        this.root.focus({ preventScroll: true });
        this.resizeCanvas();
        this.fitView();
        this.renderLayers();
        this.renderInfo();
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.pointer = null;
        this.lassoPoints = null;
        if (this._docKey) window.removeEventListener("keydown", this._docKey, true);
        this._docKey = null;
        this.root.remove();
        this.drawThumb();
        this.notifyChanged();
        this.syncLayers().catch((err) => console.error(err));
    }

    bindEvents() {
        const root = this.root;
        const stop = (e) => e.stopPropagation();
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keyup"]) {
            root.addEventListener(type, stop);
        }
        root.addEventListener("contextmenu", (e) => e.preventDefault());
        root.addEventListener("click", (e) => {
            if (e.target && e.target.closest && e.target.closest("button")) this.root.focus({ preventScroll: true });
        });
        root.addEventListener("wheel", (e) => {
            if (e.target === this.promptInput || (e.target && e.target.closest && e.target.closest(".ipc-list"))) { e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation();
            if (e.target === this.canvas) this.onWheel(e);
        }, { passive: false });
        root.addEventListener("keydown", (e) => {
            if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
                e.stopPropagation();
                return;
            }
            e.stopPropagation();
            this.onKey(e);
        });
        root.addEventListener("paste", (e) => {
            if (e.target === this.promptInput) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault(); e.stopPropagation();
                    this.loadFile(item.getAsFile());
                    return;
                }
            }
        });
        this.viewEl.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
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
        if (this.statusEl) this.statusEl.textContent = text;
        if (this.nodeStatus) this.nodeStatus.textContent = text;
    }

    setTool(tool) {
        this.tool = tool;
        for (const [id, b] of Object.entries(this.toolButtons)) b.classList.toggle("ipc-active", id === tool);
        this.viewEl.classList.toggle("ipc-pan", tool === "hand");
        this.viewEl.classList.toggle("ipc-move", tool === "transform");
        this.draw();
    }

    onKey(e) {
        const k = e.key.toLowerCase();
        if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.generate(); return; }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "n") { e.preventDefault(); this.addPaintLayer(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? this.redoStep() : this.undoStep(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); this.redoStep(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); this.clearSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "i") { e.preventDefault(); this.invertSelection(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.shiftKey && k === "f") { this.fillSelection(); return; }
        switch (k) {
            case "b": this.setTool("select"); break;
            case "r": this.setTool("rect"); break;
            case "l": this.setTool("lasso"); break;
            case "d": this.setTool("deselect"); break;
            case "p": this.setTool("paint"); break;
            case "e": this.setTool("erase"); break;
            case "t": this.setTool("transform"); break;
            case "h": this.setTool("hand"); break;
            case "f": this.fitView(); break;
            case "delete": case "backspace": { const l = this.activeLayer(); if (l) this.removeLayer(l.id); break; }
            case "[": this.setBrushSize(Math.round(this.brushSize / 1.2)); break;
            case "]": this.setBrushSize(Math.round(this.brushSize * 1.2)); break;
            case " ":
                if (!this.spaceDown) {
                    this.spaceDown = true;
                    this.viewEl.classList.add("ipc-pan");
                    const up = (ev) => {
                        if (ev.key === " ") {
                            this.spaceDown = false;
                            this.viewEl.classList.toggle("ipc-pan", this.tool === "hand");
                            window.removeEventListener("keyup", up, true);
                        }
                    };
                    window.addEventListener("keyup", up, true);
                }
                e.preventDefault();
                break;
        }
    }

    setBrushSize(v) {
        this.brushSize = Math.min(400, Math.max(2, v));
        this.sizeInput.value = this.brushSize;
        this.sizeValue.textContent = this.brushSize + "px";
        this.draw();
    }

    // ---- geometry ----------------------------------------------------------

    resizeCanvas() {
        if (!this.isOpen) return;
        const rect = this.viewEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            if (this.width && this._fitted !== false) this.fitView(); else this.draw();
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
        if (!this.width || !this.canvas.width) return;
        const pad = 24;
        const s = Math.max(0.01, Math.min((this.canvas.width - pad * 2) / this.width, (this.canvas.height - pad * 2) / this.height));
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

    // ---- layers: lookup ----------------------------------------------------

    activeLayer() {
        return this.layers.find((l) => l.id === this.activeLayerId) || null;
    }

    /** Which corner handle of the active layer is under image point (ix, iy)? */
    handleAt(ix, iy) {
        const l = this.activeLayer();
        if (!l) return null;
        const r = HANDLE_PX / this.view.scale;
        const corners = { nw: [l.x, l.y], ne: [l.x + l.w, l.y], sw: [l.x, l.y + l.h], se: [l.x + l.w, l.y + l.h] };
        for (const [name, [cx, cy]] of Object.entries(corners)) {
            if (Math.abs(ix - cx) <= r && Math.abs(iy - cy) <= r) return name;
        }
        return null;
    }

    // ---- pointer gestures --------------------------------------------------

    onPointerDown(e) {
        this.root.focus({ preventScroll: true });
        if (!this.width) return;
        const pan = e.button === 1 || e.button === 2 || this.spaceDown || this.tool === "hand";
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const [cx, cy] = this.toCanvasPx(e);
        if (pan) {
            this.pointer = { kind: "pan", startX: cx, startY: cy, vx: this.view.x, vy: this.view.y };
            this.viewEl.classList.add("ipc-panning");
            return;
        }
        if (e.button !== 0) return;
        const [ix, iy] = this.toImage(e);

        if (this.tool === "select" || this.tool === "deselect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "selpaint", last: [ix, iy] };
            this.selectionDab(ix, iy, ix, iy);
        } else if (this.tool === "rect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "rect", start: [ix, iy], cur: [ix, iy] };
        } else if (this.tool === "lasso") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "lasso" };
            this.lassoPoints = [[ix, iy]];
        } else if (this.tool === "paint" || this.tool === "erase") {
            let layer = this.activeLayer();
            if (!layer) {
                if (this.tool === "erase") { this.setStatus("The base layer cannot be erased. Select a layer or add a paint layer."); return; }
                layer = this.addPaintLayer();
            }
            this.pushUndo({ kind: "layer", id: layer.id });
            this.pointer = { kind: "layerpaint", layer, last: [ix, iy] };
            this.layerDab(layer, ix, iy, ix, iy);
        } else if (this.tool === "transform") {
            const layer = this.activeLayer();
            if (!layer) { this.setStatus("Select a layer to move or scale it. The base stays put."); return; }
            const handle = this.handleAt(ix, iy);
            this.pushUndo({ kind: "transform", id: layer.id });
            if (handle) {
                this.pointer = { kind: "scale", layer, handle, start: [ix, iy], orig: { x: layer.x, y: layer.y, w: layer.w, h: layer.h }, keepAspect: !e.shiftKey };
                this.viewEl.classList.add("ipc-scale");
            } else {
                this.pointer = { kind: "move", layer, start: [ix, iy], orig: { x: layer.x, y: layer.y } };
            }
        }
        this.draw();
    }

    onPointerMove(e) {
        if (!this.width) return;
        const [ix, iy] = this.toImage(e);
        this.hover = [ix, iy];
        const p = this.pointer;
        if (!p) {
            if (this.tool === "transform") {
                const h = this.handleAt(ix, iy);
                this.viewEl.classList.toggle("ipc-scale", !!h);
            }
            this.draw();
            return;
        }
        if (p.kind === "pan") {
            const [cx, cy] = this.toCanvasPx(e);
            this.view.x = p.vx + (cx - p.startX);
            this.view.y = p.vy + (cy - p.startY);
            this._fitted = false;
        } else if (p.kind === "selpaint") {
            this.selectionDab(p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
        } else if (p.kind === "layerpaint") {
            this.layerDab(p.layer, p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
        } else if (p.kind === "rect") {
            p.cur = [ix, iy];
        } else if (p.kind === "lasso") {
            this.lassoPoints.push([ix, iy]);
        } else if (p.kind === "move") {
            p.layer.x = Math.round(p.orig.x + (ix - p.start[0]));
            p.layer.y = Math.round(p.orig.y + (iy - p.start[1]));
        } else if (p.kind === "scale") {
            this.applyScale(p, ix, iy);
        }
        this.draw();
    }

    applyScale(p, ix, iy) {
        const o = p.orig;
        const l = p.layer;
        // Anchor is the corner opposite to the dragged handle.
        const anchorX = p.handle.includes("w") ? o.x + o.w : o.x;
        const anchorY = p.handle.includes("n") ? o.y + o.h : o.y;
        let nw = Math.abs(ix - anchorX);
        let nh = Math.abs(iy - anchorY);
        if (p.keepAspect) {
            const aspect = o.w / o.h;
            if (nw / aspect > nh) nh = nw / aspect; else nw = nh * aspect;
        }
        nw = Math.max(4, nw);
        nh = Math.max(4, nh);
        l.w = Math.round(nw);
        l.h = Math.round(nh);
        l.x = Math.round(p.handle.includes("w") ? anchorX - nw : anchorX);
        l.y = Math.round(p.handle.includes("n") ? anchorY - nh : anchorY);
    }

    onPointerUp(e) {
        const p = this.pointer;
        if (!p) return;
        this.pointer = null;
        this.viewEl.classList.remove("ipc-panning");
        this.viewEl.classList.remove("ipc-scale");
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
        } else if (p.kind === "selpaint") {
            if (this.tool === "select" && this.fillEnclosed) this.fillEnclosedAreas();
            this.markSelectionChanged();
        } else if (p.kind === "layerpaint") {
            this.markLayerChanged(p.layer);
        } else if (p.kind === "move" || p.kind === "scale") {
            this.uploaded.baseHash = null;
            this.renderLayers();
            this.drawThumb();
            this.notifyChanged();
        }
        this.draw();
    }

    selectionDab(x0, y0, x1, y1) {
        const sctx = this.selection.getContext("2d");
        sctx.globalCompositeOperation = this.tool === "deselect" ? "destination-out" : "source-over";
        sctx.strokeStyle = "#ff0000";
        sctx.lineCap = "round";
        sctx.lineJoin = "round";
        sctx.lineWidth = this.brushSize;
        sctx.beginPath();
        sctx.moveTo(x0, y0);
        sctx.lineTo(x1 + 0.01, y1 + 0.01);
        sctx.stroke();
        sctx.globalCompositeOperation = "source-over";
    }

    /**
     * Photoshop-style loop closing: every unselected region that cannot reach
     * the image border (i.e. is fully enclosed by the selection) gets selected.
     */
    fillEnclosedAreas() {
        const W = this.width, H = this.height;
        const sctx = this.selection.getContext("2d");
        const img = sctx.getImageData(0, 0, W, H);
        const d = img.data;
        const reach = new Uint8Array(W * H);   // 1 = unselected and connected to the border
        const stack = [];
        const push = (i) => { if (!reach[i] && d[i * 4 + 3] <= 127) { reach[i] = 1; stack.push(i); } };
        for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
        for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
        while (stack.length) {
            const i = stack.pop();
            const x = i % W, y = (i - x) / W;
            if (x > 0) push(i - 1);
            if (x < W - 1) push(i + 1);
            if (y > 0) push(i - W);
            if (y < H - 1) push(i + W);
        }
        let filled = 0;
        for (let i = 0; i < W * H; i++) {
            if (!reach[i] && d[i * 4 + 3] <= 127) {
                d[i * 4] = 255; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
                filled++;
            }
        }
        if (filled) sctx.putImageData(img, 0, 0);
    }

    /** Paint or erase on a layer; image coords are mapped into the layer's own pixels. */
    layerDab(layer, x0, y0, x1, y1) {
        const c = layer.canvas;
        const sx = c.width / layer.w, sy = c.height / layer.h;
        const ctx = c.getContext("2d");
        ctx.globalCompositeOperation = this.tool === "erase" ? "destination-out" : "source-over";
        ctx.strokeStyle = this.color;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = this.brushSize * (sx + sy) / 2;
        ctx.beginPath();
        ctx.moveTo((x0 - layer.x) * sx, (y0 - layer.y) * sy);
        ctx.lineTo((x1 - layer.x) * sx + 0.01, (y1 - layer.y) * sy + 0.01);
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
    }

    fillSelection() {
        if (!this.selection || !this.getBounds()) { this.setStatus("Nothing selected to fill."); return; }
        let layer = this.activeLayer();
        if (!layer) layer = this.addPaintLayer();
        this.pushUndo({ kind: "layer", id: layer.id });
        const shape = makeCanvas(this.width, this.height);
        const sctx = shape.getContext("2d");
        sctx.drawImage(this.selection, 0, 0);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = this.color;
        sctx.fillRect(0, 0, this.width, this.height);
        const c = layer.canvas;
        const ctx = c.getContext("2d");
        ctx.save();
        ctx.setTransform(c.width / layer.w, 0, 0, c.height / layer.h, 0, 0);
        ctx.drawImage(shape, -layer.x, -layer.y);
        ctx.restore();
        this.markLayerChanged(layer);
        this.draw();
    }

    // ---- undo ----------------------------------------------------------------

    snapshot(step) {
        if (step.kind === "selection") return { kind: "selection", url: this.selection.toDataURL("image/png") };
        const layer = this.layers.find((l) => l.id === step.id);
        if (!layer) return null;
        if (step.kind === "layer") return { kind: "layer", id: layer.id, url: layer.canvas.toDataURL("image/png") };
        if (step.kind === "transform") return { kind: "transform", id: layer.id, x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        return null;
    }

    pushUndo(step) {
        if (!this.selection) return;
        const snap = this.snapshot(step);
        if (!snap) return;
        this.undo.push(snap);
        if (this.undo.length > MAX_UNDO) this.undo.shift();
        this.redo = [];
    }

    async applySnapshot(snap) {
        if (snap.kind === "selection") {
            const img = await loadImageEl(snap.url);
            const sctx = this.selection.getContext("2d");
            sctx.globalCompositeOperation = "source-over";
            sctx.clearRect(0, 0, this.width, this.height);
            sctx.drawImage(img, 0, 0);
            this.markSelectionChanged();
        } else {
            const layer = this.layers.find((l) => l.id === snap.id);
            if (!layer) return;
            if (snap.kind === "layer") {
                const img = await loadImageEl(snap.url);
                const ctx = layer.canvas.getContext("2d");
                ctx.globalCompositeOperation = "source-over";
                ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                ctx.drawImage(img, 0, 0);
                this.markLayerChanged(layer);
            } else if (snap.kind === "transform") {
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                this.uploaded.baseHash = null;
                this.renderLayers();
                this.drawThumb();
                this.notifyChanged();
            }
        }
        this.draw();
    }

    async undoStep() {
        const snap = this.undo.pop();
        if (!snap) return;
        const current = this.snapshot(snap);
        if (current) this.redo.push(current);
        await this.applySnapshot(snap);
    }

    async redoStep() {
        const snap = this.redo.pop();
        if (!snap) return;
        const current = this.snapshot(snap);
        if (current) this.undo.push(current);
        await this.applySnapshot(snap);
    }

    // ---- selection ops -----------------------------------------------------

    clearSelection() {
        if (!this.selection) return;
        this.pushUndo({ kind: "selection" });
        this.selection.getContext("2d").clearRect(0, 0, this.width, this.height);
        this.markSelectionChanged();
        this.draw();
    }

    invertSelection() {
        if (!this.selection) return;
        this.pushUndo({ kind: "selection" });
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
        this.renderInfo();
        this.drawThumb();
        this.notifyChanged();
    }

    markLayerChanged(layer) {
        layer.dirty = true;
        this.uploaded.baseHash = null;
        this.drawThumb();
        this.notifyChanged();
    }

    selectionBounds() {
        if (!this.selection) return null;
        const d = this.selection.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
        for (let y = 0; y < this.height; y++) {
            const row = y * this.width;
            for (let x = 0; x < this.width; x++) {
                if (d[(row + x) * 4 + 3] > 127) {
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

    getBounds() {
        if (this.selectionDirty) {
            this.cachedBounds = this.selectionBounds();
            this.selectionDirty = false;
        }
        return this.cachedBounds;
    }

    cropRect() {
        const b = this.getBounds();
        const padding = this.widgetValue("padding", 0);
        if (!b) return [0, 0, this.width, this.height];
        const x0 = Math.max(0, b[0] - padding), y0 = Math.max(0, b[1] - padding);
        const x1 = Math.min(this.width, b[2] + padding), y1 = Math.min(this.height, b[3] + padding);
        return [x0, y0, x1 - x0, y1 - y0];
    }

    widgetValue(name, fallback) {
        const w = this.node.widgets && this.node.widgets.find((x) => x.name === name);
        return w ? (+w.value || 0) : fallback;
    }

    renderInfo() {
        if (!this.infoEl) return;
        const rows = [];
        if (this.base) {
            rows.push(["Canvas", `${this.width} × ${this.height}`]);
            const b = this.getBounds();
            rows.push(["Selection", b ? `${b[2] - b[0]} × ${b[3] - b[1]}` : "none (whole image)"]);
            const [, , cw, ch] = this.cropRect();
            rows.push(["Crop", `${cw} × ${ch}`]);
            const target = this.widgetValue("target_size", 0);
            const m = Math.max(1, this.widgetValue("multiple_of", 64) || 64);
            if (target > 0) {
                const s = target / Math.max(cw, ch);
                rows.push(["Emitted", `${Math.max(m, Math.round(cw * s / m) * m)} × ${Math.max(m, Math.round(ch * s / m) * m)}`]);
            } else {
                rows.push(["Emitted", `${Math.min(this.width, Math.ceil(cw / m) * m)} × ${Math.min(this.height, Math.ceil(ch / m) * m)}`]);
            }
        }
        this.infoEl.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("");
    }

    // ---- layers: management ------------------------------------------------

    async setBase(ref, img, { keepLayers = true } = {}) {
        const sizeChanged = img.naturalWidth !== this.width || img.naturalHeight !== this.height;
        this.base = { ref, img };
        this.width = img.naturalWidth;
        this.height = img.naturalHeight;
        if (!keepLayers || sizeChanged) { this.layers = []; this.activeLayerId = null; }
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
        this.renderInfo();
        this.fitView();
        this.drawThumb();
        this.setStatus(`${this.width} × ${this.height}`);
        this.notifyChanged();
    }

    async loadFile(file) {
        if (!file) return;
        try {
            this.setStatus("Uploading " + (file.name || "image") + " ...");
            const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
            const stem = (file.name || "pasted").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
            const ref = await uploadBlob(file, stem + ext, { overwrite: false });
            const img = await loadImageEl(viewUrl(ref));
            await this.setBase(ref, img, { keepLayers: false });
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    addLayer(layer, { activate = true } = {}) {
        this.layerCounter += 1;
        layer.id = layer.id || ("L" + Date.now().toString(36) + this.layerCounter);
        if (layer.visible == null) layer.visible = true;
        if (layer.opacity == null) layer.opacity = 1;
        if (!layer.kind) layer.kind = "result";
        this.layers.push(layer);
        if (activate) this.activeLayerId = layer.id;
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
        return layer;
    }

    addPaintLayer() {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.paintCounter += 1;
        const layer = this.addLayer({
            name: "Paint " + this.paintCounter, kind: "paint", ref: null,
            canvas: makeCanvas(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: true,
        });
        this.setStatus(`${layer.name} added. Paint with P, erase with E, fill the selection with Shift+F.`);
        return layer;
    }

    removeLayer(id) {
        this.layers = this.layers.filter((l) => l.id !== id);
        if (this.activeLayerId === id) this.activeLayerId = null;
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    moveLayer(id, delta) {
        const i = this.layers.findIndex((l) => l.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= this.layers.length) return;
        const [l] = this.layers.splice(i, 1);
        this.layers.splice(j, 0, l);
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.draw();
        this.drawThumb();
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
                const n = this.layers.filter((l) => l.kind === "result").length + 1;
                this.addLayer({ name: "Result " + n, kind: "result", ref, canvas: imageToCanvas(img), x: r.x || 0, y: r.y || 0, w: r.width || img.naturalWidth, h: r.height || img.naturalHeight });
                this.setStatus(`Result ${n} added (${r.width} × ${r.height} at ${r.x}, ${r.y})`);
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err));
            }
        }
    }

    renderLayers() {
        if (!this.layerList) return;
        const list = this.layerList;
        list.innerHTML = "";
        const mini = (name, title, onClick, cls = "") => {
            const b = el("button", "ipc-mini " + cls);
            b.type = "button";
            b.title = title;
            b.innerHTML = icon(name, 16);
            b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
            return b;
        };
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const row = el("div", "ipc-layer" + (layer.id === this.activeLayerId ? " ipc-selected" : ""));
            row.addEventListener("click", () => { this.activeLayerId = layer.id; this.renderLayers(); this.draw(); });
            const top = el("div", "ipc-row");
            top.appendChild(mini(layer.visible ? "eye" : "eyeOff", "Toggle visibility", () => {
                layer.visible = !layer.visible;
                this.uploaded.baseHash = null;
                this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
            }, layer.visible ? "" : "ipc-off"));
            const name = el("span", "ipc-name", layer.name);
            name.title = `${layer.w} × ${layer.h} at ${layer.x}, ${layer.y}`;
            top.appendChild(name);
            top.appendChild(el("span", "ipc-kind", layer.kind));
            const up = mini("up", "Move layer up", () => this.moveLayer(layer.id, +1));
            up.disabled = i === this.layers.length - 1;
            top.appendChild(up);
            const down = mini("down", "Move layer down", () => this.moveLayer(layer.id, -1));
            down.disabled = i === 0;
            top.appendChild(down);
            top.appendChild(mini("trash", "Delete layer", () => this.removeLayer(layer.id), "ipc-del"));
            row.appendChild(top);

            const opRow = el("div", "ipc-op");
            opRow.appendChild(el("span", null, "Opacity"));
            const op = document.createElement("input");
            op.type = "range";
            op.min = 0; op.max = 100; op.value = Math.round(layer.opacity * 100);
            op.title = "Layer opacity";
            const pct = el("b", null, Math.round(layer.opacity * 100) + "%");
            op.addEventListener("click", (e) => e.stopPropagation());
            op.addEventListener("input", () => { layer.opacity = op.value / 100; pct.textContent = op.value + "%"; this.uploaded.baseHash = null; this.draw(); });
            op.addEventListener("change", () => { this.drawThumb(); this.notifyChanged(); });
            opRow.appendChild(op);
            opRow.appendChild(pct);
            row.appendChild(opRow);
            list.appendChild(row);
        }
        const row = el("div", "ipc-layer" + (this.activeLayerId === null ? " ipc-selected" : ""));
        row.addEventListener("click", () => { this.activeLayerId = null; this.renderLayers(); this.draw(); });
        const top = el("div", "ipc-row");
        const eye = el("span", "ipc-mini");
        eye.innerHTML = icon("eye", 16);
        top.appendChild(eye);
        const name = el("span", "ipc-name", this.base ? "Base" : "No image");
        name.title = this.base && this.base.ref ? this.base.ref.filename : "";
        top.appendChild(name);
        top.appendChild(el("span", "ipc-kind", "base"));
        row.appendChild(top);
        list.appendChild(row);
    }

    // ---- compositing -------------------------------------------------------

    drawComposite(ctx) {
        if (!this.base) return;
        ctx.drawImage(this.base.img, 0, 0);
        for (const layer of this.layers) {
            if (!layer.visible || !layer.canvas) continue;
            ctx.globalAlpha = layer.opacity;
            ctx.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
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
            const blob = await canvasToBlob(this.flattenToCanvas());
            const hash = await hashBlob(blob);
            const ref = await uploadBlob(blob, `n${this.node.id}_base_${hash}.png`);
            const img = await loadImageEl(viewUrl(ref));
            this.layers = [];
            this.activeLayerId = null;
            this.base = { ref, img };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus("Flattened into base layer.");
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    /** Upload every edited layer so its pixels survive a reload. */
    async syncLayers() {
        for (const layer of this.layers) {
            if (!layer.dirty || !layer.canvas) continue;
            const blob = await canvasToBlob(layer.canvas);
            const hash = await hashBlob(blob);
            layer.ref = await uploadBlob(blob, `n${this.node.id}_layer_${hash}.png`);
            layer.dirty = false;
        }
        this.notifyChanged();
    }

    draw() {
        if (!this.isOpen) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.base) return;
        const s = this.view.scale;
        ctx.setTransform(s, 0, 0, s, this.view.x, this.view.y);
        ctx.imageSmoothingEnabled = s < 1;
        this.drawComposite(ctx);

        ctx.globalAlpha = 0.4;
        ctx.drawImage(this.selection, 0, 0);
        ctx.globalAlpha = 1;

        if (this.getBounds()) {
            const [x, y, w, h] = this.cropRect();
            ctx.save();
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#4a90d9";
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
        }

        // active layer outline + handles
        const active = this.activeLayer();
        if (active && (this.tool === "transform" || this.tool === "paint" || this.tool === "erase")) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffb347";
            ctx.setLineDash(this.tool === "transform" ? [] : [4 / s, 4 / s]);
            ctx.strokeRect(active.x, active.y, active.w, active.h);
            if (this.tool === "transform") {
                const r = HANDLE_PX / s / 2;
                ctx.fillStyle = "#ffb347";
                for (const [cx, cy] of [[active.x, active.y], [active.x + active.w, active.y], [active.x, active.y + active.h], [active.x + active.w, active.y + active.h]]) {
                    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
                }
            }
            ctx.restore();
        }

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
        const brushTools = ["select", "deselect", "paint", "erase"];
        if (this.hover && brushTools.includes(this.tool) && !(p && p.kind === "pan") && !this.spaceDown) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = this.tool === "paint" ? this.color : (this.tool === "erase" || this.tool === "deselect" ? "#ffd166" : "#fff");
            ctx.beginPath();
            ctx.arc(this.hover[0], this.hover[1], this.brushSize / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    // ---- queue -------------------------------------------------------------

    async generate() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        try {
            this.generateBtn.disabled = true;
            this.setStatus("Queueing ...");
            await app.queuePrompt(0);
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        } finally {
            this.generateBtn.disabled = false;
            if (this.isOpen) this.root.focus({ preventScroll: true });
        }
    }

    // ---- persistence -------------------------------------------------------

    notifyChanged() {
        try { this.node.graph && this.node.graph.setDirtyCanvas && this.node.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
        try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (_) { /* ignore */ }
    }

    getValue() {
        // While a restore is still loading images, hand back the last known state
        // so an autosave in that window does not wipe the canvas.
        if (!this.base) return this.lastValueString || "{}";
        if (!this.selectionDataUrl && this.selection) {
            this.selectionDataUrl = this.selection.toDataURL("image/png");
        }
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: this.base.ref,
            prompt: this.promptText,
            layers: this.layers.map((l) => ({
                id: l.id, name: l.name, kind: l.kind, ref: l.ref, x: l.x, y: l.y, w: l.w, h: l.h,
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
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        if (raw === this.lastValueString && (this.base || this._loading)) return;
        this.lastValueString = raw;
        // Only the most recent setValue call may touch the editor; older loads abort.
        const token = (this._loadToken = (this._loadToken || 0) + 1);
        const stale = () => this._loadToken !== token;
        this._loading = true;
        try {
            const img = await loadImageEl(viewUrl(state.base));
            if (stale()) return;
            await this.setBase(state.base, img, { keepLayers: false });
            this.promptText = state.prompt || "";
            if (this.promptInput) this.promptInput.value = this.promptText;
            for (const l of state.layers || []) {
                if (!l.ref) continue;
                try {
                    const limg = await loadImageEl(viewUrl(l.ref));
                    if (stale()) return;
                    this.layers.push({
                        id: l.id, name: l.name, kind: l.kind || "result", ref: l.ref, canvas: imageToCanvas(limg),
                        x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false,
                    });
                    if (l.kind === "paint") this.paintCounter += 1;
                } catch (err) {
                    console.warn("Inpaint Canvas: layer missing", l.ref, err);
                }
            }
            for (const key of state.seen || []) this.seenResults.add(key);
            if (state.selection) {
                const sel = await loadImageEl(state.selection);
                if (stale()) return;
                this.selection.getContext("2d").drawImage(sel, 0, 0);
                this.selectionDirty = true;
            }
            this.renderLayers();
            this.renderInfo();
            this.draw();
            this.drawThumb();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not restore canvas: " + (err.message || err));
        } finally {
            if (!stale()) this._loading = false;
        }
    }

    /** Called when the prompt is built: upload flattened image + mask, return the prompt JSON. */
    async serializeForPrompt() {
        if (!this.base) return "{}";
        const id = this.node.id;
        await this.syncLayers();
        let baseRef = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !baseRef) {
            let hash;
            if (!this.layers.some((l) => l.visible) && this.base.ref) {
                baseRef = this.base.ref;
                hash = "orig:" + this.base.ref.filename;
            } else {
                const blob = await canvasToBlob(this.flattenToCanvas());
                hash = await hashBlob(blob);
                baseRef = await uploadBlob(blob, `n${id}_base_${hash}.png`);
            }
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = baseRef;
        }
        let maskRef = this.uploaded.maskRef;
        if (!this.uploaded.maskHash || !maskRef) {
            const blob = await canvasToBlob(this.maskToCanvas());
            const hash = await hashBlob(blob);
            maskRef = await uploadBlob(blob, `n${id}_mask_${hash}.png`);
            this.uploaded.maskHash = hash;
            this.uploaded.maskRef = maskRef;
        }
        const [x, y, w, h] = this.cropRect();
        this.setStatus(`Queued crop ${w} × ${h} at ${x}, ${y}. Waiting for the result ...`);
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            prompt: this.promptText,
            layers: this.layers.length,
        });
    }

    destroy() {
        this.close();
        try { this.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
        try { this.thumbObserver.disconnect(); } catch (_) { /* ignore */ }
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
                const widget = this.addDOMWidget("canvas_state", "INPAINT_CANVAS", editor.nodeRoot, {
                    getValue: () => editor.getValue(),
                    setValue: (v) => { editor.setValue(v); },
                    getMinHeight: () => 220,
                });
                widget.serializeValue = async () => editor.serializeForPrompt();
                editor.widget = widget;
                for (const name of ["padding", "target_size", "multiple_of"]) {
                    const w = this.widgets && this.widgets.find((x) => x.name === name);
                    if (!w) continue;
                    const cb = w.callback;
                    w.callback = function () { const x = cb ? cb.apply(this, arguments) : undefined; editor.renderInfo(); editor.draw(); return x; };
                }
                const [w, h] = this.size;
                this.setSize([Math.max(w, 340), Math.max(h, 480)]);
                return r;
            };

            // Workflows saved before a widget was added carry their values shifted
            // by one. Put the canvas JSON back where it belongs and reset any widget
            // that received a string instead of a number.
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
                const values = (info && info.widgets_values) || [];
                const json = values.find((v) => typeof v === "string" && v.trim().startsWith("{"));
                if (json && this.widgets) {
                    for (const w of this.widgets) {
                        if (w.name === "canvas_state") {
                            const ed = this.inpaintEditor;
                            if (ed && ed.lastValueString !== json) w.value = json;
                        } else if (typeof w.value === "string" && w.value.trim().startsWith("{")) {
                            w.value = w.options && w.options.default != null ? w.options.default : (w.name === "multiple_of" ? 64 : 0);
                        }
                    }
                }
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
                try { this.inpaintEditor?.destroy(); } catch (_) { /* ignore */ }
                return onRemoved?.apply(this, arguments);
            };
        }

        if (nodeData.name === STITCH_CLASS) {
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

        api.addEventListener("execution_error", ({ detail }) => {
            const id = detail && (detail.node_id || "");
            const node = app.graph.getNodeById(+String(id).split(".")[0]);
            if (node && node.inpaintEditor) node.inpaintEditor.setStatus("Error: " + (detail.exception_message || "execution failed"));
        });
    },
});
