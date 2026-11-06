/**
 * A text message draft: the link that opens the phone's own Messages app with
 * the number and the wording already in, so the writer only presses send.
 *
 * Opening a draft is not sending one. Nothing leaves until a person presses
 * send in their own messaging app, and the portal's "I have sent it" stays the
 * separate act that logs it — opening the draft must never count as a send,
 * for the same reason the copy button never did.
 *
 * Imports nothing, so it runs under node and stays under test.
 *
 * The one wrinkle is the separator. Android reads `sms:NUMBER?body=`; Apple's
 * Messages (iPhone, iPad and Mac) wants `sms:NUMBER&body=` and ignores a `?`
 * body. `apple` says which.
 */

/** A US number as the dialer wants it: +1 and ten digits, or '' if it is not one. */
export function smsNumber(phone) {
  let digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length === 10 ? '+1' + digits : '';
}

/** The sms: link. A number that will not dial is left out, so the writer picks one. */
export function smsDraftUrl(phone, message, apple) {
  const number = smsNumber(phone);
  return 'sms:' + number + (apple ? '&' : '?') + 'body=' + encodeURIComponent(String(message || ''));
}

/** iPhone, iPad (which says it is a Mac, but has a touchscreen) and the Mac itself. */
export function isApple(nav) {
  const ua = String((nav && nav.userAgent) || '');
  return /iPhone|iPad|iPod|Macintosh/.test(ua);
}
