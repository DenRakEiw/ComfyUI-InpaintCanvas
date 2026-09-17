// What the editor needs from ComfyUI. The editor itself (inpaint_canvas.js and the modules
// next to it) is generated from the Scumble app repo, renderer/editor/, by its
// tools/build_node.py; this file and inpaint_node.js / inpaint_bridge.js belong to the node.
//
// Scumble's renderer/editor/host.js has the same surface backed by its main process. Every
// member the editor calls is here: the ComfyUI behaviour where the node has one, a no-op or
// an empty list where the feature is app-only (in-app ONNX helpers, API language models,
// plugins, "Generate new", export size). tools/build_node.py --check in the app repo fails
// when the editor calls a member this object does not have.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export { api };

const editorsInGraph = () => ((app.graph && app.graph._nodes) || []).map((n) => n.inpaintEditor).filter(Boolean);

export const host = {
    /** The editor is a full-window overlay over the graph: title, close button, Esc closes. */
    overlay: true,
    /** A ComfyUI page is always connected to its server. */
    connected: true,

    /** The node's wording where Scumble's differs (the editor falls back to Scumble's). */
    text: {
        downloadTip: "Save and also download the file in the browser",
        downloadLabel: "Download",
        exportLayerTip: "Save the active layer alone as a PNG with transparency (output folder)",
        exportMaskTip: "Save the selection as a black and white mask PNG (output folder)",
        pngEmbedded: "workflow embedded",
        noUpsampleOption: "no language model nodes installed",
        noUpsampleBackend: "No language model nodes installed (ComfyUI-QwenVL, or the Gemini API node).",
        noObjectBackend: "Object selection needs ComfyUI-segment-anything-2 (Kijai) for the SAM2 automatic mask generator.",
        noCutoutOption: "no RMBG nodes",
        noCutoutBackend: "No background removal nodes installed (comfyui-rmbg or ComfyUI-BRIA_AI-RMBG).",
        filmPresetTip: "Film stock: sets amount, grain size and colour share (grain character only, the colour look is a LUT's job). Values assume a picture of about 2000 px.",
    },

    // ---- the window ------------------------------------------------------------------------

    mount(root) {
        document.body.appendChild(root);
    },

    onEscape(editor) {
        editor.close();
    },

    /** One editor per node, and only the open one listens for keys (inpaint_canvas.js checks isOpen). */
    isActive() {
        return true;
    },

    editors() {
        return editorsInGraph();
    },

    /** Texts of the open workflow tabs, scanned for file names the cleanup must keep. */
    referencedTexts() {
        const out = [];
        try {
            const wf = app.extensionManager && app.extensionManager.workflow;
            for (const w of (wf && wf.openWorkflows) || []) {
                out.push(w.content || w.originalContent || "");
                if (w.activeState) out.push(JSON.stringify(w.activeState));
                if (w.initialState) out.push(JSON.stringify(w.initialState));
            }
        } catch (_) { /* ignore */ }
        return out;
    },

    // ---- the graph -------------------------------------------------------------------------

    nodeTypes() {
        return (window.LiteGraph && LiteGraph.registered_node_types) || {};
    },

    graph() {
        return app.graph;
    },

    widgetValue(editor, name, fallback) {
        const w = editor.node.widgets && editor.node.widgets.find((x) => x.name === name);
        return w ? (+w.value || 0) : fallback;
    },

    settingTargets(editor) {
        return editor.settingTargetsFromGraph();
    },

    resultInputState(editor) {
        return editor.resultInputStateFromGraph();
    },

    changed(editor) {
        try { editor.node.graph && editor.node.graph.setDirtyCanvas && editor.node.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
        try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (_) { /* ignore */ }
    },

    async queueGenerate() {
        try {
            await app.queuePrompt(0);
        } catch (first) {
            // Some third-party extensions wrap queuePrompt and throw once on the
            // first call after a page load. One retry gets past that.
            console.warn("Inpaint Canvas: queuePrompt failed once, retrying", first);
            await new Promise((r) => setTimeout(r, 300));
            await app.queuePrompt(0);
        }
    },

    modeChanged() {},
    renderPresets() {},
    buildGenerateExtras() {},   // padding, target_size, feather, multiple_of are the node's own widgets

    // ---- export ------------------------------------------------------------------------------

    workflowForPng(editor) {
        const g = editor.node.graph;
        return g && g.serialize ? g.serialize() : app.graph.serialize();
    },

    /** The node exports the picture as it is (no Size row, no frame), so a PNG may be written in bands (scumble E2). */
    exportIsPlain() {
        return true;
    },

    exportCanvas(editor) {
        return editor.flattenToCanvas({ forRun: true });
    },

    exportQuality() {
        return 0.92;
    },

    /**
     * Into ComfyUI's output root like SaveImage, not into inpaint_canvas (that folder is working
     * files the cleanup may delete); with `download` the browser saves a copy too. Returns the
     * upload ref plus `path` for the status line.
     */
    async saveExport(blob, name, { download = false } = {}) {
        const { uploadBlob } = await import("./inpaint_canvas.js");
        const ref = await uploadBlob(blob, name, { overwrite: false, type: "output", subfolder: "" });
        if (download) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = ref.filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        return { ...ref, path: `output/${ref.subfolder ? ref.subfolder + "/" : ""}${ref.filename}` };
    },

    // ---- app-only features: absent here ------------------------------------------------------

    objectsInApp() { return false; },
    async findObjects() {},
    async selectPoint() {},
    upsampleBackends() { return []; },
    async upsampleInApp() { throw new Error("in-app language models are a Scumble feature"); },
    async askLLM() { throw new Error("in-app language models are a Scumble feature"); },
    cutoutBackends() { return []; },
    async cutoutInApp() { throw new Error("in-app background removal is a Scumble feature"); },
    async freeHelpers() {},
    upsampleInstruction: null,   // the built-in upsample instruction (Scumble hands out its templates)
    generateNewAvailable() { return false; },
    openGenerateNew() {},
    editorBuilt() {},
    toolChanged() {},
    pluginPointer() { return false; },
    pluginKey() { return false; },
    pluginOverlay() {},
};
