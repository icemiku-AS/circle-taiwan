import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import shapefile from 'shapefile';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = `${root}.cache/basemap/`;
const osmUrl = 'https://download.geofabrik.de/asia/taiwan-261017-free.shp.zip';
const terrainUrl = 'https://www.tgos.tw/MDE/VirtualDir_TC/Product/528530be-0710-431e-954e-2f2f5e98b0c5/不分幅_全台20MDEM(2025).zip';
const projection = '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const transform = proj4('EPSG:4326', projection);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function boundsOf(lines) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const line of lines) for (const [x, y] of line) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}
export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const kept = new Uint8Array(points.length); kept[0] = kept[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(), a = points[first], b = points[last], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    let farthest = -1, maximum = tolerance * tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i], t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
      const d = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (d > maximum) { maximum = d; farthest = i; }
    }
    if (farthest >= 0) { kept[farthest] = 1; stack.push([first, farthest], [farthest, last]); }
  }
  return points.filter((_, i) => kept[i]);
}
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const projected = line => line.map(p => transform.forward(p).map(n => Math.round(n * 10) / 10));

async function download(name, url) {
  const path = cache + name;
  try { await stat(path); return path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`下載 ${name}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`底圖下載失敗 HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(path + '.part'));
  await rename(path + '.part', path); return path;
}

async function terrain() {
  const zip = await readFile(await download('dtm20.zip', terrainUrl));
  const tifPath = cache + 'DEM_tawiwan_V2025.tif';
  try { await stat(tifPath); }
  catch { const files = unzipSync(zip, { filter: f => f.name === 'DEM_tawiwan_V2025.tif' }); await writeFile(tifPath, files['DEM_tawiwan_V2025.tif']); }
  const tiff = await fromFile(tifPath);
  try {
    const image = await tiff.getImage(), keys = image.getGeoKeys(), resolution = image.getResolution(), origin = image.getOrigin();
    if (keys.ProjNatOriginLongGeoKey !== 121 || keys.ProjScaleAtNatOriginGeoKey !== .9999 || resolution[0] !== 20 || resolution[1] !== -20 || keys.GTRasterTypeGeoKey !== 2) throw new Error('地形投影或網格與預期不符');
    const factor = 5, width = Math.floor(image.getWidth() / factor), height = Math.floor(image.getHeight() / factor);
    // Display relief uses the agreed 100 m grid sampled from the official 20 m source.
    const rasters = await image.readRasters({ window: [0, 0, width * factor, height * factor], width, height, samples: [0], resampleMethod: 'nearest' });
    const pixels = new Uint16Array(width * height), missing = image.getGDALNoData();
    let valid = 0, max = 0;
    for (let i = 0; i < pixels.length; i++) {
      const n = rasters[0][i];
      pixels[i] = n === missing || !Number.isFinite(n) ? 65535 : Math.max(0, Math.round(n));
      if (pixels[i] !== 65535) { valid++; max = Math.max(max, pixels[i]); }
    }
    if (max < 3900 || valid < 3e6) throw new Error('地形高程或覆蓋數量異常');
    const bytes = Buffer.alloc(pixels.length * 2);
    for (let i = 0; i < pixels.length; i++) bytes.writeUInt16LE(pixels[i], i * 2);
    const cell = 100, bounds = [origin[0] - cell / 2, origin[1] - (height - .5) * cell, origin[0] + (width - .5) * cell, origin[1] + cell / 2];
    return { bytes, info: { width, height, bounds, cell, nodata: 65535, format: 'uint16-le', max, valid, url: '/terrain.bin',
      source: { url: terrainUrl, dataset: 'https://data.gov.tw/dataset/176927', sha256: sha(zip), file: 'DEM_tawiwan_V2025.tif', originalCell: 20,
        reference: 'TWD97 / TM2 121; file projection uses the WGS84 ellipsoid; no precise reference-frame adjustment' } } };
  } finally { await tiff.close(); }
}

async function vectors(bounds) {
  const zip = await readFile(await download('osm.zip', osmUrl));
  const files = unzipSync(zip, { filter: f => /gis_osm_(roads|waterways|water_a)_free_1\.(shp|dbf|prj|cpg)$/i.test(f.name) });
  const features = [], counts = { roads: 0, rivers: 0, water: 0 };
  const tiers = { motorway: 0, trunk: 0, primary: 0, motorway_link: 0, trunk_link: 0, primary_link: 0,
    secondary: 1, tertiary: 1, secondary_link: 1, tertiary_link: 1, unclassified: 2, residential: 2, living_street: 2 };
  for (const layer of ['roads', 'waterways', 'water_a']) {
    console.log(`處理 OSM ${layer}…`);
    const name = `gis_osm_${layer}_free_1`;
    if (!new TextDecoder().decode(files[name + '.prj']).includes('GCS_WGS_1984')) throw new Error('OSM 座標系不符');
    const reader = await shapefile.open(files[name + '.shp'], files[name + '.dbf'], { encoding: 'utf-8' });
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const f = value.properties.fclass, g = value.geometry;
      if (!g || (layer === 'roads' && !Object.hasOwn(tiers, f)) || (layer === 'waterways' && !['river', 'stream', 'canal'].includes(f))) continue;
      const polygon = layer === 'water_a', tier = layer === 'roads' ? tiers[f] : f === 'river' ? 0 : 2;
      const raw = polygon ? (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) : [g.type === 'LineString' ? [g.coordinates] : g.coordinates];
      for (const part of raw) {
        const lines = part.map(projected), box = boundsOf(lines);
        if (!intersects(box, bounds) || (polygon && (box[2] - box[0]) * (box[3] - box[1]) < 10000)) continue;
        const paths = lines.map(line => simplifyLine(line, polygon ? 5 : tier === 2 ? 4 : 10));
        if (paths.some(line => line.length < (polygon ? 4 : 2))) continue;
        const kind = polygon ? 'water' : layer === 'roads' ? 'road' : 'river';
        // Keep geometry only: no place names, road names, POIs or administrative lines reach the game.
        features.push({ kind, tier, bounds: box, paths });
        counts[kind === 'road' ? 'roads' : kind === 'river' ? 'rivers' : 'water']++;
      }
    }
  }
  if (counts.roads < 10000 || counts.rivers < 1000) throw new Error('道路或水系數量異常');
  return { features, counts, source: { url: osmUrl, sha256: sha(zip), date: '2026-10-17', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors / Geofabrik' } };
}

async function main() {
  await mkdir(cache, { recursive: true });
  const data = JSON.parse(await readFile(`${root}data/taiwan.json`, 'utf8'));
  const relief = await terrain(); console.log(`地形 ${relief.info.width}×${relief.info.height}`);
  const map = await vectors(data.bounds);
  const manifest = { version: 'basemap-2026-10-18', crs: 'EPSG:3826', terrain: relief.info, counts: map.counts,
    sources: [relief.info.source, map.source], limitations: ['地形以 100 公尺顯示網格取樣；原始 NoData 留空', 'OSM 道路與水系為參考線索，不參與評分', '本島視覺裁切使用當版行政答案的陸域遮罩；來源日期及沿岸差異見 SOURCES.md'],
    terrainSha256: sha(relief.bytes) };
  const content = Buffer.from(JSON.stringify({ ...manifest, features: map.features }) + '\n');
  const terrainGzip = gzipSync(relief.bytes), vectorsGzip = gzipSync(content);
  await writeFile(`${root}data/terrain.bin.gz`, terrainGzip);
  await writeFile(`${root}data/basemap.json.gz`, vectorsGzip);
  await writeFile(`${root}data/basemap-manifest.json`, JSON.stringify({ ...manifest, vectorsSha256: sha(vectorsGzip), terrainFileSha256: sha(terrainGzip) }, null, 2) + '\n');
  console.log(JSON.stringify({ ...map.counts, vectorBytes: content.length, terrainBytes: relief.bytes.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
