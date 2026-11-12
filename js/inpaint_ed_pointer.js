// Generated from DenRakEiw/scumble renderer/editor/inpaint_ed_pointer.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// tools and keys, the brush size, pointer events and the polygon close: moved out of inpaint_canvas.js (item 56 S6, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { selModeOf, selectionGco } from "./inpaint_raster.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { LIGHT_MAX, defaultLight } from "./inpaint_relight.js";
import { BRUSH_MAX, CURSOR_CLASSES, REMOVE_MARK, RULER_PX, brushSizeToSlider } from "./inpaint_consts.js";
import { normDeg } from "./inpaint_orient.js";
import { StrokeBuffer } from "./inpaint_strokebuf.js";

export class PointerPart {
    /** Hardness of the tool in use: the eraser has its own, softer default. */
    activeHardness() {
        return this.tool === "erase" ? this.eraseHardness : this.hardness;
    }

    setTool(tool) {
        if (this.pending && tool !== "transform") this.cancelPending();
        if (this.polyPoints && tool !== "polygon") this.polyPoints = null;
        if (this.shapePoints && tool !== "shape") this.cancelShape();
        if (tool !== "liquify" && this.pointer && this.pointer.kind === "liquify") this.freeLiquifyWindow(this.pointer);
        if (this.liq && tool !== "liquify") this.endLiquify();
        const prevTool = this.tool;
        this.tool = tool;
        // the popover hangs from the tip thumbnail, which only the brushes show
        if (this.tipPicker && this.tipPicker.isOpen && !(this.tipLabel && (this.tipLabel.dataset.for || "").split(" ").includes(tool))) this.closeTipPicker();
        host.toolChanged(this, tool, prevTool);
        if (this.boxes && prevTool === "boxes" && tool !== "boxes") this.boxes.deselect();
        if (this.boxes && tool === "boxes" && prevTool !== "boxes") this.boxes.selected();
        if (this.hardCtl) {
            const v = Math.round(this.activeHardness() * 100);
            this.hardCtl.input.value = v;
            this.hardCtl.value.textContent = v + "%";
        }
        for (const [id, b] of Object.entries(this.toolButtons)) b.classList.toggle("ipc-active", id === tool);
        for (const g of this.toolGroups || []) { if (g.tools.includes(tool)) g.current = tool; this.refreshGroupButton(g); }
        this.viewEl.classList.toggle("ipc-pan", tool === "hand");
        this.viewEl.classList.toggle("ipc-move", tool === "transform");
        if (tool !== "transform" && tool !== "canvas") this.viewEl.classList.remove(...CURSOR_CLASSES);
        if (tool === "canvas") this.setStatus("Drag the frame's edges to crop or extend (8 px steps, Alt for single pixels), outside it to turn the picture, Ctrl+drag along a horizon to straighten. Enter or a double click applies, Esc resets.");
        this.syncFrameControls();
        if (tool === "text") this.setStatus("Click on the canvas to add a text layer; click a text layer to select it, drag to move it.");
        // (Shift+J reaches Patch through Remove, whose model line would stay otherwise)
        if (tool === "patch") this.setStatus("Lasso the spot (or select it), then drag the selection to where the picture is right; Mode Destination copies it there instead.");
        if (tool !== "object") { this.hoverObjectId = 0; this.hoverObjectCanvas = null; }
        if (tool === "remove" && prevTool !== "remove") this.warmRemove();
        if (tool === "liquify" && prevTool !== "liquify") this.setStatus("Liquify: push, grow, shrink or swirl the active layer with the brush; Restore brings it back. Every stroke is one undo step.");
        // Move fills the old place with LaMa: loaded while the user aims, as for Remove (Extend needs no model)
        if (tool === "contentmove" && prevTool !== "contentmove") {
            this.setStatus(this.moveOpts.mode === "extend" ? "Lasso what to copy (or select it), then drag it to where the copy should go." : "Lasso the object (or select it), then drag it: it blends in where you let go, and LaMa fills where it was.");
            if (this.moveOpts.mode === "move") this.warmRemove();
        }
        if (tool === "lights") {
            this.setStatus("Lights: drag a light to move it, Alt+drag for Close/Far, wheel for diffusion (Shift: intensity), H toggles handles. Click to add a light, Delete removes.");
        }
        if (prevTool === "lights" && tool !== "lights") {
            this.viewEl.style.cursor = "";
        }
        this.updateSubbar();
        this.updateOptsBar();
        this.drawAfterPaint();
    }

    /** Redraw after the next paint, so button states and cursors show before a heavy composite runs. */
    drawAfterPaint() {
        if (this._drawAfterPaint) return;
        this._drawAfterPaint = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { this._drawAfterPaint = false; this.draw(); }));
    }

    onKey(e) {
        const k = e.key.toLowerCase();
        // AltGr types [ ] \ { } @ on a German keyboard, and Chromium on Windows reports it as Ctrl+Alt: such a key is the
        // character it types, never a Ctrl shortcut (AltGr+8 moved the layer down instead of making the brush smaller)
        const altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
        const ctrl = (e.ctrlKey || e.metaKey) && !(altGr && e.altKey);   // Windows' AltGr is Ctrl+Alt; a real Ctrl with Linux's AltGr stays Ctrl
        if (e.key === "Escape") {
            e.preventDefault();
            if (this._pendingPick) {
                this._pendingPick = null;
                this._pendingPickTarget = null;
                if (this._pickResolve) { const r = this._pickResolve; this._pickResolve = null; r(null); }
                this.draw();
                this.setStatus("Pick cancelled.");
            } else if (this.rangePending) {
                this.cancelRange();
            } else if (this._rangeTint) {
                this.setRangePreview(null);
            } else if (this.pointer && this.pointer.kind === "liquify" && !this.pointer.healing) {
                const p = this.pointer;
                this.pointer = null;
                this.liquifyDrop(p, "Liquify cancelled.");
            } else if (this.pending) {
                this.cancelPending();
            } else if (this.tool === "lights" && this.isRelightActive()) {
                const l = this.activeLayer();
                if (l && l._selectedLightId) {
                    l._deselected = true;
                    l._selectedLightId = null;
                    this.renderLayers();
                    this.draw();
                    this.setStatus("Light deselected.");
                }
            } else if (this.boxes && this.boxes.key(e, k)) {
                // the Boxes tool let go of its box
            } else if (!host.pluginKey(this, e, k)) {
                host.onEscape(this);
            }
            return;
        }
        if (ctrl && e.key === "Enter") { e.preventDefault(); this.generate(); return; }
        if (e.key === "Enter" && this.pending) { e.preventDefault(); this.applyPending(); return; }
        if (e.key === "Enter" && this.polyPoints) { e.preventDefault(); this.closePolygon(); this.draw(); return; }
        if (e.key === "Enter" && this.shapePoints) { e.preventDefault(); this.finishShape(); return; }
        if (e.key === "Enter" && this.tool === "canvas") { e.preventDefault(); if (this.framePending()) this.applyFrame(); else this.setStatus("Drag the frame first: its edges crop or extend, outside it turns the picture."); return; }
        if ((e.key === "Backspace" || e.key === "Delete") && this.polyPoints) { e.preventDefault(); this.polyPoints.pop(); if (!this.polyPoints.length) this.polyPoints = null; this.draw(); return; }
        if ((e.key === "Backspace" || e.key === "Delete") && this.shapePoints) { e.preventDefault(); this.shapePoints.pop(); if (!this.shapePoints.length) this.shapePoints = null; this.draw(); return; }
        if (this.tool === "transform" && !this.pending && e.key.startsWith("Arrow")) {
            const l = this.activeLayer();
            if (l) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const group = this.groupBox();
                const moving = group ? group.layers : [l];
                if (group) this.pushUndo({ kind: "transforms", ids: moving.map((m) => m.id), label: "Nudge layers" });
                else this.pushUndo({ kind: "transform", id: l.id, label: "Nudge layer" });
                for (const m of moving) {
                    if (e.key === "ArrowLeft") m.x -= step; if (e.key === "ArrowRight") m.x += step;
                    if (e.key === "ArrowUp") m.y -= step; if (e.key === "ArrowDown") m.y += step;
                }
                this.uploaded.baseHash = null; this.uploaded.controlHash = null;
                this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
            }
            return;
        }
        if (this.tool === "lights" && this.isRelightActive() && e.key.startsWith("Arrow")) {
            const l = this.activeLayer();
            if (l && l.params && Array.isArray(l.params.lights) && l.params.lights.length > 0) {
                const selected = l._selectedLightId ? l.params.lights.find((item) => item && item.id === l._selectedLightId) : null;
                if (selected) {
                    e.preventDefault();
                    const step = e.shiftKey ? 10 : 1;
                    // a nudge burst is a step of its own: not a slider's `_undoPending` (its commit would push the same
                    // snapshot again), and a wheel burst still open ends first so the two steps stay in order
                    if (!l._nudgePending) {
                        if (typeof l._flushWheel === "function") l._flushWheel();
                        l._nudgePending = this.snapshot({ kind: "filter", id: l.id });
                    }
                    let dx = 0, dy = 0;
                    if (e.key === "ArrowLeft") dx = -step;
                    if (e.key === "ArrowRight") dx = step;
                    if (e.key === "ArrowUp") dy = -step;
                    if (e.key === "ArrowDown") dy = step;
                    selected.x += dx;
                    selected.y += dy;
                    if (selected.type === "spot" && Array.isArray(selected.aim)) {
                        selected.aim[0] += dx;
                        selected.aim[1] += dy;
                    }
                    this.filterPreview = l.id;
                    this.ensureRelightMaps(l, { quick: true });
                    this.markFilterChanged(l, { soon: true });
                    this.renderLayers();
                    this.draw();
                    if (l._nudgeRelightTimer) clearTimeout(l._nudgeRelightTimer);
                    const flushNudge = () => {
                        if (l._nudgeRelightTimer) { clearTimeout(l._nudgeRelightTimer); l._nudgeRelightTimer = null; }
                        l._flushNudge = null;
                        const snap = l._nudgePending;
                        l._nudgePending = null;
                        if (this.filterPreview === l.id) this.filterPreview = null;
                        if (!this.layers || !this.layers.includes(l)) return;   // the layer left the document (an undo replaced it)
                        if (snap) this.pushUndoSnapshot(snap, { label: "Move light", fromDebounce: true });
                        this.ensureRelightMaps(l, { quick: false });
                        this.markFilterChanged(l);
                        this.renderLayersUnlessEditing();
                        this.draw();
                    };
                    l._flushNudge = flushNudge;
                    l._nudgeRelightTimer = setTimeout(flushNudge, 300);
                }
            }
            return;
        }
        if (ctrl && e.shiftKey && k === "n") { e.preventDefault(); this.addPaintLayer(); return; }
        if (ctrl && e.shiftKey && k === "r") { e.preventDefault(); this.toggleRulers(); return; }
        // Ctrl+Alt+G by the key, not `ctrl`: Windows reports a real Ctrl+Alt as AltGr, which types nothing on G in the usual layouts
        if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === "KeyG") { e.preventDefault(); const l = this.activeLayer(); if (l) this.setLayerClip(l, !l.clip); else this.setStatus("Select a layer to clip."); return; }
        if (ctrl && e.shiftKey && k === "g") { e.preventDefault(); this.toggleGrid(); return; }
        if (ctrl && !e.shiftKey && !e.altKey && k === "g") { e.preventDefault(); this.groupLayersNow(); return; }
        if (ctrl && k === "j") { e.preventDefault(); this.duplicateLayer(); return; }
        if (ctrl && k === "e") { e.preventDefault(); if (this.multiSelected()) this.mergeSelected(); else this.mergeDown(); return; }
        if (ctrl && (e.key === "]" || e.key === "[")) {
            e.preventDefault();
            const l = this.activeLayer();
            // a reference steps past the next reference, as the list's up / down do
            if (l && host.refTokens && this.isReference(l)) this.moveReference(l, e.key === "]" ? +1 : -1);
            else if (l) this.moveLayer(l.id, e.key === "]" ? +1 : -1, { undo: true });
            return;
        }
        if (ctrl && k === "z") { e.preventDefault(); e.shiftKey ? this.redoStep() : this.undoStep(); return; }
        if (ctrl && k === "y") { e.preventDefault(); this.redoStep(); return; }
        if (ctrl && k === "d") { e.preventDefault(); this.clearSelection(); return; }
        if (ctrl && k === "u") { e.preventDefault(); this.upsamplePrompt(); return; }
        if (ctrl && k === "c") { e.preventDefault(); this.copySelection({ merged: e.shiftKey }); return; }
        if (ctrl && e.shiftKey && k === "x") { e.preventDefault(); this.setTool("liquify"); return; }
        if (ctrl && k === "x") { e.preventDefault(); this.copySelection({ cut: true }); return; }
        if (ctrl && k === "v") { e.preventDefault(); this.pasteClipboard(); return; }
        if (ctrl && k === "i") { e.preventDefault(); this.invertSelection(); return; }
        if (ctrl && k === "s") { e.preventDefault(); this.exportImage(); return; }
        if (ctrl || (e.altKey && !altGr)) return;
        if (e.shiftKey && k === "f") { this.fillSelection(); return; }
        if (e.shiftKey && k === "l") { this.setTool("polygon"); return; }
        if (e.shiftKey && k === "r") { this.setTool("ellipse"); return; }
        if (e.shiftKey && k === "t") { this.setTool("text"); return; }
        if (e.key === "\\") { e.preventDefault(); if (!e.repeat && !this.peekBase) { this.peekBase = true; this.peekHold = true; this.peekCode = e.code || null; this.draw(); } return; }
        // the Canvas tool's own X before the plugins' keys (the Boxes tool is X)
        if (k === "x" && this.tool === "canvas") { this.swapFrameAspect(); this.setStatus(this.frameStatus()); return; }
        // the editor's own Boxes tool (the node): X picks it, and its keys come before the editor's (D, Delete, arrows)
        if (this.boxes && this.boxes.key(e, k)) return;
        if (host.pluginKey(this, e, k)) return;
        switch (k) {
            case "1": this.zoomTo(1); break;
            case "4": this.rotateView(-Math.PI / 12); break;
            case "6": this.rotateView(Math.PI / 12); break;
            case "5": if (this.view.angle) this.rotateView(-this.view.angle); break;
            case "b": this.setTool("select"); break;
            case "r": this.setTool("rect"); break;
            case "l":
                if (this.isRelightActive()) {
                    this.setTool("lights");
                } else {
                    this.setTool("lasso");
                }
                break;
            case "o": this.setTool(e.shiftKey ? "tone" : "object"); break;
            case "d": this.setTool("deselect"); break;
            case "p": this.setTool("paint"); break;
            case "e": this.setTool("erase"); break;
            case "t": this.setTool("transform"); break;
            case "h":
                if (this.tool === "lights" && this.isRelightActive()) {
                    this.hideLightHandles = !this.hideLightHandles;
                    this.draw();
                    this.renderLayers();
                    this.setStatus(this.hideLightHandles ? "Light handles hidden (press H to show)." : "Light handles visible (press H to hide).");
                    break;
                }
                this.setTool("hand");
                break;
            case "c": this.setTool("canvas"); break;
            case "i": this.setTool("eyedropper"); break;
            case "w": this.setTool(e.shiftKey ? "liquify" : "wand"); break;
            case "y": this.setTool("shape"); break;
            case "q": this.toggleQuickMask(); break;
            case "s": this.setTool(e.shiftKey ? "smudge" : "clone"); break;
            case "j": {
                // J heals; Shift+J goes round Remove, Patch and Content-aware move (Photoshop's J group), from any other
                // tool to the first
                if (!e.shiftKey) { this.setTool("heal"); break; }
                const ring = host.removeSupported ? ["remove", "patch", "contentmove"] : ["patch"];
                this.setTool(ring[(ring.indexOf(this.tool) + 1) % ring.length]);
                break;
            }
            case "g": this.setTool(e.shiftKey ? "gradient" : "bucket"); break;
            case "f": this.fitView(); break;
            case "delete": case "backspace": {
                if (this.tool === "lights" && this.isRelightActive()) {
                    const l = this.activeLayer();
                    if (l && l.params && Array.isArray(l.params.lights) && l.params.lights.length > 0) {
                        const selId = l._selectedLightId;
                        const idx = l.params.lights.findIndex((item) => item && item.id === selId);
                        if (idx >= 0) {
                            this.pushUndo({ kind: "filter", id: l.id, label: "Delete light" });
                            l.params.lights.splice(idx, 1);
                            l._selectedLightId = l.params.lights.length > 0 ? l.params.lights[Math.min(idx, l.params.lights.length - 1)].id : null;
                            this.ensureRelightMaps(l, { quick: false });
                            this.markFilterChanged(l);
                            this.renderLayers();
                            this.draw();
                        }
                    }
                    break;
                }
                // with a selection: clear the selected pixels of the active layer (Krita / Photoshop); without: delete the layer
                if (this.getBounds()) { this.clearSelectedPixels(); break; }
                if (this.multiSelected()) { this.removeLayers(this.selectedLayers().map((l) => l.id)); break; }
                const l = this.activeLayer(); if (l) this.removeLayer(l.id); break;
            }
            case "[": this.setBrushSize(Math.round(this.brushSize / 1.2)); break;
            case "]": this.setBrushSize(Math.round(this.brushSize * 1.2)); break;
            case " ":
                if (!this.spaceDown) {
                    this.spaceDown = true;
                    this.viewEl.classList.add("ipc-pan");
                    const up = (ev) => {
                        if (ev.key === " ") {
                            this.spaceDown = false;
                            this.viewEl.classList.toggle("ipc-pan", this.tool === "hand");
                            window.removeEventListener("keyup", up, true);
                        }
                    };
                    window.addEventListener("keyup", up, true);
                }
                e.preventDefault();
                break;
        }
    }

    setBrushSize(v) {
        this.brushSize = Math.min(BRUSH_MAX, Math.max(2, Math.round(v)));
        this.sizeCtl.input.value = brushSizeToSlider(this.brushSize);
        this.sizeCtl.value.textContent = this.brushSize + "px";
        this.drawSoon();
    }

    // ---- pointer gestures --------------------------------------------------

    onPointerDown(e) {
        this.root.focus({ preventScroll: true });
        if (!this.width) return;
        // a heal stroke is held until its blend lands (`healBlend`): the next gesture waits for it
        if (this.pointer && this.pointer.healing) { this.setStatus(this.heldWord(this.pointer)); return; }
        if (this.pointer && this.pointer.kind === "liquify") { const p = this.pointer; this.pointer = null; this.liquifyDrop(p, null); }
        // Chrome reports detail = 0 on pointer events, so double-clicks are detected here:
        // a second press within 400 ms and 8 css px of the previous one.
        const nowMs = performance.now();
        const [dcx, dcy] = this.toCanvasPx(e);
        const last = this._lastDown;
        const isDouble = !!(last && nowMs - last.t < 400 && last.button === e.button && Math.hypot(dcx - last.x, dcy - last.y) < 8 * (window.devicePixelRatio || 1));
        this._lastDown = isDouble ? null : { t: nowMs, x: dcx, y: dcy, button: e.button };
        const pan = e.button === 1 || e.button === 2 || this.spaceDown || this.tool === "hand";
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const [cx, cy] = this.toCanvasPx(e);
        if (pan) {
            this.pointer = { kind: "pan", startX: cx, startY: cy, vx: this.view.x, vy: this.view.y };
            this.viewEl.classList.add("ipc-panning");
            return;
        }
        if (e.button !== 0) return;
        const [ix, iy] = this.toImage(e);
        if (this._pendingPick) {
            this.handlePickOnce(this._pendingPick, ix, iy);
            return;
        }
        if (this.boxes && this.boxes.pointer("down", e, ix, iy)) return;
        if (host.pluginPointer(this, "down", e, ix, iy)) return;
        if (this.base) {
            const [cx, cy] = this.toCanvasPx(e);
            const dpr = window.devicePixelRatio || 1;
            if (this.compare && Math.abs(cx - this.canvas.width * (this.compare.split ?? 0.5)) <= 6 * dpr) {
                this.pointer = { kind: "split" };
                return;
            }
            if (this.showRulers) {
                const rp = RULER_PX * dpr;
                if (cx < rp || cy < rp) {
                    if ((e.detail >= 2 || isDouble)) { this.guides = { x: [], y: [] }; this.draw(); this.notifyChanged(); this.setStatus("Guides cleared."); return; }
                    this.pointer = { kind: "guide", axis: cy < rp ? "y" : "x", index: -1, pos: null };
                    return;
                }
                const g = this.guideAt(cx, cy);
                if (g && this.tool !== "hand") { this.pointer = { kind: "guide", axis: g.axis, index: g.index, pos: this.guides[g.axis][g.index] }; return; }
            }
        }
        if (e.ctrlKey && !e.altKey && !e.shiftKey && !this.quickMask && ["transform", "paint", "erase", "text"].includes(this.tool)) {
            // Ctrl+click: the topmost layer with a visible pixel under the cursor becomes active (Photoshop's auto-select)
            const l = this.pickLayerAt(ix, iy);
            if (this.pending) this.cancelPending();
            this.activeLayerId = l ? l.id : null;
            this.renderLayers(); this.updateSubbar(); this.draw();
            this.setStatus(l ? `${l.name} selected.` : "Base selected.");
            return;
        }

        // Krita / Photoshop modifiers: Shift adds, Alt subtracts, Shift+Alt intersects; rectangle and lasso replace otherwise.
        const selMode = selModeOf(e);
        if (this.tool === "select" || this.tool === "deselect") {
            this.pushUndo({ kind: "selection", label: this.tool === "deselect" ? "Deselect brush" : "Selection brush" });
            this.pointer = { kind: "selpaint", last: [ix, iy], path: [[ix, iy]], subtract: this.tool === "deselect" || e.altKey };
            this.selectionDab(ix, iy, ix, iy);
        } else if (this.tool === "wand") {
            this.wandSelect(ix, iy, selMode);
            return;
        } else if (this.tool === "rect" || this.tool === "ellipse") {
            const moveSel = selMode === "replace" && !e.ctrlKey && this.selectedAt(ix, iy);
            this.pushUndo({ kind: "selection", label: moveSel ? "Move selection" : this.tool === "ellipse" ? "Ellipse selection" : "Rectangle selection" });
            if (moveSel) {
                // dragging inside the selection moves its outline (Photoshop's marquee tools)
                const orig = this.sel.clone();   // the outline as it was, drawn back offset while dragging
                // every pixel with any alpha lies in `ext` (exact: an approximate extent left faint pixels
                // behind or erased them): a move rewrites the old and the new place of it only, never the
                // whole selection on tiles (a full-size scratch per pointer move); the canvas backend rewrites
                // the whole image (its extent is all of it)
                const ext = this.selectionExtent({ exact: true });
                this.pointer = { kind: "selmove", start: [ix, iy], orig, origBounds: this.getBounds(), ext, lastExt: ext };
            } else {
                this.pointer = { kind: "rect", ellipse: this.tool === "ellipse", square: e.ctrlKey, start: [ix, iy], cur: [ix, iy], startPx: this.toCanvasPx(e), mode: selMode };
            }
        } else if (this.tool === "lasso" || this.tool === "patch" || this.tool === "contentmove") {
            // patch and the content-aware move drag the selection when pressed inside it (the marquee's rule) and draw a
            // lasso elsewhere
            if (this.tool !== "lasso" && selMode === "replace" && !e.ctrlKey && this.selectedAt(ix, iy)) this.patchPress(e, ix, iy);
            else {
                this.pushUndo({ kind: "selection", label: "Lasso selection" });
                this.pointer = { kind: "lasso", mode: selMode };
                this.lassoPoints = [[ix, iy]];
            }
        } else if (this.tool === "polygon") {
            if (!this.polyPoints) {
                this.polyPoints = [[ix, iy]];
                this.polyMode = selMode;
            } else {
                const [fx, fy] = this.polyPoints[0];
                const near = Math.hypot(ix - fx, iy - fy) <= 8 / this.view.scale;
                if ((near && this.polyPoints.length >= 3) || (e.detail >= 2 || isDouble)) { this.closePolygon(); this.draw(); return; }
                this.polyPoints.push([ix, iy]);
            }
            this.draw();
            return;
        } else if (this.tool === "object") {
            this.pointer = { kind: "object", start: [cx, cy], startImg: [ix, iy], curImg: [ix, iy], moved: false, mode: selModeOf(e, "add"), shift: e.shiftKey, alt: e.altKey };
        } else if (this.tool === "eyedropper" || (this.tool === "paint" && e.altKey)) {
            this.pickColor(ix, iy);
            return;
        } else if (this.tool === "bucket") {
            if (this.quickMask) this.wandSelect(ix, iy, selMode); else this.bucketFill(ix, iy);
            return;
        } else if (this.tool === "smudge" || this.tool === "tone") {
            // the tone brush (dodge / burn / sponge, PLAN_0_1_31 §4 step 9) rides the smudge's engine as blur and sharpen do
            const toneTool = this.tool === "tone", opts = toneTool ? this.toneOpts : this.smudgeOpts;
            let layer = this.activeLayer();
            if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            if (layer && layer.kind === "filter") { this.setStatus(`Filter layers have no pixels to ${toneTool ? "dodge or burn" : "smudge"}.`); return; }
            // the mask or the selection is what the UI says is being edited; these brushes only work on pixels
            if (this.quickMask || (layer && layer.maskEdit)) { this.setStatus(`${this.quickMask ? "Quick mask is on" : `The mask of ${layer.name} is being edited`}: the ${toneTool ? "dodge / burn brush" : "smudge"} works on pixels. ${this.quickMask ? "Press Q to leave it." : "Switch the mask edit off first."}`); return; }
            const so = opts && opts.sample;
            let sample = so === "image" ? "all" : so === "below" ? "below" : "layer";
            if (!layer) {
                // the base is never written: the smudge takes the picture and paints into a new layer (a whole copy of the
                // base as a layer took 1.9 s and held 1.1 GB of mirrors at 15000 x 10000, PLAN_0_1_31 §4 step 1)
                layer = this.addPaintLayer();
                sample = "all";
                // and the strokes after it on that new layer take the picture too, not the layer's own few pixels
                if (opts) opts.sample = "image";
                const sel = toneTool ? this.toneSampleSel : this.smudgeSampleSel;
                if (sel) sel.value = "image";
                this.setStatus(`The base cannot be edited directly: the ${toneTool ? "brush" : "smudge"} paints into a new layer from the picture (Sample: image).`);
            }
            // the tone brush's curve is fixed for the stroke; Alt swaps dodge and burn (Photoshop's habit)
            const tone = toneTool ? this.toneStroke(e.altKey) : null;
            const mode = tone ? "tone" : this.smudgeOpts && this.smudgeOpts.mode;
            this.pushUndo({ kind: "layer", id: layer.id, label: tone ? tone.label : mode === "blur" ? "Blur" : mode === "sharpen" ? "Sharpen" : "Smudge" });
            // chosen before the gesture starts: a read during it must see the picture as if no gesture ran (brushSource)
            // blur and sharpen filter the picture of the press, not what the stroke has already done to it: every dab moves
            // the pixels towards one result, which the strength reaches where the brush passes often (filtering the live
            // pixels compounded: eight overlapping dabs of a sharpen rang between black and white)
            // (dodge and burn too: the stroke reaches its curve and does not build up over itself, GIMP's default)
            const fx = mode === "blur" || mode === "sharpen" || mode === "tone";
            const src = sample === "layer" ? null : this.brushSource(sample, layer, { snapshot: fx });
            const orig = fx && sample === "layer" ? layer.px.clone() : null;
            const pressure = this.pressureOf(e);
            this.pointer = { kind: "smudge", layer, src, orig, tone, last: [ix, iy], clip: this.strokeClip(layer, layer.px), pressure, stab: this.newStabiliser(ix, iy, pressure) };
            // blur, sharpen and the tone brush dab where they are pressed, so a click lightens a spot (GIMP, Photoshop);
            // the smudge only picks up there, at its first move
            if (fx) this.smudgeDab(this.pointer, ix, iy, ix, iy);
        } else if (this.tool === "clone" || this.tool === "heal") {
            if (e.altKey) {
                this.cloneSource = { x: ix, y: iy };
                this.cloneOffset = null;
                this.updateOptsBar();
                this.setStatus("Source set. Paint to copy from there; Alt+click moves the source.");
                this.draw();
                return;
            }
            if (!this.cloneSource) { this.setStatus("Alt+click to set the source point first."); return; }
            let layer = this.activeLayer();
            if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Select a paint or image layer."); return; }
            // they paint the layer's pixels, never the mask or the selection the UI says is being edited (the smudge's rule)
            if (this.quickMask || (layer && layer.maskEdit)) { this.setStatus(`${this.quickMask ? "Quick mask is on" : `The mask of ${layer.name} is being edited`}: the ${this.tool === "heal" ? "healing brush" : "clone brush"} works on pixels. ${this.quickMask ? "Press Q to leave it." : "Switch the mask edit off first."}`); return; }
            if (!layer) layer = this.addPaintLayer();
            const o = this.cloneOpts || { sample: "image", aligned: true };
            if (!o.aligned || !this.cloneOffset) this.cloneOffset = { x: this.cloneSource.x - ix, y: this.cloneSource.y - iy };
            const heal = this.tool === "heal";
            // where the dabs read, chosen before the gesture starts (PLAN_0_1_31 §4 step 2): a box per move, not a flatten of
            // the whole picture at every press (0.5 to 1.7 s at 15000 x 10000); heal also reads the picture under the dab
            const sample = o.sample === "layer" ? "layer" : "all";
            const src = this.brushSource(sample, layer);
            const dest = heal ? (sample === "all" ? src : this.brushSource("all", layer)) : null;
            const stroke = new StrokeBuffer(layer.px, this.pixels);
            const pressure = this.pressureOf(e);
            this.pointer = { kind: "layerpaint", layer, stroke, clip: this.strokeClip(layer, layer.px), erase: false, last: [ix, iy], pressure, stab: this.newStabiliser(ix, iy, pressure),
                clone: { src, dest, off: this.cloneOffset, heal, S: { x: this.cloneSource.x, y: this.cloneSource.y }, xf: this.cloneXf(o) } };
            this.cloneDab(this.pointer, ix, iy, ix, iy);
        } else if (this.tool === "remove") {
            // the stroke marks the hole (REMOVE_MARK, shown half transparent); the fill lands at the release (`removeRun`)
            let layer = this.activeLayer();
            if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Select a paint or image layer."); return; }
            if (this.quickMask || (layer && layer.maskEdit)) { this.setStatus(`${this.quickMask ? "Quick mask is on" : `The mask of ${layer.name} is being edited`}: Remove works on pixels. ${this.quickMask ? "Press Q to leave it." : "Switch the mask edit off first."}`); return; }
            if (!host.removeModel()) { this.setStatus("Remove needs the LaMa model: download it in Settings › Helpers (in-app models).", "warn"); return; }
            if (layer && (layer.px.width !== layer.w || layer.px.height !== layer.h || layer.x !== Math.round(layer.x) || layer.y !== Math.round(layer.y))) {
                this.setStatus(`Remove paints into a layer at its own size on whole pixels, and ${layer.name} is scaled or placed between pixels: pick another layer, or the base (Remove then paints into a new layer).`);
                return;
            }
            // on the base the fill goes into a new layer and is taken from the image (the new layer has nothing to take); the
            // option goes back to image, or the next stroke, on that layer, would take the layer alone (the smudge's rule)
            const made = !layer;
            if (made) {
                layer = this.addPaintLayer();
                if (this.removeOpts) this.removeOpts.sample = "image";
                if (this.removeSampleSel) this.removeSampleSel.value = "image";
            }
            const sample = !made && (this.removeOpts || {}).sample === "layer" ? "layer" : "all";
            const stroke = new StrokeBuffer(layer.px, this.pixels);
            const pressure = this.pressureOf(e);
            this.pointer = { kind: "layerpaint", layer, stroke, clip: this.strokeClip(layer, layer.px), erase: false, last: [ix, iy], pressure, stab: this.newStabiliser(ix, iy, pressure),
                remove: { src: this.brushSource(sample, layer), sample, made }, dabColor: REMOVE_MARK, previewAlpha: 0.5, opacity: 1 };
            this.layerDab(this.pointer, ix, iy, ix, iy);
        } else if (this.tool === "liquify") {
            this.liquifyPress(e, ix, iy);
        } else if (this.tool === "gradient") {
            let layer = this.activeLayer();
            if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Select a paint or image layer."); return; }
            if (!layer) layer = this.addPaintLayer();
            // a gradient rebuilds its whole buffer on every move, so it keeps the canvas buffer on
            // both backends: a sparse store would allocate every tile of the target and read a
            // scratch of the whole layer back per move (docs/PLAN_BCE.md §C5)
            const stroke = new StrokeBuffer(layer.px);
            this.pointer = { kind: "layerpaint", grad: true, layer, stroke, clip: this.strokeClip(layer, layer.px), erase: false, start: [ix, iy], last: [ix, iy] };
        } else if (this.tool === "shape") {
            this.shapePointerDown(ix, iy, e, isDouble);
        } else if ((this.tool === "paint" || this.tool === "erase") && this.quickMask) {
            // quick mask: the brushes edit the selection
            this.pushUndo({ kind: "selection", label: this.tool === "erase" ? "Quick mask erase" : "Quick mask paint" });
            this.pointer = { kind: "selpaint", last: [ix, iy], path: [[ix, iy]], subtract: this.tool === "erase" || e.altKey };
            this.selectionDab(ix, iy, ix, iy);
        } else if (this.tool === "paint" || this.tool === "erase") {
            let layer = this.activeLayer();
            if (layer && this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            const pressure = this.pressureOf(e);
            // Shift+click: a straight line from where the last stroke on this layer ended
            const prev = this.lastStrokeEnd;
            const lineFrom = e.shiftKey && prev && layer && prev.layerId === layer.id ? [prev.x, prev.y] : null;
            if (layer && layer.alphaLock && this.tool === "erase" && !(layer.maskPx && layer.maskEdit)) { this.setStatus(`${layer.name} has its alpha locked: nothing to erase. Unlock alpha first.`); return; }
            if (layer && layer.maskPx && layer.maskEdit) {
                // Painting on the transparency mask: paint reveals, erase hides.
                const stroke = new StrokeBuffer(layer.maskPx, this.pixels);
                this.pointer = { kind: "maskpaint", layer, stroke, clip: this.strokeClip(layer, layer.maskPx), erase: this.tool === "erase", white: true, last: [ix, iy], pressure, flow: this.brushFlow, stab: this.newStabiliser(ix, iy, pressure) };
                if (lineFrom && prev.mask) this.layerDab(this.pointer, lineFrom[0], lineFrom[1], ix, iy); else this.layerDab(this.pointer, ix, iy, ix, iy);
                this.draw();
                return;
            }
            if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Add a mask (from selection) and enable mask editing to limit where the filter applies."); return; }
            if (!layer) {
                if (this.tool === "erase") { this.setStatus("The base layer cannot be erased. Select a layer or add a paint layer."); return; }
                layer = this.addPaintLayer();
            }
            const stroke = new StrokeBuffer(layer.px, this.pixels);
            this.pointer = { kind: "layerpaint", layer, stroke, clip: this.strokeClip(layer, layer.px), erase: this.tool === "erase", last: [ix, iy], pressure, flow: this.brushFlow, stab: this.newStabiliser(ix, iy, pressure) };
            if (lineFrom && !prev.mask) this.layerDab(this.pointer, lineFrom[0], lineFrom[1], ix, iy); else this.layerDab(this.pointer, ix, iy, ix, iy);
        } else if (this.tool === "transform") {
            const layer = this.activeLayer();
            if (!layer) { this.setStatus("Select a layer to move or scale it. The base stays put."); return; }
            const group = !this.pending && this.groupBox();
            if (group) {
                // several layers selected: they move and scale as one box (filter and locked layers stay put)
                const { layers, ...box } = group;
                const handle = this.handleAt(ix, iy);
                this.pushUndo({ kind: "transforms", ids: layers.map((l) => l.id), label: handle ? "Scale layers" : "Move layers" });
                const members = layers.map((l) => ({ layer: l, x: l.x, y: l.y, w: l.w, h: l.h }));
                this.pointer = { kind: handle ? "scale" : "move", layer: { ...box }, group: members, handle, start: [ix, iy], orig: { ...box }, keepAspect: !!handle && handle.length === 2 && !e.shiftKey };
                this.draw();
                return;
            }
            if (this.multiSelected()) { this.setStatus("All selected layers are locked or filter layers: nothing to move."); return; }
            if (layer.kind === "filter") { this.setStatus("Filter layers cover the whole canvas and cannot be transformed."); return; }
            if (this.isLocked(layer)) { this.setStatus(`${layer.name} is locked.`); return; }
            if (this.pending) { this.pendingPointerDown(ix, iy, e); this.draw(); return; }
            const handle = this.handleAt(ix, iy);
            if (!handle && this.rotateZoneAt(layer, ix, iy)) {
                // just outside a corner: start rotating right away; the rotation stays pending until Enter
                this.startPending("rotate");
                if (this.pending) this.pendingPointerDown(ix, iy, e);
                this.draw();
                return;
            }
            this.pushUndo({ kind: "transform", id: layer.id, label: handle ? "Scale" : "Move layer" });
            if (handle) {
                const corner = handle.length === 2;
                this.pointer = { kind: "scale", layer, handle, start: [ix, iy], orig: { x: layer.x, y: layer.y, w: layer.w, h: layer.h }, keepAspect: corner && !e.shiftKey };
            } else {
                this.pointer = { kind: "move", layer, start: [ix, iy], orig: { x: layer.x, y: layer.y } };
            }
        } else if (this.tool === "text") {
            const hit = [...this.layers].reverse().find((l) => l.kind === "text" && this.shown(l) && this.textHitAt(l, ix, iy));
            if (hit) {
                this.activeLayerId = hit.id;
                this.renderLayers();
                if ((e.detail >= 2 || isDouble) && !this.isLocked(hit)) { e.preventDefault(); this.beginTextEdit(hit); this.draw(); return; }
                if (this.isLocked(hit)) { this.setStatus(`${hit.name} is locked.`); this.draw(); return; }
                this.pushUndo({ kind: "transform", id: hit.id, label: "Move layer" });
                this.pointer = { kind: "move", layer: hit, start: [ix, iy], orig: { x: hit.x, y: hit.y } };
            } else {
                this.addTextLayer(ix, iy);
            }
        } else if (this.tool === "canvas") {
            if (!this.base) return;
            // the frame's gestures (PLAN_0_1_31 §7, 23b): nothing is applied on release
            const f = this.frameOrCanvas();
            if (this.frameStraighten || e.ctrlKey || e.metaKey) {
                this.pointer = { kind: "straighten", start: [ix, iy], cur: [ix, iy], orig: { ...f } };
                this.draw();
                return;
            }
            const handle = this.canvasHandleAt(ix, iy);
            const inside = ix >= f.x && ix <= f.x + f.w && iy >= f.y && iy <= f.y + f.h;
            if (!handle && inside && (e.detail >= 2 || isDouble) && this.framePending()) { this.applyFrame(); return; }
            if (handle) this.pointer = { kind: "frame", handle, start: [ix, iy], orig: { ...f } };
            else if (inside) this.pointer = { kind: "framemove", start: [ix, iy], orig: { ...f } };
            else this.pointer = { kind: "framerotate", start: [ix, iy], orig: { ...f }, a0: Math.atan2(iy - this.height / 2, ix - this.width / 2) };
        } else if (this.tool === "lights") {
            if (!this.isRelightActive()) return;
            const layer = this.activeLayer();
            if (!layer) return;
            layer.params = layer.params || {};
            if (!Array.isArray(layer.params.lights)) layer.params.lights = [];
            const hit = this.hitLight(layer, ix, iy);
            if (hit && hit.mode === "aim") {
                layer._deselected = false;
                layer._selectedLightId = hit.light.id;
                this.renderLayers();
                this.pointer = {
                    kind: "relight",
                    mode: "aim",
                    layer,
                    light: hit.light,
                    startX: ix,
                    startY: iy,
                    startAx: hit.light.aim[0],
                    startAy: hit.light.aim[1],
                    undoLabel: "Move light aim",
                    hasPushedUndo: false,
                    moved: false,
                };
            } else if (hit && hit.mode === "light") {
                layer._deselected = false;
                layer._selectedLightId = hit.light.id;
                this.renderLayers();
                if ((e.detail >= 2 || isDouble)) {
                    if (e.preventDefault) e.preventDefault();
                    const kelvinSel = this.layerList?.querySelector(".ipc-relight-kelvin-sel");
                    if (kelvinSel) kelvinSel.focus();
                    this.draw();
                    return;
                }
                if (e.altKey) {
                    this.pointer = {
                        kind: "relight",
                        mode: "dist",
                        layer,
                        light: hit.light,
                        startX: ix,
                        startY: iy,
                        startDist: hit.light.dist != null ? hit.light.dist : -30,
                        undoLabel: "Relight: Close/Far",
                        hasPushedUndo: false,
                        moved: false,
                    };
                } else {
                    const startAim = hit.light.aim ? [hit.light.aim[0], hit.light.aim[1]] : null;
                    this.pointer = {
                        kind: "relight",
                        mode: "move",
                        layer,
                        light: hit.light,
                        startX: ix,
                        startY: iy,
                        startLx: hit.light.x,
                        startLy: hit.light.y,
                        startAim,
                        undoLabel: "Move light",
                        hasPushedUndo: false,
                        moved: false,
                    };
                }
            } else if (hit && hit.mode === "own_light") {
                if (layer.params.lights.length < LIGHT_MAX) {
                    this.pushUndo({ kind: "filter", id: layer.id, label: "Add light" });
                    let n = 1;
                    while (layer.params.lights.some((l) => l && l.id === `light_${n}`)) n++;
                    const nl = defaultLight(n - 1, { width: this.width, height: this.height });
                    nl.id = `light_${n}`;
                    nl.x = Math.round(hit.pos[0]);
                    nl.y = Math.round(hit.pos[1]);
                    nl.aim = [Math.round(hit.pos[0]), Math.round(hit.pos[1] + 100)];
                    layer.params.lights.push(nl);
                    layer._deselected = false;
                    layer._selectedLightId = nl.id;
                    this.ensureRelightMaps(layer, { quick: false });
                    this.markFilterChanged(layer);
                    this.renderLayers();
                    this.draw();
                }
            } else {
                if (layer.params.lights.length < LIGHT_MAX) {
                    this.pushUndo({ kind: "filter", id: layer.id, label: "Add light" });
                    let n = 1;
                    while (layer.params.lights.some((l) => l && l.id === `light_${n}`)) n++;
                    const nl = defaultLight(n - 1, { width: this.width, height: this.height });
                    nl.id = `light_${n}`;
                    nl.x = Math.round(ix);
                    nl.y = Math.round(iy);
                    nl.aim = [Math.round(ix), Math.round(iy + 100)];
                    layer.params.lights.push(nl);
                    layer._deselected = false;
                    layer._selectedLightId = nl.id;
                    this.ensureRelightMaps(layer, { quick: false });
                    this.markFilterChanged(layer);
                    this.renderLayers();
                    this.draw();
                } else {
                    layer._deselected = true;
                    layer._selectedLightId = null;
                    this.renderLayers();
                    this.draw();
                }
            }
        }
        this.draw();
    }

    onPointerMove(e) {
        if (!this.width) return;
        const [ix, iy] = this.toImage(e);
        this.hover = [ix, iy];
        if (this.boxes && this.boxes.pointer("move", e, ix, iy)) return;
        if (host.pluginPointer(this, "move", e, ix, iy)) return;
        const p = this.pointer;
        if (!p || p.healing) {
            if (p) { this.drawSoon(); return; }
            if (this.tool === "transform") this.updateTransformCursor(ix, iy);
            if (this.tool === "canvas") this.updateCanvasCursor(ix, iy);
            if (this.tool === "object") this.updateObjectHover(ix, iy);
            if (this.tool === "lights") this.updateLightsCursor(ix, iy);
            this.drawSoon();
            return;
        }
        if (p.kind === "pan") {
            const [cx, cy] = this.toCanvasPx(e);
            this.view.x = p.vx + (cx - p.startX);
            this.view.y = p.vy + (cy - p.startY);
            this._fitted = false;
        } else if (p.kind === "selpaint") {
            this.selectionDab(p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
            p.path.push([ix, iy]);
        } else if (p.kind === "layerpaint" || p.kind === "maskpaint") {
            if (p.shape || p.grad) {
                if (e.pointerType === "pen" && e.pressure > 0) p.pressure = this.pressureOf(e);
                if (p.shape) this.shapeDab(p, ix, iy, e); else this.gradientDab(p, ix, iy);
                p.last = [ix, iy];
            } else {
                // all the move's points in one box and one run of dabs (docs/BUGS.md, the eraser of 0.1.32)
                const pts = this.strokePoints(p, e);
                if (pts.length) {
                    if (p.clone) this.cloneStroke(p, p.last[0], p.last[1], pts); else this.layerStroke(p, p.last[0], p.last[1], pts);
                    const q = pts[pts.length - 1];
                    p.last = [q[0], q[1]];
                    p.pressure = q[2];
                }
            }
        } else if (p.kind === "shapepoint") {
            // a Bezier point curves the line by dragging its handle out of the click
            if (this.shapeDrag && this.shapePoints) {
                const q = this.shapePoints[this.shapeDrag.index];
                if (q) { q.hx = ix - q.x; q.hy = iy - q.y; }
            }
        } else if (p.kind === "liquify") {
            try { this.liquifyMove(p, this.strokePoints(p, e)); }
            catch (err) { if (this.pointer === p) this.pointer = null; this.liquifyDrop(p, null); throw err; }
        } else if (p.kind === "smudge") {
            for (const [x, y, pr] of this.strokePoints(p, e)) {
                p.pressure = pr;
                this.smudgeDab(p, p.last[0], p.last[1], x, y);
                p.last = [x, y];
            }
        } else if (p.kind === "rect") {
            if (p.startPx) {
                // in screen pixels, so it is the same gesture at every zoom: on a large image
                // one screen pixel is many image pixels
                const [cx, cy] = this.toCanvasPx(e);
                if (Math.hypot(cx - p.startPx[0], cy - p.startPx[1]) > 3) p.moved = true;
            }
            if (p.square || e.ctrlKey) {
                const dx = ix - p.start[0], dy = iy - p.start[1], m = Math.max(Math.abs(dx), Math.abs(dy));
                p.cur = [p.start[0] + Math.sign(dx || 1) * m, p.start[1] + Math.sign(dy || 1) * m];
            } else p.cur = [ix, iy];
            p.mode = selModeOf(e);
        } else if (p.kind === "object") {
            p.curImg = [ix, iy];
            p.mode = selModeOf(e, "add");
            const dx = Math.abs(ix - p.startImg[0]), dy = Math.abs(iy - p.startImg[1]);
            if (dx >= 4 || dy >= 4) p.moved = true;
            this.draw();
        } else if (p.kind === "selmove") {
            const mx = Math.round(ix - p.start[0]), my = Math.round(iy - p.start[1]);
            if (mx || my) p.moved = true;
            const orig = p.orig, e = p.ext;
            if (isTilePixels(this.sel)) {
                // what the selection holds now (the outline at the last offset) and where it goes: outside
                // both, it is transparent before and after, so the rewrite stays inside their union
                const next = e ? [e[0] + mx, e[1] + my, e[2] + mx, e[3] + my] : null, last = p.lastExt;
                const box = !last ? next : !next ? last : [Math.min(last[0], next[0]), Math.min(last[1], next[1]), Math.max(last[2], next[2]), Math.max(last[3], next[3])];
                if (box) {
                    this.sel.clear(box);
                    // unscaled at whole pixels (mx, my are rounded): a copy of the extent to its new place
                    if (e) this.sel.blit(orig, e[0] + mx, e[1] + my, "copy", 1, e);
                }
                p.lastExt = next;
                // the display levels are refreshed inside the rewritten box, not rebuilt from the whole selection
                if (box) this.touchSourceRect(this.sel, box[0], box[1], box[2], box[3]);
                else this.touchSource(this.sel);
            } else {
                // On canvases 0.1.12's whole rewrite, GPU work there, and its touchSource, which drops the display
                // levels the pointer-down's undo step built. The tile path above, run on canvases (the box is the whole
                // image), redrew all those levels on every move (7500 × 5000 down to 938 × 625 at 15k: 35 to 46 ms of
                // GPU work a move against 6 to 7), and with the selection canvas on the CPU its clear plus "copy"
                // blit cleared the image twice (a handler of 156 to 171 ms against 118 to 131; C2's final review)
                const W = this.width, H = this.height;
                this.sel.drawInto(null, (ctx) => {
                    ctx.clearRect(0, 0, W, H);
                    orig.drawTo(ctx, mx, my);
                });
                this.touchSource(this.sel);
            }
            if (p.origBounds) {
                // the outline only moves: shift the known box instead of scanning the selection
                const nb = [Math.max(0, p.origBounds[0] + mx), Math.max(0, p.origBounds[1] + my),
                    Math.min(this.width, p.origBounds[2] + mx), Math.min(this.height, p.origBounds[3] + my)];
                this.cachedBounds = (nb[2] > nb[0] && nb[3] > nb[1]) ? nb : null;
                this.selectionDirty = false;
            } else {
                this.selectionDirty = true; this.selectionLoose = false;
            }
        } else if (p.kind === "lasso") {
            this.lassoPoints.push([ix, iy]);
            p.mode = selModeOf(e);
        } else if (p.kind === "patchdrag") {
            this.patchDrag(p, e, ix, iy);
        } else if (p.kind === "move") {
            p.layer.x = Math.round(p.orig.x + (ix - p.start[0]));
            p.layer.y = Math.round(p.orig.y + (iy - p.start[1]));
            this.snapGuides = null;
            if (!e.altKey) this.snapLayer(p.layer, p);
            if (p.group) this.applyGroupBox(p);
        } else if (p.kind === "scale" && p.group) {
            this.applyScale(p, ix, iy);
            this.snapGuides = null;
            if (!e.altKey) this.snapScale(p, ix, iy);
            this.applyGroupBox(p);
        } else if (p.kind === "scale") {
            if (p.angle) {
                const [lx, ly] = this.toLayerLocal(p.layer, p.angle, ix, iy, p.center);
                this.applyScale(p, lx, ly);
                // the rotation is about the layer's centre, which just moved: shift so the anchor corner stays put on screen
                const l = p.layer, dx = l.x + l.w / 2 - p.center[0], dy = l.y + l.h / 2 - p.center[1];
                const c = Math.cos(p.angle), s = Math.sin(p.angle);
                l.x = Math.round(l.x + (c * dx - s * dy) - dx);
                l.y = Math.round(l.y + (s * dx + c * dy) - dy);
            } else {
                this.applyScale(p, ix, iy);
                this.snapGuides = null;
                if (!e.altKey) this.snapScale(p, ix, iy);
            }
        } else if (p.kind === "guide") {
            p.pos = Math.round(p.axis === "x" ? ix : iy);
        } else if (p.kind === "split") {
            const [cx] = this.toCanvasPx(e);
            this.compare.split = Math.min(0.95, Math.max(0.05, cx / this.canvas.width));
        } else if (p.kind === "frame") {
            this.dragFrameHandle(p, ix, iy, e);
        } else if (p.kind === "framemove") {
            const o = p.orig, step = o.angle || e.altKey ? 1 : 8;
            const dx = Math.round((ix - p.start[0]) / step) * step, dy = Math.round((iy - p.start[1]) / step) * step;
            this.setFrame({ x: o.x + dx, y: o.y + dy }, this.frame());
            this.setStatus(this.frameStatus());
        } else if (p.kind === "framerotate") {
            // outside the frame the picture turns about its centre (Shift keeps whole degrees), once the pointer has moved
            // a few pixels: a click that wobbles must not refit a frame placed by hand
            const moved = Math.hypot(ix - p.start[0], iy - p.start[1]) * this.view.scale / (window.devicePixelRatio || 1);
            if (moved >= 4 || p.turning) {
                p.turning = true;
                let deg = normDeg(p.orig.angle + (Math.atan2(iy - this.height / 2, ix - this.width / 2) - p.a0) * 180 / Math.PI);
                if (e.shiftKey) deg = Math.round(deg);
                deg = Math.round(deg * 100) / 100;
                if (deg !== (this.frameOrCanvas().angle || 0)) this.setFrameAngle(deg);
            }
        } else if (p.kind === "straighten") {
            p.cur = [ix, iy];
        } else if (p.kind === "pending") {
            this.pendingPointerMove(ix, iy, e);
        } else if (p.kind === "relight") {
            const dx = Math.round(ix - p.startX);
            const dy = Math.round(iy - p.startY);
            if (!p.hasPushedUndo) {
                if (Math.hypot(dx, dy) >= 2 || (p.mode === "dist" && Math.abs(dy) >= 2)) {
                    p.hasPushedUndo = true;
                    this.pushUndo({ kind: "filter", id: p.layer.id, label: p.undoLabel });
                }
            }
            if (p.hasPushedUndo) {
                p.moved = true;
                if (p.mode === "move") {
                    p.light.x = p.startLx + dx;
                    p.light.y = p.startLy + dy;
                    if (p.startAim && p.light.aim) {
                        p.light.aim[0] = p.startAim[0] + dx;
                        p.light.aim[1] = p.startAim[1] + dy;
                    }
                } else if (p.mode === "aim") {
                    p.light.aim[0] = p.startAx + dx;
                    p.light.aim[1] = p.startAy + dy;
                } else if (p.mode === "dist") {
                    const deltaDist = Math.round(-dy * (100.0 / Math.max(100, (this.height || 1024) * 0.4)));
                    p.light.dist = Math.max(-100, Math.min(100, p.startDist + deltaDist));
                }
                this.filterPreview = p.layer.id;
                this.ensureRelightMaps(p.layer, { quick: true });
                this.markFilterChanged(p.layer, { soon: true });
            }
        }
        this.drawSoon();
    }

    applyScale(p, ix, iy) {
        const o = p.orig;
        const l = p.layer;
        const h = p.handle;
        const horizontal = h.includes("e") || h.includes("w");
        const vertical = h.includes("n") || h.includes("s");
        const anchorX = h.includes("w") ? o.x + o.w : o.x;
        const anchorY = h.includes("n") ? o.y + o.h : o.y;
        let nw = horizontal ? Math.abs(ix - anchorX) : o.w;
        let nh = vertical ? Math.abs(iy - anchorY) : o.h;
        if (p.keepAspect && horizontal && vertical) {
            const aspect = o.w / o.h;
            if (nw / aspect > nh) nh = nw / aspect; else nw = nh * aspect;
        }
        nw = Math.max(4, nw);
        nh = Math.max(4, nh);
        l.w = Math.round(nw);
        l.h = Math.round(nh);
        l.x = Math.round(h.includes("w") ? anchorX - nw : (horizontal ? anchorX : o.x));
        l.y = Math.round(h.includes("n") ? anchorY - nh : (vertical ? anchorY : o.y));
    }

    onPointerUp(e) {
        const p = this.pointer;
        if (!p || p.healing) return;
        this.pointer = null;
        this.viewEl.classList.remove("ipc-panning");
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (p.kind === "boxes") { if (this.boxes) this.boxes.pointer("up", e, ...this.toImage(e)); return; }
        if (p.kind === "plugin") { host.pluginPointer(this, "up", e, ...this.toImage(e), p); return; }
        if (p.kind === "rect") {
            if (p.startPx && !p.moved) {
                // a click without a drag deselects, like the lasso below. Without the screen
                // pixel threshold a hand that wobbles by one pixel left a small selection
                // right under the cursor, which on a 15k image is a dozen image pixels wide.
                if (p.mode !== "replace") return;
                this.selectionLabel = "";
                this.sel.clear();
                this.markSelectionChanged(null);   // the undo step was pushed on pointer down
                this.draw();
                return;
            }
            const [x0, y0] = p.start;
            const [x1, y1] = p.cur;
            const mode = p.mode, ellipse = p.ellipse, W = this.width, H = this.height;
            if (mode === "replace") this.selectionLabel = "";
            const rx0 = Math.min(x0, x1), ry0 = Math.min(y0, y1), rx1 = Math.max(x0, x1), ry1 = Math.max(y0, y1);
            const shapeBox = [rx0, ry0, rx1, ry1];
            const gco = selectionGco(mode);
            if (mode === "replace") {
                this.sel.clear();
            } else if (gco.clearOutside) {
                if (ry0 > 0) this.sel.clear([0, 0, W, ry0]);
                if (ry1 < H) this.sel.clear([0, ry1, W, H]);
                if (rx0 > 0) this.sel.clear([0, ry0, rx0, ry1]);
                if (rx1 < W) this.sel.clear([rx1, ry0, W, ry1]);
            }
            const box = [rx0 - 1, ry0 - 1, rx1 + 1, ry1 + 1];
            this.sel.drawInto(box, (sctx) => {
                sctx.globalCompositeOperation = gco.op;
                sctx.fillStyle = "#ff0000";
                if (ellipse) {
                    sctx.beginPath();
                    sctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
                    sctx.fill();
                } else {
                    sctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
                }
            });
            this.markSelectionChanged(this.boundsAfter(p.mode, shapeBox));
        } else if (p.kind === "selmove") {
            // a click without a drag deselects, the way the marquee tools do in Photoshop and Krita
            if (!p.moved) { this.clearSelection(); return; }
            this.markSelectionChanged(this.selectionDirty ? undefined : this.cachedBounds);
            this.setStatus("Selection outline moved.");
        } else if (p.kind === "lasso") {
            const pts = this.lassoPoints;
            this.lassoPoints = null;
            if ((!pts || pts.length <= 2) && p.mode === "replace") { this.clearSelection(); return; }   // a click deselects
            if (pts && pts.length > 2) {
                let lx0 = pts[0][0], ly0 = pts[0][1], lx1 = lx0, ly1 = ly0;
                for (const [px, py] of pts) { if (px < lx0) lx0 = px; if (px > lx1) lx1 = px; if (py < ly0) ly0 = py; if (py > ly1) ly1 = py; }
                const mode = p.mode, W = this.width, H = this.height;
                if (mode === "replace") this.selectionLabel = "";
                const gco = selectionGco(mode);
                if (mode === "replace") {
                    this.sel.clear();
                } else if (gco.clearOutside) {
                    if (ly0 > 0) this.sel.clear([0, 0, W, ly0]);
                    if (ly1 < H) this.sel.clear([0, ly1, W, H]);
                    if (lx0 > 0) this.sel.clear([0, ly0, lx0, ly1]);
                    if (lx1 < W) this.sel.clear([lx1, ly0, W, ly1]);
                }
                this.sel.drawInto([lx0 - 1, ly0 - 1, lx1 + 1, ly1 + 1], (sctx) => {
                    sctx.globalCompositeOperation = gco.op;
                    sctx.fillStyle = "#ff0000";
                    sctx.beginPath();
                    sctx.moveTo(pts[0][0], pts[0][1]);
                    for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i][0], pts[i][1]);
                    sctx.closePath();
                    sctx.fill();
                });
                this.markSelectionChanged(this.boundsAfter(p.mode, [lx0, ly0, lx1, ly1]));
            }
        } else if (p.kind === "patchdrag") {
            this.patchRelease(p, e);
        } else if (p.kind === "selpaint") {
            const filled = this.fillEnclosed && this.closeStrokeLoop(p.path, !!p.subtract);
            // the dabs kept the levels up to date and a closed loop fills inside the path, which
            // lies within the dabs' box; that box is the new bounds (an add) or their superset (a subtract)
            this.markSelectionChanged(p.bounds ? this.boundsAfter(p.subtract ? "subtract" : "add", p.bounds) : undefined, p.bounds);
        } else if (p.kind === "object") {
            const cur = p.curImg || this.toImage(e);
            const start = p.startImg || cur;
            const dx = Math.abs(cur[0] - start[0]), dy = Math.abs(cur[1] - start[1]);
            if (p.moved && dx >= 4 && dy >= 4) {
                const box = [
                    Math.max(0, Math.min(start[0], cur[0])),
                    Math.max(0, Math.min(start[1], cur[1])),
                    Math.min(this.width, Math.max(start[0], cur[0])),
                    Math.min(this.height, Math.max(start[1], cur[1])),
                ];
                host.selectBox(this, box, { mode: p.mode || "add" });
            } else if (!p.moved || (dx < 4 && dy < 4)) {
                this.toggleObjectAt(...this.toImage(e), p);   // a click; a pointer that moved along one axis only does nothing
            }
            this.draw();
        } else if (p.kind === "layerpaint") {
            this.finishStroke(p);   // the stabiliser's rest of the string, before the box is taken
            // heal: the blend replaces the dabs' colours; a large stroke is blended in a worker and commits when it lands
            if (p.clone && p.clone.heal && this.healBlend(p)) { this.draw(); return; }
            // remove: the stroke only marks the hole; the model's fill lands when it answers, or nothing does
            if (p.remove) { this.removeRun(p); this.draw(); return; }
            this.commitLayerPaint(p);
        } else if (p.kind === "shapepoint") {
            this.shapeDrag = null;
        } else if (p.kind === "liquify") {
            this.liquifyRelease(p);
            this.draw();
        } else if (p.kind === "smudge") {
            this.finishStroke(p);
            // the box the dabs covered (the whole layer before 0.1.32: every matched layer above lost its statistics)
            if (p.bounds) this.markLayerChanged(p.layer, this.strokeRect(p, p.layer.px));
            if (p.orig) { p.orig.release(); p.orig = null; }
            if (p.src && p.src.release) p.src.release();
            this.releaseStrokeScratch();
        } else if (p.kind === "maskpaint" && !p.layer.maskPx) {
            // the mask went away while the button was down (Ctrl+Z of the step that made it, or an
            // agent's undo): the stroke has nothing to land on and ends like a cancelled one
            this.releaseStrokeScratch();
            this.draw();
        } else if (p.kind === "maskpaint") {
            this.finishStroke(p);
            const box = this.strokeRect(p, p.layer.maskPx);
            this.commitStroke(p);
            this.markMaskChanged(p.layer, box);
            this.releaseStrokeScratch();
            this.lastStrokeEnd = { layerId: p.layer.id, x: p.last[0], y: p.last[1], mask: true };
        } else if (p.kind === "move" || p.kind === "scale") {
            this.snapGuides = null;
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.renderLayers();
            this.updateSubbar();
            this.drawThumb();
            this.notifyChanged();
        } else if (p.kind === "guide") {
            const list = this.guides[p.axis];
            const limit = p.axis === "x" ? this.width : this.height;
            const inside = p.pos != null && p.pos >= 0 && p.pos <= limit;
            if (p.index >= 0) { if (inside) list[p.index] = p.pos; else list.splice(p.index, 1); }
            else if (inside) list.push(p.pos);
            this.notifyChanged();
            this.setStatus(inside ? `Guide at ${p.axis} = ${p.pos}.` : (p.index >= 0 ? "Guide removed." : "Drag the guide onto the image to place it."));
        } else if (p.kind === "straighten") {
            // along something that should be level or plumb: the nearest of the two is what the line is taken for, and the
            // picture turns by what it is off (it is drawn over the preview, so from the angle it is turned already)
            const [x0, y0] = p.start, [x1, y1] = p.cur;
            const len = Math.hypot(x1 - x0, y1 - y0) * this.view.scale / (window.devicePixelRatio || 1);
            if (len >= 8) {
                const phi = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
                const off = phi - 90 * Math.round(phi / 90);
                this.frameStraighten = false;
                this.setFrameAngle(p.orig.angle - off);
            } else {
                this.setStatus("Draw a longer line along something that should be level or plumb.");
            }
            this.syncFrameControls();
        } else if (p.kind === "frame" || p.kind === "framemove" || p.kind === "framerotate") {
            // nothing is applied on release: Enter, Apply or a double click inside the frame does
            this.setStatus(this.frameStatus());
        } else if (p.kind === "relight") {
            this.filterPreview = null;
            if (p.moved) {
                this.ensureRelightMaps(p.layer, { quick: false });
                this.markFilterChanged(p.layer);
                this.renderLayers();
            }
        }
        this.draw();
    }

    /** Fill the polygon in progress into the selection with the mode chosen at its first point. */
    closePolygon() {
        const pts = this.polyPoints;
        this.polyPoints = null;
        if (!pts || pts.length < 3) { this.setStatus("A polygon needs at least three points."); return; }
        this.pushUndo({ kind: "selection", label: "Polygon selection" });
        const mode = this.polyMode, W = this.width, H = this.height;
        if (mode === "replace") this.selectionLabel = "";
        let bx0 = pts[0][0], by0 = pts[0][1], bx1 = bx0, by1 = by0;
        for (const [px, py] of pts) { if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; }
        const gco = selectionGco(mode);
        if (mode === "replace") {
            this.sel.clear();
        } else if (gco.clearOutside) {
            if (by0 > 0) this.sel.clear([0, 0, W, by0]);
            if (by1 < H) this.sel.clear([0, by1, W, H]);
            if (bx0 > 0) this.sel.clear([0, by0, bx0, by1]);
            if (bx1 < W) this.sel.clear([bx1, by0, W, by1]);
        }
        this.sel.drawInto([bx0 - 1, by0 - 1, bx1 + 1, by1 + 1], (sctx) => {
            sctx.globalCompositeOperation = gco.op;
            sctx.fillStyle = "#ff0000";
            sctx.beginPath();
            sctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i][0], pts[i][1]);
            sctx.closePath();
            sctx.fill();
        });
        this.markSelectionChanged(this.boundsAfter(this.polyMode, [bx0, by0, bx1, by1]));
        const modeWord = this.polyMode === "replace" ? "selected" : this.polyMode === "add" ? "added" : this.polyMode === "subtract" ? "subtracted" : "intersected";
        this.setStatus(`Polygon with ${pts.length} points ${modeWord}.`);
    }
}
