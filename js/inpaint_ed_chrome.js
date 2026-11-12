// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_chrome.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the node widget, thumbs, tile / selection / mask draw helpers, the modal chrome (subbar, options bar): moved out of inpaint_canvas.js (item 56 S10b, docs/PLAN_SPLIT.md), text unchanged.

import { TIFF_EXT } from "./inpaint_tiff.js";
import { MIP_LEVELS, isTilePixels } from "./inpaint_tiles.js";
import { buildEditorModal } from "./inpaint_modal.js";
import { el, icon, iconButton, numberInput, selectInput } from "./inpaint_dom.js";

export class ChromePart {
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
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/") || TIFF_EXT.test(f.name || ""));
            if (!files.length) return;
            // no base yet or Ctrl held: (re)load the base; otherwise every file becomes a new image layer
            if (!this.width || e.ctrlKey) this.loadFile(files[0]);
            else this.addImageLayers(files, e.shiftKey ? "reference" : "none", e.shiftKey ? {} : { place: "fit" });
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
        // one composite of the whole image at thumbnail scale, from the pyramid: no second full-size pass
        const prev = this.viewPass;
        this.viewPass = { x: 0, y: 0, w: this.width, h: this.height, sx: w / this.width, sy: h / this.height, display: true };
        try {
            this.drawComposite(ctx);
        } finally {
            this.viewPass = prev;
        }
        if (this.sel && !this.selectionHasNoTiles()) {
            ctx.globalAlpha = 0.45;
            this.drawSelectionInto(ctx, w / this.width);
            ctx.globalAlpha = 1;
        }
        // a display pass of its own (C6 b): the chains it asked for are watched even when the screen's pass asked for none
        this.watchChains();
    }

    /** The selection is on tiles and holds none: nothing to draw, and no display mirror to make for it. */
    selectionHasNoTiles() {
        return isTilePixels(this.sel) && this.sel.tileCount === 0;
    }

    /**
     * The level a view at `scale` (destination pixels per source pixel) draws a tile store from: the
     * one whose cells are at least as dense as the destination, clamped to the mips a tile carries.
     */
    tileLevel(scale) {
        return scale > 0 && Number.isFinite(scale) ? Math.max(0, Math.min(MIP_LEVELS, Math.floor(-Math.log2(scale)))) : 0;
    }

    /**
     * Draw the part of a tile store the view shows into `ctx`, which carries the transform from image
     * coordinates to the destination (docs/PLAN_BCE.md §C3): the region canvas at the view's level,
     * built from the tiles' mips, instead of a display mirror of the whole thing and a Skia pyramid on
     * it. `x, y, w, h` is where the pixels sit in the image. False when there is nothing to draw from
     * (no tile of the region), which is a draw of nothing.
     */
    drawTilesInto(ctx, px, x, y, w, h, vp) {
        const fx = w / px.width, fy = h / px.height;
        const level = this.tileLevel(fx * vp.sx);
        // a pass for the screen (or the navigator) may show a stale picture of tiles whose mips are in the worker (C6 b);
        // any other pass (a sample the wand floods, a flattened preview) reads exact mips
        const display = !!(vp.screen || vp.display);
        const rc = px.regionCanvas([(vp.x - x) / fx, (vp.y - y) / fy, (vp.x + vp.w - x) / fx, (vp.y + vp.h - y) / fy], level, display);
        if (!rc) return false;
        // the canvas holds whole tiles, its last row and column the clamp past the pixels' own edge
        const sw = Math.min(rc.canvas.width, (px.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (px.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return false;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, x + rc.x * fx, y + rc.y * fy, sw * rc.f * fx, sh * rc.f * fy);
        return true;
    }

    /**
     * Draw the selection mask over the image rectangle it covers, into a context that already carries
     * the transform from image to screen coordinates. On tiles it is the part of the mask the view
     * shows, at the view's level, straight from the tiles (docs/PLAN_BCE.md §C3): no display mirror of
     * the whole selection, no GPU copy of one and no pyramid. On canvases it is the pyramid's level,
     * as it always was. `scale` is the destination pixels per image pixel.
     *
     * `region` is the image rectangle to cover ({ x, y, w, h }); the whole image when it is null,
     * which is what the navigator's thumbnail wants. `display` false reads exact levels, for a picture that is
     * not the screen (C6 c5: the prompt context, `screenshot`): a display read may show coarse cells of tiles whose
     * chains are still in the worker, and asks for them as screen chains, whose landing redraws the screen.
     */
    drawSelectionInto(ctx, scale, region = null, display = true) {
        if (this.selectionHasNoTiles()) return;
        if (!isTilePixels(this.sel)) {
            ctx.drawImage(this.displaySource(this.sel, scale, true), 0, 0, this.width, this.height);
            return;
        }
        const level = this.tileLevel(scale);
        const r = region || { x: 0, y: 0, w: this.width, h: this.height };
        // the screen's callers (the ants, the tint, the navigator, a live stroke's clip) draw with display (C6 b)
        const rc = this.sel.regionCanvas([r.x, r.y, r.x + r.w, r.y + r.h], level, display);
        if (!rc) return;
        // the canvas holds whole tiles, its last row and column the clamp past the image's edge: the
        // draw is cropped to the image, which is what the whole-image draw of the other path covers
        const sw = Math.min(rc.canvas.width, (this.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (this.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, rc.x, rc.y, sw * rc.f, sh * rc.f);
    }

    /**
     * Draw a layer's mask over the layer's rectangle or region, into a context that already carries
     * the transform from image to screen coordinates. Modelled on drawSelectionInto.
     */
    drawMaskInto(ctx, layer, scale, region = null, display = true) {
        if (!layer || !layer.maskPx) return;
        const maskPx = layer.maskPx;
        const isFilter = layer.kind === "filter";
        const lx = isFilter ? 0 : layer.x;
        const ly = isFilter ? 0 : layer.y;
        const lw = isFilter ? this.width : layer.w;
        const lh = isFilter ? this.height : layer.h;
        const fx = lw / maskPx.width, fy = lh / maskPx.height;
        if (!isTilePixels(maskPx)) {
            ctx.drawImage(this.displaySource(maskPx, scale * fx, display), lx, ly, lw, lh);
            return;
        }
        const level = this.tileLevel(scale * fx);
        const r = region || { x: lx, y: ly, w: lw, h: lh };
        const rc = maskPx.regionCanvas([(r.x - lx) / fx, (r.y - ly) / fy, (r.x + r.w - lx) / fx, (r.y + r.h - ly) / fy], level, display);
        if (!rc) return;
        const sw = Math.min(rc.canvas.width, (maskPx.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (maskPx.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return;
        ctx.drawImage(rc.canvas, 0, 0, sw, sh, lx + rc.x * fx, ly + rc.y * fy, sw * rc.f * fx, sh * rc.f * fy);
    }

    // ---- modal -------------------------------------------------------------

    /** The dialog itself: inpaint_modal.js builds it, one function per panel. */
    buildModal() {
        buildEditorModal(this);
    }

    buildSubbar() {
        const bar = el("div", "ipc-subbar");
        bar.hidden = true;
        this.subbar = bar;
        this.subModeButtons = {};
        const modes = [
            ["scale", "transform", "Move / scale: drag inside to move, corners keep aspect (Shift: free), edges scale one axis"],
            ["rotate", "rotate", "Rotate around the center (Shift snaps to 15°)"],
            ["distort", "distort", "Distort: drag the four corners freely (perspective)"],
            ["warp", "warp", "Warp: drag grid points to bend the layer"],
        ];
        for (const [id, ic, title] of modes) {
            const b = iconButton(ic, title, () => this.setTransformMode(id), id[0].toUpperCase() + id.slice(1));
            this.subModeButtons[id] = b;
            bar.appendChild(b);
        }
        bar.appendChild(el("span", "ipc-sep"));
        const gridLab = el("label", null, "Grid");
        this.warpGridSel = selectInput(["3", "4", "5", "6"], "4", "Warp grid size");
        this.warpGridSel.addEventListener("change", () => { if (this.pending && this.pending.mode === "warp") { this.cancelPending(); this.startPending("warp"); } });
        gridLab.appendChild(this.warpGridSel);
        bar.appendChild(gridLab);
        const angleLab = el("label", null, "Angle");
        this.angleInput = numberInput(0, -360, 360, "Rotation in degrees", 60);
        this.angleInput.step = 1;
        this.angleInput.addEventListener("input", () => { if (this.pending && this.pending.mode === "rotate") { this.pending.angle = (+this.angleInput.value || 0) * Math.PI / 180; this.draw(); } });
        angleLab.appendChild(this.angleInput);
        bar.appendChild(angleLab);
        bar.appendChild(el("span", "ipc-sep"));
        this.applyBtn = iconButton("check", "Apply the transform (Enter)", () => this.applyPending(), "Apply");
        this.applyBtn.classList.add("ipc-primary");
        bar.appendChild(this.applyBtn);
        this.cancelBtn = iconButton("close", "Cancel the transform (Esc)", () => this.cancelPending(), "Cancel");
        bar.appendChild(this.cancelBtn);
        // numeric geometry and one-click operations, shown in scale mode
        this.geoBox = el("span", "ipc-geo");
        this.geoInputs = {};
        for (const [k, title] of [["x", "Left edge"], ["y", "Top edge"], ["w", "Width"], ["h", "Height"]]) {
            const lab = el("label", null, k.toUpperCase());
            const inp = numberInput(0, -99999, 99999, `${title} of the layer in image pixels`, 62);
            inp.addEventListener("change", () => this.setLayerGeometry());
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
            this.geoInputs[k] = inp;
            lab.appendChild(inp);
            this.geoBox.appendChild(lab);
        }
        this.geoBox.appendChild(el("span", "ipc-sep"));
        this.geoBox.appendChild(iconButton("flipH", "Flip horizontally", () => this.flipLayer("h")));
        this.geoBox.appendChild(iconButton("flipV", "Flip vertically", () => this.flipLayer("v")));
        this.geoBox.appendChild(iconButton("rotCCW", "Rotate 90° counter-clockwise", () => this.rotateLayer90(-1)));
        this.geoBox.appendChild(iconButton("rotCW", "Rotate 90° clockwise", () => this.rotateLayer90(1)));
        this.geoBox.appendChild(iconButton("center", "Centre the layer on the canvas", () => this.centerLayer()));
        bar.appendChild(this.geoBox);
        // align and distribute: the selected layers to the box around them, or to the canvas (one layer: the canvas)
        this.alignBox = el("span", "ipc-geo");
        this.alignSep = this.alignBox.appendChild(el("span", "ipc-sep"));
        for (const [how, ic, title] of [["left", "alignLeft", "Align left edges"], ["hcenter", "alignHCenter", "Align horizontal centres"], ["right", "alignRight", "Align right edges"], ["top", "alignTop", "Align top edges"], ["vcenter", "alignVCenter", "Align vertical centres"], ["bottom", "alignBottom", "Align bottom edges"]]) {
            this.alignBox.appendChild(iconButton(ic, title, () => this.alignLayers(how, { to: this.alignToSel.value.toLowerCase() })));
        }
        this.distButtons = [
            iconButton("distH", "Distribute horizontally: equal gaps between the layers", () => this.distributeLayers("x", { to: this.alignToSel.value.toLowerCase() })),
            iconButton("distV", "Distribute vertically: equal gaps between the layers", () => this.distributeLayers("y", { to: this.alignToSel.value.toLowerCase() })),
        ];
        for (const b of this.distButtons) this.alignBox.appendChild(b);
        const toLab = el("label", null, "To");
        this.alignToSel = selectInput(["Selection", "Canvas"], "Selection", "Align and distribute within the box around the selected layers, or within the canvas");
        this.alignToSel.addEventListener("change", () => this.updateSubbar());
        toLab.appendChild(this.alignToSel);
        this.alignBox.appendChild(toLab);
        bar.appendChild(this.alignBox);
        this.subHint = el("span", "ipc-hint", "");
        bar.appendChild(this.subHint);
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) bar.addEventListener(type, (e) => e.stopPropagation());
        this.viewEl.appendChild(bar);
        this.transformMode = "scale";
        this.updateSubbar();
    }

    /** Options of the bucket, gradient and eyedropper tools (a second bar in the subbar's place). */
    buildOptsBar() {
        const bar = el("div", "ipc-subbar");
        bar.hidden = true;
        this.optsBar = bar;
        this.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
        this.gradientOpts = { type: "linear", to: "transparent" };
        this.removeOpts = { sample: "image" };
        this.patchOpts = { mode: "source", blend: 100 };
        this.moveOpts = { mode: "move", blend: "edge" };
        this.liquifyOpts = { mode: "push", strength: 50, showFreeze: true };
        // the brush settings move from the top bar into this bar and show for the tools that use them
        const moveCtl = (labelEl, forTools) => { if (!labelEl) return; labelEl.dataset.for = forTools; bar.appendChild(labelEl); };
        moveCtl(this.sizeCtl && this.sizeCtl.input.parentElement, "select deselect paint erase smudge tone clone heal remove liquify");
        moveCtl(this.hardCtl && this.hardCtl.input.parentElement, "paint erase smudge tone clone heal remove liquify");
        // one call: a second one for "shape" overwrote the list and hid the slider for the brushes (e0c00a7 to 0.1.31)
        moveCtl(this.opacCtl && this.opacCtl.input.parentElement, "paint erase clone heal bucket gradient shape");
        moveCtl(this.flowCtl && this.flowCtl.input.parentElement, "paint erase");
        moveCtl(this.colorLabel, "paint bucket gradient shape");
        moveCtl(this.tipLabel, "paint erase smudge tone clone heal");
        for (const e of this.tipOnlyEls || []) moveCtl(e, "paint erase");
        this.syncTipControls();
        const row = (cls, ...nodes) => { const lab = el("label", null); lab.dataset.for = cls; for (const n of nodes) lab.appendChild(typeof n === "string" ? el("span", null, n) : n); bar.appendChild(lab); return lab; };
        const tol = document.createElement("input");
        tol.type = "range"; tol.min = 0; tol.max = 255; tol.value = this.fillOpts.tolerance; tol.title = "Tolerance: how different a colour may be to count as the same area (0..255 per channel)";
        const tolVal = el("span", null, String(this.fillOpts.tolerance));
        tol.addEventListener("input", () => { this.fillOpts.tolerance = +tol.value; tolVal.textContent = tol.value; });
        row("bucket wand", "Tolerance", tol, tolVal);
        const cont = document.createElement("input");
        cont.type = "checkbox"; cont.checked = true; cont.title = "Contiguous: only the connected area under the cursor; off fills every similar colour of the image";
        cont.addEventListener("change", () => { this.fillOpts.contiguous = cont.checked; });
        row("bucket wand", cont, "Contiguous");
        const sample = selectInput(["image", "layer"], "image", "What the fill looks at: the visible image (all layers) or the active layer alone");
        sample.addEventListener("change", () => { this.fillOpts.sample = sample.value; });
        row("bucket eyedropper wand", "Sample", sample);
        // item 58: the eyedropper takes the pixel under the cursor or the mean of the 3 x 3 / 5 x 5 around it (pickColor;
        // Alt+click with the paint brush too), kept like the pressure curve; Point unless the user chose otherwise
        this.eyedropperSize = 1;
        try { const n = +localStorage.getItem("ipc.eyedropperSize"); if (n === 3 || n === 5) this.eyedropperSize = n; } catch (_) { /* no storage */ }
        const dsize = selectInput([{ value: "1", label: "Point" }, { value: "3", label: "3 × 3" }, { value: "5", label: "5 × 5" }], String(this.eyedropperSize),
            "Size: the one pixel under the cursor, or the average of the 3 × 3 or 5 × 5 pixels around it, so grain or noise does not hand you a stray pixel's colour");
        dsize.addEventListener("change", () => {
            this.eyedropperSize = +dsize.value === 3 || +dsize.value === 5 ? +dsize.value : 1;
            try { localStorage.setItem("ipc.eyedropperSize", String(this.eyedropperSize)); } catch (_) { /* ignore */ }
            this.root.focus({ preventScroll: true });
        });
        this.eyedropperSizeSel = dsize;
        row("eyedropper", "Size", dsize);
        const gtype = selectInput(["linear", "radial"], "linear", "Gradient shape");
        gtype.addEventListener("change", () => { this.gradientOpts.type = gtype.value; });
        row("gradient", "Type", gtype);
        const gto = selectInput(["transparent", "white", "black"], "transparent", "What the colour fades to");
        gto.addEventListener("change", () => { this.gradientOpts.to = gto.value; });
        row("gradient", "To", gto);
        this.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
        const skind = selectInput(["rectangle", "ellipse", "polygon", "polyline", "bezier", "freehand"], "rectangle",
            "What the shape tool draws. Rectangle, ellipse and freehand are dragged; polygon, polyline and Bezier are clicked point by point.");
        skind.addEventListener("change", () => { this.cancelShape(); this.shapeOpts.kind = skind.value; this.updateOptsBar(); this.draw(); });
        row("shape", "Kind", skind);
        const sfill = document.createElement("input");
        sfill.type = "checkbox"; sfill.checked = true; sfill.title = "Fill the shape with the paint colour";
        sfill.addEventListener("change", () => { this.shapeOpts.fill = sfill.checked; });
        this.shapeFillRow = row("shape", sfill, "Fill");
        const sstroke = document.createElement("input");
        sstroke.type = "checkbox"; sstroke.title = "Draw the outline as well, in its own colour";
        sstroke.addEventListener("change", () => { this.shapeOpts.stroke = sstroke.checked; this.updateOptsBar(); });
        this.shapeStrokeRow = row("shape", sstroke, "Outline");
        const swidth = document.createElement("input");
        swidth.type = "number"; swidth.className = "ipc-num"; swidth.min = 1; swidth.max = 500; swidth.value = this.shapeOpts.width;
        swidth.style.width = "56px"; swidth.title = "Outline width in image pixels";
        swidth.addEventListener("change", () => { this.shapeOpts.width = Math.max(1, Math.min(500, +swidth.value || 1)); swidth.value = this.shapeOpts.width; });
        this.shapeWidthRow = row("shape", "Width", swidth);
        const scolor = document.createElement("input");
        scolor.type = "color"; scolor.value = this.shapeOpts.color; scolor.title = "Outline colour (the fill uses the paint colour)";
        scolor.addEventListener("input", () => { this.shapeOpts.color = scolor.value; });
        this.shapeColorRow = row("shape", scolor);
        const sradius = document.createElement("input");
        sradius.type = "number"; sradius.className = "ipc-num"; sradius.min = 0; sradius.max = 4096; sradius.value = 0;
        sradius.style.width = "56px"; sradius.title = "Corner radius of the rectangle, in image pixels";
        sradius.addEventListener("change", () => { this.shapeOpts.radius = Math.max(0, +sradius.value || 0); sradius.value = this.shapeOpts.radius; });
        this.shapeRadiusRow = row("shape", "Radius", sradius);
        this.smudgeOpts = { strength: 60, sample: "layer", length: 0, finger: false, mode: "smudge" };
        this.cloneOpts = { sample: "image", aligned: true, angle: 0, scale: 100, flipX: false, flipY: false, overlay: true };
        const str = document.createElement("input");
        str.type = "range"; str.min = 1; str.max = 100; str.value = this.smudgeOpts.strength; str.title = "Strength: how much of the picked-up paint is dragged along";
        const strVal = el("span", null, this.smudgeOpts.strength + "%");
        str.addEventListener("input", () => { this.smudgeOpts.strength = +str.value; strVal.textContent = str.value + "%"; });
        const smode = selectInput(["smudge", "blur", "sharpen"], "smudge", "Mode: smudge drags the paint along; blur softens and sharpen crisps what the brush passes over, as much as the strength says (Length and Finger are the smudge's)");
        smode.addEventListener("change", () => { this.smudgeOpts.mode = smode.value; this.root.focus({ preventScroll: true }); this.updateOptsBar(); });
        this.smudgeModeSel = smode;
        row("smudge", "Mode", smode);
        row("smudge", "Strength", str, strVal);
        // the pen (PLAN_0_1_31 §4 step 5): how its pressure maps to size, and a stabiliser for a steady line
        const pcurve = selectInput(["linear", "soft", "hard"], this.pressureCurve, "Pressure: how a pen's pressure sizes the brush. Soft reaches full size with a light hand, hard needs a firm one");
        pcurve.addEventListener("change", () => { this.pressureCurve = pcurve.value; try { localStorage.setItem("ipc.pressureCurve", pcurve.value); } catch (_) { /* ignore */ } this.root.focus({ preventScroll: true }); });
        row("paint erase smudge tone clone heal liquify", "Pressure", pcurve);
        const stab = document.createElement("input");
        stab.type = "range"; stab.min = 0; stab.max = 60; stab.value = this.stabiliser;
        stab.title = "Stabiliser: the brush follows the cursor on a string this many screen pixels long, so a trembling hand draws a calm line (0: off). The release finishes the line to the cursor";
        const stabVal = el("span", null, this.stabiliser ? this.stabiliser + "px" : "off");
        stab.addEventListener("input", () => { this.stabiliser = +stab.value; stabVal.textContent = this.stabiliser ? this.stabiliser + "px" : "off"; try { localStorage.setItem("ipc.stabiliser", String(this.stabiliser)); } catch (_) { /* ignore */ } });
        row("paint erase smudge tone clone heal liquify", "Stabiliser", stab, stabVal);
        const slen = document.createElement("input");
        slen.type = "range"; slen.min = 0; slen.max = 100; slen.value = this.smudgeOpts.length;
        slen.title = "Length: how much of the picked-up paint the brush keeps from dab to dab. 0 leaves it where it is laid down; towards 100 it goes on to the end of the stroke";
        const slenVal = el("span", null, this.smudgeOpts.length + "%");
        slen.addEventListener("input", () => { this.smudgeOpts.length = +slen.value; slenVal.textContent = slen.value + "%"; });
        row("smudge", "Length", slen, slenVal);
        const ssample = selectInput(["layer", "below", "image"], "layer", "What the smudge picks up: the active layer alone, the layers up to it (below), or the visible image (all layers), smudged into the active layer. On the base it always takes the image and paints into a new layer");
        ssample.addEventListener("change", () => { this.smudgeOpts.sample = ssample.value; this.root.focus({ preventScroll: true }); });
        this.smudgeSampleSel = ssample;
        row("smudge", "Sample", ssample);
        const sfinger = document.createElement("input");
        sfinger.type = "checkbox"; sfinger.title = "Finger painting: every stroke starts with the paint colour on the brush";
        sfinger.addEventListener("change", () => { this.smudgeOpts.finger = sfinger.checked; });
        row("smudge", sfinger, "Finger");
        // dodge / burn / sponge (PLAN_0_1_31 §4 step 9): GIMP's curves, Photoshop's options; the smudge's stroke engine
        this.toneOpts = { mode: "dodge", range: "midtones", exposure: 50, protect: true, vibrance: true, sample: "layer" };
        const tmode = selectInput(["dodge", "burn", "saturate", "desaturate"], "dodge", "Dodge lightens, burn darkens; saturate and desaturate are the sponge. Alt while pressing swaps dodge and burn, saturate and desaturate, for that stroke");
        tmode.addEventListener("change", () => { this.toneOpts.mode = tmode.value; this.root.focus({ preventScroll: true }); this.updateOptsBar(); });
        this.toneModeSel = tmode;
        row("tone", "Mode", tmode);
        const trange = selectInput(["shadows", "midtones", "highlights"], "midtones", "Range: which tones dodge and burn act on most");
        trange.addEventListener("change", () => { this.toneOpts.range = trange.value; this.root.focus({ preventScroll: true }); });
        this.toneRangeRow = row("tone", "Range", trange);
        const texp = document.createElement("input");
        texp.type = "range"; texp.min = 1; texp.max = 100; texp.value = this.toneOpts.exposure;
        texp.title = "Exposure: how strongly one stroke lightens, darkens or changes the saturation. A stroke does not build up over itself; paint again to go further";
        const texpVal = el("span", null, this.toneOpts.exposure + "%");
        texp.addEventListener("input", () => { this.toneOpts.exposure = +texp.value; texpVal.textContent = texp.value + "%"; });
        this.toneExpName = el("span", null, "Exposure");
        row("tone", this.toneExpName, texp, texpVal);
        const tprotect = document.createElement("input");
        tprotect.type = "checkbox"; tprotect.checked = true;
        tprotect.title = "Protect tones: the curve moves the brightest channel and the other two keep their share of it, so colours keep their hue (a strong highlights dodge or shadows burn can still clip). Off: each channel on its own, as GIMP does";
        tprotect.addEventListener("change", () => { this.toneOpts.protect = tprotect.checked; });
        this.toneProtectRow = row("tone", tprotect, "Protect tones");
        const tvib = document.createElement("input");
        tvib.type = "checkbox"; tvib.checked = true;
        tvib.title = "Vibrance: dull colours gain more saturation than vivid ones";
        tvib.addEventListener("change", () => { this.toneOpts.vibrance = tvib.checked; });
        this.toneVibranceRow = row("tone", tvib, "Vibrance");
        const tsample = selectInput(["layer", "below", "image"], "layer", "What the brush works from: the active layer alone, the layers up to it (below), or the visible image (all layers), written into the active layer. On the base it always takes the image and paints into a new layer");
        tsample.addEventListener("change", () => { this.toneOpts.sample = tsample.value; this.root.focus({ preventScroll: true }); });
        this.toneSampleSel = tsample;
        row("tone", "Sample", tsample);
        const csample = selectInput(["image", "layer"], "image", "Where the copied pixels come from: the visible image (all layers) or the active layer alone");
        csample.addEventListener("change", () => { this.cloneOpts.sample = csample.value; });
        row("clone heal", "Sample", csample);
        const rsample = selectInput(["image", "layer"], "image", "What Remove fills from: the visible image (all layers) or the active layer alone. The fill goes into the active layer; on the base it always takes the image and paints into a new layer");
        rsample.addEventListener("change", () => { this.removeOpts.sample = rsample.value; this.root.focus({ preventScroll: true }); });
        this.removeSampleSel = rsample;
        row("remove", "Sample", rsample);
        const pmode = selectInput(["source", "destination"], "source", "Source: the selection is repaired with what lies where you drag it. Destination: what is selected is copied to where you drag it");
        pmode.addEventListener("change", () => { this.patchOpts.mode = pmode.value; this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.patchModeSel = pmode;
        row("patch", "Mode", pmode);
        const pblend = document.createElement("input");
        pblend.type = "range"; pblend.min = 0; pblend.max = 100; pblend.value = 100;
        pblend.title = "Blend: at 100 % the patch takes on the colour and light around it; at 0 % its texture is copied as it is";
        const pblendVal = el("span", null, "100%");
        pblend.addEventListener("input", () => { this.patchOpts.blend = +pblend.value; pblendVal.textContent = pblend.value + "%"; });
        pblend.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        row("patch", "Blend", pblend, pblendVal);
        const mmode = selectInput(["move", "extend"], "move", "Move: the selection lands where you let go and LaMa fills where it was. Extend: a copy lands there and the original stays");
        mmode.addEventListener("change", () => { this.moveOpts.mode = mmode.value; if (mmode.value === "move") this.warmRemove(); this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.moveModeSel = mmode;
        row("contentmove", "Mode", mmode);
        const mblend = selectInput(["edge", "all"], "edge", "Edge: a band inside the selection's edge takes on the new place, what you moved stays exactly as it was. All: the whole piece takes on the new place's colour and light (an object moved into shade darkens)");
        mblend.addEventListener("change", () => { this.moveOpts.blend = mblend.value; this.root.focus({ preventScroll: true }); });
        this.moveBlendSel = mblend;
        row("contentmove", "Blend", mblend);
        // liquify (PLAN_0_1_31 §5 step 5): the mode, how strongly a dab moves the picture, and Restore all
        const lmode = selectInput(["push", "grow", "shrink", "swirlcw", "swirlccw", "restore", "freeze", "thaw"], "push", "Push drags the picture along with the brush; grow and shrink swell or pinch what is under it, swirl turns it, restore brings back what the session started from; freeze paints what should stay where it is (red) and thaw frees it again. Grow, shrink, swirl and restore keep working while the button is held still. Alt while pressing reverses grow / shrink, the swirl, and freeze / thaw");
        for (const o of lmode.options) o.textContent = { swirlcw: "swirl ↻", swirlccw: "swirl ↺" }[o.value] || o.value;   // clockwise, counter-clockwise
        lmode.addEventListener("change", () => { this.liquifyOpts.mode = lmode.value; this.updateOptsBar(); this.root.focus({ preventScroll: true }); });
        this.liquifyModeSel = lmode;
        row("liquify", "Mode", lmode);
        const lstr = document.createElement("input");
        lstr.type = "range"; lstr.min = 1; lstr.max = 100; lstr.value = this.liquifyOpts.strength;
        lstr.title = "Strength: how far a dab moves the picture (push: at 100 % the picture under the brush's centre follows the cursor all the way)";
        const lstrVal = el("span", null, this.liquifyOpts.strength + "%");
        lstr.addEventListener("input", () => { this.liquifyOpts.strength = +lstr.value; lstrVal.textContent = lstr.value + "%"; });
        lstr.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        row("liquify", "Strength", lstr, lstrVal);
        row("liquify", iconButton("undo", "Restore all: the active layer as it was when the Liquify session began (inside the selection, when there is one). One undo step",
            () => { this.liquifyRestoreAll(); this.root.focus({ preventScroll: true }); }, "Restore all"));
        // the freeze's three controls in one row: icon buttons, so the bar stays one line
        const lshow = document.createElement("input");
        lshow.type = "checkbox"; lshow.checked = true; lshow.title = "Show the frozen parts of the active layer in red while Liquify is the tool";
        lshow.addEventListener("change", () => { this.liquifyOpts.showFreeze = lshow.checked; this.draw(); this.root.focus({ preventScroll: true }); });
        row("liquify", "Freeze", lshow,
            iconButton("close", "Clear freeze: every part of the active layer free to move again", () => { this.liquifyClearFreeze(); this.root.focus({ preventScroll: true }); }),
            iconButton("invert", "Invert freeze: what was frozen is free, and the rest of the active layer frozen", () => { this.liquifyInvertFreeze(); this.root.focus({ preventScroll: true }); }));
        const aligned = document.createElement("input");
        aligned.type = "checkbox"; aligned.checked = true; aligned.title = "Aligned: the offset between source and brush stays the same for every stroke; off starts every stroke at the source point again";
        aligned.addEventListener("change", () => { this.cloneOpts.aligned = aligned.checked; });
        row("clone heal", aligned, "Aligned");
        // the source turned, scaled and mirrored against where it lands (PLAN_0_1_31 §4 step 4)
        const numIn = (min, max, value, title, set) => {
            const n = document.createElement("input");
            n.type = "number"; n.className = "ipc-num"; n.min = min; n.max = max; n.value = value; n.style.width = "52px"; n.title = title;
            n.addEventListener("change", () => { const v = Math.max(min, Math.min(max, Math.round(+n.value || 0))); n.value = v; set(v); this.draw(); });
            return n;
        };
        this.cloneAngleInput = numIn(-180, 180, 0, "Angle: the source turned by this many degrees where it lands", (v) => { this.cloneOpts.angle = v; });
        row("clone heal", "Angle", this.cloneAngleInput, "\u00b0");
        this.cloneScaleInput = numIn(10, 400, 100, "Scale: the source this big where it lands, in percent", (v) => { this.cloneOpts.scale = v; });
        row("clone heal", "Scale", this.cloneScaleInput, "%");
        const flip = (key, title) => {
            const c = document.createElement("input");
            c.type = "checkbox"; c.title = title;
            c.addEventListener("change", () => { this.cloneOpts[key] = c.checked; this.draw(); });
            return c;
        };
        row("clone heal", flip("flipX", "Mirror the source left to right"), "Flip H");
        row("clone heal", flip("flipY", "Mirror the source top to bottom"), "Flip V");
        const ghost = document.createElement("input");
        ghost.type = "checkbox"; ghost.checked = true; ghost.title = "Overlay: show what the brush would copy under it, half transparent (while the source is in view)";
        ghost.addEventListener("change", () => { this.cloneOpts.overlay = ghost.checked; this.draw(); });
        row("clone heal", ghost, "Overlay");
        // the Canvas tool's frame (PLAN_0_1_31 §7, 23b): the aspect, the angle, the straighten line, the lines, apply
        const asp = selectInput(["free", "original", "1:1", "4:3", "3:2", "16:9", "5:4", "custom"], this.frameAspect,
            "The frame's aspect: choosing one fits the largest such frame into the (turned) picture; X turns it on its side");
        // S: the keys (Enter, X, Esc) go back to the editor after a pick
        asp.addEventListener("change", () => { this.frameAspect = asp.value; this.frameAspectFlip = false; this.fitFrameToAspect(); this.root.focus({ preventScroll: true }); });
        this.frameAspectSel = asp;
        row("canvas", "Aspect", asp);
        const cw = numberInput(this.frameCustom[0], 1, 100000, "Custom aspect: width", 48), chh = numberInput(this.frameCustom[1], 1, 100000, "Custom aspect: height", 48);
        const setCustom = () => { this.frameCustom = [Math.max(1, +cw.value || 1), Math.max(1, +chh.value || 1)]; if (this.frameAspect === "custom") this.fitFrameToAspect(); };
        cw.addEventListener("change", setCustom); chh.addEventListener("change", setCustom);
        this.frameCustomRow = row("canvas", cw, ":", chh);
        row("canvas", iconButton("rotCW", "Turn the aspect on its side (X)", () => { this.swapFrameAspect(); this.setStatus(this.frameStatus()); }));
        const ang = numberInput(0, -45, 45, "The picture's angle in degrees (clockwise); the frame fits inside the turned picture", 56);
        ang.step = 0.1;
        ang.addEventListener("change", () => this.setFrameAngle(+ang.value || 0));
        ang.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.setFrameAngle(+ang.value || 0); this.root.focus({ preventScroll: true }); this.applyFrame(); } });
        const rng = document.createElement("input");
        rng.type = "range"; rng.min = -45; rng.max = 45; rng.step = 0.1; rng.value = 0;
        rng.title = "Turn the picture: the frame fits inside it (drag outside the frame on the canvas does the same)";
        rng.addEventListener("input", () => this.setFrameAngle(+rng.value || 0));
        rng.addEventListener("change", () => this.root.focus({ preventScroll: true }));
        this.frameAngleInput = ang; this.frameAngleRange = rng;
        row("canvas", "Angle", rng, ang);
        this.frameStraightenBtn = iconButton("ruler", "Straighten: draw a line along something that should be level or plumb (Ctrl+drag on the canvas does the same)", () => {
            this.frameStraighten = !this.frameStraighten;
            this.syncFrameControls();
            this.setStatus(this.frameStraighten ? "Draw a line along something that should be level or plumb." : this.frameStatus());
        }, "Straighten");
        row("canvas", this.frameStraightenBtn);
        const ov = selectInput(["thirds", "golden", "grid", "diagonal", "none"], this.frameOverlay, "Lines over the frame to compose by");
        ov.addEventListener("change", () => { this.frameOverlay = ov.value; try { localStorage.setItem("ipc.cropOverlay", ov.value); } catch (_) { /* no storage */ } this.draw(); this.root.focus({ preventScroll: true }); });
        row("canvas", "Lines", ov);
        row("canvas", iconButton("check", "Apply the frame (Enter, or a double click inside it)", () => this.applyFrame(), "Apply"));
        row("canvas", iconButton("close", "Reset the frame (Esc)", () => { this.resetFrame(); this.setStatus(this.frameStatus()); }, "Reset"));
        this.optsHint = el("span", "ipc-hint", "");
        bar.appendChild(this.optsHint);
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) bar.addEventListener(type, (e) => e.stopPropagation());
        this.viewEl.appendChild(bar);
    }

    updateOptsBar() {
        if (!this.optsBar) return;
        const tool = this.tool;
        const on = ["select", "deselect", "paint", "erase", "bucket", "gradient", "eyedropper", "smudge", "tone", "clone", "heal", "remove", "patch", "contentmove", "liquify", "wand", "shape", "canvas"].includes(tool);
        this.optsBar.hidden = !on;
        if (!on) return;
        for (const lab of this.optsBar.querySelectorAll("label")) lab.hidden = !(lab.dataset.for || "").split(" ").includes(tool);
        if (tool === "shape") {
            const o = this.shapeOpts, open = o.kind === "polyline";
            this.shapeFillRow.hidden = open;                       // an open line has nothing to fill
            this.shapeStrokeRow.hidden = open;
            this.shapeWidthRow.hidden = !(o.stroke || open);
            this.shapeColorRow.hidden = !(o.stroke || open);
            this.shapeRadiusRow.hidden = o.kind !== "rectangle";
        }
        if (tool === "tone") {
            const sponge = this.toneOpts.mode === "saturate" || this.toneOpts.mode === "desaturate";
            this.toneRangeRow.hidden = sponge;
            this.toneProtectRow.hidden = sponge;
            this.toneVibranceRow.hidden = this.toneOpts.mode !== "saturate";
            this.toneExpName.textContent = sponge ? "Amount" : "Exposure";
        }
        const shapeHints = {
            rectangle: "Drag a rectangle; Shift keeps it square, Alt draws from the centre",
            ellipse: "Drag an ellipse; Shift keeps it a circle, Alt draws from the centre",
            polygon: "Click the corners, click the first point or press Enter to close",
            polyline: "Click the corners, press Enter to finish the line",
            bezier: "Click a point, or drag while clicking to curve the line; Enter finishes",
            freehand: "Draw with the cursor held down",
        };
        if (tool === "canvas") this.syncFrameControls();
        const hints = { canvas: "Edges crop or extend, outside turns, Ctrl+drag straightens; Enter or a double click applies, Esc resets", shape: shapeHints[this.shapeOpts.kind] || "", select: "Paint to select, Alt subtracts", deselect: "Paint to deselect", paint: "Alt+click picks a colour, Shift+click draws a line", erase: "Shift+click draws a line", wand: "Click to select the similar area; Shift adds, Alt subtracts, Shift+Alt intersects", bucket: "Click to fill; Shift+F fills the whole selection", gradient: "Drag from the colour to where it should have faded", eyedropper: "Click to pick a colour", smudge: this.smudgeOpts && this.smudgeOpts.mode === "blur" ? "Paint over what should soften" : this.smudgeOpts && this.smudgeOpts.mode === "sharpen" ? "Paint over what should crisp up; a little goes a long way" : "Drag across an edge to soften it", tone: this.toneHint(), remove: "Brush over what should go: it is filled from its surroundings when you let go", patch: this.patchOpts.mode === "destination" ? "Lasso what to copy, then drag the selection to where the copy should go" : "Lasso the spot, then drag the selection to where the picture is right", contentmove: this.moveOpts.mode === "extend" ? "Lasso what to copy, then drag it: the copy blends in where you let go" : "Lasso the object, then drag it: it blends in where you let go, and its old place is filled", liquify: this.liquifyHint(), clone: this.cloneSource ? "Paint to copy from the source (Alt+click moves it)" : "Alt+click sets the source point", heal: this.cloneSource ? "Paint to repair with the source's texture (Alt+click moves it)" : "Alt+click sets the source point" };
        this.optsHint.textContent = hints[tool] || "";
    }

    updateSubbar() {
        if (!this.subbar) return;
        const on = this.tool === "transform";
        this.subbar.hidden = !on;
        if (!on) return;
        const mode = this.pending ? this.pending.mode : this.transformMode;
        for (const [id, b] of Object.entries(this.subModeButtons)) b.classList.toggle("ipc-active", id === mode);
        const pending = !!this.pending;
        this.applyBtn.hidden = !pending;
        this.cancelBtn.hidden = !pending;
        this.warpGridSel.parentElement.hidden = mode !== "warp";
        this.angleInput.parentElement.hidden = mode !== "rotate";
        if (this.pending && this.pending.mode === "rotate") this.angleInput.value = Math.round(this.pending.angle * 180 / Math.PI);
        const active = this.activeLayer();
        if (this.geoBox) {
            this.geoBox.hidden = !(mode === "scale" && active && !pending && !this.multiSelected());
            if (!this.geoBox.hidden && document.activeElement && !this.geoBox.contains(document.activeElement)) for (const k of ["x", "y", "w", "h"]) this.geoInputs[k].value = Math.round(active[k]);
        }
        const many = !pending && this.multiSelected() ? this.selectedLayers().length : 0;
        if (this.alignBox) {
            const movable = this.alignTargets().length;
            this.alignBox.hidden = !(mode === "scale" && !pending && movable);
            this.alignToSel.parentElement.hidden = movable < 2;
            this.alignSep.hidden = !!(this.geoBox && this.geoBox.hidden);   // the bar's own separator stands before it then
            const toCanvas = movable < 2 || this.alignToSel.value === "Canvas";
            for (const b of this.distButtons) b.disabled = movable < (toCanvas ? 2 : 3);
        }
        this.subHint.textContent = !active ? "Select a layer first" : many ? `${many} layers selected: drag moves them, the handles scale them together, arrow keys nudge` : (pending ? (mode === "rotate" ? "Drag outside to rotate (Shift snaps), handles scale, inside moves. Enter applies, Esc cancels" : "Enter applies, Esc cancels") : (mode === "scale" ? "Drag outside a corner to rotate, arrow keys nudge" : "Click a mode to start"));
    }
}
