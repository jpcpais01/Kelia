import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

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
});
