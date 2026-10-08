// Generated from DenRakEiw/scumble renderer/editor/reftokens.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// The @img tokens of the prompt (item 26, docs/PLAN_REFS.md C1 and C2). The prompt names the visible reference layers
// by their place in the list, top first: `@img1` .. `@img999`. A token stays tied to its layer through every change
// that renumbers the references (`remap`), and one whose layer has no label (hidden, deleted, no longer a reference)
// waits as `@img?<layer id>` until the layer gets one again. At send time the tokens become markers `{@ref:i}`, i = the
// picture's index in `request.references`, which main resolves to the route's own name for the picture
// (electron/main/providers/refs.js uses exactly this grammar; tools/refs_cases.json holds the cases both are tested on).
//
// Shared with the ComfyUI node (tools/build_node.py FILES), so nothing app-specific: no DOM, no imports. Pure, so
// tools/reftokens_test.js runs it in plain Node. A text is always a plain string; a label map is a Map from layer id to
// label number (`labelMap`).

/** @typedef {{ type: "text", text: string } | { type: "token", text: string, n: number } | { type: "token", text: string, id: string }} Segment */
/** @typedef {Map<string, number>} Labels */
/** @typedef {{ kind: "literal" | "parked" | "unknown" | "unsent", token: string, n?: number, id?: string }} MarkerError */

/**
 * The grammar, as a RegExp source: live `@img1` .. `@img999` (group 1), parked `@img?<layer id>` (group 2). The prefix
 * is case-insensitive by hand, not with `/i`, so the id stays case-sensitive; `@img0`, `@img01`, `@img1234`,
 * `@img?labc`, `x@img1`, `@img1-a` and `@image2` are plain text.
 */
export const TOKEN = String.raw`(?<![\w-])@[Ii][Mm][Gg](?:([1-9]\d{0,2})|\?(L[0-9a-z]+))(?![\w-])`;

// a fresh RegExp per call: a shared /g one carries its lastIndex from one caller to the next
const re = (flags = "g") => new RegExp(TOKEN, flags);
// the prefix lower case, the number or the id as found ("@IMG2" -> "@img2", "@Img?Labc" -> "@img?Labc")
const norm = (tok) => "@img" + tok.slice(4);

/** label number -> layer id */
function invert(labels) {
    const out = new Map();
    if (labels) for (const [id, n] of labels) if (!out.has(n)) out.set(n, id);
    return out;
}

/**
 * The text as segments, in order: plain text and tokens (`n` for a live one, `id` for a parked one, `text` as found).
 * Their texts put together give the text back.
 * @param {string} text
 * @returns {Segment[]}
 */
export function parse(text) {
    const s = String(text == null ? "" : text);
    /** @type {Segment[]} */
    const out = [];
    let at = 0;
    for (const m of s.matchAll(re())) {
        if (m.index > at) out.push({ type: "text", text: s.slice(at, m.index) });
        out.push(m[1] ? { type: "token", text: m[0], n: +m[1] } : { type: "token", text: m[0], id: m[2] });
        at = m.index + m[0].length;
    }
    if (at < s.length) out.push({ type: "text", text: s.slice(at) });
    return out;
}

/**
 * Does the text hold a token, live or parked?
 * @param {string} text
 */
export function hasTokens(text) {
    const s = String(text == null ? "" : text);
    return s.includes("@") && re("").test(s);
}

/**
 * Every token's prefix in lower case; the number and the id stay as they are. Anything but a string comes back as it is.
 * @template T
 * @param {T} text
 * @returns {T}
 */
export function normalize(text) {
    if (typeof text !== "string" || !text.includes("@")) return text;
    return /** @type {T} */ (/** @type {unknown} */ (text.replace(re(), norm)));
}

/**
 * The labels of the reference layers as the editor lists them (visible references with pixels, top first): layer id
 * -> 1, 2, ...
 * @param {{ id: string }[]} refLayers
 * @returns {Labels}
 */
export function labelMap(refLayers) {
    return new Map((refLayers || []).map((l, i) => [l.id, i + 1]));
}

/**
 * Do two label maps give every layer the same label? A missing map counts as an empty one.
 * @param {Labels | null} a
 * @param {Labels | null} b
 */
export function sameLabels(a, b) {
    const x = a || new Map(), y = b || new Map();
    if (x.size !== y.size) return false;
    for (const [id, n] of x) if (y.get(id) !== n) return false;
    return true;
}

/**
 * The text after the labels changed from `before` to `after`, in one callback replace: every token is read from the
 * text as it was, so a swap of img1 and img2 cannot collide. A live token follows its layer to the layer's new label,
 * or parks as `@img?<id>` when the layer has none; a parked token whose layer has a label again unparks; a live token
 * no layer held before stays as it is (it binds to whichever reference gets that label). Every token comes out
 * normalised. A merge passes `after` with the absorbed layer's id under the survivor's label (an id mapped to nothing
 * parks, as for a merge into a hidden reference). A text without "@" (or anything but a string) comes back as it is.
 * @template T
 * @param {T} text
 * @param {Labels | null} before
 * @param {Labels | null} after
 * @returns {T}
 */
export function remap(text, before, after) {
    if (typeof text !== "string" || !text.includes("@")) return text;
    const idOf = invert(before), to = after || new Map();
    const out = text.replace(re(), (tok, num, id) => {
        const lid = id || idOf.get(+num);
        if (!lid) return "@img" + num;
        const n = to.get(lid);
        return n != null ? "@img" + n : "@img?" + lid;
    });
    return /** @type {T} */ (/** @type {unknown} */ (out));
}

/**
 * The text with each live token as a marker `{@ref:i}`, i = the token's layer's index in `sent` (the order of
 * `request.references`, null for the Original, so the Original shifts every index by one). `sent` null only validates:
 * a live token with a label is then left as it is. What cannot be sent is left as found and listed in `errors`, once
 * per kind and token: a literal "{@ref:" anywhere (Scumble keeps it for itself), a parked token, a number no layer
 * holds, a layer that is not among `sent`.
 * @param {string} text
 * @param {Labels | null} labels
 * @param {(string | null)[] | null} sent
 * @returns {{ text: string, errors: MarkerError[] }}
 */
export function toMarkers(text, labels, sent) {
    const s = String(text == null ? "" : text), idOf = invert(labels);
    /** @type {MarkerError[]} */
    const errors = [];
    const seen = new Set();
    const fail = (e, key) => { if (!seen.has(e.kind + " " + key)) { seen.add(e.kind + " " + key); errors.push(e); } };
    if (/\{@ref:/i.test(s)) fail({ kind: "literal", token: "{@ref:" }, "");
    const out = s.replace(re(), (tok, num, id) => {
        if (id) { fail({ kind: "parked", token: tok, id }, norm(tok)); return tok; }
        const lid = idOf.get(+num);
        if (!lid) { fail({ kind: "unknown", token: tok, n: +num }, norm(tok)); return tok; }
        if (!sent) return tok;
        const i = sent.indexOf(lid);
        if (i < 0) { fail({ kind: "unsent", token: tok, n: +num, id: lid }, norm(tok)); return tok; }
        return `{@ref:${i}}`;
    });
    return { text: out, errors };
}

/**
 * The text with each token written as a name, for a route that sends no reference pictures (an upscale, a text run).
 * `names(key)` gets "img<n>" for a live token or "?<id>" for a parked one and answers a name or null; a name goes
 * through `clean`, so it cannot bring a token or a marker into the text. A token without a name is left as found and
 * listed in `missing`. Tokens are listed normalised, once each, in the order they first appear.
 * @param {string} text
 * @param {(key: string) => string | null | undefined} names
 * @returns {{ text: string, replaced: { token: string, name: string }[], missing: string[] }}
 */
export function namesFor(text, names) {
    const s = String(text == null ? "" : text);
    const replaced = [], missing = [], got = new Map();
    const out = s.replace(re(), (tok, num, id) => {
        const key = id ? "?" + id : "img" + num;
        if (!got.has(key)) {
            const raw = names(key), token = norm(tok), name = raw == null ? null : clean(raw);
            got.set(key, name);
            if (name == null) missing.push(token);
            else replaced.push({ token, name });
        }
        const name = got.get(key);
        return name == null ? tok : name;
    });
    return { text: out, replaced, missing };
}

/**
 * A layer name fit to stand in a prompt or an instruction: no `@`, `"`, `{` or `}`, white space (line breaks
 * included) as single spaces, trimmed, at most 60 characters, "unnamed" when nothing is left.
 * @param {unknown} name
 */
export function clean(name) {
    const s = String(name == null ? "" : name).replace(/[@"{}]/g, "").replace(/\s+/g, " ").trim();
    const cut = Array.from(s).slice(0, 60).join("").trim();
    return cut || "unnamed";
}

/** @typedef {{ id: string, n: number, name: string }} NamedRef  a reference the prompt names: layer id, label, layer name */

/**
 * How an upsample instruction names one reference (26d1): its token and its layer's name.
 * @param {NamedRef} r
 */
export function referenceName(r) {
    return `@img${r.n} (the layer "${clean(r.name)}")`;
}

/**
 * The `{references}` placeholder (26d1): which tokens the request uses and what each names, with a leading space like
 * `{hint}`; "" when the prompt names none, so an instruction without references stays as it was.
 * @param {NamedRef[]} refs  sorted by label
 */
export function referencesText(refs) {
    if (!refs || !refs.length) return "";
    return ` The request names ${refs.length === 1 ? "this reference image" : "these reference images"} by token: ${refs.map(referenceName).join(", ")}.`;
}

/**
 * The rule every upsample instruction gets when the prompt names references (26d1): keep the tokens as they are, add
 * none, never write a picture's number. "" when it names none.
 * @param {NamedRef[]} refs  sorted by label
 */
export function referencesRule(refs) {
    if (!refs || !refs.length) return "";
    const list = refs.map((r) => "@img" + r.n).join(", ");
    return `Reference tokens: keep every token of the request (${list}) exactly as written, lower case, never translated, quoted or split, as often as the request uses it and next to the words it belongs to. Write no token the request does not use, never replace a token with a description of its picture, and never name a picture by a number such as "image 2".`;
}

/**
 * A `compare` result for the status line (26d1); "" when the rewrite kept the tokens. Never the word "failed": an
 * agent's `upsample_prompt` reads that in the status as an error.
 * @param {{ dropped: string[], invented: string[], literals: string[] } | null} cmp
 */
export function checkNote(cmp) {
    if (!cmp) return "";
    const parts = [];
    if (cmp.dropped && cmp.dropped.length) parts.push("dropped " + cmp.dropped.join(", "));
    if (cmp.invented && cmp.invented.length) parts.push("added " + cmp.invented.join(", "));
    if (cmp.literals && cmp.literals.length) parts.push("wrote " + cmp.literals.map((l) => `"${l}"`).join(", "));
    return parts.length ? `Check the tokens: the rewrite ${parts.join("; ")}.` : "";
}

// how a model names a picture by number instead of by token (26d1): "image 3", "img1" without the @, "<image3>",
// "<frame>2</frame>" and the app's own marker; the marker and the bracket forms first, so "<image3>" counts once. The
// number ends the word: "picture 2x sharper" or "image 4k" is no picture's number
const LITERAL = String.raw`\{@ref:\d+\}|<image\s*\d+>|<frame>\d+</frame>|(?<![@\w])(?:image|picture|img|bild|reference|ref)[ _#-]?\d+(?!\w)`;

/** the tokens of a text, normalised, once each, in order */
function tokensOf(text) {
    const out = [];
    for (const seg of parse(text)) if (seg.type === "token" && !out.includes(norm(seg.text))) out.push(norm(seg.text));
    return out;
}

/** the literals of a text: a key that ignores case and separators ("Image 3" = "image3") -> the first as found */
function literalsOf(text) {
    const out = new Map();
    for (const m of String(text == null ? "" : text).matchAll(new RegExp(LITERAL, "gi"))) {
        const key = m[0].toLowerCase().replace(/[\s_#-]+/g, "");
        if (!out.has(key)) out.set(key, m[0]);
    }
    return out;
}

/**
 * A rewrite checked against its request (26d1): the tokens it `dropped` and `invented` (sets: a token written twice or
 * once more is no difference; normalised strings), and the `literals` it wrote that name a picture by number (as found)
 * while the request holds no such literal itself. `allowed`: label numbers the answer may name although the request
 * does not; 26d1 passes the request's own, so every token the answer adds counts as invented.
 * @param {string} req
 * @param {string} ans
 * @param {Iterable<number> | null} [allowed]
 * @returns {{ dropped: string[], invented: string[], literals: string[] }}
 */
export function compare(req, ans, allowed) {
    const want = tokensOf(req), got = tokensOf(ans);
    const ok = new Set(allowed ? Array.from(allowed, Number) : []);
    const live = (t) => /^@img\d/.test(t);
    const dropped = want.filter((t) => !got.includes(t));
    const invented = got.filter((t) => !want.includes(t) && !(live(t) && ok.has(+t.slice(4))));
    const held = literalsOf(req);
    const literals = [...literalsOf(ans)].filter(([key]) => !held.has(key)).map(([, found]) => found);
    return { dropped, invented, literals };
}

const high = (c) => c >= 0xd800 && c <= 0xdbff;
const low = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Where two texts differ, by common prefix and suffix: `a.slice(start, endA)` became `b.slice(start, endB)`. The range
 * never splits a surrogate pair.
 * @param {string} a
 * @param {string} b
 * @returns {{ start: number, endA: number, endB: number }}
 */
export function diffRange(a, b) {
    const x = String(a == null ? "" : a), y = String(b == null ? "" : b);
    const min = Math.min(x.length, y.length);
    let start = 0;
    while (start < min && x.charCodeAt(start) === y.charCodeAt(start)) start++;
    if (start > 0 && x !== y && high(x.charCodeAt(start - 1))) start--;
    let end = 0;
    while (end < min - start && x.charCodeAt(x.length - 1 - end) === y.charCodeAt(y.length - 1 - end)) end++;
    if (end > 0 && low(x.charCodeAt(x.length - end))) end--;
    return { start, endA: x.length - end, endB: y.length - end };
}

/**
 * An offset into `a` (a caret) carried into `b`: one before the change stays, one after it shifts by the change's
 * length, one inside it goes to the change's end in `b`. So when a remap turns `@img2` into the longer `@img?L1k3`, a
 * caret stays after the same word, not at the same number.
 * @param {number} off
 * @param {string} a
 * @param {string} b
 */
export function mapOffset(off, a, b) {
    const { start, endA, endB } = diffRange(a, b);
    const o = Math.max(0, Math.min(Number(off) || 0, String(a == null ? "" : a).length));
    if (o <= start) return o;
    if (o >= endA) return o + endB - endA;
    return endB;
}
