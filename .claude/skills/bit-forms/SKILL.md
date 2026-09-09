---
name: bit-forms
description: Parsing BiT work orders and invoices — the real shape of the PDF, the two-column layout, how the customer/unit/totals blocks are found, and the parsers in assets/lib. Read before touching lines.js, parse-work-order.js, parse-invoice.js or extract.js.
---

# What a real BiT form actually looks like

**BiT is never integrated with.** No scraping, no automation, no API calls, no
matter how convenient. Every exchange is a person downloading a PDF from BiT
and uploading it here, or re-keying data from here into BiT. Parsing an
uploaded PDF is the only contact, and it is one-way.

Parsing happens **in the browser** (pdfjs), never in Apps Script. The relevant
modules — `assets/lib/lines.js`, `parse-work-order.js`, `parse-invoice.js`,
`extract.js` — import nothing, so they run in the browser and under node, which
is how the parser stays under test.

Measured from two real documents — a work order (`01-8893`) and a completed
invoice with a deposit against it (`01-7153`) — and encoded in
`scripts/lib/sample-work-order.mjs` so every test runs against the real shape.

## The shape

- **Two columns, both headings on one row.** `Sold To:` at x=31 and
  `Invoice # 01-8893` at x=218, same y. The customer block runs down the left,
  the unit down the right. Flattened into lines they read as one run-on
  sentence, which is why `labelledColumnBlock` takes the column boundary from
  the label's own row rather than guessing a width.
- **Empty fields simply do not print.** There is no placeholder text. A
  customer with no trailer has no trailer rows at all, and a unit with nothing
  filled in leaves an empty column — which `findUnitColumn` reports as missing
  rather than guessing at.

  *(An earlier note claimed BiT prints field names into empty slots. It does
  not. That form had the descriptions typed into the fields by hand to show
  what goes where. The parser still refuses to read such a row as a unit,
  because "Make Trailer" on a customer's page is worse than a blank.)*
- **A `#` is part of a heading, never a value separator.** Reading
  `Serial # Reg #` as serial="Reg #" is how "Make Trailer" got onto a job.
- **The shop's own details are on every form**, above the customer's: Quest's
  address, `815-433-2200`, `service@questwatersports.com`. Any "first phone on
  the page" fallback finds the SHOP — and then emails the shop instead of the
  customer. **Fallbacks are confined to lines below the `Sold To:` anchor.**
- **Names arrive as separate text runs** — "John" and "Purnell" at different x
  on one row — so line grouping, not the raw items, is what the parser reads.
- **The totals block is on the LAST page**, down the right, sharing rows with
  the legal text down the left. A job can carry a deposit: one real invoice
  reads Grand Total 16,917.79, Deposits 15,285.32, **Amount Due 1,632.47**. The
  balance is what the customer owes and what `parse-invoice.js` is for; the
  grand total is not, and must never sit next to a Pay button.

## `work_requested`

What the customer asked for, parsed off the body of the work order — the band
between the invoice detail row and the "I hereby authorize" boilerplate, both
of which are printed furniture and so make the band findable without knowing
what is in it.

It is the one field a mechanic needs before touching the boat, so it rides
along with `lookupJob` (a typed number means the paper is elsewhere) and with
the open-jobs list. **It is never in `missing`**: plenty of jobs are written up
with that band empty.

## Stamping

The browser opens the PDF (pdfjs) and stamps the QR onto it (pdf-lib). Apps
Script cannot do either. A **re-stamp keeps the job's existing token** — see
the `writer-portal` skill.
