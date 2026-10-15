import { Heightmap } from '@kelia/shared';

export interface TerrainData {
  heightmap: Heightmap;
  splat: Uint8Array; // RGBA per heightmap sample
}

let cached: Promise<TerrainData> | null = null;

/** Heightmap + splat weights for the whole world, computed in a worker. */
export function loadTerrainData(onProgress?: (p: number) => void): Promise<TerrainData> {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./terrainData.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.value);
      else if (m.type === 'done') {
        worker.terminate();
        resolve({ heightmap: new Heightmap(m.step, m.heights), splat: m.splat });
      }
    };
    worker.onerror = (err) => reject(err);
    worker.postMessage({ step: 1 });
  });
  return cached;
}
