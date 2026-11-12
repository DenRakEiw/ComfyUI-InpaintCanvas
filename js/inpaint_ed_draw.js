// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_draw.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the brush ring, marching ants, draw, the chain watch, view caches and mips: moved out of inpaint_canvas.js (item 56 S10, docs/PLAN_SPLIT.md), text unchanged.

import { chainScheduler } from "./inpaint_tiles.js";
import { makeCanvas } from "./inpaint_consts.js";

export class DrawPart {
    /**
     * An outline that is still being dragged, drawn the way marching ants are: a solid
     * black line first, the dashed white one over it. A single white line is invisible on
     * a white image, which is why Photoshop and Krita never draw one.
     */
    /**
     * The brush outline under the cursor. The coloured ring sits on a dark halo, because on
     * its own a one pixel line in the paint colour disappears over its own paint: a brush
     * wider than the layer then looks like a tool that fills rectangles instead of a brush
     * that is simply bigger than what is being painted on.
     */
    drawBrushRing(ctx, s) {
        const brushTools = ["select", "deselect", "paint", "erase", "smudge", "tone", "clone", "heal", "remove", "liquify"];
        if (!this.hover || !brushTools.includes(this.tool)) return;
        ctx.save();
        const colour = this.tool === "paint" ? this.color : (this.tool === "erase" || this.tool === "deselect" ? "#ffd166" : "#fff");
        const ring = (r, dash) => {
            ctx.setLineDash(dash ? [3 / s, 3 / s] : []);
            ctx.lineWidth = 3 / s;
            ctx.strokeStyle = "rgba(0,0,0,0.8)";
            ctx.beginPath(); ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = colour;
            ctx.beginPath(); ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2); ctx.stroke();
        };
        const tip = (this.tool === "paint" || this.tool === "erase") ? this.brushTip() : null;
        if (tip) {
            // the box the stamp will cover, long side = the brush size, turned with the stroke when following it
            const k = this.brushSize / Math.max(tip.canvas.width, tip.canvas.height);
            const w = tip.canvas.width * k, h = tip.canvas.height * k;
            ctx.translate(this.hover[0], this.hover[1]);
            if (this.tipRotate && this._tipAngle) ctx.rotate(this._tipAngle);
            ctx.setLineDash([]);
            ctx.lineWidth = 3 / s; ctx.strokeStyle = "rgba(0,0,0,0.8)";
            ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.lineWidth = 1 / s; ctx.strokeStyle = colour;
            ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.restore();
            return;
        }
        ring(this.brushSize / 2, false);
        if ((this.tool === "paint" || this.tool === "erase") && this.activeHardness() < 0.98) ring((this.brushSize / 2) * this.activeHardness(), true);
        ctx.restore();
    }

    antsStroke(ctx, path, s) {
        ctx.lineWidth = 1 / s;
        ctx.setLineDash([]);
        ctx.strokeStyle = "#000";
        path();
        ctx.setLineDash([4 / s, 3 / s]);
        ctx.strokeStyle = "#fff";
        path();
    }

    /**
     * Selection as a marching-ants outline: the mask shifted by a screen pixel in eight directions minus the mask, filled
     * with a moving stripe pattern. `shift` ([dx, dy] image pixels) draws it moved (a patch drag), the selection unchanged.
     */
    drawMarchingAnts(ctx, shift = null) {
        const W = this.canvas.width, H = this.canvas.height;
        if (!this.antsCanvas || this.antsCanvas.width !== W || this.antsCanvas.height !== H) this.antsCanvas = makeCanvas(W, H);
        const a = this.antsCanvas.getContext("2d");
        const s = this.view.scale, vx = this.view.x, vy = this.view.y;
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-over";
        a.globalAlpha = 1;
        a.clearRect(0, 0, W, H);
        a.imageSmoothingEnabled = s < 1;
        const r = 1.25;
        // nine draws of the selection: never at full size (the view's level, and on tiles only the
        // part the view shows, straight from the tiles)
        const view = this.viewportRegion();
        // moved: the selection's part that lands in view is the view's region moved back
        const region = shift && view ? { ...view, x: view.x - shift[0], y: view.y - shift[1] } : view;
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            this.applyViewTransform(a, dx, dy);
            this.applyTilt(a);
            if (shift) a.translate(shift[0], shift[1]);
            // the moved pass reads as a sampler (not `display`): on tiles it would otherwise take the screen's region slot
            // and the unmoved pass would rebuild it again, two whole regions a frame while the patch drags
            this.drawSelectionInto(a, s, region, !shift);
        }
        this.applyViewTransform(a);
        this.applyTilt(a);
        if (shift) a.translate(shift[0], shift[1]);
        a.globalCompositeOperation = "destination-out";
        this.drawSelectionInto(a, s, region, !shift);
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-in";
        if (!this.antsPattern) {
            const tile = makeCanvas(8, 8);
            const t = tile.getContext("2d");
            t.fillStyle = "#fff"; t.fillRect(0, 0, 8, 8);
            t.fillStyle = "#000";
            t.beginPath();
            t.moveTo(0, 0); t.lineTo(4, 0); t.lineTo(8, 4); t.lineTo(8, 8); t.lineTo(4, 8); t.lineTo(0, 4); t.closePath();
            t.fill();
            this.antsPattern = a.createPattern(tile, "repeat");
        }
        const offset = Math.floor(Date.now() / 120) % 8;
        try { this.antsPattern.setTransform(new DOMMatrix().translate(offset, 0)); } catch (_) { /* old browsers: static stripes */ }
        a.fillStyle = this.antsPattern;
        a.fillRect(0, 0, W, H);
        a.globalCompositeOperation = "source-over";
        const t = ctx.getTransform();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.antsCanvas, 0, 0);
        ctx.setTransform(t);
        if (!this.antsTimer) {
            // keep the ants walking while a selection is shown; stops itself when there is none or the editor closes
            this.antsTimer = setInterval(() => {
                if (!this.isOpen || this.selectionDisplay !== "ants" || !this.getBounds()) { clearInterval(this.antsTimer); this.antsTimer = null; return; }
                if (!this.pointer) this.drawSoon();
            }, 120);
        }
    }

    draw() {
        this.drawScene();
        this.drawOverlays();
        this.watchChains();
    }

    /**
     * While mip chains are in the mips worker (C6 b), wait for the next batch to land and draw again: the frame
     * after a whole change of a large layer or mask showed a stale or coarse picture of the tiles still on their
     * way, and the rows' thumbnails did too. Nothing is kept when nothing is on its way.
     *
     * What a landing redraws depends on whose chains landed (C6 b2):
     * - The selection's: only what is drawn over the scene (the tint, the marching ants, the quick mask, the
     *   navigator). No filter layer and no colour match ever reads the selection, so the scene and the view's caches
     *   stay. The exception is a live stroke clipped to the selection, whose view scratch is clipped by the
     *   selection's region canvas (`layerRegionView` keys on its `chainEpoch`): the scene is drawn again for it.
     * - The base's, a layer's or a mask's: the scene is drawn again at once, and the view's filter outputs and colour
     *   matches of the layers above the lowest landed one are dropped once no chain is on its way any more
     *   (`staleViewCachesAbove`). Dropping all of them at every landing ran the match (three readbacks) and the filter
     *   pass again per batch of 128 chains, 16 to 20 times per whole change at 15000 x 10000, each 75 to 545 ms
     *   behind a busy GPU queue.
     */
    watchChains() {
        const sch = chainScheduler();
        if (this._chainWatch || !sch.pending) return;
        this._chainWatch = true;
        sch.landing().then((stores) => {
            this._chainWatch = false;
            // `screen`: the stores whose chains a reader of the screen asked for. A landing only a thumbnail asked for
            // (a layer at 1:1, a hidden one) changes nothing on the screen, and dropping the view's caches for it ran a
            // colour match and a filter pass again per batch (the C6 b review)
            const screen = stores.screen || stores;
            const base = screen.has(this._basePx);
            const landed = [];
            for (const l of this.layers) {
                if (!stores.has(l.px) && !(l.maskPx && stores.has(l.maskPx))) continue;
                if (screen.has(l.px) || (l.maskPx && screen.has(l.maskPx))) landed.push(l);
                this.redrawThumbsOf(l);
            }
            let scene = base || landed.length > 0;
            if (scene) this.staleViewCachesAbove(base, landed);
            else if (!sch.pending) this.dropStaleViewCaches();   // the last batch was another store's
            // a live stroke's sparse store: the view scratch of the gesture is built again from its region canvases
            const p = this.pointer, sb = p && p.stroke;
            if (sb && sb.px && screen.has(sb.px)) { scene = true; this._strokeViewSig = null; }
            const sel = !!this.sel && screen.has(this.sel);
            if (sel && sb && p.clip) scene = true;
            if (scene) this.sceneSig = null;
            if (scene || sel) {
                this.drawSoon();
                this.drawThumb();   // the navigator (the node's; the app has none mounted)
            }
            this.watchChains();
        });
    }

    /**
     * Chains of the base (`base`) or of `landed` layers (their pixels or their masks) landed (C6 b2): the view's own
     * caches of every layer above the lowest of them were made from the picture the landing replaced. A filter layer's
     * output is made from everything below it, and a colour match's statistics (and so its matched pixels) from what is
     * under the layer; the matched layer's own pixels come from its exact display canvas, not from mips, and a layer
     * below the landed one reads nothing of it. Their full-resolution caches never saw a stale mip.
     *
     * They are dropped once, when no chain is on its way any more, not per landing: the screen shows the previous
     * filter output and match meanwhile, as it shows the coarse picture, and the frame after the last landing is exact.
     *
     * The same layers' caches of sampled passes (`sampleRegion`: a plugin's `flatten({ maxSize })`, the film panel,
     * the wand's coarse flood) go too. A sampled pass reads exact mips, but it takes the colour match's statistics
     * from the screen's slot when they are there (`matchStats`), and a sampled pass while the chains were on their
     * way kept matched pixels (and a filter output made from them) from the statistics of the coarse picture past the
     * settle (the C6 b2 review: 5 to 6 levels on about 45,000 bytes of a 512 px flatten at 4000 x 3000).
     */
    staleViewCachesAbove(base, landed) {
        const st = this._viewStale || (this._viewStale = { base: false, layers: new Set(), watch: false });
        if (base) st.base = true;
        for (const l of landed) st.layers.add(l);
        const sch = chainScheduler();
        // the last landing: dropped here, in the landing's own callback, which runs before the continuations of
        // mipsSettled() (a reader that draws right after it sees the fresh match)
        if (!sch.pending) { this.dropStaleViewCaches(); return; }
        // otherwise when nothing is on its way any more, also when the rest of the queue was dropped without a landing
        if (st.watch) return;
        st.watch = true;
        sch.settled().then(() => { st.watch = false; this.dropStaleViewCaches(); });
    }

    /** The drop `staleViewCachesAbove` put off; draws again when it dropped anything. */
    dropStaleViewCaches() {
        const st = this._viewStale;
        if (!st || (!st.base && !st.layers.size)) return;
        let from = st.base ? -1 : Infinity;
        for (const l of st.layers) {
            const i = this.layers.indexOf(l);
            if (i < 0) { from = -1; break; }   // removed meanwhile: the layers above it moved down
            if (i < from) from = i;
        }
        st.base = false;
        st.layers.clear();
        let dropped = false;
        for (let i = from + 1; i < this.layers.length; i++) {
            const l = this.layers[i];
            // no draw for them: nothing on the screen came from them. The colour-match statistics stay: an entry read while
            // chains were on their way is provisional and goes when they have landed (C6 c 7c, `sampledMatchStats`)
            l._fcacheSample = null; l._mcacheSample = null;
            if (!l._fcacheView && !l._mcacheView) continue;
            l._fcacheView = null; l._mcacheView = null;
            dropped = true;
        }
        if (!dropped) return;
        this.sceneSig = null;
        this.drawSoon();
        this.drawThumb();
    }

    /**
     * Resolves when no mip chain is on its way in the mips worker (C6 b): a test or a benchmark that reads the
     * screen right after a whole change waits for this and then draws, and reads the exact picture.
     */
    mipsSettled() {
        return chainScheduler().settled();
    }
}
