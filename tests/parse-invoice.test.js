import { describe, expect, it } from 'vitest';
import { parseInvoiceTotals, formatMoney } from '../assets/lib/parse-invoice.js';
import { groupIntoLines } from '../assets/lib/lines.js';
import { makeInvoicePdf } from '../scripts/lib/sample-work-order.mjs';

async function readPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  let lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    lines = lines.concat(groupIntoLines(content.items
      .filter((item) => typeof item.str === 'string' && item.transform)
      .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width || 0, height: item.height || 0 }))));
  }
  await task.destroy();
  return { lines, text: lines.join('\n') };
}

describe('reading the totals off a finished invoice', () => {
  it('finds the balance behind the legal text sharing its rows', async () => {
    const totals = parseInvoiceTotals(await readPdf(await makeInvoicePdf()));
    expect(totals.grandTotal).toBe(16917.79);
    expect(totals.deposits).toBe(15285.32);
    expect(totals.amountDue).toBe(1632.47);
  });

  it('is the deposit case that matters — the balance is not the total', async () => {
    const totals = parseInvoiceTotals(await readPdf(await makeInvoicePdf()));
    expect(totals.amountDue).toBeLessThan(totals.grandTotal);
    expect(Math.round((totals.grandTotal - totals.deposits) * 100) / 100).toBe(totals.amountDue);
  });

  it('handles an invoice with nothing paid against it yet', async () => {
    const totals = parseInvoiceTotals(await readPdf(
      await makeInvoicePdf({ deposits: 0, amountDue: 16917.79 }),
    ));
    expect(totals.deposits).toBe(0);
    expect(totals.amountDue).toBe(16917.79);
  });

  it('reports nothing rather than a figure it does not believe', () => {
    // A balance larger than the total means we matched the wrong number, and
    // a wrong figure next to a Pay button is worse than no figure.
    const bad = parseInvoiceTotals({ lines: ['Grand Total 100.00', 'Amount Due 900.00'] });
    expect(bad.amountDue).toBeNull();
    expect(bad.found).not.toContain('amountDue');

    expect(parseInvoiceTotals({ lines: ['nothing here'] }).amountDue).toBeNull();
    expect(parseInvoiceTotals({ lines: [] }).found).toEqual([]);
  });

  it('formats money the way an invoice says it', () => {
    expect(formatMoney(1632.47)).toBe('$1,632.47');
    expect(formatMoney(16917.79)).toBe('$16,917.79');
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(null)).toBeNull();
  });
});
