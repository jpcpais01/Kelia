// The painted anime face: big glossy eyes (tall iris with a dark top and a
// glowing lower half, a pupil, two catch-lights, the upper lid's shadow),
// an inked upper lash line with a flick at the outer corner, brows in the
// hair colour, a hint of nose, a small mouth and a soft blush. Drawn into
// the right half of the hero's atlas, in the head's front view; the eye
// whites and irises are also written to the alpha channel so the shader can
// keep them bright in any light.
import type { HeroAtlas } from './palette';

/** Head layout (rig space, metres): chin height and the face box the texture covers. */
export const CHIN_Y = 1.555;
export const HEAD_H = 0.25;
export const FACE_BOX = { x0: -0.07, x1: 0.07, y0: CHIN_Y + 0.01, y1: CHIN_Y + 0.15 };

/** Eye placement (metres from the chin / the centre line) and size. */
export const EYE = { y: 0.094, x: 0.033, w: 0.0196, h: 0.0192 };

export interface FaceStyle {
  /** Upper lid curve: height at the inner corner, peak, outer corner (in eye half-heights). */
  lid: [number, number, number];
  /** Lower lid sag (in eye half-heights) and how far the outer corner lifts. */
  low: number;
  lift: number;
  /** Iris size (fraction of eye width) and how far the lid hides its top. */
  iris: number;
  /** Lash weight and the outer flick length. */
  lash: number;
  flick: number;
  /** Brow: height above the eye, tilt (positive = outer end higher), arch, thickness. */
  brow: [number, number, number, number];
  /** Mouth: half width, curve (positive smile), asymmetry. */
  mouth: [number, number, number];
  scar?: boolean;
  /** Scale of the whole eye (feminine builds get bigger eyes). */
  size?: number;
}

export const FACE_STYLES: FaceStyle[] = [
  // Valiant: open, round, bright
  { lid: [0.35, 1.05, 0.55], low: 0.95, lift: 0.1, iris: 0.66, lash: 1, flick: 0.35, brow: [1.25, 0.08, 0.28, 0.16], mouth: [0.55, 0.22, 0] },
  // Keen: sharp almond, lifted corners
  { lid: [0.15, 0.9, 0.75], low: 0.62, lift: 0.4, iris: 0.6, lash: 1.05, flick: 0.55, brow: [1.2, 0.22, 0.18, 0.12], mouth: [0.5, 0.12, 0.35] },
  // Stern: calm, heavy lids
  { lid: [0.2, 0.62, 0.42], low: 0.8, lift: 0.05, iris: 0.64, lash: 1.25, flick: 0.3, brow: [0.95, -0.02, 0.06, 0.17], mouth: [0.55, -0.02, 0] },
  // Rugged: narrow, fierce
  { lid: [0.05, 0.6, 0.55], low: 0.55, lift: 0.2, iris: 0.56, lash: 1.2, flick: 0.4, brow: [0.85, -0.22, 0.1, 0.24], mouth: [0.6, -0.05, 0.25], scar: true },
];

const px = (x: number) => ((x - FACE_BOX.x0) / (FACE_BOX.x1 - FACE_BOX.x0)) * 512 + 512;
const py = (y: number) => ((FACE_BOX.y1 - y) / (FACE_BOX.y1 - FACE_BOX.y0)) * 512;
const S = 512 / (FACE_BOX.x1 - FACE_BOX.x0); // pixels per metre

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgb = (c: [number, number, number], k = 1, add = 0) =>
  `rgb(${c.map((v) => Math.max(0, Math.min(255, Math.round(v * k + add)))).join(',')})`;
const mixc = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** A momentary expression painted over the face style. */
export interface FaceExpr {
  /** Upper lids coming down (0 open .. 1 shut). */
  lid: number;
  /** Eyes squeezed shut in pain (drawn as > <). */
  squeeze?: boolean;
  /** Brows: positive knits them down in anger, negative raises the inner ends in pain. */
  brow?: number;
  /** Mouth: at rest, open in a shout, or gritted teeth. */
  mouth?: 'rest' | 'shout' | 'grit';
}

export const EXPRESSIONS = {
  rest: { lid: 0 },
  half: { lid: 0.55 },
  blink: { lid: 1 },
  fierce: { lid: 0.22, brow: 1, mouth: 'shout' },
  hurt: { lid: 1, squeeze: true, brow: -1, mouth: 'grit' },
} satisfies Record<string, FaceExpr>;
export type ExpressionName = keyof typeof EXPRESSIONS;

export interface FacePaint {
  style: number;
  skin: string;
  hair: string;
  eye: string;
  /** Feminine build: bigger eyes, longer lashes, softer brows. */
  soft?: boolean;
}

/** Paint the face region of the atlas. */
export function paintFace(atlas: HeroAtlas, f: FacePaint, ex: FaceExpr = EXPRESSIONS.rest) {
  const ctx = atlas.ctx;
  const st = { ...(FACE_STYLES[f.style] ?? FACE_STYLES[0]) };
  if (f.soft) {
    st.size = 1.1;
    st.lash *= 1.15;
    st.flick += 0.2;
    st.brow = [st.brow[0] + 0.1, st.brow[1] * 0.6, st.brow[2] + 0.1, st.brow[3] * 0.7];
    st.mouth = [st.mouth[0] * 0.85, Math.max(st.mouth[1], 0.12), st.mouth[2] * 0.5];
    st.scar = false;
  }
  const lid = Math.max(0, Math.min(1, ex.lid));
  const shut = lid > 0.95;
  const browK = ex.brow ?? 0;
  st.brow = [
    st.brow[0] - 0.18 * Math.max(0, browK) + 0.12 * Math.max(0, -browK),
    st.brow[1] + 0.32 * browK,
    st.brow[2] * (1 - 0.6 * Math.abs(browK)),
    st.brow[3] * (1 + 0.2 * Math.max(0, browK)),
  ];
  const skin = hexRgb(f.skin);
  const hair = hexRgb(f.hair);
  const iris = hexRgb(f.eye);
  ctx.save();
  ctx.beginPath();
  ctx.rect(512, 0, 512, 512);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = f.skin;
  ctx.fillRect(512, 0, 512, 512);

  // blush: soft and low on the cheeks
  for (const side of [-1, 1]) {
    const cx = px(side * 0.042);
    const cy = py(CHIN_Y + 0.071);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.02);
    g.addColorStop(0, 'rgba(235,105,110,0.28)');
    g.addColorStop(1, 'rgba(235,105,110,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.5, 0.75);
    ctx.translate(-cx, -cy);
    ctx.fillRect(cx - S * 0.03, cy - S * 0.03, S * 0.06, S * 0.06);
    ctx.restore();
  }

  const line = rgb(mixc([42, 24, 30], hair, 0.18));
  const browCol = rgb(mixc(hair, [30, 20, 24], 0.38));
  const mask: Path2D[] = [];

  for (const side of [-1, 1] as const) {
    const k = st.size ?? 1;
    const cx = px(side * EYE.x);
    const cy = py(CHIN_Y + EYE.y);
    const w = EYE.w * S * k;
    const h = EYE.h * S * k;
    // eye-local → canvas: x outward from the nose, y up
    const P = (x: number, y: number): [number, number] => [cx + side * x * w, cy - y * h];
    // the closed lid: a line sagging a little below the middle of the eye
    const closedY = (x: number) => -st.low * 0.42 - 0.2 * (1 - x * x) + st.lift * 0.35 * (x + 1);
    const U = (x: number, y: number): [number, number] => P(x, y + (closedY(x) - y) * lid);
    const [li, lp, lo] = st.lid;
    const inner = P(-1, li * 0.2 - 0.15);
    const outer = P(1, lo - 0.25 + st.lift * 0.3);
    // upper lid: inner corner, up over the peak, down to the outer corner
    const upper = new Path2D();
    upper.moveTo(...inner);
    upper.bezierCurveTo(...U(-0.75, li + 0.55), ...U(0.15, lp + 0.25), ...U(0.55, lp * 0.92));
    upper.quadraticCurveTo(...U(0.92, lo * 0.85), ...outer);
    const shape = new Path2D(upper);
    // lower lid back to the inner corner
    shape.bezierCurveTo(...P(0.85, -st.low * 0.75 + st.lift), ...P(-0.3, -st.low * 1.05), ...inner);
    shape.closePath();
    if (!shut) mask.push(shape);

    if (ex.squeeze) {
      // squeezed shut: a thick > < pointing at the nose
      ctx.strokeStyle = line;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = h * 0.26 * st.lash;
      ctx.beginPath();
      ctx.moveTo(...P(0.95, 0.75));
      ctx.lineTo(...P(-0.75, 0.05));
      ctx.lineTo(...P(0.95, -0.55));
      ctx.stroke();
    } else if (!shut) {
      // the eye white with the lid's soft shadow at the top
      ctx.save();
      ctx.clip(shape);
      const wg = ctx.createLinearGradient(0, cy - h * 1.2, 0, cy + h);
      wg.addColorStop(0, '#c9c3d6');
      wg.addColorStop(0.45, '#f6f2f4');
      wg.addColorStop(1, '#ffffff');
      ctx.fillStyle = wg;
      ctx.fillRect(cx - w * 1.3, cy - h * 2, w * 2.6, h * 4);
      // iris: tall, nudged toward the nose, its top tucked under the lid
      const ir = w * st.iris;
      const irY = h * 1.12;
      const icx = cx - side * w * 0.06;
      const icy = cy + h * 0.06;
      const ig = ctx.createLinearGradient(0, icy - irY, 0, icy + irY);
      ig.addColorStop(0, rgb(iris, 0.22));
      ig.addColorStop(0.38, rgb(iris, 0.62));
      ig.addColorStop(0.72, rgb(iris, 1.12, 10));
      ig.addColorStop(1, rgb(mixc(iris, [255, 255, 255], 0.45), 1.05));
      ctx.fillStyle = ig;
      ctx.beginPath();
      ctx.ellipse(icx, icy, ir, irY, 0, 0, Math.PI * 2);
      ctx.fill();
      // a lighter ring in the lower iris and a dark rim
      ctx.strokeStyle = rgb(mixc(iris, [255, 255, 255], 0.25), 1.15);
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = w * 0.06;
      ctx.beginPath();
      ctx.ellipse(icx, icy + irY * 0.08, ir * 0.72, irY * 0.72, 0, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgb(iris, 0.18);
      ctx.lineWidth = w * 0.07;
      ctx.beginPath();
      ctx.ellipse(icx, icy, ir, irY, 0, 0, Math.PI * 2);
      ctx.stroke();
      // pupil
      ctx.fillStyle = rgb(iris, 0.1);
      ctx.beginPath();
      ctx.ellipse(icx, icy - irY * 0.08, ir * 0.36, irY * 0.48, 0, 0, Math.PI * 2);
      ctx.fill();
      // the lid's shadow across the top (it comes down with the lid)
      const drop = lid * h * 0.9;
      const sg = ctx.createLinearGradient(0, cy - h * 1.3 + drop, 0, cy - h * 0.1 + drop);
      sg.addColorStop(0, 'rgba(20,10,30,0.75)');
      sg.addColorStop(1, 'rgba(20,10,30,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(cx - w * 1.3, cy - h * 2, w * 2.6, h * 1.95 + drop);
      // catch-lights: a big one up toward the outer side, a small one low
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(icx + side * ir * 0.32, icy - irY * 0.38, ir * 0.3, irY * 0.24, side * -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(icx - side * ir * 0.3, icy + irY * 0.45, ir * 0.12, irY * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    if (!ex.squeeze) {
      // upper lash line: thick, tapering in, a flick past the outer corner (it rides the lid down)
      ctx.fillStyle = line;
      const t = h * 0.2 * st.lash * (1 + 0.15 * lid);
      const fl = 1 - 0.5 * lid;
      const lash = new Path2D();
      lash.moveTo(...P(-1.02, li * 0.2 - 0.12));
      lash.bezierCurveTo(...U(-0.75, li + 0.55), ...U(0.15, lp + 0.25), ...U(0.55, lp * 0.92));
      lash.quadraticCurveTo(...U(0.92, lo * 0.85), ...outer);
      lash.lineTo(...P(1.12 + st.flick * 0.5 * fl, lo - 0.05 + st.flick * 0.55 * fl + st.lift * 0.3 - lid * 0.35));
      lash.quadraticCurveTo(...U(1.0, lo + 0.1 + t / h), ...U(0.6, lp * 0.92 + (t / h) * 1.1));
      lash.bezierCurveTo(...U(0.15, lp + 0.25 + (t / h) * 1.2), ...U(-0.75, li + 0.55 + (t / h) * 0.5), ...P(-1.02, li * 0.2 - 0.05));
      lash.closePath();
      ctx.fill(lash);
    }
    // a few lashes off the outer end
    ctx.strokeStyle = line;
    ctx.lineCap = 'round';
    ctx.lineWidth = w * 0.06;
    for (const [a, b] of ex.squeeze
      ? []
      : ([
          [0.72, 0.3],
          [0.9, 0.45],
        ] as const)) {
      const base = U(a, lo * 0.9 + 0.1 + (1 - a) * lp * 0.6);
      ctx.beginPath();
      ctx.moveTo(...base);
      ctx.lineTo(base[0] + side * w * b * 0.6, base[1] - h * b * 0.6);
      ctx.stroke();
    }
    // lower lash: a thin stroke under the outer half
    ctx.lineWidth = w * 0.055;
    ctx.globalAlpha = ex.squeeze ? 0 : 0.75 * (1 - 0.6 * lid);
    ctx.beginPath();
    ctx.moveTo(...P(0.05, -st.low * 1.0));
    ctx.quadraticCurveTo(...P(0.75, -st.low * 0.8 + st.lift), ...P(0.98, -0.1 + st.lift * 0.6));
    ctx.stroke();
    // the lid crease above
    ctx.globalAlpha = ex.squeeze ? 0.5 : 0.35;
    ctx.lineWidth = w * 0.045;
    ctx.beginPath();
    ctx.moveTo(...P(-0.5, li + 0.95));
    ctx.quadraticCurveTo(...P(0.25, lp + 0.75), ...P(0.85, lo + 0.55));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // brow
    const [bh, tilt, arch, bt] = st.brow;
    ctx.fillStyle = browCol;
    const bw = 1.05;
    const b0 = P(-0.95, bh * 2 + 0.6 - tilt);
    const b1 = P(bw, bh * 2 + 0.6 + tilt * 2.2);
    const peak = P(0.1, bh * 2 + 0.6 + arch * 2.2 + tilt * 0.4);
    const th = bt * h * 2.2;
    ctx.beginPath();
    ctx.moveTo(b0[0], b0[1] + th * 0.45);
    ctx.quadraticCurveTo(peak[0], peak[1] + th * 0.5, b1[0], b1[1]);
    ctx.quadraticCurveTo(peak[0], peak[1] - th * 0.6, b0[0], b0[1] - th * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  // nose: a short shadow under the tip and a tiny highlight
  const nx = px(0.0035);
  const ny = py(CHIN_Y + 0.064);
  ctx.strokeStyle = rgb(skin, 0.68);
  ctx.lineWidth = S * 0.0016;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(nx - S * 0.003, ny);
  ctx.quadraticCurveTo(nx, ny + S * 0.0012, nx + S * 0.0035, ny - S * 0.001);
  ctx.stroke();

  // mouth
  const [mw, curve, asym] = st.mouth;
  const my = py(CHIN_Y + 0.038);
  const mx = px(0);
  const half = S * 0.0115 * mw * 2;
  const lipLine = rgb(mixc(skin, [90, 30, 40], 0.65), 0.9);
  if (ex.mouth === 'shout' || ex.mouth === 'grit') {
    // open: a dark mouth with the top teeth showing (and a tongue when shouting)
    const shout = ex.mouth === 'shout';
    const hw = half * (shout ? 1.15 : 1.3);
    const top = my - S * (shout ? 0.0035 : 0.002);
    const depth = S * (shout ? 0.015 : 0.005);
    const m = new Path2D();
    m.moveTo(mx - hw, top + S * 0.001);
    m.quadraticCurveTo(mx, top - S * 0.0012, mx + hw, top + S * 0.001);
    if (shout) m.bezierCurveTo(mx + hw * 0.9, top + depth * 0.9, mx - hw * 0.9 + hw * 0.4, top + depth * 1.15, mx - hw, top + S * 0.001);
    else m.quadraticCurveTo(mx, top + depth * 1.6, mx - hw, top + S * 0.001);
    m.closePath();
    ctx.fillStyle = rgb([70, 22, 34]);
    ctx.fill(m);
    ctx.save();
    ctx.clip(m);
    ctx.fillStyle = '#f7f3ee';
    ctx.fillRect(mx - hw, top - S * 0.002, hw * 2, (shout ? 0.0024 : 0.0032) * S + S * 0.002);
    if (!shout) {
      ctx.fillRect(mx - hw, top + depth * 0.85, hw * 2, S * 0.01);
      ctx.strokeStyle = rgb([150, 120, 120]);
      ctx.lineWidth = S * 0.0006;
      ctx.beginPath();
      ctx.moveTo(mx - hw, top + depth * 0.62);
      ctx.lineTo(mx + hw, top + depth * 0.62);
      ctx.stroke();
    } else {
      ctx.fillStyle = rgb([196, 84, 92]);
      ctx.beginPath();
      ctx.ellipse(mx, top + depth * 1.05, hw * 0.6, depth * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = lipLine;
    ctx.lineWidth = S * 0.0013;
    ctx.stroke(m);
  } else {
    ctx.strokeStyle = lipLine;
    ctx.lineWidth = S * 0.0017;
    ctx.beginPath();
    ctx.moveTo(mx - half, my - curve * S * 0.004);
    ctx.quadraticCurveTo(mx, my + curve * S * 0.007, mx + half, my - (curve + asym) * S * 0.004);
    ctx.stroke();
    // lower lip hint
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = S * 0.0012;
    ctx.beginPath();
    ctx.moveTo(mx - half * 0.35, my + S * 0.0045);
    ctx.quadraticCurveTo(mx, my + S * 0.0058, mx + half * 0.35, my + S * 0.0045);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (st.scar) {
    ctx.strokeStyle = rgb(skin, 0.72, -8);
    ctx.lineWidth = S * 0.0022;
    ctx.beginPath();
    ctx.moveTo(px(-0.052), py(CHIN_Y + 0.088));
    ctx.lineTo(px(-0.022), py(CHIN_Y + 0.064));
    ctx.stroke();
    ctx.strokeStyle = rgb(skin, 1.08, 12);
    ctx.lineWidth = S * 0.0009;
    ctx.stroke();
  }
  ctx.restore();

  // the eyes' alpha: 255 skin, 155 inside an eye (the shader keeps it bright)
  const img = ctx.getImageData(512, 0, 512, 512);
  const m = document.createElement('canvas');
  m.width = 512;
  m.height = 512;
  const mc = m.getContext('2d')!;
  mc.translate(-512, 0);
  mc.fillStyle = '#fff';
  for (const p of mask) mc.fill(p);
  const md = mc.getImageData(0, 0, 512, 512).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = 255 - Math.round((md[i + 3] / 255) * 100);
  ctx.putImageData(img, 512, 0);
}
