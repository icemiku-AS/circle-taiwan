import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { RULES_VERSION } from '../shared/rules.js';

test('房間 API：新版積分、固定開局人數、缺件、作廢與舊局版本', { timeout: 30000 }, async t => {
  const bundle = await build({ stdin: { contents: "import { createFreeWorker } from './server/free-rooms.js'; export default createFreeWorker();", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ script: bundle.outputFiles[0].text, modules: true, compatibilityDate: '2026-05-15', cf: false, port: 0, d1Databases: { DB: 'test-rooms' }, log: new Log(LogLevel.ERROR) });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const schema = await readFile(new URL('../server/free-schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const versions = { dataVersion: 'test-data', rulesVersion: RULES_VERSION, runtimeVersion: 'test-runtime' };
  const settings = { challenge: 'county', difficulty: 'easy', scope: 'mainland', count: 3, seconds: 20, capacity: 8 };
  async function command(input, session, expectedStatus = 200) {
    const response = await mf.dispatchFetch('http://localhost/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: JSON.stringify({ requestId: crypto.randomUUID(), code: session?.code, ...input }) });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value;
  }
  const plan = { type: 'create', nickname: 'A', settings, questions: ['county-a', 'county-b', 'county-c'], versions };
  const outdated = await command({ ...plan, versions: { ...versions, rulesVersion: 'circle-taiwan-0.5' } }, null, 409);
  assert.equal(outdated.error, 'version_mismatch');
  const created = await command(plan), players = [created.session];
  assert.equal(created.details.settings.pool, 'classic');
  for (const nickname of ['B', 'C', 'D']) players.push((await command({ type: 'join', code: created.details.code, nickname, versions })).session);
  for (const session of players) {
    await command({ type: 'loaded', revision: 1, versions }, session);
    await command({ type: 'ready', revision: 1, ready: true }, session);
  }
  await db.prepare('UPDATE rooms SET versions=? WHERE id=?').bind(JSON.stringify({ ...versions, rulesVersion: 'circle-taiwan-0.5' }), created.summary.room).run();
  assert.equal((await command({ type: 'start', revision: 1 }, players[0], 409)).error, 'version_mismatch');
  await db.prepare('UPDATE rooms SET versions=? WHERE id=?').bind(JSON.stringify(versions), created.summary.room).run();
  let state = await command({ type: 'start', revision: 1 }, players[0]);
  const roomId = state.summary.room;
  async function allowAnswers() { await db.prepare('UPDATE rooms SET start_at=? WHERE id=?').bind(Date.now() - 1000, roomId).run(); }
  async function submit(index, score, status = 'ok') {
    state = await command({ type: 'submit', gameId: state.summary.game, questionId: state.summary.round,
      answer: { submissionId: crypto.randomUUID(), status, score, elapsed: (index + 1) * 1000, points: status === 'ok' ? [[0, 0], [1, 0], [0, 1]] : [] } }, players[index]);
  }
  async function forceSettle() {
    await db.prepare('UPDATE rooms SET deadline=? WHERE id=?').bind(Date.now() - 11000, roomId).run();
    state = await command({ type: 'force-settle', gameId: state.summary.game, questionId: state.summary.round }, players[0]);
  }
  async function next() { state = await command({ type: 'next', gameId: state.summary.game, questionId: state.summary.round }, players[0]); }
  await allowAnswers();
  for (const [index, score] of [95, 95, 92, 0].entries()) await submit(index, score, index === 3 ? 'invalid' : 'ok');
  assert.equal(state.summary.phase, 'reveal');
  assert.deepEqual(state.details.roundStandings.map(p => [p.points, p.rank]), [[10, 1], [10, 1], [5, 3], [0, 4]]);
  const firstPoints = state.details.cumulativeStandings.map(p => [p.id, p.points]);
  await command({ type: 'leave' }, players[3]);
  state = await command({ type: 'resume' }, players[0]);
  assert.equal(state.details.players.length, 4);
  assert.deepEqual(state.details.cumulativeStandings.map(p => [p.id, p.points]), firstPoints);
  await next(); await allowAnswers();
  await submit(0, 100); await submit(1, null, 'calculation_failed'); await submit(2, 92); await forceSettle();
  assert.ok(state.details.roundStandings.every(p => p.points === 0 && p.rank === null));
  assert.deepEqual(state.details.cumulativeStandings.map(p => [p.id, p.points]), firstPoints);
  await next(); await allowAnswers();
  await submit(0, 5); await submit(1, 5); await submit(2, 0, 'unanswered'); await forceSettle();
  assert.ok(state.details.roundStandings.every(p => p.points === 0));
  await next();
  assert.equal(state.summary.phase, 'results');
  assert.deepEqual(state.details.cumulativeStandings.map(p => [p.points, p.rank, p.validRounds]), [[10, 1, 2], [10, 1, 2], [5, 3, 2], [0, 4, 2]]);
  for (const p of state.details.cumulativeStandings) assert.equal(p.points, p.perQuestion.reduce((sum, q) => sum + q.points, 0));
  // Reuse sealed answers to model a room created before the rule upgrade.
  await db.prepare('UPDATE rooms SET versions=?,metadata_version=metadata_version+1 WHERE id=?').bind(JSON.stringify({ ...versions, rulesVersion: 'circle-taiwan-0.5' }), roomId).run();
  const legacy = await command({ type: 'resume' }, players[0]);
  assert.deepEqual(legacy.details.cumulativeStandings.map(p => [p.points, p.rank]), [[1, 1], [1, 2], [1, 3], [0, 4]]);
  for (const input of [{ pool: 'unknown' }, { scope: 'town' }, { scope: 'county', county: '' }, { scope: 'county', county: 63000 }]) {
    await command({ ...plan, settings: { ...settings, challenge: 'landmark', ...input } }, null, 400);
  }
  for (const difficulty of ['easy', 'hard']) await t.test(`景點 ${difficulty}：範圍／題庫設定、既有收件、回執、揭曉、結算與重開`, async () => {
    const config = { ...settings, challenge: 'landmark', difficulty, count: 1, capacity: 2,
      scope: difficulty === 'easy' ? 'county' : 'mainland', county: difficulty === 'easy' ? '63000' : '', pool: difficulty === 'easy' ? 'classic' : 'all' };
    const host = await command({ ...plan, settings: config, questions: ['lm-taipei-101'] });
    assert.equal(host.details.settings.pool, config.pool); assert.equal(host.details.settings.scope, config.scope);
    assert.equal(host.details.settings.county, config.county);
    const guest = await command({ type: 'join', code: host.details.code, nickname: '景點 B', versions });
    for (const session of [host.session, guest.session]) {
      await command({ type: 'loaded', revision: 1, versions }, session);
      await command({ type: 'ready', revision: 1, ready: true }, session);
    }
    let current = await command({ type: 'start', revision: 1 }, host.session);
    await db.prepare('UPDATE rooms SET start_at=? WHERE id=?').bind(Date.now() - 1000, current.summary.room).run();
    const submit = { type: 'submit', gameId: current.summary.game, questionId: current.summary.round,
      answer: { submissionId: crypto.randomUUID(), status: 'ok', score: 10, elapsed: 1000, points: [[0, 0], [1, 0], [0, 1]] } };
    await command({ ...submit, answer: { ...submit.answer, score: 101 } }, host.session, 400);
    const first = await command(submit, host.session), repeated = await command(submit, host.session);
    assert.deepEqual(repeated.receipt, first.receipt);
    // API accepts the client's score; it does not look up POIs or recompute these coordinates.
    current = await command({ ...submit, answer: { ...submit.answer, submissionId: crypto.randomUUID(), score: 0 } }, guest.session);
    assert.equal(current.summary.phase, 'reveal');
    assert.deepEqual(current.details.roundStandings.map(p => [p.score, p.points]), [[10, 1], [0, 0]]);
    const drawings = await mf.dispatchFetch(`http://localhost/api/round?code=${host.details.code}&game=${current.summary.game}&question=${current.summary.round}`,
      { headers: { Authorization: `Bearer ${host.session.token}` } });
    assert.equal(drawings.status, 200); assert.equal((await drawings.json()).drawings.length, 2);
    current = await command({ type: 'next', gameId: current.summary.game, questionId: current.summary.round }, host.session);
    assert.equal(current.summary.phase, 'results');
    assert.deepEqual(current.details.cumulativeStandings.map(p => p.points), [1, 0]);
    current = await command({ type: 'replay', gameId: current.summary.game, settings: config, questions: ['lm-taipei-101'], versions }, host.session);
    assert.equal(current.summary.phase, 'lobby'); assert.equal(current.details.settings.difficulty, difficulty);
    assert.equal(current.details.settings.pool, config.pool); assert.equal(current.details.settings.county, config.county);
  });
});

test('房間自動換題：共用期限、原子推進、舊局與身分限制', { timeout: 30000 }, async t => {
  const bundle = await build({ stdin: { contents: "import { createFreeWorker } from './server/free-rooms.js'; export default { fetch(request, env, ctx) { const at = Number(request.headers.get('X-Test-Now')); return createFreeWorker({ now: () => at }).fetch(request, env, ctx); } };", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare({ script: bundle.outputFiles[0].text, modules: true, compatibilityDate: '2026-05-15', cf: false, port: 0, d1Databases: { DB: 'test-auto-next' }, log: new Log(LogLevel.ERROR) });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const schema = await readFile(new URL('../server/free-schema.sql', import.meta.url), 'utf8');
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  let at = 1800000000000;
  const versions = { dataVersion: 'test-data', rulesVersion: RULES_VERSION, runtimeVersion: 'test-runtime' };
  const settings = { challenge: 'county', difficulty: 'easy', scope: 'mainland', count: 3, seconds: 20, capacity: 3 };
  const plan = { settings, questions: ['a', 'b', 'c'], versions };
  async function request(input, session, expected = 200) {
    const response = await mf.dispatchFetch('http://localhost/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Now': String(at), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: JSON.stringify({ requestId: crypto.randomUUID(), code: session?.code, ...input }) });
    const value = await response.json();
    if (expected !== null) assert.equal(response.status, expected, JSON.stringify(value));
    return { status: response.status, ...value };
  }
  async function poll(session) {
    const response = await mf.dispatchFetch(`http://localhost/api/room?code=${session.code}`, { headers: { Authorization: `Bearer ${session.token}`, 'X-Test-Now': String(at) } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function start() {
    const created = await request({ type: 'create', nickname: 'A', ...plan }), players = [created.session];
    for (const nickname of ['B', 'C']) players.push((await request({ type: 'join', code: created.details.code, nickname, versions })).session);
    for (const session of players) {
      await request({ type: 'loaded', revision: 1, versions }, session);
      await request({ type: 'ready', revision: 1, ready: true }, session);
    }
    const state = await request({ type: 'start', revision: 1 }, players[0]);
    at = state.summary.start;
    return { state, players };
  }
  const next = state => ({ type: 'next', gameId: state.summary.game, questionId: state.summary.round });
  const submit = (state, status = 'ok') => ({ type: 'submit', gameId: state.summary.game, questionId: state.summary.round,
    answer: { submissionId: crypto.randomUUID(), status, score: status === 'ok' ? 80 : null, elapsed: 1000, points: [[0, 0], [1, 0], [0, 1]] } });
  async function reveal(state, players) {
    for (const player of players) state = await request(submit(state), player);
    return state;
  }

  await t.test('最後收件與強制結算寫入十秒期限；回執／輪詢不重設，作廢及最後一題皆能推進', async () => {
    let { state, players } = await start();
    const answerDeadline = state.summary.deadline;
    state = await request(submit(state), players[0]);
    state = await request(submit(state), players[1]);
    assert.equal(state.summary.nextAt, null); assert.equal(state.summary.deadline, answerDeadline);
    at += 1000;
    const lastAnswer = submit(state);
    state = await request(lastAnswer, players[2]);
    const revealed = state.summary;
    assert.equal(revealed.phase, 'reveal'); assert.equal(revealed.nextAt, at + 10000); assert.equal(revealed.deadline, revealed.nextAt);
    at += 3000;
    const repeated = await request(lastAnswer, players[2]), observed = await poll(players[0]);
    assert.deepEqual(repeated.receipt, state.receipt);
    for (const response of [repeated, observed]) {
      assert.equal(response.summary.nextAt, revealed.nextAt);
      assert.equal(response.summary.expires, revealed.expires);
      assert.equal(response.summary.version, revealed.version);
    }
    at = revealed.nextAt - 1;
    assert.equal((await request(next(state), players[1], 409)).error, 'reveal_active');
    const previous = next(state);
    state = await request({ ...previous, type: 'force-next' }, players[0]);
    assert.equal(state.summary.index, 1); assert.equal(state.summary.nextAt, null);
    assert.equal(state.summary.start, at + 6000); assert.equal(state.summary.deadline, at + 26000);
    assert.equal((await request(previous, players[1], 409)).error, 'round_changed');
    const strokes = await db.prepare('SELECT COUNT(*) AS count FROM room_answers WHERE room_id=? AND round_id=? AND points IS NOT NULL').bind(state.summary.room, previous.questionId).first();
    assert.equal(strokes.count, 0);
    at = state.summary.start;
    state = await request(submit(state, 'calculation_failed'), players[0]);
    state = await request(submit(state), players[1]);
    at = state.summary.deadline + 10000;
    state = await request({ ...next(state), type: 'force-settle' }, players[0]);
    assert.equal(state.summary.nextAt, at + 10000);
    assert.equal(state.details.rounds.at(-1).voided, true);
    assert.ok(state.details.roundStandings.every(p => p.points === 0));
    at = state.summary.nextAt;
    state = await request(next(state), players[1]);
    assert.equal(state.summary.index, 2);
    at = state.summary.deadline + 10000;
    state = await request({ ...next(state), type: 'force-settle' }, players[0]);
    assert.equal(state.summary.nextAt, at + 10000);
    at = state.summary.nextAt;
    state = await request(next(state), players[2]);
    assert.equal(state.summary.phase, 'results'); assert.equal(state.summary.nextAt, null); assert.equal(state.summary.deadline, null);
    state = await request({ type: 'replay', gameId: state.summary.game, ...plan }, players[0]);
    assert.equal(state.summary.phase, 'lobby'); assert.equal(state.summary.nextAt, null); assert.equal(state.summary.deadline, null);
  });

  await t.test('房主手動與多人自動同時到達只前進一次', async () => {
    let { state, players } = await start();
    state = await reveal(state, players);
    const previous = state.summary, input = next(state);
    at = previous.nextAt;
    const responses = await Promise.all(players.map((player, index) => request({ ...input, type: index ? 'next' : 'force-next' }, player, null)));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.filter(r => r.status !== 200).every(r => r.status === 409 && r.error === 'round_changed'));
    state = await poll(players[0]);
    assert.equal(state.summary.index, 1); assert.equal(state.summary.version, previous.version + 1);
    assert.equal((await request(input, players[0], 409)).error, 'round_changed');
  });

  await t.test('離場、非本局成員與過期房間不可自動推進', async () => {
    let { state, players } = await start();
    state = await reveal(state, players);
    const input = next(state);
    at = state.summary.nextAt;
    await request({ type: 'leave' }, players[1]);
    assert.equal((await request(input, players[1], 403)).error, 'identity_lost');
    await db.prepare('UPDATE room_players SET in_game=0 WHERE room_id=? AND id=?').bind(state.summary.room, players[2].id).run();
    assert.equal((await request(input, players[2], 403)).error, 'identity_lost');
    assert.equal((await poll(players[0])).summary.phase, 'reveal');
    at = state.summary.expires;
    assert.equal((await request(input, players[0], 410)).error, 'room_closed');
  });

  await t.test('0.8 舊局保留交卷期限與房主手動換題', async () => {
    let { state, players } = await start();
    await db.prepare('UPDATE rooms SET versions=? WHERE id=?').bind(JSON.stringify({ ...versions, rulesVersion: 'circle-taiwan-0.8' }), state.summary.room).run();
    const deadline = state.summary.deadline;
    state = await reveal(state, players);
    assert.equal(state.summary.nextAt, null); assert.equal(state.summary.deadline, deadline);
    at = deadline + 20000;
    assert.equal((await request(next(state), players[1], 403)).error, 'host_only');
    state = await request(next(state), players[0]);
    assert.equal(state.summary.index, 1);
    const nextDeadline = state.summary.deadline;
    at = nextDeadline + 10000;
    state = await request({ ...next(state), type: 'force-settle' }, players[0]);
    assert.equal(state.summary.nextAt, null); assert.equal(state.summary.deadline, nextDeadline);
  });
});
