/**
 * More than one address on a job.
 *
 * A boat with two owners, a wife who does the paying, a fleet manager who
 * wants a copy of everything — the shop wanted to list them all rather than
 * pick one. They live in the job's one email cell, comma separated, and are
 * typed one to a line in the portal so nobody has to get the punctuation
 * right at a counter with a customer waiting.
 *
 * Splitting on commas, semicolons AND whitespace is what makes that true:
 * a pair pasted out of Outlook, a stray trailing comma and a line typed with
 * a space after it all come apart the same way. Joining always puts a comma
 * back, because a comma is the only separator GmailApp's recipient field
 * accepts — a semicolon fails the whole send, taking the address that was
 * spelled correctly with it.
 *
 * Imports nothing, so the portal and the tests can both use it.
 */

/** The addresses in a stored value, in order, first spelling of each kept. */
export function emailList(value) {
  const seen = new Set();
  return String(value || '').split(/[,;\s]+/).filter((address) => {
    if (!address) return false;
    // Case-insensitively, because addresses are, and because the shop
    // re-typing one with a capital should not mean sending it twice.
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What goes in the cell: the lines from the portal as one stored value. */
export function joinEmails(list) {
  return emailList((list || []).join(',')).join(', ');
}
