import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Hash of everything in public/, so the service worker's asset cache is only
 *  replaced when a model, sky map or icon actually changes. */
function hashPublic(dir: string, hash = createHash('sha256')) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) hashPublic(file, hash);
    else hash.update(name).update(fs.readFileSync(file));
  }
  return hash;
}

/** Emits /sw.js for the production build with this build's id, the tiny app
 *  shell to precache and the public-asset version filled in. Build files are
 *  cached as the game loads them rather than precached, so a first visit
 *  never downloads the game twice. Dev serves no service worker. */
function pwaPlugin(): Plugin {
  return {
    name: 'kelia-pwa',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const shell = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/favicon.svg'];
      const build = createHash('sha256').update(Object.keys(bundle).sort().join('|')).digest('hex').slice(0, 12);
      const assets = hashPublic(path.join(here, 'public')).digest('hex').slice(0, 12);
      const source = fs
        .readFileSync(path.join(here, 'pwa/sw.js'), 'utf8')
        .replace('__KELIA_BUILD__', build)
        .replace('__KELIA_STATIC__', assets)
        .replace('__KELIA_PRECACHE__', JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // The Firebase web config is public by design; also accept it without the
  // VITE_ prefix, since Vercel warns about (and can lock) prefixed names. Only
  // these exact names are exposed, never e.g. FIREBASE_SERVICE_ACCOUNT.
  envPrefix: ['VITE_', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID'],
  resolve: {
    alias: { '@kelia/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  plugins: [pwaPlugin()],
});
