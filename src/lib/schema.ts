// The whole database, as one idempotent script. Embedded as a string rather
// than read from a .sql file so the Next server build cannot lose it in
// output-file tracing. Every statement is CREATE ... IF NOT EXISTS, so this
// runs on every boot and is a no-op after the first.
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id                        TEXT PRIMARY KEY,
  tracking_token            TEXT NOT NULL UNIQUE,
  customer_name             TEXT,
  customer_phone            TEXT,
  customer_email            TEXT,
  boat_info                 TEXT,
  status                    TEXT NOT NULL DEFAULT 'received',
  needs_review              TEXT NOT NULL DEFAULT '[]',
  work_order_file_id        TEXT,
  work_order_source_file_id TEXT,
  invoice_file_id           TEXT,
  payment_link              TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  work_started_at           TEXT,
  work_finished_at          TEXT,
  done_at                   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx  ON jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS mechanics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  job_id     TEXT REFERENCES jobs (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_job_idx ON files (job_id);

CREATE TABLE IF NOT EXISTS log_entries (
  id                     TEXT PRIMARY KEY,
  job_id                 TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  mechanic_id            TEXT REFERENCES mechanics (id),
  entry_type             TEXT NOT NULL,
  text                   TEXT,
  audio_file_id          TEXT REFERENCES files (id),
  transcript_status      TEXT,
  transcript_error       TEXT,
  assembly_transcript_id TEXT,
  part_identifier        TEXT,
  quantity               REAL,
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_entries_job_idx ON log_entries (job_id, created_at);
CREATE INDEX IF NOT EXISTS log_entries_pending_idx ON log_entries (transcript_status);

CREATE TABLE IF NOT EXISTS entry_photos (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES log_entries (id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL REFERENCES files (id),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_photos_entry_idx ON entry_photos (entry_id, position);

CREATE TABLE IF NOT EXISTS status_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_events_job_idx ON status_events (job_id, created_at);

CREATE TABLE IF NOT EXISTS email_log (
  id         TEXT PRIMARY KEY,
  job_id     TEXT REFERENCES jobs (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_log_job_idx ON email_log (job_id, created_at DESC);
`;
