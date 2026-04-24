/* Silence · service worker
   Minimal offline cache — app is tiny.
   v1.3.0 — surfaces per-asset install failures to the page
            via postMessage so Diagnostics can show them. */

const CACHE = 'silence-v1-4-0';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './whisper.js',
  './app.js',
  './whisper-worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const results = await Promise.all(ASSETS.map(async (url) => {
      try { await cache.add(url); return { url, ok: true }; }
      catch (err) { return { url, ok: false, error: String(err && err.message || err) }; }
    }));
    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
      self.__cacheInstallErrors = failed;
      try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        clients.forEach(c => c.postMessage({ type: 'sw-install-errors', errors: failed }));
      } catch (_) {}
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => cached)
    )
  );
});
