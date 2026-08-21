import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { getJob, updateJob, REVIEW_FIELDS } from '@/lib/jobs';

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const job = getJob(decodeURIComponent(id));
  if (!job) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const patch = {
    customer_name: str(form.get('customer_name')),
    customer_phone: str(form.get('customer_phone')),
    customer_email: str(form.get('customer_email')),
    boat_info: str(form.get('boat_info')),
  };
  // The flag list is derived, never typed: filling a field clears its flag.
  const stillMissing = REVIEW_FIELDS.filter((field) => !patch[field]);
  updateJob(job.id, { ...patch, needs_review: JSON.stringify(stillMissing) });

  return NextResponse.redirect(
    new URL(`/admin/jobs/${encodeURIComponent(job.id)}?saved=details`, request.url),
    303,
  );
}
