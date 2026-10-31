import { describe, it, expect } from 'vitest';
import { matchesSearch, phoneKey } from '../assets/lib/search.js';

const job = ['01-8891', 'Jane Rivers', 'jane@example.com', '2019 Yamaha 242X', '(815) 555-0142'];
const finds = (q) => matchesSearch(job, q, '(815) 555-0142');

describe('searching for a customer', () => {
  it('finds them by whatever they say first', () => {
    ['', 'jane', 'Jane Rivers', 'rivers jane', 'rivers, jane', 'yamaha rivers', 'jane@example',
      '815-555-0142', '8155550142', '(815) 555 0142', '555-0142', '01-8891', '8891'].forEach((q) => {
      expect(finds(q), q).toBe(true);
    });
  });

  it('does not find somebody else', () => {
    ['jane smith', '555-9999', 'sea ray'].forEach((q) => expect(finds(q), q).toBe(false));
  });

  it('compares phone numbers on their last ten digits', () => {
    expect(phoneKey('+1 (815) 555-0142')).toBe('8155550142');
    expect(phoneKey('815.555.0142')).toBe('8155550142');
    expect(phoneKey('12')).toBe('');
  });
});
