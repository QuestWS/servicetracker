import { db, nowIso } from './db';
import { newId } from './ids';
import { fileUrl } from './files';
import { mechanicNames } from './mechanics';
import {
  type EntryPhoto,
  type EntryType,
  type LogEntryRow,
  type LogEntryView,
} from './entry-types';

export * from './entry-types';

export function createEntry(input: {
  jobId: string;
  mechanicId: string | null;
  entryType: EntryType;
  text?: string | null;
  audioFileId?: string | null;
  transcriptStatus?: 'pending' | 'done' | 'failed' | null;
  partIdentifier?: string | null;
  quantity?: number | null;
  photoFileIds?: string[];
}): LogEntryRow {
  const at = nowIso();
  const row: LogEntryRow = {
    id: newId('log'),
    job_id: input.jobId,
    mechanic_id: input.mechanicId,
    entry_type: input.entryType,
    text: input.text?.trim() || null,
    audio_file_id: input.audioFileId ?? null,
    transcript_status: input.transcriptStatus ?? null,
    transcript_error: null,
    assembly_transcript_id: null,
    // A part is always internal, so its identifier never reaches the customer
    // feed regardless of what the caller passed for entry_type.
    part_identifier: input.entryType === 'part' ? (input.partIdentifier ?? null) : null,
    quantity: input.entryType === 'part' ? (input.quantity ?? null) : null,
    created_at: at,
  } as LogEntryRow;

  const insert = db().prepare(
    `INSERT INTO log_entries (id, job_id, mechanic_id, entry_type, text, audio_file_id,
                              transcript_status, transcript_error, assembly_transcript_id,
                              part_identifier, quantity, created_at)
     VALUES (@id, @job_id, @mechanic_id, @entry_type, @text, @audio_file_id,
             @transcript_status, @transcript_error, @assembly_transcript_id,
             @part_identifier, @quantity, @created_at)`,
  );
  const insertPhoto = db().prepare(
    `INSERT INTO entry_photos (id, entry_id, file_id, position, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db().transaction(() => {
    insert.run(row as unknown as Record<string, unknown>);
    (input.photoFileIds ?? []).forEach((fileId, index) => {
      insertPhoto.run(newId('ph'), row.id, fileId, index, at);
    });
  })();
  return row;
}

function photosByEntry(entryIds: string[]): Map<string, EntryPhoto[]> {
  const out = new Map<string, EntryPhoto[]>();
  if (!entryIds.length) return out;
  const placeholders = entryIds.map(() => '?').join(',');
  const rows = db()
    .prepare(
      `SELECT entry_id, file_id FROM entry_photos
        WHERE entry_id IN (${placeholders}) ORDER BY position ASC`,
    )
    .all(...entryIds) as { entry_id: string; file_id: string }[];
  for (const row of rows) {
    const list = out.get(row.entry_id) ?? [];
    list.push({ id: row.file_id, url: fileUrl(row.file_id) });
    out.set(row.entry_id, list);
  }
  return out;
}

function toView(rows: LogEntryRow[]): LogEntryView[] {
  const photos = photosByEntry(rows.map((r) => r.id));
  const names = mechanicNames();
  return rows.map(({ audio_file_id, ...rest }) => ({
    ...rest,
    mechanic_name: rest.mechanic_id ? (names.get(rest.mechanic_id) ?? 'Unknown') : null,
    audio_url: audio_file_id ? fileUrl(audio_file_id) : null,
    photos: photos.get(rest.id) ?? [],
  }));
}

/** The complete log — internal notes, customer notes and parts together. */
export function listEntries(jobId: string): LogEntryView[] {
  const rows = db()
    .prepare('SELECT * FROM log_entries WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId) as LogEntryRow[];
  return toView(rows);
}

/**
 * The customer's feed: customer notes and their photos, nothing else, ever.
 * A voice note still transcribing has no text yet and no photos, so it stays
 * out of the feed until AssemblyAI comes back rather than showing a blank row.
 */
export function listCustomerEntries(jobId: string, publicToken: string): LogEntryView[] {
  const rows = db()
    .prepare(
      `SELECT * FROM log_entries
        WHERE job_id = ? AND entry_type = 'customer_note'
        ORDER BY created_at ASC`,
    )
    .all(jobId) as LogEntryRow[];
  return toView(rows)
    .filter((entry) => Boolean(entry.text) || entry.photos.length > 0)
    .map((entry) => ({
      ...entry,
      // The customer sees what was said and when, not who logged it or how.
      audio_url: null,
      transcript_error: null,
      assembly_transcript_id: null,
      // The tracking token is the customer's only credential, so it has to
      // travel with each photo request.
      photos: entry.photos.map((photo) => ({
        ...photo,
        url: `${photo.url}?t=${encodeURIComponent(publicToken)}`,
      })),
    }));
}

export function getEntry(id: string): LogEntryRow | null {
  return (db().prepare('SELECT * FROM log_entries WHERE id = ?').get(id) as LogEntryRow) ?? null;
}

export function setTranscriptPending(entryId: string, assemblyId: string): void {
  db()
    .prepare(
      "UPDATE log_entries SET transcript_status = 'pending', assembly_transcript_id = ? WHERE id = ?",
    )
    .run(assemblyId, entryId);
}

export function setTranscriptText(entryId: string, text: string): void {
  db()
    .prepare(
      "UPDATE log_entries SET text = ?, transcript_status = 'done', transcript_error = NULL WHERE id = ?",
    )
    .run(text.trim(), entryId);
}

export function setTranscriptFailed(entryId: string, error: string): void {
  db()
    .prepare("UPDATE log_entries SET transcript_status = 'failed', transcript_error = ? WHERE id = ?")
    .run(error.slice(0, 500), entryId);
}

/** Entries whose transcription was in flight when the process last stopped. */
export function pendingTranscripts(): LogEntryRow[] {
  return db()
    .prepare("SELECT * FROM log_entries WHERE transcript_status = 'pending'")
    .all() as LogEntryRow[];
}

export function countEntries(jobId: string): number {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM log_entries WHERE job_id = ?')
    .get(jobId) as { n: number };
  return row.n;
}
