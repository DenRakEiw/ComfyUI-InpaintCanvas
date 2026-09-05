// Inpaint Canvas - layered canvas editor for ComfyUI.
//
// The node itself only shows a thumbnail and a button. The editor opens as a
// full-window overlay so it never fights litegraph for pointer or wheel
// events. Responsibilities of this file:
//   * the editor (layers, selection tools, paint tools, transform, pan/zoom, undo,
//     control layers, outpainting, result history)
//   * persisting the canvas state in the workflow (widget value)
//   * on queue: flatten visible layers + selection mask (+ control layers), upload
//     them, and put a small JSON into the prompt as `canvas_state`
//   * strip the `result` back-link from the prompt (it would be a cycle) and
//     pass its source as `result_source`
//   * receive stitched results from the backend and add them as layers

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "InpaintCanvas";
const STITCH_CLASS = "InpaintCanvasStitch";
const SUBFOLDER = "inpaint_canvas";
const MAX_UNDO = 30;
const HANDLE_PX = 9;
const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light", "difference"];
const ROLES = ["none", "scribble", "lineart", "depth", "pose", "canny", "other"];

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

async function uploadBlob(blob, filename, { overwrite = true, type = "input" } = {}) {
    const form = new FormData();
    form.append("image", new File([blob], filename, { type: "image/png" }));
    form.append("subfolder", SUBFOLDER);
    form.append("type", type);
    if (overwrite) form.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (resp.status !== 200) {
        throw new Error("Inpaint Canvas: upload failed (" + resp.status + ")");
    }
    const data = await resp.json();
    return { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: data.type || type };
}

async function uploadCanvas(canvas, prefix) {
    const blob = await canvasToBlob(canvas);
    const hash = await hashBlob(blob);
    return { ref: await uploadBlob(blob, `${prefix}_${hash}.png`), hash };
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
const CROP_DEFAULTS = { context: "auto", feather: "auto", fill: "none", colorMatch: true };
const CROP_LEGACY = { context: "manual", feather: "manual", fill: "none", colorMatch: false };   // workflows saved before these existed

/** Context padding, grow, feather and blend from the selection size (same formula as nodes.py). */
function autoSelectionParams(selW, selH) {
    const diag = Math.hypot(selW, selH);
    const feather = Math.max(Math.floor(0.10 * diag), 32);
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

function upsampleInstruction(useCase, text, region) {
    // Kept short and with the request repeated at the end: small VLMs (Qwen3-VL 2B)
    // drop the request when it is buried in a long preamble.
    const req = text ? `"${text}"` : "(no request given: infer the most plausible content from the picture)";
    const rules = `Rules: obey the request exactly and translate it to English if needed (Seide = silk, Leder = leather); if the request names a colour or material, the prompt must use exactly that colour and material even though the picture currently shows something else; describe only the final content as a direct description of what is seen; the ${region.includes("green") ? "green area" : "magenta outline"} is only a marker, never mention it, the region or the image; no lists, no preamble, no quotes, no negative prompt. Output only the prompt text.`;
    const tail = `Request again: ${req}`;
    switch (useCase) {
        case "add":
            return `Look at the image. Something new will be painted into ${region} according to this request: ${req}. Write the image-generation prompt for it: one English paragraph of 40 to 80 words, starting with the requested object, then its shape, material and colour, then how it sits in the scene (size relative to the surroundings, contact with surfaces, cast shadows) under the same lighting and perspective as the rest of the picture. ${rules} ${tail}`;
        case "remove":
            return `Look at the image. Whatever is inside ${region} will be erased as if it had never been there${text ? `; request: ${req}` : ""}. Write the image-generation prompt for that spot: one English paragraph of 30 to 60 words describing only what would be visible with the object gone, the background, surfaces, body or textures continuing naturally from the surroundings. The object that is there now must not appear in the prompt and the word remove must not be used. ${rules}`;
        case "edit":
            return `Look at the image. ${region} will be changed according to this request: ${req}. Write an editing instruction for an image editing model: one or two English sentences of at most 50 words, starting with a verb, naming exactly what changes (keep the requested colours and materials) and what must stay the same (identity, pose, lighting, composition). ${rules} ${tail}`;
        case "outpaint":
            return `Look at the image. ${region} lies at the border and the scene will be extended beyond it${text ? `; request: ${req}` : ""}. Write the image-generation prompt for the extension: one English paragraph of 40 to 80 words describing what appears further out, continuing the same environment, perspective, lighting and style without a visible seam. ${rules} ${tail}`;
        default:
            return `Look at the image. ${region} will be repainted according to this request: ${req}. Write the image-generation prompt for that area: one English paragraph of 40 to 80 words, starting with the requested subject, then its materials and colours, then how its lighting, perspective and scale match the surroundings so the result blends in. ${rules} ${tail}`;
    }
}

function availableSegmentBackends() {
    const types = (window.LiteGraph && LiteGraph.registered_node_types) || {};
    return SEGMENT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]) && (!b.available || b.available(b)));
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
    magic: '<path d="M4 20l10-10"/><path d="M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none"/><path d="M19 9l.7 1.3L21 11l-1.3.7L19 13l-.7-1.3L17 11l1.3-.7z" fill="currentColor" stroke="none"/><path d="M14 8l2 2"/>',
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
.ipc-list { overflow:auto; min-height:90px; max-height:34vh; }
.ipc-layer { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-bottom:1px solid #161616; cursor:pointer; }
.ipc-layer:hover { background:#262b33; }
.ipc-layer.ipc-selected { background:#2b3a4f; box-shadow: inset 3px 0 0 #4a90d9; }
.ipc-layer .ipc-row { display:flex; align-items:center; gap:4px; }
.ipc-layer .ipc-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-layer .ipc-kind { font-size:10px; color:#777; text-transform:uppercase; }
.ipc-layer .ipc-kind.ipc-ctrl { color:#ffb347; }
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
        this.layers = [];            // { id, name, kind, role, blend, ref, canvas, x, y, w, h, opacity, visible, dirty }
        this.activeLayerId = null;   // null = base
        this.selection = null;       // canvas WxH, red pixels where selected
        this.history = [];           // { key, ref, x, y, w, h, prompt, layerId, thumb }
        this.view = { scale: 1, x: 0, y: 0 };
        this.tool = "select";
        this.brushSize = 40;
        this.hardness = 1;
        this.brushOpacity = 1;
        this.color = "#ff3b30";
        this.fillEnclosed = true;
        this.promptText = "";
        this.cropSettings = { ...CROP_DEFAULTS };
        this.upsampleSettings = { useCase: "auto", backend: "auto" };
        this.promptBackup = null;
        this.undo = [];
        this.redo = [];
        this.selectionDirty = true;
        this.selectionDataUrl = null;
        this.cachedBounds = null;
        this.uploaded = { baseHash: null, baseRef: null, maskHash: null, maskRef: null, controlHash: null, controlRef: null };
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
        this.hardCtl = slider("Hardness", 0, 100, 100, (v) => v + "%", (v) => { this.hardness = v / 100; });
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
        addTool("select", "Paint selection (B)");
        addTool("rect", "Rectangle selection (R)");
        addTool("lasso", "Lasso selection (L)");
        addTool("object", "Object selection (O): hover to see objects, click to select, click again to deselect. Shift adds, Alt subtracts.");
        addTool("deselect", "Erase from selection (D)");
        this.loopBtn = iconButton("loop", "Close loops: a brush stroke that encloses an area selects the inside too (Photoshop-style)", () => {
            this.fillEnclosed = !this.fillEnclosed;
            this.loopBtn.classList.toggle("ipc-toggle-on", this.fillEnclosed);
            this.setStatus(this.fillEnclosed ? "Close loops on: enclosed areas get selected." : "Close loops off.");
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
        tools.appendChild(el("div", "ipc-sep"));
        tools.appendChild(iconButton("fit", "Fit to view (F)", () => this.fitView()));
        tools.appendChild(iconButton("flatten", "Flatten all visible layers into the base", () => this.flatten()));
        body.appendChild(tools);

        this.viewEl = el("div", "ipc-view");
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d");
        this.viewEl.appendChild(this.canvas);
        this.dropHint = el("div", "ipc-drop", "Load an image, paste it (Ctrl+V) or drop it here.\nThen paint a selection and press Generate.");
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
        layersHead.appendChild(miniButton("plus", "Add a paint layer (Ctrl+Shift+N)", () => this.addPaintLayer()));
        side.appendChild(layersHead);
        this.layerList = el("div", "ipc-list");
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
            d.appendChild(sec);

            // select by text
            const seg = el("div", "ipc-sec");
            const row = el("div", "ipc-seg");
            this.segInput = document.createElement("input");
            this.segInput.type = "text";
            this.segInput.placeholder = "Select by text, e.g. shirt";
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
            this.segQuality = document.createElement("input");
            this.segQuality.type = "checkbox";
            this.segQuality.title = "Use the large SAM model (slower, finer edges)";
            qualLab.appendChild(this.segQuality);
            qualLab.appendChild(el("span", null, "HQ"));
            seg.appendChild(qualLab);
            const srcLab = el("label", null, "Source");
            this.segSourceSel = selectInput(["image", "active layer"], "image", "What the model sees: the flattened image, or only the active layer (the result is clipped to that layer)");
            this.segSourceSel.addEventListener("change", () => { if (this.tool === "object") this.ensureObjects(); });
            srcLab.appendChild(this.segSourceSel);
            seg.appendChild(srcLab);
            this.segBackendSel = selectInput(["auto"], "auto", "Segmentation backend");
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
            const ext = iconButton("extend", "Extend the canvas (outpainting). The new border becomes the selection.", () => this.extendCanvas(), "Extend canvas");
            ext.classList.add("ipc-small");
            sec.appendChild(ext);
            this.canvasInfo = el("span", null, "");
            sec.appendChild(this.canvasInfo);
            d.appendChild(sec);
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
            d.appendChild(wrap);

            // prompt upsampling
            const up = el("div", "ipc-sec ipc-upsample");
            const caseLab = el("label", null, "Use case");
            this.upCaseSel = selectInput(UPSAMPLE_CASES, "auto", "What the rewritten prompt is for. auto = fill, or outpaint when the selection touches the border.");
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
                    context: this.cropContextSel.value === "auto" ? "auto" : "manual",
                    feather: this.cropFeatherSel.value === "auto" ? "auto" : "manual",
                    fill: this.cropFillSel.value,
                    colorMatch: this.cropColorMatch.checked,
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
            for (const c of [this.cropContextSel, this.cropFeatherSel, this.cropFillSel]) c.addEventListener("change", onChange);
            this.cropColorMatch.addEventListener("change", onChange);
            row("Context", this.cropContextSel);
            row("Feather", this.cropFeatherSel);
            row("Fill", this.cropFillSel);
            row("Color match", this.cropColorMatch, "Match the result's colors and brightness to the surroundings when it is stitched back");
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
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f && f.type.startsWith("image/")) this.loadFile(f);
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

    setTool(tool) {
        if (this.pending && tool !== "transform") this.cancelPending();
        this.tool = tool;
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
            case "delete": case "backspace": { const l = this.activeLayer(); if (l) this.removeLayer(l.id); break; }
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
        return !!(layer.role && layer.role !== "none");
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

        if (this.tool === "select" || this.tool === "deselect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "selpaint", last: [ix, iy] };
            this.selectionDab(ix, iy, ix, iy);
        } else if (this.tool === "rect") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "rect", start: [ix, iy], cur: [ix, iy] };
        } else if (this.tool === "lasso") {
            this.pushUndo({ kind: "selection" });
            this.pointer = { kind: "lasso" };
            this.lassoPoints = [[ix, iy]];
        } else if (this.tool === "object") {
            this.pointer = { kind: "object", start: [cx, cy], moved: false, shift: e.shiftKey, alt: e.altKey };
        } else if (this.tool === "paint" || this.tool === "erase") {
            let layer = this.activeLayer();
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
        } else if (p.kind === "layerpaint") {
            this.layerDab(p, p.last[0], p.last[1], ix, iy);
            p.last = [ix, iy];
        } else if (p.kind === "rect") {
            p.cur = [ix, iy];
        } else if (p.kind === "lasso") {
            this.lassoPoints.push([ix, iy]);
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
            sctx.globalCompositeOperation = "source-over";
            sctx.fillStyle = "#ff0000";
            sctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            this.markSelectionChanged();
        } else if (p.kind === "lasso") {
            const pts = this.lassoPoints;
            this.lassoPoints = null;
            if (pts && pts.length > 2) {
                const sctx = this.selection.getContext("2d");
                sctx.globalCompositeOperation = "source-over";
                sctx.fillStyle = "#ff0000";
                sctx.beginPath();
                sctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) sctx.lineTo(pts[i][0], pts[i][1]);
                sctx.closePath();
                sctx.fill();
                this.markSelectionChanged();
            }
        } else if (p.kind === "selpaint") {
            if (this.tool === "select" && this.fillEnclosed) this.fillEnclosedAreas();
            this.markSelectionChanged();
        } else if (p.kind === "object") {
            if (!p.moved) this.toggleObjectAt(...this.toImage(e), p);
        } else if (p.kind === "layerpaint") {
            this.commitStroke(p);
            this.markLayerChanged(p.layer);
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
        sctx.globalCompositeOperation = this.tool === "deselect" ? "destination-out" : "source-over";
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
    fillEnclosedAreas() {
        const W = this.width, H = this.height;
        const sctx = this.selection.getContext("2d");
        const img = sctx.getImageData(0, 0, W, H);
        const d = img.data;
        const reach = new Uint8Array(W * H);
        const stack = [];
        const push = (i) => { if (!reach[i] && d[i * 4 + 3] <= 127) { reach[i] = 1; stack.push(i); } };
        for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
        for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
        while (stack.length) {
            const i = stack.pop();
            const x = i % W, y = (i - x) / W;
            if (x > 0) push(i - 1);
            if (x < W - 1) push(i + 1);
            if (y > 0) push(i - W);
            if (y < H - 1) push(i + W);
        }
        let filled = 0;
        for (let i = 0; i < W * H; i++) {
            if (!reach[i] && d[i * 4 + 3] <= 127) {
                d[i * 4] = 255; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
                filled++;
            }
        }
        if (filled) sctx.putImageData(img, 0, 0);
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
        const color = p.erase ? "#000000" : this.color;
        ctx.globalCompositeOperation = "source-over";
        if (this.hardness >= 0.98) {
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
            g.addColorStop(Math.max(0, Math.min(0.97, this.hardness)), `rgba(${rgb},1)`);
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

    /** Apply the stroke buffer to the layer with the brush opacity. */
    commitStroke(p) {
        const ctx = p.layer.canvas.getContext("2d");
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
        this.pushUndo({ kind: "layer", id: layer.id });
        const shape = makeCanvas(this.width, this.height);
        const sctx = shape.getContext("2d");
        sctx.drawImage(this.selection, 0, 0);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = this.color;
        sctx.fillRect(0, 0, this.width, this.height);
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
        tmp.getContext("2d").drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
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

    async segmentByText() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        const text = (this.segInput.value || "").trim();
        if (!text) { this.setStatus("Type what to select, e.g. \"shirt\"."); this.segInput.focus(); return; }
        const backend = SEGMENT_BACKENDS.find((b) => b.id === this.segBackendSel.value) || availableSegmentBackends()[0];
        if (!backend) { this.setStatus("No segmentation nodes installed (comfyui_segment_anything or comfyui-rmbg)."); return; }
        try {
            this.segBtn.disabled = true;
            this.setStatus(`Segmenting "${text}" with ${backend.label} ...`);
            const { ref, layer } = await this.segmentSource();
            const threshold = Math.min(0.95, Math.max(0.05, +this.segThreshold.value || 0.3));
            const prompt = {
                seg_load: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify(ref) } },
                ...backend.build("seg_load", text, threshold, { quality: this.segQuality.checked }, backend),
                seg_out: { class_type: "InpaintCanvasMaskOut", inputs: { mask: backend.maskOut, canvas_node: String(this.node.id), purpose: "segment" } },
            };
            const res = await api.queuePrompt(-1, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
            this.segmentPromptId = res && res.prompt_id;
            this.segmentPending = { text, mode: this.segMode, layer };
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
            ctx.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
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
        ctx.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
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
        return "fill";
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
                ...backend.build("up_load", upsampleInstruction(useCase, text, region)),
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
            this.setStatus(count ? `Selected "${pending.text}" (${pct}% of the image, ${pending.mode}).` : `Nothing found for "${pending.text}". Lower the threshold or rephrase.`);
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
            // Flatten what is visible now, then stretch its edge pixels into the new border.
            const flat = this.flattenToCanvas({ forRun: true });
            const nb = makeCanvas(nw, nh);
            const ctx = nb.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            if (top) ctx.drawImage(flat, 0, 0, W, 1, left, 0, W, top);
            if (bottom) ctx.drawImage(flat, 0, H - 1, W, 1, left, top + H, W, bottom);
            if (left) ctx.drawImage(flat, 0, 0, 1, H, 0, top, left, H);
            if (right) ctx.drawImage(flat, W - 1, 0, 1, H, left + W, top, right, H);
            if (top && left) ctx.drawImage(flat, 0, 0, 1, 1, 0, 0, left, top);
            if (top && right) ctx.drawImage(flat, W - 1, 0, 1, 1, left + W, 0, right, top);
            if (bottom && left) ctx.drawImage(flat, 0, H - 1, 1, 1, 0, top + H, left, bottom);
            if (bottom && right) ctx.drawImage(flat, W - 1, H - 1, 1, 1, left + W, top + H, right, bottom);
            ctx.drawImage(flat, left, top);
            const { ref } = await uploadCanvas(nb, `n${this.node.id}_base`);
            const img = await loadImageEl(viewUrl(ref));

            // Everything visible was baked into the new base; keep only control layers.
            const kept = this.layers.filter((l) => this.isControl(l));
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
            this.uploaded = { baseHash: null, baseRef: null, maskHash: null, maskRef: null, controlHash: null, controlRef: null };
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
        if (step.kind === "layerfull") return { kind: "layerfull", id: layer.id, url: layer.canvas.toDataURL("image/png"), cw: layer.canvas.width, ch: layer.canvas.height, x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        return null;
    }

    pushUndo(step) {
        if (!this.selection) return;
        const snap = this.snapshot(step);
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
            } else if (snap.kind === "layerfull") {
                const img = await loadImageEl(snap.url);
                layer.canvas = imageToCanvas(img, snap.cw, snap.ch);
                Object.assign(layer, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
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
        this.uploaded.baseHash = null;
        this.uploaded.controlHash = null;
        this.drawThumb();
        this.notifyChanged();
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
        return b ? autoSelectionParams(b[2] - b[0], b[3] - b[1]) : null;
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
            if (target > 0) {
                const s = target / Math.max(cw, ch);
                rows.push(["Emitted", `${Math.max(m, Math.round(cw * s / m) * m)} × ${Math.max(m, Math.round(ch * s / m) * m)}`]);
            } else {
                rows.push(["Emitted", `${Math.min(this.width, Math.ceil(cw / m) * m)} × ${Math.min(this.height, Math.ceil(ch / m) * m)}`]);
            }
            const ctrl = this.layers.filter((l) => this.isControl(l) && l.visible).length;
            rows.push(["Control", ctrl ? `${ctrl} layer${ctrl > 1 ? "s" : ""}` : "none (black)"]);
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
                this.history.push({ key, name: layer.name, ref, x: layer.x, y: layer.y, w: layer.w, h: layer.h, prompt: this.promptText, layerId: layer.id, time: Date.now() });
                this.renderHistory();
                this.setStatus(`Result ${n} added (${r.width} × ${r.height} at ${r.x}, ${r.y})`);
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
            top.appendChild(el("span", "ipc-kind" + (this.isControl(layer) ? " ipc-ctrl" : ""), this.isControl(layer) ? layer.role : layer.kind));
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
            op.addEventListener("input", () => { layer.opacity = op.value / 100; pct.textContent = op.value + "%"; this.uploaded.baseHash = null; this.uploaded.controlHash = null; this.draw(); });
            op.addEventListener("change", () => { this.drawThumb(); this.notifyChanged(); });
            opRow.appendChild(op);
            opRow.appendChild(pct);
            row.appendChild(opRow);

            const modeRow = el("div", "ipc-op");
            const blendLab = el("label", null, "Blend");
            const blend = selectInput(BLEND_MODES, layer.blend || "normal", "Blend mode");
            blend.addEventListener("change", () => { layer.blend = blend.value; this.uploaded.baseHash = null; this.draw(); this.drawThumb(); this.notifyChanged(); });
            blendLab.appendChild(blend);
            modeRow.appendChild(blendLab);
            const roleLab = el("label", null, "Control");
            const role = selectInput(ROLES, layer.role || "none", "Control role: layers with a role go to the control_image output instead of the image");
            role.addEventListener("change", () => {
                layer.role = role.value;
                this.uploaded.baseHash = null;
                this.uploaded.controlHash = null;
                this.renderLayers(); this.renderInfo(); this.draw(); this.drawThumb(); this.notifyChanged();
            });
            roleLab.appendChild(role);
            modeRow.appendChild(roleLab);
            row.appendChild(modeRow);
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
        if (layer && layer.canvas) { paint(layer.canvas); return; }
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

    drawComposite(ctx, { forRun = false, controlOnly = false } = {}) {
        if (!this.base) return;
        if (controlOnly) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, this.width, this.height);
        } else {
            ctx.drawImage(this.base.img, 0, 0);
        }
        for (const layer of this.layers) {
            if (!layer.visible || !layer.canvas) continue;
            const ctrl = this.isControl(layer);
            if (controlOnly && !ctrl) continue;
            if (forRun && ctrl) continue;
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
            if (p.mode === "rotate") {
                const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(p.angle);
                ctx.drawImage(layer.canvas, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
                ctx.restore();
            } else {
                drawMesh(ctx, layer.canvas, (u, v) => this.pendingDst(p, u, v), n, n);
            }
            return;
        }
        ctx.drawImage(this.layerWithStroke(layer), layer.x, layer.y, layer.w, layer.h);
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
            this.layers = this.layers.filter((l) => this.isControl(l));
            this.activeLayerId = null;
            this.base = { ref, img };
            this.uploaded.baseHash = hash;
            this.uploaded.baseRef = ref;
            this.renderLayers();
            this.renderHistory();
            this.draw();
            this.drawThumb();
            this.notifyChanged();
            this.setStatus("Flattened into base layer (control layers kept).");
        } catch (err) {
            console.error(err);
            this.setStatus(String(err.message || err));
        }
    }

    /** Upload every edited layer so its pixels survive a reload. */
    async syncLayers() {
        for (const layer of this.layers) {
            if (!layer.dirty || !layer.canvas) continue;
            const { ref } = await uploadCanvas(layer.canvas, `n${this.node.id}_layer`);
            layer.ref = ref;
            layer.dirty = false;
        }
        this.notifyChanged();
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

        ctx.globalAlpha = 0.4;
        ctx.drawImage(this.selection, 0, 0);
        ctx.globalAlpha = 1;

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
            if ((this.tool === "paint" || this.tool === "erase") && this.hardness < 0.98) {
                ctx.setLineDash([3 / s, 3 / s]);
                ctx.beginPath();
                ctx.arc(this.hover[0], this.hover[1], (this.brushSize / 2) * this.hardness, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // ---- queue -------------------------------------------------------------

    async generate() {
        if (!this.base) { this.setStatus("Load an image first."); return; }
        try {
            this.generateBtn.disabled = true;
            this.setStatus("Queueing ...");
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
                x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity, visible: l.visible,
            })),
            history: this.history.slice(-100).map((h) => ({ key: h.key, name: h.name, ref: h.ref, x: h.x, y: h.y, w: h.w, h: h.h, prompt: h.prompt, layerId: h.layerId, time: h.time })),
            selection: this.selectionDataUrl,
            seen: Array.from(this.seenResults).slice(-200),
            crop: this.cropSettings,
            upsample: this.upsampleSettings,
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
            for (const l of state.layers || []) {
                if (!l.ref) continue;
                try {
                    const limg = await loadImageEl(viewUrl(l.ref));
                    if (stale()) return;
                    this.layers.push({
                        id: l.id, name: l.name, kind: l.kind || "result", role: l.role || "none", blend: l.blend || "normal",
                        ref: l.ref, canvas: imageToCanvas(limg),
                        x: l.x, y: l.y, w: l.w, h: l.h, opacity: l.opacity ?? 1, visible: l.visible !== false, dirty: false,
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
        const [x, y, w, h] = this.cropRect();
        this.setStatus(`Queued crop ${w} × ${h} at ${x}, ${y}. Waiting for the result ...`);
        return JSON.stringify({
            width: this.width,
            height: this.height,
            base: baseRef,
            mask: maskRef,
            control: controlRef,
            prompt: this.promptText,
            layers: this.layers.length,
            crop: this.cropSettings,
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
                for (const node of Object.values(output)) {
                    if (node.class_type !== NODE_CLASS) continue;
                    const link = node.inputs && node.inputs.result;
                    if (Array.isArray(link)) {
                        node.inputs.result_source = `${link[0]}:${link[1]}`;
                        delete node.inputs.result;
                    } else if (node.inputs) {
                        delete node.inputs.result_source;
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
                else node.inpaintEditor.applyMaskFile(info);
            }
        });
    },
});
