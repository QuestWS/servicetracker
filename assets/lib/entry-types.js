/** Entry shapes and labels, shared by every screen. */

export const ENTRY_TYPES = ['customer_note', 'internal_note', 'writer_note', 'labor', 'part'];

export const ENTRY_LABEL = {
  customer_note: 'Customer note',
  internal_note: 'Internal note',
  writer_note: 'From the office',
  labor: 'Labor',
  part: 'Part',
};

/**
 * Labor and parts are shop bookkeeping — the numbers the service writer
 * re-keys into BiT. Along with internal notes, they never reach the customer.
 */
export const INTERNAL_ONLY = ['internal_note', 'writer_note', 'labor', 'part'];

export function isEntryType(value) {
  return ENTRY_TYPES.indexOf(value) !== -1;
}

/**
 * Time is entered, shown and added up in hours and minutes — "2h 30m", not
 * "2.5 h". The shop says it that way and a mechanic logging a stint off the
 * clock should not have to do the division in their head.
 *
 * The stored figure stays decimal hours: it is what the Jobs sheet has always
 * held, what an estimate is written in, and what gets re-keyed into BiT. So
 * minutes are the unit of truth in the code and the decimal is just how it
 * is written down. Everything that counts goes through toMinutes() first,
 * which is what keeps three twenty-minute stints adding up to exactly 1h
 * instead of 59m — summing 0.3333 three times does not.
 */
export function toMinutes(hours) {
  const number = Number(hours);
  return isFinite(number) ? Math.round(number * 60) : 0;
}

/** The inverse, at the precision the sheet stores. 4dp holds any whole minute. */
export function toHours(minutes) {
  return Math.round((Number(minutes) / 60) * 10000) / 10000;
}

/** "2h 30m", "45m", "3h". Zero is "0m" — a duration, never a blank. */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  if (!m) return `${h}h`;
  return `${h}h ${m}m`;
}

/** The same, for the decimal figure that comes back off a job. */
export function formatHours(hours) {
  return formatMinutes(toMinutes(hours));
}

/**
 * The decimal, for the one screen that still needs it: BiT takes hours as a
 * number, so the service writer writing up an invoice has to type 2.5 even
 * though the mechanic logged 2h 30m. Shown beside the duration on the portal,
 * never on the floor and never to a customer.
 */
export function decimalHours(hours) {
  return `${Math.round((toMinutes(hours) / 60) * 100) / 100} h`;
}

export const STATUSES = ['received', 'work_underway', 'work_finished', 'done'];

export const STATUS_LABEL = {
  received: 'Received',
  work_underway: 'Work underway',
  work_finished: 'Work finished (pending invoice)',
  done: 'Done',
};

export const STATUS_SHORT = {
  received: 'Received',
  work_underway: 'Underway',
  work_finished: 'Finished',
  done: 'Done',
};

export const STATUS_PILL = {
  received: 'blue',
  work_underway: 'gold',
  work_finished: 'frost',
  done: 'green',
};

/** Customer-facing wording. Never mentions invoicing, mechanics or parts. */
export const STATUS_CUSTOMER = {
  received: {
    headline: 'Received',
    detail: 'Your boat is checked in and in the queue. We will start work shortly.',
  },
  work_underway: {
    headline: 'Work underway',
    detail: 'A technician is working on your boat right now. Updates appear below as they happen.',
  },
  work_finished: {
    headline: 'Work complete',
    detail: 'The work on your boat is finished. We are putting the final invoice together now.',
  },
  done: {
    headline: 'Ready for pickup',
    detail: 'Everything is wrapped up. Your invoice and payment link are below.',
  },
};

const ORDER = { received: 0, work_underway: 1, work_finished: 2, done: 3 };

/** True when `to` is at or beyond `from` — the lifecycle never runs backwards. */
export function isForward(from, to) {
  return ORDER[to] >= ORDER[from];
}

export function atLeast(status, floor) {
  return ORDER[status] >= ORDER[floor];
}
