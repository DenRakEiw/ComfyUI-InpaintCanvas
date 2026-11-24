// Generated from scumble-app/scumble renderer/editor/inpaint_docmaps.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// The document maps of one document (item 77 step 2, docs/PLAN_ENCAPSULATION.md): the depth, normal and other maps by
// kind, the version every cache of them keys on, and the preview of a map's meta while a slider is dragged, with one
// owner. The map objects themselves are made elsewhere (inpaint_maps.js, the depth part); this object only keeps them
// and bumps the version with every change a reader has to see. Before, seven parts wrote `maps` and `mapsVersion` by
// hand, and the preview kept the map it would put back without its kind.

/**
 * @typedef {{ xf?: number[] | null, data?: ArrayBufferView | null, meta?: object, [k: string]: any }} DocMap
 * @typedef {Record<string, DocMap>} MapSet
 * @typedef {{ kind: string, prev: DocMap }} MapPreview
 */

export class DocumentMaps {
    constructor() {
        /** @type {MapSet} the maps by kind; readers may hold the object, only this class changes it */
        this.all = {};
        /** bumped by every change of a map a reader has to see (the caches of filters, relight and the depth view key on it) */
        this.version = 0;
        /** @type {MapPreview | null} the map a meta preview replaced, put back by `endPreview` / `cancelPreview` */
        this.preview = null;
    }

    /** @param {string} kind @returns {DocMap | null} */
    get(kind) {
        return this.all[kind] || null;
    }

    /** Put or drop one map without a new version (a restore that bumps once at its end, the `depth` setter). @param {string} kind @param {DocMap | null | undefined} map */
    put(kind, map) {
        if (map) this.all[kind] = map;
        else delete this.all[kind];
    }

    /** A new version: what the readers key on changed. */
    bump() {
        this.version++;
    }

    /** Put or drop several maps (null drops), one new version. @param {Record<string, DocMap | null | undefined>} maps */
    set(maps) {
        for (const [kind, map] of Object.entries(maps)) this.put(kind, map);
        this.bump();
    }

    /**
     * Every map at once (a new document, an undo of a turn): a new object, so a reader holding the old set keeps it.
     * @param {MapSet | null | undefined} maps @param {{ bump?: boolean }} [opts]
     */
    replaceAll(maps, { bump = true } = {}) {
        this.all = maps ? { ...maps } : {};
        this.preview = null;
        if (bump) this.bump();
    }

    /**
     * The maps' placement on the picture follows a geometry change (a turn, a straighten): each map with a placement
     * gets `place(xf)` written into it, in place (the steps that hold the map copied it, `mapsCopy`). One new version
     * when any map moved. @param {(xf: number[]) => number[]} place
     */
    follow(place) {
        let any = false;
        for (const map of Object.values(this.all)) {
            if (!map || !map.xf) continue;
            map.xf = place(map.xf);
            any = true;
        }
        if (any) this.bump();
    }

    /**
     * A meta preview shows `updated` in place of the map of `kind`; the first preview keeps the map it replaced.
     * @param {string} kind @param {DocMap} updated
     */
    showPreview(kind, updated) {
        const cur = this.all[kind];
        if (!this.preview && cur) this.preview = { kind, prev: cur };
        this.all[kind] = updated;
        this.bump();
    }

    /** The preview is committed: the map it replaced, for the undo step (null without a preview). @param {string} kind @returns {DocMap | null} */
    endPreview(kind) {
        const p = this.preview;
        this.preview = null;
        return p && p.kind === kind ? p.prev : null;
    }

    /** The preview is let go without putting anything back (the editor is destroyed). */
    forgetPreview() {
        this.preview = null;
    }

    /** The preview is cancelled: the map it replaced is put back under its own kind. @returns {MapPreview | null} */
    cancelPreview() {
        const p = this.preview;
        if (!p) return null;
        this.preview = null;
        this.all[p.kind] = p.prev;
        this.bump();
        return p;
    }
}
