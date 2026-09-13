// Inpaint Canvas - the ComfyUI side of the node: the thumbnail widget on the node, the
// queuePrompt wrapper that turns the result back-link into result_source, the setting
// outputs, and the websocket routing of results and helper outputs to the right editor.
//
// This file belongs to the node repo. The editor it creates (InpaintEditor in
// inpaint_canvas.js and the modules next to it) is generated from the Scumble app repo,
// renderer/editor/, by tools/build_node.py there; host.js is what the editor asks ComfyUI.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { InpaintEditor, viewUrl, loadImageEl, makeCanvas, FIXED_OUTPUTS, SETTING_SLOTS, TAIL_OUTPUTS, NODE_CLASS, STITCH_CLASS, isSettingOutput, settingIndex, linkOf } from "./inpaint_canvas.js";
import { FILTERS, filterDefaults } from "./inpaint_filters.js";
import { installBridge } from "./inpaint_bridge.js";

// ---------------------------------------------------------------------------
// extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "inpaint.InpaintCanvas",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_CLASS) {
            /**
             * Outputs after the fixed ones: the connected setting slots plus one free
             * one, then the tail outputs (reference_images). Setting slots keep their
             * index while connected; the tail moves and the queuePrompt wrapper maps
             * its visible slot to the backend slot (FIXED_OUTPUTS + SETTING_SLOTS + i).
             */
            const syncSettingOutputs = (node) => {
                const graph = node.graph || app.graph;
                let highest = 0;
                for (const o of node.outputs || []) if (isSettingOutput(o) && o.links && o.links.length) highest = Math.max(highest, settingIndex(o));
                const want = Math.min(SETTING_SLOTS, highest + 1);
                // drop free setting slots above the wanted count (from the end: removeOutput reindexes later links)
                for (let i = node.outputs.length - 1; i >= FIXED_OUTPUTS; i--) {
                    const o = node.outputs[i];
                    if (isSettingOutput(o) && settingIndex(o) > want) node.removeOutput(i);
                }
                for (const t of TAIL_OUTPUTS) if (!node.outputs.some((o) => o && o.name === t.name)) node.addOutput(t.name, t.type, { label: t.label });
                for (let n = 1; n <= want; n++) if (!node.outputs.some((o) => isSettingOutput(o) && settingIndex(o) === n)) node.addOutput(`setting_${n}`, "*");
                // order: fixed, settings by number, tail; then point every link at its slot
                // outputs from older versions that no longer exist (reference_images) go away
                for (let i = node.outputs.length - 1; i >= FIXED_OUTPUTS; i--) {
                    const o = node.outputs[i];
                    if (!isSettingOutput(o) && !TAIL_OUTPUTS.some((t) => o && o.name === t.name)) node.removeOutput(i);
                }
                const fixed = node.outputs.slice(0, FIXED_OUTPUTS);
                const settings = node.outputs.filter(isSettingOutput).sort((a, b) => settingIndex(a) - settingIndex(b));
                const tail = TAIL_OUTPUTS.map((t) => node.outputs.find((o) => o && o.name === t.name)).filter(Boolean);
                const ordered = fixed.concat(settings, tail);
                if (ordered.some((o, i) => node.outputs[i] !== o) || ordered.length !== node.outputs.length) {
                    node.outputs.splice(0, node.outputs.length, ...ordered);
                }
                node.outputs.forEach((o, i) => {
                    for (const id of (o && o.links) || []) { const link = linkOf(graph, id); if (link) link.origin_slot = i; }
                    if (isSettingOutput(o)) { const n = settingIndex(o); o.label = (o.links && o.links.length) ? `setting ${n}` : `setting ${n} (free)`; }
                    const t = TAIL_OUTPUTS.find((x) => o && x.name === o.name);
                    if (t) o.label = t.label;
                });
                node.setSize([node.size[0], Math.max(node.size[1], node.computeSize()[1])]);
            };
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const editor = new InpaintEditor(this);
                this.inpaintEditor = editor;
                const widget = this.addDOMWidget("canvas_state", "INPAINT_CANVAS", editor.nodeRoot, {
                    getValue: () => editor.getValue(),
                    setValue: (v) => { editor.setValue(v); },
                    getMinHeight: () => 220,
                });
                widget.serializeValue = async () => editor.serializeForPrompt();
                editor.widget = widget;
                for (const name of ["padding", "target_size", "multiple_of"]) {
                    const w = this.widgets && this.widgets.find((x) => x.name === name);
                    if (!w) continue;
                    const cb = w.callback;
                    w.callback = function () { const x = cb ? cb.apply(this, arguments) : undefined; editor.renderInfo(); editor.draw(); return x; };
                }
                const [w, h] = this.size;
                this.setSize([Math.max(w, 340), Math.max(h, 500)]);
                syncSettingOutputs(this);
                return r;
            };

            // Setting outputs behave like a Primitive node's: the next free slot
            // appears once the previous one is connected, and the editor lists a
            // control per connected target.
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slot, connected, linkInfo, ioSlot) {
                const r = onConnectionsChange ? onConnectionsChange.apply(this, arguments) : undefined;
                if (type === LiteGraph.OUTPUT && slot >= FIXED_OUTPUTS && isSettingOutput(this.outputs && this.outputs[slot])) {
                    syncSettingOutputs(this);
                    setTimeout(() => { if (this.inpaintEditor) this.inpaintEditor.settingsChanged(); }, 0);
                } else if (type === LiteGraph.OUTPUT && this.inpaintEditor) {
                    setTimeout(() => this.inpaintEditor.renderInfo(), 0);
                } else if (type === LiteGraph.INPUT && this.inpaintEditor) {
                    setTimeout(() => this.inpaintEditor.renderInfo(), 0);
                }
                return r;
            };

            // Workflows saved before a widget was added carry their values shifted
            // by one. Put the canvas JSON back where it belongs and reset any widget
            // that received a string instead of a number.
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
                const values = (info && info.widgets_values) || [];
                const json = values.find((v) => typeof v === "string" && v.trim().startsWith("{"));
                if (json && this.widgets) {
                    for (const w of this.widgets) {
                        if (w.name === "canvas_state") {
                            const ed = this.inpaintEditor;
                            if (ed && ed.lastValueString !== json) w.value = json;
                        } else if (typeof w.value === "string" && w.value.trim().startsWith("{")) {
                            w.value = w.options && w.options.default != null ? w.options.default : (w.name === "multiple_of" ? 64 : 0);
                        }
                    }
                }
                // links are restored after configure; refresh the setting controls once the graph is complete
                setTimeout(() => { syncSettingOutputs(this); if (this.inpaintEditor) { this.inpaintEditor.renderSettings(); this.inpaintEditor.renderInfo(); } }, 0);
                return r;
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output) {
                onExecuted?.apply(this, arguments);
                if (output && output.inpaint_result && this.inpaintEditor) {
                    this.inpaintEditor.addResults(output.inpaint_result);
                }
            };

            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                try { this.inpaintEditor?.destroy(); } catch (_) { /* ignore */ }
                return onRemoved?.apply(this, arguments);
            };
        }

        if (nodeData.name === STITCH_CLASS) {
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output) {
                onExecuted?.apply(this, arguments);
                for (const r of (output && output.inpaint_result) || []) {
                    const target = r.canvas_node != null ? app.graph.getNodeById(+r.canvas_node) : null;
                    if (target && target.inpaintEditor) target.inpaintEditor.addResults([r]);
                }
            };
        }
    },

    setup() {
        // Commands from the MCP server (mcp/inpaint_canvas_mcp.py) arrive over the websocket.
        installBridge({ api, app, viewUrl, loadImageEl, makeCanvas, FILTERS, filterDefaults, NODE_CLASS });

        // The result back-link is a cycle from the graph's point of view. Strip it
        // from the prompt and pass the source node instead; the backend expands an
        // ephemeral stitch node that reads from that source.
        const origQueue = api.queuePrompt;
        api.queuePrompt = async function (number, prompt, ...rest) {
            const output = prompt && prompt.output;
            if (output) {
                const canvasIds = new Set();
                for (const [id, node] of Object.entries(output)) {
                    if (node.class_type !== NODE_CLASS) continue;
                    canvasIds.add(String(id));
                    for (const [input, key] of [["result", "result_source"], ["result_local", "result_source_local"]]) {
                        const link = node.inputs && node.inputs[input];
                        if (Array.isArray(link)) {
                            node.inputs[key] = `${link[0]}:${link[1]}`;
                            delete node.inputs[input];
                        } else if (node.inputs) {
                            delete node.inputs[key];
                        }
                    }
                }
                // Tail outputs sit right after the visible setting slots in the node but
                // after all SETTING_SLOTS in the backend: map the slot by output name.
                if (canvasIds.size) {
                    for (const node of Object.values(output)) {
                        for (const [name, v] of Object.entries(node.inputs || {})) {
                            if (!Array.isArray(v) || v.length !== 2 || !canvasIds.has(String(v[0]))) continue;
                            const gnode = app.graph.getNodeById(+v[0]);
                            const o = gnode && gnode.outputs && gnode.outputs[v[1]];
                            const ti = o ? TAIL_OUTPUTS.findIndex((t) => t.name === o.name) : -1;
                            if (ti >= 0) node.inputs[name] = [v[0], FIXED_OUTPUTS + SETTING_SLOTS + ti];
                        }
                    }
                }
            }
            return origQueue.call(this, number, prompt, ...rest);
        };

        api.addEventListener("execution_error", ({ detail }) => {
            const id = detail && (detail.node_id || "");
            const node = app.graph.getNodeById(+String(id).split(".")[0]);
            if (node && node.inpaintEditor) node.inpaintEditor.setStatus("Error: " + (detail.exception_message || "execution failed"));
            // helper prompts (segmentation) carry ids that are not graph nodes
            for (const n of app.graph._nodes) {
                const ed = n.inpaintEditor;
                if (ed && ed.segmentPromptId && detail && detail.prompt_id === ed.segmentPromptId) {
                    ed.segmentPending = null;
                    ed.segBtn.disabled = false;
                    ed.setStatus("Segmentation failed: " + (detail.exception_message || "execution failed"));
                }
                if (ed && ed.objectsPromptId && detail && detail.prompt_id === ed.objectsPromptId) {
                    ed.objectsPending = null;
                    ed.setStatus("Object detection failed: " + (detail.exception_message || "execution failed"));
                }
                if (ed && ed.upsamplePromptId && detail && detail.prompt_id === ed.upsamplePromptId) {
                    ed.upsamplePending = null;
                    ed.upBtn.disabled = false;
                    ed.setStatus("Upsampling failed: " + (detail.exception_message || "execution failed"));
                }
                if (ed && ed.cutoutPromptId && detail && detail.prompt_id === ed.cutoutPromptId) {
                    ed.cutoutPending = null;
                    ed.renderLayers();
                    ed.setStatus("Background removal failed: " + (detail.exception_message || "execution failed"));
                }
            }
        });

        // Masks and texts produced by helper prompts are routed to their canvas by id.
        api.addEventListener("executed", ({ detail }) => {
            const out = detail && detail.output;
            if (out && out.inpaint_text) {
                for (const info of out.inpaint_text) {
                    const node = app.graph.getNodeById(+info.canvas_node);
                    if (node && node.inpaintEditor) node.inpaintEditor.applyTextResult(info);
                }
            }
            if (!out || !out.inpaint_mask) return;
            for (const info of out.inpaint_mask) {
                const node = app.graph.getNodeById(+info.canvas_node);
                if (!node || !node.inpaintEditor) continue;
                if (info.purpose === "segments") node.inpaintEditor.applySegmentsFile(info);
                else if (info.purpose === "cutout") node.inpaintEditor.applyCutoutFile(info);
                else node.inpaintEditor.applyMaskFile(info);
            }
        });
    },
});
