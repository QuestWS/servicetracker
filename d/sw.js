/*
 * Service worker for the Detail Tracker. Two jobs, and only two:
 *
 *  - Make the app installable, which on an iPhone is what allows a web page
 *    to receive notifications at all.
 *  - Answer a push. The push carries no words (Apps Script cannot encrypt a
 *    payload — see the Web Push section of service-tracker.gs), so this asks
 *    the server what happened, using the sign-in the page left in Cache
 *    Storage, and shows that. If it cannot ask, it still shows something:
 *    a browser may take notifications away from a worker that stays silent.
 *
 * It caches no pages. Every fetch goes to the network as if it were not here,
 * which is the lesson the mechanic app's worker learned the hard way about
 * new pages meeting old modules.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function whatHappened() {
  try {
    const c = await caches.open('detail-auth');
    const res = await c.match('auth');
    if (!res) return null;
    const { token, api } = await res.json();
    const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: 'pushInbox', token, args: [] }) });
    const body = await r.json();
    return body && body.note ? body.note : null;
  } catch (err) {
    return null;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const note = await whatHappened();
    const title = (note && note.title) || 'Detail Tracker';
    const body = (note && note.text) || 'Something changed on the detail board.';
    const url = new URL(note && note.detailId ? '?detail=' + encodeURIComponent(note.detailId) : './', self.registration.scope).href;
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    open.forEach((c) => c.postMessage({ type: 'pushed' }));
    await self.registration.showNotification(title, {
      body, tag: 'detail-' + ((note && note.detailId) || 'board'), renotify: true,
      icon: '../assets/icons/icon-192.png', badge: '../assets/icons/icon-192.png', data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => c.url.startsWith(self.registration.scope));
    if (here) { await here.focus(); return here.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
