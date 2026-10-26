import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { readTourismRecords, decodeTourismSource, prepareLandmarks, writeLandmarks } from '../scripts/prepare-landmarks.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/landmarks-tourism.json', import.meta.url)));
const { projection } = JSON.parse(await readFile(new URL('../data/manifest.json', import.meta.url)));
const context = { projection, bounds: [150000, 2400000, 350000, 2900000], counties: ['63000', '67000'] };
const selection = fixture.Attractions.map((record, index) => ({
  id: index ? 'lm-chimei' : 'lm-taipei-101', recordId: record.AttractionID, name: record.AttractionName,
  county: record.PostalAddress.CityCode, anchorLabel: '來源代表點（測試）', reviewedAt: '2026-10-26'
}));
const version = 'landmarks-2026-10-26-01';
const prepare = (records = fixture.Attractions, choices = selection, info = fixture._source, map = context, tag = version) =>
  prepareLandmarks(records, choices, info, map, tag);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

test('觀光署 adapter：實際 Attractions 結構、ZIP 篩選與錯誤來源', () => {
  assert.deepEqual(readTourismRecords(fixture), fixture.Attractions);
  const json = bytesOf(fixture);
  assert.deepEqual(decodeTourismSource(json), fixture.Attractions);
  assert.deepEqual(decodeTourismSource(zipSync({ 'AttractionList.json': json, 'AttractionFeeList.json': Buffer.from('unrelated') }), true), fixture.Attractions);
  for (const payload of [[], {}, { Attractions: [] }, { Attractions: null }]) assert.throws(() => readTourismRecords(payload));
  for (const bytes of [Buffer.alloc(0), Buffer.from('{'), Buffer.from([0xff])]) assert.throws(() => decodeTourismSource(bytes));
  assert.throws(() => decodeTourismSource(zipSync({ 'wrong.json': json }), true), /AttractionList/);
});

test('轉檔：穩定排序、保留來源與原始座標；兩份 Schema 可解析', async () => {
  const before = structuredClone({ fixture, selection }), result = prepare();
  assert.deepEqual(result.landmarks.map(item => item.id), ['lm-chimei', 'lm-taipei-101']);
  assert.equal(result.crs, 'EPSG:3826');
  assert.equal(result.projection, projection);
  for (const item of result.landmarks) {
    const record = fixture.Attractions.find(row => row.AttractionID === item.source.recordId);
    assert.deepEqual(item.wgs84, [record.PositionLon, record.PositionLat]);
    assert.ok(item.point.every(Number.isFinite));
    assert.equal(item.source.snapshotSha256, fixture._source.sourceSha256);
    assert.equal(item.source.updatedAt, record.UpdateTime);
    assert.equal(item.source.licenseUrl, 'https://data.gov.tw/license');
  }
  assert.deepEqual({ fixture, selection }, before);
  const sourceSchema = JSON.parse(await readFile(new URL('../data/landmarks-source.schema.json', import.meta.url)));
  const schema = JSON.parse(await readFile(new URL('../data/landmarks.schema.json', import.meta.url)));
  for (const record of fixture.Attractions) for (const key of sourceSchema.required) assert.ok(Object.hasOwn(record, key));
  assert.deepEqual(Object.keys(result).sort(), schema.required.toSorted());
  for (const item of result.landmarks) assert.deepEqual(Object.keys(item).sort(), schema.$defs.landmark.required.toSorted());
});

test('投影：中央經線赤道控制點及湖泊點不作陸地裁切', () => {
  const record = { ...fixture.Attractions[0], PositionLon: 121, PositionLat: 0 };
  const [item] = prepare([record], [selection[0]], fixture._source, { ...context, bounds: [200000, -10, 300000, 10] }).landmarks;
  assert.ok(Math.abs(item.point[0] - 250000) < 0.01);
  assert.ok(Math.abs(item.point[1]) < 0.01);
  // This tests coordinate acceptance only; it does not approve a real lake question or its anchor.
  const lake = { ...record, PositionLon: 120.917, PositionLat: 23.85, PostalAddress: { CityCode: '10008' } };
  assert.equal(prepare([lake], [{ ...selection[0], county: '10008' }], fixture._source, { ...context, counties: ['10008'] }).landmarks.length, 1);
});

test('選中資料驗證：缺欄位、錯誤數值、經緯度對調及縣市／範圍錯誤', () => {
  const record = fixture.Attractions[0], choice = [selection[0]];
  for (const PositionLon of [null, '', '121.5', true, NaN, Infinity, -181, 181]) {
    assert.throws(() => prepare([{ ...record, PositionLon }], choice), /經緯度/);
  }
  for (const PositionLat of [null, '', '25', false, NaN, Infinity, -91, 91]) {
    assert.throws(() => prepare([{ ...record, PositionLat }], choice), /經緯度/);
  }
  const missing = { ...record }; delete missing.PositionLat;
  assert.throws(() => prepare([missing], choice), /經緯度/);
  assert.throws(() => prepare([{ ...record, AttractionName: ' ' }], choice), /名稱/);
  assert.throws(() => prepare([{ ...record, PositionLon: record.PositionLat, PositionLat: record.PositionLon }], choice), /經緯度/);
  assert.throws(() => prepare([{ ...record, PositionLon: 0, PositionLat: 0 }], choice), /範圍/);
  assert.throws(() => prepare([record], [{ ...choice[0], county: '67000' }]), /縣市與選題不符/);
  assert.throws(() => prepare([record], [{ ...choice[0], county: '09020' }]), /縣市不存在/);
  assert.throws(() => prepare([{ ...record, UpdateTime: null }], choice), /更新時間/);
  assert.equal(prepare([record, { AttractionID: 'not-selected', PositionLon: null }], choice).landmarks.length, 1);
});

test('選題與追溯：重複 ID、缺題、無效日期、版本及來源資訊明確失敗', () => {
  assert.throws(() => prepare([], selection), /缺題/);
  assert.throws(() => prepare([...fixture.Attractions, fixture.Attractions[0]]), /紀錄重複/);
  assert.throws(() => prepare(undefined, [selection[0], selection[0]]), /景點 ID 重複/);
  assert.throws(() => prepare(undefined, [selection[0], { ...selection[0], id: 'lm-another' }]), /來源 ID/);
  for (const change of [{ id: 'bad' }, { name: '' }, { anchorLabel: ' ' }, { reviewedAt: '2026-02-30' }]) {
    assert.throws(() => prepare(undefined, [{ ...selection[0], ...change }]));
  }
  for (const choices of [[], Array(1001).fill(selection[0])]) assert.throws(() => prepare(undefined, choices), /1～1000/);
  for (const tag of ['bad', 'landmarks-2026-02-30-01']) assert.throws(() => prepare(undefined, undefined, undefined, undefined, tag));
  for (const change of [{ sourceSha256: '' }, { sourceUrl: 'file:///local' }, { retrievedAt: '2026-10-26' }, { retrievedAt: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => prepare(undefined, undefined, { ...fixture._source, ...change }));
  }
});

test('產檔：輸入一致可重建；座標改變更新雜湊；失敗不覆寫已產出版本', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'circle-landmarks-'));
  t.after(async () => {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    await rm(temp, { recursive: true, force: true });
  });
  const catalog = prepare(), manifest = { version, count: 2, outputSha256: sha(bytesOf(catalog)) };
  assert.deepEqual(prepare(), catalog);
  assert.deepEqual(prepare(fixture.Attractions.toReversed(), selection.toReversed()), catalog);
  const changed = structuredClone(fixture.Attractions); changed[0].PositionLon += 0.001;
  assert.notEqual(sha(bytesOf(prepare(changed))), manifest.outputSha256);
  const first = join(temp, 'first'), second = join(temp, 'second');
  await writeLandmarks(catalog, manifest, first);
  await writeLandmarks(catalog, manifest, second);
  assert.deepEqual(await readdir(first), ['landmarks-manifest.json', 'landmarks.json']);
  for (const file of await readdir(first)) assert.deepEqual(await readFile(join(first, file)), await readFile(join(second, file)));
  await assert.rejects(writeLandmarks(catalog, manifest, first), { code: 'EEXIST' });
  await assert.rejects(writeLandmarks(catalog, { ...manifest, outputSha256: 'wrong' }, join(temp, 'bad')), /雜湊/);
  assert.equal(sha(await readFile(join(first, 'landmarks.json'))), manifest.outputSha256);
  assert.deepEqual((await readdir(temp)).sort(), ['first', 'second']);
});
