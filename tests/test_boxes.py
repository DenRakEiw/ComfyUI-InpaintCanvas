"""Box prompting tests: boxes_rows.py against the vectors of Scumble's writer, and Python-only cases.

tests/boxes_vectors.json is a copy of Scumble's tools/boxes_vectors.json, computed by the app's
electron/main/providers/boxes.js; every vector here must come out the same, to the character. Run from the
repository root:

    python -m unittest discover -s tests -v
"""

import importlib.util
import json
import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
