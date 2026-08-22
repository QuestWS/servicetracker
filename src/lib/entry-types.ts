/**
 * Entry shapes and labels, kept free of any database import so the mechanic
 * app and the feed components can use them in the browser.
 */
export const ENTRY_TYPES = ['customer_note', 'internal_note', 'labor', 'part'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export function isEntryType(value: string): value is EntryType {
  return (ENTRY_TYPES as readonly string[]).includes(value);
}

export const ENTRY_LABEL: Record<EntryType, string> = {
  customer_note: 'Customer note',
  internal_note: 'Internal note',
  labor: 'Labor',
  part: 'Part',
};

/**
 * Labor and parts are shop bookkeeping — the numbers the service writer
 * re-keys into BiT. Like part numbers, hours never reach the customer page.
 */
export const INTERNAL_ONLY: EntryType[] = ['internal_note', 'labor', 'part'];

/** Formats hours the way the shop says them: 1.5 h, 0.25 h, 2 h. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} h`;
}

export type LogEntryRow = {
  id: string;
  job_id: string;
  mechanic_id: string | null;
  entry_type: EntryType;
  text: string | null;
  audio_file_id: string | null;
  transcript_status: 'pending' | 'done' | 'failed' | null;
  transcript_error: string | null;
  assembly_transcript_id: string | null;
  part_identifier: string | null;
  quantity: number | null;
  hours: number | null;
  created_at: string;
};

export type EntryPhoto = { id: string; url: string };

export type LogEntryView = Omit<LogEntryRow, 'audio_file_id'> & {
  mechanic_name: string | null;
  audio_url: string | null;
  photos: EntryPhoto[];
};
