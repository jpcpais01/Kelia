// Kelia service worker. The Vite build (pwaPlugin in vite.config.ts) fills in
// the placeholders below and emits this file as /sw.js.
//
// - Pages: network first, so every launch loads the newest deploy; the cached
//   page is only a fallback when offline (it then shows the realm as
//   unreachable instead of the browser's error page).
// - Build files (hashed JS/CSS/fonts): cache first. Their names change with
//   every build, so a cached copy can never be stale. Each build has its own
//   cache; the previous one is kept so a tab still running the old build can
//   finish loading its lazy chunks, older ones are deleted.
// - Game assets (models, sky maps, vendor scripts, icons): cache first in a
//   cache named after a hash of their contents, so it is replaced only when
//   an asset actually changes.
// - Everything else is never touched: other origins (game server, Firebase,
//   Google sign-in), WebSockets, non-GET requests, audio streaming (range
//   requests) and the server health check.

const BUILD = '__KELIA_BUILD__';
const STATIC_VERSION = '__KELIA_STATIC__';
const PRECACHE = __KELIA_PRECACHE__;

const SHELL = `kelia-shell-${BUILD}`;
const STATIC = `kelia-static-${STATIC_VERSION}`;
const STAMP = '/__kelia-built';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // cache: 'reload' skips the HTTP cache so the shell is never a stale copy
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      await cache.put(STAMP, new Response(String(Date.now())));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const shells = [];
      for (const name of names) {
        if (name.startsWith('kelia-static-') && name !== STATIC) await caches.delete(name);
        if (name.startsWith('kelia-shell-') && name !== SHELL) {
          const stamp = await (await caches.open(name)).match(STAMP);
          shells.push({ name, at: stamp ? Number(await stamp.text()) : 0 });
        }
      }
      // keep the newest previous build, drop the rest
      shells.sort((a, b) => b.at - a.at);
      for (const old of shells.slice(1)) await caches.delete(old.name);
      await self.clients.claim();
    })(),
  );
});

const isBuildFile = (path) => /^\/assets\/[^/]+-[\w-]{8}\.(js|css|woff2?)$/.test(path);
const isGameAsset = (path) =>
  path.startsWith('/assets/') || path.startsWith('/vendor/') || path.startsWith('/icons/') || path === '/manifest.webmanifest' || path === '/favicon.svg';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.destination === 'audio' || req.destination === 'video') return;

  if (req.mode === 'navigate') {
    event.respondWith(page(req));
  } else if (isBuildFile(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL));
  } else if (isGameAsset(url.pathname)) {
    event.respondWith(cacheFirst(req, STATIC));
  }
});

async function page(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put('/', res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match('/', { cacheName: SHELL });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req, name) {
  const hit = await caches.match(req, { ignoreSearch: false });
  if (hit) return hit;
  // revalidate against the server so a new asset version is never masked by
  // the browser's own HTTP cache
  const res = await fetch(req, { cache: 'no-cache' });
  if (res.ok && res.status === 200) (await caches.open(name)).put(req, res.clone());
  return res;
}
