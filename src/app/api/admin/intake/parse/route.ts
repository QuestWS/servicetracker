import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/guards';
import { extractPdf } from '@/lib/pdf/extract';
import { parseWorkOrder } from '@/lib/pdf/parse-work-order';
import { storeFile } from '@/lib/files';
import { getJob } from '@/lib/jobs';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Step one of intake: read the BiT work order and hand back what we found.
 * Nothing is created yet — the service writer confirms the fields first,
 * because a mis-parsed email address is worse than a blank one.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const form = await request.formData();
  const upload = form.get('pdf');
  if (!(upload instanceof File)) return jsonError('Choose a work order PDF to upload.', 400);
  if (upload.size === 0) return jsonError('That file is empty.', 400);
  if (upload.size > MAX_BYTES) return jsonError('That PDF is larger than 25 MB.', 400);

  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') {
    return jsonError('That does not look like a PDF. Download the work order from BiT and try again.', 400);
  }

  let parsed;
  let hasTextLayer = true;
  try {
    const extracted = await extractPdf(bytes);
    hasTextLayer = extracted.lines.length > 0;
    parsed = parseWorkOrder(extracted);
  } catch (error) {
    return jsonError(`Could not read that PDF: ${(error as Error).message}`, 422);
  }

  const stored = await storeFile({
    jobId: null,
    kind: 'work_order_source',
    filename: upload.name || 'work-order.pdf',
    mime: 'application/pdf',
    bytes,
  });

  const duplicate = parsed.invoiceNumber ? Boolean(getJob(parsed.invoiceNumber)) : false;

  return NextResponse.json({
    sourceFileId: stored.id,
    filename: stored.filename,
    parsed,
    hasTextLayer,
    duplicate,
  });
}
