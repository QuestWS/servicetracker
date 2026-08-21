import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, str } from '@/lib/guards';
import { storeFile } from '@/lib/files';
import { getJob, updateJob } from '@/lib/jobs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Attaches the final BiT invoice and the POS+ payment link. The invoice needs
 * no QR code — it is the document the customer receives, not the one the shop
 * writes on.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await ctx.params;
  const job = getJob(decodeURIComponent(id));
  if (!job) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const back = (query: string) =>
    NextResponse.redirect(
      new URL(`/admin/jobs/${encodeURIComponent(job.id)}?${query}`, request.url),
      303,
    );

  const paymentLink = str(form.get('payment_link'));
  if (paymentLink && !/^https?:\/\//i.test(paymentLink)) {
    return back('error=payment_link');
  }

  const upload = form.get('invoice');
  let invoiceFileId = job.invoice_file_id;
  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_BYTES) return back('error=invoice_size');
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') return back('error=invoice_type');
    const stored = await storeFile({
      jobId: job.id,
      kind: 'invoice',
      filename: `invoice-${job.id}.pdf`,
      mime: 'application/pdf',
      bytes,
    });
    invoiceFileId = stored.id;
  }

  updateJob(job.id, { invoice_file_id: invoiceFileId, payment_link: paymentLink });
  return back('saved=invoice');
}
