import { validateSettings, questionPool, extentForSettings, standings } from '../shared/rules.js';
import { validatePoints } from '../shared/scoring.js';

let sequence = 0;
function localId() {
  if (globalThis.crypto?.getRandomValues) return [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
}

export function selectQuestions(data, input, random = Math.random, mode = 'single') {
  const settings = validateSettings(input, mode, data.regions), pool = questionPool(settings, data.regions);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const seen = new Set();
  const unique = settings.challenge !== 'landmark' ? pool : pool.filter(r => {
    const key = `${r.county}:${r.officialName || r.name}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { settings, questions: unique.slice(0, settings.count).map(r => r.id) };
}
export function createSoloRecord(settings, questions, nickname, now = Date.now(), id = localId) {
  return { id: id(), settings, questions, nickname, phase: 'answering', index: 0,
    rounds: [{ id: id(), regionId: questions[0], start: now, points: [], revision: 0, closed: true, submittedAt: null, skipped: false, result: null }] };
}
export class SoloGame {
  constructor(record, { data, engine, onChange = () => {}, onMessage = () => {}, now = Date.now, id = localId }) {
    Object.assign(this, { record, data, engine, onChange, onMessage, now, id });
    this.reviews = new Map(); this.active = true;
    this.byId = new Map(data.regions.map(r => [r.id, r]));
    this.prewarm();
  }
  prewarm() { this.engine.prepare?.(this.current.regionId).catch(() => {}); }
  get current() { return this.record.rounds.at(-1); }
  get extent() { return extentForSettings(this.record.settings, this.data.regions, this.data.bounds); }
  publish() { if (this.active) this.onChange(this.view()); }
  draft(points, closed = true) {
    if (!this.active || this.record.phase !== 'answering') return;
    this.current.points = validatePoints(points, this.data.playBounds); this.current.closed = closed; this.current.revision++;
  }
  async submit(questionId, skip = false) {
    if (!this.active || this.record.phase !== 'answering' || this.current.id !== questionId) return;
    if (!skip && !this.current.closed) throw new Error('請先封閉筆畫，或重畫後送出');
    if (!skip && this.current.points.length < 3) throw new Error('請圈出範圍，或跳過本題');
    const q = this.current; q.submittedAt = this.now(); q.skipped = skip; if (skip) { q.points = []; q.closed = true; }
    this.record.phase = 'scoring'; this.publish(); await this.compute(q);
  }
  async compute(q) {
    try {
      const review = await this.calculateReview(q);
      if (!this.active || this.current !== q) return;
      const result = review.results.solo;
      if (result.status === 'invalid' || result.status === 'unanswered') {
        this.record.phase = 'answering'; q.submittedAt = null; q.skipped = false;
        this.onMessage('圈選沒有有效面積；筆畫已保留，請重畫或跳過');
      } else {
        q.result = { score: result.score, status: result.status, elapsed: result.elapsed, breakdown: result.breakdown, ...(result.landmark ? { landmark: result.landmark } : {}) };
        this.reviews.set(q.id, review); this.record.phase = 'reveal-scores';
      }
    } catch (error) {
      if (!this.active || this.current !== q) return;
      this.record.phase = 'error'; this.error = error;
    }
    this.publish();
  }
  async retry() {
    if (!this.active || this.record.phase !== 'error') return;
    this.record.phase = 'scoring'; this.error = null; this.publish(); await this.compute(this.current);
  }
  redraw() {
    if (!this.active || this.record.phase !== 'error') return;
    this.current.submittedAt = null; this.current.skipped = false;
    this.record.phase = 'answering'; this.error = null; this.publish();
  }
  next(questionId) {
    if (!this.active || this.record.phase !== 'reveal-scores' || this.current.id !== questionId) return;
    if (this.record.rounds.length === this.record.questions.length) { this.record.phase = 'results'; this.engine.close(); }
    else {
      this.record.index++; this.record.phase = 'answering';
      this.record.rounds.push({ id: this.id(), regionId: this.record.questions[this.record.index], start: this.now(), points: [], revision: 0, closed: true, submittedAt: null, skipped: false, result: null });
      this.prewarm();
    }
    this.publish();
  }
  async calculateReview(q) {
    const value = await this.engine.score(q.regionId, q.points, this.data.playBounds);
    // Older compatible workers also return an unused clipped-answer geometry.
    const { answer, ...summary } = value.result;
    const result = { ...summary, elapsed: Math.max(0, q.submittedAt - q.start) };
    if (q.skipped) { result.status = 'skipped'; result.score = 0; }
    const region = this.byId.get(q.regionId);
    return { name: region.name, officialName: region.officialName, anchorLabel: region.anchorLabel,
      points: q.points, target: value.target, neutral: value.neutral, neutralNames: region.neutralNames || [], results: { solo: result },
      ...(value.targetPoint ? { targetPoint: value.targetPoint, answer: value.answer } : {}) };
  }
  async review(id) {
    if (!this.active) throw new Error('本局已結束');
    if (!this.reviews.has(id)) throw new Error('尚未揭曉');
    return this.reviews.get(id);
  }
  view() {
    const r = this.record, q = this.current, revealed = r.phase === 'reveal-scores';
    const player = { id: 'solo', name: r.nickname, color: '#c56e46', loaded: true, online: true, left: false, spectator: false };
    const region = this.byId.get(q.regionId);
    return { local: true, type: 'state', mode: 'single', code: r.id, phase: r.phase, settings: r.settings, settingsRevision: 1, you: 'solo', hostId: 'solo', players: [player],
      serverNow: this.now(), error: '背景計分失敗；圈選與原提交時間已保留，可重新計分或重畫。', notices: [],
      question: r.phase === 'results' ? null : { id: q.id, name: region.name, officialName: region.officialName, anchorLabel: region.anchorLabel,
        number: r.index + 1, count: r.questions.length, start: q.start, deadline: null,
        points: q.points, closed: q.closed, extent: this.extent, revision: q.revision, locked: r.phase !== 'answering', checking: false, neutralNames: region.neutralNames || [], results: revealed ? { solo: q.result } : null },
      history: r.phase === 'results' ? r.rounds.map(q => { const region = this.byId.get(q.regionId); return {
        id: q.id, name: region.name, officialName: region.officialName, anchorLabel: region.anchorLabel, results: { solo: q.result } }; }) : null,
      standings: r.phase === 'results' ? standings([player], r.rounds.map(q => ({ results: { solo: q.result } })), 0, 'single') : null };
  }
  stop() { this.active = false; this.reviews.clear(); this.engine.close(); }
}
