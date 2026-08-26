# Making logging faster

Written 26 Aug 2026, to be picked up cold. Everything here is measured, and
`tools/bench-reads.mjs` reproduces the measurement — run it before and after
each change so the claim is evidence rather than an opinion.

## What is actually slow

A Sheet has no index. `rows_()` does `getDataRange().getValues()` — the entire
tab — and `_rowCache` is per-execution, so **every web request starts cold**.
Cell reads per request is therefore the number that decides how the app feels,
and it grows every week the shop uses it.

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

## The work, in order

### 0. Instrument first (small, do it first)

Have `api()` in `assets/lib/api.js` time every call, and show the figure in the
portal — a corner readout, or the App setup page. Twenty minutes, and it turns
"feels slow" into a number, including the Apps Script overhead this plan could
not measure. Everything below is judged against it.

### 1. `addEntry` stops returning the whole log  — halves a save

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

### 2. Running totals on Jobs — takes LogEntries out of the jobs list

`listJobs` reads all 3,200 entries only to count them per job and sum hours.

- Two new Jobs columns, **on the END** (append-only rule): `entry_count`,
  `minutes_total`.
- `addEntry` increments both as it writes.
- `listJobs` stops calling `rows_('LogEntries')` entirely.
- Add `recountJobTotals_()` run from `setup()`, the same way
  `repairCoercedIds_` works — so a drifted total is repairable and the first
  run backfills existing jobs.

Expect `listJobs` ~64,000 cells → ~10,000. Needs `setup()` run once.

### 3. `getJob` stops fetching what nobody is looking at — 5 reads → 3

`getJob` reads Jobs, LogEntries, PropRepairs, StatusEvents and EmailLog on
every open. Timeline and Email log are the two nobody reads on most visits —
fetch them on demand when the writer expands them.

### 4. Archive old log entries — the only fix that bounds the growth

Everything above shifts the curve; this one caps it. A `LogArchive` tab with
the same columns, and a sweep that moves entries belonging to jobs that are
done *and* paid *and* older than N months. `getJob` falls back to the archive
when the job is in that state; `entriesForJob_` keeps reading only the live
tab. Biggest change, least urgent, do it last.

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
