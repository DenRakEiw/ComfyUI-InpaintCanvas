// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_masks.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// layer masks, cutout, the mask and layer menus, clipping: moved out of inpaint_canvas.js (item 56 S5, docs/PLAN_SPLIT.md), text unchanged.

import { api, host } from "./host.js";
import { SUBFOLDER, uploadCanvas } from "./inpaint_upload.js";
import { pixelMap, xfInv, xfMul } from "./inpaint_resample.js";
import { failKind } from "./inpaint_status.js";
import { MASK_RGB, REF_FITS, RUN_GOING_TEXT, hostText, makeCanvas } from "./inpaint_consts.js";
import { availableCutoutBackends, withSpecDefaults } from "./inpaint_backends.js";
import { loadImageEl, viewUrl } from "./inpaint_load.js";

export class MasksPart {
    markMaskChanged(layer, rect, { pixels = true } = {}) {
        this.scheduleAutosave();
        layer._refAvatar = null;
        if (pixels) layer.maskDirty = !!layer.maskPx;
        if (!layer.maskPx) {
            layer.maskRef = null;
            if (this.maskView && this.maskView.id === layer.id && this.maskView.mode !== "effect") this.maskView = null;
        }
        layer._maskedValid = false;
        layer._mcache = null;
        layer._mcacheView = null; layer._mcacheSample = null;
        // `rect` (in the mask's own pixels) keeps the cached levels and refreshes them there
        if (!pixels) { /* only the switch: the mask's pixels and their levels stay */ }
        else if (rect && layer.maskPx) this.touchSourceRect(layer.maskPx, rect[0], rect[1], rect[2], rect[3]);
        else { this.touchSource(layer.maskPx); this.scheduleDetachedRelease(); }   // a new mask, or none (C6 a)
        this.touchSource(layer._masked);
        layer.exportRef = null;
        this.bumpComposite(layer, rect && layer.maskPx ? this.layerRectToImage(layer, layer.maskPx, rect) : null);
        this.uploaded.controlHash = null;
        this.drawThumb();
        this.notifyChanged();
    }

    // ---- layer masks and cutouts ------------------------------------------------

    refreshCutoutBackends() {
        if (!this.cutoutSel) return;
        const avail = availableCutoutBackends();
        const cur = this.cutoutSettings.backend;
        this.cutoutSel.innerHTML = "";
        for (const b of avail) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.cutoutSel.appendChild(o); }
        if (!avail.length) { const o = document.createElement("option"); o.value = ""; o.textContent = hostText("noCutoutOption", "no model (Settings › Helpers)"); this.cutoutSel.appendChild(o); }
        this.cutoutSel.value = avail.some((b) => b.id === cur) ? cur : (avail[0] ? avail[0].id : "");
    }

    /**
     * Remove the background of a layer with an RMBG node; the result becomes its transparency mask. Answers "started" (a
     * ComfyUI run under way: applyCutoutFile finishes it), "done" (the in-app model's mask is applied) or false (nothing
     * started or the in-app run failed; `status` says why), so a caller tells "not started" from "already finished".
     */
    async cutoutLayer(layer) {
        if (!layer || !layer.px) return false;
        if (this.resizingRun()) { this.setStatus(RUN_GOING_TEXT); return false; }
        const availCut = availableCutoutBackends();
        const backend = availCut.find((b) => b.id === this.cutoutSettings.backend) || availCut[0];
        if (!backend) { this.setStatus(hostText("noCutoutBackend", "No background removal model: download one in Settings › Helpers, or install comfyui-rmbg on the server."), "warn"); return false; }
        if (this.cutoutPending) { this.setStatus(`Still removing the background of ${this.cutoutPending.layer.name} ...`); return false; }
        try {
            this.cutoutPending = { layer, backend };
            this.renderLayers();
            this.setStatus(`Removing the background of ${layer.name} with ${backend.label} ...`);
            if (backend.inApp) { const img = await host.cutoutInApp(this, layer, backend); return (await this.applyCutoutImage(img, this.cutoutPending)) ? "done" : false; }
            // The layer's own pixels (transparent parts turn black on the way to RGB).
            const up = await uploadCanvas(layer.px.toCanvas(), `n${this.node.id}_cutsrc`);
            const prompt = {
                cut_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(up.ref) } },
                ...withSpecDefaults(backend.build("cut_load")),
                cut_out: { class_type: "InpaintCanvasMaskOut", inputs: { mask: backend.maskOut, canvas_node: String(this.node.id), purpose: "cutout" } },
            };
            this.helperUsed = true;   // a helper model (SAM2 / SAM3 / RMBG / Qwen-VL) may now sit in VRAM outside ComfyUI's model management
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.cutoutPromptId = res && res.prompt_id;
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
            return "started";
        } catch (err) {
            console.error(err);
            this.cutoutPending = null;
            this.renderLayers();
            this.setStatus("Background removal failed: " + (err.message || err), failKind(err));
            return false;
        }
    }

    /** The RMBG mask came back: grayscale PNG at the layer's pixel size -> transparency mask. */
    async applyCutoutFile(info) {
        const pending = this.cutoutPending;
        if (!pending) return;
        const layer = pending.layer;
        if (!this.layers.includes(layer)) { this.cutoutPending = null; this.renderLayers(); return; }
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            await this.applyCutoutImage(img, pending);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not apply the cutout: " + (err.message || err), failKind(err));
            if (this.cutoutPending === pending) this.cutoutPending = null;
            this.renderLayers();
        }
    }

    /** A grayscale mask (any size, white = keep) for the pending cutout's layer -> its transparency mask; true when applied. */
    async applyCutoutImage(img, pending) {
        const layer = pending.layer;
        try {
            const W = layer.px.width, H = layer.px.height;
            // the model's grey answer (not a mask yet) scaled to the layer's own pixels, its R channel becomes the alpha
            const tmp = makeCanvas(W, H);
            const tctx = tmp.getContext("2d");
            tctx.drawImage(img, 0, 0, W, H);
            const src = tctx.getImageData(0, 0, W, H).data;
            const out = new ImageData(W, H);
            const d = out.data;
            let sum = 0;
            for (let i = 0; i < src.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = src[i]; sum += src[i]; }
            const m = this.pixels.Mask.fromImageData(out);
            this.pushUndo({ kind: "mask", id: layer.id, label: "Remove background" });
            layer.maskPx = m;
            layer.maskOff = false;
            layer.maskEdit = false;
            this.markMaskChanged(layer);
            this.renderLayers();
            this.draw();
            const pct = Math.round(100 * sum / (255 * W * H));
            this.setStatus(`${layer.name}: background removed with ${pending.backend.label}, ${pct}% kept. Enable mask editing to touch it up with P / E.`);
            return true;
        } catch (err) {
            console.error(err);
            this.setStatus("Could not apply the cutout: " + (err.message || err), failKind(err));
            return false;
        } finally {
            // cleared only now: the mask is applied before the row's spinner state goes away
            if (this.cutoutPending === pending) this.cutoutPending = null;
            this.renderLayers();
        }
    }

    /**
     * Transparency mask from the selection (Krita: "add transparency mask" from selection); `hide`: the inverse, the
     * selected part is hidden (Photoshop's Hide Selection). Replaces a mask the layer has; one undo step. False when
     * nothing is selected.
     */
    maskFromSelection(layer, { hide = false } = {}) {
        if (!layer || !this.sel) return false;
        if (this.maskBlocked(layer)) return false;
        if (!this.getBounds()) { this.setStatus(hide ? "Select the area to hide first." : "Select the area to keep first."); return false; }
        this.pushUndo({ kind: "mask", id: layer.id, label: hide ? "Mask hides selection" : "Mask from selection" });
        // a new mask at the layer's own resolution (the mask undo step holds the old one): the
        // selection under the layer, turned white with its coverage kept in alpha
        const m = this.pixels.Mask.empty(layer.px.width, layer.px.height);
        const W = m.width, H = m.height;
        const reg = this.selectionWriteRegion(layer, m);   // null on canvases: the whole mask, as before
        const part = reg && reg.ext ? this.sel.toCanvas(reg.ext) : null;
        try {
            if (!reg || reg.ext) {
                m.drawInto(reg ? reg.box : null, (ctx) => {
                    // the scale composed on drawInto's transform and taken off again with restore (rule 12)
                    ctx.save();
                    ctx.scale(W / layer.w, H / layer.h);
                    if (part) ctx.drawImage(part, reg.ext[0] - layer.x, reg.ext[1] - layer.y);
                    else this.sel.drawTo(ctx, -layer.x, -layer.y);
                    ctx.restore();
                    ctx.globalCompositeOperation = "source-in";   // over the whole mask (its region on tiles, empty around it)
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, W, H);
                });
            }
        } finally {
            if (part) { part.width = 1; part.height = 1; }
        }
        if (hide) m.invert(MASK_RGB);
        layer.maskPx = m;
        layer.maskOff = false;
        layer.maskEdit = false;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(hide ? `${layer.name}: the mask hides the selected part.` : `${layer.name}: mask from selection. Only the selected part stays visible.`);
        return true;
    }

    /**
     * A mask operation can not run on a layer under a pending transform (the transform bakes the mask it had when it
     * started); true with a status line then.
     */
    maskBlocked(layer) {
        if (!(this.pending && this.pending.layer === layer)) return false;
        this.setStatus("Apply or cancel the transform first (Enter / Escape).");
        return true;
    }

    /** The mask inverted: what it showed is hidden and the other way round. One undo step; switches the mask on. */
    invertLayerMask(layer) {
        if (!layer || !layer.maskPx) { if (layer) this.setStatus(`${layer.name} has no mask to invert.`); return false; }
        if (this.maskBlocked(layer)) return false;
        this.pushUndo({ kind: "mask", id: layer.id, label: "Invert mask" });
        // new pixels (a copy-on-write clone on tiles), not a write into the old ones: the undo step holds those
        const m = layer.maskPx.clone();
        m.invert(MASK_RGB);
        layer.maskPx = m;
        layer.maskOff = false;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(`${layer.name}: mask inverted.`);
        return true;
    }

    /**
     * Reveal all (`reveal`: a white mask, the whole layer shows) or hide all (a black mask, nothing shows; paint the
     * mask to bring parts back). Adds a mask to a layer without one, replaces the one it has. One undo step.
     */
    fillLayerMask(layer, reveal) {
        if (!layer || !layer.px) return false;
        if (this.maskBlocked(layer)) return false;
        this.pushUndo({ kind: "mask", id: layer.id, label: reveal ? "Mask reveals all" : "Mask hides all" });
        const had = !!layer.maskPx;
        const m = this.pixels.Mask.empty(layer.px.width, layer.px.height);
        if (reveal) m.fill(null, "#ffffff");
        layer.maskPx = m;
        layer.maskOff = false;
        if (!had) layer.maskEdit = false;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(reveal
            ? `${layer.name}: the mask reveals the whole layer. Edit the mask and erase (E) to hide parts.`
            : `${layer.name}: the mask hides the whole layer. Edit the mask and paint (P) to bring parts back.`);
        return true;
    }

    /**
     * Copy the mask from `source` layer to `target` layer (R3-S8).
     * If both layers share equal dimensions and position, clones the mask directly (copy-on-write on tiles).
     * Otherwise, resamples source mask using transformedAsync mapping destination pixel positions to source pixel positions.
     * Outside the source layer's area the target is hidden (edge: "transparent"). One undo step.
     */
    async maskFromLayer(target, source) {
        if (!target || !target.px) return false;
        if (!source) {
            this.setStatus("from_layer needs source.");
            return false;
        }
        if (target.id === source.id) {
            this.setStatus(`${source.name}: the source layer cannot be the target layer.`);
            return false;
        }
        if (!source.maskPx) {
            this.setStatus(`${source.name} has no mask.`);
            return false;
        }
        if (this.maskBlocked(target)) return false;

        const token = (this._maskOpToken = (this._maskOpToken || 0) + 1);
        const sm = source.maskPx;
        const tw = target.px.width, th = target.px.height;
        const same = sm.width === tw && sm.height === th
            && source.x === target.x && source.y === target.y
            && source.w === target.w && source.h === target.h;

        let m;
        if (same) {
            m = sm.clone();
        } else {
            const srcToImg = [source.w / sm.width, 0, 0, source.h / sm.height, source.x, source.y];
            const dstToImg = [target.w / tw, 0, 0, target.h / th, target.x, target.y];
            const inv = xfMul(xfInv(srcToImg), dstToImg);
            const map = pixelMap(inv);
            m = await sm.transformedAsync(map, tw, th, { color: MASK_RGB, edge: "transparent" });
        }

        if (this._maskOpToken !== token) return false;
        const curTarget = this.layers.find((l) => l.id === target.id);
        if (!curTarget || curTarget.px !== target.px) {
            this.setStatus("That layer is gone.");
            return false;
        }

        this.pushUndo({ kind: "mask", id: target.id, label: "Mask from layer" });
        target.maskPx = m;
        target.maskOff = false;
        target.maskEdit = false;
        this.markMaskChanged(target);
        this.renderLayers();
        this.draw();
        this.setStatus(`${target.name}: mask copied from ${source.name}.`);
        return true;
    }

    /**
     * A mask operation by name, for the mask row's menu and `set_mask`: invert, reveal (all), hide (all), from_selection,
     * hide_selection, from_layer, enable, disable, apply, remove. True when it changed the layer; false with a status line when it
     * could not (no mask, no selection, a pending transform) or when the switch already stood that way.
     */
    maskOp(layer, op, opts = {}) {
        if (!layer) return false;
        const need = () => { if (!layer.maskPx) this.setStatus(`${layer.name} has no mask.`); return !!layer.maskPx; };
        switch (op) {
            case "invert": return this.invertLayerMask(layer);
            case "reveal": return this.fillLayerMask(layer, true);
            case "hide": return this.fillLayerMask(layer, false);
            case "from_selection": return this.maskFromSelection(layer);
            case "hide_selection": return this.maskFromSelection(layer, { hide: true });
            case "from_layer": return this.maskFromLayer(layer, opts.source);
            case "enable": case "disable": return need() && this.setMaskOff(layer, op === "disable");
            case "apply":
                if (!need() || this.maskBlocked(layer)) return false;
                // a filter layer's pixels are never drawn: its mask is all that limits the filter
                if (layer.kind === "filter") { this.setStatus(`${layer.name} is a filter layer: it has no pixels to bake the mask into.`); return false; }
                this.applyMask(layer);
                return true;
            case "remove": if (!need() || this.maskBlocked(layer)) return false; this.removeMask(layer); return true;
            default: throw new Error(`unknown mask operation "${op}"`);
        }
    }

    /** The mask row's menu (the "..." button, or a right click on the mask's label): the whole-mask operations. */
    openMaskMenu(layer, anchor) {
        if (this.flyout && this.flyout.group.btn === anchor) { this.closeFlyout(); return; }
        const has = !!layer.maskPx, id = layer.id;
        const viewing = !!(this.maskView && this.maskView.id === id);
        const isFilterWithLimit = layer.kind === "filter" && !!(layer.params && layer.params.limit);
        const clipSrc = this.maskClip ? this.layers.find((l) => l.id === this.maskClip.id) : null;
        const clipHasMask = !!(clipSrc && clipSrc.maskPx);
        const canPaste = !!(clipSrc && clipHasMask && clipSrc.id !== layer.id);
        const pasteLabel = clipSrc ? `Paste mask from ${clipSrc.name}` : "Paste mask";
        // the layer looked up at the click: an undo while the menu is open puts copies of the layers back
        const act = (icon, label, op, title, disabled = false, opts = {}) => ({ icon, label, title, disabled, onClick: () => {
            const l = this.layers.find((x) => x.id === id);
            if (l) {
                const res = this.maskOp(l, op, opts);
                if (res && typeof res.catch === "function") res.catch((err) => this.setStatus(String(err.message || err), failKind(err)));
            } else {
                this.setStatus("That layer is gone.");
            }
        } });
        this.openFlyout({
            btn: anchor, items: [],
            actions: [
                act("eye", "Reveal all", "reveal", has ? "Replace the mask with a white one: the whole layer shows" : "Add a white mask: the whole layer shows, erase on the mask to hide parts"),
                act("eyeOff", "Hide all", "hide", has ? "Replace the mask with a black one: nothing of the layer shows" : "Add a black mask: nothing of the layer shows, paint on the mask to bring parts back"),
                { sep: true },
                act("mask", "Reveal selection", "from_selection", "A mask from the selection: only the selected part shows"),
                act("mask", "Hide selection", "hide_selection", "A mask from the selection, inverted: the selected part is hidden"),
                { sep: true },
                { icon: "mask", label: "Copy mask", disabled: !has, title: "Copy this layer's mask to paste onto another layer", onClick: () => {
                    this.maskClip = { id: layer.id };
                    this.setStatus(`${layer.name}: mask copied.`);
                } },
                { icon: "mask", label: pasteLabel, disabled: !canPaste, title: clipSrc ? `Paste ${clipSrc.name}'s mask onto this layer` : "Paste a copied mask onto this layer", onClick: () => {
                    const l = this.layers.find((x) => x.id === id);
                    if (!l) { this.setStatus("That layer is gone."); return; }
                    const src = this.maskClip ? this.layers.find((x) => x.id === this.maskClip.id) : null;
                    const res = this.maskOp(l, "from_layer", { source: src });
                    if (res && typeof res.catch === "function") res.catch((err) => this.setStatus(String(err.message || err), failKind(err)));
                } },
                { sep: true },
                act("invert", "Invert mask", "invert", "What the mask shows is hidden and the other way round", !has),
                { sep: true },
                { icon: "eye", label: "Show as overlay", disabled: !has, title: "Show the mask as a red overlay where it hides", onClick: () => {
                    this.maskView = { id, mode: "overlay" };
                    this.renderLayers();
                    this.draw();
                } },
                { icon: "eye", label: "Show alone", key: "Alt+click", disabled: !has, title: "Show the mask alone in black and white (Alt+click on mask label)", onClick: () => {
                    this.maskView = { id, mode: "alone" };
                    this.renderLayers();
                    this.draw();
                } },
                ...(isFilterWithLimit ? [{ icon: "eye", label: "Show the effect", title: "Show where the filter acts (mask \u00D7 limit weight)", onClick: () => {
                    this.maskView = { id, mode: "effect" };
                    this.renderLayers();
                    this.draw();
                } }] : []),
                { icon: "eyeOff", label: "Hide the view", disabled: !viewing, title: "End the mask view", onClick: () => {
                    this.maskView = null;
                    this.renderLayers();
                    this.draw();
                } },
            ],
        }, anchor);
    }

    /**
     * A right click on a layer row: solo and the operations on the selection. A row outside the selection is selected
     * first, as a click would; one inside keeps the selection, so the entries act on all of it.
     */
    openLayerMenu(layer, e) {
        if (!this.selectedLayers().includes(layer)) this.clickLayerRow(layer, null);
        const row = this.layerList && this.layerList.querySelector(`[data-layer="${CSS.escape(layer.id)}"]`);
        if (!row) return;
        const sel = this.selectedLayers(), many = sel.length > 1;
        const ids = sel.map((l) => l.id);
        // the layers looked up at the click: an undo while the menu is open puts copies of the layers back
        const live = () => this.layers.filter((l) => ids.includes(l.id));
        const soloOn = !!this._solo && this._solo.key === [...ids].sort().join(" ");
        this.openFlyout({
            btn: row, items: [],
            actions: [
                { icon: "solo", label: soloOn ? "End solo" : (many ? "Show only these layers" : "Show only this layer"), key: "Alt+click eye",
                    title: "Hide every other layer; the same again brings back what was visible before (references stay as they are)",
                    onClick: () => { const l = live(); if (l.length) this.soloLayers(l); } },
                { icon: "eye", label: "Show all layers", title: this._solo ? "End the solo: every layer as visible as it was before" : "Show every layer of the picture",
                    onClick: () => this.showAllLayers() },
                { sep: true },
                { icon: "clip", label: layer.clip ? (many ? "Release clipping" : "Release clipping mask") : "Clip to layer below", key: "Ctrl+Alt+G",
                    title: layer.clip ? "Draw the layer on its own again" : "Show this layer only where the layer under it has pixels (also: Alt+click the line between the two rows)",
                    onClick: () => { const l = live(); if (l.length) this.setLayerClip(l.find((x) => x.id === layer.id) || l[0], !layer.clip); } },
                { icon: "folder", label: many ? `Group ${sel.length} layers` : "Group layer", key: "Ctrl+G", title: "Put the layers into a new group (a folder: its eye and lock count for all of them)",
                    onClick: () => { const l = live(); if (l.length) this.groupLayersNow(l); } },
                ...(many ? [] : [{ icon: "contentmove", label: "Match edges to the layer below",
                    title: "An inpaint that came back slightly shifted or scaled: fit the layer's own edge to the picture under it and move or resample it to match (one undo step; refused when the fit is not plausible)",
                    onClick: () => { const l = live()[0]; if (l) this.matchEdges(l); } }]),
                { sep: true },
                { icon: "merge", label: many ? `Merge ${sel.length} layers` : "Merge down", key: "Ctrl+E", title: many ? "Merge the selected layers into one, at the place of the topmost" : "Merge into the layer below",
                    onClick: () => (many ? this.mergeSelected() : this.mergeDown(live()[0])) },
                { icon: "trash", label: many ? `Delete ${sel.length} layers` : "Delete layer", key: "Del", title: "Locked layers stay",
                    onClick: () => this.removeLayers(ids) },
            ],
        }, row);
    }

    /**
     * Clip a layer to the layer below it, or release it (PLAN_0_1_31 §6 step 3): `on` true / false, null switches. With
     * `layer` in a multi-selection every selected layer goes the same way. One "layers" undo step; false when nothing
     * changed or the change was refused (the bottom layer, a reference or control layer).
     */
    setLayerClip(layer, on = null, { only = false } = {}) {
        if (!layer) { this.setStatus("Select a layer to clip."); return false; }
        const sel = this.selectedLayers();
        const ls = !only && sel.length > 1 && sel.includes(layer) ? sel : [layer];
        const want = on == null ? !layer.clip : !!on;
        if (want) {
            const bad = ls.find((l) => this.isReference(l) || this.isControl(l));
            if (bad) { this.setStatus(`${bad.name} is not part of the picture (${this.isReference(bad) ? "a reference" : "a control layer"}): there is nothing to clip.`); return false; }
            const lowest = ls.reduce((m, l) => Math.min(m, this.layers.indexOf(l)), Infinity);
            if (lowest <= 0 || ls.length === this.layers.length) { this.setStatus("The bottom layer has no layer below it to clip to."); return false; }
        }
        const change = ls.filter((l) => !!l.clip !== want);
        if (!change.length) { this.setStatus(want ? "Already clipped to the layer below." : "Not clipped."); return false; }
        this.pushUndo({ kind: "layers", label: want ? "Clip to layer below" : "Release clipping" });
        for (const l of change) l.clip = want;
        this.visibilityChanged();
        const base = want ? this.clipBaseOf(change[0]) : null;
        this.setStatus(want ? (base ? `${change.length > 1 ? `${change.length} layers` : change[0].name} clipped to ${base.name}: shown only where it is. Alt+click the line between the rows releases it.` : `${change[0].name} is clipped, but the layer below is a filter layer: the clip has no effect until a picture layer is below.`)
            : `${change.length > 1 ? `${change.length} layers` : change[0].name} released: drawn as a layer of its own again.`, want && !base ? "warn" : "info");
        return true;
    }

    /**
     * The layer an Alt+click at `e` on a row of the layer list would clip or release: the pointer within a few pixels of
     * the line between two rows names the upper row's layer (the row itself at its bottom edge, the row above at its top
     * edge); null elsewhere, on a control, or at the edge of the list.
     */
    clipEdgeLayer(row, e) {
        if (e.target && e.target.closest && e.target.closest("input, select, button, textarea")) return null;
        const r = row.getBoundingClientRect(), edge = 5;
        let upper = null;
        if (e.clientY >= r.bottom - edge) upper = row.nextElementSibling && row.nextElementSibling.dataset && row.nextElementSibling.dataset.layer ? row : null;
        else if (e.clientY <= r.top + edge) upper = row.previousElementSibling && row.previousElementSibling.dataset && row.previousElementSibling.dataset.layer ? row.previousElementSibling : null;
        return upper ? this.layers.find((l) => l.id === upper.dataset.layer) || null : null;
    }

    /** Alt+click on the line between two rows: the upper layer is clipped to the one below, or released. True when it was that. */
    clipEdgeClick(row, e) {
        const l = this.clipEdgeLayer(row, e);
        if (!l) return false;
        e.preventDefault(); e.stopPropagation();
        this.setLayerClip(l, !l.clip, { only: true });
        return true;
    }

    /** "Show all layers": ends a solo if one is on, else shows every layer of the picture. */
    showAllLayers() {
        if (this._solo) return this.unsolo();
        for (const l of this.layers) if (!this.isReference(l)) l.visible = true;
        for (const g of this.groups) g.visible = true;
        this.visibilityChanged();
        this.setStatus("All layers shown.");
        return true;
    }

    /** Bake the mask into the layer's alpha. */
    applyMask(layer, { silent = false, undo = true } = {}) {
        if (!layer || !layer.maskPx) return;
        if (undo) this.pushUndo({ kind: "layerfull", id: layer.id, label: "Apply mask" });
        if (layer.maskOff) { layer.maskOff = false; layer._maskedValid = false; }   // applying bakes the mask in, switched off or not
        const masked = this.layerPixels(layer);
        // new pixels, not a write into the old ones: the layerfull undo step and a running
        // encode of it may still read the old object
        const out = makeCanvas(layer.px.width, layer.px.height);
        out.getContext("2d").drawImage(masked, 0, 0);
        layer.px = this.pixels.Layer.fromCanvas(out);
        layer.maskPx = null;
        layer.maskOff = false;
        layer.maskRef = null;
        layer.maskDirty = false;
        layer.maskEdit = false;
        if (this.maskView && this.maskView.id === layer.id) this.maskView = null;
        this.markLayerChanged(layer);
        if (!silent) { this.renderLayers(); this.draw(); this.setStatus(`${layer.name}: mask applied to the pixels.`); }
    }

    /**
     * Switch a layer's mask off or on (`off` left out: the other way), PSD's "disabled" mask: it stays with the layer,
     * moves and saves with it, and the layer is drawn as if it had none. One undo step. False when nothing changed.
     */
    setMaskOff(layer, off = !(layer && layer.maskOff)) {
        if (!layer || !layer.maskPx || !!layer.maskOff === !!off) return false;
        this.pushUndo({ kind: "layers", label: off ? "Switch mask off" : "Switch mask on" });
        layer.maskOff = !!off;
        if (off) layer.maskEdit = false;
        this.markMaskChanged(layer, null, { pixels: false });
        this.renderLayers();
        this.draw();
        this.setStatus(off ? `${layer.name}: mask switched off. It stays with the layer; Shift+click the mask switch to turn it on.` : `${layer.name}: mask switched on.`);
        return true;
    }

    removeMask(layer) {
        if (!layer || !layer.maskPx) return;
        this.pushUndo({ kind: "mask", id: layer.id, label: "Remove mask" });
        layer.maskPx = null;
        layer.maskOff = false;
        layer.maskEdit = false;
        if (this.maskView && this.maskView.id === layer.id) this.maskView = null;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(`${layer.name}: mask removed, the whole layer is visible again.`);
    }

    toggleMaskEdit(layer) {
        if (!layer || !layer.maskPx) return;
        if (!layer.maskEdit && layer.maskOff) this.setMaskOff(layer, false);
        layer.maskEdit = !layer.maskEdit;
        for (const l of this.layers) if (l !== layer) l.maskEdit = false;
        this.activeLayerId = layer.id;
        if (layer.maskEdit && this.tool !== "paint" && this.tool !== "erase") this.setTool("paint");
        this.renderLayers();
        this.draw();
        this.setStatus(layer.maskEdit ? `${layer.name}: editing the mask. Paint (P) reveals, erase (E) hides, Shift+F reveals the selection.` : `${layer.name}: editing pixels again.`, "info");
    }

    // ---- reference images -----------------------------------------------------------

    syncRefControls() {
        if (this.refFitSel) this.refFitSel.value = REF_FITS.includes(this.refSettings.fit) ? this.refSettings.fit : "pad";
        this.refreshCutoutBackends();
    }

    /**
     * Where reference number `k` (0-based, counting every reference) of `px`'s size goes: a third of the canvas, cascaded
     * from the top left. The file itself stays the reference; the box is only how it is shown.
     */
    referenceBox(px, k) {
        const nw = px.width, nh = px.height;
        const s = Math.min(1, (Math.max(this.width, this.height) / 3) / Math.max(nw, nh));
        const off = 16 + (k % 8) * 24;
        return { x: off, y: off, w: Math.max(1, Math.round(nw * s)), h: Math.max(1, Math.round(nh * s)) };
    }
}
