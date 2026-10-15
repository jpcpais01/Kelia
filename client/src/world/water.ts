// Mirror Lake and the Silverrun river (with Silverfall). One shader handles
// both: depth from the terrain heightmap drives colour, transparency and
// shoreline foam; flow scrolls along the river and speeds up over the falls.
import {
  Color3,
  Effect,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
  VertexData,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import {
  FALL_S0,
  FALL_S1,
  LAKE,
  RIVER_POINTS,
  RIVER_TOTAL,
  WATER_LEVEL,
  riverHalfWidth,
  riverWaterY,
} from '@kelia/shared';
import type { Atmosphere } from './atmosphere';

Effect.ShadersStore['keliaWaterVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 flowData; // xy = flow dir, z = speed, w = falls factor
uniform mat4 viewProjection;
uniform vec4 params; // x = time
varying vec3 vPos;
varying vec2 vUv;
varying vec4 vFlow;
void main(void) {
  vec3 p = position;
  float t = params.x;
  // Gentle swell on open water only.
  float open = 1.0 - flowData.w;
  p.y += (sin(p.x * 0.21 + t * 1.1) * 0.5 + sin(p.z * 0.17 - t * 0.9) * 0.5) * 0.035 * open;
  vPos = p;
  vUv = uv;
  vFlow = flowData;
  gl_Position = viewProjection * vec4(p, 1.0);
}
`;

Effect.ShadersStore['keliaWaterFragmentShader'] = /* glsl */ `
precision highp float;
varying vec3 vPos;
varying vec2 vUv;
varying vec4 vFlow;
uniform sampler2D heightTex;
uniform vec3 cameraPos;
uniform vec4 params; // x = time, y = night
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 deepColor;
uniform vec3 shallowColor;

float terrainH(vec2 xz) {
  vec2 g = clamp(xz + 512.0, vec2(0.0), vec2(1023.99));
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 ii = ivec2(i);
  float a = texelFetch(heightTex, ii, 0).r;
  float b = texelFetch(heightTex, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, ii + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float waves(vec2 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.13 + 7.1) * 0.3 + vnoise(p * 4.7 - 3.3) * 0.2;
}

void main(void) {
  float t = params.x;
  float ground = terrainH(vPos.xz);
  float depth = vPos.y - ground;
  if (depth < -0.05) discard;

  vec2 dir = vFlow.xy;
  float speed = vFlow.z;
  float falls = vFlow.w;
  vec2 side = vec2(-dir.y, dir.x);
  // Coordinates that move with the current.
  vec2 fp = vec2(dot(vPos.xz, side), dot(vPos.xz, dir));
  vec2 p1 = fp * vec2(0.55, 0.35) - vec2(0.0, t * speed * 0.55);
  vec2 p2 = fp * vec2(1.1, 0.8) - vec2(t * 0.05, t * speed * 0.9);
  vec2 p3 = vPos.xz * 0.12 + vec2(t * 0.02, -t * 0.015);
  float e = 0.12;
  float h0 = waves(p1) + waves(p2) * 0.6 + waves(p3) * 0.8;
  float hx = waves(p1 + vec2(e, 0.0)) + waves(p2 + vec2(e, 0.0)) * 0.6 + waves(p3 + vec2(e, 0.0)) * 0.8;
  float hz = waves(p1 + vec2(0.0, e)) + waves(p2 + vec2(0.0, e)) * 0.6 + waves(p3 + vec2(0.0, e)) * 0.8;
  float strength = mix(0.35, 0.9, clamp(speed / 3.0, 0.0, 1.0));
  vec3 n = normalize(vec3((h0 - hx) * strength * 2.0, 1.0, (h0 - hz) * strength * 2.0));
  // rotate the perturbation back from flow space to world
  n = normalize(vec3(n.x * side.x + n.z * dir.x, n.y, n.x * side.y + n.z * dir.y));

  vec3 V = normalize(cameraPos - vPos);
  float NdotV = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  vec3 R = reflect(-V, n);
  float ry = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(horizonColor, zenithColor, pow(ry, 0.45));
  vec3 H = normalize(V + sunDir);
  float spec = pow(max(dot(n, H), 0.0), 380.0) * 6.0 + pow(max(dot(n, H), 0.0), 40.0) * 0.12;
  vec3 sun = sunColor * spec * step(0.0, sunDir.y);

  float d = max(depth, 0.0);
  float absorb = 1.0 - exp(-d * 0.55);
  vec3 body = mix(shallowColor, deepColor, absorb);
  // light the water body softly
  float light = 0.35 + 0.65 * clamp(sunDir.y + 0.2, 0.0, 1.0);
  body *= light * (1.0 - params.y * 0.6);
  vec3 col = mix(body, sky, fresnel) + sun;

  // Foam: shorelines, rocks in the current and the falls.
  float foamNoise = vnoise(fp * vec2(2.2, 1.0) - vec2(0.0, t * speed * 1.6)) * 0.6 + vnoise(vPos.xz * 1.7 + t * 0.3) * 0.4;
  float shore = smoothstep(0.35, 0.0, d) * smoothstep(0.35, 0.75, foamNoise + 0.25);
  float rapids = smoothstep(2.4, 4.5, speed) * smoothstep(0.45, 0.8, foamNoise);
  float fallsFoam = falls * smoothstep(0.25, 0.65, foamNoise + 0.2);
  float foam = clamp(max(max(shore, rapids), fallsFoam), 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.85, 0.9, 0.92), sunColor * 0.9 + zenithColor * 0.4, 0.3) * light;
  col = mix(col, foamCol, foam * 0.85);

  float alpha = clamp(smoothstep(0.0, 0.9, d) * 0.85 + fresnel * 0.4 + foam * 0.6, 0.0, 0.97);
  alpha = max(alpha, falls * 0.9);

  float dist = length(cameraPos - vPos);
  float fog = exp(-pow(dist * fogDensity, 2.0));
  col = mix(fogColor, col, fog);
  gl_FragColor = vec4(col, alpha);
}
`;

function riverPointAt(s: number): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 1; i < RIVER_POINTS.length; i++) {
    const [ax, az] = RIVER_POINTS[i - 1];
    const [bx, bz] = RIVER_POINTS[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (s <= acc + len || i === RIVER_POINTS.length - 1) {
      const t = Math.min(1, Math.max(0, (s - acc) / len));
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / len, dz: (bz - az) / len };
    }
    acc += len;
  }
  const [x, z] = RIVER_POINTS[RIVER_POINTS.length - 1];
  return { x, z, dx: 0, dz: -1 };
}

export class Water {
  readonly material: ShaderMaterial;
  readonly meshes: Mesh[] = [];
  private params = new Vector4();
  private deep = Color3.FromHexString('#0f3d4f').toLinearSpace();
  private shallow = Color3.FromHexString('#3c8f8c').toLinearSpace();

  constructor(private scene: Scene, heightTex: Texture, private atmosphere: Atmosphere) {
    const mat = new ShaderMaterial('water', scene, 'keliaWater', {
      attributes: ['position', 'uv', 'flowData'],
      uniforms: ['viewProjection', 'params', 'cameraPos', 'sunDir', 'sunColor', 'zenithColor', 'horizonColor', 'fogColor', 'fogDensity', 'deepColor', 'shallowColor'],
      samplers: ['heightTex'],
      needAlphaBlending: true,
    });
    mat.setTexture('heightTex', heightTex);
    mat.backFaceCulling = false;
    mat.alphaMode = 2; // ALPHA_COMBINE
    this.material = mat;
    this.meshes.push(this.buildRiver(), this.buildLake());
    for (const m of this.meshes) {
      m.material = mat;
      m.isPickable = false;
      m.alwaysSelectAsActiveMesh = false;
      m.renderingGroupId = 0;
    }
  }

  private buildRiver(): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const flow: number[] = [];
    const indices: number[] = [];
    const across = 9;
    let s = 0;
    let row = 0;
    while (s <= RIVER_TOTAL + 0.01) {
      const p = riverPointAt(s);
      const wy = riverWaterY(s);
      const hw = riverHalfWidth(s) + 6.5;
      const onFalls = s > FALL_S0 - 2 && s < FALL_S1 + 1;
      // speed: calm on the plateau, fast at the lip, churning at the foot
      const slope = Math.abs(riverWaterY(s + 1) - riverWaterY(s - 1)) / 2;
      const speed = Math.min(6, 0.7 + slope * 9);
      const fallsF = onFalls ? 1 : Math.max(0, 1 - Math.abs(s - FALL_S1) / 14) * 0.7;
      for (let k = 0; k < across; k++) {
        const u = (k / (across - 1)) * 2 - 1;
        const x = p.x + -p.dz * u * hw;
        const z = p.z + p.dx * u * hw;
        positions.push(x, wy, z);
        uvs.push(u, s);
        flow.push(p.dx, p.dz, speed, fallsF);
      }
      if (row > 0) {
        const a = (row - 1) * across;
        const b = row * across;
        for (let k = 0; k < across - 1; k++) indices.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
      row++;
      s += onFalls ? 0.4 : 2;
    }
    const mesh = new Mesh('river', this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    mesh.setVerticesData('flowData', flow, false, 4);
    return mesh;
  }

  private buildLake(): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const flow: number[] = [];
    const indices: number[] = [];
    const rings = 24;
    const segs = 72;
    const R = LAKE.radius + 26;
    positions.push(LAKE.center[0], WATER_LEVEL, LAKE.center[1]);
    uvs.push(0, 0);
    flow.push(0.6, 0.8, 0.15, 0);
    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * R;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        positions.push(LAKE.center[0] + Math.cos(a) * rad, WATER_LEVEL, LAKE.center[1] + Math.sin(a) * rad);
        uvs.push(r / rings, k / segs);
        flow.push(0.6, 0.8, 0.15, 0);
      }
    }
    for (let k = 0; k < segs; k++) indices.push(0, 1 + ((k + 1) % segs), 1 + k);
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * segs;
      const b0 = 1 + r * segs;
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        indices.push(a0 + k, a0 + k1, b0 + k, a0 + k1, b0 + k1, b0 + k);
      }
    }
    const mesh = new Mesh('lake', this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    mesh.setVerticesData('flowData', flow, false, 4);
    return mesh;
  }

  update(time: number, cameraPos: Vector3) {
    const a = this.atmosphere;
    const m = this.material;
    m.setVector4('params', this.params.set(time, a.state.night, 0, 0));
    m.setVector3('cameraPos', cameraPos);
    m.setVector3('sunDir', a.sunDir.y > -0.05 ? a.sunDir : a.moonDir);
    m.setColor3('sunColor', a.sunDir.y > -0.05 ? a.state.sun.scale(Math.min(1.5, a.state.sunIntensity / 2.5)) : new Color3(0.5, 0.6, 0.8));
    m.setColor3('zenithColor', a.state.zenith);
    m.setColor3('horizonColor', a.state.horizon);
    m.setColor3('fogColor', a.state.fog);
    m.setFloat('fogDensity', this.scene.fogDensity);
    m.setColor3('deepColor', this.deep);
    m.setColor3('shallowColor', this.shallow);
  }
}
