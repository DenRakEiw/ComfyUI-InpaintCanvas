// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_text.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the text tool: the inline edit box, text layers and fonts: moved out of inpaint_canvas.js (item 56 S3, docs/PLAN_SPLIT.md), text unchanged.

import { FONT_CATEGORIES, TEXT_DEFAULTS, addUserFont, fontCss, fontList, loadFontList, renderText, textAngle, textFrame } from "./inpaint_text.js";
import { SUBFOLDER, uploadBlob } from "./inpaint_upload.js";
import { pixelMap, xfApply, xfInv, xfMul, xfRotate } from "./inpaint_resample.js";
import { failKind } from "./inpaint_status.js";
import { MASK_RGB } from "./inpaint_consts.js";
import { normDeg, orientOps, spinText, textBox, textStartFraction, textTotalAngle } from "./inpaint_orient.js";
import { el, miniButton, numberInput, selectInput } from "./inpaint_dom.js";

export class TextPart {
    /** Edit a text layer right on the canvas: a transparent text box over the layer, the layer renders live. */
    beginTextEdit(layer) {
        if (!layer || layer.kind !== "text" || !layer.text) return;
        if (this.textEdit) this.endTextEdit(true);
        const ta = document.createElement("textarea");
        ta.className = "ipc-textedit";
        ta.value = layer.text.content;
        ta.spellcheck = false;
        this.textEdit = { layer, ta, before: this.snapshot({ kind: "text", id: layer.id }) };
        for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu", "mousedown", "mouseup"]) ta.addEventListener(type, (e) => e.stopPropagation());
        ta.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); this.endTextEdit(false); }
            else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.endTextEdit(true); }
        });
        ta.addEventListener("input", () => { layer.text.content = ta.value; this.scheduleTextRender(layer); });
        ta.addEventListener("blur", () => { if (this.textEdit && this.textEdit.ta === ta) this.endTextEdit(true); });
        this.viewEl.appendChild(ta);
        this.positionTextEdit();
        // focus after the click's default actions have run (a mousedown on the canvas would blur it again)
        setTimeout(() => { if (this.textEdit && this.textEdit.ta === ta) { ta.focus(); ta.select(); } }, 0);
        this.setStatus("Editing the text on the canvas: Enter applies, Shift+Enter starts a new line, Esc cancels.");
    }

    positionTextEdit() {
        const te = this.textEdit;
        if (!te) return;
        const l = te.layer, t = l.text, dpr = window.devicePixelRatio || 1;
        // at the corner the text starts at, as big as the upright text, turned (and mirrored) as the text is
        const f = textStartFraction(l);
        const [sx, sy] = this.imageToScreen(l.x + f[0] * l.w, l.y + f[1] * l.h);
        const res = t.res || 2;
        const k = l.px && l.px.width > 1 ? l.w / (l.px.width / res) : 1;
        const z = this.view.scale / dpr;
        const fs = Math.max(4, t.size * k * z);
        const pad = Math.max(0, (t.size * 0.15 + (t.outline || 0)) * k * z);
        const [uw, uh] = textBox(l);
        const turn = this.view.angle * 180 / Math.PI + textTotalAngle(t);
        Object.assign(te.ta.style, {
            left: `${sx / dpr}px`, top: `${sy / dpr}px`,
            width: `${Math.max(24, uw / res * k * z + 2)}px`, height: `${Math.max(fs * 1.4, uh / res * k * z + 2)}px`,
            padding: `${pad}px`, fontSize: `${fs}px`, lineHeight: String(t.lineHeight || 1.2),
            fontFamily: `"${fontCss(t)}", sans-serif`, fontWeight: t.bold ? "700" : "400", fontStyle: t.italic ? "italic" : "normal",
            textAlign: t.align || "left", letterSpacing: `${(t.letterSpacing || 0) * k * z}px`,
            transform: `${turn ? `rotate(${turn}deg)` : ""}${t.flip ? " scaleX(-1)" : ""}`.trim(), transformOrigin: "0 0",
        });
    }

    endTextEdit(commit) {
        const te = this.textEdit;
        if (!te) return;
        this.textEdit = null;
        te.ta.remove();
        clearTimeout(te.layer._textTimer);
        // the step taken at the start holds a PNG of the layer: pushed when the content changed,
        // released otherwise (a cancel or an unchanged Enter left its blob URL behind for good)
        const changed = commit && te.layer.text.content !== te.before.text.content;
        if (!commit) te.layer.text.content = te.before.text.content;
        if (changed) this.pushUndoSnapshot(te.before, { label: "Edit text" }); else this.releaseSnapshot(te.before);
        this.renderTextLayer(te.layer);
        this.renderLayers();
        this.root.focus({ preventScroll: true });
    }

    // ---- text layers -------------------------------------------------------------------

    /** Add a text layer with its top left at (ix, iy) and focus its text field. */
    async addTextLayer(ix, iy) {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.textCounter = (this.textCounter || 0) + 1;
        const t = { ...TEXT_DEFAULTS, ...(this.textDefaults || {}) };
        if (!this.textDefaults) t.size = Math.max(12, Math.round(Math.min(this.width, this.height) / 12));
        t.color = this.color;
        const layer = this.addLayer({ name: "Text " + this.textCounter, kind: "text", ref: null, text: t, px: this.pixels.Layer.empty(1, 1), x: Math.round(ix), y: Math.round(iy), w: 1, h: 1, dirty: true });
        await loadFontList();
        await this.renderTextLayer(layer, { keepScale: false });
        this.renderLayers();
        const ta = this.layerList.querySelector(`[data-layer="${layer.id}"] textarea`);
        if (ta) { ta.focus(); ta.select(); }
        this.setStatus(`${layer.name} added. Type in the layer panel; move it with the text tool or T, scale and rotate with T.`);
        return layer;
    }

    /**
     * Render a text layer's description into its pixels, keeping the scale the user gave it. The corner the text starts
     * at (its upright top left) stays where it is, so a text grows away from it whatever its turn and angle; after an
     * angle change (`layer._textPivot` "centre", set with the change) the middle of the layer stays instead. `adopt(layer,
     * before)` runs with the new pixels in place and before anything is drawn (`before` the old rectangle and pixel size).
     */
    async renderTextLayer(layer, { keepScale = true, adopt = null } = {}) {
        if (!layer || layer.kind !== "text" || !layer.text) return;
        const token = (layer._textToken = (layer._textToken || 0) + 1);
        layer._textRendering = token;   // a text undo step taken meanwhile knows its pixels are behind
        const r = await renderText(layer.text);
        const { canvas, res, missing } = r;
        if (layer._textRendering === token) layer._textRendering = 0;
        // a newer render, a layer gone, or a text made pixels meanwhile (distort, warp): this one is not wanted
        if (layer._textToken !== token || !this.layers.includes(layer) || layer.kind !== "text" || !layer.text) return;
        const oldRes = (layer.text && layer.text.res) || 2;
        const had = layer.px && layer.px.width > 1;
        let k = keepScale && had ? layer.w / (layer.px.width / oldRes) : 1;
        // an unscaled text stays unscaled: the layer's size is rounded, and a scale derived from it would drift
        if (had && Math.abs(k - 1) * (layer.px.width / oldRes) < 1) k = 1;
        // the point that stays: given with an angle change (read before the description changed), else read from the
        // pixels shown now, before they are replaced
        const piv = layer._textPivot;
        layer._textPivot = null;
        const pivot = piv && piv.mode === "centre" ? "centre" : "start";
        const f0 = had && pivot === "start" ? textStartFraction(layer) : [0.5, 0.5];
        const keepX = piv && Number.isFinite(piv.x) ? piv.x : layer.x + f0[0] * layer.w;
        const keepY = piv && Number.isFinite(piv.y) ? piv.y : layer.y + f0[1] * layer.h;
        const before = { x: layer.x, y: layer.y, w: layer.w, h: layer.h, pw: had ? layer.px.width : 0, ph: had ? layer.px.height : 0 };
        // adopts the rendered canvas: replaced, not written (its size changes with every edit). A text with a free angle
        // comes drawn at it; one without is mirrored and turned here exactly (the document's turns and the layer's own
        // compose into text.turn / text.flip / text.angle)
        let px = this.pixels.Layer.fromCanvas(canvas);
        if (!r.oriented) for (const op of orientOps(layer.text)) px = px.turned(op);
        layer.px = px;
        layer.text.res = res;
        if (r.box) layer.text.box = r.box;
        layer.w = Math.max(1, Math.round(px.width / res * k));
        layer.h = Math.max(1, Math.round(px.height / res * k));
        if (had) {
            const f1 = pivot === "start" ? textStartFraction(layer) : [0.5, 0.5];
            layer.x = Math.round(keepX - f1[0] * layer.w);
            layer.y = Math.round(keepY - f1[1] * layer.h);
        }
        layer._textCentre = had && pivot === "centre" ? { x: keepX, y: keepY, x0: layer.x, y0: layer.y, w: layer.w, h: layer.h } : null;
        if (adopt) adopt(layer, before);
        layer._maskedValid = false;
        const { turn: _turn, flip: _flip, angle: _angle, box: _box, ...style } = layer.text;   // a new text layer starts upright
        this.textDefaults = { ...style, content: TEXT_DEFAULTS.content };
        if (missing) this.setStatus(`Font "${layer.text.font}" is not available here; a fallback was used.`, "warn");
        this.markLayerChanged(layer);
        this.draw();
    }

    scheduleTextRender(layer) {
        clearTimeout(layer._textTimer);
        layer._textTimer = setTimeout(() => this.renderTextLayer(layer), 120);
    }

    /**
     * Turn a text layer to `deg` degrees in all on the screen (clockwise, PLAN_0_1_31 §7): the text stays editable (its
     * quarter turns and its free angle in the description) and is drawn at the angle as vectors, never resampled.
     * `pivot` "centre" keeps the middle of the layer (the transform tool, the Angle field), "start" the corner the text
     * starts at (add_text). A mask is turned with the text into the new box: the one resample an angle change costs.
     * One `layers` step (it holds the description and the mask), unless `step` is false.
     */
    async setTextAngle(layer, deg, { label = "Text angle", step = true, pivot = "centre" } = {}) {
        if (!layer || layer.kind !== "text" || !layer.text || !Number.isFinite(+deg)) return false;
        if (this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return false; }
        // a render on its way first: the pixels it makes are what the angle turns from
        if (layer._textTimer || layer._textRendering) {
            clearTimeout(layer._textTimer); layer._textTimer = null;
            await this.renderTextLayer(layer);
        }
        const delta = normDeg(+deg - textTotalAngle(layer.text));
        if (Math.abs(delta) < 1e-6) return false;
        if (this.textEdit && this.textEdit.layer === layer) this.endTextEdit(true);
        if (step) this.pushUndo({ kind: "layers", label });
        const mask = layer.maskPx;
        // the point that stays, read from the text as it is (add_text's start corner, or the middle); the exact middle of
        // the last turn while the layer has not moved since, so many small turns do not walk it by half pixels
        const mode = pivot === "start" ? "start" : "centre";
        const f0 = mode === "start" ? textStartFraction(layer) : [0.5, 0.5];
        const keep = { mode, x: layer.x + f0[0] * layer.w, y: layer.y + f0[1] * layer.h };
        const c = layer._textCentre;
        if (mode === "centre" && c && c.x0 === layer.x && c.y0 === layer.y && c.w === layer.w && c.h === layer.h) { keep.x = c.x; keep.y = c.y; }
        layer.text = spinText(layer.text, delta);
        if (layer._textUndo) this.releaseSnapshot(layer._textUndo);
        layer._textUndo = null;
        layer._textPivot = keep;
        await this.renderTextLayer(layer, {
            adopt: (l, b) => {
                if (!mask || !b.pw) return;
                // the old mask over the old box, turned by delta about the middle the text kept, into the new box: from a
                // new mask pixel to the image, back by the turn, into the old mask's pixels
                const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
                const toOld = xfInv([b.w / mask.width, 0, 0, b.h / mask.height, b.x, b.y]);
                const fromNew = [l.w / l.px.width, 0, 0, l.h / l.px.height, l.x, l.y];
                const inv = xfMul(toOld, xfMul(xfRotate(-delta, cx, cy), fromNew));
                l.maskPx = mask.transformed(pixelMap(inv), l.px.width, l.px.height, { color: MASK_RGB });
                l.maskDirty = true;
            },
        });
        this.renderLayers(); this.updateSubbar(); this.draw();
        this.notifyChanged();
        return true;
    }

    /** Is (ix, iy) on a text layer's text (its upright box turned as the text is), not only inside its rectangle? */
    textHitAt(l, ix, iy) {
        if (!(ix >= l.x && ix <= l.x + l.w && iy >= l.y && iy <= l.y + l.h)) return false;
        if (!textAngle(l.text) || !l.px) return true;
        const [uw, uh] = textBox(l), f = textFrame(uw, uh, l.text);
        const [u, v] = xfApply(xfInv(f.m), (ix - l.x) * l.px.width / l.w, (iy - l.y) * l.px.height / l.h);
        return u >= 0 && u <= uw && v >= 0 && v <= uh;
    }

    fillFontSelect(sel, value) {
        sel.innerHTML = "";
        const list = fontList();
        const groups = new Map();
        for (const f of list) { if (!groups.has(f.category)) groups.set(f.category, []); groups.get(f.category).push(f); }
        for (const [cat, fonts] of groups) {
            const g = document.createElement("optgroup");
            g.label = FONT_CATEGORIES[cat] || cat;
            for (const f of fonts) { const o = document.createElement("option"); o.value = f.family; o.textContent = f.family; g.appendChild(o); }
            sel.appendChild(g);
        }
        if (value && !list.some((f) => f.family === value)) { const o = document.createElement("option"); o.value = value; o.textContent = value + " (missing)"; sel.appendChild(o); }
        sel.value = value || (list[0] && list[0].family) || "";
    }

    /** The controls of a text layer row: text, font, size, colour, style, alignment, spacing, outline. */
    buildTextControls(layer) {
        const t = layer.text;
        const box = el("div", "ipc-text");
        const stop = (e) => e.stopPropagation();
        const begin = () => { if (!layer._textUndo) layer._textUndo = this.snapshot({ kind: "text", id: layer.id }); };
        const commit = (label) => { if (layer._textUndo) { this.pushUndoSnapshot(layer._textUndo, { label }); layer._textUndo = null; } };
        const change = (fn, label) => { this.pushUndo({ kind: "text", id: layer.id, label }); fn(); this.renderTextLayer(layer); };

        const ta = document.createElement("textarea");
        ta.value = t.content;
        ta.title = "The text; Enter starts a new line, Esc leaves the field";
        ta.addEventListener("click", stop);
        ta.addEventListener("pointerdown", stop);
        ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { ta.blur(); this.root.focus({ preventScroll: true }); } });
        ta.addEventListener("focus", begin);
        ta.addEventListener("input", () => { t.content = ta.value; this.scheduleTextRender(layer); });
        ta.addEventListener("change", () => commit("Edit text"));
        box.appendChild(ta);

        const fontRow = el("div", "ipc-row");
        const fontSel = document.createElement("select");
        fontSel.className = "ipc-sel";
        fontSel.title = "Font. The bundled fonts are open source (OFL / Apache, see js/fonts/licenses); + adds your own .ttf / .otf / .woff, stored in input/inpaint_canvas/fonts.";
        this.fillFontSelect(fontSel, t.font);
        fontSel.addEventListener("click", stop);
        fontSel.addEventListener("keydown", stop);
        fontSel.addEventListener("change", () => change(() => { t.font = fontSel.value; const f = fontList().find((x) => x.family === t.font); t.fontRef = f && f.ref ? f.ref : null; }, "Text font"));
        fontRow.appendChild(fontSel);
        fontRow.appendChild(miniButton("plus", "Add a font file (.ttf, .otf, .woff, .woff2). Uploaded to input/inpaint_canvas/fonts and available from then on.", () => { this.fontTarget = layer; this.fontInput.click(); }));
        box.appendChild(fontRow);

        const r1 = el("div", "ipc-row");
        r1.appendChild(el("span", null, "Size"));
        const size = numberInput(t.size, 1, 4096, "Font size in image pixels", 52);
        size.addEventListener("change", () => change(() => { t.size = Math.max(1, +size.value || 1); }, "Text size"));
        r1.appendChild(size);
        const col = document.createElement("input");
        col.type = "color"; col.value = t.color; col.title = "Text colour";
        col.addEventListener("click", stop);
        col.addEventListener("focus", begin);
        col.addEventListener("input", () => { t.color = col.value; this.scheduleTextRender(layer); });
        col.addEventListener("change", () => commit("Text colour"));
        r1.appendChild(col);
        const bold = miniButton("bold", "Bold", () => change(() => { t.bold = !t.bold; }, "Bold"), t.bold ? "ipc-on" : "");
        const ital = miniButton("italic", "Italic", () => change(() => { t.italic = !t.italic; }, "Italic"), t.italic ? "ipc-on" : "");
        r1.appendChild(bold); r1.appendChild(ital);
        const align = selectInput(["left", "center", "right"], t.align || "left", "Alignment of several lines");
        align.addEventListener("change", () => change(() => { t.align = align.value; }, "Text alignment"));
        r1.appendChild(align);
        box.appendChild(r1);

        const r2 = el("div", "ipc-row");
        r2.appendChild(el("span", null, "Line"));
        const lh = numberInput(t.lineHeight, 0.5, 4, "Line height as a multiple of the size", 52);
        lh.step = 0.05;
        lh.addEventListener("change", () => change(() => { t.lineHeight = Math.min(4, Math.max(0.5, +lh.value || 1.2)); }, "Line height"));
        r2.appendChild(lh);
        r2.appendChild(el("span", null, "Spacing"));
        const ls = numberInput(t.letterSpacing, -50, 200, "Letter spacing in image pixels", 52);
        ls.addEventListener("change", () => change(() => { t.letterSpacing = +ls.value || 0; }, "Letter spacing"));
        r2.appendChild(ls);
        r2.appendChild(el("span", null, "Outline"));
        const ow = numberInput(t.outline, 0, 200, "Outline width in image pixels (0 = none)", 48);
        ow.addEventListener("change", () => change(() => { t.outline = Math.max(0, +ow.value || 0); }, "Outline width"));
        r2.appendChild(ow);
        const ocol = document.createElement("input");
        ocol.type = "color"; ocol.value = t.outlineColor || "#000000"; ocol.title = "Outline colour";
        ocol.addEventListener("click", stop);
        ocol.addEventListener("focus", begin);
        ocol.addEventListener("input", () => { t.outlineColor = ocol.value; this.scheduleTextRender(layer); });
        ocol.addEventListener("change", () => commit("Outline colour"));
        r2.appendChild(ocol);
        box.appendChild(r2);

        const r3 = el("div", "ipc-row");
        r3.appendChild(el("span", null, "Angle"));
        const ang = numberInput(Math.round(textTotalAngle(t) * 100) / 100, -180, 180, "How far the text is turned, in degrees clockwise. It stays editable; the transform tool (T) turns it too.", 64);
        ang.step = 0.1;
        ang.addEventListener("change", () => { this.setTextAngle(layer, +ang.value || 0, { label: "Text angle" }); });
        r3.appendChild(ang);
        box.appendChild(r3);
        return box;
    }

    /** Upload font files to input/inpaint_canvas/fonts and use the first one on the layer the + came from. */
    async addFontFiles(files) {
        files = Array.from(files || []).filter((f) => f && /\.(ttf|otf|woff2?)$/i.test(f.name || ""));
        if (!files.length) { this.setStatus("Font files only (.ttf, .otf, .woff, .woff2)."); return; }
        let first = null;
        for (const file of files) {
            try {
                const name = (file.name || "font.ttf").replace(/[^a-z0-9._ \-\[\],]/gi, "_");
                const ref = await uploadBlob(file, name, { overwrite: true, subfolder: SUBFOLDER + "/fonts" });
                const entry = addUserFont(ref);
                if (!first) first = entry;
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err), failKind(err));
            }
        }
        if (!first) return;
        const target = this.fontTarget && this.layers.includes(this.fontTarget) ? this.fontTarget : null;
        this.fontTarget = null;
        if (target && target.kind === "text") {
            this.pushUndo({ kind: "text", id: target.id, label: "Text font" });
            target.text.font = first.family;
            target.text.fontRef = first.ref;
            await this.renderTextLayer(target);
        }
        this.renderLayers();
        this.setStatus(`${files.length} font${files.length > 1 ? "s" : ""} added (${first.family}). Stored in input/inpaint_canvas/fonts.`);
    }
}
