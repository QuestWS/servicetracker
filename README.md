# Quest Watersports — Service Tracker

Work order intake, shop-floor logging, and a live customer status page for
service jobs at Quest Watersports (Ottawa, IL).

The shop runs on **BiT Dealership Software**, which has no API, no data export
and no template control. Every integration point here works around that the
same way: a human downloads a PDF from BiT and uploads it, or re-keys data from
here back into BiT. Nothing in this app talks to BiT, and nothing should be
added that tries to.

## What it replaces

Mechanics get a paper work order printed from BiT, write hours, parts and notes
on it by hand, and hand it in at the end of the job for the office to re-key.
Nobody — the owner or the customer — can see where a job stands while it is in
progress.

This app adds a QR code to that same piece of paper. The paper habit does not
change; the logging does.

## The flow

1. **Service writer** creates the job in BiT as normal and downloads the work
   order PDF.
2. They upload it at **/admin/intake**. The invoice number, customer and unit
   are read off the PDF's text layer, they confirm what was found, and the app
   returns the same document with a QR code stamped on it. Job status:
   `Received`.
3. They print that copy and put it in the folder, same as today.
4. **Mechanic** opens the app on their phone, scans the QR straight off the
   paper. The job moves to `Work underway` on that scan.
5. They tap their name (or type it once), then log as they go: hours and what
   they did with them, customer notes, internal notes, parts, photos — typed
   or spoken.
6. When the boat is physically done they mark **Work finished**.
7. **Service writer** writes the job up in BiT as today, downloads the final
   invoice, uploads it here with the POS+ payment link.
8. They **Mark done**. That is the one moment a customer-facing email fires:
   tracking link, invoice PDF, payment link.

```
Received ──scan──▶ Work underway ──mechanic──▶ Work finished ──writer──▶ Done
                                                                          └─ customer email
```

Status never runs backwards.

## The three faces

| Path | Who | What |
|---|---|---|
| `/admin` | Service writer | Job list, intake, full log, close-out, mechanics roster |
| `/m` | Mechanics | Installable PWA: scan → name → log → finish |
| `/t/<token>` | Customer | Public, unguessable URL. Status and customer-facing notes only |

### The customer never sees

Internal notes, labor hours, part numbers, quantities, who logged what, or any
pricing — at any status. Before `Done` there is no invoice and no payment link either.
That boundary is enforced in the query (`listCustomerEntries`), not in the
template, and it is covered by tests.

## Running it

```bash
npm install
cp .env.example .env      # fill in APP_URL, ADMIN_PASSWORD, SESSION_SECRET
npm run build
npm start                 # http://localhost:3000
```

Then, in the portal: **Mechanics** → add the crew so they have a name to tap;
**App setup** → the one-time QR and install instructions for their phones.

Development: `npm run dev`. Tests: `npm test`. Types: `npm run typecheck`.

### Requirements

- Node 22+, and a host that keeps a **persistent disk** — the database and every
  photo, recording and PDF live under `DATA_DIR`. This does not run on a
  serverless host.
- **HTTPS in production.** Camera and microphone access are blocked on plain
  HTTP everywhere except `localhost`, so the scanner simply will not start.
- One instance. Transcription polling and the PIN rate limiter both hold state
  in process, and SQLite wants a single writer.

### Backups

`DATA_DIR` is the whole system: `servicetracker.db` plus `uploads/`. Copy it
somewhere else on a schedule. Use `sqlite3 servicetracker.db ".backup out.db"`
rather than copying the file out from under a running server.

## Configuration

Every setting, with notes, is in [`.env.example`](.env.example). The two that
bite hardest:

- `APP_URL` is baked into printed QR codes. Get it right before the first work
  order is stamped, or the printed sheets point at the wrong host.
- `SMTP_PASS` on a free Gmail account must be an **App Password**.

Mail goes out under the shop name from the SMTP account, with replies routed
to `service@questwatersports.com` — the same arrangement the winter services
app uses, so both send like one shop.

Missing mail or AssemblyAI credentials never break a save: the entry is stored,
the audio is kept, and the skipped email is recorded in the job's email log
with the reason.

## How the pieces work

- **PDF parsing** (`src/lib/pdf/`) reads positioned text runs from the work
  order, rebuilds visual lines, and reads labelled blocks *per column* — a BiT
  work order puts "Sold To:" and the unit details side by side, and flattened
  into lines they read as one run-on sentence. Anything it cannot find is
  reported, never guessed, and the service writer confirms every field before
  the job is created.
- **The QR stamp** goes in the emptiest corner of page one, scored against the
  text already there, so the original document is untouched underneath.
- **Scanning** uses the browser's built-in `BarcodeDetector` where it exists
  (Android Chrome) and lazily loads ZXing where it does not (Safari, so: the
  shop iPad). Manual entry of the invoice number sits on the same screen, not
  behind a menu.
- **Voice notes** upload to AssemblyAI in the background — the mechanic never
  waits on the network. The raw audio is kept on the job either way, and a
  transcript still in flight when the server restarts is picked back up at boot.
- **Hours** are logged as the mechanic finishes each stint, with a line saying
  what the time went on — typed, or dictated like any other note, in which case
  the hours count immediately and the words fill in when the transcript lands.
  They total up on the job, and that total with the parts is what the service
  writer keys into BiT at invoicing time.
- **Nothing is queued offline.** A mechanic needs to know their note landed, so
  a failed save is a visible error, never a silent "saved".

### Who logged it

A mechanic signs in by tapping their name, or typing it the first time. There
is no PIN and no password: the app is reached from a QR code on a work order
already sitting in the shop, so a secret on the sign-in screen would guard a
door that is propped open anyway — what the name is for is attributing the log.
"Remember me" keeps a mechanic signed in on their own phone for a month; left
unticked, the shared shop iPad forgets them at the end of the shift.

A name nobody has used before joins the roster rather than being turned away —
nobody should be stuck behind an admin screen with a boat in front of them. The
service writer can rename anyone (their entries follow the rename) or switch
someone off, which refuses that name at sign-in.

## Relationship to the winter services app

This is a separate project from `QuestWS/winter-quotes_26-27`: its own repo,
own database, own deployment, no shared code or infrastructure. What is shared
is the house style — the navy/frost/gold palette, the card and pill shapes, the
type stack — copied deliberately so the two apps look like one shop, and the
credentials in `.env`, if convenient.

## Deliberately not here

No parts catalog, inventory or pricing. No writing back into BiT. No payment
integration — the POS+ link is generated by hand in POS+ and pasted in.
