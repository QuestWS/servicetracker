# Deploying

Two halves, deployed separately. Neither costs anything.

| Half | Lives on | How it deploys |
|---|---|---|
| The four pages | GitHub Pages | Commit to `main` — Pages serves the repo |
| The backend | Google Apps Script | Actions → **Deploy Apps Script** → Run workflow |

Everything runs inside the shop's existing `questwsottawa@gmail.com` account. No
card, no subscription, nothing to approve.

---

## The rule that matters most

**Never use "New deployment."** It mints a new `/exec` URL, which orphans all
four pages *and* every QR code already printed on paper in the job folder.
Always update the **existing** deployment.

The GitHub Actions workflow enforces this — it calls `clasp update-deployment`
against a fixed `DEPLOYMENT_ID` and cannot create a new one.

---

## First-time setup

### 1. Create the Apps Script project

1. Go to <https://script.google.com>, signed in as `questwsottawa@gmail.com`.
2. **New project**. Name it `Quest Service Tracker`.
3. Paste the whole of `service-tracker.gs` over the editor contents. **Save.**

### 2. Run `setup()` once

Pick `setup` from the function dropdown and **Run**. Approve the permission
prompt (it needs Sheets, Drive, Gmail and external requests).

It creates the spreadsheet, the Drive folder and the hourly trigger, then logs
the URLs. Safe to re-run: it repairs missing tabs without touching data.

### 3. Set the script properties

**Project Settings → Script properties → Add script property:**

| Property | Value |
|---|---|
| `ADMIN_PASSWORD` | the service writer portal password |
| `ASSEMBLYAI_API_KEY` | the AssemblyAI key (optional — without it, voice notes keep the audio but get no text) |
| `WEB_APP_URL` | the `/exec` URL from step 4, so AssemblyAI can call back |
| `SITE_URL` | where GitHub Pages serves the four pages |
| `TEST_EMAIL` | where a held customer email goes to be read (defaults to the service desk) |

Two more decide the posture. Both have safe defaults, so neither needs setting
on a fresh deployment:

| Property | Default | What it does |
|---|---|---|
| `TEST_MODE` | `true` | The invoice email you send goes to `TEST_EMAIL`, not the customer |
| `CUSTOMER_TRACKING` | `off` | The customer page answers a holding message to anyone but staff |

Both are switched from **App setup** in the portal rather than here.

**Credentials only ever live here.** Nothing in this repo holds a password or a
key, and nothing should — the repo is public.

### 4. Deploy the web app

**Deploy → New deployment → Web app.** This is the *only* time you use "New
deployment".

- Execute as: **Me**
- Who has access: **Anyone** — the customer page has no Google login, so this
  is required. It is not optional and not a mistake.

Copy the `/exec` URL. Put it in two places:

1. `assets/lib/config.js` → `API_URL`, then commit. It appears in exactly this
   one file so the four pages cannot drift apart.
2. The `WEB_APP_URL` script property from step 3.

### 5. Turn on GitHub Pages

**Settings → Pages → Source: Deploy from a branch → `main` / root.**

The site lands at `https://questws.github.io/servicetracker/`. If that is not
the URL, fix `SITE_URL` in `assets/lib/config.js` — it is what gets printed
into every QR code.

### 6. Wire up the deploy workflow

So future backend changes go out from GitHub instead of copy-paste.

**Get a clasp credential** (on any machine with node):

```bash
npx @google/clasp@3.3.0 login
# sign in as questwsottawa@gmail.com, then:
base64 -w0 ~/.clasprc.json
```

Copy everything between the BEGIN and END markers below — and nothing else.
`base64 -w0` prints no trailing newline, so it is easy to copy the shell
prompt along with it, which is the usual cause of a failed deploy.

```
--- BEGIN, copy after this line ---
<the base64 output>
--- END, copy before this line ---
```

**Settings → Secrets and variables → Actions:**

| Kind | Name | Value |
|---|---|---|
| Secret | `CLASPRC_JSON` | the base64 blob above |
| Variable | `SCRIPT_ID` | Apps Script → Project Settings → Script ID |
| Variable | `DEPLOYMENT_ID` | Deploy → Manage deployments → the deployment's ID |
| Variable | `REMOTE_FILE_NAME` | the file name in the editor, usually `Code` |

**Capture the live manifest** so a push cannot silently change the web app's
access settings:

```bash
npx @google/clasp@3.3.0 pull
cp appsscript.json apps-script/appsscript.json   # commit this
```

---

## Deploying a backend change after that

1. Commit the change to `service-tracker.gs`.
2. **Actions → Deploy Apps Script → Run workflow.**
3. Describe what changed. It shows up in the Apps Script version list.
4. Mode:
   - `push-and-deploy` — cuts an immutable version and points the existing
     deployment at it. The `/exec` URL does not change.
   - `push-only` — uploads the code without making it live.

`tools/verify.sh` runs first. A tree that fails it never reaches the shop.

**Rolling back:** Apps Script → Deploy → Manage deployments → pencil → pick an
older version from the dropdown. Every deploy leaves a numbered version behind
precisely so this is one click.

### Deploying a page change

Commit. Pages picks it up in a minute or two. Hard-refresh (Ctrl+Shift+R) or
the browser serves you a cached copy and you debug a ghost.

---

## New Google capabilities

If a change starts using a Google service the project has not touched before,
run any function that reaches it **once from the editor** and approve the
prompt, *then* deploy. Otherwise it fails silently at runtime for everyone.

---

## Checking it works

```bash
npm install
npm run serve          # http://localhost:8787, real backend, in-memory data
node tools/browser-check.mjs
```

`npm run serve` runs the actual `service-tracker.gs` through a stubbed Apps
Script environment, so the pages talk to the real backend logic without
touching Google. `browser-check.mjs` drives the whole flow in a real browser —
intake, logging, and the customer boundary.

---

## What to watch after go-live

- **Gmail sends about 100 messages a day** on a consumer account. The digest is
  hourly and per job precisely to stay well under that. If the shop ever gets
  busy enough to approach it, lengthen the digest interval rather than removing
  the cap.
- **Drive is 15 GB, shared with Gmail** and with the winter services app.
  Photos are shrunk to about 200 KB before upload, so a season of jobs is a
  fraction of it — but it is shared, so it is worth a look each spring.
- **The hourly trigger** shows its runs in Apps Script → Executions. If digests
  stop arriving, that is the first place to look.
