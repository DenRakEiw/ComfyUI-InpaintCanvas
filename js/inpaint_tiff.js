// Generated from DenRakEiw/scumble renderer/editor/inpaint_tiff.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * TIFF files (docs/PLAN_0_1_29.md 3d): read as a stream and written in strips, as inpaint_png.js does PNG. A picture
 * never exists as one buffer: the reader hands out bands of RGBA8 rows while it decodes, the writer takes strips of
 * rows that the worker pool compresses. Plain data, no DOM, nothing runs at import: the module is imported in the
 * window, in the pool's workers, in Node (tools/tiff_test.js) and by ComfyUI as a node file.
 *
 * Read: classic and BigTIFF, both byte orders; strips or tiles, chunky or planar; no compression, LZW, Deflate (8 and
 * 32946) and PackBits, horizontal prediction at 8 and 16 bits; grey (1, 2, 4, 8, 16 bits, either polarity), palette (1,
 * 2, 4, 8 bits), RGB (8, 16 bits); a first extra sample as alpha when it says so (unassociated kept, associated
 * unpremultiplied). The first full-resolution image of the file is read (a reduced-resolution one before it is
 * skipped). 16-bit samples become 8 by rounding to the nearest level (v / 257), the rule the PSD reader uses; a palette's
 * 16-bit colour map by its high byte, as libtiff reads it. Colour profiles,
 * the orientation tag and Photoshop's layers are not applied; the caller gets a note for each. CMYK, YCbCr, Lab,
 * floating point, signed and 32-bit samples, JPEG and every other compression are refused with a message that says
 * what to do instead.
 *
 * Write: little-endian classic TIFF, RGBA 8 bits with unassociated alpha, Adobe Deflate strips with horizontal
 * prediction, 72 dpi. A file that could pass 4 GB would need BigTIFF, which is not written.
 */

// ---- reading ----------------------------------------------------------------------------------------------------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
const COMPRESSIONS = {
    1: "none", 2: "CCITT RLE", 3: "CCITT Group 3 fax", 4: "CCITT Group 4 fax", 5: "LZW", 6: "old-style JPEG", 7: "JPEG",
    8: "Deflate", 32773: "PackBits", 32809: "ThunderScan", 32946: "Deflate", 34661: "JBIG", 34676: "SGI LogLuv",
    34677: "SGI LogLuv 24", 34712: "JPEG 2000", 34887: "LERC", 34892: "lossy JPEG", 34925: "LZMA", 50000: "Zstandard",
    50001: "WebP", 50002: "JPEG XL", 52546: "JPEG XL",
};
const READ = new Set([1, 5, 8, 32773, 32946]);
const MAX_IFDS = 256;              // IFDs walked to count the pages (and to find a full-resolution one)
const MAX_VALUES = 1 << 24;        // entries of one tag's array (a strip table of a gigapixel picture is far below)

const TRUNCATED = "the file ends early (it is truncated, or not a TIFF)";
const truncated = (what = "") => new Error(TRUNCATED + (what ? ": " + what : ""));

/** Does the file start like a TIFF (classic or BigTIFF, either byte order)? */
export function isTiff(head) {
    if (!head || head.length < 4) return false;
    const [a, b, c, d] = head;
    if (a === 0x49 && b === 0x49) return (c === 42 || c === 43) && d === 0;
    if (a === 0x4D && b === 0x4D) return c === 0 && (d === 42 || d === 43);
    return false;
}

/** File name endings of a TIFF, for the callers that test names. */
export const TIFF_EXT = /\.tiff?$/i;

/** Random access to a Blob in pieces, with the byte order of the file. */
class Source {
    constructor(blob) { this.blob = blob; this.size = blob.size; this.le = true; this.big = false; }
    async bytes(off, len) {
        if (!(off >= 0) || !(len >= 0) || off + len > this.size) throw truncated(`${len} bytes at ${off} of ${this.size}`);
        return new Uint8Array(await this.blob.slice(off, off + len).arrayBuffer());
    }
    view(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
    u16(b, o) { return this.view(b).getUint16(o, this.le); }
    u32(b, o) { return this.view(b).getUint32(o, this.le); }
    u64(b, o) {
        const v = this.view(b), lo = v.getUint32(o + (this.le ? 0 : 4), this.le), hi = v.getUint32(o + (this.le ? 4 : 0), this.le);
        if (hi >= 0x200000) throw new Error("a BigTIFF offset beyond 2^53");
        return hi * 4294967296 + lo;
    }
}

/** One IFD: its entries by tag (`{ type, count, at }`, `at` the offset of the value, or its inline bytes) and the next IFD. */
async function readIfd(src, off) {
    const big = src.big;
    const head = await src.bytes(off, big ? 8 : 2);
    const n = big ? src.u64(head, 0) : src.u16(head, 0);
    if (!(n > 0) || n > 4096) throw new Error(`a TIFF directory of ${n} entries at ${off} (the file is damaged, or not a TIFF)`);
    const esz = big ? 20 : 12;
    const block = await src.bytes(off + head.length, n * esz + (big ? 8 : 4));
    const tags = new Map();
    for (let i = 0; i < n; i++) {
        const o = i * esz;
        const tag = src.u16(block, o), type = src.u16(block, o + 2);
        const count = big ? src.u64(block, o + 4) : src.u32(block, o + 4);
        const vo = o + (big ? 12 : 8), room = big ? 8 : 4;
        const size = (TYPE_SIZE[type] || 1) * count;
        tags.set(tag, { type, count, inline: size <= room ? block.slice(vo, vo + room) : null, at: size <= room ? -1 : (big ? src.u64(block, vo) : src.u32(block, vo)) });
    }
    const next = big ? src.u64(block, n * esz) : src.u32(block, n * esz);
    return { off, tags, next };
}

/** A tag's values: numbers (rationals as num / den), or a string for ASCII. */
async function valuesOf(src, e) {
    const size = TYPE_SIZE[e.type] || 1;
    if (e.count > MAX_VALUES) throw new Error(`a TIFF tag with ${e.count} values`);
    const b = e.inline || await src.bytes(e.at, size * e.count);
    const v = src.view(b), le = src.le, out = [];
    if (e.type === 2) return new TextDecoder("latin1").decode(b.subarray(0, e.count)).replace(/\0.*$/s, "");
    for (let i = 0; i < e.count; i++) {
        const o = i * size;
        switch (e.type) {
            case 1: case 7: out.push(b[o]); break;
            case 6: out.push(v.getInt8(o)); break;
            case 3: out.push(v.getUint16(o, le)); break;
            case 8: out.push(v.getInt16(o, le)); break;
            case 4: case 13: out.push(v.getUint32(o, le)); break;
            case 9: out.push(v.getInt32(o, le)); break;
            case 5: { const d = v.getUint32(o + 4, le); out.push(d ? v.getUint32(o, le) / d : 0); break; }
            case 10: { const d = v.getInt32(o + 4, le); out.push(d ? v.getInt32(o, le) / d : 0); break; }
            case 11: out.push(v.getFloat32(o, le)); break;
            case 12: out.push(v.getFloat64(o, le)); break;
            case 16: case 18: out.push(src.u64(b, o)); break;
            case 17: out.push(src.u64(b, o)); break;
            default: out.push(b[o]);
        }
    }
    return out;
}

/**
 * The header and the directories: which image is read, how its bytes lie, what it holds. Throws the refusal for a
 * file that is not read. `{ info, layout }`, `info` as `readTiff` returns it.
 */
async function parse(blob) {
    const src = new Source(blob);
    if (blob.size < 8) throw new Error("not a TIFF file");
    const head = await src.bytes(0, Math.min(16, blob.size));
    if (!isTiff(head)) throw new Error("not a TIFF file");
    src.le = head[0] === 0x49;
    src.big = src.u16(head, 2) === 43;
    let first;
    if (src.big) {
        if (head.length < 16 || src.u16(head, 4) !== 8) throw new Error("a BigTIFF with an offset size other than 8");
        first = src.u64(head, 8);
    } else first = src.u32(head, 4);

    // the directories: the first full-resolution one is read, the others counted as pages
    const seen = new Set();
    let chosen = null, pages = 0, reducedFirst = false;
    for (let off = first, k = 0; off && k < MAX_IFDS && !seen.has(off); k++) {
        seen.add(off);
        let ifd;
        try { ifd = await readIfd(src, off); } catch (err) { if (chosen) break; throw err; }
        const nst = ifd.tags.has(254) ? (await valuesOf(src, ifd.tags.get(254)))[0] : 0;
        const st = ifd.tags.has(255) ? (await valuesOf(src, ifd.tags.get(255)))[0] : 1;
        const reduced = (nst & 1) === 1 || st === 2;
        if (!reduced) { pages++; if (!chosen) chosen = ifd; }
        else if (!chosen) reducedFirst = true;
        off = ifd.next;
    }
    if (!chosen) {   // only reduced-resolution images: take the first after all
        chosen = await readIfd(src, first);
        pages = 1;
    }
    const tags = chosen.tags;
    const get = async (tag, dflt) => (tags.has(tag) ? valuesOf(src, tags.get(tag)) : dflt);
    const one = async (tag, dflt) => (tags.has(tag) ? (await valuesOf(src, tags.get(tag)))[0] : dflt);

    const width = await one(256, 0), height = await one(257, 0);
    if (!(width > 0) || !(height > 0)) throw new Error("a TIFF of no size");
    const compression = await one(259, 1);
    if (compression === 6 || compression === 7 || compression === 34892) throw new Error("JPEG-compressed TIFF files are not read; save it with LZW or ZIP compression, or as a JPEG file");
    if (!READ.has(compression)) throw new Error(`TIFF compression ${compression} (${COMPRESSIONS[compression] || "unknown"}) is not read; save it with LZW or ZIP compression, or without`);
    const spp = await one(277, 1);
    const formats = await get(339, [1]);
    if (formats.includes(3)) throw new Error("this TIFF holds floating-point samples; only 8 and 16-bit integer TIFF files are read (convert it to 16 bits)");
    if (formats.includes(2)) throw new Error("this TIFF holds signed samples; only unsigned 8 and 16-bit TIFF files are read");
    if (formats.some((f) => f !== 1 && f !== 4)) throw new Error(`TIFF sample format ${formats.join(", ")} is not read`);
    const bitsList = await get(258, [1]);
    const bits = bitsList[0];
    if (bitsList.some((b) => b !== bits)) throw new Error(`a TIFF whose channels have different depths (${bitsList.join(", ")} bits) is not read`);
    const photometric = tags.has(262) ? await one(262, 1) : (spp >= 3 ? 2 : 1);
    if (photometric === 5) throw new Error("this TIFF is in CMYK colour; only RGB, grayscale and palette TIFF files are read (convert it to RGB)");
    if (photometric === 6) throw new Error("this TIFF is in YCbCr colour (usually JPEG-compressed); save it in RGB with LZW or ZIP compression, or as a JPEG file");
    if (photometric === 8 || photometric === 9 || photometric === 10) throw new Error("this TIFF is in Lab colour; only RGB, grayscale and palette TIFF files are read (convert it to RGB)");
    if (![0, 1, 2, 3].includes(photometric)) throw new Error(`TIFF colour kind ${photometric} is not read; only RGB, grayscale and palette TIFF files are`);
    if (bits === 32 || bits === 64) throw new Error(`this TIFF has ${bits} bits per channel; only 8 and 16 are read (convert it to 16 bits)`);
    const kind = photometric === 2 ? "RGB" : photometric === 3 ? "palette" : "grayscale";
    const allowed = photometric === 2 ? [8, 16] : photometric === 3 ? [1, 2, 4, 8] : [1, 2, 4, 8, 16];
    if (!allowed.includes(bits)) throw new Error(`a ${kind} TIFF with ${bits} bits per channel is not read`);
    const base = photometric === 2 ? 3 : 1;
    if (spp < base) throw new Error(`an RGB TIFF with ${spp} channels`);
    const planar = await one(284, 1);
    if (planar !== 1 && planar !== 2) throw new Error(`TIFF planar configuration ${planar} is not read`);
    const predictor = await one(317, 1);
    if (predictor === 3) throw new Error("this TIFF uses floating-point prediction; only 8 and 16-bit integer TIFF files are read");
    if (predictor !== 1 && predictor !== 2) throw new Error(`TIFF predictor ${predictor} is not read`);
    if (predictor === 2 && bits !== 8 && bits !== 16) throw new Error(`horizontal prediction at ${bits} bits is not read`);
    if ((await one(266, 1)) === 2) throw new Error("a TIFF with its bits in reversed order (FillOrder 2) is not read");

    // extra channels: the first one is alpha when it says so, the rest are left out
    const notes = [];
    const extra = spp - base;
    const extras = await get(338, []);
    let alpha = "none";
    if (extra > 0) {
        const e0 = extras.length ? extras[0] : 0;
        if (e0 === 1) alpha = "premultiplied";
        else if (e0 === 2) alpha = "straight";
        if (alpha === "none" || extra > 1) notes.push(extra - (alpha === "none" ? 0 : 1) > 1 ? `${extra - (alpha === "none" ? 0 : 1)} extra channels left out` : "an extra channel left out");
    }

    // where the bytes are
    const tiled = tags.has(322) || tags.has(324);
    const planes = planar === 2 ? spp : 1;
    const perPixel = planar === 2 ? 1 : spp;   // samples in one plane's pixel
    let layout;
    if (tiled) {
        const tw = await one(322, 0), tl = await one(323, 0);
        if (!(tw > 0) || !(tl > 0)) throw new Error("a tiled TIFF without its tile size");
        const across = Math.ceil(width / tw), down = Math.ceil(height / tl);
        const offsets = await get(324, []), counts = await get(325, []);
        const want = across * down * planes;
        if (offsets.length < want || (counts.length < want && compression !== 1)) throw new Error(`the tile table holds ${Math.min(offsets.length, counts.length)} of ${want} tiles (the file is damaged)`);
        const rowBytes = Math.ceil((tw * perPixel * bits) / 8);
        const full = rowBytes * tl;
        layout = { tiled: true, tw, tl, across, down, offsets, counts: counts.length >= want ? counts : offsets.map(() => full) };
    } else {
        const rps = Math.min(height, Math.max(1, await one(278, height)));
        const per = Math.ceil(height / rps);
        const offsets = await get(273, []);
        let counts = await get(279, null);
        const want = per * planes;
        if (!counts) {
            if (compression !== 1) throw new Error("a compressed TIFF without its strip sizes (the file is damaged)");
            const rb = Math.ceil((width * perPixel * bits) / 8);
            counts = offsets.map((_, i) => rb * Math.min(rps, height - (i % per) * rps));
        }
        if (offsets.length < want || counts.length < want) throw new Error(`the strip table holds ${Math.min(offsets.length, counts.length)} of ${want} strips (the file is damaged)`);
        layout = { tiled: false, rps, per, offsets, counts };
    }
    layout.rowBytes = Math.ceil((width * perPixel * bits) / 8);   // one image row of one plane
    layout.planes = planes;
    layout.perPixel = perPixel;
    layout.colormap = photometric === 3 ? await get(320, null) : null;
    if (photometric === 3 && (!layout.colormap || layout.colormap.length < 3 * (1 << bits))) throw new Error("a palette TIFF without its colour map");

    if (pages > 1) notes.push(`page 1 of ${pages === MAX_IFDS ? pages + " or more" : pages} opened; the other pages are left out`);
    if (reducedFirst) notes.push("a reduced-resolution preview in front of the picture was skipped");
    if (bits === 16) notes.push("16 bits per channel rounded to 8");
    const orientation = await one(274, 1);
    if (orientation !== 1) notes.push(`the orientation tag (${orientation}) is not applied: the picture opens as stored`);
    if (tags.has(34675)) notes.push("its colour profile is not applied");
    if (tags.has(37724)) notes.push("Photoshop layers are not read; the merged picture opens");

    const info = {
        width, height, bits, samples: spp, photometric, compression, predictor, planar, tiled, bigtiff: src.big,
        alpha, pages, notes,
    };
    return { src, info, layout };
}

/** The header and what it holds, without reading the pixels. Throws the refusal for a file that is not read. */
export async function tiffInfo(blob) {
    return (await parse(blob)).info;
}

// -- decoders: bytes of one strip or tile in, the uncompressed bytes out, piece by piece --

/** A growing byte buffer. */
class Sink {
    constructor(n = 65536) { this.buf = new Uint8Array(n); this.len = 0; }
    room(n) {
        if (this.len + n <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.len + n) cap *= 2;
        const b = new Uint8Array(cap);
        b.set(this.buf.subarray(0, this.len));
        this.buf = b;
    }
    take() { const out = this.buf.slice(0, this.len); this.len = 0; return out; }
}

/** PackBits (Apple, TIFF 6.0 section 9), streamed: a run may be cut anywhere between two pieces. */
function packBitsDecoder() {
    const out = new Sink();
    let lit = 0, rep = -1;   // literal bytes still to copy; a repeat count waiting for its byte
    return {
        push(chunk) {
            for (let i = 0; i < chunk.length;) {
                if (lit > 0) {
                    const n = Math.min(lit, chunk.length - i);
                    out.room(n); out.buf.set(chunk.subarray(i, i + n), out.len); out.len += n;
                    lit -= n; i += n;
                } else if (rep > 0) {
                    out.room(rep); out.buf.fill(chunk[i], out.len, out.len + rep); out.len += rep;
                    rep = -1; i++;
                } else {
                    const h = chunk[i++];
                    if (h < 128) lit = h + 1;
                    else if (h > 128) rep = 257 - h;
                }
            }
            return out.take();
        },
        end() { return new Uint8Array(0); },
    };
}

/**
 * TIFF's LZW (TIFF 6.0 section 13), streamed: codes of 9 to 12 bits, most significant bit first, the width growing one
 * code early; 256 clears the table, 257 ends the strip. The LZW of before TIFF 6 (bits the other way round) is refused.
 */
function lzwDecoder() {
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
    const out = new Sink();
    let next = 258, width = 9, old = -1, acc = 0, nbits = 0, ended = false, checked = false, head = -1;
    const emit = (code) => {
        const l = len[code];
        out.room(l);
        const b = out.buf;
        let p = out.len + l - 1;
        for (let c = code; c >= 0; c = prefix[c]) b[p--] = suffix[c];
        out.len += l;
    };
    const add = (pre, ch) => {
        if (next >= 4096) return;
        prefix[next] = pre; suffix[next] = ch; first[next] = first[pre]; len[next] = len[pre] + 1;
        next++;
        if (next >= (1 << width) - 1 && width < 12) width++;
    };
    const code = (c) => {
        if (c === 256) { next = 258; width = 9; old = -1; return; }
        if (c === 257) { ended = true; return; }
        if (old < 0) {
            if (c > 255) throw new Error("damaged LZW data in the TIFF (a code before any literal)");
            emit(c); old = c; return;
        }
        if (c < next) { emit(c); add(old, first[c]); }
        else if (c === next) { add(old, first[old]); emit(c); }
        else throw new Error("damaged LZW data in the TIFF (a code beyond the table)");
        old = c;
    };
    return {
        push(chunk) {
            let i = 0;
            if (!checked && chunk.length) {
                // an old-style stream starts with its clear code least significant bit first: 0x00, then a byte with bit 0 set
                if (head < 0) { head = chunk[0]; if (chunk.length < 2) return new Uint8Array(0); }
                const second = head === chunk[0] && chunk.length >= 2 ? chunk[1] : chunk[0];
                if (head === 0 && (second & 1)) throw new Error("this TIFF uses the old-style LZW of before TIFF 6, which is not read; save it again with LZW or ZIP compression");
                checked = true;
                if (chunk[0] !== head || chunk.length < 2) {   // the first byte came alone: feed it now
                    acc = head; nbits = 8;
                }
            }
            for (; i < chunk.length && !ended; i++) {
                acc = ((acc << 8) | chunk[i]) & 0xFFFFFF;
                nbits += 8;
                while (nbits >= width && !ended) {
                    const c = (acc >>> (nbits - width)) & ((1 << width) - 1);
                    nbits -= width;
                    code(c);
                }
            }
            return out.take();
        },
        end() { return out.take(); },
    };
}

/** The pieces of a ReadableStream, and the stream cancelled when the caller stops early. */
async function* piecesOf(stream) {
    const r = stream.getReader();
    let done = false;
    try {
        for (;;) {
            const x = await r.read();
            if (x.done) { done = true; return; }
            yield x.value;
        }
    } finally {
        if (!done) { try { await r.cancel(); } catch (_) { /* nothing to cancel */ } }
    }
}

/** The uncompressed bytes of one strip or tile, piece by piece. */
async function* unpacked(src, off, count, compression, name) {
    if (!(off >= 0) || !(count >= 0) || off + count > src.size) throw truncated(`${name} lies past the end of the file`);
    const raw = src.blob.slice(off, off + count).stream();
    if (compression === 1) { yield* piecesOf(raw); return; }
    if (compression === 8 || compression === 32946) {
        try { yield* piecesOf(raw.pipeThrough(new DecompressionStream("deflate"))); } catch (err) { throw new Error(`${name} of the TIFF is damaged or cut off (${(err && err.message) || err})`); }
        return;
    }
    const dec = compression === 5 ? lzwDecoder() : packBitsDecoder();
    for await (const piece of piecesOf(raw)) { const o = dec.push(piece); if (o.length) yield o; }
    const tail = dec.end();
    if (tail.length) yield tail;
}

/** Undo horizontal prediction (Predictor 2) on `rows` rows of `rowBytes`, `pixels` wide with `per` samples a pixel. */
function unpredict(buf, rows, rowBytes, pixels, per, bits, le) {
    if (bits === 8) {
        for (let r = 0; r < rows; r++) {
            const o = r * rowBytes, end = o + pixels * per;
            for (let i = o + per; i < end; i++) buf[i] = (buf[i] + buf[i - per]) & 255;
        }
    } else {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let r = 0; r < rows; r++) {
            const o = r * rowBytes;
            for (let s = per; s < pixels * per; s++) v.setUint16(o + s * 2, (v.getUint16(o + s * 2, le) + v.getUint16(o + (s - per) * 2, le)) & 0xFFFF, le);
        }
    }
}

/**
 * The rows of one plane, read in order from its strips: `read(n)` gives the next `n` rows as a fresh buffer. Each strip
 * is decoded as it streams in, so a picture stored as one strip never exists as a whole.
 */
class StripRows {
    constructor(src, info, layout, plane) {
        this.src = src; this.info = info; this.L = layout; this.plane = plane;
        this.strip = -1; this.it = null; this.need = 0; this.piece = null; this.at = 0;
    }
    async open() {
        const L = this.L, s = ++this.strip;
        if (s >= L.per) throw truncated("more rows asked for than the strips hold");
        const k = this.plane * L.per + s;
        const rows = Math.min(L.rps, this.info.height - s * L.rps);
        this.need = rows * L.rowBytes;
        this.it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `strip ${k + 1}`);
        this.piece = null; this.at = 0;
    }
    async read(n) {
        const L = this.L, out = new Uint8Array(n * L.rowBytes);
        let filled = 0;
        while (filled < out.length) {
            if (this.need === 0) await this.open();
            if (!this.piece || this.at >= this.piece.length) {
                const x = await this.it.next();
                if (x.done) throw truncated(`strip ${this.plane * L.per + this.strip + 1} holds ${out.length - filled > 0 ? "fewer bytes than its rows" : ""}`.trim());
                this.piece = x.value; this.at = 0;
                continue;
            }
            const take = Math.min(this.piece.length - this.at, this.need, out.length - filled);
            out.set(this.piece.subarray(this.at, this.at + take), filled);
            filled += take; this.at += take; this.need -= take;
            if (this.need === 0) { await this.close(); }   // what a strip holds past its rows is padding
        }
        if (this.info.predictor === 2) unpredict(out, n, L.rowBytes, this.info.width, L.perPixel, this.info.bits, this.src.le);
        return out;
    }
    async close() {
        if (this.it) { const it = this.it; this.it = null; try { await it.return(); } catch (_) { /* closed */ } }
        this.piece = null;
    }
}

/** The rows of one plane from its tiles: a row of tiles is decoded whole, then handed out row by row. */
class TileRows {
    constructor(src, info, layout, plane) {
        this.src = src; this.info = info; this.L = layout; this.plane = plane;
        this.band = null; this.bandAt = 0; this.bandRows = 0; this.ty = -1;
    }
    async tile(k) {
        const L = this.L, tileRow = Math.ceil((L.tw * L.perPixel * this.info.bits) / 8), want = tileRow * L.tl;
        const buf = new Uint8Array(want);
        let got = 0;
        const it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `tile ${k + 1}`);
        try {
            for await (const piece of it) {
                const take = Math.min(piece.length, want - got);
                buf.set(piece.subarray(0, take), got);
                got += take;
                if (got >= want) break;
            }
        } finally { try { await it.return(); } catch (_) { /* closed */ } }
        if (got < want) throw truncated(`tile ${k + 1} holds ${got} of ${want} bytes`);
        if (this.info.predictor === 2) unpredict(buf, L.tl, tileRow, L.tw, L.perPixel, this.info.bits, this.src.le);
        return { buf, tileRow };
    }
    async nextBand() {
        const L = this.L, ty = ++this.ty;
        if (ty >= L.down) throw truncated("more rows asked for than the tiles hold");
        const rows = Math.min(L.tl, this.info.height - ty * L.tl);
        const band = new Uint8Array(rows * L.rowBytes);
        const per = (L.perPixel * this.info.bits) / 8;   // bytes a pixel (a fraction below 8 bits; tile widths are multiples of 16)
        for (let tx = 0; tx < L.across; tx++) {
            const { buf, tileRow } = await this.tile(this.plane * L.across * L.down + ty * L.across + tx);
            const px = Math.min(L.tw, this.info.width - tx * L.tw);
            const bytes = Math.ceil(px * per), at = Math.floor(tx * L.tw * per);
            for (let r = 0; r < rows; r++) band.set(buf.subarray(r * tileRow, r * tileRow + bytes), r * L.rowBytes + at);
        }
        this.band = band; this.bandAt = 0; this.bandRows = rows;
    }
    async read(n) {
        const L = this.L, out = new Uint8Array(n * L.rowBytes);
        for (let r = 0; r < n;) {
            if (!this.band || this.bandAt >= this.bandRows) await this.nextBand();
            const take = Math.min(n - r, this.bandRows - this.bandAt);
            out.set(this.band.subarray(this.bandAt * L.rowBytes, (this.bandAt + take) * L.rowBytes), r * L.rowBytes);
            this.bandAt += take; r += take;
        }
        return out;
    }
    async close() { this.band = null; }
}

/** 16 bits to 8, to the nearest level: floor(v / 257 + 1/2). */
const to8 = (v) => ((v * 2 + 257) / 514) | 0;

/**
 * A band of rows (one buffer per plane) as RGBA8. Every sample first becomes 8 bits in pixel order (`s8`, palette
 * indices stay indices), then the colour kind turns it into RGBA.
 */
function converter(info, layout, le) {
    const W = info.width, spp = info.samples, bits = info.bits, ph = info.photometric;
    const base = ph === 2 ? 3 : 1;
    const ai = info.alpha === "none" ? -1 : base;
    const pre = info.alpha === "premultiplied";
    const palette = ph === 3;
    const cm = layout.colormap;
    const levels = palette ? 1 << bits : 0;
    const pal = palette ? new Uint8Array(levels * 3) : null;
    // the colour map by its high byte, as libtiff reads it: exact for the v * 256 some writers store and the v * 257 of
    // others; a map with every entry below 256 is taken as 8 bits already (libtiff's test for such writers)
    const map8 = palette && cm.slice(0, 3 * levels).every((v) => v < 256) ? (v) => v : (v) => v >> 8;
    if (palette) for (let i = 0; i < levels; i++) { pal[i * 3] = map8(cm[i]); pal[i * 3 + 1] = map8(cm[levels + i]); pal[i * 3 + 2] = map8(cm[2 * levels + i]); }
    const scale = bits < 8 && !palette ? 255 / ((1 << bits) - 1) : 1;
    const s8 = new Uint8Array(W * spp);
    const planes = layout.planes, rowBytes = layout.rowBytes;
    const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

    /** Row `r` of the band as 8-bit samples in pixel order. */
    const samples = (bufs, r) => {
        if (planes === 1 && bits === 8) return bufs[0].subarray(r * rowBytes, r * rowBytes + W * spp);
        for (let p = 0; p < planes; p++) {
            const b = bufs[p], o = r * rowBytes;
            const per = planes === 1 ? spp : 1, step = planes === 1 ? 1 : spp, off = planes === 1 ? 0 : p;
            const n = W * per;
            if (bits === 8) { for (let i = 0; i < n; i++) s8[off + i * step] = b[o + i]; }
            else if (bits === 16) { const v = view(b); for (let i = 0; i < n; i++) s8[off + i * step] = to8(v.getUint16(o + i * 2, le)); }
            else {
                const mask = (1 << bits) - 1, perByte = 8 / bits;
                for (let i = 0; i < n; i++) {
                    const byte = b[o + Math.floor(i / perByte)];
                    const raw = (byte >> (8 - bits - (i % perByte) * bits)) & mask;
                    s8[off + i * step] = palette ? raw : Math.round(raw * scale);
                }
            }
        }
        return s8;
    };
    return (bufs, n, out) => {
        for (let r = 0; r < n; r++) {
            const s = samples(bufs, r);
            let o = r * W * 4;
            for (let x = 0, i = 0; x < W; x++, i += spp, o += 4) {
                let R, G, B;
                if (ph === 2) { R = s[i]; G = s[i + 1]; B = s[i + 2]; }
                else if (palette) { const k = s[i] * 3; R = pal[k]; G = pal[k + 1]; B = pal[k + 2]; }
                else { R = G = B = ph === 0 ? 255 - s[i] : s[i]; }
                let A = 255;
                if (ai >= 0) {
                    A = s[i + ai];
                    if (pre) {
                        if (A === 0) { R = G = B = 0; }
                        else if (A < 255) {
                            const h = A >> 1;
                            R = Math.min(255, Math.floor((R * 255 + h) / A)); G = Math.min(255, Math.floor((G * 255 + h) / A)); B = Math.min(255, Math.floor((B * 255 + h) / A));
                        }
                    }
                }
                out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = A;
            }
        }
    };
}

/**
 * A TIFF read as a stream: `onHeader(info)` first, then `await onRows(rgba, y0, rows)` per band of at most
 * `rowsPerBand` rows, in order (`rgba` a fresh Uint8Array of `rows * width * 4` bytes, straight alpha). Resolves to
 * `info`: `{ width, height, bits, samples, photometric, compression, predictor, planar, tiled, bigtiff, alpha, pages,
 * notes }`. Throws the refusal for a file that is not read, before any row.
 */
export async function readTiff(blob, { onHeader = null, onRows, rowsPerBand = 256 } = {}) {
    const { src, info, layout } = await parse(blob);
    if (onHeader) await onHeader(info);
    const Rows = layout.tiled ? TileRows : StripRows;
    const planes = Array.from({ length: layout.planes }, (_, p) => new Rows(src, info, layout, p));
    const convert = converter(info, layout, src.le);
    const band = Math.max(1, rowsPerBand | 0);
    try {
        for (let y = 0; y < info.height; y += band) {
            const n = Math.min(band, info.height - y);
            const bufs = await Promise.all(planes.map((p) => p.read(n)));
            const out = new Uint8Array(n * info.width * 4);
            convert(bufs, n, out);
            if (onRows) await onRows(out, y, n);
        }
    } finally {
        for (const p of planes) await p.close();
    }
    return info;
}

// ---- writing ----------------------------------------------------------------------------------------------------

export const TIFF_STRIP_BYTES = 8 * 1048576;   // raw bytes of a strip at most: what one worker holds a few times over

/** Rows a strip of a picture `width` wide holds: a power of two that divides 256 (every row source's alignment). */
export function tiffStripRows(width) {
    let r = 256;
    while (r > 1 && r * Math.max(1, width) * 4 > TIFF_STRIP_BYTES) r >>= 1;
    return r;
}

/**
 * One strip: `rows` rows of RGBA8 `w` wide, differenced horizontally (Predictor 2, on a copy) and compressed by
 * `deflate` (bytes -> a zlib stream). `{ chunk, raw }`.
 */
export async function tiffPart({ rgba, w, rows, predictor = 2 }, deflate) {
    const n = w * rows * 4;
    const src = rgba instanceof Uint8Array ? rgba.subarray(0, n) : new Uint8Array(rgba, 0, n);
    let bytes = src;
    if (predictor === 2) {
        bytes = new Uint8Array(src);
        const row = w * 4;
        for (let r = 0; r < rows; r++) {
            const o = r * row;
            for (let i = o + row - 1; i >= o + 4; i--) bytes[i] = (bytes[i] - bytes[i - 4]) & 255;
        }
    }
    const z = await deflate(bytes);
    const chunk = z.byteOffset === 0 && z.byteLength === z.buffer.byteLength ? z.buffer : z.slice().buffer;
    return { chunk, raw: n };
}

/**
 * A TIFF written strip by strip, like `PngStreamWriter`: `run(args, transfer)` runs one `tiff_part` job (`args`: `{ w,
 * rows, predictor, ...source }`) and resolves to its reply; strips are added in row order, each `tiffStripRows(width)`
 * rows but the last; they finish in any order. `flights` bounds the strips in the workers at once.
 */
export class TiffStreamWriter {
    /** Throws when the file could pass 4 GB, which classic TIFF cannot address. */
    static check(width, height) {
        if (width * height * 4 + 1048576 > 0xFFFFFFFF) throw new Error(`a TIFF of ${width} × ${height} could pass 4 GB, which needs BigTIFF; BigTIFF is not written, save it as PNG or PSD`);
    }

    constructor(width, height, { run, flights = 8, predictor = 2, rowsPerStrip = 0 } = {}) {
        if (!(width > 0) || !(height > 0)) throw new Error("a TIFF of no size");
        TiffStreamWriter.check(width, height);
        this.width = width | 0;
        this.height = height | 0;
        this.run = run;
        this.flights = Math.max(1, flights | 0);
        this.predictor = predictor === 1 ? 1 : 2;
        this.rps = rowsPerStrip > 0 ? rowsPerStrip | 0 : tiffStripRows(this.width);
        this.rows = 0;
        this.parts = [];
        this.inFlight = new Set();
        this.failed = null;
    }

    async room() {
        while (this.inFlight.size >= this.flights) await Promise.race(this.inFlight);
        if (this.failed) throw this.failed;
    }

    add(rows, source, transfer = []) {
        if (this.failed) throw this.failed;
        const want = Math.min(this.rps, this.height - this.rows);
        if (rows !== want) throw new Error(`a strip of ${rows} rows at ${this.rows} of ${this.height} (${want} expected)`);
        this.rows += rows;
        const p = Promise.resolve(this.run({ w: this.width, rows, predictor: this.predictor, ...source }, transfer));
        const tracked = p.then((r) => { this.inFlight.delete(tracked); return r; }, (err) => { this.inFlight.delete(tracked); if (!this.failed) this.failed = err; throw err; });
        tracked.catch(() => {});
        this.inFlight.add(tracked);
        this.parts.push(tracked);
    }

    async finish() {
        if (this.rows !== this.height) throw new Error(`${this.rows} of ${this.height} rows were written`);
        const replies = await Promise.all(this.parts);
        const n = replies.length;
        const counts = replies.map((r) => r.chunk.byteLength);
        const u16 = (...v) => { const b = new Uint8Array(v.length * 2); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint16(i * 2, x, true)); return b; };
        const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return b; };
        const software = new TextEncoder().encode("Scumble\0");
        // [tag, type, count, value bytes]; StripOffsets are filled in once the layout is known
        const entries = [
            [254, 4, 1, u32(0)],
            [256, 4, 1, u32(this.width)],
            [257, 4, 1, u32(this.height)],
            [258, 3, 4, u16(8, 8, 8, 8)],
            [259, 3, 1, u16(8)],                  // Adobe Deflate
            [262, 3, 1, u16(2)],                  // RGB
            [273, 4, n, new Uint8Array(4 * n)],
            [274, 3, 1, u16(1)],                  // top left
            [277, 3, 1, u16(4)],
            [278, 4, 1, u32(this.rps)],
            [279, 4, n, u32(...counts)],
            [282, 5, 1, u32(72, 1)],
            [283, 5, 1, u32(72, 1)],
            [284, 3, 1, u16(1)],                  // chunky
            [296, 3, 1, u16(2)],                  // inches
            [305, 2, software.length, software],
            [317, 3, 1, u16(this.predictor)],
            [338, 3, 1, u16(2)],                  // unassociated alpha
            [339, 3, 4, u16(1, 1, 1, 1)],
        ];
        const ifdSize = 2 + entries.length * 12 + 4;
        let at = 8 + ifdSize;
        const places = entries.map(([, , , v]) => {
            if (v.length <= 4) return -1;
            const p = at; at += v.length + (v.length & 1);
            return p;
        });
        const stripsAt = at;
        let total = stripsAt;
        const offsets = counts.map((c) => { const o = total; total += c; return o; });
        if (total > 0xFFFFFFFF) throw new Error("the TIFF would pass 4 GB, which needs BigTIFF; BigTIFF is not written, save it as PNG or PSD");
        entries[6][3] = u32(...offsets);
        const head = new Uint8Array(8 + ifdSize + (stripsAt - 8 - ifdSize));
        const d = new DataView(head.buffer);
        head[0] = 0x49; head[1] = 0x49; d.setUint16(2, 42, true); d.setUint32(4, 8, true);
        d.setUint16(8, entries.length, true);
        entries.forEach(([tag, type, count, v], i) => {
            const o = 10 + i * 12;
            d.setUint16(o, tag, true); d.setUint16(o + 2, type, true); d.setUint32(o + 4, count, true);
            if (places[i] < 0) head.set(v, o + 8);
            else { d.setUint32(o + 8, places[i], true); head.set(v, places[i]); }
        });
        d.setUint32(10 + entries.length * 12, 0, true);   // no next IFD
        return new Blob([head, ...replies.map((r) => r.chunk)], { type: "image/tiff" });
    }
}
