/**
 * The editor's worker: everything that used to stall the main thread with a whole image
 * in hand. It runs in the ComfyUI page and in the app alike (a module worker created from
 * `import.meta.url`, so both hosts serve it from next to the editor).
 *
 * Jobs:
 *   png             one canvas -> a PNG blob, optionally with the upload hash. The main
 *                   thread only pays for createImageBitmap (25 ms on a 96 MP canvas)
 *                   instead of the 755 ms that canvas.toBlob blocks it for.
 *   export_begin / export_layer / export_finish
 *                   a layered PSD or ORA file, one layer at a time: the layer is packed
 *                   as soon as its pixels arrive, so only one layer is ever in flight and
 *                   the 3 s PackBits run happens off the main thread.
 *   selection       grow, shrink, feather or invert the selection (up to 3.9 s on the
 *                   main thread at 96 MP).
 *   flood           the magic wand's and the bucket's region: the similar pixels around a
 *                   point, clipped to the selection, as a coloured shape.
 *
 * Pixels arrive as ImageBitmaps (transferred, never copied through structured cloning) and
 * are closed as soon as they are drawn. Every reply carries the request's id; a failure
 * comes back as { ok: false, error } and the editor falls back to the main thread.
 */
import { PsdWriter, OraWriter } from "./inpaint_export.js";
import { floodMask, maskToColorCanvas, clipMaskToSelection, growMask, invertMask, maskBounds } from "./inpaint_raster.js";

const exports_ = new Map();   // job id -> { writer, format }

/** An ImageBitmap as a 2D canvas; the bitmap is released right away. */
function canvasOf(bitmap) {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return c;
}

/** Same short SHA-1 the editor uses to name uploaded files. */
async function hashOf(blob) {
    const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function png(bitmap, wantHash) {
    const blob = await canvasOf(bitmap).convertToBlob({ type: "image/png" });
    return { blob, hash: wantHash ? await hashOf(blob) : null };
}

/** grow / shrink / feather / invert, on the selection's pixels. */
async function selection(msg) {
    const c = canvasOf(msg.bitmap);
    const W = c.width, H = c.height;
    let out = c;
    if (msg.kind === "feather") {
        out = new OffscreenCanvas(W, H);
        const octx = out.getContext("2d");
        octx.filter = `blur(${msg.radius}px)`;
        octx.drawImage(c, 0, 0);
        octx.filter = "none";
    } else if (msg.kind !== "invert" && msg.kind !== "grow") {
        throw new Error("unknown selection job " + msg.kind);
    }
    const ctx = out.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    if (msg.kind === "invert") { invertMask(img.data); ctx.putImageData(img, 0, 0); }
    else if (msg.kind === "grow") { growMask(img.data, W, H, msg.n); ctx.putImageData(img, 0, 0); }
    // the editor would otherwise scan the whole selection for this afterwards, on its own thread
    return { bitmap: out.transferToImageBitmap(), bounds: maskBounds(img.data, W, H) };
}

/** The magic wand's and the bucket's region, as a shape in the requested colour. */
async function flood(msg) {
    const src = canvasOf(msg.bitmap);
    const W = src.width, H = src.height;
    const data = src.getContext("2d").getImageData(0, 0, W, H).data;
    const mask = floodMask(data, W, H, msg.x, msg.y, msg.tolerance, msg.contiguous);
    if (msg.selBitmap) clipMaskToSelection(mask, canvasOf(msg.selBitmap));
    let count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            if (!mask[row + x]) continue;
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    const shape = maskToColorCanvas(mask, W, H, msg.color || "#ff0000");
    return { bitmap: shape.transferToImageBitmap(), count, bounds: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1] };
}

async function run(msg) {
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "export_begin") {
        const opts = { width: msg.width, height: msg.height };
        exports_.set(msg.job, { format: msg.format, writer: msg.format === "psd" ? new PsdWriter(opts) : new OraWriter(opts) });
        return {};
    }
    if (msg.op === "export_layer") {
        const job = exports_.get(msg.job);
        if (!job) throw new Error("unknown export job");
        await job.writer.layer(msg.meta, canvasOf(msg.bitmap));
        return {};
    }
    if (msg.op === "export_finish") {
        const job = exports_.get(msg.job);
        if (!job) throw new Error("unknown export job");
        exports_.delete(msg.job);
        return { blob: await job.writer.finish(canvasOf(msg.bitmap)) };
    }
    if (msg.op === "export_cancel") {
        exports_.delete(msg.job);
        return {};
    }
    throw new Error("unknown job " + msg.op);
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    try {
        const result = await run(msg);
        // an ImageBitmap in the reply is transferred, never copied
        self.postMessage({ id: msg.id, ok: true, ...result }, result && result.bitmap ? [result.bitmap] : []);
    } catch (err) {
        // a bitmap that was transferred but never drawn would leak until the worker dies
        for (const k of ["bitmap", "selBitmap"]) { try { if (msg[k] && msg[k].close) msg[k].close(); } catch (_) { /* ignore */ } }
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
};
