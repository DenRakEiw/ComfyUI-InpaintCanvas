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
import math
import os
import time

import numpy as np
import torch
from PIL import Image, ImageFilter

import comfy.utils
import folder_paths
from comfy_execution.graph_utils import GraphBuilder

SUBFOLDER = "inpaint_canvas"
MIN_AUTO_CROP = 512   # auto context never emits a region smaller than this (image permitting)
SETTING_SLOTS = 8     # wildcard "setting_n" outputs the editor can drive (LoRA names, steps, ...)
REFERENCE_FITS = ("pad", "crop", "stretch")   # how reference layers of different sizes become one batch
TEMP_MAX_AGE = 3600   # helper results in temp/inpaint_canvas older than this are pruned on the next helper run
CLEANUP_MIN_AGE = 120  # the cleanup route never deletes files younger than this (a run may still need them)


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


def _load_rgb(ref, background=None):
    """Load an image reference as a [1, H, W, 3] float tensor. With ``background``
    (an RGB tuple) a transparent image is composited onto that colour first;
    without it PIL simply drops the alpha channel."""
    img = Image.open(_ref_path(ref))
    if background is not None and (img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, tuple(background) + (255,))
        img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None]


def _border_color(img):
    """Mean colour of the outermost pixel ring of a [1, H, W, 3] tensor."""
    h, w = img.shape[1], img.shape[2]
    ring = torch.cat([img[0, 0, :, :], img[0, h - 1, :, :], img[0, :, 0, :], img[0, :, w - 1, :]], dim=0)
    return ring.mean(dim=0)


def _reference_batch(images, size=1024, fit="pad"):
    """Stack reference images of different sizes into one [N, H, W, 3] batch.

    Each image is first scaled down so its long side is at most ``size`` (0 =
    native). The batch size is the largest width and height that remain; the
    others are padded with their own border colour (``pad``, default), scaled
    to cover and center-cropped (``crop``) or simply stretched (``stretch``).
    """
    if not images:
        return torch.zeros((0, 64, 64, 3), dtype=torch.float32)
    scaled = []
    for img in images:
        h, w = img.shape[1], img.shape[2]
        if size > 0 and max(w, h) > size:
            s = size / max(w, h)
            img = _resize_image(img, max(1, int(round(w * s))), max(1, int(round(h * s))))
        scaled.append(img)
    W = max(img.shape[2] for img in scaled)
    H = max(img.shape[1] for img in scaled)
    out = []
    for img in scaled:
        h, w = img.shape[1], img.shape[2]
        if w == W and h == H:
            out.append(img)
        elif fit == "stretch":
            out.append(_resize_image(img, W, H))
        elif fit == "crop":
            out.append(_resize_image(img, W, H, crop="center"))
        else:
            canvas = _border_color(img).view(1, 1, 1, 3).expand(1, H, W, 3).clone()
            x0 = (W - w) // 2
            y0 = (H - h) // 2
            canvas[:, y0:y0 + h, x0:x0 + w] = img
            out.append(canvas)
    return torch.cat(out, dim=0).clamp(0, 1)


def _prune_temp(max_age=TEMP_MAX_AGE):
    """Delete helper results (masks, label maps) older than ``max_age`` seconds.
    They are consumed by the editor right after they are produced."""
    out_dir = os.path.join(folder_paths.get_temp_directory(), SUBFOLDER)
    now = time.time()
    try:
        names = os.listdir(out_dir)
    except OSError:
        return
    for name in names:
        path = os.path.join(out_dir, name)
        try:
            if os.path.isfile(path) and now - os.path.getmtime(path) > max_age:
                os.remove(path)
        except OSError:
            pass


def _cleanup_files(keep, dry_run=True, min_age=CLEANUP_MIN_AGE):
    """Remove files in the input/output/temp ``inpaint_canvas`` folders that no
    workflow references.

    ``keep`` is the list of filenames the open editors still use (base, layers,
    masks, history). On top of that every ``*.json`` under the user directory
    (saved workflows, incl. other users) is scanned for the file names, so a
    canvas saved in another workflow keeps its files. Files younger than
    ``min_age`` seconds are kept as well: a queued run may still need them.
    """
    files = []
    for kind in ("input", "output", "temp"):
        folder = os.path.join(_dir_for_type(kind), SUBFOLDER)
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                files.append((kind, name, path))
    names = {name for _, name, _ in files}
    referenced = set(str(k) for k in (keep or []))
    user_dir = folder_paths.get_user_directory()
    for root, _dirs, fnames in os.walk(user_dir):
        for fn in fnames:
            if not fn.lower().endswith(".json"):
                continue
            path = os.path.join(root, fn)
            try:
                if os.path.getsize(path) > 50 * 1024 * 1024:
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            if SUBFOLDER not in text:
                continue
            for name in names:
                if name in text:
                    referenced.add(name)
    now = time.time()
    result = {"removed": 0, "kept": 0, "bytes": 0, "by_type": {"input": 0, "output": 0, "temp": 0}, "dry_run": bool(dry_run), "files": []}
    for kind, name, path in files:
        try:
            if name in referenced or now - os.path.getmtime(path) < min_age:
                result["kept"] += 1
                continue
            size = os.path.getsize(path)
            if not dry_run:
                os.remove(path)
        except OSError:
            result["kept"] += 1
            continue
        result["removed"] += 1
        result["bytes"] += size
        result["by_type"][kind] += 1
        if len(result["files"]) < 500:
            result["files"].append(f"{kind}/{name}")
    return result


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


def _auto_selection_params(sel_w, sel_h, strength=1.0):
    """Context padding, grow, feather and blend derived from the selection size.

    Same idea as the Krita AI plugin's defaults (reimplemented, not copied):
    feather 10 % of the selection diagonal but at least 32 px, a 4 px hard grow
    plus half the feather, a blend of at most 25 px for the composite, and a
    context padding of feather + 4 + 6 % of the diagonal. ``strength`` (the
    denoise of a local run) scales the feather like Krita does: a gentle refine
    needs a narrower transition than a full repaint.
    """
    diag = math.hypot(sel_w, sel_h)
    strength = min(1.0, max(0.05, float(strength)))
    feather = max(int(0.10 * diag * strength), int(round(32 * strength)))
    grow = 4 + feather // 2
    blend = min(25, grow + feather // 2)
    pad = feather + 4 + int(0.06 * diag)
    return pad, grow, feather, blend


def _ensure_min_span(a0, a1, limit, min_size):
    """Grow [a0, a1) symmetrically to at least ``min_size`` inside [0, limit)."""
    size = a1 - a0
    if size >= min_size or min_size <= 0:
        return a0, a1
    target = min(min_size, limit)
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


def _dilate_mask(mask, px):
    """Binary-ish dilation of a [H, W] mask by ``px`` pixels (square kernel)."""
    if px <= 0:
        return mask
    k = 2 * int(px) + 1
    out = torch.nn.functional.max_pool2d(mask[None, None], kernel_size=k, stride=1, padding=int(px))
    return out[0, 0]


def _erode_mask(mask, px):
    if px <= 0:
        return mask
    return 1.0 - _dilate_mask(1.0 - mask, px)


def _denoise_mask(sel, grow, feather):
    """Selection -> dilate(grow) -> blur(feather); always opaque inside the selection."""
    m = _dilate_mask(sel, grow)
    m = _blur_mask(m, feather / 2.5)
    return torch.maximum(m, sel).clamp(0, 1)


def _composite_mask(sel, grow, feather, blend):
    """Denoise mask -> erode(blend/2) -> blur(blend); opaque inside the selection."""
    m = _denoise_mask(sel, grow, feather)
    m = _erode_mask(m, blend // 2)
    m = _blur_mask(m, blend / 2.5)
    return torch.maximum(m, sel).clamp(0, 1)


def _gauss_np(arr, sigma):
    """Gaussian blur of an HxW or HxWxC float32 numpy array (OpenCV, falls back to PIL)."""
    if sigma <= 0:
        return arr
    try:
        import cv2
        return cv2.GaussianBlur(arr, (0, 0), sigmaX=float(sigma), sigmaY=float(sigma), borderType=cv2.BORDER_REPLICATE)
    except ImportError:
        t = torch.from_numpy(arr)
        if t.dim() == 2:
            return _blur_mask(t, sigma).numpy()
        return torch.stack([_blur_mask(t[..., c], sigma) for c in range(t.shape[-1])], dim=-1).numpy()


def _fill_masked(crop, fill_mask, mode):
    """Fill the selected area of a [1, H, W, 3] crop before it goes to the model.

    none:    untouched.
    neutral: average color of the surroundings, soft edge.
    blur:    surroundings smeared inward (normalized convolution), soft edge.
    border:  OpenCV Navier-Stokes inpainting from the border, then smeared.
    green:   pure green (0, 255, 0) with a hard edge, for edit models that are
             told to "fill the green area".
    """
    if mode in (None, "", "none"):
        return crop
    img = crop[0].cpu().float().numpy().copy()
    H, W = img.shape[:2]
    fm = fill_mask.cpu().float().numpy().astype(np.float32)
    hard = (fm > 0.5).astype(np.float32)
    if hard.sum() <= 0:
        return crop
    if mode == "green":
        out = img.copy()
        out[hard > 0.5] = (0.0, 1.0, 0.0)
        return torch.from_numpy(out)[None]
    soft = np.clip(_gauss_np(hard, 4.0) * 1.0, 0, 1)
    soft = np.maximum(soft, hard)
    if mode == "neutral":
        keep = hard < 0.5
        color = img[keep].mean(axis=0) if keep.any() else np.array([0.5, 0.5, 0.5], dtype=np.float32)
        out = img * (1 - soft[..., None]) + color[None, None, :] * soft[..., None]
        return torch.from_numpy(out.astype(np.float32))[None]
    if mode == "border":
        try:
            import cv2
            img8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)
            m8 = (hard * 255).astype(np.uint8)
            img = cv2.inpaint(img8, m8, 3, cv2.INPAINT_NS).astype(np.float32) / 255.0
        except ImportError:
            pass
    # blur (and the smoothing after border): smear the surroundings into the hole
    # with a normalized convolution so the hole content itself does not bleed.
    sigma = max(8.0, 0.05 * max(H, W))
    inv = (1.0 - hard)[..., None]
    num = _gauss_np(img * inv, sigma)
    den = _gauss_np(inv[..., 0], sigma)[..., None]
    smeared = np.where(den > 1e-4, num / np.maximum(den, 1e-4), img)
    if mode == "border":
        smeared = img * 0.5 + smeared * 0.5
    out = img * (1 - soft[..., None]) + smeared * soft[..., None]
    return torch.from_numpy(np.clip(out, 0, 1).astype(np.float32))[None]


def _cast_setting(entry):
    """Value for a setting_n output, typed for the widget it is wired to."""
    if not isinstance(entry, dict) or "value" not in entry:
        return None
    v = entry.get("value")
    t = str(entry.get("type") or "").upper()
    try:
        if t == "INT":
            return int(round(float(v)))
        if t == "FLOAT":
            return float(v)
        if t == "BOOLEAN":
            return bool(v) if not isinstance(v, str) else v.strip().lower() in ("1", "true", "yes", "on")
    except (TypeError, ValueError):
        return None
    return v


def _color_match(patch, reference, weight):
    """Shift the patch's per-channel mean and spread towards the reference,
    measured where ``weight`` (0..1, [H, W]) is high (the ring around the
    selection that the composite keeps). Returns the patch unchanged when the
    ring is too small to measure."""
    w = weight.clamp(0, 1)
    total = float(w.sum())
    if total < 64:
        return patch
    w3 = w[..., None]

    def stats(img):
        mean = (img * w3).sum(dim=(0, 1)) / total
        var = (((img - mean) ** 2) * w3).sum(dim=(0, 1)) / total
        return mean, var.clamp_min(1e-6).sqrt()

    mean_r, std_r = stats(reference)
    mean_t, std_t = stats(patch)
    scale = (std_r / std_t).clamp(0.5, 2.0)
    return ((patch - mean_t) * scale + mean_r).clamp(0, 1)


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
    result_source_local = inputs.get("result_source_local", "") or ""
    return state, result_source, result_source_local


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
                                    "tooltip": "Context pixels added around the selection before cropping. Ignored while the editor's Context is set to auto."}),
                "target_size": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 8,
                                        "tooltip": "Longest side of the emitted crop. 0 keeps the native size."}),
                "feather": ("INT", {"default": 16, "min": 0, "max": 512, "step": 1,
                                    "tooltip": "Blur radius applied to the selection edge when the result is stitched back. Ignored while the editor's Feather is set to auto."}),
                "multiple_of": ("INT", {"default": 64, "min": 1, "max": 256, "step": 1,
                                        "tooltip": "crop_image width and height are made a multiple of this (Flux wants 64)."}),
            },
            "optional": {
                "result": ("IMAGE", {"lazy": True,
                                     "tooltip": "Wire the inpaint result of your API chain here (editor mode API). It is stitched back into the canvas as a new layer."}),
                "result_local": ("IMAGE", {"lazy": True,
                                           "tooltip": "Wire the decoded result of your local chain here (editor mode Local). Only the chain of the selected mode runs."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "MASK", "STRING", "INT", "INT", "STRING", "IMAGE", "FLOAT", "INT", "STRING", "STRING") + ("*",) * SETTING_SLOTS + ("IMAGE",)
    RETURN_NAMES = ("crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative") + tuple(f"setting_{i}" for i in range(1, SETTING_SLOTS + 1)) + ("reference_images",)
    OUTPUT_TOOLTIPS = (
        "Selected region plus padding, scaled to target_size. Inpaint this.",
        "Selection mask matching crop_image (grown and feathered when the editor's Feather is auto).",
        "The flattened canvas at full size.",
        "Selection mask at full size.",
        "Stitch parameters for a standalone Inpaint Canvas Stitch node.",
        "Width of crop_image. Wire it into generators that need an explicit size.",
        "Height of crop_image.",
        "The prompt typed into the editor.",
        "Layers marked as control (scribble, lineart, depth, pose) on black, cropped and scaled exactly like crop_image. Feed it to ControlNet.",
        "Denoise strength from the editor's Generate section (1.0 = full repaint). Wire it into your local sampler.",
        "Seed from the editor (random per run or fixed). Wire it into your local sampler.",
        "\"api\" or \"local\": which result input the editor expects the result on.",
        "Negative prompt from the editor (shown in local mode; for SDXL-class models).",
    ) + tuple("Editor-driven setting: wire it into any widget input (lora_name, ckpt_name, steps, ...) and a matching control appears in the editor. The next free slot shows up once this one is connected." for _ in range(SETTING_SLOTS)) + (
        "Layers with the role \"reference\" as one image batch (top of the layer list first), for multi-reference editing with Flux.2 / Kontext. Empty batch without reference layers.",
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
        state, result_source, result_source_local = _state_from_prompt(prompt, unique_id)
        gen = state.get("gen") or {}
        mode = "local" if gen.get("mode") == "local" else "api"
        denoise = min(1.0, max(0.0, float(gen.get("denoise", 1.0) or 0.0)))
        seed = int(gen.get("seed", 0) or 0)
        refine = bool(gen.get("refine")) and mode == "local"
        strength = denoise if mode == "local" else 1.0
        # Only the chain wired to the selected mode's input is pulled in by the stitch expansion.
        result_source = result_source_local if mode == "local" else result_source
        base_ref = state.get("base")
        if not base_ref:
            raise ValueError("Inpaint Canvas: load an image into the canvas first.")

        image = _load_rgb(base_ref)
        height, width = image.shape[1], image.shape[2]
        mask = _load_mask(state.get("mask"), height, width)

        m = max(1, int(multiple_of))
        crop_settings = state.get("crop") or {}
        auto_context = crop_settings.get("context") == "auto"
        auto_feather = crop_settings.get("feather") == "auto"
        fill_mode = crop_settings.get("fill", "none") or "none"
        color_match = bool(crop_settings.get("colorMatch", False))
        has_selection = bool((mask > 0.5).any())

        sx0, sy0, sx1, sy1 = _selection_bbox(mask, 0)
        auto_pad, auto_grow, auto_feather_px, auto_blend = _auto_selection_params(sx1 - sx0, sy1 - sy0, strength)
        if not has_selection:
            auto_pad, auto_grow, auto_feather_px, auto_blend = 0, 0, 0, 0
        pad_used = auto_pad if auto_context else int(padding)
        if auto_feather:
            grow_used, feather_used, blend_used = auto_grow, auto_feather_px, auto_blend
        else:
            grow_used, feather_used, blend_used = 0, int(feather), 0
        if refine:
            # Refine pass: the sampler sees the plain selection (no grow, no feather)
            # and the untouched content; only the composite keeps a soft seam.
            grow_used, feather_used = 0, 0
            fill_mode = "none"
            if not auto_feather:
                blend_used = int(feather)

        x0, y0, x1, y1 = _selection_bbox(mask, pad_used)
        if auto_context and has_selection:
            x0, x1 = _ensure_min_span(x0, x1, width, MIN_AUTO_CROP)
            y0, y1 = _ensure_min_span(y0, y1, height, MIN_AUTO_CROP)
        if target_size <= 0:
            # Native size: grow the region itself so the emitted crop is a clean multiple.
            x0, x1 = _fit_span_to_multiple(x0, x1, width, m)
            y0, y1 = _fit_span_to_multiple(y0, y1, height, m)
        crop = image[:, y0:y1, x0:x1]
        sel_crop = mask[y0:y1, x0:x1]
        # crop_mask is the denoise mask: grown and feathered in auto mode, the raw selection otherwise.
        crop_mask = _denoise_mask(sel_crop, grow_used, feather_used) if auto_feather and has_selection else sel_crop
        if has_selection and fill_mode != "none":
            fill_px = max(grow_used - feather_used // 2, 0)
            crop = _fill_masked(crop, _dilate_mask(sel_crop, fill_px), fill_mode)

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
            "feather": int(feather_used),
            "grow": int(grow_used),
            "blend": int(blend_used),
            "auto_feather": bool((auto_feather or refine) and has_selection),
            "color_match": color_match,
            "width": width,
            "height": height,
        })

        settings = state.get("settings") or {}
        setting_values = tuple(_cast_setting(settings.get(str(i))) for i in range(1, SETTING_SLOTS + 1))

        # Reference layers: uploaded at their native size (cutout masks already
        # applied, transparency on white), batched for the API node.
        ref_settings = state.get("refs") or {}
        ref_images = []
        for entry in state.get("references") or []:
            try:
                ref_images.append(_load_rgb(entry, background=(255, 255, 255)))
            except (ValueError, FileNotFoundError, OSError) as err:
                print(f"[Inpaint Canvas] reference skipped: {err}")
        try:
            ref_size = int(ref_settings.get("size", 1024) or 0)
        except (TypeError, ValueError):
            ref_size = 1024
        ref_fit = ref_settings.get("fit") if ref_settings.get("fit") in REFERENCE_FITS else "pad"
        references = _reference_batch(ref_images, ref_size, ref_fit)

        outputs = (crop, crop_mask[None], image, mask[None], stitch_info,
                   int(crop.shape[2]), int(crop.shape[1]), str(state.get("prompt", "") or ""),
                   control_crop, denoise, seed, mode, str(state.get("negative", "") or "")) + setting_values + (references,)

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

        if info.get("auto_feather"):
            # Krita-style: opaque inside the selection, soft transition outside it.
            full = _composite_mask(mask, int(info.get("grow", 0)), feather, int(info.get("blend", 0)))
        else:
            full = _blur_mask(mask, feather)
        blend = full[y:y + h, x:x + w]
        blend3 = blend[..., None]

        out = base.clone()
        region = out[0, y:y + h, x:x + w]
        if info.get("color_match"):
            # Match the patch to the surroundings the composite keeps (the ring
            # between the region border and the selection).
            patch = _color_match(patch, region, 1.0 - blend)
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
            "optional": {
                "label": ("STRING", {"default": "", "forceInput": True,
                                     "tooltip": "Text that describes the mask (e.g. the object name a language model derived from the prompt); echoed back to the editor."}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True

    def send(self, mask, canvas_node="", purpose="segment", label=""):
        out_dir = os.path.join(folder_paths.get_temp_directory(), SUBFOLDER)
        os.makedirs(out_dir, exist_ok=True)
        _prune_temp()
        filename = f"n{canvas_node or 'x'}_{purpose}_{time.strftime('%H%M%S')}_{int(time.time() * 1000) % 1000:03d}.png"
        if isinstance(label, (list, tuple)):
            label = " ".join(str(t) for t in label)
        label = " ".join(str(label or "").strip().strip("\"'.").split())
        info = {"filename": filename, "subfolder": SUBFOLDER, "type": "temp", "canvas_node": canvas_node, "purpose": purpose, "label": label}
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
        _prune_temp()
        filename = f"n{canvas_node or 'x'}_segments_{time.strftime('%H%M%S')}_{int(time.time() * 1000) % 1000:03d}.png"
        Image.fromarray(rgb, "RGB").save(os.path.join(out_dir, filename), compress_level=1)
        return {"ui": {"inpaint_mask": [{
            "filename": filename, "subfolder": SUBFOLDER, "type": "temp",
            "canvas_node": canvas_node, "purpose": "segments",
            "width": int(W), "height": int(H), "count": len(results),
        }]}}


class InpaintCanvasTextOut:
    """Hand a text back to the canvas editor (used by the editor's prompt upsampling)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "canvas_node": ("STRING", {"default": "", "tooltip": "Id of the Inpaint Canvas node that asked for the text."}),
                "purpose": ("STRING", {"default": "upsample"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    CATEGORY = "image/inpaint"
    OUTPUT_NODE = True

    def send(self, text, canvas_node="", purpose="upsample"):
        if isinstance(text, (list, tuple)):
            text = " ".join(str(t) for t in text)
        text = str(text or "").strip()
        # strip wrapping quotes and a "Prompt:" prefix that small models like to add
        if len(text) > 1 and text[0] == text[-1] and text[0] in "\"'":
            text = text[1:-1].strip()
        for prefix in ("Prompt:", "prompt:", "PROMPT:"):
            if text.startswith(prefix):
                text = text[len(prefix):].strip()
        return {"ui": {"inpaint_text": [{"text": text, "canvas_node": canvas_node, "purpose": purpose}]}}


# ---------------------------------------------------------------------------
# HTTP route: file cleanup (the editor's "Clean up files" button)
# ---------------------------------------------------------------------------

def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None:
        return

    @server.routes.post("/inpaint_canvas/cleanup")
    async def _cleanup_route(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        keep = data.get("keep") if isinstance(data, dict) else None
        dry_run = bool(data.get("dry_run", True)) if isinstance(data, dict) else True
        try:
            min_age = float(data.get("min_age", CLEANUP_MIN_AGE)) if isinstance(data, dict) else CLEANUP_MIN_AGE
        except (TypeError, ValueError):
            min_age = CLEANUP_MIN_AGE
        result = _cleanup_files(keep if isinstance(keep, list) else [], dry_run=dry_run, min_age=max(0.0, min_age))
        return web.json_response(result)


_register_routes()


NODE_CLASS_MAPPINGS = {
    "InpaintCanvas": InpaintCanvas,
    "InpaintCanvasStitch": InpaintCanvasStitch,
    "InpaintCanvasLoadRef": InpaintCanvasLoadRef,
    "InpaintCanvasMaskOut": InpaintCanvasMaskOut,
    "InpaintCanvasObjectMap": InpaintCanvasObjectMap,
    "InpaintCanvasTextOut": InpaintCanvasTextOut,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintCanvas": "Inpaint Canvas",
    "InpaintCanvasStitch": "Inpaint Canvas Stitch",
    "InpaintCanvasLoadRef": "Inpaint Canvas Load Ref",
    "InpaintCanvasMaskOut": "Inpaint Canvas Mask Out",
    "InpaintCanvasObjectMap": "Inpaint Canvas Object Map",
    "InpaintCanvasTextOut": "Inpaint Canvas Text Out",
}
