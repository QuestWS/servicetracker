import { describe, expect, it } from 'vitest';
import { parseWorkOrder } from '../assets/lib/parse-work-order.js';
import { groupIntoLines } from '../assets/lib/lines.js';
import { makeWorkOrderPdf } from '../scripts/lib/sample-work-order.mjs';

/**
 * Feeds a PDF through pdfjs the way the admin page does.
 *
 * This uses the pdfjs-dist package rather than the vendored browser build:
 * the browser copy needs DOMMatrix and a canvas that node has not got. Same
 * library, same version, and the code under test here is the parser, not
 * pdfjs — the vendored file is exercised for real by tools/browser-check.mjs.
 */
async function readPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === 'string' && item.transform)
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || 0,
      }));
    pages.push({ index: n, width: viewport.width, height: viewport.height, items, lines: groupIntoLines(items) });
  }
  await task.destroy();
  const lines = pages.flatMap((p) => p.lines);
  return { pages, lines, text: lines.join('\n') };
}

const parse = async (overrides) => parseWorkOrder(await readPdf(await makeWorkOrderPdf(overrides)));

/**
 * The fixture is measured from a real BiT invoice, so these are the shapes
 * that actually turn up: two columns with both headings on one row, the
 * shop's own contact details across the top of every form, and unit fields
 * printed as bare headings with no colons.
 */
describe('reading a BiT work order', () => {
  it('pulls the invoice number and customer off the real layout', async () => {
    const parsed = await parse();
    expect(parsed.invoiceNumber).toBe('01-8886');
    expect(parsed.customerName).toBe('JOHN SMITH');
    expect(parsed.customerPhone).toBe('(815) 555-0142');
    expect(parsed.customerEmail).toBe('jsmith@example.com');
  });

  it('does not let the column beside the customer bleed into the name', async () => {
    // "Sold To:" and "Invoice #" sit on the same row; the unit headings run
    // down the right. Flattened into lines they read as one run-on sentence.
    const parsed = await parse();
    expect(parsed.customerName).not.toMatch(/year|make|model/i);
  });

  it('never mistakes the shop for the customer', async () => {
    // BiT prints Quest's own address, phone and email above the customer's on
    // every form. Getting this wrong emails the shop instead of the customer.
    const parsed = await parse({ omitEmail: true });
    expect(parsed.customerEmail).toBeNull();
    expect(parsed.missing).toContain('customerEmail');
    expect(parsed.customerPhone).toBe('(815) 555-0142');
    expect(parsed.customerPhone).not.toBe('(815) 433-2200');
  });

  it('reports a blank unit rather than reading the headings as one', async () => {
    // The unit fields print as "Year Make Model" when empty. "Make Trailer"
    // on a customer's page is worse than an honest blank.
    const parsed = await parse();
    expect(parsed.boatInfo).toBeNull();
    expect(parsed.missing).toEqual(['boatInfo']);
  });

  it('reads a unit that has actually been filled in', async () => {
    const parsed = await parse({
      unit: { year: '2019', make: 'Yamaha', model: '242X E-Series', serial: 'YAM12345K819', engine: 'Yamaha 1.8L HO' },
    });
    expect(parsed.boatInfo).toContain('2019 Yamaha 242X E-Series');
    expect(parsed.boatInfo).toContain('YAM12345K819');
    expect(parsed.missing).toEqual([]);
  });

  it('normalises a phone number written any of the usual ways', async () => {
    for (const phone of ['815-555-0142', '815.555.0142', '1 815 555 0142']) {
      expect((await parse({ phone })).customerPhone).toBe('(815) 555-0142');
    }
  });

  it('still reads a form that does use labels with colons', () => {
    const lines = ['Invoice #: 01-4000', 'Sold To:', 'ADA LOVELACE', 'Phone: 815-555-0199',
                   'Email: ada@example.com', 'Year: 2021', 'Make: Yamaha', 'Model: AR195'];
    const parsed = parseWorkOrder({ lines, text: lines.join('\n') });
    expect(parsed.invoiceNumber).toBe('01-4000');
    expect(parsed.customerName).toBe('ADA LOVELACE');
    expect(parsed.boatInfo).toBe('2021 Yamaha AR195');
  });

  it('finds nothing in a PDF with no text layer, and says so', () => {
    expect(parseWorkOrder({ lines: [], text: '' }).missing).toEqual([
      'invoiceNumber', 'customerName', 'customerPhone', 'customerEmail', 'boatInfo',
    ]);
  });
});
