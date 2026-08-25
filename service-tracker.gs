/************************************************************************
 * Quest Watersports — Service Tracker backend
 *
 * The whole server side: Sheets as the database, Drive for photos, voice
 * notes and PDFs, Gmail for the two kinds of mail this system sends.
 *
 * The four pages on GitHub Pages talk to this file and nothing else, over a
 * single POST endpoint. Deploy notes and the one-time setup are in
 * docs/DEPLOY.md — read that before touching a deployment.
 *
 * ── WHAT THIS FILE MUST NEVER DO ──────────────────────────────────────
 * 1. Reach into BiT. Every exchange with BiT is a person downloading a PDF
 *    and uploading it here, or re-keying what they read here back into BiT.
 * 2. Show a customer anything but customer notes. See customerView_().
 * 3. Open a PDF. The service writer's browser parses and stamps work
 *    orders; this file only ever stores the bytes it is handed.
 ************************************************************************/

/* ============================ configuration ============================ */

/** Tabs are created on first run by setup(); see ensureSheets_(). */
const SS_NAME = 'Quest Service Tracker';
const DRIVE_FOLDER_NAME = 'Quest Service Tracker Files';

/** Where the four pages are served from — used to build printed QR links. */
const SITE_URL = 'https://questws.github.io/servicetracker';

const SHOP_NAME = 'Quest Watersports';
const SHOP_PHONE = '(815) 433-2200';
const SHOP_ADDRESS = '1851 Old Chicago Road, Ottawa, IL';

/** Customer replies land here, and so does the hourly digest. */
const SERVICE_EMAIL = 'service@questwatersports.com';

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
/** Why a part is on the list. */
const PART_REASON_LABEL = {
  job: 'For this job',
  restock: 'Restock',
  stock: 'Stock'
};

const ENTRY_LABEL = {
  customer_note: 'Customer note',
  internal_note: 'Internal note',
  labor: 'Labor',
  part: 'Part'
};

/** Column order per tab. Adding a column means adding it to the END here. */
const SHEETS = {
  Jobs: ['id', 'token', 'customer_name', 'customer_phone', 'customer_email', 'boat_info',
         'status', 'needs_review', 'work_order_file', 'invoice_file', 'payment_link',
         'created_at', 'updated_at', 'work_started_at', 'work_finished_at', 'done_at',
         'grand_total', 'deposits', 'amount_due',
         'parts_ordered_at', 'paid_at'],
  LogEntries: ['id', 'job_id', 'mechanic_id', 'mechanic_name', 'entry_type', 'text', 'hours',
               'part_identifier', 'quantity', 'audio_file', 'photos', 'transcript_status',
               'transcript_id', 'transcript_error', 'notified_at', 'created_at',
               'logged_at'],
  // A part somebody needs: off a work order, or a bare stock request. One row
  // per part; rows ordered together share a vendor and order number, and the
  // group is done when every row in it has been received.
  PartsOrders: ['id', 'job_id', 'source_entry', 'part_identifier', 'description', 'quantity',
                'reason', 'status', 'vendor', 'order_number', 'notes', 'requested_by',
                'created_at', 'ordered_at', 'received_at'],
  Mechanics: ['id', 'name', 'active', 'created_at'],
  StatusEvents: ['id', 'job_id', 'from_status', 'to_status', 'actor_type', 'actor', 'note', 'created_at'],
  EmailLog: ['id', 'job_id', 'kind', 'recipient', 'subject', 'status', 'error', 'created_at']
};

/* ============================== plumbing =============================== */

function props_() {
  return PropertiesService.getScriptProperties();
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
function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    if (!values[r][0]) continue;
    const row = { _row: r + 1 };
    for (let c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    out.push(row);
  }
  return out;
}

function appendRow_(name, obj) {
  const columns = SHEETS[name];
  const row = columns.map(function (key) {
    return obj[key] === undefined || obj[key] === null ? '' : obj[key];
  });
  sheet_(name).appendRow(row);
  return obj;
}

/** Writes only the named fields back to one row. */
function updateRow_(name, rowNumber, patch) {
  const columns = SHEETS[name];
  const sheet = sheet_(name);
  Object.keys(patch).forEach(function (key) {
    const index = columns.indexOf(key);
    if (index === -1) return;
    const value = patch[key];
    sheet.getRange(rowNumber, index + 1).setValue(value === null || value === undefined ? '' : value);
  });
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

function requireMechanic_(token) {
  const payload = unseal_(token);
  if (!payload || payload.role !== 'mechanic') throw new Error('Sign in with your name first.');
  return payload;
}

/** Either credential opens the shop-side views. */
function requireShop_(token) {
  const payload = unseal_(token);
  if (!payload || (payload.role !== 'admin' && payload.role !== 'mechanic')) {
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
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'Unreadable request.' });
  }

  const FNS = {
    /* service writer */
    adminSignIn:      function (a) { return adminSignIn(a[0]); },
    createJob:        function (a) { return createJob(data.token, a[0]); },
    attachWorkOrder:  function (a) { return attachWorkOrder(data.token, a[0], a[1]); },
    listJobs:         function (a) { return listJobs(data.token, a[0]); },
    getJob:           function (a) { return getJob(data.token, a[0]); },
    saveJobDetails:   function (a) { return saveJobDetails(data.token, a[0], a[1]); },
    saveInvoice:      function (a) { return saveInvoice(data.token, a[0], a[1], a[2], a[3]); },
    markDone:         function (a) { return markDone(data.token, a[0]); },
    sendInvoiceEmail: function (a) { return sendInvoiceEmail(data.token, a[0]); },
    setStatus:        function (a) { return setStatusByWriter(data.token, a[0], a[1]); },
    markLogged:       function (a) { return markEntriesLogged(data.token, a[0]); },
    setJobFlag:       function (a) { return setJobFlag(data.token, a[0], a[1], a[2]); },
    listMechanics:    function (a) { return listMechanicsAdmin(data.token); },
    addMechanic:      function (a) { return addMechanic(data.token, a[0]); },
    renameMechanic:   function (a) { return renameMechanic(data.token, a[0], a[1]); },
    setMechanicActive:function (a) { return setMechanicActive(data.token, a[0], a[1]); },

    /* parts */
    listParts:        function (a) { return listPartsOrders(data.token); },
    requestPart:      function (a) { return requestPart(data.token, a[0]); },
    partsOrdered:     function (a) { return markPartsOrdered(data.token, a[0], a[1], a[2]); },
    partReceived:     function (a) { return markPartReceived(data.token, a[0], a[1]); },
    partNote:         function (a) { return setPartNote(data.token, a[0], a[1]); },
    cancelPart:       function (a) { return cancelPartOrder(data.token, a[0]); },

    /* mechanic app */
    roster:           function (a) { return roster(); },
    signIn:           function (a) { return mechanicSignIn(a[0], a[1]); },
    lookupJob:        function (a) { return lookupJob(a[0], a[1]); },
    jobForMechanic:   function (a) { return jobForMechanic(data.token, a[0]); },
    addEntry:         function (a) { return addEntry(data.token, a[0], a[1]); },
    finishWork:       function (a) { return finishWork(data.token, a[0]); },

    /* customer page — the token in the URL is the only credential */
    publicJob:        function (a) { return publicJob(a[0], data.token); },
    setTestMode:      function (a) { return setTestMode(data.token, a[0]); },
    setCustomerTracking: function (a) { return setCustomerTracking(data.token, a[0]); },
    config:           function (a) { return config(data.token); }
  };

  if (!FNS[data.fn]) return json_({ error: 'Unknown function.' });
  try {
    return json_(FNS[data.fn](data.args || []));
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

/**
 * GET serves two things: a health check, and AssemblyAI's transcript webhook.
 * Nothing else — the pages are static files on GitHub Pages.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.hook === 'transcript') return transcriptWebhook_(params);
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

function jobSummary_(job) {
  return {
    id: job.id,
    token: job.token,
    customerName: job.customer_name,
    customerPhone: job.customer_phone,
    customerEmail: job.customer_email,
    boatInfo: job.boat_info,
    status: job.status,
    statusLabel: STATUS_LABEL[job.status],
    needsReview: job.needs_review ? String(job.needs_review).split(',').filter(String) : [],
    workOrderFile: job.work_order_file || null,
    invoiceFile: job.invoice_file || null,
    paymentLink: job.payment_link || null,
    grandTotal: numberOrNull_(job.grand_total),
    deposits: numberOrNull_(job.deposits),
    amountDue: numberOrNull_(job.amount_due),
    partsOrderedAt: job.parts_ordered_at || null,
    paidAt: job.paid_at || null,
    trackingUrl: trackingUrl_(job),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    doneAt: job.done_at || null
  };
}

function numberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return isFinite(number) ? number : null;
}

const REVIEW_FIELDS = ['customerName', 'customerPhone', 'customerEmail', 'boatInfo'];

function missingFields_(fields) {
  return REVIEW_FIELDS.filter(function (name) {
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

  return withLock_(function () {
    if (jobRow_(id)) {
      throw new Error('Job ' + id + ' already exists. Open it from the jobs list instead.');
    }
    const at = nowIso_();
    const job = {
      id: id,
      token: newTrackingToken_(),
      customer_name: payload.customerName || '',
      customer_phone: payload.customerPhone || '',
      customer_email: payload.customerEmail || '',
      boat_info: payload.boatInfo || '',
      status: 'received',
      needs_review: missingFields_(payload).join(','),
      work_order_file: '',
      invoice_file: '',
      payment_link: '',
      created_at: at,
      updated_at: at,
      work_started_at: '',
      work_finished_at: '',
      done_at: ''
    };

    appendRow_('Jobs', job);
    recordStatus_(id, '', 'received', 'service_writer', '', 'Work order intake');
    return { job: jobSummary_(job) };
  });
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

function listJobs(token, filter) {
  requireAdmin_(token);
  filter = filter || {};
  const entries = rows_('LogEntries');
  const counts = {};
  const hours = {};
  entries.forEach(function (entry) {
    counts[entry.job_id] = (counts[entry.job_id] || 0) + 1;
    if (entry.entry_type === 'labor' && entry.hours) {
      hours[entry.job_id] = (hours[entry.job_id] || 0) + Number(entry.hours);
    }
  });

  const search = String(filter.search || '').trim().toLowerCase();
  const jobs = rows_('Jobs')
    .filter(function (job) {
      if (filter.status && filter.status !== 'all' && job.status !== filter.status) return false;
      if (!search) return true;
      return [job.id, job.customer_name, job.boat_info, job.customer_phone]
        .join(' ').toLowerCase().indexOf(search) !== -1;
    })
    .map(function (job) {
      const summary = jobSummary_(job);
      summary.entryCount = counts[job.id] || 0;
      summary.hours = Math.round((hours[job.id] || 0) * 100) / 100;
      return summary;
    })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

  const byStatus = {};
  rows_('Jobs').forEach(function (job) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
  });
  return { jobs: jobs, counts: byStatus, testMode: testMode_() };
}

function getJob(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  const entries = entriesForJob_(id);
  return {
    testMode: testMode_(),
    customerTracking: customerTracking_(),
    job: jobSummary_(job),
    entries: entries,
    hours: laborTotals_(entries),
    timeline: rows_('StatusEvents').filter(function (event) { return event.job_id === id; }),
    emails: rows_('EmailLog').filter(function (mail) { return mail.job_id === id; }).reverse()
  };
}

function saveJobDetails(token, id, fields) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  updateRow_('Jobs', job._row, {
    customer_name: fields.customerName || '',
    customer_phone: fields.customerPhone || '',
    customer_email: fields.customerEmail || '',
    boat_info: fields.boatInfo || '',
    // The flag list is derived, never typed: filling a field clears its flag.
    needs_review: missingFields_(fields).join(','),
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
 * If a new field is ever added to a log entry, its visibility is decided
 * here, not in a page template.
 */
function customerView_(entries) {
  return entries
    .filter(function (entry) {
      if (entry.entryType !== 'customer_note') return false;
      return Boolean(entry.text) || entry.photos.length > 0;
    })
    .map(function (entry) {
      return {
        id: entry.id,
        text: entry.text,
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
    total += entry.hours;
    const who = entry.mechanicName || 'Unknown';
    byPerson[who] = (byPerson[who] || 0) + entry.hours;
  });
  const round = function (n) { return Math.round(n * 100) / 100; };
  return {
    total: round(total),
    byMechanic: Object.keys(byPerson)
      .map(function (name) { return { name: name, hours: round(byPerson[name]) }; })
      .sort(function (a, b) { return b.hours - a.hours; })
  };
}

function jobForMechanic(token, jobToken) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  return {
    mechanic: { id: who.id, name: who.name },
    job: jobSummary_(job),
    entries: entriesForJob_(job.id),
    hours: laborTotals_(entriesForJob_(job.id))
  };
}

/**
 * One entry against a job: typed or spoken, with photos, from a phone in a
 * shop. Photos arrive already shrunk by the browser in two sizes.
 */
function addEntry(token, jobToken, payload) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');

  const type = payload.entryType;
  if (!ENTRY_LABEL[type]) throw new Error('Pick what kind of entry this is.');

  const text = String(payload.text || '').trim();
  const hasAudio = Boolean(payload.audio);
  const photos = payload.photos || [];

  const hours = payload.hours === '' || payload.hours === null || payload.hours === undefined
    ? null : Number(payload.hours);
  if (hours !== null && (!isFinite(hours) || hours <= 0)) {
    throw new Error('Hours must be a number greater than zero.');
  }
  const quantity = payload.quantity ? Number(payload.quantity) : null;
  if (quantity !== null && (!isFinite(quantity) || quantity <= 0)) {
    throw new Error('Quantity must be a number greater than zero.');
  }

  if (type === 'part' && !String(payload.partIdentifier || '').trim()) {
    throw new Error('Scan or type the part number.');
  }
  if (type === 'labor') {
    if (hours === null) throw new Error('How many hours did this take?');
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

  return withLock_(function () {
    const stored = photos.slice(0, 8).map(function (photo, index) {
      return {
        thumb: saveFile_(job.id, 'photo-' + Date.now() + '-' + index + '-thumb.jpg', 'image/jpeg', photo.thumb),
        full: saveFile_(job.id, 'photo-' + Date.now() + '-' + index + '.jpg', 'image/jpeg', photo.full)
      };
    });

    let audioFile = '';
    if (hasAudio) {
      audioFile = saveFile_(job.id, 'voice-' + Date.now() + '.' + (payload.audioExt || 'webm'),
        payload.audioMime || 'audio/webm', payload.audio);
    }

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
      transcript_status: audioFile && !text ? 'pending' : '',
      transcript_id: '',
      transcript_error: '',
      notified_at: '',
      created_at: nowIso_()
    };
    appendRow_('LogEntries', entry);

    // Logging against a job nobody scanned still means work has started.
    if (job.status === 'received') {
      setStatus_(job, 'work_underway', 'mechanic', who.name, 'First log entry');
    }

    if (entry.transcript_status === 'pending') submitTranscript_(entry.id, audioFile);

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

    const entries = entriesForJob_(job.id);
    // The job comes back too: logging the first entry moves the status, and
    // the phone should not go on showing "Received" after it has.
    return {
      entry: entryView_(entry),
      entries: entries,
      job: jobSummary_(jobRow_(job.id)),
      hours: laborTotals_(entries)
    };
  });
}

function finishWork(token, jobToken) {
  const who = requireMechanic_(token);
  const job = jobByToken_(jobToken);
  if (!job) throw new Error('No such job.');
  if (job.status === 'done') throw new Error('This job is already closed out.');
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
    receivedAt: part.received_at || null
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
    received_at: ''
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

/** Needed, on order, and the completed orders behind them. */
function listPartsOrders(token) {
  requireAdmin_(token);
  const all = rows_('PartsOrders').map(partView_);
  const jobs = {};
  rows_('Jobs').forEach(function (job) { jobs[job.id] = job.customer_name || ''; });
  all.forEach(function (part) { part.customerName = part.jobId ? (jobs[part.jobId] || null) : null; });

  const byNewest = function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); };
  const needed = all.filter(function (p) { return p.status === 'needed'; }).sort(byNewest);
  const ordered = all.filter(function (p) { return p.status === 'ordered'; }).sort(byNewest);

  // An order is finished when every line on it has come in. Lines received
  // without an order number (walked in, found on the shelf) group on their own.
  const received = all.filter(function (p) { return p.status === 'received'; });
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

function cancelPartOrder(token, id) {
  requireAdmin_(token);
  const part = partRow_(id);
  if (!part) throw new Error('No such part.');
  if (part.status === 'ordered') throw new Error('That one is already on order — mark it received instead.');
  const sheet = sheet_('PartsOrders');
  sheet.deleteRow(part._row);
  return listPartsOrders(token);
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

function adminSignIn(password) {
  const expected = props_().getProperty('ADMIN_PASSWORD');
  if (!expected) throw new Error('No portal password is set on this deployment yet.');
  if (String(password || '') !== expected) throw new Error('That password was not recognised.');
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
function lookupJob(code, source) {
  const job = jobByToken_(String(code || '').trim().toUpperCase()) || jobByNumber_(code);
  if (!job) throw new Error('No job found for that code. Check the number on the work order.');

  if (source === 'scan' && job.status === 'received') {
    setStatus_(job, 'work_underway', 'system', '', 'First scan of the work order');
  }
  const fresh = jobRow_(job.id);
  return {
    job: {
      id: fresh.id,
      token: fresh.token,
      boatInfo: fresh.boat_info,
      customerName: fresh.customer_name,
      status: fresh.status,
      statusLabel: STATUS_LABEL[fresh.status]
    }
  };
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
      amountDue: job.status === 'done' ? numberOrNull_(job.amount_due) : null
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

function jobFolder_(jobId) {
  const root = rootFolder_();
  const existing = root.getFoldersByName(jobId);
  return existing.hasNext() ? existing.next() : root.createFolder(jobId);
}

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
function saveFile_(jobId, name, mime, base64) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name);
  const file = jobFolder_(jobId).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

/* =============================== email ================================= */

/** Money the way an invoice says it. */
function money_(value) {
  const number = numberOrNull_(value);
  if (number === null) return '';
  return '$' + number.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

function button_(url, label, bg) {
  return '<a href="' + esc_(url) + '" style="display:inline-block;background:' + (bg || '#14293E') +
    ';color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;' +
    'padding:12px 22px;border-radius:8px;margin:4px 6px 4px 0">' + esc_(label) + '</a>';
}

/**
 * The house style, matched to the winter services app's customer emails so
 * both arrive looking like the same shop: the wordmark over a gold rule, one
 * card on ice blue, a navy footer with the address and phone.
 *
 * The width and height attributes on the logo are load-bearing — Outlook's
 * renderer ignores the CSS and prints the full-size image without them.
 */
function noticeHtml_(parts) {
  const logo = logoBlob_()
    ? '<img src="cid:questlogo" alt="' + esc_(SHOP_NAME) + '" width="104" height="56" style="width:104px;height:56px;display:block;border:0">'
    : '<div style="font-family:Arial Black,Arial;font-size:24px;color:#14293E;letter-spacing:1px">' + esc_(SHOP_NAME.toUpperCase()) + '</div>';

  return '<div style="background:#EBF1F6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #C7D5E0">' +
      '<div style="padding:22px 28px;border-bottom:4px solid #C08A22">' + logo + '</div>' +
      '<div style="padding:26px 28px">' +
        (parts.banner || '') +
        (parts.greeting ? '<p style="font-size:16px;color:#1D2B38;margin:0 0 6px">Hi ' + esc_(parts.greeting) + ',</p>' : '') +
        '<div style="font-size:15px;color:#1D2B38;line-height:1.55;margin:0 0 14px">' + parts.intro + '</div>' +
        (parts.meta ? '<div style="font-family:Courier New,monospace;font-size:13px;color:#5C7185;margin-bottom:10px">' + esc_(parts.meta) + '</div>' : '') +
        (parts.buttons || '') +
        '<p style="font-size:13px;color:#5C7185;line-height:1.5;margin:12px 0 0">Questions? Call us at ' + esc_(SHOP_PHONE) + '.</p>' +
      '</div>' +
      '<div style="background:#14293E;color:#B9CDDD;padding:14px 28px;font-size:12px">' +
        esc_(SHOP_NAME) + ' &middot; ' + esc_(SHOP_ADDRESS) + ' &middot; ' + esc_(SHOP_PHONE) +
      '</div>' +
    '</div></div>';
}

function logEmail_(jobId, kind, recipient, subject, status, error) {
  appendRow_('EmailLog', {
    id: newId_('mail'),
    job_id: jobId || '',
    kind: kind,
    recipient: recipient,
    subject: subject,
    status: status,
    error: error ? String(error).substr(0, 400) : '',
    created_at: nowIso_()
  });
}

function send_(options) {
  const opts = {
    htmlBody: options.html,
    name: SHOP_NAME,
    replyTo: SERVICE_EMAIL
  };
  const logo = logoBlob_();
  if (logo) opts.inlineImages = { questlogo: logo };
  if (FROM_ALIAS) opts.from = FROM_ALIAS;
  if (options.attachments) opts.attachments = options.attachments;

  try {
    GmailApp.sendEmail(options.to, options.subject, options.text || options.subject, opts);
    logEmail_(
      options.jobId,
      options.kind,
      options.to,
      options.subject,
      options.suppressed ? 'held (test mode)' : 'sent',
      options.suppressed ? 'would have gone to ' + options.intendedFor : ''
    );
    return true;
  } catch (err) {
    logEmail_(options.jobId, options.kind, options.to, options.subject, 'failed', err);
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
function sendInvoiceEmail_(job) {
  if (!job.customer_email) {
    logEmail_(job.id, 'customer_done', '(none on file)', 'Service complete', 'skipped', 'No customer email on the job');
    return false;
  }
  const rehearsal = testMode_();
  const attachments = [];
  if (job.invoice_file) {
    try {
      attachments.push(DriveApp.getFileById(job.invoice_file).getBlob().setName('Invoice-' + job.id + '.pdf'));
    } catch (err) {
      /* The job is done either way; a missing attachment is not a reason to hold the mail. */
    }
  }

  // No tracking link while the page is switched off — a dead link in a
  // customer's invoice is worse than no link at all.
  const link = customerTracking_() ? trackingUrl_(job) : '';
  const first = String(job.customer_name || '').split(' ')[0];
  const due = numberOrNull_(job.amount_due);
  const deposits = numberOrNull_(job.deposits);

  // A job with a deposit against it owes nothing like its total, so the
  // balance gets said plainly rather than left for them to work out.
  const balance = due === null ? '' :
    '<div style="background:#FDFCF7;border:1px solid #C7D5E0;border-radius:8px;padding:14px 18px;margin:4px 0 16px">' +
      '<table width="100%" cellpadding="0" cellspacing="0">' +
        (deposits ? '<tr><td style="padding:3px 0;color:#5C7185;font-size:13px">Deposits already paid</td>' +
          '<td align="right" style="padding:3px 0;color:#5C7185;font-size:13px">' + money_(deposits) + '</td></tr>' : '') +
        '<tr><td style="padding:4px 0;font-weight:bold;color:#14293E">Amount due</td>' +
          '<td align="right" style="padding:4px 0;font-weight:bold;color:#14293E;font-size:17px">' + money_(due) + '</td></tr>' +
      '</table></div>';

  // In test mode the customer's email is sent to the shop instead, headed with
  // who it was for, so it can be read end to end without anybody outside the
  // building seeing anything.
  const banner = rehearsal
    ? '<div style="background:#FBEEE2;border:1px solid #E4B48F;border-left:4px solid #A6541F;' +
      'border-radius:8px;padding:12px 14px;margin:0 0 16px;color:#A6541F;font-size:14px">' +
      '<b>TEST MODE — not sent to the customer.</b><br>This is what ' +
      esc_(job.customer_email) + ' would have received for job ' + esc_(job.id) + '.</div>'
    : '';

  return send_({
    to: rehearsal ? testEmail_() : job.customer_email,
    jobId: job.id,
    kind: rehearsal ? 'customer_done_test' : 'customer_done',
    suppressed: rehearsal,
    intendedFor: job.customer_email,
    subject: (rehearsal ? '[TEST] ' : '') + 'Your ' + SHOP_NAME + ' service is complete — ' + job.id,
    greeting: first,
    html: noticeHtml_({
      banner: banner,
      greeting: first,
      intro: 'The work on ' + (job.boat_info ? esc_('your ' + job.boat_info) : 'your boat') + ' is complete. ' +
        (attachments.length ? 'Your final invoice is attached' : 'Everything is wrapped up') +
        (job.payment_link ? ', and you can pay online with the button below.' : '.') + balance,
      meta: 'INVOICE# ' + job.id + (job.boat_info ? ' · ' + job.boat_info : ''),
      buttons: (link ? button_(link, 'View your job') : '') +
        (job.payment_link ? button_(job.payment_link, due === null ? 'Pay online' : 'Pay ' + money_(due), '#C08A22') : '')
    }),
    text: 'The work on your boat is complete.' +
      (due === null ? '' : '\n\nAmount due: ' + money_(due)) +
      (link ? '\n\nJob status: ' + link : '') +
      (job.payment_link ? '\nPay your invoice: ' + job.payment_link : '') +
      '\n\nInvoice ' + job.id + '\n' + SHOP_NAME,
    attachments: attachments
  });
}

/**
 * Closes the ticket. Sends nothing.
 *
 * A job may be closed for a customer with no email address on file — plenty
 * of them are walk-ins who take their invoice at the counter — so an address
 * is a requirement of the email, not of finishing the work.
 */
function markDone(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  if (job.status === 'done') throw new Error('That job was already marked done.');
  setStatus_(job, 'done', 'service_writer', '', 'Marked done');
  return { job: jobSummary_(jobRow_(id)) };
}

/**
 * The one thing a customer ever receives, and only because a writer pressed
 * the button. Sendable more than once on purpose: an address gets corrected,
 * or Gmail drops a message, and the fix is to send it again.
 */
function sendInvoiceEmail(token, id) {
  requireAdmin_(token);
  const job = jobRow_(id);
  if (!job) throw new Error('No such job.');
  if (job.status !== 'done') throw new Error('That job is not marked done yet.');
  if (!job.customer_email) {
    throw new Error('This job has no customer email address, so there is nobody to send the invoice to.');
  }
  return { emailed: sendInvoiceEmail_(job), testMode: testMode_(), sentTo: testMode_() ? testEmail_() : job.customer_email };
}

/** What the portal needs to know about this deployment. */
function config(token) {
  requireAdmin_(token);
  return {
    testMode: testMode_(),
    testEmail: testEmail_(),
    customerTracking: customerTracking_(),
    siteUrl: SITE_URL,
    serviceEmail: SERVICE_EMAIL
  };
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
      if (entry.hours) bits.push('<b>' + entry.hours + ' h</b>');
      if (entry.partIdentifier) {
        bits.push('<b>' + esc_(entry.partIdentifier) + '</b>' + (entry.quantity ? ' &times; ' + entry.quantity : ''));
      }
      if (entry.text) bits.push(esc_(entry.text));
      if (!entry.text && entry.transcriptStatus === 'pending') bits.push('<i>voice note — still transcribing</i>');
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
 * Hands the recording to AssemblyAI and returns immediately - the mechanic
 * never waits on it. The audio stays in Drive either way; the words are
 * filled in underneath the entry when the webhook comes back.
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
      updateRow_('LogEntries', all[i]._row, {
        text: String(body.text || '').trim(),
        transcript_status: 'done',
        transcript_error: ''
      });
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
  if (params.transcript_id) applyTranscript_(params.transcript_id);
  return json_({ ok: true });
}

/**
 * Safety net for a webhook that never arrived - a deploy in the middle of a
 * transcription, or a delivery Google dropped. Runs alongside the digest.
 */
function sweepTranscripts_() {
  if (!assemblyKey_()) return;
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

/* ============================== triggers =============================== */

/** One hourly job does both: it keeps well inside the trigger runtime quota. */
function hourly() {
  sweepTranscripts_();
  sendDigest();
}

function installTriggers_() {
  const ours = { hourly: true, sendDailyOrders: true };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ours[trigger.getHandlerFunction()]) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  // 3pm Central — the script's own timezone, set in appsscript.json.
  ScriptApp.newTrigger('sendDailyOrders').timeBased().atHour(15).everyDays(1).create();
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
  rootFolder_();
  secret_();
  installTriggers_();

  const notes = [
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

/** Convenience for the editor: set the portal password without leaving it in code. */
function setAdminPassword(password) {
  if (!password || String(password).length < 8) throw new Error('Use at least 8 characters.');
  props_().setProperty('ADMIN_PASSWORD', String(password));
  return 'Portal password set.';
}
