import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  DETAIL_MENU, WINTER_CARD, rate, suggestPrice, keyForWinterLabel, dimsFromText, isWide, menuItem,
} from '../assets/lib/detail-menu.js';

describe('the detail menu', () => {
  it('carries every line on the 2025 detail sheet', () => {
    const labels = DETAIL_MENU.map((m) => m.label.toLowerCase());
    ['power wash', 'premium detail — exterior', 'upper deck only', 'hull-sides only', 'premium detail — interior',
      'fly-bridge', 'wash & wax', 'exterior wash only', 'interior wipe-down', 'trailer', 'acid wash',
      'initial bottom paint', 're-application', 'paint & supplies', 'own trailer', 'our trailer',
      'wet sanding', 'bilge', 'stain', 'isinglass', 'carpet', 'cabin', 'degreasing', 'other']
      .forEach((w) => expect(labels.some((l) => l.includes(w)), w).toBe(true));
    expect(new Set(DETAIL_MENU.map((m) => m.key)).size).toBe(DETAIL_MENU.length);
  });

  it('prices per foot by beam, wide over 8\'6"', () => {
    expect(isWide(8.5)).toBe(false);
    expect(isWide(8.6)).toBe(true);
    expect(suggestPrice('premiumExt', { loa: 20, beam: 8 }).amount).toBe(900);
    expect(suggestPrice('premiumExt', { loa: 30, beam: 10 }).amount).toBe(2700);
    expect(suggestPrice('extWash', { loa: 20, beam: 8 }).amount).toBe(100);
    expect(suggestPrice('extWash', { loa: 20, beam: 9 }).amount).toBe(120);
    expect(suggestPrice('trailer', { loa: 20 }).amount).toBe(40);
    expect(suggestPrice('relaunchOwn', {}).amount).toBe(100);
  });

  it('asks for what it needs rather than guessing', () => {
    expect(suggestPrice('washWax', {}).amount).toBeNull();
    // Same price either beam: the beam is not needed.
    expect(suggestPrice('washWax', { loa: 20 }).amount).toBe(320);
    expect(suggestPrice('acidWash', { loa: 20 }).why).toMatch(/beam/);
    expect(suggestPrice('premiumInt', { loa: 20 }).why).toMatch(/400/);
  });

  it('quotes, never gives away, a line the sheet has at 0 on a narrow beam', () => {
    expect(rate('upperDeck', 8).kind).toBe('quote');
    expect(suggestPrice('upperDeck', { loa: 30, beam: 10 }).amount).toBe(1350);
  });

  it('never prices below the winter card where both sheets price a line', () => {
    Object.keys(WINTER_CARD).forEach((key) => {
      const card = WINTER_CARD[key];
      if (card.flat !== undefined) expect(rate(key).rate).toBeGreaterThanOrEqual(card.flat);
      else {
        expect(rate(key, 8).rate).toBeGreaterThanOrEqual(card.narrow);
        expect(rate(key, 10).rate).toBeGreaterThanOrEqual(card.wide);
      }
    });
  });

  it('agrees with the winter card it was copied from, when that repo is beside this one', () => {
    const p = '../winter-quotes_26-27/pricing-engine.js';
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    const num = (k) => Number((src.match(new RegExp(`\\b${k}:\\s*([\\d.]+)`)) || [])[1]);
    expect(WINTER_CARD.powerwash.narrow).toBe(num('powerwashFt'));
    expect(WINTER_CARD.acidWash.narrow).toBe(num('acidNarrowFt'));
    expect(WINTER_CARD.acidWash.wide).toBe(num('acidWideFt'));
    expect(WINTER_CARD.skiDetail.flat).toBe(num('skiDetail'));
  });

  it('maps the winter system\'s detail words onto menu lines', () => {
    expect(keyForWinterLabel('Exterior detail')).toBe('premiumExt');
    expect(keyForWinterLabel('Wash & wax')).toBe('washWax');
    expect(keyForWinterLabel('Interior wipe-down')).toBe('intWipe');
    expect(keyForWinterLabel("Powerwash hull (22')")).toBe('powerwash');
    expect(keyForWinterLabel('Acid wash hull')).toBe('acidWash');
    expect(keyForWinterLabel('Jetski detail × 2')).toBe('skiDetail');
    expect(keyForWinterLabel('Shrinkwrap')).toBe('');
    expect(menuItem('nope')).toBeNull();
  });

  it('reads dimensions the way they are written', () => {
    expect(dimsFromText("22' x 8'6\"")).toEqual({ loa: 22, beam: 8.5 });
    expect(dimsFromText('Length: 24 ft').loa).toBe(24);
    expect(dimsFromText('').loa).toBe(0);
  });
});
