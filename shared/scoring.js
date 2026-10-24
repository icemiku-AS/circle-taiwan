import { MAX_POINTS } from './rules.js';

export function area(geometry) {
  return geometry.reduce((sum, polygon) => sum + polygon.reduce((a, ring, index) => {
    const [ox, oy] = ring[0];
    let value = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      value += (p[0] - ox) * (q[1] - oy) - (q[0] - ox) * (p[1] - oy);
    }
    return a + (index ? -1 : 1) * Math.abs(value) / 2;
  }, 0), 0);
}

export function validatePoints(points, bounds) {
  if (!Array.isArray(points) || points.length > MAX_POINTS) throw new Error(`圈選最多 ${MAX_POINTS} 個座標點`);
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error('圈選座標格式錯誤');
    if (bounds && (p[0] < bounds[0] || p[1] < bounds[1] || p[0] > bounds[2] || p[1] > bounds[3])) throw new Error('圈選超出可作答的地圖範圍');
  }
  return points.map(p => p.slice());
}

// Node and the browser worker use the same engines, without coordinate snapping or simplification.
export function createScoring(clipping, fallback) {
  function clip(operation, ...geometries) {
    try { return clipping[operation](...geometries); }
    catch (error) {
      if (!fallback || !/^(Unable to (find segment|complete output ring|pop\(\))|Infinite loop when)/.test(error.message)) throw error;
      // Retry the original coordinates with decimal arithmetic, never a coarser grid.
      return fallback[operation](...geometries);
    }
  }
  function normalizeStroke(points) {
    validatePoints(points);
    if (new Set(points.map(p => p.join(','))).size < 3) return [];
    const normalized = clip('union', [points]);
    return area(normalized) > 0 ? normalized : [];
  }
  function prepareScorer(target, land, neutral = []) {
    const effectiveLand = neutral.length ? clip('difference', land, neutral) : land;
    const correct = clip('intersection', target, effectiveLand), correctArea = area(correct);
    if (!Number.isFinite(correctArea) || correctArea <= 0) throw new Error('答案圖資面積無效，請重新載入圖資');
    return (points, { comparison = true } = {}) => {
      const normalized = normalizeStroke(points);
      const empty = { score: 0, status: points.length ? 'invalid' : 'unanswered', answer: [], hit: [], extra: [], miss: correct, breakdown: { hit: 0, extra: 0, miss: 100 } };
      if (!normalized.length) return comparison ? empty : { score: empty.score, status: empty.status, breakdown: empty.breakdown };
      const answer = clip('intersection', normalized, effectiveLand);
      const hit = answer.length ? clip('intersection', answer, correct) : [];
      const hitArea = area(hit), answerArea = area(answer), unionArea = answerArea + correctArea - hitArea;
      if (!Number.isFinite(unionArea) || unionArea <= 0) throw new Error('答案圖資面積無效，請重新載入圖資');
      const summary = { score: Math.min(100, Math.max(0, hitArea / unionArea * 100)), status: 'valid',
        breakdown: { hit: hitArea / unionArea * 100, extra: (answerArea - hitArea) / unionArea * 100, miss: (correctArea - hitArea) / unionArea * 100 } };
      return comparison ? { ...summary, answer, hit, extra: answer.length ? clip('difference', answer, correct) : [], miss: clip('difference', correct, answer) } : summary;
    };
  }
  return { normalizeStroke, prepareScorer, scoreAnswer: (points, target, land, neutral = []) => prepareScorer(target, land, neutral)(points) };
}
