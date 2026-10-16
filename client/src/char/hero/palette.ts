// The hero's texture: one canvas per character holding flat colour swatches
// (an 8×8 grid on the left half, one row per kind of surface so the shader
// knows what it is shading) and the painted face on the right half. Skin,
// hair, eye and outfit colours are baked in, so changing a colour in the
// creator only repaints the canvas.
import { DynamicTexture, type Scene } from '@babylonjs/core';

/** Swatch rows: what the surface is made of (read back by the surface plugin). */
export const ROW = { skin: 0, hair: 1, cloth: 2, cloth2: 3, leather: 4, metal: 5, gold: 6, special: 7 } as const;

export type Swatch = [row: number, col: number];

/** Atlas size: swatch grid 512×512 on the left, face 512×512 on the right. */
export const ATLAS_W = 1024;
export const ATLAS_H = 512;
const CELL = 64;

export const SW = {
  skin: [ROW.skin, 0] as Swatch,
  lips: [ROW.skin, 1] as Swatch,
  hair: [ROW.hair, 0] as Swatch,
  hairDark: [ROW.hair, 1] as Swatch,
  hairLight: [ROW.hair, 2] as Swatch,
  ink: [ROW.special, 0] as Swatch,
  white: [ROW.special, 1] as Swatch,
  fur: [ROW.special, 2] as Swatch,
  furDark: [ROW.special, 3] as Swatch,
  gem: (i: number) => [ROW.special, 4 + i] as Swatch,
  cloth: (i: number) => [i < 8 ? ROW.cloth : ROW.cloth2, i & 7] as Swatch,
  leather: (i: number) => [ROW.leather, i] as Swatch,
  metal: (i: number) => [ROW.metal, i] as Swatch,
  gold: (i: number) => [ROW.gold, i] as Swatch,
};

/** Texture coordinates of a swatch's centre. */
export function uvOf(s: Swatch): [number, number] {
  return [(s[1] + 0.5) / 16, 1 - (s[0] + 0.5) / 8];
}

/** Texture coordinates for a point of the face region (0..1 across, 0..1 down). */
export function faceUV(fx: number, fy: number): [number, number] {
  return [0.5 + 0.5 * Math.max(0, Math.min(1, fx)), 1 - Math.max(0, Math.min(1, fy))];
}

/** Skin as painted: a touch lighter and less saturated than the swatch (the toon light warms it). */
export function heroSkin(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const l = 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  const o = c.map((v) => Math.max(0, Math.min(255, Math.round((v + (l - v) * 0.22) * 1.04 + 4))));
  return '#' + o.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export interface PaletteColors {
  skin: string;
  hair: string;
  /** Swatch → colour for the outfit (cloth, leather, metal, gold, fur, gems). */
  outfit: [Swatch, string][];
}

const shade = (hex: string, k: number, add = 0) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k + add))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/** A character's texture (atlas canvas wrapped as a DynamicTexture). */
export class HeroAtlas {
  readonly texture: DynamicTexture;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;

  constructor(scene: Scene, name: string) {
    this.texture = new DynamicTexture(name, { width: ATLAS_W, height: ATLAS_H }, scene, true);
    this.texture.hasAlpha = false;
    this.texture.wrapU = this.texture.wrapV = 0; // clamp
    this.canvas = this.texture.getContext().canvas as HTMLCanvasElement;
  }

  get ctx() {
    return this.texture.getContext() as CanvasRenderingContext2D;
  }

  /** Paint the swatches (left half). */
  paintSwatches(c: PaletteColors) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // neutral fill for unused cells
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 512, 512);
    const put = (s: Swatch, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(s[1] * CELL, s[0] * CELL, CELL, CELL);
    };
    put(SW.skin, c.skin);
    put(SW.lips, shade(c.skin, 0.86));
    put(SW.hair, c.hair);
    put(SW.hairDark, shade(c.hair, 0.62));
    put(SW.hairLight, shade(c.hair, 1.25, 18));
    put(SW.ink, '#1d1520');
    put(SW.white, '#f4f0ea');
    put(SW.fur, '#d9cdb8');
    put(SW.furDark, '#6b5240');
    for (const [s, col] of c.outfit) put(s, col);
  }

  update() {
    this.texture.update(true, false, true);
  }

  dispose() {
    this.texture.dispose();
  }
}
