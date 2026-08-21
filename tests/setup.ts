import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every run gets its own database and upload directory, so tests never touch
// the shop's data and never leak state into one another.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-tracker-test-'));
process.env.DATA_DIR = dir;
process.env.APP_URL = 'https://tracker.example.com';
process.env.SESSION_SECRET = 'test-secret';
