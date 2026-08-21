import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/guards';
import { attachFileToJob, fileUrl, getFile, readFileBytes, storeFile } from '@/lib/files';
import { createJob, getJob, trackingUrl, updateJob, REVIEW_FIELDS } from '@/lib/jobs';
import { extractPdf } from '@/lib/pdf/extract';
import { stampWorkOrder } from '@/lib/pdf/stamp';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Body = {
  sourceFileId?: string;
  invoiceNumber?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  boatInfo?: string;
};

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Step two: create the job and hand back a print-ready PDF — the original
 * document, untouched, with a QR code added.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = (await request.json()) as Body;
  const invoiceNumber = clean(body.invoiceNumber)?.toUpperCase();
  if (!invoiceNumber) return jsonError('An invoice number is required — it identifies the job.', 400);
  if (getJob(invoiceNumber)) {
    return jsonError(`Job ${invoiceNumber} already exists. Open it from the jobs list instead.`, 409);
  }

  const source = body.sourceFileId ? getFile(body.sourceFileId) : null;
  if (!source) return jsonError('Upload the work order PDF again — the file was not found.', 400);

  const fields = {
    customer_name: clean(body.customerName),
    customer_phone: clean(body.customerPhone),
    customer_email: clean(body.customerEmail),
    boat_info: clean(body.boatInfo),
  };
  // Whatever is still blank stays flagged on the job so it is visible in the
  // list rather than quietly missing when the Done email goes out.
  const stillMissing = REVIEW_FIELDS.filter((field) => !fields[field]);

  const job = createJob({
    id: invoiceNumber,
    customerName: fields.customer_name,
    customerPhone: fields.customer_phone,
    customerEmail: fields.customer_email,
    boatInfo: fields.boat_info,
    needsReview: [...stillMissing],
    workOrderSourceFileId: source.id,
  });
  attachFileToJob(source.id, job.id);

  try {
    const bytes = new Uint8Array(await readFileBytes(source));
    const extracted = await extractPdf(bytes);
    const stamped = await stampWorkOrder({
      pdfBytes: bytes,
      trackingUrl: trackingUrl(job),
      invoiceNumber: job.id,
      firstPage: extracted.pages[0],
    });
    const stampedFile = await storeFile({
      jobId: job.id,
      kind: 'work_order_stamped',
      filename: `work-order-${job.id}.pdf`,
      mime: 'application/pdf',
      bytes: stamped,
    });
    updateJob(job.id, { work_order_file_id: stampedFile.id });

    return NextResponse.json({
      jobId: job.id,
      trackingUrl: trackingUrl(job),
      stampedPdfUrl: fileUrl(stampedFile.id),
      adminUrl: `/admin/jobs/${encodeURIComponent(job.id)}`,
      needsReview: stillMissing,
    });
  } catch (error) {
    // The job exists and is usable; only the stamped copy failed. Say so
    // plainly rather than pretending intake worked end to end.
    return NextResponse.json(
      {
        jobId: job.id,
        trackingUrl: trackingUrl(job),
        stampedPdfUrl: null,
        adminUrl: `/admin/jobs/${encodeURIComponent(job.id)}`,
        needsReview: stillMissing,
        warning: `Job created, but the QR stamp failed: ${(error as Error).message}`,
      },
      { status: 207 },
    );
  }
}
