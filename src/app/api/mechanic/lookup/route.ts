import { NextResponse, type NextRequest } from 'next/server';
import { jsonError } from '@/lib/guards';
import { findJobByInvoiceNumber, getJobByToken, setStatus, type Job } from '@/lib/jobs';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import { currentMechanic } from '@/lib/session';
import { STATUS_LABEL } from '@/lib/status';
import { tokenFromScan } from '@/lib/tracking';

function summary(job: Job) {
  return {
    id: job.id,
    token: job.tracking_token,
    boatInfo: job.boat_info,
    customerName: job.customer_name,
    status: job.status,
    statusLabel: STATUS_LABEL[job.status],
  };
}

/**
 * Turns a scan (or a typed invoice number) into a job.
 *
 * A scan is the mechanic physically picking the job up off the shelf, so this
 * is where a job auto-advances to "Work underway" — before the PIN prompt,
 * exactly as the paper-first workflow implies. Only a summary comes back; the
 * log itself needs a PIN.
 */
export async function GET(request: NextRequest) {
  if (!rateLimit(clientKey(request, 'lookup'), 60, 60 * 1000)) {
    return jsonError('Slow down a moment and try again.', 429);
  }

  const params = request.nextUrl.searchParams;
  const scanned = params.get('scan');
  const code = params.get('code');
  const source = params.get('source') === 'scan' || Boolean(scanned) ? 'scan' : 'manual';

  let job: Job | null = null;
  if (scanned) {
    const token = tokenFromScan(scanned);
    if (!token) {
      return jsonError('That code is not a Quest work order. Type the invoice number instead.', 404);
    }
    job = getJobByToken(token);
  } else if (code) {
    job = getJobByToken(code.trim().toUpperCase()) ?? findJobByInvoiceNumber(code);
  } else {
    return jsonError('Nothing to look up.', 400);
  }

  if (!job) return jsonError('No job found for that code. Check the number on the work order.', 404);

  if (source === 'scan' && job.status === 'received') {
    const mechanic = await currentMechanic();
    setStatus(
      job.id,
      'work_underway',
      mechanic ? { type: 'mechanic', id: mechanic.id } : { type: 'system' },
      'First scan of the work order',
    );
    job = getJobByToken(job.tracking_token)!;
  }

  return NextResponse.json({ job: summary(job) });
}
