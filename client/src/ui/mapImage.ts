// Paints a stylised, hill-shaded map of the world for the minimap.
import { WORLD_HALF, waterAt, type Heightmap } from '@kelia/shared';

/** `contours` adds faint cartographic height lines every `contours` metres (the big map uses them). */
export function renderMapImage(hm: Heightmap, size: number, splat?: Uint8Array, contours = 0): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const m = (WORLD_HALF * 2) / size;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let j = 0; j < size; j++) {
    const z = -WORLD_HALF + (j + 0.5) * m;
    for (let i = 0; i < size; i++) {
      const x = -WORLD_HALF + (i + 0.5) * m;
      const h = hm.sample(x, z);
      const hx = hm.sample(x + m, z) - hm.sample(x - m, z);
      const hz = hm.sample(x, z + m) - hm.sample(x, z - m);
      // light from the north-west
      const shade = Math.max(0.55, Math.min(1.3, 1 + (-hx * 0.7 + hz * 0.7) * 0.35));
      let r = 86, g = 128, b = 66;
      const hi = Math.max(0, Math.min(1, (h - 20) / 60));
      r = lerp(r, 150, hi); g = lerp(g, 146, hi); b = lerp(b, 132, hi);
      if (splat) {
        const si = (Math.round(z - -WORLD_HALF) * hm.size + Math.round(x - -WORLD_HALF)) * 4;
        const f = splat[si] / 255, rock = splat[si + 1] / 255, sand = splat[si + 2] / 255, dirt = splat[si + 3] / 255;
        r = lerp(r, 52, f); g = lerp(g, 88, f); b = lerp(b, 48, f);
        r = lerp(r, 140, rock); g = lerp(g, 136, rock); b = lerp(b, 128, rock);
        r = lerp(r, 214, sand); g = lerp(g, 196, sand); b = lerp(b, 150, sand);
        r = lerp(r, 176, dirt); g = lerp(g, 146, dirt); b = lerp(b, 104, dirt);
      }
      r *= shade; g *= shade; b *= shade;
      if (contours) {
        const c = Math.floor(h / contours);
        const major = c % 5 === 0;
        if (c !== Math.floor(hm.sample(x + m, z) / contours) || c !== Math.floor(hm.sample(x, z + m) / contours)) {
          const k = major ? 0.68 : 0.84;
          r *= k; g *= k; b *= k;
        }
      }
      const w = waterAt(x, z);
      if (w > h) {
        const depth = Math.min(1, (w - h) / 3);
        r = lerp(96, 40, depth); g = lerp(150, 92, depth); b = lerp(178, 150, depth);
      }
      const o = (j * size + i) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
