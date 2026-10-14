"""FLUX 3 box rows for the Inpaint Canvas node: the edit rows and the caption that ComfyUI core's Flux 3 Image node
cannot write (its ``bounding_boxes`` input writes new-image rows only).

A port of Scumble's ``electron/main/providers/boxes.js`` (DenRakEiw/scumble), line by line, so the node writes the
same words, numbers and JSON as the app: ``tests/boxes_vectors.json`` holds vectors computed by that file and
``tests/test_boxes.py`` checks every one. Pure Python, no torch: nodes.py measures the editor's boxes against the
crop it built and calls this module.

A box here is the request's shape of the app (fractions of the frame):
    {"id": "red_scarf_1", "kind": "new" | "keep" | "move" | "remove" | "from",
     "rect": [l, t, r, b],            # fractions 0..1 of the frame: the target
     "src": [l, t, r, b] | None,      # keep / move / remove: where it is in the frame; from: where in its picture
     "ref": None | key,               # from: the key ``names`` maps to its picture's name (ref_image_k)
     "desc": "...", "text": "SALE"}   # text: new only, the words a Text box renders

The grid is FLUX 3's: ``[top, left, bottom, right]`` on 0..1000 of the frame. Where JavaScript and Python differ the
JavaScript side is copied: ``Math.round`` (not Python's half to even), JS whitespace in ``\\s`` and ``trim()``, string
lengths in UTF-16 units, ASCII ``\\b`` and case folding, compact JSON without ASCII escapes.
"""

import json
import math
import re

KINDS = ("new", "keep", "move", "remove", "from")

# lowercase words joined by underscores, then a number; never a picture's name (ref_image_1)
BOX_ID = re.compile(r"(?!ref_image_[0-9]+\Z)[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*_[1-9][0-9]*\Z")

DESC_MAX = 400

# ECMAScript WhiteSpace and LineTerminator: what JS's \s matches and trim() removes (Python's set differs: it has
# U+001C to U+001F and U+0085, JS has U+FEFF)
_JS_WS_CODES = (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680) + tuple(range(0x2000, 0x200B)) + (0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
_WS = "[" + "".join("\\u%04x" % c for c in _JS_WS_CODES) + "]"
_WS_RUN = re.compile(_WS + "+")
_TRIM = re.compile("^" + _WS + "+|" + _WS + "+\\Z")
_SURROGATE = re.compile("[\\ud800-\\udfff]")

# words that open an instruction: a description that starts with one goes into the caption as it is
VERB = re.compile(r"(?:add|bring|brighten|change|darken|draw|fill|give|insert|lighten|make|paint|place|put|recolou?r|render|replace|show|swap|turn|use|write)\b", re.I | re.A)
_MOVE = re.compile(r"move\b", re.I | re.A)
_REMOVE = re.compile(r"(?:remove|erase|delete)\b", re.I | re.A)
_KEEP = re.compile(r"keep\b", re.I | re.A)
_CLAUSE_END = re.compile("(?:" + _WS + "|[.!;:,])+\\Z")
_LOWER_FIRST = re.compile("[A-Z][a-z]|A(?=" + _WS + ")")
_STOP_END = re.compile(r"[.!?]\Z")


class BoxError(ValueError):
    """A box the rows cannot carry; the message names it, in the app's words."""


_UNDEF = object()


# ---- JavaScript's behaviour ------------------------------------------------------------------------------------------

def js_round(x):
    """``Math.round`` on a non-negative double: half up, exact (``floor(x + 0.5)`` gives 1 for 0.49999999999999994)."""
    r = math.floor(x)
    return int(r + 1 if x - r >= 0.5 else r)


def len16(s):
    """A string's length as JavaScript counts it (UTF-16 units)."""
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def cut16(s, n):
    """``s.slice(0, n)`` in UTF-16 units; a character the cut would split in half is left out whole."""
    out, units = [], 0
    for c in s:
        u = 2 if ord(c) > 0xFFFF else 1
        if units + u > n:
            break
        out.append(c)
        units += u
    return "".join(out)


def js_trim(s):
    return _TRIM.sub("", s)


def _js_string(v):
    """``String(v)`` for the values a box can hold."""
    if v is _UNDEF:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (int, float, str)):
        return str(v)
    if isinstance(v, dict):
        return "[object Object]"
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else _js_string(x) for x in v)
    return str(v)


def one_line(s):
    """``String(s == null ? "" : s).replace(/\\s+/g, " ").trim()``."""
    return js_trim(_WS_RUN.sub(" ", "" if s is None else _js_string(s)))


def fold(s):
    """A description as a row carries it: one line, trimmed, at most DESC_MAX UTF-16 units; a lone surrogate (half of
    a character an earlier cut split) is dropped."""
    return _SURROGATE.sub("", cut16(one_line(s), DESC_MAX))


def dumps(v):
    """``JSON.stringify(v)``: compact, no ASCII escapes."""
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


# ---- the shape check -------------------------------------------------------------------------------------------------

def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _fracs(v):
    return (isinstance(v, (list, tuple)) and len(v) == 4 and all(_is_num(x) and 0 <= x <= 1 for x in v)
            and v[0] < v[2] and v[1] < v[3])


def _is_int(x):
    return _is_num(x) and float(x).is_integer()


def _get(b, key):
    return b.get(key, _UNDEF) if isinstance(b, dict) else _UNDEF


def _absent(v):
    return v is _UNDEF or v is None


def who_of(b, i):
    bid = _get(b, "id")
    return "Box " + (bid if isinstance(bid, str) else "#" + str(i + 1))


def check_boxes(boxes):
    """The boxes held to their shape (main's checkBoxes): a list, each box a dict with a well-formed and unique id, a
    known kind, ``rect`` fractions with l < r and t < b, ``src`` the same for keep / move / remove / from and none for
    new, ``ref`` an integer for from only, ``desc`` a string, ``text`` a string on a new box only. Raises BoxError naming
    the box ("Box edit_1: ..: nothing was sent.")."""
    if boxes is None:
        return []
    if not isinstance(boxes, (list, tuple)):
        raise BoxError("The request's boxes are not a list: nothing was sent.")
    seen = set()
    for i, b in enumerate(boxes):
        who = who_of(b, i)

        def bad(why):
            return BoxError(f"{who}: {why}: nothing was sent.")

        if not isinstance(b, dict):
            raise bad("not an object")
        bid = _get(b, "id")
        if not isinstance(bid, str) or not BOX_ID.match(bid):
            raise bad("the id is not lowercase words and a number joined by underscores (knight_1, red_scarf_2)")
        if bid in seen:
            raise bad("the id is used twice")
        seen.add(bid)
        kind = _get(b, "kind")
        if not (isinstance(kind, str) and kind in KINDS):
            raise bad(f'the kind "{cut16(_js_string(kind), 20)}" is not new, keep, move, remove or from')
        if not _fracs(_get(b, "rect")):
            raise bad("rect is not [l, t, r, b] in fractions 0..1 with l < r and t < b")
        if kind == "new":
            if not _absent(_get(b, "src")):
                raise bad("a new box has no src")
        elif not _fracs(_get(b, "src")):
            raise bad("src is not [l, t, r, b] in fractions 0..1 with l < r and t < b")
        ref = _get(b, "ref")
        if kind == "from":
            if not (_is_int(ref) and ref >= 0):
                raise bad("a from box needs ref, the reference's index")
        elif not _absent(ref):
            raise bad("only a from box has a ref")
        desc = _get(b, "desc")
        if not _absent(desc) and not isinstance(desc, str):
            raise bad("desc is not a string")
        text = _get(b, "text")
        if not _absent(text):
            if not isinstance(text, str):
                raise bad("text is not a string")
            if kind != "new":
                raise bad("only a new box renders text")
    return boxes


# ---- the rows --------------------------------------------------------------------------------------------------------

def grid(rect):
    """A rectangle in fractions ([l, t, r, b]) on the 0 to 1000 grid as [top, left, bottom, right], at least 1 apart."""
    def g(v):
        return max(0, min(1000, js_round(v * 1000)))
    t, l, b, r = g(rect[1]), g(rect[0]), g(rect[3]), g(rect[2])
    if b <= t:
        if t >= 1000:
            t = 999
        b = t + 1
    if r <= l:
        if l >= 1000:
            l = 999
        r = l + 1
    return [t, l, b, r]


def picture_name(names, ref, who):
    """The name of the picture a from box takes (``names`` maps its ref to ``ref_image_k``)."""
    names = names or {}
    key = int(ref) if _is_int(ref) else ref
    name = names.get(key, names.get(str(key)))
    if not name:
        raise BoxError(f"{who} takes reference picture {key + 1 if isinstance(key, int) else key}, which this run does not send: nothing was sent.")
    return name


def desc_of(b):
    """A box's desc as a FLUX 3 row carries it: a Text box says what it reads (``text reading "SALE", red letters``)."""
    own = fold(b.get("desc"))
    text = b.get("text")
    return fold(f'text reading "{fold(text)}"' + (", " + own if own else "") if text is not None else own)


def rows_flux3(boxes, frame=None, names=None, text=False):
    """The FLUX 3 rows of the boxes: on an edit (``frame`` the crop's picture name, ref_image_0)
    ``{id, from, src_bbox, tgt_bbox, desc}`` per kind, on a new image (``text``) ``{id, bbox, desc}`` (New and Text
    boxes only)."""
    boxes = check_boxes(boxes)
    rows = []
    for b in boxes:
        bid, kind = b["id"], b["kind"]
        if text and kind == "from":
            raise BoxError(f"Box {bid} is a from box: on a new image FLUX 3 places New and Text boxes only (a New box whose description names the reference picture places it): nothing was sent.")
        if text and kind != "new":
            raise BoxError(f"Box {bid} is a {kind} box, and a new image has no source to keep, move or remove: nothing was sent.")
        desc = desc_of(b)
        if text:
            rows.append({"id": bid, "bbox": grid(b["rect"]), "desc": desc})
            continue
        if not frame:
            raise BoxError(f"Box {bid}: this route sends no crop the box could be placed in: nothing was sent.")
        if kind == "new":
            rows.append({"id": bid, "from": None, "src_bbox": None, "tgt_bbox": grid(b["rect"]), "desc": desc})
        elif kind == "keep":
            rows.append({"id": bid, "from": frame, "src_bbox": grid(b["src"]), "tgt_bbox": grid(b["src"]), "desc": desc})
        elif kind == "move":
            rows.append({"id": bid, "from": frame, "src_bbox": grid(b["src"]), "tgt_bbox": grid(b["rect"]), "desc": desc})
        elif kind == "remove":
            rows.append({"id": bid, "from": frame, "src_bbox": grid(b["src"]), "tgt_bbox": None, "desc": desc})
        else:
            rows.append({"id": bid, "from": picture_name(names, b["ref"], f"Box {bid}"), "src_bbox": grid(b["src"]), "tgt_bbox": grid(b["rect"]), "desc": desc})
    return rows


def rows_text(boxes):
    """The rows of a new image: ``{id, bbox, desc}`` for New and Text boxes."""
    return rows_flux3(boxes, None, None, text=True)


# ---- the caption (S3e of the app): name each element as <id> and say where it goes -----------------------------------

def clause_of(s):
    """A description as a clause of the caption: one line, no closing stop, a capital that only opened the sentence
    lowered (an acronym keeps its case)."""
    t = _CLAUSE_END.sub("", one_line(s))
    return t[0].lower() + t[1:] if _LOWER_FIRST.match(t) else t


def _drop_verb(s, rx):
    return js_trim(rx.sub("", s, count=1) if rx.match(s) else s)


def where_words(g):
    """Where a box lies in the frame (a grid), in words, by thirds; over three quarters each way is "over most of the
    picture"."""
    if not isinstance(g, (list, tuple)) or len(g) != 4:
        return ""
    if g[2] - g[0] >= 750 and g[3] - g[1] >= 750:
        return "over most of the picture"

    def third(mid, lo, hi):
        return lo if mid * 3 < 1000 else hi if mid * 3 > 2000 else ""
    v = third((g[0] + g[2]) / 2, "top", "bottom")
    h = third((g[1] + g[3]) / 2, "left", "right")
    return f"at the {v} {h}" if v and h else f"at the {v}" if v else f"on the {h}" if h else "in the middle"


def way_words(a, b):
    """Which way a Move box goes, from its source grid to its target grid, in words."""
    if not isinstance(a, (list, tuple)) or not isinstance(b, (list, tuple)):
        return "to its new box"
    dy = (b[0] + b[2] - a[0] - a[2]) / 2
    dx = (b[1] + b[3] - a[1] - a[3]) / 2
    v = "up" if dy <= -100 else "down" if dy >= 100 else ""
    h = "to the left" if dx <= -100 else "to the right" if dx >= 100 else ""
    way = f"{v} and {h}" if v and h else v or h or "to its new box"

    def area(g):
        return max(1, (g[2] - g[0]) * (g[3] - g[1]))
    k = area(b) / area(a)
    return f"{way}, larger" if k >= 1.5 else f"{way}, smaller" if k <= 1 / 1.5 else way


def _clause_flux3(b, row):
    d = clause_of(row.get("desc"))
    bid = f"<{b['id']}>"
    kind = b.get("kind")
    if kind == "new":
        where = where_words(row.get("tgt_bbox") or row.get("bbox"))
        return f"{d if VERB.match(d) else 'place ' + d} {bid} {where}" if d else f"fill the area {bid} {where} so it fits the picture"
    if kind == "from":
        where = where_words(row.get("tgt_bbox"))
        pic = f"<{row.get('from')}>"
        return f"{d if VERB.match(d) else 'place ' + d} {bid} from {pic} {where}" if d else f"place what {pic} shows as {bid} {where}"
    if kind == "move":
        return f"move {_drop_verb(d, _MOVE) or 'the element'} {bid} {way_words(row.get('src_bbox'), row.get('tgt_bbox'))}"
    if kind == "remove":
        return f"remove {_drop_verb(d, _REMOVE) or 'the element'} {bid} {where_words(row.get('src_bbox'))}"
    if kind == "keep":
        return f"keep {_drop_verb(d, _KEEP) or 'the element'} {bid} as it is"
    return ""


def _place_only(b, row):
    where = where_words(row.get("tgt_bbox") or row.get("bbox"))
    if b.get("kind") == "from" and row.get("from"):
        return f"<{row['from']}> goes in <{b['id']}> {where}"
    return f"the change goes in <{b['id']}> {where}"


def caption_flux3(prompt, boxes, rows, frame):
    """The caption the rows go with: the prompt as it is, then one sentence per box it does not name by ``<id>``, with
    the box's description and its place in words. A box without a row gets no sentence; a box whose description is the
    prompt (the selection's box) says only where; "In <frame>, " opens the first sentence on an edit when the prompt does
    not name the frame; "Leave the rest of the picture as it is." closes it when the prompt says nothing the boxes do
    not."""
    text = one_line(prompt)
    by_id = {}
    for r in rows or []:
        by_id[r.get("id")] = r
    told = [b for b in (boxes or []) if isinstance(b, dict) and b.get("id", _UNDEF) in by_id and f"<{_js_string(b.get('id', _UNDEF))}>" not in text]

    def plain(s):
        return clause_of(s).lower()
    whole = plain(text)

    def is_prompt(d):
        a = plain(d)
        return bool(a) and (a == whole or (len16(a) >= DESC_MAX - 10 and len16(whole) > len16(a) and whole.startswith(a)))
    said = bool(text) and any(is_prompt(by_id[b["id"]].get("desc")) for b in told)
    clauses = [c for c in ((_place_only(b, by_id[b["id"]]) if is_prompt(by_id[b["id"]].get("desc")) else _clause_flux3(b, by_id[b["id"]])) for b in told) if c]
    if clauses and frame and f"<{frame}>" not in text:
        clauses[0] = f"In <{frame}>, {clauses[0]}"
    sentences = [f"{s[0].upper()}{s[1:]}." for s in clauses]
    if frame and by_id and (not text or said):
        sentences.append("Leave the rest of the picture as it is.")
    head = f"{text}." if text and sentences and not _STOP_END.search(text) else text
    return " ".join(p for p in [head] + sentences if p)


def bare_note(ids):
    if not ids:
        return None
    one = len(ids) == 1
    return f"{'Box' if one else 'Boxes'} {', '.join(ids)} went without a description: the model guesses what goes there."


def apply_boxes(prompt, boxes, frame=None, names=None, text=False):
    """The prompt a FLUX 3 run goes out with: the caption, a space and the JSON rows. Returns
    ``{"prompt", "rows", "notes"}``; raises BoxError as main refuses."""
    boxes = check_boxes(boxes)
    rows = rows_flux3(boxes, frame, names, text)
    caption = caption_flux3(prompt, boxes, rows, frame)
    note = bare_note([r["id"] for i, r in enumerate(rows) if boxes[i]["kind"] == "new" and not r["desc"]])
    return {"prompt": f"{caption} {dumps(rows)}", "rows": rows, "notes": [note] if note else []}


def elements_core(boxes):
    """The New and Text boxes as ComfyUI core's bounding-box elements (``{type, bbox, text?, desc}``, the grid of the
    frame), for Flux 3 Image's ``bounding_boxes``, Create Bounding Boxes and the Ideogram JSON prompt builder. Core
    names the rows box_1, box_2 .. itself and writes a Text box's words before its desc."""
    out = []
    for b in check_boxes(boxes):
        if b["kind"] != "new":
            continue
        desc = fold(b.get("desc"))
        if b.get("text") is not None:
            out.append({"type": "text", "bbox": grid(b["rect"]), "text": fold(b["text"]), "desc": desc})
        else:
            out.append({"type": "obj", "bbox": grid(b["rect"]), "desc": desc})
    return out
