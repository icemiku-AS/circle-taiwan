import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { SoloAssets } from '../public/solo-assets.js';
import { GameMap } from '../public/map.js';

const rectangle = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const countyA = [[rectangle(0, 0, 10, 10), rectangle(3, 3, 4, 4)]], countyB = [[rectangle(10, 0, 20, 10)]];
const townA = [[rectangle(0, 0, 5, 10)]], townB = [[rectangle(5, 0, 10, 10)]];

function fixture(t, failedKey = '') {
  const answerPacks = {}, bytesByUrl = new Map(), requests = [];
  for (const [key, records] of Object.entries({ county: [{ id: 'a', geometry: countyA }, { id: 'b', geometry: countyB }], 'town-a': [{ geometry: townA }, { geometry: townB }], 'town-b': [{ geometry: countyB }] })) {
    const decoded = Buffer.from(JSON.stringify(records)), bytes = gzipSync(decoded), url = `/assets/${key}.bin`;
    answerPacks[key] = { url, sha256: createHash('sha256').update(bytes).digest('hex'), decodedBytes: decoded.length };
    bytesByUrl.set(url, bytes);
  }
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    if (url === `/assets/${failedKey}.bin`) { failedKey = ''; return new Response('', { status: 503 }); }
    assert.ok(bytesByUrl.has(url), 'Only existing county/town static packs are requested');
    return new Response(bytesByUrl.get(url));
  });
  return { assets: new SoloAssets({ answerPacks }), requests };
}

test('景點邊界：四種範圍／難度只載入所需縣市與鄉鎮包', async t => {
  const { assets, requests } = fixture(t);
  assert.deepEqual(await assets.landmarkBoundaries({ scope: 'mainland', difficulty: 'hard' }), { scopeOutline: [], internalBoundaries: [] });
  assert.equal(requests.length, 0);
  const hard = await assets.landmarkBoundaries({ scope: 'county', county: 'a', difficulty: 'hard' });
  assert.deepEqual(hard, { scopeOutline: countyA, internalBoundaries: [] });
  assert.deepEqual(requests, ['/assets/county.bin']);
  const [easy, again] = await Promise.all(Array.from({ length: 2 }, () => assets.landmarkBoundaries({ scope: 'county', county: 'a', difficulty: 'easy' })));
  assert.equal(easy, again);
  assert.equal(easy.scopeOutline, hard.scopeOutline);
  assert.deepEqual(easy.internalBoundaries, [...townA, ...townB]);
  const mainland = await assets.landmarkBoundaries({ scope: 'mainland', difficulty: 'easy' });
  assert.deepEqual(mainland, { scopeOutline: [], internalBoundaries: [...countyA, ...countyB] });
  assert.equal(mainland.internalBoundaries, await assets.countyBoundaries());
  assert.deepEqual(requests, ['/assets/county.bin', '/assets/town-a.bin']);
  assert.deepEqual((await assets.landmarkBoundaries({ scope: 'county', county: 'b', difficulty: 'hard' })).scopeOutline, countyB);
});

test('景點邊界：失敗後可重試，縣市與難度快取互不污染', async t => {
  const { assets, requests } = fixture(t, 'town-a');
  const settings = { scope: 'county', county: 'a', difficulty: 'easy' };
  await assert.rejects(assets.landmarkBoundaries(settings), /載入失敗/);
  const hard = await assets.landmarkBoundaries({ ...settings, difficulty: 'hard' });
  assert.deepEqual(hard.internalBoundaries, []);
  assert.deepEqual((await assets.landmarkBoundaries(settings)).internalBoundaries, [...townA, ...townB]);
  assert.deepEqual(requests, ['/assets/county.bin', '/assets/town-a.bin', '/assets/town-a.bin']);
  await assert.rejects(assets.landmarkBoundaries({ ...settings, county: 'unknown' }), /所選縣市邊界/);
  delete assets.manifest.answerPacks['town-b'];
  await assert.rejects(assets.landmarkBoundaries({ ...settings, county: 'b' }), /範圍邊界資料不完整/);
});

test('景點邊界：切換縣市只保留最近一份鄉鎮細節，仍共用縣市外框', async t => {
  const { assets, requests } = fixture(t), settings = { scope: 'county', county: 'a', difficulty: 'easy' };
  const [original, next] = await Promise.all([assets.landmarkBoundaries(settings), assets.landmarkBoundaries({ ...settings, county: 'b' })]);
  assert.deepEqual(next.internalBoundaries, countyB);
  const reloaded = await assets.landmarkBoundaries(settings);
  assert.equal(reloaded.scopeOutline, original.scopeOutline);
  assert.deepEqual(reloaded.internalBoundaries, original.internalBoundaries);
  assert.deepEqual(requests, ['/assets/county.bin', '/assets/town-a.bin', '/assets/town-b.bin', '/assets/town-a.bin']);
});

test('範圍背景：保留洞邊界、重用筆畫背景，切換縣市／資料會重繪', () => {
  const context = {
    fills: 0, strokes: [], path: [],
    setTransform() {}, fillRect() { this.fills++; }, fill() {},
    beginPath() { this.path = []; }, moveTo(x, y) { this.path.push(['M', x, y]); }, lineTo() {}, closePath() {},
    stroke() { this.strokes.push(this.path.slice()); }
  };
  const map = Object.assign(Object.create(GameMap.prototype), {
    view: { x: 10, y: 5, scale: 1 }, dpr: 1, width: 100, height: 100, canvas: { width: 100, height: 100 },
    background: { width: 0, height: 0, getContext: () => context },
    data: { bounds: [0, 0, 20, 10], land: [...countyA, ...countyB] }, scopeOutline: countyA, internalBoundaries: [...townA, ...townB]
  });
  map.paintBase();
  assert.deepEqual(context.strokes.at(-1), [['M', 0, 0], ['M', 3, 3]], 'Scope outline includes the county hole');
  const count = context.fills;
  map.points = rectangle(1, 1, 2, 2); map.paintBase();
  assert.equal(context.fills, count, 'Drawing reuses the background');
  map.internalBoundaries = []; map.paintBase();
  assert.equal(context.fills, count + 1, 'Hard clears internal boundaries even at the same camera position');
  map.scopeOutline = countyB; map.paintBase();
  assert.deepEqual(context.strokes.at(-1), [['M', 10, 0]]);
  map.data = { ...map.data, land: countyB }; map.paintBase();
  assert.equal(context.fills, count + 3, 'A new dataset invalidates the background');
});
