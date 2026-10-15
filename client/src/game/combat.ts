// Client side of combat: reads attack input (combo, skills, dodge, potions),
// aims with a soft lock on the enemy nearest the crosshair, plays animations
// and effects immediately (the server decides what actually hits), and shows
// the results: damage numbers, hit reactions, telegraphs, deaths and level ups.
import { Vector3 } from '@babylonjs/core';
import {
  CLASSES,
  HIT_CRIT,
  HIT_DODGED,
  HIT_DOT,
  HIT_HEAL,
  HIT_PLAYER,
  ITEMS,
  POTION_COOLDOWN,
  SKILL_UNLOCK,
  clampAim,
  skillFor,
  skillUnlocked,
  statsFor,
  xpToNext,
  type ActKind,
  type CharacterData,
  type ClassId,
  type Hit,
  type ServerMessage,
  type SkillDef,
  type Stats,
} from '@kelia/shared';
import type { CharacterModel } from '../char/model';
import type { Effects } from '../fx/fx';
import type { Net } from '../net/net';
import type { Hud } from '../ui/hud';
import type { World } from '../world/world';
import type { FollowCamera } from './camera';
import type { Input } from './input';
import type { MonsterEntity } from './monsters';
import type { LocalPlayer } from './player';
import type { RemotePlayer } from './remote';

export interface CombatContext {
  world: World;
  fx: Effects;
  hud: Hud;
  net: Net;
  input: Input;
  follow: FollowCamera;
  player: LocalPlayer;
  character: CharacterData;
  myId: number;
  remotes: Map<number, RemotePlayer>;
  monsters: Map<number, MonsterEntity>;
  canAct(): boolean;
}

const CLASS_COLORS: Record<ClassId, { main: string; hit: string }> = {
  vanguard: { main: '#ffe1a0', hit: '#ffd27a' },
  ranger: { main: '#b8ff9a', hit: '#d6ffb0' },
  arcanist: { main: '#b49bff', hit: '#d4c4ff' },
};

interface Timer {
  t: number;
  fn: () => void;
}

export class CombatController {
  private cooldowns = new Map<string, number>(); // skill id -> time ready (s)
  private busyUntil = 0;
  private comboIdx = 0;
  private comboExpire = 0;
  private queued: { k: ActKind; i: number; until: number } | null = null;
  private potionReady = 0;
  private timers: Timer[] = [];
  private t = 0;
  stats: Stats;
  dead = false;
  maxHp: number;

  constructor(private c: CombatContext) {
    this.stats = statsFor(c.character.cls, c.character.level, c.character.equipment);
    this.maxHp = this.stats.maxHp;
    c.player.speedMul = this.stats.speed;
  }

  private later(seconds: number, fn: () => void) {
    this.timers.push({ t: this.t + seconds, fn });
  }

  // ------------------------------------------------------------------ input
  update(dt: number) {
    this.t += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].t <= this.t) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        fn();
      }
    }
    const { input } = this.c;
    if (!this.dead && this.c.canAct()) {
      if (input.locked && input.mouseButtons.has(0)) this.queue('c', 0);
      for (let i = 0; i < 3; i++) if (input.pressedKey(`Digit${i + 1}`) || input.pressedKey(`Numpad${i + 1}`)) this.queue('s', i);
      if (input.pressedKey('KeyQ') || input.pressedKey('ShiftRight')) this.queue('d', 0);
      if (input.pressedKey('KeyR')) this.drinkPotion();
    }
    if (this.queued && this.t > this.queued.until) this.queued = null;
    if (this.queued && this.t >= this.busyUntil && !this.dead) {
      const q = this.queued;
      this.queued = null;
      this.act(q.k, q.i);
    }
    this.updateCooldownUi();
  }

  private queue(k: ActKind, i: number) {
    // a dodge cancels a queued attack; attacks don't replace a queued dodge
    if (this.queued?.k === 'd' && k !== 'd') return;
    this.queued = { k, i, until: this.t + 0.35 };
  }

  private updateCooldownUi() {
    const hud = this.c.hud;
    const cls = CLASSES[this.c.character.cls];
    cls.skills.forEach((s, i) => {
      const left = Math.max(0, (this.cooldowns.get(s.id) ?? 0) - this.t);
      hud.setCooldown(1 + i, left / (s.cooldown * (1 - this.stats.cdr)), left);
    });
    const dl = Math.max(0, (this.cooldowns.get(cls.dodge.id) ?? 0) - this.t);
    hud.setCooldown(4, dl / cls.dodge.cooldown, dl);
    const pl = Math.max(0, this.potionReady - this.t);
    hud.setCooldown(5, pl / POTION_COOLDOWN, pl);
  }

  private drinkPotion() {
    const inv = this.c.character.inventory;
    const id = inv.find((s) => s.id === 'potion_small' && s.qty > 0)?.id ?? inv.find((s) => s.id === 'potion_large' && s.qty > 0)?.id;
    if (!id) {
      this.c.hud.toast('No potions left.');
      return;
    }
    if (this.t < this.potionReady) return;
    if (this.c.character.hp >= this.maxHp) {
      this.c.hud.toast('You are already at full health.');
      return;
    }
    this.potionReady = this.t + POTION_COOLDOWN;
    this.c.net.send({ t: 'use', id });
    const m = this.c.player.model;
    m.animator.play('Use_Item', { upper: true, speed: 1.6 });
    this.later(0.35, () => this.c.fx.column(this.c.player.pos.clone(), '#7dff9a', { radius: 0.6, count: 40, dur: 0.4 }));
  }

  // ------------------------------------------------------------------ aiming
  /** The enemy closest to the crosshair, if any is near the line of sight. */
  private softTarget(maxDist: number, cone: number): MonsterEntity | null {
    const cam = this.c.world.camera;
    const origin = cam.position;
    const dir = cam.getTarget().subtract(origin).normalize();
    const me = this.c.player.pos;
    let best: MonsterEntity | null = null;
    let bestScore = Infinity;
    for (const m of this.c.monsters.values()) {
      if (!m.targetable) continue;
      const toMe = Vector3.Distance(m.pos, me);
      if (toMe > maxDist) continue;
      const p = m.pos.add(new Vector3(0, 1 * m.def.scale, 0));
      const v = p.subtract(origin);
      const d = v.length();
      const ang = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(v.scale(1 / d), dir))));
      const allow = cone + Math.atan2(m.def.radius, d);
      if (ang > allow) continue;
      const score = ang + toMe * 0.004;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** Where the crosshair meets the ground (or a point far along it). */
  private groundAim(maxDist: number): Vector3 {
    const cam = this.c.world.camera;
    const origin = cam.position.clone();
    const dir = cam.getTarget().subtract(origin).normalize();
    const g = (x: number, z: number) => this.c.world.groundAt(x, z);
    let prev = origin;
    for (let s = 1; s <= maxDist + 12; s += 1) {
      const p = origin.add(dir.scale(s));
      if (p.y <= g(p.x, p.z)) {
        // refine
        let a = prev;
        let b = p;
        for (let k = 0; k < 6; k++) {
          const mid = Vector3.Center(a, b);
          if (mid.y <= g(mid.x, mid.z)) b = mid;
          else a = mid;
        }
        return b;
      }
      prev = p;
    }
    const far = origin.add(dir.scale(maxDist));
    far.y = g(far.x, far.z);
    return far;
  }

  private aim(skill: SkillDef): { yaw: number; tx: number; tz: number; target: MonsterEntity | null } {
    const me = this.c.player.pos;
    const sh = skill.shape;
    const camFwd = this.c.follow.forward();
    const camYaw = Math.atan2(camFwd.x, camFwd.z);
    if (sh.kind === 'melee' || sh.kind === 'aoe-self' || sh.kind === 'self') {
      const reach = sh.kind === 'melee' ? sh.range + 2.5 : 6;
      const t = this.softTarget(reach, 0.5);
      const yaw = t ? Math.atan2(t.pos.x - me.x, t.pos.z - me.z) : camYaw;
      return { yaw, tx: me.x, tz: me.z, target: t };
    }
    if (sh.kind === 'projectile' || sh.kind === 'aoe-target') {
      const range = sh.range;
      const t = this.softTarget(range + 2, 0.16);
      let tx: number;
      let tz: number;
      if (t) {
        tx = t.pos.x;
        tz = t.pos.z;
      } else {
        const p = this.groundAim(range);
        if (Vector3.Distance(p, me) < 2.5) {
          tx = me.x + camFwd.x * range;
          tz = me.z + camFwd.z * range;
        } else {
          tx = p.x;
          tz = p.z;
        }
      }
      [tx, tz] = clampAim(me.x, me.z, tx, tz, range);
      const yaw = Math.hypot(tx - me.x, tz - me.z) > 0.5 ? Math.atan2(tx - me.x, tz - me.z) : camYaw;
      return { yaw, tx, tz, target: t };
    }
    return { yaw: camYaw, tx: me.x, tz: me.z, target: null };
  }

  // ------------------------------------------------------------------ acting
  private act(k: ActKind, i: number) {
    const ch = this.c.character;
    if (k === 'c') {
      if (this.t > this.comboExpire) this.comboIdx = 0;
      i = this.comboIdx;
    }
    const skill = skillFor(ch.cls, k, i);
    if (!skill) return;
    if (!skillUnlocked(k, i, ch.level)) {
      this.c.hud.toast(`${skill.name} unlocks at level ${SKILL_UNLOCK[i]}.`);
      return;
    }
    if ((this.cooldowns.get(skill.id) ?? 0) > this.t) return;
    const player = this.c.player;
    const model = player.model;
    if (!player.grounded && k !== 'd') return;
    if (skill.cooldown > 0) this.cooldowns.set(skill.id, this.t + skill.cooldown * (k === 'd' ? 1 : 1 - this.stats.cdr));
    this.busyUntil = this.t + skill.lockout;
    if (k === 'c') {
      this.comboIdx = (this.comboIdx + 1) % 3;
      this.comboExpire = this.t + skill.lockout + 0.75;
    }
    if (k === 'd') {
      this.dodge(skill);
      return;
    }
    const a = this.aim(skill);
    const melee = skill.shape.kind === 'melee' || (skill.shape.kind === 'aoe-self' && skill.power > 0);
    player.face(a.yaw, Math.min(skill.lockout, skill.impactAt + 0.15));
    player.commit(skill.lockout * (melee ? 0.9 : 0.75), undefined, melee ? 0.12 : 0.45);
    model.animator.play(skill.anim, { speed: skill.animSpeed ?? 1, upper: melee ? false : undefined, fadeIn: 0.06, fadeOut: 0.2 });
    if (k === 's') this.c.hud.pulse(1 + i);
    this.c.net.send({ t: 'act', k, i, yaw: Math.round(a.yaw * 1000) / 1000, tx: Math.round(a.tx * 100) / 100, tz: Math.round(a.tz * 100) / 100 });
    this.skillFx(model, ch.cls, skill, a.yaw, a.tx, a.tz, true);
  }

  private dodge(skill: SkillDef) {
    const player = this.c.player;
    const model = player.model;
    const cls = this.c.character.cls;
    const fwd = this.c.follow.forward();
    const wish = player.wishDir(this.c.input, this.c.follow);
    const dist = skill.shape.kind === 'dash' ? skill.shape.distance : 5;
    let yaw = player.yaw;
    if (cls === 'arcanist') {
      const dir = wish ?? fwd;
      const from = player.pos.add(new Vector3(0, 1, 0));
      this.c.fx.flash(from, '#b49bff', 2.2, 0.25);
      this.c.fx.burst(from, '#b49bff', { count: 26, speed: 4, size: 0.2, life: 0.45, gravity: 0 });
      player.teleport(dir.x * dist, dir.z * dist);
      yaw = Math.atan2(dir.x, dir.z);
      player.face(yaw, 0.1);
      player.commit(skill.lockout, undefined, 0.3);
      const to = player.pos.add(new Vector3(0, 1, 0));
      this.c.fx.flash(to, '#d4c4ff', 2.6, 0.3);
      this.c.fx.burst(to, '#b49bff', { count: 30, speed: 3, size: 0.22, life: 0.55, gravity: -1 });
      model.animator.play('Spellcast_Raise', { upper: true, speed: 2 });
    } else if (cls === 'ranger') {
      const dir = fwd.scale(-1);
      yaw = Math.atan2(fwd.x, fwd.z);
      player.face(yaw, skill.lockout);
      player.commit(skill.lockout, dir.scale(dist / skill.lockout), 0, false);
      model.animator.play('Dodge_Backward', { upper: false, speed: skill.animSpeed ?? 1.3, fadeIn: 0.04 });
      this.c.fx.dust(player.pos, 8);
    } else {
      const dir = wish ?? fwd;
      yaw = Math.atan2(dir.x, dir.z);
      player.commit(skill.lockout, dir.scale(dist / skill.lockout), 0, true);
      model.animator.play('Dodge_Forward', { upper: false, speed: skill.animSpeed ?? 1.25, fadeIn: 0.04 });
      this.c.fx.dust(player.pos, 10);
      this.later(skill.lockout * 0.8, () => this.c.fx.dust(player.pos, 6));
    }
    this.c.hud.pulse(4);
    this.c.net.send({ t: 'act', k: 'd', i: 0, yaw: Math.round(yaw * 1000) / 1000, tx: 0, tz: 0 });
  }

  /** Someone else used a skill: animate them and show its effect. */
  onRemoteAct(m: Extract<ServerMessage, { t: 'act' }>) {
    if (m.id === this.c.myId) return;
    const r = this.c.remotes.get(m.id);
    if (!r) return;
    const skill = skillFor(r.info.cls, m.k, m.i);
    if (!skill) return;
    const an = r.model.animator;
    if (m.k === 'd') {
      if (r.info.cls === 'arcanist') {
        this.c.fx.flash(r.pos.add(new Vector3(0, 1, 0)), '#b49bff', 2.2, 0.25);
        this.later(0.12, () => this.c.fx.flash(r.pos.add(new Vector3(0, 1, 0)), '#d4c4ff', 2.4, 0.3));
      } else {
        an.play(r.info.cls === 'ranger' ? 'Dodge_Backward' : 'Dodge_Forward', { upper: false, speed: skill.animSpeed ?? 1.25, fadeIn: 0.04 });
        this.c.fx.dust(r.pos, 8);
      }
      return;
    }
    const melee = skill.shape.kind === 'melee' || (skill.shape.kind === 'aoe-self' && skill.power > 0);
    r.model.root.rotation.y = m.yaw;
    an.play(skill.anim, { speed: skill.animSpeed ?? 1, upper: melee ? false : undefined, fadeIn: 0.06 });
    this.skillFx(r.model, r.info.cls, skill, m.yaw, m.tx, m.tz, false);
  }

  private handPos(model: CharacterModel, slot: 'handslot.r' | 'handslot.l', fallbackY = 1.3) {
    const n = model.node(slot);
    if (n) {
      n.computeWorldMatrix(true);
      return n.getAbsolutePosition().clone();
    }
    return model.root.position.add(new Vector3(0, fallbackY, 0));
  }

  /** First live monster near point p (for missile visuals). */
  private monsterAt(p: Vector3, radius: number) {
    for (const m of this.c.monsters.values()) {
      if (!m.targetable) continue;
      const dx = m.pos.x - p.x;
      const dz = m.pos.z - p.z;
      const r = radius + m.def.radius;
      if (dx * dx + dz * dz < r * r && p.y > m.pos.y - 0.3 && p.y < m.pos.y + 2.4 * m.def.scale) return m;
    }
    return null;
  }

  private skillFx(model: CharacterModel, cls: ClassId, skill: SkillDef, yaw: number, tx: number, tz: number, local: boolean) {
    const fx = this.c.fx;
    const col = CLASS_COLORS[cls];
    const at = () => model.root.position.clone();
    const chest = () => at().add(new Vector3(0, 1.0, 0));
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const near = () => Vector3.Distance(at(), this.c.player.pos) < 14;
    const impact = Math.max(0, skill.impactAt - 0.07);
    switch (skill.vfx) {
      case 'slash':
      case 'heavy': {
        const heavy = skill.vfx === 'heavy';
        const step = skill.id === 'combo2' ? 1 : 0;
        this.later(impact, () => {
          fx.slash(chest(), yaw, col.main, { radius: heavy ? 2.4 : 2.0, arc: heavy ? 2.6 : 2.2, tilt: heavy ? 0 : step ? -0.35 : 0.45, reverse: !!step, width: heavy ? 0.95 : 0.75, dur: heavy ? 0.3 : 0.22 });
          if (heavy) {
            fx.dust(at().add(fwd.scale(1.6)), 12);
            if (local) this.c.follow.shake(0.18);
          }
        });
        break;
      }
      case 'bash':
        this.later(impact, () => {
          const p = chest().add(fwd.scale(1.1));
          fx.flash(p, '#ffe1a0', 2.4, 0.22);
          fx.burst(p, '#ffd27a', { count: 26, speed: 6, size: 0.16, life: 0.4, stretch: true });
          fx.ring(at().add(fwd.scale(1.2)), 0.3, 2.6, '#ffe1a0', 0.4);
          if (local) this.c.follow.shake(0.25);
        });
        break;
      case 'whirl':
        this.later(impact - 0.15, () => {
          fx.slash(chest(), yaw, col.main, { radius: 3.2, arc: 5.6, width: 1.2, dur: 0.42, spin: 6.2 });
          fx.slash(at().add(new Vector3(0, 0.7, 0)), yaw + 2, '#fff2d0', { radius: 2.8, arc: 4.8, width: 0.9, dur: 0.38, spin: 5.5 });
          fx.ring(at(), 0.6, 3.8, '#ffe1a0', 0.5);
          fx.dust(at(), 16);
          if (local) this.c.follow.shake(0.22);
        });
        break;
      case 'rally':
        this.later(impact, () => {
          fx.ring(at(), 0.5, 10, '#ffd27a', 0.9);
          fx.column(at(), '#ffd27a', { radius: 1.2, count: 80, dur: 0.7 });
          fx.flash(chest().add(new Vector3(0, 0.6, 0)), '#ffe1a0', 3, 0.35);
        });
        break;
      case 'arrow':
      case 'arrow_heavy':
      case 'arrow_pierce':
      case 'snare': {
        if (skill.shape.kind !== 'projectile') break;
        const sh = skill.shape;
        const tint = skill.vfx === 'arrow_pierce' ? '#8fd8ff' : skill.vfx === 'snare' ? '#7dff8a' : skill.vfx === 'arrow_heavy' ? '#fff2b0' : col.main;
        this.later(skill.impactAt, () => {
          const from = this.handPos(model, 'handslot.l');
          const target = new Vector3(tx, this.c.world.groundAt(tx, tz) + 1.1, tz);
          const flat = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
          const dir = Vector3.Distance(target, from) > 2 ? target.subtract(from).normalize() : flat;
          const hitIds = new Set<number>();
          fx.missile(from, dir, sh.speed, sh.range, 'arrow', tint, (p) => {
            const m = this.monsterAt(p, sh.radius);
            if (!m || hitIds.has(m.id)) return false;
            hitIds.add(m.id);
            fx.burst(p, tint, { count: 14, speed: 4, size: 0.14, life: 0.35, stretch: true });
            if (skill.vfx === 'snare') fx.ring(m.pos, 1.4, 0.6, '#7dff8a', 0.8);
            return !sh.pierce;
          });
          if (skill.vfx === 'arrow_pierce') fx.flash(from, '#8fd8ff', 1.4, 0.2);
        });
        break;
      }
      case 'volley':
        this.later(skill.impactAt * 0.4, () => {
          const r = skill.shape.kind === 'aoe-target' ? skill.shape.radius : 4;
          fx.telegraph(tx, tz, r, skill.impactAt * 0.6, '#9cff8a');
          fx.volley(tx, tz, r, '#e8ffd0', 0);
        });
        break;
      case 'bolt':
      case 'bolt_big': {
        if (skill.shape.kind !== 'projectile') break;
        const sh = skill.shape;
        const big = skill.vfx === 'bolt_big';
        this.later(skill.impactAt, () => {
          const from = this.handPos(model, 'handslot.r', 1.5).add(new Vector3(0, 0.3, 0));
          const target = new Vector3(tx, this.c.world.groundAt(tx, tz) + 1.1, tz);
          const dir = Vector3.Distance(target, from) > 2 ? target.subtract(from).normalize() : fwd;
          fx.flash(from, col.main, big ? 1.6 : 1, 0.15);
          fx.missile(
            from,
            dir,
            sh.speed,
            sh.range,
            'bolt',
            big ? '#d4c4ff' : col.main,
            (p) => !!this.monsterAt(p, sh.radius),
            (p, struck) => {
              fx.burst(p, col.main, { count: big ? 30 : 16, speed: big ? 6 : 4, size: big ? 0.26 : 0.18, life: 0.4, gravity: 0 });
              if (struck && big) fx.ring(new Vector3(p.x, this.c.world.groundAt(p.x, p.z), p.z), 0.3, 2, col.main, 0.4);
            },
          );
        });
        break;
      }
      case 'fireball': {
        this.later(skill.impactAt * 0.55, () => {
          const from = this.handPos(model, 'handslot.r', 1.6).add(new Vector3(0, 0.5, 0));
          const target = new Vector3(tx, this.c.world.groundAt(tx, tz) + 0.2, tz);
          const dist = Vector3.Distance(from, target);
          const travel = Math.max(0.12, skill.impactAt * 0.45);
          fx.missile(from, target.subtract(from).normalize(), dist / travel, dist, 'fire', '#ff8a2a', () => false, (p) => {
            const g = new Vector3(p.x, this.c.world.groundAt(p.x, p.z), p.z);
            fx.flash(g.add(new Vector3(0, 1, 0)), '#ffb04a', 5, 0.35);
            fx.burst(g.add(new Vector3(0, 0.6, 0)), '#ff7a1a', { count: 60, speed: 8, size: 0.5, life: 0.7, color2: '#ffd24a', gravity: -2 });
            fx.burst(g.add(new Vector3(0, 0.3, 0)), '#3a2a20', { count: 18, speed: 2.5, size: 1.2, life: 1.2, additive: false, gravity: -1.5 });
            fx.ring(g, 0.5, skill.shape.kind === 'aoe-target' ? skill.shape.radius + 0.5 : 3.5, '#ff8a2a', 0.5);
            if (Vector3.Distance(g, this.c.player.pos) < 16) this.c.follow.shake(0.3);
          });
        });
        break;
      }
      case 'frost':
        this.later(impact, () => {
          const r = skill.shape.kind === 'aoe-self' ? skill.shape.radius : 6;
          fx.ring(at(), 0.5, r, '#8fe8ff', 0.6, 2.6);
          fx.ring(at(), 0.3, r * 0.7, '#ffffff', 0.45, 1.6);
          fx.burst(at().add(new Vector3(0, 0.4, 0)), '#bff4ff', { count: 70, speed: 9, size: 0.2, life: 0.6, up: 0.1, gravity: 4, stretch: true });
          if (local || near()) this.c.follow.shake(0.15);
        });
        break;
      case 'heal':
        this.later(impact, () => {
          fx.ring(at(), 0.4, 10, '#ffe58a', 0.9);
          fx.column(at(), '#ffe58a', { radius: 1, count: 70, dur: 0.6 });
          fx.flash(chest().add(new Vector3(0, 0.9, 0)), '#fff2b0', 2.6, 0.4);
        });
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ server events
  onMonsterAct(m: Extract<ServerMessage, { t: 'mact' }>) {
    const e = this.c.monsters.get(m.id);
    if (!e) return;
    e.attack(m.a, m.yaw);
    const a = e.def.attacks[m.a];
    if (!a) return;
    const fx = this.c.fx;
    if (a.telegraph) {
      const r = a.kind === 'spin' || a.kind === 'slam' ? a.radius ?? 3 : 1.6;
      fx.telegraph(m.tx, m.tz, r, a.impactAt);
    }
    this.later(a.impactAt, () => {
      if (!e.model || !e.alive) return;
      const base = e.pos.clone();
      const chest = base.add(new Vector3(0, 1.1 * e.def.scale, 0));
      const near = Vector3.Distance(base, this.c.player.pos);
      if (a.kind === 'melee') {
        fx.slash(chest, e.yaw, '#ff9a8a', { radius: 1.6 * Math.max(1, e.def.scale * 0.8), arc: a.arc ?? 1.6, width: 0.6, dur: 0.2, tilt: 0.3 });
      } else if (a.kind === 'slam') {
        const g = new Vector3(m.tx, this.c.world.groundAt(m.tx, m.tz), m.tz);
        fx.ring(g, 0.4, (a.radius ?? 3) + 0.4, '#ff6a4a', 0.5);
        fx.dust(g, 24);
        fx.burst(g.add(new Vector3(0, 0.3, 0)), e.def.id === 'mage' ? '#c47bff' : '#ffb27a', { count: 40, speed: 7, size: 0.25, life: 0.6, gravity: 8, up: 1.2 });
        if (Vector3.Distance(g, this.c.player.pos) < 12) this.c.follow.shake(e.def.boss ? 0.55 : 0.25);
      } else if (a.kind === 'spin') {
        fx.slash(chest, e.yaw, '#ff8a6a', { radius: a.radius ?? 4, arc: 6, width: 1.4, dur: 0.45, spin: 6 });
        fx.dust(base, 20);
        if (near < 10) this.c.follow.shake(0.35);
      } else if (a.kind === 'projectile') {
        const n = e.model.node('handslot.r');
        n?.computeWorldMatrix(true);
        const from = n ? n.getAbsolutePosition().add(new Vector3(0, 0.4, 0)) : chest;
        const to = new Vector3(m.tx, this.c.world.groundAt(m.tx, m.tz) + 1.1, m.tz);
        const me = this.c.player;
        fx.missile(from, to.subtract(from).normalize(), a.projSpeed ?? 15, a.range + 4, 'hex', '#c47bff', (p) => Vector3.DistanceSquared(p, me.pos.add(new Vector3(0, 1, 0))) < 0.8, (p) => fx.burst(p, '#c47bff', { count: 18, speed: 4, size: 0.2, life: 0.4, gravity: 0 }));
      }
    });
  }

  onHits(hits: Hit[]) {
    const { hud, world, myId, player, fx } = this.c;
    for (const [target, amt, flags, src] of hits) {
      if (flags & HIT_PLAYER) {
        const head = target === myId ? player.pos.add(new Vector3(0, 2.1, 0)) : this.c.remotes.get(target)?.pos.add(new Vector3(0, 2.1, 0));
        if (!head) continue;
        if (flags & HIT_HEAL) {
          if (target === myId || src === myId) hud.floatText(world.engine, world.camera, head, `+${amt}`, 'heal');
          continue;
        }
        if (flags & HIT_DODGED) {
          if (target === myId) hud.floatText(world.engine, world.camera, head, 'Dodged', 'miss');
          continue;
        }
        if (target === myId) {
          hud.floatText(world.engine, world.camera, head, `-${amt}`, 'hurt');
          const k = amt / this.maxHp;
          hud.hurt(k);
          this.c.follow.shake(Math.min(0.5, 0.12 + k * 1.2));
          fx.burst(player.pos.add(new Vector3(0, 1.1, 0)), '#ff6b5e', { count: 10, speed: 3, size: 0.12, life: 0.3 });
          const an = player.model.animator;
          if (!an.busy && !this.dead) an.play(Math.random() < 0.5 ? 'Hit_A' : 'Hit_B', { upper: true, speed: 1.3, fadeIn: 0.04 });
        } else {
          const r = this.c.remotes.get(target);
          if (r && !r.model.animator.busy) r.model.animator.play('Hit_A', { upper: true, speed: 1.3 });
        }
        continue;
      }
      const m = this.c.monsters.get(target);
      if (!m) continue;
      m.hit();
      m.lastHurt = performance.now();
      const top = m.pos.add(new Vector3(0, 2.0 * m.def.scale + 0.2, 0));
      if (!(flags & HIT_DOT)) fx.burst(m.pos.add(new Vector3(0, 1.0 * m.def.scale, 0)), flags & HIT_CRIT ? '#ffe28a' : '#ffffff', { count: flags & HIT_CRIT ? 22 : 10, speed: flags & HIT_CRIT ? 7 : 4, size: 0.12, life: 0.3, stretch: true });
      if (src === myId) {
        hud.floatText(world.engine, world.camera, top, String(amt), flags & HIT_CRIT ? 'crit' : flags & HIT_DOT ? 'dot' : 'dmg');
        if (flags & HIT_CRIT) this.c.follow.shake(0.12);
      }
    }
  }

  onKill(id: number) {
    const m = this.c.monsters.get(id);
    if (!m) return;
    this.later(0.25, () => {
      this.c.fx.burst(m.pos.add(new Vector3(0, 0.8 * m.def.scale, 0)), '#cfc6b4', { count: m.def.boss ? 60 : 24, speed: 3, size: 0.5 * m.def.scale, life: 1.1, additive: false, gravity: -0.6, spread: 0.4 * m.def.scale });
      this.c.fx.flash(m.pos.add(new Vector3(0, 1.4 * m.def.scale, 0)), m.def.eyeColor, 1.6 * m.def.scale, 0.4);
    });
  }

  onSelf(s: Extract<ServerMessage, { t: 'me' }>['s']) {
    const ch = this.c.character;
    const hud = this.c.hud;
    ch.hp = s.hp;
    this.maxHp = s.maxHp;
    ch.xp = s.xp;
    ch.level = s.level;
    if (s.inventory) {
      ch.inventory = s.inventory;
      hud.setPotions(s.inventory.filter((i) => i.id === 'potion_small' || i.id === 'potion_large').reduce((n, i) => n + i.qty, 0));
    }
    hud.setHp(s.hp, s.maxHp);
    hud.setXp(s.xp / xpToNext(s.level), s.level);
    hud.setLowHealth(s.hp > 0 && s.hp / s.maxHp < 0.25);
    if (s.gain) {
      const p = this.c.player.pos.add(new Vector3(0, 2.4, 0));
      this.later(0.3, () => hud.floatText(this.c.world.engine, this.c.world.camera, p, `+${s.gain} XP`, 'xp'));
    }
  }

  onLevel(m: Extract<ServerMessage, { t: 'lvl' }>) {
    const fx = this.c.fx;
    if (m.id === this.c.myId) {
      const ch = this.c.character;
      ch.level = m.level;
      this.stats = statsFor(ch.cls, ch.level, ch.equipment);
      this.maxHp = m.maxHp;
      this.c.player.speedMul = this.stats.speed;
      this.c.hud.levelUp(m.level);
      this.c.hud.setUnlocks(m.level);
      this.c.hud.setPlateLevel(this.c.myId, m.level);
      const unlocked = CLASSES[ch.cls].skills.find((_, i) => SKILL_UNLOCK[i] === m.level);
      if (unlocked) this.later(1.2, () => this.c.hud.toast(`New skill: ${unlocked.name} (${unlocked.key})`));
      const passive = CLASSES[ch.cls].passives.find((p) => p.level === m.level);
      if (passive) this.later(2.2, () => this.c.hud.toast(`${passive.name}: ${passive.description}`));
      const at = this.c.player.pos.clone();
      fx.column(at, '#ffd27a', { radius: 1, count: 120, height: 3.5, dur: 1 });
      fx.ring(at, 0.5, 5, '#ffd27a', 1);
    } else {
      const r = this.c.remotes.get(m.id);
      if (!r) return;
      r.info.level = m.level;
      this.c.hud.setPlateLevel(m.id, m.level);
      fx.column(r.pos.clone(), '#ffd27a', { radius: 1, count: 80, dur: 0.8 });
    }
  }

  onDied(by: string) {
    this.dead = true;
    this.queued = null;
    const p = this.c.player;
    p.frozen = true;
    p.model.animator.play('Death_A', { hold: true, upper: false, fadeIn: 0.1 });
    this.c.input.releaseLock();
    this.c.hud.setLowHealth(false);
    this.later(1.4, () => this.c.hud.showDeath(by, () => this.c.net.send({ t: 'respawn' })));
  }

  onRespawned(m: Extract<ServerMessage, { t: 'respawned' }>) {
    this.dead = false;
    const p = this.c.player;
    p.frozen = false;
    p.model.animator.stopAction();
    p.correct(m.x, m.y, m.z);
    p.face(m.yaw, 0.1);
    this.c.follow.yaw = m.yaw;
    this.c.hud.hideDeath();
    this.c.fx.column(p.pos.clone(), '#fff2b0', { radius: 0.9, count: 70, dur: 0.8 });
  }

  onLoot(id: string, qty: number) {
    const it = ITEMS[id];
    if (it) this.c.hud.toast(`Looted ${qty > 1 ? `${qty} × ` : ''}${it.name}`);
  }
}
