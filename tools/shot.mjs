// Headless screenshot helper: node shot.mjs <url> <out.png> [waitMs] [--webgpu]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [url, out, wait = '8000', ...flags] = process.argv.slice(2);
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (flags.includes('--webgpu')) args.push('--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader');
const browser = await chromium.launch({ executablePath: exe, args, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { const t = m.text(); if (!t.includes('[vite]')) console.log('[page]', m.type(), t.slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (flags.includes('--eval')) {
  const i = flags.indexOf('--eval');
  console.log(await page.evaluate(flags[i + 1]));
}
await page.evaluate(() => { try { window.kelia?.engine?.stopRenderLoop(); } catch {} });
await page.waitForTimeout(500);
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
