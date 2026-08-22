/*
 * Service worker for the mechanic PWA.
 *
 * Scope is deliberately narrow: keep the app shell installable and instantly
 * openable in a shop with patchy wifi, and stay out of the way of everything
 * that touches job data. Log entries are never queued offline — a mechanic
 * needs to know their note actually landed, so a failed save surfaces as a
 * visible error instead of a silent "saved".
 */
const VERSION = 'quest-shell-v2';

// Everything the mechanic app needs to paint its first screen. The scanner's
// ZXing fallback is deliberately absent: it is a third of a megabyte that
// only Safari ever loads, and only once someone opens the camera.
const SHELL = [
  'm/',
  'assets/app.css',
  'assets/quest-mark.png',
  'assets/icons/icon-192.png',
  'assets/lib/api.js',
  'assets/lib/config.js',
  'assets/lib/entry-types.js',
  'assets/lib/tracking.js',
  'assets/lib/ui.js',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((path) => new URL(path, self.registration.scope).href)))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Job data lives at script.google.com and Drive serves the photos. Neither
  // is ours to cache, and stale job data would be worse than none.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(new URL('m/', self.registration.scope).href))),
    );
    return;
  }

  if (/\.(?:css|js|mjs|png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy));
        return response;
      })),
    );
  }
});
