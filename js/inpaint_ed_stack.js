// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_stack.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the sampling stack and its band programs, floodStack, brushSource, passStores, readBox: moved out of inpaint_canvas.js (item 56 S5, docs/PLAN_SPLIT.md), text unchanged.

import { FILTERS, applyFilter } from "./inpaint_filters.js";
import { beginScope, endScope, glMaxSide, glReleaseLargeSurfaces, isGLSurface, readSurfaceBytes, releaseSurface, surfaceFromBytes } from "./inpaint_filters_gl.js";
import { OPS } from "./px/kernels.js";
import { tilesSource } from "./inpaint_raster.js";
import { EXPORT, INTERACTIVE } from "./inpaint_pool.js";
import { stackArgs, stackInArena, stackRows, storeArgs } from "./inpaint_bands.js";
import { compositeBox } from "./inpaint_boxstack.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { TILE_SIZE, isTilePixels } from "./inpaint_tiles.js";
import { editorPool, markStep } from "./inpaint_jobs.js";
import { nextPartsSeq, partsFailed, partsUsable } from "./inpaint_encode.js";
import { seedOfLayer } from "./blend_modes.js";
import { cpuDab, makeCanvas } from "./inpaint_consts.js";
import { NO_PROGRAM } from "./inpaint_load.js";

let InpaintEditor = null;

export class StackPart {
    /**
     * A canvas of the region `box` ([x0, y0, x1, y1] in image coordinates) of what the
     * bucket, wand and eyedropper look at, at `scale` pixels per image pixel: the visible
     * image composited for that box only (the same region pass the screen uses), or the
     * active layer alone. `opts` are drawComposite's (`forRun` leaves the helper layers out).
     */
    sampleRegion(source, box, scale, opts = {}) {
        const [x0, y0, x1, y1] = box;
        const w = Math.max(1, Math.round((x1 - x0) * scale)), h = Math.max(1, Math.round((y1 - y0) * scale));
        // C6 (c1): `pad` image pixels of the surroundings are composited too (clamped to the image), so a filter that reads
        // its neighbours sees them, and the canvas handed back is still the box: a CPU canvas, read back without a GPU wait
        // The margin is whole pixels of the canvas handed back on every side (clamped to the image), so the padded pass
        // samples on the unpadded one's grid and is drawn back at whole pixels: at a scale below 1 a margin of whole image
        // pixels put the box's picture up to half a pixel of the canvas off (the C6 c1 review). At 1 it is the same margin.
        const pad = source !== "layer" && opts.pad > 0 ? Math.ceil(opts.pad * scale) : 0;
        const kl = Math.min(pad, Math.floor(x0 * scale)), kt = Math.min(pad, Math.floor(y0 * scale));
        const kr = Math.min(pad, Math.floor((this.width - x1) * scale)), kb = Math.min(pad, Math.floor((this.height - y1) * scale));
        if (kl > 0 || kt > 0 || kr > 0 || kb > 0) {
            const pb = [x0 - kl / scale, y0 - kt / scale, x1 + kr / scale, y1 + kb / scale];
            const big = this.sampleRegion(source, pb, scale, { ...opts, pad: 0 });
            const c = makeCanvas(w, h);
            const cctx = c.getContext("2d", { willReadFrequently: true });
            cctx.drawImage(big, -kl, -kt);
            return c;
        }
        const c = makeCanvas(w, h);
        const ctx = c.getContext("2d");
        ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
        if (source === "layer") {
            const l = this.activeLayer();
            if (l && l.kind !== "filter" && l.px && isTilePixels(l.px) && !this.liveStrokeOn(l) && (!this.liveMask(l) || this.tileMaskOf(l))) {
                // C6 (c2b): the active layer on tiles from its own tiles at the pass's level, and its mask from the mask's
                // (the canvas holds this layer only, so a whole-canvas destination-in is the mask). layerPixels gave the
                // layer's display mirror, or `_masked` and two mirrors, and a Skia pyramid of it below half size: 0.57 to
                // 1.86 GB at 15000 x 10000 for an eyedropper click or a wand with the tool bar's Sample set to the layer.
                const vp = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, sx: scale, sy: scale, sample: true };
                ctx.imageSmoothingEnabled = true;
                this.drawPixelsInto(ctx, l, l.px, vp);
                if (this.liveMask(l)) {
                    ctx.globalCompositeOperation = "destination-in";
                    this.drawPixelsInto(ctx, l, l.maskPx, vp);
                    ctx.globalCompositeOperation = "source-over";
                }
                return c;
            }
            if (l && l.kind !== "filter" && l.px) {
                const px = this.layerPixels(l, true);
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(this.displaySource(px, (l.w * scale) / px.width), l.x, l.y, l.w, l.h);
                return c;
            }
        }
        const prev = this.viewPass;
        // `sample`: this pass keeps its own filter and match caches, the screen's stay
        // `display` (C6 c 7c): the screen's colour-match statistics read the levels the screen shows
        this.viewPass = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, sx: scale, sy: scale, sample: true, forRun: !!opts.forRun, display: !!opts.display };
        try {
            this.drawComposite(ctx, opts);
        } finally {
            this.viewPass = prev;
        }
        return c;
    }

    /**
     * How far around a pixel (in image pixels) the composite of the layers below `upTo` (all of them when null) reads,
     * for a read of `box` ([x0, y0, x1, y1]) at scale 1 that has to equal the full-resolution flatten there (C6 c1):
     * the sum of the visible filter layers' `reach` (a filter reads that far around each pixel of what is below it,
     * so the reaches of stacked filters add up). Infinity when a box of any margin cannot give those pixels: a filter
     * that does not say how far it reads (or depends on the picture's size, vignette, normalise, a frame), a
     * colour-matched layer near the box (its statistics are the whole layer's surroundings), or a layer drawn scaled,
     * at a fractional position or through a pending transform. Measured on tiles against the whole flatten: a text layer
     * (rendered at twice its size) 1 level at opacity 1 and 2 at 0.8 on its anti-aliased edge, a layer at a fractional
     * position 13 levels on its last column and row; unscaled layers at whole positions 0.
     */
    boxReach(box, { forRun = true, upTo = null, loose = false } = {}) {
        const end = upTo == null ? this.layers.length : Math.max(0, Math.min(this.layers.length, upTo));
        const shown = [];
        let reach = 0;
        for (let i = 0; i < end; i++) {
            const l = this.layers[i];
            if (this.compareShow && l.kind === "result" && l.id !== this.compareShow) continue;
            if ((!this.shown(l) && !(this.compareShow && l.id === this.compareShow)) || !l.px) continue;
            if (l.kind === "filter") {
                const def = FILTERS[l.filter];
                let r = def ? def.reach : 0;      // a filter that is not installed hands the picture on (applyFilter)
                if (typeof r === "function") { try { r = r(l.params || {}, { width: this.width, height: this.height }); } catch (_) { r = undefined; } }
                // `loose` (E5, a document larger than any canvas: there is no whole flatten to fall back to): a filter
                // that names no reach counts as pointwise, and the layers below are taken as a region pass draws them
                if (!(r >= 0) || !Number.isFinite(r)) { if (loose) continue; return Infinity; }
                reach += r;
                continue;
            }
            if (forRun && (this.isControl(l) || this.isReference(l))) continue;
            shown.push(l);
        }
        if (loose) return reach;
        const bs = this.basePx;
        if (bs && (bs.width !== this.width || bs.height !== this.height)) return Infinity;
        const b = [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach];
        for (const l of shown) {
            const near = l.x < b[2] && l.x + l.w > b[0] && l.y < b[3] && l.y + l.h > b[1];
            if (!near) continue;
            if (this.matchActive(l) || (this.pending && this.pending.layer === l)) return Infinity;
            const px = l.px;
            if (px.width !== l.w || px.height !== l.h || l.x !== Math.round(l.x) || l.y !== Math.round(l.y)) return Infinity;
        }
        return reach;
    }

    /**
     * The full-resolution composite as a plain stack the pool's workers can composite from the arena themselves
     * (docs/PLAN_BCE.md §3b, B item 1): `[{ px, mask, x, y, alpha, op }]`, the base first, or null when any layer the
     * composite shows needs more than its tiles at an opacity through a mask on its own grid, source-over or in its
     * blend mode (`op`, the kernel's number: B item 7): a filter layer, a transform in progress, a live
     * stroke, a scaled or fractional layer. The same layers in the same order as `drawLayersInto` draws them, and the
     * same exclusions as `boxReach`: this is a third walk of the stack, so it stays next to the second.
     *
     * `filters` (B item 7 part 2): a filter layer is an entry too, `{ filter, reach, mask, alpha, op }`, instead of the
     * end of the plan: the workers composite what is below it, the filter runs on the GPU over those bytes
     * (`programBand`), and what is above goes over the result in the workers again. Null then for a filter that names no
     * reach, a mask that is not the picture's tiles, and, as `applyFilterLayer` shows the layers unfiltered during a
     * gesture below a filter, for any gesture outside a run.
     *
     * A colour-matched layer (B item 7 part 3) is an entry with `match: layer`: `holdStack` takes its statistics from
     * point samples of the tiles (`stackMatches`) and the worker matches the layer's rows before it composites them.
     * Null for a matched layer above a filter layer (its statistics would need the filtered picture at the sample
     * points; the region pass keeps that case) and with `InpaintEditor.stackMatch === false`, the A/B switch.
     */
    stackPlan({ forRun = true, upTo = null, filters = false } = {}) {
        if (!this.tileMode || !this.base || !partsUsable() || !arenaEnabled() || InpaintEditor.bands === false || InpaintEditor.stacks === false) return null;
        const bs = this.basePx;
        if (!bs || !isTilePixels(bs) || bs.width !== this.width || bs.height !== this.height) return null;
        const out = [{ px: bs, mask: null, x: 0, y: 0, alpha: 255 }];
        const end = upTo == null ? this.layers.length : Math.max(0, Math.min(this.layers.length, upTo));
        let sawFilter = false;
        // clipping (PLAN_0_1_31 §6 step 3), as drawLayersInto: an entry clipped to its base's entry (`clip`), which the
        // consumers turn into a coverage (the base's alpha through its mask at its opacity) folded into the entry's mask
        const entryOf = new Map();
        for (let i = 0; i < end; i++) {
            const l = this.layers[i];
            if (this.compareShow && l.kind === "result" && l.id !== this.compareShow) continue;
            if ((!this.shown(l) && !(this.compareShow && l.id === this.compareShow)) || !l.px) continue;
            const cb = this.clipBaseOf(l, i);
            const clip = cb ? entryOf.get(cb) : null;
            if (cb && !clip) continue;
            if (l.kind === "filter") {
                if (!filters || InpaintEditor.stackFilters === false) return null;
                if (!forRun && ((this.pointer && this.pointer.layer) || this.pending)) return null;
                const def = FILTERS[l.filter];
                if (!def) continue;   // applyFilter hands the picture on
                let r = def.reach;
                if (typeof r === "function") { try { r = r(l.params || {}, { width: this.width, height: this.height }); } catch (_) { r = undefined; } }
                if (!(r >= 0) || !Number.isFinite(r)) return null;
                const fop = l.blend && l.blend !== "normal" ? OPS[l.blend] : 0;
                if (!(fop >= 0)) return null;
                const fm = this.liveMask(l) || null;
                if (fm && (!isTilePixels(fm) || fm.width !== this.width || fm.height !== this.height || (this.pointer && this.pointer.layer === l))) return null;
                const falpha = Math.round(Math.max(0, Math.min(1, l.opacity ?? 1)) * 255);
                if (falpha > 0) { out.push({ filter: l, reach: Math.ceil(r), mask: fm, alpha: falpha, op: fop, clip }); sawFilter = true; }
                continue;
            }
            if (forRun && (this.isControl(l) || this.isReference(l))) continue;
            let op = 0;
            let dissolve = null;
            if (l.blend === "dissolve") {
                dissolve = seedOfLayer(l.id);
                op = 0;
            } else {
                op = l.blend && l.blend !== "normal" ? OPS[l.blend] : 0;
                if (!(op >= 0) || (op && InpaintEditor.stackBlends === false)) return null;
            }
            const matched = this.matchActive(l);
            if (matched && (InpaintEditor.stackMatch === false || sawFilter)) return null;
            if ((this.pending && this.pending.layer === l) || this.liveStrokeOn(l)) return null;
            const px = l.px;
            if (!isTilePixels(px) || px.width !== l.w || px.height !== l.h || l.x !== Math.round(l.x) || l.y !== Math.round(l.y)) return null;
            const mask = this.liveMask(l) ? this.tileMaskOf(l) : null;
            if (this.liveMask(l) && !mask) return null;
            const alpha = Math.round(Math.max(0, Math.min(1, l.opacity ?? 1)) * 255);
            const entry = { px, mask, x: l.x, y: l.y, alpha, op, match: matched ? l : null, clip };
            if (dissolve !== null) entry.dissolve = dissolve;
            entryOf.set(l, entry);
            out.push(entry);
        }
        return out;
    }

    /**
     * `stackPlan` as a row source: `{ source, release() }`, or null. The pixels are held as copy-on-write clones from
     * now on, so the file is the picture of this moment whatever is painted while the workers read it.
     */
    async stackSource(opts = { forRun: true }) {
        const held = await this.holdStack(this.stackPlan(opts), { forRun: opts.forRun !== false });
        if (!held) return null;
        return { source: stackRows(this.width, this.height, held.stores), layers: held.stores.length - 1, release: held.release };
    }

    /**
     * A stack plan (its first entry, the base, may be null) held as clones the workers read by slot: `{ stores, release() }`,
     * or null when a tile is outside the arena. A plan with filter layers (`stackPlan`'s `filters`) is held as a program
     * instead: `{ steps, reach, forRun, release() }`, the steps in turn `{ stores, args }` (a run of layers: `stores[0]` the
     * base, or null above a filter) and `{ filter, plain, mask, alpha, op }`, `reach` the sum of the filters' (`programBand`).
     * The clones are taken at once; then the colour-match statistics of the plan's matched layers are read from them
     * (`stackMatches`, a pool job each), so the held stack is the picture of this moment, match included.
     */
    async holdStack(plan, { forRun = true, priority = EXPORT, group = null } = {}) {
        const version = this.compositeVersion;   // the clones' version: their statistics are stamped with it, whatever moves while the jobs run
        const held = this.holdStackNow(plan, { forRun });
        if (!held) return null;
        try { await this.stackMatches(held, { forRun, priority, group, version }); }
        catch (err) { held.release(); if (partsFailed(err)) return null; throw err; }
        return held;
    }

    holdStackNow(plan, { forRun = true } = {}) {
        if (!plan) return null;
        for (const s of plan) if (s && ((s.px && !stackInArena(s.px)) || (s.mask && !stackInArena(s.mask)))) return null;
        // a clipped entry's `clip` becomes the held store of its base (PLAN_0_1_31 §6 step 3); a base comes before its layers
        const heldOf = new Map();
        const hold = (s) => {
            if (!s) return s;
            const h = { snap: s.px.clone(), mask: s.mask ? s.mask.clone() : null, x: s.x, y: s.y, alpha: s.alpha, op: s.op | 0, layer: s.match || null, match: null, clip: s.clip ? heldOf.get(s.clip) || null : null, dissolve: s.dissolve ?? null };
            heldOf.set(s, h);
            return h;
        };
        if (!plan.some((s) => s && s.filter)) {
            const stores = plan.map(hold);
            return { stores, release() { for (const s of stores) if (s) { s.snap.release(); if (s.mask) s.mask.release(); } } };
        }
        const steps = [], clones = [];
        let run = null, reach = 0;
        plan.forEach((s, i) => {
            if (s && s.filter) {
                const mask = s.mask ? s.mask.clone() : null;
                if (mask) clones.push(mask);
                const clip = s.clip ? heldOf.get(s.clip) || null : null;
                const over = !!(FILTERS[s.filter.filter] && FILTERS[s.filter.filter].over);   // a fill layer goes over the band as a layer
                steps.push({ filter: s.filter, plain: !mask && s.alpha === 255 && !s.op && !clip && !over, mask, alpha: s.alpha, op: s.op | 0, clip });
                reach += s.reach;
                run = null;
                return;
            }
            const h = hold(s);
            if (h) { clones.push(h.snap); if (h.mask) clones.push(h.mask); }
            if (!run) { run = { stores: i === 0 ? [] : [null] }; steps.push(run); }
            run.stores.push(h);
        });
        for (const st of steps) if (st.stores) st.args = stackArgs(st.stores);
        return { steps, reach, forRun: !!forRun, free: [], b: null, timing: { bands: 0, pool: 0, upload: 0, filter: 0, read: 0 }, out: null, release() { for (const c of clones) c.release(); this.free = null; this.b = null; this.out = null; glReleaseLargeSurfaces(); } };
    }

    /**
     * The colour match of every matched layer of a held stack (B item 7 part 3): each store that came from a matched
     * layer (`layer`) gets `match`, the ten floats the worker's `matchPixels` takes (meanS, meanT, scale, k), or null
     * when there are no statistics (the layer is composited unmatched then, as the flatten draws it). In stack order,
     * so a matched layer below is matched in the backdrop of the one above. Matched layers are only in the first run
     * of a program (`stackPlan` turns a match above a filter away).
     */
    async stackMatches(held, { forRun = true, priority = EXPORT, group = null, version = this.compositeVersion } = {}) {
        const stores = held.steps ? held.steps[0].stores : held.stores;
        for (let i = 1; i < stores.length; i++) {
            const s = stores[i];
            if (!s || !s.layer) continue;
            s.match = await this.stackMatchOf(s, stores.slice(0, i), { forRun, priority, group, version });
        }
    }

    /**
     * The statistics of a matched layer for the worker path, from point samples of the tiles (the user's decision (b)
     * of C6 (c) 7c, 2026-09-18): the layer's own pixels through its mask and the composite of the held stores `below`
     * it, both at `matchGeometry`'s grid (256 px on the layer's long side with its padding, a sample at each picture
     * pixel's centre, nearest), gathered and composited by a pool worker (`stack_points`), the statistics by the
     * unchanged `statsOfMatch`. Measured against the whole flatten's statistics on eight photos: mean 0.56, at most
     * 8 to 9 levels in the matched layer (box means of the mip levels were 5.45 mean on a textured photo, and are not
     * used here). Kept per layer per change in `_mstatsStack` / `_mstatsStackRun` under the clones' `version` (a
     * change while the jobs run must not stamp them with the picture after it), forwarded like the sampled entries;
     * the strength is read at use time, so a tick keeps the entry.
     */
    async stackMatchOf(store, below, { forRun = true, priority = EXPORT, group = null, version = this.compositeVersion } = {}) {
        const layer = store.layer, m = layer.match || {};
        const k = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        const key = JSON.stringify([m.source, layer.x, layer.y, layer.w, layer.h]);
        const slot = forRun ? "_mstatsStackRun" : "_mstatsStack";
        const c = layer[slot];
        let stats;
        if (c && c.version === version && c.key === key) stats = c.stats;
        else {
            const { g, ld, bd } = await this.stackSamples(store, below, { priority, group });
            const lay = makeCanvas(g.pw, g.ph);
            lay.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(ld, g.pw, g.ph), 0, 0);
            stats = this.statsOfMatch(layer, lay, ld, bd, g.pad);
            layer[slot] = { version, key, stats };
        }
        if (!stats || !(k > 0)) return null;
        const p = [...stats.meanS, ...stats.meanT, ...stats.scale, k];
        return p.every(Number.isFinite) ? p : null;
    }

    /**
     * The point samples a matched layer's statistics are made from (`stackMatchOf`): `{ g, xs, ys, ld, bd }`, the
     * geometry (`matchGeometry`), the image pixels of the grid, the layer's own samples through its mask (`ld`) and the
     * composite of the held stores `below` at the same pixels (`bd`), `g.pw` × `g.ph` RGBA8 each. The grid is exact
     * integers: sample i is the centre of picture pixel i, `layer.x + floor(((2 (i − pad) + 1) w) / (2 sw))`, nearest,
     * a centre on a pixel boundary taking the right or lower pixel (a float grid took either neighbour by its last ulp
     * for layers whose side is a multiple of 512). The layer's own rows are not clamped to the image (`matchStats`
     * draws the whole layer picture); the stores below are sampled inside the image only, as the flatten shows them.
     */
    async stackSamples(store, below, { priority = EXPORT, group = null } = {}) {
        const layer = store.layer;
        const g = this.matchGeometry(layer);
        const xs = new Int32Array(g.pw), ys = new Int32Array(g.ph);
        for (let i = 0; i < g.pw; i++) xs[i] = layer.x + Math.floor(((2 * (i - g.pad) + 1) * layer.w) / (2 * g.sw));
        for (let j = 0; j < g.ph; j++) ys[j] = layer.y + Math.floor(((2 * (j - g.pad) + 1) * layer.h) / (2 * g.sh));
        const a = ys[0], b = ys[g.ph - 1] + 1;
        const own = stackArgs([null, { snap: store.snap, mask: store.mask, x: store.x, y: store.y, alpha: 255, op: 0 }])(a, b).layers[0] || null;
        const stack = stackArgs(below)(Math.max(0, a), Math.min(this.height, b));
        const r = await editorPool().run("stack_points", { xs: xs.buffer, ys: ys.buffer, image: [this.width, this.height], stack, layer: own }, [], { priority, group });
        return { g, xs, ys, ld: new Uint8ClampedArray(r.lay), bd: new Uint8ClampedArray(r.bel) };
    }

    /** The rows of a band of a held program (`holdStack`), so that a band with its margins stays a texture of 24 MP: whole tiles, 256 to 2,048. Zero when the GPU cannot take the picture's width. */
    programRows(prog, width) {
        const max = glMaxSide(), pw = Math.min(this.width, width + 2 * prog.reach);
        if (!max || pw > max) return 0;
        const rows = Math.floor((24e6 / pw - 2 * prog.reach) / TILE_SIZE) * TILE_SIZE;
        return Math.max(TILE_SIZE, Math.min(2048, rows, Math.floor((max - 2 * prog.reach) / TILE_SIZE) * TILE_SIZE));
    }

    /** One filter layer over `input` (a surface or a canvas of a band whose corner is `origin` in the picture), as `filteredCanvas` runs it in a pass at full resolution; the input again when the filter gave nothing. */
    bandFilter(layer, input, origin, forRun) {
        if (!layer._fxCacheSample) layer._fxCacheSample = {};
        const info = this.filterInfo(layer, {
            scale: 1,
            origin,
            full: [this.width, this.height],
            forRun: !!forRun,
            cache: layer._fxCacheSample,
            chain: "bands",
            site: "bandFilter",
        });
        let out = null;
        beginScope();
        try { out = applyFilter(layer.filter, input, layer.params, info); }
        catch (err) { console.error(err); }
        out = endScope(out);
        return out || input;
    }

    /**
     * The pixels of `box` ([x0, y0, x1, y1], inside the image) of a held program (B item 7 part 2) as RGBA8, into `into` or
     * into the program's own array (good until the next band is read): the box with the filters' reach around it is composited by the pool into a shared buffer
     * (`stack_into`, a tile row a job), goes to the GPU as a texture, through the filter layers one after the other, and
     * comes back once (`readPixels`); layers above a filter, and a filter at an opacity, in a blend mode or through a
     * mask, are composited over what came back by the pool again. No canvas on the way unless a filter makes one (a
     * blur goes through `ctx.filter`). Throws NO_PROGRAM when the GPU path is not there: the caller takes the old way.
     * `programStart` is the part that needs no GPU (the layers below the first filter), so a reader of band after band
     * (`programReader`) has the pool composite the next band while this thread filters and reads this one.
     */
    async programBand(prog, box, into = null, opts = {}) {
        return this.programFinish(prog, this.programStart(prog, box, opts), into, opts);
    }

    /** `{ read(box, into, next) }`: `programBand`, with the band `next` started before this one goes to the GPU. */
    programReader(prog, opts = {}) {
        let ahead = null;
        const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
        return {
            read: async (box, into = null, next = null) => {
                const cur = ahead && same(ahead.box, box) ? ahead : this.programStart(prog, box, opts);
                ahead = next ? this.programStart(prog, next, opts) : null;
                return this.programFinish(prog, cur, into, opts);
            },
        };
    }

    programStart(prog, box, { priority = EXPORT, group = null } = {}) {
        const W = this.width, H = this.height, R = prog.reach;
        const [bx, by, bx1, by1] = box, w = bx1 - bx, h = by1 - by;
        const kl = Math.min(R, bx), kt = Math.min(R, by), kr = Math.min(R, W - bx1), kb = Math.min(R, H - by1);
        const px0 = bx - kl, py0 = by - kt, pw = w + kl + kr, ph = h + kt + kb, bytes = pw * ph * 4;
        if (!prog.free) prog.free = [];
        const at = prog.free.findIndex((s) => s.byteLength >= bytes);
        // a buffer that comes back from a band before is cleared by the jobs that fill it, row by row, in the pool
        const used = at >= 0;
        const sab = used ? prog.free.splice(at, 1)[0] : new SharedArrayBuffer(bytes);
        const pool = editorPool();
        const composite = async (args, clear = false) => {
            const jobs = [];
            for (let yy = py0; yy < py0 + ph;) {
                const n = Math.min(TILE_SIZE - (yy % TILE_SIZE), py0 + ph - yy);
                const stack = args(yy, yy + n);
                if (clear || stack.base || stack.layers.length) jobs.push(pool.run("stack_into", { sab, w: pw, x0: px0, y0: py0, y: yy, rows: n, stack, clear }, [], { priority, group }));
                yy += n;
            }
            await Promise.all(jobs);
        };
        const lead = prog.steps[0].stores ? 1 : 0;
        if (!lead && used) new Uint8Array(sab, 0, bytes).fill(0);
        const first = lead ? composite(prog.steps[0].args, used) : Promise.resolve();
        first.catch(() => 0);   // the failure is seen where the band is finished
        return { box, sab, bytes, w, h, kl, kt, px0, py0, pw, ph, lead, first, composite };
    }

    async programFinish(prog, s, into = null, { timing = null } = {}) {
        const W = this.width, H = this.height;
        const { sab, bytes, w, h, kl, kt, px0, py0, pw, ph } = s;
        const A = new Uint8Array(sab, 0, bytes);
        const free = (v) => { if (isGLSurface(v)) releaseSurface(v); };
        const read = (v, x, y, rw, rh, out) => {
            if (isGLSurface(v)) { if (!readSurfaceBytes(v, x, y, rw, rh, out)) throw new Error(NO_PROGRAM); return; }
            const c = document.createElement("canvas");
            c.width = rw; c.height = rh;
            const cx = c.getContext("2d", { willReadFrequently: true });
            try { cx.globalCompositeOperation = "copy"; cx.drawImage(v, -x, -y); out.set(cx.getImageData(0, 0, rw, rh).data); } finally { c.width = 1; c.height = 1; }
        };
        let gpu = null;   // the picture so far while it is with the filters (a surface, or a filter's canvas); else it is in A
        // where a band's time goes, summed over the bands (ms): waiting for the pool, the upload and the filters' calls, the
        // reads; into the reader's own `timing` when it has one (fillBoxFromStack's, the K0b harness), else the program's
        const T = timing || prog.timing, now = () => performance.now();
        const timed = (key, fn) => { const t0 = now(); try { return fn(); } finally { T[key] += now() - t0; } };
        const readT = (...a) => timed("read", () => read(...a));
        T.bands++;
        try {
            let t0 = now();
            await s.first;
            T.pool += now() - t0;
            for (const st of prog.steps.slice(s.lead)) {
                if (st.stores) {
                    if (gpu) { readT(gpu, 0, 0, pw, ph, A); free(gpu); gpu = null; }
                    t0 = now();
                    await s.composite(st.args);
                    T.pool += now() - t0;
                    continue;
                }
                const below = !gpu;   // what the filter reads is still in A
                const input = gpu || timed("upload", () => surfaceFromBytes(A, pw, ph));
                if (!input) throw new Error(NO_PROGRAM);
                gpu = input;
                const out = timed("filter", () => this.bandFilter(st.filter, input, [px0, py0], prog.forRun));
                if (st.plain) { if (out !== input) free(input); gpu = out; continue; }
                // at an opacity, in a blend mode or through a mask: the filtered band over the band it was made from
                if (!prog.b || prog.b.byteLength < bytes) prog.b = new SharedArrayBuffer(bytes);
                if (!below) readT(input, 0, 0, pw, ph, A);
                readT(out, 0, 0, pw, ph, new Uint8Array(prog.b, 0, bytes));
                if (out !== input) free(out);
                free(input); gpu = null;
                t0 = now();
                await s.composite(stackArgs([null, { sab: prog.b, mask: st.mask, x: 0, y: 0, w: W, h: H, alpha: st.alpha, op: st.op, clip: st.clip }]));
                T.pool += now() - t0;
            }
            // without `into` the bytes are the program's own, good until the next band is read (`bandRows` has copied its parts by then)
            if (!into && (!prog.out || prog.out.length < w * h * 4)) prog.out = new Uint8Array(w * h * 4);
            const dst = into || prog.out.subarray(0, w * h * 4);
            if (gpu) readT(gpu, kl, kt, w, h, dst);
            else timed("read", () => {
                if (w === pw) dst.set(A.subarray(kt * pw * 4, (kt + h) * pw * 4));
                else for (let y = 0; y < h; y++) dst.set(A.subarray(((kt + y) * pw + kl) * 4, ((kt + y) * pw + kl + w) * 4), y * w * 4);
            });
            // the program's own bytes go out as `getImageData` gives them (a flatten writes them into tiles as ImageData)
            return into ? dst : new Uint8ClampedArray(dst.buffer, dst.byteOffset, dst.length);
        } finally {
            free(gpu);
            if (prog.free && prog.free.length < 2) prog.free.push(sab);
        }
    }

    /**
     * What the wand and the bucket look at (`sample`: "image" or "layer") as a stack plan, when the workers can
     * composite it from tiles (B item 2), else null and `sampleRegion` draws it. The branches are `sampleRegion`'s: the
     * active layer alone, through its mask, over nothing; or the visible image, helper layers included.
     */
    floodStack(sample) {
        if (InpaintEditor.stacks === false || !this.tileMode || this.huge || !partsUsable() || !arenaEnabled()) return null;
        if (sample === "layer") {
            const l = this.activeLayer();
            if (l && l.kind !== "filter" && l.px) {
                const plain = isTilePixels(l.px) && !this.liveStrokeOn(l) && (!this.liveMask(l) || this.tileMaskOf(l)) && l.px.width === l.w && l.px.height === l.h && l.x === Math.round(l.x) && l.y === Math.round(l.y);
                return plain ? [null, { px: l.px, mask: this.liveMask(l) ? this.tileMaskOf(l) : null, x: l.x, y: l.y, alpha: 255 }] : null;
            }
        }
        return this.stackPlan({ forRun: false, filters: true });
    }

    /**
     * Where a brush that reads the picture reads it (PLAN_0_1_31 §4 step 2), chosen once at the press, before
     * `this.pointer` is set: `{ tier, read(box, slot) }`. `read` gives `{ canvas, x, y }`, a canvas whose (0, 0) is the
     * image point (x, y) and that covers `box` ([x0, y0, x1, y1] in image pixels) clamped to the picture, or null when
     * the box lies outside it; `slot` (0, 1) keeps two reads of one move apart (heal's source and destination). `sample`:
     * "layer" (`layer` alone through its mask over nothing, as the wand's and the bucket's "layer"), "below" (the picture
     * up to and including `layer`) or "all" (the visible picture with the helper layers, as `compositeCanvas` draws it).
     * Clone and heal flattened the whole picture at every press before (0.5 to 1.7 s at 15000 x 10000, 1.1 GB of
     * mirrors), the smudge read the layer's whole mirror at every step (0.2 to 8 s a move).
     *
     * Tier "tiles": `stackPlan`'s stack (for "layer" the layer alone, as `floodStack`), composited under the box by
     * `compositeBox` from the tiles, nothing that grows with the document. The stores are read where they are, not held:
     * a clone or heal stroke writes into its stroke buffer until the release, so what it reads stays the press's picture,
     * and a smudge reads what its own steps wrote. A colour-matched layer is matched with the statistics the sampled
     * passes use, taken here (`boxMatchOf`). The kernel's composite may differ from Canvas 2D's by a level or two in a
     * blend mode (CLAUDE.md "three roundings"). Tier "region" (the canvas backend, a filter layer, a scaled, fractional or
     * text layer, a pending transform, or `InpaintEditor.regionalBrushes === false`, the A/B switch): `readBox` or
     * `sampleRegion("layer")`, the Canvas 2D picture, read as if no gesture ran (a region pass during a stroke draws the
     * stroke into its layer, leaves the filters above it out and the target unmatched). Where `boxReach` is infinite
     * that is the cached whole flatten, as before; a smudge reading it sees the press's picture, not its own steps.
     */
    brushSource(sample, layer, { snapshot = false } = {}) {
        const idx = layer ? this.layers.indexOf(layer) : -1;
        const upTo = sample === "below" && idx >= 0 ? idx + 1 : null;
        const clampBox = (box) => {
            const b = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1])), Math.min(this.width, Math.ceil(box[2])), Math.min(this.height, Math.ceil(box[3]))];
            return b[2] > b[0] && b[3] > b[1] ? b : null;
        };
        const region = (box) => {
            const b = clampBox(box);
            if (!b) return null;
            const keep = this.pointer;
            this.pointer = null;
            try {
                const canvas = sample === "layer" ? this.sampleRegion("layer", b, 1) : this.readBox(b, upTo == null ? { forRun: false } : { forRun: false, upTo });
                return { canvas, x: b[0], y: b[1] };
            } finally { this.pointer = keep; }
        };
        let plan = null;
        if (InpaintEditor.regionalBrushes !== false && this.tileMode) {
            if (sample === "layer") {
                const l = layer;
                if (l && l.kind !== "filter" && l.px && isTilePixels(l.px) && (!this.liveMask(l) || this.tileMaskOf(l)) && l.px.width === l.w && l.px.height === l.h && l.x === Math.round(l.x) && l.y === Math.round(l.y))
                    plan = [null, { px: l.px, mask: this.liveMask(l) ? this.tileMaskOf(l) : null, x: l.x, y: l.y, alpha: 255, op: 0 }];
            } else plan = this.stackPlan({ forRun: false, upTo });
        }
        // `snapshot` on the region tier (the canvas backend, and tiles under a filter layer or a scaled one), which reads
        // the live picture: the press's picture kept pixel by pixel as the stroke first reads it. A dab reads its box
        // before it writes there, so the first read of a pixel is its value at the press; the memory grows with the
        // ground the stroke covers, in 256 px blocks, not with the document (a stroke of dodge compounded to white)
        const firstRead = snapshot ? new Map() : null;
        const remember = (bytes, box) => {
            const w = box[2] - box[0], x0 = Math.max(0, box[0]), x1 = Math.min(this.width, box[2]);
            for (let iy = Math.max(0, box[1]); iy < Math.min(this.height, box[3]); iy++) {
                for (let ix = x0; ix < x1;) {
                    const key = (iy >> 8) * 65536 + (ix >> 8), n = Math.min(x1 - ix, 256 - (ix & 255));
                    let blk = firstRead.get(key);
                    if (!blk) firstRead.set(key, blk = { px: new Uint8ClampedArray(256 * 256 * 4), known: new Uint8Array(256 * 256) });
                    for (let k = 0, bi = (iy & 255) * 256 + (ix & 255), si = ((iy - box[1]) * w + ix - box[0]) * 4; k < n; k++, bi++, si += 4) {
                        if (blk.known[bi]) { bytes[si] = blk.px[bi * 4]; bytes[si + 1] = blk.px[bi * 4 + 1]; bytes[si + 2] = blk.px[bi * 4 + 2]; bytes[si + 3] = blk.px[bi * 4 + 3]; }
                        else { blk.known[bi] = 1; blk.px[bi * 4] = bytes[si]; blk.px[bi * 4 + 1] = bytes[si + 1]; blk.px[bi * 4 + 2] = bytes[si + 2]; blk.px[bi * 4 + 3] = bytes[si + 3]; }
                    }
                    ix += n;
                }
            }
            return bytes;
        };
        // the region pass as bytes of the box (zeros where it lies outside the picture)
        const rawBytes = (box) => {
            const w = box[2] - box[0], h = box[3] - box[1];
            const c = this._brushBytes = cpuDab(this._brushBytes, w, h);
            const ctx = c.getContext("2d");
            ctx.clearRect(0, 0, w, h);
            const got = region(box);
            if (got) ctx.drawImage(got.canvas, got.x - box[0], got.y - box[1]);
            return ctx.getImageData(0, 0, w, h).data;
        };
        const regionBytes = (box) => {
            if (!firstRead) return rawBytes(box);
            // a spatial filter above (a blur's radius, `boxReach`) carries a dab's write that far past its box: those
            // pixels are remembered with this read, before the write lands (infinite reach reads the press's flatten)
            const R = Math.ceil(this.boxReach(box, upTo == null ? { forRun: false } : { forRun: false, upTo }));
            if (!(R > 0) || !Number.isFinite(R)) return remember(rawBytes(box), box);
            const pb = [box[0] - R, box[1] - R, box[2] + R, box[3] + R], pw = pb[2] - pb[0];
            const big = remember(rawBytes(pb), pb), w = box[2] - box[0], h = box[3] - box[1], out = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) out.set(big.subarray(((y + R) * pw + R) * 4, ((y + R) * pw + R + w) * 4), y * w * 4);
            return out;
        };
        // the same as a canvas (a scaled layer's smudge draws from it): through the bytes when the press is kept
        const regionRead = !firstRead ? region : (box, slot = 0) => {
            const b = clampBox(box);
            if (!b) return null;
            const w = b[2] - b[0], h = b[3] - b[1], bytes = regionBytes(b);
            const reads = this._brushRead || (this._brushRead = []);
            const c = reads[slot] = cpuDab(reads[slot], w, h);
            c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, w * h * 4), w, h), 0, 0);
            return { canvas: c, x: b[0], y: b[1] };
        };
        if (!plan) return { tier: "region", read: regionRead, bytes: regionBytes, release() { if (firstRead) firstRead.clear(); } };
        // `snapshot`: the stores as copy-on-write clones of the press (blur, sharpen, the tone brush), given back by
        // `release`; the region tier keeps the press by first reads (above)
        const clones = [];
        const held = (s) => { if (!snapshot || !s) return s; const c = s.clone(); clones.push(c); return c; };
        // a clipped entry's `clip` becomes its base's mapped entry (held clones included), as `holdStackNow` does; a base
        // comes before its layers. `dissolve` (the layer's seed) goes on: without it compositeBox drew a dissolve layer as
        // a smooth normal blend at its opacity, and clipped layers over their whole extent, where the screen shows dots
        // and the base's coverage (the canvas backend's region read did, so the two backends wrote different pixels)
        const mapped = new Map();
        const stack = plan.map((s) => {
            if (!s) return s;
            const e = { px: held(s.px), mask: held(s.mask || null), x: s.x, y: s.y, alpha: s.alpha, op: s.op | 0, match: s.match ? this.boxMatchOf(s.match) : null, clip: s.clip ? mapped.get(s.clip) || null : null, dissolve: s.dissolve ?? null };
            mapped.set(s, e);
            return e;
        });
        const src = {
            tier: "tiles",
            read: (box, slot = 0) => {
                if (src.tier !== "tiles") return regionRead(box, slot);
                const b = clampBox(box);
                if (!b) return null;
                const w = b[2] - b[0], h = b[3] - b[1];
                let bytes;
                // a store given back while the gesture ran (an agent's undo): the rest of the gesture reads the region pass
                try { bytes = compositeBox(stack, b[0], b[1], w, h, this.width, this.height); }
                catch (err) { console.warn("Inpaint Canvas: the brush's tile read failed, reading the region pass:", err); src.tier = "region"; return regionRead(box, slot); }
                const reads = this._brushRead || (this._brushRead = []);
                const c = reads[slot] = cpuDab(reads[slot], w, h);
                c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, w * h * 4), w, h), 0, 0);
                return { canvas: c, x: b[0], y: b[1] };
            },
            release() { for (const c of clones.splice(0)) c.release(); if (firstRead) firstRead.clear(); },
            // the box as straight RGBA8 (whole image pixels; transparent outside the picture), valid until the next read:
            // the smudge takes the composite as bytes, no canvas between
            bytes: (box) => {
                if (src.tier === "tiles") {
                    try { return compositeBox(stack, box[0], box[1], box[2] - box[0], box[3] - box[1], this.width, this.height); }
                    catch (err) { console.warn("Inpaint Canvas: the brush's tile read failed, reading the region pass:", err); src.tier = "region"; }
                }
                return regionBytes(box);
            },
        };
        return src;
    }

    /** The ten floats a colour-matched layer is matched with in `compositeBox` (as `stackMatchOf` gives the workers), from the statistics the sampled passes use; null for no match. */
    boxMatchOf(layer) {
        const m = layer.match || {};
        const k = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        if (!(k > 0)) return null;
        const stats = this.sampledMatchStats(layer, false, false);
        if (!stats) return null;
        const p = [...stats.meanS, ...stats.meanT, ...stats.scale, k];
        return p.every(Number.isFinite) ? p : null;
    }

    /**
     * The flood over `box` (on the tile grid, inside the image) of a held stack, without a canvas (B item 2): the pool
     * composites the box from the tiles into one shared buffer, a tile row a job, and one worker floods it there. The
     * answer is `floodShape`'s, with `tiles` in place of `shape` when `o.tiles` asks for the selection's tiles. Null when
     * it cannot be done this way (too large for one buffer, no kernels, a failed job): the caller takes the canvases.
     */
    async floodOverTiles(held, box, x, y, o) {
        const [bx, by, bx1, by1] = box, w = bx1 - bx, h = by1 - by;
        if (!(w > 0 && h > 0) || w * h * 4 > 0x7fffffff) return null;
        const pool = editorPool(), group = "flood" + nextPartsSeq();
        let selSnap = null;
        try {
            const sab = new SharedArrayBuffer(w * h * 4);
            if (!(await this.fillBoxFromStack(held, box, sab, { priority: INTERACTIVE, group }))) return null;
            let sel = null;
            if (o.clip && this.getBounds()) {
                if (!stackInArena(this.sel)) return null;
                selSnap = this.sel.clone();
                sel = storeArgs(selSnap, 0, 0, by, by1);
            }
            const r = await pool.run("flood", { sab, w, h, x0: bx, y0: by, x: x - bx, y: y - by, tolerance: o.tolerance, contiguous: o.contiguous, color: o.color, sel, out: o.tiles ? "tiles" : "bitmap" }, [], { priority: INTERACTIVE, group, timeout: 300000 });
            return { shape: r.bitmap || null, tiles: r.tiles || null, count: r.count, bounds: r.bounds, touches: r.touches, close: !!r.bitmap };
        } catch (err) {
            pool.cancel(group);
            if (!partsFailed(err) && !String(err && err.message).includes(NO_PROGRAM)) console.warn("Inpaint Canvas: the region over tiles failed, using the canvases:", (err && err.message) || err);
            return null;
        } finally {
            if (selSnap) selSnap.release();
        }
    }

    /**
     * The box ([x0, y0, x1, y1], inside the image) of a held stack composited into `sab` (RGBA, the box's width, as
     * `getImageData` gives it): the pool fills it from the tiles, a tile row a job; a stack with filter layers goes band
     * by band through the GPU (B item 7 part 2). False when the program cannot take a band of that width.
     */
    async fillBoxFromStack(held, box, sab, { priority = INTERACTIVE, group = null } = {}) {
        const [bx, by, bx1, by1] = box, w = bx1 - bx;
        if (held.steps) {
            // B item 7 part 2: filter layers in the stack: band by band through the GPU, each band's rows into the buffer.
            // The K0b harness (docs/PLAN_WASM_BUILD.md §4.12): this box's split as marks, from the reader's own timing
            markStep("program", "start");
            const timing = { bands: 0, pool: 0, upload: 0, filter: 0, read: 0 };
            const rows = this.programRows(held, w);
            if (!rows) { markStep("program", "done", { ...timing, rows }); return false; }
            const reader = this.programReader(held, { priority, group, timing });
            const done = (extra) => markStep("program", "done", { ...Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])), rows, ...extra });
            try {
                for (let yy = by; yy < by1; yy += rows) {
                    const y1 = Math.min(by1, yy + rows);
                    await reader.read([bx, yy, bx1, y1], new Uint8Array(sab, (yy - by) * w * 4, (y1 - yy) * w * 4), y1 < by1 ? [bx, y1, bx1, Math.min(by1, y1 + rows)] : null);
                }
            } catch (err) {
                // the callers fall back to the canvases and return normally: the run still gets its end
                done({ failed: true });
                throw err;
            }
            done(null);
            return true;
        }
        const pool = editorPool(), args = stackArgs(held.stores);
        const jobs = [];
        for (let yy = by; yy < by1;) {
            const n = Math.min(TILE_SIZE - (yy % TILE_SIZE), by1 - yy);
            jobs.push(pool.run("stack_into", { sab, w, x0: bx, y0: by, y: yy, rows: n, stack: args(yy, yy + n) }, [], { priority, group }));
            yy += n;
        }
        await Promise.all(jobs);
        return true;
    }

    /**
     * The stack a run composites its box from, held now (`holdStack`: copy-on-write clones taken before this returns its
     * promise, so the picture is the one of this moment whatever the window does while the crop is planned), for
     * `readBoxBytes`' `held`; the caller releases it. Resolves to null when the stack cannot be held.
     */
    holdRunStack({ forRun = true, priority = INTERACTIVE } = {}) {
        if (!this.tileMode || this.huge || InpaintEditor.boxOverTiles === false) return Promise.resolve(null);
        return this.holdStack(this.stackPlan({ forRun, filters: true }), { forRun, priority }).catch(() => null);
    }

    /**
     * The box ([x0, y0, x1, y1]) of the full-resolution composite a run sees as RGBA bytes, `{ data, width, height, how }`,
     * without holding the window where it can be (docs/BUGS.md, a provider run's crop): the stack the tile workers
     * composite (`stackPlan`: a colour-matched layer with its statistics from point samples of the tiles, filter layers
     * over worker-composited bands; `how` "stack" or "program"), else `readBox` or the canvas backend's flatten, read
     * once ("canvas"). `data` may be a view on a SharedArrayBuffer (no ImageData over it; the stitch worker copies it).
     */
    async readBoxBytes(box, { forRun = true, priority = INTERACTIVE, held: given = undefined } = {}) {
        const [bx, by, bx1, by1] = box, w = bx1 - bx, h = by1 - by;
        if (!(w > 0 && h > 0)) throw new Error("an empty box");
        await this.relightIdle();   // relight's full shadow maps, not the quick map of a light on the move (F2.7)
        if (this.tileMode && !this.huge && w * h * 4 <= 0x7fffffff && InpaintEditor.boxOverTiles !== false) {
            // `held`: the stack taken earlier by `holdRunStack` (the caller releases it); else held here, now
            const held = given !== undefined ? await given : await this.holdStack(this.stackPlan({ forRun, filters: true }), { forRun, priority });
            if (held) {
                const group = "box" + nextPartsSeq();
                try {
                    const sab = new SharedArrayBuffer(w * h * 4);
                    if (await this.fillBoxFromStack(held, box, sab, { priority, group })) return { data: new Uint8ClampedArray(sab), width: w, height: h, how: held.steps ? "program" : "stack" };
                } catch (err) {
                    editorPool().cancel(group);
                    if (!partsFailed(err) && !String(err && err.message).includes(NO_PROGRAM)) console.warn("Inpaint Canvas: the box over tiles failed, using the canvases:", (err && err.message) || err);
                } finally {
                    if (given === undefined) held.release();
                }
            }
        }
        const c = makeCanvas(w, h);
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (this.tileMode) ctx.drawImage(this.readBox(box, { forRun }), 0, 0);
        else ctx.drawImage(this.flattenToCanvas({ forRun }), bx, by, w, h, 0, 0, w, h);
        try { return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, how: "canvas" }; } finally { c.width = 1; c.height = 1; }
    }

    /**
     * The wand's answer as tiles of the selection (`floodOverTiles` with `tiles`), written into the mask.
     */
    applyTilesToSelection(tiles, mode = "replace", box = null, at = [0, 0]) {
        return this.combineSelection(tilesSource(tiles, at, box), mode, {
            label: "Magic wand",
            box: box || (tiles.length ? [at[0], at[1], at[0] + 1, at[1] + 1] : null),
        });
    }

    /**
     * The pixels of `box` ([x0, y0, x1, y1], whole image pixels inside the image) as the full-resolution flatten has
     * them (C6 c1), as a CPU canvas of the box: a region pass at level 0 over the box with a margin as wide as
     * `boxReach` says, or, when no margin can give them, the box cut out of the whole flatten (`compositeCanvas`,
     * kept until the composite changes). `upTo` stops before that layer index. Byte for byte on a stack of
     * pointwise layers; a blur in the stack reads the same pixels, and Skia's blur of a smaller canvas comes out up to
     * 1 to 3 levels apart (measured, docs/PLAN_BCE.md §C6 c1).
     */
    /**
     * The tile stores a sampled pass over `box` at `scale` would read, each with the level it is read at and the
     * rectangle of its own pixels the pass shows (C6 c3): the base and every layer the pass draws, with its mask.
     * The same layers, in the same order, as `drawLayersInto`, and the same level and rectangle as `drawTilesInto`.
     * A store missed here is not an error - its chains are built where they are read, as they were before - so this
     * stays a plain walk of the stack rather than a second copy of the pass. A store named here that the pass does
     * NOT read from tiles is worse than a miss: the read waits for chains nothing uses. So the branches `drawLayer`
     * takes (a colour match, a live stroke, a mask off the tile grid) are repeated here, and `forRun` defaults the
     * way `drawLayersInto` defaults it.
     */
    passStores(source, box, scale, { forRun = false, upTo = null, baseOnly = false, controlOnly = false, skipFilters = false } = {}) {
        const skip = skipFilters;
        const out = [];
        const vp = { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1], sx: scale, sy: scale };
        const add = (px, x, y, w, h) => {
            if (!px || !isTilePixels(px) || !w || !h) return;
            const fx = w / px.width, fy = h / px.height;
            if (!(fx > 0) || !(fy > 0)) return;
            out.push({ px, level: this.tileLevel(fx * scale), rect: [(vp.x - x) / fx, (vp.y - y) / fy, (vp.x + vp.w - x) / fx, (vp.y + vp.h - y) / fy] });
        };
        if (source === "layer") {
            // the same branch `sampleRegion` takes: the active layer alone, with its mask
            const l = this.activeLayer();
            if (l && l.kind !== "filter" && l.px && !this.liveStrokeOn(l) && (!this.liveMask(l) || this.tileMaskOf(l))) {
                add(l.px, l.x, l.y, l.w, l.h);
                add(this.liveMask(l), l.x, l.y, l.w, l.h);
            }
            return out;
        }
        if (!controlOnly) add(this.basePx, 0, 0, this.width, this.height);
        const end = baseOnly || controlOnly ? 0 : upTo == null ? this.layers.length : Math.max(0, Math.min(this.layers.length, upTo));
        const drawn = new Set();
        for (let i = 0; i < end; i++) {
            const layer = this.layers[i];
            if (this.compareShow && layer.kind === "result" && layer.id !== this.compareShow) continue;
            if ((!this.shown(layer) && !(this.compareShow && layer.id === this.compareShow)) || !layer.px) continue;
            const cb = controlOnly ? null : this.clipBaseOf(layer, i);
            if (cb && !drawn.has(cb)) continue;
            if (skip && layer.clip) {
                const target = controlOnly ? null : this.clipTargetOf(layer, i);
                if (target && target.kind === "filter" && !drawn.has(target)) continue;
            }
            if (layer.kind === "filter") {
                if (!controlOnly && !skip) {
                    add(this.liveMask(layer), 0, 0, this.width, this.height);
                    drawn.add(layer);
                }
                continue;
            }
            if (forRun && (this.isControl(layer) || this.isReference(layer))) continue;
            drawn.add(layer);
            // only the layers `drawLayer` really draws from tiles in a region pass. A colour-matched layer off tiles
            // (`layerMatchedPixels`), a layer under a live paint stroke and one whose mask is not on the same
            // tile grid are composed from a canvas instead, so priming them would buy a wait and nothing else.
            // A colour-matched layer on tiles reads its tiles at the pass's level (C6 c 7b, `matchedRegionView`).
            const gesture = this.pointer && this.pointer.layer === layer;
            if (this.matchActive(layer) && !gesture && !this.matchFromTiles(layer)) continue;
            if (this.liveStrokeOn(layer)) continue;
            if (this.liveMask(layer) && !this.tileMaskOf(layer)) continue;
            add(layer.px, layer.x, layer.y, layer.w, layer.h);
            add(this.liveMask(layer), layer.x, layer.y, layer.w, layer.h);
        }
        return out;
    }

    /**
     * Ask the mips worker for every chain a sampled pass over `box` at `scale` needs, and resolve when they have
     * landed (C6 c3). Resolves with the jobs, whose `release()` the caller owes after the read; resolves at once with
     * an empty list on the canvas backend, without a worker, or for a pass at level 0 (which reads no chain).
     */
    async primePass(source, box, scale, opts = {}) {
        if (!this.tileMode) return [];
        // the pass `sampleRegion` really runs is the padded one (it recurses with the wider box), so prime that
        const pad = source !== "layer" && opts.pad > 0 ? opts.pad : 0;
        const b = pad ? [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] : box;
        const stores = this.passStores(source, b, scale, opts);
        if (!stores.length) return [];
        const jobs = await Promise.all(stores.map((st) => st.px.primeRegion(st.rect, st.level)));
        return jobs.filter((j) => j && j.live);
    }

    /**
     * `sampleRegion`, with the chains it needs built in the mips worker instead of on this thread (C6 c3). The
     * picture is `sampleRegion`'s, exactly; what changes is that a read of a document whose tiles have no chain -
     * every read right after a flip, a filter, a fill or an undo - no longer holds the window for hundreds of
     * milliseconds. At 15000 x 10000 a 192 px flatten after a flip built 2,088 chains here, 510 ms in one task.
     *
     * The caller must be able to wait: the picture arrives a frame or two later than `sampleRegion`'s would, and
     * the document may have changed meanwhile, exactly as for any other await.
     */
    async sampleRegionSettled(source, box, scale, opts = {}) {
        // relight's full shadow maps first: a settled read of the picture never takes the quick map of a light on the move
        // or the map of where it was (F2.7); a read without the filters or of the base alone does not wait for them
        if (source !== "layer" && !opts.skipFilters && !opts.baseOnly && !opts.controlOnly) await this.relightIdle();
        if (!this.tileMode) return this.sampleRegion(source, box, scale, opts);
        const jobs = await this.primePass(source, box, scale, opts);
        try {
            return this.sampleRegion(source, box, scale, opts);
        } finally {
            for (const j of jobs) j.release();
        }
    }

    /**
     * The selection over `box` ([x0, y0, x1, y1] in image coordinates) at `scale`, as a canvas of `w` x `h` whose
     * alpha is the mask (C6 c5): exact levels from the mask's tiles, with the chains built in the mips worker, as
     * `sampleRegionSettled` does for the picture. Null on the canvas backend (the caller keeps `sel.drawTo`). Before,
     * every such draw was `sel.drawTo`, which on tiles is the selection's display mirror: 600 MB at 15000 x 10000,
     * kept, for a 1024 px picture.
     */
    async selectionCanvasSettled(box, scale, w, h) {
        if (!this.tileMode || !isTilePixels(this.sel)) return null;
        const m = makeCanvas(w, h);
        if (this.selectionHasNoTiles()) return m;
        const sel = this.sel;
        const job = await sel.primeRegion(box, this.tileLevel(scale));
        try {
            if (this.sel !== sel) return m;   // replaced while its chains were on their way: nothing of it to draw
            const mc = m.getContext("2d");
            mc.imageSmoothingEnabled = true;
            mc.setTransform(scale, 0, 0, scale, -box[0] * scale, -box[1] * scale);
            this.drawSelectionInto(mc, scale, { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] }, false);
        } finally {
            job.release();
        }
        return m;
    }

    readBox(box, { forRun = true, upTo = null } = {}) {
        let reach = this.boxReach(box, { forRun, upTo });
        const o = upTo == null ? { forRun } : { forRun, upTo };
        // E5: no whole flatten exists of a document larger than any canvas; its box is a region pass (see `bandPlan`)
        if (!Number.isFinite(reach) && this.huge) reach = this.boxReach(box, { forRun, upTo, loose: true });
        if (Number.isFinite(reach)) return this.sampleRegion("image", box, 1, { ...o, pad: reach });
        const flat = this.compositeCanvas(o);
        const c = makeCanvas(box[2] - box[0], box[3] - box[1]);
        c.getContext("2d", { willReadFrequently: true }).drawImage(flat, -box[0], -box[1]);
        return c;
    }
}

export function bindStack(C) { InpaintEditor = C; }
