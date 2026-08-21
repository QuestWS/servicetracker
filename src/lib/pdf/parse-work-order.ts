import { groupIntoLines, type TextItem } from './lines';

/**
 * Field extraction from a BiT work order's text layer.
 *
 * BiT has no API and no template control, so the printed PDF *is* the
 * interface. Every rule here is a guess about someone else's layout: the
 * parser is deliberately permissive and reports what it could not find
 * instead of failing, and the service writer confirms the result before a
 * job is created.
 */

export type ParsedWorkOrder = {
  invoiceNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  boatInfo: string | null;
  /** Field names that came back empty and need a human. */
  missing: string[];
};

const INVOICE_PATTERNS = [
  /\b(?:invoice|inv|work\s*order|w\.?o\.?|repair\s*order|r\.?o\.?|ticket|service\s*order)\s*(?:#|no\.?|number)?\s*[:#]?\s*([0-9]{1,4}-[0-9]{2,8})\b/i,
  /\b(?:invoice|inv|work\s*order|w\.?o\.?|repair\s*order|r\.?o\.?|ticket)\s*(?:#|no\.?|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,15})\b/i,
];

const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const CUSTOMER_BLOCK_LABELS = ['sold to', 'bill to', 'customer', 'billed to', 'sold to:'];
const UNIT_BLOCK_LABELS = ['unit', 'unit information', 'vehicle', 'boat', 'equipment', 'trailer'];

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

function cleanLabel(line: string): string {
  return line.replace(/[:#]+\s*$/, '').trim().toLowerCase();
}

/** Pulls `Label: value` off a single line, when the value is on that line. */
function inlineValue(line: string, label: string): string | null {
  const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:#]\\s*(.+)$`, 'i');
  const match = line.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value || null;
}

function findInvoiceNumber(text: string): string | null {
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

function looksLikeStreet(line: string): boolean {
  return (
    /^\d+\s+\S/.test(line) ||
    /\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|hwy|highway|way|pkwy|circle|cir|box)\b\.?$/i.test(
      line.trim(),
    ) ||
    /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(line.trim())
  );
}

function looksLikeName(line: string): boolean {
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
function blockAfter(lines: string[], labels: string[], maxLines = 6): string[] {
  for (let i = 0; i < lines.length; i++) {
    const label = cleanLabel(lines[i]);
    const matched = labels.find((l) => label === l || label.startsWith(`${l} `) || label === `${l}:`);
    if (!matched && !labels.some((l) => new RegExp(`^${l}\\s*[:#]`, 'i').test(lines[i]))) continue;

    const out: string[] = [];
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
function labelledColumnBlock(
  items: TextItem[],
  labels: string[],
  options: { columnWidth?: number; depth?: number; maxLines?: number } = {},
): string[] {
  const { columnWidth = 235, depth = 120, maxLines = 6 } = options;

  const label = items.find((item) => {
    const text = item.str.trim().toLowerCase();
    return labels.some((l) => text === l || text === `${l}:` || text.startsWith(`${l}:`));
  });
  if (!label) return [];

  const left = label.x - 6;
  const right = label.x + columnWidth;
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

function firstMatch(lines: string[], re: RegExp): string | null {
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[0].trim();
  }
  return null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return raw.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function findBoatInfo(lines: string[]): string | null {
  const found = new Map<string, string>();

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

  const extras: string[] = [];
  const engine = found.get('engine') ?? found.get('motor');
  if (engine) extras.push(`Engine: ${engine}`);
  const hull = found.get('hin') ?? found.get('serial') ?? found.get('serial #') ?? found.get('vin');
  if (hull) extras.push(`HIN/Serial: ${hull}`);
  const length = found.get('length');
  if (length) extras.push(`Length: ${length}`);

  if (headline) return [headline, ...extras].join(' · ');

  // No Year/Make/Model labels: fall back to whatever sits under a unit block.
  const block = blockAfter(lines, UNIT_BLOCK_LABELS, 3).filter(
    (l) => !/^\s*$/.test(l) && !PHONE_RE.test(l) && !EMAIL_RE.test(l),
  );
  if (block.length) return block.join(' · ').slice(0, 200);
  return extras.length ? extras.join(' · ') : null;
}

export function parseWorkOrder(input: {
  lines: string[];
  text: string;
  /** Page one's positioned items, when available — they make columns readable. */
  pages?: { items: TextItem[] }[];
}): ParsedWorkOrder {
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

  const customerPhone = normalizePhone(
    firstMatch(customerBlock, PHONE_RE) ??
      firstMatch(
        lines.filter((l) => /phone|cell|mobile|tel\b/i.test(l)),
        PHONE_RE,
      ) ??
      firstMatch(lines, PHONE_RE),
  );

  const customerEmail =
    firstMatch(customerBlock, EMAIL_RE) ??
    firstMatch(
      lines.filter((l) => /e-?mail/i.test(l)),
      EMAIL_RE,
    ) ??
    firstMatch(lines, EMAIL_RE);

  const boatInfo = findBoatInfo(lines);

  const missing: string[] = [];
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
    missing,
  };
}

/** Human labels for the fields the service writer may have to fill in. */
export const FIELD_LABELS: Record<string, string> = {
  invoiceNumber: 'Invoice #',
  customerName: 'Customer name',
  customerPhone: 'Phone',
  customerEmail: 'Email',
  boatInfo: 'Boat / engine',
};
