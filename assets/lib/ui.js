/** Small shared helpers. Everything user-typed goes through esc() first. */

export const $ = (id) => document.getElementById(id);

/**
 * Escape before interpolating anything into innerHTML. Notes, names and part
 * numbers are all typed by people on phones, so an apostrophe or a stray
 * angle bracket must not be able to break the markup it lands in.
 */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(message) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Chicago',
});
const DATE_ONLY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Chicago',
});

/** Shop time is Ottawa, IL — never the server's or the phone's timezone. */
export function formatDateTime(iso) {
  return iso ? DATE_TIME.format(new Date(iso)) : '—';
}

export function formatDate(iso) {
  return iso ? DATE_ONLY.format(new Date(iso)) : '—';
}

export function relativeDays(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** Turns a File into the base64 the backend stores in Drive. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Shrinks a photo before it is uploaded. A modern phone camera produces
 * 4-8 MB per shot; the shop is on cell service and the backend stores base64,
 * so a full-size original costs everyone and shows nothing extra.
 * Returns { full, thumb } as base64 JPEG.
 */
export async function preparePhoto(file, fullEdge = 1600, thumbEdge = 320) {
  const bitmap = await createImageBitmap(file);
  const draw = (edge, quality) => {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    return url.slice(url.indexOf(',') + 1);
  };
  const out = { full: draw(fullEdge, 0.82), thumb: draw(thumbEdge, 0.7) };
  bitmap.close();
  return out;
}

/**
 * Drive serves the files directly — they are stored "anyone with the link",
 * so an <img> or an <a> just works, with no round trip through Apps Script
 * and with the browser doing the caching.
 *
 * These three functions are the ONLY place these URL shapes appear. If Google
 * moves an endpoint, this is the one spot to fix.
 */
export function driveImageUrl(id, width = 1000) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
}

export function driveFileUrl(id) {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

/**
 * Kept, unused by the pages: recordings are reached through driveFileUrl and
 * Drive's own player now. The shop uses the transcript almost always, and an
 * embedded <audio> was one more thing to break — it did, silently, pointing
 * at the retired `uc?export=download` endpoint and showing 0:00 / 0:00.
 *
 * If a player ever comes back, this is the endpoint that serves bytes.
 */
export function driveDownloadUrl(id) {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`;
}

/**
 * Bytes to base64, in chunks. A work order can be several megabytes, and
 * building one intermediate string that size is a needless memory spike on
 * the shop laptop.
 */
export function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Turns base64 the backend returned back into something the page can show. */
export function dataUrl(mime, base64) {
  return `data:${mime};base64,${base64}`;
}

export function downloadBytes(base64, mime, filename) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return url;
}
