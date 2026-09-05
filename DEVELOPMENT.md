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
`crop_image, crop_mask, image, mask, stitch_info, crop_width, crop_height, prompt, control_image, denoise, seed, mode`.
Only ever append outputs; reordering breaks saved workflows.

Two result inputs (2026-09-05): `result` (API chain) and `result_local`
(local chain), both lazy and both removed from the prompt by the queuePrompt
wrapper (`result_source`, `result_source_local`). `run()` picks the source
by `canvas_state.gen.mode` and expands the stitch only for that one, so the
other chain is never executed (its nodes are not ancestors of anything once
the back-link is gone). `gen = {mode, denoise, seed, seedRandom}` lives in
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
  layers: [{ id, name, kind: "result"|"paint", role: "none"|"scribble"|...,
             blend: "normal"|"multiply"|..., ref, x, y, w, h, opacity, visible }],
  history: [{ key, name, ref, x, y, w, h, prompt, layerId, time }],
  selection: "data:image/png;base64,...",     // red where selected
  seen: ["subfolder/filename", ...] }          // results already added
```

Prompt-time JSON (what the backend sees, from `serializeForPrompt`):
`{ width, height, base, mask, control, prompt, layers }` where `base` is the
flattened visible non-control layers (or the original ref when no layer is
visible), `mask` the selection as grayscale PNG, `control` the control layers
on black (or null). Files are named `n{nodeId}_{base|mask|control|layer}_{sha1[:12]}.png`
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
- `extendCanvas()` bakes visible non-control layers into a new base (edge
  pixels stretched into the border), keeps control layers (shifted / resized),
  sets the border as selection.
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
- Layer transform is move/scale only (no rotation, no free distortion).
- History thumbnails come from the layer canvas or the output file; discarded
  results keep their file in `output/inpaint_canvas/` forever (no cleanup).
- Uploads accumulate in `input/inpaint_canvas/` (hash-named, deduplicated per
  content, never deleted).
- Very large canvases: `selectionBounds`, flood fill and the distance
  transform are O(W·H) in JS; a 4K canvas takes a few hundred ms per op.
- Painting on a scaled layer paints into its native resolution (fine), but
  brush size is scaled by the average of the two axes.
- No LICENSE file yet (user has not chosen one).

## 9. State at the end of 2026-09-05

Browser-verified on the user's photo (`input/inpaint_canvas/ComfyUI_01940_.png`):
select by text with SAM3 (RMBG), object tool hover / click / toggle / Shift /
Alt with undo, source switch for both, helper prompts only (`/history` shows
`seg_*` and `obj_*` keys, never the main chain). Test recipe for the editor
from the console: build the graph as in section 6, `ed = c.inpaintEditor`,
`ed.setTool("object")`, then dispatch `PointerEvent`s on `ed.canvas` (map
image coords with `ed.view` and the canvas bounding rect; `buttons: 0` for
hover, pointerdown + pointerup at the same spot for a click).

Note: `.p-blockui-mask` can stay in the DOM with size 0x0 after the restore;
check `offsetWidth` rather than existence.

Ideas not done: a "detail" slider for the object tool (points_per_side 48/64
finds smaller parts), showing all object outlines while hovering, SAM3 point
prompts for click-to-segment without the precomputed map (core's point path
works), and cleanup of `temp/inpaint_canvas/`.

## 8. Roadmap (from the user's own Krita list)

Done: control layers, soft brush + opacity, blend modes, outpainting,
grow/shrink/from-layer, history.

Open, in the order suggested:
1. **Regions**: per-layer prompt that applies only inside that layer's alpha.
   Backend: mask outputs per region + string outputs, or a list output.
2. **Refine pass**: re-run a result at low denoise without reselecting
   (probably a "refine" flag in canvas_state that makes `crop_mask` the whole
   patch and a `denoise` hint output).
3. Soft-edged selection (feather preview), brush presets, keyboard color
   picker. (Rotation, distort and warp exist since 2026-09-05.)
4. Regions via the installed comfyui-tooling-nodes (`ETN_BackgroundRegion`,
   `ETN_DefineRegion`, `ETN_AttentionMask`) - only worth it for local models
   (the Flux.2 API takes no conditioning); check first whether the tooling
   nodes support Flux.2 Klein at all. Krita is GPL-3: reimplement, do not copy.
   (Fill modes, auto sizing and color match from the same analysis are done,
   see section 10.)
5. Registry publish once the user adds `REGISTRY_ACCESS_TOKEN`.

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

Color match (`_color_match`): per-channel mean/std transfer in RGB, measured
where the composite keeps the base (`1 - composite mask`, the ring), std ratio
clamped to [0.5, 2], skipped when the ring has < 64 px of weight. Verified on
an inverted patch: ring means moved from (124, 153, 144) to (121, 94, 101)
against a base ring of (130, 102, 111).

Verified via the API (`InpaintCanvas` -> `ImageInvert` -> back, synthetic
1024x768 base with a 120x90 ellipse selection): manual crop 249x219,
auto crop 512x512, all five fill modes visually correct, composite opaque
inside the selection.

## 12. Ideas from the Krita AI plugin not taken yet (2026-09-05)

Looked at `model.py` properties and `settings.py` of the installed plugin
(`%APPDATA%/krita/pykrita/ai_diffusion`). Done here: strength (= denoise),
seed / fixed seed, fill modes, auto grow/feather/padding, color match,
history, control layers, prompt translation (via the upsampler). Not done,
roughly by value for this node:
- Refine workflow (WorkflowKind.refine / refine_region): re-run the selected
  region at denoise < 1 without a mask edge; with the denoise setting this is
  now "lower denoise + Generate", a dedicated button could also set the fill
  to none and skip the mask feather.
- Batch count: N results per Generate, all landing in the history (local
  only; on the API that is N paid calls).
- Styles: presets bundling prompt prefix/suffix, LoRAs (`<lora:name:1.0>`
  syntax parsed out of the prompt), sampler settings; would become string
  outputs here.
- Negative prompt output (SDXL-class local models only).
- Upscale workflow (tiled with refinement, `upscale_tiled`), live mode, and
  regions (attention masks, local models only) are separate projects.
- Strength-scaled selection modifiers (feather * strength) are a five-line
  tweak once refine exists.

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
maps auto to outpaint when the selection touches a canvas edge, else fill.

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
