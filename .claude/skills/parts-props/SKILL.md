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

## Both

- **None of it reaches `/t/`** — it is all shop bookkeeping. Props are their
  own tab, `publicJob` never touches either, and a test walks a job with a prop
  out all the way to done and asserts the customer page says nothing about it.
- **A new tab needs `setup()` run once.** `sheet_` fails with "Run setup()." if
  it is missing, and the App setup page has the button.
