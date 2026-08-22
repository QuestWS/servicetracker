import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminChrome } from '@/components/AdminChrome';
import { CopyField } from '@/components/CopyField';
import { ShopFeed } from '@/components/Feed';
import { StatusPill } from '@/components/StatusPill';
import { hoursByMechanic, listEntries, totalHours } from '@/lib/entries';
import { formatHours } from '@/lib/entry-types';
import { listEmails } from '@/lib/email';
import { formatDateTime } from '@/lib/format';
import { getJob, listStatusEvents, needsReview, trackingUrl } from '@/lib/jobs';
import { requireAdminPage } from '@/lib/page-guards';
import { STATUS_LABEL, atLeast } from '@/lib/status';
import { FIELD_LABELS } from '@/lib/pdf/parse-work-order';

export const dynamic = 'force-dynamic';

const NOTICES: Record<string, { tone: 'ok' | 'warn'; text: string }> = {
  'saved=details': { tone: 'ok', text: 'Customer details saved.' },
  'saved=invoice': { tone: 'ok', text: 'Invoice and payment link saved.' },
  'saved=status': { tone: 'ok', text: 'Status updated.' },
  'saved=done': { tone: 'ok', text: 'Job marked done — the customer email has been sent.' },
  'saved=resent': { tone: 'ok', text: 'Customer email sent again.' },
  'saved=done_no_mail': {
    tone: 'warn',
    text: 'Job marked done. No mail server is configured on this install, so nothing was emailed — send the customer their tracking link by hand, or set SMTP up and use "send again" below.',
  },
  'error=not_done': { tone: 'warn', text: 'That job is not marked done yet.' },
  'error=email': {
    tone: 'warn',
    text: 'Job marked done, but the customer email did not send. Check the mail settings and the email log below.',
  },
  'error=no_email': {
    tone: 'warn',
    text: 'This job has no customer email address, so there is nobody to send the invoice to. Add one first.',
  },
  'error=already_done': { tone: 'warn', text: 'This job was already marked done.' },
  'error=payment_link': { tone: 'warn', text: 'The payment link must start with http:// or https://.' },
  'error=invoice_type': { tone: 'warn', text: 'That invoice file was not a PDF.' },
  'error=invoice_size': { tone: 'warn', text: 'That invoice PDF is larger than 25 MB.' },
  'error=status': { tone: 'warn', text: 'That status change was not allowed.' },
};

const FIELD_MAP: Record<string, string> = {
  customer_name: 'customerName',
  customer_phone: 'customerPhone',
  customer_email: 'customerEmail',
  boat_info: 'boatInfo',
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Job ${decodeURIComponent(id)}` };
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  await requireAdminPage(`/admin/jobs/${encodeURIComponent(id)}`);

  const job = getJob(id);
  if (!job) notFound();

  const query = await searchParams;
  const noticeKey = query.saved
    ? `saved=${query.saved}`
    : query.error
      ? `error=${query.error}`
      : null;
  const notice = noticeKey ? NOTICES[noticeKey] : null;

  const entries = listEntries(job.id);
  const labor = totalHours(job.id);
  const laborByMechanic = hoursByMechanic(job.id);
  const events = listStatusEvents(job.id);
  const emails = listEmails(job.id);
  const flags = needsReview(job);
  const readyToClose = atLeast(job.status, 'work_finished');
  const doneEmail = emails.find((mail) => mail.kind === 'customer_done');
  const doneEmailSent = doneEmail?.status === 'sent';
  const action = `/api/admin/jobs/${encodeURIComponent(job.id)}`;

  return (
    <AdminChrome active="jobs">
      <main className="wrap">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <h1 className="page-title">Job {job.id}</h1>
            <div className="row tight" style={{ marginTop: 6 }}>
              <StatusPill status={job.status} full />
              <span className="sub" style={{ color: 'var(--muted)' }}>
                Opened {formatDateTime(job.created_at)}
              </span>
            </div>
          </div>
          <Link className="btn ghost" href="/admin">
            Back to jobs
          </Link>
        </div>

        {notice && (
          <div className={`banner ${notice.tone}`} style={{ margin: '14px 0' }}>
            {notice.text}
          </div>
        )}

        {flags.length > 0 && (
          <div className="banner warn" style={{ margin: '14px 0' }}>
            Still needed from the work order:{' '}
            {flags.map((field) => FIELD_LABELS[FIELD_MAP[field] ?? field] ?? field).join(', ')}. The
            customer cannot be emailed without an address.
          </div>
        )}

        <div className="split" style={{ marginTop: 16 }}>
          <div className="stack">
            <section className="card">
              <h2>Customer &amp; boat</h2>
              <form method="post" action={`${action}/details`}>
                <label className="fld" htmlFor="customer_name">
                  Customer name
                </label>
                <input
                  className={`txt${flags.includes('customer_name') ? ' field-flag' : ''}`}
                  id="customer_name"
                  name="customer_name"
                  defaultValue={job.customer_name ?? ''}
                />
                <label className="fld" htmlFor="customer_phone">
                  Phone
                </label>
                <input
                  className={`txt${flags.includes('customer_phone') ? ' field-flag' : ''}`}
                  id="customer_phone"
                  name="customer_phone"
                  defaultValue={job.customer_phone ?? ''}
                />
                <label className="fld" htmlFor="customer_email">
                  Email
                </label>
                <input
                  className={`txt${flags.includes('customer_email') ? ' field-flag' : ''}`}
                  id="customer_email"
                  name="customer_email"
                  type="email"
                  defaultValue={job.customer_email ?? ''}
                />
                <label className="fld" htmlFor="boat_info">
                  Boat / engine
                </label>
                <input
                  className={`txt${flags.includes('boat_info') ? ' field-flag' : ''}`}
                  id="boat_info"
                  name="boat_info"
                  defaultValue={job.boat_info ?? ''}
                />
                <div style={{ marginTop: 14 }}>
                  <button className="btn navy" type="submit">
                    Save details
                  </button>
                </div>
              </form>
            </section>

            <section className="card">
              <h2>Paperwork</h2>
              <div className="stack">
                {job.work_order_file_id ? (
                  <a className="btn ghost" href={`/api/files/${job.work_order_file_id}`} target="_blank" rel="noreferrer">
                    Open stamped work order (PDF)
                  </a>
                ) : (
                  <div className="banner warn">
                    No stamped work order on file. Re-run intake if the printed copy has no QR code.
                  </div>
                )}
                {job.work_order_source_file_id && job.work_order_source_file_id !== job.work_order_file_id && (
                  <a
                    className="hint"
                    href={`/api/files/${job.work_order_source_file_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Original BiT download (no QR)
                  </a>
                )}
                <CopyField label="Customer tracking link" value={trackingUrl(job)} />
              </div>
            </section>

            <section className="card">
              <h2>Labor logged</h2>
              {labor > 0 ? (
                <>
                  <div className="hourstotal">{formatHours(labor)}</div>
                  {laborByMechanic.map((row) => (
                    <div className="kv" key={row.name}>
                      <span className="k">{row.name}</span>
                      <b style={{ fontFamily: 'var(--mono)' }}>{formatHours(row.hours)}</b>
                    </div>
                  ))}
                  <p className="hint">
                    This is what the mechanics logged as they worked — key it into BiT with the
                    parts when you write the invoice up. The customer never sees it.
                  </p>
                </>
              ) : (
                <p className="hint" style={{ margin: 0 }}>
                  No hours logged yet. Mechanics add them from the job screen as they finish each
                  stint.
                </p>
              )}
            </section>

            <section className="card">
              <h2>Close out</h2>
              {!readyToClose && (
                <p className="hint" style={{ marginBottom: 10 }}>
                  You can attach the invoice at any time, but hold off marking the job done until the
                  mechanic marks it finished.
                </p>
              )}
              <form method="post" action={`${action}/invoice`} encType="multipart/form-data">
                <label className="fld" htmlFor="invoice">
                  Final invoice PDF (from BiT — no QR needed)
                </label>
                <input className="txt" id="invoice" name="invoice" type="file" accept="application/pdf" />
                {job.invoice_file_id && (
                  <p className="hint">
                    On file:{' '}
                    <a href={`/api/files/${job.invoice_file_id}`} target="_blank" rel="noreferrer">
                      invoice-{job.id}.pdf
                    </a>{' '}
                    — uploading again replaces it.
                  </p>
                )}
                <label className="fld" htmlFor="payment_link">
                  POS+ payment link
                </label>
                <input
                  className="txt mono"
                  id="payment_link"
                  name="payment_link"
                  placeholder="https://..."
                  defaultValue={job.payment_link ?? ''}
                />
                <p className="hint">Generate the link in POS+ and paste it here — we only store it.</p>
                <div style={{ marginTop: 14 }}>
                  <button className="btn ghost" type="submit">
                    Save invoice &amp; link
                  </button>
                </div>
              </form>

              <hr style={{ border: 0, borderTop: '1px solid var(--ice)', margin: '18px 0' }} />

              {job.status === 'done' ? (
                <>
                  <div className={`banner ${doneEmailSent ? 'ok' : 'warn'}`}>
                    Marked done {formatDateTime(job.done_at)}
                    {doneEmailSent
                      ? ` — the customer email went to ${doneEmail?.recipient}.`
                      : ' — but the customer email has not gone out. Check the email log below, then send it again.'}
                  </div>
                  <form method="post" action={`${action}/resend`} style={{ marginTop: 12 }}>
                    <button
                      className={`btn ${doneEmailSent ? 'ghost' : 'gold'} block`}
                      type="submit"
                      disabled={!job.customer_email}
                    >
                      {doneEmailSent ? 'Send the customer email again' : 'Try the customer email again'}
                    </button>
                  </form>
                </>
              ) : (
                <form method="post" action={`${action}/done`}>
                  <p className="hint" style={{ marginBottom: 10 }}>
                    Marking done emails the customer their tracking link, the invoice PDF and the
                    payment link. It is the only email they get.
                  </p>
                  <button
                    className="btn gold block"
                    type="submit"
                    disabled={!job.customer_email}
                    title={job.customer_email ? undefined : 'Add a customer email address first'}
                  >
                    Mark done &amp; email the customer
                  </button>
                </form>
              )}

              {job.status !== 'done' && (
                <form method="post" action={`${action}/status`} style={{ marginTop: 12 }}>
                  <label className="fld" htmlFor="to">
                    Or set the shop status by hand
                  </label>
                  <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                    <select className="txt" id="to" name="to" defaultValue={job.status}>
                      <option value="received">Received</option>
                      <option value="work_underway">Work underway</option>
                      <option value="work_finished">Work finished (pending invoice)</option>
                    </select>
                    <button className="btn ghost sm" type="submit">
                      Set
                    </button>
                  </div>
                </form>
              )}
            </section>
          </div>

          <div className="stack">
            <section className="card">
              <h2>
                Shop log ({entries.length}){labor > 0 ? ` · ${formatHours(labor)} logged` : ''}
              </h2>
              <ShopFeed entries={entries} />
            </section>

            <section className="card">
              <h2>Timeline</h2>
              {events.map((event) => (
                <div className="kv" key={event.id}>
                  <span className="k">{formatDateTime(event.created_at)}</span>
                  <b>
                    {STATUS_LABEL[event.to_status]}
                    <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                      {' '}
                      · {event.actor_type.replace('_', ' ')}
                    </span>
                  </b>
                </div>
              ))}
            </section>

            {emails.length > 0 && (
              <section className="card">
                <h2>Email log</h2>
                {emails.map((mail) => (
                  <div className="kv" key={mail.id}>
                    <span className="k">
                      {formatDateTime(mail.created_at)} · {mail.kind.replace('_', ' ')}
                    </span>
                    <b>
                      <span
                        className={`pill ${mail.status === 'sent' ? 'green' : mail.status === 'skipped' ? 'grey' : 'red'}`}
                      >
                        {mail.status}
                      </span>
                      <div style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>
                        {mail.recipient}
                        {mail.error ? ` — ${mail.error}` : ''}
                      </div>
                    </b>
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>
      </main>
    </AdminChrome>
  );
}
