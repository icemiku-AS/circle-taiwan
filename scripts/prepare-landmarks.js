import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';
import proj4 from 'proj4';
import { area, locatePointInGeometry } from '../shared/scoring.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const datasetUrl = 'https://data.gov.tw/dataset/7777', licenseUrl = 'https://data.gov.tw/license';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function readTourismRecords(payload) {
  assert.ok(object(payload) && Array.isArray(payload.Attractions) && payload.Attractions.length,
    '觀光來源必須包含非空的 Attractions 陣列（AttractionList.json）');
  return payload.Attractions;
}

export function decodeTourismSource(bytes, zipped = false) {
  assert.ok(bytes.length > 0 && bytes.length <= MAX_SOURCE_BYTES, '觀光來源檔案須介於 1 byte 與 64 MiB');
  if (zipped) {
    const files = unzipSync(bytes, { filter: entry => {
      if (entry.name !== 'AttractionList.json') return false;
      assert.ok(entry.originalSize <= MAX_SOURCE_BYTES, 'AttractionList.json 解壓後超過 64 MiB');
      return true;
    } });
    bytes = files['AttractionList.json'];
    assert.ok(bytes && bytes.length <= MAX_SOURCE_BYTES, 'ZIP 缺少有效的 AttractionList.json');
  }
  return readTourismRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export function prepareLandmarks(records, selection, sourceInfo, { projection, bounds, counties }, version) {
  assert.ok(Array.isArray(records), '觀光紀錄格式錯誤');
  assert.ok(Array.isArray(selection) && selection.length > 0 && selection.length <= 1000, '選題清單須有 1～1000 題');
  assert.match(version, /^landmarks-\d{4}-\d{2}-\d{2}-\d{2,}$/);
  assert.ok(date(version.slice(10, 20)), '題庫版本日期無效');
  assert.ok(object(sourceInfo) && /^[a-f0-9]{64}$/.test(sourceInfo.sourceSha256), '來源 SHA-256 無效');
  assert.ok(typeof sourceInfo.retrievedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(sourceInfo.retrievedAt) &&
    date(sourceInfo.retrievedAt.slice(0, 10)) && Number.isFinite(Date.parse(sourceInfo.retrievedAt)), '來源取得時間須為含時區的 ISO 日期');
  assert.ok(typeof sourceInfo.sourceUrl === 'string' && /^https?:$/.test(new URL(sourceInfo.sourceUrl).protocol), '來源網址須為 HTTP(S)');
  assert.ok(text(projection) && Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
    bounds[0] < bounds[2] && bounds[1] < bounds[3] && Array.isArray(counties), '行政圖資範圍或投影無效');
  const ids = new Set(), sourceIds = new Set();
  for (const item of selection) {
    assert.ok(object(item) && typeof item.id === 'string' && /^lm-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && item.id.length <= 40, '景點 ID 無效');
    assert.ok(!ids.has(item.id), `景點 ID 重複：${item.id}`); ids.add(item.id);
    assert.ok(text(item.recordId) && !sourceIds.has(item.recordId), `來源 ID 缺少或重複：${item.id}`); sourceIds.add(item.recordId);
    assert.ok(text(item.name) && item.name.trim().length <= 80 && text(item.anchorLabel) && item.anchorLabel.trim().length <= 80, `題名或定位對象無效：${item.id}`);
    assert.ok(typeof item.county === 'string' && /^\d{5}$/.test(item.county) && counties.includes(item.county), `縣市不存在於遊戲範圍：${item.id}`);
    assert.ok(date(item.reviewedAt), `缺少有效審查日期：${item.id}`);
  }
  const byId = new Map();
  for (const record of records) if (object(record) && sourceIds.has(record.AttractionID)) {
    assert.ok(!byId.has(record.AttractionID), `觀光來源紀錄重複：${record.AttractionID}`);
    byId.set(record.AttractionID, record);
  }
  const transform = proj4('EPSG:4326', projection);
  const landmarks = selection.map(item => {
    const record = byId.get(item.recordId);
    assert.ok(record, `觀光來源缺題：${item.recordId}`);
    assert.ok(text(record.AttractionName), `觀光來源名稱無效：${item.recordId}`);
    const lon = record.PositionLon, lat = record.PositionLat;
    assert.ok(Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90,
      `經緯度須為有效數值：${item.recordId}`);
    if (record.UpdateTime !== undefined) assert.ok(text(record.UpdateTime), `來源更新時間無效：${item.recordId}`);
    if (record.PostalAddress?.CityCode) assert.equal(record.PostalAddress.CityCode, item.county, `來源縣市與選題不符：${item.id}`);
    const point = transform.forward([lon, lat]);
    assert.ok(point.every(Number.isFinite) && point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3],
      `景點超出遊戲圖資範圍：${item.id}`);
    return { id: item.id, name: item.name.trim(), county: item.county, anchorLabel: item.anchorLabel.trim(), wgs84: [lon, lat], point,
      source: { datasetUrl, recordId: item.recordId, licenseUrl, retrievedAt: sourceInfo.retrievedAt, snapshotSha256: sourceInfo.sourceSha256,
        ...(record.UpdateTime === undefined ? {} : { updatedAt: record.UpdateTime }) }, reviewedAt: item.reviewedAt };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Bounds only screen coordinates; the reviewed selection decides island/water coverage and the intended anchor.
  return { schemaVersion: 1, version, crs: 'EPSG:3826', projection, landmarks };
}

export function prepareLandmarkPools(records, selection, sourceInfo, administrative, version) {
  const counties = administrative.regions.filter(r => r.level === 'county');
  const context = { projection: administrative.manifest.projection, bounds: administrative.bounds, counties: counties.map(r => r.id) };
  const curated = prepareLandmarks(records, selection, sourceInfo, context, version);
  assert.equal(curated.landmarks.length, 100, '全島經典選題必須保留 100 題');
  assert.ok(Array.isArray(administrative.land) && administrative.land.length, '缺少本島幾何');
  const mainland = [administrative.land.reduce((largest, polygon) => area([polygon]) > area([largest]) ? polygon : largest)];
  const countyById = new Map(counties.map(r => [r.id, r])), curatedBySource = new Map(curated.landmarks.map(r => [r.source.recordId, r]));
  const transform = proj4('EPSG:4326', context.projection), bounds = context.bounds, ids = new Set(), sourceIds = new Set(), landmarks = [];
  const excludedCounts = { nonMainlandCounty: 0, invalidRequiredFields: 0, outsideBounds: 0, outsideMainland: 0, outsideDeclaredCounty: 0 };
  for (const record of records) {
    if (text(record?.AttractionID)) {
      assert.ok(!sourceIds.has(record.AttractionID), `觀光來源紀錄重複：${record.AttractionID}`); sourceIds.add(record.AttractionID);
    }
    const county = countyById.get(record?.PostalAddress?.CityCode);
    if (!county) { excludedCounts.nonMainlandCounty++; continue; }
    const lon = record.PositionLon, lat = record.PositionLat, old = curatedBySource.get(record.AttractionID);
    const id = old?.id || (text(record.AttractionID) ? 'lm-' + record.AttractionID.replace(/^Attraction_/, '').toLowerCase().replaceAll('_', '-') : '');
    if (!/^lm-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 40 || !text(record.AttractionName) || record.AttractionName.trim().length > 80 ||
      !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (record.UpdateTime !== undefined && !text(record.UpdateTime))) {
      excludedCounts.invalidRequiredFields++; continue;
    }
    const point = transform.forward([lon, lat]);
    if (!point.every(Number.isFinite) || point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3]) { excludedCounts.outsideBounds++; continue; }
    if (locatePointInGeometry(point, mainland).relation === 'outside') { excludedCounts.outsideMainland++; continue; }
    if (locatePointInGeometry(point, county.geometry).relation === 'outside') { excludedCounts.outsideDeclaredCounty++; continue; }
    assert.ok(!ids.has(id), `景點 ID 重複：${id}`); ids.add(id);
    landmarks.push({ ...(old || { id, name: record.AttractionName.trim(), county: county.id, anchorLabel: '官方登錄代表點', wgs84: [lon, lat], point,
      source: { datasetUrl, recordId: record.AttractionID, licenseUrl, retrievedAt: sourceInfo.retrievedAt, snapshotSha256: sourceInfo.sourceSha256,
        ...(record.UpdateTime === undefined ? {} : { updatedAt: record.UpdateTime }) } }),
    officialName: record.AttractionName.trim(), classicMainland: Boolean(old), classicCounty: Boolean(old) });
  }
  for (const item of curated.landmarks) assert.ok(ids.has(item.id), `經典景點未通過本島／所屬縣市檢查：${item.id}`);
  const countyCounts = {};
  for (const county of counties) {
    const items = landmarks.filter(r => r.county === county.id).sort((a, b) => a.source.recordId < b.source.recordId ? -1 : a.source.recordId > b.source.recordId ? 1 : 0);
    const chosen = items.filter(r => r.classicMainland), names = new Set(chosen.map(r => r.officialName));
    assert.ok(chosen.length <= 20, `縣市原經典題超過 20 題：${county.id}`);
    for (const item of items) {
      if (chosen.length === 20) break;
      if (item.classicCounty || names.has(item.officialName)) continue;
      item.classicCounty = true; chosen.push(item); names.add(item.officialName);
    }
    assert.equal(chosen.length, 20, `縣市不足 20 個不同名稱的有效景點：${county.id}`);
    countyCounts[county.id] = { all: items.length, classic: chosen.length };
  }
  landmarks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert.ok(landmarks.length <= 10000, '全量景點超過 10000 筆');
  return { catalog: { ...curated, schemaVersion: 2, landmarks }, summary: { sourceCount: records.length, excludedCounts,
    poolCounts: { all: landmarks.length, classicMainland: 100, classicCounty: counties.length * 20 }, countyCounts } };
}

export async function writeLandmarks(catalog, manifest, output) {
  const content = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
  assert.equal(manifest.outputSha256, sha(content), '題庫產物雜湊不符');
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  // Fresh staging directories preserve published versions and leave interrupted builds inspectable.
  await mkdir(output);
  await writeFile(join(output, 'landmarks.json.tmp'), content, { flag: 'wx' });
  await writeFile(join(output, 'landmarks-manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await rename(join(output, 'landmarks.json.tmp'), join(output, 'landmarks.json'));
  await rename(join(output, 'landmarks-manifest.json.tmp'), join(output, 'landmarks-manifest.json'));
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, selection: { type: 'string' }, 'source-info': { type: 'string' },
    version: { type: 'string' }, output: { type: 'string' }
  } });
  assert.ok(values.source && values.selection && values['source-info'] && values.version,
    '用法：npm run data:landmarks -- --source <ZIP或JSON> --selection <選題JSON> --source-info <來源JSON> --version landmarks-YYYY-MM-DD-NN [--output <全新目錄>]');
  assert.ok(/\.(zip|json)$/i.test(values.source), '來源須為 ZIP 或 JSON');
  assert.ok((await stat(values.source)).size <= MAX_SOURCE_BYTES, '觀光來源檔案超過 64 MiB');
  const [source, selectionBytes, sourceInfoBytes, administrativeBytes, administrativeManifestBytes] = await Promise.all([
    readFile(values.source), readFile(values.selection), readFile(values['source-info']),
    readFile(join(root, 'data/taiwan.json')), readFile(join(root, 'data/manifest.json'))
  ]);
  const sourceInfo = JSON.parse(sourceInfoBytes), administrativeManifest = JSON.parse(administrativeManifestBytes);
  assert.equal(sha(source), sourceInfo.sourceSha256, '來源快照 SHA-256 不符');
  assert.equal(sha(administrativeBytes), administrativeManifest.outputSha256, '行政圖資 SHA-256 不符');
  const administrative = JSON.parse(administrativeBytes);
  assert.equal(administrativeManifest.crs, 'EPSG:3826');
  assert.equal(administrative.manifest.projection, administrativeManifest.projection, '行政圖資投影不符');
  const { catalog, summary } = prepareLandmarkPools(decodeTourismSource(source, /\.zip$/i.test(values.source)), JSON.parse(selectionBytes), sourceInfo, administrative, values.version);
  const manifest = { schemaVersion: 2, version: catalog.version, count: catalog.landmarks.length, crs: catalog.crs,
    sourceUrl: sourceInfo.sourceUrl, retrievedAt: sourceInfo.retrievedAt, sourceSha256: sha(source), selectionSha256: sha(selectionBytes),
    projectionSha256: sha(catalog.projection), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    outputSha256: sha(JSON.stringify(catalog, null, 2) + '\n'), licenseUrl, ...summary };
  const output = values.output || join(root, '.cache/landmarks', catalog.version);
  await writeLandmarks(catalog, manifest, output);
  console.log(JSON.stringify({ output: resolve(output), count: manifest.count, outputSha256: manifest.outputSha256 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
