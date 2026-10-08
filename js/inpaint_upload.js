// Generated from DenRakEiw/scumble renderer/editor/inpaint_upload.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Uploads (moved out of inpaint_canvas.js as they were): a blob to ComfyUI's /upload/image or, when it is large, to
 * the node's own route, and a canvas or pixels as a PNG named by its hash.
 */
import { api } from "./host.js";
import { isTilePixels } from "./inpaint_tiles.js";
import { encodeCanvas, encodeTilePixels } from "./inpaint_encode.js";

const SUBFOLDER = "inpaint_canvas";

// ComfyUI's /upload/image stops at --max-upload-size (100 MB by default). Files above this
// go through the node's own streaming route, which has no such limit; a 413 from ComfyUI
// falls back to it as well.
const LARGE_UPLOAD = 64 * 1024 * 1024;

async function uploadBlob(blob, filename, { overwrite = true, type = "input", subfolder = SUBFOLDER } = {}) {
    if (blob.size < LARGE_UPLOAD) {
        const form = new FormData();
        form.append("image", new File([blob], filename, { type: "image/png" }));
        form.append("subfolder", subfolder);
        form.append("type", type);
        if (overwrite) form.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (resp.status === 200) {
            const data = await resp.json();
            return { filename: data.name, subfolder: data.subfolder || subfolder, type: data.type || type };
        }
        if (resp.status !== 413) throw new Error("Inpaint Canvas: upload failed (" + resp.status + ")");
    }
    const q = new URLSearchParams({ filename, subfolder, type, overwrite: overwrite ? "true" : "false" });
    const resp = await api.fetchApi("/inpaint_canvas/upload?" + q, { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });
    if (resp.status === 404) throw new Error(`Inpaint Canvas: ${Math.round(blob.size / 1048576)} MB is over ComfyUI's upload limit and the node's own upload route is missing: restart ComfyUI after updating the node (or start it with --max-upload-size 1000).`);
    if (resp.status !== 200) {
        let msg = "";
        try { msg = (await resp.json()).error || ""; } catch (_) { /* ignore */ }
        throw new Error("Inpaint Canvas: upload failed (" + resp.status + (msg ? ", " + msg : "") + ")");
    }
    const data = await resp.json();
    return { filename: data.name, subfolder: data.subfolder || subfolder, type: data.type || type };
}

async function uploadCanvas(canvas, prefix) {
    const { blob, hash } = await encodeCanvas(canvas, { hash: true });
    return { ref: await uploadBlob(blob, `${prefix}_${hash}.png`), hash };
}

/** Upload pixels as a PNG named by its hash: from their tiles when they are on tiles, else from their canvas. */
async function uploadPixels(px, prefix) {
    const r = await encodeTilePixels(px, { hash: true });
    if (r) return { ref: await uploadBlob(r.blob, `${prefix}_${r.hash}.png`), hash: r.hash };
    const c = px.toCanvas();
    try {
        return await uploadCanvas(c, prefix);
    } finally {
        if (isTilePixels(px)) { c.width = 1; c.height = 1; }
    }
}

export { SUBFOLDER, uploadBlob, uploadCanvas, uploadPixels };
