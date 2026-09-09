# Quest Watersports Service Tracker — working notes

Read [README.md](README.md) first for what this is. This file is what every
session needs: the rules that are dangerous to break, the shape of the repo,
and where to find the rest.

**The detail lives in skills, so a session only pays for the part it is
touching.** Load the one that matches the work before you start — see
[Where the rest lives](#where-the-rest-lives).

## Hard rules

These apply everywhere and are not negotiable by any skill.

1. **BiT is never integrated with.** No scraping, no automation, no API calls,
   no matter how convenient. Every exchange is a person downloading a PDF from
   BiT and uploading it here, or re-keying data from here into BiT.
2. **Never "New deployment."** It mints a new `/exec` URL, orphaning all four
   pages and every QR code already printed on paper. Update the existing
   deployment — the Actions workflow is built so you cannot do otherwise.
3. **`SITE_URL` is printed onto paper.** Changing it after work orders are in
   the folder invalidates every QR code already printed. Same reason a
   re-stamp keeps the job's existing token.
4. **This is an internal tool, and customer tracking is scrapped.** The only
   thing a customer ever receives is the invoice email a writer sends by hand
   from a finished job. `markDone` closes the ticket and sends nothing;
   `sendInvoiceEmail` is a separate call behind a separate button. Do not put
   those back together, and do not add a send to a status change or a trigger.

   **Nothing any user sees may mention a customer tracking page.** Not the
   portal, not the mechanic app, not the landing page, not `/t/`, not an
   email. `publicJob`, `customerView_` and `setCustomerTracking` are still in
   the backend and still guarded — dead but benign, and still tested on the
   wire so the boundary cannot rot. Nothing calls them from a page. `/t/`
   itself still has to answer, because the QR code on every printed work order
   points at it and that paper cannot be recalled; it answers with the shop's
   phone number.
5. **The customer sees customer notes and nothing else.** Internal notes,
   labor hours, part numbers, quantities, mechanic names, prop repairs, job
   attachments and the shop's own figures never reach `/t/`, at any status.
   The filter is `customerView_`, it is the only thing `publicJob` returns
   entries through, and `tools/verify.sh` **fails the deploy** if either stops
   being true. If a new field is added to a log entry, decide its visibility
   there, not in a page template.

   The one money figure they see is **their own balance**, and only once the
   job is Done — at which point they are being handed the invoice anyway.
   `amountDue` is the number after deposits, **never the grand total**.
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

## Two data rules that break things silently

Full detail in the `backend-data` skill, but these bite from anywhere:

- **Column order is append-only.** `SHEETS` at the top of the backend is the
  schema; `appendRow_` and `updateRow_` index by that array, so a new column
  goes on the **END**. A column the header does not have yet reads back empty —
  the feature saves and then simply does not work, with no error. **Any deploy
  that adds a column, a tab or a trigger needs `setup()` run once**, and the
  App setup page has the button.
- **Every cell is written as plain text.** A BiT invoice number is `01-8891`,
  and a General-formatted cell turns that into the first of January, 8891 — so
  the primary key comes back as a `Date` and every lookup misses.

## Where the rest lives

Load the skill that matches before changing anything in its area. Each one
carries the reasoning, the traps, and how to test that area.

| Skill | Load it when you are touching |
|---|---|
| `mechanic-app` | `m/index.html` — the scanner, job screen, tabs, drafts, saves, time entry, photos, the PWA |
| `writer-portal` | `admin/index.html` — jobs list and sorting, job page, re-stamping, the red alert, attachments, close out, fixing misfiled entries |
| `parts-props` | the parts list, stock requests, order lifecycle, the archive table, props out for repair |
| `customer-email` | anything mailed out — the invoice email, Outlook rendering, attachments vs Drive links, CC, test mode, the digest |
| `backend-data` | read/write paths in `service-tracker.gs` — schema, locking, the row cache, Drive, transcripts, speed |
| `deploy-setup` | deploying, `setup()`, the two switches, script properties, sign-in and the magic link, triggers, quotas |
| `bit-forms` | the BiT PDF shape and the parsers in `assets/lib` |

**When the change is done, run `/ship`** — verify, browser-check, commit, push
to the feature branch *and* `main`, deploy only if the backend changed, and say
whether `setup()` now has to be run. The skills point at it too, so naming an
area is a whole job rather than a reading list.

Longer-form documents, for when a skill points at one:

- [docs/DEPLOY.md](docs/DEPLOY.md) — first-time setup and the deploy workflow
- [docs/FASTER.md](docs/FASTER.md) — the performance measurements and the plan
- [docs/VPS.md](docs/VPS.md) — what moving off Apps Script would involve

## Facts established with the shop

The handful that come up everywhere:

- **BiT invoice numbers are never recycled.** That is what makes the number
  safe as a job's primary key.
- **Hours are deliberately uncapped.** The same screen is used to work up an
  estimate, where a figure covers a whole job rather than one stint.
- **Deposits are normal.** Boats get worked on over a winter and paid down as
  they go, so the amount due is routinely a fraction of the total.
- **Nothing customer-facing says "boat."** A trailer, a prop or an engine on a
  stand all come through the same shop.
- **Mechanics have no PIN.** They identify by name, and names are unique
  case-insensitively because the name is the whole of the identity.

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

Never run the browser check alongside `verify`, and restart the preview server
first — it holds its data in memory.
