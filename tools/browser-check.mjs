/**
 * Drives the real pages in a real browser against the real backend.
 *
 * The unit tests cover the parser and the backend separately; this is the
 * only thing that proves the parts fit — in particular that pdfjs and pdf-lib
 * run from their vendored copies in a browser, which is where intake actually
 * happens.
 *
 *   npm run serve            (in one terminal)
 *   node tools/browser-check.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { makeWorkOrderPdf, makeInvoicePdf } from '../scripts/lib/sample-work-order.mjs';

const BASE = process.env.BASE || 'http://localhost:8787';
const PASSWORD = process.env.ADMIN_PASSWORD || 'shop';
const SHOTS = 'scratch/shots';
const failures = [];

/** Font requests fail in sandboxes with no outbound network; not a page fault. */
const isEnvironmental = (text) =>
  /fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_CONNECTION_RESET|Failed to load resource/.test(text);

function check(label, condition, detail) {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(label);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
fs.mkdirSync(SHOTS, { recursive: true });

// A fresh invoice number per run: the backend refuses a duplicate, which is
// correct, and would otherwise make the second run of this script look broken.
const INVOICE = `01-${String(Math.floor(1000 + Math.random() * 8999))}`;
const WORK_ORDER = 'scratch/browser-check-wo.pdf';
fs.writeFileSync(WORK_ORDER, await makeWorkOrderPdf({
  invoice: INVOICE,
  unit: { year: '2019', make: 'Yamaha', model: '242X E-Series', serial: 'YAM12345K819', engine: 'Yamaha 1.8L HO' },
}));

/* ------------------------------------------------------------ service writer */
const desk = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const admin = await desk.newPage();
const adminErrors = [];
admin.on('pageerror', (error) => adminErrors.push(String(error)));
admin.on('console', (message) => { if (message.type() === 'error' && !isEnvironmental(message.text())) adminErrors.push(message.text()); });

console.log('\n== service writer ==');
await admin.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
await admin.fill('#password', PASSWORD);
await admin.click('button[type=submit]');
await admin.waitForSelector('.page-title');
check('signs in', (await admin.textContent('.page-title')).includes('Jobs'));

// This script walks the deployment through its switches — test mode off,
// tracking on — and `npm run serve` keeps its backend in memory. Run it
// twice against the same server and the second run starts from the end
// state of the first, then fails ten minutes later on a button that is
// showing its opposite label. Say so now instead.
const posture = await admin.evaluate(async (base) => {
  const token = localStorage.getItem('qst_token') || sessionStorage.getItem('qst_token');
  const res = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: 'config', token, args: [] }),
  });
  return res.json();
}, BASE);
if (posture.testMode !== true || posture.customerTracking !== false) {
  console.error(`\nFAILED: this backend is not in its default posture ` +
    `(testMode=${posture.testMode}, customerTracking=${posture.customerTracking}). ` +
    `That is where a previous run of this script left it. Restart 'npm run serve' ` +
    `and try again — its data lives in memory and only a restart clears it.`);
  await browser.close();
  process.exit(1);
}
check('starts from a fresh backend', true);

await admin.goto(`${BASE}/admin/?view=intake`, { waitUntil: 'networkidle' });
await admin.setInputFiles('#pdf', WORK_ORDER);
await admin.waitForSelector('#stage-review.on', { timeout: 20000 });

const parsed = {};
for (const id of ['invoiceNumber', 'customerName', 'customerPhone', 'customerEmail', 'boatInfo']) {
  parsed[id] = await admin.inputValue(`#${id}`);
}
console.log('  parsed in the browser:', JSON.stringify(parsed));
check('reads the invoice number from the PDF', parsed.invoiceNumber === INVOICE, parsed.invoiceNumber);
check('reads the customer name', parsed.customerName === 'JOHN SMITH', parsed.customerName);
check('reads the phone', parsed.customerPhone === '(815) 555-0142', parsed.customerPhone);
check('reads the email', parsed.customerEmail === 'jsmith@example.com', parsed.customerEmail);
check('reads the unit', /Yamaha/.test(parsed.boatInfo), parsed.boatInfo);
// The work band, off the body of the form — what the mechanic reads first.
const workRequested = await admin.inputValue('#workRequested');
check('reads what needs doing off the work order',
  /port engine stalling at idle/i.test(workRequested), workRequested);
check('and stops before the legal boilerplate', !/hereby authorize|Sale Total/i.test(workRequested));
await admin.screenshot({ path: `${SHOTS}/40-intake-review.png`, fullPage: true });

await admin.click('#create');
await admin.waitForSelector('#stage-done.on', { timeout: 30000 });
const doneText = await admin.textContent('#stage-done');
check('creates the job and stamps the PDF', /created/i.test(doneText));
check('the stamp saved to Drive', !/did not save/.test(doneText), doneText.slice(0, 120));
const trackLink = await admin.inputValue('#newlink');
const token = new URL(trackLink).searchParams.get('j');
check('hands back a tracking link', Boolean(token) && token.length === 20, trackLink);
await admin.screenshot({ path: `${SHOTS}/41-intake-done.png`, fullPage: true });

const invoiceNumber = parsed.invoiceNumber;
await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });
check('the job page opens', (await admin.textContent('.page-title')).includes(invoiceNumber));
check('the stamped work order is linked', await admin.locator('text=Open stamped work order').count() > 0);

/* ----------------------------------------------------------------- mechanic */
console.log('\n== mechanic ==');
const shop = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mech = await shop.newPage();
const mechErrors = [];
mech.on('pageerror', (error) => mechErrors.push(String(error)));
mech.on('console', (message) => { if (message.type() === 'error' && !isEnvironmental(message.text())) mechErrors.push(message.text()); });

await mech.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
await mech.click('#manual');
await mech.fill('#code', invoiceNumber);
await mech.click('button[type=submit]');
await mech.waitForSelector('#nameform, .namegrid', { timeout: 15000 });
await mech.screenshot({ path: `${SHOTS}/42-mech-signin.png`, fullPage: true });

// Once anyone has signed in, the roster shows instead of a blank field.
// Take the "not here" door so this exercises the typing path either way.
if (await mech.locator('#other').count()) await mech.click('#other');
await mech.waitForSelector('#name');
await mech.fill('#name', 'Dale');
await mech.click('#nameform button[type=submit]');
await mech.waitForSelector('.segmented', { timeout: 15000 });
check('signs in by typing a name', (await mech.textContent('.card')).includes(invoiceNumber));

// What needs doing has to reach the person holding the wrench.
check('the job screen shows what needs doing',
  /port engine stalling at idle/i.test(await mech.evaluate(() => document.body.innerText)));

await mech.click('.segmented button[data-tab="labor"]');
await mech.waitForSelector('#hours');
await mech.click('.hourchips button[data-h="1.5"]');
await mech.fill('#text', 'Pulled and reset the impeller housing.');
await mech.click('#save');
await mech.waitForSelector('.entry.labor', { timeout: 15000 });
check('logs hours with a description', (await mech.textContent('.entry.labor')).includes('1.5 h'));

// A voice note whose player points at the wrong Drive endpoint looks fine
// and plays nothing — 0:00 / 0:00 — so the URL itself is what gets checked.
// `uc?export=download` answers a media element with an HTML interstitial.
const audioSrcs = await mech.evaluate(() =>
  [...document.querySelectorAll('audio')].map((a) => a.getAttribute('src') || ''));
check('no player points at the retired uc?export endpoint',
  !audioSrcs.some((src) => src.includes('/uc?export=download')), audioSrcs.join(' | '));
// Logging the first entry starts the job; the phone must show that, not the
// status it was opened with.
check('the status pill catches up after the first entry',
  (await mech.textContent('.pill.frost')).includes('Work underway'),
  await mech.textContent('.pill.frost'));

await mech.click('.segmented button[data-tab="internal_note"]');
await mech.fill('#text', 'Owner never winterised this — bill the extra hour.');
await mech.click('#save');
await mech.waitForSelector('.entry.internal_note', { timeout: 15000 });

// The mechanic app no longer offers a customer note; the backend still knows
// the type, so the customer page can be brought back without one. Posting it
// on the wire keeps the strongest test in this file alive — that what the
// customer is shown is decided by customerView_ and nothing else.
const posted = await mech.evaluate(async ({ base, job, text }) => {
  const token = localStorage.getItem('qst_token') || sessionStorage.getItem('qst_token');
  const res = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: 'addEntry', token, args: [job, { entryType: 'customer_note', text }] }),
  });
  return res.json();
}, { base: BASE, job: token, text: 'Impeller is replaced and she runs clean.' });
check('the backend still takes a customer note', !posted.error, posted.error);

await mech.click('.segmented button[data-tab="part"]');
await mech.fill('#part', '6BH-44352-00-00');
await mech.fill('#qty', '2');
// Ticking the box should ask how many, then put it on the parts list.
await mech.check('#needorder');
check('ticking "needs ordering" asks how many', await mech.isVisible('#orderqty'));
await mech.fill('#orderqty', '2');
await mech.check('#needrestock');
await mech.fill('#restockqty', '1');
await mech.click('#save');
await mech.waitForSelector('.entry.part', { timeout: 15000 });
check('logs a part', (await mech.textContent('.entry.part')).includes('6BH-44352-00-00'));

// And a stock request with no job behind it.
await mech.click('a:has-text("Scan another work order")');
await mech.waitForSelector('#reqpart');
await mech.click('#reqpart');
await mech.waitForSelector('#pdesc');
await mech.fill('#pdesc', 'Spark plugs, box of 8');
await mech.fill('#pqty', '8');
await mech.fill('#pnote', 'Down to the last box');
await mech.screenshot({ path: `${SHOTS}/48-stock-request.png`, fullPage: true });
await mech.click('#form button[type=submit]');
await mech.waitForSelector('#scan', { timeout: 15000 });
check('takes a stock request with no part number', true);
await mech.screenshot({ path: `${SHOTS}/43-mech-job.png`, fullPage: true });

/* ------------------------------------------------------------------ parts */
console.log('\n== parts ==');
await admin.goto(`${BASE}/admin/?view=parts`, { waitUntil: 'networkidle' });
await admin.waitForSelector('.partlist', { timeout: 20000 });
const partsText = await admin.evaluate(() => document.body.innerText);
check('the ordered part is on the list', partsText.includes('6BH-44352-00-00'), partsText.slice(0, 200));
check('so is the restock, separately', (partsText.match(/6BH-44352-00-00/g) || []).length >= 2);
check('and the stock request', partsText.includes('Spark plugs'));
check('a request with no part number still shows', partsText.includes('(no part number)'));
const noteValues = await admin.evaluate(() =>
  Array.from(document.querySelectorAll('[data-note]')).map((input) => input.value));
check('notes come through', noteValues.some((v) => v.includes('Down to the last box')), noteValues.join(' | '));
await admin.screenshot({ path: `${SHOTS}/49-parts.png`, fullPage: true });

// Order the lot, then receive them one at a time.
const picks = await admin.locator('.partpick').count();
for (let i = 0; i < picks; i++) await admin.locator('.partpick').nth(i).check();
await admin.fill('#vendor', 'Mercury Marine');
await admin.fill('#ordernumber', 'PO-9912');
await admin.click('#markordered');
await admin.waitForSelector('[data-receive]', { timeout: 20000 });
check('the batch moves to on order', (await admin.locator('[data-receive]').count()) === picks);

let remaining = await admin.locator('[data-receive]').count();
while (remaining > 0) {
  await admin.locator('[data-receive]').first().click();
  await admin.waitForFunction((n) => document.querySelectorAll('[data-receive]').length === n - 1,
    remaining, { timeout: 20000 });
  remaining -= 1;
}
await admin.waitForSelector('details summary', { timeout: 20000 });
const afterText = await admin.evaluate(() => document.body.innerText);
check('and archives once every line is in',
  afterText.includes('PO-9912') && afterText.includes('Mercury Marine'),
  afterText.slice(afterText.indexOf('Completed'), afterText.indexOf('Completed') + 160));
await admin.screenshot({ path: `${SHOTS}/50-parts-done.png`, fullPage: true });

/* --------------------------------------------------------------- close out */
console.log('\n== close out ==');
const INVOICE_PDF = 'scratch/browser-check-invoice.pdf';
fs.writeFileSync(INVOICE_PDF, await makeInvoicePdf({ invoice: INVOICE }));

await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });

// The writer's checklist: everything logged so far moves behind the line.
check('entries start as needing writing up', (await admin.textContent('.card')).length > 0);
await admin.click('#marklogged');
await admin.waitForSelector('text=Already written up', { timeout: 20000 });
check('written-up entries move out of the way',
  (await admin.textContent('#view')).includes('Everything logged so far is written up'));
await admin.check('#ck-paid');
await admin.waitForFunction(() => document.getElementById('ck-paid')?.checked === true, { timeout: 20000 });
check('paid/closed sticks', await admin.isChecked('#ck-paid'));
await admin.screenshot({ path: `${SHOTS}/51-checklist.png`, fullPage: true });

await admin.setInputFiles('#invoice', INVOICE_PDF);
await admin.waitForFunction(() => {
  const el = document.getElementById('totalsmsg');
  return el && el.textContent && !el.textContent.includes('Reading');
}, { timeout: 30000 });
const totalsMessage = await admin.textContent('#totalsmsg');
console.log('  read off the invoice:', totalsMessage.trim());
check('reads the balance off the invoice', /1,632\.47/.test(totalsMessage), totalsMessage);
check('shows the deposit it was netted against', /15,285\.32/.test(totalsMessage), totalsMessage);
check('fills the amount due field', (await admin.inputValue('#amountDue')) === '1632.47');

await admin.fill('#paymentLink', 'https://pay.pospluslogin.com/questwatersports/abc123');
await admin.click('#invoiceform button[type=submit]');
await admin.waitForSelector('text=What the customer owes', { timeout: 20000 });
check('stores the balance on the job', (await admin.textContent('.hourstotal')).includes('1,632.47'));
await admin.screenshot({ path: `${SHOTS}/45-closeout.png`, fullPage: true });

// The deployment starts in test mode, so this first pass is the rehearsal.
check('the portal warns it is in test mode', await admin.locator('#testbanner .banner').count() > 0);
check('the done button just closes the ticket',
  (await admin.textContent('#markdone')).trim() === 'Mark done',
  await admin.textContent('#markdone'));

await admin.click('#markdone');
await admin.waitForSelector('text=Marked done', { timeout: 30000 });
check('marks the job done', (await admin.content()).includes('Marked done'));

// Closing a ticket must never post mail by itself.
const afterDone = await admin.evaluate(() => document.body.innerText);
check('and sends nothing on its own', /nothing has been emailed/i.test(afterDone));
check('the invoice email is a separate button', await admin.locator('#sendinvoice').count() > 0);

admin.once('dialog', (dialog) => dialog.accept());
await admin.click('#sendinvoice');
await admin.waitForSelector('text=Invoice emailed', { timeout: 30000 });
const afterSend = await admin.evaluate(() => document.body.innerText);
check('and says test mode kept it in the building', /test mode, so that was the shop/i.test(afterSend),
  afterSend.slice(afterSend.search(/Invoice emailed/i), afterSend.search(/Invoice emailed/i) + 160));
await admin.screenshot({ path: `${SHOTS}/45b-invoice-sent.png`, fullPage: true });

/* ------------------------------------------------------- as an internal tool */
console.log('\n== customer page switched off ==');
// A real customer has no shop session, which is the whole point.
const stranger = await browser.newContext({ viewport: { width: 430, height: 900 } });
const outsider = await stranger.newPage();
const outsiderErrors = [];
outsider.on('pageerror', (error) => outsiderErrors.push(String(error)));
await outsider.goto(`${BASE}/t/?j=${token}`, { waitUntil: 'networkidle' });
await outsider.waitForSelector('.card', { timeout: 15000 });
const dark = await outsider.evaluate(() => document.body.innerText);
check('a customer scanning the QR sees a holding message', /we have your boat/i.test(dark), dark.slice(0, 140));
check('which promises no link that is never coming', !/we will email you a link/i.test(dark));
check('and shows none of their job', !dark.includes('runs clean') && !dark.includes('1,632.47'));
await outsider.screenshot({ path: `${SHOTS}/46-internal-only.png`, fullPage: true });

console.log('\n== switching the customer page on ==');
await admin.goto(`${BASE}/admin/?view=setup`, { waitUntil: 'networkidle' });
await admin.waitForSelector('#trackon');
await admin.screenshot({ path: `${SHOTS}/47-setup.png`, fullPage: true });
admin.once('dialog', (dialog) => dialog.accept());
await admin.click('#trackon');
await admin.waitForSelector('#trackoff', { timeout: 20000 });
check('the tracking page switches on', await admin.locator('#trackoff').count() > 0);

await outsider.reload({ waitUntil: 'networkidle' });
await outsider.waitForSelector('.card', { timeout: 15000 });
const holding = await outsider.evaluate(() => document.body.innerText);
check('but test mode still holds the customer back', /not quite ready/i.test(holding), holding.slice(0, 140));
check('and still shows none of their job', !holding.includes('runs clean'));
await outsider.screenshot({ path: `${SHOTS}/46-holding.png`, fullPage: true });

// The same link in the service writer's browser, which IS signed in.
const preview = await desk.newPage();
await preview.goto(`${BASE}/t/?j=${token}`, { waitUntil: 'networkidle' });
await preview.waitForSelector('.status-hero', { timeout: 15000 });
const previewed = await preview.evaluate(() => document.body.innerText);
check('while staff previewing it see the real page', previewed.includes('runs clean'));
check('and are told it is a preview', previewed.includes('Test mode'));
await preview.close();

console.log('\n== going live ==');
await admin.goto(`${BASE}/admin/?view=setup`, { waitUntil: 'networkidle' });
await admin.waitForSelector('#golive');
await admin.screenshot({ path: `${SHOTS}/47-golive.png`, fullPage: true });
admin.once('dialog', (dialog) => dialog.accept());
await admin.click('#golive');
await admin.waitForSelector('#gotest', { timeout: 20000 });
check('going live is one switch', await admin.locator('#gotest').count() > 0);
check('and the warning banner goes', await admin.locator('#testbanner .banner').count() === 0);

/* ----------------------------------------------------------------- customer */
console.log('\n== customer, now live ==');
const customer = outsider;
const customerErrors = outsiderErrors;
await customer.reload({ waitUntil: 'networkidle' });
await customer.waitForSelector('.status-hero', { timeout: 15000 });
// What the customer can actually READ. Checking page source would match the
// page's own template strings and quietly pass on a real leak.
const seen = await customer.evaluate(() => document.body.innerText);
check('shows the customer note', seen.includes('runs clean'));
check('hides the internal note', !seen.includes('winterised'));
check('hides the labor description', !seen.includes('impeller housing'));
check('hides the hours figure', !seen.includes('1.5 h'));
check('hides the part number', !seen.includes('6BH-44352'));
check('hides the mechanic name', !seen.includes('Dale'));
check('offers the invoice now the job is done', seen.includes('View your invoice'));
// The number that matters: what they owe after their deposit, not the total.
check('shows the balance, not the grand total', seen.includes('$1,632.47'), seen.slice(0, 300));
check('never shows the grand total', !seen.includes('16,917.79'));
check('the pay button carries the figure', seen.includes('Pay $1,632.47'));
check('no longer says it is a preview', !seen.includes('Test mode'));
await customer.screenshot({ path: `${SHOTS}/44-customer.png`, fullPage: true });

// And the wire itself, since a page can only render what it was sent.
const wire = await customer.evaluate(async (base) => {
  const token = new URLSearchParams(location.search).get('j');
  const res = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: 'publicJob', args: [token] }),
  });
  return res.text();
}, BASE);
check('sends the customer nothing internal', !/6BH-44352|impeller housing|Dale|hours/.test(wire), wire.slice(0, 200));

await customer.goto(`${BASE}/t/?j=ZZZZZZZZZZZZZZZZZZZZ`, { waitUntil: 'networkidle' });
check('a wrong token says so plainly', (await customer.content()).includes('Link not found'));

/* --------------------------------------------------------- open jobs list */
console.log('\n== picking a job off the list ==');
// A job this mechanic never scanned and has no paper for — which is the
// whole point of the list. Created through the writer's own API so the
// section does not depend on what earlier sections left behind (by now the
// first job has been closed out, and a closed job is deliberately not on
// this list).
const FLOOR_INVOICE = `01-${String(Math.floor(1000 + Math.random() * 8999))}`;
const seeded = await admin.evaluate(async ({ base, invoice }) => {
  const token = localStorage.getItem('qst_token') || sessionStorage.getItem('qst_token');
  const res = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: 'createJob', token, args: [{
      invoiceNumber: invoice,
      customerName: 'AVA STONE',
      boatInfo: '2021 Yamaha AR195',
      workRequested: 'Winterise and replace the impeller.',
    }] }),
  });
  return res.json();
}, { base: BASE, invoice: FLOOR_INVOICE });
check('a second job is on the floor', !seeded.error, seeded.error);

const floor = await browser.newContext({ viewport: { width: 430, height: 900 } });
const picker = await floor.newPage();
const pickerErrors = [];
picker.on('pageerror', (error) => pickerErrors.push(String(error)));
picker.on('console', (message) => { if (message.type() === 'error' && !isEnvironmental(message.text())) pickerErrors.push(message.text()); });

await picker.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
await picker.waitForSelector('#openjobs');

// Signed out, the list must ask who you are first: one job by number means
// you hold the paper, the whole list is every customer at once.
await picker.click('#openjobs');
await picker.waitForSelector('#name, .namegrid', { timeout: 15000 });
check('the list asks who you are before showing it',
  /who is working|your name/i.test(await picker.evaluate(() => document.body.innerText)));

if (await picker.locator('#other').count()) await picker.click('#other');
await picker.waitForSelector('#name');
await picker.fill('#name', 'Dale');
await picker.click('#nameform button[type=submit]');

await picker.waitForSelector('[data-pick]', { timeout: 20000 });
const listed = await picker.evaluate(() => document.body.innerText);
check('lists the ticket number', listed.includes(FLOOR_INVOICE), listed.slice(0, 200));
check('lists the customer', /AVA STONE/i.test(listed));
check('lists the boat', /2021 Yamaha AR195/i.test(listed));
check('leaves the closed-out job off it', !listed.includes(invoiceNumber));
await picker.screenshot({ path: `${SHOTS}/43-open-jobs.png`, fullPage: true });

await picker.click(`[data-pick="0"]`);
await picker.waitForSelector('.segmented', { timeout: 20000 });
const opened = await picker.evaluate(() => document.body.innerText);
check('opens the job straight from the list', opened.includes(FLOOR_INVOICE));
check('and carries what needs doing with it', /winterise and replace the impeller/i.test(opened),
  opened.slice(0, 200));
await picker.close();

/* ------------------------------------------------------------- magic link */
// Its own context, so it starts signed out and cannot disturb anything above.
console.log('\n== mailed sign-in link ==');
const lockedOut = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const visitor = await lockedOut.newPage();
const visitorErrors = [];
visitor.on('pageerror', (error) => visitorErrors.push(String(error)));
visitor.on('console', (message) => { if (message.type() === 'error' && !isEnvironmental(message.text())) visitorErrors.push(message.text()); });

await visitor.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
await visitor.waitForSelector('#maillink');
await visitor.click('#maillink');
await visitor.waitForSelector('.banner.ok', { timeout: 20000 });
const sentNotice = await visitor.evaluate(() => document.body.innerText);
check('says where the link went', /service@questwatersports\.com/.test(sentNotice), sentNotice.slice(0, 160));

const mail = await (await fetch(`${BASE}/dev/mail`)).json();
const signInMail = mail.filter((m) => /Sign in to the/.test(m.subject)).pop();
check('the link email went to the service desk', signInMail && signInMail.to === 'service@questwatersports.com');
const nonce = signInMail && signInMail.body.match(/\?k=([0-9A-Z]{20})/);
check('and carries a one-time nonce', Boolean(nonce), signInMail && signInMail.body.slice(0, 120));

await visitor.goto(`${BASE}/admin/?k=${nonce[1]}`, { waitUntil: 'networkidle' });
await visitor.waitForSelector('.page-title', { timeout: 20000 });
check('following it signs the writer in', (await visitor.textContent('.page-title')).includes('Jobs'));
check('and the nonce is scrubbed out of the address', !visitor.url().includes('k='), visitor.url());
await visitor.screenshot({ path: `${SHOTS}/48-magic-link.png`, fullPage: true });

// Spent means spent. A fresh context is the honest test: somebody else with
// the same link and no session of their own.
const stale = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const replay = await stale.newPage();
await replay.goto(`${BASE}/admin/?k=${nonce[1]}`, { waitUntil: 'networkidle' });
await replay.waitForSelector('#maillink', { timeout: 20000 });
const refused = await replay.evaluate(() => document.body.innerText);
check('a second use is refused', /already been used|newer one replaced/i.test(refused), refused.slice(0, 160));
check('and it does not let them in', !/Jobs/.test(await replay.textContent('.card')));
await replay.close();

/* --------------------------------------------------------------------- done */
console.log('\n== page errors ==');
check('service writer console clean', adminErrors.length === 0, adminErrors.join(' | '));
check('mechanic console clean', mechErrors.length === 0, mechErrors.join(' | '));
check('customer console clean', customerErrors.length === 0, customerErrors.join(' | '));
check('sign-in console clean', visitorErrors.length === 0, visitorErrors.join(' | '));
check('open-jobs console clean', pickerErrors.length === 0, pickerErrors.join(' | '));

await browser.close();
console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'browser-check: all good'}`);
process.exit(failures.length ? 1 : 0);
