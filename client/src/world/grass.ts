// GPU grass and wildflowers. Each field is one instanced mesh whose blades
// live on a world-locked lattice that wraps around the camera, so there is
// zero per-frame CPU work no matter how far you run. Density comes from the
// terrain splat map, heights from the heightmap texture, and blades sway with
// rolling wind gusts and part around characters.
import {
  Color3,
  Effect,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import { SHRINE, VILLAGE } from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import type { Atmosphere } from './atmosphere';

Effect.ShadersStore['keliaGrassVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
attribute vec4 grassInst;
uniform mat4 viewProjection;
uniform vec4 field;   // x = period, y = fade radius, z = inner cut radius, w = density scale
uniform vec4 shape;   // x = height, y = width, z = flower mode, w = time
uniform vec3 camPos;
uniform vec4 wind;    // xy = dir, z = strength, w = gust scale
uniform vec4 pushers[4];
uniform sampler2D heightTex;
uniform sampler2D splatTex;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vPos;
varying float vGust;
varying vec4 vSplat;
varying float vRand;

float terrainH(vec2 xz) {
  vec2 g = clamp(xz + 512.0, vec2(0.0), vec2(1023.99));
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 ii = ivec2(i);
  float a = texelFetch(heightTex, ii, 0).r;
  float b = texelFetch(heightTex, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, ii + ivec2(1, 1), 0).r;
  // match the terrain mesh triangulation (diagonal from (0,0) to (1,1))
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}

void main(void) {
  float P = field.x;
  vec2 base = camPos.xz - P * 0.5;
  vec2 wp = base + mod(grassInst.xy - base, P);
  float dist = length(wp - camPos.xz);

  vec4 sp = texelFetch(splatTex, ivec2(clamp(wp + 512.5, vec2(0.0), vec2(1024.0))), 0);
  vSplat = sp;
  float dens = clamp((1.0 - sp.g * 1.6) * (1.0 - sp.b * 1.8) * (1.0 - sp.a * 1.4), 0.0, 1.0);
  if (shape.z > 0.5) dens *= (1.0 - sp.r) * 0.9; // flowers prefer open meadows
  else dens *= 1.0 - sp.r * 0.45;
  float keep = step(grassInst.z, dens * field.w);
  float fade = 1.0 - smoothstep(field.y * 0.6, field.y, dist);
  float inner = smoothstep(field.z - 2.0, field.z + 2.0, dist);
  float s = keep * fade * inner * (0.55 + 0.9 * grassInst.w);
  // taller, lusher grass in the forest edge, short near paths
  s *= mix(1.0, 1.35, sp.r) * (1.0 - sp.a * 0.5);
  // kept short in the village and around the shrine
  s *= mix(0.6, 1.0, smoothstep(${VILLAGE.radius.toFixed(1)} - 12.0, ${VILLAGE.radius.toFixed(1)} + 6.0, length(wp - vec2(${VILLAGE.center[0].toFixed(1)}, ${VILLAGE.center[1].toFixed(1)}))));
  s *= mix(0.5, 1.0, smoothstep(${SHRINE.radius.toFixed(1)} - 2.0, ${SHRINE.radius.toFixed(1)} + 6.0, length(wp - vec2(${SHRINE.center[0].toFixed(1)}, ${SHRINE.center[1].toFixed(1)}))));

  float ang = grassInst.z * 43.7 + grassInst.w * 17.0;
  float ca = cos(ang); float sa = sin(ang);
  vec3 lp = vec3(position.x * shape.y, position.y * shape.x, position.z * shape.y);
  lp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
  lp *= s;

  // Wind: steady sway + rolling gust bands that travel across the meadow.
  float t = shape.w;
  float hgt = uv.y;
  float bend = hgt * hgt;
  float along = dot(wp, wind.xy);
  float gust = sin(along * 0.07 * wind.w - t * 1.6) * 0.5 + 0.5;
  gust = gust * gust * (0.6 + 0.4 * sin(dot(wp, vec2(-wind.y, wind.x)) * 0.05 + t * 0.4));
  vGust = gust;
  float sway = sin(t * 2.3 + wp.x * 0.7 + wp.y * 0.5 + grassInst.z * 6.0) * 0.12;
  vec2 w = wind.xy * (wind.z * (0.25 + gust * 0.9)) + vec2(-wind.y, wind.x) * sway * wind.z;
  lp.xz += w * bend * s * shape.x;

  // Characters push the grass aside.
  for (int i = 0; i < 4; i++) {
    vec2 d = wp - pushers[i].xz;
    float r = pushers[i].w;
    float l = length(d);
    float f = (1.0 - smoothstep(r * 0.3, r, l)) * step(0.001, r);
    lp.xz += (d / max(l, 0.001)) * f * bend * 0.9 * s;
    lp.y *= 1.0 - f * 0.55 * hgt;
  }

  vec3 wpos = vec3(wp.x, terrainH(wp) - 0.02, wp.y) + lp;
  vPos = wpos;
  vUv = uv;
  vColor = color;
  vRand = grassInst.z;
  gl_Position = viewProjection * vec4(wpos, 1.0);
}
`;

Effect.ShadersStore['keliaGrassFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vPos;
varying float vGust;
varying vec4 vSplat;
varying float vRand;
uniform vec4 shape;
uniform vec3 camPos;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientColor;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 baseColor;
uniform vec3 tipColor;
uniform vec3 dryColor;
uniform vec3 forestColor;

vec3 flowerPalette(float r) {
  if (r < 0.2) return vec3(0.95, 0.93, 0.85);
  if (r < 0.4) return vec3(1.0, 0.82, 0.25);
  if (r < 0.6) return vec3(0.68, 0.45, 0.95);
  if (r < 0.8) return vec3(0.98, 0.45, 0.55);
  return vec3(0.45, 0.65, 1.0);
}

void main(void) {
  float h = vUv.y;
  vec3 col;
  if (shape.z > 0.5) {
    // flowers: vertex colour alpha marks petals
    vec3 petal = flowerPalette(fract(vRand * 7.31));
    col = mix(vec3(0.22, 0.42, 0.14), petal, vColor.a);
    col = col * col; // to linear-ish
  } else {
    float dry = smoothstep(0.55, 0.95, fract(vRand * 3.7));
    vec3 tip = mix(tipColor, dryColor, dry * 0.7);
    tip = mix(tip, forestColor * 1.4, vSplat.r * 0.8);
    vec3 bse = mix(baseColor, forestColor * 0.6, vSplat.r);
    col = mix(bse, tip, smoothstep(0.0, 1.0, h));
    col *= 0.8 + 0.4 * fract(vRand * 13.7);
  }
  // Lighting: soft lambert + translucency toward the sun + ambient sky.
  vec3 N = vec3(0.0, 1.0, 0.0);
  float ndl = clamp(dot(N, sunDir) * 0.6 + 0.4, 0.0, 1.0);
  vec3 V = normalize(camPos - vPos);
  float trans = pow(clamp(dot(-V, sunDir), 0.0, 1.0), 3.0) * h * 0.9;
  float ao = mix(0.6, 1.0, h);
  vec3 lit = col * (sunColor * (ndl + trans) + ambientColor) * ao;
  lit += col * vGust * 0.12 * sunColor * h; // gusts catch the light
  float dist = length(camPos - vPos);
  float fog = exp(-pow(dist * fogDensity, 2.0));
  gl_FragColor = vec4(mix(fogColor, lit, fog), 1.0);
}
`;

function bladeGeometry(): VertexData {
  // A slightly curved, tapered blade: 4 segments, 9 vertices.
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const segs = 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = 0.5 * (1 - Math.pow(t, 1.6));
    const curve = t * t * 0.25;
    if (i < segs) {
      positions.push(-w, t, curve, w, t, curve);
      uvs.push(0, t, 1, t);
      colors.push(1, 1, 1, 0, 1, 1, 1, 0);
    } else {
      positions.push(0, t, curve);
      uvs.push(0.5, 1);
      colors.push(1, 1, 1, 0);
    }
  }
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const last = (segs - 1) * 2;
  indices.push(last, last + 2, last + 1);
  const vd = new VertexData();
  vd.positions = positions;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.indices = indices;
  return vd;
}

function flowerGeometry(): VertexData {
  // Thin stem + two crossed petal quads at the top (alpha = petal mask).
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const quad = (pts: number[][], petal: number, v0: number, v1: number) => {
    const b = positions.length / 3;
    for (const [i, p] of pts.entries()) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(i === 0 || i === 3 ? 0 : 1, i < 2 ? v0 : v1);
      colors.push(1, 1, 1, petal);
    }
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const sw = 0.04;
  quad([[-sw, 0, 0], [sw, 0, 0], [sw, 0.85, 0], [-sw, 0.85, 0]], 0, 0, 0.85);
  // five petals in a slightly cupped star
  const y = 0.85;
  const center = positions.length / 3;
  positions.push(0, y + 0.03, 0);
  uvs.push(0.5, 1);
  colors.push(1, 1, 1, 0.35);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const r = k % 2 === 0 ? 0.5 : 0.18;
    positions.push(Math.cos(a) * r, y + (k % 2 === 0 ? 0.08 : 0.02), Math.sin(a) * r);
    uvs.push(0.5, 1);
    colors.push(1, 1, 1, 1);
  }
  for (let k = 0; k < 10; k++) indices.push(center, center + 1 + k, center + 1 + ((k + 1) % 10));
  const vd = new VertexData();
  vd.positions = positions;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.indices = indices;
  return vd;
}

interface Field {
  mesh: Mesh;
  mat: ShaderMaterial;
  shape: [number, number, number];
  fv: Vector4;
}

export class Grass {
  private fields: Field[] = [];
  private pushers = new Float32Array(16);
  private shapeV = new Vector4();
  readonly wind = new Vector4(0.8, 0.6, 0.55, 1);

  constructor(private scene: Scene, private heightTex: Texture, private splatTex: Texture, private atmosphere: Atmosphere) {}

  applyQuality(q: QualitySettings) {
    for (const f of this.fields) {
      f.mesh.dispose();
      f.mat.dispose();
    }
    this.fields = [];
    const innerR = q.grassRadius * 0.34;
    // inner dense field, outer sparse field of bigger tufts, and flowers
    this.addField('grassNear', bladeGeometry(), innerR, 0, q.grassDensity, { h: 0.4, w: 0.07, flower: false });
    this.addField('grassFar', bladeGeometry(), q.grassRadius, innerR, q.grassDensity * 0.3, { h: 0.5, w: 0.12, flower: false });
    this.addField('flowers', flowerGeometry(), Math.min(q.grassRadius, 46), 0, q.grassDensity * 0.05, { h: 0.3, w: 0.28, flower: true });
  }

  private addField(name: string, geo: VertexData, radius: number, innerCut: number, density: number, shape: { h: number; w: number; flower: boolean }) {
    const period = radius * 2;
    // jittered lattice
    const cell = 1 / Math.sqrt(density);
    const n = Math.max(1, Math.floor(period / cell));
    const count = n * n;
    const inst = new Float32Array(count * 4);
    let seed = 12345 + Math.round(radius * 31);
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++, k++) {
        inst[k * 4] = (i + rnd()) * (period / n);
        inst[k * 4 + 1] = (j + rnd()) * (period / n);
        inst[k * 4 + 2] = rnd();
        inst[k * 4 + 3] = rnd();
      }
    }
    const mesh = new Mesh(name, this.scene);
    geo.applyToMesh(mesh);
    const buf = new VertexBuffer(this.scene.getEngine(), inst, 'grassInst', { updatable: false, stride: 4, size: 4, instanced: true, divisor: 1 });
    mesh.setVerticesBuffer(buf);
    mesh.forcedInstanceCount = count;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    const mat = new ShaderMaterial(name + 'Mat', this.scene, 'keliaGrass', {
      attributes: ['position', 'uv', 'color', 'grassInst'],
      uniforms: ['viewProjection', 'field', 'shape', 'camPos', 'wind', 'pushers', 'sunDir', 'sunColor', 'ambientColor', 'fogColor', 'fogDensity', 'baseColor', 'tipColor', 'dryColor', 'forestColor'],
      samplers: ['heightTex', 'splatTex'],
    });
    mat.backFaceCulling = false;
    mat.setTexture('heightTex', this.heightTex);
    mat.setTexture('splatTex', this.splatTex);
    mat.setColor3('baseColor', Color3.FromHexString('#3a6524').toLinearSpace());
    mat.setColor3('tipColor', Color3.FromHexString('#86ad48').toLinearSpace());
    mat.setColor3('dryColor', Color3.FromHexString('#c9b766').toLinearSpace());
    mat.setColor3('forestColor', Color3.FromHexString('#3d6a2a').toLinearSpace());
    mesh.material = mat;
    const fv = new Vector4(period, radius, innerCut, 1);
    this.fields.push({ mesh, mat, shape: [shape.h, shape.w, shape.flower ? 1 : 0], fv });
  }

  /** Up to four characters that bend the grass (x, z, radius). */
  setPushers(list: { x: number; z: number; r: number }[]) {
    this.pushers.fill(0);
    for (let i = 0; i < Math.min(4, list.length); i++) {
      this.pushers[i * 4] = list[i].x;
      this.pushers[i * 4 + 2] = list[i].z;
      this.pushers[i * 4 + 3] = list[i].r;
    }
  }

  update(time: number, cameraPos: Vector3) {
    const a = this.atmosphere;
    const s = a.state;
    const sunUp = a.sunDir.y > -0.05;
    const sunCol = (sunUp ? s.sun : new Color3(0.45, 0.55, 0.85)).scale(Math.min(2.2, a.sun.intensity * 0.55));
    const amb = s.zenith.add(s.horizon).scale(0.5 * s.ambient * 0.9);
    this.fields.forEach((f) => {
      const m = f.mat;
      m.setVector4('field', f.fv);
      m.setVector4('shape', this.shapeV.set(f.shape[0], f.shape[1], f.shape[2], time));
      m.setVector3('camPos', cameraPos);
      m.setVector4('wind', this.wind);
      m.setArray4('pushers', Array.from(this.pushers));
      m.setVector3('sunDir', sunUp ? a.sunDir : a.moonDir);
      m.setColor3('sunColor', sunCol);
      m.setColor3('ambientColor', amb);
      m.setColor3('fogColor', s.fog);
      m.setFloat('fogDensity', this.scene.fogDensity);
    });
  }
}
