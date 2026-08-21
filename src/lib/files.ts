import fs from 'node:fs/promises';
import path from 'node:path';
import { db, nowIso } from './db';
import { newId } from './ids';
import { uploadsDir } from './config';

export type FileKind =
  | 'work_order_source'
  | 'work_order_stamped'
  | 'invoice'
  | 'photo'
  | 'audio';

export type StoredFile = {
  id: string;
  job_id: string | null;
  kind: FileKind;
  filename: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
};

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(-80) || 'file';
}

/**
 * Writes bytes under data/uploads/<job or _unassigned>/ and records a row.
 * Everything is served back through /api/files/[id], never as a raw path, so
 * access control has exactly one place to live.
 */
export async function storeFile(input: {
  jobId: string | null;
  kind: FileKind;
  filename: string;
  mime: string;
  bytes: Uint8Array | Buffer;
}): Promise<StoredFile> {
  const id = newId('file');
  const folder = input.jobId ? input.jobId.replace(/[^A-Za-z0-9._-]/g, '_') : '_unassigned';
  const dir = path.join(uploadsDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const filename = safeName(input.filename);
  const relPath = path.join(folder, `${id}-${filename}`);
  const bytes = Buffer.from(input.bytes);
  await fs.writeFile(path.join(uploadsDir, relPath), bytes);

  const row: StoredFile = {
    id,
    job_id: input.jobId,
    kind: input.kind,
    filename,
    mime: input.mime,
    size: bytes.byteLength,
    path: relPath,
    created_at: nowIso(),
  };
  db()
    .prepare(
      `INSERT INTO files (id, job_id, kind, filename, mime, size, path, created_at)
       VALUES (@id, @job_id, @kind, @filename, @mime, @size, @path, @created_at)`,
    )
    .run(row);
  return row;
}

export function getFile(id: string): StoredFile | null {
  return (db().prepare('SELECT * FROM files WHERE id = ?').get(id) as StoredFile) ?? null;
}

export function absolutePath(file: StoredFile): string {
  return path.join(uploadsDir, file.path);
}

export function readFileBytes(file: StoredFile): Promise<Buffer> {
  return fs.readFile(absolutePath(file));
}

/** Re-parents a file written before the job existed (intake writes the PDF first). */
export function attachFileToJob(fileId: string, jobId: string): void {
  db().prepare('UPDATE files SET job_id = ? WHERE id = ?').run(jobId, fileId);
}

export function fileUrl(fileId: string): string {
  return `/api/files/${fileId}`;
}
