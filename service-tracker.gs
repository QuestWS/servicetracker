/************************************************************************
 * Quest Watersports — Service Tracker backend
 *
 * The whole server side: Sheets as the database, Drive for photos, voice
 * notes and PDFs, Gmail for the two kinds of mail this system sends.
 *
 * The four pages on GitHub Pages talk to this file and nothing else, over a
 * single endpoint: POST for everything, and GET as a second road for a few
 * reads (see serve_ and API_GET_FNS_). Deploy notes and the one-time setup are in
 * docs/DEPLOY.md — read that before touching a deployment.
 *
 * ── WHAT THIS FILE MUST NEVER DO ──────────────────────────────────────
 * 1. Reach into BiT. Every exchange with BiT is a person downloading a PDF
 *    and uploading it here, or re-keying what they read here back into BiT.
 * 2. Show a customer anything but customer notes. See customerView_().
 * 3. Open a PDF. The service writer's browser parses and stamps work
 *    orders; this file only ever stores the bytes it is handed.
 ************************************************************************/

/* ============================= diagnostics ============================= */

/**
 * RUN THIS FROM THE EDITOR when somebody says "it's slow". First function in
 * the file on purpose: the Apps Script editor's function dropdown lists them
 * in file order, and there are hundreds below.
 *
 * `serverMs` on every answer says how long a call took. It cannot say which
 * road the call took inside the script — whether the batch read ran or
 * quietly fell back, whether the cache answered. This times each road on its
 * own and prints the lot to the execution log. If every number here is small
 * and the phone's footer still says thirty seconds, the time is between the
 * phone and Google, not in this file.
 *
 * It writes nothing: no row, no property, no cache entry. It reads the one
 * job it looks up by its token and never "scans" it, so nothing advances.
 */
function diagnoseSpeed() {
  const lines = [];
  const time = function (label, work) {
    const started = Date.now();
    let note = '';
    try {
      note = work() || '';
    } catch (err) {
      note = 'FAILED: ' + (err && err.message ? err.message : err);
    }
    lines.push(('      ' + (Date.now() - started)).slice(-6) + ' ms  ' + label + (note ? '  — ' + note : ''));
  };
  const cold = function () { forget_(); };

  time('ping (the empty call)', function () { apiFns_({}).ping([]); });
  time('script properties, all of them (what props_ reads once)', function () {
    return Object.keys(PropertiesService.getScriptProperties().getProperties() || {}).length + ' properties';
  });
  time('one getDataRange().getValues() on Jobs', function () {
    return sheet_('Jobs').getDataRange().getValues().length + ' rows';
  });
  time('one values.batchGet, Jobs + LogEntries', function () {
    if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets) return 'the Sheets advanced service is OFF — every batch read falls back';
    const answer = Sheets.Spreadsheets.Values.batchGet(ss_().getId(), { ranges: ["'Jobs'", "'LogEntries'"] });
    return (answer.valueRanges || []).length + ' ranges';
  });
  time('prefetch_ for the job page, then rows_ on each', function () {
    cold();
    const tabs = JOB_PAGE_TABS_;
    prefetch_(tabs);
    const batched = tabs.filter(function (name) { return _rowCache[name]; }).length;
    tabs.forEach(function (name) { rows_(name); });
    return batched === tabs.length ? 'batched' : 'FELL BACK to one read per tab (' + batched + '/' + tabs.length + ' batched)';
  });
  time('openJobs, from the sheet', function () {
    cold();
    return openJobsFromSheet_().jobs.length + ' open';
  });
  time('openJobs, from the cache', function () {
    const hit = cachedOpenJobs_();
    return hit ? hit.jobs.length + ' open, cache HIT' : 'cache miss (nothing cached, or a save since)';
  });
  time("the writer's jobs list, from the sheet", function () {
    cold();
    return jobsListFromSheet_({ status: 'all' }).jobs.length + ' jobs';
  });
  let sample = null;
  time("the writer's job page for one job, cold", function () {
    cold();
    sample = rows_('Jobs')[0];
    if (!sample) return 'no jobs to open';
    forget_();
    getJob(seal_({ role: 'admin', exp: Date.now() + 60000 }), sample.id);
    return sample.id;
  });
  time('lookupJob for one job, cold', function () {
    cold();
    sample = rows_('Jobs')[0];
    if (!sample) return 'no jobs to look up';
    forget_();
    lookupJob(sample.token, 'diagnose', '');
    return sample.id;
  });

  const report = 'diagnoseSpeed, ' + new Date().toISOString() + '\n' + lines.join('\n');
  Logger.log(report);
  return report;
}

/* ============================ configuration ============================ */

/** Tabs are created on first run by setup(); see ensureSheets_(). */
const SS_NAME = 'Quest Service Tracker';
const DRIVE_FOLDER_NAME = 'Quest Service Tracker Files';

/** Where the four pages are served from — used to build printed QR links. */
const SITE_URL = 'https://questws.github.io/servicetracker';

const SHOP_NAME = 'Quest Watersports';
const SHOP_PHONE = '(815) 433-2200';
/** Whose name a note from the office is logged under. */
const SHOP_WRITER_NAME = 'Service writer';
const SHOP_ADDRESS = '1800 N 2871st Rd, Ottawa, IL 61350';

/** Customer replies land here, and so does the hourly digest. */
const SERVICE_EMAIL = 'service@questwatersports.com';

/**
 * Copied on the office's email whenever a customer accepts, declines or asks
 * for a call about a detail quote — John prices and does the details. Chris,
 * Nov 2026. Shop mail only: never a customer, never a recipient anybody can
 * set from a page.
 */
const DETAIL_ALERT_EMAIL = 'john@questwatersports.com';

/**
 * Where a statement sends somebody to pay, instead of any one job's own POS+
 * link. A statement can bundle several invoices, and no individual job's
 * link is right for all of them — this is the shop's own payment page, not
 * tied to a particular ticket.
 */
const STATEMENT_PAYMENT_URL = 'https://pay.pospluslogin.com/questws';

/**
 * Where a customer is sent to leave a Google review, when a service writer
 * ticks the box on a payment email. One tap, straight onto the stars.
 *
 * The place id is the shop's own, derived from the ftid in its Google Maps
 * URL (0x88095499531e717d:0x7d6123427197748a) rather than looked up: a
 * ChIJ... id is just those two 64-bit halves in a small protobuf, base64url
 * encoded. Public, like STATEMENT_PAYMENT_URL above — nothing secret lives
 * in this file.
 *
 * Two other shapes were considered:
 *
 *   - The Business Profile's own https://g.page/r/.../review. Equally direct,
 *     and fine to paste into App setup if it ever turns up — but that profile
 *     sits on the owner's personal Google account and was not to hand.
 *   - https://www.google.com/search?kgmid=/g/1thkxvf7, the shop's knowledge
 *     panel. Rejected on merit: it opens a PAGE, and the customer still has
 *     to find "Write a review" on it. writereview opens the box itself.
 *
 * ── A WARNING ABOUT TESTING THIS, WHICH COST A DAY ────────────────────
 * Clicking a review link in a sample email sent from OUTSIDE this app — the
 * Gmail API, a hand-composed message, anything not sent by Apps Script — lands
 * on a Google "Redirect Notice" warning page instead of the destination.
 *
 * That is an artefact of the test, NOT of the link. Gmail wraps every link it
 * renders as google.com/url?q=... and forwards silently only when the wrapper
 * carries a valid usg= signature; the out-of-band samples got no signature, so
 * EVERY link in them stopped at the warning — including a POS+ payment link
 * that works perfectly in the invoice email this app sends.
 *
 * Three "fixes" were shipped chasing this before that control was run: the
 * knowledge-panel link, then writereview, then a redirect page on the shop's
 * own domain. None of them was fixing anything. If a link looks broken in a
 * sample, send a real one from the portal in test mode BEFORE touching the
 * code — it arrives via service@ and renders the way a customer's will.
 *
 * Still overridable from App setup, for the day the g.page link turns up or
 * the listing moves.
 */
const GOOGLE_REVIEW_URL =
  'https://search.google.com/local/writereview?placeid=ChIJfXEeU5lUCYgRinSXcUIjYX0';

/**
 * The link in force: what the shop saved, or the fallback above if they never
 * saved anything.
 *
 * Reads the property for PRESENCE rather than truth. A saved empty string is
 * the shop deliberately turning the ask off, and `||` would have quietly
 * handed the fallback straight back — so clearing it would not have cleared
 * it. Never saved at all is null, and that is the only case the default
 * applies to.
 */
function reviewUrl_() {
  const saved = props_().getProperty('GOOGLE_REVIEW_URL');
  if (saved === null || saved === undefined) return GOOGLE_REVIEW_URL;
  return String(saved).trim();
}

/**
 * Whether a review link opens the review box itself, or merely the listing.
 *
 * Decides one sentence in the email. A g.page/r/ link drops the customer on
 * the star rating with the keyboard up; the kgmid fallback drops them on a
 * page where "Write a review" is one more thing to spot. Telling somebody to
 * look for a button that is not there is worse than saying nothing, so the
 * sentence is attached to the link that needs it rather than written into the
 * template for good.
 */
function directReviewLink_(url) {
  return /^https:\/\/(g\.page\/r\/|search\.google\.com\/local\/writereview)/i.test(String(url || ''));
}

/**
 * The line that goes on every customer email about finished work, review
 * request or not.
 *
 * The shop's own words, and the point of them is that it is the same
 * invitation for the customer who is delighted and the one who is not. A
 * review request is a choice a writer makes per send; this is not.
 */
const FEEDBACK_LINE = 'If there was any part of your experience that wasn\u2019t up to your ' +
  'expectations, please reply to this email and let us know!';

/**
 * Optional: after adding a "Send mail as" alias in this Google account's
 * Gmail settings, put that address here so mail comes from a
 * questwatersports.com address instead of the Gmail one. '' sends as the
 * account. This mirrors the winter services app's FROM_ALIAS.
 */
const FROM_ALIAS = '';

/** The Quest mark, embedded in every email. Same file the winter app uses. */
const LOGO_URL = SITE_URL + '/assets/quest-wordmark.png';

/**
 * Test mode. ON until somebody deliberately turns it off, so a fresh
 * deployment cannot email a customer by accident while the shop is still
 * finding its feet.
 *
 * What it changes, and only this:
 *   - The customer's "job is done" email goes to TEST_EMAIL instead, marked
 *     as what WOULD have been sent, so it can be read and checked.
 *   - The public tracking page shows a holding notice to anyone who is not
 *     signed in on the shop side. Staff still see the real thing, so the page
 *     can be debugged against live jobs.
 *
 * What it does NOT change: everything else. Jobs, scanning, logging, hours,
 * photos, the invoice, the status lifecycle and the hourly digest all behave
 * exactly as they will in production — otherwise it would not be a rehearsal.
 */
function testMode_() {
  return String(props_().getProperty('TEST_MODE') || 'true') !== 'false';
}

/** Where a suppressed customer email goes so somebody can read it. */
function testEmail_() {
  return props_().getProperty('TEST_EMAIL') || SERVICE_EMAIL;
}

/**
 * The customer tracking page. OFF by default: the shop runs this as an
 * internal tool, and the only thing a customer ever receives is the invoice
 * email a service writer sends by hand.
 *
 * The page and everything behind it are kept whole rather than deleted, so
 * turning it back on is one script property and no code. While it is off,
 * `publicJob` answers a holding notice to anyone who is not shop staff, and
 * the invoice email carries no tracking link.
 *
 * The QR code on the work order stays either way — it is what a mechanic
 * scans to open the job on the iPad.
 */
function customerTracking_() {
  return String(props_().getProperty('CUSTOMER_TRACKING') || 'off') === 'on';
}

/** Hours a mechanic stays signed in: their own phone vs the shared iPad. */
const REMEMBER_DAYS = 30;
const SHIFT_HOURS = 10;

const STATUSES = ['received', 'work_underway', 'work_finished', 'done'];
const STATUS_ORDER = { received: 0, work_underway: 1, work_finished: 2, done: 3 };
const STATUS_LABEL = {
  received: 'Received',
  work_underway: 'Work underway',
  work_finished: 'Work finished (pending invoice)',
  done: 'Done'
};
/**
 * A customer's parts order runs on the same Jobs row and the same status
 * column as a work order, so payments, receipts, the texted invoice page,
 * archiving and statements all work on it unchanged. Only the words differ:
 * nobody works on anything, a part is ordered, arrives and is collected.
 * `work_underway` never happens to an order — nothing scans one.
 */
const ORDER_STATUS_LABEL = {
  received: 'Ordered',
  work_underway: 'Ordered',
  work_finished: 'Arrived',
  done: 'Picked up'
};
/** Why a part is on the list. */
/**
 * Where a prop is in its trip out of the building.
 *
 * Not the parts lifecycle with different words. A part is ordered and arrives;
 * a prop is the customer's own, it leaves, and it may come back unusable — at
 * which point somebody has to ring the owner about a new one. So "unfixable"
 * is an ending in its own right, not a failure state of "returned".
 */
const PROP_STATUS = ['ready', 'picked_up', 'fixed', 'unfixable'];

const PROP_STATUS_LABEL = {
  ready: 'Ready for pick-up',
  picked_up: 'Picked up',
  fixed: 'Returned — fixed',
  unfixable: 'Returned — unfixable'
};

/**
 * How a payment came in. The list exists because a receipt that says
 * "payment received" and nothing else is no use to a customer reconciling
 * their own card statement — "Visa ending 4412" is.
 *
 * `card` is the only one that normally has a receipt of its own to attach;
 * the rest are recorded for the shop's record and named on the email.
 */
const PAYMENT_METHODS = ['card', 'cash', 'check', 'transfer', 'other'];

const PAYMENT_METHOD_LABEL = {
  card: 'Card',
  cash: 'Cash',
  check: 'Check',
  transfer: 'Bank transfer',
  other: 'Other'
};

const PART_REASON_LABEL = {
  job: 'For this job',
  restock: 'Restock',
  stock: 'Stock'
};

/**
 * Time, in hours and minutes.
 *
 * The sheet stores decimal hours and always has — it is what an estimate is
 * written in and what gets re-keyed into BiT — but nothing in this file adds
 * decimals together. Every figure is turned into whole minutes first, added
 * there, and turned back. Sum 0.3333 three times and a mechanic's three
 * twenty-minute stints come to 59 minutes; sum 20 three times and they come
 * to the hour they actually worked.
 *
 * These are duplicated from assets/lib/entry-types.js on purpose: Apps Script
 * has no imports, and the two copies are pinned together by a unit test.
 */
function minutesFromHours_(hours) {
  const number = Number(hours);
  return isFinite(number) ? Math.round(number * 60) : 0;
}

/** 4dp holds any whole number of minutes exactly enough to survive the trip. */
function hoursFromMinutes_(minutes) {
  return Math.round((Number(minutes) / 60) * 10000) / 10000;
}

/** "2h 30m", "45m", "3h" — how the shop says it, everywhere it is shown. */
function formatDuration_(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return m + 'm';
  if (!m) return h + 'h';
  return h + 'h ' + m + 'm';
}

const ENTRY_LABEL = {
  customer_note: 'Customer note',
  internal_note: 'Internal note',
  // The office writing to the floor: "the owner wants a call before you pull
  // the lower unit". Shop-only, like everything except customer_note —
  // customerView_ filters on that one type, so this is excluded from the
  // customer page by construction rather than by remembering to exclude it.
  writer_note: 'From the office',
  labor: 'Labor',
  part: 'Part'
};

/** Column order per tab. Adding a column means adding it to the END here. */
const SHEETS = {
  Jobs: ['id', 'token', 'customer_name', 'customer_phone', 'customer_email', 'boat_info',
         'status', 'needs_review', 'work_order_file', 'invoice_file', 'payment_link',
         'created_at', 'updated_at', 'work_started_at', 'work_finished_at', 'done_at',
         'grand_total', 'deposits', 'amount_due',
         'parts_ordered_at', 'paid_at', 'work_requested', 'alert', 'alert_at',
         // Running totals, so the jobs list and a save never have to read
         // every log entry in the shop to count this job's. Repaired by
         // recountJobTotals_ from setup(), which is also what backfills them.
         'entry_count', 'minutes_total',
         // What has actually been collected against this invoice, summed off
         // the Payments tab. Derived, exactly like entry_count above: the
         // jobs list, the statements page and every balance shown to a
         // customer need it, and none of them may pay for a read of every
         // payment in the shop to get one job's. recountJobPayments_ backfills
         // it and puts it right if it ever drifts.
         'paid_total',
         // The code in the link a customer is texted. Short enough to ride in
         // an SMS next to everything else that has to be said, and minted
         // only for a job somebody actually texts — see invoiceCodeFor_.
         'invoice_code',
         // Filed away by the writer: off every list but Archived. A stamp,
         // not a status — the job is still done, still paid or not, and
         // restoring it puts it back exactly where it was. See archiveJobs.
         'archived_at',
         // What sort of ticket this is. Empty is a work order, which is every
         // row written before the column existed. 'parts' is a customer's
         // parts order: a BiT invoice for parts they are buying, with no
         // mechanic and no boat in the shop — see createPartsOrder.
         'kind',
         // A parts order the customer called off, and when. A stamp rather than
         // a status: the order still went through Ordered, maybe Arrived, and
         // the refund is a row on Payments. See cancelPartsOrder.
         'cancelled_at',
         // What the shop kept on a cancelled order is for, in words the
         // customer is shown: "return shipping", "restocking fee".
         'cancel_note',
         // A walk-in winterize: the checklist the writer chose at intake and
         // what the mechanic has ticked, as one JSON object. Empty on every
         // other job. See setJobWinter. Shop-side only.
         'winter_work',
         // Who has work on this ticket: '' the mechanic alone (every job
         // before this column), 'detail' the detailer alone, 'both' each their
         // own half. See setJobDetail and the Detail Tracker section.
         'detail_split',
         // Each half marked done, on a split ticket. The job reaches Work
         // finished only when both are stamped.
         'mech_done_at', 'detail_done_at'],
  LogEntries: ['id', 'job_id', 'mechanic_id', 'mechanic_name', 'entry_type', 'text', 'hours',
               'part_identifier', 'quantity', 'audio_file', 'photos', 'transcript_status',
               'transcript_id', 'transcript_error', 'notified_at', 'created_at',
               'logged_at',
               // The words off the recording, kept apart from `text` because
               // `text` is what a person typed. A mechanic who records AND
               // types has said two things, and a transcript landing in the
               // same cell would have wiped one of them out.
               'transcript',
               // Which job's Drive folder this entry's photos and recording
               // are actually sitting in, and ONLY while that is not the job
               // the entry is on. Empty means they are where they belong,
               // which is the answer for every entry that has never moved.
               'files_job',
               // The id the PHONE gave this entry, before it ever reached the
               // wire. It is what makes a retry safe: the app now keeps an
               // unsent entry in an outbox on the device and sends it again
               // when it next opens, which means the same note can arrive
               // twice — once from a request whose answer was lost, once from
               // the retry. Hours are money, so a second copy is not a
               // cosmetic problem. See the duplicate check in addEntry.
               'client_id'],
  // A part somebody needs: off a work order, or a bare stock request. One row
  // per part; rows ordered together share a vendor and order number, and the
  // group is done when every row in it has been received.
  PartsOrders: ['id', 'job_id', 'source_entry', 'part_identifier', 'description', 'quantity',
                'reason', 'status', 'vendor', 'order_number', 'notes', 'requested_by',
                'created_at', 'ordered_at', 'received_at', 'archived_at'],
  // A propeller off a boat, away at the prop shop. Deliberately its own tab
  // rather than a PartsOrders row: a prop is not bought, it is the customer's
  // own part leaving the building and coming back, and its stages say so.
  // What identifies it is a photograph of the tag tied to it, not a number.
  PropRepairs: ['id', 'job_id', 'tag_photo', 'description', 'status', 'vendor',
                'notes', 'requested_by', 'created_at', 'picked_up_at', 'returned_at',
                // Same as on LogEntries: a prop goes through the same outbox
                // and can be sent twice for the same reason.
                'client_id'],
  // Documents on a job that are not the work order and not the invoice: a
  // photo of the damage for the customer, a supplier quote for the shop.
  // `visibility` is the whole point of the tab — see addJobFile.
  // `size` is the file's own byte count, written at upload. The invoice email
  // needs it to decide attach-or-link, and it is recorded rather than read
  // back off Drive so deciding costs nothing — a file too big to attach is
  // never downloaded to find that out.
  JobFiles: ['id', 'job_id', 'name', 'mime', 'drive_file', 'visibility',
             'added_by', 'created_at', 'size'],
  // Money actually collected against an invoice, one row per payment.
  //
  // Its own tab rather than a column on Jobs because a boat is routinely paid
  // down in pieces — a card at the counter and a check in the post is one
  // afternoon here — and "how was it paid" is the question a customer asks
  // back. `batch` is what ties the payments a writer recorded in one go, and
  // emailed in one receipt, back together afterwards.
  //
  // `amount` is what was taken, never a running balance: a balance is derived
  // from the invoice, and a stored one goes stale the moment anything else
  // changes.
  Payments: ['id', 'job_id', 'batch', 'amount', 'method', 'reference', 'received_at',
             'note', 'recorded_by', 'created_at'],
  Mechanics: ['id', 'name', 'active', 'created_at'],
  StatusEvents: ['id', 'job_id', 'from_status', 'to_status', 'actor_type', 'actor', 'note', 'created_at'],
  EmailLog: ['id', 'job_id', 'kind', 'recipient', 'subject', 'status', 'error', 'created_at',
             // The writer's own note, if one went in this email — what the
             // customer was told in the shop's words. See withStaffNote_.
             'note'],
  // A statement being built but not yet sent — the whole point is to let a
  // writer stage every invoice, then come back later (with a mechanic, say)
  // and double-check before anything goes to the customer. One row per
  // customer's in-progress statement; `invoices_json` is the only place a
  // list this shape needs to live, so it is a JSON blob rather than a tab of
  // its own — never queried by field, only read and written whole. Each
  // invoice's PDF is uploaded to Drive at save time (not kept as bytes in the
  // browser), because the whole point is surviving a reload or a different
  // session before it is finally sent.
  StatementDrafts: ['id', 'customer_name', 'customer_phone', 'customer_email',
                     'invoices_json', 'created_at', 'updated_at'],
  // What the floor has ticked off on a winter unit — a boat the winter
  // services system says is pulled or dropped off. The unit and its list of
  // work live over there (see winterWork); only the ticks live here. One row
  // per quote number + item, rewritten in place when it is un-ticked.
  WinterWork: ['id', 'quote_no', 'item', 'done', 'done_by', 'done_at', 'created_at'],
  // The Detail Tracker's board: one row per detail, from a request, a work
  // order or a winter unit. `items` is the lines as one JSON cell — see
  // sanitizeDetailItems_. `quote_code` is the only credential on /q/.
  Details: ['id', 'source', 'job_id', 'winter_qn', 'customer_name', 'customer_phone', 'customer_email',
            'unit', 'loa', 'beam', 'items', 'status', 'assigned_to', 'notes', 'quote_code', 'quote_sent_at',
            'created_by', 'created_at', 'updated_at', 'started_at', 'done_at', 'done_by', 'archived_at',
            // The BiT work order the writer made once the quote was approved.
            'ticket_no',
            // D-1001, D-1002…: a quote request's own number, for the phone
            // and the inbox, when it has no work order or winter quote yet.
            'quote_no'],
  // What happened on the board, newest last: what the live feed and a push
  // notification say.
  DetailEvents: ['id', 'detail_id', 'kind', 'text', 'actor', 'created_at'],
  // Phones that asked for notifications. See pushNotify_.
  PushSubs: ['id', 'endpoint', 'who', 'label', 'role', 'failures', 'created_at']
};

/* ============================== plumbing =============================== */

/**
 * Script properties, read ONCE per execution.
 *
 * Every getProperty is its own call out to Google, and an ordinary request
 * asks for several: the spreadsheet id, the token secret, test mode, the
 * tracking switch, the review link. getProperties() brings the lot back in
 * one call, and they are a handful of short strings.
 *
 * Writes go straight through to the real store and update the copy, so a
 * value set in this execution reads back as set. Another execution's write
 * is not seen until the next request, which is no change: every request is
 * its own execution, and none of them read a property twice expecting it to
 * have moved underneath them.
 */
let _props = null;
function props_() {
  if (_props) return _props;
  const store = PropertiesService.getScriptProperties();
  const values = store.getProperties() || {};
  _props = {
    getProperty: function (key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setProperty: function (key, value) {
      store.setProperty(key, value);
      values[key] = String(value);
      return _props;
    },
    deleteProperty: function (key) {
      store.deleteProperty(key);
      delete values[key];
      return _props;
    }
  };
  return _props;
}

function nowIso_() {
  return new Date().toISOString();
}

/** Crockford-ish base32: no I, L, O or U, so a printed token cannot be misread. */
const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Unguessable enough that the URL itself is the customer's credential. */
function newTrackingToken_() {
  let out = '';
  while (out.length < 20) {
    const uuid = Utilities.getUuid().replace(/[^0-9a-f]/g, '');
    for (let i = 0; i < uuid.length && out.length < 20; i += 2) {
      out += TOKEN_ALPHABET[parseInt(uuid.substr(i, 2), 16) % TOKEN_ALPHABET.length];
    }
  }
  return out;
}

/**
 * The code that stands for a job in a text message.
 *
 * Eight characters, not the job's twenty-character tracking token, because
 * this one has to fit in an SMS alongside a sentence and still leave the
 * whole thing inside one 160-character segment. Eight of this alphabet is
 * about a trillion codes: a code is still the only credential on that page,
 * so it has to be worth as little to guess at as the token is.
 *
 * Same Crockford-ish alphabet as the token, for the same reason — a customer
 * reading one back over the phone must not have to distinguish 1 from I.
 */
const INVOICE_CODE_LENGTH = 8;

function newInvoiceCode_() {
  let out = '';
  while (out.length < INVOICE_CODE_LENGTH) {
    const uuid = Utilities.getUuid().replace(/[^0-9a-f]/g, '');
    for (let i = 0; i < uuid.length && out.length < INVOICE_CODE_LENGTH; i += 2) {
      out += TOKEN_ALPHABET[parseInt(uuid.substr(i, 2), 16) % TOKEN_ALPHABET.length];
    }
  }
  return out;
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').substr(0, 16);
}

let _ss = null;
function ss_() {
  if (_ss) return _ss;
  const id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setup() once from the editor before using this.');
  _ss = SpreadsheetApp.openById(id);
  return _ss;
}

function sheet_(name) {
  const sheet = ss_().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup().');
  return sheet;
}

/** Every row of a tab as objects keyed by the header row. */
/**
 * Every cell in this workbook is stored as PLAIN TEXT, and that is not a
 * stylistic choice.
 *
 * A BiT invoice number looks like `01-8891`. Handed to Sheets as a bare
 * value, Sheets reads it as a date — the first of January, 8891 — and the
 * job's primary key comes back as a Date object instead of the number
 * printed on the paper. Every lookup by id then misses, which shows up as
 * "No such job." on a job you can see in the list. ISO timestamps get the
 * same treatment.
 *
 * So writes go through a range formatted `@` first, and reads normalise any
 * Date left over from before that was true. Numbers are coerced on the way
 * out (`numberOrNull_`, `Number(...)`) so storing them as text costs
 * nothing.
 */
/** `instanceof` is not safe across execution contexts; the tag always is. */
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function asText_(value) {
  if (value === null || value === undefined) return '';
  // A legacy cell Sheets already turned into a date. ISO keeps it sortable
  // and makes String() comparisons stable on both sides of a lookup.
  if (isDate_(value)) return value.toISOString();
  return value;
}

/** Per-execution cache. A web app call is short-lived; a stale read is not. */
let _rowCache = {};

function rows_(name) {
  if (_rowCache[name]) return _rowCache[name];
  const values = sheet_(name).getDataRange().getValues();
  // The data range ends at the last row with anything in it, which is exactly
  // what getLastRow would answer — so an append after a read does not have to
  // ask again.
  if (_lastRow[name] === undefined && values.length > 1) _lastRow[name] = values.length;
  return parseRows_(name, values);
}

/**
 * Turns a tab's raw values into row objects and memoises them — shared by
 * rows_ and by prefetch_, which fetches several tabs in one call.
 */
function parseRows_(name, values) {
  if (values.length < 2) {
    _rowCache[name] = [];
    return _rowCache[name];
  }
  const header = values[0];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    if (!values[r][0]) continue;
    const row = { _row: r + 1 };
    for (let c = 0; c < header.length; c++) row[header[c]] = asText_(values[r][c]);
    out.push(row);
  }
  _rowCache[name] = out;
  return out;
}

/**
 * Several tabs in ONE round trip, where a page needs them all at once.
 *
 * rows_ reads a tab per call, and each call is its own trip to Google. The
 * writer's job page wants seven tabs; fetched one by one that was the bulk of
 * its wait. The Sheets advanced service can hand them all back from a single
 * `values.batchGet`, and the answer lands in the same row cache rows_ reads
 * from — so nothing downstream knows or cares how the rows arrived.
 *
 * Purely an optimisation, and it fails safe. If the advanced service is not
 * enabled, not authorised, or any tab is missing, this does nothing and each
 * rows_ call reads its own tab exactly as before.
 *
 * Cells are plain text, so the formatted value IS the value — except a date
 * left over from before that was true. getValues hands that back as a Date,
 * which asText_ turns into ISO; the API hands back how Sheets displays it,
 * `9/1/2026 10:00:00`, which sorts and parses as something else entirely. So
 * an answer holding anything shaped like a displayed date is thrown away and
 * the tabs are read the old way. The price of an old sheet is the old speed,
 * never a different answer.
 */
// `9/1/2026`, `1.9.2026`, `9/1/2026 10:00:00`, or a dashed date only when a
// time follows it — a bare `2026-09-01` is how this app writes a payment date
// as text, and must not send every job with a payment down the slow path.
const DISPLAYED_DATE_ = new RegExp('^(\\d{1,4}[/.]\\d{1,2}[/.]\\d{1,4}(\\s+\\d{1,2}:\\d{2}(:\\d{2})?(\\s*[AP]M)?)?' +
  '|\\d{1,4}-\\d{1,2}-\\d{1,4}\\s+\\d{1,2}:\\d{2}(:\\d{2})?(\\s*[AP]M)?)$');

function holdsDisplayedDate_(values) {
  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    for (let c = 0; c < row.length; c++) {
      if (typeof row[c] === 'string' && row[c].length <= 22 && DISPLAYED_DATE_.test(row[c])) return true;
    }
  }
  return false;
}

function prefetch_(names) {
  const wanted = names.filter(function (name) { return !_rowCache[name]; });
  if (wanted.length < 2) return;
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) return;
  let answer;
  try {
    // SpreadsheetApp holds writes back and sends them in bulk; the Sheets API
    // reads the server directly and would not see them. Anything this
    // execution has written — the save before a jobPage read, say — has to
    // land first.
    SpreadsheetApp.flush();
    answer = Sheets.Spreadsheets.Values.batchGet(ss_().getId(), {
      ranges: wanted.map(function (name) { return "'" + name + "'"; }),
      valueRenderOption: 'FORMATTED_VALUE',
      majorDimension: 'ROWS'
    });
  } catch (err) {
    return;
  }
  const ranges = (answer && answer.valueRanges) || [];
  if (ranges.length !== wanted.length) return;
  if (ranges.some(function (range) { return holdsDisplayedDate_(range.values || []); })) return;
  wanted.forEach(function (name, i) {
    parseRows_(name, ranges[i].values || []);
  });
}

/**
 * Where the next append goes. Memoised for the same reason `rows_` is: one
 * getLastRow is a round trip to Google, and a save that logs a part and puts
 * a line on the parts list appends twice.
 */
let _lastRow = {};

/** Anything that writes must drop the cache, or the next read is a lie. */
function forget_(name) {
  if (name) {
    delete _rowCache[name];
    delete _lastRow[name];
  } else {
    _rowCache = {};
    _lastRow = {};
  }
}

function appendRow_(name, obj) {
  const columns = SHEETS[name];
  const row = columns.map(function (key) {
    return obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
  });
  const sheet = sheet_(name);
  if (_lastRow[name] === undefined) _lastRow[name] = sheet.getLastRow();
  const at = Math.max(_lastRow[name] + 1, 2);
  const range = sheet.getRange(at, 1, 1, columns.length);
  range.setNumberFormat('@');
  range.setValues([row]);
  forget_(name);
  _lastRow[name] = at;
  return obj;
}

/**
 * Writes only the named fields back to one row — in ONE call, not one per
 * field. Each setValue is a round trip to Google, and a status change used
 * to spend three of them.
 */
/**
 * Guards a write against a header setup() has not caught up with. Only worth
 * calling from a new feature's entry point, in the window between a deploy and
 * somebody running setup() — after that it is always true.
 */
/**
 * Whether a column setup() is supposed to have written is actually there.
 *
 * Memoised: this is asked on the transcript path, which can run for a dozen
 * entries in one sweep, and the header does not change mid-execution.
 */
let _headers = {};
function headerHas_(name, column) {
  if (!_headers[name]) {
    _headers[name] = sheet_(name).getRange(1, 1, 1, SHEETS[name].length).getValues()[0];
  }
  return _headers[name].indexOf(column) !== -1;
}

function requireColumn_(name, column) {
  const header = sheet_(name).getRange(1, 1, 1, SHEETS[name].length).getValues()[0];
  if (header.indexOf(column) === -1) {
    throw new Error('This needs a one-time setup step: open the Apps Script project and run setup(), ' +
      'then try again. (The ' + name + ' sheet has no "' + column + '" column yet.)');
  }
}

/**
 * The span is read back before it is written, and that read is not waste to
 * be optimised away. A patch of `updated_at` plus the two running totals
 * spans fourteen columns, most of them nobody in this call touched — the
 * alert among them. Writing those back from a copy read earlier would quietly
 * undo whatever the service writer saved in between, and the writer's saves
 * do not take the lock. One round trip is the price of not doing that.
 */
function updateRow_(name, rowNumber, patch) {
  const columns = SHEETS[name];
  const keys = Object.keys(patch).filter(function (key) { return columns.indexOf(key) !== -1; });
  if (!keys.length) return;

  let first = columns.length;
  let last = 0;
  keys.forEach(function (key) {
    const index = columns.indexOf(key);
    if (index < first) first = index;
    if (index > last) last = index;
  });

  const sheet = sheet_(name);
  const range = sheet.getRange(rowNumber, first + 1, 1, last - first + 1);
  const values = range.getValues()[0];
  keys.forEach(function (key) {
    const value = patch[key];
    values[columns.indexOf(key) - first] = value === null || value === undefined ? '' : String(value);
  });
  range.setNumberFormat('@');
  range.setValues([values]);
  forget_(name);
}

/**
 * Two mechanics saving at the same moment would otherwise interleave their
 * appends. Every write goes through here.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ================================ auth ================================= */

function secret_() {
  let value = props_().getProperty('TOKEN_SECRET');
  if (!value) {
    value = Utilities.getUuid() + Utilities.getUuid();
    props_().setProperty('TOKEN_SECRET', value);
  }
  return value;
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, secret_())
  );
}

function seal_(payload) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  return body + '.' + sign_(body);
}

function unseal_(token) {
  if (!token || String(token).indexOf('.') === -1) return null;
  const parts = String(token).split('.');
  if (sign_(parts[0]) !== parts[1]) return null;
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function requireAdmin_(token) {
  const payload = unseal_(token);
  if (!payload || payload.role !== 'admin') throw new Error('Sign in to the service writer portal first.');
  return payload;
}

function mechanicOrNull_(token) {
  const payload = unseal_(token);
  return payload && payload.role === 'mechanic' ? payload : null;
}

function requireMechanic_(token) {
  const payload = mechanicOrNull_(token);
  if (!payload) throw new Error('Sign in with your name first.');
  return payload;
}

/** Either credential opens the shop-side views. */
function requireShop_(token) {
  const payload = unseal_(token);
  // 'detail' is a Detail Tracker sign-in: a winter staff PIN, checked by the
  // winter system (detailSignIn). Same people as the floor, same bar.
  if (!payload || (payload.role !== 'admin' && payload.role !== 'mechanic' && payload.role !== 'detail')) {
    throw new Error('Sign in first.');
  }
  return payload;
}

/* ============================== dispatch =============================== */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * The single endpoint. Every page posts {fn, token, args} as text/plain —
 * a "simple" request, so the browser skips the CORS preflight that an Apps
 * Script web app cannot answer.
 */
function doPost(e) {
  // AssemblyAI delivers its webhook as a POST, not a GET, and puts the
  // transcript id in the BODY rather than the query string. Only the hook
  // marker and the shared secret ride in the URL, so they arrive on
  // e.parameter either way. Handled before the FNS dispatch because a
  // webhook has no `fn` and would otherwise be answered "Unknown function."
  const query = (e && e.parameter) || {};
  if (query.hook === 'transcript') {
    let body = {};
    try {
      body = JSON.parse(e.postData.contents) || {};
    } catch (err) {
      body = {};
    }
    return transcriptWebhook_({
      k: query.k,
      transcript_id: body.transcript_id || query.transcript_id,
      status: body.status || query.status
    });
  }

  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_(stamp_({ error: 'Unreadable request.' }));
  }
  // The winter system telling the Detail Tracker a quote was answered. Its own
  // door with its own key check, like the transcript hook: no token, no fn.
  if (data && data.api === 'detailPing') {
    let out;
    try { out = detailPing_(data); } catch (err) { out = { ok: 0, error: String(err && err.message || err) }; }
    return json_(stamp_(out));
  }
  return json_(serve_(data, false));
}

/**
 * Every function the pages can call, by name. A table built per request
 * because each entry closes over that request's token.
 */
function apiFns_(data) {
  return {
    /**
     * Does nothing, on purpose.
     *
     * Apps Script boots a container to answer a request and keeps it warm for
     * a short while afterwards. The mechanic app calls this the moment it
     * opens and again when the scanner comes up, so the call that follows —
     * the one somebody is standing there waiting for — lands on a container
     * that is already running instead of paying for the start-up itself.
     *
     * It touches no sheet, no property and no credential, and answers the
     * same to anyone. Its round trip, on the App setup page, is also the
     * cleanest reading there is of what an empty call to Apps Script costs.
     */
    ping:             function () { return { ok: true }; },

    /* service writer */
    adminSignIn:      function (a) { return adminSignIn(a[0]); },
    requestMagicLink: function (a) { return requestMagicLink(); },
    magicSignIn:      function (a) { return magicSignIn(a[0]); },
    createJob:        function (a) { return createJob(data.token, a[0]); },
    attachWorkOrder:  function (a) { return attachWorkOrder(data.token, a[0], a[1]); },
    listJobs:         function (a) { return listJobs(data.token, a[0]); },
    getJob:           function (a) { return getJob(data.token, a[0]); },
    saveJobDetails:   function (a) { return saveJobDetails(data.token, a[0], a[1]); },
    saveInvoice:      function (a) { return saveInvoice(data.token, a[0], a[1], a[2], a[3]); },
    markDone:         function (a) { return markDone(data.token, a[0], a[1] === true); },
    sendInvoiceEmail: function (a) { return sendInvoiceEmail(data.token, a[0], a[1]); },
    previewCustomerEmail: function (a) { return previewCustomerEmail(data.token, a[0], a[1], a[2]); },
    invoiceText:      function (a) { return invoiceText(data.token, a[0], a[1]); },
    markInvoiceTexted: function (a) { return markInvoiceTexted(data.token, a[0], a[1]); },
    sendOrderReceipt: function (a) { return sendOrderReceipt(data.token, a[0], a[1]); },
    cancelPartsOrder: function (a) { return cancelPartsOrder(data.token, a[0], a[1]); },
    createPartsOrder: function (a) { return createPartsOrder(data.token, a[0]); },
    markOrderArrived: function (a) { return markOrderArrived(data.token, a[0]); },
    sendArrivalEmail: function (a) { return sendArrivalEmail(data.token, a[0], a[1]); },
    recordPayment:    function (a) { return recordPayment(data.token, a[0], a[1]); },
    listOpenStatements: function (a) { return listOpenStatements(data.token); },
    sendCustomerStatement: function (a) { return sendCustomerStatement(data.token, a[0], a[1]); },
    previewCustomerStatement: function (a) { return previewCustomerStatement(data.token, a[0], a[1], a[2]); },
    statementSummaryPdf: function (a) { return statementSummaryPdf(data.token, a[0], a[1]); },
    listSentStatements: function (a) { return listSentStatements(data.token); },
    backfillInvoice: function (a) { return backfillInvoice(data.token, a[0]); },
    saveStatementDraft: function (a) { return saveStatementDraft(data.token, a[0]); },
    listStatementDrafts: function (a) { return listStatementDrafts(data.token); },
    deleteStatementDraft: function (a) { return deleteStatementDraft(data.token, a[0]); },
    setStatus:        function (a) { return setStatusByWriter(data.token, a[0], a[1]); },
    markLogged:       function (a) { return markEntriesLogged(data.token, a[0]); },
    addWriterNote:    function (a) { return addWriterNote(data.token, a[0], a[1]); },
    addJobFile:       function (a) { return addJobFile(data.token, a[0], a[1]); },
    deleteJobFile:    function (a) { return deleteJobFile(data.token, a[0]); },
    deleteEntry:      function (a) { return deleteEntry(data.token, a[0]); },
    moveEntry:        function (a) { return moveEntry(data.token, a[0], a[1]); },
    setJobAlert:      function (a) { return setJobAlert(data.token, a[0], a[1]); },
    jobHistory:       function (a) { return jobHistory(data.token, a[0]); },
    setJobFlag:       function (a) { return setJobFlag(data.token, a[0], a[1], a[2]); },
    archiveJobs:      function (a) { return archiveJobs(data.token, a[0], a[1]); },
    sheetStatus:      function (a) { return sheetStatus(data.token); },
    runSetup:         function (a) { return runSetup(data.token); },
    listMechanics:    function (a) { return listMechanicsAdmin(data.token); },
    addMechanic:      function (a) { return addMechanic(data.token, a[0]); },
    renameMechanic:   function (a) { return renameMechanic(data.token, a[0], a[1]); },
    setMechanicActive:function (a) { return setMechanicActive(data.token, a[0], a[1]); },

    /* parts */
    listParts:        function (a) { return listPartsOrders(data.token); },
    requestPart:      function (a) { return requestPart(data.token, a[0]); },
    addJobPart:       function (a) { return addJobPart(data.token, a[0], a[1]); },
    partsOrdered:     function (a) { return markPartsOrdered(data.token, a[0], a[1], a[2]); },
    partReceived:     function (a) { return markPartReceived(data.token, a[0], a[1]); },
    partNote:         function (a) { return setPartNote(data.token, a[0], a[1]); },
    cancelPart:       function (a) { return cancelPartOrder(data.token, a[0]); },
    archiveParts:     function (a) { return setPartsArchived(data.token, a[0], a[1]); },
    deleteParts:      function (a) { return deletePartsOrders(data.token, a[0]); },
    listArchivedParts: function (a) { return listArchivedParts(data.token); },

    /* props out for repair */
    listProps:        function (a) { return listPropRepairs(data.token); },
    markPropsPickedUp: function (a) { return markPropsPickedUp(data.token, a[0], a[1]); },
    markPropReturned: function (a) { return markPropReturned(data.token, a[0], a[1]); },
    setPropNote:      function (a) { return setPropNote(data.token, a[0], a[1]); },
    cancelProp:       function (a) { return cancelPropRepair(data.token, a[0]); },

    /* mechanic app */
    roster:           function (a) { return roster(); },
    signIn:           function (a) { return mechanicSignIn(a[0], a[1]); },
    lookupJob:        function (a) { return lookupJob(a[0], a[1], data.token); },
    jobLog:           function (a) { return jobLog(data.token, a[0]); },
    jobProps:         function (a) { return jobProps(data.token, a[0]); },
    jobForMechanic:   function (a) { return jobForMechanic(data.token, a[0]); },
    openJobs:         function (a) { return openJobs(data.token, a[0] === true); },
    transcriptsFor:   function (a) { return transcriptsFor(data.token, a[0]); },
    addEntry:         function (a) { return addEntry(data.token, a[0], a[1]); },
    addPropRepair:    function (a) { return addPropRepair(data.token, a[0], a[1]); },
    finishWork:       function (a) { return finishWork(data.token, a[0]); },
    setJobWinterItem: function (a) { return setJobWinterItem(data.token, a[0], a[1], a[2] === true, a[3]); },
    winterMenu:       function (a) { return winterMenu(data.token); },
    setJobWinter:     function (a) { return setJobWinter(data.token, a[0], a[1] || null); },
    winterWork:       function (a) { return winterWork(data.token, a[0] === true); },

    /* the Detail Tracker */
    detailSignIn:     function (a) { return detailSignIn(a[0]); },
    detailForCode:    function (a) { return detailForCode(data.token, a[0], a[1]); },
    detailBoard:      function (a) { return detailBoard(data.token, a[0], a[1]); },
    getDetail:        function (a) { return getDetail(data.token, a[0]); },
    createDetail:     function (a) { return createDetail(data.token, a[0]); },
    updateDetail:     function (a) { return updateDetail(data.token, a[0], a[1]); },
    setDetailItemDone: function (a) { return setDetailItemDone(data.token, a[0], a[1], a[2] === true); },
    startDetail:      function (a) { return startDetail(data.token, a[0]); },
    finishDetail:     function (a) { return finishDetail(data.token, a[0]); },
    setDetailStatus:  function (a) { return setDetailStatus(data.token, a[0], a[1]); },
    setJobDetail:     function (a) { return setJobDetail(data.token, a[0], a[1] || null); },
    quoteDetail:      function (a) { return quoteDetail(data.token, a[0], a[1]); },
    linkDetailJob:    function (a) { return linkDetailJob(data.token, a[0], a[1]); },
    sendDetailQuote:  function (a) { return sendDetailQuote(data.token, a[0], a[1] || {}, a[2]); },
    acceptDetailForCustomer: function (a) { return acceptDetailForCustomer(data.token, a[0], a[1] || {}); },
    detailQuoteText:  function (a) { return detailQuoteText(data.token, a[0]); },
    markDetailQuoteSent: function (a) { return markDetailQuoteSent(data.token, a[0], a[1]); },
    sendDetailQuoteEmail: function (a) { return sendDetailQuoteEmail(data.token, a[0]); },
    decideDetailLine: function (a) { return decideDetailLine(data.token, a[0], a[1], a[2], a[3]); },
    decideDetailLines: function (a) { return decideDetailLines(data.token, a[0], a[1], a[2], a[3]); },
    addDetailNote:    function (a) { return addDetailNote(data.token, a[0], a[1]); },
    winterDetails:    function (a) { return winterDetails(data.token, a[0] === true); },
    pullWinterDetail: function (a) { return pullWinterDetail(data.token, a[0]); },
    pushKey:          function (a) { return pushKey(); },
    pushSubscribe:    function (a) { return pushSubscribe(data.token, a[0], a[1]); },
    pushUnsubscribe:  function (a) { return pushUnsubscribe(data.token, a[0]); },
    pushInbox:        function (a) { return pushInbox(data.token); },
    pushTest:         function (a) { return pushTest(data.token); },
    /* the customer's detail quote — the code in the URL is the whole of it */
    detailQuote:      function (a) { return detailQuote(a[0]); },
    answerDetailQuote: function (a) { return answerDetailQuote(a[0], a[1], a[2]); },
    /* the public Request a detail page — no credential at all; see requestDetailOnline */
    requestDetailOnline: function (a) { return requestDetailOnline(a[0]); },
    setWinterItem:    function (a) { return setWinterItem(data.token, a[0], a[1], a[2] === true); },

    /* customer page — the token in the URL is the only credential */
    publicJob:        function (a) { return publicJob(a[0], data.token); },
    /* the texted invoice page — the short code in the URL is the whole of it */
    invoicePage:      function (a) { return invoicePage(a[0]); },
    setTestMode:      function (a) { return setTestMode(data.token, a[0]); },
    setCustomerTracking: function (a) { return setCustomerTracking(data.token, a[0]); },
    setReviewUrl:     function (a) { return setReviewUrl(data.token, a[0]); },
    config:           function (a) { return config(data.token); }
  };
}

/* ------------------------------ one door ------------------------------- */
/*
 * POST and GET both come through here. POST is how every page has always
 * called; GET is the second road a slow READ can take (see API_GET_FNS_).
 */

/**
 * Stamped on every answer the dispatch gives, errors included.
 *
 * A POST can reach the web app with its body gone, and Apps Script then hands
 * it to doGet. That used to answer with the health check, `{ok: true}`, and
 * the page could not tell it from a real reply: the mechanic app took it as a
 * saved note, dropped the note from its outbox, and put `undefined` where the
 * entry was in the feed. The note was never saved and nothing anywhere said
 * so. The pages now treat any reply without this stamp as no answer at all.
 * The health check deliberately goes without it.
 */
const API_STAMP_ = 'service-tracker';

function stamp_(out) {
  if (out && typeof out === 'object' && !Array.isArray(out)) out._api = API_STAMP_;
  return out;
}

/**
 * The functions that may be asked for by GET, and so the definition of a
 * read. A GET can be retried, prefetched or followed twice by something
 * between the phone and Google, so nothing that writes may ever be on it.
 *
 * Everything NOT here is a write: it is refused on GET, and it drops the
 * cached lists when it runs. That is one list, not two, on purpose — a
 * function added next month is a write until somebody deliberately says
 * otherwise, so it cannot slip onto the GET road or forget to invalidate.
 *
 * lookupJob is the one read that can write: a SCAN of a job still at
 * "Received" moves it to "Work underway". On the GET road it never does (see
 * serve_), and nothing is lost when that road wins — the first entry logged
 * against the job moves it just the same, and the POST that raced it usually
 * lands anyway. On POST it still advances, and drops the cache itself.
 *
 * The token rides in the query string on this road, which puts it in Apps
 * Script's own execution log. Only the script's owner can read that log — the
 * shop's own Google account, which already holds the portal password in its
 * script properties — so no token there opens anything its reader could not
 * already open. Accepted deliberately, for the floor's reads and the office's.
 *
 * Every portal read below was checked for writes, helpers included: the only
 * ones reachable are the first-run initialisations every call shares (the
 * signing secret, the Drive folder). invoiceText is NOT here — it mints the
 * job's short code — and neither are the statement previews, whose drafts are
 * too big for an address.
 */
const API_GET_FNS_ = {
  ping: true,
  roster: true,
  lookupJob: true,
  jobForMechanic: true,
  jobLog: true,
  jobProps: true,
  openJobs: true,
  transcriptsFor: true,
  winterWork: true,
  winterMenu: true,

  /* the Detail Tracker. winterDetails is NOT here: a fresh read puts the
     winter system's answers onto the board, which is a write. */
  detailBoard: true,
  getDetail: true,
  detailForCode: true,
  detailQuoteText: true,
  pushInbox: true,
  /* the customer's detail quote page */
  detailQuote: true,

  /* the writer's portal */
  listJobs: true,
  getJob: true,
  // Builds an email and sends nothing — see previewCustomerEmail.
  previewCustomerEmail: true,
  jobHistory: true,
  listParts: true,
  listArchivedParts: true,
  listProps: true,
  listMechanics: true,
  listOpenStatements: true,
  listSentStatements: true,
  listStatementDrafts: true,
  config: true,
  sheetStatus: true
};

function isReadFn_(fn) {
  return Object.prototype.hasOwnProperty.call(API_GET_FNS_, String(fn));
}

/** {fn, token, args, rid?, jobPage?} in, the stamped answer object out. */
function serve_(data, viaGet) {
  data = data || {};
  const FNS = apiFns_(data);
  if (!Object.prototype.hasOwnProperty.call(FNS, data.fn)) return stamp_({ error: 'Unknown function.' });
  if (viaGet) {
    // The server refuses, not just the page declining to ask. A write that
    // becomes GET-able is how a note gets saved twice.
    if (!isReadFn_(data.fn)) return stamp_({ error: 'That has to be sent, not fetched.' });
    // A read by GET is a read: no replay id, no page riding along, and a
    // lookup never advances the job's status from here.
    data.rid = '';
    data.jobPage = '';
    if (data.fn === 'lookupJob' && Array.isArray(data.args)) data.args = [data.args[0], 'get'];
  }
  const write = !isReadFn_(data.fn);
  try {
    return stamp_(dispatch_(FNS, data));
  } finally {
    // Whatever the outcome: a write that failed halfway may still have
    // written something, and dropping the cache costs one put.
    if (write) invalidateLists_();
  }
}

function dispatch_(FNS, data) {
  // How long this took on Google's side, in every answer. The pages measure
  // the whole round trip; the difference between the two numbers is start-up
  // and the wire, and knowing which of the two is the problem is the
  // difference between fixing "it feels slow" and guessing at it.
  const started = Date.now();

  // A call with no `rid` behaves exactly as it always did; the phone only
  // stamps one on the saves it will retry. See claimRid_.
  const rid = String(data.rid || '');
  if (!rid) {
    try {
      return timed_(withJobPage_(FNS[data.fn](data.args || []), data), started);
    } catch (err) {
      return timed_({ error: String(err && err.message ? err.message : err) }, started);
    }
  }

  const claim = claimRid_(rid);
  if (claim.prior) {
    claim.prior.replayed = true;
    return timed_(claim.prior, started);
  }
  if (claim.running) {
    // The first copy is still working. Saying so is not an error the mechanic
    // should see as a failed save — the outbox holds the entry and asks again.
    return timed_({ error: 'That save is still going through. It has not been lost.', pending: true }, started);
  }

  let out;
  try {
    out = FNS[data.fn](data.args || []);
  } catch (err) {
    // A failure does NOT become the stored answer. This is the one place this
    // deliberately departs from the console in winter-quotes, and the reason
    // is what is retrying: there, a person reads the error and decides; here,
    // the outbox asks again on its own. Caching "lock timed out" would replay
    // that same failure to every retry for the life of the entry, and the note
    // would never land. Releasing the claim makes the next attempt real work.
    releaseRid_(rid);
    return timed_({ error: String(err && err.message ? err.message : err) }, started);
  }
  finishRid_(rid, out);
  return timed_(out, started);
}

/* ------------------------- write once, answer twice --------------------- */
/*
 * The mechanic app keeps an entry it has not managed to send in an outbox on
 * the phone, and sends it again when the app next opens. That is what stops a
 * note dying with the page — and it is also what makes the same note arrive
 * twice: once from a request whose answer never got back, once from the retry.
 *
 * So every save the phone will retry carries a `rid` it generated, and the
 * answer to that rid is kept for a quarter of an hour:
 *
 *   - first time we see it, claim it and do the work;
 *   - see it again while the work is still running, say so rather than
 *     starting a second copy;
 *   - see it again after it finished, hand back the SAME answer.
 *
 * The claim is taken under the script lock, so two copies of one tap cannot
 * both win it. Nothing depends on the cache existing: if CacheService is
 * unavailable the claim fails open to "do the work", which is the behaviour
 * from before this existed.
 *
 * This covers the fast case — a duplicate minutes apart — and costs no sheet
 * read at all. It is NOT the whole guarantee: a phone that has been in a
 * locker overnight retries long after any cache entry has gone, so the
 * durable half is the `client_id` column and the check in addEntry.
 *
 * Borrowed, with its reasoning, from `rid` in the winter services console —
 * same shape, already load-tested in the yard.
 */
const RID_TTL_ = 900;          // how long an answer stays replayable, seconds
const RID_RUNNING_TTL_ = 400;  // just over the Apps Script execution ceiling
const RID_RUNNING_ = '\u0000running';

function ridKey_(rid) { return 'RID_' + String(rid || ''); }

/**
 * {prior} when this rid has already been answered, {running:true} when it is
 * in flight, {} when the caller now owns it and should do the work.
 */
function claimRid_(rid) {
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { return {}; }
  const key = ridKey_(rid);
  let lock = null;
  let held = false;
  try { lock = LockService.getScriptLock(); held = lock.tryLock(10000); } catch (err) { held = false; }
  try {
    const prior = cache.get(key);
    if (prior === RID_RUNNING_) return { running: true };
    if (prior) {
      try { return { prior: JSON.parse(prior) }; } catch (err) { return {}; }
    }
    cache.put(key, RID_RUNNING_, RID_RUNNING_TTL_);
    return {};
  } catch (err) {
    return {};
  } finally {
    if (held) { try { lock.releaseLock(); } catch (err) { /* already gone */ } }
  }
}

/** Park the answer where a retry of the same rid will find it. */
function finishRid_(rid, out) {
  try {
    CacheService.getScriptCache().put(ridKey_(rid), JSON.stringify(out || {}), RID_TTL_);
  } catch (err) {
    // Too big to cache, or no cache at all. The claim stays "running" until it
    // expires, and the durable client_id check is what catches a retry — the
    // answer being replayable was only ever the cheap half.
  }
}

/** Let go of a claim whose work failed, so the next attempt is real work. */
function releaseRid_(rid) {
  try { CacheService.getScriptCache().remove(ridKey_(rid)); } catch (err) { /* nothing held */ }
}

/**
 * A save on the writer's job page, and the page it lands on, in ONE call.
 *
 * Every button on that page used to save and then ask getJob for the whole
 * page again — two trips to Apps Script, each paying start-up and the
 * redirect, for one click. A page that asks `jobPage: id` alongside the call
 * gets the fresh page back in the same answer, read after the write in the
 * same execution, so it cannot be staler than a second call would have been.
 *
 * Only after the call itself succeeded, and only ever getJob, which checks
 * the writer's token for itself. If the read fails the save still stands and
 * the answer simply goes without it; the page then fetches the job the old
 * way.
 */
function withJobPage_(out, data) {
  if (!data.jobPage || !out || typeof out !== 'object' || Array.isArray(out)) return out;
  try {
    out.jobPage = getJob(data.token, String(data.jobPage));
  } catch (err) {
    // The save is what matters; the page can ask again.
  }
  return out;
}

function timed_(out, started) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  out.serverMs = Date.now() - started;
  return out;
}

/**
 * GET serves three things: AssemblyAI's transcript webhook, the second road
 * for a slow read (`?fn=…&token=…&args=[…]`, reads only — see API_GET_FNS_),
 * and a health check.
 *
 * The health check is NOT stamped, and that is load-bearing: a POST whose
 * body went missing arrives here with no `fn`, and the page must be able to
 * tell this answer from a real one.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.hook === 'transcript') return transcriptWebhook_(params);
  if (params.fn) {
    let args = [];
    try {
      args = params.args ? JSON.parse(params.args) : [];
    } catch (err) {
      return json_(stamp_({ error: 'Unreadable request.' }));
    }
    return json_(serve_({ fn: params.fn, token: params.token || '', args: Array.isArray(args) ? args : [] }, true));
  }
  return json_({ ok: true, service: 'Quest Service Tracker' });
}

/* =============================== jobs ================================== */

function jobRow_(id) {
  const all = rows_('Jobs');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

function jobByToken_(token) {
  const all = rows_('Jobs');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].token) === String(token)) return all[i];
  }
  return null;
}

/**
 * Mechanic lookup by the number printed on the paper. BiT writes it as
 * `01-8886`; people type `018886` or `8886`, so match generously but never
 * ambiguously — a suffix match that hits two jobs returns nothing.
 */
function jobByNumber_(typed) {
  const wanted = String(typed || '').trim().toUpperCase();
  if (!wanted) return null;
  const exact = jobRow_(wanted);
  if (exact) return exact;

  const digits = wanted.replace(/[^0-9A-Z]/g, '');
  if (!digits) return null;
  const matches = rows_('Jobs').filter(function (job) {
    const normalized = String(job.id).toUpperCase().replace(/[^0-9A-Z]/g, '');
    return normalized === digits || normalized.slice(-digits.length) === digits;
  });
  return matches.length === 1 ? matches[0] : null;
}

function trackingUrl_(job) {
  return SITE_URL + '/t/?j=' + job.token;
}

/**
 * The invoice page by its short code. Matched case-insensitively: a customer
 * who retypes the link off a text will not have held the shift key.
 */
function jobByInvoiceCode_(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const all = rows_('Jobs');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].invoice_code || '').toUpperCase() === wanted) return all[i];
  }
  return null;
}

/** Where a texted customer lands. Same site as the QR code, a different door. */
function invoiceUrl_(code) {
  return SITE_URL + '/i/?c=' + code;
}

/**
 * This job's code, minted the first time somebody asks for it.
 *
 * Lazy on purpose. Most jobs are emailed, and a column written on every
 * markDone is a write nobody asked for; a code that exists is also a live
 * door into a customer's invoice, so the ones that exist should be the ones
 * the shop deliberately handed out.
 *
 * Under the lock, and re-read inside it: two writers texting the same job in
 * the same minute must end up handing out the same code, not two doors to the
 * same invoice.
 */
function invoiceCodeFor_(job) {
  const existing = String(job.invoice_code || '').trim().toUpperCase();
  if (existing) return existing;
  requireColumn_('Jobs', 'invoice_code');
  return withLock_(function () {
    // The re-read has to be a real one. Rows are cached per execution and
    // this execution's copy was taken before the lock, so without dropping it
    // first the "has somebody else minted one" check would be answered from
    // the same stale picture that sent us in here.
    forget_('Jobs');
    const fresh = jobRow_(job.id);
    const already = String((fresh && fresh.invoice_code) || '').trim().toUpperCase();
    if (already) return already;
    let code = newInvoiceCode_();
    // A collision is somewhere around one in a trillion, and the cost of
    // checking is a tab already in the row cache. Two jobs sharing a code
    // would hand one customer the other's invoice.
    while (jobByInvoiceCode_(code)) code = newInvoiceCode_();
    updateRow_('Jobs', fresh._row, { invoice_code: code, updated_at: nowIso_() });
    return code;
  });
}

/** Money to the cent, so a sum of three payments is not 0.30000000000000004. */
function money2_(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function paymentView_(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    // Which recording this came in on — the writer entered these together and
    // one receipt went out covering the lot.
    batch: row.batch || '',
    amount: money2_(numberOrNull_(row.amount) || 0),
    // Money that went back to the customer. Only a cancelled order writes
    // one — see cancelPartsOrder; recordPayment refuses a negative line.
    refund: (numberOrNull_(row.amount) || 0) < 0,
    method: PAYMENT_METHODS.indexOf(row.method) === -1 ? 'other' : row.method,
    methodLabel: PAYMENT_METHOD_LABEL[row.method] || PAYMENT_METHOD_LABEL.other,
    // Last four, a check number, an auth code — whatever the writer wrote
    // down so the customer can match it to their own statement.
    reference: row.reference || '',
    receivedAt: row.received_at || '',
    note: row.note || '',
    recordedBy: row.recorded_by || '',
    createdAt: row.created_at
  };
}

function paymentsForJob_(jobId) {
  // A deployment that has not had setup() run yet has no Payments tab, and a
  // job page must not go dark over it — a job with nowhere to record payments
  // has no payments, which is true rather than a papered-over error. The App
  // setup page is what says the sheet is behind, loudly; recordPayment
  // refuses outright rather than writing into a tab that is not there.
  let all;
  try {
    all = rows_('Payments');
  } catch (err) {
    return [];
  }
  return all
    .filter(function (row) { return String(row.job_id) === String(jobId); })
    .map(paymentView_)
    .sort(function (a, b) {
      return String(a.receivedAt || a.createdAt).localeCompare(String(b.receivedAt || b.createdAt))
        || String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

/**
 * What is still owed on a job: the invoice's own amount due, less everything
 * collected against it since.
 *
 * `amount_due` is left exactly as the invoice read — it is what BiT said, and
 * re-uploading the invoice reads it again. Payments are subtracted here
 * instead, so the two numbers never fight and the shop can always see both.
 *
 * null when no invoice figure has been read yet, which is a different thing
 * from zero: nothing is owed on a job nobody has priced, and nothing is
 * settled on one either.
 */
function jobBalance_(job) {
  // A cancelled order owes nothing. What was paid and what went back are on
  // the Payments tab; the invoice's own figures are left as BiT printed them,
  // so the arithmetic below would read the refund as money now owed.
  if (isCancelledOrder_(job)) return 0;
  const due = numberOrNull_(job.amount_due);
  if (due === null) return null;
  return money2_(due - (numberOrNull_(job.paid_total) || 0));
}

/** Close enough to zero that a customer is not chased for it. */
function settled_(balance) {
  return balance !== null && balance <= 0.005;
}

/** A customer's parts order rather than a work order. */
function isPartsOrder_(job) {
  return Boolean(job) && String(job.kind || '') === 'parts';
}

function statusLabel_(job) {
  if (isCancelledOrder_(job)) return 'Cancelled';
  return (isPartsOrder_(job) ? ORDER_STATUS_LABEL : STATUS_LABEL)[job.status];
}

/** A parts order the customer called off. Nothing is owed on it, either way. */
function isCancelledOrder_(job) {
  return isPartsOrder_(job) && Boolean(job.cancelled_at);
}

function jobSummary_(job) {
  return {
    id: job.id,
    token: job.token,
    kind: isPartsOrder_(job) ? 'parts' : 'job',
    customerName: job.customer_name,
    customerPhone: job.customer_phone,
    customerEmail: job.customer_email,
    boatInfo: job.boat_info,
    status: job.status,
    statusLabel: statusLabel_(job),
    needsReview: job.needs_review ? String(job.needs_review).split(',').filter(String) : [],
    workOrderFile: job.work_order_file || null,
    invoiceFile: job.invoice_file || null,
    paymentLink: job.payment_link || null,
    grandTotal: numberOrNull_(job.grand_total),
    deposits: numberOrNull_(job.deposits),
    amountDue: numberOrNull_(job.amount_due),
    workRequested: job.work_requested || null,
    // The red banner on the mechanic's job screen. Shop-side only: publicJob
    // builds the customer's payload field by field and never reads this.
    alert: job.alert || null,
    alertAt: job.alert_at || null,
    partsOrderedAt: job.parts_ordered_at || null,
    paidAt: job.paid_at || null,
    // When a parts order came in. The same stamp a work order gets when the
    // mechanic finishes, because it is the same step in the same column.
    arrivedAt: isPartsOrder_(job) ? (job.work_finished_at || null) : null,
    cancelledAt: isCancelledOrder_(job) ? job.cancelled_at : null,
    cancelNote: isCancelledOrder_(job) ? (job.cancel_note || '') : '',
    trackingUrl: trackingUrl_(job),
    // The texted invoice page, once a writer has asked for one. Null until
    // then, because the code is only minted when somebody texts the job —
    // see invoiceCodeFor_.
    invoiceCode: job.invoice_code || null,
    invoiceUrl: job.invoice_code ? invoiceUrl_(job.invoice_code) : null,
    archivedAt: job.archived_at || null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    doneAt: job.done_at || null,
    // The running totals off the row, so a page can say how much log there is
    // without anything having read the log.
    entryCount: Number(job.entry_count || 0),
    minutesTotal: Number(job.minutes_total || 0),
    // Collected so far, and what that leaves. Both off the row, for the same
    // reason as the totals above — the jobs list shows a balance and must not
    // read the Payments tab to do it.
    paidTotal: money2_(numberOrNull_(job.paid_total) || 0),
    balance: jobBalance_(job),
    // The winterize checklist, or null. Shop-side: the customer's pages
    // never call this function.
    winter: winterView_(winterSpecOf_(job)),
    // A split ticket: who is on it and who it is waiting on. Null on a job
    // that is the mechanic's alone.
    detail: jobDetailSummary_(job)
  };
}

function numberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return isFinite(number) ? number : null;
}

/**
 * The addresses on a job. There can be several — two owners on a boat, an
 * office that pays for a fleet — and they share the one `customer_email`
 * cell, comma separated. Deliberately not a new column: a column the header
 * does not have yet reads back empty, so a second address would save and
 * then quietly not be emailed until somebody ran setup().
 *
 * Splitting on commas, semicolons and whitespace means whatever the writer
 * typed or pasted comes apart, and the one thing that goes back is a comma:
 * GmailApp's recipient field takes commas only, and a semicolon fails the
 * whole send rather than the address that carried it. Old rows written
 * before the portal had a line per address are cleaned up on the way past,
 * which is why sending reads through here too.
 */
function emailList_(value) {
  const seen = {};
  return String(value || '').split(/[,;\s]+/).filter(function (address) {
    if (!address) return false;
    const key = address.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

/** The same list as one stored — or sendable — value. */
function normalizeEmails_(value) {
  return emailList_(value).join(', ');
}

/**
 * The shop's own copy. Skipped when the desk is already on the message,
 * which is what a rehearsal is, and now also when the writer has put
 * service@ on the job itself — copying an address onto its own message is a
 * duplicate rather than a record.
 */
function shopCc_(to) {
  const desk = String(SERVICE_EMAIL).toLowerCase();
  const already = emailList_(to).some(function (address) { return address.toLowerCase() === desk; });
  return already ? '' : SERVICE_EMAIL;
}

const REVIEW_FIELDS = ['customerName', 'customerPhone', 'customerEmail', 'boatInfo'];

/**
 * What still has to be filled in. A parts order is not asked for a boat:
 * somebody buying a trim pump over the counter may not have one with us, and
 * a flag that can never be cleared is a flag everybody learns to ignore.
 */
function missingFields_(fields, kind) {
  return REVIEW_FIELDS.filter(function (name) {
    if (kind === 'parts' && name === 'boatInfo') return false;
    return !String(fields[name] || '').trim();
  });
}

/**
 * Intake. The browser has already read the work order and stamped the QR on
 * it, so all that arrives here is the finished document and the fields the
 * service writer confirmed.
 */
function createJob(token, payload) {
  requireAdmin_(token);
  const id = String(payload.invoiceNumber || '').trim().toUpperCase();
  if (!id) throw new Error('An invoice number is required — it identifies the job.');
  if (payload.winter) ensureWinterColumn_();

  return withLock_(function () { return createJobRow_(id, payload); });
}

/** The job row itself. Callers hold the lock. */
function createJobRow_(id, payload) {
    if (jobRow_(id)) {
      const d = ss_().getSheetByName('Details') ? detailForJob_(id) : null;
      throw new Error('Job ' + id + ' already exists' + (d && d.quote_no ? ' — it was made from detail quote ' + d.quote_no +
        '. Open it from the jobs list and drop the work order on its page to stamp it.' : '. Open it from the jobs list instead.'));
    }
    const at = nowIso_();
    const fields = Object.assign({}, payload, { customerEmail: normalizeEmails_(payload.customerEmail) });
    const job = {
      id: id,
      token: newTrackingToken_(),
      customer_name: payload.customerName || '',
      customer_phone: payload.customerPhone || '',
      customer_email: fields.customerEmail,
      boat_info: payload.boatInfo || '',
      // What the customer asked for, off the body of the work order. This is
      // the one field a mechanic needs before touching the boat.
      work_requested: payload.workRequested || '',
      status: 'received',
      needs_review: missingFields_(fields).join(','),
      work_order_file: '',
      invoice_file: '',
      payment_link: '',
      created_at: at,
      updated_at: at,
      work_started_at: '',
      work_finished_at: '',
      done_at: ''
    };

    // Marked a winterize job at intake: the checklist goes on with the row.
    if (payload.winter) job.winter_work = JSON.stringify(sanitizeWinterSpec_(payload.winter, null, 'Office'));

    appendRow_('Jobs', job);
    recordStatus_(id, '', 'received', 'service_writer', '', payload.intakeNote || 'Work order intake');
    return { job: jobSummary_(job) };
}

/**
 * A job for an invoice that predates this tracker — already finished and
 * already billed before the first row was ever written here, with nothing
 * on the shop floor left to record. Built out of the same three calls
 * intake already makes — createJob, saveInvoice, markDone, run back to
 * back — rather than a second copy of what a job row looks like.
 *
 * Exists for the "Create new statement" wizard on the Statements page,
 * which reads invoice number, balance and customer contact off an uploaded
 * BiT invoice PDF in the browser and lets the writer fix anything read
 * wrong before this is ever called. Once created, a backfilled job is an
 * ordinary job — it shows up in the jobs list, can be opened, and can be
 * marked paid like any other.
 *
 * Takes the invoice PDF either fresh (`invoicePdf`, base64, straight off the
 * wizard) or already sitting in Drive (`driveFile`, an id) — a statement
 * saved as a draft has already uploaded it once, and re-encoding it through
 * the browser a second time to send the same bytes back would be wasted
 * work. Either way it becomes the job's own invoice_file by id; it is never
 * copied into the job's folder, because nothing reads it any differently
 * for living in the draft's folder instead — filing, not access.
 */
function backfillInvoice(token, payload) {
  requireAdmin_(token);
  if (!payload.invoicePdf && !payload.driveFile) throw new Error('The invoice PDF is required.');
  const amountDue = numberOrNull_(payload.amountDue);
  if (amountDue === null || amountDue <= 0) {
    throw new Error('A balance greater than zero is required for ' + (payload.invoiceNumber || 'this invoice') + '.');
  }
  const id = String(payload.invoiceNumber || '').trim().toUpperCase();
  createJob(token, {
    invoiceNumber: id,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerEmail: payload.customerEmail,
    boatInfo: payload.boatInfo
  });
  saveInvoice(token, id, '', payload.invoicePdf || '', {
    grandTotal: payload.grandTotal, deposits: payload.deposits, amountDue: amountDue
  });
  if (!payload.invoicePdf && payload.driveFile) {
    const job = jobRow_(id);
    updateRow_('Jobs', job._row, { invoice_file: payload.driveFile, updated_at: nowIso_() });
  }
  markDone(token, id);
  // The status trail already says the row was created and immediately
  // marked done, which is honest but says nothing about why. A writer
  // opening this job in six months should not have to guess why it has no
  // shop-floor history.
  addWriterNote(token, id, 'Backfilled from an invoice that predates the tracker — no shop-floor history to show.');
  return { job: jobSummary_(jobRow_(id)) };
}

/* ------------------------------------------------- statement drafts ---- */

/**
 * A customer's parts order: somebody buying parts, not leaving anything to be
 * worked on. The writer rings it up in BiT, downloads the invoice and drops
 * it here, and from then on it is tracked like a job without a mechanic —
 * Ordered, Arrived, Picked up — with payments, receipts and the arrival
 * notice hanging off the same row.
 *
 * The invoice number is the key, exactly as for a work order: BiT never
 * recycles one, so the two cannot collide.
 *
 * The browser has read the PDF already (see parseInvoiceItems); what arrives
 * is the invoice itself, the figures the writer confirmed, and the part lines
 * as a list. `items` is those lines as the writer wants them worded, kept in
 * work_requested — the "what is this ticket for" field of any job. `parts`
 * are the lines to put on the shop's parts list, so the order goes out to a
 * supplier in the normal batch; empty when the writer has already ordered it
 * or the parts are on the shelf.
 *
 * Nothing is sent. Telling the customer it has arrived is its own button.
 */
function createPartsOrder(token, payload) {
  requireAdmin_(token);
  payload = payload || {};
  const id = String(payload.invoiceNumber || '').trim().toUpperCase();
  if (!id) throw new Error('An invoice number is required — it identifies the order.');
  if (!payload.invoicePdf) throw new Error('The invoice PDF is required.');
  // Without the column every order would save as a work order and land on
  // the mechanics' phones.
  requireColumn_('Jobs', 'kind');
  if (jobRow_(id)) throw new Error(id + ' is already in the tracker. Open it from the list instead.');

  const lines = (payload.parts || []).map(function (line) {
    const identifier = String((line && line.partIdentifier) || '').trim();
    const description = String((line && line.description) || '').trim();
    const quantity = numberOrNull_(line && line.quantity);
    return {
      partIdentifier: identifier,
      description: description,
      quantity: quantity !== null && quantity > 0 ? quantity : null
    };
  }).filter(function (line) { return line.partIdentifier || line.description; });

  // Drive before the lock, like every other upload: the lock is the whole
  // shop's, and a PDF upload is not a reason for a mechanic's save to wait.
  const invoiceFile = saveFile_(id, 'invoice-' + id + '.pdf', 'application/pdf', payload.invoicePdf);
  const money = function (value) { return numberOrNull_(value) === null ? '' : Number(value); };

  return withLock_(function () {
    forget_('Jobs');
    if (jobRow_(id)) throw new Error(id + ' is already in the tracker. Open it from the list instead.');
    const at = nowIso_();
    const fields = Object.assign({}, payload, { customerEmail: normalizeEmails_(payload.customerEmail) });
    if (payload.paymentLink && !/^https?:\/\//i.test(payload.paymentLink)) {
      throw new Error('The payment link must start with http:// or https://');
    }
    const job = {
      id: id,
      // Never printed or scanned — an order has no paper in the shop's
      // folder — but every row carries one, and a blank would match the
      // first blank a lookup was ever handed.
      token: newTrackingToken_(),
      customer_name: payload.customerName || '',
      customer_phone: payload.customerPhone || '',
      customer_email: fields.customerEmail,
      boat_info: payload.boatInfo || '',
      work_requested: String(payload.items || '').trim(),
      status: 'received',
      needs_review: missingFields_(fields, 'parts').join(','),
      work_order_file: '',
      invoice_file: invoiceFile,
      payment_link: payload.paymentLink || '',
      created_at: at,
      updated_at: at,
      work_started_at: '',
      work_finished_at: '',
      done_at: '',
      grand_total: money(payload.grandTotal),
      deposits: money(payload.deposits),
      amount_due: money(payload.amountDue),
      kind: 'parts'
    };
    appendRow_('Jobs', job);
    recordStatus_(id, '', 'received', 'service_writer', '', 'Parts order taken');
    lines.forEach(function (line) {
      addPartOrder_({
        jobId: id,
        partIdentifier: line.partIdentifier,
        description: line.description,
        quantity: line.quantity,
        reason: 'job',
        notes: 'Customer order',
        requestedBy: SHOP_WRITER_NAME
      });
    });
    return { job: jobSummary_(job), partsListed: lines.length };
  });
}

/**
 * The parts are in. Sends nothing — telling the customer is the arrival
 * email or the text, each its own button, for the same reason closing a
 * work order never posts the invoice: a writer decides what goes out.
 */
function markOrderArrived(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such order.');
  if (!isPartsOrder_(job)) throw new Error('That is a work order, not a parts order.');
  if (isCancelledOrder_(job)) throw new Error('That order was cancelled.');
  if (job.status === 'work_finished') throw new Error('That order is already marked arrived.');
  if (job.status === 'done') throw new Error('That order has already been picked up.');
  setStatus_(job, 'work_finished', 'service_writer', '', 'Order arrived');
  return { job: jobSummary_(jobRow_(id)) };
}

/**
 * The customer has called the order off, and gets their money back.
 *
 * Not a negative payment through recordPayment, which refuses one: the
 * balance there is the invoice's amount due less what was collected, so a
 * refund on its own would read as the whole order owed again — and a
 * statement would go chasing a customer who has just been paid back. A
 * cancelled order owes nothing (see jobBalance_), its refund is a Payments
 * row with a negative amount so the record says what went back and how, and
 * the ticket closes: done, and paid, which is what takes it off every open
 * list.
 *
 * The refund is typed as a positive figure, and may be nothing at all — an
 * order cancelled before anybody paid. It cannot be more than was paid.
 *
 * Lines still waiting to be ordered come off the parts list, since nobody
 * should buy them now. A line already ordered stays, and is counted in the
 * answer: what happens to it — sent back, kept as stock — is the writer's
 * call, not this function's.
 *
 * Sends nothing.
 */
function cancelPartsOrder(token, id, payload) {
  requireAdmin_(token);
  payload = payload || {};
  const job = jobRow_(id);
  if (!job) throw new Error('No such order.');
  if (!isPartsOrder_(job)) throw new Error('That is a work order, not a parts order.');
  if (isCancelledOrder_(job)) throw new Error('That order is already cancelled.');
  requireColumn_('Jobs', 'cancelled_at');

  const typed = numberOrNull_(payload.amount);
  if (typed === null || typed < 0) throw new Error('Say how much was refunded — 0 if nothing was paid.');
  const refund = money2_(typed);
  if (refund > orderPaid_(job) + 0.005) {
    throw new Error('That is more than was paid on this order (' + money_(orderPaid_(job)) + ').');
  }
  const method = PAYMENT_METHODS.indexOf(String(payload.method || '')) === -1 ? 'other' : String(payload.method);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.receivedAt || ''))
    ? String(payload.receivedAt) : nowIso_().slice(0, 10);
  const note = String(payload.note || '').trim().substr(0, 400);
  // What anything not refunded is for. The customer is shown it, on the
  // settlement receipt and the page their text opens.
  const keptFor = String(payload.keptFor || '').trim().substr(0, 120);
  if (refund > 0) requireColumn_('Payments', 'batch');
  requireColumn_('Jobs', 'cancel_note');

  // Their receipts for the refund — BiT's return invoice, the card slip.
  // Customer files, so they go with the settlement receipt and show on the
  // texted page; to Drive before the lock, like every other upload.
  ((payload && payload.files) || []).forEach(function (file) {
    if (!file || !file.base64) return;
    const name = String(file.name || '').trim() || 'receipt';
    appendRow_('JobFiles', {
      id: newId_('file'),
      job_id: job.id,
      name: name,
      mime: file.mime || '',
      drive_file: saveFile_(job.id, name, file.mime || 'application/octet-stream', file.base64),
      visibility: 'customer',
      added_by: SHOP_WRITER_NAME,
      created_at: nowIso_(),
      size: base64Bytes_(file.base64)
    });
  });

  const outcome = withLock_(function () {
    forget_('Jobs');
    const fresh = jobRow_(id);
    if (isCancelledOrder_(fresh)) throw new Error('That order is already cancelled.');
    const at = nowIso_();
    const patch = { cancelled_at: at, cancel_note: keptFor, updated_at: at };
    if (refund > 0) {
      appendRow_('Payments', {
        id: newId_('pmt'),
        job_id: fresh.id,
        batch: newId_('pay'),
        amount: -refund,
        method: method,
        reference: String(payload.reference || '').trim().substr(0, 80),
        received_at: when,
        note: 'Refund, order cancelled' + (note ? ': ' + note : ''),
        recorded_by: SHOP_WRITER_NAME,
        created_at: at
      });
      patch.paid_total = money2_((numberOrNull_(fresh.paid_total) || 0) - refund);
    }
    if (!fresh.paid_at) patch.paid_at = at;
    updateRow_('Jobs', fresh._row, patch);
    const reason = 'Cancelled' + (refund > 0 ? ', refunded ' + money_(refund) : '') + (note ? ': ' + note : '');
    if (!setStatus_(jobRow_(id), 'done', 'service_writer', '', reason)) {
      recordStatus_(fresh.id, fresh.status, fresh.status, 'service_writer', '', reason);
    }

    // Off the parts list: whatever nobody has bought yet. Highest row first,
    // because each delete moves every row below it up one.
    const lines = rows_('PartsOrders').filter(function (part) { return part.job_id === fresh.id; });
    const unbought = lines.filter(function (part) { return part.status === 'needed'; })
      .map(function (part) { return part._row; })
      .sort(function (a, b) { return b - a; });
    if (unbought.length) {
      const sheet = sheet_('PartsOrders');
      unbought.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
      forget_('PartsOrders');
    }
    return {
      removed: unbought.length,
      stillOnOrder: lines.filter(function (part) { return part.status === 'ordered'; }).length
    };
  });

  const after = jobRow_(id);
  return {
    job: jobSummary_(after),
    payments: paymentsForJob_(id),
    files: filesForJob_(id),
    refunded: refund,
    kept: orderPaid_(after),
    partsRemoved: outcome.removed,
    partsStillOnOrder: outcome.stillOnOrder
  };
}

function statementDraftRow_(id) {
  const all = rows_('StatementDrafts');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

function statementDraftView_(row) {
  const invoices = JSON.parse(row.invoices_json || '[]');
  return {
    id: row.id,
    customerName: row.customer_name || '',
    customerPhone: row.customer_phone || '',
    customerEmail: row.customer_email || '',
    invoices: invoices,
    totalDue: Math.round(invoices.reduce(function (sum, inv) {
      return sum + (Number(inv.amountDue) || 0);
    }, 0) * 100) / 100,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * A statement staged but not yet sent. Every open invoice for one customer,
 * with each PDF already sitting in Drive by the time this returns — a draft
 * exists so a writer can build the whole thing, walk away, and come back
 * with a mechanic to double-check it later, possibly in a different session
 * entirely, so nothing about it can live only in the browser.
 *
 * `id` given means update the existing draft in place — a writer coming
 * back to add one more invoice or fix a figure, not create a second draft
 * for the same customer. An invoice that already has a `driveFile` (kept
 * from an earlier save, untouched since) is not re-uploaded; only ones
 * carrying fresh `invoicePdf` bytes cost a Drive write here.
 */
function saveStatementDraft(token, payload) {
  requireAdmin_(token);
  const invoices = Array.isArray(payload.invoices) ? payload.invoices : [];
  if (!invoices.length) throw new Error('Add at least one invoice before saving a draft.');

  const id = String(payload.id || '').trim() || newId_('stmtdraft');
  const stored = invoices.map(function (inv) {
    const number = String(inv.invoiceNumber || '').trim().toUpperCase();
    let driveFile = inv.driveFile || '';
    if (inv.invoicePdf) {
      driveFile = saveFile_(id, 'invoice-' + (number || 'unnumbered') + '.pdf', 'application/pdf', inv.invoicePdf);
    }
    if (!driveFile) throw new Error('Every invoice needs a PDF before it can be saved to a draft.');
    return {
      invoiceNumber: number,
      boatInfo: inv.boatInfo || '',
      grandTotal: numberOrNull_(inv.grandTotal),
      deposits: numberOrNull_(inv.deposits),
      amountDue: numberOrNull_(inv.amountDue),
      driveFile: driveFile,
      filename: inv.filename || ''
    };
  });

  const existing = payload.id ? statementDraftRow_(id) : null;
  const at = nowIso_();
  const row = {
    id: id,
    customer_name: payload.customerName || '',
    customer_phone: payload.customerPhone || '',
    customer_email: payload.customerEmail || '',
    invoices_json: JSON.stringify(stored),
    created_at: existing ? existing.created_at : at,
    updated_at: at
  };
  if (existing) updateRow_('StatementDrafts', existing._row, row);
  else appendRow_('StatementDrafts', row);
  return { draft: statementDraftView_(row) };
}

/** Every staged statement, most recently touched first. */
function listStatementDrafts(token) {
  requireAdmin_(token);
  return {
    drafts: rows_('StatementDrafts').map(statementDraftView_)
      .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); })
  };
}

/**
 * Drops the row only. The Drive files it pointed at are left where they
 * are — an abandoned draft is rare enough that cleaning up after it is not
 * worth a round trip per invoice, and nothing else in this backend chases
 * down orphaned Drive files either.
 */
function deleteStatementDraft(token, id) {
  requireAdmin_(token);
  const row = statementDraftRow_(id);
  if (!row) throw new Error('No such draft.');
  sheet_('StatementDrafts').deleteRow(row._row);
  forget_('StatementDrafts');
  return { deleted: id };
}

/**
 * The stamped work order, uploaded a moment after the job is created.
 *
 * It cannot come with createJob: the QR code has to point at a tracking token
 * that does not exist until the row does, so the browser creates the job,
 * draws the code, and posts the finished PDF back here.
 */
function attachWorkOrder(token, id, pdfBase64) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  if (!pdfBase64) throw new Error('No document was attached.');
  const fileId = saveFile_(job.id, 'work-order-' + job.id + '.pdf', 'application/pdf', pdfBase64);
  updateRow_('Jobs', job._row, { work_order_file: fileId, updated_at: nowIso_() });
  return { job: jobSummary_(jobRow_(id)) };
}

/**
 * A job is finished with the writer when it is both done AND paid.
 *
 * Not simply done: a closed ticket the customer has not settled is still the
 * writer's problem, and it is the one most easily forgotten — the work is
 * over, so nothing else brings it back to their attention. So "open" means
 * anything still wanting something from the office.
 */
function isOpenJob_(job) {
  return !(job.status === 'done' && job.paid_at);
}

function listJobs(token, filter) {
  requireAdmin_(token);
  filter = filter || {};
  // The writer's list, answered from memory the same way as the mechanic's
  // open-jobs list and dropped by the same generation — see OPEN_JOBS_V_. The
  // key carries the filter, since the answer depends on it.
  const key = JOBS_LIST_KEY_ + JSON.stringify([filter.status || '', String(filter.search || '')]);
  if (!filter.fresh) {
    const gen = currentListsGen_();
    const hit = gen ? cacheGetBig_(key + gen) : null;
    if (hit && Array.isArray(hit.jobs)) {
      hit.fromCache = true;
      return hit;
    }
  }
  const gen = listsGen_();
  const out = jobsListFromSheet_(filter);
  cachePutBig_(key + gen, out, OPEN_JOBS_TTL_);
  return out;
}

// Bump whenever a job summary gains a field, for the reason OPEN_JOBS_V_ says.
const JOBS_LIST_V_ = 8;
const JOBS_LIST_KEY_ = 'JOBSLIST_v' + JOBS_LIST_V_ + '_';

/**
 * Whatever the customer says first on the phone. Every word typed must turn
 * up somewhere in the invoice number, name, email or unit, in any order, so
 * "john white" and "white john" find the same job. A query of digits and
 * phone punctuation only is a phone number and is matched on its digits, so
 * "815-433-2200" finds "(815) 433 2200" however it was keyed. The Service
 * Desk (questws.github.io/desk/) sends the same text here and to the winter
 * console's search, which matches the same way (searchMatcher_ there).
 */
function matchesSearch_(job, search) {
  if (!search) return true;
  const digits = search.replace(/\D/g, '');
  if (/^[\d\s()+.\-]+$/.test(search) && digits.length >= 3) {
    if (String(job.id || '').indexOf(search) !== -1) return true;
    return String(job.customer_phone || '').replace(/\D/g, '').indexOf(digits) !== -1;
  }
  const hay = [job.id, job.customer_name, job.customer_email, job.boat_info, job.customer_phone]
    .join(' ').toLowerCase();
  return search.split(/[\s,]+/).filter(String).every(function (word) {
    return hay.indexOf(word) !== -1;
  });
}

/** The writer's list, read from the sheet. Writes nothing, caches nothing. */
function jobsListFromSheet_(filter) {
  const search = String(filter.search || '').trim().toLowerCase();
  const jobs = rows_('Jobs')
    .filter(function (job) {
      // An archived job is on the Archived list and no other — not even All.
      // `every` is the whole tab, archived included: what the portal fetches
      // once and then sorts into its chips itself.
      if (filter.status === 'every') {
        // nothing filtered out
      } else if (filter.status === 'archived') {
        if (!job.archived_at) return false;
      } else if (job.archived_at) {
        return false;
      } else if (filter.status === 'open') {
        if (!isOpenJob_(job)) return false;
      } else if (filter.status && filter.status !== 'all' && job.status !== filter.status) {
        return false;
      }
      return matchesSearch_(job, search);
    })
    .map(function (job) {
      const summary = jobSummary_(job);
      // Off the job row. Counting these used to mean reading every log entry
      // in the shop on every load of this page.
      summary.entryCount = Number(job.entry_count || 0);
      summary.minutes = Number(job.minutes_total || 0);
      summary.hours = hoursFromMinutes_(summary.minutes);
      return summary;
    })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

  // The counts are the Jobs page's stats, and an order on them would read as
  // a boat waiting. The Orders page counts its own off the list.
  const byStatus = { open: 0, archived: 0 };
  rows_('Jobs').forEach(function (job) {
    if (isPartsOrder_(job)) return;
    if (job.archived_at) {
      byStatus.archived += 1;
      return;
    }
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    if (isOpenJob_(job)) byStatus.open += 1;
  });
  // Approved detail quotes waiting on the writer's BiT work order — on the
  // same answer, so the jobs page stays one call (linkDetailJob makes them jobs).
  // Detail quote requests that are not jobs yet — every one, from the moment
  // it is taken in — on the same answer, so the jobs page stays one call and
  // its search finds a caller's quote as well as their jobs.
  const quotes = detailQuotesForDesk_();
  return { jobs: jobs, counts: byStatus, testMode: testMode_(), detailQuotes: quotes,
           detailWaiting: quotes.filter(function (d) { return d.stage === 'ticket'; }) };
}

/**
 * Every open invoice — done, unpaid, still owing something real — grouped by
 * the customer it belongs to. A "customer" here is an email address: it is
 * the one field guaranteed to route a statement to a single mailbox, and a
 * job carrying none cannot be statemented any more than it can be invoiced.
 *
 * Recomputed fresh on every call rather than cached, because this is what
 * decides who gets mailed — a payment ticked five minutes ago must already
 * be off the list.
 */
function openInvoicesByCustomer_() {
  const groups = {};
  rows_('Jobs').forEach(function (job) {
    if (job.status !== 'done' || job.paid_at) return;
    // What is still owed, not what the invoice originally said. A customer
    // who paid half last week must be asked for half, and a statement built
    // off the invoice figure would bill them twice for the part they settled.
    const due = jobBalance_(job);
    if (!due || due <= 0) return;
    const email = normalizeEmails_(job.customer_email);
    if (!email) return;
    // Keyed on the FIRST address, not the whole list. A customer whose newer
    // job carries their wife's address as well is still one customer with one
    // statement to settle, and keying on the list would send them two.
    const key = emailList_(email)[0].toLowerCase();
    if (!groups[key]) {
      groups[key] = {
        customerEmail: email,
        customerName: job.customer_name || '',
        customerPhone: job.customer_phone || '',
        invoices: [],
        totalDue: 0,
        _doneAt: ''
      };
    }
    const group = groups[key];
    // The most recently finished job's name and phone win, on the chance the
    // office corrected a typo since an older invoice was written.
    if (String(job.done_at || '') >= group._doneAt) {
      group.customerName = job.customer_name || group.customerName;
      group.customerPhone = job.customer_phone || group.customerPhone;
      // Including who else is on it now — the statement goes where the most
      // recent job says it should.
      group.customerEmail = email;
      group._doneAt = job.done_at || group._doneAt;
    }
    group.invoices.push({ id: job.id, boatInfo: job.boat_info || '', amountDue: due, doneAt: job.done_at || '' });
    group.totalDue += due;
  });
  return Object.keys(groups).map(function (key) {
    const group = groups[key];
    delete group._doneAt;
    group.invoices.sort(function (a, b) { return String(a.doneAt).localeCompare(String(b.doneAt)); });
    group.totalDue = Math.round(group.totalDue * 100) / 100;
    return group;
  }).sort(function (a, b) {
    return String(a.customerName || a.customerEmail).localeCompare(String(b.customerName || b.customerEmail));
  });
}

/** Open invoices that would belong on a statement but have nowhere to send one. */
function openInvoicesMissingEmail_() {
  return rows_('Jobs').filter(function (job) {
    const due = jobBalance_(job);
    return job.status === 'done' && !job.paid_at && due && due > 0 && !normalizeEmails_(job.customer_email);
  }).map(function (job) {
    return { id: job.id, customerName: job.customer_name || '', amountDue: jobBalance_(job) };
  });
}

/** What the Statements page shows: every customer still owed for, and when a statement last reached each. */
function listOpenStatements(token) {
  requireAdmin_(token);
  const groups = openInvoicesByCustomer_();
  const lastSent = {};
  rows_('EmailLog').forEach(function (mail) {
    if (mail.kind !== 'statement' && mail.kind !== 'statement_test') return;
    if (!lastSent[mail.job_id] || mail.created_at > lastSent[mail.job_id]) lastSent[mail.job_id] = mail.created_at;
  });
  groups.forEach(function (group) {
    // A statement's invoices are logged and sent together, so any one of
    // them carrying a recent send means the whole thing went.
    const sent = group.invoices.map(function (inv) { return lastSent[inv.id]; }).filter(Boolean).sort();
    group.lastSentAt = sent.length ? sent[sent.length - 1] : null;
  });
  return { customers: groups, missingEmail: openInvoicesMissingEmail_(), testMode: testMode_() };
}

/**
 * Statement sends, newest first — reconstructed from EmailLog rather than
 * kept in a table of their own. sendStatement_ stamps every invoice's row
 * from one send with the exact same recipient, subject and timestamp, which
 * is what makes that triple a reliable key to regroup them by.
 *
 * Each invoice is reported with its CURRENT balance and open/paid state
 * rather than a frozen figure from the day the statement went out — a
 * customer who paid one of three since is more useful shown as paid than
 * repeated back at whatever they owed when the email was sent.
 */
function listSentStatements(token) {
  requireAdmin_(token);
  const groups = {};
  const order = [];
  rows_('EmailLog').forEach(function (mail) {
    if (mail.kind !== 'statement' && mail.kind !== 'statement_test') return;
    const key = mail.recipient + '|' + mail.subject + '|' + mail.created_at;
    if (!groups[key]) {
      groups[key] = {
        recipient: mail.recipient,
        subject: mail.subject,
        sentAt: mail.created_at,
        status: mail.status,
        testMode: mail.kind === 'statement_test',
        jobIds: []
      };
      order.push(key);
    }
    groups[key].jobIds.push(mail.job_id);
    // A batch either all sent, all held or all failed together; a failed
    // row anywhere in it means the send itself failed.
    if (mail.status === 'failed') groups[key].status = 'failed';
  });

  const sends = order.map(function (key) {
    const group = groups[key];
    const jobs = group.jobIds.map(function (id) { return jobRow_(id); }).filter(Boolean);
    const first = jobs[0];
    return {
      customerEmail: first ? first.customer_email : String(group.recipient).split(' (cc')[0],
      customerName: first ? first.customer_name : '',
      sentAt: group.sentAt,
      subject: group.subject,
      status: group.status,
      testMode: group.testMode,
      invoices: jobs.map(function (job) {
        const due = numberOrNull_(job.amount_due);
        return { id: job.id, amountDue: due, stillOpen: isOpenJob_(job) && due !== null && due > 0 };
      })
    };
  }).sort(function (a, b) { return String(b.sentAt).localeCompare(String(a.sentAt)); });

  return { sends: sends };
}

/** Every tab the writer's job page draws from, fetched in one trip. */
const JOB_PAGE_TABS_ = ['Jobs', 'LogEntries', 'PropRepairs', 'PartsOrders', 'JobFiles', 'Payments', 'EmailLog'];

function getJob(token, id) {
  requireAdmin_(token);
  prefetch_(JOB_PAGE_TABS_);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const entries = entriesForJob_(id);
  return {
    testMode: testMode_(),
    customerTracking: customerTracking_(),
    job: jobSummary_(job),
    // The detailer's half of a split ticket: its lines and where they stand.
    detailWork: job.detail_split && ss_().getSheetByName('Details')
      ? (function () { const d = detailForJob_(id); return d ? detailView_(d, job) : null; })() : null,
    entries: entries,
    hours: laborTotals_(entries),
    props: propsForJob_(id),
    parts: partsForJob_(id),
    files: filesForJob_(id),
    // Money taken against this invoice, so the job page can show what is left
    // to collect without a second call.
    payments: paymentsForJob_(id),
    // Whether the shop has a Google review link set at all. The payment form's
    // review tick box hangs off it: an ask that links nowhere is worse than no
    // ask, so the box is disabled and says where to set one.
    reviewUrl: reviewUrl_(),
    // What the invoice email can carry in attachments, so the page can say
    // when a customer file will go as a Drive link instead of an attachment
    // rather than leaving the writer to find out from the customer.
    mailLimit: MAIL_ATTACHMENT_BUDGET,
    // The mail log stays. It is not just a panel: the page reads it to know
    // whether the invoice has already gone, which is what the send button
    // hangs off. The status timeline is display only, so that one is fetched
    // when asked for — see jobHistory.
    emails: rows_('EmailLog').filter(function (mail) { return mail.job_id === id; }).reverse()
  };
}

/**
 * The status timeline for one job, fetched only when the writer asks for it.
 *
 * It used to ride along with getJob, which meant another whole-tab read on
 * every single open of a job page for a panel nobody looks at most visits.
 *
 * Only the timeline moved. The mail log looked like the same kind of thing and
 * is not: the page reads it to decide whether the invoice has already been
 * sent, so deferring it would have left the send button lying until somebody
 * clicked Show.
 */
function jobHistory(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  return {
    timeline: rows_('StatusEvents').filter(function (event) { return event.job_id === id; })
  };
}

function saveJobDetails(token, id, fields) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  // One line per address on the form, one cell here. Normalised before the
  // review flags are worked out, so a box holding nothing but punctuation
  // counts as no address on file rather than as an address.
  const saved = Object.assign({}, fields, { customerEmail: normalizeEmails_(fields.customerEmail) });
  updateRow_('Jobs', job._row, {
    customer_name: saved.customerName || '',
    customer_phone: saved.customerPhone || '',
    customer_email: saved.customerEmail,
    boat_info: saved.boatInfo || '',
    work_requested: saved.workRequested || '',
    // The flag list is derived, never typed: filling a field clears its flag.
    needs_review: missingFields_(saved, isPartsOrder_(job) ? 'parts' : '').join(','),
    updated_at: nowIso_()
  });
  return { job: jobSummary_(jobRow_(id)) };
}

/**
 * The final invoice, its payment link, and what the customer actually owes.
 *
 * The figures are read off the PDF in the service writer's browser and
 * confirmed by them before they land here — a deposit means the amount due is
 * nothing like the grand total, and that is the number the customer wants.
 */
function saveInvoice(token, id, paymentLink, invoicePdf, totals) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  if (paymentLink && !/^https?:\/\//i.test(paymentLink)) {
    throw new Error('The payment link must start with http:// or https://');
  }
  const patch = { payment_link: paymentLink || '', updated_at: nowIso_() };
  if (invoicePdf) {
    patch.invoice_file = saveFile_(id, 'invoice-' + id + '.pdf', 'application/pdf', invoicePdf);
  }
  if (totals) {
    patch.grand_total = numberOrNull_(totals.grandTotal) === null ? '' : Number(totals.grandTotal);
    patch.deposits = numberOrNull_(totals.deposits) === null ? '' : Number(totals.deposits);
    patch.amount_due = numberOrNull_(totals.amountDue) === null ? '' : Number(totals.amountDue);
  }
  updateRow_('Jobs', job._row, patch);
  return { job: jobSummary_(jobRow_(id)) };
}

function recordStatus_(jobId, from, to, actorType, actor, note) {
  appendRow_('StatusEvents', {
    id: newId_('sev'),
    job_id: jobId,
    from_status: from,
    to_status: to,
    actor_type: actorType,
    actor: actor || '',
    note: note || '',
    created_at: nowIso_()
  });
}

/**
 * The only way a job's status changes. Refuses to run the lifecycle
 * backwards and stamps the matching timestamp column.
 */
function setStatus_(job, to, actorType, actor, note) {
  if (job.status === to) return false;
  if (STATUS_ORDER[to] < STATUS_ORDER[job.status]) return false;

  const at = nowIso_();
  const patch = { status: to, updated_at: at };
  if (to === 'work_underway' && !job.work_started_at) patch.work_started_at = at;
  if (to === 'work_finished' && !job.work_finished_at) patch.work_finished_at = at;
  if (to === 'done' && !job.done_at) patch.done_at = at;
  updateRow_('Jobs', job._row, patch);
  recordStatus_(job.id, job.status, to, actorType, actor, note);
  return true;
}

function setStatusByWriter(token, id, to) {
  requireAdmin_(token);
  if (STATUSES.indexOf(to) === -1 || to === 'done') throw new Error('That status change is not allowed.');
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  setStatus_(job, to, 'service_writer', '', 'Set by service writer');
  return { job: jobSummary_(jobRow_(id)) };
}

/* ============================== entries ================================ */

function parsePhotos_(cell) {
  if (!cell) return [];
  try {
    const parsed = JSON.parse(cell);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function entryView_(entry) {
  return {
    id: entry.id,
    jobId: entry.job_id,
    mechanicId: entry.mechanic_id || null,
    mechanicName: entry.mechanic_name || null,
    entryType: entry.entry_type,
    text: entry.text || null,
    hours: entry.hours === '' || entry.hours === null ? null : Number(entry.hours),
    partIdentifier: entry.part_identifier || null,
    quantity: entry.quantity === '' || entry.quantity === null ? null : Number(entry.quantity),
    audioFile: entry.audio_file || null,
    photos: parsePhotos_(entry.photos),
    // What was typed and what was said, separately. Older entries kept the
    // transcript in `text`, which is why this is not a rename.
    transcript: entry.transcript || null,
    transcriptStatus: entry.transcript_status || null,
    transcriptError: entry.transcript_error || null,
    loggedAt: entry.logged_at || null,
    createdAt: entry.created_at
  };
}

function entriesForJob_(jobId) {
  return rows_('LogEntries')
    .filter(function (entry) { return String(entry.job_id) === String(jobId); })
    .map(entryView_)
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

/**
 * THE customer boundary. Everything the public page shows comes through
 * here, and nothing else does.
 *
 * Only customer notes survive, and only their words, their photos and when
 * they were written. No mechanic name, no hours, no part number, no audio,
 * no transcription plumbing — at any status. A voice note still waiting on
 * its transcript has no words yet, so it stays out rather than showing an
 * empty row; it appears on its own once the text lands.
 *
 * Spoken words count as words. They used to arrive in `text` and now arrive
 * in `transcript`, so both are read and joined — the customer sees the note,
 * not the mechanics of how it was dictated.
 *
 * If a new field is ever added to a log entry, its visibility is decided
 * here, not in a page template.
 */
function customerWords_(entry) {
  return [entry.text, entry.transcript].filter(Boolean).join('\n\n') || null;
}

function customerView_(entries) {
  return entries
    .filter(function (entry) {
      if (entry.entryType !== 'customer_note') return false;
      return Boolean(customerWords_(entry)) || entry.photos.length > 0;
    })
    .map(function (entry) {
      return {
        id: entry.id,
        text: customerWords_(entry),
        photos: entry.photos,
        createdAt: entry.createdAt
      };
    });
}

/** Total labor on a job, and the split by mechanic the shop reckons with. */
function laborTotals_(entries) {
  let total = 0;
  const byPerson = {};
  entries.forEach(function (entry) {
    if (entry.entryType !== 'labor' || !entry.hours) return;
    const minutes = minutesFromHours_(entry.hours);
    total += minutes;
    const who = entry.mechanicName || 'Unknown';
    byPerson[who] = (byPerson[who] || 0) + minutes;
  });
  return {
    // Both units travel: `hours` is the figure the writer re-keys into BiT,
    // `minutes` is what the pages render, and neither is derived from a
    // rounded version of the other.
    total: hoursFromMinutes_(total),
    totalMinutes: total,
    byMechanic: Object.keys(byPerson)
      .map(function (name) {
        return { name: name, hours: hoursFromMinutes_(byPerson[name]), minutes: byPerson[name] };
      })
      .sort(function (a, b) { return b.minutes - a.minutes; })
  };
}

/**
 * Everything the mechanic's job screen draws itself from — and deliberately
 * NOT the log.
 *
 * Reading one job's entries means reading every entry in the shop: a Sheet has
 * no index, so `entriesForJob_` pulls the whole LogEntries tab and filters it.
 * It was the largest read on this path and the only one that grows every week
 * the shop uses the app, and it was being paid on every single job opened.
 *
 * The screen does not need it to be useful. A mechanic opens a job for the
 * alert, for what needs doing, and for the box to log into. The count and the
 * running total come off the Jobs row, so the card can honestly say "Job log
 * (7)" and fetch those seven when somebody asks for them — `jobLog` below.
 *
 * Props are left out for the same reason and a simpler one: they are only ever
 * drawn inside the Prop tab, so the tab fetches them when it opens.
 */
function mechanicPayload_(who, job) {
  return {
    mechanic: { id: who.id, name: who.name },
    job: jobSummary_(job),
    hours: {
      total: hoursFromMinutes_(Number(job.minutes_total || 0)),
      totalMinutes: Number(job.minutes_total || 0)
    }
  };
}

/** The log itself, when the mechanic asks to see it. */
function jobLog(token, jobToken) {
  requireMechanic_(token);
  prefetch_(['Jobs', 'LogEntries']);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  const entries = entriesForJob_(job.id);
  // The full breakdown, not the row's total: whoever asked for the log is
  // reading the detail, and this is the version that is right even if the
  // derived column has drifted.
  return { entries: entries, hours: laborTotals_(entries) };
}

/** What is already away at the prop shop, for the Prop tab. */
function jobProps(token, jobToken) {
  requireMechanic_(token);
  prefetch_(['Jobs', 'PropRepairs']);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  return { props: propsForJob_(job.id) };
}

function jobForMechanic(token, jobToken) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  return mechanicPayload_(who, job);
}

/**
 * One entry against a job: typed or spoken, with photos, from a phone in a
 * shop. Photos arrive already shrunk by the browser in two sizes.
 */
/**
 * The entry the phone gave this client id, if it ever landed.
 *
 * Only ever called on a retry — it reads the whole LogEntries tab, which is
 * the read every other path here works to avoid.
 */
function entryByClientId_(clientId) {
  if (!clientId) return null;
  const all = rows_('LogEntries');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].client_id) === String(clientId)) return all[i];
  }
  return null;
}

function addEntry(token, jobToken, payload) {
  const who = requireMechanic_(token);

  // The phone's own id for this entry, and whether this is the phone asking
  // again. Both come off the outbox — see the client_id column.
  const clientId = String((payload && payload.clientId) || '');
  const isRetry = Boolean(payload && payload.retry);

  const type = payload.entryType;
  if (!ENTRY_LABEL[type]) throw new Error('Pick what kind of entry this is.');

  const text = String(payload.text || '').trim();
  const hasAudio = Boolean(payload.audio);
  const photos = payload.photos || [];

  // The mechanic app sends whole minutes, because that is what it asks for.
  // `hours` is still accepted: it is what the estimate side of the same screen
  // has always sent, and what anything already on the wire sends.
  let hours = null;
  if (payload.minutes !== '' && payload.minutes !== null && payload.minutes !== undefined) {
    const minutes = Number(payload.minutes);
    if (!isFinite(minutes) || minutes <= 0 || Math.round(minutes) !== minutes) {
      throw new Error('Time has to be a whole number of minutes, greater than zero.');
    }
    hours = hoursFromMinutes_(minutes);
  } else if (payload.hours !== '' && payload.hours !== null && payload.hours !== undefined) {
    hours = Number(payload.hours);
  }
  if (hours !== null && (!isFinite(hours) || hours <= 0)) {
    throw new Error('Time on the job has to be greater than zero.');
  }
  const quantity = payload.quantity ? Number(payload.quantity) : null;
  if (quantity !== null && (!isFinite(quantity) || quantity <= 0)) {
    throw new Error('Quantity must be a number greater than zero.');
  }

  if (type === 'part' && !String(payload.partIdentifier || '').trim()) {
    throw new Error('Scan or type the part number.');
  }
  if (type === 'labor') {
    if (hours === null) throw new Error('How long did this take?');
    // Hours with no description are no use to whoever writes the invoice.
    if (!text && !hasAudio) throw new Error('Say what you did with that time.');
  } else if (type !== 'part' && !text && !hasAudio && !photos.length) {
    throw new Error('Add a note, a recording or a photo before saving.');
  }

  const orderQty = payload.orderQty ? Number(payload.orderQty) : null;
  const restockQty = payload.restockQty ? Number(payload.restockQty) : null;
  [['order', orderQty], ['restock', restockQty]].forEach(function (pair) {
    if (pair[1] !== null && (!isFinite(pair[1]) || pair[1] <= 0)) {
      throw new Error('How many to ' + pair[0] + '? It needs to be a number greater than zero.');
    }
  });

  /**
   * Files go to Drive BEFORE the lock is taken.
   *
   * Every save in the shop queues on one script lock. A photo is two Drive
   * writes — thumbnail and full — and Drive is slow, so a mechanic saving two
   * photos held every other mechanic's save behind four uploads that had
   * nothing to do with the spreadsheet. The lock exists to keep two saves
   * from reading the same running total; it was never there to protect a file
   * upload.
   *
   * The price is one read of the Jobs tab before the lock, to know which
   * folder the photos belong in — and the copy it leaves behind is dropped
   * inside the lock, because it predates it. A save with no files pays
   * nothing for this.
   */
  const hasFiles = Boolean(photos.length || hasAudio);
  let stored = [];
  let audioFile = '';
  /**
   * A retry asks first, and only a retry.
   *
   * The phone keeps an entry it could not send in an outbox and sends it
   * again when it next opens, so the same note can arrive twice — once from a
   * request whose answer was lost on the way back, once from the retry. A
   * second copy of a labor entry is money, so this has to be impossible
   * rather than unlikely.
   *
   * The `rid` claim in doPost covers duplicates minutes apart without reading
   * anything. It cannot cover a phone that spent the night in a locker: by
   * morning the cached answer is long gone. That is what this is for, and why
   * it reads the sheet rather than a cache.
   *
   * **It is deliberately not on the first attempt.** Finding one entry by its
   * client id means reading every entry in the shop — the exact read that was
   * taken off this path because it grows every week — and a first attempt has
   * nothing to find. A retry is rare enough to pay for it.
   *
   * Before the upload, not inside the lock, so a duplicate does not push two
   * more photos into Drive on its way to being thrown away. The concurrent
   * case — two copies of one tap in the same moment — is the rid claim's, and
   * it takes the script lock to settle it.
   */
  if (isRetry && clientId) {
    const already = entryByClientId_(clientId);
    if (already) {
      const onJob = jobRow_(already.job_id);
      return {
        entry: entryView_(already),
        job: onJob ? jobSummary_(onJob) : null,
        hours: {
          total: hoursFromMinutes_(Number((onJob && onJob.minutes_total) || 0)),
          totalMinutes: Number((onJob && onJob.minutes_total) || 0)
        },
        // The phone clears it out of the outbox on this exactly as it would on
        // a fresh save. Saying which it was is for the log, not the mechanic.
        duplicate: true
      };
    }
  }

  if (hasFiles) {
    const unlocked = jobByToken_(jobToken);
    if (!unlocked) throw new Error('No such job.');
    stored = photos.slice(0, 8).map(function (photo, index) {
      return {
        thumb: saveFile_(unlocked.id, 'photo-' + Date.now() + '-' + index + '-thumb.jpg', 'image/jpeg', photo.thumb),
        full: saveFile_(unlocked.id, 'photo-' + Date.now() + '-' + index + '.jpg', 'image/jpeg', photo.full)
      };
    });
    if (hasAudio) {
      audioFile = saveFile_(unlocked.id, 'voice-' + Date.now() + '.' + (payload.audioExt || 'webm'),
        payload.audioMime || 'audio/webm', payload.audio);
    }
  }

  const saved = withLock_(function () {
    // The job is read INSIDE the lock, and that is the whole point of doing
    // it here rather than at the top. The running totals have to be read and
    // incremented without another save landing in between, and reading the
    // tab once with the lock held is the same guarantee the old re-read gave
    // — for one fewer read of every job in the shop.
    if (hasFiles) forget_('Jobs');
    const job = jobByToken_(jobToken);
    if (!job) throw new Error('No such job.');

    const entry = {
      id: newId_('log'),
      job_id: job.id,
      mechanic_id: who.id,
      mechanic_name: who.name,
      entry_type: type,
      text: text,
      // The bookkeeping fields belong to exactly one entry type each. Pinning
      // them here means a part number or a labor figure cannot ride along on
      // a customer note, whatever the page sent.
      hours: type === 'labor' ? hours : '',
      part_identifier: type === 'part' ? String(payload.partIdentifier).trim() : '',
      quantity: type === 'part' && quantity ? quantity : '',
      audio_file: audioFile,
      photos: stored.length ? JSON.stringify(stored) : '',
      // Every recording gets transcribed. It used to skip the ones with a
      // typed note beside them — on the reasoning that the words were already
      // there — but a mechanic who records AND types has said two things, and
      // only one of them was being kept.
      transcript_status: audioFile ? 'pending' : '',
      transcript_id: '',
      transcript_error: '',
      notified_at: '',
      created_at: nowIso_(),
      // Written on every entry, not only the ones that get retried: it is
      // what a later retry looks itself up by, and the row has to carry it
      // before anybody knows whether the answer got home.
      client_id: clientId
    };
    appendRow_('LogEntries', entry);

    // Logging against a job nobody scanned still means work has started.
    if (job.status === 'received') {
      setStatus_(job, 'work_underway', 'mechanic', who.name, 'First log entry');
    }

    // A part the mechanic says has to be ordered, or put back on the shelf,
    // becomes a line on the parts list then and there. Both can be true at
    // once: one off the shelf for this boat, another to replace it.
    if (type === 'part') {
      if (orderQty !== null) {
        addPartOrder_({
          jobId: job.id, sourceEntry: entry.id, partIdentifier: entry.part_identifier,
          description: text, quantity: orderQty, reason: 'job', requestedBy: who.name
        });
      }
      if (restockQty !== null) {
        addPartOrder_({
          jobId: job.id, sourceEntry: entry.id, partIdentifier: entry.part_identifier,
          description: text, quantity: restockQty, reason: 'restock', requestedBy: who.name
        });
      }
    }

    const saved = bumpJobEntryTotals_(job.id, type === 'labor' ? minutesFromHours_(hours) : 0, true);

    // No entries in the answer. It used to hand back every entry on the job —
    // a full read of the LogEntries tab, which grows forever — to return a
    // list the phone already had. It appends the one new entry itself.
    //
    // The job comes back too: logging the first entry moves the status, and
    // the phone should not go on showing "Received" after it has.
    return {
      entry: entryView_(entry),
      job: jobSummary_(saved),
      hours: {
        total: hoursFromMinutes_(Number(saved.minutes_total || 0)),
        totalMinutes: Number(saved.minutes_total || 0)
      },
      transcribe: entry.transcript_status === 'pending' ? { entryId: entry.id, audioFile: audioFile } : null
    };
  });

  // Sending the audio to AssemblyAI means reading the whole recording back
  // out of Drive and pushing those bytes over the wire twice. That cannot
  // happen anywhere in this request.
  //
  // It used to be a plain call right here, on the reasoning that being
  // outside the lock meant nobody waited on it. Outside the lock only means
  // the REST of the floor is not waiting: this execution is what the phone
  // is holding a connection open for, and Apps Script has no way to leave a
  // call running after the answer goes back. So the mechanic who recorded
  // the note stood and watched a Drive read and two uploads to a third party
  // — minutes of it, when the shop's wifi or AssemblyAI was having a bad
  // afternoon — after the entry was already safely in the sheet.
  //
  // The row is written and marked pending, which is all the phone needs.
  // Handing off to a trigger puts the upload in its own execution, seconds
  // later, where slow costs nobody anything.
  const queued = saved.transcribe;
  delete saved.transcribe;
  if (queued) queueTranscriptRun_();
  return saved;
}

function finishWork(token, jobToken) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  if (job.status === 'done') throw new Error('This job is already closed out.');
  const split = String(job.detail_split || '');
  if (split === 'detail') throw new Error('This one is the detailer\u2019s alone \u2014 they mark it done in the Detail Tracker.');
  if (split === 'both') {
    // A split ticket: this is the mechanic's half. The job is finished when
    // the detailer's half is too, whichever of them gets there second.
    withLock_(function () {
      forget_('Jobs');
      const fresh = jobRow_(job.id);
      if (!fresh.mech_done_at) updateRow_('Jobs', fresh._row, { mech_done_at: nowIso_(), updated_at: nowIso_() });
      forget_('Jobs');
      const now = jobRow_(job.id);
      if (now.status === 'received') setStatus_(now, 'work_underway', 'mechanic', who.name, 'Mechanical work finished');
      if (now.detail_done_at) setStatus_(jobRow_(job.id), 'work_finished', 'mechanic', who.name, 'Mechanic finished — detail already done');
    });
    try { bumpDetailVersion_(); } catch (err) { /* the board catches up on its next read */ }
    const after = jobRow_(job.id);
    const waiting = after.status !== 'work_finished';
    if (waiting) {
      try {
        const d = detailForJob_(job.id);
        if (d) withLock_(function () { detailEvent_(d.id, 'mech', who.name + ' finished the mechanical work on job ' + job.id + ' — waiting on the detail', who.name); });
      } catch (err) { /* the event is a courtesy */ }
    }
    return { status: after.status, statusLabel: waiting ? 'Mechanical done — waiting on detail' : STATUS_LABEL[after.status],
             waitingOn: waiting ? 'detail' : '' };
  }
  setStatus_(job, 'work_finished', 'mechanic', who.name, '');
  const updated = jobRow_(job.id);
  return { status: updated.status, statusLabel: STATUS_LABEL[updated.status] };
}

/* =========================== parts orders ============================== */

function partView_(part) {
  return {
    id: part.id,
    jobId: part.job_id || null,
    partIdentifier: part.part_identifier || null,
    description: part.description || null,
    quantity: numberOrNull_(part.quantity),
    reason: part.reason,
    reasonLabel: PART_REASON_LABEL[part.reason] || part.reason,
    status: part.status,
    vendor: part.vendor || null,
    orderNumber: part.order_number || null,
    notes: part.notes || '',
    requestedBy: part.requested_by || null,
    createdAt: part.created_at,
    orderedAt: part.ordered_at || null,
    receivedAt: part.received_at || null,
    // Filed away rather than deleted. A flag, not a status: an archived part
    // is still a received one, so nothing about the order grouping changes.
    archivedAt: part.archived_at || null
  };
}

function partRow_(id) {
  const all = rows_('PartsOrders');
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

function addPartOrder_(fields) {
  const row = {
    id: newId_('part'),
    job_id: fields.jobId || '',
    source_entry: fields.sourceEntry || '',
    part_identifier: fields.partIdentifier || '',
    description: fields.description || '',
    quantity: fields.quantity === null || fields.quantity === undefined ? '' : fields.quantity,
    reason: fields.reason,
    status: 'needed',
    vendor: '',
    order_number: '',
    notes: fields.notes || '',
    requested_by: fields.requestedBy || '',
    created_at: nowIso_(),
    ordered_at: '',
    received_at: '',
    archived_at: ''
  };
  appendRow_('PartsOrders', row);
  return row;
}

/**
 * A part somebody wants ordered, with no work order behind it — the usual
 * case being a mechanic at the shelf noticing stock is low.
 *
 * The part number is asked for but not insisted on: somebody standing in
 * front of an empty hook with a description and no number should still be
 * able to get it onto the list.
 */
function requestPart(token, payload) {
  const who = requireShop_(token);
  const description = String((payload && payload.description) || '').trim();
  const identifier = String((payload && payload.partIdentifier) || '').trim();
  if (!description && !identifier) {
    throw new Error('Say which part you need — a number, a description, or both.');
  }
  const quantity = payload.quantity ? Number(payload.quantity) : null;
  if (quantity !== null && (!isFinite(quantity) || quantity <= 0)) {
    throw new Error('Quantity must be a number greater than zero.');
  }
  return withLock_(function () {
    const part = addPartOrder_({
      partIdentifier: identifier,
      description: description,
      quantity: quantity,
      reason: 'stock',
      notes: String((payload && payload.notes) || '').trim(),
      requestedBy: who.name || 'service writer'
    });
    return { part: partView_(part) };
  });
}

/**
 * A part the office puts on a job's ticket — the customer rings up wanting
 * something ordered, and the writer has the work order open in front of them.
 *
 * The same row a mechanic's part entry creates, so it lands on the one parts
 * list and takes a vendor, an order number and a received tick like any other.
 * What differs is only where it came from: there is no log entry behind it,
 * because nobody touched the boat — so source_entry stays empty and the part
 * is credited to the writer rather than to a mechanic.
 *
 * The part number is asked for and not insisted on, the same as a stock
 * request: a customer on the phone describing what they want is exactly the
 * case where nobody has a number yet.
 */
function addJobPart(token, id, payload) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');

  const identifier = String((payload && payload.partIdentifier) || '').trim();
  const description = String((payload && payload.description) || '').trim();
  if (!identifier && !description) {
    throw new Error('Say which part — a number, a description, or both.');
  }
  const quantity = payload && payload.quantity ? Number(payload.quantity) : null;
  if (quantity !== null && (!isFinite(quantity) || quantity <= 0)) {
    throw new Error('How many? It needs to be a number greater than zero.');
  }

  return withLock_(function () {
    const part = addPartOrder_({
      jobId: job.id,
      partIdentifier: identifier,
      description: description,
      quantity: quantity,
      reason: 'job',
      notes: String((payload && payload.notes) || '').trim(),
      requestedBy: SHOP_WRITER_NAME
    });
    return { part: partView_(part), parts: partsForJob_(job.id) };
  });
}

/** Every part on one job's ticket, oldest first, whatever stage it is at. */
function partsForJob_(jobId) {
  return rows_('PartsOrders')
    .filter(function (part) { return part.job_id === jobId; })
    .map(partView_)
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

/** Needed, on order, and the completed orders behind them. */
function listPartsOrders(token) {
  requireAdmin_(token);
  prefetch_(['PartsOrders', 'Jobs']);
  const all = rows_('PartsOrders').map(partView_);
  const jobs = {};
  rows_('Jobs').forEach(function (job) { jobs[job.id] = job.customer_name || ''; });
  all.forEach(function (part) { part.customerName = part.jobId ? (jobs[part.jobId] || null) : null; });

  const byNewest = function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); };
  const needed = all.filter(function (p) { return p.status === 'needed'; }).sort(byNewest);
  const ordered = all.filter(function (p) { return p.status === 'ordered'; }).sort(byNewest);

  // An order is finished when every line on it has come in. Lines received
  // without an order number (walked in, found on the shelf) group on their own.
  // An archived part drops out of the working list entirely. It is still a
  // received part on a completed order — it has just been filed.
  const received = all.filter(function (p) { return p.status === 'received' && !p.archivedAt; });
  const groups = {};
  received.forEach(function (part) {
    const key = part.orderNumber || ('(no order number) ' + part.id);
    if (!groups[key]) groups[key] = { orderNumber: part.orderNumber, vendor: part.vendor, parts: [], receivedAt: '' };
    groups[key].parts.push(part);
    if (String(part.receivedAt) > String(groups[key].receivedAt)) groups[key].receivedAt = part.receivedAt;
  });
  // Anything still outstanding on an order keeps that order out of completed.
  ordered.forEach(function (part) {
    const key = part.orderNumber || '';
    if (key && groups[key]) delete groups[key];
  });
  const completed = Object.keys(groups)
    .map(function (key) { return groups[key]; })
    .sort(function (a, b) { return String(b.receivedAt).localeCompare(String(a.receivedAt)); });

  return { needed: needed, ordered: ordered, completed: completed };
}

/** Marks a batch as ordered, against a vendor and that vendor's order number. */
function markPartsOrdered(token, ids, vendor, orderNumber) {
  requireAdmin_(token);
  const cleanVendor = String(vendor || '').trim();
  const cleanNumber = String(orderNumber || '').trim();
  if (!cleanVendor) throw new Error('Who is it ordered from?');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Tick the parts that went on the order.');

  return withLock_(function () {
    const at = nowIso_();
    ids.forEach(function (id) {
      const part = partRow_(id);
      if (!part || part.status !== 'needed') return;
      updateRow_('PartsOrders', part._row, {
        status: 'ordered', vendor: cleanVendor, order_number: cleanNumber, ordered_at: at
      });
    });
    return listPartsOrders(token);
  });
}

function markPartReceived(token, id, received) {
  requireAdmin_(token);
  const part = partRow_(id);
  if (!part) throw new Error('No such part.');
  updateRow_('PartsOrders', part._row, received
    ? { status: 'received', received_at: nowIso_() }
    : { status: 'ordered', received_at: '' });
  return listPartsOrders(token);
}

/**
 * Free text against a part, at any stage: waiting on the customer to confirm,
 * on backorder until March, whatever falls outside the normal run.
 */
function setPartNote(token, id, note) {
  requireShop_(token);
  const part = partRow_(id);
  if (!part) throw new Error('No such part.');
  updateRow_('PartsOrders', part._row, { notes: String(note || '').trim() });
  return { part: partView_(partRow_(id)) };
}

/**
 * Files a completed order away, or brings it back.
 *
 * Archiving is not deleting, and the difference is the point: the parts list
 * is a working list, and a year of completed orders buried under it makes the
 * three lines that still need doing hard to find. An archived order keeps
 * everything — what it was, whose boat, which supplier, what it cost to chase
 * — on a page built for looking things up rather than working from.
 *
 * Takes ids rather than an order number because that is what the page already
 * has, and because an order line that never got a number is its own group.
 */
function setPartsArchived(token, ids, archived) {
  requireAdmin_(token);
  if (!Array.isArray(ids) || !ids.length) throw new Error('Nothing picked to file away.');

  return withLock_(function () {
    const at = archived ? nowIso_() : '';
    ids.forEach(function (id) {
      const part = partRow_(id);
      if (!part) return;
      // Only a part that has actually arrived can be filed. Anything still
      // needed or on order belongs on the working list.
      if (archived && part.status !== 'received') return;
      updateRow_('PartsOrders', part._row, { archived_at: at });
    });
    return listPartsOrders(token);
  });
}

/**
 * Gone for good — for the duplicate row and the order that was never really
 * placed, not for tidying up history. Only ever reaches parts that have
 * arrived; anything still needed or on order goes through cancelPartOrder,
 * which refuses to lose an order somebody has actually placed.
 */
function deletePartsOrders(token, ids) {
  requireAdmin_(token);
  if (!Array.isArray(ids) || !ids.length) throw new Error('Nothing picked to delete.');

  return withLock_(function () {
    const sheet = sheet_('PartsOrders');
    const targets = [];
    ids.forEach(function (id) {
      const part = partRow_(id);
      if (part && part.status === 'received') targets.push(part._row);
    });
    // Highest row first. Deleting row 4 shifts row 5 up to 4, so deleting in
    // ascending order takes out the wrong rows from the second one onward.
    targets.sort(function (a, b) { return b - a; });
    targets.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
    // deleteRow bypasses appendRow_/updateRow_, so it has to forget the
    // memoised rows itself.
    forget_('PartsOrders');
    return listPartsOrders(token);
  });
}

/**
 * The filing cabinet. Flat rows rather than grouped orders, because this page
 * exists to be searched — "which supplier did that impeller come from" is a
 * question about one line, not about an order.
 *
 * Everything comes back in one answer and the browser does the searching and
 * sorting. Apps Script charges per round trip, and a query per keystroke would
 * be unusable; the whole tab is already read to build this, so the rows cost
 * nothing extra to send.
 */
function listArchivedParts(token) {
  requireAdmin_(token);
  const jobs = {};
  rows_('Jobs').forEach(function (job) { jobs[job.id] = job.customer_name || ''; });

  const archived = rows_('PartsOrders')
    .map(partView_)
    .filter(function (part) { return Boolean(part.archivedAt); });
  archived.forEach(function (part) {
    part.customerName = part.jobId ? (jobs[part.jobId] || null) : null;
  });
  archived.sort(function (a, b) { return String(b.archivedAt).localeCompare(String(a.archivedAt)); });
  return { parts: archived };
}

function cancelPartOrder(token, id) {
  requireAdmin_(token);
  const part = partRow_(id);
  if (!part) throw new Error('No such part.');
  if (part.status === 'ordered') throw new Error('That one is already on order — mark it received instead.');
  const sheet = sheet_('PartsOrders');
  sheet.deleteRow(part._row);
  forget_('PartsOrders');
  return listPartsOrders(token);
}

/* ============================ prop repairs ============================= */

function propView_(prop) {
  return {
    id: prop.id,
    jobId: prop.job_id || null,
    // One photo, in the same two sizes every other photo is stored in: a thumb
    // for the list and a full one for when somebody needs to read the tag.
    tagPhoto: parsePhotos_(prop.tag_photo)[0] || null,
    description: prop.description || '',
    status: prop.status,
    statusLabel: PROP_STATUS_LABEL[prop.status] || prop.status,
    vendor: prop.vendor || null,
    notes: prop.notes || '',
    requestedBy: prop.requested_by || null,
    createdAt: prop.created_at,
    pickedUpAt: prop.picked_up_at || null,
    returnedAt: prop.returned_at || null
  };
}

function propRow_(id) {
  const all = rows_('PropRepairs');
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) return all[i];
  }
  return null;
}

/**
 * A prop coming off a boat and going out for repair, logged from the floor by
 * whoever pulled it.
 *
 * The tag is the identity. A prop has no barcode and no part number — what
 * tells the prop shop whose it is, and tells the writer which boat it goes
 * back on, is the paper tag wired to it. So the mechanic photographs the tag
 * and that photo travels with the row.
 *
 * The photo is asked for, not insisted on, for the same reason the stock
 * request does not insist on a part number: a mechanic holding a prop with a
 * camera that will not focus should still be able to get it onto the list, so
 * long as they say in words which prop it is.
 */
/** The prop the phone gave this client id, if it ever landed. Retries only. */
function propByClientId_(clientId) {
  if (!clientId) return null;
  const all = rows_('PropRepairs');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].client_id) === String(clientId)) return all[i];
  }
  return null;
}

function addPropRepair(token, jobToken, payload) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');

  const description = String((payload && payload.description) || '').trim();
  const photo = (payload && payload.tagPhoto) || null;
  if (!photo && !description) {
    throw new Error('Photograph the tag, or say which prop this is.');
  }

  // Same bargain as addEntry: only a retry pays for the look-up, and it
  // happens before the tag photo goes to Drive.
  const clientId = String((payload && payload.clientId) || '');
  if (payload && payload.retry && clientId) {
    const already = propByClientId_(clientId);
    if (already) {
      return { prop: propView_(already), props: propsForJob_(already.job_id), duplicate: true };
    }
  }

  return withLock_(function () {
    let stored = '';
    if (photo) {
      stored = JSON.stringify([{
        thumb: saveFile_(job.id, 'prop-tag-' + Date.now() + '-thumb.jpg', 'image/jpeg', photo.thumb),
        full: saveFile_(job.id, 'prop-tag-' + Date.now() + '.jpg', 'image/jpeg', photo.full)
      }]);
    }
    const row = {
      id: newId_('prop'),
      job_id: job.id,
      tag_photo: stored,
      description: description,
      status: 'ready',
      vendor: '',
      notes: String((payload && payload.notes) || '').trim(),
      requested_by: who.name,
      created_at: nowIso_(),
      picked_up_at: '',
      returned_at: '',
      client_id: clientId
    };
    appendRow_('PropRepairs', row);
    return { prop: propView_(row), props: propsForJob_(job.id) };
  });
}

function fileView_(row) {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime || '',
    driveFile: row.drive_file,
    // 'customer' rides along with the invoice email. 'internal' never leaves
    // the building.
    visibility: row.visibility === 'customer' ? 'customer' : 'internal',
    addedBy: row.added_by || null,
    createdAt: row.created_at,
    // Bytes, so the page can say how big it is and the invoice email can work
    // out what will fit. 0 for anything added before the column existed.
    size: Math.max(0, Math.round(numberOrNull_(row.size) || 0))
  };
}

function filesForJob_(jobId) {
  return rows_('JobFiles')
    .filter(function (row) { return String(row.job_id) === String(jobId); })
    .map(fileView_)
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

/**
 * A document on the job, marked for the customer or for the shop.
 *
 * The visibility is decided when the file is added and never inferred later:
 * a `customer` file is attached to the invoice email when the writer sends
 * it, an `internal` one is never sent anywhere. Anything ambiguous is
 * internal — the failure that matters here is a supplier's cost sheet going
 * out with an invoice, not a photo the customer has to ask twice for.
 *
 * Nothing here reaches /t/. Attachments are not a log entry, `publicJob`
 * never touches this tab, and the only way one leaves the building is a
 * writer pressing send on the invoice email.
 */
function addJobFile(token, id, payload) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');

  const name = String((payload && payload.name) || '').trim() || 'attachment';
  if (!payload || !payload.base64) throw new Error('No file was attached.');
  const visibility = payload.visibility === 'customer' ? 'customer' : 'internal';

  const fileId = saveFile_(job.id, name, payload.mime || 'application/octet-stream', payload.base64);
  const row = {
    id: newId_('file'),
    job_id: job.id,
    name: name,
    mime: payload.mime || '',
    drive_file: fileId,
    visibility: visibility,
    added_by: SHOP_WRITER_NAME,
    created_at: nowIso_(),
    size: base64Bytes_(payload.base64)
  };
  appendRow_('JobFiles', row);
  return { files: filesForJob_(job.id), mailLimit: MAIL_ATTACHMENT_BUDGET };
}

/**
 * Takes a document off the job.
 *
 * The Drive file goes to the bin rather than being destroyed: this is the
 * writer tidying up a wrong upload, and a customer's photo is not something
 * to lose to a mis-tap. Drive keeps a binned file for thirty days.
 */
function deleteJobFile(token, fileId) {
  requireAdmin_(token);
  return withLock_(function () {
    const all = rows_('JobFiles');
    const row = all.filter(function (r) { return String(r.id) === String(fileId); })[0];
    if (!row) throw new Error('No such attachment.');

    try {
      DriveApp.getFileById(row.drive_file).setTrashed(true);
    } catch (err) {
      // Already gone from Drive by hand. The row still has to go.
    }
    sheet_('JobFiles').deleteRow(row._row);
    // deleteRow goes round appendRow_/updateRow_, so it forgets the memoised
    // rows itself or every read after this is a lie.
    forget_('JobFiles');
    return { files: filesForJob_(row.job_id), mailLimit: MAIL_ATTACHMENT_BUDGET };
  });
}

function propsForJob_(jobId) {
  return rows_('PropRepairs')
    .filter(function (prop) { return prop.job_id === jobId; })
    .map(propView_)
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

/** Waiting to go, away at the shop, and what has come back. */
function listPropRepairs(token) {
  requireAdmin_(token);
  const all = rows_('PropRepairs').map(propView_);
  const jobs = {};
  const boats = {};
  rows_('Jobs').forEach(function (job) {
    jobs[job.id] = job.customer_name || '';
    boats[job.id] = job.boat_info || '';
  });
  all.forEach(function (prop) {
    prop.customerName = prop.jobId ? (jobs[prop.jobId] || null) : null;
    prop.boatInfo = prop.jobId ? (boats[prop.jobId] || null) : null;
  });

  const byNewest = function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); };
  const pick = function (status) {
    return all.filter(function (p) { return p.status === status; }).sort(byNewest);
  };
  const back = all
    .filter(function (p) { return p.status === 'fixed' || p.status === 'unfixable'; })
    .sort(function (a, b) { return String(b.returnedAt).localeCompare(String(a.returnedAt)); });

  return { ready: pick('ready'), pickedUp: pick('picked_up'), back: back };
}

/**
 * The prop shop's van has been. Props go out in a batch against whoever took
 * them, the same way parts go on an order against a vendor.
 */
function markPropsPickedUp(token, ids, vendor) {
  requireAdmin_(token);
  const cleanVendor = String(vendor || '').trim();
  if (!cleanVendor) throw new Error('Who took them?');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Tick the props that went.');

  return withLock_(function () {
    const at = nowIso_();
    ids.forEach(function (id) {
      const prop = propRow_(id);
      if (!prop || prop.status !== 'ready') return;
      updateRow_('PropRepairs', prop._row, {
        status: 'picked_up', vendor: cleanVendor, picked_up_at: at
      });
    });
    return listPropRepairs(token);
  });
}

/**
 * Back on the bench. Fixed, or not worth fixing — the second is a real ending,
 * and the one that means somebody has a phone call to make.
 */
function markPropReturned(token, id, outcome) {
  requireAdmin_(token);
  if (outcome !== 'fixed' && outcome !== 'unfixable') {
    throw new Error('Did it come back fixed, or unfixable?');
  }
  const prop = propRow_(id);
  if (!prop) throw new Error('No such prop.');
  if (prop.status !== 'picked_up') throw new Error('That one has not gone out yet.');
  updateRow_('PropRepairs', prop._row, { status: outcome, returned_at: nowIso_() });
  return listPropRepairs(token);
}

/** Free text against a prop at any stage — a quote, a delay, whose it is. */
function setPropNote(token, id, note) {
  requireShop_(token);
  const prop = propRow_(id);
  if (!prop) throw new Error('No such prop.');
  updateRow_('PropRepairs', prop._row, { notes: String(note || '').trim() });
  return { prop: propView_(propRow_(id)) };
}

/** Pulled off the list before it ever left. Once it is gone, it is gone. */
function cancelPropRepair(token, id) {
  requireAdmin_(token);
  const prop = propRow_(id);
  if (!prop) throw new Error('No such prop.');
  if (prop.status !== 'ready') {
    throw new Error('That prop is already out — mark it returned instead.');
  }
  const sheet = sheet_('PropRepairs');
  sheet.deleteRow(prop._row);
  // deleteRow does not go through appendRow_/updateRow_, so it has to forget
  // the memoised rows itself or the next read in this execution is stale.
  forget_('PropRepairs');
  return listPropRepairs(token);
}

/* ============================ winter work ============================== */
/*
 * The work waiting on boats the winter program has brought in.
 *
 * The shop asked for it plainly (Sep 2026): when a boat is marked pulled or
 * dropped off in the winter services system, the mechanics should see what
 * needs winterizing — or any other job to be done before it goes into
 * storage. That system (QuestWS/winter-quotes_26-27) already knows both
 * facts: Harbor Haul Out records the pull and the drop-off, and the customer's
 * quote says what they paid to have done. So this asks it, rather than asking
 * somebody to type the same list in twice.
 *
 * What decides each piece:
 *
 *  - IT IS NOT A JOB. A job here is a BiT invoice with a work order printed
 *    and a QR code on it; a winter unit is a quote in another system with
 *    neither. Making one into the other would put forty boats into the
 *    writer's close-out, where each would want an invoice that is never
 *    coming from BiT. So it is its own list, and the only thing written on
 *    this side is which items a mechanic has ticked off.
 *  - THE LIST COMES FROM THERE; THE TICKS GO BACK. The winter system says
 *    which units are here and what they need. A tick is the floor's own
 *    record, in the WinterWork tab, and it is also sent back (winterTicks)
 *    so Harbor Haul Out can show a boat as "winterize pending" until the
 *    last winterization item is ticked off here. Each send is the WHOLE
 *    state for that quote, so a repeat changes nothing; one that fails is
 *    caught up by hourly(). Nothing else is ever written over there.
 *  - A SHARED KEY in script properties — WINTER_KEY here, TRACKER_KEY there,
 *    the same long random string. Neither repo holds it; both are public. No
 *    key set means the list says so and fetches nothing.
 *  - NO MONEY CROSSES. The winter side sends labels only, never an amount, a
 *    balance, a phone number or an email; it is checked over there
 *    (tools/check-tracker-feed.js) and asserted again here.
 *  - CACHED FOR FIVE MINUTES, and the last good answer kept for a day. The
 *    winter backend is a second cold start and a spreadsheet walk; paying for
 *    it on every open of the list would make this the slowest screen in the
 *    app. A pull recorded at the harbor shows here within five minutes, or at
 *    once on Refresh. When the winter side cannot be reached the last good
 *    list is shown and says how old it is, like every other list here.
 *  - A TICK IS KEYED ON THE ITEM'S WORDS. The quote has no line ids. If the
 *    office renames a line over there, the tick on the old words stops
 *    matching and the item shows as not done — which fails towards doing the
 *    work, not towards skipping it.
 */
const WINTER_EXEC_URL = 'https://script.google.com/macros/s/AKfycbxv8kqGKXU_4-9TytfWzdrv-QqqmyrYLxRwd8FDfA8b47sX3NlEBNDlIwIHRuQObZbL9w/exec';
// v2: units carry storing / storageLabel / storageHow. A cached v1 feed has
// none of them, and the phone could not tell "not storing" from "too old to say".
const WINTER_FEED_KEY_ = 'WINTER_FEED_v2';
const WINTER_LAST_GOOD_KEY_ = 'WINTER_LASTGOOD_v2';
const WINTER_FEED_TTL_ = 300;
const WINTER_LAST_GOOD_TTL_ = 21600;
const WINTER_ITEM_MAX_ = 200;

/*
 * Detailing is Harbor Haul Out's, not the floor's (Nov 2026: "show Exterior
 * detail, Wash & wax, Interior detail and Interior wipe-down only in the
 * Harbor Haul Out app"). The detailers work from that app; a mechanic should
 * not see them on a boat's list, and a writer should not be offered them on a
 * walk-in winterize. Matched on the menu key or the words, either way round,
 * so a quote line that says "Wash & wax" is caught as surely as the key.
 */
/*
 * Nov 7 2026: and now the Detail Tracker's — washes and the jetski detail
 * with them, because a mechanic ticking off "Powerwash hull" while the wash
 * was still to do is exactly the mix-up it was built to end.
 */
const HARBOR_ONLY_KEYS_ = { extDetail: true, washWax: true, intDetail: true, intWipe: true,
  powerwash: true, acidWash: true, skiDetail: true, bottomTouch: true, bottomStrip: true };
// Bottom paint too — Chris, Nov 7 2026: "Bottom paint is detailing."
const HARBOR_ONLY_LABELS_ = ['exterior detail', 'wash & wax', 'interior detail', 'interior wipe-down',
  'powerwash hull', 'acid wash hull', 'jetski detail', 'bottom paint touch-up', 'strip bottom paint & reapply'];

function harborOnly_(key, label) {
  if (HARBOR_ONLY_KEYS_[String(key || '')]) return true;
  const words = String(label || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();
  return HARBOR_ONLY_LABELS_.some(function (l) { return words === l || words.indexOf(l + ' ') === 0 || words.indexOf(l + ' (') === 0; });
}

/**
 * One call to the winter system's tracker door. Throws with a sentence a
 * mechanic can read; the answer when it worked.
 */
function winterCall_(body) {
  const res = UrlFetchApp.fetch(props_().getProperty('WINTER_URL') || WINTER_EXEC_URL, {
    method: 'post',
    contentType: 'text/plain',
    // pingUrl: where the winter system can tell the Detail Tracker a quote
    // was answered. Sent on every keyed call so nobody has to configure it.
    payload: JSON.stringify(Object.assign({ api: 'tracker', key: winterKey_(), pingUrl: ownExecUrl_() }, body)),
    muteHttpExceptions: true,
    followRedirects: true
  });
  let out = null;
  try { out = JSON.parse(res.getContentText()); } catch (err) { out = null; }
  if (res.getResponseCode() !== 200 || !out || out._api !== 'tracker') {
    throw new Error('The winter system did not answer.');
  }
  if (!out.ok) {
    throw new Error(/authoris/i.test(String(out.error))
      ? 'The winter system turned the key down. WINTER_KEY here and TRACKER_KEY there have to match.'
      : 'The winter system said: ' + String(out.error || 'no.'));
  }
  return out;
}

/** This web app's own /exec address, or '' when it cannot be told for sure. */
function ownExecUrl_() {
  let url = String(props_().getProperty('WEB_APP_URL') || '');
  if (!/\/exec$/.test(url)) {
    try { url = String(ScriptApp.getService().getUrl() || ''); } catch (err) { url = ''; }
  }
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url) ? url : '';
}

/** Whether the shop has put the shared key in. */
function winterKey_() {
  return String(props_().getProperty('WINTER_KEY') || '').trim();
}

/**
 * The winter system's list of units on To store, straight off the wire.
 * Throws with a sentence a mechanic can read.
 */
function fetchWinterFeed_() {
  const body = winterCall_({ fn: 'winterWork' });
  // Only what this app shows, named one field at a time. A field added over
  // there does not ride through to the phone because somebody spread a row.
  return {
    at: String(body.at || nowIso_()),
    units: (body.units || []).map(function (u) {
      return {
        qn: String(u.qn || ''), name: String(u.name || ''), unit: String(u.unit || ''),
        ymm: String(u.ymm || ''), dims: String(u.dims || ''), tab: String(u.tab || ''),
        // Whether it is going into storage and where, for the mechanic's tag.
        // null when the winter side is too old to say — the app then falls
        // back to the bare storage area rather than claiming either answer.
        storing: u.storing === undefined ? null : !!u.storing,
        storageLabel: String(u.storageLabel || ''), storageHow: String(u.storageHow || ''),
        slip: String(u.slip || ''), keys: String(u.keys || ''), trailerLoc: String(u.trailerLoc || ''),
        state: String(u.state || ''), stateLabel: String(u.stateLabel || ''), stateAt: String(u.stateAt || ''),
        alert: String(u.alert || ''), cnote: String(u.cnote || ''),
        work: (u.work || []).map(function (w) {
          return { sec: String(w.sec || ''), label: String(w.label || '').slice(0, WINTER_ITEM_MAX_),
                   requested: !!w.requested, winterize: !!w.winterize };
        }).filter(function (w) { return w.label && !harborOnly_('', w.label); })
      };
    }).filter(function (u) { return u.qn; })
  };
}

/** The feed, from the cache when it is fresh enough. {feed, stale, error}. */
function winterFeed_(fresh) {
  const cached = fresh ? null : cacheGetBig_(WINTER_FEED_KEY_);
  if (cached && Array.isArray(cached.units)) return { feed: cached, stale: false, error: '' };
  try {
    const feed = fetchWinterFeed_();
    cachePutBig_(WINTER_FEED_KEY_, feed, WINTER_FEED_TTL_);
    cachePutBig_(WINTER_LAST_GOOD_KEY_, feed, WINTER_LAST_GOOD_TTL_);
    return { feed: feed, stale: false, error: '' };
  } catch (err) {
    const kept = cacheGetBig_(WINTER_LAST_GOOD_KEY_);
    return { feed: kept && Array.isArray(kept.units) ? kept : null, stale: true,
             error: String(err && err.message ? err.message : err) };
  }
}

/** Every tick, keyed quote number + item words. Nothing when setup() has not made the tab. */
function winterTicks_() {
  const out = {};
  if (!ss_().getSheetByName('WinterWork')) return out;
  rows_('WinterWork').forEach(function (row) {
    out[row.quote_no + '\n' + row.item] = row;
  });
  return out;
}

/**
 * The list the mechanic app shows: every unit on the winter system's To store
 * list, with its work and what has been ticked off. Either sign-in opens it —
 * it is every customer's name at once, same bar as the open-jobs list.
 */
function winterWork(token, fresh) {
  requireShop_(token);
  if (!winterKey_()) {
    return { configured: false, units: [],
             error: 'Not connected to the winter system yet. The office needs to add WINTER_KEY.' };
  }
  const got = winterFeed_(fresh === true);
  if (!got.feed) return { configured: true, units: [], stale: true, error: got.error };
  const ticks = winterTicks_();
  const units = got.feed.units.map(function (u) {
    // Filtered again here: a feed cached before the filter still has them.
    const work = u.work.filter(function (w) { return !harborOnly_('', w.label); }).map(function (w) {
      const t = ticks[u.qn + '\n' + w.label];
      const done = !!(t && t.done === 'yes');
      return { sec: w.sec, label: w.label, requested: w.requested, winterize: !!w.winterize,
               done: done, doneBy: done ? t.done_by : '', doneAt: done ? t.done_at : '' };
    });
    const left = work.filter(function (w) { return !w.done; }).length;
    const winterizeLeft = work.filter(function (w) { return w.winterize && !w.done; }).length;
    return {
      qn: u.qn, name: u.name, unit: u.unit, ymm: u.ymm, dims: u.dims, tab: u.tab,
      storing: u.storing === undefined ? null : u.storing,
      storageLabel: u.storageLabel || '', storageHow: u.storageHow || '',
      slip: u.slip, keys: u.keys, trailerLoc: u.trailerLoc,
      state: u.state, stateLabel: u.stateLabel, stateAt: u.stateAt,
      alert: u.alert, cnote: u.cnote, work: work, left: left, winterizeLeft: winterizeLeft
    };
  });
  // Work still to do first, oldest arrival first within that — the boat that
  // has sat longest is the one to start on. Alerted units lead, as on the
  // open-jobs list: the alert is read before anybody touches the boat.
  units.sort(function (a, b) {
    return (b.alert ? 1 : 0) - (a.alert ? 1 : 0) ||
      (a.left ? 0 : 1) - (b.left ? 0 : 1) ||
      String(a.stateAt).localeCompare(String(b.stateAt));
  });
  return { configured: true, units: units, at: got.feed.at, stale: got.stale, error: got.error };
}

/**
 * Tick an item off, or put it back. The floor's record only — nothing goes to
 * the winter system. Whoever is signed in is who did it.
 */
function setWinterItem(token, qn, item, done) {
  const who = requireShop_(token);
  const quoteNo = String(qn || '').trim();
  const label = String(item || '').trim().slice(0, WINTER_ITEM_MAX_);
  if (!quoteNo || !label) throw new Error('Which unit and which item?');
  if (!ss_().getSheetByName('WinterWork')) {
    throw new Error('This needs a one-time setup step: the office has to run setup from the App setup page.');
  }
  const by = who.role === 'mechanic' ? who.name : 'Office';
  const out = withLock_(function () {
    const row = rows_('WinterWork').filter(function (r) {
      return r.quote_no === quoteNo && r.item === label;
    })[0];
    const patch = done
      ? { done: 'yes', done_by: by, done_at: nowIso_() }
      : { done: '', done_by: '', done_at: '' };
    if (row) {
      updateRow_('WinterWork', row._row, patch);
    } else {
      appendRow_('WinterWork', Object.assign({ id: newId_('ww'), quote_no: quoteNo, item: label,
                                               created_at: nowIso_() }, patch));
    }
    return { ok: true, item: { label: label, done: !!done, doneBy: patch.done_by, doneAt: patch.done_at } };
  });
  // Outside the lock: this is a trip to the other script, and the lock is
  // every save in the shop. The tick is already safe here; if the send fails,
  // hourly() catches Harbor Haul Out up, and the answer says so.
  out.synced = pushWinterTicks_([quoteNo]);
  return out;
}

/** {quote no: [{label, by, at}]} of what is ticked, for the named quotes or all. */
function winterTickState_(only) {
  const want = only ? only.reduce(function (m, q) { m[q] = true; return m; }, {}) : null;
  const out = {};
  if (!ss_().getSheetByName('WinterWork')) return out;
  rows_('WinterWork').forEach(function (r) {
    if (want && !want[r.quote_no]) return;
    if (!out[r.quote_no]) out[r.quote_no] = [];
    if (r.done === 'yes') out[r.quote_no].push({ label: r.item, by: r.done_by, at: r.done_at });
  });
  // A named quote with no rows at all still goes, as an empty list.
  (only || []).forEach(function (q) { if (!out[q]) out[q] = []; });
  return out;
}

/** Sends the ticks to the winter system. True when it took them. Never throws. */
function pushWinterTicks_(only) {
  if (!winterKey_()) return false;
  try {
    const ticks = winterTickState_(only);
    if (!Object.keys(ticks).length) return true;
    winterCall_({ fn: 'winterTicks', ticks: ticks });
    return true;
  } catch (err) {
    return false;
  }
}

/* ======================== winterize, on a work order ===================== */
/*
 * A walk-in winterize: an ordinary BiT work order whose writer ticked
 * "Winterize job" at intake. Chris, Nov 2026: the mechanic should get "the
 * same checklist winterizing process he does on stored boats but for
 * walk-ins", still log hours and parts for anything beyond it, and "all of
 * the options from winter services should populate" at intake — full or basic,
 * with the engine type left blank when the customer does not know, so the
 * mechanic is asked to pick it at the boat while still being told which level
 * to do.
 *
 * What decides each piece:
 *
 *  - IT IS STILL A JOB. Same QR, same Hours / Parts / Notes, same close-out.
 *    The checklist is one more thing on it, in `winter_work`, never a second
 *    kind of ticket — the extra work beyond winterizing is logged exactly as
 *    on any other job.
 *  - THE MENU IS THE WINTER SYSTEM'S. winterMenu asks it (fn 'menu'), built
 *    from its pricing engine, so a service added there for the season is
 *    offered here too. Cached six hours, and the last good copy kept in a
 *    script property, so intake does not depend on that system being up.
 *  - WHAT WAS CHOSEN IS FROZEN ON THE JOB. The labels, the level's steps and
 *    the engine types go into the cell at intake. The mechanic's screen needs
 *    nothing from the winter system, and a menu changed mid-season does not
 *    rewrite a job already on the floor.
 *  - THE ENGINE TYPE MAY BE BLANK, AND THEN IT IS THE MECHANIC'S. The engine
 *    item cannot be ticked until somebody picks one, and the screen says why
 *    — but Full or Basic, and its steps, are on it from the start.
 *  - A TICK IS WRITTEN UNDER THE LOCK, re-read inside it, so two mechanics on
 *    one boat cannot undo each other's ticks, and a writer's edit keeps every
 *    tick on an item that is still on the list.
 *  - SHOP-SIDE ONLY. publicJob and invoicePage name their fields one at a
 *    time and neither reads this column; a test holds both to that.
 */
const WINTER_MENU_KEY_ = 'WINTER_MENU_v1';
const WINTER_MENU_PROP_ = 'WINTER_MENU_LASTGOOD';
const WINTER_MENU_TTL_ = 21600;
const WINTER_LEVELS_ = { basic: 'Basic', full: 'Full service' };

function cleanWinterMenu_(m) {
  const str = function (v, n) { return String(v === undefined || v === null ? '' : v).slice(0, n || 200); };
  return {
    levels: (m.levels || []).filter(function (l) { return WINTER_LEVELS_[l.id]; }).map(function (l) {
      return { id: l.id, label: str(l.label, 40), steps: str(l.steps, 600), stepsPwc: str(l.stepsPwc || l.steps, 600) };
    }),
    engines: (m.engines || []).map(function (e) {
      return { id: str(e.id, 30), name: str(e.name, 80), pwc: !!e.pwc };
    }).filter(function (e) { return e.id && e.name; }),
    services: (m.services || []).map(function (x) {
      return { key: str(x.key, 40), label: str(x.label), kind: x.kind === 'count' ? 'count' : 'flag',
               group: str(x.group, 60), needs: str(x.needs, 40), request: !!x.request, winterize: !!x.winterize,
               units: (x.units || []).map(function (u) { return str(u, 20); }) };
    }).filter(function (x) { return x.key && x.label && !harborOnly_(x.key, x.label); })
  };
}

/** A menu kept from before the filter, made to match it. */
function withoutHarborOnly_(menu) {
  menu.services = (menu.services || []).filter(function (x) { return !harborOnly_(x.key, x.label); });
  return menu;
}

/** The winter services menu, for the intake form. */
function winterMenu(token) {
  requireAdmin_(token);
  if (!winterKey_()) throw new Error('Not connected to the winter system yet. The office needs to add WINTER_KEY.');
  const cached = cacheGetBig_(WINTER_MENU_KEY_);
  if (cached && cached.levels) return { menu: withoutHarborOnly_(cached) };
  try {
    const menu = cleanWinterMenu_(winterCall_({ fn: 'menu' }));
    if (!menu.levels.length) throw new Error('The winter system sent an empty menu.');
    cachePutBig_(WINTER_MENU_KEY_, menu, WINTER_MENU_TTL_);
    try { props_().setProperty(WINTER_MENU_PROP_, JSON.stringify(menu)); } catch (err) { /* too big: cache only */ }
    return { menu: menu };
  } catch (err) {
    let kept = null;
    try { kept = JSON.parse(props_().getProperty(WINTER_MENU_PROP_) || 'null'); } catch (e) { kept = null; }
    if (kept && kept.levels) return { menu: withoutHarborOnly_(kept), stale: true, error: String(err.message || err) };
    throw err;
  }
}

function winterSpecOf_(job) {
  if (!job || !job.winter_work) return null;
  try {
    const spec = JSON.parse(job.winter_work);
    return spec && WINTER_LEVELS_[spec.level] ? spec : null;
  } catch (err) {
    return null;
  }
}

/**
 * What the writer chose, made safe to store. `input` comes from the intake
 * form: { level, engineId, engineCount, steps, stepsPwc, engines, items }.
 * `prev` is what is on the job now, whose ticks and mechanic-picked engine
 * survive an edit.
 */
function sanitizeWinterSpec_(input, prev, by) {
  const str = function (v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n || 200); };
  const level = str(input && input.level, 10);
  if (!WINTER_LEVELS_[level]) throw new Error('Choose Full service or Basic for the winterize.');
  const engines = ((input.engines && input.engines.length) ? input.engines : (prev && prev.engines) || [])
    .map(function (e) { return { id: str(e.id, 30), name: str(e.name, 80), pwc: !!e.pwc }; })
    .filter(function (e) { return e.id && e.name; }).slice(0, 12);
  const pick = str(input.engineId, 30);
  let engine = pick ? engines.filter(function (e) { return e.id === pick; })[0] || null : null;
  if (pick && !engine) throw new Error('That engine type is not on the winter menu.');
  let engineBy = engine ? by : '';
  let engineAt = engine ? nowIso_() : '';
  // Left blank by the writer but already picked at the boat: keep it.
  if (!engine && prev && prev.engine) { engine = prev.engine; engineBy = prev.engineBy || ''; engineAt = prev.engineAt || ''; }
  if (engine && prev && prev.engine && prev.engine.id === engine.id) { engineBy = prev.engineBy || engineBy; engineAt = prev.engineAt || engineAt; }
  const count = Math.max(1, Math.min(6, Math.floor(Number(input.engineCount) || 1)));
  const seen = { engine: true };
  const items = (input.items || []).map(function (x) {
    const qty = Math.max(1, Math.min(99, Math.floor(Number(x.qty) || 1)));
    return { id: str(x.id, 40), label: str(x.label), group: str(x.group, 60), winterize: !!x.winterize,
             count: x.count === true, qty: qty };
  }).filter(function (x) {
    if (!x.id || !x.label || seen[x.id]) return false;
    seen[x.id] = true;
    return true;
  }).slice(0, 40);
  const done = {};
  const prevDone = (prev && prev.done) || {};
  Object.keys(prevDone).forEach(function (id) { if (seen[id]) done[id] = prevDone[id]; });
  return {
    v: 1, level: level, steps: str(input.steps, 600) || (prev && prev.steps) || '',
    stepsPwc: str(input.stepsPwc, 600) || (prev && prev.stepsPwc) || '',
    engines: engines, engine: engine, engineCount: count, engineBy: engineBy, engineAt: engineAt,
    items: items, done: done, setBy: by, setAt: nowIso_()
  };
}

/** What a page shows: every item with its tick, the engine item first. */
function winterView_(spec) {
  if (!spec) return null;
  const done = spec.done || {};
  const levelLabel = WINTER_LEVELS_[spec.level];
  const engineName = spec.engine ? spec.engine.name : '';
  const engineItem = {
    id: 'engine', kind: 'engine', group: 'Engine winterization', winterize: true,
    label: levelLabel + ' winterize — ' + (engineName || 'engine type to check') +
      (spec.engineCount > 1 ? ' × ' + spec.engineCount : '')
  };
  // A job set up before detailing moved to Harbor Haul Out may still carry
  // one; it is not shown, and does not hold the checklist open.
  const items = [engineItem].concat((spec.items || []).filter(function (x) {
    return !harborOnly_(x.id, x.label);
  }).map(function (x) {
    return { id: x.id, kind: 'service', group: x.group, winterize: !!x.winterize,
             label: x.label + (x.count && x.qty > 1 ? ' × ' + x.qty : '') };
  })).map(function (x) {
    const d = done[x.id];
    x.done = !!d;
    x.doneBy = d ? String(d.by || '') : '';
    x.doneAt = d ? String(d.at || '') : '';
    return x;
  });
  return {
    level: spec.level, levelLabel: levelLabel,
    // The PWC wording leaves out the fuel filter; anything else gets the boat's.
    steps: spec.engine && spec.engine.pwc ? (spec.stepsPwc || spec.steps) : spec.steps,
    engine: spec.engine || null, engineCount: spec.engineCount || 1,
    engineBy: spec.engineBy || '', engineAt: spec.engineAt || '',
    needsEngine: !spec.engine, engines: spec.engines || [],
    items: items,
    left: items.filter(function (x) { return !x.done; }).length,
    winterizeLeft: items.filter(function (x) { return x.winterize && !x.done; }).length
  };
}

/** The column, written into the header the first time anybody needs it. */
function ensureWinterColumn_() {
  if (headerHas_('Jobs', 'winter_work')) return;
  // Only ever adds what is missing — the same thing setup() does for the
  // header, without making the office find the button for one column.
  ensureSheets_(ss_());
  _headers = {};
}

/** Set, change or take off a job's winterize checklist. `input` null takes it off. */
function setJobWinter(token, id, input) {
  requireAdmin_(token);
  ensureWinterColumn_();
  return withLock_(function () {
    forget_('Jobs');
    const job = jobRow_(id);
    if (!job) throw new Error('No such job.');
    if (isPartsOrder_(job)) throw new Error('A parts order has no boat to winterize.');
    const value = input ? JSON.stringify(sanitizeWinterSpec_(input, winterSpecOf_(job), 'Office')) : '';
    updateRow_('Jobs', job._row, { winter_work: value, updated_at: nowIso_() });
    return { job: jobSummary_(jobRow_(id)) };
  });
}

/**
 * The mechanic ticking an item, or picking the engine type, or both. The
 * engine item cannot be ticked without an engine type — that is the prompt.
 */
function setJobWinterItem(token, jobToken, itemId, done, engineId) {
  const who = requireMechanic_(token);
  return withLock_(function () {
    forget_('Jobs');
    const job = jobByToken_(jobToken);
    if (!job) throw new Error('No such job.');
    const spec = winterSpecOf_(job);
    if (!spec) throw new Error('This job has no winterize checklist.');
    const pick = String(engineId || '');
    if (pick) {
      const engine = (spec.engines || []).filter(function (e) { return e.id === pick; })[0];
      if (!engine) throw new Error('That engine type is not on the list.');
      spec.engine = engine;
      spec.engineBy = who.name;
      spec.engineAt = nowIso_();
    }
    const id = String(itemId || '');
    if (id) {
      const known = id === 'engine' || (spec.items || []).some(function (x) { return x.id === id; });
      if (!known) throw new Error('That item is not on this checklist any more. Pull the job up again.');
      if (id === 'engine' && done && !spec.engine) {
        throw new Error('Pick the engine type first — the customer did not say, so the checklist needs it.');
      }
      spec.done = spec.done || {};
      if (done) spec.done[id] = { by: who.name, at: nowIso_() };
      else delete spec.done[id];
    }
    updateRow_('Jobs', job._row, { winter_work: JSON.stringify(spec), updated_at: nowIso_() });
    // A tick is work on the boat, the same as a first log entry.
    if (job.status === 'received') setStatus_(job, 'work_underway', 'mechanic', who.name, 'First winterize tick');
    return { winter: winterView_(spec) };
  });
}

/* ============================= mechanics =============================== */

function normalizeName_(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

/**
 * A name is a name, not a free-text field: long enough to identify someone,
 * short enough to fit the log, and letters rather than a barcode somebody
 * scanned into the wrong box.
 */
function isUsableName_(name) {
  if (name.length < 2 || name.length > 40) return false;
  return /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’.\- ]*$/.test(name);
}

function mechanicByName_(name) {
  const wanted = normalizeName_(name).toLowerCase();
  const all = rows_('Mechanics');
  for (let i = 0; i < all.length; i++) {
    if (normalizeName_(all[i].name).toLowerCase() === wanted) return all[i];
  }
  return null;
}

function roster() {
  return {
    roster: rows_('Mechanics')
      .filter(function (m) { return String(m.active) !== 'false' && m.active !== false; })
      .map(function (m) { return { id: m.id, name: m.name }; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
  };
}

/**
 * Signing in is saying who you are. There is no PIN: this app is reached from
 * a QR code on a work order already sitting in the shop, so a secret here
 * would guard a door that is propped open anyway. The name is for
 * attributing the log.
 *
 * A name nobody has used before joins the roster rather than being turned
 * away — nobody should be stuck behind an admin screen with a boat in front
 * of them. A name the office switched off is refused, because that is a
 * decision somebody made on purpose.
 */
function mechanicSignIn(rawName, remember) {
  const name = normalizeName_(rawName);
  if (!isUsableName_(name)) throw new Error('Use your name as the shop would write it on the schedule.');

  return withLock_(function () {
    let mechanic = mechanicByName_(name);
    if (mechanic && (mechanic.active === false || String(mechanic.active) === 'false')) {
      throw new Error('That name is switched off in the office. Ask the service writer.');
    }
    if (!mechanic) {
      mechanic = { id: newId_('mech'), name: name, active: true, created_at: nowIso_() };
      appendRow_('Mechanics', mechanic);
    }
    const ttl = remember === false ? SHIFT_HOURS * 3600000 : REMEMBER_DAYS * 86400000;
    return {
      token: seal_({ role: 'mechanic', id: mechanic.id, name: mechanic.name, exp: Date.now() + ttl }),
      mechanic: { id: mechanic.id, name: mechanic.name }
    };
  });
}

function listMechanicsAdmin(token) {
  requireAdmin_(token);
  return {
    mechanics: rows_('Mechanics').map(function (m) {
      return {
        id: m.id,
        name: m.name,
        active: !(m.active === false || String(m.active) === 'false'),
        createdAt: m.created_at
      };
    })
  };
}

function addMechanic(token, name) {
  requireAdmin_(token);
  const clean = normalizeName_(name);
  if (!isUsableName_(clean)) throw new Error('Enter a name the way the shop would write it.');
  return withLock_(function () {
    if (mechanicByName_(clean)) {
      throw new Error('Somebody on the roster already goes by that name.');
    }
    appendRow_('Mechanics', { id: newId_('mech'), name: clean, active: true, created_at: nowIso_() });
    return listMechanicsAdmin(token);
  });
}

function renameMechanic(token, id, name) {
  requireAdmin_(token);
  const clean = normalizeName_(name);
  if (!isUsableName_(clean)) throw new Error('Enter a name the way the shop would write it.');
  const clash = mechanicByName_(clean);
  if (clash && clash.id !== id) throw new Error('Somebody on the roster already goes by that name.');
  const all = rows_('Mechanics');
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) {
      updateRow_('Mechanics', all[i]._row, { name: clean });
      break;
    }
  }
  return listMechanicsAdmin(token);
}

function setMechanicActive(token, id, active) {
  requireAdmin_(token);
  const all = rows_('Mechanics');
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === id) {
      updateRow_('Mechanics', all[i]._row, { active: Boolean(active) });
      break;
    }
  }
  return listMechanicsAdmin(token);
}

/* ------------------------------------------------------ magic link sign-in */

/** How long a mailed sign-in link stays good, and how often one may be asked for. */
const MAGIC_MINUTES = 15;
const MAGIC_THROTTLE_SECONDS = 60;

/**
 * Mails a one-time sign-in link to the service desk.
 *
 * This takes no recipient, deliberately. The address is the SERVICE_EMAIL
 * constant, so an endpoint that anybody on the internet may call can only
 * ever put mail into the shop's own inbox — it cannot be aimed at a mailbox
 * somebody else controls, and it cannot be used to post mail to a stranger.
 * Whoever can read the service desk inbox is already the service writer.
 *
 * Exactly one link is outstanding at a time: asking for a new one voids the
 * last, and using one clears it. So a link sitting in the inbox from last
 * week does not still open the portal.
 */
function requestMagicLink() {
  const props = props_();

  // A throttle, because the shop's Gmail allowance is about a hundred
  // messages a day and is shared with the winter app. Somebody leaning on
  // the button should not be able to spend it.
  const last = Number(props.getProperty('MAGIC_SENT_AT') || 0);
  const wait = Math.ceil((last + MAGIC_THROTTLE_SECONDS * 1000 - Date.now()) / 1000);
  if (wait > 0) {
    throw new Error('A link was sent a moment ago — check ' + SERVICE_EMAIL +
      ', or ask again in ' + wait + ' second' + (wait === 1 ? '' : 's') + '.');
  }

  const nonce = newTrackingToken_();
  props.setProperty('MAGIC_NONCE', nonce);
  props.setProperty('MAGIC_EXP', String(Date.now() + MAGIC_MINUTES * 60000));
  props.setProperty('MAGIC_SENT_AT', String(Date.now()));

  const link = SITE_URL + '/admin/?k=' + nonce;
  const sent = send_({
    to: SERVICE_EMAIL,
    jobId: '',
    kind: 'sign_in_link',
    subject: 'Sign in to the ' + SHOP_NAME + ' service tracker',
    html: noticeHtml_({
      intro: '<div style="font-size:16px;font-weight:bold;color:#14293E;margin-bottom:8px">Sign in to the service tracker</div>' +
        '<p style="font-size:15px;line-height:1.55;color:#1D2B38;margin:0 0 4px">' +
        'This link opens the service writer portal and lasts ' + MAGIC_MINUTES + ' minutes. ' +
        'It works once.</p>' +
        '<p style="font-size:13px;color:#5C7185;margin:12px 0 0">' +
        'If you did not ask for it, nothing has happened — the link is useless to anyone who ' +
        'cannot read this inbox, and the next one asked for replaces it.</p>',
      buttons: button_(link, 'Open the portal')
    }),
    text: 'Sign in to the ' + SHOP_NAME + ' service tracker.\n\n' + link +
      '\n\nGood for ' + MAGIC_MINUTES + ' minutes, once.'
  });
  if (!sent) throw new Error('That link could not be emailed. Sign in with the portal password instead.');
  return { sentTo: SERVICE_EMAIL, minutes: MAGIC_MINUTES };
}

/**
 * Spends a mailed link. Success consumes it, and so does expiry — but a
 * wrong guess does NOT. Clearing the nonce on a mismatch would let anybody
 * who can reach this endpoint void the writer's real link by submitting
 * rubbish, over and over. The nonce is 20 characters of base32 and one is
 * outstanding at a time, so guessing is not the threat; the denial of
 * service was.
 */
function magicSignIn(nonce) {
  const props = props_();
  const expected = props.getProperty('MAGIC_NONCE');
  const expires = Number(props.getProperty('MAGIC_EXP') || 0);

  if (!expected || !nonce || String(nonce) !== expected) {
    throw new Error('That sign-in link has already been used, or a newer one replaced it. Ask for a fresh one.');
  }
  props.deleteProperty('MAGIC_NONCE');
  props.deleteProperty('MAGIC_EXP');
  if (Date.now() > expires) {
    throw new Error('That sign-in link has expired. Ask for a fresh one.');
  }
  return { token: seal_({ role: 'admin', exp: Date.now() + 12 * 3600000 }) };
}

/**
 * The portal password, compared without case and without surrounding space.
 *
 * The shop types this on a phone and a counter iPad, where the keyboard
 * capitalises the first letter on its own and a trailing space is easy to
 * pick up. A writer who typed the right word should not be turned away by
 * their own keyboard, and a password this short is not being protected by
 * its capitalisation anyway.
 */
function adminSignIn(password) {
  const expected = props_().getProperty('ADMIN_PASSWORD');
  if (!expected) throw new Error('No portal password is set on this deployment yet.');
  const typed = String(password || '').trim().toLowerCase();
  if (!typed || typed !== String(expected).trim().toLowerCase()) {
    throw new Error('That password was not recognised.');
  }
  return { token: seal_({ role: 'admin', exp: Date.now() + 12 * 3600000 }) };
}

/* ============================ lookup & public ========================== */

/**
 * Turns a scan (or a typed invoice number) into a job.
 *
 * A scan is the mechanic physically picking the job up off the shelf, so this
 * is where a job auto-advances to "Work underway" — before anyone signs in,
 * exactly as the paper-first workflow implies. Only a summary comes back; the
 * log itself needs a name against it.
 */
function lookupJob(code, source, token) {
  const job = jobByToken_(String(code || '').trim().toUpperCase()) || jobByNumber_(code);
  if (!job) throw new Error('No job found for that code. Check the number on the work order.');
  // An order's number is a real BiT invoice number, so a mechanic can type
  // one. Saying what it is beats "not found" for a number they can see.
  if (isPartsOrder_(job)) {
    throw new Error(job.id + ' is a customer parts order, not a work order — there is nothing on it for the shop floor.');
  }

  if (source === 'scan' && job.status === 'received') {
    setStatus_(job, 'work_underway', 'system', '', 'First scan of the work order');
    // The one read that writes, so the one read that has to drop the list
    // itself: the dispatch only does it for functions off the read list.
    invalidateLists_();
  }
  const fresh = jobRow_(job.id);

  // A mechanic who is already signed in is going to ask for the log the
  // instant this answers, and a second call to Apps Script costs far more in
  // start-up and redirects than it does in reading — it was most of the wait
  // between scanning a work order and seeing the job. So the log rides along
  // when there is a name against the request. Without one the answer is
  // unchanged: a summary, and a sign-in prompt.
  const who = token ? mechanicOrNull_(token) : null;
  if (who) return mechanicPayload_(who, fresh);

  return {
    job: {
      id: fresh.id,
      token: fresh.token,
      boatInfo: fresh.boat_info,
      customerName: fresh.customer_name,
      // Typing the number instead of scanning means the paper is elsewhere,
      // so the work to be done has to come back with the job.
      workRequested: fresh.work_requested || null,
      status: fresh.status,
      statusLabel: STATUS_LABEL[fresh.status]
    }
  };
}

/**
 * Just the transcript state of a job's voice notes, for the phone to poll
 * while the mechanic is still standing there.
 *
 * Deliberately not jobLog: that returns every entry on the job, and polling
 * it every few seconds to watch one field change is a lot of spreadsheet
 * reading for a shop on wifi. This is the smallest answer to "are the words
 * back yet".
 */
function transcriptsFor(token, jobToken) {
  requireMechanic_(token);
  prefetch_(['Jobs', 'LogEntries']);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');

  return {
    entries: entriesForJob_(job.id)
      .filter(function (entry) { return Boolean(entry.audioFile); })
      .map(function (entry) {
        return {
          id: entry.id,
          // Both, because both can move: an older entry keeps its words in
          // `text`, a new one has them in `transcript` beside whatever was
          // typed.
          text: entry.text,
          transcript: entry.transcript,
          transcriptStatus: entry.transcriptStatus,
          transcriptError: entry.transcriptError
        };
      })
  };
}

/**
 * Every job still on the floor, for a mechanic who has the boat but not the
 * paperwork.
 *
 * This one needs a signed-in mechanic, unlike lookupJob. Looking a job up by
 * its number means you are holding the work order, or were told the number;
 * listing every open job hands over every customer's name and boat to
 * anyone who can reach the endpoint. Same information, very different
 * disclosure, so the roster is the gate.
 *
 * Finished and done jobs are left out: the list is "what could I be working
 * on", not an archive. A mechanic who taps Work finished is telling the shop
 * they are off that boat, so the job leaves their list the moment they do —
 * what happens to it after that is the writer's, and the writer's own list
 * still carries it. Nothing is lost by dropping it here: scanning the work
 * order still opens the job, so a mechanic who has more to add gets at it the
 * same way they got at it the first time.
 */
function openJobs(token, fresh) {
  requireMechanic_(token);
  // Opening the app takes whatever is fastest; a deliberate Refresh asks for
  // the sheet as it is now. Either way the answer is cached for the next one.
  const cached = fresh ? null : cachedOpenJobs_();
  if (cached) return cached;
  const gen = listsGen_();
  const out = openJobsFromSheet_();
  cachePutBig_(OPEN_JOBS_KEY_ + gen, out, OPEN_JOBS_TTL_);
  return out;
}

/*
 * ---------------------- the open-jobs list, from memory ------------------
 *
 * The list every mechanic opens, and every save changes. Measured, the server
 * answers it from CacheService in about a hundredth of the time it takes to
 * read the Jobs tab — and it is the call the phone makes most.
 *
 * What makes it safe to trust, each of which is load-bearing:
 *
 *  - EVERY WRITE DROPS IT, FROM ONE PLACE. serve_ calls invalidateLists_
 *    after any function that is not on API_GET_FNS_, so a write added later
 *    cannot forget to. lookupJob's first-scan advance, the one read that
 *    writes, drops it where it writes.
 *  - A GENERATION, NOT A DELETE. Dropping it mints a new generation id, and
 *    the list is stored under the generation current when its read BEGAN. A
 *    list read from the sheet just before a save, and put away just after,
 *    lands under a generation nobody asks for any more — rather than sitting
 *    there stale until it expires.
 *  - A SHAPE VERSION in the key. Bump OPEN_JOBS_V_ whenever a row gains a
 *    field, or for the life of the cache after a deploy the phone is handed
 *    rows without it and cannot tell "no alert" from "predates alerts".
 *  - A SHORT LIFE. Somebody editing the Sheet by hand goes round every one of
 *    the above; ten minutes is how long that can show on the floor, and
 *    Refresh on the list skips the cache altogether.
 *  - SPLIT ACROSS ENTRIES. CacheService caps a value at 100 KB, and a missing
 *    piece reads as a miss, never as half a list.
 */
const OPEN_JOBS_V_ = 3;
const OPEN_JOBS_KEY_ = 'OPENJOBS_v' + OPEN_JOBS_V_ + '_';
// Shared by every cached list: one write drops them all.
const LISTS_GEN_KEY_ = 'LISTS_GEN';
const OPEN_JOBS_TTL_ = 600;

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (err) { return null; }
}

/** The current generation, minted if there is none. '' with no cache at all. */
function listsGen_() {
  const cache = scriptCache_();
  if (!cache) return '';
  try {
    const gen = cache.get(LISTS_GEN_KEY_);
    if (gen) return gen;
    return newListsGen_(cache);
  } catch (err) {
    return '';
  }
}

function newListsGen_(cache) {
  const gen = Utilities.getUuid().slice(0, 8);
  // Longer than any list lives, so the generation outlasts what it names.
  cache.put(LISTS_GEN_KEY_, gen, 21600);
  return gen;
}

/** The generation now, without minting one. '' when there is none. */
function currentListsGen_() {
  const cache = scriptCache_();
  if (!cache) return '';
  try { return cache.get(LISTS_GEN_KEY_) || ''; } catch (err) { return ''; }
}

function cachedOpenJobs_() {
  const gen = currentListsGen_();
  if (!gen) return null;
  const hit = cacheGetBig_(OPEN_JOBS_KEY_ + gen);
  if (!hit || !Array.isArray(hit.jobs)) return null;
  hit.fromCache = true;
  return hit;
}

/**
 * After any write. Never throws: a save must not fail over a cache.
 *
 * Flushes first. SpreadsheetApp holds writes back until the execution ends,
 * so without it the new generation would exist before the write it marks had
 * reached the sheet — and a list read in that gap would be put away under the
 * NEW generation, stale, for its whole life.
 */
function invalidateLists_() {
  const cache = scriptCache_();
  if (!cache) return;
  try { SpreadsheetApp.flush(); } catch (err) { /* nothing held back */ }
  try { newListsGen_(cache); } catch (err) { /* the list expires on its own */ }
}

/**
 * A value too big for one CacheService entry, in pieces. The head names how
 * many pieces and a random id they are stored under, so a reader cannot stitch
 * the head of one write to the pieces of another. Any piece missing is a miss.
 * Pieces are measured in characters and kept well under the byte cap, since a
 * character can be up to four bytes.
 */
const CACHE_PIECE_CHARS_ = 24000;

function cachePutBig_(key, value, ttl) {
  const cache = scriptCache_();
  if (!cache || !key) return false;
  try {
    const text = JSON.stringify(value);
    const id = Utilities.getUuid().slice(0, 8);
    const pieces = {};
    let n = 0;
    for (let at = 0; at < text.length || n === 0; at += CACHE_PIECE_CHARS_) {
      pieces[key + '.' + id + '.' + n] = text.slice(at, at + CACHE_PIECE_CHARS_);
      n++;
    }
    // Pieces first, head last: a reader who sees the head finds the pieces.
    cache.putAll(pieces, ttl);
    cache.put(key, JSON.stringify({ id: id, n: n }), ttl);
    return true;
  } catch (err) {
    return false;
  }
}

function cacheGetBig_(key) {
  const cache = scriptCache_();
  if (!cache || !key) return null;
  try {
    const head = JSON.parse(cache.get(key) || 'null');
    if (!head || !head.id || !(head.n > 0)) return null;
    const keys = [];
    for (let i = 0; i < head.n; i++) keys.push(key + '.' + head.id + '.' + i);
    const got = cache.getAll(keys) || {};
    let text = '';
    for (let i = 0; i < keys.length; i++) {
      if (typeof got[keys[i]] !== 'string') return null;
      text += got[keys[i]];
    }
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/** The list itself, read from the sheet. Writes nothing, caches nothing. */
function openJobsFromSheet_() {
  const jobs = rows_('Jobs')
    // A customer's parts order has nothing on it for the floor to do.
    .filter(function (job) {
      if (job.status === 'done' || job.status === 'work_finished' || isPartsOrder_(job)) return false;
      // The detailer's alone, or the mechanic's half already marked done:
      // nothing left on it for the floor.
      const split = String(job.detail_split || '');
      return split !== 'detail' && !(split === 'both' && job.mech_done_at);
    })
    .map(function (job) {
      return {
        id: job.id,
        token: job.token,
        customerName: job.customer_name || '',
        boatInfo: job.boat_info || '',
        workRequested: job.work_requested || '',
        // Carried so the list can flag the job before it is opened — an alert
        // nobody sees until they have picked the job is half an alert.
        alert: job.alert || '',
        // A walk-in winterize, and how much of its checklist is left.
        winterLeft: (function () { const w = winterView_(winterSpecOf_(job)); return w ? w.winterizeLeft : -1; })(),
        // A split ticket: the mechanic has a half, the detailer the other.
        split: String(job.detail_split || ''),
        status: job.status,
        statusLabel: STATUS_LABEL[job.status]
      };
    });

  // Underway first — that is the boat someone is standing next to — then
  // waiting. Finished never reaches here.
  const rank = { work_underway: 0, received: 1 };
  jobs.sort(function (a, b) {
    // A job carrying an alert goes to the top whatever its status, because the
    // whole point of the alert is that it is read before work starts.
    const byAlert = (b.alert ? 1 : 0) - (a.alert ? 1 : 0);
    if (byAlert !== 0) return byAlert;
    const byStatus = (rank[a.status] === undefined ? 9 : rank[a.status]) -
                     (rank[b.status] === undefined ? 9 : rank[b.status]);
    return byStatus !== 0 ? byStatus : String(a.id).localeCompare(String(b.id));
  });
  return { jobs: jobs };
}

/**
 * The customer page. The token in the URL is the whole of the credential.
 *
 * In test mode this answers with a holding notice unless the caller is signed
 * in on the shop side — so a customer who scans the QR off a work order sees
 * nothing, while the writer previewing the same link sees the real page.
 */
function publicJob(trackingToken, shopToken) {
  const job = jobByToken_(String(trackingToken || '').trim().toUpperCase());
  if (!job) throw new Error('That tracking link does not match a job.');

  let staff = false;
  try {
    requireShop_(shopToken);
    staff = true;
  } catch (err) {
    staff = false;
  }
  // Two separate reasons the page may be dark, and the customer is told a
  // different thing by each: a rehearsal ends, an internal-only shop does not.
  if (!staff && (!customerTracking_() || testMode_())) {
    return {
      notLive: true,
      reason: customerTracking_() ? 'test' : 'off',
      shop: { name: SHOP_NAME, phone: SHOP_PHONE }
    };
  }

  return {
    testMode: testMode_(),
    job: {
      id: job.id,
      boatInfo: job.boat_info,
      status: job.status,
      createdAt: job.created_at,
      // Only ever offered once the job is done and the writer attached them.
      // The balance is the customer's own figure off their own invoice — it
      // is not shop bookkeeping, and it is the thing they most want to know.
      invoiceFile: job.status === 'done' ? (job.invoice_file || null) : null,
      paymentLink: job.status === 'done' ? (job.payment_link || null) : null,
      amountDue: job.status === 'done' ? jobBalance_(job) : null
    },
    entries: customerView_(entriesForJob_(job.id)),
    shop: { name: SHOP_NAME, phone: SHOP_PHONE }
  };
}

/* =============================== files ================================= */

function rootFolder_() {
  const id = props_().getProperty('DRIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder(DRIVE_FOLDER_NAME);
  props_().setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * Per-execution cache. Without it every saved file paid for its own Drive
 * folder search, so a photo cost two searches and a note with four photos
 * cost eight.
 */
let _folders = {};

function jobFolder_(jobId) {
  const key = String(jobId);
  if (_folders[key]) return _folders[key];

  const root = rootFolder_();
  const existing = root.getFoldersByName(key);
  const folder = existing.hasNext() ? existing.next() : root.createFolder(key);

  // Share the FOLDER, once, rather than every file inside it. Drive hands a
  // file its parent's permissions, and setSharing is a slow call that used
  // to be made twice for every photo — a thumbnail and a full size each.
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    _sharedFolders[key] = true;
  } catch (err) {
    // Fall back to sharing each file, so a photo is never left unreachable.
    _sharedFolders[key] = false;
  }
  _folders[key] = folder;
  return folder;
}

let _sharedFolders = {};

/**
 * Stores base64 bytes in the job's Drive folder and returns the Drive id.
 *
 * Files are shared "anyone with the link", the same arrangement the shop
 * already uses for unit photos on the winter services side. Apps Script
 * cannot stream binary, so the alternative was base64 through this endpoint
 * on every image — an execution and a fat JSON payload per photo, on shop
 * wifi.
 *
 * What protects a file is that its id is unguessable AND that ids are only
 * ever handed out by the rule in customerView_/publicJob: the customer page
 * is sent ids for photos on customer notes and, once done, the invoice —
 * nothing else. An internal photo's id never reaches a page a customer can
 * open, so there is nothing there to leak.
 */
/**
 * How many bytes a base64 string stands for, without decoding it.
 *
 * Four characters carry three bytes, less whatever the padding stands in for.
 * Worth doing arithmetically: the alternative is a second decode of a payload
 * that may be tens of megabytes, purely to call `.length` on the result.
 */
function base64Bytes_(base64) {
  const clean = String(base64 == null ? '' : base64).replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.slice(-2) === '==' ? 2 : (clean.slice(-1) === '=' ? 1 : 0);
  return Math.max(0, Math.floor(clean.length / 4) * 3 - padding);
}

function saveFile_(jobId, name, mime, base64) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name);
  const folder = jobFolder_(jobId);
  const file = folder.createFile(blob);
  if (!_sharedFolders[String(jobId)]) {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  return file.getId();
}

/* =============================== email ================================= */

/** Money the way an invoice says it. */
function money_(value) {
  const number = numberOrNull_(value);
  if (number === null) return '';
  // -$12.00, not $-12.00: a refund is the one negative figure this prints.
  return (number < 0 ? '-$' : '$') + Math.abs(number).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function esc_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let _logoBlob = null;
function logoBlob_() {
  if (_logoBlob !== null) return _logoBlob;
  try {
    _logoBlob = UrlFetchApp.fetch(LOGO_URL).getBlob().setName('questlogo');
  } catch (err) {
    _logoBlob = false; // Cached as a miss so we do not retry on every send.
  }
  return _logoBlob;
}

/**
 * A button built out of a table, which is the only kind that survives Outlook.
 *
 * It used to be an <a> with padding and a background colour. Outlook's
 * renderer ignores padding on an inline element, so what arrived was the
 * label with a coloured rectangle behind the text and nothing else — which
 * reads as a highlighted word rather than something to press. The colour goes
 * on a table cell, where every client honours it, and the padding goes on a
 * block-level <a> filling that cell so the whole rectangle is clickable.
 *
 * bgcolor as an attribute as well as CSS: Outlook wants the attribute.
 */
function button_(url, label, bg) {
  const fill = bg || '#14293E';
  const edge = bg ? '#9C6E14' : '#0C1B2C';
  return '<table role="presentation" border="0" cellpadding="0" cellspacing="0" ' +
      'style="display:inline-block;margin:0 10px 10px 0;border-collapse:separate"><tr>' +
      '<td align="center" bgcolor="' + fill + '" style="background:' + fill +
        ';border:1px solid ' + edge + ';border-radius:8px">' +
      '<a href="' + esc_(url) + '" style="display:block;padding:14px 30px;' +
        'font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;' +
        'color:#ffffff;text-decoration:none;white-space:nowrap">' + esc_(label) + '</a>' +
      '</td></tr></table>';
}

/**
 * The house style, matched to the winter services app's customer emails so
 * both arrive looking like the same shop: the wordmark over a gold rule, one
 * card on ice blue, a navy footer with the address and phone.
 *
 * Built out of TABLES carrying bgcolor attributes, not divs with CSS
 * backgrounds, because Outlook on Windows renders mail through Word — and
 * Word is not a browser. It ignores max-width, so a div card becomes as wide
 * as the window. It drops background colours given only in CSS, so the white
 * card, the navy footer and every coloured notice arrived plain white. And it
 * will not inherit font-family into a table, which is how half an email ends
 * up in Times New Roman.
 *
 * So: every colour is an attribute as well as a style, every cell that holds
 * text names its own font, line heights are in pixels rather than multiples,
 * and a ghost table inside an mso conditional pins the width for Outlook
 * while every other client uses max-width. Gmail rendered the div version
 * beautifully, which is exactly why it survived this long.
 *
 * The width and height attributes on the logo are load-bearing for the same
 * reason — Outlook ignores the CSS and prints the full-size image without
 * them.
 */
const MAIL_FONT = 'font-family:Arial,Helvetica,sans-serif';

/**
 * How many bytes of attachment the invoice email will carry.
 *
 * Gmail refuses a message over 25MB, and that 25MB is the message as it goes
 * on the wire — where MIME encodes every attachment in base64 and four
 * characters carry three bytes. So 18MB of actual file is about 24MB of mail,
 * and anything past that is a bounce rather than a big email.
 *
 * Over the budget the file is not dropped and the customer is not told to
 * ring up: it goes in the body as a Drive link, which is the same file by a
 * different door. See invoiceEmailContent_.
 */
const MAIL_ATTACHMENT_BUDGET = 18 * 1024 * 1024;

/**
 * A Drive file by its id, the same URL shape the pages use.
 *
 * Built rather than fetched with getUrl(): every job folder is link-shared,
 * so the id is all that is needed, and asking Drive would be a round trip
 * per link for a string we can write ourselves.
 */
function driveViewUrl_(id) {
  return 'https://drive.google.com/file/d/' + encodeURIComponent(String(id)) + '/view';
}

/**
 * Decides attach-or-link for a list of Drive files, against what is left of
 * the message's attachment budget.
 *
 * The rule lives here rather than in each send path because it is subtle in
 * exactly one place: a file whose size was never recorded is LINKED, not
 * attached. What is being decided is whether to stake the whole email —
 * invoice and all — on one file, and an unknown size is not something to
 * gamble that on. A link always works.
 *
 * Files are taken in the order given and each is measured against what is
 * left, so a small one behind a large one is still attached rather than
 * punished for its neighbour. A file binned out of Drive by hand is dropped
 * from both lists: the rest of the email still goes.
 *
 * Nothing is ever left off silently — everything is in `attached` or `linked`
 * and every send path says which.
 */
function packAttachments_(budget, candidates, preview) {
  const out = { blobs: [], attached: [], linked: [], budget: budget };
  (candidates || []).forEach(function (file) {
    if (!file || !file.driveFile) return;
    if (!file.size || file.size > out.budget) {
      out.linked.push({ name: file.name, driveFile: file.driveFile });
      return;
    }
    // A preview says what would be attached without downloading any of it:
    // the decision is made on the recorded size, never on the bytes.
    if (preview) {
      out.budget -= file.size;
      out.attached.push(file.name);
      return;
    }
    try {
      out.blobs.push(DriveApp.getFileById(file.driveFile).getBlob().setName(file.name));
      out.budget -= file.size;
      out.attached.push(file.name);
    } catch (err) {
      /* Binned out of Drive by hand. Send the rest. */
    }
  });
  return out;
}

/** The download list for whatever did not fit, as the email shows it. */
function linkListHtml_(linked) {
  return (linked || []).map(function (file) {
    return '<a href="' + driveViewUrl_(file.driveFile) + '" style="color:#1F5C8B">' +
      esc_(file.name) + '</a>';
  }).join('<br>');
}

/**
 * The feedback invitation, in the house style. On every customer email about
 * finished work, whether or not a review was asked for — see FEEDBACK_LINE.
 */
function feedbackHtml_() {
  return '<div style="' + MAIL_FONT + ';font-size:14.5px;line-height:22px;color:#1D2B38;' +
    'margin:16px 0 0;padding:12px 0 0;border-top:1px solid #EBF1F6">' + esc_(FEEDBACK_LINE) + '</div>';
}

/** A coloured notice box: the test-mode banner, the balance. */
function mailBox_(fill, edge, body, extra) {
  return '<div style="margin:0 0 16px">' +
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ' +
        'bgcolor="' + fill + '" style="background:' + fill + ';border:1px solid ' + edge +
        ';border-radius:8px' + (extra || '') + '">' +
      '<tr><td style="padding:13px 16px">' + body + '</td></tr>' +
    '</table></div>';
}

/**
 * A note of the writer's own, typed in the preview before the email goes:
 * "Your spare prop is by the door", "Sorry this took so long". The same
 * arrangement as the winter console's staff note — it sits right under
 * "Hi name,", where a personal line reads as one, and the preview and the
 * send are built with it the same way, so what the writer saw is what goes.
 *
 * A table, not a div, for the reason every coloured box in these emails is
 * one: Outlook drops a background given only in CSS. Escaped, so a note can
 * never put markup into a customer's email.
 */
const NOTE_SLOT_ = '<!--staff-note-->';
const NOTE_MAX_ = 2000;

function staffNote_(staff) {
  const raw = staff && typeof staff === 'object' ? staff.note : staff;
  return String(raw || '').replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX_);
}

function withStaffNote_(content, note) {
  if (!note) return content;
  if (content.html.indexOf(NOTE_SLOT_) === -1) {
    // Every email offered a note is built on noticeHtml_. One that is not
    // would drop the note without a word, so refuse instead.
    throw new Error('This email has no place for a note.');
  }
  const block = mailBox_('#EBF1F6', '#C7D5E0',
    '<div style="' + MAIL_FONT + ';font-size:15px;line-height:23px;color:#1D2B38">' +
      esc_(note).replace(/\n/g, '<br>') + '</div>',
    ';border-left:4px solid #4A81A6');
  content.html = content.html.replace(NOTE_SLOT_, block);
  content.text = note + '\n\n' + (content.text || '');
  content.note = note;
  return content;
}

function noticeHtml_(parts) {
  const logo = logoBlob_()
    ? '<img src="cid:questlogo" alt="' + esc_(SHOP_NAME) + '" width="104" height="56" style="width:104px;height:56px;display:block;border:0">'
    : '<div style="font-family:Arial Black,Arial,sans-serif;font-size:24px;color:#14293E;letter-spacing:1px">' +
      esc_(SHOP_NAME.toUpperCase()) + '</div>';

  const card =
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" align="center" ' +
        'bgcolor="#ffffff" style="max-width:640px;background:#ffffff;border:1px solid #C7D5E0;border-collapse:collapse">' +
      '<tr><td bgcolor="#ffffff" style="padding:22px 28px;border-bottom:4px solid #C08A22">' + logo + '</td></tr>' +
      '<tr><td bgcolor="#ffffff" style="padding:26px 28px;' + MAIL_FONT +
          ';font-size:15px;color:#1D2B38;line-height:23px">' +
        (parts.banner || '') +
        (parts.greeting ? '<p style="' + MAIL_FONT + ';font-size:16px;line-height:24px;color:#1D2B38;margin:0 0 6px">Hi ' +
          esc_(parts.greeting) + ',</p>' : '') +
        // Where a writer's note goes: under "Hi name,", ahead of the system's
        // own wording. Filled by withStaffNote_, or left as an empty comment.
        NOTE_SLOT_ +
        '<div style="' + MAIL_FONT + ';font-size:15px;color:#1D2B38;line-height:23px;margin:0 0 14px">' + parts.intro + '</div>' +
        (parts.meta ? '<div style="font-family:Courier New,Courier,monospace;font-size:13px;line-height:19px;' +
          'color:#5C7185;margin-bottom:10px">' + esc_(parts.meta) + '</div>' : '') +
        (parts.buttons ? '<div style="margin:18px 0 4px">' + parts.buttons + '</div>' : '') +
        '<div style="border-top:1px solid #EBF1F6;margin:18px 0 0;padding-top:14px">' +
          '<p style="' + MAIL_FONT + ';font-size:13.5px;color:#4A5A68;line-height:20px;margin:0">' +
            'Any questions, give us a call on ' + esc_(SHOP_PHONE) + ' &mdash; we&rsquo;re happy to talk it through.' +
          '</p></div>' +
      '</td></tr>' +
      // The same gold rule that sits under the wordmark, so the navy band
      // reads as the bottom of a frame rather than a line that wandered in.
      '<tr><td height="4" bgcolor="#C08A22" style="height:4px;background:#C08A22;font-size:0;' +
        'line-height:0;mso-line-height-rule:exactly">&nbsp;</td></tr>' +
      '<tr><td bgcolor="#14293E" style="background:#14293E;padding:20px 28px;' + MAIL_FONT +
          ';font-size:12.5px;line-height:21px;color:#B9CDDD;text-align:center" align="center">' +
        '<div style="color:#ffffff;font-size:13.5px;font-weight:bold;letter-spacing:.04em;margin-bottom:2px">' +
          esc_(SHOP_NAME) + '</div>' +
        esc_(SHOP_ADDRESS) + '<br>' + esc_(SHOP_PHONE) + ' &middot; ' + esc_(SERVICE_EMAIL) +
      '</td></tr>' +
    '</table>';

  return '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ' +
      'bgcolor="#EBF1F6" style="background:#EBF1F6;border-collapse:collapse">' +
      '<tr><td align="center" style="padding:24px 12px">' +
        '<!--[if mso]><table role="presentation" width="640" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->' +
        card +
        '<!--[if mso]></td></tr></table><![endif]-->' +
      '</td></tr></table>';
}

function logEmail_(jobId, kind, recipient, subject, status, error, at, note) {
  appendRow_('EmailLog', {
    id: newId_('mail'),
    job_id: jobId || '',
    kind: kind,
    recipient: recipient,
    subject: subject,
    status: status,
    error: error ? String(error).substr(0, 400) : '',
    created_at: at || nowIso_(),
    note: note || ''
  });
}

function deliverMail_(options) {
  const opts = {
    htmlBody: options.html,
    name: SHOP_NAME,
    replyTo: SERVICE_EMAIL
  };
  const logo = logoBlob_();
  if (logo) opts.inlineImages = { questlogo: logo };
  if (FROM_ALIAS) opts.from = FROM_ALIAS;
  if (options.attachments) opts.attachments = options.attachments;
  if (options.cc) opts.cc = options.cc;
  GmailApp.sendEmail(options.to, options.subject, options.text || options.subject, opts);
}

function send_(options) {
  try {
    deliverMail_(options);
    logEmail_(
      options.jobId,
      options.kind,
      // Who it went to, copies included, because "did the shop get one?" is a
      // question the writer's email log should answer without guessing.
      options.cc ? options.to + ' (cc ' + options.cc + ')' : options.to,
      options.subject,
      options.suppressed ? 'held (test mode)' : 'sent',
      options.suppressed ? 'would have gone to ' + options.intendedFor : '',
      null, options.note
    );
    return true;
  } catch (err) {
    logEmail_(options.jobId, options.kind, options.to, options.subject, 'failed', err, null, options.note);
    return false;
  }
}

/**
 * Same delivery as send_, logged once per job instead of once for the
 * message — a statement is one email about several invoices, and each job's
 * own mail log (what the job page reads to know what has gone out about it)
 * needs its own row to show it.
 *
 * Every one of those rows is stamped with the SAME timestamp, computed once
 * here rather than left to logEmail_'s own default. Rows come from a loop
 * over appendRow_ calls — real Sheets writes, not free — so two calls to
 * nowIso_() a few of those apart can land in different seconds. The Sent
 * statements list regroups these rows by (recipient, subject, created_at)
 * with no table of its own to hold a batch id, and that only works if one
 * send leaves one timestamp behind.
 */
function sendStatement_(options) {
  const recipientLog = options.cc ? options.to + ' (cc ' + options.cc + ')' : options.to;
  const at = nowIso_();
  try {
    deliverMail_(options);
    options.jobIds.forEach(function (jobId) {
      logEmail_(jobId, options.kind, recipientLog, options.subject,
        options.suppressed ? 'held (test mode)' : 'sent',
        options.suppressed ? 'would have gone to ' + options.intendedFor : '', at);
    });
    return true;
  } catch (err) {
    options.jobIds.forEach(function (jobId) {
      logEmail_(jobId, options.kind, options.to, options.subject, 'failed', err, at);
    });
    return false;
  }
}

/**
 * The single customer-facing email: the final BiT invoice attached, the
 * balance owed, and the POS+ payment link.
 *
 * Nothing fires this on its own. A service writer presses the button, on a
 * job they have already marked done — marking done and emailing the customer
 * are two deliberate acts, so closing a ticket can never post mail by itself.
 */
/** The date and time a rehearsal was generated, in the shop's own timezone. */
function rehearsalStamp_() {
  return Utilities.formatDate(new Date(), 'America/Chicago', 'MMM d HH:mm');
}

function invoiceEmailContent_(job, preview) {
  const rehearsal = testMode_();
  const attachments = [];

  // The invoice is a separate PDF attachment on every one of these, whatever
  // else the job carries. It is the document the email is about, it is small,
  // and a customer should never have to follow a link to read their own bill.
  let invoiceAttached = false;
  let budget = MAIL_ATTACHMENT_BUDGET;
  if (job.invoice_file && preview) {
    invoiceAttached = true;
  } else if (job.invoice_file) {
    try {
      const invoice = DriveApp.getFileById(job.invoice_file).getBlob().setName('Invoice-' + job.id + '.pdf');
      attachments.push(invoice);
      invoiceAttached = true;
      budget -= invoice.getBytes().length;
    } catch (err) {
      /* The job is done either way; a missing attachment is not a reason to hold the mail. */
    }
  }

  // Whatever the writer marked for the customer when they added it. Marked
  // once, at upload, and never guessed at here: an internal file going out
  // with an invoice is the mistake this whole distinction exists to prevent.
  //
  // What is decided here is only HOW it goes: a file that fits inside what
  // is left of the budget is attached, and one that does not goes in the body
  // as a Drive link. That beats both alternatives — refusing the upload puts
  // the writer back to mailing it by hand, and attaching it anyway bounces
  // the whole email, invoice and all. Files are taken in the order they were
  // added and each is measured against what is left, so a small one added
  // after a large one is still attached rather than punished for its
  // neighbour.
  const packed = packAttachments_(budget, filesForJob_(job.id).filter(function (file) {
    return file.visibility === 'customer';
  }), preview);
  packed.blobs.forEach(function (blob) { attachments.push(blob); });
  const extras = packed.attached;
  const linked = packed.linked;
  const linkList = linkListHtml_(linked);

  // No tracking link while the page is switched off — a dead link in a
  // customer's invoice is worse than no link at all.
  const link = customerTracking_() ? trackingUrl_(job) : '';
  const first = String(job.customer_name || '').split(' ')[0];
  // The remaining balance, not the invoice's original figure. Normally the
  // two are the same — this email goes out before anybody has paid — but a
  // writer re-sending it after taking a payment must not ask again for money
  // already in the till.
  const due = jobBalance_(job);
  const deposits = numberOrNull_(job.deposits);
  const paid = money2_(numberOrNull_(job.paid_total) || 0);

  // A job with a deposit against it owes nothing like its total, so the
  // balance gets said plainly rather than left for them to work out.
  const balance = due === null ? '' : mailBox_('#FDFCF7', '#C7D5E0',
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
      (deposits ? '<tr><td style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;line-height:19px">' +
        'Deposits already paid</td>' +
        '<td align="right" style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;line-height:19px">' +
        money_(deposits) + '</td></tr>' : '') +
      (paid ? '<tr><td style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;line-height:19px">' +
        'Payments received</td>' +
        '<td align="right" style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;line-height:19px">' +
        money_(paid) + '</td></tr>' : '') +
      '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;font-size:15px;line-height:23px">' +
        'Amount due</td>' +
        '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
        'font-size:17px;line-height:24px">' + money_(due) + '</td></tr>' +
    '</table>');

  // In test mode the customer's email is sent to the shop instead, headed with
  // who it was for, so it can be read end to end without anybody outside the
  // building seeing anything.
  const banner = rehearsal
    ? mailBox_('#FBEEE2', '#E4B48F',
      '<div style="' + MAIL_FONT + ';font-size:14px;line-height:21px;color:#A6541F">' +
        '<b>TEST MODE &mdash; not sent to the customer.</b><br>This is what ' +
        esc_(normalizeEmails_(job.customer_email)) + ' would have received for job ' + esc_(job.id) + '.' +
        // Which rehearsal this is. Two copies of the same job an hour apart
        // are otherwise identical to look at, and the whole point of
        // resending one is to see whether something changed.
        '<br>Generated ' + esc_(rehearsalStamp_()) + '.</div>',
      ';border-left:4px solid #A6541F')
    : '';

  const to = rehearsal ? testEmail_() : normalizeEmails_(job.customer_email);

  return {
    to: to,
    // The shop keeps a copy of everything that goes to a customer. Skipped
    // when the service desk IS the recipient, which is what a rehearsal is —
    // copying an address to itself is a duplicate, not a record.
    cc: shopCc_(to),
    jobId: job.id,
    kind: rehearsal ? 'customer_done_test' : 'customer_done',
    suppressed: rehearsal,
    intendedFor: normalizeEmails_(job.customer_email),
    // The rehearsal carries its own time. Every test send of the same job
    // used to have an identical subject, so Gmail stacked them into one
    // conversation and hid the repeated body behind its "trimmed content"
    // dots — which is how a re-sent rehearsal can look exactly like the one
    // received an hour earlier, whatever changed in between. What the
    // customer gets is unchanged.
    subject: (rehearsal ? '[TEST ' + rehearsalStamp_() + '] ' : '') +
      'Your ' + SHOP_NAME + ' service is complete — ' + job.id,
    greeting: first,
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      // Not "your boat": plenty of what comes through the shop is a trailer,
      // a prop or an engine on a stand, and the unit is named on the line
      // below anyway. What is always true is that the customer asked for
      // something and it has been done.
      intro: 'The work you requested has been done. ' +
        (invoiceAttached ? 'Your final invoice is attached' : 'Everything is wrapped up') +
        (job.payment_link ? ', and you can pay online with the button below.' : '.') +
        (extras.length ? '<div style="' + MAIL_FONT + ';margin-top:8px">Also attached: ' +
          extras.map(esc_).join(', ') + '.</div>' : '') +
        // Too big for the email, so the same file by link. Said as where it
        // is rather than as an apology for the size of it.
        (linked.length ? '<div style="' + MAIL_FONT + ';margin-top:8px">' +
          (linked.length === 1 ? 'This is too large to email, so it is here to download:'
            : 'These are too large to email, so they are here to download:') +
          '<br>' + linkList + '</div>' : '') + balance + feedbackHtml_(),
      meta: 'INVOICE# ' + job.id + (job.boat_info ? ' · ' + job.boat_info : ''),
      buttons: (link ? button_(link, 'View your job') : '') +
        (job.payment_link ? button_(job.payment_link, due === null ? 'Pay online' : 'Pay ' + money_(due), '#C08A22') : '')
    }),
    text: 'The work you requested has been done.' +
      '\n\n' + FEEDBACK_LINE +
      (extras.length ? '\n\nAlso attached: ' + extras.join(', ') : '') +
      (linked.length ? '\n\nToo large to email, so here to download:\n' +
        linked.map(function (file) { return file.name + ': ' + driveViewUrl_(file.driveFile); }).join('\n') : '') +
      (due === null ? '' : '\n\nAmount due: ' + money_(due)) +
      (link ? '\n\nJob status: ' + link : '') +
      (job.payment_link ? '\nPay your invoice: ' + job.payment_link : '') +
      '\n\nInvoice ' + job.id + '\n' + SHOP_NAME,
    attachments: attachments
  };
}

/* ============================== payments =============================== */

/**
 * `2026-09-15` as a person reads it, without going near a Date.
 *
 * Deliberately string arithmetic. A payment date is stored as a plain day —
 * no time, no zone — and `new Date('2026-09-15')` is midnight UTC, which
 * formatted in the shop's own timezone is the fourteenth. A customer reading
 * a receipt dated the day before they paid rings up about it, and they are
 * right to.
 */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function payDate_(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  const month = MONTH_NAMES[Number(match[2]) - 1];
  if (!month) return '';
  return month + ' ' + Number(match[3]) + ', ' + match[1];
}

/** "Visa ending 4412" — how a payment is named on the receipt. */
function paymentLabel_(payment) {
  const label = PAYMENT_METHOD_LABEL[payment.method] || PAYMENT_METHOD_LABEL.other;
  return payment.reference ? label + ' · ' + payment.reference : label;
}

/**
 * The receipt a customer gets when money is taken: what was received, how,
 * and where that leaves the invoice.
 *
 * Two shapes out of one function on purpose. "Paid in full" and "payment
 * received, balance owed" differ in what they say and in whether they ask for
 * anything further, and a single template with a couple of ternaries in it is
 * how one of those ends up quietly asking a customer who has settled up to
 * pay again.
 *
 * Built out of tables carrying bgcolor attributes, like everything else that
 * leaves this file — see noticeHtml_ for why that is not a style choice.
 */
function paymentEmailContent_(job, options) {
  const rehearsal = testMode_();
  const payments = options.payments || [];
  const batchTotal = money2_(payments.reduce(function (sum, p) { return sum + p.amount; }, 0));
  const paidTotal = money2_(options.paidTotal || 0);
  const balance = options.balance;
  const full = Boolean(options.paidInFull);
  const review = options.requestReview ? reviewUrl_() : '';
  const note = String(options.note || '').trim();
  const linked = options.linked || [];

  const rows = payments.map(function (payment) {
    const when = payDate_(payment.receivedAt);
    return '<tr>' +
      '<td style="' + MAIL_FONT + ';padding:4px 10px 4px 0;color:#1D2B38;font-size:14px;line-height:21px">' +
        esc_(paymentLabel_(payment)) +
        (when ? ' <span style="color:#5C7185">· ' + esc_(when) + '</span>' : '') + '</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;color:#1D2B38;font-size:14px;' +
        'line-height:21px;white-space:nowrap">' + money_(payment.amount) + '</td></tr>';
  }).join('');

  const lineTable = '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" ' +
      'style="margin:10px 0 2px">' + rows +
    '<tr><td style="' + MAIL_FONT + ';padding:8px 10px 0 0;border-top:1px solid #C7D5E0;font-weight:bold;' +
      'color:#14293E;font-size:14px;line-height:21px">' +
      (payments.length > 1 ? 'Total received' : 'Received') + '</td>' +
    '<td align="right" style="' + MAIL_FONT + ';padding:8px 0 0;border-top:1px solid #C7D5E0;font-weight:bold;' +
      'color:#14293E;font-size:14px;line-height:21px;white-space:nowrap">' + money_(batchTotal) + '</td></tr>' +
    '</table>';

  // Paid in full says so in its own colour and asks for nothing. A remaining
  // balance is the same box the invoice email uses, so the figure a customer
  // is looking at is in the place they last saw one.
  const balanceBox = full
    ? mailBox_('#EFF6EE', '#BBD5B6',
        '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
          '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#2E6B2A;' +
            'font-size:15px;line-height:23px">Paid in full — nothing further owed</td>' +
          '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#2E6B2A;' +
            'font-size:17px;line-height:24px;white-space:nowrap">' + money_(0) + '</td></tr></table>')
    : (balance === null ? '' : mailBox_('#FDFCF7', '#C7D5E0',
        '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
          (paidTotal > batchTotal + 0.005
            ? '<tr><td style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;line-height:19px">' +
              'Paid on this invoice to date</td>' +
              '<td align="right" style="' + MAIL_FONT + ';padding:3px 0;color:#5C7185;font-size:13px;' +
              'line-height:19px">' + money_(paidTotal) + '</td></tr>'
            : '') +
          '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
            'font-size:15px;line-height:23px">Balance remaining</td>' +
          '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
            'font-size:17px;line-height:24px;white-space:nowrap">' + money_(balance) + '</td></tr></table>'));

  const noteBox = note
    ? mailBox_('#F4F8FB', '#C7D5E0',
        '<div style="' + MAIL_FONT + ';font-size:14.5px;line-height:22px;color:#1D2B38">' +
          esc_(note).replace(/\r?\n/g, '<br>') + '</div>')
    : '';

  // Only when a writer ticked the box AND the shop has actually set its review
  // link. Never by default: the whole point of the tick is that a job which
  // went badly gets the receipt without the ask.
  const reviewBlock = review
    ? '<div style="' + MAIL_FONT + ';font-size:14.5px;line-height:22px;color:#1D2B38;margin:16px 0 0">' +
        'It was a pleasure working with you. If you have a minute, a short Google review helps ' +
        'other boaters find us more than just about anything else we can do.' +
        // Only when the link lands on the listing rather than the review box.
        // The shop's Business Profile link opens the stars directly, and
        // telling somebody to hunt for a button that is already in front of
        // them reads as clutter.
        (directReviewLink_(review) ? ''
          : ' The button below opens our Google listing \u2014 tap <b>Write a review</b> there.') +
      '</div>'
    : '';

  const banner = rehearsal
    ? mailBox_('#FBEEE2', '#E4B48F',
      '<div style="' + MAIL_FONT + ';font-size:14px;line-height:21px;color:#A6541F">' +
        '<b>TEST MODE — not sent to the customer.</b><br>This is what ' +
        esc_(normalizeEmails_(job.customer_email)) + ' would have received for job ' + esc_(job.id) + '.' +
        '<br>Generated ' + esc_(rehearsalStamp_()) + '.</div>',
      ';border-left:4px solid #A6541F')
    : '';

  const to = rehearsal ? testEmail_() : normalizeEmails_(job.customer_email);
  const first = String(job.customer_name || '').split(' ')[0];
  const kind = full ? 'customer_paid' : 'customer_payment';

  const intro = full
    ? 'Thank you — your payment has been received, and invoice ' + esc_(job.id) +
      ' is now paid in full.'
    : 'Thank you — your payment has been received. Here is where the invoice stands.';

  const attachNote = options.attached && options.attached.length
    ? '<div style="' + MAIL_FONT + ';margin-top:10px">Attached: ' +
      options.attached.map(esc_).join(', ') + '.</div>'
    : '';
  const linkNote = linked.length
    ? '<div style="' + MAIL_FONT + ';margin-top:8px">' +
      (linked.length === 1 ? 'This is too large to email, so it is here to download:'
        : 'These are too large to email, so they are here to download:') +
      '<br>' + linkListHtml_(linked) + '</div>'
    : '';

  return {
    to: to,
    // The shop keeps its own copy of everything that goes to a customer,
    // skipped when the desk is already the recipient — see invoiceEmailContent_.
    cc: shopCc_(to),
    jobId: job.id,
    kind: rehearsal ? kind + '_test' : kind,
    suppressed: rehearsal,
    intendedFor: normalizeEmails_(job.customer_email),
    subject: (rehearsal ? '[TEST ' + rehearsalStamp_() + '] ' : '') +
      (full ? 'Payment received, paid in full — ' : 'Payment received — ') +
      SHOP_NAME + ' invoice ' + job.id,
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      intro: intro + lineTable + balanceBox + noteBox + attachNote + linkNote + reviewBlock +
        // On every one of these, review request or not. Deliberately after the
        // review ask rather than before it, so the customer who was not asked
        // is not reading a shorter version of somebody else's email.
        feedbackHtml_(),
      meta: 'INVOICE# ' + job.id + (job.boat_info ? ' · ' + job.boat_info : ''),
      buttons: (review ? button_(review, 'Leave us a Google review', '#C08A22') : '') +
        // Never on a paid-in-full receipt, whatever link is on the job: a Pay
        // button under the words "nothing further owed" is how a customer
        // pays twice.
        (!full && balance !== null && balance > 0.005 && job.payment_link
          ? button_(job.payment_link, 'Pay ' + money_(balance), '#C08A22')
          : '')
    }),
    text: (full
      ? 'Thank you - your payment has been received, and invoice ' + job.id + ' is now paid in full.'
      : 'Thank you - your payment has been received.') +
      '\n\n' + payments.map(function (payment) {
        const when = payDate_(payment.receivedAt);
        return paymentLabel_(payment) + (when ? ' (' + when + ')' : '') + ': ' + money_(payment.amount);
      }).join('\n') +
      '\n' + (payments.length > 1 ? 'Total received' : 'Received') + ': ' + money_(batchTotal) +
      (full ? '\n\nPaid in full - nothing further owed.'
        : (balance === null ? '' : '\n\nBalance remaining: ' + money_(balance) +
          (job.payment_link ? '\nPay online: ' + job.payment_link : ''))) +
      (note ? '\n\n' + note : '') +
      (options.attached && options.attached.length ? '\n\nAttached: ' + options.attached.join(', ') : '') +
      (linked.length ? '\n\nToo large to email, so here to download:\n' +
        linked.map(function (file) { return file.name + ': ' + driveViewUrl_(file.driveFile); }).join('\n') : '') +
      (review ? '\n\nA short Google review helps other boaters find us: ' + review +
        (directReviewLink_(review) ? '' : '\n(Tap "Write a review" on the listing that opens.)') : '') +
      '\n\n' + FEEDBACK_LINE +
      '\n\nInvoice ' + job.id + '\n' + SHOP_NAME,
    attachments: options.attachments || []
  };
}

/**
 * Records money taken against an invoice and, if the writer asked for it,
 * sends the customer their receipt.
 *
 * SEVERAL PAYMENTS AT ONCE is the normal case, not a nicety: a boat is
 * routinely settled with a card at the counter and a check that came in the
 * post, and entering those as two separate actions means two emails to a
 * customer who paid once. They go in together, under one `batch`, and one
 * receipt covers the lot.
 *
 * PAID IN FULL IS THE WRITER'S CALL, not the arithmetic's. The page works out
 * the obvious answer and ticks the box for them, but the shop is allowed to
 * call a ticket settled with eleven cents of rounding left on it, and it is
 * allowed to take a payment that clears the balance on a job it wants to keep
 * open. Only the tick closes a ticket, and only a closed ticket leaves the
 * open-jobs list.
 *
 * Nothing about this sends by itself. `sendEmail` is a separate decision from
 * recording the money, and a writer who is only correcting the books leaves it
 * off.
 */
function recordPayment(token, id, payload) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  // The same gate as the invoice email: a receipt saying what is owed on a
  // finished invoice needs there to be a finished invoice. A parts order IS
  // its finished invoice from the moment it is taken — customers pay for
  // parts up front, at pick-up, or some of each — so it is never gated.
  if (isCancelledOrder_(job)) {
    throw new Error('That order was cancelled. Its refund was recorded when it was cancelled.');
  }
  if (job.status !== 'done' && !isPartsOrder_(job)) {
    throw new Error('Mark the job done first — a payment is recorded against the final invoice.');
  }
  // Both are new with this feature, so until setup() has run the rows would
  // save and read back empty. Say so instead of losing somebody's money.
  requireColumn_('Jobs', 'paid_total');
  requireColumn_('Payments', 'batch');

  const wanted = (payload && payload.payments) || [];
  if (!wanted.length) throw new Error('Add at least one payment.');
  const today = nowIso_().slice(0, 10);

  const lines = wanted.map(function (line) {
    const typed = numberOrNull_(line && line.amount);
    // Zero is allowed: a warranty job, or one the deposits already covered,
    // still has to be closed out, and the record of it is a $0 line.
    if (typed === null || !(typed >= 0)) throw new Error('Every payment needs an amount, and it cannot be negative.');
    const amount = money2_(typed);
    const method = PAYMENT_METHODS.indexOf(String(line.method || '')) === -1
      ? 'other' : String(line.method);
    // A date typed as anything but a plain day is not stored: the receipt
    // formats it as a day, and half a timestamp in that column reads back as
    // a date Sheets has had its own ideas about.
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(line.receivedAt || '')) ? String(line.receivedAt) : today;
    return {
      amount: amount,
      method: method,
      reference: String(line.reference || '').trim().substr(0, 80),
      receivedAt: when,
      note: String(line.note || '').trim().substr(0, 400)
    };
  });

  const batchTotal = money2_(lines.reduce(function (sum, line) { return sum + line.amount; }, 0));
  // A $0 recording only means something as the act of closing the ticket.
  // Without the tick it would add a line to the books and change nothing.
  if (!(batchTotal > 0) && !(payload && payload.paidInFull)) {
    throw new Error('A $0 payment only closes out the invoice — tick that it settles the account in full.');
  }

  // Drive BEFORE the lock, like every other upload path here: one script lock
  // serves the whole shop, and a writer attaching a scanned card receipt must
  // not be everybody else's wait. See saveFile_ and the backend-data notes.
  const uploaded = [];
  ((payload && payload.files) || []).forEach(function (file) {
    if (!file || !file.base64) return;
    const name = String(file.name || '').trim() || 'receipt';
    const fileId = saveFile_(job.id, name, file.mime || 'application/octet-stream', file.base64);
    const row = {
      id: newId_('file'),
      job_id: job.id,
      name: name,
      mime: file.mime || '',
      // Uploaded on the payment form, which is the customer's own receipt
      // going back to them. There is no internal variant of this button —
      // anything the shop wants to keep to itself goes through Attachments,
      // where saying so is the whole of the choice.
      drive_file: fileId,
      visibility: 'customer',
      added_by: SHOP_WRITER_NAME,
      created_at: nowIso_(),
      size: base64Bytes_(file.base64)
    };
    appendRow_('JobFiles', row);
    uploaded.push({ name: name, driveFile: fileId, size: row.size });
  });

  const batch = newId_('pay');
  const saved = withLock_(function () {
    // Re-read inside the lock before adding to the running total, for the
    // same reason addEntry does: the row above was read before the lock, and
    // two writers saving together would both write the same total.
    forget_('Jobs');
    const fresh = jobRow_(job.id);
    if (!fresh) throw new Error('No such job.');

    const at = nowIso_();
    lines.forEach(function (line) {
      appendRow_('Payments', {
        id: newId_('pmt'),
        job_id: fresh.id,
        batch: batch,
        amount: line.amount,
        method: line.method,
        reference: line.reference,
        received_at: line.receivedAt,
        note: line.note,
        recorded_by: SHOP_WRITER_NAME,
        created_at: at
      });
    });

    const paidTotal = money2_((numberOrNull_(fresh.paid_total) || 0) + batchTotal);
    const patch = { paid_total: paidTotal, updated_at: at };
    // The one thing that archives a ticket. Not the arithmetic reaching zero
    // and not the email going out — the writer saying the account is settled.
    if (payload && payload.paidInFull) {
      if (!fresh.paid_at) patch.paid_at = at;
    }
    updateRow_('Jobs', fresh._row, patch);
    return { paidTotal: paidTotal, at: at };
  });

  const after = jobRow_(job.id);
  const balance = jobBalance_(after);
  const paidInFull = Boolean(payload && payload.paidInFull);

  let emailed = null;
  if (payload && payload.sendEmail) {
    if (!normalizeEmails_(after.customer_email)) {
      throw new Error('The payment is recorded, but this job has no customer email address, ' +
        'so there is nobody to send the receipt to.');
    }
    emailed = sendPaymentEmail_(after, {
      payments: paymentsForJob_(after.id).filter(function (p) { return p.batch === batch; }),
      paidInFull: paidInFull,
      balance: balance,
      paidTotal: saved.paidTotal,
      note: payload.note,
      requestReview: Boolean(payload.requestReview),
      files: uploaded
    });
  }

  return {
    job: jobSummary_(after),
    payments: paymentsForJob_(after.id),
    files: filesForJob_(after.id),
    batch: batch,
    recorded: lines.length,
    received: batchTotal,
    balance: balance,
    // The ticket only leaves the open-jobs list when it is paid in full, so
    // the page can say which of the two things just happened.
    archived: Boolean(after.paid_at),
    emailed: emailed,
    testMode: testMode_(),
    sentTo: emailed === null ? '' : (testMode_() ? testEmail_() : normalizeEmails_(after.customer_email)),
    reviewRequested: Boolean(payload && payload.requestReview && reviewUrl_())
  };
}

/**
 * Puts the receipt's attachments together and sends it.
 *
 * What rides along is whatever the writer uploaded on the payment form — the
 * invoice with the payment noted on it, the card receipt — under the same
 * attach-or-link rule as every other customer email. Nothing else on the job
 * is swept in: the invoice email already sent the customer's files, and a
 * receipt that silently re-attaches them is a surprise rather than a service.
 */
function sendPaymentEmail_(job, options) {
  // A parts order's receipt carries its invoice. There is no "service
  // complete" email for an order to have sent it already, and the BiT invoice
  // is the itemised record of what they paid for.
  const blobs = [];
  const names = [];
  let budget = MAIL_ATTACHMENT_BUDGET;
  if (isPartsOrder_(job) && job.invoice_file) {
    try {
      const invoice = DriveApp.getFileById(job.invoice_file).getBlob().setName('Invoice-' + job.id + '.pdf');
      blobs.push(invoice);
      names.push('Invoice-' + job.id + '.pdf');
      budget -= invoice.getBytes().length;
    } catch (err) {
      /* Binned by hand. The receipt still goes. */
    }
  }
  const packed = packAttachments_(budget, options.files || []);
  return send_(paymentEmailContent_(job, {
    payments: options.payments,
    paidInFull: options.paidInFull,
    balance: options.balance,
    paidTotal: options.paidTotal,
    note: options.note,
    requestReview: options.requestReview,
    attachments: blobs.concat(packed.blobs),
    attached: names.concat(packed.attached),
    linked: packed.linked
  }));
}

/**
 * Closes the ticket. Sends nothing.
 *
 * A job may be closed for a customer with no email address on file — plenty
 * of them are walk-ins who take their invoice at the counter — so an address
 * is a requirement of the email, not of finishing the work.
 */
function markDone(token, id, force) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  if (job.status === 'done') {
    throw new Error(isPartsOrder_(job) ? 'That order was already marked picked up.' : 'That job was already marked done.');
  }
  // A split ticket with half of it still open: say so, and close only when
  // the writer says to anyway (the customer took it as it is, say).
  const split = jobDetailSummary_(job);
  if (split && split.waitingOn && !force) {
    return { needsConfirm: true, waitingOn: split.waitingOn,
             message: 'This is a split ticket and ' + ({ mechanic: 'the mechanic has not', detail: 'the detailer has not',
               both: 'neither the mechanic nor the detailer has' })[split.waitingOn] + ' marked their part done yet.' };
  }
  setStatus_(job, 'done', 'service_writer', '', isPartsOrder_(job) ? 'Picked up' : 'Marked done');
  return { job: jobSummary_(jobRow_(id)) };
}

/**
 * A note from the service writer onto the job, for whoever is working it.
 *
 * Written as an entry rather than a field on the job so it lands in the log
 * in the order it was said, alongside what the mechanic found — a note added
 * on Tuesday should not appear to have been there since intake.
 */
/**
 * The red banner on a job: the thing a mechanic must not start work without
 * reading. "Owner is disputing the estimate — do not order the outdrive."
 *
 * Deliberately not the same as a note in the shop log. A note is one line in a
 * feed that a busy mechanic scrolls past; this sits across the top of the job
 * in red until somebody takes it down, and marks the job in the open-jobs list
 * so it is visible before the job is even opened. Because it is that loud, it
 * is meant to be cleared once it has been acted on — a banner that is always
 * there is a banner nobody reads.
 *
 * Setting one also writes it into the shop log, so the record of what was said
 * and when survives the banner being taken down. Clearing does not: the log
 * already has it.
 *
 * Never reaches the customer. It is a Jobs column, and publicJob names the
 * columns it returns one at a time.
 */
function setJobAlert(token, id, text) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const body = String(text || '').trim();

  // rows_ keys every row off the sheet's own header, so a column that setup()
  // has not written yet reads back as undefined — the alert would save and
  // then simply never appear, which is the worst way for this particular
  // feature to fail. Say so instead.
  requireColumn_('Jobs', 'alert');

  updateRow_('Jobs', job._row, {
    alert: body,
    alert_at: body ? nowIso_() : '',
    updated_at: nowIso_()
  });

  if (body) {
    appendRow_('LogEntries', {
      id: newId_('log'),
      job_id: job.id,
      mechanic_id: '',
      mechanic_name: SHOP_WRITER_NAME,
      entry_type: 'writer_note',
      text: 'Alert: ' + body,
      hours: '',
      part_identifier: '',
      quantity: '',
      audio_file: '',
      photos: '',
      transcript_status: '',
      transcript_id: '',
      transcript_error: '',
      notified_at: '',
      created_at: nowIso_()
    });
    bumpJobEntryTotals_(job.id, 0);
  }
  return { job: jobSummary_(jobRow_(id)), entries: entriesForJob_(job.id) };
}

function entryRow_(id) {
  const all = rows_('LogEntries');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].id) === String(id)) return all[i];
  }
  return null;
}

/** The parts list lines a log entry put there, if any. */
function partsFromEntry_(entryId) {
  return rows_('PartsOrders').filter(function (part) {
    return String(part.source_entry) === String(entryId);
  });
}

/**
 * Take an entry off the job.
 *
 * A mechanic logs against the wrong boat, or the same note twice, and the
 * office is the only place that can put it right. This is the writer's tool
 * and nobody else's — a mechanic cannot unsay something the shop has since
 * read and acted on.
 *
 * A part entry that already put a line on the parts list is the one case this
 * refuses. Deleting the entry would leave that line behind with nothing
 * explaining it, or take it away with an order already placed against it —
 * which is exactly what `cancelPartOrder` exists to prevent. A line still
 * only NEEDED goes with the entry, because nothing has happened to it yet;
 * anything ordered or arrived has to be dealt with on the parts list first.
 */
function deleteEntry(token, entryId) {
  requireAdmin_(token);

  return withLock_(function () {
    const entry = entryRow_(entryId);
    if (!entry) throw new Error('No such entry.');

    const lines = partsFromEntry_(entry.id);
    const placed = lines.filter(function (part) { return part.status !== 'needed'; });
    if (placed.length) {
      throw new Error('That entry put a part on order (' +
        placed.map(function (p) { return p.part_identifier || p.description || 'a part'; }).join(', ') +
        '). Take it off the parts list first, then delete this.');
    }

    const jobId = entry.job_id;
    const minutes = entry.entry_type === 'labor' && entry.hours ? minutesFromHours_(entry.hours) : 0;

    // Highest row first, the same rule the parts delete follows: taking out
    // row 4 shifts row 5 up into its place.
    const partsSheet = sheet_('PartsOrders');
    lines.map(function (part) { return part._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (rowNumber) { partsSheet.deleteRow(rowNumber); });
    if (lines.length) forget_('PartsOrders');

    sheet_('LogEntries').deleteRow(entry._row);
    // deleteRow goes round appendRow_/updateRow_, so it forgets the memoised
    // rows itself or every read after this is a lie.
    forget_('LogEntries');

    adjustJobEntryTotals_(jobId, -1, -minutes, true);
    return { jobId: jobId, removedParts: lines.length };
  });
}

/**
 * Put an entry on the job it belonged to.
 *
 * Scanning the wrong work order off a bench with three of them on it is the
 * ordinary way this happens, and the note is usually right — it is just
 * filed against the wrong boat. Moving beats deleting and re-typing:
 * whatever the mechanic said, the photos they took and the time they logged
 * all travel, and the hours land on the invoice they belong to.
 *
 * The target is given the way a work order is read: the number off the paper.
 * `01-8886`, `018886` and `8886` all find it, and a suffix that matches two
 * jobs finds neither.
 *
 * Both jobs' running totals move, which is the whole reason this cannot be a
 * hand edit in the Sheet. Any parts-list line the entry created goes with it,
 * or it would sit on the wrong customer's order.
 *
 * The photos and the recording stay in the original job's Drive folder. The
 * links keep working — the folder is link-shared and the entry carries the
 * file ids — and moving files between folders is several slow Drive calls for
 * a tidiness nobody sees.
 */
function moveEntry(token, entryId, toJob) {
  requireAdmin_(token);

  return withLock_(function () {
    const entry = entryRow_(entryId);
    if (!entry) throw new Error('No such entry.');

    const target = jobRow_(String(toJob || '').trim().toUpperCase()) || jobByNumber_(toJob);
    if (!target) throw new Error('No job found for that number. Check it against the work order.');
    if (String(target.id) === String(entry.job_id)) {
      throw new Error('That entry is already on ' + target.id + '.');
    }

    const from = entry.job_id;
    const minutes = entry.entry_type === 'labor' && entry.hours ? minutesFromHours_(entry.hours) : 0;

    // The files stay put for now and a nightly job walks them over. Moving
    // Drive files is several slow calls each, and this runs while somebody is
    // waiting at a counter — `files_job` remembers where they actually are
    // until 2am. Already stamped means the entry has been moved twice since
    // the last sweep, and the stamp still points at the folder holding them;
    // moved back to that folder and there is nothing left to do.
    const patch = { job_id: target.id };
    if (entry.audio_file || entry.photos) {
      const filesAt = entry.files_job || from;
      patch.files_job = String(filesAt) === String(target.id) ? '' : filesAt;
    }
    updateRow_('LogEntries', entry._row, patch);
    partsFromEntry_(entry.id).forEach(function (part) {
      updateRow_('PartsOrders', part._row, { job_id: target.id });
    });

    adjustJobEntryTotals_(from, -1, -minutes, true);
    adjustJobEntryTotals_(target.id, 1, minutes, true);
    return { from: from, to: target.id };
  });
}

function addWriterNote(token, id, text) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Write the note first.');

  const entry = {
    id: newId_('log'),
    job_id: job.id,
    mechanic_id: '',
    mechanic_name: SHOP_WRITER_NAME,
    entry_type: 'writer_note',
    text: body,
    hours: '',
    part_identifier: '',
    quantity: '',
    audio_file: '',
    photos: '',
    transcript_status: '',
    transcript_id: '',
    transcript_error: '',
    notified_at: '',
    created_at: nowIso_()
  };
  appendRow_('LogEntries', entry);
  bumpJobEntryTotals_(job.id, 0);
  return { entry: entryView_(entry), entries: entriesForJob_(job.id) };
}

/**
 * The one thing a customer ever receives, and only because a writer pressed
 * the button. Sendable more than once on purpose: an address gets corrected,
 * or Gmail drops a message, and the fix is to send it again.
 */
/**
 * The three customer emails a writer sends from a job or an order page, each
 * with what has to be true before it may go. One place, because the preview
 * and the send must agree: a preview of an email the send would refuse, or
 * one built differently from what goes, is worse than none.
 *
 *   invoice  — a finished work order: the work is done, here is the bill.
 *   arrival  — a parts order that has come in.
 *   receipt  — a parts order's receipt; on a cancelled one, its settlement.
 */
function customerEmailContent_(job, kind, staff, preview) {
  if (kind === 'invoice') {
    // "The work you requested has been done" is not something to tell a
    // customer who bought a part. An order goes out as its arrival notice and
    // its receipt, which carries the invoice.
    if (isPartsOrder_(job)) throw new Error('A parts order is not sent the service invoice — use the arrival email or the receipt.');
    if (job.status !== 'done') throw new Error('That job is not marked done yet.');
    if (!normalizeEmails_(job.customer_email)) {
      throw new Error('This job has no customer email address, so there is nobody to send the invoice to.');
    }
    return withStaffNote_(invoiceEmailContent_(job, preview), staffNote_(staff));
  }
  if (!isPartsOrder_(job)) throw new Error('That is a work order, not a parts order.');
  if (kind === 'arrival') {
    if (isCancelledOrder_(job)) throw new Error('That order was cancelled.');
    if (!orderArrived_(job)) throw new Error('Mark the order arrived first.');
    if (!normalizeEmails_(job.customer_email)) {
      throw new Error('This order has no customer email address, so there is nobody to tell.');
    }
    return withStaffNote_(arrivalEmailContent_(job), staffNote_(staff));
  }
  if (kind === 'receipt') {
    // A cancelled order still takes a receipt: it is the one that says the
    // account is settled and carries the refund receipts.
    if (!normalizeEmails_(job.customer_email)) {
      throw new Error('This order has no customer email address, so there is nobody to send the receipt to.');
    }
    return withStaffNote_(orderReceiptContent_(job, preview), staffNote_(staff));
  }
  throw new Error('Unknown email.');
}

/** Sends one of those, and says where it went. */
function sendCustomerEmail_(token, id, kind, staff) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error(kind === 'invoice' ? 'No such job.' : 'No such order.');
  return {
    emailed: send_(customerEmailContent_(job, kind, staff, false)),
    testMode: testMode_(),
    sentTo: testMode_() ? testEmail_() : normalizeEmails_(job.customer_email)
  };
}

/**
 * What one of those would look like, sent now, with the writer's note in it.
 * Builds the same email the send does — same rules, same wording, same
 * attachment decisions — and sends nothing. Files are not downloaded for it:
 * what gets attached is decided on their recorded sizes, as the send does.
 *
 * The logo travels inside a sent email as an inline image; in a preview it
 * is the public copy the shop already serves, so the page shows what the
 * customer will.
 */
function previewCustomerEmail(token, id, kind, staff) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const content = customerEmailContent_(job, kind, staff, true);
  return {
    to: content.to,
    cc: content.cc || '',
    subject: content.subject,
    html: content.html.split('cid:questlogo').join(LOGO_URL),
    testMode: testMode_(),
    intendedFor: content.intendedFor || ''
  };
}

function sendInvoiceEmail(token, id, staff) {
  return sendCustomerEmail_(token, id, 'invoice', staff);
}

/**
 * What has been paid on an order so far: the deposits BiT shows on the
 * invoice, plus anything recorded here since. A parts order is very often
 * paid in full at the counter, and BiT prints that payment as a deposit.
 */
/**
 * How a cancelled order came out: what they paid, what went back, and what
 * the shop kept. Reads the order's payments for the refund rows.
 */
function orderSettlement_(job) {
  const refunded = money2_(-paymentsForJob_(job.id)
    .filter(function (payment) { return payment.refund; })
    .reduce(function (sum, payment) { return sum + payment.amount; }, 0));
  const kept = Math.max(0, orderPaid_(job));
  return { paid: money2_(kept + refunded), refunded: refunded, kept: money2_(kept), keptFor: job.cancel_note || '' };
}

function orderPaid_(job) {
  return money2_((numberOrNull_(job.deposits) || 0) + (numberOrNull_(job.paid_total) || 0));
}

/** Where an order is, in the words a customer is told. */
function orderStageWords_(job) {
  if (job.status === 'done') return 'has been collected';
  if (orderArrived_(job)) return 'has arrived and is ready for pick-up';
  return 'is on order';
}

/**
 * The receipt for a parts order: what they bought, what they have paid, and
 * where the order stands — usually "on order", because this is what a
 * customer who paid up front wants in hand the day they pay.
 *
 * Not the payment receipt (sendPaymentEmail_), which is about one payment
 * being recorded and says nothing of the parts. Recording a payment is not
 * needed first: an order paid at the counter in BiT arrives here with the
 * payment already on the invoice as a deposit. A writer's button, like every
 * other send.
 */
function sendOrderReceipt(token, id, staff) {
  return sendCustomerEmail_(token, id, 'receipt', staff);
}

function orderReceiptContent_(job, preview) {
  const rehearsal = testMode_();
  const due = jobBalance_(job);
  const owed = due !== null && !settled_(due);
  const paid = orderPaid_(job);
  const first = String(job.customer_name || '').split(' ')[0];
  const items = String(job.work_requested || '').split('\n')
    .map(function (line) { return line.trim(); }).filter(String);
  const stage = orderStageWords_(job);
  const onOrder = stage === 'is on order';
  const cancelled = isCancelledOrder_(job);
  const settlement = cancelled ? orderSettlement_(job) : null;

  const banner = rehearsal
    ? mailBox_('#FBEEE2', '#E4B48F',
      '<div style="' + MAIL_FONT + ';font-size:14px;line-height:21px;color:#A6541F">' +
        '<b>TEST MODE &mdash; not sent to the customer.</b><br>This is what ' +
        esc_(normalizeEmails_(job.customer_email)) + ' would have received for order ' + esc_(job.id) + '.' +
        '<br>Generated ' + esc_(rehearsalStamp_()) + '.</div>',
      ';border-left:4px solid #A6541F')
    : '';

  const itemBox = items.length ? mailBox_('#FDFCF7', '#C7D5E0',
    '<div style="' + MAIL_FONT + ';font-size:13px;line-height:19px;color:#5C7185;margin-bottom:4px">' +
      'Your order</div>' +
    items.map(function (line) {
      return '<div style="' + MAIL_FONT + ';font-size:14.5px;line-height:22px;color:#14293E">' + esc_(line) + '</div>';
    }).join('')) : '';

  const cell = 'padding:3px 0;color:#5C7185;font-size:13px;line-height:19px';
  const row = function (label, value) {
    return '<tr><td style="' + MAIL_FONT + ';' + cell + '">' + esc_(label) + '</td>' +
      '<td align="right" style="' + MAIL_FONT + ';' + cell + '">' + value + '</td></tr>';
  };
  // A cancelled order: paid, refunded, kept and what for, and the line that
  // matters — nothing owed.
  const money = cancelled ? mailBox_('#FDFCF7', '#C7D5E0',
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
      (settlement.paid ? row('Paid', money_(settlement.paid)) : '') +
      (settlement.refunded ? row('Refunded to you', '&minus;' + money_(settlement.refunded)) : '') +
      (settlement.kept ? row('Kept' + (settlement.keptFor ? ' for ' + settlement.keptFor : ''), money_(settlement.kept)) : '') +
      '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;font-size:15px;line-height:23px">' +
        'Nothing owed</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
        'font-size:17px;line-height:24px">' + money_(0) + '</td></tr>' +
    '</table>') : mailBox_('#FDFCF7', '#C7D5E0',
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
      (paid ? '<tr><td style="' + MAIL_FONT + ';' + cell + '">Paid</td>' +
        '<td align="right" style="' + MAIL_FONT + ';' + cell + '">' + money_(paid) + '</td></tr>' : '') +
      '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;font-size:15px;line-height:23px">' +
        (owed ? 'Left to pay' : 'Paid in full') + '</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
        'font-size:17px;line-height:24px">' + money_(owed ? due : 0) + '</td></tr>' +
    '</table>');

  // The invoice is the itemised record of what they paid for, so it goes
  // with every receipt for an order — and then whatever the writer marked
  // for the customer, the refund receipts among them, under the same
  // attach-or-link rule as the invoice email.
  const attachments = [];
  const attachedNames = [];
  let budget = MAIL_ATTACHMENT_BUDGET;
  if (job.invoice_file && preview) {
    attachedNames.push('Invoice-' + job.id + '.pdf');
  } else if (job.invoice_file) {
    try {
      const invoice = DriveApp.getFileById(job.invoice_file).getBlob().setName('Invoice-' + job.id + '.pdf');
      attachments.push(invoice);
      attachedNames.push('Invoice-' + job.id + '.pdf');
      budget -= invoice.getBytes().length;
    } catch (err) {
      /* Binned by hand. The receipt still goes. */
    }
  }
  const packed = packAttachments_(budget, filesForJob_(job.id).filter(function (file) {
    return file.visibility === 'customer';
  }), preview);
  packed.blobs.forEach(function (blob) { attachments.push(blob); });
  const named = attachedNames.concat(packed.attached);
  const attachNote = (named.length ? '<div style="' + MAIL_FONT + ';margin-top:8px">Attached: ' +
      named.map(esc_).join(', ') + '.</div>' : '') +
    (packed.linked.length ? '<div style="' + MAIL_FONT + ';margin-top:8px">' +
      (packed.linked.length === 1 ? 'This is too large to email, so it is here to download:'
        : 'These are too large to email, so they are here to download:') +
      '<br>' + linkListHtml_(packed.linked) + '</div>' : '');

  const intro = cancelled
    ? 'Your order has been cancelled and your account is settled &mdash; nothing further is owed.' +
      (settlement.refunded ? ' ' + money_(settlement.refunded) + ' has been refunded to you.' : '')
    : (owed ? 'Thank you for your order.' : 'Thank you &mdash; your order is paid in full.') +
      ' It ' + esc_(stage) + '.' +
      (onOrder ? ' We will let you know as soon as it arrives.' : '');

  const to = rehearsal ? testEmail_() : normalizeEmails_(job.customer_email);
  return {
    to: to,
    cc: shopCc_(to),
    jobId: job.id,
    kind: rehearsal ? 'customer_order_receipt_test' : 'customer_order_receipt',
    suppressed: rehearsal,
    intendedFor: normalizeEmails_(job.customer_email),
    subject: (rehearsal ? '[TEST ' + rehearsalStamp_() + '] ' : '') +
      (cancelled ? 'Order cancelled, all settled — ' : owed ? 'Your order — ' : 'Paid receipt — ') +
      SHOP_NAME + ' invoice ' + job.id,
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      intro: intro + itemBox + money + attachNote,
      meta: 'INVOICE# ' + job.id,
      buttons: !cancelled && owed && job.payment_link ? button_(job.payment_link, 'Pay ' + money_(due), '#C08A22') : ''
    }),
    text: (cancelled
      ? 'Your order has been cancelled and your account is settled - nothing further is owed.' +
        (items.length ? '\n\n' + items.join('\n') : '') +
        (settlement.paid ? '\n\nPaid: ' + money_(settlement.paid) : '') +
        (settlement.refunded ? '\nRefunded to you: -' + money_(settlement.refunded) : '') +
        (settlement.kept ? '\nKept' + (settlement.keptFor ? ' for ' + settlement.keptFor : '') + ': ' + money_(settlement.kept) : '') +
        '\nNothing owed.'
      : (owed ? 'Thank you for your order.' : 'Thank you - your order is paid in full.') +
        ' It ' + stage + '.' + (onOrder ? ' We will let you know as soon as it arrives.' : '') +
        (items.length ? '\n\n' + items.join('\n') : '') +
        (paid ? '\n\nPaid: ' + money_(paid) : '') +
        (owed ? '\nLeft to pay: ' + money_(due) : '\nPaid in full.') +
        (owed && job.payment_link ? '\nPay online: ' + job.payment_link : '')) +
      (named.length ? '\n\nAttached: ' + named.join(', ') : '') +
      (packed.linked.length ? '\n\nToo large to email, so here to download:\n' +
        packed.linked.map(function (file) { return file.name + ': ' + driveViewUrl_(file.driveFile); }).join('\n') : '') +
      '\n\nInvoice ' + job.id + '\n' + SHOP_NAME + ' · ' + SHOP_PHONE,
    attachments: attachments
  };
}

/** An order that has come in — still waiting, or already collected. */
function orderArrived_(job) {
  return isPartsOrder_(job) && (job.status === 'work_finished' || job.status === 'done');
}

/**
 * "Your order is in." The one email a parts order has that a work order does
 * not, and like every other send here it is a writer pressing a button:
 * marking the order arrived posts nothing.
 *
 * What it says is what is wanted at the counter — what came in, that it is
 * ready, where to collect it and what is left to pay. The balance is the
 * balance, never the grand total, and a Pay button only when something is
 * owed and there is a link to pay it with.
 */
function sendArrivalEmail(token, id, staff) {
  return sendCustomerEmail_(token, id, 'arrival', staff);
}

function arrivalEmailContent_(job) {
  const rehearsal = testMode_();
  const due = jobBalance_(job);
  const owed = due !== null && !settled_(due);
  const first = String(job.customer_name || '').split(' ')[0];
  const items = String(job.work_requested || '').split('\n')
    .map(function (line) { return line.trim(); }).filter(String);

  const banner = rehearsal
    ? mailBox_('#FBEEE2', '#E4B48F',
      '<div style="' + MAIL_FONT + ';font-size:14px;line-height:21px;color:#A6541F">' +
        '<b>TEST MODE &mdash; not sent to the customer.</b><br>This is what ' +
        esc_(normalizeEmails_(job.customer_email)) + ' would have received for order ' + esc_(job.id) + '.' +
        '<br>Generated ' + esc_(rehearsalStamp_()) + '.</div>',
      ';border-left:4px solid #A6541F')
    : '';

  const itemBox = items.length ? mailBox_('#FDFCF7', '#C7D5E0',
    '<div style="' + MAIL_FONT + ';font-size:13px;line-height:19px;color:#5C7185;margin-bottom:4px">' +
      'What came in</div>' +
    items.map(function (line) {
      return '<div style="' + MAIL_FONT + ';font-size:14.5px;line-height:22px;color:#14293E">' + esc_(line) + '</div>';
    }).join('')) : '';

  const balance = due === null ? '' : mailBox_('#FDFCF7', '#C7D5E0',
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;font-size:15px;line-height:23px">' +
        (owed ? 'Left to pay' : 'Paid in full') + '</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
        'font-size:17px;line-height:24px">' + money_(owed ? due : 0) + '</td>' +
    '</tr></table>');

  const to = rehearsal ? testEmail_() : normalizeEmails_(job.customer_email);
  const intro = 'Good news &mdash; your order has arrived and is ready for pick-up at ' +
    esc_(SHOP_ADDRESS) + '.' +
    (owed ? (job.payment_link ? ' You can pay the balance online with the button below, or when you collect it.'
      : ' The balance can be paid when you collect it.') : ' It is all paid for, so just come and get it.');

  return {
    to: to,
    cc: shopCc_(to),
    jobId: job.id,
    kind: rehearsal ? 'customer_arrived_test' : 'customer_arrived',
    suppressed: rehearsal,
    intendedFor: normalizeEmails_(job.customer_email),
    subject: (rehearsal ? '[TEST ' + rehearsalStamp_() + '] ' : '') +
      'Your order has arrived — ' + SHOP_NAME + ' invoice ' + job.id,
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      intro: intro + itemBox + balance,
      meta: 'INVOICE# ' + job.id,
      buttons: owed && job.payment_link ? button_(job.payment_link, 'Pay ' + money_(due), '#C08A22') : ''
    }),
    text: 'Your order has arrived and is ready for pick-up at ' + SHOP_ADDRESS + '.' +
      (items.length ? '\n\n' + items.join('\n') : '') +
      (due === null ? '' : (owed ? '\n\nLeft to pay: ' + money_(due) : '\n\nPaid in full.')) +
      (owed && job.payment_link ? '\nPay online: ' + job.payment_link : '') +
      '\n\nInvoice ' + job.id + '\n' + SHOP_NAME + ' · ' + SHOP_PHONE
  };
}

/* ========================= the invoice by text ========================= */

/**
 * BiT can text a customer; this app cannot, and must not try to.
 *
 * Plenty of customers here never give an email address — they give a phone
 * number at the counter and that is the whole of it. So the shop needs the
 * same thing the invoice email says, in a form a writer can send from BiT:
 * a short message and a link to a page that carries the invoice, the balance
 * and the payment button.
 *
 * The app composes the message and mints the code. A person copies it into
 * BiT and presses send there — exactly like every other exchange with BiT,
 * and for the same reason. Nothing here dials out.
 */

/**
 * Anything outside plain ASCII, spelled the way a phone can carry it.
 *
 * Not fussiness. A text made only of GSM-7 characters fits 160 to a segment;
 * ONE character outside that set — a curly apostrophe pasted from a document,
 * an em dash, an accented name — switches the whole message to UCS-2, where a
 * segment holds 70. A message that reads fine here silently becomes three
 * texts on the shop's bill and arrives in pieces on an old handset.
 *
 * So the message is kept to ASCII, and the substitutions are made here rather
 * than by never typing the characters — the wording will be edited one day by
 * somebody who has no idea this matters.
 */
const SMS_SUBSTITUTIONS = [
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/[\u2013\u2014]/g, '-'],
  [/\u2026/g, '...'],
  [/\u00A0/g, ' ']
];

function gsmSafe_(text) {
  let out = String(text == null ? '' : text);
  SMS_SUBSTITUTIONS.forEach(function (pair) { out = out.replace(pair[0], pair[1]); });
  // Whatever is left that a GSM-7 alphabet cannot carry. Dropped rather than
  // guessed at: a mangled word is easier to spot and fix than a message that
  // quietly costs three segments.
  return out.replace(/[^\x20-\x7E\n]/g, '');
}

/** 160 characters in one text, and 153 each once it has to be split. */
function textSegments_(message) {
  const length = String(message || '').length;
  if (!length) return 0;
  return length <= 160 ? 1 : Math.ceil(length / 153);
}

/**
 * What the writer pastes into BiT.
 *
 * Short on purpose — everything that needs saying at length is on the page
 * the link opens. What has to survive the trip is who it is from, which
 * invoice it is about, what is owed, and where to go.
 *
 * The balance is the balance, never the grand total, for the same reason the
 * email never puts the grand total next to a Pay button: deposits are normal
 * here, and a customer who has already paid most of it must not be asked for
 * the lot.
 */
function invoiceTextMessage_(job, code, purpose) {
  return gsmSafe_(invoiceTextBody_(job, code, purpose) + '\n' + SMS_FOOTER);
}

/**
 * The last line of every text. The texts go out from a phone number nobody
 * watches for replies, so a customer who answers one would be talking to
 * nobody; this says where to go instead. It pushes every message to two
 * segments, which the shop asked for knowingly — the count in the portal
 * shows it.
 */
const SMS_FOOTER = 'Please note: This inbox is not regularly monitored. Please call ' + SHOP_PHONE +
  ' or email ' + SERVICE_EMAIL + ' if you have any questions.';

function invoiceTextBody_(job, code, purpose) {
  const due = jobBalance_(job);
  const owed = due === null || settled_(due) ? '' : money_(due);
  // A parts order's receipt, sent the day it is paid for: what it is for,
  // that it is paid, and that the parts are coming. One segment.
  if (isCancelledOrder_(job)) {
    const back = orderSettlement_(job).refunded;
    return gsmSafe_(
      SHOP_NAME + ': order ' + job.id + ' is cancelled and settled.' +
      (back ? ' ' + money_(back) + ' refunded, nothing owed.' : ' Nothing owed.') +
      ' Receipts: ' + invoiceUrl_(code));
  }
  if (isPartsOrder_(job) && purpose === 'receipt') {
    const onOrder = !orderArrived_(job);
    return gsmSafe_(
      SHOP_NAME + ': order ' + job.id + (owed ? ', ' + owed + ' due.' : ' paid in full, thanks.') +
      (onOrder ? " Parts on order, we'll text when in." : '') +
      ' Receipt: ' + invoiceUrl_(code));
  }
  // A parts order is texted when it arrives, and that is the news: it is in
  // and can be collected. Same link, same balance rule, one segment.
  if (isPartsOrder_(job)) {
    return gsmSafe_(
      SHOP_NAME + ': your order is ready for pick-up. Invoice ' + job.id +
      (owed ? ', ' + owed + ' due' : '') + '. ' +
      (owed && job.payment_link ? 'Pay here: ' : 'Details: ') +
      invoiceUrl_(code));
  }
  return gsmSafe_(
    SHOP_NAME + ': your service is complete. Invoice ' + job.id +
    (owed ? ', ' + owed + ' due' : '') + '. ' +
    (owed && job.payment_link ? 'View it and pay here: ' : 'View it here: ') +
    invoiceUrl_(code));
}

/**
 * The text for a finished job: the message, the link, and what it will cost
 * to send.
 *
 * Asking for it mints the code, and that is the only thing that ever does.
 * Nothing is sent and nothing is logged — the writer has not sent anything
 * yet, and a job whose text was prepared and never sent must not read as one
 * the customer has heard from. markInvoiceTexted is that second, separate
 * act, exactly like the email's own button.
 */
function invoiceText(token, id, purpose) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  // A parts order has two texts: its receipt, any time, and its arrival
  // notice, once it is in. A work order has the one.
  purpose = isPartsOrder_(job) && purpose === 'receipt' ? 'receipt' : 'invoice';
  // A cancelled order has one text left to send: that it is settled.
  if (isCancelledOrder_(job) && purpose !== 'receipt') throw new Error('That order was cancelled.');
  if (isPartsOrder_(job)) {
    if (purpose !== 'receipt' && !orderArrived_(job)) {
      throw new Error('Mark the order arrived first — the text tells them it is ready.');
    }
  } else if (job.status !== 'done') {
    throw new Error('That job is not marked done yet.');
  }
  const code = invoiceCodeFor_(job);
  const message = invoiceTextMessage_(job, code, purpose);
  return {
    code: code,
    url: invoiceUrl_(code),
    message: message,
    characters: message.length,
    segments: textSegments_(message),
    phone: job.customer_phone || ''
  };
}

/**
 * The writer has sent it from BiT. Recorded on the same log as the mail, so
 * the job page can say what this customer has been sent without caring which
 * door it went out of.
 *
 * Taken on trust, because it has to be: the sending happens in another
 * program, and the alternative — inferring it from the copy button — would
 * mark a job texted because somebody looked at the wording.
 */
function markInvoiceTexted(token, id, purpose) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const code = invoiceCodeFor_(job);
  // Its own kind for an order, so the page can tell "told them it is in"
  // apart from anything else that went to the same number.
  const order = isPartsOrder_(job);
  const receipt = order && purpose === 'receipt';
  logEmail_(job.id, receipt ? 'customer_receipt_text' : order ? 'customer_arrived_text' : 'customer_text',
    job.customer_phone || '(no number on file)',
    receipt ? (isCancelledOrder_(job) ? 'Settlement text sent from BiT' : 'Receipt text sent from BiT')
      : order ? 'Arrival text sent from BiT' : 'Invoice text sent from BiT',
    'sent', '');
  return { code: code, url: invoiceUrl_(code) };
}

/**
 * What the texted page is allowed to show. The public door, and the code in
 * the URL is the whole of the credential.
 *
 * It returns NO log entries, at any status — not filtered ones, none. The
 * customer page's filter (customerView_) exists because that page shows a
 * job's log; this one shows an invoice, and the safest way to keep hours,
 * part numbers, internal notes and mechanic names off it is to never put a
 * log entry within reach of it. Fields are named one at a time here for the
 * same reason publicJob names them: a row spread into the payload would carry
 * the shop's alert out of the building.
 *
 * Deliberately NOT gated on TEST_MODE or the customer-tracking switch. Both
 * exist to stop this app sending something to a customer by itself, and this
 * page sends nothing — a person pressed send, in BiT, having read the message
 * first. A rehearsal that cannot open the page it is rehearsing is no
 * rehearsal, and a live link that goes dark because a switch was flipped is
 * the one failure a customer actually notices.
 */
function invoicePage(code) {
  // The one page a texted customer waits on. Both tabs it reads in one trip;
  // like every prefetch_, it fails safe to the per-tab reads.
  prefetch_(['Jobs', 'JobFiles', 'Payments']);
  const job = jobByInvoiceCode_(code);
  const shop = { name: SHOP_NAME, phone: SHOP_PHONE, email: SERVICE_EMAIL, address: SHOP_ADDRESS };
  // The same answer for a code that never existed and a code on a job that is
  // not finished: nothing to be learned by trying codes. A parts order is
  // live from the start: it is already an invoice, and its receipt text is
  // sent the day it is paid for. The page says where it is.
  const order = isPartsOrder_(job);
  if (!job || !(job.status === 'done' || order)) return { notFound: true, shop: shop };

  const due = jobBalance_(job);
  return {
    invoice: {
      id: job.id,
      // "Jane", not "Jane Rivers" — it is a greeting, not a record.
      firstName: String(job.customer_name || '').split(' ')[0],
      unit: job.boat_info || '',
      doneAt: job.done_at || '',
      // Their own balance off their own invoice. Never the grand total: see
      // invoiceTextMessage_.
      amountDue: due,
      settled: settled_(due),
      deposits: numberOrNull_(job.deposits),
      paidTotal: money2_(numberOrNull_(job.paid_total) || 0),
      paymentLink: job.payment_link || '',
      invoiceFile: job.invoice_file || '',
      // Worded as an order on the page: "ready for pick-up", not "service
      // complete". pickedUp says it has already been collected.
      order: order,
      pickedUp: order && job.status === 'done',
      arrived: order && orderArrived_(job),
      // A link already in a customer's phone keeps answering: it says the
      // order was cancelled, and shows nothing to pay.
      cancelled: isCancelledOrder_(job),
      // How a cancelled order came out: paid, refunded, kept and what for.
      settlement: isCancelledOrder_(job) ? orderSettlement_(job) : null,
      // What has gone in so far, so a receipt can say "paid" with a figure.
      paidSoFar: order ? orderPaid_(job) : null
    },
    // The same files the invoice email would carry, decided the same way:
    // whatever the writer marked for the customer when they added it.
    files: filesForJob_(job.id)
      .filter(function (file) { return file.visibility === 'customer'; })
      .map(function (file) { return { name: file.name, driveFile: file.driveFile }; }),
    shop: shop
  };
}

/**
 * A one-page account summary: every open invoice for this customer, what is
 * owed on each, and the total. The only PDF this backend ever builds instead
 * of just storing — there is no BiT document that shows several jobs' worth
 * of balance at once, so the browser has nothing existing to hand up here.
 * Built from markup rather than parsed from anything, which is a different
 * thing from the "never opens a PDF" rule: nothing is being read, only
 * written.
 */
function statementPdf_(group) {
  const rows = group.invoices.map(function (inv) {
    return '<tr>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #C7D5E0">' + esc_(inv.id) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #C7D5E0">' + esc_(inv.boatInfo) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #C7D5E0;text-align:right">' + esc_(money_(inv.amountDue)) + '</td>' +
    '</tr>';
  }).join('');

  const html = '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1D2B38;font-size:13px;padding:24px">' +
    '<div style="font-size:20px;font-weight:bold;color:#14293E">' + esc_(SHOP_NAME) + '</div>' +
    '<div style="color:#5C7185;margin-bottom:18px">' + esc_(SHOP_ADDRESS) + ' &middot; ' + esc_(SHOP_PHONE) + '</div>' +
    '<div style="font-size:16px;font-weight:bold;color:#14293E">Statement of account</div>' +
    '<div style="color:#5C7185;margin-bottom:16px">' +
      esc_(group.customerName || group.customerEmail) + ' &middot; ' +
      esc_(Utilities.formatDate(new Date(), 'America/Chicago', 'MMM d, yyyy')) + '</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
      '<tr>' +
        '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #14293E">Invoice #</th>' +
        '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #14293E">Description</th>' +
        '<th style="text-align:right;padding:6px 10px;border-bottom:2px solid #14293E">Amount due</th>' +
      '</tr>' + rows +
      '<tr><td colspan="2" style="padding:10px;text-align:right;font-weight:bold">Total due</td>' +
        '<td style="padding:10px;text-align:right;font-weight:bold">' + esc_(money_(group.totalDue)) + '</td></tr>' +
    '</table>' +
  '</body></html>';

  const tag = String(group.customerName || group.customerEmail).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'customer';
  return HtmlService.createHtmlOutput(html).getAs('application/pdf').setName('Statement-' + tag + '.pdf');
}

/**
 * The statement email: one line per open invoice, the summary PDF above and
 * every underlying BiT invoice attached alongside it, and language that
 * checks in rather than chases — a customer who has already paid is far more
 * likely than the shop having lost a boat over a payment link.
 *
 * Never carries an individual job's payment_link. A statement can straddle
 * several jobs and no single one's link is right for all of them, so it
 * always points at the shop's own payment page instead.
 *
 * `followup` only changes the subject and the opening line — everything
 * else about a follow-up is identical to a first statement, recomputed the
 * same way and carrying the same attachments, because it is the same
 * request said again, not a different email.
 */
/**
 * Just the subject, HTML and text of a statement email — no attachments, no
 * Drive access, no send. Split out from sendCustomerStatementMail_ so a
 * preview can build the exact words a customer would read without touching
 * Gmail, and so it can run against a group of invoices that are not real
 * jobs yet — the "Create new statement" wizard, before anything is
 * backfilled. `linked` is the "too large to attach" note; the wizard has no
 * way to know a PDF's real size before the job exists, so it is always
 * empty there, and the preview simply says nothing about it rather than
 * guessing.
 */
function statementEmailContent_(group, followup, linked) {
  const rehearsal = testMode_();
  const plural = group.invoices.length > 1;

  const linkList = (linked || []).map(function (file) {
    return '<a href="' + driveViewUrl_(file.driveFile) + '" style="color:#1F5C8B">Invoice ' + esc_(file.id) + '</a>';
  }).join('<br>');

  const lineRows = group.invoices.map(function (inv) {
    return '<tr>' +
      '<td style="' + MAIL_FONT + ';padding:4px 10px 4px 0;color:#1D2B38;font-size:14px">' + esc_(inv.id) +
        (inv.boatInfo ? ' <span style="color:#5C7185">&middot; ' + esc_(inv.boatInfo) + '</span>' : '') + '</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;color:#1D2B38;font-size:14px;white-space:nowrap">' +
        money_(inv.amountDue) + '</td></tr>';
  }).join('');
  const lineTable = '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">' +
    lineRows + '</table>';

  const totalBox = mailBox_('#FDFCF7', '#C7D5E0',
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' +
      '<tr><td style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;font-size:15px;line-height:23px">' +
        'Total balance</td>' +
      '<td align="right" style="' + MAIL_FONT + ';padding:4px 0;font-weight:bold;color:#14293E;' +
        'font-size:17px;line-height:24px">' + money_(group.totalDue) + '</td></tr></table>');

  const banner = rehearsal
    ? mailBox_('#FBEEE2', '#E4B48F',
      '<div style="' + MAIL_FONT + ';font-size:14px;line-height:21px;color:#A6541F">' +
        '<b>TEST MODE &mdash; not sent to the customer.</b><br>This is what ' +
        esc_(group.customerEmail) + ' would have received.' +
        '<br>Generated ' + esc_(rehearsalStamp_()) + '.</div>',
      ';border-left:4px solid #A6541F')
    : '';

  const to = rehearsal ? testEmail_() : normalizeEmails_(group.customerEmail);
  const first = String(group.customerName || '').split(' ')[0];

  return {
    to: to,
    cc: shopCc_(to),
    kind: rehearsal ? 'statement_test' : 'statement',
    suppressed: rehearsal,
    intendedFor: group.customerEmail,
    subject: (rehearsal ? '[TEST ' + rehearsalStamp_() + '] ' : '') +
      (followup ? 'Following up on your account with ' + SHOP_NAME : 'A note about your account with ' + SHOP_NAME),
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      intro: (followup
        ? 'Just following up on the invoice' + (plural ? 's' : '') + ' below, which ' +
          (plural ? 'still show' : 'still shows') + ' an open balance.'
        : 'While going through our records, we noticed the invoice' + (plural ? 's' : '') + ' below ' +
          (plural ? 'still show' : 'still shows') + ' an open balance, and wanted to check in — it is entirely ' +
          'possible something slipped past us on our end.') + lineTable + totalBox +
        '<div style="' + MAIL_FONT + ';margin-top:14px">If you have already taken care of ' +
        (plural ? 'one or more of these' : 'this') + ', please let us know — it is possible we simply missed ' +
        'recording the payment, though that would be unusual on our part. If you have not had a chance yet, ' +
        'you can settle your balance any time using the button below, rather than any older payment link we ' +
        'may have sent you.</div>' +
        (linked && linked.length ? '<div style="' + MAIL_FONT + ';margin-top:8px">' +
          (linked.length === 1 ? 'One invoice is too large to attach, so it is here to download instead:'
            : 'A couple of these are too large to attach, so they are here to download instead:') +
          '<br>' + linkList + '</div>' : ''),
      buttons: button_(STATEMENT_PAYMENT_URL, 'Pay your balance', '#C08A22')
    }),
    text: 'We noticed the following invoice' + (plural ? 's' : '') + ' still show a balance:\n\n' +
      group.invoices.map(function (inv) { return inv.id + ': ' + money_(inv.amountDue); }).join('\n') +
      '\n\nTotal balance: ' + money_(group.totalDue) +
      '\n\nAlready paid? Please let us know, in case we missed recording it.' +
      '\nNot yet? Pay online any time: ' + STATEMENT_PAYMENT_URL +
      '\n\n' + SHOP_NAME
  };
}

function sendCustomerStatementMail_(group, followup) {
  const attachments = [statementPdf_(group)];
  let budget = MAIL_ATTACHMENT_BUDGET - attachments[0].getBytes().length;

  // Each invoice's own PDF rides along too, same as the single-invoice email
  // — a customer should never have to click through to read a bill. One
  // that does not fit what is left of the budget goes in as a Drive link
  // instead of bouncing the whole message.
  const linked = [];
  group.invoices.forEach(function (inv) {
    const job = jobRow_(inv.id);
    if (!job || !job.invoice_file) return;
    try {
      const blob = DriveApp.getFileById(job.invoice_file).getBlob().setName('Invoice-' + job.id + '.pdf');
      const bytes = blob.getBytes().length;
      if (bytes > budget) {
        linked.push({ id: job.id, driveFile: job.invoice_file });
        return;
      }
      attachments.push(blob);
      budget -= bytes;
    } catch (err) {
      /* Binned out of Drive by hand. The statement still goes; that one invoice just isn't attached. */
    }
  });

  const jobIds = group.invoices.map(function (inv) { return inv.id; });
  const content = statementEmailContent_(group, followup, linked);
  return sendStatement_(Object.assign({ jobIds: jobIds, attachments: attachments }, content));
}

/**
 * The open-invoice group a customer's address belongs to.
 *
 * Matched on the first address rather than the whole list, because that is
 * what the group is keyed on: a page that was loaded before a second address
 * was added to one of the jobs still finds the right customer instead of
 * telling the writer their statement has gone away.
 */
function statementGroupFor_(customerEmail) {
  const wanted = String(emailList_(customerEmail)[0] || '').toLowerCase();
  if (!wanted) return null;
  return openInvoicesByCustomer_().find(function (g) {
    return String(emailList_(g.customerEmail)[0] || '').toLowerCase() === wanted;
  }) || null;
}

/**
 * The group statementEmailContent_ and statementPdf_ both work from —
 * either a real customer's current open invoices, or the "Create new
 * statement" wizard's own not-yet-created ones, handed over as `draft`:
 * {customerName, customerEmail, invoices: [{invoiceNumber, boatInfo,
 * amountDue}]}. A draft wins when given one, because before anything is
 * backfilled there are no jobs yet for a real lookup to find.
 */
function resolveStatementGroup_(customerEmail, draft) {
  if (draft && Array.isArray(draft.invoices) && draft.invoices.length) {
    return draftStatementGroup_(draft);
  }
  const group = statementGroupFor_(customerEmail);
  if (!group) {
    throw new Error('That customer has no open invoices right now — the list may be out of date. Refresh and try again.');
  }
  return group;
}

/** The group shape statementEmailContent_ needs, built from the wizard's own state rather than real Jobs rows. */
function draftStatementGroup_(draft) {
  const invoices = draft.invoices.map(function (inv) {
    return {
      id: String(inv.invoiceNumber || '').trim().toUpperCase() || '(new invoice)',
      boatInfo: inv.boatInfo || '',
      amountDue: numberOrNull_(inv.amountDue) || 0
    };
  });
  return {
    customerName: draft.customerName || '',
    customerEmail: String(draft.customerEmail || '').trim(),
    invoices: invoices,
    totalDue: Math.round(invoices.reduce(function (sum, inv) { return sum + inv.amountDue; }, 0) * 100) / 100
  };
}

/**
 * The words a customer would read, without sending anything — the popup the
 * writer checks before a statement (or a follow-up) actually goes out.
 */
function previewCustomerStatement(token, customerEmail, followup, draft) {
  requireAdmin_(token);
  const group = resolveStatementGroup_(customerEmail, draft);
  const content = statementEmailContent_(group, !!followup, []);
  return {
    subject: content.subject,
    html: content.html,
    to: content.to,
    testMode: testMode_(),
    invoiceCount: group.invoices.length,
    totalDue: group.totalDue
  };
}

/**
 * The statement summary as a standalone PDF — the same document that
 * otherwise only ever rides along with the email — handed back on its own
 * so a writer can print or read it without anything going to a customer.
 * Works from a draft exactly the way the preview does: printing a
 * statement before it is ever sent is the whole point of saving one.
 */
function statementSummaryPdf(token, customerEmail, draft) {
  requireAdmin_(token);
  const group = resolveStatementGroup_(customerEmail, draft);
  const pdf = statementPdf_(group);
  return { base64: Utilities.base64Encode(pdf.getBytes()), filename: pdf.getName() };
}

/**
 * Sendable more than once on purpose, the same as a single invoice — an
 * address gets corrected, or one more invoice comes due before the last
 * statement was acted on, and the fix each time is to send it again.
 *
 * Recomputes the customer's open invoices itself rather than trusting
 * whatever the portal had on screen: a payment ticked in the last few
 * minutes must never go out on a statement anyway.
 */
function sendCustomerStatement(token, customerEmail, followup) {
  requireAdmin_(token);
  if (!normalizeEmails_(customerEmail)) throw new Error('No customer given.');
  const group = statementGroupFor_(customerEmail);
  if (!group) {
    throw new Error('That customer has no open invoices right now — the list may be out of date. Refresh and try again.');
  }
  return {
    emailed: sendCustomerStatementMail_(group, !!followup),
    testMode: testMode_(),
    sentTo: testMode_() ? testEmail_() : group.customerEmail,
    invoiceCount: group.invoices.length
  };
}

/** What the portal needs to know about this deployment. */
function config(token) {
  requireAdmin_(token);
  return {
    testMode: testMode_(),
    testEmail: testEmail_(),
    customerTracking: customerTracking_(),
    siteUrl: SITE_URL,
    serviceEmail: SERVICE_EMAIL,
    reviewUrl: reviewUrl_(),
    // So App setup can say WHICH link is in force — the direct one the shop
    // pasted, or the listing fallback it falls back to — and offer the
    // fallback back if somebody clears the field and changes their mind.
    reviewUrlDefault: GOOGLE_REVIEW_URL,
    reviewUrlDirect: directReviewLink_(reviewUrl_())
  };
}

/**
 * The shop's Google review link, set from the App setup page.
 *
 * A script property rather than a constant in the code because it is the
 * shop's to change and changing it should not be a deploy. Not a credential —
 * see GOOGLE_REVIEW_URL. Blank clears it, which turns the review tick box on
 * the payment form back off rather than leaving it pointing at nothing.
 */
function setReviewUrl(token, url) {
  requireAdmin_(token);
  const value = String(url || '').trim();
  if (value && !/^https:\/\//i.test(value)) {
    throw new Error('That needs to be a full https:// link \u2014 the one your Google Business ' +
      'Profile gives you under "Ask for reviews".');
  }
  props_().setProperty('GOOGLE_REVIEW_URL', value);
  return { reviewUrl: reviewUrl_() };
}

/**
 * Going live is one deliberate switch, made by a person who is signed in.
 * Turning it back on is just as easy if something needs another rehearsal.
 */
function setTestMode(token, on) {
  requireAdmin_(token);
  props_().setProperty('TEST_MODE', on ? 'true' : 'false');
  return { testMode: testMode_(), testEmail: testEmail_() };
}

/**
 * Switches the customer tracking page on or off. Off is the default and the
 * shop's settled plan; the switch exists so the decision can be revisited
 * without going back into the code.
 */
function setCustomerTracking(token, on) {
  requireAdmin_(token);
  props_().setProperty('CUSTOMER_TRACKING', on ? 'on' : 'off');
  return { customerTracking: customerTracking_() };
}

/* ========================= writer's close-out ========================== */

/**
 * "Parts and labor logged" is not a flag on the job — it is a line drawn
 * under everything logged so far.
 *
 * Stamping each entry means anything a mechanic adds afterwards shows up
 * below that line as still needing writing up, which is the thing the writer
 * actually has to keep track of on a job that is still open.
 */
function markEntriesLogged(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  return withLock_(function () {
    const at = nowIso_();
    let count = 0;
    rows_('LogEntries').forEach(function (entry) {
      if (String(entry.job_id) !== String(id) || entry.logged_at) return;
      updateRow_('LogEntries', entry._row, { logged_at: at });
      count += 1;
    });
    return { logged: count, entries: entriesForJob_(id) };
  });
}

/**
 * Files finished jobs away, or brings them back.
 *
 * Archiving is not deleting and not closing: the row, its log, its payments
 * and its paid tick are all untouched, and an archived job still opens from
 * its QR code. All it does is take the job off every list but Archived, so the
 * Done tab is the jobs that still want looking at rather than every boat the
 * shop has ever finished. Only a done job can be filed — anything else is
 * still being worked on, and hiding it would lose it.
 *
 * Several at once, because that is how the Done tab is cleared: tick the lot,
 * press once. A job that cannot be filed is skipped and counted, not fatal.
 */
function archiveJobs(token, ids, archived) {
  requireAdmin_(token);
  if (!Array.isArray(ids) || !ids.length) throw new Error('Nothing picked to archive.');
  // Without the column the stamp would save and read back empty — the jobs
  // would simply stay put, with no way to tell why.
  requireColumn_('Jobs', 'archived_at');
  return withLock_(function () {
    forget_('Jobs');
    const at = archived ? nowIso_() : '';
    let changed = 0;
    let skipped = 0;
    // One read for the whole batch. updateRow_ drops the memoised rows after
    // every write, so looking each job up afresh would re-read the tab once
    // per tick; the row numbers do not move under the lock.
    const byId = {};
    rows_('Jobs').forEach(function (job) { byId[String(job.id)] = job; });
    ids.forEach(function (id) {
      const job = byId[String(id)];
      if (!job || (archived && job.status !== 'done')) {
        skipped += 1;
        return;
      }
      if (Boolean(job.archived_at) === Boolean(archived)) return;
      updateRow_('Jobs', job._row, { archived_at: at, updated_at: nowIso_() });
      changed += 1;
    });
    return { changed: changed, skipped: skipped };
  });
}

/** The other two ticks: parts ordered, and paid/closed. */
function setJobFlag(token, id, flag, on) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const column = { partsOrdered: 'parts_ordered_at', paid: 'paid_at' }[flag];
  if (!column) throw new Error('Unknown checkbox.');
  const patch = { updated_at: nowIso_() };
  patch[column] = on ? nowIso_() : '';
  updateRow_('Jobs', job._row, patch);
  return { job: jobSummary_(jobRow_(id)) };
}

/* ============================ hourly digest ============================ */

/**
 * One email per job per hour, covering everything logged on it since the last
 * one. Deliberately batched rather than one email per entry: a consumer Gmail
 * account will only send about a hundred messages a day, and a busy Saturday
 * of per-entry notifications would eat that and then start failing silently.
 *
 * Runs on a time trigger; see installTriggers_().
 */
function sendDigest() {
  const pending = rows_('LogEntries').filter(function (entry) { return !entry.notified_at; });
  if (!pending.length) return;

  const byJob = {};
  pending.forEach(function (entry) {
    (byJob[entry.job_id] = byJob[entry.job_id] || []).push(entry);
  });

  const at = nowIso_();
  Object.keys(byJob).forEach(function (jobId) {
    const job = jobRow_(jobId);
    if (!job) return;
    const entries = byJob[jobId].map(entryView_).sort(function (a, b) {
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });

    const rowsHtml = entries.map(function (entry) {
      const bits = [];
      if (entry.hours) bits.push('<b>' + formatDuration_(minutesFromHours_(entry.hours)) + '</b>');
      if (entry.partIdentifier) {
        bits.push('<b>' + esc_(entry.partIdentifier) + '</b>' + (entry.quantity ? ' &times; ' + entry.quantity : ''));
      }
      if (entry.text) bits.push(esc_(entry.text));
      if (entry.transcript) bits.push('<i>said:</i> ' + esc_(entry.transcript));
      if (!entry.transcript && entry.transcriptStatus === 'pending') {
        bits.push('<i>voice note — still transcribing</i>');
      }
      if (entry.photos.length) bits.push('<i>' + entry.photos.length + ' photo' + (entry.photos.length === 1 ? '' : 's') + '</i>');
      return '<tr><td style="padding:6px 0;border-bottom:1px solid #EBF1F6;vertical-align:top">' +
        '<div style="font-size:12px;color:#4A81A6;text-transform:uppercase;letter-spacing:.06em">' +
          esc_(ENTRY_LABEL[entry.entryType]) + ' &middot; ' + esc_(entry.mechanicName || 'unknown') + '</div>' +
        '<div style="font-size:14px;color:#1D2B38">' + bits.join('<br>') + '</div></td></tr>';
    }).join('');

    const totals = laborTotals_(entriesForJob_(jobId));
    send_({
      to: SERVICE_EMAIL,
      jobId: jobId,
      kind: 'digest',
      subject: jobId + ' — ' + entries.length + ' new ' + (entries.length === 1 ? 'entry' : 'entries'),
      html: noticeHtml_({
        intro: '<div style="font-size:16px;font-weight:bold;color:#14293E;margin-bottom:2px">' +
            esc_(jobId) + (job.customer_name ? ' &middot; ' + esc_(job.customer_name) : '') + '</div>' +
          '<div style="font-size:13px;color:#5C7185;margin-bottom:12px">' +
            esc_(STATUS_LABEL[job.status]) + (totals.total ? ' &middot; ' + totals.total + ' h logged so far' : '') + '</div>' +
          '<table width="100%" cellpadding="0" cellspacing="0">' + rowsHtml + '</table>',
        buttons: button_(SITE_URL + '/admin/?job=' + encodeURIComponent(jobId), 'Open the job')
      }),
      text: entries.length + ' new entries on ' + jobId + '\n' + SITE_URL + '/admin/?job=' + jobId
    });

    byJob[jobId].forEach(function (entry) {
      updateRow_('LogEntries', entry._row, { notified_at: at });
    });
  });
}

/* ========================== daily order list =========================== */

/**
 * What is outstanding on parts, in the writer's inbox at 3pm.
 *
 * Sent every weekday whether or not anything changed — an empty list is
 * itself worth seeing, because it is the difference between "nothing to
 * order" and "the trigger stopped running".
 */
function sendDailyOrders() {
  const all = rows_('PartsOrders').map(partView_);
  const needed = all.filter(function (p) { return p.status === 'needed'; });
  const waiting = all.filter(function (p) { return p.status === 'ordered'; });

  const line = function (part) {
    const bits = [];
    if (part.quantity) bits.push('<b>' + part.quantity + '&times;</b>');
    bits.push('<b>' + esc_(part.partIdentifier || '(no part number)') + '</b>');
    if (part.description) bits.push(esc_(part.description));
    const tail = [];
    if (part.jobId) tail.push('job ' + esc_(part.jobId));
    tail.push(esc_(part.reasonLabel));
    if (part.vendor) tail.push(esc_(part.vendor) + (part.orderNumber ? ' #' + esc_(part.orderNumber) : ''));
    if (part.requestedBy) tail.push(esc_(part.requestedBy));
    return '<tr><td style="padding:6px 0;border-bottom:1px solid #EBF1F6">' +
      '<div style="font-size:14px;color:#1D2B38">' + bits.join(' ') + '</div>' +
      '<div style="font-size:12px;color:#5C7185">' + tail.join(' &middot; ') + '</div>' +
      (part.notes ? '<div style="font-size:13px;color:#A6541F;margin-top:2px">' + esc_(part.notes) + '</div>' : '') +
      '</td></tr>';
  };

  const section = function (title, parts) {
    if (!parts.length) return '<p style="font-size:14px;color:#5C7185;margin:0 0 12px">' + title + ': nothing.</p>';
    return '<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#4A81A6;margin:14px 0 4px">' +
      title + ' (' + parts.length + ')</div>' +
      '<table width="100%" cellpadding="0" cellspacing="0">' + parts.map(line).join('') + '</table>';
  };

  send_({
    to: SERVICE_EMAIL,
    jobId: '',
    kind: 'daily_orders',
    subject: 'Parts to order — ' + Utilities.formatDate(new Date(), 'America/Chicago', 'EEE d MMM'),
    html: noticeHtml_({
      intro: '<div style="font-size:16px;font-weight:bold;color:#14293E;margin-bottom:10px">Parts list</div>' +
        section('To order', needed) + section('On order, not yet in', waiting),
      buttons: button_(SITE_URL + '/admin/?view=parts', 'Open the parts list')
    }),
    text: needed.length + ' to order, ' + waiting.length + ' on order.\n' + SITE_URL + '/admin/?view=parts'
  });
}

/* =========================== transcription ============================= */

function assemblyKey_() {
  return props_().getProperty('ASSEMBLYAI_API_KEY') || '';
}

function webhookUrl_() {
  const url = props_().getProperty('WEB_APP_URL');
  if (!url) return '';
  return url + '?hook=transcript&k=' + encodeURIComponent(secret_().substr(0, 24));
}

/**
 * Hands one recording to AssemblyAI. Slow by nature — a Drive read of the
 * whole file and two uploads — so it must only ever run from a trigger,
 * never from a request a mechanic is waiting on. See queueTranscriptRun_.
 *
 * The audio stays in Drive either way; the words are filled in underneath
 * the entry when the webhook comes back.
 */
function submitTranscript_(entryId, audioFileId) {
  const key = assemblyKey_();
  if (!key) {
    markTranscript_(entryId, 'failed', '', 'ASSEMBLYAI_API_KEY is not set on this deployment');
    return;
  }
  try {
    const bytes = DriveApp.getFileById(audioFileId).getBlob().getBytes();
    const upload = UrlFetchApp.fetch('https://api.assemblyai.com/v2/upload', {
      method: 'post',
      contentType: 'application/octet-stream',
      headers: { authorization: key },
      payload: bytes,
      muteHttpExceptions: true
    });
    if (upload.getResponseCode() >= 300) throw new Error('upload failed (' + upload.getResponseCode() + ')');
    const uploadUrl = JSON.parse(upload.getContentText()).upload_url;

    const body = { audio_url: uploadUrl, punctuate: true, format_text: true, language_code: 'en_us' };
    const hook = webhookUrl_();
    if (hook) body.webhook_url = hook;

    const created = UrlFetchApp.fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'post',
      contentType: 'application/json',
      headers: { authorization: key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (created.getResponseCode() >= 300) throw new Error('request failed (' + created.getResponseCode() + ')');
    markTranscript_(entryId, 'pending', JSON.parse(created.getContentText()).id, '');
  } catch (err) {
    markTranscript_(entryId, 'failed', '', err);
  }
}

/**
 * Books a run of the transcript queue a few seconds out.
 *
 * A one-off time trigger is the only way an Apps Script request can start
 * work it does not then wait for: the handler runs in its own execution,
 * after this one has already answered the phone.
 *
 * One trigger is booked at a time. Two mechanics recording at once want one
 * run that picks up both rows, not two runs and two entries against the
 * trigger quota. If a save lands while a run is already reading, that entry
 * can miss the run it booked — which is what the hourly sweep is for.
 */
function queueTranscriptRun_() {
  try {
    const pending = ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getHandlerFunction() === 'processTranscriptQueue';
    });
    if (pending) return;
    ScriptApp.newTrigger('processTranscriptQueue').timeBased().after(5000).create();
  } catch (err) {
    // Out of triggers, or the deployment cannot install one. The row is
    // already marked pending, so the hourly sweep still gets there — late
    // words beat a save that hangs.
  }
}

/** The queued run. Installed by queueTranscriptRun_, and it clears up after itself. */
function processTranscriptQueue() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'processTranscriptQueue') ScriptApp.deleteTrigger(trigger);
  });
  submitQueuedTranscripts_();
}

/**
 * Every recording that has been stored but never handed to AssemblyAI.
 *
 * `pending` with no transcript id is the queue: addEntry writes the row that
 * way and books a run. Nothing else distinguishes a recording waiting to go
 * up from one already up and waiting to come back.
 */
function submitQueuedTranscripts_() {
  if (!assemblyKey_()) return;
  rows_('LogEntries')
    .filter(function (entry) {
      return entry.transcript_status === 'pending' && !entry.transcript_id && entry.audio_file;
    })
    .forEach(function (entry) {
      try {
        submitTranscript_(entry.id, entry.audio_file);
      } catch (err) {
        /* submitTranscript_ marks its own failures; the next run tries again. */
      }
    });
}

function markTranscript_(entryId, status, transcriptId, error) {
  const all = rows_('LogEntries');
  for (let i = 0; i < all.length; i++) {
    if (all[i].id !== entryId) continue;
    const patch = { transcript_status: status };
    if (transcriptId) patch.transcript_id = transcriptId;
    if (error) patch.transcript_error = String(error).substr(0, 300);
    updateRow_('LogEntries', all[i]._row, patch);
    return all[i];
  }
  return null;
}

function applyTranscript_(transcriptId) {
  const key = assemblyKey_();
  if (!key) return;
  const res = UrlFetchApp.fetch('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
    headers: { authorization: key },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) return;
  const body = JSON.parse(res.getContentText());

  const all = rows_('LogEntries');
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].transcript_id) !== String(transcriptId)) continue;
    if (body.status === 'completed') {
      const words = String(body.text || '').trim();
      // Into its own column, so a mechanic who typed a note and recorded one
      // keeps both.
      //
      // Before that column exists — the window between this deploy and
      // somebody running setup() — writing there would put the words in a
      // cell with no header, to be read back as nothing. So: an entry with
      // nothing typed takes them in `text`, exactly as it always did and
      // losing nothing. An entry that has BOTH is left pending instead of
      // being written over or quietly dropped; the hourly sweep asks again,
      // and the words land properly the moment the column is there. Waiting
      // is recoverable. Losing what a mechanic said is not.
      let patch;
      if (headerHas_('LogEntries', 'transcript')) {
        patch = { transcript: words };
      } else if (!all[i].text) {
        patch = { text: words };
      } else {
        return;
      }
      patch.transcript_status = 'done';
      patch.transcript_error = '';
      updateRow_('LogEntries', all[i]._row, patch);
    } else if (body.status === 'error') {
      updateRow_('LogEntries', all[i]._row, {
        transcript_status: 'failed',
        transcript_error: String(body.error || 'Transcription failed').substr(0, 300)
      });
    }
    return;
  }
}

function transcriptWebhook_(params) {
  if (params.k !== secret_().substr(0, 24)) return json_({ error: 'no' });
  // A transcript that errored out at AssemblyAI still calls back. Applying it
  // records the failure against the entry, which is what the mechanic needs
  // to see rather than a note stuck on "transcribing…" for ever.
  if (params.transcript_id) applyTranscript_(params.transcript_id);
  return json_({ ok: true });
}

/**
 * Safety net for a webhook that never arrived - a deploy in the middle of a
 * transcription, or a delivery Google dropped. Runs alongside the digest.
 *
 * Also the net under the queue itself: a recording whose trigger never ran
 * has no transcript id to poll, and would otherwise sit pending forever.
 */
function sweepTranscripts_() {
  if (!assemblyKey_()) return;
  submitQueuedTranscripts_();
  rows_('LogEntries')
    .filter(function (entry) { return entry.transcript_status === 'pending' && entry.transcript_id; })
    .forEach(function (entry) {
      try {
        applyTranscript_(entry.transcript_id);
      } catch (err) {
        /* Leave it pending; the next sweep tries again. */
      }
    });
}

/**
 * Walks the photos and the recording of a moved entry into the folder of the
 * job it now belongs to.
 *
 * Moving an entry leaves its files behind on purpose: Drive is several slow
 * calls per file and the writer is standing at a counter when they press the
 * button. The links keep working either way — every job folder is
 * link-shared and the entry carries the file ids — so nothing is broken in
 * the meantime. What is wrong is the filing: somebody opening last winter's
 * job in Drive should find that job's photos in that job's folder.
 *
 * So it happens at 2am, when slow costs nothing.
 *
 * Capped per run. A night with a hundred moved entries behind it must not
 * spend the day's trigger runtime in one go; whatever is left is still
 * stamped and the next night takes it.
 */
const FILE_SWEEP_LIMIT = 40;

function sweepEntryFiles_() {
  const waiting = rows_('LogEntries').filter(function (entry) {
    return entry.files_job && String(entry.files_job) !== String(entry.job_id);
  }).slice(0, FILE_SWEEP_LIMIT);

  waiting.forEach(function (entry) {
    try {
      const folder = jobFolder_(entry.job_id);
      const ids = [];
      if (entry.audio_file) ids.push(entry.audio_file);
      parsePhotos_(entry.photos).forEach(function (photo) {
        if (photo.thumb) ids.push(photo.thumb);
        if (photo.full) ids.push(photo.full);
      });

      ids.forEach(function (id) {
        try {
          // moveTo, not a copy: the id in the sheet has to keep working, and
          // the file takes its new parent's sharing on the way in.
          DriveApp.getFileById(id).moveTo(folder);
        } catch (err) {
          // A file somebody deleted out of Drive by hand. The entry still
          // reads fine without it, and stopping here would strand every
          // other file on the entry.
        }
      });
      updateRow_('LogEntries', entry._row, { files_job: '' });
    } catch (err) {
      // Leave the stamp on. Whatever went wrong — a folder that would not
      // open, Drive refusing — the next night tries again.
    }
  });
  return waiting.length;
}

/* ============================== triggers =============================== */

/** One hourly job does both: it keeps well inside the trigger runtime quota. */
function hourly() {
  sweepTranscripts_();
  sendDigest();
  // Catches Harbor Haul Out up on any tick whose own send failed. The whole
  // state each time, so this is a no-op over there when nothing is behind.
  pushWinterTicks_(null);
  // The Detail Tracker's winter quotes, for any answer whose ping was lost.
  catchUpWinterDetails_();
}

/** Housekeeping, at an hour when slow does not matter. */
function nightly() {
  sweepEntryFiles_();
}

function installTriggers_() {
  const ours = { hourly: true, sendDailyOrders: true, nightly: true };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ours[trigger.getHandlerFunction()]) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  // 3pm Central — the script's own timezone, set in appsscript.json.
  ScriptApp.newTrigger('sendDailyOrders').timeBased().atHour(15).everyDays(1).create();
  // 2am, for the filing nobody should have to wait on.
  ScriptApp.newTrigger('nightly').timeBased().atHour(2).everyDays(1).create();
}

/* ================================ setup ================================ */

function ensureSheets_(spreadsheet) {
  Object.keys(SHEETS).forEach(function (name) {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    const header = SHEETS[name];
    const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
    // Column order is append-only, so a header that is already right is left
    // alone and a new column is simply written into place.
    if (current.join(' ') !== header.join(' ')) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.setFrozenRows(1);
    }
  });
  const first = spreadsheet.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0) spreadsheet.deleteSheet(first);
}

/**
 * Undoes the damage Sheets did before cells were written as text.
 *
 * A job whose id reads as a Date was written when the column was still
 * General: `01-8891` went in and the first of January 8891 came out. That
 * inverts exactly — month and year are the two halves of the invoice number
 * — so the id can be put back rather than the job thrown away. Ids appear as
 * `job_id` on four other tabs, and all of them have to move together or the
 * entries orphan.
 *
 * Safe to re-run: a row already holding text is left alone.
 */
/**
 * Recounts every job's entry_count and minutes_total from the log itself.
 *
 * The running totals exist so the jobs list and every save can avoid reading
 * the whole LogEntries tab. A derived number that nothing ever checks is a
 * number that drifts, so this is the check: it is what backfills the columns
 * the first time, and what puts them right if anything ever writes an entry
 * without going through addEntry.
 *
 * Reads both tabs once. Only writes the jobs whose figures were actually
 * wrong, so a healthy shop pays nothing for having it run.
 */
/**
 * Adds one entry to a job's running totals.
 *
 * Every path that appends a LogEntries row has to come through here, and two
 * of them did not: addWriterNote and setJobAlert wrote an entry straight to
 * the tab, so a job carrying an office note or an alert under-reported itself
 * on the writer's list. sheetStatus caught it the first time it was asked.
 *
 * Re-reads the row rather than trusting a copy taken earlier: the caller may
 * have read it before the lock, and two writes landing together would both
 * save the same number and lose one. `insideLock` says the caller already
 * read the row with the lock held, which is the same guarantee for one fewer
 * read of the whole tab — addEntry does exactly that.
 */
function bumpJobEntryTotals_(jobId, addedMinutes, insideLock) {
  return adjustJobEntryTotals_(jobId, 1, addedMinutes || 0, insideLock);
}

/**
 * The same bookkeeping in both directions, because entries also leave.
 *
 * A delete takes one off a job; a move takes one off the job it was logged
 * against and puts it on the job it belonged to. Both totals are derived, so
 * every path that changes what the log holds has to come through here — the
 * writer's list reads these numbers and never counts the rows.
 *
 * Floored at zero. If a total has drifted below what the log actually holds,
 * a negative count on the jobs list helps nobody; sheetStatus reports the
 * drift and setup() recounts it.
 */
function adjustJobEntryTotals_(jobId, entryDelta, minutesDelta, insideLock) {
  if (!insideLock) forget_('Jobs');
  const job = jobRow_(jobId);
  if (!job) return null;
  const totals = {
    entry_count: Math.max(Number(job.entry_count || 0) + entryDelta, 0),
    minutes_total: Math.max(Number(job.minutes_total || 0) + minutesDelta, 0)
  };
  updateRow_('Jobs', job._row, {
    entry_count: totals.entry_count,
    minutes_total: totals.minutes_total,
    updated_at: nowIso_()
  });
  return Object.assign({}, job, totals);
}

/** Which jobs' stored totals disagree with the log. Reads only. */
function jobTotalsDrift_() {
  const counts = {};
  const minutes = {};
  rows_('LogEntries').forEach(function (entry) {
    const id = String(entry.job_id);
    counts[id] = (counts[id] || 0) + 1;
    if (entry.entry_type === 'labor' && entry.hours) {
      minutes[id] = (minutes[id] || 0) + minutesFromHours_(entry.hours);
    }
  });

  // paid_total is derived exactly like the two above, off the Payments tab,
  // and every balance the shop or a customer is shown comes out of it. A tab
  // setup() has not created yet simply has no payments in it.
  const paid = {};
  let payments = [];
  try {
    payments = rows_('Payments');
  } catch (err) {
    payments = [];
  }
  payments.forEach(function (payment) {
    const id = String(payment.job_id);
    paid[id] = money2_((paid[id] || 0) + (numberOrNull_(payment.amount) || 0));
  });

  const out = [];
  rows_('Jobs').forEach(function (job) {
    const id = String(job.id);
    const wantCount = counts[id] || 0;
    const wantMinutes = minutes[id] || 0;
    const wantPaid = money2_(paid[id] || 0);
    if (Number(job.entry_count || 0) === wantCount &&
        Number(job.minutes_total || 0) === wantMinutes &&
        money2_(numberOrNull_(job.paid_total) || 0) === wantPaid) return;
    out.push({ id: id, row: job._row, entryCount: wantCount, minutesTotal: wantMinutes, paidTotal: wantPaid });
  });
  return out;
}

function recountJobTotals_() {
  return jobTotalsDrift_().map(function (job) {
    updateRow_('Jobs', job.row, {
      entry_count: job.entryCount,
      minutes_total: job.minutesTotal,
      paid_total: job.paidTotal
    });
    return job.id;
  });
}

/**
 * Whether the sheet has caught up with the code — read only, changes nothing.
 *
 * A deploy ships code; setup() is what writes new tabs and columns into the
 * sheet, and nothing forces the two to happen together. Until they do, a new
 * feature either fails with "Run setup()." or, worse, saves into a column the
 * header does not name and silently reads back empty.
 *
 * That gap used to live in somebody's memory. Now the App setup page asks.
 */
function sheetStatus(token) {
  requireAdmin_(token);
  const spreadsheet = ss_();
  const missing = [];
  Object.keys(SHEETS).forEach(function (name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (!sheet) {
      missing.push({ tab: name, columns: [], absent: true });
      return;
    }
    const header = sheet.getRange(1, 1, 1, SHEETS[name].length).getValues()[0];
    const gaps = SHEETS[name].filter(function (column) { return header.indexOf(column) === -1; });
    if (gaps.length) missing.push({ tab: name, columns: gaps, absent: false });
  });

  // Only worth asking once the columns exist; before that every job "drifts".
  const columnsReady = !missing.length;
  const drift = columnsReady ? jobTotalsDrift_().map(function (job) { return job.id; }) : [];

  return {
    ready: columnsReady && !drift.length,
    missing: missing,
    drifted: drift.length,
    driftedIds: drift.slice(0, 10)
  };
}

/**
 * setup(), from the portal instead of the Apps Script editor.
 *
 * Every deploy that adds a column or a trigger needs setup() run once, and
 * until now that meant somebody opening script.google.com, finding the
 * function in a dropdown and pressing run. The App setup page already says
 * exactly what is missing; this is the button next to it.
 *
 * Behind the writer's password, which is the same door as everything else on
 * that page, and it is safe to press twice: setup() adds what is missing and
 * touches nothing else.
 *
 * Answers rather than throws when it fails part way. ensureSheets_ runs
 * before installTriggers_, so a script that has never been authorised to
 * create triggers from a web app still gets its columns — and the writer
 * needs to be told which half happened, not handed a red banner that makes
 * it look like nothing did.
 */
function runSetup(token) {
  requireAdmin_(token);
  try {
    return { ok: true, notes: setup(), status: sheetStatus(token) };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
      status: sheetStatus(token)
    };
  }
}

function repairCoercedIds_() {
  const fixed = [];
  const map = {};

  ['Jobs', 'LogEntries', 'PartsOrders', 'StatusEvents', 'EmailLog'].forEach(function (name) {
    const columns = SHEETS[name];
    const sheet = sheet_(name);
    const last = sheet.getLastRow();
    if (last < 2) return;

    const range = sheet.getRange(1, 1, last, columns.length);
    const values = range.getValues();
    let touched = false;

    for (let r = 1; r < values.length; r++) {
      ['id', 'job_id'].forEach(function (key) {
        const index = columns.indexOf(key);
        // Only a job's own id is an invoice number; a log entry's id is not.
        if (index === -1 || (key === 'id' && name !== 'Jobs')) return;
        const value = values[r][index];
        if (!isDate_(value)) return;
        const text = invoiceNumberFromDate_(value);
        map[value.toISOString()] = text;
        values[r][index] = text;
        touched = true;
        if (key === 'id') fixed.push(text);
      });
    }

    // Text from here on, whatever was in the cells before.
    range.setNumberFormat('@');
    if (touched) range.setValues(values);
  });

  forget_();
  return fixed;
}

/** `01-8891` is what Sheets turned into 8891-01-01. This turns it back. */
function invoiceNumberFromDate_(date) {
  const month = date.getMonth() + 1;
  return (month < 10 ? '0' : '') + month + '-' + date.getFullYear();
}

/**
 * Run this ONCE from the editor, then paste the values it logs into
 * assets/lib/config.js and deploy the web app. Safe to re-run: it repairs
 * missing tabs and re-installs the trigger without touching data.
 */
function setup() {
  let spreadsheet;
  const existing = props_().getProperty('SPREADSHEET_ID');
  if (existing) {
    spreadsheet = SpreadsheetApp.openById(existing);
  } else {
    spreadsheet = SpreadsheetApp.create(SS_NAME);
    props_().setProperty('SPREADSHEET_ID', spreadsheet.getId());
  }
  _ss = spreadsheet;
  ensureSheets_(spreadsheet);
  const repaired = repairCoercedIds_();
  const recounted = recountJobTotals_();
  rootFolder_();
  secret_();
  installTriggers_();
  // Run from the editor, setup() never passes through serve_, and it has just
  // put ids and totals right: the cached lists must not go on saying otherwise.
  invalidateLists_();

  const notes = [
    repaired.length
      ? 'Repaired ' + repaired.length + ' job id(s) Sheets had read as dates: ' + repaired.join(', ')
      : 'Job ids are stored as text. Nothing to repair.',
    recounted.length
      ? 'Recounted entries, time and payments on ' + recounted.length + ' job(s).'
      : 'Every job\'s entry, time and payment totals already agreed with the record.',
    'Spreadsheet: ' + spreadsheet.getUrl(),
    'Drive folder: https://drive.google.com/drive/folders/' + props_().getProperty('DRIVE_FOLDER_ID'),
    '',
    'Still to do, in Project Settings > Script properties:',
    '  ADMIN_PASSWORD     the service writer portal password',
    '  ASSEMBLYAI_API_KEY optional; without it voice notes keep the audio but get no text',
    '  WEB_APP_URL        this deployment /exec URL, so AssemblyAI can call back',
    '',
    'Then paste the /exec URL into assets/lib/config.js as API_URL and commit.'
  ].join('\n');
  Logger.log(notes);
  return notes;
}

/**
 * Convenience for the editor: set the portal password without leaving it in
 * code. Five characters is the floor the shop asked for — short enough to say
 * across a counter, and deliberately not something this function pretends is
 * strong. See the note in CLAUDE.md about what actually guards this door.
 */
function setAdminPassword(password) {
  const value = String(password || '').trim();
  if (value.length < 5) throw new Error('Use at least 5 characters.');
  props_().setProperty('ADMIN_PASSWORD', value);
  return 'Portal password set.';
}

/* ============================ the Detail Tracker ========================== */
/*
 * Chris, Nov 2026: "There's been some mixups between the detailer and the
 * mechanic ... the mechanic marks it done because the mechanical parts are
 * done, but detail quotes, details, powerwashes, etc. all still need to be
 * done." So detailing is its own board, with its own app at /d/:
 *
 *  - A DETAIL IS A ROW ON `Details`. It comes from one of three places: a
 *    request taken in at the counter or by phone (`source: request`), a work
 *    order the writer ticked Detail on (`source: job`, `job_id` set), or a
 *    winter unit whose quote carries detailing or a wash (`source: winter`,
 *    `winter_qn` set). Its lines are the detail menu's (assets/lib/
 *    detail-menu.js), as one JSON cell, because a detail is read and written
 *    whole and never queried by line.
 *  - A SPLIT TICKET IS STILL ONE TICKET. `detail_split` on the job says who
 *    has work on it: '' is the mechanic alone (every job before this), 'detail'
 *    the detailer alone, 'both' each their own part. On 'both' the job only
 *    reaches Work finished when the mechanic AND the detailer have each marked
 *    their half done (`mech_done_at`, `detail_done_at`) — whichever finishes
 *    second is what moves it. Until then the writer's list says who it is
 *    waiting on, and Mark done asks before closing a ticket with half of it
 *    still open.
 *  - THE QUOTE WAITS ON THE CUSTOMER, the same way the winter system's quoted
 *    items do: a line sent for a quote is not work to do until they accept
 *    it. They answer on /q/?c=CODE — Accept, Decline or Call me — by POST
 *    only, so a mail scanner following the link answers nothing. Sending is a
 *    person's act, as everywhere in this app: the email has its own button,
 *    and the text is a draft a person sends.
 *  - THE OFFICE HEARS AT ONCE. Every answer bumps DETAIL_V (what the open
 *    board polls, at the cost of one property read), writes a DetailEvents
 *    row, sends a Web Push to every phone that switched notifications on, and
 *    emails service@ once per submission. A winter quote's answer is pinged
 *    across by the winter system (`api: 'detailPing'`) and caught up hourly.
 *  - WINTER QUOTES STAY THE WINTER SYSTEM'S. A winter unit's detailing is
 *    priced and answered there, because that is where its invoice and its
 *    payments are. This board shows what state each line is in, and the
 *    detailer's ticks go back the same way the mechanics' do (WinterWork →
 *    winterTicks), so Harbor Haul Out knows the wash is done.
 *  - SHOP-SIDE, EXCEPT THE QUOTE PAGE. detailQuote names its fields one at a
 *    time: the customer's first name, the unit, and the lines sent to them
 *    with their prices. Never a note, never who, never a line not quoted.
 */

const DETAIL_STATUSES_ = { requested: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const DETAIL_SPLITS_ = { '': 'Mechanic only', detail: 'Detailer only', both: 'Mechanic and detailer' };
const DETAIL_QUOTE_STATES_ = { '': 1, pending: 1, call: 1, accepted: 1, declined: 1 };
const DETAIL_ITEM_MAX_ = 40;
const DETAIL_FINE_PRINT_ = 'All figures are estimates and represent “starting” prices. Total does not ' +
  'include tax, and may not include certain material costs. Units not removed within 10 days of completion are ' +
  'subject to short-term storage fees of $25 per day.';

/*
 * The winter system's words for detail and wash lines. Kept in step with
 * WINTER_WORDS in assets/lib/detail-menu.js — the board maps a winter line to
 * a menu line with that list, and this decides which winter lines are the
 * detailers' in the first place.
 */
const DETAIL_WINTER_WORDS_ = [
  [/^exterior detail/i, 'premiumExt'],
  [/^wash\s*&\s*wax/i, 'washWax'],
  [/^interior detail/i, 'premiumInt'],
  [/^interior wipe-?\s*down/i, 'intWipe'],
  [/^power\s*wash/i, 'powerwash'],
  [/^acid wash/i, 'acidWash'],
  [/^jetski detail/i, 'skiDetail'],
  // Chris, Nov 7 2026: "Bottom paint is detailing."
  [/^bottom paint touch-?\s*up/i, 'bottomReapply'],
  [/^strip bottom paint/i, 'bottomPaint']
];

/*
 * Lines that bring another with them — bottom paint needs paint & supplies.
 * Kept in step with `needs` in assets/lib/detail-menu.js: the picker ticks
 * the second line, and sanitizeDetailItems_ adds it if a page did not.
 */
const DETAIL_NEEDS_ = { bottomPaint: ['paintSupplies'], bottomReapply: ['paintSupplies'], sandblast: ['paintSupplies'] };
const DETAIL_NEEDS_LABELS_ = { paintSupplies: ['Paint & supplies (estimate)', 'Bottom cleaning & painting'] };

/**
 * Bottom paint is a package (Chris, Nov 2026): "a customer can't approve
 * painting and decline the paint and supplies — the most they can accept the
 * bottom paint and ask for a call about paint and supplies, or decline the
 * whole package. Declining the bottom painting automatically means they're
 * declining paint and supplies." Run on the lines after any answer, from the
 * customer or the desk: declines paint & supplies when every bottom paint line
 * is declined, and refuses a declined paint & supplies while any bottom paint
 * is still on. Returns { auto: [lines it changed] } or { error }.
 */
const DETAIL_PACKAGE_ERROR_ = 'Paint & supplies comes with the bottom paint. Accept it or ask us to call about it \u2014 ' +
  'or decline the bottom paint too, and it goes with it.';
function paintPackage_(items, at, by) {
  const parents = items.filter(function (x) { return DETAIL_NEEDS_[x.key] && !x.winter; });
  if (!parents.length) return { auto: [] };
  const kids = items.filter(function (x) {
    return !x.winter && parents.some(function (p) { return DETAIL_NEEDS_[p.key].indexOf(x.key) !== -1; });
  });
  const auto = [];
  if (parents.every(function (p) { return p.quote === 'declined'; })) {
    kids.forEach(function (k) {
      if (k.quote !== 'declined' && !k.done) {
        k.quote = 'declined'; k.answeredAt = at; k.answeredBy = by; auto.push(k);
      }
    });
    return { auto: auto };
  }
  if (kids.some(function (k) { return k.quote === 'declined'; })) return { error: DETAIL_PACKAGE_ERROR_ };
  return { auto: auto };
}

function detailKeyForLabel_(label) {
  const words = String(label || '').trim();
  const hit = DETAIL_WINTER_WORDS_.filter(function (w) { return w[0].test(words); })[0];
  return hit ? hit[1] : '';
}

/** The tabs and columns this needs, written the first time anybody needs them. */
function ensureDetailSchema_() {
  const ss = ss_();
  if (ss.getSheetByName('Details') && ss.getSheetByName('DetailEvents') && ss.getSheetByName('PushSubs') &&
      headerHas_('Jobs', 'detail_done_at') && headerHas_('Details', 'quote_no')) return;
  ensureSheets_(ss);
  _headers = {};
}

/** What the open board polls. A new value on every write that changes a detail. */
function detailVersion_() {
  return String(props_().getProperty('DETAIL_V') || '0');
}

function bumpDetailVersion_() {
  const v = String(Date.now()) + '-' + Utilities.getUuid().slice(0, 4);
  props_().setProperty('DETAIL_V', v);
  return v;
}

function detailEvent_(detailId, kind, text, actor) {
  appendRow_('DetailEvents', { id: newId_('dev'), detail_id: detailId || '', kind: kind,
    text: String(text || '').slice(0, 500), actor: actor || '', created_at: nowIso_() });
}

function whoIs_(who) {
  return who && (who.role === 'mechanic' || who.role === 'detail') ? who.name : 'Office';
}

/**
 * The Detail Tracker's sign-in: the same staff PIN as Harbor Haul Out
 * (Chris, Nov 7 2026: "the sign ins for the detail app to be the same as the
 * harbor haul out app"). The winter system holds the roster and checks it —
 * with its own wrong-PIN pause — and this seals a token for the name it
 * answers with, good for the same twelve hours a Harbor Haul Out sign-in is.
 */
const DETAIL_SESSION_HOURS_ = 12;
function detailSignIn(pin) {
  const p = String(pin || '').trim();
  if (!p) throw new Error('Enter your PIN.');
  if (!winterKey_()) throw new Error('Not connected to the winter system yet. The office needs to add WINTER_KEY.');
  const out = winterCall_({ fn: 'staffPin', pin: p });
  if (!out.valid) throw new Error(String(out.error || 'Wrong PIN.'));
  const name = String(out.name || '').slice(0, 80);
  const who = { name: name, admin: !!out.admin, quote: !!out.quote };
  return { token: seal_({ role: 'detail', name: name, admin: who.admin, exp: Date.now() + DETAIL_SESSION_HOURS_ * 3600000 }), who: who };
}

function detailItems_(row) {
  try {
    const items = JSON.parse(row.items || '[]');
    return Array.isArray(items) ? items : [];
  } catch (err) {
    return [];
  }
}

function money2orNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Lines from a page, made safe to store. `prev` is what is on the detail now:
 * a line kept (same id) keeps its tick and its customer's answer, unless its
 * price changed under an answer, which puts the answer back to unanswered —
 * a customer agreed to a figure, not to whatever the line says later.
 */
function sanitizeDetailItems_(input, prev) {
  const str = function (v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n || 120); };
  const before = {};
  (prev || []).forEach(function (x) { before[x.id] = x; });
  const seen = {};
  const out = (input || []).slice(0, DETAIL_ITEM_MAX_).map(function (x) {
    let id = str(x.id, 40);
    if (!id || seen[id]) id = newId_('dl');
    seen[id] = true;
    const old = before[id] || null;
    const price = money2orNull_(x.price);
    const item = {
      id: id, key: str(x.key, 40), label: str(x.label), group: str(x.group, 60),
      qty: Math.max(1, Math.min(99, Math.floor(Number(x.qty) || 1))),
      price: price, how: str(x.how, 120),
      // A winter line comes with the winter system's answer; anything new starts unquoted.
      quote: old ? old.quote || '' : (x.winter && DETAIL_QUOTE_STATES_[x.quote] ? String(x.quote) : ''), answeredAt: old ? old.answeredAt || '' : '',
      answeredBy: old ? old.answeredBy || '' : '', note: old ? old.note || '' : '',
      winter: old ? old.winter || '' : str(x.winter, 20),
      done: old ? old.done || null : null
    };
    if (old && old.price !== price && (item.quote === 'accepted' || item.quote === 'pending' || item.quote === 'call')) {
      item.quote = price === null ? '' : 'pending';
      item.answeredAt = '';
      item.answeredBy = '';
    }
    return item;
  }).filter(function (x) { return x.label; });
  // Bottom paint never goes out without its paint & supplies line.
  const keys = {};
  out.forEach(function (x) { keys[x.key] = true; });
  Object.keys(DETAIL_NEEDS_).forEach(function (k) {
    if (!out.some(function (x) { return x.key === k && !x.winter; })) return;
    DETAIL_NEEDS_[k].forEach(function (need) {
      if (keys[need] || !DETAIL_NEEDS_LABELS_[need]) return;
      keys[need] = true;
      out.push({ id: newId_('dl'), key: need, label: DETAIL_NEEDS_LABELS_[need][0], group: DETAIL_NEEDS_LABELS_[need][1],
        qty: 1, price: null, how: '', quote: '', answeredAt: '', answeredBy: '', note: '', winter: '', done: null });
    });
  });
  return out;
}

/** A line that is work to do: not declined, not waiting on an answer. */
function detailDoable_(x) {
  return x.quote === '' || x.quote === 'accepted';
}

/** Where a detail sits on the board. */
/*
 * A quote request (Chris, Nov 7 2026) runs: the desk takes it in → John
 * prices it and sends it ('price') → the customer answers ('waiting' /
 * 'call') → the desk writes the BiT work order and puts its number on
 * ('ticket') → whoever does it marks it done → the desk is emailed to call
 * the customer and collect. A work order or winter unit skips the first and
 * the fourth: it already has its ticket, or its invoice is the winter quote.
 */
function detailStage_(row, items) {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'done') return 'done';
  if (row.status === 'in_progress') return 'doing';
  if (items.some(function (x) { return x.quote === 'call'; })) return 'call';
  if (items.some(function (x) { return x.quote === 'pending'; })) return 'waiting';
  const request = (row.source || 'request') === 'request';
  if (request && items.every(function (x) { return !x.quote; })) return 'price';
  if (items.some(function (x) { return x.quote === '' && x.price === null; })) return 'price';
  if (items.length && !items.some(detailDoable_)) return 'declined';
  if (request && !row.ticket_no) return 'ticket';
  return 'todo';
}

function detailQuoteUrl_(code) {
  return SITE_URL + '/q/?c=' + encodeURIComponent(code);
}

function detailView_(row, job) {
  const items = detailItems_(row);
  const count = function (q) { return items.filter(function (x) { return x.quote === q; }).length; };
  const doable = items.filter(detailDoable_);
  return {
    id: row.id, source: row.source || 'request', jobId: row.job_id || '', winterQn: row.winter_qn || '',
    customerName: row.customer_name || '', customerPhone: row.customer_phone || '',
    customerEmail: row.customer_email || '', unit: row.unit || '',
    loa: numberOrNull_(row.loa), beam: numberOrNull_(row.beam),
    items: items, status: row.status || 'requested', statusLabel: DETAIL_STATUSES_[row.status || 'requested'],
    stage: detailStage_(row, items),
    pending: count('pending'), calls: count('call'), declined: count('declined'),
    left: doable.filter(function (x) { return !x.done; }).length,
    total: Math.round(doable.reduce(function (t, x) { return t + (Number(x.price) || 0); }, 0) * 100) / 100,
    assignedTo: row.assigned_to || '', notes: row.notes || '',
    quoteCode: row.quote_code || '', quoteUrl: row.quote_code ? detailQuoteUrl_(row.quote_code) : '',
    quoteSentAt: row.quote_sent_at || '',
    createdBy: row.created_by || '', createdAt: row.created_at || '', updatedAt: row.updated_at || '',
    startedAt: row.started_at || '', doneAt: row.done_at || '', doneBy: row.done_by || '',
    archivedAt: row.archived_at || '',
    ticketNo: row.ticket_no || '',
    quoteNo: row.quote_no || '',
    // The ticket number, when it is a job in this tracker, opens it.
    ticketJob: row.ticket_no && !row.job_id && jobByNumber_(row.ticket_no) ? jobByNumber_(row.ticket_no).id : '',
    split: job ? String(job.detail_split || '') : '',
    mechDone: job ? !!job.mech_done_at : false,
    jobStatus: job ? job.status : ''
  };
}

function detailRow_(id) {
  return rows_('Details').filter(function (r) { return r.id === String(id || ''); })[0] || null;
}

function detailForJob_(jobId) {
  return rows_('Details').filter(function (r) {
    return r.job_id === String(jobId || '') && r.status !== 'cancelled';
  })[0] || null;
}

function jobsById_() {
  const out = {};
  rows_('Jobs').forEach(function (j) { out[j.id] = j; });
  return out;
}

/**
 * The board. `since` is the version the page already has: the same version
 * answers {same: true} off one property read, which is what lets an open
 * board ask every twenty seconds without costing the shop anything.
 */
function detailBoard(token, since, opts) {
  requireShop_(token);
  const v = detailVersion_();
  if (since && String(since) === v) return { same: true, v: v };
  if (!ss_().getSheetByName('Details')) return { v: v, details: [], events: [], setup: false };
  prefetch_(['Details', 'Jobs', 'DetailEvents']);
  const jobs = jobsById_();
  const archived = !!(opts && opts.archived);
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const details = rows_('Details').filter(function (r) {
    if (archived) return !!r.archived_at;
    if (r.archived_at) return false;
    // Done and cancelled stay up for a fortnight, then only on Archived.
    if ((r.status === 'done' || r.status === 'cancelled') && String(r.done_at || r.updated_at) < cutoff) return false;
    return true;
  }).map(function (r) { return detailView_(r, jobs[r.job_id]); });
  const order = { call: 0, waiting: 1, price: 2, doing: 3, todo: 4, done: 5, cancelled: 6 };
  details.sort(function (a, b) {
    return (order[a.stage] - order[b.stage]) || String(a.createdAt).localeCompare(String(b.createdAt));
  });
  const events = rows_('DetailEvents').slice(-40).reverse().map(function (e) {
    return { id: e.id, detailId: e.detail_id, kind: e.kind, text: e.text, actor: e.actor, at: e.created_at };
  });
  return { v: v, details: details, events: events, setup: true };
}

function getDetail(token, id) {
  requireShop_(token);
  if (!ss_().getSheetByName('Details')) throw new Error('No such detail.');
  const row = detailRow_(id);
  if (!row) throw new Error('No such detail.');
  const job = row.job_id ? jobRow_(row.job_id) : null;
  const events = rows_('DetailEvents').filter(function (e) { return e.detail_id === row.id; }).reverse()
    .map(function (e) { return { kind: e.kind, text: e.text, actor: e.actor, at: e.created_at }; });
  return { detail: detailView_(row, job), events: events, v: detailVersion_() };
}

function cleanDetailFields_(input) {
  const str = function (v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n || 200); };
  const dim = function (v) { const n = Number(v); return isFinite(n) && n > 0 && n < 200 ? String(Math.round(n * 1000) / 1000) : ''; };
  const out = {};
  if (input.customerName !== undefined) out.customer_name = str(input.customerName, 120);
  if (input.customerPhone !== undefined) out.customer_phone = str(input.customerPhone, 40);
  if (input.customerEmail !== undefined) out.customer_email = str(input.customerEmail, 200);
  if (input.unit !== undefined) out.unit = str(input.unit, 200);
  if (input.loa !== undefined) out.loa = dim(input.loa);
  if (input.beam !== undefined) out.beam = dim(input.beam);
  if (input.notes !== undefined) out.notes = str(input.notes, 2000);
  if (input.assignedTo !== undefined) out.assigned_to = str(input.assignedTo, 80);
  return out;
}

/** A new request, taken in at the counter, on the phone, or off a winter unit. */
function createDetail(token, input) {
  const who = requireShop_(token);
  return createDetailAs_(whoIs_(who), input);
}

function createDetailAs_(by, input) {
  ensureDetailSchema_();
  input = input || {};
  const fields = cleanDetailFields_(input);
  if (!fields.customer_name) throw new Error('Whose is it? Put the customer’s name in.');
  const items = sanitizeDetailItems_(input.items, null);
  if (!items.length) throw new Error('Pick at least one thing to do from the menu.');
  const qn = String(input.winterQn || '').trim().toUpperCase().slice(0, 20);
  const out = withLock_(function () {
    if (qn) {
      const already = rows_('Details').filter(function (r) {
        return r.winter_qn === qn && r.status !== 'cancelled' && r.status !== 'done' && !r.archived_at;
      })[0];
      if (already) return { detail: detailView_(already, null), existed: true, v: detailVersion_() };
    }
    const at = nowIso_();
    const row = Object.assign({
      id: newId_('det'), source: qn ? 'winter' : 'request', job_id: '', winter_qn: qn,
      quote_no: qn ? '' : nextDetailQuoteNo_(),
      items: JSON.stringify(items), status: 'requested', created_by: by,
      created_at: at, updated_at: at
    }, fields);
    appendRow_('Details', row);
    detailEvent_(row.id, 'created', (qn ? 'Winter unit on the board: ' : by === DETAIL_ONLINE_BY_ ? 'Online quote request from '
      : 'New quote request for ') + row.customer_name + ': ' + items.map(function (x) { return x.label; }).join(', '), by);
    const v = bumpDetailVersion_();
    return { detail: detailView_(detailRow_(row.id), null), v: v, row: detailRow_(row.id) };
  });
  // Outside the lock: mail and push are trips out. A quote request is John's
  // to price, so he is told at once (service@ copied, as on all his mail).
  if (out.row && out.row.source === 'request' && !out.existed) {
    notifyNewRequest_(out.row);
    pushNotify_('New quote request', out.row.customer_name + ': ' +
      detailItems_(out.row).map(function (x) { return x.label; }).join(', '), out.row.id);
  }
  delete out.row;
  return out;
}

/**
 * The next D-number. Called inside the lock, so two requests at once cannot
 * take the same one. A script property rather than a count of rows: a
 * cancelled or archived request keeps its number and nothing is ever reused.
 */
const DETAIL_QUOTE_NO_START_ = 1000;
function nextDetailQuoteNo_() {
  const n = Math.max(Number(props_().getProperty('DETAIL_QUOTE_SEQ') || 0), DETAIL_QUOTE_NO_START_) + 1;
  props_().setProperty('DETAIL_QUOTE_SEQ', String(n));
  return 'D-' + n;
}

/**
 * Every quote request the writer's portal shows: taken in, priced, waiting,
 * approved — everything not yet a job (a job is on the jobs list already) and
 * not archived. Newest first.
 */
function detailQuotesForDesk_() {
  if (!ss_().getSheetByName('Details')) return [];
  return rows_('Details').filter(function (r) {
    return !r.archived_at && (r.source || 'request') === 'request' && !r.job_id;
  }).map(function (r) { return detailView_(r, null); })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

/* ------------------------------------------------------- online requests --- */
/*
 * Chris, Nov 7 2026: "a customer facing request a detail site too that feeds
 * into this like the winterizing has." /r/ is that page, and this is the one
 * door it has. It makes exactly what + New quote makes — a quote request on
 * the board, John emailed with service@ copied — and nothing more.
 *
 * It is an unauthenticated write that ends in an email, so:
 *  - ONE EMAIL TO THE ADDRESS IT WAS GIVEN, about this request and nothing
 *    else: "Hold tight! We got your detail request" with its D-number and
 *    what they entered (Chris, Nov 7 2026 — his explicit exception to "a
 *    person sends every customer email", because the customer pressed the
 *    button themselves). The ceilings below are what stop the form being a
 *    way to mail somebody else: three a day per address or phone. Test mode
 *    holds it like every other customer email. John and service@ are told
 *    by notifyNewRequest_, whose recipients are constants.
 *  - NO PRICES COME IN. Every line arrives unpriced; John prices it.
 *  - A FILLED-IN HIDDEN FIELD is a bot: it is thanked and nothing is saved.
 *  - A CEILING: DETAIL_ONLINE_PER_HOUR_ requests an hour from everybody, and
 *    three a day from one phone number or email. Past either it says to call.
 *  - POST only, like every write: not on API_GET_FNS_.
 */
const DETAIL_ONLINE_BY_ = 'Online request';
const DETAIL_ONLINE_PER_HOUR_ = 20;
const DETAIL_ONLINE_PER_CONTACT_ = 3;

function requestDetailOnline(input) {
  input = input || {};
  if (String(input.website || '').trim()) return { ok: true, ref: '' };   // the bot trap
  const str = function (v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n); };
  const name = str(input.name, 120);
  const phone = str(input.phone, 40);
  const email = str(input.email, 200);
  if (!name) throw new Error('Please tell us your name.');
  if (phone.replace(/\D/g, '').length < 10 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Please give us a phone number or an email address so we can send your quote.');
  }
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 30).map(function (x) {
    return { key: /^[A-Za-z]{2,20}$/.test(String(x && x.key || '')) ? String(x.key) : '', label: str(x && x.label, 120),
             group: str(x && x.group, 60), qty: x && x.qty, price: null };
  }).filter(function (x) { return x.label; });
  if (!items.length) throw new Error('Tick at least one thing you would like done.');

  const cache = scriptCache_();
  const hourKey = 'DREQ_H_' + Math.floor(Date.now() / 3600000);
  const contact = 'DREQ_C_' + (phone.replace(/\D/g, '').slice(-10) || email.toLowerCase()).replace(/[^a-z0-9@.]/g, '').slice(0, 80);
  const count = function (k) { try { return Number(cache && cache.get(k) || 0); } catch (e) { return 0; } };
  if (count(hourKey) >= DETAIL_ONLINE_PER_HOUR_ || count(contact) >= DETAIL_ONLINE_PER_CONTACT_) {
    throw new Error('We have had a lot of requests just now. Please call us on ' + SHOP_PHONE + ' and we will take it over the phone.');
  }
  try { if (cache) { cache.put(hourKey, String(count(hourKey) + 1), 3700); cache.put(contact, String(count(contact) + 1), 86400); } } catch (e) { /* no cache, no ceiling */ }

  const notes = [
    str(input.where, 200) ? 'Where it is: ' + str(input.where, 200) : '',
    str(input.contactBy, 40) ? 'Best way to reach them: ' + str(input.contactBy, 40) : '',
    str(input.notes, 1500) ? 'They wrote: ' + str(input.notes, 1500) : ''
  ].filter(String).join('\n');
  const out = createDetailAs_(DETAIL_ONLINE_BY_, { customerName: name, customerPhone: phone, customerEmail: email,
    unit: str(input.unit, 200), loa: input.loa, beam: input.beam, notes: notes, items: items });
  const row = detailRow_(out.detail.id);
  const emailed = sendDetailReceived_(row, { where: str(input.where, 200), contactBy: str(input.contactBy, 40),
    notes: str(input.notes, 1500) });
  return { ok: true, ref: row.quote_no, emailed: emailed, shop: { phone: SHOP_PHONE, email: SERVICE_EMAIL } };
}

/**
 * "Hold tight!" — the customer's own copy of what they asked for, with its
 * D-number. Only ever to the address on this request. Never throws: the
 * request is saved either way, and the page still thanks them.
 */
function sendDetailReceived_(row, extra) {
  const to = normalizeEmails_(row.customer_email);
  if (!to) return false;
  try {
    const rehearsal = testMode_();
    const first = String(row.customer_name || '').split(/[ ,]/).filter(String)[0] || '';
    const kv = function (k, v) {
      return v ? '<tr><td style="' + MAIL_FONT + ';font-size:14px;color:#5C7185;padding:4px 14px 4px 0;vertical-align:top;white-space:nowrap">' +
        esc_(k) + '</td><td style="' + MAIL_FONT + ';font-size:15px;color:#1D2B38;padding:4px 0">' + esc_(v) + '</td></tr>' : '';
    };
    const ft = function (v) { return v ? fmtFtIn_(Number(v)) : ''; };
    const items = detailItems_(row);
    const html = noticeHtml_({
      banner: rehearsal ? mailBox_('#FFF6E0', '#E2C27A', '<b>Test mode.</b> This would have gone to ' + esc_(to) + '.') : '',
      greeting: first,
      intro: '<p style="margin:0 0 12px"><b>Hold tight! We got your detail request.</b> We\u2019ll look it over and send you a ' +
        'quote to accept or decline. Nothing is booked until you say yes.</p>' +
        '<p style="margin:0 0 12px">Your quote number is <b style="font-size:17px">' + esc_(row.quote_no) + '</b> \u2014 mention it if you call.</p>' +
        '<p style="margin:14px 0 4px;font-weight:bold">What you asked for</p><ul style="margin:0 0 12px;padding-left:20px">' +
        items.map(function (x) { return '<li>' + esc_(x.label) + (x.qty > 1 ? ' \u00d7 ' + x.qty : '') + '</li>'; }).join('') + '</ul>' +
        '<p style="margin:14px 0 4px;font-weight:bold">What you told us</p>' +
        '<table role="presentation" border="0" cellpadding="0" cellspacing="0">' +
          kv('Name', row.customer_name) + kv('Phone', row.customer_phone) + kv('Email', row.customer_email) +
          kv('Unit', row.unit) + kv('Where it is', extra && extra.where) + kv('Length', ft(row.loa)) + kv('Beam', ft(row.beam)) +
          kv('Send my quote by', extra && extra.contactBy) + kv('Notes', extra && extra.notes) +
        '</table>' +
        '<p style="font-size:13px;color:#5C7185;line-height:19px;margin:16px 0 0">Got something wrong? Just reply to this email or give us a call.</p>'
    });
    return send_({
      to: rehearsal ? testEmail_() : to, subject: (rehearsal ? '[TEST] ' : '') + 'Hold tight! We got your detail request (' + row.quote_no + ')',
      html: html, text: 'We got your detail request. Your quote number is ' + row.quote_no + '.', jobId: row.id,
      kind: 'detail_received', suppressed: rehearsal, intendedFor: to
    });
  } catch (err) {
    return false;
  }
}

/** Feet and inches, the way a tape reads: 22' 6". */
function fmtFtIn_(v) {
  if (!isFinite(v) || v <= 0) return '';
  let ft = Math.floor(v), inch = Math.round((v - ft) * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return ft + "'" + (inch ? ' ' + inch + '"' : '');
}

/** The detail's own page in the Detail Tracker. */
function detailUrl_(id) {
  return SITE_URL + '/d/?detail=' + encodeURIComponent(id);
}

/*
 * THE SHOP'S OWN DETAIL EMAILS — to John and the desk, never a customer.
 * Chris, Nov 7 2026: they "look bare and the notes not having linebreaks
 * makes it extremely awkward to read". Same frame as the customer mail
 * (noticeHtml_'s wordmark, gold rule and navy footer, so the inline logo is
 * shown rather than arriving as a stray attachment), a coloured heading that
 * says what happened, the customer as a table with tap-to-call, the lines with
 * their prices, the notes with their line breaks, and one big button.
 *
 * No emoji in a subject: Outlook on Windows showed "📞" as "??????".
 */
const STAFF_TONES_ = {
  navy: ['#14293E', '#FFFFFF'], gold: ['#C08A22', '#FFFFFF'], red: ['#B3261E', '#FFFFFF'], green: ['#1E6B3A', '#FFFFFF']
};

function staffMailHtml_(o) {
  const tone = STAFF_TONES_[o.tone] || STAFF_TONES_.navy;
  const cell = function (style, body) { return '<td style="' + MAIL_FONT + ';' + style + '">' + body + '</td>'; };
  const logo = logoBlob_()
    ? '<img src="cid:questlogo" alt="' + esc_(SHOP_NAME) + '" width="104" height="56" style="width:104px;height:56px;display:block;border:0">'
    : '<div style="font-family:Arial Black,Arial,sans-serif;font-size:22px;color:#14293E">' + esc_(SHOP_NAME.toUpperCase()) + '</div>';
  const section = function (title) {
    return '<div style="' + MAIL_FONT + ';font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;' +
      'color:#4A81A6;margin:20px 0 8px">' + esc_(title) + '</div>';
  };
  const rows = (o.rows || []).filter(function (r) { return r[1]; }).map(function (r) {
    return '<tr>' + cell('font-size:13.5px;color:#5C7185;padding:5px 16px 5px 0;vertical-align:top;white-space:nowrap', esc_(r[0])) +
      cell('font-size:15px;color:#1D2B38;padding:5px 0;vertical-align:top', r[2] ? r[1] : esc_(r[1])) + '</tr>';
  }).join('');
  const STATE = { accepted: ['Accepted', '#1E6B3A'], declined: ['Declined', '#5C7185'], call: ['Call me', '#B3261E'],
    pending: ['Waiting on customer', '#9C6E14'] };
  const lines = (o.lines || []).map(function (x) {
    const st = x.state && STATE[x.state];
    return '<tr>' + cell('font-size:15px;color:#1D2B38;padding:8px 0;border-bottom:1px solid #EBF1F6',
        esc_(x.label) + (x.qty > 1 ? ' &times; ' + x.qty : '') +
        (st ? '<br><span style="font-size:12.5px;font-weight:bold;color:' + st[1] + '">' + st[0] + '</span>' : '')) +
      cell('font-size:15px;color:#1D2B38;padding:8px 0 8px 16px;border-bottom:1px solid #EBF1F6;text-align:right;white-space:nowrap;vertical-align:top',
        x.price === null || x.price === undefined ? '<span style="color:#9AA8B5">to price</span>' : esc_(money_(x.price))) + '</tr>';
  }).join('');
  const multiline = function (text) {
    return String(text || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l) {
      const m = l.match(/^([A-Z][^:]{1,30}):\s*(.*)$/);
      return m ? '<b>' + esc_(m[1]) + ':</b> ' + esc_(m[2]) : esc_(l);
    }).join('<br>');
  };
  const body =
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="' + tone[0] + '" style="background:' + tone[0] + ';border-radius:8px">' +
      '<tr>' + cell('padding:14px 18px;color:' + tone[1],
        (o.quoteNo ? '<div style="font-size:13px;font-weight:bold;letter-spacing:1px;opacity:.85">' + esc_(o.quoteNo) + '</div>' : '') +
        '<div style="font-size:20px;font-weight:bold;line-height:26px">' + esc_(o.heading) + '</div>' +
        (o.sub ? '<div style="font-size:14px;line-height:20px;margin-top:3px">' + esc_(o.sub) + '</div>' : '')) + '</tr></table>' +
    (o.ask ? '<div style="margin:16px 0 0">' + mailBox_('#FDECEA', '#E8B4B0', '<div style="' + MAIL_FONT + ';font-size:13px;font-weight:bold;color:#B3261E;margin-bottom:4px">THEY ASKED</div>' +
      '<div style="' + MAIL_FONT + ';font-size:15px;line-height:22px;color:#1D2B38">' + multiline(o.ask) + '</div>') + '</div>' : '') +
    (rows ? section('Customer') + '<table role="presentation" border="0" cellpadding="0" cellspacing="0">' + rows + '</table>' : '') +
    (lines ? section(o.linesTitle || 'What they want') + '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">' + lines +
      (o.total !== undefined ? '<tr>' + cell('font-size:15px;font-weight:bold;padding:10px 0 0', esc_(o.totalLabel || 'Total')) +
        cell('font-size:15px;font-weight:bold;padding:10px 0 0 16px;text-align:right;white-space:nowrap', esc_(money_(o.total))) + '</tr>' : '') +
      '</table>' : '') +
    (o.notes ? section('Notes') + '<div style="' + MAIL_FONT + ';font-size:15px;line-height:23px;color:#1D2B38;background:#F4F7FA;' +
      'border-left:4px solid #C7D5E0;padding:10px 14px">' + multiline(o.notes) + '</div>' : '') +
    (o.next ? '<p style="' + MAIL_FONT + ';font-size:15px;line-height:22px;color:#1D2B38;margin:20px 0 0">' + o.next + '</p>' : '') +
    (o.button ? '<div style="margin:20px 0 0">' + button_(o.button.url, o.button.label, o.tone === 'gold' ? '#C08A22' : '') + '</div>' : '');
  return '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#EBF1F6" style="background:#EBF1F6">' +
    '<tr><td align="center" style="padding:20px 10px">' +
    '<!--[if mso]><table role="presentation" width="620" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->' +
    '<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="max-width:620px;background:#FFFFFF;border:1px solid #C7D5E0">' +
      '<tr><td bgcolor="#FFFFFF" style="padding:18px 24px;border-bottom:4px solid #C08A22">' + logo + '</td></tr>' +
      '<tr><td bgcolor="#FFFFFF" style="padding:22px 24px 26px">' + body + '</td></tr>' +
      '<tr><td bgcolor="#14293E" style="background:#14293E;padding:14px 24px;' + MAIL_FONT + ';font-size:12px;line-height:18px;color:#B9CDDD;text-align:center">' +
        'Detail Tracker &middot; for the shop, not the customer</td></tr>' +
    '</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table>';
}

/** The customer as table rows: tap-to-call, tap-to-email, the unit and its size. */
function detailCustomerRows_(row) {
  const phone = String(row.customer_phone || '');
  const digits = phone.replace(/\D/g, '');
  const ft = function (v) { return v ? fmtFtIn_(Number(v)) : ''; };
  return [
    ['Name', row.customer_name],
    ['Phone', phone ? (digits.length >= 10 ? '<a href="tel:+1' + digits.slice(-10) + '" style="color:#14293E;font-weight:bold">' + esc_(phone) + '</a>' : esc_(phone)) : '', true],
    ['Email', row.customer_email ? '<a href="mailto:' + esc_(row.customer_email) + '" style="color:#4A81A6">' + esc_(row.customer_email) + '</a>' : '', true],
    ['Unit', row.unit],
    ['Size', [ft(row.loa) ? ft(row.loa) + ' long' : '', ft(row.beam) ? ft(row.beam) + ' beam' : ''].filter(String).join(', ')],
    ['Work order', row.ticket_no || row.job_id],
    ['Winter quote', row.winter_qn]
  ];
}

/** John: a new quote to price. To him, service@ copied. Never the customer. */
function notifyNewRequest_(row) {
  const online = row.created_by === DETAIL_ONLINE_BY_;
  const subject = (online ? 'New detail quote requested online: ' : 'New detail quote requested: ') +
    row.customer_name + (row.quote_no ? ' (' + row.quote_no + ')' : '');
  const html = staffMailHtml_({
    tone: 'gold', quoteNo: row.quote_no,
    heading: 'New quote to price' + (online ? ' — requested online' : row.job_id ? ' — on work order ' + row.job_id : ''),
    sub: online ? 'The customer filled in the Request a detail page.'
      : row.job_id ? 'The work order is in for confirmed work; they want these quoted while it is in the shop.'
      : 'Taken in by ' + (row.created_by || 'the desk') + '.',
    rows: detailCustomerRows_(row),
    // On a work order, only the lines still to price — not ones already agreed.
    lines: detailItems_(row).filter(function (x) { return !row.job_id || !x.quote; })
      .map(function (x) { return { label: x.label, qty: x.qty, price: x.price }; }),
    notes: row.notes,
    button: { url: detailUrl_(row.id), label: 'Price it and send the quote' }
  });
  send_({ to: DETAIL_ALERT_EMAIL, cc: SERVICE_EMAIL, subject: subject, html: html, text: subject + ' — ' + detailUrl_(row.id),
          jobId: row.id, kind: 'detail_request' });
}

/** The desk: the work is done, call the customer and collect. */
function notifyDetailDone_(row) {
  const items = detailItems_(row).filter(detailDoable_);
  const total = items.reduce(function (t, x) { return t + (Number(x.price) || 0); }, 0);
  const winter = !!row.winter_qn;
  const subject = 'Detail done — contact ' + row.customer_name + (winter ? '' : ' and collect payment') +
    (row.quote_no ? ' (' + row.quote_no + ')' : '');
  const next = winter ? 'This is on winter quote <b>' + esc_(row.winter_qn) + '</b> — it is billed there.'
    : row.job_id ? 'Close out job <b>' + esc_(row.job_id) + '</b> in the portal as usual: invoice, payment, send.'
    : 'Contact the customer and collect payment' + (row.ticket_no ? ' on work order <b>' + esc_(row.ticket_no) + '</b>.'
      : ' — there is no work order number on it yet.');
  const html = staffMailHtml_({
    tone: 'green', quoteNo: row.quote_no,
    heading: winter ? 'Detail done' : 'Detail done — time to collect',
    sub: (row.done_by || 'The detailer') + ' marked it done.',
    rows: detailCustomerRows_(row),
    linesTitle: 'What was done',
    lines: items.map(function (x) { return { label: x.label, qty: x.qty, price: x.price }; }),
    total: total, totalLabel: 'Approved total (before tax)',
    next: next,
    button: row.job_id ? { url: SITE_URL + '/admin/?job=' + encodeURIComponent(row.job_id), label: 'Open job ' + row.job_id }
      : { url: detailUrl_(row.id), label: 'Open it in the Detail Tracker' }
  });
  send_({ to: SERVICE_EMAIL, subject: subject, html: html, text: subject, jobId: row.job_id || row.id, kind: 'detail_done' });
}

/** Lines, dimensions, notes, who has it. Ticks and answers ride through on each line. */
function updateDetail(token, id, input) {
  const who = requireShop_(token);
  ensureDetailSchema_();
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    const patch = cleanDetailFields_(input || {});
    // Measured: say so in its history, the way it was read off the tape.
    const measured = (patch.loa !== undefined && String(patch.loa) !== String(row.loa || '') && patch.loa) ||
      (patch.beam !== undefined && String(patch.beam) !== String(row.beam || '') && patch.beam);
    if (input && input.items) {
      const items = sanitizeDetailItems_(input.items, detailItems_(row));
      if (!items.length) throw new Error('A detail needs at least one line. Cancel it instead.');
      patch.items = JSON.stringify(items);
    }
    patch.updated_at = nowIso_();
    updateRow_('Details', row._row, patch);
    if (measured) {
      const L = patch.loa !== undefined ? patch.loa : row.loa, B = patch.beam !== undefined ? patch.beam : row.beam;
      detailEvent_(row.id, 'note', whoIs_(who) + ' measured it: ' + [L ? fmtFtIn_(Number(L)) + ' long' : '',
        B ? fmtFtIn_(Number(B)) + ' beam' : ''].filter(String).join(', '), whoIs_(who));
    }
    const v = bumpDetailVersion_();
    return { detail: detailView_(detailRow_(id), row.job_id ? jobRow_(row.job_id) : null), v: v };
  });
}

/** The job a detail belongs to moves on when its detail does. */
function startJobForDetail_(row, by) {
  if (!row.job_id) return;
  const job = jobRow_(row.job_id);
  if (job && job.status === 'received') setStatus_(job, 'work_underway', 'detailer', by, 'Detail started');
}

/** Tick a line off, or put it back. A first tick starts the detail. */
function setDetailItemDone(token, id, itemId, done) {
  const who = requireShop_(token);
  const by = whoIs_(who);
  const out = withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    if (row.status === 'done' || row.status === 'cancelled') throw new Error('This detail is closed. Re-open it first.');
    const items = detailItems_(row);
    const item = items.filter(function (x) { return x.id === String(itemId || ''); })[0];
    if (!item) throw new Error('That line is not on this detail any more. Pull it up again.');
    if (done && !detailDoable_(item)) {
      throw new Error(item.quote === 'declined' ? 'The customer declined that one.' : 'That one is still waiting on the customer.');
    }
    item.done = done ? { by: by, at: nowIso_() } : null;
    const patch = { items: JSON.stringify(items), updated_at: nowIso_() };
    if (done && row.status === 'requested') { patch.status = 'in_progress'; patch.started_at = nowIso_(); }
    updateRow_('Details', row._row, patch);
    if (done) startJobForDetail_(row, by);
    const v = bumpDetailVersion_();
    return { row: detailRow_(id), item: item, v: v };
  });
  if (out.row.winter_qn && out.item.winter) syncDetailToWinter_(out.row);
  return { detail: detailView_(out.row, out.row.job_id ? jobRow_(out.row.job_id) : null), v: out.v };
}

function startDetail(token, id) {
  const who = requireShop_(token);
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    if (row.status === 'requested') {
      updateRow_('Details', row._row, { status: 'in_progress', started_at: nowIso_(), updated_at: nowIso_(),
        assigned_to: row.assigned_to || whoIs_(who) });
      startJobForDetail_(row, whoIs_(who));
      detailEvent_(row.id, 'started', whoIs_(who) + ' started the detail for ' + row.customer_name, whoIs_(who));
    }
    const v = bumpDetailVersion_();
    return { detail: detailView_(detailRow_(id), row.job_id ? jobRow_(row.job_id) : null), v: v };
  });
}

/**
 * The detailer's half is done. Every line still to do is ticked by them; a
 * line still waiting on the customer stops it, because finishing would leave
 * work the customer may yet say yes to.
 *
 * On a work order this is the detailer's mark: a detail-only job moves to
 * Work finished, and a split job does when the mechanic has finished too.
 */
function finishDetail(token, id) {
  const who = requireShop_(token);
  const by = whoIs_(who);
  const out = withLock_(function () {
    forget_('Details');
    forget_('Jobs');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    if (row.status === 'done') return { row: row, already: true };
    if (row.status === 'cancelled') throw new Error('That detail was cancelled.');
    const items = detailItems_(row);
    const waiting = items.filter(function (x) { return x.quote === 'pending' || x.quote === 'call'; });
    if (waiting.length) {
      throw new Error(waiting.length + (waiting.length === 1 ? ' line is' : ' lines are') +
        ' still waiting on the customer (' + waiting.map(function (x) { return x.label; }).join(', ') +
        '). Get their answer, or mark it for them, first.');
    }
    const at = nowIso_();
    items.forEach(function (x) { if (detailDoable_(x) && !x.done) x.done = { by: by, at: at }; });
    updateRow_('Details', row._row, { items: JSON.stringify(items), status: 'done', done_at: at, done_by: by,
      started_at: row.started_at || at, updated_at: at });
    let jobNote = '';
    if (row.job_id) {
      const job = jobRow_(row.job_id);
      if (job && job.status !== 'done') {
        updateRow_('Jobs', job._row, { detail_done_at: at, updated_at: at });
        forget_('Jobs');
        const fresh = jobRow_(row.job_id);
        const split = String(fresh.detail_split || '');
        if (split === 'detail' || (split === 'both' && fresh.mech_done_at)) {
          if (fresh.status === 'received') setStatus_(fresh, 'work_underway', 'detailer', by, 'Detail started');
          setStatus_(jobRow_(row.job_id), 'work_finished', 'detailer', by,
            split === 'both' ? 'Detail finished — mechanic already done' : 'Detail finished');
          jobNote = ' Job ' + row.job_id + ' is ready to close out.';
        } else if (split === 'both') {
          jobNote = ' Job ' + row.job_id + ' is still waiting on the mechanic.';
        }
      }
    }
    detailEvent_(row.id, 'done', by + ' finished the detail for ' + row.customer_name + '.' + jobNote, by);
    return { row: detailRow_(id), jobNote: jobNote, v: bumpDetailVersion_() };
  });
  if (out.row.winter_qn) syncDetailToWinter_(out.row);
  // The desk hears when there is a customer to call: a detail of its own, or
  // a job whose last half this was. Not a split job still waiting on the mechanic.
  if (!out.already && (!out.row.job_id || /ready to close out/.test(out.jobNote))) {
    notifyDetailDone_(out.row);
    pushNotify_('Detail done', out.row.customer_name + ' — ' + (out.row.winter_qn ? 'winter quote ' + out.row.winter_qn
      : out.row.job_id ? 'job ' + out.row.job_id + ' is ready to close out' : 'contact them and collect payment'), out.row.id);
  } else if (out.jobNote && !out.already) {
    pushNotify_('Detail done', out.row.customer_name + ' —' + out.jobNote, out.row.id);
  }
  return { detail: detailView_(out.row, out.row.job_id ? jobRow_(out.row.job_id) : null),
           jobNote: out.jobNote, v: out.v || detailVersion_() };
}

/** Back from Done, or Cancel / un-cancel. Writer or detailer. */
function setDetailStatus(token, id, to) {
  const who = requireShop_(token);
  if (to !== 'requested' && to !== 'cancelled' && to !== 'archived' && to !== 'unarchived') {
    throw new Error('That status change is not allowed.');
  }
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    const at = nowIso_();
    const patch = { updated_at: at };
    if (to === 'archived') patch.archived_at = at;
    else if (to === 'unarchived') patch.archived_at = '';
    else {
      patch.status = to;
      if (to === 'requested') { patch.done_at = ''; patch.done_by = ''; }
      if (to === 'cancelled') patch.done_at = at;
      if (row.job_id) {
        const job = jobRow_(row.job_id);
        if (job && job.status !== 'done') updateRow_('Jobs', job._row, { detail_done_at: '', updated_at: at });
      }
      detailEvent_(row.id, to, whoIs_(who) + (to === 'cancelled' ? ' cancelled' : ' re-opened') +
        ' the detail for ' + row.customer_name, whoIs_(who));
    }
    updateRow_('Details', row._row, patch);
    const v = bumpDetailVersion_();
    return { detail: detailView_(detailRow_(id), row.job_id ? jobRow_(row.job_id) : null), v: v };
  });
}

/* --------------------------- split work orders --------------------------- */

/**
 * The writer ticking Detail on a work order, at intake or on the job page.
 * `input` is { split: 'detail'|'both', items, loa, beam, notes }; null takes
 * the detail off (cancels it) and makes the job the mechanic's alone again.
 */
function setJobDetail(token, jobId, input) {
  const who = requireAdmin_(token);
  ensureDetailSchema_();
  const out = withLock_(function () {
    forget_('Jobs');
    forget_('Details');
    const job = jobRow_(jobId);
    if (!job) throw new Error('No such job.');
    if (isPartsOrder_(job)) throw new Error('A parts order has nothing to detail.');
    if (job.status === 'done') throw new Error('That job is closed out already.');
    const at = nowIso_();
    let row = detailForJob_(job.id);
    if (!input) {
      if (row) {
        updateRow_('Details', row._row, { status: 'cancelled', done_at: at, updated_at: at });
        detailEvent_(row.id, 'cancelled', 'Detail taken off job ' + job.id, whoIs_(who));
      }
      updateRow_('Jobs', job._row, { detail_split: '', detail_done_at: '', updated_at: at });
      bumpDetailVersion_();
      return { job: jobSummary_(jobRow_(job.id)), detail: null };
    }
    const split = String(input.split || '');
    if (split !== 'detail' && split !== 'both') throw new Error('Say who is on it: the detailer alone, or the mechanic and the detailer.');
    const items = sanitizeDetailItems_(input.items, row ? detailItems_(row) : null);
    if (!items.length) throw new Error('Tick at least one thing for the detailer.');
    /* "Quote these first" (Chris, Nov 7 2026): the mechanical work on the
       ticket is confirmed, the detail is not. The lines go in with no price,
       John is emailed to price and send them, and only what the customer
       accepts becomes the detailer's work. Lines already answered or done
       keep what they have. */
    const quoteFirst = input.quote === true;
    let newlyToQuote = false;
    if (quoteFirst) {
      items.forEach(function (x) {
        if (!x.quote && !x.done && !x.winter) { if (x.price !== null) x.price = null; newlyToQuote = true; }
      });
    }
    const fields = cleanDetailFields_({ loa: input.loa, beam: input.beam, notes: input.notes });
    const jobPatch = { detail_split: split, updated_at: at };
    if (row) {
      updateRow_('Details', row._row, Object.assign(fields, { items: JSON.stringify(items), updated_at: at,
        customer_name: job.customer_name, customer_phone: job.customer_phone, customer_email: job.customer_email,
        unit: job.boat_info }, quoteFirst && !row.quote_no ? { quote_no: nextDetailQuoteNo_() } : {}));
      if (row.status === 'done') {
        // A line added to a finished detail re-opens it.
        if (items.some(function (x) { return detailDoable_(x) && !x.done; })) {
          updateRow_('Details', row._row, { status: 'in_progress', done_at: '', done_by: '' });
          jobPatch.detail_done_at = '';
        }
      }
    } else {
      row = Object.assign({ id: newId_('det'), source: 'job', job_id: job.id, winter_qn: '',
        customer_name: job.customer_name, customer_phone: job.customer_phone, customer_email: job.customer_email,
        unit: job.boat_info, items: JSON.stringify(items), status: 'requested', created_by: whoIs_(who),
        created_at: at, updated_at: at, quote_no: quoteFirst ? nextDetailQuoteNo_() : '' }, fields);
      appendRow_('Details', row);
      detailEvent_(row.id, 'created', 'Job ' + job.id + ' (' + (job.customer_name || 'no name') + ') sent to detail: ' +
        items.map(function (x) { return x.label; }).join(', '), whoIs_(who));
      jobPatch.detail_done_at = '';
    }
    updateRow_('Jobs', job._row, jobPatch);
    bumpDetailVersion_();
    forget_('Details');
    const fresh = jobRow_(job.id);
    const saved = detailForJob_(job.id);
    return { job: jobSummary_(fresh), detail: detailView_(saved, fresh), row: newlyToQuote ? saved : null };
  });
  // John prices it: told once there is something new to price on it.
  if (out.row) {
    notifyNewRequest_(out.row);
    pushNotify_('New quote request', out.row.customer_name + ' (job ' + out.row.job_id + '): ' +
      detailItems_(out.row).filter(function (x) { return !x.quote; }).map(function (x) { return x.label; }).join(', '), out.row.id);
  }
  delete out.row;
  return out;
}

/**
 * A detail on a work order the customer declined in full: there is nothing
 * for the detailer to do, so its half of the ticket is closed rather than
 * holding the job at "waiting on detail" for ever. The job then finishes
 * when the mechanic does (or now, if they already have, or if there is no
 * mechanic on it). The desk and John are told. Never throws.
 */
function settleDeclinedDetail_(id) {
  try {
    const out = withLock_(function () {
      forget_('Details');
      forget_('Jobs');
      const row = detailRow_(id);
      if (!row || !row.job_id || row.status === 'done' || row.status === 'cancelled') return null;
      const items = detailItems_(row);
      if (!items.length || items.some(function (x) { return detailDoable_(x) || x.quote === 'pending' || x.quote === 'call'; })) return null;
      const at = nowIso_();
      updateRow_('Details', row._row, { status: 'done', done_at: at, done_by: 'Declined by the customer', updated_at: at });
      const job = jobRow_(row.job_id);
      let note = '';
      if (job && job.status !== 'done') {
        updateRow_('Jobs', job._row, { detail_done_at: at, updated_at: at });
        forget_('Jobs');
        const fresh = jobRow_(row.job_id);
        const split = String(fresh.detail_split || '');
        if (split === 'detail' || (split === 'both' && fresh.mech_done_at)) {
          if (fresh.status === 'received') setStatus_(fresh, 'work_underway', 'detailer', 'Customer', 'Detail declined');
          setStatus_(jobRow_(row.job_id), 'work_finished', 'detailer', 'Customer', 'Detail declined — nothing to do');
          note = 'Job ' + row.job_id + ' is ready to close out.';
        } else {
          note = 'Job ' + row.job_id + ' finishes when the mechanic does.';
        }
      }
      detailEvent_(row.id, 'done', row.customer_name + ' declined all the detail — nothing for the detailer. ' + note, 'Customer');
      bumpDetailVersion_();
      return { row: detailRow_(id), note: note };
    });
    if (!out) return false;
    const subject = 'Detail declined on job ' + out.row.job_id + ': ' + out.row.customer_name + (out.row.quote_no ? ' (' + out.row.quote_no + ')' : '');
    send_({ to: SERVICE_EMAIL, cc: DETAIL_ALERT_EMAIL, subject: subject, kind: 'detail_declined', jobId: out.row.job_id, text: subject,
      html: staffMailHtml_({ tone: 'navy', quoteNo: out.row.quote_no, heading: 'Detail declined — nothing for the detailer',
        sub: 'The customer said no to every detail line on job ' + out.row.job_id + '.', rows: detailCustomerRows_(out.row),
        linesTitle: 'Declined', lines: detailItems_(out.row).map(function (x) { return { label: x.label, qty: x.qty, price: x.price, state: x.quote }; }),
        next: esc_(out.note), button: { url: SITE_URL + '/admin/?job=' + encodeURIComponent(out.row.job_id), label: 'Open job ' + out.row.job_id } }) });
    pushNotify_('Detail declined', out.row.customer_name + ' — ' + out.note, out.row.id);
    return true;
  } catch (err) {
    return false;
  }
}

/** What the writer's list and job page say about the split. Off the row alone. */
function jobDetailSummary_(job) {
  const split = String(job.detail_split || '');
  if (!split) return null;
  const mechDone = split === 'detail' || !!job.mech_done_at;
  const detailDone = !!job.detail_done_at;
  return {
    split: split, splitLabel: DETAIL_SPLITS_[split] || split,
    mechDoneAt: job.mech_done_at || null, detailDoneAt: job.detail_done_at || null,
    waitingOn: mechDone && detailDone ? '' : (!mechDone && !detailDone ? 'both' : (!mechDone ? 'mechanic' : 'detail'))
  };
}

/* ---------------------------- the quote ---------------------------------- */

/**
 * Send lines for the customer's answer. Mints the code (once — a re-quote keeps
 * the link already in their inbox) and marks the lines pending. Sends nothing:
 * the email and the text are their own buttons.
 */
function quoteDetail(token, id, itemIds) {
  const who = requireShop_(token);
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    if (row.source === 'winter') throw new Error('Winter quotes are priced and sent from the winter console or Harbor Haul Out.');
    const want = (itemIds || []).map(String);
    const items = detailItems_(row);
    let n = 0;
    items.forEach(function (x) {
      if (want.length && want.indexOf(x.id) === -1) return;
      if (x.quote === 'accepted' || x.quote === 'declined' || x.done) return;
      if (x.price === null) throw new Error('Put a price on “' + x.label + '” before quoting it.');
      x.quote = 'pending';
      n += 1;
    });
    if (!n) throw new Error('Nothing to quote: every line is already answered or done.');
    const patch = { items: JSON.stringify(items), updated_at: nowIso_() };
    if (!row.quote_code) patch.quote_code = newInvoiceCode_();
    updateRow_('Details', row._row, patch);
    detailEvent_(row.id, 'quoted', whoIs_(who) + ' quoted ' + n + (n === 1 ? ' line' : ' lines') + ' for ' + row.customer_name, whoIs_(who));
    const v = bumpDetailVersion_();
    const fresh = detailRow_(id);
    return { detail: detailView_(fresh, null), text: detailQuoteMessage_(fresh), v: v };
  });
}

function detailQuoteMessage_(row) {
  const first = String(row.customer_name || '').split(/[ ,]/).filter(String)[0] || '';
  const name = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
  return (name ? 'Hi ' + name + ', ' : 'Hi, ') + SHOP_NAME + ' here. Your detailing quote is ready — accept, ' +
    'decline or ask us to call: ' + detailQuoteUrl_(row.quote_code);
}

/** John's prices onto the lines: {itemId: price}. A line already answered keeps its figure. */
function setDetailPrices_(id, prices) {
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    const items = detailItems_(row);
    let dirty = false;
    Object.keys(prices || {}).forEach(function (itemId) {
      const x = items.filter(function (i) { return i.id === itemId; })[0];
      if (!x || x.winter || x.quote === 'accepted' || x.quote === 'declined' || x.done) return;
      const p = money2orNull_(prices[itemId]);
      if (p !== x.price) { x.price = p; dirty = true; }
    });
    if (dirty) updateRow_('Details', row._row, { items: JSON.stringify(items), updated_at: nowIso_() });
    return detailRow_(id);
  });
}

/**
 * "Send quote to customer" — John's one button. Saves his prices, puts every
 * priced line not yet answered in front of the customer, and sends it:
 * `via` 'email' emails it now; 'text' hands back the wording for him to send
 * from his phone (and say so with markDetailQuoteSent). Pressing it is the
 * send, so this is rule 4's own button, not a send riding on something else.
 */
function sendDetailQuote(token, id, prices, via) {
  requireShop_(token);
  const row = setDetailPrices_(id, prices);
  const missing = detailItems_(row).filter(function (x) { return !x.quote && !x.done && x.price === null; });
  if (missing.length) {
    throw new Error('Put a price on ' + missing.map(function (x) { return '\u201c' + x.label + '\u201d'; }).join(', ') + ' first.');
  }
  const quoted = quoteDetail(token, id, []);
  if (via === 'email') {
    const sent = sendDetailQuoteEmail(token, id);
    return { detail: detailView_(detailRow_(id), null), emailed: true, testMode: sent.testMode, v: detailVersion_() };
  }
  return { detail: quoted.detail, text: quoted.text, phone: row.customer_phone || '', v: quoted.v };
}

/**
 * The customer already said yes — at the counter, on the phone — so there is
 * no quote to send. Every priced line not yet answered becomes accepted, by
 * whoever pressed it, and the detail goes on to the work order.
 */
function acceptDetailForCustomer(token, id, prices) {
  const who = requireShop_(token);
  setDetailPrices_(id, prices);
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    const items = detailItems_(row);
    const missing = items.filter(function (x) { return !x.quote && !x.done && x.price === null && !x.winter; });
    if (missing.length) throw new Error('Put a price on every line first, so the work order has the figures.');
    let n = 0;
    items.forEach(function (x) {
      if (x.quote || x.done || x.winter) return;
      x.quote = 'accepted'; x.answeredAt = nowIso_(); x.answeredBy = whoIs_(who); n += 1;
    });
    if (!n) throw new Error('Nothing left to agree to.');
    updateRow_('Details', row._row, { items: JSON.stringify(items), updated_at: nowIso_() });
    detailEvent_(row.id, 'answer', whoIs_(who) + ' marked the quote for ' + row.customer_name + ' as already agreed', whoIs_(who));
    return { detail: detailView_(detailRow_(id), null), v: bumpDetailVersion_() };
  });
}

/**
 * The work order goes on, and the detail becomes a job in the writer's portal.
 *
 * Chris, Nov 7 2026: "this detail app should just be the detail version of the
 * mechanic app but the service writer still has the same work to do either
 * way." So an approved quote request, once its BiT work order is written, is a
 * job like any other: a detailer-only job (`detail_split: 'detail'`) under the
 * BiT number, carrying the customer, the unit and the approved lines. The
 * detailer marking it done moves it to Work finished on the writer's list,
 * exactly as a mechanic's Work finished does, and the writer closes it out —
 * invoice, payment, email or text — the way every job is closed out.
 *
 * If the writer already loaded that work order through intake, the detail is
 * linked to that job instead of making a second one.
 */
function linkDetailJob(token, id, ticketNo) {
  const who = requireShop_(token);
  ensureDetailSchema_();
  const ticket = String(ticketNo || '').trim().toUpperCase().slice(0, 30);
  if (!ticket) throw new Error('Type the BiT work order number.');
  const out = withLock_(function () {
    forget_('Details');
    forget_('Jobs');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    if (row.status === 'cancelled') throw new Error('That detail was cancelled.');
    if (row.job_id) throw new Error('This detail is already job ' + row.job_id + '.');
    const items = detailItems_(row);
    if (items.some(function (x) { return x.quote === 'pending' || x.quote === 'call'; })) {
      throw new Error('Some lines are still waiting on the customer. Get their answer first.');
    }
    const doable = items.filter(detailDoable_);
    if (!doable.length) throw new Error('Nothing on this detail was approved, so there is no work order to make.');
    let job = jobRow_(ticket) || jobByNumber_(ticket);
    let made = false;
    if (job) {
      if (isPartsOrder_(job)) throw new Error(job.id + ' is a parts order, not a work order.');
      if (job.status === 'done') throw new Error('Job ' + job.id + ' is already closed out.');
      const other = detailForJob_(job.id);
      if (other && other.id !== row.id) throw new Error('Job ' + job.id + ' already has a detail on it (' + (other.quote_no || other.id) + ').');
    } else {
      const lines = doable.map(function (x) {
        return x.label + (x.qty > 1 ? ' \u00d7 ' + x.qty : '') + (x.price !== null ? ' \u2014 ' + money_(x.price) : '');
      });
      createJobRow_(ticket, {
        customerName: row.customer_name, customerPhone: row.customer_phone, customerEmail: row.customer_email,
        boatInfo: row.unit, intakeNote: 'Made from detail quote ' + (row.quote_no || row.id),
        workRequested: 'Detail' + (row.quote_no ? ' ' + row.quote_no : '') + ':\n' + lines.join('\n') + (row.notes ? '\n\n' + row.notes : '')
      });
      job = jobRow_(ticket);
      made = true;
    }
    const at = nowIso_();
    updateRow_('Jobs', job._row, { detail_split: String(job.detail_split || '') === 'both' ? 'both' : 'detail',
      detail_done_at: row.status === 'done' ? (row.done_at || at) : '', updated_at: at });
    updateRow_('Details', row._row, { job_id: job.id, ticket_no: job.id, updated_at: at });
    forget_('Jobs');
    // Already finished before the work order went on: the job is ready to close out.
    if (row.status === 'done') {
      const j = jobRow_(job.id);
      if (j.status === 'received') setStatus_(j, 'work_underway', 'detailer', row.done_by, 'Detail already done');
      setStatus_(jobRow_(job.id), 'work_finished', 'detailer', row.done_by, 'Detail already done');
    } else if (row.status === 'in_progress') {
      const j = jobRow_(job.id);
      if (j.status === 'received') setStatus_(j, 'work_underway', 'detailer', whoIs_(who), 'Detail started');
    }
    detailEvent_(row.id, 'job', (made ? 'Job ' + job.id + ' made from ' : 'Linked to job ' + job.id + ': ') +
      (row.quote_no || 'this detail') + ' (' + row.customer_name + ')', whoIs_(who));
    forget_('Details');
    return { detail: detailView_(detailRow_(id), jobRow_(job.id)), job: jobSummary_(jobRow_(job.id)), made: made,
             v: bumpDetailVersion_() };
  });
  return out;
}

/** The wording and number for a text. Not a send — a person sends it. */
function detailQuoteText(token, id) {
  requireShop_(token);
  const row = detailRow_(id);
  if (!row) throw new Error('No such detail.');
  if (!row.quote_code) throw new Error('Quote some lines first.');
  return { text: detailQuoteMessage_(row), phone: row.customer_phone || '' };
}

/** "I have sent it" — the only thing that records a text going out. */
function markDetailQuoteSent(token, id, how) {
  const who = requireShop_(token);
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    updateRow_('Details', row._row, { quote_sent_at: nowIso_(), updated_at: nowIso_() });
    detailEvent_(row.id, 'sent', whoIs_(who) + ' texted the quote to ' + row.customer_name, whoIs_(who));
    return { detail: detailView_(detailRow_(id), null), v: bumpDetailVersion_() };
  });
}

/** The quote by email: its own button, and the only send in this section. */
function sendDetailQuoteEmail(token, id) {
  const who = requireShop_(token);
  const row = detailRow_(id);
  if (!row) throw new Error('No such detail.');
  if (!row.quote_code) throw new Error('Quote some lines first.');
  const to = normalizeEmails_(row.customer_email);
  if (!to) throw new Error('There is no email address on this detail. Add one, or text it instead.');
  const rehearsal = testMode_();
  const items = detailItems_(row).filter(function (x) { return x.quote === 'pending' || x.quote === 'call'; });
  if (!items.length) throw new Error('Nothing on this detail is waiting on the customer.');
  const first = String(row.customer_name || '').split(/[ ,]/).filter(String)[0] || '';
  const list = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px">' +
    items.map(function (x) {
      return '<tr><td style="' + MAIL_FONT + ';font-size:15px;padding:6px 0;border-bottom:1px solid #EBF1F6">' +
        esc_(x.label) + (x.qty > 1 ? ' &times; ' + x.qty : '') + '</td><td align="right" style="' + MAIL_FONT +
        ';font-size:15px;padding:6px 0;border-bottom:1px solid #EBF1F6;white-space:nowrap">' + esc_(money_(x.price)) + '</td></tr>';
    }).join('') + '</table>';
  const html = noticeHtml_({
    banner: rehearsal ? mailBox_('#FFF6E0', '#E2C27A', '<b>Test mode.</b> This would have gone to ' + esc_(to) + '.') : '',
    greeting: first,
    intro: '<p style="margin:0 0 12px">Here is your detailing quote' + (row.unit ? ' for your ' + esc_(row.unit) : '') +
      '. Nothing is done until you accept it — tap below to accept, decline, or ask us to call you.</p>' + list +
      '<p style="font-size:12.5px;color:#5C7185;line-height:18px;margin:10px 0 0">' + esc_(DETAIL_FINE_PRINT_) + '</p>',
    buttons: button_(detailQuoteUrl_(row.quote_code), 'Review my quote')
  });
  const ok = send_({
    to: rehearsal ? testEmail_() : to, subject: (rehearsal ? '[TEST] ' : '') + 'Your detailing quote from ' + SHOP_NAME +
      (row.quote_no ? ' (' + row.quote_no + ')' : ''),
    html: html, text: 'Your detailing quote: ' + detailQuoteUrl_(row.quote_code), jobId: row.job_id || row.id,
    kind: 'detail_quote', suppressed: rehearsal, intendedFor: to
  });
  if (!ok) throw new Error('The email did not go. Try again, or text it instead.');
  withLock_(function () {
    forget_('Details');
    const fresh = detailRow_(id);
    updateRow_('Details', fresh._row, { quote_sent_at: nowIso_(), updated_at: nowIso_() });
    detailEvent_(row.id, 'sent', whoIs_(who) + ' emailed the quote to ' + row.customer_name +
      (rehearsal ? ' (test mode: held)' : ''), whoIs_(who));
  });
  return { ok: true, testMode: rehearsal, v: bumpDetailVersion_() };
}

/** The customer's page. The code is the whole of the credential. */
function detailQuote(code) {
  const shop = { name: SHOP_NAME, phone: SHOP_PHONE, email: SERVICE_EMAIL };
  const c = String(code || '').trim().toUpperCase();
  if (!c || !ss_().getSheetByName('Details')) return { notFound: true, shop: shop };
  const row = rows_('Details').filter(function (r) { return r.quote_code && r.quote_code === c; })[0];
  if (!row || row.status === 'cancelled') return { notFound: true, shop: shop };
  // Named one field at a time. Only lines that were sent to them.
  const lines = detailItems_(row).filter(function (x) { return x.quote; }).map(function (x) {
    return { id: x.id, key: x.key, label: x.label, qty: x.qty, price: x.price, status: x.quote, done: !!x.done };
  });
  return {
    quote: {
      firstName: String(row.customer_name || '').split(/[ ,]/).filter(String)[0] || '',
      quoteNo: row.quote_no || '', unit: row.unit || '', lines: lines, finePrint: DETAIL_FINE_PRINT_, closed: row.status === 'done'
    },
    shop: shop
  };
}

/**
 * Accept / Decline / Call me, from the customer. One request, however many
 * lines, and idempotent: the same answer twice changes nothing. An accepted
 * line is not theirs to un-accept from here (the shop may already be doing
 * it) — they ring, as on the winter page.
 */
function answerDetailQuote(code, answers, note) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) throw new Error('That link is not complete.');
  const out = withLock_(function () {
    forget_('Details');
    const row = rows_('Details').filter(function (r) { return r.quote_code && r.quote_code === c; })[0];
    if (!row || row.status === 'cancelled') throw new Error('We could not find that quote. Please call us.');
    const items = detailItems_(row);
    const changed = [];
    const at = nowIso_();
    (answers || []).slice(0, DETAIL_ITEM_MAX_).forEach(function (a) {
      const choice = String(a && a.choice || '');
      if (choice !== 'accepted' && choice !== 'declined' && choice !== 'call') return;
      const x = items.filter(function (i) { return i.id === String(a.item || ''); })[0];
      if (!x || !x.quote || x.quote === 'accepted' || x.quote === choice) return;
      x.quote = choice;
      x.answeredAt = at;
      x.answeredBy = 'customer';
      changed.push(x);
    });
    // Bottom paint is a package: nothing is saved if this answer breaks it.
    const pkg = paintPackage_(items, at, 'customer');
    if (pkg.error) throw new Error(pkg.error);
    pkg.auto.forEach(function (x) { if (changed.indexOf(x) === -1) changed.push(x); });
    const ask = String(note || '').trim().slice(0, 1000);
    if (changed.length) {
      if (ask) changed.forEach(function (x) { if (x.quote === 'call') x.note = ask; });
      updateRow_('Details', row._row, { items: JSON.stringify(items), updated_at: at });
      const words = { accepted: 'accepted', declined: 'declined', call: 'wants a call about' };
      const text = row.customer_name + ' ' + ['call', 'accepted', 'declined'].map(function (k) {
        const these = changed.filter(function (x) { return x.quote === k; });
        return these.length ? words[k] + ' ' + these.map(function (x) { return x.label; }).join(', ') : '';
      }).filter(String).join('; ') + (ask ? ' — “' + ask + '”' : '');
      detailEvent_(row.id, changed.some(function (x) { return x.quote === 'call'; }) ? 'call' : 'answer', text, 'Customer');
      return { row: detailRow_(row.id), changed: changed, text: text, ask: ask, v: bumpDetailVersion_() };
    }
    return { row: row, changed: [] };
  });
  if (out.changed.length) {
    const call = out.changed.some(function (x) { return x.quote === 'call'; });
    pushNotify_(call ? 'Call requested' : 'Detail quote answered', out.text, out.row.id);
    notifyDetailAnswer_(out.row, out.changed, out.ask);
    settleDeclinedDetail_(out.row.id);
  }
  const page = detailQuote(c);
  page.saved = out.changed.length;
  return page;
}

/** One email to the office per submission, never per line. */
function notifyDetailAnswer_(row, changed, ask, recordedBy) {
  const call = changed.filter(function (x) { return x.quote === 'call'; });
  const n = function (q) { return changed.filter(function (x) { return x.quote === q; }).length; };
  const subject = (call.length ? 'CALL REQUESTED — ' : '') + 'Detail quote answered: ' + row.customer_name +
    (row.quote_no ? ' (' + row.quote_no + ')' : '');
  const html = staffMailHtml_({
    tone: call.length ? 'red' : n('accepted') ? 'green' : 'navy', quoteNo: row.quote_no,
    heading: call.length ? 'They want a call' : n('accepted') ? 'Quote accepted' : 'Quote declined',
    sub: [n('accepted') ? n('accepted') + ' accepted' : '', n('declined') ? n('declined') + ' declined' : '',
      call.length ? call.length + ' call me' : ''].filter(String).join(' · ') +
      (recordedBy ? ' — recorded by ' + recordedBy + ' from the customer' : ' — answered online'),
    ask: ask,
    rows: detailCustomerRows_(row),
    linesTitle: 'Their answers',
    lines: changed.map(function (x) { return { label: x.label, qty: x.qty, price: x.price, state: x.quote }; }),
    next: n('accepted') && !call.length ? 'Next: the desk writes the work order in BiT and puts its number on.' : '',
    button: { url: detailUrl_(row.id), label: call.length ? 'Open it — then give them a call' : 'Open it in the Detail Tracker' }
  });
  send_({ to: DETAIL_ALERT_EMAIL, cc: SERVICE_EMAIL, subject: subject, html: html, text: subject,
          jobId: row.job_id || row.id, kind: 'detail_answer' });
}

/** Staff answering for the customer — they rang, or said yes at the counter. */
function decideDetailLine(token, id, itemId, choice, note) {
  return decideDetailLines(token, id, [itemId], choice, note);
}

/**
 * Staff recording the customer's answer — they rang the desk, or said yes at
 * the counter. `itemIds` is the lines, or 'all' for every line still open
 * (waiting on them, or priced and not sent). Accepted, declined or "have John
 * call" tells John exactly as the customer answering online does, saying who
 * recorded it; `note` is what the customer said, kept on the line and in the
 * email. Chris, Nov 7 2026: "confirmations/declines/requests for John to call
 * directly in the service writer page".
 */
function decideDetailLines(token, id, itemIds, choice, note) {
  const who = requireShop_(token);
  if (!DETAIL_QUOTE_STATES_[choice]) throw new Error('That is not an answer.');
  const by = whoIs_(who);
  const said = String(note || '').trim().slice(0, 1000);
  const out = withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    const items = detailItems_(row);
    const all = itemIds === 'all';
    const want = all ? null : (itemIds || []).map(String);
    const targets = items.filter(function (x) {
      if (x.winter || x.done) return false;
      if (all) return x.quote === 'pending' || x.quote === 'call' || (x.quote === '' && x.price !== null);
      return want.indexOf(x.id) !== -1;
    });
    if (!targets.length) {
      if (!all && items.some(function (x) { return x.winter && want.indexOf(x.id) !== -1; })) {
        throw new Error('Answer winter quotes in the winter console.');
      }
      throw new Error(all ? 'Nothing on this quote is waiting on an answer.' : 'That line is not on this detail any more.');
    }
    const at = nowIso_();
    const changed = [];
    targets.forEach(function (x) {
      if (x.quote === choice && !said) return;
      x.quote = choice;
      x.answeredAt = at;
      x.answeredBy = by;
      if (said) x.note = said;
      changed.push(x);
    });
    if (!changed.length) return { row: row, changed: [] };
    const pkg = paintPackage_(items, at, by);
    if (pkg.error) throw new Error(pkg.error);
    pkg.auto.forEach(function (x) { if (changed.indexOf(x) === -1) changed.push(x); });
    updateRow_('Details', row._row, { items: JSON.stringify(items), updated_at: at });
    const words = { '': 'not quoted', pending: 'waiting on the customer', call: 'wants John to call', accepted: 'accepted', declined: 'declined' };
    detailEvent_(row.id, choice === 'call' ? 'call' : 'answer', by + ' recorded: ' + row.customer_name + ' ' + words[choice] + ' — ' +
      changed.map(function (x) { return x.label; }).join(', ') + (said ? ' (“' + said + '”)' : ''), by);
    return { row: detailRow_(id), changed: changed, v: bumpDetailVersion_() };
  });
  if (out.changed.length && (choice === 'accepted' || choice === 'declined' || choice === 'call')) {
    notifyDetailAnswer_(out.row, out.changed, said, by);
    if (settleDeclinedDetail_(out.row.id)) out.row = detailRow_(id);
    pushNotify_(choice === 'call' ? 'Call requested' : 'Detail quote answered',
      out.row.customer_name + ': ' + out.changed.map(function (x) { return x.label; }).join(', ') + ' — ' +
      ({ accepted: 'accepted', declined: 'declined', call: 'please call them' })[choice], out.row.id);
  }
  return { detail: detailView_(out.row, out.row.job_id ? jobRow_(out.row.job_id) : null), v: out.v || detailVersion_() };
}

/**
 * What a scan (or a typed number) in the Detail Tracker opens. Chris, Nov
 * 2026: "I don't see a way to scan a QR code with the detail tracker." The
 * page reads the code the way the mechanic app does (tracking.js) and asks
 * here with what it found: `job` (a work order's token), `winter` (a winter
 * quote number) or `text` (whatever was typed: a D-number, a winter quote
 * number or a BiT work order number). Answers the detail to open, or what
 * the code is when there is no detail on it yet. Writes nothing.
 */
function detailForCode(token, kind, code) {
  requireShop_(token);
  const c = String(code || '').trim();
  if (!c) throw new Error('Scan a code or type a number.');
  const has = !!ss_().getSheetByName('Details');
  const open = function (r) { return r.status !== 'cancelled' && !r.archived_at; };
  const winterQn = kind === 'winter' ? c.toUpperCase() : (/^QW-\d{2}-\d{3,5}$/i.test(c) ? c.toUpperCase() : '');
  if (winterQn) {
    const row = has ? rows_('Details').filter(function (r) { return r.winter_qn === winterQn && open(r); })
      .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); })[0] : null;
    if (row) return { detailId: row.id };
    const got = winterKey_() ? winterDetailFeed_(false) : { feed: null };
    const u = got.feed && got.feed.units.filter(function (x) { return x.qn === winterQn; })[0];
    if (u) return { winterQn: winterQn, canPull: true, name: u.name, unit: [u.ymm, u.unit].filter(String).join(' \u00b7 ') };
    return { notFound: true, message: 'Winter quote ' + winterQn + ' has no detailing or washes on it.' };
  }
  const dn = kind === 'text' && /^D-?\d{3,6}$/i.test(c) ? 'D-' + c.replace(/\D/g, '') : '';
  if (dn) {
    const row = has ? rows_('Details').filter(function (r) { return r.quote_no === dn; })[0] : null;
    return row ? { detailId: row.id } : { notFound: true, message: 'There is no detail quote ' + dn + '.' };
  }
  const job = kind === 'job' ? jobByToken_(c) : jobByNumber_(c);
  if (!job) return { notFound: true, message: kind === 'job' ? 'That work order is not in the tracker.' : 'No work order ' + c + '.' };
  const row = has ? detailForJob_(job.id) : null;
  if (row) return { detailId: row.id };
  return { none: true, job: { id: job.id, customerName: job.customer_name || '', boatInfo: job.boat_info || '' },
    message: 'Work order ' + job.id + ' has no detail on it. The office adds it from the job page (Send to detail).' };
}

/** A note on a quote, from whoever took the call. Goes in its history with their name. */
function addDetailNote(token, id, text) {
  const who = requireShop_(token);
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new Error('Write the note first.');
  return withLock_(function () {
    forget_('Details');
    const row = detailRow_(id);
    if (!row) throw new Error('No such detail.');
    updateRow_('Details', row._row, { updated_at: nowIso_() });
    detailEvent_(row.id, 'note', t, whoIs_(who));
    return { detail: detailView_(detailRow_(id), row.job_id ? jobRow_(row.job_id) : null), v: bumpDetailVersion_() };
  });
}

/* ------------------------------ winter units ----------------------------- */

const WINTER_DETAIL_KEY_ = 'WINTER_DETAILS_v1';
const WINTER_DETAIL_LAST_ = 'WINTER_DETAILS_LAST_v1';
const WINTER_DETAIL_SNAP_PROP_ = 'WINTER_DETAIL_SNAP';
/* The winter system's item states, to this board's. */
const WINTER_STATE_TO_QUOTE_ = { awaiting: 'pending', call: 'call', declined: 'declined', quoted: 'accepted',
  open: '', asked: '', dims: '' };

function cleanWinterDetailUnit_(u) {
  return {
    qn: String(u.qn || '').slice(0, 20), name: String(u.name || '').slice(0, 120),
    phone: String(u.phone || '').slice(0, 40), email: String(u.email || '').slice(0, 200),
    unit: String(u.unit || '').slice(0, 40), ymm: String(u.ymm || '').slice(0, 120),
    dims: String(u.dims || '').slice(0, 60), loa: numberOrNull_(u.loa), beam: numberOrNull_(u.beam),
    stateLabel: String(u.stateLabel || '').slice(0, 60),
    items: (u.items || []).map(function (x) {
      return { l: String(x.l || '').slice(0, WINTER_ITEM_MAX_), s: String(x.s || ''), a: numberOrNull_(x.a) };
    }).filter(function (x) { return x.l && detailKeyForLabel_(x.l); })
  };
}

/** Every winter quote with detailing or a wash on it, off the winter system. */
function fetchWinterDetails_() {
  const body = winterCall_({ fn: 'details' });
  return { at: String(body.at || nowIso_()), units: (body.units || []).map(cleanWinterDetailUnit_)
    .filter(function (u) { return u.qn && u.items.length; }) };
}

function winterDetailFeed_(fresh) {
  const cached = fresh ? null : cacheGetBig_(WINTER_DETAIL_KEY_);
  if (cached && Array.isArray(cached.units)) return { feed: cached, stale: false, error: '' };
  try {
    const feed = fetchWinterDetails_();
    cachePutBig_(WINTER_DETAIL_KEY_, feed, WINTER_FEED_TTL_);
    cachePutBig_(WINTER_DETAIL_LAST_, feed, WINTER_LAST_GOOD_TTL_);
    return { feed: feed, stale: false, error: '' };
  } catch (err) {
    const kept = cacheGetBig_(WINTER_DETAIL_LAST_);
    return { feed: kept && Array.isArray(kept.units) ? kept : null, stale: true,
             error: String(err && err.message ? err.message : err) };
  }
}

/** The lines a winter unit brings onto the board. Prices are the winter quote's. */
function winterDetailItems_(u) {
  return u.items.map(function (x) {
    const q = WINTER_STATE_TO_QUOTE_[x.s] === undefined ? '' : WINTER_STATE_TO_QUOTE_[x.s];
    return { id: 'w_' + x.l.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30), key: detailKeyForLabel_(x.l),
      label: x.l, qty: 1, price: x.a, winter: x.s || 'asked', quote: q };
  });
}

/** The Winter tab of the board: every winter unit with detail work, and whether it is on the board. */
function winterDetails(token, fresh) {
  requireShop_(token);
  if (!winterKey_()) return { configured: false, units: [], error: 'Not connected to the winter system yet. The office needs to add WINTER_KEY.' };
  const got = winterDetailFeed_(fresh === true);
  if (!got.feed) return { configured: true, units: [], stale: true, error: got.error };
  const onBoard = {};
  if (ss_().getSheetByName('Details')) {
    rows_('Details').forEach(function (r) {
      if (r.winter_qn && r.status !== 'cancelled' && !r.archived_at) onBoard[r.winter_qn] = { id: r.id, status: r.status };
    });
  }
  if (fresh === true) applyWinterStates_(got.feed.units, false);
  return {
    configured: true, at: got.feed.at, stale: got.stale, error: got.error,
    units: got.feed.units.map(function (u) {
      return { qn: u.qn, name: u.name, phone: u.phone, email: u.email, unit: u.unit, ymm: u.ymm, dims: u.dims,
        loa: u.loa, beam: u.beam, stateLabel: u.stateLabel, items: winterDetailItems_(u),
        onBoard: onBoard[u.qn] || null };
    })
  };
}

/**
 * Put the winter system's answers onto the board's winter details, and say
 * what moved. Called by the ping, by a fresh Winter tab, and hourly. Only the
 * answer and the price of a winter line change here; its tick is ours.
 */
function applyWinterStates_(units, notify) {
  if (!ss_().getSheetByName('Details')) return [];
  const byQn = {};
  units.forEach(function (u) { byQn[u.qn] = u; });
  const moved = [];
  withLock_(function () {
    forget_('Details');
    rows_('Details').forEach(function (row) {
      const u = row.winter_qn && byQn[row.winter_qn];
      if (!u || row.status === 'cancelled' || row.archived_at) return;
      const fresh = winterDetailItems_(u);
      const items = detailItems_(row);
      let dirty = false;
      fresh.forEach(function (f) {
        const x = items.filter(function (i) { return i.winter && i.label === f.label; })[0];
        if (!x) {
          items.push(Object.assign(f, { group: '', how: '', answeredAt: '', answeredBy: '', note: '', done: null }));
          moved.push({ row: row, text: row.customer_name + ': ' + f.label + ' added on the winter quote' });
          dirty = true;
          return;
        }
        if (x.quote !== f.quote || x.price !== f.price) {
          if (x.quote !== f.quote && (f.quote === 'accepted' || f.quote === 'declined' || f.quote === 'call')) {
            moved.push({ row: row, call: f.quote === 'call', text: row.customer_name + ' ' +
              ({ accepted: 'accepted', declined: 'declined', call: 'wants a call about' })[f.quote] + ' ' + f.label + ' (winter quote ' + row.winter_qn + ')' });
          }
          x.quote = f.quote; x.price = f.price; x.winter = f.winter;
          x.answeredAt = nowIso_(); x.answeredBy = 'winter';
          dirty = true;
        }
      });
      if (dirty) updateRow_('Details', row._row, { items: JSON.stringify(items), updated_at: nowIso_() });
    });
    moved.forEach(function (m) { detailEvent_(m.row.id, m.call ? 'call' : 'answer', m.text, 'Winter'); });
    if (moved.length) bumpDetailVersion_();
  });
  if (notify) {
    moved.forEach(function (m) {
      pushNotify_(m.call ? 'Call requested' : 'Winter detail quote', m.text, m.row.id);
    });
  }
  return moved;
}

/** Bring a winter unit onto the board. Idempotent per quote number. */
function pullWinterDetail(token, qn) {
  requireShop_(token);
  const got = winterDetailFeed_(false);
  const u = got.feed && got.feed.units.filter(function (x) { return x.qn === String(qn || '').trim().toUpperCase(); })[0];
  if (!u) throw new Error('That winter quote has no detailing on it any more, or the winter system could not be reached.');
  return createDetail(token, { winterQn: u.qn, customerName: u.name, customerPhone: u.phone, customerEmail: u.email,
    unit: [u.ymm, u.unit].filter(String).join(' · '), loa: u.loa, beam: u.beam, items: winterDetailItems_(u) });
}

/** The detailer's ticks on a winter unit, home the way the mechanics' go. Never throws. */
function syncDetailToWinter_(row) {
  try {
    if (!ss_().getSheetByName('WinterWork')) return false;
    const done = row.status === 'done';
    withLock_(function () {
      forget_('WinterWork');
      detailItems_(row).filter(function (x) { return x.winter; }).forEach(function (x) {
        const tick = !!x.done || (done && detailDoable_(x));
        const had = rows_('WinterWork').filter(function (r) { return r.quote_no === row.winter_qn && r.item === x.label; })[0];
        const patch = tick ? { done: 'yes', done_by: (x.done && x.done.by) || row.done_by || 'Detail', done_at: (x.done && x.done.at) || nowIso_() }
                           : { done: '', done_by: '', done_at: '' };
        if (had) { if ((had.done === 'yes') !== tick) updateRow_('WinterWork', had._row, patch); }
        else if (tick) appendRow_('WinterWork', Object.assign({ id: newId_('ww'), quote_no: row.winter_qn, item: x.label, created_at: nowIso_() }, patch));
      });
    });
    return pushWinterTicks_([row.winter_qn]);
  } catch (err) {
    return false;
  }
}

/**
 * The winter system telling us a customer answered (or staff priced) a
 * detail line. Same shared key as the tracker door, the other way round.
 * Carries that quote's detail lines, so nothing has to re-read the season.
 */
function detailPing_(body) {
  const want = winterKey_();
  const got = String(body && body.key || '');
  let diff = want.length >= 24 && got.length === want.length ? 0 : 1;
  for (let i = 0; i < want.length && i < got.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) return { ok: 0, error: 'Not authorised.' };
  const u = cleanWinterDetailUnit_(body.unit || {});
  if (!u.qn) return { ok: 0, error: 'Which quote?' };
  // The cached feed is now behind on this quote; the next read goes fresh.
  try { scriptCache_().remove(WINTER_DETAIL_KEY_); } catch (e) { /* it expires on its own */ }
  const moved = applyWinterStates_([u], true);
  if (!moved.length && body.event) {
    // A unit not on the board yet: still worth a buzz when a customer answered.
    const text = String(body.event).slice(0, 300);
    withLock_(function () { detailEvent_('', 'answer', text, 'Winter'); bumpDetailVersion_(); });
    pushNotify_(/call/i.test(text) ? 'Call requested' : 'Winter detail quote', text, '');
  }
  return { ok: 1, moved: moved.length };
}

/** Hourly: catch the board up on any ping that never arrived. */
function catchUpWinterDetails_() {
  if (!winterKey_()) return;
  try {
    const got = winterDetailFeed_(true);
    if (got.feed) applyWinterStates_(got.feed.units, true);
  } catch (err) { /* next hour */ }
}

/* =============================== web push ================================ */
/*
 * Notifications on the detailer's and the writer's phones, from Apps Script,
 * which has no Web Push library and no elliptic-curve signing. So the two
 * pieces Web Push needs are here in plain JavaScript:
 *
 *  - A VAPID key pair (P-256), made the first time anybody asks for the public
 *    half and kept in script properties — never in this public repo.
 *  - An ES256 signature on the VAPID JWT, with the nonce derived the RFC 6979
 *    way (HMAC-SHA256 over the key and the message), because Apps Script has
 *    no secure random source and ECDSA with a guessable nonce gives the key
 *    away.
 *
 * The push itself carries NO payload. Encrypting one needs AES-GCM, which
 * Apps Script also lacks; instead the phone's service worker, woken by the
 * push, asks pushInbox what happened and shows that. The words never sit on
 * Google's or Apple's push servers either.
 *
 * Subscriptions are rows on PushSubs. One that the push service says is gone
 * (404/410) is deleted on the spot.
 */
const P256_ = (function () {
  const B = function (h) { return BigInt('0x' + h); };
  return {
    p: B('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: B('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    gx: B('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    gy: B('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
  };
})();

function modP_(a, m) { const r = a % m; return r >= BigInt(0) ? r : r + m; }

function invMod_(a, m) {
  let lo = BigInt(1), hi = BigInt(0), low = modP_(a, m), high = m;
  while (low > BigInt(1)) {
    const r = high / low;
    const nm = hi - lo * r, nw = high - low * r;
    hi = lo; high = low; lo = nm; low = nw;
  }
  return modP_(lo, m);
}

/* Jacobian coordinates: one inversion per scalar multiply, not one per step. */
function jDouble_(P) {
  const p = P256_.p, X = P[0], Y = P[1], Z = P[2], three = BigInt(3), two = BigInt(2);
  if (Y === BigInt(0)) return [BigInt(0), BigInt(1), BigInt(0)];
  const YY = modP_(Y * Y, p), S = modP_(BigInt(4) * X * YY, p);
  const ZZ = modP_(Z * Z, p);
  const M = modP_(three * (X - ZZ) * (X + ZZ), p);   // a = -3
  const X3 = modP_(M * M - two * S, p);
  const Y3 = modP_(M * (S - X3) - BigInt(8) * YY * YY, p);
  return [X3, Y3, modP_(two * Y * Z, p)];
}

function jAdd_(P, Q) {
  const p = P256_.p;
  if (P[2] === BigInt(0)) return Q;
  if (Q[2] === BigInt(0)) return P;
  const Z1Z1 = modP_(P[2] * P[2], p), Z2Z2 = modP_(Q[2] * Q[2], p);
  const U1 = modP_(P[0] * Z2Z2, p), U2 = modP_(Q[0] * Z1Z1, p);
  const S1 = modP_(P[1] * Q[2] * Z2Z2, p), S2 = modP_(Q[1] * P[2] * Z1Z1, p);
  if (U1 === U2) return S1 === S2 ? jDouble_(P) : [BigInt(0), BigInt(1), BigInt(0)];
  const H = modP_(U2 - U1, p), R = modP_(S2 - S1, p);
  const HH = modP_(H * H, p), HHH = modP_(H * HH, p), V = modP_(U1 * HH, p);
  const X3 = modP_(R * R - HHH - BigInt(2) * V, p);
  const Y3 = modP_(R * (V - X3) - S1 * HHH, p);
  return [X3, Y3, modP_(H * P[2] * Q[2], p)];
}

function p256Mul_(k) {
  let R = [BigInt(0), BigInt(1), BigInt(0)];
  let A = [P256_.gx, P256_.gy, BigInt(1)];
  let e = k;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) R = jAdd_(R, A);
    A = jDouble_(A);
    e >>= BigInt(1);
  }
  if (R[2] === BigInt(0)) throw new Error('point at infinity');
  const zi = invMod_(R[2], P256_.p), zi2 = modP_(zi * zi, P256_.p);
  return [modP_(R[0] * zi2, P256_.p), modP_(R[1] * zi2 * zi, P256_.p)];
}

function bytesToBig_(b) { let h = ''; b.forEach(function (x) { h += (x < 16 ? '0' : '') + x.toString(16); }); return BigInt('0x' + (h || '0')); }
function bigToBytes_(n, len) {
  let h = n.toString(16);
  while (h.length < len * 2) h = '0' + h;
  const out = [];
  for (let i = 0; i < len * 2; i += 2) out.push(parseInt(h.substr(i, 2), 16));
  return out;
}

function sha256_(bytes) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const msg = bytes.map(function (b) { return b & 255; });
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 7; i >= 0; i--) msg.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
  const W = new Array(64);
  const rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
  for (let off = 0; off < msg.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = (msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = [];
  H.forEach(function (x) { out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255); });
  return out;
}

function hmac256_(key, msg) {
  let k = key.length > 64 ? sha256_(key) : key.slice();
  while (k.length < 64) k.push(0);
  const ipad = k.map(function (b) { return b ^ 0x36; }), opad = k.map(function (b) { return b ^ 0x5c; });
  return sha256_(opad.concat(sha256_(ipad.concat(msg))));
}

function asciiBytes_(s) { const out = []; for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255); return out; }

function b64url_(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? A[n & 63] : '');
  }
  return out;
}

/** ECDSA P-256 / SHA-256, r||s, nonce by RFC 6979. */
function es256Sign_(d, msgBytes) {
  const n = P256_.n;
  const h1 = sha256_(msgBytes);
  const z = bytesToBig_(h1);
  const x = bigToBytes_(d, 32), h1o = bigToBytes_(modP_(z, n), 32);
  let V = []; let K = [];
  for (let i = 0; i < 32; i++) { V.push(1); K.push(0); }
  K = hmac256_(K, V.concat([0], x, h1o)); V = hmac256_(K, V);
  K = hmac256_(K, V.concat([1], x, h1o)); V = hmac256_(K, V);
  for (;;) {
    V = hmac256_(K, V);
    const k = bytesToBig_(V);
    if (k >= BigInt(1) && k < n) {
      const r = modP_(p256Mul_(k)[0], n);
      const s = modP_(invMod_(k, n) * (z + r * d), n);
      if (r !== BigInt(0) && s !== BigInt(0)) return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
    }
    K = hmac256_(K, V.concat([0])); V = hmac256_(K, V);
  }
}

/** The VAPID pair, made once. {d: BigInt, pub: base64url of the 65-byte point}. */
function vapidKeys_() {
  let dh = props_().getProperty('VAPID_PRIVATE');
  let pub = props_().getProperty('VAPID_PUBLIC');
  if (!dh || !pub) {
    let seed = [];
    for (let i = 0; i < 8; i++) seed = seed.concat(asciiBytes_(Utilities.getUuid()));
    seed = seed.concat(asciiBytes_(String(Date.now()) + secret_()));
    const d = modP_(bytesToBig_(sha256_(seed)), P256_.n - BigInt(1)) + BigInt(1);
    const Q = p256Mul_(d);
    dh = d.toString(16);
    pub = b64url_([4].concat(bigToBytes_(Q[0], 32), bigToBytes_(Q[1], 32)));
    props_().setProperty('VAPID_PRIVATE', dh);
    props_().setProperty('VAPID_PUBLIC', pub);
  }
  return { d: BigInt('0x' + dh), pub: pub };
}

function vapidJwt_(endpoint, keys) {
  const aud = String(endpoint).match(/^https:\/\/[^/]+/);
  if (!aud) throw new Error('Not a push endpoint.');
  const head = b64url_(asciiBytes_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url_(asciiBytes_(JSON.stringify({ aud: aud[0], exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:' + SERVICE_EMAIL })));
  return head + '.' + body + '.' + b64url_(es256Sign_(keys.d, asciiBytes_(head + '.' + body)));
}

/** The public half, for the page's pushManager.subscribe. */
function pushKey() {
  return { key: vapidKeys_().pub };
}

function pushSubscribe(token, sub, label) {
  const who = requireShop_(token);
  ensureDetailSchema_();
  const endpoint = String(sub && sub.endpoint || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw new Error('That is not a push subscription.');
  return withLock_(function () {
    forget_('PushSubs');
    const had = rows_('PushSubs').filter(function (r) { return r.endpoint === endpoint; })[0];
    const row = { endpoint: endpoint, who: whoIs_(who), label: String(label || '').slice(0, 80), role: who.role, failures: '0' };
    if (had) updateRow_('PushSubs', had._row, row);
    else appendRow_('PushSubs', Object.assign({ id: newId_('push'), created_at: nowIso_() }, row));
    return { ok: true };
  });
}

function pushUnsubscribe(token, endpoint) {
  requireShop_(token);
  if (!ss_().getSheetByName('PushSubs')) return { ok: true };
  withLock_(function () {
    forget_('PushSubs');
    const had = rows_('PushSubs').filter(function (r) { return r.endpoint === String(endpoint || ''); })[0];
    if (had) { sheet_('PushSubs').deleteRow(had._row); forget_('PushSubs'); }
  });
  return { ok: true };
}

/**
 * Wake every subscribed phone. Never throws and never holds the lock: it is
 * one request per phone, sent together, after the answer is saved.
 */
function pushNotify_(title, text, detailId) {
  try {
    if (!ss_().getSheetByName('PushSubs')) return 0;
    const subs = rows_('PushSubs');
    if (!subs.length) return 0;
    // What the service worker will show, kept for it to collect.
    cachePutBig_('PUSH_LAST', { title: String(title || ''), text: String(text || '').slice(0, 300),
      detailId: detailId || '', at: nowIso_() }, 3600);
    const keys = vapidKeys_();
    const requests = subs.map(function (s) {
      return { url: s.endpoint, method: 'post', muteHttpExceptions: true, contentType: 'application/octet-stream',
        headers: { Authorization: 'vapid t=' + vapidJwt_(s.endpoint, keys) + ', k=' + keys.pub, TTL: '86400', Urgency: 'high' } };
    });
    const replies = UrlFetchApp.fetchAll ? UrlFetchApp.fetchAll(requests) : requests.map(function (r) {
      const url = r.url; return UrlFetchApp.fetch(url, r);
    });
    const gone = [];
    replies.forEach(function (res, i) {
      const code = res.getResponseCode();
      if (code === 404 || code === 410) gone.push(subs[i]._row);
    });
    if (gone.length) {
      withLock_(function () {
        gone.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet_('PushSubs').deleteRow(r); });
        forget_('PushSubs');
      });
    }
    return replies.length - gone.length;
  } catch (err) {
    return 0;
  }
}

/** What the service worker shows when a push wakes it. */
function pushInbox(token) {
  requireShop_(token);
  const last = cacheGetBig_('PUSH_LAST');
  return { note: last || null, v: detailVersion_() };
}

/** "Send me a test" on the board, so a phone can prove it is set up. */
function pushTest(token) {
  const who = requireShop_(token);
  const sent = pushNotify_('Detail Tracker', 'Notifications are working on ' + whoIs_(who) + '’s phones.', '');
  return { sent: sent };
}
