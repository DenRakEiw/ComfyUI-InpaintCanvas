// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_match.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// colour match: moved out of inpaint_canvas.js (item 56 S10, docs/PLAN_SPLIT.md), text unchanged.

import { matchCanvas } from "./inpaint_filters.js";
import { chainScheduler, isTilePixels } from "./inpaint_tiles.js";
import { makeCanvas } from "./inpaint_consts.js";

export class MatchPart {
    matchActive(layer) {
        return !!(layer.match && layer.match.strength > 0 && layer.kind !== "filter" && !this.isControl(layer) && !this.isReference(layer));
    }

    markMatchChanged(layer) {
        layer._mcache = null;
        layer._mcacheView = null; layer._mcacheSample = null;
        layer._mstats = null;
        const v0 = this.compositeVersion;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        // C6 (c) 7c: the layer's own shared statistics do not depend on its match settings (their key holds the source),
        // only on its pixels and what is below it: a strength tick keeps them, and only the layers above match again
        for (const slot of ["_mstatsSample", "_mstatsSampleRun", "_mstatsStack", "_mstatsStackRun"]) if (layer[slot] && layer[slot].version === v0) layer[slot].version = this.compositeVersion;
    }

    /**
     * The layer's pixels with their colour statistics matched to the composite
     * below (per-channel mean and spread, ratio clamped to 0.5..2, like the
     * stitch's colour match). Source: the surroundings (a ring around the
     * layer's opaque area) or the pixels underneath it. Cached per composite
     * version and settings.
     */
    layerMatchedPixels(layer, below, vp = null, opts = {}) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        const px = this.layerPixels(layer, true);
        // in a region pass the match is applied to the pyramid level that is actually drawn
        const out0 = vp ? this.displaySource(px, (layer.w * vp.sx) / px.width, !!vp.screen) : px;
        const skip = !!opts.skipFilters;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, out0.width, out0.height, skip]);
        const slot = vp ? (vp.sample ? "_mcacheSample" : "_mcacheView") : "_mcache";
        const c = layer[slot];
        if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        const st = this.matchStats(layer, below, vp, out0, opts);
        const out = st && strength > 0 ? matchCanvas(out0, st, strength) : out0;
        layer[slot] = { version: this.compositeVersion, key, canvas: out };
        return out;
    }

    /** A colour-matched layer whose region passes read its tiles (C6 c 7b): its pixels on tiles, its mask on the same grid. */
    matchFromTiles(layer) {
        return !!layer.px && isTilePixels(layer.px) && (!this.liveMask(layer) || !!this.tileMaskOf(layer));
    }

    /**
     * The colour-matched pixels of the part of `layer` a region pass shows (C6 c slice 7b), for a layer on tiles
     * (`matchFromTiles`): `{ canvas, sw, sh, x, y, w, h }` - draw `sw x sh` of the canvas (fractional at the layer's last
     * row and column) at `x, y, w, h` in the image - or `{ plain: true }` when there are no statistics (draw the layer
     * unmatched, from its tiles), or null when the region holds nothing of the layer.
     *
     * The pixels are the layer's region canvas at the pass's level, masked by the mask's region canvas on the same
     * grid, and matched. `layerMatchedPixels` matched the layer's whole display mirror, or the Skia pyramid level of it
     * the pass drew: 572 MB for the mirror and 197 MB for the pyramid of a full-size layer at 15000 x 10000, three more
     * 572 MB canvases for a masked one (`_masked` and two mirrors), and a match of up to 600 MB per miss at 1:1.
     *
     * Kept per pass kind (`_mcacheView` for the screen and the navigator, `_mcacheSample` for a sampled pass) under the
     * region canvases' origin and size, not the view's: a pan inside their tile of margin reuses the match. The
     * statistics object is part of the key, so a new one (a change below, a drop on a landing) matches again; so do
     * `chainEpoch`s, which move when the chains of a display read's stale cells land.
     */
    matchedRegionView(layer, vp, below) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        // first: a statistics miss may run a pass of its own, which takes region canvases and scratches the view reads below
        const st = this.matchStats(layer, below, vp, null);
        if (!st || !(strength > 0)) return { plain: true };
        const px = layer.px, mask = this.liveMask(layer) || null;
        const fx = layer.w / px.width, fy = layer.h / px.height;
        const level = this.tileLevel(fx * vp.sx);
        const display = !!(vp.screen || vp.display);
        const rect = [(vp.x - layer.x) / fx, (vp.y - layer.y) / fy, (vp.x + vp.w - layer.x) / fx, (vp.y + vp.h - layer.y) / fy];
        const rc = px.regionCanvas(rect, level, display);
        if (!rc) return null;
        // the canvas holds whole tiles, its last row and column the clamp past the pixels' own edge (as drawTilesInto)
        const sw = Math.min(rc.canvas.width, (px.width - rc.x) / rc.f);
        const sh = Math.min(rc.canvas.height, (px.height - rc.y) / rc.f);
        if (!(sw > 0) || !(sh > 0)) return null;
        const cw = Math.ceil(sw), ch = Math.ceil(sh);
        // a separate pixels object: its region canvas does not replace the layer's
        const mrc = mask ? mask.regionCanvas(rect, level, display) : null;
        const slot = vp.sample ? "_mcacheSample" : "_mcacheView";
        const key = JSON.stringify(["region", m.strength, m.source, layer.x, layer.y, layer.w, layer.h, level, display, rc.x, rc.y, cw, ch,
            px.version, px.chainEpoch || 0,
            mask ? [mask.version, mask.chainEpoch || 0, mrc ? [mrc.x, mrc.y, mrc.canvas.width, mrc.canvas.height] : -1] : -1]);
        const c = layer[slot];
        if (c && c.region && c.key === key && c.stats === st) return c.region;
        let src = rc.canvas;
        if (mask || cw !== rc.canvas.width || ch !== rc.canvas.height) {
            src = this.passScratch("_matchRegion", cw, ch);
            const x = src.getContext("2d");
            x.setTransform(1, 0, 0, 1, 0, 0);
            x.globalAlpha = 1;
            x.globalCompositeOperation = "copy";
            x.drawImage(rc.canvas, 0, 0, cw, ch, 0, 0, cw, ch);
            if (mask) {
                // the mask's region canvas may start at another tile (it is kept while the range stays inside it)
                x.globalCompositeOperation = "destination-in";
                if (mrc) x.drawImage(mrc.canvas, (mrc.x - rc.x) / rc.f, (mrc.y - rc.y) / rc.f);
                else x.clearRect(0, 0, cw, ch);
            }
            x.globalCompositeOperation = "source-over";
        }
        const out = matchCanvas(src, st, strength);
        const region = { canvas: out, sw, sh, x: layer.x + rc.x * fx, y: layer.y + rc.y * fy, w: sw * rc.f * fx, h: sh * rc.f * fy };
        layer[slot] = { version: this.compositeVersion, key, stats: st, canvas: out, region };
        return region;
    }

    /**
     * The colour-matched pixels of the part of `layer` a sampled pass shows (C6 b3), with where they go in the image:
     * `{ canvas, x, y, w, h }`, or null when the pass's region misses the layer. The statistics are the whole
     * layer's, as `layerMatchedPixels` takes them; only the pixels matched are cut to the region, one source pixel
     * wider on every side for the draw's filtering.
     *
     * The wand's and the bucket's fine boxes are a few hundred pixels of a layer that can be 2048 px and more: each
     * box matched the whole layer (a GPU pass and a readback of its size, 200 ms at 15000 x 10000 behind the queue
     * the box's own composite had just filled). Before C6 (b2) those boxes computed their own statistics from the
     * box, found too few pixels of the layer's surroundings in it, and stored null in the screen's slot: the match
     * was skipped, and the screen showed the layer unmatched until the composite changed.
     */
    layerMatchedPart(layer, below, vp) {
        const m = layer.match || {};
        const strength = Math.min(1, Math.max(0, (m.strength || 0) / 100));
        const px = this.layerPixels(layer, true);
        const out0 = this.displaySource(px, (layer.w * vp.sx) / px.width, false);
        const fx = out0.width / layer.w, fy = out0.height / layer.h;   // source pixels per image pixel
        const cx0 = Math.max(0, Math.floor((vp.x - layer.x) * fx) - 1), cy0 = Math.max(0, Math.floor((vp.y - layer.y) * fy) - 1);
        const cx1 = Math.min(out0.width, Math.ceil((vp.x + vp.w - layer.x) * fx) + 1), cy1 = Math.min(out0.height, Math.ceil((vp.y + vp.h - layer.y) * fy) + 1);
        if (cx1 <= cx0 || cy1 <= cy0) return null;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, out0.width, out0.height, cx0, cy0, cx1, cy1]);
        const c = layer._mcacheSample;
        if (c && c.version === this.compositeVersion && c.key === key && c.part) return c.part;
        const st = this.matchStats(layer, below, vp, out0);
        const cw = cx1 - cx0, ch = cy1 - cy0;
        let crop = out0;
        if (cx0 > 0 || cy0 > 0 || cw < out0.width || ch < out0.height) {
            crop = makeCanvas(cw, ch);
            crop.getContext("2d").drawImage(out0, cx0, cy0, cw, ch, 0, 0, cw, ch);
        }
        const out = st && strength > 0 ? matchCanvas(crop, st, strength) : crop;
        const part = { canvas: out, x: layer.x + cx0 / fx, y: layer.y + cy0 / fy, w: cw / fx, h: ch / fy };
        layer._mcacheSample = { version: this.compositeVersion, key, canvas: out, part };
        return part;
    }

    /**
     * Mean and spread of the layer and of what it is matched against, both at 256 px.
     *
     * A region pass (the screen, the navigator, a sampled pass: the eyedropper, the wand's and the bucket's passes, a
     * plugin's flatten) takes the entry `sampledMatchStats` keeps per layer per change (C6 c slices 7a and 7c): the
     * screen, the navigator and every sampled pass match a layer with the same statistics, which do not move with the
     * view. The full-resolution flatten (exports, runs, uploads) keeps its own, from the whole composite below the layer
     * and the layer's own pixels (`out0`), cached per composite version.
     */
    matchStats(layer, below, vp, out0, opts = {}) {
        if (vp) return this.sampledMatchStats(layer, !!vp.forRun, !!(vp.screen || vp.display), !!opts.skipFilters);
        const m = layer.match || {};
        const skip = !!opts.skipFilters;
        const key = JSON.stringify([m.strength, m.source, layer.x, layer.y, layer.w, layer.h, skip]);
        const cached = layer._mstats;
        if (cached && cached.version === this.compositeVersion && cached.key === key) return cached.stats;
        below = typeof below === "function" ? below() : below;
        const s = Math.min(1, 256 / Math.max(layer.w, layer.h));
        const sw = Math.max(2, Math.round(layer.w * s)), sh = Math.max(2, Math.round(layer.h * s));
        const pad = Math.max(4, Math.round(Math.max(sw, sh) * 0.08));
        const pw = sw + 2 * pad, ph = sh + 2 * pad;
        // layer alpha and the composite below, both padded, at statistics resolution
        const lay = makeCanvas(pw, ph);
        const lctx = lay.getContext("2d");
        lctx.drawImage(out0, 0, 0, out0.width, out0.height, pad, pad, sw, sh);
        const ld = lctx.getImageData(0, 0, pw, ph).data;
        const bel = makeCanvas(pw, ph);
        const bctx = bel.getContext("2d");
        const padImg = pad / s;
        const bs = below.width / this.width;
        bctx.drawImage(below, (layer.x - padImg) * bs, (layer.y - padImg) * bs, (layer.w + 2 * padImg) * bs, (layer.h + 2 * padImg) * bs, 0, 0, pw, ph);
        const bd = bctx.getImageData(0, 0, pw, ph).data;
        const stats = this.statsOfMatch(layer, lay, ld, bd, pad);
        layer._mstats = { version: this.compositeVersion, key, stats };
        return stats;
    }

    /**
     * The statistics of a padded layer picture `lay` (its bytes `ld`) against the backdrop bytes `bd` of the same size:
     * the layer's opaque pixels against a ring around them (the blurred alpha reaches, the alpha itself does not), or
     * against the backdrop under them. Null below 64 pixels on either side.
     */
    statsOfMatch(layer, lay, ld, bd, pad) {
        const m = layer.match || {};
        const pw = lay.width, ph = lay.height;
        const blur = makeCanvas(pw, ph);
        const bl = blur.getContext("2d");
        try { bl.filter = `blur(${pad * 0.6}px)`; } catch (_) { /* ignore */ }
        bl.drawImage(lay, 0, 0);
        bl.filter = "none";
        const bld = bl.getImageData(0, 0, pw, ph).data;
        const under = m.source === "underneath";
        const sum = [0, 0, 0], sq = [0, 0, 0], tsum = [0, 0, 0], tsq = [0, 0, 0];
        let ns = 0, nt = 0;
        for (let i = 0; i < ld.length; i += 4) {
            const a = ld[i + 3];
            if (a > 127) {
                for (let ch = 0; ch < 3; ch++) { const v = ld[i + ch]; tsum[ch] += v; tsq[ch] += v * v; }
                nt++;
                if (under && bd[i + 3] > 0) { for (let ch = 0; ch < 3; ch++) { const v = bd[i + ch]; sum[ch] += v; sq[ch] += v * v; } ns++; }
            } else if (!under && bld[i + 3] > 6 && bd[i + 3] > 0) {
                for (let ch = 0; ch < 3; ch++) { const v = bd[i + ch]; sum[ch] += v; sq[ch] += v * v; }
                ns++;
            }
        }
        if (!(ns >= 64 && nt >= 64)) return null;
        const meanS = sum.map((v) => v / ns), meanT = tsum.map((v) => v / nt);
        const stdS = sq.map((v, ch) => Math.sqrt(Math.max(1e-6, v / ns - meanS[ch] * meanS[ch])));
        const stdT = tsq.map((v, ch) => Math.sqrt(Math.max(1e-6, v / nt - meanT[ch] * meanT[ch])));
        return { meanS, meanT, scale: stdS.map((v, ch) => Math.min(2, Math.max(0.5, v / stdT[ch]))) };
    }

    /**
     * The colour-match statistics every sampled pass uses (C6 c slice 7a): one entry per layer per change (and per
     * `forRun`, which decides whether control and reference layers are in the backdrop), taken from the layer's
     * **whole** padded surroundings at 256 px, whatever pass asks first.
     *
     * Before, a sampled pass took the screen's statistics when they were there and otherwise made its own from its
     * own region. The eyedropper's 1 x 1 pass and a fine box of the wand hold a few hundred pixels of the ring at most:
     * they stored null, and every sampled pass after them drew the layer unmatched until the composite changed (a
     * 512 px picture after an eyedropper click was 102 levels off on 95,172 bytes). A drop of the screen's statistics
     * between the wand's coarse and fine pass (a chain landing) made the wand select a different region.
     *
     * The backdrop is a sampled pass of its own over the padded box, of the layers below this one (`upTo`), and the
     * layer is drawn from its own pixels at the same scale.
     *
     * C6 (c) 7c: the screen and the navigator take this entry too (`display`). They read the levels the screen shows, so
     * a whole change of a 15000 x 10000 layer builds no chain on the main thread for them; an entry read that way while
     * chains are on their way in the mips worker is `provisional`: it goes when they have landed (and the screen draws
     * again with the entry made then), and a reader that wants exact levels makes it again at once. Read with every chain
     * there, display and exact levels are the same bytes.
     */
    sampledMatchStats(layer, forRun, display = false, skipFilters = false) {
        const m = layer.match || {};
        // a filter-free pass (`pictureInput` for the depth model) reads the picture below without its filter
        // layers, so its statistics are its own entry, never the screen's or a run's
        const key = JSON.stringify([m.source, layer.x, layer.y, layer.w, layer.h, !!skipFilters]);
        const slot = forRun ? "_mstatsSampleRun" : "_mstatsSample";
        const c = layer[slot];
        const valid = c && c.version === this.compositeVersion && c.key === key;
        if (valid && (display || !c.provisional)) return c.stats;
        // the layer, masked, at the statistics' scale
        const { lay, ld, pad, pw, ph, fx, fy, box } = this.matchLayerPicture(layer, display);
        // the composite of the layers below it over the same box, at the same scale
        const idx = this.layers.indexOf(layer);
        const under = this.sampleRegion("image", box, Math.min(fx, fy), { forRun, upTo: Math.max(0, idx), display, skipFilters: !!skipFilters });
        const bel = makeCanvas(pw, ph);
        const bctx = bel.getContext("2d", { willReadFrequently: true });
        bctx.drawImage(under, 0, 0, pw, ph);
        const bd = bctx.getImageData(0, 0, pw, ph).data;
        const stats = this.statsOfMatch(layer, lay, ld, bd, pad);
        const sch = display && this.tileMode ? chainScheduler() : null;
        const entry = { version: this.compositeVersion, key, stats, provisional: !!(sch && sch.pending) };
        layer[slot] = entry;
        const redraw = () => { this.sceneSig = null; this.drawSoon(); this.drawThumb(); };
        // an exact reader replaced the entry the screen drew with
        if (valid && c.provisional) redraw();
        if (entry.provisional) sch.settled().then(() => { if (layer[slot] !== entry) return; layer[slot] = null; redraw(); });
        return stats;
    }

    /**
     * The layer, masked, padded, at the colour-match statistics' scale (256 px on its long side), with its bytes:
     * `{ lay, ld, pad, pw, ph, fx, fy, box }`, `box` the padded rectangle in image coordinates. A layer on tiles is read
     * from its tiles and its mask at that scale, exact or (`display`, the screen's statistics) from the levels the screen
     * shows; any other from the display pyramid of its canvas.
     */
    matchLayerPicture(layer, display) {
        const { pad, pw, ph, fx, fy } = this.matchGeometry(layer);
        const box = [layer.x - pad / fx, layer.y - pad / fy, layer.x + layer.w + pad / fx, layer.y + layer.h + pad / fy];
        const lay = makeCanvas(pw, ph);
        const lctx = lay.getContext("2d", { willReadFrequently: true });
        lctx.imageSmoothingEnabled = true;
        lctx.setTransform(fx, 0, 0, fy, pad - layer.x * fx, pad - layer.y * fy);
        if (this.matchFromTiles(layer)) {
            const vp = { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1], sx: fx, sy: fy, display };
            this.drawPixelsInto(lctx, layer, layer.px, vp);
            if (this.liveMask(layer)) {
                lctx.globalCompositeOperation = "destination-in";
                this.drawPixelsInto(lctx, layer, layer.maskPx, vp);
                lctx.globalCompositeOperation = "source-over";
            }
        } else {
            const src = this.layerPixels(layer, true);
            lctx.drawImage(this.displaySource(src, (layer.w * fx) / src.width, false), layer.x, layer.y, layer.w, layer.h);
        }
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        const ld = lctx.getImageData(0, 0, pw, ph).data;
        return { lay, ld, pad, pw, ph, fx, fy, box };
    }

    /** The colour-match statistics' picture of a layer: 256 px on its long side (`sw` x `sh`, scale `fx`, `fy`), `pad` around it, `pw` x `ph` in all. */
    matchGeometry(layer) {
        const s = Math.min(1, 256 / Math.max(layer.w, layer.h));
        const sw = Math.max(2, Math.round(layer.w * s)), sh = Math.max(2, Math.round(layer.h * s));
        const pad = Math.max(4, Math.round(Math.max(sw, sh) * 0.08));
        return { s, sw, sh, pad, pw: sw + 2 * pad, ph: sh + 2 * pad, fx: sw / layer.w, fy: sh / layer.h };
    }
}
