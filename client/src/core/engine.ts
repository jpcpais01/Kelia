import { Engine, WebGPUEngine, type AbstractEngine } from '@babylonjs/core';
import type { UserSettings } from './quality';

export interface EngineInfo {
  engine: AbstractEngine;
  api: 'webgpu' | 'webgl2';
  gpu: string;
}

const FALLBACK_KEY = 'kelia.webgpu.failed';

/**
 * WebGPU first, WebGL2 as the automatic fallback. If WebGPU crashed in a
 * previous session we remember that and go straight to WebGL2.
 */
export async function createEngine(canvas: HTMLCanvasElement, settings: UserSettings): Promise<EngineInfo> {
  let preferWebGPU = settings.renderer !== 'webgl2';
  try {
    if (settings.renderer === 'auto' && sessionStorage.getItem(FALLBACK_KEY)) preferWebGPU = false;
  } catch {
    /* ignore */
  }
  if (new URLSearchParams(location.search).get('gl') === '2') preferWebGPU = false;

  if (preferWebGPU && (await WebGPUEngine.IsSupportedAsync)) {
    try {
      const engine = new WebGPUEngine(canvas, {
        antialias: true,
        stencil: true,
        adaptToDeviceRatio: true,
        powerPreference: 'high-performance',
        setMaximumLimits: true,
        enableAllFeatures: true,
      });
      await engine.initAsync();
      engine.onContextLostObservable.add(() => markWebGPUBroken());
      const info = (engine as unknown as { _adapterInfo?: { vendor?: string; architecture?: string; description?: string } })._adapterInfo;
      const gpu = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'WebGPU device';
      return { engine, api: 'webgpu', gpu };
    } catch (err) {
      console.warn('[engine] WebGPU init failed, falling back to WebGL2', err);
      markWebGPUBroken();
    }
  }
  const engine = new Engine(canvas, true, {
    stencil: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    adaptToDeviceRatio: true,
  });
  const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
  let gpu = 'WebGL2 device';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch {
    /* ignore */
  }
  return { engine, api: 'webgl2', gpu };
}

export function markWebGPUBroken() {
  try {
    sessionStorage.setItem(FALLBACK_KEY, '1');
  } catch {
    /* ignore */
  }
}
