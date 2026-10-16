// Painted stylised rock, shared by the terrain and the far mountain ranges.
//
// Cliffs are broken into big, irregular planes (domain-warped Voronoi cells),
// each with its own tilt and tone, so the cel terminator carves a slope into
// bold lit and shaded faces the way a painted backdrop would. Over that run
// vertical gullies and water stains (side-projected streaks), soft warm/cool
// colour drift with altitude, ochre patches, dark crevices between planes and
// grass caps on sky-facing ledges. Snow settles on flat tops and trickles
// down the gullies.
//
// Faces turned from the sun are painted cooler and darker and sunlit ones a
// touch warmer (kRockSun, applied by the caller so snow gets it too), the
// way a painter splits a mountain into light and shadow masses: the split
// survives the haze, so distant ranges still read as forms instead of a
// flat grey cut-out.
//
// Everything is anti-aliased with screen-space derivatives (no branches, so
// WGSL's uniformity rules are happy) and the crevices fade once they would
// shrink below a pixel.

export const ROCK_UNIFORMS = {
  /** x = facet cell size (m), y = snow line (m), z = facet strength, w = gully texture scale. */
  rockP: 'vec4',
  rockWarm: 'vec3',
  rockCool: 'vec3',
  snowCol: 'vec3',
  mossCol: 'vec3',
} as const;

export const ROCK_DEFAULTS = {
  rockP: [26, 128, 1, 1],
};

export const ROCK_GLSL_DEFS = /* glsl */ `
vec2 kHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// xy = cell id, z = distance to its point, w = to the second nearest
vec4 kVoro(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0;
  float f2 = 8.0;
  vec2 id = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + kHash2(i + g) * 0.85 - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = i + g; } else if (d < f2) { f2 = d; }
    }
  }
  return vec4(id, sqrt(f1), sqrt(f2));
}
`;

export const ROCK_WGSL_DEFS = /* wgsl */ `
fn kHash2(q: vec2f) -> vec2f {
  let p = vec2f(dot(q, vec2f(127.1, 311.7)), dot(q, vec2f(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
fn kVoro(p: vec2f) -> vec4f {
  let i = floor(p);
  let f = p - i;
  var f1 = 8.0;
  var f2 = 8.0;
  var id = i;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let r = g + kHash2(i + g) * 0.85 - f;
      let d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = i + g; } else if (d < f2) { f2 = d; }
    }
  }
  return vec4f(id, sqrt(f1), sqrt(f2));
}
`;

/**
 * GLSL statements. Inputs: `kP` (world position), `kNr` (unit normal),
 * `kD`, `kD2`, `kD3` (detail noise samples at fine/mid/coarse scale) and the
 * `detailTex` sampler. Outputs: `kRockCol` (albedo), `kRockN` (chiselled
 * normal), `kRockH` (0..1 "height" for height-blending), `kSnow` (0..1 snow
 * cover for any layer), `kRockSun` (colour multiplier for the light/shadow
 * split, for the rock and snow layers). Reads the toon plugin's `toonSunDir`.
 */
export const ROCK_GLSL = /* glsl */ `
  // big chiselled planes: each cell of a warped cellular pattern is one flat,
  // tilted face, so the cel terminator carves the slope into bold shapes
  vec2 kG = kP.xz / rockP.x + (kD3.rg - 0.5) * 0.35 + (kD2.rg - 0.5) * 0.12;
  vec4 kV = kVoro(kG);
  vec2 kRnd = kHash2(kV.xy + 17.0);
  float kSteep = smoothstep(0.15, 0.55, 1.0 - kNr.y);
  vec3 kT = normalize(vec3(-kNr.z, 0.0, kNr.x) + vec3(1e-4, 0.0, 0.0));
  vec3 kRockN = normalize(kNr + (kT * (kRnd.x - 0.5) * 1.1 + vec3(0.0, (kRnd.y - 0.5) * 0.5, 0.0)) * rockP.z);
  // crevices between the planes: a thin dark crack inside a soft occluded band
  float kEdgeAA = fwidth(kG.x) + fwidth(kG.y);
  float kEdge = kV.w - kV.z;
  float kCrev = (1.0 - smoothstep(0.0, 0.025 + kEdgeAA * 1.5, kEdge)) * (1.0 - smoothstep(0.1, 0.35, kEdgeAA));
  float kCrevSoft = 1.0 - smoothstep(0.0, 0.2, kEdge);
  // gullies and water stains running down the faces
  float kAx = abs(kNr.x) / (abs(kNr.x) + abs(kNr.z) + 1e-4);
  float kStA = texture2D(detailTex, vec2(kP.z * 0.011, kP.y * 0.006) * rockP.w).b;
  float kStB = texture2D(detailTex, vec2(kP.x * 0.011, kP.y * 0.006) * rockP.w).b;
  float kStreak = mix(kStB, kStA, kAx);
  float kGully = smoothstep(0.56, 0.74, kStreak) * kSteep;
  float kRidge = smoothstep(0.32, 0.14, kStreak) * kSteep;
  // soft, irregular colour layers instead of hard strata lines
  float kLayer = sin(kP.y * 0.085 + kD3.a * 6.0 + kD2.b * 2.5) * 0.5 + 0.5;
  // palette: warm taupe low, blue-grey high, ochre drifts, a tone per plane
  float kAlt = clamp(kP.y / 160.0 + (kD3.a - 0.5) * 0.6, 0.0, 1.0);
  vec3 kRockCol = mix(rockWarm, rockCool, kAlt);
  kRockCol = mix(kRockCol, rockWarm * vec3(1.18, 0.96, 0.7), smoothstep(0.5, 0.8, kD3.b + kRnd.y * 0.3 - 0.1) * 0.55);
  kRockCol *= (0.82 + 0.3 * kRnd.x) * mix(0.93, 1.06, kLayer * kSteep) * (0.93 + 0.12 * kD.r) * (0.84 + 0.28 * smoothstep(0.3, 0.7, kD3.r));
  kRockCol *= 1.0 - 0.3 * kGully + 0.1 * kRidge;
  kRockCol *= mix(1.0, 0.8, kCrevSoft * kSteep) * mix(1.0, 0.5, kCrev * kSteep * smoothstep(0.35, 0.65, kD2.b + kRnd.y * 0.35));
  // grass caps on ledges and gentle tops: crisp edge, a shadowed lip beneath
  float kTop = kNr.y + (kD.r - 0.5) * 0.12 + (kD2.g - 0.5) * 0.2;
  float kBelowSnow = 1.0 - smoothstep(rockP.y - 30.0, rockP.y - 5.0, kP.y);
  float kCap = smoothstep(0.74, 0.765, kTop) * kBelowSnow;
  kRockCol *= mix(1.0, 0.68, smoothstep(0.64, 0.74, kTop) * (1.0 - kCap) * kBelowSnow);
  kRockCol = mix(kRockCol, mossCol * (0.85 + 0.25 * kD.r), kCap);
  kRockN = normalize(mix(kRockN, kNr, kCap * 0.8));
  float kRockH = clamp(0.4 + kRnd.x * 0.3 - kCrev * 0.3 - kGully * 0.2, 0.0, 1.0);
  // snow: crisp caps on gentle faces, and streaks down the gullies below
  float kSnowL = rockP.y + (kD3.a - 0.5) * 36.0 + (kD2.r - 0.5) * 10.0;
  float kSnow = smoothstep(kSnowL, kSnowL + 2.0, kP.y) * smoothstep(0.4, 0.47, kNr.y + (kD.g - 0.5) * 0.15 + (kRnd.y - 0.5) * 0.14);
  kSnow = max(kSnow, smoothstep(kSnowL - 28.0, kSnowL - 4.0, kP.y) * smoothstep(0.6, 0.72, kStreak) * smoothstep(0.1, 0.4, kNr.y + 0.3));
  // light and shadow masses: cool, deep shade sides, warm sunlit faces
  // (steep faces split by which way they face the sun's azimuth, so the
  // masses still read with the sun high overhead)
  vec2 kLh = toonSunDir.xz / max(length(toonSunDir.xz), 1e-3);
  float kSunF = mix(dot(kRockN, toonSunDir.xyz), dot(kRockN.xz / max(length(kRockN.xz), 1e-3), kLh) * 0.6, kSteep * 0.5);
  vec3 kRockSun = mix(vec3(0.64, 0.7, 0.9), vec3(1.08, 1.03, 0.94), smoothstep(-0.3, 0.35, kSunF));
  // screen-space curvature: ridges and buttresses catch the light, creases
  // and gullies fall into shade, so the big forms read at any distance
  vec3 kDpx = dFdx(kP);
  vec3 kDpy = dFdy(kP);
  float kCurv = dot(dFdx(kNr), kDpx) / max(dot(kDpx, kDpx), 1e-6) + dot(dFdy(kNr), kDpy) / max(dot(kDpy, kDpy), 1e-6);
  kRockSun *= 1.0 + 0.32 * clamp(kCurv * rockP.x * 0.3, -1.0, 1.0);
`;

export const ROCK_WGSL = /* wgsl */ `
  let kG = kP.xz / uniforms.rockP.x + (kD3.rg - vec2f(0.5)) * 0.35 + (kD2.rg - vec2f(0.5)) * 0.12;
  let kV = kVoro(kG);
  let kRnd = kHash2(kV.xy + vec2f(17.0));
  let kSteep = smoothstep(0.15, 0.55, 1.0 - kNr.y);
  let kT = normalize(vec3f(-kNr.z, 0.0, kNr.x) + vec3f(1e-4, 0.0, 0.0));
  var kRockN = normalize(kNr + (kT * (kRnd.x - 0.5) * 1.1 + vec3f(0.0, (kRnd.y - 0.5) * 0.5, 0.0)) * uniforms.rockP.z);
  let kEdgeAA = fwidth(kG.x) + fwidth(kG.y);
  let kEdge = kV.w - kV.z;
  let kCrev = (1.0 - smoothstep(0.0, 0.025 + kEdgeAA * 1.5, kEdge)) * (1.0 - smoothstep(0.1, 0.35, kEdgeAA));
  let kCrevSoft = 1.0 - smoothstep(0.0, 0.2, kEdge);
  let kAx = abs(kNr.x) / (abs(kNr.x) + abs(kNr.z) + 1e-4);
  let kStA = textureSample(detailTex, detailTexSampler, vec2f(kP.z * 0.011, kP.y * 0.006) * uniforms.rockP.w).b;
  let kStB = textureSample(detailTex, detailTexSampler, vec2f(kP.x * 0.011, kP.y * 0.006) * uniforms.rockP.w).b;
  let kStreak = mix(kStB, kStA, kAx);
  let kGully = smoothstep(0.56, 0.74, kStreak) * kSteep;
  let kRidge = smoothstep(0.32, 0.14, kStreak) * kSteep;
  let kLayer = sin(kP.y * 0.085 + kD3.a * 6.0 + kD2.b * 2.5) * 0.5 + 0.5;
  let kAlt = clamp(kP.y / 160.0 + (kD3.a - 0.5) * 0.6, 0.0, 1.0);
  var kRockCol = mix(uniforms.rockWarm, uniforms.rockCool, kAlt);
  kRockCol = mix(kRockCol, uniforms.rockWarm * vec3f(1.18, 0.96, 0.7), smoothstep(0.5, 0.8, kD3.b + kRnd.y * 0.3 - 0.1) * 0.55);
  kRockCol *= (0.82 + 0.3 * kRnd.x) * mix(0.93, 1.06, kLayer * kSteep) * (0.93 + 0.12 * kD.r) * (0.84 + 0.28 * smoothstep(0.3, 0.7, kD3.r));
  kRockCol *= 1.0 - 0.3 * kGully + 0.1 * kRidge;
  kRockCol *= mix(1.0, 0.8, kCrevSoft * kSteep) * mix(1.0, 0.5, kCrev * kSteep * smoothstep(0.35, 0.65, kD2.b + kRnd.y * 0.35));
  let kTop = kNr.y + (kD.r - 0.5) * 0.12 + (kD2.g - 0.5) * 0.2;
  let kBelowSnow = 1.0 - smoothstep(uniforms.rockP.y - 30.0, uniforms.rockP.y - 5.0, kP.y);
  let kCap = smoothstep(0.74, 0.765, kTop) * kBelowSnow;
  kRockCol *= mix(1.0, 0.68, smoothstep(0.64, 0.74, kTop) * (1.0 - kCap) * kBelowSnow);
  kRockCol = mix(kRockCol, uniforms.mossCol * (0.85 + 0.25 * kD.r), kCap);
  kRockN = normalize(mix(kRockN, kNr, kCap * 0.8));
  let kRockH = clamp(0.4 + kRnd.x * 0.3 - kCrev * 0.3 - kGully * 0.2, 0.0, 1.0);
  let kSnowL = uniforms.rockP.y + (kD3.a - 0.5) * 36.0 + (kD2.r - 0.5) * 10.0;
  var kSnow = smoothstep(kSnowL, kSnowL + 2.0, kP.y) * smoothstep(0.4, 0.47, kNr.y + (kD.g - 0.5) * 0.15 + (kRnd.y - 0.5) * 0.14);
  kSnow = max(kSnow, smoothstep(kSnowL - 28.0, kSnowL - 4.0, kP.y) * smoothstep(0.6, 0.72, kStreak) * smoothstep(0.1, 0.4, kNr.y + 0.3));
  let kLh = uniforms.toonSunDir.xz / max(length(uniforms.toonSunDir.xz), 1e-3);
  let kSunF = mix(dot(kRockN, uniforms.toonSunDir.xyz), dot(kRockN.xz / max(length(kRockN.xz), 1e-3), kLh) * 0.6, kSteep * 0.5);
  var kRockSun = mix(vec3f(0.64, 0.7, 0.9), vec3f(1.08, 1.03, 0.94), smoothstep(-0.3, 0.35, kSunF));
  let kDpx = dpdx(kP);
  let kDpy = dpdy(kP);
  let kCurv = dot(dpdx(kNr), kDpx) / max(dot(kDpx, kDpx), 1e-6) + dot(dpdy(kNr), kDpy) / max(dot(kDpy, kDpy), 1e-6);
  kRockSun = kRockSun * (1.0 + 0.32 * clamp(kCurv * uniforms.rockP.x * 0.3, -1.0, 1.0));
`;
