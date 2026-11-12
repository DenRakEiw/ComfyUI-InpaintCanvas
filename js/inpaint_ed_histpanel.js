// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_histpanel.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the history panel and the new canvas dialog: moved out of inpaint_canvas.js (item 56 S3, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { uploadCanvas } from "./inpaint_upload.js";
import { pixelMap, xfBox, xfInv, xfMul, xfScale } from "./inpaint_resample.js";
import { parse, remap } from "./reftokens.js";
import { failKind } from "./inpaint_status.js";
import { makeCanvas } from "./inpaint_consts.js";
import { boxOnPixels, orientIsUp, orientMatrix, orientOps, validXf } from "./inpaint_orient.js";
import { el, miniButton } from "./inpaint_dom.js";
import { loadImageEl, viewUrl } from "./inpaint_load.js";

export class HistoryPanelPart {
    // ---- history -------------------------------------------------------------

    renderHistory() {
        if (!this.historyList) return;
        const list = this.historyList;
        list.innerHTML = "";
        if (!this.history.length) {
            list.appendChild(el("div", "ipc-sec", "Results show up here with a preview."));
            return;
        }
        for (let i = this.history.length - 1; i >= 0; i--) {
            const h = this.history[i];
            const layer = this.layers.find((l) => l.id === h.layerId) || null;
            const item = el("div", "ipc-hitem" + (layer ? "" : " ipc-gone"));
            const thumb = document.createElement("canvas");
            thumb.width = 112; thumb.height = 112;
            thumb.dataset.hist = i;   // redrawThumbsOf finds it when the layer's mips land (C6 b)
            thumb.title = "Solo: show only this result";
            this.drawHistoryThumb(thumb, h);
            thumb.addEventListener("click", (e) => { e.stopPropagation(); if (e.ctrlKey || e.shiftKey) { this.setCompare(e.ctrlKey ? "a" : "b", h); return; } this.soloResult(h); });
            item.appendChild(thumb);
            const text = el("div", "ipc-htext");
            const title = el("b", null, h.name + (layer ? "" : " (discarded)"));
            text.appendChild(title);
            text.appendChild(el("span", null, `${h.w} × ${h.h} at ${h.x}, ${h.y}`));
            if (h.via) text.appendChild(el("span", "ipc-hvia", h.via));
            if (h.seed != null) {
                const meta = el("span", null, `${h.mode || "api"} · seed ${h.seed}` + (h.mode === "local" && h.denoise != null ? ` · denoise ${h.denoise}` : ""));
                meta.title = "Click to use this seed again";
                meta.style.cursor = "pointer";
                meta.addEventListener("click", (e) => { e.stopPropagation(); this.genSettings.seed = h.seed; this.genSettings.seedRandom = false; this.syncGenControls(); this.notifyChanged(); this.setStatus(`Seed ${h.seed} set (random off).`); });
                text.appendChild(meta);
            } else if (h.seed === null && h.mode) {
                text.appendChild(el("span", null, `${h.mode} · no seed sent`));
            }
            if (h.prompt) {
                // like the seed: a click puts the prompt back in the field, Ctrl+click copies it (node issue #1, ask 4)
                const p = el("span", "ipc-hprompt", h.prompt);
                p.title = h.prompt + "\n(click: use this prompt again; Ctrl+click: copy it)";
                p.style.cursor = "pointer";
                p.addEventListener("click", (e) => { e.stopPropagation(); this.reusePrompt(h, { copy: e.ctrlKey || e.metaKey }); });
                text.appendChild(p);
            }
            item.appendChild(text);
            if (layer) {
                item.appendChild(miniButton("solo", "Solo: show only this result", () => this.soloResult(h)));
                item.appendChild(miniButton("trash", "Discard: remove the layer (the file stays, restore is possible)", () => this.removeLayer(layer.id), "ipc-del"));
            } else {
                item.appendChild(miniButton("restore", "Restore this result as a layer", () => this.restoreResult(h)));
            }
            list.appendChild(item);
        }
    }

    /**
     * A result's prompt (S4; node issue #1, ask 4): back into the prompt field, its @img tokens written for the references
     * shown now (h.refs says which layer each one named at the click; one that is not shown waits as @img?), Revert
     * holding the prompt before; `copy`: to the clipboard instead. Refused while an upsample's answer is on its way.
     */
    async reusePrompt(h, { copy = false } = {}) {
        if (!h || !h.prompt) return false;
        let text = String(h.prompt);
        // an entry from before 0.1.48 kept no refs: its numbered tokens stay as they are, and the line says to check them
        const legacy = !(h.refs && typeof h.refs === "object") && parse(text).some((s) => s.type === "token" && s.n != null);
        if (host.refTokens) {
            const before = new Map();
            if (h.refs && typeof h.refs === "object") for (const [k, id] of Object.entries(h.refs)) { const m = /^img(\d+)$/.exec(k); if (m) before.set(id, +m[1]); }
            // also with no refs: a parked token (@img?<id>) whose layer is shown again gets its number
            text = remap(text, before, this.refLabels());
        }
        if (copy) {
            try {
                if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
                else {
                    // the node opened over plain http on another machine has no clipboard API: the old way
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand("copy");
                    ta.remove();
                    if (!ok) throw new Error("the browser refused it");
                }
                this.setStatus(`The prompt of ${h.name} is on the clipboard.`, "info");
                return true;
            } catch (err) {
                this.setStatus(`The prompt could not be copied: ${(err && err.message) || err}`, "error");
                return false;
            }
        }
        if (this.upsamplePending) { this.setStatus("Wait for the upsampling to finish: its answer would replace the prompt.", "info"); return false; }
        this.promptBackup = this.promptText;
        if (this.upRevertBtn) this.upRevertBtn.disabled = false;
        this.setPromptText(text);
        this.notifyChanged();
        const parked = new Set(parse(text).filter((s) => s.type === "token" && s.id != null).map((s) => s.id)).size;
        this.setStatus(`The prompt of ${h.name} is back in the field; Revert puts the one before back.`
            + (parked ? ` ${parked} of its reference${parked > 1 ? "s are" : " is"} not shown now: ${parked > 1 ? "their tokens wait" : "its token waits"} as @img? until shown again.` : "")
            + (legacy ? " It was saved before results kept their references: check that its @img chips name the pictures you mean." : ""), parked || legacy ? "warn" : "info");
        return true;
    }

    drawHistoryThumb(canvas, h) {
        const paint = (img) => {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // the file turned as the document was since (the entry's `orient`)
            const quarter = !!(h.orient && (h.orient.turn & 1));
            const iw = quarter ? img.height : img.width, ih = quarter ? img.width : img.height;
            const s = Math.min(canvas.width / iw, canvas.height / ih);
            const w = iw * s, hh = ih * s;
            ctx.save();
            ctx.translate((canvas.width - w) / 2, (canvas.height - hh) / 2);
            ctx.scale(s, s);
            if (!orientIsUp(h.orient)) ctx.transform(...orientMatrix(h.orient, img.width, img.height));
            ctx.drawImage(img, 0, 0);
            ctx.restore();
        };
        const layer = this.layers.find((l) => l.id === h.layerId);
        if (layer && layer.px) {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const s = Math.min(canvas.width / layer.px.width, canvas.height / layer.px.height);
            const w = layer.px.width * s, hh = layer.px.height * s;
            this.drawLayerFitted(ctx, layer, (canvas.width - w) / 2, (canvas.height - hh) / 2, w, hh);
            return;
        }
        const paintXf = (img) => {
            // an entry that went through a straighten: its file drawn through its map, fitted into the thumbnail
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const m = xfMul(h.xf, xfScale(1 / (img.naturalWidth || img.width), 1 / (img.naturalHeight || img.height)));
            const b = xfBox(m, 0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height);
            const s = Math.min(canvas.width / (b[2] - b[0]), canvas.height / (b[3] - b[1]));
            ctx.save();
            ctx.translate((canvas.width - (b[2] - b[0]) * s) / 2, (canvas.height - (b[3] - b[1]) * s) / 2);
            ctx.scale(s, s);
            ctx.translate(-b[0], -b[1]);
            ctx.transform(...m);
            ctx.drawImage(img, 0, 0);
            ctx.restore();
        };
        const draw = (img) => (validXf(h.xf) ? paintXf(img) : paint(img));
        if (h.thumbImg) { draw(h.thumbImg); return; }
        loadImageEl(viewUrl(h.ref)).then((img) => { h.thumbImg = img; draw(img); }).catch(() => { /* ignore */ });
    }

    soloResult(h) {
        for (const l of this.layers) {
            if (l.kind !== "result") continue;
            l.visible = l.id === h.layerId;
        }
        const layer = this.layers.find((l) => l.id === h.layerId);
        if (layer) this.activeLayerId = layer.id;
        this.uploaded.baseHash = null;
        this.refsMutated();   // a result layer may be a reference
        this.renderLayers();
        this.renderInfo();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
        this.setStatus(layer ? `Showing only ${h.name}.` : `${h.name} is discarded; restore it first.`, "info");
    }

    /**
     * Replace the base image with these pixels. Used by "Generate new" (the model's answer
     * becomes the image) and by anything that turns a result into the new base. `keepRefs`: the reference layers stay
     * (hidden ones too), every other layer goes (26f). Returns { width, height, kept, dropped } (layers).
     */
    async setBaseFromCanvas(canvas, { keepLayers = false, keepRefs = false } = {}) {
        if (this.pending) this.cancelPending();
        if (this.textEdit) this.endTextEdit(false);
        const { ref } = await uploadCanvas(canvas, `n${this.node.id}_base`);
        // C6 (d): a copy of the caller's canvas (the canvas backend adopts a canvas it is given), not the upload decoded again
        const px = this.pixels.Layer.fromImage(canvas, canvas.width, canvas.height);
        const keep = keepRefs && !keepLayers ? this.layers.filter((l) => this.isReference(l)) : null;
        const dropped = keepLayers ? 0 : this.layers.length - (keep ? keep.length : 0);
        if (!keepLayers) {
            this.layers = [];
            this.activeLayerId = null;
            this.history = [];
            this.savedSelections = [];
            this.maps = {};
            this.mapsVersion++;
            this.guides = { x: [], y: [] };
            this.compare = null;
            this.sel = null;
        }
        await this.setBasePixels(ref, px, { keepLayers, keep });
        this.clearUndo();
        this.renderHistory();
        this.renderSelectionList();
        return { width: this.width, height: this.height, kept: keep ? keep.length : 0, dropped };
    }

    /**
     * The models the New dialog offers (host.newCanvasChoices: the app's host; the node's has none or answers null), or
     * null when there is no model besides "Any size": the dialog then asks for the width and height alone.
     */
    newCanvasModels() {
        if (typeof host.newCanvasChoices !== "function") return null;
        let ch = null;
        try { ch = host.newCanvasChoices(this); } catch (err) { console.error(err); return null; }
        return ch && Array.isArray(ch.models) && ch.models.some((m) => m && typeof m.value === "string" && m.value) ? ch : null;
    }

    /**
     * The New dialog with the host's models (item 34, docs/PLAN_NEW_PRESETS.md section 8; the app's
     * host.newCanvasChoices, the node has none): Model ("Any size" first, then grouped), Provider (hidden when the model
     * has one way to run), the provider's own Aspect and Size class, a note with the canvas the preset makes, then Width
     * and Height, which show that canvas and are disabled while a model is chosen, and are free with "Any size" (from
     * the document's size). A change of model or provider keeps the aspect and the class where the new lists have them,
     * else takes the nearest. A class may carry `labels` ({ aspect: label }): its name at an aspect where the provider
     * counts it otherwise (a tier by area). Resolves with { width, height, target, about } (target null for "Any size")
     * or null when cancelled.
     */
    async askNewCanvas(choices, message, curW, curH) {
        const models = choices.models.filter((m) => m && typeof m === "object" && typeof m.value === "string");
        // "Any size" (value "") is what the dialog opens on without a preset: added when the host's list lacks it, or the
        // Model select would show the first model while the boxes are free, and Create would make that model's canvas
        if (!models.some((m) => m.value === "")) models.unshift({ value: "", label: "Any size", group: "", providers: [] });
        const ASPECT = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/;
        const ratioOf = (a) => { const m = ASPECT.exec(String(a == null ? "" : a)); return m && +m[1] > 0 && +m[2] > 0 ? +m[1] / +m[2] : null; };
        const nearestAspect = (r, list) => {
            if (!(r > 0)) return null;
            let best = null, bestD = Infinity;
            for (const a of list) {
                const q = ratioOf(a);
                if (!q) continue;
                const d = Math.abs(Math.log(q / r));
                if (d < bestD - 1e-12) { best = a; bestD = d; }
            }
            return best;
        };
        const nearestClass = (list, want) => {
            const w = +want > 0 ? +want : 1024;
            return list.reduce((best, c) => (!best || Math.abs(+c.value - w) < Math.abs(+best.value - w) ? c : best), null);
        };
        // the canvas of a preset: the host's rule (the class's long side, at most 2048 px, multiples of 16), else the same
        const working = (aspect, px) => {
            const wh = typeof choices.working === "function" ? choices.working(aspect, px) : null;
            if (Array.isArray(wh) && +wh[0] > 0 && +wh[1] > 0) return [Math.round(+wh[0]), Math.round(+wh[1])];
            const r = ratioOf(aspect) || 1, L = Math.min(+px || 1024, 2048);
            const r16 = (v) => Math.max(64, Math.min(8192, Math.round(v / 16) * 16));
            return r >= 1 ? [r16(L), r16(L / r)] : [r16(L * r), r16(L)];
        };
        const modelOf = (v) => (v ? models.find((m) => m.value === v) || null : null);
        const providersOf = (m) => (m && Array.isArray(m.providers) ? m.providers.filter((p) => p && typeof p === "object") : []);
        const aspectsOf = (p) => (p && Array.isArray(p.aspects) ? p.aspects.map(String) : []);
        const classesOf = (p) => (p && Array.isArray(p.classes) ? p.classes.filter((k) => k && +k.value > 0) : []);
        // what the dialog shows; `free` is the size "Any size" makes (the document's, then what was typed)
        const st = { model: "", provider: "", aspect: null, size: null, free: [curW, curH] };
        const pick = choices.pick;
        if (pick && modelOf(pick.model)) Object.assign(st, { model: pick.model, provider: pick.provider || "", aspect: pick.aspect || null, size: +pick.size || null });
        // the model, its provider (the one asked for, else the first: the remembered one), the aspect and the class (the
        // ones before when offered, else the nearest, else the first) and the canvas they make
        const current = () => {
            const m = modelOf(st.model);
            const provs = providersOf(m);
            const p = provs.find((x) => x.value === st.provider) || provs[0] || null;
            if (!m || !p) return { m: null, p: null, aspect: null, cls: null, single: true, wh: st.free };
            const aspects = aspectsOf(p);
            const shape = ratioOf(st.aspect) || (st.free[0] > 0 && st.free[1] > 0 ? st.free[0] / st.free[1] : null);
            const aspect = st.aspect && aspects.includes(st.aspect) ? st.aspect : nearestAspect(shape, aspects) || aspects[0] || null;
            const cls = nearestClass(classesOf(p), st.size || Math.max(st.free[0], st.free[1]));
            const px = cls ? +cls.value : null;
            // what is shown is what the next change keeps or nears
            st.provider = p.value;
            if (aspect) st.aspect = aspect;
            if (px) st.size = px;
            return { m, p, aspect, cls, single: provs.length === 1 && !provs[0].value, wh: working(aspect, px) };
        };
        // a class's name at the aspect shown (its `labels` where the provider counts that aspect otherwise)
        const classLabel = (k, aspect) => (k.labels && aspect && k.labels[aspect]) || k.label || `${k.value} px`;
        const asks = (c) => [c.cls ? classLabel(c.cls, c.aspect) : "", c.aspect ? `at ${c.aspect}` : ""].filter(Boolean).join(" ");
        const noteOf = (c) => {
            if (!c.m) return "Choose a model to make the canvas in its aspect, at a working size for its size class.";
            const a = asks(c);
            return `Canvas ${c.wh[0]} \u00d7 ${c.wh[1]} px${a ? `; Generate new asks for ${a}` : ""}.`;
        };
        const providerOptions = (c) => providersOf(c.m).map((p) => ({ value: p.value, label: p.label || p.value }));
        const aspectOptions = (c) => aspectsOf(c.p).map((a) => ({ value: a, label: a }));
        const classOptions = (c) => classesOf(c.p).map((k) => ({ value: String(k.value), label: classLabel(k, c.aspect) }));
        const c0 = current();
        const fields = [
            { key: "model", label: "Model", type: "select", wide: true, value: c0.m ? c0.m.value : "",
                options: models.map((m) => ({ value: m.value, label: m.label || m.value || "Any size", group: m.value ? m.group || "" : "" })) },
            { key: "provider", label: "Provider", type: "select", wide: true, options: providerOptions(c0), value: c0.p ? c0.p.value : "", hidden: c0.single },
            { key: "aspect", label: "Aspect", type: "select", options: aspectOptions(c0), value: c0.aspect || "", hidden: !c0.m },
            { key: "size", label: "Size class", type: "select", options: classOptions(c0), value: c0.cls ? String(c0.cls.value) : "", hidden: !c0.m },
            { key: "note", type: "note", text: noteOf(c0) },
            { key: "width", label: "Width", value: c0.wh[0], min: 16, max: 16384, disabled: !!c0.m },
            { key: "height", label: "Height", value: c0.wh[1], min: 16, max: 16384, disabled: !!c0.m },
        ];
        const onChange = (key, values, set) => {
            if (key === "width" || key === "height") {
                if (!modelOf(st.model)) st.free = [+values.width, +values.height];
                return;
            }
            if (key === "model") { st.model = values.model; st.provider = ""; }
            else if (key === "provider") st.provider = values.provider;
            else if (key === "aspect") st.aspect = values.aspect || null;
            else if (key === "size") st.size = +values.size || null;
            else return;
            const c = current();
            set("provider", { options: providerOptions(c), value: c.p ? c.p.value : "", hidden: c.single });
            set("aspect", { options: aspectOptions(c), value: c.aspect || "", hidden: !c.m });
            set("size", { options: classOptions(c), value: c.cls ? String(c.cls.value) : "", hidden: !c.m });
            set("note", { text: noteOf(c) });
            set("width", { value: c.wh[0], disabled: !!c.m });
            set("height", { value: c.wh[1], disabled: !!c.m });
        };
        const answer = await this.ask({ title: "New empty canvas", message, fields, linked: true, ok: "Create", danger: !!this.base, onChange });
        if (answer == null) return null;
        // the answer as it stands (a select set without its change event counts too)
        st.model = modelOf(answer.model) ? answer.model : "";
        if (st.model) {
            if (answer.provider != null) st.provider = answer.provider;
            if (answer.aspect) st.aspect = answer.aspect;
            if (+answer.size > 0) st.size = +answer.size;
        }
        const c = current();
        if (!c.m) return { width: answer.width, height: answer.height, target: null, about: "" };
        const [w, h] = c.wh;
        const name = (c.m.label || c.m.value) + (c.single ? "" : ` (${c.p.label || c.p.value})`);
        const a = asks(c);
        return {
            width: w, height: h,
            target: { recipe: c.m.value, provider: c.p.value || null, aspect: c.aspect || null, size: c.cls ? +c.cls.value : Math.max(w, h), width: w, height: h },
            about: `for ${name}${a ? `; Generate new asks for ${a}` : ""}`,
        };
    }

    /**
     * A fresh white canvas after a confirmation; the size is asked for in the same dialog. `keepRefs`: the reference
     * layers stay, placed again on the new canvas (generate_new's local path, 26f). In the app the dialog also offers the
     * models (askNewCanvas): a canvas made for one keeps it as `genSettings.target`, which Generate new opens on, and
     * selects its recipe (host.newCanvasChosen); "Any size" leaves none. A size given (`"1024x768"`) asks nothing and
     * leaves the preset to the caller.
     */
    async newCanvas(size = null, { keepRefs = false } = {}) {
        const curW = this.width || 1024, curH = this.height || 1024;
        const what = this.base ? `This discards the current image, ${this.layers.length} layer${this.layers.length === 1 ? "" : "s"}, the selection and ${this.history.length} history entr${this.history.length === 1 ? "y" : "ies"} in this editor.` : "";
        let w, h;
        let choices = null, preset = null;   // the dialog's models (the app's host only) and what was made from them
        if (size != null) {
            const m = /^\s*(\d{2,5})\s*[x*,\s\u00d7]\s*(\d{2,5})\s*$/i.exec(String(size));
            if (!m) { this.setStatus("Size not understood. Use width x height, e.g. 1024x1024."); return; }
            w = +m[1]; h = +m[2];
        } else if ((choices = this.newCanvasModels()) != null) {
            const got = await this.askNewCanvas(choices, what, curW, curH);
            if (got == null) { this.setStatus("New canvas cancelled."); return; }
            w = got.width; h = got.height;
            preset = got;
        } else {
            const answer = await this.ask({
                title: "New empty canvas",
                message: what,
                fields: [{ key: "width", label: "Width", value: curW, min: 16, max: 16384 },
                    { key: "height", label: "Height", value: curH, min: 16, max: 16384 }],
                linked: true,
                ok: "Create",
                danger: !!this.base,
            });
            if (answer == null) { this.setStatus("New canvas cancelled."); return; }
            w = answer.width; h = answer.height;
        }
        if (!(w >= 16) || !(h >= 16)) { this.setStatus("Width and height must be at least 16 pixels.", "warn"); return; }
        w = Math.min(16384, Math.round(w)); h = Math.min(16384, Math.round(h));
        try {
            this.setStatus(`Creating a ${w} × ${h} canvas ...`);
            if (this.pending) this.cancelPending();
            if (this.textEdit) this.endTextEdit(false);
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, w, h);
            const { ref } = await uploadCanvas(c, `n${this.node.id}_base`);
            const px = this.pixels.Layer.fromCanvas(c);   // C6 (d): not the upload decoded again
            const keep = keepRefs ? this.layers.filter((l) => this.isReference(l)) : null;
            this.layers = [];
            this.activeLayerId = null;
            this.history = [];
            this.savedSelections = [];
            this.maps = {};
            this.mapsVersion++;
            this.guides = { x: [], y: [] };
            this.compare = null;
            this.sel = null;
            await this.setBasePixels(ref, px, { keepLayers: false, keep });
            this._blankBase = true;
            this.clearUndo();
            this.renderHistory();
            this.renderSelectionList();
            this.setStatus(`New ${w} × ${h} canvas.${keep && keep.length ? ` The reference layer${keep.length > 1 ? "s stay" : " stays"}.` : ""} Load an image as a layer, paint, or select and generate.`);
            if (size == null) {
                // item 34: the preset this canvas was made for stays with the document (inside `gen`, saved with it;
                // Generate new opens on it while the picture keeps this size) and selects its recipe; a canvas of a
                // size typed in ("Any size", or a host without models) has none
                const target = preset && preset.target ? { ...preset.target, width: this.width, height: this.height } : null;
                if (target) {
                    this.genSettings.target = target;
                    let failed = null;
                    if (typeof host.newCanvasChosen === "function") {
                        try { await host.newCanvasChosen(this, { ...target }); } catch (err) { console.error(err); failed = err; }
                    }
                    this.notifyChanged();
                    this.setStatus(failed
                        ? `New ${w} \u00d7 ${h} canvas, but its model could not be selected: ${failed.message || failed}`
                        : `New ${w} \u00d7 ${h} canvas ${preset.about}.`, failed ? "warn" : "info");
                } else {
                    if (this.genSettings.target) { delete this.genSettings.target; this.notifyChanged(); }
                    // the next New opens on "Any size", as this one was made
                    if (choices && typeof host.newCanvasChosen === "function") {
                        try { await host.newCanvasChosen(this, null); } catch (err) { console.error(err); }
                    }
                }
            }
        } catch (err) {
            console.error(err);
            this.setStatus("Could not create the canvas: " + (err.message || err), failKind(err));
        }
    }

    async clearHistory() {
        if (!this.history.length) { this.setStatus("The history is already empty."); return; }
        const gone = this.history.filter((h) => !this.layers.some((l) => l.id === h.layerId)).length;
        const msg = `Clear ${this.history.length} result${this.history.length === 1 ? "" : "s"} from the history? Layers are kept.` +
            (gone ? ` ${gone} discarded result${gone === 1 ? "" : "s"} can no longer be restored.` : "");
        if (!(await this.ask({ title: "Clear the history", message: msg, ok: "Clear", danger: true })) || !this.history.length) return;
        this.history = [];
        this.renderHistory();
        this.notifyChanged();
        this.setStatus("History cleared.");
    }

    async restoreResult(h) {
        try {
            const img = h.thumbImg || await loadImageEl(viewUrl(h.ref));
            // the file as the model answered; turned as the document was since (its `orient`), then a file of its own
            let px = this.pixels.Layer.fromImage(img);
            let layer;
            if (validXf(h.xf)) {
                // it went through a straighten: resampled once into its turned rectangle, at the file's own resolution
                const fw = px.width, fh = px.height;
                const rect = boxOnPixels(h.xf, 0, 0, 1, 1);
                const rx = fw / Math.hypot(h.xf[0], h.xf[1]), ry = fh / Math.hypot(h.xf[2], h.xf[3]);
                const npw = Math.max(1, Math.round(rect[2] * rx)), nph = Math.max(1, Math.round(rect[3] * ry));
                const inv = xfMul(xfScale(fw, fh), xfMul(xfInv(h.xf), [rect[2] / npw, 0, 0, rect[3] / nph, rect[0], rect[1]]));
                const turned = px.transformed(pixelMap(inv), npw, nph);
                px.release();
                layer = this.addLayer({ name: h.name, kind: "result", ref: null, px: turned, x: rect[0], y: rect[1], w: rect[2], h: rect[3], dirty: true });
            } else {
                for (const op of orientOps(h.orient)) px = px.turned(op);
                const up = orientIsUp(h.orient);
                layer = this.addLayer({ name: h.name, kind: "result", ref: up ? h.ref : null, px, x: h.x, y: h.y, w: h.w, h: h.h, ...(up ? {} : { dirty: true }) });
            }
            h.layerId = layer.id;
            this.renderHistory();
            this.setStatus(`${h.name} restored.`);
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        }
    }
}
