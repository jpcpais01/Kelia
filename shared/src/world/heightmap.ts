// A sampled heightmap of the whole world. The client builds terrain meshes,
// grass and water depth from it; the server uses it for fast height lookups.
import { WORLD_HALF } from './layout';
import { heightAt } from './terrain';

export class Heightmap {
  /** Samples per side (cells + 1). */
  readonly size: number;
  /** Metres between samples. */
  readonly step: number;
  readonly data: Float32Array;

  constructor(step: number, data?: Float32Array) {
    this.step = step;
    this.size = Math.round((WORLD_HALF * 2) / step) + 1;
    this.data = data ?? new Float32Array(this.size * this.size);
  }

  /** Fill rows [row0, row1). Call repeatedly to spread the work over frames. */
  fillRows(row0: number, row1: number) {
    const { size, step, data } = this;
    for (let j = row0; j < Math.min(row1, size); j++) {
      const z = -WORLD_HALF + j * step;
      for (let i = 0; i < size; i++) {
        data[j * size + i] = heightAt(-WORLD_HALF + i * step, z);
      }
    }
  }

  fill() {
    this.fillRows(0, this.size);
    return this;
  }

  /** Raw sample at grid coordinates (clamped). */
  at(i: number, j: number): number {
    const s = this.size - 1;
    i = i < 0 ? 0 : i > s ? s : i;
    j = j < 0 ? 0 : j > s ? s : j;
    return this.data[j * this.size + i];
  }

  /** Height matching the rendered triangle mesh exactly (diagonal split i+j). */
  sample(x: number, z: number): number {
    const gx = (x + WORLD_HALF) / this.step;
    const gz = (z + WORLD_HALF) / this.step;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = this.at(i, j);
    const h11 = this.at(i + 1, j + 1);
    if (fx > fz) {
      const h10 = this.at(i + 1, j);
      return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    }
    const h01 = this.at(i, j + 1);
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  /** Unit surface normal (central differences). */
  normal(x: number, z: number, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }) {
    const e = this.step;
    const dx = this.sample(x + e, z) - this.sample(x - e, z);
    const dz = this.sample(x, z + e) - this.sample(x, z - e);
    const nx = -dx;
    const ny = 2 * e;
    const nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
    return out;
  }

  /** 0 (flat) .. 1 (vertical) */
  slope(x: number, z: number): number {
    const n = this.normal(x, z);
    return 1 - n.y;
  }
}
