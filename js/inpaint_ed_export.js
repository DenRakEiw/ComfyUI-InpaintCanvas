// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_export.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// export (PSD, ORA, TIFF, PNG), cleanupFiles, bounds, the crop rect and the info rows: moved out of inpaint_canvas.js (item 56 S9, docs/PLAN_SPLIT.md), text unchanged.

import { api, host } from "./host.js";
import { deflate } from "./px/kernels.js";
import { canvasOf } from "./inpaint_pixels.js";
import { SRGB_CHUNK, asciiJson, pngWithChunks } from "./inpaint_png.js";
import { OraBandWriter, PsdBandWriter, bandRows, tileRows, writeTiff } from "./inpaint_bands.js";
import { tiffPart } from "./inpaint_tiff.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { buildLayered, editorPool, markStep } from "./inpaint_jobs.js";
import { bandPause, nextPartsSeq, partsFailed, partsFlights, partsRun, partsUsable } from "./inpaint_encode.js";
import { failKind } from "./inpaint_status.js";
import { PYRAMID_MIN_PX, hostText, makeCanvas } from "./inpaint_consts.js";
import { MIN_AUTO_CROP, autoSelectionParams, ensureMinSpan } from "./inpaint_backends.js";
import { NO_PROGRAM, canvasRows } from "./inpaint_load.js";

let InpaintEditor = null;

export class ExportPart {
    // ---- export -----------------------------------------------------------------

    /** Save the visible composite (filters applied, no control / reference layers) to output/inpaint_canvas. */
    /**
     * The layers as PSD / ORA see them: pixels at image resolution, bottom first, the base as
     * "Background". The descriptors are not layers: each holds its own export copy as `canvas`.
     * PSD (docs/PLAN_0_1_31.md 3e): a layer's pixels as they are and its mask as `mask: { canvas, disabled }` (the mask's
     * alpha, at the layer's export size), switched off or not; ORA has no masks, so its layers bake the live one.
     * A clipped layer is clipped in the PSD too (`clip`, when its base is exported); ORA has no clipping, its layers go unclipped.
     */
    /**
     * The PSD groups (`lsct`, PLAN_0_1_31 §6.5) of a walk of the layers bottom first: `at(l)` gives the section records
     * to write before layer `l` (a folder record for each group it is not in any more, then a bounding divider for each
     * group it opens), `end()` the folder records that close the rest. A reference never closes a group: it is written
     * where the walk is. A record: `{ section: 1 | 2 | 3, name, visible }` (2 = a folded group, 3 = the divider).
     */
    psdSections() {
        let open = [];
        const close = (k) => {
            const out = [];
            for (let q = open.length - 1; q >= k; q--) out.push({ section: open[q].collapsed ? 2 : 1, name: open[q].name, visible: open[q].visible !== false, x: 0, y: 0, opacity: 1, blend: "normal" });
            open = open.slice(0, k);
            return out;
        };
        return {
            at: (l) => {
                if (this.isReference(l)) return [];
                const chain = this.groupsOf(l.group).reverse();
                let k = 0;
                while (k < open.length && k < chain.length && open[k] === chain[k]) k++;
                const out = close(k);
                for (let q = k; q < chain.length; q++) { out.push({ section: 3, name: "</Layer group>", visible: true, x: 0, y: 0, opacity: 1, blend: "normal" }); open.push(chain[q]); }
                return out;
            },
            end: () => close(0),
        };
    }

    exportLayerStack(fmt = "psd") {
        const psd = fmt === "psd";
        const sec = psd ? this.psdSections() : null;
        const layers = [];
        const bg = makeCanvas(this.width, this.height);
        this.basePx.drawTo(bg.getContext("2d"), 0, 0);   // unscaled (PLAN_BCE §C1 rule 6)
        layers.push({ name: "Background", x: 0, y: 0, canvas: bg, opacity: 1, visible: true, blend: "normal" });
        let skipped = 0;
        for (const l of this.layers) {
            if (sec) layers.push(...sec.at(l));
            if ((l.kind === "filter" && !this.isFillLayer(l)) || !l.px) { skipped++; continue; }
            const w = Math.max(1, Math.round(l.w)), h = Math.max(1, Math.round(l.h));
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            const keepMask = psd && !!l.maskPx;
            if (this.isFillLayer(l)) ctx.drawImage(this.fillLayerCanvas(l, !keepMask), 0, 0, w, h);   // its fill, the live mask baked unless it goes along
            else ctx.drawImage(keepMask ? this.layerWithStroke(l) : this.layerPixels(l), 0, 0, w, h);
            let mask = null;
            if (keepMask) {
                // the mask at the pixels' export size, the same resampling as the pixels
                const mc = makeCanvas(w, h);
                const mctx = mc.getContext("2d");
                mctx.imageSmoothingEnabled = true;
                mctx.imageSmoothingQuality = "high";
                l.maskPx.drawTo(mctx, 0, 0, w, h);
                mask = { canvas: mc, disabled: !!l.maskOff };
            }
            const aside = this.isControl(l) || this.isReference(l);
            layers.push({ name: l.name + (aside ? ` (${l.role})` : ""), x: Math.round(l.x), y: Math.round(l.y), canvas: c, opacity: l.opacity ?? 1, visible: (psd ? l.visible !== false : this.shown(l)) && !aside, blend: l.blend || "normal", ...(mask ? { mask } : {}), ...(psd && this.clipBaseOf(l) ? { clip: true } : {}) });
        }
        if (sec) layers.push(...sec.end());
        return { layers, skipped };
    }

    /**
     * The layers as PSD / ORA see them, as row sources (E4, inpaint_bands.js), bottom first: `[{ meta, open() }]`, where
     * `open()` gives `{ source, close() }`. A layer on tiles, at its own size and without a mask, is read from its tiles
     * (a copy-on-write clone taken now, released through `held`); any other is drawn into a canvas of its size when it
     * is opened, as `exportLayerStack` does for all of them at once, so only one such canvas exists at a time.
     * PSD: a masked layer's pixels as they are (from its tiles when it can) and its mask as `openMask()`, with
     * `meta.mask = { disabled }`; ORA bakes the live mask as before.
     */
    exportLayerSources(held, fmt = "psd") {
        const psd = fmt === "psd";
        const byName = arenaEnabled();
        const fromTiles = (px) => { const snap = px.clone(); held.push(snap); return () => ({ source: tileRows(snap, byName), close() {} }); };
        const fromCanvas = (draw, w, h) => () => {
            const c = makeCanvas(w, h);
            draw(c.getContext("2d"));
            return { source: canvasRows(c), close() { c.width = 1; c.height = 1; } };
        };
        const out = [];
        const bs = this.basePx;
        out.push({
            meta: { name: "Background", x: 0, y: 0, opacity: 1, visible: true, blend: "normal" },
            open: isTilePixels(bs) && bs.width === this.width && bs.height === this.height ? fromTiles(bs) : fromCanvas((ctx) => bs.drawTo(ctx, 0, 0), this.width, this.height),
        });
        let skipped = 0;
        const sec = psd ? this.psdSections() : null;
        const sections = (list) => list.map((meta) => ({ meta, open: null }));
        for (const l of this.layers) {
            if (sec) out.push(...sections(sec.at(l)));
            if ((l.kind === "filter" && !this.isFillLayer(l)) || !l.px) { skipped++; continue; }
            const w = Math.max(1, Math.round(l.w)), h = Math.max(1, Math.round(l.h));
            const aside = this.isControl(l) || this.isReference(l);
            const mask = psd ? l.maskPx : null;   // kept as a mask, switched off or not
            const still = !this.liveStrokeOn(l) && !(this.pending && this.pending.layer === l);
            // raw pixels from the tiles: an unmasked layer, or one whose mask goes along as a mask
            const plain = isTilePixels(l.px) && (mask || !this.liveMask(l)) && l.px.width === w && l.px.height === h && still;
            const smooth = (ctx) => { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; };
            out.push({
                meta: { name: l.name + (aside ? ` (${l.role})` : ""), x: Math.round(l.x), y: Math.round(l.y), opacity: l.opacity ?? 1, visible: (psd ? l.visible !== false : this.shown(l)) && !aside, blend: l.blend || "normal", ...(mask ? { mask: { disabled: !!l.maskOff } } : {}), ...(psd && this.clipBaseOf(l) ? { clip: true } : {}) },
                open: this.isFillLayer(l) ? this.fillLayerRows(l, !mask) : plain ? fromTiles(l.px) : fromCanvas((ctx) => { smooth(ctx); ctx.drawImage(mask ? this.layerWithStroke(l) : this.layerPixels(l), 0, 0, w, h); }, w, h),
                // the mask at the pixels' size: its own tiles when it has that size already, else drawn to it
                ...(mask ? { openMask: isTilePixels(mask) && mask.width === w && mask.height === h && still ? fromTiles(mask) : fromCanvas((ctx) => { smooth(ctx); mask.drawTo(ctx, 0, 0, w, h); }, w, h) } : {}),
            });
        }
        if (sec) out.push(...sections(sec.end()));
        return { stack: out, skipped };
    }

    /**
     * A PSD or ORA file written from row sources by the worker pool (E4): `{ blob, layers, skipped }`, or null when it
     * cannot be (the canvas backend, no pool, no Rust kernels) and the caller takes the canvas writers. The merged
     * picture comes in bands when it can (`bandPlan`), else from one flatten.
     */
    async exportLayeredBands(fmt, progress = null) {
        if (!this.tileMode || !partsUsable() || InpaintEditor.bands === false) return null;
        const group = "layered" + nextPartsSeq();
        const W = this.width, H = this.height;
        const version = this.compositeVersion;
        const held = [];
        let flat = null;
        try {
            const opts = { width: W, height: H, run: partsRun(group), flights: partsFlights(), pause: bandPause };
            const writer = fmt === "psd" ? new PsdBandWriter(opts) : new OraBandWriter(opts);
            const { stack, skipped } = this.exportLayerSources(held, fmt);
            // B item 1: the merged picture of a plain stack is composited by the workers, from clones taken now with the layers'
            const stackOf = await this.stackSource({ forRun: true });
            if (stackOf) held.push({ release: () => stackOf.release() });
            const steps = stack.length + 1;
            let done = 0;
            const report = (f) => { if (progress) progress((done + f) / steps); };
            for (const L of stack) {
                if (!L.open) { writer.section(L.meta); done++; continue; }   // a group's record (PSD)
                const o = L.open();
                const m = L.openMask ? L.openMask() : null;
                try { await writer.layer(L.meta, o.source, report, m ? m.source : null); } finally { o.close(); if (m) m.close(); }
                done++;
            }
            const plan = stackOf ? null : this.bandPlan({ forRun: true });
            const bands = plan ? await this.bandSource({ forRun: true }, plan) : null;   // B item 7 part 2: filter layers over worker-composited bands
            if (bands) held.push(bands);
            let composite;
            if (stackOf) composite = stackOf.source;
            else if (bands) {
                composite = bandRows(W, H, (y0, y1) => {
                    if (this.compositeVersion !== version) throw new Error("the picture changed while it was written; try again");
                    return bands.read(y0, y1);
                }, bands.rows);
            } else {
                flat = this.flattenToCanvas({ forRun: true });
                composite = canvasRows(flat);
            }
            let blob;
            if (fmt === "psd") blob = await writer.finish(composite, report);
            else {
                const ts = Math.min(1, 256 / Math.max(W, H));
                const small = await this.sampleRegionSettled("image", [0, 0, W, H], ts, { forRun: true });
                const thumb = await new Promise((r) => small.toBlob(r, "image/png"));
                blob = await writer.finish(composite, thumb, report);
            }
            return { blob, layers: stack.filter((L) => L.open).length, skipped };
        } catch (err) {
            editorPool().cancel(group);
            if (partsFailed(err) || String(err && err.message).includes(NO_PROGRAM)) return null;   // the canvas writers take it
            throw err;
        } finally {
            for (const px of held) px.release();
            if (flat) { flat.width = 1; flat.height = 1; }
        }
    }

    /**
     * The picture as a TIFF (docs/PLAN_0_1_29.md 3d): `{ blob, width, height }`. As it is (no Size or Canvas row), from
     * the row sources the PNG and PSD exports read: a plain stack composited by the workers, bands, or one flatten;
     * scaled or framed, from the export canvas. The strips are compressed by the pool, or here when there is none.
     */
    async encodeTiff(progress = null, { flatOnly = false } = {}) {
        const plain = host.exportIsPlain(this);
        const pooled = partsUsable();
        const group = "tiff" + nextPartsSeq();
        const held = [];
        let flat = null;
        try {
            let source = null;
            if (plain && pooled && this.tileMode && !flatOnly) {
                const stack = await this.stackSource({ forRun: true });
                if (stack) { held.push({ release: () => stack.release() }); source = stack.source; }
                else {
                    const plan = this.bandPlan({ forRun: true });
                    const bands = plan ? await this.bandSource({ forRun: true }, plan) : null;
                    if (bands) {
                        held.push(bands);
                        const version = this.compositeVersion;
                        source = bandRows(this.width, this.height, (y0, y1) => {
                            if (this.compositeVersion !== version) throw new Error("the picture changed while it was written; try again");
                            return bands.read(y0, y1);
                        }, bands.rows);
                    }
                }
            }
            if (!source) {
                if (this.relightSettled) await this.relightSettled();
                flat = plain ? this.flattenToCanvas({ forRun: true }) : await host.exportCanvas(this, "tiff");
                source = canvasRows(flat);
            }
            const run = pooled ? partsRun(group) : (op, args) => tiffPart(args, deflate);
            const blob = await writeTiff(source, run, { flights: pooled ? partsFlights() : 1, progress, pause: bandPause });
            return { blob, width: source.width, height: source.height };
        } catch (err) {
            if (pooled) editorPool().cancel(group);
            if (!flatOnly && !this.huge && String(err && err.message).includes(NO_PROGRAM)) return this.encodeTiff(progress, { flatOnly: true });   // a matched stack without its program: one flatten
            throw err;
        } finally {
            for (const h of held) h.release();
            if (flat) { flat.width = 1; flat.height = 1; }
        }
    }

    /** The active layer alone as a PNG with transparency, into the output folder. */
    async exportLayerPng() {
        const l = this.activeLayer();
        if (!l || l.kind === "filter" || !l.px) { this.setStatus("Select a pixel layer to save it on its own."); return null; }
        try {
            const c = makeCanvas(this.width, this.height);
            c.getContext("2d").drawImage(this.layerPixels(l), l.x, l.y, l.w, l.h);
            const blob = await new Promise((r) => c.toBlob(r, "image/png"));
            const stem = (l.name || "layer").replace(/[^a-z0-9._ -]/gi, "_");
            const saved = await host.saveExport(blob, `${stem}.png`, { editor: this });
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            this.setStatus(`Saved ${saved.path} (${l.name}, ${this.width} × ${this.height} with transparency).`, "info");
            return saved;
        } catch (err) { console.error(err); this.setStatus("Save failed: " + (err.message || err), failKind(err)); return null; }
    }

    /** The selection as a black and white mask PNG, into the output folder. */
    async exportMaskPng() {
        if (!this.getBounds()) { this.setStatus("Nothing selected to save as a mask."); return null; }
        try {
            const blob = await new Promise((r) => this.maskToCanvas().toBlob(r, "image/png"));
            const stem = ((this.saveNameInput && this.saveNameInput.value) || "inpaint_canvas").trim().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_") || "inpaint_canvas";
            const saved = await host.saveExport(blob, `${stem}_mask.png`, { editor: this });
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            this.setStatus(`Saved ${saved.path} (mask, white = selected).`, "info");
            return saved;
        } catch (err) { console.error(err); this.setStatus("Save failed: " + (err.message || err), failKind(err)); return null; }
    }

    async exportImage({ download = false } = {}) {
        if (!this.base) { this.setStatus("Nothing to save yet."); return null; }
        const start = markStep("export", "start");   // its fmt once it is read below
        if (this.removePending || this.healPending || this.liquifyPending) { this.setStatus("Waiting for the stroke to land..."); await this.heldEdit(); }
        await this.relightSettled();   // every format: the layered and TIFF writers read bands that do not wait by themselves (F2.7)
        markStep("export", "ready");
        const fmt = ["png", "jpg", "webp", "tiff", "psd", "ora"].includes(this.saveFormatSel && this.saveFormatSel.value) ? this.saveFormatSel.value : "png";
        start.fmt = fmt;
        const stem = ((this.saveNameInput && this.saveNameInput.value) || "inpaint_canvas").trim().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_") || "inpaint_canvas";
        try {
            this.setStatus("Saving ...");
            let blob, note = "", embedded = false, banded = false, size = null;
            let pngTexts = null;
            const pngChunks = fmt === "png" ? [SRGB_CHUNK] : null;   // 3f: the pixels are sRGB, and the file says so
            if (fmt === "png") {
                // Same metadata as SaveImage: the workflow (and the canvas prompt), so the file loads back into ComfyUI. The
                // host answers null when it is not to be embedded (the app's switch, on by default: docs/PLAN_0_1_29.md 3f).
                try {
                    const workflow = host.workflowForPng(this);
                    if (workflow) pngTexts = { workflow: asciiJson(workflow), inpaint_canvas: asciiJson({ prompt: this.promptText, negative: this.negativeText, width: this.width, height: this.height, seed: this.genSettings.seed, mode: this.genSettings.mode }) };
                } catch (err) { console.warn("Inpaint Canvas: could not embed the workflow", err); }
            }
            // E2: a PNG of the picture as it is is written in bands by the worker pool, without a canvas of the picture
            if (fmt === "png" && host.exportIsPlain(this)) {
                const t0 = performance.now();
                const r = await this.encodeComposite({ forRun: true }, { texts: pngTexts, chunks: pngChunks, progress: (f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`) });
                if (r) { blob = r.blob; banded = true; embedded = !!pngTexts; note = `, ${Math.round(performance.now() - t0)} ms`; }
            }
            // E4: a layered file from the layers' own tiles and the composite's bands, packed by the worker pool
            if (fmt === "psd" || fmt === "ora") {
                const t0 = performance.now();
                const r = await this.exportLayeredBands(fmt, (f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`));
                if (r) { blob = r.blob; note = `, ${r.layers} layers${r.skipped ? `, ${r.skipped} filter layer${r.skipped > 1 ? "s" : ""} only in the merged image` : ""}, ${Math.round(performance.now() - t0)} ms`; }
            }
            // 3d: a TIFF is written in strips from the picture's rows (scaled or framed from the export canvas)
            if (fmt === "tiff") {
                const t0 = performance.now();
                const r = await this.encodeTiff((f) => this.setStatus(`Saving ... ${Math.round(f * 100)} %`));
                blob = r.blob; size = [r.width, r.height]; note = `, ${Math.round(performance.now() - t0)} ms`;
            }
            const canvas = blob ? { width: size ? size[0] : this.width, height: size ? size[1] : this.height } : await host.exportCanvas(this, fmt);
            if (blob) { /* written in bands */ }
            else if (fmt === "psd" || fmt === "ora") {
                const t0 = performance.now();
                const { layers, skipped } = this.exportLayerStack(fmt);
                blob = await buildLayered(fmt, { width: this.width, height: this.height, layers, composite: canvas });
                note = `, ${layers.filter((L) => !L.section).length} layers${skipped ? `, ${skipped} filter layer${skipped > 1 ? "s" : ""} only in the merged image` : ""}, ${Math.round(performance.now() - t0)} ms`;
            } else {
                blob = await new Promise((r) => canvas.toBlob(r, fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png", host.exportQuality(this)));
            }
            if (fmt === "png" && !banded) {
                try { blob = pngWithChunks(await blob.arrayBuffer(), { texts: pngTexts, chunks: pngChunks }); embedded = !!pngTexts; } catch (err) { console.warn("Inpaint Canvas: could not embed the workflow", err); }
            }
            markStep("export", "encoded", { MB: blob ? blob.size / 1048576 : 0 });
            const saved = await host.saveExport(blob, `${stem}.${fmt === "tiff" ? "tif" : fmt}`, { editor: this, download });
            markStep("export", "saved");
            if (!saved) { this.setStatus("Save cancelled."); return null; }
            const kb = Math.round(blob.size / 1024);
            this.setStatus(`Saved ${saved.path} (${canvas.width} × ${canvas.height}, ${kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " kB"}${fmt === "png" && embedded ? ", " + hostText("pngEmbedded", "recipe embedded") : ""}${note}).`, "info");
            return saved;
        } catch (err) {
            console.error(err);
            this.setStatus("Save failed: " + (err.message || err), failKind(err));
            return null;
        }
    }

    async cleanupFiles() {
        const fmt = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
        try {
            const keep = InpaintEditor.referencedFiles();
            const call = async (dry) => {
                const r = await api.fetchApi("/inpaint_canvas/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep, dry_run: dry }) });
                if (r.status !== 200) throw new Error(`cleanup route answered ${r.status} (restart ComfyUI after updating the node)`);
                return r.json();
            };
            this.setStatus("Checking files ...");
            const plan = await call(true);
            if (!plan.removed) {
                this.setStatus(`Nothing to clean up: ${plan.kept} file${plan.kept === 1 ? "" : "s"} still in use.`);
                if (this.cleanupInfo) this.cleanupInfo.textContent = `${plan.kept} in use`;
                return;
            }
            const t = plan.by_type || {};
            const msg = `Delete ${plan.removed} file${plan.removed === 1 ? "" : "s"} (${fmt(plan.bytes)}) from the inpaint_canvas folders?\n` +
                `input ${t.input || 0} · output ${t.output || 0} · temp ${t.temp || 0}\n\n` +
                `Kept: ${plan.kept} file${plan.kept === 1 ? "" : "s"} used by open editors, open workflow tabs or saved workflows, and anything younger than two minutes. Discarded history results that are deleted cannot be restored.`;
            if (!(await this.ask({ title: "Clean up files", message: msg, ok: "Delete", danger: true }))) { this.setStatus("Cleanup cancelled."); return; }
            const res = await call(false);
            this.setStatus(`Cleanup: ${res.removed} file${res.removed === 1 ? "" : "s"} deleted (${fmt(res.bytes)}), ${res.kept} kept.`);
            if (this.cleanupInfo) this.cleanupInfo.textContent = `${res.removed} deleted, ${fmt(res.bytes)}`;
        } catch (err) {
            console.error(err);
            this.setStatus("Cleanup failed: " + (err.message || err), failKind(err));
        }
    }

    /** Exact bounding box of the selected pixels inside a box, or null when it holds none. */
    scanBounds(bx0, by0, bx1, by1) {
        const W = bx1 - bx0, H = by1 - by0;
        if (W <= 0 || H <= 0) return null;
        // one 32-bit word per pixel; alpha is the high byte, so "selected" is one bit test
        const d = new Uint32Array(this.sel.readRect(bx0, by0, W, H).data.buffer);
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) {
            const row = y * W;
            let rx0 = -1;
            for (let x = 0; x < W; x++) if (d[row + x] & 0x80000000) { rx0 = x; break; }
            if (rx0 < 0) continue;
            let rx1 = rx0;
            for (let x = W - 1; x > rx0; x--) if (d[row + x] & 0x80000000) { rx1 = x; break; }
            if (rx0 < x0) x0 = rx0;
            if (rx1 > x1) x1 = rx1;
            if (y < y0) y0 = y;
            y1 = y;
        }
        if (x1 < 0) return null;
        return [bx0 + x0, by0 + y0, bx0 + x1 + 1, by0 + y1 + 1];
    }

    /**
     * Exact bounding box of the selected pixels inside `box`, a rectangle known to hold
     * them all, read in 64 px strips from each edge inwards: rows from the top until the
     * first selected pixel, rows from the bottom, then columns within those rows. A
     * marquee on a 15k canvas costs four strips of a few MB instead of the box (hundreds
     * of MB and half a second of readback). A selection whose alpha never reaches 128
     * still reads the whole box, strip by strip. Null when the box holds none.
     */
    scanBoundsIn(box) {
        const [bx0, by0, bx1, by1] = box;
        const W = bx1 - bx0, H = by1 - by0;
        if (W <= 0 || H <= 0) return null;
        const sel = this.sel;
        const STRIP = 64;
        const rows = (y, h) => {   // first and last row of the strip with a selected pixel, or null
            const d = new Uint32Array(sel.readRect(bx0, y, W, h).data.buffer);
            let first = -1, last = -1;
            for (let r = 0; r < h; r++) {
                const row = r * W;
                for (let x = 0; x < W; x++) if (d[row + x] & 0x80000000) { if (first < 0) first = r; last = r; break; }
            }
            return first < 0 ? null : [first, last];
        };
        let y0 = -1, y1 = -1;
        for (let y = by0; y < by1 && y0 < 0; y += STRIP) { const hit = rows(y, Math.min(STRIP, by1 - y)); if (hit) y0 = y + hit[0]; }
        if (y0 < 0) return null;
        for (let y = by1; y > y0 && y1 < 0; y -= STRIP) { const yy = Math.max(y0, y - STRIP); const hit = rows(yy, y - yy); if (hit) y1 = yy + hit[1] + 1; }
        if (y1 < 0) y1 = y0 + 1;
        const cols = (x, w) => {   // first and last column of the strip with a selected pixel, or null
            const h = y1 - y0;
            const d = new Uint32Array(sel.readRect(x, y0, w, h).data.buffer);
            let first = -1, last = -1;
            for (let c = 0; c < w; c++) {
                for (let r = 0; r < h; r++) if (d[r * w + c] & 0x80000000) { if (first < 0) first = c; last = c; break; }
            }
            return first < 0 ? null : [first, last];
        };
        let x0 = -1, x1 = -1;
        for (let x = bx0; x < bx1 && x0 < 0; x += STRIP) { const hit = cols(x, Math.min(STRIP, bx1 - x)); if (hit) x0 = x + hit[0]; }
        if (x0 < 0) return null;
        for (let x = bx1; x > x0 && x1 < 0; x -= STRIP) { const xx = Math.max(x0, x - STRIP); const hit = cols(xx, x - xx); if (hit) x1 = xx + hit[1] + 1; }
        if (x1 < 0) x1 = x0 + 1;
        return [x0, y0, x1, y1];
    }

    /**
     * A rectangle holding every pixel of the selection with any alpha at all (the bounds
     * count only alpha >= 128; a feathered tail lies outside them), from the 1/16 display
     * level padded by one cell, so nothing full-size is read back. What an undo step has
     * to copy and what a restore has to refresh. Null when the selection is empty.
     *
     * On tiles it is exact and reads nothing: the extent of the tile set (`bounds()`, every
     * allocated tile holds a pixel), with no display mirror made. The canvas backend's level
     * loses what its four smoothed halvings round away (an isolated pixel below about alpha
     * 128, and at sizes that do not halve evenly even alpha 255); `exact` takes the whole
     * image there instead, for a caller that must not lose one (the selection drag, C2 step
     * b's review; a whole-canvas write is GPU work on that backend).
     */
    selectionExtent({ exact = false } = {}) {
        if (!this.sel) return null;
        const W = this.width, H = this.height;
        if (isTilePixels(this.sel)) return this.sel.bounds();
        if (W * H <= PYRAMID_MIN_PX || exact) return [0, 0, W, H];
        const budget = this._pyramidBudget;
        this._pyramidBudget = Infinity;
        const lvl = this.displaySource(this.sel, 1 / 16);
        this._pyramidBudget = budget;
        // no level came back (displaySource hands back the source itself): read nothing, take it all
        if (lvl === canvasOf(this.sel)) return [0, 0, W, H];
        const lw = lvl.width, lh = lvl.height;
        const d = new Uint32Array(lvl.getContext("2d").getImageData(0, 0, lw, lh).data.buffer);
        let cx0 = lw, cy0 = lh, cx1 = -1, cy1 = -1;
        for (let y = 0; y < lh; y++) {
            const row = y * lw;
            for (let x = 0; x < lw; x++) {
                if (!(d[row + x] & 0xff000000)) continue;   // any alpha at all, the level is smoothed
                if (x < cx0) cx0 = x;
                if (x > cx1) cx1 = x;
                if (y < cy0) cy0 = y;
                cy1 = y;
            }
        }
        if (cx1 < 0) return null;
        const fx = W / lw, fy = H / lh;
        return [Math.max(0, Math.floor((cx0 - 1) * fx) - 2), Math.max(0, Math.floor((cy0 - 1) * fy) - 2),
            Math.min(W, Math.ceil((cx1 + 2) * fx) + 2), Math.min(H, Math.ceil((cy1 + 2) * fy) + 2)];
    }

    /**
     * The selection's bounding box, scanned for: the extent from the 1/16 level, then the
     * exact box by strips inside it. Never a readback of the whole canvas.
     */
    selectionBounds() {
        const ext = this.selectionExtent();
        return ext ? this.scanBoundsIn(ext) : null;
    }

    /**
     * The selection's bounding box after an op that filled `box` ([x0, y0, x1, y1] in
     * image coordinates), or undefined when it has to be scanned for (every subtract).
     */
    boundsAfter(mode, box) {
        // the known box, exact or a superset ({ within }), or undefined when nothing is known
        const known = this.selectionDirty && !this.selectionLoose ? undefined : this.cachedBounds;
        if (mode === "subtract") {
            // a subtract only removes: the old box still holds everything, as a superset
            if (known === undefined) return undefined;
            return known ? { within: known } : null;
        }
        const b = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])),
            Math.min(this.width, Math.ceil(box[2])), Math.min(this.height, Math.ceil(box[3]))];
        const empty = b[2] <= b[0] || b[3] <= b[1];
        if (mode === "replace") return empty ? null : b;
        if (mode === "intersect") {
            if (empty || known === null) return null;
            if (known === undefined) return { within: b };
            const ix0 = Math.max(known[0], b[0]), iy0 = Math.max(known[1], b[1]);
            const ix1 = Math.min(known[2], b[2]), iy1 = Math.min(known[3], b[3]);
            if (ix0 >= ix1 || iy0 >= iy1) return null;
            return { within: [ix0, iy0, ix1, iy1] };
        }
        if (known === undefined) return undefined;
        const old = known;
        const u = empty ? old : (!old ? b : [Math.min(old[0], b[0]), Math.min(old[1], b[1]), Math.max(old[2], b[2]), Math.max(old[3], b[3])]);
        return this.selectionLoose && u ? { within: u } : u;
    }

    getBounds() {
        if (this.selectionDirty) {
            // a superset is made exact by strips from its edges; otherwise the extent is scanned for
            this.cachedBounds = this.selectionLoose && this.cachedBounds ? this.scanBoundsIn(this.cachedBounds) : this.selectionBounds();
            this.selectionDirty = false;
            this.selectionLoose = false;
        }
        return this.cachedBounds;
    }

    /** Auto sizing values for the current selection, or null without a selection. */
    autoParams() {
        const b = this.getBounds();
        const strength = this.genSettings.mode === "local" ? this.genSettings.denoise : 1;
        return b ? autoSelectionParams(b[2] - b[0], b[3] - b[1], strength) : null;
    }

    cropRect() {
        const b = this.getBounds();
        if (!b) return [0, 0, this.width, this.height];
        const auto = this.cropSettings.context === "auto";
        const padding = auto ? this.autoParams().pad : this.widgetValue("padding", 0);
        let x0 = Math.max(0, b[0] - padding), y0 = Math.max(0, b[1] - padding);
        let x1 = Math.min(this.width, b[2] + padding), y1 = Math.min(this.height, b[3] + padding);
        if (auto) {
            [x0, x1] = ensureMinSpan(x0, x1, this.width, MIN_AUTO_CROP);
            [y0, y1] = ensureMinSpan(y0, y1, this.height, MIN_AUTO_CROP);
        }
        return [x0, y0, x1 - x0, y1 - y0];
    }

    syncCropControls() {
        if (!this.cropContextSel) return;
        this.cropContextSel.value = this.cropSettings.context === "auto" ? "auto" : "manual";
        this.cropFeatherSel.value = this.cropSettings.feather === "auto" ? "auto" : "manual";
        this.cropFillSel.value = this.cropSettings.fill || "none";
        this.cropColorMatch.checked = !!this.cropSettings.colorMatch;
        if (this.cropOriginal) this.cropOriginal.checked = !!this.cropSettings.withOriginal;
        if (this.cropAlign) this.cropAlign.checked = this.cropSettings.align !== false;
        if (this.cropPasteSel) this.cropPasteSel.value = this.cropSettings.paste === "crop" ? "whole crop" : "selection";
        if (this.extendFillSel) this.extendFillSel.value = this.cropSettings.extendFill || "average color";
    }

    widgetValue(name, fallback) {
        return host.widgetValue(this, name, fallback);
    }

    renderInfo() {
        // the recipe, the selection, the fill and the Original all change what the references go as
        this.refreshRefLayout();
        this.renderInfoRows();
        // the depth row follows the picture: a load, a crop or a resize changes what it says (it was
        // rendered only on a document's setValue and after a compute, so a loaded picture kept "No image loaded")
        this.renderDepthRow();
    }

    /** The Info panel's rows (renderInfo, and again when the references' layout has answered: refreshRefLayout). */
    renderInfoRows() {
        if (this.resizeW && this.width && document.activeElement !== this.resizeW && document.activeElement !== this.resizeH) { this.resizeW.value = this.width; this.resizeH.value = this.height; }
        if (!this.infoEl) return;
        const rows = [];
        if (this.base) {
            rows.push(["Canvas", `${this.width} × ${this.height}`]);
            const b = this.getBounds();
            rows.push(["Selection", b ? `${b[2] - b[0]} × ${b[3] - b[1]}` : "none (whole image)"]);
            const [, , cw, ch] = this.cropRect();
            const ap = this.autoParams();
            rows.push(["Crop", `${cw} × ${ch}` + (ap && this.cropSettings.context === "auto" ? ` (context ${ap.pad} px)` : "")]);
            if (ap) rows.push(["Edge", this.cropSettings.feather === "auto" ? `grow ${ap.grow}, feather ${ap.feather}, blend ${ap.blend} px` : `feather ${this.widgetValue("feather", 0)} px`]);
            const target = this.widgetValue("target_size", 0);
            const m = Math.max(1, this.widgetValue("multiple_of", 64) || 64);
            // the node's batch: the crop, the Original (not on a refine pass, which fills nothing), the references; a
            // local recipe of the app sends only those its graph reads (host.refLayout, 26e)
            const refine = this.genSettings.mode === "local" && !!this.genSettings.refine;
            const shown = this.referenceLayers();
            const lay = host.refTokens ? this.refLayoutInfo : null;
            const sent = lay && lay.names ? shown.filter((l) => lay.names.get(l.id)) : shown;
            const nBatch = 1 + (b && !refine && this.cropSettings.withOriginal && this.cropSettings.fill && this.cropSettings.fill !== "none" ? 1 : 0) + (lay && lay.local && lay.names ? sent.length : shown.length);
            const pair = nBatch > 1 ? ` ×${nBatch} (batch)` : "";
            if (target > 0) {
                const s = target / Math.max(cw, ch);
                const ew = Math.max(m, Math.round(cw * s / m) * m), eh = Math.max(m, Math.round(ch * s / m) * m);
                const distort = Math.abs((ew / eh) / (cw / ch) - 1) * 100;
                const warn = distort >= 1.5 ? ` · aspect ${distort.toFixed(1)} % off, stretched back on stitch` : "";
                rows.push(["Emitted", `${ew} × ${eh}${pair}${warn}`]);
                rows.push(["Paste", this.cropSettings.paste === "crop" ? "whole crop" : "selection only"]);
            } else {
                rows.push(["Emitted", `${Math.min(this.width, Math.ceil(cw / m) * m)} × ${Math.min(this.height, Math.ceil(ch / m) * m)}${pair}`]);
            }
            const ctrl = this.layers.filter((l) => this.isControl(l) && this.shown(l)).length;
            rows.push(["Control", ctrl ? `${ctrl} layer${ctrl > 1 ? "s" : ""}` : "none (black)"]);
            const refs = shown.length;
            // a route that sends the references as style references (Magnific's Ideogram) or in a list of their own
            // (Ideogram 4.5) gives them no number: they go, unnamed
            if (lay && lay.style && refs && !lay.none) rows.push(["References", `${refs} image${refs > 1 ? "s" : ""} without a number (style or unnumbered references)`]);
            else if (lay && lay.names && refs && !lay.none) {
                // the app: what each shown reference goes as ("img1 → <image3>"), what is left out, and a guessed wording
                const labels = this.refLabels();
                const arrows = sent.map((l) => `img${labels.get(l.id)} → ${lay.names.get(l.id)}`);
                const left = shown.filter((l) => !lay.names.get(l.id)).map((l) => `img${labels.get(l.id)}`);
                rows.push(["References", (arrows.length ? arrows.join(", ") + (lay.local ? ` (${this.refSettings.fit})` : "") : "none sent")
                    + (left.length ? ` · ${left.join(", ")} not sent` : "") + (lay.guess ? " · wording guessed from the graph" : "")]);
            } else if (lay && lay.none && refs) rows.push(["References", `none sent: ${lay.none}`]);
            else rows.push(["References", refs ? `${refs} image${refs > 1 ? "s" : ""} in crop_image (${this.refSettings.fit})` : "none"]);
            const rs = this.resultInputState();
            rows.push(["Result", `${this.genSettings.mode} → ${rs.name}${rs.wired ? (rs.fallback ? " (only input wired)" : "") : " (not wired!)"}` + (this.genSettings.mode === "local" && this.genSettings.refine ? " · refine" : "")]);
        }
        // as text: a name such as "<image3>" is no tag
        this.infoEl.replaceChildren(...rows.flatMap(([k, v]) => {
            const key = document.createElement("span"), val = document.createElement("b");
            key.textContent = k; val.textContent = v;
            return [key, val];
        }));
        if (this.canvasInfo) this.canvasInfo.textContent = this.frameInfoText();
    }
}

export function bindExport(C) { InpaintEditor = C; }
