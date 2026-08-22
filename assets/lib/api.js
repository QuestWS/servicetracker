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

export async function api(fn, args) {
  if (!API_URL || API_URL.indexOf('PASTE') === 0) {
    throw new ApiError('This site is not connected to its backend yet — see assets/lib/config.js.');
  }
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn, token: storedToken(), args: args || [] }),
    });
  } catch {
    throw new ApiError('No connection to the shop server. Nothing was saved.');
  }
  if (!res.ok) throw new ApiError(`The shop server answered ${res.status}. Nothing was saved.`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('The shop server sent something unreadable. Nothing was saved.');
  }
  if (body && body.error) {
    if (String(body.error).indexOf('Sign in') === 0) clearSession();
    throw new ApiError(body.error);
  }
  return body;
}
