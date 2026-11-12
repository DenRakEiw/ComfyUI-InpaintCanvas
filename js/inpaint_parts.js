// Generated from DenRakEiw/scumble renderer/editor/inpaint_parts.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// Parts of a class or an object kept in modules of their own (item 56, docs/PLAN_SPLIT.md §2).
//
// A part module holds an ordinary class whose body is methods moved out of a long class, text unchanged:
//     export class LiquifyPart { liquifyHint() { ... } ... }
// The long file installs it right after its class:  installParts(InpaintEditor, [LiquifyPart, ...]);
// Every own property descriptor of the part's prototype but `constructor` is copied onto the target's prototype, so
// methods stay non-enumerable and accessors stay accessors (never Object.assign: it reads an accessor as a value and
// makes methods enumerable). A name the target or another part already has throws: no linter sees a duplicate across
// files. A target that is a plain object (host.js) takes parts that are plain objects the same way.
//
// A leaf: no imports, no side effect at import (the node's ComfyUI page loads its js/ in any order).

const ownKeys = (o) => [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)];
const label = (p, i) => (p && p.name) || `part ${i}`;

/**
 * Install `parts` onto `target`: a class (its prototype takes the parts' prototypes) or a plain object (it takes the
 * parts' own properties). Returns the names installed, in order.
 * @param {Function|object} target
 * @param {Array<Function|object>} parts
 * @returns {Array<string|symbol>}
 */
export function installParts(target, parts) {
    const isClass = typeof target === "function";
    const into = isClass ? target.prototype : target;
    if (!into || (typeof into !== "object" && typeof into !== "function")) throw new TypeError("installParts: no target");
    const from = new Map();   // name -> the part that brought it
    const plan = [];
    parts.forEach((part, i) => {
        if (isClass) {
            if (typeof part !== "function" || !part.prototype) throw new TypeError(`installParts: ${label(part, i)} is not a class`);
            const statics = ownKeys(part).filter((k) => k !== "length" && k !== "name" && k !== "prototype");
            if (statics.length) throw new Error(`installParts: ${label(part, i)} has static members (${statics.map(String).join(", ")}); statics stay in the class`);
        } else if (!part || typeof part !== "object") {
            throw new TypeError(`installParts: part ${i} is not an object`);
        }
        const src = isClass ? part.prototype : part;
        for (const key of ownKeys(src)) {
            if (isClass && key === "constructor") continue;
            const name = String(key);
            if (Object.prototype.hasOwnProperty.call(into, key)) throw new Error(`installParts: ${label(part, i)}.${name} is already on ${isClass ? target.name + ".prototype" : "the target"}`);
            if (from.has(key)) throw new Error(`installParts: ${label(part, i)}.${name} is also in ${from.get(key)}`);
            from.set(key, label(part, i));
            plan.push([key, Object.getOwnPropertyDescriptor(src, key)]);
        }
    });
    // nothing is installed unless every part fits
    for (const [key, desc] of plan) Object.defineProperty(into, key, desc);
    return plan.map(([key]) => key);
}
