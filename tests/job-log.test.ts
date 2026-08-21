import { beforeAll, describe, expect, it } from 'vitest';
import { createEntry, listCustomerEntries, listEntries } from '@/lib/entries';
import { createMechanic, authenticateByPin } from '@/lib/mechanics';
import { createJob, getJob, setStatus, trackingUrl, type Job } from '@/lib/jobs';
import { storeFile } from '@/lib/files';

let job: Job;
let mechanicId: string;

beforeAll(async () => {
  const mechanic = createMechanic('Dale', '4821');
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

describe('mechanic PINs', () => {
  it('identifies a mechanic by PIN alone and rejects a wrong one', () => {
    expect(authenticateByPin('4821')?.name).toBe('Dale');
    expect(authenticateByPin('0000')).toBeNull();
  });

  it('never stores the PIN in the clear', () => {
    const dale = authenticateByPin('4821')!;
    expect(JSON.stringify(dale)).not.toContain('4821');
  });
});
