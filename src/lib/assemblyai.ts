import { config } from './config';
import {
  setTranscriptFailed,
  setTranscriptPending,
  setTranscriptText,
  pendingTranscripts,
} from './entries';
import { getFile, readFileBytes } from './files';

const BASE = 'https://api.assemblyai.com/v2';

function headers(): Record<string, string> {
  return { authorization: config.assemblyAiKey };
}

async function uploadAudio(bytes: Buffer): Promise<string> {
  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`AssemblyAI upload failed (${res.status})`);
  const json = (await res.json()) as { upload_url?: string };
  if (!json.upload_url) throw new Error('AssemblyAI upload returned no URL');
  return json.upload_url;
}

async function requestTranscript(audioUrl: string): Promise<string> {
  const res = await fetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      punctuate: true,
      format_text: true,
      language_code: 'en_us',
    }),
  });
  if (!res.ok) throw new Error(`AssemblyAI transcript request failed (${res.status})`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('AssemblyAI transcript request returned no id');
  return json.id;
}

type TranscriptState = { status: string; text?: string | null; error?: string | null };

async function fetchTranscript(id: string): Promise<TranscriptState> {
  const res = await fetch(`${BASE}/transcript/${id}`, { headers: headers() });
  if (!res.ok) throw new Error(`AssemblyAI poll failed (${res.status})`);
  return (await res.json()) as TranscriptState;
}

const POLL_MS = 4000;
const MAX_POLLS = 150; // ~10 minutes; longer than any note a mechanic dictates.

async function pollUntilDone(entryId: string, transcriptId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let state: TranscriptState;
    try {
      state = await fetchTranscript(transcriptId);
    } catch (error) {
      // Network blip: keep polling, the transcript is still queued upstream.
      if (attempt === MAX_POLLS - 1) {
        setTranscriptFailed(entryId, (error as Error).message);
      }
      continue;
    }
    if (state.status === 'completed') {
      setTranscriptText(entryId, state.text ?? '');
      return;
    }
    if (state.status === 'error') {
      setTranscriptFailed(entryId, state.error ?? 'Transcription failed');
      return;
    }
  }
  setTranscriptFailed(entryId, 'Transcription timed out');
}

/**
 * Kicks off transcription for a voice entry and returns immediately — the
 * mechanic never waits on the network. The raw audio stays on disk either
 * way; the transcript is filled in underneath the entry when it lands, and
 * the job screen polls for it.
 */
export function transcribeInBackground(entryId: string, audioFileId: string): void {
  if (!config.assemblyAiKey) {
    setTranscriptFailed(entryId, 'ASSEMBLYAI_API_KEY is not configured');
    return;
  }
  void (async () => {
    try {
      const file = getFile(audioFileId);
      if (!file) throw new Error('Audio file missing');
      const bytes = await readFileBytes(file);
      const uploadUrl = await uploadAudio(bytes);
      const transcriptId = await requestTranscript(uploadUrl);
      setTranscriptPending(entryId, transcriptId);
      await pollUntilDone(entryId, transcriptId);
    } catch (error) {
      setTranscriptFailed(entryId, (error as Error).message);
    }
  })();
}

/**
 * Re-attaches to transcripts that were in flight when the server last stopped.
 * Called once at boot, so a restart mid-transcription is not a lost note.
 */
export function resumePendingTranscripts(): void {
  if (!config.assemblyAiKey) return;
  for (const entry of pendingTranscripts()) {
    if (!entry.assembly_transcript_id) continue;
    void pollUntilDone(entry.id, entry.assembly_transcript_id);
  }
}
