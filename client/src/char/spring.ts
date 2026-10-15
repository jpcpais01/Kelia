// Tiny damped springs for procedural motion (body layers, flinches).

export interface Spring {
  x: number;
  v: number;
}

export function spring(): Spring {
  return { x: 0, v: 0 };
}

/** Damped spring toward `target` (frequency in Hz, damping ratio < 1 overshoots). */
export function stepSpring(s: Spring, target: number, dt: number, hz: number, zeta: number) {
  const w = Math.PI * 2 * hz;
  // a few sub-steps keep stiff springs stable on long frames
  const n = Math.max(1, Math.ceil(dt / 0.012));
  const h = Math.min(dt, 0.1) / n;
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h;
    s.x += s.v * h;
  }
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = 0;
    s.v = 0;
  }
}
