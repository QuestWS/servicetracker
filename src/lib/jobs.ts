import { db, nowIso } from './db';
import { newId, newTrackingToken } from './ids';
import { config } from './config';
import { isForward, type Status } from './status';

export type Job = {
  id: string;
  tracking_token: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  boat_info: string | null;
  status: Status;
  needs_review: string;
  work_order_file_id: string | null;
  work_order_source_file_id: string | null;
  invoice_file_id: string | null;
  payment_link: string | null;
  created_at: string;
  updated_at: string;
  work_started_at: string | null;
  work_finished_at: string | null;
  done_at: string | null;
};

export type Actor =
  | { type: 'service_writer'; id?: null }
  | { type: 'mechanic'; id: string }
  | { type: 'system'; id?: null };

export function trackingUrl(job: Pick<Job, 'tracking_token'>): string {
  return `${config.appUrl}/t/${job.tracking_token}`;
}

/** Fields the intake parser is expected to fill; anything missing is flagged. */
export const REVIEW_FIELDS = [
  'customer_name',
  'customer_phone',
  'customer_email',
  'boat_info',
] as const;

export function needsReview(job: Job): string[] {
  try {
    const parsed = JSON.parse(job.needs_review);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function createJob(input: {
  id: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  boatInfo?: string | null;
  needsReview?: string[];
  workOrderFileId?: string | null;
  workOrderSourceFileId?: string | null;
}): Job {
  const at = nowIso();
  const row = {
    id: input.id,
    tracking_token: newTrackingToken(),
    customer_name: input.customerName ?? null,
    customer_phone: input.customerPhone ?? null,
    customer_email: input.customerEmail ?? null,
    boat_info: input.boatInfo ?? null,
    status: 'received' as Status,
    needs_review: JSON.stringify(input.needsReview ?? []),
    work_order_file_id: input.workOrderFileId ?? null,
    work_order_source_file_id: input.workOrderSourceFileId ?? null,
    invoice_file_id: null,
    payment_link: null,
    created_at: at,
    updated_at: at,
    work_started_at: null,
    work_finished_at: null,
    done_at: null,
  };
  db()
    .prepare(
      `INSERT INTO jobs (id, tracking_token, customer_name, customer_phone, customer_email,
                         boat_info, status, needs_review, work_order_file_id,
                         work_order_source_file_id, invoice_file_id, payment_link,
                         created_at, updated_at, work_started_at, work_finished_at, done_at)
       VALUES (@id, @tracking_token, @customer_name, @customer_phone, @customer_email,
               @boat_info, @status, @needs_review, @work_order_file_id,
               @work_order_source_file_id, @invoice_file_id, @payment_link,
               @created_at, @updated_at, @work_started_at, @work_finished_at, @done_at)`,
    )
    .run(row);
  recordStatusEvent(row.id, null, 'received', { type: 'service_writer' }, 'Work order intake');
  return row;
}

export function getJob(id: string): Job | null {
  return (db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job) ?? null;
}

export function getJobByToken(token: string): Job | null {
  return (db().prepare('SELECT * FROM jobs WHERE tracking_token = ?').get(token) as Job) ?? null;
}

/**
 * Mechanic lookup by the number printed on the paper. BiT writes it as
 * `01-8886`; people type `018886` or `8886`, so match generously but never
 * ambiguously — a suffix match that hits two jobs returns nothing.
 */
export function findJobByInvoiceNumber(raw: string): Job | null {
  const typed = raw.trim().toUpperCase();
  if (!typed) return null;
  const exact = getJob(typed);
  if (exact) return exact;

  const digits = typed.replace(/[^0-9A-Z]/g, '');
  if (!digits) return null;
  const candidates = db()
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
    .all() as Job[];
  const matches = candidates.filter((job) => {
    const normalized = job.id.toUpperCase().replace(/[^0-9A-Z]/g, '');
    return normalized === digits || normalized.endsWith(digits);
  });
  return matches.length === 1 ? matches[0] : null;
}

export function listJobs(filter?: { status?: Status | 'all'; search?: string }): Job[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status && filter.status !== 'all') {
    clauses.push('status = @status');
    params.status = filter.status;
  }
  if (filter?.search) {
    clauses.push(
      '(id LIKE @q OR customer_name LIKE @q OR boat_info LIKE @q OR customer_phone LIKE @q)',
    );
    params.q = `%${filter.search}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db()
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`)
    .all(params) as Job[];
}

export function countByStatus(): Record<string, number> {
  const rows = db()
    .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
    .all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

type JobPatch = Partial<
  Pick<
    Job,
    | 'customer_name'
    | 'customer_phone'
    | 'customer_email'
    | 'boat_info'
    | 'payment_link'
    | 'invoice_file_id'
    | 'work_order_file_id'
    | 'needs_review'
  >
>;

export function updateJob(id: string, patch: JobPatch): Job | null {
  const keys = Object.keys(patch) as (keyof JobPatch)[];
  if (keys.length) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db()
      .prepare(`UPDATE jobs SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, id, updated_at: nowIso() });
  }
  return getJob(id);
}

export function recordStatusEvent(
  jobId: string,
  from: Status | null,
  to: Status,
  actor: Actor,
  note?: string,
): void {
  db()
    .prepare(
      `INSERT INTO status_events (id, job_id, from_status, to_status, actor_type, actor_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId('sev'), jobId, from, to, actor.type, actor.id ?? null, note ?? null, nowIso());
}

export type StatusEvent = {
  id: string;
  job_id: string;
  from_status: Status | null;
  to_status: Status;
  actor_type: string;
  actor_id: string | null;
  note: string | null;
  created_at: string;
};

export function listStatusEvents(jobId: string): StatusEvent[] {
  return db()
    .prepare('SELECT * FROM status_events WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId) as StatusEvent[];
}

/**
 * The only way a job's status changes. Refuses to run the lifecycle backwards
 * and stamps the matching timestamp column so the customer page can show when
 * each stage happened.
 */
export function setStatus(
  jobId: string,
  to: Status,
  actor: Actor,
  note?: string,
): { job: Job; changed: boolean } | null {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.status === to) return { job, changed: false };
  if (!isForward(job.status, to)) return { job, changed: false };

  const at = nowIso();
  const stamps: Record<string, string | null> = {};
  if (to === 'work_underway' && !job.work_started_at) stamps.work_started_at = at;
  if (to === 'work_finished' && !job.work_finished_at) stamps.work_finished_at = at;
  if (to === 'done' && !job.done_at) stamps.done_at = at;

  const extra = Object.keys(stamps)
    .map((k) => `, ${k} = @${k}`)
    .join('');
  db()
    .prepare(`UPDATE jobs SET status = @status, updated_at = @updated_at${extra} WHERE id = @id`)
    .run({ ...stamps, id: jobId, status: to, updated_at: at });
  recordStatusEvent(jobId, job.status, to, actor, note);
  return { job: getJob(jobId)!, changed: true };
}
