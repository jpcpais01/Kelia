// Developer showcase for the combat effects (?cam=...&chars=1&fx=<scene>).
// Places characters and skeleton targets, plays a scripted set of skills on a
// fixed time step, and freezes everything at ?fxt=<seconds> so a headless
// screenshot captures the effects mid-flight regardless of frame rate.
import { Vector3 } from '@babylonjs/core';
import { CLASSES, MONSTERS, type ClassId, type MonsterId, type SkillDef } from '@kelia/shared';
import { playSkillAnim } from '../char/attacks';
import type { RigLibrary } from '../char/library';
import type { CharacterModel } from '../char/model';
import type { World } from '../world/world';
import { D, Effects } from './fx';
import { playDodgeFx, playSkillFx, type FxWorld } from './skills';

interface Actor {
  c: CharacterModel;
  cls: ClassId;
}

type Step = (t: number) => void;

export async function runFxShowcase(world: World, chars: Actor[], monsterLib: RigLibrary, params: URLSearchParams, center: [number, number]) {
  const { MonsterModel } = await import('../char/monsterModel');
  const fx = new Effects(world.scene, world.terrain.heightTexture);
  if (params.has('notrail')) fx.weaponTrail = () => {};
  fx.groundAt = (x, z) => world.groundAt(x, z);
  const scene = world.scene;
  const STEP = Number(params.get('fxs') || '0.05');
  scene.useConstantAnimationDeltaTime = true;
  scene.animationTimeScale = STEP / 0.016;
  const name = params.get('fx') || 'melee';
  const freezeAt = Number(params.get('fxt') || '99999');
  const [cx, cz] = center;
  const gy = (x: number, z: number) => world.groundAt(x, z);
  const cam = world.camera.position;
  const faceCam = (x: number, z: number) => Math.atan2(cam.x - x, cam.z - z);

  const targets: { pos: Vector3; m: InstanceType<typeof MonsterModel>; id: number; def: (typeof MONSTERS)[MonsterId] }[] = [];
  const addTarget = (id: MonsterId, x: number, z: number, yaw: number) => {
    const def = MONSTERS[id];
    const m = new MonsterModel(scene, monsterLib, def, 'fxT' + targets.length);
    m.root.position.set(x, gy(x, z), z);
    m.root.rotation.y = yaw;
    m.setShadowCaster((mm) => world.atmosphere.addShadowCaster(mm, false));
    targets.push({ pos: m.root.position, m, id: targets.length, def });
    return m;
  };
  const place = (i: number, x: number, z: number, yaw: number) => {
    const a = chars[i];
    a.c.root.position.set(x, gy(x, z), z);
    a.c.root.rotation.y = yaw;
    return a;
  };
  const hide = (keep: number[]) => chars.forEach((a, i) => a.c.setVisible(keep.includes(i)));

  const fxw: FxWorld = {
    groundAt: gy,
    monsterAt: (p, r) => {
      for (const t of targets) {
        const dx = t.pos.x - p.x;
        const dz = t.pos.z - p.z;
        const rr = r + t.def.radius;
        if (dx * dx + dz * dz < rr * rr && p.y > t.pos.y - 0.3 && p.y < t.pos.y + 2.4 * t.def.scale) return { id: t.id, pos: t.pos, scale: t.def.scale };
      }
      return null;
    },
    shake: () => {},
    playerPos: () => new Vector3(cx, gy(cx, cz), cz),
  };

  const skill = (cls: ClassId, k: 'c' | 's' | 'd', i: number): SkillDef => {
    const c = CLASSES[cls];
    return k === 'c' ? c.combo[i] : k === 's' ? c.skills[i] : c.dodge;
  };
  const cast = (a: Actor, s: SkillDef, yaw: number, tx: number, tz: number) => {
    a.c.root.rotation.y = yaw;
    playSkillAnim(a.c.animator, s, false);
    playSkillFx(fx, fxw, a.c, a.cls, s, yaw, tx, tz, true);
  };
  const hitAt = (t: (typeof targets)[number], crit: boolean, color = '#ffd27a') => fx.impact(t.pos.add(new Vector3(0, 1.0 * t.def.scale, 0)), color, { crit, scale: 1 });

  // ---------------------------------------------------------------- scenes
  const steps: [number, Step][] = [];
  const at = (t: number, fn: Step) => steps.push([t, fn]);
  if (name === 'test') {
    hide([]);
    const p = new Vector3(cx + 0.5, gy(cx, cz) + 1.2, cz);
    at(0, () => {
      fx.shape(p, { mode: 0, yaw: 2.5, tilt: 0, dur: 1, len: 2.3, head: 1.9, radius: 2, width: 0.8, color: [2, 1, 0.2] });
      fx.shape(p.add(new Vector3(0, 1.2, 0)), { mode: 0, yaw: 2.5, tilt: 0.5, dur: 1, len: 2.3, head: 1.9, radius: 2, width: 0.8, color: [0.2, 1, 2] });
      fx.slash(p.add(new Vector3(-2, 0, 0)), 2.5, '#ffc457', { dur: 1 });
      const q = new Vector3(cx - 0.4, gy(cx - 0.4, cz - 0.2) + 1, cz - 0.2);
      fx.slash(q, 0.38, '#ffc457', { dur: 1, tilt: 0.48, radius: 2.05, arc: 2.3, width: 0.8 });
      fx.slash(q.add(new Vector3(2, 0, 0)), 0.38, '#7fd7ff', { dur: 1, tilt: 0, radius: 2.05, arc: 2.3, width: 0.8 });
    });
    at(0.25, () => {
      const q = new Vector3(cx - 0.4, gy(cx - 0.4, cz - 0.2) + 1, cz - 0.2);
      fx.slash(q.add(new Vector3(0, 1, 0)), 0.38, '#ff7fd7', { dur: 0.26, tilt: 0.48, radius: 2.05, arc: 2.3, width: 0.8 });
      fx.slash(q.add(new Vector3(0, 2, 0)), 0.38, '#ff7fd7', { dur: 0.6, tilt: 0.48, radius: 2.05, arc: 2.3, width: 0.8 });
    });
  } else if (name === 'melee') {
    hide([0, 2]);
    const t0 = addTarget('warrior', cx - 0.6, cz + 1.6, faceCam(cx, cz) + Math.PI);
    void t0;
    const a = place(0, cx - 1.6, cz - 0.4, 0);
    const b = place(2, cx + 2.6, cz - 1.0, 0);
    const ya = Math.atan2(targets[0].pos.x - a.c.root.position.x, targets[0].pos.z - a.c.root.position.z);
    at(0, () => cast(a, skill('vanguard', 'c', 2), ya, 0, 0));
    at(0.02, () => cast(b, skill('vanguard', 's', 1), faceCam(cx + 2.6, cz - 1), 0, 0));
    at(0.38, () => hitAt(targets[0], true));
  } else if (name === 'slash') {
    hide([0]);
    addTarget('minion', cx + 0.4, cz + 1.8, Math.PI);
    const a = place(0, cx - 0.4, cz - 0.2, 0);
    const ya = Math.atan2(targets[0].pos.x - a.c.root.position.x, targets[0].pos.z - a.c.root.position.z);
    const ci = Number(params.get('combo') || '0');
    at(0, () => cast(a, skill('vanguard', 'c', ci), ya, 0, 0));
    if (params.has('measure')) at(0, () => fx.weaponTrail(a.c.node('handslot.r'), '#ffffff', 0, 1, { life: 2 }));
    at(0.3, () => hitAt(targets[0], false));
  } else if (name === 'bash') {
    hide([0, 2]);
    addTarget('rogue', cx + 0.2, cz + 2.4, Math.PI);
    const a = place(0, cx - 0.6, cz + 0.2, 0);
    const b = place(2, cx + 2.4, cz - 1.4, 0);
    at(0, () => cast(a, skill('vanguard', 's', 0), Math.atan2(targets[0].pos.x - a.c.root.position.x, targets[0].pos.z - a.c.root.position.z), 0, 0));
    at(0, () => cast(b, skill('vanguard', 's', 2), faceCam(cx + 2.4, cz - 1.4), 0, 0));
  } else if (name === 'magic') {
    hide([3, 5]);
    addTarget('warrior', cx - 3.2, cz + 3.6, 0);
    const a = place(3, cx + 1.6, cz - 1.2, 0);
    const b = place(5, cx - 2.4, cz - 2.2, 0);
    const tg = targets[0].pos;
    at(0, () => cast(a, skill('arcanist', 's', 0), Math.atan2(tg.x - (cx + 1.6), tg.z - (cz - 1.2)), tg.x, tg.z));
    at(0.4, () => cast(b, skill('arcanist', 's', 1), faceCam(cx - 2.4, cz - 2.2), 0, 0));
  } else if (name === 'arcane') {
    hide([3, 5]);
    addTarget('minion', cx - 3.0, cz + 5.0, 0);
    const a = place(3, cx + 1.4, cz - 1.0, 0);
    const b = place(5, cx - 2.0, cz - 1.6, 0);
    const tg = targets[0].pos;
    at(0, () => cast(a, skill('arcanist', 'c', 2), Math.atan2(tg.x - (cx + 1.4), tg.z - (cz - 1.0)), tg.x, tg.z));
    at(0.1, () => cast(b, skill('arcanist', 's', 2), faceCam(cx - 2, cz - 1.6), 0, 0));
  } else if (name === 'blink') {
    hide([3, 5]);
    const a = place(3, cx - 2.6, cz - 0.4, 0);
    const b = place(5, cx + 1.6, cz - 1.0, 0);
    at(0, () => {
      const from = a.c.root.position.clone();
      fx.afterimage(a.c.meshes, '#b49bff', { dur: 0.55, intensity: 2.6 });
      a.c.root.position.x += 3.2;
      a.c.root.position.z += 1.2;
      a.c.root.position.y = gy(a.c.root.position.x, a.c.root.position.z);
      playDodgeFx(fx, 'arcanist', from, a.c.root.position.clone(), 0);
      a.c.animator.play('Spellcast_Raise', { upper: true, speed: 2 });
    });
    at(0, () => cast(b, skill('arcanist', 'c', 0), faceCam(cx + 1.6, cz - 1) - 0.9, cx - 6, cz + 6));
  } else if (name === 'ranger') {
    hide([1, 4]);
    addTarget('rogue', cx - 4, cz + 7, 0);
    addTarget('minion', cx + 3.5, cz + 6, 0);
    const a = place(1, cx - 1.2, cz - 1.0, 0);
    const b = place(4, cx + 1.8, cz - 1.6, 0);
    const t1 = targets[0].pos;
    at(0, () => cast(a, skill('ranger', 's', 0), Math.atan2(t1.x - (cx - 1.2), t1.z - (cz - 1)), t1.x, t1.z));
    at(0, () => cast(b, skill('ranger', 's', 1), Math.atan2(targets[1].pos.x - (cx + 1.8), targets[1].pos.z - (cz - 1.6)), targets[1].pos.x, targets[1].pos.z));
  } else if (name === 'snare') {
    hide([1, 4]);
    addTarget('warrior', cx - 1.5, cz + 4, Math.PI);
    const a = place(1, cx + 0.6, cz - 1.5, 0);
    const b = place(4, cx + 2.2, cz - 0.6, 0);
    const t1 = targets[0].pos;
    at(0, () => cast(a, skill('ranger', 's', 2), Math.atan2(t1.x - (cx + 0.6), t1.z - (cz - 1.5)), t1.x, t1.z));
    at(0.25, () => cast(b, skill('ranger', 'c', 2), Math.atan2(t1.x - (cx + 2.2), t1.z - (cz - 0.6)), t1.x, t1.z));
  } else if (name === 'boss') {
    hide([0]);
    const k = addTarget('king', cx - 1.0, cz + 3.5, faceCam(cx - 1, cz + 3.5));
    addTarget('mage', cx + 3.5, cz + 2.5, faceCam(cx + 3.5, cz + 2.5));
    place(0, cx + 0.5, cz - 1.0, faceCam(cx + 0.5, cz - 1));
    const sx = cx + 0.2;
    const sz = cz + 0.8;
    at(0, () => {
      k.animator.play('1H_Melee_Attack_Jump_Chop', { speed: 0.85, upper: false });
      fx.telegraph(sx, sz, 4.2, 1.05);
      fx.telegraph(cx + 3.5, cz - 1.5, 2.2, 1.6, '#b45cff', D.hex);
    });
    at(1.05, () => fx.slam(new Vector3(sx, gy(sx, sz), sz), 4.2, '#ff8a4a', true));
  } else if (name === 'death') {
    hide([0, 1]);
    const m1 = addTarget('warrior', cx - 1.5, cz + 2.5, faceCam(cx - 1.5, cz + 2.5));
    const m2 = addTarget('mage', cx + 2.2, cz + 2.8, faceCam(cx + 2.2, cz + 2.8));
    place(0, cx - 2.4, cz - 0.6, faceCam(cx - 2.4, cz - 0.6));
    place(1, cx + 1.4, cz - 1.0, faceCam(cx + 1.4, cz - 1));
    at(0, () => {
      m1.animator.play('Death_A', { hold: true, upper: false });
      m2.animator.play('Death_B', { hold: true, upper: false });
    });
    at(0.35, () => {
      fx.soulRelease(targets[0].pos.clone(), targets[0].def.scale, targets[0].def.eyeColor, m1.meshes);
      fx.soulRelease(targets[1].pos.clone(), targets[1].def.scale, targets[1].def.eyeColor, m2.meshes);
    });
    at(0.0, () => fx.levelUp(chars[0].c.root.position.clone()));
    at(0.2, () => fx.lootBeam(chars[1].c.root.position.clone(), '#c77dff', true));
  }

  // ---------------------------------------------------------------- loop
  let t = 0;
  let warm = 0;
  let frozen = false;
  const t0 = performance.now();
  world.onUpdate(() => {
    // let shaders compile before the clock starts
    if (warm < 3 || performance.now() - t0 < 1500) {
      warm++;
      fx.update(0);
      for (const a of chars) a.c.update(STEP, Vector3.Zero(), 0, false);
      for (const tg of targets) tg.m.update(STEP, Vector3.Zero());
      return;
    }
    if (frozen) {
      fx.update(0);
      return;
    }
    const dt = Math.min(STEP, freezeAt - t);
    for (const s of steps) if (s[0] >= t && s[0] < t + dt + 1e-6 && !(s as unknown as { done?: boolean }).done) {
      (s as unknown as { done?: boolean }).done = true;
      s[1](t);
    }
    t += dt;
    fx.update(dt);
    for (const a of chars) a.c.update(dt, Vector3.Zero(), 0, false);
    for (const tg of targets) tg.m.update(dt, Vector3.Zero());
    if (t >= freezeAt - 1e-6) {
      frozen = true;
      scene.animationsEnabled = false;
      console.log('[fx] frozen at', t.toFixed(2));
    }
  });
  (window as unknown as { fx: unknown }).fx = fx;
}
