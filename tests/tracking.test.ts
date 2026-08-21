import { describe, expect, it } from 'vitest';
import { looksLikeInvoiceNumber, tokenFromScan } from '@/lib/tracking';
import { atLeast, isForward } from '@/lib/status';

describe('reading a scanned code', () => {
  const token = 'ABCDEFGHJKMNPQRSTVWX';

  it('accepts the tracking URL printed on the work order', () => {
    expect(tokenFromScan(`https://tracker.example.com/t/${token}`)).toBe(token);
    expect(tokenFromScan(`https://tracker.example.com/t/${token}?utm=x`)).toBe(token);
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
