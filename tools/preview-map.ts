// Renders a shaded top-down preview of the terrain to tools/out/map.png
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { Heightmap } from '../shared/src/world/heightmap';
import { surfaceAt, waterAt } from '../shared/src/world/terrain';
import { POINTS_OF_INTEREST, WORLD_HALF } from '../shared/src/world/layout';

const step = Number(process.argv[2] ?? 2);
const t0 = performance.now();
const hm = new Heightmap(step).fill();
console.log('heightmap', hm.size, 'x', hm.size, ((performance.now() - t0) / 1000).toFixed(2) + 's');
let min = Infinity, max = -Infinity;
for (const v of hm.data) { min = Math.min(min, v); max = Math.max(max, v); }
console.log('height range', min.toFixed(1), max.toFixed(1));
const S = hm.size;
const png = new PNG({ width: S, height: S });
for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
  const x = -WORLD_HALF + i * step, z = -WORLD_HALF + j * step;
  const h = hm.at(i, j);
  const slope = hm.slope(x, z);
  const s = surfaceAt(x, z, h, slope);
  let r = 90 * s.grass + 40 * s.forest + 130 * s.rock + 210 * s.sand + 150 * s.dirt;
  let g = 160 * s.grass + 90 * s.forest + 125 * s.rock + 190 * s.sand + 115 * s.dirt;
  let b = 60 * s.grass + 40 * s.forest + 120 * s.rock + 140 * s.sand + 80 * s.dirt;
  const n = hm.normal(x, z);
  const shade = Math.max(0.35, n.x * -0.5 + n.y * 0.7 + n.z * 0.5);
  r *= shade; g *= shade; b *= shade;
  const w = waterAt(x, z);
  if (w > h) { const d = Math.min(1, (w - h) / 3); r = 60 - d * 40; g = 140 - d * 60; b = 190 - d * 40; }
  const idx = ((S - 1 - j) * S + i) * 4; // north up
  png.data[idx] = Math.min(255, r); png.data[idx + 1] = Math.min(255, g); png.data[idx + 2] = Math.min(255, b); png.data[idx + 3] = 255;
}
for (const p of POINTS_OF_INTEREST) {
  const i = Math.round((p.pos[0] + WORLD_HALF) / step), j = S - 1 - Math.round((p.pos[1] + WORLD_HALF) / step);
  for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const idx = ((j + b) * S + i + a) * 4; png.data[idx] = 255; png.data[idx + 1] = 40; png.data[idx + 2] = 200; }
}
fs.mkdirSync('tools/out', { recursive: true });
fs.writeFileSync('tools/out/map.png', PNG.sync.write(png));
