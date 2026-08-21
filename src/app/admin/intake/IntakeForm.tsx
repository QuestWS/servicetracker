'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { CopyField } from '@/components/CopyField';
import { FIELD_LABELS, type ParsedWorkOrder } from '@/lib/pdf/parse-work-order';

type ParseResponse = {
  sourceFileId: string;
  filename: string;
  parsed: ParsedWorkOrder;
  hasTextLayer: boolean;
  duplicate: boolean;
};

type CreateResponse = {
  jobId: string;
  trackingUrl: string;
  stampedPdfUrl: string | null;
  adminUrl: string;
  needsReview: string[];
  warning?: string;
};

type Fields = {
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  boatInfo: string;
};

const EMPTY: Fields = {
  invoiceNumber: '',
  customerName: '',
  customerPhone: '',
  customerEmail: '',
  boatInfo: '',
};

export function IntakeForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parse, setParse] = useState<ParseResponse | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Fields the parser could not find keep their warning colour until typed in. */
  const missing = new Set(parse?.parsed.missing ?? []);

  async function readPdf(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('pdf', file);
      const res = await fetch('/api/admin/intake/parse', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not read that PDF.');
      const data = json as ParseResponse;
      setParse(data);
      setFields({
        invoiceNumber: data.parsed.invoiceNumber ?? '',
        customerName: data.parsed.customerName ?? '',
        customerPhone: data.parsed.customerPhone ?? '',
        customerEmail: data.parsed.customerEmail ?? '',
        boatInfo: data.parsed.boatInfo ?? '',
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createJob() {
    if (!parse) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/intake/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceFileId: parse.sourceFileId, ...fields }),
      });
      const json = await res.json();
      if (!res.ok && res.status !== 207) throw new Error(json.error ?? 'Could not create the job.');
      setCreated(json as CreateResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setParse(null);
    setCreated(null);
    setFields(EMPTY);
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  if (created) {
    return (
      <section className="card">
        <h2>Job {created.jobId} created</h2>
        <div className="banner ok" style={{ marginBottom: 14 }}>
          {created.warning ??
            'Print the stamped work order and put it in the folder exactly as you do today.'}
        </div>
        <div className="stack">
          {created.stampedPdfUrl && (
            <a className="btn navy" href={created.stampedPdfUrl} target="_blank" rel="noreferrer">
              Open print-ready work order
            </a>
          )}
          <CopyField label="Customer tracking link" value={created.trackingUrl} />
          <div className="row">
            <Link className="btn ghost" href={created.adminUrl}>
              Open the job
            </Link>
            <button className="btn ghost" type="button" onClick={reset}>
              Do another
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{parse ? 'Check what we read' : 'Upload the BiT work order'}</h2>
      {error && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!parse && (
        <>
          <label className="fld" htmlFor="pdf">
            Work order PDF
          </label>
          <input
            className="txt"
            id="pdf"
            ref={fileInput}
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void readPdf(file);
            }}
          />
          <p className="hint">
            Download the work order from BiT, then pick it here. Nothing is created until you
            confirm the details on the next step.
          </p>
          {busy && <div className="msg">Reading the PDF…</div>}
        </>
      )}

      {parse && (
        <>
          {!parse.hasTextLayer && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              That PDF has no text layer — it looks like a scan. Type the details in by hand, or
              re-download the work order straight from BiT.
            </div>
          )}
          {parse.duplicate && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              A job already exists with this invoice number. Change it, or open the existing job
              instead.
            </div>
          )}
          {parse.parsed.missing.length > 0 && (
            <div className="banner info" style={{ marginBottom: 12 }}>
              Could not find:{' '}
              {parse.parsed.missing.map((f) => FIELD_LABELS[f] ?? f).join(', ')}. Fill in what you
              can — the highlighted fields are the ones we guessed at nothing for.
            </div>
          )}

          {(
            [
              ['invoiceNumber', 'Invoice # (this becomes the job number)', 'mono'],
              ['customerName', 'Customer name', ''],
              ['customerPhone', 'Phone', ''],
              ['customerEmail', 'Email (needed for the final invoice email)', ''],
              ['boatInfo', 'Boat / engine', ''],
            ] as [keyof Fields, string, string][]
          ).map(([key, label, extra]) => (
            <div key={key}>
              <label className="fld" htmlFor={key}>
                {label}
              </label>
              <input
                className={`txt ${extra} ${missing.has(key) && !fields[key] ? 'field-flag' : ''}`}
                id={key}
                value={fields[key]}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
            </div>
          ))}

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn navy" type="button" onClick={createJob} disabled={busy || !fields.invoiceNumber}>
              {busy ? 'Working…' : 'Create job & stamp the QR code'}
            </button>
            <button className="btn ghost" type="button" onClick={reset} disabled={busy}>
              Start over
            </button>
          </div>
          <p className="hint">Read from {parse.filename}.</p>
        </>
      )}
    </section>
  );
}
