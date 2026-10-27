import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatic, staticAssets } from './build-static.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');

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

export function prepareSoloRelease(out, previous, { freshSite = false } = {}) {
  out = resolve(out);
  // Never clean an existing build: it may contain the versions used by saved games.
  if (existsSync(out) && readdirSync(out).length) throw new Error('發布目錄必須為空；既有版本與存檔所需素材不會自動刪除');
  if (!previous && !freshSite) throw new Error('更新既有網站必須提供 --previous 上一發布目錄；全新網站請明確使用 --fresh');
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
  copyFileSync(join(root, 'LICENSE'), join(out, 'license.txt'));
  copyFileSync(join(root, 'data/SOURCES.md'), join(out, 'data-notes.txt'));
  const html = readFileSync(join(out, 'index.html'), 'utf8').replace('href="/LICENSE"', 'href="/license.txt"').replace('href="/data-notes"', 'href="/data-notes.html"').replace('</head>', '<meta name="robots" content="noindex,nofollow">\n</head>');
  writeFileSync(join(out, 'index.html'), html);
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
  const evidence = { schema: 1, version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, fingerprint: manifest.fingerprint, engineVersion: manifest.engineVersion,
    runtimeVersion: manifest.runtimeVersion, dataVersion: manifest.dataVersion, preserved, assets: assets.length,
    assetBytes: assets.reduce((n, asset) => n + asset.bytes, 0),
    sourceData: Object.fromEntries(['taiwan.json', 'basemap.json.gz', 'terrain.bin.gz'].map(f => [f, sha(readFileSync(join(root, 'data', f)))])) };
  writeFileSync(join(out, 'release.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}

