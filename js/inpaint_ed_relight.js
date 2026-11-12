// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_relight.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the relight runtime (maps, the lights overlay) and the scene draw and overlays: moved out of inpaint_canvas.js (item 56 S10, docs/PLAN_SPLIT.md), text unchanged.

import { heightNormals, route as kernelRoute, shadowMarch } from "./px/kernels.js";
import { INTERACTIVE, NORMAL } from "./inpaint_pool.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { editorPool, markStep } from "./inpaint_jobs.js";
import { nextPartsSeq } from "./inpaint_encode.js";
import { STRIPES_PER_WORKER, cancelMarch, lightColorHex, lightToMap, marchOnPool, relightDepthScale, relightMapKey, relightVisCurrent, relightVisKey } from "./inpaint_relight.js";
import { HANDLE_PX, makeCanvas, refBadge } from "./inpaint_consts.js";

export class RelightPart {
    /**
     * Downsample 16-bit depth map for quarter-size shadow march.
     */
    downsampleDepth(src, srcW, srcH, dstW, dstH) {
        // on a SharedArrayBuffer where the page is isolated, as the depth map itself (inpaint_maps.js `makeMap`): the quick
        // march reads it in stripes where it lies (K12, inpaint_relight.js `marchOnPool`)
        const shared = typeof SharedArrayBuffer === "function" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
        const dst = shared ? new Uint16Array(new SharedArrayBuffer(dstW * dstH * 2)) : new Uint16Array(dstW * dstH);
        for (let dy = 0; dy < dstH; dy++) {
            const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) / dstH) * srcH));
            const sRow = sy * srcW;
            const dRow = dy * dstW;
            for (let dx = 0; dx < dstW; dx++) {
                const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) / dstW) * srcW));
                dst[dRow + dx] = src[sRow + sx];
            }
        }
        return dst;
    }

    /**
     * Resolves when a pending nudge or wheel step is committed and every relight layer's full shadow map is computed
     * for its lights (`relightIdle`): what a run and an export wait for. `also`: a relight layer to settle even when it is
     * hidden (a relight render reads its own maps for the light map).
     */
    async relightSettled(also = null) {
        this.flushPendingDebounces();
        await this.relightIdle(also);
    }

    /**
     * Resolves when every relight layer's full shadow map is computed for its current lights (F2.7): what a reader of
     * the picture a run sees waits for (a crop, a screenshot, a plugin's settled flatten), so it reads neither the quick
     * map of a light on the move nor the map of where a light was. Unlike `relightSettled` it leaves a pending nudge as it
     * is: a read pushes no undo step. Each round waits for the jobs there are when it starts (a drag goes on adding quick
     * ones); a light moved during the wait starts another round, three at most. Hidden relight layers are not read
     * (`also` is one that is, whether shown or not).
     * @param {any} [also]
     */
    async relightIdle(also = null) {
        for (let round = 0; round < 3; round++) {
            for (const l of this.layers || []) {
                if (l.kind === "filter" && l.filter === "relight" && (l === also || this.shown(l))) this.ensureRelightMaps(l);
            }
            const jobs = this._relightPending ? Array.from(this._relightPending) : [];
            if (!jobs.length) return;
            await Promise.all(jobs);
        }
    }

    /** The relight_shadow marches in flight over all layers, quick and full (the K0b harness waits on it). */
    relightMarching() {
        return this._relightMarches || 0;
    }

    isRelightActive() {
        const l = this.activeLayer();
        return !!(l && l.kind === "filter" && l.filter === "relight");
    }

    ownLightPos(layer) {
        const stats = this.belowStats(layer, false);
        const fit = stats?.fit;
        const l0 = (fit && Array.isArray(fit.l0) && fit.l0.length >= 3) ? fit.l0 : [0, 0, 1];
        const cx = this.width * 0.5;
        const cy = this.height * 0.5;
        const spread = Math.min(this.width, this.height) * 0.35;
        return [cx + l0[0] * spread, cy + l0[1] * spread, l0];
    }

    hitLight(layer, ix, iy) {
        if (!layer || !layer.params || !Array.isArray(layer.params.lights)) return null;
        const lights = layer.params.lights;
        const s = this.view.scale;

        // 1. Aim handles (spot lights)
        for (let i = lights.length - 1; i >= 0; i--) {
            const l = lights[i];
            if (l && l.on !== false && l.type === "spot" && Array.isArray(l.aim)) {
                if (Math.hypot(ix - l.aim[0], iy - l.aim[1]) <= 14 / s) {
                    return { light: l, mode: "aim", index: i };
                }
            }
        }

        // 2. Light rings
        for (let i = lights.length - 1; i >= 0; i--) {
            const l = lights[i];
            if (!l) continue;
            const rScreen = Math.max(10, Math.min(36, 18 - ((l.dist || 0) / 100.0) * 8));
            const hitRadius = (rScreen + 6) / s;
            if (Math.hypot(ix - l.x, iy - l.y) <= hitRadius) {
                return { light: l, mode: "light", index: i };
            }
        }

        // 3. Own light handle
        const [ox, oy, l0] = this.ownLightPos(layer);
        if (Math.hypot(ix - ox, iy - oy) <= 16 / s) {
            return { mode: "own_light", pos: [ox, oy], l0 };
        }

        return null;
    }

    updateLightsCursor(ix, iy) {
        if (!this.isRelightActive()) {
            this.viewEl.style.cursor = "";
            return;
        }
        const layer = this.activeLayer();
        const hit = this.hitLight(layer, ix, iy);
        if (hit) {
            if (hit.mode === "aim") {
                this.viewEl.style.cursor = "crosshair";
            } else if (hit.mode === "light") {
                this.viewEl.style.cursor = "move";
            } else if (hit.mode === "own_light") {
                this.viewEl.style.cursor = "copy";
            }
        } else {
            this.viewEl.style.cursor = "crosshair";
        }
    }

    drawLightsOverlay(ctx) {
        if (!this.isOpen || !this.isRelightActive() || this.hideLightHandles) return;
        const activeLayer = this.activeLayer();
        if (!activeLayer || !activeLayer.params || !Array.isArray(activeLayer.params.lights)) return;
        const lights = activeLayer.params.lights;
        const selId = activeLayer._selectedLightId;
        const s = this.view.scale;
        const invScale = 1.0 / s;

        // 1. Fitted original light ("own light")
        const [ox, oy] = this.ownLightPos(activeLayer);
        const or = 14 * invScale;
        ctx.save();
        ctx.strokeStyle = "rgba(180, 180, 180, 0.7)";
        ctx.lineWidth = 1.5 * invScale;
        ctx.setLineDash([3 * invScale, 3 * invScale]);
        ctx.beginPath();
        ctx.arc(ox, oy, or, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(180, 180, 180, 0.9)";
        ctx.beginPath();
        ctx.arc(ox, oy, 2.5 * invScale, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = `600 ${(10 * invScale).toFixed(2)}px system-ui, sans-serif`;
        const ownText = "own light";
        const tw = ctx.measureText(ownText).width + 6 * invScale;
        const th = 13 * invScale;
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        ctx.fillRect(ox - tw / 2, oy + or + 3 * invScale, tw, th);
        ctx.fillStyle = "rgba(220, 220, 220, 0.9)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(ownText, ox, oy + or + 3 * invScale + th / 2);
        ctx.restore();

        // 2. Active lights
        for (let i = 0; i < lights.length; i++) {
            const l = lights[i];
            if (!l) continue;
            const x = l.x;
            const y = l.y;
            const isSelected = l.id === selId;
            const colorHex = lightColorHex(l.color);
            const rScreen = Math.max(10, Math.min(36, 18 - ((l.dist || 0) / 100.0) * 8));
            const r = rScreen * invScale;

            ctx.save();

            // Spot aim line and aim handle
            if (l.type === "spot" && Array.isArray(l.aim)) {
                const [ax, ay] = l.aim;
                ctx.save();
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.5 * invScale;
                ctx.setLineDash([4 * invScale, 3 * invScale]);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(ax, ay);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.5 * invScale;
                ctx.beginPath();
                ctx.arc(ax, ay, 6 * invScale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(ax, ay, 2 * invScale, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Outer halo if selected
            if (isSelected) {
                ctx.strokeStyle = "rgba(74, 144, 217, 0.5)";
                ctx.lineWidth = 5 * invScale;
                ctx.beginPath();
                ctx.arc(x, y, r + 2 * invScale, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Main ring
            ctx.strokeStyle = colorHex;
            ctx.lineWidth = (isSelected ? 2.5 : 1.5) * invScale;
            if (l.on === false) {
                ctx.setLineDash([4 * invScale, 4 * invScale]);
            } else {
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Inner glyph
            if (l.type === "point") {
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(x, y, 3 * invScale, 0, Math.PI * 2);
                ctx.fill();
            } else if (l.type === "sun") {
                ctx.fillStyle = colorHex;
                ctx.beginPath();
                ctx.arc(x, y, 2.5 * invScale, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.2 * invScale;
                const ray = 5 * invScale;
                ctx.beginPath();
                ctx.moveTo(x - ray, y); ctx.lineTo(x + ray, y);
                ctx.moveTo(x, y - ray); ctx.lineTo(x, y + ray);
                ctx.stroke();
            } else if (l.type === "spot") {
                const aim = l.aim || [x, y + 100];
                const angle = Math.atan2(aim[1] - y, aim[0] - x);
                const halfCone = ((l.cone || 30) * Math.PI) / 180;
                ctx.strokeStyle = colorHex;
                ctx.lineWidth = 1.2 * invScale;
                const cr = 6 * invScale;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + cr * Math.cos(angle - halfCone), y + cr * Math.sin(angle - halfCone));
                ctx.arc(x, y, cr, angle - halfCone, angle + halfCone);
                ctx.lineTo(x, y);
                ctx.stroke();
            }

            // Number badge
            const bx = x + r * 0.72 + 6 * invScale;
            const by = y - r * 0.72 - 6 * invScale;
            const br = 7 * invScale;
            ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = isSelected ? "#7cc7ff" : "rgba(255, 255, 255, 0.4)";
            ctx.lineWidth = 1 * invScale;
            ctx.stroke();
            ctx.font = `bold ${(9 * invScale).toFixed(2)}px system-ui, sans-serif`;
            ctx.fillStyle = isSelected ? "#7cc7ff" : "#ffffff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(i + 1), bx, by);

            ctx.restore();
        }
    }

    /**
     * Ensures normals and visibility maps for a relight filter layer are up to date.
     * Manages layer._relight cache and dispatches worker pool jobs.
     * @param {any} layer
     * @param {{ quick?: boolean }} [opts]
     */
    ensureRelightMaps(layer, { quick = false } = {}) {
        const depthMap = (this.maps && this.maps.depth) || null;
        if (!depthMap || !depthMap.data || depthMap.w <= 0 || depthMap.h <= 0) return;

        const cache = layer._relight || (layer._relight = {
            key: null,
            normals: null,
            vis: null,
            visQuick: null,
            depthQuick: null,
            fit: null,
            pending: new Set(),
        });

        const mapVersion = depthMap.dataVersion ?? depthMap.version ?? 0;   // the normals read the data alone
        const depthScale = relightDepthScale(layer.params);
        const sigma = Number.isFinite(layer.params?.sigma) ? Number(layer.params.sigma) : 2.0;
        const mapLongSide = Math.max(depthMap.w, depthMap.h);
        const scaleZ = (depthScale / 100.0) * mapLongSide;

        // Normals cache
        const nKey = `${mapVersion}_${depthScale}_${sigma}`;
        if ((!cache.normals || cache.normals.key !== nKey) && !cache.pending.has("n:" + nKey)) {
            cache.pending.add("n:" + nKey);
            const p = (async () => {
                try {
                    const pool = editorPool();
                    if (pool && !pool.off) {
                        const res = await pool.run("relight_normals", {
                            depth: depthMap.data,
                            w: depthMap.w,
                            h: depthMap.h,
                            scale: scaleZ,
                            sigma,
                        }, [], { priority: quick ? INTERACTIVE : NORMAL });
                        cache.normals = {
                            data: new Uint8Array(res.normals),
                            w: depthMap.w,
                            h: depthMap.h,
                            key: nKey,
                        };
                    } else {
                        const normals = heightNormals(depthMap.data, depthMap.w, depthMap.h, scaleZ, sigma);
                        cache.normals = {
                            data: normals,
                            w: depthMap.w,
                            h: depthMap.h,
                            key: nKey,
                        };
                    }
                    cache.key = nKey;
                    this.markFilterChanged(layer, { soon: true });
                } catch (err) {
                    console.warn("relight_normals failed:", err);
                } finally {
                    cache.pending.delete("n:" + nKey);
                }
            })();
            this._relightPending.add(p);
            p.finally(() => this._relightPending.delete(p));
        }

        // Shadow maps: a channel per light under relightVisKey, the keys pickVis reads (docs/PLAN_RELIGHT_FIXES.md F2.5)
        const shadows = Number.isFinite(layer.params?.shadows) ? Number(layer.params.shadows) : 60;
        if (shadows === 0) return;   // pickVis hands an all-lit map; the maps stay as they are for when the shadows come back
        const mapKey = relightMapKey(depthMap);
        const lights = Array.isArray(layer.params?.lights) ? layer.params.lights : [];
        const targetW = quick ? Math.max(1, Math.floor(depthMap.w / 4)) : depthMap.w;
        const targetH = quick ? Math.max(1, Math.floor(depthMap.h / 4)) : depthMap.h;
        const stamp = () => (cache.ticket = (cache.ticket || 0) + 1);

        let targetVis = quick ? cache.visQuick : cache.vis;
        if (!targetVis || targetVis.w !== targetW || targetVis.h !== targetH) {
            const visData = new Uint8Array(targetW * targetH * 4);
            let keys = [null, null, null, null], tickets = [0, 0, 0, 0], seq = 0;
            const full = cache.vis;
            if (quick && full && full.data && full.w && full.h) {
                const srcVis = full.data;
                const srcW = full.w;
                const srcH = full.h;
                for (let dy = 0; dy < targetH; dy++) {
                    const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) / targetH) * srcH));
                    const sRow = sy * srcW;
                    const dRow = dy * targetW;
                    for (let dx = 0; dx < targetW; dx++) {
                        const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) / targetW) * srcW));
                        const sIdx = (sRow + sx) * 4;
                        const dIdx = (dRow + dx) * 4;
                        visData[dIdx] = srcVis[sIdx];
                        visData[dIdx + 1] = srcVis[sIdx + 1];
                        visData[dIdx + 2] = srcVis[sIdx + 2];
                        visData[dIdx + 3] = srcVis[sIdx + 3];
                    }
                }
                // the full map at a quarter of its size: current for every light that has not moved since it was made, so
                // a drag marches only the light it moves, and its first frames show the shadows from before the drag
                if (Array.isArray(full.keys)) keys = full.keys.map((k) => (k ? k.slice(0, -1) + "q" : null));
                if (Array.isArray(full.tickets)) tickets = full.tickets.slice();
                seq = full.seq || 0;
            } else {
                visData.fill(255);
            }
            if (!quick) {
                // a new full map (a depth map of another size): newer than any quick map, which belongs to the old one
                seq = cache.seq = (cache.seq || 0) + 1;
                cache.visQuick = null;
            }
            targetVis = { data: visData, w: targetW, h: targetH, keys, tickets, seq };
            if (quick) cache.visQuick = targetVis;
            else cache.vis = targetVis;
        }

        let marchDepth;
        if (quick) {
            if (!cache.depthQuick || cache.depthQuick.w !== targetW || cache.depthQuick.h !== targetH || cache.depthQuick.mapVersion !== mapVersion) {
                cache.depthQuick = {
                    data: this.downsampleDepth(depthMap.data, depthMap.w, depthMap.h, targetW, targetH),
                    w: targetW,
                    h: targetH,
                    mapVersion,
                };
            }
            marchDepth = cache.depthQuick.data;
        } else {
            marchDepth = depthMap.data;
        }
        const scaleFactor = targetW / depthMap.w;
        const marchScale = scaleZ * scaleFactor;
        // the K0b harness (docs/PLAN_WASM_BUILD.md §4.5): a "start" mark for a call that posts marches, made at its first;
        // "landed" for each answer, "idle" when the layer's last march in flight has answered
        let run = null;
        // K12 (§4.5): each march is a pool group of its own (a page-wide sequence number: a layer's id and its cache's
        // tickets repeat in a second tab of the same document and after a deep release; then the layer, the channel, the
        // size, the ticket), cut into stripes by marchOnPool. A full march of a channel supersedes the one still on its way for it (the light moved on,
        // went off, or came back to the key the channel holds): the older one's queued stripes are cancelled and its
        // pending key is freed at once, so the light can march there again. A quick march is never cancelled: the quick
        // map trails the pointer, an older answer still lands over an older one. K12b: a full march's stripes go through
        // the pool's feed (at most the route relightFeed, else the pool's size + 1, stripes of all full marches posted at
        // once), so other NORMAL pool work waits for about one stripe; a quick march's go at once (INTERACTIVE).
        const fullMarches = cache.fullMarches || (cache.fullMarches = [null, null, null, null]);
        const supersede = (i) => {
            const m = fullMarches[i];
            if (!m) return;
            fullMarches[i] = null;
            m.superseded = true;
            cache.pending.delete(m.pendingKey);
            const pool = editorPool();
            if (pool && !pool.off) cancelMarch(pool, m.group);   // its stripes in the feed too (K12b)
        };
        // the depth map's name for the workers' resident copy of it (px.js `_slot`): its data, the march's size
        const depthKey = `${mapKey}:${quick ? "q" : "f"}:${targetW}x${targetH}`;

        for (let i = 0; i < 4; i++) {
            const l = lights[i];
            const vKey = relightVisKey(l, depthScale, mapKey, quick);
            if (vKey === null) {
                if (!quick) supersede(i);
                if (targetVis.keys[i] !== null) {
                    for (let idx = 0; idx < targetW * targetH; idx++) {
                        targetVis.data[idx * 4 + i] = 255;
                    }
                    targetVis.keys[i] = null;
                    (targetVis.tickets || (targetVis.tickets = [0, 0, 0, 0]))[i] = stamp();
                    targetVis.seq = cache.seq = (cache.seq || 0) + 1;
                }
                continue;
            }

            const pendingKey = `v:${quick ? "q" : "f"}:${i}:${vKey}`;
            if (targetVis.keys[i] === vKey) {
                if (!quick && fullMarches[i] && fullMarches[i].pendingKey !== pendingKey) supersede(i);
                continue;
            }
            if (cache.pending.has(pendingKey)) continue;
            if (!quick) supersede(i);
            cache.pending.add(pendingKey);
            const chan = i;
            const ticket = stamp();
            const march = { group: `relight${nextPartsSeq()}:${layer.id}:${chan}:${targetW}x${targetH}:${ticket}`, pendingKey, superseded: false };
            if (!quick) fullMarches[chan] = march;
            if (!run) run = markStep("relight_maps", "start", { quick, lights: 0, w: targetW, h: targetH });
            run.lights++;
            cache.marching = (cache.marching || 0) + 1;
            this._relightMarches++;
            const p = (async () => {
                try {
                    const lm = lightToMap(l, depthMap, { depth_scale: depthScale });
                    const lightVec = [
                        (lm.mx / depthMap.w) * targetW,
                        (lm.my / depthMap.h) * targetH,
                        lm.mz * scaleFactor,
                        l.type === "sun" ? 1 : 0,
                    ];
                    const diff = Number.isFinite(l.diffusion) ? Number(l.diffusion) : 30;
                    const radius = (diff / 100.0) * (0.05 * Math.max(targetW, targetH));
                    const bias = 0.005 * marchScale;
                    const taps = quick ? 1 : 4;
                    const steps = quick ? 16 : 32;

                    let vChan;
                    const pool = editorPool();
                    const posted = performance.now();
                    if (pool && !pool.off) {
                        const stripes = kernelRoute("relightStripes"), feed = kernelRoute("relightFeed");
                        vChan = await marchOnPool(pool, {
                            depth: marchDepth,
                            w: targetW,
                            h: targetH,
                            scale: marchScale,
                            light: lightVec,
                            radius,
                            taps,
                            steps,
                            bias,
                            key: depthKey,
                        }, {
                            priority: quick ? INTERACTIVE : NORMAL,
                            group: march.group,
                            stripes: stripes === undefined ? STRIPES_PER_WORKER * pool.size : stripes,
                            budget: quick ? 0 : (feed === undefined ? pool.size + 1 : feed),
                        });
                    } else {
                        vChan = shadowMarch(marchDepth, targetW, targetH, marchScale, lightVec, radius, taps, steps, bias, 0, targetH);
                    }
                    // Into the map of this size that is there now (a quick map seeded again meanwhile takes it too). A march for
                    // the key the channel wants now (the light, the relief scale and the depth map at landing) always lands
                    // and outranks any older march still on its way; one for a light that has moved on lands only in the
                    // quick map and only over an older march: during a drag the quick map trails the pointer instead of
                    // waiting for it to stop. pickVis tells current from trailing by the keys.
                    const tv = quick ? cache.visQuick : cache.vis;
                    const current = vKey === this.relightChannelKey(layer, chan, quick);
                    markStep("relight_maps", "landed", { chan, quick, current, ms: Math.round((performance.now() - posted) * 10) / 10 });
                    if (tv && tv.w === targetW && tv.h === targetH && tv.keys[chan] !== vKey) {
                        const tickets = tv.tickets || (tv.tickets = [0, 0, 0, 0]);
                        if (current || (quick && ticket > (tickets[chan] || 0))) {
                            for (let idx = 0; idx < targetW * targetH; idx++) {
                                tv.data[idx * 4 + chan] = vChan[idx];
                            }
                            tv.keys[chan] = vKey;
                            tickets[chan] = current ? stamp() : ticket;
                            tv.seq = cache.seq = (cache.seq || 0) + 1;
                            if (!quick) this.dropQuickVis(layer);
                            this.markFilterChanged(layer, { soon: true });
                        }
                    }
                } catch (err) {
                    // a superseded march's cancelled stripes (the pool's CancelledError): a newer march of the channel took over
                    if (!(err && err.cancelled)) console.warn(`relight_shadow channel ${chan} failed:`, err);
                } finally {
                    cache.marching--;
                    this._relightMarches--;
                    if (!cache.marching) markStep("relight_maps", "idle", { quick });
                    if (!march.superseded) cache.pending.delete(pendingKey);   // a superseded one's key was freed when it was, and may be a newer march's now
                    if (fullMarches[chan] === march) fullMarches[chan] = null;
                    // the channel still lacks the key it wants now and no march for that key is on its way (a light turned
                    // off and on while its march ran, a march for a key left behind): ask for one
                    const want = this.relightChannelKey(layer, chan, quick);
                    const tvNow = quick ? cache.visQuick : cache.vis;
                    if (want && tvNow && Array.isArray(tvNow.keys) && tvNow.keys[chan] !== want
                        && !cache.pending.has(`v:${quick ? "q" : "f"}:${chan}:${want}`) && this.layers.includes(layer)) {
                        this.markFilterChanged(layer, { soon: true });
                    }
                }
            })();
            this._relightPending.add(p);
            p.finally(() => this._relightPending.delete(p));
        }
        if (!quick) this.dropQuickVis(layer);
    }

    /**
     * The key shadow channel `chan` of a relight layer wants now: its light, relief scale and the depth map as they are
     * (`relightVisKey`), null for a light that is off.
     * @param {any} layer
     * @param {number} chan
     * @param {boolean} quick
     */
    relightChannelKey(layer, chan, quick) {
        const p = layer.params || {};
        return relightVisKey((Array.isArray(p.lights) ? p.lights : [])[chan], relightDepthScale(p), relightMapKey(this.maps && this.maps.depth), quick);
    }

    /**
     * A relight layer's quick shadow map goes once its full map is current for its lights (F2.5): the next drag or slider
     * preview seeds a quick map from the full one, instead of showing the shadows of an earlier drag in its first frames.
     * @param {any} layer
     */
    dropQuickVis(layer) {
        const cache = layer && layer._relight;
        if (!cache || !cache.visQuick) return;
        if (relightVisCurrent(cache.vis, layer.params?.lights, relightDepthScale(layer.params), relightMapKey(this.maps && this.maps.depth), false)) {
            cache.visQuick = null;
        }
    }


    /**
     * Everything the composited image depends on. While it stays the same the last
     * scene canvas is reused and only the overlays (ants, cursor, handles) are redrawn.
     */
    sceneSignature() {
        const v = this.view;
        const p = this.pointer, q = this.pending;
        const parts = [this.pixelVersion, this.compositeVersion, this.width, this.height,
            this.canvas.width, this.canvas.height, Math.round(v.x * 8), Math.round(v.y * 8), v.scale, v.angle || 0,
            this.peekBase ? 1 : 0, this.compare ? `${this.compare.a}:${this.compare.b}:${this.compare.split}` : 0,
            this.compareShow || 0, this.filterPreview || 0, this.viewTilt() || 0,
            this.maskView ? `${this.maskView.id}:${this.maskView.mode}` : ""];
        for (const l of this.layers) {
            parts.push(l.id, this.shown(l) ? 1 : 0, l.opacity, l.blend, l.role, l.x, l.y, l.w, l.h,
                l.kind === "filter" ? l.filter + JSON.stringify(l.params || {}) + (this.mapsOf(l).length ? `:${this.mapsVersion || 0}` : "") : "",
                l.match ? `${l.match.strength}:${l.match.source}` : "", l.maskPx ? (l.maskOff ? 2 : 1) : 0, l.maskEdit ? 1 : 0);
        }
        if (p) parts.push("p", p.kind, p.layer ? p.layer.id : "");
        if (q) parts.push("q", q.mode, q.angle || 0, q.points ? q.points.join(",") : "");
        return parts.join("|");
    }

    drawScene() {
        if (!this.isOpen) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.base) return;
        const s = this.view.scale;
        if (!this.sceneCanvas || this.sceneCanvas.width !== W || this.sceneCanvas.height !== H) {
            this.sceneCanvas = makeCanvas(W, H);
            this.sceneSig = null;
        }
        if (this.sceneSig !== this.sceneSignature()) {
            const sctx = this.sceneCanvas.getContext("2d");
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.globalAlpha = 1;
            sctx.globalCompositeOperation = "source-over";
            sctx.clearRect(0, 0, W, H);
            this.applyViewTransform(sctx);
            this.applyTilt(sctx);
            sctx.imageSmoothingEnabled = s < 1;
            this._pyramidBudget = 1;
            this._pyramidPending = false;
            this.drawSceneImage(sctx, W, H);
            this._pyramidBudget = Infinity;
            this.sceneSig = this.sceneSignature();   // caches filled while drawing count as part of this scene
            if (this._pyramidPending) {
                // a source still has to build its level: draw again, sharper, on the next frame
                this.sceneSig = null;
                this.drawSoon();
            }
        }
        ctx.drawImage(this.sceneCanvas, 0, 0);
        this.applyViewTransform(ctx);
        ctx.imageSmoothingEnabled = s < 1;
        this.drawSceneOverlays(ctx);
    }

    /** The image itself: the base alone while peeking, the compare split, or the composite. */
    drawSceneImage(ctx, W, H) {
        if (this.peekBase) {
            const bs = this.basePx;
            // C6 (c2f): on tiles the peek is the view's composite of the base alone, from the base's tiles (the atlas on the
            // GPU path, its region canvas on Canvas 2D), shown stale or coarse until its chains land like any frame. The
            // whole base drawn through displaySource was its display mirror and a GPU copy of it (at 0.5 and up) or a Skia
            // pyramid (below): 572 MB and more at 15000 x 10000 on the first peek after a change.
            if (bs && isTilePixels(bs)) this.drawViewComposite(ctx, { baseOnly: true });
            else if (bs) ctx.drawImage(this.displaySource(bs, this.view.scale, true), 0, 0, this.width, this.height);
            return;
        }
        if (this.compare && this.compare.a && this.compare.b) {
            // A left, B right: two passes with the other result hidden; caches are invalidated between them
            const split = Math.min(0.95, Math.max(0.05, this.compare.split ?? 0.5));
            for (const side of ["a", "b"]) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.beginPath();
                if (side === "a") ctx.rect(0, 0, W * split, H); else ctx.rect(W * split, 0, W * (1 - split), H);
                ctx.clip();
                this.applyViewTransform(ctx);
                this.applyTilt(ctx);
                this.compareShow = this.compare[side];
                this.uploaded.baseHash = null;
                this.drawViewComposite(ctx);
                ctx.restore();
            }
            this.compareShow = null;
            this.uploaded.baseHash = null;
            this.applyViewTransform(ctx);
            return;
        }
        this.drawViewComposite(ctx);
    }

    cleanMaskView() {
        if (!this.maskView) return;
        const l = this.layers.find((x) => x.id === this.maskView.id);
        if (!l) { this.maskView = null; return; }
        if (this.maskView.mode !== "effect" && !l.maskPx) { this.maskView = null; return; }
        if (this.maskView.mode === "effect" && (l.kind !== "filter" || !(l.params && l.params.limit))) { this.maskView = null; return; }
    }

    /** Selection, crop frame, layer handles and the tool cursors, on top of the scene. */
    drawSceneOverlays(ctx) {
        const s = this.view.scale;
        // what sits on the picture turns with the straighten preview; the frame, the guides and the grid stay level
        const tilt = this.viewTilt();
        if (tilt) { ctx.save(); this.applyTilt(ctx); }
        // a patch drag: its preview under the outline, and the outline where the drag has taken it
        const patch = this.pointer && this.pointer.kind === "patchdrag" ? this.pointer : null;
        if (patch) this.drawPatchPreview(ctx, patch);
        this.drawLiquifyFreeze(ctx);
        const shift = patch && patch.moved && (patch.d[0] || patch.d[1]) ? patch.d : null;
        if (this.selectionDisplay === "tint" || this.quickMask || !this.getBounds()) {
            // an empty selection on tiles (no tile) draws nothing: its draw made a display mirror as large as the
            // image, and a GPU copy of it at 0.5 or more, for transparent pixels (C2's final review)
            if (!this.selectionHasNoTiles()) {
                ctx.globalAlpha = this.quickMask ? 0.5 : 0.4;
                const region = this.viewportRegion();
                if (shift) { ctx.save(); ctx.translate(shift[0], shift[1]); }
                this.drawSelectionInto(ctx, s, shift && region ? { ...region, x: region.x - shift[0], y: region.y - shift[1] } : region);
                if (shift) ctx.restore();
                ctx.globalAlpha = 1;
            }
        } else {
            // the outline stays where the selection is, and a second one follows the drag
            this.drawMarchingAnts(ctx);
            if (shift) this.drawMarchingAnts(ctx, shift);
        }

        if (this.tool === "object" && this.hoverObjectCanvas && !this.spaceDown) {
            // the object under the cursor, red shape shown in cyan
            ctx.save();
            ctx.globalAlpha = 0.5;
            try { ctx.filter = "hue-rotate(180deg)"; } catch (_) { /* old canvas */ }
            ctx.drawImage(this.displaySource(this.hoverObjectCanvas, s), 0, 0, this.width, this.height);
            ctx.restore();
        }

        if (this.mapView === "depth" && !this.spaceDown) {
            const map = (this.maps && this.maps.depth) || this.depth;
            if (map) {
                const proxy = this.depthProxy2048(map);
                if (proxy) {
                    const xf = map.xf || [this.width, 0, 0, this.height, 0, 0];
                    ctx.save();
                    ctx.transform(...xf);
                    ctx.drawImage(proxy, 0, 0, 1, 1);
                    ctx.restore();
                }
            }
        } else if (this.showDepthMap && this.depth && !this.spaceDown) {
            this.drawDepthOverlay(ctx);
        }

        if (this._rangeTint && !this.spaceDown) {
            ctx.save();
            ctx.globalAlpha = 0.4;
            if (this._rangeTint.xf) {
                ctx.transform(...this._rangeTint.xf);
                ctx.drawImage(this._rangeTint.canvas, 0, 0, 1, 1);
            } else if (this._rangeTint.box) {
                const [bx, by, bw, bh] = this._rangeTint.box;
                ctx.drawImage(this._rangeTint.canvas, bx, by, bw, bh);
            } else {
                ctx.drawImage(this._rangeTint.canvas, 0, 0, this.width, this.height);
            }
            ctx.restore();
        }

        this.cleanMaskView();
        if (this.maskView && (this.maskView.mode === "overlay" || this.maskView.mode === "alone")) {
            const vl = this.layers.find((l) => l.id === this.maskView.id);
            if (vl && vl.maskPx) {
                const vw = this.canvas.width, vh = this.canvas.height;
                const region = this.viewportRegion();
                if (this.maskView.mode === "overlay") {
                    const sc = this.passScratch("maskOverlay", vw, vh);
                    const sctx = sc.getContext("2d");
                    sctx.save();
                    try {
                        sctx.setTransform(1, 0, 0, 1, 0, 0);
                        sctx.globalCompositeOperation = "source-over";
                        sctx.globalAlpha = 1;
                        sctx.clearRect(0, 0, vw, vh);
                        sctx.fillStyle = "#ff0000";
                        sctx.fillRect(0, 0, vw, vh);
                        sctx.globalCompositeOperation = "destination-out";
                        this.applyViewTransform(sctx);
                        if (tilt) this.applyTilt(sctx);
                        this.drawMaskInto(sctx, vl, s, region, true);
                    } finally {
                        sctx.restore();
                    }
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.globalCompositeOperation = "source-over";
                    ctx.globalAlpha = 0.5;
                    ctx.drawImage(sc, 0, 0);
                    ctx.restore();
                } else if (this.maskView.mode === "alone") {
                    const lx = vl.kind === "filter" ? 0 : vl.x;
                    const ly = vl.kind === "filter" ? 0 : vl.y;
                    const lw = vl.kind === "filter" ? this.width : vl.w;
                    const lh = vl.kind === "filter" ? this.height : vl.h;
                    ctx.save();
                    ctx.fillStyle = "#000000";
                    ctx.globalAlpha = 1;
                    ctx.globalCompositeOperation = "source-over";
                    ctx.fillRect(lx, ly, lw, lh);
                    ctx.restore();
                    const sc = this.passScratch("maskAlone", vw, vh);
                    const sctx = sc.getContext("2d");
                    sctx.save();
                    try {
                        sctx.setTransform(1, 0, 0, 1, 0, 0);
                        sctx.globalCompositeOperation = "source-over";
                        sctx.globalAlpha = 1;
                        sctx.clearRect(0, 0, vw, vh);
                        sctx.fillStyle = "#ffffff";
                        sctx.fillRect(0, 0, vw, vh);
                        sctx.globalCompositeOperation = "destination-in";
                        this.applyViewTransform(sctx);
                        if (tilt) this.applyTilt(sctx);
                        this.drawMaskInto(sctx, vl, s, region, true);
                    } finally {
                        sctx.restore();
                    }
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.globalCompositeOperation = "source-over";
                    ctx.globalAlpha = 1;
                    ctx.drawImage(sc, 0, 0);
                    ctx.restore();
                }
            }
        }

        if (this.getBounds()) {
            const [x, y, w, h] = this.cropRect();
            ctx.save();
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#4a90d9";
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
        }

        // reference layers: cyan frame with their batch index
        const refs = this.referenceLayers();
        if (refs.length) {
            ctx.save();
            ctx.lineWidth = 1.5 / s;
            ctx.strokeStyle = "#7cc7ff";
            ctx.fillStyle = "#7cc7ff";
            ctx.font = `${Math.max(11, 13 / s)}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            refs.forEach((l, i) => {
                ctx.setLineDash([5 / s, 3 / s]);
                ctx.strokeRect(l.x, l.y, l.w, l.h);
                ctx.setLineDash([]);
                const label = refBadge(i);
                const tw = ctx.measureText(label).width + 8 / s, th = Math.max(11, 13 / s) + 4 / s;
                ctx.globalAlpha = 0.85;
                ctx.fillRect(l.x, l.y, tw, th);
                ctx.globalAlpha = 1;
                ctx.fillStyle = "#10202c";
                ctx.fillText(label, l.x + 4 / s, l.y + 2 / s);
                ctx.fillStyle = "#7cc7ff";
            });
            ctx.restore();
        }
        const maskLayer = this.layers.find((l) => l.maskPx && l.maskEdit && this.shown(l));
        if (maskLayer) {
            ctx.save();
            ctx.lineWidth = 2 / s;
            ctx.strokeStyle = "#ff66cc";
            ctx.setLineDash([4 / s, 4 / s]);
            ctx.strokeRect(maskLayer.x, maskLayer.y, maskLayer.w, maskLayer.h);
            ctx.restore();
        }

        const active = this.activeLayer();
        const pend = this.pending;
        if (pend && pend.layer) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffb347";
            ctx.fillStyle = "#ffb347";
            const r = HANDLE_PX / s / 2;
            if (pend.mode === "rotate") {
                const l = pend.layer;
                const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
                ctx.translate(cx, cy); ctx.rotate(pend.angle); ctx.translate(-cx, -cy);
                ctx.strokeRect(l.x, l.y, l.w, l.h);
                const handles = this.layerHandles(l);
                for (const name of ["nw", "ne", "sw", "se"]) { const [hx, hy] = handles[name]; ctx.fillRect(hx - r, hy - r, r * 2, r * 2); }
                ctx.fillStyle = "#1e1e1e";
                for (const name of ["n", "s", "w", "e"]) { const [hx, hy] = handles[name]; ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            } else if (pend.mode === "distort") {
                ctx.beginPath();
                pend.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
                ctx.closePath();
                ctx.stroke();
                for (const [x, y] of pend.points) ctx.fillRect(x - r, y - r, r * 2, r * 2);
            } else if (pend.mode === "warp") {
                const n = pend.n;
                ctx.setLineDash([3 / s, 3 / s]);
                for (let j = 0; j <= n; j++) { ctx.beginPath(); for (let i = 0; i <= n; i++) { const [x, y] = pend.points[j * (n + 1) + i]; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
                for (let i = 0; i <= n; i++) { ctx.beginPath(); for (let j = 0; j <= n; j++) { const [x, y] = pend.points[j * (n + 1) + i]; j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
                ctx.setLineDash([]);
                for (const [x, y] of pend.points) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
            }
            ctx.restore();
        } else if (active && (this.tool === "transform" || this.tool === "paint" || this.tool === "erase")) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#ffb347";
            // a multi-selection: each selected layer's outline dashed, the handles on the box around all of them
            const group = this.tool === "transform" ? this.groupBox() : null;
            if (group) {
                ctx.setLineDash([4 / s, 4 / s]);
                for (const l of group.layers) ctx.strokeRect(l.x, l.y, l.w, l.h);
            }
            const box = group || active;
            ctx.setLineDash(this.tool === "transform" ? [] : [4 / s, 4 / s]);
            ctx.strokeRect(box.x, box.y, box.w, box.h);
            if (this.tool === "transform") {
                const r = HANDLE_PX / s / 2;
                ctx.fillStyle = "#ffb347";
                const handles = this.layerHandles(box);
                for (const name of ["nw", "ne", "sw", "se"]) { const [cx, cy] = handles[name]; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); }
                ctx.fillStyle = "#1e1e1e";
                for (const name of ["n", "s", "w", "e"]) { const [cx, cy] = handles[name]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
            }
            ctx.restore();
        }

        if (tilt) ctx.restore();
        if (this.tool === "canvas" && this.width) this.drawCanvasFrame(ctx);
        if (this.snapGuides && this.pointer && (this.pointer.kind === "move" || this.pointer.kind === "scale")) {
            ctx.save();
            ctx.strokeStyle = "#ff66cc";
            ctx.lineWidth = 1 / s;
            ctx.setLineDash([6 / s, 4 / s]);
            for (const gx of this.snapGuides.x) { ctx.beginPath(); ctx.moveTo(gx, -1e5); ctx.lineTo(gx, 1e5); ctx.stroke(); }
            for (const gy of this.snapGuides.y) { ctx.beginPath(); ctx.moveTo(-1e5, gy); ctx.lineTo(1e5, gy); ctx.stroke(); }
            ctx.restore();
        }

        const p = this.pointer;
        if (p && p.kind === "rect") {
            ctx.save();
            this.antsStroke(ctx, () => {
                if (p.ellipse) {
                    ctx.beginPath();
                    ctx.ellipse((p.start[0] + p.cur[0]) / 2, (p.start[1] + p.cur[1]) / 2, Math.abs(p.cur[0] - p.start[0]) / 2, Math.abs(p.cur[1] - p.start[1]) / 2, 0, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    ctx.strokeRect(p.start[0], p.start[1], p.cur[0] - p.start[0], p.cur[1] - p.start[1]);
                }
            }, s);
            ctx.restore();
        }
        if (p && p.kind === "object" && p.moved && p.startImg && p.curImg) {
            ctx.save();
            ctx.strokeStyle = "#4a90d9";
            ctx.lineWidth = 1.5 / s;
            ctx.setLineDash([6 / s, 4 / s]);
            ctx.strokeRect(p.startImg[0], p.startImg[1], p.curImg[0] - p.startImg[0], p.curImg[1] - p.startImg[1]);
            ctx.restore();
        }
        if (this.lassoPoints && this.lassoPoints.length > 1) {
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
                for (const [x, y] of this.lassoPoints) ctx.lineTo(x, y);
                ctx.stroke();
            }, s);
            ctx.restore();
        }
        if (this.polyPoints && this.polyPoints.length) {
            const pts = this.polyPoints;
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                if (this.hover) ctx.lineTo(this.hover[0], this.hover[1]);
                ctx.stroke();
            }, s);
            ctx.setLineDash([]);
            const r = 4 / s;
            ctx.fillStyle = "#fff";
            for (const [x, y] of pts) ctx.fillRect(x - r / 2, y - r / 2, r, r);
            // the first point is the closing target: a ring, larger when the cursor is within reach
            const closeNear = this.hover && pts.length >= 3 && Math.hypot(this.hover[0] - pts[0][0], this.hover[1] - pts[0][1]) <= 8 / s;
            ctx.strokeStyle = closeNear ? "#7cc7ff" : "#fff";
            ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], (closeNear ? 8 : 5) / s, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if (this.shapePoints && this.shapePoints.length) {
            const pts = this.shapePoints;
            const closed = this.shapeOpts.kind !== "polyline";
            ctx.save();
            this.antsStroke(ctx, () => {
                ctx.beginPath();
                this.shapePointPath(ctx, pts, false, this.hover && !this.shapeDrag ? this.hover : null);
                ctx.stroke();
            }, s);
            ctx.setLineDash([]);
            const r = 4 / s;
            ctx.fillStyle = "#fff";
            for (const q of pts) ctx.fillRect(q.x - r / 2, q.y - r / 2, r, r);
            if (this.shapeOpts.kind === "bezier") {
                ctx.strokeStyle = "#7cc7ff";
                ctx.lineWidth = 1 / s;
                for (const q of pts) {
                    if (!q.hx && !q.hy) continue;
                    ctx.beginPath();
                    ctx.moveTo(q.x - q.hx, q.y - q.hy); ctx.lineTo(q.x + q.hx, q.y + q.hy);
                    ctx.stroke();
                }
            }
            // the first point closes the shape: a ring, larger when the cursor is within reach
            const closeNear = closed && this.hover && pts.length >= 2 && Math.hypot(this.hover[0] - pts[0].x, this.hover[1] - pts[0].y) <= 8 / s;
            ctx.strokeStyle = closeNear ? "#7cc7ff" : "#fff";
            ctx.lineWidth = 1 / s;
            ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, (closeNear ? 8 : 5) / s, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if ((this.tool === "clone" || this.tool === "heal") && this.cloneSource) {
            // the source: a crosshair, and the point the brush copies from follows it: during a stroke at the stroke's
            // lining up, before one at the lining up the next press takes (the kept offset when Aligned, else the press)
            const o = this.cloneOpts || {}, pc = this.pointer && this.pointer.clone, hv = this.hover;
            const S = pc && pc.S ? pc.S : this.cloneSource, xf = pc ? pc.xf : this.cloneXf(o);
            const off = pc ? pc.off : (o.aligned && this.cloneOffset ? this.cloneOffset : null);
            const D = off ? { x: S.x - off.x, y: S.y - off.y } : hv ? { x: hv[0], y: hv[1] } : null;
            const q = hv && D ? (xf ? [S.x + xf.A[0] * (hv[0] - D.x) + xf.A[1] * (hv[1] - D.y), S.y + xf.A[2] * (hv[0] - D.x) + xf.A[3] * (hv[1] - D.y)] : [hv[0] + S.x - D.x, hv[1] + S.y - D.y]) : [S.x, S.y];
            if (o.overlay !== false && hv && D && !this.compare && !this.peekBase) this.drawCloneGhost(ctx, hv, D, S, xf, q);
            ctx.save();
            ctx.strokeStyle = "#7cc7ff";
            ctx.lineWidth = 1 / s;
            const cr = this.brushSize / 2 / (xf ? xf.k : 1), k = 6 / s;
            ctx.beginPath(); ctx.arc(q[0], q[1], cr, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(q[0] - k, q[1]); ctx.lineTo(q[0] + k, q[1]); ctx.moveTo(q[0], q[1] - k); ctx.lineTo(q[0], q[1] + k); ctx.stroke();
            ctx.restore();
        }
        if (p && p.stab && p.last && this.hover && (p.last[0] !== this.hover[0] || p.last[1] !== this.hover[1])) {
            // the stabiliser's string, from where the brush is to the cursor
            ctx.save();
            ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1 / s; ctx.setLineDash([4 / s, 3 / s]);
            ctx.beginPath(); ctx.moveTo(p.last[0], p.last[1]); ctx.lineTo(this.hover[0], this.hover[1]); ctx.stroke();
            ctx.restore();
        }
        if (!(p && p.kind === "pan") && !this.spaceDown) this.drawBrushRing(ctx, s);
    }
}
