---
name: writer-portal
description: Working on the service writer's portal (admin/index.html) — the jobs list and its sorting, the job page, intake and re-stamping work orders, the red alert, job attachments, the close-out checklist, and moving or deleting misfiled log entries. Use for anything the office sees.
---

# The service writer's portal

`admin/index.html` — password → 12-hour sealed token in localStorage. This is
the office side: one person at a counter, on a laptop or an iPad, usually with
a customer in front of them.

**Test with:** `npm run serve`, then `node tools/browser-check.mjs`.

## The jobs list

Defaults to **Open jobs**, and open means *not (done AND paid)* — see
`isOpenJob_`. Not simply "not done": a closed ticket the customer has not
settled is still the writer's problem, and it is the one most easily lost,
because the work is over and nothing else will bring it back to their
attention. Ticking paid is what takes a job off the list; untick it and the job
comes back.

The chip order is Open jobs, the four statuses, **All**, Done. All sits next to
Done at the far end on purpose: those two are what you go looking for, not what
you should land on. Open carries no query parameter, being the default, so `?`
is the working list and `?status=all` is everything.

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

## The job page

Two columns. Left is Customer & boat, Parts, Close out checklist, Close out.
Right is For the mechanic, Paperwork, Attachments, what the customer owes,
Labor, Props, Shop log, Timeline, Email log. `browser-check.mjs` asserts the
two end up **roughly level** — neither is expected to match the other exactly,
but one running to twice the other is the shape of the bug, and the left column
used to hold every form on the page and run several screens past the right.

The **mail log is not deferred**, unlike the timeline. The page reads it to
know whether the invoice has already gone, and that is what the send button
hangs off — defer it and the button lies until somebody clicks Show. Only the
timeline moved, behind `jobHistory`.

`work_requested` is what the customer asked for, parsed off the body of the
work order — see the `bit-forms` skill. It is never in `missing`: plenty of
jobs are written up with that band empty.

## Re-stamping a work order

A customer adds to the job after the sheet is printed, so the writer changes it
in BiT and drops the new PDF on the job page. **It is stamped with the same QR
as the first copy**, so anything already in the folder still opens the job —
this is the same reason `SITE_URL` can never change. `attachWorkOrder` replaces
the stored file and touches nothing else.

A PDF whose invoice number reads as a *different* job is refused: this job's QR
on another job's paper sends a mechanic to the wrong boat. One with no text
layer is allowed through with a note, because it proves nothing either way.
The description off the new copy is **offered, not applied** — the writer may
have already typed a better version by hand.

## The red alert

A per-job `alert` (plus `alert_at`), set and cleared from the job page, shown
in red across the top of the mechanic's job screen and on the open-jobs list,
where an alerted job also sorts to the front — an alert nobody sees until they
have already picked the job is half an alert.

- **It is not another kind of note.** A note is a line in a feed that a busy
  mechanic scrolls past. This is for "do not start — the owner is disputing the
  estimate". Because it is that loud it is meant to be taken down once acted
  on, and the card says so. Setting one also writes it into the shop log, so
  the record survives the banner coming down.
- It is not dismissible from the phone.
- **It never reaches `/t/`.** It is a Jobs column, so `customerView_` never
  sees it — what keeps it in the building is that `publicJob` names the
  customer's fields one at a time instead of handing back the row.
  `tools/verify.sh` fails the deploy if `publicJob` so much as mentions it.
- `setJobAlert` calls `requireColumn_` before writing, because the column only
  exists once somebody has run `setup()`. Without that the alert would save,
  read back as undefined and never appear — and the writer would have no way to
  tell that from a mechanic ignoring it.

## Documents on a job

Anything that belongs on a job and is neither the work order nor the invoice:
a photo of what was found, a supplier's quote. Its own tab, `JobFiles`.

- **`visibility` is decided when the file is added and never inferred later.**
  A `customer` file is attached to the invoice email when the writer presses
  send; an `internal` one never leaves the building. Anything the backend
  cannot read as exactly `customer` is internal — the failure that matters is a
  supplier's cost sheet going out with an invoice, not a photo the customer has
  to ask twice for.
- The page makes that the *action* rather than a setting: two buttons,
  **Attach for the customer** and **Keep internal**, and which one you press is
  the choice. A default nobody notices is how the wrong file gets sent.
- **None of it reaches `/t/`.** It is not a log entry, `publicJob` never
  touches the tab, and a test asserts a customer-marked file is absent from the
  customer payload.
- Removing one **bins the Drive file rather than destroying it**. This is the
  writer undoing a wrong upload; Drive keeps a binned file for thirty days.
- **Upload is capped at 25MB, and that is the only cap** — a file goes to Apps
  Script base64-encoded inside one POST, a third bigger than the file itself,
  and past that size the request is refused before the script runs. Whether it
  is small enough to *email* is decided at send time instead; see the
  `customer-email` skill.

## The close-out checklist

**"Parts and labor logged" is not a job flag.** It stamps `logged_at` on each
entry, so anything a mechanic adds afterwards shows up below the line as still
needing writing up. Parts-ordered and paid/closed are job flags.

**`markDone` sends nothing.** Closing a ticket and emailing a customer are two
deliberate acts behind two buttons.

## Fixing a misfiled entry

The office can move a log entry to another work order, or delete it. The floor
cannot: `deleteEntry` and `moveEntry` are writer-only, because a mechanic
unsaying something the shop has already read and acted on is a different thing
from correcting a mistake.

- **Both totals move.** `adjustJobEntryTotals_` is the one place that changes
  `entry_count`/`minutes_total` in either direction. That is the whole reason
  this cannot be a hand edit in the Sheet.
- **A parts-list line goes with the entry.** On a move it follows, or it sits
  on the wrong customer's order. On a delete it goes too — but only while it is
  still `needed`. An entry whose part has actually been ordered refuses to
  delete and says to deal with the parts list first.
- **Photos and recordings stay put until 2am.** Moving Drive files is several
  slow calls each and the writer is standing at a counter, so `moveEntry`
  stamps `files_job` with the folder the files are actually in and the
  `nightly` trigger walks them over. The links work either way — every job
  folder is link-shared and the entry carries the file ids — so this is about
  filing, not access. `files_job` empty means nothing to do, which is the
  answer for every entry that has never moved, and moving one back before the
  sweep runs clears it. The sweep is capped per night so a backlog cannot spend
  the day's trigger runtime in one go.
- The move target is given as the number off the paper, through
  `jobByNumber_`, so `01-8886`, `018886` and `8886` all find it and an
  ambiguous suffix finds nothing.
