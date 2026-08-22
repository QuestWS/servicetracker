import { groupIntoLines } from './lines.js';

/**
 * Reads the text layer out of a work order, in the browser.
 *
 * The service writer's own machine does this: Apps Script cannot open a PDF,
 * and doing it here means intake costs the backend nothing but a write.
 */
let pdfjs = null;

/**
 * Resolved against this module's own URL rather than the page's, so it works
 * the same whichever page pulls it in and cannot be handed a wrong prefix.
 * Loaded on demand: it is a megabyte that only intake ever needs.
 */
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

/**
 * @param {Uint8Array} bytes the PDF
 * @returns {Promise<{pages: Array, lines: string[], text: string}>}
 */
export async function extractPdf(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    // pdfjs takes ownership of the buffer, so hand it a copy.
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const raw of content.items) {
        if (typeof raw.str !== 'string' || !raw.transform) continue;
        items.push({
          str: raw.str,
          x: raw.transform[4],
          y: raw.transform[5],
          width: raw.width || 0,
          height: raw.height || 0,
        });
      }
      pages.push({
        index: n,
        width: viewport.width,
        height: viewport.height,
        items,
        lines: groupIntoLines(items),
      });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  const lines = pages.flatMap((p) => p.lines);
  return { pages, lines, text: lines.join('\n') };
}
