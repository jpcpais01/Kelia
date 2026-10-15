import { DAY_LENGTH_SECONDS } from './constants';

/**
 * Time of day in [0, 1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 * Derived from wall-clock time so every server and client agrees without sync.
 * Days run a little long and nights a little short.
 */
export function dayTimeAt(epochMs: number): number {
  const t = (epochMs / 1000 / DAY_LENGTH_SECONDS) % 1;
  // Remap so night (0.8 -> 0.2) takes ~30% of the cycle instead of 40%.
  const nightFrac = 0.3;
  const dayFrac = 1 - nightFrac;
  if (t < dayFrac) return 0.22 + (t / dayFrac) * (0.78 - 0.22);
  const n = (t - dayFrac) / nightFrac; // 0..1 through the night
  return (0.78 + n * 0.44) % 1;
}

/** Sun direction for a time of day (unit vector pointing *towards* the sun). */
export function sunDirection(dayTime: number): [number, number, number] {
  const a = (dayTime - 0.25) * Math.PI * 2; // 0 at sunrise, PI/2 at noon
  const elev = Math.sin(a);
  const horiz = Math.cos(a);
  // Sun rises in the east (+x), sets in the west, tilted toward the south.
  const tilt = 0.42;
  const x = horiz;
  const y = elev * Math.cos(tilt);
  const z = -elev * Math.sin(tilt) - 0.15;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
