import { PDFDocument, StandardFonts } from '../../assets/vendor/pdf-lib.esm.min.js';

/**
 * A practice work order laid out the way BiT actually lays one out.
 *
 * The geometry is measured from two real BiT documents: the shop's own details
 * across the top, "Sold To:" and "Invoice #" side by side at y=616, the
 * customer block down the left at x=31, and the unit down the right at x=218.
 *
 * Two things learned from the real ones and worth not "fixing":
 *  - **Empty fields simply do not print.** A customer with no trailer has no
 *    trailer rows at all; there is no placeholder text. So a blank unit means
 *    an empty column, and the honest answer is to flag it for the writer.
 *  - **The shop's own phone and email are on every form**, above the
 *    customer's. A parser that falls back to "first phone on the page" gets
 *    the shop's, and then emails the shop instead of the customer.
 *
 * `unitPlaceholders` reproduces a form where somebody typed the field
 * descriptions into the fields themselves ("Serial # Reg #") to show what goes
 * where. That is not BiT's doing, but it happened once and the parser has to
 * refuse to read it as a unit.
 */
export async function makeWorkOrderPdf(overrides = {}) {
  const data = {
    invoice: '01-8886',
    name: 'JOHN SMITH',
    street: '742 Evergreen Terrace',
    city: 'Ottawa IL 61350',
    phone: '815-555-0142',
    email: 'jsmith@example.com',
    description: 'Customer reports port engine stalling at idle. 100 hour service.',
    // The common case: a unit with something in it. Pass `unit: null` for a
    // customer who has none of it filled out.
    unit: { year: '2003', make: 'Four Winns', serial: 'GFNMJ001E102 IL4215LA', engine: 'MERCRUISER 496 m061588' },
    unitPlaceholders: false,
    omitEmail: false,
    ...overrides,
  };

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const write = (text, x, y, size = 9, useBold = false) =>
    page.drawText(text, { x, y, size, font: useBold ? bold : font });

  // The shop's own letterhead — present on every BiT form.
  write('Quest Watersports', 31, 755, 11, true);
  write('1851 Old Chicago (N2871st) Road', 31, 744);
  write('Ottawa IL 61350', 31, 732);
  write('815-433-2200', 31, 721);
  write('service@questwatersports.com', 31, 710);
  write('questwatersports.com', 31, 698);

  // Two columns, both headings on the same row.
  write('Sold To:', 31, 616);
  write(`Invoice # ${data.invoice}`, 218, 616);

  write(data.name, 31, 593);
  write(data.street, 31, 582);
  write(data.city, 31, 571);

  if (data.unitPlaceholders) {
    // Somebody typed the field descriptions into the fields.
    write('Year Make Model', 218, 593);
    write('Serial # Reg #', 218, 582);
    write('Eng Make Eng Model Eng Serial #', 218, 571);
    write('Trailer Make Trailer', 218, 559);
    write('Trailer Serial #', 218, 548);
  } else if (data.unit) {
    // A real unit. Rows the customer has nothing for are simply absent —
    // this one has no trailer, like the real invoice it is measured from.
    const model = [data.unit.year, data.unit.make, data.unit.model].filter(Boolean).join(' ');
    if (model) write(model, 218, 593);
    if (data.unit.serial) write(data.unit.serial, 218, 582);
    if (data.unit.engine) write(data.unit.engine, 218, 571);
  }

  write(`MP ${data.phone}`, 31, 537);
  if (!data.omitEmail) write(data.email, 116, 537);

  const headings = [['Invoice', 56], ['Salesperson', 117], ['Customer', 193],
                    ['Tax Number', 273], ['Date', 359], ['Charge', 411], ['PO Number', 501]];
  headings.forEach(([label, x]) => write(label, x, 521));
  write(data.invoice, 54, 507);
  write('SC', 137, 507);
  write('3436', 202, 507);
  write('08/22/2026', 344, 507);
  write('N', 422, 507);

  write(data.description, 31, 480);
  write('.', 31, 469);
  write('.', 31, 457);

  write('I hereby authorize the above repair work to be done along with necessary materials.', 31, 134, 7);
  write('Sale Total', 428, 134);
  write('0.00', 578, 134);
  write('Amount Due', 428, 76);
  write('0.00', 575, 76);

  return doc.save();
}

/**
 * A finished invoice: the same head, a table of line items, and the totals
 * block down the right of the LAST page. Measured from a real one that carried
 * a deposit — Grand Total 16,917.79, Deposits 15,285.32, Amount Due 1,632.47 —
 * which is the case the customer most needs telling about.
 */
export async function makeInvoicePdf(overrides = {}) {
  const data = {
    invoice: '01-7153',
    saleTotal: 15765.06,
    shopSupplies: 200.0,
    tax: 952.73,
    grandTotal: 16917.79,
    deposits: 15285.32,
    amountDue: 1632.47,
    ...overrides,
  };

  const bytes = await makeWorkOrderPdf({ invoice: data.invoice, ...(overrides.workOrder || {}) });
  const { PDFDocument: Doc, StandardFonts: Fonts } = await import('../../assets/vendor/pdf-lib.esm.min.js');
  const doc = await Doc.load(bytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(Fonts.Helvetica);
  const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label, value, y) => {
    // The legal text runs down the left on these same rows, which is why the
    // flattened line reads "...upon completion of Amount Due 1,632.47".
    page.drawText('Standard terms and conditions text continues along this line.', { x: 31, y, size: 7, font });
    page.drawText(label, { x: 428, y, size: 9, font });
    page.drawText(money(value), { x: 560, y, size: 9, font });
  };

  row('Sale Total', data.saleTotal, 134);
  row('Shop Supplies, Freight', data.shopSupplies, 122);
  row('Tax', data.tax, 111);
  row('Grand Total', data.grandTotal, 100);
  row('Deposits', data.deposits, 88);
  row('Amount Due', data.amountDue, 76);
  return doc.save();
}
