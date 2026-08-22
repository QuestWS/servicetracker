import { describe, expect, it } from 'vitest';
import { looksLikeInvoiceNumber, tokenFromScan, trackingUrl } from '../assets/lib/tracking.js';
import { atLeast, isForward, formatHours } from '../assets/lib/entry-types.js';

describe('reading a scanned code', () => {
  const token = 'ABCDEFGHJKMNPQRSTVWX';

  it('accepts the tracking URL printed on the work order', () => {
    expect(tokenFromScan(`https://questws.github.io/servicetracker/t/?j=${token}`)).toBe(token);
    expect(tokenFromScan(`https://questws.github.io/servicetracker/t/?j=${token}&utm=x`)).toBe(token);
  });

  it('still reads a code printed under the old path scheme', () => {
    expect(tokenFromScan(`https://tracker.example.com/t/${token}`)).toBe(token);
    expect(tokenFromScan(`https://tracker.example.com/t/${token}/`)).toBe(token);
  });

  it('accepts a bare token, in either case', () => {
    expect(tokenFromScan(token)).toBe(token);
    expect(tokenFromScan(token.toLowerCase())).toBe(token);
  });

  it('rejects anything else, so a stray barcode cannot open a job', () => {
    expect(tokenFromScan('https://example.com/')).toBeNull();
    expect(tokenFromScan('012345678905')).toBeNull();
    expect(tokenFromScan('')).toBeNull();
    // The alphabet has no I, L, O or U — a lookalike is not a token.
    expect(tokenFromScan('ABCDEFGHIJKLMNOPQRST')).toBeNull();
  });

  it('recognises a hand-typed invoice number', () => {
    expect(looksLikeInvoiceNumber('01-8886')).toBe(true);
    expect(looksLikeInvoiceNumber('8886')).toBe(true);
    expect(looksLikeInvoiceNumber('not a number at all')).toBe(false);
  });

  it('builds the URL that gets printed as a QR code', () => {
    expect(trackingUrl('https://questws.github.io/servicetracker/', token))
      .toBe(`https://questws.github.io/servicetracker/t/?j=${token}`);
  });
});

describe('the status lifecycle', () => {
  it('only ever moves forward', () => {
    expect(isForward('received', 'work_underway')).toBe(true);
    expect(isForward('work_underway', 'done')).toBe(true);
    expect(isForward('done', 'received')).toBe(false);
    expect(isForward('work_finished', 'work_underway')).toBe(false);
  });

  it('knows when a job has reached a stage', () => {
    expect(atLeast('done', 'work_finished')).toBe(true);
    expect(atLeast('work_underway', 'work_finished')).toBe(false);
  });
});

describe('hours', () => {
  it('reads the way the shop says them', () => {
    expect(formatHours(1.5)).toBe('1.5 h');
    expect(formatHours(0.25)).toBe('0.25 h');
    expect(formatHours(2)).toBe('2 h');
    // An estimate covering a whole job is a real figure, not a typo.
    expect(formatHours(40)).toBe('40 h');
  });
});
