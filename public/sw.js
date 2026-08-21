/*
 * Service worker for the mechanic PWA.
 *
 * Scope is deliberately narrow: keep the app shell installable and instantly
 * openable in a shop with patchy wifi, and stay out of the way of everything
 * that touches job data. Log entries are never queued offline — a mechanic
 * needs to know their note actually landed, so a failed POST surfaces as a
 * visible error instead of a silent "saved".
 */
const VERSION = 'quest-shell-v1';
const SHELL = ['/m', '/m/offline', '/icons/icon-192.png', '/icons/icon-512.png', '/quest-mark.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Job data, uploads and auth must always come from the network.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (url.pathname === '/m') {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/m/offline'))),
    );
    return;
  }

  if (/\.(?:png|svg|ico|webmanifest|css|woff2?)$/.test(url.pathname) || url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
