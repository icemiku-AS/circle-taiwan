import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { questionPool, RULES_VERSION, TIMES, COUNTS, MAX_POINTS } from '../shared/rules.js';
import clipping from 'polygon-clipping';
import { area } from '../shared/scoring.js';

export function loadCatalog() {
  const bytes = readFileSync(new URL('../data/taiwan.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.outputSha256) throw new Error('圖資雜湊不符，請重新執行 npm run data:prepare');
  return createCatalog(JSON.parse(bytes));
}

export function createCatalog(data) {
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
  const [x0, y0, x1, y1] = data.bounds, margin = Math.max(x1 - x0, y1 - y0) * 0.3;
  return {
    ...data, regions, byId, playBounds: [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
    pool: settings => questionPool(settings, regions),
    extent(settings) {
      if (settings.challenge === 'village') return byId.get(settings.town).bounds;
      if (settings.challenge === 'town' && settings.scope === 'county') return byId.get(settings.county).bounds;
      return data.bounds;
    },
    publicData() { return { manifest: data.manifest, rulesVersion: RULES_VERSION, land: data.land, bounds: data.bounds,
      playBounds: this.playBounds, regions, times: TIMES, counts: COUNTS, maxPoints: MAX_POINTS }; }
  };
}
