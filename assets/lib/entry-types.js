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

/** Formats hours the way the shop says them: 1.5 h, 0.25 h, 2 h. */
export function formatHours(hours) {
  return `${Math.round(Number(hours) * 100) / 100} h`;
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
