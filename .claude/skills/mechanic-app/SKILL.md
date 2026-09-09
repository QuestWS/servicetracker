---
name: mechanic-app
description: Working on the mechanic's phone app (m/index.html) — the scanner, the job screen, the Hours/Parts/Notes/Prop tabs, drafts, optimistic saves, time entry, photos, voice notes, the feed, the PWA and service worker. Use for anything a mechanic sees or taps on the floor.
---

# The mechanic app

`m/index.html` — one file, plain ESM, no framework. Manifest and `sw.js` live at
the repo root. It is a phone app used standing next to a boat, often on bad
wifi, by someone who came to write rather than to read.

**Test with:** `npm run serve` in one terminal, then
`node tools/browser-check.mjs`. The mechanic sections are the bulk of it.

## The one thing that governs everything here

A mechanic who taps something and sees nothing happen assumes it worked and
walks away. Every decision below comes back to that.

## The tabs

Three log types — **Hours, Parts, Notes**, in that order. A fourth tab,
**Prop**, sits beside them and is deliberately not one of them: it writes a
PropRepairs row, not a log entry. It shares the strip because that is where a
mechanic looks for the thing they do next — as its own card below the log, it
sat under everything nobody scrolls to. The tab hides the note, recorder and
photo controls, and the one save button at the foot of the card does whatever
the current tab is for.

Customer notes were dropped; notes are the shop's own record now. The
`customer_note` type is still live in the backend and still the only thing
`customerView_` lets through, so the customer page can be switched back on
without one. Nothing in the UI creates one, so `browser-check.mjs` posts one
on the wire to keep the boundary test honest.

## Every tab keeps its own draft, and one tap saves all of them

A mechanic finishing a job puts the hours in, scans the part they used and
writes what they found, in whatever order those things happened. The strip
used to be four forms sharing one set of fields, redrawn empty on every tab
change, so two of those three were lost on the way to the third. Each tab
holds its own text, photos, recording and figures now; the strip marks the
tabs holding something; and the button says how many it is about to save.

A tab with SOME of an entry in it stops the save and names the tab —
"Parts: Scan or type the part number." Skipping it quietly would throw away
exactly the thing the mechanic thought they had written down. The saves go
out one after another rather than all at once, because they all queue on the
same script lock anyway and the feed should read in tab order.

`captureDraft()` runs before every redraw. Miss it and a part number typed on
the way to the Hours tab is gone.

## A save does not make the mechanic wait

The entry goes into the feed on the tap, marked *Saving…*, the form clears for
the next one, and the row settles when the backend answers — only the feed and
the running total are redrawn then, never the form, because by that point
somebody may be typing into it. A save that fails says **Not saved** in red
where the entry is, with a button to send it again, and says it as a toast too
in case the mechanic has walked to another screen. Nothing is ever queued past
the app closing: a note the phone swallowed is worse than one the mechanic
knows did not send.

`whatIsMissing()` says what the backend would have refused — the part number,
the time, the empty note — without a round trip. The backend is still the
authority and still checks; this is the same short list said instantly, and it
is what keeps the optimistic entry honest.

## No confirmation dialogs on this screen

**Work finished takes one tap.** There used to be a "Mark finished? Yes / Not
yet" step, and it rendered into `#notice` at the TOP of the job screen while
the button that triggers it sits at the very bottom, below the whole log. A
mechanic who had just scrolled down to tap it never saw the prompt appear
above the fold, tapped once, saw nothing change where they were looking, and
moved on — the job never actually finished, silently, which is worse than an
accidental tap would have been.

The writer can put a job back to any status from the portal, so a mis-tap is a
one-second fix there. **Before adding any confirm step to this app, check
where it renders relative to the control that triggers it.** Errors go to a
toast for the same reason.

## Time is hours and minutes, never a decimal

The sheet stores decimal hours — that is what an estimate is written in and
what gets re-keyed into BiT — but nothing adds decimals together. Every figure
goes through `minutesFromHours_` first, is summed in whole minutes, and comes
back through `hoursFromMinutes_`. Sum 0.3333 three times and a mechanic's three
twenty-minute stints come to 59 minutes.

The writer's Labor card is the one place that still shows the decimal, because
BiT will not take "2h 30m". The mechanic and the customer never see it.

Hours are **deliberately uncapped** — the same screen is used to work up an
estimate, where a figure covers a whole job rather than one stint.

## Opening a job does not fetch the log

One job's entries means reading every entry in the shop — a Sheet has no index
— and it was the largest read on the path, paid by a mechanic who opened the
job to *write*. The card says "Job log (7)" from the row's own `entry_count`
and fetches those seven through `jobLog` when somebody taps for them. Anything
saved since shows at once, fetched or not: what the mechanic just wrote is
never behind a button. `hours.total` comes off `minutes_total`; the by-person
breakdown only comes back with the log.

Props are out of the open payload for the same reason plus a simpler one: they
are drawn only inside the Prop tab, so `jobProps` runs when that tab opens.

Shrinking what the log SHOWS would save nothing — the read is the whole tab
either way. Only not asking for it saves anything.

## Who may list jobs, and who may look one up

**`openJobs` needs a signed-in mechanic; `lookupJob` does not.** Looking one
job up by its number means you are holding the work order. Listing every open
job hands over every customer's name and boat at once — same information, very
different disclosure, so the roster is the gate.

`lookupJob` **answers differently depending on who asked**, and that is the
gate rather than an optimisation: with a signed-in mechanic's token it returns
the whole job screen — the log, the hours, the props — and without one it
returns the summary and nothing else. It does that because opening a job used
to be two calls to Apps Script and the second cost more in start-up than in
reading. **Never let the anonymous branch grow the log, the customer's phone
or their email** — a test asserts each of those is absent.

## Photos, recordings and the roster

- Photos are `[{thumb, full}]` JSON in one cell — the browser uploads two
  sizes so the feed is cheap and the lightbox is sharp. Shrunk to ~200KB
  before upload; Drive is 15GB and shared with the winter app.
- Two photo buttons and two hidden inputs, rather than one input and a choice.
  Whether a bare file input offers "camera or library" is up to the phone: the
  shop's opened straight into the gallery, and before that `capture` sent it
  straight to the camera. Neither gave the mechanic the choice. **Neither
  input is the QR scanner**, which is a live `getUserMedia` stream.
- **Typed and spoken are two fields, not one.** `text` is what a person typed;
  `transcript` is what the recording said. Every recording is transcribed, and
  the transcript lands in its own column so it can never write over what
  somebody typed. Anything reading a voice note reads both.
- **Mechanics have no PIN.** They identify by name, and names are unique
  case-insensitively because the name is the whole of the identity.

## `ping` and warming

`ping` does nothing, on purpose. The app calls it as it opens and again when
the scanner comes up, so Google has a container running by the time somebody
scans. Keep it free — no sheet, no property, no credential — and keep the
app's `warm()` rate limit, or a phone in a pocket becomes a pinger.

The footer shows `4.2s · 0.6s in the sheet`: the whole round trip, and what
Apps Script spent. The gap is start-up and wifi.

## The red alert

Shown in red across the top of the job screen and on the open-jobs list, where
an alerted job also sorts to the front. **It is not dismissible from the
phone** — it comes down when the office takes it down, not when the floor taps
it away. Setting and clearing it is the writer's; see the `writer-portal`
skill.

## The service worker

There is a watchdog behind the boot and an always-present way to throw the
caches away, living outside the screen that redraws. The network wins over the
cache, so a stale module planted by an old deploy cannot stop the app starting.
`browser-check.mjs` plants one deliberately and asserts it still boots.

## Doing the work

This skill is the reference for the area, and the job runs end to end: make
the change the shop asked for, cover it with tests, and take it all the way
out. **Do not stop at a working diff** — an unshipped change helps nobody on
the floor.

When it is done, follow **[the ship procedure](../../commands/ship.md)**:
verify, browser-check if a page was touched, commit, push to the feature
branch *and* `main`, deploy only if `service-tracker.gs` changed, then report —
flagging clearly if `setup()` now has to be run.
