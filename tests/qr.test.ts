import { describe, expect, it } from 'vitest';
import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { qrPng } from '@/lib/pdf/stamp';
// The icon build's PNG reader, reused so the test decodes exactly the bytes a
// phone camera would be pointed at.
import { decode } from '../scripts/lib/png.mjs';

function readQr(png: Buffer): string {
  const image = decode(png);
  const luminances = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < luminances.length; i++) {
    const o = i * 4;
    luminances[i] = (image.data[o] * 299 + image.data[o + 1] * 587 + image.data[o + 2] * 114) / 1000;
  }
  const source = new RGBLuminanceSource(luminances, image.width, image.height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  return new MultiFormatReader().decode(bitmap).getText();
}

describe('the QR code stamped on the work order', () => {
  it('reads back as the exact tracking URL', async () => {
    const url = 'https://tracker.example.com/t/HP7CJNM76WHQDB01FDHW';
    expect(readQr(await qrPng(url))).toBe(url);
  });

  it('survives being printed small', async () => {
    // scale 4 is roughly the size the stamp lands on a letter page.
    const url = 'https://tracker.example.com/t/ABCDEFGHJKMNPQRSTVWX';
    expect(readQr(await qrPng(url, 4))).toBe(url);
  });
});
