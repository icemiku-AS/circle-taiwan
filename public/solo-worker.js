import './vendor/polygon-clipping.umd.min.js';
import './vendor/polyclip-ts.umd.min.js';
import { createScoring, validatePoints } from './shared/scoring.js';
import { compressedJSON } from './solo-assets.js';

const { prepareScorer, prepareLandmarkScorer } = createScoring(globalThis.polygonClipping, globalThis.polyclip);
let land, regions = new Map(), regionId, score, queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      let value;
      if (data.action === 'init') {
        land = data.land; regions.clear(); regionId = null; score = null;
        const keys = [...new Set(data.ids.map(id => data.manifest.regionPacks[id]))]; let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, keys.length) }, async () => {
          while (next < keys.length) {
            const asset = data.manifest.answerPacks[keys[next++]]; if (!asset) throw new Error('題目資料版本不符');
            for (const r of await compressedJSON(asset)) if (data.ids.includes(r.id)) regions.set(r.id, r);
          }
        }));
        if (data.ids.some(id => !regions.has(id))) throw new Error('題目資料不完整');
        value = true;
      } else if (data.action === 'geometry') {
        const r = regions.get(data.regionId); if (!r) throw new Error('題目資料尚未就緒');
        value = r.kind === 'landmark' ? { target: [], targetPoint: r.point, neutral: [] } : { target: r.geometry, neutral: r.neutral };
      } else if (data.action === 'score' || data.action === 'prepare') {
        const r = regions.get(data.regionId); if (!r) throw new Error('題目資料尚未就緒');
        if (regionId !== r.id) { score = r.kind === 'landmark' ? prepareLandmarkScorer(r.point) : prepareScorer(r.geometry, land, r.neutral); regionId = r.id; }
        if (data.action === 'prepare') value = true;
        else {
          const { answer, ...result } = score(validatePoints(data.points, data.bounds));
          value = r.kind === 'landmark' ? { result, answer, target: [], targetPoint: r.point, neutral: [] } : { result, target: r.geometry, neutral: r.neutral };
        }
      } else throw new Error('未知計分操作');
      self.postMessage({ id: data.id, value });
    } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  });
};
