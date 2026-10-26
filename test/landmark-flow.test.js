import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import clipping from 'polygon-clipping';
import { area, createScoring, locatePointInGeometry } from '../shared/scoring.js';
import { questionPool } from '../shared/rules.js';
import { loadCatalog } from '../server/catalog.js';
import { decodeTourismSource, prepareLandmarks } from '../scripts/prepare-landmarks.js';
import { buildFreeLocal } from '../scripts/build-cloudflare.js';
import { createSoloRecord, selectQuestions, SoloGame } from '../public/solo-game.js';
import { SoloAssets } from '../public/solo-assets.js';
import { comparisonBounds, landmarkDetails, roundScoreText, scoreText } from '../public/share.js';

const read = path => readFile(new URL('../' + path, import.meta.url));
const json = async path => JSON.parse(await read(path));
const sha = value => createHash('sha256').update(value).digest('hex');
const catalog = loadCatalog(), data = catalog.publicData();
const { prepareLandmarkScorer } = createScoring(clipping);
const square = ([x, y], radius = 100) => [[x - radius, y - radius], [x + radius, y - radius], [x + radius, y + radius], [x - radius, y + radius]];

test('正式題庫：本島 19 縣市共 100 題、來源與轉檔可重現', async () => {
  const landmarks = await json('data/landmarks.json'), manifest = await json('data/landmarks-manifest.json');
  const bytes = await read('data/landmarks-source.zip'), info = await json('data/landmarks-source-info.json');
  const records = decodeTourismSource(bytes, true), selection = await json('data/landmarks-selection.json');
  const counties = data.regions.filter(r => r.level === 'county').map(r => r.id);
  assert.equal(sha(bytes), info.sourceSha256);
  assert.equal(sha(await read('data/landmarks-selection.json')), manifest.selectionSha256);
  assert.equal(sha(await read('scripts/prepare-landmarks.js')), manifest.scriptSha256);
  assert.equal(sha(await read('data/landmarks.json')), manifest.outputSha256);
  assert.deepEqual(prepareLandmarks(records, selection, info, { projection: landmarks.projection, bounds: data.bounds, counties }, landmarks.version), landmarks);
  assert.equal(landmarks.landmarks.length, 100);
  assert.equal(new Set(landmarks.landmarks.map(r => r.id)).size, 100);
  assert.equal(new Set(landmarks.landmarks.map(r => r.county)).size, 19);
  const mainland = [data.land.reduce((a, b) => area([a]) > area([b]) ? a : b)];
  for (const item of landmarks.landmarks) {
    assert.ok(!['09007', '09020', '10016'].includes(item.county), item.id);
    assert.notEqual(locatePointInGeometry(item.point, mainland).relation, 'outside', item.id);
    assert.notEqual(locatePointInGeometry(item.point, catalog.byId.get(item.county).geometry).relation, 'outside', item.id);
    assert.ok(item.anchorLabel && item.reviewedAt);
  }
});

test('設定與題庫：景點 Easy/Hard、舊行政區選題，公開 metadata 不混入答案點', () => {
  for (const difficulty of ['easy', 'hard']) for (const mode of ['single', 'multi']) {
    const { settings, questions } = selectQuestions(data, { challenge: 'landmark', difficulty, count: 5, scope: 'county', county: '63000', town: 'old' }, () => .5, mode);
    assert.equal(settings.difficulty, difficulty);
    assert.deepEqual([settings.scope, settings.county, settings.town], ['mainland', '', '']);
    assert.equal(questions.length, 5);
    assert.equal(new Set(questions).size, 5);
    assert.ok(questions.every(id => catalog.byId.get(id).kind === 'landmark'));
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
  assert.equal(points.length, 100);
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
