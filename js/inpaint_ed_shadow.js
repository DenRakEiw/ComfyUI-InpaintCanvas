// Generated from scumble-app/scumble renderer/editor/inpaint_ed_shadow.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// *Layer › Add Contact Shadow* (item 61, docs/PLAN_0_1_57.md): a plain pixel layer in multiply directly under a layer
// with transparency (a cut-out, a key, a pasted picture), its shadow from the layer's coverage (`inpaint_shadow.js`).
// The work runs on a coverage grid of the object's own box at a working scale (never a document-size canvas: on tiles
// the coverage is read from the region canvases at a mip level, as the screen reads them), the shadow's own grid is
// capped in cells, and the layer that lands is the shadow's trimmed box at the picture's resolution. The dialog's
// preview is drawn over the screen only (`drawShadowOverlay`, from drawOverlays): it is never a layer of the document.

import { SHADOW_DEFAULTS, SHADOW_MAX_CELLS, SHADOW_MAX_CELLS_PREVIEW, SHADOW_WORK, SHADOW_WORK_PREVIEW, coarserCoverage, contactShadow, shadowAt, shadowExtent, shadowParams } from "./inpaint_shadow.js";
import { makeCanvas } from "./inpaint_consts.js";
import { mapEnc, sampleMap } from "./inpaint_maps.js";
import { xfApply, xfInv } from "./inpaint_resample.js";
import { u16Bilinear } from "./inpaint_weights.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { failKind } from "./inpaint_status.js";

/** The coarse pass that finds the object inside its layer (a cut-out often spans the whole picture). */
const FIND_WORK = 512;
/** Above this many pixels the shadow layer keeps a lower resolution of its own (drawn scaled, as a result layer is). */
const FULL_CAP = 100e6;
/** Rows of the full-size layer written at a time. */
const BAND = 256;

/** A depth sampler in image coordinates for `map`: the map's inverse transform taken once, not per cell. */
function depthSampler(map) {
    if (mapEnc(map).id !== "u16") return (X, Y) => sampleMap(map, X, Y);
    const inv = xfInv(map.xf || [map.w, 0, 0, map.h, 0, 0]);
    const { data, w, h } = map;
    return (X, Y) => { const [ux, uy] = xfApply(inv, X, Y); return u16Bilinear(data, w, h, ux * w, uy * h); };
}

export class ShadowPart {
    /** `layer` as the stack holds it now: an undo puts copies of the layers back, so a caller's object may be stale. */
    liveShadowLayer(layer) {
        return (layer && this.layers.find((l) => l.id === layer.id)) || layer;
    }

    /** Why `layer` can have no contact shadow (a sentence for the status line), or null when it can. */
    shadowRefusal(layer) {
        if (!this.width) return "Load an image first.";
        if (!layer || !layer.px || layer.kind === "filter") return "Select a layer with transparency (a cut-out, a key, a pasted picture) to give it a contact shadow.";
        if (this.isReference(layer) || this.isControl(layer)) return `${layer.name} is not part of the picture: it casts no shadow.`;
        if (this.isLocked(layer) && !layer.locked) return `${layer.name} is in a locked group: unlock the group first.`;
        if (this.pending && this.pending.layer === layer) return `Apply or cancel the transform of ${layer.name} first.`;
        return null;
    }

    /**
     * `layer`'s coverage (its alpha with a live mask) over the image region `r` [x0, y0, x1, y1] at about `work` px. On
     * tiles the pixels and the mask are drawn from their region canvases at the level the scale asks for
     * (`drawTilesInto`): no display mirror of a whole layer, no canvas past Chromium's limits.
     */
    shadowCoverage(layer, r, work) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const s = Math.min(1, work / Math.max(rw, rh));
        const tw = Math.max(1, Math.round(rw * s)), th = Math.max(1, Math.round(rh * s));
        const sx = tw / rw, sy = th / rh;
        const c = makeCanvas(tw, th), ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.setTransform(sx, 0, 0, sy, -r[0] * sx, -r[1] * sy);
        const vp = { x: r[0], y: r[1], w: rw, h: rh, sx };
        // false: the region holds no tile (nothing drawn)
        const put = (px) => {
            if (isTilePixels(px)) return this.drawTilesInto(ctx, px, layer.x, layer.y, layer.w, layer.h, vp);
            px.drawTo(ctx, layer.x, layer.y, layer.w, layer.h);
            return true;
        };
        put(layer.px);
        const mask = this.liveMask(layer);
        if (mask) {
            ctx.globalCompositeOperation = "destination-in";
            // a mask with no tile in the region hides all of it there
            if (!put(mask)) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, tw, th); ctx.restore(); }
            ctx.globalCompositeOperation = "source-over";
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const d = ctx.getImageData(0, 0, tw, th).data;
        c.width = 1; c.height = 1;
        const alpha = new Float32Array(tw * th);
        for (let i = 0; i < alpha.length; i++) alpha[i] = d[4 * i + 3] / 255;
        return { alpha, w: tw, h: th, x0: r[0], y0: r[1], sx, sy };
    }

    /**
     * The object of `layer` as a coverage grid at about `work` px on its long side: a coarse pass finds the object's
     * box inside the layer, the second draws that box alone. Null when the layer has nothing opaque in the picture.
     */
    shadowSource(layer, work = SHADOW_WORK) {
        const lb = [Math.max(0, Math.floor(layer.x)), Math.max(0, Math.floor(layer.y)), Math.min(this.width, Math.ceil(layer.x + layer.w)), Math.min(this.height, Math.ceil(layer.y + layer.h))];
        if (lb[2] - lb[0] < 1 || lb[3] - lb[1] < 1) return null;
        const coarse = this.shadowCoverage(layer, lb, FIND_WORK);
        let x0 = coarse.w, y0 = coarse.h, x1 = -1, y1 = -1;
        for (let y = 0; y < coarse.h; y++) for (let x = 0; x < coarse.w; x++) {
            if (coarse.alpha[y * coarse.w + x] < 0.02) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < 0) return null;
        // a cell and a half of the coarse grid around it: its smoothing reaches that far
        const ob = [
            Math.max(lb[0], Math.floor(lb[0] + (x0 - 1.5) / coarse.sx)), Math.max(lb[1], Math.floor(lb[1] + (y0 - 1.5) / coarse.sy)),
            Math.min(lb[2], Math.ceil(lb[0] + (x1 + 2.5) / coarse.sx)), Math.min(lb[3], Math.ceil(lb[1] + (y1 + 2.5) / coarse.sy)),
        ];
        return this.shadowCoverage(layer, ob, work);
    }

    /**
     * The shadow grid of a source (`shadowSource`) for the parameters: `{ grid, src }`, `src` the source it was made on
     * (coarser than the one given when the shadow's grid would pass `maxCells`: a long reach, a wide softness or a
     * strong skew). The depth map fades it where there is one. `grid` null when the source has nothing opaque.
     */
    shadowGrid(src, params, maxCells = SHADOW_MAX_CELLS) {
        for (let i = 0; i < 8; i++) {
            const e = shadowExtent(src.alpha, src.w, src.h, params);
            if (!e) return { grid: null, src };
            if (e.cells <= maxCells || (src.w <= 8 && src.h <= 8)) break;
            src = coarserCoverage(src, Math.max(2, Math.ceil(Math.sqrt(e.cells / maxCells))));
        }
        const depth = this.maps && this.maps.depth && this.maps.depth.data ? this.maps.depth : null;
        const at = depth ? depthSampler(depth) : null;
        const s = src;
        const depthAt = at ? (gx, gy) => at(s.x0 + (gx + 0.5) / s.sx, s.y0 + (gy + 0.5) / s.sy) : null;
        return { grid: contactShadow({ alpha: src.alpha, w: src.w, h: src.h, params, depthAt }), src };
    }

    /**
     * The shadow as layer pixels and their place: `{ px, x, y, w, h }`, null when nothing of it falls in the picture.
     * At the picture's resolution (up to FULL_CAP pixels), black with the shadow as its alpha.
     */
    shadowLayerData(src, grid) {
        if (!grid || !grid.trim) return null;
        const [tx0, ty0, tx1, ty1] = grid.trim;
        const X0 = Math.max(0, Math.floor(src.x0 + (grid.x + tx0) / src.sx)), Y0 = Math.max(0, Math.floor(src.y0 + (grid.y + ty0) / src.sy));
        const X1 = Math.min(this.width, Math.ceil(src.x0 + (grid.x + tx1) / src.sx)), Y1 = Math.min(this.height, Math.ceil(src.y0 + (grid.y + ty1) / src.sy));
        const W = X1 - X0, H = Y1 - Y0;
        if (W < 1 || H < 1) return null;
        const f = Math.min(1, Math.sqrt(FULL_CAP / (W * H)));
        const pw = Math.max(1, Math.round(W * f)), ph = Math.max(1, Math.round(H * f));
        const fx = W / pw, fy = H / ph;
        const px = this.pixels.Layer.empty(pw, ph);
        for (let b0 = 0; b0 < ph; b0 += BAND) {
            const bh = Math.min(BAND, ph - b0);
            const data = new Uint8ClampedArray(pw * bh * 4);
            let any = false;
            for (let j = 0; j < bh; j++) {
                const Y = Y0 + (b0 + j + 0.5) * fy;
                const v = (Y - src.y0) * src.sy - 0.5 - grid.y;
                const row = j * pw * 4;
                for (let i = 0; i < pw; i++) {
                    const X = X0 + (i + 0.5) * fx;
                    const a = shadowAt(grid, (X - src.x0) * src.sx - 0.5 - grid.x, v);
                    if (a > 0) { const q = Math.round(a * 255); if (q) { data[row + i * 4 + 3] = q; any = true; } }
                }
            }
            // an empty layer keeps no tiles where nothing was written
            if (any) px.writeRect({ data, width: pw, height: bh }, 0, b0, "copy");
        }
        return { px, x: X0, y: Y0, w: W, h: H };
    }

    /**
     * The dialog's preview over the screen: the grid's own cells, black with the shadow as alpha where the layer itself
     * does not cover it (the layer sits over its shadow; a layer above it is not taken into account). `{ canvas, x, y,
     * w, h }` in image coordinates, null when nothing falls in the picture.
     */
    shadowPreviewCanvas(src, grid) {
        if (!grid || !grid.trim) return null;
        const [tx0, ty0, tx1, ty1] = grid.trim;
        const cx0 = Math.max(tx0, Math.ceil((0 - src.x0) * src.sx - grid.x)), cy0 = Math.max(ty0, Math.ceil((0 - src.y0) * src.sy - grid.y));
        const cx1 = Math.min(tx1, Math.floor((this.width - src.x0) * src.sx - grid.x)), cy1 = Math.min(ty1, Math.floor((this.height - src.y0) * src.sy - grid.y));
        if (cx1 <= cx0 || cy1 <= cy0) return null;
        const pw = cx1 - cx0, ph = cy1 - cy0;
        const img = new ImageData(pw, ph), d = img.data;
        for (let v = 0; v < ph; v++) {
            const ay = grid.y + cy0 + v;
            for (let u = 0; u < pw; u++) {
                const ax = grid.x + cx0 + u;
                const own = ax >= 0 && ay >= 0 && ax < src.w && ay < src.h ? src.alpha[ay * src.w + ax] : 0;
                d[(v * pw + u) * 4 + 3] = Math.round(grid.data[(cy0 + v) * grid.w + cx0 + u] * (1 - own) * 255);
            }
        }
        const canvas = makeCanvas(pw, ph);
        canvas.getContext("2d").putImageData(img, 0, 0);
        return { canvas, x: src.x0 + (grid.x + cx0) / src.sx, y: src.y0 + (grid.y + cy0) / src.sy, w: pw / src.sx, h: ph / src.sy };
    }

    /** The dialog's preview, from drawOverlays (the view's transform applied): screen only, never in a layer or a file. */
    drawShadowOverlay(ctx) {
        const o = this._shadowOverlay;
        if (!o || !o.canvas || !(o.opacity > 0)) return;
        ctx.save();
        ctx.globalAlpha = o.opacity;
        ctx.imageSmoothingEnabled = true;
        // black at alpha a over the picture is the multiply of the layer that Apply makes
        ctx.drawImage(o.canvas, o.x, o.y, o.w, o.h);
        ctx.restore();
    }

    /**
     * Where the shadow of `layer` goes in the stack: the index it is inserted at, its group and whether it is clipped.
     * Directly under the layer; under a clipped layer's whole clip, below the layer it targets, so the shadow never
     * becomes the base it clips to. A clip with nothing to target in its group (it draws as it is) gets a shadow
     * clipped as well, under the chain, which then draws as it is too.
     */
    shadowPlace(layer) {
        const i = this.layers.indexOf(layer);
        if (!layer.clip) return { at: i, group: layer.group || null, clip: false };
        const target = this.clipTargetOf(layer, i);
        // clipped to a pixel layer: the shadow goes right under the layer, clipped to the same base. Under the base it was
        // hidden wherever the base is opaque, the only place the layer shows (review 2026-11-16
        // p1-outpaint-shadow/clipped-layer-shadow-placed-under-clip-base)
        if (target && target.kind !== "filter") return { at: i, group: layer.group || null, clip: true };
        // clipped over a filter (a clip without effect): under the filter, which stays the target
        if (target) return { at: this.layers.indexOf(target), group: target.group || null, clip: false };
        let j = i;
        while (j > 0 && this.layers[j - 1].clip && (this.layers[j - 1].group || null) === (layer.group || null)) j--;
        return { at: j, group: layer.group || null, clip: true };
    }

    /**
     * The contact shadow of `layer` as a new layer under it (multiply, `opacity` as the layer's), one undo step
     * ("layers"). `params`: distance, softness, opacity, skew (`shadowParams`). The new layer, or null with the status
     * line saying why (a failure, such as memory, is a red line, not a thrown error).
     */
    addContactShadow(layer, params = {}) {
        layer = this.liveShadowLayer(layer);
        const why = this.shadowRefusal(layer);
        if (why) { this.setStatus(why, "info"); return null; }
        const p = shadowParams(params);
        const t0 = performance.now();
        let made;
        try {
            const src0 = this.shadowSource(layer, SHADOW_WORK);
            const { grid, src } = src0 ? this.shadowGrid(src0, p) : { grid: null, src: null };
            if (!grid) { this.setStatus(`${layer.name} has no opaque part in the picture: it casts no shadow.`, "info"); return null; }
            made = { grid, data: this.shadowLayerData(src, grid) };
        } catch (err) {
            console.error(err);
            this.setStatus(`The contact shadow of ${layer.name} failed: ${err && err.message ? err.message : err}`, failKind(err) || "error");
            return null;
        }
        const { grid, data } = made;
        if (!data) { this.setStatus(`The shadow of ${layer.name} falls outside the picture.`, "info"); return null; }
        this.pushUndo({ kind: "layers", label: "Contact shadow" });
        const place = this.shadowPlace(layer);
        const out = this.addLayer({ name: `${layer.name} shadow`, kind: "paint", ref: null, px: data.px, x: data.x, y: data.y, w: data.w, h: data.h, dirty: true, blend: "multiply", opacity: p.opacity, clip: place.clip }, { activate: false, quiet: true });
        const now = this.layers.indexOf(out);
        if (place.at >= 0 && now > place.at) { this.layers.splice(now, 1); this.layers.splice(place.at, 0, out); }
        if (place.group) out.group = place.group;
        this.layersRestacked();
        this.markLayerChanged(out);
        this.renderLayers();
        this.draw();
        const ms = Math.round(performance.now() - t0);
        this._shadowMs = ms;
        const depth = grid.footDepth != null ? ", faded by the depth map where the ground lies farther" : "";
        this.setStatus(`${out.name} added under ${layer.name} (multiply, ${Math.round(p.opacity * 100)} %${depth}) in ${ms} ms. Paint or erase on it as on any layer; Ctrl+Z takes it back.`);
        return out;
    }

    /**
     * The dialog: distance, softness, opacity and skew with the shadow shown live while it is open (drawn over the
     * screen at the working grid's resolution, never a layer: a save, the autosave, an agent's command or an undo
     * meanwhile see the document as it is). Apply makes the layer at the picture's resolution as one undo step; Cancel
     * leaves nothing. Resolves with the new layer or null; a failure is a red status line.
     */
    async contactShadowDialog(layer = this.activeLayer()) {
        try {
            return await this.contactShadowDialogNow(layer);
        } catch (err) {
            this._shadowOverlay = null;
            console.error(err);
            this.setStatus(`The contact shadow failed: ${err && err.message ? err.message : err}`, failKind(err) || "error");
            if (this.isOpen) this.draw();
            return null;
        }
    }

    async contactShadowDialogNow(layer) {
        layer = this.liveShadowLayer(layer);
        const why = this.shadowRefusal(layer);
        if (why) { this.setStatus(why, "info"); return null; }
        const src = this.shadowSource(layer, SHADOW_WORK_PREVIEW);
        if (!src) { this.setStatus(`${layer.name} has no opaque part in the picture: it casts no shadow.`, "info"); return null; }
        const last = { ...SHADOW_DEFAULTS, ...(this._shadowLast || {}) };
        const pct = (v) => Math.round(v * 100);
        let timer = 0;
        const valuesOf = (v) => shadowParams({ distance: v.distance, softness: v.softness, opacity: v.opacity / 100, skew: v.skew });
        const show = (v) => {
            const p = valuesOf(v);
            try {
                const { grid, src: used } = this.shadowGrid(src, p, SHADOW_MAX_CELLS_PREVIEW);
                const pv = this.shadowPreviewCanvas(used, grid);
                this._shadowOverlay = pv ? { ...pv, opacity: p.opacity } : null;
            } catch (err) {
                this._shadowOverlay = null;
                console.error(err);
                this.setStatus(`The shadow's preview failed: ${err && err.message ? err.message : err}`, failKind(err) || "error");
            }
            this.draw();
        };
        show({ distance: last.distance, softness: last.softness, opacity: pct(last.opacity), skew: last.skew });
        const asked = this.ask({
            title: `Contact shadow for ${layer.name}`,
            message: "A soft shadow from the layer's shape, darkest where it meets the ground, as a multiply layer of its own under it. Distance and softness are % of the layer's height; direction shifts the far end sideways." + (this.maps && this.maps.depth && this.maps.depth.data ? " The depth map fades it where the ground lies farther than the layer's foot." : ""),
            fields: [
                { key: "distance", label: "Distance (%)", value: last.distance, min: 1, max: 300 },
                { key: "softness", label: "Softness (%)", value: last.softness, min: 0, max: 100 },
                { key: "opacity", label: "Opacity (%)", value: pct(last.opacity), min: 0, max: 100 },
                { key: "skew", label: "Direction (%)", value: last.skew, min: -100, max: 100 },
            ],
            ok: "Apply",
            onChange: (key, values) => {
                clearTimeout(timer);
                // the opacity is the layer's: no new shadow for it
                if (key === "opacity" && this._shadowOverlay) { this._shadowOverlay.opacity = valuesOf(values).opacity; this.draw(); return; }
                timer = setTimeout(() => show(values), 40);
            },
        });
        // the preview stays visible: a clear backdrop, the box in the top right corner (a shadow lies low), a slider
        // under each number box
        const wrap = this.askOpen;
        if (wrap) {
            wrap.style.background = "transparent";
            wrap.style.alignItems = "flex-start";
            wrap.style.justifyContent = "flex-end";
            wrap.style.padding = "16px";
            for (const inp of wrap.querySelectorAll(".ipc-askfields input[type=number]")) {
                const range = document.createElement("input");
                range.type = "range"; range.min = inp.min; range.max = inp.max; range.step = "1"; range.value = inp.value;
                range.addEventListener("input", () => { inp.value = range.value; inp.dispatchEvent(new Event("input")); });
                inp.addEventListener("input", () => { if (range.value !== inp.value) range.value = inp.value; });
                inp.parentNode.appendChild(range);
            }
        }
        let v;
        try { v = await asked; } finally {
            clearTimeout(timer);
            this._shadowOverlay = null;
            if (this.isOpen) this.draw();
        }
        if (!v || typeof v !== "object") { this.setStatus("Contact shadow cancelled.", "info"); return null; }
        const p = valuesOf(v);
        this._shadowLast = p;
        const now = this.layers.find((l) => l.id === layer.id);
        if (!now) { this.setStatus("The layer went away meanwhile: no shadow made.", "info"); return null; }
        return this.addContactShadow(now, p);
    }
}
