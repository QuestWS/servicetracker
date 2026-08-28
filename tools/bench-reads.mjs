/**
 * Counts what one web request actually costs the Sheet.
 *
 * A Sheet has no index, so rows_() reads the WHOLE tab every time — and the
 * row cache is per-execution, so every web request starts cold. That makes
 * cell-reads-per-request the number that grows every week the shop uses it.
 *
 * `ops` is the other number, and at the shop's current size it is the one
 * that decides how slow a save FEELS. Every getValues, getLastRow,
 * setNumberFormat and setValues is a separate round trip from Apps Script to
 * Google's servers, and each costs the same tens of milliseconds whether the
 * range is one cell or ten thousand. Forty jobs' worth of cells crosses the
 * wire faster than four needless calls.
 *
 * This runs the real service-tracker.gs against the test stub with the sheet
 * API instrumented, seeds a shop of a given size, and reports reads and writes
 * per operation. Run it before and after a change: the point is evidence, not
 * an opinion about which version is faster.
 *
 *   node tools/bench-reads.mjs            # 40 jobs, 8 entries each
 *   node tools/bench-reads.mjs 400 8      # a shop a couple of years in
 */
import { loadBackend } from '../tests/helpers/apps-script-stubs.js';

const JOBS = Number(process.argv[2] || 40);
const ENTRIES = Number(process.argv[3] || 8);

const backend = loadBackend({ properties: { ADMIN_PASSWORD: 'x' } });
const admin = backend.fn('adminSignIn', 'x').token;
const mech = backend.fn('mechanicSignIn', 'Dale', true).token;

for (let j = 0; j < JOBS; j++) {
  const id = `01-${9000 + j}`;
  backend.fn('createJob', admin, {
    invoiceNumber: id, customerName: `Customer ${j}`, customerPhone: '(815) 555-0142',
    customerEmail: 'x@example.com', boatInfo: '2019 Yamaha 242X',
  });
  const jobToken = backend.fn('jobRow_', id).token;
  for (let e = 0; e < ENTRIES; e++) {
    backend.fn('addEntry', mech, jobToken, { entryType: 'labor', minutes: 30, text: 'Work.' });
  }
}
const token = backend.fn('jobRow_', '01-9000').token;

const stats = { reads: 0, cells: 0, writes: 0, ops: 0 };
for (const name of ['Jobs', 'LogEntries', 'PartsOrders', 'PropRepairs',
                    'StatusEvents', 'EmailLog', 'Mechanics']) {
  const sheet = backend.sheet(name);
  if (!sheet) continue;
  const realData = sheet.getDataRange.bind(sheet);
  sheet.getDataRange = () => {
    const range = realData();
    const values = range.getValues.bind(range);
    return { ...range, getValues: () => {
      const v = values();
      stats.reads++;
      stats.ops++;
      stats.cells += v.length * (v[0]?.length || 0);
      return v;
    } };
  };
  const realLast = sheet.getLastRow.bind(sheet);
  sheet.getLastRow = () => { stats.ops++; return realLast(); };
  const realRange = sheet.getRange.bind(sheet);
  sheet.getRange = (...args) => {
    const range = realRange(...args);
    const set = range.setValues.bind(range);
    const get = range.getValues.bind(range);
    const format = range.setNumberFormat.bind(range);
    return { ...range,
      getValues: () => { stats.ops++; return get(); },
      setNumberFormat: (f) => { stats.ops++; return format(f); },
      setValues: (v) => { stats.writes++; stats.ops++; return set(v); } };
  };
}

console.log(`\n  ${JOBS} jobs, ${JOBS * ENTRIES} log entries.`);
console.log('  Each line is ONE fresh web request — the row cache starts empty, as in production.\n');

function measure(label, fn) {
  backend.fn('forget_');                    // what a new execution begins with
  stats.reads = 0; stats.cells = 0; stats.writes = 0; stats.ops = 0;
  fn();
  console.log(`  ${label.padEnd(32)} ops ${String(stats.ops).padStart(3)}`
    + `   whole-tab reads ${String(stats.reads).padStart(2)}`
    + `   cells ${String(stats.cells).padStart(7)}   writes ${String(stats.writes).padStart(2)}`);
}

measure('addEntry (hours)', () =>
  backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 30, text: 'Impeller.' }));
measure('addEntry (part + order line)', () =>
  backend.fn('addEntry', mech, token, { entryType: 'part', partIdentifier: 'X-1', quantity: 1, orderQty: 1 }));
measure('lookupJob (scan, signed in)', () => backend.fn('lookupJob', '01-9000', 'scan', mech));
measure('jobForMechanic (open a job)', () => backend.fn('jobForMechanic', mech, token));
measure('listJobs (writer jobs list)', () => backend.fn('listJobs', admin, {}));
measure('getJob (writer job page)', () => backend.fn('getJob', admin, '01-9000'));
measure('openJobs (mechanic job list)', () => backend.fn('openJobs', mech));
measure('listParts (parts list)', () => backend.fn('listPartsOrders', admin));
console.log('');
