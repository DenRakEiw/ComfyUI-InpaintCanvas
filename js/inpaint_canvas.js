// Generated from DenRakEiw/scumble renderer/editor/inpaint_canvas.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Inpaint Canvas - layered canvas editor for ComfyUI.
//
// The node itself only shows a thumbnail and a button. The editor opens as a
// full-window overlay so it never fights litegraph for pointer or wheel
// events. Responsibilities of this file:
//   * the editor (layers, selection tools, paint tools, transform, pan/zoom, undo,
//     control layers, reference layers, layer masks / cutouts, outpainting, result history)
//   * persisting the canvas state in the workflow (widget value)
//   * on queue: flatten visible layers + selection mask (+ control layers), upload
//     them, and put a small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle) and
//     pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { api, host } from "./host.js";
import { loadFontList } from "./inpaint_text.js";
import { setKernels, kernelsMode, liquifyDab } from "./px/kernels.js";
import { LayerPixels, canvasOf, displayCanvasIfMade, deprecatedPixels } from "./inpaint_pixels.js";
import { pngPartsOf, readPngParts } from "./inpaint_png.js";
import { releaseBoxBuffers } from "./inpaint_boxstack.js";
import { TIFF_EXT, tiffPlan, readTiffBand, readTiffBands } from "./inpaint_tiff.js";
import { pixelsBackend, isTilePixels, scratchStats, TILE_SIZE, chainScheduler } from "./inpaint_tiles.js";
import { JOB_TIMINGS, STEP_MARKS, workerCall, editorPool, buildLayered, measureGen, pendingJobs, resetPool } from "./inpaint_jobs.js";
import { encodeCanvas, canvasToBlob, partsUsable, encodeTilePixels, encodeBands } from "./inpaint_encode.js";
import { uploadBlob, uploadCanvas, uploadPixels } from "./inpaint_upload.js";
import { LAYERED_EXT } from "./inpaint_layered.js";
import { BLEND_MODES } from "./blend_modes.js";
import { pxCalls, kernelRoutes, setRoute as setKernelRoute, pxTimed, pxSplit, pxInstances } from "./px/kernels.js";
import { statusKindFor, failKind } from "./inpaint_status.js";
import { RunProgress } from "./inpaint_progress.js";
import { BRUSH_MAX, MAX_UNDO, MAX_UNDO_BYTES, NODE_CLASS, REF_DEFAULTS, REF_FITS, RELIGHT_LIGHT_TYPES, RELIGHT_STYLES, RUN_GOING_TEXT, SEL_BOX_MAX_PX, STITCH_CLASS, TAIL_OUTPUTS, brushSizeToSlider, sliderToBrushSize, editorTileMode, hostText, makeCanvas } from "./inpaint_consts.js";
import { DISSOLVE_CLIP_SHADER, DISSOLVE_SHADER } from "./inpaint_shaders.js";
import { el, icon, iconButton, miniButton, numberInput, selectGrouped, selectInput } from "./inpaint_dom.js";
import { CROP_DEFAULTS, FIXED_OUTPUTS, GEN_DEFAULTS, SETTING_SLOTS, UPSAMPLE_CASES, isSettingOutput, linkOf, randomSeed, settingIndex } from "./inpaint_backends.js";
import { STYLE, injectStyle } from "./inpaint_style.js";
import { hugePngSize, imageFileSize, loadImageEl, pixelsFromTiff, pixelsOffThread, viewUrl, bindLoad } from "./inpaint_load.js";
import { PanelsPart } from "./inpaint_ed_panels.js";
import { LayersPart } from "./inpaint_ed_layers.js";
import { HistoryPanelPart } from "./inpaint_ed_histpanel.js";
import { TextPart } from "./inpaint_ed_text.js";
import { installParts } from "./inpaint_parts.js";
import { TipsPart } from "./inpaint_ed_tips.js";
import { HealPart, bindHeal } from "./inpaint_ed_heal.js";
import { LiquifyPart, bindLiquify } from "./inpaint_ed_liquify.js";
import { ShapePart, bindShape } from "./inpaint_ed_shape.js";
import { SelectPart, bindSelect } from "./inpaint_ed_select.js";
import { StackPart, bindStack } from "./inpaint_ed_stack.js";
import { SegmentPart } from "./inpaint_ed_segment.js";
import { MasksPart } from "./inpaint_ed_masks.js";
import { GeometryPart } from "./inpaint_ed_geometry.js";
import { PointerPart } from "./inpaint_ed_pointer.js";
import { DepthPart } from "./inpaint_ed_depth.js";
import { FiltersPart } from "./inpaint_ed_filters.js";
import { HistoryPart } from "./inpaint_ed_history.js";
import { PersistPart } from "./inpaint_ed_persist.js";
import { ExportPart, bindExport } from "./inpaint_ed_export.js";
import { OpenPart, bindOpen } from "./inpaint_ed_open.js";
import { StrokesPart, bindStrokes } from "./inpaint_ed_strokes.js";
import { DisplayPart, bindDisplay } from "./inpaint_ed_display.js";
import { CompositePart, bindComposite } from "./inpaint_ed_composite.js";
import { MatchPart } from "./inpaint_ed_match.js";
import { DrawPart } from "./inpaint_ed_draw.js";
import { RelightPart } from "./inpaint_ed_relight.js";
import { ChromePart } from "./inpaint_ed_chrome.js";
import { ViewPart } from "./inpaint_ed_view.js";
import { RefsPart } from "./inpaint_ed_refs.js";

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

// Copy in one tab, paste in another: the clipboard belongs to the module, not to an editor.
let CLIPBOARD = null;

class InpaintEditor {

    get clipboard() { return CLIPBOARD; }

    set clipboard(v) { CLIPBOARD = v; }

    /** The selection's canvas under its old name, for one release: use `sel` (MaskPixels). */
    get selection() {
        deprecatedPixels("editor.selection", "editor.sel");
        return this.sel ? this.sel.toCanvas() : null;
    }

    set selection(canvas) {
        deprecatedPixels("editor.selection", "editor.sel");
        this.sel = canvas ? this.pixels.Mask.fromCanvas(canvas) : null;
    }

    constructor(node) {
        this.node = node;
        // decided once, for the editor's life: every pixels object this editor makes (layers, masks,
        // the selection, the base, undo copies) is of this backend, so they can be blitted, cloned
        // and restored into each other (docs/PLAN_BCE.md §C2 step b)
        const mode = editorTileMode();
        this.tileMode = mode.on;
        this.tileModeFrom = mode.from;
        this.pixels = pixelsBackend(this.tileMode);   // { Layer, Mask, tiles }
        this.width = 0;
        this.height = 0;
        this.base = null;            // { ref, px }: the file in the mirror and its pixels (this.basePx)
        this.layers = [];            // { id, name, kind, role, blend, ref, px (LayerPixels), x, y, w, h, opacity, visible, dirty,
                                     //   maskPx (MaskPixels, alpha = visible) | null, maskRef, maskDirty, maskEdit }
        this.activeLayerId = null;   // null = base
        this.layerSel = new Set();   // Ctrl / Shift + click in the layer list: the layers selected with the active one (PLAN_0_1_31 §6.1)
        this.layerAnchorId = null;   // where a Shift + click range starts
        this.groups = [];            // { id, name, visible, locked, collapsed, parent }: folders of layers (PLAN_0_1_31 §6.5); a layer's `group` names its innermost
        this.activeGroupId = null;   // the group whose header row was clicked (its layers are the selection)
        this._solo = null;           // { ids, visible }: the layers shown alone, and what was visible before the first solo
        this.sel = null;             // MaskPixels WxH (red, alpha = selected); null before an image is loaded
        this._relightPending = new Set();
        this._relightMarches = 0;    // relight_shadow marches in flight over all layers (`relightMarching`, the K0b harness)
        this.history = [];           // { key, ref, x, y, w, h, prompt, layerId, thumb }
        this.view = { scale: 1, x: 0, y: 0, angle: 0 };
        this.guides = { x: [], y: [] };
        // what the whole-document operations add up to since the document was opened (PLAN_0_1_31 §7: turns, crops,
        // extends, resizes, straightens), as one map from the picture then to the picture now: an undo step and a snapshot
        // keep theirs, so a restore maps what no step holds (the results history, the saved selections) by the difference
        this.docXf = [1, 0, 0, 1, 0, 0];
        // the Canvas tool's pending frame (PLAN_0_1_31 §7, 23b: `frame()`), its aspect preset and the lines over it
        this.canvasFrame = null;
        this.frameAspect = "free";
        this.frameCustom = [4, 3];
        this.frameAspectFlip = false;
        this.frameStraighten = false;
        let overlay = "thirds";
        try { overlay = localStorage.getItem("ipc.cropOverlay") || "thirds"; } catch (_) { /* no storage */ }
        this.frameOverlay = ["thirds", "golden", "grid", "diagonal", "none"].includes(overlay) ? overlay : "thirds";
        let showRulers = false, showGrid = false, gridSize = 64;
        try { showRulers = localStorage.getItem("ipc.rulers") === "1"; showGrid = localStorage.getItem("ipc.grid") === "1"; gridSize = +localStorage.getItem("ipc.gridSize") || 64; } catch (_) { /* no storage */ }
        this.showRulers = showRulers;
        this.showGrid = showGrid;
        this.gridSize = gridSize;
        this.tool = "select";
        this.brushSize = 40;
        this.brushTips = [];        // imported tips: { id, name, canvas, spacing }
        this.brushTipId = "";       // "" = the built-in round tip
        this.brushTipSpacing = 0.25;
        this.onBrushTips = null;    // the host may set this to persist imported tips
        this.hardness = 1;
        this.eraseHardness = 0.5;       // the eraser is soft by default, like Krita's Eraser Soft
        try {
            const h = parseFloat(localStorage.getItem("ipc.hardness")), e = parseFloat(localStorage.getItem("ipc.eraseHardness"));
            if (h >= 0 && h <= 1) this.hardness = h;
            if (e >= 0 && e <= 1) this.eraseHardness = e;
        } catch (_) { /* no storage */ }
        this.brushOpacity = 1;
        this.brushFlow = 1;             // below 1 the stroke builds up where its stamps overlap (flowStamps)
        // the pen: its pressure curve and the stabiliser's string in screen pixels (0 off), kept like the hardness
        this.pressureCurve = "linear";
        this.stabiliser = 0;
        try {
            const pc = localStorage.getItem("ipc.pressureCurve"), st = +localStorage.getItem("ipc.stabiliser");
            if (pc === "soft" || pc === "hard" || pc === "linear") this.pressureCurve = pc;
            if (st > 0 && st <= 100) this.stabiliser = st;
        } catch (_) { /* no storage */ }
        this.color = "#ff3b30";
        this.fillEnclosed = true;
        this.promptText = "";
        this.cropSettings = { ...CROP_DEFAULTS };
        this.upsampleSettings = { useCase: "auto", backend: "auto" };
        this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed() };
        this.negativeText = "";
        this.settings = {};             // {"1": {value, type, label}, ...} for the setting_n outputs
        this.refSettings = { ...REF_DEFAULTS };   // reference_images batch: long side, fit
        this.cutoutSettings = { backend: "auto" };
        this.cutoutPending = null;      // {layer, backend} while a background removal runs
        this.promptBackup = null;
        this.upsampleCheck = null;      // the last upsample's token check when it found something ({ dropped, invented, literals }, 26d1)
        // @img1, @img2 in the prompt name the shown reference layers (docs/PLAN_REFS.md C2): the labels they had at the
        // last change, by layer id, so the next change can rewrite them; null until the first document
        this.refMap = null;
        this._remapTargets = new Set();   // fields outside the editor whose text names references (addRemapTarget)
        this.refLayoutInfo = null;      // the app's reference layout for the chosen route: the name each reference goes as
        this.lastSentPrompt = null;     // the prompt main sent in the last provider run, the names written in
        this.lastRunNotes = [];         // what the last run's route declared it left out
        this.lastRunError = null;       // why the last Generate click was refused (commands.generate throws it)
        this.selectionLabel = "";       // what the selection is, when it came from "Select by text"
        this.undo = [];
        this.redo = [];
        this.historyGen = 0;            // bumped by every change an undo that is still loading its step must not run over
        this.maxUndo = MAX_UNDO;        // the history's depth: steps and bytes (the app's Settings › Memory sets them)
        this.maxUndoBytes = MAX_UNDO_BYTES;
        this.undoTrimmed = false;       // older steps were dropped since the last clear: the list's first row is not the start
        this.snapshots = [];            // named snapshots: [{ name, at, snap }] (turn snapshots, tiles only; not saved)
        this.selectionDirty = true;
        this.selectionLoose = false;   // cachedBounds is a superset of the selection, made exact on the next getBounds()
        this.selectionDataUrl = null;
        this.cachedBounds = null;
        this.compositeVersion = 0;      // bumped whenever the composite changes (filter caches key on it)
        this.pixelVersion = 0;          // bumped whenever a source canvas changed (the scene cache keys on it)
        this.pyramids = new WeakMap();  // source canvas -> cached downscaled levels for drawing
        this._pyramidBudget = Infinity; // new levels allowed in this frame (drawScene sets it to 1)
        this._pyramidPending = false;
        this.sceneCanvas = null;        // last composited view; overlays are drawn on top of it every frame
        this.sceneSig = null;
        this.viewCanvas = null;         // the visible region, composited at screen resolution
        this.viewPass = null;           // {x, y, w, h, sx, sy} while a region is being composited
        this.flatCache = null;          // {version, key, canvas} for eyedropper / clone / bucket / wand
        this.undoBytes = 0;
        this.selectionEncoded = false;  // the selection PNG in selectionDataUrl is up to date
        this.selectionSeq = 0;
        this.uploaded = this.makeUploaded();
        this.filterCounter = 0;
        this.filterPreview = null;      // id of the filter layer whose slider is being dragged (low-res preview)
        this.hideLightHandles = false;  // view toggle: hide 3D light handles and overlays on canvas
        this.seenResults = new Set();
        this.layerCounter = 0;
        this.paintCounter = 0;
        this.pointer = null;
        this.lassoPoints = null;
        this.polyPoints = null;         // polygon selection in progress: [[x, y], ...]
        this.shapePoints = null;        // polygon / polyline / bezier shape in progress: [{x, y, hx, hy}, ...]
        this.shapeDrag = null;          // the bezier handle being pulled right now
        this.polyMode = "replace";
        this.hover = null;
        this.objects = null;            // {hash, w, h, ids: Uint16Array, count, layerId}
        this.objectsPending = null;
        this.objectShapeCache = new Map();
        this.hoverObjectId = 0;
        this.hoverObjectCanvas = null;
        this.depthPending = null;
        this.rangePending = null;
        this.showDepthMap = false;
        this.maps = {};
        this.mapsVersion = 0;
        this._mapUndoPending = null;
        this.rangeLimit = {
            source: host.depthSupported !== false ? "depth" : "luma",
            lo: 0,
            hi: 0.3,
            fLo: 0.05,
            fHi: 0.05,
            invert: false,
            color: "#ffffff",
            tol: 30,
        };
        this.rangeMode = "replace";
        this._rangeTint = null;
        this.mapView = null;
        this.maskView = null;   // null | { id: string, mode: "overlay" | "alone" | "effect" }
        this.maskClip = null;   // null | { id: string } (layer whose mask was copied in mask menu)
        this._pendingPick = null;
        this._pendingPickTarget = null;
        this.geometrySeq = 0;
        let selDisplay = "ants";
        try { selDisplay = localStorage.getItem("ipc.selectionDisplay") || "ants"; } catch (_) { /* no storage */ }
        this.selectionDisplay = selDisplay === "tint" ? "tint" : "ants";   // marching ants (default) or red tint
        this.status = "No image loaded.";
        this.statusKind = "";
        // the status row's bar: the hosts feed it the runs of this document (docs/PLAN_0_1_48.md S3)
        this.runProgress = new RunProgress((s) => this.renderRunProgress(s));
        this.isOpen = false;

        injectStyle();
        this.buildNodeWidget();
        this.buildModal();
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        host.mount(this.root);
        // While the editor is open every shortcut belongs to it. The listener sits
        // on window in the capture phase so ComfyUI's own handlers (workflow undo on
        // Ctrl+Z, keybindings) never see the keys; otherwise Ctrl+Z would undo the
        // whole workflow state and reset the canvas.
        this._docKey = (e) => {
            if (!this.isOpen || !host.isActive(this)) return;
            const t = e.target;
            if (this.askOpen) return;   // the question dialog has its own keys
            if (t && t.closest && t.closest("dialog[open]")) return;   // a key inside an open <dialog> (a host settings dialog, a plugin's) stays with the dialog: Escape has to reach its native close
            if (t && t.closest && t.closest("[data-own-keys]")) return;   // a host's own floating panel (a shadow root's host: its keys arrive retargeted to it) keeps its keys, as a dialog does
            if (document.querySelector("dialog:modal")) return;        // the rest of the page is inert under a modal dialog (the app's questions)
            const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
            if (e.key === "Escape") {
                if (this.tipPicker && this.tipPicker.isOpen) { e.stopImmediatePropagation(); e.preventDefault(); this.closeTipPicker(); return; }
                // the prompt field's picker or swap menu goes first; a second Escape leaves the field
                if (this.promptField && this.promptField.popupOpen()) { e.stopImmediatePropagation(); e.preventDefault(); this.promptField.closePopups(); return; }
                if (t === this.promptInput) return;
                e.stopImmediatePropagation(); e.preventDefault();
                if (this._pendingPick) {
                    this._pendingPick = null;
                    this._pendingPickTarget = null;
                    if (this._pickResolve) { const r = this._pickResolve; this._pickResolve = null; r(null); }
                    this.draw();
                    this.setStatus("Pick cancelled.");
                }
                else if (this.rangePending) {
                    this.cancelRange();
                }
                else if (this._rangeTint) {
                    this.setRangePreview(null);
                }
                else if (this.pointer && this.pointer.kind === "patchdrag") { const p = this.pointer; this.pointer = null; this.patchDone(p); this.draw(); this.setStatus(`${p.tool === "contentmove" ? "Move" : "Patch"} cancelled.`); }
                else if (this.pointer && this.pointer.kind === "liquify" && !this.pointer.healing) { const p = this.pointer; this.pointer = null; this.liquifyDrop(p, "Liquify cancelled."); }
                else if (this.pending) this.cancelPending();
                else if (this.polyPoints) { this.polyPoints = null; this.draw(); this.setStatus("Polygon cancelled."); }
                else if (this.shapePoints) { this.cancelShape(); this.draw(); this.setStatus("Shape cancelled."); }
                else if (this.tool === "canvas" && this.pointer && ["frame", "framemove", "framerotate", "straighten"].includes(this.pointer.kind)) {
                    const o = this.pointer.orig;
                    this.pointer = null;
                    this.canvasFrame = o && o.base === this.base ? { ...o } : null;
                    this.syncFrameControls(); this.draw(); this.setStatus("The frame is back where it was.");
                }
                else if (this.tool === "canvas" && this.framePending()) { this.resetFrame(); this.setStatus("Canvas frame reset."); }
                else if (this.flyout) this.closeFlyout();
                else if (this.textEdit) this.endTextEdit(false);
                else if (this.compare) { this.compare = null; if (this.compareBtn) this.compareBtn.classList.remove("ipc-on"); this.draw(); this.setStatus("Compare ended."); }
                else if (this.tool === "lights" && this.isRelightActive()) {
                    const l = this.activeLayer();
                    if (l && l._selectedLightId) {
                        l._deselected = true;
                        l._selectedLightId = null;
                        this.renderLayers();
                        this.draw();
                        this.setStatus("Light deselected.");
                    }
                }
                else if (this.boxes && this.boxes.key(e, "escape")) { /* the Boxes tool let go of its box */ }
                else if (!host.pluginKey(this, e, "escape")) host.onEscape(this);
                return;
            }
            // a key from inside the tip popover (a button there after Tab) is never an editor shortcut
            if (this.tipPicker && this.tipPicker.isOpen && t && this.tipPicker.el.contains(t)) return;
            if (inField) return;   // typing in the editor's own fields: their handlers stop propagation themselves
            e.stopImmediatePropagation();
            // a heal stroke blending in a worker is still the gesture (`healBlend`): its commit reads the selection and the
            // layer as they are, so a shortcut waits for it as a press does (Ctrl+Z waits for it through `trackEdit`)
            if (this.pointer && this.pointer.healing && !((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z")) {
                e.preventDefault();
                this.setStatus(this.heldWord(this.pointer));
                return;
            }
            this.onKey(e);
        };
        window.addEventListener("keydown", this._docKey, true);
        this._docKeyUp = (e) => {
            // the key that started it: AltGr+ß types \ only while AltGr is down, and it may come up first
            if (this.peekHold && (e.key === "\\" || (this.peekCode && e.code === this.peekCode))) { this.peekHold = false; this.peekCode = null; this.peekBase = false; if (this.peekBtn) this.peekBtn.classList.remove("ipc-toggle-on"); this.draw(); }
        };
        window.addEventListener("keyup", this._docKeyUp, true);
        this.setPromptText(this.promptText, { history: "reset" });
        this.refreshSegmentBackends();
        this.syncRefControls();
        loadFontList().then(() => { if (this.isOpen && this.layers.some((l) => l.kind === "text")) this.renderLayers(); }).catch(() => {});
        this.root.focus({ preventScroll: true });
        this.applyStoredSideWidth();
        this.resizeCanvas();
        this.fitView();
        this.renderLayers();
        this.renderHistory();
        this.renderInfo();
    }

    close() {
        if (!this.isOpen) return;
        if (this.pending) this.cancelPending();
        // a heal still blending in a worker lands as its quick heal (the worker's answer finds the pointer gone); a Remove
        // waiting for the model lands nothing (its stroke is only the mark of the hole)
        const hp = this.pointer;
        // a liquify stroke, dragged or baking, lands nothing either (the field goes back with it, the source is let go)
        if (hp && hp.kind === "liquify") { this.pointer = null; this.liquifyDrop(hp, null); }
        else if (hp && hp.healing) { this.pointer = null; if (hp.remove) this.dropStroke(hp); else this.commitLayerPaint(hp); }
        this.endLiquify();
        this.liqFreezes = null;
        this.isOpen = false;
        if (this.antsTimer) { clearInterval(this.antsTimer); this.antsTimer = null; }
        this.pointer = null;
        this.lassoPoints = null;
        if (this._docKey) window.removeEventListener("keydown", this._docKey, true);
        this._docKey = null;
        if (this._docKeyUp) window.removeEventListener("keyup", this._docKeyUp, true);
        this._docKeyUp = null;
        if (this.textEdit) this.endTextEdit(true);
        this.closeFlyout();
        this.dropFlyoutListener();
        this.closeAsk();
        this.closeTipPicker();   // its window listener and preview slices go with the editor (8c14eee)
        // a relight nudge or wheel burst still in its 300 ms is dropped, not committed: its timer and flush, the snapshot it
        // would have pushed (the layer's next edit would take it as its own "before") and its preview
        for (const l of this.layers || []) {
            if (!l || !(l._flushNudge || l._flushWheel || l._nudgeRelightTimer || l._wheelRelightTimer || l._nudgePending || l._wheelPending)) continue;
            clearTimeout(l._nudgeRelightTimer);
            clearTimeout(l._wheelRelightTimer);
            l._nudgeRelightTimer = l._wheelRelightTimer = null;
            l._flushNudge = l._flushWheel = null;
            l._nudgePending = l._wheelPending = l._wheelLabel = null;
            if (this.filterPreview === l.id) this.filterPreview = null;
        }
        if (this.promptField) this.promptField.closePopups();
        clearTimeout(this._autosave);
        this.compare = null;
        this.peekBase = false;
        this.flatCache = null;
        this.sceneCanvas = null;
        this.sceneSig = null;
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
            const t = e.target;
            if (this.askOpen) return;   // the dialog just focused its input; do not pull the focus back to the canvas
            // a button inside the prompt field (a chip's chevron) keeps the field's focus
            if (t && t.closest && t.closest("button") && !t.closest("input, select, textarea, [contenteditable]")) this.root.focus({ preventScroll: true });
        });
        root.addEventListener("wheel", (e) => {
            if (e.target !== this.canvas) { e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation();
            this.onWheel(e);
        }, { passive: false });
        // Keys are handled by the window capture listener (see open()); here we
        // only keep them from bubbling to the graph canvas.
        root.addEventListener("keydown", (e) => { this._loadNote = null; e.stopPropagation(); });
        // the user acts: a load's note (setValue) stops riding on the next lines
        root.addEventListener("pointerdown", () => { this._loadNote = null; }, true);
        root.addEventListener("paste", (e) => {
            if (this.promptInput && e.target && this.promptInput.contains(e.target)) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault(); e.stopPropagation();
                    // no base yet: the image becomes the base; otherwise it lands as a new layer at the origin (Krita: paste as new layer)
                    if (this.width) this.addImageLayers([item.getAsFile()], "none", { place: "origin" });
                    else this.loadFile(item.getAsFile());
                    return;
                }
            }
        });
        this.viewEl.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = e.ctrlKey && this.width ? "move" : "copy"; this.viewEl.classList.add("ipc-dropping"); });
        this.viewEl.addEventListener("dragleave", (e) => { if (!this.viewEl.contains(e.relatedTarget)) this.viewEl.classList.remove("ipc-dropping"); });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.viewEl.classList.remove("ipc-dropping");
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/") || LAYERED_EXT.test(f.name || "") || TIFF_EXT.test(f.name || ""));
            if (!files.length) return;
            // No image yet, or Ctrl held: the file becomes (replaces) the base. Otherwise each file is a new
            // image layer centred on the drop point (Shift: reference layers), like dropping into Krita.
            if (!this.width || e.ctrlKey) { this.loadFile(files[0]); return; }
            if (e.shiftKey) { this.addImageLayers(files, "reference"); return; }
            this.addImageLayers(files, "none", { place: "at", at: this.toImage(e) });
        });
        this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.hoverObjectId = 0; this.hoverObjectCanvas = null; this.draw(); });
    }

    /**
     * A question inside the editor: Electron has no window.prompt (it throws
     * "prompt() is not supported"), and a native dialog would block the canvas.
     * Resolves with the entered text, with true for a plain confirm, or with null
     * when the question was cancelled.
     *
     * `fields` makes a form: number boxes ({ key, label, value, min, max, disabled }), selects ({ key, label,
     * type: "select", options: [{ value, label, group }], value, hidden, disabled, wide }; options with a group go in an
     * optgroup of that name, a `wide` field takes a row of its own) and note lines ({ key, type: "note", text, hidden }).
     * The answer is then an object: a number per number box, a string per select (hidden ones too), no notes.
     * `linked` offers to tie exactly two number boxes by their ratio (a disabled box is not tied). `onChange(key, values,
     * set)` runs after a select is changed or a number box is typed in: `values` the answer as it is now,
     * `set(key, { options, value, hidden, disabled, text })` changes a field without calling onChange again.
     */
    ask({ title = "", message = "", value = null, fields = null, linked = false, ok = "OK", cancel = "Cancel", danger = false, onChange = null } = {}) {
        return new Promise((resolve) => {
            const wrap = el("div", "ipc-ask");
            const box = el("div", "ipc-askbox");
            if (title) box.appendChild(el("div", "ipc-asktitle", title));
            if (message) box.appendChild(el("div", "ipc-askmsg", message));
            let input = null;
            const nums = [];        // the number boxes, in order
            const ctls = [];        // every control that answers: number boxes and selects, in order
            const parts = new Map();   // key -> { kind, cell, ctl }
            // the ratio tie (two number boxes): its hooks stay no-ops without one
            let tied = () => false, retie = () => {}, syncLink = () => {};
            // a select's value: `want` when it is one of the options, else the first option
            const pickOption = (sel, want) => {
                const v = want == null ? "" : String(want);
                sel.value = v;
                if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
            };
            const fillSelect = (sel, options, want) => {
                sel.textContent = "";
                let group = null;
                for (const raw of options || []) {
                    const o = raw && typeof raw === "object" ? raw : { value: raw, label: raw };
                    const opt = document.createElement("option");
                    opt.value = String(o.value == null ? "" : o.value);
                    opt.textContent = String(o.label != null ? o.label : opt.value);
                    if (o.group) {
                        if (!group || group.label !== String(o.group)) { group = document.createElement("optgroup"); group.label = String(o.group); sel.appendChild(group); }
                        group.appendChild(opt);
                    } else {
                        group = null;
                        sel.appendChild(opt);
                    }
                }
                pickOption(sel, want);
            };
            if (fields && fields.length) {
                // one labelled box per field (a number box or a select), notes between them; two number boxes can be
                // tied by their ratio
                const grid = el("div", "ipc-askfields");
                for (const f of fields) {
                    const kind = f.type === "select" ? "select" : f.type === "note" ? "note" : "number";
                    if (kind === "note") {
                        const note = el("div", "ipc-asknote", f.text != null ? String(f.text) : "");
                        note.hidden = !!f.hidden;
                        grid.appendChild(note);
                        parts.set(f.key, { kind, cell: note, ctl: null });
                        continue;
                    }
                    const cell = el("div", "ipc-askfield" + (f.wide ? " ipc-askwide" : ""));
                    cell.appendChild(el("span", null, f.label || f.key));
                    let ctl;
                    if (kind === "select") {
                        ctl = document.createElement("select");
                        ctl.className = "ipc-askinput";
                        fillSelect(ctl, f.options, f.value);
                    } else {
                        ctl = document.createElement("input");
                        ctl.type = "number";
                        ctl.className = "ipc-askinput";
                        ctl.value = String(f.value != null ? f.value : "");
                        if (f.min != null) ctl.min = String(f.min);
                        if (f.max != null) ctl.max = String(f.max);
                        nums.push(ctl);
                    }
                    ctl.dataset.key = f.key;
                    ctl.disabled = !!f.disabled;
                    cell.hidden = !!f.hidden;
                    cell.appendChild(ctl);
                    grid.appendChild(cell);
                    ctls.push(ctl);
                    parts.set(f.key, { kind, cell, ctl });
                }
                box.appendChild(grid);
                if (nums.length === 2 && linked) {
                    const lab = el("label", "ipc-asklink");
                    const link = document.createElement("input");
                    link.type = "checkbox";
                    link.checked = linked === "on";   // true only offers the tie; "on" starts with it
                    lab.appendChild(link);
                    lab.appendChild(el("span", null, "Keep the ratio"));
                    box.appendChild(lab);
                    // the ratio of the two values: taken at the start; with onChange (a dialog whose fields the caller
                    // changes, New with a model) also when the tie is ticked and when set() changes them while they are
                    // not tied (a disabled box is not tied). A plain dialog (the two-number New, the node's, SVG import)
                    // keeps the ratio it opened with
                    let ratio = 1;
                    retie = () => { const a = +nums[0].value, b = +nums[1].value; if (a > 0 && b > 0) ratio = b / a; };
                    retie();
                    tied = () => link.checked && !nums[0].disabled && !nums[1].disabled;
                    syncLink = () => { const off = nums[0].disabled || nums[1].disabled; link.disabled = off; lab.classList.toggle("ipc-off", off); };
                    syncLink();
                    const tie = (from, to, factor) => () => {
                        if (!tied()) return;
                        const v = +from.value;
                        if (v > 0) to.value = String(Math.max(1, Math.round(v * factor())));
                    };
                    nums[0].addEventListener("input", tie(nums[0], nums[1], () => ratio));
                    nums[1].addEventListener("input", tie(nums[1], nums[0], () => (ratio ? 1 / ratio : 1)));
                    if (typeof onChange === "function") link.addEventListener("change", () => { if (link.checked) retie(); });
                }
            } else if (value != null) {
                input = document.createElement("input");
                input.type = "text";
                input.className = "ipc-askinput";
                input.value = String(value);
                box.appendChild(input);
            }
            const row = el("div", "ipc-askrow");
            const cancelBtn = el("button", "ipc-ib", cancel);
            const okBtn = el("button", "ipc-ib " + (danger ? "ipc-danger" : "ipc-primary"), ok);
            cancelBtn.type = "button";
            okBtn.type = "button";
            row.appendChild(el("span", "ipc-grow"));
            row.appendChild(cancelBtn);
            row.appendChild(okBtn);
            box.appendChild(row);
            wrap.appendChild(box);
            // the answer: an object for fields (numbers for number boxes, strings for selects), the string for a text
            // input, true otherwise
            const answer = () => {
                if (!ctls.length) return input ? input.value : true;
                const out = {};
                for (const c of ctls) out[c.dataset.key] = c.tagName === "SELECT" ? c.value : +c.value;
                return out;
            };
            // a field changed by the caller (onChange): its options, value, text, hidden and disabled state
            const set = (key, patch = {}) => {
                const p = parts.get(key);
                if (!p || !patch) return;
                if (p.kind === "note") {
                    if (patch.text != null) p.cell.textContent = String(patch.text);
                } else {
                    const wasOff = p.ctl.disabled;
                    if (p.kind === "select" && patch.options) fillSelect(p.ctl, patch.options, patch.value != null ? patch.value : p.ctl.value);
                    else if (patch.value != null) {
                        if (p.kind === "select") pickOption(p.ctl, patch.value);
                        else p.ctl.value = String(patch.value);
                    }
                    if (patch.disabled != null) p.ctl.disabled = !!patch.disabled;
                    // the tie takes the new values as its ratio unless it holds them (a box enabled again joins it anew)
                    if (p.kind === "number" && (patch.value != null || wasOff !== p.ctl.disabled) && (!tied() || (wasOff && !p.ctl.disabled))) retie();
                }
                if (patch.hidden != null) p.cell.hidden = !!patch.hidden;
                syncLink();
            };
            if (typeof onChange === "function") {
                const fire = (key) => {
                    try { onChange(key, answer(), set); } catch (err) { console.error(err); }
                };
                // after the tie's own listeners, so onChange sees both values
                for (const c of ctls) c.addEventListener(c.tagName === "SELECT" ? "change" : "input", () => fire(c.dataset.key));
            }
            const finish = (val) => {
                if (this.askOpen !== wrap) return;
                this.askOpen = null;
                if (this._askFinish === finish) this._askFinish = null;
                window.removeEventListener("keydown", onKey, true);
                wrap.remove();
                try { this.root.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
                resolve(val);
            };
            const onKey = (e) => {
                // a question no longer on the page (its editor closed or destroyed) takes no key: it lets go of the window
                if (this._destroyed || !wrap.isConnected) {
                    window.removeEventListener("keydown", onKey, true);
                    if (this.askOpen === wrap) finish(null);
                    return;
                }
                if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(null); }
                else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); finish(answer()); }
            };
            cancelBtn.addEventListener("click", () => finish(null));
            okBtn.addEventListener("click", () => finish(answer()));
            wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) finish(null); });
            this.askOpen = wrap;
            // close() and destroy() answer an open question with null: its window listener closes over the editor
            this._askFinish = finish;
            window.addEventListener("keydown", onKey, true);
            this.root.appendChild(wrap);
            // the first number box that can be typed in, else the first select, else the text input or OK
            const usable = (c) => !c.disabled && !c.closest("[hidden]");
            const firstNum = nums.find(usable);
            const firstSel = ctls.find((c) => c.tagName === "SELECT" && usable(c));
            if (firstNum) { firstNum.focus(); firstNum.select(); }
            else if (firstSel) firstSel.focus();
            else if (input) { input.focus(); input.select(); }
            else okBtn.focus();
        });
    }

    /**
     * The status line. `opts` gives its kind: "error" or "warn" (red, five blinks, then steady red until the next
     * line; no blink under reduced motion), "info" (plain whatever the text says), or { kind }; left out, the text
     * decides (inpaint_status.js statusKindOf). `status` stays the plain text, `statusKind` the kind ("" for a plain line).
     */
    setStatus(text, opts) {
        let kind = statusKindFor(text, opts);
        // a load that left layers out (setValue) says so on the plain lines written right after it too (LOAD_NOTE_LINES)
        const carry = this._loadNote;
        if (carry && Date.now() > carry.until) this._loadNote = null;
        else if (carry && !kind && !String(text).includes(carry.note)) {
            text = `${text} ${carry.note}`;
            kind = "warn";
            if (--carry.lines <= 0) this._loadNote = null;
        }
        this.status = text;
        this.statusKind = kind;
        for (const node of [this.statusEl, this.nodeStatus]) {
            if (!node) continue;
            // the same line again while it still blinks (a caller that repeats itself) keeps its blink going
            const again = kind && node.textContent === String(text) && node.classList.contains("ipc-status-blink");
            node.textContent = text;
            node.classList.toggle("ipc-status-error", !!kind);
            if (again) continue;
            node.classList.remove("ipc-status-blink");
            if (!kind) continue;
            // the five pulses are over: drop the class, or a hidden tab shown again (display: none and back) would blink anew
            if (!node._blinkEnds) {
                node._blinkEnds = true;
                node.addEventListener("animationend", (e) => { if (e.animationName === "ipc-status-blink") node.classList.remove("ipc-status-blink"); });
            }
            // every error line blinks anew, the same text after its blink too: the class comes back after a style flush
            void node.offsetWidth;
            node.classList.add("ipc-status-blink");
        }
    }

    /**
     * The status row's bar from a RunProgress state (null: hidden): the fill at the fraction, or a busy sweep without
     * one (still under reduced motion), and the label beside it (the node k of n, a sampler's step, the seconds).
     */
    renderRunProgress(s) {
        const box = this.runEl;
        if (!box) return;
        box.hidden = !s;
        if (!s) return;
        const busy = s.fraction == null;
        box.classList.toggle("ipc-run-busy", busy);
        this.runFill.style.width = busy ? "" : `${Math.round(Math.max(0, Math.min(1, s.fraction)) * 1000) / 10}%`;
        if (this.runLabel.textContent !== s.label) this.runLabel.textContent = s.label;
        box.title = s.label;
    }

    // ---- file cleanup ---------------------------------------------------------------

    /** File names every open editor and every open workflow tab still reference. */
    /** A job of the editor's worker, and the timings of the worker jobs since the last reset (phase R's benchmark, docs/PLAN_BCE.md §2b). */
    static get kernels() { return kernelsMode(); }
    static set kernels(mode) { setKernels(mode); }

    /** The window's kernel routes, defaults and overrides merged (px/kernels.js `kernelRoutes`; docs/PLAN_WASM_K1.md §1.3). */
    static get routes() { return kernelRoutes(); }

    /** Override one route on the window and in every job sent after it (`null` removes the override; a bad name or value throws). */
    static setRoute(name, value) { return setKernelRoute(name, value); }

    static workerJob(op, args = {}, transfer = []) {
        return workerCall(op, args, transfer);
    }

    /** The PNG writers of E2, the parted reader of K8, the banded TIFF reader of K18 and the pool, for tests and benchmarks. */
    static get parts() {
        return { usable: partsUsable, encodeTilePixels, encodeBands, encodeCanvas, uploadPixels, buildLayered, pool: editorPool, pngRoute: hugePngSize, imageRoute: imageFileSize, offThread: pixelsOffThread, pngPartsOf, readPngParts, pixelsFromTiff, tiffPlan, readTiffBand, readTiffBands };
    }

    /** Rows per band for `tiff_band` opens (K18; `0`: `TILE_SIZE`; `false`: `tiff_read` instead of `tiff_band`). */
    static tiffBandRows = 0;

    /** PNG files of at least this many pixels are opened through the stream reader when they need no colour management (0: only above the canvas limit). */
    static pngStreamFrom = 32 * 1024 * 1024;

    /** Image files (JPEG, WebP, a PNG the stream reader does not take) of at least this many pixels are decoded in a pool worker on tiles (0: never). */
    static imageWorkerFrom = 32 * 1024 * 1024;

    /** The heal's Poisson blend at the release (false: the dabs' quick heal is what lands, as before 0.1.32). */
    static healBlend = true;

    /** A heal stroke's box above this many pixels keeps the quick heal (the blend's grids take about 40 bytes a pixel). */
    static healBlendMax = 8 * 1024 * 1024;

    /** A heal stroke with at most this many pixels to heal, in a box of at most `healSyncBox`, is blended at the release
     * (up to about 60 ms: the blend's cost follows the box too); more go to a worker. */
    static healSyncMax = 128 * 1024;

    static healSyncBox = 512 * 1024;

    /** Remove fills a stroke up to this many pixels across (its crop is twice that, scaled to the model's 512 x 512). */
    static removeMaxHole = 2048;

    /** A liquify stroke whose tiles hold at most this many pixels is baked at the release; more in the pool (0: always the pool). */
    static liquifySyncMax = 256 * 1024;

    /** A liquify bake's gathered block at most this many pixels (inpaint_liquify.js; tests force it small). 0: the module's. */
    static liquifyBlockMax = 0;

    /** Grow, shrink, swirl and restore dab this often (ms) while the button is held still; 0 turns the timer off (tests). */
    static liquifyRateMs = 33;

    /** The dense dab kernel `liquifyDab` passes to `LiquifyField.dab` (K30; `null` forces the Map-based reference loop). */
    static liquifyDabKernel = liquifyDab;

    /** Liquify's preview of a box larger than this many pixels is computed at a coarser resolution and scaled up. */
    static liquifyPreviewMax = 256 * 1024;

    /** A patch drag shows the picture it would take (Source) or the piece it copies (Destination) up to this many pixels of the selection's box; above, only the outline follows. */
    static patchPreviewMax = 2 * 1024 * 1024;

    static jobTimings(reset = false) {
        const out = JOB_TIMINGS.slice();
        if (reset) JOB_TIMINGS.length = 0;
        return out;
    }

    /** The window's step marks (inpaint_jobs.js `markStep`): a copy; `reset` clears them. */
    static stepMarks(reset = false) {
        const out = STEP_MARKS.slice();
        if (reset) STEP_MARKS.length = 0;
        return out;
    }

    /** The window thread's px kernel calls by export name (px/kernels.js `pxCalls`, the K0b harness): a copy; `reset` clears them. */
    static pxCalls(reset = false) {
        return pxCalls(reset);
    }

    /** The window's px clocks on or off (no argument: the current state); while on, every job asks its worker for a split (K1). */
    static pxTimed(on) {
        return on === undefined ? pxTimed() : pxTimed(on);
    }

    /** The window thread's split since the last `pxCalls(true)` (px/kernels.js `pxSplit`); `since` a split taken before. */
    static pxSplit(since = null) {
        return pxSplit(since);
    }

    /** The window thread's px instance: its serial, bytes, holds and renewals by cause (px/kernels.js `pxInstances`). */
    static pxInstances() {
        return pxInstances();
    }

    /** The measurement generation the jobs carry (inpaint_jobs.js `measureGen`); `next` starts a new one. */
    static measureGen(next = false) {
        return measureGen(next);
    }

    /** The worker jobs sent and not answered yet, the pool's queue included (a harness's settle waits for 0). */
    static pendingJobs() {
        return pendingJobs();
    }

    /** Stop the pool's workers so the next job starts new ones (a harness's fresh pool). */
    static resetPool() {
        resetPool();
    }

    static referencedFiles() {
        const keep = new Set();
        const scan = (text) => { for (const m of String(text || "").matchAll(/"filename"\s*:\s*"([^"]+)"/g)) keep.add(m[1]); };
        for (const text of host.referencedTexts ? host.referencedTexts() : []) scan(text);   // the node's open workflow tabs
        for (const ed of host.editors()) {
            scan(ed.lastValueString);
            try { scan(ed.getValue()); } catch (_) { /* ignore */ }
            scan(JSON.stringify(ed.uploaded));
            scan(JSON.stringify(ed.layers.map((l) => [l.ref, l.maskRef, l.exportRef, l.lut && l.lut.ref, l.plate && l.plate.ref])));
            if (ed.base) scan(JSON.stringify(ed.base.ref));
            // what the undo and redo steps and the named snapshots hold: an undo puts those files back (not caught: a walk
            // that fails stops the clean-up)
            scan(JSON.stringify(ed.heldFileRefs()));
        }
        try { for (let i = 0; i < localStorage.length; i++) scan(localStorage.getItem(localStorage.key(i))); } catch (_) { /* ignore */ }
        return Array.from(keep);
    }

    /**
     * The base image, `{ ref, px }` or null (C6 d): the file in the mirror (the state, runs, uploads) and its pixels, made
     * once when the base is set. The base kept the <img> it was decoded from, `{ ref, img }`, and made its pixels from it
     * on the first frame: at 15000 x 10000 a 572 MB decoded image kept for the life of the base and of every canvas undo
     * step, a second decode of each crop, resize, extend, merge into the base, flatten and generated base after its own
     * upload came back as an <img>, and 0.5 to 0.8 s of `fromImage` on the first frame after an undo of any of them.
     * A base is never written, only replaced; a replaced base's atlas pages go (C6 a).
     */
    get base() { return this._base || null; }

    set base(v) {
        const old = this._base;
        this._base = v || null;
        if (old && (!v || old.px !== v.px)) this.scheduleDetachedRelease();
    }

    /** The base image's pixels; null exactly when there is no base image. */
    get basePx() { return this._base ? this._base.px || null : null; }

    get _basePx() { return this.basePx; }

    /**
     * Upload every edited layer so its pixels survive a reload. Only dirty pixels are
     * materialised (autosave calls this for every tab); the file name is the PNG's hash.
     */
    /**
     * Upload every edited layer and mask. One pass at a time per document (the 15 s autosave and a save before closing
     * can ask at once: the second waits for the first, so it never finds a layer "clean" whose upload is still running).
     * A layer counts as clean from the start of its upload, so a change during the upload marks it again for the next
     * pass; a failed upload marks it again too.
     */
    syncLayers() {
        const pass = (this._syncing || Promise.resolve()).catch(() => {}).then(() => this.syncLayersOnce());
        this._syncing = pass;
        return pass;
    }

    async syncLayersOnce() {
        for (const layer of this.layers) {
            if (layer.dirty && layer.px) {
                layer.dirty = false;
                try {
                    const { ref } = await uploadPixels(layer.px, `n${this.node.id}_layer`);
                    layer.ref = ref;
                } catch (err) {
                    layer.dirty = true;
                    throw err;
                }
            }
            if (layer.maskDirty && layer.maskPx) {
                layer.maskDirty = false;
                try {
                    const { ref } = await uploadPixels(layer.maskPx, `n${this.node.id}_lmask`);
                    layer.maskRef = ref;
                } catch (err) {
                    layer.maskDirty = true;
                    throw err;
                }
            }
        }
        this.notifyChanged();
    }

    /** Draw once on the next animation frame, however many slider events arrive before it. */
    drawSoon() {
        if (this._drawQueued) return;
        this._drawQueued = true;
        requestAnimationFrame(() => { this._drawQueued = false; this.draw(); });
    }

    /** A skin was switched (renderer/skins.js): redraw what took its colours from THEME. */
    themeChanged() { try { this.renderLayers(); } catch (err) { console.warn("theme: layers", err); } try { this.syncTipControls(); } catch (err) { console.warn("theme: tip", err); } this.drawSoon(); }

    // ---- queue -------------------------------------------------------------

    // ---- editor-driven settings (setting_n outputs) -------------------------------

    /** Connected setting outputs with their targets: [{index, output, node, inputName, spec, widget}]. */
    settingTargets() {
        return host.settingTargets(this);
    }

    settingTargetsFromGraph() {
        const res = [];
        const outs = this.node.outputs || [];
        const graph = this.node.graph || (host.graph ? host.graph() : null);
        for (let i = FIXED_OUTPUTS; i < outs.length; i++) {
            const o = outs[i];
            if (!isSettingOutput(o) || !o.links || !o.links.length) continue;
            const link = linkOf(graph, o.links[0]);
            if (!link) continue;
            const target = graph.getNodeById(link.target_id);
            if (!target) continue;
            const input = target.inputs && target.inputs[link.target_slot];
            if (!input) continue;
            const inputName = input.name;
            const nd = target.constructor && target.constructor.nodeData;
            const spec = nd && nd.input && ((nd.input.required && nd.input.required[inputName]) || (nd.input.optional && nd.input.optional[inputName])) || null;
            const widget = target.widgets && target.widgets.find((w) => w.name === inputName) || null;
            res.push({ index: settingIndex(o), output: o, node: target, inputName, spec, widget });
        }
        return res;
    }

    /** Kind and options of a target input from its node definition (or its widget as fallback). */
    settingKind(t) {
        const spec = t.spec;
        let type = spec ? spec[0] : (t.widget ? t.widget.type : "STRING");
        let opts = spec && spec[1] ? spec[1] : {};
        if (Array.isArray(type)) return { kind: "combo", options: type, opts };
        if (type === "COMBO") return { kind: "combo", options: (opts.options || (t.widget && t.widget.options && t.widget.options.values) || []), opts };
        if (type === "INT" || type === "FLOAT") return { kind: "number", type, opts };
        if (type === "BOOLEAN") return { kind: "boolean", opts };
        if (t.widget && t.widget.type === "combo") return { kind: "combo", options: (t.widget.options && t.widget.options.values) || [], opts };
        if (t.widget && t.widget.type === "number") return { kind: "number", type: Number.isInteger(t.widget.options && t.widget.options.precision) && t.widget.options.precision === 0 ? "INT" : "FLOAT", opts: t.widget.options || {} };
        return { kind: "string", opts };
    }

    /** Called when a setting output is (dis)connected: keep the stored values in step with the targets. */
    settingsChanged() {
        const targets = this.settingTargets();
        const live = new Set();
        for (const t of targets) {
            const key = String(t.index);
            live.add(key);
            const k = this.settingKind(t);
            const label = `${t.node.title || t.node.type} · ${t.inputName}`;
            const type = k.kind === "number" ? k.type : (k.kind === "boolean" ? "BOOLEAN" : (k.kind === "combo" ? "COMBO" : "STRING"));
            const cur = this.settings[key];
            // the app's local recipes give a key with the recipe in it; the node's graph targets have none
            const target = t.key || `${t.node.id}:${t.inputName}`;
            if (!cur || cur.target !== target) {
                // new target: start from what the widget shows now, so connecting changes nothing
                const value = t.widget ? t.widget.value : (k.kind === "combo" ? k.options[0] : (k.kind === "number" ? (k.opts.default ?? 0) : (k.kind === "boolean" ? !!k.opts.default : "")));
                this.settings[key] = { value, type, label, target };
            } else {
                cur.type = type; cur.label = label;
            }
        }
        for (const key of Object.keys(this.settings)) if (!live.has(key)) delete this.settings[key];
        this.renderSettings();
        this.notifyChanged();
    }

    renderSettings() {
        // a preset or a recipe may switch a row the layout reads (a ToAPIs channel)
        this.refreshRefLayout();
        if (!this.settingsList) return;
        const list = this.settingsList;
        list.innerHTML = "";
        const targets = this.settingTargets();
        if (!targets.length) {
            // the app's rows come from the recipe, not from wiring: its shell sets its own text (noSettingsText)
            list.appendChild(el("span", null, this.noSettingsText || "Wire a setting output of the node into any widget (lora_name, ckpt_name, steps ...) and it shows up here."));
            return;
        }
        host.renderPresets(this, list, targets);
        for (const t of targets) {
            const key = String(t.index);
            const entry = this.settings[key];
            if (!entry) continue;
            const k = this.settingKind(t);
            const lab = el("label", null, entry.label);
            lab.title = `setting_${t.index} → ${entry.label}`;
            let control;
            // onSettingSet: the app keeps a row you set as the recipe's value for every tab (issue #12); the node has none
            const commit = (v) => { entry.value = v; if (t.widget) { try { t.widget.value = v; } catch (_) { /* read-only */ } } this.notifyChanged(); this.refreshRefLayout(); if (typeof this.onSettingSet === "function") this.onSettingSet(entry.target, v); };
            if (k.kind === "combo") {
                // a file the server's list lacks stays the recipe's choice, marked in the select (issue #4: until 0.1.45
                // the row silently became the folder's first file, a Flux file on most installs); the app's host refuses
                // the run with the file and its download link (missingFilesRefusal). An empty value still takes the first.
                const options = k.options.map(String), value = String(entry.value ?? "");
                const known = options.includes(value);
                const missing = !known && options.length > 0 && value !== "";
                control = selectInput(missing ? [...options, { value, label: `${value} (not on the server)` }] : options, value, entry.label);
                if (!known && !missing && options.length) { entry.value = k.options[0]; control.value = String(entry.value); }
                if (missing) {
                    control.classList.add("ipc-sel-missing");
                    control.title = `${entry.label}: ${value} is not on the server. Put the file in its models folder (Generate names the download link), or pick one of the server's files here.`;
                }
                control.addEventListener("change", () => commit(control.value));
            } else if (k.kind === "number") {
                const o = k.opts || {};
                control = numberInput(entry.value, o.min ?? -1e9, o.max ?? 1e9, entry.label, 96);
                control.step = o.step ?? (k.type === "INT" ? 1 : 0.01);
                control.addEventListener("change", () => commit(k.type === "INT" ? Math.round(+control.value || 0) : (+control.value || 0)));
            } else if (k.kind === "boolean") {
                control = document.createElement("input"); control.type = "checkbox"; control.checked = !!entry.value;
                control.addEventListener("change", () => commit(control.checked));
            } else {
                control = document.createElement("input"); control.type = "text"; control.value = entry.value == null ? "" : String(entry.value); control.spellcheck = false;
                control.addEventListener("keydown", (e) => e.stopPropagation());
                control.addEventListener("change", () => commit(control.value));
            }
            lab.appendChild(control);
            list.appendChild(lab);
        }
    }

    /** Name of the result input the current mode expects, and whether something is wired to it. */
    /** Which result input the run will use: the mode's own, or the other one when only that is wired. */
    resultInputState() {
        return host.resultInputState(this);
    }

    resultInputStateFromGraph() {
        const want = this.genSettings.mode === "local" ? "result_local" : "result";
        const other = want === "result" ? "result_local" : "result";
        const wired = (name) => { const input = (this.node.inputs || []).find((i) => i.name === name); return !!(input && input.link != null); };
        if (wired(want)) return { name: want, wired: true, fallback: false };
        if (wired(other)) return { name: other, wired: true, fallback: true };
        return { name: want, wired: false, fallback: false };
    }

    syncGenControls() {
        this.syncBoxesRow();
        if (!this.modeSel) return;
        const local = this.genSettings.mode === "local";
        // the app adds a third mode, cloud (Comfy Cloud recipes); a mode the select lacks shows as api
        this.modeSel.value = this.genSettings.mode;
        if (this.modeSel.value !== this.genSettings.mode) this.modeSel.value = local ? "local" : "api";
        this.denoiseInput.value = this.genSettings.denoise;
        if (this.denoiseVal) this.denoiseVal.textContent = (+this.genSettings.denoise || 1).toFixed(2);
        this.seedInput.value = this.genSettings.seed;
        this.seedRandom.checked = !!this.genSettings.seedRandom;
        this.refineBtn.classList.toggle("ipc-toggle-on", !!this.genSettings.refine);
        this.refineBtn.hidden = !local;
        this.denoiseInput.parentElement.hidden = !local;
        // a Comfy Cloud graph takes the negative where it has one, as a local chain does; left empty, it keeps its own
        if (this.negativeInput) {
            const cloud = this.genSettings.mode === "cloud";
            this.negativeInput.hidden = !(local || cloud);
            if (this._negativeHint == null) this._negativeHint = this.negativeInput.placeholder;
            this.negativeInput.placeholder = cloud ? "Negative prompt. Left empty, the recipe's graph keeps its own negative." : this._negativeHint;
        }
    }

    /**
     * The Boxes switch under the prompt field (item 28 S3d): shown while the recipe sends boxes (host.boxSwitch), its
     * label counting the document's boxes; the hint says what goes while it is on (the selection, with no boxes) and
     * that the boxes stay home while it is off. The node always shows it (its host answers takes: the canvas output
     * box_prompt carries the boxes; the editor owns them there, inpaint_boxes.js).
     */
    syncBoxesRow() {
        if (!this.boxesRow) return;
        const s = host.boxSwitch(this);
        this.boxesRow.hidden = !(s && s.takes);
        if (!s) return;
        const on = !!this.genSettings.boxes;
        this.boxesCheck.checked = on;
        this.boxesLabel.textContent = s.count ? `Boxes · ${s.count}` : "Boxes";
        this.boxesHint.textContent = on ? (s.count ? "" : "the selection goes as one box") : (s.count ? "not sent" : "");
    }

    /** Drop the helper models from VRAM: ComfyUI's /free resets the executor, which releases the node instances holding them. */
    /**
     * Give the caches back: the filtered and matched copies, the masked layers, the
     * scratch canvases, the display pyramids and the compositor's textures. Everything
     * here is rebuilt on demand, so the only cost is the next frame; the pyramid comes
     * back one level per frame by design. `deep` also drops the GPU-side pool through
     * the hook the app sets (`releaseGpu`). `mirrors` also gives back the display canvases of
     * pixels on tiles (a cache of the tiles, made again and synced by the next frame that shows
     * them, which costs a putImageData per tile: for tabs that are not in front). Returns the bytes
     * it let go of.
     */
    releaseCaches({ deep = false, mirrors = false } = {}) {
        const px = (c) => (c && c.width ? c.width * c.height * 4 : 0);
        let freed = 0;
        const sources = [];
        for (const l of this.layers) {
            for (const slot of ["_fcache", "_fcacheView", "_fcacheSample", "_mcache", "_mcacheView", "_mcacheSample"]) {
                if (l[slot]) { freed += px(l[slot].canvas); l[slot] = null; }
            }
            l._fxCache = null;
            l._fxCacheView = null;
            l._fxCacheSample = null;
            l._mstats = null;
            l._mstatsSample = null;
            l._mstatsSampleRun = null;
            l._mstatsStack = null;
            l._mstatsStackRun = null;
            if (l._masked) { freed += px(l._masked); sources.push(l._masked); l._masked = null; l._maskedValid = false; }
            if (deep && l._relight) {
                if (l._relight.normals && l._relight.normals.data) freed += l._relight.normals.data.byteLength;
                if (l._relight.vis && l._relight.vis.data) freed += l._relight.vis.data.byteLength;
                if (l._relight.visQuick && l._relight.visQuick.data) freed += l._relight.visQuick.data.byteLength;
                if (l._relight.depthQuick && l._relight.depthQuick.data) freed += l._relight.depthQuick.data.byteLength;
                l._relight = null;
            }
            for (const p of [l.px, l.maskPx]) if (p) sources.push(displayCanvasIfMade(p));
        }
        for (const name of ["sceneCanvas", "viewCanvas", "flatCanvas", "filterMaskCanvas", "strokePreview", "maskPreview", "maskedPreview", "antsCanvas", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "_passView", "_passMaskView", "_filterMaskView", "_smudgeSrc", "_smudgeClip", "_smudgeTip", "_brushBytes", "_cloneDab", "_healDest", "_dabMask", "_blendScratchGpu", "_blendScratchCpu"]) {
            if (this[name]) { freed += px(this[name].c || this[name]); this[name] = null; }
        }
        if (this._brushRead) { for (const c of this._brushRead) if (c) freed += px(c); this._brushRead = null; }
        if (this._walkScratches) { for (const c of this._walkScratches.values()) freed += px(c); this._walkScratches = null; }
        releaseBoxBuffers();
        if (this.flatCache) { freed += px(this.flatCache.canvas); this.flatCache = null; }
        this.sceneSig = null;
        // the pyramids: their levels are exclusively theirs, the sources stay
        // the base's pixels only when they were built: asking basePx here would build them
        for (const src of [...sources, displayCanvasIfMade(this._basePx), displayCanvasIfMade(this.sel)]) {
            if (!src) continue;
            const entry = this.pyramids.get(src);
            if (!entry) continue;
            for (const lvl of entry.levels) freed += px(lvl);
            freed += px(entry.gpu);
            this.pyramids.delete(src);
        }
        if (this._compositor) {
            const st = this._compositor.stats ? this._compositor.stats() : null;
            if (st) freed += st.bytes + ((st.atlas && st.atlas.bytes) || 0);   // the source textures and the tile atlas
            this._compositor.clear();
        }
        if (mirrors) {
            // after the pyramids and the textures, which were keyed on these canvases; the caches
            // above that could hold one (_mcache*, flatCache) are gone too. The canvas backend's
            // display canvas is the pixels themselves and answers 0.
            for (const p of this.heldPixels()) freed += p.releaseDisplay();
        }
        if (deep && typeof this.releaseGpu === "function") { try { freed += this.releaseGpu() || 0; } catch (_) { /* no GPU path */ } }
        // the mips scheduler's buffers for its next batch (the module's, up to 32 MB): only while no chain is on its way (C6 b)
        if (this.tileMode) freed += chainScheduler().releasePool();
        // deliberately no draw: a background tab that redrew here would build every cache
        // straight back. The next draw (a gesture, or the tab coming forward) rebuilds
        // exactly what it needs; the caller redraws when the tab is the one in front.
        return freed;
    }

    /**
     * Every pixels object this editor holds: the layers' and masks', the base's (when built), the
     * selection, and what the undo and redo steps keep (rect copies, the layers of a layers / canvas
     * step). Each once.
     */
    heldPixels() {
        const out = new Set();
        const add = (p) => { if (p instanceof LayerPixels) out.add(p); };
        for (const l of this.layers) { add(l.px); add(l.maskPx); }
        add(this._basePx);
        add(this.sel);
        for (const list of [this.undo, this.redo, this.snapshots.map((s) => s.snap)]) {
            for (const st of list) {
                if (!st) continue;
                add(st.px);
                add(st.maskPx);   // on tiles: a mask / layerfull step's clone
                add(st.selPx);    // on tiles: a canvas step's selection
                add(st.base && st.base.px);   // a canvas step's base (C6 d: its pixels, where it held an <img>)
                for (const l of st.layers || []) { add(l.px); add(l.maskPx); }
                for (const p of st.pixels || []) { add(p && p.px); add(p && p.maskPx); }   // a turn step's and a named snapshot's clones
            }
        }
        return out;
    }

    /**
     * Every file ref (`{ filename, subfolder, type }`) the undo and redo steps and the named snapshots hold: a layer
     * record's `ref` and `maskRef` (layers, canvas and turn steps), a text's user font (`text.fontRef`, a text step's
     * too), a filter's LUT and grain plate, a canvas or turn step's base, the document maps' files, the plugins' data a
     * step keeps. An undo puts these back with their refs and uploads none of them again, so Settings › Local files ›
     * Clean up keeps them (the host's referencedFileKeys, and the node's referencedFiles); it removed them, and an undo across
     * the clean-up left a layer, a font or the whole picture naming a file the next start and the next save could not find.
     */
    heldFileRefs() {
        return this.fileRefsOf([...(this.undo || []), ...(this.redo || []), ...(this.snapshots || []).map((s) => s && s.snap)]);
    }

    /**
     * The file refs in these steps (undo steps, turn snapshots: the assistant's "Undo this turn" record asks too). Each
     * step is walked as data: plain objects and arrays, every object with a `filename` string being a ref, so a ref field
     * a later step adds is found too. Pixels, canvases, images, typed arrays and maps are class instances and are not
     * entered, nor the layers' `_` caches.
     */
    fileRefsOf(steps) {
        const out = [];
        const seen = new Set();
        const walk = (v, depth) => {
            if (!v || typeof v !== "object" || depth > 40 || seen.has(v)) return;
            const proto = Object.getPrototypeOf(v);
            const array = Array.isArray(v);
            if (!array && proto !== Object.prototype && proto !== null) return;
            seen.add(v);
            if (array) { for (const x of v) walk(x, depth + 1); return; }
            if (typeof v.filename === "string" && v.filename) out.push(v);
            for (const k of Object.keys(v)) if (k.charCodeAt(0) !== 95) walk(v[k], depth + 1);   // not the "_" caches
        };
        for (const st of steps || []) walk(st, 0);
        return out;
    }

    async freeHelperModels() {
        const freed = this.releaseCaches({ deep: true });
        const mb = Math.round(freed / 1048576);
        this.drawSoon();
        try { await host.freeHelpers(); } catch (err) { console.warn(err); }
        if (!host.connected) { this.helperUsed = false; this.setStatus(`Freed ${mb} MB of caches; the in-app helper models are unloaded too.`); return; }
        try {
            this.setStatus(`Freed ${mb} MB of caches. Freeing helper models (SAM, Qwen-VL) from VRAM ...`);
            const r = await api.fetchApi("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
            if (r.status !== 200) throw new Error("/free answered " + r.status);
            this.helperUsed = false;
            this.setStatus(`Freed ${mb} MB of caches; the helper models are out of VRAM too.`);
        } catch (err) {
            console.warn("Inpaint Canvas: could not free models", err);
            this.setStatus("Could not free the helper models: " + (err.message || err), failKind(err));
        }
    }

    /**
     * Generate with the host's recipe. `opts` (the app's Each area, eacharea.js; the button and Ctrl+Enter pass none):
     * `refs` a reference snapshot to send instead of the one of now, `area` one area of the selection to run on instead of
     * the selection itself (the host reads it in place of `this.sel`; the document's selection is never touched).
     */
    async generate(opts = {}) {
        this.lastRunError = null;
        if (!this.base) { this.setStatus("Load an image first."); return; }
        // One API run per document: the host holds `providerPending` until its result has landed, and the button stays
        // disabled while the run is awaited. Ctrl+Enter (the editor's keys and the prompt field) reaches here directly, so
        // a run that needs that slot (the host's resultInputState says `provider`) is refused here, before the seed is
        // rolled or the button freed under the first run. A recipe on the user's ComfyUI takes no slot and keeps
        // queueing (ComfyUI queues on purpose), also while a 1× pass or a selection's upscale holds it; not while a run
        // whose landing resizes the document holds it (`resizes`: an upscale of the whole picture, the Realism Pass
        // above 1×), whose result would land in the old geometry. The node's host has no slot.
        const area = (opts && opts.area) || null;
        // the app's Each area (eacharea.js) runs its areas one by one on this document: a Generate of the whole selection
        // meanwhile would land among them (and on the user's ComfyUI hold up the next area)
        if (!area && this._eachArea) {
            this.lastRunError = new Error("Each area is running on this document: wait for it, or stop it.");
            this.setStatus(this.lastRunError.message, "info");
            return { error: this.lastRunError };
        }
        if (this.providerPending && (this.resultInputState().provider || this.providerPending.resizes)) {
            this.lastRunError = new Error(RUN_GOING_TEXT);
            this.setStatus(this.lastRunError.message, "info");
            return { error: this.lastRunError };
        }
        // the prompt and the references as they are at the click (docs/PLAN_REFS.md C3): a later hide or move does not
        // change what this run sends
        const refs = (opts && opts.refs) || this.refSnapshot();
        if (this.removePending || this.healPending || this.liquifyPending) { this.setStatus("Waiting for the stroke to land..."); await this.heldEdit(); }
        if (this.genSettings.seedRandom) { this.genSettings.seed = randomSeed(); if (this.seedInput) this.seedInput.value = this.genSettings.seed; }
        const { name, wired } = this.resultInputState();
        try {
            this.generateBtn.disabled = true;
            // Local mode: the helper models (Qwen-VL, SAM3, SAM2, RMBG) keep their weights inside their node
            // instances, invisible to ComfyUI's model management. Before a local run they are freed, so a big
            // model such as Flux.2 gets the whole card; in API mode they simply stay resident.
            if (this.genSettings.mode === "local" && this.helperUsed) await this.freeHelperModels();
            this.setStatus(wired ? `Queueing (${this.genSettings.mode}, seed ${this.genSettings.seed}, result from ${name}) ...` : `Queueing, but nothing is wired into "result" or "result_local": the result will not come back into the canvas.`);
            await host.queueGenerate(this, area ? { refs, area } : { refs });
        } catch (err) {
            console.error(err);
            // kept for the app's generate command, which throws it at once; also returned, so a caller gets its own run's
            this.lastRunError = err instanceof Error ? err : new Error(String(err));
            this.setStatus(String(err.message || err), failKind(err));
            return { error: this.lastRunError };
        } finally {
            this.generateBtn.disabled = false;
            if (this.isOpen) this.root.focus({ preventScroll: true });
        }
    }

    // ---- persistence -------------------------------------------------------

    notifyChanged() {
        if (this.boxes) this.boxes.refresh();   // a box written, an undo or redo of one, a restored workflow
        host.changed(this);
    }

    /** Encode the selection PNG for getValue off the main thread and save again when it lands. */
    encodeSelectionSoon() {
        if (this._selEncoding) return;
        this._selEncoding = true;
        const seq = this.selectionSeq;
        const sel = this.sel;   // a replaced selection is a new object: its PNG is not stored
        // E5: on tiles the PNG holds the box the selection's tiles cover (`selectionBox` says where it goes), read from the
        // tiles; a box too large for a canvas (an inverted selection of a huge document) is the whole mask written in
        // parts by the pool. It was `sel.toCanvas()`: a canvas of the whole image for every change of the selection
        // (600 MB at 15000 x 10000), and nothing at all above the canvas limit.
        let blobOf, box = null;
        try {
            const ext = isTilePixels(sel) ? sel.bounds() : null;
            if (isTilePixels(sel) && !ext) {
                this._selEncoding = false;
                this.selectionDataUrl = null; this.selectionBox = null;
                if (seq === this.selectionSeq) this.selectionEncoded = true;
                return;
            }
            if (ext && (ext[2] - ext[0]) * (ext[3] - ext[1]) <= SEL_BOX_MAX_PX) {
                box = [ext[0], ext[1], ext[2] - ext[0], ext[3] - ext[1]];
                const c = document.createElement("canvas");
                c.width = box[2]; c.height = box[3];
                c.getContext("2d", { willReadFrequently: true }).putImageData(sel.readRect(box[0], box[1], box[2], box[3]), 0, 0);
                blobOf = canvasToBlob(c).finally(() => { c.width = 1; c.height = 1; });
            } else if (ext) {
                blobOf = encodeTilePixels(sel).then((r) => { if (!r) throw new Error("the selection is too large to be saved without the worker pool"); return r.blob; });
            } else {
                blobOf = canvasToBlob(sel.toCanvas());
            }
        } catch (err) {
            this._selEncoding = false;
            console.warn("Inpaint Canvas: selection encode failed", err);
            return;
        }
        blobOf
            .then((blob) => new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = () => rej(r.error);
                r.readAsDataURL(blob);
            }))
            .then((url) => {
                this._selEncoding = false;
                if (sel !== this.sel) return;
                this.selectionDataUrl = url;
                this.selectionBox = box;
                if (seq === this.selectionSeq) {
                    this.selectionEncoded = true;
                    this.notifyChanged();   // save again, now with the fresh selection
                } else {
                    this.encodeSelectionSoon();
                }
            })
            .catch((err) => { this._selEncoding = false; console.warn("Inpaint Canvas: selection encode failed", err); });
    }

    /**
     * What this editor holds in pixels, as plain data (bytes are w * h * 4, the backing
     * store of a canvas). Nothing here allocates or frees; it is the input of
     * tools/mem_test.py and of the memory work in the app's docs/PERFORMANCE.md.
     * The GPU filter chain is app-only and is asked separately (glPoolStats()).
     *
     * Pixels on tiles (docs/PLAN_BCE.md §C2 step b) are reported under the same slot names with
     * `tiles` and the bytes of their allocated tiles, a tile shared copy-on-write by several
     * pixels objects counted once (the first holder in the order layers, base, selection, undo);
     * their display mirror, where one was made, is a slot of its own ("mirror", a canvas of the
     * pixels' size in renderer memory). `tiles` at the top sums both.
     */
    memoryReport() {
        const px = (c) => (c && c.width ? c.width * c.height * 4 : 0);
        const seen = new Set();          // one canvas (or tile) counted once, however many slots hold it
        const add = (into, name, c) => {
            if (!c || !c.width) return;
            const bytes = px(c);
            into.push({ name, w: c.width, h: c.height, bytes, shared: seen.has(c) });
            seen.add(c);
        };
        const tileSum = { pixels: 0, tiles: 0, bytes: 0, sharedTiles: 0, chains: 0, chainBytes: 0, mirrors: 0, mirrorBytes: 0, thumbnails: 0, thumbnailBytes: 0, regions: 0, regionBytes: 0, primedBytes: 0 };
        // the mip chains a tile keeps and its edge copy (C6 b): a buffer a copy on write shares is counted once
        const chainSeen = new Set();
        const addChains = (t) => {
            for (const b of [t.mips, t.edge && t.edge.mips, t.edge && t.edge.data]) {
                if (!b || chainSeen.has(b.buffer)) continue;
                chainSeen.add(b.buffer);
                tileSum.chains++; tileSum.chainBytes += b.byteLength;
            }
        };
        // the tiles of `p` no slot counted yet: [tiles, bytes, tiles counted before]
        const newTiles = (p, skip = null) => {
            let n = 0, bytes = 0, old = 0;
            for (const t of p.tileList()) {
                if (seen.has(t) || (skip && skip.has(t))) { old++; continue; }
                seen.add(t);
                n++;
                bytes += t.data.byteLength;
                addChains(t);
            }
            return [n, bytes, old];
        };
        // a pixels object into `into` under `name`: its backing canvas, or its new tiles plus its mirror
        const addPixels = (into, name, p) => {
            if (!p) return;
            if (!isTilePixels(p)) { add(into, name, canvasOf(p)); return; }
            const [n, bytes, old] = newTiles(p);
            tileSum.pixels++; tileSum.tiles += n; tileSum.bytes += bytes; tileSum.sharedTiles += old;
            // the cells of a primed exact read still in flight (C6 c3); zero unless one is reading right now
            if (p.primedBytes) tileSum.primedBytes += p.primedBytes();
            into.push({ name, w: p.width, h: p.height, tiles: n, sharedTiles: old, bytes, shared: false });
            const m = p.displayCanvasIfMade();
            if (m && m.width && !seen.has(m)) { tileSum.mirrors++; tileSum.mirrorBytes += px(m); }
            add(into, name === "canvas" ? "mirror" : name + "Mirror", m);
            const th = p.thumbnailCanvasIfMade();
            if (th && th.width && !seen.has(th)) { tileSum.thumbnails++; tileSum.thumbnailBytes += px(th); }
            add(into, name === "canvas" ? "thumbnail" : name + "Thumbnail", th);
            // the part of the pixels a view shows, at a level, from the tiles' mips (C3: what the
            // selection's overlay draws instead of a mirror of the whole mask)
            for (const rg of (p.regionCanvasesIfMade ? p.regionCanvasesIfMade() : [])) {
                if (!rg || !rg.width || seen.has(rg)) continue;
                tileSum.regions++; tileSum.regionBytes += px(rg);
                add(into, name === "canvas" ? "region" : name + "Region", rg);
            }
        };
        const sum = (list) => list.reduce((a, e) => a + (e.shared ? 0 : e.bytes), 0);

        // layers, and the sources whose pyramids we can find again
        const sources = [];
        const layers = [];
        for (const l of this.layers) {
            const own = [];
            // the backing canvases, so a colour-match cache that holds the layer's own canvas is counted once
            const lc = displayCanvasIfMade(l.px), mc = displayCanvasIfMade(l.maskPx);
            addPixels(own, "canvas", l.px);
            addPixels(own, "mask", l.maskPx);
            add(own, "_masked", l._masked);
            for (const slot of ["_fcache", "_fcacheView", "_fcacheSample", "_mcache", "_mcacheView", "_mcacheSample"]) {
                const c = l[slot] && l[slot].canvas;
                add(own, slot, c);
            }
            for (const c of [lc, mc, l._masked, l._mcache && l._mcache.canvas, l._mcacheView && l._mcacheView.canvas, l._mcacheSample && l._mcacheSample.canvas]) if (c) sources.push(c);
            layers.push({ id: l.id, name: l.name, kind: l.kind, w: l.w, h: l.h, bytes: sum(own), slots: own });
        }
        // the base's pixels only when they were built (basePx would build them)
        for (const c of [displayCanvasIfMade(this._basePx), displayCanvasIfMade(this.sel)]) if (c) sources.push(c);

        // pyramids: a WeakMap cannot be walked, so ask it for every source we know of
        const pyramid = [];
        for (const src of sources) {
            const entry = this.pyramids.get(src);
            if (!entry || (!entry.levels.length && !entry.gpu)) continue;
            let bytes = 0, levels = 0;
            for (const lvl of entry.levels) if (lvl && lvl.width) { bytes += px(lvl); levels++; }
            // the screen's GPU copy of a tile mirror (displaySource's `screen`)
            const gpuBytes = px(entry.gpu);
            pyramid.push({ w: src.width, h: src.height, levels, bytes: bytes + gpuBytes, gpuCopyBytes: gpuBytes });
        }

        // the scratch canvases the editor keeps between frames, the base and the selection first:
        // their tiles are counted before the undo steps that share them
        const scratch = [];
        addPixels(scratch, "_baseCanvas", this._basePx);   // the name mem_test and the docs know
        addPixels(scratch, "selection", this.sel);
        for (const name of ["sceneCanvas", "viewCanvas", "flatCanvas", "strokePreview", "maskPreview", "maskedPreview", "antsCanvas", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "filterMaskCanvas", "_passView", "_passMaskView", "_filterMaskView"]) add(scratch, name, this[name]);
        add(scratch, "flatCache", this.flatCache && this.flatCache.canvas);

        // undo / redo: the rect copies plus the canvases (or tiles) the "layers" / "canvas" snapshots
        // hold that the live document does not
        const live = new Set();
        for (const l of this.layers) {
            for (const p of [l.px, l.maskPx]) {
                if (!p) continue;
                if (isTilePixels(p)) { for (const t of p.tileList()) live.add(t); const m = p.displayCanvasIfMade(); if (m) live.add(m); } else live.add(canvasOf(p));
            }
        }
        const undoSeen = new Set();
        // bytes of pixels a step holds that neither the live layers nor an earlier step hold
        const heldBytes = (p) => {
            if (!p) return 0;
            if (!isTilePixels(p)) {
                const c = canvasOf(p);
                if (!c || !c.width || live.has(c) || undoSeen.has(c) || seen.has(c)) return 0;
                undoSeen.add(c);
                return px(c);
            }
            let bytes = 0;
            for (const t of p.tileList()) {
                if (live.has(t) || undoSeen.has(t) || seen.has(t)) continue;
                undoSeen.add(t);
                bytes += t.data.byteLength;
                tileSum.tiles++; tileSum.bytes += t.data.byteLength;
                addChains(t);
            }
            const m = p.displayCanvasIfMade();
            if (m && m.width && !live.has(m) && !undoSeen.has(m) && !seen.has(m)) { undoSeen.add(m); bytes += px(m); tileSum.mirrors++; tileSum.mirrorBytes += px(m); }
            tileSum.pixels++;
            return bytes;
        };
        const walkSteps = (list) => {
            const kinds = {};
            let bytes = 0, held = 0;
            for (const s of list) {
                if (!s) continue;
                kinds[s.kind] = (kinds[s.kind] || 0) + 1;
                if (s.kind === "layerrect" || s.kind === "selection") bytes += heldBytes(s.px) + (s.parts || []).reduce((n, q) => n + heldBytes(q.px), 0);   // a rect / selection step's pixels copy (a move's two)
                else held += heldBytes(s.px);   // on tiles: a whole-layer step's clone (its tiles the live layers do not hold)
                held += heldBytes(s.maskPx) + heldBytes(s.selPx) + heldBytes(s.base && s.base.px);
                for (const l of s.layers || []) {
                    // snapshot copies are spreads: they carry px / maskPx, not the aliases
                    held += heldBytes(l.px) + heldBytes(l.maskPx);
                    if (l._masked && l._masked.width && !live.has(l._masked) && !undoSeen.has(l._masked)) { undoSeen.add(l._masked); held += px(l._masked); }
                }
                for (const p of s.pixels || []) held += heldBytes(p && p.px) + heldBytes(p && p.maskPx);   // a turn step's and a named snapshot's clones
            }
            return { steps: list.length, kinds, rectBytes: bytes, heldLayerBytes: held };
        };
        const undo = { budget: this.undoBytes, undo: walkSteps(this.undo || []), redo: walkSteps(this.redo || []), snapshots: walkSteps((this.snapshots || []).map((s) => s.snap)) };

        const comp = this._compositor && this._compositor.stats ? this._compositor.stats() : null;
        const pool = this.tileMode ? scratchStats() : null;
        const mapsReport = {};
        let mapsBytes = 0;
        if (this.maps) {
            for (const [k, m] of Object.entries(this.maps)) {
                if (!m) continue;
                const b = (m.data ? m.data.byteLength : 0) + (m.guide ? m.guide.byteLength : 0);
                mapsBytes += b;
                mapsReport[k] = { w: m.w, h: m.h, bytes: b, version: m.version, dataVersion: m.dataVersion, guide: !!m.guide };
            }
        }
        return {
            id: this.node && this.node.id,
            size: [this.width, this.height],
            tileMode: this.tileMode,
            // tile bytes and mirrors of every pixels object above; the scratch pool is the module's, shared by all editors
            tiles: this.tileMode ? { ...tileSum, tileSize: TILE_SIZE, scratchPoolBytes: pool.poolPixels * 4, chainPoolBytes: chainScheduler().pool.length * TILE_SIZE * TILE_SIZE * 4 } : null,
            layers: { count: layers.length, bytes: layers.reduce((a, l) => a + l.bytes, 0), list: layers },
            pyramid: { sources: pyramid.length, levels: pyramid.reduce((a, p) => a + p.levels, 0), bytes: pyramid.reduce((a, p) => a + p.bytes, 0), list: pyramid },
            undo,
            compositor: comp,
            objects: this.objects && this.objects.ids ? { w: this.objects.w, h: this.objects.h, bytes: this.objects.ids.byteLength } : null,
            maps: { count: Object.keys(mapsReport).length, bytes: mapsBytes, kinds: mapsReport },
            scratch: { bytes: sum(scratch), list: scratch },
        };
    }

    destroy() {
        this._destroyed = true;
        if (this.runProgress) this.runProgress.clear();   // its one-second ticker
        this._mapUndoPending = null;
        clearTimeout(this._refLayTimer);
        if (this._compositor) { try { this._compositor.dispose(); } catch (_) { /* context gone */ } this._compositor = null; }
        this.close();
        this.closeFlyout();
        this.dropFlyoutListener();   // close() returns early for an editor that is not open
        this.closeAsk();
        if (this.promptField) this.promptField.destroy();   // its document listener and the context callback
        // after close(), which commits an open text edit: that step's blob URL is revoked with the rest
        this.clearUndo();   // the blob URLs of the whole-layer steps are revoked, not left behind
        this.clearSnapshots();
        try { this.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
        try { this.thumbObserver.disconnect(); } catch (_) { /* ignore */ }
    }
}
installParts(InpaintEditor, [PanelsPart, LayersPart, HistoryPanelPart, TextPart, TipsPart, HealPart, LiquifyPart, ShapePart, SelectPart, StackPart, SegmentPart, MasksPart, GeometryPart, PointerPart, DepthPart, FiltersPart, HistoryPart, PersistPart, ExportPart, OpenPart, StrokesPart, DisplayPart, CompositePart, MatchPart, DrawPart, RelightPart, ChromePart, ViewPart, RefsPart]);
bindDisplay(InpaintEditor);
bindComposite(InpaintEditor);
bindExport(InpaintEditor);
bindOpen(InpaintEditor);
bindStrokes(InpaintEditor);
bindSelect(InpaintEditor);
bindStack(InpaintEditor);
bindHeal(InpaintEditor);
bindLiquify(InpaintEditor);
bindShape(InpaintEditor);
bindLoad(InpaintEditor);

// everything the hosts use: Scumble's shell, commands and plugins, the node's extension (js/inpaint_node.js)
export { InpaintEditor, BLEND_MODES, DISSOLVE_SHADER, DISSOLVE_CLIP_SHADER, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, TAIL_OUTPUTS, NODE_CLASS, STITCH_CLASS, isSettingOutput, settingIndex, linkOf, el, icon, iconButton, miniButton, selectInput, selectGrouped, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, STYLE, RELIGHT_STYLES, RELIGHT_LIGHT_TYPES, BRUSH_MAX, brushSizeToSlider, sliderToBrushSize };
