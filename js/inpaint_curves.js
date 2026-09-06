// Inpaint Canvas - curves: monotone cubic interpolation (Fritsch-Carlson) into
// 256-entry tables and the curve editor control that the "Curves" filter layer
// shows in its layer row. The filter itself lives in inpaint_filters.js; this
// file only knows about point lists ([[x, y], ...] in 0..255) and DOM.

export const CURVE_CHANNELS = ["rgb", "r", "g", "b"];
const CHANNEL_LABEL = { rgb: "RGB", r: "R", g: "G", b: "B" };
const CHANNEL_COLOR = { rgb: "#e6e6e6", r: "#ff6a6a", g: "#6fdc6f", b: "#6f9dff" };

export function identityCurve() { return [[0, 0], [255, 255]]; }
export function curveDefaults() { return { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() }; }

/** Sorted, clamped, x-unique copy of a point list (bad input -> identity). */
export function cleanCurve(points) {
    const pts = (Array.isArray(points) ? points : [])
        .filter((p) => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
        .map((p) => [Math.min(255, Math.max(0, +p[0])), Math.min(255, Math.max(0, +p[1]))])
        .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const p of pts) { if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6) out[out.length - 1] = p; else out.push(p); }
    return out.length >= 2 ? out : identityCurve();
}

export function isIdentityCurve(points) {
    const p = cleanCurve(points);
    return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255;
}

/** 256-entry table through the points, monotone cubic (Fritsch-Carlson), flat outside the first / last point. */
export function curveTable(points) {
    const p = cleanCurve(points);
    const n = p.length;
    const t = new Uint8ClampedArray(256);
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const h = new Float64Array(n - 1), d = new Float64Array(n - 1), m = new Float64Array(n);
    for (let k = 0; k < n - 1; k++) { h[k] = xs[k + 1] - xs[k]; d[k] = (ys[k + 1] - ys[k]) / h[k]; }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] > 0 ? (d[k - 1] + d[k]) / 2 : 0;
    for (let k = 0; k < n - 1; k++) {
        if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
        const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
        if (s > 9) { const tau = 3 / Math.sqrt(s); m[k] = tau * a * d[k]; m[k + 1] = tau * b * d[k]; }
    }
    let k = 0;
    for (let x = 0; x < 256; x++) {
        if (x <= xs[0]) { t[x] = ys[0]; continue; }
        if (x >= xs[n - 1]) { t[x] = ys[n - 1]; continue; }
        while (k < n - 2 && x > xs[k + 1]) k++;
        const u = (x - xs[k]) / h[k], u2 = u * u, u3 = u2 * u;
        t[x] = (2 * u3 - 3 * u2 + 1) * ys[k] + (u3 - 2 * u2 + u) * h[k] * m[k] + (-2 * u3 + 3 * u2) * ys[k + 1] + (u3 - u2) * h[k] * m[k + 1];
    }
    return t;
}

/** Composite tables {r, g, b}: master (rgb) first, then the channel curve. `null` when everything is identity. */
export function curvesToTables(curves) {
    const c = curves || {};
    if (CURVE_CHANNELS.every((ch) => isIdentityCurve(c[ch]))) return null;
    const master = curveTable(c.rgb);
    const out = {};
    for (const ch of ["r", "g", "b"]) {
        const t = curveTable(c[ch]);
        const comp = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i++) comp[i] = t[master[i]];
        out[ch] = comp;
    }
    return out;
}

function cloneCurves(curves) {
    const out = {};
    for (const ch of CURVE_CHANNELS) out[ch] = cleanCurve(curves && curves[ch]).map((p) => [p[0], p[1]]);
    return out;
}

// ---------------------------------------------------------------------------
// the editor control
// ---------------------------------------------------------------------------

const BOX_W = 220, BOX_H = 160, PAD = 7, HIT = 9, OFF_REMOVE = 36;

/**
 * Build the curve editor for a filter layer. The point lists live in
 * `layer.params[param.key]` ({rgb, r, g, b}); a drag starts with
 * `callbacks.begin()` (undo snapshot of the old params), then replaces the
 * object with a fresh copy (the snapshot copies params shallowly, so the old
 * object must stay untouched), mutates the copy while calling
 * `callbacks.preview()`, and ends with `callbacks.commit()`.
 * `histogram()` may return a 256-bin array of the filter input to draw behind the curve.
 */
export function buildCurvesControl(layer, param, callbacks, { histogram } = {}) {
    const key = param.key;
    const state = { channel: "rgb", drag: null, hover: -1 };
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const wrap = document.createElement("div");
    wrap.className = "ipc-curves";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;";
    for (const ev of ["click", "pointerdown", "dblclick", "keydown"]) wrap.addEventListener(ev, callbacks.stop);

    const head = document.createElement("div");
    head.style.cssText = "display:flex;gap:3px;align-items:center;";
    const chButtons = {};
    const mkButton = (text, title) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = text; b.title = title;
        b.style.cssText = "font:11px system-ui,sans-serif;padding:1px 7px;border-radius:4px;border:1px solid #3a3a3a;background:#161616;color:#aaa;cursor:pointer;";
        return b;
    };
    for (const ch of CURVE_CHANNELS) {
        const b = mkButton(CHANNEL_LABEL[ch], ch === "rgb" ? "Master curve (all channels)" : `${CHANNEL_LABEL[ch]} channel curve`);
        b.addEventListener("click", () => { state.channel = ch; state.hover = -1; syncButtons(); draw(); });
        chButtons[ch] = b;
        head.appendChild(b);
    }
    const spacer = document.createElement("span"); spacer.style.flex = "1"; head.appendChild(spacer);
    const reset = mkButton("Reset", "Reset this channel to a straight line (Shift: all channels)");
    reset.addEventListener("click", (e) => {
        const cur = layer.params[key] || curveDefaults();
        const all = e.shiftKey;
        const touched = all ? !CURVE_CHANNELS.every((ch) => isIdentityCurve(cur[ch])) : !isIdentityCurve(cur[state.channel]);
        if (!touched) return;
        callbacks.begin();
        const next = cloneCurves(cur);
        if (all) for (const ch of CURVE_CHANNELS) next[ch] = identityCurve(); else next[state.channel] = identityCurve();
        layer.params[key] = next;
        callbacks.commit();
        draw();
    });
    head.appendChild(reset);
    wrap.appendChild(head);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(BOX_W * dpr); canvas.height = Math.round(BOX_H * dpr);
    canvas.style.cssText = `width:${BOX_W}px;height:${BOX_H}px;max-width:100%;border:1px solid #3a3a3a;border-radius:4px;background:#161616;cursor:crosshair;touch-action:none;display:block;`;
    canvas.title = "Click adds a point, drag moves it, drag it out of the box or double-click removes it";
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const curves = () => {
        let c = layer.params[key];
        if (!c || typeof c !== "object") { c = curveDefaults(); layer.params[key] = c; }
        return c;
    };
    const points = () => { const c = curves(); if (!Array.isArray(c[state.channel])) c[state.channel] = identityCurve(); return c[state.channel]; };
    const syncButtons = () => {
        for (const ch of CURVE_CHANNELS) {
            const on = ch === state.channel;
            chButtons[ch].style.background = on ? "#2b3a4f" : "#161616";
            chButtons[ch].style.color = on ? (ch === "rgb" ? "#7cc7ff" : CHANNEL_COLOR[ch]) : "#aaa";
        }
    };

    // curve coordinates (0..255, y up) <-> canvas pixels
    const innerW = BOX_W - 2 * PAD, innerH = BOX_H - 2 * PAD;
    const toPx = (x, y) => [PAD + x / 255 * innerW, PAD + (1 - y / 255) * innerH];
    const fromEvent = (e) => {
        const r = canvas.getBoundingClientRect();
        const sx = r.width ? BOX_W / r.width : 1, sy = r.height ? BOX_H / r.height : 1;
        const cx = (e.clientX - r.left) * sx, cy = (e.clientY - r.top) * sy;
        return { cx, cy, x: (cx - PAD) / innerW * 255, y: (1 - (cy - PAD) / innerH) * 255 };
    };
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    const nearest = (cx, cy) => {
        const pts = points();
        let best = -1, bd = HIT * HIT;
        for (let i = 0; i < pts.length; i++) { const [px, py] = toPx(pts[i][0], pts[i][1]); const dd = (px - cx) * (px - cx) + (py - cy) * (py - cy); if (dd < bd) { bd = dd; best = i; } }
        return best;
    };

    function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, BOX_W, BOX_H);
        ctx.fillStyle = "#161616"; ctx.fillRect(0, 0, BOX_W, BOX_H);
        // histogram of the filter input (luma), when the editor can provide one
        const hist = typeof histogram === "function" ? histogram() : null;
        if (hist && hist.length === 256) {
            let mx = 0;
            for (let i = 0; i < 256; i++) if (hist[i] > mx) mx = hist[i];
            if (mx > 0) {
                ctx.fillStyle = "#2e2e2e";
                for (let i = 0; i < 256; i++) {
                    const hh = Math.sqrt(hist[i] / mx) * innerH;   // sqrt: a single peak does not flatten the rest
                    const [x0] = toPx(i, 0);
                    ctx.fillRect(x0, PAD + innerH - hh, innerW / 255 + 0.5, hh);
                }
            }
        }
        // grid and the identity diagonal
        ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
            const x = Math.round(PAD + innerW * i / 4) + 0.5, y = Math.round(PAD + innerH * i / 4) + 0.5;
            ctx.moveTo(x, PAD); ctx.lineTo(x, PAD + innerH);
            ctx.moveTo(PAD, y); ctx.lineTo(PAD + innerW, y);
        }
        ctx.stroke();
        ctx.strokeStyle = "#333";
        ctx.beginPath(); ctx.moveTo(...toPx(0, 0)); ctx.lineTo(...toPx(255, 255)); ctx.stroke();
        // the other channels, faint
        const c = curves();
        for (const ch of CURVE_CHANNELS) {
            if (ch === state.channel || isIdentityCurve(c[ch])) continue;
            drawCurve(curveTable(c[ch]), CHANNEL_COLOR[ch], 0.35, 1);
        }
        const pts = points();
        drawCurve(curveTable(pts), CHANNEL_COLOR[state.channel], 1, 1.5);
        for (let i = 0; i < pts.length; i++) {
            const [px, py] = toPx(pts[i][0], pts[i][1]);
            const active = state.drag ? state.drag.idx === i : state.hover === i;
            ctx.beginPath(); ctx.arc(px, py, active ? 4 : 3, 0, Math.PI * 2);
            ctx.fillStyle = active ? "#fff" : "#161616";
            ctx.fill();
            ctx.strokeStyle = CHANNEL_COLOR[state.channel]; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (state.drag && state.drag.removed) {
            ctx.fillStyle = "#888"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center";
            ctx.fillText("release to remove the point", BOX_W / 2, BOX_H - 4);
        }
    }
    function drawCurve(table, color, alpha, width) {
        ctx.save();
        ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round";
        ctx.beginPath();
        for (let x = 0; x < 256; x++) { const [px, py] = toPx(x, table[x]); if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
        ctx.stroke();
        ctx.restore();
    }

    /** Make the point lists private to this gesture (the undo snapshot keeps the old object) and return the active one. */
    const beginEdit = () => {
        callbacks.begin();
        const next = cloneCurves(curves());
        layer.params[key] = next;
        return next[state.channel];
    };
    const insertSorted = (pts, x, y) => {
        let i = 0;
        while (i < pts.length && pts[i][0] < x) i++;
        pts.splice(i, 0, [x, y]);
        // a re-inserted point may share a column with a neighbour: nudge it into a free one
        if (i > 0 && pts[i][0] <= pts[i - 1][0]) pts[i][0] = pts[i - 1][0] + 1;
        if (i < pts.length - 1 && pts[i][0] >= pts[i + 1][0]) pts[i][0] = pts[i + 1][0] - 1;
        return i;
    };
    const constrainX = (pts, i, x) => {
        if (i === 0 || i === pts.length - 1) return pts[i][0];   // end points only move vertically
        return Math.min(pts[i + 1][0] - 1, Math.max(pts[i - 1][0] + 1, x));
    };

    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const q = fromEvent(e);
        let idx = nearest(q.cx, q.cy);
        const pts = beginEdit();
        if (idx < 0) {
            const x = Math.round(clamp(q.x)), y = Math.round(clamp(q.y));
            if (pts.some((p) => Math.abs(p[0] - x) < 1)) { callbacks.commit(); return; }   // a point already sits on this column
            idx = insertSorted(pts, x, y);
        }
        state.drag = { idx, removed: false };
        state.hover = idx;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
        callbacks.preview();
        draw();
    });
    canvas.addEventListener("pointermove", (e) => {
        const q = fromEvent(e);
        const d = state.drag;
        if (!d) {
            const h = nearest(q.cx, q.cy);
            if (h !== state.hover) { state.hover = h; draw(); }
            return;
        }
        e.preventDefault();
        const pts = points();
        const far = q.cx < -OFF_REMOVE || q.cx > BOX_W + OFF_REMOVE || q.cy < -OFF_REMOVE || q.cy > BOX_H + OFF_REMOVE;
        if (d.removed) {
            if (far) return;
            d.idx = insertSorted(pts, Math.round(clamp(q.x)), Math.round(clamp(q.y)));
            d.removed = false;
        } else if (far && d.idx > 0 && d.idx < pts.length - 1 && pts.length > 2) {
            pts.splice(d.idx, 1);
            d.removed = true; d.idx = -1;
        } else {
            const p = pts[d.idx];
            p[0] = Math.round(constrainX(pts, d.idx, clamp(q.x)));
            p[1] = Math.round(clamp(q.y));
        }
        state.hover = d.idx;
        callbacks.preview();
        draw();
    });
    const endDrag = (e) => {
        if (!state.drag) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
        state.drag = null;
        callbacks.commit();
        draw();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => { if (!state.drag && state.hover !== -1) { state.hover = -1; draw(); } });
    canvas.addEventListener("pointerenter", () => draw());   // picks up a histogram computed after the row was built
    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const q = fromEvent(e);
        const idx = nearest(q.cx, q.cy);
        const cur = points();
        if (idx <= 0 || idx >= cur.length - 1 || cur.length <= 2) return;
        const pts = beginEdit();
        pts.splice(idx, 1);
        state.hover = -1;
        callbacks.commit();
        draw();
    });

    syncButtons();
    draw();
    requestAnimationFrame(draw);
    return wrap;
}
