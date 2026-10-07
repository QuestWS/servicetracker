import { describe, expect, it } from 'vitest';
import { tokenExpiry } from '../assets/lib/api.js';

// The backend seals {role, exp} as web-safe base64 JSON, a dot, then the HMAC.
const seal = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_') + '.signature';

describe('reading when a sign-in runs out', () => {
  it('reads the expiry off a sealed token', () => {
    const exp = Date.now() + 12 * 3600000;
    expect(tokenExpiry(seal({ role: 'admin', exp }))).toBe(exp);
  });

  it('reads one whose base64 needs the web-safe alphabet', () => {
    const exp = 1791234567890;
    expect(tokenExpiry(seal({ role: 'admin', exp, pad: '>>>???' }))).toBe(exp);
  });

  it('says 0 for anything it cannot read, leaving the backend to decide', () => {
    expect(tokenExpiry('')).toBe(0);
    expect(tokenExpiry(null)).toBe(0);
    expect(tokenExpiry('not-a-token')).toBe(0);
    expect(tokenExpiry(seal({ role: 'admin' }))).toBe(0);
  });
});
