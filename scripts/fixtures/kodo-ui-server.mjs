import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a local port');
const html = await readFile(new URL('./kodo-ui-form.html', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ pid: process.pid, fixture: 'kodo-ui' })); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html);
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => server.close());
