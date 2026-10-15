// Other players: snapshot interpolation (rendered INTERP_DELAY_MS in the
// past), with velocity derived from the interpolated path so animation speed
// matches what you see, plus emotes and state-driven one-shots.
import { Vector3 } from '@babylonjs/core';
import { INTERP_DELAY_MS, MoveState, type PublicCharacter, type SnapEntity } from '@kelia/shared';
import type { CharacterModel } from '../char/model';
import { wrap } from './player';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  st: MoveState;
  hp: number;
}

export class RemotePlayer {
  private buf: Sample[] = [];
  readonly pos = new Vector3();
  private prevPos = new Vector3();
  yaw = 0;
  private prevYaw = 0;
  state = MoveState.Idle;
  hpFrac = 1;
  private vel = new Vector3();
  private initialized = false;
  private lastState = MoveState.Idle;
  dead = false;

  constructor(public info: PublicCharacter, readonly model: CharacterModel) {}

  push(ts: number, e: SnapEntity) {
    const s: Sample = { t: ts, x: e[1], y: e[2], z: e[3], yaw: e[4], st: e[5] as MoveState, hp: e[6] / 255 };
    if (this.buf.length && ts <= this.buf[this.buf.length - 1].t) return;
    this.buf.push(s);
    if (this.buf.length > 40) this.buf.splice(0, this.buf.length - 40);
    if (!this.initialized) {
      this.initialized = true;
      this.pos.set(s.x, s.y, s.z);
      this.prevPos.copyFrom(this.pos);
      this.yaw = this.prevYaw = s.yaw;
    }
  }

  update(dt: number, serverNow: number) {
    const rt = serverNow - INTERP_DELAY_MS;
    const b = this.buf;
    if (b.length) {
      // drop samples we no longer need (keep one before rt)
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
      } else if (!c) {
        // starved: hold position (no extrapolation past 250 ms)
        this.state = a.st;
        this.hpFrac = a.hp;
      }
      // big jumps (teleports, corrections) snap instead of sliding
      const far = (this.pos.x - x) ** 2 + (this.pos.z - z) ** 2 > 25;
      this.prevPos.copyFrom(this.pos);
      this.pos.set(x, y, z);
      if (far) this.prevPos.copyFrom(this.pos);
      this.prevYaw = this.yaw;
      this.yaw = yaw;
    }
    if (dt > 0) {
      const k = 1 - Math.exp(-dt * 12);
      this.vel.x += ((this.pos.x - this.prevPos.x) / dt - this.vel.x) * k;
      this.vel.z += ((this.pos.z - this.prevPos.z) / dt - this.vel.z) * k;
    }
    const turnRate = wrap(this.yaw - this.prevYaw) / Math.max(dt, 1e-4);
    this.model.root.position.copyFrom(this.pos);
    this.model.root.rotation.y = this.yaw;

    // state transitions
    if (this.state !== this.lastState) {
      const an = this.model.animator;
      if (this.state === MoveState.Dead) an.play('Death_A', { hold: true, upper: false });
      if (this.lastState === MoveState.Dead) an.stopAction();
      if (this.state === MoveState.Dead) this.dead = true;
      else if (this.lastState === MoveState.Dead) this.dead = false;
      if (this.lastState === MoveState.Air && this.state !== MoveState.Air) an.play('Jump_Land', { speed: 1.4, upper: false, fadeIn: 0.05 });
      if (this.lastState === MoveState.Sit) an.stopAction();
      this.lastState = this.state;
    }
    this.model.update(dt, this.vel, turnRate, this.state === MoveState.Air);
  }

  emote(e: string) {
    const an = this.model.animator;
    if (e === 'wave') an.play('Interact', { upper: true });
    else if (e === 'cheer') an.play('Cheer', { upper: false });
    else if (e === 'dance') an.play('Cheer', { upper: false, speed: 1.6, loop: true });
    else if (e === 'sit') an.play('Sit_Floor_Down', { upper: false, onEnd: () => an.play('Sit_Floor_Idle', { loop: true, upper: false }) });
  }

  dispose() {
    this.model.dispose();
  }
}
