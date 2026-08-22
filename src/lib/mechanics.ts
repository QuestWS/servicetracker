import { db, nowIso } from './db';
import { newId } from './ids';

export type Mechanic = {
  id: string;
  name: string;
  active: number;
  created_at: string;
};

/** Collapses the ways the same person types their own name. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * A name is a name, not a free-text field. Long enough to identify someone,
 * short enough to fit the log, and letters rather than a barcode someone
 * scanned into the wrong box.
 */
export function isUsableName(name: string): boolean {
  if (name.length < 2 || name.length > 40) return false;
  return /^[\p{L}][\p{L}\p{M}'’.\- ]*$/u.test(name);
}

export function listMechanics(includeInactive = false): Mechanic[] {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db()
    .prepare(`SELECT id, name, active, created_at FROM mechanics ${where} ORDER BY name`)
    .all() as Mechanic[];
}

export function getMechanic(id: string): Mechanic | null {
  return (
    (db()
      .prepare('SELECT id, name, active, created_at FROM mechanics WHERE id = ?')
      .get(id) as Mechanic) ?? null
  );
}

export function findMechanicByName(name: string): Mechanic | null {
  return (
    (db()
      .prepare('SELECT id, name, active, created_at FROM mechanics WHERE name = ? COLLATE NOCASE')
      .get(normalizeName(name)) as Mechanic) ?? null
  );
}

export function createMechanic(name: string): Mechanic {
  const row = {
    id: newId('mech'),
    name: normalizeName(name),
    active: 1,
    created_at: nowIso(),
  };
  db()
    .prepare(
      `INSERT INTO mechanics (id, name, active, created_at)
       VALUES (@id, @name, @active, @created_at)`,
    )
    .run(row);
  return row;
}

export type SignInResult =
  | { ok: true; mechanic: Mechanic; created: boolean }
  | { ok: false; reason: 'invalid' | 'inactive' };

/**
 * Sign-in is typing your name. There is no secret: the app is reached from
 * the QR code on a work order that is already sitting in the shop, and the
 * point of the name is to attribute the log, not to guard it.
 *
 * A name nobody has used before joins the roster rather than being turned
 * away — a mechanic on a job should never be stuck behind an admin screen.
 * A name the service writer has deactivated is refused, because that is a
 * decision someone made on purpose.
 */
export function signInByName(raw: string): SignInResult {
  const name = normalizeName(raw);
  if (!isUsableName(name)) return { ok: false, reason: 'invalid' };

  const existing = findMechanicByName(name);
  if (existing) {
    if (!existing.active) return { ok: false, reason: 'inactive' };
    return { ok: true, mechanic: existing, created: false };
  }
  return { ok: true, mechanic: createMechanic(name), created: true };
}

export function setMechanicActive(id: string, active: boolean): void {
  db().prepare('UPDATE mechanics SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function renameMechanic(id: string, name: string): boolean {
  const normalized = normalizeName(name);
  if (!isUsableName(normalized)) return false;
  const clash = findMechanicByName(normalized);
  if (clash && clash.id !== id) return false;
  db().prepare('UPDATE mechanics SET name = ? WHERE id = ?').run(normalized, id);
  return true;
}

/** Names for the log, resolved in one query rather than per entry. */
export function mechanicNames(): Map<string, string> {
  const rows = db().prepare('SELECT id, name FROM mechanics').all() as {
    id: string;
    name: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}
