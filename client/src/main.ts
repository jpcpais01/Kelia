import '@fontsource-variable/inter';
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import './styles/main.css';
import { createEngine, markWebGPUBroken } from './core/engine';
import { PRESETS, autoQuality, loadSettings } from './core/quality';
import { RigLibrary } from './char/library';
import { perf } from './core/perf';
import { perfOverlay } from './ui/perfOverlay';
import './ui/fullscreen';
import { Game } from './game/game';
import { loadTerrainData } from './world/terrainData';
import { World } from './world/world';

const bar = document.getElementById('boot-progress') as HTMLElement | null;
const statusEl = document.getElementById('boot-status');
const progress = (p: number, text?: string) => {
  if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  if (text && statusEl) statusEl.textContent = text;
};

async function boot() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const settings = loadSettings();
  progress(0.02, 'Starting the renderer…');
  const { engine, api, gpu } = await createEngine(canvas, settings);
  console.log('[kelia] renderer', api, gpu);
  const params = new URLSearchParams(location.search);
  const level = (params.get('q') as keyof typeof PRESETS) || (settings.quality === 'auto' ? autoQuality(gpu) : settings.quality);
  const data = await loadTerrainData((p) => progress(0.05 + p * 0.5, 'Shaping the valley…'));
  progress(0.6, 'Growing the forests…');
  await new Promise((r) => setTimeout(r, 0));
  const world = new World(engine, data, PRESETS[level] ?? PRESETS.medium);
  if (settings.renderScale > 0) world.setRenderScale(settings.renderScale);
  progress(0.72, 'Raising the village…');
  const [lib, monsterLib] = await Promise.all([
    RigLibrary.load(world.scene, 'characters/adventurers.glb', ['knight', 'barbarian', 'mage', 'rogue']),
    RigLibrary.load(world.scene, 'characters/skeletons.glb', [], false),
    world.loadAssets(),
  ]);
  progress(0.9, 'Lighting the lanterns…');
  // Let terrain chunks and shaders settle before revealing.
  await world.scene.whenReadyAsync();
  progress(1, 'Welcome');

  let game: Game | null = null;
  perfOverlay.init(engine, {
    api,
    gpu,
    quality: () => `${world.quality.level} · ${world.scaleLabel()}`,
    ping: () => game?.ping ?? null,
  });

  let lastErrorFrames = 0;
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    try {
      perf.frameBegin();
      world.update(dt);
      perf.begin('render');
      world.scene.render();
      perf.end('render');
      perf.frameEnd();
      perfOverlay.update();
      lastErrorFrames = 0;
    } catch (err) {
      if (++lastErrorFrames === 1) console.error(err);
      if (lastErrorFrames > 30 && api === 'webgpu') {
        markWebGPUBroken();
        location.reload();
      }
    }
  });
  window.addEventListener('resize', () => engine.resize());
  (window as unknown as { kelia: unknown }).kelia = { world, engine, lib, monsterLib, perf };

  const cam = params.get('cam')?.split(',').map(Number);
  if (cam) {
    // Developer view: fixed camera for screenshots (?cam=x,y,z,tx,ty,tz&t=dayTime&rel).
    await devView(world, lib, params, cam, monsterLib);
  } else {
    game = new Game(world, lib, settings, gpu, monsterLib);
    (window as unknown as { game: unknown }).game = game;
    void game.start();
  }
  const bootEl = document.getElementById('boot');
  bootEl?.classList.add('done');
  setTimeout(() => bootEl?.remove(), 1300);
}

async function devView(world: World, lib: RigLibrary, params: URLSearchParams, cam: number[], monsterLib: RigLibrary) {
  const { Vector3 } = await import('@babylonjs/core');
  const t = params.get('t');
  if (t) world.atmosphere.dayTime = Number(t);
  const rel = params.has('rel');
  const g0 = rel ? world.groundAt(cam[0], cam[2]) : 0;
  const g1 = rel ? world.groundAt(cam[3], cam[5]) : 0;
  world.camera.position.set(cam[0], cam[1] + g0, cam[2]);
  world.camera.setTarget(new Vector3(cam[3], cam[4] + g1, cam[5]));
  if (params.get('monsters')) {
    const { MonsterModel } = await import('./char/monsterModel');
    const { MONSTERS, MONSTER_IDS } = await import('@kelia/shared');
    const [ox, oz] = (params.get('at') || '-62,-11').split(',').map(Number);
    const anim = params.get('anim');
    const ms = MONSTER_IDS.map((id, i) => {
      const m = new MonsterModel(world.scene, monsterLib, MONSTERS[id], 'dm' + i);
      const x = ox + (i - 2) * 2.2;
      m.root.position.set(x, world.groundAt(x, oz), oz);
      m.root.rotation.y = Number(params.get('yaw') ?? 0);
      m.setShadowCaster((mm) => world.atmosphere.addShadowCaster(mm, false));
      if (anim) m.animator.play(anim, { loop: true, upper: false });
      return m;
    });
    world.onUpdate((dt) => ms.forEach((m) => m.update(dt, Vector3.Zero())));
    (window as unknown as { monsters: unknown }).monsters = ms;
    return;
  }
  if (!params.get('chars')) return;
  const { CharacterModel } = await import('./char/model');
  const looks = [
    { appearance: { body: 1, skin: 1, face: 0, hair: 0, hairColor: 3, eyes: 2, outfit: 0, headgear: false }, cls: 'vanguard', weapon: 'sword_iron', offhand: 'shield_round' },
    { appearance: { body: 0, skin: 5, face: 1, hair: 1, hairColor: 6, eyes: 3, outfit: 1, headgear: true }, cls: 'ranger', weapon: 'bow_hunter', offhand: null },
    { appearance: { body: 2, skin: 3, face: 3, hair: 3, hairColor: 4, eyes: 1, outfit: 3, headgear: false }, cls: 'vanguard', weapon: 'axe_woodsman', offhand: 'shield_spike' },
    { appearance: { body: 1, skin: 8, face: 2, hair: 2, hairColor: 9, eyes: 5, outfit: 2, headgear: true }, cls: 'arcanist', weapon: 'staff_sun', offhand: null },
    { appearance: { body: 0, skin: 7, face: 1, hair: 4, hairColor: 0, eyes: 0, outfit: 4, headgear: false }, cls: 'ranger', weapon: 'bow_starfall', offhand: null },
    { appearance: { body: 2, skin: 0, face: 0, hair: 1, hairColor: 8, eyes: 4, outfit: 5, headgear: false }, cls: 'arcanist', weapon: 'wand_willow', offhand: null },
  ] as const;
  const anims = (params.get('anim') || 'Idle').split(',');
  const [ox, oz] = (params.get('at') || '-62,-11').split(',').map(Number);
  const chars = looks.map((l, i) => {
    const look = JSON.parse(JSON.stringify(l));
    // &hg=1 / &hg=0 forces every headgear on or off
    if (params.has('hg')) look.appearance.headgear = params.get('hg') === '1';
    const c = new CharacterModel(world.scene, lib, look, 'c' + i);
    const x = ox + (i - 2.5) * 1.6;
    c.root.position.set(x, world.groundAt(x, oz), oz);
    c.root.rotation.y = Math.PI;
    c.groundAt = (x, z) => world.groundAt(x, z);
    c.setShadowCaster((m) => world.atmosphere.addShadowCaster(m, false));
    const a = anims[i % anims.length];
    if (a !== 'Idle' && a !== 'walk' && a !== 'run') c.animator.play(a, { loop: true });
    return { c, a };
  });
  world.onUpdate((dt) => {
    for (const { c, a } of chars) {
      const v = a === 'walk' ? new Vector3(0, 0, -2.1) : a === 'run' ? new Vector3(0, 0, -5.4) : Vector3.Zero();
      c.update(dt, v, 0, false);
    }
  });
  (window as unknown as { chars: unknown }).chars = chars;
}

boot().catch((err) => {
  console.error(err);
  progress(1, 'Something went wrong while loading. Please refresh.');
});
