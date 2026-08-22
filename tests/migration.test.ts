import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '@/lib/db';

/**
 * The shape the database had when mechanics signed in with a PIN and nobody
 * logged hours. An install that already exists has to come forward without
 * losing anything.
 */
const OLD_SCHEMA = `
CREATE TABLE mechanics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE log_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  mechanic_id TEXT,
  entry_type TEXT NOT NULL,
  text TEXT,
  audio_file_id TEXT,
  transcript_status TEXT,
  transcript_error TEXT,
  assembly_transcript_id TEXT,
  part_identifier TEXT,
  quantity REAL,
  created_at TEXT NOT NULL
);
`;

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe('upgrading a database from the PIN era', () => {
  it('drops the dead PIN hashes and keeps the people', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare('INSERT INTO mechanics VALUES (?, ?, ?, 1, ?)').run(
      'mech_1',
      'Dale',
      'scrypt$deadbeef$cafe',
      '2026-01-01T00:00:00.000Z',
    );

    migrate(db);

    expect(columns(db, 'mechanics')).not.toContain('pin_hash');
    const dale = db.prepare('SELECT name, active FROM mechanics WHERE id = ?').get('mech_1');
    expect(dale).toEqual({ name: 'Dale', active: 1 });
  });

  it('adds the hours column without touching the entries already logged', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    db.prepare(
      `INSERT INTO log_entries (id, job_id, entry_type, text, created_at)
       VALUES ('log_1', '01-8886', 'internal_note', 'Impeller was shot.', '2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    expect(columns(db, 'log_entries')).toContain('hours');
    const entry = db.prepare('SELECT text, hours FROM log_entries WHERE id = ?').get('log_1');
    expect(entry).toEqual({ text: 'Impeller was shot.', hours: null });
  });

  it('is safe to run again on a database that is already current', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(columns(db, 'log_entries').filter((c) => c === 'hours')).toHaveLength(1);
  });
});
