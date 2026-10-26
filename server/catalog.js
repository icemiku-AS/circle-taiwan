import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { questionPool, RULES_VERSION, TIMES, COUNTS, MAX_POINTS } from '../shared/rules.js';
import clipping from 'polygon-clipping';
import { area } from '../shared/scoring.js';

export function loadCatalog() {
  const bytes = readFileSync(new URL('../data/taiwan.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.outputSha256) throw new Error('圖資雜湊不符，請重新執行 npm run data:prepare');
  const landmarkBytes = readFileSync(new URL('../data/landmarks.json', import.meta.url));
  const landmarkManifest = JSON.parse(readFileSync(new URL('../data/landmarks-manifest.json', import.meta.url)));
  if (createHash('sha256').update(landmarkBytes).digest('hex') !== landmarkManifest.outputSha256) throw new Error('景點題庫雜湊不符，請重新產製題庫');
  const landmarks = JSON.parse(landmarkBytes);
  if (landmarks.version !== landmarkManifest.version || landmarks.landmarks.length !== landmarkManifest.count || landmarks.crs !== 'EPSG:3826' || landmarks.projection !== manifest.projection) throw new Error('景點題庫版本或投影不符');
  return createCatalog(JSON.parse(bytes), landmarks);
}

export function createCatalog(data, landmarks = null) {
  const byId = new Map(data.regions.map(r => [r.id, { ...r, neutral: [], neutralNames: [] }]));
  if (byId.size !== data.regions.length) throw new Error('圖資行政代碼重複');
  const regions = data.regions.filter(r => r.level !== 'village' || (r.label?.trim() && r.label !== byId.get(r.town)?.label))
    .map(({ geometry, ...r }) => r);
  for (const region of byId.values()) {
    const enclosed = new Map();
    for (const polygon of region.geometry) for (const ring of polygon.slice(1)) {
      const hole = [[ring]], box = ring.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
      for (const other of byId.values()) {
        if (other.id === region.id || other.level !== region.level || other.bounds[0] < box[0] || other.bounds[1] < box[1] || other.bounds[2] > box[2] || other.bounds[3] > box[3]) continue;
        if (area(clipping.difference(other.geometry, hole)) <= 1e-6) enclosed.set(other.id, other);
      }
    }
    if (enclosed.size) {
      region.neutral = clipping.union(...[...enclosed.values()].map(r => r.geometry));
      region.neutralNames = [...enclosed.values()].map(r => r.name);
    }
  }
  // POIs join metadata only after all administrative geometry processing is complete.
  for (const item of landmarks?.landmarks || []) {
    if (byId.has(item.id) || item.point.length !== 2 || !item.point.every(Number.isFinite) || byId.get(item.county)?.level !== 'county') throw new Error('景點題庫 ID、座標或縣市無效');
    const meta = { id: item.id, name: item.name, label: item.name, level: 'landmark', county: item.county, anchorLabel: item.anchorLabel };
    regions.push(meta); byId.set(item.id, { ...meta, kind: 'landmark', point: item.point, neutralNames: [] });
  }
  const manifest = landmarks ? { ...data.manifest, version: `${data.manifest.version}+${landmarks.version}`, landmarkVersion: landmarks.version } : data.manifest;
  const [x0, y0, x1, y1] = data.bounds, margin = Math.max(x1 - x0, y1 - y0) * 0.3;
  return {
    ...data, manifest, regions, byId, playBounds: [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
    pool: settings => questionPool(settings, regions),
    extent(settings) {
      if (settings.challenge === 'village') return byId.get(settings.town).bounds;
      if (settings.challenge === 'town' && settings.scope === 'county') return byId.get(settings.county).bounds;
      return data.bounds;
    },
    publicData() { return { manifest, rulesVersion: RULES_VERSION, land: data.land, bounds: data.bounds,
      playBounds: this.playBounds, regions, times: TIMES, counts: COUNTS, maxPoints: MAX_POINTS }; }
  };
}
