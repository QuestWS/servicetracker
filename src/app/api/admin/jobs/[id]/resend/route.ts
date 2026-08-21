import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/guards';
import { getJob } from '@/lib/jobs';
import { sendJobDoneEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Sends the customer's Done email again. Needed more often than it sounds:
 * the mail server was down, or the address was wrong and has since been
 * fixed. It changes no status — the job is already done.
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

  if (job.status !== 'done') return back('error=not_done');
  if (!job.customer_email) return back('error=no_email');

  const sent = await sendJobDoneEmail(job);
  return back(sent ? 'saved=resent' : 'error=email');
}
