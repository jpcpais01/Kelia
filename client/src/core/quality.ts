// Graphics quality presets. Everything that costs GPU time is driven from
// here so mid-range laptops can run Kelia smoothly.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  renderScale: number; // 1 = native; <1 renders fewer pixels and upscales
  shadows: boolean;
  shadowMapSize: number;
  shadowCascades: number;
  shadowDistance: number;
  ssao: boolean;
  bloom: boolean;
  dof: boolean;
  lightShafts: boolean;
  fogQuality: 0 | 1 | 2; // 0 = distance fog, 1 = height fog, 2 = height fog + sun scattering
  grassRadius: number; // metres around the camera with grass
  grassDensity: number; // blades per m² at full density
  treeDistance: number;
  viewDistance: number;
  msaa: number;
  fxaa: boolean;
  ambientLife: number; // 0..1 multiplier for birds/butterflies/particles
  waterReflections: boolean;
}

export const PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low', renderScale: 0.75, shadows: true, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 60,
    ssao: false, bloom: false, dof: false, lightShafts: false, fogQuality: 1, grassRadius: 38, grassDensity: 9,
    treeDistance: 260, viewDistance: 700, msaa: 1, fxaa: true, ambientLife: 0.4, waterReflections: false,
  },
  medium: {
    level: 'medium', renderScale: 0.9, shadows: true, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 110,
    ssao: false, bloom: true, dof: false, lightShafts: true, fogQuality: 2, grassRadius: 55, grassDensity: 16,
    treeDistance: 380, viewDistance: 900, msaa: 1, fxaa: true, ambientLife: 0.7, waterReflections: false,
  },
  high: {
    level: 'high', renderScale: 1, shadows: true, shadowMapSize: 2048, shadowCascades: 4, shadowDistance: 160,
    ssao: true, bloom: true, dof: true, lightShafts: true, fogQuality: 2, grassRadius: 72, grassDensity: 26,
    treeDistance: 520, viewDistance: 1200, msaa: 4, fxaa: false, ambientLife: 1, waterReflections: true,
  },
  ultra: {
    level: 'ultra', renderScale: 1, shadows: true, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 220,
    ssao: true, bloom: true, dof: true, lightShafts: true, fogQuality: 2, grassRadius: 95, grassDensity: 34,
    treeDistance: 700, viewDistance: 1500, msaa: 4, fxaa: false, ambientLife: 1, waterReflections: true,
  },
};

export interface UserSettings {
  quality: QualityLevel | 'auto';
  renderer: 'auto' | 'webgpu' | 'webgl2';
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  showNames: boolean;
  cameraShake: boolean;
  masterVolume: number;
}

const DEFAULTS: UserSettings = {
  quality: 'auto',
  renderer: 'auto',
  mouseSensitivity: 1,
  invertY: false,
  fov: 60,
  showNames: true,
  cameraShake: true,
  masterVolume: 0.8,
};

const KEY = 'kelia.settings.v1';

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: UserSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Guess a sensible preset from the GPU name. Integrated GPUs start at medium. */
export function autoQuality(gpuName: string): QualityLevel {
  const g = gpuName.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return 'low';
  if (/rtx\s?(30|40|50)|rx\s?(6[89]|7[89]|9\d)|apple m\d (pro|max|ultra)/.test(g)) return 'ultra';
  if (/rtx|gtx\s?1[06-9]|radeon rx|arc a7|apple m[2-9]/.test(g)) return 'high';
  if (/intel|uhd|iris|vega|radeon\(tm\) graphics|mali|adreno|apple m1/.test(g)) return 'medium';
  return 'high';
}
