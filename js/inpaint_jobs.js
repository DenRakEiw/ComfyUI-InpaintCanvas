// Generated from DenRakEiw/scumble renderer/editor/inpaint_jobs.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The editor's side of its workers (moved out of inpaint_canvas.js as they were): the shared worker and its jobs
 * (`editorWorker`, `workerCall`), the mips worker, the pool (`editorPool`, inpaint_pool.js), the tile store's chain
 * transport and the layered export in the worker (`buildLayered`). Next to `inpaint_worker.js`, whose URL it resolves.
 * In a cycle with inpaint_canvas.js for the switches on the class (`InpaintEditor.mipsOnPool`, `mipsOnSharedWorker`):
 * they are read inside functions only, never while this module is evaluated.
 */
import { kernelsMode } from "./px/kernels.js";
import { buildPsd, buildOra } from "./inpaint_export.js";
import { WorkerPool, poolSize, INTERACTIVE, NORMAL } from "./inpaint_pool.js";
import { setChainTransport, setResampleTransport, setLiquifyTransport } from "./inpaint_tiles.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { InpaintEditor } from "./inpaint_canvas.js";

const WORKER_TIMEOUT = 180000;              // a worker job that never answers falls back to the main thread

// ---- the worker: PNG encoding, upload hashes and the layered export writers ----------
// canvas.toBlob keeps the main thread busy for 755 ms on a 96 MP canvas (measured), and
// the PSD writer for 3 s. Both move into js/inpaint_worker.js; the editor only pays for
// createImageBitmap (25 ms) and the transfer. Without a worker (old browser, blocked
// module worker) everything falls back to the main thread, so nothing depends on it.

let WORKER = null;
let WORKER_OFF = false;
let workerSeq = 0;
const workerJobs = new Map();

// The pixel kernels are Rust (px/kernels.js) in the window and in both workers; `InpaintEditor.kernels = "js"` forces the
// JS twins everywhere, for the benchmark (tools/px_jobs.py). The worker jobs with a kernel reply with the milliseconds of
// their parts, kept here (`InpaintEditor.jobTimings(true)` reads and clears them).
const JOB_TIMINGS = [];
function keepTiming(msg) {
    if (!msg.timing) return;
    JOB_TIMINGS.push(msg.timing);
    if (JOB_TIMINGS.length > 5000) JOB_TIMINGS.splice(0, JOB_TIMINGS.length - 5000);
}

function editorWorker() {
    if (WORKER_OFF) return null;
    if (WORKER) return WORKER;
    try {
        WORKER = new Worker(new URL("./inpaint_worker.js", import.meta.url), { type: "module" });
        WORKER.onmessage = (e) => {
            const msg = e.data || {};
            keepTiming(msg);
            const job = workerJobs.get(msg.id);
            if (!job) return;
            workerJobs.delete(msg.id);
            if (msg.ok) job.resolve(msg); else job.reject(new Error(msg.error || "worker job failed"));
        };
        WORKER.onerror = (err) => {
            console.warn("Inpaint Canvas: worker unavailable, doing this on the main thread:", (err && err.message) || err);
            WORKER_OFF = true;
            WORKER = null;
            for (const job of workerJobs.values()) job.reject(new Error("worker gone"));
            workerJobs.clear();
        };
    } catch (err) {
        console.warn("Inpaint Canvas: no worker:", (err && err.message) || err);
        WORKER_OFF = true;
        WORKER = null;
    }
    return WORKER;
}

function workerCall(op, args = {}, transfer = []) {
    const w = editorWorker();
    if (!w) return Promise.reject(new Error("no worker"));
    const id = ++workerSeq;
    return new Promise((resolve, reject) => {
        // a worker that never answers must not hang an upload or an export for good: the
        // job is dropped and the caller falls back to the main thread
        const timer = setTimeout(() => {
            if (!workerJobs.delete(id)) return;
            reject(new Error(`worker job ${op} timed out`));
        }, WORKER_TIMEOUT);
        workerJobs.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
            w.postMessage({ id, op, kernels: kernelsMode(), ...args }, transfer);
        } catch (err) {
            clearTimeout(timer);
            workerJobs.delete(id);
            reject(err);
        }
    });
}

// The mips worker (docs/PLAN_BCE.md §C6 b): the same module in a worker of its own, which builds the mip chains a
// whole change of a layer or a mask asks for (2,360 at 15000 x 10000, about 300 ms). Its own, because the shared
// worker runs a magic wand's flood for seconds, and the screen would show a coarse picture for all of them. Without
// it (no module worker, or one that failed) the tile store builds every chain where it is read, as before.
let MIPS_WORKER = null;
let MIPS_OFF = false;
const mipsJobs = new Map();

function mipsWorker() {
    if (MIPS_OFF) return null;
    if (MIPS_WORKER) return MIPS_WORKER;
    try {
        MIPS_WORKER = new Worker(new URL("./inpaint_worker.js", import.meta.url), { type: "module" });
        MIPS_WORKER.onmessage = (e) => {
            const msg = e.data || {};
            keepTiming(msg);
            const job = mipsJobs.get(msg.id);
            if (!job) return;
            mipsJobs.delete(msg.id);
            if (msg.ok) job.resolve(msg); else job.reject(new Error(msg.error || "mips job failed"));
        };
        MIPS_WORKER.onerror = (err) => {
            MIPS_OFF = true;
            MIPS_WORKER = null;
            for (const job of mipsJobs.values()) job.reject(new Error("mips worker gone: " + ((err && err.message) || err)));
            mipsJobs.clear();
        };
    } catch (err) {
        MIPS_OFF = true;
        MIPS_WORKER = null;
    }
    return MIPS_WORKER;
}

// The worker pool (docs/PLAN_BCE.md §E1, inpaint_pool.js): the same module in up to eight workers, started as jobs need
// them. The mip chains go through it; `InpaintEditor.mipsOnPool = false` sends them to the one mips worker as before E1.
let POOL = null;

function editorPool() {
    if (!POOL) POOL = new WorkerPool({
        create: () => new Worker(new URL("./inpaint_worker.js", import.meta.url), { type: "module" }),
        defaults: () => ({ kernels: kernelsMode() }),
        onTiming: keepTiming,
        timeout: WORKER_TIMEOUT,
    });
    return POOL;
}

/**
 * The tile store's chain transport: a batch of tiles to a worker, their chains back. A tile in the arena is named by
 * its slot and read where it lies; any other is a copy, transferred both ways.
 */
function mipsTransport(tiles) {
    const transfer = tiles.filter((t) => t.data).map((t) => t.data);
    if (mipsOnPool()) return editorPool().run("mips", { tiles }, transfer, { priority: INTERACTIVE });
    const w = InpaintEditor.mipsOnSharedWorker ? editorWorker() : mipsWorker();
    if (!w) return Promise.reject(new Error("no mips worker"));
    const id = ++workerSeq;
    const jobs = InpaintEditor.mipsOnSharedWorker ? workerJobs : mipsJobs;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (jobs.delete(id)) reject(new Error("mips job timed out")); }, WORKER_TIMEOUT);
        jobs.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        try {
            w.postMessage({ id, op: "mips", kernels: kernelsMode(), tiles }, transfer);
        } catch (err) {
            clearTimeout(timer);
            jobs.delete(id);
            reject(err);
        }
    });
}

const mipsOnPool = () => InpaintEditor.mipsOnPool !== false && !InpaintEditor.mipsOnSharedWorker && !editorPool().off;
mipsTransport.flights = poolSize();
// tiles by slot only while the pool takes them: its workers are the ones that hold the arena's chunks
Object.defineProperty(mipsTransport, "arena", { get: mipsOnPool });
if (typeof Worker === "function") setChainTransport(mipsTransport);

/**
 * The tile store's resample transport (`transformedAsync`, PLAN_0_1_31 §7): one row of destination tiles per pool job,
 * the source tiles named by their arena slots. Usable only where the pool's workers hold the arena.
 */
function resampleTransport(args) {
    return editorPool().run("resample", args, [], { priority: NORMAL });
}
Object.defineProperty(resampleTransport, "usable", { get: () => arenaEnabled() && !editorPool().off });
if (typeof Worker === "function") setResampleTransport(resampleTransport);

/**
 * Liquify's bake transport (`liquifiedAsync`, PLAN_0_1_31 §5 step 5): one row of output tiles per pool job, INTERACTIVE
 * (the gesture waits for it, as a heal's blend does).
 */
function liquifyTransport(args) {
    return editorPool().run("liquify", args, [], { priority: INTERACTIVE });
}
Object.defineProperty(liquifyTransport, "usable", { get: () => arenaEnabled() && !editorPool().off });
if (typeof Worker === "function") setLiquifyTransport(liquifyTransport);

/**
 * A layered PSD or ORA file. The worker takes the layers one at a time, so only one
 * layer's pixels are in flight; without a worker the writers run on the main thread.
 * A layer's `mask` (`{ canvas, disabled }`, inpaint_export.js) goes to a PSD as a second
 * bitmap; ORA has no layer masks and never gets one.
 */
async function buildLayered(format, { width, height, layers, composite }) {
    if (editorWorker()) {
        const job = "x" + (++workerSeq);
        try {
            await workerCall("export_begin", { job, format, width, height });
            for (const L of layers) {
                if (L.section) { await workerCall("export_layer", { job, meta: { ...L } }); continue; }   // a group's record (PSD)
                const bitmap = await createImageBitmap(L.canvas);
                const meta = { name: L.name, x: L.x, y: L.y, opacity: L.opacity, visible: L.visible, blend: L.blend, ...(L.clip ? { clip: true } : {}) };
                let maskBitmap = null;
                if (format === "psd" && L.mask) {
                    try { maskBitmap = await createImageBitmap(L.mask.canvas); } catch (err) { bitmap.close(); throw err; }
                    meta.mask = { disabled: !!L.mask.disabled };
                }
                await workerCall("export_layer", { job, meta, bitmap, maskBitmap }, maskBitmap ? [bitmap, maskBitmap] : [bitmap]);
            }
            const bitmap = await createImageBitmap(composite);
            const r = await workerCall("export_finish", { job, bitmap }, [bitmap]);
            if (r.blob) return r.blob;
        } catch (err) {
            console.warn("Inpaint Canvas: export in the worker failed, using the main thread:", (err && err.message) || err);
            workerCall("export_cancel", { job }).catch(() => {});
        }
    }
    return format === "psd" ? buildPsd({ width, height, layers, composite }) : buildOra({ width, height, layers, composite });
}

export { JOB_TIMINGS, editorWorker, workerCall, editorPool, buildLayered };
