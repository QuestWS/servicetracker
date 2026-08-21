import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/guards';
import { getJob, setStatus } from '@/lib/jobs';
import { isStatus } from '@/lib/status';

/**
 * Lets the service writer nudge a job along when the shop floor forgot to —
 * the mechanic marked nothing, or a job was scanned by mistake. Marking a job
 * Done has its own route, because that one sends mail.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const job = getJob(decodeURIComponent(id));
  if (!job) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const to = form.get('to');
  if (typeof to !== 'string' || !isStatus(to) || to === 'done') {
    return NextResponse.redirect(
      new URL(`/admin/jobs/${encodeURIComponent(job.id)}?error=status`, request.url),
      303,
    );
  }
  setStatus(job.id, to, { type: 'service_writer' }, 'Set by service writer');
  return NextResponse.redirect(
    new URL(`/admin/jobs/${encodeURIComponent(job.id)}?saved=status`, request.url),
    303,
  );
}
