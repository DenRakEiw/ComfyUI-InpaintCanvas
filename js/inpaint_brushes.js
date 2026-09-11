/**
 * Brush tips from Photoshop .abr files.
 *
 * Adobe never published the format. This reader follows GIMP's `gimpbrush-load.c` and
 * scurest/abrupng (both GPL-3.0, like this node), which are the reverse-engineered
 * readers everyone else builds on:
 *   https://gitlab.gnome.org/GNOME/gimp/-/blob/master/app/core/gimpbrush-load.c
 *   https://github.com/scurest/abrupng
 *
 * Two shapes exist. Versions 1 and 2 are a flat list of brushes; versions 6 and 10 are a
 * container of `8BIM` blocks whose `samp` block holds the sampled brushes. Only *sampled*
 * brushes carry a bitmap; the round "computed" brushes of version 1 are parameters, which
 * the editor already has as its own round tip, so they are skipped.
 *
 * A tip is 8-bit coverage, row major, read straight through the way GIMP reads it: the
 * stored value *is* the alpha, high means paint.
 */

/** Big-endian reader over an ArrayBuffer. */
class Reader {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.bytes = new Uint8Array(buffer);
        this.pos = 0;
    }
    get length() { return this.bytes.length; }
    need(n) { if (this.pos + n > this.bytes.length) throw new Error("the file ends in the middle of a brush"); }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
    u16() { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, false); this.pos += 4; return v; }
    tag() { this.need(4); let s = ""; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.bytes[this.pos + i]); this.pos += 4; return s; }
    skip(n) { this.pos += n; if (this.pos > this.bytes.length) throw new Error("the file ends in the middle of a brush"); }
    raw(n) { this.need(n); const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
}

/**
 * PackBits, one run of rows: `height` big-endian row lengths first, then that many bytes of
 * encoded data. A negative count repeats the next byte, a positive one copies literals, and
 * -128 is a no-op.
 */
function readRle(r, height, size) {
    let len = 0;
    for (let i = 0; i < height; i++) len += r.u16();
    const out = new Uint8Array(size);
    let o = 0, read = 0;
    while (read < len && o < size) {
        const n = r.i8();
        read++;
        if (n === -128) continue;
        if (n < 0) {
            const count = 1 - n;
            const b = r.u8();
            read++;
            for (let i = 0; i < count && o < size; i++) out[o++] = b;
        } else {
            const count = n + 1;
            const chunk = r.raw(count);
            read += count;
            for (let i = 0; i < count && o < size; i++) out[o++] = chunk[i];
        }
    }
    return out;
}

function bitmap(r, width, height, depth, compressed) {
    const size = width * height * (depth >> 3);
    if (!size || size > 64 * 1024 * 1024) throw new Error(`brush bitmap out of range (${width} x ${height})`);
    return compressed ? readRle(r, height, size) : r.raw(size).slice();
}

/** Versions 1 and 2: a count in the header, then that many brushes, each length prefixed. */
function readV1(r, version, count) {
    const out = [];
    let pos = r.pos;
    for (let i = 0; i < count; i++) {
        r.pos = pos;
        if (r.pos + 2 > r.length) break;
        const len = r.u16();
        pos = r.pos + len;
        try {
            const type = r.u16();
            if (type !== 2) continue;         // 1 = computed (a round tip), no bitmap
            r.u32();                           // misc
            const spacing = r.u16();
            if (version === 2) r.skip(2 * r.u32());   // the name, a UCS-2 string
            r.u8();                            // antialiasing
            const top = r.u16(), left = r.u16(), bottom = r.u16(), right = r.u16();
            r.skip(16);                        // the same bounds again as 32-bit values
            const depth = r.u16();
            if (depth !== 8) continue;
            const compressed = r.u8() !== 0;
            const width = right - left, height = bottom - top;
            if (width <= 0 || height <= 0) continue;
            out.push({ width, height, spacing, data: bitmap(r, width, height, depth, compressed) });
        } catch (_) {
            break;                             // a broken brush ends the file for us
        }
    }
    return out;
}

/** Versions 6 and 10: walk the 8BIM blocks to `samp`, then the brushes inside it. */
function readV6(r, subversion) {
    while (r.pos + 12 <= r.length) {
        r.tag();                               // the signature, normally 8BIM
        const key = r.tag();
        const len = r.u32();
        if (key === "samp") {
            const end = Math.min(r.length, r.pos + len);
            return sampled(r, end, subversion);
        }
        r.skip(len);
    }
    throw new Error("no sampled brushes in this file (it may hold only computed tips)");
}

function sampled(r, end, subversion) {
    const out = [];
    let pos = r.pos;
    while (pos < end) {
        r.pos = pos;
        if (r.pos + 4 > end) break;
        const len = r.u32();
        pos = (r.pos + len + 3) & ~3;          // brushes are padded to four bytes
        try {
            r.skip(subversion === 1 ? 47 : 301);
            const top = r.u32(), left = r.u32(), bottom = r.u32(), right = r.u32();
            const depth = r.u16();
            if (depth !== 8) continue;
            const compressed = r.u8() !== 0;
            const width = right - left, height = bottom - top;
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) continue;
            out.push({ width, height, spacing: 0, data: bitmap(r, width, height, depth, compressed) });
        } catch (_) {
            break;
        }
    }
    return out;
}

/**
 * Every sampled tip in an .abr file, as `{ width, height, spacing, data }` with `data` an
 * 8-bit coverage map. Throws when the version is one we cannot read.
 */
export function readAbr(buffer) {
    const r = new Reader(buffer);
    const version = r.u16();
    const second = r.u16();
    let brushes;
    if (version === 1 || version === 2) brushes = readV1(r, version, second);
    else if ((version === 6 || version === 10) && (second === 1 || second === 2)) brushes = readV6(r, second);
    else throw new Error(`.abr version ${version}.${second} is not one this reader knows (1, 2, 6 and 10 are)`);
    if (!brushes.length) throw new Error("no bitmap tips in this file");
    return { version, subversion: second, brushes };
}

/**
 * A tip as a canvas: black pixels whose alpha is the coverage, which is what the paint path
 * stamps and tints. `make` builds the canvas, so both hosts can pass their own helper.
 */
export function tipCanvas(tip, make) {
    const c = make(tip.width, tip.height);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(tip.width, tip.height);
    const d = img.data;
    for (let i = 0, j = 0; i < tip.data.length; i++, j += 4) {
        d[j] = 0; d[j + 1] = 0; d[j + 2] = 0; d[j + 3] = tip.data[i];
    }
    ctx.putImageData(img, 0, 0);
    return c;
}
