// Third-person follow camera: smooth orbit, terrain and obstacle avoidance,
// gentle look-ahead, sprint FOV kick and trauma-based screen shake.
import { Vector3, type UniversalCamera } from '@babylonjs/core';
import { Simplex2 } from '@kelia/shared';

export interface CameraSettings {
  sensitivity: number;
  invertY: boolean;
  fov: number;
  shake: boolean;
}

const noise = new Simplex2(99);

export class FollowCamera {
  yaw = Math.PI;
  pitch = 0.32;
  distance = 6.2;
  private targetDistance = 6.2;
  private focus = new Vector3();
  private smoothDist = 6.2;
  private trauma = 0;
  private t = 0;
  private fovKick = 0;
  /** Extra framing offset (shoulder). */
  shoulder = 0.45;
  settings: CameraSettings = { sensitivity: 1, invertY: false, fov: 60, shake: true };
  /** Height sampler for terrain collision. */
  groundAt: (x: number, z: number) => number = () => 0;
  /** Blocking test for obstacles (buildings, trees): returns true if point is inside one. */
  blocked: (x: number, y: number, z: number) => boolean = () => false;
  private initialized = false;
  /** Set while the free cursor aims: forward() then points at the cursor instead. */
  aimYaw: number | null = null;

  constructor(readonly camera: UniversalCamera) {}

  /** Add screen shake (0..1, decays quickly). */
  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  look(dx: number, dy: number) {
    const s = 0.0024 * this.settings.sensitivity;
    this.yaw += dx * s;
    this.pitch += dy * s * (this.settings.invertY ? -1 : 1);
    this.pitch = Math.max(-0.55, Math.min(1.25, this.pitch));
  }

  zoom(steps: number) {
    this.targetDistance = Math.max(2.2, Math.min(14, this.targetDistance * Math.pow(1.12, steps)));
  }

  /** Forward direction on the ground plane (where W walks and skills aim). */
  forward() {
    if (this.aimYaw !== null) return new Vector3(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  snap(target: Vector3) {
    this.focus.copyFrom(target);
    this.initialized = true;
  }

  update(dt: number, target: Vector3, velocity: Vector3, sprinting: boolean) {
    this.t += dt;
    if (!this.initialized) this.snap(target);
    // Follow with a little lag vertically (smooths jumps and steps) and less horizontally.
    const kh = 1 - Math.exp(-dt * 14);
    const kv = 1 - Math.exp(-dt * 7);
    this.focus.x += (target.x - this.focus.x) * kh;
    this.focus.z += (target.z - this.focus.z) * kh;
    this.focus.y += (target.y - this.focus.y) * kv;

    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 8));
    const cp = Math.cos(this.pitch);
    const dir = new Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pivot = this.focus.add(right.scale(this.shoulder * Math.min(1, this.distance / 5)));

    // Pull in when terrain or an obstacle is in the way.
    let d = this.distance;
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const s = (this.distance * i) / steps;
      const p = pivot.add(dir.scale(s));
      if (p.y < this.groundAt(p.x, p.z) + 0.35 || this.blocked(p.x, p.y, p.z)) {
        d = Math.max(1.2, s - this.distance / steps);
        break;
      }
    }
    // Pull in fast, ease back out.
    this.smoothDist += (d - this.smoothDist) * (d < this.smoothDist ? 1 - Math.exp(-dt * 25) : 1 - Math.exp(-dt * 3));
    const pos = pivot.add(dir.scale(this.smoothDist));
    const gy = this.groundAt(pos.x, pos.z) + 0.35;
    if (pos.y < gy) pos.y = gy;

    // Shake
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const sh = this.settings.shake ? this.trauma * this.trauma : 0;
    const look = pivot.clone();
    look.y += 0.15;
    // slight look-ahead in the direction of travel
    look.addInPlace(velocity.scale(0.06));
    if (sh > 0) {
      const f = 22;
      pos.x += noise.noise(this.t * f, 1) * sh * 0.22;
      pos.y += noise.noise(this.t * f, 2) * sh * 0.22;
      look.x += noise.noise(this.t * f, 3) * sh * 0.12;
      look.y += noise.noise(this.t * f, 4) * sh * 0.12;
    }
    this.camera.position.copyFrom(pos);
    this.camera.setTarget(look);
    this.fovKick += ((sprinting ? 1 : 0) - this.fovKick) * (1 - Math.exp(-dt * 4));
    this.camera.fov = ((this.settings.fov + this.fovKick * 6) * Math.PI) / 180;
  }
}
