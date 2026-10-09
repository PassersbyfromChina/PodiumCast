#!/usr/bin/env node
/**
 * Serves the repository the way GitHub Pages does, so index.html can be checked locally:
 *
 *   npm run serve:pages          → http://127.0.0.1:8788/
 *
 * It also serves the built web bundles under /web/{cast,stage}/, which is handy for opening a
 * Stage in a plain browser against a running Cast (manual address mode).
 */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OUT_DIR, ROOT } from './lib/build-common.mjs';

const PORT = Number(process.env.PORT ?? 8788);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  // `/web/<role>/...` is served from the build output rather than the repository root.
  const base = rel.startsWith('/web/') ? OUT_DIR : ROOT;
  const file = path.join(base, rel.startsWith('/web/') ? rel.replace(/^\/web\//, 'web/') : rel.replace(/^\//, ''));

  if (!file.startsWith(base)) { res.writeHead(403).end('forbidden'); return }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PodiumCast Pages preview: http://127.0.0.1:${PORT}/`);
  console.log(`web bundles (after \`npm run build:web\`): http://127.0.0.1:${PORT}/web/cast/ and /web/stage/`);
});
