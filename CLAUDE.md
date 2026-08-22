# Quest Watersports Service Tracker — working notes

Read [README.md](README.md) first for what this is and how the shop uses it.
This file is the short list of things that are easy to get wrong.

## Hard rules

1. **BiT is never integrated with.** No scraping, no automation, no API calls,
   no matter how convenient. Every exchange is a person downloading a PDF from
   BiT and uploading it here, or re-keying data from here into BiT.
2. **No code, database or infrastructure is shared with
   `QuestWS/winter-quotes_26-27`.** The house style was copied on purpose; do
   not turn that into an import, a submodule or a shared deployment.
3. **The customer sees customer notes and nothing else.** Internal notes,
   labor hours, part numbers, quantities, mechanic names and pricing never
   reach `/t/<token>`, at any status. The filter lives in `listCustomerEntries` and in
   `publiclyVisible` in the file route — both are covered by tests. If a new
   field is added to a log entry, decide its visibility there, not in a
   template.
4. **`APP_URL` is printed onto paper.** Changing it after work orders are in
   the folder invalidates every QR code already printed. If the host must
   change, the old host has to keep redirecting `/t/*`.

## Shape of the thing

```
src/lib/          domain + storage; anything importing db.ts is server-only
src/lib/pdf/      lines.ts and parse-work-order.ts are pure (browser-safe);
                  extract.ts and stamp.ts are node-only
src/app/admin/    service writer portal (password → cookie session)
src/app/m/        mechanic PWA (PIN → cookie session)
src/app/t/        public customer page (tracking token is the only credential)
src/app/api/      every mutation; pages read the database directly
scripts/lib/      shared with tests: png.mjs (icon codec), sample-work-order.mjs
```

Two rules keep the client bundle honest: a module that imports `db.ts` can
never be imported from a `'use client'` file, and shared value exports (entry
labels, tracking-token parsing) live in `entry-types.ts`, `tracking.ts` and
`pdf/lines.ts`, which import nothing from node.

## Data model notes

Follows the spec's starting point with two deliberate changes:

- `LogEntry.photo_url` became a `entry_photos` table — the spec asks for photos
  (plural) on any entry.
- A fourth entry type, `labor`, carries `hours` plus the description of what
  the time went on. Like `part`, it is internal-only; `createEntry` pins
  `hours` to null for every other type so the figure cannot ride along on a
  customer note.
- `Mechanic.pin` is gone. Mechanics identify themselves by name, and names are
  unique (case-insensitively) because the name is the whole of the identity.
- Files are rows in `files` and are served only through `/api/files/[id]`, so
  access control has exactly one home. `audio_url` and `photos[].url` in API
  responses point there.

## Schema changes

`SCHEMA` is all `CREATE ... IF NOT EXISTS`, which cannot alter a table that
already exists. Anything added or removed after the first deploy goes in
`migrate()` in `db.ts`, guarded by what the database actually has, and gets a
case in `tests/migration.test.ts`.

## Facts established with the shop

- **BiT invoice numbers are never recycled.** That is what makes it safe to use
  the number as a job's primary key.
- **Hours are deliberately uncapped.** The same screen is used to work up an
  estimate, where a figure covers a whole job rather than one stint.
- **Customer email is copied from the winter services app**, down to the
  wordmark over the gold rule and the navy footer: sent under the shop name
  from the Gmail account with `Reply-To: service@questwatersports.com`. That is
  a copied convention, not shared infrastructure — this app has its own SMTP
  transport and sends nothing through the other project's Apps Script.

## Operational facts worth remembering

- One instance only. Transcript polling and the PIN rate limiter are in-process,
  and SQLite wants a single writer.
- HTTPS or the scanner does not start — browsers block camera access on plain
  HTTP outside `localhost`.
- Missing SMTP or AssemblyAI credentials never fail a save. The entry is stored,
  the audio kept, and the skipped email recorded with its reason in the job's
  email log.
- Nothing is queued offline in the mechanic app. A mechanic must know whether
  their note landed, so a failed save shows an error rather than a false
  "saved".

## Before you push

```bash
npm run typecheck && npm test && npm run build
```

`npm run sample-work-order` writes a BiT-shaped practice PDF for exercising
intake by hand.
