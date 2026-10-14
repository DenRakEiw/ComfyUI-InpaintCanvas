// Generated from DenRakEiw/scumble renderer/editor/inpaint_status.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// The status line's kinds (item 45, docs/PLAN_0_1_48.md S1 / S2): "error" and "warn" show red and blink five times
// (the user counts warnings as errors; the app log keeps the two levels apart), "" is a plain line. Shared by the
// editor, the app host, the shell and the plugin API; no imports, so every host can load it.

// A line without a kind is judged by its text: the failures the app log has always caught, and the
// "... needs X: download it in Settings" lines.
const ERROR_TEXT = /^(error|failed|could not|cannot|no api key)|error invoking|failed[:.](?=\s|$)| failed /i;
const WARN_TEXT = /\bdownload (?:it|one) in settings\b|\bmodel is downloaded \(settings\b/i;

/** The kind a status text has by itself: "error", "warn" or "". */
export function statusKindOf(text) {
    const t = String(text == null ? "" : text);
    return ERROR_TEXT.test(t) ? "error" : WARN_TEXT.test(t) ? "warn" : "";
}

/** setStatus's kind: `opts` is "error" / "warn" / "info" or { kind }; "info" keeps a line plain whatever it says. */
export function statusKindFor(text, opts) {
    const k = typeof opts === "string" ? opts : opts && typeof opts === "object" ? opts.kind : undefined;
    if (k === "error" || k === "warn") return k;
    if (k === "info") return "";
    return statusKindOf(text);
}

/** Whether a caught error is a cancel (the user's, or a newer action's), which stays a plain line. */
export function isCancel(err) {
    if (!err) return false;
    if (err.kind === "cancelled" || err.name === "AbortError" || err.cancelled === true) return true;
    return /^(cancel(l?ed)?\b|aborted\b)/i.test(String(err.message || err).trim());
}

/**
 * The kind of a line that shows a caught error: the kind the thrower gave it (refusal below), plain for a cancel,
 * else an error.
 */
export function failKind(err) {
    const k = err && err.statusKind;
    if (k === "error" || k === "warn" || k === "info") return k;
    return isCancel(err) ? "info" : "error";
}

/**
 * An Error for a refusal that a catch shows in the status line: plain by default (a step of the user's fixes it: select
 * an area, wait for the run, pick a recipe), "warn" for a limit; failKind reads the kind back.
 */
export function refusal(text, kind = "info") {
    return Object.assign(new Error(text), { statusKind: kind });
}
