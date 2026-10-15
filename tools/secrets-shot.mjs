// Headless look at the secret spots (needs a local server with DEV_COMMANDS=true).
// node secrets-shot.mjs <url> <outDir>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [url, outDir = 'out/secrets'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ executablePath: exe, args, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
await page.goto(url);
await page.waitForSelector('.login-card button.btn.primary', { timeout: 240000 });
await page.click('.login-card button.btn.primary');
await page.waitForSelector('.creator', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.fill('.name-row input', 'Seeker');
await page.click('.creator-right .btn.primary');
await page.waitForSelector('.hud', { timeout: 120000 });
await page.waitForFunction(() => window.game.camBlend >= 1, null, { timeout: 180000 });
const spots = [['tower', -210, -284, Math.PI], ['fairy', -318, 128, 0], ['isle', 196, -262, Math.PI], ['grotto', -36, 222, 0], ['village', 4, -30, 2.4]];
for (const [n, x, z, yaw] of spots) {
  await page.evaluate(([x, z]) => window.game.net.send({ t: 'chat', text: `/tp ${x} ${z}` }), [x, z]);
  await page.waitForTimeout(9000);
  await page.evaluate((yaw) => { window.game.follow.yaw = yaw; window.game.follow.pitch = 0.1; }, yaw);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${outDir}/${n}.png`, timeout: 180000 });
  console.log('shot', n);
}
console.log('errors', errors.length);
await browser.close();
