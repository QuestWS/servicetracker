import fs from 'node:fs';
import path from 'node:path';
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

const LOGO_CID = 'questlogo';
const LOGO_FILE = path.join(process.cwd(), 'public', 'quest-wordmark.png');

/** The mark rides along as an inline attachment, so it shows with images off. */
function logoAttachment(): { filename: string; path: string; cid: string } | null {
  return fs.existsSync(LOGO_FILE)
    ? { filename: 'quest-watersports.png', path: LOGO_FILE, cid: LOGO_CID }
    : null;
}

/**
 * Copied from the winter services app's customer emails so both arrive
 * looking like the same shop: the wordmark over a gold rule, one card on
 * ice-blue, a navy footer carrying the address and phone.
 *
 * The width and height attributes on the logo are load-bearing — Outlook's
 * renderer ignores the CSS and prints the full-size image without them.
 */
function notice(input: {
  greeting?: string;
  intro: string;
  meta?: string;
  buttons?: string;
}): string {
  const logo = logoAttachment()
    ? `<img src="cid:${LOGO_CID}" alt="${escapeHtml(config.shopName)}" width="104" height="56" style="width:104px;height:56px;display:block;border:0">`
    : `<div style="font-family:Arial Black,Arial;font-size:24px;color:#14293E;letter-spacing:1px">${escapeHtml(
        config.shopName.toUpperCase(),
      )}</div>`;

  return (
    '<div style="background:#EBF1F6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #C7D5E0">' +
    `<div style="padding:22px 28px;border-bottom:4px solid #C08A22">${logo}</div>` +
    '<div style="padding:26px 28px">' +
    (input.greeting
      ? `<p style="font-size:16px;color:#1D2B38;margin:0 0 6px">Hi ${escapeHtml(input.greeting)},</p>`
      : '') +
    `<div style="font-size:15px;color:#1D2B38;line-height:1.55;margin:0 0 14px">${input.intro}</div>` +
    (input.meta
      ? `<div style="font-family:Courier New,monospace;font-size:13px;color:#5C7185;margin-bottom:10px">${escapeHtml(
          input.meta,
        )}</div>`
      : '') +
    (input.buttons ?? '') +
    (config.shopPhone
      ? `<p style="font-size:13px;color:#5C7185;line-height:1.5;margin:12px 0 0">Questions? Call us at ${escapeHtml(
          config.shopPhone,
        )}.</p>`
      : '') +
    '</div>' +
    `<div style="background:#14293E;color:#B9CDDD;padding:14px 28px;font-size:12px">${[
      config.shopName,
      config.shopAddress,
      config.shopPhone,
    ]
      .filter(Boolean)
      .map(escapeHtml)
      .join(' · ')}</div>` +
    '</div></div>'
  );
}

function button(href: string, label: string, bg = '#14293E'): string {
  return (
    `<a href="${escapeHtml(href)}" style="display:inline-block;background:${bg};` +
    'color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;' +
    `padding:12px 22px;border-radius:8px;margin:4px 6px 4px 0">${escapeHtml(label)}</a>`
  );
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
  const logo = logoAttachment();
  try {
    await transport.sendMail({
      // Same shape as the winter services app: a display name the customer
      // recognises, and replies routed to the shop rather than to whichever
      // mailbox the app authenticates with.
      from: { name: config.shopName, address: config.smtp.from || config.smtp.user },
      replyTo: config.replyTo || undefined,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: [...(input.attachments ?? []), ...(logo ? [logo] : [])],
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
  const subject = `Your ${config.shopName} service is complete — ${job.id}`;
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

  const html = notice({
    greeting: job.customer_name?.split(' ')[0],
    intro:
      `The work on ${job.boat_info ? escapeHtml(`your ${job.boat_info}`) : 'your boat'} is complete. ` +
      (attachments.length ? 'Your final invoice is attached' : 'Everything is wrapped up') +
      (job.payment_link ? ', and you can pay online with the button below.' : '.'),
    meta: `INVOICE# ${job.id}${job.boat_info ? ` · ${job.boat_info}` : ''}`,
    buttons:
      button(link, 'View your job') +
      (job.payment_link ? button(job.payment_link, 'Pay online', '#C08A22') : ''),
  });

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
    html,
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
    entry.hours ? `Hours: ${entry.hours}` : '',
    entry.part_identifier ? `Part: ${entry.part_identifier}` : '',
    entry.quantity ? `Qty: ${entry.quantity}` : '',
    entry.text ? entry.text : '',
    !entry.text && entry.transcript_status === 'pending' ? '(voice note — transcribing)' : '',
    input.photoCount ? `${input.photoCount} photo${input.photoCount === 1 ? '' : 's'} attached` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const html = notice({
    intro:
      `<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#4A81A6;margin-bottom:4px">${escapeHtml(
        kind,
      )}</div>` +
      `<div style="font-size:16px;font-weight:bold;color:#14293E;margin-bottom:10px">${escapeHtml(job.id)}${
        job.customer_name ? ` · ${escapeHtml(job.customer_name)}` : ''
      }</div>` +
      `<div style="background:#F4F9FC;border:1px solid #C7D5E0;border-radius:10px;padding:12px 14px;white-space:pre-wrap">${escapeHtml(
        detail || '(no text)',
      )}</div>`,
    meta: `${input.mechanicName ?? 'unknown'} · ${new Date(entry.created_at).toLocaleString('en-US')}`,
    buttons: button(adminLink, 'Open the job'),
  });

  const text = `${kind} on ${job.id}\n\n${detail}\n\nOpen the job: ${adminLink}`;

  return send({
    to,
    subject,
    html,
    text,
    kind: 'entry_notification',
    jobId: job.id,
  });
}
