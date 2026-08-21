import { notFound } from 'next/navigation';
import { CustomerFeed } from '@/components/Feed';
import { config } from '@/lib/config';
import { listCustomerEntries } from '@/lib/entries';
import { formatDate } from '@/lib/format';
import { getJobByToken } from '@/lib/jobs';
import { STATUSES, STATUS_CUSTOMER, STATUS_SHORT } from '@/lib/status';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return {
    title: `Your service job · ${config.shopName}`,
    robots: { index: false, follow: false },
  };
}

const STEP_LABELS: Record<(typeof STATUSES)[number], string> = {
  received: 'Received',
  work_underway: 'In the shop',
  work_finished: 'Work done',
  done: 'Ready',
};

export default async function TrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = getJobByToken(token);
  if (!job) notFound();

  const entries = listCustomerEntries(job.id, job.tracking_token);
  const state = STATUS_CUSTOMER[job.status];
  const currentIndex = STATUSES.indexOf(job.status);

  return (
    <>
      <header className="tracker-head">
        <div className="inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/quest-mark.png" alt="" />
          <div>
            <div className="co">{config.shopName}</div>
            <div className="sub">Service tracking</div>
          </div>
        </div>
      </header>

      <main className="wrap narrow">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="kv">
            <span className="k">Your boat</span>
            <b>{job.boat_info ?? 'Your unit'}</b>
          </div>
          <div className="kv">
            <span className="k">Job number</span>
            <b style={{ fontFamily: 'var(--mono)' }}>{job.id}</b>
          </div>
          <div className="kv">
            <span className="k">Checked in</span>
            <b>{formatDate(job.created_at)}</b>
          </div>
        </div>

        <div className="status-hero">
          <div className="h">{state.headline}</div>
          <div className="d">{state.detail}</div>
        </div>

        <div className="steps" style={{ marginTop: 16 }}>
          {STATUSES.map((value, index) => (
            <div
              key={value}
              className={`step${index < currentIndex ? ' on' : ''}${index === currentIndex ? ' here' : ''}`}
            >
              <div className="bar" />
              <div className="lab">{STEP_LABELS[value]}</div>
            </div>
          ))}
        </div>

        {job.status === 'done' && (
          <section className="card gold" style={{ marginTop: 18 }}>
            <h2 style={{ color: '#8a6516' }}>Invoice &amp; payment</h2>
            <div className="stack">
              {job.invoice_file_id && (
                <a
                  className="btn navy"
                  href={`/api/files/${job.invoice_file_id}?t=${encodeURIComponent(job.tracking_token)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View your invoice (PDF)
                </a>
              )}
              {job.payment_link && (
                <a className="btn gold" href={job.payment_link} target="_blank" rel="noreferrer">
                  Pay online
                </a>
              )}
              {!job.invoice_file_id && !job.payment_link && (
                <p className="hint">
                  Your invoice is on its way — give the shop a call if you need it right now.
                </p>
              )}
            </div>
          </section>
        )}

        <section style={{ marginTop: 22 }}>
          <h2
            style={{
              fontFamily: 'var(--disp)',
              fontSize: 24,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
              color: 'var(--navy)',
              marginBottom: 10,
            }}
          >
            Updates from the shop
          </h2>
          <CustomerFeed entries={entries} />
        </section>

        <p className="hint" style={{ marginTop: 26, textAlign: 'center' }}>
          Questions? Call {config.shopName}
          {config.shopPhone ? ` at ${config.shopPhone}` : ''} and quote job {job.id}.
        </p>
      </main>
    </>
  );
}
