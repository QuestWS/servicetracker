/**
 * The outbox: saves that have not made it to the backend yet, kept on the
 * device so they survive the app going away.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────
 * The save queue used to live entirely in memory — a promise chain in a
 * module variable, and a pending object in the page's state. Everything in
 * that sentence dies when the page unloads. Backing out of the installed PWA,
 * switching apps and letting the phone reclaim it, locking the screen at the
 * wrong moment: the chain stopped mid-flight and the note went with it. The
 * feed had already shown the entry, so the mechanic believed it saved.
 *
 * The service worker says log entries are never queued offline, because "a
 * mechanic needs to know their note actually landed". That instinct is right
 * and refusing to persist inverted it: destroying the evidence along with the
 * queue is what made a failure invisible. Nobody found out. The answer is to
 * persist AND surface — see drain() and what the app does with what it
 * returns.
 *
 * ── WHY INDEXEDDB ──────────────────────────────────────────────────────
 * Photos and voice notes are Blobs and IndexedDB stores them natively.
 * localStorage is string-only, synchronous and about 5MB: base64-ing a
 * five-photo entry into it would block the UI on the way to blowing the
 * quota.
 *
 * ── WHAT CALLERS MUST HONOUR ───────────────────────────────────────────
 * A record is written BEFORE the network call and deleted only once the
 * server's answer is in hand. Anything else — a timeout, a dropped
 * connection, the app dying — leaves it queued, which is the entire point.
 *
 * Every record carries a `clientId` generated here. It rides with the save,
 * the backend writes it onto the row, and a retry is matched against it, so
 * asking twice cannot produce two entries. Hours are money; a duplicate
 * labor entry is not a cosmetic problem.
 *
 * Nothing in this file imports anything, so it runs under node in the tests
 * as well as in the browser.
 */

const DB_NAME = 'quest-outbox';
const DB_VERSION = 1;
const STORE = 'outbox';

/** Unguessable is not the point here; unique on one device is. */
export function newClientId() {
  const rand = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `c_${rand}`;
}

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB refused'));
  }).catch((err) => {
    // Private browsing, a storage-blocking setting, a browser that has locked
    // the database. Remembering the failure stops every later call queueing
    // behind another attempt that will fail the same way.
    dbPromise = Promise.reject(err);
    throw err;
  });
  return dbPromise;
}

function run(mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let out;
    try {
      out = work(store);
    } catch (err) {
      return reject(err);
    }
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error || new Error('outbox write failed'));
    tx.onabort = () => reject(tx.error || new Error('outbox write aborted'));
  }));
}

/**
 * Put a record in the outbox. Callers await this BEFORE the network call —
 * that await is the instant the note becomes durable.
 */
export function put(record) {
  return run('readwrite', (store) => store.put(record));
}

/** Take it out. Only ever called with the server's answer in hand. */
export function remove(clientId) {
  return run('readwrite', (store) => store.delete(clientId));
}

/** Everything still waiting, oldest first — the order they were written in. */
export function drain() {
  return run('readonly', (store) => store.getAll()).then((rows) => {
    const list = Array.isArray(rows) ? rows.slice() : [];
    list.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    return list;
  });
}

/** Note that an attempt failed, so the app can say how long it has been trying. */
export function markAttempt(clientId, error) {
  return run('readwrite', (store) => {
    const request = store.get(clientId);
    request.onsuccess = () => {
      const row = request.result;
      if (!row) return;
      row.attempts = Number(row.attempts || 0) + 1;
      row.lastError = String(error || '');
      row.lastTriedAt = new Date().toISOString();
      store.put(row);
    };
    return request;
  });
}

/** The mechanic deciding a stuck note is not worth keeping. */
export function discard(clientId) {
  return remove(clientId);
}
