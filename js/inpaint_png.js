// Generated from DenRakEiw/scumble renderer/editor/inpaint_png.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * PNG files written in parts (docs/PLAN_BCE.md §E2): a picture never exists as one RGBA buffer or one canvas.
 *
 * A PNG's pixels are one zlib stream. `PngStreamWriter` cuts the picture into parts of whole rows, has each part
 * filtered and deflated by a worker (`png_part` in inpaint_worker.js: the Rust kernel ends every part but the last on
 * a sync flush, so parts compressed on any worker in any order are one deflate stream when written in order), and
 * joins them: signature, IHDR, the tEXt chunks, an IDAT with the two zlib header bytes, each part's IDAT as the
 * worker made it (length, type, data, CRC), an IDAT with the Adler-32 of all the filtered bytes (the parts' own sums
 * joined by `adlerCombine`), IEND. The file is a Blob of those pieces.
 *
 * A part's rows come either as bytes (`{ rgba, prev }`, a band the editor composited) or as the tiles that hold them
 * (`{ tiles, prevTiles }`, named by arena slot or as copies), which a worker reads where they lie.
 *
 * Without the Rust kernels in the workers a part fails with `NO_PARTS`, and the caller keeps its canvas path.
 */

import { pngUnfilterRows } from "./px/kernels.js";

export const PNG_LEVEL = 2;               // measured (E2): 84 MB/s a worker and 0.349 of the raw size; level 6 is 13 MB/s for 0.327
export const PART_BYTES = 8 * 1048576;    // raw bytes of a part: what one worker holds three times over while it runs
export const NO_PARTS = "png parts need the Rust kernels";

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();

/** CRC-32 of `bytes`, continued from `crc` (the value a former call returned). */
export function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A chunk: length, type, data, CRC over type and data. */
export function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

const BASE = 65521;

/** The Adler-32 of A followed by B from the sums of A (`a1`) and of B alone (`a2`), B being `len2` bytes (zlib's adler32_combine). */
export function adlerCombine(a1, a2, len2) {
    const rem = len2 % BASE;
    let sum1 = a1 & 0xFFFF;
    let sum2 = (rem * sum1) % BASE;
    sum1 += (a2 & 0xFFFF) + BASE - 1;
    sum2 += ((a1 >>> 16) & 0xFFFF) + ((a2 >>> 16) & 0xFFFF) + BASE - rem;
    if (sum1 >= BASE) sum1 -= BASE;
    if (sum1 >= BASE) sum1 -= BASE;
    if (sum2 >= BASE * 2) sum2 -= BASE * 2;
    if (sum2 >= BASE) sum2 -= BASE;
    return ((sum2 << 16) | sum1) >>> 0;
}

/** Rows of a part for a picture `width` wide: about PART_BYTES, at most `most` (a tile row), at least one. */
export function partRows(width, most = 256) {
    return Math.max(1, Math.min(most, Math.floor(PART_BYTES / (4 * Math.max(1, width)))));
}

/** JSON with every non-ASCII character escaped, so it fits a Latin-1 tEXt chunk unchanged. */
export function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * The `sRGB` chunk (rendering intent 0, perceptual) an exported PNG carries: its pixels are sRGB, since every decode
 * converts to it. Alone, without gAMA / cHRM / iCCP, so `pngIsPlainSrgb` still sends the file to the stream reader.
 * Never on uploads: their names are the hash of their bytes.
 */
export const SRGB_CHUNK = Object.freeze(["sRGB", Uint8Array.of(0)]);

/** The chunks after IHDR in the order a file takes them: `chunks` ([type, bytes] pairs, before IDAT), then one tEXt per text. */
function extraChunks(texts, chunks) {
    const out = [];
    for (const [type, data] of chunks || []) out.push(pngChunk(type, data));
    const enc = new TextEncoder();
    for (const [key, value] of Object.entries(texts || {})) out.push(pngChunk("tEXt", enc.encode(key + "\0" + value)));   // ASCII in, ASCII out (asciiJson)
    return out;
}

/**
 * A finished PNG (another encoder's) with `chunks` and tEXt `texts` put in right after IHDR, the way ComfyUI's SaveImage
 * stores prompt and workflow. A chunk whose type the file already has (an encoder's own sRGB), or a colour chunk
 * where the file says otherwise (iCCP, cICP, gAMA, cHRM), is left out.
 */
export function pngWithChunks(buffer, { texts = null, chunks = null } = {}) {
    const src = new Uint8Array(buffer);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const typeAt = (p) => String.fromCharCode(src[p + 4], src[p + 5], src[p + 6], src[p + 7]);
    if (src.length < 33 || typeAt(8) !== "IHDR") throw new Error("not a PNG with IHDR first");
    const have = new Set();
    for (let p = 8; p + 12 <= src.length;) {
        const type = typeAt(p);
        if (type === "IDAT" || type === "IEND") break;
        have.add(type);
        p += 12 + dv.getUint32(p);
    }
    const colour = ["sRGB", "iCCP", "cICP", "gAMA", "cHRM"];
    const keep = (chunks || []).filter(([type]) => !have.has(type) && !(colour.includes(type) && colour.some((t) => have.has(t))));
    const extra = extraChunks(texts, keep);
    const ihdrEnd = 8 + 12 + 13;
    return new Blob([src.subarray(0, ihdrEnd), ...extra, src.subarray(ihdrEnd)], { type: "image/png" });
}

export class PngStreamWriter {
    /**
     * `run(args, transfer)` runs one `png_part` job and resolves to its reply (`{ chunk, adler, raw }`); `texts`:
     * keyword -> text for tEXt chunks (ASCII; `asciiJson`); `chunks`: [type, bytes] pairs before them (`SRGB_CHUNK`).
     * `flights`: parts in the workers at once, which bounds the memory a fast producer takes (each part is its raw
     * bytes here, in flight, and three times in its worker).
     */
    constructor(width, height, { run, texts = null, chunks = null, level = PNG_LEVEL, flights = 8 } = {}) {
        if (!(width > 0) || !(height > 0)) throw new Error("a PNG of no size");
        this.width = width | 0;
        this.height = height | 0;
        this.run = run;
        this.level = level;
        this.flights = Math.max(1, flights | 0);
        this.texts = texts;
        this.chunks = chunks;
        this.rows = 0;               // rows handed over so far
        this.parts = [];             // promises of replies, in the order of their rows
        this.inFlight = new Set();
        this.failed = null;
    }

    /** Wait until another part may be started. */
    async room() {
        while (this.inFlight.size >= this.flights) await Promise.race(this.inFlight);
        if (this.failed) throw this.failed;
    }

    /**
     * The next `rows` rows. `source`: `{ rgba: ArrayBuffer, prev: ArrayBuffer | null }` (both transferred; `prev` the row
     * above, which the writer does not keep) or `{ tiles, prevTiles, x0, r0 }` (see `png_part`). Parts must be added in
     * the order of their rows; they finish in any.
     */
    add(rows, source, transfer = []) {
        if (this.failed) throw this.failed;
        if (!(rows > 0) || this.rows + rows > this.height) throw new Error(`a part of ${rows} rows at ${this.rows} of ${this.height}`);
        const last = this.rows + rows === this.height;
        this.rows += rows;
        const p = Promise.resolve(this.run({ w: this.width, rows, level: this.level, last, ...source }, transfer));
        const tracked = p.then((r) => { this.inFlight.delete(tracked); return r; }, (err) => { this.inFlight.delete(tracked); if (!this.failed) this.failed = err; throw err; });
        tracked.catch(() => {});
        this.inFlight.add(tracked);
        this.parts.push(tracked);
    }

    /** The file, once every part is in. */
    async finish() {
        if (this.rows !== this.height) throw new Error(`${this.rows} of ${this.height} rows were written`);
        const replies = await Promise.all(this.parts);
        const ihdr = new Uint8Array(13);
        const dv = new DataView(ihdr.buffer);
        dv.setUint32(0, this.width); dv.setUint32(4, this.height);
        ihdr[8] = 8; ihdr[9] = 6;   // 8 bits, RGBA; deflate, adaptive filtering, no interlace
        const pieces = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngChunk("IHDR", ihdr), ...extraChunks(this.texts, this.chunks)];
        // zlib: deflate with a 32K window, no dictionary; the level bits are a hint (0x9C: the default), FCHECK makes it a multiple of 31
        pieces.push(pngChunk("IDAT", new Uint8Array([0x78, 0x9C])));
        let adler = 1;
        for (const r of replies) {
            pieces.push(new Uint8Array(r.chunk));
            adler = adlerCombine(adler, r.adler, r.raw);
        }
        pieces.push(pngChunk("IDAT", new Uint8Array([adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255])));
        pieces.push(pngChunk("IEND", new Uint8Array(0)));
        return new Blob(pieces, { type: "image/png" });
    }
}

// ---- reading ------------------------------------------------------------------------------------------------

/** Width, height, bit depth, colour type and interlace flag from the first 33 bytes of a PNG; null for anything else. */
export function pngHeader(bytes) {
    const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (!bytes || bytes.length < 33 || SIG.some((b, i) => bytes[i] !== b)) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), bitDepth: bytes[24], colorType: bytes[25], interlace: bytes[28] };
}

/**
 * A PNG read as a stream (docs/PLAN_BCE.md §E2): the bytes of the file go through the chunk framing here, the IDAT
 * payload through `DecompressionStream("deflate")`, and the rows come out unfiltered and as RGBA8 in bands of
 * `rowsPerBand`, so a picture no canvas can hold (above 268 MP) is decoded without ever existing in one piece. Runs in
 * a worker or in the window.
 *
 * `onHeader({ width, height, bitDepth, colorType })` first, then `await onRows(rgba, y0, rows)` per band (a
 * Uint8ClampedArray of its own each time). Grey, grey + alpha, RGB, RGBA and palette pictures of 8 bits (1, 2, 4 bits
 * for grey and palette), and 16 bits by their high byte; `tRNS`; not interlaced ones (refused). Colour profiles and
 * gamma are not applied: the bytes are taken as sRGB, which is what such files hold in practice.
 */
export async function readPng(blob, { onHeader = null, onRows, rowsPerBand = 256 } = {}) {
    const h = pngHeader(new Uint8Array(await blob.slice(0, 33).arrayBuffer()));
    if (!h) throw new Error("not a PNG file");
    const { width, height, bitDepth, colorType } = h;
    if (!(width > 0) || !(height > 0)) throw new Error("a PNG of no size");
    if (h.interlace) throw new Error("interlaced PNG files cannot be read as a stream; save the file without interlacing");
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG colour type ${colorType} at ${bitDepth} bits is not supported`);
    const bitsPerPixel = channels * bitDepth;
    const bpp = Math.max(1, bitsPerPixel >> 3);                 // the distance the row filters look back, in bytes
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
    const stride = rowBytes + 1;

    let palette = null, trns = null;
    const texts = {};
    if (onHeader) await onHeader({ width, height, bitDepth, colorType });

    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    // -- the bytes of the file -> chunks; IDAT payload -> the inflater --
    const feed = (async () => {
        const src = blob.slice(8).stream().getReader();
        const header = new Uint8Array(8);
        let have = 0;                                   // bytes of the chunk header collected
        let type = "", left = 0, skipCrc = 0;           // payload bytes left of the current chunk, CRC bytes to skip
        let small = null, smallAt = 0;                  // a PLTE / tRNS / tEXt payload being collected
        let done = false;
        try {
            while (!done) {
                const { value, done: end } = await src.read();
                if (end) break;
                let o = 0;
                while (o < value.length && !done) {
                    if (skipCrc > 0) { const n = Math.min(skipCrc, value.length - o); skipCrc -= n; o += n; continue; }
                    if (left === 0 && have < 8) {
                        const n = Math.min(8 - have, value.length - o);
                        header.set(value.subarray(o, o + n), have); have += n; o += n;
                        if (have < 8) continue;
                        left = new DataView(header.buffer).getUint32(0);
                        type = String.fromCharCode(header[4], header[5], header[6], header[7]);
                        small = type === "PLTE" || type === "tRNS" || (type === "tEXt" && left < 4 * 1048576) ? new Uint8Array(left) : null;
                        smallAt = 0;
                        if (left === 0) { have = 0; skipCrc = 4; if (type === "IEND") done = true; }
                        continue;
                    }
                    const n = Math.min(left, value.length - o);
                    const piece = value.subarray(o, o + n);
                    if (type === "IDAT") await writer.write(piece);
                    else if (small) { small.set(piece, smallAt); smallAt += n; }
                    left -= n; o += n;
                    if (left === 0) {
                        if (type === "PLTE") palette = small;
                        else if (type === "tRNS") trns = small;
                        else if (type === "tEXt" && small) { const z = small.indexOf(0); if (z > 0) texts[new TextDecoder("latin1").decode(small.subarray(0, z))] = new TextDecoder("latin1").decode(small.subarray(z + 1)); }
                        else if (type === "IEND") done = true;
                        have = 0; skipCrc = 4; small = null;
                    }
                }
            }
        } finally {
            try { src.cancel(); } catch (_) { /* ignore */ }
            try { await writer.close(); } catch (_) { /* the reading side reports it */ }
        }
    })();

    // -- inflated bytes -> rows -> RGBA bands --
    const prev = new Uint8Array(rowBytes);
    let lineAt = 0, y = 0;
    const sample = (src, i, depth) => {   // sample i of a packed row of 1, 2 or 4 bits
        const per = 8 / depth, b = src[Math.floor(i / per)];
        return (b >> (8 - depth - (i % per) * depth)) & ((1 << depth) - 1);
    };
    const toRgba = (src, dst, o) => {
        const step = bitDepth === 16 ? 2 : 1;
        if (colorType === 6) {
            if (step === 1) { dst.set(src.subarray(0, width * 4), o); return; }
            for (let x = 0; x < width; x++, o += 4) { dst[o] = src[x * 8]; dst[o + 1] = src[x * 8 + 2]; dst[o + 2] = src[x * 8 + 4]; dst[o + 3] = src[x * 8 + 6]; }
        } else if (colorType === 2) {
            // tRNS names one colour as transparent, in 16-bit samples
            const tr = trns && trns.length >= 6 ? trns : null;
            for (let x = 0, i = 0; x < width; x++, i += 3 * step, o += 4) {
                dst[o] = src[i]; dst[o + 1] = src[i + step]; dst[o + 2] = src[i + 2 * step];
                let clear = false;
                if (tr) {
                    clear = step === 2
                        ? src[i] === tr[0] && src[i + 1] === tr[1] && src[i + 2] === tr[2] && src[i + 3] === tr[3] && src[i + 4] === tr[4] && src[i + 5] === tr[5]
                        : src[i] === tr[1] && src[i + 1] === tr[3] && src[i + 2] === tr[5];
                }
                dst[o + 3] = clear ? 0 : 255;
            }
        } else if (colorType === 4) {
            for (let x = 0, i = 0; x < width; x++, i += 2 * step, o += 4) { const v = src[i]; dst[o] = v; dst[o + 1] = v; dst[o + 2] = v; dst[o + 3] = src[i + step]; }
        } else if (colorType === 0) {
            const max = (1 << Math.min(8, bitDepth)) - 1;
            const tv = trns && trns.length >= 2 ? (bitDepth === 16 ? (trns[0] << 8) | trns[1] : trns[1]) : -1;
            for (let x = 0; x < width; x++, o += 4) {
                let v, raw;
                if (bitDepth === 16) { v = src[x * 2]; raw = (src[x * 2] << 8) | src[x * 2 + 1]; }
                else if (bitDepth === 8) { v = raw = src[x]; }
                else { raw = sample(src, x, bitDepth); v = Math.round((raw * 255) / max); }
                dst[o] = v; dst[o + 1] = v; dst[o + 2] = v; dst[o + 3] = raw === tv ? 0 : 255;
            }
        } else {
            if (!palette) throw new Error("a palette PNG without its palette");
            for (let x = 0; x < width; x++, o += 4) {
                const k = bitDepth === 8 ? src[x] : sample(src, x, bitDepth);
                dst[o] = palette[k * 3]; dst[o + 1] = palette[k * 3 + 1]; dst[o + 2] = palette[k * 3 + 2];
                dst[o + 3] = trns && k < trns.length ? trns[k] : 255;
            }
        }
    };
    // A band of lines is collected and its filters are undone in one call of the kernel (px/kernels.js: Rust, or the
    // twin); an 8-bit RGB or RGBA picture comes out of that call as RGBA8, any other kind row by row through `toRgba`.
    let lines = null, held = 0, bandY = 0;
    const spent = { unfilter: 0, deliver: 0 };   // milliseconds: the filters undone, and inside `onRows`; the rest is the inflater
    const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const emit = async () => {
        if (!held) return;
        const n = held, at = bandY;
        const out = new Uint8ClampedArray(n * width * 4);
        const fast = bitDepth === 8 && (colorType === 6 || (colorType === 2 && !trns));   // tRNS comes before the first IDAT
        const t0 = clock();
        const block = lines.subarray(0, n * stride);
        const done = pngUnfilterRows(block, n, rowBytes, bpp, prev, fast ? { w: width, channels, out } : null);
        if (done !== n) throw new Error("PNG row " + (at + done) + " has filter type " + block[done * stride]);
        if (!fast) for (let r = 0; r < n; r++) toRgba(block.subarray(r * stride + 1, (r + 1) * stride), out, r * width * 4);
        held = 0;
        const t1 = clock();
        spent.unfilter += t1 - t0;
        await onRows(out, at, n);
        spent.deliver += clock() - t1;
    };
    const drainRows = async () => {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            let o = 0;
            while (o < value.length && y < height) {
                if (!lines) lines = new Uint8Array(Math.min(rowsPerBand, height) * stride);
                if (!held && !lineAt) bandY = y;
                // as much of the band as this piece holds, in one copy
                const room = Math.min(rowsPerBand, height - bandY) * stride - (held * stride + lineAt);
                const n = Math.min(room, value.length - o);
                lines.set(value.subarray(o, o + n), held * stride + lineAt);
                o += n;
                const total = lineAt + n;
                const whole = Math.floor(total / stride);
                held += whole; y += whole; lineAt = total - whole * stride;
                if (held >= Math.min(rowsPerBand, height - bandY)) await emit();
            }
        }
        await emit();
    };
    const drain = (async () => {
        try { await drainRows(); } catch (err) { reader.cancel().catch(() => {}); throw err; }   // the feeding side stops with it
    })();
    await Promise.all([feed, drain]);
    if (y !== height) throw new Error(`the PNG ended after ${y} of ${height} rows`);
    return { width, height, bitDepth, colorType, texts, spent };
}
