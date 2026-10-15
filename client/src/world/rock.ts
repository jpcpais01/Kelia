// Chiselled stylised rock, shared by the terrain and the far mountain ranges.
//
// The ground is cut into jittered cells (seen from the side, a cliff reads as
// a row of columns and slabs). Every cell gets its own tilt, so the cel
// terminator breaks a slope into crisp lit and shaded planes, and its own
// strata spacing and phase, so ledges stop at each crack instead of running
// round the mountain like the layers of a cake. Each ledge has a sunlit lip
// and a shadowed seam; sky-facing lips carry moss, and the high peaks snow.
//
// Everything is anti-aliased with screen-space derivatives (no branches, so
// WGSL's uniformity rules are happy) and fades to plain cell tones once the
// detail would shrink below a pixel.

export const ROCK_UNIFORMS = {
  /** x = cell size (m), y = snow line (m), z = facet strength, w = strata scale. */
  rockP: 'vec4',
  rockWarm: 'vec3',
  rockCool: 'vec3',
  snowCol: 'vec3',
  mossCol: 'vec3',
} as const;

export const ROCK_DEFAULTS = {
  rockP: [13, 128, 1, 1],
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
 * `kD`, `kD2`, `kD3` (detail noise samples at fine/mid/coarse scale).
 * Outputs: `kRockCol` (albedo), `kRockN` (chiselled normal), `kRockH` (0..1
 * "height" for height-blending), `kSnow` (0..1 snow cover for any layer).
 */
export const ROCK_GLSL = /* glsl */ `
  float kCell = rockP.x;
  vec2 kG = kP.xz / kCell + (kD2.rg - 0.5) * 0.4;
  vec4 kV = kVoro(kG);
  vec2 kRnd = kHash2(kV.xy + 17.0);
  float kSteep = smoothstep(0.12, 0.5, 1.0 - kNr.y);
  // strata: every cell keeps its own spacing and phase
  float kSy = kP.y * mix(0.13, 0.24, kRnd.x) * rockP.w + kRnd.y * 9.0 + kD.b * 0.18;
  float kStr = fract(kSy);
  float kAA = fwidth(kSy);
  float kFadeS = (1.0 - smoothstep(0.07, 0.2, kAA)) * kSteep;
  float kW = kAA + 0.015;
  float kSeam = 1.0 - smoothstep(0.035, 0.035 + kW, kStr) * (1.0 - smoothstep(0.995 - kW, 0.995, kStr));
  float kLip = smoothstep(0.8 - kW, 0.86, kStr) * (1.0 - smoothstep(0.97 - kW, 0.99, kStr));
  float kUnder = 1.0 - smoothstep(0.04, 0.38, kStr);
  // cracks between cells
  float kEdgeAA = fwidth(kG.x) + fwidth(kG.y);
  float kCrack = (1.0 - smoothstep(0.0, 0.03 + kEdgeAA * 1.5, kV.w - kV.z)) * (1.0 - smoothstep(0.15, 0.45, kEdgeAA)) * kSteep;
  // chiselled normal: each cell a tilted plane
  vec3 kT = normalize(vec3(-kNr.z, 0.0, kNr.x) + vec3(1e-4, 0.0, 0.0));
  vec3 kRockN = kNr + (kT * (kRnd.x - 0.5) * 0.9 + vec3(0.0, (kRnd.y - 0.5) * 0.45, 0.0)) * rockP.z;
  kRockN = normalize(kRockN);
  // colour: warm low, cool high, every slab and band its own tone
  float kTone = kRnd.x * 0.55 + fract(floor(kSy) * 0.618) * 0.45 * kSteep;
  float kAlt = clamp(kP.y / 150.0 + (kD3.a - 0.5) * 0.7, 0.0, 1.0);
  vec3 kRockCol = mix(rockWarm, rockCool, kAlt) * (0.8 + 0.32 * kTone) * (0.92 + 0.16 * kD.r);
  kRockCol = mix(kRockCol, kRockCol * vec3(1.12, 0.98, 0.8), smoothstep(0.6, 0.85, kD2.b) * 0.55);
  kRockCol *= mix(1.0, 0.66, kSeam * kFadeS);
  kRockCol *= mix(1.0, 0.86, kUnder * kFadeS);
  kRockCol *= 1.0 + 0.1 * kLip * kFadeS;
  kRockCol *= mix(1.0, 0.68, kCrack);
  // moss on sky-facing lips and ledges
  float kMoss = smoothstep(0.72, 0.78, kRockN.y + (kD.r - 0.5) * 0.25) * (1.0 - smoothstep(rockP.y - 40.0, rockP.y - 10.0, kP.y));
  kRockCol = mix(kRockCol, mossCol * (0.82 + 0.3 * kD.r), kMoss * 0.85);
  float kRockH = clamp(0.35 + kRnd.x * 0.3 + kLip * 0.3 - kCrack * 0.3, 0.0, 1.0);
  // snow on the peaks: on gentle faces, a crisp cel edge
  float kSnowL = rockP.y + (kD3.a - 0.5) * 36.0 + (kD2.r - 0.5) * 10.0;
  float kSnow = smoothstep(kSnowL, kSnowL + 2.5, kP.y) * smoothstep(0.38, 0.46, kRockN.y + (kD.g - 0.5) * 0.2);
`;

export const ROCK_WGSL = /* wgsl */ `
  let kCell = uniforms.rockP.x;
  let kG = kP.xz / kCell + (kD2.rg - vec2f(0.5)) * 0.4;
  let kV = kVoro(kG);
  let kRnd = kHash2(kV.xy + vec2f(17.0));
  let kSteep = smoothstep(0.12, 0.5, 1.0 - kNr.y);
  let kSy = kP.y * mix(0.13, 0.24, kRnd.x) * uniforms.rockP.w + kRnd.y * 9.0 + kD.b * 0.18;
  let kStr = fract(kSy);
  let kAA = fwidth(kSy);
  let kFadeS = (1.0 - smoothstep(0.07, 0.2, kAA)) * kSteep;
  let kW = kAA + 0.015;
  let kSeam = 1.0 - smoothstep(0.035, 0.035 + kW, kStr) * (1.0 - smoothstep(0.995 - kW, 0.995, kStr));
  let kLip = smoothstep(0.8 - kW, 0.86, kStr) * (1.0 - smoothstep(0.97 - kW, 0.99, kStr));
  let kUnder = 1.0 - smoothstep(0.04, 0.38, kStr);
  let kEdgeAA = fwidth(kG.x) + fwidth(kG.y);
  let kCrack = (1.0 - smoothstep(0.0, 0.03 + kEdgeAA * 1.5, kV.w - kV.z)) * (1.0 - smoothstep(0.15, 0.45, kEdgeAA)) * kSteep;
  let kT = normalize(vec3f(-kNr.z, 0.0, kNr.x) + vec3f(1e-4, 0.0, 0.0));
  var kRockN = kNr + (kT * (kRnd.x - 0.5) * 0.9 + vec3f(0.0, (kRnd.y - 0.5) * 0.45, 0.0)) * uniforms.rockP.z;
  kRockN = normalize(kRockN);
  let kTone = kRnd.x * 0.55 + fract(floor(kSy) * 0.618) * 0.45 * kSteep;
  let kAlt = clamp(kP.y / 150.0 + (kD3.a - 0.5) * 0.7, 0.0, 1.0);
  var kRockCol = mix(uniforms.rockWarm, uniforms.rockCool, kAlt) * (0.8 + 0.32 * kTone) * (0.92 + 0.16 * kD.r);
  kRockCol = mix(kRockCol, kRockCol * vec3f(1.12, 0.98, 0.8), smoothstep(0.6, 0.85, kD2.b) * 0.55);
  kRockCol *= mix(1.0, 0.66, kSeam * kFadeS);
  kRockCol *= mix(1.0, 0.86, kUnder * kFadeS);
  kRockCol *= 1.0 + 0.1 * kLip * kFadeS;
  kRockCol *= mix(1.0, 0.68, kCrack);
  let kMoss = smoothstep(0.72, 0.78, kRockN.y + (kD.r - 0.5) * 0.25) * (1.0 - smoothstep(uniforms.rockP.y - 40.0, uniforms.rockP.y - 10.0, kP.y));
  kRockCol = mix(kRockCol, uniforms.mossCol * (0.82 + 0.3 * kD.r), kMoss * 0.85);
  let kRockH = clamp(0.35 + kRnd.x * 0.3 + kLip * 0.3 - kCrack * 0.3, 0.0, 1.0);
  let kSnowL = uniforms.rockP.y + (kD3.a - 0.5) * 36.0 + (kD2.r - 0.5) * 10.0;
  let kSnow = smoothstep(kSnowL, kSnowL + 2.5, kP.y) * smoothstep(0.38, 0.46, kRockN.y + (kD.g - 0.5) * 0.2);
`;
