// Client configuration from Vite env vars (set them in Vercel → Settings →
// Environment Variables; see README "Deploying").
const raw = import.meta.env as Record<string, string | undefined>;

/** JS-snippet keys from the Firebase console, matched to our env names. */
const SNIPPET_KEY: Record<string, string> = {
  VITE_FIREBASE_API_KEY: 'apiKey',
  VITE_FIREBASE_AUTH_DOMAIN: 'authDomain',
  VITE_FIREBASE_PROJECT_ID: 'projectId',
  VITE_FIREBASE_APP_ID: 'appId',
};

/**
 * Reads a VITE_ variable forgivingly: trims spaces and stray quotes, finds
 * `NAME=value` lines when a whole .env block was pasted into one field, and
 * understands the console's `apiKey: "..."` snippet pasted into any field.
 */
function envVar(name: string): string {
  const values = Object.values(raw).filter((v): v is string => typeof v === 'string');
  for (const v of values) {
    if (!v.includes(name + '=')) continue;
    const m = v.match(new RegExp(`(?:^|\\s)${name}=\\s*["']?([^\\s"',;]+)`));
    if (m) return m[1];
  }
  const snippet = SNIPPET_KEY[name];
  if (snippet) {
    for (const v of values) {
      const m = v.match(new RegExp(`["']?\\b${snippet}["']?\\s*:\\s*["']([^"']+)["']`));
      if (m) return m[1].trim();
    }
  }
  const v = raw[name];
  return typeof v === 'string' ? (v.trim().replace(/^["']/, '').split(/[\s"',;]/)[0] ?? '') : '';
}

/** Firebase web API keys always look like this; anything else can't work. */
const API_KEY_RE = /AIza[0-9A-Za-z_-]{35}/;

function apiKey(): string {
  const v = envVar('VITE_FIREBASE_API_KEY');
  if (API_KEY_RE.test(v)) return v.match(API_KEY_RE)![0];
  // The key may sit in another field (e.g. the whole config pasted elsewhere).
  for (const other of Object.values(raw)) {
    const m = typeof other === 'string' ? other.match(API_KEY_RE) : null;
    if (m) return m[0];
  }
  return v;
}

const env = {
  VITE_SERVER_URL: envVar('VITE_SERVER_URL'),
  VITE_FIREBASE_API_KEY: apiKey(),
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

/** Why account login can't work with this build's settings, if it can't. */
export const FIREBASE_PROBLEM: string | null = !env.VITE_FIREBASE_API_KEY
  ? null
  : !API_KEY_RE.test(env.VITE_FIREBASE_API_KEY)
    ? `The Firebase API key in this build isn't valid (got "${maskKey(env.VITE_FIREBASE_API_KEY)}"; it should start with "AIza" and be 39 characters).`
    : !env.VITE_FIREBASE_PROJECT_ID && !env.VITE_FIREBASE_AUTH_DOMAIN
      ? 'Firebase is missing its project id in this build.'
      : null;

/** Shows enough of a key to compare it with the console, never all of it. */
export function maskKey(k: string): string {
  return k.length <= 10 ? `${k.slice(0, 3)}… (${k.length} chars)` : `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)`;
}

export const FIREBASE_CONFIG = env.VITE_FIREBASE_API_KEY
  ? {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    }
  : null;

export const DEBUG = new URLSearchParams(location.search).has('debug');
