import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config';
import { db, nowIso } from './db';
import { newId } from './ids';
import { ENTRY_LABEL, type LogEntryRow } from './entries';
import { getFile, readFileBytes } from './files';
import { trackingUrl, type Job } from './jobs';

let transporter: Transporter | null = null;

function mailer(): Transporter | null {
  if (!config.smtp.user || !config.smtp.pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

function logEmail(input: {
  jobId: string | null;
  kind: string;
  recipient: string;
  subject: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO email_log (id, job_id, kind, recipient, subject, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('mail'),
      input.jobId,
      input.kind,
      input.recipient,
      input.subject,
      input.status,
      input.error?.slice(0, 500) ?? null,
      nowIso(),
    );
}

export type EmailRecord = {
  id: string;
  job_id: string | null;
  kind: string;
  recipient: string;
  subject: string;
  status: string;
  error: string | null;
  created_at: string;
};

export function listEmails(jobId: string): EmailRecord[] {
  return db()
    .prepare('SELECT * FROM email_log WHERE job_id = ? ORDER BY created_at DESC')
    .all(jobId) as EmailRecord[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** House style, matched to the Quest quote emails: navy header, gold rule. */
function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EBF1F6;font-family:'Source Sans 3',Segoe UI,Helvetica,Arial,sans-serif;color:#1D2B38;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EBF1F6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #C7D5E0;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#14293E;color:#ffffff;padding:18px 22px;border-bottom:4px solid #C08A22;">
          <div style="font-size:19px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(config.shopName)}</div>
          <div style="font-size:12px;color:#B9CDDD;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(title)}</div>
        </td></tr>
        <tr><td style="padding:22px;">${body}</td></tr>
        <tr><td style="padding:14px 22px;border-top:1px solid #EBF1F6;font-size:12px;color:#5C7185;">
          ${escapeHtml(config.shopName)}${config.shopPhone ? ` · ${escapeHtml(config.shopPhone)}` : ''} · Ottawa, IL
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function button(href: string, label: string, color = '#14293E'): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;letter-spacing:.04em;padding:12px 22px;border-radius:9px;">${escapeHtml(label)}</a>`;
}

async function send(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
  jobId: string | null;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}): Promise<boolean> {
  const transport = mailer();
  if (!transport) {
    logEmail({ ...input, recipient: input.to, status: 'skipped', error: 'SMTP not configured' });
    return false;
  }
  try {
    await transport.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    });
    logEmail({ ...input, recipient: input.to, status: 'sent' });
    return true;
  } catch (error) {
    logEmail({ ...input, recipient: input.to, status: 'failed', error: (error as Error).message });
    return false;
  }
}

/**
 * The single customer-facing email, fired when the service writer marks the
 * job Done: tracking link, the final BiT invoice as an attachment, and the
 * POS+ payment link.
 */
export async function sendJobDoneEmail(job: Job): Promise<boolean> {
  if (!job.customer_email) {
    logEmail({
      jobId: job.id,
      kind: 'customer_done',
      recipient: '(none on file)',
      subject: `Your ${config.shopName} service is complete`,
      status: 'skipped',
      error: 'No customer email on the job',
    });
    return false;
  }

  const link = trackingUrl(job);
  const subject = `${config.shopName}: service complete — invoice ${job.id}`;
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (job.invoice_file_id) {
    const file = getFile(job.invoice_file_id);
    if (file) {
      attachments.push({
        filename: `Invoice-${job.id}.pdf`,
        content: await readFileBytes(file),
        contentType: 'application/pdf',
      });
    }
  }

  const body = `
    <p style="margin:0 0 14px;font-size:16px;">Hi${job.customer_name ? ` ${escapeHtml(job.customer_name.split(' ')[0])}` : ''},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">The work on ${
      job.boat_info ? `your ${escapeHtml(job.boat_info)}` : 'your boat'
    } is complete. Your final invoice is attached${
      job.payment_link ? ', and you can pay online with the button below' : ''
    }.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
      <tr><td style="padding:0 10px 10px 0;">${button(link, 'View your job')}</td>
      ${job.payment_link ? `<td style="padding:0 0 10px 0;">${button(job.payment_link, 'Pay invoice', '#C08A22')}</td>` : ''}</tr>
    </table>
    <p style="margin:0;font-size:13px;color:#5C7185;">Invoice ${escapeHtml(job.id)}${
      job.boat_info ? ` · ${escapeHtml(job.boat_info)}` : ''
    }</p>`;

  const text = [
    `The work on your boat is complete.`,
    ``,
    `Job status: ${link}`,
    job.payment_link ? `Pay your invoice: ${job.payment_link}` : '',
    ``,
    `Invoice ${job.id}`,
    config.shopName,
  ]
    .filter(Boolean)
    .join('\n');

  return send({
    to: job.customer_email,
    subject,
    html: shell('Service complete', body),
    text,
    kind: 'customer_done',
    jobId: job.id,
    attachments,
  });
}

/**
 * Service-writer notification, one per log entry. Deliberately per-entry to
 * start with — batching can come later if the shop finds it noisy.
 */
export async function sendEntryNotification(input: {
  job: Job;
  entry: LogEntryRow;
  mechanicName: string | null;
  photoCount: number;
}): Promise<boolean> {
  const to = config.serviceWriterEmail;
  const { job, entry } = input;
  if (!to) {
    logEmail({
      jobId: job.id,
      kind: 'entry_notification',
      recipient: '(none configured)',
      subject: `New log entry on ${job.id}`,
      status: 'skipped',
      error: 'SERVICE_WRITER_EMAIL is not set',
    });
    return false;
  }

  const adminLink = `${config.appUrl}/admin/jobs/${encodeURIComponent(job.id)}`;
  const kind = ENTRY_LABEL[entry.entry_type];
  const subject = `${job.id} — ${kind.toLowerCase()} from ${input.mechanicName ?? 'the shop'}`;

  const detail = [
    entry.part_identifier ? `Part: ${entry.part_identifier}` : '',
    entry.quantity ? `Qty: ${entry.quantity}` : '',
    entry.text ? entry.text : '',
    !entry.text && entry.transcript_status === 'pending' ? '(voice note — transcribing)' : '',
    input.photoCount ? `${input.photoCount} photo${input.photoCount === 1 ? '' : 's'} attached` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const body = `
    <p style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#4A81A6;">${escapeHtml(kind)}</p>
    <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#14293E;">${escapeHtml(job.id)}${
      job.customer_name ? ` · ${escapeHtml(job.customer_name)}` : ''
    }</p>
    <div style="background:#F4F9FC;border:1px solid #C7D5E0;border-radius:10px;padding:12px 14px;font-size:15px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(
      detail || '(no text)',
    )}</div>
    <p style="margin:14px 0 18px;font-size:13px;color:#5C7185;">Logged by ${escapeHtml(
      input.mechanicName ?? 'unknown',
    )} · ${escapeHtml(new Date(entry.created_at).toLocaleString('en-US'))}</p>
    ${button(adminLink, 'Open the job')}`;

  const text = `${kind} on ${job.id}\n\n${detail}\n\nOpen the job: ${adminLink}`;

  return send({
    to,
    subject,
    html: shell('New log entry', body),
    text,
    kind: 'entry_notification',
    jobId: job.id,
  });
}
