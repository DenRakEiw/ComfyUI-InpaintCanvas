// Generated from DenRakEiw/scumble renderer/editor/inpaint_encode.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The PNG encoders (moved out of inpaint_canvas.js as they were): a canvas in the shared worker (`encodeCanvas`),
 * tile pixels, bands and row sources in parts by the pool (`encodeTilePixels`, `encodeBands`, `encodeRows`), with the
 * hash an upload is named by. In a cycle with inpaint_canvas.js for the switch on the class (`InpaintEditor.pngParts`),
 * read inside `partsUsable` only.
 */
import { kernelsMode } from "./px/kernels.js";
import { EXPORT } from "./inpaint_pool.js";
import { NO_PARTS } from "./inpaint_png.js";
import { tileRows, bandRows, writePng } from "./inpaint_bands.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { isTilePixels, TILE_SIZE } from "./inpaint_tiles.js";
import { editorWorker, workerCall, editorPool } from "./inpaint_jobs.js";
import { InpaintEditor } from "./inpaint_canvas.js";

/**
 * PNG of a canvas, plus the upload hash when asked for; encoded in the worker if there is one.
 * `snapshot`: the caller writes into the canvas right after handing it over (an undo step of the
 * pixels before an edit). The worker gets a bitmap taken at the call, but the main-thread fallback
 * after a failed worker job would encode the canvas as it is by then, after the edit, so such a
 * call fails instead: an undo step that says it is lost, not one that restores the edit.
 */
async function encodeCanvas(canvas, { hash = false, snapshot = false } = {}) {
    if (editorWorker()) {
        let failure = "no image in the answer";
        try {
            const bitmap = await createImageBitmap(canvas);
            const r = await workerCall("png", { bitmap, hash }, [bitmap]);
            if (r.blob) return { blob: r.blob, hash: r.hash };
        } catch (err) {
            failure = (err && err.message) || String(err);
        }
        if (snapshot) throw new Error("the pixels could not be encoded in the worker (" + failure + ")");
        console.warn("Inpaint Canvas: encoding in the worker failed, using the main thread:", failure);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { blob, hash: hash ? await hashBlob(blob) : null };
}

function canvasToBlob(canvas, opts) {
    return encodeCanvas(canvas, opts).then((r) => r.blob);
}

async function hashBlob(blob) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- PNGs written in parts by the pool (docs/PLAN_BCE.md §E2, inpaint_png.js) ------------------------------
// A picture is cut into parts of whole rows, each filtered and deflated by a pool worker, and the file is joined
// from them: no canvas of the picture, no bitmap of it, no RGBA buffer of it. `PARTS_OFF` once the workers have no
// Rust kernels (or there are no workers): every caller then keeps its canvas path.

let PARTS_OFF = false;
let partsSeq = 0;

function partsUsable() {
    return !PARTS_OFF && InpaintEditor.pngParts !== false && kernelsMode() === "rust" && typeof Worker === "function" && !editorPool().off;
}

/** The pool as the band writers take it (inpaint_bands.js): jobs of one file share a group, so a failure cancels the rest. */
const partsRun = (group) => (op, args, transfer) => editorPool().run(op, args, transfer, { priority: EXPORT, group });
const partsFlights = () => editorPool().size * 2;
/** Between two bands composited on this thread: a task's pause, so the window answers while a file is written. */
const bandPause = () => new Promise((r) => setTimeout(r, 0));

/** A failure that means "not this way" (no kernels, no pool), against one that is the caller's to see. */
function partsFailed(err) {
    const msg = String((err && err.message) || err);
    if (msg.includes(NO_PARTS) || msg.includes("no worker pool")) { PARTS_OFF = true; return true; }
    return false;
}

async function hashInPool(blob) {
    try { return (await editorPool().run("hash", { blob }, [], { priority: EXPORT })).hash; } catch (_) { return hashBlob(blob); }
}

/**
 * PNG of tile pixels straight from their tiles: `{ blob, hash }`, or null when parts cannot be used (the caller
 * encodes a canvas). The pixels are held as a copy-on-write clone while the workers read them, so a stroke meanwhile
 * writes into tiles of its own and the file is the picture of the moment of the call.
 */
async function encodeTilePixels(px, { hash = false, texts = null } = {}) {
    if (!partsUsable() || !isTilePixels(px)) return null;
    const snap = px.clone();
    const group = "png" + (++partsSeq);
    try {
        const blob = await writePng(tileRows(snap, arenaEnabled()), partsRun(group), { texts, flights: partsFlights() });
        return { blob, hash: hash ? await hashInPool(blob) : null };
    } catch (err) {
        editorPool().cancel(group);
        if (partsFailed(err)) return null;
        throw err;
    } finally {
        snap.release();
    }
}

/**
 * PNG of a picture that arrives in bands: `band(y0, y1)` gives (or resolves to) the RGBA8 of those rows as a typed
 * array of its own. `{ blob, hash }`, or null when parts cannot be used. Bands are asked for one after the other, each
 * only when the workers have room, with a task's pause between them.
 */
async function encodeBands(width, height, band, { hash = false, texts = null, chunks = null, rows = TILE_SIZE, progress = null } = {}) {
    return encodeRows(bandRows(width, height, band, rows), { hash, texts, chunks, progress });
}

/** PNG of any row source (inpaint_bands.js): `{ blob, hash }`, or null when parts cannot be used. */
async function encodeRows(source, { hash = false, texts = null, chunks = null, progress = null } = {}) {
    if (!partsUsable()) return null;
    const group = "png" + (++partsSeq);
    try {
        const blob = await writePng(source, partsRun(group), { texts, chunks, flights: partsFlights(), progress, pause: bandPause });
        return { blob, hash: hash ? await hashInPool(blob) : null };
    } catch (err) {
        editorPool().cancel(group);
        if (partsFailed(err)) return null;
        throw err;
    }
}

/** The next number of a job group for the class: `partsSeq` is this module's to write, an import of it is read-only. */
function nextPartsSeq() { return ++partsSeq; }

export { encodeCanvas, canvasToBlob, partsUsable, partsRun, partsFlights, bandPause, partsFailed, nextPartsSeq, encodeTilePixels, encodeBands, encodeRows };
