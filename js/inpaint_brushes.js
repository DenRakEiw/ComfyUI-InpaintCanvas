// Generated from DenRakEiw/scumble renderer/editor/inpaint_brushes.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * Brush tips from Photoshop .abr files.
 *
 * Adobe never published the brush format. This reader follows GIMP's `gimpbrush-load.c` and
 * scurest/abrupng (both GPL-3.0, like this node), which are the reverse-engineered readers
 * everyone else builds on:
 *   https://gitlab.gnome.org/GNOME/gimp/-/blob/master/app/core/gimpbrush-load.c
 *   https://github.com/scurest/abrupng
 * The names, spacings and diameters of version 6 / 10 files come from the `desc` block, an
 * Action Descriptor in the structure the Photoshop File Formats Specification documents for
 * PSD ("Descriptor structure"); neither GIMP nor abrupng reads it, both name the tips by index.
 *
 * Two shapes exist. Versions 1 and 2 are a flat list of brushes; versions 6 and 10 are a
 * container of `8BIM` blocks: `samp` holds the sampled bitmaps (each entry starts with the
 * brush's UUID), `desc` the presets that reference them by that UUID (several presets may
 * share one bitmap), `patt` the patterns. Only *sampled* brushes carry a bitmap; the round
 * "computed" brushes are parameters, which the editor already has as its own round tip, so
 * they are skipped and counted.
 *
 * A tip is 8-bit coverage, row major, read straight through the way GIMP reads it: the
 * stored value *is* the alpha, high means paint. Checked on 2026-09-12 against Photoshop
 * 2026's own packs (Default Brushes 6.2, Legacy Brushes 10.2, Converted Legacy Tool Presets
 * 10.2) and a 377 MB third-party 6.2 pack: every `samp` entry's UUID is referenced by the
 * `desc` block and the descriptor parser consumes the block to its last byte.
 */

/** Big-endian reader over an ArrayBuffer. */
class Reader {
    constructor(buffer, pos = 0) {
        this.view = new DataView(buffer);
        this.bytes = new Uint8Array(buffer);
        this.pos = pos;
    }
    get length() { return this.bytes.length; }
    need(n) { if (this.pos + n > this.bytes.length) throw new Error("the file ends in the middle of a brush"); }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
    u16() { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, false); this.pos += 4; return v; }
    i32() { this.need(4); const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
    f64() { this.need(8); const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }
    tag() { this.need(4); let s = ""; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.bytes[this.pos + i]); this.pos += 4; return s; }
    skip(n) { this.pos += n; if (this.pos > this.bytes.length) throw new Error("the file ends in the middle of a brush"); }
    raw(n) { this.need(n); const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    /** A Pascal string: one length byte, then the characters. */
    pstr() { const n = this.u8(); const b = this.raw(n); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]); return s; }
    /** A UCS-2 string with a 32-bit character count, the terminating null dropped. */
    ustr() { const n = this.u32(); this.need(n * 2); let s = ""; for (let i = 0; i < n; i++) { const c = this.view.getUint16(this.pos, false); this.pos += 2; if (c) s += String.fromCharCode(c); } return s; }
    /** A descriptor key: a 32-bit length, zero meaning a four-character id. */
    key() { const n = this.u32(); if (n === 0) return this.tag(); const b = this.raw(n); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]); return s; }
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
    let computed = 0;
    let pos = r.pos;
    for (let i = 0; i < count; i++) {
        r.pos = pos;
        if (r.pos + 2 > r.length) break;
        const len = r.u16();
        pos = r.pos + len;
        try {
            const type = r.u16();
            if (type !== 2) { if (type === 1) computed++; continue; }   // 1 = computed (a round tip), no bitmap
            r.u32();                           // misc
            const spacing = r.u16();
            let name = "";
            if (version === 2) name = r.ustr();   // the name, a UCS-2 string
            r.u8();                            // antialiasing
            const top = r.u16(), left = r.u16(), bottom = r.u16(), right = r.u16();
            r.skip(16);                        // the same bounds again as 32-bit values
            const depth = r.u16();
            if (depth !== 8) continue;
            const compressed = r.u8() !== 0;
            const width = right - left, height = bottom - top;
            if (width <= 0 || height <= 0) continue;
            out.push({ width, height, spacing: spacing / 100, name, uuid: "", data: bitmap(r, width, height, depth, compressed) });
        } catch (_) {
            break;                             // a broken brush ends the file for us
        }
    }
    return { brushes: out, computed, presets: out.length + computed };
}

/** The 8BIM blocks of a version 6 / 10 file: key -> [start, length]. Blocks are padded to four bytes. */
function blocks(r) {
    const out = new Map();
    while (r.pos + 12 <= r.length) {
        r.tag();                               // the signature, normally 8BIM
        const key = r.tag();
        const len = r.u32();
        if (!out.has(key)) out.set(key, [r.pos, len]);
        r.pos = (r.pos + len + 3) & ~3;
    }
    return out;
}

/** The sampled brushes of the `samp` block: the UUID (a Pascal string), a version-dependent header, the bounds and the bitmap. */
function sampled(r, end, subversion) {
    const out = [];
    let pos = r.pos;
    while (pos < end) {
        r.pos = pos;
        if (r.pos + 4 > end) break;
        const len = r.u32();
        pos = (r.pos + len + 3) & ~3;          // brushes are padded to four bytes
        try {
            const start = r.pos;
            const uuid = r.pstr();
            r.pos = start + (subversion === 1 ? 47 : 301);
            const top = r.u32(), left = r.u32(), bottom = r.u32(), right = r.u32();
            const depth = r.u16();
            if (depth !== 8) continue;
            const compressed = r.u8() !== 0;
            const width = right - left, height = bottom - top;
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) continue;
            out.push({ width, height, spacing: 0, name: "", uuid, data: bitmap(r, width, height, depth, compressed) });
        } catch (_) {
            break;
        }
    }
    return out;
}

/** One value of an Action Descriptor, by its four-character type. Throws on a type this reader does not know. */
function descItem(r) {
    const t = r.tag();
    switch (t) {
        case "Objc": case "GlbO": return descriptor(r);
        case "VlLs": { const n = r.u32(); const a = []; for (let i = 0; i < n; i++) a.push(descItem(r)); return a; }
        case "doub": return r.f64();
        case "UntF": { const unit = r.tag(); return { unit, value: r.f64() }; }
        case "TEXT": return r.ustr();
        case "enum": return { type: r.key(), value: r.key() };
        case "long": return r.i32();
        case "comp": { const hi = r.i32(), lo = r.u32(); return hi * 4294967296 + lo; }
        case "bool": return !!r.u8();
        case "type": case "GlbC": return { name: r.ustr(), cls: r.key() };
        case "alis": case "tdta": { const n = r.u32(); r.skip(n); return { bytes: n }; }
        case "obj ": {
            const n = r.u32();
            for (let i = 0; i < n; i++) {
                const kind = r.tag();
                if (kind === "prop") { r.ustr(); r.key(); r.key(); }
                else if (kind === "Clss") { r.ustr(); r.key(); }
                else if (kind === "Enmr") { r.ustr(); r.key(); r.key(); r.key(); }
                else if (kind === "rele" || kind === "indx" || kind === "Idnt") { r.ustr(); r.key(); r.u32(); }
                else if (kind === "name") { r.ustr(); r.key(); r.ustr(); }
                else throw new Error(`descriptor reference ${kind}`);
            }
            return { reference: n };
        }
        case "ObAr": { const n = r.u32(); r.ustr(); r.key(); const m = r.u32(); const out = { _count: n }; for (let i = 0; i < m; i++) { const k = r.key(); out[k] = descItem(r); } return out; }
        default: throw new Error(`descriptor type "${t}" at ${r.pos - 4}`);
    }
}

/** An Action Descriptor: a name, a class id, then key / value items. */
function descriptor(r) {
    r.ustr();                                  // the class name, usually empty
    const cls = r.key();
    const n = r.u32();
    const out = { _class: cls };
    for (let i = 0; i < n; i++) { const k = r.key(); out[k] = descItem(r); }
    return out;
}

/** "$$$/Presets/Brushes/Spatter14pixels=Spatter 14 pixels" -> "Spatter 14 pixels". */
function presetName(v) {
    const s = String(v || "");
    const i = s.indexOf("=");
    return (i >= 0 && s.startsWith("$$$/") ? s.slice(i + 1) : s).trim();
}

/**
 * The presets of the `desc` block, keyed by the UUID of the sampled bitmap they use. A
 * computed preset (no `sampledData`) is only counted. Returns null when the block is missing
 * or the descriptor cannot be read, in which case the tips keep their index names.
 */
function readDesc(buffer, block, warnings) {
    if (!block) return null;
    try {
        const r = new Reader(buffer, block[0]);
        const version = r.u32();
        if (version !== 16) throw new Error(`descriptor version ${version}`);
        const top = descriptor(r);
        const list = Array.isArray(top.Brsh) ? top.Brsh : [];
        const byUuid = new Map();
        let computed = 0;
        const num = (v) => (v && typeof v === "object" && "value" in v ? +v.value : (typeof v === "number" ? v : NaN));
        const entryOf = (b, name) => ({ name, spacing: num(b.Spcn), diameter: num(b.Dmtr), angle: num(b.Angl), roundness: num(b.Rndn), flipX: !!b.flipX, flipY: !!b.flipY });
        const secondary = [];   // dual-brush tips and the like: named after their preset, registered after the primaries
        const collect = (v, name, depth) => {
            if (!v || typeof v !== "object" || depth > 6) return;
            if (Array.isArray(v)) { for (const x of v) collect(x, name, depth + 1); return; }
            if (typeof v.sampledData === "string") secondary.push([v.sampledData, entryOf(v, name)]);
            for (const k of Object.keys(v)) if (k !== "Brsh" || depth > 0) collect(v[k], name, depth + 1);   // the preset's own Brsh is the primary; a dualBrush holds its tip under Brsh too
        };
        for (const p of list) {
            const b = p && p.Brsh;
            if (!b || typeof b !== "object") continue;
            const name = presetName(p["Nm  "]);
            const uuid = typeof b.sampledData === "string" ? b.sampledData : "";
            if (!uuid) computed++;
            else if (!byUuid.has(uuid)) byUuid.set(uuid, entryOf(b, name));
            else byUuid.get(uuid).others = (byUuid.get(uuid).others || 0) + 1;
            collect(p, name ? `${name} (dual)` : "", 0);
        }
        for (const [uuid, entry] of secondary) if (!byUuid.has(uuid)) byUuid.set(uuid, entry);
        if (r.pos !== block[0] + block[1]) warnings.push(`the desc block was read to byte ${r.pos - block[0]} of ${block[1]}`);
        return { byUuid, presets: list.length, computed };
    } catch (err) {
        warnings.push(`desc block not read: ${err.message || err}`);
        return null;
    }
}

/** Versions 6 and 10: the `samp` block's bitmaps, named and spaced from the `desc` block. */
function readV6(buffer, r, subversion, warnings) {
    const map = blocks(r);
    const samp = map.get("samp");
    if (!samp) throw new Error("no sampled brushes in this file (it may hold only computed tips)");
    r.pos = samp[0];
    const brushes = sampled(r, Math.min(r.length, samp[0] + samp[1]), subversion);
    const desc = readDesc(buffer, map.get("desc"), warnings);
    let computed = 0, presets = brushes.length;
    if (desc) {
        computed = desc.computed;
        presets = desc.presets;
        let unmatched = 0;
        for (const b of brushes) {
            const p = desc.byUuid.get(b.uuid);
            if (!p) { unmatched++; continue; }
            b.name = p.name;
            if (p.spacing > 0) b.spacing = p.spacing / 100;
            b.diameter = p.diameter; b.angle = p.angle; b.roundness = p.roundness; b.flipX = p.flipX; b.flipY = p.flipY;
            if (p.others) b.presets = p.others + 1;
        }
        if (unmatched) warnings.push(`${unmatched} bitmap${unmatched === 1 ? "" : "s"} not referenced by any preset`);
    }
    return { brushes, computed, presets };
}

/**
 * Every sampled tip in an .abr file, as `{ width, height, spacing, name, uuid, data }` with
 * `data` an 8-bit coverage map and `spacing` a fraction of the tip's size (0 when the file has
 * none). `computed` counts the parametric round tips that were skipped, `presets` the entries
 * the file lists, `warnings` what could not be read. Throws when the version is one we cannot
 * read or the file holds no bitmap at all.
 */
export function readAbr(buffer) {
    const r = new Reader(buffer);
    const version = r.u16();
    const second = r.u16();
    const warnings = [];
    let res;
    if (version === 1 || version === 2) res = readV1(r, version, second);
    else if ((version === 6 || version === 10) && (second === 1 || second === 2)) res = readV6(buffer, r, second, warnings);
    else throw new Error(`.abr version ${version}.${second} is not one this reader knows (1, 2, 6 and 10 are)`);
    if (!res.brushes.length) throw new Error(res.computed ? `only computed (round) tips in this file, ${res.computed} of them; the editor's own round dab covers those` : "no bitmap tips in this file");
    return { version, subversion: second, brushes: res.brushes, computed: res.computed, presets: res.presets, warnings };
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
