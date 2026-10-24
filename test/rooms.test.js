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
});
