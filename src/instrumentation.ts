/**
 * Boot hook. Opens the database (creating it on first run) and re-attaches to
 * any transcript that was still in flight when the server last stopped.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { db } = await import('./lib/db');
  db();
  const { resumePendingTranscripts } = await import('./lib/assemblyai');
  resumePendingTranscripts();
}
