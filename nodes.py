"""Inpaint Canvas for ComfyUI.

Two nodes:

* ``InpaintCanvas`` - a layered canvas edited in a full-window editor opened
  from the node. The user loads an image, paints a selection, and the node
  emits the selected region (plus context padding, optionally upscaled) as
  IMAGE/MASK for a normal inpainting chain. The decoded result can be wired
  straight back into the node's ``result`` input. That link would be a cycle
  for ComfyUI, so the frontend strips it from the prompt and passes the source
  as ``result_source`` instead. On execution the canvas node then expands an
  ephemeral ``InpaintCanvasStitch`` node that pulls the result in, downscales
  it to the original region, feathers the edges and hands the patch back to
  the frontend, which adds it as a new layer.

* ``InpaintCanvasStitch`` - the stitch step as a standalone node, usable
  explicitly as well.
"""

import json
import os
import time

import numpy as np
import torch
from PIL import Image, ImageFilter

import comfy.utils
import folder_paths
from comfy_execution.graph_utils import GraphBuilder

SUBFOLDER = "inpaint_canvas"


# ---------------------------------------------------------------------------
# file helpers
# ---------------------------------------------------------------------------

def _dir_for_type(kind):
    if kind == "output":
        return folder_paths.get_output_directory()
    if kind == "temp":
        return folder_paths.get_temp_directory()
    return folder_paths.get_input_directory()


def _ref_path(ref):
    """Resolve a {filename, subfolder, type} reference to an absolute path."""
    if not ref or not ref.get("filename"):
        raise ValueError("Inpaint Canvas: no image reference given")
    base = _dir_for_type(ref.get("type", "input"))
    sub = os.path.normpath(ref.get("subfolder", "") or "")
    if sub == ".":
        sub = ""
    path = os.path.abspath(os.path.join(base, sub, ref["filename"]))
    if os.path.commonpath((os.path.abspath(base), path)) != os.path.abspath(base):
        raise ValueError("Inpaint Canvas: reference outside of the ComfyUI directories")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Inpaint Canvas: file not found: {path}")
    return path


def _load_rgb(ref):
    """Load an image reference as a [1, H, W, 3] float tensor."""
    img = Image.open(_ref_path(ref)).convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None]


def _load_mask(ref, height, width):
    """Load a mask reference as a [H, W] float tensor (white = selected)."""
    if not ref or not ref.get("filename"):
        return torch.zeros((height, width), dtype=torch.float32)
    img = Image.open(_ref_path(ref)).convert("L")
    if img.size != (width, height):
        img = img.resize((width, height), Image.BILINEAR)
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)


def _blur_mask(mask, radius):
    """Gaussian blur of a [H, W] mask via PIL. Radius 0 returns the input."""
    if radius <= 0:
        return mask
    img = Image.fromarray((mask.clamp(0, 1).numpy() * 255).astype(np.uint8), "L")
    img = img.filter(ImageFilter.GaussianBlur(radius))
    return torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)


def _resize_image(image, width, height, crop="disabled"):
    """Lanczos resize of a [B, H, W, C] tensor. ``crop="center"`` keeps the aspect
    ratio by center-cropping instead of distorting."""
    if image.shape[2] == width and image.shape[1] == height:
        return image
    out = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "lanczos", crop)
    return out.movedim(1, -1).clamp(0, 1)


def _resize_mask(mask, width, height):
    if mask.shape[1] == width and mask.shape[0] == height:
        return mask
    out = torch.nn.functional.interpolate(mask[None, None], size=(height, width), mode="bilinear", align_corners=False)
    return out[0, 0].clamp(0, 1)


def _state_from_prompt(prompt, unique_id):
    node = (prompt or {}).get(str(unique_id), {})
    inputs = node.get("inputs", {})
    raw = inputs.get("canvas_state", "") or "{}"
    try:
        state = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except json.JSONDecodeError:
        state = {}
    result_source = inputs.get("result_source", "") or ""
    return state, result_source


def _selection_bbox(mask, padding):
    """Bounding box of the selection expanded by ``padding``, clamped to the image."""
    h, w = mask.shape
    ys, xs = torch.nonzero(mask > 0.5, as_tuple=True)
    if ys.numel() == 0:
        return 0, 0, w, h
    x0 = max(0, int(xs.min()) - padding)
    y0 = max(0, int(ys.min()) - padding)
    x1 = min(w, int(xs.max()) + 1 + padding)
    y1 = min(h, int(ys.max()) + 1 + padding)
    return x0, y0, x1, y1


def _fit_span_to_multiple(a0, a1, limit, m):
    """Grow [a0, a1) symmetrically so its length is a multiple of ``m``, staying
    inside [0, limit). If the image is too small for the next multiple, use the
    largest multiple that fits."""
    size = a1 - a0
    target = -(-size // m) * m
    if target > limit:
        target = (limit // m) * m
        if target <= 0:
            return a0, a1
    extra = target - size
    a0 -= extra // 2
    a1 = a0 + target
    if a0 < 0:
        a1 -= a0
        a0 = 0
    if a1 > limit:
        a0 -= a1 - limit
        a1 = limit
    return max(0, a0), a1


# ---------------------------------------------------------------------------
# nodes
# ---------------------------------------------------------------------------

class InpaintCanvas:
    """Layered canvas with selection tools. Emits the selected region for inpainting
    and takes the inpainted result back in as a new layer."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "padding": ("INT", {"default": 64, "min": 0, "max": 4096, "step": 8,
                                    "tooltip": "Context pixels added around the selection before cropping."}),
                "target_size": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 8,
                                        "tooltip": "Longest side of the emitted crop. 0 keeps the native size."}),
                "feather": ("INT", {"default": 16, "min": 0, "max": 512, "step": 1,
                                    "tooltip": "Blur radius applied to the selection edge when the result is stitched back."}),
                "multiple_of": ("INT", {"default": 64, "min": 1, "max": 256, "step": 1,
                                        "tooltip": "crop_image width and height are made a multiple of this (Flux wants 64)."}),
            },
            "optional": {
                "result": ("IMAGE", {"lazy": True,
                                     "tooltip": "Wire the decoded inpaint result here. It is stitched back into the canvas as a new layer."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "MASK", "STRING", "INT", "INT", "STRING", "IMAGE")
    RETURN_NAMES = ("crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image")
    OUTPUT_TOOLTIPS = (
        "Selected region plus padding, scaled to target_size. Inpaint this.",
        "Selection mask matching crop_image.",
        "The flattened canvas at full size.",
        "Selection mask at full size.",
        "Stitch parameters for a standalone Inpaint Canvas Stitch node.",
        "Width of crop_image. Wire it into generators that need an explicit size.",
        "Height of crop_image.",
        "The prompt typed into the editor.",
        "Layers marked as control (scribble, lineart, depth, pose) on black, cropped and scaled exactly like crop_image. Feed it to ControlNet.",
    )
    FUNCTION = "run"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True
    DESCRIPTION = ("Krita-style inpainting inside ComfyUI: load an image, paint a selection, "
                   "inpaint the emitted crop with any nodes you like, and wire the result back "
                   "into this node. Each result lands on the canvas as a new layer.")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-run. The stitch of a wired-back result only happens while this
        # node executes, and this node cannot know whether the upstream inpaint
        # chain (seed, prompt, ...) changed. Running it is cheap.
        return float("nan")

    def run(self, padding=64, target_size=1024, feather=16, multiple_of=64, prompt=None, unique_id=None, **kwargs):
        state, result_source = _state_from_prompt(prompt, unique_id)
        base_ref = state.get("base")
        if not base_ref:
            raise ValueError("Inpaint Canvas: load an image into the canvas first.")

        image = _load_rgb(base_ref)
        height, width = image.shape[1], image.shape[2]
        mask = _load_mask(state.get("mask"), height, width)

        m = max(1, int(multiple_of))
        x0, y0, x1, y1 = _selection_bbox(mask, padding)
        if target_size <= 0:
            # Native size: grow the region itself so the emitted crop is a clean multiple.
            x0, x1 = _fit_span_to_multiple(x0, x1, width, m)
            y0, y1 = _fit_span_to_multiple(y0, y1, height, m)
        crop = image[:, y0:y1, x0:x1]
        crop_mask = mask[y0:y1, x0:x1]

        control_ref = state.get("control")
        if control_ref:
            control = _load_rgb(control_ref)
            if control.shape[1] != height or control.shape[2] != width:
                control = _resize_image(control, width, height)
        else:
            control = torch.zeros_like(image)
        control_crop = control[:, y0:y1, x0:x1]

        if target_size > 0:
            cw, ch = x1 - x0, y1 - y0
            scale = target_size / max(cw, ch)
            nw = max(m, int(round(cw * scale / m)) * m)
            nh = max(m, int(round(ch * scale / m)) * m)
            crop = _resize_image(crop, nw, nh)
            crop_mask = _resize_mask(crop_mask, nw, nh)
            control_crop = _resize_image(control_crop, nw, nh)

        stitch_info = json.dumps({
            "canvas_node": str(unique_id),
            "base": base_ref,
            "mask": state.get("mask"),
            "bbox": [x0, y0, x1 - x0, y1 - y0],
            "feather": int(feather),
            "width": width,
            "height": height,
        })

        outputs = (crop, crop_mask[None], image, mask[None], stitch_info,
                   int(crop.shape[2]), int(crop.shape[1]), str(state.get("prompt", "") or ""),
                   control_crop)

        if result_source:
            src_id, _, src_slot = result_source.partition(":")
            graph = GraphBuilder()
            graph.node("InpaintCanvasStitch",
                       result=[str(src_id), int(src_slot or 0)],
                       stitch_info=stitch_info)
            return {"result": outputs, "expand": graph.finalize()}

        return {"result": outputs}


class InpaintCanvasStitch:
    """Downscale an inpainted crop back to its region, feather the edge and paste it
    onto the canvas. Returns the stitched image and sends the patch to the canvas node."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "result": ("IMAGE", {"tooltip": "The inpainted crop (any size, it is resized to the region)."}),
                "stitch_info": ("STRING", {"forceInput": True,
                                           "tooltip": "stitch_info output of the Inpaint Canvas node."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "stitch"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True

    def stitch(self, result, stitch_info):
        info = json.loads(stitch_info)
        base = _load_rgb(info["base"])
        height, width = base.shape[1], base.shape[2]
        mask = _load_mask(info.get("mask"), height, width)
        x, y, w, h = [int(v) for v in info["bbox"]]
        feather = int(info.get("feather", 0))

        # First image of the batch, RGB only (API nodes may return RGBA).
        src = result[0:1, :, :, :3].cpu().float()
        # Keep the aspect ratio: if the generator returned a different shape,
        # center-crop instead of distorting the content.
        patch = _resize_image(src, w, h, crop="center")[0]

        blend = _blur_mask(mask, feather)[y:y + h, x:x + w]
        blend3 = blend[..., None]

        out = base.clone()
        region = out[0, y:y + h, x:x + w]
        out[0, y:y + h, x:x + w] = region * (1.0 - blend3) + patch * blend3

        # Save the patch as RGBA (alpha = feathered mask) for the canvas layer.
        rgba = torch.cat([patch, blend3], dim=-1)
        rgba_np = (rgba.clamp(0, 1).numpy() * 255).astype(np.uint8)
        out_dir = os.path.join(folder_paths.get_output_directory(), SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"n{info.get('canvas_node', 'x')}_result_{stamp}.png"
        counter = 1
        while os.path.exists(os.path.join(out_dir, filename)):
            filename = f"n{info.get('canvas_node', 'x')}_result_{stamp}_{counter}.png"
            counter += 1
        Image.fromarray(rgba_np, "RGBA").save(os.path.join(out_dir, filename), compress_level=4)

        return {
            "ui": {
                "inpaint_result": [{
                    "filename": filename,
                    "subfolder": SUBFOLDER,
                    "type": "output",
                    "x": x, "y": y, "width": w, "height": h,
                    "canvas_node": info.get("canvas_node"),
                }],
            },
            "result": (out,),
        }


class InpaintCanvasLoadRef:
    """Load an image by a {filename, subfolder, type} reference. Used by the editor's
    helper prompts (text segmentation) because LoadImage only accepts top-level files."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ref": ("STRING", {"default": "", "multiline": False,
                                   "tooltip": "JSON {filename, subfolder, type} of a file in the ComfyUI input/output/temp directories."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load"
    CATEGORY = "image/inpaint"

    @classmethod
    def IS_CHANGED(cls, ref=""):
        try:
            return os.path.getmtime(_ref_path(json.loads(ref)))
        except Exception:
            return float("nan")

    def load(self, ref=""):
        return (_load_rgb(json.loads(ref)),)


class InpaintCanvasMaskOut:
    """Hand a mask back to the canvas editor (text segmentation) or, with purpose
    "segments", a whole mask batch encoded as an object label map (hover selection)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK",),
                "canvas_node": ("STRING", {"default": "", "tooltip": "Id of the Inpaint Canvas node that asked for the mask."}),
                "purpose": ("STRING", {"default": "segment"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True

    def send(self, mask, canvas_node="", purpose="segment"):
        out_dir = os.path.join(folder_paths.get_temp_directory(), SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        filename = f"n{canvas_node or 'x'}_{purpose}_{time.strftime('%H%M%S')}_{int(time.time() * 1000) % 1000:03d}.png"
        info = {"filename": filename, "subfolder": SUBFOLDER, "type": "temp", "canvas_node": canvas_node, "purpose": purpose}
        m = mask.detach().cpu().float().clamp(0, 1)
        if m.dim() == 2:
            m = m[None]
        if purpose == "segments":
            # Object map for the editor's hover selection: every mask of the batch
            # becomes one label, small objects are painted over large ones so the
            # smallest object under the cursor wins. Label id = R + 256 * G, 0 = none.
            binary = m > 0.5
            areas = binary.flatten(1).sum(dim=1)
            order = torch.argsort(areas, descending=True)
            labels = np.zeros((m.shape[1], m.shape[2]), dtype=np.uint16)
            count = 0
            for idx in order.tolist():
                if areas[idx] <= 0:
                    continue
                count += 1
                labels[binary[idx].numpy()] = count
            rgb = np.zeros((labels.shape[0], labels.shape[1], 3), dtype=np.uint8)
            rgb[..., 0] = labels & 255
            rgb[..., 1] = labels >> 8
            Image.fromarray(rgb, "RGB").save(os.path.join(out_dir, filename), compress_level=1)
            info.update({"width": int(labels.shape[1]), "height": int(labels.shape[0]), "count": int(count)})
            return {"ui": {"inpaint_mask": [info]}}
        merged = m.max(dim=0).values if m.shape[0] > 1 else m[0]
        arr = (merged.numpy() * 255).astype(np.uint8)
        Image.fromarray(arr, "L").save(os.path.join(out_dir, filename), compress_level=1)
        info.update({"width": int(arr.shape[1]), "height": int(arr.shape[0]), "coverage": float(merged.mean())})
        return {"ui": {"inpaint_mask": [info]}}


class InpaintCanvasObjectMap:
    """Find every object in an image with SAM2's automatic mask generator and hand the
    editor an object label map for its hover selection tool.

    `sam2_model` comes from ComfyUI-segment-anything-2 (Kijai), loaded with segmentor
    "automaskgenerator". The label map is an RGB PNG with id = R + 256 * G, 0 = no
    object; small objects are painted over large ones so the smallest object under
    the cursor wins. Kijai's own auto-segmentation node only outputs the union mask."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sam2_model": ("SAM2MODEL",),
                "image": ("IMAGE",),
                "canvas_node": ("STRING", {"default": "", "tooltip": "Id of the Inpaint Canvas node that asked for the objects."}),
                "points_per_side": ("INT", {"default": 32, "min": 8, "max": 64, "tooltip": "Sampling grid; more points find smaller objects and take longer."}),
                "pred_iou_thresh": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01}),
                "stability_score_thresh": ("FLOAT", {"default": 0.92, "min": 0.0, "max": 1.0, "step": 0.01}),
                "min_area": ("FLOAT", {"default": 0.0002, "min": 0.0, "max": 0.5, "step": 0.0001, "tooltip": "Objects smaller than this fraction of the image are dropped."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True

    def run(self, sam2_model, image, canvas_node="", points_per_side=32, pred_iou_thresh=0.8, stability_score_thresh=0.92, min_area=0.0002):
        from contextlib import nullcontext
        import comfy.model_management as mm

        if sam2_model.get("segmentor") != "automaskgenerator":
            raise ValueError("Load the SAM2 model with segmentor = automaskgenerator for the object map.")
        model = sam2_model["model"]
        device = sam2_model["device"]
        dtype = sam2_model["dtype"]
        model.points_per_side = int(points_per_side)
        model.points_per_batch = 64
        model.pred_iou_thresh = float(pred_iou_thresh)
        model.stability_score_thresh = float(stability_score_thresh)
        model.stability_score_offset = 1.0
        model.crop_n_layers = 0
        model.box_nms_thresh = 0.7
        model.min_mask_region_area = 0
        model.use_m2m = False
        model.mask_threshold = 0.0
        model.predictor.model.to(device)

        img_np = (image[0:1].contiguous() * 255).byte().cpu().numpy()[0]
        H, W = img_np.shape[:2]
        ctx = torch.autocast(mm.get_autocast_device(device), dtype=dtype) if not mm.is_device_mps(device) else nullcontext()
        with ctx:
            results = model.generate(img_np)

        min_px = max(1, int(min_area * H * W))
        results = [r for r in results if int(r.get("area", r["segmentation"].sum())) >= min_px]
        results.sort(key=lambda r: int(r.get("area", r["segmentation"].sum())), reverse=True)
        labels = np.zeros((H, W), dtype=np.uint16)
        for i, r in enumerate(results):
            labels[np.asarray(r["segmentation"], dtype=bool)] = i + 1
        rgb = np.zeros((H, W, 3), dtype=np.uint8)
        rgb[..., 0] = labels & 255
        rgb[..., 1] = labels >> 8

        out_dir = os.path.join(folder_paths.get_temp_directory(), SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        filename = f"n{canvas_node or 'x'}_segments_{time.strftime('%H%M%S')}_{int(time.time() * 1000) % 1000:03d}.png"
        Image.fromarray(rgb, "RGB").save(os.path.join(out_dir, filename), compress_level=1)
        return {"ui": {"inpaint_mask": [{
            "filename": filename, "subfolder": SUBFOLDER, "type": "temp",
            "canvas_node": canvas_node, "purpose": "segments",
            "width": int(W), "height": int(H), "count": len(results),
        }]}}


NODE_CLASS_MAPPINGS = {
    "InpaintCanvas": InpaintCanvas,
    "InpaintCanvasStitch": InpaintCanvasStitch,
    "InpaintCanvasLoadRef": InpaintCanvasLoadRef,
    "InpaintCanvasMaskOut": InpaintCanvasMaskOut,
    "InpaintCanvasObjectMap": InpaintCanvasObjectMap,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintCanvas": "Inpaint Canvas",
    "InpaintCanvasStitch": "Inpaint Canvas Stitch",
    "InpaintCanvasLoadRef": "Inpaint Canvas Load Ref",
    "InpaintCanvasMaskOut": "Inpaint Canvas Mask Out",
    "InpaintCanvasObjectMap": "Inpaint Canvas Object Map",
}
