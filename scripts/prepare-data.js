import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import shapefile from 'shapefile';
import proj4 from 'proj4';
import clipping from 'polygon-clipping';
import { area } from '../shared/scoring.js';
import { loadOcean, mainlandMask } from './mainland-mask.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const projection = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const transform = proj4('EPSG:4326', projection);
const sources = [
  { level: 'county', dataset: 7442, url: 'https://www.tgos.tw/tgos/VirtualDir/Product/1cd4f4c9-6b01-4cf9-bf6c-23a73aa17d24/直轄市、縣(市)界線1140318.zip' },
  { level: 'town', dataset: 7441, url: 'https://www.tgos.tw/tgos/VirtualDir/Product/3fe61d4a-ca23-4f45-8aca-4a536f40f290/鄉(鎮、市、區)界線1140318.zip' },
  { level: 'village', dataset: 7438, url: 'https://www.tgos.tw/tgos/VirtualDir/Product/a04697c8-64db-450a-a105-3eb471c45abd/村(里)界(TWD97經緯度).zip' }
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const projectPoint = p => transform.forward(p).map(n => Math.round(n * 100) / 100);
const project = ring => ring.map(projectPoint);
const geometries = g => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly.map(project));
export function boundsOf(geometry) {
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of geometry) for (const ring of polygon) for (const p of ring) {
    box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])];
  }
  return box;
}

async function load(source) {
  const cache = `${root}.cache/maps/${source.level}.zip`;
  let bytes;
  try { bytes = await readFile(cache); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`下載官方 ${source.level} 圖資…`);
    const response = await fetch(source.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`圖資下載失敗：HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(cache, bytes);
  }
  const files = unzipSync(bytes, { filter: f => /\.(shp|dbf|prj|cpg)$/i.test(f.name) });
  const names = Object.keys(files).filter(n => /\.shp$/i.test(n));
  if (!names.length) throw new Error('壓縮檔缺少 SHP');
  const byId = new Map(), parts = [];
  for (const name of names) {
    const base = name.slice(0, -4);
    const get = extension => files[Object.keys(files).find(n => n.toLowerCase() === `${base}.${extension}`.toLowerCase())];
    const prj = new TextDecoder().decode(get('prj'));
    if (!prj.startsWith('GEOGCS') || !prj.includes('TWD')) throw new Error('來源座標系與預期 TWD97 經緯度不符');
    const encoding = get('cpg') ? new TextDecoder().decode(get('cpg')).trim() : 'big5';
    parts.push({ file: base, encoding, sourceCrs: prj });
    const reader = await shapefile.open(get('shp'), get('dbf'), { encoding: /^utf-?8|65001$/i.test(encoding) ? 'utf-8' : encoding === '950' ? 'big5' : encoding });
    while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const p = value.properties;
    if (['10016', '09007', '09020'].includes(p.COUNTYCODE)) continue;
    if (!value.geometry || !['Polygon', 'MultiPolygon'].includes(value.geometry.type)) continue;
    const geometry = clipping.union(geometries(value.geometry));
    const feature = { id: String(p.VILLCODE || p.TOWNCODE || p.COUNTYCODE), level: source.level,
      name: [p.COUNTYNAME, p.TOWNNAME, p.VILLNAME].filter(Boolean).join(''),
      label: p.VILLNAME || p.TOWNNAME || p.COUNTYNAME,
      county: String(p.COUNTYCODE), town: p.TOWNCODE ? String(p.TOWNCODE) : '', geometry };
    if (byId.has(feature.id)) feature.geometry = clipping.union(byId.get(feature.id).geometry, geometry);
    byId.set(feature.id, feature);
    }
  }
  return { features: [...byId.values()], source: { ...source, files: parts, sha256: sha(bytes) } };
}

await mkdir(`${root}.cache/maps`, { recursive: true });
await mkdir(`${root}data`, { recursive: true });
const counties = await load(sources[0]);
const { ocean, manifest: coast } = await loadOcean(projectPoint);
const nearshoreBytes = await readFile(`${root}data/nearshore-manifest.json`);
const nearshore = JSON.parse(nearshoreBytes);
if (nearshore.coastSourceSha256 !== coast.inputSha256 ||
    nearshore.coastManifestSha256 !== sha(await readFile(`${root}data/coast-manifest.json`))) throw new Error('近岸核准清單與海洋來源不符');
const land = mainlandMask(counties.features.map(f => f.geometry), ocean, nearshore.regions);
if (area(land) < 3e10) throw new Error('本島裁切結果過小，不發布這批圖資');
const towns = await load(sources[1]);
const villages = await load(sources[2]);
for (const input of [counties, towns, villages]) {
  if (nearshore.administrativeSources.find(s => s.level === input.source.level)?.sha256 !== input.source.sha256) throw new Error(`近岸核准清單與行政來源不符：${input.source.level}`);
}
const regions = [];
for (const feature of [...counties.features, ...towns.features, ...villages.features]) {
  const geometry = clipping.intersection(feature.geometry, land);
  if (area(geometry) < 1) continue;
  regions.push({ ...feature, geometry, bounds: boundsOf(geometry) });
}
const manifest = { version: 'nlsc-mainland-nearshore-2026-10-22', generatedAt: new Date().toISOString(), crs: 'EPSG:3826', projection,
  attribution: '內政部國土測繪中心；政府資料開放授權條款第 1 版', licenseUrl: 'https://data.gov.tw/license',
  sources: [counties.source, towns.source, villages.source],
  coast: { version: coast.version, inputSha256: coast.inputSha256, manifestSha256: sha(await readFile(`${root}data/coast-manifest.json`)), scales: coast.scales, licenseUrl: coast.licenseUrl },
  nearshore: { version: nearshore.version, manifestSha256: sha(nearshoreBytes), regions: nearshore.regions.map(({ name, sha256 }) => ({ name, sha256 })) },
  limitations: ['本島以官方 CoastA 海洋面排除海面後取最大連通陸域，加上六組雜湊釘選的近岸陸塊；河川與湖泊不自動排除', '海洋面採 1:25,000 圖幅，5 處缺口局部採 1:50,000；來源日期與海岸變動須參考 SOURCES.md', '行政區僅對遊戲範圍內部分出題與計分；其他沿岸島塊、遠方離島及無交集區域不出題', '不作為正式測量圖資'],
  counts: Object.fromEntries(['county', 'town', 'village'].map(level => [level, regions.filter(r => r.level === level).length])) };
const data = { manifest, land, bounds: boundsOf(land), regions };
const ids = new Set(regions.map(r => r.id));
if (manifest.counts.county !== 19 || manifest.counts.town !== 349 || manifest.counts.village !== 7656 ||
    regions.filter(r => r.level === 'village' && r.town === '63000030').length !== 53 ||
    regions.some(r => r.level === 'village' && (!ids.has(r.town) || !ids.has(r.county)))) throw new Error('匯入數量或父層行政區異常，不覆寫遊戲圖資');
const content = JSON.stringify(data);
await writeFile(`${root}data/taiwan.json`, content + '\n');
await writeFile(`${root}data/manifest.json`, JSON.stringify({ ...manifest, outputSha256: sha(Buffer.from(content + '\n')) }, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest.counts, bytes: Buffer.byteLength(content), sha256: sha(Buffer.from(content + '\n')) }));
