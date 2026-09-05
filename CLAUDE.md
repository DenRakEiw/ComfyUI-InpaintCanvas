# CLAUDE.md — ComfyUI-InpaintCanvas

Read this first. `DEVELOPMENT.md` has the long version (mechanisms, gotchas,
test recipes, roadmap). `README.md` is the user-facing manual.

## What this is

A Krita-style inpainting node for ComfyUI, built for and with DenRakEiw
(GitHub: DenRakEiw, repo https://github.com/DenRakEiw/ComfyUI-InpaintCanvas).
One node holds image, layers, selection and prompt; the selected region goes
out as a crop, any inpaint chain works on it, and the result is wired **back
into the same node** and lands as a new layer. The user's real chain is the
Flux.2 [max] API node (returns RGBA, square unless width/height are wired).

## Layout

- `nodes.py` — `InpaintCanvas` (OUTPUT_NODE, always re-executes),
  `InpaintCanvasStitch` (OUTPUT_NODE, also used ephemerally), and the helpers
  `InpaintCanvasLoadRef` (ref JSON -> IMAGE), `InpaintCanvasMaskOut`
  (MASK -> temp PNG + `ui.inpaint_mask`; purpose `segments` encodes a batch as
  a label map), `InpaintCanvasObjectMap` (SAM2 automask -> label map for the
  hover object tool) and `InpaintCanvasTextOut` (STRING -> `ui.inpaint_text`,
  prompt upsampling).
- `js/inpaint_canvas.js` — the whole frontend: node thumbnail widget, the
  full-window editor (`InpaintEditor`), state persistence, prompt rewriting.
- `pyproject.toml` + `.github/workflows/publish_action.yml` — Comfy Registry
  (`PublisherId = "denrakeiw"`, secret `REGISTRY_ACCESS_TOKEN` is the user's).
- Local install path: `ComfyUI/custom_nodes/ComfyUI-InpaintCanvas`.
  An empty locked `custom_nodes/inpaint` shell may still exist; delete it.

## Invariants — do not break these

1. **The back-link is never sent to the backend.** `api.queuePrompt` wrapper
   turns `inputs.result` (a link) into `inputs.result_source = "id:slot"`.
   ComfyUI's `validate_inputs` rejects real cycles.
2. **The canvas node always re-executes** (`IS_CHANGED` returns NaN). A cached
   node cannot expand the ephemeral stitch, and `IS_CHANGED` is called with an
   empty `prompt`, so it cannot hash the state anyway.
3. **The stitch result reaches the frontend through `display_node`.** The
   ephemeral node's UI output is attributed to the canvas node; the frontend
   handles it in `onExecuted`. UI key is `inpaint_result`, never `images`
   (that would trigger ComfyUI's built-in image preview).
4. **`canvas_state` is a DOM widget, not a declared input.** Its
   `serializeValue` uploads flattened image, mask and control PNGs and returns
   a small JSON; the backend reads it from the hidden `PROMPT`. Undeclared
   prompt inputs are ignored by validation. Keep it that way.
5. **Adding a widget shifts `widgets_values` of saved workflows.** The
   `onConfigure` migration finds the JSON and puts it back. Keep it working
   when you add widgets; prefer adding new state to the JSON instead.
6. **`getValue` must never return `{}` while a restore is loading**
   (autosave would wipe the canvas). It returns `lastValueString`.
7. Layer pixels are never stored in the workflow. Dirty layers are uploaded on
   editor close and before every run (`syncLayers`).
8. **Editor features that need a model run use helper prompts**, never the
   user's graph: the frontend queues a tiny prompt (`api.queuePrompt(-1, ...)`,
   front of the queue) made of loader/model nodes plus `InpaintCanvasMaskOut`,
   and picks the result up from the `executed` event by `canvas_node`. The
   user runs paid API nodes; a helper must never trigger the main chain.

## User preferences (stated explicitly)

- Push and commit as **DenRakEiw**, not as Claude, no Claude trailer in commit
  messages. Use `git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`
  and push with `-c credential.helper='!gh auth git-credential'`.
- One node, one window. No helper nodes for the round trip, no in-node canvas.
- Icons, not text, for tools. Krita/Photoshop vocabulary. Answer in German.
- The user asks for features by Krita name; the roadmap is in DEVELOPMENT.md.

## Where things stand (2026-09-05)

Done and verified: everything in README, including "Select by text" (SAM3 via
comfyui-rmbg as default), the object selection tool (hover/click, SAM2 object
map), the Source switch (image / active layer), the Crop settings (auto
context, auto feather, fill modes, color match; DEVELOPMENT.md 10), prompt
upsampling (Qwen3-VL local / Gemini API, DEVELOPMENT.md 11) and the
window-capture key handling (Ctrl+Z never reaches ComfyUI's workflow undo).
SAM3 weights are at `models/checkpoints/sam3.pt` with a hardlink at
`models/sam3/sam3.pt`. The core SAM3 text path returns noise here (6b).

## Working on it

- Python changes need a ComfyUI restart; JS changes only need a page reload.
  (ComfyUI-HotReloadHack is installed and does reload `nodes.py` on save, the
  log says "Reloaded module ComfyUI-InpaintCanvas", but do not rely on it for
  new node classes or changed INPUT_TYPES; restart to be sure.)
  Restart only when `GET /queue` shows nothing running or pending (the user
  runs paid API workflows), then `Start-Process run_nvidia_gpu.bat`.
- Check syntax with `python -m py_compile nodes.py` and `node --check js/inpaint_canvas.js`.
- Browser testing: see DEVELOPMENT.md "Testing". Beware the workflow restore
  that happens 2–4 minutes after page load and replaces any scripted graph.
