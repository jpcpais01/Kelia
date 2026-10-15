// Ground colours shared by the terrain and the grass, so every blade grows
// out of exactly the colour of the soil beneath it and a meadow reads as one
// soft, painted surface rather than blades on a carpet.
import { Color3 } from '@babylonjs/core';

const lin = (hex: string): [number, number, number] => {
  const c = Color3.FromHexString(hex).toLinearSpace();
  return [c.r, c.g, c.b];
};

export const GROUND = {
  /** Meadow, cool and warm ends of the large colour drifts. */
  grassA: lin('#4f8c3c'),
  grassB: lin('#8db84f'),
  /** Sun-bleached patches. */
  grassDry: lin('#c9bd62'),
  /** Under the trees. */
  forestCol: lin('#2f6a38'),
  rockCol: lin('#9d968c'),
  sandCol: lin('#ead9a6'),
  dirtCol: lin('#a8835c'),
};

/**
 * GLSL: the meadow colour at a world position, identical to the terrain
 * shader's grass layer. Needs uniforms grassA, grassB, grassDry, forestCol and
 * the detail noise sampler `detailTex`; `sp` is the splat sample.
 */
export const GROUND_GRASS_GLSL = /* glsl */ `
vec3 groundGrass(vec2 xz, vec4 sp) {
  vec4 d = textureLod(detailTex, xz * 0.21, 0.0);
  vec4 d2 = textureLod(detailTex, xz * 0.027, 0.0);
  vec4 d3 = textureLod(detailTex, xz * 0.0041, 0.0);
  vec3 g = mix(grassA, grassB, smoothstep(0.25, 0.75, d3.a));
  g = mix(g, grassDry, smoothstep(0.55, 0.85, d2.a) * 0.6);
  g *= 0.9 + 0.2 * d.r;
  return mix(g, forestCol * (0.8 + 0.45 * d.g), sp.r);
}
`;
