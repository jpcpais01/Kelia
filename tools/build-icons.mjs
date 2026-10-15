// App icon pipeline: draws the Kelia crest as SVG and exports every size the
// PWA manifest, iOS and the browser tab need into client/public/icons.
// Run: cd tools && npm i && node build-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '../client/public');
const out = path.join(pub, 'icons');
fs.mkdirSync(out, { recursive: true });

// Deterministic star field so re-runs give identical files.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const stars = Array.from({ length: 34 }, () => {
  const x = 30 + rnd() * 452;
  const y = 24 + rnd() * 230;
  const r = 0.7 + rnd() * rnd() * 2.2;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" opacity="${(0.35 + rnd() * 0.6).toFixed(2)}"/>`;
}).join('');

// Eight-pointed star: long cardinal rays, short diagonal ones.
function star(cx, cy, long, short, waist) {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8 - Math.PI / 2;
    const r = i % 4 === 0 ? long : i % 2 === 0 ? short : waist;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(' ');
}

// Bevelled rays: each ray is two triangles, a lit face and a shaded face.
function facets(cx, cy, long, short, waist) {
  const pt = (i, r) => {
    const a = (i * Math.PI) / 8 - Math.PI / 2;
    return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
  };
  let lit = '';
  let dark = '';
  for (let i = 0; i < 16; i += 2) {
    const tip = pt(i, i % 4 === 0 ? long : short);
    lit += `<polygon points="${cx},${cy} ${pt(i - 1, waist)} ${tip}"/>`;
    dark += `<polygon points="${cx},${cy} ${tip} ${pt(i + 1, waist)}"/>`;
  }
  return { lit, dark };
}

// Small four-point sparkle.
const sparkle = (x, y, s) =>
  `<path d="M${x} ${y - s} Q${x + s * 0.16} ${y - s * 0.16} ${x + s} ${y} Q${x + s * 0.16} ${y + s * 0.16} ${x} ${y + s} Q${x - s * 0.16} ${y + s * 0.16} ${x - s} ${y} Q${x - s * 0.16} ${y - s * 0.16} ${x} ${y - s}Z"/>`;

/**
 * scale: emblem size (maskable keeps it inside the 80% safe circle);
 * rounded: transparent rounded corners plus a gilded frame for the "any" icon.
 */
function svg({ scale = 1, rounded = false } = {}) {
  const c = 256;
  const e = (v) => (v * scale).toFixed(1);
  const ring = 150 * scale;
  const diamonds = [0, 90, 180, 270]
    .map((deg) => `<rect x="${c - 9 * scale}" y="${c - ring - 9 * scale}" width="${18 * scale}" height="${18 * scale}" transform="rotate(${deg} ${c} ${c}) rotate(45 ${c} ${c - ring})"/>`)
    .join('');
  const ticks = [45, 135, 225, 315]
    .map((deg) => `<circle cx="${c}" cy="${c - ring}" r="${4 * scale}" transform="rotate(${deg} ${c} ${c})"/>`)
    .join('');
  const rays = facets(c, c, 176 * scale, 96 * scale, 40 * scale);
  const clip = rounded ? 'clip-path="url(#round)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  <clipPath id="round"><rect width="512" height="512" rx="112"/></clipPath>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0f1430"/>
    <stop offset="0.42" stop-color="#2b3270"/>
    <stop offset="0.68" stop-color="#7a5a8e"/>
    <stop offset="0.84" stop-color="#e39a72"/>
    <stop offset="1" stop-color="#f6cf8e"/>
  </linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#fff3cf" stop-opacity="0.95"/>
    <stop offset="0.35" stop-color="#f3c977" stop-opacity="0.45"/>
    <stop offset="1" stop-color="#f3c977" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff6dc"/>
    <stop offset="0.38" stop-color="#f4d58f"/>
    <stop offset="0.7" stop-color="#d9a85a"/>
    <stop offset="1" stop-color="#9c6a2e"/>
  </linearGradient>
  <linearGradient id="goldEdge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff2c8"/>
    <stop offset="1" stop-color="#a9763a"/>
  </linearGradient>
  <radialGradient id="gem" cx="0.38" cy="0.32" r="0.75">
    <stop offset="0" stop-color="#e9fffa"/>
    <stop offset="0.3" stop-color="#7fe6d4"/>
    <stop offset="0.75" stop-color="#239b93"/>
    <stop offset="1" stop-color="#0d5a5f"/>
  </radialGradient>
  <linearGradient id="far" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#5e5a8c"/>
    <stop offset="1" stop-color="#3a3d6e"/>
  </linearGradient>
  <linearGradient id="near" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1f2f4f"/>
    <stop offset="1" stop-color="#0d1426"/>
  </linearGradient>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${e(10)}"/></filter>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="${e(6)}" stdDeviation="${e(7)}" flood-color="#0a0d1f" flood-opacity="0.55"/></filter>
</defs>
<g ${clip}>
  <rect width="512" height="512" fill="url(#sky)"/>
  <g fill="#fff8e6">${stars}</g>
  <ellipse cx="256" cy="430" rx="300" ry="120" fill="#ffd9a0" opacity="0.35" filter="url(#soft)"/>
  <path d="M0 400 L70 330 L118 362 L188 280 L246 344 L300 300 L360 352 L420 296 L512 372 L512 512 L0 512Z" fill="url(#far)" opacity="0.9"/>
  <path d="M188 280 L206 300 L196 304 L186 296 L174 306Z M420 296 L436 312 L426 314 L416 308 L406 312Z" fill="#c9c3e8" opacity="0.55"/>
  <path d="M0 448 L60 410 L120 432 L170 396 L232 440 L290 414 L350 446 L410 404 L470 430 L512 414 L512 512 L0 512Z" fill="url(#near)"/>
  <circle cx="${c}" cy="${c}" r="${e(205)}" fill="url(#halo)" opacity="0.85"/>
  <g filter="url(#shadow)">
    <circle cx="${c}" cy="${c}" r="${ring}" fill="none" stroke="url(#goldEdge)" stroke-width="${e(5)}"/>
    <circle cx="${c}" cy="${c}" r="${ring - 12 * scale}" fill="none" stroke="#f4d58f" stroke-opacity="0.55" stroke-width="${e(1.6)}" stroke-dasharray="${e(3)} ${e(7)}"/>
    <g fill="url(#gold)" stroke="#fff2c8" stroke-width="${e(1.5)}">${diamonds}</g>
    <g fill="#f8e2a8">${ticks}</g>
    <polygon points="${star(c, c, 176 * scale, 96 * scale, 40 * scale)}" fill="url(#gold)" stroke="#fff4d4" stroke-width="${e(3)}" stroke-linejoin="round"/>
    <g fill="#fff8e4" opacity="0.5">${rays.lit}</g>
    <g fill="#7a4a1c" opacity="0.32">${rays.dark}</g>
    <circle cx="${c}" cy="${c}" r="${e(40)}" fill="#fbe7b4" stroke="#9c6a2e" stroke-width="${e(2)}"/>
    <circle cx="${c}" cy="${c}" r="${e(31)}" fill="url(#gem)"/>
    <ellipse cx="${c - 10 * scale}" cy="${c - 12 * scale}" rx="${e(11)}" ry="${e(7)}" fill="#ffffff" opacity="0.8" transform="rotate(-30 ${c - 10 * scale} ${c - 12 * scale})"/>
  </g>
  <g fill="#fffbe9">${sparkle(c + 118 * scale, c - 112 * scale, 14 * scale)}${sparkle(c - 126 * scale, c + 100 * scale, 9 * scale)}${sparkle(c + 96 * scale, c + 132 * scale, 6 * scale)}</g>
</g>
${rounded ? '<rect x="5" y="5" width="502" height="502" rx="108" fill="none" stroke="url(#goldEdge)" stroke-width="6" opacity="0.9"/><rect x="15" y="15" width="482" height="482" rx="99" fill="none" stroke="#f4d58f" stroke-opacity="0.35" stroke-width="2"/>' : ''}
</svg>`;
}

const any = svg({ rounded: true });
const maskable = svg({ scale: 0.8 });
fs.writeFileSync(path.join(pub, 'favicon.svg'), any);
fs.writeFileSync(path.join(out, 'icon.svg'), any);
fs.writeFileSync(path.join(out, 'icon-maskable.svg'), maskable);

const render = (src, size, file) =>
  sharp(Buffer.from(src), { density: Math.max(72, (72 * size) / 512) * 2 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, file));

await Promise.all([
  render(any, 192, 'icon-192.png'),
  render(any, 512, 'icon-512.png'),
  render(maskable, 192, 'maskable-192.png'),
  render(maskable, 512, 'maskable-512.png'),
  // iOS draws its own rounded corners and has no transparency
  render(maskable, 180, 'apple-touch-icon.png'),
  render(any, 32, 'favicon-32.png'),
  render(any, 16, 'favicon-16.png'),
]);
console.log('icons written to', path.relative(process.cwd(), out));
