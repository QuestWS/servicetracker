# Making logging faster

Written 26 Aug 2026, to be picked up cold. Everything here is measured, and
`tools/bench-reads.mjs` reproduces the measurement — run it before and after
each change so the claim is evidence rather than an opinion.

## What is actually slow

A Sheet has no index. `rows_()` does `getDataRange().getValues()` — the entire
tab — and `_rowCache` is per-execution, so **every web request starts cold**.
Cell reads per request is the number that grows every week the shop uses it.

(Written believing that was also the number that decides how the app feels. It
is not, at the size the shop is at today — see "the second pass" below, which
is where the round trips got counted.)

```
node tools/bench-reads.mjs 400 8      # 400 jobs, 3,200 log entries

  addEntry (hours)                 reads  2   cells   64058   writes  1
  addEntry (part + order line)     reads  2   cells   64075   writes  2
  jobForMechanic (open a job)      reads  3   cells   64086   writes  0
  listJobs (writer jobs list)      reads  2   cells   64075   writes  0
  getJob (writer job page)         reads  5   cells   70502   writes  0
  openJobs (mechanic job list)     reads  1   cells    9624   writes  0
```

**64,000 cells read to append one row.** At 40 jobs it is 6,458 — exactly
linear. It is not just slow, it gets slower.

Not measured: Apps Script's own per-request overhead. The sandbox this was
written in cannot reach `script.google.com`. Best guess 0.3–1.5s warm, worse
cold, but treat that as unmeasured until step 0 lands.

## Decision already taken

Stay on Apps Script + Pages for now. A small server would be $5–15/month and
roughly 10–30× faster per call, and it stays on the table — but it brings
backups, TLS, monitoring and someone on call at 7pm Saturday, and it loses the
Sheet as a thing the shop can just open and read. Do the cheap wins first and
re-decide with real numbers.

Worth knowing if that day comes: **printed QR codes survive a backend move.**
They encode `SITE_URL` (the Pages site), not the `/exec` URL. Only `API_URL`
in `assets/lib/config.js` changes — provided the migration preserves job
tokens.

## The second pass (27 Aug 2026) — round trips, not cells

The shop came back with "still feels very slow opening a work order, and
saving is slow too". That is the sentence that says the first pass optimised
the wrong number for the size the shop is actually at.

Cells read is the number that **grows**. It is not the number that **hurts**
today. At forty jobs the whole Jobs tab is a thousand cells, and a thousand
cells cross the wire in one gulp. What costs is the number of separate trips:

- Every call to Apps Script pays start-up, an OAuth-less redirect (a POST to
  `/exec` is answered with a 302 to `googleusercontent.com`, which the phone
  then follows — two HTTP round trips for one call), and the shop's wifi.
- Inside the script, every `getValues`, `getLastRow`, `setNumberFormat` and
  `setValues` is its own round trip to Google's servers, and each costs about
  the same whether the range is one cell or ten thousand.

So `tools/bench-reads.mjs` now counts **ops** alongside cells, and the fixes
below are about trips rather than volume.

**Opening a job was two calls to Apps Script.** `lookupJob` answered with a
summary, then the phone called `jobForMechanic` for the log. Two lots of
start-up and redirect for one scan. `lookupJob` now takes the caller's token
and, when it is a signed-in mechanic's, answers with the whole job screen —
one call. An anonymous scan is unchanged, which matters: the roster is the gate
on the log and on the customer's details.

**A save read the Jobs tab twice.** Once before the lock to find the job, once
inside it to increment the totals safely. The lookup now happens inside the
lock, which is the same guarantee for one read instead of two.

**A save held the whole floor behind its photo uploads.** One script lock
serves every save in the shop, and a photo is two Drive writes — thumbnail and
full. Uploading inside the lock meant one mechanic's two photos made everybody
else's save wait on four Drive writes that had nothing to do with the
spreadsheet. Files now go to Drive before the lock is taken. A test asserts it,
and asserts the row write still happens inside.

**Where the next append goes is remembered** for the length of a request, so a
part that puts two lines on the parts list does not ask twice.

**And the part that no amount of backend work reaches: the mechanic was made
to stand and watch the round trip.** The save is optimistic now — the entry is
in the feed on the tap, the form clears, and the row settles when the answer
comes back. A failure says so in the feed with a retry, and as a toast, so
nothing is silently swallowed. Alongside it, `whatIsMissing()` says what the
backend would have refused without a call at all: forgetting the part number
costs nothing now instead of a second and a half.

**`ping`** does nothing, on purpose. The app calls it as it opens and again
when the scanner comes up, so Apps Script has a warm container by the time the
lookup arrives. It is also the cleanest reading of what an empty call costs —
watch it on the App setup page.

Measured at 400 jobs / 3,200 entries:

```
                        ops   cells        was
  addEntry (hours)        7   10,426       8 ops, 20,852 cells
  addEntry (part+order)  10   10,426      11 ops, 20,869 cells
  open a job (scanned)    3   64,888      two calls: 1 op + 3 ops
```

Not fixed, and the honest limit of this pass: **opening a job still reads
every log entry in the shop.** Three whole-tab reads, one of them LogEntries.
That is step 4 below and nothing else will move it.

What is not guesswork any more is where the time goes. Step 0 landed with
this pass: every answer carries `serverMs`, the pages time the whole round
trip, the mechanic's footer shows both, and the App setup page lists the last
dozen calls. If the round trip is four seconds and the sheet's share is half a
second, the remaining work is not in this file — it is the decision about
Apps Script.

## Where it got to (27 Aug 2026)

Steps 1, 2 and most of 3 are done. Measured the same way, 400 jobs / 3,200
entries:

```
                        before            after
  addEntry              64,058 cells      20,852   -67%
  listJobs              64,075 cells      10,426   -84%
  getJob                70,534 cells      64,928   -8%   (6 reads -> 5)
  jobForMechanic        64,086 cells      64,888   unchanged
```

`addEntry` and `listJobs` no longer read the log at all, so neither grows with
the shop any more. What is left is step 4, and it is the only thing that will
move `jobForMechanic` and `getJob`: both genuinely need every entry on the job
to draw the feed, so the fix is having fewer entries in the live tab, not
reading them more cleverly.

Two things learned in the doing, both recorded below:

- Deferring the **mail log** off `getJob` looked identical to deferring the
  timeline and was not. The page reads it to know whether the invoice has
  already gone, which is what the send button hangs off — defer it and the
  button lies until somebody clicks Show. Only the timeline moved.
- `addEntry` re-reads the Jobs row **inside** the lock before incrementing. The
  row it had was read before the lock was taken, so two mechanics saving at
  once would both write the same number and one would be lost.

## The work, in order

### 0. Instrument first — DONE

`doPost` stamps `serverMs` on every answer, success or error. `api()` in
`assets/lib/api.js` times the whole round trip and keeps the last dozen calls
in `timings`, with `onApiTiming` for anything that wants to watch. The
mechanic's footer shows the last call — `4.2s · 0.6s in the sheet` — and the
App setup page lists the recent ones with a button to time it again.

The gap between the two numbers is start-up, the redirect and the wifi. No
amount of tidying spreadsheet reads touches it, which is exactly why the
figure had to exist before any more tidying.

### 1. `addEntry` stops returning the whole log — DONE

`addEntry` ends with `entries: entriesForJob_(job.id)`, purely to hand back a
list the phone already has. That call is a full LogEntries read.

- Backend: drop `entries` from the return; keep `entry: entryView_(entry)`.
- `m/index.html` `saveEntry()`: `state.entries = result.entries` becomes a
  local insert of `result.entry`. **Check the sort order** — `entriesForJob_`
  orders the feed, so insert at the same end, and confirm `entryView_` and the
  feed renderer agree on the fields.
- Same shape applies to `addWriterNote` and `setJobAlert`, but the admin page
  re-renders through `getJob` anyway, so those are lower value.

Expect `addEntry` 2 reads → 1. Covered by the existing browser-check assertions
that a saved entry appears in the feed.

### 2. Running totals on Jobs — DONE

`listJobs` reads all 3,200 entries only to count them per job and sum hours.

- Two new Jobs columns, **on the END** (append-only rule): `entry_count`,
  `minutes_total`.
- `addEntry` increments both as it writes.
- `listJobs` stops calling `rows_('LogEntries')` entirely.
- Add `recountJobTotals_()` run from `setup()`, the same way
  `repairCoercedIds_` works — so a drifted total is repairable and the first
  run backfills existing jobs.

Expect `listJobs` ~64,000 cells → ~10,000. Needs `setup()` run once.

### 3. `getJob` stops fetching what nobody is looking at — DONE (timeline only)

`getJob` reads Jobs, LogEntries, PropRepairs, StatusEvents and EmailLog on
every open. Timeline and Email log are the two nobody reads on most visits —
fetch them on demand when the writer expands them.

### 4. Archive old log entries — the only fix that bounds the growth

Everything above shifts the curve; this one caps it. A `LogArchive` tab with
the same columns, and a sweep that moves entries belonging to jobs that are
done *and* paid *and* older than N months. `getJob` falls back to the archive
when the job is in that state; `entriesForJob_` keeps reading only the live
tab. Biggest change, least urgent, do it last.

### 5. If the round trip is still the problem — the last thing inside Apps Script

Only worth doing if the readout shows the sheet's share is the big half. In
order of how much they buy:

- **Batch the reads.** Enable the Sheets advanced service and use
  `spreadsheets.values.batchGet` to fetch Jobs, LogEntries and PropRepairs in
  ONE call instead of three. Needs `enabledAdvancedServices` in
  `appsscript.json` and a stub for it in the tests.
- **Drop `setNumberFormat` from the hot path** by formatting whole columns as
  text once in `setup()`. Saves a trip per write. Prove the format survives a
  row appended past the formatted range before trusting it — the whole reason
  cells are text is that `01-8891` becomes a date otherwise.
- **`CacheService` for a job's entries**, keyed by job id and dropped by every
  path that writes one. Real cross-execution caching, unlike `_rowCache`. The
  invalidation is the risk: a mechanic who sees a stale log will not trust the
  app again.

## Constraints that still hold

- Column order is append-only, and a new column needs `setup()` run once.
- Every cell is written as text (`setNumberFormat('@')`), because `01-8891`
  in a General cell becomes a date and the primary key stops matching.
- Any write outside `appendRow_`/`updateRow_` must call `forget_` itself.
- Nothing here may reach `/t/`. `tools/verify.sh` enforces the boundary.
- `npm run verify` before pushing; browser check on a freshly restarted
  preview server, never alongside verify.

## Still outstanding from before this plan

**`setup()` has not been run since the alert columns, the PropRepairs tab and
`archived_at` shipped.** Until it is, those features write into unnamed
columns or fail with "Run setup()." Step 2 adds two more columns to the same
run.
