// Client-side monsters: snapshot interpolation (like other players), state
// driven animation (rising, attacking, staggered, dying) and hit reactions.
import { Vector3 } from '@babylonjs/core';
import { INTERP_DELAY_MS, MONSTERS, MONSTER_IDS, MonsterState, type MonsterDef, type SnapMonster } from '@kelia/shared';
import type { MonsterModel } from '../char/monsterModel';
import { wrap } from './player';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  st: MonsterState;
  hp: number;
}

export class MonsterEntity {
  readonly def: MonsterDef;
  private buf: Sample[] = [];
  readonly pos = new Vector3();
  private prevPos = new Vector3();
  yaw = 0;
  state = MonsterState.Idle;
  hpFrac = 1;
  private vel = new Vector3();
  private lastState: MonsterState | null = null;
  lastSeen = 0;
  /** performance.now() of the last time it was hit (shows its health bar). */
  lastHurt = 0;
  /** Seconds since death (for sinking into the ground). */
  private deadT = 0;
  model: MonsterModel | null = null;
  private attackUntil = 0;

  constructor(readonly id: number, kind: number) {
    this.def = MONSTERS[MONSTER_IDS[kind]];
  }

  push(ts: number, m: SnapMonster) {
    const s: Sample = { t: ts, x: m[2], y: m[3], z: m[4], yaw: m[5], st: m[6] as MonsterState, hp: m[7] / 255 };
    if (this.buf.length && ts <= this.buf[this.buf.length - 1].t) return;
    if (!this.buf.length) {
      this.pos.set(s.x, s.y, s.z);
      this.prevPos.copyFrom(this.pos);
      this.yaw = s.yaw;
      this.state = s.st;
      this.hpFrac = s.hp;
    }
    this.buf.push(s);
    if (this.buf.length > 30) this.buf.splice(0, this.buf.length - 30);
  }

  get alive() {
    return this.state !== MonsterState.Dead;
  }

  /** Can be hit right now (as far as the client knows). */
  get targetable() {
    return this.state !== MonsterState.Dead && this.state !== MonsterState.Rising;
  }

  update(dt: number, serverNow: number) {
    const rt = serverNow - INTERP_DELAY_MS;
    const b = this.buf;
    if (b.length) {
      while (b.length >= 2 && b[1].t <= rt) b.shift();
      const a = b[0];
      const c = b[1];
      let x = a.x, y = a.y, z = a.z, yaw = a.yaw;
      if (c && rt > a.t) {
        const f = Math.min(1, (rt - a.t) / (c.t - a.t));
        x = a.x + (c.x - a.x) * f;
        y = a.y + (c.y - a.y) * f;
        z = a.z + (c.z - a.z) * f;
        yaw = a.yaw + wrap(c.yaw - a.yaw) * f;
        this.state = f < 0.5 ? a.st : c.st;
        this.hpFrac = c.hp;
      } else {
        this.state = a.st;
        this.hpFrac = a.hp;
      }
      const far = (this.pos.x - x) ** 2 + (this.pos.z - z) ** 2 > 36;
      this.prevPos.copyFrom(this.pos);
      this.pos.set(x, y, z);
      if (far) this.prevPos.copyFrom(this.pos);
      this.yaw = yaw;
    }
    if (dt > 0) {
      const k = 1 - Math.exp(-dt * 12);
      this.vel.x += ((this.pos.x - this.prevPos.x) / dt - this.vel.x) * k;
      this.vel.z += ((this.pos.z - this.prevPos.z) / dt - this.vel.z) * k;
    }
    const m = this.model;
    if (!m) return;
    this.animate(dt);
    m.root.position.copyFrom(this.pos);
    if (this.state === MonsterState.Dead) {
      this.deadT += dt;
      if (this.deadT > 4) m.root.position.y -= Math.min(1.6, (this.deadT - 4) * 0.5);
    } else this.deadT = 0;
    m.root.rotation.y = this.yaw;
    m.update(dt, this.state === MonsterState.Dead || this.state === MonsterState.Attack ? Vector3.Zero() : this.vel);
  }

  private animate(dt: number) {
    void dt;
    const an = this.model!.animator;
    if (this.state === this.lastState) return;
    const prev = this.lastState;
    this.lastState = this.state;
    if (this.state === MonsterState.Dead) an.play(an.has('Death_C_Skeletons') ? 'Death_C_Skeletons' : 'Death_A', { hold: true, upper: false, fadeIn: 0.1 });
    else if (this.state === MonsterState.Rising) an.play('Spawn_Ground_Skeletons', { upper: false, fadeIn: 0.01, hold: false });
    else if (this.state === MonsterState.Stunned) an.play('Hit_B', { upper: false, loop: true, speed: 0.45 });
    else if (prev === MonsterState.Stunned || prev === MonsterState.Dead) an.stopAction();
  }

  /** Server says this monster begins an attack. */
  attack(idx: number, yaw: number) {
    const a = this.def.attacks[idx];
    if (!a || !this.model) return 0;
    this.yaw = yaw;
    const d = this.model.animator.play(a.anim, { speed: a.speed ?? 1, upper: false, fadeIn: 0.08 });
    this.attackUntil = performance.now() + d * 1000;
    return d;
  }

  hit() {
    this.model?.flash();
    const an = this.model?.animator;
    if (an && this.state !== MonsterState.Dead && this.state !== MonsterState.Stunned && performance.now() > this.attackUntil && !an.busy) {
      an.play('Hit_A', { upper: true, speed: 1.4, fadeIn: 0.04 });
    }
  }

  dispose() {
    this.model?.dispose();
    this.model = null;
  }
}
