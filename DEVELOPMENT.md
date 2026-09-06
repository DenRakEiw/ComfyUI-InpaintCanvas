# Development notes

Everything that is not obvious from the code. Written so a fresh session can
continue without the chat history. Dates are 2026-09-04 unless stated.

## 1. Origin and decisions

- The user inpaints in Krita with the krita-ai-diffusion plugin and wanted the
  same loop inside ComfyUI. Existing packs (Comfyui-LayerForge, Comfy-Canvas)
  were judged "right direction, different idea".
- First version had the editor inside the node as a DOM widget. The user found
  it clunky and asked for a separate window plus icons. The editor is now a
  full-window overlay (`.ipc-modal`, `position: fixed`, z-index 10000) opened
  from a thumbnail widget in the node.
- The user rejected a two-node round trip ("Send to Canvas" helper node) and
  asked to "trick ComfyUI into allowing cycles". The sanctioned way is below.

## 2. How the round trip works (backend)

ComfyUI facts verified in `execution.py` / `comfy_execution/graph.py` (v0.33.2):

- `validate_inputs` walks links from output nodes with a `visiting` list and
  reports `dependency_cycle`. A real back-link would fail validation.
- A node may return `{"result": ..., "expand": graph}`. Nodes in `graph` are
  added with `dynprompt.add_ephemeral_node(id, info, parent_id, display_id)`;
  `display_id` defaults to the parent. Ephemeral OUTPUT nodes are added to the
  execution list and pull their upstream chain in, including nodes that were
  not ancestors of any output. Their inputs may link to original prompt node
  ids (`["12", 0]`).
- Non-link entries in the expanded result are used as the parent's outputs
  (`pending_subgraph_results` resolution keeps plain tensors).
- `executed` websocket messages carry `display_node`; the frontend looks the
  node up by it and calls `node.onExecuted(output)`.
- `IsChangedCache.get` calls `get_input_data` **without** dynprompt, so hidden
  `PROMPT` is `{}` inside `IS_CHANGED`. That is why `IS_CHANGED` returns NaN
  unconditionally. Consequence: everything downstream re-runs on each queue,
  which is what an inpaint loop wants anyway.
- `get_input_data` passes only declared inputs to the function; extra keys in
  the prompt (`canvas_state`, `result_source`) are ignored by validation and
  read via the hidden `PROMPT` dict instead.
- Output node: `InpaintCanvas.OUTPUT_NODE = True`, so a workflow with only
  canvas → chain → back works without Save/Preview Image.
- `GraphBuilder` prefixes ids (`"1.0.0.1"` was the stitch id in tests).

Stitch (`InpaintCanvasStitch.stitch`): takes `result[0:1, :, :, :3]` (API nodes
return RGBA), lanczos-resizes with `crop="center"` to the bbox (keeps aspect,
crops instead of distorting), blurs the full selection mask by `feather`,
composites, saves the patch as RGBA PNG to `output/inpaint_canvas/` and returns
`ui.inpaint_result = [{filename, subfolder, type, x, y, width, height, canvas_node}]`
plus the stitched full image as its IMAGE output.

Crop (`InpaintCanvas.run`): bbox = selection bounds + `padding`, clamped. With
`target_size > 0` the crop is scaled so the long side is `target_size`, both
sides rounded to `multiple_of`. With `target_size == 0` the bbox itself is grown
symmetrically to a multiple (`_fit_span_to_multiple`). `control_image` is the
control PNG cropped/scaled identically (zeros if none). Outputs in order:
`crop_image, crop_mask, image, mask, stitch_info, crop_width, crop_height, prompt, control_image, denoise, seed, mode, negative, setting_1..setting_8`.
Only ever append outputs; reordering breaks saved workflows (section 12 for
how outputs after the setting slots are shown and remapped).

Setting outputs (2026-09-05): eight wildcard (`"*"`) outputs after `negative`
(`FIXED_OUTPUTS` = 13 in the JS must equal the number of outputs before
them). The backend always returns all eight (`_cast_setting` types the stored
value by the target widget: INT, FLOAT, BOOLEAN, else as is; unconnected ones
are None). The frontend keeps only the connected ones plus one free slot
(`syncSettingOutputs`: trailing outputs are removed/added, so slot indices of
connected ones never move; the label says "(free)"). `onConnectionsChange` for
an output slot >= 13 resyncs and calls `editor.settingsChanged()`, which reads
the link targets (`settingTargets`: target node, input name, its spec from
`nodeData.input`, its widget), stores `{value, type, label, target}` in
`canvas_state.settings[n]` seeded from the widget's current value, and
renders a control per entry (`renderSettings`: combo -> select with the
option list, INT/FLOAT -> number with min/max/step, BOOLEAN -> checkbox, else
text). Editing pushes the value into the target widget too. Wildcard outputs
pass backend validation (`validate_node_input` returns True for "*") and the
frontend connects "*" to any input, including combo widgets. Verified in the
browser with `LoraLoader.lora_name` (1178 options) and `KSampler.steps`, via
the API with INT/FLOAT/COMBO targets on ImageBlur and ImageScaleBy.

Refine (`gen.refine`, local only): crop_mask is the plain selection (grow 0,
feather 0), fill forced to none, the composite keeps the blend so the seam
stays soft. Strength scaling: `_auto_selection_params(..., strength)` with
strength = denoise in local mode multiplies the feather (and its 32 px
minimum) like Krita's `feather_rel * strength`. `negative` output =
`canvas_state.negative`.

Two result inputs (2026-09-05): `result` (API chain) and `result_local`
(local chain), both lazy and both removed from the prompt by the queuePrompt
wrapper (`result_source`, `result_source_local`). `run()` picks the source
by `canvas_state.gen.mode` and expands the stitch only for that one, so the
other chain is never executed (its nodes are not ancestors of anything once
the back-link is gone). When the mode's input is not wired, the other one is
used (2026-09-05 late: the user switched to local for the denoise slider
while the Flux.2 chain sat on `result`, and three runs came back without a
layer; the editor now shows "(only input wired)" in the Crop info). `gen = {mode, denoise, seed, seedRandom}` lives in
the state; the frontend rolls a new seed before every Generate when
`seedRandom` is on and stores mode/seed/denoise in each history entry.

## 3. Frontend facts (comfyui-frontend-package 1.49.6)

- `node.addDOMWidget(name, type, element, {getValue, setValue, getMinHeight})`;
  `widget.value` is backed by those callbacks; `widget.serializeValue` (async)
  is awaited by `graphToPrompt` and its return value goes into
  `inputs[widget.name]` — for **every** named widget, declared or not.
- `graphToPrompt` skips widgets with `options.serialize === false`.
- `api.queuePrompt(number, {output, workflow})` — the wrapper edits
  `prompt.output[id].inputs`.
- `configure()` assigns `widgets_values` by index, then calls `onConfigure`.
  Hence the migration in `onConfigure`.
- The frontend auto-restores the last workflow from local storage **2–4
  minutes after page load** with this many custom nodes (`.p-blockui-mask`
  stays until then). Any graph built by script before that gets replaced.
- Some third-party extension wraps `api.queuePrompt` and throws
  `ReferenceError: app is not defined` (or "reading 'output'") on the **first**
  call after load. `generate()` retries once after 300 ms.
- ComfyUI's own Escape handler (closes side panels such as the Job Queue) runs
  before ours; the editor's Escape listener is on `window` in capture phase.
- Executed-event routing for a standalone stitch node uses
  `output.inpaint_result[i].canvas_node` to find the canvas.
- `window.comfyAPI.app.app` is the app object in the browser console;
  `window.app` is not set.

## 4. State model

`canvas_state` widget value (persisted in the workflow, JSON string):

```
{ width, height,
  base: {filename, subfolder, type},          // input/inpaint_canvas/...
  prompt: "...",
  layers: [{ id, name, kind: "result"|"paint"|"image"|"filter", role: "none"|"reference"|"scribble"|...,
             blend: "normal"|"multiply"|..., ref, x, y, w, h, opacity, visible,
             mask: {filename, subfolder, type} | null,      // transparency mask PNG (alpha = visible)
             filter, params, lut: {name, size, ref} }],     // kind "filter" only (ref = null there)
  history: [{ key, name, ref, x, y, w, h, prompt, layerId, time, seed, mode, denoise }],
  selection: "data:image/png;base64,...",     // red where selected
  seen: ["subfolder/filename", ...],           // results already added
  negative: "...",
  crop: { context: "auto"|"manual", feather: "auto"|"manual",
          fill: "none"|"neutral"|"blur"|"border"|"green", colorMatch, extendFill },
  upsample: { useCase, backend },
  gen: { mode: "api"|"local", denoise, seed, seedRandom, refine },
  settings: { "1": { value, type, label, target }, ... },   // setting_n outputs
  refs: { fit: "pad"|"crop"|"stretch" },                     // how references are fitted to the crop size
  cutout: { backend: "auto"|"rmbg2"|"birefnet"|"ben2"|"bria14" } }
```

Prompt-time JSON (what the backend sees, from `serializeForPrompt`):
`{ width, height, base, mask, control, prompt, negative, layers, crop, gen, settings, references, refs }` where `base` is the
flattened visible non-control, non-reference layers (or the original ref when
no layer is visible), `mask` the selection as grayscale PNG, `control` the
control layers on black (or null), `references` the list of file refs of the
visible reference layers (top of the list first). Files are named `n{nodeId}_{base|mask|control|layer}_{sha1[:12]}.png`
and uploaded with `overwrite=true`; unchanged content is not re-uploaded
(`this.uploaded.*Hash`).

In memory each layer has `canvas` (HTMLCanvasElement, its own pixel size) drawn
at `(x, y, w, h)`; result layers are patch-sized, paint layers are canvas-sized.
Painting maps image coords into layer pixels (`sx = canvas.width / w`).

## 5. Editor internals worth knowing

- Tools: `select`, `rect`, `lasso`, `deselect` (selection); `paint`, `erase`,
  `transform`, `hand` (layers). Selection is a canvas with red pixels; the
  mask export reads alpha.
- `closeStrokeLoop(path, subtract)` = Photoshop Selection Brush loop closing
  (2026-09-05, replaced the border flood fill): the stroke's path points are
  recorded, and when the last point is within `max(brushSize, 24 / scale)` of
  the first, the path is closed with a straight line and filled with nonzero
  winding (subtract brush: destination-out). Tiny scribbles (bbox < 1.5 brush
  sizes) are ignored. Adobe's own description: "close a freehand stroke into
  a lasso shape by connecting back to your starting point, and Photoshop fills
  the area automatically". The old flood fill needed a pixel-tight ring and
  never filled loops that touched the image border.
- `growSelection(n)` uses an exact Euclidean distance transform
  (Felzenszwalb, `distanceTransform`); negative n shrinks.
- Layer strokes go into a per-gesture stroke buffer (`pointer.stroke`) and are
  committed with `globalAlpha = brushOpacity`; soft brushes stamp radial
  gradient dabs (`hardness < 0.98`), hard brushes use a round line.
  `layerWithStroke(layer)` gives the live preview.
- `drawComposite(ctx, {forRun, controlOnly})`: `forRun` skips control layers,
  `controlOnly` draws only them on black. Blend modes map straight to
  `globalCompositeOperation`.
- Undo stack entries: `{kind: "selection"|"layer"|"transform"|"layerfull", ...}`
  with PNG data URLs for pixels (MAX_UNDO 30). `layerfull` stores pixels and
  rect together; it is what rotate/distort/warp push before baking.
- Transform tool: scale mode is live and non-destructive (x, y, w, h). Rotate,
  distort and warp use `this.pending` (`{mode, layer, angle | points, n}`);
  `pendingDst(p, u, v)` maps the normalised layer position to image coords
  (rotation about the center, a homography for distort, bilinear control-grid
  interpolation for warp). `drawLayer` renders the preview through `drawMesh`
  (triangle pairs, affine per triangle, clip grown 0.7 px to hide seams);
  `applyPending` bakes into a new canvas at the layer's native resolution and
  updates the rect. The sub-toolbar (`buildSubbar`/`updateSubbar`) lives inside
  `.ipc-view`; `.ipc-modal [hidden]` needs `display:none !important` because
  the flex rules would otherwise override the attribute.
- `extendCanvas()` bakes visible non-control layers into a new base, keeps
  control layers (shifted / resized), sets the border as selection. The
  border fill is `cropSettings.extendFill`: average colour of a 64 px
  thumbnail (default), grey, green, black, per-pixel random noise, or the
  original stretched edge pixels (the user found the stretching distorting
  and wanted plain colour / noise for context and latent models).
- `history` entries are results; `soloResult`, `removeLayer`, `restoreResult`.
- `setValue` is guarded by a load token and `lastValueString`; concurrent
  restores were producing duplicated layers before.

## 6. Testing

Restart ComfyUI only when idle:

```powershell
$q = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8188/queue).Content
# must contain "queue_running": [], "queue_pending": []
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8188 -State Listen).OwningProcess -Force
Start-Process -FilePath "F:\Comfyui\ComfyUI_windows_portable_nvidia\run_nvidia_gpu.bat" -WorkingDirectory "F:\Comfyui\ComfyUI_windows_portable_nvidia"
```

Server ready when `GET /object_info/InpaintCanvas` returns 200 (about a minute).

Model-free smoke test of the round trip: canvas `crop_image` → `ImageInvert`
→ canvas `result`. Test assets: `input/inpaint_canvas/test_base.png` (512×384
gradient with a white rectangle) and `test_mask.png`.

Browser (in-app browser, `window.comfyAPI.app.app`):

```js
const app = window.comfyAPI.app.app;
app.graph.clear();
const c = LiteGraph.createNode('InpaintCanvas'); c.pos = [80, 80]; app.graph.add(c);
const inv = LiteGraph.createNode('ImageInvert'); inv.pos = [520, 120]; app.graph.add(inv);
c.connect(0, inv, 0); inv.connect(0, c, 'result');
await c.inpaintEditor.setValue(JSON.stringify({width:512,height:384,
  base:{filename:'test_base.png',subfolder:'inpaint_canvas',type:'input'},layers:[]}));
c.inpaintEditor.open();
// synthetic strokes: dispatch PointerEvents on c.inpaintEditor.canvas, map image
// coords with view.scale/view.x/view.y and the canvas bounding rect.
await c.inpaintEditor.generate();   // then poll /history?max_items=1
```

Wait for `.p-blockui-mask` to disappear before scripting, or the restored
workflow will replace the graph mid-test.

Verified on 2026-09-04: loop close, paint/erase/fill, transform + undo,
prompt output, soft brush alpha (50% → 128), blend multiply, control layer
excluded from run image and present on black, grow/shrink exact to the pixel,
selection from layer, extend canvas (border selected), history discard /
restore / solo, workflow reload without duplicate layers.

## 6b. Helper prompts, "Select by text" and object selection (2026-09-05, browser-verified)

Why a helper prompt: the editor needs model runs (segmentation) without
running the user's main chain (Flux.2 API = money) and without custom HTTP
routes. So the frontend queues a standalone prompt at the front of the queue:

```
seg_load: InpaintCanvasLoadRef {ref: JSON of the flattened base upload}
<backend nodes>                       // see SEGMENT_BACKENDS in the JS
seg_out:  InpaintCanvasMaskOut {mask: [.., idx], canvas_node: "<node id>", purpose: "segment"}
```

`api.queuePrompt(-1, {output, workflow: {nodes: [], links: [], version: 0.4,
extra: {inpaint_canvas_helper: true}}})`. Node ids in helper prompts are
strings like `seg_run`; ComfyUI accepts any string keys. The editor listens on
`api` `executed` events for `output.inpaint_mask` and routes by `canvas_node`
(`applyMaskFile`, modes replace / add / subtract, undo pushed). Errors are
matched by `detail.prompt_id === editor.segmentPromptId`.

Backends (`SEGMENT_BACKENDS`, in order of preference; availability = required
node types registered in `LiteGraph.registered_node_types`, plus an optional
`available()` check). Measured on 2026-09-05 with the user's 1776x2368 photo:

- `sam3_rmbg` (default): `SAM3Segment` from comfyui-rmbg -> mask index 1.
  Clean "woman" mask (19 % coverage), ~8 s cold, ~2 s warm. **Every optional
  input must be sent** (`device`, `max_segments`, ... ) because the Python
  signature has no defaults for them; a prompt without `device` fails with
  "missing 1 required positional argument". Weights: `models/sam3/sam3.pt`
  (the node would download that file from `1038lab/sam3` itself). The user
  downloaded the official `sam3.pt` (3.45 GB, facebook/sam3, license gated) to
  `models/checkpoints/sam3.pt`; `models/sam3/sam3.pt` is a hardlink to it
  (`mklink /H`), so core and RMBG share one file.
- `dino_sam`: `GroundingDinoModelLoader (segment anything)` SwinT +
  `SAMModelLoader (segment anything)` (vit_b, or vit_h with the HQ toggle) +
  `GroundingDinoSAMSegment (segment anything)` -> mask output index 1.
  Weights are on disk (`models/grounding-dino`, `models/sams`).
- `sam3_core` (experimental, last): `CheckpointLoaderSimple` (`sam3.pt` shows
  up in the checkpoint list) -> `CLIPTextEncode` -> `SAM3_Detect` -> mask 0.
  **Text prompts return noise here**: for "woman", "person", "face", "legs"
  and even "white rectangle" on the 512x384 test image the mask is scattered
  speckles, independent of threshold and refine_iterations, and the coverage
  is nearly identical for different prompts. The point-prompt path of the same
  node (`positive_coords`) segments the test rectangle correctly, so the
  detector/text path is what is broken (core picks fp16 for SAM3; bf16/fp32
  was not tried because it needs a restart flag). Revisit after a ComfyUI
  update; until then the backend is offered but not default.

Florence-2 was rejected for masks (polygon output is coarse); it would only
serve as a detector in front of SAM2, which GroundingDINO does better.

### Object selection tool (`object`, key O)

Photoshop "object selection" style hover: one model run per image, then
instant hover in the browser.

- Backend: `InpaintCanvasObjectMap` takes Kijai's `SAM2MODEL` (loaded by
  `DownloadAndLoadSAM2Model` with segmentor `automaskgenerator`,
  `sam2_hiera_base_plus.safetensors`, fp16) and an IMAGE, runs
  `model.generate()` (the SAM2AutomaticMaskGenerator instance Kijai's loader
  returns), drops masks under `min_area` (0.02 % of the image), sorts by area
  descending and paints ids into a uint16 label map; it is saved as RGB PNG
  with `id = R + 256 * G` (0 = none) to `temp/inpaint_canvas/` and reported
  as `ui.inpaint_mask` with `purpose: "segments"` and `count`. Kijai's own
  `Sam2AutoSegmentation` node only outputs the union mask (its per-mask data
  ends up in a random-color preview image), which is why the node exists.
  36 objects on the test photo (background, person, face, swimsuit, hair,
  coral pieces, floor), ~4 s warm, ~20 s cold after a restart.
- Frontend: `OBJECT_BACKEND` builds `obj_load` (LoadRef) + `obj_model` +
  `obj_run`; `ensureObjects()` uploads the source, skips the run when
  `objects.hash` already matches, otherwise queues the helper prompt (front of
  queue). `applySegmentsFile()` decodes the PNG into `objects.ids`
  (Uint16Array). `updateObjectHover()` reads the id under the cursor and
  builds a cached red shape canvas (`objectShape`, LRU of 12);
  `draw()` paints it with `ctx.filter = "hue-rotate(180deg)"` (cyan) at 50 %.
  Click (`toggleObjectAt`, only when the pointer moved < 4 px) adds the shape
  to the selection, or removes it when the pixel under the cursor is already
  selected; Shift forces add, Alt forces subtract; each click pushes a
  selection undo step.
- Staleness: the object map is keyed by the source hash. For source *image*
  that is `uploaded.baseHash`, which every layer edit sets to null, so the next
  hover in the tool triggers a refresh. For *active layer* the hash contains
  the layer id and the upload hash, checked when the tool or source changes.

### Source switch (image / active layer)

`segmentSource()` is used by both text segmentation and the object tool.
*image* = the flattened visible non-control layers (reuses `uploaded.baseRef`).
*active layer* = only that layer drawn on #808080 at its rect, uploaded as
`n{id}_segsrc_{hash}.png`; the returned mask (`applyMaskFile`) or label map
(`applySegmentsFile`) is clipped with `layerAlpha(layer)` (alpha > 0 in image
coordinates). Verified: a red brush blob on a paint layer gives 2 objects
(grey + blob), hovering outside the blob gives id 0, "red shape" via SAM3
selects only the blob.

Why not LoadImage: its `image` widget is a combo validated against the
top-level input listing, so files in `input/inpaint_canvas/` fail validation.
Hence `InpaintCanvasLoadRef`.

`InpaintCanvasMaskOut` saves to `temp/inpaint_canvas/`, merges a mask batch
with max, and reports `coverage` (mean) in the ui payload.

Florence-2 was considered and rejected for masks (polygon output is coarse);
it would only serve as a detector in front of SAM2, which GroundingDINO does
better. Comparison: SAM3 > GroundingDINO+SAM for text prompts; both beat
Florence.

## 7. Known limitations

- Base layer is not editable (no erase); painting on it creates a paint layer.
- History thumbnails come from the layer canvas or the output file; discarded
  results keep their file in `output/inpaint_canvas/` until the user runs
  "Clean up files" (section 12); uploads accumulate in `input/inpaint_canvas/`
  (hash-named, deduplicated per content) the same way.
- Transforming a layer that has a mask (rotate / distort / warp / scale bake)
  applies the mask first; the mask is not transformed separately.
- Very large canvases: `selectionBounds`, `layerAlpha`, the object map and the
  distance transform are O(W*H) in JS; a 4K canvas takes a few hundred ms per
  op.
- Painting on a scaled layer paints into its native resolution (fine), but
  brush size is scaled by the average of the two axes.
- The object tool's map is computed at `points_per_side` 32; very small parts
  are missed (a detail slider would raise it to 48/64).
- Prompt upsampling with the 2B model: German requests sometimes lose a word,
  *remove* keeps describing the object (see section 11).
- Setting outputs push values into the target widget, but a value typed into
  the target widget itself is not read back until the link is re-made.
- No LICENSE file yet (user has not chosen one).

## 8. State at the end of the 2026-09-05 session

Everything in README is built and verified (browser and/or API), pushed to
GitHub as DenRakEiw, latest commit "README rewritten ..." (`64ce260`). Nothing
is half-done. Screenshots for the README live in `docs/img/*.jpg` and were
taken with `docs/shots.py`: a headless Edge with `--remote-debugging-port`
driven over the DevTools protocol (aiohttp websocket), which loads ComfyUI,
builds a demo graph, opens the editor, runs SAM3 / SAM2 / a model-free
round trip and captures `Page.captureScreenshot`. Re-run it after UI changes
(see the docstring; ComfyUI must be running).

Test recipes: section 6 (round trip), 6b (helper prompts), and from the
console `ed = c.inpaintEditor`, `ed.setTool("object")`, dispatch
`PointerEvent`s on `ed.canvas` (map image coords with `ed.view` and the
canvas bounding rect; `buttons: 0` for hover, pointerdown + pointerup at the
same spot for a click). In the in-app browser the pane must be visible for
the editor to have a layout; hidden panes give a 0x0 canvas. The
`.p-blockui-mask` element can stay in the DOM with size 0x0 after the
workflow restore; check `offsetWidth` rather than existence.

## 9. Roadmap

Done from the user's Krita list and the plugin analysis: control layers,
soft brush + opacity, blend modes, outpainting with border fill, grow /
shrink / from layer, history, select by text, object selection, prompt
upsampling, auto context / feather, fill modes, color match, API / local
switch, denoise + seed, refine, negative prompt, strength-scaled feather,
editor-driven setting outputs.

Open, roughly by value for the user's workflow (Flux.2 API plus local Klein):

1. **Reference layers**: done (section 12).
2. **Batch / variants**: N results per Generate landing in the history, plus
   an A/B compare (InvokeAI's staging area idea: accept or discard before the
   layer stays). Local only by default; on the API it is N paid calls, so ask
   for confirmation.
3. **Layer masks and cutouts**: done (section 12).
4. **Styles**: presets bundling prompt prefix / suffix, `<lora:name:1.0>`
   syntax parsed out of the prompt, sampler settings (Krita's new "Style &
   Prompt" node does this for custom workflows); here they would become
   string outputs and setting values.
5. **Regions**: per-layer prompts through the installed comfyui-tooling-nodes
   (`ETN_BackgroundRegion`, `ETN_DefineRegion`, `ETN_AttentionMask`), local
   models only; verify Flux.2 Klein support first. Krita 1.53 also added
   semantic segmentation control layers (Anima regional controlnet), which
   is the same idea from the control side.
6. **Object tool details**: a detail slider (points_per_side 48 / 64), all
   object outlines shown while the tool is active, SAM3 point prompts for a
   click-to-segment without the precomputed map (core's point path works).
7. **Live preview**: Krita's live mode (continuous low-step generation while
   painting) is a separate project; a cheap first step is "auto-generate on
   selection change" with a local model.
8. **Housekeeping**: LICENSE; Comfy Registry publish once
   `REGISTRY_ACCESS_TOKEN` exists; soft-edged selection preview; brush
   presets; keyboard colour picker. (File cleanup is done, section 12.)

Done since (2026-09-05, late): 1 reference layers, 3 layer masks / cutouts,
file cleanup from 8. See section 12.

Sources looked at on 2026-09-05: the installed Krita AI plugin (`%APPDATA%/
krita/pykrita/ai_diffusion`, GPL-3: reimplement, never copy), its 1.49 / 1.53
release notes, Comfyui-LayerForge (polygonal inpaint selection, IndexedDB
persistence, background removal), InvokeAI's unified canvas (infinite canvas,
staging area, region prompting).

## 10. Crop settings: auto sizing, fill modes, color match (2026-09-05)

Stored in `canvas_state.crop = {context, feather, fill, colorMatch}` (not as
node widgets: invariant 5). Defaults for new canvases `CROP_DEFAULTS`
(auto / auto / none / true); states without a `crop` key load `CROP_LEGACY`
(manual / manual / none / false) so old workflows behave as before. The
editor's Crop section edits them; `cropRect()` and `renderInfo()` mirror the
backend formula so the dashed rectangle matches what is emitted.

Formulas (`_auto_selection_params` in nodes.py, `autoSelectionParams` in JS;
Krita AI defaults reimplemented): `diag` = selection bbox diagonal,
`feather = max(int(0.10 * diag), 32)`, `grow = 4 + feather // 2`,
`blend = min(25, grow + feather // 2)`, `pad = feather + 4 + int(0.06 * diag)`.
Auto context pads the bbox by `pad` and then widens it symmetrically to
`MIN_AUTO_CROP` = 512 per side (`_ensure_min_span`, clamped to the image).

Masks in auto feather mode:
- denoise mask (`crop_mask` output) = selection -> dilate(grow) -> gaussian
  blur(sigma feather / 2.5) -> max with selection (opaque inside).
- composite mask (stitch) = denoise -> erode(blend // 2) -> blur(sigma
  blend / 2.5) -> max with selection. Manual mode keeps the old
  `_blur_mask(mask, feather)`.
`stitch_info` carries `feather, grow, blend, auto_feather, color_match`.

Fill (`_fill_masked`, applied to the crop before scaling, fill mask =
selection dilated by `max(grow - feather // 2, 0)`, i.e. 4 px in auto mode):
neutral = mean colour of the unmasked crop pixels with a soft edge (sigma 4);
blur = normalized-convolution smear of the surroundings (sigma
`max(8, 5 % of the crop's long side)`) so the old content does not bleed;
border = OpenCV `cv2.inpaint(..., INPAINT_NS)` averaged with the smear; green
= (0, 1, 0) hard. `cv2` 4.13 is in python_embeded; blurs fall back to PIL.

`crop.withOriginal` (2026-09-05 late, user request): with a fill mode the
`crop_image` output is `torch.cat([filled, untouched])`, filled first, so an
edit model that gets the green area also sees what was there (the user
masked a whole head to change the hair and got the back of a head). The
stitch takes `result[0:1]` as before. Off by default; the Crop info shows
"×2 (filled + original)" when it applies.

Color match (`_color_match`): per-channel mean/std transfer in RGB, measured
where the composite keeps the base (`1 - composite mask`, the ring), std ratio
clamped to [0.5, 2], skipped when the ring has < 64 px of weight. Verified on
an inverted patch: ring means moved from (124, 153, 144) to (121, 94, 101)
against a base ring of (130, 102, 111).

Verified via the API (`InpaintCanvas` -> `ImageInvert` -> back, synthetic
1024x768 base with a 120x90 ellipse selection): manual crop 249x219,
auto crop 512x512, all five fill modes visually correct, composite opaque
inside the selection.

## 11. Prompt upsampling (2026-09-05)

Helper prompt: `up_load` (LoadRef of the context image) -> backend -> `up_out`
(`InpaintCanvasTextOut`, `ui.inpaint_text = [{text, canvas_node, purpose}]`),
routed in the `executed` listener to `applyTextResult`. The node strips
wrapping quotes and a "Prompt:" prefix.

Context image (`promptContextCanvas`): the crop rect of the flattened image,
long side <= 1024, with the selection marked by a magenta outline (about
1/300 of the width; a red tint was tried first and made the model describe
the tint instead of the requested colour), or solid green when
`cropSettings.fill === "green"` (so the model sees what the generator sees).
Uploaded as `n{id}_promptctx_{hash}.png`.

Backends (`UPSAMPLE_BACKENDS`): `qwenvl` = `AILab_QwenVL` from ComfyUI-QwenVL
with `Qwen3-VL-2B-Instruct` (on disk in `models/LLM/Qwen-VL`, fp16;
`custom_prompt` replaces the preset entirely; the preset combo value must
still be a valid option, it is the emoji-prefixed "Detailed Description"),
~9 s cold. `gemini` = core `GeminiNode` (Comfy API, `gemini-2.5-flash`,
`images` input) for users with API credits.

Instructions (`upsampleInstruction`): deliberately short, "Look at the
image ..." + the request, the task paragraph per use case (fill 40-80 words
blending with the surroundings; add = object + scale, contact, shadows;
remove = only what is visible with the object gone; edit = verb-first
instruction <= 50 words; outpaint = continuation beyond the border), a rules
sentence (translate, keep requested colours/materials, never mention the
marker/region/image, prompt text only) and the request repeated at the end.
A long preamble made Qwen3-VL 2B drop the request entirely. `resolveUseCase()`
maps auto to outpaint when the selection touches a canvas edge, else **edit**
(changed 2026-09-05 late: the user's chains are edit models, and the fill
description that auto produced before read like an image caption, e.g.
"change her haircolor to light blue" -> a paragraph about a surreal portrait).
The edit instruction is its own template: role sentence, the request first,
the rewrite rules (15-35 words, verb first, name the subject as seen, exact
colours / materials, end with what stays unchanged, no description of the
picture or its current state), two worked examples (one German), the request
again at the end. Measured with Qwen3-VL 2B (2-6 s warm): "change her
haircolor to light blue" -> "Change the woman's hair color to light blue,
maintaining her facial features, expression, skin tone, makeup, clothing,
posture, setting, and all other elements that remain constant."; "mach den
Badeanzug rot mit weißen Punkten" -> "Change the swimsuit to red with white
dots, keeping the woman's posture, ..."; "remove the corals on her arms" ->
"Remove the coral decorations from the woman's arms, preserving ...".

Measured with Qwen3-VL 2B (2-5 s warm): fill/edit/add follow English requests
well ("red silk swimsuit" -> correct colour and material); the German
"roter Seiden-Badeanzug" kept the swimsuit black in fill (edit got it
right); remove keeps describing the object that should disappear, the 2B
model cannot imagine it gone. Hence the 4B backend option (downloads on
first use) and Gemini for quality.
Settings persist in `canvas_state.upsample = {useCase, backend}`; the backend
list is filled in `refreshSegmentBackends()` from the registered node types.

Two-way link with "Select by text" (user request, 2026-09-05):
- Segmentation -> upsampling: `selectionLabel` remembers the term of the last
  text segmentation (replace sets it, add/subtract append, `clearSelection`
  resets it) and `upsampleInstruction` gets it as `hint`: the region is
  described as "... (it currently contains: swimsuit)".
- Prompt -> segmentation: Go with an empty Select-by-text field and a prompt
  present chains, inside one helper prompt, `term_run` (the upsample backend
  with `segmentTermInstruction`, a two-step "translate, then name the object"
  instruction; a single question made the 2B model copy German words) ->
  the segmentation node's `prompt` input (STRING link) -> `InpaintCanvasMaskOut`
  with the optional `label` input linked to the same text, echoed as
  `info.label` so the editor can show the derived term in the field. Measured
  with Qwen3-VL 2B: "roter Seiden-Badeanzug" -> bathing suit, "eine goldene
  Kette um den Hals" -> necklace (not in the picture yet, SAM3 then finds
  nothing), "entferne die Korallen an den Armen" -> coral branches.
- The HQ toggle is hidden unless the GroundingDINO + SAM backend is chosen.

Key handling: the window keydown listener (capture phase, registered in
`open()`, removed in `close()`) now handles every key while the editor is
open and calls `stopImmediatePropagation()`, except for keys typed into the
editor's own inputs. Before, Ctrl+Z reached ComfyUI's workflow undo as well
and reverted the canvas state.

## 12. Reference layers, layer masks / cutouts, file cleanup (2026-09-05, late)

### Reference layers (in the `crop_image` batch)

**Changed the same evening:** the separate `reference_images` output is gone.
Wired into a node with no reference layers present it was an empty batch,
and everything downstream (PreviewImage, the API node's preview) failed with
"index 0 is out of bounds". References are now appended to `crop_image`
after the crop (and after the untouched crop when "Original" is on), each
fitted to the crop's size with `_fit_image(img, W, H, fit)` (pad with the
border colour / cover-crop / stretch). Without reference layers
`crop_image` is unchanged. `TAIL_OUTPUTS` is empty; `syncSettingOutputs`
removes leftover non-setting outputs from saved workflows. The mechanism
below is kept for the record and for future tail outputs.

Role `reference` on a layer (`ROLES` now has it between none and the control
roles). `isControl()` excludes it, `isReference()` / `referenceLayers()` (visible
ones, panel order = array reversed, so the top of the list is reference 1)
select it. `drawComposite({forRun})` skips control *and* reference layers;
`controlOnly` skips them as well. In the editor they are drawn normally plus a
cyan dashed frame with "ref n" (`draw()`), the layer badge says "ref n" or
"ref (hidden)". Upload: image button in the Layers header (`refInput`,
multiple), drop on the layer list, or drop on the canvas with Shift
(`addImageLayers(files, role, {place, at})`; a plain drop on the canvas adds
image layers with `place: "at"`, centred on the drop point, Ctrl+drop or a
drop without a base calls `loadFile`): the original file is uploaded
with `overwrite: false` and *is* the layer's `ref` (kind `image`, `dirty`
false), the layer is shown at a third of the canvas, cascaded from the top
left. `extendCanvas()` and `flatten()` keep reference layers.

`serializeForPrompt` adds `references: [ref, ...]`: the file itself when the
layer is untouched and has no mask, otherwise `layer.exportRef`, an upload of
`layerPixels(layer)` (mask applied), invalidated by `markLayerChanged` /
`markMaskChanged` / role change. Plus `refs: {size, fit}` from the Canvas
section.

Backend: `_reference_batch(images, size, fit)` scales every image down to the
long side `size` (0 = native; small images are never upscaled), takes the
largest remaining width and height as the batch size and pads (border mean
colour, `_border_color`), crops (`common_upscale` with `crop="center"`) or
stretches the others. Transparent PNGs are composited on white
(`_load_rgb(ref, background=(255, 255, 255))`). No references -> a
`[0, 64, 64, 3]` batch, which the Flux.2 API nodes treat as "no reference"
(`get_number_of_images` = 0). Verified in `comfy_api_nodes/nodes_bfl.py`
(v0.33.2): `Flux2ImageNode` flattens 4-D tensors of every `image_n` input, and
`Flux2ProImageNode` / `Flux2MaxImageNode` iterate `images.shape[0]`; both cap
at 8 / 9 references and downscale each to 2048² pixels themselves.

**Output slot mapping.** The backend appends `reference_images` after
`setting_8` (slot 21 = `FIXED_OUTPUTS + SETTING_SLOTS`). The frontend keeps
its "connected settings plus one free slot" behaviour, so it cannot show slot
21 at index 21. `TAIL_OUTPUTS` lists such outputs; `syncSettingOutputs`
orders the node's outputs as fixed (13), settings by number, tail, and rewrites
`link.origin_slot` for every link (`linkOf(graph, id)` covers `getLink`,
`_links.get` and `links[id]`; litegraph's `removeOutput` decrements
`origin_slot` of later links itself, `addOutput` only appends). The
`api.queuePrompt` wrapper then maps every prompt input `[canvasId, slot]`
whose visible output is a tail output to the backend slot by name.
`isSettingOutput` (`/^setting_\d+$/`) is what tells setting slots from tail
outputs everywhere (`settingTargets`, `onConnectionsChange`). Saved
workflows without the tail output get it appended on load (the `onConfigure`
timeout calls `syncSettingOutputs`); setting links keep their slots.

### Layer masks and cutouts

Per layer: `mask` (canvas at `layer.canvas` size, alpha = visible, colour
white), `maskRef` (uploaded `n{id}_lmask_{hash}.png`, RGBA so the alpha
survives), `maskDirty`, `maskEdit`. `layerPixels(layer)` is the one accessor
for a layer's composited pixels: `layerWithStroke` (pixels + live pixel
stroke) `destination-in` `maskWithStroke` (mask + live mask stroke), cached in
`layer._masked` / `_maskedValid` when no stroke is live. It replaced
`layer.canvas` in `drawLayer` (also the pending-transform preview),
`layerAlpha`, `selectionFromLayer`, `segmentSource` (active layer),
`drawHistoryThumb` and the reference export. Strokes: `onPointerDown` routes
paint / erase to `{kind: "maskpaint", white: true}` when the active layer has
`maskEdit`; `layerDab` paints white, `commitStroke` targets the mask, paint =
source-over (reveal), erase = destination-out (hide). `fillSelection` on a
mask in edit mode reveals the selection. Undo: kind `mask` (data URL or
null); `layerfull` snapshots carry the mask too, and `applyPending` bakes the
mask (`applyMask(layer, {silent, undo: false})`) before transforming.

Mask row in the layer panel: cutout (scissors), backend select (on the active
layer only, `cutoutSel`, persisted in `cutout.backend`), mask from selection,
state text, edit toggle (`ipc-on`, pencil), apply (check), remove (trash).
`toggleMaskEdit` switches to the paint tool and turns the other layers' edit
off; the edited layer gets a magenta dashed frame in `draw()`.

Cutout helper prompt (`cutoutLayer`): `cut_load` (LoadRef of
`n{id}_cutsrc_{hash}.png` = `layer.canvas`, transparent pixels turn black on
the way to RGB) -> backend -> `cut_out` (`InpaintCanvasMaskOut`, purpose
`cutout`). `CUTOUT_BACKENDS`: `rmbg2` (comfyui-rmbg `RMBG` with model
RMBG-2.0; every optional input is sent, same as SAM3), `birefnet`
(`BiRefNetRMBG`, BiRefNet-general), `ben2` (`RMBG`, BEN2), `bria14`
(`BRIA_RMBG_ModelLoader_Zho` + `BRIA_RMBG_Zho`, weights ship with the node).
comfyui-rmbg downloads its weights into `models/RMBG/<model>` on first use
(`1038lab/*` mirrors, not gated). The `executed` listener routes purpose
`cutout` to `applyCutoutFile`, which reads the grayscale PNG into the mask's
alpha; `execution_error` with `cutoutPromptId` clears `cutoutPending`.

### File cleanup

`POST /inpaint_canvas/cleanup` with `{keep: [filenames], dry_run, min_age}`
(`_register_routes` at import; `PromptServer.instance` exists when custom
nodes load). `_cleanup_files` lists the three `inpaint_canvas` folders
(input/ and output/ restricted to `INTERNAL_FILE_RE`, the node's own
`n<id>_<kind>_...` names, so user uploads and exports are never candidates),
scans every `*.json` under `folder_paths.get_user_directory()` (saved
workflows of every user; files over 50 MB skipped) for the file names, keeps
those, the `keep` list and anything younger than `min_age` (default 120 s),
and deletes or only counts the rest. The editor (`cleanupFiles`) collects
`keep` with `InpaintEditor.referencedFiles()`: every open editor's state
(`lastValueString`, `getValue()`, `uploaded`, layer / mask / export refs),
every open workflow tab (`app.extensionManager.workflow.openWorkflows`:
`content`, `activeState`, `initialState`) and every `localStorage` value
(the frontend keeps unsaved workflows there). Flow: dry run -> confirm with
counts and sizes -> real run -> status. `_prune_temp()` in `MaskOut.send` and
`ObjectMap.run` deletes helper results older than an hour.

## 13. Filter layers (2026-09-05, late)

Scope decided with the user: only what helps an inpainted patch blend and the
image finish (grain, sharpen, levels, LUT, vignette), no Nik-style suite.
`js/inpaint_filters.js` holds the registry `FILTERS` (`{label, params:
[{key, label, min, max, step, default, unit, type}], apply(src, params,
info), needsLut}`) and the `.cube` helpers; the editor knows nothing about
individual filters.

Layer model: kind `filter`, `filter` id, `params`, `lut: {name, size, ref}`
plus `_lutData` (Float32Array size³·3) in memory, `_fcache`. The layer keeps an
empty W×H canvas so masks, undo and the panel code work unchanged; paint,
erase, fill, transform and cutout refuse filter layers (mask editing works).

Compositing: `drawComposite` takes a fast path without filter layers and
otherwise renders everything into `this.flatCanvas` (image-sized) through
`drawLayersInto`, so a filter layer sees the composite below it at full
resolution (`applyFilterLayer`), then draws the flat canvas onto the target
(view, thumbnail, flatten). `filteredCanvas` caches the result per layer,
keyed on `compositeVersion`, params, LUT file, `forRun` (control / reference
layers are excluded there) and preview mode. `compositeVersion` is bumped by
the `uploaded.baseHash` setter (`makeUploaded`) whenever it is cleared, which
every composite change already did. During a slider drag (`filterPreview`
= layer id, set on `input`, cleared on `change`) the filter runs on a copy
downscaled to 1024 px (`info.scale` shrinks radii) and the result is drawn
scaled up; `change` pushes one undo step captured at the first `input`
(`_undoPending`, `pushUndoSnapshot`). While a gesture edits a layer below the
filter, the filter is skipped for that frame so the live stroke stays visible.

LUTs: `lutFromCube` parses 3D `.cube` (DOMAIN_MIN/MAX honoured, 1D rejected),
`lutToCanvas` bakes it into a size²×size RGB PNG (x = r + b·size, y = g) that
is uploaded like any layer file (`n{id}_lut_{hash}.png`, so the cleanup keeps
it), `lutFromImage` reads it back on restore. Applying is trilinear in a
pixel loop, `strength` mixes with the input.

Grain presets (`GRAIN_PRESETS`, param type `select`, grouped by `group`
into optgroups): a preset copies its `amount`, `size`, `chroma` and `look`
into the params; any grain slider sets the preset back to `custom` (the
`Look` slider, `keepPreset`, does not). `look` = `{sat, contrast, warmth,
tint, fade, mix (3x3 row-major channel mixer), mono (luminance weights for
black-and-white, ortho and infrared)}` applied by `applyLook` before the
grain, mixed by `look_strength`. The artistic stocks (LomoChrome Purple /
Turquoise, Aerochrome, redscale) are channel mixes; Metropolis, cross-
processing, expired and instant film are saturation / contrast / fade /
cast combinations.

Grain distribution (measured 2026-09-05 on fotokorn.de plates the user
downloaded: Kodak Gold 200, Lomography CN 400, Rollei RPX 400, Tri-X from
the demo PSD, 6048 px wide, greyscale overlays): high-pass noise is skewed
and heavy-tailed (skew 0.48 / 0.62 / 0.77 / 0.94, kurtosis 3.2 / 3.7 / 4.6 /
5.4), correlation length about 0.5 px at 6048 px (sharpened scans; real
grain is sub-pixel at our working sizes), chroma zero (the plates are
desaturated), and the amplitudes are normalised by the vendor, so they do not
calibrate amounts. The synthetic noise is therefore a standardised lognormal
(`speckle` slider -> sigma up to 0.5; sigma 0.3 gives skew ~0.95 / kurtosis
~4.6 like the black-and-white plates, presets: classic B&W 60, T-grain 40,
colour negative 36, cine 30, slide 24). A real plate can be loaded per
layer (`layer.plate = {name, ref, w, h, mean, std}`, `_plateImg`,
`plateStats`): it is tiled with a canvas pattern at `plate_scale`, centred on
its mean and normalised by its high-pass std so `amount` keeps its meaning;
`size`, `speckle` and `chroma` are hidden while a plate is loaded. The
measuring script: high-pass with a 12 px gaussian, std / skew / kurtosis,
lag autocorrelation 1..12 px. `chroma` replaced the `mono` flag the same evening (old
layers: `mono === false` -> 100, else 0); the noise is a luminance part
shared by all channels plus a per-channel part weighted by chroma. The
values are approximations of how the stocks are described, not measured.

Performance (2026-09-05 late, after the user found the opacity slider on a
grain layer "lahm"): a filter layer's own opacity or blend never invalidates
its cache (the input below is unchanged), the noise field of the grain
filter is cached per layer in `layer._fxCache` (key: size, speckle, chroma,
seed, canvas size, or plate + scale), samples come from a 64k lookup table
instead of exp/log per pixel, and slider `input` events draw once per
animation frame (`drawSoon`, `markFilterChanged(layer, {soon: true})`);
dragging the opacity of a layer *below* a filter sets `filterPreview = "*"`
(all filters at preview size). Measured on the 1776×2368 photo: grain full
107 ms (was 226), preview 17 ms (was 143), filter opacity drag 0 ms per
event, 20 opacity events on a layer below the filter 527 ms in total.

Measured on the 1776×2368 photo in headless Edge: grain 144 ms, sharpen
75 ms, cached redraw 0 ms; invert LUT exact (mean 16.25 -> 238.75, strength
50 -> 128); mask from selection limits the effect to the selection (outside
diff 0); getValue/setValue round trip identical (diff 0, LUT restored); the
run uploads a flattened base with the grain baked in.

### 13b. Adjustment filters (2026-09-06)

Six point / convolution filters were added to `FILTERS` (ids `blur`,
`curves`, `brightness_contrast`, `hue_sat`, `color_balance`, `bw`, plus the
parameter-less `invert`), all in `inpaint_filters.js`; the curves editor and
its interpolation live in `js/inpaint_curves.js` (imported by the filter
module, nothing in the editor file knows about it). All of them are one pass
over the pixels with precomputed tables or a 3x3 matrix; `openPixels` /
`applyTables` / `copyCanvas` are the shared helpers, identity parameters
return a plain copy.

- `hue_sat`: SVG `feColorMatrix` hueRotate and saturate matrices (Rec. 709
  luma constants) multiplied into one 3x3 (`hueSatMatrix`), lightness as a
  256 table (positive blends to white, negative to black). Hue 180 turns a
  pure red into (0, 109, 109): the matrix keeps luma, so pure primaries do
  not become pure complements as an HSL shift would.
- `brightness_contrast`: one 256 table. Brightness `b` (scaled to ±0.4)
  adds `b (1 - v²)` above zero and `b (1 - (1 - v)²)` below, so one end stays
  fixed and the slope never goes negative; contrast is the Photoshop legacy
  pivot around 0.5 with slope `1 / (1 - 0.98 c)` (c > 0) or `1 + c` (c < 0).
- `color_balance`: nine sliders `{shadows,mid,high}_{cr,mg,yb}` and the bool
  `preserve`. The shift of a pixel depends only on its luma, so the three
  channel offsets are `Float32Array(256)` tables indexed by Rec. 601 luma
  (`colorBalanceTables`): tone weights are the GIMP ramps (shadows fade out
  0.21..0.46, highlights fade in 0.54..0.79, midtones the product), gain
  0.4·255 per 100, and *preserve luminosity* subtracts the luma of the offset
  from all three channels inside the table. +100 midtone red moves mid grey
  to (200, 98, 98).
- `curves`: `params.curves = {rgb, r, g, b}`, each a point list `[[x, y],
  ...]` in 0..255 (a `type: "custom"` param, default from `curveDefaults`).
  `curveTable` is Fritsch–Carlson monotone cubic (no overshoot, flat outside
  the end points), `curvesToTables` composes master then channel into three
  tables (`null` when everything is identity: plain copy). The apply pass
  also stores a luma histogram of its input (every 4th pixel) in
  `info.cache.histogram` = `layer._fxCache.histogram`, which the control
  draws behind the curve (sqrt-scaled). The control (`buildCurvesControl`,
  220x160 CSS px, DPR-aware, channel buttons, Reset / Shift+Reset): the
  gesture calls `callbacks.begin()` and then *replaces*
  `layer.params.curves` with a deep copy before mutating it, because the
  editor's filter snapshot copies params shallowly — the undo snapshot keeps
  the old object. Pointer capture on the canvas; click adds a point on a free
  column, drag clamps y to 0..255 and x between the neighbours (end points
  keep their x), dragging more than 36 px outside the box removes an interior
  point (re-entering re-inserts it), double-click removes, `preview()` per
  move, `commit()` on up / cancel. `callbacks.stop` is attached for click,
  pointerdown, dblclick and keydown on the wrapper so the layer row ignores
  the gesture. After an undo the layer list is re-rendered, so tests must
  re-query the row before dispatching more events.
- `blur`: `ctx.filter = blur(sigma)` with sigma = radius · `info.scale`, on a
  canvas padded by `ceil(3 sigma) + 2` px of mirrored source (eight
  `drawImage` calls with flipped transforms), cropped back and backed with
  the source through `destination-over` so alpha is exactly 255 everywhere.
  Radius < 0.05 px returns a copy.
- `bw`: weights normalised by their sum (30/59/11 and 60/118/22 are the
  same), one dot product per pixel; tint = `hueToRgb(hue) - 0.5` times
  `0.35 · 255 · strength` times a midtone tent `1 - |2l - 1|`, so black and
  white stay neutral (hue 35 at 100 % on mid grey: 172, 135, 84).
- `invert`: the 255 - i table, no params (`filterDefaults` returns `{}`).

Measured 2026-09-06 in headless Edge on a 2048x2048 gradient (best of 3,
`applyFilter` plus a 1x1 `getImageData`): hue_sat 51 ms, brightness_contrast
39, color_balance 39, curves 26, bw 33, invert 23, levels 23 (for
comparison), blur radius 4 / 64 1–2 ms (GPU; 11 ms with a full 2048²
readback, checker variance 16256 -> 0, min alpha 255), blur 64 on the 1024
preview 2 ms. Scene checks (512x384 patches through `addFilterLayer` +
`flattenToCanvas({forRun: true})`): hue 180 red -> (0, 109, 109), saturation
-100 -> grey, lightness ±50 on mid grey -> 192 / 64; brightness +50: 40 ->
90, 128 -> 166, 220 -> 233; contrast -100 -> everything 128; curves
[128 -> 192] lifts mid grey to 192 and a blue curve [0,255]-[255,0] inverts
blue only (master then channel: 192, 192, 63); bw red-only weights make red
white and green black; invert red -> cyan; the curves params survive a
getValue/setValue round trip; no `console.error` during the run. The scene
file is `scratchpad/fx2/scenes_fx2.py` (runner on port 9334).

## 14. Export (2026-09-05, late)

`exportImage({download})`: `flattenToCanvas({forRun: true})` (filters baked,
control / reference layers out) -> PNG or JPEG blob -> `uploadBlob(..., {type:
"output", subfolder: ""})`, i.e. the output root like SaveImage (not
`output/inpaint_canvas`, which the cleanup treats as working files). The
upload route de-duplicates identical content (same name returned, no new
file) and appends " (n)" for changed content. PNG gets tEXt chunks
`workflow` (graph serialize) and `inpaint_canvas` (prompt, negative, size,
seed, mode) inserted after IHDR by `pngWithText` (CRC32 in JS); non-ASCII is
`\uXXXX`-escaped by `asciiJson` so the chunk stays Latin-1 and the JSON
stays valid. Verified: chunks parse, `Bäume` survives, levels are baked
(mean 138 -> 85). Download = object URL + `<a download>`. Ctrl+S in the
editor, the Save button in the top bar, name / format / Download in the
Canvas section.

## 15. Doubled contours: stretch-back, alignment, whole-crop paste (2026-09-05, late)

The user's swimsuit edit (Flux.2 [pro], crop 765×1424 emitted as 576×1024)
came back with doubled outlines along the arm and shoulder while the model's
own output looked right. Measured on the stitched patch against the base in
the ring outside the selection: ECC affine fit scale x 1.048, shift -18 px,
ring mean abs difference 14.2 -> 9.6 after warping; the patch's Laplacian
variance was 145 against 1366 for the base (rendered at 1024 px, upscaled).

1. `run()` rounds both emitted sides to `multiple_of` independently, which
   changes the aspect ratio (here 4.7 %) and *stretches* the crop; the stitch
   then center-cropped the result instead of stretching it back. Now
   `stitch_info.emitted` carries the emitted size and a result with that
   aspect (within 1 %) is resized with `crop="disabled"`, the exact inverse;
   only a result with another aspect is center-cropped. The Crop info warns
   "aspect n % off, stretched back on stitch" above 1.5 %.
2. Edit models drift anyway. `_align_patch(patch, region, keep)`: grayscale,
   downscaled to 512 px, `cv2.findTransformECC` MOTION_AFFINE with the ring
   (`1 - dilate(blend, blend + feather/2)`) as inputMask; accepted only when
   scale is within 8 %, shear < 0.03, shift < 5 % of the region and the ring
   difference drops by at least 3 %; then `cv2.warpAffine` (inverse map,
   reflect border) on the RGB patch. `crop.align` (Crop section "Align",
   default on); the report goes into `ui.inpaint_result[].align` and the
   status line. Verified offline on the real result: ring difference 14.17
   without, 9.95 with alignment.
3. `crop.paste` = "selection" | "crop" (Crop section "Paste"). With "crop"
   the composite mask is the whole bbox rectangle, eroded by `f // 2` and
   blurred by `f / 2.5` (`f = max(8, feather, blend)`), multiplied by the
   rectangle so the fade stays inside it: alpha 1 in the middle, 0.64 at
   10 px, 0.2 at 2 px from the edge with feather 16. The user's request: the
   model's output is consistent in itself, only the selection border was
   the problem.

The remaining softness is resolution: `target_size` 0 (native) or above the
region size for API models (Flux.2 accepts up to 2048 px).

## 16. Corner rotation, canvas tool, text layers (2026-09-06)

### Rotation at the corners (transform tool)

`rotateZoneAt(l, ix, iy)`: outside the layer frame (beyond the handle radius)
and within 5 handle radii of a corner. In scale mode a pointer-down there calls
`startPending("rotate")` and hands the event to `pendingPointerDown`, so the
rotation is the usual pending transform (bar switches to Rotate, angle field,
Enter bakes via `applyPending`, Esc cancels). While it is pending,
`pendingPointerDown` maps the pointer into the un-rotated frame
(`toLayerLocal`, inverse rotation about the centre): a handle there scales,
inside moves, outside rotates. Scaling while rotated: `applyScale` runs in the
local frame with the centre fixed at gesture start (`p.center`); because the
preview rotates about the *current* centre, the rect is then shifted by
`(R - I)(c_new - c_orig)` so the anchor corner stays put on screen (measured
in the headless test: 1 px drift at 20°). Cursors: `CURSOR_CLASSES`,
`setHandleCursor(handle, rotate)`; the rotate cursor is an inline SVG.

### Canvas tool (extend by dragging)

Tool `canvas` (key C). The four Canvas-section inputs are the single source of
truth: `extendRect()` derives the planned rectangle from them, `draw()` shows
it as a dashed frame with handles, a tint over the new border and the pixel
counts per side, `canvasHandleAt` hit-tests the frame. Dragging a handle
writes the inputs (`pointer.kind === "canvasext"`, 8 px steps, Alt = 1 px,
never below 0: shrinking is not a crop). Enter (or the button) calls
`extendCanvas()`, Esc resets the inputs while something is pending, then
closes as usual.

### Text layers

Layer kind `text` with `layer.text = {content, font, fontRef, size, color,
bold, italic, align, lineHeight, letterSpacing, outline, outlineColor, res}`
(`TEXT_DEFAULTS` in `js/inpaint_text.js`). `renderText()` measures with
`fontBoundingBoxAscent/Descent`, draws at `res = 2` (stroke for the outline,
then fill) and `renderTextLayer()` puts the result into the layer keeping the
user's scale factor (`layer.w / (canvas.width / res)`). Everything else treats
it as a pixel layer: transform (a baked rotation is lost on the next text
edit), masks, match, blend, flatten, upload (`syncLayers`) and reload from
`ref`; `getValue` also stores `text`, and a text layer that was never uploaded
is rendered again on load (`textToRender` in `setValue`). Undo kind `text`
(canvas + geometry + description); the text area snapshots on focus and pushes
on change, the colour inputs likewise, everything else through `change()`.

Fonts: `js/fonts/fonts.json` lists the 17 bundled families (variable-weight
files get a `100 900` FontFace weight so bold uses the axis, static ones are
synthesised), licences in `js/fonts/licenses`. User fonts: uploaded through
the plain `/upload/image` endpoint (it accepts any file) to
`input/inpaint_canvas/fonts`, listed by `GET /inpaint_canvas/fonts`,
registered with `addUserFont`; a layer remembers `fontRef` so another browser
can load the face without the listing. The cleanup only looks at files
directly in `input/inpaint_canvas`, so the fonts folder is never touched.
The `familyOf()` name comes from the file name (brackets, "Regular", "VF"
stripped).

Test: scratchpad `scenes_text.py` (rotate zone cursor, pending rotate, scale
in the rotated frame with anchor check, move, Enter; canvas tool drag with
and without Alt, Enter; text layer creation, font list, re-render on input,
bold + undo, kind select round trip, persistence).

## 17. Quality-of-life plan (2026-09-06)

The user's list of what Photoshop / Krita have and the node lacked, built in
this order (each package committed and browser-tested on its own):

1. **Canvas extension by dragging applies on release** and is undoable
   (undo kind `canvas`: base, size, selection, shallow layer copies). Done.
2. **Layers**: rename (double-click), duplicate (Ctrl+J), merge down
   (Ctrl+E), thumbnails, drag reorder, lock / alpha lock, Alt+eye solo,
   Ctrl+click on the canvas selects the layer under the cursor.
3. **Adjustment filter layers** (`inpaint_filters.js`): hue / saturation,
   brightness / contrast, colour balance, curves (custom control via
   `FILTERS[id].control`, param `type: "custom"`), gaussian blur, black &
   white. Built by a subagent in parallel with 2.
4. **Painting**: eyedropper (Alt in brush / I), Shift-click straight lines,
   tablet pressure for size and opacity, bucket fill, gradient tool, then
   smudge, clone stamp and healing brush.
5. **Selection**: magic wand / colour range with tolerance, ellipse, feather,
   move the selection outline, save / restore selections, quick mask mode.
6. **Transform / canvas**: flip, rotate 90°, numeric position / size,
   snapping to canvas edges and centre, centre layer, crop, resize image.
7. **View**: zoom 100%, rotate view, rulers / grid / guides, before-after
   toggle, side-by-side compare, on-canvas text editing, autosave / recovery.
