"""Reference layers in the crop_image batch: a reference that does not load, with and without named_refs.

Scumble sends canvas_state.named_refs = true when the prompt names a reference by its place in the batch (@img1 as
"<image3>" ..). A reference left out would move every later one up, so then the run stops with an error naming the
reference; without named_refs it is left out with a print, as before. Plain Python on test_paths' stubs. Run from the
repository root:

    python -m unittest discover -s tests -v
"""

import json
import os
import shutil
import tempfile
import unittest

from PIL import Image

import test_paths as tp   # one stub install for every test file (folder_paths, comfy.utils, server ...)

nodes = tp.nodes


class NamedRefsTests(unittest.TestCase):
    W, H = 640, 480
    SEL = (200, 160, 440, 320)   # the selection, x1 and y1 exclusive

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ic_refs_")
        for kind in ("input", "output", "temp", "user"):
            tp.DIRS[kind] = os.path.join(self.tmp, "ComfyUI", kind)
            os.makedirs(tp.DIRS[kind])
        self.dir = os.path.join(tp.DIRS["input"], "inpaint_canvas")
        os.makedirs(self.dir)
        Image.new("RGB", (self.W, self.H), (90, 120, 160)).save(os.path.join(self.dir, "base.png"))
        m = Image.new("L", (self.W, self.H), 0)
        m.paste(255, self.SEL)
        m.save(os.path.join(self.dir, "mask.png"))
        Image.new("RGB", (300, 200), (200, 30, 30)).save(os.path.join(self.dir, "red.png"))
        Image.new("RGB", (200, 300), (30, 200, 30)).save(os.path.join(self.dir, "green.png"))
        with open(os.path.join(self.dir, "broken.png"), "wb") as f:
            f.write(b"not a picture at all")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ref(self, name):
        return {"filename": name, "subfolder": "inpaint_canvas", "type": "input"}

    def run_node(self, references, **extra):
        state = {"width": self.W, "height": self.H, "base": self.ref("base.png"), "mask": self.ref("mask.png"),
                 "prompt": "the hat of <image2>", "gen": {"mode": "api"},
                 "crop": {"context": "manual", "feather": "manual", "fill": "none"},
                 "references": [self.ref(n) for n in references], "refs": {"fit": "pad"}, **extra}
        prompt = {"7": {"class_type": "InpaintCanvas", "inputs": {"canvas_state": json.dumps(state)}}}
        out = nodes.InpaintCanvas().run(padding=32, target_size=512, feather=0, multiple_of=64, prompt=prompt, unique_id="7")
        return dict(zip(nodes.InpaintCanvas.RETURN_NAMES, out["result"]))

    def test_named_refs_all_loaded(self):
        d = self.run_node(["red.png", "green.png"], named_refs=True)
        self.assertEqual(d["crop_image"].shape[0], 3)   # the crop, then both references

    def test_named_refs_missing_first_stops_the_run(self):
        with self.assertRaises(ValueError) as caught:
            self.run_node(["missing.png", "green.png"], named_refs=True)
        text = str(caught.exception)
        self.assertTrue(text.startswith("Inpaint Canvas: reference 1 (@img1) could not be loaded (file not found: "), text)
        self.assertIn("missing.png", text)
        self.assertEqual(text.count("Inpaint Canvas:"), 1, text)
        self.assertIn("the run stops", text)

    def test_named_refs_unreadable_second_stops_the_run(self):
        with self.assertRaises(ValueError) as caught:
            self.run_node(["red.png", "broken.png"], named_refs=True)
        self.assertTrue(str(caught.exception).startswith("Inpaint Canvas: reference 2 (@img2) could not be loaded ("), str(caught.exception))

    def test_without_named_refs_the_reference_is_left_out(self):
        for extra in ({}, {"named_refs": False}):
            d = self.run_node(["missing.png", "green.png"], **extra)
            self.assertEqual(d["crop_image"].shape[0], 2, extra)   # the crop and green.png, moved up one place
            d = self.run_node(["red.png", "broken.png"], **extra)
            self.assertEqual(d["crop_image"].shape[0], 2, extra)

    def test_only_true_counts(self):
        # canvas_state is JSON from a client: a string "false" or a 1 is not the app's flag
        for value in ("false", 1, None):
            d = self.run_node(["missing.png", "green.png"], named_refs=value)
            self.assertEqual(d["crop_image"].shape[0], 2, value)


if __name__ == "__main__":
    unittest.main()
