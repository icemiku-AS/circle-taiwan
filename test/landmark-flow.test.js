import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import clipping from 'polygon-clipping';
import { area, createScoring, locatePointInGeometry, landmarkRulesForSettings } from '../shared/scoring.js';
import { questionPool } from '../shared/rules.js';
import { loadCatalog } from '../server/catalog.js';
import { buildFreeLocal } from '../scripts/build-cloudflare.js';
import { createSoloRecord, selectQuestions, SoloGame } from '../public/solo-game.js';
import { SoloAssets } from '../public/solo-assets.js';
import { SoloEngine } from '../public/solo-engine.js';
import { comparisonBounds, landmarkDetails, landmarkFeedback, landmarkSummary, questionName, challengeScope, roundScoreText, scoreText } from '../public/share.js';

const read = path => readFile(new URL('../' + path, import.meta.url));
const json = async path => JSON.parse(await read(path));
const sha = value => createHash('sha256').update(value).digest('hex');
const catalog = loadCatalog(), data = catalog.publicData();
const { prepareLandmarkScorer } = createScoring(clipping);
const square = ([x, y], radius = 100) => [[x - radius, y - radius], [x + radius, y - radius], [x + radius, y + radius], [x - radius, y + radius]];

test('正式題庫：本島 5554 題、經典 100 題與縣市各 20 題，來源版本一致', async () => {
  const landmarks = await json('data/landmarks.json'), manifest = await json('data/landmarks-manifest.json');
  const bytes = await read('data/landmarks-source.zip'), info = await json('data/landmarks-source-info.json');
  const selection = await json('data/landmarks-selection.json');
  assert.equal(sha(bytes), info.sourceSha256);
  assert.equal(sha(await read('data/landmarks-selection.json')), manifest.selectionSha256);
  assert.equal(sha(await read('scripts/prepare-landmarks.js')), manifest.scriptSha256);
  assert.equal(sha(await read('data/landmarks.json')), manifest.outputSha256);
  assert.equal(landmarks.landmarks.length, 5554);
  assert.equal(new Set(landmarks.landmarks.map(r => r.id)).size, 5554);
  assert.equal(new Set(landmarks.landmarks.map(r => r.county)).size, 19);
  const classic = landmarks.landmarks.filter(r => r.classicMainland);
  assert.equal(classic.length, 100);
  assert.deepEqual(classic.map(r => r.id).sort(), selection.map(r => r.id).sort());
  for (const county of data.regions.filter(r => r.level === 'county')) {
    assert.equal(landmarks.landmarks.filter(r => r.county === county.id && r.classicCounty).length, 20);
    assert.equal(county.areaM2, area(catalog.byId.get(county.id).geometry));
  }
  const mainland = [data.land.reduce((a, b) => area([a]) > area([b]) ? a : b)];
  for (const item of classic) {
    assert.ok(!['09007', '09020', '10016'].includes(item.county), item.id);
    assert.notEqual(locatePointInGeometry(item.point, mainland).relation, 'outside', item.id);
    assert.notEqual(locatePointInGeometry(item.point, catalog.byId.get(item.county).geometry).relation, 'outside', item.id);
    assert.ok(item.anchorLabel && item.reviewedAt);
  }
});

test('設定與題庫：Scope／Pool／Difficulty 獨立，單人多人與行政區相容', () => {
  for (const difficulty of ['easy', 'hard']) for (const mode of ['single', 'multi']) for (const scope of ['mainland', 'county']) for (const pool of ['classic', 'all']) {
    const { settings, questions } = selectQuestions(data, { challenge: 'landmark', difficulty, pool, count: 5, scope, county: '65000', town: 'old' }, () => .5, mode);
    assert.equal(settings.difficulty, difficulty);
    assert.deepEqual([settings.scope, settings.county, settings.town], [scope, scope === 'county' ? '65000' : '', '']);
    assert.equal(questionPool(settings, data.regions).length, scope === 'county' ? pool === 'all' ? 650 : 20 : pool === 'all' ? 5554 : 100);
    assert.equal(questions.length, 5);
    assert.equal(new Set(questions).size, 5);
    assert.ok(questions.every(id => catalog.byId.get(id).kind === 'landmark'));
    if (scope === 'county') assert.ok(questions.every(id => catalog.byId.get(id).county === '65000'));
  }
  for (const r of questionPool({ challenge: 'landmark' }, data.regions)) {
    assert.equal(r.point, undefined); assert.equal(r.geometry, undefined);
  }
  assert.equal(questionPool({ challenge: 'county' }, data.regions).length, 19);
  const town = data.regions.find(r => r.level === 'town');
  for (const settings of [{ challenge: 'town', scope: 'county', county: town.county }, { challenge: 'village', county: town.county, town: town.id }]) {
    const selected = selectQuestions(data, settings);
    assert.ok(selected.questions.every(id => catalog.byId.get(id).level === settings.challenge));
  }
});

test('Worker 初始化：縣市規則固定，重啟後不退回全島尺度', async t => {
  const previous = globalThis.Worker, sent = [];
  t.after(() => { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; });
  globalThis.Worker = class {
    postMessage(message) { sent.push(structuredClone(message)); queueMicrotask(() => this.onmessage({ data: { id: message.id, value: true } })); }
    terminate() {}
  };
  const settings = { challenge: 'landmark', scope: 'county', county: '10020' }, areaM2 = data.regions.find(r => r.id === settings.county).areaM2;
  const rules = landmarkRulesForSettings(settings, areaM2), engine = new SoloEngine({ runtimeVersion: 'test' }, data, ['lm-test'], rules);
  t.after(() => engine.close());
  await engine.ready(); engine.close(); rules.maxAreaM2 = 1;
  await engine.ready();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].landmarkRules.maxAreaM2, areaM2);
  assert.deepEqual(sent[1].landmarkRules, sent[0].landmarkRules);
});

test('全量抽題：保留來源紀錄但同局不重複同縣同名景點', () => {
  const region = data.regions.find(r => r.level === 'landmark');
  const sample = { ...data, regions: [...data.regions.filter(r => r.level === 'county'),
    ...Array.from({ length: 12 }, (_, i) => ({ ...region, id: `lm-sample-${i}`, officialName: `景點${Math.floor(i / 2)}` }))] };
  const { questions } = selectQuestions(sample, { challenge: 'landmark', pool: 'all', count: 5 }, () => .9);
  assert.equal(questions.length, 5);
  assert.equal(new Set(questions.map(id => sample.regions.find(r => r.id === id).officialName)).size, 5);
});

test('景點結算：低分命中也計入，跳過列分母，作廢排除；文案與設定一致', () => {
  const round = (score, hit, status = 'valid') => ({ results: { solo: { score, status, landmark: { hit } } } });
  const history = [round(10, true), round(0, false), round(0, null, 'skipped'), { ...round(100, true), voided: true }, round(null, null, 'calculation_failed')];
  assert.equal(landmarkSummary(history, 'solo'), '🎯 命中率：1 / 3 題（33%）');
  assert.equal(landmarkSummary([], 'solo'), '🎯 命中率：0 / 0 題（—）');
  assert.equal(questionName({ name: '舊題名', officialName: '台北101', anchorLabel: '主塔' }), '台北101（主塔）');
  assert.equal(questionName({ name: '臺北市' }), '臺北市');
  assert.equal(landmarkFeedback({ status: 'valid', score: 10, landmark: { hit: true, areaM2: 59721560 } }), '🟢 10.00 分 · 命中！（圈選面積 59.7 km²）');
  assert.equal(landmarkFeedback({ status: 'valid', score: 0, landmark: { hit: false, outsideDistanceM: 900 } }), '🔴 0 分 · 未命中（離景點最近 0.9 km）');
  assert.equal(landmarkFeedback({ status: 'skipped' }), '已跳過 · 0 分');
  assert.equal(challengeScope(data, { challenge: 'landmark', scope: 'county', county: '65000', pool: 'all' }), '景點挑戰 · 新北市 · 全部題庫');
});

function solo() {
  const { settings, questions } = selectQuestions(data, { challenge: 'landmark' }, () => .5);
  let time = 1000, failure = false;
  const engine = { close() {}, prepare: async () => {}, score: async (id, points) => {
    if (failure) throw new Error('simulated worker failure');
    const targetPoint = catalog.byId.get(id).point, { answer, ...result } = prepareLandmarkScorer(targetPoint)(points);
    return { result, answer, target: [], targetPoint, neutral: [] };
  } };
  const game = new SoloGame(createSoloRecord(settings, questions, '測試', time), { data, engine, now: () => time });
  return { game, fail: value => { failure = value; }, tick: () => { time += 1000; } };
}

test('單人：命中／未命中／跳過、揭曉與結算皆保留景點資料', async () => {
  const { game, tick } = solo();
  for (let i = 0; i < 5; i++) {
    const q = game.current, point = catalog.byId.get(q.regionId).point;
    if (i < 2) game.draft(square(i ? [point[0] + 1000, point[1]] : point));
    tick(); await game.submit(q.id, i >= 2);
    assert.equal(game.record.phase, 'reveal-scores');
    const review = await game.review(q.id);
    assert.deepEqual(review.targetPoint, point);
    assert.ok(Array.isArray(review.answer));
    assert.equal(q.result.score, i ? 0 : 100);
    assert.equal(q.result.status, i >= 2 ? 'skipped' : 'valid');
    if (i < 2) {
      assert.equal(q.result.landmark.hit, !i);
      assert.equal(q.result.landmark.areaM2, 40000);
      assert.equal(q.result.landmark.outsideDistanceM, i ? 900 : 0);
    }
    game.next(q.id);
  }
  assert.equal(game.view().phase, 'results');
  assert.equal(game.view().standings[0].score, 20);
  assert.equal(game.view().history.length, 5);
  game.stop();
});

test('單人：無效筆畫可重畫，Worker 失敗不記零分且重試保留提交時間', async () => {
  const { game, tick, fail } = solo(), q = game.current, point = catalog.byId.get(q.regionId).point;
  game.draft([point, [point[0] + 1, point[1]], [point[0] + 2, point[1]]]);
  tick(); await game.submit(q.id);
  assert.equal(game.record.phase, 'answering'); assert.equal(q.result, null);
  game.draft(square(point)); const original = structuredClone(q.points);
  fail(true); tick(); await game.submit(q.id);
  assert.equal(game.record.phase, 'error'); assert.equal(q.result, null);
  const submittedAt = q.submittedAt;
  fail(false); tick(); await game.retry();
  assert.equal(game.record.phase, 'reveal-scores'); assert.equal(q.result.score, 100);
  assert.equal(q.submittedAt, submittedAt); assert.deepEqual(q.points, original);
  game.stop();
});

test('揭曉與分享：景點顯示分數、完整面積與最近距離，行政區仍顯示百分比', () => {
  assert.equal(scoreText(75, 'landmark'), '75.00 分'); assert.equal(scoreText(75), '75.00%');
  assert.match(roundScoreText({ points: 1, score: 10, status: 'ok' }, 'landmark'), /10.00 分/);
  assert.equal(landmarkDetails({ hit: false, areaM2: 40000, outsideDistanceM: 900 }), '未命中 · 距離 0.90 km · 圈選 0.04 km²');
  assert.equal(landmarkDetails({ hit: null }), '無有效圈選');
  const box = comparisonBounds([], square([0, 0], 10), [1000, 2000]);
  assert.ok(box[0] < -10 && box[1] < -10 && box[2] > 1000 && box[3] > 2000);
});

test('縣市線索：只讀靜態縣市包、共用快取，下載失敗仍可重試', async t => {
  const geometry = [[square([250000, 2700000])]], decoded = Buffer.from(JSON.stringify([{ geometry }])), bytes = gzipSync(decoded);
  const assets = new SoloAssets({ answerPacks: { county: { url: '/assets/blobs/counties.bin', sha256: sha(bytes), decodedBytes: decoded.length } } });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, '/assets/blobs/counties.bin');
    return new Response(++requests === 1 ? '' : bytes, { status: requests === 1 ? 503 : 200 });
  });
  await assert.rejects(assets.countyBoundaries(), /載入失敗/);
  const [a, b] = await Promise.all([assets.countyBoundaries(), assets.countyBoundaries()]);
  assert.deepEqual(a, geometry); assert.equal(a, b); assert.equal(requests, 2);
});

test('打包：景點獨立答案包；Cloudflare 僅入口、收件 API、規則', { timeout: 60000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'circle-landmark-build-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  // buildFreeLocal asserts the exact API dependency allowlist.
  const built = await buildFreeLocal(out), manifest = JSON.parse(await readFile(join(built.client, 'assets/current.json')));
  const unpack = async asset => JSON.parse(gunzipSync(await readFile(join(built.client, asset.url))));
  const points = await unpack(manifest.answerPacks.landmark), counties = await unpack(manifest.answerPacks.county);
  assert.equal(points.length, 5554);
  for (const r of points) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'kind', 'point']);
    assert.equal(r.kind, 'landmark'); assert.equal(manifest.regionPacks[r.id], 'landmark');
    assert.deepEqual(r.point, catalog.byId.get(r.id).point);
  }
  assert.equal(counties.length, 19); assert.ok(counties.every(r => r.geometry && !r.point));
  assert.ok(manifest.dataVersion.endsWith(catalog.manifest.landmarkVersion));
  const worker = await readFile(join(out, 'server.js'), 'utf8');
  assert.doesNotMatch(worker, /prepareLandmarkScorer|polygon-clipping|polyclip-ts|landmarkScoreForArea|AttractionID|lm-taipei-101/);
});
