import { PDFDocument, StandardFonts, rgb } from '../vendor/pdf-lib.esm.min.js';
import QRCode from '../vendor/qrcode.min.mjs';

/**
 * QR generation and work-order stamping.
 *
 * This runs in the service writer's browser, not on a server. Apps Script
 * cannot open a PDF, and doing it here keeps the whole PDF pipeline off any
 * backend quota — the browser hands the backend a finished document.
 */

const QR_SIZE = 92;
const PADDING = 6;
const CAPTION_HEIGHT = 22;
const MARGIN = 14;
const NAVY = rgb(0x14 / 255, 0x29 / 255, 0x3e / 255);

/**
 * Picks where the QR goes. The work order must stay visually identical, so we
 * look for the emptiest of four corners on page one rather than dropping the
 * code on top of BiT's header. Ties break towards the top right, which is
 * where the shop expects to reach for it.
 */
export function chooseStampBox(page) {
  const boxWidth = QR_SIZE + PADDING * 2;
  const boxHeight = QR_SIZE + CAPTION_HEIGHT + PADDING * 2;
  const candidates = [
    { x: page.width - boxWidth - MARGIN, y: page.height - boxHeight - MARGIN, width: boxWidth, height: boxHeight },
    { x: MARGIN, y: page.height - boxHeight - MARGIN, width: boxWidth, height: boxHeight },
    { x: page.width - boxWidth - MARGIN, y: MARGIN, width: boxWidth, height: boxHeight },
    { x: MARGIN, y: MARGIN, width: boxWidth, height: boxHeight },
  ];

  const items = page.items || [];
  let best = candidates[0];
  let bestScore = Infinity;
  for (const box of candidates) {
    let score = 0;
    for (const item of items) {
      const itemHeight = item.height || 8;
      const overlaps =
        item.x < box.x + box.width &&
        item.x + (item.width || 1) > box.x &&
        item.y < box.y + box.height &&
        item.y + itemHeight > box.y;
      if (overlaps) score += 1;
    }
    if (score < bestScore) {
      bestScore = score;
      best = box;
    }
    if (score === 0) break;
  }
  return best;
}

/**
 * The QR as a module matrix: `size` modules square, `isDark(x, y)`.
 * No canvas and no PNG encoder, so the same code runs in the browser and in
 * the test suite.
 */
export function qrMatrix(value) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  return { size, isDark: (x, y) => data[y * size + x] === 1 };
}

/**
 * Draws the QR onto a pdf-lib page as vector rectangles rather than a bitmap.
 * A printed code is read by a phone camera off paper, and vector modules stay
 * crisp at any printer resolution where a scaled PNG would soften.
 *
 * Runs of adjacent dark modules in a row are merged into one rectangle, which
 * takes a 33x33 code from a thousand objects to a couple of hundred.
 */
export function drawQr(page, options) {
  const { size, isDark } = qrMatrix(options.value);
  const quiet = 2;
  const scale = options.size / (size + quiet * 2);

  for (let row = 0; row < size; row++) {
    let run = 0;
    for (let col = 0; col <= size; col++) {
      const dark = col < size && isDark(col, row);
      if (dark) {
        run += 1;
        continue;
      }
      if (run > 0) {
        page.drawRectangle({
          x: options.x + (quiet + col - run) * scale,
          // PDF y grows upward; the matrix's first row is the top of the code.
          y: options.y + options.size - (quiet + row + 1) * scale,
          width: run * scale,
          height: scale,
          color: options.color || NAVY,
        });
        run = 0;
      }
    }
  }
}

/**
 * Returns the original PDF with a QR code (and a one-line caption) added to
 * page one. Nothing else about the document is touched.
 */
export async function stampWorkOrder(input) {
  const doc = await PDFDocument.load(input.pdfBytes);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const box = chooseStampBox({ width, height, items: input.firstPage && input.firstPage.items });

  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: rgb(1, 1, 1),
    borderColor: NAVY,
    borderWidth: 1,
  });
  drawQr(page, {
    value: input.trackingUrl,
    x: box.x + PADDING,
    y: box.y + CAPTION_HEIGHT + PADDING - 4,
    size: QR_SIZE,
  });

  const caption = 'SCAN TO LOG WORK';
  const captionSize = 7.5;
  page.drawText(caption, {
    x: box.x + (box.width - bold.widthOfTextAtSize(caption, captionSize)) / 2,
    y: box.y + PADDING + 8,
    size: captionSize,
    font: bold,
    color: NAVY,
  });

  const numberSize = 8;
  page.drawText(input.invoiceNumber, {
    x: box.x + (box.width - font.widthOfTextAtSize(input.invoiceNumber, numberSize)) / 2,
    y: box.y + PADDING - 1,
    size: numberSize,
    font,
    color: NAVY,
  });

  return doc.save();
}

/**
 * The same matrix as an SVG, for showing a code on screen — the one-time
 * install code on the setup page. Scales to any size and prints cleanly.
 */
export function qrSvg(value, pixels = 220) {
  const { size, isDark } = qrMatrix(value);
  const quiet = 2;
  const span = size + quiet * 2;
  let rects = '';
  for (let row = 0; row < size; row++) {
    let run = 0;
    for (let col = 0; col <= size; col++) {
      const dark = col < size && isDark(col, row);
      if (dark) { run += 1; continue; }
      if (run > 0) {
        rects += `<rect x="${quiet + col - run}" y="${quiet + row}" width="${run}" height="1"/>`;
        run = 0;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${span}" height="${span}" fill="#fff"/><g fill="#14293E">${rects}</g></svg>`;
}
