/**
 * Tracking tokens. Loaded by the mechanic scanner and by the customer page,
 * so it must stay dependency-free.
 */

// Crockford-ish base32: no I, L, O or U, so a token read off a printed page
// cannot be confused between 1/I or 0/O.
const TOKEN_RE = /^[0-9A-HJ-NP-TV-Z]{20}$/;

/**
 * Pulls a tracking token out of whatever the camera read. The QR on a work
 * order holds the full tracking URL, but people also paste links, retype
 * them, and occasionally scan a code that is just the token.
 *
 * GitHub Pages serves static paths only, so the customer page is
 * `/t/?j=TOKEN` rather than `/t/TOKEN` — both spellings are accepted, since
 * a work order printed under an older scheme has to keep working.
 */
export function tokenFromScan(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  const direct = text.toUpperCase();
  if (TOKEN_RE.test(direct)) return direct;

  const fromQuery = text.match(/[?&]j=([0-9A-Za-z]{20})\b/);
  if (fromQuery) {
    const candidate = fromQuery[1].toUpperCase();
    if (TOKEN_RE.test(candidate)) return candidate;
  }

  const fromPath = text.match(/\/t\/([0-9A-Za-z]{20})(?:[/?#]|$)/);
  if (fromPath) {
    const candidate = fromPath[1].toUpperCase();
    if (TOKEN_RE.test(candidate)) return candidate;
  }
  return null;
}

/** True when the text looks like a hand-typed BiT invoice number. */
export function looksLikeInvoiceNumber(raw) {
  return /^[0-9A-Za-z-]{3,16}$/.test(String(raw == null ? '' : raw).trim());
}

/** The URL printed as a QR code on the work order. */
export function trackingUrl(siteUrl, token) {
  return `${String(siteUrl).replace(/\/+$/, '')}/t/?j=${token}`;
}
