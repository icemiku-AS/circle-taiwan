import assert from 'node:assert/strict';
import test from 'node:test';
import { RULES_VERSION, extentForSettings, questionPool, standings, validateSettings } from '../shared/rules.js';
import { multiplayerRulesText, roundScoreText } from '../public/share.js';

const roster = count => Array.from({ length: count }, (_, i) => ({ id: String(i) }));
const round = scores => ({ results: Object.fromEntries(scores.map((score, i) => [String(i), { score, elapsed: (i + 1) * 1000, status: 'ok' }])) });
const multi = scores => standings(roster(scores.length), [round(scores)], 20, 'multi');
const ladders = [[8, 1], [8, 5, 1], [8, 6, 3, 1], [8, 6, 5, 3, 1], [8, 7, 5, 4, 2, 1], [8, 7, 6, 5, 3, 2, 1], [8, 7, 6, 5, 4, 3, 2, 1]];

for (const [index, expected] of ladders.entries()) {
  test(`${index + 2} 人名次分正確，最高 10 點，92% 以上最後一名得 3 點`, () => {
    const rows = multi(expected.map((_, i) => 99 - i));
    assert.deepEqual(rows.map(p => p.points), expected.map(points => points + 2));
    assert.deepEqual(rows.map(p => p.rank), expected.map((_, i) => i + 1));
  });
}

test('低吻合度第一名、神準最後一名與全員未作答', () => {
  assert.equal(multi([5, 0])[0].points, 0);
  assert.equal(multi([99, 92])[1].points, 3);
  const rows = standings(roster(2), [{ results: {} }], 20, 'multi');
  for (const p of rows) {
    assert.equal(p.points, 0);
    assert.equal(p.score, 0);
    assert.equal(p.time, 20);
    assert.equal(p.perQuestion[0].status, 'unanswered');
  }
});

test('先取兩位小數再判定品質上限與神準門檻', () => {
  for (const [score, points] of [[9.994, 0], [9.995, 1], [49.994, 4], [49.995, 5], [74.994, 7], [74.995, 8], [80, 9], [89.994, 9], [89.995, 10], [100, 10]]) {
    assert.equal(multi([score, 0])[0].points, points, `${score}%`);
  }
});

test('吻合度取兩位後並列為 1、1、3；多人時間不破同分', () => {
  const rows = multi([95.001, 95.004, 94]);
  assert.deepEqual(rows.map(p => p.points), [10, 10, 3]);
  assert.deepEqual(rows.map(p => p.rank), [1, 1, 3]);
  assert.deepEqual(rows.map(p => p.time), [1, 2, 3]);
  const reversed = standings(roster(3).reverse(), [round([95.001, 95.004, 94])], 20, 'multi');
  assert.deepEqual(reversed.map(p => [p.id, p.points, p.rank]).sort(), rows.map(p => [p.id, p.points, p.rank]).sort());
});

test('無效狀態不領分、不搶名次，開局名單包含離場者', () => {
  const q = round([95, 92, 100, 100, 100]);
  ['unanswered', 'invalid', 'forced_missing'].forEach((status, i) => { q.results[String(i + 2)].status = status; });
  q.results.spectator = { score: 100, elapsed: 0, status: 'ok' };
  const players = roster(5), rows = standings(players, [q], 20, 'multi');
  assert.equal(rows.find(p => p.id === '0').points, 10);
  assert.equal(rows.find(p => p.id === '1').points, 8);
  for (const id of ['2', '3', '4']) assert.equal(rows.find(p => p.id === id).points, 0);
  players[1].left = true;
  assert.deepEqual(standings(players, [q], 20, 'multi').map(p => p.points), rows.map(p => p.points));
  delete q.results['1'];
  const missing = standings(players, [q], 20, 'multi').find(p => p.id === '1');
  assert.equal(missing.points, 0);
  assert.equal(missing.score, 0);
  assert.equal(missing.time, 20);
});

test('逐題點數累計決定勝負，平均僅在同積分時比較', () => {
  const rows = standings(roster(2), [[91, 90], [91, 90], [80, 100]].map(round), 20, 'multi');
  assert.deepEqual(rows.map(p => [p.id, p.points, p.score, p.rank]), [['0', 22, 87.33, 1], ['1', 16, 93.33, 2]]);
  for (const p of rows) assert.equal(p.points, p.perQuestion.reduce((sum, q) => sum + q.points, 0));
  const tiedPoints = multi([9, 5]);
  assert.deepEqual(tiedPoints.map(p => [p.points, p.rank]), [[0, 1], [0, 2]]);
});

test('平均由原始分數計算，取兩位小數後比較並列', () => {
  const rows = standings(roster(2), [[74.994, 74.999], [74.994, 74.999], [75.004, 74.999]].map(round), 20, 'multi');
  assert.ok(rows.every(p => p.score === 75));
  const ties = multi([5.001, 5.004]);
  assert.deepEqual(ties.map(p => p.rank), [1, 1]);
});

test('明確作廢或任一系統計分失敗，都排除全題積分、平均及時間', () => {
  const cancelled = { ...round([100, 100]), voided: true };
  const failed = round([100, 100]);
  failed.results['1'] = { score: null, elapsed: 15000, status: 'calculation_failed' };
  const rows = standings(roster(2), [round([95, 92]), cancelled, failed], 20, 'multi');
  assert.deepEqual(rows.map(p => p.points), [10, 3]);
  assert.deepEqual(rows.map(p => p.score), [95, 92]);
  assert.deepEqual(rows.map(p => p.time), [1, 2]);
  for (const p of rows) {
    assert.equal(p.validRounds, 1);
    for (const q of p.perQuestion.slice(1)) assert.deepEqual([q.points, q.score, q.time, q.voided], [0, null, null, true]);
  }
  for (const rounds of [[], [cancelled, failed]]) {
    for (const p of standings(roster(2), rounds, 20, 'multi')) assert.deepEqual([p.points, p.score, p.time, p.rank, p.validRounds], [0, null, null, null, 0]);
  }
});

test('單人仍按吻合度與時間排序，原始分數嚴格大於 50 才計達標點', () => {
  const rows = standings(roster(2), [round([50, 50.001])], 0);
  assert.deepEqual(rows.map(p => [p.id, p.points, p.score, p.rank]), [['0', 0, 50, 1], ['1', 1, 50, 2]]);
});

test('既有 0.5 房間保留舊積分；0.8 與 0.6／0.7 共用名次規則', () => {
  assert.equal(RULES_VERSION, 'circle-taiwan-0.8');
  for (const version of ['circle-taiwan-0.6', 'circle-taiwan-0.7']) assert.deepEqual(
    standings(roster(2), [round([95, 95])], 20, 'multi', RULES_VERSION),
    standings(roster(2), [round([95, 95])], 20, 'multi', version));
  const rows = standings(roster(2), [round([95, 95])], 20, 'multi', 'circle-taiwan-0.5');
  assert.deepEqual(rows.map(p => [p.points, p.rank]), [[1, 1], [1, 2]]);
  assert.equal(standings(roster(2), [round([50.001, 50])], 20, 'multi', 'circle-taiwan-0.5')[0].points, 1);
});

test('景點 scope／pool／difficulty 獨立；行政區與預設 classic 相容', () => {
  const regions = [
    { id: '10004', level: 'county', bounds: [1, 2, 3, 4] }, { id: '65000', level: 'county', bounds: [5, 6, 7, 8] },
    { id: 'town-a', level: 'town', county: '10004', bounds: [1, 2, 2, 3] },
    { id: 'village-a', level: 'village', county: '10004', town: 'town-a' },
    ...['10004', '65000'].flatMap(county => [0, 1, 2].map(i => ({ id: `lm-${county}-${i}`, county, level: 'landmark',
      classicMainland: i === 0, classicCounty: i < 2 })))
  ], bounds = [0, 0, 10, 10];
  for (const mode of ['single', 'multi']) for (const scope of ['mainland', 'county']) for (const pool of ['classic', 'all']) {
    let previous;
    for (const difficulty of ['easy', 'hard']) {
      const settings = validateSettings({ challenge: 'landmark', scope, pool, county: '10004', town: 'town-a', difficulty }, mode, regions);
      const ids = questionPool(settings, regions).map(r => r.id);
      assert.equal(ids.length, scope === 'mainland' ? pool === 'classic' ? 2 : 6 : pool === 'classic' ? 2 : 3);
      assert.equal(settings.town, ''); assert.equal(settings.county, scope === 'county' ? '10004' : '');
      assert.deepEqual(extentForSettings(settings, regions, bounds), scope === 'county' ? regions[0].bounds : bounds);
      if (previous) assert.deepEqual(ids, previous); previous = ids;
    }
  }
  assert.equal(validateSettings({ challenge: 'landmark' }, 'single', regions).pool, 'classic');
  for (const input of [{ scope: 'town' }, { pool: 'invalid' }, { scope: 'county', county: '09020' }]) {
    assert.throws(() => validateSettings({ challenge: 'landmark', ...input }, 'single', regions));
  }
  const town = validateSettings({ challenge: 'town', scope: 'county', county: '10004', pool: 'all' }, 'single', regions);
  assert.equal(town.pool, 'classic'); assert.deepEqual(questionPool(town, regions).map(r => r.id), ['town-a']);
  assert.deepEqual(extentForSettings(town, regions, bounds), regions[0].bounds);
  const village = validateSettings({ challenge: 'village', county: '10004', town: 'town-a' }, 'single', regions);
  assert.deepEqual(extentForSettings(village, regions, bounds), regions[2].bounds);
});

test('逐題文字支援動態點數，保留缺件與作廢回饋', () => {
  for (const points of [1, 3, 9, 10]) assert.equal(roundScoreText({ points, score: 92, status: 'ok' }), `+${points} 點 · 92.00%`);
  assert.equal(roundScoreText({ points: 0, score: 0, status: 'forced_missing' }), '0 點 · 0.00%（強制封存缺件）');
  assert.equal(roundScoreText({ voided: true, score: null, status: 'calculation_failed' }), '本題作廢（計分失敗）');
  assert.equal(roundScoreText(null), '—');
  assert.match(multiplayerRulesText(RULES_VERSION), /同分依平均吻合度排序，相同則並列/);
  assert.match(multiplayerRulesText('circle-taiwan-0.5'), /總時間排序/);
});
