import { beforeEach, describe, expect, it } from 'vitest';
import { loadBackend } from './helpers/apps-script-stubs.js';

let backend;
let adminToken;

/** A job with one of every kind of entry logged against it. */
function seedJob(id = '01-8886', { seedLabor = true } = {}) {
  backend.fn('createJob', adminToken, {
    invoiceNumber: id,
    customerName: 'Jane Rivers',
    customerPhone: '(815) 555-0142',
    customerEmail: 'jane@example.com',
    boatInfo: '2019 Yamaha 242X',
  });
  const token = backend.fn('jobRow_', id).token;
  const mech = backend.fn('mechanicSignIn', 'Dale', true).token;

  backend.fn('addEntry', mech, token, {
    entryType: 'customer_note',
    text: 'Impeller was shot — swapped it out.',
    photos: [{ thumb: 'dGh1bWI=', full: 'ZnVsbA==' }],
  });
  backend.fn('addEntry', mech, token, {
    entryType: 'internal_note',
    text: 'Owner never winterised this. Bill the extra hour.',
  });
  backend.fn('addEntry', mech, token, {
    entryType: 'part',
    partIdentifier: '6BH-44352-00-00',
    quantity: 2,
  });
  if (seedLabor) {
    backend.fn('addEntry', mech, token, {
      entryType: 'labor',
      hours: 1.5,
      text: 'Pulled and reset the impeller housing.',
    });
  }
  return { id, token, mech };
}

beforeEach(() => {
  backend = loadBackend({ properties: { ADMIN_PASSWORD: 'shop-password' } });
  adminToken = backend.fn('adminSignIn', 'shop-password').token;
});

/**
 * Most of this suite describes the shop once it has gone live with the
 * customer page switched on — the arrangement the tracking code exists for,
 * even though the shop's settled plan is to run without it.
 */
function goLive() {
  backend.fn('setTestMode', adminToken, false);
  backend.fn('setCustomerTracking', adminToken, true);
}

describe('what the customer is allowed to see', () => {
  it('shows customer notes and hides everything else', () => {
    goLive();
    const { id, token } = seedJob();
    const shop = backend.fn('getJob', adminToken, id);
    expect(shop.entries).toHaveLength(4);

    const publicView = backend.fn('publicJob', token);
    expect(publicView.entries).toHaveLength(1);
    expect(publicView.entries[0].text).toContain('Impeller was shot');

    const serialised = JSON.stringify(publicView);
    expect(serialised).not.toContain('6BH-44352-00-00');
    expect(serialised).not.toContain('Bill the extra hour');
    expect(serialised).not.toContain('Pulled and reset');
    expect(serialised).not.toContain('Dale');
    expect(serialised).not.toContain('1.5');
  });

  it('keeps hours and part numbers off an entry that is not theirs', () => {
    const { id } = seedJob();
    const entries = backend.fn('getJob', adminToken, id).entries;
    const note = entries.find((e) => e.entryType === 'customer_note');
    expect(note.hours).toBeNull();
    expect(note.partIdentifier).toBeNull();
  });

  it('withholds the invoice, payment link and balance until the job is done', () => {
    goLive();
    const { id, token } = seedJob();
    backend.fn('saveInvoice', adminToken, id, 'https://pos.example.com/pay/abc', 'JVBERi0=', {
      grandTotal: 16917.79, deposits: 15285.32, amountDue: 1632.47,
    });

    expect(backend.fn('publicJob', token).job.paymentLink).toBeNull();
    expect(backend.fn('publicJob', token).job.invoiceFile).toBeNull();
    expect(backend.fn('publicJob', token).job.amountDue).toBeNull();

    backend.fn('markDone', adminToken, id);
    const done = backend.fn('publicJob', token);
    expect(done.job.paymentLink).toBe('https://pos.example.com/pay/abc');
    expect(done.job.invoiceFile).toBeTruthy();
    // Their own balance off their own invoice — not the grand total, because
    // this job carried a deposit.
    expect(done.job.amountDue).toBe(1632.47);
    expect(JSON.stringify(done)).not.toContain('16917.79');
  });

  it('holds a voice note back until its transcript lands', () => {
    goLive();
    const { token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'customer_note', audio: 'YXVkaW8=' });
    // Audio with no words yet is not a blank row on the customer's page.
    expect(backend.fn('publicJob', token).entries).toHaveLength(1);
  });
});

describe('files in Drive', () => {
  it('link-shares the job folder, so a page can show what is inside it', () => {
    seedJob();
    expect(backend.sharing.size).toBeGreaterThan(0);
    for (const value of backend.sharing.values()) {
      expect(value).toBe('ANYONE_WITH_LINK/VIEW');
    }
  });

  it('shares the folder once instead of every file in it', () => {
    // setSharing is a slow Drive call, and a photo stores two files. Doing
    // it per file is what made saving a note with photos crawl.
    seedJob();
    expect([...backend.sharing.keys()]).toEqual(['folder-01-8886']);
  });
});

describe('the job lifecycle', () => {
  it('advances on the first scan and never runs backwards', () => {
    backend.fn('createJob', adminToken, { invoiceNumber: '01-9000', customerEmail: 'a@b.com' });
    const token = backend.fn('jobRow_', '01-9000').token;
    expect(backend.fn('jobRow_', '01-9000').status).toBe('received');

    backend.fn('lookupJob', token, 'scan');
    expect(backend.fn('jobRow_', '01-9000').status).toBe('work_underway');

    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    backend.fn('finishWork', mech, token);
    expect(backend.fn('jobRow_', '01-9000').status).toBe('work_finished');

    expect(() => backend.fn('setStatusByWriter', adminToken, '01-9000', 'received')).not.toThrow();
    expect(backend.fn('jobRow_', '01-9000').status).toBe('work_finished');
  });

  it('finds a job by a hand-typed invoice number', () => {
    seedJob('01-8886');
    expect(backend.fn('lookupJob', '01-8886', 'manual').job.id).toBe('01-8886');
    expect(backend.fn('lookupJob', '8886', 'manual').job.id).toBe('01-8886');
    expect(() => backend.fn('lookupJob', 'nope', 'manual')).toThrow(/No job found/);
  });

  it('refuses a second job on the same invoice number', () => {
    seedJob('01-8886');
    expect(() => backend.fn('createJob', adminToken, { invoiceNumber: '01-8886' }))
      .toThrow(/already exists/);
  });
});

describe('hours', () => {
  it('totals labor and splits it by mechanic, ignoring everything else', () => {
    const { id, token } = seedJob();
    const rae = backend.fn('mechanicSignIn', 'Rae', true).token;
    backend.fn('addEntry', rae, token, { entryType: 'labor', hours: 2, text: 'Rigging.' });
    backend.fn('addEntry', rae, token, { entryType: 'internal_note', text: 'Ordered a clamp.' });

    const totals = backend.fn('getJob', adminToken, id).hours;
    expect(totals.totalMinutes).toBe(210);
    expect(totals.total).toBe(3.5);
    expect(totals.byMechanic).toEqual([
      { name: 'Rae', hours: 2, minutes: 120 },
      { name: 'Dale', hours: 1.5, minutes: 90 },
    ]);
  });

  it('takes the time in minutes, which is what the app sends', () => {
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'Impeller.' });
    const totals = backend.fn('getJob', adminToken, id).hours;
    expect(totals.totalMinutes).toBe(20 + 90);
  });

  it('adds three twenty-minute stints up to exactly an hour', () => {
    // The reason the arithmetic is done in minutes at all. Three entries of
    // 0.3333 h summed as decimals come to 0.9999 — 59 minutes — and the
    // mechanic who worked an hour is short one minute on the invoice.
    const { id, token, mech } = seedJob('01-8886', { seedLabor: false });
    for (let i = 0; i < 3; i++) {
      backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'Stint.' });
    }
    const totals = backend.fn('getJob', adminToken, id).hours;
    expect(totals.totalMinutes).toBe(60);
    expect(backend.fn('listJobs', adminToken, {}).jobs.find((j) => j.id === id).minutes).toBe(60);
  });

  it('refuses half a minute', () => {
    const { token, mech } = seedJob();
    expect(() => backend.fn('addEntry', mech, token, {
      entryType: 'labor', minutes: 20.5, text: 'Stint.',
    })).toThrow(/whole number of minutes/i);
  });

  it('takes an estimate-sized figure without complaint', () => {
    const { token, mech } = seedJob();
    expect(() => backend.fn('addEntry', mech, token, {
      entryType: 'labor', hours: 40, text: 'Full repower estimate.',
    })).not.toThrow();
  });

  it('refuses hours with no description, and a description with no hours', () => {
    const { token, mech } = seedJob();
    expect(() => backend.fn('addEntry', mech, token, { entryType: 'labor', hours: 2 }))
      .toThrow(/what you did/i);
    expect(() => backend.fn('addEntry', mech, token, { entryType: 'labor', text: 'a while' }))
      .toThrow(/how long/i);
    expect(() => backend.fn('addEntry', mech, token, { entryType: 'labor', hours: 0, text: 'x' }))
      .toThrow(/greater than zero/);
  });
});

describe('the job alert', () => {
  it('shows up on the job the mechanic opens', () => {
    const { id, token, mech } = seedJob();
    backend.fn('setJobAlert', adminToken, id, 'Do not start — owner is disputing the estimate.');
    const seen = backend.fn('jobForMechanic', mech, token).job;
    expect(seen.alert).toBe('Do not start — owner is disputing the estimate.');
    expect(seen.alertAt).toBeTruthy();
  });

  it('flags the job in the open-jobs list and floats it to the top', () => {
    seedJob('01-8886');
    seedJob('01-8887');
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    // 01-8887 sorts second by id; the alert is what puts it first.
    backend.fn('setJobAlert', adminToken, '01-8887', 'Call the owner before you touch it.');
    const jobs = backend.fn('openJobs', mech).jobs;
    expect(jobs[0].id).toBe('01-8887');
    expect(jobs[0].alert).toBe('Call the owner before you touch it.');
    expect(jobs[1].alert).toBe('');
  });

  it('comes down when the office takes it down', () => {
    const { id, token, mech } = seedJob();
    backend.fn('setJobAlert', adminToken, id, 'Hold this boat.');
    backend.fn('setJobAlert', adminToken, id, '');
    const seen = backend.fn('jobForMechanic', mech, token).job;
    expect(seen.alert).toBe(null);
    expect(seen.alertAt).toBe(null);
  });

  it('leaves what it said in the shop log after the banner is gone', () => {
    const { id } = seedJob();
    backend.fn('setJobAlert', adminToken, id, 'Hold this boat.');
    backend.fn('setJobAlert', adminToken, id, '');
    const logged = backend.fn('getJob', adminToken, id).entries
      .filter((entry) => entry.entryType === 'writer_note');
    expect(logged.map((entry) => entry.text)).toContain('Alert: Hold this boat.');
  });

  it('never reaches the customer, at any status', () => {
    const { id, token } = seedJob();
    backend.fn('props_').setProperty('CUSTOMER_TRACKING', 'on');
    backend.fn('props_').setProperty('TEST_MODE', 'false');
    backend.fn('setJobAlert', adminToken, id, 'Owner is disputing the estimate.');
    // The lifecycle only runs forwards, and seeding entries already started
    // the job — so walk it the rest of the way from where it actually is.
    const check = () => {
      const seen = JSON.stringify(backend.fn('publicJob', token, ''));
      expect(seen).not.toContain('disputing');
      expect(seen).not.toContain('alert');
    };
    check();
    backend.fn('setStatusByWriter', adminToken, id, 'work_finished');
    check();
    // Done is the one status the writer reaches through markDone, not the
    // status setter — and it is the status that opens the invoice and the
    // balance to the customer, so it is the one most worth checking.
    backend.fn('markDone', adminToken, id);
    check();
  });

  it('belongs to the writer, not the floor', () => {
    const { id, mech } = seedJob();
    expect(() => backend.fn('setJobAlert', mech, id, 'Anything at all.')).toThrow();
  });

  it('says to run setup() rather than saving into a column that is not there', () => {
    // Exactly the state a deploy leaves behind: new code, old header. Without
    // this the alert saves, reads back as undefined, and never appears — and
    // the writer has no way to tell that from "the mechanic ignored it".
    const { id } = seedJob();
    const jobs = backend.sheet('Jobs');
    jobs.rows[0] = jobs.rows[0].filter((column) => column !== 'alert' && column !== 'alert_at');
    expect(() => backend.fn('setJobAlert', adminToken, id, 'Hold this boat.'))
      .toThrow(/run setup\(\)/i);
  });

  it('does not disturb the fields the writer types on the job', () => {
    const { id } = seedJob();
    backend.fn('setJobAlert', adminToken, id, 'Hold this boat.');
    backend.fn('saveJobDetails', adminToken, id, {
      customerName: 'Jane Rivers', customerPhone: '(815) 555-0142',
      customerEmail: 'jane@example.com', boatInfo: '2019 Yamaha 242X',
    });
    expect(backend.fn('getJob', adminToken, id).job.alert).toBe('Hold this boat.');
  });
});

describe('whether the sheet has caught up with the code', () => {
  it('says so when it has', () => {
    seedJob();
    const status = backend.fn('sheetStatus', adminToken);
    expect(status.ready).toBe(true);
    expect(status.missing).toHaveLength(0);
    expect(status.drifted).toBe(0);
  });

  it('names the columns a deploy added and setup() has not written yet', () => {
    seedJob();
    const jobs = backend.sheet('Jobs');
    // Exactly the state a deploy leaves behind: new code, old header.
    jobs.rows[0] = jobs.rows[0].filter((column) => column !== 'alert' && column !== 'alert_at');
    const status = backend.fn('sheetStatus', adminToken);
    expect(status.ready).toBe(false);
    const gap = status.missing.find((m) => m.tab === 'Jobs');
    expect(gap.columns).toEqual(['alert', 'alert_at']);
  });

  it('names a tab that does not exist yet', () => {
    seedJob();
    backend.fn('ss_').deleteSheet(backend.sheet('PropRepairs'));
    const status = backend.fn('sheetStatus', adminToken);
    expect(status.ready).toBe(false);
    expect(status.missing.find((m) => m.tab === 'PropRepairs').absent).toBe(true);
  });

  it('counts jobs whose totals have drifted from the log', () => {
    const { id } = seedJob();
    const job = backend.fn('jobRow_', id);
    backend.fn('updateRow_', 'Jobs', job._row, { entry_count: 99, minutes_total: 9999 });
    const status = backend.fn('sheetStatus', adminToken);
    expect(status.ready).toBe(false);
    expect(status.drifted).toBe(1);
    expect(status.driftedIds).toContain(id);
    // And it is read-only: asking twice does not quietly fix anything.
    expect(backend.fn('sheetStatus', adminToken).drifted).toBe(1);
    expect(Number(backend.fn('jobRow_', id).entry_count)).toBe(99);
  });

  it('goes quiet once setup has been run', () => {
    const { id } = seedJob();
    const job = backend.fn('jobRow_', id);
    backend.fn('updateRow_', 'Jobs', job._row, { entry_count: 99 });
    expect(backend.fn('sheetStatus', adminToken).ready).toBe(false);
    backend.fn('recountJobTotals_');
    expect(backend.fn('sheetStatus', adminToken).ready).toBe(true);
  });

  it('is the writer\'s to ask', () => {
    const { mech } = seedJob();
    expect(() => backend.fn('sheetStatus', mech)).toThrow();
  });

  it('stays clean through everything that writes a log entry', () => {
    // The bug this check was built to find: addWriterNote and setJobAlert
    // appended a row straight to the tab and never touched the running
    // totals, so a job with an office note on it under-reported itself on
    // the writer's list. Every path that adds an entry belongs here.
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'Stint.' });
    backend.fn('addWriterNote', adminToken, id, 'Ring the owner before you start.');
    backend.fn('setJobAlert', adminToken, id, 'Do not start.');
    backend.fn('addJobPart', adminToken, id, { partIdentifier: 'IMP-1' });

    const status = backend.fn('sheetStatus', adminToken);
    expect(status.drifted).toBe(0);
    expect(status.ready).toBe(true);
    // And the count on the list is the count in the log.
    const listed = backend.fn('listJobs', adminToken, { status: 'open' }).jobs
      .find((j) => j.id === id);
    expect(listed.entryCount).toBe(backend.fn('getJob', adminToken, id).entries.length);
  });
});

describe('the writer\'s working list', () => {
  /** Walks a job all the way to done, optionally ticking paid. */
  function finish(id, paid) {
    backend.fn('setStatusByWriter', adminToken, id, 'work_finished');
    backend.fn('markDone', adminToken, id);
    if (paid) backend.fn('setJobFlag', adminToken, id, 'paid', true);
  }

  it('drops a job once it is done AND paid', () => {
    const { id } = seedJob('01-8886');
    seedJob('01-8887');
    finish(id, true);
    const open = backend.fn('listJobs', adminToken, { status: 'open' }).jobs;
    expect(open.map((j) => j.id)).toEqual(['01-8887']);
  });

  it('keeps a job that is done but not paid', () => {
    const { id } = seedJob();
    finish(id, false);
    // The work is over, so nothing else will bring this back to the writer's
    // attention — which is exactly why it has to stay on the list.
    const open = backend.fn('listJobs', adminToken, { status: 'open' }).jobs;
    expect(open.map((j) => j.id)).toContain(id);
  });

  it('brings one back if the paid tick comes off again', () => {
    const { id } = seedJob();
    finish(id, true);
    expect(backend.fn('listJobs', adminToken, { status: 'open' }).jobs).toHaveLength(0);
    backend.fn('setJobFlag', adminToken, id, 'paid', false);
    expect(backend.fn('listJobs', adminToken, { status: 'open' }).jobs
      .map((j) => j.id)).toContain(id);
  });

  it('counts the open ones alongside the statuses', () => {
    const a = seedJob('01-8886');
    seedJob('01-8887');
    finish(a.id, true);
    const counts = backend.fn('listJobs', adminToken, { status: 'open' }).counts;
    expect(counts.open).toBe(1);
    expect(counts.done).toBe(1);
  });

  it('still shows everything when asked for all', () => {
    const { id } = seedJob('01-8886');
    seedJob('01-8887');
    finish(id, true);
    expect(backend.fn('listJobs', adminToken, { status: 'all' }).jobs).toHaveLength(2);
    // And a named status is unaffected by any of this.
    expect(backend.fn('listJobs', adminToken, { status: 'done' }).jobs
      .map((j) => j.id)).toEqual([id]);
  });

  it('searches within the open list rather than around it', () => {
    const { id } = seedJob('01-8886');
    seedJob('01-8887');
    finish(id, true);
    const found = backend.fn('listJobs', adminToken, { status: 'open', search: 'Jane' }).jobs;
    expect(found.map((j) => j.id)).toEqual(['01-8887']);
  });
});

describe('what a job page costs to open', () => {
  it('leaves the timeline for when it is asked for', () => {
    const { id } = seedJob();
    const page = backend.fn('getJob', adminToken, id);
    // A whole-tab read that was happening on every open for a panel nobody
    // looks at most visits. If it comes back, this says so.
    expect(page.timeline).toBeUndefined();
    // Everything the page actually draws is still there.
    expect(page.job.id).toBe(id);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.hours.totalMinutes).toBeGreaterThan(0);
  });

  it('but keeps the mail log, which is not just a panel', () => {
    const { id } = seedJob();
    // The page reads this to know whether the invoice has already gone, which
    // is what the send button hangs off. Deferring it would leave that button
    // lying until somebody clicked Show.
    expect(Array.isArray(backend.fn('getJob', adminToken, id).emails)).toBe(true);
  });

  it('and hands the timeline over when it is asked for', () => {
    const { id } = seedJob();
    const history = backend.fn('jobHistory', adminToken, id);
    expect(Array.isArray(history.timeline)).toBe(true);
    expect(history.timeline.length).toBeGreaterThan(0);
  });

  it('which is the writer\'s to ask for', () => {
    const { id, mech } = seedJob();
    expect(() => backend.fn('jobHistory', mech, id)).toThrow();
  });
});

describe('how long the backend says it took', () => {
  it('answers a warm-up call without touching anything', () => {
    // The mechanic app calls this as it opens, so that Google has a container
    // running by the time somebody scans. It must stay free: no sheet, no
    // credential, nothing to leak, nothing to go wrong.
    const pong = backend.post({}, { fn: 'ping', args: [] });
    expect(pong.ok).toBe(true);
    expect(Object.keys(pong).sort()).toEqual(['ok', 'serverMs']);
  });

  it('reports its own time on every answer, good or bad', () => {
    // "It feels slow" cannot be fixed. This is what lets the app say how much
    // of a wait was Apps Script doing the work and how much was everything
    // else — start-up, the redirect, the shop's wifi — which is the half no
    // amount of tidying spreadsheet reads will help.
    const ok = backend.post({}, { fn: 'roster', args: [] });
    expect(typeof ok.serverMs).toBe('number');
    const bad = backend.post({}, { fn: 'listJobs', token: 'rubbish', args: [{}] });
    expect(bad.error).toMatch(/Sign in/);
    expect(typeof bad.serverMs).toBe('number');
  });
});

describe('what opening a job costs', () => {
  it('answers a signed-in scan with the whole job screen, in one call', () => {
    const { id, token, mech } = seedJob();
    // Scanning used to be two calls to Apps Script: the lookup, then the job.
    // Each one pays Google's start-up and a redirect before it reads a cell,
    // and that was most of the wait between the scanner beeping and the job
    // appearing. One call now answers both.
    const answer = backend.fn('lookupJob', token, 'scan', mech);
    expect(answer.job.id).toBe(id);
    expect(answer.mechanic.name).toBe('Dale');
    expect(answer.hours.totalMinutes).toBe(90);
  });

  it('without reading a single log entry to do it', () => {
    const { token, mech } = seedJob();
    // One job's log means reading every entry in the shop — a Sheet has no
    // index — and it was being paid for on every job opened, by a mechanic who
    // came to write rather than to read. The count and the running total come
    // off the job's own row instead.
    const answer = backend.fn('lookupJob', token, 'scan', mech);
    expect(answer.entries).toBeUndefined();
    expect(answer.props).toBeUndefined();
    expect(answer.job.entryCount).toBe(4);
    expect(answer.hours.totalMinutes).toBe(90);
  });

  it('and hands the log over when the mechanic asks for it', () => {
    const { token, mech } = seedJob();
    const log = backend.fn('jobLog', mech, token);
    expect(log.entries.length).toBe(4);
    expect(log.hours.totalMinutes).toBe(90);
    // The breakdown by person only exists on this side, where somebody is
    // actually reading the detail.
    expect(log.hours.byMechanic[0].name).toBe('Dale');
  });

  it('which is the floor\'s to ask for, not anybody\'s', () => {
    const { token } = seedJob();
    expect(() => backend.fn('jobLog', 'not-a-token', token)).toThrow(/Sign in/);
    expect(() => backend.fn('jobLog', adminToken, token)).toThrow(/Sign in/);
    expect(() => backend.fn('jobProps', 'not-a-token', token)).toThrow(/Sign in/);
  });

  it('still hands an unsigned scan nothing but the summary', () => {
    const { token } = seedJob();
    // The roster is the gate on the log, and on the customer's details with
    // it. Holding the paper gets you the number and the boat; it does not get
    // you what anyone has written down about the job.
    const answer = backend.fn('lookupJob', token, 'scan');
    expect(answer.job.boatInfo).toBe('2019 Yamaha 242X');
    expect(answer.entries).toBeUndefined();
    expect(answer.mechanic).toBeUndefined();
    expect(answer.job.customerPhone).toBeUndefined();
    expect(answer.job.customerEmail).toBeUndefined();
  });

  it('ignores a token that is not a mechanic\'s', () => {
    const { token } = seedJob();
    expect(backend.fn('lookupJob', token, 'scan', adminToken).entries).toBeUndefined();
    expect(backend.fn('lookupJob', token, 'scan', 'rubbish').entries).toBeUndefined();
  });

  it('answers an unknown job the same either way', () => {
    const { mech } = seedJob();
    expect(() => backend.fn('lookupJob', 'nope', 'manual', mech)).toThrow(/No job found/);
  });
});

describe('a job\'s running totals', () => {
  it('count what the log holds, without reading it', () => {
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 45, text: 'More.' });
    const row = backend.fn('jobRow_', id);
    const entries = backend.fn('getJob', adminToken, id).entries;
    expect(Number(row.entry_count)).toBe(entries.length);
    // seedJob logs 1.5h, plus the 45 above.
    expect(Number(row.minutes_total)).toBe(90 + 45);
  });

  it('are what the jobs list reports', () => {
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 30, text: 'More.' });
    const listed = backend.fn('listJobs', adminToken, {}).jobs.find((j) => j.id === id);
    expect(listed.minutes).toBe(120);
    expect(listed.entryCount).toBe(backend.fn('getJob', adminToken, id).entries.length);
  });

  it('are put right by setup when they drift', () => {
    const { id } = seedJob();
    // Whatever could desync them — a hand edit, a row written outside
    // addEntry — the recount is the answer, and it only touches what is wrong.
    const job = backend.fn('jobRow_', id);
    backend.fn('updateRow_', 'Jobs', job._row, { entry_count: 99, minutes_total: 9999 });
    const fixed = backend.fn('recountJobTotals_');
    expect(fixed).toContain(id);
    const after = backend.fn('jobRow_', id);
    expect(Number(after.entry_count)).toBe(backend.fn('getJob', adminToken, id).entries.length);
    expect(Number(after.minutes_total)).toBe(90);
    // A second pass has nothing left to do.
    expect(backend.fn('recountJobTotals_')).toHaveLength(0);
  });
});

describe('the writer putting a part on a job', () => {
  it('lands on the same list a mechanic would have put it on', () => {
    const { id } = seedJob();
    backend.fn('addJobPart', adminToken, id, {
      partIdentifier: 'IMP-100', description: 'Impeller kit', quantity: 2,
    });
    const needed = backend.fn('listPartsOrders', adminToken).needed;
    const part = needed.find((p) => p.partIdentifier === 'IMP-100');
    expect(part).toBeTruthy();
    expect(part.jobId).toBe(id);
    expect(part.quantity).toBe(2);
    expect(part.reasonLabel).toBe('For this job');
  });

  it('is credited to the office, not to a mechanic who never touched it', () => {
    const { id } = seedJob();
    backend.fn('addJobPart', adminToken, id, { description: 'Impeller kit' });
    const part = backend.fn('listPartsOrders', adminToken).needed
      .find((p) => p.description === 'Impeller kit');
    expect(part.requestedBy).toBe('Service writer');
    // No log entry behind it: nobody worked on the boat to produce it.
    expect(backend.fn('partRow_', part.id).source_entry).toBe('');
  });

  it('goes the whole way to arrived, like any other part', () => {
    const { id } = seedJob();
    backend.fn('addJobPart', adminToken, id, { partIdentifier: 'IMP-100' });
    const part = backend.fn('listPartsOrders', adminToken).needed
      .find((p) => p.partIdentifier === 'IMP-100');
    backend.fn('markPartsOrdered', adminToken, [part.id], 'Mercury Marine', 'PO-55');
    const onOrder = backend.fn('listPartsOrders', adminToken).ordered
      .find((p) => p.id === part.id);
    expect(onOrder.vendor).toBe('Mercury Marine');
    expect(onOrder.orderNumber).toBe('PO-55');
    backend.fn('markPartReceived', adminToken, part.id, true);
    const arrived = backend.fn('listPartsOrders', adminToken).completed
      .reduce((all, group) => all.concat(group.parts), [])
      .find((p) => p.id === part.id);
    expect(arrived.receivedAt).toBeTruthy();
  });

  it('takes a description when nobody has a number yet', () => {
    const { id } = seedJob();
    expect(() => backend.fn('addJobPart', adminToken, id, { description: 'The blue one' }))
      .not.toThrow();
    expect(() => backend.fn('addJobPart', adminToken, id, {})).toThrow(/say which part/i);
  });

  it('refuses a quantity that is not a quantity', () => {
    const { id } = seedJob();
    expect(() => backend.fn('addJobPart', adminToken, id, { partIdentifier: 'X', quantity: -1 }))
      .toThrow(/greater than zero/i);
    expect(() => backend.fn('addJobPart', adminToken, id, { partIdentifier: 'X', quantity: 'lots' }))
      .toThrow(/greater than zero/i);
    // Zero reads as "not given", the same as an empty box and the same as a
    // stock request — which is what the stepper produces below one.
    const saved = backend.fn('addJobPart', adminToken, id, { partIdentifier: 'X', quantity: 0 });
    expect(saved.part.quantity).toBe(null);
  });

  it('shows up on the job page it was added from', () => {
    const { id } = seedJob();
    backend.fn('addJobPart', adminToken, id, { partIdentifier: 'IMP-100' });
    const onTicket = backend.fn('getJob', adminToken, id).parts;
    expect(onTicket.map((p) => p.partIdentifier)).toContain('IMP-100');
  });

  it('belongs to the writer, not the floor', () => {
    const { id, mech } = seedJob();
    expect(() => backend.fn('addJobPart', mech, id, { partIdentifier: 'X' })).toThrow();
  });

  it('never reaches the customer', () => {
    const { id, token } = seedJob();
    backend.fn('addJobPart', adminToken, id, { partIdentifier: 'IMP-100', description: 'Impeller kit' });
    backend.fn('props_').setProperty('CUSTOMER_TRACKING', 'on');
    backend.fn('props_').setProperty('TEST_MODE', 'false');
    const seen = JSON.stringify(backend.fn('publicJob', token, ''));
    expect(seen).not.toContain('IMP-100');
    expect(seen).not.toContain('Impeller kit');
  });
});

describe('filing a completed order away', () => {
  /**
   * A job, two parts wanted against it, ordered together and all received —
   * one carrying a job and a customer, one a bare stock request, because the
   * archive has to hold both shapes.
   *
   * seedJob's part entry does not ask for anything to be ordered, so the
   * order line is created here with orderQty, the way the mechanic app does.
   */
  function completedOrder(id = '01-8886', orderNumber = 'PO-1') {
    const seeded = seedJob(id);
    backend.fn('addEntry', seeded.mech, seeded.token, {
      entryType: 'part', partIdentifier: '6BH-44352-00-00', quantity: 2, orderQty: 2,
      text: 'Impeller kit',
    });
    backend.fn('requestPart', adminToken, { partIdentifier: 'IMP-100', description: 'Shelf spare' });

    const ids = backend.fn('listPartsOrders', adminToken).needed.map((p) => p.id);
    backend.fn('markPartsOrdered', adminToken, ids, 'Mercury Marine', orderNumber);
    ids.forEach((partId) => backend.fn('markPartReceived', adminToken, partId, true));
    return { ...seeded, ids };
  }

  it('drops off the working list and turns up in the archive', () => {
    const { ids } = completedOrder();
    expect(backend.fn('listPartsOrders', adminToken).completed).toHaveLength(1);

    const after = backend.fn('setPartsArchived', adminToken, ids, true);
    expect(after.completed).toHaveLength(0);
    const archived = backend.fn('listArchivedParts', adminToken).parts;
    expect(archived).toHaveLength(ids.length);
    expect(archived[0].archivedAt).toBeTruthy();
  });

  it('keeps everything the writer might look it up by', () => {
    const { ids } = completedOrder();
    backend.fn('setPartsArchived', adminToken, ids, true);
    const filed = backend.fn('listArchivedParts', adminToken).parts
      .find((p) => p.partIdentifier === '6BH-44352-00-00');
    // Part, customer, supplier and work order are the four things the page
    // searches on, so all four have to survive being filed.
    expect(filed.partIdentifier).toBe('6BH-44352-00-00');
    expect(filed.customerName).toBe('Jane Rivers');
    expect(filed.vendor).toBe('Mercury Marine');
    expect(filed.jobId).toBe('01-8886');
  });

  it('comes back out again', () => {
    const { ids } = completedOrder();
    backend.fn('setPartsArchived', adminToken, ids, true);
    const after = backend.fn('setPartsArchived', adminToken, ids, false);
    expect(after.completed).toHaveLength(1);
    expect(backend.fn('listArchivedParts', adminToken).parts).toHaveLength(0);
  });

  it('will not file a part that has not arrived', () => {
    const seeded = seedJob();
    backend.fn('addEntry', seeded.mech, seeded.token, {
      entryType: 'part', partIdentifier: 'ORD-1', quantity: 1, orderQty: 1, text: 'Still coming',
    });
    const needed = backend.fn('listPartsOrders', adminToken).needed;
    backend.fn('setPartsArchived', adminToken, needed.map((p) => p.id), true);
    // Still on the list to order — filing is for things that are done.
    expect(backend.fn('listPartsOrders', adminToken).needed).toHaveLength(needed.length);
    expect(backend.fn('listArchivedParts', adminToken).parts).toHaveLength(0);
  });

  it('deletes a whole order without taking the wrong rows with it', () => {
    // The row-index trap: deleting row 4 shifts row 5 up into its place, so
    // deleting ascending removes the wrong rows from the second one onward.
    // Two orders, so a mistake here eats lines that belong to the other.
    const first = completedOrder('01-8886', 'PO-1');
    const second = completedOrder('01-8887', 'PO-2');
    expect(first.ids.length).toBeGreaterThan(1);

    const before = backend.fn('listArchivedParts', adminToken);
    expect(before.parts).toHaveLength(0);

    backend.fn('deletePartsOrders', adminToken, first.ids);
    const left = backend.fn('listPartsOrders', adminToken);
    const survivors = left.completed.reduce((all, group) => all.concat(group.parts), []);
    // Every line of the second order is untouched, and none of the first is left.
    expect(survivors.map((p) => p.id).sort()).toEqual(second.ids.slice().sort());
  });

  it('refuses to delete an order somebody has actually placed', () => {
    const seeded = seedJob();
    backend.fn('addEntry', seeded.mech, seeded.token, {
      entryType: 'part', partIdentifier: 'ORD-1', quantity: 1, orderQty: 1, text: 'On its way',
    });
    const needed = backend.fn('listPartsOrders', adminToken).needed;
    const ids = needed.map((p) => p.id);
    backend.fn('markPartsOrdered', adminToken, ids, 'Mercury Marine', 'PO-9');
    backend.fn('deletePartsOrders', adminToken, ids);
    expect(backend.fn('listPartsOrders', adminToken).ordered).toHaveLength(ids.length);
  });

  it('belongs to the writer alone', () => {
    const { ids, mech } = completedOrder();
    expect(mech).toBeTruthy();
    expect(() => backend.fn('setPartsArchived', mech, ids, true)).toThrow();
    expect(() => backend.fn('deletePartsOrders', mech, ids)).toThrow();
    expect(() => backend.fn('listArchivedParts', mech)).toThrow();
  });

  it('says so rather than quietly doing nothing when nothing is picked', () => {
    expect(() => backend.fn('setPartsArchived', adminToken, [], true)).toThrow(/nothing picked/i);
    expect(() => backend.fn('deletePartsOrders', adminToken, [], true)).toThrow(/nothing picked/i);
  });
});

describe('a prop out for repair', () => {
  const TAG = { thumb: 'dGh1bWI=', full: 'ZnVsbA==' };

  function sendProp(id = '01-8886', extra = {}) {
    const seeded = seedJob(id);
    backend.fn('addPropRepair', seeded.mech, seeded.token,
      Object.assign({ tagPhoto: TAG, description: 'Stainless 3-blade, port' }, extra));
    return seeded;
  }

  it('starts on the bench, ready for pick-up', () => {
    sendProp();
    const list = backend.fn('listPropRepairs', adminToken);
    expect(list.ready).toHaveLength(1);
    expect(list.ready[0].statusLabel).toBe('Ready for pick-up');
    expect(list.pickedUp).toHaveLength(0);
    expect(list.back).toHaveLength(0);
  });

  it('carries the tag photo, which is the whole of its identity', () => {
    sendProp();
    const prop = backend.fn('listPropRepairs', adminToken).ready[0];
    // Two sizes, same as every other photo: a thumb for the list, a full one
    // for reading a handwritten name off.
    expect(prop.tagPhoto.thumb).toBeTruthy();
    expect(prop.tagPhoto.full).toBeTruthy();
    expect(prop.tagPhoto.thumb).not.toBe(prop.tagPhoto.full);
  });

  it('takes a described prop when the camera will not play', () => {
    const { token, mech } = seedJob();
    expect(() => backend.fn('addPropRepair', mech, token, { description: 'Aluminium spare' }))
      .not.toThrow();
  });

  it('refuses one with neither a photo nor a word about it', () => {
    const { token, mech } = seedJob();
    expect(() => backend.fn('addPropRepair', mech, token, {}))
      .toThrow(/photograph the tag/i);
  });

  it('goes out against whoever took it', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    const list = backend.fn('markPropsPickedUp', adminToken, [id], 'Ottawa Prop Works');
    expect(list.ready).toHaveLength(0);
    expect(list.pickedUp[0].vendor).toBe('Ottawa Prop Works');
    expect(list.pickedUp[0].pickedUpAt).toBeTruthy();
  });

  it('will not let a batch out without saying who took it', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    expect(() => backend.fn('markPropsPickedUp', adminToken, [id], '  ')).toThrow(/who took them/i);
  });

  it('comes back fixed', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    backend.fn('markPropsPickedUp', adminToken, [id], 'Ottawa Prop Works');
    const list = backend.fn('markPropReturned', adminToken, id, 'fixed');
    expect(list.pickedUp).toHaveLength(0);
    expect(list.back[0].status).toBe('fixed');
    expect(list.back[0].returnedAt).toBeTruthy();
  });

  it('or comes back unfixable, which is an ending of its own', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    backend.fn('markPropsPickedUp', adminToken, [id], 'Ottawa Prop Works');
    const list = backend.fn('markPropReturned', adminToken, id, 'unfixable');
    expect(list.back[0].status).toBe('unfixable');
    expect(list.back[0].statusLabel).toBe('Returned — unfixable');
  });

  it('cannot come back before it has gone out', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    expect(() => backend.fn('markPropReturned', adminToken, id, 'fixed')).toThrow(/not gone out/i);
  });

  it('will not accept an outcome that is neither', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    backend.fn('markPropsPickedUp', adminToken, [id], 'Ottawa Prop Works');
    expect(() => backend.fn('markPropReturned', adminToken, id, 'received'))
      .toThrow(/fixed, or unfixable/i);
  });

  it('can be pulled off the list before it leaves, but not after', () => {
    sendProp();
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    expect(backend.fn('cancelPropRepair', adminToken, id).ready).toHaveLength(0);

    sendProp('01-8887');
    const second = backend.fn('listPropRepairs', adminToken).ready[0].id;
    backend.fn('markPropsPickedUp', adminToken, [second], 'Ottawa Prop Works');
    expect(() => backend.fn('cancelPropRepair', adminToken, second)).toThrow(/already out/i);
  });

  it('rides along with the job on both sides of the shop', () => {
    const { id, token, mech } = sendProp();
    // The floor reads them in the Prop tab, which is the only place they are
    // drawn and so the only place they are fetched.
    expect(backend.fn('jobProps', mech, token).props).toHaveLength(1);
    expect(backend.fn('getJob', adminToken, id).props).toHaveLength(1);
  });

  it('is the floor that sends one out and the office that moves it along', () => {
    const { id: jobId, token, mech } = seedJob();
    // A signed-out phone cannot put a prop on the list.
    expect(() => backend.fn('addPropRepair', 'not-a-token', token, { description: 'x' })).toThrow();
    backend.fn('addPropRepair', mech, token, { description: 'Stainless 3-blade' });
    const id = backend.fn('listPropRepairs', adminToken).ready[0].id;
    // And the floor cannot mark it picked up or read the whole shop's list.
    expect(() => backend.fn('listPropRepairs', mech)).toThrow();
    expect(() => backend.fn('markPropsPickedUp', mech, [id], 'Anyone')).toThrow();
    expect(jobId).toBeTruthy();
  });

  it('never reaches the customer', () => {
    const { id, token } = sendProp();
    backend.fn('props_').setProperty('CUSTOMER_TRACKING', 'on');
    backend.fn('props_').setProperty('TEST_MODE', 'false');
    backend.fn('setStatusByWriter', adminToken, id, 'work_finished');
    backend.fn('markDone', adminToken, id);
    const seen = JSON.stringify(backend.fn('publicJob', token, ''));
    expect(seen).not.toContain('prop');
    expect(seen).not.toContain('3-blade');
  });
});

describe('signing in by name', () => {
  it('matches somebody already on the roster, however they type it', () => {
    backend.fn('mechanicSignIn', 'Dale', true);
    for (const typed of ['dale', '  DALE  ']) {
      backend.fn('mechanicSignIn', typed, true);
    }
    expect(backend.fn('roster').roster).toHaveLength(1);
  });

  it('adds a name nobody has used before rather than turning them away', () => {
    backend.fn('mechanicSignIn', 'Marisol Vega', true);
    expect(backend.fn('roster').roster.map((m) => m.name)).toContain('Marisol Vega');
  });

  it('refuses junk in the name field', () => {
    for (const junk of ['', 'x', '012345678905', '   ']) {
      expect(() => backend.fn('mechanicSignIn', junk, true)).toThrow(/as the shop would write it/);
    }
  });

  it('refuses a name the office switched off', () => {
    backend.fn('mechanicSignIn', 'Former Employee', true);
    const id = backend.fn('mechanicByName_', 'Former Employee').id;
    backend.fn('setMechanicActive', adminToken, id, false);
    expect(() => backend.fn('mechanicSignIn', 'former employee', true)).toThrow(/switched off/);
  });
});

describe('who may call what', () => {
  it('turns away an unsigned caller and a mechanic reaching for the portal', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('listJobs', '', {})).toThrow(/Sign in/);
    expect(() => backend.fn('listJobs', mech, {})).toThrow(/Sign in/);
    expect(() => backend.fn('adminSignIn', 'wrong-password')).toThrow(/not recognised/);
  });

  it('takes the portal password however the keyboard capitalised it', () => {
    const back = loadBackend({ properties: { ADMIN_PASSWORD: 'quest' } });
    // A counter iPad capitalises the first letter on its own, and a trailing
    // space is easy to pick up. None of that should turn the writer away.
    for (const typed of ['quest', 'Quest', 'QUEST', '  quest  ', 'qUeSt']) {
      expect(back.fn('adminSignIn', typed).token).toBeTruthy();
    }
    expect(() => back.fn('adminSignIn', 'quests')).toThrow(/not recognised/);
    // An empty box is not a match against an empty-ish stored value either.
    expect(() => back.fn('adminSignIn', '')).toThrow(/not recognised/);
    expect(() => back.fn('adminSignIn', '   ')).toThrow(/not recognised/);
  });

  it('lets the shop set a five-character password, but no shorter', () => {
    const back = loadBackend({ properties: { ADMIN_PASSWORD: 'x' } });
    expect(back.fn('setAdminPassword', 'quest')).toMatch(/set/i);
    expect(back.fn('adminSignIn', 'QUEST').token).toBeTruthy();
    expect(() => back.fn('setAdminPassword', 'ques')).toThrow(/at least 5/i);
    expect(() => back.fn('setAdminPassword', '  q  ')).toThrow(/at least 5/i);
  });

  it('will not take a token somebody edited', () => {
    const forged = adminToken.slice(0, -4) + 'AAAA';
    expect(() => backend.fn('listJobs', forged, {})).toThrow(/Sign in/);
  });
});

describe('saving an entry', () => {
  it('still refuses a job token that is not a job', () => {
    const { mech } = seedJob();
    // The job is looked up inside the lock now, after the payload is checked,
    // rather than before it. The answer to a bad token has to be the same.
    expect(() => backend.fn('addEntry', mech, 'NOSUCH', { entryType: 'labor', minutes: 30, text: 'x' }))
      .toThrow(/No such job/);
  });

  it('reads the job once, with the lock held, and still adds up', () => {
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'One.' });
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'Two.' });
    backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 20, text: 'Three.' });
    const row = backend.fn('jobRow_', id);
    // 90 from the seed. Three twenty-minute stints are an hour, not 59
    // minutes, and the totals must not have skipped a beat now that the row
    // is read once instead of twice.
    expect(Number(row.minutes_total)).toBe(150);
    expect(Number(row.entry_count)).toBe(backend.fn('getJob', adminToken, id).entries.length);
    expect(backend.fn('jobTotalsDrift_')).toHaveLength(0);
  });

  it('does not hold the whole floor behind a photo upload', () => {
    const { token, mech } = seedJob();
    // One script lock serves every save in the shop. Drive is slow and a
    // photo is two writes to it, so uploading inside the lock made one
    // mechanic's two photos everybody else's wait. The lock is for the
    // running totals; the upload has no business inside it.
    backend.call(`
      __lockDepth = 0;
      __uploadedUnderLock = false;
      LockService = { getScriptLock: function () { return {
        waitLock: function () { __lockDepth += 1; },
        releaseLock: function () { __lockDepth -= 1; }
      }; } };
      __realSaveFile = saveFile_;
      saveFile_ = function (a, b, c, d) {
        if (__lockDepth > 0) __uploadedUnderLock = true;
        return __realSaveFile(a, b, c, d);
      };
      // The same watch on the row write, so that a green result means the
      // upload was outside the lock rather than that the watch never fired.
      __appendedUnderLock = false;
      __realAppendRow = appendRow_;
      appendRow_ = function (a, b) {
        if (__lockDepth > 0) __appendedUnderLock = true;
        return __realAppendRow(a, b);
      };
    `);
    const saved = backend.fn('addEntry', mech, token, {
      entryType: 'internal_note',
      text: 'Corrosion on the mount.',
      photos: [{ thumb: 'dGh1bWI=', full: 'ZnVsbA==' }],
    });
    expect(saved.entry.photos).toHaveLength(1);
    expect(backend.call('__uploadedUnderLock')).toBe(false);
    expect(backend.call('__appendedUnderLock')).toBe(true);
  });

  it('puts two order lines on two different rows', () => {
    const { token, mech } = seedJob();
    // Where the next append goes is remembered for the length of one request
    // now. Get that wrong and the second line lands on top of the first.
    backend.fn('addEntry', mech, token, {
      entryType: 'part', partIdentifier: 'TWO-LINE', text: 'Impeller', orderQty: 1, restockQty: 2,
    });
    const { needed } = backend.fn('listPartsOrders', adminToken);
    expect(needed).toHaveLength(2);
    expect(needed.map((p) => p.quantity).sort()).toEqual([1, 2]);
  });
});

describe('parts', () => {
  it('puts a part on the list when the mechanic says it needs ordering', () => {
    const { id, token, mech } = seedJob();
    backend.fn('addEntry', mech, token, {
      entryType: 'part', partIdentifier: '47-4516', quantity: 1, text: 'Ring gear', orderQty: 2,
    });
    const { needed } = backend.fn('listPartsOrders', adminToken);
    expect(needed).toHaveLength(1);
    expect(needed[0].partIdentifier).toBe('47-4516');
    expect(needed[0].quantity).toBe(2);
    expect(needed[0].reason).toBe('job');
    expect(needed[0].jobId).toBe(id);
  });

  it('can want one for the job and another to put back on the shelf', () => {
    const { token, mech } = seedJob();
    backend.fn('addEntry', mech, token, {
      entryType: 'part', partIdentifier: '4-4226', text: 'Drain plug', orderQty: 1, restockQty: 3,
    });
    const { needed } = backend.fn('listPartsOrders', adminToken);
    expect(needed).toHaveLength(2);
    expect(needed.map((p) => p.reason).sort()).toEqual(['job', 'restock']);
    expect(needed.find((p) => p.reason === 'restock').quantity).toBe(3);
  });

  it('leaves the list alone for a part that is simply used', () => {
    const { token, mech } = seedJob();
    backend.fn('addEntry', mech, token, { entryType: 'part', partIdentifier: 'ON-HAND', quantity: 1 });
    expect(backend.fn('listPartsOrders', adminToken).needed).toHaveLength(0);
  });

  it('takes a stock request with no work order behind it', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    backend.fn('requestPart', mech, { partIdentifier: 'ACD-41-983', description: 'Spark plugs', quantity: 8 });
    const { needed } = backend.fn('listPartsOrders', adminToken);
    expect(needed[0].jobId).toBeNull();
    expect(needed[0].reason).toBe('stock');
    expect(needed[0].requestedBy).toBe('Dale');
  });

  it('accepts a request with no part number, but not one with nothing at all', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('requestPart', mech, { description: 'That black hose clamp' })).not.toThrow();
    expect(() => backend.fn('requestPart', mech, { partIdentifier: '', description: '' }))
      .toThrow(/Say which part/);
  });

  it('moves a batch onto an order, then archives it once every line is in', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    backend.fn('requestPart', mech, { partIdentifier: 'A-1', description: 'One' });
    backend.fn('requestPart', mech, { partIdentifier: 'B-2', description: 'Two' });
    const ids = backend.fn('listPartsOrders', adminToken).needed.map((p) => p.id);

    let list = backend.fn('markPartsOrdered', adminToken, ids, 'Mercury', 'PO-9912');
    expect(list.needed).toHaveLength(0);
    expect(list.ordered).toHaveLength(2);
    expect(list.completed).toHaveLength(0);
    expect(list.ordered[0].vendor).toBe('Mercury');
    expect(list.ordered[0].orderNumber).toBe('PO-9912');

    // Half an order in is still an open order.
    list = backend.fn('markPartReceived', adminToken, ids[0], true);
    expect(list.ordered).toHaveLength(1);
    expect(list.completed).toHaveLength(0);

    list = backend.fn('markPartReceived', adminToken, ids[1], true);
    expect(list.ordered).toHaveLength(0);
    expect(list.completed).toHaveLength(1);
    expect(list.completed[0].orderNumber).toBe('PO-9912');
    expect(list.completed[0].parts).toHaveLength(2);
  });

  it('will not let a batch go out without saying who it went to', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    backend.fn('requestPart', mech, { partIdentifier: 'A-1' });
    const ids = backend.fn('listPartsOrders', adminToken).needed.map((p) => p.id);
    expect(() => backend.fn('markPartsOrdered', adminToken, ids, '', 'PO-1')).toThrow(/ordered from/);
  });

  it('carries a note at any stage, which is the point of it', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    const part = backend.fn('requestPart', mech, { partIdentifier: 'A-1' }).part;
    backend.fn('setPartNote', mech, part.id, 'Waiting on the customer to confirm the colour');
    expect(backend.fn('listPartsOrders', adminToken).needed[0].notes).toContain('Waiting on the customer');

    backend.fn('markPartsOrdered', adminToken, [part.id], 'Mercury', 'PO-1');
    backend.fn('setPartNote', adminToken, part.id, 'Backordered until March');
    expect(backend.fn('listPartsOrders', adminToken).ordered[0].notes).toBe('Backordered until March');
  });

  it('sends the writer a list at 3pm, even when there is nothing on it', () => {
    backend.sentMail.length = 0;
    backend.fn('sendDailyOrders');
    expect(backend.sentMail).toHaveLength(1);
    expect(backend.sentMail[0].to).toBe('service@questwatersports.com');
    expect(backend.sentMail[0].opts.htmlBody).toContain('nothing');

    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    backend.fn('requestPart', mech, { partIdentifier: 'A-1', description: 'Impeller', quantity: 2 });
    backend.fn('setPartNote', mech, backend.fn('listPartsOrders', adminToken).needed[0].id, 'On backorder');
    backend.sentMail.length = 0;
    backend.fn('sendDailyOrders');
    const html = backend.sentMail[0].opts.htmlBody;
    expect(html).toContain('A-1');
    expect(html).toContain('Impeller');
    expect(html).toContain('On backorder');
  });
});

describe("the writer's close-out", () => {
  it('draws a line under what has been written up, so later entries stand out', () => {
    const { id, token, mech } = seedJob();
    expect(backend.fn('getJob', adminToken, id).entries.every((e) => !e.loggedAt)).toBe(true);

    const result = backend.fn('markEntriesLogged', adminToken, id);
    expect(result.logged).toBe(4);
    expect(backend.fn('getJob', adminToken, id).entries.every((e) => e.loggedAt)).toBe(true);

    // Something added afterwards is on the other side of that line.
    backend.fn('addEntry', mech, token, { entryType: 'internal_note', text: 'Found another thing.' });
    const entries = backend.fn('getJob', adminToken, id).entries;
    expect(entries.filter((e) => !e.loggedAt)).toHaveLength(1);
    expect(entries.filter((e) => e.loggedAt)).toHaveLength(4);
  });

  it('remembers parts ordered and paid, and lets them be un-ticked', () => {
    const { id } = seedJob();
    expect(backend.fn('getJob', adminToken, id).job.paidAt).toBeNull();

    backend.fn('setJobFlag', adminToken, id, 'paid', true);
    expect(backend.fn('getJob', adminToken, id).job.paidAt).toBeTruthy();
    backend.fn('setJobFlag', adminToken, id, 'paid', false);
    expect(backend.fn('getJob', adminToken, id).job.paidAt).toBeNull();

    backend.fn('setJobFlag', adminToken, id, 'partsOrdered', true);
    expect(backend.fn('getJob', adminToken, id).job.partsOrderedAt).toBeTruthy();
    expect(() => backend.fn('setJobFlag', adminToken, id, 'nonsense', true)).toThrow(/Unknown checkbox/);
  });

  it('keeps the whole checklist on the shop side of the wall', () => {
    const { id, token } = seedJob();
    backend.fn('markEntriesLogged', adminToken, id);
    backend.fn('setJobFlag', adminToken, id, 'paid', true);
    const seen = JSON.stringify(backend.fn('publicJob', token, adminToken));
    expect(seen).not.toContain('loggedAt');
    expect(seen).not.toContain('paidAt');
  });
});

describe('test mode', () => {
  it('is on by default, so a fresh deployment cannot email a customer', () => {
    const fresh = loadBackend({ properties: { ADMIN_PASSWORD: 'x' } });
    expect(fresh.fn('testMode_')).toBe(true);
  });

  it('sends the customer email to the shop instead, marked as what they would have got', () => {
    const { id } = seedJob();
    backend.fn('saveInvoice', adminToken, id, 'https://pos.example.com/pay/abc', 'JVBERi0=', {
      grandTotal: 100, deposits: 0, amountDue: 100,
    });
    backend.fn('markDone', adminToken, id);
    expect(backend.sentMail).toHaveLength(0);

    const result = backend.fn('sendInvoiceEmail', adminToken, id);
    expect(result.testMode).toBe(true);
    expect(backend.sentMail).toHaveLength(1);
    const mail = backend.sentMail[0];
    expect(mail.to).toBe('service@questwatersports.com');
    expect(mail.to).not.toBe('jane@example.com');
    expect(mail.subject).toMatch(/^\[TEST\]/);
    expect(mail.opts.htmlBody).toContain('TEST MODE');
    // Whoever reads it needs to know who it was meant for.
    expect(mail.opts.htmlBody).toContain('jane@example.com');
  });

  it('says in the log that the email was held, and from whom', () => {
    const { id } = seedJob();
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);
    const log = backend.fn('getJob', adminToken, id).emails.find((m) => m.kind === 'customer_done_test');
    expect(log.status).toBe('held (test mode)');
    expect(log.error).toContain('jane@example.com');
  });

  it('still closes the job out properly — it is a rehearsal, not a mock', () => {
    const { id } = seedJob();
    backend.fn('markDone', adminToken, id);
    expect(backend.fn('jobRow_', id).status).toBe('done');
  });

  it('shows a customer nothing but a holding notice', () => {
    const { token } = seedJob();
    const seen = backend.fn('publicJob', token, '');
    expect(seen.notLive).toBe(true);
    expect(seen.entries).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('Impeller was shot');
  });

  it('shows shop staff the real page, so it can be debugged against live jobs', () => {
    const { token } = seedJob();
    const staff = backend.fn('publicJob', token, adminToken);
    expect(staff.notLive).toBeUndefined();
    expect(staff.testMode).toBe(true);
    expect(staff.entries).toHaveLength(1);

    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(backend.fn('publicJob', token, mech).entries).toHaveLength(1);
  });

  it('going live is one switch, and it takes', () => {
    const { id } = seedJob();
    backend.fn('setTestMode', adminToken, false);
    expect(backend.fn('config', adminToken).testMode).toBe(false);

    backend.sentMail.length = 0;
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);
    expect(backend.sentMail[0].to).toBe('jane@example.com');
    expect(backend.sentMail[0].subject).not.toMatch(/TEST/);
  });

  it('only an admin can flip it', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('setTestMode', mech, false)).toThrow(/Sign in/);
    expect(() => backend.fn('setTestMode', '', false)).toThrow(/Sign in/);
  });
});

describe('the customer email', () => {
  it('goes out once, under the shop name, with replies aimed at the service desk', () => {
    goLive();
    const { id } = seedJob();
    backend.fn('saveInvoice', adminToken, id, 'https://pos.example.com/pay/abc', 'JVBERi0=');
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);

    expect(backend.sentMail).toHaveLength(1);
    const mail = backend.sentMail[0];
    expect(mail.to).toBe('jane@example.com');
    expect(mail.opts.name).toBe('Quest Watersports');
    expect(mail.opts.replyTo).toBe('service@questwatersports.com');
    expect(mail.opts.htmlBody).toContain('Pay online');
    expect(mail.opts.htmlBody).toContain('1851 Old Chicago Road');
    // Never the shop's own numbers.
    expect(mail.opts.htmlBody).not.toContain('6BH-44352');
    expect(mail.opts.htmlBody).not.toContain('1.5 h');
  });

  it('says what the customer owes, not what the job cost', () => {
    goLive();
    const { id } = seedJob();
    backend.fn('saveInvoice', adminToken, id, 'https://pos.example.com/pay/abc', 'JVBERi0=', {
      grandTotal: 16917.79, deposits: 15285.32, amountDue: 1632.47,
    });
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);

    const html = backend.sentMail[0].opts.htmlBody;
    expect(html).toContain('$1,632.47');
    expect(html).toContain('$15,285.32');
    expect(html).toContain('Pay $1,632.47');
    expect(backend.sentMail[0].body).toContain('Amount due: $1,632.47');
  });

  it('closes a job with no address on file, and refuses only the email', () => {
    // Walk-ins take their invoice at the counter; that is not a reason the
    // ticket cannot be closed.
    backend.fn('createJob', adminToken, { invoiceNumber: '01-9001', customerName: 'No Email' });
    backend.fn('markDone', adminToken, '01-9001');
    expect(backend.fn('jobRow_', '01-9001').status).toBe('done');
    expect(() => backend.fn('sendInvoiceEmail', adminToken, '01-9001')).toThrow(/nobody to send/);
  });

  it('will not send before the job is done', () => {
    const { id } = seedJob();
    expect(() => backend.fn('sendInvoiceEmail', adminToken, id)).toThrow(/not marked done/);
    expect(backend.sentMail).toHaveLength(0);
  });

  it('sends again on demand, because addresses get corrected', () => {
    goLive();
    const { id } = seedJob();
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);
    expect(backend.sentMail).toHaveLength(2);
  });

  it('only an admin can send it', () => {
    goLive();
    const { id } = seedJob();
    backend.fn('markDone', adminToken, id);
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('sendInvoiceEmail', mech, id)).toThrow(/Sign in/);
    expect(backend.sentMail).toHaveLength(0);
  });
});

describe('a voice note coming back with its words', () => {
  // AssemblyAI: upload the audio, ask for a transcript, then it calls back.
  function assemblyBackend(options = {}) {
    const back = loadBackend({
      properties: {
        ADMIN_PASSWORD: 'shop-password',
        ASSEMBLYAI_API_KEY: 'test-key',
        // Not a script.google.com URL on purpose: verify.sh forbids one
        // outside config.js, and a test fixture must not be the exception
        // that teaches people to weaken that guard.
        WEB_APP_URL: 'https://backend.test/exec',
      },
      fetch: (url) => {
        if (url.endsWith('/v2/upload')) return { code: 200, body: { upload_url: 'https://cdn/audio' } };
        if (url.endsWith('/v2/transcript')) return { code: 200, body: { id: 'tr_1' } };
        if (url.endsWith('/v2/transcript/tr_1')) {
          return { code: 200, body: { status: 'completed', text: 'Impeller was shot, swapped it out.' } };
        }
        return { code: 404, body: {} };
      },
    });
    const admin = back.fn('adminSignIn', 'shop-password').token;
    back.fn('createJob', admin, { invoiceNumber: '01-8891', customerName: 'Garrett B' });
    const jobToken = back.fn('jobRow_', '01-8891').token;
    const mech = back.fn('mechanicSignIn', 'Dale', true).token;
    back.fn('addEntry', mech, jobToken,
      options.entry || { entryType: 'labor', hours: 0.25, audio: 'YXVkaW8=' });
    return { back, admin };
  }

  it('submits the recording and waits, rather than making the mechanic wait', () => {
    const { back, admin } = assemblyBackend();
    const entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.transcriptStatus).toBe('pending');
    expect(back.fetched.some((f) => f.url.endsWith('/v2/upload'))).toBe(true);
  });

  it('tells AssemblyAI where to call back', () => {
    const { back } = assemblyBackend();
    const ask = back.fetched.find((f) => f.url.endsWith('/v2/transcript'));
    expect(JSON.parse(ask.options.payload).webhook_url).toContain('hook=transcript');
  });

  it('takes the callback as a POST with the id in the body', () => {
    // AssemblyAI POSTs its webhook and puts transcript_id in the BODY. The
    // handler used to live on doGet and read the query string, so every
    // callback was answered "Unknown function." and the note sat on
    // "transcribing…" until the hourly sweep caught it.
    const { back, admin } = assemblyBackend();
    const ask = back.fetched.find((f) => f.url.endsWith('/v2/transcript'));
    const hook = new URL(JSON.parse(ask.options.payload).webhook_url);

    const answer = back.post(
      { hook: 'transcript', k: hook.searchParams.get('k') },
      { transcript_id: 'tr_1', status: 'completed' },
    );
    expect(answer.ok).toBe(true);

    const entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.transcript).toBe('Impeller was shot, swapped it out.');
    expect(entry.transcriptStatus).toBe('done');
  });

  it('refuses a callback that does not carry the secret', () => {
    const { back, admin } = assemblyBackend();
    back.post({ hook: 'transcript', k: 'wrong' }, { transcript_id: 'tr_1', status: 'completed' });
    expect(back.fn('getJob', admin, '01-8891').entries[0].transcriptStatus).toBe('pending');
  });

  it('answers the phone with just the transcript state', () => {
    // The mechanic is still standing there, so the phone polls for the
    // words. Polling jobForMechanic would re-read every entry, the job and
    // the hours to watch one field change.
    const { back } = assemblyBackend();
    const mech = back.fn('mechanicSignIn', 'Dale', true).token;
    const jobToken = back.fn('jobRow_', '01-8891').token;

    const waiting = back.fn('transcriptsFor', mech, jobToken);
    expect(waiting.entries).toHaveLength(1);
    expect(waiting.entries[0].transcriptStatus).toBe('pending');
    // Nothing but what the poll needs.
    expect(Object.keys(waiting.entries[0]).sort())
      .toEqual(['id', 'text', 'transcript', 'transcriptError', 'transcriptStatus']);

    back.fn('sweepTranscripts_');
    const done = back.fn('transcriptsFor', mech, jobToken);
    expect(done.entries[0].transcriptStatus).toBe('done');
    expect(done.entries[0].transcript).toBe('Impeller was shot, swapped it out.');
  });

  it('leaves out entries that were never spoken', () => {
    const { back, admin } = assemblyBackend();
    const mech = back.fn('mechanicSignIn', 'Dale', true).token;
    const jobToken = back.fn('jobRow_', '01-8891').token;
    back.fn('addEntry', mech, jobToken, { entryType: 'internal_note', text: 'Typed, not spoken.' });

    expect(back.fn('transcriptsFor', mech, jobToken).entries).toHaveLength(1);
    expect(back.fn('getJob', admin, '01-8891').entries).toHaveLength(2);
  });

  it('needs a signed-in mechanic, and a job that exists', () => {
    const { back } = assemblyBackend();
    const jobToken = back.fn('jobRow_', '01-8891').token;
    expect(() => back.fn('transcriptsFor', '', jobToken)).toThrow(/Sign in/);
    const mech = back.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => back.fn('transcriptsFor', mech, 'NOPE')).toThrow(/No such job/);
  });

  it('still catches it on the hourly sweep if the callback never arrives', () => {
    const { back, admin } = assemblyBackend();
    back.fn('sweepTranscripts_');
    expect(back.fn('getJob', admin, '01-8891').entries[0].transcript)
      .toBe('Impeller was shot, swapped it out.');
  });

  it('keeps what was typed as well as what was said', () => {
    // A mechanic who records AND types has said two things. The transcript
    // used to be skipped entirely when there was a typed note beside it, so
    // the recording was stored and never turned into words.
    const { back, admin } = assemblyBackend({
      entry: { entryType: 'internal_note', text: 'Impeller housing, port side.',
               audio: 'YXVkaW8=', audioMime: 'audio/webm' },
    });
    back.fn('sweepTranscripts_');
    const entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.text).toBe('Impeller housing, port side.');
    expect(entry.transcript).toBe('Impeller was shot, swapped it out.');
    expect(entry.audioFile).toBeTruthy();
  });

  it('and does not lose the words if setup() has not been run yet', () => {
    // Between this deploy and somebody running setup() there is no transcript
    // column, so the words would be written to a cell with no header and read
    // back as nothing. They go where they always went instead.
    const { back, admin } = assemblyBackend();
    const sheet = back.sheet('LogEntries');
    const at = sheet.rows[0].indexOf('transcript');
    expect(at).toBeGreaterThan(-1);
    sheet.rows[0][at] = '';                       // the header before setup()
    back.call('forget_(); _headers = {};');
    back.fn('sweepTranscripts_');
    const entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.text).toBe('Impeller was shot, swapped it out.');
  });

  it('and waits rather than choosing between them when both exist', () => {
    // Nothing typed can be written over to make room, and the words are not
    // worth throwing away, so the entry stays pending until the column is
    // there and the next sweep puts them where they belong.
    const { back, admin } = assemblyBackend({
      entry: { entryType: 'internal_note', text: 'Impeller housing, port side.',
               audio: 'YXVkaW8=', audioMime: 'audio/webm' },
    });
    const sheet = back.sheet('LogEntries');
    const at = sheet.rows[0].indexOf('transcript');
    sheet.rows[0][at] = '';
    back.call('forget_(); _headers = {};');
    back.fn('sweepTranscripts_');
    let entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.text).toBe('Impeller housing, port side.');
    expect(entry.transcript).toBeNull();
    expect(entry.transcriptStatus).toBe('pending');

    // setup() puts the header right; the next sweep finishes the job.
    sheet.rows[0][at] = 'transcript';
    back.call('forget_(); _headers = {};');
    back.fn('sweepTranscripts_');
    entry = back.fn('getJob', admin, '01-8891').entries[0];
    expect(entry.text).toBe('Impeller housing, port side.');
    expect(entry.transcript).toBe('Impeller was shot, swapped it out.');
    expect(entry.transcriptStatus).toBe('done');
  });
});

describe('what the mechanic needs before touching the boat', () => {
  it('carries the work asked for onto the job', () => {
    backend.fn('createJob', adminToken, {
      invoiceNumber: '01-8891',
      customerName: 'Garrett B',
      boatInfo: '1995 Glastron 15ft',
      workRequested: 'Look over shift cable. Call customer to go over specifics.',
    });
    expect(backend.fn('getJob', adminToken, '01-8891').job.workRequested)
      .toBe('Look over shift cable. Call customer to go over specifics.');
  });

  it('answers a typed-in number with the work, not just the boat', () => {
    // Typing the number instead of scanning means the paper is somewhere
    // else, so the job has to say what it needs.
    backend.fn('createJob', adminToken, {
      invoiceNumber: '01-8891', customerName: 'Garrett B', workRequested: 'Look over shift cable.',
    });
    expect(backend.fn('lookupJob', '01-8891', 'typed').job.workRequested).toBe('Look over shift cable.');
  });

  it('lets the writer correct it', () => {
    backend.fn('createJob', adminToken, { invoiceNumber: '01-8891', workRequested: 'Garbled OCR' });
    backend.fn('saveJobDetails', adminToken, '01-8891', { workRequested: 'Replace impeller' });
    expect(backend.fn('jobRow_', '01-8891').work_requested).toBe('Replace impeller');
  });
});

describe('a note from the office to the floor', () => {
  it('lands in the shop log where the mechanic will see it', () => {
    const { id, token } = seedJob();
    backend.fn('addWriterNote', adminToken, id, 'Owner wants a call before you pull the lower unit.');

    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    const seen = backend.fn('jobLog', mech, token).entries;
    const note = seen.find((e) => e.entryType === 'writer_note');
    expect(note.text).toBe('Owner wants a call before you pull the lower unit.');
    expect(note.mechanicName).toBe('Service writer');
  });

  it('never reaches the customer, even with the page on and live', () => {
    goLive();
    const { id, token } = seedJob();
    backend.fn('addWriterNote', adminToken, id, 'Owner is a friend of the boss, be careful.');

    const seen = JSON.stringify(backend.fn('publicJob', token));
    expect(seen).not.toContain('friend of the boss');
    expect(seen).not.toContain('writer_note');
  });

  it('is logged in order, not pinned to the job', () => {
    // A note added on Tuesday should not look like it was there at intake.
    const { id } = seedJob();
    const before = backend.fn('getJob', adminToken, id).entries.length;
    backend.fn('addWriterNote', adminToken, id, 'Second thought about the impeller.');
    const after = backend.fn('getJob', adminToken, id).entries;
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1].entryType).toBe('writer_note');
  });

  it('carries no hours, no part number, no photos', () => {
    const { id } = seedJob();
    backend.fn('addWriterNote', adminToken, id, 'Just words.');
    const note = backend.fn('getJob', adminToken, id).entries.find((e) => e.entryType === 'writer_note');
    expect(note.hours).toBeNull();
    expect(note.partIdentifier).toBeNull();
    expect(note.photos).toEqual([]);
  });

  it('only the writer can add one, and not an empty one', () => {
    const { id } = seedJob();
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('addWriterNote', mech, id, 'hello')).toThrow(/Sign in/);
    expect(() => backend.fn('addWriterNote', adminToken, id, '   ')).toThrow(/Write the note/);
    expect(() => backend.fn('addWriterNote', adminToken, 'nope', 'hello')).toThrow(/No such job/);
  });
});

describe('picking a job off a list', () => {
  function seedFloor() {
    backend.fn('createJob', adminToken, {
      invoiceNumber: '01-8891', customerName: 'Garrett B', boatInfo: '1995 Glastron 15ft',
    });
    backend.fn('createJob', adminToken, {
      invoiceNumber: '01-8892', customerName: 'Jane Rivers', boatInfo: '2019 Yamaha 242X',
      customerEmail: 'jane@example.com',
    });
    return backend.fn('mechanicSignIn', 'Dale', true).token;
  }

  it('lists ticket, customer and boat for everything still open', () => {
    const mech = seedFloor();
    const { jobs } = backend.fn('openJobs', mech);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id).sort()).toEqual(['01-8891', '01-8892']);
    const one = jobs.find((j) => j.id === '01-8891');
    expect(one.customerName).toBe('Garrett B');
    expect(one.boatInfo).toBe('1995 Glastron 15ft');
    // The token is what opening the job needs.
    expect(one.token).toMatch(/^[0-9A-HJ-NP-TV-Z]{20}$/);
  });

  it('drops a job once it is closed out', () => {
    const mech = seedFloor();
    backend.fn('markDone', adminToken, '01-8892');
    expect(backend.fn('openJobs', mech).jobs.map((j) => j.id)).toEqual(['01-8891']);
  });

  it('puts the boats being worked on at the top', () => {
    const mech = seedFloor();
    const token = backend.fn('jobRow_', '01-8892').token;
    backend.fn('addEntry', mech, token, { entryType: 'internal_note', text: 'Started on it.' });
    expect(backend.fn('openJobs', mech).jobs[0].id).toBe('01-8892');
  });

  it('needs a signed-in mechanic — it is every customer on the floor at once', () => {
    // Looking one job up by its number means you are holding the paper.
    // Listing them all is a different disclosure and needs the roster.
    seedFloor();
    expect(() => backend.fn('openJobs', '')).toThrow(/Sign in/);
    expect(() => backend.fn('openJobs', 'not-a-token')).toThrow(/Sign in/);
  });

  it('and does not leak the shop\'s own bookkeeping', () => {
    const mech = seedFloor();
    backend.fn('setJobFlag', adminToken, '01-8891', 'paid', true);
    const seen = JSON.stringify(backend.fn('openJobs', mech));
    expect(seen).not.toContain('paidAt');
    expect(seen).not.toContain('amountDue');
    expect(seen).not.toContain('customer_email');
    expect(seen).not.toContain('jane@example.com');
  });
});

describe('a BiT invoice number as a primary key', () => {
  // Sheets reads `01-8891` as the first of January, 8891. That turned the
  // job's own id into a Date, every lookup by id missed, and the portal
  // answered "No such job." on a job sitting in its own list.
  it('stays the number printed on the paper', () => {
    backend.fn('createJob', adminToken, { invoiceNumber: '01-8891', customerName: 'Garrett Bennett' });
    expect(backend.fn('jobRow_', '01-8891').id).toBe('01-8891');
  });

  it('opens the job the list links to', () => {
    const { id } = seedJob('01-8891');
    const listed = backend.fn('listJobs', adminToken, {}).jobs[0];
    expect(listed.id).toBe('01-8891');
    // Exactly what the portal does with the id it was handed.
    expect(backend.fn('getJob', adminToken, listed.id).job.id).toBe('01-8891');
    expect(id).toBe('01-8891');
  });

  it('keeps a job and its entries together', () => {
    const { id } = seedJob('01-8891');
    expect(backend.fn('getJob', adminToken, id).entries).toHaveLength(4);
  });

  it('survives a timestamp being date-shaped too', () => {
    seedJob('01-8891');
    const created = backend.fn('jobRow_', '01-8891').created_at;
    expect(typeof created).toBe('string');
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('puts back an id an older deployment already mangled', () => {
    seedJob('01-8891');
    // Force the damage the old code did: a General cell holding a Date.
    const jobs = backend.sheet('Jobs');
    const entries = backend.sheet('LogEntries');
    jobs.rows[1][0] = new Date(8891, 0, 1);
    entries.rows.slice(1).forEach((row) => { row[1] = new Date(8891, 0, 1); });
    backend.fn('forget_');
    expect(backend.fn('jobRow_', '01-8891')).toBeNull();

    expect(backend.fn('repairCoercedIds_')).toEqual(['01-8891']);
    expect(backend.fn('jobRow_', '01-8891').id).toBe('01-8891');
    expect(backend.fn('getJob', adminToken, '01-8891').entries).toHaveLength(4);
  });
});

describe('the mailed sign-in link', () => {
  it('goes to the service desk and nowhere else', () => {
    const result = backend.fn('requestMagicLink');
    expect(result.sentTo).toBe('service@questwatersports.com');
    expect(backend.sentMail).toHaveLength(1);
    expect(backend.sentMail[0].to).toBe('service@questwatersports.com');
  });

  it('takes no recipient, so it cannot be aimed at a stranger', () => {
    // Whatever an unauthenticated caller passes is ignored: the address is a
    // constant, which is the whole of this endpoint's safety.
    backend.fn('requestMagicLink', 'attacker@example.com');
    expect(backend.sentMail[0].to).toBe('service@questwatersports.com');
  });

  it('signs the writer in when the link is followed', () => {
    backend.fn('requestMagicLink');
    const link = backend.sentMail[0].body.match(/\?k=([0-9A-Z]{20})/)[1];
    const token = backend.fn('magicSignIn', link).token;
    expect(backend.fn('config', token).testMode).toBe(true);
  });

  it('spends the link — a second use is refused', () => {
    backend.fn('requestMagicLink');
    const link = backend.sentMail[0].body.match(/\?k=([0-9A-Z]{20})/)[1];
    backend.fn('magicSignIn', link);
    expect(() => backend.fn('magicSignIn', link)).toThrow(/already been used/);
  });

  it('refuses a link that expired', () => {
    backend.fn('requestMagicLink');
    const link = backend.sentMail[0].body.match(/\?k=([0-9A-Z]{20})/)[1];
    backend.fn('props_').setProperty('MAGIC_EXP', String(Date.now() - 1000));
    expect(() => backend.fn('magicSignIn', link)).toThrow(/expired/);
  });

  it('refuses a guess without burning the real link', () => {
    // Otherwise anyone who can reach the endpoint could stop the writer
    // signing in, just by posting rubbish at it.
    backend.fn('requestMagicLink');
    const real = backend.sentMail[0].body.match(/\?k=([0-9A-Z]{20})/)[1];
    expect(() => backend.fn('magicSignIn', 'ZZZZZZZZZZZZZZZZZZZZ')).toThrow(/already been used/);
    expect(() => backend.fn('magicSignIn', '')).toThrow();
    expect(backend.fn('magicSignIn', real).token).toBeTruthy();
  });

  it('throttles, because the day only holds about a hundred emails', () => {
    backend.fn('requestMagicLink');
    expect(() => backend.fn('requestMagicLink')).toThrow(/ask again in/i);
    expect(backend.sentMail).toHaveLength(1);
  });

  it('voids the previous link when a fresh one is asked for', () => {
    backend.fn('requestMagicLink');
    const first = backend.sentMail[0].body.match(/\?k=([0-9A-Z]{20})/)[1];

    backend.fn('props_').setProperty('MAGIC_SENT_AT', '0');
    backend.fn('requestMagicLink');
    const second = backend.sentMail[1].body.match(/\?k=([0-9A-Z]{20})/)[1];
    expect(second).not.toBe(first);

    expect(() => backend.fn('magicSignIn', first)).toThrow(/replaced it|already been used/);
    expect(backend.fn('magicSignIn', second).token).toBeTruthy();
  });

  it('carries a link to the portal, not to a job', () => {
    backend.fn('requestMagicLink');
    const mail = backend.sentMail[0];
    expect(mail.body).toContain('/admin/?k=');
    expect(mail.opts.htmlBody).toContain('Open the portal');
  });
});

describe('running as an internal tool', () => {
  it('keeps the customer page dark by default, live or not', () => {
    const { token } = seedJob();
    backend.fn('setTestMode', adminToken, false);

    const seen = backend.fn('publicJob', token, '');
    expect(seen.notLive).toBe(true);
    expect(seen.reason).toBe('off');
    expect(seen.entries).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('Impeller was shot');
  });

  it('tells the customer a different thing while it is only a rehearsal', () => {
    const { token } = seedJob();
    backend.fn('setCustomerTracking', adminToken, true);
    expect(backend.fn('publicJob', token, '').reason).toBe('test');
  });

  it('stays dark on the strength of either switch alone', () => {
    const { token } = seedJob();
    backend.fn('setCustomerTracking', adminToken, true);
    expect(backend.fn('publicJob', token, '').notLive).toBe(true);

    backend.fn('setCustomerTracking', adminToken, false);
    backend.fn('setTestMode', adminToken, false);
    expect(backend.fn('publicJob', token, '').notLive).toBe(true);
  });

  it('still lets the writer preview the page', () => {
    const { token } = seedJob();
    expect(backend.fn('publicJob', token, adminToken).entries).toHaveLength(1);
  });

  it('leaves no tracking link in the invoice email', () => {
    backend.fn('setTestMode', adminToken, false);
    const { id } = seedJob();
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);

    const mail = backend.sentMail[0];
    expect(mail.opts.htmlBody).not.toContain('/t/?j=');
    expect(mail.opts.htmlBody).not.toContain('View your job');
    expect(mail.body).not.toContain('Job status:');
    // The invoice itself still goes, which is the whole point of sending it.
    expect(mail.to).toBe('jane@example.com');
  });

  it('puts the link back when the page is switched on again', () => {
    goLive();
    const { id, token } = seedJob();
    backend.fn('markDone', adminToken, id);
    backend.fn('sendInvoiceEmail', adminToken, id);
    expect(backend.sentMail[0].opts.htmlBody).toContain(token);
    expect(backend.fn('publicJob', token, '').notLive).toBeUndefined();
  });

  it('only an admin can flip it', () => {
    const mech = backend.fn('mechanicSignIn', 'Dale', true).token;
    expect(() => backend.fn('setCustomerTracking', mech, true)).toThrow(/Sign in/);
    expect(() => backend.fn('setCustomerTracking', '', true)).toThrow(/Sign in/);
  });
});

describe('the hourly digest', () => {
  it('sends one email per job covering everything new, then stops repeating it', () => {
    seedJob('01-8886');
    seedJob('01-8887');
    backend.sentMail.length = 0;

    backend.fn('sendDigest');
    expect(backend.sentMail).toHaveLength(2);
    const first = backend.sentMail[0];
    expect(first.to).toBe('service@questwatersports.com');
    expect(first.subject).toMatch(/4 new entries/);
    // The writer's digest is the one place the shop's own numbers belong.
    expect(first.opts.htmlBody).toContain('6BH-44352-00-00');
    expect(first.opts.htmlBody).toContain('1.5 h');

    backend.sentMail.length = 0;
    backend.fn('sendDigest');
    expect(backend.sentMail).toHaveLength(0);
  });
});
