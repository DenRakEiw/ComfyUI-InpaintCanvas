// Generated from DenRakEiw/scumble renderer/editor/inpaint_modal.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The editor's dialog, built once per document: buildEditorModal() puts the top bar, the tool
// column, the canvas and the side panel together, and one function per panel fills it. Moved here
// from InpaintEditor.buildModal() on 2026-09-20 (CLAUDE.md, the split of inpaint_canvas.js); the
// code is the method's, with `this` as the `ed` parameter. Every function writes its elements onto
// the editor, as the method did: they are construction, not state of their own.
import { host } from "./host.js";
import { el, iconButton, miniButton, selectInput, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed, brushSizeToSlider, sliderToBrushSize } from "./inpaint_canvas.js";
import { selModeOf } from "./inpaint_raster.js";
import { PromptField, RefBar } from "./prompt_field.js";
import { buildRangeBar } from "./inpaint_rangebar.js";

/**
 * The whole dialog of one editor. The order is the one the method had, and the two joints it kept
 * in local variables are passed on: `root` and `body` hold the parts, and the side panel's
 * `section` adds a block to the tab that is current.
 */
export function buildEditorModal(ed) {
    const root = el("div", "ipc-modal");
    root.tabIndex = 0;
    ed.root = root;

    buildTopBar(ed, root);

    // body
    const body = el("div", "ipc-body");
    buildTools(ed, body);
    buildView(ed, body);

    const { side, section, toGenPane } = buildSidePanel(ed);
    buildLayers(ed);
    buildReferences(ed);
    buildUndoHistory(ed, section);
    buildSelection(ed, section);
    buildCanvasPanel(ed, section);
    buildExport(ed, section);
    toGenPane();
    buildPrompt(ed, section);
    buildGenerate(ed, section);
    buildSettings(ed, section);
    buildHistory(ed, section);
    buildCrop(ed, section);

    let paneId = "image";
    try { paneId = localStorage.getItem("ipc.pane") || "image"; } catch (_) { /* no storage */ }
    ed.showPane(paneId);
    body.appendChild(side);
    root.appendChild(body);

    const bottom = el("div", "ipc-bottom");
    ed.statusEl = el("span", null, ed.status);
    bottom.appendChild(ed.statusEl);
    bottom.appendChild(el("span", "ipc-kbd", host.overlay ? "Wheel: zoom · Space/middle: pan · [ ]: size · Esc: close" : "Wheel: zoom · Space/middle: pan · [ ]: size · Ctrl+Enter: generate"));
    root.appendChild(bottom);

    ed.bindEvents();
    ed.setTool("select");
    ed.renderLayers();
    ed.renderHistory();
    ed.renderInfo();
    ed.resizeObserver = new ResizeObserver(() => ed.resizeCanvas());
    ed.resizeObserver.observe(ed.viewEl);
    host.editorBuilt(ed);
}

/** The top bar: file buttons, the brush controls, the tip, the view toggles, the mode select and Generate. */
function buildTopBar(ed, root) {
    // top bar
    const top = el("div", "ipc-top");
    if (host.overlay) top.appendChild(el("span", "ipc-title", "Inpaint Canvas"));
    ed.fileInput = document.createElement("input");
    ed.fileInput.type = "file";
    ed.fileInput.accept = "image/*,.tif,.tiff";
    ed.fileInput.style.display = "none";
    ed.fileInput.addEventListener("change", () => {
        const f = ed.fileInput.files && ed.fileInput.files[0];
        if (f) ed.loadFile(f);
        ed.fileInput.value = "";
    });
    top.appendChild(ed.fileInput);
    top.appendChild(iconButton("newfile", "New: an empty white canvas. Everything in this editor (layers, results, selection, history) is discarded; you are asked first.", () => ed.newCanvas(), "New"));
    if (host.generateNewAvailable && host.generateNewAvailable()) {
        top.appendChild(iconButton("sparkle", "Generate new: make the base image from the prompt alone, no image needed. Model, size and seed are in the dialog.", () => host.openGenerateNew(ed), "Generate new"));
    }
    top.appendChild(iconButton("load", "Load an image as the base layer (Ctrl+drop replaces the image; a plain drop adds a layer)", () => ed.fileInput.click(), "Load"));
    top.appendChild(iconButton("save", "Save the finished image (Ctrl+S): all visible layers with their filters, without control and reference layers, into ComfyUI's output folder. Name and format in the Canvas section.", () => ed.exportImage(), "Save"));

    const slider = (label, min, max, value, fmt, onInput) => {
        const lab = el("label", null, label);
        const inp = document.createElement("input");
        inp.type = "range"; inp.min = min; inp.max = max; inp.value = value;
        const val = el("span", null, fmt(value));
        inp.addEventListener("input", () => { onInput(+inp.value); val.textContent = fmt(+inp.value); });
        lab.appendChild(inp); lab.appendChild(val);
        top.appendChild(lab);
        return { input: inp, value: val };
    };
    // the slider is logarithmic (BRUSH_MAX px at its end, inpaint_canvas.js): its position is not the size
    ed.sizeCtl = slider("Size", 0, 1000, brushSizeToSlider(ed.brushSize), (v) => sliderToBrushSize(v) + "px", (v) => { ed.brushSize = sliderToBrushSize(v); ed.draw(); });
    ed.sizeCtl.value.textContent = ed.brushSize + "px";
    ed.hardCtl = slider("Hardness", 0, 100, Math.round(ed.hardness * 100), (v) => v + "%", (v) => {
        // the slider edits the hardness of the active tool: the eraser has its own
        if (ed.tool === "erase") ed.eraseHardness = v / 100; else ed.hardness = v / 100;
        try { localStorage.setItem(ed.tool === "erase" ? "ipc.eraseHardness" : "ipc.hardness", String(v / 100)); } catch (_) { /* ignore */ }
    });
    ed.hardCtl.input.title = "Brush hardness. The eraser keeps its own value (soft by default); the slider shows the active tool's.";
    ed.opacCtl = slider("Opacity", 1, 100, 100, (v) => v + "%", (v) => { ed.brushOpacity = v / 100; });
    // flow builds a stroke up where it passes again (the stroke buffer is 8 bits: below 5 % it would not reach full cover)
    ed.flowCtl = slider("Flow", 5, 100, 100, (v) => v + "%", (v) => { ed.brushFlow = v / 100; });
    ed.flowCtl.input.title = "Flow: how much paint each dab lays down; below 100 % a stroke builds up where it overlaps itself. Opacity caps the whole stroke.";

    const colorLabel = el("label", null, "Color");
    ed.colorLabel = colorLabel;
    ed.colorInput = document.createElement("input");
    ed.colorInput.type = "color";
    ed.colorInput.value = ed.color;
    ed.colorInput.title = "Paint color";
    ed.colorInput.addEventListener("input", () => { ed.color = ed.colorInput.value; });
    colorLabel.appendChild(ed.colorInput);
    top.appendChild(colorLabel);

    // brush tip: the built-in round dab, or a stamp imported from a .abr or an image
    const tipLabel = el("label", null, "Tip");
    ed.tipLabel = tipLabel;
    ed.tipThumb = document.createElement("canvas");
    ed.tipThumb.width = 48; ed.tipThumb.height = 24;
    ed.tipThumb.className = "ipc-tipthumb";
    ed.tipThumb.style.width = "48px"; ed.tipThumb.style.height = "24px"; ed.tipThumb.style.position = "static";   // .ipc-view canvas is absolute and 100 %
    // the thumbnail opens the tip popover (every tip with a stroke preview, the recent ones, a search); it is the label's
    // first control, so a click on "Tip" opens it too
    ed.tipBtn = el("button", "ipc-tipbtn");
    ed.tipBtn.type = "button";
    ed.tipBtn.title = "The tip that will land on the canvas. Click for all tips with a stroke preview, the recent ones and a search.";
    ed.tipBtn.setAttribute("aria-haspopup", "dialog");
    ed.tipBtn.appendChild(ed.tipThumb);
    ed.tipBtn.appendChild(el("span", "ipc-caret", "▾"));
    ed.tipBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ed.toggleTipPicker(); });
    tipLabel.appendChild(ed.tipBtn);
    ed.tipSel = selectInput(["Round"], "Round", "The brush tip. Round is the built-in soft dab; the others were imported from a .abr or an image file.");
    ed.tipSel.addEventListener("change", () => ed.setBrushTip(ed.tipSel.value === "Round" ? "" : ed.tipSel.value));
    tipLabel.appendChild(ed.tipSel);
    ed.tipFile = document.createElement("input");
    ed.tipFile.type = "file";
    ed.tipFile.accept = ".abr,.png,.jpg,.jpeg,.webp";
    ed.tipFile.multiple = true;
    ed.tipFile.style.display = "none";
    ed.tipFile.addEventListener("change", () => { const f = Array.from(ed.tipFile.files || []); ed.tipFile.value = ""; ed.importBrushFiles(f); });
    tipLabel.appendChild(ed.tipFile);
    tipLabel.appendChild(iconButton("upload", "Import brush tips from a Photoshop .abr file or from images. A .abr may hold dozens of tips; all of them are added.", () => ed.tipFile.click(), "Import"));
    ed.tipRemoveBtn = iconButton("trash", "Remove this tip from the list", () => ed.removeBrushTip(ed.brushTipId));
    tipLabel.appendChild(ed.tipRemoveBtn);
    // the tip's own settings, shown while an imported tip is active (the round dab has hardness instead)
    const spacingLabel = el("label", null, "Spacing");
    ed.spacingCtl = document.createElement("input");
    ed.spacingCtl.type = "range"; ed.spacingCtl.min = 1; ed.spacingCtl.max = 200; ed.spacingCtl.value = 25;
    ed.spacingCtl.title = "Distance between stamps as a share of the tip's size; a .abr brings its own value";
    const spacingVal = el("span", null, "25%");
    ed.spacingCtl.addEventListener("input", () => { spacingVal.textContent = ed.spacingCtl.value + "%"; const t = ed.brushTip(); if (t) { t.spacing = +ed.spacingCtl.value / 100; ed._tipStamp = null; } });
    ed.spacingCtl.addEventListener("change", () => ed.brushTipsChanged());
    ed.spacingVal = spacingVal;
    spacingLabel.appendChild(ed.spacingCtl); spacingLabel.appendChild(spacingVal);
    const rotateLabel = el("label", null);
    ed.tipRotateCb = document.createElement("input");
    ed.tipRotateCb.type = "checkbox";
    ed.tipRotateCb.title = "Rotate the tip to follow the stroke direction, the way a flat brush turns in the hand";
    ed.tipRotateCb.addEventListener("change", () => { ed.tipRotate = ed.tipRotateCb.checked; try { localStorage.setItem("ipc.tipRotate", ed.tipRotate ? "1" : "0"); } catch (_) { /* ignore */ } });
    try { ed.tipRotate = localStorage.getItem("ipc.tipRotate") === "1"; } catch (_) { ed.tipRotate = false; }
    ed.tipRotateCb.checked = !!ed.tipRotate;
    rotateLabel.appendChild(ed.tipRotateCb); rotateLabel.appendChild(el("span", null, "Follow stroke"));
    ed.tipOnlyEls = [spacingLabel, rotateLabel];
    top.appendChild(tipLabel); top.appendChild(spacingLabel); top.appendChild(rotateLabel);
    // view toggles
    const viewBox = el("span", "ipc-viewbox");
    ed.rulersBtn = iconButton("ruler", "Rulers (Ctrl+Shift+R). Drag a guide out of a ruler; drag it back to remove it; double-click a ruler clears all guides. Layers snap to guides.", () => ed.toggleRulers());
    ed.rulersBtn.classList.toggle("ipc-toggle-on", ed.showRulers);
    viewBox.appendChild(ed.rulersBtn);
    ed.gridBtn = iconButton("grid", "Grid (Ctrl+Shift+G): lines every 64 px", () => ed.toggleGrid());
    ed.gridBtn.classList.toggle("ipc-toggle-on", ed.showGrid);
    viewBox.appendChild(ed.gridBtn);
    ed.peekBtn = iconButton("peek", "Before / after: the base image without any layer. Hold \\ for a quick look, click to toggle.", () => { ed.peekBase = !ed.peekBase; ed.peekHold = false; ed.peekBtn.classList.toggle("ipc-toggle-on", ed.peekBase); ed.draw(); });
    viewBox.appendChild(ed.peekBtn);
    viewBox.appendChild(iconButton("fit", "Fit to view (F); 1 shows 100 %", () => ed.fitView()));
    top.appendChild(viewBox);

    top.appendChild(el("span", "ipc-grow"));
    ed.modeSel = selectInput(["api", "local"], "api", "Which chain the result comes back from: API = the result input, Local = the result_local input. Only that chain runs.");
    ed.modeSel.classList.add("ipc-mode");
    ed.modeSel.addEventListener("change", () => { ed.genSettings.mode = ed.modeSel.value; ed.syncGenControls(); ed.renderInfo(); ed.notifyChanged(); host.modeChanged(ed, ed.modeSel.value); });
    top.appendChild(ed.modeSel);
    ed.generateBtn = iconButton("play", "Queue the workflow (Ctrl+Enter). The result comes back as a new layer.", () => ed.generate(), "Generate");
    ed.generateBtn.classList.add("ipc-primary");
    top.appendChild(ed.generateBtn);
    if (host.overlay) {
        // over the graph the editor needs its own way out; in the app it is the window
        const closeBtn = iconButton("close", "Close editor (Esc)", () => ed.close());
        closeBtn.classList.add("ipc-danger");
        top.appendChild(closeBtn);
    }
    root.appendChild(top);
}

/** The tool column: one button per tool, the groups with their flyouts, undo / redo and flatten. */
function buildTools(ed, body) {
    const tools = el("div", "ipc-tools");
    ed.toolsEl = tools;
    ed.toolButtons = {};
    const addTool = (id, title) => {
        const b = iconButton(id, title, () => ed.setTool(id));
        ed.toolButtons[id] = b;
        tools.appendChild(b);
    };
    ed._addTool = addTool;
    // Tool groups: one button per family, the button shows the family's current tool; hover,
    // right-click or hold opens the flyout with all of them (Photoshop / Krita style).
    ed.toolGroups = [];
    ed.toolGroupOf = {};
    const addGroup = (items, actions = []) => {
        const g = { items, tools: items.map((i) => i.tool), current: items[0].tool, actions, btn: null };
        const btn = el("button", "ipc-ib ipc-groupbtn");
        btn.type = "button";
        // click: the group's current tool at once. The flyout opens on right-click, on holding the
        // button (300 ms) or on a click on the corner triangle; it never opens on hover, so moving
        // down the column stays quiet.
        btn.addEventListener("click", (e) => {
            e.stopPropagation(); e.preventDefault();
            clearTimeout(g._hold);
            if (g._held) { g._held = false; return; }
            const r = btn.getBoundingClientRect();
            if (e.clientX > r.right - 12 && e.clientY > r.bottom - 12) { ed.openFlyout(g, btn); return; }
            ed.closeFlyout();
            ed.setTool(g.current);
        });
        btn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ed.openFlyout(g, btn); });
        btn.addEventListener("pointerdown", (e) => { if (e.button === 0) { g._held = false; g._hold = setTimeout(() => { g._held = true; ed.openFlyout(g, btn); }, 300); } });
        btn.addEventListener("pointerup", () => clearTimeout(g._hold));
        btn.addEventListener("pointerleave", () => clearTimeout(g._hold));
        g.btn = btn;
        ed.toolGroups.push(g);
        for (const it of items) ed.toolGroupOf[it.tool] = g;
        tools.appendChild(btn);
        ed.refreshGroupButton(g);
        return g;
    };

    tools.appendChild(el("div", "ipc-grp", "Select"));
    addGroup([
        { tool: "select", label: "Selection brush", key: "B", title: "Paint selection (B): adds to the selection, Alt subtracts" },
        { tool: "deselect", label: "Deselect brush", key: "D", title: "Erase from selection (D)" },
    ], [
        { icon: "loop", label: "Close loops", title: "Close loops: end a brush stroke where it started and the inside is filled too. Also for the subtract brush.", toggle: () => ed.fillEnclosed, onClick: () => { ed.fillEnclosed = !ed.fillEnclosed; ed.setStatus(ed.fillEnclosed ? "Close loops on: end a stroke where it started to fill the inside." : "Close loops off."); } },
    ]);
    addGroup([
        { tool: "rect", label: "Rectangle", key: "R", title: "Rectangle selection (R): replaces the selection, Shift adds, Alt subtracts, Shift+Alt intersects, Ctrl keeps it square. Drag inside an existing selection to move its outline." },
        { tool: "ellipse", label: "Ellipse", key: "Shift+R", title: "Ellipse selection (Shift+R): replaces the selection, Shift adds, Alt subtracts, Shift+Alt intersects, Ctrl keeps it a circle. Drag inside an existing selection to move its outline." },
        { tool: "lasso", label: "Lasso", key: "L", title: "Lasso selection (L): replaces the selection, Shift adds, Alt subtracts, Shift+Alt intersects" },
        { tool: "polygon", label: "Polygon", key: "Shift+L", title: "Polygon selection (Shift+L): click point by point, click the first point, double-click or Enter to close, Backspace removes the last point, Esc cancels. Replaces the selection, Shift adds, Alt subtracts, Shift+Alt intersects." },
    ]);
    addGroup([
        { tool: "object", label: "Object", key: "O", title: "Object selection (O): hover to see objects, click to select, click again to deselect. Shift adds, Alt subtracts, Shift+Alt intersects." },
        { tool: "wand", label: "Magic wand", key: "W", title: "Magic wand (W): selects the area of similar colour under the cursor. Tolerance, contiguous and the sample source are in the bar above the canvas. Shift adds, Alt subtracts, Shift+Alt intersects." },
    ]);
    ed.quickMaskBtn = iconButton("quickmask", "Quick mask (Q): while on, the paint and erase tools edit the selection (paint selects, erase deselects, the bucket works like the wand) and the selection is shown as a red tint.", () => ed.toggleQuickMask());
    tools.appendChild(ed.quickMaskBtn);
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(el("div", "ipc-grp", "Layer"));
    addTool("paint", "Paint on the active layer (P). On the base it creates a paint layer. Alt+click picks a colour, Shift+click draws a straight line.");
    addTool("erase", "Erase from the active layer (E)");
    addGroup([
        { tool: "smudge", label: "Smudge", key: "Shift+S", title: "Smudge (Shift+S): drag the paint along the stroke, like a finger in wet paint; Mode also makes it a blur or sharpen brush. Strength, Length, Finger and Sample are in the bar above the canvas; on the base it paints into a new layer from the picture." },
        { tool: "clone", label: "Clone stamp", key: "S", title: "Clone stamp (S): Alt+click sets the source, then paint to copy from there onto the active layer. Aligned keeps the offset between strokes; Sample chooses the visible image or the layer." },
        { tool: "heal", label: "Healing brush", key: "J", title: "Healing brush (J): like the clone stamp, but the copied texture takes on the colour and light around it, blended without a rim when you let go." },
        ...(host.removeSupported ? [{ tool: "remove", label: "Remove", key: "Shift+J", title: "Remove (Shift+J): brush over an object or a blemish; when you let go it is filled from what surrounds it (LaMa, in-app: Settings › Helpers). It paints into the active layer; on the base it paints into a new layer." }] : []),
        { tool: "patch", label: "Patch", key: "Shift+J", title: "Patch (Shift+J, again after Remove): lasso a spot (or select it), then drag the selection to where the picture is right; when you let go that texture is laid into the spot and takes on the colour and light around it. Mode Destination copies the selection to where you let go instead. It paints into the active layer; on the base into a new layer." },
        ...(host.removeSupported ? [{ tool: "contentmove", label: "Content-aware move", key: "Shift+J", title: "Content-aware move (Shift+J, again after Patch): lasso an object (or select it), then drag it; when you let go it lands there, its edge blended into the new place, and LaMa fills where it was. Mode Extend leaves the original and places a copy. It paints into the active layer; on the base into a new layer." }] : []),
        { tool: "tone", label: "Dodge / burn", key: "Shift+O", title: "Dodge / burn (Shift+O): paint to lighten or darken (shadows, midtones or highlights), or with the sponge to saturate or desaturate. Alt while pressing swaps dodge and burn. On the base it paints into a new layer." },
        { tool: "liquify", label: "Liquify", key: "Shift+W", title: "Liquify (Shift+W or Ctrl+Shift+X): push the picture with the brush, grow, shrink or swirl it, and restore it. Every stroke is one undo step, and every stroke of a session is taken from where the session began, so the picture does not soften. On the base it works on a copy of it, the layer Liquify." },
    ]);
    addGroup([
        { tool: "bucket", label: "Bucket fill", key: "G", title: "Bucket fill (G): fills the connected area of similar colour under the cursor on the active layer, limited to the selection. Tolerance, contiguous and the sample source are in the bar above the canvas." },
        { tool: "gradient", label: "Gradient", key: "Shift+G", title: "Gradient (Shift+G): drag on the active layer to draw a gradient from the colour to transparent, white or black (linear or radial, bar above the canvas), limited to the selection." },
    ], [
        { icon: "fill", label: "Fill selection", key: "Shift+F", title: "Fill the selection with the colour on the active layer (Shift+F)", onClick: () => ed.fillSelection() },
    ]);
    addTool("shape", "Shape (Y): draw a filled or outlined shape on the active layer, limited to the selection. "
        + "Rectangle and ellipse are dragged out (Shift keeps them square, Alt draws from the centre); polygon, polyline and Bezier are "
        + "clicked point by point (click the first point or press Enter to finish, Backspace takes one back, Esc cancels; on a Bezier "
        + "point, drag while clicking to curve the line); freehand follows the cursor. Kind, fill, outline and corner radius are in the "
        + "bar above the canvas.");
    addTool("eyedropper", "Eyedropper (I): click to pick the colour under the cursor from the visible image. Alt+click with the brush does the same.");
    addTool("transform", "Move / scale / rotate the active layer (T). Drag inside to move, corners scale (Shift: free aspect), edges scale one axis, drag just outside a corner to rotate (Shift snaps to 15°). Rotation is applied with Enter.");
    addTool("text", "Text (Shift+T): click on the canvas to add a text layer, click a text layer to select it, drag to move it, double-click to edit it on the canvas.");
    addTool("hand", "Pan (H, Space or middle mouse)");
    addTool("canvas", "Canvas (C): drag the frame's edges or corners outward to extend the canvas (outpainting), inward to crop, outside the frame to turn the picture; Ctrl+drag along a horizon straightens it. Aspect presets and lines in the bar above. Enter or a double click inside applies, Esc resets. Snaps to 8 px, Alt for single pixels.");
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(iconButton("undo", "Undo (Ctrl+Z)", () => ed.undoStep()));
    tools.appendChild(iconButton("redo", "Redo (Ctrl+Shift+Z)", () => ed.redoStep()));
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(iconButton("flatten", "Flatten all visible layers into the base", () => ed.flatten()));
    body.appendChild(tools);
}

/** The canvas itself, its drop hint and the two bars above it. */
function buildView(ed, body) {
    ed.viewEl = el("div", "ipc-view");
    ed.canvas = document.createElement("canvas");
    ed.ctx = ed.canvas.getContext("2d");
    ed.viewEl.appendChild(ed.canvas);
    ed.dropHint = el("div", "ipc-drop", "Load an image, paste it (Ctrl+V) or drop it here.\nThen paint a selection and press Generate.\nOnce an image is loaded, dropped files become new layers (Shift: reference, Ctrl: replace the image).");
    ed.viewEl.appendChild(ed.dropHint);
    ed.buildSubbar();
    ed.buildOptsBar();
    body.appendChild(ed.viewEl);
}

/** The side panel with its two tabs. `section` adds a details block to the tab that is current; `toGenPane` makes that the Generate tab, as the method did at its half-way point. */
function buildSidePanel(ed) {
    // side panel
    const side = el("div", "ipc-side");
    // two tabs: Image (layers, selection, canvas, export) and Generate (prompt, settings, history, crop)
    const tabBar = el("div", "ipc-tabs");
    ed.panes = { image: el("div", "ipc-pane"), gen: el("div", "ipc-pane") };
    ed.tabButtons = {};
    for (const [id, label, title] of [["image", "Image", "Layers, selection, canvas, export"], ["gen", "Generate", "Prompt, generation settings, history, crop"]]) {
        const b = el("button", "ipc-tab", label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); ed.showPane(id); });
        ed.tabButtons[id] = b;
        tabBar.appendChild(b);
    }
    side.appendChild(tabBar);
    side.appendChild(ed.panes.image);
    side.appendChild(ed.panes.gen);
    ed.sidePanel = side;
    side.appendChild(buildSideGrip(ed, side));
    let pane = ed.panes.image;
    const section = (title, open, build) => {
        const d = document.createElement("details");
        d.open = open;
        const sum = el("summary", null, title);
        d.appendChild(sum);
        build(d, sum);
        pane.appendChild(d);
        return d;
    };
    ed.addSection = (title, open, build, paneId) => { const prev = pane; pane = ed.panes[paneId] || prev; try { return section(title, open, build); } finally { pane = prev; } };
    return { side, section, toGenPane: () => { pane = ed.panes.gen; } };
}

/**
 * The grip on the side panel's left edge (item 17): drag to make the panel wider or narrower, double-click for the
 * default. The move and the release are listened for on the window in the capture phase: the editor's root stops
 * pointerup from bubbling, and the pointer may leave the grip while it drags.
 */
function buildSideGrip(ed, side) {
    const grip = el("div", "ipc-side-grip");
    grip.title = "Drag to make the panel wider or narrower; double-click for the default width";
    grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // the used CSS width, without the border a bounding box adds (a drag would move the panel by it)
        const x0 = e.clientX, w0 = parseFloat(getComputedStyle(side).width) || side.getBoundingClientRect().width;
        let w = w0, moved = false;
        try { grip.setPointerCapture(e.pointerId); } catch (_) { /* a pointer the browser does not know (a scripted event) */ }
        grip.classList.add("ipc-dragging");
        const end = (save) => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", up, true);
            grip.classList.remove("ipc-dragging");
            // a press without a move keeps what is stored (the panel may show a stored width clamped to a small window)
            if (save && moved) ed.setSideWidth(w);
            else if (!save) ed.applyStoredSideWidth();
        };
        const up = () => end(true);
        const move = (ev) => {
            // the release was lost (the button let go over another window) or the tab went away under the drag (hidden
            // or closed: its body has no box, and every width would clamp to the minimum): the drag ends, the tab's own
            // width (the stored one) stays
            if (!(ev.buttons & 1)) { end(true); return; }
            if (!side.isConnected || side.parentElement.getBoundingClientRect().width < 1) { end(false); return; }
            if (ev.clientX !== x0) moved = true;
            w = ed.setSideWidth(w0 + (x0 - ev.clientX), { save: false });
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
    });
    grip.addEventListener("dblclick", (e) => { e.stopPropagation(); ed.setSideWidth(null); });
    return grip;
}

/** The layer list and the buttons above it. */
function buildLayers(ed) {
    const layersHead = el("h4", null, "Layers");
    layersHead.appendChild(el("span", "ipc-grow"));
    const fileInput = (onFiles) => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = "image/*,.tif,.tiff"; inp.multiple = true; inp.style.display = "none";
        inp.addEventListener("change", () => { const files = Array.from(inp.files || []); inp.value = ""; if (files.length) onFiles(files); });
        layersHead.appendChild(inp);
        return inp;
    };
    ed.imageInput = fileInput((files) => ed.addImageLayers(files, "none", { place: "fit" }));
    ed.refInput = fileInput((files) => ed.addImageLayers(files, "reference"));
    ed.fontInput = fileInput((files) => ed.addFontFiles(files));
    ed.fontInput.accept = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
    layersHead.appendChild(miniButton("image", "Import images as layers (one layer per file, part of the image, fitted to the canvas). Dropping files on this list does the same.", () => ed.imageInput.click()));
    layersHead.appendChild(miniButton("fx", "Add a filter layer (film grain, sharpen, blur, levels, curves, brightness / contrast, hue / saturation, colour balance, black & white, invert, LUT, vignette). It filters everything below it; give it a mask to limit where it applies.", () => ed.addFilterLayer()));
    layersHead.appendChild(miniButton("fill", "Add a fill layer (a colour, or a gradient: linear, reflected or radial; it starts in the paint colour). It covers everything below it; its blend mode, opacity and mask let the picture through. The fill's type is in its row.", () => ed.addFilterLayer("fill")));
    layersHead.appendChild(miniButton("plus", "Add a paint layer (Ctrl+Shift+N)", () => ed.addPaintLayer()));
    ed.panes.image.appendChild(layersHead);
    ed.layerList = el("div", "ipc-list");
    ed.layerList.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); ed.layerList.classList.add("ipc-dropping"); });
    ed.layerList.addEventListener("dragleave", () => ed.layerList.classList.remove("ipc-dropping"));
    ed.layerList.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        ed.layerList.classList.remove("ipc-dropping");
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
        if (files.length) ed.addImageLayers(files, e.shiftKey ? "reference" : "none", e.shiftKey ? {} : { place: "fit" });
    });
    ed.panes.image.appendChild(ed.layerList);
}

/** The reference list: pictures that travel with the crop but are not part of the image. */
function buildReferences(ed) {
    // references: their own list, they are not part of the image
    const refHead = el("h4", null, "References");
    refHead.title = "Reference images travel with crop_image as extra batch images (Flux.2 / Kontext multi-reference). They are not part of the image. Hidden references are not sent.";
    ed.refCount = el("span", "ipc-refcount", "");
    refHead.appendChild(ed.refCount);
    refHead.appendChild(el("span", "ipc-grow"));
    ed.refFitSel = selectInput(REF_FITS, REF_DEFAULTS.fit, "How a reference is brought to the crop's size: pad scales it to fit and fills the rest with the image's border colour, crop scales to cover and cuts the middle, stretch distorts.");
    ed.refFitSel.classList.add("ipc-narrow");
    ed.refFitSel.addEventListener("change", () => { ed.refSettings.fit = ed.refFitSel.value; ed.notifyChanged(); });
    refHead.appendChild(ed.refFitSel);
    refHead.appendChild(miniButton("refImage", "Add reference images (one per file). Shift+drop on the canvas or a drop on this list does the same.", () => ed.refInput.click()));
    ed.panes.image.appendChild(refHead);
    ed.refList = el("div", "ipc-list ipc-reflist");
    ed.refList.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); ed.refList.classList.add("ipc-dropping"); });
    ed.refList.addEventListener("dragleave", () => ed.refList.classList.remove("ipc-dropping"));
    ed.refList.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        ed.refList.classList.remove("ipc-dropping");
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
        if (files.length) ed.addImageLayers(files, "reference");
    });
    ed.panes.image.appendChild(ed.refList);
}

/**
 * Undo history (docs/PLAN_0_1_31.md §2): the undo steps as rows, oldest first, a click jumps there; named snapshots of
 * the whole document under them (tiles only). Not the "History" section of the Generate tab, which lists results.
 */
function buildUndoHistory(ed, section) {
    let open = false;
    try { open = localStorage.getItem("ipc.undoOpen") === "1"; } catch (_) { /* no storage */ }
    const d = section("Undo history", open, (d, sum) => {
        sum.appendChild(el("span", "ipc-grow"));
        const clr = miniButton("trash", "Clear the undo history (the snapshots stay). Nothing in the picture changes.", async () => {
            if (!ed.undo.length && !ed.redo.length) return;
            const yes = await ed.ask({ title: "Clear the undo history", message: `${ed.undo.length + ed.redo.length} step${ed.undo.length + ed.redo.length === 1 ? "" : "s"} can no longer be undone or redone. The picture stays as it is.`, ok: "Clear", danger: true });
            if (!yes) return;
            ed.clearUndo();
            ed.setStatus("Undo history cleared.");
        }, "ipc-del ipc-undo-clear");
        clr.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
        sum.appendChild(clr);
        ed.undoListEl = el("div", "ipc-undo-list");
        d.appendChild(ed.undoListEl);
        const row = el("div", "ipc-sec ipc-undo-bar");
        ed.undoSnapBtn = iconButton("plus", SNAP_TITLE, async () => {
            if (!ed.tileMode || !ed.base) return;
            const name = await ed.ask({ title: "Snapshot", message: "A name for the document as it is now:", value: ed.nextSnapshotName(), ok: "Take" });
            if (name == null) return;
            ed.takeSnapshot(String(name));
        }, "Snapshot");
        ed.undoSnapBtn.classList.add("ipc-small", "ipc-undo-snap");
        row.appendChild(ed.undoSnapBtn);
        d.appendChild(row);
        ed.snapListEl = el("div", "ipc-snap-list");
        d.appendChild(ed.snapListEl);
    });
    d.addEventListener("toggle", () => {
        try { localStorage.setItem("ipc.undoOpen", d.open ? "1" : "0"); } catch (_) { /* no storage */ }
        if (d.open) ed.renderUndoList();    // brings the present into view
    });
    ed.undoSection = d;
    ed.renderUndoList = () => renderUndoList(ed);
    renderUndoList(ed);
}

const SNAP_TITLE = "Keep the whole document as it is now under a name, to come back to later (up to 8; not saved with the document).";
const clock = (t) => { if (!t) return ""; const x = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`; };

/** The rows of the Undo history (a few dozen at most: the depth caps them), redrawn after every change of the stacks. */
function renderUndoList(ed) {
    const list = ed.undoListEl;
    if (!list) return;
    const tiles = !!ed.tileMode;
    ed.undoSnapBtn.disabled = !tiles || !ed.base;
    ed.undoSnapBtn.title = tiles ? SNAP_TITLE : "Snapshots need the tile backend (Settings › Rendering).";
    list.textContent = "";
    for (const r of ed.undoList()) {
        const row = el("div", "ipc-undo-row" + (r.current ? " ipc-undo-current" : "") + (r.future ? " ipc-undo-future" : ""), r.label);
        row.dataset.steps = String(r.steps);
        row.title = (r.at ? clock(r.at) + " · " : "") + (r.current ? "The picture as it is now" : r.future ? `Redo ${r.steps} step${r.steps === 1 ? "" : "s"} to get here` : `Undo ${-r.steps} step${r.steps === -1 ? "" : "s"} to get here`);
        // a click while a jump still runs is dropped: its step count belongs to the list before that jump
        if (!r.current) row.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (ed._undoJumping) return;
            ed._undoJumping = true;
            try { await ed.stepHistory(r.steps); } finally { ed._undoJumping = false; }
        });
        list.appendChild(row);
    }
    // the present in view inside the list's own scroll box (scrollIntoView would move the whole side panel)
    const cur = list.querySelector(".ipc-undo-current");
    if (cur && ed.undoSection && ed.undoSection.open) {
        if (cur.offsetTop < list.scrollTop) list.scrollTop = cur.offsetTop;
        else if (cur.offsetTop + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = cur.offsetTop + cur.offsetHeight - list.clientHeight;
    }
    const snaps = ed.snapListEl;
    snaps.textContent = "";
    for (const s of ed.snapshots) {
        const row = el("div", "ipc-snap-row");
        row.dataset.name = s.name;
        const name = el("span", "ipc-snap-name", s.name);
        name.title = `Taken at ${clock(s.at)}`;
        row.appendChild(name);
        row.appendChild(el("span", "ipc-grow"));
        // the row's own entry, by where it is now (a name is unique, the entry is surer still)
        const restore = miniButton("restore", `Put the document back as it was in "${s.name}" (one undo step: Ctrl+Z takes it back)`, () => ed.restoreSnapshot(ed.snapshots.indexOf(s)), "ipc-snap-restore");
        const del = miniButton("trash", `Delete the snapshot "${s.name}"`, () => ed.deleteSnapshot(ed.snapshots.indexOf(s)), "ipc-del ipc-snap-delete");
        row.appendChild(restore);
        row.appendChild(del);
        snaps.appendChild(row);
    }
}

/** Selection: grow, feather, the stored selections, selection by text and the object tool. */
function buildSelection(ed, section) {
    section("Selection", true, (d) => {
        const sec = el("div", "ipc-sec");
        ed.growInput = numberInput(16, 1, 1024, "Pixels to grow or shrink by", 60);
        sec.appendChild(el("span", null, "by"));
        sec.appendChild(ed.growInput);
        sec.appendChild(el("span", null, "px"));
        const selRow = el("div", "ipc-sec");
        const clrSel = iconButton("clear", "Clear the selection (Ctrl+D)", () => ed.clearSelection(), "None");
        clrSel.classList.add("ipc-small");
        selRow.appendChild(clrSel);
        const inv = iconButton("invert", "Invert the selection (Ctrl+I)", () => ed.invertSelection(), "Invert");
        inv.classList.add("ipc-small");
        selRow.appendChild(inv);
        ed.antsBtn = iconButton("ants", "Selection display: marching ants outline (on) or red tint (off)", () => {
            ed.selectionDisplay = ed.selectionDisplay === "ants" ? "tint" : "ants";
            try { localStorage.setItem("ipc.selectionDisplay", ed.selectionDisplay); } catch (_) { /* ignore */ }
            ed.antsBtn.classList.toggle("ipc-toggle-on", ed.selectionDisplay === "ants");
            ed.draw();
            ed.setStatus(ed.selectionDisplay === "ants" ? "Selection shown as an outline." : "Selection shown as a red tint.");
        }, "Ants");
        ed.antsBtn.classList.add("ipc-small");
        ed.antsBtn.classList.toggle("ipc-toggle-on", ed.selectionDisplay === "ants");
        selRow.appendChild(ed.antsBtn);
        d.appendChild(selRow);
        const grow = iconButton("grow", "Grow the selection by n pixels", () => ed.growSelection(+ed.growInput.value), "Grow");
        grow.classList.add("ipc-small");
        sec.appendChild(grow);
        const shrink = iconButton("shrink", "Shrink the selection by n pixels", () => ed.growSelection(-ed.growInput.value), "Shrink");
        shrink.classList.add("ipc-small");
        sec.appendChild(shrink);
        const from = iconButton("fromLayer", "Replace the selection with the opaque area of the active layer", () => ed.selectionFromLayer(), "Layer");
        from.classList.add("ipc-small");
        selRow.appendChild(from);
        const clr = iconButton("erase", "Delete the selected pixels of the active layer (Del). Invert the selection first to keep only the selection.", () => ed.clearSelectedPixels(), "Delete px");
        clr.classList.add("ipc-small");
        selRow.appendChild(clr);
        ed.featherInput = numberInput(8, 1, 512, "Feather radius in pixels", 52);
        sec.appendChild(el("span", "ipc-gap", ""));
        sec.appendChild(ed.featherInput);
        const fe = iconButton("blur", "Feather: soften the selection's edge by the radius (a gaussian blur of the selection mask)", () => ed.featherSelection(+ed.featherInput.value), "Feather");
        fe.classList.add("ipc-small");
        sec.appendChild(fe);
        d.appendChild(sec);

        // saved selections (stored with the workflow)
        const sv = el("div", "ipc-sec");
        const save = iconButton("save", "Store the current selection with the workflow", () => ed.saveSelection(), "Save selection");
        save.classList.add("ipc-small");
        sv.appendChild(save);
        ed.selectionsSel = selectInput([], "", "Saved selections");
        ed.selectionsSel.classList.add("ipc-narrow");
        sv.appendChild(ed.selectionsSel);
        const load = iconButton("fromLayer", "Load the saved selection (replaces; Shift+click adds, Alt+click subtracts, Shift+Alt intersects)", (e) => ed.loadSelection(ed.selectionsSel.selectedIndex, selModeOf(e)), "Load");
        load.classList.add("ipc-small");
        sv.appendChild(load);
        sv.appendChild(miniButton("trash", "Delete the saved selection", () => ed.deleteSelection(ed.selectionsSel.selectedIndex), "ipc-del"));
        d.appendChild(sv);
        ed.renderSelectionList();

        // select by range (Nik-9 Parity R1-S6)
        buildRangeSelect(ed, d);

        // select by text
        const seg = el("div", "ipc-sec");
        const row = el("div", "ipc-seg");
        ed.segInput = document.createElement("input");
        ed.segInput.type = "text";
        ed.segInput.placeholder = "Select by text, e.g. shirt (empty: from the prompt)";
        ed.segInput.spellcheck = false;
        ed.segInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); ed.segmentByText(); } if (e.key === "Escape") { ed.segInput.blur(); ed.root.focus({ preventScroll: true }); } });
        row.appendChild(ed.segInput);
        ed.segBtn = iconButton("magic", "Run the segmentation model and turn the result into a selection (Enter in the field)", () => ed.segmentByText(), "Go");
        ed.segBtn.classList.add("ipc-small", "ipc-primary");
        row.appendChild(ed.segBtn);
        seg.appendChild(row);
        const modes = el("div", "ipc-modes");
        ed.segModeButtons = {};
        for (const [id, label, title] of [["replace", "Replace", "Replace the selection"], ["add", "Add", "Add to the selection"], ["subtract", "Subtract", "Remove from the selection"], ["intersect", "Intersect", "Intersect with the selection"]]) {
            const b = el("button", "ipc-ib", label); b.type = "button"; b.title = title;
            b.addEventListener("click", (e) => { e.stopPropagation(); ed.segMode = id; for (const [k, x] of Object.entries(ed.segModeButtons)) x.classList.toggle("ipc-active", k === id); });
            ed.segModeButtons[id] = b;
            modes.appendChild(b);
        }
        ed.segMode = "replace";
        ed.segModeButtons.replace.classList.add("ipc-active");
        seg.appendChild(modes);
        const thrLab = el("label", null, "Threshold");
        ed.segThreshold = numberInput(0.3, 0.05, 0.95, "Detection threshold: lower finds more, higher is stricter", 56);
        ed.segThreshold.step = 0.05;
        thrLab.appendChild(ed.segThreshold);
        seg.appendChild(thrLab);
        const qualLab = el("label", null, "");
        ed.segQualityLab = qualLab;
        ed.segQuality = document.createElement("input");
        ed.segQuality.type = "checkbox";
        ed.segQuality.title = "HQ: use the large SAM model with GroundingDINO + SAM (slower, finer edges). Not used by SAM3.";
        qualLab.appendChild(ed.segQuality);
        qualLab.appendChild(el("span", null, "HQ"));
        seg.appendChild(qualLab);
        const srcLab = el("label", null, "Source");
        ed.segSourceSel = selectInput(["image", "active layer"], "image", "What the model sees: the flattened image, or only the active layer (the result is clipped to that layer)");
        ed.segSourceSel.addEventListener("change", () => { if (ed.tool === "object") ed.ensureObjects(); });
        srcLab.appendChild(ed.segSourceSel);
        seg.appendChild(srcLab);
        ed.segBackendSel = selectInput(["auto"], "auto", "Segmentation backend");
        ed.segBackendSel.addEventListener("change", () => ed.updateSegQuality());
        seg.appendChild(ed.segBackendSel);
        d.appendChild(seg);
    });
}

/** Select by range (Nik-9 Parity R1-S6). */
function buildRangeSelect(ed, d) {
    const block = el("div", "ipc-sec");
    ed.rangeBlock = block;

    // Header: Depth row (Nik-9 Parity R1-S3b moved here; absent when host.depthSupported === false)
    if (host.depthSupported !== false) {
        ed.depthContainer = el("div", "ipc-depth-container");
        block.appendChild(ed.depthContainer);
        ed.renderDepthRow();
    } else {
        ed.depthContainer = null;
    }

    if (!ed.rangeLimit) {
        ed.rangeLimit = {
            source: host.depthSupported !== false ? "depth" : "luma",
            lo: 0,
            hi: 0.3,
            fLo: 0.05,
            fHi: 0.05,
            invert: false,
            color: "#ffffff",
            tol: 30,
        };
    }
    if (host.depthSupported === false && ed.rangeLimit.source === "depth") {
        ed.rangeLimit.source = "luma";
    }
    ed.rangeMode = ed.rangeMode || "replace";

    // Source select row
    const srcRow = el("div", "ipc-row");
    const srcLab = el("label", null, "Source");
    const sources = [];
    if (host.depthSupported !== false) {
        sources.push({ value: "depth", label: "Depth" });
    }
    sources.push({ value: "luma", label: "Luminosity" });
    sources.push({ value: "color", label: "Colour" });
    ed.rangeSourceSel = selectInput(sources, ed.rangeLimit.source, "Range source: Depth, Luminosity or Colour");
    srcLab.appendChild(ed.rangeSourceSel);
    srcRow.appendChild(srcLab);
    block.appendChild(srcRow);

    // Colour row: colour swatch and tolerance (visible when source === "color")
    const colorRow = el("div", "ipc-row");
    colorRow.style.display = ed.rangeLimit.source === "color" ? "" : "none";
    const colorLab = el("label", null, "Colour");
    ed.rangeColorInput = document.createElement("input");
    ed.rangeColorInput.type = "color";
    ed.rangeColorInput.value = ed.rangeLimit.color || "#ffffff";
    ed.rangeColorInput.title = "Target colour";
    ed.rangeColorInput.addEventListener("input", () => {
        ed.rangeLimit.color = ed.rangeColorInput.value;
        if (ed.rangeBar) ed.rangeBar.refresh();
    });
    colorLab.appendChild(ed.rangeColorInput);
    colorRow.appendChild(colorLab);

    const tolLab = el("label", null, "Tolerance");
    ed.rangeTolInput = numberInput(ed.rangeLimit.tol ?? 30, 0, 100, "Colour tolerance (0..100)", 48);
    ed.rangeTolInput.addEventListener("input", () => {
        ed.rangeLimit.tol = parseFloat(ed.rangeTolInput.value) || 0;
        if (ed.rangeBar) ed.rangeBar.refresh();
    });
    tolLab.appendChild(ed.rangeTolInput);
    colorRow.appendChild(tolLab);
    block.appendChild(colorRow);

    // Range bar container
    const barWrap = el("div", "ipc-rangebar-container");
    block.appendChild(barWrap);

    // The button and Enter: a refused run (no depth map yet, no picture) lands in the status line, not
    // as an unhandled rejection.
    const runRange = () => Promise.resolve(ed.selectRange(ed.rangeLimit, ed.rangeMode))
        .catch((err) => ed.setStatus(err && err.message ? err.message : String(err)));

    const mountRangeBar = () => {
        barWrap.innerHTML = "";
        const source = ed.rangeLimit.source;
        ed.rangeBar = buildRangeBar(ed.rangeLimit, {
            gradient: source,
            histogram: () => {
                if (source === "depth") return ed.mapHistogram("depth");
                if (source === "luma") {
                    const h = ed.pictureHistogram();
                    return h ? h.luma : null;
                }
                return ed.similarityHistogram(ed.rangeLimit);
            },
            begin: () => ed.setRangePreview(ed.rangeLimit),
            preview: (r) => ed.setRangePreview({ ...ed.rangeLimit, ...r }),
            commit: (r) => { ed.rangeLimit = { ...ed.rangeLimit, ...r }; },
            stop: () => ed.setRangePreview(null),
            pick: () => ed.pickOnce(source),
            hover: (on) => ed.setRangePreview(on ? ed.rangeLimit : null),
            title: "Range",
            onEnter: runRange,
        });
        barWrap.appendChild(ed.rangeBar.el);
    };

    mountRangeBar();

    ed.rangeSourceSel.addEventListener("change", () => {
        ed.rangeLimit.source = ed.rangeSourceSel.value;
        colorRow.style.display = ed.rangeLimit.source === "color" ? "" : "none";
        mountRangeBar();
    });

    // Mode buttons
    const modes = el("div", "ipc-modes");
    ed.rangeModeButtons = {};
    for (const [id, label, title] of [
        ["replace", "Replace", "Replace the selection"],
        ["add", "Add", "Add to the selection"],
        ["subtract", "Subtract", "Remove from the selection"],
        ["intersect", "Intersect", "Intersect with the selection"],
    ]) {
        const b = el("button", "ipc-ib", label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            ed.rangeMode = id;
            for (const [k, x] of Object.entries(ed.rangeModeButtons)) x.classList.toggle("ipc-active", k === id);
        });
        ed.rangeModeButtons[id] = b;
        modes.appendChild(b);
    }
    ed.rangeModeButtons[ed.rangeMode || "replace"].classList.add("ipc-active");
    block.appendChild(modes);

    // Select button row
    const actRow = el("div", "ipc-row");
    ed.rangeSelectBtn = iconButton("magic", "Select pixels matching the range", runRange, "Select");
    ed.rangeSelectBtn.classList.add("ipc-small", "ipc-primary");
    actRow.appendChild(ed.rangeSelectBtn);
    // Invert: what lies outside the range instead (the preview tint follows it)
    const invLab = el("label", null);
    ed.rangeInvertInput = document.createElement("input");
    ed.rangeInvertInput.type = "checkbox";
    ed.rangeInvertInput.checked = !!ed.rangeLimit.invert;
    ed.rangeInvertInput.title = "Select what lies outside the range";
    ed.rangeInvertInput.addEventListener("change", () => {
        ed.rangeLimit.invert = ed.rangeInvertInput.checked;
        if (ed.rangeBar) ed.rangeBar.refresh();
        if (ed._rangeTint) ed.setRangePreview(ed.rangeLimit);
    });
    invLab.appendChild(ed.rangeInvertInput); invLab.appendChild(el("span", null, "Invert"));
    actRow.appendChild(invLab);
    block.appendChild(actRow);

    d.appendChild(block);
}

/** Canvas: size, extend, the frame and the local files. */
function buildCanvasPanel(ed, section) {
    section("Canvas", false, (d) => {
        const sec = el("div", "ipc-sec");
        const grid = el("div", "ipc-row4");
        ed.extendInputs = {};
        for (const [key, label] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]]) {
            grid.appendChild(el("span", null, label));
            ed.extendInputs[key] = numberInput(0, -65535, 65535, `Pixels to add at the ${key} (negative: crop); the canvas tool (C) shows the frame, Enter applies`, 64);
            ed.extendInputs[key].addEventListener("input", () => ed.setFrameFromSides());
            ed.extendInputs[key].addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ed.setFrameFromSides(); ed.root.focus({ preventScroll: true }); ed.applyFrame(); } });
            grid.appendChild(ed.extendInputs[key]);
        }
        sec.appendChild(grid);
        const fillLab = el("label", null, "Border");
        ed.extendFillSel = selectInput(["stretch edges", "average color", "grey", "green", "black", "noise"], "average color",
            "What fills the new border before the model sees it: stretched edge pixels, the image's average colour, neutral grey, green (edit models), black, or random noise (latent models).");
        ed.extendFillSel.addEventListener("change", () => { ed.cropSettings.extendFill = ed.extendFillSel.value; ed.notifyChanged(); });
        fillLab.appendChild(ed.extendFillSel);
        sec.appendChild(fillLab);
        const ext = iconButton("extend", "Apply the canvas frame: the pixels above extend the canvas (outpainting; the new border becomes the selection), negative values crop; with an angle the picture is straightened and cropped in one step. The canvas tool (C) sets the frame by dragging; Enter applies.", () => ed.applyFrame(), "Apply");
        ext.classList.add("ipc-small");
        sec.appendChild(ext);
        const rst = iconButton("close", "Reset the canvas frame (Esc in the canvas tool)", () => ed.resetFrame(), "Reset");
        rst.classList.add("ipc-small");
        sec.appendChild(rst);
        ed.canvasInfo = el("span", null, "");
        sec.appendChild(ed.canvasInfo);
        d.appendChild(sec);

        // resize the whole image
        const rs = el("div", "ipc-sec");
        rs.appendChild(el("span", null, "Resize"));
        ed.resizeW = numberInput(0, 8, 16384, "New width", 64);
        ed.resizeH = numberInput(0, 8, 16384, "New height", 64);
        ed.resizeLock = document.createElement("input");
        ed.resizeLock.type = "checkbox"; ed.resizeLock.checked = true; ed.resizeLock.title = "Keep the aspect ratio";
        ed.resizeW.addEventListener("input", () => { if (ed.resizeLock.checked && ed.width) ed.resizeH.value = Math.max(8, Math.round(+ed.resizeW.value * ed.height / ed.width)); });
        ed.resizeH.addEventListener("input", () => { if (ed.resizeLock.checked && ed.height) ed.resizeW.value = Math.max(8, Math.round(+ed.resizeH.value * ed.width / ed.height)); });
        rs.appendChild(ed.resizeW);
        rs.appendChild(el("span", null, "×"));
        rs.appendChild(ed.resizeH);
        const lockLab = el("label", null, ""); lockLab.appendChild(ed.resizeLock); lockLab.appendChild(el("span", null, "aspect")); rs.appendChild(lockLab);
        const rbtn = iconButton("resize", "Scale the image, all layers and the selection to the new size (undoable)", () => ed.resizeImage(+ed.resizeW.value, +ed.resizeH.value), "Resize");
        rbtn.classList.add("ipc-small");
        rs.appendChild(rbtn);
        d.appendChild(rs);

        // turn or mirror the whole picture, every layer with it (PLAN_0_1_31 §7); the transform bar has the layer's own
        const turn = el("div", "ipc-sec");
        turn.appendChild(el("span", null, "Turn"));
        for (const [icon, op, title] of [
            ["rotCCW", -1, "Rotate the whole picture 90° counter-clockwise: every layer, mask and the selection turn with it (undoable)"],
            ["rotCW", 1, "Rotate the whole picture 90° clockwise: every layer, mask and the selection turn with it (undoable)"],
            ["rot180", 2, "Rotate the whole picture 180° (undoable)"],
            ["flipH", "h", "Mirror the whole picture left to right: every layer with it (undoable)"],
            ["flipV", "v", "Mirror the whole picture top to bottom: every layer with it (undoable)"],
        ]) {
            const b = iconButton(icon, title, () => ed.turnDocument(op));
            b.classList.add("ipc-small");
            b.dataset.turn = String(op);
            turn.appendChild(b);
        }
        d.appendChild(turn);

        // files
        const files = el("div", "ipc-sec");
        const clean = iconButton("broom", "Delete the node's own working files in input/output/temp inpaint_canvas that no workflow uses: not this or any open editor, not any saved workflow, not younger than two minutes. Images you loaded or saved keep their names and are never touched. Asks before deleting.", () => ed.cleanupFiles(), "Clean up files");
        clean.classList.add("ipc-small");
        files.appendChild(clean);
        ed.cleanupInfo = el("span", null, "");
        files.appendChild(ed.cleanupInfo);
        d.appendChild(files);
    });
}

/** Export: the file name, the format and what a save writes. */
function buildExport(ed, section) {
    section("Export", true, (d) => {
        const exp = el("div", "ipc-sec");
        exp.appendChild(el("span", null, "Save as"));
        ed.saveNameInput = document.createElement("input");
        ed.saveNameInput.type = "text";
        ed.saveNameInput.className = "ipc-num";
        ed.saveNameInput.style.width = "120px";
        ed.saveNameInput.value = "inpaint_canvas";
        ed.saveNameInput.title = "File name (a counter is added when it exists)";
        ed.saveNameInput.spellcheck = false;
        ed.saveNameInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ed.exportImage(); });
        exp.appendChild(ed.saveNameInput);
        ed.saveFormatSel = selectInput(["png", "jpg", "webp", "tiff", "psd", "ora"], "png", "PNG is lossless and can carry the workflow and prompt in the file, JPEG and WebP are smaller, TIFF (8 bits, ZIP compression) is for print and photo programs. PSD and ORA (OpenRaster, for GIMP and others) keep the layers: name, position, opacity, visibility, blend mode; filter layers are baked into the merged image only.");
        exp.appendChild(ed.saveFormatSel);
        const dl = iconButton("download", hostText("downloadTip", "Save the image to a file (Ctrl+S)"), () => ed.exportImage({ download: true }), hostText("downloadLabel", "Save as"));
        dl.classList.add("ipc-small");
        exp.appendChild(dl);
        const lay = iconButton("image", hostText("exportLayerTip", "Save the active layer alone as a PNG file with transparency"), () => ed.exportLayerPng(), "Layer");
        lay.classList.add("ipc-small");
        exp.appendChild(lay);
        const msk = iconButton("mask", hostText("exportMaskTip", "Save the selection as a black and white mask PNG file"), () => ed.exportMaskPng(), "Mask");
        msk.classList.add("ipc-small");
        exp.appendChild(msk);
        d.appendChild(exp);

    });
}

/** Prompt: the text fields, the templates and the upsampler. */
function buildPrompt(ed, section) {
    section("Prompt", true, (d) => {
        const wrap = el("div", "ipc-prompt");
        if (host.refTokens) {
            // the app: a field that draws the @img tokens as reference chips and reads like the textarea (PLAN_REFS C4)
            ed.promptField = new PromptField({
                placeholder: "Describe the change. Type @ to name a reference image.",
                refs: () => ed.refContext(),
                popupRoot: ed.root,
                addReferences: (files) => ed.addReferencesForPrompt(files),
                preview: (id, canvas) => ed.refPreview(id, canvas),
            });
            ed.promptInput = ed.promptField.el;
            // the reference bar above the field: a chip per reference, "+", the count against the recipe (26c2)
            new RefBar(ed.promptField, { mount: wrap });
        } else {
            ed.promptInput = document.createElement("textarea");
            ed.promptInput.placeholder = "Describe what should appear in the selection. Available as the node's prompt output.";
            ed.promptInput.spellcheck = false;
        }
        ed.promptInput.addEventListener("input", () => { ed.promptText = ed.promptInput.value; });
        ed.promptInput.addEventListener("change", () => ed.notifyChanged());
        ed.promptInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { ed.promptInput.blur(); ed.root.focus({ preventScroll: true }); }
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ed.generate(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") { e.preventDefault(); ed.upsamplePrompt(); }
        });
        wrap.appendChild(ed.promptInput);
        ed.negativeInput = document.createElement("textarea");
        ed.negativeInput.placeholder = "Negative prompt (local mode, SDXL-class models). Available as the node's negative output.";
        ed.negativeInput.spellcheck = false;
        ed.negativeInput.rows = 2;
        ed.negativeInput.addEventListener("input", () => { ed.negativeText = ed.negativeInput.value; });
        ed.negativeInput.addEventListener("change", () => ed.notifyChanged());
        ed.negativeInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { ed.negativeInput.blur(); ed.root.focus({ preventScroll: true }); } });
        wrap.appendChild(ed.negativeInput);
        d.appendChild(wrap);

        // the Boxes switch (item 28 S3d): a row of its own, shown while the recipe sends boxes (syncBoxesRow)
        ed.boxesRow = el("div", "ipc-sec ipc-boxes");
        ed.boxesRow.hidden = true;
        const boxLab = el("label", null, "");
        boxLab.title = "Send boxes with Generate and Generate new: the document's boxes (the Boxes panel and tool), or the selection as one box when there are none. Off, no box goes and the boxes stay with the document. The first box a document gets turns it on.";
        ed.boxesCheck = document.createElement("input");
        ed.boxesCheck.type = "checkbox";
        ed.boxesCheck.addEventListener("change", () => {
            ed.genSettings.boxes = ed.boxesCheck.checked;
            ed.syncBoxesRow();
            ed.notifyChanged();
            ed.draw();
        });
        boxLab.appendChild(ed.boxesCheck);
        ed.boxesLabel = el("span", null, "Boxes");
        boxLab.appendChild(ed.boxesLabel);
        ed.boxesRow.appendChild(boxLab);
        ed.boxesHint = el("span", "ipc-hint", "");
        ed.boxesRow.appendChild(ed.boxesHint);
        d.appendChild(ed.boxesRow);

        // prompt upsampling
        const up = el("div", "ipc-sec ipc-upsample");
        const caseLab = el("label", null, "Use case");
        ed.upCaseSel = selectInput(UPSAMPLE_CASES, "auto", "What the rewritten prompt is for. auto = an editing instruction (Flux.2, Kontext, Klein), or outpaint when the selection touches the border. fill / add / remove write a description of the finished area for inpaint models; upscale describes what is there with the fine detail an upscale or refinement pass should bring out.");
        ed.upCaseSel.addEventListener("change", () => { ed.upsampleSettings.useCase = ed.upCaseSel.value; ed.notifyChanged(); });
        caseLab.appendChild(ed.upCaseSel);
        up.appendChild(caseLab);
        ed.upBackendSel = selectInput(["auto"], "auto", "Language model used for upsampling");
        ed.upBackendSel.addEventListener("change", () => { ed.upsampleSettings.backend = ed.upBackendSel.value; ed.notifyChanged(); });
        up.appendChild(ed.upBackendSel);
        ed.upBtn = iconButton("magic", "Upsample (Ctrl+U): a vision-language model rewrites the prompt for the selected area and use case. Short requests work best; the small local model is most reliable with English.", () => ed.upsamplePrompt(), "Upsample");
        ed.upBtn.classList.add("ipc-small", "ipc-primary");
        up.appendChild(ed.upBtn);
        ed.upRevertBtn = iconButton("restore", "Put the previous prompt back", () => ed.revertPrompt(), "Revert");
        ed.upRevertBtn.classList.add("ipc-small");
        ed.upRevertBtn.disabled = true;
        up.appendChild(ed.upRevertBtn);
        d.appendChild(up);
    });
}

/** Generate: mode, seed, denoise, the provider's own rows and the helper models. */
function buildGenerate(ed, section) {
    section("Generate", true, (d) => {
        const sec = el("div", "ipc-sec ipc-gen");
        const denLab = el("label", null, "Denoise");
        denLab.title = "Denoise strength for a local sampler (denoise output). 1.0 repaints the selection completely, lower values keep more of what is there (refine).";
        ed.denoiseInput = document.createElement("input");
        ed.denoiseInput.type = "range";
        ed.denoiseInput.min = 0.05; ed.denoiseInput.max = 1; ed.denoiseInput.step = 0.05; ed.denoiseInput.value = 1;
        ed.denoiseInput.title = "Denoise strength, emitted on the node's denoise output";
        ed.denoiseInput.addEventListener("keydown", (e) => e.stopPropagation());
        ed.denoiseInput.addEventListener("click", (e) => e.stopPropagation());
        ed.denoiseVal = el("b", null, "1.00");
        ed.denoiseInput.addEventListener("input", () => {
            ed.genSettings.denoise = Math.min(1, Math.max(0.05, Math.round((+ed.denoiseInput.value || 1) * 100) / 100));
            ed.denoiseVal.textContent = ed.genSettings.denoise.toFixed(2);
            ed.renderInfo(); ed.draw();
        });
        ed.denoiseInput.addEventListener("change", () => ed.notifyChanged());
        denLab.appendChild(ed.denoiseInput);
        denLab.appendChild(ed.denoiseVal);
        sec.appendChild(denLab);
        const seedLab = el("label", null, "Seed");
        seedLab.title = "Seed emitted on the node's seed output";
        ed.seedInput = numberInput(0, 0, 4294967295, "Seed value", 96);
        ed.seedInput.addEventListener("change", () => { ed.genSettings.seed = Math.max(0, Math.floor(+ed.seedInput.value || 0)); ed.genSettings.seedRandom = false; ed.seedRandom.checked = false; ed.notifyChanged(); });
        seedLab.appendChild(ed.seedInput);
        sec.appendChild(seedLab);
        const rndLab = el("label", null, "");
        ed.seedRandom = document.createElement("input");
        ed.seedRandom.type = "checkbox";
        ed.seedRandom.checked = true;
        ed.seedRandom.title = "New random seed for every Generate";
        ed.seedRandom.addEventListener("change", () => { ed.genSettings.seedRandom = ed.seedRandom.checked; ed.notifyChanged(); });
        rndLab.appendChild(ed.seedRandom);
        rndLab.appendChild(el("span", null, "random"));
        sec.appendChild(rndLab);
        const dice = iconButton("dice", "Roll a new seed now", () => { ed.genSettings.seed = randomSeed(); ed.seedInput.value = ed.genSettings.seed; ed.notifyChanged(); });
        dice.classList.add("ipc-small");
        sec.appendChild(dice);
        const freeBtn = iconButton("broom", "Free the helper models (Qwen-VL, SAM3, SAM2, RMBG) from VRAM now. In local mode this happens by itself before a run whenever a helper was used; in API mode they stay loaded.", () => ed.freeHelperModels(), "Free VRAM");
        freeBtn.classList.add("ipc-small");
        sec.appendChild(freeBtn);
        ed.refineBtn = iconButton("refine", "Refine (local mode): re-run the selection at the denoise below without fill and without a feathered mask; the seam stays soft when stitching.", () => {
            ed.genSettings.refine = !ed.genSettings.refine;
            if (ed.genSettings.refine && ed.genSettings.denoise >= 1) { ed.genSettings.denoise = 0.5; ed.denoiseInput.value = 0.5; }
            ed.syncGenControls(); ed.renderInfo(); ed.notifyChanged();
            ed.setStatus(ed.genSettings.refine ? `Refine on: denoise ${ed.genSettings.denoise}, plain selection mask, no fill.` : "Refine off.");
        }, "Refine");
        ed.refineBtn.classList.add("ipc-small");
        sec.appendChild(ed.refineBtn);
        host.buildGenerateExtras(ed, sec);
        d.appendChild(sec);
    });
}

/** Settings: the recipe's own inputs (the panel is rendered by renderSettings). */
function buildSettings(ed, section) {
    section("Settings", true, (d) => {
        ed.settingsList = el("div", "ipc-sec ipc-settings");
        d.appendChild(ed.settingsList);
        ed.renderSettings();
    });
}

/** History: the runs of this document. */
function buildHistory(ed, section) {
    section("History", true, (d, sum) => {
        sum.appendChild(el("span", "ipc-grow"));
        const clr = miniButton("trash", "Clear the history list (layers and files stay)", () => ed.clearHistory(), "ipc-del");
        clr.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
        ed.compareBtn = miniButton("compare", "Compare two results side by side (the two newest, or Ctrl+click a thumbnail for A and Shift+click for B). Drag the divider; Esc or click again ends it.", () => ed.toggleCompare());
        ed.compareBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
        sum.appendChild(ed.compareBtn);
        sum.appendChild(clr);
        ed.historyList = el("div", "ipc-hist");
        d.appendChild(ed.historyList);
    });
}

/** Crop: what the node sends, and the numbers that describe it. */
function buildCrop(ed, section) {
    section("Crop", true, (d) => {
        const sec = el("div", "ipc-sec ipc-cropset");
        const onChange = () => {
            ed.cropSettings = {
                ...ed.cropSettings,
                context: ed.cropContextSel.value === "auto" ? "auto" : "manual",
                feather: ed.cropFeatherSel.value === "auto" ? "auto" : "manual",
                fill: ed.cropFillSel.value,
                colorMatch: ed.cropColorMatch.checked,
                withOriginal: ed.cropOriginal.checked,
                align: ed.cropAlign.checked,
                paste: ed.cropPasteSel.value === "whole crop" ? "crop" : "selection",
            };
            ed.renderInfo();
            ed.draw();
            ed.notifyChanged();
        };
        const row = (label, control, title) => {
            const l = el("label", null, label);
            if (title) l.title = title;
            l.appendChild(control);
            sec.appendChild(l);
        };
        ed.cropContextSel = selectInput(["auto", "manual"], "auto", "Context around the selection: auto sizes it from the selection (at least 512 px), manual uses the node's padding widget");
        ed.cropFeatherSel = selectInput(["auto", "manual"], "auto", "Mask edge: auto grows and feathers the mask from the selection size, manual blurs by the node's feather widget");
        ed.cropFillSel = selectInput(["none", "neutral", "blur", "border", "green"], "none", "How the selected area is filled in crop_image before the model sees it. Green is for edit models (\"fill the green area\").");
        ed.cropColorMatch = document.createElement("input");
        ed.cropColorMatch.type = "checkbox";
        ed.cropColorMatch.checked = true;
        ed.cropOriginal = document.createElement("input");
        ed.cropOriginal.type = "checkbox";
        ed.cropOriginal.checked = false;
        ed.cropAlign = document.createElement("input");
        ed.cropAlign.type = "checkbox";
        ed.cropAlign.checked = true;
        ed.cropAlign.addEventListener("change", onChange);
        ed.cropPasteSel = selectInput(["selection", "whole crop"], "selection", "What of the result is pasted back: only the selection (soft edge along the selection), or the whole returned rectangle with a soft border at its edge. Edit models re-render the crop as a whole; whole crop keeps their result intact and avoids doubled contours at the selection border.");
        ed.cropPasteSel.addEventListener("change", onChange);
        for (const c of [ed.cropContextSel, ed.cropFeatherSel, ed.cropFillSel]) c.addEventListener("change", onChange);
        ed.cropColorMatch.addEventListener("change", onChange);
        ed.cropOriginal.addEventListener("change", onChange);
        row("Context", ed.cropContextSel);
        row("Feather", ed.cropFeatherSel);
        row("Paste", ed.cropPasteSel, "Only the selection, or the whole returned rectangle");
        row("Fill", ed.cropFillSel);
        row("Original", ed.cropOriginal, "With a fill mode: crop_image becomes a batch of two, the filled crop first and the untouched crop second, so an edit model (Flux.2, Kontext) sees what is under the green area. The stitch uses the first result image. Not for VAE Encode chains.");
        row("Color match", ed.cropColorMatch, "Match the result's colors and brightness to the surroundings when it is stitched back");
        row("Align", ed.cropAlign, "Register the result to the unchanged surroundings before stitching (affine fit on the ring around the selection). Fixes doubled contours when the model shifted or slightly rescaled the content. Applied only when it measurably improves the match.");
        d.appendChild(sec);
        ed.infoEl = el("div", "ipc-info");
        d.appendChild(ed.infoEl);
    });
}
