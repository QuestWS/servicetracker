---
name: backend-data
description: Working inside service-tracker.gs — the sheet schema and column rules, plain-text cells, the row cache, locking, Drive file storage, transcripts, and everything about why saving is slow and what keeps it fast. Read before changing any read or write path in the backend.
---

# The backend, the schema, and speed

`service-tracker.gs` is the entire backend. Tabs are in the `SHEETS` constant
at the top of it — that constant is the schema, read it there rather than from
any document.

## The two rules that break things silently

**1. Column order is append-only.** `appendRow_` and `updateRow_` both index by
that array, so a new column goes on the **END** and `setup()` writes it into
the header on the next run. A column the header does not have yet reads back
empty — the feature saves and then simply does not work, with no error.

**Any deploy that adds a column, a tab or a trigger needs `setup()` run once.**
The App setup page says whether the sheet is behind and has the button.

**2. Every cell is written as plain text**, via `setNumberFormat('@')` before
`setValues`. This is not tidiness. A BiT invoice number is `01-8891`, and a
General-formatted cell turns that into *the first of January, 8891* — so the
job's primary key came back as a `Date`, every lookup by id missed, and the
portal answered *"No such job."* on a job sitting in its own list. ISO
timestamps go the same way.

`asText_` normalises any Date still in the sheet, `repairCoercedIds_` (run from
`setup()`) puts mangled ids back across all five tabs, and **the test stub
imitates the coercion** so this cannot pass tests again while failing in
production. Numbers are coerced on read, so text costs nothing.

BiT invoice numbers are **never recycled**, which is what makes the number safe
as a primary key.

## The row cache

`rows_` is memoised per execution and every write calls `forget_`. If you add a
code path that writes to a sheet without going through `appendRow_` or
`updateRow_` — `deleteRow`, say — **it must call `forget_` itself**, or every
read after it is a lie.

## Round trips are the cost, not cells

Full measurements and the remaining plan are in **[docs/FASTER.md](../../../docs/FASTER.md)**;
`tools/bench-reads.mjs` reproduces them — run it before and after any change
that claims to make things faster. It counts **ops** alongside cells, and ops
is the one to watch first.

Every call to `/exec` pays Apps Script's start-up and the redirect it answers a
POST with. Inside the script, every `getValues`, `getLastRow`,
`setNumberFormat` and `setValues` is its own trip to Google, each costing about
the same whether the range is one cell or ten thousand.

Three rules came out of counting them, and all three are load-bearing:

- **`addEntry` reads the Jobs tab once, inside the lock.** It used to read it
  before the lock to find the job and again inside to increment safely. The job
  lookup lives inside `withLock_`, after the payload checks — same guarantee,
  half the reading.
- **Files go to Drive BEFORE the lock.** One script lock serves every save in
  the shop and a photo is two Drive writes, so uploading inside it made one
  mechanic's photos everybody else's wait. The lock is for the running totals.
  A test asserts `saveFile_` runs outside it and `appendRow_` inside.
- **`updateRow_` reads the span back before writing it, and that read stays.**
  A patch of `updated_at` plus the two totals spans fourteen columns, the alert
  among them, and the writer's saves do not take the lock. Building the span
  from a row read earlier would quietly undo whatever the office saved in
  between. This looks like a removable round trip. It is not.

Other things already paid for, which will come back if undone:

- `updateRow_` writes the changed span in ONE call. It used to be one
  `setValue` per field, so a status change cost three round trips.
- `jobFolder_` is memoised, and the **folder** is link-shared once rather than
  every file inside it. Drive gives a file its parent's permissions;
  `setSharing` is slow and a photo stores two files.
- The AssemblyAI submission happens **after** the lock is released and after
  the row is written. It is a Drive read plus two calls over the wire; inside
  the lock it held up every mechanic on the floor. The row is marked `pending`,
  so the hourly sweep catches it if the submission fails.

## Derived totals

**`entry_count` and `minutes_total` on Jobs are derived**, so the jobs list and
a save never read every log entry in the shop to count one job's. `setup()`
runs `recountJobTotals_` to backfill and to put right anything that ever
drifts. A derived number nothing checks is a number that rots.

**`addEntry` re-reads the Jobs row inside the lock** before incrementing. The
row it already had was read before the lock was taken; without the re-read two
mechanics saving at once both write the same total and one is lost.

`adjustJobEntryTotals_` is the one place those totals change in either
direction — a move takes an entry off one job and puts it on another, a delete
takes it off for good.

## Entry types and fields

- A `labor` entry carries `hours` plus what the time went on. Like `part` it is
  internal-only; **`addEntry` pins `hours` to `''` for every other type** so
  the figure cannot ride along on a customer note.
- **Typed and spoken are two fields, not one.** `text` is what a person typed;
  `transcript` is what the recording said. The transcript was once only
  requested when `text` was empty, so a recording next to a typed note was
  stored and never turned into words. Every recording is transcribed now, and
  the transcript lands in its own column so it can never write over what
  somebody typed. Entries older than the column keep their words in `text` —
  which is why this was an addition and not a rename, and why anything reading
  a voice note reads both.
- Photos are `[{thumb, full}]` JSON in one cell.
- Time is stored as decimal hours but **never summed as decimals** — see the
  `mechanic-app` skill.

## Drive

Files are link-shared, matching how the shop already handles unit photos. See
the comment on `saveFile_` for what actually protects them: the id is
unguessable AND ids are only ever handed out by the rule in
`customerView_`/`publicJob`.

Photos are shrunk to ~200KB in the browser before upload. Drive is 15GB, shared
with the winter services app.
