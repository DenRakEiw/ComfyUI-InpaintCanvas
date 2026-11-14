// Generated from DenRakEiw/scumble renderer/editor/inpaint_surfacefx.js by tools/build_node.py. Do not edit here: edit it in the app repo and build.
// @ts-check
// Deep paint's layer (docs/PLAN_SURFACE_PAINT.md §3.2, SP4): a filter layer `surface` whose own pixels hold the paint P
// (straight RGBA). Over the picture below B it lays the paint as the surface's own colour, in linear light:
//
//     out = mix(B, P * S + k * R, a)
//
// with S the document's light (the `shading` map times its `sScale`), R its reflections (`residual`), k the layer's
// "Keep reflections" (0..1) and a the paint's alpha. Where nothing is painted (a = 0) the picture goes through byte for
// byte. The maps are sampled bilinear through `passToMap`, as the depth filters sample theirs; an rgb16 map goes to the
// GPU as two RGBA8 textures (`rgb16Views`: R lo, R hi, G lo, G hi / B lo, B hi) read with texelFetch, so the shader's
// bilinear step is the CPU twin's (`rgb16Bilinear`) on the same 16-bit values.
import { registerGLFilter } from "./inpaint_filters_gl.js";
import { passToMap, sampleMapPx } from "./inpaint_maps.js";
import { SRGB_TO_LIN, linToSrgb255 } from "./inpaint_surface.js";
import { makeCanvas } from "./inpaint_pixels.js";

const DUMMY = { data: new Uint8Array([0, 0, 0, 0]), width: 1, height: 1, channels: 4 };
const VIEWS = new WeakMap();   // map.data -> [lo/hi of R, G | lo/hi of B]

/**
 * An rgb16 map as two RGBA8 sampler values: (R lo, R hi, G lo, G hi) and (B lo, B hi, 0, 0), kept per data array and
 * uploaded once per data version (`static`).
 * @param {any} map
 */
export function rgb16Views(map) {
    if (!map || map.enc !== "rgb16" || !map.data) return null;
    let v = VIEWS.get(map.data);
    if (!v) {
        const n = map.w * map.h, d = map.data;
        const a = new Uint8Array(n * 4), b = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) {
            const r = d[3 * i], g = d[3 * i + 1], bl = d[3 * i + 2];
            a[4 * i] = r & 255; a[4 * i + 1] = r >> 8; a[4 * i + 2] = g & 255; a[4 * i + 3] = g >> 8;
            b[4 * i] = bl & 255; b[4 * i + 1] = bl >> 8;
        }
        v = [a, b];
        VIEWS.set(map.data, v);
    }
    const key = `${map.kind}:${map.dataVersion}`;
    return [
        { data: v[0], width: map.w, height: map.h, channels: 4, static: true, key: key + ":rg" },
        { data: v[1], width: map.w, height: map.h, channels: 4, static: true, key: key + ":b" },
    ];
}

/**
 * Bilinear sample of an rgb16 map at map pixel (x, y) (pixel centres at + 0.5, edge clamp: u16Bilinear's), into `out`
 * as 0..1.
 * @param {Uint16Array} d
 * @param {number} w
 * @param {number} h
 * @param {number} x
 * @param {number} y
 * @param {number[]} out
 */
export function rgb16Bilinear(d, w, h, x, y, out) {
    const qx = x - 0.5, qy = y - 0.5;
    const fx0 = Math.floor(qx), fy0 = Math.floor(qy);
    const fx = qx - fx0, fy = qy - fy0;
    const x0 = fx0 < 0 ? 0 : fx0 > w - 1 ? w - 1 : fx0, x1 = fx0 + 1 < 0 ? 0 : fx0 + 1 > w - 1 ? w - 1 : fx0 + 1;
    const y0 = fy0 < 0 ? 0 : fy0 > h - 1 ? h - 1 : fy0, y1 = fy0 + 1 < 0 ? 0 : fy0 + 1 > h - 1 ? h - 1 : fy0 + 1;
    const i00 = 3 * (y0 * w + x0), i10 = 3 * (y0 * w + x1), i01 = 3 * (y1 * w + x0), i11 = 3 * (y1 * w + x1);
    for (let c = 0; c < 3; c++) {
        const top = d[i00 + c] + fx * (d[i10 + c] - d[i00 + c]);
        const bot = d[i01 + c] + fx * (d[i11 + c] - d[i01 + c]);
        out[c] = (top + fy * (bot - top)) / 65535;
    }
    return out;
}

/** The layer's "Keep reflections" as 0..1. */
export function surfaceK(params) {
    const v = params && params.reflections !== undefined ? Number(params.reflections) : 100;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1;
}

/**
 * The surface's own colour under a picture pixel (Deep paint's eyedropper, SP5): the paint P that the layer turns into
 * the pixel `rgb` (sRGB 0..255) at document point (docX, docY), from the formula's inverse in linear light,
 * P = (B - k R) / (S sScale), clamped to 0..1 and back to sRGB 0..255 into `out`. Painted back with the same k it gives
 * the pixel again, up to the 8-bit step of P times the light; where the light is 0 the colour is black, and where the
 * picture is darker than k R or brighter than S sScale + k R the clamp shows (no paint reaches it).
 * @param {any} maps the document's maps (shading, residual)
 * @param {number} k Keep reflections, 0..1
 * @param {ArrayLike<number>} rgb
 * @param {number} docX
 * @param {number} docY
 * @param {number[]} [out]
 */
export function surfaceAlbedo(maps, k, rgb, docX, docY, out = [0, 0, 0]) {
    const S = maps && maps.shading, R = maps && maps.residual;
    if (!S || !R) { out[0] = rgb[0]; out[1] = rgb[1]; out[2] = rgb[2]; return out; }
    const sScale = (S.meta && S.meta.sScale) || 1;
    const s = sampleMapPx(S, docX, docY), r = sampleMapPx(R, docX, docY);
    for (let c = 0; c < 3; c++) {
        const den = s[c] * sScale;
        let v = den > 1e-6 ? (SRGB_TO_LIN[rgb[c]] - k * r[c]) / den : 0;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        out[c] = Math.round(linToSrgb255(v));
    }
    return out;
}

/** Whether the surface filter can run: both maps present and the layer's own pixels handed over. */
function ready(info) {
    const m = info && info.maps;
    return !!(m && m.shading && m.residual && m.shading.enc === "rgb16" && m.residual.enc === "rgb16" && typeof (info && info.own) === "function");
}

/**
 * The CPU twin. `src` a canvas (the picture below in the pass's pixels), `info.own(w, h)` the layer's paint for the same
 * pixels ({ data, width, height }, straight RGBA8).
 * @param {HTMLCanvasElement} src
 * @param {Record<string, any>} params
 * @param {Record<string, any>} info
 */
export function applySurface(src, params, info) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    if (!octx) return src;
    octx.drawImage(src, 0, 0);
    if (!ready(info)) return out;
    const own = info.own(W, H);
    if (!own || !own.data) return out;
    const img = octx.getImageData(0, 0, W, H);
    const px = img.data, p = own.data;
    const S = info.maps.shading, R = info.maps.residual;
    const sScale = (S.meta && S.meta.sScale) || 1;
    const k = surfaceK(params);
    const ms = passToMap(S, info.scale || 1), mr = passToMap(R, info.scale || 1);
    const origin = (info.full ? info.origin : null) || [0, 0];
    const s = [0, 0, 0], r = [0, 0, 0];
    for (let y = 0; y < H; y++) {
        const py = origin[1] + y + 0.5;   // the pixel's centre, as the shader (pictureUv)
        for (let x = 0; x < W; x++) {
            const i = 4 * (y * W + x);
            const a = p[i + 3];
            if (a === 0) continue;
            const ppx = origin[0] + x + 0.5;
            rgb16Bilinear(S.data, S.w, S.h, ms[0] * ppx + ms[2] * py + ms[4], ms[1] * ppx + ms[3] * py + ms[5], s);
            rgb16Bilinear(R.data, R.w, R.h, mr[0] * ppx + mr[2] * py + mr[4], mr[1] * ppx + mr[3] * py + mr[5], r);
            // the paint over the picture below ("over" in straight alpha: where the picture is transparent the paint's
            // colour stays its own instead of mixing with the black of nothing; over an opaque picture mix(B, t, a))
            const al = a / 255, ab = px[i + 3] / 255, ao = ab + (1 - ab) * al;
            for (let c = 0; c < 3; c++) {
                const b = SRGB_TO_LIN[px[i + c]];
                const t = SRGB_TO_LIN[p[i + c]] * s[c] * sScale + k * r[c];
                let v = (b * ab * (1 - al) + t * al) / ao;
                v = v < 0 ? 0 : v > 1 ? 1 : v;
                px[i + c] = Math.round(linToSrgb255(v));
            }
            px[i + 3] = Math.round(ao * 255);
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/** The shaders' rgb16 map read (two RGBA8 textures of `rgb16Views`) and its bilinear step: Deep paint's and relight's. */
export const RGB16_GLSL = `
vec3 rgb16At(sampler2D a, sampler2D b, ivec2 p) {
    ivec2 q = clamp(p, ivec2(0), textureSize(a, 0) - 1);
    vec4 u = texelFetch(a, q, 0) * 255.0;
    vec2 v = texelFetch(b, q, 0).rg * 255.0;
    return vec3(u.x + 256.0 * u.y, u.z + 256.0 * u.w, v.x + 256.0 * v.y) / 65535.0;
}
vec3 rgb16Bilinear(sampler2D a, sampler2D b, vec2 px) {
    vec2 q = px - 0.5; ivec2 i = ivec2(floor(q)); vec2 f = q - floor(q);
    return mix(mix(rgb16At(a, b, i), rgb16At(a, b, i + ivec2(1, 0)), f.x), mix(rgb16At(a, b, i + ivec2(0, 1)), rgb16At(a, b, i + ivec2(1, 1)), f.x), f.y);
}
`;

const SURFACE_GLSL = RGB16_GLSL + `
vec3 s_toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 s_toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

vec4 shade(vec4 c, vec2 uv) {
    vec4 p = texelFetch(u_own, ivec2(floor(uv * u_size)), 0);
    if (p.a <= 0.0) return c;
    vec2 pp = pictureUv(uv) * u_pictureSize;
    vec3 s = rgb16Bilinear(u_s1, u_s2, vec2(dot(u_ms0.xy, pp) + u_ms1.x, dot(u_ms0.zw, pp) + u_ms1.y)) * u_sScale;
    vec3 r = rgb16Bilinear(u_r1, u_r2, vec2(dot(u_mr0.xy, pp) + u_mr1.x, dot(u_mr0.zw, pp) + u_mr1.y));
    vec3 b = s_toLin(c.rgb);
    vec3 t = s_toLin(p.rgb) * s + u_k * r;
    // "over" in straight alpha (the CPU twin's comment)
    float ao = c.a + (1.0 - c.a) * p.a;
    vec3 v = clamp((b * c.a * (1.0 - p.a) + t * p.a) / ao, 0.0, 1.0);
    return vec4(s_toSrgb(v), ao);
}
`;

let registered = false;

export function registerSurfaceGL() {
    if (registered) return;
    registerGLFilter("surface", {
        uniforms: {
            u_own: "sampler2D", u_s1: "sampler2D", u_s2: "sampler2D", u_r1: "sampler2D", u_r2: "sampler2D",
            u_ms0: "vec4", u_ms1: "vec2", u_mr0: "vec4", u_mr1: "vec2", u_sScale: "float", u_k: "float",
        },
        code: SURFACE_GLSL,
        values: (params, info, src) => {
            const S = info.maps.shading, R = info.maps.residual;
            const ms = passToMap(S, info.scale || 1), mr = passToMap(R, info.scale || 1);
            const sv = rgb16Views(S), rv = rgb16Views(R);
            const own = info.own(src.width, src.height);
            return {
                u_own: own ? { data: own.data, width: own.width, height: own.height, channels: 4 } : DUMMY,
                u_s1: sv[0], u_s2: sv[1], u_r1: rv[0], u_r2: rv[1],
                u_ms0: [ms[0], ms[2], ms[1], ms[3]], u_ms1: [ms[4], ms[5]],
                u_mr0: [mr[0], mr[2], mr[1], mr[3]], u_mr1: [mr[4], mr[5]],
                u_sScale: (S.meta && S.meta.sScale) || 1,
                u_k: surfaceK(params),
            };
        },
        skip: (p, info) => !ready(info),
    });
    registered = true;
}
