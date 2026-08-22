import Link from 'next/link';
import { AdminChrome } from '@/components/AdminChrome';
import { StatusPill } from '@/components/StatusPill';
import { countByStatus, listJobs, needsReview } from '@/lib/jobs';
import { requireAdminPage } from '@/lib/page-guards';
import { STATUSES, STATUS_LABEL, isStatus, type Status } from '@/lib/status';
import { formatDate, relativeDays } from '@/lib/format';
import { formatHours } from '@/lib/entry-types';
import { jobListStats } from '@/lib/entries';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Jobs' };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireAdminPage('/admin');
  const { status: statusParam, q } = await searchParams;
  const status: Status | 'all' = statusParam && isStatus(statusParam) ? statusParam : 'all';
  const search = q?.trim() || undefined;

  const jobs = listJobs({ status, search });
  const counts = countByStatus();
  const stats = jobListStats();

  const filterHref = (value: Status | 'all') => {
    const params = new URLSearchParams();
    if (value !== 'all') params.set('status', value);
    if (search) params.set('q', search);
    const qs = params.toString();
    return `/admin${qs ? `?${qs}` : ''}`;
  };

  return (
    <AdminChrome active="jobs">
      <main className="wrap">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h1 className="page-title">Jobs</h1>
          <Link className="btn navy" href="/admin/intake">
            New work order
          </Link>
        </div>

        <div className="stats" style={{ marginBottom: 16 }}>
          {STATUSES.map((value) => (
            <Link key={value} className="stat" href={filterHref(value)}>
              <div className="v">{counts[value] ?? 0}</div>
              <div className="k">{STATUS_LABEL[value]}</div>
            </Link>
          ))}
        </div>

        <form className="row" method="get" action="/admin" style={{ marginBottom: 14 }}>
          {status !== 'all' && <input type="hidden" name="status" value={status} />}
          <input
            className="txt"
            name="q"
            placeholder="Invoice #, customer or boat"
            defaultValue={search ?? ''}
            style={{ flex: '1 1 240px' }}
          />
          <button className="btn ghost" type="submit">
            Search
          </button>
          {(search || status !== 'all') && (
            <Link className="btn ghost" href="/admin">
              Clear
            </Link>
          )}
        </form>

        <div className="row tight" style={{ marginBottom: 14 }}>
          <Link className={`chip${status === 'all' ? ' on' : ''}`} href={filterHref('all')}>
            All
          </Link>
          {STATUSES.map((value) => (
            <Link
              key={value}
              className={`chip${status === value ? ' on' : ''}`}
              href={filterHref(value)}
            >
              {STATUS_LABEL[value]}
            </Link>
          ))}
        </div>

        {jobs.length === 0 ? (
          <div className="empty">
            {search || status !== 'all'
              ? 'No jobs match that filter.'
              : 'No jobs yet. Upload a BiT work order to create the first one.'}
          </div>
        ) : (
          <div className="joblist">
            {jobs.map((job) => {
              const flags = needsReview(job);
              const stat = stats.get(job.id) ?? { entries: 0, hours: 0 };
              return (
                <Link key={job.id} className="jobrow" href={`/admin/jobs/${encodeURIComponent(job.id)}`}>
                  <div style={{ minWidth: 84 }}>
                    <div className="num">{job.id}</div>
                    <div className="sub">{formatDate(job.created_at)}</div>
                  </div>
                  <div className="grow">
                    <div className="who">{job.customer_name ?? '(no name on file)'}</div>
                    <div className="sub">{job.boat_info ?? '(no boat details)'}</div>
                  </div>
                  <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                    {flags.length > 0 && <span className="pill red">{flags.length} to fill in</span>}
                    {stat.hours > 0 && <span className="pill frost">{formatHours(stat.hours)}</span>}
                    <span className="pill grey">{stat.entries} log</span>
                    <StatusPill status={job.status} />
                    <span className="sub" style={{ minWidth: 78, textAlign: 'right' }}>
                      {relativeDays(job.updated_at)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </AdminChrome>
  );
}
