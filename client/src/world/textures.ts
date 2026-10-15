// Procedural textures generated at startup (no downloads needed).
import { RawTexture, Texture, type Scene } from '@babylonjs/core';

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Periodic value noise so the texture tiles seamlessly. */
function tileNoise(x: number, y: number, period: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const p = (v: number) => ((v % period) + period) % period;
  const a = hash(p(xi), p(yi), seed);
  const b = hash(p(xi + 1), p(yi), seed);
  const c = hash(p(xi), p(yi + 1), seed);
  const d = hash(p(xi + 1), p(yi + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function tileFbm(x: number, y: number, period: number, octaves: number, seed: number) {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * tileNoise(x * f, y * f, period * f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

/** RGBA detail noise: r = fine fbm, g = cellular-ish clumps, b = streaks, a = coarse. */
export function createDetailTexture(scene: Scene, size = 256): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const fine = tileFbm(u * 2, v * 2, 16, 4, 1);
      const clumps = Math.pow(tileFbm(u, v, 8, 3, 7), 1.6);
      const streak = tileFbm(u * 4, v * 0.6, 32, 3, 13); // anisotropic: rock strata
      const coarse = tileFbm(u * 0.5, v * 0.5, 4, 3, 21);
      const o = (y * size + x) * 4;
      data[o] = fine * 255;
      data[o + 1] = Math.min(255, clumps * 1.6 * 255);
      data[o + 2] = streak * 255;
      data[o + 3] = coarse * 255;
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  tex.name = 'detailNoise';
  return tex;
}

/** A soft round sprite for particles (fireflies, dust, mist). */
export function createSoftDotTexture(scene: Scene, size = 64): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - d);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.pow(a, 1.8) * 255;
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.hasAlpha = true;
  tex.name = 'softDot';
  return tex;
}

/** Puffy noise sprite for mist, smoke and waterfall spray. */
export function createCloudSpriteTexture(scene: Scene, size = 128): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tileFbm((x / size) * 4, (y / size) * 4, 4, 4, 77);
      const a = Math.max(0, 1 - d) * (0.55 + 0.9 * n);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.min(255, Math.pow(Math.max(0, a), 1.5) * 255);
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.hasAlpha = true;
  tex.name = 'cloudSprite';
  return tex;
}
