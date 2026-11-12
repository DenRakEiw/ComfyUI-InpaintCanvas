// Generated from DenRakEiw/scumble renderer/editor/inpaint_backends.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// segment, upsample, cutout and object backends, the crop and generation defaults: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./host.js";
import { referencesRule, referencesText } from "./reftokens.js";

// ---------------------------------------------------------------------------
// text segmentation backends (each builds a small standalone prompt)
// ---------------------------------------------------------------------------

/**
 * A helper prompt with every required widget input its builder left out set to the server's own default for it (the
 * node's spec in /object_info: a combo's default or its first option, a value's default). Node packs add required
 * inputs: comfyui-rmbg's SAM3Segment got `model_name` (sam3.1_multiplex_fp16 / sam3) in 2026-10, and a prompt without
 * it fails validation (DenRakEiw/scumble#7); an older pack without the input is sent nothing more. Links (IMAGE, MASK,
 * ...) have no default and stay as they are. Changes and returns `nodes`.
 */
function withSpecDefaults(nodes) {
    const types = host.nodeTypes() || {};
    for (const node of Object.values(nodes)) {
        const t = node && types[node.class_type];
        const req = t && t.nodeData && t.nodeData.input && t.nodeData.input.required;
        if (!req || !node.inputs) continue;
        for (const [name, spec] of Object.entries(req)) {
            if (name in node.inputs || !Array.isArray(spec)) continue;
            const opts = spec[1] && typeof spec[1] === "object" ? spec[1] : {};
            if (Array.isArray(spec[0])) {
                const v = opts.default !== undefined && spec[0].includes(opts.default) ? opts.default : spec[0][0];
                if (v !== undefined) node.inputs[name] = v;
            } else if (opts.default !== undefined && ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(spec[0])) {
                node.inputs[name] = opts.default;
            }
        }
    }
    return nodes;
}

const SEGMENT_BACKENDS = [
    {
        id: "sam3_rmbg",
        label: "SAM3",
        needs: ["SAM3Segment"],
        // comfyui-rmbg's SAM3 node. Its optional inputs have no defaults in the
        // Python signature, so every one of them must be sent. Weights: models/sam3/sam3.pt.
        build: (load, text, threshold) => ({
            seg_run: { class_type: "SAM3Segment", inputs: {
                image: [load, 0], prompt: text, output_mode: "Merged", confidence_threshold: Math.min(0.95, Math.max(0.05, threshold)),
                max_segments: 0, segment_pick: 0, mask_blur: 0, mask_offset: 0, device: "Auto", invert_output: false, unload_model: false,
                background: "Alpha", background_color: "#222222",
            } },
        }),
        maskOut: ["seg_run", 1],
    },
    {
        id: "dino_sam",
        label: "GroundingDINO + SAM",
        needs: ["GroundingDinoModelLoader (segment anything)", "SAMModelLoader (segment anything)", "GroundingDinoSAMSegment (segment anything)"],
        build: (load, text, threshold, opts) => ({
            seg_dino: { class_type: "GroundingDinoModelLoader (segment anything)", inputs: { model_name: "GroundingDINO_SwinT_OGC (694MB)" } },
            seg_sam: { class_type: "SAMModelLoader (segment anything)", inputs: { model_name: opts.quality ? "sam_vit_h (2.56GB)" : "sam_vit_b (375MB)" } },
            seg_run: { class_type: "GroundingDinoSAMSegment (segment anything)", inputs: { sam_model: ["seg_sam", 0], grounding_dino_model: ["seg_dino", 0], image: [load, 0], prompt: text, threshold } },
        }),
        maskOut: ["seg_run", 1],
    },
    {
        id: "sam3_core",
        label: "SAM3 (core, experimental)",
        needs: ["SAM3_Detect", "CheckpointLoaderSimple", "CLIPTextEncode"],
        // The SAM3 checkpoint (sam3.safetensors from Hugging Face, license gated)
        // goes into models/checkpoints and loads through the normal checkpoint loader.
        checkpoint: () => {
            const t = host.nodeTypes()["CheckpointLoaderSimple"];
            const list = t && t.nodeData && t.nodeData.input && t.nodeData.input.required && t.nodeData.input.required.ckpt_name;
            const names = Array.isArray(list) && Array.isArray(list[0]) ? list[0] : [];
            return names.find((n) => /sam3/i.test(n)) || null;
        },
        available: (b) => !!b.checkpoint(),
        build: (load, text, threshold, opts, b) => ({
            seg_ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: b.checkpoint() } },
            seg_text: { class_type: "CLIPTextEncode", inputs: { clip: ["seg_ckpt", 1], text } },
            seg_run: { class_type: "SAM3_Detect", inputs: { model: ["seg_ckpt", 0], image: [load, 0], conditioning: ["seg_text", 0], threshold, refine_iterations: 2, individual_masks: false } },
        }),
        maskOut: ["seg_run", 0],
    },
];

const MIN_AUTO_CROP = 512;          // keep in sync with nodes.py
const CROP_DEFAULTS = { context: "auto", feather: "auto", fill: "none", colorMatch: true, extendFill: "average color", withOriginal: false, align: true, paste: "selection" };
const CROP_LEGACY = { context: "manual", feather: "manual", fill: "none", colorMatch: false };   // workflows saved before these existed
// Generate settings: mode picks which result input the round trip uses ("api" =
// result, "local" = result_local); denoise and seed are emitted as node outputs.
const GEN_DEFAULTS = { mode: "api", denoise: 1.0, seed: 0, seedRandom: true, refine: false, boxes: false };
// Editor-driven setting outputs: wildcard outputs after the fixed ones, wired to
// any widget input in the graph. FIXED_OUTPUTS must match RETURN_NAMES up to "negative".
const FIXED_OUTPUTS = 13;
const SETTING_SLOTS = 8;
const randomSeed = () => Math.floor(Math.random() * 0xffffffff);

/** Context padding, grow, feather and blend from the selection size (same formula as nodes.py). */
function autoSelectionParams(selW, selH, strength = 1) {
    const diag = Math.hypot(selW, selH);
    strength = Math.min(1, Math.max(0.05, strength));
    const feather = Math.max(Math.floor(0.10 * diag * strength), Math.round(32 * strength));
    const grow = 4 + Math.floor(feather / 2);
    const blend = Math.min(25, grow + Math.floor(feather / 2));
    const pad = feather + 4 + Math.floor(0.06 * diag);
    return { pad, grow, feather, blend };
}

function ensureMinSpan(a0, a1, limit, minSize) {
    const size = a1 - a0;
    if (size >= minSize || minSize <= 0) return [a0, a1];
    const target = Math.min(minSize, limit);
    const extra = target - size;
    a0 -= Math.floor(extra / 2);
    a1 = a0 + target;
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > limit) { a0 -= a1 - limit; a1 = limit; }
    return [Math.max(0, a0), a1];
}

// Prompt upsampling: a vision-language model sees the crop (selection tinted
// red, or solid green when Fill is green) and rewrites the user's short request
// into a prompt for the chosen use case. Runs as a helper prompt like the
// segmentation, never through the user's chain.
const UPSAMPLE_BACKENDS = [
    {
        id: "qwenvl",
        label: "Qwen3-VL 2B (local)",
        needs: ["AILab_QwenVL"],
        build: (load, instruction) => ({
            up_run: { class_type: "AILab_QwenVL", inputs: {
                model_name: "Qwen3-VL-2B-Instruct", quantization: "None (FP16)", attention_mode: "auto",
                preset_prompt: "\u{1F5BC}\uFE0F Detailed Description", custom_prompt: instruction,
                max_tokens: 220, keep_model_loaded: true, seed: 1, image: [load, 0],
            } },
        }),
        textOut: ["up_run", 0],
    },
    {
        id: "qwenvl4b",
        label: "Qwen3-VL 4B (local, downloads ~8 GB once)",
        needs: ["AILab_QwenVL"],
        build: (load, instruction) => ({
            up_run: { class_type: "AILab_QwenVL", inputs: {
                model_name: "Qwen3-VL-4B-Instruct", quantization: "None (FP16)", attention_mode: "auto",
                preset_prompt: "\u{1F5BC}\uFE0F Detailed Description", custom_prompt: instruction,
                max_tokens: 220, keep_model_loaded: true, seed: 1, image: [load, 0],
            } },
        }),
        textOut: ["up_run", 0],
    },
    {
        id: "gemini",
        label: "Gemini (Comfy API)",
        needs: ["GeminiNode"],
        build: (load, instruction) => ({
            up_run: { class_type: "GeminiNode", inputs: { prompt: instruction, model: "gemini-2.5-flash", seed: 1, images: [load, 0] } },
        }),
        textOut: ["up_run", 0],
    },
];

function availableUpsampleBackends() {
    const types = host.nodeTypes();
    return [...UPSAMPLE_BACKENDS.filter((b) => b.needs.every((n) => !!types[n])), ...host.upsampleBackends()];
}

const UPSAMPLE_CASES = ["auto", "fill", "add", "remove", "edit", "outpaint", "upscale"];

/** Short noun phrase for a segmentation model, derived from the user's prompt by a VLM. */
function segmentTermInstruction(promptText) {
    // Two explicit steps: with a single question the 2B model copies German words unchanged.
    return `Step 1: translate this request to English: "${promptText}". Step 2: name the one object in the picture that the request is about, as it looks now, in English, 1 to 3 words, plain nouns only (examples: swimsuit, hair, wooden chair, background). Output only the words of step 2, nothing else.`;
}

/**
 * The instruction the language model gets. The host may hand out its own text (Scumble's
 * prompt templates); when it does not, the built-in rules below are used.
 */
function upsampleInstruction(useCase, text, region, hint, refs = []) {
    if (host.upsampleInstruction) {
        const own = host.upsampleInstruction({ useCase, prompt: text, region, hint, references: refs });
        if (own) return own;
    }
    return builtInUpsampleInstruction(useCase, text, region, hint, refs);
}

/**
 * `refs`: the references the prompt names (`[{ id, n, name }]` by label, docs/PLAN_REFS.md 26d1). Every sentence about
 * them is added only when there are any, so the text without references is the one it always was (the node's too).
 */
function builtInUpsampleInstruction(useCase, text, region, hint, refs = []) {
    const has = refs.length > 0;
    // Kept short and with the request repeated at the end: small VLMs (Qwen3-VL 2B)
    // drop the request when it is buried in a long preamble.
    const req = text ? `"${text}"` : "(no request given: infer the most plausible content from the picture)";
    // what the selection contains, when it came from a text segmentation
    const look = `${has ? "Look at the picture being edited." : "Look at the image."}${hint ? ` ${region[0].toUpperCase()}${region.slice(1)} currently shows: ${hint}.` : ""}${referencesText(refs)}`;
    const rules = `Rules: obey the request exactly and translate it to English if needed (Seide = silk, Leder = leather); if the request names a colour or material, the prompt must use exactly that colour and material even though the picture currently shows something else; describe only the final content as a direct description of what is seen; the ${region.includes("green") ? "green area" : "magenta outline"} is only a marker, never mention it, the region or the image${has ? " (the @img tokens are not such mentions: keep them)" : ""}; no lists, no preamble, no quotes, no negative prompt.${has ? " " + referencesRule(refs) : ""} Output only the prompt text.`;
    const tail = `Request again: ${req}`;
    // what each use case may take from a named reference picture
    const take = (s) => (has ? " " + s : "");
    const t0 = has ? "@img" + refs[0].n : "";
    switch (useCase) {
        case "add":
            return `${look} Something new will be painted into ${region} according to this request: ${req}. Write the image-generation prompt for it: one English paragraph of 40 to 80 words, starting with the requested object, then its shape, material and colour, then how it sits in the scene (size relative to the surroundings, contact with surfaces, cast shadows) under the same lighting and perspective as the rest of the picture.${take("Take from each named reference image only the object or material the request asks for, and write its token where the request puts it.")} ${rules} ${tail}`;
        case "remove":
            return `${look} Whatever ${region} contains will be erased as if it had never been there${text ? `; request: ${req}` : ""}. Write the image-generation prompt for that spot: one English paragraph of 30 to 60 words describing only what would be visible with the object gone, the background, surfaces, body or textures continuing naturally from the surroundings. The object that is there now must not appear in the prompt and the word remove must not be used.${take("A named reference image only shows the surface or texture the uncovered area should continue: write its token where the request puts it and add nothing else from it.")} ${rules}`;
        case "edit":
            return `You write instructions for an image editing model. Request: ${req}. ${look} Rewrite the request as one English instruction of 15 to 35 words for the editing model: start with a verb, name the subject as it appears in the picture (the woman, the red car, the wall), apply exactly the requested change with the exact colours, materials or objects named in the request, and end with what must stay unchanged.${take(`Where the request takes something from a reference image, name it by its token, as in "the jacket from ${t0}", and take from that picture only what the request asks for, never its background.`)} Do not describe the picture, do not describe the current state, do not add a story or mood. Examples: request "change her haircolor to light blue" -> "Change the woman's hair color to light blue, keeping her hairstyle, face, expression, skin, clothing, pose, lighting and background exactly as they are." Request "mach den Stuhl aus Holz" -> "Make the chair out of natural wood with visible grain, keeping its shape, position, the person sitting on it and the rest of the scene unchanged."${take(`Request "zieh ihr die Jacke aus ${t0} an" -> "Dress the woman in the jacket from ${t0}, keeping her face, hair, pose, the lighting and the background exactly as they are."`)} ${has ? referencesRule(refs) + " " : ""}Output only the instruction. Request again: ${req}`;
        case "outpaint":
            return `${look} ${region[0].toUpperCase()}${region.slice(1)} lies at the border and the scene will be extended beyond it${text ? `; request: ${req}` : ""}. Write the image-generation prompt for the extension: one English paragraph of 40 to 80 words describing what appears further out, continuing the same environment, perspective, lighting and style without a visible seam.${take("Take from each named reference image only what the request asks for (a subject, a style, a setting), and write its token where the request puts it.")} ${rules} ${tail}`;
        case "upscale":
            return `${look} ${region[0].toUpperCase()}${region.slice(1)} will be upscaled and refined at a higher resolution without changing what it shows${text ? `; extra guidance on style and detail: ${req}` : ""}. Write the image-generation prompt for the refinement: one English paragraph of 40 to 80 words describing faithfully what is already there (subjects, materials, colours, lighting, style), then the fine detail a sharp high-resolution version would show (surface textures, pores, fabric weave, hair strands, foliage, crisp edges). Do not add, remove or change any object, do not change colours or composition.${take("A named reference image is guidance for style and detail only: write its token where the request puts it and never add its content.")} ${rules}${text ? ` ${tail}` : ""}`;
        default:
            return `${look} ${region[0].toUpperCase()}${region.slice(1)} will be repainted according to this request: ${req}. Write the image-generation prompt for that area: one English paragraph of 40 to 80 words, starting with the requested subject, then its materials and colours, then how its lighting, perspective and scale match the surroundings so the result blends in.${take("Take from each named reference image only what the request asks for (a subject, a garment, a material, a style or a pose), never its background, and write its token where the request puts it.")} ${rules} ${tail}`;
    }
}

function availableSegmentBackends() {
    const types = host.nodeTypes();
    return SEGMENT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]) && (!b.available || b.available(b)));
}

// Background removal for layer cutouts (Krita "remove background", LayerForge).
// One helper prompt per layer: LoadRef(layer pixels) -> model -> InpaintCanvasMaskOut
// (purpose "cutout"); the mask becomes the layer's transparency mask.
const CUTOUT_BACKENDS = [
    {
        id: "rmbg2",
        label: "RMBG-2.0",
        needs: ["RMBG"],
        // comfyui-rmbg: every optional input is read from **params, so all of them are sent.
        build: (load) => ({
            cut_run: { class_type: "RMBG", inputs: {
                image: [load, 0], model: "RMBG-2.0", sensitivity: 1.0, process_res: 1024, mask_blur: 0, mask_offset: 0,
                invert_output: false, refine_foreground: false, background: "Alpha", background_color: "#222222",
            } },
        }),
        maskOut: ["cut_run", 1],
    },
    {
        id: "birefnet",
        label: "BiRefNet",
        needs: ["BiRefNetRMBG"],
        build: (load) => ({
            cut_run: { class_type: "BiRefNetRMBG", inputs: {
                image: [load, 0], model: "BiRefNet-general", mask_blur: 0, mask_offset: 0,
                invert_output: false, refine_foreground: false, background: "Alpha", background_color: "#222222",
            } },
        }),
        maskOut: ["cut_run", 1],
    },
    {
        id: "ben2",
        label: "BEN2",
        needs: ["RMBG"],
        build: (load) => ({
            cut_run: { class_type: "RMBG", inputs: {
                image: [load, 0], model: "BEN2", sensitivity: 1.0, process_res: 1024, mask_blur: 0, mask_offset: 0,
                invert_output: false, refine_foreground: false, background: "Alpha", background_color: "#222222",
            } },
        }),
        maskOut: ["cut_run", 1],
    },
    {
        id: "bria14",
        label: "BRIA RMBG 1.4",
        needs: ["BRIA_RMBG_ModelLoader_Zho", "BRIA_RMBG_Zho"],
        build: (load) => ({
            cut_model: { class_type: "BRIA_RMBG_ModelLoader_Zho", inputs: {} },
            cut_run: { class_type: "BRIA_RMBG_Zho", inputs: { rmbgmodel: ["cut_model", 0], image: [load, 0] } },
        }),
        maskOut: ["cut_run", 1],
    },
];

function availableCutoutBackends() {
    const types = host.nodeTypes();
    return [...host.cutoutBackends(), ...CUTOUT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]))];
}

const isSettingOutput = (o) => !!(o && typeof o.name === "string" && /^setting_\d+$/.test(o.name));
const settingIndex = (o) => parseInt(o.name.slice(8), 10);

/** A link by id, whatever the litegraph version stores links in. */
function linkOf(graph, id) {
    if (!graph || id == null) return null;
    if (typeof graph.getLink === "function") { const l = graph.getLink(id); if (l) return l; }
    if (graph._links && typeof graph._links.get === "function") { const l = graph._links.get(id); if (l) return l; }
    return (graph.links && graph.links[id]) || null;
}

// Object map for the hover selection tool: SAM2's automatic mask generator
// (ComfyUI-segment-anything-2 by Kijai) finds every object once, the editor then
// picks objects under the cursor without further model runs.
const OBJECT_BACKEND = {
    label: "SAM2",
    // Kijai's loader gives the automatic mask generator; our own node runs it and
    // encodes the label map (Kijai's auto node only outputs the union mask).
    needs: ["DownloadAndLoadSAM2Model", "InpaintCanvasObjectMap"],
    build: (load, canvasNode) => ({
        obj_model: { class_type: "DownloadAndLoadSAM2Model", inputs: { model: "sam2_hiera_base_plus.safetensors", segmentor: "automaskgenerator", device: "cuda", precision: "fp16" } },
        obj_run: { class_type: "InpaintCanvasObjectMap", inputs: {
            sam2_model: ["obj_model", 0], image: [load, 0], canvas_node: canvasNode,
            points_per_side: 32, pred_iou_thresh: 0.8, stability_score_thresh: 0.92, min_area: 0.0002,
        } },
    }),
};

function objectBackendAvailable() {
    if (host.objectsInApp()) return true;
    const types = host.nodeTypes();
    return OBJECT_BACKEND.needs.every((n) => !!types[n]);
}

export { CROP_DEFAULTS, CROP_LEGACY, FIXED_OUTPUTS, GEN_DEFAULTS, MIN_AUTO_CROP, OBJECT_BACKEND, SEGMENT_BACKENDS, SETTING_SLOTS, UPSAMPLE_CASES, autoSelectionParams, availableCutoutBackends, availableSegmentBackends, availableUpsampleBackends, ensureMinSpan, isSettingOutput, linkOf, objectBackendAvailable, randomSeed, segmentTermInstruction, settingIndex, upsampleInstruction, withSpecDefaults };
