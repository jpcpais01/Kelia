// Procedural sky, sun, moon, stars and clouds, plus the time-of-day lighting
// model that drives the sun light, ambient light, fog and exposure.
import {
  Color3,
  Effect,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Scene,
} from '@babylonjs/core';
import { drawLast } from './drawOrder';

Effect.ShadersStore['keliaSkyVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main(void) {
  vDir = position;
  vec4 p = worldViewProjection * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

Effect.ShadersStore['keliaSkyFragmentShader'] = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec3 fogColor;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 moonDir;
uniform vec4 params; // x = time (s), y = night (0..1), z = cloud cover, w = sun glow
uniform vec3 cloudLight;
uniform vec3 cloudShade;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.07 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.9375;
}

void main(void) {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float t = params.x;
  float night = params.y;

  // Painted gradient: deep zenith, luminous horizon band.
  float up = clamp(h, 0.0, 1.0);
  vec3 col = mix(horizonColor, zenithColor, smoothstep(0.0, 0.62, pow(up, 0.7)));
  col = mix(col, horizonColor * 1.08 + vec3(0.02), exp(-up * 14.0) * 0.6);

  // Sun: a soft halo, a wide warm glow at dawn/dusk and a crisp bright disk.
  float sd = max(dot(dir, sunDir), 0.0);
  float horizonBand = exp(-abs(h) * 5.0);
  col += sunColor * (pow(sd, 5.0) * 0.32 * params.w * (0.45 + horizonBand) + pow(sd, 60.0) * 0.55 + pow(sd, 900.0) * 1.6);
  col += sunColor * smoothstep(0.99935, 0.99965, sd) * 22.0 * (1.0 - night);

  // Moon with a faint halo.
  float md = max(dot(dir, moonDir), 0.0);
  float moon = smoothstep(0.99925, 0.99955, md);
  float craters = 0.84 + 0.16 * vnoise((dir.xz - moonDir.xz) * 240.0);
  col += vec3(0.88, 0.93, 1.0) * moon * 2.8 * craters * night;
  col += vec3(0.28, 0.36, 0.6) * (pow(md, 48.0) * 0.4 + pow(md, 6.0) * 0.06) * night;

  // Stars (twinkling), fading in at night and hidden near the horizon.
  if (night > 0.01) {
    vec3 sp = dir * 260.0;
    vec3 cell = floor(sp);
    float r = hash3(cell);
    if (r > 0.9962) {
      vec3 c = cell + 0.5 + (vec3(hash3(cell + 1.3), hash3(cell + 2.7), hash3(cell + 5.1)) - 0.5) * 0.6;
      float d = length(sp - c);
      float tw = 0.6 + 0.4 * sin(t * (1.5 + r * 6.0) + r * 40.0);
      float star = smoothstep(0.45, 0.0, d) * tw;
      vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.72), hash3(cell + 9.0));
      col += tint * star * 3.4 * night * smoothstep(0.02, 0.25, h);
    }
    float band = exp(-pow(dot(dir, normalize(vec3(0.3, 0.6, 0.74))) * 3.0, 2.0));
    col += vec3(0.13, 0.12, 0.24) * band * fbm(dir.xz * 7.0 + 3.0) * night * smoothstep(0.0, 0.3, h);
  }

  // Anime cumulus: crisp edges, bright tops, lavender undersides, a silver rim
  // toward the sun. Alpha carries cloud opacity (it blocks the sun shafts).
  float occ = 0.0;
  if (h > 0.0) {
    vec2 uv = dir.xz / (h + 0.11) * 1.25;
    vec2 wind = vec2(t * 0.0042, t * 0.0015);
    float base = fbm(uv + wind);
    float detail = fbm(uv * 2.9 - wind * 1.6);
    float shape = base * 0.78 + detail * 0.32;
    float cover = params.z;
    float edge = 1.0 - cover * 0.95;
    float dens = smoothstep(edge, edge + 0.05, shape) * smoothstep(0.0, 0.16, h);
    float thick = smoothstep(edge, edge + 0.32, shape);
    // light from the sun's side: compare with the shape a step toward the sun
    vec2 toSun = normalize(sunDir.xz + vec2(1e-4)) * 0.09;
    float shapeS = fbm(uv + wind + toSun) * 0.78 + detail * 0.32;
    float lit = clamp(0.62 + (shape - shapeS) * 5.5 + (detail - 0.5) * 0.35, 0.0, 1.0);
    lit = smoothstep(0.25, 0.75, lit);
    vec3 cc = mix(cloudShade, cloudLight, lit);
    cc = mix(cc, cloudShade * 0.92, thick * 0.35 * (1.0 - lit));
    float rim = (1.0 - thick) * pow(sd, 6.0);
    cc += sunColor * (rim * 1.4 + pow(sd, 16.0) * 0.35);
    col = mix(col, cc, dens * 0.96);
    occ = dens * (0.55 + 0.45 * thick);

    // high wispy streaks
    float wisp = fbm(vec2(uv.x * 0.6, uv.y * 2.4) * 0.7 + wind * 0.6);
    float w = smoothstep(0.58, 0.82, wisp) * smoothstep(0.05, 0.35, h) * (1.0 - dens) * 0.35;
    col = mix(col, cloudLight * 0.95 + sunColor * pow(sd, 8.0) * 0.4, w);
  }

  // The horizon melts into the same haze as the ground fog.
  col = mix(col, fogColor, exp(-max(h, 0.0) * 22.0) * 0.55);
  col = mix(col, groundColor, smoothstep(0.0, -0.1, h));
  gl_FragColor = vec4(col, h < 0.0 ? 1.0 : occ);
}
`;

export interface SkyState {
  zenith: Color3;
  horizon: Color3;
  ground: Color3;
  sun: Color3; // sun light colour (also tints the sky glow)
  sunIntensity: number;
  ambient: number; // IBL intensity
  fog: Color3;
  fogDensity: number;
  exposure: number;
  glow: number;
  night: number;
  cloudLight: Color3;
  cloudShade: Color3;
}

const c = (hex: string) => Color3.FromHexString(hex).toLinearSpace();

interface Key {
  t: number;
  zenith: string;
  horizon: string;
  sun: string;
  sunI: number;
  amb: number;
  fog: string;
  fogD: number;
  exp: number;
  glow: number;
  night: number;
  cl: string;
  cs: string;
}

// Time-of-day key frames. 0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
const KEYS: Key[] = [
  { t: 0.0, zenith: '#050a1c', horizon: '#16233f', sun: '#7f9ad6', sunI: 0.35, amb: 0.32, fog: '#141d33', fogD: 0.0042, exp: 1.35, glow: 0.0, night: 1, cl: '#2b3550', cs: '#0d1222' },
  { t: 0.2, zenith: '#0c1630', horizon: '#3a3f63', sun: '#9a8fc4', sunI: 0.3, amb: 0.35, fog: '#2c3150', fogD: 0.0045, exp: 1.3, glow: 0.3, night: 0.85, cl: '#5a5b7c', cs: '#1b1f36' },
  { t: 0.245, zenith: '#2a4a83', horizon: '#f0a070', sun: '#ffb070', sunI: 1.4, amb: 0.55, fog: '#d79a82', fogD: 0.0042, exp: 1.15, glow: 1.6, night: 0.2, cl: '#ffc59a', cs: '#7a6a8a' },
  { t: 0.3, zenith: '#3f78c9', horizon: '#cfe0ef', sun: '#ffe2b8', sunI: 3.0, amb: 0.85, fog: '#bcd2e4', fogD: 0.0026, exp: 1.0, glow: 0.6, night: 0, cl: '#ffffff', cs: '#b0b2d8' },
  { t: 0.5, zenith: '#2a72e2', horizon: '#c6e2f6', sun: '#fff4e2', sunI: 3.8, amb: 1.0, fog: '#bed6ea', fogD: 0.0018, exp: 0.95, glow: 0.35, night: 0, cl: '#ffffff', cs: '#a9b2d8' },
  { t: 0.7, zenith: '#3a6bc0', horizon: '#e2d6c2', sun: '#ffdcaa', sunI: 3.1, amb: 0.85, fog: '#d6d2c6', fogD: 0.0024, exp: 1.0, glow: 0.7, night: 0, cl: '#fff3e0', cs: '#b9a8c6' },
  { t: 0.755, zenith: '#2c4683', horizon: '#ff9a5c', sun: '#ff9550', sunI: 1.6, amb: 0.55, fog: '#e0906c', fogD: 0.004, exp: 1.12, glow: 1.9, night: 0.15, cl: '#ffb27a', cs: '#6d4f6e' },
  { t: 0.8, zenith: '#101a3a', horizon: '#4a3d64', sun: '#9584c4', sunI: 0.35, amb: 0.36, fog: '#2e2b48', fogD: 0.0046, exp: 1.3, glow: 0.4, night: 0.85, cl: '#4b4766', cs: '#181a30' },
  { t: 1.0, zenith: '#050a1c', horizon: '#16233f', sun: '#7f9ad6', sunI: 0.35, amb: 0.32, fog: '#141d33', fogD: 0.0042, exp: 1.35, glow: 0.0, night: 1, cl: '#2b3550', cs: '#0d1222' },
];

const parsed = KEYS.map((k) => ({
  ...k,
  zenithC: c(k.zenith),
  horizonC: c(k.horizon),
  sunC: c(k.sun),
  fogC: c(k.fog),
  clC: c(k.cl),
  csC: c(k.cs),
}));

export function skyStateAt(dayTime: number, out?: SkyState): SkyState {
  const t = ((dayTime % 1) + 1) % 1;
  let i = 0;
  while (i < parsed.length - 2 && parsed[i + 1].t <= t) i++;
  const a = parsed[i];
  const b = parsed[i + 1];
  const f = (t - a.t) / (b.t - a.t);
  const s = out ?? {
    zenith: new Color3(),
    horizon: new Color3(),
    ground: new Color3(),
    sun: new Color3(),
    sunIntensity: 0,
    ambient: 0,
    fog: new Color3(),
    fogDensity: 0,
    exposure: 1,
    glow: 0,
    night: 0,
    cloudLight: new Color3(),
    cloudShade: new Color3(),
  };
  Color3.LerpToRef(a.zenithC, b.zenithC, f, s.zenith);
  Color3.LerpToRef(a.horizonC, b.horizonC, f, s.horizon);
  Color3.LerpToRef(a.sunC, b.sunC, f, s.sun);
  Color3.LerpToRef(a.fogC, b.fogC, f, s.fog);
  Color3.LerpToRef(a.clC, b.clC, f, s.cloudLight);
  Color3.LerpToRef(a.csC, b.csC, f, s.cloudShade);
  s.ground.copyFrom(s.fog).scaleInPlace(0.85);
  s.sunIntensity = a.sunI + (b.sunI - a.sunI) * f;
  s.ambient = a.amb + (b.amb - a.amb) * f;
  s.fogDensity = a.fogD + (b.fogD - a.fogD) * f;
  s.exposure = a.exp + (b.exp - a.exp) * f;
  s.glow = a.glow + (b.glow - a.glow) * f;
  s.night = a.night + (b.night - a.night) * f;
  return s;
}

export class Sky {
  readonly dome: Mesh;
  readonly material: ShaderMaterial;
  private params = new Vector4();

  constructor(scene: Scene) {
    this.dome = MeshBuilder.CreateSphere('sky', { diameter: 3000, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    this.dome.infiniteDistance = true;
    this.dome.isPickable = false;
    this.dome.applyFog = false;
    this.material = new ShaderMaterial('skyMat', scene, 'kelia' + 'Sky', {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'zenithColor', 'horizonColor', 'groundColor', 'fogColor', 'sunDir', 'sunColor', 'moonDir', 'params', 'cloudLight', 'cloudShade'],
    });
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.dome.material = this.material;
    this.dome.renderingGroupId = 0;
    this.dome.alwaysSelectAsActiveMesh = true;
    // shaded last, only where nothing else covers the far plane
    this.material.needAlphaTestingForMesh = () => true;
    drawLast(this.dome);
  }

  update(state: SkyState, sunDir: Vector3, moonDir: Vector3, time: number, cloudCover: number, cameraPos: Vector3) {
    const m = this.material;
    m.setColor3('zenithColor', state.zenith);
    m.setColor3('horizonColor', state.horizon);
    m.setColor3('groundColor', state.ground);
    m.setColor3('fogColor', state.fog);
    m.setColor3('sunColor', state.sun);
    m.setVector3('sunDir', sunDir);
    m.setVector3('moonDir', moonDir);
    m.setVector4('params', this.params.set(time, state.night, cloudCover, state.glow));
    m.setColor3('cloudLight', state.cloudLight);
    m.setColor3('cloudShade', state.cloudShade);
    void cameraPos;
  }
}
