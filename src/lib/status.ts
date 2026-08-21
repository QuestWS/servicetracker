export const STATUSES = ['received', 'work_underway', 'work_finished', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

/** Shop-side label — what the service writer and mechanics see. */
export const STATUS_LABEL: Record<Status, string> = {
  received: 'Received',
  work_underway: 'Work underway',
  work_finished: 'Work finished (pending invoice)',
  done: 'Done',
};

/** Short form, for pills in dense lists. */
export const STATUS_SHORT: Record<Status, string> = {
  received: 'Received',
  work_underway: 'Underway',
  work_finished: 'Finished',
  done: 'Done',
};

/** Customer-facing wording. Never mentions invoicing mechanics or parts. */
export const STATUS_CUSTOMER: Record<Status, { headline: string; detail: string }> = {
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

export const STATUS_PILL: Record<Status, string> = {
  received: 'blue',
  work_underway: 'gold',
  work_finished: 'frost',
  done: 'green',
};

const ORDER: Record<Status, number> = {
  received: 0,
  work_underway: 1,
  work_finished: 2,
  done: 3,
};

/** True when `to` is at or beyond `from` — the lifecycle never runs backwards. */
export function isForward(from: Status, to: Status): boolean {
  return ORDER[to] >= ORDER[from];
}

export function atLeast(status: Status, floor: Status): boolean {
  return ORDER[status] >= ORDER[floor];
}
