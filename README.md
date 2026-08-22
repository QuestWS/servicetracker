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
2. They upload it at **/admin/**. Their own browser reads the invoice number,
   customer and unit off the PDF, they confirm what was found, and the browser
   stamps a QR code onto the same document. Job status: `Received`.
3. They print that copy and put it in the folder, same as today.
4. **Mechanic** opens the app on their phone and scans the QR straight off the
   paper. The job moves to `Work underway` on that scan.
5. They tap their name, then log as they go: hours and what they did with them,
   customer notes, internal notes, parts, photos — typed or spoken.
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
| `/admin/` | Service writer | Job list, intake, full log, close-out, mechanics roster |
| `/m/` | Mechanics | Installable PWA: scan → name → log → finish |
| `/t/?j=…` | Customer | Public, unguessable URL. Status and customer-facing notes only |

### The customer never sees

Internal notes, labor hours, part numbers, quantities, who logged what, or any
pricing — at any status. Before `Done` there is no invoice and no payment link
either. That boundary lives in one function, `customerView_`, and is checked
three ways: a backend unit test, a rendered-page assertion, and a grep in
`tools/verify.sh` that fails the deploy if the filter goes missing.

## How it is put together

Nothing here costs anything to run, and nothing needed approving to start.

```
GitHub Pages ──── the four pages, static
      │
      │  POST {fn, token, args} as text/plain
      ▼
Apps Script ───── the whole backend, one /exec endpoint
      ├── Google Sheets   the database
      ├── Google Drive    photos, voice notes, PDFs
      └── Gmail           the customer email and the hourly digest
```

**The PDF work happens in the browser.** Apps Script cannot open a PDF, and the
service writer is already sitting at a machine that can — so their browser
parses the work order and stamps the QR, and the backend only ever stores the
finished bytes. It also makes intake feel instant.

**Files are stored "anyone with the link"**, the same arrangement the shop
already uses for unit photos. What protects a file is that its id is
unguessable *and* that ids are only handed out by the visibility rule: the
customer page is sent ids for photos on customer notes and, once done, the
invoice — nothing else.

## Running it locally

```bash
npm install
npm run serve                 # http://localhost:8787
node tools/browser-check.mjs  # drives the whole flow in a real browser
```

`npm run serve` executes the actual `service-tracker.gs` through a stubbed Apps
Script environment, so the pages talk to the real backend logic. Data is in
memory and gone when you stop it.

```bash
npm test            # the parser, the tracking tokens, the QR, the backend
npm run verify      # everything the deploy workflow checks
```

Deployment — both halves, and the rule about never minting a new `/exec` URL —
is in [docs/DEPLOY.md](docs/DEPLOY.md).

## Notes worth having read

- **Hours are uncapped.** The same screen gets used to work up an estimate,
  where a figure covers a whole job rather than one stint at the bench.
- **Sign-in is typing your name.** There is no PIN: the app is reached from a
  QR code on a work order already sitting in the shop, so a secret there would
  guard a door that is propped open anyway. The name is for attributing the
  log. "Remember me" keeps a mechanic signed in on their own phone; left
  unticked, the shared iPad forgets them at the end of the shift.
- **Notifications are an hourly digest**, one email per job covering everything
  new. A consumer Gmail account sends about a hundred messages a day, and a
  busy Saturday of per-entry emails would eat that and then fail silently.
- **Voice notes** go to AssemblyAI in the background; the audio is kept either
  way, and the words fill in underneath the entry when the transcript lands.
- **Nothing is queued offline.** A mechanic needs to know their note landed, so
  a failed save is a visible error, never a silent "saved".

## Relationship to the winter services app

This is a separate project from `QuestWS/winter-quotes_26-27`: its own repo,
own spreadsheet, own Drive folder, own Apps Script deployment, no shared code.
What is shared is the house style — the navy/frost/gold palette, the card and
pill shapes, the email layout — copied deliberately so the two apps look like
one shop, and the Google account itself, which means a shared Drive quota and a
shared daily Gmail send limit.

## Deliberately not here

No parts catalog, inventory or pricing. No writing back into BiT. No payment
integration — the POS+ link is generated by hand in POS+ and pasted in.
