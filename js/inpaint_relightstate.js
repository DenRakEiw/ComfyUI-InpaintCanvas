// Generated from scumble-app/scumble renderer/editor/inpaint_relightstate.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Relight's runtime state of one document (item 77 step 2, docs/PLAN_ENCAPSULATION.md): the map jobs in flight that
// `relightSettled` waits for, the count of shadow marches, and the layers a whole-picture read leaves out. The maps a
// relight layer has made stay on the layer (`layer._relight`, keyed by their inputs); this object only keeps what is
// the document's. Before, the jobs and the count were two bare fields of the editor, and a whole-picture relight hid
// its layers by writing `visible = false` and wrote the old value back after the read: an undo step pushed during the
// read recorded the layers hidden, and an eye clicked during it was undone by the write back.

export class RelightState {
    constructor() {
        /** @type {Set<Promise<unknown>>} the normal and shadow map jobs in flight, over all relight layers */
        this.jobs = new Set();
        /** the relight_shadow marches in flight over all layers, quick and full (`relightMarching`, the K0b harness) */
        this.marches = 0;
        /** @type {Map<string, number>} layer id -> how many reads leave it out of the picture now */
        this.hidden = new Map();
    }

    /**
     * Keep a map job until it settles. The job catches its own errors; a rejection is dropped here all the same.
     * @template T @param {Promise<T>} p @returns {Promise<T>}
     */
    track(p) {
        this.jobs.add(p);
        const off = () => { this.jobs.delete(p); };
        p.then(off, off);
        return p;
    }

    /** The jobs in flight now (a round of `relightIdle` waits for these). @returns {Promise<unknown>[]} */
    pending() {
        return Array.from(this.jobs);
    }

    marchBegan() {
        this.marches++;
    }

    marchEnded() {
        if (this.marches > 0) this.marches--;
    }

    /**
     * Leave layers out of the picture for one read (`shown` answers false for them) without touching their `visible`:
     * an undo step, a save or an eye clicked meanwhile sees and keeps the layers as they are. Answers the release, which
     * may be called more than once; two reads that hide the same layer keep it hidden until both released.
     * @param {Iterable<string>} ids @returns {() => void}
     */
    hide(ids) {
        const held = Array.from(new Set(ids));
        for (const id of held) this.hidden.set(id, (this.hidden.get(id) || 0) + 1);
        let done = false;
        return () => {
            if (done) return;
            done = true;
            for (const id of held) {
                const n = (this.hidden.get(id) || 0) - 1;
                if (n > 0) this.hidden.set(id, n);
                else this.hidden.delete(id);
            }
        };
    }

    /** Whether a read leaves this layer out now: `shown` asks it for every layer of every walk. @param {string} id */
    isHidden(id) {
        return this.hidden.size > 0 && this.hidden.has(id);
    }
}
