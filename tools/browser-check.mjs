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
import { makeWorkOrderPdf } from '../scripts/lib/sample-work-order.mjs';

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

await mech.click('.segmented button[data-tab="labor"]');
await mech.waitForSelector('#hours');
await mech.click('.hourchips button[data-h="1.5"]');
await mech.fill('#text', 'Pulled and reset the impeller housing.');
await mech.click('#save');
await mech.waitForSelector('.entry.labor', { timeout: 15000 });
check('logs hours with a description', (await mech.textContent('.entry.labor')).includes('1.5 h'));
// Logging the first entry starts the job; the phone must show that, not the
// status it was opened with.
check('the status pill catches up after the first entry',
  (await mech.textContent('.pill.frost')).includes('Work underway'),
  await mech.textContent('.pill.frost'));

await mech.click('.segmented button[data-tab="customer_note"]');
await mech.fill('#text', 'Impeller is replaced and she runs clean.');
await mech.click('#save');
await mech.waitForSelector('.entry.customer_note', { timeout: 15000 });

await mech.click('.segmented button[data-tab="part"]');
await mech.fill('#part', '6BH-44352-00-00');
await mech.fill('#qty', '2');
await mech.click('#save');
await mech.waitForSelector('.entry.part', { timeout: 15000 });
check('logs a part', (await mech.textContent('.entry.part')).includes('6BH-44352-00-00'));
await mech.screenshot({ path: `${SHOTS}/43-mech-job.png`, fullPage: true });

/* ----------------------------------------------------------------- customer */
console.log('\n== customer ==');
const public_ = await browser.newContext({ viewport: { width: 430, height: 900 } });
const customer = await public_.newPage();
const customerErrors = [];
customer.on('pageerror', (error) => customerErrors.push(String(error)));
await customer.goto(`${BASE}/t/?j=${token}`, { waitUntil: 'networkidle' });
await customer.waitForSelector('.status-hero', { timeout: 15000 });
// What the customer can actually READ. Checking page source would match the
// page's own template strings and quietly pass on a real leak.
const seen = await customer.evaluate(() => document.body.innerText);
check('shows the customer note', seen.includes('runs clean'));
check('hides the labor description', !seen.includes('impeller housing'));
check('hides the hours figure', !seen.includes('1.5 h'));
check('hides the part number', !seen.includes('6BH-44352'));
check('hides the mechanic name', !seen.includes('Dale'));
check('offers no invoice before done', !seen.includes('View your invoice'));

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
await customer.screenshot({ path: `${SHOTS}/44-customer.png`, fullPage: true });

await customer.goto(`${BASE}/t/?j=ZZZZZZZZZZZZZZZZZZZZ`, { waitUntil: 'networkidle' });
check('a wrong token says so plainly', (await customer.content()).includes('Link not found'));

/* --------------------------------------------------------------------- done */
console.log('\n== page errors ==');
check('service writer console clean', adminErrors.length === 0, adminErrors.join(' | '));
check('mechanic console clean', mechErrors.length === 0, mechErrors.join(' | '));
check('customer console clean', customerErrors.length === 0, customerErrors.join(' | '));

await browser.close();
console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'browser-check: all good'}`);
process.exit(failures.length ? 1 : 0);
