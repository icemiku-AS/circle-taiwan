import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildStatic, staticAssets } from './build-static.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');

// Large data and display tiles are served separately to fit the static file size limit.
export const SOLO_SOURCE_FILES = [...['app.js', 'basemap.js', 'clue-tiles.js', 'draft.js', 'index.html', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'map.js', 'sha256.js', 'share.js',
  'solo-assets.js', 'solo-engine.js', 'solo-game.js', 'solo-worker.js', 'multi-client.js', 'style.css'].map(file => 'public/' + file),
  'shared/rules.js', 'shared/scoring.js', 'server/catalog.js', 'server/basemap.js', 'server/static.js',
  'scripts/build-static.js', 'scripts/prepare-solo-release.js', 'scripts/prepare-data.js', 'scripts/prepare-basemap.js', 'scripts/mainland-mask.js',
  'package.json', 'package-lock.json', '.gitignore', 'README.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/pull_request_template.md', 'LICENSE', 'data/SOURCES.md', 'data/manifest.json', 'data/basemap-manifest.json', 'data/coast-manifest.json', 'data/coast-source.zip', 'data/nearshore-manifest.json',
  'data/display-tiles/manifest.json'];

export function preservePublishedAssets(previous, out) {
  previous = resolve(previous); out = resolve(out);
  assert.notEqual(previous, out, '上一發布包與新發布包必須分開');
  const current = JSON.parse(readFileSync(join(previous, 'assets/current.json'), 'utf8'));
  const manifests = readdirSync(join(previous, 'assets'), { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-f0-9]{64}$/.test(f.name));
  assert.ok(manifests.some(f => f.name === current.fingerprint), '上一發布包缺少目前版本的 manifest');
  for (const entry of manifests) {
    const manifest = JSON.parse(readFileSync(join(previous, 'assets', entry.name, 'manifest.json'), 'utf8'));
    assert.equal(manifest.fingerprint, entry.name);
    if (entry.name === current.fingerprint) assert.deepEqual(manifest, current, '上一發布包的版本索引不一致');
    assert.match(manifest.runtimeVersion, /^[a-f0-9]{64}$/);
    for (const file of ['solo-worker.js', 'solo-assets.js', 'basemap.js', 'sha256.js', 'shared/scoring.js', 'shared/rules.js', 'vendor/polygon-clipping.umd.min.js']) {
      assert.ok(lstatSync(join(previous, 'runtime', manifest.runtimeVersion, file)).isFile(), `上一發布包缺少 Worker 檔案：${file}`);
    }
    if (manifest.clues.tiles) assert.ok(lstatSync(join(previous, 'runtime', manifest.runtimeVersion, 'clue-tiles.js')).isFile(), '上一發布包缺少圖塊模組');
    for (const asset of staticAssets(manifest)) {
      assert.match(asset.url, /^\/assets\/blobs\/[a-f0-9]{64}\.bin$/);
      const bytes = readFileSync(join(previous, asset.url));
      assert.equal(bytes.length, asset.bytes, asset.url); assert.equal(sha(bytes), asset.sha256, asset.url);
    }
  }
  let files = 0;
  for (const directory of ['assets', 'runtime']) for (const entry of readdirSync(join(previous, directory), { recursive: true, withFileTypes: true })) {
    assert.ok(entry.isDirectory() || entry.isFile(), '舊版素材不可包含符號連結');
    if (!entry.isFile()) continue;
    const file = relative(previous, join(entry.parentPath, entry.name));
    if (file.replaceAll('\\', '/') === 'assets/current.json') continue;
    const bytes = readFileSync(join(previous, file)), destination = join(out, file);
    if (existsSync(destination)) assert.ok(bytes.equals(readFileSync(destination)), `不可改寫已發布素材：${file}`);
    else { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(previous, file), destination); }
    files++;
  }
  return { versions: manifests.map(f => f.name), files };
}

export function prepareSoloRelease(out, previous, sourceFiles = SOLO_SOURCE_FILES, { freshSite = false } = {}) {
  out = resolve(out);
  // Never clean an existing build: it may contain the versions used by saved games.
  if (existsSync(out) && readdirSync(out).length) throw new Error('發布目錄必須為空；既有版本與存檔所需素材不會自動刪除');
  if (!previous && !freshSite) throw new Error('更新既有網站必須提供 --previous 上一發布目錄；全新網站請明確使用 --fresh');
  for (const file of sourceFiles) assert.ok(lstatSync(join(root, file)).isFile(), `原始碼必須為一般檔案：${file}`);
  for (const file of readdirSync(join(root, 'public'))) if (/\.(js|html|css|svg|ico|png)$/.test(file)) assert.ok(SOLO_SOURCE_FILES.includes('public/' + file), `前端包含未列入發布的檔案：${file}`);
  const coastBytes = readFileSync(join(root, 'data/coast-manifest.json')), coast = JSON.parse(coastBytes);
  const geography = JSON.parse(readFileSync(join(root, 'data/manifest.json')));
  assert.equal(sha(readFileSync(join(root, 'data/coast-source.zip'))), coast.inputSha256, '海洋原始資料與來源紀錄不符');
  assert.equal(geography.coast.manifestSha256, sha(coastBytes), '答案未使用目前這份海岸來源紀錄');
  assert.equal(geography.coast.inputSha256, coast.inputSha256, '答案與海洋原始資料版本不符');
  const nearshoreBytes = readFileSync(join(root, 'data/nearshore-manifest.json')), nearshore = JSON.parse(nearshoreBytes);
  assert.equal(geography.nearshore.manifestSha256, sha(nearshoreBytes), '答案未使用目前這份近岸核准清單');
  assert.equal(nearshore.coastSourceSha256, coast.inputSha256, '近岸清單與海洋原始資料不符');
  assert.equal(nearshore.coastManifestSha256, sha(coastBytes), '近岸清單與海岸來源紀錄不符');
  assert.deepEqual(nearshore.administrativeSources, geography.sources.map(({ level, sha256 }) => ({ level, sha256 })), '近岸清單與行政來源不符');
  const manifest = buildStatic(out);
  const preserved = previous ? preservePublishedAssets(previous, out) : null;
  execFileSync('tar', ['-czf', join(out, 'source-code.tar.gz'), ...sourceFiles], { cwd: root });
  const entries = execFileSync('tar', ['-tzf', join(out, 'source-code.tar.gz')], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.ok(entries.every(name => !name.startsWith('/') && !name.split('/').includes('..') && !/(^|\/)\.(git|env)(\/|$|\.)/.test(name)));
  assert.deepEqual([...entries].sort(), [...sourceFiles].sort(), '原始碼包必須完全符合建置檔案清單');
  mkdirSync(join(out, 'source-data'));
  // .bin prevents hosts from treating our original gzip bytes as HTTP Content-Encoding.
  writeFileSync(join(out, 'source-data/taiwan.json.gz.bin'), gzipSync(readFileSync(join(root, 'data/taiwan.json'))));
  for (const file of ['basemap.json.gz', 'terrain.bin.gz']) copyFileSync(join(root, 'data', file), join(out, 'source-data', file + '.bin'));
  writeFileSync(join(out, 'source-build.txt'), `# 原始碼與圖資重建

公開專案：https://github.com/icemiku-AS/circle-taiwan
本次部署的對應原始碼：/source-code.tar.gz
授權：/license.txt 與 /data-notes.txt

GitHub 完整下載已含圖資。
若使用網站的 source-code.tar.gz，先以 tar -xzf source-code.tar.gz 解到空目錄。
將下列 JavaScript 存為 restore-data.mjs，置於解開後的根目錄：

\`\`\`js
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const base = new URL(process.argv[2]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const geography = JSON.parse(await readFile('data/manifest.json', 'utf8'));
const basemap = JSON.parse(await readFile('data/basemap-manifest.json', 'utf8'));
const display = JSON.parse(await readFile('data/display-tiles/manifest.json', 'utf8'));
const inputs = [
  ['taiwan.json', 'source-data/taiwan.json.gz.bin', geography.outputSha256, true],
  ['basemap.json.gz', 'source-data/basemap.json.gz.bin', basemap.vectorsSha256],
  ['terrain.bin.gz', 'source-data/terrain.bin.gz.bin', basemap.terrainFileSha256]
];
for (const tile of [...display.levels, ...(display.terrain?.levels || [])].flatMap(level => level.tiles)) {
  assert.match(tile.file, /^(terrain-)?[0-9]+-[12]-[0-9]+-[0-9]+\\.webp$/);
  assert.match(tile.sha256, /^[a-f0-9]{64}$/);
  inputs.push(['display-tiles/' + tile.file, 'assets/blobs/' + tile.sha256 + '.bin', tile.sha256]);
}
for (const [file, url, hash, compressed] of inputs) {
  const response = await fetch(new URL(url, base));
  assert.ok(response.ok, '下載失敗：' + file);
  const body = Buffer.from(await response.arrayBuffer());
  const bytes = compressed ? gunzipSync(body) : body;
  assert.equal(sha(bytes), hash, '雜湊不符：' + file);
  await writeFile('data/' + file, bytes);
}
console.log('圖資還原完成');
\`\`\`

執行 node restore-data.mjs https://提供此來源包的網站/，逐檔核對雜湊後還原。
接著執行 npm install、npm start。
正式計分使用原始向量；顯示圖塊僅用於地形、道路與水系。
`);
  copyFileSync(join(root, 'LICENSE'), join(out, 'license.txt'));
  copyFileSync(join(root, 'data/SOURCES.md'), join(out, 'data-notes.txt'));
  const html = readFileSync(join(out, 'index.html'), 'utf8').replace('href="/LICENSE"', 'href="/license.txt"').replace('href="/data-notes"', 'href="/data-notes.html"').replace('</head>', '<meta name="robots" content="noindex,nofollow">\n</head>');
  writeFileSync(join(out, 'index.html'), html);
  const notes = readFileSync(join(root, 'data/SOURCES.md'), 'utf8').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  writeFileSync(join(out, 'data-notes.html'), `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only light"><meta name="robots" content="noindex,nofollow"><title>圖資與限制｜圈出台灣</title><link rel="stylesheet" href="/style.css"></head><body><main class="page-shell data-notes"><a href="/">返回首頁</a><h1>圖資與限制</h1><p><a href="/source-code.tar.gz">遊戲程式原始碼</a> · <a href="/source-build.txt">原始資料與重建方式</a></p><pre>${notes}</pre></main></body></html>`);
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  const assets = staticAssets(manifest);
  for (const asset of assets) {
    assert.match(asset.url, /^\/assets\/blobs\/[a-f0-9]{64}\.bin$/);
    assert.equal(sha(readFileSync(join(out, asset.url))), asset.sha256, asset.name);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'environment.json'))), { multiplayer: 'coming', url: null });
  assert.ok(existsSync(join(out, 'runtime', manifest.runtimeVersion, 'solo-worker.js')));
  const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter(f => f.isFile());
  assert.ok(files.every(f => !['.git', '.cache', 'node_modules', 'server', 'prototype'].some(name => f.parentPath.split(/[\\/]/).slice(out.split(/[\\/]/).length).includes(name))));
  assert.ok(files.every(f => !/\.(cmd|ps1|patch)$/.test(f.name)), '發布包不可包含舊啟動器或還原補丁');
  const evidence = { schema: 1, fingerprint: manifest.fingerprint, engineVersion: manifest.engineVersion,
    runtimeVersion: manifest.runtimeVersion, dataVersion: manifest.dataVersion, preserved, assets: assets.length,
    assetBytes: assets.reduce((n, asset) => n + asset.bytes, 0),
    sourceArchiveSha256: sha(readFileSync(join(out, 'source-code.tar.gz'))),
    sourceData: Object.fromEntries(['taiwan.json', 'basemap.json.gz', 'terrain.bin.gz'].map(f => [f, sha(readFileSync(join(root, 'data', f)))])) };
  writeFileSync(join(out, 'release.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

