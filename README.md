# ComfyUI-InpaintCanvas

Krita-style inpainting without leaving ComfyUI. One node holds the image, the
layers, the selection and the prompt. The selected region goes out as a crop,
any inpaint chain works on it, and the result is wired straight back into the
same node, where it lands as a new layer. Select the next spot, generate again.

![The editor: a photo with a text selection, the crop rectangle and the side panel](docs/img/editor.jpg)

Highlights

- Full-window editor with selection brush, rectangle, lasso, loop closing,
  object selection by hovering (SAM2), select by text (SAM3 or GroundingDINO +
  SAM), grow / shrink, layers with blend modes, paint and erase, transform
  with rotate, distort and warp, control layers for ControlNet, outpainting.
- Prompt upsampling with a local vision-language model (Qwen3-VL) or Gemini,
  tuned per use case: fill, add, remove, edit, outpaint.
- Auto context and auto feather derived from the selection size, fill modes
  for the masked area, colour matching when the result is stitched back.
- An API / Local switch with two result inputs: only the chain of the chosen
  mode runs, so a paid API node stays idle while you work locally.
- Denoise, seed, negative prompt and up to eight editor-driven setting outputs
  (LoRA name, checkpoint, steps, anything with a widget) so you can steer the
  graph from inside the editor.
- Helper prompts for segmentation and upsampling run at the front of the
  queue with only the model nodes they need. Your generation chain is never
  triggered by them.

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/DenRakEiw/ComfyUI-InpaintCanvas
```

Restart ComfyUI. The node itself has no extra Python dependencies beyond what
ComfyUI ships (OpenCV is used for the *border* fill when available).

Optional node packs, each enabling one editor feature:

| Feature                   | Node pack                                                   | Models                                                        |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Select by text (default)  | [comfyui-rmbg](https://github.com/1038lab/ComfyUI-RMBG) (SAM3) | `models/sam3/sam3.pt` (downloaded by the node on first use)  |
| Select by text (fallback) | [comfyui_segment_anything](https://github.com/storyicon/comfyui_segment_anything) | GroundingDINO SwinT + SAM in `models/grounding-dino`, `models/sams` |
| Object selection (hover)  | [ComfyUI-segment-anything-2](https://github.com/kijai/ComfyUI-segment-anything-2) | `sam2_hiera_base_plus.safetensors` in `models/sam2`        |
| Prompt upsampling         | [ComfyUI-QwenVL](https://github.com/1038lab/ComfyUI-QwenVL) or ComfyUI's Gemini API node | Qwen3-VL 2B in `models/LLM/Qwen-VL` (downloaded on first use) |

The editor lists only the backends whose nodes are installed.

## Quick start

![The node in a graph with a LoRA loader, a KSampler and the inpaint chain wired back into result](docs/img/graph.jpg)

1. Add **Inpaint Canvas**, click **Open editor**, load an image (button,
   Ctrl+V or drag and drop).
2. Wire `crop_image` (and `crop_mask`, `prompt`, `crop_width` / `crop_height`
   as your chain needs them) into your inpaint chain, and the decoded result
   back into `result` (API chain) or `result_local` (local chain).
3. Paint or pick a selection, type a prompt, press **Generate** (Ctrl+Enter).
4. The result comes back as a new layer. Compare, discard, refine, select the
   next region.

Minimal local chain:

```
Inpaint Canvas ─crop_image──▶ VAE Encode (for Inpainting) ─▶ KSampler ─▶ VAE Decode ─┐
               ─crop_mask───▶                              ▲ seed, denoise            │
               ◀─────────────────────────── result_local ◀────────────────────────────┘
```

With an API node (Flux.2 for example) wire `crop_image`, `prompt`,
`crop_width` and `crop_height` into it and its image output into `result`.
The stitch accepts any size and RGBA; a different aspect ratio is
center-cropped, never distorted.

## The editor

### Selecting

Tools on the left: brush (B), rectangle (R), lasso (L), object selection
(O), deselect brush (D). `[` and `]` change the brush size, the top bar holds
size, hardness, opacity and the paint colour.

- **Close loops** (toggle under the selection tools) works like Photoshop's
  Selection Brush: end a stroke where it started and the inside is filled as
  well. A small gap is bridged with a straight line, a loop against the image
  border counts, and the deselect brush cuts loops out the same way.
- **Object selection (O)**: on first use SAM2 finds every object in the image
  once (a few seconds). Then the object under the mouse lights up in cyan,
  click adds it, click again removes it, Shift always adds, Alt always
  subtracts. Small objects win over the large ones containing them, a face
  over the person. The map refreshes itself when the image changes.

  ![Object selection: the person is selected, the swimsuit is highlighted under the cursor](docs/img/object-hover.jpg)

- **Select by text**: type what you want ("shirt", "hair", "the red car"),
  press Go or Enter, and the mask comes back as the selection in the chosen
  mode (Replace, Add, Subtract). Leave the field empty and press Go with a
  prompt written below: the language model names the object the prompt is
  about ("roter Seiden-Badeanzug" gives "bathing suit"), that term is
  segmented and shown in the field. *Threshold*: lower finds more. *HQ*
  (GroundingDINO + SAM only) uses the large SAM model.
- **Source**: what the segmentation models look at. *image* is the flattened
  visible layers, exactly what your chain sees. *active layer* shows the model
  only that layer on neutral grey and clips the result to its pixels, so you
  can pick objects inside a result or paint layer without the base
  interfering. Applies to both select by text and object selection.
- **Grow / Shrink** by n pixels (exact distance transform), **From layer**
  takes the opaque area of the active layer. Clear (Ctrl+D), invert (Ctrl+I).

### Layers

- Paint (P) and erase (E) on the active layer; painting on the base creates a
  paint layer automatically, the base itself is never erased. Fill the
  selection with the colour (Shift+F). Soft brushes stamp radial dabs, opacity
  applies per stroke.
- **Transform (T)** has four modes in the bar above the canvas. *Scale*: drag
  inside to move, corners scale proportionally (Shift for free aspect), edge
  handles scale one axis, arrow keys nudge (Shift: 10 px). *Rotate*: drag
  around the centre or type an angle (Shift snaps to 15°). *Distort*: drag the
  four corners (perspective). *Warp*: bend the layer with a 3 to 6 point grid.
  Rotate, distort and warp preview live and are baked with Enter or Apply, Esc
  cancels, undo restores the layer completely.
- The layer list (right): click to activate, toggle visibility, opacity, blend
  mode (multiply, screen, overlay, ...), move up / down, delete (Delete key),
  plus button for an empty paint layer (Ctrl+Shift+N). Flatten bakes all
  visible layers into the base.
- **Control layers**: give a layer a role (scribble, lineart, depth, pose,
  canny, other). Such layers are left out of the image your chain sees and
  instead composited on black into the `control_image` output, cropped and
  scaled exactly like `crop_image`. Feed it to ControlNet.
- **Reference layers** (Flux.2 / Kontext multi-reference editing): the image
  button in the Layers header uploads one or more files as layers with the
  role *reference* (dropping files onto the layer list, or onto the canvas
  with Shift, does the same). Reference layers are shown on the canvas with a
  cyan frame and their batch number, but they are not part of the image your
  chain sees. Instead they go out as one IMAGE batch on `reference_images`,
  top of the list first, at their native resolution (cutout masks applied,
  transparency on white). Wire that batch into the Flux.2 API node's
  `images` / `image_1` input; the node flattens batches, so one link carries
  all references. Any layer can be turned into a reference through its role
  select, and a hidden reference layer is left out of the batch. *References*
  in the Canvas section sets the long side (0 = native) and how images of
  different sizes become one batch: *pad* with the image's border colour,
  *crop* to cover, or *stretch*.
- **Layer masks and cutouts** (Krita's transparency masks, LayerForge's
  background removal): every layer row has a mask row. *Cutout* runs one of
  the installed background removal nodes on the layer (comfyui-rmbg's
  RMBG-2.0, BiRefNet or BEN2, or BRIA RMBG 1.4; the model select shows up on
  the active layer) and turns the result into a transparency mask, so a
  product shot or a pasted photo becomes a cutout without touching its pixels.
  *Mask from selection* keeps only the selected part visible. With a mask
  present, the pencil toggle switches the paint (reveal) and erase (hide)
  tools onto the mask, Shift+F reveals the selection; the check applies the
  mask to the pixels, the trash removes it. Masks are undoable, survive a
  reload, and are respected by *From layer*, the segmentation source *active
  layer*, the reference batch and the run image.

### Prompt and upsampling

The prompt field is stored with the workflow and leaves the node on the
`prompt` output. **Upsample** (Ctrl+U) lets a vision-language model rewrite a
short request (any language) into a proper English prompt. It sees the crop
with the selection outlined in magenta (solid green when Fill is green) and
writes for the chosen **use case**:

| Use case   | What it writes                                                              |
| ---------- | --------------------------------------------------------------------------- |
| fill       | what the area should show, matching materials, lighting and perspective    |
| add        | a new object with scale, contact shadows and the scene's lighting          |
| remove     | only the background that should appear, never naming the object            |
| edit       | one verb-first instruction for editing models (Flux.2, Kontext, Klein): the requested change with its exact colours and materials, then what stays unchanged |
| outpaint   | the scene continued beyond the border                                      |
| auto       | outpaint when the selection touches the border, edit otherwise             |

When the selection came from select by text, the model is also told what the
outline contains. **Revert** brings the previous prompt back. Backends:
Qwen3-VL 2B locally (short English requests are the most reliable; German
requests occasionally lose a word, so read the result), Qwen3-VL 4B
(downloaded on first use, about 8 GB, better at *remove* and at translating),
or Gemini through ComfyUI's API node.

### Generate: API or local, denoise, seed, refine

![Local mode: denoise, seed, refine, negative prompt and the settings driven from the editor](docs/img/local-settings.jpg)

- The **api / local** switch next to Generate says which chain the result
  comes back from: *api* uses the `result` input, *local* the `result_local`
  input. Only the chain wired to the selected input runs. When only one of the
  two inputs is wired, that one is used whatever the mode says, and the Crop
  panel says so ("only input wired"); it warns when nothing is wired at all.
- **Denoise** (a slider, local mode: 1.0 repaints the selection, lower
  values refine what is there) and **Seed** with a *random* toggle and a dice
  button leave the node on the `denoise` and `seed` outputs. Wire them into
  your sampler.
- Local mode adds **Refine**: the selection goes to the sampler as a plain,
  unfeathered mask without fill, the seam still blends softly when stitching.
  Switching it on drops denoise to 0.5 if it was at 1. The auto feather also
  scales with denoise in local mode, so a gentle refine gets a narrower
  transition than a full repaint.
- Local mode shows a **negative prompt** field under the prompt (`negative`
  output, for SDXL-class models).

### Settings driven from the editor

The node ends with `setting 1 (free)`. Wire it into any widget input of
another node, a LoRA loader's `lora_name`, a checkpoint name, `steps`, `cfg`,
a sampler name, and the next free setting output appears, up to eight. The
editor's Settings section shows a matching control for each connected one: a
drop-down with the model list, a number field, a checkbox or a text field. It
starts from the value the widget had when you connected it, so nothing changes
until you touch it, and edits are pushed to the widget right away. The values
travel with the canvas in the workflow.

### Crop settings

The dashed rectangle on the canvas is the crop that will be emitted: the
selection's bounding box plus context. The Crop panel shows its size, the
size that actually leaves the node, and four settings stored with the canvas:

- **Context** *auto* sizes the context from the selection (6 % of the
  selection diagonal plus the feather plus 4 px) and never emits a crop
  smaller than 512 px on a side when the image allows it. Small fixes get a
  tight crop, large selections get room. *manual* uses the `padding` widget.
- **Feather** *auto* derives the mask edge from the selection size the way
  the Krita AI plugin does: feather 10 % of the diagonal (at least 32 px), a
  4 px hard grow plus half the feather, a blend of at most 25 px for the
  composite. `crop_mask` is then the grown and feathered mask, and the stitch
  keeps the result fully opaque inside your selection with a soft transition
  outside it. *manual* emits the raw selection and blurs the edge by the
  `feather` widget at stitch time.
- **Fill** changes what the model sees inside the selection in `crop_image`
  (the canvas itself is untouched): *neutral* the average colour of the
  surroundings, *blur* the surroundings smeared into the area, *border* an
  OpenCV border fill plus smear, *green* pure green with a hard edge for edit
  models that are told to "fill the green area". Use one of these when the
  model keeps the old content instead of replacing it.
- **Original** (with a fill mode) sends the untouched crop along: `crop_image`
  becomes a batch of two, the filled crop first, the original second. An edit
  model that only gets a green head sees hair from behind and paints the back
  of a head; with the original next to it, it knows what is under the green.
  The Flux.2 API node flattens the batch into two input images. Not meant for
  VAE Encode chains, which would encode both.
- **Color match** matches the result's colours and brightness to the ring
  around the selection when it is stitched back, so results that come back
  with a colour shift leave no visible seam.

Workflows saved before these settings existed load with manual context, manual
feather, no fill and no colour match, so nothing changes for them.

### Outpainting

The Canvas section extends the canvas on any side. The visible image is baked
into the new base and the border becomes the selection. **Border** chooses
what fills it before the model sees it: the image's average colour (default),
neutral grey, green for edit models, black, random noise for latent models, or
stretched edge pixels. Press Generate to fill it; the *outpaint* use case of
the upsampler writes the matching prompt. Control and reference layers survive
the extension.

### Cleaning up files

Uploads, results and helper masks accumulate in `input/inpaint_canvas`,
`output/inpaint_canvas` and `temp/inpaint_canvas`. **Clean up files** in the
Canvas section deletes what nothing uses any more: files referenced by an open
editor, an open workflow tab, the browser's stored workflows or any saved
workflow (every `.json` under ComfyUI's `user` directory) are kept, and so is
anything younger than two minutes. You see the counts and sizes and confirm
before anything is deleted. Discarded history results whose files are gone
can no longer be restored. Helper results in `temp/inpaint_canvas` older than
an hour are pruned automatically on the next helper run.

### History

![A result came back as a layer and shows up in the history with mode, seed and prompt](docs/img/result.jpg)

Every result is listed with a preview, the prompt it was made with, the mode
and the seed. Click a preview (or the solo button) to show only that result,
discard one to remove its layer, restore a discarded one later, click the seed
line to reuse that seed. The trash icon in the header clears the list; layers
and files stay.

### Keyboard

| Keys                         | Action                                   |
| ---------------------------- | ---------------------------------------- |
| B, R, L, O, D                | selection brush, rectangle, lasso, object, deselect |
| P, E, T, H                   | paint, erase, transform, hand            |
| `[` `]`                      | brush size                               |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | undo, redo                               |
| Ctrl+D, Ctrl+I               | clear, invert selection                  |
| Shift+F                      | fill selection with colour               |
| Ctrl+Shift+N, Delete         | new paint layer, delete active layer     |
| Ctrl+U                       | upsample prompt                          |
| Ctrl+Enter                   | generate                                 |
| F                            | fit to view                              |
| Space / middle mouse / right mouse | pan (wheel zooms)                  |
| Esc                          | cancel transform, close editor           |

While the editor is open all shortcuts belong to it: Ctrl+Z undoes the last
editor step, not the workflow.

## Node reference

### Inpaint Canvas (`InpaintCanvas`)

Widgets

| Widget        | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `padding`     | Context pixels around the selection (Context = manual).                     |
| `target_size` | Longest side of the emitted crop. 0 keeps the native size.                  |
| `feather`     | Blur radius of the selection edge at stitch time (Feather = manual).        |
| `multiple_of` | Crop width and height are made a multiple of this. Flux wants 64.           |

With `target_size` set, the scaled crop is rounded to the multiple. With
`target_size` 0 the region itself is grown symmetrically until it is a multiple.

Inputs (both optional, both lazy)

- `result`: the result of your API chain (editor mode *api*).
- `result_local`: the decoded result of your local chain (editor mode *local*).

Outputs

| Output                       | Content                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `crop_image` / `crop_mask`   | the region to inpaint, scaled, with fill and grown / feathered mask applied when on; with **Original** on and a fill mode, `crop_image` is a batch of two (filled, untouched) |
| `image` / `mask`             | the flattened canvas and the raw selection at full size                 |
| `stitch_info`                | parameters for the standalone stitch node                               |
| `crop_width` / `crop_height` | size of `crop_image`, for generators that take an explicit size         |
| `prompt` / `negative`        | the editor's prompt fields                                              |
| `control_image`              | control layers on black, aligned with `crop_image` (black if none)      |
| `denoise` / `seed` / `mode`  | the Generate settings (`mode` is "api" or "local")                      |
| `setting_1` ... `setting_8`  | wildcard outputs driven from the editor's Settings section              |
| `reference_images`           | the visible reference layers as one IMAGE batch, top of the list first; an empty batch without any |

Only ever appended, so saved workflows keep working. The node shows only the
connected setting slots plus one free one, with `reference_images` right after
them; the visible slot is mapped to the backend slot when the prompt is queued.

### Inpaint Canvas Stitch (`InpaintCanvasStitch`)

The stitch step as an explicit node: `result` + `stitch_info` in, the stitched
full image out. You only need it when you do not want the back-link on the
canvas node. Its result is still delivered to the canvas as a layer.

### Helper nodes

Used by the editor's helper prompts; you can also wire them yourself.

- `Inpaint Canvas Load Ref`: loads an image by a `{filename, subfolder, type}`
  JSON reference.
- `Inpaint Canvas Mask Out`: hands a MASK back to the editor (optional `label`
  text is echoed along; purpose `cutout` delivers a layer mask).
- `Inpaint Canvas Object Map`: runs SAM2's automatic mask generator (model
  from Kijai's `DownloadAndLoadSAM2Model` with segmentor `automaskgenerator`)
  and hands the editor an object label map.
- `Inpaint Canvas Text Out`: hands a STRING back to the editor.

## How the round trip works

ComfyUI rejects cycles, so the `result` links are never sent to the backend
as links. The frontend removes them from the prompt and passes the source
nodes as `result_source` / `result_source_local`. When the canvas node runs
it expands an ephemeral stitch node that reads from the source of the selected
mode; the other chain is not connected to anything and never executes. The
stitch's UI output is attributed to the canvas node, which is how the layer
arrives without a second visible node. Because the canvas node is an output
node, the chain runs even without a Save Image or Preview Image node.

The canvas node always re-executes: it cannot know whether the upstream chain
changed, and the stitch only happens while it runs.

Files: uploads go to `input/inpaint_canvas/`, stitched patches to
`output/inpaint_canvas/`, helper-prompt results to `temp/inpaint_canvas/`.
Edited layers are uploaded when the editor closes and before every run. The
workflow stores file references, the selection and the settings, not the
pixels of the layers.

## Development

See `DEVELOPMENT.md` for the mechanisms, measurements and test recipes, and
`CLAUDE.md` for the invariants that must not be broken.
