import assert from 'node:assert/strict';
import test from 'node:test';
import clipping from 'polygon-clipping';
import * as fallback from 'polyclip-ts';
import { LANDMARK_RULES, roundScore, standings } from '../shared/rules.js';
import { area, createScoring, landmarkRulesForSettings, landmarkScoreForArea, locatePointInGeometry, validatePoints } from '../shared/scoring.js';

const engine = createScoring(clipping, fallback);
const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
const geometry = [[square]];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} != ${expected}`);
const scoreAt = (point, points = square, options) => engine.prepareLandmarkScorer(point)(points, options);

test('S 曲線：滿分、保底、中點與參考值', () => {
  const { minAreaM2: min, maxAreaM2: max } = LANDMARK_RULES;
  assert.equal(landmarkScoreForArea(min / 2), 100);
  assert.equal(landmarkScoreForArea(min), 100);
  assert.equal(landmarkScoreForArea(max), 10);
  assert.equal(landmarkScoreForArea(max * 2), 10);
  near(landmarkScoreForArea(Math.sqrt(min * max)), 55);
  const radii = [1, 2, 5, 10, 25, 50, 100, 200], scores = [100, 95.78, 80.13, 63.78, 40.71, 25.26, 14.22, 10];
  radii.forEach((radius, i) => assert.equal(roundScore(landmarkScoreForArea(Math.PI * (radius * 1000) ** 2)), scores[i]));
  let previous = 100;
  for (let i = 0; i < 20; i++) {
    const score = landmarkScoreForArea(min * (max / min) ** (i / 19));
    assert.ok(score >= 10 && score <= previous); previous = score;
  }
});

test('S 曲線：拒絕無效面積與規則，幾何有效性門檻獨立', () => {
  for (const areaM2 of [0, -1, NaN, Infinity]) assert.throws(() => landmarkScoreForArea(areaM2));
  for (const patch of [{ minAreaM2: 0 }, { maxAreaM2: 1 }, { minScore: NaN }, { minScore: 100 }, { invalidAreaM2: -1 }, { boundaryEpsilonM: -1 }]) {
    assert.throws(() => engine.prepareLandmarkScorer([5, 5], { ...LANDMARK_RULES, ...patch }));
  }
  assert.equal(scoreAt([0.5, 0.5], [[0, 0], [1, 0], [1, 1], [0, 1]]).status, 'invalid');
  assert.equal(scoreAt([0.5, 0.5], [[0, 0], [2, 0], [2, 1], [0, 1]]).score, 100);
  assert.equal(scoreAt([20, 20]).score, 0);
  assert.equal(scoreAt([20, 20]).status, 'valid');
});

test('縣市尺度：滿分與中點不變，圈滿全縣保底，其他設定不影響曲線', () => {
  for (const areaM2 of [60e6, 4600e6]) {
    const settings = { challenge: 'landmark', scope: 'county', pool: 'classic', difficulty: 'easy' };
    const rules = landmarkRulesForSettings(settings, areaM2);
    assert.equal(rules.minAreaM2, LANDMARK_RULES.minAreaM2); assert.equal(rules.maxAreaM2, areaM2);
    assert.equal(landmarkScoreForArea(rules.minAreaM2, rules), 100);
    near(landmarkScoreForArea(Math.sqrt(rules.minAreaM2 * areaM2), rules), 55);
    assert.equal(landmarkScoreForArea(areaM2, rules), 10);
    assert.equal(landmarkScoreForArea(areaM2 * 2, rules), 10);
    assert.deepEqual(landmarkRulesForSettings({ ...settings, pool: 'all', difficulty: 'hard' }, areaM2), rules);
    let last = 100;
    for (let i = 0; i <= 10; i++) {
      const score = landmarkScoreForArea(rules.minAreaM2 * (areaM2 / rules.minAreaM2) ** (i / 10), rules);
      assert.ok(score >= 10 && score <= last); last = score;
    }
  }
  assert.deepEqual(landmarkRulesForSettings({ challenge: 'landmark', scope: 'mainland' }), LANDMARK_RULES);
  assert.deepEqual(landmarkRulesForSettings({ challenge: 'town', scope: 'county' }), LANDMARK_RULES);
  for (const invalid of [undefined, 0, NaN, Infinity, LANDMARK_RULES.minAreaM2]) {
    assert.throws(() => landmarkRulesForSettings({ challenge: 'landmark', scope: 'county' }, invalid));
  }
  const rules = landmarkRulesForSettings({ challenge: 'landmark', scope: 'county' }, 60e6);
  const scorer = engine.prepareLandmarkScorer([5000, 3000], rules);
  rules.maxAreaM2 = LANDMARK_RULES.maxAreaM2;
  const answer = [[0, 0], [10000, 0], [10000, 6000], [0, 6000]], result = scorer(answer);
  assert.equal(result.score, 10); assert.equal(result.landmark.areaM2, 60e6); assert.equal(result.landmark.hit, true);
  assert.deepEqual(scorer(answer), result);
});

test('PIP：內部、水平／垂直邊、頂點與小量邊界容差', () => {
  for (const p of [[5, 5], [0, 5], [5, 0], [0, 0], [10, 10]]) {
    const r = scoreAt(p); assert.equal(r.landmark.hit, true); assert.equal(r.landmark.outsideDistanceM, 0);
    assert.equal(r.landmark.nearestPoint, null);
  }
  assert.equal(locatePointInGeometry([5, 5], geometry).relation, 'inside');
  assert.equal(locatePointInGeometry([0, 0], geometry).relation, 'boundary');
  assert.equal(scoreAt([-1, 0]).landmark.hit, false);
  const epsilon = LANDMARK_RULES.boundaryEpsilonM;
  assert.equal(scoreAt([-epsilon / 2, 5]).landmark.hit, true);
  assert.equal(scoreAt([-2 * epsilon, 5]).landmark.hit, false);
});

test('最近距離：線段投影、端點與零長線段', () => {
  const side = scoreAt([13, 5]).landmark, corner = scoreAt([13, 14]).landmark;
  assert.equal(side.outsideDistanceM, 3); assert.deepEqual(side.nearestPoint, [10, 5]);
  assert.equal(corner.outsideDistanceM, 5); assert.deepEqual(corner.nearestPoint, [10, 10]);
  const repeated = locatePointInGeometry([5, 6], [[[[2, 2], [2, 2]]]]);
  assert.equal(repeated.outsideDistanceM, 5);
  assert.deepEqual(locatePointInGeometry([5, 5], []), { relation: 'outside', outsideDistanceM: null, nearestPoint: null });
});

test('洞與凹形：洞內到最近邊界，不能只判包圍盒', () => {
  const hole = [[3, 3], [3, 7], [7, 7], [7, 3]], withHole = [[square, hole]];
  assert.equal(area(withHole), 84);
  assert.equal(locatePointInGeometry([5, 5], withHole).outsideDistanceM, 2);
  assert.equal(locatePointInGeometry([3, 5], withHole).relation, 'boundary');
  const stroke = [...square, square[0], ...hole, hole[0], square[0]];
  const result = scoreAt([5, 5], stroke);
  assert.equal(result.landmark.areaM2, 84); assert.equal(result.landmark.hit, false);
  assert.equal(result.landmark.outsideDistanceM, 2);
  const concave = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.equal(scoreAt([7, 7], concave).landmark.outsideDistanceM, 3);
  assert.equal(scoreAt([7, 7], concave).landmark.areaM2, 64);
});

test('自相交、重複繞行與多區塊依 non-zero 正規化計全部面積', () => {
  const bow = [[0, 0], [10, 10], [0, 10], [10, 0]];
  assert.equal(scoreAt([5, 2], bow).landmark.areaM2, 50);
  assert.equal(scoreAt([5, 2], bow).landmark.hit, true);
  assert.equal(scoreAt([2, 5], bow).landmark.hit, false);
  const twice = [...square, ...square];
  assert.equal(scoreAt([5, 5], twice).landmark.areaM2, 100);
  assert.equal(scoreAt([5, 5], twice).landmark.hit, true);
  const other = square.map(([x, y]) => [x + 20, y]);
  const both = [...square, square[0], ...other, other[0], square[0]];
  assert.equal(scoreAt([5, 5], both).landmark.areaM2, 200);
});

test('原筆跡不變、完整面積不裁陸地，投影座標量級結果一致', () => {
  const input = structuredClone(square), original = structuredClone(input);
  const first = scoreAt([5, 5], input);
  assert.deepEqual(input, original); assert.deepEqual(scoreAt([5, 5], input), first);
  assert.equal(first.landmark.areaM2, 100);
  assert.equal(scoreAt([5, 5], [...square].reverse()).landmark.areaM2, 100);
  assert.equal(scoreAt([5, 5], [...square, square[0], square[0]]).landmark.areaM2, 100);
  const shifted = square.map(([x, y]) => [x + 250000, y + 2600000]);
  const result = scoreAt([250013, 2600005], shifted);
  near(result.landmark.areaM2, 100); near(result.landmark.outsideDistanceM, 3);
  assert.equal(result.landmark.hit, false);
  assert.equal(scoreAt([5, 5], square, { comparison: false }).answer, undefined);
});

test('空筆畫、退化及輸入邊界不會產生假命中或 NaN', () => {
  for (const points of [[], [[0, 0]], [[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 2]], [[1, 1], [1, 1], [1, 1]]]) {
    const r = scoreAt([5, 5], points);
    assert.equal(r.status, points.length ? 'invalid' : 'unanswered');
    assert.equal(r.score, 0); assert.equal(r.landmark.hit, null); assert.equal(r.landmark.outsideDistanceM, null);
  }
  for (const points of [[[NaN, 1]], [[1]], [[Infinity, 1]], Array(2049).fill([0, 0])]) assert.throws(() => scoreAt([5, 5], points));
  assert.throws(() => validatePoints([[11, 0]], [0, 0, 10, 10]));
  assert.equal(validatePoints(Array(2048).fill([0, 0])).length, 2048);
  assert.throws(() => engine.prepareLandmarkScorer([NaN, 1]));
});

test('景點沿用指定例外備援，未知錯誤拋出且不記成 0 分', () => {
  const points = structuredClone(square), original = structuredClone(points);
  let calls = 0;
  const known = createScoring({ union() { throw new Error('Unable to find segment #1 in SweepLine tree.'); } }, {
    union(...args) { calls++; return fallback.union(...args); }
  });
  assert.deepEqual(known.prepareLandmarkScorer([5, 5])(points), scoreAt([5, 5], points));
  assert.equal(calls, 1); assert.deepEqual(points, original);
  const unknown = createScoring({ union() { throw new Error('broken'); } }, { union() { assert.fail('未知錯誤不可使用備援'); } });
  assert.throws(() => unknown.prepareLandmarkScorer([5, 5])(points), /broken/);
  assert.deepEqual(points, original);
});

test('行政區 IoU 契約與多人保底排名維持原規則', () => {
  const old = engine.scoreAnswer(square, geometry, geometry);
  assert.equal(old.score, 100); assert.equal(old.status, 'valid');
  assert.deepEqual(old.breakdown, { hit: 100, extra: 0, miss: 0 });
  assert.equal(old.landmark, undefined);
  const rows = standings([{ id: 'a' }, { id: 'b' }], [{ results: {
    a: { status: 'ok', score: 10, elapsed: 1000 }, b: { status: 'ok', score: 0, elapsed: 1000 }
  } }], 20, 'multi');
  assert.deepEqual(rows.map(r => r.points), [1, 0]);
});
