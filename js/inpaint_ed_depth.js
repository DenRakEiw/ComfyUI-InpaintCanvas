// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_depth.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the depth map, maps, depth edit and the filter-preview cancel helpers: moved out of inpaint_canvas.js (item 56 S7, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS } from "./inpaint_filters.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { editorPool } from "./inpaint_jobs.js";
import { uploadCanvas } from "./inpaint_upload.js";
import { GUIDE, STALE_DIFF, WORK_MAX, modelSize, workSize } from "./inpaint_depth.js";
import { deriveMap, editMap, fingerprint, fingerprintDiff, makeMap, packRG16, selectionOnMap } from "./inpaint_maps.js";
import { SNAP_DEFAULT } from "./inpaint_edges.js";
import { failKind } from "./inpaint_status.js";
import { makeCanvas } from "./inpaint_consts.js";
import { el, iconButton } from "./inpaint_dom.js";

export class DepthPart {
    // ---- depth estimation (Nik-9 Parity R1-S3b / F8) --------------------------------

    /** The depth map on the document's map store (F8), or null. */
    get depth() {
        const m = this.maps && this.maps.depth;
        if (!m) return null;
        return {
            ...m,
            u16: m.data || m.u16,   // a store entry keeps its bytes in `data`; a legacy object set through the setter in `u16`
            ...m.meta,
            origW: this.width,
            origH: this.height,
        };
    }

    set depth(v) {
        if (!this.maps) this.maps = {};
        if (v) this.maps.depth = v;
        else delete this.maps.depth;
    }

    async ensureDepthMap({ force = false, edges = null, detail = null } = {}) {
        return this.computeDepthMap({ recompute: force, edges, detail });
    }

    /**
     * Compute or refresh the document's depth map:
     * Samples document without filter layers via host.depthInput, runs Depth Anything V2 Small,
     * optionally computes detail tiles pass (R2-S7), refines edges using guided filter in a worker,
     * and stores result in this.maps.depth via setMap.
     */
    async computeDepthMap({ recompute = false, edges = null, detail = null } = {}) {
        if (!this.base) throw new Error("No image loaded in document");
        if (this.depthPending) return this.depthPending;
        const model = host.depthModel();
        if (!model) {
            this.setStatus("Depth estimation needs Depth Anything V2 Small: download it in Settings › Helpers.", "warn");
            throw new Error("No depth model is downloaded (Settings › Helpers)");
        }
        const run = async () => {
            this.depthPending = true;
            this.renderDepthRow();
            try {
                const token = this.geometryToken();
                const W = this.width, H = this.height;
                const [mw, mh] = modelSize(W, H);
                const input = await host.depthInput(this, mw, mh);
                const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
                const fp = fingerprint(fpInp.image, 64, 64);

                const chosenDetail = detail || (host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard"));
                const existing = this.maps && this.maps.depth;
                const existingDetail = existing && existing.meta && existing.meta.detail
                    ? (existing.meta.detail.route === "large" ? "large" : (existing.meta.detail.grid === 3 ? "finest" : "fine"))
                    : "standard";
                if (!recompute && existing && existing.meta && existing.meta.fp === fp && existingDetail === chosenDetail) {
                    if (edges !== null && edges !== undefined) {
                        this.setMapMeta("depth", { snap: { ...(existing.meta.snap || {}), strength: Math.max(0, Math.min(100, Math.round(+edges))) } });
                    }
                    this.renderDepthRow();
                    return this.maps.depth;
                }
                this.setStatus("Estimating depth with " + model.label + " ...");
                const res = await host.computeDepth(this, {
                    image: input.image,
                    width: mw,
                    height: mh,
                });

                let rawDepth = res.depth;
                let rw = mw;
                let rh = mh;
                let detailMeta = null;

                if (chosenDetail !== "standard") {
                    const grid = chosenDetail === "finest" ? 3 : 2;
                    this._depthAbort = new AbortController();
                    this._depthStatusText = `Depth: tile 1 of ${grid * grid}`;
                    this.renderDepthRow();
                    let detailRes = null;
                    try {
                        detailRes = await host.depthDetail(this, {
                            grid,
                            route: "tiles",
                            global: { data: res.depth, w: mw, h: mh },
                            signal: this._depthAbort.signal,
                            onProgress: (i, n) => {
                                this._depthStatusText = `Depth: tile ${i} of ${n}`;
                                this.setStatus(this._depthStatusText);
                                this.renderDepthRow();
                            },
                        });
                    } catch (err) {
                        console.error("Depth detail failed:", err);
                        this.setStatus("Depth detail failed: " + (err.message || err), failKind(err));
                        return existing || null;
                    } finally {
                        this._depthAbort = null;
                        this._depthStatusText = null;
                    }
                    if (!detailRes) {
                        this.setStatus("Depth estimation cancelled.");
                        return existing || null;
                    }
                    rawDepth = detailRes.data;
                    rw = detailRes.w;
                    rh = detailRes.h;
                    detailMeta = {
                        route: detailRes.route,
                        grid: detailRes.grid,
                        size: [detailRes.w, detailRes.h],
                        tiles: detailRes.fits ? detailRes.fits.length : (detailRes.grid * detailRes.grid),
                        dropped: detailRes.fits ? detailRes.fits.filter((f) => f.dropped).length : 0,
                    };
                }

                const [gw, gh] = workSize(W, H, WORK_MAX);
                const guide = await host.depthInput(this, gw, gh);
                this.setStatus("Refining depth map with guided filter ...");
                const poolRes = await editorPool().run("depth_guide", {
                    raw: rawDepth,
                    rw,
                    rh,
                    gd: guide.image,
                    gw,
                    gh,
                    r: GUIDE.r,
                    eps: GUIDE.eps,
                }, [guide.image.buffer], { priority: INTERACTIVE });
                const u16 = new Uint16Array(poolRes.u16);
                const gd = new Uint8ClampedArray(poolRes.gd);
                const { lo, hi } = poolRes;
                // main answers the model's own time as runMs (and the whole call as seconds)
                const modelMs = res.runMs != null ? res.runMs : (res.seconds != null ? res.seconds * 1000 : 0);
                const snapStrength = edges != null ? Math.max(0, Math.min(100, Math.round(+edges))) : SNAP_DEFAULT;
                const meta = {
                    fp,
                    lo,
                    hi,
                    rawBounds: [res.min, res.max],
                    provider: res.provider,
                    ms: modelMs,
                    totalMs: modelMs + (poolRes.timing && poolRes.timing.total ? poolRes.timing.total : 0),
                    raw: rawDepth,
                    rw,
                    rh,
                    snap: { strength: snapStrength },
                    ...(detailMeta ? { detail: detailMeta } : {}),
                };
                const map = makeMap("depth", gw, gh, u16, [W, 0, 0, H, 0, 0], meta, gd);
                const ok = await this.setMap("depth", map, { label: recompute ? "Recompute depth map" : "Depth map", token });
                if (!ok) {
                    this.setStatus("The depth map was dropped: the picture was turned or cropped meanwhile.");
                    return null;
                }
                this._depthOverlayCanvas = null;
                this._depthStale = false;
                const detailSuffix = detailMeta ? (" (" + chosenDetail + ")") : "";
                this.setStatus("Depth map " + rw + "x" + rh + " -> " + gw + "x" + gh + detailSuffix + " with " + model.label + " in " + (meta.totalMs / 1000).toFixed(2) + " s (" + res.provider + ").");
                return map;
            } catch (err) {
                console.error("Depth estimation failed:", err);
                this.setStatus("Depth estimation failed: " + (err.message || err), failKind(err));
                throw err;
            } finally {
                this.depthPending = null;
                this.renderDepthRow();
            }
        };
        const p = run();
        this.depthPending = p;
        return p;
    }

    /**
     * Create the document's depth map from an existing layer (white is near, black is far).
     * The layer must cover the whole picture.
     * @param {any} layer - Layer object, name, or id
     * @param {{ invert?: boolean }} [opts]
     * @returns {Promise<any>} The created DocMap
     */
    async depthFromLayer(layer, { invert = false } = {}) {
        if (!this.base) throw new Error("No image loaded in document");
        const l = typeof layer === "object" && layer ? layer : (this.layers.find((x) => x.id === layer || x.name === layer) || null);
        if (!l) {
            this.setStatus("Layer not found");
            throw new Error("Layer not found");
        }
        if (l.kind === "filter" || l.kind === "group" || !l.px || l.x > 0 || l.y > 0 || (l.x + l.w) < this.width || (l.y + l.h) < this.height) {
            this.setStatus("The layer must cover the whole picture");
            throw new Error("the layer must cover the whole picture");
        }

        const token = this.geometryToken();
        const W = this.width, H = this.height;
        const [gw, gh] = workSize(W, H, WORK_MAX);
        const s = Math.min(1, WORK_MAX / Math.max(W, H));

        const prevActiveId = this.activeLayerId;
        this.activeLayerId = l.id;
        let layerCanvas = null;
        try {
            layerCanvas = await this.sampleRegionSettled("layer", [0, 0, W, H], s);
        } finally {
            this.activeLayerId = prevActiveId;
        }

        if (!layerCanvas) {
            this.setStatus("Failed to read layer pixels", "error");
            throw new Error("Failed to read layer pixels");
        }

        const lctx = layerCanvas.getContext("2d", { willReadFrequently: true });
        const ldata = lctx.getImageData(0, 0, gw, gh).data;
        const n = gw * gh;
        const rawDepth = new Float32Array(n);
        for (let i = 0, j = 0; i < ldata.length; i += 4, j++) {
            const r = ldata[i], g = ldata[i + 1], b = ldata[i + 2], a = ldata[i + 3];
            const luma = a === 0 ? 0 : (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            const far = invert ? luma : (1 - luma);
            rawDepth[j] = 1 - far;
        }

        const guide = await host.pictureInput(this, gw, gh, { skipFilters: true, background: "#808080" });
        this.setStatus("Refining depth map with guided filter ...");
        const poolRes = await editorPool().run("depth_guide", {
            raw: rawDepth,
            rw: gw,
            rh: gh,
            gd: guide.image,
            gw,
            gh,
            r: GUIDE.r,
            eps: GUIDE.eps,
            lo: 0,
            hi: 1,
        }, [guide.image.buffer], { priority: INTERACTIVE });
        const u16 = new Uint16Array(poolRes.u16);
        const gd = new Uint8ClampedArray(poolRes.gd);

        const fpInp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
        const fp = fingerprint(fpInp.image, 64, 64);
        const meta = {
            source: "layer",
            layer: l.name || `Layer ${l.id}`,
            time: Date.now(),
            fp,
            lo: 0,
            hi: 1,
            raw: rawDepth,
            rw: gw,
            rh: gh,
            snap: { strength: SNAP_DEFAULT },
            invert: !!invert,
        };

        const map = makeMap("depth", gw, gh, u16, [W, 0, 0, H, 0, 0], meta, gd);
        const ok = await this.setMap("depth", map, { label: "Depth from layer", token });
        if (!ok) {
            this.setStatus("The depth map was dropped: the picture was turned or cropped meanwhile.");
            return null;
        }
        this._depthOverlayCanvas = null;
        this._depthStale = false;
        this.setStatus("Depth map " + gw + "x" + gh + " from layer \"" + (l.name || l.id) + "\".");
        this.renderDepthRow();
        return map;
    }

    /**
     * Flyout menu to select a layer to generate depth from.
     * @param {HTMLElement} anchor
     */
    openDepthFromLayerMenu(anchor) {
        if (this.flyout && this.flyout.group && this.flyout.group.btn === anchor) { this.closeFlyout(); return; }
        const candidateLayers = this.layers.filter((l) => l.kind !== "filter" && l.kind !== "group");
        if (!candidateLayers.length) {
            this.setStatus("No layers to create depth from.");
            return;
        }
        const actions = [];
        for (const l of candidateLayers) {
            const name = l.name || `Layer ${l.id}`;
            actions.push({
                label: name,
                title: "Make depth map from " + name + " (white is near, black is far)",
                onClick: () => this.depthFromLayer(l, { invert: false }),
            });
            actions.push({
                label: name + " (inverted)",
                title: "Make depth map from " + name + " inverted (black is near, white is far)",
                onClick: () => this.depthFromLayer(l, { invert: true }),
            });
        }
        this.openFlyout({ btn: anchor, items: [], actions });
    }

    /**
     * Is this filter layer's effect shown instead of the picture in the pass being drawn? Only the
     * screen pass (`viewPass.screen`): a sample pass (the wand's fine pass, the bucket's probe, the
     * Limit row's histograms), a thumbnail or an export reads the picture whatever the view shows.
     */
    effectViewOf(layer, forRun = false) {
        const vp = this.viewPass;
        return !forRun && !!vp && !!vp.screen && !vp.sample
            && !!this.maskView && this.maskView.mode === "effect" && this.maskView.id === layer.id;
    }

    /**
     * Has the picture changed enough since the depth map was computed? Answers from the last check and,
     * when the composite moved since then, runs one more check in the background (a 64 x 64 flatten,
     * no model) and redraws the row when its answer differs; a map just computed is never stale.
     */
    isDepthStale() {
        const m = this.maps && this.maps.depth;
        if (!m) return false;
        if (this._depthStaleAt !== this.compositeVersion && !this._depthStaleCheck) {
            const at = this.compositeVersion;
            this._depthStaleCheck = this.checkDepthStale().then((stale) => {
                this._depthStaleAt = at;
                this._depthStaleCheck = null;
                // the picture moved on while the check ran: once more, for the picture as it is now
                if (this.compositeVersion !== at) this.isDepthStale();
                else if (stale !== this._depthStaleShown) this.renderDepthRow();
            }, () => { this._depthStaleCheck = null; });
        }
        this._depthStaleShown = this._depthStale ?? false;
        return this._depthStaleShown;
    }

    async checkDepthStale() {
        const res = await this.mapStale("depth");
        this._depthStale = res.stale;
        return res.stale;
    }

    /** Draw depth map overlay onto canvas view. */
    drawDepthOverlay(ctx) {
        if (!this.depth || !this.depth.u16) return;
        const key = this.depth.dataVersion || this.depth.version || 1;
        if (!this._depthOverlayCanvas || this._depthOverlayKey !== key) {
            const dw = this.depth.w, dh = this.depth.h;
            const c = document.createElement("canvas");
            c.width = dw; c.height = dh;
            const dctx = c.getContext("2d");
            const idata = dctx.createImageData(dw, dh);
            const d32 = idata.data;
            const u16 = this.depth.u16;
            const n = dw * dh;
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                const v = (u16[i] >> 8) & 0xff;
                d32[j] = v;
                d32[j + 1] = v;
                d32[j + 2] = v;
                d32[j + 3] = 255;
            }
            dctx.putImageData(idata, 0, 0);
            this._depthOverlayCanvas = c;
            this._depthOverlayKey = key;
        }
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.drawImage(this._depthOverlayCanvas, 0, 0, this.width, this.height);
        ctx.restore();
    }

    /** Refresh sidebar depth controls and status. */
    renderDepthRow() {
        if (!this.depthContainer) return;
        const con = this.depthContainer;
        con.innerHTML = "";
        if (!this.base) {
            con.appendChild(el("span", "ipc-dim", "No image loaded"));
            return;
        }
        if (this.depthPending) {
            const row = el("div", "ipc-sec");
            row.appendChild(el("span", null, this._depthStatusText || "Estimating depth map ..."));
            if (this._depthAbort) {
                const cancelBtn = el("button", "ipc-small", "Cancel");
                cancelBtn.addEventListener("click", () => {
                    if (this._depthAbort) this._depthAbort.abort();
                    this.setStatus("Depth estimation cancelled.");
                });
                row.appendChild(cancelBtn);
            }
            con.appendChild(row);
            return;
        }
        const depthMap = (this.maps && this.maps.depth) || this.depth;
        if (!depthMap) {
            const row = el("div", "ipc-sec");
            const btn = iconButton("magic", "Compute 16-bit depth map with Depth Anything V2 Small", () => this.ensureDepthMap(), "Compute depth map");
            btn.classList.add("ipc-small", "ipc-primary");
            row.appendChild(btn);

            const fromLayerBtn = el("button", "ipc-small ipc-btn ipc-depth-from-layer-btn", "From layer...");
            fromLayerBtn.title = "Make depth map from an existing layer";
            fromLayerBtn.addEventListener("click", () => this.openDepthFromLayerMenu(fromLayerBtn));
            row.appendChild(fromLayerBtn);

            const detailLab = el("label", "ipc-depth-detail-label", "Detail");
            const detailSel = el("select", "ipc-select ipc-depth-detail-select");
            const curDetail = host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard");
            for (const [val, lbl] of [["standard", "Standard"], ["fine", "Fine (2x2)"], ["finest", "Finest (3x3)"]]) {
                const opt = el("option", null, lbl);
                opt.value = val;
                if (val === curDetail) opt.selected = true;
                detailSel.appendChild(opt);
            }
            detailSel.addEventListener("change", () => {
                if (host.setDepthDetail) host.setDepthDetail(detailSel.value);
                else host.depthDetailSetting = detailSel.value;
            });
            detailLab.appendChild(detailSel);
            row.appendChild(detailLab);

            con.appendChild(row);
            return;
        }
        const stale = this.isDepthStale();
        const row = el("div", "ipc-sec");
        const info = el("span", null, `${depthMap.w} x ${depthMap.h}` + (stale ? " (stale)" : ""));
        if (stale) info.classList.add("ipc-warn");
        row.appendChild(info);
        const recomputeBtn = iconButton("refresh", "Recompute depth map for the current picture", () => this.ensureDepthMap({ force: true }), "Recompute");
        recomputeBtn.classList.add("ipc-small");
        if (stale) recomputeBtn.classList.add("ipc-primary");
        row.appendChild(recomputeBtn);

        const fromLayerBtn = el("button", "ipc-small ipc-btn ipc-depth-from-layer-btn", "From layer...");
        fromLayerBtn.title = "Replace depth map from an existing layer";
        fromLayerBtn.addEventListener("click", () => this.openDepthFromLayerMenu(fromLayerBtn));
        row.appendChild(fromLayerBtn);

        const detailLab = el("label", "ipc-depth-detail-label", "Detail");
        const detailSel = el("select", "ipc-select ipc-depth-detail-select");
        const curDetail = host.getDepthDetail ? host.getDepthDetail() : (host.depthDetailSetting || "standard");
        for (const [val, lbl] of [["standard", "Standard"], ["fine", "Fine (2x2)"], ["finest", "Finest (3x3)"]]) {
            const opt = el("option", null, lbl);
            opt.value = val;
            if (val === curDetail) opt.selected = true;
            detailSel.appendChild(opt);
        }
        detailSel.addEventListener("change", () => {
            if (host.setDepthDetail) host.setDepthDetail(detailSel.value);
            else host.depthDetailSetting = detailSel.value;
        });
        detailLab.appendChild(detailSel);
        row.appendChild(detailLab);

        const viewBtn = iconButton("eye", "Show depth map on canvas", () => {
            this.mapView = this.mapView === "depth" ? null : "depth";
            viewBtn.classList.toggle("ipc-toggle-on", this.mapView === "depth");
            this.draw();
        }, "Show map");
        viewBtn.classList.add("ipc-small");
        viewBtn.classList.toggle("ipc-toggle-on", this.mapView === "depth");
        this.depthViewBtn = viewBtn;
        row.appendChild(viewBtn);
        con.appendChild(row);

        const edgesRow = el("div", "ipc-sec ipc-depth-edges-row");
        const edgesLab = el("label", "ipc-depth-edges-label", "Edges");
        edgesLab.title = "How closely depth follows the picture's edges; 0 is the smooth map";
        const edgesSlider = document.createElement("input");
        edgesSlider.type = "range";
        edgesSlider.min = "0";
        edgesSlider.max = "100";
        edgesSlider.step = "1";
        const curStrength = (depthMap.meta?.snap?.strength != null) ? depthMap.meta.snap.strength : SNAP_DEFAULT;
        edgesSlider.value = String(curStrength);
        edgesSlider.title = "How closely depth follows the picture's edges; 0 is the smooth map";
        edgesSlider.className = "ipc-range-slider ipc-depth-edges-slider";
        const edgesVal = el("span", "ipc-depth-edges-val", String(curStrength));
        edgesSlider.addEventListener("input", () => {
            const str = parseInt(edgesSlider.value, 10) || 0;
            edgesVal.textContent = String(str);
            this.setMapMeta("depth", { snap: { strength: str } }, { preview: true });
            this.drawSoon();
        });
        edgesSlider.addEventListener("change", () => {
            const str = parseInt(edgesSlider.value, 10) || 0;
            edgesVal.textContent = String(str);
            this.setMapMeta("depth", { snap: { strength: str } }, { preview: false });
            this.draw();
        });
        edgesSlider.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                this.cancelMapMeta("depth");
                const reverted = (this.maps?.depth?.meta?.snap?.strength != null) ? this.maps.depth.meta.snap.strength : SNAP_DEFAULT;
                edgesSlider.value = String(reverted);
                edgesVal.textContent = String(reverted);
                this.drawSoon();
            }
        });
        this.depthEdgesInput = edgesSlider;
        edgesLab.appendChild(edgesSlider);
        edgesLab.appendChild(edgesVal);
        edgesRow.appendChild(edgesLab);
        con.appendChild(edgesRow);

        const editRow = el("div", "ipc-sec ipc-depth-edit-row");
        const hasSel = !!this.getBounds();

        const btnFlatten = el("button", "ipc-small ipc-depth-flatten-btn", "Flatten");
        btnFlatten.title = "Flatten depth inside selection to median";
        btnFlatten.disabled = !hasSel;
        btnFlatten.addEventListener("click", () => this.editDepth("flatten", null, { label: "Depth: Flatten" }));
        editRow.appendChild(btnFlatten);

        const btnNearer = el("button", "ipc-small ipc-depth-nearer-btn", "Nearer");
        btnNearer.title = "Step depth inside selection nearer (-0.05)";
        btnNearer.disabled = !hasSel;
        btnNearer.addEventListener("click", () => this.editDepth("offset", -0.05, { label: "Depth: Nearer" }));
        editRow.appendChild(btnNearer);

        const btnFarther = el("button", "ipc-small ipc-depth-farther-btn", "Farther");
        btnFarther.title = "Step depth inside selection farther (+0.05)";
        btnFarther.disabled = !hasSel;
        btnFarther.addEventListener("click", () => this.editDepth("offset", 0.05, { label: "Depth: Farther" }));
        editRow.appendChild(btnFarther);

        const btnSmooth = el("button", "ipc-small ipc-depth-smooth-btn", "Smooth");
        btnSmooth.title = "Smooth depth inside selection";
        btnSmooth.disabled = !hasSel;
        btnSmooth.addEventListener("click", () => this.editDepth("smooth", 1, { label: "Depth: Smooth" }));
        editRow.appendChild(btnSmooth);

        con.appendChild(editRow);
    }

    /** The sequence counter bumped whenever whole-document geometry changes (PLAN_NIK9_BUILD.md §F8). */
    geometryToken() {
        return this.geometrySeq;
    }

    /**
     * Store or replace a document map (depth, guide, sky mask) under `kind`.
     * Immutable in data: changes produce a new DocMap object.
     * Uploads the packed u16 RGBA8 representation to ComfyUI/mirror if ref is missing.
     * Rejects if `token` no longer matches `geometryToken()` (e.g. canvas turned or cropped meanwhile)
     * or if the editor was destroyed.
     * @param {string} kind
     * @param {any} [map]
     * @param {{ label?: string, token?: number | null }} [opts]
     * @returns {Promise<boolean>}
     */
    async setMap(kind, map = null, { label = "Depth map", token = null } = {}) {
        if (token !== null && token !== this.geometryToken()) return false;
        if (this._destroyed) return false;

        const nodeId = (this.node && this.node.id != null) ? this.node.id : "0";
        if (map && !map.ref) {
            try {
                const c = packRG16(map);
                const { ref } = await uploadCanvas(c, `n${nodeId}_${kind || "depth"}`);
                map.ref = ref;
            } catch (_) {
                // Standalone / offline / test mode
            }
        }
        if (map && map.guide && !map.guideRef) {
            try {
                const gc = document.createElement("canvas");
                gc.width = map.w;
                gc.height = map.h;
                const gctx = gc.getContext("2d");
                const imgData = gctx.createImageData(map.w, map.h);
                imgData.data.set(map.guide);
                gctx.putImageData(imgData, 0, 0);
                const { ref } = await uploadCanvas(gc, `n${nodeId}_${kind || "depth"}guide`);
                map.guideRef = ref;
            } catch (_) {
                // Standalone / offline / test mode
            }
        }
        if (token !== null && token !== this.geometryToken()) return false;
        if (this._destroyed) return false;

        const prev = (this.maps && this.maps[kind]) || null;
        let snapBytes = 0;
        if (prev) {
            if (!map || prev.data !== map.data) snapBytes += prev.data ? prev.data.byteLength : 0;
            if (!map || prev.guide !== map.guide) snapBytes += prev.guide ? prev.guide.byteLength : 0;
        }
        this.pushUndoSnapshot({ kind: "maps", map: kind, prev, bytes: snapBytes }, { label });
        if (!this.maps) this.maps = {};
        if (map) {
            this.maps[kind] = map;
        } else {
            delete this.maps[kind];
        }
        this.mapsVersion++;

        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.sceneSig = null;
        this.renderHistory();
        this.draw();
        this.notifyChanged();
        return true;
    }

    /**
     * Update metadata of a document map (R2-S4).
     * @param {string} kind
     * @param {object} patch
     * @param {{ preview?: boolean, label?: string }} [opts]
     * @returns {boolean}
     */
    setMapMeta(kind, patch, { preview = false, label = "Depth map edges" } = {}) {
        const cur = (this.maps && this.maps[kind]) || null;
        if (!cur) return false;
        const newMeta = { ...(cur.meta || {}), ...patch };
        const updated = deriveMap(cur, { meta: newMeta });
        if (preview) {
            if (!this._mapUndoPending) {
                this._mapUndoPending = cur;
            }
            this.maps[kind] = updated;
            this.mapsVersion++;
            for (const l of this.layers) {
                if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                    this.markFilterChanged(l);
                }
            }
            this.draw();
            return true;
        }
        const prev = this._mapUndoPending || cur;
        this._mapUndoPending = null;
        this.pushUndoSnapshot({ kind: "maps", map: kind, prev, bytes: 0 }, { label });
        this.maps[kind] = updated;
        this.mapsVersion++;
        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.sceneSig = null;
        this.renderHistory();
        this.draw();
        this.notifyChanged();
        return true;
    }

    /**
     * Cancel an in-flight metadata preview on a document map (R2-S5).
     * @param {string} [kind]
     * @returns {boolean}
     */
    cancelMapMeta(kind = "depth") {
        if (!this._mapUndoPending) return false;
        const prev = this._mapUndoPending;
        this._mapUndoPending = null;
        if (!this.maps) this.maps = {};
        this.maps[kind] = prev;
        this.mapsVersion++;
        for (const l of this.layers) {
            if (l.kind === "filter" && (l.params?.limit?.source === (kind || "depth") || this.mapsOf(l).includes(kind || "depth"))) {
                this.markFilterChanged(l);
            }
        }
        this.draw();
        return true;
    }

    /**
     * Edit the document's depth map inside the current selection (R2-S8).
     * @param {"flatten" | "offset" | "smooth"} op
     * @param {number | null} [value]
     * @param {{ label?: string }} [opts]
     * @returns {Promise<{ op: string, median?: number, texels_changed: number, map: { w: number, h: number, version: number } } | null>}
     */
    async editDepth(op, value = null, { label } = {}) {
        if (!this.maps || !this.maps.depth) {
            this.setStatus("Compute a depth map first.");
            return null;
        }
        if (!this.getBounds()) {
            this.setStatus("Select what to change first.");
            return null;
        }

        const map = this.maps.depth;
        const W = this.width;
        const H = this.height;
        const s = Math.min(1, (2 * Math.max(map.w, map.h)) / Math.max(W, H));
        const sw = Math.max(1, Math.round(W * s));
        const sh = Math.max(1, Math.round(H * s));

        let selCanvas = await this.selectionCanvasSettled([0, 0, W, H], s, sw, sh);
        let allocated = false;
        if (!selCanvas) {
            selCanvas = makeCanvas(sw, sh);
            allocated = true;
            const sctx = selCanvas.getContext("2d");
            sctx.imageSmoothingEnabled = true;
            this.sel.drawTo(sctx, 0, 0, sw, sh);
        }

        let weight;
        try {
            weight = selectionOnMap(selCanvas, s, map);
        } finally {
            if (allocated || selCanvas) {
                selCanvas.width = 1;
                selCanvas.height = 1;
            }
        }

        const data = editMap(map, weight, op, value);
        const edits = ((map.meta && map.meta.edits) || 0) + 1;
        const nextMeta = { ...(map.meta || {}), edits };
        const nextMap = deriveMap(map, { data, meta: nextMeta });
        const undoLabel = label || ("Depth: " + (op.charAt(0).toUpperCase() + op.slice(1)));
        await this.setMap("depth", nextMap, { label: undoLabel });

        const res = {
            op,
            texels_changed: data.texelsChanged || 0,
            map: { w: nextMap.w, h: nextMap.h, version: nextMap.version },
        };
        if (data.median !== undefined) {
            res.median = data.median;
        }
        return res;
    }

    /**
     * The map kinds a filter layer depends on (R2-S12, F10):
     * union of def.maps(params) and limit.source === "depth" ? ["depth"] : [].
     * @param {any} layer
     * @returns {string[]}
     */
    mapsOf(layer) {
        if (!layer || (layer.kind ? layer.kind !== "filter" : !layer.filter)) return [];
        const def = FILTERS[layer.filter];
        const res = new Set();
        if (def) {
            if (typeof def.maps === "function") {
                try {
                    const list = def.maps(layer.params || {});
                    if (Array.isArray(list)) for (const k of list) if (k) res.add(k);
                } catch (_) { /* ignore */ }
            } else if (Array.isArray(def.maps)) {
                for (const k of def.maps) if (k) res.add(k);
            }
        }
        if (layer.params && layer.params.limit && (layer.params.limit.source === "depth" || layer.params.limit.source === "map")) {
            res.add("depth");
        }
        return Array.from(res);
    }

    /**
     * Cancel pending filter parameter preview (e.g. from slider drag or preset hover).
     * Restores params to the snapshot taken before preview began and clears pending state.
     * @param {any} layer
     * @returns {boolean}
     */
    cancelFilterParams(layer) {
        if (!layer || layer.kind !== "filter" || !layer._undoPending) return false;
        layer.params = { ...(layer._undoPending.params || {}) };
        layer._undoPending = null;
        this.filterPreview = null;
        this.markFilterChanged(layer, { soon: true });
        this.draw();
        return true;
    }

    /**
     * Every preview still shown goes back to its committed values: a choice list's hover and a filter layer's
     * `_undoPending` while `filterPreview` names its layer (a plugin's hover over a stock, a slider not let go). An
     * `_undoPending` no preview shows any more is a slider the list was rebuilt under: it is not cancelled (that would
     * put back the values from before it over every later edit of the layer). A relight nudge or wheel burst is not a
     * preview but a step of its own (`_nudgePending` / `_wheelPending`, pushed by flushPendingDebounces).
     */
    cancelPreviews() {
        this.cancelChoicePreview();
        for (const l of this.layers || []) if (this.previewShown(l)) this.cancelFilterParams(l);
    }

    /**
     * Whether `filterPreview` shows a preview whose "before" the layer holds in `_undoPending`: not a relight nudge's or
     * wheel burst's preview (theirs is `_nudgePending` / `_wheelPending`), not an `_undoPending` left by a slider the list
     * was rebuilt under (nothing shows it any more).
     */
    previewShown(l) {
        return !!(l && l._undoPending && this.filterPreview === l.id && !l._nudgePending && !l._wheelPending);
    }

    /**
     * The committed parameters (and name) of a filter layer whose preview is shown, as cancelPreviews would put them
     * back (a choice list's hover first: its cancel ends the preview); null when none is. An undo record or a copy holds
     * these, not the hovered or half-dragged ones.
     */
    committedFilter(l) {
        if (!l || l.kind !== "filter") return null;
        const snap = l._hoverSnap && this.filterPreview === l.id ? l._hoverSnap
            : this.previewShown(l) && l._undoPending.kind === "filter" ? l._undoPending : null;
        if (!snap) return null;
        const params = { ...(snap.params || {}) };
        if (Array.isArray(params.lights)) params.lights = JSON.parse(JSON.stringify(params.lights));
        return { params, name: l._hoverSnap === snap ? snap.name || null : null };
    }

    /**
     * renderLayers, unless a control of the list holds an edit still in progress (a slider being dragged): rebuilding the
     * list under it ends the drag without its change event, and its step would never be pushed. The control's own
     * change renders the list when it lets go.
     */
    renderLayersUnlessEditing() {
        if ((this.layers || []).some((x) => x && (x._undoPending || x._matchUndo))) return;
        this.renderLayers();
    }

    /**
     * Checks if the document map under `kind` is stale against the current picture.
     * Renders pictureInput through the map's xf into 64 x 64 and compares fingerprint against meta.fp.
     * @param {string} kind
     * @returns {Promise<{ stale: boolean, diff: number }>}
     */
    async mapStale(kind) {
        const map = this.maps && this.maps[kind];
        if (!map || !map.meta || !map.meta.fp) return { stale: false, diff: 0 };
        if (this.width <= 0 || this.height <= 0) return { stale: false, diff: 0 };
        try {
            const inp = await host.pictureInput(this, 64, 64, { skipFilters: true, background: "#808080" });
            const fp = fingerprint(inp.image, 64, 64);
            const diff = fingerprintDiff(map.meta.fp, fp);
            const thresh = map.meta.threshold != null ? map.meta.threshold : STALE_DIFF;
            return { stale: diff >= thresh, diff };
        } catch (err) {
            console.warn("mapStale failed:", err);
            return { stale: false, diff: 0 };
        }
    }
}
