// Client configuration from Vite env vars (set them in Vercel → Settings →
// Environment Variables; see README "Deploying").
const raw = import.meta.env as Record<string, string | undefined>;

/**
 * Reads a VITE_ variable forgivingly: trims spaces and stray quotes, and also
 * finds `NAME=value` lines when a whole .env block was pasted into one field.
 */
function envVar(name: string): string {
  for (const v of Object.values(raw)) {
    if (typeof v !== 'string' || !v.includes(name + '=')) continue;
    const m = v.match(new RegExp(`(?:^|\\s)${name}=\\s*["']?([^\\s"']+)`));
    if (m) return m[1];
  }
  const v = raw[name];
  return typeof v === 'string' ? (v.trim().replace(/^["']/, '').split(/[\s"']/)[0] ?? '') : '';
}

const env = {
  VITE_SERVER_URL: envVar('VITE_SERVER_URL'),
  VITE_FIREBASE_API_KEY: envVar('VITE_FIREBASE_API_KEY'),
  VITE_FIREBASE_AUTH_DOMAIN: envVar('VITE_FIREBASE_AUTH_DOMAIN'),
  VITE_FIREBASE_PROJECT_ID: envVar('VITE_FIREBASE_PROJECT_ID'),
  VITE_FIREBASE_APP_ID: envVar('VITE_FIREBASE_APP_ID'),
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.hostname.startsWith('192.168.');

/** WebSocket base of the game server, e.g. wss://kelia-server.onrender.com */
export const SERVER_URL: string = (
  env.VITE_SERVER_URL || (isLocal ? `ws://${location.hostname}:8787` : 'wss://kelia-server.onrender.com')
).replace(/\/$/, '');

export const SERVER_HTTP = SERVER_URL.replace(/^ws/, 'http');

export const FIREBASE_CONFIG = env.VITE_FIREBASE_API_KEY
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : null;

export const DEBUG = new URLSearchParams(location.search).has('debug');
