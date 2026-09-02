# Quest Watersports Service Tracker — working notes

Read [README.md](README.md) first for what this is, and
[docs/DEPLOY.md](docs/DEPLOY.md) before touching a deployment. This file is the
short list of things that are easy to get wrong.

## Hard rules

1. **BiT is never integrated with.** No scraping, no automation, no API calls,
   no matter how convenient. Every exchange is a person downloading a PDF from
   BiT and uploading it here, or re-keying data from here into BiT.
2. **Never "New deployment."** It mints a new `/exec` URL, orphaning all four
   pages and every QR code already printed on paper. Update the existing
   deployment — the Actions workflow is built so you cannot do otherwise.
3. **This is an internal tool, and customer tracking is scrapped.** The only
   thing a customer ever receives is the invoice email a writer sends by hand
   from a finished job. `markDone` closes the ticket and sends nothing;
   `sendInvoiceEmail` is a separate call behind a separate button. Do not put
   those back together, and do not add a send to a status change or a trigger.

   **Nothing any user sees may mention a customer tracking page.** Not the
   portal, not the mechanic app, not the landing page, not `/t/`, not an
   email. `publicJob`, `customerView_` and `setCustomerTracking` are still in
   the backend and still guarded — they are dead but benign, and the boundary
   is still tested on the wire so it cannot rot. Nothing calls them from a
   page. `/t/` itself still has to answer, because the QR code on every
   printed work order points at it and that paper cannot be recalled; it
   answers with the shop's phone number.
4. **The customer sees customer notes and nothing else.** Internal notes,
   labor hours, part numbers, quantities, mechanic names and the shop's own
   figures never reach `/t/`, at any status. The filter is `customerView_`, it
   is the only thing `publicJob` returns entries through, and
   `tools/verify.sh` fails the deploy if either of those stops being true. If
   a new field is added to a log entry, decide its visibility there, not in a
   page template.

   The one money figure they do see is **their own balance**, and only once the
   job is Done — at which point they are being handed the invoice anyway.
   `amountDue` is the number after deposits, never the grand total.
5. **`SITE_URL` is printed onto paper.** Changing it after work orders are in
   the folder invalidates every QR code already printed.

   The same reason a **re-stamp keeps the job's existing token**. A customer
   adds to the job after the sheet is printed, so the writer changes it in BiT
   and drops the new PDF on the job page: it is stamped with the same QR as the
   first copy, so anything already in the folder still opens the job.
   `attachWorkOrder` replaces the stored file and touches nothing else. A PDF
   whose invoice number reads as a *different* job is refused — this job's QR
   on another job's paper sends a mechanic to the wrong boat — while one with
   no text layer is allowed through with a note, because it proves nothing
   either way. The description off the new copy is **offered, not applied**:
   the writer may have already typed a better version by hand.
6. **No credential ever lands in this repo.** It is public. Passwords and API
   keys live in Apps Script → Project Settings → Script properties, and the
   code only ever names them.

## Shape of the thing

```
index.html            landing
admin/index.html      service writer portal (password → token in localStorage)
m/index.html          mechanic PWA (name → token; manifest + sw.js at the root)
t/index.html          customer page (?j=token is the only credential)
assets/lib/           shared browser modules — no framework, plain ESM
assets/vendor/        pdfjs, pdf-lib, qrcode, zxing, committed on purpose
service-tracker.gs    the entire backend
scripts/lib/          shared with tests: png.mjs, sample-work-order.mjs
tools/verify.sh       what the deploy workflow runs before it will deploy
tools/browser-check.mjs  drives the real pages in a real browser
```

`assets/lib/config.js` holds the `/exec` URL, and is the **only** place it
appears — `verify.sh` fails if it turns up anywhere else, because four pages
drifting onto different backends is a bad afternoon.

## Where work happens

The split is deliberate and worth keeping:

- **The browser** opens PDFs (pdfjs), stamps the QR (pdf-lib), and shrinks
  photos before upload. Apps Script cannot do the first two at all, and the
  third would cost a fortune in payload.
- **Apps Script** stores, decides who may see what, and sends mail. It never
  parses a document.

`assets/lib/lines.js`, `parse-work-order.js`, `tracking.js` and
`entry-types.js` import nothing — they run in the browser and under node, which
is how the parser stays under test.

## Data model notes

Sheets tabs are in `SHEETS` at the top of the backend. **Column order is
append-only**: `appendRow_` and `updateRow_` both index by that array, so a new
column goes on the END and `setup()` writes it into the header on the next run.

**Every cell is written as plain text**, via `setNumberFormat('@')` before
`setValues`. This is not tidiness. A BiT invoice number is `01-8891`, and a
General-formatted cell turns that into the first of January, 8891 — so the
job's primary key came back as a `Date`, every lookup by id missed, and the
portal answered *"No such job."* on a job sitting in its own list. ISO
timestamps go the same way. `asText_` normalises any Date still in the sheet,
`repairCoercedIds_` (run from `setup()`) puts mangled ids back across all five
tabs, and the test stub now **imitates the coercion** so this cannot pass tests
again while failing in production. Numbers are coerced on read, so text costs
nothing.

`rows_` is memoised per execution and every write calls `forget_`. If you add
a code path that writes to a sheet without going through `appendRow_` or
`updateRow_` — `deleteRow`, say — it must call `forget_` itself.

- **Typed and spoken are two fields, not one.** `text` is what a person typed;
  `transcript` is what the recording said. A mechanic who records *and* types
  has said two things, and for a while the second was thrown away: the
  transcript was only requested when `text` was empty, so a recording next to
  a typed note was stored and never turned into words. Every recording is
  transcribed now, and the transcript lands in its own column so it can never
  write over what somebody typed. Entries older than the column keep their
  words in `text`, which is why this was an addition and not a rename — and
  why anything reading a voice note reads both.
- Photos are `[{thumb, full}]` JSON in one cell — the browser uploads two sizes
  so the feed is cheap and the lightbox is sharp.
- **`work_requested` is what the customer asked for**, parsed off the body of
  the work order — the band between the invoice detail row and the "I hereby
  authorize" boilerplate, both of which are printed furniture and so make the
  band findable without knowing what is in it. It is the one field a mechanic
  needs before touching the boat, so it rides along with `lookupJob` (a typed
  number means the paper is elsewhere) and with the open-jobs list. It is
  never in `missing`: plenty of jobs are written up with that band empty.
- **`openJobs` needs a signed-in mechanic; `lookupJob` does not.** Looking one
  job up by its number means you are holding the work order. Listing every
  open job hands over every customer's name and boat at once — same
  information, very different disclosure, so the roster is the gate.

  `lookupJob` **answers differently depending on who asked**, and that is the
  gate rather than an optimisation: with a signed-in mechanic's token it
  returns the whole job screen — the log, the hours, the props — and without
  one it returns the summary and nothing else. It does that because opening a
  job used to be two calls to Apps Script and the second one cost more in
  start-up than in reading. Never let the anonymous branch grow the log, the
  customer's phone or their email: a test asserts each of those is absent.
- **Opening a job does not fetch the log.** One job's entries means reading
  every entry in the shop — a Sheet has no index — and it was the largest read
  on the path, paid by a mechanic who opened the job to *write*. The card says
  "Job log (7)" from the row's own `entry_count` and fetches those seven
  through `jobLog` when somebody taps for them. Anything saved since shows at
  once, fetched or not: what the mechanic just wrote is never behind a button.
  `hours.total` on that screen comes off `minutes_total`; the by-person
  breakdown only comes back with the log, where somebody is reading detail.

  Props are out of the open payload for the same reason plus a simpler one:
  they are drawn only inside the Prop tab, so `jobProps` runs when that tab
  opens. Shrinking what the log SHOWS would have saved nothing — the read is
  the whole tab either way. Only not asking for it saves anything.

- **A save does not make the mechanic wait.** The entry goes into the feed on
  the tap, marked *Saving…*, the form clears for the next one, and the row
  settles when the backend answers — only the feed and the running total are
  redrawn then, never the form, because by that point somebody may be typing
  into it. A save that fails says **Not saved** in red where the entry is,
  with a button to send it again, and says it as a toast too in case the
  mechanic has walked to another screen. Nothing is ever queued past the app
  closing: a note the phone swallowed is worse than one the mechanic knows
  did not send.

  `whatIsMissing()` says what the backend would have refused — the part
  number, the time, the empty note — without a round trip. The backend is
  still the authority and still checks; this is the same short list said
  instantly, and it is what keeps the optimistic entry honest.

- **The mechanic app logs three things: Hours, Parts, Notes** — in that order.
  A fourth tab, **Prop**, sits beside them and is deliberately not one of them:
  it writes a PropRepairs row, not a log entry. It shares the strip because
  that is where a mechanic looks for the thing they do next — as its own card
  below the log, it sat under everything nobody scrolls to. The tab hides the
  note, recorder and photo controls, and the one save button at the foot of
  the card does whatever the current tab is for.
  Customer notes were dropped; notes are the shop's own record now. The
  `customer_note` type is still live in the backend and still the only thing
  `customerView_` lets through, so the customer page can be switched back on
  without one. Nothing in the UI creates one, so `browser-check.mjs` posts one
  on the wire to keep the boundary test honest.
- **Time is entered and shown as hours and minutes**, never as a decimal. The
  sheet still stores decimal hours — that is what an estimate is written in and
  what gets re-keyed into BiT — but nothing adds decimals together. Every
  figure goes through `minutesFromHours_` first, is summed in whole minutes,
  and comes back through `hoursFromMinutes_`. Sum 0.3333 three times and a
  mechanic's three twenty-minute stints come to 59 minutes. The service
  writer's Labor card is the one place that still shows the decimal, because
  BiT will not take "2h 30m"; the mechanic's app and the customer never see it.
- A fourth entry type, `labor`, carries `hours` plus what the time went on.
  Like `part` it is internal-only; `addEntry` pins `hours` to `''` for every
  other type so the figure cannot ride along on a customer note.
- Mechanics have no PIN. They identify themselves by name, and names are unique
  case-insensitively because the name is the whole of the identity.

## What a real BiT form actually looks like

Measured from two real documents — a work order (`01-8893`) and a completed
invoice with a deposit against it (`01-7153`) — and encoded in
`scripts/lib/sample-work-order.mjs` so every test runs against the real shape:

- **Two columns, both headings on one row.** `Sold To:` at x=31 and
  `Invoice # 01-8893` at x=218, same y. The customer block runs down the left,
  the unit down the right. Flattened into lines they read as one run-on
  sentence, which is why `labelledColumnBlock` takes the column boundary from
  the label's own row rather than guessing a width.
- **Empty fields simply do not print.** There is no placeholder text. A
  customer with no trailer has no trailer rows at all, and a unit with nothing
  filled in leaves an empty column — which `findUnitColumn` reports as missing
  rather than guessing at.
  *(An earlier note here claimed BiT prints field names into empty slots. It
  does not. That form had the descriptions typed into the fields by hand to
  show what goes where. The parser still refuses to read such a row as a unit,
  because "Make Trailer" on a customer's page is worse than a blank.)*
- **A `#` is part of a heading, never a value separator.** Reading
  `Serial # Reg #` as serial="Reg #" is how "Make Trailer" got onto a job.
- **The shop's own details are on every form**, above the customer's: Quest's
  address, `815-433-2200`, `service@questwatersports.com`. Any "first phone on
  the page" fallback finds the SHOP — and then emails the shop instead of the
  customer. Fallbacks are confined to lines below the `Sold To:` anchor.
- **Names arrive as separate text runs** — "John" and "Purnell" at different
  x on one row — so line grouping, not the raw items, is what the parser reads.
- **The totals block is on the LAST page**, down the right, sharing rows with
  the legal text down the left. A job can carry a deposit: one real invoice
  reads Grand Total 16,917.79, Deposits 15,285.32, **Amount Due 1,632.47**. The
  balance is what the customer owes and what `parse-invoice.js` is for; the
  grand total is not.

## Facts established with the shop

- **BiT invoice numbers are never recycled.** That is what makes the number
  safe as a job's primary key.
- **Hours are deliberately uncapped.** The same screen is used to work up an
  estimate, where a figure covers a whole job rather than one stint.
- **Deposits are normal.** Boats get worked on over a winter and paid down as
  they go, so the amount due is routinely a fraction of the total. Never put
  the grand total next to a Pay button.
- **Customer email is copied from the winter services app**, down to the
  wordmark over the gold rule and the navy footer, sent under the shop name
  with `Reply-To: service@questwatersports.com`. Copied convention, not shared
  infrastructure — a separate script, sheet and Drive folder.

  **The whole email is tables, not divs, and that is not a style choice.**
  Outlook on Windows renders mail through Word, which is not a browser: it
  ignores `max-width` (so a div card becomes as wide as the window), it drops
  a background colour given only in CSS (so the white card, the navy footer
  and every coloured notice came out plain white), and it will not inherit
  `font-family` into a table (so half the mail arrives in Times New Roman).
  Gmail rendered the div version beautifully, which is exactly why it survived
  as long as it did.

  So every colour is a `bgcolor` attribute as well as a style, every cell
  holding text names its own font, line heights are in pixels, and a ghost
  table inside an `<!--[if mso]>` conditional pins the width for Outlook. A
  test asserts all three, because none of it can be seen from here.

  **A button is a table** for the same reason: Outlook ignores padding on an
  inline element, so the old `<a>` arrived as a coloured rectangle behind the
  words — a highlighted phrase rather than something to press.

  And **nothing customer-facing says "boat"**: a trailer, a prop or an engine
  on a stand all come through the same shop. The email says the work you
  requested has been done, and the unit is named on its own line.
- **Drive files are link-shared**, matching how the shop already handles unit
  photos. See the comment on `saveFile_` for what actually protects them.

## The red alert on a job

A per-job `alert` (plus `alert_at`), set and cleared by the service writer from
the job page, shown in red across the top of the mechanic's job screen and on
the open-jobs list — where an alerted job also sorts to the front, because an
alert nobody sees until they have already picked the job is half an alert.

- **It is not another kind of note.** A note is a line in a feed that a busy
  mechanic scrolls past. This is for "do not start — the owner is disputing the
  estimate". Because it is that loud it is meant to be taken down once it has
  been acted on, and the writer's card says so. Setting one also writes it into
  the shop log, so the record survives the banner coming down.
- It is not dismissible from the phone. It comes down when the office takes it
  down, not when the floor taps it away.
- **It never reaches `/t/`.** It is a Jobs column, so `customerView_` never
  sees it — what keeps it in the building is that `publicJob` names the
  customer's fields one at a time instead of handing back the row.
  `tools/verify.sh` fails the deploy if `publicJob` so much as mentions it, or
  if it stops building that payload field by field.
- `setJobAlert` calls `requireColumn_` before writing, because the column only
  exists once somebody has run `setup()`. Without that the alert would save,
  read back as undefined and never appear — and the writer would have no way to
  tell that from a mechanic ignoring it.

## Props out for repair

A propeller off a customer's boat, away at the prop shop and back again. It
mirrors the parts list — a floor-to-office handoff with a batch step in the
middle — and differs in the two ways that matter.

- **A photograph of the tag is the identity.** A prop has no barcode and no
  part number. What tells the prop shop whose it is, and tells the writer
  which boat it goes back on, is the paper tag wired to it — so the mechanic
  photographs the tag and that photo leads every row on both screens. It is
  asked for, not insisted on: like the stock request's part number, a
  description alone still gets a prop onto the list, because a mechanic
  holding a prop and a camera that will not focus should not be stuck.
- **The stages are its own**: `ready` → `picked_up` → `fixed` *or*
  `unfixable`. Not the parts lifecycle reworded. A part is bought and arrives;
  a prop is the customer's own property leaving the building, and it can come
  back unusable — which is a real ending, and the one that means somebody has
  a phone call to make. So `unfixable` is a status, not a failed `returned`.
- It goes out in a batch against whoever collected it, the way parts go on an
  order against a vendor. Once it has left it can no longer be pulled off the
  list — only marked returned.
- The floor creates one; the office moves it along. `addPropRepair` needs a
  signed-in mechanic, everything after it needs the writer, and `listProps`
  is writer-only for the same reason `openJobs` is gated: it is every
  customer's name and boat in one list.
- **None of it reaches `/t/`.** It is its own tab, `publicJob` never touches
  it, and a test walks a job with a prop out all the way to done and asserts
  the customer page says nothing about it.
- A new tab needs `setup()` run once, same as a new column. `sheet_` already
  fails with "Run setup()." if the tab is missing, so this one guards itself.

## The writer's jobs list

Defaults to **Open jobs**, and open means *not (done AND paid)* — see
`isOpenJob_`. Not simply "not done": a closed ticket the customer has not
settled is still the writer's problem, and it is the one most easily lost,
because the work is over and nothing else will bring it back to their
attention. Ticking paid is what takes a job off the list; untick it and the
job comes back.

The chip order is Open jobs, the four statuses, **All**, Done. All sits next
to Done at the far end on purpose: those two are what you go looking for,
not what you should land on.

Open carries no query parameter, being the default, so `?` is the working
list and `?status=all` is everything.

**Three orders, sorted in the browser off the one fetch** — the same reasoning
as the parts archive: Apps Script charges per round trip, and re-asking the
backend to put the same rows in a different order is a wait for nothing.
Newest first is the working list; work order number and customer surname are
for going *for* something, so they run upwards and A-to-Z, which is the order
you scan in. The choice lives in `?sort=` so a refresh keeps it and the status
chips carry it across.

Surnames come out of `assets/lib/names.js`, which is under test because one
name field holds several shapes: "John Purnell", "SMITH, JOHN", "John Purnell
Jr" and "Quest Watersports LLC". A business sorts under what it trades as —
filed under L, "Quest Watersports LLC" is unfindable — and a job with no name
yet sorts last, being a job to fix rather than a customer called nothing.

## Fixing a misfiled entry

The office can move a log entry to another work order, or delete it. The
floor cannot: `deleteEntry` and `moveEntry` are writer-only, because a
mechanic unsaying something the shop has already read and acted on is a
different thing from correcting a mistake.

- **Both totals move.** `adjustJobEntryTotals_` is the one place that changes
  `entry_count`/`minutes_total` in either direction — a move takes the entry
  off one job and puts it on the other, a delete takes it off for good. That
  is the whole reason this cannot be a hand edit in the Sheet.
- **A parts-list line goes with the entry.** On a move it follows, or it sits
  on the wrong customer's order. On a delete it goes too — but only while it
  is still `needed`. An entry whose part has actually been ordered refuses to
  delete and says to deal with the parts list first, the same rule
  `cancelPartOrder` follows.
- **Photos and recordings stay put until 2am.** Moving Drive files is several
  slow calls each and the writer is standing at a counter, so `moveEntry`
  stamps `files_job` with the folder the files are actually in and the
  `nightly` trigger walks them over. The links work either way — every job
  folder is link-shared and the entry carries the file ids — so this is about
  filing, not access: somebody opening last winter's job in Drive should find
  that job's photos in that job's folder. `files_job` empty means nothing to
  do, which is the answer for every entry that has never moved, and moving one
  back before the sweep runs clears it. The sweep is capped per night so a
  backlog cannot spend the day's trigger runtime in one go.
- The move target is given as the number off the paper, through
  `jobByNumber_`, so `01-8886`, `018886` and `8886` all find it and an
  ambiguous suffix finds nothing.

## Parts, and the writer's checklist

- A **part entry** can carry two extra asks: order one for this job, and put one
  back on the shelf. Both are separate `PartsOrders` rows against the same
  entry, because they are two different things to buy.
- A **stock request** has no job behind it. The part number is asked for but
  not enforced — somebody at an empty hook with only a description still gets
  it onto the list. Do not add `required` to that field.
- Order lines go `needed` → `ordered` (with a vendor and that vendor's order
  number) → `received`. An order is finished, and moves to completed, only when
  every line sharing its order number is in.
- **"Parts and labor logged" is not a job flag.** It stamps `logged_at` on each
  entry, so anything a mechanic adds afterwards shows up below the line as
  still needing writing up. Parts-ordered and paid/closed are job flags.
- **A completed order can be filed away or deleted.** Filing is the normal
  one: the parts list is a working list, and a year of finished orders buried
  under it makes the three lines that still need doing hard to find. An
  archived part keeps everything and moves to `?view=archive`; `archived_at`
  is a flag, not a status, so nothing about the order grouping changes.
  Deleting is for the duplicate row, not for tidying history — it asks first,
  and only ever touches parts that have arrived. Anything still needed or on
  order goes through `cancelPartOrder`, which refuses to lose a placed order.
- **The archive is a table, and the only one in the app.** Everything else is
  a list of cards because everything else is read one item at a time; the
  archive is read by scanning a column for a supplier or a name. It searches
  and sorts on part, customer, supplier and work order — in the browser, off
  one fetch, because Apps Script charges per round trip and a query per
  keystroke would be unusable.
- `deletePartsOrders` removes rows highest-first. Deleting row 4 shifts row 5
  up into its place, so an ascending loop takes out the wrong rows from the
  second one onward; there is a test with two orders that catches exactly
  that, and `deleteRow` has to `forget_` the memoised rows itself.
- None of it reaches `/t/` — it is all shop bookkeeping.

## Signing in to the portal

Two ways, both landing on the same 12-hour sealed token:

- `ADMIN_PASSWORD`, a script property. Compared **case-insensitively and
  trimmed**: the shop types it on a phone and a counter iPad, where the
  keyboard capitalises the first letter on its own. `setAdminPassword` accepts
  five characters and up, at the shop's request.

  That is a deliberately weak door, and worth being honest about: five
  lower-cased characters is guessable, `adminSignIn` has no throttle, and
  behind it are customer names, phone numbers and addresses. What actually
  keeps people out is that the `/exec` URL is not published anywhere. If that
  ever stops being true, add a throttle before anything else.
- A one-time link mailed to `SERVICE_EMAIL` by `requestMagicLink`.

That second one is an **unauthenticated endpoint that sends mail**, so three
properties hold it together and none of them is optional:

1. **It takes no recipient.** The address is the `SERVICE_EMAIL` constant.
   Never add a parameter for it — that turns a sign-in helper into something
   that posts mail to whoever asks.
2. **One link outstanding at a time**, in `MAGIC_NONCE`/`MAGIC_EXP`. Asking
   for a new one voids the last; using one clears it.
3. **A wrong guess does not consume the nonce.** Only success and expiry do.
   Clearing it on a mismatch would let anyone void the writer's real link by
   posting rubbish at the endpoint — a denial of service, which is the actual
   threat here, since a 20-character base32 nonce is not going to be guessed.

`MAGIC_THROTTLE_SECONDS` keeps somebody leaning on the button from spending
the day's Gmail allowance.

## What makes saving slow

**There is a plan for this: [docs/FASTER.md](docs/FASTER.md).** It carries the
measurements, the four fixes in order, and why the shop is staying on Apps
Script for now. `tools/bench-reads.mjs` reproduces the numbers — run it before
and after any change that claims to make things faster.

The short version: a Sheet has no index, `rows_` reads the whole tab, and
`_rowCache` is per-execution. At 400 jobs one `addEntry` used to read 64,000
cells to append one row, growing linearly forever.

Steps 1–3 are done: `addEntry` is down 67% and `listJobs` 84%, and neither
reads the log at all any more, so neither grows with the shop. Two rules came
out of it and both matter:

- **`entry_count` and `minutes_total` on Jobs are derived**, so `setup()` runs
  `recountJobTotals_` to backfill and to put right anything that ever drifts.
  A derived number nothing checks is a number that rots.
- **`addEntry` re-reads the Jobs row inside the lock** before incrementing.
  The row it already had was read before the lock was taken; without the
  re-read two mechanics saving at once both write the same total and one is
  lost.


**Round trips are the cost, not cells** — at the size the shop is actually at.
Every call to `/exec` pays Apps Script's start-up and the redirect it answers a
POST with, and inside the script every `getValues`, `getLastRow`,
`setNumberFormat` and `setValues` is its own trip to Google. Each costs about
the same whether the range is one cell or ten thousand. `tools/bench-reads.mjs`
counts both numbers; **ops** is the one to watch first.

Three rules came out of counting them, and all three are load-bearing:

- **`addEntry` reads the Jobs tab once, inside the lock.** It used to read it
  before the lock to find the job and again inside to increment safely. Reading
  it once with the lock held is the same guarantee for half the reading — so
  the job lookup lives inside `withLock_`, after the payload checks.
- **Files go to Drive BEFORE the lock.** One script lock serves every save in
  the shop and a photo is two Drive writes, so uploading inside it made one
  mechanic's photos everybody else's wait. The lock is for the running totals.
  A test asserts `saveFile_` runs outside it and `appendRow_` inside.
- **`updateRow_` reads the span back before writing it, and that read stays.**
  A patch of `updated_at` plus the two totals spans fourteen columns, the alert
  among them, and the writer's saves do not take the lock. Building the span
  from a row read earlier would quietly undo whatever the office saved in
  between.

Every answer carries `serverMs`, and `api()` times the whole round trip — the
mechanic's footer shows both, and the App setup page lists recent calls. The
gap between the two numbers is start-up and wifi, which no amount of tidying
spreadsheet reads will touch.

`ping` is the one function that does nothing, and it earns its place: the
mechanic app calls it as it opens and again when the scanner comes up, so
Google has a container running by the time somebody scans. Keep it free — no
sheet, no property, no credential — and keep the app's `warm()` rate limit,
or a phone in a pocket becomes a pinger.

Apps Script charges for round trips, and a save used to make a lot of them.
If a save gets sluggish again, look here first:

- `rows_` is memoised per execution. Before that, one `addEntry` read the Jobs
  tab three times and LogEntries once.
- `updateRow_` writes the changed span in ONE call. It used to be one
  `setValue` per field, so a status change cost three round trips.
- `jobFolder_` is memoised, and the **folder** is link-shared once rather than
  every file inside it. Drive gives a file its parent's permissions.
  `setSharing` is slow and a photo stores two files, so this was two slow ACL
  calls per photo.
- The AssemblyAI submission happens **after** the lock is released and after
  the row is written. It is a Drive read plus two calls over the wire; inside
  the lock it held up every other mechanic on the floor. The row is already
  marked `pending`, so the hourly sweep catches it if the submission fails.

## Quotas to respect

Consumer Gmail, not Workspace, and the account is shared with the winter app:

- **~100 emails a day**, counted per recipient. This is why notifications are
  an hourly per-job digest rather than one per entry. Do not turn that back
  into per-entry sending. The invoice email copies `SERVICE_EMAIL` so the shop
  keeps a record of what each customer was sent — that is two recipients per
  finished job, which at a handful of jobs a day is nothing, and it is skipped
  when the desk is already the recipient (a rehearsal), because copying an
  address to itself is a duplicate rather than a record.
- **15 GB of Drive**, shared. Photos are shrunk to ~200 KB before upload.
- **90 minutes of trigger runtime a day.** One hourly trigger does both the
  transcript sweep and the digest, for that reason. Two dailies sit beside it:
  the parts list at 3pm, and `nightly` at 2am for the file filing — put
  housekeeping there, where slow costs nothing, rather than into the hourly.

## Running setup() without opening Apps Script

Every deploy that adds a column, a tab or a trigger needs `setup()` run once.
The App setup page says whether the sheet is behind — `sheetStatus` — and now
has the button next to it: `runSetup` is `setup()` behind the writer's
password. It is safe to press twice, because setup() only ever adds what is
missing.

It **answers rather than throws** when it fails part way, and that is the
point of the shape. `ensureSheets_` runs before `installTriggers_`, so a
script that has never been authorised to create a trigger from a web app
still gets its columns — the page says which half landed instead of showing a
red banner that makes it look as though nothing did.

Nobody should have to find a function in a dropdown on script.google.com to
finish a deploy.

## The two switches

Both are script properties, both default to the safe side, and both are flipped
from the App setup page rather than by hand.

`TEST_MODE` defaults to **on**, so a fresh deployment cannot email a customer
by accident. It changes the invoice email's recipient to `TEST_EMAIL`, marked
as what would have been sent, and (when tracking is on) holds `/t/` back from
anyone not signed in on the shop side. Everything else behaves as it will in
production — it is a rehearsal, not a mock.

`CUSTOMER_TRACKING` defaults to **off** and there is no longer any way to
turn it on from a page — the App setup card that did is gone. It survives as a
script property the backend still reads, which is what keeps `publicJob`
honest and testable. While off, the invoice email carries no link at all.

The QR code goes on the work order regardless — it is what a mechanic scans,
and `/t/` answers anyone else with the shop's phone number.

Note that `scripts/serve.mjs` rewrites `API_URL` and `SITE_URL` as it serves
`config.js`, so the local preview and `browser-check.mjs` can never reach the
shop's live backend. `config.js` holds a real deployment URL now; without that
rewrite a browser check would write jobs into the production Sheet.

## Before you push

```bash
npm run verify
```

Syntax, the customer boundary, the single `/exec` URL, the manifest's anonymous
access, and the unit tests. The deploy workflow runs exactly this and will not
deploy a tree that fails it.

For anything touching the pages, also:

```bash
npm run serve                 # in one terminal
node tools/browser-check.mjs
```
