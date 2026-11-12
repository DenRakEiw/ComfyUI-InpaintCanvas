// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_filters.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// emulated blends, frequency separation, dodge / burn, filter layers, picture stats, the range preview, applyFilterLayer: moved out of inpaint_canvas.js (item 56 S7, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { FILTERS, applyFilter, colourStats, fillPixels, filterDefaults, lutFromCube, lutToCanvas, plateStats } from "./inpaint_filters.js";
import { beginScope, drawSurfaceTo, endScope, glChainUsable, glToCanvas, isGLSurface, releaseSurface, runShader, surfaceToCanvas } from "./inpaint_filters_gl.js";
import { OPS, compositeTile, freqSeparate } from "./px/kernels.js";
import { bandRows } from "./inpaint_bands.js";
import { toneLUT } from "./inpaint_stroke.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { markStep } from "./inpaint_jobs.js";
import { uploadBlob, uploadCanvas } from "./inpaint_upload.js";
import { passToMap, sampleMap } from "./inpaint_maps.js";
import { colourSimilarity, hexToRgb as hexToRgb01, opp, rangeWeight, u16Bilinear } from "./inpaint_weights.js";
import { limitAlphaRows } from "./inpaint_limit.js";
import { BLEND_OPS, EMULATED_BLENDS, canvasOp, hash32, mul255, seedOfLayer } from "./blend_modes.js";
import { failKind } from "./inpaint_status.js";
import { FREQ_MAX_PX, cpuDab, makeCanvas } from "./inpaint_consts.js";
import { DISSOLVE_CLIP_SHADER, DISSOLVE_SHADER, EMULATED_BLEND_CLIP_SHADER, EMULATED_BLEND_SHADER, RANGE_PREVIEW_SHADER } from "./inpaint_shaders.js";
import { UploadCache, sourceTag } from "./inpaint_strokebuf.js";
import { canvasRows, loadImageEl, viewUrl } from "./inpaint_load.js";

export class FiltersPart {
    /**
     * Draw in a blend mode Canvas 2D has no operation for (linear light, PLAN_0_1_31 §4 step 8; PLAN_NIK9's other modes
     * would join `EMULATED_BLENDS`): `draw(c)` puts the layer alone onto a scratch of `ctx`'s canvas size, with `ctx`'s
     * transform and smoothing, at full opacity (the layer's `opacity` goes to the blend, as the worker stack takes it:
     * baked into the 8-bit scratch its rounding came out doubled by linear light's slope), then blended over the canvas: on the GPU for a screen pass (the compositor's
     * formula through runShader: a readback of the view canvas every frame would trip Chromium's acceleration latch),
     * else on the CPU through `compositeTile`, the worker stack's own kernel (the flatten, the bands, the merges). A
     * colour-matched layer drawn into the scratch finds no backdrop there: its statistics come from the sampled passes.
     *
     * `clip` (PLAN_0_1_31 §6 step 3): the coverage of a clipped layer's base (`clipCoverage`, a canvas of `ctx`'s size in
     * its pixels): the scratch keeps the layer only where the base is (`destination-in`), and then goes over the canvas
     * in any blend mode, the ones Canvas 2D has as well.
     *
     * Dissolve (`seed`, the layer's `seedOfLayer`): a pixel is kept or dropped by a hash of its image pixel, so the dots
     * stay where they are on every path. `toImage` maps the canvas's pixels to image pixels for that hash; without it
     * the inverse of `ctx`'s transform does, which is right for a canvas the image is drawn into through its transform
     * (the screen, the region pass, the flatten). A canvas whose transform does not say where its origin lies in the
     * image (a merge's union box, drawn at offsets of its own) passes the map.
     */
    blendEmulated(ctx, mode, draw, opacity = 1, clip = null, seed = null, toImage = null) {
        const cv = ctx.canvas, W = cv.width, H = cv.height;
        if (!W || !H) return;
        const screen = !!(this.viewPass && this.viewPass.screen);
        const slot = screen ? "_blendScratchGpu" : "_blendScratchCpu";
        let s = this[slot];
        if (!s || s.width !== W || s.height !== H) s = this[slot] = screen ? makeCanvas(W, H) : cpuDab(null, W, H);
        const sc = s.getContext("2d");
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1; sc.globalCompositeOperation = "source-over";
        sc.clearRect(0, 0, W, H);
        sc.setTransform(ctx.getTransform());
        sc.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
        draw(sc);
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1;
        const op = mode && mode !== "normal" ? OPS[mode] : 0;
        // a clip on the screen in a mode Canvas 2D has (or in one the kernel lacks): the scratch cut to the base's coverage
        // and drawn over. Off the screen the kernel below takes the coverage as the layer's mask, as the workers do:
        // `destination-in` rounds the premultiplied scratch, which a mode's slope then magnifies (5 levels, measured)
        if (clip && !EMULATED_BLENDS.has(mode) && (screen || !(op >= 0))) {
            sc.globalCompositeOperation = "destination-in";
            sc.globalAlpha = (clip._clipAlpha ?? 255) / 255;
            sc.drawImage(clip, 0, 0);
            sc.globalAlpha = 1;
            sc.globalCompositeOperation = "source-over";
        }
        if (!EMULATED_BLENDS.has(mode) && (screen || !clip || !(op >= 0))) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
            ctx.globalCompositeOperation = canvasOp(mode);
            ctx.drawImage(s, 0, 0);
            ctx.restore();
            return;
        }
        if (screen && EMULATED_BLENDS.has(mode)) {
            let out = null;
            if (mode === "dissolve") {
                const inv = toImage || ctx.getTransform().inverse();
                const seedVal = seed !== null ? (seed >>> 0) : 0;
                const uniforms = {
                    u_layer: s,
                    u_alpha255: Math.round(Math.max(0, Math.min(1, opacity)) * 255),
                    u_seed_hi: (seedVal >>> 16) & 0xffff,
                    u_seed_lo: seedVal & 0xffff,
                    u_invX: [inv.a, inv.c, inv.e],
                    u_invY: [inv.b, inv.d, inv.f],
                };
                if (clip) uniforms.u_clip = clip;
                try {
                    out = clip
                        ? runShader(DISSOLVE_CLIP_SHADER, cv, uniforms)
                        : runShader(DISSOLVE_SHADER, cv, uniforms);
                } catch (err) {
                    console.warn("Inpaint Canvas: the dissolve blend shader failed, blending on the CPU:", err);
                }
            } else {
                const uMode = BLEND_OPS[mode];
                try {
                    out = clip
                        ? runShader(EMULATED_BLEND_CLIP_SHADER, cv, { u_layer: s, u_clip: clip, u_opacity: Math.max(0, Math.min(1, opacity)), u_mode: uMode })
                        : runShader(EMULATED_BLEND_SHADER, cv, { u_layer: s, u_opacity: Math.max(0, Math.min(1, opacity)), u_mode: uMode });
                } catch (err) {
                    console.warn("Inpaint Canvas: the blend shader failed, blending on the CPU:", err);
                }
            }
            if (out) {
                const img = isGLSurface(out) ? surfaceToCanvas(out) : out;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "copy";
                ctx.imageSmoothingEnabled = false;   // copy with smoothing on moves bytes (CLAUDE.md)
                ctx.drawImage(img, 0, 0);
                ctx.restore();
                return;
            }
        }
        const b = ctx.getImageData(0, 0, W, H), t = sc.getImageData(0, 0, W, H);
        let mask = null;
        if (clip) {
            const cd = clip.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
            mask = new Uint8Array(W * H);
            const ca = clip._clipAlpha ?? 255;
            if (ca === 255) for (let i = 0; i < mask.length; i++) mask[i] = cd[i * 4 + 3];
            else for (let i = 0; i < mask.length; i++) { const t = cd[i * 4 + 3] * ca + 128; mask[i] = (t + (t >> 8)) >> 8; }
        }
        if (mode === "dissolve") {
            const inv = toImage || ctx.getTransform().inverse();
            const td = t.data;
            const alpha255 = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
            const seedVal = seed !== null ? (seed >>> 0) : 0;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const idx = (y * W + x) * 4;
                    const srcA = td[idx + 3];
                    if (srcA === 0) continue;
                    const m = mask ? mask[y * W + x] : 255;
                    const c = mul255(mul255(srcA, alpha255), m);
                    const imgX = Math.floor(inv.a * (x + 0.5) + inv.c * (y + 0.5) + inv.e);
                    const imgY = Math.floor(inv.b * (x + 0.5) + inv.d * (y + 0.5) + inv.f);
                    const keep = c === 255 || ((hash32(imgX, imgY, seedVal) >>> 24) < c);
                    if (keep) {
                        td[idx + 3] = 255;
                    } else {
                        td[idx] = 0;
                        td[idx + 1] = 0;
                        td[idx + 2] = 0;
                        td[idx + 3] = 0;
                    }
                }
            }
            compositeTile(new Uint8Array(b.data.buffer, b.data.byteOffset, W * H * 4), [new Uint8Array(td.buffer, td.byteOffset, W * H * 4)], [0], [255], [null]);
            ctx.putImageData(b, 0, 0);
            return;
        }
        compositeTile(new Uint8Array(b.data.buffer, b.data.byteOffset, W * H * 4), [new Uint8Array(t.data.buffer, t.data.byteOffset, W * H * 4)], [op], [Math.round(Math.max(0, Math.min(1, opacity)) * 255)], [mask]);
        ctx.putImageData(b, 0, 0);
    }

    /**
     * Frequency separation (PLAN_0_1_31 §4 step 8): the picture of the selection's box, or of the whole picture up to
     * 16 MP, split into two layers on top, "Low frequency" (its blur of `radius` px, normal) and above it "High frequency"
     * (the detail, in linear light), which give the picture back where it is opaque: H = floor((I - L + 255) / 2) and,
     * where I - L is odd, L one level up (at 255 one down, H one up), so that L + 2H - 255 = I exactly, on every path at
     * full opacity (8-bit linear light has no neutral grey; Photoshop's recipe loses a level on half the pixels). The
     * picture is the run's (`readBoxBytes`, without helper layers). One undo step; the high layer is made active.
     */
    async frequencySeparation({ radius = null } = {}) {
        if (!this.base) { this.setStatus("Load a picture first."); return null; }
        const b = this.getBounds();
        const box = b ? [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(this.width, Math.ceil(b[2])), Math.min(this.height, Math.ceil(b[3]))] : [0, 0, this.width, this.height];
        const w = box[2] - box[0], h = box[3] - box[1];
        if (!(w > 0 && h > 0)) { this.setStatus("The selection is empty."); return null; }
        if (w * h > FREQ_MAX_PX) { this.setStatus(`Frequency separation works on up to ${Math.round(FREQ_MAX_PX / 1e6)} MP (this is ${Math.round(w * h / 1e5) / 10} MP): select the area first, a face or a patch of skin.`, "warn"); return null; }
        const r = radius > 0 ? Math.max(1, Math.min(200, Math.round(radius))) : Math.max(2, Math.round(Math.min(this.width, this.height) * 0.004));
        markStep("freqsep", "start", { w, h, radius: r });   // the K0b harness (docs/PLAN_WASM_BUILD.md §4.9): read, split (the blur in it since K27), written
        this.setStatus(`Frequency separation (${r} px) ...`);
        const src = await this.readBoxBytes(box, { forRun: true });
        const I = new Uint8ClampedArray(w * h * 4);
        I.set(src.data.subarray ? src.data.subarray(0, w * h * 4) : src.data);
        markStep("freqsep", "read");
        // the blur and the split (px/kernels.js `freqSeparate`, K26 + K27: Rust in one arena, the twins in
        // inpaint_stroke.js on the routes "js"), L and Hi copied out of wasm memory before the layers are written
        const { low: L, high: Hi } = freqSeparate(I, w, h, r);
        markStep("freqsep", "split");
        this.pushUndo({ kind: "layers", label: "Frequency separation" });
        const make = (bytes, name, blend) => {
            const px = this.pixels.Layer.empty(w, h);
            px.writeRect({ data: bytes, width: w, height: h }, 0, 0);
            const l = this.addLayer({ name, kind: "paint", px, x: box[0], y: box[1], w, h, dirty: true });
            l.blend = blend;
            this.markLayerChanged(l);
            return l;
        };
        const low = make(L, `Low frequency (${r} px)`, "normal");
        const high = make(Hi, "High frequency", "linear-light");
        markStep("freqsep", "written");
        this.activeLayerId = high.id;
        this.renderLayers();
        this.draw();
        this.setStatus(`Frequency separation: ${low.name} and ${high.name} (linear light) on top, ${w} \u00d7 ${h}. Soften colour on the low layer, retouch texture on the high one.`);
        markStep("freqsep", "done");
        return { low: low.id, high: high.id, radius: r, box };
    }

    /**
     * Image > New Dodge & Burn Layer (PLAN_0_1_31 §4 step 9): a paint layer in soft light on top, where white paint
     * lightens and black darkens. Empty unless `grey`: soft light is affine in the layer's colour on each side of 50 %
     * grey, so paint of alpha a on an empty layer gives the picture it gives on a grey one (to rounding), and an empty
     * layer holds no tiles until painted (a grey fill takes every one, about 600 MB at 15000 x 10000). `grey` fills it
     * with 128 (Photoshop's habit; 128 is neutral at any opacity, dist/map4/blend.md §4a). One undo step, made active.
     */
    dodgeBurnLayer({ grey = false } = {}) {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.pushUndo({ kind: "layers", label: "Dodge & burn layer" });
        const px = this.pixels.Layer.empty(this.width, this.height);
        if (grey) px.fill(null, "#808080");
        // the blend goes in with it: addLayer draws at once, and a grey layer drawn as normal covered the picture
        const l = this.addLayer({ name: "Dodge & burn", kind: "paint", px, x: 0, y: 0, w: this.width, h: this.height, dirty: true, blend: "soft-light" });
        this.markLayerChanged(l);
        this.renderLayers();
        this.draw();
        this.setStatus(`Dodge & burn layer (soft light${grey ? ", 50 % grey" : ""}) on top: paint white to lighten and black to darken at a low opacity${grey ? ", grey takes it back" : ", the eraser takes it back"}.`);
        return l;
    }

    /** The tone brush's stroke, fixed at the press: the options bar's mode and curve; `swap` (Alt) turns dodge into burn. */
    toneStroke(swap = false) {
        const o = this.toneOpts || {};
        let mode = o.mode || "dodge";
        if (swap) mode = { dodge: "burn", burn: "dodge", saturate: "desaturate", desaturate: "saturate" }[mode] || mode;
        const amount = Math.max(0, Math.min(100, +o.exposure || 0)) / 100;
        const label = mode[0].toUpperCase() + mode.slice(1);
        if (mode === "saturate" || mode === "desaturate") return { mode, label, sponge: true, amount, vibrance: o.vibrance !== false };
        return { mode, label, lut: toneLUT(o.range || "midtones", amount, mode === "burn"), protect: o.protect !== false };
    }

    /** The options bar's hint for the tone brush. */
    toneHint() {
        const m = this.toneOpts && this.toneOpts.mode;
        return m === "burn" ? "Paint over what should darken; Alt dodges"
            : m === "saturate" ? "Paint over what should gain colour; Alt desaturates"
            : m === "desaturate" ? "Paint over what should lose colour; Alt saturates"
            : "Paint over what should lighten; Alt burns";
    }

    /** A rectangle in a layer target's own pixels ([x0, y0, x1, y1]) in image coordinates; `target` is pixels or a canvas. */
    layerRectToImage(layer, target, rect) {
        const sx = layer.w / target.width, sy = layer.h / target.height;
        return [layer.x + rect[0] * sx, layer.y + rect[1] * sy, layer.x + rect[2] * sx, layer.y + rect[3] * sy];
    }

    /**
     * The composite changed because `layer`'s pixels changed inside `box` (image coordinates,
     * null for the whole layer). The colour-match statistics of every other layer are keyed
     * on the composite version and would be scanned for again on the next frame, which is a
     * readback that waits for the GPU (40 to 380 ms on a 15k document); those that the change
     * cannot have touched keep their statistics: a matched layer below the changed one (its
     * backdrop is untouched), and one whose sampling rectangle (its own rectangle plus the
     * statistics' padding) lies clear of the box.
     */
    bumpComposite(layer, box) {
        const v0 = this.compositeVersion;
        this.uploaded.baseHash = null;   // bumps compositeVersion
        const v1 = this.compositeVersion;
        if (v1 === v0) return;
        const i = this.layers.indexOf(layer);
        // a matched layer's own statistics move with any change of its pixels, and its match with them: its whole rectangle is the change
        const b = box && !this.matchActive(layer) ? box : [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h];
        for (let j = 0; j < this.layers.length; j++) {
            const l = this.layers[j];
            if (l === layer || !this.matchActive(l)) continue;
            let keep = j < i;   // below the change: its backdrop did not change
            if (!keep) {
                const pad = Math.max(8, Math.max(l.w, l.h) * 0.1);   // matchStats samples 8 % around the layer
                keep = b[2] <= l.x - pad || b[0] >= l.x + l.w + pad || b[3] <= l.y - pad || b[1] >= l.y + l.h + pad;
            }
            if (!keep) continue;
            for (const slot of ["_mstats", "_mstatsSample", "_mstatsSampleRun", "_mstatsStack", "_mstatsStackRun"]) if (l[slot] && l[slot].version === v0) l[slot].version = v1;
        }
    }

    /** Upload edited layers 15 s after the last change, so a crash loses at most that much. */
    scheduleAutosave() {
        clearTimeout(this._autosave);
        this._autosave = setTimeout(() => {
            if (!this.isOpen) return;
            if (this.pointer || this.pending || this.textEdit) { this.scheduleAutosave(); return; }
            this.syncLayers().catch((err) => console.warn("Inpaint Canvas: autosave failed", err));
        }, 15000);
    }

    /** The upload cache; clearing baseHash means "the composite changed" and bumps compositeVersion. */
    makeUploaded() {
        return new UploadCache(this);
    }

    // ---- filter layers ------------------------------------------------------------

    addFilterLayer(id = "grain") {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        if (!FILTERS[id]) id = "grain";
        this.filterCounter += 1;
        const params = filterDefaults(id);
        // a colour fill starts in the paint colour, a gradient from it to transparent
        const paint = /^#[0-9a-f]{6}$/i.test(this.color || "") ? this.color.toLowerCase() : null;
        if (paint && id === "fill") params.color = paint;
        if (paint && id === "gradient") { params.from = paint; params.to = paint; params.to_opacity = 0; }
        const layer = this.addLayer({
            name: `${FILTERS[id].label} ${this.filterCounter}`, kind: "filter", filter: id, params, lut: null,
            ref: null, px: this.pixels.Layer.empty(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: false,
        });
        this.setStatus(FILTERS[id].over
            ? `${layer.name} added. It covers everything below it; set the colour in the layer list, the blend mode, the opacity or a mask to let the picture through.`
            : `${layer.name} added. It filters everything below it; pick the type and drag the sliders in the layer list.`);
        if (id === "relight") {
            const relightConf = host.getRelightSettings ? host.getRelightSettings() : null;
            params.route = "app";
            if (relightConf) {
                if (relightConf.strength !== undefined) params.strength = relightConf.strength;
                if (relightConf.style !== undefined) params.style = relightConf.style;
                if (relightConf.preserve_details !== undefined) params.preserve_details = relightConf.preserve_details;
                if (relightConf.interpolate !== undefined) params.interpolate = relightConf.interpolate;
                if (relightConf.detail !== undefined) params.detail = relightConf.detail;
                if (relightConf.enable_hr_fix !== undefined) params.enable_hr_fix = relightConf.enable_hr_fix;
                if (relightConf.light_type !== undefined) params.light_type = relightConf.light_type;
                if (relightConf.lora_strength !== undefined) params.lora_strength = relightConf.lora_strength;
                if (relightConf.steps !== undefined) params.steps = relightConf.steps;
            }
            this.setTool("lights");
            const hasDepth = !!(this.maps && this.maps.depth && (this.maps.depth.data || this.maps.depth.u16));
            if (!hasDepth && this.ensureDepthMap) {
                this.ensureDepthMap().catch(() => {});
            }
        }
        return layer;
    }

    setFilterType(layer, id) {
        if (!FILTERS[id] || layer.filter === id) return;
        this.pushUndo({ kind: "filter", id: layer.id, label: "Filter type" });
        // a fill switched to a gradient keeps its colour (to transparent) and back; other types start in the paint colour
        const was = layer.filter, prev = layer.params || {};
        const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c.toLowerCase() : null);
        const seed = was === "fill" ? hex(prev.color) : was === "gradient" ? hex(prev.from) : hex(this.color);
        layer.filter = id;
        layer.params = filterDefaults(id);
        if (id === "relight") {
            const relightConf = host.getRelightSettings ? host.getRelightSettings() : null;
            layer.params.route = "app";
            if (relightConf) {
                if (relightConf.strength !== undefined) layer.params.strength = relightConf.strength;
                if (relightConf.style !== undefined) layer.params.style = relightConf.style;
                if (relightConf.preserve_details !== undefined) layer.params.preserve_details = relightConf.preserve_details;
                if (relightConf.interpolate !== undefined) layer.params.interpolate = relightConf.interpolate;
                if (relightConf.detail !== undefined) layer.params.detail = relightConf.detail;
                if (relightConf.enable_hr_fix !== undefined) layer.params.enable_hr_fix = relightConf.enable_hr_fix;
                if (relightConf.light_type !== undefined) layer.params.light_type = relightConf.light_type;
                if (relightConf.lora_strength !== undefined) layer.params.lora_strength = relightConf.lora_strength;
                if (relightConf.steps !== undefined) layer.params.steps = relightConf.steps;
            }
            this.setTool("lights");
            const hasDepth = !!(this.maps && this.maps.depth && (this.maps.depth.data || this.maps.depth.u16));
            if (!hasDepth && this.ensureDepthMap) {
                this.ensureDepthMap().catch(() => {});
            }
        }
        if (prev.limit) {
            layer.params.limit = { ...prev.limit };
            if (FILTERS[id] && FILTERS[id].over && layer.params.limit.source !== "depth") {
                delete layer.params.limit;
                this.setStatus("Fill layers take a depth limit only: non-depth limit dropped.", "warn");
            }
        }
        if (seed && id === "fill") layer.params.color = seed;
        if (seed && id === "gradient") { layer.params.from = seed; layer.params.to = seed; layer.params.to_opacity = 0; }
        // layer names are not editable: the type (or a preset, see the preset select) names the layer
        layer.name = `${FILTERS[id].label} ${this.filterCounter}`;
        if (id === "relight") {
            this.setTool("lights");
        }
        this.markFilterChanged(layer);
        this.renderLayers();
    }

    /** A fill layer (PLAN_0_1_31 §6 step 6): a filter layer whose type gives pixels of its own (`over`: a colour, a gradient). */
    isFillLayer(l) {
        return !!(l && l.kind === "filter" && FILTERS[l.filter] && FILTERS[l.filter].over);
    }

    /** A fill layer's pixels at the picture's size as a canvas (the PSD / ORA layer), with its live mask baked in when `bake`. */
    fillLayerCanvas(l, bake) {
        const W = this.width, H = this.height;
        const c = makeCanvas(W, H), ctx = c.getContext("2d");
        const rows = fillPixels(l.filter, l.params || {}, [W, H], [0, 0], W, H);
        if (l.params && l.params.limit) {
            limitAlphaRows(rows, 0, 0, W, H, l.params.limit, this.maps && this.maps.depth);
        }
        ctx.putImageData(new ImageData(rows, W, H), 0, 0);
        const m = bake ? this.liveMask(l) : null;
        if (m) { ctx.globalCompositeOperation = "destination-in"; m.drawTo(ctx, 0, 0, W, H); ctx.globalCompositeOperation = "source-over"; }
        return c;
    }

    /** `exportLayerSources`' `open` of a fill layer: its rows as `fillPixels` makes them, band by band; drawn once into a canvas when its live mask is to be baked (ORA). */
    fillLayerRows(l, bake) {
        const W = this.width, H = this.height, id = l.filter, p = JSON.parse(JSON.stringify(l.params || {}));
        if (bake && this.liveMask(l)) return () => { const c = this.fillLayerCanvas(l, true); return { source: canvasRows(c), close() { c.width = 1; c.height = 1; } }; };
        const depthMap = this.maps && this.maps.depth;
        return () => ({ source: bandRows(W, H, (y0, y1) => {
            const rows = fillPixels(id, p, [W, H], [0, y0], W, y1 - y0);
            if (p.limit) limitAlphaRows(rows, 0, y0, W, y1 - y0, p.limit, depthMap);
            return rows;
        }), close() {} });
    }

    markFilterChanged(layer, { soon = false } = {}) {
        this.sceneSig = null;
        layer._fcache = null;
        layer._fcacheView = null; layer._fcacheSample = null; layer._fxCacheSample = null;
        this.uploaded.baseHash = null;
        if (layer && layer.kind === "filter" && layer.filter === "relight") {
            this.ensureRelightMaps(layer, { quick: this.filterPreview === layer.id });
        }
        if (this.isFillLayer(layer)) this.redrawThumbsOf(layer);   // a fill layer's row shows its fill
        if (soon) { this.drawSoon(); return; }   // slider drag: one draw per frame, thumbnail and save on release
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    async loadLutFile(layer, file) {
        if (!file) return;
        try {
            this.setStatus(`Reading ${file.name} ...`);
            const lut = lutFromCube(await file.text());
            const up = await uploadCanvas(lutToCanvas(lut), `n${this.node.id}_lut`);
            this.pushUndo({ kind: "filter", id: layer.id, label: "Load LUT" });
            layer.lut = { name: file.name, size: lut.size, ref: up.ref };
            layer._lutData = lut;
            if (/^LUT/.test(layer.name || "") || !layer.name) layer.name = file.name.replace(/\.cube$/i, "");
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded (${lut.size}³ LUT).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the LUT: " + (err.message || err), failKind(err));
        }
    }

    async loadPlateFile(layer, file) {
        if (!file) return;
        try {
            this.setStatus(`Uploading ${file.name} ...`);
            const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
            const stem = (file.name || "plate").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "plate";
            const ref = await uploadBlob(file, stem + ext, { overwrite: false });
            const img = await loadImageEl(viewUrl(ref));
            const st = plateStats(img);
            this.pushUndo({ kind: "filter", id: layer.id, label: "Load grain plate" });
            layer.plate = { name: file.name, ref, w: img.naturalWidth, h: img.naturalHeight, mean: Math.round(st.mean * 10) / 10, std: Math.round(st.std * 10) / 10 };
            layer._plateImg = img;
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded as grain plate (${img.naturalWidth} × ${img.naturalHeight}, mean ${layer.plate.mean}, noise ${layer.plate.std}).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the plate: " + (err.message || err), failKind(err));
        }
    }

    removePlate(layer) {
        if (!layer.plate) return;
        this.pushUndo({ kind: "filter", id: layer.id, label: "Remove grain plate" });
        layer.plate = null;
        layer._plateImg = null;
        this.markFilterChanged(layer);
        this.renderLayers();
        this.setStatus(`${layer.name}: back to synthetic grain.`);
    }

    /**
     * Cache key for a filtered canvas pass. Centralises key generation so call sites and future
     * map dependencies stay in sync. Produces the legacy string for layers without limit or maps.
     */
    filterKey(layer, below, forRun, preview, vp = this.viewPass, plain = false) {
        const baseKey = [
            layer.filter,
            layer.params,
            layer.lut && layer.lut.ref && layer.lut.ref.filename,
            layer.plate && layer.plate.ref && layer.plate.ref.filename,
            !!forRun,
            !!preview,
            vp && vp.crop ? vp.crop.bw : below.width,
            vp && vp.crop ? vp.crop.bh : below.height,
            vp ? [vp.x, vp.y, vp.w, vp.h, vp.sx, vp.sy, !!(vp.screen || vp.display)] : 0,
        ];
        const readsMap = typeof this.mapsOf === "function" ? this.mapsOf(layer).length > 0 : (layer.params && layer.params.limit && (layer.params.limit.source === "depth" || layer.params.limit.source === "map"));
        if (readsMap) {
            baseKey.push(this.mapsVersion || 0);
        }
        const isEffectView = this.effectViewOf(layer, forRun);
        if (isEffectView) baseKey.push(true);
        if (layer.params && layer.params.limit) baseKey.push(!!plain);
        return JSON.stringify(baseKey);
    }

    /**
     * @typedef {{ scale: number, origin: number[], full: number[], forRun?: boolean, cache?: object, chain?: boolean|"bands", site?: string }} FilterPass
     *
     * Build the context object handed to `applyFilter` for both filteredCanvas and bandFilter.
     * @param {any} layer
     * @param {FilterPass} pass
     */
    filterInfo(layer, pass) {
        const def = FILTERS[layer.filter];
        const stats = def && def.wholeStats ? this.belowStats(layer, pass.forRun) : null;
        const info = {
            scale: pass.scale,
            origin: pass.origin,
            full: pass.full,
            stats,
            wholeStats: stats,
            seed: layer.id,
            lut: layer._lutData,
            plate: layer._plateImg || null,
            plateKey: layer.plate && layer.plate.ref && layer.plate.ref.filename,
            plateMean: layer.plate && layer.plate.mean,
            plateStd: layer.plate && layer.plate.std,
            cache: pass.cache,
            chain: pass.chain,
            maps: this.maps || null,
        };
        if (this.effectViewOf(layer, pass.forRun)) {
            info.limitView = true;
        }
        if (pass.site) {
            if (!this._lastFilterInfoBySite) this._lastFilterInfoBySite = {};
            this._lastFilterInfoBySite[pass.site] = info;
        }
        if (layer.filter === "relight") {
            info.layer = layer;
            info.relight = layer._relight;
            info.forRun = !!pass.forRun;   // pickVis: a run never reads the quick shadow map
            info.quick = !pass.forRun && this.filterPreview === layer.id;
            this.ensureRelightMaps(layer, { quick: info.quick });
        }
        if (this._filterInfoHook) this._filterInfoHook(info, layer, pass);
        return info;
    }

    /**
     * Crop `below` (a region-pass canvas that reaches past the document) to the document's pixel box `[bx0, by0, bw, bh]`,
     * clamping any 1-pixel fractional rim from the strictly-inside box `[ix0, iy0, iw, ih]` so a filter that samples
     * neighbours never reads the empty margin or a subpixel edge pixel.
     */
    cropFilterInput(below, { bx0, by0, bw, bh, ix0, iy0, iw, ih }) {
        const doc = makeCanvas(bw, bh);
        const dctx = doc.getContext("2d");
        dctx.imageSmoothingEnabled = false;
        if (iw > 0 && ih > 0) {
            const ox = ix0 - bx0, oy = iy0 - by0;
            dctx.drawImage(below, ix0, iy0, iw, ih, ox, oy, iw, ih);
            if (ox > 0) dctx.drawImage(doc, ox, oy, 1, ih, 0, oy, ox, ih);
            if (bw > ox + iw) dctx.drawImage(doc, ox + iw - 1, oy, 1, ih, ox + iw, oy, bw - ox - iw, ih);
            if (oy > 0) dctx.drawImage(doc, 0, oy, bw, 1, 0, 0, bw, oy);
            if (bh > oy + ih) dctx.drawImage(doc, 0, oy + ih - 1, bw, 1, 0, oy + ih, bw, bh - oy - ih);
        } else {
            dctx.drawImage(below, bx0, by0, bw, bh, 0, 0, bw, bh);
        }
        return doc;
    }

    /**
     * Filtered copy of `below` for a filter layer, cached until the composite or the parameters
     * change. `below` is the composite so far: a canvas, or the GPU surface the filter layer
     * before this one left behind. With `keepSurface` the result stays a surface for the next
     * filter layer and is not cached; without it the surface is read back into a canvas. The
     * stages inside one filter (the film look is colour, halation and grain) always chain on
     * the GPU, which is where most of the canvas round trips were.
     */
    filteredCanvas(layer, below, forRun, preview, keepSurface = false, plain = keepSurface) {
        const vp = this.viewPass;
        const key = this.filterKey(layer, below, forRun, preview, vp, plain);
        const slot = vp ? (vp.sample ? "_fcacheSample" : "_fcacheView") : "_fcache";
        const c = layer[slot];
        if (!keepSurface && c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        let input = below, scale = vp ? vp.sx : 1;
        if (vp && vp.crop && !isGLSurface(below)) {
            input = this.cropFilterInput(below, vp.crop);
        } else if (preview) {
            const s = Math.min(1, 1024 / Math.max(below.width, below.height));
            if (s < 1) {
                input = makeCanvas(Math.round(below.width * s), Math.round(below.height * s));
                const ictx = input.getContext("2d");
                ictx.imageSmoothingEnabled = true;
                ictx.drawImage(below, 0, 0, input.width, input.height);
                scale = s;
            }
        }
        let canvas = null;
        const fxSlot = vp ? (vp.sample ? "_fxCacheSample" : "_fxCacheView") : "_fxCache";
        if (!layer[fxSlot]) layer[fxSlot] = {};
        // where the input sits in the image, in its own pixels: filters with a field of
        // their own (grain) anchor it there instead of at the corner of the preview
        const origin = vp ? [vp.x * vp.sx, vp.y * vp.sy] : [0, 0];
        // E3: the whole picture in the input's pixels, for a filter whose geometry belongs to the picture (a vignette, a
        // frame), and the whole picture's statistics for one that reads them (normalise): a pass composites a part
        const full = vp ? [this.width * vp.sx, this.height * vp.sy] : [input.width, input.height];
        const chain = !this.filterChainOff && glChainUsable(input.width, input.height);   // filterChainOff: the Canvas 2D path, for composite_test
        const info = this.filterInfo(layer, {
            scale,
            origin,
            full,
            forRun: !!forRun,
            cache: layer[fxSlot],
            chain,
            site: "filteredCanvas",
        });
        // A limit's weight goes into the result's alpha whenever the result is drawn over the picture (a
        // blend mode, an opacity, a mask, or a clip): where the limit is 0 the layer then shows nothing,
        // like its painted mask. A plain filter layer stands for the picture (whether it stays a surface
        // for the next filter layer or replaces the canvas below it) and mixes the input back in instead.
        info.limitOver = !plain;
        beginScope();
        try { canvas = applyFilter(layer.filter, input, layer.params, info); }
        catch (err) { console.error(err); }
        canvas = endScope(canvas);
        // A depth limit without a map: the layer shows nothing (the limit stage hands the input back and
        // says so; the Limit row reads the flag). Drawn over the picture that is nothing; only as the
        // chain's surface it is the picture.
        layer.limitMissing = !!info.limitMissing;
        if (info.limitMissing && canvas === input && !(keepSurface && isGLSurface(canvas))) canvas = null;
        if (isGLSurface(canvas)) {
            if (keepSurface) return canvas;                    // the next filter layer reads the texture
            const flat = surfaceToCanvas(canvas);
            if (canvas !== input) releaseSurface(canvas);      // a filter that did nothing hands its input back
            canvas = flat;
        }
        layer[slot] = { version: this.compositeVersion, key, canvas };
        return canvas;
    }

    /**
     * `colourStats` or custom `wholeStats` of the whole picture below a filter layer (E3, F10):
     * from a sampled pass of the layers below it (size chosen by def.wholeStatsSize, 64..1024, default 256),
     * kept while the picture below (`belowSignature`) and the parameters the statistics read stay the same: a custom
     * `wholeStats` reads the ones `wholeStatsParams` names (relight's fit: depth_scale and sigma), or all of them.
     * Keyed on `compositeVersion` before (F2.6), which every slider and light drag of the layer itself bumps: a drag of
     * ten moves read the picture below back 22 times.
     */
    belowStats(layer, forRun) {
        if (!layer || !this.layers || !this.width || !this.height) return null;
        const def = FILTERS[layer.filter];
        const n = Math.max(64, Math.min(1024, (def && def.wholeStatsSize) || 256));
        const params = layer.params || {};
        const reads = !def || typeof def.wholeStats !== "function" ? ""
            : Array.isArray(def.wholeStatsParams) ? JSON.stringify(def.wholeStatsParams.map((k) => params[k] ?? null)) : JSON.stringify(params);
        const vKey = `${this.belowSignature(layer)}#${reads}#${n}#${this.mapsOf(layer).length ? this.mapsVersion || 0 : 0}`;
        const slot = forRun ? "_bstatsRun" : "_bstats";
        const c = layer[slot];
        if (c && c.version === vKey) return c.stats;
        const index = this.layers.indexOf(layer);
        const s = Math.min(1, n / Math.max(this.width, this.height));
        const entry = { version: vKey, stats: null };
        layer[slot] = entry;
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo: Math.max(0, index) });
        if (def && typeof def.wholeStats === "function") {
            try {
                entry.stats = def.wholeStats(small, { width: this.width, height: this.height }, { maps: this.maps || {}, sampleMap, layer, params: layer?.params });
            } catch (err) {
                console.warn(`filter ${def.label || layer.filter} wholeStats failed:`, err);
                if (host.pluginReport && def.plugin) host.pluginReport(def.plugin, `filter ${layer.filter} wholeStats`, err);
                entry.stats = null;
            }
        } else {
            entry.stats = colourStats(small);
        }
        return entry.stats;
    }

    /**
     * What the picture below `layer` is made of, as a string (F2.6): the base and every layer below it as the composite
     * reads them - each pixel source by identity and version (every write reaches the display through `touchSource` /
     * `touchSourceRect`, whose `touch()` moves the source's version on both backends), place, size, visibility (groups
     * included), opacity, blend, clip, mask, colour match, role, a filter's parameters, LUT and plate, and a relight
     * layer's shadow and normal maps (they land after its parameters change), the maps for a layer below that reads
     * them - and the compare side shown and a filter preview of another layer. A change of the layer's own parameters or
     * of a layer above it leaves it as it is, and so does a brush dab anywhere above (the document-wide `pixelVersion`
     * is not in it: it moves with every dab). `belowStats` adds the maps when the layer itself reads them.
     * @param {any} layer
     */
    belowSignature(layer) {
        const index = this.layers.indexOf(layer);
        const parts = [this.width, this.height, sourceTag(this.basePx),
            this.compareShow || "", this.filterPreview && this.filterPreview !== layer.id ? this.filterPreview : ""];
        for (const g of this.groups || []) parts.push(g.id, g.parent || "", g.visible === false ? 0 : 1);
        for (let i = 0; i < index; i++) {
            const l = this.layers[i];
            let filter = "";
            if (l.kind === "filter") {
                filter = `${l.filter}${JSON.stringify(l.params || {})}${sourceTag(l._lutData)}${sourceTag(l._plateImg)}`;
                const r = l.filter === "relight" ? l._relight : null;
                if (r) filter += `:${r.seq || 0}:${r.visQuick ? r.visQuick.seq || 0 : "-"}:${(r.normals && r.normals.key) || ""}`;
                if (this.mapsOf(l).length) filter += `@${this.mapsVersion || 0}`;
            }
            parts.push(l.id, l.kind, l.role || "", this.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "",
                l.x, l.y, l.w, l.h, sourceTag(l.px), sourceTag(l.maskPx), l.maskOff ? 1 : 0,
                l.match ? `${l.match.strength}:${l.match.source}` : "", filter);
        }
        return parts.join("|");
    }

    /**
     * `colourStats` below a filter layer, used as fallback for histogram / color sample when a filter defines custom `wholeStats`.
     */
    belowColourStats(layer, forRun = false) {
        if (!layer || !this.layers || !this.width || !this.height) return null;
        const slot = forRun ? "_bcstatsRun" : "_bcstats";
        const c = layer[slot];
        if (c && c.version === this.compositeVersion) return c.stats;
        const index = this.layers.indexOf(layer);
        const s = Math.min(1, 256 / Math.max(this.width, this.height));
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo: Math.max(0, index) });
        const entry = { version: this.compositeVersion, stats: colourStats(small) };
        layer[slot] = entry;
        return entry.stats;
    }

    /**
     * The histogram `{ r, g, b, luma }` of the composite below a filter layer (R1-S4).
     */
    belowHistogram(layer, forRun = false) {
        const st = this.belowStats(layer, forRun);
        if (st && st.hist) return st.hist;
        const cs = this.belowColourStats(layer, forRun);
        return (cs && cs.hist) || null;
    }

    /**
     * The 256 px RGBA sample `{ bytes, w, h }` below a filter layer (R1-S4).
     */
    belowSample(layer, forRun = false) {
        const st = this.belowStats(layer, forRun);
        if (st && st.bytes) return { bytes: st.bytes, w: st.w, h: st.h };
        const cs = this.belowColourStats(layer, forRun);
        return (cs && cs.bytes) ? { bytes: cs.bytes, w: cs.w, h: cs.h } : null;
    }

    /**
     * `colourStats` of the whole picture, sampled at up to 256 px on the long side (R1-S4).
     * Cached per `compositeVersion` in `_picStats` or `_picStatsRun`.
     */
    pictureStats(forRun = true) {
        if (!this.width || !this.height) return null;
        const slot = forRun ? "_picStatsRun" : "_picStats";
        const c = this[slot];
        if (c && c.version === this.compositeVersion) return c.stats;
        const s = Math.min(1, 256 / Math.max(this.width, this.height));
        const entry = { version: this.compositeVersion, stats: null };
        this[slot] = entry;
        const upTo = this.layers ? this.layers.length : 0;
        const small = this.sampleRegion("image", [0, 0, this.width, this.height], s, { forRun: !!forRun, upTo });
        entry.stats = colourStats(small);
        return entry.stats;
    }

    /**
     * The whole picture's histogram `{ r, g, b, luma }` from a 256 px sample (R1-S4).
     */
    pictureHistogram(forRun = true) {
        const st = this.pictureStats(forRun);
        return (st && st.hist) || null;
    }

    /**
     * The whole picture's 256 px RGBA sample `{ bytes, w, h }` (R1-S4).
     */
    pictureSample(forRun = true) {
        const st = this.pictureStats(forRun);
        return (st && st.bytes) ? { bytes: st.bytes, w: st.w, h: st.h } : null;
    }

    /**
     * 256-bin histogram of a feature map (depth `u16 >> 8`, etc.), cached by hash / dataVersion (R1-S4).
     */
    mapHistogram(kind) {
        if (kind === "depth") {
            // The map store's entry keeps its bytes in `data`; the `depth` getter presents them as `u16`.
            const depth = this.depth;
            if (!depth || !depth.u16) return null;
            if (!this._mapHistCache) this._mapHistCache = new Map();
            const key = `depth:${depth.hash ?? depth.dataVersion ?? depth.version ?? "default"}`;
            if (this._mapHistCache.has(key)) return this._mapHistCache.get(key);
            if (this._mapHistCache.size >= 8) this._mapHistCache.clear();   // a few versions, not every recompute
            const u16 = depth.u16;
            const hist = new Float64Array(256);
            for (let i = 0; i < u16.length; i++) hist[u16[i] >> 8]++;
            this._mapHistCache.set(key, hist);
            return hist;
        }
        if (this.maps && this.maps[kind]) {
            const map = this.maps[kind];
            if (!this._mapHistCache) this._mapHistCache = new Map();
            const key = `${kind}:${map.hash ?? map.dataVersion ?? map.version ?? "default"}`;
            if (this._mapHistCache.has(key)) return this._mapHistCache.get(key);
            if (map.u16) {
                const hist = new Float64Array(256);
                for (let i = 0; i < map.u16.length; i++) hist[map.u16[i] >> 8]++;
                this._mapHistCache.set(key, hist);
                return hist;
            }
            if (map.u8) {
                const hist = new Float64Array(256);
                for (let i = 0; i < map.u8.length; i++) hist[map.u8[i]]++;
                this._mapHistCache.set(key, hist);
                return hist;
            }
        }
        return null;
    }

    /**
     * 256-bin histogram of colour similarity over a 256 px sample (R1-S6 / R1-S8).
     * Cached per (compositeVersion, color, tol).
     * @param {Object} limit - Range limit containing { color, tol }
     * @param {Object} [sample] - Optional custom sample { bytes, w, h }
     * @returns {Float64Array | null}
     */
    similarityHistogram(limit, sample = null) {
        if (!limit) return null;
        const color = limit.color || "#ffffff";
        const tol = limit.tol ?? 30;
        const samp = sample || this.pictureSample();
        if (!samp || !samp.bytes) return null;
        let key = null;
        if (!sample) {
            if (!this._simHistCache) this._simHistCache = new Map();
            key = `${this.compositeVersion}:${color}:${tol}`;
            if (this._simHistCache.has(key)) return this._simHistCache.get(key);
        }
        const rgbRef = hexToRgb01(color);
        const colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
        const px = samp.bytes;
        const hist = new Float64Array(256);
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3] / 255;
            if (!a) continue;
            const sim = colourSimilarity(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, colorRef, tol);
            const bin = Math.min(255, Math.max(0, Math.floor(sim * 256)));
            hist[bin] += a;
        }
        if (!sample && key) {
            this._simHistCache.set(key, hist);
        }
        return hist;
    }

    /**
     * Samples the depth map at image coordinates (ix, iy), returning a value in 0..1 (R1-S6).
     * @param {number} ix
     * @param {number} iy
     * @returns {number}
     */
    depthAt(ix, iy) {
        const map = (this.maps && this.maps.depth) || this.depth;
        if (!map) return 0;
        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return 0;
        if (map.xf) {
            const m = passToMap(map, 1);
            const pxCentre = ix + 0.5;
            const pyCentre = iy + 0.5;
            const mx = m[0] * pxCentre + m[2] * pyCentre + m[4];
            const my = m[1] * pxCentre + m[3] * pyCentre + m[5];
            return u16Bilinear(data, map.w, map.h, mx, my);
        }
        const mx = (ix / (this.width || 1)) * map.w;
        const my = (iy / (this.height || 1)) * map.h;
        return u16Bilinear(data, map.w, map.h, mx, my);
    }

    /**
     * Greyscale canvas proxy of a feature map downsampled to <= maxSize on long side (R1-S6).
     * Cached per dataVersion.
     */
    depthProxy(map, maxSize = 2048) {
        if (!map) return null;
        const key = `${maxSize}:${map.dataVersion ?? map.version ?? 1}`;
        if (!this._depthProxies) this._depthProxies = new Map();
        if (this._depthProxies.has(key)) return this._depthProxies.get(key);

        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return null;
        const dw = map.w, dh = map.h;
        const maxSide = Math.max(dw, dh);
        const scale = maxSide > maxSize ? maxSize / maxSide : 1;
        const pw = Math.max(1, Math.round(dw * scale));
        const ph = Math.max(1, Math.round(dh * scale));

        const c = document.createElement("canvas");
        c.width = pw; c.height = ph;
        const ctx = c.getContext("2d");
        const idata = ctx.createImageData(pw, ph);
        const d32 = idata.data;

        for (let y = 0; y < ph; y++) {
            const sy = Math.min(dh - 1, Math.floor(y / scale));
            const yOffset = sy * dw;
            const rowOffset = y * pw * 4;
            for (let x = 0; x < pw; x++) {
                const sx = Math.min(dw - 1, Math.floor(x / scale));
                const v = (data[yOffset + sx] >> 8) & 0xff;
                const idx = rowOffset + x * 4;
                d32[idx] = v;
                d32[idx + 1] = v;
                d32[idx + 2] = v;
                d32[idx + 3] = 255;
            }
        }
        ctx.putImageData(idata, 0, 0);
        this._depthProxies.set(key, c);
        return c;
    }

    depthProxy2048(map) {
        return this.depthProxy(map, 2048);
    }

    depthProxy1024(map) {
        return this.depthProxy(map, 1024);
    }

    depthProxy1024Data(map) {
        if (!map) return null;
        const key = `data1024:${map.dataVersion ?? map.version ?? 1}`;
        if (!this._depthProxies) this._depthProxies = new Map();
        if (this._depthProxies.has(key)) return this._depthProxies.get(key);

        const data = map.u16 || map.data;
        if (!data || !map.w || !map.h) return null;
        const dw = map.w, dh = map.h;
        const maxSide = Math.max(dw, dh);
        const scale = maxSide > 1024 ? 1024 / maxSide : 1;
        const pw = Math.max(1, Math.round(dw * scale));
        const ph = Math.max(1, Math.round(dh * scale));
        const vals = new Float32Array(pw * ph);

        for (let y = 0; y < ph; y++) {
            const sy = Math.min(dh - 1, Math.floor(y / scale));
            const yOffset = sy * dw;
            const rowOffset = y * pw;
            for (let x = 0; x < pw; x++) {
                const sx = Math.min(dw - 1, Math.floor(x / scale));
                vals[rowOffset + x] = data[yOffset + sx] / 65535;
            }
        }
        const res = { vals, w: pw, h: ph };
        this._depthProxies.set(key, res);
        return res;
    }

    /**
     * Sets or clears live red preview tint for range selection (R1-S6).
     * Builds this._rangeTint and calls drawSoon().
     * @param {Object | null} limit
     */
    setRangePreview(limit) {
        if (!limit) {
            this._rangeTint = null;
            this.drawSoon();
            return;
        }

        if (limit.source === "depth") {
            const map = (this.maps && this.maps.depth) || this.depth;
            if (!map) {
                this._rangeTint = null;
                this.drawSoon();
                return;
            }
            const pdata = this.depthProxy1024Data(map);
            if (!pdata) {
                this._rangeTint = null;
                this.drawSoon();
                return;
            }
            const { vals, w, h } = pdata;

            if (!this._depthTintCanvas || this._depthTintCanvas.width !== w || this._depthTintCanvas.height !== h) {
                this._depthTintCanvas = document.createElement("canvas");
                this._depthTintCanvas.width = w;
                this._depthTintCanvas.height = h;
                this._depthTintCtx = this._depthTintCanvas.getContext("2d");
                this._depthTintImg = this._depthTintCtx.createImageData(w, h);
            }
            const imgData = this._depthTintImg;
            const d32 = imgData.data;
            const n = w * h;
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                const wt = rangeWeight(vals[i], limit);
                d32[j] = 255;
                d32[j + 1] = 0;
                d32[j + 2] = 0;
                d32[j + 3] = Math.round(wt * 255);
            }
            this._depthTintCtx.putImageData(imgData, 0, 0);
            this._rangeTint = {
                canvas: this._depthTintCanvas,
                xf: map.xf || [this.width, 0, 0, this.height, 0, 0],
            };
            this.drawSoon();
            return;
        }

        // luma or color
        const vr = this.viewportRegion();
        const box = vr ? [Math.max(0, vr.x), Math.max(0, vr.y), Math.min(this.width, vr.x + vr.w), Math.min(this.height, vr.y + vr.h)] : [0, 0, this.width, this.height];
        const bw = box[2] - box[0], bh = box[3] - box[1];
        if (bw <= 0 || bh <= 0) {
            this._rangeTint = null;
            this.drawSoon();
            return;
        }
        const scale = vr ? vr.scale : Math.min(1, 1024 / Math.max(this.width, this.height));
        const boxKey = `${box[0]},${box[1]},${box[2]},${box[3]}`;
        const cacheKey = `${this.compositeVersion}:${boxKey}:${scale}`;

        if (!this._rangeSampleCache || this._rangeSampleCache.key !== cacheKey) {
            const sampleCanvas = this.sampleRegion("image", box, scale, { forRun: true });
            const sctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
            const imgData = sctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
            this._rangeSampleCache = {
                key: cacheKey,
                version: this.compositeVersion,
                canvas: sampleCanvas,
                imgData,
                box,
                scale,
                w: sampleCanvas.width,
                h: sampleCanvas.height,
            };
        }

        const cached = this._rangeSampleCache;
        const cw = cached.w, ch = cached.h;

        let tintOut = null;
        let colorRef = [0, 0, 0], colorTol = limit.tol ?? 30;
        if (limit.source === "color") {
            const rgbRef = hexToRgb01(limit.color || "#ffffff");
            colorRef = opp(rgbRef[0], rgbRef[1], rgbRef[2]);
        }
        const rVec = [limit.lo ?? 0, limit.hi ?? 1, limit.fLo ?? 0, limit.fHi ?? 0];
        try {
            const uniforms = {
                u_source: limit.source === "color" ? 2 : 1,
                u_range: rVec,
                u_invert: limit.invert ? 1 : 0,
                u_ref: colorRef,
                u_tol: colorTol,
            };
            const shRes = runShader(RANGE_PREVIEW_SHADER, cached.canvas, uniforms);
            if (shRes) {
                tintOut = glToCanvas(shRes);
            }
        } catch (_) {
            tintOut = null;
        }

        if (!tintOut) {
            if (!this._tintCpuCanvas || this._tintCpuCanvas.width !== cw || this._tintCpuCanvas.height !== ch) {
                this._tintCpuCanvas = document.createElement("canvas");
                this._tintCpuCanvas.width = cw;
                this._tintCpuCanvas.height = ch;
                this._tintCpuCtx = this._tintCpuCanvas.getContext("2d");
                this._tintCpuImg = this._tintCpuCtx.createImageData(cw, ch);
            }
            const srcData = cached.imgData.data;
            const outImg = this._tintCpuImg;
            const outData = outImg.data;
            const isLuma = limit.source === "luma";
            for (let i = 0; i < srcData.length; i += 4) {
                const a = srcData[i + 3] / 255;
                if (!a) {
                    outData[i] = 255;
                    outData[i + 1] = 0;
                    outData[i + 2] = 0;
                    outData[i + 3] = 0;
                    continue;
                }
                const r = srcData[i] / 255, g = srcData[i + 1] / 255, b = srcData[i + 2] / 255;
                const v = isLuma ? (0.299 * r + 0.587 * g + 0.114 * b) : colourSimilarity(r, g, b, colorRef, colorTol);
                const wt = rangeWeight(v, limit);
                outData[i] = 255;
                outData[i + 1] = 0;
                outData[i + 2] = 0;
                outData[i + 3] = Math.round(wt * 255 * a);
            }
            this._tintCpuCtx.putImageData(outImg, 0, 0);
            tintOut = this._tintCpuCanvas;
        }

        this._rangeTint = {
            canvas: tintOut,
            box: [box[0], box[1], bw, bh],
        };
        this.drawSoon();
    }

    /**
     * Arms a one-shot click to pick range value from the picture (R1-S6).
     * @param {"depth" | "luma" | "color"} source
     * @param {(val: number | string | null, meta?: any) => void} [onPick] - Optional target callback (R1-S8)
     * @returns {Promise<number | string | null>}
     */
    pickOnce(source = "depth", onPick = null) {
        this._pendingPick = source;
        this._pendingPickTarget = typeof onPick === "function" ? onPick : null;
        const name = source === "depth" ? "depth" : source === "luma" ? "luminosity" : "colour";
        this.setStatus(`Click the picture to pick ${name} … (Esc cancels)`);
        this.draw();
        return new Promise((resolve) => {
            this._pickResolve = resolve;
        });
    }

    async handlePickOnce(source, ix, iy) {
        const targetCb = this._pendingPickTarget;
        this._pendingPick = null;
        this._pendingPickTarget = null;
        this.setStatus("");
        const px = Math.max(0, Math.min(this.width - 1, Math.floor(ix)));
        const py = Math.max(0, Math.min(this.height - 1, Math.floor(iy)));
        let pickedVal = null;

        if (source === "depth") {
            const v = this.depthAt(ix, iy);
            pickedVal = v;
            if (!targetCb) {
                const w = (this.rangeLimit.hi ?? 0.3) - (this.rangeLimit.lo ?? 0);
                const half = w / 2;
                let lo = Math.max(0, v - half);
                let hi = Math.min(1, v + half);
                if (lo === 0) hi = Math.min(1, w);
                if (hi === 1) lo = Math.max(0, 1 - w);
                this.rangeLimit.lo = lo;
                this.rangeLimit.hi = hi;
                if (this.rangeBar) this.rangeBar.set(this.rangeLimit);
            }
        } else if (source === "luma") {
            const res = await this.readBoxBytes([px, py, px + 1, py + 1], { forRun: true });
            const d = res ? res.data : null;
            if (d && d.length >= 3) {
                const v = (0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]) / 255;
                pickedVal = v;
                if (!targetCb) {
                    const w = (this.rangeLimit.hi ?? 0.3) - (this.rangeLimit.lo ?? 0);
                    const half = w / 2;
                    let lo = Math.max(0, v - half);
                    let hi = Math.min(1, v + half);
                    if (lo === 0) hi = Math.min(1, w);
                    if (hi === 1) lo = Math.max(0, 1 - w);
                    this.rangeLimit.lo = lo;
                    this.rangeLimit.hi = hi;
                    if (this.rangeBar) this.rangeBar.set(this.rangeLimit);
                }
            }
        } else if (source === "color") {
            const res = await this.readBoxBytes([px, py, px + 1, py + 1], { forRun: true });
            const d = res ? res.data : null;
            if (d && d.length >= 3) {
                const toHex = (n) => n.toString(16).padStart(2, "0");
                const hex = `#${toHex(d[0])}${toHex(d[1])}${toHex(d[2])}`;
                pickedVal = hex;
                if (!targetCb) {
                    this.rangeLimit.color = hex;
                    if (this.rangeColorInput) this.rangeColorInput.value = hex;
                    if (this.rangeBar) this.rangeBar.refresh();
                }
            }
        }
        if (targetCb) {
            try {
                targetCb(pickedVal, { ix, iy, source });
            } catch (err) {
                console.error("pickOnce target callback failed:", err);
            }
        }
        if (this._pickResolve) {
            const r = this._pickResolve;
            this._pickResolve = null;
            r(pickedVal);
        }
        this.draw();
    }

    /**
     * Draw a filter layer onto `ctx` (a canvas holding everything below it), or hand its result
     * on to the next filter layer as a GPU surface. `chain` is what the filter layer before it
     * left there, `more` says another filter layer follows; the return value is the new chain,
     * null once everything has been drawn. The pixels are the same either way: a result that
     * goes onto the canvas is drawn over the composite exactly as before, and the held chain is
     * flushed first (flushFilterChain), so only the upload of the next filter's input is saved.
     */
    // `clip`: the filter layer is clipped to the layer below (PLAN_0_1_31 §6 step 3), `() => coverage` (`clipCoverage`, asked for
    // once the filter has run: its input's statistics may walk the stack again): the result goes over the picture where the
    // base is, `mix(in, filtered, baseAlpha)`
    applyFilterLayer(ctx, layer, index, forRun, chain = null, more = false, clip = null) {
        if (!forRun) {
            // While something below the filter is being painted or moved, the cached
            // result would hide the live change: show the layers unfiltered instead.
            const p = this.pointer;
            const gestureLayer = (p && p.layer) || (this.pending && this.pending.layer) || null;
            if (gestureLayer && gestureLayer !== layer) {
                const gi = this.layers.indexOf(gestureLayer);
                if (gi >= 0 && gi < index) return chain;
            }
        }
        const vp = this.viewPass;
        // the region pass already works at screen resolution; the 1024 px preview is for the full-size path
        const preview = !forRun && !vp && (this.filterPreview === layer.id || this.filterPreview === "*");
        if (chain && preview) chain = this.flushFilterChain(ctx, chain);   // the preview downscales on a canvas
        // A filter layer that covers its input one to one can leave its result on the GPU; a
        // mask, an opacity or a blend mode has to composite it onto the canvas.
        // a fill layer (`over`) goes over the picture as a layer does: its result never stands for the picture
        const limitView = this.effectViewOf(layer, forRun);
        const plain = !limitView && !this.liveMask(layer) && Math.round(layer.opacity * 255) === 255 && (!layer.blend || layer.blend === "normal") && !preview && !clip && !this.isFillLayer(layer);
        let rx = vp ? vp.x : 0, ry = vp ? vp.y : 0;
        let rw = vp ? vp.w : this.width, rh = vp ? vp.h : this.height;
        const margin = !!(vp && (rx < 0 || ry < 0 || rx + rw > this.width || ry + rh > this.height));
        let fvp = vp;
        if (margin && !this.isFillLayer(layer)) {
            const W = ctx.canvas.width, H = ctx.canvas.height;
            const sx = W / rw, sy = H / rh;
            const dl = -rx * sx, dt = -ry * sy, dr = (this.width - rx) * sx, db = (this.height - ry) * sy;
            const bx0 = Math.max(0, Math.floor(dl)), by0 = Math.max(0, Math.floor(dt));
            const bx1 = Math.min(W, Math.ceil(dr)), by1 = Math.min(H, Math.ceil(db));
            const bw = bx1 - bx0, bh = by1 - by0;
            if (bw <= 0 || bh <= 0) return chain;
            const ix0 = Math.max(bx0, Math.min(bx1, Math.ceil(dl))), iy0 = Math.max(by0, Math.min(by1, Math.ceil(dt)));
            const ix1 = Math.min(bx1, Math.max(ix0, Math.floor(dr))), iy1 = Math.min(by1, Math.max(iy0, Math.floor(db)));
            rx += bx0 / sx; ry += by0 / sy;
            rw = bw / sx; rh = bh / sy;
            fvp = { ...vp, x: rx, y: ry, w: rw, h: rh, crop: { bx0, by0, bw, bh, ix0, iy0, iw: ix1 - ix0, ih: iy1 - iy0 } };
        }
        if (chain && margin && this.isFillLayer(layer)) chain = this.flushFilterChain(ctx, chain);
        const keepSurface = plain && more && !this.filterChainOff && glChainUsable(fvp && fvp.crop ? fvp.crop.bw : ctx.canvas.width, fvp && fvp.crop ? fvp.crop.bh : ctx.canvas.height);
        let out;
        this.viewPass = fvp;
        try {
            out = this.filteredCanvas(layer, chain ? chain.surface : ctx.canvas, forRun, preview, keepSurface, plain);
        } finally {
            this.viewPass = vp;
        }
        if (isGLSurface(out)) {
            if (chain && out !== chain.surface) releaseSurface(chain.surface);
            return { surface: out, x: rx, y: ry, w: rw, h: rh };
        }
        chain = this.flushFilterChain(ctx, chain);   // the result goes onto the canvas, so the composite has to be there
        if (!out || (plain && out === ctx.canvas)) return null;
        let src = out;
        if (this.liveMask(layer)) {
            if (!this.filterMaskCanvas || this.filterMaskCanvas.width !== out.width || this.filterMaskCanvas.height !== out.height) this.filterMaskCanvas = makeCanvas(out.width, out.height);
            const m = this.filterMaskCanvas;
            const mctx = m.getContext("2d");
            mctx.globalCompositeOperation = "source-over";
            mctx.globalAlpha = 1;
            mctx.clearRect(0, 0, m.width, m.height);
            mctx.drawImage(out, 0, 0);
            mctx.globalCompositeOperation = "destination-in";
            const ms = layer.maskPx.width / this.width;   // a filter layer's mask covers the whole image
            const g = this.pointer;
            const stroke = !!(g && g.kind === "maskpaint" && g.layer === layer);
            if (vp && isTilePixels(layer.maskPx)) {
                // C6 (c2): in a region pass the part of the mask the pass shows, from the mask's tiles at the pass's level,
                // and during a mask stroke on this layer the stroke over it in a scratch of the pass's size. drawTo gave
                // the mask's display mirror (572 MB at 15000 x 10000, synced per written tile) and a sub-rectangle draw of
                // it per pass; the stroke a full-size live preview filled from that mirror.
                const sx = m.width / rw, sy = m.height / rh;
                const mvp = { ...(fvp || vp), sx, sy };
                const whole = { x: 0, y: 0, w: this.width, h: this.height };
                mctx.save();
                try {
                    if (stroke) {
                        const sc = this.passScratch("_filterMaskView", m.width, m.height), sctx = sc.getContext("2d");
                        sctx.save();
                        try {
                            sctx.setTransform(1, 0, 0, 1, 0, 0);
                            sctx.globalAlpha = 1;
                            sctx.globalCompositeOperation = "source-over";
                            sctx.clearRect(0, 0, m.width, m.height);
                            sctx.setTransform(sx, 0, 0, sy, -rx * sx, -ry * sy);
                            this.drawTilesInto(sctx, layer.maskPx, 0, 0, this.width, this.height, mvp);
                            this.drawStrokeInto(sctx, whole, layer.maskPx, g.erase ? "destination-out" : "source-over", mvp, [0, 0, m.width, m.height]);
                        } finally {
                            sctx.restore();
                        }
                        mctx.setTransform(1, 0, 0, 1, 0, 0);
                        mctx.drawImage(sc, 0, 0);
                    } else {
                        mctx.setTransform(sx, 0, 0, sy, -rx * sx, -ry * sy);
                        this.drawTilesInto(mctx, layer.maskPx, 0, 0, this.width, this.height, mvp);
                    }
                } finally {
                    mctx.restore();
                }
            }
            // during a mask stroke on this layer its live preview (the mask's size), otherwise the mask's own pixels
            else if (stroke) mctx.drawImage(this.maskWithStroke(layer), rx * ms, ry * ms, rw * ms, rh * ms, 0, 0, m.width, m.height);
            else layer.maskPx.drawTo(mctx, rx * ms, ry * ms, rw * ms, rh * ms, 0, 0, m.width, m.height);
            mctx.globalCompositeOperation = "source-over";
            src = m;
        }
        if (limitView) {
            ctx.save();
            ctx.fillStyle = "#000000";
            ctx.fillRect(rx, ry, rw, rh);
            ctx.restore();
        }
        // A fill layer covers the picture, not the view: the screen's region pass reaches past the document when the
        // view is zoomed out (viewportRegion pads the visible area and clamps nothing), and the fill's bytes there are
        // its clamped ends, so a gradient painted the whole viewport (the user's screenshot, 2026-10-10). The draw is
        // clipped to the document; a filter leaves the transparent outside transparent by itself.
        const clipDoc = margin && this.isFillLayer(layer);
        if (clipDoc) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.width, this.height); ctx.clip(); }
        try {
            if (!limitView && (clip || EMULATED_BLENDS.has(layer.blend))) {
                this.blendEmulated(ctx, layer.blend, (c) => { c.drawImage(src, rx, ry, rw, rh); }, layer.opacity, clip ? clip() : null, seedOfLayer(layer.id));
                return null;
            }
            ctx.globalAlpha = limitView ? 1 : layer.opacity;
            ctx.globalCompositeOperation = limitView ? "source-over" : canvasOp(layer.blend);
            if (plain) ctx.clearRect(rx, ry, rw, rh);
            ctx.drawImage(src, rx, ry, rw, rh);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            return null;
        } finally {
            if (clipDoc) ctx.restore();
        }
    }

    /** Draw what the filter chain left on the GPU onto `ctx` and give the surface back. */
    flushFilterChain(ctx, chain) {
        if (!chain) return null;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        if (!drawSurfaceTo(ctx, chain.surface, chain.x, chain.y, chain.w, chain.h, true)) {
            const flat = surfaceToCanvas(chain.surface);
            if (flat) {
                ctx.clearRect(chain.x, chain.y, chain.w, chain.h);
                ctx.drawImage(flat, chain.x, chain.y, chain.w, chain.h);
            }
        }
        releaseSurface(chain.surface);
        return null;
    }

    /** Is the next layer that gets drawn after `i` a filter layer? (may the chain go on?) */
    nextIsFilterLayer(i, forRun, end = this.layers.length) {
        for (let j = i + 1; j < end; j++) {
            const l = this.layers[j];
            if (this.compareShow && l.kind === "result" && l.id !== this.compareShow) continue;
            if ((!this.shown(l) && !(this.compareShow && l.id === this.compareShow)) || !l.px) continue;
            if (l.kind === "filter") return true;
            if (forRun && (this.isControl(l) || this.isReference(l))) continue;
            return false;
        }
        return false;
    }
}
