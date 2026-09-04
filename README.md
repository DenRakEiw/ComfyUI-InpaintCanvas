# Inpaint Canvas for ComfyUI

Krita-style inpainting without leaving ComfyUI. One node holds the image, the
layers and the selection. The selected region goes out as a crop, any inpaint
chain works on it, and the decoded result is wired straight back into the same
node. It comes back downscaled to the original region, feathered at the edge,
and lands on the canvas as a new layer.

## Nodes

### Inpaint Canvas (`InpaintCanvas`)

The editor lives inside the node.

Toolbar

- **Load** an image (or paste with Ctrl+V, or drop a file on the canvas).
- **Brush / Rect / Lasso / Erase** build the selection. Keys: B, R, L, E.
  `[` and `]` change the brush size.
- **Clear**, **Invert**, **Undo** (Ctrl+Z / Ctrl+Shift+Z).
- **Fit** (F) resets the view. Mouse wheel zooms, middle mouse, right mouse or
  Space + drag pans.
- **Flatten** merges all visible layers into the base layer.

The dashed blue rectangle shows the crop that will be emitted: the selection's
bounding box plus `padding`.

Widgets

| Widget        | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `padding`     | Context pixels around the selection that go into the crop.              |
| `target_size` | Longest side of the emitted crop. 0 keeps the native size.              |
| `feather`     | Blur radius of the selection edge when the result is stitched back.    |

Inputs

- `result` (IMAGE, optional): wire the decoded inpaint result here.

Outputs

- `crop_image` / `crop_mask`: the region to inpaint, already scaled to `target_size`.
- `image` / `mask`: the flattened canvas and the selection at full size.
- `stitch_info`: parameters for the standalone stitch node below.

### Inpaint Canvas Stitch (`InpaintCanvasStitch`)

The stitch step as an explicit node: `result` + `stitch_info` in, the stitched
full image out. You only need it when you do not want to use the back-link on
the canvas node. Its result is still delivered to the canvas as a layer.

## Minimal workflow

```
Inpaint Canvas ─crop_image──▶ VAE Encode (for Inpainting) ─▶ KSampler ─▶ VAE Decode ─┐
               ─crop_mask───▶                                                          │
               ◀──────────────────────────── result ◀──────────────────────────────────┘
```

1. Load an image into the canvas, paint a selection, queue.
2. The result appears as "Result 1" in the layer list. Queue again for another
   variant, toggle layers to compare, delete the ones you do not want.
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

Files: uploads go to `input/inpaint_canvas/`, stitched patches to
`output/inpaint_canvas/`. The workflow only stores file references and the
selection, not pixel data of the layers.
