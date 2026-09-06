"""README screenshots: drive a headless Edge over the DevTools protocol, load
ComfyUI, build the demo graph, open the Inpaint Canvas editor and capture
scenes into docs/img/ (as PNG; convert to JPEG and crop the graph afterwards).

Start Edge first (any Chromium works the same):
  msedge --headless=new --remote-debugging-port=9333 --window-size=1600,1000 ^
    --user-data-dir=<empty profile dir> http://127.0.0.1:8188/
Then: python docs/shots.py [scene ...]   with ComfyUI running on 127.0.0.1:8188.
Scenes use input/inpaint_canvas/ComfyUI_01940_.png and a plain ImageInvert as
the "inpaint chain", so no model besides SAM3 / SAM2 is needed."""
import asyncio, base64, json, os, sys, time, urllib.request
import aiohttp

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img")
os.makedirs(OUT, exist_ok=True)
PORT = 9333

HELPERS = r"""
window.__wait = (ms) => new Promise(r => setTimeout(r, ms));
window.__ipcAt = (ed, ix, iy) => { const r = ed.canvas.getBoundingClientRect(); const cx = ed.view.x + ix * ed.view.scale, cy = ed.view.y + iy * ed.view.scale; return { clientX: r.left + cx * (r.width / ed.canvas.width), clientY: r.top + cy * (r.height / ed.canvas.height) }; };
window.__ipcEv = (ed, type, ix, iy, extra = {}) => { const p = window.__ipcAt(ed, ix, iy); ed.canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...p, ...extra })); };
window.__until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) {} await window.__wait(250); } return false; };
"""

SCENES = [
    ("graph", r"""
const app = window.comfyAPI.app.app;
app.graph.clear();
const c = LiteGraph.createNode('InpaintCanvas'); c.pos = [60, 80]; app.graph.add(c);
const lora = LiteGraph.createNode('LoraLoader'); lora.pos = [560, 60]; app.graph.add(lora);
const ks = LiteGraph.createNode('KSampler'); ks.pos = [560, 330]; app.graph.add(ks);
const inv = LiteGraph.createNode('ImageInvert'); inv.pos = [560, 720]; inv.title = 'your inpaint chain'; app.graph.add(inv);
c.connect(0, inv, 0); inv.connect(0, c, 'result');
c.connect(13, lora, lora.inputs.findIndex(i => i.name === 'lora_name'));
c.connect(14, ks, ks.inputs.findIndex(i => i.name === 'steps'));
c.connect(10, ks, ks.inputs.findIndex(i => i.name === 'seed'));
c.connect(9, ks, ks.inputs.findIndex(i => i.name === 'denoise'));
window.__c = c; const ed = c.inpaintEditor; window.__ed = ed;
await ed.setValue(JSON.stringify({width:1776,height:2368,base:{filename:'ComfyUI_01940_.png',subfolder:'inpaint_canvas',type:'input'},layers:[],prompt:'red silk swimsuit',crop:{context:'auto',feather:'auto',fill:'none',colorMatch:true}}));
await window.__wait(1500);
app.canvas.ds.scale = 0.7; app.canvas.ds.offset = [60, 170]; app.canvas.setDirty(true, true);
await window.__wait(800);
return c.outputs.length;
"""),
    ("local-settings", r"""
const ed = window.__ed; ed.open(); await window.__wait(1200);
ed.setTool('select');
ed.segInput.value = 'swimsuit'; ed.segMode = 'replace'; ed.segBackendSel.value = 'sam3_rmbg'; ed.segmentByText();
await window.__until(async () => !ed.segmentPending && ed.getBounds(), 90000);
ed.modeSel.value = 'local'; ed.modeSel.dispatchEvent(new Event('change'));
ed.negativeInput.value = 'blurry, low quality'; ed.negativeText = ed.negativeInput.value;
if (!ed.genSettings.refine) ed.refineBtn.click();
ed.settingsChanged(); ed.renderInfo(); await window.__wait(400);
return { settings: Object.keys(ed.settings), status: ed.status };
"""),
    ("editor", r"""
const ed = window.__ed; ed.open(); await window.__wait(1200);
ed.setTool('select');
// select-by-text "woman" via SAM3 so the editor shows a real selection
ed.segInput.value = 'woman'; ed.segMode = 'replace'; ed.segBackendSel.value = 'sam3_rmbg'; ed.segmentByText();
const ok = await window.__until(async () => !ed.segmentPending && ed.getBounds(), 90000);
ed.setTool('select'); await window.__wait(500);
return { ok, status: ed.status };
"""),
    ("object-hover", r"""
const ed = window.__ed;
ed.clearSelection(); ed.setTool('object');
await window.__until(async () => ed.objects && !ed.objectsPending, 120000);
window.__ipcEv(ed, 'pointermove', 888, 1000, { buttons: 0 });
window.__ipcEv(ed, 'pointerdown', 888, 300); window.__ipcEv(ed, 'pointerup', 888, 300);   // face -> selected
window.__ipcEv(ed, 'pointermove', 888, 1000, { buttons: 0 });                              // hover swimsuit
await window.__wait(300);
return { status: ed.status, hover: ed.hoverObjectId };
"""),
    ("layers", r"""
const ed = window.__ed;
ed.modeSel.value = 'api'; ed.modeSel.dispatchEvent(new Event('change'));
ed.clearSelection();
// a text layer, a film grain filter layer and the result layer, transform bar open
const T = await ed.addTextLayer(120, 120); T.text.content = 'Inpaint\nCanvas'; T.text.font = 'Bebas Neue'; T.text.size = 220; T.text.color = '#ffffff'; T.text.outline = 6; T.text.outlineColor = '#000000';
await ed.renderTextLayer(T); await window.__wait(600);
const F = ed.addFilterLayer('grain'); F.params.preset = 'portra400'; F.params.amount = 18; F.params.size = 1.5; F.params.chroma = 30; F.name = 'Kodak Portra 400'; ed.markFilterChanged(F);
ed.activeLayerId = T.id; ed.setTool('transform'); ed.renderLayers(); ed.draw(); await window.__wait(600);
return { layers: ed.layers.map(l => l.name) };
"""),
    ("result", r"""
const ed = window.__ed;
// the local-settings scene left the editor in local mode, where the result is expected on result_local
ed.modeSel.value = 'api'; ed.modeSel.dispatchEvent(new Event('change'));
ed.setTool('select'); ed.clearSelection();
ed.segInput.value = 'swimsuit'; ed.segMode = 'replace'; ed.segmentByText();
await window.__until(async () => !ed.segmentPending && ed.getBounds(), 90000);
ed.promptInput.value = 'red silk swimsuit'; ed.promptText = ed.promptInput.value;
const before = ed.history.length;
await ed.generate();
const ok = await window.__until(async () => ed.history.length > before, 120000);
await window.__wait(800);
return { ok, hist: ed.history.length, status: ed.status };
"""),
]


async def main():
    pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    page = next((p for p in pages if p.get("type") == "page" and "8188" in p.get("url", "")), None)
    assert page, pages
    async with aiohttp.ClientSession() as sess:
        async with sess.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024) as ws:
            mid = 0

            async def call(method, **params):
                nonlocal mid
                mid += 1
                await ws.send_json({"id": mid, "method": method, "params": params})
                while True:
                    msg = await ws.receive_json()
                    if msg.get("id") == mid:
                        if "error" in msg:
                            raise RuntimeError(msg["error"])
                        return msg.get("result", {})

            async def js(expr, timeout=180):
                src = f"(async () => {{ {expr} }})()"
                r = await call("Runtime.evaluate", expression=src, awaitPromise=True, returnByValue=True, timeout=timeout * 1000)
                if "exceptionDetails" in r:
                    raise RuntimeError(json.dumps(r["exceptionDetails"])[:800])
                return r.get("result", {}).get("value")

            async def shot(name):
                r = await call("Page.captureScreenshot", format="png")
                path = os.path.join(OUT, f"{name}.png")
                open(path, "wb").write(base64.b64decode(r["data"]))
                print("saved", path)

            await call("Page.enable")
            await call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
            print("waiting for ComfyUI ...")
            t0 = time.time()
            while time.time() - t0 < 420:
                ready = await js("return !!(window.LiteGraph && LiteGraph.registered_node_types['InpaintCanvas'] && window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app.graph);")
                if ready:
                    break
                await asyncio.sleep(3)
            print(f"ready after {time.time() - t0:.0f}s")
            await asyncio.sleep(20)   # let the workflow restore (if any) settle
            await js(HELPERS + " return 1;")
            only = sys.argv[1:] or [n for n, _ in SCENES]
            for name, code in SCENES:
                if name not in only:
                    continue
                res = await js(code)
                print(name, "->", res)
                await shot(name)

asyncio.run(main())
