// Graphics quality presets. Everything that costs GPU time is driven from
// here so mid-range laptops can run Kelia smoothly.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  renderScale: number; // 1 = native; <1 renders fewer pixels and upscales
  shadows: boolean;
  shadowMapSize: number;
  /** Radius (m) around the player that gets real-time shadows. */
  shadowDistance: number;
  /** 0 = one hardware PCF tap, 1 = soft 3×3 PCF. */
  shadowSoft: 0 | 1;
  bloom: boolean;
  /** Sun shafts through trees, from the sky mask (no extra scene pass). */
  sunShafts: boolean;
  /** Ink outlines around characters and monsters. */
  outlines: boolean;
  grassRadius: number; // metres around the camera with grass
  grassDensity: number; // blades per m² at full density
  treeDistance: number;
  viewDistance: number;
  /** MSAA samples on the scene buffer (1 = off, FXAA in the final pass instead). */
  msaa: number;
  fxaa: boolean;
  ambientLife: number; // 0..1 multiplier for birds/butterflies/particles
}

export const PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low', renderScale: 0.8, shadows: true, shadowMapSize: 1024, shadowDistance: 38, shadowSoft: 0,
    bloom: true, sunShafts: false, outlines: true, grassRadius: 40, grassDensity: 10,
    treeDistance: 300, viewDistance: 700, msaa: 1, fxaa: true, ambientLife: 0.4,
  },
  medium: {
    level: 'medium', renderScale: 0.9, shadows: true, shadowMapSize: 2048, shadowDistance: 55, shadowSoft: 0,
    bloom: true, sunShafts: true, outlines: true, grassRadius: 58, grassDensity: 18,
    treeDistance: 420, viewDistance: 900, msaa: 1, fxaa: true, ambientLife: 0.7,
  },
  high: {
    level: 'high', renderScale: 1, shadows: true, shadowMapSize: 2048, shadowDistance: 70, shadowSoft: 1,
    bloom: true, sunShafts: true, outlines: true, grassRadius: 75, grassDensity: 26,
    treeDistance: 560, viewDistance: 1200, msaa: 4, fxaa: false, ambientLife: 1,
  },
  ultra: {
    level: 'ultra', renderScale: 1, shadows: true, shadowMapSize: 4096, shadowDistance: 95, shadowSoft: 1,
    bloom: true, sunShafts: true, outlines: true, grassRadius: 95, grassDensity: 34,
    treeDistance: 720, viewDistance: 1500, msaa: 4, fxaa: false, ambientLife: 1,
  },
};

export interface UserSettings {
  quality: QualityLevel | 'auto';
  renderer: 'auto' | 'webgpu' | 'webgl2';
  /** Rendering resolution as a fraction of the screen's native pixels (0.5–2); 0 = automatic (from the quality preset). */
  renderScale: number;
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  showNames: boolean;
  cameraShake: boolean;
  masterVolume: number;
  musicVolume: number;
  ambienceVolume: number;
  /** Your own view of the sky: follow the world clock, or hold it at sunrise, day, sunset or night. */
  timeOfDay: TimeOfDay;
}

export type TimeOfDay = 'auto' | 'sunrise' | 'day' | 'sunset' | 'night';

const DEFAULTS: UserSettings = {
  quality: 'auto',
  renderer: 'auto',
  renderScale: 0,
  mouseSensitivity: 1,
  invertY: false,
  fov: 60,
  showNames: true,
  cameraShake: true,
  masterVolume: 0.8,
  musicVolume: 0.5,
  ambienceVolume: 0.8,
  timeOfDay: 'auto',
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
