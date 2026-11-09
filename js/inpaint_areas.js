// Generated from DenRakEiw/scumble renderer/editor/inpaint_areas.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The separate areas of a selection (CLAUDE.md item 54, issue #9): a selection of several areas apart (people selected
// by text, say) goes as one crop of all of them, scaled down to the model's size, so each area comes back soft. The app
// counts the areas to say so and to run each one on its own (eacharea.js); this module is the arithmetic of it, pure: no
// editor, no canvas, no DOM. The editor's worker (inpaint_worker.js, its `area_cells` job) counts a selection's tiles
// with it, and the window counts the same way where there is no pool.
//
//   areaCell(W, H)          the side of a cell of the coarse grid (a power of two, the grid at most 1024 cells a side)
//   speckPixels(W, H)       the smallest area that counts; anything smaller is a speck and is left out
//   countTileCells(...)     a 256 x 256 RGBA tile's selected pixels (alpha 128 and more) added to the grid's cells
//   countRowCells(...)      the same for rows of RGBA bytes (a readback of the selection)
//   labelParts(...)         the grid's 8-connected parts: their boxes in image pixels and their selected pixels
//   groupAreas(...)         the parts whose crops would overlap joined into one area, each area's crop and reach
//
// A cell holds the count of its selected pixels, so a part's pixels are exact on tiles; its box is the cells' box, up to
// one cell larger than the selected pixels on each side.

/** The longest side of the coarse grid, in cells. */
export const AREA_GRID_MAX = 1024;

/** The side of a cell of the coarse grid in image pixels: the smallest power of two that keeps the grid within 1024 cells a side (at most 128). */
export function areaCell(W, H) {
    let cell = 1;
    while (Math.ceil(Math.max(W, H) / cell) > AREA_GRID_MAX && cell < 128) cell *= 2;
    return cell;
}

/**
 * The smallest separate area that counts, in selected pixels: max(256, W * H / 20000), a 20,000th of the picture and at
 * least 16 x 16 (256 px at
 * 1024 x 1024, 839 at 4096 x 4096, 7,500 at 15000 x 10000, about an 87 px square). A stray dab of a brush or the
 * crumbs of a selection by text are smaller; anything a model should paint on its own is larger.
 */
export function speckPixels(W, H) {
    return Math.max(256, Math.round((W * H) / 20000));
}

/** log2 of a power of two. */
function shiftOf(cell) {
    let s = 0;
    while ((1 << s) < cell) s++;
    return s;
}

/**
 * Add the selected pixels (alpha 128 and more, the run's own threshold: stitch.js reads more than half as selected) of a
 * tile to `counts`, the grid of `gw` cells a row. `bytes`: the tile's RGBA bytes (256 x 256, 4-byte aligned), at (ox, oy)
 * of the image, `vw` x `vh` of it inside the image (an edge tile's padding is never read).
 */
export function countTileCells(bytes, ox, oy, vw, vh, cell, gw, counts) {
    // one word a pixel, little endian: the alpha is the top byte, so a selected pixel is a negative word
    const d = new Int32Array(bytes.buffer, bytes.byteOffset, 256 * 256);
    countWords(d, 256, ox, oy, vw, vh, cell, gw, counts);
}

/** `countTileCells` for `h` rows of `w` RGBA pixels (`data`, 4-byte aligned) at (ox, oy) of the image. */
export function countRowCells(data, w, h, ox, oy, cell, gw, counts) {
    const d = new Int32Array(data.buffer, data.byteOffset, w * h);
    countWords(d, w, ox, oy, w, h, cell, gw, counts);
}

function countWords(d, stride, ox, oy, vw, vh, cell, gw, counts) {
    const s = shiftOf(cell);
    for (let y = 0; y < vh; y++) {
        const row = y * stride, crow = ((oy + y) >> s) * gw;
        let x = 0;
        while (x < vw) {
            // the run of pixels of this row that fall into one cell, counted into it at once
            const cx = (ox + x) >> s, end = Math.min(vw, ((cx + 1) << s) - ox);
            let n = 0;
            for (let i = row + x, e = row + end; i < e; i++) if (d[i] < 0) n++;
            if (n) counts[crow + cx] += n;
            x = end;
        }
    }
}

/**
 * The 8-connected parts of the cells that hold a selected pixel. `counts`: the grid (`gw` x `gh` cells of `cell` px) of
 * a W x H picture; `speck`: the fewest selected pixels a part needs to count (speckPixels). Returns `{ parts, specks,
 * speckBoxes, more }`: each part `{ box: [x0, y0, x1, y1] (image pixels, x1 and y1 exclusive), px (its selected pixels),
 * cells }` in the order found (top to bottom); `specks` how many parts were too small, `speckBoxes` the boxes of the
 * first `maxSpecks` of them; at most `maxParts` parts are listed and `more` counts the rest.
 */
export function labelParts(counts, gw, gh, cell, W, H, speck, maxParts = 2048, maxSpecks = 4096) {
    const n = gw * gh;
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    const parts = [], speckBoxes = [];
    let specks = 0, more = 0;
    for (let i = 0; i < n; i++) {
        if (!counts[i] || seen[i]) continue;
        let head = 0, tail = 0;
        queue[tail++] = i;
        seen[i] = 1;
        let px = 0, cells = 0, cx0 = gw, cy0 = gh, cx1 = -1, cy1 = -1;
        while (head < tail) {
            const j = queue[head++];
            const y = (j / gw) | 0, x = j - y * gw;
            px += counts[j];
            cells++;
            if (x < cx0) cx0 = x;
            if (x > cx1) cx1 = x;
            if (y < cy0) cy0 = y;
            if (y > cy1) cy1 = y;
            const ya = y > 0 ? y - 1 : 0, yb = y < gh - 1 ? y + 1 : y;
            const xa = x > 0 ? x - 1 : 0, xb = x < gw - 1 ? x + 1 : x;
            for (let yy = ya; yy <= yb; yy++) {
                for (let xx = xa, k = yy * gw + xa; xx <= xb; xx++, k++) {
                    if (counts[k] && !seen[k]) { seen[k] = 1; queue[tail++] = k; }
                }
            }
        }
        const box = [cx0 * cell, cy0 * cell, Math.min(W, (cx1 + 1) * cell), Math.min(H, (cy1 + 1) * cell)];
        if (px < speck) {
            specks++;
            if (speckBoxes.length < maxSpecks) speckBoxes.push(box);
            continue;
        }
        if (parts.length < maxParts) parts.push({ box, px, cells });
        else more++;
    }
    return { parts, specks, speckBoxes, more };
}

/** Whether two boxes [x0, y0, x1, y1] share any area (touching edges do not). */
export function boxesMeet(a, b) {
    return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/**
 * The areas a run of each one on its own would make: the parts whose crops would overlap joined into one, again until
 * none meets another. `cropOf(box)` is the crop ([x0, y0, x1, y1]) a run makes of a selection with that bounding box;
 * an area's `reach` is its crop united with its box grown by `margin` px (the cells' rounding, a soft rim), held to the W
 * x H picture. Two areas whose reaches meet are one: so a run of one area, its selection cut to its reach, never holds a
 * pixel of another. Returns the areas in reading order (by their top, then their left): `{ box, crop, reach, px, parts }`.
 */
export function groupAreas(parts, cropOf, { margin = 0, W, H }) {
    const reachOf = (it) => {
        const c = cropOf(it.box);
        it.crop = c;
        it.reach = [Math.max(0, Math.min(c[0], it.box[0] - margin)), Math.max(0, Math.min(c[1], it.box[1] - margin)),
            Math.min(W, Math.max(c[2], it.box[2] + margin)), Math.min(H, Math.max(c[3], it.box[3] + margin))];
        return it;
    };
    let items = parts.map((p) => reachOf({ box: p.box.slice(), px: p.px, parts: 1 }));
    for (;;) {
        const parent = items.map((_, i) => i);
        const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
        let joined = false;
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                if (!boxesMeet(items[i].reach, items[j].reach)) continue;
                const a = find(i), b = find(j);
                if (a !== b) { parent[b] = a; joined = true; }
            }
        }
        if (!joined) break;
        const sets = new Map();
        items.forEach((it, i) => {
            const r = find(i);
            const s = sets.get(r);
            if (!s) { sets.set(r, { box: it.box.slice(), px: it.px, parts: it.parts }); return; }
            s.box = [Math.min(s.box[0], it.box[0]), Math.min(s.box[1], it.box[1]), Math.max(s.box[2], it.box[2]), Math.max(s.box[3], it.box[3])];
            s.px += it.px;
            s.parts += it.parts;
        });
        // a joined area's crop is planned anew from its whole box: it can reach a third area the parts did not
        items = Array.from(sets.values()).map(reachOf);
    }
    return items.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
}
