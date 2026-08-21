import { NextResponse, type NextRequest } from 'next/server';
import { jsonError, requireMechanic, str } from '@/lib/guards';
import { createEntry, isEntryType, listEntries } from '@/lib/entries';
import { storeFile } from '@/lib/files';
import { getJobByToken, setStatus } from '@/lib/jobs';
import { transcribeInBackground } from '@/lib/assemblyai';
import { sendEntryNotification } from '@/lib/email';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const MAX_PHOTOS = 8;

const AUDIO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
};

/**
 * Logs one entry against a job: typed or spoken, with photos, from a phone in
 * a shop. Everything is written before the response returns except the
 * transcription and the service-writer email — a mechanic standing over a
 * boat should not wait on AssemblyAI or on SMTP.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { mechanic, error } = await requireMechanic();
  if (error) return error;

  const { token } = await ctx.params;
  const job = getJobByToken(token);
  if (!job) return new NextResponse('Not found', { status: 404 });

  const form = await request.formData();
  const entryType = str(form.get('entry_type'));
  if (!entryType || !isEntryType(entryType)) return jsonError('Pick what kind of entry this is.', 400);

  const text = str(form.get('text'));
  const partIdentifier = str(form.get('part_identifier'));
  const quantityRaw = str(form.get('quantity'));
  const quantity = quantityRaw ? Number(quantityRaw) : null;
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
    return jsonError('Quantity must be a number greater than zero.', 400);
  }

  const audio = form.get('audio');
  const photos = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);

  if (entryType === 'part' && !partIdentifier) {
    return jsonError('Scan or type the part number.', 400);
  }
  const hasAudio = audio instanceof File && audio.size > 0;
  if (entryType !== 'part' && !text && !hasAudio && !photos.length) {
    return jsonError('Add a note, a recording or a photo before saving.', 400);
  }
  if (photos.length > MAX_PHOTOS) return jsonError(`Up to ${MAX_PHOTOS} photos per entry.`, 400);

  const photoFileIds: string[] = [];
  for (const photo of photos) {
    if (!photo.type.startsWith('image/')) return jsonError('Photos must be images.', 400);
    if (photo.size > MAX_PHOTO_BYTES) return jsonError('One of those photos is too large.', 400);
    const stored = await storeFile({
      jobId: job.id,
      kind: 'photo',
      filename: photo.name || 'photo.jpg',
      mime: photo.type,
      bytes: new Uint8Array(await photo.arrayBuffer()),
    });
    photoFileIds.push(stored.id);
  }

  let audioFileId: string | null = null;
  if (hasAudio) {
    const file = audio as File;
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      return jsonError('That recording is not an audio file.', 400);
    }
    if (file.size > MAX_AUDIO_BYTES) return jsonError('That recording is too long.', 400);
    const ext = AUDIO_EXT[file.type] ?? 'webm';
    const stored = await storeFile({
      jobId: job.id,
      kind: 'audio',
      filename: `voice-${Date.now()}.${ext}`,
      mime: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    audioFileId = stored.id;
  }

  const entry = createEntry({
    jobId: job.id,
    mechanicId: mechanic.id,
    entryType,
    text,
    audioFileId,
    // A voice note with no typed text is waiting on transcription; a voice
    // note attached to typed text is just a recording.
    transcriptStatus: audioFileId && !text ? 'pending' : null,
    partIdentifier,
    quantity,
    photoFileIds,
  });

  // Logging against a job that was only ever received (someone typed the
  // number instead of scanning) still means the work has started.
  if (job.status === 'received') {
    setStatus(job.id, 'work_underway', { type: 'mechanic', id: mechanic.id }, 'First log entry');
  }

  if (audioFileId && !text) transcribeInBackground(entry.id, audioFileId);

  void sendEntryNotification({
    job,
    entry,
    mechanicName: mechanic.name,
    photoCount: photoFileIds.length,
  });

  return NextResponse.json({ entry: { id: entry.id }, entries: listEntries(job.id) }, { status: 201 });
}
