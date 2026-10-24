export const RULES_VERSION = 'circle-taiwan-0.5';
export const TIMES = [10, 20, 30, 45, 60];
export const COUNTS = { single: [5, 10], multi: [1, 3, 5, 10] };
export const DEFAULTS = { challenge: 'county', scope: 'mainland', county: '', town: '', count: 5, seconds: 20, capacity: 5, difficulty: 'easy' };
export const MAX_POINTS = 2048;

export function validateSettings(input, mode, regions) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('遊戲設定格式錯誤');
  const s = { ...DEFAULTS, ...input };
  if (!['single', 'multi'].includes(mode) || !['county', 'town', 'village'].includes(s.challenge)) throw new Error('請選擇有效的挑戰類型');
  if (!COUNTS[mode].includes(s.count)) throw new Error('題數選項無效');
  if (!['easy', 'hard'].includes(s.difficulty)) throw new Error('難度選項無效');
  if (mode === 'single') s.seconds = null;
  else if (!TIMES.includes(s.seconds)) throw new Error('時間選項無效');
  if (!Number.isInteger(s.capacity) || s.capacity < 2 || s.capacity > 8) throw new Error('房間容量需為 2～8 人');
  if (s.challenge === 'county') { s.scope = 'mainland'; s.county = ''; s.town = ''; }
  if (s.challenge === 'town') {
    if (!['county', 'mainland'].includes(s.scope)) throw new Error('請選擇出題範圍');
    if (s.scope === 'county' && !regions.some(r => r.level === 'county' && r.id === s.county)) throw new Error('縣市不存在');
    if (s.scope === 'mainland') s.county = '';
    s.town = '';
  }
  if (s.challenge === 'village') {
    s.scope = 'town';
    if (!regions.some(r => r.level === 'town' && r.id === s.town && r.county === s.county)) throw new Error('請選擇有效的鄉鎮市區');
  }
  if (!questionPool(s, regions).length) throw new Error('此範圍尚未匯入可用圖資');
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, s[k]]));
}

export function questionPool(s, regions) {
  return regions.filter(r => r.level === s.challenge &&
    (s.challenge !== 'town' || s.scope === 'mainland' || r.county === s.county) &&
    (s.challenge !== 'village' || r.town === s.town));
}

export const roundScore = n => Math.round((n + Number.EPSILON * Math.max(1, Math.abs(n))) * 100) / 100;
export const roundTime = milliseconds => Math.round(milliseconds / 100) / 10;

export function standings(roster, rounds, seconds, mode = 'single') {
  const voided = r => r.voided || Object.values(r.results || {}).some(result => result.status === 'calculation_failed');
  const valid = rounds.filter(r => !voided(r));
  const rows = roster.map(player => {
    const result = r => r.results[player.id] || { score: 0, elapsed: seconds * 1000, status: 'unanswered' };
    const results = valid.map(result);
    return { ...player, points: results.filter(r => r.score > 50).length,
      score: valid.length ? roundScore(results.reduce((sum, r) => sum + r.score, 0) / valid.length) : null,
      time: valid.length ? roundTime(results.reduce((sum, r) => sum + r.elapsed, 0)) : null,
      validRounds: valid.length,
      perQuestion: rounds.map(q => { const r = result(q), cancelled = voided(q); return { points: !cancelled && r.score > 50 ? 1 : 0,
        score: cancelled ? null : roundScore(r.score), time: cancelled ? null : roundTime(r.elapsed), status: r.status, voided: cancelled }; }) };
  }).sort((a, b) => (mode === 'multi' ? b.points - a.points : 0) || b.score - a.score || a.time - b.time);
  rows.forEach((r, i) => { r.rank = !valid.length ? null : i && (mode !== 'multi' || r.points === rows[i - 1].points) && r.score === rows[i - 1].score && r.time === rows[i - 1].time ? rows[i - 1].rank : i + 1; });
  return rows;
}
