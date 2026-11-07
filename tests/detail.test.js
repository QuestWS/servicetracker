import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { loadBackend } from './helpers/apps-script-stubs.js';

const KEY = 'test-winter-key-test-winter-key-0001';
// Built in two halves: verify.sh holds the real /exec URL to config.js alone.
const TRACKER_URL = 'https://script.google.com/' + 'macros/s/AKfycbTRACKER/exec';
let backend;
let admin;
let pushed;
let winterUnits;

function load() {
  pushed = [];
  winterUnits = [{
    qn: 'QW-26-1255', name: 'White, John', phone: '(815) 555-0100', email: 'john@example.com', unit: 'Boat',
    ymm: '2018 Demo 21', dims: "21' x 8'6\"", loa: 21, beam: 8.5, stateLabel: 'Stored',
    items: [
      { l: 'Wash & wax', s: 'awaiting', a: 336 },
      { l: "Powerwash hull (21')", s: 'quoted', a: 118.86 },
      { l: 'Shrinkwrap', s: 'quoted', a: 400 },
      { l: 'Bottom paint touch-up', s: 'open', a: null },
    ],
  }];
  backend = loadBackend({
    properties: { ADMIN_PASSWORD: 'pw', WINTER_KEY: KEY, TEST_MODE: 'false' },
    fetch: (url, opts) => {
      if (/script\.google\.com/.test(url)) {
        const body = JSON.parse(opts.payload);
        if (body.fn === 'details') return { code: 200, body: { ok: 1, _api: 'tracker', at: 'now', units: winterUnits } };
        return { code: 200, body: { ok: 1, _api: 'tracker', changed: 1 } };
      }
      if (/push|fcm/.test(url)) pushed.push({ url, opts });
      return { code: 201, body: '' };
    },
  });
  admin = backend.fn('adminSignIn', 'pw').token;
}

const JOHN = 'john@questwatersports.com';
const SERVICE = 'service@questwatersports.com';
/** Mail to the customer — not John's or the desk's alerts. */
const toCustomer = () => backend.sentMail.filter((m) => m.to !== JOHN && m.to !== SERVICE);
const mech = () => backend.fn('mechanicSignIn', 'Dale', true).token;
const detailer = () => backend.fn('mechanicSignIn', 'John', true).token;

function newDetail(extra = {}) {
  return backend.fn('createDetail', detailer(), {
    customerName: 'Pat Harbor', customerPhone: '815-555-0142', customerEmail: 'pat@example.com',
    unit: '2019 Malibu 22', loa: 22, beam: 8.5, notes: 'Owner wants it by Friday',
    items: [
      { key: 'washWax', label: 'Wash & wax', price: 352 },
      { key: 'premiumInt', label: 'Premium detail — interior', price: null },
    ],
    ...extra,
  }).detail;
}

beforeEach(load);

describe('the detail board', () => {
  it('takes in a request and shows it on the board, priced lines and unpriced', () => {
    const d = newDetail();
    expect(d.source).toBe('request');
    expect(d.stage).toBe('price');
    expect(d.createdBy).toBe('John');
    const board = backend.fn('detailBoard', admin, '');
    expect(board.details.map((x) => x.id)).toEqual([d.id]);
    expect(board.events[0].text).toMatch(/Pat Harbor/);
  });

  it('answers "same" to a board that is already up to date, off one property read', () => {
    newDetail();
    const first = backend.fn('detailBoard', admin, '');
    const again = backend.fn('detailBoard', admin, first.v);
    expect(again).toEqual({ same: true, v: first.v });
    newDetail({ customerName: 'Sam Lot' });
    expect(backend.fn('detailBoard', admin, first.v).same).toBeUndefined();
  });

  it('refuses anybody not signed in', () => {
    expect(() => backend.fn('detailBoard', 'nope', '')).toThrow(/Sign in/);
    expect(() => backend.fn('createDetail', '', { customerName: 'x', items: [{ label: 'a' }] })).toThrow();
  });

  it('ticks lines, starts on the first, and finishes', () => {
    const d = newDetail({ items: [{ key: 'washWax', label: 'Wash & wax', price: 352 }, { key: 'trailer', label: 'Trailer', price: 44 }] });
    const t = detailer();
    const after = backend.fn('setDetailItemDone', t, d.id, d.items[0].id, true).detail;
    expect(after.status).toBe('in_progress');
    expect(after.left).toBe(1);
    const done = backend.fn('finishDetail', t, d.id).detail;
    expect(done.status).toBe('done');
    expect(done.items.every((x) => x.done && x.done.by === 'John')).toBe(true);
  });
});

describe('a detail quote, waiting on the customer', () => {
  function quoted() {
    const d = newDetail({ items: [
      { key: 'washWax', label: 'Wash & wax', price: 352 },
      { key: 'premiumInt', label: 'Premium detail — interior', price: 450 },
      { key: 'trailer', label: 'Trailer', price: 44 },
    ] });
    const q = backend.fn('quoteDetail', admin, d.id, [d.items[0].id, d.items[1].id]);
    return { d: q.detail, text: q.text };
  }

  it('will not quote a line with no price', () => {
    const d = newDetail();
    expect(() => backend.fn('quoteDetail', admin, d.id, [])).toThrow(/price/);
  });

  it('mints one code, marks the lines pending and sends nothing', () => {
    const { d, text } = quoted();
    expect(d.quoteCode).toMatch(/^[0-9A-Z]{8}$/);
    expect(d.stage).toBe('waiting');
    expect(text).toContain('/q/?c=' + d.quoteCode);
    expect(text).not.toMatch(/boat/i);
    expect(toCustomer()).toHaveLength(0);
    // A re-quote keeps the link already in their inbox.
    const again = backend.fn('quoteDetail', admin, d.id, [d.items[2].id]).detail;
    expect(again.quoteCode).toBe(d.quoteCode);
  });

  it('shows the customer only the lines sent to them, and nothing of the shop\'s', () => {
    const { d } = quoted();
    const page = backend.fn('detailQuote', d.quoteCode.toLowerCase());
    expect(page.quote.lines.map((x) => x.label)).toEqual(['Wash & wax', 'Premium detail — interior']);
    const wire = JSON.stringify(page);
    for (const secret of ['Owner wants it by Friday', 'John', 'pat@example.com', '815-555-0142', 'Trailer']) {
      expect(wire).not.toContain(secret);
    }
    expect(backend.fn('detailQuote', 'ZZZZZZZZ').notFound).toBe(true);
  });

  it('takes Accept / Call me in one request, tells the office once, and wakes the phones', () => {
    backend.fn('pushSubscribe', admin, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }, 'counter iPad');
    const { d } = quoted();
    pushed.length = 0;   // the new request's own push is not what this is about
    const out = backend.fn('answerDetailQuote', d.quoteCode, [
      { item: d.items[0].id, choice: 'accepted' },
      { item: d.items[1].id, choice: 'call' },
    ], 'Does it include the cabin?');
    expect(out.saved).toBe(2);
    expect(out.quote.lines.map((x) => x.status)).toEqual(['accepted', 'call']);
    const office = backend.sentMail.filter((m) => m.opts.kind === undefined && /answered/.test(m.subject));
    expect(office).toHaveLength(1);
    expect(office[0].to).toBe(JOHN);
    expect(office[0].opts.cc).toBe(SERVICE);
    expect(office[0].subject).toMatch(/CALL REQUESTED/);
    expect(office[0].opts.htmlBody).toContain('Does it include the cabin?');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].opts.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(pushed[0].opts.payload).toBeUndefined();
    const inbox = backend.fn('pushInbox', admin);
    expect(inbox.note.title).toMatch(/Call requested/);
    expect(inbox.note.text).toMatch(/Pat Harbor/);
    const board = backend.fn('detailBoard', admin, '');
    expect(board.details[0].stage).toBe('call');
    expect(board.details[0].calls).toBe(1);
  });

  it('is idempotent, and an accepted line is not the customer\'s to take back', () => {
    const { d } = quoted();
    backend.fn('answerDetailQuote', d.quoteCode, [{ item: d.items[0].id, choice: 'accepted' }], '');
    const mail = backend.sentMail.length;
    const again = backend.fn('answerDetailQuote', d.quoteCode, [{ item: d.items[0].id, choice: 'accepted' }], '');
    expect(again.saved).toBe(0);
    const back = backend.fn('answerDetailQuote', d.quoteCode, [{ item: d.items[0].id, choice: 'declined' }], '');
    expect(back.saved).toBe(0);
    expect(back.quote.lines[0].status).toBe('accepted');
    expect(backend.sentMail.length).toBe(mail);
  });

  it('can only be answered by POST', () => {
    const { d } = quoted();
    const out = backend.get({ fn: 'answerDetailQuote', args: JSON.stringify([d.quoteCode, [{ item: d.items[0].id, choice: 'accepted' }], '']) });
    expect(out.error).toMatch(/sent, not fetched/);
    expect(backend.fn('detailQuote', d.quoteCode).quote.lines[0].status).toBe('pending');
  });

  it('will not finish while a line is still waiting on the customer', () => {
    const { d } = quoted();
    expect(() => backend.fn('finishDetail', admin, d.id)).toThrow(/waiting on the customer/);
    backend.fn('decideDetailLine', admin, d.id, d.items[0].id, 'accepted');
    backend.fn('decideDetailLine', admin, d.id, d.items[1].id, 'declined');
    const done = backend.fn('finishDetail', admin, d.id).detail;
    expect(done.status).toBe('done');
    expect(done.items[1].done).toBeNull();
    expect(done.total).toBe(352 + 44);
  });

  it('emails the quote only when somebody presses the button, with a link and no answer buttons', () => {
    const { d } = quoted();
    expect(toCustomer()).toHaveLength(0);
    backend.fn('sendDetailQuoteEmail', admin, d.id);
    expect(toCustomer()).toHaveLength(1);
    const m = toCustomer()[0];
    expect(m.to).toBe('pat@example.com');
    expect(m.opts.htmlBody).toContain('/q/?c=' + d.quoteCode);
    expect(m.opts.htmlBody).not.toMatch(/choice=|accept\?/i);
    expect(m.opts.htmlBody).not.toMatch(/\bboat\b/i);
  });

  it('holds the email back in test mode', () => {
    backend.properties.set('TEST_MODE', 'true');
    backend.call('_props = null;');
    const { d } = quoted();
    backend.fn('sendDetailQuoteEmail', admin, d.id);
    const quote = backend.sentMail.find((m) => /detailing quote/.test(m.subject));
    expect(quote.to).not.toBe('pat@example.com');
    expect(quote.subject).toMatch(/TEST/);
  });
});

describe('a split work order', () => {
  function job(id, split) {
    backend.fn('createJob', admin, { invoiceNumber: id, customerName: 'Jane Rivers', customerPhone: '815', boatInfo: '2019 Yamaha 242X' });
    const out = backend.fn('setJobDetail', admin, id, { split, loa: 24, items: [{ key: 'washWax', label: 'Wash & wax', price: 384 }] });
    return { token: backend.fn('jobRow_', id).token, detail: out.detail, job: out.job };
  }

  it('waits for both halves before the writer sees it finished — mechanic first', () => {
    const { token, detail, job: j } = job('01-9001', 'both');
    expect(j.detail).toMatchObject({ split: 'both', waitingOn: 'both' });
    const m = backend.fn('finishWork', mech(), token);
    expect(m.status).toBe('work_underway');
    expect(m.waitingOn).toBe('detail');
    expect(backend.fn('getJob', admin, '01-9001').job.detail.waitingOn).toBe('detail');
    // Off the floor's list: the mechanic is done with it.
    expect(backend.fn('openJobs', mech(), true).jobs.map((x) => x.id)).not.toContain('01-9001');
    const out = backend.fn('finishDetail', detailer(), detail.id);
    expect(out.jobNote).toMatch(/ready to close out/);
    expect(backend.fn('getJob', admin, '01-9001').job.status).toBe('work_finished');
  });

  it('waits for both halves — detailer first', () => {
    const { token, detail } = job('01-9002', 'both');
    expect(backend.fn('finishDetail', detailer(), detail.id).jobNote).toMatch(/waiting on the mechanic/);
    expect(backend.fn('getJob', admin, '01-9002').job.status).not.toBe('work_finished');
    expect(backend.fn('getJob', admin, '01-9002').job.detail.waitingOn).toBe('mechanic');
    expect(backend.fn('finishWork', mech(), token).status).toBe('work_finished');
  });

  it('asks the writer before closing a ticket with half of it open', () => {
    job('01-9003', 'both');
    const asked = backend.fn('markDone', admin, '01-9003');
    expect(asked.needsConfirm).toBe(true);
    expect(asked.message).toMatch(/neither/);
    expect(backend.fn('getJob', admin, '01-9003').job.status).not.toBe('done');
    backend.fn('markDone', admin, '01-9003', true);
    expect(backend.fn('getJob', admin, '01-9003').job.status).toBe('done');
  });

  it('a detail-only job is the detailer\'s: off the floor\'s list and not theirs to finish', () => {
    const { token, detail } = job('01-9004', 'detail');
    expect(backend.fn('openJobs', mech(), true).jobs.map((x) => x.id)).not.toContain('01-9004');
    expect(() => backend.fn('finishWork', mech(), token)).toThrow(/detailer/);
    backend.fn('finishDetail', detailer(), detail.id);
    expect(backend.fn('getJob', admin, '01-9004').job.status).toBe('work_finished');
  });

  it('a job with no detail behaves exactly as before', () => {
    backend.fn('createJob', admin, { invoiceNumber: '01-9005', customerName: 'A B', boatInfo: 'x' });
    const token = backend.fn('jobRow_', '01-9005').token;
    expect(backend.fn('getJob', admin, '01-9005').job.detail).toBeNull();
    expect(backend.fn('finishWork', mech(), token).status).toBe('work_finished');
    expect(backend.fn('markDone', admin, '01-9005').needsConfirm).toBeUndefined();
  });

  it('taking the detail off cancels it and gives the job back to the mechanic', () => {
    const { detail } = job('01-9006', 'detail');
    const out = backend.fn('setJobDetail', admin, '01-9006', null);
    expect(out.job.detail).toBeNull();
    expect(backend.fn('getDetail', admin, detail.id).detail.status).toBe('cancelled');
  });

  it('editing the lines keeps the ticks already made', () => {
    const { detail } = job('01-9007', 'both');
    backend.fn('setDetailItemDone', detailer(), detail.id, detail.items[0].id, true);
    const out = backend.fn('setJobDetail', admin, '01-9007', { split: 'both', items: [
      { id: detail.items[0].id, key: 'washWax', label: 'Wash & wax', price: 384 },
      { key: 'trailer', label: 'Trailer', price: 48 },
    ] });
    expect(out.detail.items[0].done.by).toBe('John');
    expect(out.detail.items).toHaveLength(2);
    // The first detail tick started the job, like a first log entry.
    expect(out.job.status).toBe('work_underway');
  });
});

describe('winter units with detailing', () => {
  it('lists the winter quotes with detail work, leaving the rest of the quote behind', () => {
    const out = backend.fn('winterDetails', detailer(), true);
    expect(out.units).toHaveLength(1);
    expect(out.units[0].items.map((x) => x.label)).toEqual(['Wash & wax', "Powerwash hull (21')", 'Bottom paint touch-up']);
    expect(out.units[0].items.map((x) => x.quote)).toEqual(['pending', 'accepted', '']);
    expect(out.units[0].items[2].key).toBe('bottomReapply');
  });

  it('pulls a unit onto the board once, and refuses a quote from here', () => {
    backend.fn('winterDetails', detailer(), true);
    const d = backend.fn('pullWinterDetail', detailer(), 'QW-26-1255').detail;
    expect(d.source).toBe('winter');
    expect(d.stage).toBe('waiting');
    expect(backend.fn('pullWinterDetail', detailer(), 'QW-26-1255').existed).toBe(true);
    expect(() => backend.fn('quoteDetail', admin, d.id, [])).toThrow(/winter console/);
  });

  it('takes the winter system\'s ping, with the key, and buzzes the phones', () => {
    backend.fn('pushSubscribe', admin, { endpoint: 'https://web.push.apple.com/abc' }, 'Chris');
    backend.fn('winterDetails', detailer(), true);
    const d = backend.fn('pullWinterDetail', detailer(), 'QW-26-1255').detail;
    const unit = { ...winterUnits[0], items: [{ l: 'Wash & wax', s: 'call', a: 336 }, winterUnits[0].items[1]] };
    expect(backend.api({ api: 'detailPing', key: 'wrong-key-wrong-key-wrong-key-00', unit }).ok).toBe(0);
    const ok = backend.api({ api: 'detailPing', key: KEY, unit });
    expect(ok).toMatchObject({ ok: 1, moved: 1, _api: 'service-tracker' });
    expect(backend.fn('getDetail', admin, d.id).detail.stage).toBe('call');
    expect(pushed.some((p) => /web\.push\.apple\.com/.test(p.url))).toBe(true);
  });

  it('sends the detailer\'s ticks home the way the mechanics\' go', () => {
    backend.fn('winterDetails', detailer(), true);
    const d = backend.fn('pullWinterDetail', detailer(), 'QW-26-1255').detail;
    const wash = d.items.find((x) => /Powerwash/.test(x.label));
    backend.fn('setDetailItemDone', detailer(), d.id, wash.id, true);
    const sent = backend.fetched.filter((f) => /script\.google\.com/.test(f.url) && JSON.parse(f.options.payload).fn === 'winterTicks');
    expect(sent.length).toBeGreaterThan(0);
    const ticks = JSON.parse(sent[sent.length - 1].options.payload).ticks;
    expect(ticks['QW-26-1255'].map((t) => t.label)).toContain("Powerwash hull (21')");
  });
});

describe('web push from Apps Script', () => {
  it('signs a VAPID token that a real ES256 verifier accepts', () => {
    const key = backend.fn('pushKey').key;
    const raw = Buffer.from(key, 'base64url');
    expect(raw).toHaveLength(65);
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    for (let i = 0; i < 3; i++) {
      const jwt = backend.call(`vapidJwt_('https://fcm.googleapis.com/fcm/send/x${i}', vapidKeys_())`);
      const [h, b, sig] = jwt.split('.');
      const ok = crypto.verify('sha256', Buffer.from(h + '.' + b), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
      expect(ok).toBe(true);
      expect(JSON.parse(Buffer.from(b, 'base64url'))).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:service@questwatersports.com' });
    }
  });

  it('hashes like SHA-256', () => {
    for (const text of ['', 'abc', 'x'.repeat(200)]) {
      const ours = backend.call(`b64url_(sha256_(asciiBytes_(${JSON.stringify(text)})))`);
      expect(ours).toBe(crypto.createHash('sha256').update(text).digest('base64url'));
    }
  });

  it('keeps the key once made, and drops a subscription the push service says is gone', () => {
    const k = backend.fn('pushKey').key;
    backend.call('_props = null;');
    expect(backend.fn('pushKey').key).toBe(k);
    expect(backend.properties.get('VAPID_PRIVATE')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('signing in with the Harbor Haul Out staff PIN', () => {
  function withPins() {
    const asked = [];
    backend = loadBackend({
      properties: { ADMIN_PASSWORD: 'pw', WINTER_KEY: KEY, WEB_APP_URL: TRACKER_URL },
      fetch: (url, opts) => {
        const body = JSON.parse(opts.payload);
        asked.push(body);
        if (body.fn === 'staffPin') {
          return { code: 200, body: body.pin === '4821'
            ? { ok: 1, _api: 'tracker', valid: true, name: 'John', admin: false, quote: 1 }
            : { ok: 1, _api: 'tracker', valid: false, error: 'Wrong PIN.' } };
        }
        return { code: 200, body: { ok: 1, _api: 'tracker', units: [] } };
      },
    });
    return asked;
  }

  it('asks the winter system whose PIN it is and signs that person in', () => {
    const asked = withPins();
    const out = backend.fn('detailSignIn', '4821');
    expect(out.who).toEqual({ name: 'John', admin: false, quote: true });
    expect(asked[0]).toMatchObject({ api: 'tracker', fn: 'staffPin', pin: '4821', key: KEY });
    // Tells the winter system where to ping, so nobody has to set it up.
    expect(asked[0].pingUrl).toBe(TRACKER_URL);
    const d = backend.fn('createDetail', out.token, { customerName: 'Pat', items: [{ key: 'washWax', label: 'Wash & wax', price: 1 }] }).detail;
    expect(d.createdBy).toBe('John');
  });

  it('refuses a wrong PIN with the winter system\'s words', () => {
    withPins();
    expect(() => backend.fn('detailSignIn', '0000')).toThrow('Wrong PIN.');
    expect(() => backend.fn('detailSignIn', '')).toThrow(/Enter your PIN/);
  });

  it('is a floor sign-in, not the writer\'s', () => {
    withPins();
    const { token } = backend.fn('detailSignIn', '4821');
    expect(() => backend.fn('listJobs', token, {})).toThrow(/service writer/);
    expect(() => backend.fn('setJobDetail', token, '01-1', null)).toThrow(/service writer/);
  });
});


describe('a quote request, start to finish', () => {
  function request() {
    return backend.fn('createDetail', admin, {
      customerName: 'Pat Harbor', customerPhone: '815-555-0142', customerEmail: 'pat@example.com',
      unit: '2019 Malibu 22', loa: 22, beam: 8.5,
      items: [{ key: 'washWax', label: 'Wash & wax' }, { key: 'carpet', label: 'Carpet cleaning' }],
    }).detail;
  }

  it('emails John that a quote is wanted, with service@ copied, and waits on his prices', () => {
    const d = request();
    expect(d.stage).toBe('price');
    const m = backend.sentMail.find((x) => /quote requested/.test(x.subject));
    expect(m.to).toBe(JOHN);
    expect(m.opts.cc).toBe(SERVICE);
    expect(m.opts.htmlBody).toContain('/d/?detail=' + d.id);
    expect(m.opts.htmlBody).toContain('Carpet cleaning');
  });

  it('a request with prices typed at the desk still waits on John to send it', () => {
    const d = newDetail({ items: [{ key: 'washWax', label: 'Wash & wax', price: 352 }] });
    expect(d.stage).toBe('price');
  });

  it('John prices it and sends it in one press; the customer gets it, and nothing went to them before', () => {
    const d = request();
    expect(toCustomer()).toHaveLength(0);
    expect(() => backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352 }, 'email')).toThrow(/Carpet cleaning/);
    const out = backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'email');
    expect(out.emailed).toBe(true);
    expect(out.detail.stage).toBe('waiting');
    expect(out.detail.items.map((x) => x.price)).toEqual([352, 150]);
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].to).toBe('pat@example.com');
  });

  it('by text, it hands back the words and sends nothing', () => {
    const d = request();
    const out = backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'text');
    expect(out.text).toContain('/q/?c=');
    expect(out.phone).toBe('815-555-0142');
    expect(toCustomer()).toHaveLength(0);
  });

  it('approved, it waits for the work order number; then it is work to do', () => {
    const d = request();
    const sent = backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'email').detail;
    backend.fn('answerDetailQuote', sent.quoteCode, [{ item: d.items[0].id, choice: 'accepted' }, { item: d.items[1].id, choice: 'declined' }], '');
    expect(backend.fn('getDetail', admin, d.id).detail.stage).toBe('ticket');
    const after = backend.fn('linkDetailJob', admin, d.id, '01-8891').detail;
    expect(after.ticketNo).toBe('01-8891');
    expect(after.jobId).toBe('01-8891');
    expect(after.stage).toBe('todo');
  });

  it('declined in full, it says so rather than waiting for a work order', () => {
    const d = request();
    const sent = backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'email').detail;
    backend.fn('answerDetailQuote', sent.quoteCode, d.items.map((x) => ({ item: x.id, choice: 'declined' })), '');
    expect(backend.fn('getDetail', admin, d.id).detail.stage).toBe('declined');
  });

  it('"customer already agreed" skips the quote', () => {
    const d = request();
    const out = backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }).detail;
    expect(out.items.every((x) => x.quote === 'accepted' && x.answeredBy === 'Office')).toBe(true);
    expect(out.stage).toBe('ticket');
    expect(toCustomer()).toHaveLength(0);
  });

  it('done, the desk is emailed to contact the customer and collect, with the ticket and the approved total', () => {
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    backend.fn('linkDetailJob', admin, d.id, '01-8891');
    backend.fn('finishDetail', detailer(), d.id);
    const m = backend.sentMail.find((x) => /Detail done/.test(x.subject));
    expect(m.to).toBe(SERVICE);
    expect(m.subject).toMatch(/collect payment/);
    expect(m.opts.htmlBody).toContain('01-8891');
    expect(m.opts.htmlBody).toContain('$502.00');
    expect(m.opts.htmlBody).toContain('815-555-0142');
  });

  it('a split job still waiting on the mechanic does not tell the desk to collect', () => {
    backend.fn('createJob', admin, { invoiceNumber: '01-9101', customerName: 'Jane Rivers', boatInfo: 'x' });
    const { detail } = backend.fn('setJobDetail', admin, '01-9101', { split: 'both', items: [{ key: 'washWax', label: 'Wash & wax', price: 1 }] });
    backend.fn('finishDetail', detailer(), detail.id);
    expect(backend.sentMail.some((x) => /Detail done/.test(x.subject))).toBe(false);
  });

  it('the work order number makes it a job in the writer\'s portal, detailer only', () => {
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    const out = backend.fn('linkDetailJob', detailer(), d.id, '01-8891');
    expect(out.made).toBe(true);
    const page = backend.fn('getJob', admin, '01-8891');
    expect(page.job).toMatchObject({ customerName: 'Pat Harbor', customerPhone: '815-555-0142', customerEmail: 'pat@example.com',
      boatInfo: '2019 Malibu 22', status: 'received' });
    expect(page.job.detail).toMatchObject({ split: 'detail', waitingOn: 'detail' });
    expect(page.job.workRequested).toMatch(/D-1001/);
    expect(page.job.workRequested).toMatch(/Wash & wax — \$352\.00/);
    expect(page.detailWork.id).toBe(d.id);
    expect(backend.fn('listJobs', admin, { status: 'every' }).jobs.map((j) => j.id)).toContain('01-8891');
    // Off the mechanics' list: it is the detailer's.
    expect(backend.fn('openJobs', mech(), true).jobs.map((j) => j.id)).not.toContain('01-8891');
  });

  it('the detailer marking it done puts it in Work finished for the writer to close out, like a mechanic does', () => {
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    backend.fn('linkDetailJob', admin, d.id, '01-8891');
    backend.fn('finishDetail', detailer(), d.id);
    expect(backend.fn('getJob', admin, '01-8891').job.status).toBe('work_finished');
    const m = backend.sentMail.find((x) => /Detail done/.test(x.subject));
    expect(m.opts.htmlBody).toMatch(/Close out job <b>01-8891<\/b>/);
    // And from there it is an ordinary close-out.
    backend.fn('saveInvoice', admin, '01-8891', '', 'JVBERi0=', { grandTotal: 502, deposits: 0, amountDue: 502 });
    expect(backend.fn('markDone', admin, '01-8891').job.status).toBe('done');
  });

  it('links to a job the writer already loaded through intake instead of making a second', () => {
    backend.fn('createJob', admin, { invoiceNumber: '01-8891', customerName: 'Pat Harbor', boatInfo: 'x' });
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    const out = backend.fn('linkDetailJob', admin, d.id, '8891');
    expect(out.made).toBe(false);
    expect(out.detail.jobId).toBe('01-8891');
    expect(backend.fn('getJob', admin, '01-8891').job.detail.split).toBe('detail');
  });

  it('a detail already finished becomes a job ready to close out', () => {
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    backend.fn('finishDetail', detailer(), d.id);
    backend.fn('linkDetailJob', admin, d.id, '01-8891');
    expect(backend.fn('getJob', admin, '01-8891').job.status).toBe('work_finished');
  });

  it('will not make a job while the customer has not answered', () => {
    const d = request();
    backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'email');
    expect(() => backend.fn('linkDetailJob', admin, d.id, '01-8891')).toThrow(/waiting on the customer/);
  });

  it('intake of the same number later says where the job came from', () => {
    const d = request();
    backend.fn('acceptDetailForCustomer', admin, d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 });
    backend.fn('linkDetailJob', admin, d.id, '01-8891');
    expect(() => backend.fn('createJob', admin, { invoiceNumber: '01-8891', customerName: 'x' })).toThrow(/detail quote D-1001.*stamp it/);
  });
});

describe('the public Request a detail page', () => {
  const ask = (extra = {}) => backend.fn('requestDetailOnline', {
    name: 'Pat Harbor', phone: '(815) 555-0142', email: 'pat@example.com', unit: '2019 Malibu 22', loa: 22, beam: 8.5,
    where: 'In slip B-12', contactBy: 'Text', notes: 'Before Memorial Day please',
    items: [{ key: 'washWax', label: 'Wash & wax', price: 1 }, { key: 'carpet', label: 'Carpet cleaning' }], ...extra,
  });

  it('lands on the board as a quote request, unpriced, and emails John with service@ copied', () => {
    const out = ask();
    expect(out.ok).toBe(true);
    expect(out.ref).toBe('D-1001');
    const d = backend.fn('detailBoard', admin, '').details[0];
    expect(d.stage).toBe('price');
    expect(d.createdBy).toBe('Online request');
    expect(d.items.map((x) => x.price)).toEqual([null, null]);
    expect(d.notes).toMatch(/slip B-12/);
    const m = backend.sentMail.find((x) => /requested online/.test(x.subject));
    expect(m.to).toBe(JOHN);
    expect(m.opts.cc).toBe(SERVICE);
  });

  it('sends the customer a "Hold tight!" with their D-number, what they entered and what they asked for', () => {
    ask();
    const m = backend.sentMail.find((x) => /Hold tight/.test(x.subject));
    expect(m.to).toBe('pat@example.com');
    expect(m.subject).toContain('D-1001');
    for (const bit of ['D-1001', 'Wash &amp; wax', 'Carpet cleaning', '2019 Malibu 22', 'In slip B-12', 'Text', 'Before Memorial Day', '22&#39;', '8&#39; 6&quot;']) {
      expect(m.opts.htmlBody).toContain(bit);
    }
    expect(m.opts.htmlBody).not.toMatch(/\bboat\b/i);
    // And nobody else: John's goes to John, and there is one of each.
    expect(backend.sentMail.filter((x) => x.to === 'pat@example.com')).toHaveLength(1);
  });

  it('holds the Hold tight! in test mode, like every customer email', () => {
    backend.properties.set('TEST_MODE', 'true');
    backend.call('_props = null;');
    ask();
    expect(backend.sentMail.some((x) => x.to === 'pat@example.com')).toBe(false);
    expect(backend.sentMail.find((x) => /Hold tight/.test(x.subject)).subject).toMatch(/^\[TEST\]/);
  });

  it('numbers every quote request, desk or online, and never reuses one', () => {
    expect(ask().ref).toBe('D-1001');
    const desk = backend.fn('createDetail', admin, { customerName: 'Sam', items: [{ key: 'washWax', label: 'Wash & wax' }] }).detail;
    expect(desk.quoteNo).toBe('D-1002');
    backend.fn('setDetailStatus', admin, desk.id, 'cancelled');
    expect(ask({ phone: '815-555-0199', email: 'b@example.com' }).ref).toBe('D-1003');
    const m = backend.sentMail.find((x) => /quote requested/.test(x.subject) && /D-1003/.test(x.subject));
    expect(m.to).toBe(JOHN);
  });

  it('wants a way to reach them and something to do', () => {
    expect(() => ask({ phone: '', email: '' })).toThrow(/phone number or an email/);
    expect(() => ask({ items: [] })).toThrow(/Tick at least one/);
    expect(() => ask({ name: '' })).toThrow(/name/);
  });

  it('thanks a bot and saves nothing', () => {
    expect(ask({ website: 'http://spam' }).ok).toBe(true);
    expect(backend.fn('detailBoard', admin, '').details).toHaveLength(0);
    expect(backend.sentMail).toHaveLength(0);
  });

  it('stops one phone number after three in a day, so it cannot be used to mail somebody', () => {
    ask(); ask(); ask();
    expect(() => ask()).toThrow(/call us/);
  });

  it('can only be sent, never fetched', () => {
    const out = backend.get({ fn: 'requestDetailOnline', args: JSON.stringify([{ name: 'x', phone: '8155550142', items: [{ label: 'a' }] }]) });
    expect(out.error).toMatch(/sent, not fetched/);
  });
});


describe('the shop\'s own detail emails read well', () => {
  it('keeps the notes\' line breaks, labels them, and links to call', () => {
    backend.fn('requestDetailOnline', { name: 'Pat Harbor', phone: '(815) 555-0142', email: 'pat@example.com',
      where: 'In slip B-12', contactBy: 'Text', notes: 'Oxidation on port side', loa: 22, beam: 8.5,
      items: [{ key: 'washWax', label: 'Wash & wax' }] });
    const m = backend.sentMail.find((x) => /requested online/.test(x.subject));
    const html = m.opts.htmlBody;
    expect(html).toContain('<b>Where it is:</b> In slip B-12<br><b>Best way to reach them:</b> Text<br><b>They wrote:</b> Oxidation on port side');
    expect(html).toContain('href="tel:+18155550142"');
    // The logo is shown in the email exactly when it is attached — never a stray attachment.
    expect(html.includes('cid:questlogo')).toBe(!!(m.opts.inlineImages && m.opts.inlineImages.questlogo));
    expect(html).toContain('Price it and send the quote');
    expect(html).toContain("22&#39; long, 8&#39; 6&quot; beam");
  });

  it('puts no emoji in a subject (Outlook showed them as ??????)', () => {
    const d = backend.fn('createDetail', admin, { customerName: 'Pat', customerEmail: 'p@example.com',
      items: [{ key: 'washWax', label: 'Wash & wax' }] }).detail;
    const q = backend.fn('sendDetailQuote', admin, d.id, { [d.items[0].id]: 300 }, 'email').detail;
    backend.fn('answerDetailQuote', q.quoteCode, [{ item: d.items[0].id, choice: 'call' }], 'When?');
    backend.sentMail.forEach((x) => expect(x.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}✅]/u));
    const call = backend.sentMail.find((x) => /^CALL REQUESTED — /.test(x.subject));
    expect(call.opts.htmlBody).toContain('They want a call');
    expect(call.opts.htmlBody).toContain('When?');
  });
});

describe('detail quotes in the writer\'s portal, from the start', () => {
  function priced() {
    const d = backend.fn('createDetail', detailer(), { customerName: 'Pat Harbor', customerPhone: '815-555-0142',
      customerEmail: 'pat@example.com', items: [{ key: 'washWax', label: 'Wash & wax' }, { key: 'carpet', label: 'Carpet cleaning' }] }).detail;
    return backend.fn('sendDetailQuote', detailer(), d.id, { [d.items[0].id]: 352, [d.items[1].id]: 150 }, 'email').detail;
  }

  it('is on the jobs list\'s answer from the moment it is taken in', () => {
    const d = backend.fn('createDetail', detailer(), { customerName: 'Pat Harbor', items: [{ key: 'washWax', label: 'Wash & wax' }] }).detail;
    const list = backend.fn('listJobs', admin, { status: 'every', fresh: true });
    expect(list.detailQuotes.map((x) => x.id)).toEqual([d.id]);
    expect(list.detailQuotes[0].stage).toBe('price');
    expect(list.detailWaiting).toHaveLength(0);
  });

  it('leaves it off once it is a job — the job is on the list then', () => {
    const d = priced();
    backend.fn('decideDetailLines', admin, d.id, 'all', 'accepted', '');
    backend.fn('linkDetailJob', admin, d.id, '01-8891');
    expect(backend.fn('listJobs', admin, { status: 'every', fresh: true }).detailQuotes).toHaveLength(0);
  });

  it('the writer records the customer\'s yes for everything from a phone call, and John hears it', () => {
    const d = priced();
    const before = backend.sentMail.length;
    const out = backend.fn('decideDetailLines', admin, d.id, 'all', 'accepted', 'Said yes on the phone').detail;
    expect(out.items.every((x) => x.quote === 'accepted' && x.answeredBy === 'Office')).toBe(true);
    expect(out.stage).toBe('ticket');
    const m = backend.sentMail.slice(before).find((x) => /Detail quote answered/.test(x.subject));
    expect(m.to).toBe(JOHN);
    expect(m.opts.cc).toBe(SERVICE);
    expect(m.opts.htmlBody).toContain('recorded by Office');
    expect(m.opts.htmlBody).toContain('Said yes on the phone');
  });

  it('"have John call" on one line emails John with what they asked', () => {
    const d = priced();
    backend.fn('decideDetailLines', admin, d.id, [d.items[1].id], 'call', 'Wants to know if the cabin is included');
    const m = backend.sentMail.find((x) => /^CALL REQUESTED/.test(x.subject));
    expect(m.to).toBe(JOHN);
    expect(m.opts.htmlBody).toContain('Wants to know if the cabin is included');
    expect(backend.fn('getDetail', admin, d.id).detail.stage).toBe('call');
  });

  it('keeps notes from whoever took the call, with their name', () => {
    const d = priced();
    backend.fn('addDetailNote', admin, d.id, 'Called back, left a voicemail');
    const ev = backend.fn('getDetail', admin, d.id).events[0];
    expect(ev).toMatchObject({ kind: 'note', text: 'Called back, left a voicemail', actor: 'Office' });
    expect(() => backend.fn('addDetailNote', admin, d.id, '  ')).toThrow(/Write the note/);
  });

  it('says so when nothing is left to answer', () => {
    const d = priced();
    backend.fn('decideDetailLines', admin, d.id, 'all', 'declined', '');
    expect(() => backend.fn('decideDetailLines', admin, d.id, 'all', 'accepted', '')).toThrow(/Nothing on this quote/);
  });
});
