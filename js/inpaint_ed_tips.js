// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_tips.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// brush tips, stamp and dab masks, smudge, the clone stroke and its ghost: moved out of inpaint_canvas.js (item 56 S4, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { readAbr, tipCanvas } from "./inpaint_brushes.js";
import { SMUDGE_ALPHA_LOCK, SMUDGE_PICKUP, blurRGBA, sharpenRGBA, smudgeDab as smudgeDabKernel, spongeRGBA, toneRGBA } from "./px/kernels.js";
import { hexToRgb } from "./inpaint_raster.js";
import { TipPicker, noteRecentTip } from "./inpaint_tippicker.js";
import { THEME } from "./inpaint_theme.js";
import { failKind } from "./inpaint_status.js";
import { TONE_DAB, cpuDab, makeCanvas, meanRGB } from "./inpaint_consts.js";

export class TipsPart {
    // ---- brush tips (Photoshop .abr and images) ---------------------------------------------

    /** The selected imported tip, or null for the built-in round dab. */
    brushTip() {
        if (!this.brushTipId) return null;
        return this.brushTips.find((t) => t.id === this.brushTipId) || null;
    }

    setBrushTip(id) {
        this.brushTipId = this.brushTips.some((t) => t.id === id) ? id : "";
        this._tipStamp = null;
        if (this.tipSel) this.tipSel.value = this.brushTipId || "Round";
        const t = this.brushTip();
        noteRecentTip(this.brushTipId);
        this.syncTipControls();
        if (this.tipPicker) this.tipPicker.markActive();
        this.draw();
        this.setStatus(t ? `Brush tip: ${t.name} (${t.canvas.width} \u00d7 ${t.canvas.height}${t.spacing ? `, spacing ${Math.round(t.spacing * 100)} %` : ""}).` : "Brush tip: the built-in round dab.");
    }

    /** The thumbnail, the Remove button and the tip-only rows follow the active tip. */
    syncTipControls() {
        const t = this.brushTip();
        if (this.tipThumb) {
            const ctx = this.tipThumb.getContext("2d");
            ctx.clearRect(0, 0, this.tipThumb.width, this.tipThumb.height);
            const src = t ? t.canvas : this.dabMask(11, this.hardness);
            const k = Math.min((this.tipThumb.width - 2) / src.width, (this.tipThumb.height - 2) / src.height, 1.5);
            const w = src.width * k, h = src.height * k;
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            ctx.drawImage(src, (this.tipThumb.width - w) / 2, (this.tipThumb.height - h) / 2, w, h);
            // the tip is black on transparent: draw it as white so it reads on the dark bar
            ctx.globalCompositeOperation = "source-in";
            ctx.fillStyle = THEME.tipGlyph;
            ctx.fillRect(0, 0, this.tipThumb.width, this.tipThumb.height);
            ctx.globalCompositeOperation = "source-over";
        }
        if (this.tipRemoveBtn) this.tipRemoveBtn.style.display = t ? "" : "none";
        for (const e of this.tipOnlyEls || []) e.style.display = t ? "" : "none";
        if (t && this.spacingCtl) { const v = Math.round((t.spacing || this.brushTipSpacing) * 100); this.spacingCtl.value = v; this.spacingVal.textContent = v + "%"; }
    }

    /** Drop a tip from the list (the round dab takes over when it was active) and tell the host. */
    removeBrushTip(id) {
        const t = this.brushTips.find((x) => x.id === id);
        if (!t) return false;
        this.brushTips.splice(this.brushTips.indexOf(t), 1);
        if (this.brushTipId === id) this.brushTipId = "";
        this._tipStamp = null;
        this.renderBrushTips();
        this.syncTipControls();
        this.brushTipsChanged();
        this.setStatus(`Brush tip ${t.name} removed.`);
        return true;
    }

    /** The list changed (import, remove, spacing): the host may persist it. */
    brushTipsChanged() {
        if (this.onBrushTips) { try { this.onBrushTips(this.brushTips); } catch (err) { console.warn("brush tips not saved", err); } }
    }

    /** Rebuild the tip select from this.brushTips, keeping the current choice if it survives. */
    renderBrushTips() {
        if (!this.tipSel) return;
        const keep = this.brushTipId;
        this.tipSel.innerHTML = "";
        for (const [value, label] of [["Round", "Round"], ...this.brushTips.map((t) => [t.id, t.name])]) {
            const o = document.createElement("option");
            o.value = value; o.textContent = label;
            this.tipSel.appendChild(o);
        }
        this.tipSel.value = this.brushTips.some((t) => t.id === keep) ? keep : "Round";
        this.brushTipId = this.tipSel.value === "Round" ? "" : this.tipSel.value;
        if (this.tipPicker && this.tipPicker.isOpen) this.tipPicker.render();
    }

    /** The tip popover (inpaint_tippicker.js) under the tip thumbnail: every tip with a stroke preview, recent, search. */
    openTipPicker() {
        if (!this.tipPicker) this.tipPicker = new TipPicker(this);
        this.closeFlyout();
        this.tipPicker.open(this.tipBtn || this.tipThumb);
        return this.tipPicker;
    }

    closeTipPicker() {
        if (this.tipPicker) this.tipPicker.close();
    }

    toggleTipPicker() {
        if (this.tipPicker && this.tipPicker.isOpen) this.closeTipPicker(); else this.openTipPicker();
    }

    /**
     * Add tips from the files the user picked: a Photoshop .abr, which may hold dozens, or
     * plain images, whose alpha is the coverage when they have one and whose darkness is
     * when they do not, so a black-on-white brush scan works as well as a cut-out PNG.
     */
    async importBrushFiles(files) {
        if (!files || !files.length) return [];
        const added = [];
        for (const f of files) {
            try {
                const tips = /\.abr$/i.test(f.name) ? await this.tipsFromAbr(f) : [await this.tipFromImage(f)];
                for (const tip of tips) { this.brushTips.push(tip); added.push(tip); }
            } catch (err) {
                console.warn("brush import", f.name, err);
                this.setStatus(`${f.name}: ${err.message || err}`, failKind(err));
            }
        }
        if (!added.length) return added;
        this.renderBrushTips();
        this.setBrushTip(added[0].id);
        this.brushTipsChanged();
        const skipped = this._tipsSkipped || 0;
        this._tipsSkipped = 0;
        this.setStatus(`${added.length} brush tip${added.length === 1 ? "" : "s"} imported${skipped ? `, ${skipped} computed (round) tip${skipped === 1 ? "" : "s"} skipped` : ""}. Pick one under Tip.`, skipped ? "warn" : "info");
        return added;
    }

    /** Every sampled tip of a .abr, named as the file names it (an unnamed one after the file and its index). */
    async tipsFromAbr(file) {
        const { brushes, computed, warnings } = readAbr(await file.arrayBuffer());
        this._tipsSkipped = (this._tipsSkipped || 0) + (computed || 0);
        for (const w of warnings || []) console.info("brush import", file.name, w);
        const stem = file.name.replace(/\.abr$/i, "");
        return brushes.map((b, i) => this.makeTip(b.name || `${stem} ${i + 1}`, tipCanvas(b, makeCanvas), b.spacing || 0, file.name));
    }

    async tipFromImage(file) {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error("this file is not an image the browser can read"));
                im.src = url;
            });
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) throw new Error("the image is empty");
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, w, h);
            let opaque = 0;
            for (let j = 3; j < d.data.length; j += 4) if (d.data[j] > 250) opaque++;
            if (opaque > w * h * 0.98) {
                // no alpha to speak of: read it as a scan, where dark pixels paint
                for (let i = 0, j = 0; i < w * h; i++, j += 4) {
                    const lum = d.data[j] * 0.299 + d.data[j + 1] * 0.587 + d.data[j + 2] * 0.114;
                    d.data[j] = 0; d.data[j + 1] = 0; d.data[j + 2] = 0; d.data[j + 3] = 255 - Math.round(lum);
                }
            } else {
                for (let i = 0, j = 0; i < w * h; i++, j += 4) { d.data[j] = 0; d.data[j + 1] = 0; d.data[j + 2] = 0; }
            }
            ctx.putImageData(d, 0, 0);
            return this.makeTip(file.name.replace(/\.[^.]+$/, ""), c, 0);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    makeTip(name, canvas, spacing, source = "") {
        return { id: `tip${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, canvas, spacing: spacing > 0.01 ? Math.min(2, spacing) : 0, source };
    }

    /** The tip tinted and scaled so its long side is `size`, cached for the running stroke. */
    tipStamp(tip, size, color) {
        const s = Math.max(1, Math.round(size));
        const key = `${tip.id}|${s}|${color}`;
        if (this._tipStamp && this._tipStamp.key === key) return this._tipStamp.c;
        const src = tip.canvas;
        const k = s / Math.max(src.width, src.height);
        const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
        const c = makeCanvas(w, h);
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, 0, 0, w, h);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        this._tipStamp = { key, c };
        return c;
    }

    /**
     * One move's path (`layerStroke`'s segments) stamped with the imported tip instead of the round dab, evenly along it
     * (`pathStamps`). The step follows the tip's own spacing when the file carried one, otherwise a quarter of the
     * stamp, which is close to what the round dab uses; a stamp's long side is its size. "Follow stroke" turns it by the
     * angle `layerStroke` took from the move.
     */
    stampDab(ctx, tip, segs, color) {
        for (const s of segs) s.step = Math.max(1, Math.max(1, Math.round(s.radius * 2)) * (tip.spacing || this.brushTipSpacing));
        const angle = this.tipRotate ? (this._tipAngle || 0) : 0;
        this.pathStamps(segs, (x, y, s) => {
            const stamp = this.tipStamp(tip, s.radius * 2, color);
            const w = stamp.width, h = stamp.height;
            if (angle) {
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(angle);
                ctx.drawImage(stamp, -w / 2, -h / 2);
                ctx.restore();
            } else {
                ctx.drawImage(stamp, x - w / 2, y - h / 2);
            }
        });
    }

    /** A soft round alpha mask of radius r (canvas 2r × 2r), cached per size and hardness. */
    dabMask(r, hardness) {
        const key = `${r}|${hardness}`;
        if (this._dabMask && this._dabMask.key === key) return this._dabMask.c;
        const size = Math.max(1, Math.ceil(r * 2));
        const c = cpuDab(null, size);   // drawn into the dab canvases, which are on the CPU
        const ctx = c.getContext("2d");
        const g = ctx.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0, "rgba(0,0,0,1)");
        g.addColorStop(Math.max(0, Math.min(0.97, hardness)), "rgba(0,0,0,1)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        this._dabMask = { key, c };
        return c;
    }

    /**
     * Smudge (PLAN_0_1_31 §4 step 3): the brush holds a carry, a box of paint the size of the dab, laid down where the
     * dab lands and refilled there from what the brush samples (the `smudge_dab` kernel, crates/px/src/smudge.rs, and
     * its JS twin): Strength is how much of the carry goes down, Length how much of it the brush keeps (0: what it left
     * behind, which was the smudge of 0.1.31; up to 100: the paint goes on to the end of the stroke). The first dab of a
     * stroke only fills the carry, or with Finger painting starts from the paint colour. Pen pressure scales the size
     * and the strength. The dab sits on whole pixels (its mask carries the fraction), so the carry moves a whole box at
     * a time; each step reads the box from the layer (or the picture, `smudgeSample`) and writes it back.
     */
    smudgeDab(p, x0, y0, x1, y1) {
        const layer = p.layer, target = layer.px;
        const sx = target.width / layer.w, sy = target.height / layer.h;
        const lx0 = (x0 - layer.x) * sx, ly0 = (y0 - layer.y) * sy, lx1 = (x1 - layer.x) * sx, ly1 = (y1 - layer.y) * sy;
        const pr = Math.max(0.05, Math.min(1, p.pressure || 1));
        // the tone brush lays its curve down whole (the pressure scales it); Exposure is in the curve, not the strength
        const o = p.tone ? TONE_DAB : this.smudgeOpts || {};
        // the carry's side is fixed for the stroke (the full-pressure dab's box); a smaller dab is a smaller mask in it
        if (!p.side) p.side = Math.ceil(Math.max(1, this.brushSize * (sx + sy) / 4) * 2) + 2;
        const side = p.side;
        const r = Math.min((side - 2) / 2, Math.max(1, this.brushSize * (sx + sy) / 4 * pr));
        const strength = Math.round(Math.max(0, Math.min(1, (o.strength ?? 60) / 100)) * 65536 * pr);
        const keep = Math.round(Math.max(0, Math.min(1, (o.length || 0) / 100)) * 65536);
        if (!p.carry) p.carry = new Uint16Array(side * side * 4);
        const tip = this.brushTip();
        const spacing = Math.max(1, tip ? (tip.spacing || this.brushTipSpacing || 0.25) * 2 * r : r * 0.25);
        // blur and sharpen: a filter of 1 px for a small brush up to 8 px, read with three times that around the box; the
        // tone brush works pixel by pixel and reads the box alone
        const mode = p.tone ? "tone" : o.mode === "blur" || o.mode === "sharpen" ? o.mode : "smudge";
        const fxRadius = Math.max(1, Math.min(8, Math.round(r / 12))), fxPad = mode === "tone" ? 0 : fxRadius * 3;
        // the image box the move can touch (the release marks it, not the whole layer)
        this.strokeBounds(p, x0, y0, x1, y1, (side / 2 + 1) / Math.min(sx, sy));
        const dist = Math.hypot(lx1 - lx0, ly1 - ly0);
        const steps = Math.max(1, Math.ceil(dist / spacing));
        // a filter brush's press is one dab; after it every call starts past the point the last one ended on
        const last = mode !== "smudge" && !p.started && dist === 0 ? 0 : steps;
        for (let i = p.started ? 1 : 0; i <= last; i++) {
            const cx = lx0 + (lx1 - lx0) * i / steps, cy = ly0 + (ly1 - ly0) * i / steps;
            const bx = Math.round(cx - side / 2), by = Math.round(cy - side / 2);
            let mask = this.smudgeMask(side, cx - bx, cy - by, r, tip);
            if (p.clip) {
                this._smudgeClip = cpuDab(this._smudgeClip, side);   // clipCanvasFor draws into it when it has the size
                this._smudgeClip = this.clipCanvasFor(layer, target, bx, by, side, side, this._smudgeClip);
                const sel = this._smudgeClip.getContext("2d").getImageData(0, 0, side, side).data;
                mask = mask.slice();
                for (let k = 0; k < mask.length; k++) mask[k] = Math.floor((mask[k] * sel[k * 4 + 3] + 127) / 255);
            }
            if (p.src && mode !== "smudge" && (layer.x + bx / sx < 0 || layer.y + by / sy < 0 || layer.x + (bx + side) / sx > this.width || layer.y + (by + side) / sy > this.height)) {
                // a filter brush that reads the picture finds nothing outside it: laid down there it would erase the layer
                mask = mask.slice();
                for (let y = 0; y < side; y++) {
                    const iy = layer.y + (by + y + 0.5) / sy, rowOut = iy < 0 || iy >= this.height;
                    for (let x = 0; x < side; x++) {
                        const ix = layer.x + (bx + x + 0.5) / sx;
                        if (rowOut || ix < 0 || ix >= this.width) mask[y * side + x] = 0;
                    }
                }
            }
            const img = target.readRect(bx, by, side, side);
            let flags = layer.alphaLock ? SMUDGE_ALPHA_LOCK : 0;
            if (mode !== "smudge") {
                // blur and sharpen (step 6): the box and its surroundings filtered (the picture or the layer, as Sample says),
                // taken into the carry and laid down at the strength; nothing carried to the next step
                const pad = fxPad, big = side + 2 * pad;
                const around = p.src ? this.smudgeSample(p, target, bx - pad, by - pad, big) : (p.orig || target).readRect(bx - pad, by - pad, big, big).data;
                const t = p.tone;
                const f = mode === "tone" ? (t.sponge ? spongeRGBA(around, t.amount, t.mode === "saturate", t.vibrance) : toneRGBA(around, t.lut, t.protect))
                    : mode === "blur" ? blurRGBA(around, big, big, fxRadius) : sharpenRGBA(around, big, big, fxRadius, 1);
                const box = p.fxBox && p.fxBox.length === side * side * 4 ? p.fxBox : (p.fxBox = new Uint8ClampedArray(side * side * 4));
                for (let y = 0; y < side; y++) box.set(f.subarray(((y + pad) * big + pad) * 4, ((y + pad) * big + pad + side) * 4), y * side * 4);
                smudgeDabKernel(img.data, box, p.carry, mask, 0, 0, SMUDGE_PICKUP);
                smudgeDabKernel(img.data, box, p.carry, mask, strength, 0, flags);
                p.started = true;
            } else {
                if (!p.started) {
                    p.started = true;
                    if (o.finger) this.fillCarry(p.carry, this.color);   // the stroke starts with paint on the brush
                    else flags |= SMUDGE_PICKUP;
                }
                const src = p.src ? this.smudgeSample(p, target, bx, by, side) : img.data;   // the layer's own bytes: read before written, per pixel
                smudgeDabKernel(img.data, src, p.carry, mask, strength, keep, flags);
            }
            if (!(flags & SMUDGE_PICKUP)) {
                target.writeRect(img, bx, by);
                // the region pass reads the layer through its caches (the masked canvas, the match, the levels): the next
                // step's read has to see this one (the tile tier reads the tiles themselves)
                if (p.src && p.src.tier !== "tiles") {
                    layer._maskedValid = false; layer._mcache = null; layer._mcacheView = null; layer._mcacheSample = null;
                    const wx0 = Math.max(0, bx), wy0 = Math.max(0, by), wx1 = Math.min(target.width, bx + side), wy1 = Math.min(target.height, by + side);
                    if (wx1 > wx0 && wy1 > wy0) this.touchSourceRect(target, wx0, wy0, wx1, wy1);
                }
            }
        }
        layer._maskedValid = false;
        layer._mcache = null;
        layer._mcacheView = null; layer._mcacheSample = null;
        // the levels of the move's box are refreshed, not dropped for the whole layer (C6 b)
        const bx0 = Math.max(0, Math.floor(Math.min(lx0, lx1) - side / 2) - 2), by0 = Math.max(0, Math.floor(Math.min(ly0, ly1) - side / 2) - 2);
        const bx1 = Math.min(target.width, Math.ceil(Math.max(lx0, lx1) + side / 2) + 2), by1 = Math.min(target.height, Math.ceil(Math.max(ly0, ly1) + side / 2) + 2);
        if (bx1 > bx0 && by1 > by0) this.touchSourceRect(target, bx0, by0, bx1, by1);
    }

    /** The carry filled with one colour, opaque (finger painting). */
    fillCarry(carry, hex) {
        const [r, g, b] = hexToRgb(hex || "#000000");
        for (let k = 0; k < carry.length; k += 4) { carry[k] = r * 257; carry[k + 1] = g * 257; carry[k + 2] = b * 257; carry[k + 3] = 65535; }
    }

    /**
     * The smudge dab's coverage, `side` x `side` bytes: the round dab of radius `r` whose centre lies at (fx, fy) of the box
     * (full inside the hardness, falling linearly to 0 at `r`, as `dabMask`'s gradient), or an imported tip, its longer
     * side 2r, centred there. Kept for the last few sizes and fractions (a quarter pixel): a stroke asks the same ones.
     */
    smudgeMask(side, fx, fy, r, tip = null) {
        const qx = Math.round(fx * 4) / 4, qy = Math.round(fy * 4) / 4, h = Math.max(0, Math.min(0.97, this.hardness));
        const key = `${side}|${r.toFixed(2)}|${qx}|${qy}|${tip ? tip.id + "|" + tip.canvas.width : "round|" + h}`;
        const cache = this._smudgeMasks || (this._smudgeMasks = new Map());
        let m = cache.get(key);
        if (m) return m;
        m = new Uint8Array(side * side);
        if (tip) {
            const c = this._smudgeTip = cpuDab(this._smudgeTip, side);
            const ctx = c.getContext("2d");
            ctx.clearRect(0, 0, side, side);
            const k = 2 * r / Math.max(tip.canvas.width, tip.canvas.height), w = tip.canvas.width * k, hh = tip.canvas.height * k;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(tip.canvas, qx - w / 2, qy - hh / 2, w, hh);
            const d = ctx.getImageData(0, 0, side, side).data;
            for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
        } else {
            for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
                const d = Math.hypot(x + 0.5 - qx, y + 0.5 - qy) / r;
                m[y * side + x] = d <= h ? 255 : d >= 1 ? 0 : Math.round(255 * (1 - d) / (1 - h));
            }
        }
        if (cache.size >= 24) cache.delete(cache.keys().next().value);
        cache.set(key, m);
        return m;
    }

    /**
     * What the smudge samples for the box `side` x `side` at (bx, by) of `target` (the layer's pixels): the picture (Sample:
     * current and below, or the image; always on the base) through the gesture's source, as straight RGBA8 on the layer's
     * grid. An unscaled layer at whole pixels takes the source's bytes as they are; otherwise the box is drawn from the
     * source's canvas at the layer's scale.
     */
    smudgeSample(p, target, bx, by, side) {
        const layer = p.layer;
        const fx = layer.w / target.width, fy = layer.h / target.height;
        if (fx === 1 && fy === 1 && layer.x === Math.round(layer.x) && layer.y === Math.round(layer.y) && p.src.bytes) {
            return p.src.bytes([layer.x + bx, layer.y + by, layer.x + bx + side, layer.y + by + side]);
        }
        const ix = layer.x + bx * fx, iy = layer.y + by * fy, iw = side * fx, ih = side * fy;
        const c = this._smudgeSrc = cpuDab(this._smudgeSrc, side);
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, side, side);
        const got = p.src.read([Math.floor(ix) - 1, Math.floor(iy) - 1, Math.ceil(ix + iw) + 1, Math.ceil(iy + ih) + 1]);
        if (got) ctx.drawImage(got.canvas, ix - got.x, iy - got.y, iw, ih, 0, 0, side, side);
        return ctx.getImageData(0, 0, side, side).data;
    }

    /**
     * Heal: the patch in the dab canvas takes the destination's colour, the difference of the two means added to its
     * bytes when it is more than a level (both means over the pixels at least 8 in alpha: the patch's square and the
     * destination's square `w` at (x, y) of the image, read from `dst`). The means were an 8 x 8 downscale of two
     * whole-picture canvases with a readback each before 0.1.32; now they are the bytes' own, from CPU canvases.
     */
    healShift(dctx, size, dst, x, y, w) {
        const img = dctx.getImageData(0, 0, size, size), a = img.data;
        const ms = meanRGB(a);
        if (!ms) return;
        const t = this._healDest = cpuDab(this._healDest, size);
        const tctx = t.getContext("2d");
        tctx.clearRect(0, 0, size, size);
        tctx.drawImage(dst.canvas, x - dst.x, y - dst.y, w, w, 0, 0, size, size);
        const md = meanRGB(tctx.getImageData(0, 0, size, size).data);
        if (!md) return;
        const dr = md[0] - ms[0], dg = md[1] - ms[1], db = md[2] - ms[2];
        if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= 1) return;
        for (let k = 0; k < a.length; k += 4) { a[k] += dr; a[k + 1] += dg; a[k + 2] += db; }
        dctx.putImageData(img, 0, 0);
    }

    /** Clone / heal for one segment (the press); a move goes through `cloneStroke` with all its points. */
    cloneDab(p, x0, y0, x1, y1) {
        this.cloneStroke(p, x0, y0, [[x1, y1, p.pressure]]);
    }

    /**
     * Clone / heal: copy the source patch (offset by the stroke's offset) into the stroke buffer; heal shifts its colour to
     * the destination's. One read a move (PLAN_0_1_31 §4 step 2): the box that every dab of the move, from (x0, y0) through
     * `pts` ([x, y, pressure], image pixels), takes its patch from, and for heal the box of the picture under the move; the
     * gesture's source (`brushSource`) composites it. The dabs go evenly along the whole path past its start, as one
     * segment's did; 0.1.32 read, stamped and drew a box per coalesced point of a pen, five to seven times slower at 700 to
     * 1,000 px (docs/BUGS.md, fixed for 0.1.33). A segment's dab takes the pressure of its end.
     */
    cloneStroke(p, x0, y0, pts) {
        if (!pts.length) return;
        const layer = p.layer, s = p.stroke, cl = p.clone;
        const sx = s.tw / layer.w, sy = s.th / layer.h;
        const tip = this.brushTip();
        // the source point of an image point d: S + A (d - D), D the point the source was lined up with (S - off);
        // without a transform A is 1 and it is d + off, as before
        const xf = cl.xf, S = cl.S || { x: x0 + cl.off.x, y: y0 + cl.off.y }, Dx = S.x - cl.off.x, Dy = S.y - cl.off.y;
        const qOf = (x, y) => (xf ? [S.x + xf.A[0] * (x - Dx) + xf.A[1] * (y - Dy), S.y + xf.A[2] * (x - Dx) + xf.A[3] * (y - Dy)] : [x + cl.off.x, y + cl.off.y]);
        // the path in image pixels, each segment with its dab: R in image px, r in layer px, the dab's side
        const segs = [];
        let ax = x0, ay = y0, Rmax = 0;
        let q = qOf(x0, y0), qb = [q[0], q[1], q[0], q[1]], db = [x0, y0, x0, y0];
        for (const [x, y, pr] of pts) {
            const R = Math.max(0.5, this.brushSize / 2 * Math.max(0.05, Math.min(1, pr || 1)));
            const r = Math.max(1, R * (sx + sy) / 2);
            this.strokeBounds(p, ax, ay, x, y, R + 2);
            this.strokeDirty(p, ax, ay, x, y, R + 2);
            const step = Math.max(1, tip ? (tip.spacing || this.brushTipSpacing || 0.25) * 2 * R : R * 0.25);
            segs.push({ x0: ax, y0: ay, x1: x, y1: y, len: Math.hypot(x - ax, y - ay), R, r, size: Math.ceil(r * 2), step });
            if (R > Rmax) Rmax = R;
            q = qOf(x, y);
            qb = [Math.min(qb[0], q[0]), Math.min(qb[1], q[1]), Math.max(qb[2], q[0]), Math.max(qb[3], q[1])];
            db = [Math.min(db[0], x), Math.min(db[1], y), Math.max(db[2], x), Math.max(db[3], y)];
            ax = x; ay = y;
        }
        const reach = xf ? Rmax * Math.SQRT2 / xf.k : Rmax;   // a turned, scaled dab reads up to its corners
        const span = (b, e) => [Math.floor(b[0] - e) - 2, Math.floor(b[1] - e) - 2, Math.ceil(b[2] + e) + 2, Math.ceil(b[3] + e) + 2];
        const src = cl.src.read(span(qb, reach), 0);
        const dst = cl.heal && src ? cl.dest.read(span(db, Rmax), 1) : null;
        const rMax = Math.max(1, Rmax * (sx + sy) / 2);
        s.draw((db[0] - layer.x) * sx - rMax - 1, (db[1] - layer.y) * sy - rMax - 1, (db[2] - layer.x) * sx + rMax + 1, (db[3] - layer.y) * sy + rMax + 1, (sctx) => {
            if (!src) return;   // the source lies outside the picture: nothing to copy
            let d = null, dctx = null, mask = null, at = null;
            this.pathStamps(segs, (x, y, g) => {
                const { R, r, size } = g;
                if (at !== g && (!at || at.size !== size || at.r !== r)) {
                    d = this._cloneDab = cpuDab(this._cloneDab, size);
                    dctx = d.getContext("2d");
                    mask = tip ? this.tipMaskCanvas(size, r, tip) : this.dabMask(r, this.hardness);
                }
                at = g;
                dctx.globalCompositeOperation = "source-over";
                dctx.clearRect(0, 0, size, size);
                if (!xf) {
                    const qx = x + cl.off.x, qy = y + cl.off.y;
                    dctx.drawImage(src.canvas, qx - R - src.x, qy - R - src.y, R * 2, R * 2, 0, 0, size, size);
                } else {
                    // the source canvas drawn through the inverse: dab pixel u = sc (D + Ai (q - S) - (x - R, y - R)), q its image point
                    const sc = size / (2 * R), Ai = xf.Ai, ox = src.x - S.x, oy = src.y - S.y;
                    dctx.setTransform(sc * Ai[0], sc * Ai[2], sc * Ai[1], sc * Ai[3],
                        sc * (Ai[0] * ox + Ai[1] * oy + Dx - (x - R)), sc * (Ai[2] * ox + Ai[3] * oy + Dy - (y - R)));
                    dctx.imageSmoothingEnabled = true;
                    dctx.drawImage(src.canvas, 0, 0);
                    dctx.setTransform(1, 0, 0, 1, 0, 0);
                }
                if (dst) this.healShift(dctx, size, dst, x - R, y - R, R * 2);
                dctx.globalCompositeOperation = "destination-in";
                dctx.drawImage(mask, 0, 0);
                const lx = (x - layer.x) * sx, ly = (y - layer.y) * sy;
                sctx.drawImage(d, lx - r, ly - r);
            }, false);
        });
    }

    /** The release of a layer stroke: its undo step and the write, and what depends on the layer. */
    commitLayerPaint(p) {
        const box = this.strokeRect(p, p.layer.px);
        this.commitStroke(p);
        // a move's two places each (`undoBoxes`), not the box around both
        if (p.undoBoxes) for (const b of p.undoBoxes) this.markLayerChanged(p.layer, b);
        else this.markLayerChanged(p.layer, box);
        this.releaseStrokeScratch();
        // a patch or a move is no stroke a Shift+click line could go on from
        if (!p.grad && !p.patch && !p.move) this.lastStrokeEnd = { layerId: p.layer.id, x: p.last[0], y: p.last[1], mask: false };
    }

    /** The Remove model loaded while the user aims (about 9 s the first time), with a line in the status bar. */
    warmRemove() {
        if (!host.removeSupported) return;
        const move = this.tool === "contentmove";
        if (!host.removeModel()) { this.setStatus(move ? "Content-aware move needs the LaMa model to fill the old place: download it in Settings › Helpers (in-app models), or set Mode to Extend." : "Remove needs the LaMa model: download it in Settings › Helpers (in-app models).", "warn"); return; }
        if (this._removeWarming) return;
        // asked at every pick: the process may have been stopped (a model folder change), and a loaded one answers at once
        this._removeWarming = true;
        if (!this._removeReady) this.setStatus(`Loading LaMa for ${move ? "Content-aware move" : "Remove"} (about 10 s the first time)...`);
        host.warmRemove(this).then((r) => {
            this._removeWarming = false;
            this._removeReady = !!(r && r.ready);
            if ((this.tool !== "remove" && this.tool !== "contentmove") || this.pointer) return;
            this.setStatus(r && r.ready ? (this.tool === "remove" ? "LaMa is ready: brush over what should go." : "LaMa is ready: lasso the object, then drag it.") : `LaMa could not be loaded: ${(r && r.error) || "no model"}.`, r && r.ready ? "info" : "warn");
        });
    }

    /**
     * The clone source's transform (PLAN_0_1_31 §4 step 4) from the options, or null when it is none: the source turned
     * by `angle` degrees, `scale` percent as large and mirrored where it lands. `A` maps an offset from the lined-up
     * point D to the source's offset from S, `q = S + A (d - D)`, A = (1/k) R(-angle) F; `Ai` is its inverse, k F R(angle);
     * both as [a, b, c, d] for [[a, b], [c, d]].
     */
    cloneXf(o = this.cloneOpts || {}) {
        const t = (+o.angle || 0) * Math.PI / 180, k = Math.max(0.1, Math.min(4, (+o.scale || 100) / 100));
        const fx = o.flipX ? -1 : 1, fy = o.flipY ? -1 : 1;
        if (!t && k === 1 && fx === 1 && fy === 1) return null;
        const c = Math.cos(t), s = Math.sin(t);
        return { k, A: [c * fx / k, s * fy / k, -s * fx / k, c * fy / k], Ai: [k * fx * c, -k * fx * s, k * fy * s, k * fy * c] };
    }

    /** An imported tip as a dab mask: a CPU canvas `size` a side, the tip's longer side 2r, in the middle (clone and heal). */
    tipMaskCanvas(size, r, tip) {
        const key = `${size}|${r.toFixed(2)}|${tip.id}|${tip.canvas.width}`;
        if (this._tipMask && this._tipMask.key === key) return this._tipMask.c;
        const c = cpuDab(null, size), ctx = c.getContext("2d");
        const k = 2 * r / Math.max(tip.canvas.width, tip.canvas.height), w = tip.canvas.width * k, h = tip.canvas.height * k;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tip.canvas, size / 2 - w / 2, size / 2 - h / 2, w, h);
        this._tipMask = { key, c };
        return c;
    }

    /**
     * The clone overlay (PLAN_0_1_31 §4 step 4): what the brush at `hv` would copy, drawn half transparent inside the brush
     * circle, turned, scaled and mirrored as the options say. Its pixels are the view's own composite (`viewCanvas`, the
     * region the last scene was built from), so it costs one clipped draw and no read; while the source is outside that
     * region nothing is drawn but the source's circle. `ctx` is in image coordinates.
     */
    drawCloneGhost(ctx, hv, D, S, xf, q) {
        const reg = this._viewRegion, img = this.viewCanvas;
        if (!reg || !img) return;
        const R = this.brushSize / 2, reach = (xf ? R * Math.SQRT2 / xf.k : R) + 1;
        if (q[0] - reach < reg.x || q[1] - reach < reg.y || q[0] + reach > reg.x + reg.w || q[1] + reach > reg.y + reg.h) return;
        const Ai = xf ? xf.Ai : [1, 0, 0, 1];
        ctx.save();
        ctx.beginPath(); ctx.arc(hv[0], hv[1], R, 0, Math.PI * 2); ctx.clip();
        ctx.globalAlpha = 0.5;
        // the source point q shows at d = D + Ai (q - S)
        ctx.transform(Ai[0], Ai[2], Ai[1], Ai[3], D.x - (Ai[0] * S.x + Ai[1] * S.y), D.y - (Ai[2] * S.x + Ai[3] * S.y));
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, reg.x, reg.y, reg.w, reg.h);
        ctx.restore();
    }
}
