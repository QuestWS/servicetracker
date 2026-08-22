import { describe, expect, it } from 'vitest';
import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { chooseStampBox, qrMatrix } from '../assets/lib/stamp.js';

/**
 * Renders the QR module matrix to a luminance grid and reads it back with a
 * real decoder. The stamp draws these same modules as vector rectangles, so
 * if this decodes, what lands on the paper is a readable code.
 */
function decode(value, moduleSize = 4) {
  const { size, isDark } = qrMatrix(value);
  const quiet = 4;
  const width = (size + quiet * 2) * moduleSize;
  const luminances = new Uint8ClampedArray(width * width).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isDark(x, y)) continue;
      for (let dy = 0; dy < moduleSize; dy++) {
        for (let dx = 0; dx < moduleSize; dx++) {
          const px = (quiet + x) * moduleSize + dx;
          const py = (quiet + y) * moduleSize + dy;
          luminances[py * width + px] = 0;
        }
      }
    }
  }
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminances, width, width)));
  return new MultiFormatReader().decode(bitmap).getText();
}

describe('the QR code stamped on the work order', () => {
  it('reads back as the exact tracking URL', () => {
    const url = 'https://questws.github.io/servicetracker/t/?j=HP7CJNM76WHQDB01FDHW';
    expect(decode(url)).toBe(url);
  });

  it('survives being printed small', () => {
    const url = 'https://questws.github.io/servicetracker/t/?j=ABCDEFGHJKMNPQRSTVWX';
    expect(decode(url, 2)).toBe(url);
  });
});

describe('where the stamp lands', () => {
  it('keeps out of the busiest corner', () => {
    const page = { width: 612, height: 792 };
    const crowded = Array.from({ length: 20 }, (_, i) => ({ x: 500, y: 700 + i, width: 80, height: 10 }));
    const box = chooseStampBox({ ...page, items: crowded });
    const topRight = chooseStampBox({ ...page, items: [] });
    expect(box.x === topRight.x && box.y === topRight.y).toBe(false);
  });

  it('defaults to the top right when the page is empty', () => {
    const box = chooseStampBox({ width: 612, height: 792, items: [] });
    expect(box.x).toBeGreaterThan(612 / 2);
    expect(box.y).toBeGreaterThan(792 / 2);
  });
});
