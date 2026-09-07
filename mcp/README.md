# Inpaint Canvas MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an agent (Claude Code, Claude
Desktop, Cursor, any MCP client) drive the Inpaint Canvas editor that is open in your
ComfyUI browser tab: load an image, select by rectangle or by text, set the prompt,
generate, look at the result, blend it with colour match, add filters and text, export.

It is **local only**. The server talks to your running ComfyUI over HTTP, ComfyUI pushes
each command to the browser tab over its own websocket, the editor runs it and answers.
Nothing leaves your machine and the command route only accepts requests from localhost.

## Requirements

- ComfyUI running with this node pack, and **a browser tab with an Inpaint Canvas node
  in the graph** (the editor does not need to be open, but open it to watch the agent).
- The `mcp` Python package in the Python the server runs with. For the portable
  ComfyUI build that is `python_embeded`:

  ```bash
  python_embeded\python.exe -m pip install mcp
  ```

  Both mcp 1.x and 2.x work.
- For `generate`: an inpainting chain wired to the node's `result` (API) or
  `result_local` input, exactly as when you press Generate yourself. The two example
  workflows in `examples/` are ready for that.

## Setup

**Claude Code** (one line, from any folder):

```bash
claude mcp add inpaint-canvas -e COMFYUI_URL=http://127.0.0.1:8188 -- F:\path\to\python_embeded\python.exe F:\path\to\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas\mcp\inpaint_canvas_mcp.py
```

**Claude Desktop / Cursor / others**, in their MCP config file:

```json
{
  "mcpServers": {
    "inpaint-canvas": {
      "command": "F:\\path\\to\\python_embeded\\python.exe",
      "args": ["F:\\path\\to\\ComfyUI\\custom_nodes\\ComfyUI-InpaintCanvas\\mcp\\inpaint_canvas_mcp.py"],
      "env": { "COMFYUI_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

Check the connection without an agent:

```bash
python_embeded\python.exe custom_nodes\ComfyUI-InpaintCanvas\mcp\inpaint_canvas_mcp.py --check
```

It prints ComfyUI's folders and the Inpaint Canvas nodes found in the open tabs.

Environment: `COMFYUI_URL` (default `http://127.0.0.1:8188`), `INPAINT_CANVAS_NODE`
(a node id, only needed when the graph holds several Inpaint Canvas nodes).

## Tools

| Area | Tools |
|---|---|
| Look | `inpaint_status`, `list_nodes`, `list_layers`, `screenshot` (JPEG of the composite, selection tinted, optional layer frames), `get_state` |
| Image | `load_image`, `new_canvas`, `add_image_layer` (image or reference), `extend_canvas` (grow for outpainting, negative crops) |
| Selection | `select_rect`, `select_by_text` (SAM3), `select_all`, `select_none`, `select_invert`, `select_feather`, `select_grow`, `select_from_layer` |
| Generate | `set_prompt`, `set_generation` (api/local, seed, denoise), `set_crop`, `upsample_prompt`, `generate` (waits for the result layer) |
| Layers | `set_layer` (visibility, opacity, blend, **colour match**, role, position, size), `set_active_layer`, `remove_layer`, `duplicate_layer`, `merge_down`, `move_layer`, `flip_layer`, `center_layer`, `cutout_layer` (RMBG) |
| Filters, text | `filter_types`, `add_filter`, `set_filter`, `add_text`, `set_text` |
| Rest | `undo`, `redo`, `compare`, `export_image` (png/jpg/webp/psd/ora), `export_mask`, `open_editor`, `close_editor` |

Resource `inpaint-canvas://guide` returns the manual (GUIDE.md), so the agent can read up
on the settings it changes.

## A typical session

> Load `C:\pics\car.png`, select the car, replace it with a red vintage convertible,
> blend the colours, add a little film grain and save as PSD.

The agent runs `load_image`, `select_by_text("the car")`, `set_prompt(...)`,
`generate`, `screenshot`, `set_layer(match=60)`, `add_filter("grain", {"amount": 20})`,
`export_image("psd")`. Every step is visible in the editor and stays undoable.

## Several tabs

Commands are broadcast on the first `inpaint_status` / `list_nodes`; the tab that holds
an Inpaint Canvas node becomes the target for everything after that. With a node in
more than one tab, close the other tab or set `INPAINT_CANVAS_NODE` to the node id you
mean (`list_nodes` shows ids and tabs).

## How it works, for developers

- `nodes.py` registers `POST /inpaint_canvas/command` (loopback only), `POST
  /inpaint_canvas/reply` and `GET /inpaint_canvas/info`. A command is forwarded with
  `PromptServer.send_sync("inpaint_canvas.command", …)` and the route waits on a future
  until the tab replies, with the caller's timeout.
- `js/inpaint_bridge.js` listens for that event, resolves the editor (by node id or the
  first one), runs the command and posts the reply. Every command is a small function
  `(editor, args) -> JSON` in the `COMMANDS` table; long jobs (segmentation, generate,
  cutout, upsampling) wait for their result before answering.
- `mcp/inpaint_canvas_mcp.py` is a thin stdio MCP server: each tool is one command,
  `load_image` and `add_image_layer` upload the file through `/upload/image` first,
  `screenshot` returns the JPEG as image content.

Adding a command means one entry in `COMMANDS` and one tool function here.
