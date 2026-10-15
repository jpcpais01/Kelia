// Client configuration from Vite env vars (set them in Vercel → Settings →
// Environment Variables; see README "Deploying").
const env = import.meta.env;

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
