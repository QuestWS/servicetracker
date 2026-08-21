import fs from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { absolutePath, getFile, type StoredFile } from '@/lib/files';
import { getJobByToken } from '@/lib/jobs';
import { currentMechanic, isAdmin } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * Is this file one the public tracking page is allowed to show? Only two
 * things ever qualify: a photo hanging off a customer-facing note, and the
 * final invoice once the job is Done. Internal notes, part photos and the
 * work order itself never leave the shop.
 */
function publiclyVisible(file: StoredFile, token: string): boolean {
  const job = getJobByToken(token);
  if (!job || job.id !== file.job_id) return false;

  if (file.kind === 'invoice') return job.status === 'done' && job.invoice_file_id === file.id;
  if (file.kind !== 'photo') return false;

  const row = db()
    .prepare(
      `SELECT 1 FROM entry_photos p
         JOIN log_entries e ON e.id = p.entry_id
        WHERE p.file_id = ? AND e.job_id = ? AND e.entry_type = 'customer_note'
        LIMIT 1`,
    )
    .get(file.id, job.id);
  return Boolean(row);
}

function contentDisposition(file: StoredFile): string {
  const inline = file.mime.startsWith('image/') || file.mime.startsWith('audio/') || file.mime === 'application/pdf';
  return `${inline ? 'inline' : 'attachment'}; filename="${file.filename.replace(/"/g, '')}"`;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const file = getFile(id);
  if (!file) return new NextResponse('Not found', { status: 404 });

  const token = request.nextUrl.searchParams.get('t');
  const allowed =
    (await isAdmin()) ||
    Boolean(await currentMechanic()) ||
    (token ? publiclyVisible(file, token) : false);
  if (!allowed) return new NextResponse('Not found', { status: 404 });

  const path = absolutePath(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }

  const headers = new Headers({
    'Content-Type': file.mime,
    'Content-Disposition': contentDisposition(file),
    'Cache-Control': 'private, max-age=300',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  });

  // Range support keeps Safari happy when it scrubs a voice note.
  const range = request.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (Number.isNaN(start) || start > end || start >= stat.size) {
      return new NextResponse('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` },
      });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    headers.set('Content-Length', String(end - start + 1));
    const stream = fs.createReadStream(path, { start, end });
    return new NextResponse(stream as unknown as ReadableStream, { status: 206, headers });
  }

  headers.set('Content-Length', String(stat.size));
  const stream = fs.createReadStream(path);
  return new NextResponse(stream as unknown as ReadableStream, { status: 200, headers });
}
