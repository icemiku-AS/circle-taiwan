import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export async function serveStatic(req, res, root = resolve('dist')) {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return true; }
  if (path.startsWith('/api/')) return false;
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return true; }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path === '/data-notes' ? '/data-notes.html' : path}`);
  if (!file.startsWith(root + sep) || path.split('/').some(p => p.startsWith('.'))) { res.writeHead(403); res.end(); return true; }
  try {
    const body = await readFile(file), tag = `W/"${createHash('sha256').update(body).digest('hex')}"`;
    res.setHeader('Cache-Control', (path.startsWith('/assets/') && path !== '/assets/current.json') || path.startsWith('/runtime/') ? 'public, max-age=31536000, immutable' : 'public, no-cache'); res.setHeader('ETag', tag);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.gz': 'application/octet-stream', '.bin': 'application/octet-stream' })[extname(file)] || 'text/plain';
    res.setHeader('Content-Type', type + (type.startsWith('text/') ? '; charset=utf-8' : ''));
    if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return true; }
    if (!['.gz', '.bin'].includes(extname(file)) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(body)); }
    else res.end(body);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code === 'ENOENT' ? '找不到頁面' : '載入失敗，請重試'); }
  return true;
}
export async function startStatic({ port = Number(process.env.PORT || 4175), host = '127.0.0.1', root = resolve('dist') } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob: https://hits.sh; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (await serveStatic(req, res, root) === false) { res.writeHead(404); res.end('單人靜態服務不提供遊戲 API'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startStatic(); console.log(`瀏覽器單人：http://127.0.0.1:${server.address().port}/`);
}
