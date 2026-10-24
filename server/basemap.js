import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function loadBasemap() {
  const manifest = JSON.parse(readFileSync(new URL('../data/basemap-manifest.json', import.meta.url), 'utf8'));
  const read = (name, hash) => {
    const bytes = readFileSync(new URL(`../data/${name}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('線索底圖雜湊不符，請執行 npm run data:basemap');
    return bytes;
  };
  const terrain = read('terrain.bin.gz', manifest.terrainFileSha256);
  const { features } = JSON.parse(gunzipSync(read('basemap.json.gz', manifest.vectorsSha256)));
  return { manifest, terrain, features };
}

export function visibleFeatures(features, bounds, detail) {
  return features.filter(f => f.bounds[0] <= bounds[2] && f.bounds[2] >= bounds[0] && f.bounds[1] <= bounds[3] && f.bounds[3] >= bounds[1] &&
    (f.kind === 'water' ? detail > 0 || Math.max(f.bounds[2] - f.bounds[0], f.bounds[3] - f.bounds[1]) >= 500 : f.tier <= detail));
}
