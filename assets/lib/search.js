/**
 * Whatever the customer says first on the phone.
 *
 * Every word typed has to turn up somewhere in `fields`, in any order, so
 * "john white", "white john" and "white yamaha" all find the same job. A query
 * of digits and phone punctuation only is a phone number and is matched on
 * its digits against `phone`, so "815-433-2200" finds "(815) 433 2200" however
 * it was keyed — unless it is part of one of the fields as typed, which is how
 * an invoice number like 01-8891 is still found.
 *
 * The same rules as matchesSearch_ in service-tracker.gs, which answers
 * listJobs; the portal filters its cached list with this, and the Service Desk
 * (questws.github.io/desk/) imports it. Imports nothing, so it runs under node.
 */
export function matchesSearch(fields, search, phone) {
  const wanted = String(search || '').trim().toLowerCase();
  if (!wanted) return true;
  const hay = fields.map((f) => (f == null ? '' : String(f))).join(' ').toLowerCase();
  const digits = wanted.replace(/\D/g, '');
  if (/^[\d\s()+.-]+$/.test(wanted) && digits.length >= 3) {
    if (hay.indexOf(wanted) !== -1) return true;
    return String(phone || '').replace(/\D/g, '').indexOf(digits) !== -1;
  }
  return wanted.split(/[\s,]+/).filter(Boolean).every((word) => hay.indexOf(word) !== -1);
}

/** Digits only, the last ten — how two records' phone numbers are compared. */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}
