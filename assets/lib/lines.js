/**
 * Line reconstruction from positioned PDF text runs.
 *
 * Items arrive as {str, x, y, width, height} in PDF user space (origin at the
 * bottom left). BiT's PDFs put each label and value in a separate run, so
 * nothing useful survives without this step.
 */
/**
 * Groups text items into visual lines. BiT's PDFs put each label and value in
 * separate text runs, so nothing useful survives without this step. Exported
 * because the parser re-runs it over a single column of a two-column page.
 */
export function groupIntoLines(items) {
  const sorted = [...items].sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  let currentY = null;
  let parts = [];

  const flush = () => {
    if (!parts.length) return;
    let line = '';
    let prev = null;
    for (const item of parts) {
      if (prev) {
        const gap = item.x - (prev.x + prev.width);
        // A run that starts more than a space-width after the previous one is
        // a new column, not a continuation of the same word.
        if (gap > 1.2 && !line.endsWith(' ')) line += ' ';
      }
      line += item.str;
      prev = item;
    }
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(trimmed);
    parts = [];
  };

  for (const item of sorted) {
    if (!item.str.trim()) continue;
    if (currentY === null || Math.abs(item.y - currentY) <= 2.5) {
      currentY = currentY === null ? item.y : currentY;
      parts.push(item);
    } else {
      flush();
      currentY = item.y;
      parts.push(item);
    }
  }
  flush();
  return lines;
}
