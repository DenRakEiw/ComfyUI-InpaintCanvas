// Generated from scumble-app/scumble renderer/editor/inpaint_selection.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// The selection of one document (item 77 step 2, docs/PLAN_ENCAPSULATION.md): the mask, its bounding-box cache, the
// change counter, the PNG kept for a save and the select-range run in flight, with one owner. The editor still draws
// into the mask (`sel.drawInto`, `sel.fill` ...) and refreshes the screen; what this object keeps is the state that
// has to follow every such change and went stale when one hand forgot it: the review of 2026-11-16 found
// `select-range-untracked-undo-and-cancel-crash` and `range-add-nothing-matched-bounds-whole-picture` in it.

/**
 * @typedef {[number, number, number, number]} Box  [x0, y0, x1, y1] in image pixels
 * @typedef {{ release?: () => void }} Mask  the editor's MaskPixels (canvas or tiles)
 * @typedef {{ group: string, seq: number, snap: object, limit: object, mode: string }} RangeRun
 */

export class SelectionState {
    /**
     * @param {{ scan: (within: Box | null) => Box | null }} opts
     *   `scan`: the editor's bounds scan, the exact box inside `within` (a known superset) or of the whole mask
     */
    constructor({ scan }) {
        /** @type {Mask | null} the mask (red, alpha = selected); null before an image is loaded */
        this.mask = null;
        /** @type {Box | null} the bounding box: exact when `dirty` is false, a superset while `loose` */
        this.cached = null;
        /** the cached box has to be made again (scanned, or made exact from the superset) */
        this.dirty = true;
        /** `cached` is a superset of the selection, made exact on the next `bounds()` */
        this.loose = false;
        /** bumped by every change of the selection: a run that read the selection checks it is still the one it read */
        this.seq = 0;
        /** @type {string | null} the selection's PNG for a save */
        this.dataUrl = null;
        /** @type {Box | null} where the PNG goes when it holds a box of the mask, not all of it ([x, y, w, h]) */
        this.box = null;
        /** the PNG in `dataUrl` is the current selection */
        this.encoded = false;
        /** a PNG is being made in the background */
        this.encoding = false;
        /** @type {RangeRun | null} the select-range run in flight */
        this.range = null;
        this.scan = scan;
    }

    /**
     * A new mask object (a turn, a crop, an undo, a restored file): the old one is the caller's (an undo step may
     * hold it). Everything known about the old one goes.
     * @param {Mask | null} mask
     */
    replace(mask) {
        this.mask = mask;
        this.invalidate();
    }

    /** Nothing known about the selection holds any more: the box is scanned for again and the PNG made again. */
    invalidate() {
        this.dirty = true;
        this.loose = false;
        this.dataUrl = null;
        this.box = null;
        this.encoded = false;
        this.seq++;
    }

    /**
     * The mask's pixels changed. `bounds`: the new box when the caller knows it (null for an empty selection),
     * `{ within: box }` when only a box holding it is known, undefined when it has to be scanned for.
     * @param {Box | null | { within: Box } | undefined} bounds
     */
    changed(bounds) {
        if (bounds === undefined) {
            this.dirty = true; this.loose = false;
        } else if (bounds === null || Array.isArray(bounds)) {
            this.cached = /** @type {Box | null} */ (bounds);
            this.dirty = false; this.loose = false;
        } else {
            this.cached = bounds.within;
            this.dirty = true; this.loose = true;
        }
        this.seq++;
        this.encoded = false;
    }

    /** The exact box is known while the pixels are still being moved (the outline drag); `changed` follows at the end. @param {Box | null} box */
    known(box) {
        this.cached = box;
        this.dirty = false; this.loose = false;
    }

    /** The box has to be scanned for (the drag moved pixels without a known box); `changed` follows at the end. */
    rescan() {
        this.dirty = true; this.loose = false;
    }

    /** The bounding box, scanned for when it is not known. @returns {Box | null} */
    bounds() {
        if (this.dirty) {
            this.cached = this.scan(this.loose && this.cached ? this.cached : null);
            this.dirty = false;
            this.loose = false;
        }
        return this.cached;
    }

    /** What is known without a scan: the box (exact or a superset), null for none, undefined when nothing is known. @returns {Box | null | undefined} */
    knownBounds() {
        return this.dirty && !this.loose ? undefined : this.cached;
    }

    /** A background encode may start (false while one runs). */
    encodeStart() {
        if (this.encoding) return false;
        this.encoding = true;
        return true;
    }

    /** The background encode ended (with a PNG for `stored`, or failed). */
    encodeEnd() {
        this.encoding = false;
    }

    /**
     * A PNG of `mask` as it was at `seq` (null: nothing to store, an empty selection on tiles). Kept only while
     * `mask` is still the selection; current only while nothing changed since. A background encode calls `encodeEnd`
     * first; a PNG made on the spot (a small document's save) leaves a background encode alone.
     * @param {Mask | null} mask @param {string | null} url @param {Box | null} box @param {number} seq
     * @returns {"current" | "stale" | "dropped"} dropped: the mask was replaced, nothing kept
     */
    stored(mask, url, box, seq) {
        if (mask !== this.mask) return "dropped";
        this.dataUrl = url;
        this.box = box;
        if (seq !== this.seq) return "stale";
        this.encoded = true;
        return "current";
    }

    /** A select-range run starts. @param {RangeRun} run */
    beginRange(run) {
        this.range = run;
    }

    /** A select-range run ends: true when it was still the run in flight (a cancel or a new run took it otherwise). @param {RangeRun} run */
    endRange(run) {
        if (this.range !== run) return false;
        this.range = null;
        return true;
    }

    /** The run in flight, taken (a cancel). @returns {RangeRun | null} */
    takeRange() {
        const run = this.range;
        this.range = null;
        return run;
    }
}
