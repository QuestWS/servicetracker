import { NextResponse } from 'next/server';
import { requireMechanic } from '@/lib/guards';
import { listEntries } from '@/lib/entries';
import { getJobByToken } from '@/lib/jobs';
import { STATUS_LABEL } from '@/lib/status';

/** The mechanic's view of a job: everything logged on it, newest last. */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { mechanic, error } = await requireMechanic();
  if (error) return error;

  const { token } = await ctx.params;
  const job = getJobByToken(token);
  if (!job) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json({
    mechanic,
    job: {
      id: job.id,
      token: job.tracking_token,
      boatInfo: job.boat_info,
      customerName: job.customer_name,
      status: job.status,
      statusLabel: STATUS_LABEL[job.status],
      workOrderUrl: job.work_order_file_id ? `/api/files/${job.work_order_file_id}` : null,
    },
    entries: listEntries(job.id),
  });
}
