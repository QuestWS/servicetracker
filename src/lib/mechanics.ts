import { db, nowIso } from './db';
import { newId } from './ids';
import { hashPin, verifyPin } from './session';

export type Mechanic = {
  id: string;
  name: string;
  pin_hash: string;
  active: number;
  created_at: string;
};

export type MechanicView = Omit<Mechanic, 'pin_hash'>;

export function listMechanics(includeInactive = false): MechanicView[] {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db()
    .prepare(`SELECT id, name, active, created_at FROM mechanics ${where} ORDER BY name`)
    .all() as MechanicView[];
}

export function getMechanic(id: string): MechanicView | null {
  return (
    (db()
      .prepare('SELECT id, name, active, created_at FROM mechanics WHERE id = ?')
      .get(id) as MechanicView) ?? null
  );
}

export function createMechanic(name: string, pin: string): MechanicView {
  const row = {
    id: newId('mech'),
    name: name.trim(),
    pin_hash: hashPin(pin),
    active: 1,
    created_at: nowIso(),
  };
  db()
    .prepare(
      `INSERT INTO mechanics (id, name, pin_hash, active, created_at)
       VALUES (@id, @name, @pin_hash, @active, @created_at)`,
    )
    .run(row);
  const { pin_hash: _pin, ...view } = row;
  return view;
}

export function setMechanicPin(id: string, pin: string): void {
  db().prepare('UPDATE mechanics SET pin_hash = ? WHERE id = ?').run(hashPin(pin), id);
}

export function setMechanicActive(id: string, active: boolean): void {
  db().prepare('UPDATE mechanics SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

/**
 * PIN-only sign-in: the mechanic types four digits and we find whose they are.
 * Every active row is checked even after a hit so a wrong PIN costs the same
 * time as a right one, and a PIN shared by two people identifies neither.
 */
export function authenticateByPin(pin: string): MechanicView | null {
  const rows = db().prepare('SELECT * FROM mechanics WHERE active = 1').all() as Mechanic[];
  let found: Mechanic | null = null;
  let hits = 0;
  for (const row of rows) {
    if (verifyPin(pin, row.pin_hash)) {
      hits += 1;
      found = row;
    }
  }
  if (hits !== 1 || !found) return null;
  return { id: found.id, name: found.name, active: found.active, created_at: found.created_at };
}

/** Names for the log, resolved in one query rather than per entry. */
export function mechanicNames(): Map<string, string> {
  const rows = db().prepare('SELECT id, name FROM mechanics').all() as {
    id: string;
    name: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}
