/**
 * Writes a practice work order laid out the way BiT lays one out, for trying
 * intake end to end before a real job goes through.
 *
 * Run: npm run sample-work-order [-- out.pdf]
 */
import fs from 'node:fs';
import { makeWorkOrderPdf } from './lib/sample-work-order.mjs';

const out = process.argv[2] ?? 'sample-work-order.pdf';
const invoice = process.env.SAMPLE_INVOICE ?? `01-${Math.floor(1000 + Math.random() * 8999)}`;
fs.writeFileSync(out, await makeWorkOrderPdf({ invoice }));
console.log(`wrote ${out} — invoice ${invoice}`);
