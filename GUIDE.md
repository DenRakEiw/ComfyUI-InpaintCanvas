# Inpaint Canvas guide

## Overview

Inpaint Canvas is a Krita-style image editor inside a ComfyUI node. One node holds the image, the layers, the selection and the prompt. The selected region leaves the node as a crop, any inpaint chain works on it, and the decoded result is wired back into the same node, where it lands as a new layer. Select the next spot, generate again, and finish the picture with layers, retouch tools and filter layers without leaving ComfyUI.

Open the editor with the **Open editor** button on the node. Esc closes it. While it is open every shortcut belongs to the editor.

## Quick start

1. Add **Inpaint Canvas**, click **Open editor**, load an image: the Load button, Ctrl+V, or drag a file onto the canvas.
2. Wire `crop_image` (plus `crop_mask`, `prompt`, `crop_width` / `crop_height` as your chain needs them) into your inpaint chain, and the decoded image back into `result` (API chain) or `result_local` (local chain).
3. Paint or pick a selection, type a prompt, press **Generate** (Ctrl+Enter).
4. The result comes back as a layer. Keep it, discard it, refine it, select the next region.

Minimal local chain: `crop_image` and `crop_mask` into VAE Encode (for Inpainting), KSampler with `seed` and `denoise` from the node, VAE Decode back into `result_local`. With an API node such as Flux.2, wire `crop_image`, `prompt`, `crop_width` and `crop_height` into it and its image into `result`.

## Selecting

- **Selection brush** (B) adds, Alt subtracts; the deselect brush (D) removes. With *Close loops* on, a stroke that ends where it started fills its inside.
- **Rectangle** (R), **ellipse** (Shift+R), **lasso** (L), **polygon** (Shift+L: click point by point, Enter or a double-click closes). They replace the selection; Shift adds, Alt subtracts, Ctrl keeps rectangles square and ellipses round. Dragging inside an existing selection moves its outline.
- **Magic wand** (W) selects similar colours; tolerance, contiguous and the sample source are in the bar above the canvas.
- **Object selection** (O): hover to see objects (SAM2), click to select, click again to deselect.
- **Select by text**: type "shirt" in the Selection panel and press Go (SAM3 or GroundingDINO + SAM). Empty text uses the prompt.
- **Quick mask** (Q): the paint and erase tools edit the selection, the bucket works like the wand, the selection is shown as a red tint.
- Selection panel: none, invert, marching ants or tint display, selection from the active layer, delete the selected pixels, grow, shrink, feather (soft edge that painting, filling and the mask respect), save selections with the workflow and load them again.
- No selection means the whole image.

## Layers

- Results, paint layers, imported images, text layers and filter layers stack above the base. The panel's **Image** tab holds the list; only the active layer shows its controls, the others are one line each.
- Click a row to activate it, Ctrl+click on the canvas to pick the layer under the cursor. Drag a row's header to reorder, Ctrl+] / Ctrl+[ move it, Ctrl+J duplicates, Ctrl+E merges it into the layer below (the bottom layer into the base), Delete removes it, Ctrl+Shift+N adds an empty paint layer. All undoable.
- Each row: thumbnail, eye (Alt+click: solo), name (double-click renames), lock, alpha lock (paint lands only on existing pixels), opacity, blend mode, colour match against the image below, and the mask row: cutout with the installed RMBG models, mask from selection, edit, apply, remove.
- The badge on a row switches a layer between *image* (part of the picture) and *reference* (not in the picture, sent along with `crop_image` as an extra batch image for Flux.2 / Kontext multi-reference editing). The Role select turns a layer into a control image (scribble, lineart, depth, pose, canny) that comes out of `control_image`.
- Drop an image on the canvas to add it as a layer (Shift: reference, Ctrl: replace the base). An image pasted from the clipboard becomes a layer too.
- Flatten bakes all visible layers into the base.

## Painting and retouch

- **Paint** (P) and **erase** (E): size, hardness and opacity in the bar above the canvas, Alt+click picks a colour, Shift+click draws a straight line from the last stroke's end, a pen's pressure scales the size. On the base a paint layer is created for you. With a selection present, strokes stay inside it.
- **Eyedropper** (I), **bucket** (G) with tolerance and contiguous, **gradient** (Shift+G) linear or radial, colour to transparent, white or black.
- **Smudge** (Shift+S) drags pixels along the stroke, with a strength slider: the tool of choice for a hard seam after inpainting. On the base it first makes a copy layer.
- **Clone stamp** (S) and **healing brush** (J): Alt+click sets the source, then paint. The healing brush shifts the copied texture to the colour and brightness of where it lands. *Aligned* keeps the offset between strokes.
- Ctrl+C copies the selection from the active layer (Ctrl+Shift+C from the merged image), Ctrl+X cuts, Ctrl+V pastes as a new layer.

## Text

**Text** (Shift+T): click on the canvas to add a text layer, double-click a text layer to edit it right there (Enter applies, Shift+Enter is a new line, Esc cancels). The layer panel holds text, font, size, colour, bold, italic, alignment, line height, letter spacing and outline. 17 open-source fonts are bundled; the + next to the font list uploads your own .ttf / .otf / .woff files, which stay available. Text layers are pixel layers for everything else: move, scale, rotate, mask, blend them.

## Transform and canvas

- **Transform** (T): drag inside to move, corners scale (Shift: free aspect), edges scale one axis, drag just outside a corner to rotate (Shift snaps to 15°). Rotate, distort (four corners) and warp (grid) preview live and are baked with Enter. The bar also has numeric X / Y / W / H, flip, rotate 90° and centre. While moving, the layer snaps to the canvas edges, centre and guides (Alt: free).
- **Canvas tool** (C): the canvas as a frame. Drag its edges outward to extend (outpainting), inward to crop; it applies when you release, Ctrl+Z takes it back. Extending bakes the visible image into a new base and selects the new border; the Border fill decides what the model sees there. The Canvas section does the same with numbers and can resize the whole image.

## Filter layers

The fx button in the Layers header adds a filter layer. It filters everything below it, non-destructively, with a mask to limit where it applies: film grain with 46 stock presets (Portra, Kodachrome, Tri-X, Cinestill, ...) and real grain plates, sharpen, gaussian blur, levels, curves, brightness / contrast, hue / saturation, colour balance, black & white, invert, LUT (.cube) and vignette. Filters are part of what your chain sees, of flatten and of the saved image.

## Prompt and upsampling

The Prompt field is the node's `prompt` output. **Upsample** (Ctrl+U) rewrites it with a local vision-language model (Qwen3-VL) or Gemini, looking at the crop with the selection marked. The use case (auto, edit, fill, add, remove, outpaint) decides the shape of the text: an edit instruction for Flux.2 / Kontext by default. Revert puts the old prompt back.

## Generate

- **API / Local** switch: only the chain of the chosen mode runs; a paid API node stays idle while you work locally. Both modes have their own result input.
- **Denoise** (local mode) and **seed** (random or fixed) are node outputs. **Refine** sets denoise to 0.5 with a plain mask and no fill, for a second pass over a result.
- **Negative prompt** is the `negative` output.
- **Settings**: wire one of the eight setting outputs into any widget (LoRA name, checkpoint, steps, ...) and a matching control appears in the panel, so the graph is steered from inside the editor.
- **History** lists every result with its mode, seed and prompt. Click a thumbnail to show only that result; Compare shows two results side by side with a divider.
- Helper prompts (segmentation, upsampling) run at the front of the queue with only the model nodes they need; your generation chain is never triggered by them.

## Crop settings

- **Context** (auto or manual padding) and **feather** (auto or manual) come from the selection size; the Crop panel shows the resulting crop and edge values.
- **Fill** decides what the masked area looks like before the model sees it: none, grey, average colour, green (edit models), black, noise. *With original* sends the untouched crop as a second batch image.
- **Colour match** shifts the result towards the surroundings when it is stitched back, **Align** corrects small offsets and scale differences, **Paste** chooses between the selection only (soft edge along the selection) and the whole returned rectangle (keeps an edit model's result intact).
- `target_size` and `multiple_of` on the node control the crop's emitted size; 0 keeps the native size.

## Export

The **Export** section in the Image tab and the Save button (Ctrl+S) write the visible image, filters applied, control and reference layers left out, into ComfyUI's output folder. PNG carries the workflow, JPEG and WebP are smaller, **PSD** and **ORA** (Krita / GIMP) keep the layers. Layer saves the active layer with transparency, Mask the selection as a black and white PNG, Download hands the file to the browser as well. Clean up files removes the node's own working files that no workflow uses.

## View and shortcuts

- Wheel zooms, Space or the middle mouse pans, F fits, 1 shows 100 %, 4 / 6 rotate the view, 5 resets. Rulers (Ctrl+Shift+R, drag guides out of them), grid (Ctrl+Shift+G) and before / after (hold \) are in the top bar.
- Undo Ctrl+Z, redo Ctrl+Shift+Z. Clear selection Ctrl+D, invert Ctrl+I, fill the selection Shift+F, generate Ctrl+Enter, save Ctrl+S.
- Tools: B R L O D P E T H C I G S J W Q, with Shift for the second tool of a group (Shift+R ellipse, Shift+L polygon, Shift+G gradient, Shift+S smudge, Shift+T text). The tool column groups related tools: left-click picks the shown tool, right-click, holding or the small triangle opens the group.
