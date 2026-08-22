import { PDFDocument, StandardFonts } from '../../assets/vendor/pdf-lib.esm.min.js';

/**
 * A practice work order laid out the way BiT actually lays one out.
 *
 * The geometry here is measured from a real BiT invoice: the shop's own
 * details across the top, "Sold To:" and "Invoice #" side by side at y=616,
 * the customer block down the left at x=31, the unit headings down the right
 * at x=218, and — the part that matters — the unit fields printed as bare
 * headings with NO colons ("Year Make Model", "Serial # Reg #").
 *
 * Two things follow from that and are worth not "fixing":
 *  - The shop's own phone and email are on every form, above the customer's.
 *    A parser that falls back to "first phone on the page" gets the shop's.
 *  - With no unit filled in, the right answer is to report the unit missing,
 *    not to read a heading row as a value.
 *
 * Pass `unit` to get a document with the unit filled in. WHERE BiT puts those
 * values is a guess — the real sample we have was left blank — so treat that
 * variant as provisional until a filled work order turns up.
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
    unit: null,
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

  // BiT prints the field NAMES into empty unit slots. A filled unit shows the
  // values in their place — which is the guessed half of this fixture.
  write(data.unit ? `${data.unit.year} ${data.unit.make} ${data.unit.model}` : 'Year Make Model', 218, 593);
  write(data.unit ? `${data.unit.serial}` : 'Serial # Reg #', 218, 582);
  write(data.unit ? `${data.unit.engine}` : 'Eng Make Eng Model Eng Serial #', 218, 571);
  write('Trailer Make Trailer', 218, 559);
  write('Trailer Serial #', 218, 548);

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
