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
function fakeSheet(name) {
  const rows = [];
  const sheet = {
    name,
    rows,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    appendRow: (row) => rows.push(row.slice()),
    getLastRow: () => rows.length,
    setFrozenRows: () => sheet,
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => {
        const out = [];
        for (let r = 0; r < (numRows || 1); r++) {
          const source = rows[row - 1 + r] || [];
          out.push(Array.from({ length: numCols || 1 }, (_, c) => source[col - 1 + c] ?? ''));
        }
        return out;
      },
      setValues: (values) => {
        values.forEach((line, r) => {
          while (rows.length < row + r) rows.push([]);
          const target = rows[row - 1 + r];
          line.forEach((value, c) => { target[col - 1 + c] = value; });
        });
      },
      setValue: (value) => {
        while (rows.length < row) rows.push([]);
        rows[row - 1][col - 1] = value;
      },
    }),
  };
  return sheet;
}

export function loadBackend(options = {}) {
  const sheets = new Map();
  const properties = new Map(Object.entries(options.properties || {}));
  const sentMail = [];
  const driveFiles = new Map();
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

  const folder = (name) => ({
    name,
    getId: () => `folder-${name}`,
    getFoldersByName: () => ({ hasNext: () => false, next: () => null }),
    createFolder: (child) => folder(child),
    createFile: (blob) => {
      const id = `drive-${driveFiles.size + 1}`;
      driveFiles.set(id, blob);
      return {
        getId: () => id,
        getName: () => blob.getName(),
        getBlob: () => blob,
        setSharing: (access, permission) => { sharing.set(id, `${access}/${permission}`); },
      };
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
      getFileById: (id) => ({
        getId: () => id,
        getName: () => (driveFiles.get(id) || { getName: () => 'file' }).getName(),
        getBlob: () => driveFiles.get(id),
      }),
    },
    GmailApp: {
      sendEmail: (to, subject, body, opts) => sentMail.push({ to, subject, body, opts }),
    },
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 500, getContentText: () => '{}', getBlob: () => null }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }) }) }),
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
  };
}
