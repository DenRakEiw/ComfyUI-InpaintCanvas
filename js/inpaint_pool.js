// Generated from DenRakEiw/scumble renderer/editor/inpaint_pool.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The worker pool (docs/PLAN_BCE.md §E1): up to eight of the editor's workers (`inpaint_worker.js`, each with its own
 * kernels), a queue with priorities, and the tile arena handed to every one of them.
 *
 * A job is `{ op, ...args }` as the single workers take it. `run` queues one, `map` a list whose answers come back in
 * the list's order. Priorities: INTERACTIVE (what the screen waits for: mip chains) before NORMAL before EXPORT (the
 * bands of a file being written); within one priority first come, first served. A `group` names jobs that belong
 * together (an export), and `cancel(group)` rejects the ones still queued and drops the answers of the ones a worker
 * already runs. A job may answer in pieces (`onProgress`: messages with `progress: true` before the reply).
 *
 * Workers are started when a job finds every running one busy, never ahead of need: a small document in the node's
 * browser tab keeps one. Each new worker gets the arena's chunks before its first job and every change after it
 * (messages to one worker arrive in order, so a job never names a chunk its worker has not got). A worker that fails
 * is dropped and its jobs rejected; when none can be started the pool is off and `run` rejects at once, which the
 * callers answer with their main-thread path.
 */
import { arenaChunks, onArenaChange, arenaEnabled } from "./inpaint_arena.js";

export const INTERACTIVE = 0;
export const NORMAL = 1;
export const EXPORT = 2;
const PRIORITIES = 3;
const JOB_TIMEOUT = 120000;

export const poolSize = () => Math.max(1, Math.min(8, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4) - 2));

export class CancelledError extends Error {
    constructor(group) { super(`pool jobs of ${String(group)} cancelled`); this.name = "CancelledError"; this.cancelled = true; }
}

export class WorkerPool {
    /**
     * `create()` makes one worker (a module worker of inpaint_worker.js). `size`: the most workers at once. `defaults()`
     * gives the fields every job carries (the kernels mode). `onTiming(msg)` sees every reply.
     */
    constructor({ create, size = poolSize(), defaults = null, onTiming = null, timeout = JOB_TIMEOUT } = {}) {
        this.create = create;
        this.size = size;
        this.defaults = defaults;
        this.onTiming = onTiming;
        this.timeout = timeout;
        this.workers = [];             // { w, job } (job: the one it runs, or null)
        this.queues = Array.from({ length: PRIORITIES }, () => []);
        this.seq = 0;
        this.off = false;
        this.stats_ = { run: 0, done: 0, failed: 0, cancelled: 0, started: 0, lost: 0 };
        this._unsubscribe = null;
    }

    get pending() { return this.queues.reduce((n, q) => n + q.length, 0) + this.workers.filter((s) => s.job).length; }

    stats() { return { ...this.stats_, workers: this.workers.length, size: this.size, pending: this.pending, off: this.off, arena: arenaEnabled() }; }

    /** Queue one job; resolves to the worker's reply, rejects with its error (or a CancelledError). */
    run(op, args = {}, transfer = [], { priority = NORMAL, group = null, onProgress = null, timeout = 0 } = {}) {
        if (this.off) return Promise.reject(new Error("no worker pool"));
        return new Promise((resolve, reject) => {
            const job = { id: ++this.seq, op, args, transfer, group, resolve, reject, timer: null, cancelled: false, onProgress, timeout };
            this.queues[Math.max(0, Math.min(PRIORITIES - 1, priority | 0))].push(job);
            this.stats_.run++;
            this._pump();
        });
    }

    /** `jobs`: [{ op, args, transfer }]; their replies in the same order. The first failure rejects the whole map. */
    map(jobs, opts = {}) {
        return Promise.all(jobs.map((j) => this.run(j.op, j.args, j.transfer || [], opts)));
    }

    /** Reject the queued jobs of `group`, and the running ones as soon as their worker answers. */
    cancel(group) {
        if (group === null || group === undefined) return 0;
        let n = 0;
        for (const q of this.queues) {
            for (let i = q.length - 1; i >= 0; i--) {
                if (q[i].group !== group) continue;
                const [job] = q.splice(i, 1);
                this.stats_.cancelled++;
                n++;
                job.reject(new CancelledError(group));
            }
        }
        for (const s of this.workers) {
            if (!s.job || s.job.group !== group || s.job.cancelled) continue;
            s.job.cancelled = true;
            this.stats_.cancelled++;
            n++;
            s.job.reject(new CancelledError(group));
        }
        return n;
    }

    /** Stop every worker (tests; the editor's pool lives as long as the page). Queued and running jobs are rejected. */
    terminate() {
        for (const q of this.queues) for (const job of q.splice(0)) job.reject(new Error("pool terminated"));
        for (const s of this.workers.splice(0)) {
            if (s.job) { clearTimeout(s.job.timer); if (!s.job.cancelled) s.job.reject(new Error("pool terminated")); }
            try { s.w.terminate(); } catch (_) { /* ignore */ }
        }
        if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    }

    _next() {
        for (const q of this.queues) if (q.length) return q.shift();
        return null;
    }

    _hasQueued() { return this.queues.some((q) => q.length); }

    _pump() {
        while (this._hasQueued()) {
            let s = this.workers.find((x) => !x.job);
            if (!s && this.workers.length < this.size) s = this._start();
            if (!s) {
                // nothing runs and nothing can be started: the queue would wait for ever
                if (!this.workers.length) { this.off = true; for (const q of this.queues) for (const job of q.splice(0)) job.reject(new Error("no worker pool")); }
                return;
            }
            this._send(s, this._next());
        }
    }

    _start() {
        let w;
        try { w = this.create(); } catch (_) { return null; }
        if (!w) return null;
        const s = { w, job: null };
        w.onmessage = (e) => this._reply(s, e.data || {});
        w.onerror = (err) => this._lost(s, err);
        if (arenaEnabled()) {
            if (!this._unsubscribe) this._unsubscribe = onArenaChange((c) => this._arenaChanged(c));
            const chunks = arenaChunks();
            if (chunks.length) w.postMessage({ op: "arena", added: chunks });
        }
        this.workers.push(s);
        this.stats_.started++;
        return s;
    }

    _arenaChanged(c) {
        const msg = c.sab ? { op: "arena", added: [[c.added, c.sab]] } : { op: "arena", dropped: [c.dropped] };
        for (const s of this.workers) { try { s.w.postMessage(msg); } catch (_) { /* a worker that is gone */ } }
    }

    _send(s, job) {
        s.job = job;
        job.timer = setTimeout(() => this._lost(s, new Error(`pool job ${job.op} timed out`)), job.timeout || this.timeout);
        try {
            s.w.postMessage({ id: job.id, op: job.op, ...(this.defaults ? this.defaults() : null), ...job.args }, job.transfer);
        } catch (err) {
            clearTimeout(job.timer);
            s.job = null;
            this.stats_.failed++;
            job.reject(err);
        }
    }

    _reply(s, msg) {
        const job = s.job;
        if (!job || msg.id !== job.id) return;
        // a job that answers in pieces (`png_read`: a band at a time): `progress` messages before the reply. A cancelled
        // job's worker is stopped, since nothing else ends a stream it is in the middle of.
        if (msg.progress) {
            if (job.cancelled) { this._lost(s, new Error("cancelled")); return; }
            clearTimeout(job.timer);
            job.timer = setTimeout(() => this._lost(s, new Error(`pool job ${job.op} timed out`)), job.timeout || this.timeout);
            if (job.onProgress) { try { job.onProgress(msg); } catch (err) { job.cancelled = true; job.reject(err); this._lost(s, err); } }
            return;
        }
        clearTimeout(job.timer);
        s.job = null;
        if (this.onTiming) { try { this.onTiming(msg); } catch (_) { /* ignore */ } }
        if (!job.cancelled) {
            if (msg.ok) { this.stats_.done++; job.resolve(msg); } else { this.stats_.failed++; job.reject(new Error(msg.error || "pool job failed")); }
        }
        this._pump();
    }

    /** A worker that failed or never answered: gone, with the job it ran. */
    _lost(s, err) {
        const i = this.workers.indexOf(s);
        if (i < 0) return;
        this.workers.splice(i, 1);
        this.stats_.lost++;
        try { s.w.terminate(); } catch (_) { /* ignore */ }
        const job = s.job;
        s.job = null;
        if (job) {
            clearTimeout(job.timer);
            this.stats_.failed++;
            if (!job.cancelled) job.reject(new Error("pool worker gone: " + ((err && err.message) || err)));
        }
        // a worker that dies at once every time would be started for ever
        if (this.stats_.lost >= this.size * 2 && !this.stats_.done) { this.off = true; this.size = 0; }
        this._pump();
    }
}
