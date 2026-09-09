---
description: Take the change that has just been made all the way out — verify, browser-check, commit, push and deploy — and report what the shop needs to do.
---

# Ship it

Run this end to end without stopping to ask. Everything here has been done the
same way on every change to this repo; the gates below are what make that safe.

**Stop and ask only if:** `verify` or the browser check fails in a way the
change did not cause, the change turns out to need a schema migration nobody
asked for, or shipping would break a hard rule in CLAUDE.md.

## 1. Prove it before anybody sees it

**If `service-tracker.gs` was edited, syntax-check it first.** A stray
apostrophe inside a single-quoted string breaks the whole file and every one of
the 250 tests at once:

```bash
node -e "new Function(require('fs').readFileSync('service-tracker.gs','utf8'))" && echo SYNTAX_OK
```

**Cover the change.** A backend change gets unit tests in `tests/`; anything a
person sees or taps gets checks in `tools/browser-check.mjs`. Assert the
*settled* state, never the absence of something — a page that is still loading
also lacks the thing you are looking for, and that race has produced false
passes here more than once.

```bash
npm run verify          # syntax, the customer boundary, one /exec URL, unit tests
```

**If any page was touched**, also run the browser check — on a freshly started
preview server, never alongside `verify`, because the server holds its data in
memory:

```bash
npm run serve                 # background it
node tools/browser-check.mjs  # must end "browser-check: all good"
```

Do not proceed on a red run.

## 2. Commit

Write the message the way the repo does: a short imperative subject, then what
changed **and why it was the right call** — the reasoning is the thing worth
keeping. End with the attribution footer given in this session's instructions.

## 3. Push to both

```bash
git push -u origin claude/quest-watersports-tracker-spec-nm2s9o
git push origin claude/quest-watersports-tracker-spec-nm2s9o:main
```

Both, every time. The pages are served from `main` by GitHub Pages, so a page
change that only reaches the feature branch never reaches the shop. Fetch
`main` first if the fast-forward is refused; never force-push.

## 4. Deploy — only if the backend changed

```bash
git diff HEAD~1 --stat        # did service-tracker.gs change?
```

- **`service-tracker.gs` unchanged** → nothing to deploy. The static pages go
  out through GitHub Pages on their own. Say so rather than deploying anyway.
- **`service-tracker.gs` changed** → run the **Deploy Apps Script** workflow
  (`deploy-apps-script.yml`) against `main`. Both inputs are required:
  `description` (what changed, shown in the Apps Script version list) and
  `mode` (`push-and-deploy`).

Then confirm the run actually succeeded before reporting it. The workflow
updates the existing deployment and cannot mint a new `/exec` URL — that rule
is enforced by the tool, not by memory.

## 5. Report, and say what the shop has to do

Lead with what changed in plain terms — the shop reads this, not a changelog.
Then flag anything that needs a person:

- **`setup()` must be run** if the change added a **column, a tab or a
  trigger**. Say it plainly and near the top: until it is run the feature saves
  and silently does not work. Point at the portal's **App setup → "Bring the
  sheet up to date"** button, not at script.google.com.
- Anything the writer or the mechanics will see differently.
- Anything deliberately left out, and why.

Say what was verified, plainly — "250 unit tests, verify, 253 browser checks" —
without hedging and without inflating it.

## Keeping the session cheap

This repo is large and the point of the skills is to not read what you do not
need:

- **Never read a big file whole.** `grep -n` for the symbol, then read the
  narrow range around it. `service-tracker.gs` is ~3,700 lines and
  `admin/index.html` and `tools/browser-check.mjs` are both large.
- **Do not re-run a tool that returned a huge payload.** The GitHub Actions
  list tool answers with ~67KB of JSON; it gets saved to a file, so parse that
  file instead of calling it again.
- **Pipe long output through `tail`** rather than printing it whole.
