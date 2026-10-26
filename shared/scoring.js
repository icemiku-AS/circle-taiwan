import { MAX_POINTS, LANDMARK_RULES } from './rules.js';

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

function validateLandmarkRules(rules) {
  const { minAreaM2, maxAreaM2, minScore, invalidAreaM2, boundaryEpsilonM } = rules;
  if (![minAreaM2, maxAreaM2, minScore, invalidAreaM2, boundaryEpsilonM].every(Number.isFinite) ||
    !(0 < invalidAreaM2 && invalidAreaM2 < minAreaM2 && minAreaM2 < maxAreaM2) ||
    minScore <= 0 || minScore >= 100 || boundaryEpsilonM < 0) throw new Error('景點計分規則無效');
}

export function landmarkScoreForArea(areaM2, rules = LANDMARK_RULES) {
  validateLandmarkRules(rules);
  if (!Number.isFinite(areaM2) || areaM2 <= 0) throw new Error('圈選面積無效');
  if (areaM2 <= rules.minAreaM2) return 100;
  if (areaM2 >= rules.maxAreaM2) return rules.minScore;
  const u = Math.log(areaM2 / rules.minAreaM2) / Math.log(rules.maxAreaM2 / rules.minAreaM2);
  const smooth = u * u * (3 - 2 * u);
  return Math.max(rules.minScore, Math.min(100, rules.minScore + (100 - rules.minScore) * (1 - smooth)));
}

function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    if ((ay > y) !== (by > y) && (ax - x) + (y - ay) * (bx - ax) / (by - ay) > 0) inside = !inside;
  }
  return inside;
}

// Geometry must already be normalized: raw self-intersections use non-zero, not even-odd fill.
export function locatePointInGeometry(point, geometry, boundaryEpsilonM = LANDMARK_RULES.boundaryEpsilonM) {
  validatePoints([point]);
  if (!Number.isFinite(boundaryEpsilonM) || boundaryEpsilonM < 0) throw new Error('景點邊界容差無效');
  let nearestPoint = null, distanceSquared = Infinity;
  for (const polygon of geometry) for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0;
      const q = [a[0] + t * dx, a[1] + t * dy], d2 = (point[0] - q[0]) ** 2 + (point[1] - q[1]) ** 2;
      if (d2 < distanceSquared) { distanceSquared = d2; nearestPoint = q; }
    }
  }
  if (!nearestPoint) return { relation: 'outside', outsideDistanceM: null, nearestPoint: null };
  if (!Number.isFinite(distanceSquared)) throw new Error('景點距離計算失敗');
  if (distanceSquared <= boundaryEpsilonM ** 2) return { relation: 'boundary', outsideDistanceM: 0, nearestPoint: null };
  if (geometry.some(polygon => insideRing(point, polygon[0]) && !polygon.slice(1).some(ring => insideRing(point, ring)))) {
    return { relation: 'inside', outsideDistanceM: 0, nearestPoint: null };
  }
  return { relation: 'outside', outsideDistanceM: Math.sqrt(distanceSquared), nearestPoint };
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
  function prepareLandmarkScorer(point, rules = LANDMARK_RULES) {
    const target = validatePoints([point])[0], settings = { ...rules };
    validateLandmarkRules(settings);
    return (points, { comparison = true } = {}) => {
      const answer = normalizeStroke(points), areaM2 = area(answer);
      if (!Number.isFinite(areaM2) || areaM2 < 0) throw new Error('圈選面積計算失敗');
      const result = { score: 0, status: points.length ? 'invalid' : 'unanswered',
        landmark: { hit: null, areaM2, outsideDistanceM: null, nearestPoint: null } };
      if (answer.length && areaM2 > settings.invalidAreaM2) {
        const { relation, outsideDistanceM, nearestPoint } = locatePointInGeometry(target, answer, settings.boundaryEpsilonM);
        const hit = relation !== 'outside';
        result.status = 'valid'; result.score = hit ? landmarkScoreForArea(areaM2, settings) : 0;
        result.landmark = { hit, areaM2, outsideDistanceM, nearestPoint };
      }
      return comparison ? { ...result, answer } : result;
    };
  }
  return { normalizeStroke, prepareScorer, prepareLandmarkScorer, scoreAnswer: (points, target, land, neutral = []) => prepareScorer(target, land, neutral)(points) };
}
