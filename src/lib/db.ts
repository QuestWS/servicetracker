import fs from 'node:fs';
import Database from 'better-sqlite3';
import { SCHEMA } from './schema';
import { config, dbPath, uploadsDir } from './config';

let instance: Database.Database | null = null;

/**
 * One connection for the process. better-sqlite3 is synchronous, so a single
 * handle is both the simplest and the fastest thing here — the shop runs a
 * handful of concurrent users, not a fleet.
 */
export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(SCHEMA);
  migrate(handle);
  instance = handle;
  return handle;
}

function columns(handle: Database.Database, table: string): Set<string> {
  const rows = handle.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Changes to tables that already exist somewhere. CREATE ... IF NOT EXISTS
 * cannot alter a table that is already there, so anything added or removed
 * after the first deploy is applied here, guarded by what the database
 * actually has.
 */
export function migrate(handle: Database.Database): void {
  const entryColumns = columns(handle, 'log_entries');
  if (!entryColumns.has('hours')) {
    handle.exec('ALTER TABLE log_entries ADD COLUMN hours REAL');
  }

  // Mechanics identify themselves by name now. The old PIN hashes are dead
  // credential material and are dropped rather than left lying around.
  const mechanicColumns = columns(handle, 'mechanics');
  if (mechanicColumns.has('pin_hash')) {
    handle.exec('ALTER TABLE mechanics DROP COLUMN pin_hash');
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
