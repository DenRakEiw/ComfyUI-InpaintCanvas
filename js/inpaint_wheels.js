// Generated from DenRakEiw/scumble renderer/editor/inpaint_wheels.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
import { THEME } from "./inpaint_theme.js";
import { hueRgb, GRADE_RANGES } from "./inpaint_grade.js";

/** Size of the wheel canvas in CSS pixels. */
export const WHEEL_SIZE = 72;

/** Outer radius of the wheel in CSS pixels (leaves 4 px margin for puck). */
export const WHEEL_R = 32;

/** @type {Record<string, string>} */
const RANGE_LABELS = {
    sh: "Shadows",
    mid: "Midtones",
    hi: "Highlights",
    glob: "Global",
};

/** @type {Record<string, number>} */
const DEFAULT_HUES = {
    sh: 220,
    mid: 30,
    hi: 40,
    glob: 0,
};

/**
 * Parse a hex color string (#rgb or #rrggbb) into [r, g, b] (0..255).
 * @param {string} h
 * @returns {[number, number, number]}
 */
function parseHex(h) {
    if (!h || typeof h !== "string") return [22, 22, 22];
    const s = h.replace("#", "");
    if (s.length === 3) {
        return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
    }
    if (s.length === 6) {
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    }
    return [22, 22, 22];
}

/**
 * Convert puck offset (dx, dy) relative to wheel centre to { hue, sat }.
 * hue: 0..360 in degrees, counter-clockwise, red to the right.
 * sat: 0..100, clamped at 100.
 *
 * @param {number} dx
 * @param {number} dy
 * @param {number} R
 * @returns {{ hue: number, sat: number }}
 */
export function puckToHueSat(dx, dy, R) {
    if (!R || R <= 0) return { hue: 0, sat: 0 };
    let deg = Math.atan2(-dy, dx) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    if (deg >= 360) deg -= 360;
    const dist = Math.hypot(dx, dy);
    const sat = Math.min(100, (dist / R) * 100);
    return { hue: deg, sat };
}

/**
 * Convert { hue, sat } to puck offset [dx, dy] relative to wheel centre.
 *
 * @param {number} hue
 * @param {number} sat
 * @param {number} R
 * @returns {[number, number]}
 */
export function hueSatToPuck(hue, sat, R) {
    const rad = (hue || 0) * Math.PI / 180;
    const r = ((sat || 0) / 100) * R;
    const dx = r * Math.cos(rad);
    const dy = -r * Math.sin(rad);
    return [dx, dy];
}

/** @type {HTMLCanvasElement | null} */
let cachedBg = null;
let cachedDpr = 0;
let cachedThemeVersion = -1;

/**
 * Pre-render the wheel color disc onto a cached offscreen canvas.
 * @param {number} dpr
 * @returns {HTMLCanvasElement}
 */
function getWheelBackground(dpr) {
    if (cachedBg && cachedDpr === dpr && cachedThemeVersion === THEME.version) {
        return cachedBg;
    }
    const size = Math.round(WHEEL_SIZE * dpr);
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const cx = size / 2;
    const cy = size / 2;
    const rDisk = WHEEL_R * dpr;
    const bgRgb = parseHex(THEME.curveBg || "#161616");

    for (let py = 0; py < size; py++) {
        const dy = py - cy;
        for (let px = 0; px < size; px++) {
            const dx = px - cx;
            const dist = Math.hypot(dx, dy);
            const idx = (py * size + px) * 4;
            if (dist > rDisk + 1) {
                data[idx + 3] = 0;
                continue;
            }
            let deg = Math.atan2(-dy, dx) * 180 / Math.PI;
            if (deg < 0) deg += 360;
            if (deg >= 360) deg -= 360;
            const [hr, hg, hb] = hueRgb(deg);
            const t = Math.min(1, dist / rDisk);
            const r = Math.round((1 - t) * bgRgb[0] + t * (hr * 255));
            const g = Math.round((1 - t) * bgRgb[1] + t * (hg * 255));
            const b = Math.round((1 - t) * bgRgb[2] + t * (hb * 255));
            let a = 1;
            if (dist > rDisk - 1) {
                a = Math.max(0, Math.min(1, rDisk + 1 - dist));
            }
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = Math.round(a * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    cachedBg = c;
    cachedDpr = dpr;
    cachedThemeVersion = THEME.version;
    return c;
}

/**
 * Build 2x2 colour wheels control for the colour grading filter layer.
 *
 * @param {any} layer
 * @param {any} param
 * @param {{ begin: () => void, preview: () => void, commit: () => void, stop?: (e: any) => void }} callbacks
 * @returns {HTMLElement}
 */
export function buildWheelsControl(layer, param, callbacks) {
    const stop = (e) => {
        if (callbacks && typeof callbacks.stop === "function") callbacks.stop(e);
        else if (e && e.stopPropagation) e.stopPropagation();
    };
    const dpr = Math.min(2, typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1);

    const wrap = document.createElement("div");
    wrap.className = "ipc-wheels";
    for (const ev of ["click", "pointerdown", "dblclick", "keydown"]) {
        wrap.addEventListener(ev, stop);
    }

    for (const r of GRADE_RANGES) {
        const wheel = document.createElement("div");
        wheel.className = "ipc-wheel";

        const span = document.createElement("span");
        span.textContent = RANGE_LABELS[r] || r;
        wheel.appendChild(span);

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(WHEEL_SIZE * dpr);
        canvas.height = Math.round(WHEEL_SIZE * dpr);
        canvas.style.width = `${WHEEL_SIZE}px`;
        canvas.style.height = `${WHEEL_SIZE}px`;
        canvas.style.touchAction = "none";
        canvas.style.cursor = "crosshair";
        canvas.title = `${RANGE_LABELS[r] || r}: drag puck for hue and saturation, double-click resets`;
        // @ts-ignore
        canvas._wheelR = WHEEL_R;
        canvas.dataset.wheelRange = r;
        wheel.appendChild(canvas);

        const lumInput = document.createElement("input");
        lumInput.type = "range";
        lumInput.min = "-100";
        lumInput.max = "100";
        lumInput.step = "1";
        lumInput.value = String(layer.params[`${r}_lum`] ?? 0);
        lumInput.title = `${RANGE_LABELS[r] || r} brightness`;
        lumInput.style.width = `${WHEEL_SIZE}px`;
        wheel.appendChild(lumInput);

        const ctx = canvas.getContext("2d");

        const drawWheel = () => {
            if (!ctx) return;
            const w = canvas.width, h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            const bg = getWheelBackground(dpr);
            ctx.drawImage(bg, 0, 0, w, h);

            const cx = w / 2, cy = h / 2;
            const rDisk = WHEEL_R * dpr;

            // Rim
            ctx.beginPath();
            ctx.arc(cx, cy, rDisk, 0, Math.PI * 2);
            ctx.strokeStyle = THEME.curveGrid || "#2a2a2a";
            ctx.lineWidth = 1 * dpr;
            ctx.stroke();

            // Faint centre mark
            ctx.beginPath();
            ctx.arc(cx, cy, 1.5 * dpr, 0, Math.PI * 2);
            ctx.fillStyle = THEME.curveGrid || "#2a2a2a";
            ctx.fill();

            // Puck position
            const curHue = layer.params[`${r}_hue`] ?? DEFAULT_HUES[r] ?? 0;
            const curSat = layer.params[`${r}_sat`] ?? 0;
            const [dx, dy] = hueSatToPuck(curHue, curSat, WHEEL_R);
            const puckX = cx + dx * dpr;
            const puckY = cy + dy * dpr;

            // Puck circle
            ctx.beginPath();
            ctx.arc(puckX, puckY, 3.5 * dpr, 0, Math.PI * 2);
            ctx.fillStyle = THEME.curvePoint || "#ffffff";
            ctx.fill();
            ctx.lineWidth = 1.5 * dpr;
            ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
            ctx.stroke();
        };

        drawWheel();

        let dragging = false;
        const setPuck = (e) => {
            const rect = canvas.getBoundingClientRect();
            const cxCss = (rect.width || WHEEL_SIZE) / 2;
            const cyCss = (rect.height || WHEEL_SIZE) / 2;
            const dx = (e.clientX - rect.left) - cxCss;
            const dy = (e.clientY - rect.top) - cyCss;
            const { hue, sat } = puckToHueSat(dx, dy, WHEEL_R);
            layer.params[`${r}_hue`] = Math.round(hue);
            layer.params[`${r}_sat`] = Math.round(sat);
            callbacks.preview();
            drawWheel();
        };

        canvas.addEventListener("pointerdown", (e) => {
            stop(e);
            dragging = true;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            callbacks.begin();
            setPuck(e);
        });

        canvas.addEventListener("pointermove", (e) => {
            stop(e);
            if (!dragging) return;
            setPuck(e);
        });

        const onEnd = (e) => {
            stop(e);
            if (!dragging) return;
            dragging = false;
            try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            callbacks.commit();
            drawWheel();
        };

        canvas.addEventListener("pointerup", onEnd);
        canvas.addEventListener("pointercancel", onEnd);

        canvas.addEventListener("dblclick", (e) => {
            stop(e);
            callbacks.begin();
            layer.params[`${r}_sat`] = 0;
            callbacks.commit();
            drawWheel();
        });

        for (const ev of ["click", "pointerdown", "dblclick", "keydown"]) {
            lumInput.addEventListener(ev, stop);
        }
        lumInput.addEventListener("input", (e) => {
            stop(e);
            callbacks.begin();
            layer.params[`${r}_lum`] = Math.round(+lumInput.value);
            callbacks.preview();
        });
        lumInput.addEventListener("change", (e) => {
            stop(e);
            callbacks.commit();
        });

        wrap.appendChild(wheel);
    }

    return wrap;
}
