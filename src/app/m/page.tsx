'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InstallPrompt } from './components/InstallPrompt';
import { Scanner } from './components/Scanner';
import { tokenFromScan } from '@/lib/tracking';

type Stage = 'home' | 'scanning' | 'manual';
type Mechanic = { id: string; name: string } | null;

export default function MechanicHome() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('home');
  const [mechanic, setMechanic] = useState<Mechanic>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/mechanic/auth')
      .then((res) => res.json())
      .then((json) => setMechanic(json.mechanic ?? null))
      .catch(() => setMechanic(null));
  }, []);

  const open = useCallback(
    async (query: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/mechanic/lookup?${query}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not find that job.');
        router.push(`/m/job/${json.job.token}`);
      } catch (err) {
        setError((err as Error).message);
        setStage('home');
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const handleScan = useCallback(
    (value: string) => {
      const token = tokenFromScan(value);
      if (!token) {
        setError('That code is not a Quest work order. Try again, or type the invoice number.');
        setStage('home');
        return;
      }
      void open(`scan=${encodeURIComponent(value)}`);
    },
    [open],
  );

  return (
    <main>
      <InstallPrompt />
      {mechanic && (
        <p style={{ color: '#9fc3dc', fontSize: 14, marginTop: 0 }}>
          Signed in as <b style={{ color: '#fff' }}>{mechanic.name}</b> ·{' '}
          <button
            type="button"
            className="linkbtn"
            style={{ padding: '2px 8px', fontSize: 12 }}
            onClick={async () => {
              await fetch('/api/mechanic/logout', { method: 'POST' });
              setMechanic(null);
            }}
          >
            Not you?
          </button>
        </p>
      )}

      {error && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {stage === 'home' && (
        <div className="stack">
          <button
            className="btn gold big block"
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setStage('scanning');
            }}
          >
            Scan work order
          </button>
          <button
            className="btn ghost big block"
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setStage('manual');
            }}
          >
            Type invoice number instead
          </button>
          {busy && <p style={{ color: '#9fc3dc' }}>Looking that job up…</p>}
          <p style={{ color: '#9fc3dc', fontSize: 14, lineHeight: 1.5 }}>
            Scan the QR code printed on the paper work order. Scanning starts the job — you will be
            asked for your PIN next.
          </p>
        </div>
      )}

      {stage === 'scanning' && (
        <div className="stack">
          <Scanner mode="qr" onResult={handleScan} hint="Line up the QR code on the work order" />
          <button className="btn ghost block" type="button" onClick={() => setStage('home')}>
            Cancel
          </button>
          <button className="btn ghost block" type="button" onClick={() => setStage('manual')}>
            Type invoice number instead
          </button>
        </div>
      )}

      {stage === 'manual' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) void open(`code=${encodeURIComponent(code.trim())}`);
          }}
        >
          <h2>Invoice number</h2>
          <input
            className="txt mono"
            inputMode="text"
            autoFocus
            placeholder="01-8886"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="hint">It is printed at the top of the work order, next to the QR code.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn navy" type="submit" disabled={busy || !code.trim()}>
              {busy ? 'Looking…' : 'Open job'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setStage('home')}>
              Back
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
