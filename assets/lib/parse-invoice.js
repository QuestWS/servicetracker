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
