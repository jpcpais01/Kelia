// Contact shading: soft ambient occlusion from characters and monsters onto
// everything around them.
//
// The shadow map draws the sun's shadow, but under a high sun that shadow
// hides beneath the body, and the sky light keeps reaching the ground right up
// to the feet, so people looked pasted onto the world. Each character is
// stood in for by an upright capsule, and every lit surface (terrain, props,
// buildings, other characters and the grass) works out analytically how much
// of its sky that capsule hides. Feet get a dark, soft contact blob, the
// grass around them dims, and two people standing close shade each other,
// all without an extra pass.
//
// Only the few capsules nearest the camera are sent to the shaders; farther
// away the blob is a few pixels wide and nobody misses it.
import { Vector3, Vector4, type TransformNode } from '@babylonjs/core';

/** How many capsules the shaders take. */
export const CONTACT_COUNT = 4;
/** Past this distance from the camera a capsule is not worth sending. */
const RANGE = 60;

interface Tracked {
  node: TransformNode;
  radius: number;
  height: number;
}

const tracked = new Set<Tracked>();
const tmp = new Vector3();

export const contact = {
  /** xyz = feet, w = capsule radius (0 = unused slot). */
  occ: Array.from({ length: CONTACT_COUNT }, () => new Vector4(0, -1e4, 0, 0)),
  /** Capsule heights, one per slot. */
  height: new Vector4(0, 0, 0, 0),
  /** x = strength on the sky light, y = strength on the sun light. */
  strength: new Vector4(0.85, 0.45, 0, 0),
};

/** Shade the world around this node (a character's root, at its feet) while it lives. */
export function trackContact(node: TransformNode, radius: number, height: number) {
  const t: Tracked = { node, radius, height };
  tracked.add(t);
  node.onDisposeObservable.addOnce(() => tracked.delete(t));
}

const picked: { t: Tracked; d: number }[] = [];

/** Send the capsules nearest the camera to the shaders (once per frame). */
export function updateContacts(cam: Vector3) {
  picked.length = 0;
  for (const t of tracked) {
    if (!t.node.isEnabled()) continue;
    const p = t.node.getAbsolutePosition();
    const d = Vector3.DistanceSquared(p, cam);
    if (d > RANGE * RANGE) continue;
    picked.push({ t, d });
  }
  picked.sort((a, b) => a.d - b.d);
  const h = [0, 0, 0, 0];
  for (let i = 0; i < CONTACT_COUNT; i++) {
    const e = picked[i];
    if (!e) {
      contact.occ[i].set(0, -1e4, 0, 0);
      continue;
    }
    tmp.copyFrom(e.t.node.getAbsolutePosition());
    const s = e.t.node.absoluteScaling.y || 1;
    contact.occ[i].set(tmp.x, tmp.y, tmp.z, e.t.radius * s);
    h[i] = e.t.height * s;
  }
  contact.height.set(h[0], h[1], h[2], h[3]);
}

export const CONTACT_UNIFORMS = ['toonOcc0', 'toonOcc1', 'toonOcc2', 'toonOcc3', 'toonOccH', 'toonOccK'] as const;

export const CONTACT_VALUES: Record<(typeof CONTACT_UNIFORMS)[number], Vector4> = {
  toonOcc0: contact.occ[0],
  toonOcc1: contact.occ[1],
  toonOcc2: contact.occ[2],
  toonOcc3: contact.occ[3],
  toonOccH: contact.height,
  toonOccK: contact.strength,
};

// kContact(P, N) = how much of the sky above P (facing N) is still open, 0..1.
// Each capsule is a vertical segment of spheres; the nearest sphere on the
// segment hides about  cos(angle) * r² / d²  of the hemisphere (the classic
// analytic sphere occlusion), faded out a few radii away so it stays local.
// Straight-line maths only, no branches or texture reads, so it is safe in
// any shader stage and in WGSL's uniform control flow.

/** For hand-written GLSL ShaderMaterials: declares the uniforms too. */
export const CONTACT_GLSL = /* glsl */ `
uniform vec4 toonOcc0;
uniform vec4 toonOcc1;
uniform vec4 toonOcc2;
uniform vec4 toonOcc3;
uniform vec4 toonOccH;
uniform vec4 toonOccK;
`;

/** The functions (GLSL), for shaders that already declare the uniforms. */
export const CONTACT_FUNCS_GLSL = /* glsl */ `
float kOccOne(vec4 o, float h, vec3 P, vec3 N) {
  float r = max(o.w, 1e-3);
  float y = clamp(P.y, o.y + r, o.y + max(h - r, r));
  vec3 d = vec3(o.x, y, o.z) - P;
  float dd = max(dot(d, d), 1e-4);
  float dl = sqrt(dd);
  float c = clamp(dot(N, d) / dl, 0.0, 1.0);
  float occ = c * min(1.6 * r * r / dd, 1.0);
  return occ * (1.0 - smoothstep(r * 2.5, r * 4.0, dl)) * step(1e-3, o.w);
}
float kContact(vec3 P, vec3 N) {
  float v = (1.0 - kOccOne(toonOcc0, toonOccH.x, P, N)) * (1.0 - kOccOne(toonOcc1, toonOccH.y, P, N))
          * (1.0 - kOccOne(toonOcc2, toonOccH.z, P, N)) * (1.0 - kOccOne(toonOcc3, toonOccH.w, P, N));
  return v;
}
`;

/** The same functions in WGSL (the toon material plugin's uniforms). */
export const CONTACT_FUNCS_WGSL = /* wgsl */ `
fn kOccOne(o: vec4f, h: f32, P: vec3f, N: vec3f) -> f32 {
  let r = max(o.w, 1e-3);
  let y = clamp(P.y, o.y + r, o.y + max(h - r, r));
  let d = vec3f(o.x, y, o.z) - P;
  let dd = max(dot(d, d), 1e-4);
  let dl = sqrt(dd);
  let c = clamp(dot(N, d) / dl, 0.0, 1.0);
  let occ = c * min(1.6 * r * r / dd, 1.0);
  return occ * (1.0 - smoothstep(r * 2.5, r * 4.0, dl)) * step(1e-3, o.w);
}
fn kContact(P: vec3f, N: vec3f) -> f32 {
  return (1.0 - kOccOne(uniforms.toonOcc0, uniforms.toonOccH.x, P, N)) * (1.0 - kOccOne(uniforms.toonOcc1, uniforms.toonOccH.y, P, N))
       * (1.0 - kOccOne(uniforms.toonOcc2, uniforms.toonOccH.z, P, N)) * (1.0 - kOccOne(uniforms.toonOcc3, uniforms.toonOccH.w, P, N));
}
`;
