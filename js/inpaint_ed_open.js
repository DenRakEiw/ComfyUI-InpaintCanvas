// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_open.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the base picture and file loading (PSD, ORA, TIFF, SVG): moved out of inpaint_canvas.js (item 56 S9, docs/PLAN_SPLIT.md), text unchanged.

import { route as kernelRoute } from "./px/kernels.js";
import { LayerPixels, MaskPixels, pixelsOptions } from "./inpaint_pixels.js";
import { CancelledError } from "./inpaint_pool.js";
import { pngHeader } from "./inpaint_png.js";
import { TIFF_EXT, tiffInfo } from "./inpaint_tiff.js";
import { CANVAS_MAX_PIXELS } from "./inpaint_tiles.js";
import { editorPool, markStep } from "./inpaint_jobs.js";
import { partsUsable } from "./inpaint_encode.js";
import { uploadBlob, uploadPixels } from "./inpaint_upload.js";
import { inflateAtMost, readOraBlob, readPsd } from "./inpaint_layered.js";
import { normalBlend } from "./blend_modes.js";
import { failKind, refusal } from "./inpaint_status.js";
import { PSD_WINDOW } from "./inpaint_consts.js";
import { HUGE_MAX_PIXELS, HUGE_MAX_SIDE, hugePngSize, imageFileSize, imageOfBlob, isSvgFile, isTiffFile, layeredKind, layeredStem, loadImageEl, pixelsFromPngStream, pixelsFromTiff, pixelsOffThread, pngIsPlainSrgb, pngReaderUsable, psdOnPool, rasterizeSvg, storedExt, svgSize, viewUrl } from "./inpaint_load.js";

let InpaintEditor = null;

export class OpenPart {
    // ---- layers: management ------------------------------------------------

    /**
     * A new base from a file in the mirror (`ref`), all else dropped: a large one decoded off the window on tiles.
     * Another picture is not the canvas a preset was made for: Generate new's preset (`genSettings.target`, item 34)
     * goes with the old one, as in loadFile (Generate new's own base, setBaseFromCanvas, keeps it: the run writes it).
     */
    async setBaseFromRef(ref) {
        const before = this.base;
        try {
            if (TIFF_EXT.test(ref.filename || "")) {
                const blob = await (await fetch(viewUrl(ref))).blob();
                if (await isTiffFile(blob)) {
                    const info = await tiffInfo(blob);
                    this.checkBaseSize(info.width, info.height);
                    const { px } = await pixelsFromTiff(blob, this.pixels.Layer);
                    const up = await uploadPixels(px, String(ref.filename).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image");
                    return await this.setBasePixels(up.ref, px, { keepLayers: false });
                }
            }
            if (this.tileMode) {
                const blob = await (await fetch(viewUrl(ref))).blob();
                const big = (await hugePngSize(blob)) || (await imageFileSize(blob));
                if (big) this.checkBaseSize(big.width, big.height);
                const px = big ? await pixelsOffThread(blob, this.pixels.Layer) : null;
                if (px) return await this.setBasePixels(ref, px, { keepLayers: false });
                return await this.setBase(ref, await imageOfBlob(blob), { keepLayers: false });
            }
            return await this.setBase(ref, await loadImageEl(viewUrl(ref)), { keepLayers: false });
        } finally {
            if (this.base !== before && this.genSettings && this.genSettings.target) { delete this.genSettings.target; this.notifyChanged(); }
        }
    }

    /** A new base from an <img> (or a canvas with `naturalWidth` / `naturalHeight`): its pixels are made here, the image is not kept. */
    async setBase(ref, img, opts = {}) {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        this.checkBaseSize(w, h);   // before the decode
        return this.setBasePixels(ref, this.pixels.Layer.fromImage(img, w, h), opts);
    }

    // On tiles an image above Chromium's canvas limit decodes into tiles, but nothing in C2 can show, export
    // or save it (the display mirror, toCanvas and the selection's PNG need one canvas of it), and the first
    // autosave stored the tab as "{}" (C2's final review). Refused before anything changes; C3 draws tiles and
    // E streams exports, which lift it. The canvas backend is left as it was.
    checkBaseSize(w, h) {
        if (!this.tileMode) return;
        // E5: above the canvas limit of 268 MP a document lives on tiles only. What still bounds it: a band of it is a
        // canvas (65,535 px a side), and its base alone is 4 bytes a pixel of memory (4 GB at a gigapixel).
        if (w > HUGE_MAX_SIDE || h > HUGE_MAX_SIDE || w * h > HUGE_MAX_PIXELS) {
            throw new Error(`${w} × ${h} px is above what a document can hold (${HUGE_MAX_SIDE.toLocaleString()} px a side, ${Math.round(HUGE_MAX_PIXELS / 1e6)} MP)`);
        }
        if (w * h > CANVAS_MAX_PIXELS && !partsUsable()) {
            throw new Error(`${w} × ${h} px is above the canvas limit of 268 MP, and a document that large needs the worker pool and the compiled pixel kernels, which are not available here`);
        }
    }

    /** Is this document larger than any canvas (268 MP)? Then nothing may ask for a canvas, a bitmap or an ImageData of it. */
    get huge() { return this.width * this.height > CANVAS_MAX_PIXELS; }

    /**
     * A new base from pixels the caller made for it (and does not write again); `ref` is their file in the mirror.
     * `keep`: layers that stay when the others go (Generate new's reference layers, 26f): kept as they are, and on a size
     * change placed again the way a new reference is (referenceBox), their masks, opacity and visibility unchanged.
     */
    async setBasePixels(ref, px, { keepLayers = true, keep = null } = {}) {
        this._blankBase = false;   // the new-canvas path sets it again after this call (the Generate new question, issue #12)
        // the app's Each area (eacharea.js): its areas were cut from the picture there is now
        if (this._eachArea) throw refusal("Each area is running on this document: a new picture waits until it is done, or stop it.");
        this.checkBaseSize(px.width, px.height);
        const sizeChanged = px.width !== this.width || px.height !== this.height;
        this.historyGen++;   // a restore still loading must not put the old document over the new image
        this.endLiquify();
        this.liqFreezes = null;
        this.base = { ref, px };
        this.width = px.width;
        this.height = px.height;
        this._rangeTint = null;
        this.mapView = null;
        this.maskView = null;
        this._pendingPick = null;
        this._pendingPickTarget = null;
        if (this.depthViewBtn) this.depthViewBtn.classList.remove("ipc-toggle-on");
        // the history goes with the layers: a step of the old document applied to a new image put
        // its layers (or its base, for a crop) back on top of it
        if (!keepLayers || sizeChanged) {
            // the kept layers are in the list before the detached release below looks for live pixels
            this.layers = keep ? keep.slice() : [];
            if (keep && sizeChanged) this.layers.forEach((l, k) => { if (l.px) Object.assign(l, this.referenceBox(l.px, k)); });
            this.activeLayerId = null;
            this.clearUndo();
            // the ids and the order of kept references are unchanged: the labels stay, nothing is rewritten
            this.refsRebuilt();
        }
        if (!keepLayers) this.clearSnapshots();   // a new picture is a new document: the snapshots were of the old one
        if (!this.sel || sizeChanged) {
            this.sel = this.pixels.Mask.empty(this.width, this.height);
            this.clearUndo();
        }
        this.uploaded.baseHash = null;
        this.uploaded.baseRef = null;
        this.uploaded.controlHash = null;
        this.dropHint.style.display = "none";
        this.selectionDirty = true; this.selectionLoose = false;
        this.selectionDataUrl = null;
        this.selectionEncoded = false;
        this.scheduleDetachedRelease();   // the old layers' atlas pages go (C6 a); the old base's, the base setter queues
        this.flatCache = null;
        this.sceneSig = null;
        this.touchSource(this.sel);
        this.renderLayers();
        this.renderInfo();
        this.fitView();
        this.drawThumb();
        this.setStatus(`${this.width} × ${this.height}`);
        this.notifyChanged();
    }

    async loadFile(file, { size = null, ask = true } = {}) {
        if (!file) return;
        // an open that is still decoding (a large file in a worker takes seconds, the window stays usable) must not land
        // over a later one: the last file asked for is the base
        const token = (this._openToken = (this._openToken || 0) + 1);
        // a closed tab's open is over too: its read stops at its next band and nothing reaches the local store
        const later = () => this._destroyed || this._openToken !== token;
        const before = this.base;
        try {
            const layered = await layeredKind(file);
            if (layered) { await this.loadLayered(file, layered, later); return; }
            if (await isTiffFile(file)) { await this.loadTiff(file, later); return; }
            if (isSvgFile(file)) {
                const target = await this.svgTarget(file, { size, ask });
                if (!target) { this.setStatus("Import cancelled."); return; }
                this.setStatus(`Rasterising ${file.name || "the SVG"} at ${target.width} × ${target.height} ...`);
                file = await rasterizeSvg(file, target);
            }
            const ext = await storedExt(file);
            // E5: a PNG larger than any canvas is decoded as a stream into tiles (the browser's decoder has nowhere to put
            // it); any other large file is decoded in a pool worker, so the window never holds the whole picture
            const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;
            if (big) this.checkBaseSize(big.width, big.height);
            if (later()) return;
            this.setStatus("Uploading " + (file.name || "image") + " ...");
            const stem = (file.name || "pasted").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
            const up = uploadBlob(file, stem + ext, { overwrite: false });
            up.catch(() => {});
            let px = null, ref = null;
            try {
                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });
                if (later()) { if (px) px.release(); return; }
                if (px) this.setStatus("Uploading " + (file.name || "image") + " ...");
                ref = await up;
            } catch (err) {
                if (px) px.release();
                throw err;
            }
            if (later()) { if (px) px.release(); return; }
            if (px) {
                await this.setBasePixels(ref, px, { keepLayers: false });
                return;
            }
            const img = await loadImageEl(viewUrl(ref));
            if (later()) return;
            await this.setBase(ref, img, { keepLayers: false });
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err), failKind(err));
        } finally {
            // another picture (open, drag and drop, paste, load_image) is not the canvas a preset was made for: Generate
            // new's preset (`genSettings.target`, item 34) goes with the old one, even at the same size
            if (this.base !== before && this.genSettings && this.genSettings.target) { delete this.genSettings.target; this.notifyChanged(); }
        }
    }

    /**
     * Open a TIFF (inpaint_tiff.js, docs/PLAN_0_1_29.md 3d). The header first, so a file that is not read, or is too
     * large, is refused before anything is stored; then the pixels as a stream. The base goes to the local store as a
     * PNG, so the autosave, a document and ComfyUI never see the TIFF.
     */
    async loadTiff(file, later = () => false) {
        const start = markStep("tiff_open", "start");   // its w and h once the header is read
        const name = file.name || "the TIFF";
        const info = await tiffInfo(file);
        start.w = info.width; start.h = info.height;
        this.checkBaseSize(info.width, info.height);
        markStep("tiff_open", "info");
        if (later()) return;
        let px = null, got = null, writeMs = 0;
        try {
            ({ px, info: got, writeMs } = await pixelsFromTiff(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${info.width} × ${info.height} px ... ${Math.round(f * 100)} %`); }, later));
        } catch (err) {
            if (later()) return;
            throw err;
        }
        markStep("tiff_open", "pixels", { writeMs });
        if (later()) { px.release(); return; }
        const stem = (file.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
        this.setStatus(`Storing ${name} ...`);
        const { ref } = await uploadPixels(px, stem);
        markStep("tiff_open", "stored");
        if (later()) { px.release(); return; }
        await this.setBasePixels(ref, px, { keepLayers: false });
        markStep("tiff_open", "base");
        const notes = ((got && got.notes) || info.notes || []).filter(Boolean);
        this.setStatus(`Opened ${name}: ${info.width} × ${info.height}${notes.length ? "; " + notes.join("; ") : ""}.`, notes.length ? "warn" : "info");
    }

    /**
     * A PSD or ORA file read into pixels (inpaint_layered.js): `{ width, height, layers, composite, notes }`, each
     * layer with `px` (this backend's pixels) in place of its bytes, bottom first. `later()` true: the open is over (a
     * later one, a closed tab), and a PSD read in a worker stops at its next band (a CancelledError).
     */
    async readLayered(file, kind, later = () => false) {
        markStep("layered_open", "start", { kind });
        this.setStatus(`Reading the layers of ${file.name || "the file"} ...`);
        if (kind === "psd" && psdOnPool(file)) {
            const got = await this.readPsdOnPool(file, later);
            if (got) {
                const t = got.timing || {};
                markStep("layered_open", "parsed", { route: "pool", inflateMs: t.inflate || 0, inflates: t.inflates || 0 });
                markStep("layered_open", "layers", { maskMs: got.maskMs, rgbaMs: got.rgbaMs, bitmapMs: 0, fromImageMs: 0 });
                return got.doc;
            }
        }
        // an ORA stays the file (K20c, readOraBlob): its directory, stack.xml and each layer's header are read as slices
        const bytes = kind === "psd" ? new Uint8Array(await file.arrayBuffer()) : null;
        markStep("layered_open", "read", { MB: bytes ? bytes.length / 1048576 : 0 });
        // the K0a harness: the inflates' time (they run one after another), and the layer loop's parts below
        let inflateMs = 0, inflates = 0, maskMs = 0, rgbaMs = 0, t0 = 0;
        const spent = { streamMs: 0, bitmapMs: 0, fromImageMs: 0 };
        // each inflate stops at the bytes the reader keeps (inpaint_layered.js inflateAtMost, the pool's inflater too)
        const timed = async (b, format, cap) => {
            const t = performance.now();
            try { return await inflateAtMost(b, format, cap); } finally { inflateMs += performance.now() - t; inflates++; }
        };
        // the size is checked from the header before anything else is read or made (H1 S5), as the pool route does
        const onHeader = (h) => this.checkLayeredSize(h.width, h.height);
        const doc = kind === "psd" ? await readPsd(bytes, { inflate: (b, cap) => timed(b, "deflate", cap), onHeader })
            : await readOraBlob(file, { inflateRaw: (b, cap) => timed(b, "deflate-raw", cap), onHeader });
        markStep("layered_open", "parsed", { inflateMs, inflates });
        this.checkLayeredSize(doc.width, doc.height);
        // the bottom layer's PNG, kept for loadLayered's base upload (oraBaseUpload): the decode below lets go of L.pngBlob
        if (kind === "ora") doc.basePng = (doc.layers[0] && doc.layers[0].pngBlob) || null;
        try {
            for (let i = 0; i < doc.layers.length; i++) {
                const L = doc.layers[i];
                if (later()) throw new CancelledError("layered_open");
                // a PSD mask (docs/PLAN_0_1_31.md 3e): one value per pixel of the layer, as the mask's alpha
                if (L.mask && L.mask.data) {
                    t0 = performance.now();
                    const m = new ImageData(L.w, L.h), d = m.data, v = L.mask.data;
                    for (let j = 0, o = 0; j < v.length; j++, o += 4) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = v[j]; }
                    L.maskPx = this.pixels.Mask.fromImageData(m);
                    L.maskOff = !!L.mask.disabled;
                    maskMs += performance.now() - t0;
                }
                L.mask = null;
                if (L.rgba) {
                    t0 = performance.now();
                    L.px = this.pixels.Layer.fromImageData(new ImageData(L.rgba, L.w, L.h)); L.rgba = null;
                    rgbaMs += performance.now() - t0;
                    continue;
                }
                this.setStatus(`Reading the layers of ${file.name || "the file"} ... layer ${i + 1} of ${doc.layers.length}`);
                await this.decodeOraLayer(L, spent);
                if (later()) throw new CancelledError("layered_open");
            }
        } catch (err) {
            // nothing of a read that ends here is kept: the layers decoded so far hold tiles
            for (const x of doc.layers) {
                if (x.px) { x.px.release(); x.px = null; }
                if (x.maskPx) { x.maskPx.release(); x.maskPx = null; }
            }
            throw err;
        }
        markStep("layered_open", "layers", { maskMs, rgbaMs, ...spent });
        return doc;
    }

    /**
     * K20c: one ORA layer's PNG (`L.pngBlob`) into `L.px`, `L.w`, `L.h`. On tiles a PNG of 8 bits, not interlaced, is
     * decoded by the pool (`pixelsFromPngStream`), so the window neither decodes it nor reads a canvas back. Everything
     * else goes through the browser's decoder, and so does a stream that fails: that decoder says last whether a file
     * is damaged, except for a parted PNG the pool refused twice and for one larger than any canvas.
     * `InpaintEditor.oraParted = false` keeps every layer on the browser's decoder.
     */
    async decodeOraLayer(L, spent) {
        const blob = L.pngBlob;
        if (this.tileMode && InpaintEditor.oraParted !== false && pngReaderUsable()) {
            const h = pngHeader(new Uint8Array(await blob.slice(0, 33).arrayBuffer()));
            if (h && h.bitDepth === 8 && !h.interlace) {
                const t0 = performance.now();
                try {
                    const px = await pixelsFromPngStream(blob, this.pixels.Layer);
                    L.px = px; L.w = px.width; L.h = px.height; L.pngBlob = null;
                    return;
                } catch (err) {
                    if ((err && err.partedRefused) || h.width * h.height > CANVAS_MAX_PIXELS) throw err;
                    console.warn("Inpaint Canvas: an ORA layer could not be read as a stream, using the image decoder:", (err && err.message) || err);
                } finally { spent.streamMs += performance.now() - t0; }
            }
        }
        let t0 = performance.now();
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        spent.bitmapMs += performance.now() - t0;
        L.w = bmp.width; L.h = bmp.height;
        t0 = performance.now();
        try { L.px = this.pixels.Layer.fromImage(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
        spent.fromImageMs += performance.now() - t0;
        L.pngBlob = null;
    }

    /**
     * K20c, the design's question 3: an ORA's bottom layer that became the base goes up as its own PNG, in place of a
     * new PNG encoded from `basePx`. Only a PNG the decoders read alike and a plain sRGB one (8 bits, not interlaced, no
     * colour chunk, the picture's size). `loadLayered` asks for it after the layers were read and the open is still
     * wanted (the review of 2026-11-11: never on an ORA dropped into a document, never for an open that ended early), so
     * nothing lands in the local store for an open that is over. The ref, or null and `loadLayered` encodes as before
     * (also when this upload fails). `InpaintEditor.oraParted = false` encodes too.
     */
    async oraBaseUpload(doc, file) {
        const b = doc.layers[0];
        const png = doc.basePng;
        if (!b || !png || InpaintEditor.oraParted === false) return null;
        if (!(b.x === 0 && b.y === 0 && b.visible && b.opacity >= 0.999 && b.blend === "normal")) return null;
        const h = pngHeader(new Uint8Array(await png.slice(0, 33).arrayBuffer()));
        if (!h || h.bitDepth !== 8 || h.interlace || h.width !== doc.width || h.height !== doc.height) return null;
        if (!(await pngIsPlainSrgb(png))) return null;
        try { return await uploadBlob(png, layeredStem(file) + ".png", { overwrite: false }); } catch (err) {
            console.warn("[Inpaint Canvas] the ORA's base PNG did not upload as it is; encoding it instead:", err);
            return null;
        }
    }

    /** A layered file's size against what this document can open: the document's bounds, then the canvas limit. */
    checkLayeredSize(w, h) {
        this.checkBaseSize(w, h);
        if (w * h > CANVAS_MAX_PIXELS) throw new Error(`${w} × ${h} px is larger than a layered file can be opened at (268 MP); save it as PNG`);
    }

    /**
     * D0 (docs/PLAN_WASM_BUILD.md §7): a PSD read by a pool worker (`psd_read`, inpaint_layered.js `readPsdStream`), its
     * layers and masks written into this backend's pixels band by band as they arrive, so the window never runs the
     * reader's loops and makes no array of the file. `{ doc, rgbaMs, maskMs, timing }`, `doc` as readLayered answers
     * it (each layer with `px`, a masked one with `maskPx` and `maskOff`; a file without layers with `compositePx`, the
     * merged picture, which is read only then), or null when the pool could not take the job before any band came: the
     * caller reads the file on this thread. The size is checked here from the header's 26 bytes before the job is
     * queued, so a file too large costs no worker and no read; a file the reader refuses throws its message as the
     * window's reader would; `later()` true stops the job at its next band (a CancelledError, the worker counted as
     * stopped, not lost). Paced (K20b review): the worker has at most `PSD_WINDOW` bands (the route `psdWindow`; 0 =
     * unpaced) posted and not yet acknowledged here after their `writeRect`.
     */
    async readPsdOnPool(file, later = () => false) {
        const head = new Uint8Array(await file.slice(0, 26).arrayBuffer());
        if (head.length >= 26) {
            // the reader's order of checks: signature and version, mode, depth, then the size (a refusal of the first
            // three is the worker's, in the reader's own words)
            const v = new DataView(head.buffer, head.byteOffset, head.length);
            const mode = v.getUint16(24), depth = v.getUint16(22);
            if (v.getUint32(0) === 0x38425053 && v.getUint16(4) === 1 && (mode === 3 || mode === 1) && (depth === 8 || depth === 16)) this.checkLayeredSize(v.getUint32(18), v.getUint32(14));
        }
        if (later()) throw new CancelledError("psd_read");
        const Layer = this.pixels.Layer, Mask = this.pixels.Mask;
        const made = new Map();   // stream index -> { px, maskPx }
        const name = file.name || "the file";
        let refused = null, stopped = false, bands = 0, rgbaMs = 0, maskMs = 0;
        const drop = () => { for (const e of made.values()) for (const p of [e.px, e.maskPx]) if (p) p.release(); made.clear(); };
        let r;
        // the acknowledgement window (inpaint_worker.js psdRead): each band acknowledged after its writeRect, so the
        // worker never has more than `win` bands queued ahead of this window's other tasks (timers, input, paint)
        const routedWin = kernelRoute("psdWindow"), win = routedWin === undefined ? PSD_WINDOW : routedWin;
        let pool = null;
        try {
            pool = editorPool();
            // "fail": a harness's way to see the fallback (an op no worker knows)
            r = await pool.run(InpaintEditor.psdOnPool === "fail" ? "psd_read_refused" : "psd_read", { blob: file, window: win }, [], {
                timeout: 600000,
                onProgress: (m) => {
                    if (later()) { stopped = true; throw new CancelledError("psd_read"); }
                    try {
                        const t0 = performance.now();
                        let e = made.get(m.index);
                        if (!e) made.set(m.index, (e = { px: null, maskPx: null }));
                        const key = m.mask ? "maskPx" : "px";
                        if (!e[key]) e[key] = (m.mask ? Mask : Layer).empty(m.w, m.h);
                        e[key].writeRect({ data: new Uint8ClampedArray(m.rgba), width: m.w, height: m.rows }, 0, m.y0);
                        if (m.mask) maskMs += performance.now() - t0; else rgbaMs += performance.now() - t0;
                        bands++;
                        if (win) pool.ack(m.id, bands);
                        if (!m.mask) this.setStatus(`Reading the layers of ${name} ... layer ${made.size}, ${Math.round(((m.y0 + m.rows) / m.h) * 100)} %`);
                    } catch (err) { refused = err; throw err; }
                },
            });
        } catch (err) {
            drop();
            if (stopped) throw new CancelledError("psd_read");
            if (refused) throw refused;
            // the job could not run (no pool, an op no worker knows): the window's reader. A worker lost after bands
            // came (most likely out of memory at this size) is not read again here, which needs more memory still
            if (bands) throw new Error(`reading ${name} failed in its worker: ${(err && err.message) || err}`);
            console.warn("Inpaint Canvas: reading the PSD in a worker failed, reading it here:", (err && err.message) || err);
            return null;
        }
        if (r && r.failed) { drop(); throw new Error(r.failed); }
        if (!r || !r.doc) { drop(); throw new Error(`reading ${name} failed in its worker: no answer`); }
        const doc = r.doc, taken = [];
        const take = (i, what) => {
            const e = made.get(i);
            if (!e || !e.px) throw new Error(`the PSD worker sent no pixels for ${what}`);
            made.delete(i);
            taken.push(e);
            return e;
        };
        try {
            for (const L of doc.layers) {
                const e = take(L.index, `layer "${L.name}"`);
                L.px = e.px;
                if (L.mask) {
                    if (!e.maskPx) throw new Error(`the PSD worker sent no mask for layer "${L.name}"`);
                    L.maskPx = e.maskPx;
                    L.maskOff = !!L.mask.disabled;
                } else if (e.maskPx) { e.maskPx.release(); e.maskPx = null; }
                L.mask = null;
                delete L.index;
            }
            if (doc.composite != null) doc.compositePx = take(doc.composite, "the merged picture").px;
            doc.composite = null;
        } catch (err) {
            for (const e of taken) for (const p of [e.px, e.maskPx]) if (p) p.release();
            drop();
            throw err;
        }
        drop();   // bands the answer names no layer for
        return { doc, rgbaMs, maskMs, timing: r.timing || null };
    }

    /**
     * Open a PSD or ORA with its layers. The bottom layer becomes the base when it covers the whole picture, is
     * visible, opaque in the normal mode (what Photoshop's Background and the editor's own export are); otherwise the
     * base is transparent and every layer stays a layer. A flat PSD opens from its merged picture.
     */
    async loadLayered(file, kind, later = () => false) {
        let doc;
        try { doc = await this.readLayered(file, kind, later); } catch (err) { if (later()) return; throw err; }
        // an open that is over (a later one, a closed tab) lets go of what its read made
        const dropDoc = (also = null) => {
            const seen = new Set();
            for (const p of [...doc.layers.flatMap((L) => [L.px, L.maskPx]), doc.compositePx, also]) if (p && !seen.has(p)) { seen.add(p); p.release(); }
        };
        if (later()) { dropDoc(); return; }
        const W = doc.width, H = doc.height;
        const layers = doc.layers.slice();
        let basePx = null;
        const b = layers[0];
        if (b && b.x === 0 && b.y === 0 && b.w === W && b.h === H && b.visible && b.opacity >= 0.999 && b.blend === "normal" && !b.maskPx) { basePx = b.px; layers.shift(); }
        // a layer clipped to what became the base would show "clipped without effect": the base covers the picture anyway
        if (basePx) for (const L of layers) { if (!L.clip) break; L.clip = false; }
        else if (!layers.length && doc.compositePx) basePx = doc.compositePx;   // D0's pool route: already pixels
        else if (!layers.length && doc.composite) basePx = this.pixels.Layer.fromImageData(new ImageData(doc.composite, W, H));
        else basePx = this.pixels.Layer.empty(W, H);
        if (doc.compositePx && basePx !== doc.compositePx) { doc.compositePx.release(); doc.compositePx = null; }
        this.setStatus(`Storing ${file.name || "the file"} ...`);
        const raw = kind === "ora" && basePx === b?.px ? await this.oraBaseUpload(doc, file) : null;
        const ref = raw || (await uploadPixels(basePx, layeredStem(file))).ref;
        markStep("layered_open", "stored");
        if (later()) { dropDoc(basePx); return; }
        await this.setBasePixels(ref, basePx, { keepLayers: false });
        markStep("layered_open", "base");
        let top = null;
        // PSD groups as folders (PLAN_0_1_31 §6.5), with ids of this document
        this.groupCounter = (this.groupCounter || 0) + 1;
        const gid = new Map((doc.groups || []).map((g, i) => [g.id, "G" + Date.now().toString(36) + this.groupCounter + "_" + i]));
        this.groups = (doc.groups || []).map((g) => ({ id: gid.get(g.id), name: g.name, visible: g.visible !== false, locked: false, collapsed: !!g.collapsed, parent: g.parent ? gid.get(g.parent) || null : null }));
        this.holdGroups = (this.holdGroups || 0) + 1;   // the groups wait for their layers: addLayer's list would drop them as empty
        try {
            for (const L of layers) top = this.addLayer({ name: L.name, kind: "image", ref: null, group: L.group ? gid.get(L.group) || null : null, px: L.px, x: L.x, y: L.y, w: L.w, h: L.h, opacity: L.opacity, visible: L.visible, blend: normalBlend(L.blend), dirty: true, maskPx: L.maskPx || null, maskOff: !!L.maskOff, maskDirty: !!L.maskPx, clip: !!L.clip }, { activate: false });
        } finally { this.holdGroups--; }
        if (top) this.activeLayerId = top.id;
        this.renderLayers();
        this.draw();
        markStep("layered_open", "added");
        const n = layers.length;
        this.setStatus(`Opened ${file.name || "the file"}: ${W} × ${H}, ${n} layer${n === 1 ? "" : "s"}${basePx === b?.px ? ` over "${b.name}" as the base` : ""}.${doc.notes.length ? " " + doc.notes.join("; ") + "." : ""}`, doc.lossy ? "warn" : "info");
    }

    /** The pixel size an SVG is rasterised at: the caller's `size` ([w, h], one of them may be 0 for
     *  "keep the aspect"), else fitted into `fit` (a document), else the file's own size when it declares
     *  one and 2048 on the long side when it only has a viewBox; the size dialog confirms it when `ask`. */
    async svgTarget(file, { size = null, ask = true, fit = null } = {}) {
        const info = svgSize(await file.text());
        const ratio = info.width / info.height;
        let w, h;
        if (size && size[0] > 0 && size[1] > 0) { w = size[0]; h = size[1]; }
        else if (size && size[0] > 0) { w = size[0]; h = w / ratio; }
        else if (size && size[1] > 0) { h = size[1]; w = h * ratio; }
        else if (fit && fit[0] > 0 && fit[1] > 0) { const k = Math.min(fit[0] / info.width, fit[1] / info.height); w = info.width * k; h = info.height * k; }
        else if (info.declared && info.width <= 16384 && info.height <= 16384) { w = info.width; h = info.height; }
        else { const k = 2048 / Math.max(info.width, info.height); w = info.width * k; h = info.height * k; }
        w = Math.min(16384, Math.max(1, Math.round(w))); h = Math.min(16384, Math.max(1, Math.round(h)));
        if (ask && !size && !fit) {
            const answer = await this.ask({
                title: "Import SVG",
                message: `${file.name || "The file"} is a vector drawing and has no pixel size of its own. Rasterise it at:`,
                fields: [{ key: "width", label: "Width", value: w, min: 1, max: 16384 }, { key: "height", label: "Height", value: h, min: 1, max: 16384 }],
                linked: "on",
                ok: "Import",
            });
            if (answer == null) return null;
            w = Math.min(16384, Math.max(1, Math.round(answer.width))); h = Math.min(16384, Math.max(1, Math.round(answer.height)));
        }
        return { width: w, height: h };
    }

    /**
     * `p` as pixels of this editor's backend. The editor makes all of its pixels itself, so only a
     * caller outside it can hand in pixels of the other backend (a test, a plugin that built its own):
     * strict mode (dev builds) throws, so a gate finds the mix; otherwise they are converted once
     * with a warning.
     */
    ownPixels(p) {
        if (!(p instanceof LayerPixels) || p.constructor.backend === this.pixels) return p;
        const msg = `Inpaint Canvas: pixels of the ${this.tileMode ? "canvas" : "tile"} backend handed to an editor on ${this.tileMode ? "tiles" : "canvases"}; make them with editor.pixels`;
        if (pixelsOptions().strict) throw new Error(msg);
        if (!InpaintEditor._mixWarned) { InpaintEditor._mixWarned = true; console.warn(msg + " (converted)"); }
        const B = p instanceof MaskPixels ? this.pixels.Mask : this.pixels.Layer;
        return this.tileMode ? B.fromCanvas(p.toCanvas()) : B.fromImage(p.toCanvas());
    }
}

export function bindOpen(C) { InpaintEditor = C; }
