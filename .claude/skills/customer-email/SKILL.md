---
name: customer-email
description: Working on anything the shop mails out — the customer invoice email, its HTML and Outlook rendering, attachments and Drive links, reply-to and CC, test mode rehearsals, and the hourly notification digest. Read before touching any mail template or send path in service-tracker.gs.
---

# Email

All of it lives in the mail section of `service-tracker.gs` — `send_`,
`noticeHtml_`, `mailBox_`, `button_`, `sendInvoiceEmail_`, `logEmail_`.

**The invoice email is the only thing a customer ever receives**, and a writer
sends it by hand from a finished job. `markDone` closes the ticket and sends
nothing; `sendInvoiceEmail` is a separate call behind a separate button. Do not
put those back together, and do not attach a send to a status change or a
trigger.

## The whole email is tables, not divs, and that is not a style choice

Outlook on Windows renders mail through **Word**, which is not a browser:

- it ignores `max-width`, so a div card becomes as wide as the window;
- it drops a background colour given only in CSS, so the white card, the navy
  footer and every coloured notice came out plain white;
- it will not inherit `font-family` into a table, so half the mail arrived in
  Times New Roman.

Gmail rendered the div version beautifully, which is exactly why it survived as
long as it did. **You cannot see any of this from here** — a test asserts all
three rules.

So: every colour is a `bgcolor` attribute **as well as** a style, every cell
holding text names its own font (`MAIL_FONT`), line heights are in pixels, and
a ghost table inside an `<!--[if mso]>` conditional pins the width for Outlook.

**A button is a table** for the same reason: Outlook ignores padding on an
inline element, so an `<a>` arrives as a coloured rectangle behind the words —
a highlighted phrase rather than something to press.

## Tone

**Nothing customer-facing says "boat."** A trailer, a prop or an engine on a
stand all come through the same shop. The email says *the work you requested
has been done*, and the unit is named on its own line.

The styling copies the winter services app, down to the wordmark over the gold
rule and the navy footer, sent under the shop name with
`Reply-To: service@questwatersports.com`. **Copied convention, not shared
infrastructure** — that is a separate script, sheet and Drive folder.

## What rides along with an invoice

The invoice PDF is **always** a separate attachment. It is the document the
email is about, it is small, and a customer should never follow a link to read
their own bill.

Customer-marked files from `JobFiles` then go out too — but *how* is decided at
send time, not at upload. `MAIL_ATTACHMENT_BUDGET` (18MB) is what is left for
attachments once the invoice PDF is on the message: Gmail refuses mail over
25MB **on the wire**, where base64 makes every attachment a third bigger again,
so 18MB of actual file is roughly the ceiling.

`addJobFile` records each file's byte count (`base64Bytes_`, computed
arithmetically off the base64 string rather than by decoding it a second time)
so `sendInvoiceEmail_` can add them up without a Drive read. Files are then
taken in the order they were added: one that still fits inside what is left is
attached; one that does not — **or whose size was never recorded** — goes into
the body as a Drive link instead, named the same as it would have been
attached. An unknown size is not something to gamble the whole email on.

Nothing is ever left off silently, and the invoice never rides on whether some
other file happens to fit.

## Money

The one money figure a customer sees is **their own balance**, and only once
the job is Done. `amountDue` is the number after deposits, **never the grand
total** — deposits are normal here, boats get paid down over a winter, and one
real invoice reads Grand Total 16,917.79, Deposits 15,285.32, Amount Due
1,632.47. Never put the grand total next to a Pay button.

## Who gets a copy

The invoice email CCs `SERVICE_EMAIL` so the shop keeps a record of what each
customer was sent. It is **skipped when the desk is already the recipient** —
which is what a rehearsal is — because copying an address to itself is a
duplicate rather than a record. The email log records `to (cc ...)`.

## Test mode

`TEST_MODE` defaults to **on**, so a fresh deployment cannot email a customer
by accident. It changes the recipient to `TEST_EMAIL` and heads the mail with
who it was for. Everything else behaves as it will in production — it is a
rehearsal, not a mock.

The rehearsal subject carries a **timestamp** (`rehearsalStamp_`). Without it,
every test send of the same job had an identical subject, so Gmail stacked them
into one conversation and hid the repeated body behind its "trimmed content"
dots — which is how a re-sent rehearsal can look exactly like the one received
an hour earlier, whatever changed in between. If the shop says "the email looks
unchanged", suspect this before suspecting the deploy. What the customer gets
carries no stamp.

## The quota, and the digest

Consumer Gmail, not Workspace, and the account is shared with the winter app:
**~100 emails a day, counted per recipient.**

That is why notifications are an **hourly per-job digest** rather than one per
entry. Do not turn that back into per-entry sending. The invoice CC makes two
recipients per finished job, which at a handful of jobs a day is nothing.

`MAGIC_THROTTLE_SECONDS` keeps somebody leaning on the sign-in button from
spending the day's allowance — see the `deploy-setup` skill for that endpoint's
other rules.
