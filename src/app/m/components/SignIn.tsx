'use client';

import { useState } from 'react';

/**
 * Signing in is saying who you are. There is no PIN: the app is reached from
 * the QR code on a work order already sitting in the shop, and the name is
 * there to attribute the log, not to guard it.
 *
 * The roster is offered as buttons because tapping a name on the shop iPad
 * beats typing one, and because it spells everyone the same way every time.
 * Typing is right there for anyone not on the list yet.
 */
export function SignIn({
  roster,
  onSubmit,
  busy,
  error,
}: {
  roster: { id: string; name: string }[];
  onSubmit: (name: string, remember: boolean) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [typed, setTyped] = useState('');
  const [remember, setRemember] = useState(true);
  const [typing, setTyping] = useState(roster.length === 0);

  return (
    <div className="card">
      <h2>Who is working this job?</h2>
      {error && (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {roster.length > 0 && !typing && (
        <>
          <div className="namegrid">
            {roster.map((mechanic) => (
              <button
                key={mechanic.id}
                type="button"
                disabled={busy}
                onClick={() => onSubmit(mechanic.name, remember)}
              >
                {mechanic.name}
              </button>
            ))}
          </div>
          <button
            className="btn ghost block"
            type="button"
            style={{ marginTop: 10 }}
            onClick={() => setTyping(true)}
          >
            My name is not here
          </button>
        </>
      )}

      {typing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) onSubmit(typed.trim(), remember);
          }}
        >
          <label className="fld" htmlFor="mechanic-name">
            Your name
          </label>
          <input
            className="txt"
            id="mechanic-name"
            autoFocus
            autoComplete="name"
            autoCapitalize="words"
            placeholder="Dale Hopkins"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button
            className="btn navy big block"
            type="submit"
            style={{ marginTop: 12 }}
            disabled={busy || !typed.trim()}
          >
            {busy ? 'One moment…' : 'Start logging'}
          </button>
          {roster.length > 0 && (
            <button
              className="btn ghost block"
              type="button"
              style={{ marginTop: 10 }}
              onClick={() => setTyping(false)}
            >
              Back to the list
            </button>
          )}
        </form>
      )}

      <label className="checkline">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        <span>
          Remember me on this device
          <small>Leave this off on the shop iPad — it forgets you at the end of the shift.</small>
        </span>
      </label>
    </div>
  );
}
