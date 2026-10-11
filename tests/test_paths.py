"""Path tests for nodes.py: every client-given name stays inside ComfyUI's input, output and temp folders.

Plain Python, no ComfyUI needed: folder_paths, server, comfy.utils and comfy_execution are stubbed, the
folders live in a temporary directory. Needs torch, numpy, Pillow and aiohttp (all of them ship with
ComfyUI). Run from the repository root:

    python -m unittest discover -s tests -v

This folder is not part of the registry package (.comfyignore).
"""

import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock
from urllib.parse import quote, urlencode

import torch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIRS = {}   # filled per test: input, output, temp, user


def _install_stubs():
    fp = types.ModuleType("folder_paths")
    fp.get_input_directory = lambda: DIRS["input"]
    fp.get_output_directory = lambda: DIRS["output"]
    fp.get_temp_directory = lambda: DIRS["temp"]
    fp.get_user_directory = lambda: DIRS["user"]
    sys.modules["folder_paths"] = fp

    comfy = types.ModuleType("comfy")
    utils = types.ModuleType("comfy.utils")

    def common_upscale(samples, width, height, method, crop):
        return torch.nn.functional.interpolate(samples, size=(height, width), mode="bilinear", align_corners=False)

    utils.common_upscale = common_upscale
    comfy.utils = utils
    sys.modules["comfy"] = comfy
    sys.modules["comfy.utils"] = utils

    ce = types.ModuleType("comfy_execution")
    gu = types.ModuleType("comfy_execution.graph_utils")
    gu.GraphBuilder = type("GraphBuilder", (), {})
    ce.graph_utils = gu
    sys.modules["comfy_execution"] = ce
    sys.modules["comfy_execution.graph_utils"] = gu

    srv = types.ModuleType("server")

    class PromptServer:
        instance = types.SimpleNamespace(routes=web.RouteTableDef(), sockets={}, send_sync=lambda *a, **k: None)

    srv.PromptServer = PromptServer
    sys.modules["server"] = srv
    return PromptServer.instance


SERVER = _install_stubs()
_spec = importlib.util.spec_from_file_location("inpaint_canvas_nodes", os.path.join(ROOT, "nodes.py"))
nodes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nodes)


def _png(path, size=(8, 6), color=(200, 30, 30)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", size, color).save(path)


def _make_link(link, target, directory=True):
    """A symlink, or on Windows a junction when symlinks need a privilege. Returns the kind made, or None."""
    try:
        os.symlink(target, link, target_is_directory=directory)
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt" and directory:
        import _winapi
        try:
            _winapi.CreateJunction(target, link)
            return "junction"
        except OSError:
            return None
    return None


def _remove_link(link):
    """Remove a symlink or junction without touching what it points to."""
    try:
        if os.path.isdir(link) and not os.path.islink(link):
            os.rmdir(link)   # a junction
        else:
            os.unlink(link)
    except FileNotFoundError:
        pass
    except OSError:
        os.rmdir(link)


class PathBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ic_paths_")
        for kind in ("input", "output", "temp", "user"):
            DIRS[kind] = os.path.join(self.tmp, "ComfyUI", kind)
            os.makedirs(DIRS[kind])
        self.outside = os.path.join(self.tmp, "outside")
        os.makedirs(self.outside)
        _png(os.path.join(self.outside, "secret.png"))
        _png(os.path.join(DIRS["input"], "inpaint_canvas", "photo.png"))
        _png(os.path.join(DIRS["input"], "inpaint_canvas", "my image (1).png"))
        _png(os.path.join(DIRS["input"], "inpaint_canvas", "fonts", "x.png"))
        _png(os.path.join(DIRS["input"], "top.png"))
        _png(os.path.join(DIRS["output"], "inpaint_canvas", "n3_result_1.png"))
        _png(os.path.join(DIRS["temp"], "inpaint_canvas", "n3_segment_1.png"))
        self.links = []

    def tearDown(self):
        for link in reversed(self.links):
            _remove_link(link)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def link(self, link, target, directory=True):
        kind = _make_link(link, target, directory)
        if kind is None:
            self.skipTest("cannot create a symlink or junction here")
        self.links.append(link)
        return kind

    def outside_files(self):
        return sorted(os.listdir(self.outside))

    def real(self, *parts):
        return os.path.realpath(os.path.join(*parts))


class RefPathTests(PathBase):
    def test_valid_references_resolve_as_before(self):
        cases = [
            ({"filename": "photo.png", "subfolder": "inpaint_canvas", "type": "input"}, ("input", "inpaint_canvas", "photo.png")),
            ({"filename": "photo.png", "subfolder": "inpaint_canvas"}, ("input", "inpaint_canvas", "photo.png")),
            ({"filename": "my image (1).png", "subfolder": "inpaint_canvas", "type": "input"}, ("input", "inpaint_canvas", "my image (1).png")),
            ({"filename": "x.png", "subfolder": "inpaint_canvas/fonts", "type": "input"}, ("input", "inpaint_canvas", "fonts", "x.png")),
            ({"filename": "top.png", "subfolder": "", "type": "input"}, ("input", "top.png")),
            ({"filename": "top.png", "subfolder": ".", "type": "input"}, ("input", "top.png")),
            ({"filename": "n3_result_1.png", "subfolder": "inpaint_canvas", "type": "output"}, ("output", "inpaint_canvas", "n3_result_1.png")),
            ({"filename": "n3_segment_1.png", "subfolder": "inpaint_canvas", "type": "temp"}, ("temp", "inpaint_canvas", "n3_segment_1.png")),
            ({"filename": "top.png", "type": "something else"}, ("input", "top.png")),
        ]
        if os.name == "nt":
            cases.append(({"filename": "x.png", "subfolder": "inpaint_canvas\\fonts"}, ("input", "inpaint_canvas", "fonts", "x.png")))
        for ref, (kind, *rest) in cases:
            with self.subTest(ref=ref):
                self.assertTrue(os.path.samefile(nodes._ref_path(ref), os.path.join(DIRS[kind], *rest)))

    def test_valid_reference_loads(self):
        img = nodes._load_rgb({"filename": "photo.png", "subfolder": "inpaint_canvas", "type": "input"})
        self.assertEqual(tuple(img.shape), (1, 6, 8, 3))

    def test_missing_file_is_not_found(self):
        with self.assertRaises(FileNotFoundError):
            nodes._ref_path({"filename": "nope.png", "subfolder": "inpaint_canvas"})

    def test_traversal_and_absolute_names_are_refused(self):
        secret = os.path.join(self.outside, "secret.png")
        rel_secret = os.path.relpath(secret, os.path.join(DIRS["input"], "inpaint_canvas"))
        bad = [
            {"filename": rel_secret, "subfolder": "inpaint_canvas"},
            {"filename": "secret.png", "subfolder": "../../outside"},
            {"filename": "secret.png", "subfolder": "..\\..\\outside"},
            {"filename": "secret.png", "subfolder": "inpaint_canvas/../../../outside"},
            {"filename": "../../outside/secret.png", "subfolder": ""},
            {"filename": "..", "subfolder": "inpaint_canvas"},
            {"filename": ".", "subfolder": "inpaint_canvas"},
            {"filename": secret, "subfolder": ""},
            {"filename": "photo.png", "subfolder": self.outside},
            {"filename": "/etc/passwd", "subfolder": ""},
            {"filename": "\\Windows\\win.ini", "subfolder": ""},
            {"filename": "\\\\server\\share\\x.png", "subfolder": ""},
            {"filename": "C:\\Windows\\win.ini", "subfolder": ""},
            {"filename": "D:x.png", "subfolder": ""},
            {"filename": "x.png", "subfolder": "Z:/"},
            {"filename": "photo.png\x00.txt", "subfolder": "inpaint_canvas"},
            {"filename": "photo.png", "subfolder": "inpaint_canvas\x00"},
            {"filename": "", "subfolder": "inpaint_canvas"},
            {},
            None,
            "photo.png",
        ]
        if os.name == "nt":
            bad.append({"filename": "photo.png:stream", "subfolder": "inpaint_canvas"})
        for ref in bad:
            with self.subTest(ref=ref):
                with self.assertRaises(ValueError):
                    nodes._ref_path(ref)

    def test_names_the_file_system_rewrites_are_refused(self):
        bad = [
            {"filename": "...", "subfolder": "inpaint_canvas"},
            {"filename": " ", "subfolder": "inpaint_canvas"},
            {"filename": ". .", "subfolder": "inpaint_canvas"},
            {"filename": "top.png", "subfolder": "..."},
            {"filename": "photo.png", "subfolder": "inpaint_canvas/..."},
            {"filename": "x.png", "subfolder": "inpaint_canvas/ /fonts"},
        ]
        if os.name == "nt":
            # Windows drops a trailing '.' or ' ': each of these was an alias of an existing file before
            bad += [
                {"filename": "photo.png.", "subfolder": "inpaint_canvas"},
                {"filename": "photo.png ", "subfolder": "inpaint_canvas"},
                {"filename": "photo.png", "subfolder": "inpaint_canvas."},
                {"filename": "x.png", "subfolder": "inpaint_canvas/fonts "},
                {"filename": "nul", "subfolder": ""},
                {"filename": "CON.png", "subfolder": "inpaint_canvas"},
                {"filename": "x.png", "subfolder": "inpaint_canvas/COM1"},
                {"filename": "a?.png", "subfolder": "inpaint_canvas"},
            ]
        for ref in bad:
            with self.subTest(ref=ref):
                with self.assertRaises(ValueError):
                    nodes._ref_path(ref)

    def test_url_encoded_names_stay_literal(self):
        # The node never URL-decodes a reference: "%2e%2e" is a plain folder name inside the input folder.
        for ref in ({"filename": "secret.png", "subfolder": "%2e%2e/%2e%2e/outside"},
                    {"filename": "..%2F..%2Foutside%2Fsecret.png", "subfolder": ""},
                    {"filename": "%252e%252e%252fsecret.png", "subfolder": ""}):
            with self.subTest(ref=ref):
                with self.assertRaises(FileNotFoundError) as cm:
                    nodes._ref_path(ref)
                self.assertIn(os.path.normcase(os.path.realpath(DIRS["input"])), os.path.normcase(str(cm.exception)))

    def test_directory_link_out_of_input_is_refused(self):
        kind = self.link(os.path.join(DIRS["input"], "inpaint_canvas", "escape"), self.outside)
        with self.assertRaises(ValueError, msg=kind):
            nodes._ref_path({"filename": "secret.png", "subfolder": "inpaint_canvas/escape"})

    def test_junction_out_of_input_is_refused(self):
        if os.name != "nt":
            self.skipTest("junctions are Windows only")
        import _winapi
        link = os.path.join(DIRS["input"], "junction")
        _winapi.CreateJunction(self.outside, link)
        self.links.append(link)
        with self.assertRaises(ValueError):
            nodes._ref_path({"filename": "secret.png", "subfolder": "junction"})

    def test_junction_to_another_drive_is_refused(self):
        if os.name != "nt":
            self.skipTest("drives are Windows only")
        here = os.path.splitdrive(os.path.realpath(ROOT))[0].upper()
        if os.path.splitdrive(os.path.realpath(self.tmp))[0].upper() == here:
            self.skipTest("the repository and the temp folder are on the same drive")
        import _winapi
        link = os.path.join(DIRS["input"], "otherdrive")
        _winapi.CreateJunction(os.path.join(ROOT, "tests"), link)   # only pointed at, never written to
        self.links.append(link)
        with self.assertRaises(ValueError):
            nodes._ref_path({"filename": "test_paths.py", "subfolder": "otherdrive"})

    def test_file_link_out_of_input_is_refused(self):
        link = os.path.join(DIRS["input"], "inpaint_canvas", "linked.png")
        self.link(link, os.path.join(self.outside, "secret.png"), directory=False)
        with self.assertRaises(ValueError):
            nodes._ref_path({"filename": "linked.png", "subfolder": "inpaint_canvas"})

    def test_link_that_stays_inside_still_works(self):
        self.link(os.path.join(DIRS["input"], "alias"), os.path.join(DIRS["input"], "inpaint_canvas"))
        path = nodes._ref_path({"filename": "photo.png", "subfolder": "alias"})
        self.assertEqual(os.path.normcase(path), os.path.normcase(self.real(DIRS["input"], "inpaint_canvas", "photo.png")))

    def test_load_ref_node(self):
        good = json.dumps({"filename": "photo.png", "subfolder": "inpaint_canvas", "type": "input"})
        self.assertEqual(tuple(nodes.InpaintCanvasLoadRef().load(good)[0].shape), (1, 6, 8, 3))
        bad = json.dumps({"filename": "secret.png", "subfolder": "../../outside", "type": "input"})
        with self.assertRaises(ValueError):
            nodes.InpaintCanvasLoadRef().load(bad)
        self.assertNotEqual(nodes.InpaintCanvasLoadRef.IS_CHANGED(bad), nodes.InpaintCanvasLoadRef.IS_CHANGED(bad))   # NaN


class NameRuleTests(unittest.TestCase):
    """_check_name with both rule sets, whatever the OS the tests run on."""

    VALID = ("photo.png", "my image (1).png", "n1_base_abc.png", ".hidden", "a..b.png", " leading.png", "x.con",
             "CONSOLE.png", "nul_x.png", "COM10.png", "LPT.png", "inpaint_canvas/fonts", "inpaint_canvas\\fonts",
             ".", "", "inpaint_canvas/./fonts", "%2e%2e")
    ONLY_DOTS_OR_SPACES = ("...", "....", " ", "  ", ". .", " .", ". ", "inpaint_canvas/...", "a/ /b", "a\\...\\b")
    WINDOWS_ONLY = ("a.", "a.png.", "a ", "a.png ", "inpaint_canvas./x.png", "inpaint_canvas /x.png",
                    "NUL", "nul", "Nul.png", "nul .png", "CON", "con.tar.gz", "PRN", "AUX.txt", "COM1", "com1.png",
                    "COM9", "COM0", "LPT1", "lpt1.txt", "LPT0", "COM" + chr(0xB9), "lpt" + chr(0xB3) + ".png",
                    "CONIN$", "conout$.txt", "inpaint_canvas/CON/x.png", "inpaint_canvas\\nul",
                    "a?.png", "a*.png", 'a"b.png', "a<b.png", "a>b.png", "a|b.png", "a" + chr(1) + "b.png",
                    "a" + chr(31) + ".png", "a\tb.png")

    def test_valid_names_pass(self):
        for name in self.VALID:
            for windows in (False, True):
                with self.subTest(name=name, windows=windows):
                    nodes._check_name(name, windows=windows)

    def test_only_dots_or_spaces_are_refused_everywhere(self):
        for name in self.ONLY_DOTS_OR_SPACES:
            for windows in (False, True):
                with self.subTest(name=name, windows=windows):
                    with self.assertRaises(ValueError):
                        nodes._check_name(name, windows=windows)

    def test_windows_rules(self):
        for name in self.WINDOWS_ONLY:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    nodes._check_name(name, windows=True)
                nodes._check_name(name, windows=False)   # valid names on other systems

    def test_inside_applies_the_rules(self):
        base = tempfile.mkdtemp(prefix="ic_names_")
        try:
            self.assertEqual(os.path.normcase(nodes._inside(base, "inpaint_canvas", "photo.png")),
                             os.path.normcase(os.path.join(os.path.realpath(base), "inpaint_canvas", "photo.png")))
            for parts in (("...",), ("inpaint_canvas", "..."), ("...", "photo.png"), (" ",)):
                with self.subTest(parts=parts):
                    with self.assertRaises(ValueError):
                        nodes._inside(base, *parts)
            if os.name == "nt":
                for parts in (("photo.png.",), ("NUL",), ("inpaint_canvas", "com1.png"), ("a?.png",)):
                    with self.subTest(parts=parts):
                        with self.assertRaises(ValueError):
                            nodes._inside(base, *parts)
        finally:
            shutil.rmtree(base, ignore_errors=True)


class WriteNameTests(PathBase):
    def test_name_token(self):
        self.assertEqual(nodes._name_token("12"), "12")
        self.assertEqual(nodes._name_token(7), "7")
        self.assertEqual(nodes._name_token(""), "x")
        self.assertEqual(nodes._name_token(None), "x")
        self.assertEqual(nodes._name_token("segments", ""), "segments")
        self.assertEqual(nodes._name_token("", ""), "")
        for raw in ("../../x", "..\\..\\x", "C:\\x", "/etc/x", "a\x00b", "a:b"):
            tok = nodes._name_token(raw)
            self.assertFalse(set(tok) & set("/\\:\x00"), tok)

    def _mask_out(self, canvas_node, purpose):
        res = nodes.InpaintCanvasMaskOut().send(torch.ones((4, 5)), canvas_node=canvas_node, purpose=purpose)
        return res["ui"]["inpaint_mask"][0]

    def test_mask_out_valid_names_unchanged(self):
        info = self._mask_out("12", "segment")
        self.assertRegex(info["filename"], r"^n12_segment_\d{6}_\d{3}\.png$")
        self.assertTrue(os.path.isfile(os.path.join(DIRS["temp"], "inpaint_canvas", info["filename"])))
        info = self._mask_out("", "cutout")
        self.assertTrue(info["filename"].startswith("nx_cutout_"))

    def test_mask_out_cannot_write_outside(self):
        before = self.outside_files()
        # 0.3.3 put these into the file name as they came; each one reaches the outside folder from temp/inpaint_canvas
        rel = os.path.relpath(self.outside, os.path.join(DIRS["temp"], "inpaint_canvas")).replace("\\", "/")
        for canvas_node, purpose in (("1", "/../" + rel + "/evil"), ("/../" + rel + "/evil", "segment"),
                                     ("1", ("/../" + rel + "/evil").replace("/", "\\")), ("1", self.outside + os.sep + "evil"),
                                     ("C:\\evil", "segment"), ("1", "segments/../" + rel + "/evil")):
            with self.subTest(canvas_node=canvas_node, purpose=purpose):
                info = self._mask_out(canvas_node, purpose)
                self.assertNotIn("/", info["filename"])
                self.assertNotIn("\\", info["filename"])
                self.assertTrue(os.path.isfile(os.path.join(DIRS["temp"], "inpaint_canvas", info["filename"])))
                self.assertEqual(info["canvas_node"], canvas_node)   # echoed back unchanged for the editor
        self.assertEqual(self.outside_files(), before)

    def test_mask_out_odd_ids_still_write_inside(self):
        # a token sits inside "n<id>_<purpose>_<stamp>.png": dots, spaces and device names are harmless there
        for canvas_node, purpose in (("1", "..."), ("...", "segment"), ("nul", "con"), ("5.", "x "), ("COM1", "lpt1")):
            with self.subTest(canvas_node=canvas_node, purpose=purpose):
                info = self._mask_out(canvas_node, purpose)
                self.assertTrue(os.path.isfile(os.path.join(DIRS["temp"], "inpaint_canvas", info["filename"])), info)

    def test_stitch_cannot_write_outside(self):
        before = self.outside_files()
        base = {"filename": "photo.png", "subfolder": "inpaint_canvas", "type": "input"}
        rel = os.path.relpath(self.outside, os.path.join(DIRS["output"], "inpaint_canvas")).replace("\\", "/")
        for node_id in ("5", "/../" + rel + "/evil", ("/../" + rel + "/evil").replace("/", "\\"), "C:\\evil"):
            with self.subTest(node_id=node_id):
                info = json.dumps({"canvas_node": node_id, "base": base, "mask": None, "bbox": [1, 1, 4, 3],
                                   "emitted": [4, 3], "align": False, "feather": 0, "width": 8, "height": 6})
                res = nodes.InpaintCanvasStitch().stitch(torch.zeros((1, 3, 4, 3)), info)
                name = res["ui"]["inpaint_result"][0]["filename"]
                self.assertNotIn("/", name)
                self.assertNotIn("\\", name)
                self.assertTrue(os.path.isfile(os.path.join(DIRS["output"], "inpaint_canvas", name)))
                if node_id == "5":
                    self.assertRegex(name, r"^n5_result_\d{8}_\d{6}(_\d+)?\.png$")
        self.assertEqual(self.outside_files(), before)

    def test_stitch_refuses_a_base_outside(self):
        info = json.dumps({"canvas_node": "5", "base": {"filename": "secret.png", "subfolder": "../../outside"},
                           "mask": None, "bbox": [0, 0, 4, 3], "emitted": [4, 3], "align": False, "width": 8, "height": 6})
        with self.assertRaises(ValueError):
            nodes.InpaintCanvasStitch().stitch(torch.zeros((1, 3, 4, 3)), info)


class RouteTests(PathBase):
    def setUp(self):
        super().setUp()
        self.loop = asyncio.new_event_loop()
        app = web.Application()
        app.add_routes(SERVER.routes)
        self.client = TestClient(TestServer(app), loop=self.loop)
        self.loop.run_until_complete(self.client.start_server())

    def tearDown(self):
        self.loop.run_until_complete(self.client.close())
        self.loop.close()
        parts = self.parts()
        super().tearDown()
        self.assertEqual(parts, [], "an upload left a .part file behind")

    def parts(self):
        return [f for f in self.all_files() if f.endswith(".part")]

    def upload(self, query, body=b"PNGDATA"):
        async def go():
            resp = await self.client.post("/inpaint_canvas/upload?" + query, data=body,
                                          headers={"Content-Type": "application/octet-stream"})
            try:
                data = await resp.json()
            except Exception:
                data = None
            return resp.status, data
        return self.loop.run_until_complete(go())

    def all_files(self):
        out = []
        for root, _dirs, files in os.walk(self.tmp):
            out += [os.path.relpath(os.path.join(root, f), self.tmp) for f in files]
        return sorted(out)

    def test_valid_upload(self):
        status, data = self.upload("filename=n1_base_abc.png&subfolder=inpaint_canvas&type=input&overwrite=true")
        self.assertEqual(status, 200, data)
        self.assertEqual(data, {"name": "n1_base_abc.png", "subfolder": "inpaint_canvas", "type": "input", "size": 7})
        with open(os.path.join(DIRS["input"], "inpaint_canvas", "n1_base_abc.png"), "rb") as f:
            self.assertEqual(f.read(), b"PNGDATA")
        status, data = self.upload("filename=n1_base_abc.png&subfolder=inpaint_canvas&type=input&overwrite=false", b"OTHER")
        self.assertEqual((status, data["name"]), (200, "n1_base_abc (1).png"))
        status, data = self.upload("filename=top.png&type=temp")
        self.assertEqual((status, data["subfolder"]), (200, ""))
        status, data = self.upload("filename=f.ttf&subfolder=inpaint_canvas%2Ffonts&type=input")
        self.assertEqual(status, 200, data)
        self.assertTrue(os.path.isfile(os.path.join(DIRS["input"], "inpaint_canvas", "fonts", "f.ttf")))

    def test_upload_traversal_is_refused(self):
        before = self.all_files()
        sep = "%5C"
        queries = [
            "filename=a.png&subfolder=..&type=input",
            "filename=a.png&subfolder=..%2F..%2Foutside&type=input",
            "filename=a.png&subfolder=.." + sep + ".." + sep + "outside&type=input",
            "filename=a.png&subfolder=inpaint_canvas%2F..%2F..%2F..%2Foutside&type=input",
            "filename=a.png&subfolder=%2Fetc&type=input",
            "filename=a.png&subfolder=" + self.outside.replace("\\", "%5C").replace(":", "%3A") + "&type=input",
            "filename=a.png&subfolder=Z%3A%5Cx&type=input",
            "filename=a.png&subfolder=Z%3Ax&type=input",
            "filename=a.png&subfolder=inpaint_canvas%00&type=input",
            "filename=a%00.png&subfolder=inpaint_canvas&type=input",
            "filename=..&subfolder=inpaint_canvas&type=input",
            "filename=&subfolder=inpaint_canvas&type=input",
            "filename=a.png&subfolder=inpaint_canvas&type=..%2Finput",
        ]
        for q in queries:
            with self.subTest(query=q):
                status, _data = self.upload(q)
                self.assertEqual(status, 400, q)
        self.assertEqual(self.all_files(), before)

    def test_upload_filename_path_parts_are_dropped(self):
        # basename() keeps the last part: the file lands in the requested folder, never outside
        before = self.outside_files()
        for name in ("..%2F..%2F..%2Foutside%2Fevil.png", "%2Ftmp%2Fevil.png"):
            with self.subTest(name=name):
                status, data = self.upload("filename=" + name + "&subfolder=inpaint_canvas&type=input")
                self.assertEqual(status, 200, data)
                self.assertTrue(os.path.isfile(os.path.join(DIRS["input"], "inpaint_canvas", data["name"])))
        if os.name == "nt":
            status, data = self.upload("filename=..%5C..%5C..%5Coutside%5Cevil2.png&subfolder=inpaint_canvas&type=input")
            self.assertEqual((status, data["name"]), (200, "evil2.png"))
        self.assertEqual(self.outside_files(), before)

    def test_upload_dot_and_space_names_are_refused(self):
        # "..." with overwrite=true was a 500 that left a .part file on Windows (the name is the folder there)
        before = self.all_files()
        cases = [("...", "inpaint_canvas"), ("....", "inpaint_canvas"), (". .", "inpaint_canvas"), (". . .", ""),
                 ("a.png", "..."), ("a.png", "inpaint_canvas/..."), ("a.png", "inpaint_canvas/ . /x"), ("...", "")]
        for name, sub in cases:
            for overwrite in ("true", "false"):
                q = urlencode({"filename": name, "subfolder": sub, "type": "input", "overwrite": overwrite}, quote_via=quote)
                with self.subTest(query=q):
                    status, data = self.upload(q)
                    self.assertEqual(status, 400, data)
                    self.assertIn("error", data)
        self.assertEqual(self.all_files(), before)

    def test_upload_windows_names_are_refused(self):
        if os.name != "nt":
            self.skipTest("Windows naming rules")
        before = self.all_files()
        cases = [("a.png.", "inpaint_canvas"), ("photo.png.", "inpaint_canvas"), ("nul", "inpaint_canvas"),
                 ("NUL.png", "inpaint_canvas"), ("con.tar.gz", ""), ("COM1.png", "inpaint_canvas"), ("lpt9", ""),
                 ("COM" + chr(0xB9) + ".png", ""), ("a?.png", "inpaint_canvas"), ("a*.png", ""), ('a".png', ""),
                 ("a|.png", ""), ("a<b>.png", ""), ("a" + chr(1) + ".png", "inpaint_canvas"),
                 ("a.png", "CON"), ("a.png", "inpaint_canvas."), ("a.png", "inpaint_canvas/nul"),
                 ("a.png", "inpaint_canvas/fonts./x")]
        for name, sub in cases:
            for overwrite in ("true", "false"):
                q = urlencode({"filename": name, "subfolder": sub, "type": "input", "overwrite": overwrite}, quote_via=quote)
                with self.subTest(query=q):
                    status, data = self.upload(q)
                    self.assertEqual(status, 400, data)
        self.assertEqual(self.all_files(), before)
        # surrounding spaces are stripped from the name and the subfolder, as before
        status, data = self.upload(urlencode({"filename": " b.png ", "subfolder": "inpaint_canvas ", "type": "input"}, quote_via=quote))
        self.assertEqual((status, data["name"], data["subfolder"]), (200, "b.png", "inpaint_canvas"))

    def test_upload_never_leaves_a_part_file(self):
        folder = os.path.join(DIRS["input"], "inpaint_canvas")
        os.makedirs(os.path.join(folder, "taken.png"))
        q = "filename=taken.png&subfolder=inpaint_canvas&type=input"
        status, data = self.upload(q + "&overwrite=true")   # a folder of that name: os.replace would fail
        self.assertEqual(status, 400, data)
        self.assertEqual(self.parts(), [])
        status, data = self.upload(q + "&overwrite=false")  # renamed past the folder, as before
        self.assertEqual((status, data["name"]), (200, "taken (1).png"))
        status, data = self.upload("filename=a.png&subfolder=inpaint_canvas%2Fphoto.png&type=input")
        self.assertEqual(status, 400, data)                  # the subfolder is a file
        status, data = self.upload("filename=empty.png&subfolder=inpaint_canvas&type=input", b"")
        self.assertEqual(status, 400, data)
        self.assertEqual(self.parts(), [])
        with mock.patch.object(nodes, "UPLOAD_MAX_BYTES", 4):
            status, data = self.upload("filename=big.png&subfolder=inpaint_canvas&type=input")
        self.assertEqual(status, 413, data)
        self.assertEqual(self.parts(), [])
        with mock.patch.object(nodes.os, "replace", side_effect=OSError("disk full")):
            status, data = self.upload("filename=fail.png&subfolder=inpaint_canvas&type=input&overwrite=true")
        self.assertEqual((status, data), (500, {"error": "disk full"}))
        self.assertEqual(self.parts(), [])
        status, data = self.upload("filename=same.png&subfolder=inpaint_canvas&type=input")
        self.assertEqual((status, data["name"]), (200, "same.png"))
        status, data = self.upload("filename=same.png&subfolder=inpaint_canvas&type=input&overwrite=false")
        self.assertEqual((status, data["name"]), (200, "same.png"))   # same bytes: the existing file is kept
        self.assertEqual(self.parts(), [])
        names = [os.path.basename(f) for f in self.all_files()]
        for name in ("big.png", "fail.png", "empty.png", "a.png"):
            self.assertNotIn(name, names)

    def test_upload_double_encoded_stays_inside(self):
        # aiohttp decodes once: "%252e%252e" arrives as the literal folder name "%2e%2e", inside input/
        status, data = self.upload("filename=a.png&subfolder=%252e%252e%252foutside&type=input")
        self.assertEqual(status, 200, data)
        found = [f for f in self.all_files() if f.endswith("a.png")]
        self.assertEqual(len(found), 1)
        self.assertTrue(os.path.normcase(os.path.join(self.tmp, found[0])).startswith(os.path.normcase(DIRS["input"])), found)

    def test_upload_through_a_link_is_refused(self):
        before = self.outside_files()
        self.link(os.path.join(DIRS["input"], "escape"), self.outside)
        status, _ = self.upload("filename=evil.png&subfolder=escape&type=input")
        self.assertEqual(status, 400)
        self.link(os.path.join(DIRS["input"], "inpaint_canvas", "linked.png"), os.path.join(self.outside, "secret.png"), directory=False)
        status, _ = self.upload("filename=linked.png&subfolder=inpaint_canvas&type=input&overwrite=true")
        self.assertEqual(status, 400)
        self.assertEqual(self.outside_files(), before)
        with open(os.path.join(self.outside, "secret.png"), "rb") as f:
            self.assertTrue(f.read().startswith(b"\x89PNG"))

    def test_upload_through_a_junction_is_refused(self):
        if os.name != "nt":
            self.skipTest("junctions are Windows only")
        import _winapi
        link = os.path.join(DIRS["output"], "junction")
        _winapi.CreateJunction(self.outside, link)
        self.links.append(link)
        before = self.outside_files()
        status, _ = self.upload("filename=evil.png&subfolder=junction&type=output")
        self.assertEqual(status, 400)
        self.assertEqual(self.outside_files(), before)

    def test_cleanup_leaves_links_and_their_targets(self):
        target = os.path.join(self.outside, "secret.png")
        link = os.path.join(DIRS["temp"], "inpaint_canvas", "n9_segment_link.png")
        self.link(link, target, directory=False)
        os.utime(os.path.join(DIRS["temp"], "inpaint_canvas", "n3_segment_1.png"), (1, 1))

        async def go():
            resp = await self.client.post("/inpaint_canvas/cleanup", json={"keep": [], "dry_run": False, "min_age": 0})
            return resp.status, await resp.json()
        status, data = self.loop.run_until_complete(go())
        self.assertEqual(status, 200)
        self.assertIn("temp/n3_segment_1.png", data["files"])
        self.assertNotIn("temp/n9_segment_link.png", data["files"])
        self.assertTrue(os.path.lexists(link))
        self.assertTrue(os.path.isfile(target))


if __name__ == "__main__":
    unittest.main(verbosity=2)
