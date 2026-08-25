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
   paper. The job moves to `Work underway` on that scan. No paper to hand?
   They can type the invoice number, or pick the boat off a list of every open
   job — ticket number, customer and boat — which asks them to sign in first,
   because that list is every customer on the floor at once.
   Either way the job opens with **what needs doing** on it, read off the work
   order at intake.
5. They tap their name, then log as they go: hours and what they did with them,
   customer notes, internal notes, parts, photos — typed or spoken.
6. When the boat is physically done they mark **Work finished**.
7. **Service writer** writes the job up in BiT as today, downloads the final
   invoice, uploads it here with the POS+ payment link. The browser reads the
   totals off it — a job with a deposit against it owes nothing like its grand
   total — and the writer confirms the balance before it goes anywhere.
8. They **Mark done**, which closes the ticket and sends nothing.
9. When they want the customer to have it, they press **Email the invoice** —
   a separate, deliberate act. That email is the only thing a customer ever
   receives: the invoice PDF, the payment link, and what they actually owe.

```
Received ──scan──▶ Work underway ──mechanic──▶ Work finished ──writer──▶ Done
                                                                          └─ writer presses send
```

Status never runs backwards.

## The three faces

| Path | Who | What |
|---|---|---|
| `/admin/` | Service writer | Job list, intake, full log, close-out, mechanics roster |
| `/m/` | Mechanics | Installable PWA: scan → name → log → finish |
| `/t/?j=…` | Customer | Public, unguessable URL. Status and customer-facing notes only. **Off by default** — see below |

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
- **Deposits are normal**, so the amount due is routinely a fraction of the
  total. The customer is shown their balance, never the grand total, and the
  Pay button carries the figure. If the invoice cannot be read, the field is
  simply blank for the writer to fill — never a guessed number beside a Pay
  button.
- **Parts get asked for where they are noticed.** A mechanic logging a part can
  tick "needs ordering for this job" and "took from stock, needs restocking" —
  each asks how many and each becomes its own line on the parts list. A part
  for the shelf with no job behind it goes on the same list straight from the
  phone.
- **The parts list runs needed → ordered → received**, with a vendor and their
  order number, a note field at every stage for the things that fall outside
  the normal run, and an order archiving itself once every line on it is in.
  It lands in the service writer's inbox at 3pm daily, empty or not.
- **The writer's checklist** is three ticks per job: parts and labor logged,
  parts ordered, invoice paid and ticket closed. Ticking the first draws a line
  under everything logged so far, so anything a mechanic adds later stands out
  as still needing writing up.
- **This runs as an internal tool.** The customer tracking page is switched
  off, and nothing is ever sent automatically. See below.
- **Test mode is on until you turn it off**, so nothing reaches a customer
  while you are still finding your feet. See below.
- **The writer signs in two ways.** The portal password, or a one-time link
  mailed to the service desk — useful when nobody can remember the password.
  The link endpoint takes no recipient: the address is a constant, so it can
  only ever put mail into the shop's own inbox.
- **Nothing is queued offline.** A mechanic needs to know their note landed, so
  a failed save is a visible error, never a silent "saved".

## An internal tool, by choice

The shop runs this for itself. The customer tracking page is **off**
(`CUSTOMER_TRACKING`, which defaults to `off`), and the only thing that ever
reaches a customer is the invoice email a service writer sends by hand from a
finished job. Nothing sends on a timer, on a status change, or as a side effect
of closing a ticket — the two send sites that could reach a customer both sit
behind an admin session and a button press.

While the page is off, a customer who scans the QR code on their work order
gets a short holding message with the shop's phone number, and the invoice
email carries no tracking link.

The tracking page and everything behind it are kept whole rather than deleted,
because the decision is worth revisiting once the shop has run a season on
this. Switching it back on is one button on **App setup** and no code. The QR
code stays on the work order either way — it is what mechanics scan to open a
job on the iPad.

## Test mode

A fresh deployment also starts in test mode, and the portal says so on every
screen. Run as many real work orders through as you like: scanning, logging,
hours, photos, parts and the invoice all behave exactly as they will in
production. One thing differs:

- The invoice email you send goes to the shop instead, headed with who it was
  meant for, so you can read exactly what they would have got.

(If the tracking page is switched on, test mode also holds it back from anyone
not signed in on the shop side, while staff still see the real thing.)

Going live is one button on **App setup**. From that moment, the invoice email
you send reaches the customer. It still only goes when you press send.

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
