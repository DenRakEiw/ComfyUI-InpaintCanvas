// Generated from DenRakEiw/scumble renderer/editor/inpaint_layered.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Reading layered files: Photoshop PSD and OpenRaster ORA, the two formats the editor writes (inpaint_bands.js).
 * Plain data in, plain data out, no DOM: `node tools/layered_test.js` runs it as it is.
 *
 * `readPsd(bytes, { inflate })` answers `{ width, height, layers, composite, notes }`: the layers bottom first, each
 * `{ name, x, y, w, h, opacity, visible, blend, rgba }` with straight (not premultiplied) RGBA bytes of w x h;
 * `composite` the file's merged picture as RGBA (null when it has none); `notes` what could not be kept, in words.
 * A layer with a user mask (channel -2, else -3) also has `mask: { data, defaultColor, disabled }`: `data` w x h bytes
 * at the layer's own size (255 = visible; the mask's own rectangle placed in it, its default colour around it),
 * `disabled` its switched-off flag; the pixels stay as they are (docs/PLAN_0_1_31.md 3e). A layer without one has
 * no `mask`. What a PSD holds and the editor has no place for is turned into what it looks like, where that is cheap
 * and exact enough: a group comes back as a folder (`groups` [{ id, name, visible, collapsed, parent }], a layer's
 * `group` the innermost it is in; PLAN_0_1_31 §6.5), its opacity goes into its layers' (a folder has none; exact for a
 * group in pass-through or normal mode), 16-bit samples are rounded to 8. What has no pixels of its own
 * is left out and named: adjustment and fill layers, empty layers. A clipped layer stays clipped to the layer below
 * (`clip`) unless its base was a group or a layer left out; that, and blend modes the editor lacks, are named too
 * (the layer stays, unclipped or in normal mode). RGB and grayscale, 8 and 16 bit; PSB,
 * CMYK, Lab, indexed and 32-bit files are refused with their name. `inflate(bytes)` (async, zlib) is only needed
 * for ZIP-compressed channels (Photoshop writes RLE unless told otherwise).
 *
 * `readPsdStream(bytes, { inflate, rowsPerBand, onHeader, onRows })` is the same parse for the pool job `psd_read`
 * (docs/PLAN_WASM_BUILD.md §7 D0): each layer's pixels and mask go out as RGBA bands once its channels are read, the
 * answer names them by index; readPsd stays the window's reader and its twin (tools/layered_test.js).
 *
 * `readOra(bytes, { inflateRaw })` (`readOraBlob(blob, ...)` for a file left a Blob) answers `{ width, height, layers, notes }`, each layer with its PNG as `png`
 * (bytes) instead of `rgba`, for the caller to decode; nested stacks are flattened: their visibility and opacity go
 * into their layers.
 *
 * A crafted file is refused with a plain message before it can make the reader grow (H1 S5): a layer or mask larger
 * than a document can hold, a channel whose data cannot fill its rectangle, a deflate stream that unpacks to more than
 * what is kept (`inflateAtMost`, the inflater both readers use); both readers take `onHeader` for the caller's size
 * check before anything is read. `inflate(bytes, cap)` / `inflateRaw(bytes, cap)` get the most they may give.
 */

import { PSD_BLENDS, ORA_BLENDS } from "./blend_modes.js";

export const LAYERED_EXT = /\.(psd|ora)$/i;

// What a crafted file can make the reader allocate (H1 S5, docs/research/review_external_2026-11-07/verified.json): a
// layer or mask rectangle at most what a document can hold (inpaint_canvas.js HUGE_MAX_SIDE, HUGE_MAX_PIXELS), and no
// channel larger than its data can fill (PackBits gives at most 128 bytes for 2, deflate at most 1032 for 1), so what
// a file asks for grows with its own size; an inflate stops at the bytes it may give (`inflateAtMost`).
export const LAYER_MAX_SIDE = 65535;
export const LAYER_MAX_PIXELS = 1024 * 1024 * 1024;
const DEFLATE_MAX_RATIO = 1032;
// OpenRaster: stack.xml unpacked at most this large, and every deflated entry together at most ORA_INFLATE_BASE plus
// ORA_INFLATE_RATIO times the file (a layer's PNG is compressed already: a zip deflates it by a few per cent)
const ORA_XML_MAX = 16 * 1024 * 1024;
const ORA_INFLATE_BASE = 256 * 1024 * 1024;
const ORA_INFLATE_RATIO = 64;
const INFLATE_SLICE = 64 * 1024;
// OpenRaster layers are PNGs the browser decodes: one below 2^29 px (what Blink decodes at all, so the refusal is
// plain), and all of a file's together at most what a layered file opens at (268 MP, inpaint_canvas.js
// checkLayeredSize) or 64 times the picture, whichever is more, counted from the PNGs' headers before any decode
const ORA_LAYER_MAX_PIXELS = 2 ** 29 - 1;
const ORA_PIXELS_BASE = 268435456;
const ORA_PIXELS_PER_PICTURE = 64;

const mbText = (n) => (n >= 1048576 ? `${Math.round(n / 1048576).toLocaleString("en-US")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sizeText = (w, h) => `${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")} px`;

/**
 * `bytes` (zlib "deflate" or "deflate-raw") inflated by the browser's DecompressionStream, but never to more than `cap`
 * bytes: the input goes in in slices of 64 KB while the output is read, and once the output passes `cap` the inflate
 * stops and throws (`.tooLarge` set), so a deflate bomb costs at most `cap` plus one slice's output (64 KB at 1032:1)
 * instead of all it unpacks to. Within the cap it is the whole inflate it was (the same bytes, the stream's end and
 * checksum checked): the window's reader and the pool's (inpaint_worker.js) both use this one, so their bytes agree.
 */
export async function inflateAtMost(bytes, format = "deflate", cap = Infinity) {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter(), reader = ds.readable.getReader();
    let fedErr = null, stop = false;
    const feed = (async () => {   // fed while the output is read, or the inflater's back-pressure would stall it
        try {
            for (let i = 0; i < bytes.length && !stop; i += INFLATE_SLICE) await writer.write(bytes.subarray(i, i + INFLATE_SLICE));
            if (!stop) await writer.close();
        } catch (err) { if (!stop) fedErr = err; }
    })();
    const parts = [];
    let n = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            n += value.length;
            if (n > cap) {
                stop = true;
                reader.cancel().catch(() => {});   // the feeding side stops with it
                const err = new Error(`the compressed data unpacks to more than ${cap.toLocaleString("en-US")} bytes`);
                err.tooLarge = true;
                throw err;
            }
            parts.push(value);
        }
    } catch (err) {
        if (!stop) { stop = true; reader.cancel().catch(() => {}); }
        throw err;
    }
    await feed;
    if (fedErr) throw fedErr;
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(n);
    for (let i = 0, o = 0; i < parts.length; o += parts[i].length, i++) out.set(parts[i], o);
    return out;
}

/** A layer or mask rectangle against what a document can hold; `what` names it in the refusal. */
function checkRect(what, w, h, maxPixels = LAYER_MAX_PIXELS) {
    if (w > LAYER_MAX_SIDE || h > LAYER_MAX_SIDE || w * h > maxPixels) {
        throw new Error(`${what} is ${sizeText(w, h)}, more than a layer can be (${LAYER_MAX_SIDE.toLocaleString("en-US")} px a side, ${Math.round(maxPixels / 1e6).toLocaleString("en-US")} MP): the file is damaged or not one this reader takes`);
    }
}

// additional layer info keys that make a layer an adjustment or a fill (no pixels of its own)
const ADJUSTMENTS = new Set(["SoCo", "GdFl", "PtFl", "brit", "levl", "curv", "expA", "vibA", "hue ", "hue2", "blnc", "blwh",
    "phfl", "mixr", "clrL", "nvrt", "post", "thrs", "grdm", "selc", "CgEd"]);
const PSD_MODES = { 0: "bitmap", 1: "grayscale", 2: "indexed", 3: "RGB", 4: "CMYK", 7: "multichannel", 8: "duotone", 9: "Lab" };

/** Is this the start of a PSD (or PSB) file? */
export function isPsd(head) {
    return head && head.length >= 4 && head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53;
}

/** Is this the start of an OpenRaster file (a zip whose first entry is the stored `mimetype` "image/openraster")? */
export function isOra(head) {
    if (!head || head.length < 54 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return false;
    const nameLen = head[26] | (head[27] << 8), extra = head[28] | (head[29] << 8);
    const name = String.fromCharCode(...head.subarray(30, 30 + nameLen));
    if (name !== "mimetype") return false;
    const at = 30 + nameLen + extra;
    return String.fromCharCode(...head.subarray(at, at + 16)) === "image/openraster";
}

class Reader {
    constructor(bytes) {
        this.b = bytes;
        this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.p = 0;
    }
    need(n) { if (this.p + n > this.b.length) throw new Error("the file ends early (truncated or not a PSD)"); }
    u8() { this.need(1); return this.b[this.p++]; }
    u16() { this.need(2); const x = this.v.getUint16(this.p); this.p += 2; return x; }
    i16() { this.need(2); const x = this.v.getInt16(this.p); this.p += 2; return x; }
    u32() { this.need(4); const x = this.v.getUint32(this.p); this.p += 4; return x; }
    i32() { this.need(4); const x = this.v.getInt32(this.p); this.p += 4; return x; }
    ascii(n) { this.need(n); const s = String.fromCharCode(...this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
    bytes(n) { this.need(n); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
    skip(n) { this.need(n); this.p += n; }
}

/** PackBits rows into `out` (length rows * rowBytes); `lens` the packed length of each row. */
function unpackRows(src, at, lens, rowBytes, out) {
    let p = at;
    for (let y = 0; y < lens.length; y++) {
        const end = p + lens[y], lim = Math.min(end, src.length);
        let o = y * rowBytes;
        const stop = o + rowBytes;
        while (p < lim && o < stop) {
            const n = src[p++];
            if (n < 128) {
                const c = Math.min(n + 1, stop - o, lim - p);
                out.set(src.subarray(p, p + c), o);
                p += n + 1; o += c;
            } else if (n > 128) {
                const c = Math.min(257 - n, stop - o);
                out.fill(p < lim ? src[p++] : 0, o, o + c);
                o += c;
            }   // 128 is a no-op
        }
        if (o < stop) out.fill(0, o, stop);
        p = end;
    }
    return p;
}

/**
 * Unpack `rows` PSD PackBits rows (`rowBytes` unpacked bytes per row) from `src`, advancing by each row's big-endian
 * `u16` byte count in `lensBytes` (`2 * rows` bytes), into `out` (or a fresh `Uint8Array(rows * rowBytes)`; JS twin of
 * `crates/px` `packbits_rows`, K20b).
 */
export function packbitsRows(lensBytes, src, rows, rowBytes, out = null) {
    if (!Number.isInteger(rows) || !Number.isInteger(rowBytes) || rows < 0 || rowBytes < 0) {
        throw new Error(`packbits_rows: invalid dimensions (rows=${rows}, rowBytes=${rowBytes})`);
    }
    if (rows === 0 || rowBytes === 0) {
        if (out != null && !ArrayBuffer.isView(out)) throw new Error("packbits_rows: out must be an ArrayBufferView");
        return out || new Uint8Array(0);
    }
    if (!ArrayBuffer.isView(lensBytes) || lensBytes.byteLength < rows * 2 || !ArrayBuffer.isView(src)) {
        throw new Error("packbits_rows: invalid lensBytes or src");
    }
    const need = rows * rowBytes;
    let dst = null;
    if (out != null) {
        if (!ArrayBuffer.isView(out) || out.byteLength < need) {
            throw new Error(`packbits_rows: out too short (${out && out.byteLength} < ${need})`);
        }
        dst = out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } else {
        dst = new Uint8Array(need);
    }
    const lb = lensBytes instanceof Uint8Array ? lensBytes : new Uint8Array(lensBytes.buffer, lensBytes.byteOffset, lensBytes.byteLength);
    const sb = src instanceof Uint8Array ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    let p = 0;
    for (let y = 0; y < rows; y++) {
        const rowLen = (lb[2 * y] << 8) | lb[2 * y + 1];
        const end = p + rowLen, lim = Math.min(end, sb.length);
        let o = y * rowBytes;
        const stop = o + rowBytes;
        while (p < lim && o < stop) {
            const n = sb[p++];
            if (n < 128) {
                const c = Math.min(n + 1, stop - o, lim - p);
                dst.set(sb.subarray(p, p + c), o);
                p += n + 1; o += c;
            } else if (n > 128) {
                const c = Math.min(257 - n, stop - o);
                dst.fill(p < lim ? sb[p++] : 0, o, o + c);
                o += c;
            }
        }
        if (o < stop) dst.fill(0, o, stop);
        p = end;
    }
    return out || dst;
}

/**
 * Place a band's mask overlap (`ry1 - ry0` rows of width `mw` starting at mask column `sx0`, `8`-bit or big-endian
 * `16`-bit) into `out` (or a fresh `Uint8ClampedArray(rows * w * 4)`) as `[255, 255, 255, alpha]` over
 * `[ry0, ry1) × [x0, x1)` and `[255, 255, 255, def]` elsewhere (JS twin of `crates/px` `psd_mask_rgba`, K20b).
 */
export function psdMaskRgba(src, mw, sx0, w, rows, x0, x1, ry0, ry1, bits, def, out = null) {
    if (!Number.isInteger(w) || !Number.isInteger(rows) || w <= 0 || rows <= 0 || (bits !== 8 && bits !== 16)) {
        throw new Error(`psd_mask_rgba: invalid size or bits (w=${w}, rows=${rows}, bits=${bits})`);
    }
    if (!Number.isInteger(x0) || !Number.isInteger(x1) || !Number.isInteger(ry0) || !Number.isInteger(ry1)
        || x0 < 0 || x0 > x1 || x1 > w || ry0 < 0 || ry0 > ry1 || ry1 > rows) {
        throw new Error(`psd_mask_rgba: invalid overlap (${x0}..${x1} in ${w}, ${ry0}..${ry1} in ${rows})`);
    }
    const needOut = w * rows * 4;
    let dst = null;
    if (out != null) {
        if (!ArrayBuffer.isView(out) || out.byteLength < needOut) {
            throw new Error(`psd_mask_rgba: out too short (${out && out.byteLength} < ${needOut})`);
        }
        dst = out instanceof Uint8Array || out instanceof Uint8ClampedArray
            ? out
            : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } else {
        dst = new Uint8ClampedArray(needOut);
    }
    const mRows = ry1 - ry0, span = x1 - x0, d8 = def & 255;
    let sb = null, mStride = 0, bps = bits >>> 3;
    if (mRows > 0 && span > 0) {
        if (!Number.isInteger(mw) || !Number.isInteger(sx0) || mw <= 0 || sx0 < 0 || sx0 + span > mw) {
            throw new Error(`psd_mask_rgba: invalid mask columns (sx0=${sx0}, span=${span}, mw=${mw})`);
        }
        mStride = mw * bps;
        const needSrc = (mRows - 1) * mStride + (sx0 + span) * bps;
        if (!ArrayBuffer.isView(src) || src.byteLength < needSrc) {
            throw new Error(`psd_mask_rgba: src too short (${src && src.byteLength} < ${needSrc})`);
        }
        sb = src instanceof Uint8Array ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    }
    for (let i = 0; i < needOut; i += 4) {
        dst[i] = 255; dst[i + 1] = 255; dst[i + 2] = 255; dst[i + 3] = d8;
    }
    if (mRows > 0 && span > 0) {
        for (let mr = 0; mr < mRows; mr++) {
            const rowBase = (ry0 + mr) * w * 4 + x0 * 4;
            const sBase = mr * mStride + sx0 * bps;
            if (bits === 8) {
                for (let i = 0; i < span; i++) dst[rowBase + i * 4 + 3] = sb[sBase + i];
            } else {
                for (let i = 0; i < span; i++) {
                    const v = (sb[sBase + i * 2] << 8) | sb[sBase + i * 2 + 1];
                    dst[rowBase + i * 4 + 3] = (v * 255 + 32895) >>> 16;
                }
            }
        }
    }
    return out || dst;
}

/** Undo the ZIP-with-prediction delta per row (8 bit: byte deltas, 16 bit: big-endian word deltas). */
function unpredict(buf, w, h, depth) {
    if (depth === 16) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
            const i = (y * w + x) * 2;
            v.setUint16(i, (v.getUint16(i) + v.getUint16(i - 2)) & 0xffff);
        }
    } else {
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { const i = y * w + x; buf[i] = (buf[i] + buf[i - 1]) & 255; }
    }
}

/** The fewest PackBits bytes that unpack to `rows` rows of `rowBytes` bytes (2 bytes give at most 128). */
const packedAtLeast = (rows, rowBytes) => rows * 2 * Math.ceil(rowBytes / 128);

/** The refusal of a channel whose data cannot fill its rectangle (`what` names the layer). */
function tooShort(what, w, h) {
    return new Error(`${what} holds less data than its ${sizeText(w, h)} need: the file is damaged`);
}

/**
 * One channel's samples as 8-bit bytes (w * h), from `compression` at r.p; the reader ends after `len` bytes. Its data
 * is checked against the rectangle before anything is made (H1 S5): raw data must hold every sample, PackBits rows at
 * least what the rows can unpack from, deflate at least 1 byte per 1032; a ZIP channel unpacking to more than its
 * samples is refused at that point. `what` names the layer in a refusal.
 */
async function readChannel(r, compression, w, h, depth, dataLen, inflate, what = "a PSD layer") {
    const bpc = depth / 8, rowBytes = w * bpc, size = w * h * bpc;
    const start = r.p;
    let out;
    if (compression === 0) {
        if (dataLen < size) throw tooShort(what, w, h);
        out = new Uint8Array(size);
        out.set(r.bytes(size));
    } else if (compression === 1) {
        // the row table and the rows lie inside the channel's own length: rows read past it would be the next
        // channels' bytes, so a few MB of records could each claim the same data for planes of gigabytes
        if (2 * h > dataLen) throw tooShort(what, w, h);
        const lens = new Array(h);
        for (let y = 0; y < h; y++) lens[y] = r.u16();
        const total = lens.reduce((a, b) => a + b, 0);
        r.need(total);
        if (total < packedAtLeast(h, rowBytes) || 2 * h + total > dataLen) throw tooShort(what, w, h);
        out = new Uint8Array(size);
        unpackRows(r.b, r.p, lens, rowBytes, out);
        r.p += total;
    } else if (compression === 2 || compression === 3) {
        if (!inflate) throw new Error("a ZIP-compressed PSD channel needs an inflater");
        r.need(dataLen);
        if (size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);
        // an inflater that does not stop at the cap (a test's) is held to it all the same
        const bomb = () => new Error(`a ZIP channel of ${what} unpacks to more than its ${sizeText(w, h)}: the file is damaged`);
        let raw;
        try { raw = await inflate(r.bytes(dataLen), size); } catch (err) { throw err && err.tooLarge ? bomb() : err; }
        if (raw.length > size) throw bomb();
        out = new Uint8Array(size);
        out.set(raw.subarray(0, Math.min(raw.length, size)));
        if (compression === 3) unpredict(out, w, h, depth);
    } else {
        throw new Error(`unknown PSD compression ${compression}`);
    }
    if (dataLen != null) r.p = start + dataLen;
    if (bpc === 1) return out;
    // 16 bit: round to 8 (x * 255 / 65535, i.e. the high byte with rounding)
    const o8 = new Uint8Array(w * h);
    for (let i = 0; i < o8.length; i++) o8[i] = Math.round(((out[2 * i] << 8) | out[2 * i + 1]) / 257);
    return o8;
}

function pascalName(r, pad) {
    const n = r.u8();
    const s = r.ascii(n);
    const used = 1 + n;
    const rest = (pad - (used % pad)) % pad;
    r.skip(rest);
    return s;
}

/** The additional layer info blocks of a layer record (between its name and its end): { key: bytes }. */
function additionalInfo(r, end) {
    const info = {};
    while (r.p + 12 <= end) {
        const sig = r.ascii(4);
        if (sig !== "8BIM" && sig !== "8B64") break;
        const key = r.ascii(4);
        const len = r.u32();
        if (r.p + len > end) break;
        info[key] = r.bytes(len);
    }
    return info;
}

function unicodeName(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = v.getUint32(0);
    if (4 + 2 * n > bytes.length) return null;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint16(4 + 2 * i));
    return s.replace(/\0+$/, "");
}

function sectionType(bytes) {
    if (!bytes || bytes.length < 4) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

/** A group's blend mode from its `lsct` block ("8BIM" and the key after the kind), null when the block has none. */
function sectionBlend(bytes) {
    if (!bytes || bytes.length < 12) return null;
    return String.fromCharCode(...bytes.subarray(8, 12));
}

/** Straight RGBA from the planar channels: gray replicated, a missing alpha opaque. */
function interleave(ch, w, h, gray) {
    const n = w * h, out = new Uint8ClampedArray(n * 4);
    const R = ch[0], G = gray ? ch[0] : ch[1], B = gray ? ch[0] : ch[2], A = ch[-1];
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        out[o] = R ? R[i] : 0; out[o + 1] = G ? G[i] : 0; out[o + 2] = B ? B[i] : 0; out[o + 3] = A ? A[i] : 255;
    }
    return out;
}

/** A mask channel whose rectangle is empty: the mask is its default colour everywhere. */
const EMPTY = new Uint8Array(0);

/**
 * A layer's mask record (at least 20 bytes, `r` at its start, `end` its end): the rectangle, default colour and flags
 * of the user mask (flag bit 1: switched off). The mask parameters (flag bit 4: densities and feathers) are skipped; a
 * record of 36 bytes or more then holds the "real" flags, default colour and rectangle, which channel -3 (the user
 * mask Photoshop writes beside a vector mask) is read at.
 */
function maskRecord(r, end) {
    const m = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), def: r.u8(), flags: r.u8() };
    if (m.flags & 16 && r.p < end) {
        const params = r.u8();
        r.p = Math.min(end, r.p + (params & 1 ? 1 : 0) + (params & 2 ? 8 : 0) + (params & 4 ? 1 : 0) + (params & 8 ? 8 : 0));
    }
    if (end - r.p >= 18) m.real = { flags: r.u8(), def: r.u8(), top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32() };
    return m;
}

/** The rectangle, default colour and flags a mask channel (-2 or -3) goes with, or null when the layer has no record. */
function maskFor(L, id) {
    if (!L.mask) return null;
    return id === -3 && L.mask.real ? L.mask.real : L.mask;
}

/**
 * A layer's user mask at the layer's own size (channel -2, else -3), or null: `{ data, defaultColor, disabled }`, `data`
 * w * h bytes (255 = visible) holding the mask where its rectangle covers a pixel of the layer and the default colour
 * where it does not.
 */
function layerMask(L, w, h) {
    const id = L.ch[-2] ? -2 : L.ch[-3] ? -3 : 0;
    if (!id) return null;
    const m = maskFor(L, id), src = L.ch[id];
    const data = new Uint8Array(w * h).fill(m.def);
    if (src !== EMPTY) {
        const mw = m.right - m.left;
        // the columns and rows of the layer that the mask's rectangle covers
        const x0 = Math.max(0, m.left - L.left), x1 = Math.min(w, m.right - L.left);
        const y0 = Math.max(0, m.top - L.top), y1 = Math.min(h, m.bottom - L.top);
        if (x1 > x0) {
            for (let y = y0; y < y1; y++) {
                const s = (L.top + y - m.top) * mw + (L.left + x0 - m.left);
                data.set(src.subarray(s, s + x1 - x0), y * w + x0);
            }
        }
    }
    return { data, defaultColor: m.def, disabled: !!(m.flags & 2) };
}

function listNames(names, max = 6) {
    const shown = names.slice(0, max).map((n) => `"${n}"`).join(", ");
    return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/**
 * The window's reader. `onHeader({ width, height, depth, mode, channels })` (optional) once the header is accepted and
 * before anything else is read or made: the caller's size check (H1 S5: the window checks the document's size there,
 * as the pool route does from the header's bytes before its job).
 */
export async function readPsd(input, { inflate = null, onHeader = null } = {}) {
    return decodePsd(input, inflate, null, onHeader);
}

/**
 * The worker's reader (the pool job `psd_read`, docs/PLAN_WASM_BUILD.md §7 D0): readPsd's parse, but each layer's pixels
 * go out as soon as its channels are read, `rowsPerBand` rows at a time, and its channels are dropped, so one layer's
 * planes are held at a time. `onHeader({ width, height, depth, mode, channels })` once the header is accepted; then
 * `onRows(index, kind, rgba, w, h, y0, rows)` per band, a layer's "rgba" bands (readPsd's `rgba` rows) before its "mask"
 * bands (the mask as white with the mask as alpha: what the editor's Mask is made from); `index` the layer's number in
 * the stream. The answer is readPsd's with `index` in place of a layer's `rgba` and its `mask` without `data`; the
 * merged picture is read only when no layer has pixels (the one case the editor shows it), `composite` then its index,
 * else null. `spent` (optional) gets the milliseconds of channels (the reads and unpacks), interleave, mask, deliver
 * (inside `onRows`), wait (awaiting the promises `onRows` returned) and the count of bands. An `onRows` that returns a
 * promise holds the next band back until it settles (the pool job's acknowledgement window, K20b review).
 */
export async function readPsdStream(input, { inflate = null, rowsPerBand = 256, onHeader = null, onRows = null, spent = null, kernels = null } = {}) {
    if (typeof onRows !== "function") throw new Error("readPsdStream needs onRows");
    const sp = Object.assign(spent || {}, { channels: 0, interleave: 0, mask: 0, deliver: 0, wait: 0, bands: 0 });
    return decodePsd(input, inflate, { rows: Math.max(1, rowsPerBand | 0), onHeader, onRows, sp, next: 0, kernels: kernels || PSD_JS });
}

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Validate one channel record upfront for `readPsdStream` (`docs/PLAN_WASM_K20.md` §2.1) with the exact checks and
 * refusal messages of `readChannel`. When `keep` is true, returns a lightweight descriptor over the channel's bytes
 * without allocating an unpacked plane (`comp === 0 || 1`) or mutating inflated bytes (`comp === 2 || 3`).
 */
async function prepareChannel(r, compression, w, h, depth, dataLen, inflate, what, keep) {
    const bpc = depth / 8, rowBytes = w * bpc, size = w * h * bpc;
    if (compression === 0) {
        if (dataLen < size) throw tooShort(what, w, h);
        r.need(size);
        return keep ? { comp: 0, bytes: r.b, at: r.p, cw: w, chh: h, rowBytes } : null;
    }
    if (compression === 1) {
        if (2 * h > dataLen) throw tooShort(what, w, h);
        r.need(2 * h);
        const lensAt = r.p, b = r.b;
        const rowOff = keep ? new Uint32Array(h + 1) : null;
        let total = 0;
        for (let y = 0; y < h; y++) {
            total += (b[lensAt + 2 * y] << 8) | b[lensAt + 2 * y + 1];
            if (rowOff) rowOff[y + 1] = total;
        }
        r.p = lensAt + 2 * h;
        r.need(total);
        if (total < packedAtLeast(h, rowBytes) || 2 * h + total > dataLen) throw tooShort(what, w, h);
        if (!keep) return null;
        return {
            comp: 1,
            lensBytes: b.subarray(lensAt, lensAt + 2 * h),
            bytes: b,
            dataAt: lensAt + 2 * h,
            rowOff,
            cw: w,
            chh: h,
            rowBytes,
        };
    }
    if (compression === 2 || compression === 3) {
        if (!inflate) throw new Error("a ZIP-compressed PSD channel needs an inflater");
        r.need(dataLen);
        if (size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);
        const bomb = () => new Error(`a ZIP channel of ${what} unpacks to more than its ${sizeText(w, h)}: the file is damaged`);
        let raw;
        try { raw = await inflate(r.bytes(dataLen), size); } catch (err) { throw err && err.tooLarge ? bomb() : err; }
        if (raw.length > size) throw bomb();
        if (!keep) return null;
        let buf;
        if (raw.length === size) buf = raw;
        else { buf = new Uint8Array(size); buf.set(raw); }
        return { comp: compression, bytes: buf, at: 0, cw: w, chh: h, rowBytes };
    }
    throw new Error(`unknown PSD compression ${compression}`);
}

/** Unpack rows `[y0, y0 + bandRows)` of a validated channel descriptor without mutating `d.bytes`. */
function unpackBandDesc(d, y0, bandRows, depth) {
    if (!d) return null;
    const planeBytes = bandRows * d.rowBytes;
    if (d.comp === 1) {
        const out = new Uint8Array(planeBytes);
        const s0 = d.dataAt + d.rowOff[y0], s1 = Math.min(d.bytes.length, d.dataAt + d.rowOff[y0 + bandRows]);
        const packed = s0 < s1 ? d.bytes.subarray(s0, s1) : EMPTY;
        packbitsRows(d.lensBytes.subarray(2 * y0, 2 * (y0 + bandRows)), packed, bandRows, d.rowBytes, out);
        return out;
    }
    const off = d.at + y0 * d.rowBytes;
    if (d.comp === 3) {
        const out = d.bytes.slice(off, off + planeBytes);
        unpredict(out, d.cw, bandRows, depth);
        return out;
    }
    return d.bytes.subarray(off, off + planeBytes);
}

/**
 * Materialise and interleave one `rows`-row colour/alpha band `[y0, y0 + rows)` into `Uint8ClampedArray(rows * w * 4)`
 * (`PSD_JS.bandRgba`, JS twin of `Px.prototype.psdBandRgba`, K20b).
 */
export function psdBandRgba(descs, w, y0, rows, depth, gray, spent = null) {
    const t0 = spent ? clock() : 0;
    const R = unpackBandDesc(descs[0], y0, rows, depth);
    const G = gray ? R : unpackBandDesc(descs[1], y0, rows, depth);
    const B = gray ? R : unpackBandDesc(descs[2], y0, rows, depth);
    const A = unpackBandDesc(descs["-1"], y0, rows, depth);
    const t1 = spent ? clock() : 0;
    if (spent) spent.channels += t1 - t0;
    const n = rows * w, out = new Uint8ClampedArray(n * 4);
    if (depth === 8) {
        for (let i = 0, o = 0; i < n; i++, o += 4) {
            out[o] = R ? R[i] : 0;
            out[o + 1] = G ? G[i] : 0;
            out[o + 2] = B ? B[i] : 0;
            out[o + 3] = A ? A[i] : 255;
        }
    } else {
        for (let i = 0, s = 0, o = 0; i < n; i++, s += 2, o += 4) {
            out[o] = R ? (((R[s] << 8) | R[s + 1]) * 255 + 32895) >>> 16 : 0;
            out[o + 1] = G ? (((G[s] << 8) | G[s + 1]) * 255 + 32895) >>> 16 : 0;
            out[o + 2] = B ? (((B[s] << 8) | B[s + 1]) * 255 + 32895) >>> 16 : 0;
            out[o + 3] = A ? (((A[s] << 8) | A[s + 1]) * 255 + 32895) >>> 16 : 255;
        }
    }
    if (spent) spent.interleave += clock() - t1;
    return out;
}

/**
 * Materialise and place one `rows`-row mask band `[y0, y0 + rows)` into `Uint8ClampedArray(rows * w * 4)` as
 * `[255, 255, 255, alpha]` (`PSD_JS.bandMask`, JS twin of `Px.prototype.psdBandMask`, K20b).
 */
export function psdBandMask(desc, L, m, w, h, y0, rows, depth, spent = null) {
    const t0 = spent ? clock() : 0;
    const x0 = Math.min(w, Math.max(0, m.left - L.left));
    const x1 = Math.max(x0, Math.min(w, m.right - L.left));
    const gy0 = Math.min(h, Math.max(0, m.top - L.top));
    const gy1 = Math.max(gy0, Math.min(h, m.bottom - L.top));
    const ry0 = Math.min(rows, Math.max(0, gy0 - y0));
    const ry1 = Math.max(ry0, Math.min(rows, gy1 - y0));
    let out;
    if (!desc || desc.kind === "empty" || !(x1 > x0 && ry1 > ry0)) {
        out = psdMaskRgba(null, 0, 0, w, rows, 0, 0, 0, 0, 8, m.def & 255);
    } else {
        const mRows = ry1 - ry0;
        const my0 = L.top + y0 + ry0 - m.top;
        const sx0 = L.left + x0 - m.left;
        const plane = unpackBandDesc(desc, my0, mRows, depth);
        out = psdMaskRgba(plane, desc.cw, sx0, w, rows, x0, x1, ry0, ry1, depth, m.def & 255);
    }
    if (spent) spent.mask += clock() - t0;
    return out;
}

export const PSD_JS = Object.freeze({
    packbitsRows,
    maskRgba: psdMaskRgba,
    bandRgba: psdBandRgba,
    bandMask: psdBandMask,
});

/**
 * Stream one layer's (or merged picture's) validated channel descriptors band-by-band through `stream.kernels`. An
 * `onRows` that returns a promise (the worker's acknowledgement window, inpaint_worker.js `psdRead`) is awaited before
 * the next band is made; its wait goes into `spent.wait`, not `deliver`.
 */
async function streamChannelDescs(stream, descs, w, h, depth, gray, maskDesc = null, L = null, m = null) {
    const index = stream.next++, per = stream.rows, sp = stream.sp, K = stream.kernels;
    const send = async (kind, out, y0, n) => {
        const t = clock();
        const paced = stream.onRows(index, kind, out, w, h, y0, n);
        const t1 = clock();
        sp.deliver += t1 - t;
        sp.bands++;
        if (paced && typeof paced.then === "function") { await paced; sp.wait += clock() - t1; }
    };
    for (let y0 = 0; y0 < h; y0 += per) {
        const n = Math.min(per, h - y0);
        await send("rgba", K.bandRgba(descs, w, y0, n, depth, gray, sp), y0, n);
    }
    if (m) {
        for (let y0 = 0; y0 < h; y0 += per) {
            const n = Math.min(per, h - y0);
            await send("mask", K.bandMask(maskDesc, L, m, w, h, y0, n, depth, sp), y0, n);
        }
    }
    return index;
}

/** Validate the merged picture's channels upfront for `readPsdStream`, matching `mergedPlanes` (`docs/PLAN_WASM_K20.md` §2.1). */
function mergedChannelDescs(r, bytes, width, height, channels, depth, gray) {
    if (r.p + 2 > bytes.length) return null;
    const comp = r.u16();
    const n = Math.min(channels, gray ? 2 : 4);
    if (n <= 0) return null;
    const bpc = depth / 8, rowBytes = width * bpc;
    const descs = [];
    if (comp === 1) {
        r.need(2 * height * channels);
        const tableAt = r.p;
        r.skip(2 * height * channels);
        let curAt = r.p;
        for (let c = 0; c < n; c++) {
            const lensAt = tableAt + c * 2 * height;
            const rowOff = new Uint32Array(height + 1);
            let total = 0;
            for (let y = 0; y < height; y++) {
                total += (bytes[lensAt + 2 * y] << 8) | bytes[lensAt + 2 * y + 1];
                rowOff[y + 1] = total;
            }
            if (total < packedAtLeast(height, rowBytes)) {
                const err = new Error(`the PSD's merged picture holds less data than its ${sizeText(width, height)} need: the file is damaged`);
                err.refused = true;
                throw err;
            }
            descs.push({
                comp: 1,
                lensBytes: bytes.subarray(lensAt, lensAt + 2 * height),
                bytes,
                dataAt: curAt,
                rowOff,
                cw: width,
                chh: height,
                rowBytes,
            });
            curAt += total;
        }
        r.p = curAt;
    } else if (comp === 0) {
        const size = width * height * bpc;
        for (let c = 0; c < n; c++) {
            const at = r.p;
            r.skip(size);
            descs.push({ comp: 0, bytes, at, cw: width, chh: height, rowBytes });
        }
    } else {
        return null;
    }
    return gray
        ? { 0: descs[0], "-1": descs[1] || null }
        : { 0: descs[0], 1: descs[1] || null, 2: descs[2] || null, "-1": descs[3] || null };
}

/**
 * The merged picture's channels at 8 bits (`{ 0, 1, 2, -1 }`, gray `{ 0, -1 }`) from `r` at the section's start, or null
 * when the file has none it can read; a damaged one throws (the caller drops it).
 */
function mergedPlanes(r, bytes, width, height, channels, depth, gray) {
    if (r.p + 2 > bytes.length) return null;
    const comp = r.u16();
    const planes = {};
    const n = Math.min(channels, gray ? 2 : 4);
    if (comp === 1) {
        // the row lengths of every channel are there; only the first n channels' are read (their rows come first), and
        // a channel whose rows cannot unpack to the picture is not made (H1 S5)
        const rowBytes = width * depth / 8;
        r.need(2 * height * channels);
        const lens = new Uint16Array(height * n);
        for (let i = 0; i < lens.length; i++) lens[i] = r.u16();
        r.skip(2 * height * (channels - n));
        for (let c = 0; c < n; c++) {
            const rowLens = lens.subarray(c * height, (c + 1) * height);
            let total = 0;
            for (let y = 0; y < rowLens.length; y++) total += rowLens[y];
            if (total < packedAtLeast(height, rowBytes)) {
                // refused, not dropped quietly: a file without layers then has nothing to open (decodePsd throws it)
                const err = new Error(`the PSD's merged picture holds less data than its ${sizeText(width, height)} need: the file is damaged`);
                err.refused = true;
                throw err;
            }
            const out = new Uint8Array(width * height * depth / 8);
            r.p = unpackRows(bytes, r.p, rowLens, rowBytes, out);
            planes[c] = out;
        }
    } else if (comp === 0) {
        for (let c = 0; c < n; c++) planes[c] = r.bytes(width * height * depth / 8).slice();
    }
    if (!planes[0]) return null;
    const to8 = (p) => { if (!p || depth === 8) return p; const o = new Uint8Array(width * height); for (let i = 0; i < o.length; i++) o[i] = Math.round(((p[2 * i] << 8) | p[2 * i + 1]) / 257); return o; };
    return gray ? { 0: to8(planes[0]), "-1": to8(planes[1]) } : { 0: to8(planes[0]), 1: to8(planes[1]), 2: to8(planes[2]), "-1": to8(planes[3]) };
}

/** readPsd (`stream` null) and readPsdStream (`stream` its state) on one parse. */
async function decodePsd(input, inflate, stream, onHeader = null) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const r = new Reader(bytes);
    if (r.ascii(4) !== "8BPS") throw new Error("not a PSD file");
    const version = r.u16();
    if (version === 2) throw new Error("this is a PSB (Photoshop's large document format), which is not read; save it as PSD (at most 30,000 px a side)");
    if (version !== 1) throw new Error(`unknown PSD version ${version}`);
    r.skip(6);
    const channels = r.u16(), height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
    if (mode !== 3 && mode !== 1) throw new Error(`this PSD is in ${PSD_MODES[mode] || "mode " + mode} colour; only RGB and grayscale are read (convert it in Photoshop: Image > Mode > RGB)`);
    if (depth !== 8 && depth !== 16) throw new Error(`this PSD has ${depth} bits per channel; only 8 and 16 are read`);
    if (stream && stream.onHeader) stream.onHeader({ width, height, depth, mode, channels });
    if (onHeader) onHeader({ width, height, depth, mode, channels });
    const gray = mode === 1;
    r.skip(r.u32());   // colour mode data
    r.skip(r.u32());   // image resources
    const notes = [];
    const lmLen = r.u32();
    const lmEnd = r.p + lmLen;
    const records = [];
    if (lmLen > 0) {
        const liLen = r.u32();
        const liEnd = r.p + liLen;
        if (liLen > 0) {
            const count = Math.abs(r.i16());
            for (let i = 0; i < count; i++) {
                const L = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), channels: [] };
                const nch = r.u16();
                for (let c = 0; c < nch; c++) L.channels.push({ id: r.i16(), len: r.u32() });
                if (r.ascii(4) !== "8BIM") throw new Error("a PSD layer record is damaged");
                L.blendKey = r.ascii(4);
                L.opacity = r.u8() / 255;
                L.clipping = r.u8();
                L.flags = r.u8();
                r.skip(1);
                const extraLen = r.u32();
                const extraEnd = r.p + extraLen;
                const maskLen = r.u32();
                const maskEnd = r.p + maskLen;
                if (maskLen >= 20) L.mask = maskRecord(r, maskEnd);
                r.p = maskEnd;
                r.skip(r.u32());   // blending ranges
                L.name = pascalName(r, 4);
                L.info = additionalInfo(r, extraEnd);
                r.p = extraEnd;
                L.name = unicodeName(L.info.luni) || L.name;
                L.section = sectionType(L.info.lsct || L.info.lsdk);
                if (L.section === 1 || L.section === 2) L.groupBlend = sectionBlend(L.info.lsct || L.info.lsdk) || L.blendKey;
                records.push(L);
            }
            // channel image data, in record order
            for (const L of records) {
                const w = L.right - L.left, h = L.bottom - L.top;
                L.ch = {};
                if (!stream) {
                    for (const c of L.channels) {
                        const end = r.p + c.len;
                        const isMask = c.id === -2 || c.id === -3;
                        const m = isMask ? maskFor(L, c.id) : null;
                        if (isMask && !m) { r.p = end; continue; }   // a mask channel without its record
                        const cw = m ? m.right - m.left : w, chh = m ? m.bottom - m.top : h;
                        if (m && !(cw > 0 && chh > 0)) { L.ch[c.id] = EMPTY; r.p = end; continue; }   // an empty rectangle: the default colour everywhere
                        if (c.len < 2) { r.p = end; continue; }
                        const comp = r.u16();
                        if (cw > 0 && chh > 0) {
                            const what = `the PSD layer "${String(L.name).slice(0, 60)}"${isMask ? "'s mask" : ""}`;
                            checkRect(what, cw, chh);
                            L.ch[c.id] = await readChannel(r, comp, cw, chh, depth, c.len - 2, inflate, what);
                        }
                        r.p = end;
                    }
                } else {
                    const wantPixels = L.section !== 1 && L.section !== 2 && L.section !== 3
                        && !Object.keys(L.info).some((k) => ADJUSTMENTS.has(k))
                        && w > 0 && h > 0
                        && L.channels.some((c) => c.id === 0 && c.len >= 2);
                    const hasMaskCh = (mid) => {
                        const m = maskFor(L, mid);
                        if (!m) return false;
                        const mw = m.right - m.left, mh = m.bottom - m.top;
                        return L.channels.some((c) => c.id === mid && (!(mw > 0 && mh > 0) || c.len >= 2));
                    };
                    const activeMaskId = wantPixels ? (hasMaskCh(-2) ? -2 : hasMaskCh(-3) ? -3 : 0) : 0;
                    const descs = {};
                    const t0 = clock();
                    for (const c of L.channels) {
                        const end = r.p + c.len;
                        const isMask = c.id === -2 || c.id === -3;
                        const m = isMask ? maskFor(L, c.id) : null;
                        if (isMask && !m) { r.p = end; continue; }
                        const cw = m ? m.right - m.left : w, chh = m ? m.bottom - m.top : h;
                        if (m && !(cw > 0 && chh > 0)) {
                            if (c.id === activeMaskId) descs[c.id] = { kind: "empty" };
                            r.p = end;
                            continue;
                        }
                        if (c.len < 2) { r.p = end; continue; }
                        const comp = r.u16();
                        if (cw > 0 && chh > 0) {
                            const what = `the PSD layer "${String(L.name).slice(0, 60)}"${isMask ? "'s mask" : ""}`;
                            checkRect(what, cw, chh);
                            const keep = wantPixels && (c.id === 0 || c.id === -1 || (!gray && (c.id === 1 || c.id === 2)) || c.id === activeMaskId);
                            const d = await prepareChannel(r, comp, cw, chh, depth, c.len - 2, inflate, what, keep);
                            if (d) descs[c.id] = d;
                        }
                        r.p = end;
                    }
                    stream.sp.channels += clock() - t0;
                    if (wantPixels && descs[0]) {
                        const m = activeMaskId ? maskFor(L, activeMaskId) : null;
                        const index = await streamChannelDescs(stream, descs, w, h, depth, gray, activeMaskId ? descs[activeMaskId] : null, L, m);
                        L.streamed = { index, mask: m ? { defaultColor: m.def, disabled: !!(m.flags & 2) } : null };
                        L.ch = { 0: EMPTY };
                    } else {
                        L.ch = {};
                    }
                }
            }
        }
        r.p = liEnd;
    }
    r.p = lmEnd;
    // the merged picture (the stream reads it after the layers, and only when none has pixels)
    let composite = null, mergedRefused = null;
    if (!stream) {
        try {
            const ch = mergedPlanes(r, bytes, width, height, channels, depth, gray);
            if (ch) composite = interleave(ch, width, height, gray);
        } catch (err) { composite = null; if (err && err.refused) mergedRefused = err; }
    }
    // records are bottom first; groups are a bounding divider (3) below their layers and a folder record (1 / 2) above.
    // A group comes back as a folder (PLAN_0_1_31 §6.5): `groups` [{ id, name, visible, collapsed, parent }], a layer's
    // `group` its innermost; a folder has no opacity or blend of its own here, so a group's opacity goes into its layers
    const layers = [], groups = [];
    const stack = [];   // the groups open at this record, innermost last: { id, parent, from }
    const adjust = [], empty = [], clipped = [], blends = [], groupBlends = [];
    let masks = 0, masksOff = 0, clips = 0, faded = 0, fillOpa = 0;
    // a clipped record is clipped to the nearest record below it that is not clipped (PLAN_0_1_31 §6 step 3): kept when
    // that base became a layer here; a group (flattened into its layers) or a left-out layer as the base drops the clip
    let baseKept = false;
    for (const L of records) {
        if (L.section === 3) {   // a group's bounding divider, below its layers
            stack.push({ id: "g" + (groups.length + stack.length + 1), parent: stack.length ? stack[stack.length - 1].id : null, from: layers.length });
            baseKept = false;
            continue;
        }
        if (L.section === 1 || L.section === 2) {
            baseKept = false;
            // the folder record above them: every layer since its divider is in it
            const g = stack.pop();
            if (!g) continue;   // a folder without its divider
            if (L.opacity < 1) { faded++; for (let i = g.from; i < layers.length; i++) layers[i].opacity *= L.opacity; }
            const gb = String(L.groupBlend || "pass");
            if (gb !== "pass" && gb !== "norm") groupBlends.push(`${L.name || "Group"} (${gb.trim()})`);
            groups.push({ id: g.id, name: L.name || "Group", visible: !(L.flags & 2), collapsed: L.section === 2, parent: g.parent });
            continue;
        }
        const w = L.right - L.left, h = L.bottom - L.top;
        if (Object.keys(L.info).some((k) => ADJUSTMENTS.has(k))) { adjust.push(L.name); if (!L.clipping) baseKept = false; continue; }
        if (!(w > 0 && h > 0) || !L.ch[0]) { if (L.name) empty.push(L.name); if (!L.clipping) baseKept = false; continue; }
        if (L.info && L.info.iOpa && L.info.iOpa.length > 0 && L.info.iOpa[0] < 255) fillOpa++;
        if (stream && !L.streamed) throw new Error(`readPsdStream: the pixels of layer "${L.name}" were not sent`);
        const rgba = stream ? null : interleave(L.ch, w, h, gray);
        const mask = stream ? L.streamed.mask : layerMask(L, w, h);
        if (mask) { masks++; if (mask.disabled) masksOff++; }
        let blend = PSD_BLENDS[L.blendKey];
        if (!blend) { blends.push(`${L.name} (${L.blendKey.trim()})`); blend = "normal"; }
        const clip = !!L.clipping && baseKept;
        if (L.clipping && !clip) clipped.push(L.name);
        if (clip) clips++;
        if (!L.clipping) baseKept = true;
        const layer = { name: L.name || "Layer", x: L.left, y: L.top, w, h, opacity: L.opacity, visible: !(L.flags & 2), blend, rgba, group: stack.length ? stack[stack.length - 1].id : null };
        if (stream) { delete layer.rgba; layer.index = L.streamed.index; }
        if (clip) layer.clip = true;
        if (mask) layer.mask = mask;
        layers.push(layer);
    }
    if (stream && !layers.length && width > 0 && height > 0) {   // a header of no area has no merged picture to send
        r.p = lmEnd;
        let descs = null;
        const t0 = clock();
        try { descs = mergedChannelDescs(r, bytes, width, height, channels, depth, gray); } catch (err) { descs = null; if (err && err.refused) mergedRefused = err; }
        stream.sp.channels += clock() - t0;
        if (descs) composite = await streamChannelDescs(stream, descs, width, height, depth, gray);
    }
    // a file whose only picture is a merged picture too short for its size is refused (both readers alike)
    if (!layers.length && mergedRefused) throw mergedRefused;
    const hasComposite = composite != null;
    if (adjust.length) notes.push(`${adjust.length} adjustment or fill layer${adjust.length > 1 ? "s" : ""} left out (${listNames(adjust)}): the picture can look different`);
    if (clips) notes.push(`${clips} clipped layer${clips > 1 ? "s" : ""} kept clipped`);
    if (clipped.length) notes.push(`clipping to a group or a left-out layer is not kept (${listNames(clipped)} now cover${clipped.length > 1 ? "" : "s"} more)`);
    if (blends.length) notes.push(`blend modes the editor lacks became normal: ${listNames(blends)}`);
    if (masks === 1) notes.push(`1 layer mask kept as a mask${masksOff ? " (switched off)" : ""}`);
    else if (masks > 1) notes.push(`${masks} layer masks kept as masks${masksOff ? ` (${masksOff === masks ? "all" : masksOff} switched off)` : ""}`);
    if (groups.length) notes.push(`${groups.length} group${groups.length > 1 ? "s" : ""} kept as folder${groups.length > 1 ? "s" : ""}`);
    if (faded) notes.push(`the opacity of ${faded} group${faded > 1 ? "s" : ""} went into ${faded > 1 ? "their" : "its"} layers`);
    if (groupBlends.length) notes.push(`groups are folders here, their blend modes became pass through: ${listNames(groupBlends)}`);
    if (fillOpa) notes.push(`fill opacity below 100 % read as 100 % (${fillOpa} layer${fillOpa > 1 ? "s" : ""})`);
    if (depth === 16) notes.push("16 bits per channel rounded to 8");
    if (empty.length && !layers.length && !hasComposite) notes.push("no layer has pixels");
    // a note that says something was lost or changed (not one that says what was kept): the status line shows it red
    const lossy = !!(adjust.length || clipped.length || blends.length || groupBlends.length || fillOpa || depth === 16 || (empty.length && !layers.length && !hasComposite));
    return { width, height, layers, groups, composite, notes, lossy };
}

// ---- OpenRaster -------------------------------------------------------------------------

/**
 * The entries of a zip: { name: { method, data, size } } from the central directory, `size` the entry's uncompressed
 * size as the directory gives it (what a deflated entry may unpack to). A map without a prototype, so an entry named
 * "__proto__" or "constructor" is an entry like any other.
 */
function unzip(bytes) {
    const { count, p } = zipEnd(bytes);
    const zip = zipDirectory(bytes, p, count, bytes.length);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const name in zip) {
        const e = zip[name];
        const at = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
        e.data = bytes.subarray(at, at + e.csize);
    }
    return zip;
}

/** Where a zip's directory is (`{ count, p }`, `p` its offset in the file), from the file's last 65,557 bytes or more. */
function zipEnd(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (v.getUint32(i, true) === 0x06054b50) return { count: v.getUint16(i + 10, true), p: v.getUint32(i + 16, true) };
    }
    throw new Error("the ORA file is not a complete zip");
}

/**
 * The directory's `count` records from offset `p` of `bytes`: { name: { method, csize, size, local } }. `bytes` holds
 * at least the directory and may be a slice of the file (`fileSize` is the whole file's); the record count decides
 * where it ends, the end record's byte count is not used. Every record's local header has to lie inside the file, an
 * entry that is never read too.
 */
function zipDirectory(bytes, p, count, fileSize) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = Object.create(null);
    for (let i = 0; i < count; i++) {
        if (v.getUint32(p, true) !== 0x02014b50) throw new Error("the ORA file's zip directory is damaged");
        const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
        const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
        const local = v.getUint32(p + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
        if (local + 30 > fileSize) throw new Error("the ORA file's zip directory is damaged");
        out[name] = { method, csize, size, local };
        p += 46 + nameLen + extra + comment;
    }
    return out;
}

/** A PNG's size from its IHDR (`{ w, h }`), or null when the bytes are no PNG (the decoder says why later). */
function pngSize(png) {
    if (!png || png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
    const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (v.getUint32(12) !== 0x49484452) return null;   // "IHDR"
    return { w: v.getUint32(16), h: v.getUint32(20) };
}

const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
    if (!m) return null;
    return (m[2] != null ? m[2] : m[3]).replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
};

/**
 * `onHeader({ width, height })` (optional) once stack.xml gave the size and before any layer's picture is read: the
 * caller's size check (H1 S5). A deflated entry unpacks to at most the size the zip's directory gives it (more is
 * refused), stack.xml to 16 MB, and all deflated entries together to 256 MB plus 64 times the file; a layer whose PNG
 * says it is larger than a layer can be is refused before it is decoded.
 */
export async function readOra(input, { inflateRaw = null, onHeader = null } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return oraFromEntries(bytes.length, unzip(bytes), {
        whole: (e) => e.data,
        picture: (e) => e.data,
        head: (png) => png,
        keep: (png) => ({ png }),
    }, inflateRaw, onHeader);
}

/**
 * K20c: `readOra` for a file that stays a Blob: what it answers, but each layer with `pngBlob` in place of `png` (a
 * slice of the file for a stored entry, no copy of it; a Blob of the unpacked bytes for a deflated one). The last
 * 65,557 bytes, the directory, stack.xml and 24 bytes of each layer are all that is read here: not the merged
 * picture, the thumbnail or a stored layer's pixels. Every input gives what `readOra` gives, its refusals word for word:
 * `Blob.slice` clamps as `subarray` does, so an entry the directory says runs past the file ends at the file here too.
 */
export async function readOraBlob(blob, { inflateRaw = null, onHeader = null } = {}) {
    const read = async (part) => new Uint8Array(await part.arrayBuffer());
    const tail = await read(blob.slice(Math.max(0, blob.size - 65557)));
    const { count, p } = zipEnd(tail);
    const zip = zipDirectory(await read(blob.slice(p)), 0, count, blob.size);   // from `p` on: the directory and the end record
    const place = async (e) => {
        if (e.blob) return e.blob;
        const local = new DataView(await blob.slice(e.local, e.local + 30).arrayBuffer());
        const at = e.local + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        e.blob = blob.slice(at, at + e.csize, "image/png");
        return e.blob;
    };
    const heads = new Map();   // a stack.xml may name one entry many times
    return oraFromEntries(blob.size, zip, {
        whole: async (e) => read(await place(e)),
        picture: place,
        head: async (png) => {
            if (png instanceof Uint8Array) return png;   // unpacked here
            if (!heads.has(png)) heads.set(png, await read(png.slice(0, 24)));
            return heads.get(png);
        },
        keep: (png) => ({ pngBlob: png instanceof Uint8Array ? new Blob([png], { type: "image/png" }) : png }),
    }, inflateRaw, onHeader);
}

/**
 * The reader behind `readOra` and `readOraBlob`: stack.xml and the layers, every limit and refusal once. `from` says how
 * an entry is had: `whole(e)` its stored bytes, `picture(e)` a stored layer's PNG as the reader keeps it, `head(png)` at
 * least the first 24 bytes of that or of an unpacked one, `keep(png)` the layer's field for it.
 */
async function oraFromEntries(fileSize, zip, from, inflateRaw, onHeader) {
    const budget = ORA_INFLATE_BASE + ORA_INFLATE_RATIO * fileSize;
    let unpacked = 0;
    const get = async (name, stored) => {
        const e = zip[name];
        if (!e) return null;
        if (e.method === 0) return stored(e);
        if (e.method === 8) {
            if (!inflateRaw) throw new Error("a deflated ORA entry needs an inflater");
            const label = String(name).slice(0, 80);
            if (name === "stack.xml" && e.size > ORA_XML_MAX) throw new Error(`the ORA file's stack.xml unpacks to ${mbText(e.size)}, more than a stack.xml can be (${mbText(ORA_XML_MAX)}): the file is damaged`);
            if (unpacked + e.size > budget) throw new Error(`the ORA file's entries unpack to more than ${mbText(budget)} (at ${label}), far more than its ${mbText(fileSize)} can hold: the file is damaged or not an image`);
            unpacked += e.size;
            const bomb = () => new Error(`the ORA entry ${label} unpacks to more than the ${e.size.toLocaleString("en-US")} bytes its zip directory gives: the file is damaged`);
            let raw;
            try { raw = await inflateRaw(await from.whole(e), e.size); } catch (err) { throw err && err.tooLarge ? bomb() : err; }
            if (raw.length > e.size) throw bomb();
            return raw;
        }
        throw new Error(`unknown zip method ${e.method} for ${name}`);
    };
    const xmlBytes = await get("stack.xml", from.whole);
    if (!xmlBytes) throw new Error("the ORA file has no stack.xml");
    const xml = new TextDecoder().decode(xmlBytes);
    const img = /<image\b[^>]*>/.exec(xml);
    if (!img) throw new Error("the ORA stack.xml has no <image>");
    const width = Math.round(+attr(img[0], "w")), height = Math.round(+attr(img[0], "h"));
    if (!(width > 0 && height > 0)) throw new Error("the ORA image has no size");
    if (onHeader) onHeader({ width, height });
    const pixelBudget = Math.max(ORA_PIXELS_BASE, ORA_PIXELS_PER_PICTURE * width * height);
    let pixels = 0;
    const notes = [];
    const found = [];   // top first
    const blends = [], missing = [];
    let grouped = 0;
    const groups = [];   // open stacks (the outermost <stack> is the image itself)
    const re = /<(\/?)(stack|layer)\b([^>]*?)(\/?)>/g;
    let m, level = 0;
    while ((m = re.exec(xml))) {
        const [, close, kind, body, selfClose] = m;
        const tag = " " + body;
        if (kind === "stack") {
            if (close) { groups.pop(); level--; continue; }
            level++;
            const g = { visible: attr(tag, "visibility") !== "hidden", opacity: attr(tag, "opacity") != null ? +attr(tag, "opacity") : 1, x: +(attr(tag, "x") || 0), y: +(attr(tag, "y") || 0) };
            if (level > 1) grouped++;
            if (selfClose) { level--; continue; }
            groups.push(g);
            continue;
        }
        if (close) continue;
        const src = attr(tag, "src");
        const name = attr(tag, "name") || "Layer";
        let visible = attr(tag, "visibility") !== "hidden", opacity = attr(tag, "opacity") != null ? +attr(tag, "opacity") : 1;
        let x = +(attr(tag, "x") || 0), y = +(attr(tag, "y") || 0);
        for (const g of groups) { if (!g.visible) visible = false; opacity *= g.opacity; x += g.x; y += g.y; }
        const op = attr(tag, "composite-op") || "svg:src-over";
        let blend = ORA_BLENDS[op];
        if (!blend) { blends.push(`${name} (${op})`); blend = "normal"; }
        const png = src ? await get(src, from.picture) : null;
        if (!png) { missing.push(name); continue; }
        const size = pngSize(await from.head(png));
        if (size) {
            const label = `the ORA layer "${String(name).slice(0, 60)}"`;
            checkRect(label, size.w, size.h, ORA_LAYER_MAX_PIXELS);
            pixels += size.w * size.h;
            if (pixels > pixelBudget) throw new Error(`the ORA file's layers add up to more than ${Math.round(pixelBudget / 1e6).toLocaleString("en-US")} MP at ${label}, more than the layers of a ${sizeText(width, height)} picture can be: the file is damaged`);
        }
        found.push({ name, x: Math.round(x), y: Math.round(y), opacity: Math.max(0, Math.min(1, opacity)), visible, blend, ...from.keep(png) });
    }
    if (blends.length) notes.push(`blend modes the editor lacks became normal: ${listNames(blends)}`);
    if (missing.length) notes.push(`${missing.length} layer${missing.length > 1 ? "s" : ""} without a picture left out (${listNames(missing)})`);
    if (grouped) notes.push(`${grouped} group${grouped > 1 ? "s" : ""} flattened into their layers`);
    return { width, height, layers: found.reverse(), notes, lossy: !!(blends.length || missing.length || grouped) };
}
