// Procedural sky, sun, moon, stars and clouds, plus the time-of-day lighting
// model that drives the sun light, ambient light, fog and exposure.
import {
  Color3,
  Effect,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  StandardMaterial,
  Vector3,
  Vector4,
  type Scene,
} from '@babylonjs/core';

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
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}

void main(void) {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float t = params.x;
  float night = params.y;

  // Base gradient: horizon -> zenith, with a soft band near the horizon.
  float up = clamp(h, 0.0, 1.0);
  vec3 col = mix(horizonColor, zenithColor, pow(up, 0.45));

  // Warm scattering around the sun (sunrise/sunset glow).
  float sd = max(dot(dir, sunDir), 0.0);
  float horizonBand = exp(-abs(h) * 6.0);
  col += sunColor * (pow(sd, 6.0) * 0.35 * params.w * (0.4 + horizonBand) + pow(sd, 48.0) * 0.6);

  // Sun disk
  float disk = smoothstep(0.99955, 0.99975, sd);
  col += sunColor * disk * 28.0 * (1.0 - night);

  // Moon
  float md = max(dot(dir, moonDir), 0.0);
  float moon = smoothstep(0.99935, 0.9996, md);
  vec2 moonUv = (dir.xz - moonDir.xz) * 120.0;
  float craters = 0.82 + 0.18 * vnoise(moonUv * 2.0);
  col += vec3(0.85, 0.9, 1.0) * moon * 2.6 * craters * night;
  col += vec3(0.25, 0.32, 0.5) * pow(md, 64.0) * 0.35 * night;

  // Stars (twinkling), fading in at night and hidden near the horizon.
  if (night > 0.01) {
    vec3 sp = dir * 260.0;
    vec3 cell = floor(sp);
    float r = hash3(cell);
    if (r > 0.9965) {
      vec3 c = cell + 0.5 + (vec3(hash3(cell + 1.3), hash3(cell + 2.7), hash3(cell + 5.1)) - 0.5) * 0.6;
      float d = length(sp - c);
      float tw = 0.65 + 0.35 * sin(t * (1.5 + r * 6.0) + r * 40.0);
      float star = smoothstep(0.42, 0.0, d) * tw;
      vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), hash3(cell + 9.0));
      col += tint * star * 3.0 * night * smoothstep(0.02, 0.25, h);
    }
    // faint milky band
    float band = exp(-pow(dot(dir, normalize(vec3(0.3, 0.6, 0.74))) * 3.2, 2.0));
    col += vec3(0.12, 0.13, 0.2) * band * fbm(dir.xz * 9.0 + 3.0) * night * smoothstep(0.0, 0.3, h);
  }

  // Clouds on a virtual dome.
  if (h > 0.0) {
    vec2 uv = dir.xz / (h + 0.12) * 1.6;
    vec2 wind = vec2(t * 0.0045, t * 0.0016);
    float base = fbm(uv + wind);
    float detail = fbm(uv * 3.1 - wind * 1.7);
    float cover = params.z;
    float dens = smoothstep(1.0 - cover, 1.0 - cover + 0.32, base * 0.75 + detail * 0.35);
    dens *= smoothstep(0.0, 0.18, h);
    // Light the clouds from the sun side.
    float lit = clamp(0.55 + 0.45 * dot(normalize(vec3(dir.x, 0.25, dir.z)), sunDir) + (detail - 0.5) * 0.6, 0.0, 1.0);
    vec3 cc = mix(cloudShade, cloudLight, lit);
    cc += sunColor * pow(sd, 10.0) * 0.8 * (1.0 - dens * 0.5); // silver lining
    col = mix(col, cc, dens * 0.92);
  }

  // Below the horizon blends into the distant ground haze.
  col = mix(col, groundColor, smoothstep(0.0, -0.12, h));
  gl_FragColor = vec4(col, 1.0);
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
  { t: 0.3, zenith: '#3f78c9', horizon: '#cfe0ef', sun: '#ffe2b8', sunI: 3.0, amb: 0.85, fog: '#bcd2e4', fogD: 0.0026, exp: 1.0, glow: 0.6, night: 0, cl: '#ffffff', cs: '#a7b5c9' },
  { t: 0.5, zenith: '#2f6fd0', horizon: '#c4dcf2', sun: '#fff4e2', sunI: 3.8, amb: 1.0, fog: '#bed6ea', fogD: 0.0018, exp: 0.95, glow: 0.35, night: 0, cl: '#ffffff', cs: '#9fb0c6' },
  { t: 0.7, zenith: '#3a6bc0', horizon: '#e2d6c2', sun: '#ffdcaa', sunI: 3.1, amb: 0.85, fog: '#d6d2c6', fogD: 0.0024, exp: 1.0, glow: 0.7, night: 0, cl: '#fff3e0', cs: '#a8a5b5' },
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
  readonly sunBillboard: Mesh;
  private sunMat: StandardMaterial;
  private params = new Vector4();

  constructor(scene: Scene) {
    this.dome = MeshBuilder.CreateSphere('sky', { diameter: 3000, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    this.dome.infiniteDistance = true;
    this.dome.isPickable = false;
    this.dome.applyFog = false;
    this.material = new ShaderMaterial('skyMat', scene, 'kelia' + 'Sky', {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'zenithColor', 'horizonColor', 'groundColor', 'sunDir', 'sunColor', 'moonDir', 'params', 'cloudLight', 'cloudShade'],
    });
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.dome.material = this.material;
    this.dome.renderingGroupId = 0;
    this.dome.alwaysSelectAsActiveMesh = true;

    // A bright disc that the light-shaft post effect uses as its source.
    this.sunBillboard = MeshBuilder.CreateDisc('sunDisc', { radius: 40, tessellation: 32 }, scene);
    this.sunMat = new StandardMaterial('sunDiscMat', scene);
    this.sunMat.emissiveColor = new Color3(1, 0.95, 0.85);
    this.sunMat.disableLighting = true;
    this.sunBillboard.material = this.sunMat;
    this.sunBillboard.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.sunBillboard.isPickable = false;
    this.sunBillboard.applyFog = false;
    this.sunBillboard.visibility = 0; // only used by the light-shaft pass
  }

  update(state: SkyState, sunDir: Vector3, moonDir: Vector3, time: number, cloudCover: number, cameraPos: Vector3) {
    const m = this.material;
    m.setColor3('zenithColor', state.zenith);
    m.setColor3('horizonColor', state.horizon);
    m.setColor3('groundColor', state.ground);
    m.setColor3('sunColor', state.sun);
    m.setVector3('sunDir', sunDir);
    m.setVector3('moonDir', moonDir);
    m.setVector4('params', this.params.set(time, state.night, cloudCover, state.glow));
    m.setColor3('cloudLight', state.cloudLight);
    m.setColor3('cloudShade', state.cloudShade);
    this.sunBillboard.position.copyFrom(cameraPos).addInPlace(sunDir.scale(900));
    this.sunMat.emissiveColor.copyFrom(state.sun);
  }
}
