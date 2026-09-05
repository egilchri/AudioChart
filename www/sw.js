/** @version v513 */
/* Bump this comment on every release, even when nothing else in this file
   changes — a service worker only gets reinstalled when its own script
   bytes differ from what's currently active (see the v505 fix), so a
   version bump that leaves sw.js byte-identical silently refreezes the
   worker on whatever it was last running. */
/**
 * AudioChart Service Worker — offline caching.
 *
 * Strategy by resource type:
 *   JS/CSS/HTML  → network-first, cache fallback (always fresh when online)
 *   GeoJSON data → network-first, cache fallback
 *   Tile images  → cache-first, network fallback (LRU limited)
 *   /api/*       → network-only (never cache dynamic API responses)
 */

importScripts('./js/version.js');
const CACHE = `audiochart-${APP_VERSION}`;
const TILES_CACHE     = 'audiochart-tiles-v1';      // server nautical tiles, LRU
const SATELLITE_CACHE = 'audiochart-satellite-v1'; // pre-downloaded ESRI tiles, persistent
const LOWTIDE_CACHE   = 'audiochart-lowtide-v1';   // Maine GeoLibrary low-tide orthoimagery, persistent
const CHART_CACHE     = 'audiochart-chart-v1';     // OSM + OpenSeaMap chart tiles
// Web Share Target handoff (see app.js's matching _importSharedGpx for the pickup side).
// Deliberately unversioned/stable — must survive an activate() that races the share flow.
const SHARE_CACHE = 'audiochart-share-target';
const SHARE_PAYLOAD_KEY = './shared-gpx-payload';
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
          .filter((k) => k !== CACHE && k !== TILES_CACHE && k !== SATELLITE_CACHE && k !== LOWTIDE_CACHE && k !== CHART_CACHE && k !== SHARE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;
  const url = new URL(event.request.url);

  // Web Share Target: another app (e.g. Navionics) shared a GPX file to us via
  // the OS share sheet. Handle it fully offline — never let this reach the network.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-gpx')) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

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

  // Static marketing landing pages (/sailors/, /developers/) sit alongside the
  // app under this same origin/scope but aren't part of it — leave them alone
  // entirely rather than let the app's networkFirst() cache them into
  // audiochart-${APP_VERSION} or, worse, serve the app's own offline-fallback
  // index.html for them if a visitor is offline and hasn't loaded them before.
  if (url.pathname.startsWith('/sailors/') || url.pathname.startsWith('/developers/')) {
    return;
  }

  // OSM + OpenSeaMap chart tiles
  if (url.hostname === 'tile.openstreetmap.org' ||
      url.hostname === 'tiles.openseamap.org') {
    event.respondWith(chartTileStrategy(event.request));
    return;
  }

  // Server nautical tiles, ESRI satellite tiles, and Maine's low-tide orthoimagery
  if (url.pathname.match(/\/tiles\/\d+\/\d+\/\d+\.jpg$/) ||
      url.hostname.includes('arcgisonline.com') ||
      (url.hostname === 'gis.maine.gov' && url.pathname.includes('/exportImage'))) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Everything else (JS, CSS, HTML, GeoJSON): network-first, cache fallback
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // no-store: this fetch is the whole "network-first" promise — without it,
    // the browser's own HTTP disk cache can silently satisfy this call with a
    // stale response, so "network-first" quietly becomes "browser-cache-first"
    // underneath the version-keyed Cache Storage layer this function manages.
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok && request.method === 'GET') {
      cache.put(request, response.clone());
      return response;
    }
    // Non-ok response (e.g. 503 from a dead server): fall back to cache
    const cached = await cache.match(request);
    if (cached) return cached;
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

// Reads the shared file out of the POST, stashes it in Cache Storage, then
// 303-redirects to a plain GET the browser will actually navigate to — a
// service worker can't hand data straight into a page (none exists yet at
// this point, and app.js's importer isn't reachable via window anyway since
// it's an ES module). 303 (not 302) guarantees the browser follows up with a
// GET rather than re-POSTing.
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('gpxfile');
    const text = file ? await file.text() : '';
    const cache = await caches.open(SHARE_CACHE);
    if (text) {
      await cache.put(SHARE_PAYLOAD_KEY, new Response(text, { headers: { 'Content-Type': 'text/plain' } }));
    } else {
      await cache.delete(SHARE_PAYLOAD_KEY);
    }
  } catch (_) {
    // Fall through anyway; app.js reports "no shared file" itself on a cache miss.
  }
  return Response.redirect('./?shared-gpx=1', 303);
}

async function chartTileStrategy(request) {
  const cache  = await caches.open(CHART_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    return new Response('', { status: 503 });
  }
}

async function tileStrategy(request) {
  const reqUrl = new URL(request.url);
  const isEsri = reqUrl.hostname.includes('arcgisonline.com');
  const isLowTide = reqUrl.hostname === 'gis.maine.gov';

  if (isEsri || isLowTide) {
    // Satellite and low-tide orthoimagery: persistent cache, no LRU eviction —
    // deliberately-curated imagery a user chose to view/download, not the
    // incidental churn of panning around that the generic tile cache below
    // is meant to bound.
    const persistent = await caches.open(isEsri ? SATELLITE_CACHE : LOWTIDE_CACHE);
    const hit = await persistent.match(request);
    if (hit) return hit;
    try {
      const response = await fetch(request);
      if (response.ok) await persistent.put(request, response.clone());
      return response;
    } catch (_) {
      return new Response('', { status: 503 });
    }
  }

  // Server nautical tiles: LRU-limited cache
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
