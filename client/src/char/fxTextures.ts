// Small code-generated sprites for character effects (eye halos, the boss's
// briar aura and embers). Made once per scene and shared.
import { RawTexture, Texture, type Scene } from '@babylonjs/core';
import { drawBriarRing } from '../fx/textures';
import { createSoftDotTexture } from '../world/textures';

const cache = new WeakMap<Scene, { dot: Texture; sigil: Texture }>();

/**
 * The boss's aura underfoot: thorned briars twisting around a thin ring, with
 * a soft glow toward the rim (white, alpha = shape).
 */
function createSigilTexture(scene: Scene, size = 256): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  const R = size / 2 - 2;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.97, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.95, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'white';
  ctx.stroke();
  ctx.scale(0.5, 0.5);
  drawBriarRing(ctx, R * 1.62, R * 0.1, 17);
  const img = ctx.getImageData(0, 0, size, size).data;
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < data.length; k += 4) {
    data[k] = data[k + 1] = data[k + 2] = 255;
    data[k + 3] = Math.round(img[k + 3] * 0.85);
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
