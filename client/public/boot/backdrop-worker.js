// Live loading-screen backdrop, drawn off the main thread so it stays smooth while the
// world is being built. Each scene is a hero shot plus a small motion mask
// (r = sky, g = water, b = plants); a shader brings it to life: clouds drift, water
// ripples and glints, waterfalls pour, grass sways under rolling gusts, and motes of
// light float up through the air. Scenes slowly pan and crossfade into each other.
'use strict';

const HOLD = 9.0; // seconds a scene is on screen before the next fades in
const FADE = 2.6;

const VS = `#version 300 es
in vec2 p;
out vec2 vUv;
void main() { vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uC0, uM0, uC1, uM1;
uniform vec4 uK0, uK1;      // pan: xy = centre, z = zoom, w = scene time
uniform vec4 uF0, uF1;      // waterfall box (x0, y0, x1, y1) in image uv, zero when none
uniform float uWind0, uWind1, uMix, uTime, uAspect;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.55 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.3) * 0.15; }

// image uv for this screen pixel: cover-fit 16:9 into the screen, then the slow pan
vec2 imageUv(vec4 k) {
  vec2 uv = vUv - 0.5;
  float img = 16.0 / 9.0;
  if (uAspect > img) uv.y *= img / uAspect; else uv.x *= uAspect / img;
  return k.xy + uv / k.z;
}

vec3 scene(sampler2D C, sampler2D M, vec4 k, vec4 fall, float wind) {
  float t = k.w;
  vec2 uv = imageUv(k);
  vec4 m = texture(M, uv);
  vec2 d = vec2(0.0);

  // plants: everything sways a little, and gusts roll across the meadow
  float gust = smoothstep(0.35, 1.0, sin(uv.x * 5.0 * wind - t * 1.1 + fbm(uv * 3.0) * 4.0) * 0.5 + 0.5);
  float near = smoothstep(0.35, 1.0, uv.y);
  float sway = sin(t * 2.3 + uv.x * 60.0 + vnoise(uv * 40.0) * 6.0) * (0.35 + gust) + gust * 0.8 * wind;
  d.x += sway * m.b * (0.0006 + 0.0022 * near);
  d.y += abs(sway) * m.b * 0.0006 * near;

  // water: soft ripples
  vec2 rp = uv * vec2(70.0, 190.0);
  d += (vec2(vnoise(rp + vec2(t * 0.6, t * 1.4)), vnoise(rp.yx + vec2(-t * 0.9, t * 0.7))) - 0.5) * vec2(0.0035, 0.0022) * m.g;

  vec3 c = texture(C, uv + d).rgb;

  // sky: clouds drift with the wind (two staggered phases so the scroll never jumps)
  if (m.r > 0.01) {
    float speed = 0.07, reach = 0.035;
    vec3 sky = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 2; i++) {
      float ph = fract(t * speed + float(i) * 0.5);
      float w = 1.0 - abs(ph * 2.0 - 1.0);
      vec2 su = uv - vec2(reach * wind * (ph - 0.5), 0.0);
      su += (vec2(fbm(su * 4.0 + t * 0.03), fbm(su * 4.0 + 9.0 - t * 0.02)) - 0.5) * 0.006;
      float inSky = texture(M, su).r;
      vec3 s = mix(c, texture(C, su).rgb, smoothstep(0.55, 0.95, inSky));
      sky += s * w;
      wsum += w;
    }
    c = mix(c, sky / max(wsum, 1e-3), smoothstep(0.2, 0.9, m.r));
  }

  // waterfall: pour downwards
  if (fall.z > fall.x && uv.x > fall.x && uv.x < fall.z && uv.y > fall.y && uv.y < fall.w && m.g > 0.05) {
    vec3 pour = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 2; i++) {
      float ph = fract(t * 0.55 + float(i) * 0.5);
      float w = 1.0 - abs(ph * 2.0 - 1.0);
      vec2 su = uv - vec2(sin(uv.y * 40.0 + t) * 0.001, 0.05 * ph);
      float ok = texture(M, su).g;
      pour += mix(c, texture(C, su).rgb, smoothstep(0.3, 0.8, ok)) * w;
      wsum += w;
    }
    vec3 p = pour / max(wsum, 1e-3);
    // white foam streaks
    float streak = smoothstep(0.62, 0.95, vnoise(vec2(uv.x * 220.0, uv.y * 14.0 - t * 2.6)));
    p += streak * 0.18;
    c = mix(c, p, smoothstep(0.1, 0.6, m.g));
  }

  // water: sun glints that twinkle
  float g = vnoise(uv * vec2(260.0, 520.0) + vec2(t * 0.8, -t * 0.5)) * vnoise(uv * vec2(130.0, 300.0) - t * 0.4);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c += smoothstep(0.42, 0.62, g) * m.g * (0.25 + lum) * vec3(1.0, 0.95, 0.85) * 0.55;

  // grass sheen riding the gusts
  c *= 1.0 + gust * m.b * near * 0.06;
  return c;
}

vec3 motes(vec3 c) {
  vec2 s = vec2(vUv.x * uAspect, vUv.y);
  vec3 add = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float n = 7.0 + fl * 5.0;
    vec2 p = s * n + vec2(sin(uTime * 0.13 + fl) * 0.6, uTime * (0.10 + fl * 0.05));
    vec2 cell = floor(p), f = fract(p) - 0.5;
    float r = h21(cell + fl * 17.0);
    if (r > 0.42) continue;
    vec2 off = vec2(h21(cell + 3.1), h21(cell + 7.7)) - 0.5;
    off += vec2(sin(uTime * (0.5 + r) + r * 40.0), cos(uTime * (0.4 + r) + r * 20.0)) * 0.12;
    float dist = length(f - off * 0.7);
    float size = 0.035 + 0.04 * h21(cell + 2.2) - fl * 0.006;
    float tw = 0.55 + 0.45 * sin(uTime * (1.0 + r * 2.0) + r * 60.0);
    add += vec3(1.0, 0.86, 0.6) * smoothstep(size, 0.0, dist) * tw * (0.5 - fl * 0.12);
  }
  return c + add * 0.6;
}

void main() {
  vec3 a = scene(uC0, uM0, uK0, uF0, uWind0);
  vec3 c = uMix > 0.0 ? mix(a, scene(uC1, uM1, uK1, uF1, uWind1), uMix) : a;
  o = vec4(motes(c), 1.0);
}`;

let gl, prog, canvas, U = {};
let scenes = [], order = [], cur = null, next = null, nextAt = 0, t0 = 0, stopped = false, dpr = 1;
let pending = new Map();

function fail(why) {
  stopped = true;
  postMessage({ type: 'fail', why: String(why) });
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function texture(bitmap) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  bitmap.close?.();
  return t;
}

async function bitmapOf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// load a scene's picture and mask (once)
function load(i) {
  if (pending.has(i)) return pending.get(i);
  const s = scenes[i];
  const p = Promise.all([bitmapOf(s.base + '.webp'), bitmapOf(s.base + '.mask.png')]).then(([c, m]) => {
    if (stopped) return null;
    return { s, c: texture(c), m: texture(m), born: 0, pan: i % 4 };
  });
  pending.set(i, p);
  return p;
}

// slow pan: each scene drifts from one framing to another over its time on screen
const PANS = [
  [0.49, 0.5, 1.04, 0.51, 0.49, 1.12],
  [0.51, 0.49, 1.12, 0.49, 0.505, 1.04],
  [0.508, 0.506, 1.05, 0.492, 0.496, 1.13],
  [0.494, 0.506, 1.1, 0.508, 0.497, 1.03],
];
function pan(sc, now) {
  const age = now - sc.born;
  const k = Math.min(1, age / (HOLD + FADE * 2));
  const e = k * k * (3 - 2 * k) * 0.6 + k * 0.4;
  const p = PANS[sc.pan];
  return [p[0] + (p[3] - p[0]) * e, p[1] + (p[4] - p[1]) * e, p[2] + (p[5] - p[2]) * e, age];
}

function bind(unit, tex, name) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(U[name], unit);
}

function setScene(sc, slot, now) {
  bind(slot * 2, sc.c, 'uC' + slot);
  bind(slot * 2 + 1, sc.m, 'uM' + slot);
  gl.uniform4fv(U['uK' + slot], pan(sc, now));
  gl.uniform4fv(U['uF' + slot], sc.s.fall || [0, 0, 0, 0]);
  gl.uniform1f(U['uWind' + slot], sc.s.wind || 1);
}

let step = 0;
function frame(ms) {
  if (stopped) return;
  const now = ms / 1000 - t0;
  if (cur) {
    if (!next && now >= nextAt) {
      const idx = order[++step % order.length];
      load(idx).then((sc) => {
        if (!sc || stopped) return;
        sc.born = performance.now() / 1000 - t0;
        next = sc;
      }, () => {});
      nextAt = Infinity;
    }
    let mix = 0;
    if (next) {
      mix = Math.min(1, (now - next.born) / FADE);
      mix = mix * mix * (3 - 2 * mix);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, now);
    gl.uniform1f(U.uAspect, canvas.width / canvas.height);
    gl.uniform1f(U.uMix, mix);
    setScene(cur, 0, now);
    if (next) setScene(next, 1, now);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (next && mix >= 1) {
      gl.deleteTexture(cur.c);
      gl.deleteTexture(cur.m);
      pending.delete(scenes.indexOf(cur.s));
      cur = next;
      next = null;
      nextAt = now + HOLD;
      load(order[(step + 1) % order.length]).catch(() => {});
    }
  }
  requestAnimationFrame(frame);
}

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'size') {
    if (canvas) {
      canvas.width = Math.max(1, Math.round(msg.w * dpr));
      canvas.height = Math.max(1, Math.round(msg.h * dpr));
    }
    return;
  }
  if (msg.type === 'stop') {
    stopped = true;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    close();
    return;
  }
  if (msg.type !== 'init') return;
  try {
    canvas = msg.canvas;
    dpr = msg.dpr;
    scenes = msg.scenes;
    canvas.width = Math.max(1, Math.round(msg.w * dpr));
    canvas.height = Math.max(1, Math.round(msg.h * dpr));
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', desynchronized: true });
    if (!gl) return fail('no webgl2');
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ['uC0', 'uM0', 'uC1', 'uM1', 'uK0', 'uK1', 'uF0', 'uF1', 'uWind0', 'uWind1', 'uMix', 'uTime', 'uAspect']) U[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const n = scenes.length;
    order = Array.from({ length: n }, (_, i) => (msg.start + i) % n);
    t0 = performance.now() / 1000;
    cur = await load(order[0]);
    if (!cur) return;
    cur.born = performance.now() / 1000 - t0;
    nextAt = cur.born + HOLD;
    load(order[1]).catch(() => {});
    requestAnimationFrame(frame);
    postMessage({ type: 'ready' });
  } catch (err) {
    fail(err && err.message);
  }
};
