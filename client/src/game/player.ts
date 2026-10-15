// The local player's movement: camera-relative WASD with acceleration and
// smooth turning, run/walk/sprint, jumping with coyote time, terrain and
// obstacle collision, wading, and 20 Hz position reports to the server.
import { Vector3 } from '@babylonjs/core';
import {
  GRAVITY,
  JUMP_VELOCITY,
  MAX_WADE_DEPTH,
  MoveState,
  RUN_SPEED,
  SPRINT_SPEED,
  TICK_MS,
  WALK_SPEED,
  WORLD_HALF,
  q,
  waterAt,
  type ClientMessage,
} from '@kelia/shared';
import type { CharacterModel } from '../char/model';
import type { Collider } from '../world/foliage';
import type { FollowCamera } from './camera';
import type { Input } from './input';

export interface PlayerEnv {
  groundAt(x: number, z: number): number;
  colliders(x: number, z: number, out: Collider[]): Collider[];
  send(msg: ClientMessage): void;
}

const CHAR_RADIUS = 0.42;

export class LocalPlayer {
  pos = new Vector3();
  vel = new Vector3();
  yaw = Math.PI;
  private vy = 0;
  grounded = true;
  private coyote = 0;
  private jumpBuffer = 0;
  walkMode = false;
  state = MoveState.Idle;
  private seq = 0;
  private sendAcc = 0;
  private lastYaw = Math.PI;
  turnRate = 0;
  sprinting = false;
  frozen = false;
  /** Seconds of input lock (attacks, dodges) and forced velocity during them. */
  private lockT = 0;
  private dash: Vector3 | null = null;
  private tmpCol: Collider[] = [];
  /** Extra multiplier from passives/items. */
  speedMul = 1;
  onLand: ((fallSpeed: number) => void) | null = null;
  onJump: (() => void) | null = null;

  constructor(readonly model: CharacterModel, private env: PlayerEnv) {}

  spawn(x: number, y: number, z: number, yaw: number) {
    this.pos.set(x, Math.max(y, this.env.groundAt(x, z)), z);
    this.yaw = yaw;
    this.lastYaw = yaw;
    this.vel.setAll(0);
    this.vy = 0;
    this.syncModel();
  }

  /** Server says we're somewhere else. */
  correct(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.setAll(0);
    this.vy = 0;
  }

  /** Lock movement for an action, optionally sliding with a velocity (dodges). */
  commit(seconds: number, dash?: Vector3) {
    this.lockT = Math.max(this.lockT, seconds);
    this.dash = dash ?? null;
  }

  get locked() {
    return this.lockT > 0;
  }

  update(dt: number, input: Input, cam: FollowCamera) {
    const env = this.env;
    if (input.pressedKey('KeyZ') || input.pressedKey('NumpadDivide')) this.walkMode = !this.walkMode;

    // ---- desired horizontal velocity
    let ix = 0;
    let iz = 0;
    if (!this.frozen) {
      if (input.key('KeyW') || input.key('ArrowUp')) iz += 1;
      if (input.key('KeyS') || input.key('ArrowDown')) iz -= 1;
      if (input.key('KeyD') || input.key('ArrowRight')) ix += 1;
      if (input.key('KeyA') || input.key('ArrowLeft')) ix -= 1;
      // both mouse buttons = run forward (classic MMO)
      if (input.mouseButtons.has(0) && input.mouseButtons.has(2)) iz = 1;
    }
    const fwd = cam.forward();
    const right = new Vector3(fwd.z, 0, -fwd.x);
    const wish = fwd.scale(iz).add(right.scale(ix));
    const wishLen = wish.length();
    if (wishLen > 1e-3) wish.scaleInPlace(1 / wishLen);
    const backpedal = iz < 0 && ix === 0;
    this.sprinting = !this.walkMode && !backpedal && wishLen > 0 && (input.key('ShiftLeft') || input.key('ShiftRight'));
    let speed = this.walkMode ? WALK_SPEED : this.sprinting ? SPRINT_SPEED : RUN_SPEED;
    if (backpedal) speed = Math.min(speed, WALK_SPEED * 1.25);

    // water slows you down; too deep pushes you back
    const w = waterAt(this.pos.x, this.pos.z);
    const ground = env.groundAt(this.pos.x, this.pos.z);
    const depth = w > -Infinity ? w - ground : 0;
    const wading = depth > 0.25;
    if (wading) speed *= Math.max(0.4, 1 - depth * 0.45);
    speed *= this.speedMul;

    this.lockT = Math.max(0, this.lockT - dt);
    const target = wish.scale(wishLen > 0 ? speed : 0);
    if (this.lockT > 0) {
      target.setAll(0);
      if (this.dash) target.copyFrom(this.dash);
    } else this.dash = null;

    const accel = this.grounded ? (wishLen > 0 ? 14 : 18) : 3.5;
    const k = 1 - Math.exp(-dt * (this.dash ? 30 : accel));
    this.vel.x += (target.x - this.vel.x) * k;
    this.vel.z += (target.z - this.vel.z) * k;

    // ---- facing: towards movement (backpedal keeps facing forward)
    let wantYaw = this.yaw;
    if (this.dash) wantYaw = Math.atan2(this.dash.x, this.dash.z);
    else if (wishLen > 0) wantYaw = backpedal ? Math.atan2(fwd.x, fwd.z) : Math.atan2(wish.x, wish.z);
    const dy = wrap(wantYaw - this.yaw);
    const turnK = 1 - Math.exp(-dt * (this.grounded ? 12 : 5));
    this.yaw = wrap(this.yaw + dy * turnK);
    this.turnRate = wrap(this.yaw - this.lastYaw) / Math.max(dt, 1e-4);
    this.lastYaw = this.yaw;

    // ---- jump & gravity
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = input.pressedKey('Space') ? 0.15 : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.lockT <= 0 && !this.frozen) {
      this.vy = JUMP_VELOCITY;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.onJump?.();
    }
    this.vy -= GRAVITY * dt;

    // ---- integrate with collision
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const next = new Vector3(nx, this.pos.y + this.vy * dt, nz);
    // obstacles: push out of circles
    for (const c of env.colliders(next.x, next.z, this.tmpCol)) {
      const dx = next.x - c.x;
      const dz = next.z - c.z;
      const r = c.r + CHAR_RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        next.x = c.x + (dx / d) * r;
        next.z = c.z + (dz / d) * r;
      }
    }
    // steep slopes: don't climb faster than ~50°
    const g0 = env.groundAt(this.pos.x, this.pos.z);
    let g1 = env.groundAt(next.x, next.z);
    const run = Math.hypot(next.x - this.pos.x, next.z - this.pos.z);
    if (this.grounded && run > 1e-4 && (g1 - g0) / run > 1.25) {
      next.x = this.pos.x;
      next.z = this.pos.z;
      g1 = g0;
    }
    // deep water: back to the shore
    const wn = waterAt(next.x, next.z);
    if (wn > -Infinity && wn - g1 > MAX_WADE_DEPTH) {
      next.x = this.pos.x;
      next.z = this.pos.z;
      g1 = g0;
      this.vel.scaleInPlace(0.3);
    }
    const lim = WORLD_HALF - 8;
    next.x = Math.max(-lim, Math.min(lim, next.x));
    next.z = Math.max(-lim, Math.min(lim, next.z));
    const wasGrounded = this.grounded;
    if (next.y <= g1 + 0.001) {
      if (!wasGrounded && this.vy < -2) this.onLand?.(-this.vy);
      next.y = g1;
      this.vy = 0;
      this.grounded = true;
    } else if (wasGrounded && next.y - g1 < 0.45 && this.vy <= 0) {
      // stick to the ground going downhill
      next.y = g1;
      this.vy = 0;
    } else {
      this.grounded = false;
    }
    // recompute actual velocity (after collisions) for animation
    if (dt > 0) {
      this.vel.x = (next.x - this.pos.x) / dt;
      this.vel.z = (next.z - this.pos.z) / dt;
    }
    this.pos.copyFrom(next);

    // ---- state for the network / animation
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (!this.grounded) this.state = MoveState.Air;
    else if (this.dash) this.state = MoveState.Dodge;
    else if (wading && sp > 0.3) this.state = MoveState.Wade;
    else if (sp < 0.3) this.state = MoveState.Idle;
    else if (sp < 3.4) this.state = MoveState.Walk;
    else if (sp < 6.5) this.state = MoveState.Run;
    else this.state = MoveState.Sprint;

    this.syncModel();
    this.model.update(dt, this.vel, this.turnRate, !this.grounded);

    // ---- network
    this.sendAcc += dt * 1000;
    if (this.sendAcc >= TICK_MS) {
      this.sendAcc %= TICK_MS;
      env.send({ t: 'mv', x: q(this.pos.x), y: q(this.pos.y), z: q(this.pos.z), yaw: Math.round(this.yaw * 1000) / 1000, st: this.state, seq: ++this.seq });
    }
  }

  private syncModel() {
    this.model.root.position.copyFrom(this.pos);
    this.model.root.rotation.y = this.yaw;
  }
}

export function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
