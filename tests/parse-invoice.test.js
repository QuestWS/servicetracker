import { describe, expect, it } from 'vitest';
import { parseInvoiceTotals, parseInvoiceItems, describeItems, formatMoney } from '../assets/lib/parse-invoice.js';
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
    expect(formatMoney(-2373.76)).toBe('-$2,373.76');
  });
});

/**
 * A customer's parts order, as BiT prints it. The shape is a real invoice's
 * (one part, superseded number, paid in full by the deposit); the customer
 * is invented, because this repository is public.
 */
const PARTS_ORDER = [
  'Quest Watersports',
  '1851 Old Chicago (N2871st) Road',
  'Ottawa IL 61350',
  '815-433-2200',
  'service@questwatersports.com',
  'questwatersports.com',
  'Sold To:',
  'Pat Example',
  'MP 815-555-0199 pat@example.com',
  'Invoice Salesperson Customer Tax Number Date Charge PO Number',
  '01-9131 SC 3494 10/28/2026 N',
  'SKU Description Qty Retail Price Extended',
  '48000-96J16 TRIM ASSY,POWER 1 2240.74 2240.740 2240.74',
  'Superseded from 48000-96J10',
  'Sale Total 2,240.74',
  'Tax 168.06',
  'Grand Total 2,408.80',
  'Deposits 2,408.80',
  'Amount Due 0.00',
  'How Paid CC 2408.80',
];

describe('parseInvoiceItems', () => {
  it('reads the part lines off a parts order', () => {
    const items = parseInvoiceItems({ lines: PARTS_ORDER });
    expect(items).toEqual([{
      sku: '48000-96J16',
      description: 'TRIM ASSY,POWER',
      quantity: 1,
      price: 2240.74,
      extended: 2240.74,
      // The old number is the one the customer may have asked for.
      note: 'Superseded from 48000-96J10',
    }]);
  });

  it('keeps a number inside a description, and reads several lines and quantities', () => {
    const items = parseInvoiceItems({ lines: [
      'SKU Description Qty Retail Price Extended',
      '18-3250 IMPELLER KIT 3.0L 2 41.99 41.990 83.98',
      '6BH-44352-00 PUMP 12 1 5.00 5.000 5.00',
      'Sale Total 88.98',
    ] });
    expect(items.map((item) => [item.sku, item.description, item.quantity, item.extended])).toEqual([
      ['18-3250', 'IMPELLER KIT 3.0L', 2, 83.98],
      ['6BH-44352-00', 'PUMP 12', 1, 5],
    ]);
    expect(describeItems(items)).toBe('2 x 18-3250 IMPELLER KIT 3.0L\n6BH-44352-00 PUMP 12');
  });

  it('stops at the boilerplate and at totals sharing a row with the legal text', () => {
    const items = parseInvoiceItems({ lines: [
      'SKU Description Qty Retail Price Extended',
      '6BH-44352-00 GASKET 1 9.50 9.500 9.50',
      'I hereby authorize the above repair work to be done.',
      'Standard terms continue along this line. Sale Total 9.50',
    ] });
    expect(items).toHaveLength(1);
    expect(items[0].note).toBe('');
  });

  it('reads nothing off a document with no parts table', () => {
    expect(parseInvoiceItems({ lines: ['Sold To:', 'Pat Example', 'Sale Total 10.00'] })).toEqual([]);
  });

  it('still reads the totals the order is priced from', () => {
    const totals = parseInvoiceTotals({ lines: PARTS_ORDER });
    expect([totals.grandTotal, totals.deposits, totals.amountDue]).toEqual([2408.8, 2408.8, 0]);
  });
});
