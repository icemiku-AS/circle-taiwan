import clipping from 'polygon-clipping';
import { area } from '../shared/scoring.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import shapefile from 'shapefile';

const sha = value => createHash('sha256').update(value).digest('hex');

export async function loadOcean(project) {
  const manifest = JSON.parse(await readFile(new URL('../data/coast-manifest.json', import.meta.url), 'utf8'));
  const bytes = await readFile(new URL('../data/coast-source.zip', import.meta.url));
  if (sha(bytes) !== manifest.inputSha256) throw new Error('海洋面來源雜湊不符');
  const files = unzipSync(bytes), ocean = [];
  for (const layer of manifest.layers) {
    for (const [path, hash] of Object.entries(layer.files)) if (!files[path] || sha(files[path]) !== hash) throw new Error(`海洋面圖幅檔案不符：${path}`);
    const base = layer.path;
    if (!new TextDecoder().decode(files[base + '.prj']).includes('WGS_1984')) throw new Error('海洋面坐標系與 WGS84 經緯度不符');
    const encoding = files[base + '.cpg'] ? new TextDecoder().decode(files[base + '.cpg']).trim() : 'big5';
    const source = await shapefile.open(files[base + '.shp'], files[base + '.dbf'], { encoding: /^utf-?8|65001$/i.test(encoding) ? 'utf-8' : encoding === '950' ? 'big5' : encoding });
    while (true) {
      const { done, value } = await source.read(); if (done) break;
      const p = value.properties, code = p.f_code;
      const reviewed = manifest.marineExceptions.some(e => e.path === base && e.globalId === p.GlobalID && e.code === code);
      if (p.FCsubtype !== 0 || (code != null && code !== 'BA040' && !reviewed) || !['Polygon', 'MultiPolygon'].includes(value.geometry?.type)) throw new Error(`海洋面包含未核對分類：${base}`);
      let geometry = value.geometry.type === 'Polygon' ? [value.geometry.coordinates] : value.geometry.coordinates;
      if (layer.clipBounds) {
        const frames = layer.clipBounds.map(([x0, y0, x1, y1]) => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]]);
        geometry = clipping.intersection(geometry, clipping.union(...frames));
      }
      if (geometry.length) ocean.push(geometry.map(polygon => polygon.map(ring => ring.map(project))));
    }
  }
  if (!ocean.length) throw new Error('缺少已核對的海洋面');
  return { ocean, manifest };
}

export function mainlandMask(administrative, ocean, retained = []) {
  if (!ocean.length) throw new Error('缺少已核對的海洋面，不使用行政區聯集代替陸地');
  // Only marine water is removed; inland rivers and lakes keep the existing scoring rule.
  const dry = clipping.difference(clipping.union(...administrative), ...ocean);
  if (!dry.length) throw new Error('海洋裁切後沒有本島陸地');
  const land = [dry.reduce((largest, polygon) => area([polygon]) > area([largest]) ? polygon : largest)];
  const byHash = new Map(dry.map(polygon => [sha(JSON.stringify(polygon)), polygon]));
  for (const region of retained) {
    const polygon = byHash.get(region.sha256);
    if (!polygon || land.includes(polygon)) throw new Error(`核准近岸陸塊不符或重複：${region.name}`);
    land.push(polygon);
  }
  return land;
}
