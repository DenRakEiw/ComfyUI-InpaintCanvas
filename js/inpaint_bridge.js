// Inpaint Canvas - command bridge for the MCP server (mcp/inpaint_canvas_mcp.py).
//
// The server posts a command to /inpaint_canvas/command; nodes.py pushes it over
// ComfyUI's websocket as the event "inpaint_canvas.command"; this module runs it
// against an editor and posts the answer to /inpaint_canvas/reply. Every command
// is a plain function (editor, args) -> JSON; long jobs (segmentation, generate,
// cutout) wait for their result before answering, so the caller sees the outcome.

const VERSION = 1;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function until(fn, ms, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await fn()) return true; } catch (_) { /* keep waiting */ }
        await wait(step);
    }
    return false;
}

function clampInt(v, lo, hi, dflt) {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export function installBridge({ api, app, viewUrl, loadImageEl, makeCanvas, FILTERS, filterDefaults, NODE_CLASS }) {
    const editors = () => (app.graph && app.graph._nodes ? app.graph._nodes : []).filter((n) => n.inpaintEditor).map((n) => n.inpaintEditor);

    function nodeSummary(ed) {
        return { id: ed.node.id, title: ed.node.title || "", open: !!ed.isOpen, width: ed.width || 0, height: ed.height || 0, layers: ed.layers.length, loaded: !!ed.base };
    }

    function layerSummary(ed, l) {
        const out = {
            id: l.id, name: l.name, kind: l.kind, role: l.role || "none", visible: !!l.visible, opacity: Math.round((l.opacity == null ? 1 : l.opacity) * 100) / 100,
            blend: l.blend || "normal", x: l.x, y: l.y, w: l.w, h: l.h, locked: !!l.locked, alpha_lock: !!l.alphaLock, mask: !!l.mask,
            active: l.id === ed.activeLayerId,
        };
        if (l.match && l.match.strength > 0) out.match = { strength: l.match.strength, source: l.match.source };
        if (l.kind === "filter") { out.filter = l.filter; out.params = { ...(l.params || {}) }; if (l.lut) out.lut = l.lut.name || true; }
        if (l.kind === "text" && l.text) out.text = { content: l.text.content, font: l.text.font, size: l.text.size, color: l.text.color, bold: !!l.text.bold, italic: !!l.text.italic, align: l.text.align };
        return out;
    }

    function findLayer(ed, key, { allowActive = true } = {}) {
        if (key == null || key === "" || (key === "active" && allowActive)) {
            const a = ed.activeLayer();
            if (!a) throw new Error("no active layer: pass a layer id or name");
            return a;
        }
        const s = String(key);
        let l = ed.layers.find((x) => x.id === s);
        if (!l) l = ed.layers.find((x) => (x.name || "").toLowerCase() === s.toLowerCase());
        if (!l) {
            const matches = ed.layers.filter((x) => (x.name || "").toLowerCase().includes(s.toLowerCase()));
            if (matches.length === 1) l = matches[0];
            else if (matches.length > 1) throw new Error(`"${s}" matches ${matches.length} layers: ${matches.map((m) => m.name).join(", ")}`);
        }
        if (!l) throw new Error(`no layer "${s}" (layers: ${ed.layers.map((x) => `${x.name} [${x.id}]`).join(", ") || "none"})`);
        return l;
    }

    function touch(ed, { layers = true } = {}) {
        ed.uploaded.baseHash = null;
        ed.uploaded.controlHash = null;
        if (layers) ed.renderLayers();
        ed.renderInfo();
        ed.draw();
        ed.drawThumb();
        ed.notifyChanged();
    }

    function requireImage(ed) {
        if (!ed.base || !ed.width) throw new Error("no image loaded: use load_image or new_canvas first");
    }

    function bounds(ed) {
        const b = ed.getBounds && ed.getBounds();
        return b ? { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] } : null;
    }

    function rectMask(ed, x, y, w, h) {
        const W = ed.width, H = ed.height;
        const x0 = clampInt(x, 0, W, 0), y0 = clampInt(y, 0, H, 0);
        const x1 = clampInt(x + w, 0, W, W), y1 = clampInt(y + h, 0, H, H);
        if (x1 <= x0 || y1 <= y0) throw new Error(`empty rectangle ${x},${y} ${w}×${h} on a ${W}×${H} image`);
        const m = new Uint8Array(W * H);
        for (let yy = y0; yy < y1; yy++) m.fill(1, yy * W + x0, yy * W + x1);
        return m;
    }

    async function fileFromRef(ref, name) {
        const r = await fetch(viewUrl(ref));
        if (!r.ok) throw new Error(`could not read ${ref.filename} (${r.status})`);
        const b = await r.blob();
        return new File([b], name || ref.filename, { type: b.type || "image/png" });
    }

    function status(ed) {
        const results = ed.layers.filter((l) => l.kind === "result");
        return {
            node: ed.node.id, open: !!ed.isOpen, loaded: !!ed.base, width: ed.width || 0, height: ed.height || 0,
            base: ed.base ? ed.base.ref : null, prompt: ed.promptText || "", negative: ed.negativeText || "",
            generation: { mode: ed.genSettings.mode, seed: ed.genSettings.seed, seed_random: !!ed.genSettings.seedRandom, denoise: ed.genSettings.denoise },
            crop: { ...ed.cropSettings }, selection: bounds(ed), active_layer: ed.activeLayerId,
            layers: ed.layers.map((l) => layerSummary(ed, l)), results: results.length, history: ed.history.length,
            pending: { segment: !!ed.segmentPending, cutout: !!ed.cutoutPending, upsample: !!ed.upsamplePending, transform: !!ed.pending },
            result_input: ed.resultInputState ? ed.resultInputState() : null, status: ed.status || "",
        };
    }

    const COMMANDS = {
        async status(ed) { return status(ed); },
        async open_editor(ed) { if (!ed.isOpen) ed.open(); await wait(150); return { open: !!ed.isOpen }; },
        async close_editor(ed) { if (ed.isOpen) ed.close(); return { open: !!ed.isOpen }; },

        async new_canvas(ed, a) {
            const w = clampInt(a.width, 16, 16384, 1024), h = clampInt(a.height, 16, 16384, 1024);
            await ed.newCanvas(`${w}x${h}`);
            if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
            return { width: ed.width, height: ed.height };
        },
        async load_image(ed, a) {
            const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
            if (!ref.filename) throw new Error("filename missing");
            const img = await loadImageEl(viewUrl(ref));
            if (ed.pending) ed.cancelPending();
            if (ed.textEdit) ed.endTextEdit(false);
            await ed.setBase(ref, img, { keepLayers: false });
            ed.history = []; ed.renderHistory && ed.renderHistory();
            return { width: ed.width, height: ed.height, base: ref };
        },
        async add_image_layer(ed, a) {
            requireImage(ed);
            const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
            const role = a.role === "reference" ? "reference" : "none";
            const before = new Set(ed.layers.map((l) => l.id));
            const at = Number.isFinite(+a.x) && Number.isFinite(+a.y) ? [+a.x, +a.y] : null;
            await ed.addImageLayers([await fileFromRef(ref, a.name || a.filename)], role, at ? { place: "at", at } : { place: role === "reference" ? "cascade" : "fit" });
            const layer = ed.layers.find((l) => !before.has(l.id));
            if (!layer) throw new Error(ed.status || "the layer was not added");
            if (at) { layer.x = Math.round(at[0]); layer.y = Math.round(at[1]); }
            if (Number.isFinite(+a.width) && Number.isFinite(+a.height) && +a.width > 0 && +a.height > 0) { layer.w = Math.round(+a.width); layer.h = Math.round(+a.height); }
            else if (Number.isFinite(+a.width) && +a.width > 0) { const k = +a.width / layer.w; layer.w = Math.round(+a.width); layer.h = Math.max(1, Math.round(layer.h * k)); }
            touch(ed);
            return layerSummary(ed, layer);
        },

        async select_rect(ed, a) {
            requireImage(ed);
            ed.applyMaskToSelection(rectMask(ed, +a.x || 0, +a.y || 0, +a.w || +a.width || 0, +a.h || +a.height || 0), a.mode || "replace");
            return { selection: bounds(ed) };
        },
        async select_all(ed) { requireImage(ed); ed.applyMaskToSelection(rectMask(ed, 0, 0, ed.width, ed.height), "replace"); return { selection: bounds(ed) }; },
        async select_none(ed) { requireImage(ed); ed.clearSelection(); return { selection: bounds(ed) }; },
        async select_invert(ed) { requireImage(ed); await ed.invertSelection(); return { selection: bounds(ed) }; },
        async select_feather(ed, a) { requireImage(ed); await ed.featherSelection(+a.radius || 8); return { selection: bounds(ed), status: ed.status }; },
        async select_grow(ed, a) { requireImage(ed); const n = Math.round(+a.px || 0); if (n) await ed.growSelection(n); return { selection: bounds(ed) }; },
        async select_from_layer(ed, a) {
            requireImage(ed);
            const l = findLayer(ed, a.layer);
            ed.activeLayerId = l.id; ed.selectionFromLayer(); touch(ed);
            return { selection: bounds(ed), layer: l.id };
        },
        async select_by_text(ed, a) {
            requireImage(ed);
            if (!ed.segInput) throw new Error("the editor has no segmentation controls (open it once)");
            if (ed.segmentPending) throw new Error("a segmentation is still running");
            const text = String(a.text || "").trim();
            if (!text) throw new Error("text missing, e.g. \"the car\"");
            ed.segInput.value = text;
            ed.segMode = ["replace", "add", "subtract"].includes(a.mode) ? a.mode : "replace";
            if (a.threshold != null && ed.segThreshold) ed.segThreshold.value = Math.min(0.95, Math.max(0.05, +a.threshold || 0.3));
            const before = ed.status;
            await ed.segmentByText();
            if (!ed.segmentPending) throw new Error(ed.status !== before ? ed.status : "segmentation did not start");
            const ok = await until(() => !ed.segmentPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("segmentation timed out: " + ed.status);
            // the pending flag drops when the mask file arrives; the selection is applied a moment later
            await until(() => !/^(Segmenting|Asking)/.test(ed.status || ""), 30000);
            if (/failed|could not/i.test(ed.status)) throw new Error(ed.status);
            return { selection: bounds(ed), status: ed.status };
        },

        async set_prompt(ed, a) {
            if (a.text != null) { ed.promptText = String(a.text); if (ed.promptInput) ed.promptInput.value = ed.promptText; }
            if (a.negative != null) { ed.negativeText = String(a.negative); if (ed.negativeInput) ed.negativeInput.value = ed.negativeText; }
            ed.notifyChanged();
            return { prompt: ed.promptText, negative: ed.negativeText };
        },
        async set_generation(ed, a) {
            const g = ed.genSettings;
            if (a.mode != null) { if (!["api", "local"].includes(a.mode)) throw new Error("mode must be api or local"); g.mode = a.mode; }
            if (a.seed != null) { g.seed = Math.max(0, Math.floor(+a.seed) || 0); g.seedRandom = false; }
            if (a.seed_random != null) g.seedRandom = !!a.seed_random;
            if (a.denoise != null) g.denoise = Math.min(1, Math.max(0.05, +a.denoise || 1));
            if (a.refine != null) g.refine = !!a.refine;
            if (ed.syncGenControls) ed.syncGenControls();
            ed.renderInfo(); ed.notifyChanged();
            return { mode: g.mode, seed: g.seed, seed_random: !!g.seedRandom, denoise: g.denoise, refine: !!g.refine };
        },
        async set_crop(ed, a) {
            const allowed = ["context", "feather", "fill", "colorMatch", "extendFill", "withOriginal", "align", "paste"];
            for (const [k, v] of Object.entries(a || {})) { if (!allowed.includes(k)) throw new Error(`unknown crop setting "${k}" (${allowed.join(", ")})`); ed.cropSettings[k] = v; }
            if (ed.syncCropControls) ed.syncCropControls();
            ed.renderInfo(); ed.notifyChanged();
            return { ...ed.cropSettings };
        },
        async upsample_prompt(ed, a) {
            requireImage(ed);
            if (ed.upsamplePending) throw new Error("an upsampling is still running");
            const before = ed.promptText;
            await ed.upsamplePrompt();
            if (!ed.upsamplePending) throw new Error(ed.status);
            const ok = await until(() => !ed.upsamplePending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("upsampling timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            return { prompt: ed.promptText, previous: before, status: ed.status };
        },

        async generate(ed, a) {
            requireImage(ed);
            const n0 = ed.history.length;
            const { wired } = ed.resultInputState ? ed.resultInputState() : { wired: true };
            if (!wired) throw new Error(`nothing is wired into the node's ${ed.genSettings.mode === "local" ? "result_local" : "result"} input: the result would not come back`);
            await ed.generate();
            if (/^Error|failed/i.test(ed.status)) throw new Error(ed.status);
            const t0 = Date.now(), limit = clampInt(a.timeout, 5, 3600, 600) * 1000;
            let idleSince = 0;
            while (Date.now() - t0 < limit) {
                await wait(500);
                if (ed.history.length > n0) break;
                if (/^Error/.test(ed.status || "")) throw new Error(ed.status);
                // the queue went idle without a result: the run failed elsewhere in the graph
                try {
                    const q = await (await api.fetchApi("/queue")).json();
                    const idle = !(q.queue_running || []).length && !(q.queue_pending || []).length;
                    if (idle && Date.now() - t0 > 3000) { idleSince = idleSince || Date.now(); if (Date.now() - idleSince > 2500) break; } else idleSince = 0;
                } catch (_) { /* ignore */ }
            }
            // the queue is idle: the result may still be decoding and compositing in a slow (headless, software-rendered) tab
            await until(() => ed.history.length > n0 || /^Error|failed/i.test(ed.status || ""), Math.max(30000, Math.min(limit - (Date.now() - t0), 180000)), 250);
            if (ed.history.length <= n0) throw new Error("no result arrived: " + (ed.status || "the run produced nothing for this node"));
            const h = ed.history[ed.history.length - 1];
            const layer = ed.layers.find((l) => l.id === h.layerId);
            return { layer: layer ? layerSummary(ed, layer) : null, seed: h.seed, mode: h.mode, status: ed.status, seconds: Math.round((Date.now() - t0) / 100) / 10 };
        },

        async list_layers(ed) { return { active: ed.activeLayerId, layers: ed.layers.map((l) => layerSummary(ed, l)) }; },
        async set_active_layer(ed, a) { const l = findLayer(ed, a.layer, { allowActive: false }); ed.activeLayerId = l.id; touch(ed); if (ed.updateSubbar) ed.updateSubbar(); return layerSummary(ed, l); },
        async set_layer(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.name != null) l.name = String(a.name);
            if (a.visible != null) l.visible = !!a.visible;
            if (a.opacity != null) l.opacity = Math.min(1, Math.max(0, +a.opacity > 1 ? +a.opacity / 100 : +a.opacity));
            if (a.blend != null) l.blend = String(a.blend);
            if (a.locked != null) l.locked = !!a.locked;
            if (a.alpha_lock != null) l.alphaLock = !!a.alpha_lock;
            if (a.role != null) {
                if (!["none", "reference", "control"].includes(a.role)) throw new Error("role must be none, reference or control");
                l.role = a.role; l.exportRef = null;
            }
            if (a.match != null || a.match_source != null) {
                if (l.kind === "filter") throw new Error("filter layers have no colour match");
                l.match = l.match || { strength: 0, source: "surroundings" };
                if (a.match != null) { const m = +a.match; l.match.strength = Math.min(100, Math.max(0, Math.round(m > 0 && m < 1 ? m * 100 : m))); }   // 0..100 %, a fraction is taken as a share
                if (a.match_source != null) { if (!["surroundings", "below"].includes(a.match_source)) throw new Error("match_source must be surroundings or below"); l.match.source = a.match_source; }
                ed.markMatchChanged(l);
            }
            const geo = ["x", "y", "w", "h"].some((k) => a[k] != null) || a.width != null || a.height != null;
            if (geo) {
                if (l.kind === "filter") throw new Error("filter layers cover the whole canvas");
                ed.pushUndo({ kind: "transform", id: l.id });
                if (a.x != null) l.x = Math.round(+a.x);
                if (a.y != null) l.y = Math.round(+a.y);
                const w = a.w != null ? a.w : a.width, h = a.h != null ? a.h : a.height;
                if (w != null && h == null) { const k = +w / l.w; l.w = Math.max(1, Math.round(+w)); l.h = Math.max(1, Math.round(l.h * k)); }
                else { if (w != null) l.w = Math.max(1, Math.round(+w)); if (h != null) l.h = Math.max(1, Math.round(+h)); }
            }
            if (a.active) ed.activeLayerId = l.id;
            touch(ed);
            return layerSummary(ed, l);
        },
        async remove_layer(ed, a) { const l = findLayer(ed, a.layer); ed.removeLayer(l.id); return { removed: l.id, layers: ed.layers.length }; },
        async duplicate_layer(ed, a) { const l = findLayer(ed, a.layer); const c = ed.duplicateLayer(l); if (!c) throw new Error(ed.status); return layerSummary(ed, c); },
        async merge_down(ed, a) { const l = findLayer(ed, a.layer); const n = ed.layers.length; await ed.mergeDown(l); if (ed.layers.length === n && ed.layers.includes(l)) throw new Error(ed.status); return { layers: ed.layers.map((x) => layerSummary(ed, x)), status: ed.status }; },
        async move_layer(ed, a) {
            const l = findLayer(ed, a.layer);
            const i = ed.layers.indexOf(l);
            let delta = 0;
            if (a.to === "top") delta = ed.layers.length - 1 - i; else if (a.to === "bottom") delta = -i;
            else if (a.to === "up") delta = 1; else if (a.to === "down") delta = -1; else delta = Math.round(+a.delta || 0);
            if (delta) ed.moveLayer(l.id, delta, { undo: true });
            return { index: ed.layers.indexOf(l), layers: ed.layers.map((x) => x.name) };
        },
        async flip_layer(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.flipLayer(a.axis === "y" || a.axis === "vertical" ? "y" : "x"); return layerSummary(ed, l); },
        async center_layer(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.centerLayer(); return layerSummary(ed, l); },

        async add_filter(ed, a) {
            requireImage(ed);
            const type = String(a.type || "grain");
            if (!FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            const l = ed.addFilterLayer(type);
            if (!l) throw new Error(ed.status);
            if (a.name) l.name = String(a.name);
            if (a.params) COMMANDS._applyParams(ed, l, a.params);
            touch(ed);
            return layerSummary(ed, l);
        },
        async set_filter(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "filter") throw new Error(`${l.name} is not a filter layer`);
            if (a.type && a.type !== l.filter) ed.setFilterType(l, String(a.type));
            if (a.params) COMMANDS._applyParams(ed, l, a.params);
            touch(ed);
            return layerSummary(ed, l);
        },
        _applyParams(ed, l, params) {
            const spec = FILTERS[l.filter].params || [];
            for (const [k, v] of Object.entries(params)) {
                const p = spec.find((x) => x.key === k);
                if (!p) throw new Error(`filter "${l.filter}" has no parameter "${k}" (${spec.map((x) => x.key).join(", ")})`);
                if (p.type === "select") {
                    const ids = (p.options || []).map((o) => (o.id != null ? o.id : o));
                    if (!ids.includes(v)) throw new Error(`"${v}" is not an option of ${k} (${ids.join(", ")})`);
                    l.params[k] = v;
                }
                else if (p.type === "bool") l.params[k] = !!v;
                else if (p.type === "custom") l.params[k] = v;
                else l.params[k] = Math.min(p.max, Math.max(p.min, +v));
            }
            ed.markFilterChanged(l);
        },
        async filter_types() { return { filters: Object.entries(FILTERS).map(([id, f]) => ({ id, label: f.label, params: (f.params || []).map((p) => ({ key: p.key, label: p.label, type: p.type || "number", min: p.min, max: p.max, default: p.type === "custom" ? undefined : p.default, options: p.options ? p.options.map((o) => (o.id != null ? o.id : o)) : undefined })) })) }; },

        async add_text(ed, a) {
            requireImage(ed);
            const l = await ed.addTextLayer(a.x != null ? +a.x : ed.width * 0.1, a.y != null ? +a.y : ed.height * 0.1);
            if (!l) throw new Error(ed.status);
            const t = l.text;
            if (a.text != null) t.content = String(a.text);
            if (a.font != null) t.font = String(a.font);
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.color != null) t.color = String(a.color);
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.align != null) t.align = String(a.align);
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            if (a.outline_color != null) t.outlineColor = String(a.outline_color);
            if (a.name) l.name = String(a.name);
            await ed.renderTextLayer(l, { keepScale: false });
            if (ed.textEdit) ed.endTextEdit(true);
            try { document.activeElement && document.activeElement.blur(); } catch (_) { /* ignore */ }
            touch(ed);
            return layerSummary(ed, l);
        },
        async set_text(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "text") throw new Error(`${l.name} is not a text layer`);
            const t = l.text;
            for (const [k, tk] of [["text", "content"], ["font", "font"], ["color", "color"], ["align", "align"], ["outline_color", "outlineColor"]]) if (a[k] != null) t[tk] = String(a[k]);
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            await ed.renderTextLayer(l, { keepScale: true });
            touch(ed);
            return layerSummary(ed, l);
        },
        async cutout_layer(ed, a) {
            const l = findLayer(ed, a.layer);
            if (ed.cutoutPending) throw new Error("a background removal is still running");
            await ed.cutoutLayer(l);
            if (!ed.cutoutPending) throw new Error(ed.status);
            const ok = await until(() => !ed.cutoutPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("background removal timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            return layerSummary(ed, l);
        },

        async undo(ed) { await ed.undoStep(); return { undo: ed.undo.length, redo: ed.redo.length, status: ed.status }; },
        async redo(ed) { await ed.redoStep(); return { undo: ed.undo.length, redo: ed.redo.length, status: ed.status }; },
        async compare(ed, a) {
            const want = a.enabled == null ? !ed.compare : !!a.enabled;
            if (want !== !!ed.compare) ed.toggleCompare();
            return { compare: !!ed.compare, status: ed.status };
        },
        async extend_canvas(ed, a) {
            requireImage(ed);
            const v = { left: Math.round(+a.left || 0), top: Math.round(+a.top || 0), right: Math.round(+a.right || 0), bottom: Math.round(+a.bottom || 0) };
            if (Object.values(v).some((x) => x < 0)) { await ed.cropCanvas(v); v.left = Math.max(0, v.left); v.top = Math.max(0, v.top); v.right = Math.max(0, v.right); v.bottom = Math.max(0, v.bottom); }
            if (Object.values(v).some((x) => x > 0)) await ed.extendCanvas(v);
            return { width: ed.width, height: ed.height, status: ed.status };
        },

        async export(ed, a) {
            requireImage(ed);
            const fmt = ["png", "jpg", "webp", "psd", "ora"].includes(a.format) ? a.format : "png";
            if (ed.saveFormatSel) ed.saveFormatSel.value = fmt;
            if (ed.saveNameInput) ed.saveNameInput.value = String(a.name || "inpaint_canvas");
            const ref = await ed.exportImage({ download: false });
            if (!ref) throw new Error(ed.status);
            return { file: ref, status: ed.status };
        },
        async export_layer(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; const ref = await ed.exportLayerPng(); if (!ref) throw new Error(ed.status); return { file: ref, status: ed.status }; },
        async export_mask(ed) { requireImage(ed); const ref = await ed.exportMaskPng(); if (!ref) throw new Error(ed.status); return { file: ref, status: ed.status }; },

        async screenshot(ed, a) {
            requireImage(ed);
            const max = clampInt(a.max_size, 64, 4096, 1024);
            const src = a.what === "layer" ? (() => { const l = findLayer(ed, a.layer); return { canvas: l.canvas, w: l.canvas.width, h: l.canvas.height }; })() : { canvas: ed.flattenToCanvas({ forRun: a.what !== "editor" }), w: ed.width, h: ed.height };
            const s = Math.min(1, max / Math.max(src.w, src.h));
            const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(src.canvas, 0, 0, w, h);
            const b = bounds(ed);
            if (a.show_selection !== false && b && ed.sel && a.what !== "layer") {
                ctx.globalAlpha = 0.35; ed.sel.drawTo(ctx, 0, 0, w, h); ctx.globalAlpha = 1;
                ctx.strokeStyle = "#ff40ff"; ctx.lineWidth = 2; ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
            }
            if (a.show_layers && a.what !== "layer") {
                ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1; ctx.font = "12px sans-serif"; ctx.fillStyle = "#7cc7ff";
                for (const l of ed.layers) { if (l.kind === "filter" || !l.visible) continue; ctx.strokeRect(l.x * s, l.y * s, l.w * s, l.h * s); ctx.fillText(l.name, l.x * s + 3, l.y * s + 13); }
            }
            const url = c.toDataURL("image/jpeg", Math.min(0.95, Math.max(0.3, +a.quality || 0.85)));
            return { width: w, height: h, scale: s, image_width: src.w, image_height: src.h, mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
        },
        async get_state(ed) { const v = JSON.parse(ed.getValue() || "{}"); delete v.selection; delete v.selections; return v; },
    };

    /** Whether the frontend finished starting: Vue mounted, no loading overlay. The persisted workflow is
     *  restored right after that, so a caller should also wait until the node count stops changing. */
    function tabInfo() {
        const mask = document.querySelector(".p-blockui-mask");
        return {
            bridge: VERSION, nodes: editors().map(nodeSummary),
            ready: !!(app.vueAppReady && app.graph) && !(mask && mask.offsetWidth),
            nodes_total: app.graph && app.graph._nodes ? app.graph._nodes.length : 0,
            uptime: Math.round(performance.now()),
        };
    }

    // Commands that need no editor: used by the headless mode to prepare a fresh tab.
    const TAB_COMMANDS = {
        async ping() { return tabInfo(); },
        async list_nodes() { return tabInfo(); },
        /** Make sure the graph holds an Inpaint Canvas node; creates one when there is none. */
        async ensure_node() {
            if (!editors().length) {
                const node = LiteGraph.createNode(NODE_CLASS);
                if (!node) throw new Error("the Inpaint Canvas node type is not registered in this tab");
                node.pos = [80, 80];
                app.graph.add(node);
                await until(() => editors().length, 5000);
            }
            return { nodes: editors().map(nodeSummary) };
        },
        /** Replace the graph with a workflow (the JSON of a saved workflow file); it must contain an Inpaint Canvas node. */
        async load_workflow(_, a) {
            const wf = typeof a.workflow === "string" ? JSON.parse(a.workflow) : a.workflow;
            if (!wf || !Array.isArray(wf.nodes)) throw new Error("workflow must be the JSON of a ComfyUI workflow (with a nodes array)");
            await app.loadGraphData(wf, true, true);
            await until(() => editors().length, 8000);
            await wait(500);
            const eds = editors();
            if (!eds.length) throw new Error("the workflow has no Inpaint Canvas node");
            return { nodes: eds.map(nodeSummary), node_count: app.graph._nodes.length };
        },
    };

    async function handle(msg) {
        if (!msg || !msg.id) return;
        const reply = (body) => api.fetchApi("/inpaint_canvas/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: msg.id, client: api.clientId, ...body }) }).catch(() => {});
        const cmd = String(msg.cmd || "");
        if (TAB_COMMANDS[cmd]) {
            try { return reply({ ok: true, result: await TAB_COMMANDS[cmd](null, msg.args || {}) }); }
            catch (err) { console.warn("Inpaint Canvas bridge:", cmd, err); return reply({ ok: false, error: String((err && err.message) || err) }); }
        }
        const fn = cmd.startsWith("_") ? null : COMMANDS[cmd];
        if (!fn) return reply({ ok: false, error: `unknown command "${cmd}" (${Object.keys(TAB_COMMANDS).concat(Object.keys(COMMANDS).filter((k) => !k.startsWith("_"))).join(", ")})` });
        let eds = editors();
        if (msg.node != null && msg.node !== "") eds = eds.filter((e) => String(e.node.id) === String(msg.node));
        if (!eds.length) {
            return reply({ ok: false, error: msg.node != null && msg.node !== "" ? `no Inpaint Canvas node with id ${msg.node} in the open graph` : "no Inpaint Canvas node in the open graph: add one (double-click the canvas, search \"Inpaint Canvas\")" });
        }
        const ed = eds[0];
        try {
            const result = await fn(ed, msg.args || {});
            reply({ ok: true, node: ed.node.id, result: result === undefined ? null : result });
        } catch (err) {
            console.warn("Inpaint Canvas bridge:", cmd, err);
            reply({ ok: false, node: ed.node.id, error: String((err && err.message) || err) });
        }
    }

    api.addEventListener("inpaint_canvas.command", ({ detail }) => { handle(detail); });
}
