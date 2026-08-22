import { beforeEach, describe, expect, it } from 'vitest';
import { loadBackend } from './helpers/apps-script-stubs.js';

let backend;
let adminToken;

/** A job with one of every kind of entry logged against it. */
function seedJob(id = '01-8886') {
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
  backend.fn('addEntry', mech, token, {
    entryType: 'labor',
    hours: 1.5,
    text: 'Pulled and reset the impeller housing.',
  });
  return { id, token, mech };
}

beforeEach(() => {
  backend = loadBackend({ properties: { ADMIN_PASSWORD: 'shop-password' } });
  adminToken = backend.fn('adminSignIn', 'shop-password').token;
});

/** Most of this suite describes the shop once it has gone live. */
function goLive() {
  backend.fn('setTestMode', adminToken, false);
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
  it('shares every stored file by link, so a page can show it directly', () => {
    seedJob();
    expect(backend.sharing.size).toBeGreaterThan(0);
    for (const value of backend.sharing.values()) {
      expect(value).toBe('ANYONE_WITH_LINK/VIEW');
    }
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
    expect(totals.total).toBe(3.5);
    expect(totals.byMechanic).toEqual([
      { name: 'Rae', hours: 2 },
      { name: 'Dale', hours: 1.5 },
    ]);
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
      .toThrow(/how many hours/i);
    expect(() => backend.fn('addEntry', mech, token, { entryType: 'labor', hours: 0, text: 'x' }))
      .toThrow(/greater than zero/);
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

  it('will not take a token somebody edited', () => {
    const forged = adminToken.slice(0, -4) + 'AAAA';
    expect(() => backend.fn('listJobs', forged, {})).toThrow(/Sign in/);
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
    const result = backend.fn('markDone', adminToken, id);

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
    const { id, token } = seedJob();
    backend.fn('setTestMode', adminToken, false);
    expect(backend.fn('config', adminToken).testMode).toBe(false);
    expect(backend.fn('publicJob', token, '').notLive).toBeUndefined();

    backend.sentMail.length = 0;
    backend.fn('markDone', adminToken, id);
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

    const html = backend.sentMail[0].opts.htmlBody;
    expect(html).toContain('$1,632.47');
    expect(html).toContain('$15,285.32');
    expect(html).toContain('Pay $1,632.47');
    expect(backend.sentMail[0].body).toContain('Amount due: $1,632.47');
  });

  it('refuses to mark done with no address on file', () => {
    backend.fn('createJob', adminToken, { invoiceNumber: '01-9001', customerName: 'No Email' });
    expect(() => backend.fn('markDone', adminToken, '01-9001')).toThrow(/nobody to send/);
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
