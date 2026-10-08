// Generated from DenRakEiw/scumble renderer/editor/inpaint_rangebar.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Range bar control and whole-picture histograms (R1-S4 / F9)
// Pure geometry functions for headless tests and UI control component.

/**
 * @typedef {Object} Range
 * @property {number} lo - Low cut-off 0..1
 * @property {number} hi - High cut-off 0..1 (lo <= hi)
 * @property {number} fLo - Low feather width >= 0
 * @property {number} fHi - High feather width >= 0
 * @property {boolean} [invert] - Whether the range is inverted
 */

export const RANGE_DEFAULTS = Object.freeze({
    lo: 0,
    hi: 0.3,
    fLo: 0.05,
    fHi: 0.05,
    invert: false,
});

/**
 * Pure hit test for range bar handles and box.
 * Hit order: feather handles (fLo, fHi) win over box edges (lo, hi) within tolerance.
 *
 * @param {Range} range - Current range
 * @param {number} x01 - Hit position in 0..1
 * @param {number} [tol01=0.03] - Hit tolerance in 0..1
 * @returns {"fLo" | "lo" | "hi" | "fHi" | "box" | null}
 */
export function hitTest(range, x01, tol01 = 0.03) {
    if (!range) return null;
    const lo = range.lo ?? 0;
    const hi = range.hi ?? 1;
    const fLo = Math.max(0, range.fLo ?? 0);
    const fHi = Math.max(0, range.fHi ?? 0);

    const fLoPos = lo - fLo;
    const fHiPos = hi + fHi;

    // Hit order: feather handle wins over box edge within tol01
    if (Math.abs(x01 - fLoPos) <= tol01) return "fLo";
    if (Math.abs(x01 - fHiPos) <= tol01) return "fHi";
    if (Math.abs(x01 - lo) <= tol01) return "lo";
    if (Math.abs(x01 - hi) <= tol01) return "hi";
    if (x01 >= Math.min(lo, hi) && x01 <= Math.max(lo, hi)) return "box";
    return null;
}

/**
 * Pure drag mapping: returns a new Range preserving lo <= hi, feathers >= 0,
 * and maintaining box width (hi - lo) during a box drag.
 *
 * @param {Range} range - Current range
 * @param {"fLo" | "lo" | "hi" | "fHi" | "box" | string} handle - Handle being dragged
 * @param {number} x01 - Current pointer position in 0..1
 * @param {Range} [startRange=range] - Range when drag started
 * @param {number} [startX01=x01] - Pointer position when drag started in 0..1
 * @returns {Range}
 */
export function dragTo(range, handle, x01, startRange = range, startX01 = x01) {
    const s = { ...RANGE_DEFAULTS, ...startRange };
    const cur = { ...RANGE_DEFAULTS, ...range };
    const invert = !!s.invert;

    if (handle === "lo") {
        const lo = Math.max(0, Math.min(s.hi, x01));
        return { ...s, lo, hi: s.hi, fLo: Math.max(0, s.fLo), fHi: Math.max(0, s.fHi), invert };
    }
    if (handle === "hi") {
        const hi = Math.min(1, Math.max(s.lo, x01));
        return { ...s, lo: s.lo, hi, fLo: Math.max(0, s.fLo), fHi: Math.max(0, s.fHi), invert };
    }
    if (handle === "fLo") {
        const fLo = Math.min(1, Math.max(0, s.lo - x01));
        return { ...s, lo: s.lo, hi: s.hi, fLo, fHi: Math.max(0, s.fHi), invert };
    }
    if (handle === "fHi") {
        const fHi = Math.min(1, Math.max(0, x01 - s.hi));
        return { ...s, lo: s.lo, hi: s.hi, fLo: Math.max(0, s.fLo), fHi, invert };
    }
    if (handle === "box") {
        const dx = x01 - startX01;
        const w = Math.min(1, Math.max(0, s.hi - s.lo));
        let lo = s.lo + dx;
        let hi = s.hi + dx;
        if (lo < 0) {
            lo = 0;
            hi = w;
        } else if (hi > 1) {
            hi = 1;
            lo = 1 - w;
        }
        return { ...s, lo, hi, fLo: Math.max(0, s.fLo), fHi: Math.max(0, s.fHi), invert };
    }
    return { ...cur };
}

/**
 * Builds the Range Bar UI control element.
 *
 * @param {Range} range - Initial range
 * @param {Object} [options]
 * @param {"luma" | "depth" | "color" | ((t: number) => string)} [options.gradient="luma"] - Background gradient
 * @param {() => Float64Array | null} [options.histogram] - Histogram data callback, read once per begin()
 * @param {() => void} [options.begin] - Called when drag / interaction begins
 * @param {(range: Range) => void} [options.preview] - Called during live drag
 * @param {(range: Range) => void} [options.commit] - Called when drag is committed
 * @param {(e: Event) => void} [options.stop] - Stops event propagation
 * @param {() => Promise<number | null>} [options.pick] - Eyedropper callback returning value 0..1
 * @param {(on: boolean) => void} [options.hover] - Alt held preview callback
 * @param {string} [options.title] - Optional title label
 * @returns {{ el: HTMLElement, set: (range: Partial<Range>) => void, refresh: () => void }}
 */
export function buildRangeBar(range, {
    gradient = "luma",
    histogram = null,
    begin = null,
    preview = null,
    commit = null,
    stop = null,
    pick = null,
    hover = null,
    title = null,
    onEnter = null,
} = {}) {
    let curRange = { ...RANGE_DEFAULTS, ...range };
    let currentHist = null;
    let drag = null;
    let hovering = false;

    const wrap = document.createElement("div");
    wrap.className = "ipc-rangebar-wrap";
    wrap.tabIndex = 0;

    if (typeof onEnter === "function") {
        wrap.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                onEnter();
            }
        });
    }

    // Header with title, pick button (if provided) and invert toggle
    const head = document.createElement("div");
    head.className = "ipc-rangebar-head";

    if (title) {
        const titleSpan = document.createElement("span");
        titleSpan.className = "ipc-rangebar-title";
        titleSpan.textContent = title;
        head.appendChild(titleSpan);
    }

    const spacer = document.createElement("span");
    spacer.className = "ipc-grow";
    head.appendChild(spacer);

    let pickBtn = null;
    if (typeof pick === "function") {
        pickBtn = document.createElement("button");
        pickBtn.type = "button";
        pickBtn.className = "ipc-rangebar-btn";
        pickBtn.textContent = "Pick";
        pickBtn.title = "Pick value from picture";
        pickBtn.addEventListener("click", async () => {
            try {
                if (begin) begin();
                const val = await pick();
                if (typeof val === "number" && !isNaN(val)) {
                    const w = curRange.hi - curRange.lo;
                    const half = w / 2;
                    let lo = Math.max(0, val - half);
                    let hi = Math.min(1, val + half);
                    if (lo === 0) hi = Math.min(1, w);
                    if (hi === 1) lo = Math.max(0, 1 - w);
                    curRange = { ...curRange, lo, hi };
                    draw();
                    if (commit) commit({ ...curRange });
                }
            } catch (err) {
                console.error("Eyedropper pick failed:", err);
            }
        });
        head.appendChild(pickBtn);
    }

    const invBtn = document.createElement("button");
    invBtn.type = "button";
    invBtn.className = "ipc-rangebar-btn" + (curRange.invert ? " ipc-active" : "");
    invBtn.textContent = "Invert";
    invBtn.title = "Invert range selection";
    invBtn.addEventListener("click", () => {
        if (begin) begin();
        curRange = { ...curRange, invert: !curRange.invert };
        invBtn.classList.toggle("ipc-active", !!curRange.invert);
        draw();
        if (commit) commit({ ...curRange });
    });
    head.appendChild(invBtn);
    wrap.appendChild(head);

    // Canvas bar
    const canvas = document.createElement("canvas");
    canvas.className = "ipc-rangebar-canvas";
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const syncButtons = () => {
        invBtn.classList.toggle("ipc-active", !!curRange.invert);
    };

    const draw = () => {
        if (!ctx) return;
        const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 200, height: 26 };
        const w = Math.max(10, Math.round(rect.width || canvas.clientWidth || 200));
        const h = Math.max(10, Math.round(rect.height || canvas.clientHeight || 26));

        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        // 1. Background gradient
        if (gradient === "luma") {
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, "#000");
            grad.addColorStop(1, "#fff");
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (gradient === "depth") {
            // Light (near = 0) to dark (far = 1)
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, "#fff");
            grad.addColorStop(1, "#000");
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (gradient === "color") {
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, "#f00");
            grad.addColorStop(1 / 6, "#ff0");
            grad.addColorStop(2 / 6, "#0f0");
            grad.addColorStop(3 / 6, "#0ff");
            grad.addColorStop(4 / 6, "#00f");
            grad.addColorStop(5 / 6, "#f0f");
            grad.addColorStop(1, "#f00");
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (typeof gradient === "function") {
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            for (let step = 0; step <= 16; step++) {
                const t = step / 16;
                grad.addColorStop(t, gradient(t));
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else {
            ctx.fillStyle = "#222";
            ctx.fillRect(0, 0, w, h);
        }

        // 2. Histogram curve
        if (currentHist && currentHist.length >= 256) {
            let max = 0;
            for (let i = 0; i < 256; i++) {
                if (currentHist[i] > max) max = currentHist[i];
            }
            if (max > 0) {
                ctx.beginPath();
                ctx.moveTo(0, h);
                for (let i = 0; i < 256; i++) {
                    const x = (i / 255) * w;
                    const bh = (currentHist[i] / max) * (h - 2);
                    ctx.lineTo(x, h - bh);
                }
                ctx.lineTo(w, h);
                ctx.closePath();
                ctx.fillStyle = "rgba(128, 128, 128, 0.4)";
                ctx.fill();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // 3. Selection overlay & feather ramps
        const xLo = Math.round(curRange.lo * w);
        const xHi = Math.round(curRange.hi * w);
        const xfLo = Math.round((curRange.lo - curRange.fLo) * w);
        const xfHi = Math.round((curRange.hi + curRange.fHi) * w);

        const dim = "rgba(10, 10, 10, 0.65)";
        const clear = "rgba(10, 10, 10, 0)";

        if (!curRange.invert) {
            // Unselected left
            if (xfLo > 0) {
                ctx.fillStyle = dim;
                ctx.fillRect(0, 0, Math.min(w, xfLo), h);
            }
            // Feather ramp left (xfLo -> xLo)
            if (xLo > xfLo) {
                const rampL = ctx.createLinearGradient(xfLo, 0, xLo, 0);
                rampL.addColorStop(0, dim);
                rampL.addColorStop(1, clear);
                ctx.fillStyle = rampL;
                ctx.fillRect(xfLo, 0, xLo - xfLo, h);
            }
            // Feather ramp right (xHi -> xfHi)
            if (xfHi > xHi) {
                const rampR = ctx.createLinearGradient(xHi, 0, xfHi, 0);
                rampR.addColorStop(0, clear);
                rampR.addColorStop(1, dim);
                ctx.fillStyle = rampR;
                ctx.fillRect(xHi, 0, xfHi - xHi, h);
            }
            // Unselected right
            if (xfHi < w) {
                ctx.fillStyle = dim;
                ctx.fillRect(Math.max(0, xfHi), 0, w - Math.max(0, xfHi), h);
            }
        } else {
            // Inverted: inside is dimmed, outside is selected
            if (xHi > xLo) {
                ctx.fillStyle = dim;
                ctx.fillRect(xLo, 0, xHi - xLo, h);
            }
            if (xLo > xfLo) {
                const rampL = ctx.createLinearGradient(xfLo, 0, xLo, 0);
                rampL.addColorStop(0, clear);
                rampL.addColorStop(1, dim);
                ctx.fillStyle = rampL;
                ctx.fillRect(xfLo, 0, xLo - xfLo, h);
            }
            if (xfHi > xHi) {
                const rampR = ctx.createLinearGradient(xHi, 0, xfHi, 0);
                rampR.addColorStop(0, dim);
                rampR.addColorStop(1, clear);
                ctx.fillStyle = rampR;
                ctx.fillRect(xHi, 0, xfHi - xHi, h);
            }
        }

        // 4. Box highlight borders
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xLo, 0.5);
        ctx.lineTo(xHi, 0.5);
        ctx.moveTo(xLo, h - 0.5);
        ctx.lineTo(xHi, h - 0.5);
        ctx.stroke();

        // 5. Handles: lo & hi vertical lines with arrows
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xLo, 0);
        ctx.lineTo(xLo, h);
        ctx.moveTo(xHi, 0);
        ctx.lineTo(xHi, h);
        ctx.stroke();

        // 6. Feather boundary markers (dashed lines)
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(xfLo, 0);
        ctx.lineTo(xfLo, h);
        ctx.moveTo(xfHi, 0);
        ctx.lineTo(xfHi, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small triangle handle indicators
        ctx.fillStyle = "#fff";
        // lo handle grip
        ctx.beginPath();
        ctx.moveTo(xLo, h / 2 - 4);
        ctx.lineTo(xLo + 4, h / 2);
        ctx.lineTo(xLo, h / 2 + 4);
        ctx.closePath();
        ctx.fill();
        // hi handle grip
        ctx.beginPath();
        ctx.moveTo(xHi, h / 2 - 4);
        ctx.lineTo(xHi - 4, h / 2);
        ctx.lineTo(xHi, h / 2 + 4);
        ctx.closePath();
        ctx.fill();
        // fLo handle grip
        ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
        ctx.beginPath();
        ctx.moveTo(xfLo, h / 2 - 3);
        ctx.lineTo(xfLo - 4, h / 2);
        ctx.lineTo(xfLo, h / 2 + 3);
        ctx.closePath();
        ctx.fill();
        // fHi handle grip
        ctx.beginPath();
        ctx.moveTo(xfHi, h / 2 - 3);
        ctx.lineTo(xfHi + 4, h / 2);
        ctx.lineTo(xfHi, h / 2 + 3);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    };

    // Pointer events on canvas
    const getX01 = (e) => {
        const rect = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
    };

    const getTol01 = () => {
        const rect = canvas.getBoundingClientRect();
        return Math.max(0.03, 10 / (rect.width || 200));
    };

    canvas.addEventListener("pointerdown", (e) => {
        const x01 = getX01(e);
        const tol01 = getTol01();
        const handle = hitTest(curRange, x01, tol01);
        if (!handle) return;

        if (typeof histogram === "function") {
            currentHist = histogram();
        }
        if (typeof begin === "function") {
            begin();
        }

        drag = {
            handle,
            startRange: { ...curRange },
            startX01: x01,
        };

        try {
            canvas.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }

        draw();
    });

    canvas.addEventListener("pointermove", (e) => {
        if (typeof hover === "function") {
            if (e.altKey && !hovering) {
                hovering = true;
                hover(true);
            } else if (!e.altKey && hovering) {
                hovering = false;
                hover(false);
            }
        }

        if (drag) {
            const rect = canvas.getBoundingClientRect();
            const x01 = (e.clientX - rect.left) / (rect.width || 1);
            curRange = dragTo(curRange, drag.handle, x01, drag.startRange, drag.startX01);
            draw();
            if (typeof preview === "function") {
                preview({ ...curRange });
            }
            return;
        }

        // Hover cursor
        const x01 = getX01(e);
        const tol01 = getTol01();
        const handle = hitTest(curRange, x01, tol01);
        if (handle === "box") {
            canvas.style.cursor = "grab";
        } else if (handle === "lo" || handle === "hi" || handle === "fLo" || handle === "fHi") {
            canvas.style.cursor = "ew-resize";
        } else {
            canvas.style.cursor = "default";
        }
    });

    const finishDrag = (e) => {
        if (!drag) return;
        try {
            canvas.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        drag = null;
        draw();
        if (typeof commit === "function") {
            commit({ ...curRange });
        }
        if (typeof stop === "function") {
            stop();
        }
    };

    canvas.addEventListener("pointerup", finishDrag);
    canvas.addEventListener("pointercancel", finishDrag);

    // Alt key hover handling
    if (typeof hover === "function") {
        wrap.addEventListener("keydown", (e) => {
            if (e.key === "Alt" && !hovering) {
                hovering = true;
                hover(true);
            }
        });
        wrap.addEventListener("keyup", (e) => {
            if (e.key === "Alt" && hovering) {
                hovering = false;
                hover(false);
                if (typeof stop === "function") stop();
            }
        });
        wrap.addEventListener("pointerleave", () => {
            if (hovering) {
                hovering = false;
                hover(false);
                if (typeof stop === "function") stop();
            }
        });
    }

    // Initial read and draw
    if (typeof histogram === "function") {
        currentHist = histogram();
    }
    // Schedule initial draw once layout settles
    if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => draw());
    } else {
        setTimeout(draw, 0);
    }

    return {
        el: wrap,
        set(nextRange) {
            curRange = { ...curRange, ...nextRange };
            syncButtons();
            draw();
            if (typeof commit === "function") {
                commit({ ...curRange });
            }
        },
        refresh() {
            if (typeof histogram === "function") {
                currentHist = histogram();
            }
            draw();
        },
        begin() {
            if (typeof begin === "function") begin();
        },
        preview(r) {
            if (typeof preview === "function") preview(r !== undefined ? r : { ...curRange });
        },
        commit(r) {
            if (r !== undefined) curRange = { ...curRange, ...r };
            if (typeof commit === "function") commit({ ...curRange });
        },
        stop() {
            if (typeof stop === "function") stop();
        },
    };
}
