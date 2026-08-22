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
3. **The customer sees customer notes and nothing else.** Internal notes,
   labor hours, part numbers, quantities, mechanic names and pricing never
   reach `/t/`, at any status. The filter is `customerView_`, it is the only
   thing `publicJob` returns entries through, and `tools/verify.sh` fails the
   deploy if either of those stops being true. If a new field is added to a log
   entry, decide its visibility there, not in a page template.
4. **`SITE_URL` is printed onto paper.** Changing it after work orders are in
   the folder invalidates every QR code already printed.
5. **No credential ever lands in this repo.** It is public. Passwords and API
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

- Photos are `[{thumb, full}]` JSON in one cell — the browser uploads two sizes
  so the feed is cheap and the lightbox is sharp.
- A fourth entry type, `labor`, carries `hours` plus what the time went on.
  Like `part` it is internal-only; `addEntry` pins `hours` to `''` for every
  other type so the figure cannot ride along on a customer note.
- Mechanics have no PIN. They identify themselves by name, and names are unique
  case-insensitively because the name is the whole of the identity.

## What a real BiT form actually looks like

Measured from a real invoice (`Invoice_018893`), and encoded in
`scripts/lib/sample-work-order.mjs` so every test runs against the real shape:

- **Two columns, both headings on one row.** `Sold To:` at x=31 and
  `Invoice # 01-8893` at x=218, same y. The customer block runs down the left,
  the unit fields down the right. Flattened into lines they read as one run-on
  sentence, which is why `labelledColumnBlock` takes the column boundary from
  the label's own row rather than guessing a width.
- **No colons on the unit fields.** An empty unit prints as `Year Make Model`,
  `Serial # Reg #`, `Eng Make Eng Model Eng Serial #` — the field NAMES sit in
  the empty slots. A `#` is part of the heading, never a value separator:
  reading `Serial # Reg #` as serial="Reg #" put "Make Trailer" on a job.
- **The shop's own details are on every form**, above the customer's:
  Quest's address, `815-433-2200`, `service@questwatersports.com`. Any
  "first phone on the page" fallback finds the SHOP — and then emails the shop
  instead of the customer. Fallbacks are restricted to lines below the
  `Sold To:` anchor for exactly this reason.
- **`Invoice #` appears twice**, top right and again in the table row, which
  makes the invoice number the most reliable field on the document.

Still unconfirmed: **where a filled-in unit's values land.** The one real
sample had a blank unit. `findUnitColumn` assumes the values replace the
headings in the same slots, which is the likely reading — if a filled work
order ever parses oddly, start there.

## Facts established with the shop

- **BiT invoice numbers are never recycled.** That is what makes the number
  safe as a job's primary key.
- **Hours are deliberately uncapped.** The same screen is used to work up an
  estimate, where a figure covers a whole job rather than one stint.
- **Customer email is copied from the winter services app**, down to the
  wordmark over the gold rule and the navy footer, sent under the shop name
  with `Reply-To: service@questwatersports.com`. Copied convention, not shared
  infrastructure — a separate script, sheet and Drive folder.
- **Drive files are link-shared**, matching how the shop already handles unit
  photos. See the comment on `saveFile_` for what actually protects them.

## Quotas to respect

Consumer Gmail, not Workspace, and the account is shared with the winter app:

- **~100 emails a day.** This is why notifications are an hourly per-job digest
  rather than one per entry. Do not turn that back into per-entry sending.
- **15 GB of Drive**, shared. Photos are shrunk to ~200 KB before upload.
- **90 minutes of trigger runtime a day.** One hourly trigger does both the
  transcript sweep and the digest, for that reason.

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
