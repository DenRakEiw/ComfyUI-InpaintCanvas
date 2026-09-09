"""Inpaint Canvas MCP server: lets an agent (Claude Code, Claude Desktop, Cursor, ...) drive the
Inpaint Canvas editor that is open in a ComfyUI browser tab. Local only.

How it works: every tool posts a command to the ComfyUI server (POST /inpaint_canvas/command);
nodes.py forwards it over ComfyUI's websocket to the open editor, the editor runs it and answers.
So ComfyUI must be running and a browser tab with an Inpaint Canvas node in the graph must be open.

Run:   python mcp/inpaint_canvas_mcp.py            (stdio transport, what MCP clients expect)
Env:   COMFYUI_URL   default http://127.0.0.1:8188
       INPAINT_CANVAS_NODE   optional node id when the graph holds several Inpaint Canvas nodes
       INPAINT_CANVAS_HEADLESS=1   start a headless Edge/Chrome tab on the first command (no visible tab needed)
       INPAINT_CANVAS_WORKFLOW     workflow .json to load into that tab (your inpainting chain, for generate)
       INPAINT_CANVAS_BROWSER      path to msedge/chrome if it is not found automatically
       INPAINT_CANVAS_BROWSER_ARGS extra browser flags (e.g. --remote-debugging-port=9444 to inspect the tab)

Client config (Claude Code: `claude mcp add inpaint-canvas -- <python> <this file>`, or in .mcp.json):
  {"mcpServers": {"inpaint-canvas": {"command": "<python>", "args": ["<path>/mcp/inpaint_canvas_mcp.py"],
                                     "env": {"COMFYUI_URL": "http://127.0.0.1:8188"}}}}

Needs the `mcp` package (pip install mcp); works with mcp 1.x (FastMCP) and 2.x (MCPServer).
"""
from __future__ import annotations

import atexit
import base64
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

try:  # mcp 2.x
    from mcp.server.mcpserver import Image, MCPServer as _Server
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server, Image  # type: ignore
    from mcp.server.fastmcp.exceptions import ToolError  # type: ignore

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
NODE = os.environ.get("INPAINT_CANVAS_NODE") or None
HEADLESS_ENV = os.environ.get("INPAINT_CANVAS_HEADLESS", "").strip().lower() in ("1", "true", "yes", "on")
WORKFLOW_ENV = os.environ.get("INPAINT_CANVAS_WORKFLOW") or None
BROWSER_ENV = os.environ.get("INPAINT_CANVAS_BROWSER") or None
BROWSER_ARGS_ENV = os.environ.get("INPAINT_CANVAS_BROWSER_ARGS") or ""   # extra browser flags, e.g. --remote-debugging-port=9444
BROWSER_FLAGS = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
                 "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                 "--window-size=1600,1000", "--remote-allow-origins=*"]
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

INSTRUCTIONS = """Inpaint Canvas is a Krita-style image editor inside a ComfyUI node. You control the editor that is
open in the user's browser. Typical round trip: load_image (or inpaint_status to see what is loaded) ->
select_rect / select_by_text -> set_prompt -> generate (the result comes back as a layer on top of the
selection) -> screenshot to look at it -> set_layer(match=...) to blend the colours -> export_image.
Coordinates are image pixels, origin top left. Layers are addressed by id or name; "active" is the
active layer. generate needs an inpainting chain wired to the node's result input in the user's graph;
mode "api" uses the result input, "local" the result_local input. Always screenshot after a change
you cannot judge from numbers. Selections, layers and settings persist in the editor between calls."""

mcp = _Server("inpaint-canvas", instructions=INSTRUCTIONS)


# ---------------------------------------------------------------------------------------------
# transport to ComfyUI

class BridgeError(ToolError):
    """An error the editor or the transport reported; the message reaches the model as the tool's error text."""


def _http(path: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    url = COMFYUI_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {}
        raise BridgeError(payload.get("error") or f"{url} answered {e.code}") from None
    except urllib.error.URLError as e:
        raise BridgeError(f"ComfyUI is not reachable at {COMFYUI_URL} ({e.reason}). Start ComfyUI, or set COMFYUI_URL.") from None


def cmd(name: str, args: dict | None = None, timeout: float = 30.0, node: str | None = None, client: str | None = None) -> Any:
    """Run one editor command and return its result (raises BridgeError with the editor's message)."""
    if HEADLESS_ENV and headless.client is None and name not in ("ping", "list_nodes"):
        headless.start(WORKFLOW_ENV)
    body = {"cmd": name, "args": {k: v for k, v in (args or {}).items() if v is not None}, "timeout": timeout, "node": node or NODE,
            "client": client or headless.client}
    res = _http("/inpaint_canvas/command", body, timeout=timeout + 15)
    if not res.get("ok"):
        err = res.get("error") or "the editor reported an error"
        if headless.client and "no longer connected" in err:
            headless.client = None
        raise BridgeError(err)
    return res.get("result")


# ---------------------------------------------------------------------------------------------
# headless browser: a Chromium tab of ComfyUI nobody looks at, so the bridge works on a server

class Headless:
    """Starts Edge or Chrome headless on the ComfyUI page, finds its bridge client id, prepares a node
    (or loads a workflow) and pins every later command to that tab."""

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.client: str | None = None
        self.profile: str | None = None
        self.workflow: str | None = None

    @staticmethod
    def find_browser() -> str | None:
        if BROWSER_ENV and os.path.isfile(BROWSER_ENV):
            return BROWSER_ENV
        candidates = []
        if sys.platform.startswith("win"):
            for base in (os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
                candidates += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                               os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                               os.path.join(base, "Chromium", "Application", "chrome.exe")]
        elif sys.platform == "darwin":
            candidates += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                           "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge", "chrome"):
            path = shutil.which(name)
            if path:
                candidates.append(path)
        for c in candidates:
            if c and os.path.isfile(c):
                return c
        return None

    def _tabs(self) -> set[str]:
        try:
            r = cmd("ping", timeout=5)
            return set(r.get("tabs") or [])
        except BridgeError:
            return set()

    def start(self, workflow_path: str | None = None) -> dict:
        if self.proc and self.proc.poll() is None and self.client:
            return {"running": True, "client": self.client, "profile": self.profile, "workflow": self.workflow}
        browser = self.find_browser()
        if not browser:
            raise BridgeError("no Chromium browser found (Edge or Chrome). Install one or set INPAINT_CANVAS_BROWSER to its path.")
        try:
            info = _http("/inpaint_canvas/info")
        except BridgeError:
            raise
        base = info.get("temp_dir") or tempfile.gettempdir()
        self.profile = os.path.join(base, "inpaint_canvas_headless")
        os.makedirs(self.profile, exist_ok=True)
        before = self._tabs()
        args = [browser] + list(BROWSER_FLAGS) + [f"--user-data-dir={self.profile}"] + BROWSER_ARGS_ENV.split() + [COMFYUI_URL + "/"]
        creation = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform.startswith("win") else {}
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **creation)
        self.client = None
        t0 = time.time()
        while time.time() - t0 < 90:
            if self.proc.poll() is not None:
                raise BridgeError(f"the browser exited right away (code {self.proc.returncode}); try INPAINT_CANVAS_BROWSER with another browser")
            now = self._tabs() - before
            if now:
                self.client = sorted(now)[0]
                break
            time.sleep(1.0)
        if not self.client:
            self.stop()
            raise BridgeError("the headless tab did not connect to ComfyUI within 90 s")
        self._wait_ready()
        path = workflow_path or WORKFLOW_ENV
        if path:
            res = self.load_workflow(path)
        else:
            res = cmd("ensure_node", timeout=30, client=self.client)
        return {"running": True, "client": self.client, "profile": self.profile, "workflow": self.workflow, "nodes": res.get("nodes")}

    def _wait_ready(self, limit: float = 180.0) -> None:
        """The frontend answers the bridge before it has finished starting; the persisted workflow is restored
        a few seconds later and would replace anything prepared earlier. Wait for ready, then for the graph
        to hold still."""
        t0 = time.time()
        last = None
        stable_since = None
        while time.time() - t0 < limit:
            try:
                info = cmd("ping", timeout=5, client=self.client)
            except BridgeError:
                info = None
            if info and info.get("ready"):
                key = (info.get("nodes_total"), len(info.get("nodes") or []))
                if key == last:
                    if stable_since is None:
                        stable_since = time.time()
                    elif time.time() - stable_since >= 3.0:
                        return
                else:
                    last, stable_since = key, None
            time.sleep(1.0)
        raise BridgeError("the headless tab did not finish loading ComfyUI within %d s" % limit)

    def load_workflow(self, path: str) -> dict:
        path = os.path.abspath(os.path.expanduser(path))
        try:
            with open(path, encoding="utf-8") as f:
                wf = json.load(f)
        except (OSError, ValueError) as e:
            raise BridgeError(f"cannot read workflow {path}: {e}") from None
        res = cmd("load_workflow", {"workflow": wf}, timeout=60, client=self.client)
        self.workflow = path
        return res

    def stop(self) -> dict:
        was = self.proc is not None and self.proc.poll() is None
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(10)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None
        self.client = None
        return {"stopped": was}


headless = Headless()
atexit.register(headless.stop)


def _text(obj: Any) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=False)


def _upload(path: str, subfolder: str = "inpaint_canvas") -> dict:
    """Upload a local image into ComfyUI's input folder; returns the file reference."""
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise BridgeError(f"file not found: {path}")
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if not mime.startswith("image/"):
        raise BridgeError(f"not an image: {path} ({mime})")
    name = os.path.basename(path)
    with open(path, "rb") as f:
        content = f.read()
    if len(content) >= 64 * 1024 * 1024:
        # over ComfyUI's --max-upload-size: the node's streaming route
        from urllib.parse import urlencode
        req = urllib.request.Request(COMFYUI_URL + "/inpaint_canvas/upload?" + urlencode({"filename": name, "subfolder": subfolder, "type": "input", "overwrite": "false"}),
                                     data=content, headers={"Content-Type": "application/octet-stream"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                info = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise BridgeError("the file is over ComfyUI's upload limit and the node's upload route is missing: restart ComfyUI after updating the node") from None
            raise BridgeError(f"upload failed ({e.code})") from None
        except urllib.error.URLError as e:
            raise BridgeError(f"upload failed: {e}") from None
        return {"filename": info.get("name") or name, "subfolder": info.get("subfolder") or subfolder, "type": info.get("type") or "input"}
    boundary = "----InpaintCanvas" + uuid.uuid4().hex
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n".encode() + content + b"\r\n",
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"subfolder\"\r\n\r\n{subfolder}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\nfalse\r\n".encode(),
        f"--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(COMFYUI_URL + "/upload/image", data=b"".join(parts), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            info = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise BridgeError(f"upload failed: {e}") from None
    return {"filename": info.get("name") or name, "subfolder": info.get("subfolder") or subfolder, "type": info.get("type") or "input"}


def _abs_path(ref: dict) -> str:
    info = _http("/inpaint_canvas/info")
    folder = {"input": info.get("input_dir"), "output": info.get("output_dir"), "temp": info.get("temp_dir")}.get(ref.get("type") or "output") or ""
    return os.path.join(folder, ref.get("subfolder") or "", ref.get("filename") or "")


# ---------------------------------------------------------------------------------------------
# tools: status and image

@mcp.tool()
def inpaint_status() -> str:
    """What the editor holds right now: image size, prompt, generation settings, selection bounds, every layer
    with id/name/kind/visibility/opacity/blend/position/colour match, pending jobs and the last status line.
    Call this first."""
    try:
        return _text(cmd("status"))
    except BridgeError as e:
        info = None
        try:
            info = _http("/inpaint_canvas/info")
        except BridgeError as e2:
            return f"error: {e2}"
        return f"error: {e}\nComfyUI {info.get('version', '')} is running with {info.get('clients', 0)} browser tab(s) connected."


@mcp.tool()
def start_headless(workflow_path: str | None = None) -> str:
    """Start a headless Edge/Chrome tab of ComfyUI that this server drives from now on, so no visible browser tab
    is needed. workflow_path: a saved ComfyUI workflow (.json) with an Inpaint Canvas node and your inpainting
    chain; without it an empty Inpaint Canvas node is created (generate then has nothing to run). The tab's
    state (workflow, image, layers) persists in its own browser profile between starts. Results are only
    visible through screenshot and export."""
    return _text(headless.start(workflow_path))


@mcp.tool()
def stop_headless() -> str:
    """Close the headless browser started by start_headless; commands go back to the visible tab."""
    return _text(headless.stop())


@mcp.tool()
def load_workflow(path: str) -> str:
    """Replace the graph in the driven tab with a saved ComfyUI workflow (.json). It must contain an Inpaint
    Canvas node; the inpainting chain wired to it is what generate runs. In the visible tab this replaces
    what the user has open, so prefer it for the headless tab."""
    return _text(headless.load_workflow(path) if headless.client else cmd("load_workflow", {"workflow": json.load(open(os.path.abspath(os.path.expanduser(path)), encoding="utf-8"))}, timeout=60))


@mcp.tool()
def list_nodes() -> str:
    """The Inpaint Canvas nodes in the open graph (id, title, whether the editor is open, image size). With
    several nodes, set the env INPAINT_CANVAS_NODE or pass node ids where a tool accepts one."""
    return _text(cmd("list_nodes"))


@mcp.tool()
def open_editor(node: str | None = None) -> str:
    """Open the full-window editor in the browser (most tools work with it closed too; open it so the user can watch)."""
    return _text(cmd("open_editor", node=node))


@mcp.tool()
def close_editor(node: str | None = None) -> str:
    """Close the full-window editor; the state stays in the node."""
    return _text(cmd("close_editor", node=node))


@mcp.tool()
def load_image(path: str) -> str:
    """Load a local image file as the base image (replaces the current image, layers and history).
    path: absolute path on this machine."""
    ref = _upload(path)
    return _text(cmd("load_image", ref, timeout=120))


@mcp.tool()
def new_canvas(width: int = 1024, height: int = 1024) -> str:
    """Start a new empty white canvas of the given size (discards the current image and layers)."""
    return _text(cmd("new_canvas", {"width": width, "height": height}, timeout=120))


@mcp.tool()
def add_image_layer(path: str, role: str = "image", x: int | None = None, y: int | None = None,
                    width: int | None = None, height: int | None = None, name: str | None = None) -> str:
    """Add a local image file as a new layer. role "image": part of the picture (fitted to the canvas, or placed at
    x,y with width/height in image pixels). role "reference": not part of the picture, travels with crop_image as an
    extra batch image for Flux.2 / Kontext multi-reference editing."""
    ref = _upload(path)
    ref.update({"role": "reference" if role == "reference" else "none", "x": x, "y": y, "width": width, "height": height, "name": name})
    return _text(cmd("add_image_layer", ref, timeout=120))


# ---------------------------------------------------------------------------------------------
# tools: selection

@mcp.tool()
def select_rect(x: int, y: int, width: int, height: int, mode: str = "replace") -> str:
    """Select a rectangle in image pixels. mode: replace, add or subtract."""
    return _text(cmd("select_rect", {"x": x, "y": y, "w": width, "h": height, "mode": mode}))


@mcp.tool()
def select_by_text(text: str, mode: str = "replace", threshold: float | None = None, timeout: int = 300) -> str:
    """Select an object by describing it ("the car", "left headlight", "sky"). Runs the segmentation model the
    editor is set to (SAM3 by default) and waits for the mask. mode: replace, add, subtract. threshold 0.05..0.95,
    lower finds more. Returns the selection bounds; an empty result means nothing matched."""
    return _text(cmd("select_by_text", {"text": text, "mode": mode, "threshold": threshold, "timeout": timeout}, timeout=timeout + 45))


@mcp.tool()
def select_all() -> str:
    """Select the whole image."""
    return _text(cmd("select_all"))


@mcp.tool()
def select_none() -> str:
    """Clear the selection."""
    return _text(cmd("select_none"))


@mcp.tool()
def select_invert() -> str:
    """Invert the selection."""
    return _text(cmd("select_invert"))


@mcp.tool()
def select_feather(radius: float = 8) -> str:
    """Soften the selection edge by a gaussian blur of the given radius in pixels."""
    return _text(cmd("select_feather", {"radius": radius}))


@mcp.tool()
def select_grow(pixels: int) -> str:
    """Grow (positive) or shrink (negative) the selection by the given number of pixels."""
    return _text(cmd("select_grow", {"px": pixels}, timeout=120))


@mcp.tool()
def select_from_layer(layer: str = "active") -> str:
    """Selection from a layer's opaque pixels (its alpha)."""
    return _text(cmd("select_from_layer", {"layer": layer}))


# ---------------------------------------------------------------------------------------------
# tools: prompt and generation

@mcp.tool()
def set_prompt(text: str, negative: str | None = None) -> str:
    """Set the prompt the inpainting chain receives (and the negative prompt, used by local chains)."""
    return _text(cmd("set_prompt", {"text": text, "negative": negative}))


@mcp.tool()
def set_generation(mode: str | None = None, seed: int | None = None, seed_random: bool | None = None,
                   denoise: float | None = None) -> str:
    """Generation settings. mode: "api" (result comes back through the result input) or "local" (result_local;
    helper models are freed from VRAM before the run). seed fixes the seed and turns seed_random off.
    denoise 0.05..1 is emitted on the node's denoise output for local chains."""
    return _text(cmd("set_generation", {"mode": mode, "seed": seed, "seed_random": seed_random, "denoise": denoise}))


@mcp.tool()
def set_crop(context: str | None = None, feather: str | None = None, fill: str | None = None,
             color_match: bool | None = None, paste: str | None = None) -> str:
    """Crop settings for the round trip. context: "auto" or a number of pixels of surroundings sent with the
    selection; feather: "auto" or pixels; fill: none, green, blur, average (what the selected area is filled
    with before generating); color_match: match the result to the surroundings on stitch; paste: "selection"
    or "whole crop"."""
    args = {"context": context, "feather": feather, "fill": fill, "colorMatch": color_match, "paste": paste}
    return _text(cmd("set_crop", args))


@mcp.tool()
def upsample_prompt(timeout: int = 300) -> str:
    """Let the language model the editor is set to (Qwen-VL or Gemini) rewrite the prompt with the image in view."""
    return _text(cmd("upsample_prompt", {"timeout": timeout}, timeout=timeout + 45))


@mcp.tool()
def generate(timeout: int = 600) -> str:
    """Queue the user's workflow: the selected area (with context) goes to the inpainting chain wired to the
    node, the result comes back as a new layer placed over the selection. Waits for the result. Needs a
    selection (or the whole image is used) and a prompt. Returns the new layer; then screenshot to judge it and
    set_layer(match=...) to blend its colours."""
    return _text(cmd("generate", {"timeout": timeout}, timeout=timeout + 45))


# ---------------------------------------------------------------------------------------------
# tools: layers

@mcp.tool()
def list_layers() -> str:
    """All layers bottom to top with id, name, kind (result, image, paint, text, filter), role, visibility,
    opacity, blend mode, position/size, colour match and which one is active."""
    return _text(cmd("list_layers"))


@mcp.tool()
def set_layer(layer: str = "active", name: str | None = None, visible: bool | None = None, opacity: float | None = None,
              blend: str | None = None, match: int | None = None, match_source: str | None = None,
              role: str | None = None, locked: bool | None = None, x: int | None = None, y: int | None = None,
              width: int | None = None, height: int | None = None, active: bool | None = None) -> str:
    """Change a layer. layer: id, name or "active". opacity 0..1. blend: normal, multiply, screen, overlay,
    soft-light, hard-light, darken, lighten, difference, color, luminosity, ... . match 0..100: colour match
    strength, shifts the layer's colours towards the image below (source "surroundings" or "below").
    role: none, reference or control. x/y/width/height move and scale the layer in image pixels (width alone
    keeps the aspect)."""
    args = {"layer": layer, "name": name, "visible": visible, "opacity": opacity, "blend": blend, "match": match,
            "match_source": match_source, "role": role, "locked": locked, "x": x, "y": y, "width": width, "height": height, "active": active}
    return _text(cmd("set_layer", args))


@mcp.tool()
def set_active_layer(layer: str) -> str:
    """Make a layer the active one (tools and "active" refer to it)."""
    return _text(cmd("set_active_layer", {"layer": layer}))


@mcp.tool()
def remove_layer(layer: str) -> str:
    """Delete a layer."""
    return _text(cmd("remove_layer", {"layer": layer}))


@mcp.tool()
def duplicate_layer(layer: str = "active") -> str:
    """Duplicate a layer (the copy sits above it)."""
    return _text(cmd("duplicate_layer", {"layer": layer}))


@mcp.tool()
def merge_down(layer: str = "active") -> str:
    """Merge a layer into the one below it (into the base image if it is the lowest)."""
    return _text(cmd("merge_down", {"layer": layer}, timeout=120))


@mcp.tool()
def move_layer(layer: str, to: str = "up") -> str:
    """Reorder a layer: to = up, down, top or bottom."""
    return _text(cmd("move_layer", {"layer": layer, "to": to}))


@mcp.tool()
def flip_layer(layer: str = "active", axis: str = "x") -> str:
    """Mirror a layer horizontally (axis x) or vertically (axis y)."""
    return _text(cmd("flip_layer", {"layer": layer, "axis": axis}))


@mcp.tool()
def center_layer(layer: str = "active") -> str:
    """Centre a layer on the canvas."""
    return _text(cmd("center_layer", {"layer": layer}))


@mcp.tool()
def cutout_layer(layer: str = "active", timeout: int = 300) -> str:
    """Remove the background of a layer with the cutout model the editor is set to (RMBG-2.0 by default);
    the result is a layer mask, the pixels stay."""
    return _text(cmd("cutout_layer", {"layer": layer, "timeout": timeout}, timeout=timeout + 45))


# ---------------------------------------------------------------------------------------------
# tools: filters and text

@mcp.tool()
def filter_types() -> str:
    """The filter layer types and their parameters (key, range, default)."""
    return _text(cmd("filter_types"))


@mcp.tool()
def add_filter(type: str = "grain", params: dict | None = None, name: str | None = None) -> str:
    """Add a non-destructive filter layer on top of the stack: grain (film grain, param preset picks a film
    stock), sharpen, blur, levels, curves, brightness/contrast, hsl, color balance, bw, invert, lut, vignette.
    params: {key: value} as listed by filter_types, e.g. {"amount": 35, "preset": "portra400"} (film presets:
    ektar100, portra160, portra400, portra800, gold200, superia400, velvia50, kodachrome64, tmax100, ...)."""
    return _text(cmd("add_filter", {"type": type, "params": params, "name": name}))


@mcp.tool()
def set_filter(layer: str, params: dict | None = None, type: str | None = None) -> str:
    """Change a filter layer's parameters (or its type)."""
    return _text(cmd("set_filter", {"layer": layer, "params": params, "type": type}))


@mcp.tool()
def add_text(text: str, x: int | None = None, y: int | None = None, size: int | None = None, font: str | None = None,
             color: str | None = None, bold: bool | None = None, italic: bool | None = None, align: str | None = None,
             outline: float | None = None, outline_color: str | None = None, name: str | None = None) -> str:
    """Add a text layer at x,y (image pixels, top left of the text). Bundled fonts: Roboto, Open Sans, Montserrat,
    Oswald, Bebas Neue, Anton, Bangers, Lobster, Pacifico, Playfair Display, Lora, Cinzel, Abril Fatface,
    Caveat, Dancing Script, Permanent Marker, Roboto Mono. color as #rrggbb."""
    args = {"text": text, "x": x, "y": y, "size": size, "font": font, "color": color, "bold": bold, "italic": italic,
            "align": align, "outline": outline, "outline_color": outline_color, "name": name}
    return _text(cmd("add_text", args, timeout=60))


@mcp.tool()
def set_text(layer: str, text: str | None = None, size: int | None = None, font: str | None = None,
             color: str | None = None, bold: bool | None = None, italic: bool | None = None, align: str | None = None,
             outline: float | None = None, outline_color: str | None = None) -> str:
    """Change a text layer's content or style."""
    args = {"layer": layer, "text": text, "size": size, "font": font, "color": color, "bold": bold, "italic": italic,
            "align": align, "outline": outline, "outline_color": outline_color}
    return _text(cmd("set_text", args, timeout=60))


# ---------------------------------------------------------------------------------------------
# tools: canvas, history, compare, export, look

@mcp.tool()
def extend_canvas(left: int = 0, top: int = 0, right: int = 0, bottom: int = 0) -> str:
    """Grow the canvas by pixels on each side (outpainting room; the new area is filled with the edge's average
    colour, select it and generate) or shrink it with negative values (crop)."""
    return _text(cmd("extend_canvas", {"left": left, "top": top, "right": right, "bottom": bottom}, timeout=120))


@mcp.tool()
def undo() -> str:
    """Undo the last editor step."""
    return _text(cmd("undo"))


@mcp.tool()
def redo() -> str:
    """Redo the last undone step."""
    return _text(cmd("redo"))


@mcp.tool()
def compare(enabled: bool | None = None) -> str:
    """Toggle the side-by-side compare of the two latest results in the editor (for the user to look at)."""
    return _text(cmd("compare", {"enabled": enabled}))


@mcp.tool()
def export_image(format: str = "png", name: str = "inpaint_canvas") -> str:
    """Save the image into ComfyUI's output folder and return its path. format: png (workflow embedded), jpg,
    webp, psd (Photoshop, layers kept) or ora (OpenRaster for Krita/GIMP, layers kept)."""
    res = cmd("export", {"format": format, "name": name}, timeout=300)
    res["path"] = _abs_path(res.get("file") or {})
    return _text(res)


@mcp.tool()
def export_mask() -> str:
    """Save the selection as a black/white PNG in the output folder and return its path."""
    res = cmd("export_mask", timeout=120)
    res["path"] = _abs_path(res.get("file") or {})
    return _text(res)


@mcp.tool()
def screenshot(max_size: int = 1024, show_selection: bool = True, show_layers: bool = False, what: str = "image",
               layer: str | None = None) -> Image:
    """Look at the image: the flattened composite as a JPEG, scaled to max_size on the long side. The selection is
    tinted and outlined in magenta (show_selection), show_layers draws every layer's frame and name.
    what: "image" (composite as the inpaint chain sees it), "editor" (composite with reference layers shown) or
    "layer" (only the given layer's pixels)."""
    res = cmd("screenshot", {"max_size": max_size, "show_selection": show_selection, "show_layers": show_layers, "what": what, "layer": layer}, timeout=120)
    return Image(data=base64.b64decode(res["data"]), format="jpeg")


@mcp.tool()
def get_state() -> str:
    """The editor's full state as JSON (what the node widget stores, without the selection bitmap): advanced use."""
    return _text(cmd("get_state"))


# ---------------------------------------------------------------------------------------------
# resources: the manual

@mcp.resource("inpaint-canvas://guide")
def guide() -> str:
    """The Inpaint Canvas manual (GUIDE.md): tools, shortcuts, how the round trip and the settings work."""
    try:
        with open(os.path.join(ROOT, "GUIDE.md"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return "GUIDE.md not found"


if __name__ == "__main__":
    if "--check" in sys.argv:
        try:
            print(_text(_http("/inpaint_canvas/info")))
            if "--headless" in sys.argv:
                print(_text(headless.start(WORKFLOW_ENV)))
                print(_text(cmd("status")))
                headless.stop()
            else:
                print(_text(cmd("ping")))
        except BridgeError as e:
            print("error:", e)
            sys.exit(1)
    else:
        mcp.run("stdio")
