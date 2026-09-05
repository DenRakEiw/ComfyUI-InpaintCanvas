// Inpaint Canvas - layered canvas editor for ComfyUI.
//
// The node itself only shows a thumbnail and a button. The editor opens as a
// full-window overlay so it never fights litegraph for pointer or wheel
// events. Responsibilities of this file:
//   * the editor (layers, selection tools, paint tools, transform, pan/zoom, undo,
//     control layers, reference layers, layer masks / cutouts, outpainting, result history)
//   * persisting the canvas state in the workflow (widget value)
//   * on queue: flatten visible layers + selection mask (+ control layers), upload
//     them, and put a small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle) and
//     pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { FILTERS, FILTER_IDS, filterDefaults, applyFilter, lutFromCube, lutToCanvas, lutFromImage, plateStats } from "./inpaint_filters.js";

const NODE_CLASS = "InpaintCanvas";
const STITCH_CLASS = "InpaintCanvasStitch";
const SUBFOLDER = "inpaint_canvas";
const MAX_UNDO = 30;
const HANDLE_PX = 9;
const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference"];
const ROLES = ["none", "reference", "scribble", "lineart", "depth", "pose", "canny", "other"];
// Outputs after the setting slots (none at the moment). The backend would declare
// them after setting_8, the frontend shows them right after the connected settings
// (see syncSettingOutputs) and the queuePrompt wrapper maps the visible slot to the
// backend slot. Outputs that are neither fixed, setting nor tail (e.g. the former
// reference_images) are removed from loaded workflows.
const TAIL_OUTPUTS = [];
const REF_DEFAULTS = { fit: "pad" };
const REF_FITS = ["pad", "crop", "stretch"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function viewUrl(ref) {
    const p = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder || "",
        type: ref.type || "input",
    });
    return api.apiURL("/view?" + p.toString());
}

function loadImageEl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Inpaint Canvas: could not load " + src));
        img.src = src;
    });
}

function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function hashBlob(blob) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadBlob(blob, filename, { overwrite = true, type = "input", subfolder = SUBFOLDER } = {}) {
    const form = new FormData();
    form.append("image", new File([blob], filename, { type: "image/png" }));
    form.append("subfolder", subfolder);
    form.append("type", type);
    if (overwrite) form.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (resp.status !== 200) {
        throw new Error("Inpaint Canvas: upload failed (" + resp.status + ")");
    }
    const data = await resp.json();
    return { filename: data.name, subfolder: data.subfolder || subfolder, type: data.type || type };
}

async function uploadCanvas(canvas, prefix) {
    const blob = await canvasToBlob(canvas);
    const hash = await hashBlob(blob);
    return { ref: await uploadBlob(blob, `${prefix}_${hash}.png`), hash };
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** JSON with every non-ASCII character escaped, so it fits a Latin-1 tEXt chunk unchanged. */
function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Insert tEXt chunks (keyword -> text) right after IHDR, the way ComfyUI's SaveImage stores prompt and workflow. */
function pngWithText(buffer, texts) {
    const src = new Uint8Array(buffer);
    const ihdrEnd = 8 + 4 + 4 + 13 + 4;
    const chunks = [];
    for (const [key, value] of Object.entries(texts)) {
        const payload = new TextEncoder().encode(key + "\0" + value);   // ASCII in, ASCII out (asciiJson)
        const chunk = new Uint8Array(12 + payload.length);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, payload.length);
        chunk.set([0x74, 0x45, 0x58, 0x74], 4);   // tEXt
        chunk.set(payload, 8);
        dv.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));
        chunks.push(chunk);
    }
    const total = src.length + chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    out.set(src.subarray(0, ihdrEnd), 0);
    let pos = ihdrEnd;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    out.set(src.subarray(ihdrEnd), pos);
    return new Blob([out], { type: "image/png" });
}

function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
}

function imageToCanvas(img, w, h) {
    const c = makeCanvas(w || img.naturalWidth, h || img.naturalHeight);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function numberInput(value, min, max, title, width = 58) {
    const i = document.createElement("input");
    i.type = "number";
    i.value = value; i.min = min; i.max = max; i.title = title;
    i.className = "ipc-num";
    i.style.width = width + "px";
    i.addEventListener("keydown", (e) => e.stopPropagation());
    return i;
}

function selectInput(options, value, title) {
    const s = document.createElement("select");
    s.className = "ipc-sel";
    s.title = title;
    for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        s.appendChild(opt);
    }
    s.value = value;
    s.addEventListener("click", (e) => e.stopPropagation());
    s.addEventListener("keydown", (e) => e.stopPropagation());
    return s;
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * `feature` is a Uint8Array with 1 where the feature is; returns Float32Array of
 * squared distances to the nearest feature pixel.
 */
function distanceTransform(feature, W, H) {
    const INF = 1e20;
    const f = new Float32Array(Math.max(W, H));
    const d = new Float32Array(Math.max(W, H));
    const v = new Int32Array(Math.max(W, H));
    const z = new Float32Array(Math.max(W, H) + 1);
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = feature[i] ? 0 : INF;
    const edt1d = (n) => {
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < n; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) {
            while (z[k + 1] < q) k++;
            d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
        }
    };
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) f[y] = out[y * W + x];
        edt1d(H);
        for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) f[x] = out[y * W + x];
        edt1d(W);
        for (let x = 0; x < W; x++) out[y * W + x] = d[x];
    }
    return out;
}

// ---------------------------------------------------------------------------
// geometry helpers for the transform tool
// ---------------------------------------------------------------------------

/** 3x3 homography mapping four source points onto four destination points. */
function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = src[i], [X, Y] = dst[i];
        A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
        const d = A[c][c] || 1e-12;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = A[r][c] / d;
            if (!f) continue;
            for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    const h = b.map((v, i) => v / (A[i][i] || 1e-12));
    return (x, y) => {
        const w = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
    };
}

/** Draw `img` so that source triangle s0..s2 lands on destination triangle d0..d2. */
function drawTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
    const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2;
    const [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(det) < 1e-9) return;
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
    const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    const d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    const e = u0 - a * x0 - c * y0;
    const f = v0 - b * x0 - d * y0;
    // Expand the clip a hair from the centroid so neighbouring triangles leave no seams.
    const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3;
    const grow = (px, py) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px + dx / l * 0.7, py + dy / l * 0.7]; };
    const g0 = grow(u0, v0), g1 = grow(u1, v1), g2 = grow(u2, v2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g0[0], g0[1]); ctx.lineTo(g1[0], g1[1]); ctx.lineTo(g2[0], g2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

/**
 * Draw `img` through a deformation: `dst(u, v)` gives the destination point for
 * the normalised source position (u, v) in [0, 1]. The image is split into an
 * nx by ny mesh of triangle pairs.
 */
function drawMesh(ctx, img, dst, nx, ny) {
    const W = img.width, H = img.height;
    const pts = [];
    for (let j = 0; j <= ny; j++) {
        const row = [];
        for (let i = 0; i <= nx; i++) row.push(dst(i / nx, j / ny));
        pts.push(row);
    }
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const sx0 = i / nx * W, sx1 = (i + 1) / nx * W, sy0 = j / ny * H, sy1 = (j + 1) / ny * H;
            const d00 = pts[j][i], d10 = pts[j][i + 1], d01 = pts[j + 1][i], d11 = pts[j + 1][i + 1];
            drawTriangle(ctx, img, [sx0, sy0], [sx1, sy0], [sx0, sy1], d00, d10, d01);
            drawTriangle(ctx, img, [sx1, sy0], [sx1, sy1], [sx0, sy1], d10, d11, d01);
        }
    }
}

// ---------------------------------------------------------------------------
// text segmentation backends (each builds a small standalone prompt)
// ---------------------------------------------------------------------------

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
            const t = window.LiteGraph && LiteGraph.registered_node_types["CheckpointLoaderSimple"];
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
const GEN_DEFAULTS = { mode: "api", denoise: 1.0, seed: 0, seedRandom: true, refine: false };
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
    const types = (window.LiteGraph && LiteGraph.registered_node_types) || {};
    return UPSAMPLE_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]));
}

const UPSAMPLE_CASES = ["auto", "fill", "add", "remove", "edit", "outpaint"];

/** Short noun phrase for a segmentation model, derived from the user's prompt by a VLM. */
function segmentTermInstruction(promptText) {
    // Two explicit steps: with a single question the 2B model copies German words unchanged.
    return `Step 1: translate this request to English: "${promptText}". Step 2: name the one object in the picture that the request is about, as it looks now, in English, 1 to 3 words, plain nouns only (examples: swimsuit, hair, wooden chair, background). Output only the words of step 2, nothing else.`;
}

function upsampleInstruction(useCase, text, region, hint) {
    // Kept short and with the request repeated at the end: small VLMs (Qwen3-VL 2B)
    // drop the request when it is buried in a long preamble.
    const req = text ? `"${text}"` : "(no request given: infer the most plausible content from the picture)";
    // what the selection contains, when it came from a text segmentation
    const look = `Look at the image.${hint ? ` ${region[0].toUpperCase()}${region.slice(1)} currently shows: ${hint}.` : ""}`;
    const rules = `Rules: obey the request exactly and translate it to English if needed (Seide = silk, Leder = leather); if the request names a colour or material, the prompt must use exactly that colour and material even though the picture currently shows something else; describe only the final content as a direct description of what is seen; the ${region.includes("green") ? "green area" : "magenta outline"} is only a marker, never mention it, the region or the image; no lists, no preamble, no quotes, no negative prompt. Output only the prompt text.`;
    const tail = `Request again: ${req}`;
    switch (useCase) {
        case "add":
            return `${look} Something new will be painted into ${region} according to this request: ${req}. Write the image-generation prompt for it: one English paragraph of 40 to 80 words, starting with the requested object, then its shape, material and colour, then how it sits in the scene (size relative to the surroundings, contact with surfaces, cast shadows) under the same lighting and perspective as the rest of the picture. ${rules} ${tail}`;
        case "remove":
            return `${look} Whatever ${region} contains will be erased as if it had never been there${text ? `; request: ${req}` : ""}. Write the image-generation prompt for that spot: one English paragraph of 30 to 60 words describing only what would be visible with the object gone, the background, surfaces, body or textures continuing naturally from the surroundings. The object that is there now must not appear in the prompt and the word remove must not be used. ${rules}`;
        case "edit":
            return `You write instructions for an image editing model. Request: ${req}. ${look} Rewrite the request as one English instruction of 15 to 35 words for the editing model: start with a verb, name the subject as it appears in the picture (the woman, the red car, the wall), apply exactly the requested change with the exact colours, materials or objects named in the request, and end with what must stay unchanged. Do not describe the picture, do not describe the current state, do not add a story or mood. Examples: request "change her haircolor to light blue" -> "Change the woman's hair color to light blue, keeping her hairstyle, face, expression, skin, clothing, pose, lighting and background exactly as they are." Request "mach den Stuhl aus Holz" -> "Make the chair out of natural wood with visible grain, keeping its shape, position, the person sitting on it and the rest of the scene unchanged." Output only the instruction. Request again: ${req}`;
        case "outpaint":
            return `${look} ${region[0].toUpperCase()}${region.slice(1)} lies at the border and the scene will be extended beyond it${text ? `; request: ${req}` : ""}. Write the image-generation prompt for the extension: one English paragraph of 40 to 80 words describing what appears further out, continuing the same environment, perspective, lighting and style without a visible seam. ${rules} ${tail}`;
        default:
            return `${look} ${region[0].toUpperCase()}${region.slice(1)} will be repainted according to this request: ${req}. Write the image-generation prompt for that area: one English paragraph of 40 to 80 words, starting with the requested subject, then its materials and colours, then how its lighting, perspective and scale match the surroundings so the result blends in. ${rules} ${tail}`;
    }
}

function availableSegmentBackends() {
    const types = (window.LiteGraph && LiteGraph.registered_node_types) || {};
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
    const types = (window.LiteGraph && LiteGraph.registered_node_types) || {};
    return CUTOUT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]));
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
    const types = (window.LiteGraph && LiteGraph.registered_node_types) || {};
    return OBJECT_BACKEND.needs.every((n) => !!types[n]);
}

// ---------------------------------------------------------------------------
// icons (24x24, stroke based)
// ---------------------------------------------------------------------------

const ICONS = {
    select: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M11 9v6"/><path d="M8 12h6"/>',
    deselect: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M8 12h6"/>',
    loop: '<circle cx="12" cy="12" r="7" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2"/>',
    lasso: '<path d="M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5z"/><path d="M6 12.5c-1 2 0 3.5 2 3.5s3 1.5 2 4"/>',
    object: '<path d="M4 9c0-3 3-5 6-5s6 1 6 4-2 3-2 5 1 3-1 4-4 1-6-1-3-4-3-7z" stroke-dasharray="3 2"/><path d="M13 12l7 3-3 1-1 3z" fill="currentColor" stroke="none"/>',
    paint: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/><path d="M5 19c-1 0-2-1-2-2"/>',
    erase: '<path d="M4 15l8-8 6 6-5 5H8z"/><path d="M13 21h7"/>',
    fill: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M12 4v6"/><path d="M19 15c0 2-1 3-2 4-1-1-2-2-2-4 0-1 2-3 2-3s2 2 2 3z" fill="currentColor" stroke="none"/>',
    transform: '<rect x="6" y="6" width="12" height="12"/><rect x="3" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="3" y="17" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="17" width="4" height="4" fill="currentColor" stroke="none"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5"/><path d="M11 11V4.5a1.5 1.5 0 013 0V11"/><path d="M14 11V6a1.5 1.5 0 013 0v7"/><path d="M8 12v0a1.5 1.5 0 00-3 1l2 5a4 4 0 004 3h3a4 4 0 004-4v-4"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    clear: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    invert: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>',
    ants: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><rect x="8" y="8" width="8" height="8" fill="currentColor" stroke="none" opacity=".35"/>',
    fit: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
    flatten: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
    load: '<path d="M4 17v3h16v-3"/><path d="M12 4v11"/><path d="M7 9l5-5 5 5"/>',
    play: '<path d="M7 4l12 8-12 8z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M10 6.3A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.4"/><path d="M6.6 8.6C4 10.4 2 12 2 12s4 6 10 6a10 10 0 003-.5"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12 8l4 4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    up: '<path d="M6 14l6-6 6 6"/>',
    down: '<path d="M6 10l6 6 6-6"/>',
    solo: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    restore: '<path d="M4 12a8 8 0 108-8"/><path d="M4 4v5h5"/>',
    grow: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
    shrink: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" stroke-dasharray="3 2"/><path d="M12 5v3"/><path d="M12 16v3"/><path d="M5 12h3"/><path d="M16 12h3"/>',
    fromLayer: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 14l8 4 8-4" stroke-dasharray="3 2"/>',
    rotate: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 3v5h-5"/>',
    distort: '<path d="M5 6l14-2v14l-14 2z"/><circle cx="5" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="4" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="5" cy="20" r="1.6" fill="currentColor" stroke="none"/>',
    warp: '<path d="M4 6c4-3 12 3 16 0"/><path d="M4 12c4-3 12 3 16 0"/><path d="M4 18c4-3 12 3 16 0"/><path d="M8 4v16"/><path d="M16 4v16"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    refine: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 3v5h-5"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.5" fill="currentColor" stroke="none"/>',
    magic: '<path d="M4 20l10-10"/><path d="M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none"/><path d="M19 9l.7 1.3L21 11l-1.3.7L19 13l-.7-1.3L17 11l1.3-.7z" fill="currentColor" stroke="none"/><path d="M14 8l2 2"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.3 15.7"/><path d="M8.3 8.3L20 20"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M21 16l-5-5-8 8"/>',
    mask: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
    maskEdit: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16l6-6 2 2-6 6H8z" fill="currentColor" stroke="none"/><path d="M15 9l1-1 2 2-1 1"/>',
    fx: '<path d="M4 6h9"/><path d="M19 6h1"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M12 12h8"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><circle cx="18" cy="18" r="2"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="14" width="8" height="6"/>',
    download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
    broom: '<path d="M14 3l7 7"/><path d="M17.5 6.5L9 15"/><path d="M9 15l-5 5"/><path d="M6 12l6 6"/><path d="M11 13l-4 8"/>',
    extend: '<rect x="8" y="8" width="8" height="8"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M10 4l2-2 2 2"/><path d="M10 20l2 2 2-2"/><path d="M4 10l-2 2 2 2"/><path d="M20 10l2 2-2 2"/>',
};

function icon(name, size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function iconButton(name, title, onClick, label) {
    const b = el("button", "ipc-ib");
    b.type = "button";
    b.title = title;
    b.innerHTML = icon(name) + (label ? `<span>${label}</span>` : "");
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); onClick(e); });
    return b;
}

function miniButton(name, title, onClick, cls = "") {
    const b = el("button", "ipc-mini " + cls);
    b.type = "button";
    b.title = title;
    b.innerHTML = icon(name, 16);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}

// ---------------------------------------------------------------------------
// styles (injected once)
// ---------------------------------------------------------------------------

const STYLE = `
.ipc-node { display:flex; flex-direction:column; gap:6px; width:100%; height:100%; box-sizing:border-box; padding:4px;
  color:#ccc; font:12px/1.3 system-ui, sans-serif; }
.ipc-node .ipc-thumb { flex:1; min-height:80px; width:100%; border-radius:6px; background:#1a1a1a; cursor:pointer;
  display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; }
.ipc-node .ipc-thumb canvas { max-width:100%; max-height:100%; display:block; }
.ipc-node .ipc-thumb .ipc-hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  text-align:center; color:#777; padding:12px; pointer-events:none; white-space:pre-line; }
.ipc-node .ipc-open { display:flex; align-items:center; justify-content:center; gap:8px; padding:7px 10px; border-radius:6px;
  background:#2f5f9f; color:#fff; border:1px solid #4a90d9; cursor:pointer; font:inherit; font-weight:600; }
.ipc-node .ipc-open:hover { background:#3a70b8; }
.ipc-node .ipc-status { color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.ipc-modal [hidden] { display:none !important; }
.ipc-modal { position:fixed; inset:0; z-index:10000; display:flex; flex-direction:column; background:#181818; color:#ddd;
  font:13px/1.3 system-ui, sans-serif; outline:none; }
.ipc-top { display:flex; align-items:center; gap:10px; padding:6px 10px; background:#242424; border-bottom:1px solid #0d0d0d; flex-wrap:wrap; }
.ipc-top .ipc-title { font-weight:600; margin-right:6px; }
.ipc-top .ipc-grow { flex:1; }
.ipc-top label { display:flex; align-items:center; gap:6px; color:#aaa; font-size:12px; }
.ipc-top label span { min-width:36px; text-align:right; color:#ccc; }
.ipc-top input[type=range] { width:100px; }
.ipc-top input[type=color] { width:34px; height:26px; padding:0; border:1px solid #4a4a4a; border-radius:5px; background:#333; cursor:pointer; }
.ipc-ib { display:inline-flex; align-items:center; justify-content:center; gap:6px; background:#333; color:#ddd; border:1px solid #4a4a4a;
  border-radius:6px; padding:5px 8px; cursor:pointer; font:inherit; min-width:32px; }
.ipc-ib:hover { background:#444; color:#fff; }
.ipc-ib.ipc-active { background:#2f5f9f; border-color:#4a90d9; color:#fff; }
.ipc-ib.ipc-toggle-on { background:#3d3d2a; border-color:#a08a2a; color:#ffd166; }
.ipc-ib.ipc-primary { background:#2f7f4f; border-color:#3fa76a; color:#fff; padding:5px 12px; }
.ipc-ib.ipc-primary:hover { background:#39955d; }
.ipc-ib.ipc-danger:hover { background:#7a2f2f; }
.ipc-ib.ipc-small { padding:3px 7px; font-size:12px; min-width:0; }
.ipc-body { display:flex; flex:1; min-height:0; }
.ipc-tools { display:flex; flex-direction:column; gap:4px; padding:6px; background:#202020; border-right:1px solid #0d0d0d; overflow:auto; }
.ipc-tools .ipc-ib { width:38px; height:36px; padding:0; }
.ipc-tools .ipc-sep { height:1px; background:#3a3a3a; margin:4px 2px; }
.ipc-tools .ipc-grp { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:#666; text-align:center; margin:2px 0 -1px; }
.ipc-view { flex:1; position:relative; overflow:hidden; min-width:0; cursor:crosshair;
  background-color:#2b2b2b;
  background-image: linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),
    linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%);
  background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
.ipc-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }
.ipc-view.ipc-pan { cursor:grab; }
.ipc-view.ipc-panning { cursor:grabbing; }
.ipc-view.ipc-move { cursor:move; }
.ipc-view.ipc-scale { cursor:nwse-resize; }
.ipc-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center;
  color:#888; pointer-events:none; padding:20px; white-space:pre-line; font-size:15px; }
.ipc-side { width:290px; display:flex; flex-direction:column; background:#202020; border-left:1px solid #0d0d0d; overflow:auto; }
.ipc-side h4, .ipc-side summary { margin:0; padding:6px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#999; background:#262626;
  border-bottom:1px solid #0d0d0d; border-top:1px solid #0d0d0d; display:flex; align-items:center; gap:6px; cursor:default; list-style:none; }
.ipc-side summary { cursor:pointer; }
.ipc-side summary::-webkit-details-marker { display:none; }
.ipc-side summary::before { content:"▸"; color:#666; font-size:10px; }
.ipc-side details[open] > summary::before { content:"▾"; }
.ipc-side h4 .ipc-grow, .ipc-side summary .ipc-grow { flex:1; }
.ipc-side h4 .ipc-mini { width:24px; height:22px; }
.ipc-sec { padding:8px 10px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:#aaa; font-size:12px; }
.ipc-sec .ipc-seg { display:flex; gap:6px; width:100%; align-items:center; }
.ipc-sec .ipc-seg input[type=text] { flex:1; min-width:0; background:#161616; color:#ddd; border:1px solid #3a3a3a; border-radius:4px; padding:4px 6px; font:inherit; }
.ipc-sec .ipc-seg input[type=text]:focus { outline:none; border-color:#4a90d9; }
.ipc-sec .ipc-modes { display:flex; gap:2px; }
.ipc-sec .ipc-modes .ipc-ib { padding:2px 7px; min-width:0; font-size:11px; border-radius:4px; }
.ipc-sec .ipc-row4 { display:grid; grid-template-columns:auto 1fr auto 1fr; gap:4px 6px; align-items:center; width:100%; }
.ipc-num { background:#161616; color:#ddd; border:1px solid #3a3a3a; border-radius:4px; padding:3px 5px; font:inherit; }
.ipc-sel { background:#161616; color:#ccc; border:1px solid #3a3a3a; border-radius:4px; padding:2px 4px; font:11px system-ui, sans-serif; max-width:110px; }
.ipc-list { overflow:auto; flex:none; min-height:90px; max-height:42vh; }
.ipc-layer { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-bottom:1px solid #161616; cursor:pointer; }
.ipc-layer:hover { background:#262b33; }
.ipc-layer.ipc-selected { background:#2b3a4f; box-shadow: inset 3px 0 0 #4a90d9; }
.ipc-layer .ipc-row { display:flex; align-items:center; gap:4px; }
.ipc-layer .ipc-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-layer .ipc-kind { font-size:10px; color:#777; text-transform:uppercase; }
.ipc-layer .ipc-kind.ipc-ctrl { color:#ffb347; }
.ipc-layer .ipc-kind.ipc-ref { color:#7cc7ff; }
.ipc-layer .ipc-kind.ipc-fxk { color:#c7a2ff; }
.ipc-fx { display:grid; grid-template-columns:auto 1fr auto; gap:3px 6px; align-items:center; font-size:11px; color:#888; }
.ipc-fx .ipc-sel { grid-column:1 / -1; max-width:none; }
.ipc-fx input[type=range] { width:100%; min-width:0; margin:0; }
.ipc-fx b { width:42px; text-align:right; font-weight:500; color:#bbb; }
.ipc-fx .ipc-lutrow { grid-column:1 / -1; display:flex; gap:6px; align-items:center; min-width:0; }
.ipc-fx .ipc-lutrow span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aaa; }
.ipc-layer .ipc-maskrow { display:flex; align-items:center; gap:2px; color:#888; font-size:11px; }
.ipc-layer .ipc-maskrow .ipc-sel { max-width:96px; }
.ipc-layer .ipc-maskrow .ipc-grow { flex:1; }
.ipc-mini.ipc-on { background:#2b3a4f; color:#7cc7ff; }
.ipc-list.ipc-dropping { outline:2px dashed #7cc7ff; outline-offset:-2px; }
.ipc-mini { display:inline-flex; align-items:center; justify-content:center; width:26px; height:24px; border-radius:4px;
  cursor:pointer; color:#bbb; background:transparent; border:none; padding:0; flex:none; }
.ipc-mini:hover { background:#3a3a3a; color:#fff; }
.ipc-mini.ipc-off { color:#555; }
.ipc-mini.ipc-del:hover { color:#f66; }
.ipc-mini:disabled { opacity:.25; cursor:default; }
.ipc-layer .ipc-op { display:flex; align-items:center; gap:6px; color:#888; font-size:11px; }
.ipc-layer .ipc-op input[type=range] { flex:1; margin:0; }
.ipc-layer .ipc-op b { width:34px; text-align:right; font-weight:500; color:#bbb; }
.ipc-layer .ipc-op label { display:flex; align-items:center; gap:4px; }
.ipc-prompt { padding:8px; }
.ipc-prompt textarea { width:100%; box-sizing:border-box; min-height:80px; resize:vertical; background:#161616; color:#ddd; border:1px solid #3a3a3a;
  border-radius:6px; padding:6px 8px; font:13px/1.35 system-ui, sans-serif; }
.ipc-prompt textarea:focus { outline:none; border-color:#4a90d9; }
.ipc-hist { max-height:30vh; overflow:auto; }
.ipc-hitem { display:flex; align-items:center; gap:8px; padding:5px 8px; border-bottom:1px solid #161616; }
.ipc-hitem.ipc-gone { opacity:.55; }
.ipc-hitem canvas { width:56px; height:56px; object-fit:contain; background:#111; border-radius:4px; flex:none; cursor:pointer; }
.ipc-hitem .ipc-htext { flex:1; min-width:0; font-size:11px; color:#aaa; }
.ipc-hitem .ipc-htext b { display:block; color:#ddd; font-weight:500; }
.ipc-hitem .ipc-htext span { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ipc-info { padding:8px 10px; color:#aaa; display:grid; grid-template-columns:auto 1fr; gap:3px 10px; }
.ipc-upsample { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ipc-gen { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
.ipc-gen label { display:flex; align-items:center; gap:6px; }
.ipc-gen input[type=range] { width:120px; margin:0; }
.ipc-gen b { min-width:32px; font-weight:500; color:#ccc; }
.ipc-settings { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; align-items:center; }
.ipc-settings label { display:contents; }
.ipc-settings .ipc-sel, .ipc-settings input[type=text] { min-width:0; width:100%; }
.ipc-mode { margin-right:6px; }
.ipc-cropset { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; align-items:center; }
.ipc-cropset label { display:contents; }
.ipc-info b { color:#ddd; font-weight:500; }
.ipc-bottom { padding:5px 10px; background:#242424; border-top:1px solid #0d0d0d; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; }
.ipc-kbd { color:#777; margin-left:auto; }
.ipc-view.ipc-scale-x { cursor:ew-resize; }
.ipc-view.ipc-scale-y { cursor:ns-resize; }
.ipc-view.ipc-rotate { cursor:alias; }
.ipc-subbar { position:absolute; top:8px; left:8px; z-index:2; display:flex; align-items:center; gap:6px; padding:5px 8px;
  background:rgba(30,30,30,.92); border:1px solid #3a3a3a; border-radius:8px; color:#ccc; font-size:12px; }
.ipc-subbar .ipc-ib { padding:3px 8px; min-width:0; font-size:12px; }
.ipc-subbar .ipc-sep { width:1px; height:18px; background:#444; margin:0 2px; }
.ipc-subbar label { display:flex; align-items:center; gap:4px; color:#aaa; }
.ipc-subbar .ipc-hint { color:#888; }
`;

function injectStyle() {
    if (document.getElementById("ipc-style")) return;
    const s = document.createElement("style");
    s.id = "ipc-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

class InpaintEditor {
    constructor(node) {
        this.node = node;
        this.width = 0;
        this.height = 0;
        this.base = null;            // { ref, img }
        this.layers = [];            // { id, name, kind, role, blend, ref, canvas, x, y, w, h, opacity, visible, dirty,
                                     //   mask (canvas, alpha = visible) | null, maskRef, maskDirty, maskEdit }
        this.activeLayerId = null;   // null = base
        this.selection = null;       // canvas WxH, red pixels where selected
        this.history = [];           // { key, ref, x, y, w, h, prompt, layerId, thumb }
        this.view = { scale: 1, x: 0, y: 0 };
        this.tool = "select";
        this.brushSize = 40;
        this.hardness = 1;
        this.eraseHardness = 0.5;       // the eraser is soft by default, like Krita's Eraser Soft
        try {
            const h = parseFloat(localStorage.getItem("ipc.hardness")), e = parseFloat(localStorage.getItem("ipc.eraseHardness"));
            if (h >= 0 && h <= 1) this.hardness = h;
            if (e >= 0 && e <= 1) this.eraseHardness = e;
        } catch (_) { /* no storage */ }
        this.brushOpacity = 1;
        this.color = "#ff3b30";
        this.fillEnclosed = true;
        this.promptText = "";
        this.cropSettings = { ...CROP_DEFAULTS };
        this.upsampleSettings = { useCase: "auto", backend: "auto" };
        this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed() };
        this.negativeText = "";
        this.settings = {};             // {"1": {value, type, label}, ...} for the setting_n outputs
        this.refSettings = { ...REF_DEFAULTS };   // reference_images batch: long side, fit
        this.cutoutSettings = { backend: "auto" };
        this.cutoutPending = null;      // {layer, backend} while a background removal runs
        this.promptBackup = null;
        this.selectionLabel = "";       // what the selection is, when it came from "Select by text"
        this.undo = [];
        this.redo = [];
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.cachedBounds = null;
        this.compositeVersion = 0;      // bumped whenever the composite changes (filter caches key on it)
        this.uploaded = this.makeUploaded();
        this.filterCounter = 0;
        this.filterPreview = null;      // id of the filter layer whose slider is being dragged (low-res preview)
        this.seenResults = new Set();
        this.layerCounter = 0;
        this.paintCounter = 0;
        this.pointer = null;
        this.lassoPoints = null;
        this.hover = null;
        this.objects = null;            // {hash, w, h, ids: Uint16Array, count, layerId}
        this.objectsPending = null;
        this.objectShapeCache = new Map();
        this.hoverObjectId = 0;
        this.hoverObjectCanvas = null;
        let selDisplay = "ants";
        try { selDisplay = localStorage.getItem("ipc.selectionDisplay") || "ants"; } catch (_) { /* no storage */ }
        this.selectionDisplay = selDisplay === "tint" ? "tint" : "ants";   // marching ants (default) or red tint
        this.status = "No image loaded.";
        this.isOpen = false;

        injectStyle();
        this.buildNodeWidget();
        this.buildModal();
    }

    // ---- node widget (thumbnail + button) --------------------------------

    buildNodeWidget() {
        const root = el("div", "ipc-node");
        this.nodeRoot = root;
        const thumbWrap = el("div", "ipc-thumb");
        this.thumb = document.createElement("canvas");
        this.thumb.width = 4; this.thumb.height = 4;
        thumbWrap.appendChild(this.thumb);
        this.thumbHint = el("div", "ipc-hint", "No image yet.\nOpen the editor to load one.");
        thumbWrap.appendChild(this.thumbHint);
        thumbWrap.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        thumbWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
        root.appendChild(thumbWrap);

        const openBtn = el("button", "ipc-open");
        openBtn.type = "button";
        openBtn.innerHTML = icon("edit") + "<span>Open editor</span>";
        openBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        openBtn.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        root.appendChild(openBtn);

        this.nodeStatus = el("div", "ipc-status", this.status);
        root.appendChild(this.nodeStatus);

        root.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        root.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f && f.type.startsWith("image/")) this.loadFile(f);
        });
        root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

        this.thumbObserver = new ResizeObserver(() => this.drawThumb());
        this.thumbObserver.observe(thumbWrap);
    }

    drawThumb() {
        const wrap = this.thumb.parentElement;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        if (!this.base || rect.width < 4 || rect.height < 4) {
            this.thumb.width = 4; this.thumb.height = 4;
            this.thumbHint.style.display = this.base ? "none" : "flex";
            return;
        }
        this.thumbHint.style.display = "none";
        const dpr = window.devicePixelRatio || 1;
        const s = Math.min(rect.width / this.width, rect.height / this.height, 1) * dpr;
        const w = Math.max(1, Math.round(this.width * s));
        const h = Math.max(1, Math.round(this.height * s));
        if (this.thumb.width !== w || this.thumb.height !== h) {
            this.thumb.width = w; this.thumb.height = h;
        }
        this.thumb.style.width = (w / dpr) + "px";
        this.thumb.style.height = (h / dpr) + "px";
        const ctx = this.thumb.getContext("2d");
        ctx.setTransform(w / this.width, 0, 0, h / this.height, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        this.drawComposite(ctx);
        if (this.selection) {
            ctx.globalAlpha = 0.45;
            ctx.drawImage(this.selection, 0, 0);
            ctx.globalAlpha = 1;
        }
    }

    // ---- modal -------------------------------------------------------------

    buildModal() {
        const root = el("div", "ipc-modal");
        root.tabIndex = 0;
        this.root = root;

        // top bar
        const top = el("div", "ipc-top");
        top.appendChild(el("span", "ipc-title", "Inpaint Canvas"));
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.accept = "image/*";
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", () => {
            const f = this.fileInput.files && this.fileInput.files[0];
            if (f) this.loadFile(f);
            this.fileInput.value = "";
        });
        top.appendChild(this.fileInput);
        top.appendChild(iconButton("load", "Load an image as the base layer (Ctrl+V or drop also works)", () => this.fileInput.click(), "Load"));
        top.appendChild(iconButton("save", "Save the finished image (Ctrl+S): all visible layers with their filters, without control and reference layers, into ComfyUI's output folder. Name and format in the Canvas section.", () => this.exportImage(), "Save"));

        const slider = (label, min, max, value, fmt, onInput) => {
            const lab = el("label", null, label);
            const inp = document.createElement("input");
            inp.type = "range"; inp.min = min; inp.max = max; inp.value = value;
            const val = el("span", null, fmt(value));
            inp.addEventListener("input", () => { onInput(+inp.value); val.textContent = fmt(+inp.value); });
            lab.appendChild(inp); lab.appendChild(val);
            top.appendChild(lab);
            return { input: inp, value: val };
        };
        this.sizeCtl = slider("Size", 2, 400, this.brushSize, (v) => v + "px", (v) => { this.brushSize = v; this.draw(); });
        this.hardCtl = slider("Hardness", 0, 100, Math.round(this.hardness * 100), (v) => v + "%", (v) => {
            // the slider edits the hardness of the active tool: the eraser has its own
            if (this.tool === "erase") this.eraseHardness = v / 100; else this.hardness = v / 100;
            try { localStorage.setItem(this.tool === "erase" ? "ipc.eraseHardness" : "ipc.hardness", String(v / 100)); } catch (_) { /* ignore */ }
        });
        this.hardCtl.input.title = "Brush hardness. The eraser keeps its own value (soft by default); the slider shows the active tool's.";
        this.opacCtl = slider("Opacity", 1, 100, 100, (v) => v + "%", (v) => { this.brushOpacity = v / 100; });

        const colorLabel = el("label", null, "Color");
        this.colorInput = document.createElement("input");
        this.colorInput.type = "color";
        this.colorInput.value = this.color;
        this.colorInput.title = "Paint color";
        this.colorInput.addEventListener("input", () => { this.color = this.colorInput.value; });
        colorLabel.appendChild(this.colorInput);
        top.appendChild(colorLabel);

        top.appendChild(el("span", "ipc-grow"));
        this.modeSel = selectInput(["api", "local"], "api", "Which chain the result comes back from: API = the result input, Local = the result_local input. Only that chain runs.");
        this.modeSel.classList.add("ipc-mode");
        this.modeSel.addEventListener("change", () => { this.genSettings.mode = this.modeSel.value; this.syncGenControls(); this.renderInfo(); this.notifyChanged(); });
        top.appendChild(this.modeSel);
        this.generateBtn = iconButton("play", "Queue the workflow (Ctrl+Enter). The result comes back as a new layer.", () => this.generate(), "Generate");
        this.generateBtn.classList.add("ipc-primary");
        top.appendChild(this.generateBtn);
        const closeBtn = iconButton("close", "Close editor (Esc)", () => this.close());
        closeBtn.classList.add("ipc-danger");
        top.appendChild(closeBtn);
        root.appendChild(top);

        // body
        const body = el("div", "ipc-body");

        const tools = el("div", "ipc-tools");
        this.toolButtons = {};
        const addTool = (id, title) => {
            const b = iconButton(id, title, () => this.setTool(id));
            this.toolButtons[id] = b;
            tools.appendChild(b);
        };
        tools.appendChild(el("div", "ipc-grp", "Select"));
        addTool("select", "Paint selection (B): adds to the selection, Alt subtracts");
        addTool("rect", "Rectangle selection (R): replaces the selection, Shift adds, Alt subtracts");
        addTool("lasso", "Lasso selection (L): replaces the selection, Shift adds, Alt subtracts");
        addTool("object", "Object selection (O): hover to see objects, click to select, click again to deselect. Shift adds, Alt subtracts.");
        addTool("deselect", "Erase from selection (D)");
        this.loopBtn = iconButton("loop", "Close loops (Photoshop-style): end a brush stroke where it started and the inside is filled too. Also for the subtract brush.", () => {
            this.fillEnclosed = !this.fillEnclosed;
            this.loopBtn.classList.toggle("ipc-toggle-on", this.fillEnclosed);
            this.setStatus(this.fillEnclosed ? "Close loops on: end a stroke where it started to fill the inside." : "Close loops off.");
        });
        this.loopBtn.classList.toggle("ipc-toggle-on", this.fillEnclosed);
        tools.appendChild(this.loopBtn);
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(el("div", "ipc-grp", "Layer"));
        addTool("paint", "Paint on the active layer (P). On the base it creates a paint layer.");
        addTool("erase", "Erase from the active layer (E)");
        tools.appendChild(iconButton("fill", "Fill the selection with the color on the active layer (Shift+F)", () => this.fillSelection()));
        addTool("transform", "Move / scale the active layer (T). Drag corners to scale, Shift for free aspect.");
        addTool("hand", "Pan (H, Space or middle mouse)");
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("undo", "Undo (Ctrl+Z)", () => this.undoStep()));
        tools.appendChild(iconButton("redo", "Redo (Ctrl+Shift+Z)", () => this.redoStep()));
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("clear", "Clear selection (Ctrl+D)", () => this.clearSelection()));
        tools.appendChild(iconButton("invert", "Invert selection (Ctrl+I)", () => this.invertSelection()));
        this.antsBtn = iconButton("ants", "Selection display: marching ants outline (on) or red tint (off)", () => {
            this.selectionDisplay = this.selectionDisplay === "ants" ? "tint" : "ants";
            try { localStorage.setItem("ipc.selectionDisplay", this.selectionDisplay); } catch (_) { /* ignore */ }
            this.antsBtn.classList.toggle("ipc-toggle-on", this.selectionDisplay === "ants");
            this.draw();
            this.setStatus(this.selectionDisplay === "ants" ? "Selection shown as an outline." : "Selection shown as a red tint.");
        });
        this.antsBtn.classList.toggle("ipc-toggle-on", this.selectionDisplay === "ants");
        tools.appendChild(this.antsBtn);
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("fit", "Fit to view (F)", () => this.fitView()));
        tools.appendChild(iconButton("flatten", "Flatten all visible layers into the base", () => this.flatten()));
        body.appendChild(tools);

        this.viewEl = el("div", "ipc-view");
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d");
        this.viewEl.appendChild(this.canvas);
        this.dropHint = el("div", "ipc-drop", "Load an image, paste it (Ctrl+V) or drop it here.\nThen paint a selection and press Generate.\nDrop with Shift, or onto the layer list, to add reference images.");
        this.viewEl.appendChild(this.dropHint);
        this.buildSubbar();
        body.appendChild(this.viewEl);

        // side panel
        const side = el("div", "ipc-side");
        const section = (title, open, build) => {
            const d = document.createElement("details");
            d.open = open;
            const sum = el("summary", null, title);
            d.appendChild(sum);
            build(d, sum);
            side.appendChild(d);
            return d;
        };

        const layersHead = el("h4", null, "Layers");
        layersHead.appendChild(el("span", "ipc-grow"));
        this.refInput = document.createElement("input");
        this.refInput.type = "file";
        this.refInput.accept = "image/*";
        this.refInput.multiple = true;
        this.refInput.style.display = "none";
        this.refInput.addEventListener("change", () => {
            const files = Array.from(this.refInput.files || []);
            this.refInput.value = "";
            if (files.length) this.addImageLayers(files, "reference");
        });
        layersHead.appendChild(this.refInput);
        layersHead.appendChild(miniButton("image", "Add reference images (one layer per file, role \"reference\"). They are not part of the image; they travel with crop_image as extra batch images for Flux.2 / Kontext. Dropping files on this list does the same.", () => this.refInput.click()));
        layersHead.appendChild(miniButton("fx", "Add a filter layer (grain, sharpen, levels, LUT, vignette). It filters everything below it; give it a mask to limit where it applies.", () => this.addFilterLayer()));
        layersHead.appendChild(miniButton("plus", "Add a paint layer (Ctrl+Shift+N)", () => this.addPaintLayer()));
        side.appendChild(layersHead);
        this.layerList = el("div", "ipc-list");
        this.layerList.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); this.layerList.classList.add("ipc-dropping"); });
        this.layerList.addEventListener("dragleave", () => this.layerList.classList.remove("ipc-dropping"));
        this.layerList.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            this.layerList.classList.remove("ipc-dropping");
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
            if (files.length) this.addImageLayers(files, "reference");
        });
        side.appendChild(this.layerList);

        section("Selection", true, (d) => {
            const sec = el("div", "ipc-sec");
            this.growInput = numberInput(16, 1, 1024, "Pixels to grow or shrink by", 60);
            sec.appendChild(el("span", null, "by"));
            sec.appendChild(this.growInput);
            sec.appendChild(el("span", null, "px"));
            const grow = iconButton("grow", "Grow the selection by n pixels", () => this.growSelection(+this.growInput.value), "Grow");
            grow.classList.add("ipc-small");
            sec.appendChild(grow);
            const shrink = iconButton("shrink", "Shrink the selection by n pixels", () => this.growSelection(-this.growInput.value), "Shrink");
            shrink.classList.add("ipc-small");
            sec.appendChild(shrink);
            const from = iconButton("fromLayer", "Replace the selection with the opaque area of the active layer", () => this.selectionFromLayer(), "From layer");
            from.classList.add("ipc-small");
            sec.appendChild(from);
            const clr = iconButton("erase", "Clear: delete the selected pixels of the active layer (Del). Invert the selection first to keep only the selection.", () => this.clearSelectedPixels(), "Clear");
            clr.classList.add("ipc-small");
            sec.appendChild(clr);
            d.appendChild(sec);

            // select by text
            const seg = el("div", "ipc-sec");
            const row = el("div", "ipc-seg");
            this.segInput = document.createElement("input");
            this.segInput.type = "text";
            this.segInput.placeholder = "Select by text, e.g. shirt (empty: from the prompt)";
            this.segInput.spellcheck = false;
            this.segInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); this.segmentByText(); } if (e.key === "Escape") { this.segInput.blur(); this.root.focus({ preventScroll: true }); } });
            row.appendChild(this.segInput);
            this.segBtn = iconButton("magic", "Run the segmentation model and turn the result into a selection (Enter in the field)", () => this.segmentByText(), "Go");
            this.segBtn.classList.add("ipc-small", "ipc-primary");
            row.appendChild(this.segBtn);
            seg.appendChild(row);
            const modes = el("div", "ipc-modes");
            this.segModeButtons = {};
            for (const [id, label, title] of [["replace", "Replace", "Replace the selection"], ["add", "Add", "Add to the selection"], ["subtract", "Subtract", "Remove from the selection"]]) {
                const b = el("button", "ipc-ib", label); b.type = "button"; b.title = title;
                b.addEventListener("click", (e) => { e.stopPropagation(); this.segMode = id; for (const [k, x] of Object.entries(this.segModeButtons)) x.classList.toggle("ipc-active", k === id); });
                this.segModeButtons[id] = b;
                modes.appendChild(b);
            }
            this.segMode = "replace";
            this.segModeButtons.replace.classList.add("ipc-active");
            seg.appendChild(modes);
            const thrLab = el("label", null, "Threshold");
            this.segThreshold = numberInput(0.3, 0.05, 0.95, "Detection threshold: lower finds more, higher is stricter", 56);
            this.segThreshold.step = 0.05;
            thrLab.appendChild(this.segThreshold);
            seg.appendChild(thrLab);
            const qualLab = el("label", null, "");
            this.segQualityLab = qualLab;
            this.segQuality = document.createElement("input");
            this.segQuality.type = "checkbox";
            this.segQuality.title = "HQ: use the large SAM model with GroundingDINO + SAM (slower, finer edges). Not used by SAM3.";
            qualLab.appendChild(this.segQuality);
            qualLab.appendChild(el("span", null, "HQ"));
            seg.appendChild(qualLab);
            const srcLab = el("label", null, "Source");
            this.segSourceSel = selectInput(["image", "active layer"], "image", "What the model sees: the flattened image, or only the active layer (the result is clipped to that layer)");
            this.segSourceSel.addEventListener("change", () => { if (this.tool === "object") this.ensureObjects(); });
            srcLab.appendChild(this.segSourceSel);
            seg.appendChild(srcLab);
            this.segBackendSel = selectInput(["auto"], "auto", "Segmentation backend");
            this.segBackendSel.addEventListener("change", () => this.updateSegQuality());
            seg.appendChild(this.segBackendSel);
            d.appendChild(seg);
        });

        section("Canvas", false, (d) => {
            const sec = el("div", "ipc-sec");
            const grid = el("div", "ipc-row4");
            this.extendInputs = {};
            for (const [key, label] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]]) {
                grid.appendChild(el("span", null, label));
                this.extendInputs[key] = numberInput(0, 0, 8192, `Pixels to add at the ${key}`, 64);
                grid.appendChild(this.extendInputs[key]);
            }
            sec.appendChild(grid);
            const fillLab = el("label", null, "Border");
            this.extendFillSel = selectInput(["stretch edges", "average color", "grey", "green", "black", "noise"], "average color",
                "What fills the new border before the model sees it: stretched edge pixels, the image's average colour, neutral grey, green (edit models), black, or random noise (latent models).");
            this.extendFillSel.addEventListener("change", () => { this.cropSettings.extendFill = this.extendFillSel.value; this.notifyChanged(); });
            fillLab.appendChild(this.extendFillSel);
            sec.appendChild(fillLab);
            const ext = iconButton("extend", "Extend the canvas (outpainting). The new border becomes the selection.", () => this.extendCanvas(), "Extend canvas");
            ext.classList.add("ipc-small");
            sec.appendChild(ext);
            this.canvasInfo = el("span", null, "");
            sec.appendChild(this.canvasInfo);
            d.appendChild(sec);

            // reference layers ride along in crop_image, fitted to the crop size
            const refs = el("div", "ipc-sec");
            refs.appendChild(el("span", null, "References"));
            const fitLab = el("label", null, "fit");
            this.refFitSel = selectInput(REF_FITS, REF_DEFAULTS.fit, "Reference layers are added to the crop_image batch at the crop's size: pad scales them to fit and fills the rest with the image's border colour, crop scales to cover and cuts the middle, stretch distorts.");
            this.refFitSel.addEventListener("change", () => { this.refSettings.fit = this.refFitSel.value; this.notifyChanged(); });
            fitLab.appendChild(this.refFitSel);
            refs.appendChild(fitLab);
            d.appendChild(refs);

            // export
            const exp = el("div", "ipc-sec");
            exp.appendChild(el("span", null, "Save as"));
            this.saveNameInput = document.createElement("input");
            this.saveNameInput.type = "text";
            this.saveNameInput.className = "ipc-num";
            this.saveNameInput.style.width = "120px";
            this.saveNameInput.value = "inpaint_canvas";
            this.saveNameInput.title = "File name (a counter is added when it exists)";
            this.saveNameInput.spellcheck = false;
            this.saveNameInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") this.exportImage(); });
            exp.appendChild(this.saveNameInput);
            this.saveFormatSel = selectInput(["png", "jpg"], "png", "PNG keeps the workflow inside the file (drop it onto ComfyUI to load it again), JPEG is smaller");
            exp.appendChild(this.saveFormatSel);
            const dl = iconButton("download", "Save and also download the file in the browser", () => this.exportImage({ download: true }), "Download");
            dl.classList.add("ipc-small");
            exp.appendChild(dl);
            d.appendChild(exp);

            // files
            const files = el("div", "ipc-sec");
            const clean = iconButton("broom", "Delete the node's own working files in input/output/temp inpaint_canvas that no workflow uses: not this or any open editor, not any saved workflow, not younger than two minutes. Images you loaded or saved keep their names and are never touched. Asks before deleting.", () => this.cleanupFiles(), "Clean up files");
            clean.classList.add("ipc-small");
            files.appendChild(clean);
            this.cleanupInfo = el("span", null, "");
            files.appendChild(this.cleanupInfo);
            d.appendChild(files);
        });

        section("Prompt", true, (d) => {
            const wrap = el("div", "ipc-prompt");
            this.promptInput = document.createElement("textarea");
            this.promptInput.placeholder = "Describe what should appear in the selection. Available as the node's prompt output.";
            this.promptInput.spellcheck = false;
            this.promptInput.addEventListener("input", () => { this.promptText = this.promptInput.value; });
            this.promptInput.addEventListener("change", () => this.notifyChanged());
            this.promptInput.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Escape") { this.promptInput.blur(); this.root.focus({ preventScroll: true }); }
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.generate(); }
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") { e.preventDefault(); this.upsamplePrompt(); }
            });
            wrap.appendChild(this.promptInput);
            this.negativeInput = document.createElement("textarea");
            this.negativeInput.placeholder = "Negative prompt (local mode, SDXL-class models). Available as the node's negative output.";
            this.negativeInput.spellcheck = false;
            this.negativeInput.rows = 2;
            this.negativeInput.addEventListener("input", () => { this.negativeText = this.negativeInput.value; });
            this.negativeInput.addEventListener("change", () => this.notifyChanged());
            this.negativeInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { this.negativeInput.blur(); this.root.focus({ preventScroll: true }); } });
            wrap.appendChild(this.negativeInput);
            d.appendChild(wrap);

            // prompt upsampling
            const up = el("div", "ipc-sec ipc-upsample");
            const caseLab = el("label", null, "Use case");
            this.upCaseSel = selectInput(UPSAMPLE_CASES, "auto", "What the rewritten prompt is for. auto = an editing instruction (Flux.2, Kontext, Klein), or outpaint when the selection touches the border. fill / add / remove write a description of the finished area for inpaint models.");
            this.upCaseSel.addEventListener("change", () => { this.upsampleSettings.useCase = this.upCaseSel.value; this.notifyChanged(); });
            caseLab.appendChild(this.upCaseSel);
            up.appendChild(caseLab);
            this.upBackendSel = selectInput(["auto"], "auto", "Language model used for upsampling");
            this.upBackendSel.addEventListener("change", () => { this.upsampleSettings.backend = this.upBackendSel.value; this.notifyChanged(); });
            up.appendChild(this.upBackendSel);
            this.upBtn = iconButton("magic", "Upsample (Ctrl+U): a vision-language model rewrites the prompt for the selected area and use case. Short requests work best; the small local model is most reliable with English.", () => this.upsamplePrompt(), "Upsample");
            this.upBtn.classList.add("ipc-small", "ipc-primary");
            up.appendChild(this.upBtn);
            this.upRevertBtn = iconButton("restore", "Put the previous prompt back", () => this.revertPrompt(), "Revert");
            this.upRevertBtn.classList.add("ipc-small");
            this.upRevertBtn.disabled = true;
            up.appendChild(this.upRevertBtn);
            d.appendChild(up);
        });

        section("Generate", true, (d) => {
            const sec = el("div", "ipc-sec ipc-gen");
            const denLab = el("label", null, "Denoise");
            denLab.title = "Denoise strength for a local sampler (denoise output). 1.0 repaints the selection completely, lower values keep more of what is there (refine).";
            this.denoiseInput = document.createElement("input");
            this.denoiseInput.type = "range";
            this.denoiseInput.min = 0.05; this.denoiseInput.max = 1; this.denoiseInput.step = 0.05; this.denoiseInput.value = 1;
            this.denoiseInput.title = "Denoise strength, emitted on the node's denoise output";
            this.denoiseInput.addEventListener("keydown", (e) => e.stopPropagation());
            this.denoiseInput.addEventListener("click", (e) => e.stopPropagation());
            this.denoiseVal = el("b", null, "1.00");
            this.denoiseInput.addEventListener("input", () => {
                this.genSettings.denoise = Math.min(1, Math.max(0.05, Math.round((+this.denoiseInput.value || 1) * 100) / 100));
                this.denoiseVal.textContent = this.genSettings.denoise.toFixed(2);
                this.renderInfo(); this.draw();
            });
            this.denoiseInput.addEventListener("change", () => this.notifyChanged());
            denLab.appendChild(this.denoiseInput);
            denLab.appendChild(this.denoiseVal);
            sec.appendChild(denLab);
            const seedLab = el("label", null, "Seed");
            seedLab.title = "Seed emitted on the node's seed output";
            this.seedInput = numberInput(0, 0, 4294967295, "Seed value", 96);
            this.seedInput.addEventListener("change", () => { this.genSettings.seed = Math.max(0, Math.floor(+this.seedInput.value || 0)); this.genSettings.seedRandom = false; this.seedRandom.checked = false; this.notifyChanged(); });
            seedLab.appendChild(this.seedInput);
            sec.appendChild(seedLab);
            const rndLab = el("label", null, "");
            this.seedRandom = document.createElement("input");
            this.seedRandom.type = "checkbox";
            this.seedRandom.checked = true;
            this.seedRandom.title = "New random seed for every Generate";
            this.seedRandom.addEventListener("change", () => { this.genSettings.seedRandom = this.seedRandom.checked; this.notifyChanged(); });
            rndLab.appendChild(this.seedRandom);
            rndLab.appendChild(el("span", null, "random"));
            sec.appendChild(rndLab);
            const dice = iconButton("dice", "Roll a new seed now", () => { this.genSettings.seed = randomSeed(); this.seedInput.value = this.genSettings.seed; this.notifyChanged(); });
            dice.classList.add("ipc-small");
            sec.appendChild(dice);
            this.refineBtn = iconButton("refine", "Refine (local mode): re-run the selection at the denoise below without fill and without a feathered mask; the seam stays soft when stitching.", () => {
                this.genSettings.refine = !this.genSettings.refine;
                if (this.genSettings.refine && this.genSettings.denoise >= 1) { this.genSettings.denoise = 0.5; this.denoiseInput.value = 0.5; }
                this.syncGenControls(); this.renderInfo(); this.notifyChanged();
                this.setStatus(this.genSettings.refine ? `Refine on: denoise ${this.genSettings.denoise}, plain selection mask, no fill.` : "Refine off.");
            }, "Refine");
            this.refineBtn.classList.add("ipc-small");
            sec.appendChild(this.refineBtn);
            d.appendChild(sec);
        });

        section("Settings", true, (d) => {
            this.settingsList = el("div", "ipc-sec ipc-settings");
            d.appendChild(this.settingsList);
            this.renderSettings();
        });

        section("History", true, (d, sum) => {
            sum.appendChild(el("span", "ipc-grow"));
            const clr = miniButton("trash", "Clear the history list (layers and files stay)", () => this.clearHistory(), "ipc-del");
            clr.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
            sum.appendChild(clr);
            this.historyList = el("div", "ipc-hist");
            d.appendChild(this.historyList);
        });

        section("Crop", true, (d) => {
            const sec = el("div", "ipc-sec ipc-cropset");
            const onChange = () => {
                this.cropSettings = {
                    ...this.cropSettings,
                    context: this.cropContextSel.value === "auto" ? "auto" : "manual",
                    feather: this.cropFeatherSel.value === "auto" ? "auto" : "manual",
                    fill: this.cropFillSel.value,
                    colorMatch: this.cropColorMatch.checked,
                    withOriginal: this.cropOriginal.checked,
                    align: this.cropAlign.checked,
                    paste: this.cropPasteSel.value === "whole crop" ? "crop" : "selection",
                };
                this.renderInfo();
                this.draw();
                this.notifyChanged();
            };
            const row = (label, control, title) => {
                const l = el("label", null, label);
                if (title) l.title = title;
                l.appendChild(control);
                sec.appendChild(l);
            };
            this.cropContextSel = selectInput(["auto", "manual"], "auto", "Context around the selection: auto sizes it from the selection (at least 512 px), manual uses the node's padding widget");
            this.cropFeatherSel = selectInput(["auto", "manual"], "auto", "Mask edge: auto grows and feathers the mask from the selection size, manual blurs by the node's feather widget");
            this.cropFillSel = selectInput(["none", "neutral", "blur", "border", "green"], "none", "How the selected area is filled in crop_image before the model sees it. Green is for edit models (\"fill the green area\").");
            this.cropColorMatch = document.createElement("input");
            this.cropColorMatch.type = "checkbox";
            this.cropColorMatch.checked = true;
            this.cropOriginal = document.createElement("input");
            this.cropOriginal.type = "checkbox";
            this.cropOriginal.checked = false;
            this.cropAlign = document.createElement("input");
            this.cropAlign.type = "checkbox";
            this.cropAlign.checked = true;
            this.cropAlign.addEventListener("change", onChange);
            this.cropPasteSel = selectInput(["selection", "whole crop"], "selection", "What of the result is pasted back: only the selection (soft edge along the selection), or the whole returned rectangle with a soft border at its edge. Edit models re-render the crop as a whole; whole crop keeps their result intact and avoids doubled contours at the selection border.");
            this.cropPasteSel.addEventListener("change", onChange);
            for (const c of [this.cropContextSel, this.cropFeatherSel, this.cropFillSel]) c.addEventListener("change", onChange);
            this.cropColorMatch.addEventListener("change", onChange);
            this.cropOriginal.addEventListener("change", onChange);
            row("Context", this.cropContextSel);
            row("Feather", this.cropFeatherSel);
            row("Paste", this.cropPasteSel, "Only the selection, or the whole returned rectangle");
            row("Fill", this.cropFillSel);
            row("Original", this.cropOriginal, "With a fill mode: crop_image becomes a batch of two, the filled crop first and the untouched crop second, so an edit model (Flux.2, Kontext) sees what is under the green area. The stitch uses the first result image. Not for VAE Encode chains.");
            row("Color match", this.cropColorMatch, "Match the result's colors and brightness to the surroundings when it is stitched back");
            row("Align", this.cropAlign, "Register the result to the unchanged surroundings before stitching (affine fit on the ring around the selection). Fixes doubled contours when the model shifted or slightly rescaled the content. Applied only when it measurably improves the match.");
            d.appendChild(sec);
            this.infoEl = el("div", "ipc-info");
            d.appendChild(this.infoEl);
        });

        body.appendChild(side);
        root.appendChild(body);

        const bottom = el("div", "ipc-bottom");
        this.statusEl = el("span", null, this.status);
        bottom.appendChild(this.statusEl);
        bottom.appendChild(el("span", "ipc-kbd", "Wheel: zoom · Space/middle: pan · [ ]: size · Esc: close"));
        root.appendChild(bottom);

        this.bindEvents();
        this.setTool("select");
        this.renderLayers();
        this.renderHistory();
        this.renderInfo();
        this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        this.resizeObserver.observe(this.viewEl);
    }

    buildSubbar() {
        const bar = el("div", "ipc-subbar");
        bar.hidden = true;
        this.subbar = bar;
        this.subModeButtons = {};
        const modes = [
            ["scale", "transform", "Move / scale: drag inside to move, corners keep aspect (Shift: free), edges scale one axis"],
            ["rotate", "rotate", "Rotate around the center (Shift snaps to 15°)"],
            ["distort", "distort", "Distort: drag the four corners freely (perspective)"],
            ["warp", "warp", "Warp: drag grid points to bend the layer"],
        ];
        for (const [id, ic, title] of modes) {
            const b = iconButton(ic, title, () => this.setTransformMode(id), id[0].toUpperCase() + id.slice(1));
            this.subModeButtons[id] = b;
            bar.appendChild(b);
        }
        bar.appendChild(el("span", "ipc-sep"));
        const gridLab = el("label", null, "Grid");
        this.warpGridSel = selectInput(["3", "4", "5", "6"], "4", "Warp grid size");
        this.warpGridSel.addEventListener("change", () => { if (this.pending && this.pending.mode === "warp") { this.cancelPending(); this.startPending("warp"); } });
        gridLab.appendChild(this.warpGridSel);
        bar.appendChild(gridLab);
        const angleLab = el("label", null, "Angle");
        this.angleInput = numberInput(0, -360, 360, "Rotation in degrees", 60);
        this.angleInput.step = 1;
        this.angleInput.addEventListener("input", () => { if (this.pending && this.pending.mode === "rotate") { this.pending.angle = (+this.angleInput.value || 0) * Math.PI / 180; this.draw(); } });
        angleLab.appendChild(this.angleInput);
        bar.appendChild(angleLab);
        bar.appendChild(el("span", "ipc-sep"));
        this.applyBtn = iconButton("check", "Apply the transform (Enter)", () => this.applyPending(), "Apply");
        this.applyBtn.classList.add("ipc-primary");
        bar.appendChild(this.applyBtn);
        this.cancelBtn = iconButton("close", "Cancel the transform (Esc)", () => this.cancelPending(), "Cancel");
        bar.appendChild(this.cancelBtn);
        this.subHint = el("span", "ipc-hint", "");
        bar.appendChild(this.subHint);
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) bar.addEventListener(type, (e) => e.stopPropagation());
        this.viewEl.appendChild(bar);
        this.transformMode = "scale";
        this.updateSubbar();
    }

    updateSubbar() {
        if (!this.subbar) return;
        const on = this.tool === "transform";
        this.subbar.hidden = !on;
        if (!on) return;
        const mode = this.pending ? this.pending.mode : this.transformMode;
        for (const [id, b] of Object.entries(this.subModeButtons)) b.classList.toggle("ipc-active", id === mode);
        const pending = !!this.pending;
        this.applyBtn.hidden = !pending;
        this.cancelBtn.hidden = !pending;
        this.warpGridSel.parentElement.hidden = mode !== "warp";
        this.angleInput.parentElement.hidden = mode !== "rotate";
        if (this.pending && this.pending.mode === "rotate") this.angleInput.value = Math.round(this.pending.angle * 180 / Math.PI);
        const active = this.activeLayer();
        this.subHint.textContent = !active ? "Select a layer first" : (pending ? "Enter applies, Esc cancels" : (mode === "scale" ? "Arrow keys nudge" : "Click a mode to start"));
    }

    setTransformMode(mode) {
        if (this.pending && this.pending.mode !== mode) this.cancelPending();
        this.transformMode = mode;
        if (mode !== "scale" && !this.pending && this.activeLayer()) this.startPending(mode);
        this.updateSubbar();
        this.draw();
    }

    // ---- pending transforms (rotate / distort / warp) ------------------------

    startPending(mode) {
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("Select a layer to transform. The base stays put."); return; }
        if (layer.kind === "filter") { this.setStatus("Filter layers cannot be transformed."); return; }
        const p = { mode, layer, angle: 0 };
        const { x, y, w, h } = layer;
        if (mode === "distort") {
            p.points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        } else if (mode === "warp") {
            const n = +this.warpGridSel.value || 4;
            p.n = n;
            p.points = [];
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) p.points.push([x + w * i / n, y + h * j / n]);
        }
        this.pending = p;
        this.updateSubbar();
        this.draw();
    }

    cancelPending() {
        this.pending = null;
        this.updateSubbar();
        this.draw();
    }

    /** Destination (image coords) of the normalised layer position (u, v). */
    pendingDst(p, u, v) {
        const l = p.layer;
        if (p.mode === "rotate") {
            const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
            const px = l.x + u * l.w - cx, py = l.y + v * l.h - cy;
            const c = Math.cos(p.angle), s = Math.sin(p.angle);
            return [cx + px * c - py * s, cy + px * s + py * c];
        }
        if (p.mode === "distort") {
            if (!p.H) p.H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], p.points);
            return p.H(u, v);
        }
        if (p.mode === "warp") {
            const n = p.n;
            const fi = Math.min(n - 1e-9, u * n), fj = Math.min(n - 1e-9, v * n);
            const i = Math.floor(fi), j = Math.floor(fj);
            const fu = fi - i, fv = fj - j;
            const P = (a, b) => p.points[b * (n + 1) + a];
            const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
            return [
                (1 - fv) * ((1 - fu) * p00[0] + fu * p10[0]) + fv * ((1 - fu) * p01[0] + fu * p11[0]),
                (1 - fv) * ((1 - fu) * p00[1] + fu * p10[1]) + fv * ((1 - fu) * p01[1] + fu * p11[1]),
            ];
        }
        return [l.x + u * l.w, l.y + v * l.h];
    }

    pendingSubdivisions(p, fine) {
        if (p.mode === "rotate") return 1;
        if (p.mode === "distort") return fine ? 24 : 12;
        return fine ? p.n * 6 : p.n * 3;
    }

    pendingPointAt(p, ix, iy) {
        if (!p.points) return -1;
        const r = HANDLE_PX / this.view.scale;
        let best = -1, bestD = r * r;
        p.points.forEach(([px, py], i) => {
            const d = (px - ix) ** 2 + (py - iy) ** 2;
            if (d <= bestD) { best = i; bestD = d; }
        });
        return best;
    }

    pendingPointerDown(ix, iy, e) {
        const p = this.pending;
        if (p.mode === "rotate") {
            const cx = p.layer.x + p.layer.w / 2, cy = p.layer.y + p.layer.h / 2;
            this.pointer = { kind: "pending", start: Math.atan2(iy - cy, ix - cx), startAngle: p.angle, snap: e.shiftKey };
            return;
        }
        const idx = this.pendingPointAt(p, ix, iy);
        if (idx >= 0) {
            this.pointer = { kind: "pending", index: idx, start: [ix, iy], orig: [...p.points[idx]] };
        } else {
            this.pointer = { kind: "pending", index: -1, start: [ix, iy], orig: p.points.map((q) => [...q]) };
        }
    }

    pendingPointerMove(ix, iy, e) {
        const p = this.pending, g = this.pointer;
        if (!p || !g) return;
        if (p.mode === "rotate") {
            const cx = p.layer.x + p.layer.w / 2, cy = p.layer.y + p.layer.h / 2;
            let a = g.startAngle + (Math.atan2(iy - cy, ix - cx) - g.start);
            if (e.shiftKey || g.snap) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
            p.angle = a;
            this.updateSubbar();
            return;
        }
        const dx = ix - g.start[0], dy = iy - g.start[1];
        if (g.index >= 0) {
            p.points[g.index] = [g.orig[0] + dx, g.orig[1] + dy];
        } else {
            p.points = g.orig.map(([x, y]) => [x + dx, y + dy]);
        }
        p.H = null;
    }

    /** Bake the pending transform into the layer's pixels. */
    applyPending() {
        const p = this.pending;
        if (!p) return;
        const layer = p.layer;
        if (p.mode === "rotate" && Math.abs(p.angle) < 1e-6) { this.cancelPending(); return; }
        this.pushUndo({ kind: "layerfull", id: layer.id });
        if (layer.mask) this.applyMask(layer, { silent: true, undo: false });
        const n = this.pendingSubdivisions(p, true);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
            const [X, Y] = this.pendingDst(p, i / n, j / n);
            minX = Math.min(minX, X); minY = Math.min(minY, Y); maxX = Math.max(maxX, X); maxY = Math.max(maxY, Y);
        }
        minX = Math.floor(minX); minY = Math.floor(minY); maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        // Keep the layer's native resolution (pixels per image unit).
        const res = Math.max(layer.canvas.width / layer.w, layer.canvas.height / layer.h, 1);
        const out = makeCanvas(Math.round(bw * res), Math.round(bh * res));
        const ctx = out.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const dst = (u, v) => { const [X, Y] = this.pendingDst(p, u, v); return [(X - minX) * res, (Y - minY) * res]; };
        if (p.mode === "rotate") {
            const [X, Y] = dst(0, 0);
            ctx.save();
            ctx.translate(X, Y);
            ctx.rotate(p.angle);
            ctx.scale(layer.w * res / layer.canvas.width, layer.h * res / layer.canvas.height);
            ctx.drawImage(layer.canvas, 0, 0);
            ctx.restore();
        } else {
            drawMesh(ctx, layer.canvas, dst, n, n);
        }
        layer.canvas = out;
        layer.x = minX; layer.y = minY; layer.w = bw; layer.h = bh;
        this.pending = null;
        this.markLayerChanged(layer);
        this.renderLayers();
        this.updateSubbar();
        this.draw();
        this.setStatus(`${layer.name}: ${p.mode} applied (${bw} × ${bh}).`);
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        document.body.appendChild(this.root);
        // While the editor is open every shortcut belongs to it. The listener sits
        // on window in the capture phase so ComfyUI's own handlers (workflow undo on
        // Ctrl+Z, keybindings) never see the keys; otherwise Ctrl+Z would undo the
        // whole workflow state and reset the canvas.
        this._docKey = (e) => {
            if (!this.isOpen) return;
            const t = e.target;
            const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
            if (e.key === "Escape") {
                if (t === this.promptInput) return;
                e.stopImmediatePropagation(); e.preventDefault();
                if (this.pending) this.cancelPending(); else this.close();
                return;
            }
            if (inField) return;   // typing in the editor's own fields: their handlers stop propagation themselves
            e.stopImmediatePropagation();
            this.onKey(e);
        };
        window.addEventListener("keydown", this._docKey, true);
        this.promptInput.value = this.promptText;
        this.refreshSegmentBackends();
        this.syncRefControls();
        this.root.focus({ preventScroll: true });
        this.resizeCanvas();
        this.fitView();
        this.renderLayers();
        this.renderHistory();
        this.renderInfo();
    }

    close() {
        if (!this.isOpen) return;
        if (this.pending) this.cancelPending();
        this.isOpen = false;
        if (this.antsTimer) { clearInterval(this.antsTimer); this.antsTimer = null; }
        this.pointer = null;
        this.lassoPoints = null;
        if (this._docKey) window.removeEventListener("keydown", this._docKey, true);
        this._docKey = null;
        this.root.remove();
        this.drawThumb();
        this.notifyChanged();
        this.syncLayers().catch((err) => console.error(err));
    }

    bindEvents() {
        const root = this.root;
        const stop = (e) => e.stopPropagation();
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keyup"]) {
            root.addEventListener(type, stop);
        }
        root.addEventListener("contextmenu", (e) => e.preventDefault());
        root.addEventListener("click", (e) => {
            const t = e.target;
            if (t && t.closest && t.closest("button") && !t.closest("input, select, textarea")) this.root.focus({ preventScroll: true });
        });
        root.addEventListener("wheel", (e) => {
            if (e.target !== this.canvas) { e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation();
            this.onWheel(e);
        }, { passive: false });
        // Keys are handled by the window capture listener (see open()); here we
        // only keep them from bubbling to the graph canvas.
        root.addEventListener("keydown", (e) => e.stopPropagation());
        root.addEventListener("paste", (e) => {
            if (e.target === this.promptInput) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault(); e.stopPropagation();
                    this.loadFile(item.getAsFile());
                    return;
                }
            }
        });
        this.viewEl.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        this.viewEl.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            // Shift, several files, or a base that already exists plus Shift: reference layers.
            if (this.width && (e.shiftKey || files.length > 1)) { this.addImageLayers(files, "reference"); return; }
            this.loadFile(files[0]);
        });
        this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.hoverObjectId = 0; this.hoverObjectCanvas = null; this.draw(); });
    }

    setStatus(text) {
        this.status = text;
        if (this.statusEl) this.statusEl.textContent = text;
        if (this.nodeStatus) this.nodeStatus.textContent = text;
    }

    /** Hardness of the tool in use: the eraser has its own, softer default. */
    activeHardness() {
        return this.tool === "erase" ? this.eraseHardness : this.hardness;
    }

    setTool(tool) {
        if (this.pending && tool !== "transform") this.cancelPending();
        this.tool = tool;
        if (this.hardCtl) {
            const v = Math.round(this.activeHardness() * 100);
            this.hardCtl.input.value = v;
            this.hardCtl.value.textContent = v + "%";
        }
        for (const [id, b] of Object.entries(this.toolButtons)) b.classList.toggle("ipc-active", id === tool);
        this.viewEl.classList.toggle("ipc-pan", tool === "hand");
        this.viewEl.classList.toggle("ipc-move", tool === "transform");
        if (tool !== "transform") this.viewEl.classList.remove("ipc-scale", "ipc-scale-x", "ipc-scale-y", "ipc-rotate");
        if (tool !== "object") { this.hoverObjectId = 0; this.hoverObjectCanvas = null; }
        else this.ensureObjects();
        this.updateSubbar();
        this.draw();
    }

    onKey(e) {
        const k = e.key.toLowerCase();
        if (e.key === "Escape") { e.preventDefault(); if (this.pending) this.cancelPending(); else this.close(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.generate(); return; }
        if (e.key === "Enter" && this.pending) { e.preventDefault(); this.applyPending(); return; }
        if (this.tool === "transform" && !this.pending && e.key.startsWith("Arrow")) {
            const l = this.activeLayer();
            if (l) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                this.pushUndo({ kind: "transform", id: l.id });
                if (e.key === "ArrowLeft") l.x -= step; if (e.key === "ArrowRight") l.x += step;
                if (e.key === "ArrowUp") l.y -= step; if (e.key === "ArrowDown") l.y += step;
                this.uploaded.baseHash = null; this.uploaded.controlHash = null;
                this.renderLayers(); this.draw(); this.drawThumb(); this.notifyChanged();
            }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "n") { e.preventDefault(); this.addPaintLayer(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? this.redoStep() : this.undoStep(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); this.redoStep(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); this.clearSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "u") { e.preventDefault(); this.upsamplePrompt(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "i") { e.preventDefault(); this.invertSelection(); return; }
        if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); this.exportImage(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.shiftKey && k === "f") { this.fillSelection(); return; }
        switch (k) {
            case "b": this.setTool("select"); break;
            case "r": this.setTool("rect"); break;
            case "l": this.setTool("lasso"); break;
            case "o": this.setTool("object"); break;
            case "d": this.setTool("deselect"); break;
            case "p": this.setTool("paint"); break;
            case "e": this.setTool("erase"); break;
            case "t": this.setTool("transform"); break;
            case "h": this.setTool("hand"); break;
            case "f": this.fitView(); break;
            case "delete": case "backspace": {
                // with a selection: clear the selected pixels of the active layer (Krita / Photoshop); without: delete the layer
                if (this.getBounds()) { this.clearSelectedPixels(); break; }
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
        this.brushSize = Math.min(400, Math.max(2, v));
        this.sizeCtl.input.value = this.brushSize;
        this.sizeCtl.value.textContent = this.brushSize + "px";
        this.draw();
    }

    // ---- geometry ----------------------------------------------------------

    resizeCanvas() {
        if (!this.isOpen) return;
        const rect = this.viewEl.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            if (this.width && this._fitted !== false) this.fitView(); else this.draw();
        }
    }

    toCanvasPx(e) {
        const rect = this.canvas.getBoundingClientRect();
        return [
            (e.clientX - rect.left) * (this.canvas.width / rect.width),
            (e.clientY - rect.top) * (this.canvas.height / rect.height),
        ];
    }

    toImage(e) {
        const [cx, cy] = this.toCanvasPx(e);
        return [(cx - this.view.x) / this.view.scale, (cy - this.view.y) / this.view.scale];
    }

    fitView() {
        if (!this.width || !this.canvas.width) return;
        const pad = 24;
        const s = Math.max(0.01, Math.min((this.canvas.width - pad * 2) / this.width, (this.canvas.height - pad * 2) / this.height));
        this.view.scale = s;
        this.view.x = (this.canvas.width - this.width * s) / 2;
        this.view.y = (this.canvas.height - this.height * s) / 2;
        this._fitted = true;
        this.draw();
    }

    onWheel(e) {
        if (!this.width) return;
        const [cx, cy] = this.toCanvasPx(e);
        const factor = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(40, Math.max(0.02, this.view.scale * factor));
        this.view.x = cx - (cx - this.view.x) * (ns / this.view.scale);
        this.view.y = cy - (cy - this.view.y) * (ns / this.view.scale);
        this.view.scale = ns;
        this._fitted = false;
        this.draw();
    }

    // ---- layers: lookup ----------------------------------------------------

    activeLayer() {
        return this.layers.find((l) => l.id === this.activeLayerId) || null;
    }

    isControl(layer) {
        return !!(layer.role && layer.role !== "none" && layer.role !== "reference");
    }

    isReference(layer) {
        return layer.role === "reference";
    }

    /** Visible reference layers in panel order (top of the list = reference 1). */
    referenceLayers() {
        return this.layers.filter((l) => this.isReference(l) && l.visible && l.canvas).reverse();
    }

    /**
     * The layer's pixels as they are composited: the canvas with the in-progress
     * stroke and, when the layer has a transparency mask, multiplied by it. The
     * masked result is cached until pixels or mask change.
     */
    layerPixels(layer) {
        if (!layer.mask) return this.layerWithStroke(layer);
        const p = this.pointer;
        const live = !!(p && (p.kind === "layerpaint" || p.kind === "maskpaint") && p.layer === layer);
        if (!live && layer._masked && layer._maskedValid) return layer._masked;
        const base = this.layerWithStroke(layer);
        const mask = this.maskWithStroke(layer);
        let out;
        if (live) {
            if (!this.maskedPreview || this.maskedPreview.width !== base.width || this.maskedPreview.height !== base.height) this.maskedPreview = makeCanvas(base.width, base.height);
            out = this.maskedPreview;
        } else {
            if (!layer._masked || layer._masked.width !== base.width || layer._masked.height !== base.height) layer._masked = makeCanvas(base.width, base.height);
            out = layer._masked;
        }
        const ctx = out.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.drawImage(base, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(mask, 0, 0, out.width, out.height);
        ctx.globalCompositeOperation = "source-over";
        if (!live) layer._maskedValid = true;
        return out;
    }

    /** The layer's mask with the in-progress mask stroke applied (white = visible). */
    maskWithStroke(layer) {
        const p = this.pointer;
        if (!p || p.kind !== "maskpaint" || p.layer !== layer) return layer.mask;
        if (!this.maskPreview || this.maskPreview.width !== layer.mask.width || this.maskPreview.height !== layer.mask.height) this.maskPreview = makeCanvas(layer.mask.width, layer.mask.height);
        const ctx = this.maskPreview.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, this.maskPreview.width, this.maskPreview.height);
        ctx.drawImage(layer.mask, 0, 0);
        ctx.globalAlpha = this.brushOpacity;
        ctx.globalCompositeOperation = p.erase ? "destination-out" : "source-over";
        ctx.drawImage(p.stroke, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        return this.maskPreview;
    }

    /** Handles of a layer: corners (nw, ne, sw, se) and edge midpoints (n, e, s, w). */
    layerHandles(l) {
        return {
            nw: [l.x, l.y], ne: [l.x + l.w, l.y], sw: [l.x, l.y + l.h], se: [l.x + l.w, l.y + l.h],
            n: [l.x + l.w / 2, l.y], s: [l.x + l.w / 2, l.y + l.h], w: [l.x, l.y + l.h / 2], e: [l.x + l.w, l.y + l.h / 2],
        };
    }

    /** Which handle of the active layer is under image point (ix, iy)? */
    handleAt(ix, iy) {
        const l = this.activeLayer();
        if (!l) return null;
        const r = HANDLE_PX / this.view.scale;
        const handles = this.layerHandles(l);
        for (const name of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
            const [cx, cy] = handles[name];
            if (Math.abs(ix - cx) <= r && Math.abs(iy - cy) <= r) return name;
        }
        return null;
    }

    updateTransformCursor(ix, iy) {
        const cls = this.viewEl.classList;
        cls.remove("ipc-scale", "ipc-scale-x", "ipc-scale-y", "ipc-rotate");
        if (this.pending) { if (this.pending.mode === "rotate") cls.add("ipc-rotate"); return; }
        const h = this.handleAt(ix, iy);
        if (h === "n" || h === "s") cls.add("ipc-scale-y");
        else if (h === "e" || h === "w") cls.add("ipc-scale-x");
        else if (h) cls.add("ipc-scale");
    }

    // ---- pointer gestures --------------------------------------------------

    onPointerDown(e) {
        this.root.focus({ preventScroll: true });
        if (!this.width) return;
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

        // Krita / Photoshop modifiers: Shift adds, Alt subtracts; rectangle and lasso replace otherwise.
        const selMode = e.altKey ? "subtract" : (e.shiftKey ? "add" : "replace");
        if (this.tool === "select" || this.tool === "deselect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "selpaint", last: [ix, iy], path: [[ix, iy]], subtract: this.tool === "deselect" || e.altKey };
            this.selectionDab(ix, iy, ix, iy);
        } else if (this.tool === "rect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "rect", start: [ix, iy], cur: [ix, iy], mode: selMode };
        } else if (this.tool === "lasso") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "lasso", mode: selMode };
            this.lassoPoints = [[ix, iy]];
        } else if (this.tool === "object") {
            this.pointer = { kind: "object", start: [cx, cy], moved: false, shift: e.shiftKey, alt: e.altKey };
        } else if (this.tool === "paint" || this.tool === "erase") {
            let layer = this.activeLayer();
            if (layer && layer.mask && layer.maskEdit) {
                // Painting on the transparency mask: paint reveals, erase hides.
                this.pushUndo({ kind: "mask", id: layer.id });
                const stroke = makeCanvas(layer.mask.width, layer.mask.height);
                this.pointer = { kind: "maskpaint", layer, stroke, erase: this.tool === "erase", white: true, last: [ix, iy] };
                this.layerDab(this.pointer, ix, iy, ix, iy);
                this.draw();
                return;
            }
            if (layer && layer.kind === "filter") { this.setStatus("Filter layers have no pixels. Add a mask (from selection) and enable mask editing to limit where the filter applies."); return; }
            if (!layer) {
                if (this.tool === "erase") { this.setStatus("The base layer cannot be erased. Select a layer or add a paint layer."); return; }
                layer = this.addPaintLayer();
            }
            this.pushUndo({ kind: "layer", id: layer.id });
            const stroke = makeCanvas(layer.canvas.width, layer.canvas.height);
            this.pointer = { kind: "layerpaint", layer, stroke, erase: this.tool === "erase", last: [ix, iy] };
            this.layerDab(this.pointer, ix, iy, ix, iy);
        } else if (this.tool === "transform") {
            const layer = this.activeLayer();
            if (!layer) { this.setStatus("Select a layer to move or scale it. The base stays put."); return; }
            if (layer.kind === "filter") { this.setStatus("Filter layers cover the whole canvas and cannot be transformed."); return; }
            if (this.pending) { this.pendingPointerDown(ix, iy, e); this.draw(); return; }
            const handle = this.handleAt(ix, iy);
            this.pushUndo({ kind: "transform", id: layer.id });
            if (handle) {
                const corner = handle.length === 2;
                this.pointer = { kind: "scale", layer, handle, start: [ix, iy], orig: { x: layer.x, y: layer.y, w: layer.w, h: layer.h }, keepAspect: corner && !e.shiftKey };
            } else {
                this.pointer = { kind: "move", layer, start: [ix, iy], orig: { x: layer.x, y: layer.y } };
            }
        }
        this.draw();
    }

    onPointerMove(e) {
        if (!this.width) return;
        const [ix, iy] = this.toImage(e);
        this.hover = [ix, iy];
        const p = this.pointer;
        if (!p) {
            if (this.tool === "transform") this.updateTransformCursor(ix, iy);
            if (this.tool === "object") this.updateObjectHover(ix, iy);
            this.draw();
            return;
        }
        if (p.kind === "object") {
            const [cx, cy] = this.toCanvasPx(e);
            if (Math.hypot(cx - p.start[0], cy - p.start[1]) > 4) p.moved = true;
            this.updateObjectHover(ix, iy);
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
            this.layerDab(p, p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
        } else if (p.kind === "rect") {
            p.cur = [ix, iy];
            p.mode = e.altKey ? "subtract" : (e.shiftKey ? "add" : p.mode === "replace" && !e.shiftKey ? "replace" : "add");
        } else if (p.kind === "lasso") {
            this.lassoPoints.push([ix, iy]);
            p.mode = e.altKey ? "subtract" : (e.shiftKey ? "add" : p.mode === "replace" && !e.shiftKey ? "replace" : "add");
        } else if (p.kind === "move") {
            p.layer.x = Math.round(p.orig.x + (ix - p.start[0]));
            p.layer.y = Math.round(p.orig.y + (iy - p.start[1]));
        } else if (p.kind === "scale") {
            this.applyScale(p, ix, iy);
        } else if (p.kind === "pending") {
            this.pendingPointerMove(ix, iy, e);
        }
        this.draw();
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
        if (!p) return;
        this.pointer = null;
        this.viewEl.classList.remove("ipc-panning");
        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (p.kind === "rect") {
            const [x0, y0] = p.start;
            const [x1, y1] = p.cur;
            const sctx = this.selection.getContext("2d");
            if (p.mode === "replace") { sctx.globalCompositeOperation = "source-over"; sctx.clearRect(0, 0, this.width, this.height); this.selectionLabel = ""; }
            sctx.globalCompositeOperation = p.mode === "subtract" ? "destination-out" : "source-over";
            sctx.fillStyle = "#ff0000";
            sctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            sctx.globalCompositeOperation = "source-over";
            this.markSelectionChanged();
        } else if (p.kind === "lasso") {
            const pts = this.lassoPoints;
            this.lassoPoints = null;
            if (pts && pts.length > 2) {
                const sctx = this.selection.getContext("2d");
                if (p.mode === "replace") { sctx.globalCompositeOperation = "source-over"; sctx.clearRect(0, 0, this.width, this.height); this.selectionLabel = ""; }
                sctx.globalCompositeOperation = p.mode === "subtract" ? "destination-out" : "source-over";
                sctx.fillStyle = "#ff0000";
                sctx.beginPath();
                sctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i][0], pts[i][1]);
                sctx.closePath();
                sctx.fill();
                sctx.globalCompositeOperation = "source-over";
                this.markSelectionChanged();
            }
        } else if (p.kind === "selpaint") {
            if (this.fillEnclosed) this.closeStrokeLoop(p.path, !!p.subtract);
            this.markSelectionChanged();
        } else if (p.kind === "object") {
            if (!p.moved) this.toggleObjectAt(...this.toImage(e), p);
        } else if (p.kind === "layerpaint") {
            this.commitStroke(p);
            this.markLayerChanged(p.layer);
        } else if (p.kind === "maskpaint") {
            this.commitStroke(p);
            this.markMaskChanged(p.layer);
        } else if (p.kind === "move" || p.kind === "scale") {
            this.uploaded.baseHash = null;
            this.uploaded.controlHash = null;
            this.renderLayers();
            this.drawThumb();
            this.notifyChanged();
        }
        this.draw();
    }

    selectionDab(x0, y0, x1, y1) {
        const sctx = this.selection.getContext("2d");
        const subtract = this.pointer && this.pointer.kind === "selpaint" ? !!this.pointer.subtract : this.tool === "deselect";
        sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
        sctx.strokeStyle = "#ff0000";
        sctx.lineCap = "round";
        sctx.lineJoin = "round";
        sctx.lineWidth = this.brushSize;
        sctx.beginPath();
        sctx.moveTo(x0, y0);
        sctx.lineTo(x1 + 0.01, y1 + 0.01);
        sctx.stroke();
        sctx.globalCompositeOperation = "source-over";
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
        const sctx = this.selection.getContext("2d");
        sctx.save();
        sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
        sctx.fillStyle = "#ff0000";
        sctx.beginPath();
        sctx.moveTo(x0, y0);
        for (let i = 1; i < path.length; i++) sctx.lineTo(path[i][0], path[i][1]);
        sctx.closePath();
        sctx.fill("nonzero");
        sctx.restore();
        return true;
    }

    /**
     * Draw one brush segment into the stroke buffer of a layer-paint gesture.
     * Hard brushes use a round line, soft brushes stamp radial-gradient dabs.
     * Image coords are mapped into the layer's own pixels.
     */
    layerDab(p, x0, y0, x1, y1) {
        const layer = p.layer;
        const c = p.stroke;
        const sx = c.width / layer.w, sy = c.height / layer.h;
        const ctx = c.getContext("2d");
        const lx0 = (x0 - layer.x) * sx, ly0 = (y0 - layer.y) * sy;
        const lx1 = (x1 - layer.x) * sx, ly1 = (y1 - layer.y) * sy;
        const radius = this.brushSize * (sx + sy) / 4;
        const color = p.white ? "#ffffff" : (p.erase ? "#000000" : this.color);
        ctx.globalCompositeOperation = "source-over";
        const hardness = p.erase ? this.eraseHardness : this.hardness;
        if (hardness >= 0.98) {
            ctx.strokeStyle = color;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.lineWidth = radius * 2;
            ctx.beginPath();
            ctx.moveTo(lx0, ly0);
            ctx.lineTo(lx1 + 0.01, ly1 + 0.01);
            ctx.stroke();
            return;
        }
        if (!p.gradient || p.gradientRadius !== radius) {
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
            const rgb = color.length === 7 ? `${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)}` : "0,0,0";
            g.addColorStop(0, `rgba(${rgb},1)`);
            g.addColorStop(Math.max(0, Math.min(0.97, hardness)), `rgba(${rgb},1)`);
            g.addColorStop(1, `rgba(${rgb},0)`);
            p.gradient = g;
            p.gradientRadius = radius;
        }
        const dist = Math.hypot(lx1 - lx0, ly1 - ly0);
        const spacing = Math.max(1, radius * 0.18);
        const steps = Math.max(1, Math.ceil(dist / spacing));
        ctx.fillStyle = p.gradient;
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            const x = lx0 + (lx1 - lx0) * t, y = ly0 + (ly1 - ly0) * t;
            ctx.save();
            ctx.translate(x, y);
            ctx.beginPath();
            ctx.arc(0, 0, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    /** Apply the stroke buffer to the layer (or its mask) with the brush opacity. */
    commitStroke(p) {
        const ctx = (p.kind === "maskpaint" ? p.layer.mask : p.layer.canvas).getContext("2d");
        ctx.save();
        ctx.globalAlpha = this.brushOpacity;
        ctx.globalCompositeOperation = p.erase ? "destination-out" : "source-over";
        ctx.drawImage(p.stroke, 0, 0);
        ctx.restore();
    }

    /** Layer pixels with the in-progress stroke applied, for live preview. */
    layerWithStroke(layer) {
        const p = this.pointer;
        if (!p || p.kind !== "layerpaint" || p.layer !== layer) return layer.canvas;
        if (!this.strokePreview || this.strokePreview.width !== layer.canvas.width || this.strokePreview.height !== layer.canvas.height) {
            this.strokePreview = makeCanvas(layer.canvas.width, layer.canvas.height);
        }
        const ctx = this.strokePreview.getContext("2d");
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, this.strokePreview.width, this.strokePreview.height);
        ctx.drawImage(layer.canvas, 0, 0);
        ctx.globalAlpha = this.brushOpacity;
        ctx.globalCompositeOperation = p.erase ? "destination-out" : "source-over";
        ctx.drawImage(p.stroke, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        return this.strokePreview;
    }

    fillSelection() {
        if (!this.selection || !this.getBounds()) { this.setStatus("Nothing selected to fill."); return; }
        let layer = this.activeLayer();
        if (!layer) layer = this.addPaintLayer();
        const onMask = !!(layer.mask && layer.maskEdit);
        if (layer.kind === "filter" && !onMask) { this.setStatus("Filter layers have no pixels to fill. Use \"mask from selection\" to limit the filter instead."); return; }
        this.pushUndo(onMask ? { kind: "mask", id: layer.id } : { kind: "layer", id: layer.id });
        const shape = makeCanvas(this.width, this.height);
        const sctx = shape.getContext("2d");
        sctx.drawImage(this.selection, 0, 0);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = onMask ? "#ffffff" : this.color;
        sctx.fillRect(0, 0, this.width, this.height);
        if (onMask) {
            const m = layer.mask;
            const mctx = m.getContext("2d");
            mctx.save();
            mctx.globalAlpha = this.brushOpacity;
            mctx.setTransform(m.width / layer.w, 0, 0, m.height / layer.h, 0, 0);
            mctx.drawImage(shape, -layer.x, -layer.y);
            mctx.restore();
            this.markMaskChanged(layer);
            this.draw();
            this.setStatus(`${layer.name}: selection revealed on the mask.`);
            return;
        }
        const c = layer.canvas;
        const ctx = c.getContext("2d");
        ctx.save();
        ctx.globalAlpha = this.brushOpacity;
        ctx.setTransform(c.width / layer.w, 0, 0, c.height / layer.h, 0, 0);
        ctx.drawImage(shape, -layer.x, -layer.y);
        ctx.restore();
        this.markLayerChanged(layer);
        this.draw();
    }

    /** Delete the selected pixels of the active layer (Krita "Clear"); on a mask in edit mode it hides them. */
    clearSelectedPixels() {
        if (!this.selection || !this.getBounds()) { this.setStatus("Nothing selected. Make a selection first, invert it to keep only the selected part."); return; }
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("The base layer cannot be erased. Select a layer, or paint on the base first to get a layer."); return; }
        const onMask = !!(layer.mask && layer.maskEdit);
        if (layer.kind === "filter" && !onMask) { this.setStatus("Filter layers have no pixels. Use \"mask from selection\" to limit the filter instead."); return; }
        this.pushUndo(onMask ? { kind: "mask", id: layer.id } : { kind: "layer", id: layer.id });
        const target = onMask ? layer.mask : layer.canvas;
        const ctx = target.getContext("2d");
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.setTransform(target.width / layer.w, 0, 0, target.height / layer.h, 0, 0);
        ctx.drawImage(this.selection, -layer.x, -layer.y);
        ctx.restore();
        if (onMask) this.markMaskChanged(layer); else this.markLayerChanged(layer);
        this.draw();
        this.setStatus(`${layer.name}: selected ${onMask ? "part of the mask hidden" : "pixels cleared"}.`);
    }

    // ---- selection: grow / shrink / from layer ------------------------------

    growSelection(n) {
        if (!this.selection || !n) return;
        const W = this.width, H = this.height;
        const sctx = this.selection.getContext("2d");
        const img = sctx.getImageData(0, 0, W, H);
        const d = img.data;
        const grow = n > 0;
        const r = Math.abs(n);
        const feature = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const sel = d[i * 4 + 3] > 127;
            feature[i] = grow ? (sel ? 1 : 0) : (sel ? 0 : 1);
        }
        this.pushUndo({ kind: "selection" });
        const dist = distanceTransform(feature, W, H);
        const r2 = r * r;
        for (let i = 0; i < W * H; i++) {
            const inside = grow ? dist[i] <= r2 : dist[i] > r2;
            d[i * 4] = 255; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = inside ? 255 : 0;
        }
        sctx.putImageData(img, 0, 0);
        this.markSelectionChanged();
        this.draw();
        this.setStatus(`Selection ${grow ? "grown" : "shrunk"} by ${r}px.`);
    }

    selectionFromLayer() {
        const layer = this.activeLayer();
        if (!layer) { this.setStatus("Select a layer first (the base is fully opaque)."); return; }
        this.pushUndo({ kind: "selection" });
        const tmp = makeCanvas(this.width, this.height);
        tmp.getContext("2d").drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        const src = tmp.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        const sctx = this.selection.getContext("2d");
        const img = sctx.createImageData(this.width, this.height);
        const d = img.data;
        for (let i = 0; i < src.length; i += 4) {
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = src[i + 3] > 127 ? 255 : 0;
        }
        sctx.putImageData(img, 0, 0);
        this.markSelectionChanged();
        this.draw();
        this.setStatus(`Selection taken from ${layer.name}.`);
    }

    // ---- text segmentation -----------------------------------------------------

    refreshSegmentBackends() {
        if (!this.segBackendSel) return;
        const avail = availableSegmentBackends();
        const cur = this.segBackendSel.value;
        this.segBackendSel.innerHTML = "";
        for (const b of avail) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.segBackendSel.appendChild(o); }
        if (!avail.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "no segmentation nodes installed"; this.segBackendSel.appendChild(o); }
        if (avail.some((b) => b.id === cur)) this.segBackendSel.value = cur;
        this.segBtn.disabled = !avail.length;
        this.updateSegQuality();
        if (this.upBackendSel) {
            const ups = availableUpsampleBackends();
            const curUp = this.upsampleSettings.backend;
            this.upBackendSel.innerHTML = "";
            for (const b of ups) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.upBackendSel.appendChild(o); }
            if (!ups.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "no language model nodes installed"; this.upBackendSel.appendChild(o); }
            if (ups.some((b) => b.id === curUp)) this.upBackendSel.value = curUp;
            this.upBtn.disabled = !ups.length;
        }
        if (this.upCaseSel) this.upCaseSel.value = this.upsampleSettings.useCase || "auto";
    }

    /** The HQ toggle (large SAM) only applies to the GroundingDINO + SAM backend. */
    updateSegQuality() {
        if (this.segQualityLab) this.segQualityLab.hidden = this.segBackendSel.value !== "dino_sam";
    }

    async segmentByText() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        let text = (this.segInput.value || "").trim();
        // Empty field but a prompt: let the language model name the object the prompt is about.
        const fromPrompt = !text && !!(this.promptInput.value || "").trim();
        const llm = fromPrompt ? (UPSAMPLE_BACKENDS.find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0]) : null;
        if (!text && !fromPrompt) { this.setStatus("Type what to select, e.g. \"shirt\", or write a prompt and press Go to select what it is about."); this.segInput.focus(); return; }
        if (fromPrompt && !llm) { this.setStatus("Type what to select: no language model nodes installed to derive it from the prompt."); this.segInput.focus(); return; }
        const backend = SEGMENT_BACKENDS.find((b) => b.id === this.segBackendSel.value) || availableSegmentBackends()[0];
        if (!backend) { this.setStatus("No segmentation nodes installed (comfyui_segment_anything or comfyui-rmbg)."); return; }
        try {
            this.segBtn.disabled = true;
            this.setStatus(fromPrompt ? `Asking ${llm.label} what the prompt is about, then segmenting with ${backend.label} ...` : `Segmenting "${text}" with ${backend.label} ...`);
            const { ref, layer } = await this.segmentSource();
            const threshold = Math.min(0.95, Math.max(0.05, +this.segThreshold.value || 0.3));
            const prompt = {
                seg_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
            };
            if (fromPrompt) {
                // term_run: VLM -> STRING, linked straight into the segmentation node's prompt input
                Object.assign(prompt, llm.build("seg_load", segmentTermInstruction(this.promptInput.value.trim())));
                prompt.term_run = prompt.up_run; delete prompt.up_run;
                text = ["term_run", llm.textOut[1]];
            }
            Object.assign(prompt, backend.build("seg_load", text, threshold, { quality: this.segQuality.checked }, backend));
            prompt.seg_out = { class_type: "InpaintCanvasMaskOut", inputs: { mask: backend.maskOut, canvas_node: String(this.node.id), purpose: "segment", ...(fromPrompt ? { label: text } : {}) } };
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.segmentPromptId = res && res.prompt_id;
            this.segmentPending = { text: fromPrompt ? "" : text, mode: this.segMode, layer, fromPrompt };
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
        } catch (err) {
            console.error(err);
            this.segmentPending = null;
            this.segBtn.disabled = false;
            this.setStatus("Segmentation failed: " + (err.message || err));
        }
    }

    /**
     * What a segmentation model should look at, as an uploaded reference.
     * "image": the flattened visible layers (what the inpaint chain sees).
     * "active layer": only that layer on neutral grey; results are clipped to its alpha.
     */
    async segmentSource() {
        const layerMode = this.segSourceSel && this.segSourceSel.value === "active layer";
        if (layerMode) {
            const layer = this.activeLayer();
            if (!layer) throw new Error("no active layer: pick a layer in the list or set Source to image");
            const c = makeCanvas(this.width, this.height);
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#808080";
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
            const up = await uploadCanvas(c, `n${this.node.id}_segsrc`);
            return { ref: up.ref, hash: `layer:${layer.id}:${up.hash}`, layer };
        }
        let ref = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !ref) {
            if (!this.layers.some((l) => l.visible && !this.isControl(l)) && this.base.ref) {
                ref = this.base.ref;
                this.uploaded.baseHash = "orig:" + this.base.ref.filename;
            } else {
                const up = await uploadCanvas(this.flattenToCanvas({ forRun: true }), `n${this.node.id}_base`);
                ref = up.ref; this.uploaded.baseHash = up.hash;
            }
            this.uploaded.baseRef = ref;
        }
        return { ref, hash: this.uploaded.baseHash, layer: null };
    }

    /** Uint8Array (W*H) with 1 where the layer is opaque, in image coordinates. */
    layerAlpha(layer) {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        const a = ctx.getImageData(0, 0, this.width, this.height).data;
        const out = new Uint8Array(this.width * this.height);
        for (let i = 3, j = 0; i < a.length; i += 4, j++) out[j] = a[i] > 0 ? 1 : 0;
        return out;
    }

    // ---- prompt upsampling -----------------------------------------------------

    /** The crop the model will see, with the selection tinted red (or solid green when Fill is green), long side <= 1024. */
    promptContextCanvas() {
        const [x, y, w, h] = this.cropRect();
        const flat = this.flattenToCanvas({ forRun: true });
        const scale = Math.min(1, 1024 / Math.max(w, h));
        const c = makeCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(flat, x, y, w, h, 0, 0, c.width, c.height);
        if (this.getBounds()) {
            if (this.cropSettings.fill === "green") {
                // what the generator sees: the area solid green
                const tmp = makeCanvas(c.width, c.height);
                const t = tmp.getContext("2d");
                t.drawImage(this.selection, x, y, w, h, 0, 0, c.width, c.height);
                t.globalCompositeOperation = "source-in";
                t.fillStyle = "#00ff00";
                t.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(tmp, 0, 0);
            } else {
                // a magenta outline around the selection: a tint would change the
                // colours the model is asked to describe
                const ring = makeCanvas(c.width, c.height);
                const r = ring.getContext("2d");
                const px = Math.max(2, Math.round(c.width / 300));
                for (let dx = -px; dx <= px; dx += px) for (let dy = -px; dy <= px; dy += px) r.drawImage(this.selection, x, y, w, h, dx, dy, c.width, c.height);
                r.globalCompositeOperation = "destination-out";
                r.drawImage(this.selection, x, y, w, h, 0, 0, c.width, c.height);
                r.globalCompositeOperation = "source-in";
                r.fillStyle = "#ff00ff";
                r.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(ring, 0, 0);
            }
        }
        return c;
    }

    resolveUseCase() {
        const uc = this.upsampleSettings.useCase || "auto";
        if (uc !== "auto") return uc;
        const b = this.getBounds();
        if (b && (b[0] <= 0 || b[1] <= 0 || b[2] >= this.width || b[3] >= this.height)) return "outpaint";
        // Edit models (Flux.2, Kontext, Klein) want an instruction, not a description.
        // "fill" stays available for latent inpaint models that want a description.
        return "edit";
    }

    async upsamplePrompt() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        if (this.upsamplePending) { this.setStatus("Upsampling is already running."); return; }
        const backend = UPSAMPLE_BACKENDS.find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0];
        if (!backend) { this.setStatus("No language model nodes installed (ComfyUI-QwenVL, or the Gemini API node)."); return; }
        const text = (this.promptInput.value || "").trim();
        const useCase = this.resolveUseCase();
        const region = this.getBounds() ? (this.cropSettings.fill === "green" ? "the solid green area" : "the area inside the magenta outline") : "the whole image";
        try {
            this.upBtn.disabled = true;
            this.upsamplePending = { previous: this.promptInput.value, useCase };
            this.setStatus(`Upsampling the prompt for "${useCase}" with ${backend.label} ...`);
            const { ref } = await uploadCanvas(this.promptContextCanvas(), `n${this.node.id}_promptctx`);
            const prompt = {
                up_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
                ...backend.build("up_load", upsampleInstruction(useCase, text, region, this.getBounds() ? this.selectionLabel : "")),
                up_out: { class_type: "InpaintCanvasTextOut", inputs: { text: backend.textOut, canvas_node: String(this.node.id), purpose: "upsample" } },
            };
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.upsamplePromptId = res && res.prompt_id;
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
        } catch (err) {
            console.error(err);
            this.upsamplePending = null;
            this.upBtn.disabled = false;
            this.setStatus("Upsampling failed: " + (err.message || err));
        }
    }

    /** The rewritten prompt came back from the helper prompt. */
    applyTextResult(info) {
        const pending = this.upsamplePending || { previous: this.promptInput.value, useCase: "?" };
        this.upsamplePending = null;
        this.upBtn.disabled = false;
        const text = (info.text || "").trim();
        if (!text) { this.setStatus("The model returned an empty prompt."); return; }
        this.promptBackup = pending.previous;
        this.upRevertBtn.disabled = false;
        this.promptInput.value = text;
        this.promptText = text;
        this.notifyChanged();
        this.setStatus(`Prompt upsampled for "${pending.useCase}" (${text.split(/\s+/).length} words). Revert puts the old one back.`);
    }

    revertPrompt() {
        if (this.promptBackup === null) return;
        const current = this.promptInput.value;
        this.promptInput.value = this.promptBackup;
        this.promptText = this.promptBackup;
        this.promptBackup = current;   // revert twice = redo
        this.notifyChanged();
        this.setStatus("Prompt reverted.");
    }

    // ---- object selection (hover) ---------------------------------------------

    /** Make sure the object map matches the current source; run SAM2 if not. */
    async ensureObjects() {
        if (!this.base || this.objectsPending) return;
        if (!objectBackendAvailable()) { this.setStatus("Object selection needs ComfyUI-segment-anything-2 (Kijai) for the SAM2 automatic mask generator."); return; }
        this.objectsPending = { stage: "upload" };
        try {
            const { ref, hash, layer } = await this.segmentSource();
            if (this.objects && this.objects.hash === hash && this.objects.w === this.width && this.objects.h === this.height) { this.objectsPending = null; return; }
            this.setStatus(`Finding objects with ${OBJECT_BACKEND.label} ...`);
            const prompt = {
                obj_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
                ...OBJECT_BACKEND.build("obj_load", String(this.node.id)),
            };
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
            this.objectsPending = { stage: "run", hash, layer, promptId: res && res.prompt_id };
            this.objectsPromptId = res && res.prompt_id;
        } catch (err) {
            console.error(err);
            this.objectsPending = null;
            this.setStatus("Object detection failed: " + (err.message || err));
        }
    }

    /** The label map came back: decode R + 256*G into object ids. */
    async applySegmentsFile(info) {
        const pending = this.objectsPending || {};
        this.objectsPending = null;
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            const w = info.width || img.naturalWidth, h = info.height || img.naturalHeight;
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, w, h).data;
            const ids = new Uint16Array(w * h);
            for (let i = 0, j = 0; i < d.length; i += 4, j++) ids[j] = d[i] + (d[i + 1] << 8);
            if (pending.layer && w === this.width && h === this.height) {
                const clip = this.layerAlpha(pending.layer);
                for (let j = 0; j < ids.length; j++) if (!clip[j]) ids[j] = 0;
            }
            this.objects = { hash: pending.hash, w, h, ids, count: info.count || 0, layerId: pending.layer ? pending.layer.id : null };
            this.objectShapeCache.clear();
            this.hoverObjectId = 0; this.hoverObjectCanvas = null;
            this.setStatus(`${info.count || 0} objects found. Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts).`);
            if (this.hover) this.updateObjectHover(this.hover[0], this.hover[1]);
            this.draw();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not read the object map: " + (err.message || err));
        }
    }

    objectIdAt(ix, iy) {
        const o = this.objects;
        if (!o || o.w !== this.width || o.h !== this.height) return 0;
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= o.w || y >= o.h) return 0;
        return o.ids[y * o.w + x];
    }

    /** Red shape canvas of one object (cached, selection color so it can be drawn straight into the selection). */
    objectShape(id) {
        const cached = this.objectShapeCache.get(id);
        if (cached) return cached;
        const o = this.objects;
        const c = makeCanvas(o.w, o.h);
        const ctx = c.getContext("2d");
        const out = ctx.createImageData(o.w, o.h);
        const d = out.data;
        for (let j = 0, i = 0; j < o.ids.length; j++, i += 4) {
            if (o.ids[j] === id) { d[i] = 255; d[i + 3] = 255; }
        }
        ctx.putImageData(out, 0, 0);
        if (this.objectShapeCache.size > 12) this.objectShapeCache.delete(this.objectShapeCache.keys().next().value);
        this.objectShapeCache.set(id, c);
        return c;
    }

    updateObjectHover(ix, iy) {
        if (!this.objects || (this.objects.layerId === null && this.uploaded.baseHash === null)) {
            // nothing computed yet, or the image changed since: refresh once
            if (!this.objectsPending) this.ensureObjects();
            return;
        }
        const id = this.objectIdAt(ix, iy);
        if (id === this.hoverObjectId) return;
        this.hoverObjectId = id;
        this.hoverObjectCanvas = id ? this.objectShape(id) : null;
    }

    /** Click in the object tool: toggle the object under the cursor in the selection. */
    toggleObjectAt(ix, iy, p = {}) {
        if (!this.objects) { this.ensureObjects(); return; }
        const id = this.objectIdAt(ix, iy);
        if (!id) { this.setStatus("No object here. Use the brush or lasso for this spot."); return; }
        const x = Math.floor(ix), y = Math.floor(iy);
        const already = this.selection.getContext("2d").getImageData(x, y, 1, 1).data[3] > 0;
        const subtract = p.alt ? true : (p.shift ? false : already);
        this.pushUndo({ kind: "selection" });
        const sctx = this.selection.getContext("2d");
        sctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
        sctx.drawImage(this.objectShape(id), 0, 0);
        sctx.globalCompositeOperation = "source-over";
        this.markSelectionChanged();
        this.draw();
        this.setStatus(subtract ? "Object removed from the selection." : "Object added to the selection.");
    }

    /** A mask came back from a helper prompt: merge it into the selection. */
    async applyMaskFile(info) {
        const pending = this.segmentPending || { mode: "replace", text: "" };
        this.segmentPending = null;
        this.segBtn.disabled = false;
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            if (!this.selection) return;
            this.pushUndo({ kind: "selection" });
            const tmp = makeCanvas(this.width, this.height);
            const tctx = tmp.getContext("2d");
            tctx.drawImage(img, 0, 0, this.width, this.height);
            const src = tctx.getImageData(0, 0, this.width, this.height).data;
            const clip = pending.layer ? this.layerAlpha(pending.layer) : null;
            const shape = makeCanvas(this.width, this.height);
            const sh = shape.getContext("2d");
            const out = sh.createImageData(this.width, this.height);
            const d = out.data;
            let count = 0;
            for (let i = 0, j = 0; i < src.length; i += 4, j++) {
                const on = src[i] > 127 && (!clip || clip[j]);
                d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = on ? 255 : 0;
                if (on) count++;
            }
            sh.putImageData(out, 0, 0);
            const sctx = this.selection.getContext("2d");
            if (pending.mode === "replace") sctx.clearRect(0, 0, this.width, this.height);
            sctx.globalCompositeOperation = pending.mode === "subtract" ? "destination-out" : "source-over";
            sctx.drawImage(shape, 0, 0);
            sctx.globalCompositeOperation = "source-over";
            this.markSelectionChanged();
            this.draw();
            const pct = Math.round(100 * count / (this.width * this.height));
            const term = (info.label || pending.text || "").trim();
            if (pending.fromPrompt && term && !this.segInput.value.trim()) this.segInput.value = term;
            if (count) this.selectionLabel = pending.mode === "replace" ? term : [this.selectionLabel, term].filter(Boolean).join(", ");
            this.setStatus(count ? `Selected "${term}" (${pct}% of the image, ${pending.mode}${pending.fromPrompt ? ", derived from the prompt" : ""}).` : `Nothing found for "${term}". Lower the threshold or rephrase.`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not apply the mask: " + (err.message || err));
        }
    }

    // ---- outpainting ---------------------------------------------------------

    async extendCanvas() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        const top = Math.max(0, +this.extendInputs.top.value || 0);
        const right = Math.max(0, +this.extendInputs.right.value || 0);
        const bottom = Math.max(0, +this.extendInputs.bottom.value || 0);
        const left = Math.max(0, +this.extendInputs.left.value || 0);
        if (!(top || right || bottom || left)) { this.setStatus("Enter how many pixels to add on each side."); return; }
        const W = this.width, H = this.height;
        const nw = W + left + right, nh = H + top + bottom;
        try {
            this.setStatus(`Extending canvas to ${nw} × ${nh} ...`);
            // Flatten what is visible now and fill the new border the chosen way.
            const flat = this.flattenToCanvas({ forRun: true });
            const nb = makeCanvas(nw, nh);
            const ctx = nb.getContext("2d");
            const fill = (this.extendFillSel && this.extendFillSel.value) || "average color";
            if (fill === "stretch edges") {
                ctx.imageSmoothingEnabled = true;
                if (top) ctx.drawImage(flat, 0, 0, W, 1, left, 0, W, top);
                if (bottom) ctx.drawImage(flat, 0, H - 1, W, 1, left, top + H, W, bottom);
                if (left) ctx.drawImage(flat, 0, 0, 1, H, 0, top, left, H);
                if (right) ctx.drawImage(flat, W - 1, 0, 1, H, left + W, top, right, H);
                if (top && left) ctx.drawImage(flat, 0, 0, 1, 1, 0, 0, left, top);
                if (top && right) ctx.drawImage(flat, W - 1, 0, 1, 1, left + W, 0, right, top);
                if (bottom && left) ctx.drawImage(flat, 0, H - 1, 1, 1, 0, top + H, left, bottom);
                if (bottom && right) ctx.drawImage(flat, W - 1, H - 1, 1, 1, left + W, top + H, right, bottom);
            } else if (fill === "noise") {
                const img = ctx.createImageData(nw, nh);
                const d = img.data;
                for (let i = 0; i < d.length; i += 4) { d[i] = Math.random() * 255; d[i + 1] = Math.random() * 255; d[i + 2] = Math.random() * 255; d[i + 3] = 255; }
                ctx.putImageData(img, 0, 0);
            } else {
                let color = "#808080";
                if (fill === "green") color = "#00ff00";
                else if (fill === "black") color = "#000000";
                else if (fill === "average color") {
                    // mean of a 64 px thumbnail: cheap and close enough
                    const t = makeCanvas(64, 64); const tc = t.getContext("2d"); tc.drawImage(flat, 0, 0, 64, 64);
                    const d = tc.getImageData(0, 0, 64, 64).data; let r = 0, g = 0, b = 0;
                    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
                    const n = d.length / 4; color = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
                }
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, nw, nh);
            }
            ctx.drawImage(flat, left, top);
            const { ref } = await uploadCanvas(nb, `n${this.node.id}_base`);
            const img = await loadImageEl(viewUrl(ref));

            // Everything visible was baked into the new base; keep control and reference layers.
            const kept = this.layers.filter((l) => this.isControl(l) || this.isReference(l));
            for (const l of kept) {
                if (l.kind === "paint" && l.canvas.width === W && l.canvas.height === H && l.w === W && l.h === H) {
                    const c = makeCanvas(nw, nh);
                    c.getContext("2d").drawImage(l.canvas, left, top);
                    l.canvas = c; l.x = 0; l.y = 0; l.w = nw; l.h = nh;
                } else {
                    l.x += left; l.y += top;
                }
                l.dirty = true;
            }
            this.layers = kept;
            this.activeLayerId = null;
            this.base = { ref, img };
            this.width = nw; this.height = nh;
            this.selection = makeCanvas(nw, nh);
            const sctx = this.selection.getContext("2d");
            sctx.fillStyle = "#ff0000";
            sctx.fillRect(0, 0, nw, nh);
            sctx.clearRect(left, top, W, H);
            this.undo = []; this.redo = [];
            this.uploaded = this.makeUploaded();
            this.selectionDirty = true;
            this.selectionDataUrl = null;
            for (const k of Object.keys(this.extendInputs)) this.extendInputs[k].value = 0;
            this.renderLayers();
            this.renderInfo();
            this.fitView();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus(`Canvas is ${nw} × ${nh}. The new border is selected; press Generate to outpaint it.`);
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    // ---- undo ----------------------------------------------------------------

    snapshot(step) {
        if (step.kind === "selection") return { kind: "selection", url: this.selection.toDataURL("image/png") };
        const layer = this.layers.find((l) => l.id === step.id);
        if (!layer) return null;
        if (step.kind === "layer") return { kind: "layer", id: layer.id, url: layer.canvas.toDataURL("image/png") };
        if (step.kind === "transform") return { kind: "transform", id: layer.id, x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        if (step.kind === "mask") return { kind: "mask", id: layer.id, url: layer.mask ? layer.mask.toDataURL("image/png") : null, mw: layer.mask ? layer.mask.width : 0, mh: layer.mask ? layer.mask.height : 0 };
        if (step.kind === "filter") return { kind: "filter", id: layer.id, filter: layer.filter, params: { ...(layer.params || {}) }, lut: layer.lut ? { ...layer.lut } : null, lutData: layer._lutData || null, plate: layer.plate ? { ...layer.plate } : null, plateImg: layer._plateImg || null, name: layer.name };
        if (step.kind === "layerfull") return { kind: "layerfull", id: layer.id, url: layer.canvas.toDataURL("image/png"), cw: layer.canvas.width, ch: layer.canvas.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
            mask: layer.mask ? layer.mask.toDataURL("image/png") : null, mw: layer.mask ? layer.mask.width : 0, mh: layer.mask ? layer.mask.height : 0 };
        return null;
    }

    pushUndo(step) {
        if (!this.selection) return;
        this.pushUndoSnapshot(this.snapshot(step));
    }

    pushUndoSnapshot(snap) {
        if (!snap) return;
        this.undo.push(snap);
        if (this.undo.length > MAX_UNDO) this.undo.shift();
        this.redo = [];
    }

    async applySnapshot(snap) {
        if (snap.kind === "selection") {
            const img = await loadImageEl(snap.url);
            const sctx = this.selection.getContext("2d");
            sctx.globalCompositeOperation = "source-over";
            sctx.clearRect(0, 0, this.width, this.height);
            sctx.drawImage(img, 0, 0);
            this.markSelectionChanged();
        } else {
            const layer = this.layers.find((l) => l.id === snap.id);
            if (!layer) return;
            if (snap.kind === "layer") {
                const img = await loadImageEl(snap.url);
                const ctx = layer.canvas.getContext("2d");
                ctx.globalCompositeOperation = "source-over";
                ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
                ctx.drawImage(img, 0, 0);
                this.markLayerChanged(layer);
            } else if (snap.kind === "transform") {
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers();
                this.drawThumb();
                this.notifyChanged();
            } else if (snap.kind === "filter") {
                layer.filter = snap.filter;
                layer.params = { ...snap.params };
                layer.lut = snap.lut ? { ...snap.lut } : null;
                layer._lutData = snap.lutData || null;
                layer.plate = snap.plate ? { ...snap.plate } : null;
                layer._plateImg = snap.plateImg || null;
                layer.name = snap.name || layer.name;
                this.markFilterChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "mask") {
                layer.mask = snap.url ? imageToCanvas(await loadImageEl(snap.url), snap.mw, snap.mh) : null;
                if (!layer.mask) layer.maskEdit = false;
                this.markMaskChanged(layer);
                this.renderLayers();
            } else if (snap.kind === "layerfull") {
                const img = await loadImageEl(snap.url);
                layer.canvas = imageToCanvas(img, snap.cw, snap.ch);
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
                layer.mask = snap.mask ? imageToCanvas(await loadImageEl(snap.mask), snap.mw, snap.mh) : null;
                if (!layer.mask) layer.maskEdit = false;
                layer.maskDirty = !!layer.mask;
                layer._maskedValid = false;
                layer.exportRef = null;
                this.markLayerChanged(layer);
                this.renderLayers();
            }
        }
        this.draw();
    }

    async undoStep() {
        if (this.pending) this.cancelPending();
        const snap = this.undo.pop();
        if (!snap) return;
        const current = this.snapshot(snap);
        if (current) this.redo.push(current);
        await this.applySnapshot(snap);
    }

    async redoStep() {
        if (this.pending) this.cancelPending();
        const snap = this.redo.pop();
        if (!snap) return;
        const current = this.snapshot(snap);
        if (current) this.undo.push(current);
        await this.applySnapshot(snap);
    }

    // ---- selection ops -----------------------------------------------------

    clearSelection() {
        if (!this.selection) return;
        this.selectionLabel = "";
        this.pushUndo({ kind: "selection" });
        this.selection.getContext("2d").clearRect(0, 0, this.width, this.height);
        this.markSelectionChanged();
        this.draw();
    }

    invertSelection() {
        if (!this.selection) return;
        this.pushUndo({ kind: "selection" });
        const sctx = this.selection.getContext("2d");
        const data = sctx.getImageData(0, 0, this.width, this.height);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
            d[i + 3] = 255 - d[i + 3];
        }
        sctx.putImageData(data, 0, 0);
        this.markSelectionChanged();
        this.draw();
    }

    markSelectionChanged() {
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.uploaded.maskHash = null;
        this.renderInfo();
        this.drawThumb();
        this.notifyChanged();
    }

    markLayerChanged(layer) {
        layer.dirty = true;
        layer._maskedValid = false;
        layer.exportRef = null;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.drawThumb();
        this.notifyChanged();
    }

    /** The upload cache; clearing baseHash means "the composite changed" and bumps compositeVersion. */
    makeUploaded() {
        const ed = this;
        let baseHash = null;
        const u = { baseRef: null, maskHash: null, maskRef: null, controlHash: null, controlRef: null };
        Object.defineProperty(u, "baseHash", {
            enumerable: true,
            get: () => baseHash,
            set: (v) => { if (v == null) ed.compositeVersion++; baseHash = v; },
        });
        return u;
    }

    // ---- filter layers ------------------------------------------------------------

    addFilterLayer(id = "grain") {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        if (!FILTERS[id]) id = "grain";
        this.filterCounter += 1;
        const layer = this.addLayer({
            name: `${FILTERS[id].label} ${this.filterCounter}`, kind: "filter", filter: id, params: filterDefaults(id), lut: null,
            ref: null, canvas: makeCanvas(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: false,
        });
        this.setStatus(`${layer.name} added. It filters everything below it; pick the type and drag the sliders in the layer list.`);
        return layer;
    }

    setFilterType(layer, id) {
        if (!FILTERS[id] || layer.filter === id) return;
        this.pushUndo({ kind: "filter", id: layer.id });
        const auto = FILTER_IDS.some((k) => (layer.name || "").startsWith(FILTERS[k].label + " "));
        layer.filter = id;
        layer.params = filterDefaults(id);
        if (auto) layer.name = `${FILTERS[id].label} ${this.filterCounter}`;
        this.markFilterChanged(layer);
        this.renderLayers();
    }

    markFilterChanged(layer, { soon = false } = {}) {
        layer._fcache = null;
        this.uploaded.baseHash = null;
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
            this.pushUndo({ kind: "filter", id: layer.id });
            layer.lut = { name: file.name, size: lut.size, ref: up.ref };
            layer._lutData = lut;
            if (/^LUT/.test(layer.name || "") || !layer.name) layer.name = file.name.replace(/\.cube$/i, "");
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded (${lut.size}³ LUT).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the LUT: " + (err.message || err));
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
            this.pushUndo({ kind: "filter", id: layer.id });
            layer.plate = { name: file.name, ref, w: img.naturalWidth, h: img.naturalHeight, mean: Math.round(st.mean * 10) / 10, std: Math.round(st.std * 10) / 10 };
            layer._plateImg = img;
            this.markFilterChanged(layer);
            this.renderLayers();
            this.setStatus(`${file.name} loaded as grain plate (${img.naturalWidth} × ${img.naturalHeight}, mean ${layer.plate.mean}, noise ${layer.plate.std}).`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not load the plate: " + (err.message || err));
        }
    }

    removePlate(layer) {
        if (!layer.plate) return;
        this.pushUndo({ kind: "filter", id: layer.id });
        layer.plate = null;
        layer._plateImg = null;
        this.markFilterChanged(layer);
        this.renderLayers();
        this.setStatus(`${layer.name}: back to synthetic grain.`);
    }

    /** Filtered copy of `below` for a filter layer, cached until the composite or the parameters change. */
    filteredCanvas(layer, below, forRun, preview) {
        const key = JSON.stringify([layer.filter, layer.params, layer.lut && layer.lut.ref && layer.lut.ref.filename, layer.plate && layer.plate.ref && layer.plate.ref.filename, !!forRun, !!preview, below.width, below.height]);
        const c = layer._fcache;
        if (c && c.version === this.compositeVersion && c.key === key) return c.canvas;
        let input = below, scale = 1;
        if (preview) {
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
        if (!layer._fxCache) layer._fxCache = {};
        try { canvas = applyFilter(layer.filter, input, layer.params, { scale, seed: layer.id, lut: layer._lutData, plate: layer._plateImg || null, plateKey: layer.plate && layer.plate.ref && layer.plate.ref.filename, plateMean: layer.plate && layer.plate.mean, plateStd: layer.plate && layer.plate.std, cache: layer._fxCache }); }
        catch (err) { console.error(err); }
        layer._fcache = { version: this.compositeVersion, key, canvas };
        return canvas;
    }

    /** Draw a filter layer onto `ctx` (an image-sized canvas holding everything below it). */
    applyFilterLayer(ctx, layer, index, forRun) {
        if (!forRun) {
            // While something below the filter is being painted or moved, the cached
            // result would hide the live change: show the layers unfiltered instead.
            const p = this.pointer;
            const gestureLayer = (p && p.layer) || (this.pending && this.pending.layer) || null;
            if (gestureLayer && gestureLayer !== layer) {
                const gi = this.layers.indexOf(gestureLayer);
                if (gi >= 0 && gi < index) return;
            }
        }
        const preview = !forRun && (this.filterPreview === layer.id || this.filterPreview === "*");
        const out = this.filteredCanvas(layer, ctx.canvas, forRun, preview);
        if (!out) return;
        let src = out;
        if (layer.mask) {
            if (!this.filterMaskCanvas || this.filterMaskCanvas.width !== out.width || this.filterMaskCanvas.height !== out.height) this.filterMaskCanvas = makeCanvas(out.width, out.height);
            const m = this.filterMaskCanvas;
            const mctx = m.getContext("2d");
            mctx.globalCompositeOperation = "source-over";
            mctx.globalAlpha = 1;
            mctx.clearRect(0, 0, m.width, m.height);
            mctx.drawImage(out, 0, 0);
            mctx.globalCompositeOperation = "destination-in";
            mctx.drawImage(this.maskWithStroke(layer), 0, 0, m.width, m.height);
            mctx.globalCompositeOperation = "source-over";
            src = m;
        }
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = (layer.blend && layer.blend !== "normal") ? layer.blend : "source-over";
        ctx.drawImage(src, 0, 0, this.width, this.height);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    markMaskChanged(layer) {
        layer.maskDirty = !!layer.mask;
        if (!layer.mask) layer.maskRef = null;
        layer._maskedValid = false;
        layer.exportRef = null;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.drawThumb();
        this.notifyChanged();
    }

    // ---- layer masks and cutouts ------------------------------------------------

    refreshCutoutBackends() {
        if (!this.cutoutSel) return;
        const avail = availableCutoutBackends();
        const cur = this.cutoutSettings.backend;
        this.cutoutSel.innerHTML = "";
        for (const b of avail) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; this.cutoutSel.appendChild(o); }
        if (!avail.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "no RMBG nodes"; this.cutoutSel.appendChild(o); }
        this.cutoutSel.value = avail.some((b) => b.id === cur) ? cur : (avail[0] ? avail[0].id : "");
    }

    /** Remove the background of a layer with an RMBG node; the result becomes its transparency mask. */
    async cutoutLayer(layer) {
        if (!layer || !layer.canvas) return;
        const backend = CUTOUT_BACKENDS.find((b) => b.id === this.cutoutSettings.backend && availableCutoutBackends().includes(b)) || availableCutoutBackends()[0];
        if (!backend) { this.setStatus("No background removal nodes installed (comfyui-rmbg or ComfyUI-BRIA_AI-RMBG)."); return; }
        if (this.cutoutPending) { this.setStatus(`Still removing the background of ${this.cutoutPending.layer.name} ...`); return; }
        try {
            this.cutoutPending = { layer, backend };
            this.renderLayers();
            this.setStatus(`Removing the background of ${layer.name} with ${backend.label} ...`);
            // The layer's own pixels (transparent parts turn black on the way to RGB).
            const up = await uploadCanvas(layer.canvas, `n${this.node.id}_cutsrc`);
            const prompt = {
                cut_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(up.ref) } },
                ...backend.build("cut_load"),
                cut_out: { class_type: "InpaintCanvasMaskOut", inputs: { mask: backend.maskOut, canvas_node: String(this.node.id), purpose: "cutout" } },
            };
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.cutoutPromptId = res && res.prompt_id;
            if (res && res.node_errors && Object.keys(res.node_errors).length) {
                const first = Object.values(res.node_errors)[0];
                throw new Error((first.errors && first.errors[0] && first.errors[0].message) || "prompt rejected");
            }
        } catch (err) {
            console.error(err);
            this.cutoutPending = null;
            this.renderLayers();
            this.setStatus("Background removal failed: " + (err.message || err));
        }
    }

    /** The RMBG mask came back: grayscale PNG at the layer's pixel size -> transparency mask. */
    async applyCutoutFile(info) {
        const pending = this.cutoutPending;
        if (!pending) return;
        const layer = pending.layer;
        if (!this.layers.includes(layer)) { this.cutoutPending = null; this.renderLayers(); return; }
        try {
            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || "temp" }));
            const W = layer.canvas.width, H = layer.canvas.height;
            const tmp = makeCanvas(W, H);
            const tctx = tmp.getContext("2d");
            tctx.drawImage(img, 0, 0, W, H);
            const src = tctx.getImageData(0, 0, W, H).data;
            const m = makeCanvas(W, H);
            const mctx = m.getContext("2d");
            const out = mctx.createImageData(W, H);
            const d = out.data;
            let sum = 0;
            for (let i = 0; i < src.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = src[i]; sum += src[i]; }
            mctx.putImageData(out, 0, 0);
            this.pushUndo({ kind: "mask", id: layer.id });
            layer.mask = m;
            layer.maskEdit = false;
            this.markMaskChanged(layer);
            this.renderLayers();
            this.draw();
            const pct = Math.round(100 * sum / (255 * W * H));
            this.setStatus(`${layer.name}: background removed with ${pending.backend.label}, ${pct}% kept. Enable mask editing to touch it up with P / E.`);
        } catch (err) {
            console.error(err);
            this.setStatus("Could not apply the cutout: " + (err.message || err));
        } finally {
            // cleared only now: the mask is applied before the row's spinner state goes away
            if (this.cutoutPending === pending) this.cutoutPending = null;
            this.renderLayers();
        }
    }

    /** Transparency mask from the selection (Krita: "add transparency mask" from selection). */
    maskFromSelection(layer) {
        if (!layer || !this.selection) return;
        if (!this.getBounds()) { this.setStatus("Select the area to keep first."); return; }
        this.pushUndo({ kind: "mask", id: layer.id });
        const m = makeCanvas(layer.canvas.width, layer.canvas.height);
        const ctx = m.getContext("2d");
        ctx.setTransform(m.width / layer.w, 0, 0, m.height / layer.h, 0, 0);
        ctx.drawImage(this.selection, -layer.x, -layer.y);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, m.width, m.height);
        ctx.globalCompositeOperation = "source-over";
        layer.mask = m;
        layer.maskEdit = false;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(`${layer.name}: mask from selection. Only the selected part stays visible.`);
    }

    /** Bake the mask into the layer's alpha. */
    applyMask(layer, { silent = false, undo = true } = {}) {
        if (!layer || !layer.mask) return;
        if (undo) this.pushUndo({ kind: "layerfull", id: layer.id });
        const px = this.layerPixels(layer);
        const out = makeCanvas(layer.canvas.width, layer.canvas.height);
        out.getContext("2d").drawImage(px, 0, 0);
        layer.canvas = out;
        layer.mask = null;
        layer.maskRef = null;
        layer.maskDirty = false;
        layer.maskEdit = false;
        this.markLayerChanged(layer);
        if (!silent) { this.renderLayers(); this.draw(); this.setStatus(`${layer.name}: mask applied to the pixels.`); }
    }

    removeMask(layer) {
        if (!layer || !layer.mask) return;
        this.pushUndo({ kind: "mask", id: layer.id });
        layer.mask = null;
        layer.maskEdit = false;
        this.markMaskChanged(layer);
        this.renderLayers();
        this.draw();
        this.setStatus(`${layer.name}: mask removed, the whole layer is visible again.`);
    }

    toggleMaskEdit(layer) {
        if (!layer || !layer.mask) return;
        layer.maskEdit = !layer.maskEdit;
        for (const l of this.layers) if (l !== layer) l.maskEdit = false;
        this.activeLayerId = layer.id;
        if (layer.maskEdit && this.tool !== "paint" && this.tool !== "erase") this.setTool("paint");
        this.renderLayers();
        this.draw();
        this.setStatus(layer.maskEdit ? `${layer.name}: editing the mask. Paint (P) reveals, erase (E) hides, Shift+F reveals the selection.` : `${layer.name}: editing pixels again.`);
    }

    // ---- reference images -----------------------------------------------------------

    syncRefControls() {
        if (this.refFitSel) this.refFitSel.value = REF_FITS.includes(this.refSettings.fit) ? this.refSettings.fit : "pad";
        this.refreshCutoutBackends();
    }

    /** Upload image files and add each as a layer (role "reference" by default). */
    async addImageLayers(files, role = "reference") {
        files = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
        if (!files.length) return;
        if (!this.width) {
            await this.loadFile(files.shift());
            if (!files.length || !this.width) return;
        }
        let n = this.layers.filter((l) => this.isReference(l)).length;
        let last = null;
        for (const file of files) {
            try {
                this.setStatus(`Uploading ${file.name || "image"} ...`);
                const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
                const stem = (file.name || "image").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
                const ref = await uploadBlob(file, stem + ext, { overwrite: false });
                const img = await loadImageEl(viewUrl(ref));
                // Shown at a third of the canvas, cascaded from the top left; the file itself stays the reference.
                const s = Math.min(1, (Math.max(this.width, this.height) / 3) / Math.max(img.naturalWidth, img.naturalHeight));
                const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
                const off = 16 + (n % 8) * 24;
                last = this.addLayer({ name: (file.name || "image").replace(/\.[a-z0-9]+$/i, ""), kind: "image", role, ref, canvas: imageToCanvas(img), x: off, y: off, w, h, dirty: false });
                n++;
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err));
            }
        }
        if (last) {
            const refs = this.referenceLayers().length;
            this.setStatus(role === "reference" ? `${files.length} reference image${files.length > 1 ? "s" : ""} added (${refs} will travel with crop_image). They are not part of the image.` : `${files.length} image layer${files.length > 1 ? "s" : ""} added.`);
        }
    }

    // ---- file cleanup ---------------------------------------------------------------

    /** File names every open editor and every open workflow tab still reference. */
    static referencedFiles() {
        const keep = new Set();
        const scan = (text) => { for (const m of String(text || "").matchAll(/"filename"\s*:\s*"([^"]+)"/g)) keep.add(m[1]); };
        for (const n of (app.graph && app.graph._nodes) || []) {
            const ed = n.inpaintEditor;
            if (!ed) continue;
            scan(ed.lastValueString);
            try { scan(ed.getValue()); } catch (_) { /* ignore */ }
            scan(JSON.stringify(ed.uploaded));
            scan(JSON.stringify(ed.layers.map((l) => [l.ref, l.maskRef, l.exportRef, l.lut && l.lut.ref, l.plate && l.plate.ref])));
            if (ed.base) scan(JSON.stringify(ed.base.ref));
        }
        try {
            const wf = app.extensionManager && app.extensionManager.workflow;
            for (const w of (wf && wf.openWorkflows) || []) {
                scan(w.content || w.originalContent || "");
                if (w.activeState) scan(JSON.stringify(w.activeState));
                if (w.initialState) scan(JSON.stringify(w.initialState));
            }
        } catch (_) { /* ignore */ }
        try { for (let i = 0; i < localStorage.length; i++) scan(localStorage.getItem(localStorage.key(i))); } catch (_) { /* ignore */ }
        return Array.from(keep);
    }

    // ---- export -----------------------------------------------------------------

    /** Save the visible composite (filters applied, no control / reference layers) to output/inpaint_canvas. */
    async exportImage({ download = false } = {}) {
        if (!this.base) { this.setStatus("Nothing to save yet."); return null; }
        const fmt = this.saveFormatSel && this.saveFormatSel.value === "jpg" ? "jpg" : "png";
        const stem = ((this.saveNameInput && this.saveNameInput.value) || "inpaint_canvas").trim().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_") || "inpaint_canvas";
        try {
            this.setStatus("Saving ...");
            const canvas = this.flattenToCanvas({ forRun: true });
            let blob = await new Promise((r) => canvas.toBlob(r, fmt === "jpg" ? "image/jpeg" : "image/png", 0.92));
            if (fmt === "png") {
                // Same metadata as SaveImage: the workflow (and the canvas prompt), so the file loads back into ComfyUI.
                try {
                    const workflow = this.node.graph && this.node.graph.serialize ? this.node.graph.serialize() : app.graph.serialize();
                    blob = pngWithText(await blob.arrayBuffer(), { workflow: asciiJson(workflow), inpaint_canvas: asciiJson({ prompt: this.promptText, negative: this.negativeText, width: this.width, height: this.height, seed: this.genSettings.seed, mode: this.genSettings.mode }) });
                } catch (err) { console.warn("Inpaint Canvas: could not embed the workflow", err); }
            }
            // Into the output root like SaveImage, not into inpaint_canvas (that folder is working files the cleanup may delete).
            const ref = await uploadBlob(blob, `${stem}.${fmt}`, { overwrite: false, type: "output", subfolder: "" });
            const kb = Math.round(blob.size / 1024);
            this.setStatus(`Saved output/${ref.subfolder ? ref.subfolder + "/" : ""}${ref.filename} (${this.width} × ${this.height}, ${kb} kB${fmt === "png" ? ", workflow embedded" : ""}).`);
            if (download) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = ref.filename;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
            return ref;
        } catch (err) {
            console.error(err);
            this.setStatus("Save failed: " + (err.message || err));
            return null;
        }
    }

    async cleanupFiles() {
        const fmt = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
        try {
            const keep = InpaintEditor.referencedFiles();
            const call = async (dry) => {
                const r = await api.fetchApi("/inpaint_canvas/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep, dry_run: dry }) });
                if (r.status !== 200) throw new Error(`cleanup route answered ${r.status} (restart ComfyUI after updating the node)`);
                return r.json();
            };
            this.setStatus("Checking files ...");
            const plan = await call(true);
            if (!plan.removed) {
                this.setStatus(`Nothing to clean up: ${plan.kept} file${plan.kept === 1 ? "" : "s"} still in use.`);
                if (this.cleanupInfo) this.cleanupInfo.textContent = `${plan.kept} in use`;
                return;
            }
            const t = plan.by_type || {};
            const msg = `Delete ${plan.removed} file${plan.removed === 1 ? "" : "s"} (${fmt(plan.bytes)}) from the inpaint_canvas folders?\n` +
                `input ${t.input || 0} · output ${t.output || 0} · temp ${t.temp || 0}\n\n` +
                `Kept: ${plan.kept} file${plan.kept === 1 ? "" : "s"} used by open editors, open workflow tabs or saved workflows, and anything younger than two minutes. Discarded history results that are deleted cannot be restored.`;
            if (!window.confirm(msg)) { this.setStatus("Cleanup cancelled."); return; }
            const res = await call(false);
            this.setStatus(`Cleanup: ${res.removed} file${res.removed === 1 ? "" : "s"} deleted (${fmt(res.bytes)}), ${res.kept} kept.`);
            if (this.cleanupInfo) this.cleanupInfo.textContent = `${res.removed} deleted, ${fmt(res.bytes)}`;
        } catch (err) {
            console.error(err);
            this.setStatus("Cleanup failed: " + (err.message || err));
        }
    }

    selectionBounds() {
        if (!this.selection) return null;
        const d = this.selection.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
        for (let y = 0; y < this.height; y++) {
            const row = y * this.width;
            for (let x = 0; x < this.width; x++) {
                if (d[(row + x) * 4 + 3] > 127) {
                    if (x < x0) x0 = x;
                    if (x > x1) x1 = x;
                    if (y < y0) y0 = y;
                    if (y > y1) y1 = y;
                }
            }
        }
        if (x1 < 0) return null;
        return [x0, y0, x1 + 1, y1 + 1];
    }

    getBounds() {
        if (this.selectionDirty) {
            this.cachedBounds = this.selectionBounds();
            this.selectionDirty = false;
        }
        return this.cachedBounds;
    }

    /** Auto sizing values for the current selection, or null without a selection. */
    autoParams() {
        const b = this.getBounds();
        const strength = this.genSettings.mode === "local" ? this.genSettings.denoise : 1;
        return b ? autoSelectionParams(b[2] - b[0], b[3] - b[1], strength) : null;
    }

    cropRect() {
        const b = this.getBounds();
        if (!b) return [0, 0, this.width, this.height];
        const auto = this.cropSettings.context === "auto";
        const padding = auto ? this.autoParams().pad : this.widgetValue("padding", 0);
        let x0 = Math.max(0, b[0] - padding), y0 = Math.max(0, b[1] - padding);
        let x1 = Math.min(this.width, b[2] + padding), y1 = Math.min(this.height, b[3] + padding);
        if (auto) {
            [x0, x1] = ensureMinSpan(x0, x1, this.width, MIN_AUTO_CROP);
            [y0, y1] = ensureMinSpan(y0, y1, this.height, MIN_AUTO_CROP);
        }
        return [x0, y0, x1 - x0, y1 - y0];
    }

    syncCropControls() {
        if (!this.cropContextSel) return;
        this.cropContextSel.value = this.cropSettings.context === "auto" ? "auto" : "manual";
        this.cropFeatherSel.value = this.cropSettings.feather === "auto" ? "auto" : "manual";
        this.cropFillSel.value = this.cropSettings.fill || "none";
        this.cropColorMatch.checked = !!this.cropSettings.colorMatch;
        if (this.cropOriginal) this.cropOriginal.checked = !!this.cropSettings.withOriginal;
        if (this.cropAlign) this.cropAlign.checked = this.cropSettings.align !== false;
        if (this.cropPasteSel) this.cropPasteSel.value = this.cropSettings.paste === "crop" ? "whole crop" : "selection";
        if (this.extendFillSel) this.extendFillSel.value = this.cropSettings.extendFill || "average color";
    }

    widgetValue(name, fallback) {
        const w = this.node.widgets && this.node.widgets.find((x) => x.name === name);
        return w ? (+w.value || 0) : fallback;
    }

    renderInfo() {
        if (!this.infoEl) return;
        const rows = [];
        if (this.base) {
            rows.push(["Canvas", `${this.width} × ${this.height}`]);
            const b = this.getBounds();
            rows.push(["Selection", b ? `${b[2] - b[0]} × ${b[3] - b[1]}` : "none (whole image)"]);
            const [, , cw, ch] = this.cropRect();
            const ap = this.autoParams();
            rows.push(["Crop", `${cw} × ${ch}` + (ap && this.cropSettings.context === "auto" ? ` (context ${ap.pad} px)` : "")]);
            if (ap) rows.push(["Edge", this.cropSettings.feather === "auto" ? `grow ${ap.grow}, feather ${ap.feather}, blend ${ap.blend} px` : `feather ${this.widgetValue("feather", 0)} px`]);
            const target = this.widgetValue("target_size", 0);
            const m = Math.max(1, this.widgetValue("multiple_of", 64) || 64);
            const nBatch = 1 + (b && this.cropSettings.withOriginal && this.cropSettings.fill && this.cropSettings.fill !== "none" ? 1 : 0) + this.referenceLayers().length;
            const pair = nBatch > 1 ? ` ×${nBatch} (batch)` : "";
            if (target > 0) {
                const s = target / Math.max(cw, ch);
                const ew = Math.max(m, Math.round(cw * s / m) * m), eh = Math.max(m, Math.round(ch * s / m) * m);
                const distort = Math.abs((ew / eh) / (cw / ch) - 1) * 100;
                const warn = distort >= 1.5 ? ` · aspect ${distort.toFixed(1)} % off, stretched back on stitch` : "";
                rows.push(["Emitted", `${ew} × ${eh}${pair}${warn}`]);
                rows.push(["Paste", this.cropSettings.paste === "crop" ? "whole crop" : "selection only"]);
            } else {
                rows.push(["Emitted", `${Math.min(this.width, Math.ceil(cw / m) * m)} × ${Math.min(this.height, Math.ceil(ch / m) * m)}${pair}`]);
            }
            const ctrl = this.layers.filter((l) => this.isControl(l) && l.visible).length;
            rows.push(["Control", ctrl ? `${ctrl} layer${ctrl > 1 ? "s" : ""}` : "none (black)"]);
            const refs = this.referenceLayers().length;
            rows.push(["References", refs ? `${refs} image${refs > 1 ? "s" : ""} in crop_image (${this.refSettings.fit})` : "none"]);
            const rs = this.resultInputState();
            rows.push(["Result", `${this.genSettings.mode} → ${rs.name}${rs.wired ? (rs.fallback ? " (only input wired)" : "") : " (not wired!)"}` + (this.genSettings.mode === "local" && this.genSettings.refine ? " · refine" : "")]);
        }
        this.infoEl.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("");
        if (this.canvasInfo) this.canvasInfo.textContent = this.base ? `now ${this.width} × ${this.height}` : "";
    }

    // ---- layers: management ------------------------------------------------

    async setBase(ref, img, { keepLayers = true } = {}) {
        const sizeChanged = img.naturalWidth !== this.width || img.naturalHeight !== this.height;
        this.base = { ref, img };
        this.width = img.naturalWidth;
        this.height = img.naturalHeight;
        if (!keepLayers || sizeChanged) { this.layers = []; this.activeLayerId = null; }
        if (!this.selection || sizeChanged) {
            this.selection = makeCanvas(this.width, this.height);
            this.undo = [];
            this.redo = [];
        }
        this.uploaded.baseHash = null;
        this.uploaded.baseRef = null;
        this.uploaded.controlHash = null;
        this.dropHint.style.display = "none";
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.renderLayers();
        this.renderInfo();
        this.fitView();
        this.drawThumb();
        this.setStatus(`${this.width} × ${this.height}`);
        this.notifyChanged();
    }

    async loadFile(file) {
        if (!file) return;
        try {
            this.setStatus("Uploading " + (file.name || "image") + " ...");
            const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
            const stem = (file.name || "pasted").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";
            const ref = await uploadBlob(file, stem + ext, { overwrite: false });
            const img = await loadImageEl(viewUrl(ref));
            await this.setBase(ref, img, { keepLayers: false });
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    addLayer(layer, { activate = true } = {}) {
        this.layerCounter += 1;
        layer.id = layer.id || ("L" + Date.now().toString(36) + this.layerCounter);
        if (layer.visible == null) layer.visible = true;
        if (layer.opacity == null) layer.opacity = 1;
        if (!layer.kind) layer.kind = "result";
        if (!layer.blend) layer.blend = "normal";
        if (!layer.role) layer.role = "none";
        if (layer.mask === undefined) layer.mask = null;
        if (!layer.mask) { layer.maskRef = null; layer.maskDirty = false; layer.maskEdit = false; }
        this.layers.push(layer);
        if (activate) this.activeLayerId = layer.id;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.renderLayers();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
        return layer;
    }

    addPaintLayer() {
        if (!this.width) { this.setStatus("Load an image first."); return null; }
        this.paintCounter += 1;
        const layer = this.addLayer({
            name: "Paint " + this.paintCounter, kind: "paint", ref: null,
            canvas: makeCanvas(this.width, this.height), x: 0, y: 0, w: this.width, h: this.height, dirty: true,
        });
        this.setStatus(`${layer.name} added. Paint with P, erase with E, fill the selection with Shift+F.`);
        return layer;
    }

    removeLayer(id) {
        if (this.pending && this.pending.layer.id === id) this.cancelPending();
        this.layers = this.layers.filter((l) => l.id !== id);
        if (this.activeLayerId === id) this.activeLayerId = null;
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.renderLayers();
        this.renderHistory();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    moveLayer(id, delta) {
        const i = this.layers.findIndex((l) => l.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= this.layers.length) return;
        const [l] = this.layers.splice(i, 1);
        this.layers.splice(j, 0, l);
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.renderLayers();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
    }

    async addResults(results) {
        for (const r of results || []) {
            if (!r || !r.filename) continue;
            const key = (r.subfolder || "") + "/" + r.filename;
            if (this.seenResults.has(key)) continue;
            this.seenResults.add(key);
            try {
                const ref = { filename: r.filename, subfolder: r.subfolder || SUBFOLDER, type: r.type || "output" };
                const img = await loadImageEl(viewUrl(ref));
                if (!this.width) {
                    await this.setBase(ref, img, { keepLayers: false });
                    continue;
                }
                const n = this.history.length + 1;
                const layer = this.addLayer({ name: "Result " + n, kind: "result", ref, canvas: imageToCanvas(img), x: r.x || 0, y: r.y || 0, w: r.width || img.naturalWidth, h: r.height || img.naturalHeight });
                this.history.push({ key, name: layer.name, ref, x: layer.x, y: layer.y, w: layer.w, h: layer.h, prompt: this.promptText, layerId: layer.id, time: Date.now(),
                    seed: this.genSettings.seed, mode: this.genSettings.mode, denoise: this.genSettings.denoise });
                this.renderHistory();
                const al = r.align && r.align.aligned ? ` · aligned (shift ${r.align.shift[0]}, ${r.align.shift[1]} px, scale ${r.align.scale[0]}, ${r.align.scale[1]})` : "";
                this.setStatus(`Result ${n} added (${r.width} × ${r.height} at ${r.x}, ${r.y})${al}`);
            } catch (err) {
                console.error(err);
                this.setStatus(String(err.message || err));
            }
        }
    }

    renderLayers() {
        if (!this.layerList) return;
        const list = this.layerList;
        list.innerHTML = "";
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const row = el("div", "ipc-layer" + (layer.id === this.activeLayerId ? " ipc-selected" : ""));
            row.addEventListener("click", () => { if (this.pending) this.cancelPending(); this.activeLayerId = layer.id; this.renderLayers(); this.updateSubbar(); this.draw(); });
            const top = el("div", "ipc-row");
            top.appendChild(miniButton(layer.visible ? "eye" : "eyeOff", "Toggle visibility", () => {
                layer.visible = !layer.visible;
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
            }, layer.visible ? "" : "ipc-off"));
            const name = el("span", "ipc-name", layer.name);
            name.title = `${layer.w} × ${layer.h} at ${layer.x}, ${layer.y}`;
            top.appendChild(name);
            const refIndex = this.isReference(layer) ? this.referenceLayers().indexOf(layer) : -1;
            const isFx = layer.kind === "filter";
            const kindText = isFx ? "filter" : (this.isControl(layer) ? layer.role : (this.isReference(layer) ? (refIndex >= 0 ? `ref ${refIndex + 1}` : "ref (hidden)") : layer.kind));
            top.appendChild(el("span", "ipc-kind" + (isFx ? " ipc-fxk" : (this.isControl(layer) ? " ipc-ctrl" : (this.isReference(layer) ? " ipc-ref" : ""))), kindText));
            const up = miniButton("up", "Move layer up", () => this.moveLayer(layer.id, +1));
            up.disabled = i === this.layers.length - 1;
            top.appendChild(up);
            const down = miniButton("down", "Move layer down", () => this.moveLayer(layer.id, -1));
            down.disabled = i === 0;
            top.appendChild(down);
            top.appendChild(miniButton("trash", "Delete layer", () => this.removeLayer(layer.id), "ipc-del"));
            row.appendChild(top);

            const opRow = el("div", "ipc-op");
            opRow.appendChild(el("span", null, "Opacity"));
            const op = document.createElement("input");
            op.type = "range";
            op.min = 0; op.max = 100; op.value = Math.round(layer.opacity * 100);
            op.title = "Layer opacity";
            const pct = el("b", null, Math.round(layer.opacity * 100) + "%");
            op.addEventListener("click", (e) => e.stopPropagation());
            op.addEventListener("input", () => {
                layer.opacity = op.value / 100; pct.textContent = op.value + "%";
                // A filter layer's own opacity does not change what it filters: keep its cache.
                // Layers below a filter make every filter above recompute; do that at preview size while dragging.
                if (layer.kind !== "filter") { this.filterPreview = "*"; this.uploaded.baseHash = null; this.uploaded.controlHash = null; }
                this.drawSoon();
            });
            op.addEventListener("change", () => { this.filterPreview = null; this.uploaded.baseHash = null; this.uploaded.controlHash = null; this.draw(); this.drawThumb(); this.notifyChanged(); });
            opRow.appendChild(op);
            opRow.appendChild(pct);
            row.appendChild(opRow);

            if (isFx) row.appendChild(this.buildFilterControls(layer));

            const modeRow = el("div", "ipc-op");
            const blendLab = el("label", null, "Blend");
            const blend = selectInput(BLEND_MODES, layer.blend || "normal", "Blend mode");
            blend.addEventListener("change", () => { layer.blend = blend.value; this.uploaded.baseHash = null; this.draw(); this.drawThumb(); this.notifyChanged(); });
            blendLab.appendChild(blend);
            modeRow.appendChild(blendLab);
            const roleLab = el("label", null, "Role");
            const role = selectInput(ROLES, layer.role || "none", "Role: none = part of the image; reference = not in the image, sent along with crop_image as an extra batch image (Flux.2 / Kontext multi-reference); scribble, lineart, depth, pose, canny, other = control_image on black");
            role.addEventListener("change", () => {
                layer.role = role.value;
                layer.exportRef = null;
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
            });
            roleLab.appendChild(role);
            roleLab.hidden = isFx;
            modeRow.appendChild(roleLab);
            row.appendChild(modeRow);

            // transparency mask: cutout (RMBG), from selection, edit, apply, remove
            const maskRow = el("div", "ipc-maskrow");
            const busy = !!(this.cutoutPending && this.cutoutPending.layer === layer);
            const cut = miniButton("scissors", busy ? "Removing the background ..." : "Cutout: remove the background with the model on the right (RMBG). The result is a transparency mask you can edit.", () => this.cutoutLayer(layer));
            cut.disabled = busy || isFx || !availableCutoutBackends().length;
            maskRow.appendChild(cut);
            if (layer.id === this.activeLayerId && !isFx) {
                const sel = selectInput(["auto"], "auto", "Background removal model");
                this.cutoutSel = sel;
                this.refreshCutoutBackends();
                sel.addEventListener("change", () => { this.cutoutSettings.backend = sel.value; this.notifyChanged(); });
                maskRow.appendChild(sel);
            }
            maskRow.appendChild(miniButton("mask", "Mask from selection: only the selected part of the layer stays visible", () => this.maskFromSelection(layer)));
            maskRow.appendChild(el("span", "ipc-grow"));
            maskRow.appendChild(el("span", null, layer.mask ? (layer.maskEdit ? "mask ✎" : "mask") : "no mask"));
            const editBtn = miniButton("maskEdit", "Edit the mask with the paint (reveal) and erase (hide) tools", () => this.toggleMaskEdit(layer), layer.maskEdit ? "ipc-on" : "");
            editBtn.disabled = !layer.mask;
            maskRow.appendChild(editBtn);
            const applyBtn = miniButton("check", "Apply the mask to the pixels", () => this.applyMask(layer));
            applyBtn.disabled = !layer.mask;
            maskRow.appendChild(applyBtn);
            const delMask = miniButton("trash", "Remove the mask (the pixels stay)", () => this.removeMask(layer), "ipc-del");
            delMask.disabled = !layer.mask;
            maskRow.appendChild(delMask);
            row.appendChild(maskRow);
            list.appendChild(row);
        }
        const row = el("div", "ipc-layer" + (this.activeLayerId === null ? " ipc-selected" : ""));
        row.addEventListener("click", () => { this.activeLayerId = null; this.renderLayers(); this.draw(); });
        const top = el("div", "ipc-row");
        const eye = el("span", "ipc-mini");
        eye.innerHTML = icon("eye", 16);
        top.appendChild(eye);
        const name = el("span", "ipc-name", this.base ? "Base" : "No image");
        name.title = this.base && this.base.ref ? this.base.ref.filename : "";
        top.appendChild(name);
        top.appendChild(el("span", "ipc-kind", "base"));
        row.appendChild(top);
        list.appendChild(row);
    }

    /** Type select, one slider per parameter, LUT loader: the controls of a filter layer row. */
    buildFilterControls(layer) {
        const box = el("div", "ipc-fx");
        const stop = (e) => e.stopPropagation();
        const typeSel = document.createElement("select");
        typeSel.className = "ipc-sel";
        typeSel.title = "Filter type";
        for (const id of FILTER_IDS) { const o = document.createElement("option"); o.value = id; o.textContent = FILTERS[id].label; typeSel.appendChild(o); }
        typeSel.value = FILTERS[layer.filter] ? layer.filter : "grain";
        typeSel.addEventListener("click", stop);
        typeSel.addEventListener("keydown", stop);
        typeSel.addEventListener("change", () => this.setFilterType(layer, typeSel.value));
        box.appendChild(typeSel);
        const def = FILTERS[layer.filter] || FILTERS.grain;
        if (def.needsLut) {
            const lr = el("div", "ipc-lutrow");
            const input = document.createElement("input");
            input.type = "file"; input.accept = ".cube,.CUBE"; input.style.display = "none";
            input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; if (f) this.loadLutFile(layer, f); });
            input.addEventListener("click", stop);
            lr.appendChild(input);
            const load = iconButton("load", "Load a 3D LUT (.cube). It is stored with the workflow.", () => input.click(), ".cube");
            load.classList.add("ipc-small");
            lr.appendChild(load);
            lr.appendChild(el("span", null, layer.lut ? `${layer.lut.name} (${layer.lut.size}³)` : "no LUT loaded"));
            box.appendChild(lr);
        }
        if (def.plate) {
            // real grain plate (scan of a uniformly exposed film, e.g. fotokorn's): replaces the synthetic noise
            const pr = el("div", "ipc-lutrow");
            const input = document.createElement("input");
            input.type = "file"; input.accept = "image/*"; input.style.display = "none";
            input.addEventListener("change", () => { const f = input.files && input.files[0]; input.value = ""; if (f) this.loadPlateFile(layer, f); });
            input.addEventListener("click", stop);
            pr.appendChild(input);
            const load = iconButton("image", "Load a real grain plate (a scan of uniformly exposed film, JPG/PNG). It replaces the synthetic grain; Grain sets its strength, Plate its scale (1 = plate pixels 1:1).", () => input.click(), "Plate");
            load.classList.add("ipc-small");
            pr.appendChild(load);
            pr.appendChild(el("span", null, layer.plate ? `${layer.plate.name} (${layer.plate.w} × ${layer.plate.h})` : "synthetic grain"));
            if (layer.plate) {
                const rm = miniButton("trash", "Remove the plate (back to synthetic grain)", () => this.removePlate(layer), "ipc-del");
                pr.appendChild(rm);
            }
            box.appendChild(pr);
        }
        const fmt = (p, v) => (p.type === "bool" ? (v ? "on" : "off") : (Number.isInteger(p.step) ? Math.round(v) : (+v).toFixed(p.step < 0.1 ? 2 : 1)) + (p.unit || ""));
        let presetSel = null;
        for (const p of def.params) {
            if (p.onlyWithPlate && !layer.plate) continue;
            if (p.notWithPlate && layer.plate) continue;
            const lab = el("span", null, p.label);
            box.appendChild(lab);
            const cur = layer.params[p.key] ?? p.default;
            if (p.type === "select") {
                // a preset fills the other parameters; touching a slider turns it back to "custom"
                const sel = document.createElement("select");
                sel.className = "ipc-sel";
                sel.style.gridColumn = "2 / -1";
                sel.title = "Film stock: sets amount, grain size and colour share (grain character only, the colour look is a LUT's job). Values assume a picture of about 2000 px.";
                let group = null;
                for (const o of p.options) {
                    const opt = document.createElement("option"); opt.value = o.id; opt.textContent = o.label;
                    if (o.group) {
                        if (!group || group.label !== o.group) { group = document.createElement("optgroup"); group.label = o.group; sel.appendChild(group); }
                        group.appendChild(opt);
                    } else sel.appendChild(opt);
                }
                sel.value = p.options.some((o) => o.id === cur) ? cur : p.options[0].id;
                sel.addEventListener("click", stop);
                sel.addEventListener("keydown", stop);
                sel.addEventListener("change", () => {
                    const preset = p.options.find((o) => o.id === sel.value);
                    if (!preset) return;
                    this.pushUndo({ kind: "filter", id: layer.id });
                    layer.params[p.key] = preset.id;
                    for (const [k, v] of Object.entries(preset)) if (k !== "id" && k !== "label" && k !== "group") layer.params[k] = v;
                    if (!("look" in preset)) layer.params.look = null;
                    // layer names are not editable, so the preset may name the layer
                    layer.name = preset.id === "custom" ? `${FILTERS[layer.filter].label} ${this.filterCounter}` : preset.label.replace(/ \(.*\)$/, "");
                    this.markFilterChanged(layer);
                    this.renderLayers();
                });
                presetSel = sel;
                box.appendChild(sel);
                continue;
            }
            const val = el("b", null, fmt(p, cur));
            if (p.type === "bool") {
                const cb = document.createElement("input");
                cb.type = "checkbox"; cb.checked = !!cur;
                cb.addEventListener("click", stop);
                cb.addEventListener("change", () => {
                    this.pushUndo({ kind: "filter", id: layer.id });
                    layer.params[p.key] = cb.checked;
                    val.textContent = fmt(p, cb.checked);
                    this.markFilterChanged(layer);
                });
                box.appendChild(cb);
                box.appendChild(val);
                continue;
            }
            const range = document.createElement("input");
            range.type = "range"; range.min = p.min; range.max = p.max; range.step = p.step; range.value = cur;
            range.title = p.label;
            range.addEventListener("click", stop);
            range.addEventListener("pointerdown", stop);
            range.addEventListener("keydown", stop);
            range.addEventListener("input", () => {
                if (!layer._undoPending) layer._undoPending = this.snapshot({ kind: "filter", id: layer.id });
                layer.params[p.key] = +range.value;
                val.textContent = fmt(p, +range.value);
                if (presetSel && !p.keepPreset && layer.params.preset !== "custom") { layer.params.preset = "custom"; presetSel.value = "custom"; }
                this.filterPreview = layer.id;
                this.markFilterChanged(layer, { soon: true });
            });
            range.addEventListener("change", () => {
                this.filterPreview = null;
                if (layer._undoPending) { this.pushUndoSnapshot(layer._undoPending); layer._undoPending = null; }
                layer.params[p.key] = +range.value;
                this.markFilterChanged(layer);
            });
            box.appendChild(range);
            box.appendChild(val);
        }
        return box;
    }

    // ---- history -------------------------------------------------------------

    renderHistory() {
        if (!this.historyList) return;
        const list = this.historyList;
        list.innerHTML = "";
        if (!this.history.length) {
            list.appendChild(el("div", "ipc-sec", "Results show up here with a preview."));
            return;
        }
        for (let i = this.history.length - 1; i >= 0; i--) {
            const h = this.history[i];
            const layer = this.layers.find((l) => l.id === h.layerId) || null;
            const item = el("div", "ipc-hitem" + (layer ? "" : " ipc-gone"));
            const thumb = document.createElement("canvas");
            thumb.width = 112; thumb.height = 112;
            thumb.title = "Solo: show only this result";
            this.drawHistoryThumb(thumb, h);
            thumb.addEventListener("click", (e) => { e.stopPropagation(); this.soloResult(h); });
            item.appendChild(thumb);
            const text = el("div", "ipc-htext");
            const title = el("b", null, h.name + (layer ? "" : " (discarded)"));
            text.appendChild(title);
            text.appendChild(el("span", null, `${h.w} × ${h.h} at ${h.x}, ${h.y}`));
            if (h.seed != null) {
                const meta = el("span", null, `${h.mode || "api"} · seed ${h.seed}` + (h.mode === "local" && h.denoise != null ? ` · denoise ${h.denoise}` : ""));
                meta.title = "Click to use this seed again";
                meta.style.cursor = "pointer";
                meta.addEventListener("click", (e) => { e.stopPropagation(); this.genSettings.seed = h.seed; this.genSettings.seedRandom = false; this.syncGenControls(); this.notifyChanged(); this.setStatus(`Seed ${h.seed} set (random off).`); });
                text.appendChild(meta);
            }
            if (h.prompt) { const p = el("span", null, h.prompt); p.title = h.prompt; text.appendChild(p); }
            item.appendChild(text);
            if (layer) {
                item.appendChild(miniButton("solo", "Solo: show only this result", () => this.soloResult(h)));
                item.appendChild(miniButton("trash", "Discard: remove the layer (the file stays, restore is possible)", () => this.removeLayer(layer.id), "ipc-del"));
            } else {
                item.appendChild(miniButton("restore", "Restore this result as a layer", () => this.restoreResult(h)));
            }
            list.appendChild(item);
        }
    }

    drawHistoryThumb(canvas, h) {
        const paint = (img) => {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const s = Math.min(canvas.width / img.width, canvas.height / img.height);
            const w = img.width * s, hh = img.height * s;
            ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - hh) / 2, w, hh);
        };
        const layer = this.layers.find((l) => l.id === h.layerId);
        if (layer && layer.canvas) { paint(this.layerPixels(layer)); return; }
        if (h.thumbImg) { paint(h.thumbImg); return; }
        loadImageEl(viewUrl(h.ref)).then((img) => { h.thumbImg = img; paint(img); }).catch(() => { /* ignore */ });
    }

    soloResult(h) {
        for (const l of this.layers) {
            if (l.kind !== "result") continue;
            l.visible = l.id === h.layerId;
        }
        const layer = this.layers.find((l) => l.id === h.layerId);
        if (layer) this.activeLayerId = layer.id;
        this.uploaded.baseHash = null;
        this.renderLayers();
        this.renderInfo();
        this.draw();
        this.drawThumb();
        this.notifyChanged();
        this.setStatus(layer ? `Showing only ${h.name}.` : `${h.name} is discarded; restore it first.`);
    }

    clearHistory() {
        if (!this.history.length) { this.setStatus("The history is already empty."); return; }
        const gone = this.history.filter((h) => !this.layers.some((l) => l.id === h.layerId)).length;
        const msg = `Clear ${this.history.length} result${this.history.length === 1 ? "" : "s"} from the history? Layers are kept.` +
            (gone ? ` ${gone} discarded result${gone === 1 ? "" : "s"} can no longer be restored.` : "");
        if (!window.confirm(msg)) return;
        this.history = [];
        this.renderHistory();
        this.notifyChanged();
        this.setStatus("History cleared.");
    }

    async restoreResult(h) {
        try {
            const img = h.thumbImg || await loadImageEl(viewUrl(h.ref));
            const layer = this.addLayer({ name: h.name, kind: "result", ref: h.ref, canvas: imageToCanvas(img), x: h.x, y: h.y, w: h.w, h: h.h });
            h.layerId = layer.id;
            this.renderHistory();
            this.setStatus(`${h.name} restored.`);
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    // ---- compositing -------------------------------------------------------

    drawComposite(ctx, opts = {}) {
        if (!this.base) return;
        const hasFilters = !opts.controlOnly && this.layers.some((l) => l.kind === "filter" && l.visible);
        if (!hasFilters) { this.drawLayersInto(ctx, opts); return; }
        // Filters need the composite below them at image resolution: build it offscreen first.
        if (!this.flatCanvas || this.flatCanvas.width !== this.width || this.flatCanvas.height !== this.height) this.flatCanvas = makeCanvas(this.width, this.height);
        const fctx = this.flatCanvas.getContext("2d");
        fctx.setTransform(1, 0, 0, 1, 0, 0);
        fctx.globalAlpha = 1;
        fctx.globalCompositeOperation = "source-over";
        fctx.clearRect(0, 0, this.width, this.height);
        this.drawLayersInto(fctx, opts);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(this.flatCanvas, 0, 0);
    }

    drawLayersInto(ctx, { forRun = false, controlOnly = false } = {}) {
        if (controlOnly) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, this.width, this.height);
        } else {
            ctx.drawImage(this.base.img, 0, 0);
        }
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (!layer.visible || !layer.canvas) continue;
            if (layer.kind === "filter") { if (!controlOnly) this.applyFilterLayer(ctx, layer, i, forRun); continue; }
            const ctrl = this.isControl(layer);
            if (controlOnly && !ctrl) continue;
            if (forRun && (ctrl || this.isReference(layer))) continue;
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = (!controlOnly && layer.blend && layer.blend !== "normal") ? layer.blend : "source-over";
            this.drawLayer(ctx, layer);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    }

    drawLayer(ctx, layer) {
        const p = this.pending;
        if (p && p.layer === layer) {
            const fine = !this.pointer;
            const n = this.pendingSubdivisions(p, fine);
            const px = this.layerPixels(layer);
            if (p.mode === "rotate") {
                const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(p.angle);
                ctx.drawImage(px, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
                ctx.restore();
            } else {
                drawMesh(ctx, px, (u, v) => this.pendingDst(p, u, v), n, n);
            }
            return;
        }
        ctx.drawImage(this.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
    }

    flattenToCanvas(opts = {}) {
        const c = makeCanvas(this.width, this.height);
        this.drawComposite(c.getContext("2d"), opts);
        return c;
    }

    maskToCanvas() {
        const c = makeCanvas(this.width, this.height);
        const ctx = c.getContext("2d");
        const src = this.selection.getContext("2d").getImageData(0, 0, this.width, this.height).data;
        const out = ctx.createImageData(this.width, this.height);
        const d = out.data;
        for (let i = 0; i < src.length; i += 4) {
            const a = src[i + 3];
            d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        return c;
    }

    async flatten() {
        if (!this.base || !this.layers.length) return;
        try {
            this.setStatus("Flattening ...");
            const { ref, hash } = await uploadCanvas(this.flattenToCanvas({ forRun: true }), `n${this.node.id}_base`);
            const img = await loadImageEl(viewUrl(ref));
            this.layers = this.layers.filter((l) => this.isControl(l) || this.isReference(l));
            this.activeLayerId = null;
            this.base = { ref, img };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus("Flattened into base layer (control and reference layers kept).");
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    /** Upload every edited layer so its pixels survive a reload. */
    async syncLayers() {
        for (const layer of this.layers) {
            if (layer.dirty && layer.canvas) {
                const { ref } = await uploadCanvas(layer.canvas, `n${this.node.id}_layer`);
                layer.ref = ref;
                layer.dirty = false;
            }
            if (layer.maskDirty && layer.mask) {
                const { ref } = await uploadCanvas(layer.mask, `n${this.node.id}_lmask`);
                layer.maskRef = ref;
                layer.maskDirty = false;
            }
        }
        this.notifyChanged();
    }

    /** Draw once on the next animation frame, however many slider events arrive before it. */
    drawSoon() {
        if (this._drawQueued) return;
        this._drawQueued = true;
        requestAnimationFrame(() => { this._drawQueued = false; this.draw(); });
    }

    /** Selection as a marching-ants outline: the mask shifted by a screen pixel in eight directions minus the mask, filled with a moving stripe pattern. */
    drawMarchingAnts(ctx) {
        const W = this.canvas.width, H = this.canvas.height;
        if (!this.antsCanvas || this.antsCanvas.width !== W || this.antsCanvas.height !== H) this.antsCanvas = makeCanvas(W, H);
        const a = this.antsCanvas.getContext("2d");
        const s = this.view.scale, vx = this.view.x, vy = this.view.y;
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-over";
        a.globalAlpha = 1;
        a.clearRect(0, 0, W, H);
        a.imageSmoothingEnabled = s < 1;
        const r = 1.25;
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            a.setTransform(s, 0, 0, s, vx + dx, vy + dy);
            a.drawImage(this.selection, 0, 0);
        }
        a.setTransform(s, 0, 0, s, vx, vy);
        a.globalCompositeOperation = "destination-out";
        a.drawImage(this.selection, 0, 0);
        a.setTransform(1, 0, 0, 1, 0, 0);
        a.globalCompositeOperation = "source-in";
        if (!this.antsPattern) {
            const tile = makeCanvas(8, 8);
            const t = tile.getContext("2d");
            t.fillStyle = "#fff"; t.fillRect(0, 0, 8, 8);
            t.fillStyle = "#000";
            t.beginPath();
            t.moveTo(0, 0); t.lineTo(4, 0); t.lineTo(8, 4); t.lineTo(8, 8); t.lineTo(4, 8); t.lineTo(0, 4); t.closePath();
            t.fill();
            this.antsPattern = a.createPattern(tile, "repeat");
        }
        const offset = Math.floor(Date.now() / 120) % 8;
        try { this.antsPattern.setTransform(new DOMMatrix().translate(offset, 0)); } catch (_) { /* old browsers: static stripes */ }
        a.fillStyle = this.antsPattern;
        a.fillRect(0, 0, W, H);
        a.globalCompositeOperation = "source-over";
        const t = ctx.getTransform();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.antsCanvas, 0, 0);
        ctx.setTransform(t);
        if (!this.antsTimer) {
            // keep the ants walking while a selection is shown; stops itself when there is none or the editor closes
            this.antsTimer = setInterval(() => {
                if (!this.isOpen || this.selectionDisplay !== "ants" || !this.getBounds()) { clearInterval(this.antsTimer); this.antsTimer = null; return; }
                if (!this.pointer) this.draw();
            }, 120);
        }
    }

    draw() {
        if (!this.isOpen) return;
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!this.base) return;
        const s = this.view.scale;
        ctx.setTransform(s, 0, 0, s, this.view.x, this.view.y);
        ctx.imageSmoothingEnabled = s < 1;
        this.drawComposite(ctx);

        if (this.selectionDisplay === "tint" || !this.getBounds()) {
            ctx.globalAlpha = 0.4;
            ctx.drawImage(this.selection, 0, 0);
            ctx.globalAlpha = 1;
        } else {
            this.drawMarchingAnts(ctx);
        }

        if (this.tool === "object" && this.hoverObjectCanvas && !this.spaceDown) {
            // the object under the cursor, red shape shown in cyan
            ctx.save();
            ctx.globalAlpha = 0.5;
            try { ctx.filter = "hue-rotate(180deg)"; } catch (_) { /* old canvas */ }
            ctx.drawImage(this.hoverObjectCanvas, 0, 0);
            ctx.restore();
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
                const label = `ref ${i + 1}`;
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
        const maskLayer = this.layers.find((l) => l.mask && l.maskEdit && l.visible);
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
                const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => this.pendingDst(pend, u, v));
                ctx.beginPath();
                corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
                ctx.closePath();
                ctx.stroke();
                const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
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
            ctx.setLineDash(this.tool === "transform" ? [] : [4 / s, 4 / s]);
            ctx.strokeRect(active.x, active.y, active.w, active.h);
            if (this.tool === "transform") {
                const r = HANDLE_PX / s / 2;
                ctx.fillStyle = "#ffb347";
                const handles = this.layerHandles(active);
                for (const name of ["nw", "ne", "sw", "se"]) { const [cx, cy] = handles[name]; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); }
                ctx.fillStyle = "#1e1e1e";
                for (const name of ["n", "s", "w", "e"]) { const [cx, cy] = handles[name]; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
            }
            ctx.restore();
        }

        const p = this.pointer;
        if (p && p.kind === "rect") {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#fff";
            ctx.setLineDash([4 / s, 3 / s]);
            ctx.strokeRect(p.start[0], p.start[1], p.cur[0] - p.start[0], p.cur[1] - p.start[1]);
            ctx.restore();
        }
        if (this.lassoPoints && this.lassoPoints.length > 1) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = "#fff";
            ctx.beginPath();
            ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
            for (const [x, y] of this.lassoPoints) ctx.lineTo(x, y);
            ctx.stroke();
            ctx.restore();
        }
        const brushTools = ["select", "deselect", "paint", "erase"];
        if (this.hover && brushTools.includes(this.tool) && !(p && p.kind === "pan") && !this.spaceDown) {
            ctx.save();
            ctx.lineWidth = 1 / s;
            ctx.strokeStyle = this.tool === "paint" ? this.color : (this.tool === "erase" || this.tool === "deselect" ? "#ffd166" : "#fff");
            ctx.beginPath();
            ctx.arc(this.hover[0], this.hover[1], this.brushSize / 2, 0, Math.PI * 2);
            ctx.stroke();
            if ((this.tool === "paint" || this.tool === "erase") && this.activeHardness() < 0.98) {
                ctx.setLineDash([3 / s, 3 / s]);
                ctx.beginPath();
                ctx.arc(this.hover[0], this.hover[1], (this.brushSize / 2) * this.activeHardness(), 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // ---- queue -------------------------------------------------------------

    // ---- editor-driven settings (setting_n outputs) -------------------------------

    /** Connected setting outputs with their targets: [{index, output, node, inputName, spec, widget}]. */
    settingTargets() {
        const res = [];
        const outs = this.node.outputs || [];
        const graph = this.node.graph || app.graph;
        for (let i = FIXED_OUTPUTS; i < outs.length; i++) {
            const o = outs[i];
            if (!isSettingOutput(o) || !o.links || !o.links.length) continue;
            const link = linkOf(graph, o.links[0]);
            if (!link) continue;
            const target = graph.getNodeById(link.target_id);
            if (!target) continue;
            const input = target.inputs && target.inputs[link.target_slot];
            if (!input) continue;
            const inputName = input.name;
            const nd = target.constructor && target.constructor.nodeData;
            const spec = nd && nd.input && ((nd.input.required && nd.input.required[inputName]) || (nd.input.optional && nd.input.optional[inputName])) || null;
            const widget = target.widgets && target.widgets.find((w) => w.name === inputName) || null;
            res.push({ index: settingIndex(o), output: o, node: target, inputName, spec, widget });
        }
        return res;
    }

    /** Kind and options of a target input from its node definition (or its widget as fallback). */
    settingKind(t) {
        const spec = t.spec;
        let type = spec ? spec[0] : (t.widget ? t.widget.type : "STRING");
        let opts = spec && spec[1] ? spec[1] : {};
        if (Array.isArray(type)) return { kind: "combo", options: type, opts };
        if (type === "COMBO") return { kind: "combo", options: (opts.options || (t.widget && t.widget.options && t.widget.options.values) || []), opts };
        if (type === "INT" || type === "FLOAT") return { kind: "number", type, opts };
        if (type === "BOOLEAN") return { kind: "boolean", opts };
        if (t.widget && t.widget.type === "combo") return { kind: "combo", options: (t.widget.options && t.widget.options.values) || [], opts };
        if (t.widget && t.widget.type === "number") return { kind: "number", type: Number.isInteger(t.widget.options && t.widget.options.precision) && t.widget.options.precision === 0 ? "INT" : "FLOAT", opts: t.widget.options || {} };
        return { kind: "string", opts };
    }

    /** Called when a setting output is (dis)connected: keep the stored values in step with the targets. */
    settingsChanged() {
        const targets = this.settingTargets();
        const live = new Set();
        for (const t of targets) {
            const key = String(t.index);
            live.add(key);
            const k = this.settingKind(t);
            const label = `${t.node.title || t.node.type} · ${t.inputName}`;
            const type = k.kind === "number" ? k.type : (k.kind === "boolean" ? "BOOLEAN" : (k.kind === "combo" ? "COMBO" : "STRING"));
            const cur = this.settings[key];
            if (!cur || cur.target !== `${t.node.id}:${t.inputName}`) {
                // new target: start from what the widget shows now, so connecting changes nothing
                const value = t.widget ? t.widget.value : (k.kind === "combo" ? k.options[0] : (k.kind === "number" ? (k.opts.default ?? 0) : (k.kind === "boolean" ? !!k.opts.default : "")));
                this.settings[key] = { value, type, label, target: `${t.node.id}:${t.inputName}` };
            } else {
                cur.type = type; cur.label = label;
            }
        }
        for (const key of Object.keys(this.settings)) if (!live.has(key)) delete this.settings[key];
        this.renderSettings();
        this.notifyChanged();
    }

    renderSettings() {
        if (!this.settingsList) return;
        const list = this.settingsList;
        list.innerHTML = "";
        const targets = this.settingTargets();
        if (!targets.length) {
            list.appendChild(el("span", null, "Wire a setting output of the node into any widget (lora_name, ckpt_name, steps ...) and it shows up here."));
            return;
        }
        for (const t of targets) {
            const key = String(t.index);
            const entry = this.settings[key];
            if (!entry) continue;
            const k = this.settingKind(t);
            const lab = el("label", null, entry.label);
            lab.title = `setting_${t.index} → ${entry.label}`;
            let control;
            const commit = (v) => { entry.value = v; if (t.widget) { try { t.widget.value = v; } catch (_) { /* read-only */ } } this.notifyChanged(); };
            if (k.kind === "combo") {
                control = selectInput(k.options.map(String), String(entry.value), entry.label);
                if (!k.options.map(String).includes(String(entry.value)) && k.options.length) { entry.value = k.options[0]; control.value = String(entry.value); }
                control.addEventListener("change", () => commit(control.value));
            } else if (k.kind === "number") {
                const o = k.opts || {};
                control = numberInput(entry.value, o.min ?? -1e9, o.max ?? 1e9, entry.label, 96);
                control.step = o.step ?? (k.type === "INT" ? 1 : 0.01);
                control.addEventListener("change", () => commit(k.type === "INT" ? Math.round(+control.value || 0) : (+control.value || 0)));
            } else if (k.kind === "boolean") {
                control = document.createElement("input"); control.type = "checkbox"; control.checked = !!entry.value;
                control.addEventListener("change", () => commit(control.checked));
            } else {
                control = document.createElement("input"); control.type = "text"; control.value = entry.value == null ? "" : String(entry.value); control.spellcheck = false;
                control.addEventListener("keydown", (e) => e.stopPropagation());
                control.addEventListener("change", () => commit(control.value));
            }
            lab.appendChild(control);
            list.appendChild(lab);
        }
    }

    /** Name of the result input the current mode expects, and whether something is wired to it. */
    /** Which result input the run will use: the mode's own, or the other one when only that is wired. */
    resultInputState() {
        const want = this.genSettings.mode === "local" ? "result_local" : "result";
        const other = want === "result" ? "result_local" : "result";
        const wired = (name) => { const input = (this.node.inputs || []).find((i) => i.name === name); return !!(input && input.link != null); };
        if (wired(want)) return { name: want, wired: true, fallback: false };
        if (wired(other)) return { name: other, wired: true, fallback: true };
        return { name: want, wired: false, fallback: false };
    }

    syncGenControls() {
        if (!this.modeSel) return;
        const local = this.genSettings.mode === "local";
        this.modeSel.value = local ? "local" : "api";
        this.denoiseInput.value = this.genSettings.denoise;
        if (this.denoiseVal) this.denoiseVal.textContent = (+this.genSettings.denoise || 1).toFixed(2);
        this.seedInput.value = this.genSettings.seed;
        this.seedRandom.checked = !!this.genSettings.seedRandom;
        this.refineBtn.classList.toggle("ipc-toggle-on", !!this.genSettings.refine);
        this.refineBtn.hidden = !local;
        this.denoiseInput.parentElement.hidden = !local;
        if (this.negativeInput) this.negativeInput.hidden = !local;
    }

    async generate() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        if (this.genSettings.seedRandom) { this.genSettings.seed = randomSeed(); if (this.seedInput) this.seedInput.value = this.genSettings.seed; }
        const { name, wired } = this.resultInputState();
        try {
            this.generateBtn.disabled = true;
            this.setStatus(wired ? `Queueing (${this.genSettings.mode}, seed ${this.genSettings.seed}, result from ${name}) ...` : `Queueing, but nothing is wired into "result" or "result_local": the result will not come back into the canvas.`);
            try {
                await app.queuePrompt(0);
            } catch (first) {
                // Some third-party extensions wrap queuePrompt and throw once on the
                // first call after a page load. One retry gets past that.
                console.warn("Inpaint Canvas: queuePrompt failed once, retrying", first);
                await new Promise((r) => setTimeout(r, 300));
                await app.queuePrompt(0);
            }
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        } finally {
            this.generateBtn.disabled = false;
            if (this.isOpen) this.root.focus({ preventScroll: true });
        }
    }

    // ---- persistence -------------------------------------------------------

    notifyChanged() {
        try { this.node.graph && this.node.graph.setDirtyCanvas && this.node.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
        try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (_) { /* ignore */ }
    }

    getValue() {
        if (!this.base) return this.lastValueString || "{}";
        if (!this.selectionDataUrl && this.selection) {
            this.selectionDataUrl = this.selection.toDataURL("image/png");
        }
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: this.base.ref,
            prompt: this.promptText,
            layers: this.layers.map((l) => ({
                id: l.id, name: l.name, kind: l.kind, role: l.role || "none", blend: l.blend || "normal", ref: l.ref,
                x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity, visible: l.visible, mask: l.maskRef || null,
                ...(l.kind === "filter" ? { filter: l.filter, params: l.params, lut: l.lut || null, plate: l.plate || null } : {}),
            })),
            history: this.history.slice(-100).map((h) => ({ key: h.key, name: h.name, ref: h.ref, x: h.x, y: h.y, w: h.w, h: h.h, prompt: h.prompt, layerId: h.layerId, time: h.time, seed: h.seed, mode: h.mode, denoise: h.denoise })),
            selection: this.selectionDataUrl,
            seen: Array.from(this.seenResults).slice(-200),
            crop: this.cropSettings,
            upsample: this.upsampleSettings,
            gen: this.genSettings,
            negative: this.negativeText,
            settings: this.settings,
            refs: this.refSettings,
            cutout: this.cutoutSettings,
        });
    }

    async setValue(value) {
        let state = null;
        try { state = typeof value === "string" ? JSON.parse(value || "{}") : (value || {}); } catch (_) { state = null; }
        if (!state || !state.base) return;
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        if (raw === this.lastValueString && (this.base || this._loading)) return;
        this.lastValueString = raw;
        const token = (this._loadToken = (this._loadToken || 0) + 1);
        const stale = () => this._loadToken !== token;
        this._loading = true;
        try {
            const img = await loadImageEl(viewUrl(state.base));
            if (stale()) return;
            await this.setBase(state.base, img, { keepLayers: false });
            this.promptText = state.prompt || "";
            if (this.promptInput) this.promptInput.value = this.promptText;
            this.cropSettings = state.crop ? { ...CROP_DEFAULTS, ...state.crop } : { ...CROP_LEGACY };
            this.syncCropControls();
            this.upsampleSettings = { useCase: "auto", backend: "auto", ...(state.upsample || {}) };
            this.refreshSegmentBackends();
            this.genSettings = { ...GEN_DEFAULTS, seed: randomSeed(), ...(state.gen || {}) };
            this.negativeText = state.negative || "";
            if (this.negativeInput) this.negativeInput.value = this.negativeText;
            this.settings = state.settings && typeof state.settings === "object" ? { ...state.settings } : {};
            this.refSettings = { ...REF_DEFAULTS, ...(state.refs || {}) };
            this.cutoutSettings = { backend: "auto", ...(state.cutout || {}) };
            this.syncRefControls();
            this.syncGenControls();
            this.renderSettings();
            for (const l of state.layers || []) {
                if (l.kind === "filter") {
                    try {
                        const canvas = makeCanvas(this.width, this.height);
                        let mask = null;
                        if (l.mask && l.mask.filename) {
                            try { mask = imageToCanvas(await loadImageEl(viewUrl(l.mask)), canvas.width, canvas.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                            if (stale()) return;
                        }
                        let lutData = null;
                        if (l.lut && l.lut.ref) {
                            try { lutData = lutFromImage(await loadImageEl(viewUrl(l.lut.ref)), l.lut.size); } catch (err) { console.warn("Inpaint Canvas: LUT missing", l.lut, err); }
                            if (stale()) return;
                        }
                        let plateImg = null;
                        if (l.plate && l.plate.ref) {
                            try { plateImg = await loadImageEl(viewUrl(l.plate.ref)); } catch (err) { console.warn("Inpaint Canvas: grain plate missing", l.plate, err); }
                            if (stale()) return;
                        }
                        const fid = FILTERS[l.filter] ? l.filter : "grain";
                        this.layers.push({
                            id: l.id, name: l.name, kind: "filter", role: "none", blend: l.blend || "normal", ref: null, canvas,
                            x: 0, y: 0, w: this.width, h: this.height, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false,
                            mask, maskRef: mask ? l.mask : null, maskDirty: false, maskEdit: false,
                            filter: fid, params: { ...filterDefaults(fid), ...(l.params || {}) }, lut: l.lut || null, _lutData: lutData,
                            plate: plateImg ? l.plate : null, _plateImg: plateImg,
                        });
                        this.filterCounter += 1;
                    } catch (err) {
                        console.warn("Inpaint Canvas: filter layer skipped", l, err);
                    }
                    continue;
                }
                if (!l.ref) continue;
                try {
                    const limg = await loadImageEl(viewUrl(l.ref));
                    if (stale()) return;
                    const canvas = imageToCanvas(limg);
                    let mask = null;
                    if (l.mask && l.mask.filename) {
                        try { mask = imageToCanvas(await loadImageEl(viewUrl(l.mask)), canvas.width, canvas.height); } catch (err) { console.warn("Inpaint Canvas: layer mask missing", l.mask, err); }
                        if (stale()) return;
                    }
                    this.layers.push({
                        id: l.id, name: l.name, kind: l.kind || "result", role: l.role || "none", blend: l.blend || "normal",
                        ref: l.ref, canvas,
                        x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false,
                        mask, maskRef: mask ? l.mask : null, maskDirty: false, maskEdit: false,
                    });
                    if (l.kind === "paint") this.paintCounter += 1;
                } catch (err) {
                    console.warn("Inpaint Canvas: layer missing", l.ref, err);
                }
            }
            this.history = (state.history || []).map((h) => ({ ...h }));
            for (const key of state.seen || []) this.seenResults.add(key);
            if (state.selection) {
                const sel = await loadImageEl(state.selection);
                if (stale()) return;
                this.selection.getContext("2d").drawImage(sel, 0, 0);
                this.selectionDirty = true;
            }
            this.renderLayers();
            this.renderHistory();
            this.renderInfo();
            this.draw();
            this.drawThumb();
        } catch (err) {
            console.error(err);
            this.setStatus("Could not restore canvas: " + (err.message || err));
        } finally {
            if (!stale()) this._loading = false;
        }
    }

    /** Called when the prompt is built: upload flattened image, mask and control, return the prompt JSON. */
    async serializeForPrompt() {
        if (!this.base) return "{}";
        const id = this.node.id;
        await this.syncLayers();
        let baseRef = this.uploaded.baseRef;
        if (!this.uploaded.baseHash || !baseRef) {
            let hash;
            if (!this.layers.some((l) => l.visible && !this.isControl(l)) && this.base.ref) {
                baseRef = this.base.ref;
                hash = "orig:" + this.base.ref.filename;
            } else {
                const up = await uploadCanvas(this.flattenToCanvas({ forRun: true }), `n${id}_base`);
                baseRef = up.ref; hash = up.hash;
            }
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = baseRef;
        }
        let maskRef = this.uploaded.maskRef;
        if (!this.uploaded.maskHash || !maskRef) {
            const up = await uploadCanvas(this.maskToCanvas(), `n${id}_mask`);
            maskRef = up.ref;
            this.uploaded.maskHash = up.hash;
            this.uploaded.maskRef = maskRef;
        }
        let controlRef = null;
        if (this.layers.some((l) => l.visible && this.isControl(l))) {
            if (!this.uploaded.controlHash || !this.uploaded.controlRef) {
                const up = await uploadCanvas(this.flattenToCanvas({ controlOnly: true }), `n${id}_control`);
                this.uploaded.controlHash = up.hash;
                this.uploaded.controlRef = up.ref;
            }
            controlRef = this.uploaded.controlRef;
        }
        // Reference layers at their native size: the uploaded file itself when it is
        // untouched, otherwise the pixels with the mask applied (cached per layer).
        const references = [];
        for (const l of this.referenceLayers()) {
            if (!l.mask && l.ref && !l.dirty) { references.push(l.ref); continue; }
            if (!l.exportRef) {
                const up = await uploadCanvas(this.layerPixels(l), `n${id}_ref`);
                l.exportRef = up.ref;
            }
            references.push(l.exportRef);
        }
        const [x, y, w, h] = this.cropRect();
        this.setStatus(`Queued crop ${w} × ${h} at ${x}, ${y}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}. Waiting for the result ...`);
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            control: controlRef,
            prompt: this.promptText,
            layers: this.layers.length,
            crop: this.cropSettings,
            gen: this.genSettings,
            negative: this.negativeText,
            settings: this.settings,
            references,
            refs: this.refSettings,
        });
    }

    destroy() {
        this.close();
        try { this.resizeObserver.disconnect(); } catch (_) { /* ignore */ }
        try { this.thumbObserver.disconnect(); } catch (_) { /* ignore */ }
    }
}

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
