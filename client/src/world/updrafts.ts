// Updrafts made visible: each column of rising air is drawn as two thin
// shells of wind streaks spiralling upwards in opposite directions, a swirl
// on the ground where it starts, and a flurry of leaves riding it up. All of
// it is animated on the GPU (two draws for every updraft in the world).
import { Constants, Effect, Mesh, ShaderMaterial, Vector4, VertexData, type Scene, type Vector3 } from '@babylonjs/core';
import { UPDRAFTS, type Heightmap } from '@kelia/shared';
import { TOON_FOG_GLSL, TOON_FOG_UNIFORMS, bindToonFog, toon } from './toon';

Effect.ShadersStore['keliaUpdraftVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec2 uv2;
uniform mat4 viewProjection;
varying vec2 vUv;
varying vec2 vInfo;
varying vec3 vPos;
void main() {
  vUv = uv;
  vInfo = uv2;
  vPos = position;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore['keliaUpdraftFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec2 vInfo; // x = layer (0 outer, 1 inner, 2 ground swirl), y = column height (m)
varying vec3 vPos;
uniform vec3 camPos;
uniform vec4 params; // x = time, y = daylight
${TOON_FOG_GLSL}
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float t = params.x;
  float layer = vInfo.x;
  float a = vUv.x;
  float h = vUv.y;
  float alpha;
  // the streak coordinate and its screen-space width are worked out before
  // branching: WGSL only allows fwidth in uniform control flow (WebGPU
  // rejects the whole shader otherwise, and with it the frame)
  float H = vInfo.y;
  float inner = layer;
  float s = a * (inner > 0.5 ? 5.0 : 8.0) + h * H / (inner > 0.5 ? 7.0 : 11.0);
  float w = 0.05 + fwidth(s) * 1.2;
  if (layer > 1.5) {
    // ground swirl: arms curling in towards the centre, turning
    float r = h;
    float sw = a * 5.0 + r * 2.2 - t * 0.35;
    float f = fract(sw);
    float arm = smoothstep(0.0, 0.18, f) * smoothstep(0.62, 0.2, f);
    alpha = arm * smoothstep(1.0, 0.55, r) * smoothstep(0.05, 0.3, r) * 0.45;
  } else {
    // streaks along a spiral, opposite turns per shell
    float id = floor(s);
    float f = fract(s);
    float line = smoothstep(0.5 - w, 0.5, f) * smoothstep(0.5 + w, 0.5, f);
    // dashes racing upwards, each streak at its own pace
    float rnd = hash(id + inner * 17.0);
    float along = h * H / (4.0 + 4.0 * rnd) - t * (0.8 + 0.7 * rnd) + rnd * 9.0;
    float g = fract(along);
    // a comet-like dash: bright head, long fading tail
    float dash = smoothstep(0.35, 0.95, g) * smoothstep(1.0, 0.95, g);
    alpha = line * dash * (inner > 0.5 ? 0.4 : 0.65);
    // fade in from the ground and out towards the top
    alpha *= smoothstep(0.0, 0.06, h) * smoothstep(1.0, 0.7, h);
  }
  float d = distance(camPos, vPos);
  // not too dense in your face while riding it; gone in the far distance
  alpha *= clamp((d - 0.8) / 3.0, 0.0, 1.0) * (1.0 - smoothstep(380.0, 620.0, d));
  vec3 col = mix(vec3(0.82, 0.93, 1.0), vec3(1.0), 0.5) * params.y;
  col = kFog(col, vPos, camPos);
  gl_FragColor = vec4(col, alpha);
}`;

Effect.ShadersStore['keliaUpdraftLeafVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position; // column base
attribute vec4 leaf;     // x = phase, y = radius (m), z = speed, w = size (m)
attribute vec4 corner;   // xy = corner, z = column height, w = turn rate
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec4 params;
varying vec2 vUv;
varying float vFade;
varying float vTint;
void main() {
  float t = params.x;
  float H = corner.z;
  float k = fract(leaf.x * 7.31 + t * leaf.z / H);
  float ang = leaf.x * 6.2831 + t * corner.w;
  float r = leaf.y * (0.75 + 0.35 * sin(t * 1.3 + leaf.x * 20.0));
  vec3 c = position + vec3(cos(ang) * r, k * H, sin(ang) * r);
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  // tumbling: the quad spins as it rises
  float spin = t * (3.0 + leaf.z) + leaf.x * 40.0;
  vec2 q = vec2(corner.x * cos(spin) - corner.y * sin(spin), corner.x * sin(spin) + corner.y * cos(spin));
  vec3 p = c + (right * q.x + up * q.y * 0.6) * leaf.w;
  vUv = corner.xy;
  vFade = smoothstep(0.0, 0.08, k) * smoothstep(1.0, 0.8, k);
  vTint = fract(leaf.x * 13.7);
  gl_Position = viewProjection * vec4(p, 1.0);
}`;

Effect.ShadersStore['keliaUpdraftLeafFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vFade;
varying float vTint;
uniform vec4 params;
void main() {
  // a leaf: pointed ellipse with a midrib
  float x = vUv.x;
  float y = vUv.y;
  float wdt = 0.55 * (1.0 - y * y);
  if (abs(x) > wdt) discard;
  vec3 green = mix(vec3(0.35, 0.62, 0.22), vec3(0.85, 0.72, 0.25), vTint);
  float rib = smoothstep(0.08, 0.0, abs(x));
  vec3 col = mix(green, green * 0.7, rib) * params.y;
  gl_FragColor = vec4(col, vFade);
}`;

const SEG = 48;
const LEAVES = 40;

export class Updrafts {
  private mat: ShaderMaterial;
  private leafMat: ShaderMaterial;
  private params = new Vector4(0, 1, 0, 0);

  constructor(scene: Scene, hm: Heightmap) {
    const pos: number[] = [];
    const uv: number[] = [];
    const uv2: number[] = [];
    const idx: number[] = [];
    const lp: number[] = [];
    const leaf: number[] = [];
    const corner: number[] = [];
    const lidx: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const u of UPDRAFTS) {
      const [cx, cz] = u.pos;
      const base = hm.sample(cx, cz) - 0.5;
      const H = u.top - base;
      for (const [layer, rk] of [[0, 1], [1, 0.62]] as const) {
        const r = u.radius * rk;
        const v0 = pos.length / 3;
        for (let i = 0; i <= SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          for (const h of [0, 1]) {
            pos.push(cx + Math.cos(a) * r, base + h * H, cz + Math.sin(a) * r);
            uv.push(i / SEG, h);
            uv2.push(layer, H);
          }
        }
        for (let i = 0; i < SEG; i++) {
          const a = v0 + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      // ground swirl: a disc following the ground
      const v0 = pos.length / 3;
      const RINGS = 5;
      for (let j = 0; j <= RINGS; j++) {
        for (let i = 0; i <= SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          const rr = (j / RINGS) * u.radius * 1.5;
          const x = cx + Math.cos(a) * rr;
          const z = cz + Math.sin(a) * rr;
          pos.push(x, hm.sample(x, z) + 0.08, z);
          uv.push(i / SEG, j / RINGS);
          uv2.push(2, H);
        }
      }
      for (let j = 0; j < RINGS; j++) {
        for (let i = 0; i < SEG; i++) {
          const a = v0 + j * (SEG + 1) + i;
          const b = a + SEG + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      // leaves riding the column
      for (let n = 0; n < LEAVES; n++) {
        const phase = rnd();
        const radius = u.radius * (0.2 + 0.75 * rnd());
        const speed = 3 + 4 * rnd();
        const size = 0.16 + 0.12 * rnd();
        const turn = (0.6 + 0.8 * rnd()) * (rnd() < 0.8 ? 1 : -1);
        const v = lp.length / 3;
        for (const [qx, qy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          lp.push(cx, base + 0.5, cz);
          leaf.push(phase, radius, speed, size);
          corner.push(qx, qy, H, turn);
        }
        lidx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }

    const mesh = new Mesh('updrafts', scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.uvs = uv;
    vd.uvs2 = uv2;
    vd.applyToMesh(mesh);
    this.mat = new ShaderMaterial('updraftMat', scene, 'keliaUpdraft', {
      attributes: ['position', 'uv', 'uv2'],
      uniforms: ['viewProjection', 'camPos', 'params', ...TOON_FOG_UNIFORMS],
      needAlphaBlending: true,
    });
    this.mat.backFaceCulling = false;
    this.mat.disableDepthWrite = true;
    this.mat.alphaMode = Constants.ALPHA_COMBINE;
    mesh.material = this.mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();

    const leaves = new Mesh('updraftLeaves', scene);
    const lv = new VertexData();
    lv.positions = lp;
    lv.indices = lidx;
    lv.applyToMesh(leaves);
    leaves.setVerticesData('leaf', leaf, false, 4);
    leaves.setVerticesData('corner', corner, false, 4);
    this.leafMat = new ShaderMaterial('updraftLeafMat', scene, 'keliaUpdraftLeaf', {
      attributes: ['position', 'leaf', 'corner'],
      uniforms: ['view', 'viewProjection', 'params'],
      needAlphaBlending: true,
    });
    this.leafMat.backFaceCulling = false;
    this.leafMat.disableDepthWrite = true;
    leaves.material = this.leafMat;
    leaves.isPickable = false;
    leaves.alwaysSelectAsActiveMesh = true;
    leaves.freezeWorldMatrix();
  }

  update(time: number, cam: Vector3) {
    // streaks and leaves dim with the light, never glowing at night
    this.params.x = time;
    this.params.y = Math.min(1, 0.3 + toon.sun.x * 1.4 + toon.sky.x * 0.8);
    for (const m of [this.mat, this.leafMat]) m.setVector4('params', this.params);
    this.mat.setVector3('camPos', cam);
    bindToonFog(this.mat);
  }
}
