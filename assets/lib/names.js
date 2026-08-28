/**
 * Sorting a list of customers by surname, from the one field BiT gives us.
 *
 * A work order carries `customer_name` as a single line — "John Purnell",
 * "SMITH, JOHN", "Quest Watersports LLC" — so the surname has to be read out
 * of it. Imports nothing, so the rules can be pinned by a test rather than
 * discovered on the shop's list.
 */

/** Not a surname, whatever position it is in. */
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'md', 'dds']);

/**
 * A business does not have a surname, and sorting one by its last word files
 * "Quest Watersports LLC" under L. Anything that looks like a company sorts
 * under the name it trades as instead.
 */
const BUSINESS = /(^|\s)(llc|l\.l\.c\.?|inc\.?|ltd\.?|co\.?|corp\.?|company|marina|marinas|marine|charters|rentals|resort|club)(\s|\.|$)/i;

export function lastNameOf(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  // "Smith, John" is already surname first, and the comma says so plainly.
  if (raw.indexOf(',') !== -1) return raw.slice(0, raw.indexOf(',')).trim();
  if (BUSINESS.test(raw)) return raw;

  const words = raw.split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop();
  return words[words.length - 1];
}

/**
 * Surname, then the whole name, so two Smiths keep a settled order rather
 * than swapping about between renders. A job with no name on it sorts to the
 * end: it is a job to fix, not a customer called nothing.
 */
export function byLastName(a, b) {
  const nameA = String(a == null ? '' : a).trim();
  const nameB = String(b == null ? '' : b).trim();
  if (!nameA !== !nameB) return nameA ? -1 : 1;
  const surnames = lastNameOf(nameA).localeCompare(lastNameOf(nameB), undefined, { sensitivity: 'base' });
  if (surnames !== 0) return surnames;
  return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
}
