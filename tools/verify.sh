#!/usr/bin/env bash
# Everything that must be true before the backend can go live.
# Run it locally the same way the deploy workflow does: bash tools/verify.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '  FAIL: %s\n' "$1"; fail=1; }

echo "== backend syntax =="
if node -e "const fs=require('fs'),vm=require('vm');new vm.Script(fs.readFileSync('service-tracker.gs','utf8'))" 2>/tmp/gs.err; then
  note "service-tracker.gs parses ($(wc -l < service-tracker.gs) lines)"
else
  bad "service-tracker.gs does not parse: $(head -3 /tmp/gs.err | tr '\n' ' ')"
fi

echo "== front-end syntax =="
for f in assets/lib/*.js; do
  if node --input-type=module -e "process.exit(0)" --eval "$(cat "$f" >/dev/null; echo 0)" >/dev/null 2>&1; then :; fi
  if node --check "$f" 2>/tmp/js.err; then
    note "$(basename "$f")"
  else
    bad "$f: $(head -2 /tmp/js.err | tr '\n' ' ')"
  fi
done

# The pages carry most of the UI code in an inline <script type="module">,
# and none of it was ever parsed here. A stray backtick inside an HTML
# comment in a template literal ended the string, broke the whole module,
# and the page rendered nothing — found three minutes into a browser run
# rather than in the second this takes.
echo "== page scripts =="
for f in index.html admin/index.html m/index.html t/index.html; do
  [ -f "$f" ] || continue
  python3 - "$f" > /tmp/page.mjs <<'PY'
import re, sys
src = open(sys.argv[1]).read()
print('\n;\n'.join(re.findall(r'<script type="module">(.*?)</script>', src, re.S)))
PY
  if [ ! -s /tmp/page.mjs ]; then
    note "$f (no module script)"
  elif node --check /tmp/page.mjs 2>/tmp/js.err; then
    note "$f"
  else
    bad "$f: $(head -2 /tmp/js.err | tr '\n' ' ')"
  fi
done

echo "== the customer boundary =="
# The filter that keeps hours, parts, internal notes and mechanic names off
# the public page. If this function stops existing, or the public entry point
# stops going through it, the shop finds out from a customer.
grep -q "function customerView_" service-tracker.gs \
  && note "customerView_ present" || bad "customerView_ is missing from the backend"
grep -q "entries: customerView_(entriesForJob_(job.id))" service-tracker.gs \
  && note "publicJob feeds through customerView_" || bad "publicJob no longer filters through customerView_"
for field in mechanicName hours partIdentifier audioFile transcriptStatus; do
  if awk '/^function customerView_/,/^}/' service-tracker.gs | grep -q "$field"; then
    bad "customerView_ mentions $field — the customer must never see it"
  fi
done
note "customerView_ leaks none of: mechanicName, hours, partIdentifier, audioFile, transcriptStatus"

# The job alert is a Jobs column, not a log entry, so customerView_ never sees
# it — publicJob is what keeps it in the building, by naming the columns it
# returns one at a time instead of handing back the row. That is easy to
# "tidy up" into a spread years from now, and the customer would then be
# reading "do not start, owner is disputing the estimate" about their own boat.
if awk '/^function publicJob/,/^}/' service-tracker.gs | grep -q "alert"; then
  bad "publicJob mentions the job alert — it is shop-only and must never reach /t/"
fi
awk '/^function publicJob/,/^}/' service-tracker.gs | grep -q "job: {" \
  && note "publicJob still names the customer's fields one at a time, and none of them is the alert" \
  || bad "publicJob no longer builds the customer payload field by field"

echo "== the one shared URL =="
# API_URL lives in exactly one file so the four pages cannot drift apart.
hits=$(grep -rl "script.google.com/macros" --include=*.js --include=*.html . 2>/dev/null | grep -v node_modules | grep -v '^./assets/lib/config.js' | wc -l)
[ "$hits" = "0" ] && note "the /exec URL appears only in assets/lib/config.js" \
  || bad "the /exec URL is hard-coded outside assets/lib/config.js in $hits file(s)"

echo "== deploy manifest =="
[ -f apps-script/appsscript.json ] \
  && note "apps-script/appsscript.json present" \
  || bad "apps-script/appsscript.json is missing — pushing without it can change the web app's access settings"
grep -q '"access": "ANYONE_ANONYMOUS"' apps-script/appsscript.json \
  && note "web app stays reachable without a Google login" \
  || bad "the manifest no longer grants anonymous access — the customer page would ask for a Google login"

# If this section fails for no visible reason and passes on a re-run, check
# whether tools/browser-check.mjs was running at the same time. Twice now the
# suite has reported a failure with no diff in the tree, both times with
# Chromium driving five browser contexts on the same machine — a starved
# vitest worker, not a broken test. The deploy workflow runs this alone on a
# clean runner and has never flaked. Do not run them side by side.
echo "== unit tests =="
if npm test --silent >/tmp/test.out 2>&1; then
  note "$(grep -Eo 'Tests +[0-9]+ passed' /tmp/test.out | tail -1)"
else
  bad "npm test failed:"; tail -15 /tmp/test.out
fi

echo
[ "$fail" = "0" ] && echo "verify.sh: OK" || echo "verify.sh: FAILED"
exit "$fail"
