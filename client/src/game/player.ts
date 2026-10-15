// The local player's movement: mouse-aimed WASD (the character faces where the
// camera looks; W runs that way, A/D strafe, S backpedals) with acceleration, run/walk/sprint, jumping with coyote time, terrain and
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
  /** Standing still and turning in place to catch up with the camera. */
  private idleTurn = false;
  sprinting = false;
  frozen = false;
  /** Seconds of input lock (attacks, dodges) and forced velocity during them. */
  private lockT = 0;
  private dash: Vector3 | null = null;
  private moveScale = 0;
  private faceDash = true;
  private faceT = 0;
  private faceYaw = 0;
  private tmpCol: Collider[] = [];
  /** A short burst of extra motion (attack lunges), easing out over its time. */
  private shoveV = new Vector3();
  private shoveT = 0;
  private shoveDur = 0;
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

  /**
   * Commit to an action for `seconds`: movement is scaled by `moveScale`
   * (0 = rooted), or replaced by a dash velocity (dodges).
   */
  commit(seconds: number, dash?: Vector3, moveScale = 0, faceDash = true) {
    this.lockT = Math.max(this.lockT, seconds);
    this.dash = dash ?? null;
    this.moveScale = moveScale;
    this.faceDash = faceDash;
  }

  /** Carry the body (dx, dz) metres over `seconds`, fast at first (a lunge into a swing). */
  shove(dx: number, dz: number, seconds: number) {
    this.shoveDur = this.shoveT = Math.max(0.02, seconds);
    // linear ease-out: covers v0 · T / 2
    this.shoveV.set((dx * 2) / this.shoveDur, 0, (dz * 2) / this.shoveDur);
  }

  /** Turn to face `yaw` now and hold it for `seconds` (aiming). */
  face(yaw: number, seconds: number) {
    this.faceYaw = yaw;
    this.faceT = seconds;
    this.yaw = yaw;
    this.lastYaw = yaw;
  }

  /** Instant move along (dx, dz), stopping early at water, cliffs or obstacles. */
  teleport(dx: number, dz: number) {
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / 0.25);
    let x = this.pos.x;
    let z = this.pos.z;
    let g = this.env.groundAt(x, z);
    for (let i = 1; i <= steps; i++) {
      const nx = this.pos.x + (dx * i) / steps;
      const nz = this.pos.z + (dz * i) / steps;
      const ng = this.env.groundAt(nx, nz);
      const w = waterAt(nx, nz);
      if (ng - g > 0.6 || (w > -Infinity && w - ng > MAX_WADE_DEPTH)) break;
      if (this.env.colliders(nx, nz, this.tmpCol).some((c) => (nx - c.x) ** 2 + (nz - c.z) ** 2 < (c.r + CHAR_RADIUS) ** 2)) break;
      x = nx;
      z = nz;
      g = ng;
    }
    this.pos.set(x, Math.max(g, this.pos.y), z);
    this.vel.setAll(0);
    this.syncModel();
  }

  /** Direction the player is trying to move (unit, camera-relative), or null. */
  wishDir(input: Input, cam: FollowCamera): Vector3 | null {
    let ix = 0;
    let iz = 0;
    if (input.key('KeyW') || input.key('ArrowUp')) iz += 1;
    if (input.key('KeyS') || input.key('ArrowDown')) iz -= 1;
    if (input.key('KeyD') || input.key('ArrowRight')) ix += 1;
    if (input.key('KeyA') || input.key('ArrowLeft')) ix -= 1;
    if (!ix && !iz) return null;
    const fwd = cam.forward();
    const right = new Vector3(fwd.z, 0, -fwd.x);
    return fwd.scale(iz).add(right.scale(ix)).normalize();
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
    // Facing follows the camera, so anything with a backward component is a backpedal.
    const backpedal = iz < 0;
    this.sprinting = !this.walkMode && iz > 0 && wishLen > 0 && (input.key('ShiftLeft') || input.key('ShiftRight'));
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
    this.faceT = Math.max(0, this.faceT - dt);
    const target = wish.scale(wishLen > 0 ? speed : 0);
    if (this.lockT > 0) {
      if (this.dash) target.copyFrom(this.dash);
      else target.scaleInPlace(this.moveScale);
    } else this.dash = null;
    if (this.sprinting && this.lockT > 0) this.sprinting = false;

    const accel = this.grounded ? (wishLen > 0 ? 14 : 18) : 3.5;
    const k = 1 - Math.exp(-dt * (this.dash ? 30 : accel));
    this.vel.x += (target.x - this.vel.x) * k;
    this.vel.z += (target.z - this.vel.z) * k;

    // ---- facing: where the mouse aims. Moving, the body tracks the camera (A/D
    // strafe, S backpedals); standing, it turns in place once the camera swings
    // past ~75 degrees, so looking around doesn't spin the character. With a free
    // cursor, it simply turns to face the cursor.
    let wantYaw = this.yaw;
    const camYaw = Math.atan2(fwd.x, fwd.z);
    const camOff = Math.abs(wrap(camYaw - this.yaw));
    if (wishLen > 0 || camOff > 1.3 || cam.aimYaw !== null) this.idleTurn = true;
    else if (camOff < 0.05) this.idleTurn = false;
    if (this.faceT > 0) wantYaw = this.faceYaw;
    else if (this.dash && this.faceDash) wantYaw = Math.atan2(this.dash.x, this.dash.z);
    else if (this.frozen || (this.lockT > 0 && this.moveScale === 0)) wantYaw = this.yaw;
    else if (this.idleTurn) wantYaw = camYaw;
    const dy = wrap(wantYaw - this.yaw);
    const turnK = 1 - Math.exp(-dt * (this.faceT > 0 ? 30 : wishLen > 0 ? (this.grounded ? 16 : 8) : 7));
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
    let sx = 0;
    let sz = 0;
    if (this.shoveT > 0 && this.grounded) {
      const f = this.shoveT / this.shoveDur;
      sx = this.shoveV.x * f * dt;
      sz = this.shoveV.z * f * dt;
    }
    this.shoveT = Math.max(0, this.shoveT - dt);
    const nx = this.pos.x + this.vel.x * dt + sx;
    const nz = this.pos.z + this.vel.z * dt + sz;
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
    // recompute actual velocity (after collisions) for animation; a lunge is
    // the attack's own motion, not walking, so it stays out of it
    if (dt > 0) {
      this.vel.x = (next.x - this.pos.x - sx) / dt;
      this.vel.z = (next.z - this.pos.z - sz) / dt;
    }
    this.pos.copyFrom(next);

    // ---- state for the network / animation
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (!this.grounded) this.state = MoveState.Air;
    else if (this.dash && this.lockT > 0) this.state = MoveState.Dodge;
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
