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
    // Saved screens follow the token: none may outlive it in the other bucket.
    dropCopies(other);
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

/**
 * Signing out: the token, and every screen saved under it. Somebody tapping
 * "Not you?" on the shop iPad is handing it to the next person.
 */
export function clearSession() {
  dropToken();
  try {
    dropCopies(localStorage);
    dropCopies(sessionStorage);
  } catch {
    /* nothing to clear */
  }
}

/**
 * A session that has merely EXPIRED keeps its saved screens. They are only
 * ever read while a token is held, so nothing shows until the mechanic signs
 * in again — and then the morning does not start blank.
 */
function dropToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(WHO_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(WHO_KEY);
  } catch {
    /* nothing to clear */
  }
}

/* ------------------------------------------------------ saved screens --- */
/*
 * The last open-jobs list and the last job screens the phone was shown, so
 * the next open draws at once and refreshes behind. See the mechanic-app
 * skill for the rules; the ones that live here:
 *
 *  - they sit in THE SAME BUCKET AS THE TOKEN. The list is every customer's
 *    name and boat, which is why it is behind sign-in: the shared iPad keeps
 *    its token in sessionStorage and forgets it at the end of the shift, and
 *    it forgets these with it. A mechanic's own phone keeps both.
 *  - nothing is read without a token held, and sign-out drops the lot.
 *  - only what the server said is ever saved. The callers make sure of that.
 */
const COPY_PREFIX = 'qst_copy_';
const JOBS_KEPT = 40;

function tokenBucket() {
  try {
    if (localStorage.getItem(TOKEN_KEY)) return localStorage;
    if (sessionStorage.getItem(TOKEN_KEY)) return sessionStorage;
  } catch {
    /* storage blocked */
  }
  return null;
}

function dropCopies(store) {
  const doomed = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && key.indexOf(COPY_PREFIX) === 0) doomed.push(key);
  }
  doomed.forEach((key) => store.removeItem(key));
}

function readCopy(key) {
  const store = tokenBucket();
  if (!store) return null;
  try {
    return JSON.parse(store.getItem(COPY_PREFIX + key) || 'null');
  } catch {
    return null;
  }
}

function writeCopy(key, value) {
  const store = tokenBucket();
  if (!store) return;
  try {
    store.setItem(COPY_PREFIX + key, JSON.stringify(value));
  } catch {
    /* Full or blocked: the next open is simply not instant. */
  }
}

/**
 * A named copy, with when it was saved: {value, at}. What the writer's portal
 * keeps — the jobs list, the parts list and so on — under one name each.
 */
export function savedCopy(name) {
  const copy = readCopy(`v_${name}`);
  return copy && copy.value !== undefined ? copy : null;
}

export function saveCopy(name, value) {
  writeCopy(`v_${name}`, { value, at: Date.now() });
}

/**
 * One of several copies of a kind — a job page per job — keeping only the
 * `keep` most recently saved. A job page is big, and a browser's storage is
 * not: the ones the writer is working through are the ones worth keeping.
 */
export function savedOneOf(kind, key) {
  const index = readCopy(`i_${kind}`) || [];
  if (index.indexOf(String(key)) === -1) return null;
  return savedCopy(`${kind}_${key}`);
}

export function saveOneOf(kind, key, value, keep) {
  const store = tokenBucket();
  if (!store) return;
  const wanted = String(key);
  let index = (readCopy(`i_${kind}`) || []).filter((k) => k !== wanted);
  index.unshift(wanted);
  index.slice(keep).forEach((k) => {
    try { store.removeItem(`${COPY_PREFIX}v_${kind}_${k}`); } catch { /* gone */ }
  });
  index = index.slice(0, keep);
  saveCopy(`${kind}_${wanted}`, value);
  writeCopy(`i_${kind}`, index);
}

/** {jobs, at} — the last list the server gave this phone, and when. */
export function savedOpenJobs() {
  const copy = readCopy('openjobs');
  return copy && Array.isArray(copy.jobs) ? copy : null;
}

export function saveOpenJobs(jobs) {
  writeCopy('openjobs', { jobs, at: Date.now() });
}

/**
 * The last full job screen for a job, found by its token (what a QR scan
 * hands over) or its number (what the list and a typed lookup know).
 */
export function savedJob(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const index = readCopy('jobs') || [];
  const hit = index.find((row) => row.token === wanted || String(row.id).toUpperCase() === wanted);
  if (!hit) return null;
  const copy = readCopy(`job_${hit.token}`);
  return copy && copy.job && copy.job.token === hit.token ? copy : null;
}

/** `job` and `hours` exactly as the server answered them — never a list row. */
export function saveJob(job, hours) {
  if (!job || !job.token) return;
  const store = tokenBucket();
  if (!store) return;
  const token = String(job.token).toUpperCase();
  let index = (readCopy('jobs') || []).filter((row) => row.token !== token);
  index.unshift({ token, id: job.id });
  // A phone that has opened a hundred jobs does not need a hundred copies.
  index.slice(JOBS_KEPT).forEach((row) => {
    try { store.removeItem(`${COPY_PREFIX}job_${row.token}`); } catch { /* gone */ }
  });
  index = index.slice(0, JOBS_KEPT);
  writeCopy(`job_${token}`, { job, hours: hours || null, at: Date.now() });
  writeCopy('jobs', index);
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

/**
 * What every real answer from the backend carries (API_STAMP_ in
 * service-tracker.gs). A reply without it is not an answer.
 *
 * A POST can reach Apps Script with its body gone, and it is then handed to
 * doGet, whose health check says `{ok: true}`. Read as success, that took a
 * mechanic's note out of the outbox and put nothing in its place — never
 * saved, and no trace left to say so. So an unstamped reply is treated like a
 * dropped connection: a read asks again by the other road, a write fails
 * loudly and stays in the outbox, where its client id settles whether it
 * landed.
 */
const STAMP = 'service-tracker';

/**
 * The reads that may go round by GET when the POST is slow — the same list as
 * API_GET_FNS_ in the backend, which refuses anything else on GET regardless.
 * Everything not named here is a write, and a write is only ever sent once.
 */
const READS = new Set([
  'ping', 'roster', 'lookupJob', 'jobForMechanic', 'jobLog', 'jobProps', 'openJobs', 'transcriptsFor', 'winterWork',
  // the writer's portal
  'listJobs', 'getJob', 'jobHistory', 'listParts', 'listArchivedParts', 'listProps', 'listMechanics',
  'listOpenStatements', 'listSentStatements', 'listStatementDrafts', 'config', 'sheetStatus',
]);

/**
 * How long a read waits on its POST before asking by GET as well.
 *
 * Measured on the shop's phones' cousins in the winter services app: the
 * server answered in about a second while the phone waited fifty, stuck
 * behind a first attempt that had stalled on weak signal and was going to
 * take the browser's full timeout to give up. Six seconds is well past a
 * normal answer and far short of that.
 */
export const HEDGE_MS = 6000;

/**
 * The server could not be reached, or its reply was not an answer — as
 * opposed to a real answer saying no. Only this is a reason to keep showing a
 * saved copy: "No such job" from the server means the copy is wrong.
 */
export class NoAnswer extends ApiError {}
const NotAnAnswer = NoAnswer;

/** One road, POST or GET. Resolves only with a stamped reply. */
async function road(method, fn, args, options) {
  const payload = { fn, token: storedToken(), args: args || [] };
  let res;
  try {
    if (method === 'GET') {
      const query = new URLSearchParams({ fn, token: payload.token, args: JSON.stringify(payload.args) });
      res = await fetch(`${API_URL}${API_URL.indexOf('?') === -1 ? '?' : '&'}${query}`, { method: 'GET' });
    } else {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign(payload, options && options.jobPage ? { jobPage: options.jobPage } : {})),
      });
    }
  } catch {
    throw new NotAnAnswer('No connection to the shop server. Nothing was saved.');
  }
  if (!res.ok) throw new NotAnAnswer(`The shop server answered ${res.status}. Nothing was saved.`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new NotAnAnswer('The shop server sent something unreadable. Nothing was saved.');
  }
  if (!body || body._api !== STAMP) {
    throw new NotAnAnswer('The shop server\'s answer went missing on the way back, so this may not have saved.');
  }
  return body;
}

/**
 * A read, asked a second way rather than waited out.
 *
 * POST first, as always. No answer in HEDGE_MS and the same read goes by GET
 * too; either road failing outright starts the other at once. The first real
 * answer wins and the other is ignored when it lands. Only when both roads
 * have failed does the call fail.
 */
function hedged(fn, args, options) {
  return new Promise((resolve, reject) => {
    let done = false;
    let getting = false;
    let failures = 0;
    let timer = null;
    const win = (roadName) => (body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ body, road: roadName });
    };
    const lose = (error) => {
      failures += 1;
      if (done) return;
      if (!getting) return viaGet();
      if (failures >= 2) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    };
    const viaGet = () => {
      if (getting || done) return;
      getting = true;
      road('GET', fn, args, options).then(win('get'), lose);
    };
    road('POST', fn, args, options).then(win('post'), lose);
    timer = setTimeout(viaGet, (options && options.hedgeMs) || HEDGE_MS);
  });
}

/**
 * `options.jobPage` is a job id: the writer's job page, read fresh after the
 * call, comes back on the answer as `jobPage`. One round trip for a save and
 * the page it lands on, instead of the save and then a getJob. See
 * withJobPage_ in the backend. A call asking for that is sent once, by POST.
 */
export async function api(fn, args, options) {
  if (!API_URL || API_URL.indexOf('PASTE') === 0) {
    throw new ApiError('This site is not connected to its backend yet — see assets/lib/config.js.');
  }
  const started = Date.now();
  const read = READS.has(fn) && !(options && options.jobPage);
  let body;
  let wonBy = 'post';
  try {
    if (read) {
      ({ body, road: wonBy } = await hedged(fn, args, options));
    } else {
      body = await road('POST', fn, args, options);
    }
  } catch (error) {
    record({ fn, ms: Date.now() - started, serverMs: null, ok: false, road: null });
    throw error instanceof ApiError ? error : new ApiError(String(error && error.message || error));
  }
  record({
    fn,
    ms: Date.now() - started,
    serverMs: typeof body.serverMs === 'number' ? body.serverMs : null,
    ok: !body.error,
    road: wonBy,
  });
  if (body.error) {
    if (String(body.error).indexOf('Sign in') === 0) dropToken();
    throw new ApiError(body.error);
  }
  return body;
}
