// Builds the world heightmap and ground "splat" weights off the main thread.
import { Heightmap, WORLD_HALF, pathDistance, surfaceAt, waterAt } from '@kelia/shared';

self.onmessage = (e: MessageEvent<{ step: number }>) => {
  const step = e.data.step;
  const hm = new Heightmap(step);
  const size = hm.size;
  const rows = 32;
  for (let j = 0; j < size; j += rows) {
    hm.fillRows(j, j + rows);
    (self as unknown as Worker).postMessage({ type: 'progress', value: (j / size) * 0.6 });
  }
  // Splat weights: r = forest floor, g = rock, b = sand, a = dirt (grass = rest)
  const splat = new Uint8Array(size * size * 4);
  // Ground detail: r = signed distance to the waterline ((m + 4) / 16,
  // negative under water), g = distance from a trail's centre line (m / 4),
  // ba = direction away from that centre line (for ruts)
  const ground = new Uint8Array(size * size * 4);
  const wet = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -WORLD_HALF + j * step;
    for (let i = 0; i < size; i++) {
      const x = -WORLD_HALF + i * step;
      const h = hm.data[j * size + i];
      const dx = hm.at(i + 1, j) - hm.at(i - 1, j);
      const dz = hm.at(i, j + 1) - hm.at(i, j - 1);
      const ny = (2 * step) / Math.hypot(dx, 2 * step, dz);
      const s = surfaceAt(x, z, h, 1 - ny);
      const o = (j * size + i) * 4;
      splat[o] = s.forest * 255;
      splat[o + 1] = s.rock * 255;
      splat[o + 2] = s.sand * 255;
      splat[o + 3] = s.dirt * 255;
      if (h < waterAt(x, z)) wet[j * size + i] = 1;
      const pd = Math.max(0, pathDistance(x, z));
      ground[o + 1] = Math.round(Math.min(1, pd / 4) * 255);
      let gx = 0;
      let gz = 0;
      if (pd < 4) {
        gx = pathDistance(x + 0.25, z) - pathDistance(x - 0.25, z);
        gz = pathDistance(x, z + 0.25) - pathDistance(x, z - 0.25);
        const gl = Math.hypot(gx, gz) || 1;
        gx /= gl;
        gz /= gl;
      }
      ground[o + 2] = Math.round((gx * 0.5 + 0.5) * 255);
      ground[o + 3] = Math.round((gz * 0.5 + 0.5) * 255);
    }
    if (j % 32 === 0) (self as unknown as Worker).postMessage({ type: 'progress', value: 0.6 + (j / size) * 0.4 });
  }
  const toWater = chamfer(wet, size, 1);
  const toLand = chamfer(wet, size, 0);
  for (let k = 0; k < size * size; k++) {
    const d = (wet[k] ? -toLand[k] + 0.5 : toWater[k] - 0.5) * step;
    ground[k * 4] = Math.round(Math.min(1, Math.max(0, (d + 4) / 16)) * 255);
  }
  (self as unknown as Worker).postMessage({ type: 'done', heights: hm.data, splat, ground, step }, [hm.data.buffer, splat.buffer, ground.buffer]);
};

/** Two-pass chamfer distance (in samples, capped at 64) from every sample to the nearest one where mask === target. */
function chamfer(mask: Uint8Array, size: number, target: number) {
  const d = new Float32Array(size * size);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] === target ? 0 : 64;
  const D = Math.SQRT2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - size] + 1);
        if (i > 0) v = Math.min(v, d[k - size - 1] + D);
        if (i < size - 1) v = Math.min(v, d[k - size + 1] + D);
      }
      d[k] = v;
    }
  }
  for (let j = size - 1; j >= 0; j--) {
    for (let i = size - 1; i >= 0; i--) {
      const k = j * size + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < size - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < size - 1) {
        v = Math.min(v, d[k + size] + 1);
        if (i < size - 1) v = Math.min(v, d[k + size + 1] + D);
        if (i > 0) v = Math.min(v, d[k + size - 1] + D);
      }
      d[k] = v;
    }
  }
  return d;
}
