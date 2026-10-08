// Generated from DenRakEiw/scumble renderer/editor/inpaint_arena.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The tile arena (docs/PLAN_BCE.md §E1): where a tile's 256 KB of pixels live.
 *
 * In a cross-origin isolated window (the app, whose scheme sends COOP / COEP) a tile's bytes are a view into a
 * `SharedArrayBuffer` chunk of 64 MB (256 slots), so the worker pool reads them without a copy: a job names a tile as
 * (chunk, slot) and every worker already holds the chunks (`arenaChunks`, `onArenaGrow`). Anywhere else (the node's
 * browser tab) every tile has an `ArrayBuffer` of its own, as before, and jobs copy.
 *
 * A slot goes back to its chunk's free stack when the tile object that holds it has been collected
 * (`FinalizationRegistry`): tiles are shared between pixels objects and undo steps and dropped by whoever lets go
 * last, so the arena never frees one by hand. A job that reads a slot holds the tile object until its answer is in,
 * so a slot is never handed out again while a worker may still read it. A chunk whose slots are all free again is
 * dropped (the workers are told), so closing a large document gives its memory back once it is collected.
 *
 * Slots start on 256 KB boundaries, so the bytes of every tile start on a page (the 4K aliasing rule of §B3).
 *
 * What a view into a `SharedArrayBuffer` cannot do in Chromium: back an `ImageData` (so `putImageData` needs a copy),
 * go into a `Blob`, or into `crypto.subtle`. `TypedArray.slice()` gives an unshared copy.
 */

export const SLOT_BYTES = 256 * 256 * 4;
export const SLOTS_PER_CHUNK = 256;
const CHUNK_BYTES = SLOT_BYTES * SLOTS_PER_CHUNK;

const canShare = () => typeof SharedArrayBuffer === "function" && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;

let ENABLED = null;   // null: decide at the first allocation
const chunks = [];    // index -> { sab, free: [slot], used } or null once dropped
const listeners = new Set();
let registry = null;

// `refused`: chunks the browser would not make (the tile got a buffer of its own); `failed`: tiles that got no bytes at
// all (PixelMemoryError)
const STATS = { slots: 0, chunks: 0, allocated: 0, freed: 0, droppedChunks: 0, refused: 0, failed: 0 };

/**
 * What an allocation past the renderer's limit on typed arrays becomes. Chromium gives a renderer about 15.5 GB of
 * `ArrayBuffer` and `SharedArrayBuffer` together (docs/PERFORMANCE.md §14, "The memory limits, measured": 18 full 15k
 * layers) and then throws `RangeError: Array buffer allocation failed`, which came out of whichever write needed a new
 * tile and said nothing a user could act on (docs/BUGS.md). This says what ran out and what gives it back. An operation
 * that catches its errors shows the message in the status line, as it does a canvas-limit refusal (checkCanvas in
 * inpaint_tiles.js); renderer/shell.js shows it for the ones nothing caught (a stroke, a timer), by `name`.
 */
export class PixelMemoryError extends Error {
    constructor() {
        const gb = STATS.chunks * CHUNK_BYTES / 2 ** 30;
        super("Inpaint Canvas: out of memory for pixels. This window holds as many as it can (about 15.5 GB"
            + (gb >= 1 ? `, ${gb.toFixed(1)} GB of them in layer tiles` : "")
            + "). Close a document, or lower the Undo history steps in Settings › Rendering (a deleted or merged layer is"
            + " kept by its undo step), then try again.");
        this.name = "PixelMemoryError";
    }
}

/** A tile's own buffer (no arena, or no room for a chunk): the browser's RangeError at the limit as a PixelMemoryError. */
function ownTileBytes() {
    try {
        return new Uint8ClampedArray(SLOT_BYTES);
    } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        STATS.failed++;
        throw new PixelMemoryError();
    }
}

/** Use the arena (default: when the page may share memory). A test switches it before any tile exists. */
export function setArenaEnabled(on) {
    ENABLED = on === null ? null : !!on && canShare();
}

export function arenaEnabled() {
    if (ENABLED === null) ENABLED = canShare();
    return ENABLED;
}

function release(held) {
    const c = chunks[held.chunk];
    if (!c) return;
    c.free.push(held.slot);
    c.used_[held.slot] = 1;   // it holds its last tile's pixels: zeroed when it is handed out again
    c.used--;
    STATS.slots--;
    STATS.freed++;
    // a chunk nobody uses is dropped, unless it is the last one left (the next tile would allocate it again)
    if (c.used === 0 && chunks.filter(Boolean).length > 1) {
        chunks[held.chunk] = null;
        STATS.chunks--;
        STATS.droppedChunks++;
        for (const fn of listeners) fn({ dropped: held.chunk });
    }
}

function newChunk() {
    const sab = new SharedArrayBuffer(CHUNK_BYTES);
    const free = [];
    for (let s = SLOTS_PER_CHUNK - 1; s >= 0; s--) free.push(s);
    let index = chunks.indexOf(null);
    if (index < 0) index = chunks.length;
    chunks[index] = { sab, free, used: 0, used_: new Uint8Array(SLOTS_PER_CHUNK) };
    STATS.chunks++;
    for (const fn of listeners) fn({ added: index, sab });
    return index;
}

/**
 * The bytes of a new tile (zeroed) for `owner`, the object that holds them: a `Uint8ClampedArray` of SLOT_BYTES, with
 * `arenaChunk` / `arenaSlot` set on `owner` when they live in the arena. Throws a PixelMemoryError at the renderer's
 * limit, and then `owner` is untouched.
 */
export function allocTileBytes(owner) {
    if (!arenaEnabled()) return ownTileBytes();
    if (!registry) registry = new FinalizationRegistry(release);
    let index = -1;
    for (let i = 0; i < chunks.length; i++) if (chunks[i] && chunks[i].free.length) { index = i; break; }
    if (index < 0) {
        // no room for another 64 MB in one piece: this tile gets a buffer of its own, as without the arena
        try { index = newChunk(); } catch (_) { STATS.refused++; return ownTileBytes(); }
    }
    const c = chunks[index];
    const slot = c.free.pop();
    c.used++;
    STATS.slots++;
    STATS.allocated++;
    const bytes = new Uint8ClampedArray(c.sab, slot * SLOT_BYTES, SLOT_BYTES);
    // a slot handed out again still holds its last tile's pixels; one of a new chunk is zero already, and zeroing it
    // anyway was a memset of the whole document when one is opened (2.4 GB at 30000 x 20000)
    if (c.used_[slot]) { bytes.fill(0); c.used_[slot] = 0; }
    owner.arenaChunk = index;
    owner.arenaSlot = slot;
    registry.register(owner, { chunk: index, slot });
    return bytes;
}

/** Every live chunk as [index, SharedArrayBuffer] (a worker gets them once, then the changes through `onArenaChange`). */
export function arenaChunks() {
    const out = [];
    chunks.forEach((c, i) => { if (c) out.push([i, c.sab]); });
    return out;
}

/** `fn({ added, sab })` when a chunk is made, `fn({ dropped })` when one is let go; returns the unsubscribe. */
export function onArenaChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function arenaStats() {
    return { ...STATS, enabled: arenaEnabled(), bytes: STATS.chunks * CHUNK_BYTES, freeSlots: chunks.reduce((n, c) => n + (c ? c.free.length : 0), 0) };
}

/** Is `bytes` a view into shared memory (so no `ImageData`, `Blob` or `crypto.subtle` over it)? */
export function isShared(bytes) {
    return typeof SharedArrayBuffer === "function" && bytes.buffer instanceof SharedArrayBuffer;
}
