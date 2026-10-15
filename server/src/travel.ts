// Map teleports: where each named place sets a traveller down.
import { ARRIVAL_POINT, LAKE, MONSTERS, SPAWN_ZONES, VILLAGE, PLAYABLE_HALF, SPAWN_POINT, waterAt, type Heightmap, type PointOfInterest } from '@kelia/shared';

/**
 * A dry, fairly level spot at (or as near as possible to) a place. Lakes and
 * waterfalls sit in water, so the search spirals out to the nearest shore.
 */
export function travelSpot(hm: Heightmap, poi: PointOfInterest): [number, number] {
  if (poi.id === 'village') return [SPAWN_POINT[0], SPAWN_POINT[1]];
  if (poi.id === 'shrine') return [ARRIVAL_POINT[0], ARRIVAL_POINT[1]];
  const [cx, cz] = poi.pos;
  // the lake's open water hides Lantern Isle: start the search at the shoreline instead
  const r0 = poi.kind === 'lake' ? Math.round(LAKE.radius * 0.7) : 0;
  // try the side facing Hearthmere first, so you land on the way home
  const home = Math.atan2(VILLAGE.center[0] - cx, VILLAGE.center[1] - cz);
  for (let r = r0; r <= r0 + 160; r += 3) {
    const n = r === 0 ? 1 : Math.ceil((Math.PI * 2 * r) / 3);
    for (let k = 0; k < n; k++) {
      const i = k % 2 ? (k + 1) / 2 : -k / 2;
      const a = home + (i / n) * Math.PI * 2;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      if (landable(hm, x, z)) return [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
    }
  }
  return [SPAWN_POINT[0], SPAWN_POINT[1]];
}

export function landable(hm: Heightmap, x: number, z: number) {
  if (Math.abs(x) > PLAYABLE_HALF - 10 || Math.abs(z) > PLAYABLE_HALF - 10) return false;
  // never set anyone down where monsters roam (the ruins hold a boss)
  for (const zone of SPAWN_ZONES) if (Math.hypot(x - zone.center[0], z - zone.center[1]) < zone.radius + MONSTERS[zone.monster].aggro + 8) return false;
  // dry ground with a margin, so we never land wading or at a cliff edge
  for (const [dx, dz] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) if (waterAt(x + dx, z + dz) > hm.sample(x + dx, z + dz) - 0.2) return false;
  const sx = Math.abs(hm.sample(x + 1.5, z) - hm.sample(x - 1.5, z)) / 3;
  const sz = Math.abs(hm.sample(x, z + 1.5) - hm.sample(x, z - 1.5)) / 3;
  return Math.max(sx, sz) < 0.55;
}
