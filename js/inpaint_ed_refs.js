// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_refs.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// reference layers and the @img prompt tokens: moved out of inpaint_canvas.js (item 56 S10b, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { labelMap, remap } from "./reftokens.js";
import { setFieldText } from "./inpaint_dom.js";

export class RefsPart {
    isControl(layer) {
        return !!(layer.role && layer.role !== "none" && layer.role !== "reference");
    }

    isReference(layer) {
        return layer.role === "reference";
    }

    /** Visible reference layers in panel order (top of the list = reference 1). */
    referenceLayers() {
        return this.layers.filter((l) => this.isReference(l) && l.visible && l.px).reverse();
    }

    /** The label of each shown reference by layer id: top of the list = 1, what @img1 names. */
    refLabels() {
        return labelMap(this.referenceLayers());
    }

    /**
     * What a run sends, read at the click (docs/PLAN_REFS.md C3): the prompt, the negative, the shown references by id
     * (top first) and their labels. A reference hidden while the crop is made still goes; one deleted refuses.
     */
    refSnapshot() {
        const refs = this.referenceLayers();
        return { prompt: this.promptText || "", negative: this.negativeText || "", refIds: refs.map((l) => l.id), labels: labelMap(refs) };
    }

    /** The reference layers of a snapshot, in its order; no ids: the shown ones now. */
    refLayersFor(ids) {
        if (!ids) return this.referenceLayers();
        return ids.map((id) => {
            const l = this.layers.find((x) => x.id === id);
            if (!l || !this.isReference(l) || !l.px) throw new Error("A reference layer was deleted while the run was being prepared: press Generate again.");
            return l;
        });
    }

    /**
     * 1 when a run would send the Original (the crop before the fill) as the first reference picture, as planCrop decides
     * it: a selection, a fill, "Original" on, and no refine pass (a local run's refine sends no fill). `local`: the run is
     * a local one whatever the mode switch says.
     */
    predictOriginal({ local = false } = {}) {
        const cs = this.cropSettings || {};
        const refine = !!this.genSettings.refine && (local || this.genSettings.mode === "local");
        return this.getBounds && this.getBounds() && cs.fill && cs.fill !== "none" && cs.withOriginal && !refine ? 1 : 0;
    }

    /**
     * Every reference layer, top first, as the prompt field and agents describe it (C4): label null for one that is
     * hidden (or has no pixels), `sentAs` the name the chosen route gives its picture (`refLayoutInfo`, null unknown),
     * `over` past the route's cap. `info`: another route's layout than the tab's (the Generate new dialog's, 26f).
     */
    refDescriptors(info = this.refLayoutInfo) {
        const labels = this.refLabels();
        return this.layers.filter((l) => this.isReference(l)).reverse().map((l) => ({
            id: l.id, label: labels.get(l.id) || null, name: l.name || "", visible: !!l.visible, thumb: null,
            sentAs: info && info.names && labels.has(l.id) ? info.names.get(l.id) || null : null,
            over: !!(info && info.over && labels.has(l.id) && info.over.has(l.id)),
        }));
    }

    /**
     * The shown references changed (added, deleted, moved, hidden or shown, a role change, a merge, an undo of a layers
     * step): every @img token of the prompt, the negative, Revert's text, a running upsample's text and the registered
     * fields is rewritten from the labels of the last change to the labels now, by layer id, so a token keeps naming
     * its picture. A token whose layer has no label now waits as @img?<id>. Called at the site of the change, before
     * its first render (renderReferences counts a change nobody reported). `alias`: a merge, the absorbed layer's id to
     * the survivor's, whose label its tokens take. `restore`: setValue, which runs while `_loading` holds the others off.
     */
    refsMutated({ alias = null, restore = false } = {}) {
        if (!host.refTokens || (this._loading && !restore)) return;
        const after = this.refLabels(), before = this.refMap || after;
        let target = after;
        if (alias) {
            target = new Map(after);
            for (const [from, to] of alias) if (after.has(to)) target.set(from, after.get(to));
        }
        const r = (t) => (t ? remap(t, before, target) : t);
        const p = r(this.promptText);
        // the field's undo too when the text stays the same: an older state may name a reference that moved
        if (p !== this.promptText || this.promptField) this.setPromptText(p, { keepCaret: true, history: r });
        const n = r(this.negativeText);
        if (n !== this.negativeText) this.setNegativeText(n);
        this.remapOthers(r);
        this.refMap = after;
    }

    /**
     * The labels read again where the prompt came back together with the layers (a turn snapshot) or the layers went
     * (a new picture): nothing the snapshot holds is rewritten. `carry`: what it does not hold (Revert's text, a running
     * upsample's, the registered fields) is remapped from the labels before to the ones now.
     */
    refsRebuilt({ carry = false } = {}) {
        if (!host.refTokens) { this.refMap = null; return; }
        const after = this.refLabels();
        if (carry && this.refMap) {
            const before = this.refMap;
            this.remapOthers((t) => (t ? remap(t, before, after) : t));
        }
        this.refMap = after;
    }

    /** Revert's text, a running upsample's text and the registered fields through a remap. */
    remapOthers(r) {
        if (this.promptBackup != null) this.promptBackup = r(this.promptBackup);
        if (this.upsamplePending) {
            // the answer still to come is in the numbering of the click: it goes through every remap since (26d1)
            const p = this.upsamplePending, prev = p.carry;
            p.previous = r(p.previous);
            p.carry = prev ? (t) => r(prev(t)) : r;
        }
        // every registered field gets the remap, its text unchanged too: its own undo is mapped and it redraws (the
        // Generate new dialog's bar follows a hide or an add from an agent)
        for (const f of this._remapTargets) f.setText(r(f.value), { keepCaret: true, history: r });
    }

    /**
     * A field outside the editor whose text names this document's references (the Generate new dialog's prompt): it is
     * remapped with the prompt. `field` has `value` and `setText(text, { keepCaret, history })`, called at every remap
     * (with the same text too, so the field can map its undo and redraw). Returns the dispose.
     */
    addRemapTarget(field) {
        this._remapTargets.add(field);
        return () => this._remapTargets.delete(field);
    }

    /**
     * The prompt set from code (Upsample, Revert, an agent, a remap, a restore). `keepCaret`: the caret stays after the
     * same word when the field has the focus. `history` is for the prompt field's own undo (docs/PLAN_REFS.md C4:
     * "push", "reset" or a text-to-text function); the textarea keeps none of its own. The field normalises the text
     * (line breaks, the tokens' prefix), and `promptText` takes what it holds, so the two never differ.
     */
    setPromptText(text, { keepCaret = false, history = "push" } = {}) {
        if (this.promptField) {
            this.promptField.setText(text, { keepCaret, history });
            this.promptText = this.promptField.el.value;
            return;
        }
        this.promptText = String(text == null ? "" : text);
        setFieldText(this.promptInput, this.promptText, keepCaret);
    }

    /**
     * What the prompt field draws its chips, its picker and its bar from (docs/PLAN_REFS.md C4): every reference layer,
     * top first, hidden ones with label null, each with a 32 px thumbnail; from the chosen route's layout
     * (`refLayoutInfo`, 26c2) the cap on reference layers, why none goes (`none`), a ComfyUI recipe (`local`: its
     * pictures go in the crop_image batch, named as its graph numbers them, 26e), why a token cannot go although the
     * pictures do (`refuse`); `reason` says why a parked token's layer has no descriptor, `show` shows a hidden
     * reference as its eye does. `info`: another route's layout than the tab's (the Generate new dialog's, 26f). A
     * reference can be added to an empty tab too: it gets a white canvas, which Generate new then replaces (26f).
     */
    refContext(info = this.refLayoutInfo) {
        const byId = new Map(this.layers.map((l) => [l.id, l]));
        const refs = this.refDescriptors(info).map((d) => ({ ...d, thumb: this.refAvatar(byId.get(d.id)) }));
        const local = !!(info && info.local);
        return {
            refs, cap: info && info.cap != null ? info.cap : null, none: (info && info.none) || null, local,
            refuse: (info && info.refuse) || null,
            canAdd: !!this.width || !!host.refTokens,
            reason: (id) => (byId.has(id) ? "no longer a reference: make it a reference again to send it" : "deleted: an undo brings it back"),
            show: (id) => this.showReference(id),
        };
    }

    /**
     * A hidden reference shown, as its eye in the reference list shows it (no undo step): its parked tokens come back as
     * @img<n> (refsMutated). The swap menu's "Show <name>".
     */
    showReference(id) {
        const layer = this.layers.find((l) => l.id === id);
        if (!layer || !this.isReference(layer) || layer.visible) return false;
        layer.visible = true;
        this.uploaded.baseHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
        return true;
    }

    /**
     * The chosen route's layout of the shown references read again (`host.refLayout`, which keeps it as
     * `refLayoutInfo`), 120 ms after the last call, and the prompt field drawn from it: the names on the hover card and
     * in the picker, the cap in the bar, an over or none chip. A later call wins over an answer still on its way.
     */
    refreshRefLayout() {
        if (!host.refTokens || !this.promptField || this._destroyed) return;
        clearTimeout(this._refLayTimer);
        this._refLayTimer = setTimeout(async () => {
            const seq = this._refLaySeq = (this._refLaySeq || 0) + 1;
            try { await host.refLayout(this); } catch (_) { /* the chips stay as they are */ }
            if (seq !== this._refLaySeq || this._destroyed || !this.promptField) return;
            this.promptField.refresh();
            this.renderInfoRows();
        }, 120);
    }

    /**
     * Pictures added as reference layers for the prompt field (its picker's "+ Add reference", the bar's "+", a paste
     * or a drop on it): the new references' ids, top first. Never a base: in an empty tab the app makes a white canvas
     * first (Generate new replaces it and keeps the references, 26f); the node's editor only says so.
     * @param {File[]} files
     * @returns {Promise<string[]>}
     */
    async addReferencesForPrompt(files) {
        if (!this.width && !host.refTokens) { this.setStatus("Load an image first: a reference goes beside a picture."); return []; }
        const before = new Set(this.layers.map((l) => l.id));
        await this.addImageLayers(Array.from(files || []), "reference", { blank: true });
        return this.layers.filter((l) => !before.has(l.id) && this.isReference(l)).reverse().map((l) => l.id);
    }

    /** A reference's picture for the prompt field's hover card, fitted into the canvas's own size. */
    refPreview(id, canvas) {
        const layer = this.layers.find((l) => l.id === id);
        if (!layer || !canvas) return;
        const css = Math.round(canvas.width / ((typeof window !== "undefined" && window.devicePixelRatio) || 1));
        canvas.style.width = canvas.style.height = `${css}px`;
        this.drawLayerThumb(canvas, layer);
    }

    /**
     * A reference's picture for its chip: 32 × 32, cover-cropped, as a PNG data URL. Kept on the layer for the pixels
     * and the live mask it was drawn from (a rotation replaces the pixels, the mask switch changes the live mask), and
     * dropped when either changes in place (markLayerChanged, markMaskChanged, redrawThumbsOf). A 32 px canvas stays in
     * software: no GPU readback.
     */
    refAvatar(layer) {
        if (!layer || !layer.px || !layer.px.width || !layer.px.height) return null;
        // held weakly: a replaced layer's pixels must not live on in the cache
        const mask = this.liveMask(layer), got = layer._refAvatar;
        if (got && got.px.deref() === layer.px && (got.mask ? got.mask.deref() : null) === mask) return got.url;
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        const s = Math.max(32 / layer.px.width, 32 / layer.px.height);
        const w = layer.px.width * s, h = layer.px.height * s;
        try {
            this.drawLayerFitted(c.getContext("2d"), layer, (32 - w) / 2, (32 - h) / 2, w, h);
            layer._refAvatar = { url: c.toDataURL("image/png"), px: new WeakRef(layer.px), mask: mask ? new WeakRef(mask) : null };
        } catch (_) { return null; }
        return layer._refAvatar.url;
    }

    /** The negative prompt set from code, as setPromptText. */
    setNegativeText(text, { keepCaret = false } = {}) {
        this.negativeText = String(text == null ? "" : text);
        setFieldText(this.negativeInput, this.negativeText, keepCaret);
    }

    /** Layer `layer` becomes a reference, an image layer or a control (one undo step); a new reference goes below the others. */
    setLayerRole(layer, role) {
        role = role || "none";
        if (!layer || (layer.role || "none") === role) return;
        this.pushUndo({ kind: "layers", label: "Layer role" });
        const was = this.isReference(layer);
        layer.role = role;
        layer.exportRef = null;
        // below the lowest reference, so it takes the next number and none of the others moves
        if (host.refTokens && !was && this.isReference(layer)) {
            const rest = this.layers.filter((l) => l !== layer);
            const j = rest.findIndex((l) => this.isReference(l));
            if (j >= 0) { rest.splice(j, 0, layer); this.layers = rest; }
        }
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.refsMutated();
        this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
    }

    /** One place up (dir +1) or down in the reference list: past the next reference, not the next layer of the stack. */
    moveReference(layer, dir) {
        const refs = this.layers.filter((l) => this.isReference(l));
        const i = refs.indexOf(layer);
        const other = i < 0 ? null : refs[i + (dir > 0 ? 1 : -1)];
        if (!other) return;
        this.reorderLayer(layer.id, other.id, dir > 0);
    }
}
