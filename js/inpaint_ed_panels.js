// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_panels.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the filter, limit and relight blocks of the layer panel: moved out of inpaint_canvas.js (item 56 S3, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS, FILTER_IDS, hexRgb } from "./inpaint_filters.js";
import { normalizeLimit, normalizeStoredLimit } from "./inpaint_weights.js";
import { buildRangeBar } from "./inpaint_rangebar.js";
import { KELVIN_PRESETS, LIGHT_MAX, LIGHT_PRESETS, SPOT_GOBOS, applyLightPreset, defaultLight, lightColorHex, loraPercent } from "./inpaint_relight.js";
import { RELIGHT_LIGHT_TYPES, RELIGHT_STYLES, hostText } from "./inpaint_consts.js";
import { el, iconButton, miniButton } from "./inpaint_dom.js";

export class PanelsPart {
    /** Type select, one slider per parameter, LUT loader: the controls of a filter layer row. */
    buildFilterControls(layer) {
        const box = el("div", "ipc-fx");
        const stop = (e) => e.stopPropagation();
        const typeSel = document.createElement("select");
        typeSel.className = "ipc-sel";
        // a fill layer picks among the fills, a filter layer among the filters
        const fill = !!(FILTERS[layer.filter] && FILTERS[layer.filter].over);
        typeSel.title = fill ? "Fill type" : "Filter type";
        for (const id of FILTER_IDS) {
            if (!!FILTERS[id].over !== fill) continue;
            const fdef = FILTERS[id];
            if (id !== layer.filter && !host.depthSupported) {
                const needsDepth = (typeof fdef.maps === "function" && fdef.maps({}).includes("depth")) || (Array.isArray(fdef.maps) && fdef.maps.includes("depth"));
                if (needsDepth) continue;
            }
            const o = document.createElement("option"); o.value = id; o.textContent = fdef.label; typeSel.appendChild(o);
        }
        // a filter whose plugin is off or missing keeps its id and settings and passes the picture through; picking a
        // type replaces it
        const missing = !FILTERS[layer.filter];
        if (missing) { const o = document.createElement("option"); o.value = ""; o.textContent = `missing: ${layer.filter}`; o.disabled = true; typeSel.insertBefore(o, typeSel.firstChild); }
        typeSel.value = missing ? "" : layer.filter;
        typeSel.addEventListener("click", stop);
        typeSel.addEventListener("keydown", stop);
        typeSel.addEventListener("change", () => this.setFilterType(layer, typeSel.value));
        box.appendChild(typeSel);
        if (missing) {
            box.appendChild(el("div", "ipc-hint", `The filter "${layer.filter}" is not installed (its plugin is off or missing). The layer passes the picture through and keeps its settings.`));
            return box;
        }
        if (layer.filter !== "relight" && this.mapsOf(layer).includes("depth") && !(this.maps && this.maps.depth)) {
            box.appendChild(el("div", "ipc-hint", "Needs a depth map: compute it under Selection \u203A Depth"));
        }
        const def = FILTERS[layer.filter];
        const stepLabel = (p) => (p.label ? `${def.label}: ${p.label}` : def.label);   // the Undo history's name of a control's step
        if (def.needsLut) {
            const lr = el("div", "ipc-lutrow");
            const input = document.createElement("input");
            input.type = "file"; input.accept = ".cube,.CUBE"; input.style.display = "none";
            input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; if (f) this.loadLutFile(layer, f); });
            input.addEventListener("click", stop);
            lr.appendChild(input);
            const load = iconButton("load", "Load a 3D LUT (.cube). It is stored with the workflow.", () => input.click(), ".cube");
            load.classList.add("ipc-small");
            lr.appendChild(load);
            lr.appendChild(el("span", null, layer.lut ? `${layer.lut.name} (${layer.lut.size}³)` : "no LUT loaded"));
            box.appendChild(lr);
        }
        if (def.plate) {
            // real grain plate (scan of a uniformly exposed film, e.g. fotokorn's): replaces the synthetic noise
            const pr = el("div", "ipc-lutrow");
            const input = document.createElement("input");
            input.type = "file"; input.accept = "image/*"; input.style.display = "none";
            input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; if (f) this.loadPlateFile(layer, f); });
            input.addEventListener("click", stop);
            pr.appendChild(input);
            const load = iconButton("image", "Load a real grain plate (a scan of uniformly exposed film, JPG/PNG). It replaces the synthetic grain; Grain sets its strength, Plate its scale (1 = plate pixels 1:1).", () => input.click(), "Plate");
            load.classList.add("ipc-small");
            pr.appendChild(load);
            pr.appendChild(el("span", null, layer.plate ? `${layer.plate.name} (${layer.plate.w} × ${layer.plate.h})` : "synthetic grain"));
            if (layer.plate) {
                const rm = miniButton("trash", "Remove the plate (back to synthetic grain)", () => this.removePlate(layer), "ipc-del");
                pr.appendChild(rm);
            }
            box.appendChild(pr);
        }
        const fmt = (p, v) => (p.type === "bool" ? (v ? "on" : "off") : (Number.isInteger(p.step) ? Math.round(v) : (+v).toFixed(p.step < 0.1 ? 2 : 1)) + (p.unit || ""));
        let presetSel = null;
        for (const p of def.params) {
            if (p.hidden) continue;
            if (p.onlyWithPlate && !layer.plate) continue;
            if (p.notWithPlate && layer.plate) continue;
            if (p.when) {
                let match = true;
                for (const [wk, wv] of Object.entries(p.when)) {
                    const actual = (layer.params && layer.params[wk] !== undefined) ? layer.params[wk] : def.params.find((dp) => dp.key === wk)?.default;
                    if (actual !== wv) { match = false; break; }
                }
                if (!match) continue;
            }
            if (p.type === "custom") {
                // a control the filter module builds itself (e.g. the curves editor), full row; it reports edits through the callbacks
                if (typeof def.control !== "function") continue;
                const node = def.control(layer, p, {
                    begin: () => { if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id }); },
                    preview: () => { this.filterPreview = layer.id; this.markFilterChanged(layer, { soon: true }); },
                    commit: (opts) => { this.filterPreview = null; if (layer._undoPending) { this.pushUndoSnapshot(layer._undoPending, { label: (opts && opts.label) || stepLabel(p) }); layer._undoPending = null; } this.markFilterChanged(layer); },
                    stop,
                    histogram: () => { const h = this.belowHistogram(layer); return h ? h.luma : null; },   // the curves' backdrop (P8)
                });
                if (node) { node.style.gridColumn = "1 / -1"; box.appendChild(node); }
                continue;
            }
            const lab = el("span", null, p.label);
            box.appendChild(lab);
            const cur = layer.params[p.key] ?? p.default;
            if (p.type === "select") {
                // a preset fills the other parameters; touching a slider turns it back to "custom"
                const sel = document.createElement("select");
                sel.className = "ipc-sel";
                sel.style.gridColumn = "2 / 3";
                sel.setAttribute("data-param", p.key);
                sel.title = p.title || (p.key !== "preset" ? p.label : hostText("filmPresetTip", "Film stock: sets amount, grain size and colour share (grain character only, the colour look is a LUT's job). Values assume a picture of about 2000 px. Film names are trademarks of their owners; the looks are Scumble's own approximations, not licensed products."));
                let group = null;
                for (const o of p.options) {
                    if (o.needs === "depth" && !host.depthSupported && cur !== o.id) continue;
                    const opt = document.createElement("option"); opt.value = o.id; opt.textContent = o.label;
                    if (o.group) {
                        if (!group || group.label !== o.group) { group = document.createElement("optgroup"); group.label = o.group; sel.appendChild(group); }
                        group.appendChild(opt);
                    } else sel.appendChild(opt);
                }
                sel.value = p.options.some((o) => o.id === cur) ? cur : p.options[0].id;
                sel.addEventListener("click", stop);
                sel.addEventListener("keydown", stop);
                sel.addEventListener("change", () => {
                    this.commitChoice(layer, p, sel.value);
                });
                if (p.key === "preset") presetSel = sel;
                box.appendChild(sel);

                const listBtn = miniButton("list", "Preview the entries on the picture", () => {
                    this.openChoiceList(layer, p, listBtn);
                });
                listBtn.style.gridColumn = "3 / 4";
                listBtn.setAttribute("data-param", p.key);
                box.appendChild(listBtn);
                continue;
            }
            const val = el("b", null, fmt(p, cur));
            if (p.type === "bool") {
                const cb = document.createElement("input");
                cb.type = "checkbox"; cb.checked = !!cur;
                cb.addEventListener("click", stop);
                cb.addEventListener("change", () => {
                    this.pushUndo({ kind: "filter", id: layer.id, label: stepLabel(p) });
                    layer.params[p.key] = cb.checked;
                    val.textContent = fmt(p, cb.checked);
                    this.markFilterChanged(layer);
                });
                box.appendChild(cb);
                box.appendChild(val);
                continue;
            }
            if (p.type === "color") {
                // a fill's colour: the picture follows the picker while it is open, one undo step when it closes
                const [r, g, b] = hexRgb(cur);
                const hex = (v) => "#" + v.map((c) => c.toString(16).padStart(2, "0")).join("");
                const ci = document.createElement("input");
                ci.type = "color"; ci.className = "ipc-fxcolor"; ci.value = hex([r, g, b]); ci.title = p.label;
                val.textContent = ci.value;
                val.className = "ipc-hex";
                ci.addEventListener("click", stop);
                ci.addEventListener("pointerdown", stop);
                ci.addEventListener("keydown", stop);
                ci.addEventListener("input", () => {
                    if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                    layer.params[p.key] = ci.value;
                    val.textContent = ci.value;
                    this.filterPreview = layer.id;
                    this.markFilterChanged(layer, { soon: true });
                });
                ci.addEventListener("change", () => {
                    this.filterPreview = null;
                    if (layer._undoPending) { this.pushUndoSnapshot(layer._undoPending, { label: stepLabel(p) }); layer._undoPending = null; }
                    else if (layer.params[p.key] !== ci.value) this.pushUndo({ kind: "filter", id: layer.id, label: stepLabel(p) });
                    layer.params[p.key] = ci.value;
                    val.textContent = ci.value;
                    this.markFilterChanged(layer);
                });
                box.appendChild(ci);
                box.appendChild(val);
                continue;
            }
            const range = document.createElement("input");
            range.type = "range"; range.min = p.min; range.max = p.max; range.step = p.step; range.value = cur;
            range.title = p.label;
            range.addEventListener("click", stop);
            range.addEventListener("pointerdown", stop);
            range.addEventListener("keydown", stop);
            range.addEventListener("input", () => {
                if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                layer.params[p.key] = +range.value;
                val.textContent = fmt(p, +range.value);
                if (presetSel && !p.keepPreset && layer.params.preset !== "custom") { layer.params.preset = "custom"; presetSel.value = "custom"; }
                this.filterPreview = layer.id;
                this.markFilterChanged(layer, { soon: true });
            });
            range.addEventListener("change", () => {
                this.filterPreview = null;
                if (layer._undoPending) { this.pushUndoSnapshot(layer._undoPending, { label: stepLabel(p) }); layer._undoPending = null; }
                layer.params[p.key] = +range.value;
                this.markFilterChanged(layer);
            });
            box.appendChild(range);
            box.appendChild(val);
        }
        if (layer.filter === "relight") {
            const relightBlock = this.buildRelightBlock(layer);
            if (relightBlock) box.appendChild(relightBlock);
        }
        const limitBlock = this.buildLimitBlock(layer);
        if (limitBlock) {
            box.appendChild(limitBlock);
            box.limitBlock = limitBlock;
            if (limitBlock.rangeBar) box.rangeBar = limitBlock.rangeBar;
        }
        return box;
    }

    /**
     * Builds the Limit block for a filter or fill layer (R1-S8):
     * source select (Off, Depth, Luminosity, Colour; fill layers Off and Depth only),
     * range bar with below-layer histogram, eyedropper, live preview, and inline depth compute button.
     * @param {Object} layer
     * @returns {HTMLElement}
     */
    buildLimitBlock(layer) {
        const block = el("div", "ipc-limit-block");
        block.style.gridColumn = "1 / -1";
        const stop = (e) => e.stopPropagation();

        const head = el("div", "ipc-limit-head");
        const lab = el("span", "ipc-limit-label", "Limit");
        head.appendChild(lab);

        const sel = document.createElement("select");
        sel.className = "ipc-sel ipc-limit-sel";
        sel.title = "Limit filter effect by picture range";

        const isFill = this.isFillLayer(layer);
        const options = [
            { id: "off", label: "Off" },
            ...(host.depthSupported !== false ? [{ id: "depth", label: "Depth" }] : []),
            ...(!isFill ? [
                { id: "luma", label: "Luminosity" },
                { id: "color", label: "Colour" },
            ] : []),
        ];

        for (const opt of options) {
            const o = document.createElement("option");
            o.value = opt.id;
            o.textContent = opt.label;
            sel.appendChild(o);
        }

        const curLimit = (layer.params && layer.params.limit) || null;
        let curSource = (curLimit && curLimit.source) || "off";
        if (!options.some((o) => o.id === curSource)) curSource = "off";
        sel.value = curSource;

        sel.addEventListener("click", stop);
        sel.addEventListener("keydown", stop);
        head.appendChild(sel);
        block.appendChild(head);

        const content = el("div", "ipc-limit-content");
        content.style.display = "flex";
        content.style.flexDirection = "column";
        content.style.gap = "4px";
        block.appendChild(content);

        const mount = (source) => {
            content.innerHTML = "";
            block.rangeBar = null;
            layer._rangeBar = null;
            if (source === "off") return;

            // Depth map check
            if (source === "depth") {
                const hasDepth = !!((this.maps && this.maps.depth) || this.depth);
                const limitMissing = !hasDepth || !!layer.limitMissing;
                if (limitMissing || !hasDepth) {
                    const noteRow = el("div", "ipc-limit-note");
                    noteRow.appendChild(el("span", null, "needs a depth map: compute it first"));
                    const compBtn = iconButton("magic", "Compute 16-bit depth map with Depth Anything V2 Small", async () => {
                        try {
                            await this.ensureDepthMap();
                            this.renderLayers();
                        } catch (err) {
                            console.error("Depth estimation failed:", err);
                        }
                    }, "Compute depth map");
                    compBtn.classList.add("ipc-small", "ipc-primary");
                    noteRow.appendChild(compBtn);
                    content.appendChild(noteRow);
                }
            }

            let colorInput = null;
            let tolInput = null;

            // Colour source controls: swatch and tolerance
            if (source === "color") {
                const colorRow = el("div", "ipc-limit-color-row");
                const colorLab = el("label", null, "Colour");
                colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.className = "ipc-fxcolor";
                colorInput.value = (layer.params.limit && layer.params.limit.color) || "#ffffff";
                colorInput.title = "Reference colour";
                colorInput.addEventListener("click", stop);
                colorInput.addEventListener("pointerdown", stop);
                colorInput.addEventListener("keydown", stop);
                colorInput.addEventListener("input", () => {
                    if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                    layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...(layer.params.limit || {}), color: colorInput.value }) };
                    this.filterPreview = layer.id;
                    this.markFilterChanged(layer, { soon: true });
                    if (block.rangeBar) block.rangeBar.refresh();
                });
                colorInput.addEventListener("change", () => {
                    this.filterPreview = null;
                    if (layer._undoPending) {
                        this.pushUndoSnapshot(layer._undoPending, { label: "Filter limit" });
                        layer._undoPending = null;
                    }
                    layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...(layer.params.limit || {}), color: colorInput.value }) };
                    this.markFilterChanged(layer);
                    if (block.rangeBar) block.rangeBar.refresh();
                });
                colorLab.appendChild(colorInput);
                colorRow.appendChild(colorLab);

                const tolLab = el("label", null, "Tolerance");
                tolInput = document.createElement("input");
                tolInput.type = "number";
                tolInput.min = "0";
                tolInput.max = "100";
                tolInput.step = "1";
                tolInput.value = (layer.params.limit && layer.params.limit.tol != null) ? layer.params.limit.tol : 30;
                tolInput.className = "ipc-num";
                tolInput.style.width = "48px";
                tolInput.title = "Colour tolerance (0..100)";
                tolInput.addEventListener("click", stop);
                tolInput.addEventListener("pointerdown", stop);
                tolInput.addEventListener("keydown", stop);
                tolInput.addEventListener("input", () => {
                    if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                    const tolVal = Math.max(0, Math.min(100, parseFloat(tolInput.value) || 0));
                    layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...(layer.params.limit || {}), tol: tolVal }) };
                    this.filterPreview = layer.id;
                    this.markFilterChanged(layer, { soon: true });
                    if (block.rangeBar) block.rangeBar.refresh();
                });
                tolInput.addEventListener("change", () => {
                    this.filterPreview = null;
                    if (layer._undoPending) {
                        this.pushUndoSnapshot(layer._undoPending, { label: "Filter limit" });
                        layer._undoPending = null;
                    }
                    const tolVal = Math.max(0, Math.min(100, parseFloat(tolInput.value) || 0));
                    layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...(layer.params.limit || {}), tol: tolVal }) };
                    this.markFilterChanged(layer);
                    if (block.rangeBar) block.rangeBar.refresh();
                });
                tolLab.appendChild(tolInput);
                colorRow.appendChild(tolLab);
                content.appendChild(colorRow);
            }

            // Range bar
            const barWrap = el("div", "ipc-limit-bar-wrap");
            const curLim = (layer.params && layer.params.limit && layer.params.limit.source === source)
                ? layer.params.limit
                : normalizeLimit({
                    source,
                    lo: 0.0,
                    hi: source === "depth" ? 0.5 : 0.7,
                    fLo: 0.05,
                    fHi: 0.05,
                    invert: false,
                    color: "#ffffff",
                    tol: 30,
                });

            const bar = buildRangeBar(curLim, {
                gradient: source,
                histogram: () => {
                    if (source === "depth") return this.mapHistogram("depth");
                    if (source === "luma") {
                        const h = this.belowHistogram(layer);
                        return h ? h.luma : null;
                    }
                    if (source === "color") {
                        return this.similarityHistogram(layer.params.limit || curLim, this.belowSample(layer));
                    }
                    return null;
                },
                begin: () => {
                    if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                },
                preview: (r) => {
                    const cur = layer.params.limit || curLim;
                    layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...cur, ...r }) };
                    this.filterPreview = layer.id;
                    this.markFilterChanged(layer, { soon: true });
                },
                commit: (r) => {
                    this.filterPreview = null;
                    if (!layer._undoPending) {
                        layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                    }
                    const cur = layer.params.limit || curLim;
                    if (r) {
                        layer.params = { ...layer.params, limit: normalizeStoredLimit({ ...cur, ...r }) };
                    }
                    if (layer._undoPending) {
                        this.pushUndoSnapshot(layer._undoPending, { label: "Filter limit" });
                        layer._undoPending = null;
                    }
                    this.markFilterChanged(layer);
                },
                stop: () => {
                    this.filterPreview = null;
                    this.markFilterChanged(layer);
                },
                pick: () => this.pickOnce(source, (val) => {
                    if (source === "color" && typeof val === "string") {
                        if (colorInput) colorInput.value = val;
                        if (block.rangeBar) block.rangeBar.refresh();
                    }
                }),
            });

            block.rangeBar = bar;
            layer._rangeBar = bar;
            barWrap.appendChild(bar.el);
            content.appendChild(barWrap);
        };

        mount(curSource);

        sel.addEventListener("change", () => {
            const val = sel.value;
            if (val === "off") {
                if (layer.params && layer.params.limit) {
                    this.pushUndoSnapshot(this.snapshot({ kind: "filter", id: layer.id }), { label: "Filter limit" });
                    const next = { ...layer.params };
                    delete next.limit;
                    layer.params = next;
                    this.filterPreview = null;
                    this.markFilterChanged(layer);
                    this.renderLayers();
                } else {
                    mount("off");
                }
            } else {
                const cur = layer.params.limit || {};
                const nextLimit = normalizeStoredLimit({
                    source: val,
                    lo: cur.lo ?? 0.0,
                    hi: cur.hi ?? (val === "depth" ? 0.5 : 0.7),
                    fLo: cur.fLo ?? 0.05,
                    fHi: cur.fHi ?? 0.05,
                    invert: !!cur.invert,
                    color: cur.color || "#ffffff",
                    tol: cur.tol ?? 30,
                });
                this.pushUndoSnapshot(this.snapshot({ kind: "filter", id: layer.id }), { label: "Filter limit" });
                layer.params = { ...layer.params, limit: nextLimit };
                this.filterPreview = null;
                this.markFilterChanged(layer);
                this.renderLayers();
            }
        });

        return block;
    }

    /**
     * Builds the light controls block for a relight filter layer (L1b):
     * the light list, type selector, eye toggle, reset, trash, add light button,
     * selected light sliders (Intensity, Diffusion, Close/Far, Range, plus Cone/Edge for spot),
     * colour temperature / custom colour with eyedropper pickOnce, and missing depth hint.
     * @param {Object} layer
     * @returns {HTMLElement}
     */
    buildRelightBlock(layer) {
        const block = el("div", "ipc-relight-block");
        block.style.gridColumn = "1 / -1";
        const stop = (e) => e.stopPropagation();

        layer.params = layer.params || {};
        if (!Array.isArray(layer.params.lights)) {
            layer.params.lights = [];
        }
        const lights = layer.params.lights;
        if (lights.length > 0) {
            if (!layer._deselected && (!layer._selectedLightId || !lights.some((l) => l && l.id === layer._selectedLightId))) {
                layer._selectedLightId = lights[0].id;
            }
        } else {
            layer._selectedLightId = null;
            layer._deselected = false;
        }

        // 1. Missing depth map hint (if applicable)
        const hasDepth = !!((this.maps && this.maps.depth) || this.depth);
        if (!hasDepth) {
            const noteRow = el("div", "ipc-hint ipc-relight-note");
            noteRow.appendChild(el("span", null, "Needs a depth map: compute it first"));
            if (host.depthSupported !== false) {
                const compBtn = iconButton("magic", "Compute 16-bit depth map with Depth Anything V2 Small", async () => {
                    try {
                        await this.ensureDepthMap();
                        this.renderLayers();
                    } catch (err) {
                        console.error("Depth estimation failed:", err);
                    }
                }, "Compute depth map");
                compBtn.classList.add("ipc-small", "ipc-primary");
                noteRow.appendChild(compBtn);
            }
            block.appendChild(noteRow);
        }

        // 2. Header: title and "Add light" button
        const head = el("div", "ipc-relight-head");
        const title = el("span", "ipc-relight-title", "Lights");
        head.appendChild(title);

        const editBtn = iconButton("lights", "Edit lights on canvas (L)", () => {
            this.setTool("lights");
        }, "Edit lights");
        editBtn.classList.add("ipc-small", "ipc-edit-lights");
        head.appendChild(editBtn);

        const toggleHandlesBtn = miniButton(this.hideLightHandles ? "eyeOff" : "eye", this.hideLightHandles ? "Show light handles on canvas (H)" : "Hide light handles on canvas (H)", (e) => {
            stop(e);
            this.hideLightHandles = !this.hideLightHandles;
            this.draw();
            this.renderLayers();
            this.setStatus(this.hideLightHandles ? "Light handles hidden (press H to show)." : "Light handles visible (press H to hide).");
        }, "ipc-relight-toggle-handles");
        if (this.hideLightHandles) toggleHandlesBtn.classList.add("ipc-on");
        head.appendChild(toggleHandlesBtn);

        const presetSel = document.createElement("select");
        presetSel.className = "ipc-sel ipc-relight-preset-sel";
        presetSel.title = "Apply lighting preset";
        const defOpt = document.createElement("option");
        defOpt.value = "";
        defOpt.textContent = "Preset...";
        presetSel.appendChild(defOpt);
        for (const p of LIGHT_PRESETS) {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.label;
            opt.title = p.description;
            presetSel.appendChild(opt);
        }
        presetSel.addEventListener("click", stop);
        presetSel.addEventListener("keydown", stop);
        presetSel.addEventListener("change", () => {
            const pid = presetSel.value;
            if (!pid) return;
            const pObj = LIGHT_PRESETS.find((x) => x.id === pid);
            const pLabel = pObj ? pObj.label : pid;
            this.pushUndo({ kind: "filter", id: layer.id, label: `Light preset: ${pLabel}` });
            // the picture's own size, as the relight command and the toolbar place lights (review F28: the editor has no
            // `doc`, which put every preset into the top-left 1024 px square)
            const w = this.width || 1024;
            const h = this.height || 1024;
            const newLights = applyLightPreset(pid, { width: w, height: h });
            if (newLights && newLights.length > 0) {
                layer.params.lights = newLights;
                layer._deselected = false;
                layer._selectedLightId = newLights[0].id;
                this.ensureRelightMaps(layer, { quick: false });
                this.markFilterChanged(layer);
                this.renderLayers();
                this.draw();
                this.setStatus(`Applied preset "${pLabel}".`);
            }
            presetSel.value = "";
        });
        head.appendChild(presetSel);

        const count = lights.length;
        const addBtn = iconButton("plus", count >= LIGHT_MAX ? "Maximum 4 lights reached" : "Add a new light", () => {
            if (layer.params.lights.length >= LIGHT_MAX) return;
            this.pushUndo({ kind: "filter", id: layer.id, label: "Add light" });
            const w = this.width || 1024;
            const h = this.height || 1024;
            let n = 1;
            while (layer.params.lights.some((l) => l && l.id === `light_${n}`)) n++;
            const nl = defaultLight(n - 1, { width: w, height: h });
            nl.id = `light_${n}`;
            layer.params.lights.push(nl);
            layer._deselected = false;
            layer._selectedLightId = nl.id;
            this.markFilterChanged(layer);
            this.renderLayers();
        }, "Add light");
        addBtn.classList.add("ipc-small", "ipc-add-light");
        if (count >= LIGHT_MAX) {
            addBtn.disabled = true;
            addBtn.classList.add("disabled");
        }
        head.appendChild(addBtn);
        block.appendChild(head);

        // 3. Light list
        const list = el("div", "ipc-relight-list");
        block.appendChild(list);

        if (count === 0) {
            const emptyHint = el("div", "ipc-faint", "No lights yet: click Add light");
            emptyHint.style.fontSize = "11px";
            emptyHint.style.padding = "4px 0";
            list.appendChild(emptyHint);
        }

        for (let i = 0; i < count; i++) {
            const l = lights[i];
            if (!l) continue;
            const row = el("div", "ipc-relight-row");
            if (l.id === layer._selectedLightId) row.classList.add("ipc-selected");
            if (l.on === false) row.classList.add("ipc-light-off");
            row.title = `Light ${i + 1}`;
            row.addEventListener("click", (e) => {
                stop(e);
                layer._deselected = false;
                if (layer._selectedLightId !== l.id) {
                    layer._selectedLightId = l.id;
                    this.renderLayers();
                }
            });

            // Dot with light colour
            const dot = el("span", "ipc-relight-dot");
            dot.style.backgroundColor = lightColorHex(l.color);
            row.appendChild(dot);

            // Number
            const num = el("span", "ipc-relight-num", String(i + 1));
            row.appendChild(num);

            // Type select
            const typeSel = document.createElement("select");
            typeSel.className = "ipc-sel ipc-relight-type-sel";
            typeSel.title = "Light type";
            for (const t of ["point", "sun", "spot"]) {
                const opt = document.createElement("option");
                opt.value = t;
                opt.textContent = t[0].toUpperCase() + t.slice(1);
                typeSel.appendChild(opt);
            }
            typeSel.value = l.type || "point";
            typeSel.addEventListener("click", stop);
            typeSel.addEventListener("keydown", stop);
            typeSel.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Change light type" });
                l.type = typeSel.value;
                this.markFilterChanged(layer);
                this.renderLayers();
            });
            row.appendChild(typeSel);

            // Eye toggle
            const eyeBtn = miniButton(l.on !== false ? "eye" : "eyeOff", l.on !== false ? "Hide light" : "Show light", (e) => {
                stop(e);
                this.pushUndo({ kind: "filter", id: layer.id, label: l.on !== false ? "Hide light" : "Show light" });
                l.on = l.on === false ? true : false;
                this.markFilterChanged(layer);
                this.renderLayers();
            }, "ipc-relight-eye");
            row.appendChild(eyeBtn);

            // Reset button
            const resetBtn = miniButton("restore", "Reset light to defaults", (e) => {
                stop(e);
                this.pushUndo({ kind: "filter", id: layer.id, label: "Reset light" });
                const w = this.width || 1024;
                const h = this.height || 1024;
                const def = defaultLight(i, { width: w, height: h });
                Object.assign(l, def, { id: l.id });
                this.markFilterChanged(layer);
                this.renderLayers();
            }, "ipc-relight-reset");
            row.appendChild(resetBtn);

            // Delete button
            const delBtn = miniButton("trash", "Delete light", (e) => {
                stop(e);
                this.pushUndo({ kind: "filter", id: layer.id, label: "Delete light" });
                const idx = layer.params.lights.indexOf(l);
                if (idx >= 0) layer.params.lights.splice(idx, 1);
                if (layer._selectedLightId === l.id) {
                    layer._selectedLightId = layer.params.lights[0] ? layer.params.lights[0].id : null;
                }
                this.markFilterChanged(layer);
                this.renderLayers();
            }, "ipc-del ipc-relight-del");
            row.appendChild(delBtn);

            list.appendChild(row);
        }

        // 4. Selected light controls panel
        const selLight = lights.find((l) => l && l.id === layer._selectedLightId);
        if (selLight) {
            const controlsBox = el("div", "ipc-relight-controls");

            const addSlider = (label, key, min, max, step, defVal, unit = "%") => {
                const lab = el("span", null, label);
                controlsBox.appendChild(lab);
                const curVal = selLight[key] ?? defVal;
                const range = document.createElement("input");
                range.type = "range";
                range.min = String(min);
                range.max = String(max);
                range.step = String(step);
                range.value = String(curVal);
                range.title = label;
                range.addEventListener("click", stop);
                range.addEventListener("pointerdown", stop);
                range.addEventListener("keydown", stop);
                const val = el("b", null, `${Math.round(curVal)}${unit}`);
                range.addEventListener("input", () => {
                    if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                    selLight[key] = +range.value;
                    val.textContent = `${Math.round(+range.value)}${unit}`;
                    this.filterPreview = layer.id;
                    this.markFilterChanged(layer, { soon: true });
                });
                range.addEventListener("change", () => {
                    this.filterPreview = null;
                    if (layer._undoPending) {
                        this.pushUndoSnapshot(layer._undoPending, { label: `Relight: ${label}` });
                        layer._undoPending = null;
                    }
                    selLight[key] = +range.value;
                    val.textContent = `${Math.round(+range.value)}${unit}`;
                    this.markFilterChanged(layer);
                });
                controlsBox.appendChild(range);
                controlsBox.appendChild(val);
            };

            addSlider("Intensity", "intensity", 0, 200, 1, 100, "%");
            addSlider("Diffusion", "diffusion", 0, 100, 1, 30, "%");
            addSlider("Gloss", "specular", 0, 100, 1, 0, "%");
            addSlider("Close/Far", "dist", -100, 100, 1, -30, "%");
            addSlider("Range", "range", 5, 500, 1, 50, "%");

            if (selLight.type === "spot") {
                addSlider("Cone", "cone", 1, 89, 1, 30, "\u00b0");
                addSlider("Edge", "edge", 0, 100, 1, 20, "%");

                // Gobo select
                const goboRow = el("div", "ipc-relight-gobo-row");
                const goboLab = el("span", null, "Gobo");
                goboRow.appendChild(goboLab);
                const goboSel = document.createElement("select");
                goboSel.className = "ipc-sel ipc-relight-gobo-sel";
                goboSel.title = "Spotlight gobo pattern";
                const goboLabels = {
                    none: "None",
                    blinds: "Venetian blinds",
                    window: "Window frame",
                    leaves: "Foliage dappled",
                    stripes: "Vertical bars",
                };
                for (const g of SPOT_GOBOS) {
                    const opt = document.createElement("option");
                    opt.value = g;
                    opt.textContent = goboLabels[g] || g;
                    goboSel.appendChild(opt);
                }
                goboSel.value = selLight.gobo || "none";
                goboSel.addEventListener("click", stop);
                goboSel.addEventListener("keydown", stop);
                goboSel.addEventListener("change", () => {
                    this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Gobo" });
                    selLight.gobo = goboSel.value;
                    this.markFilterChanged(layer);
                    this.renderLayers();
                });
                goboRow.appendChild(goboSel);
                controlsBox.appendChild(goboRow);
            }

            // Colour row
            const colorRow = el("div", "ipc-relight-color-row");
            const colorLab = el("span", null, "Colour");
            colorRow.appendChild(colorLab);

            const kelvinSel = document.createElement("select");
            kelvinSel.className = "ipc-sel ipc-relight-kelvin-sel";
            kelvinSel.title = "Colour temperature (Kelvin)";
            for (const kp of KELVIN_PRESETS) {
                const opt = document.createElement("option");
                opt.value = String(kp.kelvin);
                opt.textContent = `${kp.kelvin} K (${kp.label})`;
                kelvinSel.appendChild(opt);
            }
            const customOpt = document.createElement("option");
            customOpt.value = "custom";
            customOpt.textContent = "Custom";
            kelvinSel.appendChild(customOpt);

            const curCol = selLight.color ?? 5500;
            const isPreset = KELVIN_PRESETS.some((kp) => kp.kelvin === curCol);
            kelvinSel.value = isPreset ? String(curCol) : "custom";
            kelvinSel.addEventListener("click", stop);
            kelvinSel.addEventListener("keydown", stop);

            const colorInput = document.createElement("input");
            colorInput.type = "color";
            colorInput.className = "ipc-fxcolor";
            colorInput.value = lightColorHex(curCol);
            colorInput.title = "Custom light colour";
            colorInput.addEventListener("click", stop);
            colorInput.addEventListener("pointerdown", stop);
            colorInput.addEventListener("keydown", stop);

            kelvinSel.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Colour" });
                if (kelvinSel.value === "custom") {
                    selLight.color = colorInput.value;
                } else {
                    selLight.color = +kelvinSel.value;
                    colorInput.value = lightColorHex(selLight.color);
                }
                this.markFilterChanged(layer);
                this.renderLayers();
            });

            colorInput.addEventListener("input", () => {
                if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                selLight.color = colorInput.value;
                kelvinSel.value = "custom";
                const dot = block.querySelector(".ipc-relight-row.ipc-selected .ipc-relight-dot");
                if (dot) dot.style.backgroundColor = colorInput.value;
                this.filterPreview = layer.id;
                this.markFilterChanged(layer, { soon: true });
            });
            colorInput.addEventListener("change", () => {
                this.filterPreview = null;
                if (layer._undoPending) {
                    this.pushUndoSnapshot(layer._undoPending, { label: "Relight: Colour" });
                    layer._undoPending = null;
                }
                selLight.color = colorInput.value;
                kelvinSel.value = "custom";
                this.markFilterChanged(layer);
                this.renderLayers();
            });

            colorRow.appendChild(kelvinSel);
            colorRow.appendChild(colorInput);

            const pickBtn = miniButton("eyedropper", "Pick colour from picture", async () => {
                try {
                    const hex = await this.pickOnce("color");
                    if (hex && typeof hex === "string") {
                        this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Pick colour" });
                        selLight.color = hex;
                        this.markFilterChanged(layer);
                        this.renderLayers();
                    }
                } catch (err) {
                    console.error("pickOnce colour failed:", err);
                }
            }, "ipc-relight-pick");
            colorRow.appendChild(pickBtn);

            controlsBox.appendChild(colorRow);
            block.appendChild(controlsBox);
        }

        // 5. Route block
        const routeBox = el("div", "ipc-relight-route-box");
        routeBox.style.marginTop = "8px";
        routeBox.style.paddingTop = "8px";
        routeBox.style.borderTop = "1px solid var(--sc-border, rgba(255, 255, 255, 0.1))";

        const routeHead = el("div", "ipc-relight-route-head");
        routeHead.style.display = "flex";
        routeHead.style.alignItems = "center";
        routeHead.style.gap = "8px";
        routeHead.style.marginBottom = "6px";

        const routeTitle = el("span", "ipc-relight-title", "Route");
        routeHead.appendChild(routeTitle);

        const routeSel = document.createElement("select");
        routeSel.className = "ipc-sel ipc-relight-route-sel";
        routeSel.title = "Relight route";
        const routes = [
            { id: "app", label: "In-app shader (preview & export)" },
            { id: "magnific", label: "Magnific Relight" },
            { id: "fal-iclight", label: "fal.ai IC-Light v2" },
            { id: "fal-bria", label: "fal.ai Bria FIBO Relight" },
            { id: "comfycloud", label: "Comfy Cloud Qwen 2509 Relight" },
            { id: "comfyui", label: "ComfyUI Local Qwen 2509 Relight" },
        ];
        for (const r of routes) {
            const opt = document.createElement("option");
            opt.value = r.id;
            opt.textContent = r.label;
            routeSel.appendChild(opt);
        }
        routeSel.value = layer.params.route || "app";
        routeSel.addEventListener("click", stop);
        routeSel.addEventListener("keydown", stop);
        routeSel.addEventListener("change", () => {
            this.pushUndo({ kind: "filter", id: layer.id, label: "Relight route" });
            layer.params.route = routeSel.value;
            host.setRelightSettings({ route: routeSel.value });
            this.markFilterChanged(layer);
            this.renderLayers();
        });
        routeHead.appendChild(routeSel);

        // Render button (active when route !== "app")
        if (layer.params.route && layer.params.route !== "app") {
            const rLabels = {
                magnific: "Magnific Relight",
                "fal-iclight": "fal.ai IC-Light v2",
                "fal-bria": "fal.ai Bria FIBO Relight",
                comfycloud: "Comfy Cloud",
                comfyui: "ComfyUI Local",
            };
            const rName = rLabels[layer.params.route] || layer.params.route;
            const renderBtn = iconButton("play", "Render with " + rName, async () => {
                try {
                    renderBtn.disabled = true;
                    await host.relightWhole(this, layer, { route: layer.params.route });
                } catch (err) {
                    console.error("Relight render failed:", err);
                } finally {
                    renderBtn.disabled = false;
                }
            }, "Render");
            renderBtn.classList.add("ipc-small", "ipc-primary", "ipc-relight-render");
            routeHead.appendChild(renderBtn);
        }

        routeBox.appendChild(routeHead);

        // Magnific settings when route === "magnific"
        if (layer.params.route === "magnific") {
            const magControls = el("div", "ipc-relight-mag-controls");
            magControls.style.display = "grid";
            magControls.style.gridTemplateColumns = "1fr 1fr";
            magControls.style.gap = "6px";
            magControls.style.fontSize = "12px";

            // Strength slider (0..100)
            const strengthRow = el("div", "ipc-relight-mag-row");
            strengthRow.style.gridColumn = "1 / -1";
            strengthRow.style.display = "flex";
            strengthRow.style.alignItems = "center";
            strengthRow.style.gap = "8px";
            const strLabel = el("span", null, "Strength");
            strLabel.style.width = "70px";
            const strSlider = document.createElement("input");
            strSlider.type = "range";
            strSlider.min = "0"; strSlider.max = "100";
            strSlider.value = String(layer.params.strength ?? layer.params.light_transfer_strength ?? 100);
            strSlider.className = "ipc-slider";
            strSlider.addEventListener("click", stop);
            strSlider.addEventListener("keydown", stop);
            const strVal = el("span", "ipc-val", strSlider.value + "%");
            strSlider.addEventListener("input", () => {
                if (!layer._undoPending) {
                    layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                }
                strVal.textContent = strSlider.value + "%";
                layer.params.strength = +strSlider.value;
                layer.params.light_transfer_strength = +strSlider.value;
            });
            strSlider.addEventListener("change", () => {
                if (layer._undoPending) {
                    this.pushUndoSnapshot(layer._undoPending, { label: "Relight: Strength" });
                    layer._undoPending = null;
                }
                layer.params.strength = +strSlider.value;
                layer.params.light_transfer_strength = +strSlider.value;
                host.setRelightSettings({ strength: +strSlider.value });
                this.markFilterChanged(layer);
            });
            strengthRow.appendChild(strLabel);
            strengthRow.appendChild(strSlider);
            strengthRow.appendChild(strVal);
            magControls.appendChild(strengthRow);

            // Style select
            const styleRow = el("div", "ipc-relight-mag-row");
            styleRow.style.display = "flex";
            styleRow.style.alignItems = "center";
            styleRow.style.gap = "6px";
            const styLabel = el("span", null, "Style");
            styLabel.style.width = "40px";
            const styleSel = document.createElement("select");
            styleSel.className = "ipc-sel";
            for (const st of RELIGHT_STYLES) {
                const opt = document.createElement("option");
                opt.value = st;
                opt.textContent = st.replace(/_/g, " ");
                styleSel.appendChild(opt);
            }
            styleSel.value = layer.params.style || "standard";
            styleSel.addEventListener("click", stop);
            styleSel.addEventListener("keydown", stop);
            styleSel.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Style" });
                layer.params.style = styleSel.value;
                host.setRelightSettings({ style: styleSel.value });
                this.markFilterChanged(layer);
            });
            styleRow.appendChild(styLabel);
            styleRow.appendChild(styleSel);
            magControls.appendChild(styleRow);

            // Preserve details checkbox
            const pdRow = el("label", "ipc-checkbox-row");
            pdRow.style.display = "flex";
            pdRow.style.alignItems = "center";
            pdRow.style.gap = "6px";
            pdRow.style.cursor = "pointer";
            const pdCheck = document.createElement("input");
            pdCheck.type = "checkbox";
            pdCheck.checked = layer.params.preserve_details !== false;
            pdCheck.addEventListener("click", stop);
            pdCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Preserve details" });
                layer.params.preserve_details = pdCheck.checked;
                host.setRelightSettings({ preserve_details: pdCheck.checked });
                this.markFilterChanged(layer);
            });
            pdRow.appendChild(pdCheck);
            pdRow.appendChild(el("span", null, "Preserve details"));
            magControls.appendChild(pdRow);

            // Interpolate from original checkbox
            const intRow = el("label", "ipc-checkbox-row");
            intRow.style.display = "flex";
            intRow.style.alignItems = "center";
            intRow.style.gap = "6px";
            intRow.style.cursor = "pointer";
            const intCheck = document.createElement("input");
            intCheck.type = "checkbox";
            intCheck.checked = !!(layer.params.interpolate ?? layer.params.interpolate_from_original);
            intCheck.addEventListener("click", stop);
            intCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Interpolate" });
                layer.params.interpolate = intCheck.checked;
                layer.params.interpolate_from_original = intCheck.checked;
                host.setRelightSettings({ interpolate: intCheck.checked });
                this.markFilterChanged(layer);
            });
            intRow.appendChild(intCheck);
            intRow.appendChild(el("span", null, "Interpolate"));
            magControls.appendChild(intRow);

            // Detail from original switch (default true)
            const detRow = el("label", "ipc-checkbox-row");
            detRow.style.display = "flex";
            detRow.style.alignItems = "center";
            detRow.style.gap = "6px";
            detRow.style.cursor = "pointer";
            const detCheck = document.createElement("input");
            detCheck.type = "checkbox";
            detCheck.checked = layer.params.detail !== false;
            detCheck.title = "Apply lighting ratio guided by the full-resolution original to preserve 100% fine texture";
            detCheck.addEventListener("click", stop);
            detCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Detail from original" });
                layer.params.detail = detCheck.checked;
                host.setRelightSettings({ detail: detCheck.checked });
                this.markFilterChanged(layer);
            });
            detRow.appendChild(detCheck);
            detRow.appendChild(el("span", null, "Detail from original"));
            magControls.appendChild(detRow);

            routeBox.appendChild(magControls);
        } else if (layer.params.route === "fal-iclight") {
            const icControls = el("div", "ipc-relight-fal-controls");
            icControls.style.display = "flex";
            icControls.style.flexWrap = "wrap";
            icControls.style.gap = "8px";
            icControls.style.fontSize = "12px";

            // High-res fix checkbox (default true)
            const hrRow = el("label", "ipc-checkbox-row");
            hrRow.style.display = "flex";
            hrRow.style.alignItems = "center";
            hrRow.style.gap = "6px";
            hrRow.style.cursor = "pointer";
            const hrCheck = document.createElement("input");
            hrCheck.type = "checkbox";
            hrCheck.checked = layer.params.enable_hr_fix !== false;
            hrCheck.addEventListener("click", stop);
            hrCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: High-res fix" });
                layer.params.enable_hr_fix = hrCheck.checked;
                host.setRelightSettings({ enable_hr_fix: hrCheck.checked });
                this.markFilterChanged(layer);
            });
            hrRow.appendChild(hrCheck);
            hrRow.appendChild(el("span", null, "High-res fix"));
            icControls.appendChild(hrRow);

            // Detail from original switch (default true)
            const detRow = el("label", "ipc-checkbox-row");
            detRow.style.display = "flex";
            detRow.style.alignItems = "center";
            detRow.style.gap = "6px";
            detRow.style.cursor = "pointer";
            const detCheck = document.createElement("input");
            detCheck.type = "checkbox";
            detCheck.checked = layer.params.detail !== false;
            detCheck.title = "Apply lighting ratio guided by the full-resolution original to preserve 100% fine texture";
            detCheck.addEventListener("click", stop);
            detCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Detail from original" });
                layer.params.detail = detCheck.checked;
                host.setRelightSettings({ detail: detCheck.checked });
                this.markFilterChanged(layer);
            });
            detRow.appendChild(detCheck);
            detRow.appendChild(el("span", null, "Detail from original"));
            icControls.appendChild(detRow);

            routeBox.appendChild(icControls);
        } else if (layer.params.route === "fal-bria") {
            const briaControls = el("div", "ipc-relight-bria-controls");
            briaControls.style.display = "flex";
            briaControls.style.flexDirection = "column";
            briaControls.style.gap = "6px";
            briaControls.style.fontSize = "12px";

            // Light type select
            const briaRow = el("div", "ipc-relight-bria-row");
            briaRow.style.display = "flex";
            briaRow.style.alignItems = "center";
            briaRow.style.gap = "6px";
            const ltLabel = el("span", null, "Light type");
            ltLabel.style.width = "70px";
            const ltSel = document.createElement("select");
            ltSel.className = "ipc-sel";
            ltSel.title = "From the lights: the first light that is on gives the type (a sun: low-angle sunlight, a spot: spotlight on subject, otherwise soft overcast daylight lighting). A type picked here is kept for new relight layers.";
            const fromLights = document.createElement("option");
            fromLights.value = "";
            fromLights.textContent = "From the lights";
            ltSel.appendChild(fromLights);
            for (const bt of RELIGHT_LIGHT_TYPES) {
                const opt = document.createElement("option");
                opt.value = bt;
                opt.textContent = bt;
                ltSel.appendChild(opt);
            }
            ltSel.value = layer.params.light_type || "";
            ltSel.addEventListener("click", stop);
            ltSel.addEventListener("keydown", stop);
            ltSel.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Light type" });
                // "" is From the lights: the layer and the remembered settings forget the pick
                if (ltSel.value) layer.params.light_type = ltSel.value; else delete layer.params.light_type;
                host.setRelightSettings({ light_type: ltSel.value || undefined });
                this.markFilterChanged(layer);
            });
            briaRow.appendChild(ltLabel);
            briaRow.appendChild(ltSel);
            briaControls.appendChild(briaRow);

            // Detail from original switch (default true)
            const detRow = el("label", "ipc-checkbox-row");
            detRow.style.display = "flex";
            detRow.style.alignItems = "center";
            detRow.style.gap = "6px";
            detRow.style.cursor = "pointer";
            const detCheck = document.createElement("input");
            detCheck.type = "checkbox";
            detCheck.checked = layer.params.detail !== false;
            detCheck.title = "Apply lighting ratio guided by the full-resolution original to preserve 100% fine texture";
            detCheck.addEventListener("click", stop);
            detCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Detail from original" });
                layer.params.detail = detCheck.checked;
                host.setRelightSettings({ detail: detCheck.checked });
                this.markFilterChanged(layer);
            });
            detRow.appendChild(detCheck);
            detRow.appendChild(el("span", null, "Detail from original"));
            briaControls.appendChild(detRow);

            routeBox.appendChild(briaControls);
        } else if (layer.params.route === "comfycloud" || layer.params.route === "comfyui") {
            const qwenControls = el("div", "ipc-relight-qwen-controls");
            qwenControls.style.display = "flex";
            qwenControls.style.flexDirection = "column";
            qwenControls.style.gap = "6px";
            qwenControls.style.fontSize = "12px";

            // LoRA strength slider (0..100)
            const loraRow = el("div", "ipc-relight-lora-row");
            loraRow.style.display = "flex";
            loraRow.style.alignItems = "center";
            loraRow.style.gap = "8px";
            const loraLabel = el("span", null, "LoRA strength");
            loraLabel.style.width = "90px";
            const loraSlider = document.createElement("input");
            loraSlider.type = "range";
            loraSlider.min = "0"; loraSlider.max = "100"; loraSlider.step = "5";
            loraSlider.value = String(loraPercent(layer.params.lora_strength ?? layer.params.strength_model));
            loraSlider.className = "ipc-slider";
            loraSlider.addEventListener("click", stop);
            loraSlider.addEventListener("keydown", stop);
            const loraVal = el("span", "ipc-val", loraSlider.value + "%");
            loraSlider.addEventListener("input", () => {
                if (!layer._undoPending) {
                    layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                }
                loraVal.textContent = loraSlider.value + "%";
                layer.params.lora_strength = +loraSlider.value;
                layer.params.strength_model = +loraSlider.value;
            });
            loraSlider.addEventListener("change", () => {
                if (layer._undoPending) {
                    this.pushUndoSnapshot(layer._undoPending, { label: "Relight: LoRA strength" });
                    layer._undoPending = null;
                }
                layer.params.lora_strength = +loraSlider.value;
                layer.params.strength_model = +loraSlider.value;
                host.setRelightSettings({ lora_strength: +loraSlider.value });
                this.markFilterChanged(layer);
            });
            loraRow.appendChild(loraLabel);
            loraRow.appendChild(loraSlider);
            loraRow.appendChild(loraVal);
            qwenControls.appendChild(loraRow);

            // Steps slider (1..20)
            const stepsRow = el("div", "ipc-relight-steps-row");
            stepsRow.style.display = "flex";
            stepsRow.style.alignItems = "center";
            stepsRow.style.gap = "8px";
            const stepsLabel = el("span", null, "Steps");
            stepsLabel.style.width = "90px";
            const stepsSlider = document.createElement("input");
            stepsSlider.type = "range";
            stepsSlider.min = "1"; stepsSlider.max = "20"; stepsSlider.step = "1";
            stepsSlider.value = String(layer.params.steps ?? 4);
            stepsSlider.className = "ipc-slider";
            stepsSlider.addEventListener("click", stop);
            stepsSlider.addEventListener("keydown", stop);
            const stepsVal = el("span", "ipc-val", stepsSlider.value);
            stepsSlider.addEventListener("input", () => {
                if (!layer._undoPending) {
                    layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                }
                stepsVal.textContent = stepsSlider.value;
                layer.params.steps = +stepsSlider.value;
            });
            stepsSlider.addEventListener("change", () => {
                if (layer._undoPending) {
                    this.pushUndoSnapshot(layer._undoPending, { label: "Relight: Steps" });
                    layer._undoPending = null;
                }
                layer.params.steps = +stepsSlider.value;
                host.setRelightSettings({ steps: +stepsSlider.value });
                this.markFilterChanged(layer);
            });
            stepsRow.appendChild(stepsLabel);
            stepsRow.appendChild(stepsSlider);
            stepsRow.appendChild(stepsVal);
            qwenControls.appendChild(stepsRow);

            // Detail from original switch (default true)
            const detRow = el("label", "ipc-checkbox-row");
            detRow.style.display = "flex";
            detRow.style.alignItems = "center";
            detRow.style.gap = "6px";
            detRow.style.cursor = "pointer";
            const detCheck = document.createElement("input");
            detCheck.type = "checkbox";
            detCheck.checked = layer.params.detail !== false;
            detCheck.title = "Apply lighting ratio guided by the full-resolution original to preserve 100% fine texture";
            detCheck.addEventListener("click", stop);
            detCheck.addEventListener("change", () => {
                this.pushUndo({ kind: "filter", id: layer.id, label: "Relight: Detail from original" });
                layer.params.detail = detCheck.checked;
                host.setRelightSettings({ detail: detCheck.checked });
                this.markFilterChanged(layer);
            });
            detRow.appendChild(detCheck);
            detRow.appendChild(el("span", null, "Detail from original"));
            qwenControls.appendChild(detRow);

            if (layer.params.route === "comfyui") {
                const hint = el("div", "ipc-hint");
                hint.style.fontSize = "11px";
                hint.style.marginTop = "4px";
                hint.textContent = "Requires Qwen-Image-Edit-2509 fp8 unet and Relight LoRA on your local ComfyUI";
                qwenControls.appendChild(hint);
            }

            routeBox.appendChild(qwenControls);
        }

        // Last run note
        if (layer.params.last && layer.params.last.ms) {
            const lastNote = el("div", "ipc-relight-last-note");
            lastNote.style.fontSize = "11px";
            lastNote.style.color = "var(--sc-fg-2, #888)";
            lastNote.style.marginTop = "4px";
            const s = (layer.params.last.ms / 1000).toFixed(1);
            lastNote.textContent = `Last render: ${layer.params.last.route} in ${s} s${layer.params.last.seed != null ? ` (seed ${layer.params.last.seed})` : ""}`;
            routeBox.appendChild(lastNote);
        }

        block.appendChild(routeBox);

        return block;
    }
}
