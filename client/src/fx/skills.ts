// Choreography of every player skill's effects: what appears when, relative
// to the moment the skill is used. Shared by the combat controller (local and
// remote players) and the developer showcase view.
import { Vector3, type AbstractMesh, type TransformNode } from '@babylonjs/core';
import type { ClassId, SkillDef } from '@kelia/shared';
import { C, D, S, type Effects } from './fx';

export const CLASS_COLORS: Record<ClassId, { main: string; hit: string }> = {
  vanguard: { main: '#ffc457', hit: '#ffd27a' },
  ranger: { main: '#a8ff8a', hit: '#d6ffb0' },
  arcanist: { main: '#a98bff', hit: '#d4c4ff' },
};

/** What the choreography needs to know about the world. */
export interface FxWorld {
  groundAt(x: number, z: number): number;
  /** First live enemy near p (missile visuals). */
  monsterAt(p: Vector3, radius: number): { id: number; pos: Vector3; scale: number } | null;
  /** Camera shake (amount), only called for effects near the local player. */
  shake(amount: number): void;
  playerPos(): Vector3;
}

/** The caster, as far as effects care. */
export interface FxCaster {
  root: TransformNode;
  meshes: AbstractMesh[];
  node(name: string): TransformNode | undefined;
}

function handPos(model: FxCaster, slot: 'handslot.r' | 'handslot.l', fallbackY = 1.3) {
  const n = model.node(slot);
  if (n) {
    n.computeWorldMatrix(true);
    return n.getAbsolutePosition().clone();
  }
  return model.root.position.add(new Vector3(0, fallbackY, 0));
}

export function playSkillFx(fx: Effects, w: FxWorld, model: FxCaster, cls: ClassId, skill: SkillDef, yaw: number, tx: number, tz: number, local: boolean) {
  const col = CLASS_COLORS[cls];
  const at = () => model.root.position.clone();
  const chest = () => at().add(new Vector3(0, 1.0, 0));
  const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const near = () => local || Vector3.Distance(at(), w.playerPos()) < 14;
  const impact = Math.max(0, skill.impactAt - 0.07);
  const hand = model.node('handslot.r');
  switch (skill.vfx) {
    case 'slash':
    case 'heavy': {
      const heavy = skill.vfx === 'heavy';
      const step = skill.id === 'combo2' ? 1 : 0;
      fx.weaponTrail(hand, col.main, Math.max(0, skill.impactAt - 0.24), heavy ? 0.55 : 0.45, { intensity: heavy ? 1.3 : 1 });
      fx.after(impact, () => {
        // rising diagonal slice (right to left), level cut (left to right), overhead chop
        fx.slash(at().add(fwd.scale(0.2)).addInPlace(new Vector3(0, heavy ? 1.2 : step ? 0.85 : 1.0, 0)), yaw, col.main, {
          radius: heavy ? 1.75 : 1.55,
          arc: heavy ? 2.6 : 2.5,
          tilt: heavy ? 1.32 : step ? 0.06 : -0.4,
          reverse: heavy || !step,
          width: heavy ? 0.95 : 0.8,
          dur: heavy ? 0.32 : 0.26,
          intensity: heavy ? 1.25 : 1,
        });
        if (heavy) {
          const g = at().add(fwd.scale(1.7));
          g.y = w.groundAt(g.x, g.z);
          fx.after(0.06, () => {
            fx.decal(g.x, g.y, g.z, { r0: 0.3, r: 2.4, dur: 0.45, cell: D.shock, color: C(col.main, 2.4), mode: 0, fadeIn: 0, fadeOut: 0.3 });
            fx.decal(g.x, g.y, g.z, { r0: 0.6, r: 1.3, dur: 1.6, cell: D.cracks, color: [0.03, 0.025, 0.02], alpha: 0.7, occl: 1, hot: 0, fadeIn: 0.02, fadeOut: 0.6 });
            fx.sparks(g.add(new Vector3(0, 0.2, 0)), C(col.main, 3.5), { n: 12, speed: 8, up: 0.7, dur: 0.4, gravity: 9 });
            fx.dust(g, 10, 0.5);
          });
          if (local) w.shake(0.18);
        }
      });
      break;
    }
    case 'bash':
      fx.after(impact, () => {
        fx.bash(chest(), yaw, col.main);
        if (local) w.shake(0.25);
      });
      break;
    case 'whirl':
      fx.weaponTrail(hand, col.main, Math.max(0, skill.impactAt - 0.3), 0.6, { intensity: 1.3, life: 0.26 });
      fx.after(impact - 0.15, () => {
        fx.whirlwind(at(), yaw, col.main, skill.shape.kind === 'aoe-self' ? skill.shape.radius : 3.6);
        if (local) w.shake(0.22);
      });
      break;
    case 'rally':
      fx.after(Math.max(0, impact - 0.25), () => fx.gather(chest().add(new Vector3(0, 0.5, 0)), '#ffd27a', 0.25, 14, 1.2));
      fx.after(impact, () => fx.rally(at()));
      break;
    case 'arrow':
    case 'arrow_heavy':
    case 'arrow_pierce':
    case 'snare': {
      if (skill.shape.kind !== 'projectile') break;
      const sh = skill.shape;
      const kind = skill.vfx === 'arrow_pierce' ? 'pierce' : skill.vfx === 'snare' ? 'snare' : skill.vfx === 'arrow_heavy' ? 'arrow_heavy' : 'arrow';
      const tint = kind === 'pierce' ? '#8fd8ff' : kind === 'snare' ? '#7dff8a' : kind === 'arrow_heavy' ? '#fff2b0' : col.main;
      if (kind !== 'arrow') fx.after(Math.max(0, skill.impactAt - 0.32), () => fx.gather(handPos(model, 'handslot.l'), tint, 0.3, kind === 'pierce' ? 16 : 10, 0.8));
      fx.after(skill.impactAt, () => {
        const from = handPos(model, 'handslot.l');
        const target = new Vector3(tx, w.groundAt(tx, tz) + 1.1, tz);
        const dir = Vector3.Distance(target, from) > 2 ? target.subtract(from).normalize() : fwd;
        const hitIds = new Set<number>();
        // release flash at the bow
        fx.sprite(from, { dur: 0.16, size: 0.12, size1: kind === 'arrow' ? 0.45 : 0.8, cell: S.star4, color: C(tint, 4), rot: Math.random(), hot: 1, fadeIn: 0 });
        fx.shockRing(from.add(dir.scale(0.3)), C(tint, 2.2), 0.1, kind === 'pierce' ? 0.9 : 0.5, 0.22, dir);
        if (kind === 'pierce') {
          fx.shockRing(from.add(dir.scale(0.9)), C(tint, 1.8), 0.1, 1.2, 0.3, dir, 0.04);
          fx.flash(from, C(tint, 3), 1.6, 0.2);
        }
        fx.missile(from, dir, sh.speed, sh.range, kind, tint, (p) => {
          const m = w.monsterAt(p, sh.radius);
          if (!m || hitIds.has(m.id)) return false;
          hitIds.add(m.id);
          fx.impact(p, tint, { dir, scale: kind === 'arrow' ? 0.8 : 1.1 });
          if (kind === 'snare') fx.snare(m.pos, Math.max(1, m.scale));
          if (kind === 'pierce') fx.shockRing(p, C(tint, 2.4), 0.2, 1.6, 0.3, dir);
          return !sh.pierce;
        });
      });
      break;
    }
    case 'volley':
      fx.after(skill.impactAt * 0.4, () => {
        const r = skill.shape.kind === 'aoe-target' ? skill.shape.radius : 4;
        const from = handPos(model, 'handslot.l');
        for (let i = 0; i < 6; i++) {
          const d = new Vector3(fwd.x * 0.25 + (Math.random() - 0.5) * 0.2, 1, fwd.z * 0.25 + (Math.random() - 0.5) * 0.2).normalize();
          fx.sprite(from, { v: d.scale(40), dur: 0.35, size: 0.06, cell: S.spark, color: C('#e8ffd0', 5), mode: 1, stretch: 0.035, hot: 1, fadeIn: 0, fadeOut: 0.8, delay: i * 0.03 });
        }
        fx.sprite(from, { dur: 0.18, size: 0.15, size1: 0.7, cell: S.star4, color: C('#c8ffb0', 4), hot: 1, fadeIn: 0 });
        fx.reticle(tx, tz, r, skill.impactAt * 0.6 + 0.3, '#9cff8a');
        fx.volley(tx, tz, r, '#e8ffd0', skill.impactAt * 0.6 - 0.25);
      });
      break;
    case 'bolt':
    case 'bolt_big': {
      if (skill.shape.kind !== 'projectile') break;
      const sh = skill.shape;
      const big = skill.vfx === 'bolt_big';
      const tint = big ? '#c9b6ff' : col.main;
      fx.magicCircle(at(), col.main, { radius: big ? 1.5 : 1.1, dur: skill.impactAt + 0.45, spin: 2, intensity: 2.2, inner: big });
      fx.weaponTrail(hand, col.main, 0, skill.impactAt + 0.05, { life: 0.16, intensity: 0.8 });
      fx.after(0.02, () => fx.gather(handPos(model, 'handslot.r', 1.5).add(new Vector3(0, 0.3, 0)), tint, Math.max(0.12, skill.impactAt - 0.04), big ? 16 : 9, 0.7));
      fx.after(skill.impactAt, () => {
        const from = handPos(model, 'handslot.r', 1.5).add(new Vector3(0, 0.3, 0));
        const target = new Vector3(tx, w.groundAt(tx, tz) + 1.1, tz);
        const dir = Vector3.Distance(target, from) > 2 ? target.subtract(from).normalize() : fwd;
        fx.flash(from, C(tint, 3), big ? 1.6 : 1.0, 0.15);
        fx.shockRing(from, C(tint, 2), 0.1, big ? 1 : 0.6, 0.2, dir);
        fx.missile(from, dir, sh.speed, sh.range, big ? 'bolt_big' : 'bolt', tint, (p) => !!w.monsterAt(p, sh.radius), (p, struck) => fx.arcaneBurst(p, tint, big, struck));
      });
      break;
    }
    case 'fireball': {
      const radius = skill.shape.kind === 'aoe-target' ? skill.shape.radius : 3.5;
      fx.magicCircle(at(), '#ff8a2a', { radius: 1.7, dur: skill.impactAt + 0.3, spin: 2.2, intensity: 2.4 });
      fx.weaponTrail(hand, '#ff9a3a', 0, skill.impactAt * 0.55, { life: 0.2 });
      fx.after(0.05, () => fx.gather(handPos(model, 'handslot.r', 1.6).add(new Vector3(0, 0.5, 0)), '#ffb04a', skill.impactAt * 0.5 - 0.05, 14, 1.0));
      // where it will land
      const ty = w.groundAt(tx, tz);
      fx.decal(tx, ty, tz, { r0: radius * 0.4, r: radius, dur: skill.impactAt + 0.1, cell: D.arcane, color: C('#ff7a2a', 1.6), spin: 2, fadeIn: 0.4, fadeOut: 0.85, hot: 0.5 });
      fx.after(skill.impactAt * 0.55, () => {
        const from = handPos(model, 'handslot.r', 1.6).add(new Vector3(0, 0.5, 0));
        const target = new Vector3(tx, ty + 0.2, tz);
        const dist = Vector3.Distance(from, target);
        const travel = Math.max(0.12, skill.impactAt * 0.45);
        fx.flash(from, C('#ffb04a', 3), 1.4, 0.2);
        fx.missile(from, target.subtract(from).normalize(), dist / travel, dist, 'fire', '#ff8a2a', () => false, (p) => {
          const g = new Vector3(p.x, w.groundAt(p.x, p.z), p.z);
          fx.explosion(g, radius);
          if (Vector3.Distance(g, w.playerPos()) < 16) w.shake(0.3);
        });
      });
      break;
    }
    case 'frost': {
      const r = skill.shape.kind === 'aoe-self' ? skill.shape.radius : 6;
      fx.magicCircle(at(), '#8fe8ff', { radius: 1.6, dur: impact + 0.35, spin: 2.5, intensity: 2.4, cell: D.frost });
      fx.after(0.03, () => fx.gather(handPos(model, 'handslot.r', 1.5), '#bff4ff', Math.max(0.1, impact - 0.05), 12, 1.0));
      fx.after(impact, () => {
        fx.frostNova(at(), r);
        if (near()) w.shake(0.15);
      });
      break;
    }
    case 'heal':
      fx.magicCircle(at(), '#ffe58a', { radius: 1.4, dur: impact + 0.3, spin: 1.5, intensity: 2.2, cell: D.sun, inner: false });
      fx.after(0.05, () => fx.gather(chest().add(new Vector3(0, 0.9, 0)), '#fff2b0', Math.max(0.1, impact - 0.08), 14, 1.1));
      fx.after(impact, () => fx.heal(at(), '#ffe58a', skill.shape.kind === 'aoe-self' ? skill.shape.radius : 10));
      break;
    default:
      break;
  }
}

/**
 * Dodge effects. `from` is where the dodge started; for a blink `to` is where
 * it ended (leave the afterimage with fx.afterimage before teleporting).
 */
export function playDodgeFx(fx: Effects, cls: ClassId, from: Vector3, to: Vector3 | null, yaw: number) {
  if (cls === 'arcanist') {
    if (to) fx.blink(from, to, '#b49bff');
    return;
  }
  const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const color = cls === 'ranger' ? '#c8ffb0' : '#ffe9b8';
  fx.dust(from, 8);
  // wind streaks along the dash
  const dir = cls === 'ranger' ? fwd.scale(-1) : fwd;
  for (let i = 0; i < 8; i++) {
    const p = from.add(new Vector3((Math.random() - 0.5) * 0.8, 0.3 + Math.random() * 1.2, (Math.random() - 0.5) * 0.8));
    fx.sprite(p, { v: dir.scale(9 + Math.random() * 5), drag: 4, dur: 0.3, size: 0.04, cell: S.spark, color: C(color, 2.5), mode: 1, stretch: 0.06, hot: 1, alpha: 0.8, delay: i * 0.02 });
  }
  if (cls === 'ranger') {
    for (let i = 0; i < 6; i++) {
      fx.sprite(from.add(new Vector3(0, 0.5 + Math.random(), 0)), { v: new Vector3((Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2), dur: 0.9, size: 0.08, cell: S.leaf, color: C('#9cff7a', 1.6), rot: Math.random() * 6, spin: (Math.random() - 0.5) * 6, hot: 0.3, gravity: 1, drag: 1.5 });
    }
  }
}
