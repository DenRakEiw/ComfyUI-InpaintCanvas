// Generated from DenRakEiw/scumble renderer/editor/inpaint_progress.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// A run's progress for the status row's bar (docs/PLAN_0_1_48.md S3; node issue DenRakEiw/ComfyUI-InpaintCanvas#1,
// ask 1): ComfyUI's events for the prompts this document queued (the node k of n, a sampler's step v of m) and the
// seconds of a run the app waits for (an API run, a pass on the whole picture). No DOM and no imports: the editor
// draws the state it is handed, so the node's build and a plain-Node test use the same code.
//
// One state at a time: a local prompt that runs (the latest execution_start), else one that waits ("Queued"), else
// the timed run. A timed run whose own prompt runs (a pass on ComfyUI: `promptId`) shows that prompt's steps under its
// label; a local Generate beside an API run of the same tab shows as "Generating", the API run's seconds after it. Every change calls onChange(state) with null (nothing to show) or
//   { fraction: 0..1 | null (busy, no measure), label, queued: n prompts waiting besides the one shown }.

export class RunProgress {
    // the timers are called as plain functions (a browser's setInterval called on another object throws "Illegal invocation")
    constructor(onChange, { now = () => Date.now(), setInterval: si = (fn, ms) => setInterval(fn, ms), clearInterval: ci = (h) => clearInterval(h) } = {}) {
        this.onChange = onChange;
        this.now = now;
        this._si = si;
        this._ci = ci;
        this.runs = new Map();      // prompt id -> { nodes, cached, seen: Set of top-level node ids, steps: Map node -> {value, max}, stepped: [], started, node, tracked }
        this.dropped = new Map();   // what idle() let go: { at, run } per prompt id, taken back by a later event of it
        this.active = null;         // the prompt id that started last
        this.timed = null;          // { label, started, promptId } of a run the app waits for (promptId: its own prompt on ComfyUI)
        this.ticker = null;
    }

    /** A prompt this document queued, with the number of nodes in its graph. Events for it may already have come. */
    track(promptId, nodes) {
        if (!promptId) return;
        const id = String(promptId);
        if (!this.runs.has(id)) this.runs.set(id, { nodes: Math.max(1, nodes | 0), cached: 0, seen: new Set(), steps: new Map(), stepped: [], started: 0, node: null, tracked: this.now() });
        this.dropped.delete(id);
        this.changed();
    }

    /** Whether this document waits for the prompt. */
    has(promptId) {
        return !!promptId && this.runs.has(String(promptId));
    }

    /** Whether the prompt's events belong here: it is waited for, or idle() let it go less than a minute ago. */
    wants(promptId) {
        if (!promptId) return false;
        const id = String(promptId);
        if (this.runs.has(id)) return true;
        const was = this.dropped.get(id);
        return !!was && this.now() - was.at < 60000;
    }

    /** One of ComfyUI's events; false when it is not about a prompt this document tracks. */
    event(type, d) {
        const id = d && d.prompt_id != null ? String(d.prompt_id) : null;
        let run = id ? this.runs.get(id) : null;
        // a status "queue empty" can come just after a prompt was queued (it was about the job before): the prompt's
        // own events, within a minute, take it back
        if (!run && id && this.dropped.has(id) && !/^execution_(success|error|interrupted)$/.test(type) && !(type === "executing" && d.node == null)) {
            const was = this.dropped.get(id);
            this.dropped.delete(id);
            if (this.now() - was.at < 60000) { run = was.run; this.runs.set(id, run); }
        }
        if (!run) return false;
        if (type === "execution_start") {
            run.started = this.now();
            this.active = id;
        } else if (type === "execution_cached") {
            run.cached += Array.isArray(d.nodes) ? d.nodes.length : 0;
        } else if (type === "executing") {
            if (d.node == null) return this.done(id);
            if (!run.started) { run.started = this.now(); this.active = id; }
            // a node from a group or a subgraph ("12.3") counts as the node of the graph it sits in
            const top = String(d.display_node != null ? d.display_node : d.node).split(".")[0];
            run.seen.add(top);
            run.node = top;
        } else if (type === "progress") {
            if (!run.started) { run.started = this.now(); this.active = id; }
            const key = String(d.node != null ? d.node : run.node);
            const max = Math.max(1, +d.max || 1), value = Math.max(0, Math.min(max, +d.value || 0));
            const prev = run.steps.get(key);
            // events of one socket come in order: a lower value on the same node is its next sampler call (a tile, a
            // face, an item of a list), a pass of its own
            run.steps.set(key, { value, max });
            if (run.stepped[run.stepped.length - 1] !== key || (prev && value < prev.value)) run.stepped.push(key);
            run.node = key.split(".")[0];
            run.stepNode = key;
        } else if (type === "execution_success" || type === "execution_error" || type === "execution_interrupted") {
            return this.done(id);
        } else {
            return false;
        }
        this.changed();
        return true;
    }

    /** A dropped prompt the server's queue still holds (a lost socket, a stale "queue empty"): it shows again. */
    revive(promptId) {
        const id = String(promptId);
        const was = this.dropped.get(id);
        if (!was) return false;
        this.dropped.delete(id);
        if (!this.runs.has(id)) this.runs.set(id, was.run);
        this.changed();
        return true;
    }

    /** The prompt ended (or left the queue): it shows no more. */
    done(promptId) {
        const id = String(promptId);
        if (!this.runs.delete(id)) return false;
        if (this.active === id) this.active = null;
        this.changed();
        return true;
    }

    /** The queue is empty: no prompt of this document waits any more. */
    idle() {
        if (!this.runs.size) return;
        const at = this.now();
        for (const [id, run] of this.runs) this.dropped.set(id, { at, run });
        for (const [id, v] of this.dropped) if (at - v.at > 60000) this.dropped.delete(id);
        this.runs.clear();
        this.active = null;
        this.changed();
    }

    /** A run the app waits for ({ label, started } in ms, `promptId` its own prompt on ComfyUI) or null when none is going. */
    timer(t) {
        const next = t && t.started ? { label: String(t.label || "Run"), started: +t.started, promptId: t.promptId != null ? String(t.promptId) : null } : null;
        if (!next && !this.timed) return;
        if (next && this.timed && next.label === this.timed.label && next.started === this.timed.started && next.promptId === this.timed.promptId) return;
        this.timed = next;
        this.changed();
    }

    /** Everything ends: the server went away, the document closes. */
    clear() {
        this.runs.clear();
        this.dropped.clear();
        this.active = null;
        this.timed = null;
        this.changed();
    }

    /** The state the bar shows, or null. */
    state() {
        const secs = (t0) => Math.max(0, Math.floor((this.now() - t0) / 1000));
        let id = this.active && this.runs.has(this.active) ? this.active : null;
        if (!id) for (const [k, r] of this.runs) if (r.started) { id = k; break; }
        if (!id && this.runs.size) id = this.runs.keys().next().value;
        const run = id ? this.runs.get(id) : null;
        const queued = Math.max(0, this.runs.size - (run ? 1 : 0));
        const more = queued ? ` · ${queued} more queued` : "";
        if (run && run.started) {
            const total = Math.max(run.seen.size, run.nodes - run.cached);
            const parts = [];
            let fraction = null;
            const step = run.stepNode ? run.steps.get(run.stepNode) : null;
            if (step && run.node === run.stepNode.split(".")[0]) {
                fraction = step.value / step.max;
                parts.push(`step ${step.value}/${step.max}${run.stepped.length > 1 ? ` (pass ${run.stepped.length})` : ""}`);
            }
            if (run.seen.size) parts.push(`node ${Math.min(run.seen.size, total)}/${total}`);
            // the timed run's label only over its own prompt; another timed run (an API run beside a local Generate) after it
            const own = !!this.timed && this.timed.promptId === id;
            const label = own ? this.timed.label : "Generating";
            const t0 = own ? this.timed.started : run.started;
            const beside = this.timed && !own ? ` · ${this.timed.label} · ${secs(this.timed.started)} s` : "";
            return { fraction, label: `${label} · ${parts.length ? parts.join(" · ") + " · " : ""}${secs(t0)} s${more}${beside}`, queued };
        }
        if (this.timed) return { fraction: null, label: `${this.timed.label} · ${secs(this.timed.started)} s${more}`, queued };
        if (run) return { fraction: null, label: `Queued${queued ? ` (${queued + 1} prompts)` : ""}`, queued };
        return null;
    }

    changed() {
        // the seconds tick while something runs or is timed
        const ticking = !!this.timed || Array.from(this.runs.values()).some((r) => r.started);
        if (ticking && !this.ticker) this.ticker = this._si(() => this.render(), 1000);
        else if (!ticking && this.ticker) { this._ci(this.ticker); this.ticker = null; }
        this.render();
    }

    render() {
        if (this.onChange) { try { this.onChange(this.state()); } catch (err) { console.warn("run progress", err); } }
    }
}
