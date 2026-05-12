/**
 * AudioChart Service Worker — offline caching.
 *
 * Strategy by resource type:
 *   JS/CSS/HTML  → network-first, cache fallback (always fresh when online)
 *   GeoJSON data → network-first, cache fallback
 *   Tile images  → cache-first, network fallback (LRU limited)
 *   /api/*       → network-only (never cache dynamic API responses)
 */

const CACHE = 'audiochart-v5';
const TILES_CACHE = 'audiochart-tiles-v1';
const TILES_MAX = 800;

// Resources to pre-cache at install time for offline use
const PRECACHE = [
  './index.html',
  './css/app.css',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== TILES_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API or connect page — always hit the network
  // Add ngrok bypass header so the interstitial doesn't replace JSON responses
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/connect') {
    if (url.hostname.includes('ngrok')) {
      event.respondWith(fetch(event.request, {
        headers: { ...Object.fromEntries(event.request.headers), 'ngrok-skip-browser-warning': '1' },
      }));
    }
    return;
  }

  // Tiles: cache-first
  if (url.pathname.match(/\/tiles\/\d+\/\d+\/\d+\.jpg$/)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Everything else (JS, CSS, HTML, GeoJSON): network-first, cache fallback
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return cache.match('./index.html');
    }
    return new Response('', { status: 503 });
  }
}

async function tileStrategy(request) {
  const cache = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      if (keys.length > TILES_MAX) {
        await Promise.all(keys.slice(0, keys.length - TILES_MAX).map((k) => cache.delete(k)));
      }
    }
    return response;
  } catch (_) {
    return new Response('', { status: 503 });
  }
}
