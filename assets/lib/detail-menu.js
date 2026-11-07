/**
 * THE DETAIL MENU — what the Detail Tracker offers and what it costs.
 *
 * Off the shop's own "Cleaning & Detailing Services" sheet (2025 detail menu),
 * one row per line on that sheet. Imports nothing: it runs in the browser
 * (the Detail Tracker, the writer's intake) and under node (the tests).
 *
 * How a line prices:
 *   perFt  — dollars per foot of length overall (platform and pulpit
 *            included), one figure for a beam up to 8'6" and one for wider.
 *   flat   — dollars each, whatever the size.
 *   quote  — no price on the sheet ("by quote only", "quoted starting at
 *            $400", "on site quote"): the detailer types one in.
 * A 0 on the sheet in the narrow-beam column (upper deck only, hull-sides
 * only) means it is not offered on a narrow boat; it prices as a quote there
 * rather than as free.
 *
 * NEVER BELOW THE WINTER CARD. Chris, Nov 2026: "If any of the prices on that
 * sheet are lower than the current winterize sheet offering, go with the
 * higher number." WINTER_CARD below is the 2026–2027 winter rate card's figure
 * for every line both sheets price (pricing-engine.js in
 * QuestWS/winter-quotes_26-27), and rate() always answers the higher of the
 * two. Today they agree; the rule is there for the day either one moves.
 * Update WINTER_CARD at the winter rollover.
 *
 * All figures are estimates and "starting" prices, and the sheet says so; the
 * quote a customer is sent carries that sentence (DETAIL_FINE_PRINT).
 */

/** Beam over this many feet takes the wide-beam price. 8'6". */
export const WIDE_BEAM_FT = 8.5;

/** The winter rate card's figures for the lines both sheets price. */
export const WINTER_CARD = {
  powerwash: { narrow: 5.66, wide: 5.66 },   // PRICES.powerwashFt
  acidWash:  { narrow: 17,   wide: 22 },     // PRICES.acidNarrowFt / acidWideFt
  skiDetail: { flat: 175 },                  // PRICES.skiDetail
};

export const DETAIL_GROUPS = [
  'Premium detail',
  'Basic wash',
  'Bottom cleaning & painting',
  'A la carte — by quote',
  'Jetskis',
];

export const DETAIL_MENU = [
  // Premium detail (1,2)
  { key: 'powerwash',   group: 'Premium detail', label: 'Power wash (bottom)',               perFt: { narrow: 5.66, wide: 5.66 } },
  { key: 'premiumExt',  group: 'Premium detail', label: 'Premium detail — exterior',          perFt: { narrow: 45, wide: 90 },
    about: 'Basic wash, buff & wax exterior fiberglass, scrub deck, non-skid and swim platforms, clean exterior glass.' },
  { key: 'upperDeck',   group: 'Premium detail', label: 'Upper deck only (above rub-rail)',   perFt: { narrow: 0, wide: 45 } },
  { key: 'hullSides',   group: 'Premium detail', label: 'Hull-sides only (below rub-rail)',   perFt: { narrow: 0, wide: 45 } },
  { key: 'premiumInt',  group: 'Premium detail', label: 'Premium detail — interior',          quote: true, from: 400,
    about: 'Clean cockpit compartments, vacuum carpets, scrub non-carpeted flooring, dress vinyl with UV protector, open & clean canvas and interior glass. Quoted starting at $400.' },
  { key: 'flybridge',   group: 'Premium detail', label: 'Add fly-bridge',                     flat: 150 },

  // Basic wash (2)
  { key: 'washWax',     group: 'Basic wash', label: 'Wash & wax',                             perFt: { narrow: 16, wide: 16 },
    about: 'Basic wash of exterior surfaces, windshield and portals, with one coat of wax.' },
  { key: 'extWash',     group: 'Basic wash', label: 'Exterior wash only',                     perFt: { narrow: 5, wide: 6 } },
  { key: 'intWipe',     group: 'Basic wash', label: 'Interior wipe-down (cockpit & seating)', quote: true,
    about: 'Wipe down all seats and carpet areas, vacuum carpet, hose down non-carpeted areas. Quoted on site.' },
  { key: 'trailer',     group: 'Basic wash', label: 'Trailer (light grime removed, tires dressed)', perFt: { narrow: 2, wide: 2 } },

  // Bottom cleaning & painting
  { key: 'acidWash',    group: 'Bottom cleaning & painting', label: 'Acid wash (off trailer)', perFt: { narrow: 17, wide: 22 } },
  { key: 'bottomPaint', group: 'Bottom cleaning & painting', label: 'Initial bottom paint (off trailer)', perFt: { narrow: 40, wide: 52 },
    about: 'Plus paint & supplies.' },
  { key: 'bottomReapply', group: 'Bottom cleaning & painting', label: 'Bottom paint re-application (off trailer)', perFt: { narrow: 25, wide: 32 },
    about: 'Plus paint & supplies.' },
  { key: 'paintSupplies', group: 'Bottom cleaning & painting', label: 'Paint & supplies (estimate)', quote: true },
  { key: 'relaunchOwn', group: 'Bottom cleaning & painting', label: 'Pull & relaunch — own trailer', flat: 100 },
  { key: 'relaunchOurs', group: 'Bottom cleaning & painting', label: 'Pull & relaunch — our trailer', perFt: { narrow: 11, wide: 11 } },

  // A la carte estimates: by quote only
  { key: 'wetSand',     group: 'A la carte — by quote', label: 'Deep buffing & wet sanding', quote: true },
  { key: 'bilge',       group: 'A la carte — by quote', label: 'Bilge degreasing & cleaning', quote: true },
  { key: 'stain',       group: 'A la carte — by quote', label: 'Spot or stain removal',       quote: true },
  { key: 'isinglass',   group: 'A la carte — by quote', label: 'Polish isinglass',            quote: true },
  { key: 'carpet',      group: 'A la carte — by quote', label: 'Carpet cleaning',             quote: true },
  { key: 'cabin',       group: 'A la carte — by quote', label: 'Cabin cleaning',              quote: true },
  { key: 'degrease',    group: 'A la carte — by quote', label: 'Degreasing (wheels, etc.)',   quote: true },
  { key: 'other',       group: 'A la carte — by quote', label: 'Other',                       quote: true },

  // Not on the 2025 sheet, but on the winter card and done by the detailers.
  { key: 'skiDetail',   group: 'Jetskis', label: 'Jetski detail (per ski)', flat: 175 },
];

export const DETAIL_FINE_PRINT =
  'All figures are estimates and represent "starting" prices. Premium detail pricing assumes surfaces are in ' +
  'well-maintained condition; buffing alone is unlikely to correct oxidized or chalky fiberglass. Neither detailing ' +
  'nor washing addresses UV damage, scratches, discoloration or staining — correcting these is estimated separately ' +
  'and done on a best-efforts basis. Total does not include tax, and may not include certain material costs. Units ' +
  'not removed within 10 days of completion are subject to short-term storage fees of $25 per day.';

const BY_KEY = DETAIL_MENU.reduce((out, m) => { out[m.key] = m; return out; }, {});

export function menuItem(key) { return BY_KEY[String(key || '')] || null; }

/** True when a beam (decimal feet) takes the wide price. Unknown is not wide. */
export function isWide(beamFt) {
  const b = Number(beamFt);
  return isFinite(b) && b > WIDE_BEAM_FT;
}

/**
 * What one line costs per unit of measure, never below the winter card.
 * { kind: 'perFt'|'flat'|'quote', rate, needsBeam }.
 */
export function rate(key, beamFt) {
  const m = menuItem(key);
  if (!m || m.quote) return { kind: 'quote', rate: null, needsBeam: false };
  const card = WINTER_CARD[m.key] || {};
  if (m.flat !== undefined) {
    return { kind: 'flat', rate: Math.max(m.flat, card.flat || 0), needsBeam: false };
  }
  const beamKnown = beamFt !== '' && beamFt !== null && beamFt !== undefined && isFinite(Number(beamFt)) && Number(beamFt) > 0;
  const differs = m.perFt.narrow !== m.perFt.wide;
  const side = isWide(beamFt) ? 'wide' : 'narrow';
  const r = Math.max(m.perFt[side], card[side] || 0);
  // Not offered on this beam: it is quoted, not free.
  if (!r) return { kind: 'quote', rate: null, needsBeam: false };
  return { kind: 'perFt', rate: r, needsBeam: differs && !beamKnown };
}

function cents(n) { return Math.round(n * 100) / 100; }

/**
 * A suggested price for one line: { amount, how } or { amount: null, why }.
 * The detailer can always overwrite it — this is the sheet's figure, not a
 * rule. LOA and beam are decimal feet.
 */
export function suggestPrice(key, { loa, beam, qty } = {}) {
  const r = rate(key, beam);
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  if (r.kind === 'quote') {
    const m = menuItem(key);
    return { amount: null, why: m && m.from ? `Quoted, starting at $${m.from}` : 'Priced by quote' };
  }
  if (r.kind === 'flat') {
    return { amount: cents(r.rate * n), how: n > 1 ? `${n} × $${r.rate.toFixed(2)}` : `$${r.rate.toFixed(2)}` };
  }
  const L = Number(loa);
  if (!isFinite(L) || L <= 0) return { amount: null, why: 'Needs the length overall' };
  if (r.needsBeam) return { amount: null, why: 'Needs the beam (price differs over 8\'6")' };
  const amt = cents(r.rate * L * n);
  return { amount: amt, how: `${L} ft × $${r.rate.toFixed(2)}/ft${n > 1 ? ` × ${n}` : ''}` };
}

/**
 * The winter system's words for its detail and wash lines, to menu keys, so a
 * unit pulled from winter work lands on the same lines the menu offers.
 * Matched on the start of the label: "Powerwash hull (22')" is a power wash.
 */
const WINTER_WORDS = [
  [/^exterior detail/i, 'premiumExt'],
  [/^wash\s*&\s*wax/i, 'washWax'],
  [/^interior detail/i, 'premiumInt'],
  [/^interior wipe-?\s*down/i, 'intWipe'],
  [/^power\s*wash/i, 'powerwash'],
  [/^acid wash/i, 'acidWash'],
  [/^jetski detail/i, 'skiDetail'],
  // Chris, Nov 7 2026: "Bottom paint is detailing."
  [/^bottom paint touch-?\s*up/i, 'bottomReapply'],
  [/^strip bottom paint/i, 'bottomPaint'],
];

export function keyForWinterLabel(label) {
  const words = String(label || '').trim();
  const hit = WINTER_WORDS.filter(([re]) => re.test(words))[0];
  return hit ? hit[1] : '';
}

/** Feet and inches → decimal feet, for the two-box inputs. */
export function ftIn(ft, inch) {
  const v = (Number(ft) || 0) + (Number(inch) || 0) / 12;
  return v ? Math.round(v * 1000) / 1000 : 0;
}

/**
 * Pull a length and beam out of the free text a work order or the winter
 * system carries: "22' x 8'6\"", "Length: 24 ft", "22'6\" x 102\"".
 */
export function dimsFromText(text) {
  const s = String(text || '');
  const one = (t) => {
    const m = String(t).match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|''))?/i);
    if (m) return ftIn(m[1], m[2] || 0);
    const inches = String(t).match(/(\d+(?:\.\d+)?)\s*(?:"|in\b)/i);
    return inches ? Math.round((Number(inches[1]) / 12) * 1000) / 1000 : 0;
  };
  const pair = s.split(/\s+x\s+|\s*×\s*/i);
  if (pair.length >= 2) return { loa: one(pair[0]), beam: one(pair[1]) };
  const len = s.match(/length[^0-9]*([^,;\n]+)/i);
  return { loa: len ? one(len[1]) : one(s), beam: 0 };
}
