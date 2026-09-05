# Moving the Service Tracker onto a VPS

Written 5 Sep 2026, to be picked up cold by somebody planning the move. It
assumes no knowledge of this repo. Read [README.md](../README.md) for what the
tool is and [CLAUDE.md](../CLAUDE.md) for the rules that must survive the
journey; this file is about the move itself.

The short version: **this is an adapter swap, not a rewrite.** The backend
already runs under Node today — that is how the test suite and the local
preview work. What makes it a preview rather than production is nine faked
Apps Script globals. Replace those with real ones and the same backend runs on
a server.

---

## 1. What the thing is

An internal tool for Quest Watersports, a marine repair shop in Ottawa, IL.
Roughly: work orders come out of BiT (the shop's existing invoicing system, on
paper), get a QR code stamped on them, and mechanics scan that code on their
phones to log hours, parts and notes against the job. The service writer works
the other side — parts ordering, props out for repair, closing tickets and
mailing the invoice.

Scale is small and will stay small: one shop, a handful of mechanics, a few
hundred jobs a year. This is not a system that needs to scale. It is a system
that needs to be **fast enough that the guys on the floor keep using it**, and
that is the entire reason this document exists.

Four things a planner needs to know up front, because they constrain
everything:

1. **BiT is never integrated with.** No scraping, no API, no automation. Every
   exchange is a person moving a PDF by hand. This is a hard rule, not a
   current limitation.
2. **A QR code on paper cannot be recalled.** Printed work orders encode
   `SITE_URL` — the address of the static pages. Change it and every sheet
   already in the job folder stops working. See §8.
3. **There is a customer-facing boundary that is enforced by a test**, and it
   must survive the move intact. See §7.
4. **Nobody is on call.** The shop cannot have someone fixing a server at 7pm
   on a Saturday. Operational simplicity beats sophistication every time here.

---

## 2. How it runs today, and why it is slow

| Half | Runs on | Deployed by |
|---|---|---|
| Four static pages | GitHub Pages | commit to `main` |
| The backend | Google Apps Script | Actions workflow → `clasp` |
| The database | one Google Sheet | — |
| Files | Google Drive | — |
| Email | Gmail (consumer account) | — |

Everything lives in the shop's own `questwsottawa@gmail.com` account. Nothing
costs anything.

The performance problem is documented in detail in
[FASTER.md](FASTER.md), which carries the measurements. The summary:

- **A Sheet has no index.** Reading one job's log means reading every log entry
  in the shop and filtering in memory.
- **Round trips are the cost, not cells.** Inside Apps Script, every
  `getValues`, `getLastRow`, `setNumberFormat` and `setValues` is a separate
  network call to Google, each costing about the same whether the range is one
  cell or ten thousand.
- **Every request starts cold.** Apps Script boots a container to answer, and
  the in-process row cache dies with it. There is a `ping` function whose only
  job is to warm a container before the mechanic needs one.
- **A POST to `/exec` is answered with a 302** to `googleusercontent.com`,
  which the phone then follows — two HTTP round trips for one call.

Three rounds of optimisation have already happened (see FASTER.md steps 0–3).
`addEntry` is down 67%, `listJobs` 84%, and opening a job went from three
whole-tab reads to one. What is left is the platform itself.

**The app measures its own latency.** Every response carries `serverMs`, and
the browser times the whole round trip. The mechanic's footer shows both
(`4.2s · 0.6s in the sheet`) and the App setup page lists recent calls. The gap
between those two numbers is start-up, the redirect and the wifi — and that gap
is what a VPS deletes. **Read the real numbers off that page before and after;
do not take the estimates below on faith.**

---

## 3. What moving to a VPS actually buys

Per call, the change is:

| | Apps Script today | Node on a VPS |
|---|---|---|
| Container start-up | 0.3–1.5s warm, worse cold | none — process is resident |
| The 302 redirect | a second full round trip | none |
| Finding one job | whole-tab read (~10,000 cells) | indexed lookup, sub-millisecond |
| `getJob` (writer's page) | 5 whole-tab reads | 5 indexed queries, single-digit ms |
| Network | shop wifi → Google | shop wifi → your box |

A call that takes **1.5–4 seconds today should land around 30–100ms** — the
network hop to the VPS plus a few milliseconds of work. Call it **20–50×** on
the round trip. FASTER.md's earlier estimate of 10–30× for a generic small
server was deliberately conservative; it did not assume the database would sit
on the same box as the app.

**Where the shop will actually feel it:**

- **Opening a job — the biggest win.** This is the call a mechanic stands and
  waits on after scanning, and today it is the whole round trip with nothing
  hidden behind it. Seconds become imperceptible.
- **The writer's job page**, which does five reads.
- **The parts archive and jobs list**, both of which sort in the browser off
  one fetch precisely because round trips are expensive today.
- **Failure rate on bad wifi.** Fewer round trips is fewer chances to drop.

**Where it will not help, and it is worth being honest:**

- **Saving already feels instant**, because the save is optimistic — the entry
  goes into the feed on the tap and settles when the answer lands. The server
  gets faster; the *felt* experience of saving is mostly unchanged.
- **PDF parsing, QR stamping and photo shrinking all happen in the browser**
  and are untouched.
- **Uploading a big attachment is bandwidth-bound**, not server-bound.

**Limits that disappear:** the 6-minute execution cap, the 90-minutes-a-day
trigger budget, the per-op Sheets round trips, and the ~25MB POST ceiling that
currently forces attachment uploads through base64-in-JSON (a VPS can take a
normal multipart upload and stream it to disk).

**Limits that do not:** Gmail's ~100 emails a day, if you keep sending through
Gmail. See §6.

---

## 4. The migration path, and why it is unusually safe

This is the important section.

### The backend already runs under Node

`scripts/serve.mjs` (113 lines) starts a local server that serves the static
pages **and answers `/exec` using the real `service-tracker.gs`**. It does that
by loading the file into a `vm` context with faked Apps Script globals, from
`tests/helpers/apps-script-stubs.js` (302 lines). The unit tests use the same
harness.

So a Node-hosted version of this entire application exists and works today.
The only thing separating it from production is that the nine faked globals are
in-memory toys.

### The adapter surface is nine objects

| Apps Script global | Used for | Real implementation |
|---|---|---|
| `SpreadsheetApp` | the database | SQL (see §5) |
| `DriveApp` | photos, recordings, PDFs | disk or S3-compatible (§6) |
| `GmailApp` | outbound mail | SMTP (§6) |
| `PropertiesService` | config + secrets | env file or a settings table |
| `LockService` | serialising writes | a DB transaction or a mutex |
| `UrlFetchApp` | AssemblyAI + fetching the logo | `fetch` |
| `Utilities` | base64, HMAC, UUID, date formatting | `node:crypto` + Intl |
| `ScriptApp` | installing time triggers | cron or a scheduler |
| `ContentService` | JSON responses | the HTTP framework |

Every one of these is already stubbed, so **the shape each adapter must
implement is already written down** in `apps-script-stubs.js`. That file is the
specification.

### Why this beats a rewrite

- **`tools/verify.sh` keeps working.** It greps `service-tracker.gs` for the
  customer-boundary invariants and fails the deploy if they rot. Keep the file
  and you keep the guard. Rewrite the backend and that guard has to be
  rewritten too — and it is the thing standing between a supplier's cost sheet
  and a customer's inbox.
- **`tools/browser-check.mjs` becomes the acceptance test.** It already drives
  the real pages in a real browser through ~250 assertions against
  `serve.mjs`. Point it at the new server and a green run *is* the proof the
  migration worked.
- **The 250 unit tests keep passing**, because they exercise the same file.
- **The four pages do not change at all**, except one line. They already talk
  to a single door — `api(fn, args)` POSTing to one URL — and that URL appears
  in exactly one place (`assets/lib/config.js`), enforced by `verify.sh`.

The realistic caveat: `service-tracker.gs` is written in Apps Script's dialect
(no modules, `var`/`function` style, synchronous everywhere). The Drive, Gmail
and AssemblyAI calls are **synchronous** in Apps Script and asynchronous in
Node. The stubs get away with this by being instant. Real adapters will not, so
either the adapters block (a worker thread, or a sync-over-async shim) or those
call sites become async. **This is the single biggest piece of unglamorous work
in the whole move, and a planner should size it first.** Roughly: the sheet
reads/writes, `saveFile_`, `send_`, and the three `UrlFetchApp` calls.

An honest alternative, if that shim proves ugly: keep the *structure*, the
schema, the function names and the tests, and port the file to async Node
deliberately. More work, cleaner result. Decide after looking at the shim.

---

## 5. The data model

Eight tables. Column order in the source is **append-only** — the code indexes
by position — but that constraint is an artefact of Sheets and evaporates in
SQL. Keep the names.

| Table | What it holds | Key |
|---|---|---|
| `Jobs` | one row per work order | `id` = the BiT invoice number |
| `LogEntries` | hours, parts, notes — the feed | `id` |
| `PartsOrders` | one row per part needed | `id` |
| `PropRepairs` | props away at the prop shop | `id` |
| `JobFiles` | documents on a job | `id` |
| `Mechanics` | the roster | `id`, unique name |
| `StatusEvents` | the status timeline | `id` |
| `EmailLog` | what was mailed, to whom | `id` |

Exact columns are in the `SHEETS` constant at the top of
`service-tracker.gs` — copy them from there, not from here.

### Three things that will bite a migration

**1. Job IDs are text, and this has already caused an outage.** A BiT invoice
number reads `01-8891`. In a General-formatted spreadsheet cell that becomes
*the first of January, 8891* — so the primary key came back as a `Date`, every
lookup missed, and the portal reported "No such job." on a job sitting in its
own list. Every cell is therefore written as plain text via
`setNumberFormat('@')`, there is a repair function (`repairCoercedIds_`), and
the test stub deliberately *imitates* the coercion so the bug cannot pass tests
while failing in production.

**On export, the same trap is live.** A CSV round trip or a naive Sheets API
read will happily hand back Dates. Export with values as strings, import into
`TEXT` columns, and assert afterwards that every job ID still matches
`^\d{2}-\d{4}$`. In SQL this stops being a hazard permanently — which is a
quiet argument for the move all by itself.

**2. `entry_count` and `minutes_total` on `Jobs` are derived.** They exist so
the jobs list and a save never read the whole log. `setup()` runs
`recountJobTotals_` to backfill and repair drift. Recompute them after import
rather than trusting the exported values, and keep a repair path.

**3. Time is stored as decimal hours but must never be summed as decimals.**
Every figure goes through `minutesFromHours_`, is summed in whole minutes, and
comes back via `hoursFromMinutes_`. Sum 0.3333 three times and a mechanic's
three twenty-minute stints come to 59 minutes. The sheet keeps decimals because
that is what gets re-keyed into BiT.

### Database choice

**SQLite is the right-sized answer**, and the app's own design argues for it:
every write in the shop already serialises through one script lock, so the
write pattern is literally single-writer. In WAL mode SQLite handles this
workload without noticing. Backups become "copy one file." No second service to
run, patch or monitor — which matters more here than throughput ever will.

**Use Postgres if the CRM already brings it**, in which case the marginal
operational cost is zero and you may as well share. The schema is the same
either way.

Either way the whole database will be a few hundred megabytes after years.

---

## 6. The other three subsystems

### Files (photos, recordings, work orders, invoices)

Today: Google Drive, one folder per job, folder link-shared once so the files
inside inherit it. Photos are shrunk in the browser to ~200KB and stored in two
sizes. 15GB shared with the winter services app.

Two options:

- **Local disk (recommended long-term).** Trivial adapter. Serve by ID.
  Removes the Drive quota. **It also deletes a whole feature:** the nightly
  2am `sweepEntryFiles_` exists only because moving a Drive file is several
  slow API calls, so a moved log entry gets its files filed later. On local
  disk a "move" is a metadata update and the sweep is unnecessary.
- **Keep Drive.** Zero file migration on day one, and the shop keeps a folder
  it can open and browse. Costs a Google API credential and a real Drive
  adapter, which is more work to *build* than the disk one.

Sizing if files move local: roughly 500 jobs a year × ~10 photos × two sizes
≈ 2GB/year, plus PDFs. **20GB covers several years.** Migration is a one-time
script: list, download, write, rewrite the stored IDs.

### Email

Today: `GmailApp` from the shop's consumer Gmail. ~100 recipients/day. The
invoice email copies the service desk. Deliverability is Google's problem.

**Send through Gmail's SMTP relay with an app password.** Same sending
identity, same deliverability, same limit — the smallest possible change, and
mail still lands where it lands today.

Do **not** send directly from the VPS's own IP. A fresh datacenter IP with no
reputation goes to spam essentially every time, and the thing being mailed is
customer invoices.

If the shop ever outgrows 100/day, move to a transactional provider
(Postmark/Resend/SES) — better limits and tracking, but it needs SPF/DKIM on a
real domain and changes the From address. Not needed now.

**One non-obvious constraint to preserve:** the invoice email is built entirely
out of tables with `bgcolor` attributes, per-cell fonts and an Outlook
conditional ghost table — because Outlook on Windows renders mail through Word,
which ignores `max-width`, drops CSS-only backgrounds and will not inherit
`font-family` into a table. A test asserts all three. Gmail renders the naive
version beautifully, which is exactly why the bug survived so long. Do not
"clean up" that HTML.

### Scheduled work

Three time-based triggers today:

| When | Function | Does |
|---|---|---|
| hourly | `hourly()` | transcript sweep + per-job notification digest |
| 3pm daily | `sendDailyOrders()` | the parts list |
| 2am daily | `nightly()` | files the moved Drive files (capped at 40/night) |

On a VPS these become cron entries or an in-process scheduler. The hourly one
does two jobs in one trigger purely to stay inside Google's 90-minute daily
trigger budget — that constraint is gone, so they can separate if it helps.

The notification digest is hourly **on purpose**, to stay under Gmail's daily
cap. Keep it that way even though the platform no longer forces it; per-entry
email would flood both the shop and the quota.

Transcription runs through AssemblyAI, submitted after the lock is released and
caught by the hourly sweep if the submission fails. On a VPS this can just be a
proper background job. The API key lives in script properties and **must never
land in the repo — it is public.**

---

## 7. Rules that must survive the move

These are not preferences. Several are enforced by tests, and one of them
protects customer data.

1. **The customer boundary.** `/t/` is the only customer-facing page. It shows
   customer notes and the balance due, and nothing else — never internal notes,
   labor hours, part numbers, mechanic names, prop repairs, job attachments or
   the red alert. The filter is `customerView_`; `publicJob` is the only thing
   that returns entries through it, and it builds its payload field by field
   rather than handing back a row. `tools/verify.sh` **fails the deploy** if
   either stops being true. Customer tracking is currently switched off and no
   page links to it, but `/t/` still has to answer, because the QR code on
   every printed work order points at it — it answers with the shop's phone
   number.
2. **`amount_due`, never the grand total.** Deposits are normal here; boats get
   paid down over a winter. Never put the grand total next to a Pay button.
3. **Attachment visibility is decided at upload and never inferred.** Anything
   the backend cannot read as exactly `customer` is internal. The failure that
   matters is a supplier's cost sheet leaving with an invoice.
4. **`markDone` sends nothing.** Closing a ticket and emailing a customer are
   two deliberate acts behind two buttons. Do not recombine them, and do not
   attach a send to a status change or a trigger.
5. **Mechanics have no PIN.** They identify by name; names are unique
   case-insensitively because the name is the whole identity.
6. **`openJobs` requires a signed-in mechanic; `lookupJob` does not.** Looking
   one job up means you are holding the paper. Listing every open job hands
   over every customer's name and boat at once. `lookupJob` deliberately
   answers *differently* by caller — full job screen for a signed-in mechanic,
   bare summary otherwise — and a test asserts the log, phone and email are
   absent from the anonymous branch.
7. **No credential in the repo.** It is public. Secrets live in script
   properties today and belong in an env file or secrets store on the VPS.

---

## 8. The two things that can break paper

**`SITE_URL` is printed onto work orders.** The QR code encodes the address of
the *static pages*, not the backend. So:

- **Keep the pages on GitHub Pages and only change `API_URL`** → every printed
  QR code keeps working, and the change is one line in
  `assets/lib/config.js`. This is the zero-risk default and what the migration
  should do on day one. It needs CORS headers on the new server (today the
  pages dodge preflight by POSTing as `text/plain`; same-origin would remove
  the issue entirely).
- **If the pages later move to the VPS**, leave GitHub Pages serving a redirect
  to the new host, permanently. Old sheets then still work via one extra hop.
- **Never** move them and let the old address die.

**Job tokens must be preserved through the migration.** The QR encodes
`/t/?j=<token>`, and the token is a `Jobs` column. Migrate it as-is. FASTER.md
already flags this: printed QR codes survive a backend move *provided the
migration preserves job tokens*.

---

## 9. Security — one thing genuinely changes

Today the writer's portal is protected by `ADMIN_PASSWORD`, a script property,
compared case-insensitively and trimmed (the shop types it on a phone and a
counter iPad, where the keyboard capitalises). Five characters minimum, at the
shop's request. There is **no throttle** on `adminSignIn`. Behind that door are
customer names, phone numbers, addresses and emails.

CLAUDE.md is blunt about why that has been acceptable:

> What actually keeps people out is that the `/exec` URL is not published
> anywhere. If that ever stops being true, add a throttle before anything else.

**Moving to a VPS with a real hostname is exactly that moment.** A domain is
discoverable in a way a random `/exec` URL is not. So, as prerequisites rather
than nice-to-haves:

- **Rate-limit `adminSignIn`** (and the magic-link endpoint).
- **Raise the minimum password length**, or move the portal behind a second
  factor — or simply do not expose `/admin/` publicly at all.
- The magic-link endpoint is **unauthenticated and sends mail**. Three
  properties hold it together and none is optional: it takes no recipient
  parameter (the address is a constant), one link is outstanding at a time, and
  a *wrong* guess does not consume the nonce (otherwise anyone could void the
  writer's real link by posting rubbish). Port all three exactly.

---

## 10. Resources

For this app alone, alongside a CRM:

| | Needs | Notes |
|---|---|---|
| CPU | 1 vCPU is plenty | a handful of concurrent users, ever |
| RAM | ~150–250MB for Node | +~256MB if Postgres; SQLite adds none |
| Disk (code) | <100MB | includes 2.6MB of committed vendor libs |
| Disk (database) | a few hundred MB after years | tiny |
| Disk (files) | 0 if Drive stays, else ~20GB | ~2GB/year of photos + PDFs |
| Bandwidth | negligible | |
| Ports | 443 | plus a hostname and TLS |

Practically: **whatever the CRM needs, plus about 1GB of RAM and 20GB of
disk.** This app will not be what sizes the box.

Also needed: a domain or subdomain, automatic TLS (Caddy does this with no
configuration), and **an offsite nightly backup** — see below.

---

## 11. What you take on

Worth stating plainly, because it is the real cost and it is not measured in
dollars.

- **Backups become your job, and this is the biggest new risk.** Google
  currently keeps the Sheet safe without anyone thinking about it. A nightly
  dump pushed *off the box* is mandatory, not optional — a backup on the same
  VPS is not a backup. Test a restore before cutover, not after an incident.
- **TLS renewal, OS patching, uptime.** Caddy handles the first; the rest is
  yours.
- **You lose the Sheet as a thing the shop can just open and read.** This is a
  genuine loss and FASTER.md flagged it when the decision was first weighed.
  Mitigate with a read-only export, a scheduled CSV drop, or a database GUI —
  but decide *how* before cutover, not after the first time somebody asks.

---

## 12. Cutover

1. **Build the adapters.** Green unit tests + a green `browser-check.mjs`
   against the new server is the bar. Nothing else counts.
2. **Export and import**, preserving job IDs and tokens as text. Assert IDs
   still match `^\d{2}-\d{4}$` and recompute `entry_count` / `minutes_total`.
3. **Parallel run.** Point a staging copy of the pages at the VPS and run the
   browser check against real data. Apps Script stays live and untouched.
4. **Cut over at 2am.** Nobody is on the floor. Freeze writes, take a final
   export, import, flip `API_URL` in `assets/lib/config.js`, deploy Pages,
   verify a real job opens on a real phone.
5. **Keep the Apps Script deployment alive and read-only for a few weeks.**
   Rollback is then flipping `API_URL` back — one line, one Pages deploy.

**Realistic downtime: 15–60 minutes at 2am**, which no mechanic will
experience. The risk worth planning for is not the outage; it is silent data
corruption on import. See §5.

---

## 13. Open decisions for the planning session

1. **Adapter shim vs deliberate async port** (§4) — size the sync-over-async
   problem first; it determines the shape of everything else.
2. **SQLite or Postgres** (§5) — SQLite unless the CRM already brings Postgres.
3. **Files: disk or keep Drive** (§6) — disk is simpler to build, Drive is
   simpler to migrate.
4. **Do the pages move off GitHub Pages?** (§8) — recommend not on day one.
5. **Mail relay** (§6) — Gmail SMTP recommended to start.
6. **Backup destination and restore drill** (§11) — decide before cutover.
7. **Portal exposure and rate limiting** (§9) — decide before the hostname is
   public.

---

## Reference

- [CLAUDE.md](../CLAUDE.md) — the hard rules, and the reasoning behind the
  decisions that look odd
- [FASTER.md](FASTER.md) — the performance measurements and what has already
  been done
- [DEPLOY.md](DEPLOY.md) — how it deploys today
- `service-tracker.gs` — the whole backend; `SHEETS` at the top is the schema
- `tests/helpers/apps-script-stubs.js` — the adapter specification
- `tools/verify.sh` — the boundary guard that must keep passing
- `tools/browser-check.mjs` — the acceptance test for the migration
