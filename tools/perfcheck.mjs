// Headless sanity check of the F3 performance overlay and the F4 per-part GPU probe
// (shortened phases). Timings from SwiftShader are meaningless; this checks wiring.
// node perfcheck.mjs <url> <outDir>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [url, out] = process.argv.slice(2);
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForSelector('.login-card', { timeout: 240000 });
await page.keyboard.press('F3');
await page.waitForTimeout(20000);
console.log(await page.evaluate(() => document.querySelector('.perf')?.innerText.slice(0, 3000)));
console.log(await page.evaluate(() => {
  const { world, perf } = window.kelia; const c = {}; const other = {};
  for (const m of world.scene.meshes) { const s = perf.systemOf(m); c[s] = (c[s] || 0) + 1; if (s === 'other') other[m.name] = (other[m.name] || 0) + 1; }
  const snap = perf.snapshot;
  return JSON.stringify({ c, other: Object.entries(other).slice(0, 40), sys: snap.systems.map((r) => [r.key, r.cpu, r.gpu]), render: snap.render.map((r) => [r.key, r.ms]), dc: snap.drawCalls });
}));
await page.evaluate(() => { const c = window.kelia.perf.constructor; c.PHASE = 3; c.SETTLE = 1; });
await page.keyboard.press('F4');
await page.waitForFunction(() => window.kelia.perf.probeResult, null, { timeout: 300000, polling: 2000 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => window.kelia.perf.probeResult)));
await page.screenshot({ path: `${out}/perf.png`, timeout: 180000 });
await browser.close();
