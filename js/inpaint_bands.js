// Generated from DenRakEiw/scumble renderer/editor/inpaint_bands.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Files written from rows, never from a whole picture (docs/PLAN_BCE.md §E2 and §E4).
 *
 * A **row source** hands out a picture a few rows at a time, in order: `{ width, height, align, part(y, n, needPrev) }`.
 * `part` resolves to `{ args, transfer }`, the rows as a worker job takes them (inpaint_worker.js `png_part`,
 * `psd_part`): `{ tiles, prevTiles, r0 }` for tile pixels in the arena, read by the worker where they lie, or
 * `{ rgba, prev }` as bytes. A part never crosses a multiple of `align` rows (a tile row, a composited band).
 *
 *   tileRows(snap, byName)             tile pixels; `snap` is a clone the caller releases when the file is written
 *   bandRows(width, height, read, n)   a picture that is composited in bands: `read(y0, y1)` gives RGBA8 of its own
 *   stackRows(width, height, stores)   a plain stack of tile pixels, composited by the worker that packs the rows
 *
 * The **writers** cut a source into parts of about 8 MB, keep a bounded number of them in the workers and join the
 * answers: `writePng` (one zlib stream from parts deflated in parallel, inpaint_png.js), `PsdBandWriter` (PackBits per
 * channel, the row length tables joined), `OraBandWriter` (a stored zip of PNGs made by `writePng`). `run(op, args,
 * transfer)` is the pool. Nothing here touches a canvas; the editor makes the sources.
 */
import { PngStreamWriter, partRows } from "./inpaint_png.js";
import { TiffStreamWriter, tiffStripRows } from "./inpaint_tiff.js";

const TILE = 256;

/** Tile pixels as a row source. `byName`: the workers hold the arena, so tiles go by slot. */
export function tileRows(snap, byName) {
    const width = snap.width, height = snap.height;
    const names = new Map();
    const row = (ty) => {
        if (!byName || ty < 0) return null;
        if (!names.has(ty)) { names.set(ty, snap.tileRowNames(ty)); if (names.size > 3) names.delete(names.keys().next().value); }
        return names.get(ty);
    };
    return {
        width, height, align: TILE,
        async part(y, n, needPrev) {
            const ty = Math.floor(y / TILE), r0 = y - ty * TILE;
            const tiles = row(ty);
            const above = needPrev && r0 === 0 && ty > 0 ? row(ty - 1) : null;
            if (tiles && (!needPrev || r0 > 0 || ty === 0 || above)) return { args: { tiles, prevTiles: above, r0 }, transfer: [] };
            const rgba = snap.readRect(0, y, width, n).data.buffer;
            const prev = needPrev && y > 0 ? snap.readRect(0, y - 1, width, 1).data.buffer : null;
            return { args: { rgba, prev }, transfer: prev ? [rgba, prev] : [rgba] };
        },
    };
}

/**
 * A picture composited in bands of `rows` as a row source. `read(y0, y1)` gives (or resolves to) the RGBA8 of those
 * rows as a typed array of its own; bands are read one after the other, each once, when its first part is asked for.
 */
export function bandRows(width, height, read, rows = TILE) {
    const stride = width * 4;
    let band = null, by0 = 0, by1 = 0, above = null;   // the band in hand, and the last row of the one before it
    return {
        width, height, align: rows,
        async part(y, n, needPrev) {
            if (y >= by1) {
                if (band) above = band.slice(band.length - stride);
                by0 = by1; by1 = Math.min(height, by0 + rows);
                if (y !== by0) throw new Error(`rows asked for out of order: ${y}, the next band starts at ${by0}`);
                band = await read(by0, by1);
                if (band.length !== (by1 - by0) * stride) throw new Error(`a band of ${band.length} bytes for ${by1 - by0} rows of ${width}`);
            }
            if (y < by0 || y + n > by1) throw new Error(`rows ${y} to ${y + n} are not in the band ${by0} to ${by1}`);
            const r = y - by0;
            const rgba = band.slice(r * stride, (r + n) * stride).buffer;
            let prev = null;
            if (needPrev) prev = r > 0 ? band.slice((r - 1) * stride, r * stride).buffer : above ? above.slice().buffer : null;
            return { args: { rgba, prev }, transfer: prev ? [rgba, prev] : [rgba] };
        },
    };
}

/**
 * A plain stack as a row source (docs/PLAN_BCE.md §3b, B item 1): `stores[0]` is the base, the others the layers from
 * the bottom, each `{ snap, mask, x, y, alpha, op }` (`snap` and `mask` clones of tile pixels the caller releases,
 * `mask` on the layer's grid or null, `alpha` 0..255, `op` 0 for source-over or the kernel's number of a blend mode,
 * `match` the ten floats of a colour match or null, B item 7 part 3). A part names the tiles its rows touch; the worker composites them
 * (inpaint_worker.js `rowsOfStack`). Every tile must be in the arena: `stackInArena` says so beforehand.
 */
export function stackRows(width, height, stores) {
    const args = stackArgs(stores);
    return {
        width, height, align: TILE,
        async part(y, n, needPrev) {
            return { args: { y, stack: args(needPrev && y > 0 ? y - 1 : y, y + n) }, transfer: [] };
        },
    };
}

/**
 * `(a, b) => stack`: what a worker needs to composite the image rows a to b of these stores (inpaint_worker.js
 * `rowsOfStack`). `stores[0]`, the base, may be null (nothing below the layers).
 */
export function stackArgs(stores) {
    const cache = new Map();   // snap -> Map(lty -> names)
    const names = (snap, lty) => {
        let m = cache.get(snap);
        if (!m) cache.set(snap, m = new Map());
        if (!m.has(lty)) { m.set(lty, snap.tileRowNames(lty)); if (m.size > 4) m.delete(m.keys().next().value); }
        return m.get(lty);
    };
    // the tile rows of a store that the image rows a to b touch: { lty: names }, or null when it has no tile there
    const rowsOf = (snap, sy, a, b) => {
        const out = {};
        let any = false;
        const lo = Math.max(0, a - sy), hi = Math.min(snap.height, b - sy);
        for (let lty = lo >> 8; lty * TILE < hi; lty++) {
            const n = names(snap, lty);
            if (n === null) throw new Error("a tile of the stack is not in the arena");
            if (n.some(Boolean)) { out[lty] = n; any = true; }
        }
        return any ? out : null;
    };
    // a clipped store's base (`clip`, a held store; PLAN_0_1_31 §6 step 3) as the worker reads it, or false when the base
    // has no tile in these rows (the clipped layer shows nothing there); `rowsOfStack` folds its coverage into the mask
    const clipOf = (c, a, b) => {
        const tiles = rowsOf(c.snap, c.y, a, b);
        if (!tiles || !(c.alpha > 0)) return false;
        return { x: c.x, y: c.y, w: c.snap.width, h: c.snap.height, alpha: c.alpha, tiles, mask: c.mask ? rowsOf(c.mask, c.y, a, b) || {} : null };
    };
    return (a, b) => {
        const [base, ...over] = stores;
        const layers = [];
        for (const s of over) {
            const clip = s.clip ? clipOf(s.clip, a, b) : null;
            if (clip === false) continue;
            if (s.sab) {   // a filtered band over the band it was made from (B item 7 part 2): bytes of the job's own box
                layers.push({ x: s.x, y: s.y, w: s.w, h: s.h, alpha: s.alpha, op: s.op | 0, sab: s.sab, mask: s.mask ? rowsOf(s.mask, s.y, a, b) || {} : null, clip });
                continue;
            }
            const tiles = rowsOf(s.snap, s.y, a, b);
            if (!tiles || !(s.alpha > 0)) continue;
            layers.push({ x: s.x, y: s.y, w: s.snap.width, h: s.snap.height, alpha: s.alpha, op: s.op | 0, tiles, mask: s.mask ? rowsOf(s.mask, s.y, a, b) || {} : null, match: s.match || null, clip });
        }
        return { base: base ? { x: 0, y: 0, w: base.snap.width, h: base.snap.height, tiles: rowsOf(base.snap, 0, a, b) || {} } : null, layers };
    };
}

/** One store of tile pixels at (x, y) of the image as a worker reads its rows a to b (`storeRows`): the bucket's clip. */
export function storeArgs(snap, x, y, a, b) {
    const tiles = {};
    for (let lty = Math.max(0, a - y) >> 8; lty * TILE < Math.min(snap.height, b - y); lty++) {
        const n = snap.tileRowNames(lty);
        if (n === null) throw new Error("a tile of the store is not in the arena");
        if (n.some(Boolean)) tiles[lty] = n;
    }
    return { x, y, w: snap.width, h: snap.height, tiles };
}

/** Is every tile of these pixels in the arena (a worker reads tiles by slot only there)? */
export function stackInArena(px) {
    for (let ty = 0; ty * TILE < px.height; ty++) if (px.tileRowNames(ty) === null) return false;
    return true;
}

/** Walk a source in parts: `each(y, n)` for every part, in order, none crossing `source.align`. */
async function forParts(source, each) {
    const per = partRows(source.width, source.align);
    for (let y = 0; y < source.height;) {
        const n = Math.min(per, source.height - y, source.align - (y % source.align));
        await each(y, n);
        y += n;
    }
}

/** A PNG of a row source: a Blob. `texts`: tEXt chunks, `chunks`: others before them; `progress(fraction)` as the rows go out. */
export async function writePng(source, run, { texts = null, chunks = null, flights = 8, progress = null, pause = null } = {}) {
    const writer = new PngStreamWriter(source.width, source.height, { texts, chunks, flights, run: (args, transfer) => run("png_part", args, transfer) });
    await forParts(source, async (y, n) => {
        await writer.room();
        const { args, transfer } = await source.part(y, n, true);
        writer.add(n, args, transfer);
        if (progress) progress((y + n) / source.height);
        if (pause && args.rgba) await pause();
    });
    return writer.finish();
}

/**
 * A TIFF of a row source (inpaint_tiff.js, docs/PLAN_0_1_29.md 3d): a Blob. Strips of one height, a power of two that
 * divides the source's alignment, compressed by `tiff_part` jobs, a bounded number at once.
 */
export async function writeTiff(source, run, { flights = 8, progress = null, pause = null, predictor = 2 } = {}) {
    let rps = tiffStripRows(source.width);
    while (rps > 1 && source.align % rps) rps >>= 1;
    const writer = new TiffStreamWriter(source.width, source.height, { flights, predictor, rowsPerStrip: rps, run: (args, transfer) => run("tiff_part", args, transfer) });
    for (let y = 0; y < source.height; y += rps) {
        const n = Math.min(rps, source.height - y);
        await writer.room();
        const { args, transfer } = await source.part(y, n, false);
        writer.add(n, args, transfer);
        if (progress) progress((y + n) / source.height);
        if (pause && args.rgba) await pause();
    }
    return writer.finish();
}

/** Parts of other kinds in the workers, a bounded number at once, answers in order. */
class Flights {
    constructor(most) { this.most = Math.max(1, most | 0); this.inFlight = new Set(); this.all = []; this.failed = null; }
    async room() {
        while (this.inFlight.size >= this.most) await Promise.race(this.inFlight);
        if (this.failed) throw this.failed;
    }
    add(promise) {
        const t = Promise.resolve(promise).then((r) => { this.inFlight.delete(t); return r; }, (err) => { this.inFlight.delete(t); if (!this.failed) this.failed = err; throw err; });
        t.catch(() => {});
        this.inFlight.add(t);
        this.all.push(t);
    }
    done() { return Promise.all(this.all); }
}

/** The PackBits channels of a row source: `[R, G, B, A]`, each `{ lens: [Uint8Array], data: [Uint8Array], total }`. */
async function packChannels(source, run, { flights = 8, progress = null, pause = null } = {}) {
    const f = new Flights(flights);
    await forParts(source, async (y, n) => {
        await f.room();
        const { args, transfer } = await source.part(y, n, false);
        delete args.prev; delete args.prevTiles;
        f.add(run("psd_part", { w: source.width, rows: n, ...args }, transfer.filter((b) => b === args.rgba)));
        if (progress) progress((y + n) / source.height);
        if (pause && args.rgba) await pause();
    });
    const replies = await f.done();
    const out = [0, 1, 2, 3].map(() => ({ lens: [], data: [], total: 0 }));
    for (const r of replies) r.channels.forEach((c, i) => { const d = new Uint8Array(c.data); out[i].lens.push(new Uint8Array(c.lens)); out[i].data.push(d); out[i].total += d.length; });
    return out;
}

const PSD_BLEND = { normal: "norm", multiply: "mul ", screen: "scrn", overlay: "over", darken: "dark", lighten: "lite", "soft-light": "sLit", "hard-light": "hLit", "linear-light": "lLit", difference: "diff" };
const ORA_BLEND = { normal: "svg:src-over", multiply: "svg:multiply", screen: "svg:screen", overlay: "svg:overlay", darken: "svg:darken", lighten: "svg:lighten", "soft-light": "svg:soft-light", "hard-light": "svg:hard-light", "linear-light": "scumble:linear-light", difference: "svg:difference" };

class Bytes {
    constructor() { this.parts = []; this.size = 0; }
    push(u8) { this.parts.push(u8); this.size += u8.length; }
    u8(v) { this.push(Uint8Array.of(v & 255)); }
    u16(v) { this.push(Uint8Array.of((v >> 8) & 255, v & 255)); }
    i16(v) { this.u16(v < 0 ? v + 0x10000 : v); }
    u32(v) { if (!(v >= 0 && v <= 0xFFFFFFFF)) throw new Error("a PSD section above 4 GB: this document needs PSB, which is not written"); this.push(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
    i32(v) { this.u32(v < 0 ? v + 0x100000000 : v); }
    ascii(s) { this.push(new TextEncoder().encode(s)); }
}

function pascal(name, pad) {
    const bytes = new TextEncoder().encode(String(name || "Layer").replace(/[^\x20-\x7e]/g, "_").slice(0, 255));
    const out = new Uint8Array(Math.ceil((1 + bytes.length) / pad) * pad);
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
}

/**
 * The layer's full name as Photoshop reads it: an additional layer info block `luni` (a count, then UTF-16 code
 * units, padded to 4 bytes). The Pascal name beside it holds ASCII only, so without this block every name with an
 * umlaut came back as "___".
 */
function luni(name) {
    const s = String(name || "Layer");
    const len = 4 + 2 * s.length, padded = Math.ceil(len / 4) * 4;
    const out = new Uint8Array(12 + padded);
    const v = new DataView(out.buffer);
    out.set([0x38, 0x42, 0x49, 0x4d, 0x6c, 0x75, 0x6e, 0x69], 0);   // "8BIM" "luni"
    v.setUint32(8, padded);
    v.setUint32(12, s.length);
    for (let i = 0; i < s.length; i++) v.setUint16(16 + 2 * i, s.charCodeAt(i));
    return out;
}

/** The `lsct` block of a group's record: the kind (1 / 2 folder, 3 divider), and for a folder its blend mode, pass through. */
function lsctBlock(kind) {
    const folder = kind !== 3;
    const out = new Uint8Array(12 + (folder ? 12 : 4));
    const v = new DataView(out.buffer);
    out.set([0x38, 0x42, 0x49, 0x4d, 0x6c, 0x73, 0x63, 0x74], 0);   // "8BIM" "lsct"
    v.setUint32(8, folder ? 12 : 4);
    v.setUint32(12, kind);
    if (folder) out.set([0x38, 0x42, 0x49, 0x4d, 0x70, 0x61, 0x73, 0x73], 16);   // "8BIM" "pass"
    return out;
}

/**
 * The PSD of inpaint_export.js `PsdWriter`, byte for byte, from row sources: a layer is packed as soon as it is handed
 * over and kept packed (a 15000 x 10000 layer's four channels are a fraction of its 600 MB), the file is a Blob of the
 * pieces. PSD (not PSB): 30,000 px a side and 4 GB a section at most.
 */
export class PsdBandWriter {
    constructor({ width, height, run, flights = 8, pause = null }) {
        if (width > 30000 || height > 30000) throw new Error(`a PSD holds at most 30,000 px a side (${width} × ${height})`);
        this.width = width; this.height = height;
        this.run = run; this.flights = flights; this.pause = pause;
        this.records = new Bytes();
        this.channelBlobs = [];
        this.channelSize = 0;
        this.count = 0;
    }

    /**
     * One layer, bottom first: `L` = { name, x, y, opacity, visible, blend, mask }, `source` its pixels. With
     * `maskSource` (a row source of the layer's size whose alpha is the mask) and `L.mask` = `{ disabled }`, the layer
     * gets its user mask (channel -2), as `PsdWriter.layer` writes it.
     */
    async layer(L, source, progress = null, maskSource = null) {
        const lw = source.width, lh = source.height;
        if (maskSource && (maskSource.width !== lw || maskSource.height !== lh)) throw new Error(`the mask of layer "${L.name}" is ${maskSource.width} x ${maskSource.height}, its pixels ${lw} x ${lh}`);
        if (!maskSource !== !L.mask) throw new Error(`layer "${L.name}": a mask ${maskSource ? "source without L.mask" : "flag without its pixels"}`);
        // the mask's rows are packed like a layer's (all four channels, its alpha kept): half of the progress each
        const part = (from, share) => (progress ? (f) => progress(from + f * share) : null);
        const [r, g, b, a] = await packChannels(source, this.run, { flights: this.flights, progress: part(0, maskSource ? 0.5 : 1), pause: this.pause });
        const packed = [[-1, a], [0, r], [1, g], [2, b]];
        if (maskSource) packed.push([-2, (await packChannels(maskSource, this.run, { flights: this.flights, progress: part(0.5, 0.5), pause: this.pause }))[3]]);
        const rec = this.records;
        rec.i32(L.y); rec.i32(L.x); rec.i32(L.y + lh); rec.i32(L.x + lw);
        rec.u16(packed.length);
        for (const [id, pk] of packed) { rec.i16(id); rec.u32(2 + 2 * lh + pk.total); }
        rec.ascii("8BIM");
        rec.ascii(PSD_BLEND[L.blend] || "norm");
        rec.u8(Math.round(Math.max(0, Math.min(1, L.opacity ?? 1)) * 255));
        rec.u8(L.clip ? 1 : 0);   // clipped to the layer below, as PsdWriter writes it
        rec.u8(L.visible === false ? 2 : 0);
        rec.u8(0);
        const name = pascal(L.name, 4), uni = luni(L.name);
        rec.u32(4 + (maskSource ? 20 : 0) + 4 + name.length + uni.length);
        if (maskSource) {
            // layer mask data: its rectangle (the layer's), default colour, flags (bit 1: disabled), 2 bytes of padding
            rec.u32(20);
            rec.i32(L.y); rec.i32(L.x); rec.i32(L.y + lh); rec.i32(L.x + lw);
            rec.u8(255);
            rec.u8(L.mask.disabled ? 2 : 0);
            rec.u16(0);
        } else rec.u32(0);
        rec.u32(0);   // blending ranges
        rec.push(name);
        rec.push(uni);
        // the layer's channels as one Blob right away: the packed rows of a large layer are hundreds of megabytes in
        // thousands of buffers, which a Blob made at the end copied in one go (a second of blocked window at 30000 x 20000)
        const pieces = [];
        let size = 0;
        for (const [, pk] of packed) {
            pieces.push(Uint8Array.of(0, 1));
            for (const l of pk.lens) pieces.push(l);
            for (const d of pk.data) pieces.push(d);
            size += 2 + 2 * lh + pk.total;
        }
        this.channelBlobs.push(new Blob(pieces));
        this.channelSize += size;
        this.count++;
    }

    /**
     * A group's record (PLAN_0_1_31 §6.5): `S.section` 1 / 2 (the folder, above its layers; 2 = folded) or 3 (the
     * bounding divider below them), as Photoshop writes them: no pixels (four channels of no rows), the folder in blend
     * mode pass through, flags 24 (bit 4 "pixels irrelevant", bit 3 "bit 4 is set") plus 2 when hidden, the kind in an
     * `lsct` block.
     */
    section(S) {
        const records = this.records;   // PsdWriter.section, byte for byte
        records.i32(0); records.i32(0); records.i32(0); records.i32(0);
        records.u16(4);
        for (const id of [-1, 0, 1, 2]) { records.i16(id); records.u32(2); }
        records.ascii("8BIM");
        records.ascii(S.section === 3 ? "norm" : "pass");
        records.u8(255);
        records.u8(0);
        records.u8(24 | (S.visible === false ? 2 : 0));
        records.u8(0);
        const name = pascal(S.name, 4), uni = luni(S.name), lsct = lsctBlock(S.section);
        records.u32(4 + 4 + name.length + uni.length + lsct.length);
        records.u32(0);   // no mask
        records.u32(0);   // blending ranges
        records.push(name);
        records.push(uni);
        records.push(lsct);
        this.channelBlobs.push(new Blob([Uint8Array.of(0, 1, 0, 1, 0, 1, 0, 1)]));   // four channels: PackBits of no rows
        this.channelSize += 8;
        this.count++;
    }

    /** The flattened picture closes the file. */
    async finish(composite, progress = null) {
        const [cr, cg, cb] = await packChannels(composite, this.run, { flights: this.flights, progress, pause: this.pause });
        const w = new Bytes();
        w.ascii("8BPS"); w.u16(1); w.push(new Uint8Array(6)); w.u16(3); w.u32(this.height); w.u32(this.width); w.u16(8); w.u16(3);
        w.u32(0);   // colour mode data
        w.u32(0);   // image resources
        let layerInfoLen = 2 + this.records.size + this.channelSize;
        const pad = layerInfoLen % 2;
        layerInfoLen += pad;
        w.u32(4 + layerInfoLen + 4);
        w.u32(layerInfoLen);
        w.i16(this.count);
        for (const p of this.records.parts) w.push(p);
        const tail = new Bytes();
        if (pad) tail.u8(0);
        tail.u32(0);   // global layer mask info
        // merged image: RGB, PackBits, all row lengths first
        tail.u16(1);
        for (const pk of [cr, cg, cb]) for (const l of pk.lens) tail.push(l);
        for (const pk of [cr, cg, cb]) for (const d of pk.data) tail.push(d);
        return new Blob([...w.parts, ...this.channelBlobs, ...tail.parts], { type: "image/vnd.adobe.photoshop" });
    }
}

const le16 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255);
const le32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The OpenRaster file of inpaint_export.js `OraWriter` from row sources: every layer a PNG made by `writePng`, the zip
 * (stored entries) a Blob of the pieces, each entry's CRC-32 from a worker. Zip, not zip64: 4 GB at most.
 */
export class OraBandWriter {
    constructor({ width, height, run, flights = 8, pause = null }) {
        this.width = width; this.height = height;
        this.run = run; this.flights = flights; this.pause = pause;
        this.entries = [];   // { name, blob, crc, size }
        this.stackLines = [];
        this.count = 0;
        this._add("mimetype", new Blob([new TextEncoder().encode("image/openraster")]));
    }

    _add(name, blob) {
        const e = { name, blob, crc: 0, size: blob.size };
        e.ready = Promise.resolve(this.run("crc", { blob }, [])).then((r) => { e.crc = r.crc >>> 0; });
        e.ready.catch(() => {});
        this.entries.push(e);
    }

    async layer(L, source, progress = null) {
        const file = `data/layer${this.count}.png`;
        this._add(file, await writePng(source, this.run, { flights: this.flights, progress, pause: this.pause }));
        // ORA lists layers top first, they arrive bottom first
        this.stackLines.unshift(`    <layer name="${xmlEsc(L.name || "Layer")}" src="${file}" x="${L.x}" y="${L.y}" opacity="${(L.opacity ?? 1).toFixed(3)}" visibility="${L.visible === false ? "hidden" : "visible"}" composite-op="${ORA_BLEND[L.blend] || "svg:src-over"}" />`);
        this.count++;
    }

    /** `composite`: the merged picture's row source; `thumbnail`: a PNG Blob of at most 256 px. */
    async finish(composite, thumbnail, progress = null) {
        const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${this.width}" h="${this.height}" xres="72" yres="72">\n  <stack>\n${this.stackLines.join("\n")}\n  </stack>\n</image>\n`;
        this._add("stack.xml", new Blob([new TextEncoder().encode(stack)]));
        this._add("mergedimage.png", await writePng(composite, this.run, { flights: this.flights, progress, pause: this.pause }));
        if (thumbnail) this._add("Thumbnails/thumbnail.png", thumbnail);
        await Promise.all(this.entries.map((e) => e.ready));
        const pieces = [], central = [];
        let offset = 0, cdSize = 0;
        const put = (list, u8) => { list.push(u8); return u8.length; };
        for (const e of this.entries) {
            const name = new TextEncoder().encode(e.name);
            if (e.size > 0xFFFFFFFF || offset > 0xFFFFFFFF) throw new Error("an OpenRaster file above 4 GB is not written (zip64)");
            const at = offset;
            for (const u of [le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(e.crc), le32(e.size), le32(e.size), le16(name.length), le16(0), name]) offset += put(pieces, u);
            pieces.push(e.blob); offset += e.size;
            for (const u of [le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0x21), le32(e.crc), le32(e.size), le32(e.size), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(at), name]) cdSize += put(central, u);
        }
        if (offset > 0xFFFFFFFF) throw new Error("an OpenRaster file above 4 GB is not written (zip64)");
        const n = this.entries.length;
        const end = [le32(0x06054b50), le16(0), le16(0), le16(n), le16(n), le32(cdSize), le32(offset), le16(0)];
        return new Blob([...pieces, ...central, ...end], { type: "image/openraster" });
    }
}
