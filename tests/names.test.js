import { describe, expect, it } from 'vitest';
import { byLastName, lastNameOf } from '../assets/lib/names.js';

/**
 * The writer sorts the jobs list by customer to find somebody who has rung
 * up. BiT gives us one name field, so the surname has to be read out of it,
 * and the ways that goes wrong are all visible on the shop's own list.
 */
describe('reading a surname off a work order', () => {
  it('takes the last word of an ordinary name', () => {
    expect(lastNameOf('John Purnell')).toBe('Purnell');
    expect(lastNameOf('JOHN SMITH')).toBe('SMITH');
    expect(lastNameOf('Mary-Anne van der Berg')).toBe('Berg');
  });

  it('reads a name that is already surname first', () => {
    expect(lastNameOf('Smith, John')).toBe('Smith');
    expect(lastNameOf('PURNELL, JOHN A')).toBe('PURNELL');
  });

  it('does not file a man under Jr', () => {
    expect(lastNameOf('John Purnell Jr')).toBe('Purnell');
    expect(lastNameOf('John Purnell Jr.')).toBe('Purnell');
    expect(lastNameOf('Robert Downey III')).toBe('Downey');
  });

  it('sorts a business under what it trades as, not its last word', () => {
    // "Quest Watersports LLC" belongs under Q. Under L it is unfindable.
    expect(lastNameOf('Quest Watersports LLC')).toBe('Quest Watersports LLC');
    expect(lastNameOf('Starved Rock Marina')).toBe('Starved Rock Marina');
    expect(lastNameOf('Illinois Valley Boat Co.')).toBe('Illinois Valley Boat Co.');
  });

  it('has an answer for a name that is not there', () => {
    expect(lastNameOf('')).toBe('');
    expect(lastNameOf(null)).toBe('');
    expect(lastNameOf('   ')).toBe('');
    expect(lastNameOf('Cher')).toBe('Cher');
  });
});

describe('ordering the list by it', () => {
  const sorted = (names) => names.slice().sort(byLastName);

  it('runs A to Z on the surname', () => {
    expect(sorted(['John Purnell', 'Ava Stone', 'Jane Rivers']))
      .toEqual(['John Purnell', 'Jane Rivers', 'Ava Stone']);
  });

  it('settles two of the same surname by the whole name', () => {
    expect(sorted(['John Smith', 'Ada Smith']))
      .toEqual(['Ada Smith', 'John Smith']);
  });

  it('ignores the shouting BiT does on some forms', () => {
    expect(sorted(['ava stone', 'JOHN PURNELL']))
      .toEqual(['JOHN PURNELL', 'ava stone']);
  });

  it('puts a job with no name on it at the end', () => {
    // Not a customer called nothing — a job with a field still to fill in.
    expect(sorted(['', 'Ava Stone', null])).toEqual(['Ava Stone', '', null]);
  });
});
