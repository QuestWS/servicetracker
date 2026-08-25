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

  it('reads the unit out of the column beside the customer', async () => {
    const parsed = await parse();
    expect(parsed.boatInfo).toContain('2003 Four Winns');
    expect(parsed.boatInfo).toContain('GFNMJ001E102');
    expect(parsed.boatInfo).toContain('MERCRUISER 496');
    expect(parsed.missing).toEqual([]);
  });

  it('copes with a customer who has only some of it filled out', async () => {
    // Rows with nothing in them are simply absent — the real invoice this is
    // measured from belongs to a customer with no trailer.
    const parsed = await parse({ unit: { year: '2018', make: 'Yamaha AR195' } });
    expect(parsed.boatInfo).toBe('2018 Yamaha AR195');
    expect(parsed.missing).toEqual([]);
  });

  it('reports an empty unit rather than guessing at one', async () => {
    const parsed = await parse({ unit: null });
    expect(parsed.boatInfo).toBeNull();
    expect(parsed.missing).toEqual(['boatInfo']);
  });

  it('refuses to read field descriptions as a unit', async () => {
    // One form came through with the descriptions typed into the fields
    // themselves. "Make Trailer" on a customer's page is worse than a blank.
    const parsed = await parse({ unitPlaceholders: true, unit: null });
    expect(parsed.boatInfo).toBeNull();
    expect(parsed.missing).toEqual(['boatInfo']);
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

  /**
   * Job 01-8891, straight off the shop counter, with the customer's name and
   * number changed — this repo is public. Every coordinate is the real one,
   * measured from the PDF, because the geometry is the whole difficulty:
   * the shop's own phone and email sit ABOVE the customer's block, and the
   * form's column headings sit inside the unit's column.
   */
  const realWorkOrder = () => [
    // The shop's own letterhead. A fallback that reaches up here emails the
    // shop instead of the customer.
    { str: 'Quest Watersports', x: 31, y: 755, width: 77 },
    { str: '1851 Old Chicago (N2871st) Road', x: 31, y: 744, width: 136 },
    { str: 'Ottawa IL 61350', x: 31, y: 732, width: 67 },
    { str: '815-433-2200', x: 31, y: 721, width: 57 },
    { str: 'service@questwatersports.com', x: 31, y: 710, width: 129 },
    { str: 'questwatersports.com', x: 31, y: 698, width: 92 },
    // Two columns, both headings on one row.
    { str: 'Sold To:', x: 31, y: 616, width: 32 },
    { str: 'Invoice # 01-8891', x: 218, y: 616, width: 72 },
    { str: 'Dale Rivers', x: 31, y: 593, width: 67 },
    { str: '1995 Glastron 15ft', x: 218, y: 593, width: 76 },
    { str: 'MP 815-555-0142', x: 31, y: 554, width: 73 },
    // The form's own column headings, in the unit's column and inside the
    // window the unit is read from.
    { str: 'Invoice', x: 56, y: 538, width: 29 },
    { str: 'Salesperson', x: 117, y: 538, width: 49 },
    { str: 'Customer', x: 193, y: 538, width: 40 },
    { str: 'Tax Number', x: 273, y: 538, width: 50 },
    { str: 'Date', x: 359, y: 538, width: 19 },
    { str: 'Charge', x: 411, y: 538, width: 29 },
    { str: 'PO Number', x: 501, y: 538, width: 47 },
    { str: '01-8891', x: 54, y: 524, width: 33 },
    { str: 'SC', x: 137, y: 524, width: 10 },
    { str: '3435', x: 202, y: 524, width: 20 },
    { str: '08/25/2026', x: 344, y: 524, width: 48 },
  ];

  const parseReal = () => {
    const items = realWorkOrder();
    const lines = groupIntoLines(items);
    return parseWorkOrder({ lines, text: lines.join('\n'), pages: [{ items }] });
  };

  it('reads a real counter work order', () => {
    const parsed = parseReal();
    expect(parsed.invoiceNumber).toBe('01-8891');
    expect(parsed.customerName).toBe('Dale Rivers');
    expect(parsed.customerPhone).toBe('(815) 555-0142');
  });

  it("never mistakes the shop's own details for the customer's", () => {
    // The shop's phone and email are printed above every customer's block.
    // Reading either is how a customer's invoice gets emailed to the shop.
    const parsed = parseReal();
    expect(parsed.customerPhone).not.toBe('(815) 433-2200');
    expect(parsed.customerEmail).not.toBe('service@questwatersports.com');
  });

  it("keeps the form's own column headings out of the unit", () => {
    // This job went onto the board as "1995 Glastron 15ft · Tax Number Date
    // Charge PO Number" — the unit read correctly, with the heading row
    // underneath it stapled on.
    expect(parseReal().boatInfo).toBe('1995 Glastron 15ft');
  });

  it('carries the work the customer asked for', () => {
    // The band between the invoice detail row and the legal boilerplate.
    // This is what a mechanic needs to see when they open the job.
    const items = realWorkOrder().concat([
      { str: '01-8891', x: 54, y: 524, width: 33 },
      { str: '08/25/2026', x: 344, y: 524, width: 48 },
      { str: 'Need another part (see attached bag). Look over shift cable.', x: 31, y: 497, width: 382 },
      { str: 'I hereby authorize the above repair work to be done.', x: 31, y: 470, width: 400 },
      { str: 'Sale Total 0.00', x: 460, y: 470, width: 60 },
    ]);
    const lines = groupIntoLines(items);
    const parsed = parseWorkOrder({ lines, text: lines.join('\n'), pages: [{ items }] });
    expect(parsed.workRequested).toBe('Need another part (see attached bag). Look over shift cable.');
  });

  it('keeps the legal boilerplate and the totals out of it', () => {
    const items = realWorkOrder().concat([
      { str: '01-8891', x: 54, y: 524, width: 33 },
      { str: '08/25/2026', x: 344, y: 524, width: 48 },
      { str: 'Look over shift cable.', x: 31, y: 497, width: 120 },
      { str: 'I hereby authorize the above repair work to be done.', x: 31, y: 470, width: 400 },
      { str: 'Grand Total 1,632.47', x: 460, y: 455, width: 70 },
    ]);
    const lines = groupIntoLines(items);
    const parsed = parseWorkOrder({ lines, text: lines.join('\n'), pages: [{ items }] });
    expect(parsed.workRequested).toBe('Look over shift cable.');
    expect(parsed.workRequested).not.toMatch(/authorize|Total|1,632/);
  });

  it('ignores the filler rows a form prints between fields', () => {
    const items = realWorkOrder().concat([
      { str: '01-8891', x: 54, y: 524, width: 33 },
      { str: '08/25/2026', x: 344, y: 524, width: 48 },
      { str: 'Look over shift cable.', x: 31, y: 497, width: 120 },
      { str: '.', x: 31, y: 486, width: 3 },
      { str: '_________________', x: 31, y: 475, width: 90 },
      { str: 'I hereby authorize the above repair work to be done.', x: 31, y: 460, width: 400 },
    ]);
    const lines = groupIntoLines(items);
    const parsed = parseWorkOrder({ lines, text: lines.join('\n'), pages: [{ items }] });
    expect(parsed.workRequested).toBe('Look over shift cable.');
  });

  it('says nothing rather than guessing when the band is empty', () => {
    const items = realWorkOrder().concat([
      { str: '01-8891', x: 54, y: 524, width: 33 },
      { str: '08/25/2026', x: 344, y: 524, width: 48 },
      { str: 'I hereby authorize the above repair work to be done.', x: 31, y: 470, width: 400 },
    ]);
    const lines = groupIntoLines(items);
    expect(parseWorkOrder({ lines, text: lines.join('\n'), pages: [{ items }] }).workRequested).toBeNull();
  });

  it('reports a missing email rather than inventing one', () => {
    // This customer has no email on file, and BiT prints nothing at all for
    // a field that is empty.
    const parsed = parseReal();
    expect(parsed.customerEmail).toBeNull();
    expect(parsed.missing).toEqual(['customerEmail']);
  });

  it('finds nothing in a PDF with no text layer, and says so', () => {
    expect(parseWorkOrder({ lines: [], text: '' }).missing).toEqual([
      'invoiceNumber', 'customerName', 'customerPhone', 'customerEmail', 'boatInfo',
    ]);
  });
});
