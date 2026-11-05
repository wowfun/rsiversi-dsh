import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('.local/browser');
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:4319; worker-src 'self'; img-src 'self' blob:; font-src 'self'; frame-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + sep)) throw new Error('outside root');
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(4319, '127.0.0.1', () => console.log('DSH original UI fixture: http://127.0.0.1:4319/'));
