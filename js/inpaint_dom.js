// Generated from DenRakEiw/scumble renderer/editor/inpaint_dom.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// DOM helpers (el, the inputs) and the icons: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { mapOffset } from "./reftokens.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/**
 * A text field's value set from code, without an input event. `keepCaret`: when it has the focus, the caret and the
 * selection move through the change (reftokens.js mapOffset), so a remap of @img2 to @img1 leaves it after the same word;
 * a caret between two tokens that both changed goes to the end of the change (docs/PLAN_REFS.md C4).
 */
function setFieldText(field, text, keepCaret = false) {
    if (!field || field.value === text) return;
    const before = field.value;
    const focused = keepCaret && typeof document !== "undefined" && document.activeElement === field;
    const s = focused ? field.selectionStart : 0, e = focused ? field.selectionEnd : 0;
    field.value = text;
    if (focused && s != null && e != null) field.setSelectionRange(mapOffset(s, before, text), mapOffset(e, before, text));
}

function numberInput(value, min, max, title, width = 58) {
    const i = document.createElement("input");
    i.type = "number";
    i.value = value; i.min = min; i.max = max; i.title = title;
    i.className = "ipc-num";
    i.style.width = width + "px";
    i.addEventListener("keydown", (e) => e.stopPropagation());
    return i;
}

function selectInput(options, value, title) {
    const s = document.createElement("select");
    s.className = "ipc-sel";
    s.title = title;
    for (const o of options) {
        const opt = document.createElement("option");
        if (typeof o === "object" && o !== null) {
            opt.value = o.value ?? o.id;
            opt.textContent = o.label ?? o.title ?? opt.value;
        } else {
            opt.value = o;
            opt.textContent = o;
        }
        s.appendChild(opt);
    }
    s.value = value;
    s.addEventListener("click", (e) => e.stopPropagation());
    s.addEventListener("keydown", (e) => e.stopPropagation());
    return s;
}

function selectGrouped(groups, rows, value, title, opts = {}) {
    const s = document.createElement("select");
    s.className = "ipc-sel";
    if (opts && opts.className) s.classList.add(opts.className);
    s.title = title;
    for (const g of groups) {
        const gid = typeof g === "object" && g !== null ? (g.id ?? g.value) : g;
        const glabel = typeof g === "object" && g !== null ? (g.label ?? g.title ?? gid) : g;
        const grp = document.createElement("optgroup");
        grp.label = glabel;
        for (const r of rows) {
            const rgrp = typeof r === "object" && r !== null ? r.group : null;
            if (rgrp !== gid) continue;
            const opt = document.createElement("option");
            if (typeof r === "object" && r !== null) {
                opt.value = r.value ?? r.id;
                opt.textContent = r.label ?? r.title ?? opt.value;
            } else {
                opt.value = r;
                opt.textContent = r;
            }
            grp.appendChild(opt);
        }
        s.appendChild(grp);
    }
    s.value = value;
    s.addEventListener("click", (e) => e.stopPropagation());
    s.addEventListener("keydown", (e) => e.stopPropagation());
    return s;
}

// ---------------------------------------------------------------------------
// icons (24x24, stroke based)
// ---------------------------------------------------------------------------

const ICONS = {
    text: '<path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    // the Boxes tool (boxes_tool.js's icon; the node's tool column, docs/PLAN_NODE_BOXES.md B4)
    boxes: '<rect x="3" y="5" width="11" height="9" rx="1"/><rect x="10" y="10" width="11" height="9" rx="1" stroke-dasharray="3 2"/>',
    ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>',
    grid: '<rect x="3" y="3" width="18" height="18"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
    peek: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M12 5v14" stroke-dasharray="2 2"/>',
    compare: '<rect x="3" y="4" width="18" height="16"/><path d="M12 4v16"/><path d="M6 12h3M15 12h3"/>',
    flipH: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5"/><path d="M15 7l5 5-5 5"/>',
    flipV: '<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M7 9l5-5 5 5"/><path d="M7 15l5 5 5-5"/>',
    rotCW: '<path d="M4 12a8 8 0 018-8h5"/><path d="M14 1l3 3-3 3"/><rect x="11" y="12" width="9" height="8"/>',
    rotCCW: '<path d="M20 12a8 8 0 00-8-8H7"/><path d="M10 1L7 4l3 3"/><rect x="4" y="12" width="9" height="8"/>',
    rot180: '<path d="M5 13a7 7 0 1014 0"/><path d="M16 16l3-3 3 3"/><rect x="8" y="3" width="8" height="6"/>',
    center: '<rect x="3" y="3" width="18" height="18"/><path d="M12 8v8M8 12h8"/>',
    alignLeft: '<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4"/><rect x="7" y="14" width="7" height="4"/>',
    alignHCenter: '<path d="M12 3v3M12 10v4M12 18v3"/><rect x="5" y="6" width="14" height="4"/><rect x="8" y="14" width="8" height="4"/>',
    alignRight: '<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4"/><rect x="10" y="14" width="7" height="4"/>',
    alignTop: '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12"/><rect x="14" y="7" width="4" height="7"/>',
    alignVCenter: '<path d="M3 12h3M10 12h4M18 12h3"/><rect x="6" y="5" width="4" height="14"/><rect x="14" y="8" width="4" height="8"/>',
    alignBottom: '<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12"/><rect x="14" y="10" width="4" height="7"/>',
    distH: '<path d="M3 4v16M21 4v16"/><rect x="6" y="7" width="3" height="10"/><rect x="10.5" y="7" width="3" height="10"/><rect x="15" y="7" width="3" height="10"/>',
    distV: '<path d="M4 3h16M4 21h16"/><rect x="7" y="6" width="10" height="3"/><rect x="7" y="10.5" width="10" height="3"/><rect x="7" y="15" width="10" height="3"/>',
    resize: '<rect x="3" y="3" width="18" height="18"/><path d="M8 16l8-8"/><path d="M12 8h4v4"/><path d="M12 16H8v-4"/>',
    wand: '<path d="M4 20L15 9"/><path d="M15 9l-2-2 4-4 2 2z"/><path d="M19 2v2M22 5h-2M21 9l-1.5-.5M17 1l-.5 1.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6" stroke-dasharray="3 2"/>',
    quickmask: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
    blur: '<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/>',
    liquify: '<path d="M10 12a2 2 0 1 1 4 0a4 4 0 1 1-8 0a6 6 0 1 1 12 0a8 8 0 0 1-2.5 5.5"/><path d="M17 21l2.5-3.5-4-.5"/>',
    smudge: '<path d="M8 21c-3 0-5-2-5-5v-6a2 2 0 014 0v3"/><path d="M7 13V5a2 2 0 014 0v7"/><path d="M11 12V7a2 2 0 014 0v5"/><path d="M15 12v-1a2 2 0 014 0v5c0 3-2 5-5 5H8"/>',
    clone: '<path d="M5 21h14"/><path d="M4 17h16v-4H4z"/><path d="M9 13V7a3 3 0 016 0v6"/>',
    tone: '<circle cx="14.5" cy="9.5" r="5.5"/><path d="M14.5 4a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/><path d="M10.6 13.4L3.5 20.5"/>',
    heal: '<rect x="2" y="9" width="20" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M10 10l4 4"/><path d="M14 10l-4 4"/>',
    remove: '<path d="M4 20l9-9"/><path d="M13 11l3-3 2 2-3 3z"/><path d="M18 3v3M16.5 4.5h3"/><path d="M8 4v2M7 5h2"/>',
    patch: '<rect x="3" y="3" width="11" height="11" rx="2" stroke-dasharray="2.5 2"/><rect x="10" y="10" width="11" height="11" rx="2"/><path d="M8 8l5 5"/>',
    contentmove: '<rect x="3" y="12" width="9" height="9" rx="1.5" stroke-dasharray="2.5 2"/><rect x="12" y="3" width="9" height="9" rx="1.5"/><path d="M8 16l6-6M10 10h4v4"/>',
    eyedropper: '<path d="M4 20l1-4 9-9 3 3-9 9z"/><path d="M14 7l3-3 3 3-3 3"/>',
    bucket: '<path d="M4 11l7-7 8 8-7 7z"/><path d="M4 11h11"/><path d="M19 14c0 2 1.5 3 1.5 4.5a1.5 1.5 0 01-3 0C17.5 17 19 16 19 14z" fill="currentColor" stroke="none"/>',
    shape: '<rect x="3" y="8" width="11" height="11" rx="1.5"/><circle cx="16" cy="9" r="5"/>',
    gradient: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16" stroke-dasharray="1 2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M16 4v16" stroke-dasharray="3 1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    alphaLock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/><path d="M8 14h3v3H8zM13 17h3v3h-3z" fill="currentColor" stroke="none"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    merge: '<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><rect x="4" y="16" width="16" height="5" rx="1"/>',
    clip: '<path d="M7 3v8a4 4 0 004 4h8"/><path d="M15 11l4 4-4 4"/>',
    folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    ungroup: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke-dasharray="3 2.5"/>',
    caretR: '<path d="M10 7l5 5-5 5"/>',
    caretD: '<path d="M7 10l5 5 5-5"/>',
    bold: '<path d="M7 4h6a4 4 0 010 8H7z"/><path d="M7 12h7a4 4 0 010 8H7z"/>',
    italic: '<path d="M14 4h6"/><path d="M4 20h6"/><path d="M15 4l-6 16"/>',
    canvas: '<rect x="4" y="4" width="16" height="16" stroke-dasharray="3 2"/><path d="M12 1v3"/><path d="M12 20v3"/><path d="M1 12h3"/><path d="M20 12h3"/><path d="M10 2l2-1 2 1"/><path d="M10 22l2 1 2-1"/><path d="M2 10l-1 2 1 2"/><path d="M22 10l1 2-1 2"/>',
    select: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M11 9v6"/><path d="M8 12h6"/>',
    deselect: '<circle cx="11" cy="12" r="7" stroke-dasharray="3 2"/><path d="M8 12h6"/>',
    loop: '<circle cx="12" cy="12" r="7" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2"/>',
    polygon: '<path d="M5 8l7-4 8 6-3 9H7z" stroke-dasharray="3 2"/><circle cx="5" cy="8" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="4" r="1.8" fill="currentColor" stroke="none"/><circle cx="20" cy="10" r="1.8" fill="currentColor" stroke="none"/><circle cx="17" cy="19" r="1.8" fill="currentColor" stroke="none"/><circle cx="7" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
    lasso: '<path d="M12 4c4.4 0 8 2.2 8 5s-3.6 5-8 5-8-2.2-8-5 3.6-5 8-5z"/><path d="M6 12.5c-1 2 0 3.5 2 3.5s3 1.5 2 4"/>',
    object: '<path d="M4 9c0-3 3-5 6-5s6 1 6 4-2 3-2 5 1 3-1 4-4 1-6-1-3-4-3-7z" stroke-dasharray="3 2"/><path d="M13 12l7 3-3 1-1 3z" fill="currentColor" stroke="none"/>',
    paint: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/><path d="M5 19c-1 0-2-1-2-2"/>',
    erase: '<path d="M4 15l8-8 6 6-5 5H8z"/><path d="M13 21h7"/>',
    fill: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M12 4v6"/><path d="M19 15c0 2-1 3-2 4-1-1-2-2-2-4 0-1 2-3 2-3s2 2 2 3z" fill="currentColor" stroke="none"/>',
    transform: '<rect x="6" y="6" width="12" height="12"/><rect x="3" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="3" width="4" height="4" fill="currentColor" stroke="none"/><rect x="3" y="17" width="4" height="4" fill="currentColor" stroke="none"/><rect x="17" y="17" width="4" height="4" fill="currentColor" stroke="none"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5"/><path d="M11 11V4.5a1.5 1.5 0 013 0V11"/><path d="M14 11V6a1.5 1.5 0 013 0v7"/><path d="M8 12v0a1.5 1.5 0 00-3 1l2 5a4 4 0 004 3h3a4 4 0 004-4v-4"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
    clear: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    invert: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>',
    ants: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><rect x="8" y="8" width="8" height="8" fill="currentColor" stroke="none" opacity=".35"/>',
    fit: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
    flatten: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
    load: '<path d="M4 17v3h16v-3"/><path d="M12 4v11"/><path d="M7 9l5-5 5 5"/>',
    play: '<path d="M7 4l12 8-12 8z" fill="currentColor" stroke="none"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="currentColor" stroke="none"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M10 6.3A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.4"/><path d="M6.6 8.6C4 10.4 2 12 2 12s4 6 10 6a10 10 0 003-.5"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12 8l4 4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    newfile: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 10v6"/><path d="M9 13h6"/>',
    up: '<path d="M6 14l6-6 6 6"/>',
    down: '<path d="M6 10l6 6 6-6"/>',
    solo: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    restore: '<path d="M4 12a8 8 0 108-8"/><path d="M4 4v5h5"/>',
    grow: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
    shrink: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" stroke-dasharray="3 2"/><path d="M12 5v3"/><path d="M12 16v3"/><path d="M5 12h3"/><path d="M16 12h3"/>',
    fromLayer: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 14l8 4 8-4" stroke-dasharray="3 2"/>',
    rotate: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 3v5h-5"/>',
    distort: '<path d="M5 6l14-2v14l-14 2z"/><circle cx="5" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="4" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="5" cy="20" r="1.6" fill="currentColor" stroke="none"/>',
    warp: '<path d="M4 6c4-3 12 3 16 0"/><path d="M4 12c4-3 12 3 16 0"/><path d="M4 18c4-3 12 3 16 0"/><path d="M8 4v16"/><path d="M16 4v16"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    refine: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 3v5h-5"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.5" fill="currentColor" stroke="none"/>',
    magic: '<path d="M4 20l10-10"/><path d="M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none"/><path d="M19 9l.7 1.3L21 11l-1.3.7L19 13l-.7-1.3L17 11l1.3-.7z" fill="currentColor" stroke="none"/><path d="M14 8l2 2"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.3 15.7"/><path d="M8.3 8.3L20 20"/>',
    refImage: '<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M21 16l-5-5-8 8"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M21 16l-5-5-8 8"/>',
    mask: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
    more: '<circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    maskEdit: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16l6-6 2 2-6 6H8z" fill="currentColor" stroke="none"/><path d="M15 9l1-1 2 2-1 1"/>',
    fx: '<path d="M4 6h9"/><path d="M19 6h1"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M12 12h8"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><circle cx="18" cy="18" r="2"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="14" width="8" height="6"/>',
    download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
    broom: '<path d="M14 3l7 7"/><path d="M17.5 6.5L9 15"/><path d="M9 15l-5 5"/><path d="M6 12l6 6"/><path d="M11 13l-4 8"/>',
    extend: '<rect x="8" y="8" width="8" height="8"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M10 4l2-2 2 2"/><path d="M10 20l2 2 2-2"/><path d="M4 10l-2 2 2 2"/><path d="M20 10l2 2-2 2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    lights: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/>',
};

function icon(name, size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function iconButton(name, title, onClick, label) {
    const b = el("button", "ipc-ib");
    b.type = "button";
    b.title = title;
    b.innerHTML = icon(name) + (label ? `<span>${label}</span>` : "");
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); onClick(e); });
    return b;
}

function miniButton(name, title, onClick, cls = "") {
    const b = el("button", "ipc-mini " + cls);
    b.type = "button";
    b.title = title;
    b.innerHTML = icon(name, 16);
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return b;
}

export { el, icon, iconButton, miniButton, numberInput, selectGrouped, selectInput, setFieldText };
