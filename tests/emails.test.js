import { describe, expect, it } from 'vitest';
import { emailList, joinEmails } from '../assets/lib/emails.js';

describe('several addresses on one job', () => {
  it('reads a stored list back one line at a time', () => {
    expect(emailList('jane@example.com, mark@example.com'))
      .toEqual(['jane@example.com', 'mark@example.com']);
  });

  it('copes with whatever the writer typed between them', () => {
    // A semicolon is what somebody who has used Outlook reaches for, and a
    // trailing comma is what is left when an address is deleted by hand.
    expect(emailList('jane@example.com;mark@example.com')).toHaveLength(2);
    expect(emailList('jane@example.com , mark@example.com ,')).toHaveLength(2);
    expect(emailList('jane@example.com\nmark@example.com')).toHaveLength(2);
  });

  it('is empty when there is nothing on the job', () => {
    expect(emailList('')).toEqual([]);
    expect(emailList(null)).toEqual([]);
    expect(emailList(' , ; ')).toEqual([]);
  });

  it('joins lines back with commas, which is the only separator that sends', () => {
    expect(joinEmails(['jane@example.com', 'mark@example.com']))
      .toBe('jane@example.com, mark@example.com');
  });

  it('drops the blank lines nobody filled in', () => {
    expect(joinEmails(['jane@example.com', '', '   ', 'mark@example.com']))
      .toBe('jane@example.com, mark@example.com');
    expect(joinEmails(['', ''])).toBe('');
  });

  it('sends to the same person once, however they were typed', () => {
    expect(joinEmails(['jane@example.com', 'Jane@Example.com']))
      .toBe('jane@example.com');
  });

  it('keeps the order they were typed in — the first line is the customer', () => {
    expect(emailList('mark@example.com, jane@example.com')[0]).toBe('mark@example.com');
  });
});
