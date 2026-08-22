import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { config, requireSessionSecret } from './config';

const ADMIN_COOKIE = 'qst_admin';
const MECHANIC_COOKIE = 'qst_mech';

type Payload = Record<string, unknown> & { exp: number };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(value: string): string {
  return b64url(crypto.createHmac('sha256', requireSessionSecret()).update(value).digest());
}

function seal(payload: Payload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

function unseal(token: string | undefined): Payload | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = sign(body);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Payload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const baseCookie = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};

/* ---------------------------------------------------------------- admin --- */

export async function startAdminSession(): Promise<void> {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  (await cookies()).set(ADMIN_COOKIE, seal({ role: 'admin', exp }), {
    ...baseCookie,
    maxAge: 12 * 60 * 60,
  });
}

export async function endAdminSession(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const payload = unseal((await cookies()).get(ADMIN_COOKIE)?.value);
  return payload?.role === 'admin';
}

/**
 * Checks the typed password against ADMIN_PASSWORD without leaking its length
 * or contents through timing. An unset password locks the portal entirely
 * rather than opening it.
 */
export function checkAdminPassword(candidate: string): boolean {
  if (!config.adminPassword) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- mechanic --- */

export type MechanicSession = { id: string; name: string };

/**
 * `remember` is the checkbox on the sign-in screen: a mechanic's own phone
 * keeps them signed in for weeks, the shared shop iPad forgets them at the
 * end of the shift.
 */
export async function startMechanicSession(
  mechanic: MechanicSession,
  remember: boolean,
): Promise<void> {
  const maxAge = remember
    ? config.mechanicRememberDays * 24 * 60 * 60
    : config.mechanicSessionHours * 60 * 60;
  const exp = Date.now() + maxAge * 1000;
  (await cookies()).set(
    MECHANIC_COOKIE,
    seal({ id: mechanic.id, name: mechanic.name, exp }),
    { ...baseCookie, maxAge },
  );
}

export async function endMechanicSession(): Promise<void> {
  (await cookies()).delete(MECHANIC_COOKIE);
}

export async function currentMechanic(): Promise<MechanicSession | null> {
  const payload = unseal((await cookies()).get(MECHANIC_COOKIE)?.value);
  if (!payload || typeof payload.id !== 'string' || typeof payload.name !== 'string') return null;
  return { id: payload.id, name: payload.name };
}
