import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { serveStatic } from '../server/static.js';
import { buildFreeLocal } from './build-cloudflare.js';

export async function startLocal({ port = 4176, build: prepared } = {}) {
  const output = prepared || await buildFreeLocal();
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR),
    workers: ['local-a', 'local-b'].map(name => ({ name, scriptPath: join(output.root, 'server.js'), modules: true,
      compatibilityDate: '2026-05-15', d1Databases: { DB: 'local-rooms' } })) });
  let server;
  try {
    const db = await mf.getD1Database('DB', 'local-a');
    const schema = await readFile(output.schema || new URL('../server/free-schema.sql', import.meta.url), 'utf8');
    await db.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    const workers = await Promise.all(['local-a', 'local-b'].map(name => mf.getWorker(name)));
    let requestNumber = 0;
    server = http.createServer(async (req, res) => {
      try {
        if (req.headers.host !== `127.0.0.1:${server.address().port}` && req.headers.host !== `localhost:${server.address().port}`) { res.writeHead(403); res.end(); return; }
        res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob: https://hits.sh; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        if (await serveStatic(req, res, output.client)) return;
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
        const response = await workers[requestNumber++ % workers.length].fetch(`http://${req.headers.host}${req.url}`, {
          method: req.method, headers: req.headers, ...(size ? { body: Buffer.concat(chunks) } : {})
        });
        for (const [key, value] of response.headers) res.setHeader(key, value);
        res.writeHead(response.status); res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, mf, db, async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mf.dispose();
    } };
  } catch (error) { server?.close(); await mf.dispose(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startLocal();
  console.log(`Cloudflare Free 多人本機整合：${app.url}\n兩個本機 Workers 共用暫存 D1；全部圖資與計分在瀏覽器。停止後不續玩，不會部署。`);
  process.once('SIGINT', async () => { await app.close(); process.exit(0); });
}
