import { notFound } from 'next/navigation';
import { getJobByToken } from '@/lib/jobs';
import { STATUS_LABEL } from '@/lib/status';
import { JobClient } from './JobClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Job', robots: { index: false, follow: false } };

/**
 * The token in the URL came off the paper, so it is enough to name the job on
 * screen. Everything past that — the log, and the ability to add to it —
 * waits until somebody says who they are.
 */
export default async function MechanicJobPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = getJobByToken(token);
  if (!job) notFound();

  return (
    <JobClient
      token={job.tracking_token}
      initialJob={{
        id: job.id,
        token: job.tracking_token,
        boatInfo: job.boat_info,
        customerName: job.customer_name,
        status: job.status,
        statusLabel: STATUS_LABEL[job.status],
      }}
    />
  );
}
