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

describe('what the customer is allowed to see', () => {
  it('shows customer notes and hides everything else', () => {
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

  it('withholds the invoice and payment link until the job is done', () => {
    const { id, token } = seedJob();
    backend.fn('saveInvoice', adminToken, id, 'https://pos.example.com/pay/abc', 'JVBERi0=');

    expect(backend.fn('publicJob', token).job.paymentLink).toBeNull();
    expect(backend.fn('publicJob', token).job.invoiceFile).toBeNull();

    backend.fn('markDone', adminToken, id);
    const done = backend.fn('publicJob', token);
    expect(done.job.paymentLink).toBe('https://pos.example.com/pay/abc');
    expect(done.job.invoiceFile).toBeTruthy();
  });

  it('holds a voice note back until its transcript lands', () => {
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

describe('the customer email', () => {
  it('goes out once, under the shop name, with replies aimed at the service desk', () => {
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
