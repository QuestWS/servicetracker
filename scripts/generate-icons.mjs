/**
 * Builds the PWA icon set from public/quest-mark.png.
 *
 * The mark ships at 180x180, which is too small for Android's install
 * criteria, so it is decoded, scaled and re-encoded here rather than pulling
 * in an image library for four files. Only what the Quest mark actually is —
 * 8-bit non-interlaced RGB/RGBA — is supported; anything else fails loudly.
 *
 * Run: npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { decode, encode } from './lib/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public', 'quest-mark.png');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

const NAVY = [0x14, 0x29, 0x3e];

/** Box-filter downscale / bilinear upscale, good enough for an app icon. */
function resize(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = image.width / size;
  const scaleY = image.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; a += image.data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, data: out };
}

/** Centres the mark on a flat field, leaving the maskable safe area clear. */
function onField(image, size, inset, field) {
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = field[0];
    canvas[i * 4 + 1] = field[1];
    canvas[i * 4 + 2] = field[2];
    canvas[i * 4 + 3] = 255;
  }
  const inner = Math.round(size * (1 - inset * 2));
  const scaled = resize(image, inner);
  const offset = Math.round((size - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4;
      const alpha = scaled.data[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((y + offset) * size + (x + offset)) * 4;
      for (let c = 0; c < 3; c++) {
        canvas[d + c] = Math.round(scaled.data[s + c] * alpha + canvas[d + c] * (1 - alpha));
      }
      canvas[d + 3] = 255;
    }
  }
  return { width: size, height: size, data: canvas };
}

const source = decode(fs.readFileSync(SOURCE));
fs.mkdirSync(OUT_DIR, { recursive: true });

const WHITE = [0xff, 0xff, 0xff];

// A thin navy frame on the plain icons reads as a badge at home-screen size;
// the maskable one is cropped by the launcher, so it keeps the mark on its
// native white with a wide safe area instead.
const outputs = [
  ['icon-192.png', onField(source, 192, 0.06, NAVY)],
  ['icon-512.png', onField(source, 512, 0.06, NAVY)],
  ['icon-maskable-512.png', onField(source, 512, 0.2, WHITE)],
  ['apple-touch-icon.png', onField(source, 180, 0.06, NAVY)],
];
for (const [name, image] of outputs) {
  fs.writeFileSync(path.join(OUT_DIR, name), encode(image));
  console.log(`wrote public/icons/${name} (${image.width}x${image.height})`);
}
