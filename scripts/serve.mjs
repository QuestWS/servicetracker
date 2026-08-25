/**
 * Local preview: serves the static site AND runs the real backend.
 *
 * `service-tracker.gs` is executed through the same stubbed Apps Script
 * environment the tests use, so the pages talk to the actual backend logic
 * rather than a hand-written mock. Data lives in memory and is gone when you
 * stop the server.
 *
 *   npm run serve   →  http://localhost:8787
 *
 * Nothing here ships. GitHub Pages serves the files and Google runs the .gs.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from '../tests/helpers/apps-script-stubs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const PASSWORD = process.env.ADMIN_PASSWORD || 'shop';

const backend = loadBackend({ properties: { ADMIN_PASSWORD: PASSWORD } });

const CONFIG_JS = path.join(ROOT, 'assets', 'lib', 'config.js');

/** Rewrites the two URLs that must point at this preview, not at the shop. */
function localConfig(source) {
  const origin = `http://localhost:${PORT}`;
  return source
    .replace(/export const API_URL = '[^']*';/, `export const API_URL = '${origin}/exec';`)
    .replace(/export const SITE_URL = '[^']*';/, `export const SITE_URL = '${origin}';`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  // Dev only: what the backend has "sent". Lets browser-check.mjs assert on
  // real emails — the sign-in link in particular, since the nonce only ever
  // exists in one. Nothing like this exists in the deployed Apps Script.
  if (url.pathname === '/dev/mail') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    return response.end(JSON.stringify(backend.sentMail));
  }

  if (url.pathname === '/exec') {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return response.end();
    }
    const body = await readBody(request);
    let out;
    try {
      backend.context.__event = { postData: { contents: body }, parameter: Object.fromEntries(url.searchParams) };
      out = backend.call('doPost(__event)').getContent();
    } catch (error) {
      out = JSON.stringify({ error: String(error.message || error) });
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    return response.end(out);
  }

  let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    return response.end('no');
  }
  try {
    let data = fs.readFileSync(filePath);
    // config.js carries the LIVE /exec URL once the shop is deployed. Serving
    // it unchanged would point this preview — and browser-check.mjs, which
    // creates jobs — at the real backend and the real Sheet. Pin it to ours.
    if (filePath === CONFIG_JS) data = localConfig(data.toString());
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    return response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    return response.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Quest Service Tracker preview on http://localhost:${PORT}`);
  console.log(`  portal password: ${PASSWORD}`);
  console.log('  backend: service-tracker.gs, in memory');
});
