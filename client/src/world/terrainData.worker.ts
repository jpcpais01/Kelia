// Builds the world heightmap and ground "splat" weights off the main thread.
import { Heightmap, WORLD_HALF, surfaceAt } from '@kelia/shared';

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
    }
    if (j % 32 === 0) (self as unknown as Worker).postMessage({ type: 'progress', value: 0.6 + (j / size) * 0.4 });
  }
  (self as unknown as Worker).postMessage({ type: 'done', heights: hm.data, splat, step }, [hm.data.buffer, splat.buffer]);
};
