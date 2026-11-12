// Generated from DenRakEiw/scumble renderer/editor/inpaint_shaders.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// the emulated blend, dissolve and range preview shaders: moved out of inpaint_canvas.js (item 56 S1, docs/PLAN_SPLIT.md), text unchanged.

import { BLEND_FN_GLSL } from "./inpaint_compositor.js";
import { WEIGHTS_GLSL } from "./inpaint_weights.js";

// emulated blend modes over the backdrop (the input), the W3C source-over-with-blend of inpaint_compositor.js, straight alpha
const EMULATED_BLEND_SHADER = {
    label: "emulated blend",
    uniforms: { u_layer: "sampler2D", u_opacity: "float", u_mode: "int" },
    code: BLEND_FN_GLSL + `vec4 shade(vec4 B, vec2 uv) {
    vec4 S = texture(u_layer, uv);
    float as = S.a * u_opacity, ab = B.a;
    vec3 bl = blendRGB(u_mode, B.rgb, S.rgb);
    vec3 cs = mix(S.rgb, bl, ab);
    float ao = as + ab * (1.0 - as);
    vec3 co = cs * as + B.rgb * ab * (1.0 - as);
    return ao > 0.0 ? vec4(co / ao, ao) : vec4(0.0);
}`,
};
// the same, clipped (PLAN_0_1_31 §6 step 3): the base's coverage scales the layer's alpha, as the compositor's u_clip does
const EMULATED_BLEND_CLIP_SHADER = {
    label: "emulated blend, clipped",
    uniforms: { u_layer: "sampler2D", u_clip: "sampler2D", u_opacity: "float", u_mode: "int" },
    code: EMULATED_BLEND_SHADER.code.replace("float as = S.a * u_opacity,", "float as = S.a * u_opacity * texture(u_clip, uv).a,"),
};

// dissolve over the backdrop (R4-S9): a kept pixel is the layer's colour at full alpha, a dropped one the backdrop. The
// hash runs on image pixels (`u_invX`, `u_invY`: the canvas-to-image map), and the layer's opacity comes in as the
// integer the CPU paths take (`u_alpha255`, Math.round in JS): GLSL's round() leaves the direction at .5 to the GPU
// (half to even is allowed, and ANGLE's D3D11 backend may take it), and float32 0.3 * 255 is exactly 76.5, so at 30 %
// the screen could keep other pixels than the export. Every rounding here is floor(x + 0.5), as Math.round
const DISSOLVE_SHADER = {
    label: "dissolve",
    uniforms: { u_layer: "sampler2D", u_alpha255: "float", u_seed_hi: "float", u_seed_lo: "float", u_invX: "vec3", u_invY: "vec3" },
    code: `
uint lowbias32(uint x) {
    x ^= x >> 16u;
    x *= 0x7feb352du;
    x ^= x >> 15u;
    x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}

uint hash32(uint x, uint y, uint seed) {
    return lowbias32((x * 0x9E3779B1u) ^ (y * 0x85EBCA77u) ^ seed);
}

int mul255(int x, int y) {
    int t = x * y + 128;
    return (t + (t >> 8)) >> 8;
}

vec4 shade(vec4 B, vec2 uv) {
    vec4 S = texture(u_layer, uv);
    vec2 fragPx = uv * u_size;
    int imgX = int(floor(dot(u_invX, vec3(fragPx, 1.0))));
    int imgY = int(floor(dot(u_invY, vec3(fragPx, 1.0))));
    uint seed = uint(u_seed_lo) | (uint(u_seed_hi) << 16u);
    int srcA = int(floor(S.a * 255.0 + 0.5));
    int alpha255 = int(floor(u_alpha255 + 0.5));
    int c = mul255(srcA, alpha255);
    bool keep = (c == 255) || ((hash32(uint(imgX), uint(imgY), seed) >> 24u) < uint(c));
    return keep ? vec4(S.rgb, 1.0) : B;
}
`,
};

const DISSOLVE_CLIP_SHADER = {
    label: "dissolve, clipped",
    uniforms: { u_layer: "sampler2D", u_clip: "sampler2D", u_alpha255: "float", u_seed_hi: "float", u_seed_lo: "float", u_invX: "vec3", u_invY: "vec3" },
    code: DISSOLVE_SHADER.code.replace(
        "int c = mul255(srcA, alpha255);",
        "int mask = int(floor(texture(u_clip, uv).a * 255.0 + 0.5));\n    int c = mul255(mul255(srcA, alpha255), mask);"
    ),
};

/** Red range preview tint shader (R1-S6). */
const RANGE_PREVIEW_SHADER = {
    label: "range preview",
    uniforms: {
        u_source: "int",
        u_range: "vec4",
        u_invert: "bool",
        u_ref: "vec3",
        u_tol: "float",
    },
    code: `
${WEIGHTS_GLSL}

vec4 shade(vec4 color, vec2 uv) {
    float w = w_limit(u_source, color.rgb, 0.0, u_range, u_invert, u_ref, u_tol);
    return vec4(1.0, 0.0, 0.0, w * color.a);
}
`,
};

export { DISSOLVE_CLIP_SHADER, DISSOLVE_SHADER, EMULATED_BLEND_CLIP_SHADER, EMULATED_BLEND_SHADER, RANGE_PREVIEW_SHADER };
