/*
 * Service worker for the mechanic PWA.
 *
 * Scope is deliberately narrow: keep the app installable and openable in a
 * shop with patchy wifi, and stay out of the way of everything that touches
 * job data. A mechanic needs to know their note actually landed, so a failed
 * save surfaces as a visible error instead of a silent "saved".
 *
 * That rule used to be enforced by refusing to hold an unsent entry anywhere,
 * which inverted it. The queue lived in the page, so backing out of the app
 * destroyed the note AND the evidence of it — the feed had already said
 * "saved" and nobody ever found out otherwise. Refusing to persist did not
 * make the failure visible; it made it invisible.
 *
 * An unsent entry is now kept on the device in an IndexedDB outbox
 * (assets/lib/outbox.js) and, on the next launch, is retried AND shown with
 * its time and job. That is the rule above finally honoured: persist and
 * surface. Nothing is queued *silently* — which is what it was always
 * actually about.
 *
 * Note this is not Background Sync and deliberately not: that is Chrome and
 * Android only, and half the shop is on iOS. The outbox is plain IndexedDB
 * and the retry is the app opening.
 *
 * EVERYTHING SAME-ORIGIN IS NETWORK-FIRST, and that is the whole point of
 * this file. It used to serve the page network-first and the JS cache-first,
 * which sounds like a reasonable split and is in fact a trap: on any deploy
 * that touched a shared module, a phone would fetch the NEW m/index.html and
 * then satisfy its imports from the OLD cached modules. An ES module import
 * that names a missing export does not degrade — the whole script fails to
 * evaluate — so the app stopped at "Starting up…" and stayed there. It hit
 * the shop the first time a module grew an export, and it would have hit
 * again every time after.
 *
 * The cache is therefore an offline fallback, not a speed trick. That costs
 * little: this app cannot do anything useful offline anyway — the roster, the
 * job and every save need the backend — so serving stale code fast buys
 * nothing and risks a mechanic holding a dead phone mid-job.
 */
const VERSION = 'quest-shell-v3';

// Everything the mechanic app needs to paint its first screen without a
// network. The scanner's ZXing fallback is deliberately absent: it is a third
// of a megabyte that only Safari ever loads, and only once someone opens the
// camera.
const SHELL = [
  'm/',
  'assets/app.css',
  'assets/quest-mark.png',
  'assets/icons/icon-192.png',
  'assets/lib/api.js',
  'assets/lib/config.js',
  'assets/lib/entry-types.js',
  'assets/lib/outbox.js',
  'assets/lib/tracking.js',
  'assets/lib/ui.js',
  'manifest.webmanifest',
];

const shellUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map(shellUrl)))
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

/**
 * Network first, cache as the fallback, and the cache refreshed on every
 * success — so an online phone always runs one consistent generation of the
 * app, and an offline one runs the last generation that loaded whole.
 */
function fresh(request, offlineFallback) {
  return fetch(request)
    .then((response) => {
      // Only a real answer is worth keeping. A 404 or a captive-portal
      // redirect cached here would outlive the problem that caused it.
      if (response && response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request).then((hit) => {
      if (hit) return hit;
      if (offlineFallback) return caches.match(offlineFallback);
      return Response.error();
    }));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Job data lives at script.google.com and Drive serves the photos. Neither
  // is ours to cache, and stale job data would be worse than none.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fresh(request, shellUrl('m/')));
    return;
  }

  if (/\.(?:css|js|mjs|png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(fresh(request));
  }
});
