// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_strokes.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the stroke core (dabs, stamps, the stabiliser, finishStroke) and the stroke buffers (commit, preview, stroke passes): moved out of inpaint_canvas.js (item 56 S9, docs/PLAN_SPLIT.md), text unchanged.

import { OPS } from "./px/kernels.js";
import { BLIT_MARGIN, canvasOf } from "./inpaint_pixels.js";
import { Stabiliser, pressureCurve } from "./inpaint_stroke.js";
import { TILE_SIZE, isTilePixels } from "./inpaint_tiles.js";
import { failKind } from "./inpaint_status.js";
import { makeCanvas } from "./inpaint_consts.js";
import { STROKE_BAND, STROKE_SCRATCH_KEEP_PX, StrokeBuffer } from "./inpaint_strokebuf.js";
import { clampRect } from "./inpaint_load.js";

let InpaintEditor = null;

export class StrokesPart {
    selectionDab(x0, y0, x1, y1) {
        const r = this.brushSize / 2 + 2;
        const p = this.pointer;
        if (p && p.kind === "selpaint") this.strokeBounds(p, x0, y0, x1, y1, r);
        const subtract = this.pointer && this.pointer.kind === "selpaint" ? !!this.pointer.subtract : this.tool === "deselect";
        const size = this.brushSize;
        // The round line reaches half the brush past its ends, but the clip must hold Skia's
        // conservative bounds of the stroke too (about 0.71 of the width past the ends): a clip
        // inside those changes how a GPU canvas antialiases the stroke, measured up to 255 levels
        // on the edge pixels with a pad of half the brush + 16 at 150 px. The full width + 4 holds them.
        const pad = size + 4;
        this.sel.drawInto([Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad], (sctx) => {
            sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
            sctx.strokeStyle = "#ff0000";
            sctx.lineCap = "round";
            sctx.lineJoin = "round";
            sctx.lineWidth = size;
            sctx.beginPath();
            sctx.moveTo(x0, y0);
            sctx.lineTo(x1 + 0.01, y1 + 0.01);
            sctx.stroke();
        });
        // after the write (the contract's order): before it, the display levels were refreshed from
        // the selection without this dab, and a fast stroke zoomed out showed gaps until pointer up
        this.touchSourceRect(this.sel, Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r);
    }

    /**
     * Photoshop-style loop closing: every unselected region that cannot reach
     * the image border (i.e. is fully enclosed by the selection) gets selected.
     */
    /**
     * Photoshop-style loop closing for the selection brush: when a stroke comes
     * back to where it started, the path is closed with a straight line and its
     * inside is filled (nonzero winding, so a figure-eight fills both lobes and
     * a loop against the image border counts too). Works for the subtract brush
     * as well. Returns true when something was filled.
     */
    closeStrokeLoop(path, subtract) {
        if (!path || path.length < 8) return false;
        const [x0, y0] = path[0];
        const [x1, y1] = path[path.length - 1];
        const tol = Math.max(this.brushSize, 24 / this.view.scale);
        if (Math.hypot(x1 - x0, y1 - y0) > tol) return false;
        // ignore tiny scribbles: the loop must span more than the brush itself
        let minX = x0, maxX = x0, minY = y0, maxY = y0;
        for (const [x, y] of path) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (Math.max(maxX - minX, maxY - minY) < this.brushSize * 1.5) return false;
        // the closed path lies inside the box of its points
        this.sel.drawInto([minX - 1, minY - 1, maxX + 1, maxY + 1], (sctx) => {
            sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
            sctx.fillStyle = "#ff0000";
            sctx.beginPath();
            sctx.moveTo(x0, y0);
            for (let i = 1; i < path.length; i++) sctx.lineTo(path[i][0], path[i][1]);
            sctx.closePath();
            sctx.fill("nonzero");
        });
        return true;
    }

    /**
     * Draw one brush segment into the stroke buffer of a layer-paint gesture (the press, a Shift+click line); a move
     * goes through `layerStroke` with all its points.
     */
    layerDab(p, x0, y0, x1, y1) {
        this.layerStroke(p, x0, y0, [[x1, y1, p.pressure]]);
    }

    /**
     * Draw one move of a layer-paint gesture into its stroke buffer: from (x0, y0) through `pts` ([x, y, pressure] in
     * image pixels: a pen's coalesced points, the stabiliser's), in one box of the buffer. Hard brushes draw a round line,
     * soft brushes stamp radial-gradient dabs and tips their stamp, evenly along the whole path and both ends included,
     * as one segment was stamped before 0.1.32. 0.1.32 stamped every point as a segment of its own, each joint twice and
     * each in a box of its own (on tiles a scratch round trip): a soft 700 to 1,000 px eraser under a pen was four to six
     * times slower (docs/BUGS.md, fixed for 0.1.33). Flow below 100 % carries its spacing (`flowStamps`). A pen's pressure
     * scales the size (Krita's default "size by pressure"), a segment at its end's; the mouse paints at full size. Image
     * coords are mapped into the layer's own pixels.
     */
    layerStroke(p, x0, y0, pts) {
        if (!pts.length) return;
        const layer = p.layer;
        const c = p.stroke;
        const sx = c.tw / layer.w, sy = c.th / layer.h;
        const full = this.brushSize * (sx + sy) / 4;
        const segs = [];
        let ix = x0, iy = y0, lx = (x0 - layer.x) * sx, ly = (y0 - layer.y) * sy;
        let bx0 = lx, by0 = ly, bx1 = lx, by1 = ly, rMax = 0;
        for (const [x, y, pr] of pts) {
            this.strokeBounds(p, ix, iy, x, y, this.brushSize / 2 + 2);
            this.strokeDirty(p, ix, iy, x, y, this.brushSize / 2 + 2);
            const nx = (x - layer.x) * sx, ny = (y - layer.y) * sy;
            const radius = full * (pr == null ? 1 : Math.max(0.05, Math.min(1, pr)));
            segs.push({ x0: lx, y0: ly, x1: nx, y1: ny, radius, len: Math.hypot(nx - lx, ny - ly), step: 1 });
            if (nx < bx0) bx0 = nx; if (nx > bx1) bx1 = nx; if (ny < by0) by0 = ny; if (ny > by1) by1 = ny;
            if (radius > rMax) rMax = radius;
            ix = x; iy = y; lx = nx; ly = ny;
        }
        // the buffer holds the path plus the dab (a tip may be wider than round, and turned)
        const R = rMax * 1.5 + 2;
        const color = p.dabColor || (p.white ? "#ffffff" : (p.erase ? "#000000" : this.color));
        const hardness = p.erase ? this.eraseHardness : this.hardness;
        const tip = p.remove ? null : this.brushTip();   // Remove marks a hole with the round brush
        const flow = p.flow == null ? 1 : Math.max(0.01, Math.min(1, p.flow));
        // "Follow stroke": the tip turns with the move's direction, from its start to its end (as one segment did before
        // 0.1.32; a pen's points a pixel apart turned it every which way, or not at all); a stationary dab keeps the last
        if (tip && this.tipRotate) {
            const dx = lx - segs[0].x0, dy = ly - segs[0].y0;
            if (Math.hypot(dx, dy) > 0.5) this._tipAngle = Math.atan2(dy, dx);
        }
        c.draw(bx0 - R, by0 - R, bx1 + R, by1 + R, (ctx) => {
            ctx.globalCompositeOperation = "source-over";
            if (flow < 1) { for (const s of segs) this.flowStamps(ctx, p, tip, s.x0, s.y0, s.x1, s.y1, s.radius, color, hardness, flow); return; }
            if (tip) { this.stampDab(ctx, tip, segs, color); return; }
            if (hardness >= 0.98) {
                ctx.strokeStyle = color;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                // one line through the points while the width holds (the mouse, a steady pen), a new one where it changes
                for (let i = 0; i < segs.length;) {
                    let j = i + 1;
                    while (j < segs.length && segs[j].radius === segs[i].radius) j++;
                    ctx.lineWidth = segs[i].radius * 2;
                    ctx.beginPath();
                    ctx.moveTo(segs[i].x0, segs[i].y0);
                    for (let k = i; k < j - 1; k++) ctx.lineTo(segs[k].x1, segs[k].y1);
                    ctx.lineTo(segs[j - 1].x1 + 0.01, segs[j - 1].y1 + 0.01);
                    ctx.stroke();
                    i = j;
                }
                return;
            }
            // the gradient belongs to the context that made it, and on the tile backend every dab
            // draws on a scratch of its own, so it is cached per context as well as per radius
            const rgb = color.length === 7 ? `${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)}` : "0,0,0";
            for (const s of segs) s.step = Math.max(1, s.radius * 0.18);
            this.pathStamps(segs, (x, y, s) => {
                const radius = s.radius;
                if (!p.gradient || p.gradientRadius !== radius || p.gradientCtx !== ctx) {
                    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
                    g.addColorStop(0, `rgba(${rgb},1)`);
                    g.addColorStop(Math.max(0, Math.min(0.97, hardness)), `rgba(${rgb},1)`);
                    g.addColorStop(1, `rgba(${rgb},0)`);
                    p.gradient = g;
                    p.gradientRadius = radius;
                    p.gradientCtx = ctx;
                }
                ctx.fillStyle = p.gradient;
                ctx.save();
                ctx.translate(x, y);
                ctx.beginPath();
                ctx.arc(0, 0, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            });
        });
    }

    /**
     * The places a move's dabs go (layer pixels): `steps + 1` evenly along the whole path of `segs`, both ends included,
     * `steps` the fewest that keep them at most each segment's `step` apart. One segment gives the places its own loop
     * gave before (the fraction i / steps, exactly); the points of a pen's move no longer stamp every joint twice. Where
     * the steps differ (a pen's pressure changing within the move) a segment's share of the places follows its length in
     * its own steps, so a large dab is not spaced as the move's smallest. `fn(x, y, seg)` per place, `seg` the segment it
     * lies on (a place on a joint belongs to the segment it ends). `first` false leaves out the path's start when the path
     * has a length (clone and heal: the last move put its dab there).
     */
    pathStamps(segs, fn, first = true) {
        const n = segs.length;
        let total = 0, weight = 0, step = 0, one = true;
        for (const s of segs) {
            total += s.len;
            if (!(s.len > 0)) continue;
            weight += s.len / s.step;
            if (!step) step = s.step; else if (s.step !== step) one = false;
        }
        // one step for the whole path (the mouse, a steady pen): the arithmetic of one segment, so a straight move of
        // several points puts its dabs where one point did
        const steps = Math.max(1, Math.ceil(one && step ? total / step : weight));
        if (!(total > 0)) {
            // a press, or a pen that did not move: the path's point, at the first segment's size and then the last's
            for (let i = 0; i <= steps; i++) { const s = segs[i === 0 ? 0 : n - 1]; fn(s.x0, s.y0, s); }
            return;
        }
        // where each segment starts and ends, as a fraction of the path (of its length, or of its steps); the last ends at 1
        const f = new Float64Array(n + 1), sum = one ? total : weight;
        for (let k = 0, acc = 0; k < n; k++) {
            if (segs[k].len > 0) acc += one ? segs[k].len : segs[k].len / segs[k].step;
            f[k + 1] = k === n - 1 ? 1 : acc / sum;
        }
        let k = 0;
        for (let i = first ? 0 : 1; i <= steps; i++) {
            const u = i / steps;
            while (k < n - 1 && (segs[k].len === 0 || f[k + 1] < u)) k++;
            const s = segs[k];
            const t = s.len === 0 ? 0 : Math.max(0, Math.min(1, (u - f[k]) / (f[k + 1] - f[k])));
            fn(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t, s);
        }
    }

    /**
     * Flow below 100 % (PLAN_0_1_31 §4 step 5): stamps at even spacing along the stroke, each at alpha `flow`, so paint
     * builds up where stamps overlap and where the stroke passes again; the distance to the next stamp carries over from
     * one segment to the next (`p.rest`), so no joint is stamped twice. The round dab is spaced at a quarter of its
     * diameter (Photoshop's default), a tip at its own spacing. The stroke buffer is 8 bits, so a low flow tops out below
     * full cover (5 % near 96 %), which is why the slider starts at 5 %. Flow 100 % keeps the path of before.
     */
    flowStamps(ctx, p, tip, lx0, ly0, lx1, ly1, radius, color, hardness, flow) {
        const dist = Math.hypot(lx1 - lx0, ly1 - ly0);
        if (p.rest != null && dist === 0) return;   // a repeated point adds nothing; the press stamps once
        const stamp = tip ? this.tipStamp(tip, radius * 2, color) : null;
        const spacing = Math.max(1, stamp ? Math.max(stamp.width, stamp.height) * (tip.spacing || this.brushTipSpacing) : radius * 0.5);
        let fill = color;
        if (!tip && hardness < 0.98) {
            if (!p.gradient || p.gradientRadius !== radius || p.gradientCtx !== ctx) {
                const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
                const rgb = color.length === 7 ? `${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)}` : "0,0,0";
                g.addColorStop(0, `rgba(${rgb},1)`);
                g.addColorStop(Math.max(0, Math.min(0.97, hardness)), `rgba(${rgb},1)`);
                g.addColorStop(1, `rgba(${rgb},0)`);
                p.gradient = g; p.gradientRadius = radius; p.gradientCtx = ctx;
            }
            fill = p.gradient;
        }
        // "Follow stroke": the angle `layerStroke` took from the whole move
        const angle = tip && this.tipRotate ? (this._tipAngle || 0) : 0;
        ctx.globalAlpha = flow;
        let next = p.rest == null ? 0 : p.rest;
        while (next <= dist) {
            const t = dist ? next / dist : 0;
            const x = lx0 + (lx1 - lx0) * t, y = ly0 + (ly1 - ly0) * t;
            ctx.save();
            ctx.translate(x, y);
            if (stamp) { if (angle) ctx.rotate(angle); ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2); }
            else { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill(); }
            ctx.restore();
            next += spacing;
        }
        p.rest = next - dist;
        ctx.globalAlpha = 1;
    }

    /** A pen's pressure through the chosen curve (PLAN_0_1_31 §4 step 5); the mouse and touch paint at 1. */
    pressureOf(e) {
        return e && e.pointerType === "pen" && e.pressure > 0 ? pressureCurve(e.pressure, this.pressureCurve) : 1;
    }

    /** The gesture's stabiliser, or null when it is off: the options bar's string in screen pixels, in image pixels at this zoom. */
    newStabiliser(ix, iy, pressure) {
        if (!(this.stabiliser > 0)) return null;
        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        return new Stabiliser(this.stabiliser * dpr / Math.max(1e-6, this.view.scale), ix, iy, pressure);
    }

    /**
     * The points a move gives a brush gesture: every coalesced event of `e` (a pen faster than the screen gives several a
     * frame, and Chromium hands one pointermove per frame), in image pixels with its pressure, through the gesture's
     * stabiliser; none while its string is slack. A synthetic event without coalesced events is its own one.
     */
    strokePoints(p, e) {
        let evs = null;
        try { evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null; } catch (_) { evs = null; }
        if (!evs || !evs.length) evs = [e];
        const out = [];
        for (const ce of evs) {
            const [x, y] = this.toImage(ce);
            const pr = this.pressureOf(ce);
            if (p.stab) for (const q of p.stab.push(x, y, pr)) out.push(q);
            else out.push([x, y, pr]);
        }
        return out;
    }

    /** The release of a brush gesture: the stabiliser's rest of the string, drawn before the stroke is committed. */
    finishStroke(p) {
        if (!p || !p.stab) return;
        if (p.kind === "liquify") { const rest = p.stab.finish(); p.stab = null; this.liquifyMove(p, rest); return; }
        const rest = p.stab.finish();
        if (rest.length && p.kind !== "smudge" && !p.shape && !p.grad) {
            if (p.clone) this.cloneStroke(p, p.last[0], p.last[1], rest); else this.layerStroke(p, p.last[0], p.last[1], rest);
        }
        for (const [x, y, pr] of rest) {
            p.pressure = pr;
            if (p.kind === "smudge") this.smudgeDab(p, p.last[0], p.last[1], x, y);
            p.last = [x, y];
        }
        p.stab = null;
    }

    // ---- selection tools: wand, feather, saved selections, quick mask ------------------------

    selectedAt(ix, iy) {
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || !this.getBounds()) return false;
        return this.sel.readRect(x, y, 1, 1).data[3] > 127;
    }

    /**
     * Whether strokes on this layer are clipped to the selection, like in Krita and
     * Photoshop (Ctrl+D clears the selection to paint freely). The clip itself is drawn on
     * demand for the part of the layer a gesture touches (clipCanvasFor); it used to be a
     * canvas the size of the layer per gesture.
     */
    strokeClip(layer, target) {
        return !!(this.sel && this.getBounds()) || null;
    }

    /** A stroke buffer for `target` (a layer's `px` or a mask's `maskPx`; only the size is read); tests build gestures with it. */
    newStrokeBuffer(target) { return new StrokeBuffer(target, this.pixels); }

    /**
     * The selection mapped into `target`'s pixels (alpha = selected) inside the box
     * (x, y, w, h in target pixels), as a canvas of that size; `into` is reused when it fits.
     * `target` is the layer's or the mask's pixels; only its size is read. It sets absolute
     * transforms, which is allowed because the canvas is its own (or `into`, a scratch it owns),
     * never a context handed to a drawInto callback (docs/PLAN_BCE.md §C1 rule 12).
     */
    clipCanvasFor(layer, target, x, y, w, h, into = null, sel = this.sel) {
        const c = into && into.width === w && into.height === h ? into : makeCanvas(w, h);
        const ctx = c.getContext("2d");
        const fx = layer.w / target.width, fy = layer.h / target.height;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        ctx.setTransform(target.width / layer.w, 0, 0, target.height / layer.h, -x, -y);
        // C5: on tiles only the part of the selection the box covers, materialised from its tiles,
        // with a margin of BLIT_MARGIN so a fractional draw samples the neighbours as a draw from the
        // whole thing does. `drawTo` reads the selection's display mirror, which at 15000 x 10000 is
        // 572 MB built for a clip of a few hundred pixels. A canvas selection is its own canvas: the
        // draw is free there and a crop would allocate per dab (the smudge asks once a step).
        const r = isTilePixels(sel)
            ? clampRect([layer.x + x * fx - BLIT_MARGIN, layer.y + y * fy - BLIT_MARGIN,
                layer.x + (x + w) * fx + BLIT_MARGIN, layer.y + (y + h) * fy + BLIT_MARGIN], this.width, this.height)
            : null;
        if (!r) sel.drawTo(ctx, -layer.x, -layer.y);
        else if (r[2] > r[0] && r[3] > r[1]) ctx.drawImage(sel.toCanvas(r), r[0] - layer.x, r[1] - layer.y, r[2] - r[0], r[3] - r[1]);
        ctx.restore();
        return c;
    }

    /** A scratch of w x h kept between bands (the stroke's patch and its clip); at most STROKE_BAND a side. */
    bandScratch(key, w, h) {
        const c = this[key];
        if (c && c.width === w && c.height === h) return c;
        const n = makeCanvas(w, h);
        n._livePreview = true;   // never given a display pyramid
        this[key] = n;
        return n;
    }

    /**
     * The stroke buffer's pixels for a rectangle of the target (x, y, w, h in the target's own
     * pixels), limited to the selection when the gesture has a clip, as a canvas of that size;
     * null when the rectangle holds nothing of the buffer. The caller asks band by band
     * (STROKE_BAND): the clipped copy of a whole stroke used to be two canvases the size of the
     * stroke's box, 1.1 GB together on a 15000 x 10000 picture (docs/PLAN_BCE.md §C5).
     */
    strokePatch(p, target, x, y, w, h) {
        const sb = p.stroke;
        if (!sb || sb.empty) return null;
        const ix0 = Math.max(x, sb.x), iy0 = Math.max(y, sb.y);
        const ix1 = Math.min(x + w, sb.x + sb.w), iy1 = Math.min(y + h, sb.y + sb.h);
        if (ix1 <= ix0 || iy1 <= iy0) return null;
        const src = sb.part(ix0, iy0, ix1, iy1);
        if (!src) return null;
        const c = this.bandScratch("_strokePatch", w, h);
        const ctx = c.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(src.canvas, ix0 - src.x, iy0 - src.y, ix1 - ix0, iy1 - iy0, ix0 - x, iy0 - y, ix1 - ix0, iy1 - iy0);
        if (p.clip) {
            ctx.globalCompositeOperation = "destination-in";
            ctx.drawImage(this.clipCanvasFor(p.layer, target, x, y, w, h, this.bandScratch("_strokeClip", w, h), p.clipSel || this.sel), 0, 0);
            ctx.globalCompositeOperation = "source-over";
        }
        return c;
    }

    /**
     * The bands of the target a stroke's buffer covers, at most STROKE_BAND a side and never
     * wider than the box the gesture painted over: [x, y, w, h] in the target's own pixels.
     */
    *strokeBands(p, target) {
        const sb = p.stroke;
        if (!sb || sb.empty) return;
        const r = this.strokeRect(p, target);
        const x0 = Math.max(sb.x, r ? Math.floor(r[0]) : sb.x), y0 = Math.max(sb.y, r ? Math.floor(r[1]) : sb.y);
        const x1 = Math.min(sb.x + sb.w, r ? Math.ceil(r[2]) : sb.x + sb.w), y1 = Math.min(sb.y + sb.h, r ? Math.ceil(r[3]) : sb.y + sb.h);
        // only the grid cells a dab drew into: a diagonal stroke's rectangle is the whole picture
        for (const cell of sb.cells) {
            const bx = Math.max(x0, (cell % 65536) * STROKE_BAND), by = Math.max(y0, Math.floor(cell / 65536) * STROKE_BAND);
            const bx1 = Math.min(x1, (cell % 65536 + 1) * STROKE_BAND), by1 = Math.min(y1, (Math.floor(cell / 65536) + 1) * STROKE_BAND);
            if (bx1 > bx && by1 > by) yield [bx, by, bx1 - bx, by1 - by];
        }
    }

    /** What the Undo history calls a stroke's step (a shape is committed as a stroke while the shape tool is on). */
    strokeLabel(p) {
        if (p.kind === "maskpaint") return p.erase ? "Erase mask" : "Paint mask";
        if (p.grad) return "Gradient";
        if (p.move) return p.move.mode === "extend" ? "Content-aware extend" : "Content-aware move";
        if (p.patch) return "Patch";
        if (p.remove) return "Remove";
        if (p.clone) return p.clone.heal ? "Heal" : "Clone";
        if (this.tool === "shape") return "Shape";
        return p.erase ? "Erase" : "Brush stroke";
    }

    /** The opacity a live stroke is shown at: the brush's, or the gesture's own (Remove shows its mark half transparent). */
    strokeAlpha(p) {
        return p && p.previewAlpha != null ? p.previewAlpha : this.brushOpacity;
    }

    /** Apply the stroke buffer to the layer (or its mask) with the brush opacity, band by band. */
    commitStroke(p) {
        const target = p.kind === "maskpaint" ? p.layer.maskPx : p.layer.px;
        if (!target) return;   // a mask removed under the gesture: nothing to write into
        // the undo step is a copy of what the stroke touched, taken before it is applied
        // a heal that blended in a worker is an edit an undo pressed meanwhile waited for (`trackEdit`): its step is that
        // undo's to take back, so it does not count as an edit made after the key
        if (!p.noUndo) this.pushUndoSnapshot(this.strokeUndo(p, target), { label: this.strokeLabel(p), tracked: !!p.healing });
        if (!p.stroke || p.stroke.empty) return;
        // what the release froze for a heal that blended in a worker (`healBlend`), else as it is now
        const opacity = p.opacity != null ? p.opacity : this.brushOpacity;
        const op = p.op || (p.erase ? "destination-out" : (p.kind === "layerpaint" && p.layer.alphaLock ? "source-atop" : "source-over"));
        try {
            if (this.commitStrokeTiles(p, target, op, opacity)) return;
            for (const [bx, by, bw, bh] of this.strokeBands(p, target)) {
                const patch = this.strokePatch(p, target, bx, by, bw, bh);
                if (!patch) continue;
                // the patch is the band's size at the band's origin: unscaled, on whole pixels
                target.drawInto([bx, by, bx + bw, by + bh], (ctx) => {
                    ctx.globalAlpha = opacity;
                    ctx.globalCompositeOperation = op;
                    ctx.drawImage(patch, bx, by);
                });
            }
        } catch (err) {
            // the renderer's memory for pixels ran out part way (PixelMemoryError, inpaint_arena.js): the undo step above is
            // in, so Ctrl+Z takes back what the commit wrote, and the release goes on to mark the stroke's box
            if (!err || err.name !== "PixelMemoryError") throw err;
            this.setStatus(err.message, failKind(err));
            return false;
        }
    }

    /**
     * The commit on tiles: the stroke store's tiles into the target's through the compositing kernel, a tile at a time
     * (`compositeStroke`), not band by band through canvases (docs/BUGS.md: releasing a long erase held the window
     * 0.3 s at 15000 x 10000). The stroke's box, and with a clip the selection under each tile, are the kernel's
     * coverage; a clip on a scaled or fractional layer, and the canvas backend, keep the bands. False when it did not run.
     */
    commitStrokeTiles(p, target, op, opacity) {
        const sb = p.stroke, sp = sb && sb.px;
        if (!sp || !isTilePixels(target) || typeof target.compositeStroke !== "function" || InpaintEditor.strokeTiles === false) return false;
        if (sp.width !== target.width || sp.height !== target.height) return false;
        const l = p.layer;
        const sel = p.clip ? (p.clipSel || this.sel) : null;
        if (sel && (!isTilePixels(sel) || target.width !== l.w || target.height !== l.h || l.x !== Math.round(l.x) || l.y !== Math.round(l.y))) return false;
        // the box the bands would walk (`strokeBands`): the buffer's extent within the gesture's rectangle
        const r = this.strokeRect(p, target);
        const x0 = Math.max(sb.x, r ? Math.floor(r[0]) : sb.x), y0 = Math.max(sb.y, r ? Math.floor(r[1]) : sb.y);
        const x1 = Math.min(sb.x + sb.w, r ? Math.ceil(r[2]) : sb.x + sb.w), y1 = Math.min(sb.y + sb.h, r ? Math.ceil(r[3]) : sb.y + sb.h);
        if (x1 <= x0 || y1 <= y0) return true;
        const T = TILE_SIZE;
        const coverage = (tx, ty) => {
            const X = tx * T, Y = ty * T;
            const cx0 = Math.max(x0, X), cy0 = Math.max(y0, Y), cx1 = Math.min(x1, X + T), cy1 = Math.min(y1, Y + T);
            if (cx1 <= cx0 || cy1 <= cy0) return null;
            if (!sel && cx0 === X && cy0 === Y && cx1 === X + T && cy1 === Y + T) return true;
            const m = new Uint8Array(T * T);
            if (sel) {
                // the selection under this tile of the layer (unscaled, on whole pixels): its alpha is the clip
                const a = sel.readRect(l.x + cx0, l.y + cy0, cx1 - cx0, cy1 - cy0).data;
                let any = false;
                for (let yy = cy0; yy < cy1; yy++) {
                    for (let xx = cx0, j = ((yy - cy0) * (cx1 - cx0)) * 4 + 3; xx < cx1; xx++, j += 4) {
                        const v = a[j];
                        if (v) { m[(yy - Y) * T + (xx - X)] = v; any = true; }
                    }
                }
                return any ? m : null;
            }
            for (let yy = cy0; yy < cy1; yy++) m.fill(255, (yy - Y) * T + (cx0 - X), (yy - Y) * T + (cx1 - X));
            return m;
        };
        target.compositeStroke(sp, OPS[op], Math.round(Math.max(0, Math.min(1, opacity)) * 255), coverage);
        return true;
    }

    /**
     * Add the box a dab changed (image coordinates, padded) to the gesture's dirty
     * rectangles, one per live preview: each preview refreshes its own and takes it.
     *
     * The dab also changed the scene the screen shows, so the scene cache's key moves on
     * (`pixelVersion`, which `sceneSignature` reads). Every stroke kind that draws into a
     * stroke buffer comes through here (layerDab, cloneDab, gradientDab, shapeDab); a write
     * into pixels says so through touchSource / touchSourceRect instead. 28bfad0 (C5 c) took
     * the per-dab `touchSource(buffer canvas)` out of those four with nothing in its place:
     * from then on every frame of a gesture blitted the scene built at the press, and the
     * brush, the eraser, clone, the gradient and a dragged shape showed nothing until the
     * release (0.1.13, docs/PLAN_BCE.md §C7 "The live stroke that did not show"). Only the
     * key: no display level, no mirror and no pixels are touched, which is what the stroke
     * store and the region preview are for.
     */
    strokeDirty(p, x0, y0, x1, y1, pad) {
        const b = [Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad];
        for (const k of ["dirtyLayer", "dirtyMask", "dirtyMasked", "dirtyView"]) {
            const d = p[k];
            p[k] = d ? [Math.min(d[0], b[0]), Math.min(d[1], b[1]), Math.max(d[2], b[2]), Math.max(d[3], b[3])] : b;
        }
        this.pixelVersion++;
    }

    /** A live preview's dirty rectangle in `target`'s pixels (clamped), taken; null when nothing changed. `target`: pixels or a canvas of their size. */
    takeDirty(p, key, layer, target) {
        const d = p[key];
        if (!d) return null;
        p[key] = null;
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const x0 = Math.max(0, Math.floor((d[0] - layer.x) * sx) - 1), y0 = Math.max(0, Math.floor((d[1] - layer.y) * sy) - 1);
        const x1 = Math.min(target.width, Math.ceil((d[2] - layer.x) * sx) + 1), y1 = Math.min(target.height, Math.ceil((d[3] - layer.y) * sy) + 1);
        return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }

    /**
     * Bring a live preview up to date inside `box` (target pixels; null for all of it, once
     * per gesture): the target's own pixels there, then the stroke over them with the brush
     * opacity and operation. A preview used to be rebuilt whole on every frame, three
     * full-size blits per dab on a 15k layer. `target` is the layer's or the mask's pixels;
     * the preview stays a canvas in C1 (docs/PLAN_BCE.md §C1 rule 8).
     */
    refreshStrokePreview(preview, target, p, box, op) {
        const [x, y, w, h] = box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : [0, 0, target.width, target.height];
        if (w <= 0 || h <= 0) return;
        const ctx = preview.getContext("2d");
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(x, y, w, h);
        target.drawTo(ctx, x, y, w, h, x, y, w, h);
        ctx.globalAlpha = this.strokeAlpha(p);
        ctx.globalCompositeOperation = op;
        for (const [bx, by, bw, bh] of this.strokeBands(p, target)) {
            const ix0 = Math.max(x, bx), iy0 = Math.max(y, by), ix1 = Math.min(x + w, bx + bw), iy1 = Math.min(y + h, by + bh);
            if (ix1 <= ix0 || iy1 <= iy0) continue;
            const patch = this.strokePatch(p, target, bx, by, bw, bh);
            if (patch) ctx.drawImage(patch, ix0 - bx, iy0 - by, ix1 - ix0, iy1 - iy0, ix0, iy0, ix1 - ix0, iy1 - iy0);
        }
        ctx.restore();
    }

    /** After a gesture: the live preview canvases of a large layer are given back, small ones are kept for the next stroke. */
    releaseStrokeScratch() {
        for (const k of ["strokePreview", "maskPreview", "maskedPreview", "strokeView", "strokeMaskView", "_strokePatch", "_strokeClip", "_strokeDev", "_smudgeSrc", "_smudgeClip", "_smudgeTip", "_brushBytes", "_cloneDab", "_healDest", "_healClip", "_healSrc", "_patchQuick", "_patchPrev", "_liqPreview"]) {
            const c = this[k];
            if (c && c.width * c.height > STROKE_SCRATCH_KEEP_PX) this[k] = null;
        }
        if (this._brushRead) this._brushRead = this._brushRead.map((c) => (c && c.width * c.height > STROKE_SCRATCH_KEEP_PX ? null : c));
        this._strokeViewOf = null;
        this._strokeViewSig = null;
    }

    /**
     * The mask a tile path can apply straight from its own tiles: a `MaskPixels` on the same backend
     * and with the same tile grid as the pixels it masks (docs/PLAN_BCE.md §C5). A mask of another
     * size is scaled onto the layer, which only the `_masked` canvas can do.
     */
    tileMaskOf(layer) {
        const m = this.liveMask(layer);
        if (!m || !layer.px || !isTilePixels(m) || !isTilePixels(layer.px)) return null;
        return m.width === layer.px.width && m.height === layer.px.height ? m : null;
    }

    /**
     * The mask that shapes `layer` where it is drawn: its `maskPx`, or none while the mask is switched off (`maskOff`,
     * PSD's "disabled"; Shift+click on the mask). Everything that draws or composites a layer asks this; what moves,
     * saves or undoes a mask keeps using `maskPx`, so a switched-off mask follows a crop or a flip like any.
     */
    liveMask(layer) {
        return layer.maskOff ? null : layer.maskPx || null;
    }

    /** A gesture whose stroke buffer is drawn over `layer`'s pixels for the live preview. */
    liveStrokeOn(layer) {
        const p = this.pointer;
        return !!(p && p.stroke && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
    }

    /**
     * The layer as a region pass shows it while a live stroke runs on it (docs/PLAN_BCE.md §C5):
     * the part the pass covers, at the pass's resolution, in a scratch of the pass's size, redrawn
     * inside the dab's rectangle only. `layerWithStroke` makes a canvas as large as the layer and
     * fills it from the layer's display canvas at the first dab, which on a tile store is its
     * display mirror: 355 ms and two mirrors of 572 MB on a 15000 x 10000 document, measured, and
     * the last thing in the tree that made a mirror for the screen.
     *
     * Null when the caller has to take that path after all: a pass whose region is not a whole
     * number of destination pixels would resample the scratch on the way back.
     */
    layerRegionView(layer, vp) {
        const p = this.liveStrokeOn(layer) || this.liquifyOn(layer) ? this.pointer : null;
        const target = p && p.kind === "maskpaint" ? layer.maskPx : layer.px;
        if (!target || !layer.px) return null;
        const vw = vp.w * vp.sx, vh = vp.h * vp.sy;
        if (!(vw >= 1 && vh >= 1)) return null;
        if (Math.abs(vw - Math.round(vw)) > 1e-6 || Math.abs(vh - Math.round(vh)) > 1e-6) return null;
        const W = Math.round(vw), H = Math.round(vh);
        if (!this.strokeView || this.strokeView.width !== W || this.strokeView.height !== H) {
            this.strokeView = makeCanvas(W, H);
            this.strokeView._livePreview = true;   // never cached in the display pyramid
            this._strokeViewSig = null;
        }
        // the scratch holds one (gesture, layer, region): a pan, a zoom, another layer, a write into
        // the pixels or the mask, or a new gesture rebuilds it
        const sig = [vp.x, vp.y, vp.w, vp.h, layer.id, p ? p.kind : "-", layer.x, layer.y, layer.w, layer.h,
            layer.px.version, this.liveMask(layer) ? layer.maskPx.version : -1,
            // C6 b: mips landing from the worker put the stale cells of the region canvases again, the selection's too:
            // a clipped gesture's scratch is clipped by the selection's region canvas, and the dabs drawn before its
            // chains landed kept the clip of the selection before an invert until the commit (the C6 b review)
            layer.px.chainEpoch || 0, layer.maskPx ? layer.maskPx.chainEpoch || 0 : 0, this.sel ? this.sel.chainEpoch || 0 : 0].join(",");
        const full = this._strokeViewOf !== (p || layer) || this._strokeViewSig !== sig;
        if (full) { this._strokeViewOf = p || layer; this._strokeViewSig = sig; if (p) p.dirtyView = null; }
        const box = full || !p ? null : this.takeStrokeBox(p, "dirtyView");
        if (full || box) this.refreshStrokeView(layer, vp, box);
        return this.strokeView;
    }

    /** A live preview's dirty rectangle in image coordinates, taken; null when nothing changed. */
    takeStrokeBox(p, key) {
        const d = p[key];
        p[key] = null;
        return d || null;
    }

    /** Redraw `box` (image coordinates; all of the scratch when null) of the live stroke's view scratch. */
    refreshStrokeView(layer, vp, box) {
        const p = this.liveStrokeOn(layer) || this.liquifyOn(layer) ? this.pointer : null;
        const c = this.strokeView, ctx = c.getContext("2d");
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            let dx0 = 0, dy0 = 0, dx1 = c.width, dy1 = c.height;
            if (box) {
                dx0 = Math.max(0, Math.floor((box[0] - vp.x) * vp.sx) - 1);
                dy0 = Math.max(0, Math.floor((box[1] - vp.y) * vp.sy) - 1);
                dx1 = Math.min(c.width, Math.ceil((box[2] - vp.x) * vp.sx) + 1);
                dy1 = Math.min(c.height, Math.ceil((box[3] - vp.y) * vp.sy) + 1);
                if (dx1 <= dx0 || dy1 <= dy0) return;
            }
            // whole destination pixels, so the clip has no anti-aliased edge and what a dab does not
            // touch stays exactly the pixels the frame before drew (destination-in below needs it too)
            ctx.beginPath();
            ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.clip();
            ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy);
            this.drawPixelsInto(ctx, layer, layer.px, vp);
            if (p && p.kind === "layerpaint") {
                this.drawStrokeInto(ctx, layer, layer.px, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"), vp, [dx0, dy0, dx1, dy1]);
            } else if (p && p.kind === "liquify") {
                this.drawLiquifyInto(ctx, layer, vp, [dx0, dy0, dx1, dy1]);
            }
            if (this.liveMask(layer)) {
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "destination-in";
                if (p && p.kind === "maskpaint") {
                    const m = this.maskStrokeView(layer, vp, dx0, dy0, dx1, dy1);
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.drawImage(m, dx0, dy0, dx1 - dx0, dy1 - dy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
                } else {
                    this.drawPixelsInto(ctx, layer, layer.maskPx, vp);
                }
            }
        } finally {
            ctx.restore();
        }
    }

    /** The mask of `layer` with the in-progress mask stroke on it, in a scratch of the pass's size. */
    maskStrokeView(layer, vp, dx0, dy0, dx1, dy1) {
        const s = this.strokeView;
        if (!this.strokeMaskView || this.strokeMaskView.width !== s.width || this.strokeMaskView.height !== s.height) {
            this.strokeMaskView = makeCanvas(s.width, s.height);
            this.strokeMaskView._livePreview = true;
        }
        const m = this.strokeMaskView, ctx = m.getContext("2d");
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            ctx.beginPath();
            ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.clip();
            ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
            ctx.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy);
            this.drawPixelsInto(ctx, layer, layer.maskPx, vp);
            this.drawStrokeInto(ctx, layer, layer.maskPx, this.pointer.erase ? "destination-out" : "source-over", vp, [dx0, dy0, dx1, dy1]);
        } finally {
            ctx.restore();
        }
        return m;
    }

    /** Some pixels of `layer` (its own or its mask) over the layer's rectangle, at the pass's level; false when a tile store holds none there. */
    drawPixelsInto(ctx, layer, px, vp) {
        if (isTilePixels(px)) return this.drawTilesInto(ctx, px, layer.x, layer.y, layer.w, layer.h, vp);
        ctx.drawImage(this.displaySource(px, (layer.w * vp.sx) / px.width, false), layer.x, layer.y, layer.w, layer.h);
        return true;
    }

    /**
     * A scratch for one pass (C6 c2): kept under `key` up to STROKE_SCRATCH_KEEP_PX, a canvas of its own above that (a
     * fine flood box can be tens of megapixels, and nothing should hold one after the pass).
     */
    passScratch(key, w, h) {
        if (w * h > STROKE_SCRATCH_KEEP_PX) { const c = makeCanvas(w, h); c._livePreview = true; return c; }
        return this.bandScratch(key, w, h);
    }

    /**
     * A masked layer, or one a live stroke runs on, in a region pass other than the screen's stroke (C6 c2): composed
     * into a scratch of the pass target's size with the pass's transform (the layer's pixels, the stroke over them,
     * the mask, or the mask with its stroke, destination-in), then drawn at identity with the layer's alpha and blend
     * mode as `ctx` carries them. The screen's scratch (`strokeView`, its signature and the gesture's dirty box) stays
     * the screen's: the film panel's flatten during a stroke rebuilt it at 192 px and the next frame rebuilt it again,
     * two masked layers took it from each other on every frame, and a pass whose size is not a whole number of pixels
     * (the flood's coarse pass on a 3:2 picture) fell back to `_masked`: a 572 MB canvas and two display mirrors at
     * 15000 x 10000 for each masked layer.
     */
    drawLayerPass(ctx, layer, vp) {
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const p = this.liveStrokeOn(layer) ? this.pointer : null;
        const s = this.passScratch("_passView", W, H);
        const x = s.getContext("2d");
        const toPass = (c) => { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, W, H); c.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx, -vp.y * vp.sy); };
        x.save();
        try {
            toPass(x);
            this.drawPixelsInto(x, layer, layer.px, vp);
            if (p && p.kind === "layerpaint") this.drawStrokeInto(x, layer, layer.px, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"), vp, [0, 0, W, H]);
            // a liquify stroke on the screen whose region is not whole pixels (layerRegionView's null): its preview here
            else if (vp.screen && this.liquifyOn(layer)) this.drawLiquifyInto(x, layer, vp, [0, 0, W, H]);
            if (this.liveMask(layer)) {
                let m = null;
                if (p && p.kind === "maskpaint") {
                    m = this.passScratch("_passMaskView", W, H);
                    const mx = m.getContext("2d");
                    mx.save();
                    try {
                        toPass(mx);
                        this.drawPixelsInto(mx, layer, layer.maskPx, vp);
                        this.drawStrokeInto(mx, layer, layer.maskPx, p.erase ? "destination-out" : "source-over", vp, [0, 0, W, H]);
                    } finally { mx.restore(); }
                }
                x.globalAlpha = 1;
                x.globalCompositeOperation = "destination-in";
                if (m) {
                    x.setTransform(1, 0, 0, 1, 0, 0);
                    x.drawImage(m, 0, 0);
                } else {
                    this.drawPixelsInto(x, layer, layer.maskPx, vp);   // nothing to draw only outside the mask, where the layer drew nothing either
                }
            }
        } finally {
            x.restore();
        }
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(s, 0, 0);
        } finally {
            ctx.restore();
        }
    }

    /**
     * The in-progress stroke over the layer's rectangle, at the brush opacity and the gesture's
     * operation, into a context that carries the image -> destination transform. A gesture clipped
     * to the selection gets its clip in a scratch of the destination rectangle `dev` ([x0, y0, x1,
     * y1] in that context's own pixels), never in a copy of the stroke at the layer's resolution.
     */
    drawStrokeInto(ctx, layer, target, op, vp, dev) {
        const p = this.pointer, sb = p.stroke;
        if (!sb || sb.empty) return;
        if (!p.clip) {
            ctx.globalAlpha = this.strokeAlpha(p);
            ctx.globalCompositeOperation = op;
            sb.drawOver(this, ctx, layer, target, vp);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            return;
        }
        const w = dev[2] - dev[0], h = dev[3] - dev[1];
        if (w <= 0 || h <= 0) return;
        const s = this.bandScratch("_strokeDev", w, h);
        const x = s.getContext("2d");
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        x.clearRect(0, 0, w, h);
        x.setTransform(vp.sx, 0, 0, vp.sy, -vp.x * vp.sx - dev[0], -vp.y * vp.sy - dev[1]);
        sb.drawOver(this, x, layer, target, { ...vp, x: vp.x, y: vp.y, w: vp.w, h: vp.h });
        // the selection over the same image rectangle: destination-in, and the scratch is exactly
        // the rectangle, so the operation's reach beyond what is drawn is what it has to be
        x.globalCompositeOperation = "destination-in";
        this.drawSelectionInto(x, vp.sx, { x: vp.x, y: vp.y, w: vp.w, h: vp.h });
        ctx.save();
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = this.strokeAlpha(p);
            ctx.globalCompositeOperation = op;
            ctx.drawImage(s, 0, 0, w, h, dev[0], dev[1], w, h);
        } finally {
            ctx.restore();
        }
    }

    /** Layer pixels with the in-progress stroke applied, for live preview: a canvas to draw from, never into; `display` as in layerPixels. */
    layerWithStroke(layer, display = false) {
        const p = this.pointer;
        if (!p || p.kind !== "layerpaint" || p.layer !== layer) return layer.px ? (display ? canvasOf(layer.px) : layer.px.toCanvas()) : null;
        const target = layer.px;
        let fresh = false;
        if (!this.strokePreview || this.strokePreview.width !== target.width || this.strokePreview.height !== target.height) {
            this.strokePreview = makeCanvas(target.width, target.height);
            this.strokePreview._livePreview = true;
            fresh = true;
        }
        if (p.previewOf !== this.strokePreview) { p.previewOf = this.strokePreview; fresh = true; }   // a new gesture: the layer is copied once
        const box = fresh ? null : this.takeDirty(p, "dirtyLayer", layer, target);
        if (fresh) p.dirtyLayer = null;
        if (fresh || box) this.refreshStrokePreview(this.strokePreview, target, p, box, p.erase ? "destination-out" : (layer.alphaLock ? "source-atop" : "source-over"));
        return this.strokePreview;
    }
}

export function bindStrokes(C) { InpaintEditor = C; }
