// Generated from DenRakEiw/scumble renderer/editor/inpaint_load.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// file and image loading (viewUrl, SVG, TIFF, the PNG stream, pixelsFromImageFile, tileDiffBox, clampRect): moved out of inpaint_canvas.js (item 56 S2, docs/PLAN_SPLIT.md), text unchanged.

import { api } from "./host.js";
import { tiffKernels } from "./px/kernels.js";
import { CancelledError, NORMAL } from "./inpaint_pool.js";
import { pngHeader, pngPartsOf, readPngParts } from "./inpaint_png.js";
import { bandRows } from "./inpaint_bands.js";
import { TIFF_EXT, isTiff, readTiff, readTiffBands } from "./inpaint_tiff.js";
import { CANVAS_MAX_PIXELS, TILE_SIZE } from "./inpaint_tiles.js";
import { editorPool } from "./inpaint_jobs.js";
import { partsUsable } from "./inpaint_encode.js";
import { isOra, isPsd } from "./inpaint_layered.js";
import { canvasRoundTrip } from "./inpaint_resample.js";
import { makeCanvas } from "./inpaint_consts.js";

let InpaintEditor = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function viewUrl(ref) {
    const p = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder || "",
        type: ref.type || "input",
    });
    return api.apiURL("/view?" + p.toString());
}

/** A ref's mirror key ("type/subfolder/filename", as the host's referencedFileKeys and the clean-up write it). */
function refKey(ref) {
    return ref && typeof ref.filename === "string" ? `${ref.type || "input"}/${ref.subfolder || ""}/${ref.filename}` : "";
}

/**
 * Is this file gone from the store /view reads (the app's local store, which asks a connected ComfyUI for what it lacks;
 * the node's ComfyUI)? A HEAD request: true only on a 404, so a failed request or another answer leaves the file be.
 */
async function fileGone(ref) {
    try {
        const r = await fetch(viewUrl(ref), { method: "HEAD", cache: "no-store" });
        return r.status === 404;
    } catch (_) {
        return false;
    }
}

/** An undo snapshot's image: the URL may still be encoding when undo is pressed. */
async function snapImage(u) {
    return loadImageEl(typeof u === "string" ? u : await u);
}

/** An image `loadSnapImages` decoded for a restore; a missing one is a bug, not an empty picture. */
function needImage(img) {
    if (!img) throw new Error("the step's image was not loaded");
    return img;
}

function loadImageEl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Inpaint Canvas: could not load " + src));
        img.src = src;
    });
}

// ---- SVG: a vector drawing has no pixel size of its own, so it is rasterised on the way in -----
// The upload, the mirror and the server only ever see the PNG; a reload finds pixels, not a
// file that needs a size again. An <img> would render a sizeless SVG at 300 x 150.
const SVG_RE = /\.svg$/i;
function isSvgFile(file) { return !!file && (file.type === "image/svg+xml" || SVG_RE.test(file.name || "")); }

/** "psd" or "ora" when the file is one (by its first bytes, whatever its name or type says), else null. */
async function layeredKind(file) {
    if (!file || typeof file.slice !== "function") return null;
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    return isPsd(head) ? "psd" : isOra(head) ? "ora" : null;
}

/**
 * The extension a file is stored under: its own, except for a file named as a TIFF that is none (a PNG, JPEG or WebP
 * renamed), which goes under what its bytes are, so the local store holds no ".tif" (3d). A file named as a TIFF that
 * is no picture the editor reads is refused here, before anything is stored.
 */
async function storedExt(file) {
    const ext = ((file.name || "").match(/\.[a-z0-9]+$/i) || [".png"])[0];
    if (!TIFF_EXT.test(ext)) return ext;
    const kind = await imageFileSize(file);
    if (!kind) throw new Error(`${file.name} is not a TIFF file, nor another picture Scumble reads`);
    return kind.type === "jpeg" ? ".jpg" : "." + kind.type;
}

/** Is the file a TIFF (by its first bytes, whatever its name or type says)? */
async function isTiffFile(file) {
    if (!file || typeof file.slice !== "function") return false;
    return isTiff(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
}

function tiffPoolUsable(blob) {
    return typeof Worker === "function" && typeof Blob === "function" && blob instanceof Blob && !editorPool().off;
}

/**
 * The pixels of a TIFF (inpaint_tiff.js `readTiffBands` / `readTiff`, docs/PLAN_0_1_29.md 3d, docs/PLAN_WASM_BUILD.md
 * §4.6 K18), decoded in parallel bands (`tiff_band` at `NORMAL` priority) across the worker pool and written into this
 * backend's pixels with `writeRect` as each band lands, falling back to `tiff_read` on streamed files or any band error
 * (and to the window without a pool): `{ px, info, writeMs }`. `later()` true stops the open, cancels the group and
 * releases partial pixels without falling back.
 */
async function pixelsFromTiff(blob, Cls, progress = null, later = null) {
    const isLater = typeof later === "function" ? later : null;
    if (isLater && isLater()) throw new CancelledError("tiff_open");
    const bandSetting = InpaintEditor.tiffBandRows;
    const rowsPerBand = bandSetting > 0 ? (bandSetting | 0) : TILE_SIZE;
    let px = null, W = 0, H = 0, info = null, writeMs = 0, rowsDone = 0;
    const resetTarget = () => {
        if (px) { px.release(); px = null; }
        W = 0; H = 0; writeMs = 0; rowsDone = 0;
    };
    const header = (h) => {
        if (isLater && isLater()) throw new CancelledError("tiff_open");
        W = h.width; H = h.height; px = Cls.empty(W, H);
    };
    const rows = (rgba, y0, n) => {
        if (isLater && isLater()) {
            try { if (rgba && rgba.buffer && typeof rgba.buffer.transfer === "function") rgba.buffer.transfer(0); } catch (_) { /* ignore */ }
            throw new CancelledError("tiff_open");
        }
        const t0 = performance.now();
        px.writeRect({ data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, n * W * 4), width: W, height: n }, 0, y0);
        writeMs += performance.now() - t0;
        try {
            if (rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength && typeof rgba.buffer.transfer === "function") {
                rgba.buffer.transfer(0);
            }
        } catch (_) { /* ignore */ }
        rowsDone += n;
        if (progress) progress(rowsDone / H);
    };
    if (bandSetting !== false && tiffPoolUsable(blob)) {
        try {
            info = await readTiffBands(blob, {
                pool: editorPool(),
                rowsPerBand,
                priority: NORMAL,
                later: isLater,
                onHeader: header,
                onRows: rows,
            });
            if (info) {
                if (isLater && isLater()) { resetTarget(); throw new CancelledError("tiff_open"); }
                if (!px) throw new Error("the TIFF gave no pixels");
                return { px, info, writeMs };
            }
        } catch (err) {
            resetTarget();
            if ((err && err.cancelled) || (isLater && isLater())) throw new CancelledError("tiff_open");
            console.warn("Inpaint Canvas: reading the TIFF in bands failed, using tiff_read:", (err && err.message) || err);
        }
    }
    try {
        if (tiffPoolUsable(blob)) {
            let needWindowFallback = false;
            try {
                const r = await editorPool().run("tiff_read", { blob, rowsPerBand }, [], {
                    priority: NORMAL,
                    timeout: 600000,
                    onProgress: (m) => {
                        if (m.header) header(m.header);
                        else rows(new Uint8Array(m.rgba), m.y0, m.rows);
                    },
                });
                info = r.info;
            } catch (err) {
                if ((err && err.cancelled) || (isLater && isLater())) throw new CancelledError("tiff_open");
                if (editorPool().off && !px) needWindowFallback = true;
                else throw err;
            }
            if (needWindowFallback) {
                info = await readTiff(blob, { rowsPerBand, onHeader: header, onRows: rows, kernels: tiffKernels() });
            }
        } else {
            info = await readTiff(blob, { rowsPerBand, onHeader: header, onRows: rows, kernels: tiffKernels() });
        }
    } catch (err) {
        resetTarget();
        if ((err && err.cancelled) || (isLater && isLater())) throw new CancelledError("tiff_open");
        throw err;
    }
    if (isLater && isLater()) { resetTarget(); throw new CancelledError("tiff_open"); }
    if (!px) throw new Error("the TIFF gave no pixels");
    return { px, info, writeMs };
}

/**
 * D0 (docs/PLAN_WASM_BUILD.md §7): a PSD goes to a pool worker (`readPsdOnPool`) unless `InpaintEditor.psdOnPool` is
 * false (a harness's twin of the window's reader), the pool is off or there is none, or the file is not a Blob the job
 * can take; the window's reader is the fallback.
 */
function psdOnPool(file) {
    return InpaintEditor.psdOnPool !== false && typeof Worker === "function" && typeof Blob === "function" && file instanceof Blob && !editorPool().off;
}

/** The size an SVG declares: width / height attributes (px, pt, mm, cm, in, pc at 96 dpi), else the viewBox. */
function svgSize(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg") throw new Error("not an SVG file");
    const len = (v) => {
        const m = /^\s*([\d.]+)\s*(px|pt|mm|cm|in|pc)?\s*$/i.exec(v || "");
        if (!m) return 0;   // percentages and em are not a pixel size
        return +m[1] * ({ px: 1, pt: 96 / 72, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pc: 16 }[(m[2] || "px").toLowerCase()]);
    };
    let w = len(svg.getAttribute("width")), h = len(svg.getAttribute("height"));
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const vbw = vb.length === 4 && vb[2] > 0 ? vb[2] : 0, vbh = vb.length === 4 && vb[3] > 0 ? vb[3] : 0;
    const declared = w > 0 && h > 0;
    if (!(w > 0) && !(h > 0)) { w = vbw; h = vbh; }
    else if (!(w > 0)) w = vbh > 0 ? h * vbw / vbh : h;
    else if (!(h > 0)) h = vbw > 0 ? w * vbh / vbw : w;
    if (!(w > 0) || !(h > 0)) { w = 300; h = 150; }
    return { width: w, height: h, declared, viewBox: vbw > 0 && vbh > 0, doc };
}

/** Rasterise an SVG file into a PNG File of exactly width x height (the caller keeps the aspect). */
async function rasterizeSvg(file, { width, height }) {
    const text = await file.text();
    const info = svgSize(text);
    const svg = info.doc.documentElement;
    // without a viewBox the user units are pixels and a new width / height would crop instead of scale
    if (!info.viewBox) svg.setAttribute("viewBox", `0 0 ${info.width} ${info.height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
        const img = await loadImageEl(url);
        const c = makeCanvas(width, height);
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        const png = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the rasterised SVG"))), "image/png"));
        return new File([png], (file.name || "image.svg").replace(SVG_RE, "") + ".png", { type: "image/png" });
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** "Not this way" from `programBand`: no GPU path for the filters of a band (the caller takes the region pass). */
const NO_PROGRAM = "no stack program here";

/**
 * A canvas as a row source (inpaint_bands.js). Up to 64 MP it is read once; above, band by band through a CPU canvas
 * (the canvas itself is never read back band by band: that would put Chromium's canvases in software, CLAUDE.md).
 */
function canvasRows(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w * h <= 64 * 1024 * 1024) {
        let all = null;
        return bandRows(w, h, (y0, y1) => {
            if (!all) all = canvas.getContext("2d").getImageData(0, 0, w, h).data;
            return all.subarray(y0 * w * 4, y1 * w * 4);
        }, TILE_SIZE);
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = TILE_SIZE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.globalCompositeOperation = "copy";
    // measured (3d, 2026-09-26): "copy" with smoothing on moves a quarter of the bytes by up to 2 levels even at the same
    // size (a 15000 px GPU canvas into this CPU one); without smoothing the band is the canvas's bytes
    ctx.imageSmoothingEnabled = false;
    return bandRows(w, h, (y0, y1) => {
        ctx.drawImage(canvas, 0, y0, w, y1 - y0, 0, 0, w, y1 - y0);
        return ctx.getImageData(0, 0, w, y1 - y0).data;
    }, TILE_SIZE);
}

/** E5: the most a document on tiles may be: a band of it is a canvas, and its base is 4 bytes a pixel of memory. */
const HUGE_MAX_SIDE = 65535;
const HUGE_MAX_PIXELS = 1024 * 1024 * 1024;

/** The name a layered file's picture is stored under, without an extension. */
function layeredStem(file) {
    return (file.name || "layered").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "layered";
}

function pngReaderUsable() {
    return InpaintEditor.pngParts !== false && typeof Worker === "function" && !editorPool().off;
}

/** `{ width, height }` when `blob` is a PNG larger than any canvas (above 268 MP), else null. */
async function hugePngSize(blob) {
    const h = pngHeader(new Uint8Array(await blob.slice(0, 33).arrayBuffer()));
    if (!h) return null;
    if (h.width * h.height > CANVAS_MAX_PIXELS) return { width: h.width, height: h.height };
    // B item 5: a large PNG that needs nothing of the browser's decoder but its inflater goes the same way. Through an
    // image it is decoded, drawn and read back in a dozen `getImageData` calls (2.1 s of blocked window at 150 MP); as
    // a stream the window never waits. Only what the reader reads exactly as the browser shows it: 8 bits, not
    // interlaced, and no colour profile, gamma or chromaticities, which the browser applies and the reader does not.
    const from = InpaintEditor.pngStreamFrom;
    if (!(from > 0) || h.width * h.height < from || h.bitDepth !== 8 || h.interlace || !pngReaderUsable()) return null;
    return (await pngIsPlainSrgb(blob)) ? { width: h.width, height: h.height } : null;
}

/** The chunks before the first IDAT hold no iCCP, gAMA, cHRM or cICP (an sRGB chunk is what the reader assumes anyway). */
async function pngIsPlainSrgb(blob) {
    for (let at = 8, n = 0; at + 8 <= blob.size && n < 64; n++) {
        const head = new Uint8Array(await blob.slice(at, at + 8).arrayBuffer());
        const len = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        if (type === "IDAT") return true;
        if (type === "iCCP" || type === "gAMA" || type === "cHRM" || type === "cICP" || type === "IEND") return false;
        at += 12 + len;
    }
    return false;
}

/**
 * The pixels of a PNG file decoded as a stream by a pool worker (inpaint_png.js `readPng`), or in parallel across the
 * pool when the file was written in parts by Scumble (`pngPartsOf` + `readPngParts`, docs/PLAN_WASM_BUILD.md §4.2, K8),
 * written into tile pixels band by band: for a picture larger than any canvas, or at least `InpaintEditor.pngStreamFrom`
 * pixels on tiles. JPEG and WebP have no such reader; above 268 MP they are refused where they are loaded, with a
 * message that names PNG.
 */
async function pixelsFromPngStream(blob, Cls, progress = null) {
    let px = null, W = 0, H = 0, layout = null;
    if (pngReaderUsable()) {
        layout = await pngPartsOf(blob);
        if (layout) {
            try {
                await readPngParts(blob, {
                    layout,
                    pool: editorPool(),
                    rt: canvasRoundTrip(),
                    onHeader: (h) => { W = h.width; H = h.height; px = Cls.empty(W, H); },
                    onRows: (rgba, y0, rows) => {
                        px.putCanvasRows(rgba, W, 0, y0, rows);
                        try { if (typeof rgba.buffer.transfer === "function") rgba.buffer.transfer(0); } catch (_) {}
                        if (progress) progress((y0 + rows) / H);
                    },
                });
                if (!px) throw new Error("the PNG gave no pixels");
                return px;
            } catch (err) {
                if (px) { px.release(); px = null; }
                console.warn("Inpaint Canvas: the PNG could not be read in parts, using png_read:", (err && err.message) || err);
            }
        }
    }
    try {
        await editorPool().run("png_read", { blob }, [], {
            timeout: 600000,
            onProgress: (m) => {
                if (m.header) { W = m.header.width; H = m.header.height; px = Cls.empty(W, H); return; }
                px.writeRect({ data: new Uint8ClampedArray(m.rgba), width: W, height: m.rows }, 0, m.y0);
                if (progress) progress((m.y0 + m.rows) / H);
            },
        });
    } catch (err) {
        if (px) px.release();
        if (layout && err && typeof err === "object") err.partedRefused = true;
        throw err;
    }
    if (!px) throw new Error("the PNG gave no pixels");
    return px;
}

/**
 * `{ width, height, type }` of an image file from its first bytes (PNG, JPEG, WebP), or null. The size is the stored
 * one: an EXIF orientation may swap the sides, never the pixel count.
 */
async function imageFileSize(blob) {
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const png = pngHeader(head);
    if (png) return { width: png.width, height: png.height, type: "png" };
    if (head.length >= 30 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
        const kind = String.fromCharCode(head[12], head[13], head[14], head[15]);
        if (kind === "VP8X") return { width: 1 + (head[24] | (head[25] << 8) | (head[26] << 16)), height: 1 + (head[27] | (head[28] << 8) | (head[29] << 16)), type: "webp" };
        if (kind === "VP8 ") return { width: (head[26] | (head[27] << 8)) & 0x3FFF, height: (head[28] | (head[29] << 8)) & 0x3FFF, type: "webp" };
        if (kind === "VP8L") {
            const b = head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24);
            return { width: 1 + (b & 0x3FFF), height: 1 + ((b >>> 14) & 0x3FFF), type: "webp" };
        }
        return null;
    }
    if (head[0] !== 0xFF || head[1] !== 0xD8) return null;
    // JPEG: the markers up to the first start of frame (SOF0 to SOF15 but DHT, JPG and DAC)
    for (let at = 2, n = 0; at + 4 <= blob.size && n < 256; n++) {
        const m = new Uint8Array(await blob.slice(at, at + 10).arrayBuffer());
        if (m[0] !== 0xFF) return null;
        const marker = m[1];
        if (marker === 0xFF) { at++; continue; }
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { at += 2; continue; }
        const len = (m[2] << 8) | m[3];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return m.length >= 9 ? { width: (m[7] << 8) | m[8], height: (m[5] << 8) | m[6], type: "jpeg" } : null;
        }
        if (marker === 0xDA || marker === 0xD9) return null;
        at += 2 + len;
    }
    return null;
}

/**
 * The pixels of a large image file decoded off the window (docs/BUGS.md: opening a large JPEG, WebP or a PNG with a
 * colour profile blocked the window for 1 to 4 s at 150 MP), or null for the <img> way: below
 * `InpaintEditor.imageWorkerFrom`, without the pool, and for what neither reader takes. A plain PNG goes through the
 * stream reader (B item 5), everything else the browser decodes in a pool worker (`image_read`). A failed job gives
 * null too, so the caller's <img> says what the browser makes of the file.
 */
async function pixelsOffThread(blob, Cls, progress = null) {
    const png = await hugePngSize(blob);
    if (png) {
        try {
            return await pixelsFromPngStream(blob, Cls, progress);
        } catch (err) {
            if ((err && err.partedRefused) || png.width * png.height > CANVAS_MAX_PIXELS) throw err;   // no <img> holds it, and a corrupt parted PNG is refused
            console.warn("Inpaint Canvas: the PNG could not be read as a stream, using an <img>:", (err && err.message) || err);
            return null;
        }
    }
    const from = InpaintEditor.imageWorkerFrom;
    if (!(from > 0) || !partsUsable()) return null;
    const size = await imageFileSize(blob);
    if (!size || size.width * size.height < from) return null;
    try {
        return await pixelsFromImageFile(blob, Cls, progress);
    } catch (err) {
        console.warn("Inpaint Canvas: the image could not be decoded in a worker, using an <img>:", (err && err.message) || err);
        return null;
    }
}

/** An <img> of a file already in hand (the fallback after `pixelsOffThread`), without reading it a second time. */
async function imageOfBlob(blob) {
    const url = URL.createObjectURL(blob);
    try { return await loadImageEl(url); } finally { URL.revokeObjectURL(url); }
}

/** An image file decoded by a pool worker (`image_read`) into tile pixels, band by band as it comes. */
async function pixelsFromImageFile(blob, Cls, progress = null) {
    let px = null, W = 0, H = 0;
    try {
        await editorPool().run("image_read", { blob }, [], {
            timeout: 600000,
            onProgress: (m) => {
                if (m.header) { W = m.header.width; H = m.header.height; px = Cls.empty(W, H); return; }
                px.putCanvasRows(new Uint8ClampedArray(m.rgba), W, 0, m.y0, m.rows);
                if (progress) progress((m.y0 + m.rows) / H);
            },
        });
    } catch (err) {
        if (px) px.release();
        throw err;
    }
    if (!px) throw new Error("the image gave no pixels");
    return px;
}

/**
 * The box ([x0, y0, x1, y1]) over the tiles two tile pixels of the same size do not share, or null when they share
 * every one: what a "copy" of `b` onto `a` changes.
 */
function tileDiffBox(a, b) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const keys = new Set([...a.tileKeys(), ...b.tileKeys()]);
    for (const key of keys) {
        const tx = key & 0xFFFF, ty = key >>> 16;
        if (a.tileAt(tx, ty) === b.tileAt(tx, ty)) continue;
        const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
        if (ox < x0) x0 = ox;
        if (oy < y0) y0 = oy;
        if (ox + TILE_SIZE > x1) x1 = ox + TILE_SIZE;
        if (oy + TILE_SIZE > y1) y1 = oy + TILE_SIZE;
    }
    return x1 < 0 ? null : [x0, y0, Math.min(a.width, x1), Math.min(a.height, y1)];
}

/** [x0, y0, x1, y1] clamped to w x h on whole pixels (outward); a box outside gives an empty one at the edge. */
function clampRect(r, w, h) {
    const x0 = Math.min(w, Math.max(0, Math.floor(r[0]))), y0 = Math.min(h, Math.max(0, Math.floor(r[1])));
    return [x0, y0, Math.max(x0, Math.min(w, Math.ceil(r[2]))), Math.max(y0, Math.min(h, Math.ceil(r[3])))];
}

export { HUGE_MAX_PIXELS, HUGE_MAX_SIDE, NO_PROGRAM, canvasRows, clampRect, fileGone, hugePngSize, imageFileSize, imageOfBlob, isSvgFile, isTiffFile, layeredKind, layeredStem, loadImageEl, needImage, pixelsFromPngStream, pixelsFromTiff, pixelsOffThread, pngIsPlainSrgb, pngReaderUsable, psdOnPool, rasterizeSvg, refKey, snapImage, storedExt, svgSize, tileDiffBox, viewUrl, bindLoad };

function bindLoad(C) { InpaintEditor = C; }
