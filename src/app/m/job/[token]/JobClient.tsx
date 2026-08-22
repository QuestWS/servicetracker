'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ShopFeed } from '@/components/Feed';
import type { LogEntryView, EntryType } from '@/lib/entry-types';
import { SignIn } from '../../components/SignIn';
import { Scanner } from '../../components/Scanner';
import { VoiceRecorder } from '../../components/VoiceRecorder';

type JobSummary = {
  id: string;
  token: string;
  boatInfo: string | null;
  customerName: string | null;
  status: string;
  statusLabel: string;
  workOrderUrl?: string | null;
};

type Mechanic = { id: string; name: string };

const TABS: { value: EntryType; label: string }[] = [
  { value: 'customer_note', label: 'Customer' },
  { value: 'internal_note', label: 'Internal' },
  { value: 'labor', label: 'Hours' },
  { value: 'part', label: 'Part' },
];

const TAB_HELP: Record<EntryType, string> = {
  customer_note: 'The customer sees this, word for word, on their tracking page.',
  internal_note: 'Shop only. The customer never sees internal notes.',
  labor: 'Your time and what you did with it. Shop only — this is what gets billed.',
  part: 'Shop only. Parts never appear on the customer page.',
};

const HOUR_STEPS = ['0.25', '0.5', '1', '1.5', '2', '4'];

export function JobClient({ token, initialJob }: { token: string; initialJob: JobSummary }) {
  const [mechanic, setMechanic] = useState<Mechanic | null>(null);
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [checking, setChecking] = useState(true);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const [job, setJob] = useState<JobSummary>(initialJob);
  const [entries, setEntries] = useState<LogEntryView[]>([]);

  const [tab, setTab] = useState<EntryType>('customer_note');
  const [text, setText] = useState('');
  const [audio, setAudio] = useState<Blob | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [partId, setPartId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [hours, setHours] = useState('');
  const [scanningPart, setScanningPart] = useState(false);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/mechanic/jobs/${token}`);
    if (res.status === 401) {
      setMechanic(null);
      return;
    }
    if (!res.ok) return;
    const json = await res.json();
    setMechanic(json.mechanic);
    setJob(json.job);
    setEntries(json.entries);
  }, [token]);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/mechanic/auth');
      const json = await res.json();
      setRoster(json.roster ?? []);
      if (json.mechanic) {
        setMechanic(json.mechanic);
        await load();
      }
      setChecking(false);
    })();
  }, [load]);

  // A voice note lands before its transcript does; keep looking until the
  // text turns up rather than making anyone pull to refresh.
  useEffect(() => {
    if (!entries.some((entry) => entry.transcript_status === 'pending')) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [entries, load]);

  async function submitName(name: string, remember: boolean) {
    setSignInBusy(true);
    setSignInError(null);
    try {
      const res = await fetch('/api/mechanic/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, remember }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not sign you in.');
      setMechanic(json.mechanic);
      await load();
    } catch (err) {
      setSignInError((err as Error).message);
    } finally {
      setSignInBusy(false);
    }
  }

  function resetComposer() {
    setText('');
    setAudio(null);
    setPhotos([]);
    setPartId('');
    setQuantity('');
    setHours('');
    if (photoInput.current) photoInput.current.value = '';
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append('entry_type', tab);
      if (text.trim()) body.append('text', text.trim());
      if (audio) {
        const ext = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm';
        body.append('audio', audio, `voice.${ext}`);
      }
      for (const photo of photos) body.append('photos', photo);
      if (tab === 'part') {
        body.append('part_identifier', partId.trim());
        if (quantity.trim()) body.append('quantity', quantity.trim());
      }
      if (tab === 'labor') body.append('hours', hours.trim());

      const res = await fetch(`/api/mechanic/jobs/${token}/entries`, { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save that entry.');
      setEntries(json.entries);
      resetComposer();
      setNotice('Saved.');
      setTimeout(() => setNotice(null), 2500);
      void load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/mechanic/jobs/${token}/finish`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not update the job.');
      setJob({ ...job, status: json.status, statusLabel: json.statusLabel });
      setConfirmFinish(false);
      setNotice('Marked finished. The service writer takes it from here.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (checking) {
    return (
      <main>
        <p style={{ color: '#9fc3dc' }}>Opening job {initialJob.id}…</p>
      </main>
    );
  }

  if (!mechanic) {
    return (
      <main>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="kv">
            <span className="k">Job</span>
            <b style={{ fontFamily: 'var(--mono)' }}>{job.id}</b>
          </div>
          <div className="kv">
            <span className="k">Boat</span>
            <b>{job.boatInfo ?? '—'}</b>
          </div>
        </div>
        <SignIn roster={roster} onSubmit={submitName} busy={signInBusy} error={signInError} />
        <p style={{ marginTop: 14 }}>
          <Link href="/m">Back to scanning</Link>
        </p>
      </main>
    );
  }

  const said = text.trim().length > 0 || Boolean(audio);
  const canSave =
    !saving &&
    (tab === 'part'
      ? partId.trim().length > 0
      : tab === 'labor'
        ? Number(hours) > 0 && said
        : said || photos.length > 0);

  return (
    <main>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 600, color: 'var(--navy)' }}>
              {job.id}
            </div>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>
              {job.boatInfo ?? 'No boat details'}
              {job.customerName ? ` · ${job.customerName}` : ''}
            </div>
          </div>
          <span className="pill frost">{job.statusLabel}</span>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Logging as <b>{mechanic.name}</b>
        </p>
      </div>

      {notice && <div className="banner ok" style={{ marginBottom: 12 }}>{notice}</div>}
      {error && <div className="banner warn" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Add to the log</h2>
        <div className="segmented" style={{ marginBottom: 12 }}>
          {TABS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={tab === entry.value ? 'on' : ''}
              onClick={() => setTab(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 0 }}>{TAB_HELP[tab]}</p>

        {tab === 'labor' && (
          <>
            <label className="fld" htmlFor="hours">
              Hours on this job
            </label>
            <input
              className="txt mono"
              id="hours"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="1.5"
            />
            <div className="hourchips">
              {HOUR_STEPS.map((step) => (
                <button key={step} type="button" onClick={() => setHours(step)}>
                  {step} h
                </button>
              ))}
            </div>
            <p className="hint">
              Log the time as you finish a stint. Several entries in a day is normal — they add up
              on the job.
            </p>
          </>
        )}

        {tab === 'part' && (
          <>
            <label className="fld" htmlFor="part_identifier">
              Part number / UPC
            </label>
            <div className="row tight" style={{ flexWrap: 'nowrap' }}>
              <input
                className="txt mono"
                id="part_identifier"
                value={partId}
                onChange={(e) => setPartId(e.target.value)}
                placeholder="Scan or type"
              />
              <button className="btn ghost sm" type="button" onClick={() => setScanningPart((v) => !v)}>
                {scanningPart ? 'Close' : 'Scan'}
              </button>
            </div>
            {scanningPart && (
              <div style={{ marginTop: 10 }}>
                <Scanner
                  mode="any"
                  hint="Line up the barcode on the box"
                  onResult={(value) => {
                    setPartId(value);
                    setScanningPart(false);
                  }}
                />
              </div>
            )}
            <label className="fld" htmlFor="quantity">
              Quantity (optional)
            </label>
            <input
              className="txt mono"
              id="quantity"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1"
            />
          </>
        )}

        <label className="fld" htmlFor="text">
          {tab === 'part'
            ? 'Note about this part (optional)'
            : tab === 'labor'
              ? 'What you did with that time — type it or say it'
              : 'Note'}
        </label>
        <textarea
          className="txt"
          id="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            tab === 'customer_note'
              ? 'What should the customer know?'
              : tab === 'labor'
                ? 'Pulled and reset the impeller housing, re-torqued the mounts…'
                : 'What did you find or do?'
          }
        />

        <div style={{ marginTop: 12 }}>
          <VoiceRecorder
            recording={audio}
            onRecorded={setAudio}
            onClear={() => setAudio(null)}
            disabled={saving}
            label={tab === 'labor' ? 'Say what you did' : 'Record a voice note'}
          />
          <p className="hint">
            {tab === 'labor'
              ? 'Talk instead of typing and we will type it up — the hours still go in above. The recording is kept on the job.'
              : 'Speak it and we will type it up. The recording is kept on the job either way.'}
          </p>
        </div>

        <label className="fld" htmlFor="photos">
          Photos
        </label>
        <input
          className="txt"
          id="photos"
          ref={photoInput}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => setPhotos(Array.from(e.currentTarget.files ?? []))}
        />
        {photos.length > 0 && (
          <div className="thumbrow">
            {photos.map((photo, index) => (
              <figure key={`${photo.name}-${index}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={URL.createObjectURL(photo)} alt="" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => setPhotos((list) => list.filter((_, i) => i !== index))}
                >
                  ✕
                </button>
              </figure>
            ))}
          </div>
        )}

        <button
          className="btn navy big block"
          type="button"
          style={{ marginTop: 16 }}
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save entry'}
        </button>
      </section>

      <section className="card" style={{ marginBottom: 14 }}>
        <h2>Job log ({entries.length})</h2>
        <ShopFeed entries={entries} />
      </section>

      {job.status !== 'work_finished' && job.status !== 'done' ? (
        <section className="card">
          <h2>When you are done</h2>
          {confirmFinish ? (
            <>
              <p style={{ fontSize: 15 }}>
                Mark {job.id} finished? This tells the service writer the boat is physically done and
                ready to be written up in BiT.
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn green" type="button" disabled={saving} onClick={() => void finish()}>
                  Yes, work finished
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirmFinish(false)}>
                  Not yet
                </button>
              </div>
            </>
          ) : (
            <button className="btn green big block" type="button" onClick={() => setConfirmFinish(true)}>
              Work finished
            </button>
          )}
        </section>
      ) : (
        <div className="banner ok">
          Marked finished. You can still add notes if something else comes up.
        </div>
      )}

      <p style={{ marginTop: 18 }}>
        <Link href="/m">Scan another work order</Link>
      </p>
    </main>
  );
}
