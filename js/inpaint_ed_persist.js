// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_persist.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// getValue, setValue and serializeForPrompt: moved out of inpaint_canvas.js (item 56 S8, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS, filterDefaults, lutFromImage } from "./inpaint_filters.js";
import { TEXT_DEFAULTS, loadFontList } from "./inpaint_text.js";
import { installLayerAliases } from "./inpaint_pixels.js";
import { uploadCanvas } from "./inpaint_upload.js";
import { labelMap } from "./reftokens.js";
import { promptPayload, selectionBoxIdOf } from "./boxes_model.js";
import { mapFromJSON, mapToJSON } from "./inpaint_maps.js";
import { normalBlend } from "./blend_modes.js";
import { failKind } from "./inpaint_status.js";
import { LAYER_KINDS, LOAD_NOTE_LINES, LOAD_NOTE_MS, REF_DEFAULTS, SYNC_ENCODE_PX, leftOutText } from "./inpaint_consts.js";
import { orientIsUp, validXf } from "./inpaint_orient.js";
import { CROP_DEFAULTS, CROP_LEGACY, GEN_DEFAULTS, randomSeed } from "./inpaint_backends.js";
import { imageOfBlob, loadImageEl, pixelsFromPngStream, pixelsOffThread, viewUrl } from "./inpaint_load.js";

export class PersistPart {
    getValue() {
        if (!this.base) return this.lastValueString || "{}";
        if (this.sel && !this.selectionEncoded) {
            if (this.width * this.height <= SYNC_ENCODE_PX) {
                this.selectionDataUrl = this.sel.toCanvas().toDataURL("image/png");
                this.selectionBox = null;
                this.selectionEncoded = true;
            } else {
                // a 100 MP toDataURL blocks the editor for seconds: encode in the background,
                // keep the last finished PNG until it lands
                this.encodeSelectionSoon();
            }
        }
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: this.base.ref,
            prompt: this.promptText,
            groups: this.groupsCopy(),
            layers: this.layers.map((l) => ({
                id: l.id, name: l.name, kind: l.kind, role: l.role || "none", blend: l.blend || "normal", ref: l.ref,
                x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity, visible: l.visible, mask: l.maskRef || null,
                ...(l.maskOff && l.maskPx ? { maskOff: true } : {}),
                ...(l.match && l.match.strength > 0 ? { match: l.match } : {}),
                ...(l.locked ? { locked: true } : {}),
                ...(l.alphaLock ? { alphaLock: true } : {}),
                ...(l.clip ? { clip: true } : {}),
                ...(l.group ? { group: l.group } : {}),
                ...(l.kind === "filter" ? { filter: l.filter, params: l.params, lut: l.lut || null, plate: l.plate || null } : {}),
                ...(l.kind === "text" && l.text ? { text: l.text } : {}),
                ...(l.relightOf ? { relightOf: l.relightOf } : {}),
            })),
            history: this.history.slice(-100).map((h) => ({ key: h.key, name: h.name, ref: h.ref, x: h.x, y: h.y, w: h.w, h: h.h, prompt: h.prompt, layerId: h.layerId, time: h.time, seed: h.seed, mode: h.mode, denoise: h.denoise,
                ...(h.negative ? { negative: h.negative } : {}), ...(h.refs && typeof h.refs === "object" ? { refs: { ...h.refs } } : {}),
                ...(orientIsUp(h.orient) ? {} : { orient: { ...h.orient } }), ...(validXf(h.xf) ? { xf: h.xf.slice() } : {}) })),
            selection: this.selectionDataUrl,
            // E5: where the selection's PNG goes when it holds a box of the mask and not all of it ([x, y, w, h])
            ...(this.selectionDataUrl && this.selectionBox ? { selectionBox: this.selectionBox } : {}),
            selections: (this.savedSelections || []).map((s) => ({ name: s.name, url: s.url, ...(orientIsUp(s.orient) ? {} : { orient: { ...s.orient } }), ...(validXf(s.xf) ? { xf: s.xf.slice() } : {}) })),
            guides: this.guides && (this.guides.x.length || this.guides.y.length) ? this.guides : undefined,
            seen: Array.from(this.seenResults).slice(-200),
            crop: this.cropSettings,
            upsample: this.upsampleSettings,
            gen: this.genSettings,
            negative: this.negativeText,
            settings: this.settings,
            refs: this.refSettings,
            cutout: this.cutoutSettings,
            // the node keeps its boxes in the workflow (the app saves pluginData beside the state: host.js)
            ...(host.boxesInEditor && this.pluginData && this.pluginData.boxes && Array.isArray(this.pluginData.boxes.boxes) && this.pluginData.boxes.boxes.length ? { boxes: this.pluginData.boxes } : {}),
            depth: this.depth ? {
                w: this.depth.w,
                h: this.depth.h,
                origW: this.depth.origW,
                origH: this.depth.origH,
                rw: this.depth.rw,
                rh: this.depth.rh,
                lo: this.depth.lo,
                hi: this.depth.hi,
                hash: this.depth.hash,
                version: this.depth.version,
                provider: this.depth.provider,
                ms: this.depth.ms,
                totalMs: this.depth.totalMs,
                thumb: this.depth.thumb ? Array.from(this.depth.thumb) : null,
            } : null,
            maps: (this.maps && Object.keys(this.maps).length > 0) ? (() => {
                const out = {};
                for (const [k, m] of Object.entries(this.maps)) {
                    if (!m) continue;
                    const j = mapToJSON(m);
                    if (j) out[k] = j;
                }
                return Object.keys(out).length > 0 ? out : undefined;
            })() : undefined,
        });
    }

    async setValue(value) {
        let state = null;
        try { state = typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch (_) { state = null; }
        if (!state || !state.base) return;
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        if (raw === this.lastValueString && (this.base || this._loading)) return;
        this.lastValueString = raw;
        const token = (this._loadToken = (this._loadToken || 0) + 1);
        const stale = () => this._loadToken !== token;
        this._loading = true;
        try {
            // E5: the files of a document larger than any canvas are PNGs the browser's decoder has nowhere to put; they
            // are fetched and decoded as a stream into tiles. On tiles every other large file (the base the user opened,
            // a full-size layer) is decoded off the window too (`pixelsOffThread`); small ones load as they always did.
            // A file is fetched once: its pixels come from a reader (`{ px }`), or it is handed back (`{ blob }`) for the
            // <img>; on the canvas backend nothing is fetched here.
            const streamed = async (ref, Cls) => {
                if (!this.tileMode) return null;
                const blob = await (await fetch(viewUrl(ref))).blob();
                const px = await pixelsOffThread(blob, Cls);
                return px ? { px } : { blob };
            };
            const imageOf = async (got, ref) => (got && got.blob ? imageOfBlob(got.blob) : loadImageEl(viewUrl(ref)));
            const baseGot = await streamed(state.base, this.pixels.Layer);
            if (stale()) { if (baseGot && baseGot.px) baseGot.px.release(); return; }
            if (baseGot && baseGot.px) await this.setBasePixels(state.base, baseGot.px, { keepLayers: false });
            else {
                const img = await imageOf(baseGot, state.base);
                if (stale()) return;
                await this.setBase(state.base, img, { keepLayers: false });
            }
            this._rangeTint = null;
            this.mapView = null;
            this.maskView = null;
            this._pendingPick = null;
            this._pendingPickTarget = null;
            if (this.depthViewBtn) this.depthViewBtn.classList.remove("ipc-toggle-on");
            this.setPromptText(state.prompt || "", { history: "reset" });
            this.cropSettings = state.crop ? { ...CROP_DEFAULTS, ...state.crop } : { ...CROP_LEGACY };
            this.syncCropControls();
            this.upsampleSettings = { useCase: "auto", backend: "auto", ...(state.upsample || {}) };
            this.refreshSegmentBackends();
            this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed(), ...(state.gen || {}) };
            if (host.boxesInEditor) {
                // the node's boxes come back with the workflow (getValue); a state without them has none
                if (!this.pluginData || typeof this.pluginData !== "object") this.pluginData = {};
                if (state.boxes && typeof state.boxes === "object" && Array.isArray(state.boxes.boxes)) this.pluginData.boxes = JSON.parse(JSON.stringify(state.boxes));
                else delete this.pluginData.boxes;
            }
            this.setNegativeText(state.negative || "");
            this.settings = state.settings && typeof state.settings === "object" ? { ...state.settings } : {};
            this.refSettings = { ...REF_DEFAULTS, ...(state.refs || {}) };
            this.cutoutSettings = { backend: "auto", ...(state.cutout || {}) };
            this.syncRefControls();
            this.syncGenControls();
            this.renderSettings();
            const textToRender = [];
            // groups as folders (PLAN_0_1_31 §6.5): the list, each layer's `group` below; normalizeGroups drops what does not fit
            this.groups = (Array.isArray(state.groups) ? state.groups : []).filter((g) => g && typeof g.id === "string").map((g) => ({
                id: g.id, name: String(g.name || "Group"), visible: g.visible !== false, locked: !!g.locked, collapsed: !!g.collapsed, parent: typeof g.parent === "string" ? g.parent : null }));
            this.activeGroupId = null;
            // a list drawn while a layer loads (an await below) must not drop a group whose layers are not in yet
            this.holdGroups = (this.holdGroups || 0) + 1;
            // what is left out says so (docs/PLAN_0_1_50.md Q4): a layer of a kind a newer version wrote without a file,
            // a filter layer that would not load, and a pixel layer whose file would not (by name: `missing`)
            let newer = 0, failed = 0;
            const missing = [], redrawn = [];
            this.leftOut = null;
            this._loadNote = null;
            // a text layer drawn again from its description (no file, or one that would not load): rendered after the loop
            const textLayer = (l, match = { strength: 0, source: "surroundings" }) => {
                const layer = { id: l.id, name: l.name, kind: "text", role: l.role || "none", blend: normalBlend(l.blend), ref: null, px: this.pixels.Layer.empty(1, 1), x: l.x, y: l.y, w: 1, h: 1, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: true, locked: !!l.locked, alphaLock: !!l.alphaLock, clip: !!l.clip, group: l.group || null, maskPx: null, maskRef: null, maskDirty: false, maskEdit: false, match, text: { ...TEXT_DEFAULTS, ...l.text } };
                this.layers.push(installLayerAliases(layer, this.pixels));
                this.textCounter = (this.textCounter || 0) + 1;
                textToRender.push(layer);
            };
            try {
                for (const l of state.layers || []) {
                    if (l.kind === "filter") {
                        try {
                            const pixels = this.pixels.Layer.empty(this.width, this.height);
                            let maskPx = null;
                            if (l.mask && l.mask.filename) {
                                try { maskPx = this.pixels.Mask.fromImage(await loadImageEl(viewUrl(l.mask)), pixels.width, pixels.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                                if (stale()) return;
                            }
                            let lutData = null;
                            if (l.lut && l.lut.ref) {
                                try { lutData = lutFromImage(await loadImageEl(viewUrl(l.lut.ref)), l.lut.size); } catch (err) { console.warn("Inpaint Canvas: LUT missing", l.lut, err); }
                                if (stale()) return;
                            }
                            let plateImg = null;
                            if (l.plate && l.plate.ref) {
                                try { plateImg = await loadImageEl(viewUrl(l.plate.ref)); } catch (err) { console.warn("Inpaint Canvas: grain plate missing", l.plate, err); }
                                if (stale()) return;
                            }
                            // an id that is not installed here (a plugin switched off, a document from elsewhere) is kept with
                            // its params: applyFilter passes the picture through, and the next save writes it back unchanged
                            const fid = typeof l.filter === "string" && l.filter ? l.filter : "grain";
                            this.layers.push(installLayerAliases({
                                id: l.id, name: l.name, kind: "filter", role: "none", blend: normalBlend(l.blend), ref: null, px: pixels,
                                x: 0, y: 0, w: this.width, h: this.height, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false, locked: !!l.locked, clip: !!l.clip, group: l.group || null,
                                maskPx, maskRef: maskPx ? l.mask : null, maskDirty: false, maskEdit: false, maskOff: !!(maskPx && l.maskOff),
                                filter: fid, params: FILTERS[fid] ? { ...filterDefaults(fid), ...(l.params || {}) } : { ...(l.params || {}) }, lut: l.lut || null, _lutData: lutData,
                                plate: plateImg ? l.plate : null, _plateImg: plateImg,
                            }, this.pixels));
                            this.filterCounter += 1;
                        } catch (err) {
                            console.warn("Inpaint Canvas: filter layer skipped", l, err);
                            failed += 1;
                        }
                        continue;
                    }
                    if (l.kind === "text" && l.text && !l.ref) {
                        // never uploaded (editor closed without sync): render it again from its description
                        textLayer(l);
                        continue;
                    }
                    if (!l.ref) {
                        if (typeof l.kind === "string" && l.kind && !LAYER_KINDS.has(l.kind)) newer += 1;
                        continue;
                    }
                    try {
                        const got = await streamed(l.ref, this.pixels.Layer);
                        if (stale()) { if (got && got.px) got.px.release(); return; }
                        let pixels = got && got.px;
                        if (!pixels) {
                            const limg = await imageOf(got, l.ref);
                            if (stale()) return;
                            pixels = this.pixels.Layer.fromImage(limg);
                        }
                        let maskPx = null;
                        if (l.mask && l.mask.filename) {
                            try { maskPx = this.pixels.Mask.fromImage(await loadImageEl(viewUrl(l.mask)), pixels.width, pixels.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                            if (stale()) return;
                        }
                        this.layers.push(installLayerAliases({
                            id: l.id, name: l.name, kind: l.kind || "result", role: l.role || "none", blend: normalBlend(l.blend),
                            ref: l.ref, px: pixels,
                            x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false, locked: !!l.locked, alphaLock: !!l.alphaLock, clip: !!l.clip, group: l.group || null,
                            maskPx, maskRef: maskPx ? l.mask : null, maskDirty: false, maskEdit: false, maskOff: !!(maskPx && l.maskOff),
                            match: l.match && typeof l.match === "object" ? { strength: +l.match.strength || 0, source: l.match.source === "underneath" ? "underneath" : "surroundings" } : { strength: 0, source: "surroundings" },
                            relightOf: l.relightOf || null,
                            ...(l.kind === "text" && l.text ? { text: { ...TEXT_DEFAULTS, ...l.text } } : {}),
                        }, this.pixels));
                        if (l.kind === "paint") this.paintCounter += 1;
                        if (l.kind === "text") this.textCounter = (this.textCounter || 0) + 1;
                    } catch (err) {
                        console.warn("Inpaint Canvas: layer missing", l.ref, err);
                        const name = String(l.name || l.id || "layer");
                        if (l.kind === "text" && l.text && typeof l.text === "object") {
                            // a text layer is drawn again from its description, as one never stored is (its mask, if it had
                            // one, is not: the mask's size is the rendered pixels')
                            const match = l.match && typeof l.match === "object" ? { strength: +l.match.strength || 0, source: l.match.source === "underneath" ? "underneath" : "surroundings" } : undefined;
                            textLayer(l, match);
                            redrawn.push(name + (l.mask && l.mask.filename ? " (without its mask)" : ""));
                        } else missing.push(name);
                    }
                }
            } finally { this.holdGroups--; }
            if (newer || failed || missing.length || redrawn.length) {
                this.leftOut = { newer, failed, missing: missing.length, names: missing, redrawn: redrawn.length, redrawnNames: redrawn, note: leftOutText(newer, failed, missing, redrawn) };
                this.setStatus(this.leftOut.note, "warn");
                this._loadNote = { note: this.leftOut.note, lines: LOAD_NOTE_LINES, until: Date.now() + LOAD_NOTE_MS };
            }
            this.normalizeGroups();   // a layer that failed to load may leave a group empty
            if (textToRender.length) {
                await loadFontList();
                if (stale()) return;
                for (const layer of textToRender) await this.renderTextLayer(layer, { keepScale: false });
                if (stale()) return;
            }
            // the labels the prompt was saved with, then remapped to the labels of what loaded: the same when every
            // layer came back, and a reference that failed to load gets its tokens parked instead of shifting the others
            if (host.refTokens) {
                this.refMap = labelMap((state.layers || []).filter((l) => l && l.role === "reference" && l.visible !== false).reverse());
                this.refsMutated({ restore: true });
            }
            this.history = (state.history || []).map((h) => ({ ...h }));
            this.savedSelections = Array.isArray(state.selections) ? state.selections.filter((s) => s && s.url).map((s) => ({ name: s.name || "Selection", url: s.url,
                ...(orientIsUp(s.orient) ? {} : { orient: { turn: ((s.orient.turn | 0) & 3), flip: !!s.orient.flip } }), ...(validXf(s.xf) ? { xf: s.xf.map(Number) } : {}) })) : [];
            this.guides = state.guides && Array.isArray(state.guides.x) && Array.isArray(state.guides.y) ? { x: state.guides.x.map(Number), y: state.guides.y.map(Number) } : { x: [], y: [] };
            this.renderSelectionList();
            for (const key of state.seen || []) this.seenResults.add(key);
            if (state.selection) {
                const sb = Array.isArray(state.selectionBox) && state.selectionBox.length === 4 ? state.selectionBox.map((v) => Math.round(+v) || 0) : null;
                if (!sb && this.huge) {
                    // E5: the whole mask of a document larger than any canvas, decoded as a stream into mask tiles
                    const blob = await (await fetch(state.selection)).blob();
                    const px = await pixelsFromPngStream(blob, this.pixels.Mask);
                    if (stale()) { px.release(); return; }
                    if (px.width === this.width && px.height === this.height) { this.sel.release(); this.sel = px; }
                } else {
                    const sel = await loadImageEl(state.selection);
                    if (stale()) return;
                    // over what setBase left (source-over, as always: a same-size restore keeps the old selection too);
                    // a PNG of a box of the mask (E5, `selectionBox`) into that box
                    if (sb) this.sel.drawInto([sb[0], sb[1], sb[0] + sb[2], sb[1] + sb[3]], (ctx) => ctx.drawImage(sel, sb[0], sb[1]));
                    else this.sel.drawInto(null, (ctx) => ctx.drawImage(sel, 0, 0));
                }
                // touched after the write: setBase's info line and first frame built the display
                // levels of the empty selection under the same version, and above 1 MP the bounds
                // came from those, so a restored selection counted as none
                this.touchSource(this.sel);
                this.selectionDirty = true; this.selectionLoose = false;
                // and encoded again: a getValue while the layers loaded (the app's autosave, ComfyUI
                // serializing the graph) stored the empty selection's PNG as up to date, and every
                // later save wrote that until the selection was changed by hand
                this.selectionSeq++;
                this.selectionEncoded = false;
                this.selectionDataUrl = null;
            }
            if (state.depth) {
                let thumb = null;
                if (Array.isArray(state.depth.thumb)) {
                    thumb = new Uint8Array(state.depth.thumb);
                } else if (typeof state.depth.thumb === "string") {
                    const bin = atob(state.depth.thumb);
                    thumb = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) thumb[i] = bin.charCodeAt(i);
                }
                this.depth = {
                    ...state.depth,
                    thumb,
                    u16: null,
                    raw: null,
                    stale: true,
                };
            } else {
                this.depth = null;
            }
            this.maps = {};
            if (state.maps && typeof state.maps === "object") {
                for (const [kind, j] of Object.entries(state.maps)) {
                    if (!j || !j.ref) continue;
                    try {
                        const map = await mapFromJSON(kind, j, async (ref) => loadImageEl(viewUrl(ref)));
                        if (stale()) return;
                        if (map) {
                            this.maps[kind] = map;
                            if (kind === "depth" && j.guide && !map.guide) {
                                this.setStatus("the depth map's guide is missing; Recompute restores the edges", "warn");
                            }
                        } else {
                            this.setStatus(`Map "${kind}" could not be loaded.`, "warn");
                        }
                    } catch (err) {
                        console.warn(`Inpaint Canvas: map "${kind}" missing`, j.ref, err);
                        this.setStatus(`Map "${kind}" missing: ${err.message || err}`, failKind(err));
                    }
                }
            }
            this.mapsVersion++;
            this.renderLayers();
            this.renderHistory();
            this.renderInfo();
            this.renderDepthRow();
            if (this.boxes) this.boxes.refresh(true);
            this.draw();
            this.drawThumb();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not restore canvas: " + (err.message || err), failKind(err));
        } finally {
            if (!stale()) this._loading = false;
        }
    }

    /**
     * Called when the prompt is built: upload flattened image, mask and control, return the prompt JSON. `opts` (the
     * app): `refIds` the click's references (refLayersFor), `prompt` / `negative` the texts to send instead of the fields';
     * `boxes` ({ boxes, notes }, promptPayload's shape; `boxes` null: none, the selection goes as one) the boxes a run
     * sends while the Boxes switch is on, measured by the caller, instead of the document's (Generate new measures them
     * on the picture they were drawn on, before its fresh canvas replaces it). `area` (the app's Each area): one area of
     * the selection, `{ maskCanvas(), crop }`, whose mask goes instead of the selection's (never through the upload cache,
     * which stays the selection's) and whose crop the status line names.
     */
    async serializeForPrompt(opts = {}) {
        if (!this.base) return "{}";
        const id = this.node.id;
        const area = opts.area || null;
        await this.syncLayers();
        let baseRef = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !baseRef) {
            let hash;
            if (!this.layers.some((l) => this.shown(l) && !this.isControl(l)) && this.base.ref) {
                baseRef = this.base.ref;
                hash = "orig:" + this.base.ref.filename;
            } else {
                const up = await this.uploadComposite({ forRun: true }, `n${id}_base`);
                baseRef = up.ref; hash = up.hash;
            }
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = baseRef;
        }
        // the selection the mask below holds, read in the same tick (the app numbers the batch's pictures from it; the
        // node ignores the key)
        const hasSelection = area ? true : !!this.getBounds();
        let maskRef = this.uploaded.maskRef;
        if (area) {
            const c = area.maskCanvas();
            try { maskRef = (await uploadCanvas(c, `n${id}_mask`)).ref; } finally { c.width = 1; c.height = 1; }
        } else if (!this.uploaded.maskHash || !maskRef) {
            const up = await uploadCanvas(this.maskToCanvas(), `n${id}_mask`);
            maskRef = up.ref;
            this.uploaded.maskHash = up.hash;
            this.uploaded.maskRef = maskRef;
        }
        let controlRef = null;
        if (this.layers.some((l) => this.shown(l) && this.isControl(l))) {
            if (!this.uploaded.controlHash || !this.uploaded.controlRef) {
                const up = await uploadCanvas(this.flattenToCanvas({ controlOnly: true }), `n${id}_control`);
                this.uploaded.controlHash = up.hash;
                this.uploaded.controlRef = up.ref;
            }
            controlRef = this.uploaded.controlRef;
        }
        // Reference layers at their native size: the uploaded file itself when it is
        // untouched, otherwise the pixels with the mask applied (cached per layer).
        const references = [];
        const refLayers = this.refLayersFor(opts.refIds);
        for (const l of refLayers) {
            if (!l.maskPx && l.ref && !l.dirty) { references.push(l.ref); continue; }
            if (!l.exportRef) {
                const up = await uploadCanvas(this.layerPixels(l), `n${id}_ref`);
                l.exportRef = up.ref;
            }
            references.push(l.exportRef);
        }
        // the Boxes switch on and a run that takes boxes (docs/PLAN_NODE_BOXES.md §4): the document's boxes, the
        // references' layer ids and the id of the selection's box, for the node's nodes.py to write FLUX 3's rows (an older
        // node ignores them). In the app a local recipe takes them only when it declares the input its rows go to (its
        // `boxes`): the app's host wires that input to the node's box_prompt for the run.
        const promptSent = opts.prompt != null ? opts.prompt : this.promptText;
        let boxPart = {}, boxNote = "";
        const boxSwitch = this.genSettings.boxes ? host.boxSwitch(this) : null;
        if (boxSwitch && boxSwitch.takes) {
            const given = opts.boxes && typeof opts.boxes === "object" ? opts.boxes : null;
            const list = given ? (given.boxes || []) : this.pluginData && this.pluginData.boxes && Array.isArray(this.pluginData.boxes.boxes) ? this.pluginData.boxes.boxes : [];
            const p = given ? { boxes: list, notes: Array.isArray(given.notes) ? given.notes : [] } : promptPayload(list, refLayers);
            // each reference's @img label (img1 ..), so nodes.py can name a token in a description or the prompt as the
            // picture the batch holds ("image 3")
            const labels = this.refLabels();
            boxPart = { selectionBoxId: selectionBoxIdOf(promptSent), referenceIds: refLayers.map((l) => l.id), referenceLabels: refLayers.map((l) => (labels.has(l.id) ? `img${labels.get(l.id)}` : null)), ...((given ? Array.isArray(given.boxes) : list.length) ? { boxes: p.boxes } : {}) };
            boxNote = p.notes.join(" ");
        }
        const [x, y, w, h] = area && Array.isArray(area.crop) ? area.crop : this.cropRect();
        this.setStatus(`Queued crop ${w} × ${h} at ${x}, ${y}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}. Waiting for the result ...${boxNote ? " " + boxNote : ""}`, boxNote ? "warn" : undefined);
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            hasSelection,
            control: controlRef,
            prompt: opts.prompt != null ? opts.prompt : this.promptText,
            layers: this.layers.length,
            crop: this.cropSettings,
            gen: this.genSettings,
            negative: opts.negative != null ? opts.negative : this.negativeText,
            settings: this.settings,
            references,
            refs: this.refSettings,
            ...boxPart,
        });
    }
}
