import crypto from 'node:crypto';

// Crockford-ish base32: no I, L, O or U, so a token read aloud or typed off a
// printed page cannot be confused between 1/I, 0/O.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Internal row id. Sortable-ish (time prefix) and collision-free in practice. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomString(10).toLowerCase()}`;
}

/**
 * The public tracking token. 20 base32 characters is ~100 bits: the customer
 * page has no login, so the URL itself is the credential and must not be
 * enumerable.
 */
export function newTrackingToken(): string {
  return randomString(20);
}

export function randomPin(): string {
  // 4 digits, uniformly distributed.
  let pin = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 4; i++) pin += (bytes[i] % 10).toString();
  return pin;
}
