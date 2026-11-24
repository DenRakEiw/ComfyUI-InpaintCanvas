// Generated from scumble-app/scumble renderer/editor/inpaint_history.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// The undo history of one document (item 77 step 1, docs/PLAN_ENCAPSULATION.md): the two stacks, their byte budget,
// the depth and the generation counter, with one owner. The editor makes the steps (`snapshot`) and puts them back
// (`applySnapshot`); this object only keeps them. The byte count is touched by `count` / `uncount` / `grow` /
// `shrink` alone, and a step carries whether it is counted (`_counted`): the review of 2026-11-16 found the budget
// counted by three hands and going below zero (undo-bytes-budget-goes-negative-on-unpushed-and-dropped-snapshots).

/**
 * @typedef {{ bytes?: number, _counted?: boolean, label?: string, kind?: string, at?: number | null }} Step
 * @typedef {{ label: string, at: number | null, steps: number, current: boolean, future: boolean }} Row
 */

export class UndoHistory {
    /**
     * @param {{ maxSteps: number, maxBytes: number, release: (step: Step) => void }} opts
     *   `release`: the editor's way to let go of a dropped step (its blob URLs; it calls `uncount`)
     */
    constructor({ maxSteps, maxBytes, release }) {
        /** @type {Step[]} the steps an undo takes back, oldest first */
        this.undo = [];
        /** @type {Step[]} the steps a redo brings back, the next one last */
        this.redo = [];
        /** the bytes the counted steps hold */
        this.bytes = 0;
        /** older steps were dropped since the last clear: the list's first row is not the start */
        this.trimmed = false;
        /** bumped by every change an undo that is still loading its step must not run over */
        this.gen = 0;
        this.maxSteps = maxSteps;
        this.maxBytes = maxBytes;
        this.release = release;
    }

    /** @param {Step} step */
    count(step) {
        if (step && !step._counted) { this.bytes += step.bytes || 0; step._counted = true; }
    }

    /** @param {Step} step */
    uncount(step) {
        if (step && step._counted) { this.bytes -= step.bytes || 0; step._counted = false; }
    }

    /** A step holds `n` more bytes (a plugin's data riding on it): counted when the step is. @param {Step} step @param {number} n */
    grow(step, n) {
        if (!step || !n) return;
        step.bytes = (step.bytes || 0) + n;
        if (step._counted) this.bytes += n;
    }

    /** A step holds `n` bytes fewer (a liquify session's cells let go). @param {Step} step @param {number} n */
    shrink(step, n) {
        if (!step || !n) return;
        step.bytes = (step.bytes || 0) - n;
        if (step._counted) this.bytes -= n;
    }

    /**
     * A new step on the undo stack: the redo steps go first (the budget counts them, and trimming against it while
     * they were still counted threw away older steps that fit once they were gone), then the oldest steps past the depth.
     * @param {Step} step
     */
    push(step) {
        this.dropRedo();
        this.undo.push(step);
        this.count(step);
        this.trim();
    }

    /** Every redo step let go. */
    dropRedo() {
        for (const s of this.redo) this.release(s);
        this.redo = [];
    }

    /** Drop the oldest steps past the depth (steps, or bytes while more than one step is left). */
    trim() {
        const steps = Math.max(1, this.maxSteps), bytes = this.maxBytes;
        while (this.undo.length > steps || (this.bytes > bytes && this.undo.length > 1)) {
            const s = this.undo.shift();
            if (s) this.release(s);
            this.trimmed = true;
        }
    }

    /** A new depth, applied at once. @param {{ steps?: number | null, bytes?: number | null }} depth @param {{ steps: number, bytes: number }} fallback */
    setDepth({ steps, bytes } = {}, fallback) {
        if (steps != null) this.maxSteps = Math.max(1, Math.round(+steps) || fallback.steps);
        if (bytes != null) this.maxBytes = Math.max(1048576, Math.round(+bytes) || fallback.bytes);
        this.trim();
    }

    /** Both stacks let go and the count back at zero; the generation moves (a waiting undo must not run). */
    clear() {
        this.gen++;
        for (const s of this.undo) this.release(s);
        for (const s of this.redo) this.release(s);
        this.undo = [];
        this.redo = [];
        this.bytes = 0;
        this.trimmed = false;
    }

    /**
     * A step taken out of the undo stack wherever it sits (a range selection's own step, a grow or feather dropped as
     * stale): still counted, so the caller's `release` takes its bytes off. @param {Step} step @returns {Step | null}
     */
    take(step) {
        if (!step) return null;
        const i = this.undo.lastIndexOf(step);
        return i < 0 ? null : this.undo.splice(i, 1)[0];
    }

    /** The top step moved under the `count` steps pushed after it (the assistant's own step under a call's). @param {number} count */
    moveUnder(count) {
        if (!(count > 0) || this.undo.length < count + 1) return;
        const s = this.undo.pop();
        if (s) this.undo.splice(this.undo.length - count, 0, s);
    }

    /** The top step of the undo stack (`redo` false) or the redo stack taken off; still counted. @param {boolean} redo @returns {Step | undefined} */
    popTop(redo) {
        return (redo ? this.redo : this.undo).pop();
    }

    /** The present as the other stack's step during an undo (`toUndo` false) or a redo. @param {Step} step @param {boolean} toUndo */
    pushOther(step, toUndo) {
        (toUndo ? this.undo : this.redo).push(step);
        this.count(step);
    }

    /**
     * Replace both stacks (tests only; the app goes through push / take / clear): the count follows what they hold.
     * @param {Step[] | null} undo @param {Step[] | null} redo
     */
    replace(undo, redo) {
        if (undo) this.undo = undo;
        if (redo) this.redo = redo;
        this.bytes = 0;
        for (const s of [...this.undo, ...this.redo]) if (s && s._counted) this.bytes += s.bytes || 0;
    }

    /**
     * The history as rows, oldest first: the oldest state kept, one row per undo step (the last is the present), then
     * the redo steps. `steps` is what an undo (negative) or redo (positive) takes to get there.
     * @param {Record<string, string>} labels the kinds' labels
     * @returns {Row[]}
     */
    rows(labels) {
        const name = (/** @type {Step} */ s) => s.label || (s.kind && labels[s.kind]) || s.kind || "";
        const rows = [{ label: this.trimmed ? "Oldest kept" : "Start", at: null, steps: -this.undo.length }];
        this.undo.forEach((s, i) => rows.push({ label: name(s), at: s.at || null, steps: i + 1 - this.undo.length }));
        for (let j = this.redo.length - 1; j >= 0; j--) {
            const s = this.redo[j];
            rows.push({ label: name(s), at: s.at || null, steps: this.redo.length - j });
        }
        return rows.map((r) => ({ ...r, current: r.steps === 0, future: r.steps > 0 }));
    }
}
