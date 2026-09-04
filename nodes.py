"""Inpaint Canvas for ComfyUI.

Two nodes:

* ``InpaintCanvas`` - a layered canvas that lives inside the node. The user
  loads an image, paints a selection, and the node emits the selected region
  (plus context padding, optionally upscaled) as IMAGE/MASK for a normal
  inpainting chain. The decoded result can be wired straight back into the
  node's ``result`` input. That link would be a cycle for ComfyUI, so the
  frontend strips it from the prompt and passes the source as ``result_source``
  instead. On execution the canvas node then expands an ephemeral
  ``InpaintCanvasStitch`` node that pulls the result in, downscales it to the
  original region, feathers the edges and hands the patch back to the
  frontend, which adds it as a new layer.

* ``InpaintCanvasStitch`` - the stitch step as a standalone node, usable
  explicitly as well.
"""

import hashlib
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
        raise ValueError("InpaintCanvas: no image reference given")
    base = _dir_for_type(ref.get("type", "input"))
    sub = os.path.normpath(ref.get("subfolder", "") or "")
    if sub == ".":
        sub = ""
    path = os.path.abspath(os.path.join(base, sub, ref["filename"]))
    if os.path.commonpath((os.path.abspath(base), path)) != os.path.abspath(base):
        raise ValueError("InpaintCanvas: reference outside of the ComfyUI directories")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"InpaintCanvas: file not found: {path}")
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


def _resize_image(image, width, height):
    """Lanczos resize of a [B, H, W, C] tensor."""
    if image.shape[2] == width and image.shape[1] == height:
        return image
    out = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "lanczos", "disabled")
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

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("crop_image", "crop_mask", "image", "mask", "stitch_info")
    OUTPUT_TOOLTIPS = (
        "Selected region plus padding, scaled to target_size. Inpaint this.",
        "Selection mask matching crop_image.",
        "The flattened canvas at full size.",
        "Selection mask at full size.",
        "Stitch parameters for a standalone Inpaint Canvas Stitch node.",
    )
    FUNCTION = "run"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True
    DESCRIPTION = ("Krita-style inpainting inside ComfyUI: load an image, paint a selection, "
                   "inpaint the emitted crop with any nodes you like, and wire the result back "
                   "into this node. Each result lands on the canvas as a new layer.")

    @classmethod
    def IS_CHANGED(cls, padding=64, target_size=1024, feather=16, prompt=None, unique_id=None, **kwargs):
        state, result_source = _state_from_prompt(prompt, unique_id)
        if result_source:
            # A result is wired back in, so every queue should produce a fresh stitch.
            return float("nan")
        digest = hashlib.sha256()
        digest.update(json.dumps(state, sort_keys=True).encode("utf-8"))
        digest.update(f"{padding}|{target_size}|{feather}".encode("utf-8"))
        return digest.hexdigest()

    def run(self, padding=64, target_size=1024, feather=16, prompt=None, unique_id=None, **kwargs):
        state, result_source = _state_from_prompt(prompt, unique_id)
        base_ref = state.get("base")
        if not base_ref:
            raise ValueError("Inpaint Canvas: load an image into the canvas first.")

        image = _load_rgb(base_ref)
        height, width = image.shape[1], image.shape[2]
        mask = _load_mask(state.get("mask"), height, width)

        x0, y0, x1, y1 = _selection_bbox(mask, padding)
        crop = image[:, y0:y1, x0:x1]
        crop_mask = mask[y0:y1, x0:x1]

        if target_size > 0:
            cw, ch = x1 - x0, y1 - y0
            scale = target_size / max(cw, ch)
            nw = max(8, int(round(cw * scale / 8)) * 8)
            nh = max(8, int(round(ch * scale / 8)) * 8)
            crop = _resize_image(crop, nw, nh)
            crop_mask = _resize_mask(crop_mask, nw, nh)

        stitch_info = json.dumps({
            "canvas_node": str(unique_id),
            "base": base_ref,
            "mask": state.get("mask"),
            "bbox": [x0, y0, x1 - x0, y1 - y0],
            "feather": int(feather),
            "width": width,
            "height": height,
        })

        outputs = (crop, crop_mask[None], image, mask[None], stitch_info)

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

        patch = _resize_image(result[0:1].cpu().float(), w, h)[0]
        blend = _blur_mask(mask, feather)[y:y + h, x:x + w]
        # Never let the blur leak outside the crop region: keep it zero at the crop border.
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


NODE_CLASS_MAPPINGS = {
    "InpaintCanvas": InpaintCanvas,
    "InpaintCanvasStitch": InpaintCanvasStitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintCanvas": "Inpaint Canvas",
    "InpaintCanvasStitch": "Inpaint Canvas Stitch",
}
