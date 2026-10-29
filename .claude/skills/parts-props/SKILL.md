---
name: parts-props
description: Working on the parts list or props out for repair — ordering parts, stock requests, the order lifecycle and vendor batching, the archived-parts table, and propellers away at the prop shop. Covers both the mechanic's request side and the writer's ordering side.
---

# Parts, and props out for repair

Two floor-to-office handoffs with a batch step in the middle. They look alike
and are deliberately not the same thing.

Backend: `PartsOrders` and `PropRepairs` tabs. Pages: the parts list and the
props list in `admin/index.html`, the Parts and Prop tabs in `m/index.html`.

## Parts

- A **part entry** can carry two extra asks: order one for this job, and put
  one back on the shelf. Both are separate `PartsOrders` rows against the same
  entry, because they are two different things to buy.
- A **stock request** has no job behind it. The part number is asked for but
  not enforced — somebody at an empty hook with only a description still gets
  it onto the list. **Do not add `required` to that field.**
- Order lines go `needed` → `ordered` (with a vendor and that vendor's order
  number) → `received`. An order is finished, and moves to completed, only when
  **every line sharing its order number** is in.
- **A completed order can be filed away or deleted.** Filing is the normal one:
  the parts list is a working list, and a year of finished orders buried under
  it makes the three lines that still need doing hard to find. An archived part
  keeps everything and moves to `?view=archive`; `archived_at` is a flag, not a
  status, so nothing about the order grouping changes.

  Deleting is for the duplicate row, not for tidying history — it asks first,
  and only ever touches parts that have arrived. Anything still needed or on
  order goes through `cancelPartOrder`, which refuses to lose a placed order.
- **The archive is a table, and the only one in the app.** Everything else is a
  list of cards because everything else is read one item at a time; the archive
  is read by scanning a column for a supplier or a name. It searches and sorts
  on part, customer, supplier and work order — in the browser, off one fetch,
  because Apps Script charges per round trip and a query per keystroke would be
  unusable.
- `deletePartsOrders` removes rows **highest-first**. Deleting row 4 shifts row
  5 up into its place, so an ascending loop takes out the wrong rows from the
  second one onward; there is a test with two orders that catches exactly that.
  `deleteRow` has to call `forget_` itself, because it goes around
  `appendRow_`/`updateRow_`.
- The parts list is mailed at 3pm by `sendDailyOrders`.

## Props out for repair

A propeller off a customer's boat, away at the prop shop and back again. It
mirrors the parts list and differs in the two ways that matter.

- **A photograph of the tag is the identity.** A prop has no barcode and no
  part number. What tells the prop shop whose it is, and tells the writer which
  boat it goes back on, is the paper tag wired to it — so the mechanic
  photographs the tag and that photo leads every row on both screens.

  It is asked for, **not insisted on**: like the stock request's part number, a
  description alone still gets a prop onto the list, because a mechanic holding
  a prop and a camera that will not focus should not be stuck.
- **The stages are its own**: `ready` → `picked_up` → `fixed` *or*
  `unfixable`. Not the parts lifecycle reworded. A part is bought and arrives;
  a prop is the customer's own property leaving the building, and it can come
  back unusable — which is a real ending, and the one that means somebody has a
  phone call to make. So `unfixable` is a status, not a failed `returned`.
- It goes out in a batch against whoever collected it, the way parts go on an
  order against a vendor. Once it has left it can no longer be pulled off the
  list — only marked returned.
- **The floor creates one; the office moves it along.** `addPropRepair` needs a
  signed-in mechanic, everything after it needs the writer, and `listProps` is
  writer-only for the same reason `openJobs` is gated: it is every customer's
  name and boat in one list.
- On the phone the Prop tab is **not a log entry type** — it writes a
  PropRepairs row. It hides the note, recorder and photo controls, and it is
  fetched by `jobProps` only when that tab opens.

## Customer parts orders

Somebody buying parts, not leaving anything to be worked on. Rung up in BiT as
an ordinary invoice, downloaded, and dropped on **New parts order** in the
portal (`?view=neworder`). Listed under **Parts orders** in the menu (`?view=orders`).

- **It is a Jobs row with `kind = 'parts'`**, not a tab of its own. That is
  the whole design: payments, receipts, the texted invoice page, archiving,
  statements and the open rule (`isOpenJob_`) all work on it unchanged. A
  row with `kind` empty is a work order — every row from before the column.
- **Same status column, its own words** (`ORDER_STATUS_LABEL` in the
  backend and `entry-types.js`): `received` is Ordered, `work_finished` is
  Arrived, `done` is Picked up. `work_underway` never happens — nothing scans
  an order.
- **It never reaches the floor.** `openJobsFromSheet_` leaves it out and
  `lookupJob` refuses its number with a message saying what it is. The Jobs
  page leaves it off its list and its counts; `listJobs` still returns it,
  and the portal sorts by `kind` itself.
- **The part lines are read in the browser** by `parseInvoiceItems` (see
  `bit-forms`). They are kept as text in `work_requested`, which is what the
  arrival email lists, and the ones the writer ticks go on the parts list
  against the order, so they are bought from a supplier in the normal batch.
- **Money is not gated on Picked up.** `recordPayment` refuses a work order
  that is not done, but an order is its own finished invoice from the start —
  parts are paid up front, at collection, or some of each. Its receipt
  always carries the invoice PDF.
- **Telling the customer is its own button**, never a side effect of Mark
  arrived: `sendArrivalEmail`, or `invoiceText` worded "ready for pick-up"
  and sent from BiT. Both are refused until the order has arrived. The
  "service complete" invoice email is refused for an order altogether.
- **A receipt can go out at any stage**, and the usual one is the day it is
  paid for, while the parts are still on order: `sendOrderReceipt` by email
  (with the invoice attached), or `invoiceText(id, 'receipt')` for the writer
  to copy into BiT. Both say what was ordered, what has been paid (the
  invoice's deposits plus anything recorded here, `orderPaid_`) and where
  the order is. Neither changes the order. The texted page answers for an
  order at every stage for that reason.
- **Cancelling is its own step, never a negative payment.** `recordPayment`
  still refuses a negative line: balance is amount due less what was
  collected, so a refund on its own reads as the whole order owed again and
  a statement goes chasing a customer who was just paid back.
  `cancelPartsOrder` records the refund as a negative Payments row (how,
  reference, date), stamps `cancelled_at`, keeps `cancel_note` (what anything
  not refunded is for, shown to the customer: "return shipping"), files any
  refund receipts as customer files, closes the order (done + paid), and
  takes unbought lines off the parts list. A cancelled order's balance is 0
  by definition (`jobBalance_`). It sends nothing.
- **The process after a cancellation is the receipt buttons.** On a
  cancelled order they send the settlement: paid, refunded, kept and what
  for, nothing owed, with the invoice and every customer file attached
  (`orderSettlement_`). The texted page shows the same and lists the receipts.
  Arrival and further payments are refused.
- **Adding `kind` means `setup()` has to be run once.** So did
  `cancelled_at` and `cancel_note`. `createPartsOrder`
  calls `requireColumn_` first — without the column every order would save
  as a work order and land on the mechanics' phones.

## Both

- **None of it reaches `/t/`** — it is all shop bookkeeping. Props are their
  own tab, `publicJob` never touches either, and a test walks a job with a prop
  out all the way to done and asserts the customer page says nothing about it.
- **A new tab needs `setup()` run once.** `sheet_` fails with "Run setup()." if
  it is missing, and the App setup page has the button.

## Doing the work

This skill is the reference for the area, and the job runs end to end: make
the change the shop asked for, cover it with tests, and take it all the way
out. **Do not stop at a working diff** — an unshipped change helps nobody on
the floor.

When it is done, follow **[the ship procedure](../../commands/ship.md)**:
verify, browser-check if a page was touched, commit, push to the feature
branch *and* `main`, deploy only if `service-tracker.gs` changed, then report —
flagging clearly if `setup()` now has to be run.
