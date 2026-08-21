import { NextResponse } from 'next/server';
import { jsonError, requireMechanic } from '@/lib/guards';
import { getJobByToken, setStatus } from '@/lib/jobs';
import { STATUS_LABEL } from '@/lib/status';

/**
 * "Work finished" — the mechanic is physically done. It does not invoice, it
 * does not email the customer; it tells the service writer the job is ready
 * to be written up in BiT.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { mechanic, error } = await requireMechanic();
  if (error) return error;

  const { token } = await ctx.params;
  const job = getJobByToken(token);
  if (!job) return new NextResponse('Not found', { status: 404 });
  if (job.status === 'done') return jsonError('This job is already closed out.', 409);

  const result = setStatus(job.id, 'work_finished', { type: 'mechanic', id: mechanic.id });
  if (!result) return jsonError('Could not update that job.', 500);

  return NextResponse.json({
    status: result.job.status,
    statusLabel: STATUS_LABEL[result.job.status],
  });
}
