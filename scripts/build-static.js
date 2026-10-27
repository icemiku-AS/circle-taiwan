import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadCatalog } from '../server/catalog.js';
import { loadBasemap } from '../server/basemap.js';
import { terrainPixels } from '../public/basemap.js';
import { tileLevels } from '../public/clue-tiles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const staticAssets = m => [m.catalog, ...Object.values(m.answerPacks), m.clues.terrainAsset, m.clues.overviewTerrain, ...m.clues.chunks,
  ...tileLevels(m.clues.tiles).flatMap(l => l.tiles)].filter(Boolean);
export function buildStatic(out = join(root, 'dist'), { catalog, basemap, multiplayerUrl = null } = {}) {
  out = resolve(out); mkdirSync(out, { recursive: true });
  if (multiplayerUrl && !/^https?:$/.test(new URL(multiplayerUrl).protocol)) throw new Error('多人入口必須使用 HTTP／HTTPS');
  const engineVersion = sha(Buffer.concat(['shared/scoring.js', 'shared/rules.js', 'node_modules/polygon-clipping/dist/polygon-clipping.umd.min.js', 'node_modules/polyclip-ts/dist/polyclip-ts.umd.min.js'].map(f => readFileSync(join(root, f)))));
  const runtimeFiles = ['solo-worker.js', 'solo-assets.js', 'basemap.js', 'sha256.js', 'clue-tiles.js'];
  const runtimeVersion = sha(Buffer.concat(runtimeFiles.map(f => readFileSync(join(root, 'public', f))).concat(Buffer.from(engineVersion))));
  const sourceManifest = JSON.parse(readFileSync(join(root, 'data/manifest.json'), 'utf8'));
  const clueManifest = JSON.parse(readFileSync(join(root, 'data/basemap-manifest.json'), 'utf8'));
  const displayBytes = catalog || basemap ? Buffer.alloc(0) : readFileSync(join(root, 'data/display-tiles/manifest.json'));
  const display = displayBytes.length ? JSON.parse(displayBytes) : null;
  if (display && (display.inputs.vectorsSha256 !== clueManifest.vectorsSha256 || display.inputs.terrainFileSha256 !== clueManifest.terrainFileSha256)) throw new Error('顯示圖塊與正式線索版本不符，請重新產生');
  if (!catalog && sha(readFileSync(join(root, 'data/taiwan.json'))) !== sourceManifest.outputSha256) throw new Error('行政圖資雜湊不符');
  if (!basemap && (sha(readFileSync(join(root, 'data/terrain.bin.gz'))) !== clueManifest.terrainFileSha256 || sha(readFileSync(join(root, 'data/basemap.json.gz'))) !== clueManifest.vectorsSha256)) throw new Error('線索圖資雜湊不符');
  const landmarkBytes = readFileSync(join(root, 'data/landmarks.json'));
  const landmarkManifest = JSON.parse(readFileSync(join(root, 'data/landmarks-manifest.json')));
  if (sha(landmarkBytes) !== landmarkManifest.outputSha256) throw new Error('景點題庫雜湊不符');
  const fingerprint = sha(Buffer.concat(['data/manifest.json', 'data/landmarks-manifest.json', 'data/basemap-manifest.json', 'scripts/build-static.js', 'server/catalog.js'].map(f => readFileSync(join(root, f))).concat(landmarkBytes, displayBytes, Buffer.from(engineVersion + runtimeVersion))));
  const currentFile = join(out, 'assets', 'current.json');
  let manifest = existsSync(currentFile) ? JSON.parse(readFileSync(currentFile, 'utf8')) : null;
  if (catalog || basemap || manifest?.fingerprint !== fingerprint) {
    catalog ||= loadCatalog(); basemap ||= loadBasemap();
    const directory = `assets/${fingerprint}`, target = join(out, directory), blobs = join(out, 'assets', 'blobs'); mkdirSync(target, { recursive: true }); mkdirSync(blobs, { recursive: true });
    function compressed(name, bytes) {
      const payload = gzipSync(bytes), digest = sha(payload); writeFileSync(join(blobs, digest + '.bin'), payload);
      return { name, url: `/assets/blobs/${digest}.bin`, sha256: digest, bytes: payload.length, decodedBytes: bytes.length };
    }
    const pack = (name, value) => compressed(name, Buffer.from(JSON.stringify(value)));
    const publicData = catalog.publicData();
    publicData.regions = publicData.regions.map(r => ({ ...r, neutralNames: catalog.byId.get(r.id).neutralNames }));
    const groups = new Map(), regionPacks = {};
    for (const meta of publicData.regions) {
      const key = meta.level === 'landmark' ? 'landmark' : meta.level === 'village' ? `village-${meta.town}` : meta.level === 'town' ? `town-${meta.county}` : 'county';
      if (!groups.has(key)) groups.set(key, []);
      const r = catalog.byId.get(meta.id);
      groups.get(key).push(r.kind === 'landmark' ? { id: r.id, kind: 'landmark', point: r.point } : { id: r.id, geometry: r.geometry, neutral: r.neutral }); regionPacks[r.id] = key;
    }
    const answerPacks = Object.fromEntries([...groups].map(([key, values]) => [key, pack(`${key}.json.gz`, values)]));
    const vectorGroups = new Map();
    for (const f of basemap.features) {
      const detail = f.kind === 'water' ? Math.max(f.bounds[2] - f.bounds[0], f.bounds[3] - f.bounds[1]) >= 500 ? 0 : 1 : f.tier;
      const key = detail === 0 ? 'overview' : `${detail}-${Math.floor((f.bounds[0] + f.bounds[2]) / 80000)}-${Math.floor((f.bounds[1] + f.bounds[3]) / 80000)}`;
      if (!vectorGroups.has(key)) vectorGroups.set(key, { detail, bounds: [Infinity, Infinity, -Infinity, -Infinity], features: [] });
      const group = vectorGroups.get(key); group.features.push(f);
      for (let i = 0; i < 4; i++) group.bounds[i] = i < 2 ? Math.min(group.bounds[i], f.bounds[i]) : Math.max(group.bounds[i], f.bounds[i]);
    }
    const chunks = [...vectorGroups].map(([key, group]) => ({ ...pack(`clues-${key}.json.gz`, group.features), detail: group.detail, bounds: group.bounds }));
    // The original gzip is copied byte-for-byte; no resampling or geometry simplification.
    const terrainDigest = sha(basemap.terrain); writeFileSync(join(blobs, terrainDigest + '.bin'), basemap.terrain);
    let overviewTerrain;
    if (basemap.manifest.terrain) {
      const info = basemap.manifest.terrain, bytes = gunzipSync(basemap.terrain), heights = new Uint16Array(info.width * info.height);
      if (bytes.length !== heights.length * 2 || sha(bytes) !== basemap.manifest.terrainSha256) throw new Error('地形版本或資料大小不符');
      for (let i = 0; i < heights.length; i++) heights[i] = bytes.readUInt16LE(i * 2);
      const pixels = terrainPixels(heights, info.width, info.height, info.cell), width = Math.ceil(info.width / 4), height = Math.ceil(info.height / 4), overview = Buffer.alloc(width * height * 4);
      // Only the display overview is reduced; both canvases cover the original exact extent.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * info.width / width), x1 = Math.floor((x + 1) * info.width / width), y0 = Math.floor(y * info.height / height), y1 = Math.floor((y + 1) * info.height / height);
        let red = 0, green = 0, blue = 0, alpha = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
          const i = (sy * info.width + sx) * 4, a = pixels[i + 3];
          red += pixels[i] * a; green += pixels[i + 1] * a; blue += pixels[i + 2] * a; alpha += a;
        }
        const i = (y * width + x) * 4;
        if (alpha) { overview[i] = Math.round(red / alpha); overview[i + 1] = Math.round(green / alpha); overview[i + 2] = Math.round(blue / alpha); }
        overview[i + 3] = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
      }
      overviewTerrain = { ...compressed('terrain-overview.rgba.gz', overview), width, height };
    }
    const displayLevel = level => ({ ...level, tiles: level.tiles.map(tile => {
      if (!/^(terrain-)?\d+-[12]-\d+-\d+\.webp$/.test(tile.file)) throw new Error('顯示圖塊檔名不符');
      const bytes = readFileSync(join(root, 'data/display-tiles', tile.file));
      if (bytes.length !== tile.bytes || sha(bytes) !== tile.sha256) throw new Error('顯示圖塊雜湊不符：' + tile.file);
      copyFileSync(join(root, 'data/display-tiles', tile.file), join(blobs, tile.sha256 + '.bin'));
      const { file, ...meta } = tile; return { ...meta, name: file, url: `/assets/blobs/${tile.sha256}.bin` };
    }) });
    const tiles = display && { ...display, levels: display.levels.map(displayLevel), ...(display.terrain ? { terrain: { ...display.terrain, levels: display.terrain.levels.map(displayLevel) } } : {}) };
    manifest = { schema: 1, fingerprint, engineVersion, runtimeVersion, rulesVersion: publicData.rulesVersion, dataVersion: publicData.manifest.version,
      catalog: pack('catalog.json.gz', publicData), answerPacks, regionPacks,
      clues: { ...basemap.manifest, overviewTerrain, terrainAsset: { name: 'terrain.bin.gz', url: `/assets/blobs/${terrainDigest}.bin`, sha256: terrainDigest, bytes: basemap.terrain.length, decodedBytes: basemap.manifest.terrain ? basemap.manifest.terrain.width * basemap.manifest.terrain.height * 2 : 0 }, chunks, ...(tiles ? { tiles } : {}) } };
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(currentFile, JSON.stringify(manifest));
  }
  for (const file of readdirSync(join(root, 'public'))) if (/\.(js|html|css|svg|ico|png)$/.test(file)) copyFileSync(join(root, 'public', file), join(out, file));
  writeFileSync(join(out, '404.html'), '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>找不到頁面｜圈出台灣</title><link rel="stylesheet" href="/style.css"><main class="page-shell"><h1>找不到頁面</h1><a href="/">返回首頁</a></main></html>');
  mkdirSync(join(out, 'shared'), { recursive: true });
  for (const file of ['rules.js', 'scoring.js']) copyFileSync(join(root, 'shared', file), join(out, 'shared', file));
  mkdirSync(join(out, 'vendor'), { recursive: true });
  copyFileSync(join(root, 'node_modules/polygon-clipping/dist/polygon-clipping.umd.min.js'), join(out, 'vendor/polygon-clipping.umd.min.js'));
  copyFileSync(join(root, 'node_modules/polyclip-ts/dist/polyclip-ts.umd.min.js'), join(out, 'vendor/polyclip-ts.umd.min.js'));
  copyFileSync(join(root, 'node_modules/polyclip-ts/LICENSE'), join(out, 'vendor/polyclip-ts-LICENSE.txt'));
  copyFileSync(join(root, 'node_modules/bignumber.js/LICENCE.md'), join(out, 'vendor/bignumber-LICENSE.md'));
  copyFileSync(join(root, 'node_modules/splaytree-ts/LICENSE'), join(out, 'vendor/splaytree-ts-LICENSE.txt'));
  copyFileSync(join(root, 'node_modules/polygon-clipping/LICENSE.md'), join(out, 'vendor/polygon-clipping-LICENSE.md'));
  copyFileSync(join(root, 'node_modules/robust-predicates/LICENSE'), join(out, 'vendor/robust-predicates-LICENSE.txt'));
  const splaytreeReadme = readFileSync(join(root, 'node_modules/splaytree/Readme.md'), 'utf8');
  writeFileSync(join(out, 'vendor/splaytree-LICENSE.txt'), splaytreeReadme.slice(splaytreeReadme.lastIndexOf('## License')));
  const runtime = join(out, 'runtime', runtimeVersion); mkdirSync(join(runtime, 'shared'), { recursive: true }); mkdirSync(join(runtime, 'vendor'), { recursive: true });
  for (const file of runtimeFiles) copyFileSync(join(root, 'public', file), join(runtime, file));
  for (const file of ['rules.js', 'scoring.js']) copyFileSync(join(root, 'shared', file), join(runtime, 'shared', file));
  for (const file of readdirSync(join(out, 'vendor'))) copyFileSync(join(out, 'vendor', file), join(runtime, 'vendor', file));
  copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE')); copyFileSync(join(root, 'LICENSE'), join(out, 'license.txt'));
  writeFileSync(join(out, 'data-notes.html'), `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only light"><meta name="robots" content="noindex,nofollow"><title>資料來源與授權｜圈出台灣</title><link rel="stylesheet" href="/style.css"></head><body><main class="page-shell data-notes"><a href="/">返回首頁</a><h1>資料來源與授權</h1>
<ul><li>景點：交通部觀光署 <a href="https://data.gov.tw/dataset/7777">觀光資訊資料庫</a>（2026-10-26 快照）。</li><li>行政邊界：<a href="https://maps.nlsc.gov.tw/pro/download.jsp">內政部國土測繪中心</a>；地形：內政部 <a href="https://data.gov.tw/dataset/176927">2025 年版數值地形模型</a>。上述政府資料依<a href="https://data.gov.tw/license">政府資料開放授權條款第 1 版</a>提供。</li><li>道路與河川：© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>／<a href="https://download.geofabrik.de/asia/taiwan.html">Geofabrik</a>（2026-10-17 快照），依 <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a> 使用。</li><li>遊戲程式：<a href="https://github.com/icemiku-AS/circle-taiwan">GitHub 原始碼</a>，採 <a href="/license.txt">AGPL 3.0</a>。</li><li>靈感來自 <a href="https://kskdazegames.com/games/kenkyo" target="_blank" rel="noreferrer">KSKだぜGAMES《県境王》</a>，感謝原作。</li></ul>
</main></body></html>`);
  writeFileSync(join(out, 'environment.json'), JSON.stringify({ multiplayer: multiplayerUrl ? 'available' : 'coming', url: multiplayerUrl }));
  const revalidate = ['/', '/environment.json', '/assets/current.json', '/shared/rules.js', '/shared/scoring.js', ...readdirSync(join(root, 'public')).filter(f => /\.(js|html|css|svg|ico|png)$/.test(f)).map(f => '/' + f)];
  writeFileSync(join(out, '_headers'), '/assets/*/*\n  Cache-Control: public, max-age=31536000, immutable\n/runtime/*/*\n  Cache-Control: public, max-age=31536000, immutable\n' + revalidate.map(path => `${path}\n  Cache-Control: no-cache\n`).join('') + '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src \'self\'; connect-src \'self\'; img-src \'self\' data: blob: https://hits.sh; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = buildStatic(undefined, { multiplayerUrl: process.env.MULTIPLAYER_URL || null });
  console.log(`單人靜態檔已建立：dist/，圖資 ${manifest.dataVersion}，${Object.keys(manifest.answerPacks).length} 個答案分包。`);
}
