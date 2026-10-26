import assert from 'node:assert/strict';
import test from 'node:test';
import { MultiplayerHTTP } from '../public/multi-client.js';
import { RULES_VERSION } from '../shared/rules.js';

async function fixture(t, respond) {
  let wall = 1000, sequence = 0;
  const timers = new Map(), requests = [], events = [], serverOffset = 500000;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, at: wall + delay }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const manifest = { dataVersion: 'data', rulesVersion: RULES_VERSION, runtimeVersion: 'runtime' };
  const data = { bounds: [0, 0, 10, 10], regions: ['a', 'b'].map(id => ({ id, name: id, level: 'county', bounds: [0, 0, 10, 10] })) };
  const packet = {
    summary: { room: 'room', game: 'game', round: 'round-a', phase: 'reveal', index: 0, start: 500000, deadline: 511000, nextAt: 511000, expires: 2301000, now: 501000, version: 1, metadata: 1, plan: 1, host: 0, you: 1, players: [[0, 1, 1, 0, 'ok'], [1, 1, 1, 0, 'ok']] },
    details: { code: 'ABCD23', settings: { challenge: 'county', scope: 'mainland', difficulty: 'easy', count: 3, seconds: 20 }, questions: ['a', 'b'], versions: manifest,
      players: [{ id: 'host', seat: 0, name: 'A' }, { id: 'guest', seat: 1, name: 'B' }], rounds: [{ id: 'round-a', index: 0, regionId: 'a', results: { host: { status: 'ok', score: 80, elapsed: 1000 }, guest: { status: 'ok', score: 90, elapsed: 1000 } } }], roundStandings: [], cumulativeStandings: [] }
  };
  const serverNow = () => wall + serverOffset;
  const snapshot = () => structuredClone({ ...packet, summary: { ...packet.summary, now: serverNow() } });
  const advanceRound = () => Object.assign(packet.summary, { phase: 'playing', round: 'round-b', index: 1, version: 2, metadata: 2, start: serverNow() + 6000, deadline: serverNow() + 26000, nextAt: null, players: [[0, 1, 1, 0, null], [1, 1, 1, 0, null]] });
  const client = new MultiplayerHTTP({ manifest, data, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, storage: { getItem() { return null; }, removeItem() {} },
    fetch: async (url, options) => {
      const input = options.body ? JSON.parse(options.body) : null;
      requests.push({ method: options.method, input });
      const response = await respond?.({ input, packet, requests, serverNow, advanceRound });
      return response || Response.json(snapshot());
    } });
  client.onmessage = event => events.push(JSON.parse(event.data));
  await Promise.resolve();
  client.session = { code: 'ABCD23', token: 'token', id: 'guest' };
  client.apply(snapshot());
  t.after(() => client.close());
  async function advance(milliseconds) {
    const target = wall + milliseconds;
    for (;;) {
      const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry || entry[1].at > target) break;
      assert.ok(entry[1].at >= wall, 'a timer must not move time backwards');
      wall = entry[1].at; timers.delete(entry[0]);
      await entry[1].fn();
    }
    wall = target;
  }
  return { client, packet, requests, events, timers, advance, snapshot, advanceRound };
}

test('多人共用伺服器時鐘；重用單一輪詢 timer 到期換題', async t => {
  const f = await fixture(t, ({ input, serverNow, packet, advanceRound }) => {
    if (input?.type === 'next') { assert.equal(serverNow(), packet.summary.nextAt); advanceRound(); }
  });
  assert.equal(f.client.state.question.nextAt, 511000);
  assert.equal(f.timers.size, 1);
  await f.advance(9999);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'GET']);
  assert.equal(f.timers.size, 1);
  await f.advance(1);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'GET', 'POST']);
  assert.equal(f.requests.at(-1).input.questionId, 'round-a');
  assert.equal(f.client.summary.round, 'round-b');
  assert.equal(f.client.state.question.nextAt, null);
  assert.equal(f.timers.size, 1);
  const stale = f.snapshot(); stale.summary.version = 1; stale.summary.round = 'round-a';
  f.client.apply(stale);
  assert.equal(f.client.summary.round, 'round-b');
});

test('自動換題遇到競爭先同步；暫時失敗退避，不形成零延遲迴圈', async t => {
  let attempts = 0;
  const f = await fixture(t, ({ input, advanceRound }) => {
    if (input?.type !== 'next') return;
    if (++attempts === 1) return Response.json({ error: 'unavailable', message: '暫時無法連線' }, { status: 503 });
    advanceRound();
    return Response.json({ error: 'round_changed', message: '回合已更新' }, { status: 409 });
  });
  await f.advance(10000);
  assert.equal(attempts, 1); assert.equal(f.timers.size, 1);
  await f.advance(4499); assert.equal(attempts, 1);
  await f.advance(1);
  assert.equal(attempts, 2); assert.equal(f.client.summary.round, 'round-b');
  assert.equal(f.requests.at(-1).method, 'GET');
  assert.equal(f.events.filter(e => e.type === 'error').length, 1);
});

test('背景暫停；回到前景先同步，離開後不再換題', async t => {
  const f = await fixture(t);
  f.client.setHidden(true);
  assert.equal(f.timers.size, 0);
  await f.advance(20000);
  assert.equal(f.requests.length, 0);
  f.advanceRound();
  f.client.setHidden(false);
  await new Promise(setImmediate);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
  assert.equal(f.client.summary.round, 'round-b');
  assert.equal(f.timers.size, 1);
  f.client.close();
  await f.advance(60000);
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test('舊局沒有 nextAt 時不自動換題；非房主返回大廳只做一次 GET', async t => {
  const f = await fixture(t);
  delete f.packet.summary.nextAt;
  f.client.apply(f.snapshot());
  await f.advance(15000);
  assert.ok(f.requests.every(r => r.method === 'GET'));
  Object.assign(f.packet.summary, { phase: 'results', round: null, deadline: null, version: 2, metadata: 2 });
  f.client.apply(f.snapshot());
  assert.equal(f.timers.size, 0);
  const before = f.requests.length;
  await f.client.send(JSON.stringify({ type: 'replay' }));
  assert.equal(f.requests.length, before + 1); assert.equal(f.requests.at(-1).method, 'GET');
  assert.equal(f.client.summary.phase, 'results'); assert.equal(f.timers.size, 0);
  assert.equal(f.events.at(-1).type, 'info');
  Object.assign(f.packet.summary, { phase: 'lobby', game: null, version: 3, metadata: 3, plan: 2 });
  await f.client.send(JSON.stringify({ type: 'replay' }));
  assert.equal(f.requests.length, before + 2); assert.equal(f.requests.at(-1).method, 'GET');
  assert.equal(f.client.summary.phase, 'lobby'); assert.equal(f.client.final, false); assert.equal(f.timers.size, 1);
});
