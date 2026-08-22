import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A throwaway SMTP sink. The Done email is the one message a customer ever
 * gets from this app, so it is worth proving that it actually leaves the
 * building with the invoice attached — not just that nodemailer was called.
 */
function smtpSink() {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end !== -1) {
          messages.push(buffer.slice(0, end));
          buffer = '';
          inData = false;
          socket.write('250 2.0.0 Ok\r\n');
        }
        return;
      }
      let line: string;
      while (buffer.includes('\r\n') && !inData) {
        const index = buffer.indexOf('\r\n');
        line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
  });
  return {
    messages,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Undoes quoted-printable soft line breaks so assertions can match plain text. */
function unwrap(message: string): string {
  return message.replace(/=\r\n/g, '').replace(/=3D/g, '=');
}

const sink = smtpSink();
let email: typeof import('@/lib/email');
let jobs: typeof import('@/lib/jobs');
let files: typeof import('@/lib/files');

beforeAll(async () => {
  const port = await sink.listen();
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'shop@example.com';
  process.env.SMTP_PASS = 'app-password';
  process.env.MAIL_FROM = 'shop@example.com';
  process.env.SERVICE_WRITER_EMAIL = 'writer@example.com';
  // Imported only once the SMTP settings are in place — config reads the
  // environment when it is first loaded.
  email = await import('@/lib/email');
  jobs = await import('@/lib/jobs');
  files = await import('@/lib/files');
});

afterAll(async () => {
  await sink.close();
});

describe('the customer Done email', () => {
  it('carries the tracking link, the payment link and the invoice PDF', async () => {
    const job = jobs.createJob({
      id: '01-7777',
      customerName: 'Jane Rivers',
      customerEmail: 'jane@example.com',
      boatInfo: '2019 Yamaha 242X',
    });
    const invoice = await files.storeFile({
      jobId: job.id,
      kind: 'invoice',
      filename: 'invoice-01-7777.pdf',
      mime: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4 pretend invoice'),
    });
    const withInvoice = jobs.updateJob(job.id, {
      invoice_file_id: invoice.id,
      payment_link: 'https://pos.example.com/pay/xyz',
    })!;

    const sent = await email.sendJobDoneEmail(withInvoice);
    expect(sent).toBe(true);

    const message = unwrap(sink.messages.at(-1)!);
    expect(message).toContain('To: jane@example.com');
    expect(message).toContain(job.tracking_token);
    expect(message).toContain('https://pos.example.com/pay/xyz');
    expect(message).toContain('Invoice-01-7777.pdf');
    // The PDF rides along base64-encoded.
    expect(message).toContain(Buffer.from('%PDF-1.4 pretend invoice').toString('base64'));

    const log = email.listEmails(job.id);
    expect(log[0].status).toBe('sent');
  });

  it('refuses to send, and says why, when there is no address on file', async () => {
    const job = jobs.createJob({ id: '01-7778', customerName: 'No Email' });
    expect(await email.sendJobDoneEmail(job)).toBe(false);
    expect(email.listEmails(job.id)[0].error).toContain('No customer email');
  });
});

describe('the house style, copied from the winter services app', () => {
  it('sends under the shop name with replies routed to the service desk', async () => {
    const job = jobs.createJob({
      id: '01-7780',
      customerName: 'Jane Rivers',
      customerEmail: 'jane@example.com',
    });
    await email.sendJobDoneEmail(job);

    const message = unwrap(sink.messages.at(-1)!);
    expect(message).toMatch(/From: .*Quest Watersports.*<shop@example\.com>/);
    expect(message).toContain('Reply-To: service@questwatersports.com');
  });

  it('carries the wordmark inline and the shop address in the footer', async () => {
    const job = jobs.createJob({
      id: '01-7781',
      customerName: 'Jane Rivers',
      customerEmail: 'jane@example.com',
    });
    await email.sendJobDoneEmail(job);

    const message = unwrap(sink.messages.at(-1)!);
    // Attached rather than hot-linked, so it shows with remote images off.
    expect(message).toContain('Content-ID: <questlogo>');
    expect(message).toContain('cid:questlogo');
    expect(message).toContain('1851 Old Chicago Road, Ottawa, IL');
    expect(message).toContain('(815) 433-2200');
  });
});

describe('the service writer notification', () => {
  it('names the job and links straight to it', async () => {
    const job = jobs.createJob({ id: '01-7779', customerName: 'Jane Rivers' });
    const entries = await import('@/lib/entries');
    const entry = entries.createEntry({
      jobId: job.id,
      mechanicId: null,
      entryType: 'internal_note',
      text: 'Found a cracked hose clamp.',
    });

    expect(
      await email.sendEntryNotification({ job, entry, mechanicName: 'Dale', photoCount: 2 }),
    ).toBe(true);

    const message = unwrap(sink.messages.at(-1)!);
    expect(message).toContain('To: writer@example.com');
    expect(message).toContain('/admin/jobs/01-7779');
    expect(message).toContain('2 photos attached');
  });
});
