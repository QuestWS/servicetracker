import { groupIntoLines } from './lines.js';

/**
 * Field extraction from a BiT work order's text layer.
 *
 * BiT has no API and no template control, so the printed PDF *is* the
 * interface. Every rule here is a guess about someone else's layout: the
 * parser is deliberately permissive and reports what it could not find
 * instead of failing, and the service writer confirms the result before a
 * job is created.
 */

/**
 * @typedef {object} ParsedWorkOrder
 * @property {?string} invoiceNumber
 * @property {?string} customerName
 * @property {?string} customerPhone
 * @property {?string} customerEmail
 * @property {?string} boatInfo
 * @property {Array} missing  field names that came back empty and need a human
 */

const INVOICE_PATTERNS = [
  /\b(?:invoice|inv|work\s*order|w\.?o\.?|repair\s*order|r\.?o\.?|ticket|service\s*order)\s*(?:#|no\.?|number)?\s*[:#]?\s*([0-9]{1,4}-[0-9]{2,8})\b/i,
  /\b(?:invoice|inv|work\s*order|w\.?o\.?|repair\s*order|r\.?o\.?|ticket)\s*(?:#|no\.?|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,15})\b/i,
];

const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const CUSTOMER_BLOCK_LABELS = ['sold to', 'bill to', 'customer', 'billed to', 'sold to:'];
const UNIT_BLOCK_LABELS = ['unit', 'unit information', 'vehicle', 'boat', 'equipment', 'trailer'];

/**
 * A line made only of heading words, e.g. "Year Make Model" or "Serial # Reg #".
 *
 * The right-hand column of a real work order carries more than the unit: the
 * form's own column headings sit in it too. One live job came through with
 * the boat recorded as "1995 Glastron 15ft · Tax Number Date Charge PO
 * Number" — the unit read correctly, with a heading row stapled to it. Every
 * word here is a BiT heading, and the test is whole-line, so a real value
 * like "1995 Glastron 15ft" is never caught by it.
 */
const LABEL_WORDS_ONLY =
  /^(?:year|make|model|serial|reg|hin|vin|eng|engine|motor|trailer|length|hours|stock|color|colour|tax|date|charge|po|p\.o\.?|terms|salesperson|writer|tech|technician|dept|department|qty|quantity|amount|total|price|invoice|order|account|acct|ref|page|phone|type|code|status|#|no\.?|number|[:#\s])+$/i;

const UNIT_FIELDS = [
  'year',
  'make',
  'model',
  'serial',
  'serial #',
  'serial no',
  'hin',
  'vin',
  'engine',
  'motor',
  'length',
  'hours',
  'stock',
  'color',
];

function cleanLabel(line) {
  return line.replace(/[:#]+\s*$/, '').trim().toLowerCase();
}

/**
 * Pulls `Label: value` off a single line, when the value is on that line.
 *
 * A colon separates; a bare `#` does not. Real BiT prints "Serial # Reg #" as
 * a row of empty headings, and reading that as serial="Reg #" is worse than
 * reading nothing at all — a wrong unit on a job is a wrong unit on the
 * customer's page.
 */
function inlineValue(line, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`\\b${escaped}\\s*(#\\s*)?:\\s*(.+)$`, 'i'));
  if (!match) return null;
  const value = match[2].trim();
  if (!value) return null;
  // "Year: Make: Model:" is a heading row, not a year.
  return LABEL_WORDS_ONLY.test(value) ? null : value;
}

function findInvoiceNumber(text) {
  for (const pattern of INVOICE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  // Last resort: BiT numbers look like 01-8886. Accept a bare one only when
  // exactly one candidate exists, so we never pick a phone or a date.
  const candidates = [...text.matchAll(/\b\d{2}-\d{4}\b/g)].map((m) => m[0]);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function looksLikeStreet(line) {
  return (
    /^\d+\s+\S/.test(line) ||
    /\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|hwy|highway|way|pkwy|circle|cir|box)\b\.?$/i.test(
      line.trim(),
    ) ||
    /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(line.trim())
  );
}

function looksLikeName(line) {
  const trimmed = line.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (EMAIL_RE.test(trimmed) || PHONE_RE.test(trimmed)) return false;
  if (looksLikeStreet(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;
  return /[A-Za-z]{2}/.test(trimmed);
}

/**
 * Returns the lines belonging to a labelled block: either the tail of the
 * label line itself, or the lines below it until the next label-looking line.
 */
function blockAfter(lines, labels, maxLines = 6) {
  for (let i = 0; i < lines.length; i++) {
    const label = cleanLabel(lines[i]);
    const matched = labels.find((l) => label === l || label.startsWith(`${l} `) || label === `${l}:`);
    if (!matched && !labels.some((l) => new RegExp(`^${l}\\s*[:#]`, 'i').test(lines[i]))) continue;

    const out = [];
    const rest = lines[i].replace(new RegExp(`^.*?${labels.find((l) => lines[i].toLowerCase().includes(l)) ?? ''}\\s*[:#]?\\s*`, 'i'), '').trim();
    if (rest) out.push(rest);
    for (let j = i + 1; j < lines.length && out.length < maxLines; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      // A new labelled section ends the block.
      if (/^[A-Za-z][A-Za-z .#/'-]{1,24}\s*[:#]\s*$/.test(next)) break;
      out.push(next);
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * A BiT work order is laid out in columns: "Sold To:" on the left and unit
 * details on the right, at the same height. Merged into flat lines they read
 * as one run-on sentence, so a labelled block is read from the positioned
 * items instead — everything under the label, in the label's own column.
 */
function labelledColumnBlock(items, labels, options = {}) {
  const { columnWidth = 235, depth = 120, maxLines = 6 } = options;

  const label = items.find((item) => {
    const text = item.str.trim().toLowerCase();
    return labels.some((l) => text === l || text === `${l}:` || text.startsWith(`${l}:`));
  });
  if (!label) return [];

  const left = label.x - 6;
  // Where the next column starts. A two-column form puts both headings on the
  // same row — a real BiT invoice has "Sold To:" and "Invoice # 01-8893" side
  // by side — so the neighbour on the label's own line is the boundary. Guess
  // a width only when the label stands alone on its row.
  const neighbour = items
    .filter((item) => item !== label && Math.abs(item.y - label.y) <= 2.5 && item.x > label.x + 40)
    .reduce((nearest, item) => (nearest === null || item.x < nearest ? item.x : nearest), null);
  const right = neighbour === null ? label.x + columnWidth : neighbour - 6;

  const inline = label.str.split(/[:#]/).slice(1).join(':').trim();

  const below = items.filter(
    (item) =>
      item !== label &&
      item.x >= left &&
      item.x <= right &&
      item.y < label.y - 1 &&
      item.y >= label.y - depth,
  );

  const lines = groupIntoLines(below).slice(0, maxLines);
  return inline ? [inline, ...lines] : lines;
}

function firstMatch(lines, re) {
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[0].trim();
  }
  return null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return raw.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function findBoatInfo(lines) {
  const found = new Map();

  for (const line of lines) {
    for (const field of UNIT_FIELDS) {
      if (found.has(field)) continue;
      const value = inlineValue(line, field);
      if (value) {
        // Stop a run-on line ("Year: 2019 Make: Yamaha") bleeding into the
        // next field's value.
        const cut = value.search(
          new RegExp(`\\b(?:${UNIT_FIELDS.join('|')})\\s*[:#]`, 'i'),
        );
        found.set(field, (cut > 0 ? value.slice(0, cut) : value).trim());
      }
    }
  }

  const year = found.get('year');
  const make = found.get('make');
  const model = found.get('model');
  const headline = [year, make, model].filter(Boolean).join(' ').trim();

  const extras = [];
  const engine = found.get('engine') ?? found.get('motor');
  if (engine) extras.push(`Engine: ${engine}`);
  const hull = found.get('hin') ?? found.get('serial') ?? found.get('serial #') ?? found.get('vin');
  if (hull) extras.push(`HIN/Serial: ${hull}`);
  const length = found.get('length');
  if (length) extras.push(`Length: ${length}`);

  if (headline) return [headline, ...extras].join(' · ');

  // Nothing found is a flag for the service writer, never a guess. A heading
  // row read as a value would put "Make Trailer" on a customer's page.
  return extras.length ? extras.join(' · ') : null;
}

/**
 * The unit, read out of the right-hand column of a real BiT form.
 *
 * BiT stacks the unit fields opposite the customer block, and prints the field
 * NAMES into the empty slots — a unit with nothing filled in reads "Year Make
 * Model / Serial # Reg # / Eng Make Eng Model". So the rule is: take that
 * column, throw away every line that is only heading words, and keep whatever
 * is left. A blank unit leaves nothing and gets flagged; a filled one leaves
 * the actual values.
 *
 * Inferred from a form whose unit was blank. If a filled work order ever
 * parses oddly, this function is the first place to look.
 */
function findUnitColumn(items) {
  const anchor = items.find((item) => /^invoice\s*#/i.test(item.str.trim()));
  if (!anchor) return null;

  const column = items.filter(
    (item) =>
      item !== anchor &&
      item.x >= anchor.x - 6 &&
      item.y < anchor.y - 1 &&
      item.y >= anchor.y - 90,
  );
  const values = groupIntoLines(column)
    .map((line) => line.trim())
    .filter((line) => line && !LABEL_WORDS_ONLY.test(line) && !PHONE_RE.test(line) && !EMAIL_RE.test(line));
  return values.length ? values.join(' · ').slice(0, 200) : null;
}

/**
 * What the customer actually asked for, off the body of the work order.
 *
 * On a BiT form this sits in a band of its own: below the invoice detail row
 * (`01-8891  SC  3435  08/25/2026  N`) and above the legal boilerplate that
 * starts "I hereby authorize". Both edges are stable printed furniture, which
 * is what makes the band findable without knowing what is written in it.
 *
 * The totals column shares rows with the legal text on the last page, so the
 * end anchor is deliberately the FIRST line of the boilerplate — everything
 * below it is either legalese or money, and neither is a work instruction.
 */
const LEGAL_ANCHOR = /hereby\s+authorize/i;
const DETAIL_HEADINGS = /\bsalesperson\b/i;

export function findWorkRequested(lines, invoiceNumber) {
  const legal = lines.findIndex((line) => LEGAL_ANCHOR.test(line));
  if (legal <= 0) return null;

  let start = -1;
  for (let i = legal - 1; i >= 0; i--) {
    const line = lines[i];
    // The values row: repeats the invoice number alongside the job's date.
    if (invoiceNumber && line.includes(invoiceNumber) && DATE_RE.test(line)) {
      start = i + 1;
      break;
    }
    // Fall back to the headings row, whose values row is the line under it.
    if (DETAIL_HEADINGS.test(line)) {
      start = i + 2;
      break;
    }
  }
  if (start === -1 || start >= legal) return null;

  const body = lines
    .slice(start, legal)
    .map((line) => line.trim())
    // Forms carry filler rows — a lone dot, a rule, a row of underscores.
    // A work instruction has letters or digits in it.
    .filter((line) => line && !LABEL_WORDS_ONLY.test(line) && /[A-Za-z0-9]/.test(line));
  if (!body.length) return null;
  return body.join(' ').replace(/\s+/g, ' ').slice(0, 1000);
}

/**
 * `input.pages[0].items` is page one's positioned text runs, when available.
 * They are what make a two-column layout readable.
 *
 * @param {object} input  {lines, text, pages}
 * @returns {ParsedWorkOrder}
 */
export function parseWorkOrder(input) {
  const lines = input.lines.map((l) => l.trim()).filter(Boolean);
  const text = input.text;
  const items = input.pages?.[0]?.items ?? [];

  const invoiceNumber = findInvoiceNumber(text);

  // Prefer the column-aware read; fall back to flat lines for a PDF whose
  // layout we could not position (or a caller that only has text).
  const columnBlock = labelledColumnBlock(items, CUSTOMER_BLOCK_LABELS);
  const customerBlock = columnBlock.length ? columnBlock : blockAfter(lines, CUSTOMER_BLOCK_LABELS);
  const customerName =
    customerBlock.find(looksLikeName) ??
    (() => {
      const inline = lines.map((l) => inlineValue(l, 'customer name')).find(Boolean);
      return inline && looksLikeName(inline) ? inline : null;
    })() ??
    null;

  // BiT prints the SHOP's own address, phone and email across the top of every
  // form. Falling back to the first phone or email on the page would put the
  // shop's own details on the job — and then email the shop instead of the
  // customer. Anything above the "Sold To:" heading is off limits.
  const anchor = lines.findIndex((line) =>
    CUSTOMER_BLOCK_LABELS.some((l) => cleanLabel(line) === l || line.toLowerCase().startsWith(`${l}:`)),
  );
  const belowAnchor = anchor === -1 ? lines : lines.slice(anchor + 1);

  const customerPhone = normalizePhone(
    firstMatch(customerBlock, PHONE_RE) ??
      firstMatch(
        belowAnchor.filter((l) => /phone|cell|mobile|tel\b|\bmp\b/i.test(l)),
        PHONE_RE,
      ) ??
      firstMatch(belowAnchor, PHONE_RE),
  );

  const customerEmail =
    firstMatch(customerBlock, EMAIL_RE) ??
    firstMatch(
      belowAnchor.filter((l) => /e-?mail/i.test(l)),
      EMAIL_RE,
    ) ??
    firstMatch(belowAnchor, EMAIL_RE);

  // Labelled fields first (our own fixtures and any BiT form that uses
  // colons), then the positional read of the real layout's right-hand column.
  const boatInfo = findBoatInfo(lines) ?? findUnitColumn(items);

  const missing = [];
  if (!invoiceNumber) missing.push('invoiceNumber');
  if (!customerName) missing.push('customerName');
  if (!customerPhone) missing.push('customerPhone');
  if (!customerEmail) missing.push('customerEmail');
  if (!boatInfo) missing.push('boatInfo');

  return {
    invoiceNumber,
    customerName: customerName?.trim() ?? null,
    customerPhone,
    customerEmail: customerEmail?.toLowerCase() ?? null,
    boatInfo,
    // Not in `missing`: plenty of jobs are written up at the counter with
    // nothing typed in this band, and the writer can fill it in by hand.
    workRequested: findWorkRequested(lines, invoiceNumber),
    missing,
  };
}

/** Human labels for the fields the service writer may have to fill in. */
export const FIELD_LABELS = {
  invoiceNumber: 'Invoice #',
  customerName: 'Customer name',
  customerPhone: 'Phone',
  customerEmail: 'Email',
  boatInfo: 'Boat / engine',
};
