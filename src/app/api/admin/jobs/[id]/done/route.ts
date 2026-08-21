import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/guards';
import { getJob, setStatus } from '@/lib/jobs';
import { sendJobDoneEmail } from '@/lib/email';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * "Mark Done" — the one moment a customer-facing email fires. The status is
 * committed first, then the email is attempted; a bounced mail server must
 * not leave the job stuck one step short of done.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const job = getJob(decodeURIComponent(id));
  if (!job) return new NextResponse('Not found', { status: 404 });

  const back = (query: string) =>
    NextResponse.redirect(
      new URL(`/admin/jobs/${encodeURIComponent(job.id)}?${query}`, request.url),
      303,
    );

  if (job.status === 'done') return back('error=already_done');
  if (!job.customer_email) return back('error=no_email');

  const result = setStatus(job.id, 'done', { type: 'service_writer' }, 'Marked done');
  if (!result?.changed) return back('error=status');

  const sent = await sendJobDoneEmail(result.job);
  if (sent) return back('saved=done');
  // No mail server configured is a setup gap, not a delivery failure — say
  // which one it was so nobody goes hunting for a bounce that never happened.
  return back(config.smtp.user ? 'error=email' : 'saved=done_no_mail');
}
