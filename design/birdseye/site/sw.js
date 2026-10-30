// Ted's Birdseye (v1070): keeps this little page, its manifest and icons for offline use. The view inside it is
// AudioChart's Bird's-eye, kept offline by AudioChart's own service worker.
const CACHE = 'birdseye-shell-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/birdseye-192.png', './icons/birdseye-512.png', './icons/birdseye-180.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('birdseye-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
