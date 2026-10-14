"""Box prompting tests: boxes_rows.py against the vectors of Scumble's writer, and Python-only cases.

tests/boxes_vectors.json is a copy of Scumble's tools/boxes_vectors.json, computed by the app's
electron/main/providers/boxes.js; every vector here must come out the same, to the character. Run from the
repository root:

    python -m unittest discover -s tests -v
"""

import importlib.util
import json
import math
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

import test_paths as tp   # one stub install for both test files (folder_paths, comfy.utils, server ...)

nodes = tp.nodes
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _load_rows():
    """boxes_rows.py as nodes.py loads it (one module object under one name)."""
    name = "inpaint_canvas_boxes_rows"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "boxes_rows.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


R = _load_rows()
with open(os.path.join(HERE, "boxes_vectors.json"), encoding="utf-8") as f:
    V = json.load(f)


def js(v):
    """A value as JSON.stringify writes it (so 250 and 250.0 differ, as they would in a prompt)."""
    return R.dumps(v)


class VectorTests(unittest.TestCase):
    """Every vector of the app's writer, to the character."""

    def test_round(self):
        for x, want in V["round"]:
            self.assertEqual(R.js_round(x), want, x)
            self.assertIsInstance(R.js_round(x), int)

    def test_grid(self):
        for rect, want in V["grid"]:
            self.assertEqual(js(R.grid(rect)), js(want), rect)

    def test_where_and_way(self):
        for g, want in V["where"]:
            self.assertEqual(R.where_words(g), want, g)
        for a, b, want in V["way"]:
            self.assertEqual(R.way_words(a, b), want, (a, b))

    def test_check(self):
        for v in V["check"]:
            with self.subTest(boxes=v["boxes"]):
                if v["error"] is None:
                    self.assertIs(R.check_boxes(v["boxes"]), v["boxes"])
                else:
                    with self.assertRaises(R.BoxError) as cm:
                        R.check_boxes(v["boxes"])
                    self.assertEqual(str(cm.exception), v["error"])

    def test_rows(self):
        for v in V["rows"]:
            with self.subTest(boxes=v["boxes"]):
                run = lambda: R.rows_flux3(v["boxes"], v["frame"], v["names"], text=v["kind"] == "text")
                if "error" in v:
                    with self.assertRaises(R.BoxError) as cm:
                        run()
                    self.assertEqual(str(cm.exception), v["error"])
                else:
                    self.assertEqual(js(run()), js(v["rows"]))

    def test_caption(self):
        for v in V["caption"]:
            with self.subTest(prompt=v["prompt"][:40], frame=v["frame"], boxes=v["boxes"]):
                self.assertEqual(R.caption_flux3(v["prompt"], v["boxes"], v["rows"], v["frame"]), v["out"])

    def test_apply(self):
        for v in V["apply"]:
            with self.subTest(prompt=v["prompt"][:40], boxes=v["boxes"]):
                run = lambda: R.apply_boxes(v["prompt"], v["boxes"], v["frame"], v["names"], text=v["kind"] == "text")
                if "error" in v:
                    with self.assertRaises(R.BoxError) as cm:
                        run()
                    self.assertEqual(str(cm.exception), v["error"])
                else:
                    a = run()
                    self.assertEqual(a["prompt"], v["out"]["prompt"])
                    self.assertEqual(js(a["rows"]), js(v["out"]["rows"]))
                    self.assertEqual(a["notes"], v["out"]["notes"])

    def test_elements(self):
        for v in V["elements"]:
            self.assertEqual(js(R.elements_core(v["boxes"])), js(v["out"]), v["boxes"])

    def test_counts(self):
        # a copy that lost its vectors would pass every loop above
        self.assertGreaterEqual(len(V["caption"]), 100)
        self.assertGreaterEqual(len(V["rows"]), 25)
        self.assertGreaterEqual(len(V["apply"]), 10)


class PythonOnlyTests(unittest.TestCase):
    """Where Python and JavaScript differ, the writer copies JavaScript."""

    def test_rounding_is_half_up(self):
        self.assertEqual([R.js_round(x) for x in (0.5, 1.5, 2.5, 3.5)], [1, 2, 3, 4])
        self.assertEqual(round(2.5), 2)   # Python's own would differ
        # 0.5, 2.5 and 12.5 on the grid go up (Python's round: 0, 2, 12); 0.5005 * 1000 is 500.49999999999994, so 500
        self.assertEqual(R.grid([0.0025, 0.0005, 0.0125, 0.5005]), [1, 3, 500, 13])

    def test_json_is_compact_and_keeps_characters(self):
        word = "Gr" + chr(0xF6) + chr(0xDF) + "e " + chr(0x1F600)
        self.assertEqual(R.dumps([{"id": "a_1", "from": None, "tgt_bbox": [1, 2, 3, 4], "desc": word}]),
                         '[{"id":"a_1","from":null,"tgt_bbox":[1,2,3,4],"desc":"' + word + '"}]')
        self.assertEqual(R.dumps("tab\tquote\"nul" + chr(1)), '"tab\\tquote\\"nul\\u0001"')

    def test_non_ascii_desc_is_kept(self):
        word = "eine rote Lampe " + chr(0x201E) + "alt" + chr(0x201C)
        rows = R.rows_flux3([{"id": "lamp_1", "kind": "new", "rect": [0, 0, 1, 1], "desc": word}], "ref_image_0", {})
        self.assertEqual(rows[0]["desc"], word)

    def test_astral_character_at_the_cut(self):
        emoji = chr(0x1F600)
        # JavaScript's slice(0, 400) would keep the first half of the emoji (a lone surrogate); the node drops it whole
        d = R.fold("x" * 399 + emoji + "tail")
        self.assertEqual(d, "x" * 399)
        self.assertEqual(R.len16(d), 399)
        d = R.fold("x" * 398 + emoji + "tail")
        self.assertEqual(d, "x" * 398 + emoji)
        self.assertEqual(R.len16(d), 400)
        # an astral character counts two units, as in JavaScript
        self.assertEqual(R.len16(R.fold(emoji * 300)), 400)
        self.assertEqual(len(R.fold(emoji * 300)), 200)

    def test_lone_surrogate_from_the_editor_is_dropped(self):
        # the editor's own cut can send half a character (JSON "\\ud83d"), json.loads keeps it as a lone surrogate
        d = json.loads('"abc\\ud83d"')
        self.assertEqual(R.fold(d), "abc")
        self.assertEqual(R.dumps(R.fold(d)).encode("utf-8"), b'"abc"')

    def test_js_whitespace(self):
        self.assertEqual(R.fold(chr(0xFEFF) + " a" + chr(0xA0) + "b" + chr(0x2028)), "a b")
        # U+001C and U+0085 are whitespace to Python's str.split, not to JavaScript's \s
        self.assertEqual(R.fold(chr(0x1C) + "a" + chr(0x85)), chr(0x1C) + "a" + chr(0x85))

    def test_capitals_and_verbs(self):
        self.assertEqual(R.clause_of("Make it."), "make it")
        self.assertEqual(R.clause_of("NASA logo"), "NASA logo")
        self.assertEqual(R.clause_of(chr(0xC4) + "pfel"), chr(0xC4) + "pfel")   # no capital rule outside A-Z
        self.assertTrue(R.VERB.match("Paint it"))
        self.assertFalse(R.VERB.match("painting"))
        # \b is ASCII in JavaScript without the u flag: "add" before an accented letter ends a word there, so it is a verb
        self.assertTrue(R.VERB.match("add" + chr(0xE9)))

    def test_box_id(self):
        for bid, ok in (("red_scarf_1", True), ("ref_image_1", False), ("ref_image_lamp_1", True), ("red_scarf_1\n", False), ("a_0", False)):
            self.assertEqual(bool(R.BOX_ID.match(bid)), ok, bid)

    def test_new_image_rows(self):
        rows = R.rows_text([{"id": "sign_1", "kind": "new", "rect": [0, 0, 0.5, 0.5], "desc": "neon", "text": "OPEN"}])
        self.assertEqual(rows, [{"id": "sign_1", "bbox": [0, 0, 500, 500], "desc": 'text reading "OPEN", neon'}])


class RunTests(unittest.TestCase):
    """InpaintCanvas.run() with boxes in canvas_state, on the stubs (a temp input folder with real PNGs). Every
    expectation takes the frame from the returned stitch_info, never the whole picture."""

    W, H = 1000, 600
    SEL = (400, 200, 600, 400)   # the selection, x1 and y1 exclusive

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ic_boxes_")
        for kind in ("input", "output", "temp", "user"):
            tp.DIRS[kind] = os.path.join(self.tmp, "ComfyUI", kind)
            os.makedirs(tp.DIRS[kind])
        self.dir = os.path.join(tp.DIRS["input"], "inpaint_canvas")
        os.makedirs(self.dir)
        Image.new("RGB", (self.W, self.H), (90, 120, 160)).save(os.path.join(self.dir, "base.png"))
        m = Image.new("L", (self.W, self.H), 0)
        m.paste(255, self.SEL)
        m.save(os.path.join(self.dir, "mask.png"))
        Image.new("RGB", (400, 200), (200, 30, 30)).save(os.path.join(self.dir, "wide.png"))
        Image.new("RGB", (300, 300), (30, 200, 30)).save(os.path.join(self.dir, "square.png"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ref(self, name):
        return {"filename": name, "subfolder": "inpaint_canvas", "type": "input"}

    def state(self, boxes=None, gen=None, crop=None, **extra):
        s = {"width": self.W, "height": self.H, "base": self.ref("base.png"), "mask": self.ref("mask.png"),
             "prompt": "make it night", "gen": {"mode": "api", "boxes": True, **(gen or {})},
             "crop": {"context": "manual", "feather": "manual", "fill": "none", **(crop or {})}, "references": [], "refs": {"fit": "pad"}}
        if boxes is not None:
            s["boxes"] = boxes
        s.update(extra)
        return s

    def run_node(self, state, padding=56, target_size=512, multiple_of=64, inputs=None):
        prompt = {"7": {"class_type": "InpaintCanvas", "inputs": {"canvas_state": json.dumps(state), **(inputs or {})}}}
        out = nodes.InpaintCanvas().run(padding=padding, target_size=target_size, feather=0, multiple_of=multiple_of, prompt=prompt, unique_id="7")
        names = nodes.InpaintCanvas.RETURN_NAMES
        self.assertEqual(len(out["result"]), len(names))
        d = dict(zip(names, out["result"]))
        d["ui"], d["expand"] = out.get("ui"), out.get("expand")
        d["frame"] = json.loads(d["stitch_info"])["bbox"]
        d["rows"] = json.loads(d["box_prompt"][d["box_prompt"].index(" [{") + 1:]) if " [{" in d["box_prompt"] else None
        return d

    @staticmethod
    def g(rect, frame):
        """The grid of a pixel rectangle in a frame, written out (the plan's half-up formula, values away from .5)."""
        x, y, w, h = frame
        v = lambda a: int(math.floor(a * 1000 + 0.5))
        return [v((rect[1] - y) / h), v((rect[0] - x) / w), v((rect[3] - y) / h), v((rect[2] - x) / w)]

    def notes(self, d):
        return (d["ui"] or {}).get("inpaint_boxes", [])

    def test_outputs_are_appended(self):
        names = nodes.InpaintCanvas.RETURN_NAMES
        self.assertEqual(names[:13], ("crop_image", "crop_mask", "image", "mask", "stitch_info", "crop_width", "crop_height", "prompt", "control_image", "denoise", "seed", "mode", "negative"))
        self.assertEqual(names[13:21], tuple(f"setting_{i}" for i in range(1, 9)))
        self.assertEqual(names[21:], ("box_prompt", "elements"))
        self.assertEqual(nodes.InpaintCanvas.RETURN_TYPES[21:], ("STRING", "ARRAY"))
        self.assertEqual(len(nodes.InpaintCanvas.OUTPUT_TOOLTIPS), len(names))

    def test_each_kind(self):
        boxes = [
            {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a brass lamp"},
            {"id": "vase_1", "kind": "keep", "rect": [360, 160, 400, 200], "src": [360, 160, 400, 200], "desc": "the vase"},
            {"id": "cat_1", "kind": "move", "rect": [500, 300, 560, 360], "src": [380, 180, 440, 240], "desc": "the cat"},
            {"id": "cup_1", "kind": "remove", "rect": [520, 180, 560, 220], "src": [520, 180, 560, 220], "desc": "the cup"},
            {"id": "dog_1", "kind": "from", "rect": [400, 300, 500, 400], "src": [0, 0, 1, 1], "ref": 0, "desc": "the dog"},
        ]
        d = self.run_node(self.state(boxes, references=[self.ref("square.png")], refs={"fit": "stretch"}))
        f = d["frame"]
        self.assertEqual(d["prompt"], "make it night")
        rows = d["rows"]
        self.assertEqual([r["id"] for r in rows], ["lamp_1", "vase_1", "cat_1", "cup_1", "dog_1"])
        self.assertEqual(rows[0], {"id": "lamp_1", "from": None, "src_bbox": None, "tgt_bbox": self.g([420, 220, 500, 300], f), "desc": "a brass lamp"})
        self.assertEqual(rows[1]["from"], "ref_image_0")
        self.assertEqual(rows[1]["src_bbox"], rows[1]["tgt_bbox"])
        self.assertEqual(rows[2]["src_bbox"], self.g([380, 180, 440, 240], f))
        self.assertEqual(rows[2]["tgt_bbox"], self.g([500, 300, 560, 360], f))
        self.assertIsNone(rows[3]["tgt_bbox"])
        self.assertEqual(rows[4]["from"], "ref_image_1")
        self.assertEqual(rows[4]["src_bbox"], [0, 0, 1000, 1000])
        self.assertTrue(d["box_prompt"].startswith("make it night. In <ref_image_0>, place a brass lamp <lamp_1> "))
        self.assertEqual(d["elements"], [{"type": "obj", "bbox": self.g([420, 220, 500, 300], f), "desc": "a brass lamp"}])
        self.assertEqual(self.notes(d), [])
        self.assertIsNone(d["ui"])
        # the same rows as the writer gives for the measured boxes
        self.assertEqual(d["box_prompt"].split(" [{")[0] + " " + R.dumps(rows), d["box_prompt"])

    def test_original_shifts_the_references(self):
        box = {"id": "dog_1", "kind": "from", "rect": [400, 300, 500, 400], "ref": 0, "desc": "the dog"}
        keep = {"id": "vase_1", "kind": "keep", "rect": [380, 180, 440, 240], "src": [380, 180, 440, 240], "desc": "the vase"}
        on = self.run_node(self.state([box, keep], crop={"fill": "green", "withOriginal": True}, references=[self.ref("square.png")]))
        self.assertEqual(on["crop_image"].shape[0], 3)
        self.assertEqual(on["rows"][0]["from"], "ref_image_2")
        self.assertTrue(any("vase_1: its source lies in the selection" in n for n in self.notes(on)), self.notes(on))
        off = self.run_node(self.state([box, keep], crop={"fill": "green", "withOriginal": False}, references=[self.ref("square.png")]))
        self.assertEqual(off["crop_image"].shape[0], 2)
        self.assertEqual(off["rows"][0]["from"], "ref_image_1")
        # without a fill the Original never goes, whatever withOriginal says, and the keep source is not filled
        plain = self.run_node(self.state([box, keep], crop={"fill": "none", "withOriginal": True}, references=[self.ref("square.png")]))
        self.assertEqual(plain["rows"][0]["from"], "ref_image_1")
        self.assertEqual(self.notes(plain), [])

    def test_a_reference_that_fails_to_load(self):
        boxes = [{"id": "dog_1", "kind": "from", "rect": [400, 300, 500, 400], "ref": 1, "desc": "the dog"},
                 {"id": "cat_1", "kind": "from", "rect": [400, 200, 500, 300], "ref": 0, "desc": "the cat"}]
        d = self.run_node(self.state(boxes, references=[self.ref("missing.png"), self.ref("square.png")]))
        self.assertEqual(d["crop_image"].shape[0], 2)
        self.assertEqual([r["id"] for r in d["rows"]], ["dog_1"])
        self.assertEqual(d["rows"][0]["from"], "ref_image_1")
        self.assertEqual(self.notes(d), ["Box cat_1: its reference layer (reference 1 of the run) was not loaded, so the box was not sent."])

    def test_reference_fits(self):
        # wide.png is 400 x 200, the crop 512 x 512; the source is the middle half of the picture
        box = {"id": "dog_1", "kind": "from", "rect": [400, 300, 500, 400], "src": [0.25, 0.25, 0.75, 0.75], "ref": 0, "desc": ""}
        got = {}
        for fit in ("stretch", "pad", "crop"):
            d = self.run_node(self.state([box], references=[self.ref("wide.png")], refs={"fit": fit}))
            self.assertEqual((d["crop_width"], d["crop_height"]), (512, 512), fit)
            got[fit] = d["rows"][0]["src_bbox"]
        self.assertEqual(got["stretch"], [250, 250, 750, 750])
        # pad: scaled by 1.28 to 512 x 256, 128 px down: y 50 -> 192, 150 -> 320 (of 512); x 100 -> 128, 300 -> 384
        self.assertEqual(got["pad"], [375, 250, 625, 750])
        # crop: the centre 200 x 200 (cx = 100) scaled to 512: x 100 -> 0, 300 -> 512; y 50 -> 128, 150 -> 384
        self.assertEqual(got["crop"], [250, 0, 750, 1000])

    def test_crop_fit_that_cuts_the_source_off(self):
        box = {"id": "dog_1", "kind": "from", "rect": [400, 300, 500, 400], "src": [0, 0, 0.2, 1], "ref": 0, "desc": "x"}
        d = self.run_node(self.state([box], references=[self.ref("wide.png")], refs={"fit": "crop"}))
        self.assertEqual(d["box_prompt"], "make it night")
        self.assertEqual(d["elements"], [])
        self.assertTrue(self.notes(d)[0].startswith("Box dog_1: its source lies outside what the reference fit (crop) keeps"), self.notes(d))

    def test_native_size_and_multiple_of(self):
        box = {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a lamp"}
        d = self.run_node(self.state([box]), padding=10, target_size=0, multiple_of=64)
        f = d["frame"]
        self.assertEqual((f[2] % 64, f[3] % 64), (0, 0))
        self.assertNotEqual(f, [390, 190, 220, 220])   # the span was fitted to the multiple
        self.assertEqual(d["rows"][0]["tgt_bbox"], self.g([420, 220, 500, 300], f))

    def test_no_selection(self):
        box = {"id": "lamp_1", "kind": "new", "rect": [100, 100, 300, 200], "desc": "a lamp"}
        st = self.state([box], mask=None)
        d = self.run_node(st)
        self.assertEqual(d["frame"], [0, 0, self.W, self.H])
        self.assertEqual(d["rows"][0]["tgt_bbox"], self.g([100, 100, 300, 200], d["frame"]))
        # no selection and no box: nothing, no S1
        d = self.run_node(self.state([], mask=None))
        self.assertEqual((d["box_prompt"], d["elements"], d["ui"]), ("make it night", [], None))

    def test_boxes_off(self):
        box = {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a lamp"}
        d = self.run_node(self.state([box], gen={"boxes": False}))
        self.assertEqual((d["box_prompt"], d["elements"], d["ui"]), ("make it night", [], None))
        st = self.state([box])
        del st["gen"]["boxes"]
        d = self.run_node(st)
        self.assertEqual((d["box_prompt"], d["elements"]), ("make it night", []))

    def test_selection_as_a_box(self):
        d = self.run_node(self.state(None, selectionBoxId="night_1"))
        f = d["frame"]
        self.assertEqual(d["rows"], [{"id": "night_1", "from": None, "src_bbox": None, "tgt_bbox": self.g(self.SEL, f), "desc": "make it night"}])
        self.assertEqual(d["box_prompt"].split(" [{")[0], "make it night. In <ref_image_0>, the change goes in <night_1> in the middle. Leave the rest of the picture as it is.")
        self.assertEqual(d["elements"], [{"type": "obj", "bbox": self.g(self.SEL, f), "desc": "make it night"}])
        # an empty list too; without a usable selectionBoxId the id is edit_1
        for sid in (None, "Bad id", "ref_image_1"):
            d = self.run_node(self.state([], selectionBoxId=sid))
            self.assertEqual(d["rows"][0]["id"], "edit_1", sid)
        # boxes that were all dropped give notes and the plain prompt, never the selection's box
        d = self.run_node(self.state([{"id": "far_1", "kind": "new", "rect": [0, 0, 20, 20]}]))
        self.assertEqual((d["box_prompt"], d["elements"]), ("make it night", []))
        self.assertEqual(self.notes(d), ["Box far_1 lies outside the crop and was not sent."])

    def test_outside_the_frame(self):
        boxes = [{"id": "far_1", "kind": "new", "rect": [0, 0, 20, 20], "desc": "x"},
                 {"id": "ox_1", "kind": "move", "rect": [420, 220, 500, 300], "src": [0, 0, 20, 20], "desc": "the ox"},
                 {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a lamp"}]
        d = self.run_node(self.state(boxes))
        self.assertEqual([r["id"] for r in d["rows"]], ["lamp_1"])
        self.assertEqual(self.notes(d), ["Box far_1 lies outside the crop and was not sent.",
                                         "Box ox_1: its source lies outside the crop, so the box was not sent."])

    def test_the_15000_note(self):
        box = {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a lamp"}
        d = self.run_node(self.state([box], prompt="x" * 14990))
        self.assertGreater(len(d["box_prompt"]), 15000)
        self.assertTrue(any(n.startswith("The prompt with the box rows is ") and "refuses more than 15000" in n for n in self.notes(d)), self.notes(d))

    def test_small_and_bare_notes(self):
        boxes = [{"id": "dot_1", "kind": "new", "rect": [420, 220, 430, 230], "desc": "a dot"}, {"id": "gap_1", "kind": "new", "rect": [450, 250, 560, 360]}]
        d = self.run_node(self.state(boxes))
        self.assertEqual(self.notes(d), ["Box gap_1 went without a description: the model guesses what goes there.",
                                         "Box dot_1 is small (under 48 px a side as sent): the model may not place anything there."])

    def test_malformed_box_and_duplicate_id(self):
        boxes = [{"id": "Lamp", "kind": "new", "rect": [420, 220, 500, 300]}, {"id": "a_1", "kind": "new", "rect": [500, 220, 420, 300]},
                 {"id": "b_1", "kind": "keep", "rect": [420, 220, 500, 300]}, "nope",
                 {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "one"},
                 {"id": "lamp_1", "kind": "new", "rect": [440, 240, 500, 300], "desc": "two"}]
        d = self.run_node(self.state(boxes))
        self.assertEqual([r["id"] for r in d["rows"]], ["lamp_1", "lamp_2"])
        n = self.notes(d)
        self.assertEqual(n[0], "Box Lamp: the id is not lowercase words and a number joined by underscores (knight_1, red_scarf_2), so the box was not sent.")
        self.assertEqual(n[1], "Box a_1: rect is not [l, t, r, b] in image pixels with l < r and t < b, so the box was not sent.")
        self.assertEqual(n[2], "Box b_1: src is not [l, t, r, b] in image pixels with l < r and t < b, so the box was not sent.")
        self.assertEqual(n[3], "Box #4: not an object, so the box was not sent.")

    def test_a_writer_exception_gives_the_plain_prompt(self):
        box = {"id": "lamp_1", "kind": "new", "rect": [420, 220, 500, 300], "desc": "a lamp"}
        with mock.patch.object(R, "apply_boxes", side_effect=RuntimeError("boom")):
            d = self.run_node(self.state([box]))
        self.assertEqual((d["box_prompt"], d["elements"]), ("make it night", []))
        self.assertEqual(self.notes(d), ["Boxes were not written: boom"])
        # not a list
        d = self.run_node(self.state({"id": "x"}))
        self.assertEqual((d["box_prompt"], d["elements"]), ("make it night", []))
        self.assertEqual(self.notes(d), ["Boxes were not written: the canvas state's boxes are not a list"])
        # node_outputs itself failing never fails the run
        with mock.patch.object(R, "node_outputs", side_effect=RuntimeError("worse")):
            d = self.run_node(self.state([box]))
        self.assertEqual((d["box_prompt"], d["elements"]), ("make it night", []))
        self.assertEqual(self.notes(d), ["Boxes were not written: worse"])

    def test_expand_keeps_the_notes(self):
        made = []

        class FakeGraph:
            def node(self, *a, **k):
                made.append((a, k))

            def finalize(self):
                return {}

        far = {"id": "far_1", "kind": "new", "rect": [0, 0, 20, 20]}
        with mock.patch.object(nodes, "GraphBuilder", FakeGraph):
            d = self.run_node(self.state([far]), inputs={"result_source": "12:0"})
        self.assertEqual(d["expand"], {})
        self.assertEqual(made[0][0], ("InpaintCanvasStitch",))
        self.assertEqual(self.notes(d), ["Box far_1 lies outside the crop and was not sent."])
        self.assertEqual(d["box_prompt"], "make it night")


class FitTests(unittest.TestCase):
    """boxes_rows.fit_point against nodes.py's own _fit_image: a marked pixel lands where the formula says (the stub's
    common_upscale ignores crop, so only stretch and pad are measured on pixels)."""

    def test_pad_and_stretch_on_pixels(self):
        import torch
        for fit in ("pad", "stretch"):
            for (w, h, W, H) in ((400, 200, 512, 512), (200, 400, 512, 256), (300, 300, 640, 384)):
                img = torch.zeros((1, h, w, 3))
                img[0, h // 4:h // 4 + 8, w // 3:w // 3 + 8, :] = 1.0   # a white square
                out = nodes._fit_image(img, W, H, fit)
                ys, xs = torch.nonzero(out[0, :, :, 0] > 0.5, as_tuple=True)
                cx, cy = (float(xs.min()) + float(xs.max()) + 1) / 2, (float(ys.min()) + float(ys.max()) + 1) / 2
                px, py = R.fit_point(w // 3 + 4, h // 4 + 4, w, h, W, H, fit)
                self.assertAlmostEqual(cx, px, delta=1.5, msg=(fit, w, h, W, H))
                self.assertAlmostEqual(cy, py, delta=1.5, msg=(fit, w, h, W, H))

    def test_crop_matches_common_upscale(self):
        # comfy.utils.common_upscale(.., crop="center"): the centre cut, Python's round
        self.assertEqual(R.fit_point(100, 50, 400, 200, 512, 512, "crop"), (0.0, 128.0))
        self.assertEqual(R.fit_point(300, 150, 400, 200, 512, 512, "crop"), (512.0, 384.0))
        self.assertEqual(R.fit_point(0, 0, 200, 400, 512, 512, "crop"), (0.0, -256.0))
        # identity at the same size, whatever the fit
        for fit in ("pad", "crop", "stretch"):
            self.assertEqual(R.fit_point(7, 9, 64, 32, 64, 32, fit), (7, 9))


if __name__ == "__main__":
    unittest.main()
