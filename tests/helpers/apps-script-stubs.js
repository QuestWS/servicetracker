import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Runs service-tracker.gs in a fake Apps Script environment.
 *
 * The backend cannot be exercised any other way outside Google, and it holds
 * the rule that matters most in this whole system — what a customer is
 * allowed to see. Sheets are 2D arrays, Drive hands out fake ids, and Gmail
 * records what it was asked to send.
 */
/**
 * Sheets coerces what you write to it, and that is a behaviour the backend
 * has to survive rather than a detail to paper over.
 *
 * A BiT invoice number — `01-8891` — written to a General-formatted cell is
 * read by Sheets as the first of January, 8891, and comes back as a Date.
 * An earlier version of this stub stored every value verbatim, so the tests
 * were green while the real deployment answered "No such job." on a job you
 * could see in the list. The stub now does what Sheets does, and the backend
 * has to format cells as text to avoid it.
 */
const DATEISH = /^\s*\d{1,4}[-/]\d{1,4}([-/]\d{1,4})?\s*$/;

function coerce(value, format) {
  if (format === '@') return value;             // plain text: stored as written
  if (typeof value !== 'string') return value;
  if (DATEISH.test(value)) {
    const parsed = sheetsDate(value);
    if (parsed) return parsed;
  }
  return value;
}

/** What Sheets makes of `MM-YYYY`: the first of that month, that year. */
function sheetsDate(value) {
  const bits = value.trim().split(/[-/]/).map(Number);
  if (bits.some((n) => !Number.isFinite(n))) return null;
  if (bits.length === 2) {
    const [month, year] = bits;
    if (month >= 1 && month <= 12 && year > 31) return new Date(year, month - 1, 1);
  }
  return null;
}

function fakeSheet(name) {
  const rows = [];
  const formats = [];                            // formats[row][col], '@' = text

  const formatAt = (r, c) => (formats[r] && formats[r][c]) || '';
  const setFormatAt = (r, c, format) => {
    while (formats.length <= r) formats.push([]);
    formats[r][c] = format;
  };

  const sheet = {
    name,
    rows,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    appendRow: (row) => rows.push(row.map((value, c) => coerce(value, formatAt(rows.length, c)))),
    getLastRow: () => rows.length,
    setFrozenRows: () => sheet,
    // 1-indexed, like the real thing, and it shifts every row below up — which
    // is exactly why the backend has to forget_() its memoised rows after
    // calling this. Both cancel paths in the backend depend on it.
    deleteRow: (rowNumber) => {
      rows.splice(rowNumber - 1, 1);
      formats.splice(rowNumber - 1, 1);
      return sheet;
    },
    getRange: (row, col, numRows, numCols) => {
      const range = {
        getValues: () => {
          const out = [];
          for (let r = 0; r < (numRows || 1); r++) {
            const source = rows[row - 1 + r] || [];
            out.push(Array.from({ length: numCols || 1 }, (_, c) => source[col - 1 + c] ?? ''));
          }
          return out;
        },
        setNumberFormat: (format) => {
          for (let r = 0; r < (numRows || 1); r++) {
            for (let c = 0; c < (numCols || 1); c++) setFormatAt(row - 1 + r, col - 1 + c, format);
          }
          return range;
        },
        setValues: (values) => {
          values.forEach((line, r) => {
            while (rows.length < row + r) rows.push([]);
            const target = rows[row - 1 + r];
            line.forEach((value, c) => {
              target[col - 1 + c] = coerce(value, formatAt(row - 1 + r, col - 1 + c));
            });
          });
          return range;
        },
        setValue: (value) => {
          while (rows.length < row) rows.push([]);
          rows[row - 1][col - 1] = coerce(value, formatAt(row - 1, col - 1));
          return range;
        },
      };
      return range;
    },
  };
  return sheet;
}

export function loadBackend(options = {}) {
  const sheets = new Map();
  const properties = new Map(Object.entries(options.properties || {}));
  const sentMail = [];
  const triggers = [];
  const driveFiles = new Map();
  const fetched = [];
  const sharing = new Map();
  let uuidCounter = 0;

  const spreadsheet = {
    getId: () => 'fake-spreadsheet',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/fake',
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => {
      const sheet = fakeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
    deleteSheet: (sheet) => sheets.delete(sheet.name),
  };

  // Which folder each file is in, so a test can ask whether the nightly
  // housekeeping actually walked it across.
  const fileParent = new Map();

  const fileHandle = (id) => ({
    getId: () => id,
    getName: () => (driveFiles.get(id) || { getName: () => 'file' }).getName(),
    getBlob: () => driveFiles.get(id),
    setSharing: (access, permission) => { sharing.set(id, `${access}/${permission}`); },
    moveTo: (destination) => {
      fileParent.set(id, destination.getId());
      return fileHandle(id);
    },
  });

  const folder = (name) => ({
    name,
    getId: () => `folder-${name}`,
    getFoldersByName: () => ({ hasNext: () => false, next: () => null }),
    createFolder: (child) => folder(child),
    // Drive gives a file its parent's permissions, so sharing the folder is
    // what makes the files inside it reachable.
    setSharing: (access, permission) => { sharing.set(`folder-${name}`, `${access}/${permission}`); },
    createFile: (blob) => {
      const id = `drive-${driveFiles.size + 1}`;
      driveFiles.set(id, blob);
      fileParent.set(id, `folder-${name}`);
      return fileHandle(id);
    },
  });

  const sandbox = {
    console,
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: (key) => properties.delete(key),
      }),
    },
    SpreadsheetApp: {
      openById: () => spreadsheet,
      create: () => spreadsheet,
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW' },
      createFolder: (name) => folder(name),
      getFolderById: () => folder('root'),
      getFileById: (id) => {
        if (!driveFiles.has(id)) throw new Error('No item with the given ID could be found.');
        return fileHandle(id);
      },
    },
    GmailApp: {
      sendEmail: (to, subject, body, opts) => sentMail.push({ to, subject, body, opts }),
    },
    // Programmable, because the transcription path is all UrlFetch and a stub
    // that only ever answers 500 cannot tell a working webhook from a broken
    // one. Tests hand in `fetch: (url, opts) => ({code, body})`.
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetched.push({ url: String(url), options: opts || {} });
        const reply = (options.fetch && options.fetch(String(url), opts || {})) || null;
        const code = reply && reply.code !== undefined ? reply.code : 500;
        const body = reply && reply.body !== undefined ? reply.body : '{}';
        return {
          getResponseCode: () => code,
          getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
          getBlob: () => null,
        };
      },
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    // Records what setup() actually schedules. A trigger nobody installs is
    // a feature that silently never runs.
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: (handler) => {
        const spec = { handler };
        const timed = {
          everyHours: (n) => { spec.everyHours = n; return timed; },
          atHour: (n) => { spec.atHour = n; return timed; },
          everyDays: (n) => { spec.everyDays = n; return timed; },
          create: () => { triggers.push(spec); },
        };
        return { timeBased: () => timed };
      },
      deleteTrigger: () => {},
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({ setMimeType: () => ({ getContent: () => text }) }),
    },
    Utilities: {
      getUuid: () => {
        uuidCounter += 1;
        return crypto.createHash('md5').update(`uuid-${uuidCounter}`).digest('hex')
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      },
      base64Encode: (input) => Buffer.from(input).toString('base64'),
      base64EncodeWebSafe: (input) =>
        Buffer.from(typeof input === 'string' ? input : Buffer.from(input)).toString('base64url'),
      base64Decode: (text) => Array.from(Buffer.from(text, 'base64')),
      base64DecodeWebSafe: (text) => Array.from(Buffer.from(text, 'base64url')),
      computeHmacSha256Signature: (value, key) =>
        Array.from(crypto.createHmac('sha256', key).update(value).digest()),
      /** Enough of Apps Script's formatDate for the patterns this backend uses. */
      formatDate: (date, timeZone, pattern) => {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
        return pattern
          .replace(/EEE/g, parts.weekday)
          .replace(/MMM/g, parts.month)
          .replace(/yyyy/g, parts.year)
          .replace(/\bd\b/g, parts.day);
      },
      newBlob: (bytes, mime, name) => ({
        getBytes: () => bytes,
        getName: () => name,
        getContentType: () => mime,
        getDataAsString: () => Buffer.from(bytes).toString('utf8'),
        setName: (n) => ({ getName: () => n, getBytes: () => bytes }),
      }),
    },
  };
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(path.join(process.cwd(), 'service-tracker.gs'), 'utf8');
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  // The backend refuses to touch a database it was never told about.
  sandbox.PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', 'fake-spreadsheet');
  vm.runInContext('ensureSheets_(SpreadsheetApp.openById("x"))', context);

  return {
    context,
    call: (expression) => vm.runInContext(expression, context),
    fn: (name, ...args) => {
      context.__args = args;
      return vm.runInContext(`${name}.apply(null, __args)`, context);
    },
    sentMail,
    sharing,
    properties,
    fetched,
    triggers,
    /** Which folder a Drive file is sitting in right now. */
    parentOf: (id) => fileParent.get(id) || null,
    /** Deliver a webhook the way AssemblyAI does: POST, id in the body. */
    post: (parameter, body) => {
      context.__event = { parameter: parameter, postData: { contents: JSON.stringify(body) } };
      return JSON.parse(vm.runInContext('doPost(__event).getContent()', context));
    },
    /** Raw tab access, for tests that need to stage damage a real Sheet did. */
    sheet: (name) => sheets.get(name),
  };
}
