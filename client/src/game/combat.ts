// Client side of combat: reads attack input (combo, skills, dodge, potions),
// aims with a soft lock on the enemy nearest the crosshair, plays animations
// and effects immediately (the server decides what actually hits), and shows
// the results: damage numbers, hit reactions, telegraphs, deaths and level ups.
// Melee contact is predicted locally on the swing's contact frame, so the
// hit-stop, the enemy's stagger and the camera punch land with the blade
// instead of a round trip later; the server's verdict then adds the numbers.
import { Vector3 } from '@babylonjs/core';
import {
  CLASSES,
  HIT_CRIT,
  HIT_DODGED,
  HIT_DOT,
  HIT_HEAL,
  HIT_PLAYER,
  ITEMS,
  RARITY_COLORS,
  outfitIndex,
  POTION_COOLDOWN,
  SKILL_UNLOCK,
  clampAim,
  inCone,
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
import { dodgeBeats, playSkillAnim, skillWeight } from '../char/attacks';
import type { CharacterModel } from '../char/model';
import { C, D, type Effects } from '../fx/fx';
import { CLASS_COLORS, playDodgeFx, playSkillFx, type FxWorld } from '../fx/skills';
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

/** Melee blows, and the spinning ones that strike all around. */
function isMelee(skill: SkillDef) {
  return skill.shape.kind === 'melee' || (skill.shape.kind === 'aoe-self' && skill.power > 0);
}

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
  private bagHintShown = false;
  private timers: Timer[] = [];
  private t = 0;
  stats: Stats;
  dead = false;
  /** Called when inventory or equipment changed (to refresh open windows). */
  onInventory: (() => void) | null = null;
  maxHp: number;

  private fxWorld: FxWorld;

  constructor(private c: CombatContext) {
    this.stats = statsFor(c.character.cls, c.character.level, c.character.equipment);
    this.maxHp = this.stats.maxHp;
    c.player.speedMul = this.stats.speed;
    this.fxWorld = {
      groundAt: (x, z) => c.world.groundAt(x, z),
      monsterAt: (p, r) => {
        const m = this.monsterAt(p, r);
        return m ? { id: m.id, pos: m.pos, scale: m.def.scale } : null;
      },
      shake: (k) => c.follow.shake(k),
      playerPos: () => c.player.pos,
    };
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
    this.later(0.35, () => this.c.fx.column(this.c.player.pos.clone(), '#7dff9a', { radius: 0.6, count: 40, dur: 0.4, height: 2 }));
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
    if (player.gliding || (!player.grounded && k !== 'd')) return;
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
    const melee = isMelee(skill);
    player.face(a.yaw, Math.min(skill.lockout, skill.impactAt + 0.15));
    player.commit(skill.lockout * (melee ? 0.9 : 0.75), undefined, melee ? 0.12 : 0.45);
    const tl = playSkillAnim(model.animator, skill, melee ? false : undefined);
    const power = skillWeight(skill);
    const fwd = new Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    if (tl && melee) {
      // step into the swing, stopping short of the enemy it's aimed at
      let dist = skill.vfx === 'bash' ? 0.8 : skill.shape.kind === 'aoe-self' ? 0.3 : 0.25 + 0.35 * power;
      if (a.target) dist = Math.max(0, Math.min(dist + 0.3, Vector3.Distance(a.target.pos, player.pos) - a.target.def.radius - 0.95));
      if (dist > 0.05) this.later(Math.max(0, tl.strikeAt - 0.05), () => player.shove(fwd.x * dist, fwd.z * dist, tl.contactAt - tl.strikeAt + 0.14));
      this.later(tl.contactAt, () => this.contact(model, player.pos, skill, a.yaw, power, true));
    } else if (tl && power >= 0.45 && skill.power > 0) {
      // heavy shots and spells kick back on release
      this.later(tl.contactAt, () => this.c.follow.punch(fwd.scale(-1), power * 0.4));
    }
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
    const fx = this.c.fx;
    if (cls === 'arcanist') {
      const dir = wish ?? fwd;
      const from = player.pos.clone();
      fx.afterimage(model.meshes, '#b49bff', { dur: 0.55, intensity: 2.6 });
      player.teleport(dir.x * dist, dir.z * dist);
      yaw = Math.atan2(dir.x, dir.z);
      player.face(yaw, 0.1);
      player.commit(skill.lockout, undefined, 0.3);
      playDodgeFx(fx, cls, from, player.pos.clone(), yaw);
      model.animator.play('Spellcast_Raise', { upper: true, speed: 2 });
    } else if (cls === 'ranger') {
      const dir = fwd.scale(-1);
      yaw = Math.atan2(fwd.x, fwd.z);
      player.face(yaw, skill.lockout);
      player.commit(skill.lockout, dir.scale(dist / skill.lockout), 0, false);
      model.animator.play('Dodge_Backward', { upper: false, beats: dodgeBeats(skill.lockout), fadeIn: 0.04, cancelAfter: skill.lockout });
      playDodgeFx(fx, cls, player.pos.clone(), null, yaw);
      this.later(skill.lockout * 0.8, () => model.impulse(0.8, 0, 2.2));
    } else {
      const dir = wish ?? fwd;
      yaw = Math.atan2(dir.x, dir.z);
      player.commit(skill.lockout, dir.scale(dist / skill.lockout), 0, true);
      model.animator.play('Dodge_Forward', { upper: false, beats: dodgeBeats(skill.lockout), fadeIn: 0.04, cancelAfter: skill.lockout });
      playDodgeFx(fx, cls, player.pos.clone(), null, yaw);
      this.later(skill.lockout * 0.8, () => {
        fx.dust(player.pos, 6);
        // land low and come up out of it
        model.impulse(-0.6, 0, 2.6);
      });
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
      const from = r.pos.clone();
      if (r.info.cls === 'arcanist') {
        this.c.fx.afterimage(r.model.meshes, '#b49bff', { dur: 0.55, intensity: 2.6 });
        this.later(0.12, () => playDodgeFx(this.c.fx, 'arcanist', from, r.pos.clone(), m.yaw));
      } else {
        an.play(r.info.cls === 'ranger' ? 'Dodge_Backward' : 'Dodge_Forward', { upper: false, beats: dodgeBeats(skill.lockout), fadeIn: 0.04, cancelAfter: skill.lockout });
        playDodgeFx(this.c.fx, r.info.cls, from, null, m.yaw);
        this.later(skill.lockout * 0.8, () => r.model.impulse(r.info.cls === 'ranger' ? 0.8 : -0.6, 0, 2.4));
      }
      return;
    }
    const melee = isMelee(skill);
    r.model.root.rotation.y = m.yaw;
    const tl = playSkillAnim(an, skill, melee ? false : undefined);
    if (tl && melee) this.later(tl.contactAt, () => this.contact(r.model, r.pos, skill, m.yaw, skillWeight(skill), false));
    // effects of far-away players are not worth their cost
    if (Vector3.DistanceSquared(r.pos, this.c.player.pos) < 80 * 80) this.skillFx(r.model, r.info.cls, skill, m.yaw, m.tx, m.tz, false);
  }

  /**
   * A melee swing reaches its contact frame: whatever it would strike reels
   * now (the server confirms with damage a moment later), and the swing
   * freezes for a beat on the impact.
   */
  private contact(caster: CharacterModel, at: Vector3, skill: SkillDef, yaw: number, power: number, local: boolean) {
    const sh = skill.shape;
    const pos = at.clone();
    let struck = 0;
    const stop = 0.045 + 0.075 * power;
    for (const m of this.c.monsters.values()) {
      if (!m.targetable) continue;
      const hit =
        sh.kind === 'melee'
          ? inCone(pos.x, pos.z, yaw, m.pos.x, m.pos.z, sh.range, sh.arc, m.def.radius)
          : sh.kind === 'aoe-self'
            ? Vector3.Distance(m.pos, pos) < sh.radius + m.def.radius
            : false;
      if (!hit) continue;
      const dir = m.pos.subtract(pos);
      dir.y = 0;
      if (dir.lengthSquared() < 1e-6) dir.set(Math.sin(yaw), 0, Math.cos(yaw));
      m.react(dir.normalize(), power);
      struck++;
    }
    if (!struck) return;
    caster.animator.hitstop(stop);
    if (local) {
      const f = this.c.follow;
      f.shake(0.07 + 0.14 * power + Math.min(0.08, (struck - 1) * 0.03));
      f.punch(new Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 0.35 + 0.55 * power);
    }
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
    playSkillFx(this.c.fx, this.fxWorld, model, cls, skill, yaw, tx, tz, local);
  }

  // ------------------------------------------------------------------ server events
  onMonsterAct(m: Extract<ServerMessage, { t: 'mact' }>) {
    const e = this.c.monsters.get(m.id);
    if (!e) return;
    e.attack(m.a, m.yaw);
    const a = e.def.attacks[m.a];
    if (!a) return;
    const fx = this.c.fx;
    const magic = e.def.id === 'mage';
    if (a.telegraph) {
      const r = a.kind === 'spin' || a.kind === 'slam' ? a.radius ?? 3 : 1.6;
      fx.telegraph(m.tx, m.tz, r, a.impactAt, magic ? '#b45cff' : '#ff3b2f', magic ? D.hex : D.telegraph);
    }
    if (a.kind === 'melee' || a.kind === 'spin') {
      const hand = e.model?.node('handslot.r');
      fx.weaponTrail(hand, a.kind === 'spin' ? '#ff6a4a' : '#ff7a5a', Math.max(0, a.impactAt - (a.kind === 'spin' ? 0.35 : 0.22)), a.kind === 'spin' ? 0.6 : 0.3, { intensity: 0.9 });
    }
    if (a.kind === 'projectile' || (a.kind === 'slam' && magic)) {
      const hand = e.model?.node('handslot.r');
      if (hand) {
        hand.computeWorldMatrix(true);
        fx.after(0.05, () => fx.gather(hand.getAbsolutePosition().add(new Vector3(0, 0.3, 0)), '#c47bff', Math.max(0.15, a.impactAt - 0.1), 12, 0.9));
      }
      const g = e.pos;
      fx.magicCircle(new Vector3(g.x, this.c.world.groundAt(g.x, g.z), g.z), '#b45cff', { radius: 1.3 * e.def.scale, dur: a.impactAt + 0.3, cell: D.hex, spin: 1.5, intensity: 2, drift: 0 });
    }
    this.later(a.impactAt, () => {
      if (!e.model || !e.alive) return;
      const base = e.pos.clone();
      const chest = base.add(new Vector3(0, 1.1 * e.def.scale, 0));
      const near = Vector3.Distance(base, this.c.player.pos);
      if (a.kind === 'melee') {
        fx.slash(chest, e.yaw, '#ff6a4a', { radius: 1.6 * Math.max(1, e.def.scale * 0.8), arc: a.arc ?? 1.6, width: 0.65, dur: 0.24, tilt: 0.3, intensity: 0.9 });
        if (e.def.boss) fx.dust(base.add(new Vector3(Math.sin(e.yaw), 0, Math.cos(e.yaw)).scale(1.6)), 8);
      } else if (a.kind === 'slam') {
        const g = new Vector3(m.tx, this.c.world.groundAt(m.tx, m.tz), m.tz);
        fx.slam(g, a.radius ?? 3, magic ? '#c47bff' : '#ff8a4a', !!e.def.boss);
        if (Vector3.Distance(g, this.c.player.pos) < 12) this.c.follow.shake(e.def.boss ? 0.55 : 0.25);
      } else if (a.kind === 'spin') {
        fx.whirlwind(base, e.yaw, '#ff5a3a', a.radius ?? 4);
        if (near < 10) this.c.follow.shake(0.35);
      } else if (a.kind === 'projectile') {
        const n = e.model.node('handslot.r');
        n?.computeWorldMatrix(true);
        const from = n ? n.getAbsolutePosition().add(new Vector3(0, 0.4, 0)) : chest;
        const to = new Vector3(m.tx, this.c.world.groundAt(m.tx, m.tz) + 1.1, m.tz);
        const me = this.c.player;
        fx.flash(from, '#c47bff', 1.2, 0.18);
        fx.missile(from, to.subtract(from).normalize(), a.projSpeed ?? 15, a.range + 4, 'hex', '#c47bff', (p) => Vector3.DistanceSquared(p, me.pos.add(new Vector3(0, 1, 0))) < 0.8, (p) => fx.arcaneBurst(p, '#c47bff', false, false));
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
          fx.impact(player.pos.add(new Vector3(0, 1.1, 0)), '#ff4a3a', { scale: 0.7 + Math.min(0.6, k * 3) });
          const by = this.c.monsters.get(src);
          const dir = by ? player.pos.subtract(by.pos) : null;
          if (dir) {
            dir.y = 0;
            dir.normalize();
            this.c.follow.punch(dir, Math.min(0.6, 0.2 + k * 2));
          }
          // the body reels even mid-swing; the hit clip plays when it is free
          if (!this.dead) player.model.flinch(dir, Math.min(1, 0.35 + k * 3));
          const an = player.model.animator;
          if (!an.busy && !this.dead) an.play(Math.random() < 0.5 ? 'Hit_A' : 'Hit_B', { upper: true, speed: 1.3, fadeIn: 0.04 });
        } else {
          const r = this.c.remotes.get(target);
          if (r) {
            const by = this.c.monsters.get(src);
            const dir = by ? r.pos.subtract(by.pos) : null;
            if (dir) {
              dir.y = 0;
              dir.normalize();
            }
            if (!r.dead) r.model.flinch(dir, 0.6);
            if (!r.model.animator.busy) r.model.animator.play('Hit_A', { upper: true, speed: 1.3 });
          }
        }
        continue;
      }
      const m = this.c.monsters.get(target);
      if (!m) continue;
      m.lastHurt = performance.now();
      const top = m.pos.add(new Vector3(0, 2.0 * m.def.scale + 0.2, 0));
      const body = m.pos.add(new Vector3(0, 1.0 * m.def.scale, 0));
      const from = src === myId ? player.pos : this.c.remotes.get(src)?.pos;
      if (flags & HIT_DOT) m.model?.flash();
      else {
        const away = from ? m.pos.subtract(from) : null;
        if (away) {
          away.y = 0;
          away.normalize();
        }
        m.hit(away, flags & HIT_CRIT ? 0.85 : 0.5);
      }
      if (flags & HIT_DOT) {
        // burning: a lick of flame and a few embers
        fx.sprite(body.add(new Vector3((Math.random() - 0.5) * 0.4, -0.2, (Math.random() - 0.5) * 0.4)), { v: new Vector3(0, 1.6, 0), dur: 0.5, size: 0.35 * m.def.scale, size1: 0.1, cell: 9, color: C('#ff8a2a', 2.8), mode: 3, hot: 1 });
        fx.sparks(body, C('#ffb04a', 3.5), { n: 4, speed: 3, up: 0.9, gravity: -1, dur: 0.6, size: 0.03 });
      } else {
        const src0 = src === myId ? player.pos : this.c.remotes.get(src)?.pos;
        const dir = src0 ? body.subtract(src0.add(new Vector3(0, 1, 0))).normalize() : undefined;
        fx.impact(body, src0 && src === myId ? CLASS_COLORS[this.c.character.cls].hit : '#ffffff', { crit: !!(flags & HIT_CRIT), dir, scale: Math.max(0.9, m.def.scale * 0.85) });
      }
      if (src === myId) {
        hud.floatText(world.engine, world.camera, top, String(amt), flags & HIT_CRIT ? 'crit' : flags & HIT_DOT ? 'dot' : 'dmg');
        if (flags & HIT_CRIT) this.c.follow.shake(0.12);
      }
    }
  }

  onKill(id: number) {
    const m = this.c.monsters.get(id);
    if (!m) return;
    const away = m.pos.subtract(this.c.player.pos);
    away.y = 0;
    m.killed(away.lengthSquared() > 1e-4 && away.lengthSquared() < 400 ? away.normalize() : null);
    this.later(0.25, () => {
      this.c.fx.soulRelease(m.pos.clone(), m.def.scale, m.def.eyeColor, m.model?.meshes);
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
    if (s.equipment) {
      ch.equipment = s.equipment;
      this.stats = statsFor(ch.cls, ch.level, ch.equipment);
      this.c.player.speedMul = this.stats.speed;
      const model = this.c.player.model;
      model.setLook({ appearance: { ...ch.appearance, outfit: outfitIndex(ch.equipment, ch.appearance.outfit) }, cls: ch.cls, weapon: ch.equipment.weapon, offhand: ch.equipment.offhand });
      model.setShadowCaster((m) => this.c.world.atmosphere.addShadowCaster(m, false));
      this.c.fx.column(this.c.player.pos.clone(), '#fff2b0', { radius: 0.7, count: 30, dur: 0.3 });
    }
    if (s.inventory || s.equipment) this.onInventory?.();
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
      fx.levelUp(at);
    } else {
      const r = this.c.remotes.get(m.id);
      if (!r) return;
      r.info.level = m.level;
      this.c.hud.setPlateLevel(m.id, m.level);
      fx.levelUp(r.pos.clone());
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
    this.c.fx.column(p.pos.clone(), '#fff2b0', { radius: 0.9, count: 70, dur: 0.8, height: 3 });
    this.c.fx.magicCircle(p.pos.clone(), '#fff2b0', { radius: 1.6, dur: 1.6, cell: D.ascend, spin: 0.8, intensity: 2 });
  }

  onLoot(id: string, qty: number) {
    const it = ITEMS[id];
    if (!it) return;
    this.c.hud.lootToast(it.name, RARITY_COLORS[it.rarity], qty);
    if (it.rarity !== 'common') {
      const p = this.c.player.pos.clone();
      this.c.fx.lootBeam(p, RARITY_COLORS[it.rarity], it.rarity === 'epic');
      if (it.kind !== 'consumable' && !this.bagHintShown) {
        this.bagHintShown = true;
        this.later(1, () => this.c.hud.toast('Press I to open your inventory.'));
      }
    }
  }

  /** Another player's gear changed: rebuild their model. */
  onLook(m: Extract<ServerMessage, { t: 'look' }>) {
    const r = this.c.remotes.get(m.id);
    if (!r) return;
    r.info.weapon = m.weapon;
    r.info.offhand = m.offhand;
    r.info.appearance = { ...r.info.appearance, outfit: m.outfit };
    r.model.setLook({ appearance: r.info.appearance, cls: r.info.cls, weapon: m.weapon, offhand: m.offhand });
    r.model.setShadowCaster((mm) => this.c.world.atmosphere.addShadowCaster(mm, false));
  }
}
