# ComfyUI-InpaintCanvas

Krita-style inpainting without leaving ComfyUI. One node holds the image, the
layers and the selection. The selected region goes out as a crop, any inpaint
chain works on it, and the result is wired straight back into the same node.
It comes back downscaled to the original region, feathered at the edge, and
lands on the canvas as a new layer.

## Nodes

### Inpaint Canvas (`InpaintCanvas`)

The node shows a thumbnail. Clicking it (or **Open editor**) opens a
full-window editor.

Editor

- **Load** an image, paste one with Ctrl+V, or drop a file onto the canvas.
- **Select** tools on the left: brush (B), rectangle (R), lasso (L), object
  selection (O), deselect brush (D). The loop toggle below them closes brush
  strokes the way Photoshop's Selection Brush does: end a stroke where it
  started and the inside is filled as well (a small gap is bridged with a
  straight line, a loop against the image border counts, and the deselect
  brush cuts out loops the same way).
- **Object selection (O)**: the first time you pick the tool, SAM2 finds every
  object in the image once (a few seconds). After that, moving the mouse
  highlights the object under the cursor; click adds it to the selection,
  click again removes it, Shift always adds, Alt always subtracts. Small
  objects win over the large ones that contain them (a face over the person).
  The object map is refreshed automatically when the image changes. Needs
  ComfyUI-segment-anything-2 (Kijai) with `sam2_hiera_base_plus` in
  `models/sam2`.
- **Selection** section: grow or shrink by n pixels (exact distance
  transform), or take the selection from the opaque area of the active layer.
- **Select by text**: type what you want ("shirt", "hair", "the red car"),
  press Go or Enter. A small helper prompt runs at the front of the queue
  (only the segmentation nodes, never your generation chain) and the mask
  comes back as the selection: Replace, Add or Subtract. Leave the field
  empty and press Go with a prompt written below: the language model names
  the object the prompt is about ("roter Seiden-Badeanzug" gives "bathing
  suit"), that term is segmented and shown in the field. The HQ toggle only
  applies to GroundingDINO + SAM (large SAM model). Backends, best first:
  SAM3 (comfyui-rmbg's node, weights `models/sam3/sam3.pt`), GroundingDINO
  + SAM (comfyui_segment_anything, HQ toggle picks the large SAM), and the
  core SAM3 nodes (experimental: on the machine this was built on they return
  noise for text prompts). Threshold: lower finds more.
- **Source** (Selection section): what the segmentation models look at.
  *image* is the flattened visible layers, exactly what the inpaint chain
  sees. *active layer* shows the model only that layer on neutral grey and
  clips the result to the layer's pixels, so you can pick objects inside a
  result or paint layer without the base interfering. Applies to both select
  by text and object selection.
- **Layer** tools: paint (P), eraser (E), fill selection with color (Shift+F),
  transform (T), hand (H) to pan. Painting on the base creates a paint layer
  automatically; the base itself is never erased.
- **Transform** has four modes in a small bar above the canvas. *Scale*: drag
  inside to move, corners scale proportionally (Shift for free aspect), the
  round handles in the middle of each edge scale one axis, arrow keys nudge
  (Shift: 10 px). *Rotate*: drag around the center or type an angle (Shift
  snaps to 15°). *Distort*: drag the four corners freely (perspective).
  *Warp*: drag the points of a 3–6 grid to bend the layer. Rotate, distort and
  warp preview live and are baked into the layer with Enter or Apply; Esc
  cancels. Undo restores the layer completely.
- Brush **size**, **hardness** (soft edge) and **opacity** sit in the top bar
  next to the color. Opacity applies per stroke, not per dab.
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z) cover selection, strokes and transforms.
  Clear (Ctrl+D), invert (Ctrl+I), fit to view (F), flatten all visible layers.
- `[` and `]` change the brush size.
- Mouse wheel zooms. Space, middle mouse, right mouse or the hand tool pans.
- **Generate** (Ctrl+Enter) queues the workflow. The result appears in the
  layer list while the editor stays open. Esc closes it.
- **Layers** on the right: click to make a layer active, toggle visibility,
  opacity, blend mode (multiply, screen, overlay, ...), control role, move
  up / down, delete (Delete key for the active layer). The plus button adds an
  empty paint layer (Ctrl+Shift+N).
- **Control layers**: give a layer a role (scribble, lineart, depth, pose,
  canny, other). Such layers are excluded from the image that goes to the
  inpaint chain and instead composited on black into the `control_image`
  output, cropped and scaled exactly like `crop_image`. Feed it to ControlNet.
- **Canvas** section: extend the canvas on any side (outpainting). The
  visible image is baked into the new base, edge pixels are stretched into the
  border, and the border becomes the selection. Press Generate to fill it.
- **Prompt**: the text field is stored with the workflow and comes out of the
  node as the `prompt` output.
- **Prompt upsampling**: type a short request (any language) into the prompt
  field, pick a use case and press Upsample (Ctrl+U). A vision-language model
  looks at the crop with the selection tinted red (solid green when Fill is
  green, with the selection marked by a magenta outline) and rewrites the
  request into a proper English prompt: *fill* (what
  the area should show, matching the surroundings), *add* (a new object with
  scale, contact shadows and lighting), *remove* (only the background that
  should appear, never naming the object), *edit* (a verb-first instruction
  for editing models such as Flux.2), *outpaint* (the scene continued beyond
  the border). *auto* picks outpaint when the selection touches the border
  and fill otherwise. When the selection came from "Select by text", the
  model is also told what the outline contains ("it currently contains:
  swimsuit"), which helps especially with *remove*. Revert puts the previous
  prompt back. Backends: Qwen3-VL
  2B locally through ComfyUI-QwenVL (weights in `models/LLM/Qwen-VL`),
  Qwen3-VL 4B (downloaded on first use, about 8 GB, noticeably better at
  *remove* and at translating), or Gemini through ComfyUI's API node. The 2B
  model is reliable with short English requests; German requests sometimes
  lose a word in translation, so check the result. Like the segmentation, it
  runs as a small helper prompt and never triggers your generation chain.
- **History**: every result with a preview and the prompt it was made with.
  Click a preview (or the solo button) to show only that result, discard one
  to remove its layer, restore a discarded one later. The trash icon in the
  section header clears the whole list (after a confirmation); layers and
  files stay, only discarded results can then no longer be restored.

The dashed rectangle is the crop that will be emitted: the selection's bounding
box plus context. The Crop panel shows its size, the size that actually leaves
the node, and holds four settings that travel with the canvas:

- **Context** *auto* (default) sizes the context from the selection: 6 % of
  the selection diagonal plus the feather plus 4 px, and the crop is never
  smaller than 512 px on a side when the image allows it. Small fixes get a
  tight crop, large selections get room. *manual* uses the node's `padding`
  widget.
- **Feather** *auto* (default) derives the mask edge from the selection size
  the way the Krita AI plugin does: feather 10 % of the diagonal (at least
  32 px), a 4 px hard grow plus half the feather, and a blend of at most 25 px
  for the composite. `crop_mask` is then the grown and feathered mask, and the
  stitch keeps the result fully opaque inside your selection with a soft
  transition outside it. *manual* emits the raw selection and blurs the edge
  by the node's `feather` widget at stitch time (the old behaviour).
- **Fill** changes what the model sees inside the selection in `crop_image`
  (the canvas itself is untouched): *neutral* the average colour of the
  surroundings, *blur* the surroundings smeared into the area, *border* an
  OpenCV border fill plus smear, *green* pure green with a hard edge for edit
  models that are told to "fill the green area". Use one of these when the
  model keeps the old content instead of replacing it.
- **Color match** (default on) matches the result's colours and brightness to
  the ring around the selection when it is stitched back, so API results that
  come back with a colour shift do not leave a visible seam.

Workflows saved before these settings existed load with manual context, manual
feather, no fill and no color match, so nothing changes for them.

While the editor is open, all keyboard shortcuts belong to it: Ctrl+Z undoes
the last editor step, not the workflow.

Widgets

| Widget        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `padding`     | Context pixels around the selection that go into the crop (Context = manual).    |
| `target_size` | Longest side of the emitted crop. 0 keeps the native size.                       |
| `feather`     | Blur radius of the selection edge when the result is stitched back (Feather = manual). |
| `multiple_of` | Crop width and height are made a multiple of this. Flux wants 64.                |

With `target_size` set, the scaled crop is rounded to the multiple. With
`target_size` 0 the region itself is grown symmetrically until it is a multiple.

Inputs

- `result` (IMAGE, optional): wire the decoded inpaint result here.

Outputs

- `crop_image` / `crop_mask`: the region to inpaint, already scaled (with the
  fill applied, and the mask grown and feathered, when those are on).
- `image` / `mask`: the flattened canvas and the raw selection at full size.
- `stitch_info`: parameters for the standalone stitch node below.
- `crop_width` / `crop_height`: size of `crop_image`. Wire them into generators
  that take an explicit size (the Flux.2 API node, for example) so the result
  comes back in the same aspect ratio.
- `prompt`: the text from the editor's prompt field.
- `control_image`: the control layers on black, aligned with `crop_image`
  (black if there are none).

### Helper nodes

`Inpaint Canvas Load Ref` loads an image by a `{filename, subfolder, type}`
JSON reference and `Inpaint Canvas Mask Out` hands a MASK back to the editor.
`Inpaint Canvas Object Map` runs SAM2's automatic mask generator (model from
Kijai's `DownloadAndLoadSAM2Model` with segmentor `automaskgenerator`) and
hands the editor an object label map. `Inpaint Canvas Text Out` hands a
STRING back (prompt upsampling). The editor uses them for "Select by text",
object selection and upsampling; you can also wire them yourself.

### Inpaint Canvas Stitch (`InpaintCanvasStitch`)

The stitch step as an explicit node: `result` + `stitch_info` in, the stitched
full image out. You only need it when you do not want to use the back-link on
the canvas node. Its result is still delivered to the canvas as a layer.

If the result has a different aspect ratio than the region, it is center-cropped
rather than distorted. RGBA results are accepted.

## Minimal workflow

```
Inpaint Canvas ─crop_image──▶ VAE Encode (for Inpainting) ─▶ KSampler ─▶ VAE Decode ─┐
               ─crop_mask───▶                                                          │
               ◀──────────────────────────── result ◀──────────────────────────────────┘
```

1. Open the editor, load an image, paint a selection, press Generate.
2. The result appears as "Result 1". Generate again for another variant,
   toggle layers to compare, delete the ones you do not want.
3. Make the next selection on top of the result and repeat. The node flattens
   the visible layers before every run.

## How the back-link works

ComfyUI rejects cycles, so the `result` link is never sent to the backend as a
link. The frontend removes it from the prompt and passes the source node as
`result_source`. When the canvas node runs it expands an ephemeral
`InpaintCanvasStitch` node that reads from that source. Its UI output is
attributed to the canvas node, which is how the layer arrives without a second
visible node. Because the canvas node is an output node, the inpaint chain runs
even if the workflow has no Save Image or Preview Image node.

The canvas node always re-executes. It cannot know whether the upstream chain
changed, and the stitch only happens while it runs.

Files: uploads go to `input/inpaint_canvas/`, stitched patches to
`output/inpaint_canvas/`. Edited layers (paint strokes, erased results) are
uploaded when the editor closes and before every run. The workflow only stores
file references and the selection, not pixel data of the layers.
