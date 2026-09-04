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
- Tools on the left: brush, rectangle, lasso, eraser, hand. Keys: B, R, L, E, H.
  `[` and `]` change the brush size, the slider at the top does the same.
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z), clear (Ctrl+D), invert (Ctrl+I),
  fit to view (F), flatten all visible layers into the base.
- Mouse wheel zooms. Space, middle mouse, right mouse or the hand tool pans.
- **Generate** (Ctrl+Enter) queues the workflow. The result appears in the
  layer list while the editor stays open. Esc closes it.
- Layers on the right: toggle visibility, change opacity, delete. Turn a result
  off or delete it to reject it, keep it to build on it.

The dashed rectangle is the crop that will be emitted: the selection's bounding
box plus `padding`. The Crop panel shows its size and the size that actually
leaves the node.

Widgets

| Widget        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `padding`     | Context pixels around the selection that go into the crop.                       |
| `target_size` | Longest side of the emitted crop. 0 keeps the native size.                       |
| `feather`     | Blur radius of the selection edge when the result is stitched back.              |
| `multiple_of` | Crop width and height are made a multiple of this. Flux wants 64.                |

With `target_size` set, the scaled crop is rounded to the multiple. With
`target_size` 0 the region itself is grown symmetrically until it is a multiple.

Inputs

- `result` (IMAGE, optional): wire the decoded inpaint result here.

Outputs

- `crop_image` / `crop_mask`: the region to inpaint, already scaled.
- `image` / `mask`: the flattened canvas and the selection at full size.
- `stitch_info`: parameters for the standalone stitch node below.
- `crop_width` / `crop_height`: size of `crop_image`. Wire them into generators
  that take an explicit size (the Flux.2 API node, for example) so the result
  comes back in the same aspect ratio.

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
`output/inpaint_canvas/`. The workflow only stores file references and the
selection, not pixel data of the layers.
