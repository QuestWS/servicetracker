import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import type { ExtractedPage } from './extract';

const QR_SIZE = 92;
const PADDING = 6;
const CAPTION_HEIGHT = 22;
const MARGIN = 14;

export type StampBox = { x: number; y: number; width: number; height: number };

/**
 * Picks where the QR goes. The work order must stay visually identical, so we
 * look for the emptiest of four corners on page one rather than dropping the
 * code on top of BiT's header. Ties break towards the top right, which is
 * where the shop expects to reach for it.
 */
export function chooseStampBox(page: {
  width: number;
  height: number;
  items?: { x: number; y: number; width: number; height: number }[];
}): StampBox {
  const boxWidth = QR_SIZE + PADDING * 2;
  const boxHeight = QR_SIZE + CAPTION_HEIGHT + PADDING * 2;
  const candidates: StampBox[] = [
    { x: page.width - boxWidth - MARGIN, y: page.height - boxHeight - MARGIN, width: boxWidth, height: boxHeight },
    { x: MARGIN, y: page.height - boxHeight - MARGIN, width: boxWidth, height: boxHeight },
    { x: page.width - boxWidth - MARGIN, y: MARGIN, width: boxWidth, height: boxHeight },
    { x: MARGIN, y: MARGIN, width: boxWidth, height: boxHeight },
  ];

  const items = page.items ?? [];
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
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
 * Returns the original PDF with a QR code (and a one-line caption) added to
 * page one. Nothing else about the document is touched.
 */
export async function stampWorkOrder(input: {
  pdfBytes: Uint8Array;
  trackingUrl: string;
  invoiceNumber: string;
  firstPage?: ExtractedPage;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input.pdfBytes);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();

  const qrPng = await QRCode.toBuffer(input.trackingUrl, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    scale: 8,
    color: { dark: '#14293EFF', light: '#FFFFFFFF' },
  });
  const qrImage = await doc.embedPng(qrPng);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const box = chooseStampBox({
    width,
    height,
    items: input.firstPage?.items,
  });

  const navy = rgb(0x14 / 255, 0x29 / 255, 0x3e / 255);

  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: rgb(1, 1, 1),
    borderColor: navy,
    borderWidth: 1,
  });
  page.drawImage(qrImage, {
    x: box.x + PADDING,
    y: box.y + CAPTION_HEIGHT + PADDING - 4,
    width: QR_SIZE,
    height: QR_SIZE,
  });

  const caption = 'SCAN TO LOG WORK';
  const captionSize = 7.5;
  const captionWidth = bold.widthOfTextAtSize(caption, captionSize);
  page.drawText(caption, {
    x: box.x + (box.width - captionWidth) / 2,
    y: box.y + PADDING + 8,
    size: captionSize,
    font: bold,
    color: navy,
  });

  const numberSize = 8;
  const numberWidth = font.widthOfTextAtSize(input.invoiceNumber, numberSize);
  page.drawText(input.invoiceNumber, {
    x: box.x + (box.width - numberWidth) / 2,
    y: box.y + PADDING - 1,
    size: numberSize,
    font,
    color: navy,
  });

  return doc.save();
}

/** Standalone QR PNG — used for the one-time "install the app" setup code. */
export function qrPng(value: string, scale = 8): Promise<Buffer> {
  return QRCode.toBuffer(value, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    scale,
    color: { dark: '#14293EFF', light: '#FFFFFFFF' },
  });
}
