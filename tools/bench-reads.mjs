/**
 * Counts what one web request actually costs the Sheet.
 *
 * A Sheet has no index, so rows_() reads the WHOLE tab every time — and the
 * row cache is per-execution, so every web request starts cold. That makes
 * cell-reads-per-request the number that decides how slow the app feels, and
 * the number that grows every week the shop uses it.
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

const stats = { reads: 0, cells: 0, writes: 0 };
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
      stats.cells += v.length * (v[0]?.length || 0);
      return v;
    } };
  };
  const realRange = sheet.getRange.bind(sheet);
  sheet.getRange = (...args) => {
    const range = realRange(...args);
    const set = range.setValues.bind(range);
    return { ...range, setValues: (v) => { stats.writes++; return set(v); } };
  };
}

console.log(`\n  ${JOBS} jobs, ${JOBS * ENTRIES} log entries.`);
console.log('  Each line is ONE fresh web request — the row cache starts empty, as in production.\n');

function measure(label, fn) {
  backend.fn('forget_');                    // what a new execution begins with
  stats.reads = 0; stats.cells = 0; stats.writes = 0;
  fn();
  console.log(`  ${label.padEnd(32)} reads ${String(stats.reads).padStart(2)}`
    + `   cells ${String(stats.cells).padStart(7)}   writes ${String(stats.writes).padStart(2)}`);
}

measure('addEntry (hours)', () =>
  backend.fn('addEntry', mech, token, { entryType: 'labor', minutes: 30, text: 'Impeller.' }));
measure('addEntry (part + order line)', () =>
  backend.fn('addEntry', mech, token, { entryType: 'part', partIdentifier: 'X-1', quantity: 1, orderQty: 1 }));
measure('jobForMechanic (open a job)', () => backend.fn('jobForMechanic', mech, token));
measure('listJobs (writer jobs list)', () => backend.fn('listJobs', admin, {}));
measure('getJob (writer job page)', () => backend.fn('getJob', admin, '01-9000'));
measure('openJobs (mechanic job list)', () => backend.fn('openJobs', mech));
measure('listParts (parts list)', () => backend.fn('listPartsOrders', admin));
console.log('');
