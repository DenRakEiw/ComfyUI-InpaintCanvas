/**
 * Layered export: PSD (Photoshop, 8-bit RGB, PackBits) and ORA (OpenRaster, the native
 * layered format of Krita and GIMP: a zip of PNGs plus stack.xml). Both take the same
 * description: { width, height, layers: [{ name, x, y, canvas, opacity, visible, blend }],
 * composite }. `layers` are bottom first, each canvas holds the layer's pixels at image
 * resolution (canvas.width × canvas.height placed at x, y); `composite` is the flattened
 * image. Filter layers cannot be represented and are left out by the caller.
 */

const PSD_BLEND = { normal: "norm", multiply: "mul ", screen: "scrn", overlay: "over", darken: "dark", lighten: "lite", "soft-light": "sLit", "hard-light": "hLit", difference: "diff" };
const ORA_BLEND = { normal: "svg:src-over", multiply: "svg:multiply", screen: "svg:screen", overlay: "svg:overlay", darken: "svg:darken", lighten: "svg:lighten", "soft-light": "svg:soft-light", "hard-light": "svg:hard-light", difference: "svg:difference" };

class ByteWriter {
    constructor() { this.chunks = []; this.size = 0; }
    push(u8) { this.chunks.push(u8); this.size += u8.length; }
    u8(v) { this.push(Uint8Array.of(v & 255)); }
    u16(v) { this.push(Uint8Array.of((v >> 8) & 255, v & 255)); }
    i16(v) { this.u16(v < 0 ? v + 0x10000 : v); }
    u32(v) { this.push(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
    i32(v) { this.u32(v < 0 ? v + 0x100000000 : v); }
    ascii(s) { this.push(new TextEncoder().encode(s)); }
    bytes() { const out = new Uint8Array(this.size); let p = 0; for (const c of this.chunks) { out.set(c, p); p += c.length; } return out; }
}

/** PackBits (RLE) of one row. */
function packBits(row) {
    const out = [];
    const n = row.length;
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && row[j + 1] === row[i] && j - i < 126) j++;
        const run = j - i + 1;
        if (run >= 2) { out.push(257 - run, row[i]); i = j + 1; continue; }
        let k = i;
        while (k < n && k - i < 128) { if (k + 1 < n && row[k + 1] === row[k]) break; k++; }
        if (k === i) k = i + 1;
        out.push(k - i - 1);
        for (let m = i; m < k; m++) out.push(row[m]);
        i = k;
    }
    return Uint8Array.from(out);
}

/** Split an RGBA canvas into planar channels [R, G, B, A], each w*h bytes. */
function planes(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const r = new Uint8Array(w * h), g = new Uint8Array(w * h), b = new Uint8Array(w * h), a = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        const al = d[i + 3];
        // PSD stores straight (un-premultiplied) colour; the canvas gives premultiplied-looking values only where alpha is 0
        r[p] = d[i]; g[p] = d[i + 1]; b[p] = d[i + 2]; a[p] = al;
    }
    return [r, g, b, a];
}

/** PackBits-compressed channel: [rowLengths (2 bytes each), data] */
function packPlane(plane, w, h) {
    const rows = [];
    let total = 0;
    for (let y = 0; y < h; y++) { const packed = packBits(plane.subarray(y * w, (y + 1) * w)); rows.push(packed); total += packed.length; }
    return { rows, total };
}

function pascal(name, pad) {
    const bytes = new TextEncoder().encode(String(name || "Layer").replace(/[^\x20-\x7e]/g, "_").slice(0, 255));
    const len = 1 + bytes.length;
    const padded = Math.ceil(len / pad) * pad;
    const out = new Uint8Array(padded);
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
}

/** Build a PSD file (Blob) from the layered description. */
export function buildPsd({ width, height, layers, composite }) {
    const w = new ByteWriter();
    w.ascii("8BPS"); w.u16(1); w.push(new Uint8Array(6)); w.u16(3); w.u32(height); w.u32(width); w.u16(8); w.u16(3);
    w.u32(0);   // colour mode data
    w.u32(0);   // image resources
    // layer records + channel data
    const records = new ByteWriter();
    const channelData = new ByteWriter();
    records.i16(layers.length);
    for (const L of layers) {
        const lw = L.canvas.width, lh = L.canvas.height;
        const [r, g, b, a] = planes(L.canvas);
        const packed = [[-1, packPlane(a, lw, lh)], [0, packPlane(r, lw, lh)], [1, packPlane(g, lw, lh)], [2, packPlane(b, lw, lh)]];
        records.i32(L.y); records.i32(L.x); records.i32(L.y + lh); records.i32(L.x + lw);
        records.u16(4);
        for (const [id, pk] of packed) { records.i16(id); records.u32(2 + 2 * lh + pk.total); }
        records.ascii("8BIM");
        records.ascii(PSD_BLEND[L.blend] || "norm");
        records.u8(Math.round(Math.max(0, Math.min(1, L.opacity ?? 1)) * 255));
        records.u8(0);
        records.u8(L.visible === false ? 2 : 0);
        records.u8(0);
        const name = pascal(L.name, 4);
        records.u32(4 + 4 + name.length);
        records.u32(0); records.u32(0);
        records.push(name);
        for (const [, pk] of packed) {
            channelData.u16(1);
            for (const row of pk.rows) channelData.u16(row.length);
            for (const row of pk.rows) channelData.push(row);
        }
    }
    let layerInfoLen = records.size + channelData.size;
    const padLayerInfo = layerInfoLen % 2;
    layerInfoLen += padLayerInfo;
    w.u32(4 + layerInfoLen + 4);
    w.u32(layerInfoLen);
    w.push(records.bytes());
    w.push(channelData.bytes());
    if (padLayerInfo) w.u8(0);
    w.u32(0);   // global layer mask info
    // merged image: RGB, PackBits, all row lengths first
    const [cr, cg, cb] = planes(composite);
    const cp = [packPlane(cr, width, height), packPlane(cg, width, height), packPlane(cb, width, height)];
    w.u16(1);
    for (const pk of cp) for (const row of pk.rows) w.u16(row.length);
    for (const pk of cp) for (const row of pk.rows) w.push(row);
    return new Blob([w.bytes()], { type: "image/vnd.adobe.photoshop" });
}

// ---- zip (stored) for ORA ---------------------------------------------------------

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function le16(v) { return Uint8Array.of(v & 255, (v >> 8) & 255); }
function le32(v) { return Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

/** A zip archive with stored (uncompressed) entries: [{ name, data: Uint8Array }]. */
export function zipStore(entries) {
    const w = new ByteWriter();
    const central = new ByteWriter();
    let count = 0;
    for (const e of entries) {
        const name = new TextEncoder().encode(e.name);
        const data = e.data;
        const crc = crc32(data);
        const offset = w.size;
        w.push(le32(0x04034b50)); w.push(le16(20)); w.push(le16(0x0800)); w.push(le16(0)); w.push(le16(0)); w.push(le16(0x21));
        w.push(le32(crc)); w.push(le32(data.length)); w.push(le32(data.length)); w.push(le16(name.length)); w.push(le16(0));
        w.push(name); w.push(data);
        central.push(le32(0x02014b50)); central.push(le16(20)); central.push(le16(20)); central.push(le16(0x0800)); central.push(le16(0)); central.push(le16(0)); central.push(le16(0x21));
        central.push(le32(crc)); central.push(le32(data.length)); central.push(le32(data.length)); central.push(le16(name.length)); central.push(le16(0)); central.push(le16(0));
        central.push(le16(0)); central.push(le16(0)); central.push(le32(0)); central.push(le32(offset)); central.push(name);
        count++;
    }
    const cdOffset = w.size;
    w.push(central.bytes());
    const cdSize = w.size - cdOffset;
    w.push(le32(0x06054b50)); w.push(le16(0)); w.push(le16(0)); w.push(le16(count)); w.push(le16(count)); w.push(le32(cdSize)); w.push(le32(cdOffset)); w.push(le16(0));
    return w.bytes();
}

function pngBytes(canvas) {
    return new Promise((resolve) => canvas.toBlob((b) => b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))), "image/png"));
}

function xmlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** Build an OpenRaster file (Blob). Krita and GIMP open it with all layers. */
export async function buildOra({ width, height, layers, composite }) {
    const entries = [{ name: "mimetype", data: new TextEncoder().encode("image/openraster") }];
    const stackLines = [];
    // ORA lists layers top first
    for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        const file = `data/layer${i}.png`;
        entries.push({ name: file, data: await pngBytes(L.canvas) });
        stackLines.push(`    <layer name="${xmlEsc(L.name || "Layer")}" src="${file}" x="${L.x}" y="${L.y}" opacity="${(L.opacity ?? 1).toFixed(3)}" visibility="${L.visible === false ? "hidden" : "visible"}" composite-op="${ORA_BLEND[L.blend] || "svg:src-over"}" />`);
    }
    const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${width}" h="${height}" xres="72" yres="72">\n  <stack>\n${stackLines.join("\n")}\n  </stack>\n</image>\n`;
    entries.push({ name: "stack.xml", data: new TextEncoder().encode(stack) });
    entries.push({ name: "mergedimage.png", data: await pngBytes(composite) });
    const ts = Math.min(1, 256 / Math.max(width, height));
    const thumb = document.createElement("canvas");
    thumb.width = Math.max(1, Math.round(width * ts)); thumb.height = Math.max(1, Math.round(height * ts));
    thumb.getContext("2d").drawImage(composite, 0, 0, thumb.width, thumb.height);
    entries.push({ name: "Thumbnails/thumbnail.png", data: await pngBytes(thumb) });
    return new Blob([zipStore(entries)], { type: "image/openraster" });
}
