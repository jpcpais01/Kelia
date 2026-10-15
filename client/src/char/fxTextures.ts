// Small code-generated sprites for character effects (eye halos, the boss's
// aura sigil and embers). Made once per scene and shared.
import { RawTexture, Texture, type Scene } from '@babylonjs/core';
import { createSoftDotTexture } from '../world/textures';

const cache = new WeakMap<Scene, { dot: Texture; sigil: Texture }>();

/** A runic ring: two thin circles, tick marks and a soft inner glow (white, alpha = shape). */
function createSigilTexture(scene: Scene, size = 256): Texture {
  const data = new Uint8Array(size * size * 4);
  const ring = (r: number, c: number, w: number) => Math.max(0, 1 - Math.abs(r - c) / w);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size - 0.5) * 2;
      const dy = ((y + 0.5) / size - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      let a = 0;
      a = Math.max(a, ring(r, 0.93, 0.025));
      a = Math.max(a, ring(r, 0.8, 0.012) * 0.85);
      // rune ticks between the circles
      const seg = (ang / (Math.PI * 2)) * 24;
      const f = Math.abs(seg - Math.round(seg));
      if (r > 0.82 && r < 0.91) a = Math.max(a, (f < 0.06 ? 1 : 0) * 0.9, (Math.round(seg) % 3 === 0 && f < 0.2 ? 0.6 : 0));
      // a six-pointed star inside
      for (let k = 0; k < 6; k++) {
        const t = (k / 6) * Math.PI * 2;
        const px = Math.cos(t) * 0.8, py = Math.sin(t) * 0.8;
        const qx = Math.cos(t + (Math.PI * 2) / 3) * 0.8, qy = Math.sin(t + (Math.PI * 2) / 3) * 0.8;
        const ex = qx - px, ey = qy - py;
        const l2 = ex * ex + ey * ey;
        const u = Math.max(0, Math.min(1, ((dx - px) * ex + (dy - py) * ey) / l2));
        const d = Math.hypot(dx - px - ex * u, dy - py - ey * u);
        a = Math.max(a, Math.max(0, 1 - d / 0.012) * 0.55);
      }
      // soft glow toward the rim, fading out past it
      a = Math.max(a, r < 1 ? Math.pow(r, 3) * 0.25 : 0);
      if (r > 0.98) a *= Math.max(0, 1 - (r - 0.98) / 0.02);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.min(255, a * 255);
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.hasAlpha = true;
  tex.name = 'sigil';
  return tex;
}

export function fxTextures(scene: Scene) {
  let t = cache.get(scene);
  if (!t) {
    t = { dot: createSoftDotTexture(scene), sigil: createSigilTexture(scene) };
    cache.set(scene, t);
  }
  return t;
}
