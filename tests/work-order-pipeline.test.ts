import { describe, expect, it } from 'vitest';
import { extractPdf } from '@/lib/pdf/extract';
import { parseWorkOrder } from '@/lib/pdf/parse-work-order';
import { chooseStampBox, stampWorkOrder } from '@/lib/pdf/stamp';
// Shared with `npm run sample-work-order`, so the fixture and the PDF the
// shop practises intake on are the same document.
import { makeWorkOrderPdf } from '../scripts/lib/sample-work-order.mjs';

describe('reading a BiT work order', () => {
  it('pulls the invoice number, customer and unit off the text layer', async () => {
    const pdf = await makeWorkOrderPdf();
    const extracted = await extractPdf(pdf);
    const parsed = parseWorkOrder(extracted);

    expect(parsed.invoiceNumber).toBe('01-8886');
    expect(parsed.customerName).toBe('JOHN SMITH');
    expect(parsed.customerPhone).toBe('(815) 555-0142');
    expect(parsed.customerEmail).toBe('jsmith@example.com');
    expect(parsed.boatInfo).toContain('2019');
    expect(parsed.boatInfo).toContain('Yamaha');
    expect(parsed.boatInfo).toContain('242X');
    expect(parsed.missing).toEqual([]);
  });

  it('reports a missing email rather than inventing one', async () => {
    const pdf = await makeWorkOrderPdf({ omitEmail: true });
    const parsed = parseWorkOrder(await extractPdf(pdf));

    expect(parsed.customerEmail).toBeNull();
    expect(parsed.missing).toContain('customerEmail');
    // Everything else still came through.
    expect(parsed.invoiceNumber).toBe('01-8886');
    expect(parsed.customerName).toBe('JOHN SMITH');
  });

  it('normalises a phone number written any of the usual ways', async () => {
    for (const phone of ['815-555-0142', '815.555.0142', '1 815 555 0142']) {
      const parsed = parseWorkOrder(await extractPdf(await makeWorkOrderPdf({ phone })));
      expect(parsed.customerPhone).toBe('(815) 555-0142');
    }
  });

  it('finds nothing in a PDF with no text layer, and says so', () => {
    const parsed = parseWorkOrder({ lines: [], text: '' });
    expect(parsed.missing).toEqual([
      'invoiceNumber',
      'customerName',
      'customerPhone',
      'customerEmail',
      'boatInfo',
    ]);
  });
});

describe('stamping the QR code', () => {
  it('adds the code without disturbing the original document', async () => {
    const original = await makeWorkOrderPdf();
    const before = await extractPdf(original);

    const stamped = await stampWorkOrder({
      pdfBytes: original,
      trackingUrl: 'https://tracker.example.com/t/ABCDEFGHJKMNPQRSTVWX',
      invoiceNumber: '01-8886',
      firstPage: before.pages[0],
    });
    const after = await extractPdf(stamped);

    expect(after.pages).toHaveLength(before.pages.length);
    // Every line of the original survives; the stamp only adds to it.
    for (const line of before.lines) {
      expect(after.lines).toContain(line);
    }
    expect(after.text).toContain('SCAN TO LOG WORK');
    expect(after.text).toContain('01-8886');
  });

  it('keeps the stamp out of the busiest corner', () => {
    const page = { width: 612, height: 792 };
    // Text crowding the top right pushes the stamp elsewhere.
    const crowded = Array.from({ length: 20 }, (_, i) => ({
      x: 500,
      y: 700 + i,
      width: 80,
      height: 10,
    }));
    const box = chooseStampBox({ ...page, items: crowded });
    const topRight = chooseStampBox(page);
    expect(box.x === topRight.x && box.y === topRight.y).toBe(false);
  });

  it('defaults to the top right when the page is empty', () => {
    const box = chooseStampBox({ width: 612, height: 792, items: [] });
    expect(box.x).toBeGreaterThan(612 / 2);
    expect(box.y).toBeGreaterThan(792 / 2);
  });
});
