/**
 * Shared between the server and the scanner in the browser, so it must stay
 * free of node imports.
 */
const TOKEN_RE = /^[0-9A-HJ-NP-TV-Z]{20}$/;

/**
 * Pulls a tracking token out of whatever the camera read. The QR on a work
 * order holds the full tracking URL, but people also paste links, retype
 * them, and occasionally scan a code that is just the token.
 */
export function tokenFromScan(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const direct = text.toUpperCase();
  if (TOKEN_RE.test(direct)) return direct;

  const fromPath = text.match(/\/t\/([0-9A-Za-z]{20})(?:[/?#]|$)/);
  if (fromPath) {
    const candidate = fromPath[1].toUpperCase();
    if (TOKEN_RE.test(candidate)) return candidate;
  }
  return null;
}

/** True when the text looks like a hand-typed BiT invoice number. */
export function looksLikeInvoiceNumber(raw: string): boolean {
  return /^[0-9A-Za-z-]{3,16}$/.test(raw.trim());
}
