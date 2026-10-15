import { createEngine } from './core/engine';
import { PRESETS, autoQuality, loadSettings } from './core/quality';
import { loadTerrainData } from './world/terrainData';
import { World } from './world/world';
import './styles/main.css';

async function boot() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const settings = loadSettings();
  const { engine, api, gpu } = await createEngine(canvas, settings);
  console.log('[kelia] renderer', api, gpu);
  const params = new URLSearchParams(location.search);
  const level = (params.get('q') as keyof typeof PRESETS) || (settings.quality === 'auto' ? autoQuality(gpu) : settings.quality);
  const data = await loadTerrainData((p) => console.log('terrain', Math.round(p * 100)));
  const world = new World(engine, data, PRESETS[level]);
  await world.loadAssets();
  const t = params.get('t');
  if (t) world.atmosphere.dayTime = Number(t);
  const cam = params.get('cam')?.split(',').map(Number);
  if (cam) {
    world.camera.position.set(cam[0], cam[1], cam[2]);
    world.camera.setTarget(new (await import('@babylonjs/core')).Vector3(cam[3], cam[4], cam[5]));
  }
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    world.update(dt);
    world.scene.render();
  });
  window.addEventListener('resize', () => engine.resize());
  document.getElementById('boot')?.remove();
  (window as unknown as { kelia: unknown }).kelia = { world, engine };
}

boot().catch((err) => {
  console.error(err);
});
