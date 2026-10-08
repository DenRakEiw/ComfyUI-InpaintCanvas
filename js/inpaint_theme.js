// Generated from DenRakEiw/scumble renderer/editor/inpaint_theme.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
/**
 * The skin tokens (docs/SKINS.md, contract version 1) and the few canvas colours of the editor's chrome that follow
 * them: the rulers, the brush-tip thumbnail and the curves control. Every other canvas colour stays literal.
 * `THEME` holds the colours the draw code reads; its defaults are the literals those sites drew before skins, so a
 * host that never calls `refreshTheme()` (the ComfyUI node) draws exactly as before. The app shell (renderer/skins.js)
 * calls `refreshTheme()` after a skin is applied and then `themeChanged()` on every editor. No imports, and no DOM
 * access at import: Node can load this module as it is.
 */
export const SKIN_TOKENS_VERSION = 1;
export const SKIN_TOKENS = Object.freeze([
  { name: "--sc-bg", kind: "color", default: "#181818" }, { name: "--sc-chrome", kind: "color", default: "#1f1f1f" },
  { name: "--sc-chrome-edge", kind: "color", default: "#000" }, { name: "--sc-surface", kind: "color", default: "#202020" },
  { name: "--sc-raised", kind: "color", default: "#262626" }, { name: "--sc-selected", kind: "color", default: "#2b3a4f" },
  { name: "--sc-well", kind: "color", default: "#161616" }, { name: "--sc-field", kind: "color", default: "#111" },
  { name: "--sc-btn", kind: "color", default: "#2d2d2d" }, { name: "--sc-btn-hover", kind: "color", default: "#3a3a3a" },
  { name: "--sc-border", kind: "color", default: "#444" }, { name: "--sc-line", kind: "color", default: "#333" },
  { name: "--sc-fg-strong", kind: "color", default: "#eee" }, { name: "--sc-fg", kind: "color", default: "#ddd" },
  { name: "--sc-fg-2", kind: "color", default: "#aaa" }, { name: "--sc-muted", kind: "color", default: "#888" },
  { name: "--sc-faint", kind: "color", default: "#777" }, { name: "--sc-accent", kind: "color", default: "#f0c674" },
  { name: "--sc-active", kind: "color", default: "#4a90d9" }, { name: "--sc-active-bg", kind: "color", default: "#2f5f9f" },
  { name: "--sc-on-active", kind: "color", default: "#fff" }, { name: "--sc-go", kind: "color", default: "#2f6b3f" },
  { name: "--sc-warn", kind: "color", default: "#f0c674" }, { name: "--sc-ok", kind: "color", default: "#7cc47f" },
  { name: "--sc-error", kind: "color", default: "#e0533d" }, { name: "--sc-error-bg", kind: "color", default: "#3a1f1c" },
  { name: "--sc-link", kind: "color", default: "#7cc7ff" }, { name: "--sc-backdrop", kind: "color", default: "rgba(0, 0, 0, 0.55)" },
  { name: "--sc-shadow", kind: "shadow", default: "0 8px 24px rgba(0,0,0,.55)" }, { name: "--sc-scheme", kind: "scheme", default: "normal" },
  { name: "--sc-control", kind: "control", default: "auto" }, { name: "--sc-scrollbar", kind: "scrollbar", default: "auto" },
  { name: "--sc-font", kind: "font", default: "system-ui, sans-serif" }, { name: "--sc-font-mono", kind: "font", default: "ui-monospace, Consolas, monospace" },
  { name: "--sc-radius-sm", kind: "radius", default: "3px" }, { name: "--sc-radius", kind: "radius", default: "3px" },
  { name: "--sc-radius-lg", kind: "radius", default: "6px" },
]);
export const THEME_DEFAULTS = Object.freeze({ rulerBg: "#1c1c1c", rulerEdge: "#3a3a3a", rulerText: "#9a9a9a", rulerTick: "#777",
  tipGlyph: "#e8e8e8", curveBg: "#161616", curveHist: "#2e2e2e", curveGrid: "#2a2a2a", curveDiag: "#333", curvePoint: "#fff",
  curveHint: "#888", curveRgb: "#e6e6e6" });
export const THEME_TOKENS = Object.freeze({ rulerBg: "--sc-chrome", rulerEdge: "--sc-line", rulerText: "--sc-muted", rulerTick: "--sc-faint",
  tipGlyph: "--sc-fg", curveBg: "--sc-well", curveHist: "--sc-raised", curveGrid: "--sc-line", curveDiag: "--sc-line",
  curvePoint: "--sc-fg-strong", curveHint: "--sc-muted", curveRgb: "--sc-fg" });
export const THEME = { ...THEME_DEFAULTS, version: 0 };
export function refreshTheme(root = document.documentElement) {
  const cs = getComputedStyle(root);
  for (const k of Object.keys(THEME_DEFAULTS)) {
    const v = cs.getPropertyValue(THEME_TOKENS[k]).trim();
    THEME[k] = v && CSS.supports("color", v) ? v : THEME_DEFAULTS[k];
  }
  THEME.version++;
  return THEME;
}
