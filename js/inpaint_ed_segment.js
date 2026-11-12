// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_segment.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// select by text, prompt upsampling, SAM objects and mask files: moved out of inpaint_canvas.js (item 56 S5, docs/PLAN_SPLIT.md), text unchanged.

import { api, host } from "./host.js";
import { selectionGco } from "./inpaint_raster.js";
import { SUBFOLDER, uploadCanvas } from "./inpaint_upload.js";
import { checkNote, compare, namesFor, normalize, parse, remap } from "./reftokens.js";
import { failKind, refusal } from "./inpaint_status.js";
import { RUN_GOING_TEXT, hostText, makeCanvas } from "./inpaint_consts.js";
import { OBJECT_BACKEND, SEGMENT_BACKENDS, availableSegmentBackends, availableUpsampleBackends, objectBackendAvailable, segmentTermInstruction, upsampleInstruction, withSpecDefaults } from "./inpaint_backends.js";
import { loadImageEl, viewUrl } from "./inpaint_load.js";

export class SegmentPart {
    // ---- text segmentation -----------------------------------------------------

    refreshSegmentBackends() {
        if (!this.segBackendSel) return;
        const avail = availableSegmentBackends();
        const cur = this.segBackendSel.value;
        this.segBackendSel.innerHTML = "";
        for (const b of avail) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.segBackendSel.appendChild(o); }
        // no ComfyUI at all (the app on a machine without one): the route needs a server, not a node pack (review F25)
        if (!avail.length) { const o = document.createElement("option"); o.value = ""; o.textContent = host.connected ? "no segmentation nodes installed" : "needs a ComfyUI (none connected)"; this.segBackendSel.appendChild(o); }
        if (avail.some((b) => b.id === cur)) this.segBackendSel.value = cur;
        this.segBtn.disabled = !avail.length;
        this.updateSegQuality();
        if (this.upBackendSel) {
            const ups = availableUpsampleBackends();
            const curUp = this.upsampleSettings.backend;
            this.upBackendSel.innerHTML = "";
            for (const b of ups) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.upBackendSel.appendChild(o); }
            if (!ups.length) { const o = document.createElement("option"); o.value = ""; o.textContent = hostText("noUpsampleOption", "no language model (Settings › API providers, or ComfyUI-QwenVL)"); this.upBackendSel.appendChild(o); }
            if (ups.some((b) => b.id === curUp)) this.upBackendSel.value = curUp;
            this.upBtn.disabled = !ups.length;
        }
        if (this.upCaseSel) this.upCaseSel.value = this.upsampleSettings.useCase || "auto";
    }

    /** The HQ toggle (large SAM) only applies to the GroundingDINO + SAM backend. */
    updateSegQuality() {
        if (this.segQualityLab) this.segQualityLab.hidden = this.segBackendSel.value !== "dino_sam";
    }

    /** A run whose landing resizes the document holds it (the app's host): a helper's answer would land in the old geometry. */
    resizingRun() {
        return !!(this.providerPending && this.providerPending.resizes);
    }

    async segmentByText() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        if (this.resizingRun()) { this.setStatus(RUN_GOING_TEXT, "info"); return; }
        let text = (this.segInput.value || "").trim();
        // Empty field but a prompt: let the language model name the object the prompt is about.
        const fromPrompt = !text && !!(this.promptText || "").trim();
        const llm = fromPrompt ? (availableUpsampleBackends().find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0]) : null;
        if (!text && !fromPrompt) { this.setStatus("Type what to select, e.g. \"shirt\", or write a prompt and press Go to select what it is about."); this.segInput.focus(); return; }
        if (fromPrompt && !llm) { this.setStatus("Type what to select: no language model nodes installed to derive it from the prompt.", "warn"); this.segInput.focus(); return; }
        const backend = SEGMENT_BACKENDS.find((b) => b.id === this.segBackendSel.value) || availableSegmentBackends()[0];
        if (!backend) {
            if (!host.connected) { this.setStatus("Selection by text runs on your ComfyUI (SAM3 or segment-anything there), and none is connected: connect one in the top bar, or select with the object tool, which needs no ComfyUI.", "warn"); return; }
            this.setStatus("No segmentation nodes installed (comfyui_segment_anything or comfyui-rmbg).", "warn"); return;
        }
        try {
            this.segBtn.disabled = true;
            this.setStatus(fromPrompt ? `Asking ${llm.label} what the prompt is about, then segmenting with ${backend.label} ...` : `Segmenting "${text}" with ${backend.label} ...`);
            const { ref, layer } = await this.segmentSource();
            const threshold = Math.min(0.95, Math.max(0.05, +this.segThreshold.value || 0.3));
            const prompt = {
                seg_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
            };
            // the language model sees the crop alone, so an @img token is "the reference image" to it
            const asked = host.refTokens ? namesFor(this.promptText.trim(), () => "the reference image").text : this.promptText.trim();
            if (fromPrompt && llm.inApp) {
                text = (await host.askLLM(llm, segmentTermInstruction(asked), await this.promptContextCanvas())).text.replace(/[."']/g, "").trim();
                if (!text) throw new Error(`${llm.label} named no object`);
                this.setStatus(`Segmenting "${text}" (from the prompt, ${llm.label}) with ${backend.label} ...`);
            } else if (fromPrompt) {
                // term_run: VLM -> STRING, linked straight into the segmentation node's prompt input
                Object.assign(prompt, llm.build("seg_load", segmentTermInstruction(asked)));
                prompt.term_run = prompt.up_run; delete prompt.up_run;
                text = ["term_run", llm.textOut[1]];
            }
            Object.assign(prompt, withSpecDefaults(backend.build("seg_load", text, threshold, { quality: this.segQuality.checked }, backend)));
            prompt.seg_out = { class_type: "InpaintCanvasMaskOut", inputs: { mask: backend.maskOut, canvas_node: String(this.node.id), purpose: "segment", ...(fromPrompt ? { label: text } : {}) } };
            this.helperUsed = true;   // a helper model (SAM2 / SAM3 / RMBG / Qwen-VL) may now sit in VRAM outside ComfyUI's model management
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.segmentPromptId = res && res.prompt_id;
            this.segmentPending = { text: fromPrompt ? "" : text, mode: this.segMode, layer, fromPrompt };
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
        } catch (err) {
            console.error(err);
            this.segmentPending = null;
            this.segBtn.disabled = false;
            this.setStatus("Segmentation failed: " + (err.message || err), failKind(err));
        }
    }

    /**
     * What a segmentation model should look at, as an uploaded reference.
     * "image": the flattened visible layers (what the inpaint chain sees).
     * "active layer": only that layer on neutral grey; results are clipped to its alpha.
     */
    async segmentSource() {
        const layerMode = this.segSourceSel && this.segSourceSel.value === "active layer";
        if (layerMode) {
            const layer = this.activeLayer();
            if (!layer) throw refusal("no active layer: pick a layer in the list or set Source to image");
            const c = makeCanvas(this.width, this.height);
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#808080";
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
            const up = await uploadCanvas(c, `n${this.node.id}_segsrc`);
            return { ref: up.ref, hash: `layer:${layer.id}:${up.hash}`, layer };
        }
        let ref = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !ref) {
            if (!this.layers.some((l) => this.shown(l) && !this.isControl(l)) && this.base.ref) {
                ref = this.base.ref;
                this.uploaded.baseHash = "orig:" + this.base.ref.filename;
            } else {
                const up = await this.uploadComposite({ forRun: true }, `n${this.node.id}_base`);
                ref = up.ref; this.uploaded.baseHash = up.hash;
            }
            this.uploaded.baseRef = ref;
        }
        if (this.base && ref === this.base.ref && typeof host["ensureRefs"] === "function") {
            const sent = { filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" };
            const key = `${sent.type}/${sent.subfolder}/${sent.filename}`;
            let report = null;
            try {
                report = await host["ensureRefs"]([sent]);
            } catch (err) {
                if (host.connected) throw err;
            }
            if (report && report.missing && report.missing.length) throw new Error("These files are neither on the server nor in the local store: " + report.missing.join(", "));
            if (report && report.renamed && report.renamed[key]) sent.filename = report.renamed[key];
            ref = sent;
        }
        return { ref, hash: this.uploaded.baseHash, layer: null };
    }

    /** Uint8Array (W*H) with 1 where the layer is opaque, in image coordinates. */
    layerAlpha(layer) {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        const a = ctx.getImageData(0, 0, this.width, this.height).data;
        const out = new Uint8Array(this.width * this.height);
        for (let i = 3, j = 0; i < a.length; i += 4, j++) out[j] = a[i] > 0 ? 1 : 0;
        return out;
    }

    // ---- prompt upsampling -----------------------------------------------------

    /**
     * The crop the model will see, with the selection outlined in magenta (or solid green when Fill is green), long
     * side <= 1024. A promise: on tiles (C6 c5) the picture is a region pass at the output's level and the selection
     * the mask's own levels, both with their chains built in the mips worker. It was a full-resolution flatten and the
     * selection's display mirror: at 15000 x 10000 about 3.4 GB made and 2.9 GB kept for a 1024 px picture.
     */
    async promptContextCanvas() {
        const [x, y, w, h] = this.cropRect();
        const scale = Math.min(1, 1024 / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        let c, ctx;
        if (this.tileMode) {
            c = await this.sampleRegionSettled("image", [x, y, x + w, y + h], scale, { forRun: true });
            ctx = c.getContext("2d");
            ctx.setTransform(1, 0, 0, 1, 0, 0);   // the pass left its transform on the context
        } else {
            await this.relightIdle();   // as sampleRegionSettled waits on tiles (F2.7)
            const flat = this.flattenToCanvas({ forRun: true });
            c = makeCanvas(cw, ch);
            ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(flat, x, y, w, h, 0, 0, c.width, c.height);
        }
        if (this.getBounds()) {
            // the selection at the output's size: from its tiles, or `sel.drawTo` on canvases (as it always was)
            const m = await this.selectionCanvasSettled([x, y, x + w, y + h], scale, c.width, c.height);
            const drawSel = (t, dx, dy) => m ? t.drawImage(m, dx, dy) : this.sel.drawTo(t, x, y, w, h, dx, dy, c.width, c.height);
            if (this.cropSettings.fill === "green") {
                // what the generator sees: the area solid green
                const tmp = makeCanvas(c.width, c.height);
                const t = tmp.getContext("2d");
                drawSel(t, 0, 0);
                t.globalCompositeOperation = "source-in";
                t.fillStyle = "#00ff00";
                t.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(tmp, 0, 0);
            } else {
                // a magenta outline around the selection: a tint would change the
                // colours the model is asked to describe
                const ring = makeCanvas(c.width, c.height);
                const r = ring.getContext("2d");
                const px = Math.max(2, Math.round(c.width / 300));
                for (let dx = -px; dx <= px; dx += px) for (let dy = -px; dy <= px; dy += px) drawSel(r, dx, dy);
                r.globalCompositeOperation = "destination-out";
                drawSel(r, 0, 0);
                r.globalCompositeOperation = "source-in";
                r.fillStyle = "#ff00ff";
                r.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(ring, 0, 0);
            }
        }
        return c;
    }

    resolveUseCase() {
        const uc = this.upsampleSettings.useCase || "auto";
        if (uc !== "auto") return uc;
        const b = this.getBounds();
        if (b && (b[0] <= 0 || b[1] <= 0 || b[2] >= this.width || b[3] >= this.height)) return "outpaint";
        // Edit models (Flux.2, Kontext, Klein) want an instruction, not a description.
        // "fill" stays available for latent inpaint models that want a description.
        return "edit";
    }

    async upsamplePrompt() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        if (this.upsamplePending) { this.setStatus("Upsampling is already running."); return; }
        const backend = availableUpsampleBackends().find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0];
        if (!backend) { this.setStatus(hostText("noUpsampleBackend", "No language model: add an OpenAI, Google or Anthropic key in Settings › API providers, or install ComfyUI-QwenVL on the server."), "warn"); return; }
        // the @img tokens (docs/PLAN_REFS.md 26d1): the request and its labels as they are now, the references it names
        let request = this.promptText || "", labels = null, refs = [];
        if (host.refTokens) {
            const snap = this.refSnapshot();
            labels = snap.labels;
            request = remap(snap.prompt, labels, labels);   // a parked token typed for a layer that has a label names it
            const why = this.upsampleRefProblems(request, labels);
            if (why) { this.setStatus(`Upsampling needs every @img token to name a shown reference: ${why}. Show or restore the layer, or take the token out.`); return; }
            refs = this.namedRefs(request, labels);
        }
        const text = request.trim();
        const useCase = this.resolveUseCase();
        const region = this.getBounds() ? (this.cropSettings.fill === "green" ? "the solid green area" : "the area inside the magenta outline") : "the whole image";
        try {
            this.upBtn.disabled = true;
            this.upsamplePending = { previous: this.promptText, useCase, ...(labels ? { request, labels: new Map(labels), refs } : {}) };
            this.upsampleCheck = null;
            this.setStatus(`Upsampling the prompt for "${useCase}" with ${backend.label} ...`);
            if (backend.inApp) { await host.upsampleInApp(this, backend, upsampleInstruction(useCase, text, region, this.getBounds() ? this.selectionLabel : "", refs), refs); return; }
            const { ref } = await uploadCanvas(await this.promptContextCanvas(), `n${this.node.id}_promptctx`);
            const prompt = {
                up_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
                // the ComfyUI helper gets the names and the rule, no pictures (26d2: until a node release)
                ...withSpecDefaults(backend.build("up_load", upsampleInstruction(useCase, text, region, this.getBounds() ? this.selectionLabel : "", refs))),
                up_out: { class_type: "InpaintCanvasTextOut", inputs: { text: backend.textOut, canvas_node: String(this.node.id), purpose: "upsample" } },
            };
            this.helperUsed = true;   // a helper model (SAM2 / SAM3 / RMBG / Qwen-VL) may now sit in VRAM outside ComfyUI's model management
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.upsamplePromptId = res && res.prompt_id;
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
        } catch (err) {
            console.error(err);
            this.upsamplePending = null;
            this.upBtn.disabled = false;
            this.setStatus("Upsampling failed: " + (err.message || err), failKind(err));
        }
    }

    /**
     * Why the prompt's tokens cannot be upsampled (26d1), or "": a parked token has no picture and no line in
     * `{references}`, and a number no shown reference holds names nothing. `labels`: the labels of the request.
     */
    upsampleRefProblems(text, labels) {
        const out = [], seen = new Set();
        const held = new Set(labels.values());
        for (const seg of parse(text)) {
            if (seg.type !== "token") continue;
            const tok = normalize(seg.text);
            if (seen.has(tok)) continue;
            seen.add(tok);
            if ("n" in seg) { if (!held.has(seg.n)) out.push(`${tok} names none`); continue; }
            const l = this.layers.find((x) => x.id === seg.id);
            if (!l) out.push(`${tok} names a deleted layer`);
            else if (!this.isReference(l)) out.push(`"${l.name}" is no longer a reference`);
            else out.push(`"${l.name}" is ${l.visible ? "empty" : "hidden"}`);
        }
        return out.join(", ");
    }

    /** The references a text's live tokens name, by label (26d1): `[{ id, n, name }]`. */
    namedRefs(text, labels) {
        const idOf = new Map([...labels].map(([id, n]) => [n, id]));
        const ns = [...new Set(parse(text).filter((s) => s.type === "token" && "n" in s).map((s) => /** @type {any} */ (s).n))].sort((a, b) => a - b);
        return ns.filter((n) => idOf.has(n)).map((n) => {
            const id = idOf.get(n), l = this.layers.find((x) => x.id === id);
            return { id, n, name: (l && l.name) || "" };
        });
    }

    /**
     * The rewritten prompt came back from the helper prompt. With @img tokens (26d1) the answer is checked against the
     * request when that named references (a token dropped or added, a picture named by number: `upsampleCheck` and a
     * note in the status), and then carried through every change of the references since the click (`carry`, the same
     * remaps Revert's text went through: a reorder, a hide, a merge into another reference), the check's tokens too.
     */
    applyTextResult(info) {
        const pending = this.upsamplePending || { previous: this.promptText, useCase: "?" };
        this.upsamplePending = null;
        this.upBtn.disabled = false;
        let text = (info.text || "").trim();
        if (!text) { this.setStatus("The model returned an empty prompt.", "error"); return; }
        let note = "";
        if (host.refTokens) {
            text = normalize(text);
            const carry = pending.carry || ((t) => t);
            if (pending.refs && pending.refs.length) {
                // compared in the numbering of the click, as both texts are, then told in the numbering of now
                const cmp = compare(pending.request || "", text, pending.refs.map((r) => r.n));
                cmp.dropped = cmp.dropped.map(carry);
                cmp.invented = cmp.invented.map(carry);
                if (cmp.dropped.length || cmp.invented.length || cmp.literals.length) this.upsampleCheck = cmp;
                note = checkNote(cmp);
            }
            if (pending.labels) text = carry(text);
        }
        this.promptBackup = pending.previous;
        this.upRevertBtn.disabled = false;
        this.setPromptText(text);
        this.notifyChanged();
        this.setStatus(`Prompt upsampled for "${pending.useCase}" (${text.split(/\s+/).length} words).${note ? " " + note : ""} Revert puts the old one back.`, note ? "warn" : "info");
    }

    revertPrompt() {
        if (this.promptBackup === null) return;
        const current = this.promptText;
        this.setPromptText(this.promptBackup);
        this.promptBackup = current;   // revert twice = redo
        this.notifyChanged();
        this.setStatus("Prompt reverted.");
    }

    // ---- object selection (hover) ---------------------------------------------

    /** Make sure the object map matches the current source; run SAM2 if not. */
    async ensureObjects() {
        if (!this.base || this.objectsPending) return;
        if (this.resizingRun()) { if (!String(this.status || "").startsWith(RUN_GOING_TEXT)) this.setStatus(RUN_GOING_TEXT); return; }
        if (!objectBackendAvailable()) {
            // asked on every pointer move while the tool hovers: write (and log) the line once
            const t = hostText("noObjectBackend", "Object selection needs a SAM2 model: download one in Settings › Helpers, or install ComfyUI-segment-anything-2 (Kijai) on the server.");
            if (this.status !== t) this.setStatus(t, "warn");
            return;
        }
        this.objectsPending = { stage: "upload" };
        try {
            if (host.objectsInApp()) {
                // in-app SAM2 reads its own 1024 px input and keys the map on a hash of it: no full-resolution flatten,
                // PNG and upload, whose only use here was that hash (C6 c slice 6)
                const layerMode = this.segSourceSel && this.segSourceSel.value === "active layer";
                const layer = layerMode ? this.activeLayer() : null;
                if (layerMode && !layer) throw refusal("no active layer: pick a layer in the list or set Source to image");
                await host.findObjects(this, { layer });
                return;
            }
            const { ref, hash, layer } = await this.segmentSource();
            if (this.objects && this.objects.hash === hash && this.objects.w === this.width && this.objects.h === this.height) { this.objectsPending = null; return; }
            this.setStatus(`Finding objects with ${OBJECT_BACKEND.label} ...`);
            const prompt = {
                obj_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
                ...OBJECT_BACKEND.build("obj_load", String(this.node.id)),
            };
            this.helperUsed = true;   // a helper model (SAM2 / SAM3 / RMBG / Qwen-VL) may now sit in VRAM outside ComfyUI's model management
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
            this.objectsPending = { stage: "run", hash, layer, promptId: res && res.prompt_id };
            this.objectsPromptId = res && res.prompt_id;
        } catch (err) {
            console.error(err);
            this.objectsPending = null;
            this.setStatus("Object detection failed: " + (err.message || err), failKind(err));
        }
    }

    /** The label map came back: decode R + 256*G into object ids. */
    async applySegmentsFile(info) {
        const pending = this.objectsPending || {};
        this.objectsPending = null;
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            const w = info.width || img.naturalWidth, h = info.height || img.naturalHeight;
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, w, h).data;
            const ids = new Uint16Array(w * h);
            for (let i = 0, j = 0; i < d.length; i += 4, j++) ids[j] = d[i] + (d[i + 1] << 8);
            this.applySegmentIds(ids, w, h, info.count || 0, pending);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not read the object map: " + (err.message || err), failKind(err));
        }
    }

    /** An object label map (0 = none) at w × h becomes this.objects, clipped to the source layer. */
    applySegmentIds(ids, w, h, count, pending = {}) {
        {
            if (pending.layer && w === this.width && h === this.height) {
                const clip = this.layerAlpha(pending.layer);
                for (let j = 0; j < ids.length; j++) if (!clip[j]) ids[j] = 0;
            }
            this.objects = { hash: pending.hash, w, h, ids, count, layerId: pending.layer ? pending.layer.id : null };
            this.objectShapeCache.clear();
            this.hoverObjectId = 0; this.hoverObjectCanvas = null;
            this.setStatus(`${count} objects found. Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts, Shift+Alt intersects).`);
            if (this.hover) this.updateObjectHover(this.hover[0], this.hover[1]);
            this.draw();
        }
    }

    objectIdAt(ix, iy) {
        const o = this.objects;
        if (!o || o.w !== this.width || o.h !== this.height) return 0;
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= o.w || y >= o.h) return 0;
        return o.ids[y * o.w + x];
    }

    /** Red shape canvas of one object (cached, selection color so it can be drawn straight into the selection). */
    objectShape(id) {
        const cached = this.objectShapeCache.get(id);
        if (cached) return cached;
        const o = this.objects;
        const c = makeCanvas(o.w, o.h);
        const ctx = c.getContext("2d");
        const out = ctx.createImageData(o.w, o.h);
        const d = out.data;
        for (let j = 0, i = 0; j < o.ids.length; j++, i += 4) {
            if (o.ids[j] === id) { d[i] = 255; d[i + 3] = 255; }
        }
        ctx.putImageData(out, 0, 0);
        if (this.objectShapeCache.size > 12) this.objectShapeCache.delete(this.objectShapeCache.keys().next().value);
        this.objectShapeCache.set(id, c);
        return c;
    }

    updateObjectHover(ix, iy) {
        // stale: an in-app map carries the composite version it was checked at (it uploads nothing, so `baseHash` stays
        // null); a ComfyUI map is stale when the upload cache was cleared
        const o = this.objects;
        const stale = o && o.layerId === null && (o.version != null ? o.version !== this.compositeVersion : this.uploaded.baseHash === null);
        if (!o || stale) {
            // nothing computed yet, or the image changed since: refresh once
            if (!this.objectsPending) this.ensureObjects();
            return;
        }
        const id = this.objectIdAt(ix, iy);
        if (id === this.hoverObjectId) return;
        this.hoverObjectId = id;
        this.hoverObjectCanvas = id ? this.objectShape(id) : null;
    }

    /** Click in the object tool: toggle the object under the cursor in the selection. */
    toggleObjectAt(ix, iy, p = {}) {
        if (!this.objects && !host.objectsInApp()) { this.ensureObjects(); return; }
        const id = this.objects ? this.objectIdAt(ix, iy) : 0;
        if (!id) { if (host.objectsInApp()) { host.selectPoint(this, ix, iy, p); return; } this.setStatus("No object here. Use the brush or lasso for this spot."); return; }
        const x = Math.floor(ix), y = Math.floor(iy);
        const already = this.sel.readRect(x, y, 1, 1).data[3] > 0;
        let mode;
        if (p.shift && p.alt) mode = "intersect";
        else if (p.alt) mode = "subtract";
        else if (p.shift) mode = "add";
        else mode = already ? "subtract" : "add";
        this.pushUndo({ kind: "selection", label: "Object selection" });
        const shape = this.objectShape(id);   // image-sized: the whole rect (null)
        const gco = selectionGco(mode);
        if (mode === "replace") this.sel.clear();
        this.sel.drawInto(null, (sctx) => {
            sctx.globalCompositeOperation = gco.op;
            sctx.drawImage(shape, 0, 0);
        });
        this.markSelectionChanged();
        this.draw();
        const modeStatus = mode === "intersect" ? "Object intersected with the selection." : mode === "subtract" ? "Object removed from the selection." : "Object added to the selection.";
        this.setStatus(modeStatus);
    }

    /** A mask came back from a helper prompt: merge it into the selection. */
    async applyMaskFile(info) {
        const pending = this.segmentPending || { mode: "replace", text: "" };
        this.segmentPending = null;
        this.segBtn.disabled = false;
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            if (!this.sel) return;
            this.pushUndo({ kind: "selection", label: "Select by text" });
            const tmp = makeCanvas(this.width, this.height);
            const tctx = tmp.getContext("2d");
            tctx.drawImage(img, 0, 0, this.width, this.height);
            const src = tctx.getImageData(0, 0, this.width, this.height).data;
            const clip = pending.layer ? this.layerAlpha(pending.layer) : null;
            const shape = makeCanvas(this.width, this.height);
            const sh = shape.getContext("2d");
            const out = sh.createImageData(this.width, this.height);
            const d = out.data;
            let count = 0;
            for (let i = 0, j = 0; i < src.length; i += 4, j++) {
                const on = src[i] > 127 && (!clip || clip[j]);
                d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = on ? 255 : 0;
                if (on) count++;
            }
            sh.putImageData(out, 0, 0);
            const gco = selectionGco(pending.mode || "replace");
            if (pending.mode === "replace") this.sel.clear();
            this.sel.drawInto(null, (sctx) => {
                sctx.globalCompositeOperation = gco.op;
                sctx.drawImage(shape, 0, 0);
            });
            this.markSelectionChanged();
            this.draw();
            const pct = Math.round(100 * count / (this.width * this.height));
            const term = (info.label || pending.text || "").trim();
            if (pending.fromPrompt && term && !this.segInput.value.trim()) this.segInput.value = term;
            if (count) this.selectionLabel = pending.mode === "replace" ? term : [this.selectionLabel, term].filter(Boolean).join(", ");
            this.setStatus(count ? `Selected "${term}" (${pct}% of the image, ${pending.mode}${pending.fromPrompt ? ", derived from the prompt" : ""}).` : `Nothing found for "${term}". Lower the threshold or rephrase.`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not apply the mask: " + (err.message || err), failKind(err));
        }
    }
}
