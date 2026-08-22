'use client';

import { useEffect, useRef, useState } from 'react';

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (typeof MediaRecorder === 'undefined') return undefined;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Talk instead of type. The recording is kept and uploaded as-is — AssemblyAI
 * produces the text, but the audio stays on the job so anyone can hear what
 * was actually said.
 */
export function VoiceRecorder({
  recording,
  onRecorded,
  onClear,
  disabled,
  label = 'Record a voice note',
}: {
  recording: Blob | null;
  onRecorded: (blob: Blob) => void;
  onClear: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const [active, setActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const previewUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      stream.current?.getTracks().forEach((t) => t.stop());
      void audioCtx.current?.close();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  async function start() {
    setError(null);
    const mimeType = pickMimeType();
    if (typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Type the note instead.');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access was blocked. Allow it for this site, or type the note instead.');
      return;
    }

    chunks.current = [];
    const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.current.push(event.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
      if (blob.size) onRecorded(blob);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
    rec.start();
    recorder.current = rec;
    setActive(true);
    setSeconds(0);

    // A moving level bar is the only honest signal that the mic is live.
    const ctx = new AudioContext();
    audioCtx.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream.current).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const sample of data) peak = Math.max(peak, Math.abs(sample - 128));
      setLevel(Math.min(100, Math.round((peak / 128) * 260)));
      raf.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop() {
    recorder.current?.stop();
    recorder.current = null;
    setActive(false);
    cancelAnimationFrame(raf.current);
    setLevel(0);
    void audioCtx.current?.close();
    audioCtx.current = null;
  }

  if (recording) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(recording);
    return (
      <div>
        <audio controls src={previewUrl.current} style={{ width: '100%' }} />
        <button className="btn ghost sm" type="button" onClick={onClear} disabled={disabled} style={{ marginTop: 8 }}>
          Discard recording
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        className={`btn ${active ? 'danger' : 'ghost'} block`}
        type="button"
        onClick={active ? stop : () => void start()}
        disabled={disabled}
      >
        {active ? `Stop recording (${seconds}s)` : label}
      </button>
      {active && (
        <div className="reclevel">
          <i style={{ width: `${level}%` }} />
        </div>
      )}
      {error && <p className="hint" style={{ color: 'var(--warn)' }}>{error}</p>}
    </div>
  );
}
