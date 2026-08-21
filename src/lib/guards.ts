import { NextResponse } from 'next/server';
import { currentMechanic, isAdmin, type MechanicSession } from './session';

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Route-handler guard for the service-writer portal. */
export async function requireAdmin(): Promise<NextResponse | null> {
  return (await isAdmin()) ? null : jsonError('Sign in to the service writer portal first.', 401);
}

/** Route-handler guard for anything that writes to a job's log. */
export async function requireMechanic(): Promise<
  { mechanic: MechanicSession; error: null } | { mechanic: null; error: NextResponse }
> {
  const mechanic = await currentMechanic();
  if (!mechanic) return { mechanic: null, error: jsonError('Enter your PIN to continue.', 401) };
  return { mechanic, error: null };
}

/** Reads a single form/JSON string field, trimmed, or null when empty. */
export function str(value: FormDataEntryValue | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
