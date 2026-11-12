// Generated from DenRakEiw/scumble renderer/editor/inpaint_style.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the editor's style sheet: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

// ---------------------------------------------------------------------------
// styles (injected once)
// ---------------------------------------------------------------------------

const STYLE = `
.ipc-node { display:flex; flex-direction:column; gap:6px; width:100%; height:100%; box-sizing:border-box; padding:4px;
  color:var(--sc-fg, #ccc); font:12px/1.3 var(--sc-font, system-ui, sans-serif); }
.ipc-node .ipc-thumb { flex:1; min-height:80px; width:100%; border-radius:var(--sc-radius-lg, 6px); background:var(--sc-well, #1a1a1a); cursor:pointer;
  display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; }
.ipc-node .ipc-thumb canvas { max-width:100%; max-height:100%; display:block; }
.ipc-node .ipc-thumb .ipc-hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  text-align:center; color:var(--sc-faint, #777); padding:12px; pointer-events:none; white-space:pre-line; }
.ipc-node .ipc-open { display:flex; align-items:center; justify-content:center; gap:8px; padding:7px 10px; border-radius:var(--sc-radius, 6px);
  background:var(--sc-active-bg, #2f5f9f); color:var(--sc-on-active, #fff); border:1px solid var(--sc-active, #4a90d9); cursor:pointer; font:inherit; font-weight:600; }
.ipc-node .ipc-open:hover { background:var(--sc-active-bg, #3a70b8); }
.ipc-node .ipc-status { color:var(--sc-muted, #888); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.ipc-modal [hidden] { display:none !important; }
.ipc-modal { position:fixed; inset:0; z-index:10000; display:flex; flex-direction:column; background:var(--sc-bg, #181818); color:var(--sc-fg, #ddd);
  font:13px/1.3 var(--sc-font, system-ui, sans-serif); outline:none; }
.ipc-top { display:flex; align-items:center; gap:10px; padding:6px 10px; background:var(--sc-chrome, #242424); border-bottom:1px solid var(--sc-chrome-edge, #0d0d0d); flex-wrap:wrap; }
.ipc-top .ipc-title { font-weight:600; margin-right:6px; }
.ipc-top .ipc-grow { flex:1; }
.ipc-top .ipc-viewbox { display:inline-flex; gap:4px; margin-left:4px; }
.ipc-top .ipc-viewbox .ipc-ib { padding:4px 7px; min-width:0; }
.ipc-top label { display:flex; align-items:center; gap:6px; color:var(--sc-fg-2, #aaa); font-size:12px; }
.ipc-top label span { min-width:36px; text-align:right; color:var(--sc-fg-2, #ccc); }
.ipc-top input[type=range] { width:100px; }
.ipc-top input[type=color] { width:34px; height:26px; padding:0; border:1px solid var(--sc-border, #4a4a4a); border-radius:var(--sc-radius, 5px); background:var(--sc-btn, #333); cursor:pointer; }
.ipc-ib { display:inline-flex; align-items:center; justify-content:center; gap:6px; background:var(--sc-btn, #333); color:var(--sc-fg, #ddd); border:1px solid var(--sc-border, #4a4a4a);
  border-radius:var(--sc-radius, 6px); padding:5px 8px; cursor:pointer; font:inherit; min-width:32px; }
.ipc-ib:hover { background:var(--sc-btn-hover, #444); color:var(--sc-fg-strong, #fff); }
.ipc-ib.ipc-active { background:var(--sc-active-bg, #2f5f9f); border-color:var(--sc-active, #4a90d9); color:var(--sc-on-active, #fff); }
.ipc-ib.ipc-toggle-on { background:var(--sc-selected, #3d3d2a); border-color:var(--sc-accent, #a08a2a); color:var(--sc-accent, #ffd166); }
.ipc-ib.ipc-primary { background:var(--sc-go, #2f7f4f); border-color:var(--sc-go, #3fa76a); color:var(--sc-on-active, #fff); padding:5px 12px; }
.ipc-ib.ipc-primary:hover { background:var(--sc-go, #39955d); }
.ipc-ib.ipc-danger:hover { background:var(--sc-error-bg, #7a2f2f); }
.ipc-ib.ipc-small { padding:3px 7px; font-size:12px; min-width:0; }
.ipc-body { display:flex; flex:1; min-height:0; }
.ipc-tools { display:flex; flex-direction:column; gap:4px; padding:6px; background:var(--sc-surface, #202020); border-right:1px solid var(--sc-chrome-edge, #0d0d0d); overflow:auto; }
.ipc-tools .ipc-ib { width:38px; height:36px; padding:0; transition:none; user-select:none; -webkit-user-select:none; }
.ipc-tools .ipc-ib:active { background:var(--sc-btn-hover, #555); transform:translateY(1px); }
.ipc-groupbtn .ipc-tri { pointer-events:none; }
.ipc-tools .ipc-sep { height:1px; background:var(--sc-line, #3a3a3a); margin:4px 2px; }
.ipc-tools .ipc-grp { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:var(--sc-faint, #666); text-align:center; margin:2px 0 -1px; }
.ipc-groupbtn { position:relative; }
.ipc-groupbtn .ipc-tri { position:absolute; right:2px; bottom:2px; width:0; height:0; border-left:6px solid transparent; border-bottom:6px solid var(--sc-fg-2, #c0c0c0); }
.ipc-sec .ipc-gap { width:6px; }
.ipc-ask { position:absolute; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:var(--sc-backdrop, rgba(0,0,0,.55)); }
.ipc-askbox { min-width:320px; max-width:520px; display:flex; flex-direction:column; gap:10px; padding:16px;
  background:var(--sc-surface, #242424); border:1px solid var(--sc-border, #4a4a4a); border-radius:var(--sc-radius-lg, 10px); box-shadow:var(--sc-shadow, 0 12px 40px rgba(0,0,0,.6)); }
.ipc-askbox .ipc-asktitle { font-weight:600; font-size:14px; }
.ipc-askbox .ipc-askmsg { color:var(--sc-fg-2, #aaa); white-space:pre-line; }
.ipc-askbox .ipc-askinput { background:var(--sc-field, #1b1b1b); color:var(--sc-fg, #eee); border:1px solid var(--sc-line, #4a4a4a); border-radius:var(--sc-radius, 6px); padding:7px 9px; font:inherit; }
.ipc-askbox .ipc-askrow { display:flex; gap:8px; align-items:center; }
.ipc-askbox .ipc-askfields { display:flex; flex-wrap:wrap; gap:10px; }
.ipc-askbox .ipc-askfield { display:flex; flex-direction:column; gap:4px; flex:1 1 0; min-width:0; font-size:12px; color:var(--sc-fg-2, #aaa); }
.ipc-askbox .ipc-askfield input, .ipc-askbox .ipc-askfield select { width:100%; box-sizing:border-box; }
.ipc-askbox .ipc-askfield .ipc-askinput:disabled { opacity:.55; }
.ipc-askbox .ipc-askwide, .ipc-askbox .ipc-asknote { flex-basis:100%; }
.ipc-askbox .ipc-asknote { font-size:12px; color:var(--sc-fg-2, #aaa); }
.ipc-askbox .ipc-askfields > [hidden] { display:none; }
.ipc-askbox .ipc-asklink { display:flex; gap:6px; align-items:center; color:var(--sc-fg-2, #aaa); font-size:12px; }
.ipc-askbox .ipc-asklink.ipc-off { opacity:.5; }
.ipc-flyout { position:absolute; z-index:6; display:flex; flex-direction:column; gap:3px; padding:5px; background:var(--sc-raised, #262626); border:1px solid var(--sc-border, #444); border-radius:var(--sc-radius-lg, 8px); box-shadow:var(--sc-shadow, 0 8px 24px rgba(0,0,0,.55)); min-width:170px; }
.ipc-flyout .ipc-ib { justify-content:flex-start; padding:5px 10px; width:auto; height:auto; text-align:left; white-space:nowrap; }
.ipc-flyout .ipc-key { margin-left:auto; padding-left:14px; color:var(--sc-muted, #8a8a8a); font-size:11px; }
.ipc-flyout .ipc-sep { height:1px; background:var(--sc-line, #3a3a3a); margin:3px 2px; }
.ipc-flyout .ipc-ib:disabled, .ipc-flyout .ipc-ib:disabled:hover { opacity:.4; cursor:default; background:var(--sc-btn, #333); color:var(--sc-fg, #ddd); }
.ipc-choices { max-height:60vh; overflow-y:auto; overflow-x:hidden; min-width:180px; }
.ipc-choices-group { font-size:10px; font-weight:600; color:var(--sc-muted, #8a8a8a); padding:6px 10px 2px 10px; text-transform:uppercase; letter-spacing:0.5px; }
.ipc-choice-item { display:flex; align-items:center; justify-content:flex-start; padding:5px 10px; border-radius:var(--sc-radius-sm, 4px); cursor:pointer; font-size:12px; color:var(--sc-fg, #ddd); white-space:nowrap; text-align:left; background:transparent; border:none; width:100%; box-sizing:border-box; }
.ipc-choice-item:hover, .ipc-choice-item.ipc-active { background:var(--sc-btn-hover, #3a3a3a); color:var(--sc-fg-strong, #fff); }
.ipc-choice-item.ipc-current { font-weight:600; color:var(--sc-accent, #4a90d9); }
.ipc-view { flex:1; position:relative; overflow:hidden; min-width:0; cursor:crosshair;
  background-color:#2b2b2b;
  background-image: linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),
    linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%);
  background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
.ipc-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; }
.ipc-view.ipc-pan { cursor:grab; }
.ipc-view.ipc-panning { cursor:grabbing; }
.ipc-view.ipc-move { cursor:move; }
.ipc-view.ipc-scale { cursor:nwse-resize; }
.ipc-view.ipc-scale-ne { cursor:nesw-resize; }
.ipc-view.ipc-scale-x { cursor:ew-resize; }
.ipc-view.ipc-scale-y { cursor:ns-resize; }
.ipc-view.ipc-rotate { cursor:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M19 12a7 7 0 1 1-2-4.9' fill='none' stroke='black' stroke-width='4.5' stroke-linecap='round'/><path d='M19 3v5h-5' fill='none' stroke='black' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'/><path d='M19 12a7 7 0 1 1-2-4.9' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'/><path d='M19 3v5h-5' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>") 12 12, alias; }
.ipc-drop { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center;
  color:#888; pointer-events:none; padding:20px; white-space:pre-line; font-size:15px; }
.ipc-side { width:var(--ipc-side-w, 320px); min-width:310px; max-width:60%; position:relative; display:flex; flex-direction:column; background:var(--sc-surface, #202020); border-left:1px solid var(--sc-chrome-edge, #0d0d0d); overflow:hidden; }
.ipc-tabs { display:flex; background:var(--sc-well, #1a1a1a); border-bottom:1px solid var(--sc-chrome-edge, #0d0d0d); flex:none; }
.ipc-tab { flex:1; background:transparent; border:none; border-bottom:2px solid transparent; color:var(--sc-muted, #888); padding:8px 0 6px; font:inherit; font-size:11px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.ipc-tab:hover { color:var(--sc-fg, #ddd); }
.ipc-tab.ipc-active { color:var(--sc-fg-strong, #fff); border-bottom-color:var(--sc-active, #4a90d9); }
.ipc-pane { display:flex; flex-direction:column; overflow:auto; flex:1; min-height:0; }
.ipc-side-grip { position:absolute; left:0; top:0; bottom:0; width:5px; cursor:col-resize; z-index:4; touch-action:none; }
.ipc-side-grip:hover, .ipc-side-grip.ipc-dragging { background:var(--sc-accent, #ffd166); opacity:.55; }
.ipc-side h4, .ipc-side summary { margin:0; padding:6px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--sc-muted, #999); background:var(--sc-raised, #262626);
  border-bottom:1px solid var(--sc-chrome-edge, #0d0d0d); border-top:1px solid var(--sc-chrome-edge, #0d0d0d); display:flex; align-items:center; gap:6px; cursor:default; list-style:none; }
.ipc-side summary { cursor:pointer; }
.ipc-side summary::-webkit-details-marker { display:none; }
.ipc-side summary::before { content:"▸"; color:var(--sc-faint, #666); font-size:10px; }
.ipc-side details[open] > summary::before { content:"▾"; }
.ipc-side h4 .ipc-grow, .ipc-side summary .ipc-grow { flex:1; }
.ipc-side h4 .ipc-mini { width:24px; height:22px; }
.ipc-sec { padding:8px 10px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--sc-fg-2, #aaa); font-size:12px; }
.ipc-sec .ipc-seg { display:flex; gap:6px; width:100%; align-items:center; }
.ipc-sec .ipc-seg input[type=text] { flex:1; min-width:0; background:var(--sc-field, #161616); color:var(--sc-fg, #ddd); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); padding:4px 6px; font:inherit; }
.ipc-sec .ipc-seg input[type=text]:focus { outline:none; border-color:var(--sc-active, #4a90d9); }
.ipc-sec .ipc-modes { display:flex; gap:2px; }
.ipc-sec .ipc-modes .ipc-ib { padding:2px 7px; min-width:0; font-size:11px; border-radius:var(--sc-radius, 4px); }
.ipc-sec .ipc-row4 { display:grid; grid-template-columns:auto 1fr auto 1fr; gap:4px 6px; align-items:center; width:100%; }
.ipc-num { background:var(--sc-field, #161616); color:var(--sc-fg, #ddd); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); padding:3px 5px; font:inherit; }
.ipc-sel { background:var(--sc-field, #161616); color:var(--sc-fg, #ccc); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); padding:2px 4px; font:11px var(--sc-font, system-ui, sans-serif); max-width:110px; }
.ipc-list { overflow:auto; flex:none; min-height:90px; max-height:56vh; }
.ipc-list.ipc-reflist { min-height:0; max-height:30vh; }
.ipc-list.ipc-reflist:empty::after { content:"No references. Drop images here or use the button above."; display:block; padding:8px 10px; color:var(--sc-faint, #666); font-size:11px; }
.ipc-tipthumb { width:48px; height:24px; vertical-align:middle; background:var(--sc-well, #1a1a1a); border:1px solid var(--sc-line, #444); border-radius:var(--sc-radius-sm, 3px); margin-right:4px; }
.ipc-tipbtn { display:inline-flex; align-items:center; gap:1px; padding:0; margin:0; background:transparent; border:none; color:var(--sc-fg-2, #aaa); cursor:pointer; font:inherit; }
.ipc-tipbtn .ipc-tipthumb { margin-right:0; }
.ipc-tipbtn:hover .ipc-tipthumb, .ipc-tipbtn.ipc-open .ipc-tipthumb { border-color:var(--sc-active, #4a90d9); }
.ipc-tipbtn:hover, .ipc-tipbtn.ipc-open { color:var(--sc-fg-strong, #fff); }
.ipc-tipbtn .ipc-caret { font-size:9px; width:9px; min-width:0; text-align:center; }
.ipc-tippop { position:absolute; z-index:7; width:360px; box-sizing:border-box; display:flex; flex-direction:column; gap:6px; padding:8px; background:var(--sc-raised, #262626); border:1px solid var(--sc-border, #444);
  border-radius:var(--sc-radius-lg, 8px); box-shadow:var(--sc-shadow, 0 8px 24px rgba(0,0,0,.55)); color:var(--sc-fg, #ddd); font-size:12px; }
.ipc-tippop [hidden] { display:none !important; }
.ipc-tippop .ipc-tp-head { display:flex; gap:6px; align-items:center; }
.ipc-tippop input[type=search] { flex:1; min-width:0; background:var(--sc-field, #161616); color:var(--sc-fg, #ddd); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); padding:4px 6px; font:inherit; }
.ipc-tippop input[type=search]:focus { outline:none; border-color:var(--sc-active, #4a90d9); }
.ipc-tippop .ipc-tp-label { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--sc-muted, #999); }
.ipc-tippop .ipc-tp-sec { display:flex; flex-direction:column; gap:4px; }
.ipc-tippop .ipc-tp-recent { display:flex; gap:4px; flex-wrap:wrap; }
.ipc-tippop .ipc-tp-chip { width:36px; height:36px; padding:0; display:flex; align-items:center; justify-content:center; background:var(--sc-well, #1a1a1a); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); cursor:pointer; }
.ipc-tippop .ipc-tp-chip:hover { border-color:var(--sc-fg-2, #aaa); }
.ipc-tippop .ipc-tp-chip.ipc-active { border-color:var(--sc-active, #4a90d9); box-shadow:inset 0 0 0 1px var(--sc-active, #4a90d9); }
.ipc-tippop .ipc-tp-list { overflow:auto; flex:1 1 auto; min-height:60px; display:flex; flex-direction:column; margin:0 -4px; padding:0 4px; }
.ipc-tippop .ipc-tp-group { flex:none; font-size:10px; color:var(--sc-faint, #777); padding:6px 4px 2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ipc-tippop .ipc-tp-row { flex:none; display:flex; align-items:center; gap:8px; padding:3px 4px; border-radius:var(--sc-radius, 4px); cursor:pointer; }
.ipc-tippop .ipc-tp-row:hover, .ipc-tippop .ipc-tp-row.ipc-cursor { background:var(--sc-btn-hover, #3a3a3a); }
.ipc-tippop .ipc-tp-row.ipc-active { background:var(--sc-selected, #2b3a4f); box-shadow:inset 3px 0 0 var(--sc-active, #4a90d9); }
.ipc-tippop .ipc-tp-row canvas { flex:none; background:var(--sc-well, #1a1a1a); border-radius:var(--sc-radius-sm, 3px); }
.ipc-tippop .ipc-tp-name { flex:1; min-width:0; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-height:1.25; overflow-wrap:anywhere; }
.ipc-tippop .ipc-tp-empty { color:var(--sc-faint, #777); padding:8px 4px; }
.ipc-tippop .ipc-tp-foot { font-size:10px; color:var(--sc-faint, #777); }
.ipc-refcount { color:var(--sc-link, #7cc7ff); font-size:10px; margin-left:6px; text-transform:none; letter-spacing:0; }
.ipc-side h4 .ipc-sel.ipc-narrow { max-width:80px; font-size:11px; padding:1px 4px; }
.ipc-layer { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-bottom:1px solid var(--sc-line, #161616); cursor:pointer; }
.ipc-layer:hover { background:var(--sc-raised, #262b33); }
.ipc-layer.ipc-selected { background:var(--sc-selected, #2b3a4f); box-shadow: inset 3px 0 0 var(--sc-active, #4a90d9); }
.ipc-layer.ipc-multi { background:var(--sc-selected, #2b3a4f); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--sc-active, #4a90d9) 45%, transparent); }
.ipc-layer .ipc-row { display:flex; align-items:center; gap:3px; min-width:0; }
.ipc-layer .ipc-row > .ipc-mini { width:22px; flex:none; }
.ipc-layer .ipc-name { flex:1 1 48px; min-width:48px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-layer .ipc-kind { font-size:10px; color:var(--sc-faint, #777); text-transform:uppercase; }
.ipc-layer .ipc-kind.ipc-ctrl { color:var(--sc-warn, #ffb347); }
.ipc-layer .ipc-kind.ipc-ref { color:var(--sc-link, #7cc7ff); }
.ipc-layer .ipc-kind.ipc-fxk { color:var(--sc-accent, #c7a2ff); }
.ipc-layer .ipc-lthumb { width:40px; height:28px; flex:none; border-radius:var(--sc-radius-sm, 3px); border:1px solid var(--sc-line, #111); background-color:#3a3a3a;
  background-image: linear-gradient(45deg,#555 25%,transparent 25%),linear-gradient(-45deg,#555 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#555 75%),linear-gradient(-45deg,transparent 75%,#555 75%);
  background-size:8px 8px; background-position:0 0,0 4px,4px -4px,-4px 0; }
.ipc-layer .ipc-name input { width:100%; box-sizing:border-box; background:var(--sc-field, #151515); color:var(--sc-fg, #eee); border:1px solid var(--sc-active, #4a90d9); border-radius:var(--sc-radius, 3px); font:inherit; padding:1px 4px; }
.ipc-layer.ipc-drop-above { box-shadow: inset 0 3px 0 var(--sc-active, #7cc7ff); }
.ipc-layer.ipc-drop-below { box-shadow: inset 0 -3px 0 var(--sc-active, #7cc7ff); }
.ipc-layer.ipc-dragging { opacity:.5; }
.ipc-layer.ipc-locked .ipc-name { color:var(--sc-muted, #999); }
.ipc-layer .ipc-clipmark { flex:none; display:flex; color:var(--sc-muted, #999); margin-right:-1px; }
.ipc-layer .ipc-clipmark.ipc-noeffect { opacity:.4; }
.ipc-layer.ipc-clipbase .ipc-name { text-decoration:underline; text-decoration-color:var(--sc-faint, #777); text-underline-offset:3px; }
.ipc-layer.ipc-clipedge { cursor:alias; }
.ipc-layer { padding-left:calc(8px + var(--ipc-depth, 0) * 14px); }
.ipc-layer.ipc-grouprow { padding-top:4px; padding-bottom:4px; background:var(--sc-well, #1e2126); }
.ipc-layer.ipc-grouprow.ipc-selected { background:var(--sc-selected, #2b3a4f); }
.ipc-layer.ipc-grouprow .ipc-name { font-weight:600; }
.ipc-layer .ipc-gicon { flex:none; display:flex; color:var(--sc-muted, #999); }
.ipc-layer .ipc-row > .ipc-mini.ipc-fold { width:16px; margin-left:-4px; }
.ipc-layer.ipc-ghidden .ipc-name, .ipc-layer.ipc-ghidden .ipc-lthumb { opacity:.45; }
.ipc-mini.ipc-dim { opacity:.35; }
.ipc-mini.ipc-dim:hover { opacity:1; }
.ipc-layer select.ipc-kindsel { background:var(--sc-field, #262626); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); padding:0 1px; font:inherit; font-size:10px; text-transform:uppercase; color:var(--sc-muted, #888); cursor:pointer; flex:0 1 auto; min-width:44px; max-width:84px; }
.ipc-layer select.ipc-kindsel.ipc-ref { color:var(--sc-link, #7cc7ff); border-color:var(--sc-line, #2b4a63); }
.ipc-text { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--sc-muted, #888); }
.ipc-text .ipc-row { display:flex; align-items:center; gap:4px; flex-wrap:wrap; row-gap:3px; }
.ipc-text textarea { width:100%; box-sizing:border-box; min-height:38px; resize:vertical; background:var(--sc-field, #151515); color:var(--sc-fg, #eee); border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 4px); font:inherit; padding:3px 5px; }
.ipc-text input[type=color] { width:26px; height:22px; padding:0; border:1px solid var(--sc-border, #4a4a4a); border-radius:var(--sc-radius, 4px); background:var(--sc-btn, #333); cursor:pointer; }
.ipc-text .ipc-sel { flex:1; min-width:0; }
.ipc-text .ipc-num { width:52px; }
.ipc-fx { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; gap:3px 6px; align-items:center; font-size:11px; color:var(--sc-muted, #888); min-width:0; }
.ipc-fx .ipc-sel { grid-column:1 / -1; width:100%; min-width:0; max-width:100%; box-sizing:border-box; }
.ipc-fx select { width:100%; min-width:0; max-width:100%; box-sizing:border-box; }
.ipc-fx input[type=range] { width:100%; min-width:0; margin:0; }
.ipc-fx input.ipc-fxcolor { width:100%; min-width:0; height:20px; margin:0; padding:0 2px; border:1px solid var(--sc-line, #111); border-radius:var(--sc-radius-sm, 3px); background:none; cursor:pointer; }
.ipc-fx b.ipc-hex { width:auto; font-family:ui-monospace, monospace; }
.ipc-fx b { width:42px; text-align:right; font-weight:500; color:var(--sc-fg-2, #bbb); }
.ipc-fx .ipc-lutrow { grid-column:1 / -1; display:flex; gap:6px; align-items:center; min-width:0; }
.ipc-fx .ipc-lutrow span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--sc-fg-2, #aaa); }
.ipc-wheels { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.ipc-wheel { display:flex; flex-direction:column; align-items:center; gap:2px; }
.ipc-wheel span { color:var(--sc-muted, #888); }
.ipc-hsl { display:flex; flex-direction:column; gap:6px; }
.ipc-hsl-head { display:flex; gap:4px; align-items:center; }
.ipc-hsl-rows { display:flex; flex-direction:column; gap:3px; }
.ipc-hsl-row { display:flex; align-items:center; gap:6px; }

.ipc-layer .ipc-maskrow { display:flex; align-items:center; gap:2px; color:var(--sc-muted, #888); font-size:11px; }
.ipc-layer .ipc-maskrow .ipc-sel { flex:0 1 auto; min-width:0; max-width:96px; }
.ipc-layer .ipc-maskrow .ipc-grow { flex:1; }
.ipc-mini.ipc-on { background:var(--sc-selected, #2b3a4f); color:var(--sc-active, #7cc7ff); }
.ipc-list.ipc-dropping { outline:2px dashed var(--sc-active, #7cc7ff); outline-offset:-2px; }
.ipc-view.ipc-dropping { outline:2px dashed #7cc7ff; outline-offset:-3px; }
.ipc-mini { display:inline-flex; align-items:center; justify-content:center; width:26px; height:24px; border-radius:var(--sc-radius, 4px);
  cursor:pointer; color:var(--sc-fg-2, #bbb); background:transparent; border:none; padding:0; flex:none; }
.ipc-mini:hover { background:var(--sc-btn-hover, #3a3a3a); color:var(--sc-fg-strong, #fff); }
.ipc-mini.ipc-off { color:var(--sc-faint, #555); }
.ipc-mini.ipc-del:hover { color:var(--sc-error, #f66); }
.ipc-mini:disabled { opacity:.25; cursor:default; }
.ipc-layer .ipc-op { display:flex; align-items:center; gap:6px; color:var(--sc-muted, #888); font-size:11px; }
.ipc-layer .ipc-op input[type=range] { flex:1; margin:0; }
.ipc-layer .ipc-op b { width:34px; text-align:right; font-weight:500; color:var(--sc-fg-2, #bbb); }
.ipc-layer .ipc-op label { display:flex; align-items:center; gap:4px; }
.ipc-layer .ipc-op .ipc-sel { flex:0 1 auto; min-width:0; }
.ipc-layer .ipc-op .ipc-sel.ipc-narrow { max-width:96px; }
.ipc-layer .ipc-op input[type=range] { min-width:40px; }
.ipc-prompt { padding:8px; }
.ipc-prompt textarea { width:100%; box-sizing:border-box; min-height:80px; resize:vertical; background:var(--sc-field, #161616); color:var(--sc-fg, #ddd); border:1px solid var(--sc-line, #3a3a3a);
  border-radius:var(--sc-radius, 6px); padding:6px 8px; font:13px/1.35 var(--sc-font, system-ui, sans-serif); }
.ipc-prompt textarea:focus { outline:none; border-color:var(--sc-active, #4a90d9); }
.ipc-pf { position:relative; display:block; width:100%; box-sizing:border-box; min-height:80px; resize:vertical; overflow:auto; background:var(--sc-field, #161616); color:var(--sc-fg, #ddd);
  border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius, 6px); padding:6px 8px; font:13px/22px var(--sc-font, system-ui, sans-serif);
  white-space:pre-wrap; overflow-wrap:anywhere; cursor:text; outline:none; margin-bottom:6px; }
.ipc-pf:focus { border-color:var(--sc-active, #4a90d9); }
.ipc-pf.ipc-pf-empty::before { content:attr(data-placeholder); position:absolute; left:9px; top:6px; right:9px; color:var(--sc-faint, #777); pointer-events:none; white-space:normal; }
.ipc-pf[aria-disabled=true] { opacity:.6; cursor:default; }
.ipc-chip { display:inline-block; height:20px; box-sizing:border-box; margin:1px 1px 0; padding:0 1px 0 1px; vertical-align:top;
  border:1px solid var(--sc-line, #3a3a3a); border-radius:10px; background:var(--sc-btn, #2a2a2a); color:var(--sc-fg, #ddd); font-size:12px; line-height:18px; white-space:nowrap; cursor:default; }
.ipc-chip:hover { background:var(--sc-btn-hover, #333); }
.ipc-chip > * { display:inline-block; vertical-align:top; }
.ipc-chip > .ipc-chip-at { width:0; overflow:hidden; }
.ipc-chip > .ipc-chip-av { width:16px; height:16px; margin:1px 3px 0 0; border-radius:50%; object-fit:cover; background:var(--sc-well, #111); }
.ipc-chip > .ipc-chip-av[hidden] { display:none; }
.ipc-chip > .ipc-chip-label { max-width:14ch; overflow:hidden; text-overflow:ellipsis; padding-left:2px; }
.ipc-chip > .ipc-chip-chev { position:relative; width:14px; height:18px; padding:0; margin:0; border:0; background:transparent; color:var(--sc-fg-2, #bbb); cursor:pointer; }
.ipc-chip-chev::after { content:""; position:absolute; left:3px; top:6px; border:4px solid transparent; border-top-color:currentColor; }
.ipc-chip[data-state=inactive] { opacity:.7; }
.ipc-chip[data-state=inactive] .ipc-chip-label, .ipc-chip[data-state=broken] .ipc-chip-label { text-decoration:line-through; }
.ipc-chip[data-state=broken] { color:var(--sc-error, #f66); }
.ipc-chip[data-state=over] { border-color:var(--sc-warn, #ffb347); }
.ipc-chip[data-state=none] { opacity:.7; }
.ipc-chip[data-state=none] .ipc-chip-label { text-decoration:line-through; }
.ipc-chip.ipc-in-sel { outline:2px solid var(--sc-active, #4a90d9); outline-offset:-1px; }
.ipc-chip.ipc-open > .ipc-chip-chev { color:var(--sc-active, #4a90d9); }
.ipc-pf.ipc-pf-dragging, .ipc-pf.ipc-pf-dragging .ipc-chip { cursor:grabbing; }
.ipc-pf-dropcaret { position:absolute; z-index:8; width:2px; background:var(--sc-active, #4a90d9); pointer-events:none; }
.ipc-refbar { display:flex; align-items:center; gap:4px; margin-bottom:6px; min-height:22px; }
.ipc-refbar-chips { display:flex; flex-wrap:wrap; gap:4px; min-width:0; flex:0 1 auto; }
.ipc-refbar-chip { display:inline-flex; align-items:center; gap:3px; height:22px; box-sizing:border-box; max-width:120px; padding:0 7px 0 2px; margin:0;
  border:1px solid var(--sc-line, #3a3a3a); border-radius:11px; background:var(--sc-btn, #2a2a2a); color:var(--sc-fg, #ddd); font:12px/20px var(--sc-font, system-ui, sans-serif); cursor:pointer; white-space:nowrap; }
.ipc-refbar-chip:hover { background:var(--sc-btn-hover, #333); }
.ipc-refbar-chip .ipc-chip-av { flex:none; width:16px; height:16px; border-radius:50%; object-fit:cover; background:var(--sc-well, #111); }
.ipc-refbar-chip .ipc-chip-av[hidden] { display:none; }
.ipc-refbar-chip .ipc-chip-label { overflow:hidden; text-overflow:ellipsis; }
.ipc-refbar-chip[data-state=hidden] { opacity:.5; cursor:default; }
.ipc-refbar-chip[data-state=over] { border-color:var(--sc-warn, #ffb347); }
.ipc-refbar-chip[data-state=none] { opacity:.7; }
.ipc-refbar-eye { flex:none; width:12px; height:12px; color:var(--sc-muted, #999); }
.ipc-refbar-add { flex:none; width:22px; height:22px; padding:0; margin:0; border:1px dashed var(--sc-line, #3a3a3a); border-radius:11px; background:transparent;
  color:var(--sc-fg-2, #bbb); font:14px/20px var(--sc-font, system-ui, sans-serif); cursor:pointer; }
.ipc-refbar-add:hover:not(:disabled) { background:var(--sc-btn-hover, #333); color:var(--sc-fg, #ddd); }
.ipc-refbar-add:disabled { opacity:.45; cursor:default; }
.ipc-refbar-count { margin-left:auto; padding-left:6px; flex:none; font-size:10px; color:var(--sc-muted, #999); white-space:nowrap; }
.ipc-refbar-count.ipc-refbar-over { color:var(--sc-warn, #ffb347); }
.ipc-refpop { position:absolute; z-index:8; width:280px; max-height:320px; box-sizing:border-box; display:flex; flex-direction:column; gap:4px; padding:6px;
  background:var(--sc-raised, #262626); border:1px solid var(--sc-border, #444); border-radius:var(--sc-radius-lg, 8px); box-shadow:var(--sc-shadow, 0 8px 24px rgba(0,0,0,.55));
  color:var(--sc-fg, #ddd); font-size:12px; }
.ipc-refpop [hidden] { display:none !important; }
.ipc-refpop .ipc-rp-head { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--sc-muted, #999); padding:2px 4px 0; }
.ipc-refpop .ipc-rp-head.ipc-rp-query { text-transform:none; letter-spacing:0; font-size:11px; color:var(--sc-fg-2, #bbb); }
.ipc-refpop .ipc-rp-list { display:flex; flex-direction:column; gap:1px; overflow:auto; min-height:0; }
.ipc-refpop .ipc-rp-row { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box; padding:3px 6px; margin:0; border:0; border-radius:var(--sc-radius, 4px);
  background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.ipc-refpop .ipc-rp-row.ipc-rp-cur { background:var(--sc-btn-hover, #3a3a3a); }
.ipc-refpop .ipc-rp-row:disabled { opacity:.45; cursor:default; }
.ipc-refpop .ipc-rp-av { flex:none; width:24px; height:24px; border-radius:50%; object-fit:cover; background:var(--sc-well, #111); }
.ipc-refpop .ipc-rp-label { flex:none; color:var(--sc-link, #7cc7ff); }
.ipc-refpop .ipc-rp-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-refpop .ipc-rp-sent { flex:none; font-size:10px; color:var(--sc-muted, #999); }
.ipc-refpop .ipc-rp-over { flex:none; font-size:10px; color:var(--sc-warn, #ffb347); }
.ipc-refpop .ipc-rp-plus { flex:none; width:24px; text-align:center; color:var(--sc-fg-2, #bbb); }
.ipc-refpop .ipc-rp-empty, .ipc-refpop .ipc-rp-note { color:var(--sc-faint, #777); padding:2px 6px; font-size:11px; }
.ipc-refpop .ipc-rp-foot { font-size:10px; color:var(--sc-faint, #777); padding:2px 4px 0; border-top:1px solid var(--sc-line, #3a3a3a); }
.ipc-refcard { position:absolute; z-index:9; box-sizing:border-box; max-width:192px; padding:8px; display:flex; flex-direction:column; gap:4px; pointer-events:auto;
  background:var(--sc-raised, #262626); border:1px solid var(--sc-border, #444); border-radius:var(--sc-radius-lg, 8px); box-shadow:var(--sc-shadow, 0 8px 24px rgba(0,0,0,.55));
  color:var(--sc-fg, #ddd); font-size:12px; }
.ipc-refcard .ipc-refcard-pic { display:block; background:var(--sc-well, #111); border-radius:var(--sc-radius-sm, 3px); }
.ipc-refcard .ipc-refcard-name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ipc-refcard .ipc-refcard-line { font-size:11px; color:var(--sc-fg-2, #bbb); overflow-wrap:anywhere; }
.ipc-refcard[data-state=broken] .ipc-refcard-line { color:var(--sc-error, #f66); }
.ipc-refcard[data-state=over] .ipc-refcard-line { color:var(--sc-warn, #ffb347); }
.ipc-hist { max-height:30vh; overflow:auto; }
.ipc-hitem { display:flex; align-items:center; gap:8px; padding:5px 8px; border-bottom:1px solid var(--sc-line, #161616); }
.ipc-hitem.ipc-gone { opacity:.55; }
.ipc-hitem canvas { width:56px; height:56px; object-fit:contain; background:var(--sc-well, #111); border-radius:var(--sc-radius-sm, 4px); flex:none; cursor:pointer; }
.ipc-hitem .ipc-htext { flex:1; min-width:0; font-size:11px; color:var(--sc-fg-2, #aaa); }
.ipc-hitem .ipc-htext b { display:block; color:var(--sc-fg, #ddd); font-weight:500; }
.ipc-hitem .ipc-htext span { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ipc-undo-list { position:relative; max-height:30vh; overflow:auto; }
.ipc-undo-row { padding:3px 10px; font-size:12px; color:var(--sc-fg-2, #bbb); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; border-bottom:1px solid var(--sc-line, #1c1c1c); }
.ipc-undo-row:hover { background:var(--sc-raised, #262b33); color:var(--sc-fg, #ddd); }
.ipc-undo-row.ipc-undo-current { background:var(--sc-selected, #2b3a4f); box-shadow:inset 3px 0 0 var(--sc-active, #4a90d9); color:var(--sc-fg-strong, #fff); cursor:default; }
.ipc-undo-row.ipc-undo-future { color:var(--sc-faint, #777); font-style:italic; }
.ipc-undo-bar { padding-top:6px; padding-bottom:4px; }
.ipc-snap-row { display:flex; align-items:center; gap:4px; padding:2px 8px 2px 10px; font-size:12px; color:var(--sc-fg, #ddd); }
.ipc-snap-row .ipc-snap-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ipc-mask-off { color:var(--sc-faint, #777); text-decoration:line-through; cursor:pointer; }
.ipc-info { padding:8px 10px; color:var(--sc-fg-2, #aaa); display:grid; grid-template-columns:auto 1fr; gap:3px 10px; }
.ipc-upsample { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ipc-gen { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
.ipc-gen label { display:flex; align-items:center; gap:6px; }
.ipc-boxes { padding-top:0; }
.ipc-boxes label { display:flex; align-items:center; gap:6px; }
.ipc-boxes .ipc-hint { color:var(--sc-muted, #888); }
.ipc-bx-help, .ipc-bx-note, .ipc-bx-empty { font-size:11px; color:var(--sc-muted, #888); margin:2px 0 4px; }
.ipc-bx-list { display:flex; flex-direction:column; gap:6px; width:100%; }
.ipc-bx-row { display:flex; flex-direction:column; gap:3px; padding:5px 6px; border:1px solid var(--sc-line, #3a3a3a); border-left-width:3px; border-radius:4px; background:var(--sc-well, #161616); }
.ipc-bx-row.ipc-bx-sel { border-color:var(--sc-accent, #ffd166); box-shadow:0 0 0 1px var(--sc-accent, #ffd166); }
.ipc-bx-head { display:flex; gap:4px; align-items:center; }
.ipc-bx-head .ipc-bx-id { flex:1; min-width:0; }
.ipc-bx-head .ipc-bx-select { max-width:120px; }
.ipc-bx-field { background:var(--sc-field, #161616); color:var(--sc-fg, #ccc); border:1px solid var(--sc-line, #3a3a3a); border-radius:4px; padding:2px 5px; font:11px system-ui, sans-serif; width:100%; box-sizing:border-box; min-width:0; }
.ipc-bx-field:focus { outline:none; border-color:var(--sc-accent, #ffd166); }
.ipc-bx-geo { display:grid; grid-template-columns:40px 1fr; gap:4px; align-items:center; font-size:11px; }
.ipc-bx-label { color:var(--sc-muted, #888); }
.ipc-bx-buttons { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0; }
.ipc-bx-warn { display:flex; flex-direction:column; gap:4px; }
.ipc-bx-warn:empty { display:none; }
.ipc-bx-warn-row { display:flex; flex-wrap:wrap; gap:4px 6px; align-items:center; font-size:11px; color:var(--sc-warn, #f0c674); }
.ipc-gen input[type=range] { width:120px; margin:0; }
.ipc-gen b { min-width:32px; font-weight:500; color:var(--sc-fg-2, #ccc); }
.ipc-settings { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; align-items:center; }
.ipc-settings label { display:contents; }
.ipc-settings .ipc-sel, .ipc-settings input[type=text] { min-width:0; width:100%; }
.ipc-mode { margin-right:6px; }
.ipc-cropset { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; align-items:center; }
.ipc-cropset label { display:contents; }
.ipc-info b { color:var(--sc-fg, #ddd); font-weight:500; }
.ipc-bottom { padding:5px 10px; background:var(--sc-chrome, #242424); border-top:1px solid var(--sc-chrome-edge, #0d0d0d); color:var(--sc-muted, #999); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; }
.ipc-kbd { color:var(--sc-faint, #777); margin-left:auto; min-width:0; overflow:hidden; text-overflow:ellipsis; flex-shrink:1000; }
.ipc-statusline.ipc-status-error, .ipc-node .ipc-status.ipc-status-error { color:var(--sc-error, #e0533d); }
.ipc-status-blink { animation:ipc-status-blink .6s ease-in-out 5; }
.ipc-statusline { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ipc-run { display:flex; align-items:center; gap:6px; flex:none; margin-left:12px; color:var(--sc-muted, #999); }
.ipc-run-track { position:relative; width:96px; height:4px; border-radius:2px; overflow:hidden; background:var(--sc-line, #333); }
.ipc-run-fill { position:absolute; left:0; top:0; bottom:0; width:0; border-radius:2px; background:var(--sc-active, #4a90d9); transition:width .25s linear; }
.ipc-run-busy .ipc-run-fill { width:30%; animation:ipc-run-busy 1.4s ease-in-out infinite; }
@keyframes ipc-run-busy { 0% { left:-30%; } 100% { left:100%; } }
@keyframes ipc-status-blink { 50% { opacity:.2; } }
@media (prefers-reduced-motion: reduce) { .ipc-status-blink { animation:none; } .ipc-run-fill { transition:none; } .ipc-run-busy .ipc-run-fill { animation:none; left:0; width:100%; opacity:.45; } }
.ipc-view.ipc-scale-x { cursor:ew-resize; }
.ipc-view.ipc-scale-y { cursor:ns-resize; }
.ipc-view.ipc-rotate { cursor:alias; }
.ipc-subbar { position:absolute; top:8px; left:8px; z-index:2; display:flex; align-items:center; gap:6px; padding:5px 8px;
  background:var(--sc-surface, rgba(30,30,30,.92)); border:1px solid var(--sc-border, #3a3a3a); border-radius:var(--sc-radius-lg, 8px); color:var(--sc-fg-2, #ccc); font-size:12px; }
.ipc-subbar .ipc-ib { padding:3px 8px; min-width:0; font-size:12px; }
.ipc-subbar .ipc-sep { width:1px; height:18px; background:var(--sc-line, #444); margin:0 2px; }
.ipc-subbar label { display:flex; align-items:center; gap:4px; color:var(--sc-fg-2, #aaa); }
.ipc-subbar input[type=range] { width:90px; }
.ipc-subbar input[type=color] { width:30px; height:22px; padding:0; border:1px solid var(--sc-border, #4a4a4a); border-radius:var(--sc-radius, 5px); background:var(--sc-btn, #333); cursor:pointer; }
.ipc-subbar .ipc-geo { display:flex; align-items:center; gap:4px; }
.ipc-textedit { position:absolute; z-index:3; background:transparent; color:transparent; caret-color:#fff; border:1px dashed #7cc7ff; outline:none; resize:none; margin:0; overflow:hidden; white-space:pre; box-sizing:border-box; }
.ipc-subbar .ipc-geo label { gap:2px; }
.ipc-subbar .ipc-geo .ipc-num { width:58px; }
.ipc-subbar .ipc-hint { color:var(--sc-muted, #888); }
.ipc-rangebar-wrap { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ipc-rangebar-head { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--sc-fg-2, #aaa); }
.ipc-rangebar-title { font-weight:500; color:var(--sc-fg, #ddd); }
.ipc-rangebar-head .ipc-grow { flex:1; }
.ipc-rangebar-btn { display:inline-flex; align-items:center; justify-content:center; padding:1px 6px; font:11px var(--sc-font, system-ui, sans-serif);
  border-radius:var(--sc-radius, 4px); border:1px solid var(--sc-line, #3a3a3a); background:var(--sc-field, #161616); color:var(--sc-fg-2, #aaa); cursor:pointer; }
.ipc-rangebar-btn:hover { background:var(--sc-btn-hover, #333); color:var(--sc-fg, #ddd); }
.ipc-rangebar-btn.ipc-active { background:var(--sc-selected, #2b3a4f); color:var(--sc-active, #7cc7ff); border-color:var(--sc-active, #4a90d9); }
.ipc-rangebar-container { width:100%; flex-basis:100%; min-width:0; }
.ipc-rangebar-canvas { width:100%; height:38px; border:1px solid var(--sc-line, #3a3a3a); border-radius:var(--sc-radius-sm, 3px);
  background:var(--sc-well, #161616); display:block; cursor:crosshair; touch-action:none; box-sizing:border-box; }
.ipc-limit-block { grid-column:1 / -1; display:flex; flex-direction:column; gap:4px; margin-top:4px; padding-top:4px; border-top:1px solid var(--sc-line, #333); }
.ipc-limit-head { display:flex; align-items:center; gap:6px; font-size:11px; }
.ipc-limit-label { font-weight:500; color:var(--sc-fg-2, #aaa); min-width:32px; }
.ipc-limit-sel { flex:1; max-width:none; }
.ipc-limit-color-row { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--sc-fg-2, #aaa); }
.ipc-limit-color-row label { display:flex; align-items:center; gap:4px; }
.ipc-limit-note { font-size:11px; color:var(--sc-warn, #e5a040); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ipc-limit-bar-wrap { width:100%; min-width:0; }
.ipc-depth-edges-row { display:flex; align-items:center; gap:6px; margin-top:4px; font-size:11px; }
.ipc-depth-edges-label { display:flex; align-items:center; gap:6px; width:100%; font-size:11px; color:var(--sc-fg-2, #aaa); cursor:pointer; }
.ipc-depth-edges-slider { flex:1; height:4px; accent-color:var(--sc-active, #7cc7ff); cursor:pointer; }
.ipc-depth-edges-val { font-variant-numeric:tabular-nums; min-width:24px; text-align:right; color:var(--sc-fg, #ddd); }
.ipc-relight-block { grid-column:1 / -1; display:flex; flex-direction:column; gap:6px; margin-top:4px; padding-top:4px; border-top:1px solid var(--sc-line, #333); }
.ipc-relight-head { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:11px; }
.ipc-relight-title { font-weight:600; color:var(--sc-fg-2, #aaa); }
.ipc-relight-note { font-size:11px; color:var(--sc-warn, #e5a040); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ipc-relight-list { display:flex; flex-direction:column; gap:3px; }
.ipc-relight-row { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:var(--sc-radius, 3px); background:var(--sc-well, #161616); border:1px solid transparent; cursor:pointer; }
.ipc-relight-row:hover { background:var(--sc-raised, #262626); }
.ipc-relight-row.ipc-selected { background:var(--sc-selected, #2b3a4f); border-color:var(--sc-active, #4a90d9); }
.ipc-relight-row.ipc-light-off { opacity:0.5; }
.ipc-relight-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; border:1px solid var(--sc-border, #444); }
.ipc-relight-num { font-size:11px; font-weight:600; min-width:12px; color:var(--sc-fg-strong, #eee); }
.ipc-relight-type-sel { flex:1; min-width:0; height:20px; font-size:11px; padding:0 4px; }
.ipc-relight-controls { display:grid; grid-template-columns:auto 1fr auto; gap:4px 6px; align-items:center; margin-top:4px; padding:6px; border-radius:var(--sc-radius, 3px); background:var(--sc-well, #161616); font-size:11px; }
.ipc-relight-color-row { grid-column:1 / -1; display:flex; align-items:center; gap:6px; font-size:11px; }
.ipc-relight-kelvin-sel { flex:1; min-width:0; height:22px; font-size:11px; }
.ipc-relight-preset-sel { max-width:110px; height:20px; font-size:11px; padding:0 4px; }
.ipc-relight-gobo-row { grid-column:1 / -1; display:flex; align-items:center; gap:6px; font-size:11px; }
.ipc-relight-gobo-sel { flex:1; min-width:0; height:20px; font-size:11px; padding:0 4px; }
`;

function injectStyle() {
    if (document.getElementById("ipc-style")) return;
    const s = document.createElement("style");
    s.id = "ipc-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
}

export { STYLE, injectStyle };
