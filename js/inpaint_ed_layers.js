// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_layers.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// image layers, layer ops and the layers panel: moved out of inpaint_canvas.js (item 56 S3, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS, fillPixels } from "./inpaint_filters.js";
import { installLayerAliases } from "./inpaint_pixels.js";
import { TIFF_EXT, tiffInfo } from "./inpaint_tiff.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { SUBFOLDER, uploadBlob, uploadCanvas } from "./inpaint_upload.js";
import { LAYERED_EXT } from "./inpaint_layered.js";
import { labelMap, sameLabels } from "./reftokens.js";
import { BLENDS, BLEND_GROUPS, EMULATED_BLENDS, canvasOp, normalBlend, seedOfLayer } from "./blend_modes.js";
import { failKind } from "./inpaint_status.js";
import { LAYER_PENDING_KEYS, ROLES, cpuDab, makeCanvas, refBadge } from "./inpaint_consts.js";
import { el, icon, miniButton, selectGrouped, selectInput } from "./inpaint_dom.js";
import { availableCutoutBackends } from "./inpaint_backends.js";
import { hugePngSize, imageFileSize, isSvgFile, isTiffFile, layeredKind, loadImageEl, pixelsFromTiff, pixelsOffThread, rasterizeSvg, storedExt, viewUrl } from "./inpaint_load.js";

export class LayersPart {
    /**
     * Upload image files and add each as a layer (role "reference" by default). In an empty tab the first file becomes
     * the picture, except with `blank` (the app, for references: the prompt field and add_image_layer, 26f): then a white
     * 1024 x 1024 canvas comes first, which Generate new replaces while the references stay.
     */
    async addImageLayers(files, role = "reference", { place = "cascade", at = null, blank = false } = {}) {
        files = Array.from(files || []).filter((f) => f && ((f.type && f.type.startsWith("image/")) || LAYERED_EXT.test(f.name || "") || TIFF_EXT.test(f.name || "")));
        if (!files.length) return;
        if (!this.width && blank && role === "reference" && host.refTokens) {
            await this.newCanvas("1024x1024");
            if (!this.width) return;
        } else if (!this.width) {
            await this.loadFile(files.shift());
            if (!files.length || !this.width) return;
        }
        let n = this.layers.filter((l) => this.isReference(l)).length;
        let last = null, layeredFiles = 0;
        const added = [];
        for (let file of files) {
            try {
                const layered = await layeredKind(file);
                if (layered) {
                    // a PSD / ORA dropped on a document: every layer of it, where the file has it, the bottom one included
                    const doc = await this.readLayered(file, layered);
                    if (doc.compositePx) { doc.compositePx.release(); doc.compositePx = null; }   // a flat PSD adds no layer
                    // each new reference goes below the others (addLayer): top first keeps the file's stacking order
                    const order = host.refTokens && role === "reference" ? [...doc.layers].reverse() : doc.layers;
                    // its groups come along as groups (PLAN_0_1_31 §6.5), with ids of this document; references are in none
                    const gid = new Map();
                    if (role !== "reference" && doc.groups && doc.groups.length) {
                        this.groupCounter = (this.groupCounter || 0) + 1;
                        doc.groups.forEach((g, i) => gid.set(g.id, "G" + Date.now().toString(36) + this.groupCounter + "_" + i));
                        for (const g of doc.groups) this.groups.push({ id: gid.get(g.id), name: g.name, visible: g.visible !== false, locked: false, collapsed: !!g.collapsed, parent: g.parent ? gid.get(g.parent) || null : null });
                    }
                    this.holdGroups = (this.holdGroups || 0) + 1;
                    try {
                        for (const L of order) last = this.addLayer({ name: L.name, kind: "image", role, ref: null, group: (L.group && gid.get(L.group)) || null, px: L.px, x: L.x, y: L.y, w: L.w, h: L.h, opacity: L.opacity, visible: L.visible, blend: normalBlend(L.blend), dirty: true, maskPx: L.maskPx || null, maskOff: !!L.maskOff, maskDirty: !!L.maskPx, clip: role !== "reference" && !!L.clip }, { activate: false });
                    } finally { this.holdGroups--; }
                    this.renderLayers();
                    if (last) this.activeLayerId = last.id;
                    this.setStatus(`${doc.layers.length} layer${doc.layers.length === 1 ? "" : "s"} of ${file.name || "the file"} added.${doc.notes.length ? " " + doc.notes.join("; ") + "." : ""}`, doc.lossy ? "warn" : "info");
                    layeredFiles++;
                    continue;
                }
                if (isSvgFile(file)) {
                    // rasterised to fit the document, so the layer is sharp at 1:1 and the transform tool only ever scales it down
                    const target = await this.svgTarget(file, { ask: false, fit: [this.width, this.height] });
                    this.setStatus(`Rasterising ${file.name || "the SVG"} at ${target.width} × ${target.height} ...`);
                    file = await rasterizeSvg(file, target);
                }
                let ref = null, px = null;
                if (await isTiffFile(file)) {
                    // 3d: a TIFF is decoded here; its layer is stored with the others as a PNG (dirty), never as the TIFF
                    const info = await tiffInfo(file);
                    this.setStatus(`Reading ${file.name || "the TIFF"} (${info.width} × ${info.height}) ...`);
                    ({ px } = await pixelsFromTiff(file, this.pixels.Layer, null, () => !!this._destroyed));
                } else {
                    const ext = await storedExt(file);
                    const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;
                    if (big) this.checkBaseSize(big.width, big.height);
                    this.setStatus(`Uploading ${file.name || "image"} ...`);
                    const stem = (file.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
                    const up = uploadBlob(file, stem + ext, { overwrite: false });
                    up.catch(() => {});
                    try {
                        // a large file is decoded in a pool worker (`pixelsOffThread`) while it uploads, a small one through an <img>
                        if (big) px = await pixelsOffThread(file, this.pixels.Layer);
                        ref = await up;
                    } catch (err) {
                        if (px) px.release();
                        throw err;
                    }
                    if (!px) px = this.pixels.Layer.fromImage(await loadImageEl(viewUrl(ref)));
                }
                const nw = px.width, nh = px.height;
                // Shown at a third of the canvas, cascaded from the top left; the file itself stays the reference.
                const box = this.referenceBox(px, n);
                const w = box.w, h = box.h;
                const off = place === "cascade" ? box.x : 0;
                // origin: native size; fit: native size unless larger than the canvas; cascade: a third of the canvas (references)
                const fs = place === "fit" || place === "at" ? Math.min(1, this.width / nw, this.height / nh) : 1;
                const lw = place === "cascade" ? w : Math.max(1, Math.round(nw * fs)), lh = place === "cascade" ? h : Math.max(1, Math.round(nh * fs));
                let lx = off, ly = off;
                if (place === "at" && at) {
                    // centred on the drop point, nudged back so the layer stays inside the canvas; several files cascade from there
                    lx = Math.round(Math.min(Math.max(0, at[0] - lw / 2), Math.max(0, this.width - lw)));
                    ly = Math.round(Math.min(Math.max(0, at[1] - lh / 2), Math.max(0, this.height - lh)));
                    at = [at[0] + 24, at[1] + 24];
                }
                last = this.addLayer({ name: (file.name || "image").replace(/\.[a-z0-9]+$/i, ""), kind: "image", role, ref, px, x: lx, y: ly, w: lw, h: lh, dirty: !ref });
                added.push(last);
                n++;
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err), failKind(err));
            }
        }
        if (last && layeredFiles < files.length) {
            const refs = this.referenceLayers().length;
            // the labels the prompt names them by (docs/PLAN_REFS.md): "added as @img3, @img4"
            const labels = this.refLabels(), tokens = host.refTokens ? added.map((l) => labels.get(l.id)).filter(Boolean).map((k) => "@img" + k) : [];
            const as = tokens.length ? ` as ${tokens.join(", ")}` : "";
            this.setStatus(role === "reference" ? `${files.length} reference image${files.length > 1 ? "s" : ""} added${as} (${refs} will travel with crop_image). They are not part of the image.` : `${files.length} image layer${files.length > 1 ? "s" : ""} added. Move or scale with T; the role select can turn it into a reference.`);
        }
    }

    // ---- layer management: thumbnails, rename, reorder, solo, duplicate, merge, pick ---------

    drawLayerThumb(canvas, layer) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (this.isFillLayer(layer)) {
            // a fill layer: its fill (a gradient's transparent end shows the thumbnail's background)
            const w = canvas.width, h = canvas.height;
            ctx.putImageData(new ImageData(fillPixels(layer.filter, layer.params || {}, [w, h], [0, 0], w, h), w, h), 0, 0);
            return;
        }
        if (layer.kind === "filter") {
            ctx.fillStyle = "#3a2f52";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#c7a2ff";
            ctx.font = "bold 11px system-ui, sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("fx", canvas.width / 2, canvas.height / 2);
            return;
        }
        if (!layer.px) return;
        // the layer's own pixels, fitted
        const s = Math.min(canvas.width / layer.px.width, canvas.height / layer.px.height);
        const w = layer.px.width * s, h = layer.px.height * s;
        this.drawLayerFitted(ctx, layer, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }

    /**
     * A layer's pixels (its mask applied) drawn into the rectangle x, y, w, h of a thumbnail's context.
     * On tiles, outside a stroke on the layer, from the tile store's small thumbnail canvases: a thumbnail
     * never makes the display mirror, which a hidden layer or a tab in the background would otherwise
     * hold at the layer's full size for a picture of 40 px (C2 step b's review). On canvases from the display
     * canvas's pyramid level, as before, a stroke on the layer included.
     *
     * C6 (c2e): on tiles during a stroke on the layer too: the row shows the layer as it was before the stroke,
     * which is also what it shows after the commit until the list is drawn again. The stroke in a row redrawn
     * mid-gesture (a landing of the layer's chains, a run's result arriving) used to come from the full-size live
     * previews, filled from the layer's display mirror: up to four canvases of 572 MB at 15000 x 10000.
     */
    drawLayerFitted(ctx, layer, x, y, w, h) {
        const px = layer.px;
        const p = this.pointer;
        const live = !!(p && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        if (isTilePixels(px) && (!live || !this.liveMask(layer) || isTilePixels(layer.maskPx))) {
            // display (C6 b): a tile whose mips are in the worker shows what it had, and the row is drawn again when they land
            ctx.drawImage(px.thumbnailCanvas(true), x, y, w, h);
            if (this.liveMask(layer)) {
                // destination-in applies to the whole canvas: the thumbnail holds nothing else
                ctx.globalCompositeOperation = "destination-in";
                ctx.drawImage(layer.maskPx.thumbnailCanvas(true), x, y, w, h);
            }
            this.watchChains();
        } else {
            const src = this.layerPixels(layer, true);
            ctx.drawImage(this.displaySource(src, w / src.width), x, y, w, h);
        }
        ctx.restore();
    }

    /**
     * Redraw every thumbnail of `layer` in place where it is shown (C6 b, when its mips land): its row in the layer
     * list or the reference list, and the result list's items made from it. Never rebuilds a list: a landing is not
     * the user's, and a rebuild took an open rename (a reference row is not in the layer list, which made
     * refreshLayerThumb rebuild both lists) and left the result list's picture coarse (the C6 b review).
     */
    redrawThumbsOf(layer) {
        layer._refAvatar = null;
        if (this.promptField && this.isReference(layer)) this.promptField.updateThumbs([layer.id]);
        const sel = `.ipc-layer[data-layer="${layer.id}"] canvas.ipc-lthumb`;
        for (const list of [this.layerList, this.refList]) {
            const th = list && list.querySelector(sel);
            if (th) this.drawLayerThumb(th, layer);
        }
        if (this.historyList) {
            for (const c of this.historyList.querySelectorAll("canvas[data-hist]")) {
                const h = this.history[+c.dataset.hist];
                if (h && h.layerId === layer.id) this.drawHistoryThumb(c, h);
            }
        }
    }

    /** Redraw one row's thumbnail in place; the whole list when the row is not there. */
    refreshLayerThumb(layer) {
        if (!this.layerList) return;
        const th = this.layerList.querySelector(`.ipc-layer[data-layer="${layer.id}"] canvas.ipc-lthumb`);
        if (!th) { this.renderLayers(); return; }
        this.drawLayerThumb(th, layer);
    }

    /** Swap the name span for an input; Enter or blur commits, Esc cancels. */
    renameLayerInline(layer, nameEl) {
        const input = document.createElement("input");
        input.type = "text";
        input.value = layer.name;
        input.title = "Layer name";
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const v = input.value.trim();
            if (commit && v && v !== layer.name) { this.pushUndo({ kind: "layers", label: "Rename layer" }); layer.name = v; this.notifyChanged(); }
            this.renderLayers();
            this.renderHistory();
            this.root.focus({ preventScroll: true });
        };
        for (const type of ["click", "pointerdown", "dblclick", "mousedown"]) input.addEventListener(type, (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
        nameEl.textContent = "";
        nameEl.appendChild(input);
        input.focus();
        input.select();
    }

    /** Move layer `srcId` next to layer `targetId` (above it in the panel = after it in the array). */
    reorderLayer(srcId, targetId, above) {
        if (srcId === targetId) return;
        this.dropInLayers({ layer: srcId }, { layer: targetId }, above);
    }

    /**
     * Alt+click on the eye: show only this layer, or all selected layers when the row is one of several selected; the
     * same again restores what was visible before. Solo on other layers while one is on keeps the visibility from before
     * the first solo, so the restore always brings that back. References are not part of the picture and stay as they
     * are (a hidden reference is not sent).
     */
    soloLayer(layer) {
        const layers = this.multiSelected() && this.selectedLayers().includes(layer) ? this.selectedLayers() : [layer];
        return this.soloLayers(layers);
    }

    soloLayers(layers) {
        const ids = layers.map((l) => l.id);
        const key = [...ids].sort().join(" ");
        if (this._solo && this._solo.key === key) return this.unsolo();
        const rows = this.layers.filter((l) => !this.isReference(l));
        if (!this._solo) this._solo = { visible: rows.filter((l) => l.visible).map((l) => l.id), known: new Set(rows.map((l) => l.id)), groups: this.groups.filter((g) => !g.visible).map((g) => g.id) };
        this._solo.key = key;
        for (const l of rows) l.visible = ids.includes(l.id);
        // a hidden group around a soloed layer would keep it hidden: every group around one is shown during the solo
        const around = new Set(layers.flatMap((l) => this.groupsOf(l.group).map((g) => g.id)));
        const hid = new Set(this._solo.groups || []);
        for (const g of this.groups) g.visible = around.has(g.id) || !hid.has(g.id);
        this.visibilityChanged();
        this.setStatus(`Solo: only ${layers.length > 1 ? `${layers.length} layers are` : `${layers[0].name} is`} shown. Alt+click the eye again (or "Show all layers" in the row's menu) to restore.`);
        return true;
    }

    /** End a solo: every layer as visible as it was before the first solo (the layers added since stay as they are). */
    unsolo() {
        if (!this._solo) { this.setStatus("No solo to end."); return false; }
        const was = new Set(this._solo.visible), known = this._solo.known;
        for (const l of this.layers) if (!this.isReference(l) && known.has(l.id)) l.visible = was.has(l.id);
        const hid = new Set(this._solo.groups || []);
        for (const g of this.groups) if (hid.has(g.id)) g.visible = false;
        this._solo = null;
        this.visibilityChanged();
        this.setStatus("Solo off, visibility restored.");
        return true;
    }

    visibilityChanged() {
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /** Copy of the active layer right above it (Ctrl+J). */
    duplicateLayer(layer = this.activeLayer()) {
        if (!layer) { this.setStatus("Select a layer to duplicate."); return null; }
        this.pushUndo({ kind: "layers", label: "Duplicate layer" });
        this.layerCounter += 1;
        const copy = {
            ...layer, id: "L" + Date.now().toString(36) + this.layerCounter, name: layer.name + " copy",
            ref: layer.dirty ? null : layer.ref, dirty: !!layer.dirty || !layer.ref, exportRef: null, locked: false,
            maskRef: layer.maskDirty ? null : layer.maskRef, maskDirty: !!layer.maskPx && (!!layer.maskDirty || !layer.maskRef), maskEdit: false,
            _masked: null, _maskedValid: false, _mcache: null, _fcache: null, _fxCache: null, _textUndo: null, _undoPending: null,
            _relight: null, _bstats: null, _bstatsRun: null,
        };
        for (const k of LAYER_PENDING_KEYS) delete copy[k];   // an edit still in progress stays with the original
        // the spread shares the pixels; the copy gets its own (the aliases are not enumerable, so they are installed again)
        if (layer.px) copy.px = layer.px.clone();
        if (layer.maskPx) copy.maskPx = layer.maskPx.clone();
        installLayerAliases(copy, this.pixels);
        if (layer.text) copy.text = JSON.parse(JSON.stringify(layer.text));
        // a preview still shown stays with the original: the copy takes the committed values (committedFilter)
        const committed = this.committedFilter(layer);
        if (layer.params) copy.params = JSON.parse(JSON.stringify(committed ? committed.params : layer.params));
        if (committed && committed.name) copy.name = committed.name + " copy";
        if (layer.match) copy.match = { ...layer.match };
        if (layer.lut) copy.lut = { ...layer.lut };
        if (layer.plate) copy.plate = { ...layer.plate };
        if (layer.kind === "filter") copy.dirty = false;
        // the copy of a reference goes below the lowest reference, so it takes the next number and none of the others moves
        const below = host.refTokens && this.isReference(layer);
        const i = below ? this.layers.findIndex((l) => this.isReference(l)) : this.layers.indexOf(layer) + 1;
        this.layers.splice(i, 0, copy);
        this.activeLayerId = copy.id;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
        const label = below ? this.refLabels().get(copy.id) : null;
        this.setStatus(below ? `${copy.name} added${label ? ` as @img${label}` : ""}, below the other references.` : `${copy.name} added above ${layer.name}.`);
        return copy;
    }

    /** Merge the active layer into the one below it (Ctrl+E); the bottom layer merges into the base. */
    mergeDown(layer = this.activeLayer()) { return this.trackEdit(this.mergeDownNow(layer)); }   // undo waits for the upload into the base (see extendCanvas)

    async mergeDownNow(layer) {
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return; }
        if (!layer) { this.setStatus("Select a layer to merge down."); return; }
        if (this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
        if (layer.kind === "filter") { this.setStatus("Filter layers cannot be merged into a layer; Flatten bakes them into the base."); return; }
        const i = this.layers.indexOf(layer);
        const below = i > 0 ? this.layers[i - 1] : null;
        if (this.pending) this.cancelPending();
        if (!below) {
            if (this.isControl(layer) || this.isReference(layer)) { this.setStatus("Control and reference layers are not part of the image, there is nothing to merge into the base."); return; }
            let before = null, pushed = false;
            try {
                this.setStatus(`Merging ${layer.name} into the base ...`);
                before = this.snapshot({ kind: "canvas" });
                const c = makeCanvas(this.width, this.height);
                const ctx = c.getContext("2d");
                this.drawBaseInto(ctx, 0, 0, this.width, this.height);
                if (EMULATED_BLENDS.has(layer.blend)) this.blendEmulated(ctx, layer.blend, (lc) => { this.drawLayer(lc, layer); }, layer.opacity, null, seedOfLayer(layer.id));
                else {
                    ctx.globalAlpha = layer.opacity;
                    ctx.globalCompositeOperation = canvasOp(layer.blend);
                    this.drawLayer(ctx, layer);
                }
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "source-over";
                const { ref } = await uploadCanvas(c, `n${this.node.id}_base`);
                const px = this.pixels.Layer.fromCanvas(c);   // C6 (d): not the upload decoded again
                pushed = true;
                this.pushUndoSnapshot(before, { tracked: true, label: "Merge into base" });
                this.layers = this.layers.filter((l) => l.id !== layer.id);   // by id: a restore makes new layer objects
                this.base = { ref, px };
                this.activeLayerId = null;
                this.uploaded = this.makeUploaded();
                this.renderLayers(); this.renderHistory(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
                this.setStatus(`${layer.name} merged into the base (Ctrl+Z takes it back).`);
            } catch (err) {
                if (!pushed) this.releaseSnapshot(before);
                console.error(err);
                this.setStatus(String(err.message || err), failKind(err));
            }
            return;
        }
        if (this.isLocked(below)) { this.setStatus(`${below.name} is locked.`); return; }
        if (below.kind === "filter") { this.setStatus("The layer below is a filter layer; move it or merge elsewhere."); return; }
        if (this.isControl(layer) !== this.isControl(below) || this.isReference(layer) !== this.isReference(below)) { this.setStatus("Only layers of the same kind (image, control or reference) can be merged."); return; }
        this.pushUndo({ kind: "layers", label: "Merge down" });
        this.mergeInto(layer, below);
        this.activeLayerId = below.id;
        this.layerSel = new Set();
        this.renderLayers(); this.renderHistory(); this.draw();
        this.setStatus(`${layer.name} merged into ${below.name}${this.matchActive(layer) ? " (its colour match was not baked)" : ""}.`, this.matchActive(layer) ? "warn" : "info");
    }

    /**
     * Merge the selected layers into one, at the place of the topmost (Ctrl+E with several selected), as one undo step.
     * Each lower one is lifted to just under the merged part and the part merged down into it, so the survivor is the
     * bottom one's layer object (its id: prompt tokens that named any of them follow it).
     */
    mergeSelected() {
        if (this._turning) { this.setStatus("Wait for the turn to finish."); return false; }
        const sel = this.selectedLayers();
        if (sel.length < 2) return this.mergeDown();
        const bad = sel.find((l) => this.isLocked(l)) || sel.find((l) => l.kind === "filter");
        if (bad) { this.setStatus(this.isLocked(bad) ? `${bad.name} is locked.` : `${bad.name} is a filter layer: filter layers cannot be merged into a layer; Flatten bakes them into the base.`); return false; }
        if (sel.some((l) => this.isControl(l) !== this.isControl(sel[0]))) { this.setStatus("Only layers of the same kind (image or control) can be merged."); return false; }
        if (this.pending) this.cancelPending();
        this.pushUndo({ kind: "layers", label: `Merge ${sel.length} layers` });
        const unbaked = sel.slice(1).some((l) => this.matchActive(l));
        let top = sel[sel.length - 1];
        for (let k = sel.length - 2; k >= 0; k--) {
            const below = sel[k];
            // lift `below` to just under the merged part (the layers between stay where they are, above or below it)
            this.layers.splice(this.layers.indexOf(below), 1);
            this.layers.splice(this.layers.indexOf(top), 0, below);
            this.mergeInto(top, below);
            top = below;
        }
        this.activeLayerId = top.id;
        this.layerSel = new Set();
        this.renderLayers(); this.renderHistory(); this.draw();
        this.setStatus(`${sel.length} layers merged into ${top.name}${unbaked ? " (a colour match was not baked)" : ""}. Ctrl+Z takes it back.`, unbaked ? "warn" : "info");
        return true;
    }

    /** Composite `layer` into `below` (the next layer down) and drop it; no undo step, no redraw. */
    mergeInto(layer, below) {
        // union of both rectangles at the lower layer's resolution; the upper layer is composited with its opacity and blend mode
        const res = Math.max(1, below.px.width / below.w, below.px.height / below.h);
        const x0 = Math.min(layer.x, below.x), y0 = Math.min(layer.y, below.y);
        const x1 = Math.max(layer.x + layer.w, below.x + below.w), y1 = Math.max(layer.y + layer.h, below.y + below.h);
        const w = x1 - x0, h = y1 - y0;
        const c = makeCanvas(Math.round(w * res), Math.round(h * res));
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(this.layerPixels(below), (below.x - x0) * res, (below.y - y0) * res, below.w * res, below.h * res);
        // clipping (PLAN_0_1_31 §6 step 3) is baked in: a clipped layer merged into its base shows only where the base is;
        // a clipped layer below an unclipped one is cut to its own base first, and the result is no longer clipped
        const belowBase = below.clip && !layer.clip ? this.clipBaseOf(below) : null;
        if (belowBase) {
            ctx.globalCompositeOperation = "destination-in";
            ctx.globalAlpha = Math.max(0, Math.min(1, belowBase.opacity ?? 1));
            ctx.drawImage(this.layerPixels(belowBase), (belowBase.x - x0) * res, (belowBase.y - y0) * res, belowBase.w * res, belowBase.h * res);
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = 1;
        }
        if (below.clip && !layer.clip) below.clip = false;
        const clipTo = layer.clip && this.clipBaseOf(layer) === below;
        if (clipTo && (!layer.blend || layer.blend === "normal")) {
            // into its base: over the base's colour and inside its alpha, which stays (the layers still clipped to it keep
            // their coverage); at a partial alpha this is the base's picture with the layer on it, not the live stack
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = "source-atop";
            ctx.drawImage(this.layerPixels(layer), (layer.x - x0) * res, (layer.y - y0) * res, layer.w * res, layer.h * res);
        } else if (clipTo || EMULATED_BLENDS.has(layer.blend)) {
            // the layer's pixels where `below` (all the canvas holds yet) is; in a blend mode the base's alpha is put back after
            const cov = clipTo ? cpuDab(null, c.width, c.height) : null;
            if (cov) cov.getContext("2d").drawImage(c, 0, 0);
            // the canvas is the union box at `res` with no transform: dissolve hashes the image pixel, (x0, y0) + p / res,
            // as the screen and the export do (the identity hashed the box's own pixels and moved half the dots)
            const toImage = new DOMMatrix([1 / res, 0, 0, 1 / res, x0, y0]);
            this.blendEmulated(ctx, layer.blend, (lc) => { lc.imageSmoothingEnabled = true; lc.imageSmoothingQuality = "high"; lc.drawImage(this.layerPixels(layer), (layer.x - x0) * res, (layer.y - y0) * res, layer.w * res, layer.h * res); }, layer.opacity, cov, seedOfLayer(layer.id), toImage);
            if (cov) {
                const a = cov.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
                const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
                for (let i = 3; i < d.length; i += 4) d[i] = a[i];
                ctx.putImageData(img, 0, 0);
                cov.width = 1; cov.height = 1;
            }
        } else {
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = canvasOp(layer.blend);
            ctx.drawImage(this.layerPixels(layer), (layer.x - x0) * res, (layer.y - y0) * res, layer.w * res, layer.h * res);
        }
        // no alpha, blend or smoothing left on the new pixels' context (PLAN_BCE §C1 rule 11)
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.imageSmoothingQuality = "low";
        below.px = this.pixels.Layer.fromCanvas(c);   // replaced, not written: the "layers" undo step holds the old pixels
        below.x = x0; below.y = y0; below.w = w; below.h = h;
        below.maskPx = null; below.maskOff = false; below.maskRef = null; below.maskDirty = false; below.maskEdit = false;
        if (below.kind === "text") { below.kind = "paint"; delete below.text; }
        below.match = { strength: 0, source: "surroundings" };
        this.layers = this.layers.filter((l) => l !== layer);
        this.refsMutated({ alias: new Map([[layer.id, below.id]]) });   // the absorbed reference's tokens name the survivor
        this.markLayerChanged(below);
    }

    /** Topmost visible pixel layer with an opaque pixel under (ix, iy), or null. */
    pickLayerAt(ix, iy) {
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const l = this.layers[i];
            if (!this.shown(l) || l.kind === "filter" || !l.px) continue;
            if (ix < l.x || iy < l.y || ix >= l.x + l.w || iy >= l.y + l.h) continue;
            // one pixel read from the pixels (and the mask), never through a display canvas: a click must not
            // make a mirror as large as the layer on tiles (C2 step b's review)
            const px = l.px;
            const sx = Math.min(px.width - 1, Math.max(0, Math.floor((ix - l.x) * px.width / l.w)));
            const sy = Math.min(px.height - 1, Math.max(0, Math.floor((iy - l.y) * px.height / l.h)));
            let a = px.readRect(sx, sy, 1, 1).data[3];
            if (a && this.liveMask(l)) {
                const m = l.maskPx;
                a = a * m.readRect(Math.min(m.width - 1, Math.floor(sx * m.width / px.width)), Math.min(m.height - 1, Math.floor(sy * m.height / px.height)), 1, 1).data[3] / 255;
            }
            if (a > 8) return l;
        }
        return null;
    }

    addLayer(layer, { activate = true, quiet = false } = {}) {
        // `px` / `maskPx` hold the pixels; a caller that still passes `canvas` / `mask` gets them converted
        installLayerAliases(layer, this.pixels);
        if (layer.px) layer.px = this.ownPixels(layer.px);
        if (layer.maskPx) layer.maskPx = this.ownPixels(layer.maskPx);
        this.layerCounter += 1;
        layer.id = layer.id || ("L" + Date.now().toString(36) + this.layerCounter);
        if (layer.visible == null) layer.visible = true;
        if (layer.opacity == null) layer.opacity = 1;
        if (!layer.kind) layer.kind = "result";
        layer.blend = normalBlend(layer.blend);
        if (!layer.role) layer.role = "none";
        if (layer.maskPx === undefined) layer.maskPx = null;
        if (!layer.maskPx) { layer.maskRef = null; layer.maskDirty = false; layer.maskEdit = false; layer.maskOff = false; }
        else layer.maskOff = !!layer.maskOff;
        if (!layer.match) layer.match = { strength: 0, source: "surroundings" };
        this.historyGen++;   // no undo step, but a waiting restore of the layer list must not drop it
        // a new reference goes below the others, so it takes the next number and none of them is renumbered
        const lowest = host.refTokens && layer.role === "reference" ? this.layers.findIndex((l) => this.isReference(l)) : -1;
        if (lowest >= 0) this.layers.splice(lowest, 0, layer);
        else this.layers.push(layer);
        if (activate) this.activeLayerId = layer.id;
        if (quiet) return layer;   // a batch of layers: the caller's layersRestacked does this once
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
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
            px: this.pixels.Layer.empty(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: true,
        });
        this.setStatus(`${layer.name} added. Paint with P, erase with E, fill the selection with Shift+F.`);
        return layer;
    }

    removeLayer(id) {
        const target = this.layers.find((l) => l.id === id);
        if (!target) return;
        if (this.isLocked(target)) { this.setStatus(`${target.name} is locked. Unlock it first.`); return; }
        if (this.pending && this.pending.layer.id === id) this.cancelPending();
        this.pushUndo({ kind: "layers", label: "Delete layer" });
        this.layers = this.layers.filter((l) => l.id !== id);
        if (this.activeLayerId === id) this.activeLayerId = null;
        if (this.maskView && this.maskView.id === id) this.maskView = null;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers();
        this.renderHistory();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    /** Delete several layers as one undo step; locked ones stay (and are named). */
    removeLayers(ids) {
        const want = new Set(ids);
        const hit = this.layers.filter((l) => want.has(l.id));
        const locked = hit.filter((l) => this.isLocked(l)), gone = hit.filter((l) => !this.isLocked(l));
        if (!gone.length) { this.setStatus(locked.length ? `${locked.map((l) => l.name).join(", ")} ${locked.length > 1 ? "are" : "is"} locked. Unlock first.` : "No layer to delete.", "info"); return 0; }
        if (this.pending && gone.includes(this.pending.layer)) this.cancelPending();
        this.pushUndo({ kind: "layers", label: gone.length > 1 ? `Delete ${gone.length} layers` : "Delete layer" });
        this.layers = this.layers.filter((l) => !gone.includes(l));
        if (gone.some((l) => l.id === this.activeLayerId)) this.activeLayerId = locked.length ? locked[locked.length - 1].id : null;
        if (this.maskView && ids.includes(this.maskView.id)) this.maskView = null;
        this.layerSel = new Set(locked.length > 1 ? locked.map((l) => l.id) : []);
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderHistory(); this.draw(); this.drawThumb(); this.notifyChanged();
        this.setStatus(`${gone.length} layer${gone.length > 1 ? "s" : ""} deleted${locked.length ? `; ${locked.map((l) => l.name).join(", ")} locked, kept` : ""}. Ctrl+Z takes it back.`);
        return gone.length;
    }

    /** Show or hide, lock or unlock every selected layer the way the clicked row's switch goes. */
    setSelectedFlag(layer, key, value) {
        const rows = this.multiSelected() && this.selectedLayers().includes(layer) ? this.selectedLayers() : [layer];
        for (const l of rows) {
            l[key] = value;
            if (key === "locked" && value && this.pending && this.pending.layer === l) this.cancelPending();
        }
        if (key === "visible") {
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.refsMutated();   // the layers panel lists the references too
            this.renderInfo(); this.drawThumb();
        }
        this.renderLayers(); this.draw(); this.notifyChanged();
    }

    /**
     * Move a layer `delta` steps up (+) or down (-) through the tree (`stepLayer`: past a layer, into or out of a group
     * each count as one), or with `to` "top" / "bottom" to that end of the stack, out of every group. False when it did
     * not move.
     */
    moveLayer(id, delta, { undo = false, to = null } = {}) {
        const l = this.layers.find((x) => x.id === id);
        if (!l) return false;
        const snap = undo ? this.snapshot({ kind: "layers" }) : null;
        let moved = false;
        if (to === "top" || to === "bottom") {
            const i = this.layers.indexOf(l), j = to === "top" ? this.layers.length - 1 : 0;
            if (i !== j || l.group) { this.layers.splice(i, 1); this.layers.splice(j, 0, l); if (!this.isReference(l)) l.group = null; moved = true; }
        } else {
            for (let k = 0; k < Math.abs(delta); k++) { if (!this.stepLayer(l, Math.sign(delta))) break; moved = true; }
        }
        if (!moved) return false;
        if (snap && this.sel) this.pushUndoSnapshot(snap, { label: delta > 0 || to === "top" ? "Move layer up" : "Move layer down" });
        this.layersRestacked();
        return true;
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
                const n = this.history.length + 1;
                const layer = this.addLayer({ name: "Result " + n, kind: "result", ref, px: this.pixels.Layer.fromImage(img), x: r.x || 0, y: r.y || 0, w: r.width || img.naturalWidth, h: r.height || img.naturalHeight });
                // a provider run says which seed the model got (null: none went, FLUX 3 Image); a local result is the editor's
                // the texts of the click when the host kept them (S4), else the field's as the result lands (the node)
                const refsNow = () => { const o = {}; for (const [id, k] of this.refLabels()) o["img" + k] = id; return Object.keys(o).length ? o : null; };
                this.history.push({ key, name: layer.name, ref, x: layer.x, y: layer.y, w: layer.w, h: layer.h, layerId: layer.id, time: Date.now(),
                    prompt: r.prompt !== undefined ? String(r.prompt || "") : this.promptText,
                    negative: r.negative !== undefined ? String(r.negative || "") : this.negativeText || "",
                    refs: r.refs !== undefined ? r.refs : refsNow(),
                    seed: r.seed !== undefined ? r.seed : this.genSettings.seed, mode: r.mode !== undefined ? r.mode : this.genSettings.mode,
                    denoise: r.denoise !== undefined ? r.denoise : this.genSettings.denoise,
                    // what the host says of the run (the app: model, route, seconds); shown, never stored (getValue lists its fields)
                    via: r.via ? String(r.via) : null });
                this.renderHistory();
                const al = r.align && r.align.aligned ? ` · aligned (shift ${r.align.shift[0]}, ${r.align.shift[1]} px, scale ${r.align.scale[0]}, ${r.align.scale[1]})` : "";
                this.setStatus(`Result ${n} added (${r.width} × ${r.height} at ${r.x}, ${r.y})${r.via ? " · " + r.via : ""}${al}`);
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err), failKind(err));
            }
        }
    }

    renderLayers() {
        if (this.tool === "lights" && !this.isRelightActive()) {
            this.setTool("select");
        }
        this.normalizeGroups();
        if (!this.layerList) return;
        const list = this.layerList;
        // a menu opened from a row (the mask row's) belongs to the row that is about to be rebuilt
        if (this.flyout && this.flyout.group.btn && list.contains(this.flyout.group.btn)) this.closeFlyout();
        list.innerHTML = "";
        const selected = this.selectedLayers();
        const multi = new Set(selected.length > 1 ? selected.map((l) => l.id) : []);
        let open = [];   // the groups around the row before, outermost first (the list is a tree: PLAN_0_1_31 §6.5)
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            if (this.isReference(layer)) continue;   // references have their own list below
            const chain = this.groupsOf(layer.group).reverse();
            let k = 0;
            while (k < open.length && k < chain.length && open[k] === chain[k]) k++;
            for (let q = k; q < chain.length; q++) if (!chain.slice(0, q).some((g) => g.collapsed)) list.appendChild(this.buildGroupRow(chain[q], q));
            open = chain;
            if (chain.some((g) => g.collapsed)) continue;
            const inSel = multi.has(layer.id);
            const row = el("div", "ipc-layer" + (layer.id === this.activeLayerId && !this.activeGroupId ? " ipc-selected" : (inSel || layer.id === this.activeLayerId ? " ipc-multi" : "")));
            row.dataset.layer = layer.id;
            if (chain.length) row.style.setProperty("--ipc-depth", chain.length);
            if (layer.visible && !this.shown(layer)) row.classList.add("ipc-ghidden");
            row.addEventListener("click", (e) => { if (e.altKey && this.clipEdgeClick(row, e)) return; this.clickLayerRow(layer, e); });
            row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openLayerMenu(layer, e); });
            // Alt over the line between two rows: the cursor says a click clips the upper layer to the lower one
            row.addEventListener("pointermove", (e) => row.classList.toggle("ipc-clipedge", !!e.altKey && !!this.clipEdgeLayer(row, e)));
            row.addEventListener("pointerleave", () => row.classList.remove("ipc-clipedge"));
            if (this.isLocked(layer)) row.classList.add("ipc-locked");
            const cbase = this.clipBaseOf(layer, i);
            if (i + 1 < this.layers.length && this.layers[i + 1].clip && !layer.clip && layer.kind !== "filter") row.classList.add("ipc-clipbase");
            const top = el("div", "ipc-row");
            // drag the header row to reorder (the sliders below stay draggable as sliders)
            top.draggable = true;
            top.addEventListener("dragstart", (e) => {
                this.dragLayerId = layer.id; this.dragGroupId = null;
                e.dataTransfer.effectAllowed = "move";
                // its own type: the prompt field takes plain text, and a row dropped there would write its id
                try { e.dataTransfer.setData("application/x-scumble-layer", layer.id); } catch (_) { /* ignore */ }
                row.classList.add("ipc-dragging");
            });
            top.addEventListener("dragend", () => {
                this.dragLayerId = null; this.dragGroupId = null;
                row.classList.remove("ipc-dragging");
                list.querySelectorAll(".ipc-drop-above, .ipc-drop-below").forEach((r) => r.classList.remove("ipc-drop-above", "ipc-drop-below"));
            });
            row.addEventListener("dragover", (e) => {
                if (!(this.dragGroupId || (this.dragLayerId && this.dragLayerId !== layer.id))) return;
                e.preventDefault(); e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                const r = row.getBoundingClientRect();
                const above = e.clientY < r.top + r.height / 2;
                row.classList.toggle("ipc-drop-above", above);
                row.classList.toggle("ipc-drop-below", !above);
            });
            row.addEventListener("dragleave", () => row.classList.remove("ipc-drop-above", "ipc-drop-below"));
            row.addEventListener("drop", (e) => {
                if (!(this.dragGroupId || (this.dragLayerId && this.dragLayerId !== layer.id))) return;
                e.preventDefault(); e.stopPropagation();
                const r = row.getBoundingClientRect();
                const what = this.dragGroupId ? { group: this.dragGroupId } : { layer: this.dragLayerId };
                this.dragLayerId = null; this.dragGroupId = null;
                this.dropInLayers(what, { layer: layer.id }, e.clientY < r.top + r.height / 2);
            });
            top.appendChild(miniButton(layer.visible ? "eye" : "eyeOff", inSel ? "Show or hide the selected layers. Alt+click: solo (show only the selected layers, again to restore)" : "Toggle visibility. Alt+click: solo (show only this layer, again to restore)", (e) => {
                if (e && e.altKey) { this.soloLayer(layer); return; }
                this.setSelectedFlag(layer, "visible", !layer.visible);
            }, layer.visible ? "" : "ipc-off"));
            if (layer.clip) {
                const mark = el("span", "ipc-clipmark" + (cbase ? "" : " ipc-noeffect"));
                mark.innerHTML = icon("clip", 14);
                mark.title = cbase ? `Clipped to ${cbase.name}: shown only where it has pixels. Alt+click the line below this row releases it` : "Clipped, but without effect: the layer below is a filter layer or there is none";
                top.appendChild(mark);
            }
            const th = document.createElement("canvas");
            th.className = "ipc-lthumb";
            th.width = 40; th.height = 28;
            this.drawLayerThumb(th, layer);
            top.appendChild(th);
            const name = el("span", "ipc-name", layer.name);
            name.title = `${layer.w} × ${layer.h} at ${layer.x}, ${layer.y}. Double-click to rename`;
            name.addEventListener("dblclick", (e) => { e.stopPropagation(); this.renameLayerInline(layer, name); });
            top.appendChild(name);
            const refIndex = this.isReference(layer) ? this.referenceLayers().indexOf(layer) : -1;
            const isFx = layer.kind === "filter";
            const kindText = isFx ? (this.isFillLayer(layer) ? "fill" : "filter") : (this.isControl(layer) ? layer.role : (this.isReference(layer) ? (refIndex >= 0 ? refBadge(refIndex) : "ref (hidden)") : layer.kind));
            if (isFx || this.isControl(layer)) {
                top.appendChild(el("span", "ipc-kind" + (isFx ? " ipc-fxk" : " ipc-ctrl"), kindText));
            } else {
                // image / result / paint / text layers switch between "part of the image" and "reference" right here
                const ks = document.createElement("select");
                ks.className = "ipc-kindsel" + (this.isReference(layer) ? " ipc-ref" : "");
                ks.title = "Part of the image, or a reference: not in the image, sent along with crop_image as an extra batch image (Flux.2 / Kontext multi-reference)";
                for (const [v, label] of [[layer.kind, layer.kind], ["reference", this.isReference(layer) ? kindText : "reference"]]) { const o = document.createElement("option"); o.value = v; o.textContent = label; ks.appendChild(o); }
                ks.value = this.isReference(layer) ? "reference" : layer.kind;
                ks.addEventListener("click", (e) => e.stopPropagation());
                ks.addEventListener("keydown", (e) => e.stopPropagation());
                ks.addEventListener("change", () => this.setLayerRole(layer, ks.value === "reference" ? "reference" : "none"));
                top.appendChild(ks);
            }
            top.appendChild(miniButton("lock", (layer.locked ? "Locked: no painting, moving, merging or deleting. Click to unlock" : "Lock the layer (no painting, moving, merging or deleting)") + (inSel ? " (all selected layers)" : ""), () => {
                this.setSelectedFlag(layer, "locked", !layer.locked);
            }, layer.locked ? "ipc-on" : "ipc-dim"));
            if (!isFx) {
                top.appendChild(miniButton("alphaLock", layer.alphaLock ? "Alpha locked: paint only lands on existing pixels. Click to unlock" : "Lock alpha: paint only on existing pixels, transparency stays (the eraser is off)", () => {
                    layer.alphaLock = !layer.alphaLock;
                    this.renderLayers(); this.notifyChanged();
                }, layer.alphaLock ? "ipc-on" : "ipc-dim"));
            }
            top.appendChild(miniButton("duplicate", "Duplicate layer (Ctrl+J). Ctrl+C copies it, Ctrl+V pastes it here or in another tab", () => this.duplicateLayer(layer)));
            top.appendChild(miniButton("trash", inSel ? "Delete the selected layers (Delete). Ctrl+E merges them into one" : "Delete layer (Delete). Drag the row to reorder, Ctrl+] / Ctrl+[ move it up / down, Ctrl+J duplicates, Ctrl+E merges down. Ctrl / Shift + click selects several", () => (inSel ? this.removeLayers([...multi]) : this.removeLayer(layer.id)), "ipc-del"));
            row.appendChild(top);

            if (layer.id !== this.activeLayerId || this.activeGroupId) { list.appendChild(row); continue; }
            const opRow = el("div", "ipc-op");
            opRow.appendChild(el("span", null, "Opacity"));
            const op = document.createElement("input");
            op.type = "range";
            op.min = 0; op.max = 100; op.value = Math.round(layer.opacity * 100);
            op.title = "Layer opacity";
            const pct = el("b", null, Math.round(layer.opacity * 100) + "%");
            op.addEventListener("click", (e) => e.stopPropagation());
            op.addEventListener("input", () => {
                layer.opacity = op.value / 100; pct.textContent = op.value + "%";
                // A filter layer's own opacity does not change what it filters: keep its cache.
                // Layers below a filter make every filter above recompute; do that at preview size while dragging.
                if (layer.kind !== "filter") { this.filterPreview = "*"; this.uploaded.baseHash = null; this.uploaded.controlHash = null; }
                this.drawSoon();
            });
            op.addEventListener("change", () => { this.filterPreview = null; this.uploaded.baseHash = null; this.uploaded.controlHash = null; this.draw(); this.drawThumb(); this.notifyChanged(); });
            opRow.appendChild(op);
            opRow.appendChild(pct);
            row.appendChild(opRow);

            if (isFx) row.appendChild(this.buildFilterControls(layer));
            if (layer.kind === "text") row.appendChild(this.buildTextControls(layer));
            if (!isFx) {
                // colour match against the composite below, non-destructive
                const mRow = el("div", "ipc-op");
                mRow.appendChild(el("span", null, "Match"));
                const mr = document.createElement("input");
                mr.type = "range"; mr.min = 0; mr.max = 100; mr.value = Math.round((layer.match && layer.match.strength) || 0);
                mr.title = "Colour match: shift this layer's colours and contrast towards the image below (0 = off). Non-destructive; applied in the preview, in flatten and in the run.";
                const mpct = el("b", null, mr.value + "%");
                mr.addEventListener("click", (e) => e.stopPropagation());
                mr.addEventListener("pointerdown", (e) => e.stopPropagation());
                mr.addEventListener("input", () => {
                    if (!layer._matchUndo) layer._matchUndo = this.snapshot({ kind: "match", id: layer.id });
                    layer.match = { ...(layer.match || { source: "surroundings" }), strength: +mr.value };
                    mpct.textContent = mr.value + "%";
                    this.markMatchChanged(layer);
                    this.drawSoon();
                });
                mr.addEventListener("change", () => { if (layer._matchUndo) { this.pushUndoSnapshot(layer._matchUndo, { label: "Colour match strength" }); layer._matchUndo = null; } this.draw(); this.drawThumb(); this.notifyChanged(); });
                mRow.appendChild(mr);
                mRow.appendChild(mpct);
                const msrc = selectInput(["surroundings", "underneath"], (layer.match && layer.match.source) || "surroundings", "What to match against: the ring around the layer's opaque area in the image below (surroundings), or the pixels the layer covers (underneath, for results replacing what was there)");
                msrc.classList.add("ipc-narrow");
                msrc.addEventListener("change", () => { this.pushUndo({ kind: "match", id: layer.id, label: "Colour match source" }); layer.match = { ...(layer.match || { strength: 0 }), source: msrc.value }; this.markMatchChanged(layer); this.draw(); this.drawThumb(); this.notifyChanged(); });
                mRow.appendChild(msrc);
                row.appendChild(mRow);
            }

            const modeRow = el("div", "ipc-op");
            const blendLab = el("label", null, "Blend");
            const blend = selectGrouped(BLEND_GROUPS, BLENDS, layer.blend || "normal", "Blend mode");
            blend.addEventListener("change", () => { layer.blend = blend.value; this.uploaded.baseHash = null; this.draw(); this.drawThumb(); this.notifyChanged(); });
            blendLab.appendChild(blend);
            modeRow.appendChild(blendLab);
            const roleLab = el("label", null, "Role");
            const role = selectInput(ROLES, layer.role || "none", "Role: none = part of the image; reference = not in the image, sent along with crop_image as an extra batch image (Flux.2 / Kontext multi-reference); scribble, lineart, depth, pose, canny, other = control_image on black");
            role.addEventListener("change", () => this.setLayerRole(layer, role.value));
            roleLab.appendChild(role);
            roleLab.hidden = isFx;
            modeRow.appendChild(roleLab);
            row.appendChild(modeRow);

            row.appendChild(this.buildMaskRow(layer));
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
        this.renderReferences();
    }

    /**
     * A group's row in the layer list (PLAN_0_1_31 §6.5): the fold, the eye, the name, the number of layers, the lock,
     * ungroup and delete. A click selects the group's layers (they move and scale together), a drag moves the group, a
     * drop on it puts a layer or group next to it (upper half) or into it (lower half), a right click opens its menu.
     */
    buildGroupRow(g, depth) {
        const members = this.groupLayers(g.id);
        const active = this.activeGroupId === g.id && members.some((l) => l.id === this.activeLayerId);
        const row = el("div", "ipc-layer ipc-grouprow" + (active ? " ipc-selected" : "") + (this.isLocked({ locked: g.locked, group: g.parent }) ? " ipc-locked" : ""));
        row.dataset.group = g.id;
        row.style.setProperty("--ipc-depth", depth);
        if (!g.visible || !this.groupsOf(g.parent).every((p) => p.visible)) row.classList.add("ipc-ghidden");
        row.addEventListener("click", (e) => this.clickGroupRow(g, e));
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openGroupMenu(g); });
        const top = el("div", "ipc-row");
        top.draggable = true;
        top.addEventListener("dragstart", (e) => {
            this.dragGroupId = g.id; this.dragLayerId = null;
            e.dataTransfer.effectAllowed = "move";
            try { e.dataTransfer.setData("application/x-scumble-group", g.id); } catch (_) { /* ignore */ }
            row.classList.add("ipc-dragging");
        });
        top.addEventListener("dragend", () => {
            this.dragGroupId = null;
            row.classList.remove("ipc-dragging");
            this.layerList.querySelectorAll(".ipc-drop-above, .ipc-drop-below").forEach((r) => r.classList.remove("ipc-drop-above", "ipc-drop-below"));
        });
        const dragging = () => (this.dragLayerId || (this.dragGroupId && this.dragGroupId !== g.id)) ? true : false;
        row.addEventListener("dragover", (e) => {
            if (!dragging()) return;
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            const r = row.getBoundingClientRect();
            const above = e.clientY < r.top + r.height / 2;
            row.classList.toggle("ipc-drop-above", above);
            row.classList.toggle("ipc-drop-below", !above);
        });
        row.addEventListener("dragleave", () => row.classList.remove("ipc-drop-above", "ipc-drop-below"));
        row.addEventListener("drop", (e) => {
            if (!dragging()) return;
            e.preventDefault(); e.stopPropagation();
            const r = row.getBoundingClientRect();
            const what = this.dragGroupId ? { group: this.dragGroupId } : { layer: this.dragLayerId };
            this.dragLayerId = null; this.dragGroupId = null;
            this.dropInLayers(what, { group: g.id }, e.clientY < r.top + r.height / 2);
        });
        const fold = miniButton(g.collapsed ? "caretR" : "caretD", g.collapsed ? "Unfold the group" : "Fold the group", () => this.setGroupFlag(g.id, "collapsed", !g.collapsed), "ipc-fold");
        top.appendChild(fold);
        top.appendChild(miniButton(g.visible ? "eye" : "eyeOff", "Show or hide every layer of the group (their own eyes stay as they are)", () => this.setGroupFlag(g.id, "visible", !g.visible), g.visible ? "" : "ipc-off"));
        const mark = el("span", "ipc-gicon");
        mark.innerHTML = icon("folder", 16);
        top.appendChild(mark);
        const name = el("span", "ipc-name", g.name);
        name.title = `${members.length} layer${members.length === 1 ? "" : "s"}. Click to select them all (they move together), double-click to rename`;
        name.addEventListener("dblclick", (e) => { e.stopPropagation(); this.renameGroupInline(g, name); });
        top.appendChild(name);
        top.appendChild(el("span", "ipc-kind", String(members.length)));
        top.appendChild(miniButton("lock", g.locked ? "Locked: no layer of the group can be painted, moved, merged or deleted. Click to unlock" : "Lock every layer of the group", () => this.setGroupFlag(g.id, "locked", !g.locked), g.locked ? "ipc-on" : "ipc-dim"));
        top.appendChild(miniButton("ungroup", "Ungroup: the layers stay where they are, out of the group", () => this.ungroup(g.id)));
        top.appendChild(miniButton("trash", "Delete the group with its layers", () => this.removeGroup(g.id), "ipc-del"));
        row.appendChild(top);
        return row;
    }

    renameGroupInline(g, nameEl) {
        const input = document.createElement("input");
        input.type = "text";
        input.value = g.name;
        input.title = "Group name";
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (!(commit && this.renameGroup(g.id, input.value))) this.renderLayers();
            this.root.focus({ preventScroll: true });
        };
        for (const type of ["click", "pointerdown", "dblclick", "mousedown"]) input.addEventListener(type, (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
        nameEl.textContent = "";
        nameEl.appendChild(input);
        input.focus();
        input.select();
    }

    openGroupMenu(g) {
        const row = this.layerList && this.layerList.querySelector(`[data-group="${CSS.escape(g.id)}"]`);
        if (!row) return;
        const id = g.id;
        this.openFlyout({
            btn: row, items: [],
            actions: [
                { icon: "select", label: "Select its layers", title: "Select every layer of the group: they move and scale together", onClick: () => { const x = this.groupById(id); if (x) this.clickGroupRow(x, null); } },
                { icon: g.collapsed ? "caretD" : "caretR", label: g.collapsed ? "Unfold" : "Fold", onClick: () => { const x = this.groupById(id); if (x) this.setGroupFlag(id, "collapsed", !x.collapsed); } },
                { sep: true },
                { icon: "ungroup", label: "Ungroup", title: "The layers stay where they are, out of the group", onClick: () => this.ungroup(id) },
                { icon: "trash", label: "Delete group and layers", title: "Refused while one of its layers is locked", onClick: () => this.removeGroup(id) },
            ],
        }, row);
    }

    /** Transparency mask row of a layer: cutout (RMBG), from selection, edit, apply, remove. */
    buildMaskRow(layer) {
        const isFx = layer.kind === "filter";
        const maskRow = el("div", "ipc-maskrow");
        const busy = !!(this.cutoutPending && this.cutoutPending.layer === layer);
        const cut = miniButton("scissors", busy ? "Removing the background ..." : "Cutout: remove the background with the model on the right (RMBG). The result is a transparency mask you can edit.", () => this.cutoutLayer(layer));
        cut.disabled = busy || isFx || !availableCutoutBackends().length;
        maskRow.appendChild(cut);
        if (!isFx) {
            const sel = selectInput(["auto"], "auto", "Background removal model");
            this.cutoutSel = sel;
            this.refreshCutoutBackends();
            sel.addEventListener("click", (e) => e.stopPropagation());
            sel.addEventListener("change", () => { this.cutoutSettings.backend = sel.value; this.notifyChanged(); });
            maskRow.appendChild(sel);
        }
        maskRow.appendChild(miniButton("mask", "Mask from selection: only the selected part of the layer stays visible", () => this.maskFromSelection(layer)));
        const more = miniButton("more", "More mask operations: reveal all, hide all, hide the selection, invert (right-click on the mask label opens them too)", () => this.openMaskMenu(layer, more), "ipc-mask-more");
        maskRow.appendChild(more);
        maskRow.appendChild(el("span", "ipc-grow"));
        const isViewed = !!(this.maskView && this.maskView.id === layer.id);
        const labelText = isViewed ? "mask ◐" : !layer.maskPx ? "no mask" : layer.maskOff ? "mask off" : layer.maskEdit ? "mask ✎" : "mask";
        const maskLabel = el("span", layer.maskOff ? "ipc-mask-off" : null, labelText);
        if (layer.maskPx) {
            maskLabel.title = "Alt+click toggles black and white view; Shift+click switches the mask off and on; right-click for more operations";
            maskLabel.addEventListener("click", (e) => {
                if (e.altKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    const active = this.maskView && this.maskView.id === layer.id && this.maskView.mode === "alone";
                    this.maskView = active ? null : { id: layer.id, mode: "alone" };
                    this.renderLayers();
                    this.draw();
                    return;
                }
                if (e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.setMaskOff(layer);
                    return;
                }
            });
        }
        maskLabel.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openMaskMenu(layer, more); });
        maskRow.appendChild(maskLabel);
        const offBtn = miniButton(layer.maskOff ? "eyeOff" : "eye", layer.maskOff ? "The mask is switched off: switch it on" : "Switch the mask off (it stays with the layer; Shift+click on the label does the same)", () => this.setMaskOff(layer), layer.maskOff ? "ipc-on" : "");
        offBtn.disabled = !layer.maskPx;
        maskRow.appendChild(offBtn);
        const editBtn = miniButton("maskEdit", "Edit the mask with the paint (reveal) and erase (hide) tools", () => this.toggleMaskEdit(layer), layer.maskEdit ? "ipc-on" : "");
        editBtn.disabled = !layer.maskPx;
        maskRow.appendChild(editBtn);
        const applyBtn = miniButton("check", "Apply the mask to the pixels", () => this.applyMask(layer));
        applyBtn.disabled = !layer.maskPx || isFx;
        maskRow.appendChild(applyBtn);
        const delMask = miniButton("trash", "Remove the mask (the pixels stay)", () => this.removeMask(layer), "ipc-del");
        delMask.disabled = !layer.maskPx;
        maskRow.appendChild(delMask);
        return maskRow;
    }

    /** The reference list: batch order top first, thumbnail, name, eye, order, back to image, delete. */
    renderReferences() {
        this.refreshRefLayout();
        if (!this.refList) return;
        const list = this.refList;
        list.innerHTML = "";
        const refs = this.layers.filter((l) => this.isReference(l));
        const sent = this.referenceLayers();
        // a change of the shown references that no site reported leaves the prompt's @img tokens on the old labels:
        // counted for the gates (docs/PLAN_REFS.md C2), not remapped here
        if (host.refTokens && this.refMap && !this._loading && !sameLabels(this.refMap, labelMap(sent))) {
            this._refDrift = (this._refDrift || 0) + 1;
            console.warn("Scumble: the reference labels changed without a remap", [...this.refMap], sent.map((l) => l.id));
        }
        if (this.refCount) this.refCount.textContent = refs.length ? `${sent.length} of ${refs.length} sent` : "";
        for (let i = refs.length - 1; i >= 0; i--) {
            const layer = refs[i];
            const row = el("div", "ipc-layer ipc-refrow" + (layer.id === this.activeLayerId ? " ipc-selected" : ""));
            row.dataset.layer = layer.id;
            row.addEventListener("click", () => { if (this.pending) this.cancelPending(); this.activeLayerId = layer.id; this.renderLayers(); this.updateSubbar(); this.draw(); });
            // a row dragged onto another takes its place in the batch (QW7, node issue #1 ask 3): above it on its upper
            // half, below it on the lower; the same move as the arrows (reorderLayer: one undo step, the @img tokens follow)
            row.draggable = true;
            row.addEventListener("dragstart", (e) => {
                this.dragRefId = layer.id;
                row.classList.add("ipc-dragging");
                // a type of its own, not text/plain: the prompt field takes plain text dropped on it, and a row dragged
                // there by mistake would write its layer id into the prompt
                if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("application/x-scumble-reference", layer.id); }
            });
            row.addEventListener("dragend", () => {
                this.dragRefId = null;
                row.classList.remove("ipc-dragging");
                for (const r of list.querySelectorAll(".ipc-drop-above, .ipc-drop-below")) r.classList.remove("ipc-drop-above", "ipc-drop-below");
            });
            const upperHalf = (e) => { const b = row.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; };
            row.addEventListener("dragover", (e) => {
                if (!this.dragRefId || this.dragRefId === layer.id) return;
                e.preventDefault();
                e.stopPropagation();   // not a picture dropped on the list (the list's own drop adds references)
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                const above = upperHalf(e);
                // no marker on the half next to where the dragged row already is: a drop there moves nothing
                const moves = this.reorderMoves(this.dragRefId, layer.id, above);
                row.classList.toggle("ipc-drop-above", moves && above);
                row.classList.toggle("ipc-drop-below", moves && !above);
            });
            row.addEventListener("dragleave", () => row.classList.remove("ipc-drop-above", "ipc-drop-below"));
            row.addEventListener("drop", (e) => {
                const src = this.dragRefId;
                this.dragRefId = null;
                row.classList.remove("ipc-drop-above", "ipc-drop-below");
                if (!src || src === layer.id) return;
                e.preventDefault();
                e.stopPropagation();
                const moved = this.layers.find((l) => l.id === src);
                if (!moved || !this.isReference(moved)) return;
                this.reorderLayer(src, layer.id, upperHalf(e));
            });
            const top = el("div", "ipc-row");
            const hideTip = host.refTokens ? " Hiding renumbers the others; its @img tokens in the prompt wait as @img? until it is shown again." : "";
            top.appendChild(miniButton(layer.visible ? "eye" : "eyeOff", layer.visible ? "Shown and sent with crop_image. Click to hide: a hidden reference is not sent." + hideTip : "Hidden: not sent. Click to show", () => {
                layer.visible = !layer.visible;
                this.uploaded.baseHash = null;
                this.refsMutated();
                this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
            }, layer.visible ? "" : "ipc-off"));
            const th = document.createElement("canvas");
            th.className = "ipc-lthumb";
            th.width = 40; th.height = 28;
            this.drawLayerThumb(th, layer);
            top.appendChild(th);
            const name = el("span", "ipc-name", layer.name);
            name.title = `${layer.w} × ${layer.h} at ${layer.x}, ${layer.y}. Double-click to rename`;
            name.addEventListener("dblclick", (e) => { e.stopPropagation(); this.renameLayerInline(layer, name); });
            top.appendChild(name);
            const idx = sent.indexOf(layer);
            top.appendChild(el("span", "ipc-kind ipc-ref", idx >= 0 ? refBadge(idx) : "hidden"));
            const up = miniButton("up", "Earlier in the batch", () => this.moveReference(layer, +1));
            up.disabled = i === refs.length - 1;
            top.appendChild(up);
            const down = miniButton("down", "Later in the batch", () => this.moveReference(layer, -1));
            down.disabled = i === 0;
            top.appendChild(down);
            top.appendChild(miniButton("image", "Turn into a normal image layer (part of the picture)", () => {
                this.activeLayerId = layer.id;
                this.setLayerRole(layer, "none");
            }));
            top.appendChild(miniButton("trash", "Remove the reference", () => this.removeLayer(layer.id), "ipc-del"));
            row.appendChild(top);
            // a reference keeps the transparency mask row: cutting the subject out (RMBG) is
            // what a reference image is usually for, and the mask travels into the upload
            if (layer.id === this.activeLayerId) row.appendChild(this.buildMaskRow(layer));
            list.appendChild(row);
        }
        // the prompt's chips follow (a state, a label, a name); drawn again only when one of them changed
        if (this.promptField) this.promptField.refresh();
    }

    /**
     * Apply a select choice to a filter layer.
     * @param {any} layer
     * @param {any} p
     * @param {string} id
     * @param {{ rename?: boolean }} [opts]
     */
    applyChoice(layer, p, id, { rename = true } = {}) {
        const choice = p.options && p.options.find((o) => o.id === id);
        if (!choice) return;
        layer.params[p.key] = choice.id;
        if (p.key === "preset") {
            for (const [k, v] of Object.entries(choice)) {
                if (k !== "id" && k !== "label" && k !== "group") layer.params[k] = v;
            }
            if (!("look" in choice)) layer.params.look = null;
            if (rename) {
                const flabel = (FILTERS[layer.filter] && FILTERS[layer.filter].label) || "Filter";
                layer.name = choice.id === "custom" ? `${flabel} ${this.filterCounter}` : choice.label.replace(/ \(.*\)$/, "");
            }
        }
        if (rename) {
            const def = FILTERS[layer.filter];
            const whenNames = new Set();
            if (def && def.params) for (const dp of def.params) if (dp.when) for (const wk of Object.keys(dp.when)) whenNames.add(wk);
            this.markFilterChanged(layer);
            if (p.key === "preset" || whenNames.has(p.key)) {
                this.renderLayers();
            } else {
                const row = this.root && this.root.querySelector(`.ipc-layer[data-id="${layer.id}"]`);
                if (row) {
                    const sel = row.querySelector(`select.ipc-sel[data-param="${p.key}"]`);
                    if (sel && sel.value !== choice.id) sel.value = choice.id;
                }
            }
        }
    }

    /**
     * Preview a select choice on a filter layer (stores pre-hover snapshot on first call).
     * @param {any} layer
     * @param {any} p
     * @param {string} id
     */
    previewChoice(layer, p, id) {
        if (!layer) return;
        if (!layer._hoverSnap) layer._hoverSnap = this.snapshot({ kind: "filter", id: layer.id });
        this.applyChoice(layer, p, id, { rename: false });
        this.filterPreview = layer.id;
        this.markFilterChanged(layer, { soon: true });
    }

    /**
     * Cancel an active select choice preview, restoring the pre-hover snapshot.
     * @param {any} [layer]
     */
    cancelChoicePreview(layer) {
        if (!layer) {
            for (const l of this.layers) if (l._hoverSnap) this.cancelChoicePreview(l);
            return;
        }
        if (!layer._hoverSnap) return;
        const snap = layer._hoverSnap;
        layer.params = { ...(snap.params || {}) };
        if (snap.name) layer.name = snap.name;
        layer._hoverSnap = null;
        this.filterPreview = null;
        this.markFilterChanged(layer, { soon: true });
        this.draw();
    }

    /**
     * Commit a choice: cancels preview (restoring pre-hover snapshot), records undo step, then applies.
     * @param {any} layer
     * @param {any} p
     * @param {string} id
     */
    commitChoice(layer, p, id) {
        this.cancelChoicePreview(layer);
        const def = FILTERS[layer.filter];
        const step = p.label ? `${def ? def.label : "Filter"}: ${p.label}` : (def ? def.label : "Filter");
        this.pushUndo({ kind: "filter", id: layer.id, label: step });
        this.applyChoice(layer, p, id, { rename: true });
    }

    /**
     * Flyout list of choices for a select parameter, previewing each entry on hover.
     * @param {any} layer
     * @param {any} p
     * @param {HTMLElement} anchor
     */
    openChoiceList(layer, p, anchor) {
        if (this.flyout && this.flyout.group && this.flyout.group.btn === anchor) {
            this.closeFlyout();
            return;
        }
        this.closeFlyout();

        const fly = el("div", "ipc-flyout ipc-choices");
        const cur = (layer.params && layer.params[p.key] !== undefined) ? layer.params[p.key] : p.default;

        let hoverTimer = null;
        const curLayer = layer;
        const curParam = p;

        let currentGroup = null;
        for (const o of p.options) {
            if (o.needs === "depth" && !host.depthSupported && cur !== o.id) continue;
            if (o.group && o.group !== currentGroup) {
                currentGroup = o.group;
                const grp = el("div", "ipc-choices-group", currentGroup);
                fly.appendChild(grp);
            }
            const row = el("button", "ipc-choice-item ipc-choice-row" + (o.id === cur ? " ipc-current" : ""));
            row.type = "button";
            row.setAttribute("data-id", o.id);
            row.textContent = o.label;
            row.title = o.label;

            row.addEventListener("pointerenter", () => {
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    this.previewChoice(curLayer, curParam, o.id);
                }, 120);
            });
            row.addEventListener("pointerleave", () => {
                clearTimeout(hoverTimer);
            });
            row.addEventListener("click", (e) => {
                e.stopPropagation();
                clearTimeout(hoverTimer);
                this.commitChoice(curLayer, curParam, o.id);
                this.closeFlyout();
            });
            fly.appendChild(row);
        }

        fly.addEventListener("pointerleave", (e) => {
            if (e.relatedTarget && fly.contains(/** @type {Node} */ (e.relatedTarget))) return;
            clearTimeout(hoverTimer);
            this.cancelChoicePreview(curLayer);
        });

        for (const type of ["pointerdown", "pointerup", "click", "wheel", "contextmenu"]) {
            fly.addEventListener(type, (e) => e.stopPropagation());
        }

        this.root.appendChild(fly);

        const r = anchor.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
        let left = r.right - rr.left + 6;
        if (left + fly.offsetWidth > rr.width - 4) {
            left = Math.max(4, r.left - rr.left - fly.offsetWidth - 6);
        }
        fly.style.left = `${left}px`;
        const top = Math.min(r.top - rr.top, rr.height - fly.offsetHeight - 8);
        fly.style.top = `${Math.max(4, top)}px`;

        this.flyout = {
            el: fly,
            group: { btn: anchor },
            onClose: () => {
                clearTimeout(hoverTimer);
                this.cancelChoicePreview(curLayer);
            },
        };

        if (!this._flyDocDown) {
            this._flyDocDown = (e) => {
                const t = e.target instanceof Node ? e.target : null;
                if (this.flyout && (!t || (!this.flyout.el.contains(t) && !(this.flyout.group && this.flyout.group.btn && this.flyout.group.btn.contains(t))))) {
                    this.closeFlyout();
                }
            };
            window.addEventListener("pointerdown", this._flyDocDown, true);
        }
    }
}
