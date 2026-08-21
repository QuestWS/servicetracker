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
  instance = handle;
  return handle;
}

export function nowIso(): string {
  return new Date().toISOString();
}
