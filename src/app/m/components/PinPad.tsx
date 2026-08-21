'use client';

import { useState } from 'react';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];

/**
 * PIN entry with a keypad of its own. Greasy hands and a phone keyboard do not
 * get along, and the shop iPad's software keyboard covers half the screen.
 */
export function PinPad({ onSubmit, busy, error }: {
  onSubmit: (pin: string) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [pin, setPin] = useState('');

  const push = (key: string) => {
    if (busy) return;
    if (key === 'clear') return setPin('');
    if (key === 'back') return setPin((p) => p.slice(0, -1));
    setPin((p) => {
      const next = (p + key).slice(0, 6);
      if (next.length === 4) {
        // Four digits is the house length; submit without a second tap, but
        // leave room for a longer PIN by not clearing the field.
        setTimeout(() => onSubmit(next), 0);
      }
      return next;
    });
  };

  return (
    <div className="card">
      <h2>Your PIN</h2>
      <div className="pindots" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={pin.length > i ? 'on' : ''} />
        ))}
      </div>
      {error && <div className="banner warn" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="pinpad">
        {KEYS.map((key) => (
          <button key={key} type="button" onClick={() => push(key)} disabled={busy}>
            {key === 'clear' ? '✕' : key === 'back' ? '⌫' : key}
          </button>
        ))}
      </div>
      {pin.length > 4 && (
        <button
          className="btn navy block"
          type="button"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={() => onSubmit(pin)}
        >
          {busy ? 'Checking…' : 'Continue'}
        </button>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        Your PIN is how the log knows whose note this is. Ask the service writer if you have
        forgotten it.
      </p>
    </div>
  );
}
