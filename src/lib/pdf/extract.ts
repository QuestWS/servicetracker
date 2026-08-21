import fs from 'node:fs';
import path from 'node:path';
import { groupIntoLines, type TextItem } from './lines';

export { groupIntoLines, type TextItem };

export type ExtractedPage = {
  index: number;
  width: number;
  height: number;
  items: TextItem[];
  lines: string[];
};

export type ExtractedPdf = {
  pages: ExtractedPage[];
  /** Every page's lines, in reading order, joined with newlines. */
  text: string;
  lines: string[];
};

/**
 * pdfjs wants its standard-font and cmap data as a directory path. Resolving
 * it through `require.resolve` does not survive the server bundle (the
 * bundler rewrites the call and hands back a module id), so the directory is
 * found by looking, and text extraction still works without it — the only
 * cost is a warning on documents that lean on the standard fonts.
 */
let assetRoot: string | null | undefined;

function pdfjsRoot(): string | null {
  if (assetRoot !== undefined) return assetRoot;
  const candidates = [
    process.env.PDFJS_DIST_DIR,
    path.join(process.cwd(), 'node_modules', 'pdfjs-dist'),
    path.join(process.cwd(), '.next', 'server', 'node_modules', 'pdfjs-dist'),
  ].filter((value): value is string => Boolean(value));
  assetRoot = candidates.find((dir) => fs.existsSync(path.join(dir, 'standard_fonts'))) ?? null;
  return assetRoot;
}

function pdfjsAssetDir(folder: string): string | undefined {
  const root = pdfjsRoot();
  return root ? `${path.join(root, folder)}${path.sep}` : undefined;
}

/** Reads the text layer (with positions) out of a PDF. */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    // pdfjs takes ownership of the buffer, so hand it a copy.
    data: new Uint8Array(bytes),
    standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
    cMapUrl: pdfjsAssetDir('cmaps'),
    cMapPacked: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages: ExtractedPage[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        if (typeof item.str !== 'string' || !item.transform) continue;
        items.push({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width ?? 0,
          height: item.height ?? 0,
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
    // Releases the worker; the document proxy goes with it.
    await task.destroy();
  }

  const lines = pages.flatMap((p) => p.lines);
  return { pages, lines, text: lines.join('\n') };
}
