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
import { encode as encodePng } from '../scripts/lib/png.mjs';

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

/**
 * A context with the webfonts cut off at the door.
 *
 * The pages pull Barlow Condensed and friends from fonts.googleapis.com with
 * a render-blocking <link>. When the browser cannot reach Google — a sandbox
 * with no route out, a runner behind a proxy Chromium is not using, shop wifi
 * having a bad afternoon — that request does not fail fast. It sits for about
 * twelve seconds and then resets, and DOMContentLoaded waits the whole time.
 * Across the thirty-odd navigations in this script that was six minutes of a
 * six-and-a-half minute run: the checks themselves cost seconds.
 *
 * Blocking them is not a workaround, it is the right thing for a test to do.
 * Nothing here is checking Google's CDN, every family has a real fallback
 * stack, and a suite whose runtime depends on a third party's uptime tells
 * you very little on the day it is slow.
 */
async function shopContext(options) {
  const context = await browser.newContext(options);
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  return context;
}
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
const desk = await shopContext({ viewport: { width: 1280, height: 1000 } });
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

// The jobs list is read on a phone as often as a desk. The name column used to
// be handed whatever the pills left over — which at 390px was nothing — and
// then clipped, so the row showed an invoice number and no customer at all.
for (const width of [1280, 390]) {
  await admin.setViewportSize({ width, height: 900 });
  await admin.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.jobrow', { timeout: 20000 });
  const row = admin.locator(`.jobrow:has-text("${invoiceNumber}")`).first();
  const name = row.locator('.who');
  const box = await name.boundingBox();
  check(`the jobs list shows the customer at ${width}px`,
    Boolean(box) && box.width > 40 && (await name.textContent()).trim() === parsed.customerName,
    JSON.stringify({ box, text: await name.textContent() }));
}
await admin.screenshot({ path: `${SHOTS}/42-jobs-narrow.png`, fullPage: true });
await admin.setViewportSize({ width: 1280, height: 1000 });

/* ----------------------------------------------------------------- mechanic */
console.log('\n== mechanic ==');
const shop = await shopContext({ viewport: { width: 390, height: 844 } });
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

// Whether a bare file input offers "camera or library" is the phone's
// choice, and the shop's phone offered neither — first the camera only,
// then the gallery only. So there are two inputs and two buttons, and the
// OS is only ever asked for one specific thing. The QR scanner is a live
// getUserMedia stream, not a file input, and is untouched by any of it.
const photoInputs = await mech.evaluate(() => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    return el ? { capture: el.getAttribute('capture'), accept: el.getAttribute('accept'),
                  multiple: el.hasAttribute('multiple') } : null;
  };
  return {
    camera: read('#photocamera'),
    library: read('#photolibrary'),
    buttons: ['#takephoto', '#pickphoto'].filter((s) => document.querySelector(s)).length,
  };
});
check('both photo buttons are there', photoInputs.buttons === 2, JSON.stringify(photoInputs));
check('one door goes to the camera', photoInputs.camera && photoInputs.camera.capture === 'environment');
check('the other to the library', photoInputs.library && photoInputs.library.capture === null);
check('the library one takes several at once', photoInputs.library && photoInputs.library.multiple);
check('and both only take images',
  photoInputs.camera.accept === 'image/*' && photoInputs.library.accept === 'image/*');

// What needs doing has to reach the person holding the wrench.
check('the job screen shows what needs doing',
  /port engine stalling at idle/i.test(await mech.evaluate(() => document.body.innerText)));

await mech.click('.segmented button[data-tab="labor"]');
await mech.waitForSelector('#hours');
check('time is asked for in hours and minutes', await mech.locator('#minutes').count() === 1);
// A chip fills both boxes, so what is about to be saved is always the two
// numbers on screen — not a hidden figure the chip set behind them.
await mech.click('.hourchips button[data-m="240"]');
check('a chip fills both boxes',
  (await mech.inputValue('#hours')) === '4' && (await mech.inputValue('#minutes')) === '0',
  `${await mech.inputValue('#hours')}h ${await mech.inputValue('#minutes')}m`);
await mech.click('.hourchips button[data-m="45"]');
check('and a later chip replaces the figure rather than adding to it',
  (await mech.inputValue('#hours')) === '0' && (await mech.inputValue('#minutes')) === '45',
  `${await mech.inputValue('#hours')}h ${await mech.inputValue('#minutes')}m`);
// The steppers work on the pair as one duration. Five more minutes at 55
// has to read 1h 00m, not 60m, and five fewer at 1h 00m has to come back to
// 55m rather than stopping dead at zero minutes.
const shown = async () => `${await mech.inputValue('#hours')}h ${await mech.inputValue('#minutes')}m`;
const plusMinutes = '.stepper button[data-by="5"]';
const minusMinutes = '.stepper button[data-by="-5"]';

await mech.click('.hourchips button[data-m="45"]');
for (let i = 0; i < 2; i++) await mech.click(plusMinutes);
check('the minutes stepper carries into hours', (await shown()) === '0h 55m', await shown());
await mech.click(plusMinutes);
check('and 55 plus five is an hour, not sixty minutes', (await shown()) === '1h 0m', await shown());
await mech.click(minusMinutes);
check('and it borrows back down again', (await shown()) === '0h 55m', await shown());

await mech.click('.hourchips button[data-m="15"]');
for (let i = 0; i < 5; i++) await mech.click(minusMinutes);
check('and it never goes below nothing', (await shown()) === '0h 0m', await shown());

await mech.click('.stepper button[data-by="60"]');
check('the hours stepper adds an hour', (await shown()) === '1h 0m', await shown());
await mech.click('.stepper button[data-by="-60"]');
check('and takes one back', (await shown()) === '0h 0m', await shown());

// Typed by hand, which is the other half of the entry path.
await mech.fill('#hours', '1');
await mech.fill('#minutes', '30');
await mech.fill('#text', 'Pulled and reset the impeller housing.');
await mech.click('#save');
await mech.waitForSelector('.entry.labor', { timeout: 15000 });
check('logs the time with a description', (await mech.textContent('.entry.labor')).includes('1h 30m'));
check('and never shows it as a decimal',
  !(await mech.textContent('.entry.labor')).includes('1.5'));

// Three twenty-minute stints are an hour. Added up as decimals they are 59
// minutes, and the mechanic is short a minute on every invoice.
for (let i = 0; i < 3; i++) {
  await mech.fill('#hours', '');
  await mech.fill('#minutes', '20');
  await mech.fill('#text', `Twenty-minute stint ${i + 1}.`);
  await mech.click('#save');
  await mech.waitForFunction((n) => document.querySelectorAll('.entry.labor').length === n,
    i + 2, { timeout: 15000 });
}
check('three twenty-minute stints come to exactly an hour on top of the first',
  (await mech.evaluate(() => document.body.innerText)).includes('2h 30m on this job so far'),
  (await mech.evaluate(() => document.body.innerText)).slice(0, 200));

/* ------------------------------------------------------------ a prop out */
console.log('\n== a prop going out for repair ==');
// A prop has no barcode. What identifies it is the paper tag wired to it, so
// the mechanic photographs that — this stands in for the tag.
const TAG_PNG = 'scratch/browser-check-tag.png';
fs.writeFileSync(TAG_PNG, encodePng({
  width: 48, height: 48,
  data: Buffer.from(Array.from({ length: 48 * 48 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256))),
}));

// A prop is a tab alongside Hours, Parts and Notes — not a card below the
// log, where it sat under everything a mechanic scrolls past.
check('the prop form is a tab, not a card',
  await mech.locator('.segmented button[data-tab="prop"]').count() === 1);
await mech.click('.segmented button[data-tab="prop"]');
await mech.waitForSelector('#propdesc', { timeout: 20000 });
// Nothing on this tab writes a log entry, so none of the log entry's controls
// should be sitting there offering to.
const propTabHas = await mech.evaluate(() => ({
  text: Boolean(document.getElementById('text')),
  recorder: Boolean(document.querySelector('#recorder button')),
  logPhotos: Boolean(document.getElementById('takephoto')),
  save: (document.getElementById('save') || {}).textContent,
}));
check('and carries none of a log entry\u2019s fields',
  !propTabHas.text && !propTabHas.recorder && !propTabHas.logPhotos, JSON.stringify(propTabHas));
check('and the one save button says what it does here',
  /ready for pick-up/i.test(propTabHas.save || ''), propTabHas.save);

const tagInputs = await mech.evaluate(() => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    return el ? { capture: el.getAttribute('capture'), multiple: el.hasAttribute('multiple') } : null;
  };
  return { camera: read('#tagcamera'), library: read('#taglibrary') };
});
check('the tag gets its own camera door', tagInputs.camera && tagInputs.camera.capture === 'environment');
check('and its own library door', tagInputs.library && tagInputs.library.capture === null);
check('a tag is one tag, so neither takes several', !tagInputs.camera.multiple && !tagInputs.library.multiple);

await mech.setInputFiles('#tagcamera', TAG_PNG);
await mech.waitForSelector('#tagthumb figure img', { timeout: 20000 });
check('the tag photo previews before it is sent', await mech.locator('#tagthumb img').count() === 1);
await mech.fill('#propdesc', 'Stainless 3-blade, port side');
await mech.click('#save');
await mech.waitForSelector('.proprow', { timeout: 20000 });
check('the prop lands on the job, ready for pick-up',
  /ready for pick-up/i.test(await mech.textContent('.proprow')),
  await mech.textContent('.proprow'));
check('and the tag photo comes back with it', await mech.locator('.proprow img').count() === 1);
await mech.screenshot({ path: `${SHOTS}/55-prop-mechanic.png`, fullPage: true });

// Back to Hours, which is where the rest of this run expects to be.
await mech.click('.segmented button[data-tab="labor"]');
await mech.waitForSelector('#hours', { timeout: 20000 });

// A logged voice note links out to Drive rather than embedding a player.
// An embedded one pointed at the retired `uc?export=download` endpoint and
// showed 0:00 / 0:00 for months; the shop reads the transcript anyway. The
// preview of a recording not yet saved is a local blob and stays.
const feedAudio = await mech.evaluate(() =>
  [...document.querySelectorAll('.entry audio')].length);
check('a logged voice note embeds no player', feedAudio === 0, String(feedAudio));
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
// The quantity steppers step one box on its own, unlike the time pair.
const qtyPlus = (id) => `.stepper button[data-qty="${id}"][data-by="1"]`;
const qtyMinus = (id) => `.stepper button[data-qty="${id}"][data-by="-1"]`;
await mech.fill('#qty', '');
await mech.click(qtyPlus('qty'));
await mech.click(qtyPlus('qty'));
check('a quantity steps up from empty by one', (await mech.inputValue('#qty')) === '2',
  await mech.inputValue('#qty'));
await mech.click(qtyMinus('qty'));
check('and back down', (await mech.inputValue('#qty')) === '1', await mech.inputValue('#qty'));
await mech.click(qtyMinus('qty'));
check('and below one it empties rather than reading zero parts',
  (await mech.inputValue('#qty')) === '', `"${await mech.inputValue('#qty')}"`);
// A part can be a fraction of a unit — 1.5 quarts of oil — so stepping must
// not round the typed figure away.
await mech.fill('#qty', '1.5');
await mech.click(qtyPlus('qty'));
check('and it steps a fractional quantity without mangling it',
  (await mech.inputValue('#qty')) === '2.5', await mech.inputValue('#qty'));
await mech.fill('#qty', '2');

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

/* ------------------------------------------------------- filing it away */
console.log('\n== the parts archive ==');
await admin.locator('details summary').first().click();
await admin.waitForSelector('[data-archive]', { timeout: 20000 });
const filedLines = (await admin.locator('[data-archive]').first().getAttribute('data-archive')).split(',').length;
await admin.locator('[data-archive]').first().click();
await admin.waitForFunction(() => document.querySelectorAll('[data-archive]').length === 0,
  null, { timeout: 20000 });
check('a completed order can be filed away', await admin.locator('[data-archive]').count() === 0);
check('and the working list is left with what still needs doing',
  !(await admin.evaluate(() => document.body.innerText)).includes('PO-9912'));

await admin.click('a[href="?view=archive"]');
await admin.waitForSelector('#archivebody tr', { timeout: 20000 });
const archiveRows = () => admin.locator('#archivebody tr').count();
check('the archive page is reachable by the link on the parts page',
  (await admin.textContent('.page-title')).includes('Archived'));
check('and holds every line of the filed order', await archiveRows() === filedLines);
check('with the supplier kept', /Mercury Marine/.test(await admin.evaluate(() => document.body.innerText)));
await admin.screenshot({ path: `${SHOTS}/58-archive.png`, fullPage: true });

// Searching. Each of the four fields the shop asked to look things up by.
for (const [what, needle] of [['part', '6BH-44352'], ['customer', 'JOHN SMITH'],
                              ['supplier', 'Mercury'], ['work order', invoiceNumber]]) {
  await admin.fill('#archiveq', needle);
  await admin.waitForFunction((n) => document.querySelectorAll('#archivebody tr').length <= n,
    filedLines, { timeout: 20000 });
  const rows = await archiveRows();
  const text = await admin.textContent('#archivebody');
  check(`searching by ${what} finds it`, rows >= 1 && !/Nothing archived matches/.test(text),
    `${needle} -> ${rows} row(s)`);
}
await admin.fill('#archiveq', 'zzz-no-such-thing');
await admin.waitForFunction(() => /Nothing archived matches/.test(document.body.innerText),
  null, { timeout: 20000 });
check('and a search that matches nothing says so', true);
await admin.fill('#archiveq', '');
await admin.waitForFunction((n) => document.querySelectorAll('#archivebody tr').length === n,
  filedLines, { timeout: 20000 });

// Sorting. Clicking a header sorts by it; clicking again turns it round.
const supplierColumn = () => admin.evaluate(() =>
  [...document.querySelectorAll('#archivebody tr')].map((tr) => tr.children[2]?.textContent.trim()));
await admin.click('th[data-sort="vendor"] button');
const upwards = await supplierColumn();
await admin.click('th[data-sort="vendor"] button');
const downwards = await supplierColumn();
check('a column header sorts by that column',
  JSON.stringify(upwards) === JSON.stringify(downwards.slice().reverse()),
  JSON.stringify({ upwards, downwards }));
check('and says which way it is pointing',
  /[▲▼]/.test(await admin.textContent('th[data-sort="vendor"]')));

// Both of these re-render the whole page, and renderArchive blanks the table
// before it refills it — so "fewer rows than before" is briefly true at zero,
// on the loading state. Wait for the settled count, not for a decrease.
const settledAt = (n) => admin.waitForFunction(
  (want) => document.querySelectorAll('#archivebody tr').length === want, n, { timeout: 20000 });

// Restore puts it back on the working list.
await admin.locator('[data-unarchive]').first().click();
await settledAt(filedLines - 1);
check('a filed line can be restored', await archiveRows() === filedLines - 1,
  `filed ${filedLines}, now ${await archiveRows()}`);

// Delete is the irreversible one, so it asks first.
admin.once('dialog', (dialog) => dialog.accept());
await admin.locator('[data-archdelete]').first().click();
await settledAt(filedLines - 2);
check('and deleting asks before it does it, then does it',
  await archiveRows() === filedLines - 2,
  `filed ${filedLines}, now ${await archiveRows()} row(s)`);
await admin.goto(`${BASE}/admin/?view=parts`, { waitUntil: 'networkidle' });
await admin.waitForSelector('.partlist, .empty', { timeout: 20000 });

/* ----------------------------------------------------- the office writes in */
console.log('\n== notes from the office ==');
const INVOICE_PDF = 'scratch/browser-check-invoice.pdf';
fs.writeFileSync(INVOICE_PDF, await makeInvoicePdf({ invoice: INVOICE }));

await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });

// A note from the office, written on the job page and read on the floor.
await admin.fill('#writernote', 'Owner wants a call before you pull the lower unit.');
await admin.click('#addnote');
await admin.waitForSelector('text=From the office', { timeout: 20000 });
check('the writer can put a note on the job',
  /owner wants a call before you pull/i.test(await admin.evaluate(() => document.body.innerText)));

/* ---------------------------------------------------------- the props list */
console.log('\n== the props list ==');
await admin.goto(`${BASE}/admin/?view=props`, { waitUntil: 'networkidle' });
await admin.waitForSelector('.partlist', { timeout: 20000 });
const propsText = () => admin.evaluate(() => document.body.innerText);
check('the prop is waiting on the bench', /Stainless 3-blade/.test(await propsText()));
check('the tag photo is on the list, not a part number',
  await admin.locator('.tagshot img').count() > 0);
// Drive does not serve images to the preview server, so this run is also the
// broken-image case — which is exactly the one that used to shove three lines
// of blue alt text through the middle of the row.
const tagBox = await admin.locator('.tagshot').first().boundingBox();
check('and a tag photo that will not load stays inside its own box',
  tagBox.width <= 64 && tagBox.height <= 64, JSON.stringify(tagBox));
check('and it says which boat it came off', /JOHN SMITH/.test(await propsText()));
await admin.screenshot({ path: `${SHOTS}/56-props-ready.png`, fullPage: true });

// Out it goes, against whoever took it.
await admin.locator('.proppick').first().check();
await admin.fill('#propvendor', 'Ottawa Prop Works');
await admin.click('#markpicked');
await admin.waitForSelector('[data-fixed]', { timeout: 20000 });
check('a picked-up prop moves out for repair', /Ottawa Prop Works/.test(await propsText()));
check('and offers both ways back', await admin.locator('[data-unfixable]').count() === 1);

// It cannot be removed from the list once it has left the building.
check('and can no longer be pulled off the list',
  await admin.locator('[data-propcancel]').count() === 0);

await admin.click('[data-fixed]');
await admin.waitForFunction(() => document.querySelectorAll('[data-fixed]').length === 0,
  null, { timeout: 20000 });
check('and comes back fixed', /Returned — fixed/.test(await propsText()), (await propsText()).slice(0, 200));
await admin.screenshot({ path: `${SHOTS}/57-props-back.png`, fullPage: true });

/* -------------------------------------------------- a part ordered by phone */
console.log('\n== the writer putting a part on a job ==');
// Somebody rings up wanting a part. The writer has the work order open and
// never touches the mechanic app, but it has to reach the same list.
await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });
await admin.fill('#jobpartnum', 'PHONE-9000');
await admin.fill('#jobpartdesc', 'Impeller kit, 3.0L');
await admin.fill('#jobpartqty', '2');
await admin.fill('#jobpartnote', 'Customer called Tuesday');
await admin.click('#addjobpart');
await admin.waitForSelector('.ticketparts', { timeout: 20000 });
const ticket = await admin.evaluate(() => document.querySelector('.ticketparts').innerText);
check('the part lands on the job ticket', /PHONE-9000/.test(ticket), ticket.slice(0, 160));
check('and reads as still to order', /to order/i.test(ticket), ticket.slice(0, 160));

await admin.goto(`${BASE}/admin/?view=parts`, { waitUntil: 'networkidle' });
await admin.waitForSelector('.partlist', { timeout: 20000 });
check('and on the writer\u2019s ordering list',
  /PHONE-9000/.test(await admin.evaluate(() => document.body.innerText)));

// It has to take an order number and an arrival like any other part.
const phoneRow = admin.locator('.partrow:has-text("PHONE-9000")');
await phoneRow.locator('.partpick').check();
await admin.fill('#vendor', 'Mercury Marine');
await admin.fill('#ordernumber', 'PO-3311');
await admin.click('#markordered');
await admin.waitForSelector('.partrow:has-text("PHONE-9000") [data-receive]', { timeout: 20000 });
check('it takes a supplier and an order number',
  /PO-3311/.test(await admin.evaluate(() => document.body.innerText)));
await admin.locator('.partrow:has-text("PHONE-9000") [data-receive]').click();
await admin.waitForFunction(
  () => !document.querySelector('.partrow:has([data-receive])')
    || ![...document.querySelectorAll('.partrow')].some((row) =>
      row.innerText.includes('PHONE-9000') && row.querySelector('[data-receive]')),
  null, { timeout: 20000 });
check('and gets ticked off when it arrives',
  await admin.locator('.partrow:has-text("PHONE-9000") [data-receive]').count() === 0);

await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });
await admin.waitForSelector('.ticketparts', { timeout: 20000 });
check('and the job ticket says it arrived',
  /arrived/i.test(await admin.evaluate(() => document.querySelector('.ticketparts').innerText)));
await admin.screenshot({ path: `${SHOTS}/59-phone-part.png`, fullPage: true });

/* ------------------------------------------------------------- the alert */
console.log('\n== the red alert ==');
// The props list left the portal on another page.
await admin.goto(`${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`, { waitUntil: 'networkidle' });
const ALERT = 'Do not start — owner is disputing the estimate.';
await admin.fill('#alerttext', ALERT);
await admin.click('#setalert');
await admin.waitForSelector('.alertbox', { timeout: 20000 });
check('the writer can put an alert on the job',
  (await admin.textContent('.alertbox-text')).includes('disputing'));
await admin.screenshot({ path: `${SHOTS}/52-alert-writer.png`, fullPage: true });

// The floor: on the job screen, and on the list before the job is even opened.
// The phone is a single-page app, so re-open the job the way a mechanic does
// — by its number — rather than reloading onto the home screen.
const openJobByNumber = async () => {
  await mech.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
  await mech.click('#manual');
  await mech.fill('#code', invoiceNumber);
  await mech.click('button[type=submit]');
  await mech.waitForSelector('.segmented', { timeout: 20000 });
};
await openJobByNumber();
await mech.waitForSelector('[data-alert]', { timeout: 20000 });
const banner = mech.locator('[data-alert]');
check('the mechanic gets it in red across the top of the job',
  (await banner.textContent()).includes('disputing'));
const bannerColour = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
check('and it is actually red', bannerColour === 'rgb(179, 38, 30)', bannerColour);
// Above the fold matters more than merely present: it is the first thing on
// the screen, not something to be found by scrolling.
const bannerTop = (await banner.boundingBox()).y;
const headerTop = (await mech.locator('.card').first().boundingBox()).y;
check('it sits above the job it is about', bannerTop < headerTop);
await mech.screenshot({ path: `${SHOTS}/53-alert-mechanic.png`, fullPage: true });

await mech.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
await mech.click('#openjobs');
await mech.waitForSelector('.joblist', { timeout: 20000 });
check('the open-jobs list flags it before the job is opened',
  await mech.locator('.joblist.flagged').count() > 0);
check('and the flagged job is first in the list',
  (await mech.locator('.joblist').first().getAttribute('class')).includes('flagged'));
await mech.screenshot({ path: `${SHOTS}/54-alert-list.png`, fullPage: true });

// Taking it down leaves the record behind.
await admin.click('#clearalert');
await admin.waitForSelector('#alerttext', { timeout: 20000 });
check('the writer can take it back down', await admin.locator('.alertbox').count() === 0);
check('and what it said stays in the shop log',
  /alert: do not start/i.test(await admin.evaluate(() => document.body.innerText)));
await mech.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
await mech.click('#openjobs');
await mech.waitForSelector('.joblist', { timeout: 20000 });
check('and the flag comes off the list', await mech.locator('.joblist.flagged').count() === 0);

// Put it back for the customer-boundary checks further down.
await admin.fill('#alerttext', ALERT);
await admin.click('#setalert');
await admin.waitForSelector('.alertbox', { timeout: 20000 });

console.log('\n== close out ==');
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

/* ------------------------------------------------------ the QR on the paper */
console.log('\n== what a customer scanning the work order gets ==');
// The QR stamped on every work order points at /t/, and that paper cannot be
// recalled, so the address has to keep answering. Customer tracking is
// scrapped: what it answers is the shop's phone number and nothing else.
const stranger = await shopContext({ viewport: { width: 430, height: 900 } });
const outsider = await stranger.newPage();
const outsiderErrors = [];
outsider.on('pageerror', (error) => outsiderErrors.push(String(error)));
await outsider.goto(`${BASE}/t/?j=${token}`, { waitUntil: 'networkidle' });
await outsider.waitForSelector('.card', { timeout: 15000 });
const dark = await outsider.evaluate(() => document.body.innerText);
check('a customer scanning the QR gets the shop, not a job', /815-433-2200/.test(dark), dark.slice(0, 160));
check('and none of their job', !dark.includes('runs clean') && !dark.includes('1,632.47'));
check('and no mention of tracking anything', !/track/i.test(dark), dark.slice(0, 200));
// A bad token has nothing to look up, so it cannot fail differently.
await outsider.goto(`${BASE}/t/?j=ZZZZZZZZZZZZZZZZZZZZ`, { waitUntil: 'networkidle' });
check('and a wrong code reaches the same place rather than an error',
  /815-433-2200/.test(await outsider.evaluate(() => document.body.innerText)));
await outsider.screenshot({ path: `${SHOTS}/46-qr-landing.png`, fullPage: true });

console.log('\n== going live ==');
await admin.goto(`${BASE}/admin/?view=setup`, { waitUntil: 'networkidle' });
await admin.waitForSelector('#golive');
const setupText = await admin.evaluate(() => document.body.innerText);
check('the setup page offers no customer page to switch on',
  !/tracking|customer page/i.test(setupText), setupText.slice(0, 200));
await admin.screenshot({ path: `${SHOTS}/47-golive.png`, fullPage: true });
admin.once('dialog', (dialog) => dialog.accept());
await admin.click('#golive');
await admin.waitForSelector('#gotest', { timeout: 20000 });
check('going live is one switch', await admin.locator('#gotest').count() > 0);
check('and the warning banner goes', await admin.locator('#testbanner .banner').count() === 0);

/* ------------------------------------------------------ the boundary itself */
console.log('\n== the customer boundary, on the wire ==');
// No page renders this any more, but publicJob and customerView_ are still in
// the backend and verify.sh still guards them — so the boundary has to keep
// being tested. Switched on deliberately here, through the API rather than a
// button, precisely because there is no button: this asks what the code would
// disclose if the shop ever turned it back on.
const wire = await admin.evaluate(async ({ base, jobToken }) => {
  const shop = localStorage.getItem('qst_token') || sessionStorage.getItem('qst_token');
  const post = (fn, args, tok) => fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn, token: tok, args }),
  }).then((res) => res.text());
  await post('setCustomerTracking', [true], shop);
  const body = await post('publicJob', [jobToken]);
  await post('setCustomerTracking', [false], shop);
  return body;
}, { base: BASE, jobToken: token });
check('the customer note is what comes through', /runs clean/.test(wire), wire.slice(0, 160));
check('and nothing internal does',
  !/6BH-44352|impeller housing|winterised|pull the lower unit|Dale/.test(wire), wire.slice(0, 240));
check('not the hours', !/"hours":\s*[0-9]/.test(wire));
check('not the red alert', !/disputing|alert/i.test(wire));
check('not the prop that went out', !/3-blade|prop/i.test(wire));
// The balance after deposits, never the grand total.
check('the balance is disclosed, the grand total is not',
  wire.includes('1632.47') && !wire.includes('16917.79'), wire.slice(0, 240));

/* ------------------------------------------------- nothing says "tracking" */
// Wording is exactly the kind of thing that creeps back one hint at a time,
// so this reads what is actually on the screen — innerText, not source, which
// would match template strings the page never renders.
for (const [where, url] of [
  ['the jobs list', `${BASE}/admin/`],
  ['a job page', `${BASE}/admin/?job=${encodeURIComponent(invoiceNumber)}`],
  ['intake', `${BASE}/admin/?view=intake`],
  ['the parts list', `${BASE}/admin/?view=parts`],
  ['app setup', `${BASE}/admin/?view=setup`],
]) {
  await admin.goto(url, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.card, .jobrow, .page-title', { timeout: 20000 });
  const words = await admin.evaluate(() => document.body.innerText);
  check(`${where} says nothing about tracking or a customer page`,
    !/tracking|customer page/i.test(words),
    (words.match(/.{0,40}(tracking|customer page).{0,40}/i) || [''])[0]);
}
const floorWords = await mech.evaluate(() => document.body.innerText);
check('and neither does the mechanic app',
  !/tracking|customer page/i.test(floorWords),
  (floorWords.match(/.{0,40}(tracking|customer page).{0,40}/i) || [''])[0]);

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

const floor = await shopContext({ viewport: { width: 430, height: 900 } });
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

/* ----------------------------------------------------------- getting out */
// Back means "where I came from", which is a different place depending on how
// the job was opened, and Home always means the scan screen. Both live in the
// chrome, so neither depends on the screen you are trying to leave.
check('a job opened from the list offers a way back', await picker.isVisible('#navback'));
await picker.click('#navback');
await picker.waitForSelector('.joblist', { timeout: 20000 });
check('and Back from it lands on the list, not the scanner',
  await picker.locator('.joblist').count() > 0);
check('the list offers Back too', await picker.isVisible('#navback'));
await picker.click('#navback');
await picker.waitForSelector('#manual', { timeout: 20000 });
check('which reaches the scan screen', await picker.isVisible('#manual'));
check('where Back is no longer offered, there being nowhere behind it',
  !(await picker.isVisible('#navback')));

// The same job reached the other way has a different thing behind it.
await picker.click('#manual');
await picker.fill('#code', FLOOR_INVOICE);
await picker.click('button[type=submit]');
await picker.waitForSelector('.segmented', { timeout: 20000 });
await picker.click('#navback');
await picker.waitForSelector('#manual', { timeout: 20000 });
check('a job opened by number goes Back to the scan screen instead',
  await picker.isVisible('#manual'));

// Home is the one that is always there and always means the same thing.
await picker.click('#openjobs');
await picker.waitForSelector('.joblist', { timeout: 20000 });
await picker.locator('.joblist').first().click();
await picker.waitForSelector('.segmented', { timeout: 20000 });
await picker.click('#navhome');
await picker.waitForSelector('#manual', { timeout: 20000 });
check('and Home leaves a job whatever the route in', await picker.isVisible('#manual'));
check('Home is offered everywhere, including home itself',
  await picker.isVisible('#navhome'));

await picker.close();

/* ------------------------------------------------------------- magic link */
// Its own context, so it starts signed out and cannot disturb anything above.
console.log('\n== mailed sign-in link ==');
const lockedOut = await shopContext({ viewport: { width: 1280, height: 900 } });
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
const stale = await shopContext({ viewport: { width: 1280, height: 900 } });
const replay = await stale.newPage();
await replay.goto(`${BASE}/admin/?k=${nonce[1]}`, { waitUntil: 'networkidle' });
await replay.waitForSelector('#maillink', { timeout: 20000 });
const refused = await replay.evaluate(() => document.body.innerText);
check('a second use is refused', /already been used|newer one replaced/i.test(refused), refused.slice(0, 160));
check('and it does not let them in', !/Jobs/.test(await replay.textContent('.card')));
await replay.close();

/* ------------------------------------------------- the phone after a deploy */
console.log('\n== the mechanic PWA after an update ==');
// The shop's phone stopped at "Starting up…" and stayed there. The service
// worker served the page network-first and the modules cache-first, so a
// deploy that added an export handed the phone the NEW page and the OLD
// module — and an ES import naming a missing export does not degrade, it
// stops the whole script. This reproduces that exactly: install the worker,
// poison its cache with a module missing the export the page imports, and
// reload. Network-first is what has to win.
const pwa = await shopContext({ viewport: { width: 390, height: 844 } });
const phone = await pwa.newPage();
const pwaErrors = [];
phone.on('pageerror', (error) => pwaErrors.push(String(error)));

await phone.goto(`${BASE}/m/`, { waitUntil: 'networkidle' });
const controlled = await phone.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return false;
  await navigator.serviceWorker.register('../sw.js', { updateViaCache: 'none' }).catch(() => {});
  await navigator.serviceWorker.ready;
  return true;
});
check('the mechanic app installs its service worker', controlled);

await phone.reload({ waitUntil: 'networkidle' });
await phone.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
check('which then controls the page', true);
check('and the app boots under it',
  !/Starting up/.test(await phone.evaluate(() => document.body.innerText)),
  (await phone.evaluate(() => document.body.innerText)).slice(0, 120));

// Now the deploy. An old module, cached, missing what the page imports.
const poisoned = await phone.evaluate(async () => {
  const keys = await caches.keys();
  if (!keys.length) return false;
  const cache = await caches.open(keys[0]);
  const target = new URL('../assets/lib/entry-types.js', location.href).href;
  await cache.put(target, new Response(
    'export const ENTRY_LABEL = {};\nexport function formatHours() { return ""; }\n',
    { headers: { 'Content-Type': 'text/javascript' } }));
  const stale = await cache.match(target);
  return !(await stale.text()).includes('formatMinutes');
});
check('a stale module can be planted in its cache, the way a deploy used to',
  poisoned, String(poisoned));

await phone.reload({ waitUntil: 'networkidle' });
const afterStale = await phone.evaluate(() => document.body.innerText);
check('and the app still starts, because the network wins over the cache',
  !/Starting up|did not start/.test(afterStale), afterStale.slice(0, 160));
check('and it is the real module that loaded, not the planted one',
  await phone.evaluate(async () => {
    const module = await import('../assets/lib/entry-types.js');
    return typeof module.formatMinutes === 'function';
  }));

// The watchdog: the last line of defence when the module cannot load at all.
check('a watchdog stands behind all of it',
  await phone.evaluate(() => typeof window.__questBooted === 'boolean'));
check('and it knows the app got up', await phone.evaluate(() => window.__questBooted === true));

// A stale stylesheet leaves a page that works but looks wrong, which the
// watchdog cannot see — so the way out has to be reachable on purpose, and
// from every screen, including one that failed to draw.
check('and there is an always-present way to update the app',
  await phone.locator('#updateapp').count() === 1);
check('which lives outside the screen that redraws',
  await phone.evaluate(() => {
    const button = document.getElementById('updateapp');
    const view = document.getElementById('view');
    return Boolean(button && view && !view.contains(button));
  }));
check('and it can actually throw the caches away',
  await phone.evaluate(() => typeof window.__questReset === 'function'));
check('mechanic PWA console clean', pwaErrors.length === 0, pwaErrors.join(' | '));
await pwa.close();

/* --------------------------------------------------------------------- done */
console.log('\n== page errors ==');
check('service writer console clean', adminErrors.length === 0, adminErrors.join(' | '));
check('mechanic console clean', mechErrors.length === 0, mechErrors.join(' | '));
check('QR landing console clean', outsiderErrors.length === 0, outsiderErrors.join(' | '));
check('sign-in console clean', visitorErrors.length === 0, visitorErrors.join(' | '));
check('open-jobs console clean', pickerErrors.length === 0, pickerErrors.join(' | '));

await browser.close();
console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'browser-check: all good'}`);
process.exit(failures.length ? 1 : 0);
