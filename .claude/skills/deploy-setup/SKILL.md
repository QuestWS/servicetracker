---
name: deploy-setup
description: Deploying the backend, running setup() after a schema change, the TEST_MODE and CUSTOMER_TRACKING switches, portal sign-in and the magic link, script properties, scheduled triggers and Google quotas. Read before deploying, before adding a column or trigger, or when touching auth.
---

# Deploying, setup, switches and quotas

Full first-time instructions are in **[docs/DEPLOY.md](../../../docs/DEPLOY.md)**.

Two halves, deployed separately, neither costing anything:

| Half | Lives on | How it deploys |
|---|---|---|
| The four pages | GitHub Pages | commit to `main` |
| The backend | Google Apps Script | Actions → **Deploy Apps Script** → Run workflow |

## Never "New deployment"

It mints a new `/exec` URL, which orphans all four pages **and every QR code
already printed on paper**. Always update the existing deployment. The Actions
workflow enforces this — it calls `clasp update-deployment` against a fixed
`DEPLOYMENT_ID` and cannot create a new one.

`assets/lib/config.js` holds that URL and is the **only** place it appears;
`verify.sh` fails if it turns up anywhere else, because four pages drifting
onto different backends is a bad afternoon.

## Running setup() without opening Apps Script

Every deploy that adds a column, a tab or a trigger needs `setup()` run once.
`sheetStatus` says whether the sheet is behind, and the App setup page has the
button next to it: `runSetup` is `setup()` behind the writer's password. Safe
to press twice — setup() only ever adds what is missing.

It **answers rather than throws** when it fails part way, and that is the point
of the shape. `ensureSheets_` runs before `installTriggers_`, so a script never
authorised to create a trigger from a web app still gets its columns — the page
says which half landed instead of showing a red banner that makes it look as
though nothing did. Installing a trigger is the one step a web app may not be
authorised for; running `setup` once from the editor grants it for good.

**Nobody should have to find a function in a dropdown on script.google.com to
finish a deploy.**

## The two switches

Both are script properties, both default to the safe side, both flipped from
the App setup page rather than by hand.

**`TEST_MODE` defaults to on**, so a fresh deployment cannot email a customer
by accident. It changes the invoice email's recipient to `TEST_EMAIL`, marked
as what would have been sent, and (when tracking is on) holds `/t/` back from
anyone not signed in on the shop side. Everything else behaves as it will in
production — a rehearsal, not a mock.

**`CUSTOMER_TRACKING` defaults to off** and there is no longer any way to turn
it on from a page — the App setup card that did is gone. It survives as a
script property the backend still reads, which is what keeps `publicJob` honest
and testable. While off, the invoice email carries no link at all.

The QR code goes on the work order regardless — it is what a mechanic scans,
and `/t/` answers anyone else with the shop's phone number.

## Script properties

`ADMIN_PASSWORD`, `ASSEMBLYAI_API_KEY`, `TOKEN_SECRET`, `SPREADSHEET_ID`,
`DRIVE_FOLDER_ID`, `WEB_APP_URL`, `TEST_MODE`, `TEST_EMAIL`,
`CUSTOMER_TRACKING`, `MAGIC_NONCE`, `MAGIC_EXP`, `MAGIC_SENT_AT`.

**No credential ever lands in this repo. It is public.** The code only ever
names them.

## Signing in to the portal

Two ways, both landing on the same 12-hour sealed token:

- **`ADMIN_PASSWORD`**, compared **case-insensitively and trimmed**: the shop
  types it on a phone and a counter iPad, where the keyboard capitalises the
  first letter on its own. `setAdminPassword` accepts five characters and up,
  at the shop's request.

  That is a deliberately weak door, and worth being honest about: five
  lower-cased characters is guessable, `adminSignIn` has no throttle, and
  behind it are customer names, phone numbers and addresses. **What actually
  keeps people out is that the `/exec` URL is not published anywhere. If that
  ever stops being true, add a throttle before anything else.**
- A one-time link mailed to `SERVICE_EMAIL` by `requestMagicLink`.

That second one is an **unauthenticated endpoint that sends mail**, so three
properties hold it together and none is optional:

1. **It takes no recipient.** The address is the `SERVICE_EMAIL` constant.
   Never add a parameter for it — that turns a sign-in helper into something
   that posts mail to whoever asks.
2. **One link outstanding at a time**, in `MAGIC_NONCE`/`MAGIC_EXP`. Asking for
   a new one voids the last; using one clears it.
3. **A wrong guess does not consume the nonce.** Only success and expiry do.
   Clearing it on a mismatch would let anyone void the writer's real link by
   posting rubbish at the endpoint — a denial of service, which is the actual
   threat here, since a 20-character base32 nonce is not going to be guessed.

## The three triggers

| When | Function | Does |
|---|---|---|
| hourly | `hourly()` | transcript sweep + per-job notification digest |
| 3pm daily | `sendDailyOrders()` | the parts list |
| 2am daily | `nightly()` | files the moved Drive files, capped at 40 |

## Quotas to respect

Consumer Gmail, not Workspace, and the account is shared with the winter app:

- **~100 emails a day**, counted per recipient. This is why notifications are
  an hourly per-job digest rather than one per entry. See the `customer-email`
  skill.
- **15 GB of Drive**, shared. Photos are shrunk to ~200 KB before upload.
- **90 minutes of trigger runtime a day.** One hourly trigger does both the
  transcript sweep and the digest for that reason. Put housekeeping in
  `nightly` at 2am, where slow costs nothing, rather than into the hourly.

## The local preview cannot reach production

`scripts/serve.mjs` rewrites `API_URL` and `SITE_URL` as it serves
`config.js`, so the preview and `browser-check.mjs` can never reach the shop's
live backend. `config.js` holds a real deployment URL; without that rewrite a
browser check would write jobs into the production Sheet.

## Doing the work

This skill is the reference for the area, and the job runs end to end: make
the change the shop asked for, cover it with tests, and take it all the way
out. **Do not stop at a working diff** — an unshipped change helps nobody on
the floor.

When it is done, follow **[the ship procedure](../../commands/ship.md)**:
verify, browser-check if a page was touched, commit, push to the feature
branch *and* `main`, deploy only if `service-tracker.gs` changed, then report —
flagging clearly if `setup()` now has to be run.
