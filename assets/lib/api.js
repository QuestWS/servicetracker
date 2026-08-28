/**
 * The one door to the backend.
 *
 * Every call is a POST with `Content-Type: text/plain`. That is not a
 * mistake: it keeps the request "simple" in CORS terms, so the browser skips
 * the preflight OPTIONS that an Apps Script web app cannot answer. The winter
 * services console talks to its backend exactly this way.
 */
import { API_URL } from './config.js';

const TOKEN_KEY = 'qst_token';
const WHO_KEY = 'qst_who';

export function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * `remember` decides which bucket the token lands in: a mechanic's own phone
 * keeps it across days, the shared shop iPad forgets at the end of the shift.
 */
export function storeSession(token, who, remember) {
  try {
    const store = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    other.removeItem(TOKEN_KEY);
    other.removeItem(WHO_KEY);
    store.setItem(TOKEN_KEY, token);
    store.setItem(WHO_KEY, JSON.stringify(who));
  } catch {
    /* Private browsing: the session lasts as long as the page does. */
  }
}

export function storedWho() {
  try {
    return JSON.parse(localStorage.getItem(WHO_KEY) || sessionStorage.getItem(WHO_KEY) || 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(WHO_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(WHO_KEY);
  } catch {
    /* nothing to clear */
  }
}

export class ApiError extends Error {}

/**
 * How long each call actually took, because "it feels slow" cannot be fixed
 * and a number can.
 *
 * `ms` is the whole round trip as the phone experienced it. `serverMs` is
 * what Apps Script spent between receiving the request and answering it. The
 * gap between the two is start-up, the redirect Apps Script answers a POST
 * with, and the shop's wifi — none of which any amount of tidying the
 * spreadsheet reads will help.
 */
export const timings = [];
const TIMING_KEEP = 12;
const listeners = [];

export function onApiTiming(handler) {
  listeners.push(handler);
}

function record(entry) {
  timings.push(entry);
  if (timings.length > TIMING_KEEP) timings.shift();
  listeners.forEach((handler) => {
    try {
      handler(entry);
    } catch {
      /* A diagnostic must never break the call it was measuring. */
    }
  });
}

export async function api(fn, args) {
  if (!API_URL || API_URL.indexOf('PASTE') === 0) {
    throw new ApiError('This site is not connected to its backend yet — see assets/lib/config.js.');
  }
  const started = Date.now();
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn, token: storedToken(), args: args || [] }),
    });
  } catch {
    record({ fn, ms: Date.now() - started, serverMs: null, ok: false });
    throw new ApiError('No connection to the shop server. Nothing was saved.');
  }
  if (!res.ok) {
    record({ fn, ms: Date.now() - started, serverMs: null, ok: false });
    throw new ApiError(`The shop server answered ${res.status}. Nothing was saved.`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    record({ fn, ms: Date.now() - started, serverMs: null, ok: false });
    throw new ApiError('The shop server sent something unreadable. Nothing was saved.');
  }
  record({
    fn,
    ms: Date.now() - started,
    serverMs: body && typeof body.serverMs === 'number' ? body.serverMs : null,
    ok: !(body && body.error),
  });
  if (body && body.error) {
    if (String(body.error).indexOf('Sign in') === 0) clearSession();
    throw new ApiError(body.error);
  }
  return body;
}
