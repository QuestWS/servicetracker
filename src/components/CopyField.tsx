'use client';

import { useState } from 'react';

/** Read-only value plus a one-tap copy — used for tracking and payment links. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      {label && <label className="fld">{label}</label>}
      <div className="row tight" style={{ flexWrap: 'nowrap' }}>
        <input className="txt mono" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          className="btn ghost sm"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
