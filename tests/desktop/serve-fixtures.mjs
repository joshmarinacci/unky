import { createServer } from 'node:http';
import { appendFileSync, createReadStream } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, 'fixtures');
const logPath = process.env.DESKTOP_TEST_NETWORK_LOG;
const serverToken = process.env.DESKTOP_TEST_SERVER_TOKEN ?? '';

function log(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  log({ type: 'request', method: request.method, path: pathname });
  if (pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ token: serverToken }));
    return;
  }
  if (pathname === '/download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="popover-test.txt"' });
    response.end('Native downloads popover fixture.');
    return;
  }
  if (pathname === '/api/status') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, fixture: 'desktop-testing' }));
    return;
  }
  const file = pathname === '/privacy' ? 'privacy.html' : pathname === '/two' ? 'two.html' : pathname === '/slow' ? 'slow.html' : 'one.html';
  const delay = pathname === '/slow' ? 300 : 0;
  const contentType = extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  setTimeout(() => createReadStream(resolve(fixtureDir, file)).pipe(response), delay);
});

server.listen(4179, '127.0.0.1', () => log({ type: 'server-ready', port: 4179 }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
