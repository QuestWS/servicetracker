import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * A stand-in for a BiT work order.
 *
 * We have no BiT installation to generate real PDFs from, so the fixture is
 * built from the layout the shop describes: labelled header block, "Sold To:"
 * customer block, unit block. It exists to prove the pipeline (text layer →
 * fields → stamped PDF) end to end and to give the shop something to practise
 * intake on before a real work order goes through.
 */
export async function makeWorkOrderPdf(overrides = {}) {
  const data = {
    invoice: '01-8886',
    name: 'JOHN SMITH',
    phone: '(815) 555-0142',
    email: 'jsmith@example.com',
    year: '2019',
    make: 'Yamaha',
    model: '242X E-Series',
    engine: 'Yamaha 1.8L HO x2',
    hin: 'YAM12345K819',
    omitEmail: false,
    ...overrides,
  };

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const write = (text, x, y, size = 10, useBold = false) =>
    page.drawText(text, { x, y, size, font: useBold ? bold : font });

  write('QUEST WATERSPORTS', 40, 748, 16, true);
  write('1234 River Road · Ottawa, IL 61350 · (815) 555-0100', 40, 732, 9);
  write('SERVICE WORK ORDER', 40, 706, 13, true);

  write(`Invoice #: ${data.invoice}`, 400, 748, 11, true);
  write('Date: 05/14/2026', 400, 733, 10);
  write('Writer: C. KUJAWA', 400, 719, 10);

  write('Sold To:', 40, 676, 10, true);
  write(data.name, 40, 662);
  write('742 Evergreen Terrace', 40, 648);
  write('Ottawa, IL 61350', 40, 634);
  write(`Phone: ${data.phone}`, 40, 620);
  if (!data.omitEmail) write(`Email: ${data.email}`, 40, 606);

  write('Unit Information', 330, 676, 10, true);
  write(`Year: ${data.year}`, 330, 662);
  write(`Make: ${data.make}`, 330, 648);
  write(`Model: ${data.model}`, 330, 634);
  write(`Engine: ${data.engine}`, 330, 620);
  write(`HIN: ${data.hin}`, 330, 606);

  write('Complaint / Requested Work', 40, 566, 10, true);
  write('Customer reports port engine stalling at idle. Perform 100 hour service,', 40, 550, 10);
  write('inspect impeller, diagnose stalling condition.', 40, 536, 10);

  write('Tech Notes', 40, 500, 10, true);
  for (let i = 0; i < 12; i++) {
    page.drawLine({
      start: { x: 40, y: 480 - i * 22 },
      end: { x: 572, y: 480 - i * 22 },
      thickness: 0.5,
    });
  }
  write('Labor Hours: ____________', 40, 190, 10);
  write('Parts Used: ______________________________________________', 40, 168, 10);
  write('Tech Signature: __________________________', 40, 146, 10);

  return doc.save();
}
