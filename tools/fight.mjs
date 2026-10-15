// Headless combat check against a local server started with DEV_COMMANDS=true:
// guest login → create a hero of a class → teleport next to enemies → fight.
// node fight.mjs <url> <outDir> <name> [class index 0-2] [x z]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [url, outDir = 'out/fight', name = 'Fighter', clsIdx = '0', tx = '150', tz = '-40'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ executablePath: exe, args, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
const shot = async (n) => { await page.screenshot({ path: `${outDir}/${n}.png`, timeout: 180000 }); console.log('shot', n); };
const state = () => page.evaluate(() => {
  const g = window.game;
  const p = g.player;
  const ms = [...g.monsters.values()].map((m) => ({ id: m.id, kind: m.def.id, d: +Math.hypot(m.pos.x - p.pos.x, m.pos.z - p.pos.z).toFixed(1), hp: +m.hpFrac.toFixed(2), st: m.state }));
  ms.sort((a, b) => a.d - b.d);
  return { pos: [p.pos.x, p.pos.z].map((v) => +v.toFixed(1)), hp: g.character.hp, xp: g.character.xp, lvl: g.character.level, dead: g.combat.dead, near: ms.slice(0, 3), fps: window.kelia.engine.getFps().toFixed(1) };
});

if (process.env.KIND) await page.addInitScript((k) => (window.__kind = k), process.env.KIND);
await page.goto(url);
await page.waitForSelector('.login-card button.btn.primary', { timeout: 240000 });
await page.click('.login-card button.btn.primary');
await page.waitForSelector('.creator', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.click(`.cards .card:nth-child(${Number(clsIdx) + 1})`).catch(() => console.log('no class card selector'));
await page.waitForTimeout(3000);
await page.fill('.name-row input', name);
await page.click('.creator-right .btn.primary');
await page.waitForSelector('.hud', { timeout: 120000 });
await page.waitForFunction(() => window.game.camBlend >= 1, null, { timeout: 180000 });
console.log('in world', JSON.stringify(await state()));
await page.evaluate(([x, z]) => window.game.net.send({ t: 'chat', text: `/tp ${x} ${z}` }), [tx, tz]);
await page.waitForTimeout(8000);
let s = await state();
console.log('after tp', JSON.stringify(s));
// hop next to the closest enemy and face it
await page.evaluate(() => {
  const g = window.game;
  const p = g.player;
  const m = [...g.monsters.values()].filter((m) => m.alive && (!window.__kind || m.def.id === window.__kind)).sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) - Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z))[0];
  if (!m) return;
  window.__target = m.id;
  g.net.send({ t: 'chat', text: `/tp ${(m.pos.x - 4).toFixed(1)} ${m.pos.z.toFixed(1)}` });
});
await page.waitForTimeout(6000);
console.log('next to enemy', JSON.stringify(await state()));
// fight: aim at the target and attack / use skills
for (let round = 0; round < 14; round++) {
  await page.evaluate((round) => {
    const g = window.game;
    const p = g.player;
    const m = g.monsters.get(window.__target) ?? [...g.monsters.values()].find((x) => x.alive);
    if (m) {
      g.follow.yaw = Math.atan2(m.pos.x - p.pos.x, m.pos.z - p.pos.z);
      g.follow.pitch = 0.15;
      if (window.__boss) g.follow.distance = 9;
    }
    g.combat.queue(round % 5 === 2 ? 's' : 'c', 0);
    if (round === 6) g.combat.queue('d', 0);
  }, round);
  await page.waitForTimeout(2500);
  if (round === 2) await shot('1-fight');
  if (round === 7) await shot('2-fight');
  s = await state();
  console.log('round', round, JSON.stringify(s));
}
await shot('3-after');
console.log('errors', errors.length);
await browser.close();
