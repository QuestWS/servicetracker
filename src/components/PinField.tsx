'use client';

import { useState } from 'react';

/**
 * PINs are typed here and never displayed back afterwards, so there is no
 * moment where a PIN sits in a URL or a page the shop leaves open.
 */
export function PinField({
  id = 'pin',
  label = 'PIN (4–6 digits)',
}: {
  id?: string;
  label?: string;
}) {
  const [value, setValue] = useState('');

  return (
    <>
      <label className="fld" htmlFor={id}>
        {label}
      </label>
      <div className="row tight" style={{ flexWrap: 'nowrap' }}>
        <input
          className="txt mono"
          id={id}
          name="pin"
          inputMode="numeric"
          pattern="\d{4,6}"
          maxLength={6}
          required
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => {
            const bytes = new Uint32Array(1);
            crypto.getRandomValues(bytes);
            setValue(String(bytes[0] % 10000).padStart(4, '0'));
          }}
        >
          Generate
        </button>
      </div>
    </>
  );
}
