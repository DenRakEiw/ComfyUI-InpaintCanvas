// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_select.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the selection: combine, select range, SAM logits, rectangle and shape, flood, wand, feather, quick mask, fill / copy / paste, clear and invert: moved out of inpaint_canvas.js (item 56 S5, docs/PLAN_SPLIT.md), text unchanged.

import { bytesSource, clipMaskToSelection, floodMask, growMaskBounds, invertMask, maskBounds, maskToColorCanvas, rectSource, selectionGco, tilesSource } from "./inpaint_raster.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { stackInArena, storeArgs } from "./inpaint_bands.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { TILE_SIZE, isTilePixels } from "./inpaint_tiles.js";
import { editorPool, editorWorker, markStep, workerCall } from "./inpaint_jobs.js";
import { nextPartsSeq } from "./inpaint_encode.js";
import { XF_IDENTITY, xfMul } from "./inpaint_resample.js";
import { RANGE_BAND_ROWS } from "./inpaint_depth.js";
import { passToMap } from "./inpaint_maps.js";
import { SNAP_DEFAULT, SNAP_TAU, snapField, snapParams } from "./inpaint_edges.js";
import { colourSimilarity, hexToRgb as hexToRgb01, normalizeLimit, opp, rangeRowBookkeeping, rangeTileClass, rangeWeight, u16Bilinear } from "./inpaint_weights.js";
import { FLOOD_COARSE_PX, FLOOD_WHOLE_SHARE, makeCanvas } from "./inpaint_consts.js";
import { orientIsUp, orientMatrix, orientOfXf, validXf, xfIsIdentity } from "./inpaint_orient.js";
import { cachedMapTileStats } from "./inpaint_strokebuf.js";
import { clampRect, loadImageEl } from "./inpaint_load.js";

let InpaintEditor = null;

export class SelectPart {
    /** Combine a W×H region mask (1 = inside) with the selection: replace, add or subtract. */
    applyMaskToSelection(mask, mode = "replace") {
        this.applyShapeToSelection(maskToColorCanvas(mask, this.width, this.height, "#ff0000"), mode);
    }

    /**
     * Combine an arbitrary alpha source (rectSource, bytesSource, tilesSource) into the selection.
     */
    combineSelection(src, mode = "replace", { label = "Selection", box = src.box } = {}) {
        const hint = box ? this.boundsAfter(mode, box) : undefined;
        this.pushUndo({ kind: "selection", label });
        if (mode === "replace") this.selectionLabel = "";
        const old = (mode === "replace" || mode === "intersect") ? this.getBounds() : null;
        this.sel.combine(src, mode);
        const rect = box || [0, 0, this.width, this.height];
        const touched = old ? [Math.min(old[0], rect[0]), Math.min(old[1], rect[1]), Math.max(old[2], rect[2]), Math.max(old[3], rect[3])] : rect;
        this.markSelectionChanged(hint, touched);
        this.draw();
    }

    /**
     * Select by range (depth, luma or color) using the banded combine rule.
     * @param {object} limitIn - Limit parameters (source, lo, hi, fLo, fHi, invert, color, tol)
     * @param {string} [mode="replace"] - Selection mode ("replace", "add", "subtract", "intersect")
     * @param {object} [opts={}]
     * @returns {Promise<{ bounds: number[] | null, seconds: number, tiles: number }>}
     */
    async selectRange(limitIn, mode = "replace", { label = "Select by range" } = {}) {
        const limit = normalizeLimit(limitIn);
        if (!limit) throw new Error("invalid limit descriptor");
        if (limit.source === "depth" && (!this.maps || !this.maps.depth)) {
            throw new Error("no depth map: compute it first (Selection › Depth)");
        }
        if (this.rangePending) throw new Error("range selection in progress");

        const t0 = performance.now();
        const W = this.width, H = this.height;
        if (W <= 0 || H <= 0) return { bounds: null, seconds: 0, ms: 0, tiles: 0 };
        // the K0b harness (docs/PLAN_WASM_BUILD.md §4.8): the steps of the run as marks; `snap` once the depth branch has read it
        const start = markStep("range", "start", { source: limit.source, mode, snap: false });
        // a run cancelled on the way (an undo, a new picture, the panel's Cancel) gets its end mark too
        const cancelled = () => {
            markStep("range", "done", { cancelled: true, ms: Math.round((performance.now() - t0) * 10) / 10 });
            return { bounds: null, seconds: 0, ms: 0, tiles: 0 };
        };
        let readMs = 0, loopMs = 0, combineMs = 0, t1 = 0;

        const seq = nextPartsSeq();
        const group = "range" + seq;

        const oldBounds = (mode === "replace" || mode === "intersect" || mode === "subtract") ? this.getBounds() : null;
        const snap = this.snapshot({ kind: "selection", label });
        this.pushUndoSnapshot(snap);
        if (mode === "replace") {
            this.selectionLabel = "";
            this.sel.clear();
        }

        const pendingRecord = { group, seq, snap, limit, mode };
        this.rangePending = pendingRecord;

        // rangeWeight already honours limit.invert; the job inverts once more only for intersect, which
        // subtracts the complement (the same rule as the logit path below).
        const jobInvert = (mode === "intersect");
        const bandMode = (mode === "replace") ? "add" : ((mode === "intersect") ? "subtract" : mode);

        let unionBounds = null;
        let totalTiles = 0;
        let totalAlpha = 0;
        let held = null;

        try {
            if (this.tileMode && !editorPool().off) {
                // Tiles backend: pool jobs over bands
                if (limit.source === "depth") {
                    const map = this.maps.depth;
                    const m = passToMap(map, 1);
                    const strength = (map.meta?.snap?.strength != null) ? map.meta.snap.strength : SNAP_DEFAULT;
                    const snap = (map.guide && strength > 0) ? snapParams(strength) : null;
                    const sigmaR = snap ? snap[0] : 0;
                    const tau = snap ? snap[1] : SNAP_TAU;
                    start.snap = !!snap;

                    const snapOn = !!(sigmaR > 0 && map.guide);
                    const stats = cachedMapTileStats(map, m, W, H, snapOn, tau);
                    markStep("range", "edges");

                    const tileCols = Math.ceil(W / 256);
                    const tileRows = Math.ceil(H / 256);
                    let pictureTiles = 0;
                    let postedJobs = 0;

                    const guideMsg = snapOn ? {
                        sab: (typeof SharedArrayBuffer !== "undefined" && map.guide.buffer instanceof SharedArrayBuffer) ? map.guide.buffer : null,
                        data: (typeof SharedArrayBuffer !== "undefined" && map.guide.buffer instanceof SharedArrayBuffer) ? null : map.guide,
                        w: map.w,
                        h: map.h,
                    } : null;

                    const mapMsg = {
                        w: map.w,
                        h: map.h,
                        data: map.data,
                        m,
                    };

                    let scratchCanvas = null;
                    let scratchCtx = null;
                    const bandPromises = [];

                    try {
                        for (let ty = 0; ty < tileRows; ty++) {
                            if (this.rangePending !== pendingRecord) break;
                            const y0 = ty * 256;
                            const y1 = Math.min(y0 + 256, H);
                            const bh = y1 - y0;

                            const rowOffset = ty * tileCols;
                            const rowClasses = new Uint8Array(tileCols);
                            let hasCompute = false;
                            let oMin = -1, oMax = -1;
                            for (let tx = 0; tx < tileCols; tx++) {
                                const idx = rowOffset + tx;
                                if (snapOn && stats.edge[idx] === 1) {
                                    if (oMin === -1) oMin = tx;
                                    oMax = tx;
                                }
                                const cls = rangeTileClass(stats.min[idx] / 65535, stats.max[idx] / 65535, limit, jobInvert);
                                if (cls === "full") {
                                    rowClasses[tx] = 1;
                                } else if (cls === "compute") {
                                    rowClasses[tx] = 2;
                                    hasCompute = true;
                                }
                            }
                            let minTx = -1, maxTx = -1;
                            if (oMin !== -1) {
                                for (let tx = oMin; tx <= oMax; tx++) {
                                    if (rowClasses[tx] === 2) {
                                        if (minTx === -1) minTx = tx;
                                        maxTx = tx;
                                    }
                                }
                            }

                            if (!hasCompute) {
                                bandPromises.push(Promise.resolve({ y0, y1, res: rangeRowBookkeeping(W, H, ty, rowClasses, 256) }));
                                continue;
                            }

                            let picture = null;
                            if (minTx !== -1) {
                                t1 = performance.now();
                                pictureTiles += maxTx - minTx + 1;
                                const minX = minTx * 256;
                                const maxX = Math.min(W, (maxTx + 1) * 256);
                                const bw = maxX - minX;
                                const box = [minX, y0, maxX, y1];
                                const regCanvas = await this.sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true });
                                if (this.rangePending !== pendingRecord) break;

                                if (!scratchCanvas) {
                                    scratchCanvas = document.createElement("canvas");
                                    this._rangeScratchCreated = (this._rangeScratchCreated || 0) + 1;
                                    scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true });
                                }
                                if (scratchCanvas.width !== bw || scratchCanvas.height !== bh) {
                                    scratchCanvas.width = bw;
                                    scratchCanvas.height = bh;
                                }
                                scratchCtx.clearRect(0, 0, bw, bh);
                                scratchCtx.drawImage(regCanvas, 0, 0);
                                const imgData = scratchCtx.getImageData(0, 0, bw, bh);

                                let picSab = null;
                                if (typeof SharedArrayBuffer !== "undefined") {
                                    picSab = new SharedArrayBuffer(bw * bh * 4);
                                    new Uint8Array(picSab).set(imgData.data);
                                }
                                picture = picSab ? {
                                    sab: picSab,
                                    x0: minX,
                                    y0,
                                    w: bw,
                                    h: bh,
                                } : {
                                    data: imgData.data,
                                    x0: minX,
                                    y0,
                                    w: bw,
                                    h: bh,
                                };
                                readMs += performance.now() - t1;
                            }

                            const msg = {
                                op: "range_select",
                                W, H, y0, y1,
                                source: limit.source,
                                limit,
                                invert: jobInvert,
                                map: mapMsg,
                                snap: snap ? [sigmaR, tau] : null,
                                guide: guideMsg,
                                picture,
                                classes: rowClasses,
                            };

                            postedJobs++;
                            bandPromises.push(
                                editorPool().run("range_select", msg, [], { priority: INTERACTIVE, group })
                                    .then((res) => ({ y0, y1, res }))
                            );
                        }
                    } finally {
                        if (scratchCanvas) {
                            scratchCanvas.width = 1;
                            scratchCanvas.height = 1;
                            scratchCanvas = null;
                            scratchCtx = null;
                        }
                    }
                    markStep("range", "posted", { readMs, pictureTiles, jobs: postedJobs });

                    for (const p of bandPromises) {
                        const { y0, y1, res } = await p;
                        if (this.rangePending !== pendingRecord) return cancelled();

                        totalAlpha += res.alphaSum || 0;
                        if (res.tiles && res.tiles.length > 0) {
                            totalTiles += res.tiles.length;
                            t1 = performance.now();
                            const src = tilesSource(res.tiles, [0, 0], [0, y0, W, y1]);
                            this.sel.combine(src, bandMode);
                            combineMs += performance.now() - t1;
                        }
                        if (res.bounds) {
                            if (!unionBounds) {
                                unionBounds = [...res.bounds];
                            } else {
                                unionBounds[0] = Math.min(unionBounds[0], res.bounds[0]);
                                unionBounds[1] = Math.min(unionBounds[1], res.bounds[1]);
                                unionBounds[2] = Math.max(unionBounds[2], res.bounds[2]);
                                unionBounds[3] = Math.max(unionBounds[3], res.bounds[3]);
                            }
                        }
                    }
                    markStep("range", "combined", { combineMs });
                } else {
                    // Luma or color source on tiles: hold stack and at most 2 bands in flight
                    try {
                        held = await this.holdRunStack({ forRun: true });
                    } catch (_) {
                        held = null;
                    }
                    markStep("range", "held", { program: !!(held && held.steps) });
                    let bands = 0;

                    const consumeBand = (by0, by1, res) => {
                        totalAlpha += res.alphaSum || 0;
                        if (res.tiles && res.tiles.length > 0) {
                            totalTiles += res.tiles.length;
                            const tc = performance.now();
                            const src = tilesSource(res.tiles, [0, 0], [0, by0, W, by1]);
                            this.sel.combine(src, bandMode);
                            combineMs += performance.now() - tc;
                        }
                        if (res.bounds) {
                            if (!unionBounds) {
                                unionBounds = [...res.bounds];
                            } else {
                                unionBounds[0] = Math.min(unionBounds[0], res.bounds[0]);
                                unionBounds[1] = Math.min(unionBounds[1], res.bounds[1]);
                                unionBounds[2] = Math.max(unionBounds[2], res.bounds[2]);
                                unionBounds[3] = Math.max(unionBounds[3], res.bounds[3]);
                            }
                        }
                    };

                    const runBand = async (y0, y1) => {
                        const bh = y1 - y0;
                        const bandBox = [0, y0, W, y1];
                        const tr = performance.now();   // the band's read, summed over the bands (two run side by side)
                        bands++;
                        let sab = null;
                        let filled = false;
                        if (typeof SharedArrayBuffer !== "undefined") {
                            sab = new SharedArrayBuffer(W * bh * 4);
                        }
                        if (held && sab) {
                            filled = await this.fillBoxFromStack(held, bandBox, sab, { priority: INTERACTIVE, group });
                        }
                        if (!filled) {
                            const boxRes = await this.readBoxBytes(bandBox, { forRun: true, priority: INTERACTIVE, held });
                            if (boxRes && boxRes.data) {
                                if (boxRes.data.buffer instanceof SharedArrayBuffer) {
                                    sab = boxRes.data.buffer;
                                } else {
                                    if (!sab) sab = new SharedArrayBuffer(W * bh * 4);
                                    new Uint8Array(sab).set(new Uint8Array(boxRes.data.buffer, boxRes.data.byteOffset, boxRes.data.byteLength));
                                }
                            }
                        }
                        readMs += performance.now() - tr;
                        const msg = {
                            op: "range_select",
                            W, H, y0, y1,
                            source: limit.source,
                            limit,
                            invert: jobInvert,
                            sab,
                        };
                        const res = await editorPool().run("range_select", msg, [], { priority: INTERACTIVE, group });
                        return { y0, y1, res };
                    };

                    const inFlight = [];
                    for (let y0 = 0; y0 < H; y0 += RANGE_BAND_ROWS) {
                        const y1 = Math.min(y0 + RANGE_BAND_ROWS, H);
                        if (this.rangePending !== pendingRecord) break;
                        inFlight.push(runBand(y0, y1));
                        if (inFlight.length >= 2) {
                            const item = await inFlight.shift();
                            if (this.rangePending !== pendingRecord) break;
                            consumeBand(item.y0, item.y1, item.res);
                        }
                    }
                    while (inFlight.length > 0) {
                        const item = await inFlight.shift();
                        if (this.rangePending !== pendingRecord) break;
                        consumeBand(item.y0, item.y1, item.res);
                    }
                    markStep("range", "combined", { readMs, combineMs, bands });
                }
            } else {
                // Canvas backend (or pool worker off): main-thread loop over bands
                if (limit.source === "depth") {
                    const map = this.maps.depth;
                    const m = passToMap(map, 1);
                    const mapData = map.data;
                    const mapW = map.w, mapH = map.h;
                    const mapObj = { data: mapData, w: mapW, h: mapH };

                    const strength = (map.meta?.snap?.strength != null) ? map.meta.snap.strength : SNAP_DEFAULT;
                    const snap = (map.guide && strength > 0) ? snapParams(strength) : null;
                    const sigmaR = snap ? snap[0] : 0;
                    const tau = snap ? snap[1] : SNAP_TAU;
                    start.snap = !!snap;

                    const snapOn = !!(sigmaR > 0 && map.guide);
                    const stats = cachedMapTileStats(map, m, W, H, snapOn, tau);
                    markStep("range", "edges");

                    const tileCols = Math.ceil(W / 256);
                    const tileRows = Math.ceil(H / 256);

                    let scratchCanvas = null;
                    let scratchCtx = null;

                    try {
                        for (let ty = 0; ty < tileRows; ty++) {
                            if (this.rangePending !== pendingRecord) return cancelled();
                            const y0 = ty * 256;
                            const y1 = Math.min(y0 + 256, H);
                            const bh = y1 - y0;
                            const alpha = new Uint8Array(W * bh);

                            let minTx = -1, maxTx = -1;
                            if (snapOn) {
                                const rowOffset = ty * tileCols;
                                let oMin = -1, oMax = -1;
                                for (let tx = 0; tx < tileCols; tx++) {
                                    if (stats.edge[rowOffset + tx] === 1) {
                                        if (oMin === -1) oMin = tx;
                                        oMax = tx;
                                    }
                                }
                                if (oMin !== -1) {
                                    for (let tx = oMin; tx <= oMax; tx++) {
                                        const idx = rowOffset + tx;
                                        if (rangeTileClass(stats.min[idx] / 65535, stats.max[idx] / 65535, limit, jobInvert) === "compute") {
                                            if (minTx === -1) minTx = tx;
                                            maxTx = tx;
                                        }
                                    }
                                }
                            }

                            let picData = null, picX0 = 0, picX1 = 0, picW = 0;
                            t1 = performance.now();
                            if (minTx !== -1) {
                                picX0 = minTx * 256;
                                picX1 = Math.min(W, (maxTx + 1) * 256);
                                picW = picX1 - picX0;
                                const box = [picX0, y0, picX1, y1];
                                const regCanvas = await this.sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true });
                                if (this.rangePending !== pendingRecord) return cancelled();

                                if (!scratchCanvas) {
                                    scratchCanvas = document.createElement("canvas");
                                    this._rangeScratchCreated = (this._rangeScratchCreated || 0) + 1;
                                    scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true });
                                }
                                if (scratchCanvas.width !== picW || scratchCanvas.height !== bh) {
                                    scratchCanvas.width = picW;
                                    scratchCanvas.height = bh;
                                }
                                scratchCtx.clearRect(0, 0, picW, bh);
                                scratchCtx.drawImage(regCanvas, 0, 0);
                                picData = scratchCtx.getImageData(0, 0, picW, bh).data;
                            }
                            readMs += performance.now() - t1;
                            t1 = performance.now();

                            let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
                            for (let py = 0; py < bh; py++) {
                                const y = y0 + py;
                                const pyOffset = py * W;
                                const pyCentre = y + 0.5;
                                for (let px = 0; px < W; px++) {
                                    const pxCentre = px + 0.5;
                                    const mx = m[0] * pxCentre + m[2] * pyCentre + m[4];
                                    const my = m[1] * pxCentre + m[3] * pyCentre + m[5];
                                    let v;
                                    if (picData && px >= picX0 && px < picX1) {
                                        const pOffset = (py * picW + (px - picX0)) * 4;
                                        const pr = picData[pOffset] / 255;
                                        const pg = picData[pOffset + 1] / 255;
                                        const pb = picData[pOffset + 2] / 255;
                                        v = snapField(mapObj, map.guide, mx, my, pr, pg, pb, sigmaR, tau);
                                    } else {
                                        v = u16Bilinear(mapData, mapW, mapH, mx, my);
                                    }
                                    const w = rangeWeight(v, limit);
                                    const a = Math.round(255 * (jobInvert ? 1 - w : w));
                                    alpha[pyOffset + px] = a;
                                    totalAlpha += a;
                                    if (a > 0) {
                                        if (px < bX0) bX0 = px;
                                        if (px > bX1) bX1 = px;
                                        if (y < bY0) bY0 = y;
                                        if (y > bY1) bY1 = y;
                                    }
                                }
                            }

                            if (Number.isFinite(bX0)) {
                                const bandBounds = [bX0, bY0, bX1 + 1, bY1 + 1];
                                if (!unionBounds) {
                                    unionBounds = [...bandBounds];
                                } else {
                                    unionBounds[0] = Math.min(unionBounds[0], bandBounds[0]);
                                    unionBounds[1] = Math.min(unionBounds[1], bandBounds[1]);
                                    unionBounds[2] = Math.max(unionBounds[2], bandBounds[2]);
                                    unionBounds[3] = Math.max(unionBounds[3], bandBounds[3]);
                                }
                            }
                            loopMs += performance.now() - t1;

                            t1 = performance.now();
                            const src = bytesSource(alpha, 0, y0, W, bh);
                            this.sel.combine(src, bandMode);
                            combineMs += performance.now() - t1;
                            totalTiles += Math.ceil(W / 256) * Math.ceil(bh / 256);
                        }
                    } finally {
                        if (scratchCanvas) {
                            scratchCanvas.width = 1;
                            scratchCanvas.height = 1;
                            scratchCanvas = null;
                            scratchCtx = null;
                        }
                    }
                    markStep("range", "combined", { readMs, loopMs, combineMs });
                } else {
                    const flat = this.flattenToCanvas({ forRun: true });
                    const flatCtx = flat.getContext("2d");
                    markStep("range", "flattened");
                    let colorRef = null, colorTol = 30;
                    if (limit.source === "color") {
                        const rgbRef = hexToRgb01(limit.color || "#ffffff");
                        colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
                        colorTol = limit.tol ?? 30;
                    }

                    for (let y0 = 0; y0 < H; y0 += RANGE_BAND_ROWS) {
                        if (this.rangePending !== pendingRecord) return cancelled();
                        const y1 = Math.min(y0 + RANGE_BAND_ROWS, H);
                        const bh = y1 - y0;
                        const alpha = new Uint8Array(W * bh);

                        let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
                        t1 = performance.now();
                        const imgData = flatCtx.getImageData(0, y0, W, bh);
                        readMs += performance.now() - t1;
                        t1 = performance.now();
                        const d = imgData.data;
                        const isLuma = limit.source === "luma";
                        for (let py = 0; py < bh; py++) {
                            const y = y0 + py;
                            const pyOffset = py * W;
                            for (let px = 0; px < W; px++) {
                                const idx = (pyOffset + px) * 4;
                                let v;
                                if (isLuma) {
                                    v = (0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2]) / 255;
                                } else {
                                    v = colourSimilarity(d[idx] / 255, d[idx + 1] / 255, d[idx + 2] / 255, colorRef, colorTol);
                                }
                                const w = rangeWeight(v, limit);
                                const a = Math.round(255 * (jobInvert ? 1 - w : w));
                                alpha[pyOffset + px] = a;
                                totalAlpha += a;
                                if (a > 0) {
                                    if (px < bX0) bX0 = px;
                                    if (px > bX1) bX1 = px;
                                    if (y < bY0) bY0 = y;
                                    if (y > bY1) bY1 = y;
                                }
                            }
                        }

                        if (Number.isFinite(bX0)) {
                            const bandBounds = [bX0, bY0, bX1 + 1, bY1 + 1];
                            if (!unionBounds) {
                                unionBounds = [...bandBounds];
                            } else {
                                unionBounds[0] = Math.min(unionBounds[0], bandBounds[0]);
                                unionBounds[1] = Math.min(unionBounds[1], bandBounds[1]);
                                unionBounds[2] = Math.max(unionBounds[2], bandBounds[2]);
                                unionBounds[3] = Math.max(unionBounds[3], bandBounds[3]);
                            }
                        }
                        loopMs += performance.now() - t1;

                        t1 = performance.now();
                        const src = bytesSource(alpha, 0, y0, W, bh);
                        this.sel.combine(src, bandMode);
                        combineMs += performance.now() - t1;
                        totalTiles += Math.ceil(W / 256) * Math.ceil(bh / 256);
                    }
                    markStep("range", "combined", { readMs, loopMs, combineMs });
                }
            }

            if (this.rangePending !== pendingRecord) return cancelled();

            let hint;
            if (mode === "replace") {
                hint = unionBounds;
            } else if (mode === "add") {
                hint = this.boundsAfter("add", unionBounds || [0, 0, W, H]);
            } else {
                hint = oldBounds ? { within: oldBounds } : null;
            }

            const touched = oldBounds && unionBounds
                ? [Math.min(oldBounds[0], unionBounds[0]), Math.min(oldBounds[1], unionBounds[1]),
                   Math.max(oldBounds[2], unionBounds[2]), Math.max(oldBounds[3], unionBounds[3])]
                : (oldBounds || unionBounds || [0, 0, W, H]);

            this.markSelectionChanged(hint, touched);
            this.draw();

            const pct = Math.round(100 * totalAlpha / (Math.max(1, W * H) * 255));
            const wall = performance.now() - t0;
            const elapsed = (wall / 1000).toFixed(1);
            const rangeStr = limit.source === "depth"
                ? `near ${limit.lo.toFixed(2)} – far ${limit.hi.toFixed(2)}`
                : `${limit.lo.toFixed(2)} – ${limit.hi.toFixed(2)}`;
            this.setStatus(`Selected ${pct} % of the picture by ${limit.source} (${rangeStr}) in ${elapsed} s`);
            const ms = Math.round(wall * 10) / 10;
            markStep("range", "done", { ms, tiles: totalTiles, pct });

            return {
                bounds: this.getBounds(),
                seconds: +elapsed,
                ms,
                tiles: totalTiles,
            };
        } catch (err) {
            if (this.rangePending === pendingRecord) {
                this.rangePending = null;
                const popped = this.takeUndoEntry(snap);
                if (popped) {
                    this.undoBytes -= popped.bytes || 0;
                    this.applySnapshot(popped);
                    this.releaseSnapshot(popped);
                    this.historyChanged();
                    this.markSelectionChanged();
                    this.draw();
                }
            }
            throw err;
        } finally {
            if (held) {
                try { held.release(); } catch (_) {}
                held = null;
            }
            if (this.rangePending === pendingRecord) {
                this.rangePending = null;
            }
        }
    }

    /**
     * Cancel an ongoing selectRange operation.
     */
    /**
     * Take the range selection's own undo entry out of the list, wherever it sits: a stroke pushed
     * while the bands ran keeps its place (the pointer tools do not wait for `rangePending`).
     */
    takeUndoEntry(snap) {
        if (!snap) return null;
        const i = this.undo.lastIndexOf(snap);
        return i < 0 ? null : this.undo.splice(i, 1)[0];
    }

    cancelRange() {
        if (!this.rangePending) return false;
        const pending = this.rangePending;
        this.rangePending = null;
        try {
            editorPool().cancel(pending.group);
        } catch {}

        const popped = this.takeUndoEntry(pending.snap);
        if (popped) {
            this.undoBytes -= popped.bytes || 0;
            this.applySnapshot(popped);
            this.releaseSnapshot(popped);
        } else if (pending.snap) {
            this.applySnapshot(pending.snap);
            this.releaseSnapshot(pending.snap);
        }
        this.historyChanged();
        this.markSelectionChanged();
        this.draw();
        this.setStatus("Selection by range cancelled");
        return true;
    }

    /**
     * Banded combine of raw SAM2 logits into the selection (R1-S9).
     * Evaluates logits bilinearly per tile in worker (or canvas loop), clips to layer alpha if given,
     * and runs only over the box of positive logits plus one cell.
     *
     * @param {{ logits: Float32Array, n?: number, score?: number }} res
     * @param {{ mode?: "replace" | "add" | "subtract" | "intersect", label?: string, layer?: any, box?: number[], point?: number[] }} [opts]
     */
    async selectLogits(res, { mode = "replace", label = "Object selection", layer = null, box = null, point = null } = {}) {
        if (!res || !res.logits) throw new Error("selectLogits: missing logits in result");
        const logits = res.logits instanceof Float32Array ? res.logits : new Float32Array(res.logits.data || res.logits);
        const n = res.n || 256;
        const W = this.width, H = this.height;

        let minGx = n, maxGx = -1, minGy = n, maxGy = -1;
        for (let gy = 0; gy < n; gy++) {
            const r = gy * n;
            for (let gx = 0; gx < n; gx++) {
                if (logits[r + gx] > 0) {
                    if (gx < minGx) minGx = gx;
                    if (gx > maxGx) maxGx = gx;
                    if (gy < minGy) minGy = gy;
                    if (gy > maxGy) maxGy = gy;
                }
            }
        }

        if (maxGx < 0) {
            const desc = box ? "in the box." : "at this spot. Use the brush or lasso here.";
            this.setStatus("SAM2 found nothing " + desc);
            return { bounds: this.getBounds(), score: res.score, tiles: 0 };
        }

        // Expand by 1 cell in grid
        minGx = Math.max(0, minGx - 1);
        maxGx = Math.min(n - 1, maxGx + 1);
        minGy = Math.max(0, minGy - 1);
        maxGy = Math.min(n - 1, maxGy + 1);

        const imgX0 = Math.max(0, Math.floor((minGx * W) / n));
        const imgX1 = Math.min(W, Math.ceil(((maxGx + 1) * W) / n));
        const imgY0 = Math.max(0, Math.floor((minGy * H) / n));
        const imgY1 = Math.min(H, Math.ceil(((maxGy + 1) * H) / n));
        const boundsBox = [imgX0, imgY0, imgX1, imgY1];

        const oldBounds = this.getBounds();
        this.pushUndo({ kind: "selection", label });
        if (mode === "replace") {
            this.selectionLabel = "";
            this.sel.clear();
        }

        if (mode === "intersect") {
            this.sel.combine(rectSource(boundsBox), "intersect");
        }

        const jobInvert = (mode === "intersect");
        const bandMode = (mode === "replace") ? "add" : ((mode === "intersect") ? "subtract" : mode);

        let unionBounds = null;
        let totalTiles = 0;
        let totalAlpha = 0;

        const startY = Math.floor(imgY0 / RANGE_BAND_ROWS) * RANGE_BAND_ROWS;
        const endY = Math.min(H, Math.ceil(imgY1 / RANGE_BAND_ROWS) * RANGE_BAND_ROWS);

        if (this.tileMode && !editorPool().off) {
            const group = "select_logits_" + Date.now();
            const bandPromises = [];
            for (let y0 = startY; y0 < endY; y0 += RANGE_BAND_ROWS) {
                const y1 = Math.min(y0 + RANGE_BAND_ROWS, H);
                const clip = (layer && isTilePixels(layer.px)) ? storeArgs(layer.px, layer.x, layer.y, y0, y1) : null;
                const msg = {
                    op: "range_select",
                    W, H, y0, y1,
                    source: "logit",
                    logits,
                    n,
                    box: boundsBox,
                    invert: jobInvert,
                    clip,
                };
                bandPromises.push(
                    editorPool().run("range_select", msg, [], { priority: INTERACTIVE, group })
                        .then((bRes) => ({ y0, y1, bRes }))
                );
            }

            for (const p of bandPromises) {
                const { y0, y1, bRes } = await p;
                totalAlpha += bRes.alphaSum || 0;
                if (bRes.tiles && bRes.tiles.length > 0) {
                    totalTiles += bRes.tiles.length;
                    const src = tilesSource(bRes.tiles, [0, 0], [0, y0, W, y1]);
                    this.sel.combine(src, bandMode);
                }
                if (bRes.bounds) {
                    if (!unionBounds) {
                        unionBounds = [...bRes.bounds];
                    } else {
                        unionBounds[0] = Math.min(unionBounds[0], bRes.bounds[0]);
                        unionBounds[1] = Math.min(unionBounds[1], bRes.bounds[1]);
                        unionBounds[2] = Math.max(unionBounds[2], bRes.bounds[2]);
                        unionBounds[3] = Math.max(unionBounds[3], bRes.bounds[3]);
                    }
                }
            }
        } else {
            // Canvas backend (or pool worker off): main-thread loop over bands
            const sx = n / W, sy = n / H;
            const clip = layer ? this.layerAlpha(layer) : null;

            for (let y0 = startY; y0 < endY; y0 += RANGE_BAND_ROWS) {
                const y1 = Math.min(y0 + RANGE_BAND_ROWS, H);
                const bh = y1 - y0;
                const alpha = new Uint8Array(W * bh);

                let bX0 = Infinity, bY0 = Infinity, bX1 = -Infinity, bY1 = -Infinity;
                for (let py = 0; py < bh; py++) {
                    const y = y0 + py;
                    const pyOffset = py * W;
                    const fy = Math.min(n - 1, Math.max(0, (y + 0.5) * sy - 0.5));
                    const iy = Math.floor(fy), tyFrac = fy - iy, iy1 = Math.min(n - 1, iy + 1);
                    const r0 = iy * n, r1 = iy1 * n;

                    for (let x = imgX0; x < imgX1; x++) {
                        const fx = Math.min(n - 1, Math.max(0, (x + 0.5) * sx - 0.5));
                        const ix = Math.floor(fx), txFrac = fx - ix, ix1 = Math.min(n - 1, ix + 1);
                        const v = (logits[r0 + ix] * (1 - txFrac) + logits[r0 + ix1] * txFrac) * (1 - tyFrac)
                                + (logits[r1 + ix] * (1 - txFrac) + logits[r1 + ix1] * txFrac) * tyFrac;

                        let a = v > 0 ? (jobInvert ? 0 : 255) : (jobInvert ? 255 : 0);
                        if (clip && a > 0 && !clip[y * W + x]) a = 0;

                        alpha[pyOffset + x] = a;
                        totalAlpha += a;
                        if (a > 0) {
                            if (x < bX0) bX0 = x;
                            if (x > bX1) bX1 = x;
                            if (y < bY0) bY0 = y;
                            if (y > bY1) bY1 = y;
                        }
                    }
                }

                if (Number.isFinite(bX0)) {
                    const bandBounds = [bX0, bY0, bX1 + 1, bY1 + 1];
                    if (!unionBounds) {
                        unionBounds = [...bandBounds];
                    } else {
                        unionBounds[0] = Math.min(unionBounds[0], bandBounds[0]);
                        unionBounds[1] = Math.min(unionBounds[1], bandBounds[1]);
                        unionBounds[2] = Math.max(unionBounds[2], bandBounds[2]);
                        unionBounds[3] = Math.max(unionBounds[3], bandBounds[3]);
                    }
                }

                const src = bytesSource(alpha, 0, y0, W, bh);
                this.sel.combine(src, bandMode);
                totalTiles += Math.ceil(W / 256) * Math.ceil(bh / 256);
            }
        }

        let hint;
        if (mode === "replace") {
            hint = unionBounds;
        } else if (mode === "add") {
            hint = oldBounds && unionBounds
                ? [Math.min(oldBounds[0], unionBounds[0]), Math.min(oldBounds[1], unionBounds[1]),
                   Math.max(oldBounds[2], unionBounds[2]), Math.max(oldBounds[3], unionBounds[3])]
                : (oldBounds || unionBounds);
        } else if (mode === "subtract") {
            hint = oldBounds;
        } else if (mode === "intersect") {
            hint = oldBounds && unionBounds
                ? [Math.max(oldBounds[0], unionBounds[0]), Math.max(oldBounds[1], unionBounds[1]),
                   Math.min(oldBounds[2], unionBounds[2]), Math.min(oldBounds[3], unionBounds[3])]
                : (unionBounds || oldBounds);
        }

        const touched = oldBounds && unionBounds
            ? [Math.min(oldBounds[0], unionBounds[0]), Math.min(oldBounds[1], unionBounds[1]),
               Math.max(oldBounds[2], unionBounds[2]), Math.max(oldBounds[3], unionBounds[3])]
            : (oldBounds || unionBounds || [0, 0, W, H]);

        this.markSelectionChanged(hint, touched);
        this.draw();

        const pct = Math.max(1, Math.round(100 * totalAlpha / (Math.max(1, W * H) * 255)));
        const scoreStr = res.score != null ? res.score.toFixed(2) : "1.00";
        const verb = (mode === "subtract") ? "Removed" : ((mode === "intersect") ? "Kept" : "Selected");
        const desc = box ? "in the box" : "at this point";
        this.setStatus(`${verb} what SAM2 sees ${desc} (${pct} % of the picture, score ${scoreStr})`);

        return {
            bounds: this.getBounds(),
            score: res.score,
            tiles: totalTiles,
        };
    }

    /**
     * A rectangle ([x0, y0, x1, y1] in image pixels) into the selection: replace, add, subtract or intersect.
     */
    selectRectangle(box, mode = "replace") {
        const b = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])), Math.min(this.width, Math.ceil(box[2])), Math.min(this.height, Math.ceil(box[3]))];
        if (b[2] <= b[0] || b[3] <= b[1]) return false;
        const hint = this.boundsAfter(mode, b);
        const all = mode === "replace" && !b[0] && !b[1] && b[2] === this.width && b[3] === this.height;
        this.pushUndo({ kind: "selection", label: all ? "Select all" : "Rectangle selection" });
        if (mode === "replace") this.selectionLabel = "";
        const old = (mode === "replace" || mode === "intersect") ? this.getBounds() : null;
        if (mode === "replace") {
            this.sel.clear();
            this.sel.fill(b, "#ff0000");
        } else if (mode === "subtract") {
            this.sel.clear(b);
        } else if (mode === "intersect") {
            if (b[1] > 0) this.sel.clear([0, 0, this.width, b[1]]);
            if (b[3] < this.height) this.sel.clear([0, b[3], this.width, this.height]);
            if (b[0] > 0) this.sel.clear([0, b[1], b[0], b[3]]);
            if (b[2] < this.width) this.sel.clear([b[2], b[1], this.width, b[3]]);
        } else {
            this.sel.fill(b, "#ff0000");
        }
        const touched = old ? [Math.min(old[0], b[0]), Math.min(old[1], b[1]), Math.max(old[2], b[2]), Math.max(old[3], b[3])] : b;
        this.markSelectionChanged(hint, touched);
        this.draw();
        return true;
    }

    /**
     * The same with the region already drawn (a canvas or an ImageBitmap from the worker),
     * placed with its top left corner at `at` (image coordinates; the shape may be a box
     * of the image rather than all of it). `box` is the region's bounding box in image
     * coordinates when the caller knows it, so the new selection's bounds do not have to
     * be scanned for. `label` names the undo step.
     */
    applyShapeToSelection(shape, mode = "replace", box = null, at = [0, 0], label = "Selection from mask") {
        const hint = box ? this.boundsAfter(mode, box) : undefined;
        this.pushUndo({ kind: "selection", label });
        if (mode === "replace") this.selectionLabel = "";
        const rect = [at[0], at[1], at[0] + shape.width, at[1] + shape.height];
        const old = (mode === "replace" || mode === "intersect") ? this.getBounds() : null;
        const gco = selectionGco(mode);
        if (mode === "replace") {
            this.sel.clear();
        } else if (gco.clearOutside) {
            if (rect[1] > 0) this.sel.clear([0, 0, this.width, rect[1]]);
            if (rect[3] < this.height) this.sel.clear([0, rect[3], this.width, this.height]);
            if (rect[0] > 0) this.sel.clear([0, rect[1], rect[0], rect[3]]);
            if (rect[2] < this.width) this.sel.clear([rect[2], rect[1], this.width, rect[3]]);
        }
        this.sel.drawInto(rect, (sctx) => {
            sctx.globalCompositeOperation = gco.op;
            sctx.drawImage(shape, at[0], at[1]);
        });
        const touched = old ? [Math.min(old[0], rect[0]), Math.min(old[1], rect[1]), Math.max(old[2], rect[2]), Math.max(old[3], rect[3])] : rect;
        this.markSelectionChanged(hint, touched);
        this.draw();
    }

    /**
     * Run a selection algorithm (grow, feather, invert) in the worker and put the result back; the
     * answer carries the new bounding box and the rectangle it was written in.
     *
     * Only the selection's own bounding box plus `halo` -- how far the operation reaches past the
     * mask's edge -- goes through the worker and comes back (docs/PLAN_BCE.md §C5): the whole
     * selection was 600 MB of canvas at 15000 x 10000, materialised, copied into an ImageBitmap,
     * sent, and written back over a scratch of the same size. Outside that box nothing can change,
     * because the mask is empty there and grow, shrink and feather only move an edge. `whole`
     * forces the whole image, which invert needs: its result covers everything the selection does
     * not. Null means there was no worker or it failed and the caller does the work itself.
     */
    async selectionInWorker(kind, args, { halo = 0, whole = false } = {}) {
        if (!whole && this.sel) { const t = await this.selectionOverTiles(kind, args, halo); if (t) return t; }
        if (!this.sel || !editorWorker()) return null;
        const W = this.width, H = this.height;
        const b = whole ? null : this.getBounds();
        const box = whole || !b ? [0, 0, W, H] : clampRect([b[0] - halo, b[1] - halo, b[2] + halo, b[3] + halo], W, H);
        if (box[2] <= box[0] || box[3] <= box[1]) return null;
        const full = box[0] === 0 && box[1] === 0 && box[2] === W && box[3] === H;
        try {
            const bitmap = await createImageBitmap(this.sel.toCanvas(full ? null : box));
            const r = await workerCall("selection", { kind, bitmap, ...args }, [bitmap]);
            if (!r.bitmap) return null;
            this.sel.drawInto(full ? null : box, (sctx) => {
                // "copy" only where the rectangle is the whole mask: drawInto clips on the canvas
                // backend, and Chromium applies "copy" to the whole canvas whatever the clip says
                // (docs/PLAN_BCE.md §C1, WHOLE_CANVAS_OPS)
                if (full) { sctx.globalCompositeOperation = "copy"; }
                else sctx.clearRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
                sctx.drawImage(r.bitmap, box[0], box[1]);
            });
            r.bitmap.close();
            // the worker's bounds are in the box's own pixels
            let bounds = r.bounds;
            if (bounds) bounds = [bounds[0] + box[0], bounds[1] + box[1], bounds[2] + box[0], bounds[3] + box[1]];
            return { bounds, box };
        } catch (err) {
            console.warn(`Inpaint Canvas: ${kind} in the worker failed, using the main thread:`, (err && err.message) || err);
            return null;
        }
    }

    /**
     * grow, shrink and feather on the mask's own tiles (B item 3): a worker of the pool reads the selection's box (on
     * the tile grid) from the arena, works on it and sends back the tiles that changed, which are written here. No
     * canvas of the box, no bitmap, no scratch. `{ bounds, box }` like `selectionInWorker`, or null when it cannot be
     * done this way (the canvas backend, no pool, a tile outside the arena, a failed job) and the caller goes on.
     */
    async selectionOverTiles(kind, args, halo) {
        if (InpaintEditor.stacks === false || !this.tileMode || !isTilePixels(this.sel) || !arenaEnabled() || editorPool().off) return null;
        const W = this.width, H = this.height;
        const b = this.getBounds();
        if (!b) return null;
        const T = TILE_SIZE;
        const box = [Math.max(0, b[0] - halo) & ~(T - 1), Math.max(0, b[1] - halo) & ~(T - 1), Math.min(W, Math.ceil((b[2] + halo) / T) * T), Math.min(H, Math.ceil((b[3] + halo) / T) * T)];
        const w = box[2] - box[0], h = box[3] - box[1];
        if (!(w > 0 && h > 0) || w * h * 4 > 0x7fffffff || !stackInArena(this.sel)) return null;
        const snap = this.sel.clone();
        try {
            const r = await editorPool().run("selection", { kind, ...args, sel: storeArgs(snap, 0, 0, box[1], box[3]), x0: box[0], y0: box[1], w, h }, [], { priority: INTERACTIVE, timeout: 300000 });
            for (const t of r.tiles) {
                const X = box[0] + t.tx * T, Y = box[1] + t.ty * T, tw = Math.min(T, W - X), th = Math.min(T, H - Y);
                if (t.empty) { this.sel.clear([X, Y, X + tw, Y + th]); continue; }
                let data = new Uint8ClampedArray(t.data);
                if (tw < T || th < T) { const cut = new Uint8ClampedArray(tw * th * 4); for (let yy = 0; yy < th; yy++) cut.set(data.subarray(yy * T * 4, yy * T * 4 + tw * 4), yy * tw * 4); data = cut; }
                this.sel.writeRect({ data, width: tw, height: th }, X, Y);
            }
            let bounds = r.bounds;
            if (bounds) bounds = [bounds[0] + box[0], bounds[1] + box[1], bounds[2] + box[0], bounds[3] + box[1]];
            return { bounds, box, tiles: r.tiles.length };
        } catch (err) {
            console.warn(`Inpaint Canvas: ${kind} over tiles failed, using the canvases:`, (err && err.message) || err);
            return null;
        } finally {
            snap.release();
        }
    }

    /**
     * The region of similar pixels around (x, y) of `src` (a canvas of any size: the whole
     * image, or a box of it whose top left corner sits at `at` in image coordinates), as a
     * shape in `color` (a canvas or an ImageBitmap) plus the number of pixels it covers, its
     * bounds in `src`'s own pixels and on which edges of `src` it arrives. Runs in the worker
     * when there is one; `clip` limits it to the selection.
     */
    async floodShape(src, x, y, { tolerance = 32, contiguous = true, color = "#ff0000", clip = false, at = [0, 0] } = {}) {
        const W = src.width, H = src.height;
        const clipping = clip && this.getBounds();
        if (editorWorker()) {
            const transfer = [];
            try {
                const bitmap = await createImageBitmap(src);
                transfer.push(bitmap);
                const args = { bitmap, x, y, tolerance, contiguous, color };
                if (clipping) {
                    // only the box of the selection: a crop, not a copy of the whole canvas
                    // C6 (c1): the box's part of the selection, not a canvas of the whole selection per round (572 MB at 15k)
                    // (a whole-image flood keeps toCanvas(): on canvases that is the selection's own canvas, no copy)
                    const all = !at[0] && !at[1] && W === this.width && H === this.height;
                    const selBitmap = await createImageBitmap(this.sel.toCanvas(all ? null : [at[0], at[1], at[0] + W, at[1] + H]));
                    transfer.push(selBitmap);
                    args.selBitmap = selBitmap;
                }
                const r = await workerCall("flood", args, transfer);
                if (r.bitmap) return { shape: r.bitmap, count: r.count, bounds: r.bounds, touches: r.touches, close: true };
            } catch (err) {
                console.warn("Inpaint Canvas: the region in the worker failed, using the main thread:", (err && err.message) || err);
                for (const b of transfer) { try { b.close(); } catch (_) { /* already transferred */ } }
            }
        }
        const data = src.getContext("2d").getImageData(0, 0, W, H).data;
        const mask = floodMask(data, W, H, x, y, tolerance, contiguous);
        if (clipping) {
            let sel;
            if (at[0] || at[1] || W !== this.width || H !== this.height) { sel = makeCanvas(W, H); this.sel.drawTo(sel.getContext("2d"), -at[0], -at[1]); }
            else sel = this.sel.toCanvas();
            clipMaskToSelection(mask, sel);
        }
        let count = 0;
        for (let i = 0; i < mask.length; i++) count += mask[i];
        const shape = maskToColorCanvas(mask, W, H, color);
        const bounds = maskBounds(shape.getContext("2d").getImageData(0, 0, W, H).data, W, H);
        const touches = bounds ? { l: bounds[0] === 0, t: bounds[1] === 0, r: bounds[2] === W, b: bounds[3] === H } : null;
        return { shape, count, bounds, touches, close: false };
    }

    /**
     * The region of similar pixels around (x, y) in image coordinates, found without a
     * full-resolution composite of the whole image (phase A item 3 of the app's
     * docs/PLAN_TILES.md; on a 15k document that composite alone was 0.6 s, the flood over
     * 150 million pixels two more). Two passes: a coarse flood on a composite of at most
     * FLOOD_COARSE_PX on the long side finds the region's box; the fine flood then runs
     * inside that box, composited at full resolution for the box only, and widens the box
     * where the region arrives at its edge (a thin bridge the coarse pass could not see)
     * until it does not, or the box is the image. The answer carries the box's origin
     * (`x`, `y`) and size, the bounds in image coordinates, and the shape at box size.
     * A non-contiguous select (every similar pixel of the image) has to read it all and
     * takes the old path.
     */
    async floodRegion(x, y, o) {
        // B item 2: a plain stack is composited by the pool from its tiles and flooded there; held as it is now
        const held = await this.holdStack(this.floodStack(o.sample), { forRun: false, priority: INTERACTIVE });
        try { return await this.floodRegionOf(held, x, y, o); } finally { if (held) held.release(); }
    }

    async floodRegionOf(held, x, y, o) {
        const W = this.width, H = this.height;
        const whole = async () => {
            const t = held ? await this.floodOverTiles(held, [0, 0, W, H], x, y, o) : null;
            if (t) return { ...t, x: 0, y: 0, w: W, h: H, rounds: 0 };
            const r = await this.floodShape(this.sampleCanvas(o.sample), x, y, { tolerance: o.tolerance, contiguous: o.contiguous, color: o.color, clip: o.clip });
            return { ...r, x: 0, y: 0, w: W, h: H, rounds: 0 };
        };
        if (!o.contiguous || Math.max(W, H) <= FLOOD_COARSE_PX) return whole();
        const s = FLOOD_COARSE_PX / Math.max(W, H);
        // C6 (c3): the coarse pass reads a level of every tile, and after a whole change it built them all here
        // (2,360 chains, 460 ms at 15000 x 10000). `floodRegion` is already async and its caller already waits.
        const coarse = await this.sampleRegionSettled(o.sample, [0, 0, W, H], s);
        const cr = await this.floodShape(coarse, Math.floor(x * s), Math.floor(y * s), { tolerance: o.tolerance, contiguous: true, clip: false });
        if (cr.close) cr.shape.close();
        const pad = Math.ceil(2 / s) + 8;
        let box = cr.bounds
            ? [cr.bounds[0] / s - pad, cr.bounds[1] / s - pad, cr.bounds[2] / s + pad, cr.bounds[3] / s + pad]
            : [x - pad, y - pad, x + pad, y + pad];
        for (let round = 1; ; round++) {
            box = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])), Math.min(W, Math.ceil(box[2])), Math.min(H, Math.ceil(box[3]))];
            // over tiles the box lies on the tile grid: the answer's tiles are then the selection's own
            if (held) box = [box[0] & ~(TILE_SIZE - 1), box[1] & ~(TILE_SIZE - 1), Math.min(W, Math.ceil(box[2] / TILE_SIZE) * TILE_SIZE), Math.min(H, Math.ceil(box[3] / TILE_SIZE) * TILE_SIZE)];
            const [bx, by, bx1, by1] = box, bw = bx1 - bx, bh = by1 - by;
            // a region that covers most of the picture is cheaper in one pass than box by box
            if (bw <= 0 || bh <= 0 || bw * bh > W * H * FLOOD_WHOLE_SHARE) return whole();
            let r = held ? await this.floodOverTiles(held, box, x, y, { ...o, contiguous: true }) : null;
            if (!r) {
                const fine = this.sampleRegion(o.sample, box, 1);
                r = await this.floodShape(fine, x - bx, y - by, { tolerance: o.tolerance, contiguous: true, color: o.color, clip: o.clip, at: [bx, by] });
            }
            const t = r.touches || {};
            const l = t.l && bx > 0, tp = t.t && by > 0, rt = t.r && bx1 < W, b = t.b && by1 < H;
            if (!(l || tp || rt || b) || round >= 8) {
                return { ...r, x: bx, y: by, w: bw, h: bh, rounds: round, bounds: r.bounds ? [r.bounds[0] + bx, r.bounds[1] + by, r.bounds[2] + bx, r.bounds[3] + by] : null };
            }
            if (r.close) r.shape.close();
            // widen by half the box on every side the region reached
            box = [l ? bx - bw / 2 : bx, tp ? by - bh / 2 : by, rt ? bx1 + bw / 2 : bx1, b ? by1 + bh / 2 : by1];
        }
    }

    /** Magic wand: the area of similar colour under (ix, iy) becomes the selection. */
    async wandSelect(ix, iy, mode = "replace") {
        if (!this.width) return;
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const o = this.fillOpts || { tolerance: 32, contiguous: true, sample: "image" };
        const t0 = performance.now();
        const r = await this.floodRegion(x, y, { tolerance: o.tolerance, contiguous: o.contiguous, sample: o.sample, tiles: true });
        if (r.tiles) this.applyTilesToSelection(r.tiles, mode, r.bounds, [r.x, r.y]);
        else this.applyShapeToSelection(r.shape, mode, r.bounds, [r.x, r.y], "Magic wand");
        if (r.close) r.shape.close();
        this.setStatus(`${r.count.toLocaleString()} px ${mode === "replace" ? "selected" : mode === "add" ? "added" : "subtracted"} (${Math.round(performance.now() - t0)} ms).`);
    }

    /** Soften the selection edge: gaussian blur of the mask. Undo waits for it (it writes after the worker's answer). */
    featherSelection(r) { return this.trackEdit(this.featherSelectionNow(r)); }

    async featherSelectionNow(r) {
        if (!this.getBounds()) { this.setStatus("Nothing selected to feather."); return; }
        r = Math.max(0.5, Math.min(512, +r || 0));
        this.pushUndo({ kind: "selection", label: "Feather selection" });
        // a Gaussian blur of radius r is over at about three sigma; two pixels of slack on top
        const done = await this.selectionInWorker("feather", { radius: r }, { halo: Math.ceil(r * 3) + 2 });
        if (!done) {
            const tmp = makeCanvas(this.width, this.height);
            const tctx = tmp.getContext("2d");
            tctx.filter = `blur(${r}px)`;
            this.sel.drawTo(tctx, 0, 0);
            tctx.filter = "none";
            const W = this.width, H = this.height;
            this.sel.drawInto(null, (sctx) => {
                sctx.clearRect(0, 0, W, H);
                sctx.drawImage(tmp, 0, 0);
            });
        }
        this.markSelectionChanged(done ? done.bounds : undefined, done && done.box);
        this.draw();
        this.setStatus(`Selection feathered by ${r} px (soft edge for painting, filling and the mask).`);
    }

    renderSelectionList() {
        if (!this.selectionsSel) return;
        const sel = this.selectionsSel;
        const keep = sel.selectedIndex;
        sel.innerHTML = "";
        for (const s of this.savedSelections || []) { const o = document.createElement("option"); o.value = s.name; o.textContent = s.name; sel.appendChild(o); }
        sel.selectedIndex = Math.min(sel.options.length - 1, Math.max(0, keep));
        sel.disabled = !sel.options.length;
    }

    saveSelection() {
        if (!this.getBounds()) { this.setStatus("Nothing selected to save."); return; }
        if (!this.savedSelections) this.savedSelections = [];
        const name = this.selectionLabel ? this.selectionLabel : `Selection ${this.savedSelections.length + 1}`;
        this.savedSelections.push({ name, url: this.sel.toCanvas().toDataURL("image/png") });
        this.renderSelectionList();
        this.selectionsSel.selectedIndex = this.savedSelections.length - 1;
        this.notifyChanged();
        this.setStatus(`"${name}" saved with the workflow.`);
    }

    async loadSelection(index, mode = "replace") {
        const s = (this.savedSelections || [])[index];
        if (!s) { this.setStatus("No saved selection chosen."); return; }
        try {
            const img = await loadImageEl(s.url);
            this.pushUndo({ kind: "selection", label: "Load selection" });
            // the saved PNG is drawn at 0, 0 whatever its size: the whole rect (null); turned as the document was before this
            // build (its `orient`) and moved, scaled and turned as it was since (its `xf`, PLAN_0_1_31 §7). On whole pixels
            // (a crop, an extend, the quarter turns) without smoothing, so the bytes move as they are
            const o = orientIsUp(s.orient) ? XF_IDENTITY : orientMatrix(s.orient, img.naturalWidth || img.width, img.naturalHeight || img.height);
            const m = validXf(s.xf) ? xfMul(s.xf, o) : o;
            const exact = !!orientOfXf(m) && m.every((v) => Number.isInteger(v)) && m.slice(0, 4).every((v) => Math.abs(v) <= 1);
            const gco = selectionGco(mode);
            if (mode === "replace") this.sel.clear();
            this.sel.drawInto(null, (sctx) => {
                sctx.globalCompositeOperation = gco.op;
                if (!xfIsIdentity(m)) { sctx.save(); sctx.imageSmoothingEnabled = !exact; sctx.transform(...m); sctx.drawImage(img, 0, 0); sctx.restore(); }
                else sctx.drawImage(img, 0, 0);
            });
            this.selectionLabel = mode === "replace" ? s.name : this.selectionLabel;
            this.markSelectionChanged();
            this.draw();
            const modeWord = mode === "replace" ? "loaded" : mode === "add" ? "added" : mode === "subtract" ? "subtracted" : "intersected";
            this.setStatus(`"${s.name}" ${modeWord}.`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the saved selection.", "error");
        }
    }

    deleteSelection(index) {
        if (!this.savedSelections || !this.savedSelections[index]) return;
        const [s] = this.savedSelections.splice(index, 1);
        this.renderSelectionList();
        this.notifyChanged();
        this.setStatus(`"${s.name}" deleted.`);
    }

    toggleQuickMask() {
        this.quickMask = !this.quickMask;
        if (this.quickMaskBtn) this.quickMaskBtn.classList.toggle("ipc-toggle-on", this.quickMask);
        if (this.quickMask && !["paint", "erase", "bucket"].includes(this.tool)) this.setTool("paint");
        this.draw();
        this.setStatus(this.quickMask ? "Quick mask on: paint selects, erase deselects, the bucket selects similar colours. Q switches back." : "Quick mask off.");
    }

    fillSelection() {
        if (!this.sel || !this.getBounds()) { this.setStatus("Nothing selected to fill."); return; }
        let layer = this.activeLayer();
        if (!layer) layer = this.addPaintLayer();
        if (this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
        const onMask = !!(layer.maskPx && layer.maskEdit);
        if (layer.kind === "filter" && !onMask) { this.setStatus("Filter layers have no pixels to fill. Use \"mask from selection\" to limit the filter instead."); return; }
        this.pushUndo(onMask ? { kind: "mask", id: layer.id, label: "Fill mask" } : { kind: "layer", id: layer.id, label: "Fill selection" });
        // a mask is replaced, not written (rule 2): the `mask` step restores by replacing it, and an
        // older `layers` / `canvas` step still holds the old object, which has to stay as it was
        if (onMask) layer.maskPx = layer.maskPx.clone();
        const target = onMask ? layer.maskPx : layer.px;
        // the selection's region: the whole image on canvases, its extent on tiles (selectionWriteRegion)
        const reg = this.selectionWriteRegion(layer, target);
        if (reg && !reg.ext) { this.markLayerChanged(layer); this.draw(); return; }
        const [ex0, ey0, ex1, ey1] = reg ? reg.ext : [0, 0, this.width, this.height];
        const shape = makeCanvas(ex1 - ex0, ey1 - ey0);
        // on tiles a CPU canvas: it goes into the store's CPU scratch, and a GPU one would be read back there
        const sctx = reg ? shape.getContext("2d", { willReadFrequently: true }) : shape.getContext("2d");
        this.drawSelectionPart(sctx, reg && reg.ext);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = onMask ? "#ffffff" : this.color;
        sctx.fillRect(0, 0, ex1 - ex0, ey1 - ey0);
        // the shape scaled into the target's pixels, at the brush opacity; the whole area (null) on canvases
        const opacity = this.brushOpacity;
        target.drawInto(reg ? reg.box : null, (ctx) => {
            ctx.globalAlpha = opacity;
            ctx.scale(target.width / layer.w, target.height / layer.h);   // composed (rule 12)
            ctx.drawImage(shape, ex0 - layer.x, ey0 - layer.y);
        });
        if (onMask) {
            this.markMaskChanged(layer);
            this.draw();
            this.setStatus(`${layer.name}: selection revealed on the mask.`);
            return;
        }
        // on tiles the display levels are refreshed inside the written box: a rebuild drew the whole CPU mirror
        // into the first level, about 200 ms at 96 MP (C2's final review); on canvases rebuilt, as before
        this.markLayerChanged(layer, reg ? clampRect(reg.box, target.width, target.height) : undefined);
        this.draw();
    }

    /**
     * Into the clipboard: the selected pixels of the active layer (of everything visible
     * with merged), or the whole layer when nothing is selected, which is what Krita does.
     * Cut clears the pixels afterwards. Every tab shares the clipboard.
     */
    copySelection({ merged = false, cut = false } = {}) {
        if (!this.sel || !this.getBounds()) return this.copyLayer({ merged, cut });
        const [x0, y0, x1, y1] = this.getBounds();
        const w = x1 - x0, h = y1 - y0;
        const layer = this.activeLayer();
        const useMerged = merged || !layer || layer.kind === "filter";
        const c = makeCanvas(w, h);
        const ctx = c.getContext("2d");
        if (useMerged) {
            ctx.drawImage(this.flattenToCanvas({ forRun: true }), x0, y0, w, h, 0, 0, w, h);
        } else {
            ctx.drawImage(this.layerPixels(layer), layer.x - x0, layer.y - y0, layer.w, layer.h);
        }
        ctx.globalCompositeOperation = "destination-in";
        this.sel.drawTo(ctx, -x0, -y0);
        ctx.globalCompositeOperation = "source-over";
        this.clipboard = { canvas: c, x: x0, y: y0, source: useMerged ? "merged" : layer.name };
        if (cut && layer && !useMerged) this.clearSelectedPixels();
        this.setStatus(`${cut ? "Cut" : "Copied"} ${w} × ${h} px from ${this.clipboard.source}. Ctrl+V pastes it as a new layer.`);
        return this.clipboard;
    }

    /** The whole active layer into the clipboard: Ctrl+C with nothing selected, Ctrl+X cuts it out. */
    copyLayer({ merged = false, cut = false, layer = null } = {}) {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        const l = layer || this.activeLayer();
        const useMerged = merged || !l || l.kind === "filter";
        if (!useMerged && this.isLocked(l) && cut) { this.setStatus(`${l.name} is locked.`); return null; }
        let c, x, y, name;
        if (useMerged) {
            c = makeCanvas(this.width, this.height);
            c.getContext("2d").drawImage(this.flattenToCanvas({ forRun: true }), 0, 0);
            x = 0; y = 0;
            name = l && l.kind === "filter" ? "the visible image (a filter layer has no pixels of its own)" : "the visible image";
        } else {
            c = makeCanvas(l.w, l.h);
            c.getContext("2d").drawImage(this.layerPixels(l), 0, 0);
            x = l.x; y = l.y; name = l.name;
        }
        this.clipboard = { canvas: c, x, y, source: name };
        if (cut && l && !useMerged) this.removeLayer(l.id);
        this.setStatus(`${cut ? "Cut" : "Copied"} ${c.width} \u00d7 ${c.height} px from ${name}. Ctrl+V pastes it as a layer, here or in another tab.`);
        return this.clipboard;
    }

    /** Paste the clipboard as a new layer at the place it was copied from. */
    pasteClipboard() {
        if (!this.clipboard) { this.setStatus("Nothing copied yet: Ctrl+C copies the selection, or the whole layer when nothing is selected."); return null; }
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.pasteCounter = (this.pasteCounter || 0) + 1;
        const { canvas, x, y } = this.clipboard;
        const copy = makeCanvas(canvas.width, canvas.height);
        copy.getContext("2d").drawImage(canvas, 0, 0);
        const src = this.clipboard.source || "";
        const name = src && !/^the visible image/.test(src) ? `${src} copy` : `Paste ${this.pasteCounter}`;
        const layer = this.addLayer({ name, kind: "image", ref: null, px: this.pixels.Layer.fromCanvas(copy), x, y, w: canvas.width, h: canvas.height, dirty: true });
        this.setStatus(`${layer.name} added (${canvas.width} × ${canvas.height} at ${x}, ${y}). Move it with T.`);
        return layer;
    }

    /**
     * Where a write of the selection into `target` (a layer's pixels or mask, or a new mask of that size) has to
     * reach. On canvases null: the whole image, as always. On tiles `{ ext, box }`: `ext` the selection's exact
     * extent (every pixel with any alpha, from the tile set) with two transparent pixels around it, in image
     * pixels, and `box` that extent in the target's own pixels, widened by the scaled draw's reach; `ext` is null
     * for an empty selection. A whole-layer write on tiles is a scratch as large as the layer, filled from every
     * tile and read back: a fill, a clear or a mask from a 100 px selection held the main thread 0.7 to 1.1 s at
     * 96 MP, and the selection's own draw made its display mirror (C2's final review).
     */
    selectionWriteRegion(layer, target) {
        if (!isTilePixels(target) || !isTilePixels(this.sel)) return null;
        const b = this.sel.bounds();
        if (!b) return { ext: null, box: null };
        const ext = [Math.max(0, b[0] - 2), Math.max(0, b[1] - 2), Math.min(this.width, b[2] + 2), Math.min(this.height, b[3] + 2)];
        const sx = target.width / layer.w, sy = target.height / layer.h, pad = Math.ceil(Math.max(1, sx, sy)) + 2;
        const box = [Math.floor((ext[0] - layer.x) * sx) - pad, Math.floor((ext[1] - layer.y) * sy) - pad,
            Math.ceil((ext[2] - layer.x) * sx) + pad, Math.ceil((ext[3] - layer.y) * sy) + pad];
        return { ext, box };
    }

    /** The selection into `ctx` at (0, 0): all of it, or only `ext` (tiles, materialised alone) with ext's origin at (0, 0). */
    drawSelectionPart(ctx, ext) {
        if (!ext) { this.sel.drawTo(ctx, 0, 0); return; }
        const part = this.sel.toCanvas(ext);
        try { ctx.drawImage(part, 0, 0); } finally { part.width = 1; part.height = 1; }
    }

    /** Delete the selected pixels of the active layer (Krita "Clear"); on a mask in edit mode it hides them. */
    clearSelectedPixels() {
        if (!this.sel || !this.getBounds()) { this.setStatus("Nothing selected. Make a selection first, invert it to keep only the selected part."); return; }
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("The base layer cannot be erased. Select a layer, or paint on the base first to get a layer."); return; }
        if (this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
        const onMask = !!(layer.maskPx && layer.maskEdit);
        if (layer.kind === "filter" && !onMask) { this.setStatus("Filter layers have no pixels. Use \"mask from selection\" to limit the filter instead."); return; }
        this.pushUndo(onMask ? { kind: "mask", id: layer.id, label: "Hide in mask" } : { kind: "layer", id: layer.id, label: "Clear pixels" });
        if (onMask) layer.maskPx = layer.maskPx.clone();   // replaced, as in fillSelection (rule 2)
        const target = onMask ? layer.maskPx : layer.px;
        const sel = this.sel;
        const reg = this.selectionWriteRegion(layer, target);   // null on canvases: the whole layer, as before
        if (!reg || reg.ext) {
            const part = reg ? sel.toCanvas(reg.ext) : null;
            try {
                target.drawInto(reg ? reg.box : null, (ctx) => {
                    ctx.globalCompositeOperation = "destination-out";
                    ctx.scale(target.width / layer.w, target.height / layer.h);   // composed (rule 12)
                    if (part) ctx.drawImage(part, reg.ext[0] - layer.x, reg.ext[1] - layer.y);
                    else sel.drawTo(ctx, -layer.x, -layer.y);
                });
            } finally {
                if (part) { part.width = 1; part.height = 1; }
            }
        }
        if (onMask) this.markMaskChanged(layer); else this.markLayerChanged(layer, reg && reg.ext ? clampRect(reg.box, target.width, target.height) : undefined);   // as in fillSelection
        this.draw();
        this.setStatus(`${layer.name}: selected ${onMask ? "part of the mask hidden" : "pixels cleared"}.`);
    }

    // ---- selection: grow / shrink / from layer ------------------------------

    growSelection(n) { return this.trackEdit(this.growSelectionNow(n)); }   // undo waits for it, as for feather

    async growSelectionNow(n) {
        if (!this.sel || !n) return;
        const W = this.width, H = this.height;
        const grow = n > 0, r = Math.abs(n);
        this.pushUndo({ kind: "selection", label: grow ? "Grow selection" : "Shrink selection" });
        const done = await this.selectionInWorker("grow", { n }, { halo: r + 2 });
        let bounds = done ? done.bounds : undefined;
        if (!done) {
            const img = this.sel.readRect(0, 0, W, H);
            bounds = growMaskBounds(img.data, W, H, n);
            this.sel.writeRect(img, 0, 0);
        }
        this.markSelectionChanged(bounds, done && done.box);
        this.draw();
        this.setStatus(`Selection ${grow ? "grown" : "shrunk"} by ${r}px.`);
    }

    selectionFromLayer() {
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("Select a layer first (the base is fully opaque)."); return; }
        this.pushUndo({ kind: "selection", label: "Selection from layer" });
        const tmp = makeCanvas(this.width, this.height);
        tmp.getContext("2d").drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        const src = tmp.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        const img = new ImageData(this.width, this.height);
        const d = img.data;
        for (let i = 0; i < src.length; i += 4) {
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = src[i + 3] > 127 ? 255 : 0;
        }
        this.sel.writeRect(img, 0, 0);
        this.markSelectionChanged();
        this.draw();
        this.setStatus(`Selection taken from ${layer.name}.`);
    }

    // ---- selection ops -----------------------------------------------------

    clearSelection() {
        if (!this.sel) return;
        this.selectionLabel = "";
        this.pushUndo({ kind: "selection", label: "Deselect" });
        this.sel.clear();
        this.markSelectionChanged(null);
        this.draw();
    }

    invertSelection() { return this.trackEdit(this.invertSelectionNow()); }   // undo waits for it, as for feather

    async invertSelectionNow() {
        if (!this.sel) return;
        this.pushUndo({ kind: "selection", label: "Invert selection" });
        // The inverse of a selection covers everything it does not, so no bounding box can help.
        // On tiles the mask inverts its own tiles (C5): the worker's route makes a canvas, an
        // ImageBitmap and a write-back scratch of the whole mask, three times 600 MB at 15k.
        if (isTilePixels(this.sel)) {
            this.sel.invert();
            this.markSelectionChanged();
            this.draw();
            return;
        }
        const done = await this.selectionInWorker("invert", {}, { whole: true });
        if (!done) {
            const data = this.sel.readRect(0, 0, this.width, this.height);
            invertMask(data.data);
            this.sel.writeRect(data, 0, 0);
        }
        this.markSelectionChanged(done ? done.bounds : undefined);
        this.draw();
    }

    /**
     * The selection changed. `bounds` is its new bounding box when the caller knows it
     * ([x0, y0, x1, y1] or null for an empty selection), `{ within: box }` when only a
     * rectangle holding it is known (a subtract: the old box), left out it is scanned for
     * on the next getBounds(). `rect` is the rectangle the pixels changed in (image
     * coordinates): the display levels are refreshed there instead of being rebuilt.
     */
    markSelectionChanged(bounds, rect) {
        if (bounds === undefined) {
            this.selectionDirty = true; this.selectionLoose = false;
        } else if (bounds && bounds.within) {
            this.cachedBounds = bounds.within;
            this.selectionDirty = true; this.selectionLoose = true;
        } else {
            this.cachedBounds = bounds;
            this.selectionDirty = false; this.selectionLoose = false;
        }
        this.selectionSeq++;
        this.selectionEncoded = false;
        if (rect) this.touchSourceRect(this.sel, rect[0], rect[1], rect[2], rect[3]);
        else this.touchSource(this.sel);
        this.uploaded.maskHash = null;
        this.renderInfo();
        this.drawThumb();
        this.notifyChanged();
    }

    markLayerChanged(layer, rect) {
        layer.dirty = true;
        layer._refAvatar = null;
        layer._maskedValid = false;
        layer._mcache = null;
        layer._mcacheView = null; layer._mcacheSample = null;
        layer._mstats = null;
        layer._mstatsSample = null; layer._mstatsSampleRun = null;
        layer._mstatsStack = null; layer._mstatsStackRun = null;
        layer.exportRef = null;
        // `rect` (in the layer pixels' own coordinates) keeps the cached levels and refreshes them there
        if (rect) this.touchSourceRect(layer.px, rect[0], rect[1], rect[2], rect[3]);
        else { this.touchSource(layer.px); this.scheduleDetachedRelease(); }   // a whole change may be new pixels (C6 a)
        this.touchSource(layer._masked);
        this.bumpComposite(layer, rect ? this.layerRectToImage(layer, layer.px, rect) : null);
        this.uploaded.controlHash = null;
        this.drawThumb();
        this.notifyChanged();
        this.scheduleAutosave();
    }
}

export function bindSelect(C) { InpaintEditor = C; }
