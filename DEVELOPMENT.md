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
`crop_image, crop_mask, image, mask, stitch_info, crop_width, crop_height, prompt, control_image`.
Only ever append outputs; reordering breaks saved workflows.

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
- `fillEnclosedAreas()` = flood fill from the border after a selection brush
  stroke; unreached unselected pixels become selected ("close loops").
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
4. From the Krita plugin analysis (2026-09-05, see chat notes below):
   fill modes before diffusion (blur / neutral / border / green for Flux.2
   edit models), auto grow/feather/blend relative to selection diagonal
   (feather 10 % of diagonal, min 32 px; grow 4 + feather/2; blend ≤ 25),
   auto context padding `max(longest_side/16, avg_selection_side/2)` with a
   512 px minimum and square balancing, color match in the stitch, regions via
   the installed comfyui-tooling-nodes (`ETN_BackgroundRegion`,
   `ETN_DefineRegion`, `ETN_AttentionMask`). Krita is GPL-3: reimplement the
   formulas, do not copy code.
5. Registry publish once the user adds `REGISTRY_ACCESS_TOKEN`.
