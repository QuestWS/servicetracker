/**
 * The totals block off a finished BiT invoice.
 *
 * A job can carry a deposit — one real invoice reads Grand Total 16,917.79,
 * Deposits 15,285.32, Amount Due 1,632.47 — so the figure the customer
 * actually owes is nothing like the total. Telling them "pay online" next to
 * the wrong number is a bad moment at the counter, and it is the number they
 * are most likely to want.
 *
 * BiT prints these down the right of the LAST page, on the same rows as the
 * legal text down the left, so flattened lines read
 * "...upon completion of Amount Due 1,632.47". Anchoring on the label and
 * taking the money that follows survives that.
 */

const MONEY = String.raw`(-?[\d,]+\.\d{2})`;

const FIELDS = [
  ['saleTotal', /Sale\s+Total\s+/i],
  ['shopSupplies', /Shop\s+Supplies[^\d]*/i],
  ['tax', /(?:^|\s)Tax\s+/i],
  ['grandTotal', /Grand\s+Total\s+/i],
  ['deposits', /Deposits?\s+/i],
  ['amountDue', /Amount\s+Due\s+/i],
];

function toNumber(text) {
  const value = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {{lines: string[]}} input the whole document, all pages
 * @returns {{saleTotal: ?number, shopSupplies: ?number, tax: ?number,
 *            grandTotal: ?number, deposits: ?number, amountDue: ?number,
 *            found: string[]}}
 */
export function parseInvoiceTotals(input) {
  const lines = (input.lines || []).map((line) => String(line).trim()).filter(Boolean);
  const out = { saleTotal: null, shopSupplies: null, tax: null, grandTotal: null, deposits: null, amountDue: null, found: [] };

  for (const [key, label] of FIELDS) {
    // Later pages win: a total block only appears once, at the end, and a
    // stray earlier match is the less trustworthy of the two.
    for (const line of lines) {
      const match = line.match(new RegExp(label.source + MONEY, label.flags));
      if (match) out[key] = toNumber(match[1]);
    }
    if (out[key] !== null) out.found.push(key);
  }

  // A deposit bigger than the total, or a negative bill, means we misread
  // something. Report nothing rather than a figure the shop has to walk back.
  if (out.amountDue !== null && out.amountDue < 0) out.amountDue = null;
  if (out.grandTotal !== null && out.amountDue !== null && out.amountDue > out.grandTotal + 0.005) {
    out.amountDue = null;
  }
  out.found = out.found.filter((key) => out[key] !== null);
  return out;
}

/** Money the way an invoice says it. */
export function formatMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The part lines off a BiT invoice, for a customer's parts order.
 *
 * The body sits between a printed header row — "SKU Description Qty Retail
 * Price Extended" — and the totals block's "Sale Total", both furniture, so
 * the band is findable without knowing what is in it. A line reads
 *
 *   48000-96J16 TRIM ASSY,POWER 1 2240.74 2240.740 2240.74
 *
 * SKU first, the description (which can carry commas and spaces), then the
 * quantity and three money columns — the middle one, the price, printed to
 * three places. Anchoring on the numbers from the RIGHT is what keeps a
 * description with a number in it ("PUMP 3.0L") from being cut short.
 *
 * Anything in the band that is not shaped like that belongs to the line above:
 * BiT prints "Superseded from 48000-96J10" under a part whose number changed.
 * It is kept as that line's note rather than dropped, because the old number
 * is the one the customer may have asked for.
 *
 * @param {{lines: string[]}} input the whole document, all pages
 * @returns {Array<{sku: string, description: string, quantity: ?number,
 *                  price: ?number, extended: ?number, note: string}>}
 */
const ITEM_LINE = /^(\S+)\s+(.*?)\s*(-?\d+(?:\.\d+)?)\s+(-?[\d,]+\.\d{2,3})\s+(-?[\d,]+\.\d{2,3})\s+(-?[\d,]+\.\d{2})$/;
const ITEM_HEADER = /^SKU\s+Description\s+Qty\b/i;
// Anywhere in the line, not at its start: on an invoice raised off a work
// order the totals share their rows with the legal text down the left, and
// the authorisation boilerplate can come first. Either one ends the band.
const ITEM_END = /\b(Sale\s+Total|Grand\s+Total|Amount\s+Due)\b|I hereby authori[sz]e/i;

export function parseInvoiceItems(input) {
  const lines = (input.lines || []).map((line) => String(line).trim()).filter(Boolean);
  const items = [];
  let inside = false;
  for (const line of lines) {
    // The header repeats at the top of every page of a long invoice, so it
    // re-opens the band rather than being found once.
    if (ITEM_HEADER.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (ITEM_END.test(line)) break;
    const match = line.match(ITEM_LINE);
    if (match) {
      items.push({
        sku: match[1],
        description: match[2].trim(),
        quantity: toNumber(match[3]),
        price: toNumber(match[5]),
        extended: toNumber(match[6]),
        note: '',
      });
    } else if (items.length) {
      const last = items[items.length - 1];
      last.note = last.note ? `${last.note} ${line}` : line;
    }
  }
  return items;
}

/** One line per part, the way the order page and the arrival email show it. */
export function describeItems(items) {
  return (items || []).map((item) => {
    const qty = item.quantity && item.quantity !== 1 ? `${item.quantity} x ` : '';
    const what = [item.sku, item.description].filter(Boolean).join(' ');
    return `${qty}${what}`;
  }).join('\n');
}
