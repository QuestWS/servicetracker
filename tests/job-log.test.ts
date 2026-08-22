import { beforeAll, describe, expect, it } from 'vitest';
import {
  createEntry,
  hoursByMechanic,
  listCustomerEntries,
  listEntries,
  setTranscriptText,
  totalHours,
} from '@/lib/entries';
import { createMechanic, findMechanicByName, signInByName } from '@/lib/mechanics';
import { createJob, getJob, setStatus, trackingUrl, type Job } from '@/lib/jobs';
import { storeFile } from '@/lib/files';

let job: Job;
let mechanicId: string;

beforeAll(async () => {
  const mechanic = createMechanic('Dale');
  mechanicId = mechanic.id;
  job = createJob({
    id: '01-9001',
    customerName: 'Jane Rivers',
    customerEmail: 'jane@example.com',
    boatInfo: '2019 Yamaha 242X',
  });
});

describe('what the customer is allowed to see', () => {
  it('shows customer notes and hides internal notes and parts', async () => {
    const photo = await storeFile({
      jobId: job.id,
      kind: 'photo',
      filename: 'impeller.jpg',
      mime: 'image/jpeg',
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    });

    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'customer_note',
      text: 'Impeller was shot — swapped it out.',
      photoFileIds: [photo.id],
    });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'internal_note',
      text: 'Owner never winterised this. Bill the extra hour.',
    });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'part',
      partIdentifier: '6BH-44352-00-00',
      quantity: 2,
      text: 'Impeller kit',
    });

    const shop = listEntries(job.id);
    expect(shop).toHaveLength(3);

    const customer = listCustomerEntries(job.id, job.tracking_token);
    expect(customer).toHaveLength(1);
    expect(customer[0].text).toContain('Impeller was shot');
    expect(customer[0].photos[0].url).toContain(job.tracking_token);

    const serialised = JSON.stringify(customer);
    expect(serialised).not.toContain('6BH-44352-00-00');
    expect(serialised).not.toContain('Bill the extra hour');
  });

  it('keeps a part internal even if it is filed as a customer note', () => {
    const entry = createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'part',
      partIdentifier: 'SECRET-PART',
      quantity: 1,
    });
    expect(entry.part_identifier).toBe('SECRET-PART');
    expect(JSON.stringify(listCustomerEntries(job.id, job.tracking_token))).not.toContain('SECRET-PART');
  });

  it('holds back a voice note until its transcript lands', () => {
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'customer_note',
      audioFileId: null,
      transcriptStatus: 'pending',
    });
    const customer = listCustomerEntries(job.id, job.tracking_token);
    expect(customer.every((entry) => entry.text || entry.photos.length)).toBe(true);
  });
});

describe('job identity and lifecycle', () => {
  it('builds an unguessable tracking URL from the token', () => {
    expect(trackingUrl(job)).toBe(`https://tracker.example.com/t/${job.tracking_token}`);
    expect(job.tracking_token).toMatch(/^[0-9A-HJ-NP-TV-Z]{20}$/);
  });

  it('stamps a timestamp on each stage and refuses to go backwards', () => {
    setStatus(job.id, 'work_underway', { type: 'mechanic', id: mechanicId });
    const underway = getJob(job.id)!;
    expect(underway.status).toBe('work_underway');
    expect(underway.work_started_at).not.toBeNull();

    const back = setStatus(job.id, 'received', { type: 'service_writer' });
    expect(back?.changed).toBe(false);
    expect(getJob(job.id)!.status).toBe('work_underway');

    setStatus(job.id, 'done', { type: 'service_writer' });
    expect(getJob(job.id)!.done_at).not.toBeNull();
  });
});

describe('signing in by name', () => {
  it('matches somebody already on the roster, however they type it', () => {
    for (const typed of ['Dale', 'dale', '  DALE  ']) {
      const result = signInByName(typed);
      expect(result.ok && result.mechanic.id).toBe(mechanicId);
      expect(result.ok && result.created).toBe(false);
    }
  });

  it('adds a name nobody has used before rather than turning them away', () => {
    const result = signInByName('Marisol Vega');
    expect(result.ok && result.created).toBe(true);
    expect(findMechanicByName('marisol vega')?.name).toBe('Marisol Vega');
  });

  it('refuses junk in the name field', () => {
    for (const junk of ['', 'x', '012345678905', '   ']) {
      expect(signInByName(junk)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses a name the office switched off', async () => {
    const { setMechanicActive } = await import('@/lib/mechanics');
    const gone = createMechanic('Former Employee');
    setMechanicActive(gone.id, false);
    expect(signInByName('former employee')).toEqual({ ok: false, reason: 'inactive' });
  });
});

describe('labor entries', () => {
  it('totals the hours across entries and splits them by mechanic', () => {
    const job = createJob({ id: '01-9100', customerName: 'Hours Test' });
    const second = createMechanic('Rae');
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'labor',
      hours: 1.5,
      text: 'Pulled and reset the impeller housing.',
    });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'labor',
      hours: 0.25,
      text: 'Road test.',
    });
    createEntry({ jobId: job.id, mechanicId: second.id, entryType: 'labor', hours: 2, text: 'Rigging.' });
    // A note is not labor, however long it took to write.
    createEntry({ jobId: job.id, mechanicId, entryType: 'internal_note', text: 'Ordered a clamp.' });

    expect(totalHours(job.id)).toBe(3.75);
    expect(hoursByMechanic(job.id)).toEqual([
      { name: 'Rae', hours: 2 },
      { name: 'Dale', hours: 1.75 },
    ]);
  });

  it('takes a dictated description instead of a typed one', async () => {
    const job = createJob({ id: '01-9103', customerName: 'Dictation' });
    const recording = await storeFile({
      jobId: job.id,
      kind: 'audio',
      filename: 'voice.webm',
      mime: 'audio/webm',
      bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    });

    const entry = createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'labor',
      hours: 0.75,
      audioFileId: recording.id,
      transcriptStatus: 'pending',
    });

    // The hours count immediately; the words follow when AssemblyAI answers.
    expect(totalHours(job.id)).toBe(0.75);
    expect(entry.text).toBeNull();

    const view = listEntries(job.id)[0];
    expect(view.hours).toBe(0.75);
    expect(view.transcript_status).toBe('pending');
    expect(view.audio_url).toContain(recording.id);

    setTranscriptText(entry.id, 'Pulled the impeller and re-torqued the mounts.');
    const transcribed = listEntries(job.id)[0];
    expect(transcribed.text).toContain('re-torqued');
    expect(transcribed.hours).toBe(0.75);
    expect(totalHours(job.id)).toBe(0.75);
  });

  it('keeps hours off an entry that is not labor', () => {
    const job = createJob({ id: '01-9101', customerName: 'Hours Test 2' });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'customer_note',
      hours: 8,
      text: 'Still working on it.',
    });
    expect(totalHours(job.id)).toBe(0);
    expect(listEntries(job.id)[0].hours).toBeNull();
  });

  it('never shows hours to the customer', () => {
    const job = createJob({ id: '01-9102', customerName: 'Hours Test 3' });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'labor',
      hours: 6,
      text: 'Rebuilt the lower unit.',
    });
    createEntry({
      jobId: job.id,
      mechanicId,
      entryType: 'customer_note',
      text: 'Lower unit is back together.',
    });

    const customer = listCustomerEntries(job.id, job.tracking_token);
    expect(customer).toHaveLength(1);
    const serialised = JSON.stringify(customer);
    expect(serialised).not.toContain('Rebuilt the lower unit');
    expect(serialised).not.toContain('"hours":6');
  });
});
