import { GameMap, drawPath } from './map.js';
import { scoreImage, multiplayerScoreImage, challengeScope, roundScoreText, multiplayerRulesText, comparison, comparisonBounds, scoreText, landmarkDetails, landmarkFeedback, landmarkSummary, questionName } from './share.js';
import { questionPool, extentForSettings } from '../shared/rules.js';
import { landmarkRulesForSettings } from '../shared/scoring.js';
import { DraftSync } from './draft.js';
import { MultiplayerHTTP } from './multi-client.js';
import { SoloAssets } from './solo-assets.js';
import { SoloEngine } from './solo-engine.js';
import { SoloGame, createSoloRecord, selectQuestions } from './solo-game.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const score = value => scoreText(value, state?.settings.challenge || settings.challenge);
const totalTime = value => Number.isFinite(value) ? `${value.toFixed(1)} 秒` : '—';
const seconds = ms => `${(Math.round(ms / 100) / 10).toFixed(1)} 秒`;
const defaultSettings = { challenge: 'county', scope: 'mainland', county: '', town: '', pool: 'classic', count: 5, seconds: null, capacity: 5, difficulty: 'easy' };
const difficultyName = s => s.difficulty === 'easy' ? s.challenge === 'landmark' ? '初階・行政界線' : '初階・地圖線索' : s.challenge === 'landmark' && s.scope === 'county' ? '高階・縣市外框' : '高階・純輪廓';
let data, map, socket, state, session, mode = 'single', settings = { ...defaultSettings }, nickname = '玩家';
let homeEntry = 'create', joinCode = '', playersExpanded = false, rankingView = 'round';
try { nickname = (localStorage.getItem('circle-nickname') || nickname).slice(0, 16); } catch {}
let solo, staticManifest, localAssets, defaultData, environment = { multiplayer: 'coming', url: null };
let bootstrappingLocal = false, bootstrapGeneration = 0, bootstrapEngine, bootstrapRetry, gestureHintDismissed = false;
let autoStart = false, clockOffset = 0, lastQuestion = null, lastPhase = null, revision = 0, focus = null, draftTimer, reconnectTimer, finalFlush = false;
let vectorTimer, vectorController, vectorView, vectorViewport, vectorRequest = 0;
let roomLoadKey = null, roomLoadReady = false, roomLoadError = '', assets = { id: null, values: new Map(), pending: new Set(), failed: new Set() };
const draftSync = new DraftSync();
let reviews = new Map(), reviewPending = new Map(), reviewFailed = new Set(), reviewController = new AbortController(), resultKey = null, messageTimer;
const now = () => Date.now() + clockOffset;

function message(text, kind = 'error') {
  clearTimeout(messageTimer);
  const el = $('#error'); el.textContent = text; el.classList.toggle('is-info', kind === 'info'); el.hidden = false;
  el.setAttribute('role', kind === 'info' ? 'status' : 'alert');
  if (kind === 'info') messageTimer = setTimeout(() => { el.hidden = true; el.classList.remove('is-info'); }, 3200);
}
function clearMessage() { clearTimeout(messageTimer); const el = $('#error'); el.hidden = true; el.classList.remove('is-info'); }
function focusHeading(selector) {
  const heading = $(selector);
  if (heading && !document.querySelector('dialog[open]')) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}
function show(id) {
  if (document.body.dataset.screen !== id) {
    if (id !== 'play') window.scrollTo(0, 0);
    requestAnimationFrame(() => { if (document.body.dataset.screen === id) focusHeading(`#${id} h1`); });
  }
  if (id !== 'play') map?.suspend();
  if (id === 'home' || id === 'results') {
    vectorController?.abort(); vectorRequest++; vectorView = vectorViewport = null; clearTimeout(vectorTimer);
    localAssets?.clearTiles();
    if (map?.clues?.raster) { map.clues.raster = null; map.clues.bounds = null; map.clues.viewKey = null; }
  }
  if (document.body.dataset.screen === 'results' && id !== 'results') {
    for (const canvas of $('#results').querySelectorAll('canvas')) canvas.width = canvas.height = 0;
    $('#results').innerHTML = '';
  }
  document.body.dataset.screen = id;
  $('#mode-tabs').hidden = id !== 'home';
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== id;
}
function options(values, selected, label = v => v) { return values.map(v => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label(v))}</option>`).join(''); }
function available(s) { return questionPool(s, data.regions); }
function fixSelection(s, whichMode = mode) {
  s = { ...s };
  if (!data.counts[whichMode].includes(s.count)) s.count = 5;
  if (!['easy', 'hard'].includes(s.difficulty)) s.difficulty = 'easy';
  if (whichMode === 'single') s.seconds = null;
  else if (!data.times.includes(s.seconds)) s.seconds = 20;
  if (s.challenge !== 'landmark' || !['classic', 'all'].includes(s.pool)) s.pool = 'classic';
  if (s.challenge === 'county') { s.scope = 'mainland'; s.county = ''; s.town = ''; }
  if (s.challenge === 'landmark') {
    if (!['mainland', 'county'].includes(s.scope)) s.scope = 'mainland';
    if (s.scope === 'county' && !data.regions.some(r => r.level === 'county' && r.id === s.county)) s.county = '10004';
    if (s.scope === 'mainland') s.county = '';
    s.town = '';
  }
  if (s.challenge === 'town') {
    if (!['county', 'mainland'].includes(s.scope)) s.scope = 'county';
    if (s.scope === 'county' && !s.county) s.county = '10004';
    if (s.scope === 'mainland') s.county = '';
    s.town = '';
  }
  if (s.challenge === 'village') {
    s.scope = 'town';
    const villages = data.regions.filter(r => r.level === 'village');
    if (!villages.some(v => v.county === s.county)) s.county = villages.some(v => v.county === '63000') ? '63000' : villages[0]?.county || '';
    if (!villages.some(v => v.town === s.town && v.county === s.county)) s.town = s.county === '63000' && villages.some(v => v.town === '63000030') ? '63000030' : villages.find(v => v.county === s.county)?.town || '';
  }
  return s;
}
function settingsFields(s, whichMode, disabled = false) {
  const counties = data.regions.filter(r => r.level === 'county' && (s.challenge !== 'village' || data.regions.some(v => v.level === 'village' && v.county === r.id)));
  const towns = data.regions.filter(r => r.level === 'town' && r.county === s.county && data.regions.some(v => v.level === 'village' && v.town === r.id));
  const field = (name, label, html) => `<label>${label}<select name="${name}" data-setting ${disabled ? 'disabled' : ''}>${html}</select></label>`;
  const choice = (key, value, title, note) => `<button type="button" class="choice-card" data-action="choose-setting" data-setting-key="${key}" data-value="${value}" aria-pressed="${String(s[key]) === String(value)}" ${disabled ? 'disabled' : ''}><span><strong>${title}</strong><small>${note}</small></span></button>`;
  const toggle = (key, label, values) => `<div><div class="field-head"><span>${label}</span></div><input type="hidden" name="${key}" data-setting value="${s[key]}"><div class="segmented" role="group" aria-label="${label}">${values.map(([value, title]) => `<button type="button" data-action="choose-setting" data-setting-key="${key}" data-value="${value}" aria-pressed="${s[key] === value}" ${disabled ? 'disabled' : ''}>${title}</button>`).join('')}</div></div>`;
  const pool = available(s).length;
  return `<div><div class="field-head"><span>挑戰類型</span></div><input type="hidden" name="challenge" data-setting value="${s.challenge}"><div class="challenge-grid">${choice('challenge', 'county', '縣市', `從 ${data.regions.filter(r => r.level === 'county').length} 個縣市出題`)}${choice('challenge', 'town', '鄉鎮市區', '全台或指定縣市')}${choice('challenge', 'village', '村里', '選擇一個鄉鎮')}${choice('challenge', 'landmark', '知名景點', `本島 ${data.regions.filter(r => r.level === 'landmark').length} 個景點`)}</div>
    ${['town', 'village'].includes(s.challenge) ? '<div class="inline-scope">' : ''}
    ${s.challenge === 'town' ? field('scope', '出題範圍', options(['county', 'mainland'], s.scope, v => v === 'county' ? '指定縣市' : '全台灣（遊戲範圍）')) : ''}
    ${s.challenge === 'village' || (s.challenge === 'town' && s.scope === 'county') ? field('county', '縣市', options(counties.map(r => r.id), s.county, id => counties.find(r => r.id === id).label)) : ''}
    ${s.challenge === 'village' ? field('town', '鄉鎮市區', options(towns.map(r => r.id), s.town, id => towns.find(r => r.id === id).label)) : ''}
    ${['town', 'village'].includes(s.challenge) ? '</div>' : ''}${s.challenge === 'village' ? '<p class="pool-note">僅從所選鄉鎮、遊戲範圍內的村里出題。</p>' : ''}</div>
    ${s.challenge === 'landmark' ? `${toggle('scope', '出題範圍', [['mainland', '全島'], ['county', '指定縣市']])}${s.scope === 'county' ? field('county', '縣市', options(counties.map(r => r.id), s.county, id => counties.find(r => r.id === id).name)) : ''}${toggle('pool', '題庫深度', [['classic', '經典精選'], ['all', '全部題庫']])}` : ''}
    <div><div class="field-head"><span>線索難度</span></div><input type="hidden" name="difficulty" data-setting value="${s.difficulty}"><div class="difficulty-grid">${choice('difficulty', 'easy', '初階', s.challenge === 'landmark' ? s.scope === 'county' ? '縣市外框與鄉鎮界線' : '縣市邊界輔助線' : '地形、河川與道路')}${choice('difficulty', 'hard', '高階', s.challenge === 'landmark' && s.scope === 'county' ? '只有縣市外框' : '只有海岸輪廓')}</div></div>
    ${whichMode === 'multi' ? `<div class="fields">${field('seconds', '每題時間', options(data.times, s.seconds, n => `${n} 秒`))}${field('capacity', '參賽容量', options([2, 3, 4, 5, 6, 7, 8], s.capacity, n => `${n} 人`))}</div>` : ''}
    <div><div class="field-head"><span>題數</span><small>題庫 ${pool} 題</small></div><input type="hidden" name="count" data-setting value="${s.count}"><div class="question-count-row"><div class="segmented" role="group" aria-label="題數">${data.counts[whichMode].map(n => `<button type="button" data-action="choose-setting" data-setting-key="count" data-value="${n}" aria-pressed="${s.count === n}" ${disabled ? 'disabled' : ''}>${n} 題</button>`).join('')}</div>${pool < s.count ? `<span role="status">實際 ${pool} 題</span>` : ''}</div></div>`;
}
function formSettings(form, base) {
  const result = { ...base };
  for (const el of form.querySelectorAll('[data-setting]')) result[el.name] = ['count', 'seconds', 'capacity'].includes(el.name) ? Number(el.value) : el.value;
  return fixSelection(result, state?.mode || mode);
}
function renderHome() {
  const active = $('#home-form').contains(document.activeElement) ? document.activeElement : null;
  show('home');
  settings = fixSelection(settings);
  const actualCount = Math.min(settings.count, available(settings).length);
  const challengeLabel = ({ county: '縣市', town: '鄉鎮市區', village: '村里', landmark: '知名景點' })[settings.challenge];
  const diffLabel = settings.difficulty === 'easy' ? '初階線索' : '高階輪廓';
  for (const button of $('#mode-tabs').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.action === `${mode}-mode`);
  const joining = mode === 'multi' && homeEntry === 'join';
  $('#home-form').innerHTML = `<div class="home-grid"><div class="home-hero"><h1 class="display-title">把記憶<br><span>圈成一座島</span></h1><p class="hero-lede">看到題目，憑印象圈出行政區範圍或景點位置。</p><div class="home-map-card"><div class="home-map-frame"><canvas id="home-map-art" width="700" height="410" aria-label="官方圖資的台灣本島與指定近岸輪廓"></canvas></div><div class="home-map-caption"><strong>臺灣本島與指定近岸</strong></div></div>
    <div class="steps-strip" aria-label="玩法三步驟">${['看題目', '圈輪廓', '比差異'].map((title, i) => `<div class="step"><span class="step-index">0${i + 1}</span><strong>${title}</strong></div>`).join('')}</div></div>
    <div><form id="setup" class="config-card"><div class="config-head"><div><h2>${mode === 'single' ? '開始一局' : joining ? '加入朋友的房間' : '建立房間'}</h2><button type="button" data-action="help" class="text-link">玩法與鍵盤操作</button></div>${joining ? '' : `<div class="config-head-cta"><button class="primary" type="submit">${mode === 'single' ? `開始 ${actualCount} 題 →` : '建立多人房間 →'}</button><small class="config-summary">${mode === 'single' ? `${challengeLabel} · ${diffLabel} · 不限時` : `${challengeLabel} · ${diffLabel} · ${settings.seconds} 秒 · ${actualCount} 題`}</small></div>`}</div><div class="config-body">${mode === 'multi' ? `<div class="segmented room-entry" role="group" aria-label="多人入口"><button type="button" data-action="entry-join" aria-pressed="${joining}">加入房間</button><button type="button" data-action="entry-create" aria-pressed="${!joining}">建立房間</button></div><label>暱稱<input name="nickname" maxlength="16" required value="${esc(nickname)}" autocomplete="nickname" placeholder="輸入顯示暱稱"></label>${joining ? `<div class="join-inline"><label for="room-code">房間代碼</label><div class="row"><input id="room-code" name="code" form="join" maxlength="6" required autocomplete="off" value="${esc(joinCode)}" placeholder="6 碼房間代碼"><button type="button" class="primary" data-action="join-room">加入房間 →</button></div></div>` : ''}` : `<input type="hidden" name="nickname" value="${esc(nickname)}">`}${joining ? '' : `<div class="settings-fields">${settingsFields(settings, mode)}</div>`}</div></form>
    ${mode === 'multi' ? '<form id="join" hidden><button type="submit" hidden tabindex="-1"></button></form>' : ''}</div></div>`;
  $('[data-action="multi-mode"]').textContent = ['coming', 'unavailable'].includes(environment.multiplayer) ? '多人（準備中）' : '多人';
  if (mode === 'multi' && environment.multiplayer !== 'local') {
    const available = environment.multiplayer === 'available' && environment.url;
    const url = available ? new URL(environment.url, location.href) : null;
    const invite = new URLSearchParams(location.search).get('room'); if (url && invite) url.searchParams.set('room', invite);
    $('#setup').outerHTML = `<div class="card multi-entry"><h2>${available ? '前往多人遊戲' : environment.multiplayer === 'unavailable' ? '多人服務暫時無法使用' : '多人遊戲準備中'}</h2><p>多人使用獨立遊戲服務；單人練習可在這裡繼續。</p>${available ? `<a class="entry-link" href="${esc(url.href)}">開啟多人入口 →</a>` : '<button disabled>多人入口尚未開放</button>'}</div>`;
    $('#join')?.remove();
  }
  const canvas = $('#home-map-art'), c = canvas.getContext('2d'), b = data.bounds;
  const scale = Math.min(620 / (b[2] - b[0]), 370 / (b[3] - b[1]));
  c.translate(350, 205); c.scale(scale, -scale); c.translate(-(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2);
  drawPath(c, data.land); c.fillStyle = '#fbfaf6'; c.fill('nonzero'); c.strokeStyle = '#738477'; c.lineWidth = 1.4 / scale; c.stroke();
  if (active) [...$('#home-form').querySelectorAll('button,input,select')].find(el => active.name ? el.name === active.name :
    el.dataset.action === active.dataset.action && el.dataset.settingKey === active.dataset.settingKey && el.dataset.value === active.dataset.value)?.focus({ preventScroll: true });
}
function paddedBounds(bounds, padding = .25) {
  const dx = (bounds[2] - bounds[0]) * padding, dy = (bounds[3] - bounds[1]) * padding;
  return [bounds[0] - dx, bounds[1] - dy, bounds[2] + dx, bounds[3] + dy].map((n, i) => Math.max(data.playBounds[i % 2], Math.min(data.playBounds[i % 2 + 2], n)));
}
async function fetchView(bounds, detail, progress = () => {}, mpp = 1 / map.view?.scale) {
  vectorController?.abort(); vectorController = new AbortController(); const request = ++vectorRequest;
  const clues = map.clues, signal = vectorController.signal;
  clues.bounds = null; clues.detail = -1;
  const density = Math.min(globalThis.devicePixelRatio || map.dpr || 1, 2);
  const viewKey = localAssets.tileKey?.(bounds, mpp, density) || null;
  vectorView = { bounds, detail, clues, viewKey };
  const current = () => request === vectorRequest && !signal.aborted && map.clues === clues;
  const update = features => {
    if (!current()) return;
    features.sort((a, b) => ({ water: 0, river: 1, road: 2 })[a.kind] - ({ water: 0, river: 1, road: 2 })[b.kind]);
    if (!clues.raster && clues.features?.length === features.length && features.every((f, i) => f === clues.features[i])) return;
    clues.raster = null;
    clues.features = features; clues.generation++; map.render();
  };
  try {
    const ready = (name, promise) => Promise.resolve(promise).then(value => { if (current()) progress(name, true); return value; }, error => { error.clueStage = name; throw error; });
    if (viewKey) {
      const raster = await ready('地形', localAssets.tileView(bounds, mpp, density, signal));
      if (!current()) return;
      if (clues.raster?.key !== raster.key) { clues.raster = raster; clues.features = []; clues.generation++; map.render(); }
      clues.bounds = bounds; clues.detail = detail; clues.viewKey = viewKey; progress('道路與河川', true); $('#clue-status').textContent = ''; return;
    }
    const [features] = await Promise.all([
      ready('道路與河川', localAssets.features(bounds, detail, signal, update)),
      ready('地形', localAssets.clues(detail))
    ]);
    if (!current()) return;
    update(features); clues.bounds = bounds; clues.detail = detail; clues.viewKey = null; $('#clue-status').textContent = '';
  } catch (error) { if (current()) throw error; }
  finally { if (request === vectorRequest) vectorView = null; }
}
async function prepareClues(s, current, progress = () => {}) {
  if (s.challenge === 'landmark') {
    progress('行政邊界');
    try {
      const boundaries = await localAssets.landmarkBoundaries(s);
      if (current()) { Object.assign(map, boundaries); progress('行政邊界', true); map.render(); }
    } catch (error) { error.clueStage = '行政邊界'; throw error; }
    return;
  }
  map.scopeOutline = map.internalBoundaries = null;
  if (s.difficulty !== 'easy') return;
  progress('地形');
  const clues = await localAssets.clues();
  if (!current()) return;
  progress('道路與河川');
  if (map.clues !== clues) { map.baseKey = null; map.baseContentKey = null; map.vectorPaths = null; }
  map.clues = clues;
  const extent = extentForSettings(s, data.regions, data.bounds);
  const mpp = Math.max((extent[2] - extent[0]) / 600, (extent[3] - extent[1]) / 400);
  const detail = mpp > 200 ? 0 : mpp > 35 ? 1 : 2, loaded = clues.bounds;
  const viewKey = localAssets.tileKey?.(paddedBounds(extent), mpp, Math.min(globalThis.devicePixelRatio || map.dpr || 1, 2)) || null;
  if (loaded && (clues.viewKey || null) === viewKey && clues.detail >= detail && extent[0] >= loaded[0] && extent[1] >= loaded[1] && extent[2] <= loaded[2] && extent[3] <= loaded[3]) { progress('地形', true); progress('道路與河川', true); return; }
  await fetchView(paddedBounds(extent), detail, progress, mpp);
}
function queueViewportClues() {
  if (!state?.question || state.phase === 'results' || !map.cluesVisible || !map.clues || !map.view || (state.mode === 'multi' && !state.players.find(p => p.id === state.you)?.loaded)) return;
  const bounds = map.visibleBounds().map((n, i) => Math.max(data.bounds[i % 2], Math.min(data.bounds[i % 2 + 2], n)));
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) { vectorController?.abort(); vectorView = null; vectorViewport = null; clearTimeout(vectorTimer); $('#clue-status').textContent = ''; return; }
  const mpp = 1 / map.view.scale, detail = mpp > 200 ? 0 : mpp > 35 ? 1 : 2, loaded = map.clues.bounds;
  const expanded = paddedBounds(bounds, .2), viewKey = localAssets.tileKey(expanded, mpp, map.dpr);
  const key = `${bounds}:${detail}:${viewKey}`;
  if (vectorViewport?.clues === map.clues && vectorViewport.key === key) return;
  vectorViewport = { clues: map.clues, key }; clearTimeout(vectorTimer);
  if (loaded && (map.clues.viewKey || null) === viewKey && map.clues.detail >= detail && bounds[0] >= loaded[0] && bounds[1] >= loaded[1] && bounds[2] <= loaded[2] && bounds[3] <= loaded[3]) return;
  const pending = vectorView?.bounds;
  if (pending && vectorView.clues === map.clues && (vectorView.viewKey || null) === viewKey && vectorView.detail >= detail && bounds[0] >= pending[0] && bounds[1] >= pending[1] && bounds[2] <= pending[2] && bounds[3] <= pending[3]) return;
  vectorController?.abort(); vectorView = null; vectorRequest++;
  vectorTimer = setTimeout(async () => {
    if (!state?.question || state.phase === 'results') return;
    if (document.activeElement?.dataset.action === 'retry-clues') map.canvas.focus({ preventScroll: true });
    $('#clue-status').textContent = '載入地形、道路與河川細節…';
    try { await fetchView(viewKey ? expanded : paddedBounds(bounds, .3), detail, () => {}, mpp); }
    catch (error) { if (error.name !== 'AbortError') $('#clue-status').innerHTML = '地圖細節載入失敗。 <button type="button" data-action="retry-clues">重試細節</button>'; }
  }, 180);
}
async function ensureRoomLoaded() {
  if (state.phase === 'results' || (state.mode === 'multi' && state.players.find(p => p.id === state.you)?.loaded && (!state.free || roomLoadReady))) return;
  if (state.local) return;
  const key = `${state.code}:${state.settingsRevision}`;
  if (roomLoadKey === key) return;
  roomLoadKey = key; roomLoadReady = false; roomLoadError = '';
  const current = state;
  const isCurrent = () => state && roomLoadKey === key && state.code === current.code && state.settingsRevision === current.settingsRevision && state.phase !== 'results';
  try {
    await Promise.all([prepareClues(current.settings, isCurrent), socket instanceof MultiplayerHTTP ? socket.loadEngine() : null]);
    if (!isCurrent()) return;
    roomLoadReady = true;
    if (state.free && state.phase !== 'lobby') { renderState(); return; }
    send({ type: 'loaded', revision: current.settingsRevision, versions: socket instanceof MultiplayerHTTP ? socket.versions : undefined, dataVersion: data.manifest.version, rulesVersion: data.rulesVersion,
      terrainSha256: current.settings.difficulty === 'easy' && current.settings.challenge !== 'landmark' ? map.clues.terrainSha256 : null,
      vectorsSha256: current.settings.difficulty === 'easy' && current.settings.challenge !== 'landmark' ? map.clues.vectorsSha256 : null });
  } catch (error) {
    if (!isCurrent()) return;
    roomLoadError = `${error.message}；請重試載入，或${state.mode === 'multi' ? '由房主' : ''}調整設定。`; renderState();
  }
}
function roundAsset(asset, player = '') {
  const cache = assets, q = state.question, key = `${asset}:${player}`;
  if (cache.values.has(key)) return cache.values.get(key);
  if (!cache.pending.has(key) && !cache.failed.has(key)) {
    cache.pending.add(key);
    const query = new URLSearchParams({ code: state.code, question: q.id, asset, player });
    (socket instanceof MultiplayerHTTP ? socket.roundAsset(asset, player).then(value => ({ ok: true, json: async () => value })) : fetch(`/api/round?${query}`, { signal: cache.controller?.signal, headers: { Authorization: `Bearer ${session.token}` } })).then(async response => {
      if (!response.ok) throw new Error('揭曉資料載入失敗');
      const value = await response.json(); cache.values.set(key, value);
      if (asset === 'comparison') cache.values.set('neutral:', value.neutral);
    }).catch(error => { if (error.name !== 'AbortError') cache.failed.add(key); }).finally(() => {
      cache.pending.delete(key); if (assets === cache && state?.question?.id === cache.id && state.phase.startsWith('reveal')) renderState();
    });
  }
  return null;
}
function resetAssets(id = null) {
  assets.controller?.abort(); assets = { id, values: new Map(), pending: new Set(), failed: new Set(), controller: new AbortController() };
}
function resetReviews() {
  reviewController.abort(); reviewController = new AbortController(); reviews = new Map(); reviewPending = new Map(); reviewFailed = new Set(); resultKey = null;
}
function reviewAsset(id) {
  if (reviews.has(id)) return reviews.get(id);
  // At most ten rounds per game; two in flight also bounds a results-page refresh.
  if (reviewPending.size < 2 && !reviewPending.has(id) && !reviewFailed.has(id)) {
    const cache = reviews, pending = reviewPending, failed = reviewFailed;
    const query = new URLSearchParams({ code: state.code, question: id, asset: 'review' });
    const request = (state.local ? solo.review(id).then(value => ({ ok: true, json: async () => value })) : fetch(`/api/round?${query}`, { signal: reviewController.signal, headers: { Authorization: `Bearer ${session.token}` } })).then(async response => {
      if (!response.ok) throw new Error('揭曉資料載入失敗');
      cache.set(id, await response.json());
    }).catch(error => { if (error.name !== 'AbortError') failed.add(id); }).finally(() => {
      pending.delete(id); if (reviews === cache && state && ['results', 'reveal-scores'].includes(state.phase)) renderState();
    });
    pending.set(id, request);
  }
  return null;
}
function notices() { return `<div class="room-notices" role="status">${state.notices.slice(state.phase === 'lobby' ? -3 : -2).map(n => `<p>${esc(n.text)}</p>`).join('')}</div>`; }
function playerIdentity(player) {
  const duplicate = state.players.some(p => p.id !== player.id && !p.left && p.name === player.name);
  return `${esc(player.name)}${player.id === state.you ? '（你）' : ''}${duplicate ? ` <small>${esc(player.id.slice(0, 4))}</small>` : ''}`;
}
function settingsSummary(s, count = Math.min(s.count, available(s).length)) {
  return `${challengeScope(data, s)} · ${difficultyName(s)} · ${count} 題 · ${s.seconds == null ? '不限時' : `每題 ${s.seconds} 秒`}`;
}
function waitingStatus() {
  const q = state.question, me = state.players.find(p => p.id === state.you);
  if (state.phase === 'error') return state.error;
  if (q.checking) return '計算得分中，圈選與作答時間已保留。';
  if (state.free && !me.submitted) return '正在送出答案，圈選與成績已保留。';
  const players = state.players.filter(p => !p.spectator && (state.free || !p.left));
  const received = players.filter(p => p.submitted || (!state.free && p.id === state.you && q.locked)).length;
  return received < players.length ? `已收件 ${received}／${players.length}，等待其他玩家。` : '已全數收件，等待揭曉。';
}
function ranking(rows, title, cumulative = false) {
  return `<div class="table-wrap"><table aria-label="${esc(title)}"><thead><tr><th>名次／玩家</th><th>積分</th><th>${cumulative ? '平均' : state.settings.challenge === 'landmark' ? '得分' : '吻合度'}</th><th>${cumulative ? '總' : ''}時間</th></tr></thead><tbody>${rows.map(p => {
    const live = state.players?.find(x => x.id === p.id);
    const seenBadge = !cumulative && live && !live.spectator && !live.left && live.seen ? '<span class="seen-badge" title="已按我看完了">✓</span>' : '';
    return `<tr class="${p.id === state.you ? 'is-you' : ''} ${focus === p.id ? 'is-focused' : ''}" data-action="compare" data-player="${p.id}" title="點選查看 ${esc(p.name)} 的圈選對照；再點一次返回全部輪廓"><td><span class="rank-num">${p.rank == null ? '—' : p.rank + '.'}</span><button type="button" class="rank-player player-name" data-action="compare" data-player="${p.id}" aria-pressed="${focus === p.id}" data-text-color="${p.color}"><i class="dot" data-color="${p.color}"></i>${playerIdentity(p)}</button>${p.left ? '／已離開' : ''}${seenBadge}</td><td>${p.points} 點</td><td>${score(p.score)}</td><td>${totalTime(p.time)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function send(value) {
  if (state?.local) {
    if (value.type === 'next') solo.next(value.questionId);
    else if (value.type === 'skip-question') solo.submit(value.questionId, true).catch(error => message(error.message));
    else if (value.type === 'retry') solo.retry().catch(error => message(error.message));
    return true;
  }
  if (socket?.readyState !== 1) { message('目前離線；本機筆畫尚未送達，請等待重新連線。'); return false; }
  return socket.send(JSON.stringify(value)) ?? true;
}
function savedSession(stored, invite) {
  let saved; try { saved = stored ? JSON.parse(stored) : null; } catch { return null; }
  return saved && (!invite || (saved.mode === 'multi' && saved.code === invite)) ? saved : null;
}
function persistSession(value) {
  try { if (value) sessionStorage.setItem('circle-session', JSON.stringify(value)); else sessionStorage.removeItem('circle-session'); } catch {}
}
function connect(hello) {
  clearTimeout(reconnectTimer); if (socket) { socket.intentional = true; socket.close(); }
  $('#connection').textContent = '連線中…';
  const ws = socket = new MultiplayerHTTP({ manifest: staticManifest, data: defaultData, capture: () => map.points });
  ws.onopen = () => { roomLoadKey = null; roomLoadReady = false; ws.send(JSON.stringify({ ...hello, transportVersion: 1 })); };
  ws.onmessage = event => {
    if (ws !== socket || ws.intentional) return;
    const value = JSON.parse(event.data);
    if (value.type === 'session') { session = value; persistSession(value); }
    else if (value.type === 'sync') { clockOffset = value.serverNow - Date.now(); }
    else if (value.type === 'state') {
      const reconnecting = $('#connection').textContent !== '已連線';
      if (reconnecting) clearMessage();
      state = value;
      if (reconnecting && value.question) draftSync.reset(value.question.id, value.question.revision, value.question.points || []);
      clockOffset = value.serverNow - Date.now(); $('#connection').textContent = '已連線'; renderState();
      if (session) { session.mode = value.mode; session.settings = value.settings; persistSession(session); }
      if (reconnecting && state.phase === 'answering' && !state.free) flushDraft(false, true);
    } else if (value.type === 'ack' && ['draft', 'submit'].includes(value.action)) {
      if (value.questionId && value.questionId !== state?.question?.id) return;
      draftSync.ack(value); revision = Math.max(revision, value.revision || 0);
      if (value.resync && !value.locked && !value.checking) { flushDraft(false, true); return; }
      if (state?.question && (value.locked || value.checking !== undefined)) { state.question.locked = Boolean(value.locked || value.checking); state.question.checking = Boolean(value.checking && !value.locked); }
      if (value.locked && state?.mode === 'multi') $('#submit').textContent = '✓ 已送出・等待其他人…';
      $('#draft-status').textContent = value.checking ? '檢查圈選中，筆畫已保留…' : value.locked ? '✓ 已鎖定圈選，等待其他玩家作答…' : '圈選已同步';
    } else if (value.type === 'left' || value.type === 'removed') { leaveHome(); if (value.message) message(value.message); }
    else if (value.type === 'info') message(value.message, 'info');
    else if (value.type === 'error') {
      if (hello.type === 'resume' && $('#connection').textContent !== '已連線') leaveHome();
      if (state?.phase === 'answering' && !state.free) { $('#submit').disabled = !map.editable || map.points.length < 3; $('#draft-status').textContent = '圈選仍保留，請重畫或重試'; }
      message(value.message);
      if (!state) { ws.intentional = true; ws.close(); persistSession(null); session = null; $('#connection').textContent = '本機服務已就緒'; }
    }
  };
  ws.onclose = event => {
    if (ws !== socket || ws.intentional) return;
    if (event.code === 4001) { leaveHome(); message('此遊戲已在另一個分頁開啟，本分頁已停止重連。'); return; }
    $('#connection').textContent = '離線，等待重連';
    map.editable = false;
    $('#submit').disabled = true; $('#clear').disabled = true; $('#skip-question').disabled = true;
    $('#draft-status').textContent = '連線中斷，圈選仍保留；等待重新連線…';
    message('與本機服務斷線，正在重新連線。圈選仍保留，作答時間持續計算。');
    if (session) reconnectTimer = setTimeout(() => connect({ type: 'resume', code: session.code, token: session.token }), 1500);
  };
  ws.onerror = () => { $('#connection').textContent = '連線失敗'; };
}
function leaveHome() {
  solo?.stop(); solo = null;
  bootstrapGeneration++; bootstrapEngine?.close(); bootstrapEngine = null; bootstrappingLocal = false;
  autoStart = false; roomLoadKey = null; roomLoadReady = false; roomLoadError = ''; resetAssets(); resetReviews(); vectorController?.abort(); vectorView = null; vectorViewport = null; clearTimeout(vectorTimer);
  if (socket) { socket.intentional = true; socket.close(); }
  clearTimeout(reconnectTimer); clearTimeout(draftTimer); persistSession(null); session = null;
  if (state) { settings = { ...state.settings }; mode = state.mode; } state = null; lastQuestion = null; lastPhase = null; $('#connection').textContent = ''; renderHome();
}
function renderLobby() {
  show('lobby'); const me = state.players.find(p => p.id === state.you), host = state.hostId === state.you;
  $('#lobby').setAttribute('aria-label', state.mode === 'single' ? '單人地圖準備' : '多人房間');
  const loaded = me.loaded && ((state.mode === 'multi' && !state.free) || roomLoadReady);
  const participants = state.players.filter(p => !p.spectator && !p.left), ready = participants.filter(p => p.online && p.loaded && p.ready).length;
  const othersReady = participants.every(p => p.online && p.loaded && (p.ready || (host && p.id === state.you && loaded)));
  const canStart = loaded && participants.length >= (state.mode === 'single' ? 1 : 2) && (ready === participants.length || (host && !me.spectator && othersReady));
  const pending = participants.filter(p => p.id !== state.hostId && (!p.online || !p.loaded || !p.ready)).length;
  const status = roomLoadError || (!loaded ? '正在載入本房圖資與計分工具…' : host ? participants.length < 2 ? '至少需要 2 位參賽者。' : !canStart ? `等待 ${pending} 位玩家載入並準備。` : '' : me.ready ? '已準備，等待房主開始。' : '載入完成，可以準備。');
  $('#lobby').innerHTML = state.mode === 'single' ? `<div class="card"><h1>準備單人挑戰</h1><p role="status">${roomLoadError ? esc(roomLoadError) : loaded ? '地圖已就緒，即將開始。' : '正在載入地形、道路與河川，完成後才開始計時。'}</p>${roomLoadError ? `<button data-action="retry-load">重試載入</button><form id="room-settings"><div class="settings-fields">${settingsFields(state.settings, 'single')}</div></form>` : ''}<button data-action="leave">返回設定</button></div>` : `<div class="row"><h1>多人房間</h1><div class="spacer"></div><button data-action="leave">離開／重新開房</button></div><div class="card"><div class="row invite-row"><span>房間代碼 <code class="room-code">${esc(state.code)}</code></span><button data-action="copy-invite">複製邀請連結</button></div><p id="manual-invite" hidden><label>邀請連結（請選取複製）<input id="invite-url" type="url" readonly></label></p>
    <p class="room-summary">參賽 ${participants.length}／${state.settings.capacity} 人</p>
    ${state.players.filter(p => !p.left).map(p => `<div class="player"><span class="player-name" data-text-color="${p.color}"><i class="dot" data-color="${p.color}"></i>${playerIdentity(p)}${p.id === state.hostId ? '（房主）' : ''}</span><span>${!p.online ? '離線' : !p.loaded || (p.id === state.you && !loaded) ? '載入圖資中' : p.spectator ? '觀戰' : p.ready ? '已準備' : p.id === state.hostId ? '已載入' : '未準備'}</span>${host && p.id !== state.you ? `<button data-action="kick" data-player="${p.id}" aria-label="移除 ${esc(p.name)}">移除</button>` : ''}</div>`).join('')}
    <p class="load-status" role="status">${esc(status)}</p>${roomLoadError ? '<button data-action="retry-load">重試載入</button>' : ''}
    <div class="row lobby-actions">${host ? `<button class="primary" data-action="start" ${canStart ? '' : 'disabled'}>開始遊戲</button>` : `<button class="primary" data-action="ready" ${me.spectator || !loaded ? 'disabled' : ''}>${me.ready ? '取消準備' : '我準備好了'}</button>`}</div><p class="pool-note room-limits">房主離開會關房；30 分鐘沒有有效操作，房間將過期。</p>${notices()}</div>${host ? `<form id="room-settings" class="card"><h2>本局設定</h2><div class="settings-fields">${settingsFields(state.settings, state.mode)}</div></form>` : `<section class="room-settings-summary" aria-label="本局設定"><h2>本局設定</h2><p>${esc(settingsSummary(state.settings))}</p></section>`}`;
  for (const el of $('#lobby').querySelectorAll?.('[data-color]') || []) el.style.backgroundColor = el.dataset.color;
  for (const el of $('#lobby').querySelectorAll?.('[data-text-color]') || []) el.style.color = el.dataset.textColor;
  if (autoStart && state.mode === 'single' && loaded) {
    if (!me.ready) send({ type: 'ready', ready: true }); else { autoStart = false; send({ type: 'start' }); }
  }
}
function renderState() {
  if (state.phase === 'results') {
    clearTimeout(vectorTimer); vectorController?.abort(); roomLoadKey = null; roomLoadReady = false;
    renderResults(); return;
  }
  ensureRoomLoaded();
  if (state.phase === 'lobby') { if (reviews.size || reviewPending.size || reviewFailed.size) resetReviews(); renderLobby(); return; }
  show('play'); const q = state.question, me = state.players.find(p => p.id === state.you);
  const comparisonButtons = '#compare button, #round-rankings button';
  const activeComparison = [...document.querySelectorAll(comparisonButtons)].indexOf(document.activeElement);
  const single = state.mode === 'single', landmark = state.settings.challenge === 'landmark', scored = state.phase === 'reveal-scores', newQuestion = lastQuestion !== q.id;
  if (newQuestion) { playersExpanded = false; rankingView = 'round'; }
  const answering = ['countdown', 'answering'].includes(state.phase);
  const panelVisible = single ? scored : !answering || playersExpanded;
  $('#result-panel').hidden = !panelVisible;
  $('#multiplayer-panel').hidden = single;
  $('#single-result').hidden = !single || !scored;
  $('#play').classList.toggle('has-panel', panelVisible);
  $('#play').classList.toggle('is-answering', answering);
  $('#play').classList.toggle('is-reveal', scored);
  $('#play').classList.toggle('is-landmark', landmark);
  $('#players-toggle').hidden = single || !answering;
  $('#players-toggle').setAttribute('aria-expanded', String(playersExpanded));
  $('#players-toggle').textContent = `玩家 (${state.players.filter(p => !p.spectator && !p.left).length})`;
  map.resize();
  map.cluesVisible = !landmark && state.settings.difficulty === 'easy';
  map.countiesVisible = false;
  if (!landmark) map.scopeOutline = map.internalBoundaries = null;
  map.strokeColor = single ? '#c56e46' : (me?.color || '#c56e46');
  if (newQuestion) {
    clearTimeout(draftTimer); lastQuestion = q.id; revision = q.revision; finalFlush = false; focus = null;
    resetAssets(q.id); draftSync.reset(q.id, q.revision, q.points || []);
    $('#play').classList.remove('result-collapsed');
    map.points = q.points || []; map.beforeStroke = null; map.reveal = null; map.mode = 'draw'; map.keyboardDrawing = state.local && !q.closed; map.gesture = null; map.pointers.clear(); map.fit(q.extent);
    for (const el of document.querySelectorAll('.tools button')) el.setAttribute('aria-pressed', el.dataset.action === 'draw');
  }
  if (!['answering', 'countdown'].includes(state.phase) && q.points) map.points = q.points;
  const questionNumber = `第 ${q.number}／${q.count} 題${me.spectator ? '・觀戰' : ''}`;
  if ($('#q-number').textContent !== questionNumber) $('#q-number').textContent = questionNumber;
  if ($('#q-name').textContent !== questionName(q)) $('#q-name').textContent = questionName(q);
  if (newQuestion) focusHeading('#q-name');
  const reveal = state.phase.startsWith('reveal');
  if (reveal) map.mode = 'move';
  $('.target-kicker').hidden = !answering;
  $('.target-kicker').textContent = landmark ? '🎯 請圈住景點所在位置' : '請圈出完整範圍';
  $('.tools').hidden = !answering;
  $('#timer-pill').hidden = !answering && (single || state.free);
  for (const el of document.querySelectorAll('.tools button')) el.setAttribute('aria-pressed', el.dataset.action === map.mode);
  if (scored && (newQuestion || lastPhase !== state.phase)) focus = single ? state.you : null;
  const review = single && scored ? reviewAsset(q.id) : null;
  const drawings = single ? review ? [{ ...me, points: review.points }] : [] : reveal ? roundAsset('drawings') || [] : [];
  const target = landmark ? null : single ? review?.target : scored || state.phase === 'reveal-answer' ? roundAsset('target') : null;
  const targetPoint = !landmark ? null : single ? review?.targetPoint : scored || state.phase === 'reveal-answer' ? roundAsset('targetPoint') : null;
  const preloadPlayer = !single && scored ? (focus || (state.free ? (q.results?.[state.you]?.status === 'ok' ? state.you : Object.keys(q.results || {}).find(id => q.results[id].status === 'ok')) : (q.results?.[state.you] ? state.you : state.roundStandings?.[0]?.id))) : null;
  if (state.free && scored) roundAsset('neutral');
  const preloadedDetail = !single && scored && preloadPlayer ? roundAsset('comparison', preloadPlayer) : null;
  const detail = !single && scored && focus ? (focus === preloadPlayer ? preloadedDetail : roundAsset('comparison', focus)) : null;
  const comparisonReady = single ? Boolean(review) : (assets.values.has('drawings:') && (state.phase === 'reveal-drawings' || assets.values.has(landmark ? 'targetPoint:' : 'target:')) &&
    (!scored || (assets.values.has('neutral:') && (!focus || Boolean(detail)))));
  map.reveal = reveal ? { players: single ? drawings.map(p => ({ ...p, color: '#c56e46' })) : drawings, target, targetPoint,
    landmark: single ? review?.results[state.you]?.landmark : detail?.landmark || (preloadPlayer === state.you ? preloadedDetail?.landmark : null),
    results: single ? landmark && review ? { [state.you]: { ...review.results[state.you], answer: review.answer } } : review?.results : detail ? { [focus]: detail } : null,
    neutral: single ? review?.neutral || [] : detail?.neutral || assets.values.get('neutral:') || [], focus } : null;
  const fitLabel = landmark && scored ? '查看目標與圈選' : '回到完整地圖';
  $('[data-action="home-map"]').setAttribute('aria-label', fitLabel); $('[data-action="home-map"]').title = fitLabel;
  map.editable = state.phase === 'answering' && me.loaded && (!(single || state.free) || roomLoadReady) && !q.locked && !me.spectator && !me.left && !state.readonly && (state.local || socket?.readyState === 1) && (q.deadline === null || now() < q.deadline);
  if (!map.cluesVisible) $('#clue-status').textContent = '';
  else if (single && !roomLoadReady) $('#clue-status').innerHTML = roomLoadError ? `${esc(roomLoadError)} <button data-action="retry-load">重試載入</button>` : '正在載入地圖線索，完成後即可圈選。';
  $('#map-context').textContent = `${map.mode === 'draw' ? '圈選模式' : '移動模式'}${q.neutralNames?.length ? `｜${q.neutralNames.join('、')}為中立範圍，圈入不加分也不扣分。` : ''}`;
  $('#map-help').hidden = gestureHintDismissed || state.phase !== 'answering';
  const collapsed = $('#play').classList.contains('result-collapsed');
  if ($('#multi-toggle-result')) {
    $('#multi-toggle-result').hidden = single || !reveal;
    $('#multi-toggle-result').setAttribute('aria-expanded', String(!collapsed));
    $('#multi-toggle-result').textContent = `${collapsed ? '展開' : '收合'}明細`;
  }
  const activeParticipants = state.players.filter(p => !p.spectator && (state.free || !p.left));
  const submittedCount = activeParticipants.filter(p => p.submitted || (!state.free && p.id === state.you && q.locked)).length;
  const waitingCount = Math.max(0, activeParticipants.length - submittedCount);
  $('#players').innerHTML = state.players.map(p => {
    const isDone = p.submitted || (!state.free && p.id === state.you && q.locked);
    const statusText = q.voided ? '本題作廢' : q.results?.[p.id]?.status === 'forced_missing' ? '未交卷 · 0 分' : q.results?.[p.id] ? score(q.results[p.id].score) : p.left ? '已離開／等待結算' : p.submitted ? '✓ 已收件' : p.id === state.you && q.checking ? '計算中…' : '等待結果';
    return `<div class="player"><span class="player-name" data-text-color="${p.color}"><i class="dot" data-color="${p.color}"></i>${playerIdentity(p)}</span><span class="score ${!q.results?.[p.id] && isDone ? 'status-done' : ''}">${answering && !q.locked ? '' : statusText}</span></div>`;
  }).join('');
  $('#players').hidden = scored;
  const cumulative = rankingView === 'total' && q.number > 1;
  $('#round-rankings').innerHTML = scored && !single ? `${q.voided ? '<p role="status">本題因系統計分失敗作廢，不列入積分、平均與總時間；仍可比較筆跡。</p>' : ''}${q.number > 1 ? `<div class="segmented ranking-tabs" role="tablist" aria-label="排名範圍">${[['round', '本題'], ['total', '累積']].map(([view, label]) => `<button type="button" id="rank-tab-${view}" role="tab" data-action="ranking-view" data-view="${view}" aria-controls="ranking-view" aria-selected="${rankingView === view}" tabindex="${rankingView === view ? 0 : -1}">${label}</button>`).join('')}</div>` : ''}<div id="ranking-view" ${q.number > 1 ? `role="tabpanel" aria-labelledby="rank-tab-${cumulative ? 'total' : 'round'}"` : ''}>${ranking(cumulative ? state.cumulativeStandings : state.roundStandings, cumulative ? `累積排名（${q.number} 題）` : '本題名次', cumulative)}</div>` : '';
  const mine = scored && !single ? state.roundStandings.find(p => p.id === state.you) : null;
  $('#round-summary').hidden = !mine;
  $('#round-summary').textContent = mine ? q.voided ? '本題作廢' : `本題 ${mine.points} 點 · ${score(mine.score)} · ${totalTime(mine.time)}${q.results?.[state.you]?.status === 'forced_missing' ? ' · 強制未交卷' : q.results?.[state.you]?.status === 'invalid' ? ' · 無效' : q.results?.[state.you]?.status === 'unanswered' ? ' · 未作答' : ''}` : '';
  $('#room-feedback').innerHTML = !single ? `${notices()}<p id="seen-status" role="status"></p>${!me.loaded || (state.free && !roomLoadReady) ? `<p>${roomLoadError ? esc(roomLoadError) : '載入本房地圖中，完成前暫停圈選。'}</p>${roomLoadError ? '<button data-action="retry-load">重試載入</button>' : ''}` : ''}` : '';
  const focusedPlayer = focus ? (state.players.find(p => p.id === focus) || drawings.find(p => p.id === focus)) : null;
  $('#compare').innerHTML = reveal ? `<button type="button" data-action="compare" data-player="" aria-pressed="${!focus}"><span class="compare-name">${!focus ? '✓ 比較全部輪廓' : '↺ 返回比較全部輪廓'}</span><span class="compare-meta">${!focus ? `${drawings.length} 人同圖對照` : `目前單看：${esc(focusedPlayer?.name || '')}`}</span></button>` : '';
  for (const el of document.querySelectorAll('[data-color]')) el.style.backgroundColor = el.dataset.color;
  for (const el of document.querySelectorAll('[data-text-color]')) el.style.color = el.dataset.textColor;
  $('#privacy').textContent = reveal ? (!focus ? landmark ? '選取玩家可查看圈選面積與最近距離。' : '選取玩家可查看圈對、多圈與漏圈。' : '') : '作答時只看得到自己的圈選。';
  const focusedLandmark = detail?.landmark || preloadedDetail?.landmark;
  $('#landmark-detail').hidden = single || !scored || !landmark || !focusedLandmark;
  $('#landmark-detail').textContent = focusedLandmark ? `${preloadPlayer === state.you ? '你的圈選' : state.players.find(p => p.id === preloadPlayer)?.name || '圈選'}：${landmarkFeedback({ ...q.results[preloadPlayer], landmark: focusedLandmark })}${focusedLandmark.hit === false ? ` · 圈選面積 ${(focusedLandmark.areaM2 / 1e6).toFixed(2)} km²` : ''}` : '';
  $('#submit').hidden = !['countdown', 'answering'].includes(state.phase); $('#submit').disabled = !map.editable || map.points.length < 3 || Boolean(map.gesture?.drawing || map.keyboardDrawing);
  $('#submit').textContent = !single && state.phase === 'answering' && q.checking ? '檢查圈選中…' : !single && state.phase === 'answering' && q.locked ? (waitingCount > 0 ? `✓ 已送出・等待其他人（${submittedCount}／${activeParticipants.length}）` : '✓ 已送出・即將揭曉…') : '送出圈選 →';
  $('#clear').disabled = !map.editable && !(state.local && state.phase === 'error');
  $('#clear').hidden = !answering && !(state.local && state.phase === 'error');
  $('#undo').disabled = !map.editable || !map.beforeStroke || Boolean(map.gesture?.drawing);
  $('#undo').hidden = state.phase !== 'answering';
  $('#finish-stroke').hidden = !state.local || !map.keyboardDrawing || !map.editable;
  $('#reveal-status').innerHTML = reveal ? (single ? reviewFailed.has(q.id) : assets.failed.size) ? '<span>揭曉圖形載入失敗，圈選與分數仍保留。</span> <button data-action="retry-reveal">重試揭曉圖形</button>' : !comparisonReady ? '載入揭曉圖形…' : '' : '';
  $('#reveal-status').dataset.ready = String(reveal && comparisonReady);
  $('#seen').hidden = state.free || state.mode === 'single' || state.phase !== 'reveal-scores' || me.spectator; $('#seen').disabled = me.seen || !comparisonReady;
  $('#seen').textContent = me.seen ? '已看完，等待其他人' : '我看完了';
  $('#next').hidden = state.mode !== 'single' || state.phase !== 'reveal-scores'; $('#next').disabled = false;
  $('#next').textContent = q.number === q.count ? '看整局成績' : '下一題';
  $('#skip-question').hidden = state.mode !== 'single' || state.phase !== 'answering'; $('#skip-question').disabled = !map.editable;
  $('#force').hidden = state.mode === 'single' || state.hostId !== state.you || (!['scoring', 'error', 'reveal-scores'].includes(state.phase));
  $('#force').dataset.action = state.free && state.phase !== 'reveal-scores' ? 'force-settle' : 'force-next';
  if (state.free) { $('#force').disabled = state.phase !== 'reveal-scores' && now() < q.deadline + 10000; $('#force').textContent = state.phase === 'reveal-scores' ? (q.number === q.count ? '看整局成績' : '下一題') : '強制結算'; }
  $('#retry').hidden = state.phase !== 'error' || (!state.free && state.hostId !== state.you);
  $('#retry').textContent = state.localFailure === 'upload' ? '重新送出' : '重新計分';
  $('#report-failure').hidden = !state.free || !state.canReportFailure;
  $('#force-note').hidden = $('#force').hidden || reveal || !state.free;
  $('#failure-note').hidden = $('#report-failure').hidden;
  $('#waiting-host').hidden = single || !state.free || !scored || state.hostId === state.you;
  $('#waiting-host').textContent = `等待房主${q.number === q.count ? '查看整局成績' : '進入下一題'}`;
  $('#force').classList.toggle('primary', scored && state.free);
  $('#legend').hidden = !scored;
  $('#legend .user').textContent = single ? '我的圈選：橙色實線' : '圈選：實線（依玩家顏色）';
  $('#legend .target').textContent = landmark ? '景點：紅色圖針' : '正確邊界：綠色虛線';
  if ($('#legend-fill')) $('#legend-fill').textContent = landmark ? '虛線：距圈選最近位置' : !single && !focus ? '中立區：灰色' : '圈對：金色 · 多圈：橙色 · 漏圈：藍灰 · 中立區：灰色';
  if (single && scored) {
    const result = q.results[state.you];
    if (landmark) {
      $('#single-result').innerHTML = `<div class="result-head"><h2>本題結果</h2></div><p class="landmark-verdict">${esc(landmarkFeedback(result))}</p>${result.landmark?.hit === false ? `<p>圈選面積 ${(result.landmark.areaM2 / 1e6).toFixed(2)} km²</p>` : ''}<p class="score-message">${seconds(result.elapsed)}</p>`;
    } else $('#single-result').innerHTML = `<div class="result-head"><h2>本題結果</h2><button type="button" class="quiet" data-action="toggle-result" aria-controls="single-result-details" aria-expanded="${!collapsed}">${collapsed ? '展開' : '收合'}明細</button></div><div class="score-big">${result.score.toFixed(2)}<small>${landmark ? ' 分' : '% 吻合度'}</small></div><p class="score-message">${result.status === 'skipped' ? '已跳過 · 0 分 · ' : landmark && collapsed ? result.landmark?.hit ? '命中 · ' : '未命中 · ' : ''}${seconds(result.elapsed)}</p><div id="single-result-details" class="result-details">${landmark ? `<p>${esc(landmarkDetails(result.landmark))}</p>` : `<div class="breakdown" aria-label="占聯集面積的比例">${[['hit', '圈對'], ['extra', '多圈'], ['miss', '漏圈']].map(([key, label]) => `<div class="breakdown-row"><span>${label}</span><meter min="0" max="100" value="${result.breakdown[key]}" aria-label="${label}占聯集面積"></meter><strong>${result.breakdown[key].toFixed(2)}%</strong></div>`).join('')}</div>`}</div>`;
  }
  $('#map-overlay').hidden = !['countdown', 'scoring', 'error'].includes(state.phase);
  $('#map-overlay').textContent = state.phase === 'countdown' ? '準備圈選…' : state.phase === 'error' ? state.error : state.phase === 'scoring' ? (state.free ? waitingStatus() : '圈選已保留，計分中…') : '';
  $('#draft-status').textContent = me.spectator ? '本局觀戰' : '';
  if (activeComparison >= 0) document.querySelectorAll(comparisonButtons)[activeComparison]?.focus({ preventScroll: true });
  lastPhase = state.phase; map.render(); updateClock();
}
function updateClock() {
  if (socket instanceof MultiplayerHTTP) socket.tick();
  if (!state?.question || ['lobby', 'results'].includes(state.phase)) return;
  const q = state.question, time = now();
  const remain = ['countdown', 'answering'].includes(state.phase) ? Math.max(0, Math.ceil(((state.phase === 'countdown' ? q.start : q.deadline) - time) / 1000)) : null;
  const nextRemain = state.phase === 'reveal-scores' && q.nextAt ? Math.max(0, Math.ceil((q.nextAt - time) / 1000)) : null;
  if ($('#timer-prefix')) $('#timer-prefix').textContent = state.mode === 'single' ? (state.phase === 'reveal-scores' ? '本題用時' : '') : ({ countdown: '準備', answering: q.locked ? '已送出・倒數' : '倒數', scoring: '', 'reveal-scores': '' })[state.phase] || '';
  $('#clock').textContent = state.mode === 'single' && state.phase === 'answering' ? '不限時' : state.mode === 'single' && state.phase === 'reveal-scores' ? seconds(q.results[state.you].elapsed) : remain !== null ? String(remain) : state.phase === 'scoring' ? (state.free && !q.checking ? '等待結果' : '計分中…') : state.phase === 'reveal-scores' ? (nextRemain !== null ? `${nextRemain} 秒後${q.number === q.count ? '結算' : '換題'}` : '本題揭曉') : '—';
  $('#phase-label').textContent = state.mode === 'single' ? '' : ({ countdown: '秒後開始', answering: '秒', scoring: '', buffer: '揭曉緩衝', 'reveal-drawings': '大家圈在哪', 'reveal-answer': '正確範圍', 'reveal-scores': '', error: '計分失敗' })[state.phase] || '';
  $('#timer-pill')?.classList.toggle('is-urgent', state.mode === 'multi' && state.phase === 'answering' && !q.locked && remain !== null && remain <= 5);
  $('#timer-pill')?.classList.toggle('is-submitted', state.mode === 'multi' && state.phase === 'answering' && Boolean(q.locked));
  if (state.phase === 'answering' && q.deadline !== null && time >= q.deadline) { map.editable = false; $('#submit').disabled = true; }
  if (!state.free && state.phase === 'answering' && q.deadline !== null && !finalFlush && time >= q.deadline - 250 && time < q.deadline) { finalFlush = true; flushDraft(false, true); }
  if (state.free && ['scoring', 'error'].includes(state.phase)) $('#force').disabled = time < q.deadline + 10000;
  if (!state.free && state.phase === 'reveal-scores') {
    $('#force').disabled = time - q.scoredAt < 10000;
    $('#force').textContent = time - q.scoredAt < 10000 ? `房主換題（${Math.ceil((10000 - time + q.scoredAt) / 1000)}）` : '房主換題';
    if (state.mode === 'multi') {
      const active = state.players.filter(p => !p.spectator && p.online && !p.left);
      $('#seen-status').textContent = !active.length ? '目前沒有在線參賽者，已暫停自動換題。' : q.nextAt ? `全員看完，${Math.max(0, Math.ceil((q.nextAt - time) / 1000))} 秒後${q.number === q.count ? '結算' : '換題'}。` : `在線參賽者看完 ${active.filter(p => p.seen).length}／${active.length} 人；觀戰與離線者不阻擋換題。`;
    }
  }
}
function flushDraft(submit = false, full = false) {
  if (state?.free) {
    if (submit && (map.gesture?.drawing || map.keyboardDrawing)) { message('請先放開筆畫，或按 Enter 封閉後再送出。'); return; }
    socket.draft(map.points); if (submit) socket.freeze(map.points); return;
  }
  clearTimeout(draftTimer); draftTimer = null;
  if (!state?.question || state.phase !== 'answering' || state.question.locked || state.players.find(p => p.id === state.you)?.spectator) return;
  if (state.local) {
    const closed = !Boolean(map.gesture?.drawing || map.keyboardDrawing);
    solo.draft(map.points, closed);
    if (submit) solo.submit(state.question.id).catch(error => message(error.message));
    return;
  }
  if (!submit && socket?.readyState !== 1) return;
  if (submit && (map.gesture?.drawing || map.keyboardDrawing)) { message('請先放開筆畫，或按 Enter 封閉後再送出。'); return; }
  const next = Math.max(revision, state.question.revision) + 1;
  const value = state.draftProtocol === 1 ? draftSync.message(map.points, next, submit || full) : { points: map.points };
  if (!value) return;
  revision = next;
  send({ type: submit ? 'submit' : 'draft', questionId: state.question.id, revision, ...value });
  $('#draft-status').textContent = socket?.readyState === 1 ? (submit ? '送出中…' : '同步圈選中…') : '離線，筆畫尚未送達';
}
function comparisonScope() {
  return state.settings.challenge === 'landmark' ? { scopeOutline: map.scopeOutline, extent: extentForSettings(state.settings, data.regions, data.bounds) } : {};
}
function renderResults() {
  if (state.mode === 'multi') resetAssets();
  show('results'); const mine = state.standings.find(p => p.id === state.you), landmark = state.settings.challenge === 'landmark';
  if (state.mode === 'single') {
    const key = state.history.map(q => q.id).join(',');
    if (resultKey !== key) {
      resultKey = key;
      const skips = state.history.filter(q => q.results[state.you].status === 'skipped').length;
    $('#results').innerHTML = `<div class="report-hero"><div class="score-card">${landmark ? `<h2 class="hit-rate">${esc(landmarkSummary(state.history, state.you))}</h2>` : ''}<div class="score-card-label">本局平均${landmark ? '得分' : '吻合度'}</div><div class="score-card-value">${mine.score.toFixed(2)}<small>${landmark ? '分' : '%'}</small></div><p>總作答 ${totalTime(mine.time)}${skips ? ` · ${skips} 題跳過` : ''}</p></div><div class="report-copy"><h1>單人結算</h1><p class="settings-summary">${esc(settingsSummary(state.settings, state.history.length))}</p><div class="summary-actions"><button type="button" class="primary" data-action="share">下載圈選對照圖 ↓</button><button type="button" data-action="replay">再玩一局</button><button type="button" data-action="leave">回首頁</button></div></div></div><div class="summary-content"><div class="section-heading"><h2>逐題成績</h2><p>${landmark ? '橙色實線：你的圈選 · 紅色圖針：景點' : '橙色實線：你的圈選 · 綠色虛線：正解'}</p></div><div class="summary-list">${state.history.map((q, i) => { const r = q.results[state.you]; return `<article class="summary-item"><canvas width="440" height="320" data-comparison="${i}" data-action="zoom-review" data-index="${i}" aria-label="${esc(questionName(q))}的真實圈選與正解對照（點選放大）"></canvas><div class="summary-item-copy"><small>Q${String(i + 1).padStart(2, '0')}</small><h3>${esc(questionName(q))}</h3><strong>${score(r.score)}</strong><p>${r.status === 'skipped' ? '已跳過 · ' : ''}用時 ${seconds(r.elapsed)}</p>${landmark ? `<p>${esc(landmarkDetails(r.landmark))}</p>` : ''}<button type="button" class="text-link zoom-review-btn" data-action="zoom-review" data-index="${i}">放大檢視 ↗</button></div></article>`; }).join('')}</div></div>`;
      $('#results').insertAdjacentHTML('beforeend', '<p id="history-status" role="status"></p>');
    }
    for (const canvas of $('#results').querySelectorAll('[data-comparison]')) {
      const review = reviewAsset(state.history[Number(canvas.dataset.comparison)].id);
      if (review && !canvas.dataset.ready) { comparison(canvas.getContext('2d'), data, review, state.you, 0, 0, canvas.width, canvas.height, comparisonScope()); canvas.dataset.ready = 'true'; }
    }
    const complete = state.history.every(q => reviews.has(q.id));
    $('#results [data-action="share"]').disabled = !complete;
    $('#history-status').innerHTML = reviewFailed.size ? '部分對照圖載入失敗。 <button data-action="retry-reveal">重試揭曉圖形</button>' : complete ? '' : '載入逐題對照圖…';
    return;
  }
  const host = state.hostId === state.you;
  $('#results').innerHTML = `<div class="report-hero"><div class="score-card"><div class="score-card-label">${mine?.rank == null ? '本局無有效成績' : `本局第 ${mine.rank} 名 · 你的積分`}</div><div class="score-card-value">${mine?.rank == null ? '—' : `${mine.points}<small> 點</small>`}</div><p>${mine ? `平均${landmark ? '得分' : '吻合度'} ${score(mine.score)} · 總作答 ${totalTime(mine.time)}` : `共 ${state.standings.length} 位參賽者完成本局`}</p></div><div class="report-copy"><h1>多人結算</h1><p class="settings-summary">${esc(settingsSummary(state.settings, state.history.length))}</p>${!host && state.free ? '<p>等待房主返回大廳，請手動查看狀態。</p>' : ''}<div class="summary-actions"><button type="button" class="primary" data-action="replay">${!host && state.free ? '查看大廳狀態' : '返回大廳'}</button><button type="button" data-action="share">下載成績圖 ↓</button><button type="button" data-action="leave">離開／重新開房</button></div></div></div>
    <div class="summary-content"><div class="section-heading"><h2>整局排名</h2><p>${esc(multiplayerRulesText(state.rulesVersion, state.settings.challenge))}</p></div><div class="table-wrap results-ranking"><table><thead><tr><th>名次／玩家</th><th>積分</th><th>平均</th><th>總時間</th>${state.history.map((q, i) => `<th class="desktop-rounds">${i + 1}. ${esc(questionName(q))}</th>`).join('')}</tr></thead><tbody>${state.standings.map(p => `<tr class="${p.id === state.you ? 'is-you' : ''}"><td><strong class="rank-num">${p.rank == null ? '—' : '#' + p.rank}</strong><span class="player-name" data-text-color="${p.color}"><i class="dot" data-color="${p.color}"></i>${playerIdentity(p)}</span>${p.left ? '（已離開／未完成）' : ''}</td><td><strong>${p.points} 點</strong></td><td>${score(p.score)}</td><td>${totalTime(p.time)}</td>${p.perQuestion.map(q => `<td class="desktop-rounds">${esc(roundScoreText(q, state.settings.challenge))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <details class="mobile-rounds"><summary>逐題成績（${state.history.length} 題）</summary>${state.history.map((q, i) => `<section><h3>${i + 1}. ${esc(questionName(q))}</h3><table aria-label="${esc(questionName(q))}逐題成績"><thead><tr><th>玩家</th><th>成績</th></tr></thead><tbody>${state.standings.map(p => `<tr class="${p.id === state.you ? 'is-you' : ''}"><td>${playerIdentity(p)}</td><td>${esc(roundScoreText(p.perQuestion[i], state.settings.challenge))}</td></tr>`).join('')}</tbody></table></section>`).join('')}</details></div>`;
  for (const el of $('#results').querySelectorAll('[data-color]')) el.style.backgroundColor = el.dataset.color;
  for (const el of $('#results').querySelectorAll('[data-text-color]')) el.style.color = el.dataset.textColor;
}
function openReviewModal(index) {
  const q = state?.history?.[index]; if (!q) return;
  const review = reviews.get(q.id);
  if (!review) { message('對照圖尚在載入中，請稍候。', 'info'); return; }
  const r = q.results[state.you];
  $('#review-dialog-title').textContent = `Q${String(index + 1).padStart(2, '0')} · ${questionName(q)}`;
  $('#review-dialog-meta').textContent = `${state.settings.challenge === 'landmark' ? '得分' : '吻合度'} ${score(r.score)}${r.status === 'skipped' ? '（已跳過）' : ''} · 用時 ${seconds(r.elapsed)}`;
  const canvas = $('#review-dialog-canvas');
  comparison(canvas.getContext('2d'), data, review, state.you, 0, 0, canvas.width, canvas.height, comparisonScope());
  $('#review-dialog .pool-note').textContent = review.targetPoint ? landmarkDetails(r.landmark) + '；紅色圖針為景點，虛線連至圈選最近位置。' : '橙色實線：你的圈選 · 綠色虛線：正確邊界 · 金色：圈對 · 橙色：多圈 · 藍灰：漏圈 · 灰色：中立區';
  $('#review-dialog').showModal();
}
function downloadScore() {
  let cv;
  try {
  if (state.mode === 'single') {
    if (!state.history.every(q => reviews.has(q.id))) { message('請等待逐題對照圖載入完成，再下載成績圖。'); return; }
    cv = scoreImage(data, { ...state, history: state.history.map(q => reviews.get(q.id)) }, comparisonScope());
    const link = document.createElement('a'); link.download = 'circle-taiwan-comparison.png'; link.href = cv.toDataURL('image/png'); link.click(); return;
  }
  cv = multiplayerScoreImage(data, state);
  const link = document.createElement('a'); link.download = 'circle-taiwan-score.png'; link.href = cv.toDataURL('image/png'); link.click();
  } catch (error) { message(`成績圖產生失敗，成績仍保留。請重試下載：${error.message}`); }
  finally { if (cv) cv.width = cv.height = 0; }
}

document.addEventListener('submit', async e => {
  if (e.target.closest('dialog')) return;
  e.preventDefault(); clearMessage();
  if (e.target.id === 'setup') {
    if (mode === 'multi' && homeEntry === 'join') { joinRoom(joinCode, false); return; }
    const form = e.target, chosenMode = mode;
    nickname = form.elements.nickname.value.trim(); settings = formSettings(form, settings); try { localStorage.setItem('circle-nickname', nickname); } catch {}
    const chosen = { ...settings };
    for (const control of form.querySelectorAll('input,select,button')) control.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      if (chosenMode === 'single') {
        await runLocal();
      } else { autoStart = false; connect({ type: 'create', mode: chosenMode, nickname, settings: chosen }); }
    } catch (error) { message(error.message); }
    finally { for (const control of form.querySelectorAll('input,select,button')) control.disabled = false; form.removeAttribute('aria-busy'); }
  } else if (e.target.id === 'join') joinRoom(e.target.elements.code.value, false);
});
function joinRoom(code, spectator) {
  const name = $('#setup')?.elements.nickname;
  if (name && !name.reportValidity()) return;
  code = (code || '').trim().toUpperCase();
  if (!code) { $('#join')?.elements.code?.focus(); message('請先輸入 6 碼房間代碼。'); return; }
  nickname = $('#setup')?.elements.nickname.value.trim() || nickname; try { localStorage.setItem('circle-nickname', nickname); } catch {}
  autoStart = false; connect({ type: 'join', code, nickname, spectator });
}

document.addEventListener('input', e => {
  if (e.target.name === 'nickname' && e.target.closest('#setup')) nickname = e.target.value;
  if (e.target.id === 'room-code') joinCode = e.target.value;
});
document.addEventListener('keydown', e => {
  if (!e.target.matches('[data-action="ranking-view"]')) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  rankingView = e.key === 'Home' ? 'round' : e.key === 'End' ? 'total' : rankingView === 'round' ? 'total' : 'round';
  renderState(); $(`[data-action="ranking-view"][data-view="${rankingView}"]`).focus();
});
document.addEventListener('change', e => {
  if (!e.target.matches('[data-setting]')) return;
  clearMessage(); const form = e.target.closest('form');
  if (form.id === 'setup') { nickname = form.elements.nickname.value; settings = formSettings(form, settings); renderHome(); }
  else if (form.id === 'room-settings') send({ type: 'settings', settings: formSettings(form, state.settings) });
});
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action; clearMessage();
  if (action === 'home') e.preventDefault();
  if (!map && !['help', 'reload-page'].includes(action)) return;
  try {
    if (action === 'help') {
      const multi = (state?.mode || mode) === 'multi';
      $('#help-single').hidden = multi; $('#help-multi').hidden = !multi;
      const landmark = (state?.settings || settings).challenge === 'landmark', unit = landmark ? '分' : '%';
      $('#help-administrative').hidden = landmark; $('#help-landmark').hidden = !landmark;
      $('#help-clues').textContent = landmark ? '全島初階顯示縣市界，高階只有海岸線；縣市局初階顯示外框與鄉鎮界，高階只有該縣市外框。題庫與線索難度獨立，均不顯示地名或地形。' : '行政區初階提供地形、河川與道路，高階只留海岸輪廓；兩者都隱藏地名與行政界線，計分相同。';
      $('#multi-scoring-rule').textContent = multiplayerRulesText(state?.rulesVersion, landmark ? 'landmark' : 'county');
      $('#multi-scoring-details').textContent = `每題以兩位小數的成績排名，並列採 1、1、3。名次分依開局人數由 8 至 1 點分配，且不超過成績每滿 10${unit} 的點數；再加神準獎勵：75${unit} 起加 1 點，90${unit} 起改加 2 點。未作答或無效筆畫為 0 點，離場不改變本局人數；時間只供檢視。`;
      $('#multi-scoring-details').hidden = state?.rulesVersion === 'circle-taiwan-0.5';
      $('#help-dialog').showModal();
    }
    else if (action === 'dismiss-hint') { gestureHintDismissed = true; $('#map-help').hidden = true; }
    else if (action === 'retry-local-load') await bootstrapRetry?.();
    else if (action === 'retry-clues') { vectorViewport = null; queueViewportClues(); }
    else if (action === 'use-hard') { settings.difficulty = 'hard'; await runLocal(); }
    else if (action === 'back-home') leaveHome();
    else if (action === 'finish-stroke') { map.keyboardDrawing = false; flushDraft(false, true); renderState(); }
    else if (action === 'toggle-result') {
      $('#play').classList.toggle('result-collapsed'); renderState(); map.resize();
    } else if (action === 'toggle-players') {
      playersExpanded = !playersExpanded; renderState(); map.resize();
    } else if (action === 'ranking-view') {
      rankingView = button.dataset.view; renderState(); $(`[data-action="ranking-view"][data-view="${rankingView}"]`).focus();
    } else if (action === 'entry-join' || action === 'entry-create') {
      homeEntry = action === 'entry-join' ? 'join' : 'create'; renderHome();
      $(`[data-action="${action}"]`).focus();
    } else if (action === 'choose-setting') {
      const form = button.closest('form'), key = button.dataset.settingKey;
      const s = fixSelection({ ...formSettings(form, form.id === 'setup' ? settings : state.settings), [key]: key === 'count' ? Number(button.dataset.value) : button.dataset.value }, state?.mode || mode);
      if (form.id === 'setup') { nickname = form.elements.nickname.value; settings = s; renderHome(); }
      else send({ type: 'settings', settings: s });
    } else if (action.endsWith('-mode')) { nickname = $('#setup')?.elements.nickname.value || nickname; mode = action === 'single-mode' ? 'single' : 'multi'; if (mode === 'multi') { data = defaultData; map.data = data; } renderHome(); }
    else if (action === 'reload-page') location.reload();
    else if (action === 'join-room') joinRoom($('#join').elements.code.value, false);
    else if (action === 'zoom-review') openReviewModal(Number(button.dataset.index));
    else if (action === 'ready') send({ type: 'ready', ready: !state.players.find(p => p.id === state.you).ready });
    else if (action === 'calculation-failed') send({ type: 'calculation-failed' });
    else if (action === 'retry-load') { roomLoadKey = null; roomLoadError = ''; renderState(); }
    else if (action === 'retry-reveal') { assets.failed.clear(); reviewFailed.clear(); renderState(); }
    else if (action === 'start') {
      const me = state.players.find(p => p.id === state.you);
      if (state.mode === 'multi' && me && !me.spectator && !me.ready) send({ type: 'ready', ready: true });
      send({ type: 'start', questionId: state.question?.id });
    }
    else if (action === 'seen' || action === 'force-next' || action === 'force-settle' || action === 'retry') send({ type: action, questionId: state.question?.id });
    else if (action === 'next' || action === 'skip-question') { if (send({ type: action, questionId: state.question.id }) && !state.local) button.disabled = true; }
    else if (action === 'replay') { if (state.local) await runLocal(); else { autoStart = state.mode === 'single'; send({ type: 'replay' }); } }
    else if (action === 'submit') flushDraft(true);
    else if (action === 'clear') { if (state?.local && state.phase === 'error') solo.redraw(); map.clear(); }
    else if (action === 'undo') map.undo();
    else if (['draw', 'move'].includes(action)) { map.mode = action; renderState(); }
    else if (action === 'zoom-in') map.zoom(1.4);
    else if (action === 'zoom-out') map.zoom(1 / 1.4);
    else if (action === 'home-map') {
      const r = map.reveal;
      if (r?.targetPoint) {
        const points = r.players.filter(p => !r.focus || r.focus === p.id).flatMap(p => p.points);
        map.fit(points.length ? comparisonBounds([], points, r.targetPoint) : state.question.extent);
      }
      else map.fit(state.question.extent);
    }
    else if (action === 'compare') { const target = button.dataset.player || null; focus = target && focus === target ? null : target; renderState(); }
    else if (action === 'kick' && confirm('確定要移除這位玩家？')) send({ type: 'kick', playerId: button.dataset.player });
    else if (action === 'leave' || action === 'home') { if (state?.free) { socket.removePending(); socket.command({ type: 'leave' }).catch(() => {}); } else if (state) await send({ type: 'leave' }); leaveHome(); }
    else if (action === 'copy-invite') {
      const url = new URL(location.href); url.search = ''; url.searchParams.set('room', state.code);
      try {
        await navigator.clipboard.writeText(url.href);
        button.textContent = '✓ 已複製邀請連結';
        setTimeout(() => { if (button.isConnected) button.textContent = '複製邀請連結'; }, 2000);
        message('已複製邀請連結；把連結傳給朋友即可加入。', 'info');
      }
      catch { $('#manual-invite').hidden = false; const field = $('#invite-url'); field.value = url.href; field.focus(); field.select(); }
    }
    else if (action === 'share') downloadScore();
  } catch (error) { message(error.message); }
});

async function runLocal() {
  const generation = ++bootstrapGeneration; bootstrappingLocal = true; mode = 'single';
  bootstrapEngine?.close(); solo?.stop(); solo = null;
  if (socket) { socket.intentional = true; socket.close(); socket = null; }
  persistSession(null); session = null;
  clearTimeout(reconnectTimer); clearTimeout(draftTimer); clearTimeout(vectorTimer); vectorController?.abort(); vectorView = null; vectorViewport = null;
  resetReviews(); resetAssets(); state = null;
  $('#clue-status').textContent = '';
  bootstrapRetry = runLocal;
  show('lobby'); $('#lobby').setAttribute('aria-label', '準備單人挑戰');
  $('#lobby').innerHTML = `<div class="card"><h1>準備單人挑戰</h1><p id="startup-status" role="status"></p><button data-action="back-home">返回設定</button></div>`;
  const stages = { 題目: '準備中', ...(settings.challenge === 'landmark' ? { 行政邊界: '等待中' } : settings.difficulty === 'easy' ? { 地形: '等待中', 道路與河川: '等待地形' } : {}) };
  let clueFailure = false, failedStage = '';
  const current = () => generation === bootstrapGeneration && bootstrappingLocal;
  const progress = (stage, done = false) => {
    if (!current()) return;
    stages[stage] = done ? '已就緒' : '準備中';
    $('#startup-status').textContent = Object.entries(stages).map(([name, status]) => `${name}：${status}`).join('；');
  };
  progress('題目');
  try {
    data = defaultData;
    if (map.data !== data) { map.baseKey = null; map.baseContentKey = null; map.vectorPaths = null; } map.data = data;
    const selected = selectQuestions(data, settings); settings = { ...selected.settings };
    const engine = bootstrapEngine = new SoloEngine(staticManifest, data, selected.questions,
      settings.challenge === 'landmark' ? landmarkRulesForSettings(settings, data.regions.find(r => r.id === settings.county)?.areaM2) : undefined);
    await Promise.all([
      engine.ready().then(() => progress('題目', true)).catch(error => { failedStage ||= '題目'; throw error; }),
      prepareClues(settings, current, progress).catch(error => { clueFailure = true; failedStage ||= error.clueStage || '地形'; throw error; })
    ]);
    if (generation !== bootstrapGeneration) { engine.close(); return; }
    const record = createSoloRecord(settings, selected.questions, nickname);
    bootstrapEngine = null; bootstrappingLocal = false; roomLoadReady = true; roomLoadError = ''; roomLoadKey = null; clockOffset = 0; lastQuestion = null; lastPhase = null;
    solo = new SoloGame(record, { data, engine, onChange(value) { if (!solo?.active) return; state = value; $('#connection').textContent = ''; renderState(); }, onMessage: message });
    solo.publish();
  } catch (error) {
    if (generation !== bootstrapGeneration) return;
    bootstrappingLocal = false; bootstrapEngine?.close(); bootstrapEngine = null; vectorController?.abort(); vectorView = null;
    $('#lobby').innerHTML = `<div class="card"><h1>${failedStage || '資料'}尚未就緒</h1><p role="alert">${esc(error.message)}</p><div class="row"><button class="primary" data-action="retry-local-load">重試${failedStage || '載入'}</button>${clueFailure ? '<button data-action="use-hard">改用高階線索</button>' : ''}<button data-action="back-home">返回首頁</button></div></div>`;
    focusHeading('#lobby h1');
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden && state?.local) flushDraft(false, true); });

try {
  const response = await fetch('/assets/current.json'); if (!response.ok) throw new Error('圖資索引載入失敗，請先執行 npm run build:static');
  staticManifest = await response.json(); localAssets = new SoloAssets(staticManifest); data = defaultData = await localAssets.catalog();
  try {
    const response = await fetch('/environment.json'); if (!response.ok) throw new Error();
    environment = await response.json();
    if (!['local', 'coming', 'available', 'unavailable'].includes(environment.multiplayer) || (environment.multiplayer === 'available' && !/^https?:$/.test(new URL(environment.url).protocol))) throw new Error();
  } catch { environment = { multiplayer: 'unavailable', url: null }; }
  map = new GameMap($('#map'), data, { onMessage: message, onViewChange: queueViewportClues, onChange(points, immediate) {
    $('#submit').disabled = !map.editable || points.length < 3 || Boolean(map.gesture?.drawing || map.keyboardDrawing);
    $('#draft-status').textContent = state?.local || state?.free ? '' : '圈選尚未同步';
    if (state?.free) { socket.draft(points); return; }
    $('#undo').disabled = !map.editable || !map.beforeStroke || Boolean(map.gesture?.drawing);
    if (state?.local) $('#finish-stroke').hidden = !map.keyboardDrawing;
    if (immediate) flushDraft(false, true); else if (!draftTimer) draftTimer = setTimeout(() => flushDraft(), 160);
  } });
  for (const button of $('#mode-tabs').querySelectorAll('button')) button.disabled = false;
  $('#connection').textContent = ''; renderHome(); setInterval(updateClock, 100);
  let stored; try { stored = sessionStorage.getItem('circle-session'); } catch {}
  const invite = new URLSearchParams(location.search).get('room');
  const saved = savedSession(stored, invite);
  if (stored && !saved) persistSession(null);
  if (saved && environment.multiplayer === 'local') { session = saved; autoStart = session.mode === 'single'; connect({ type: 'resume', code: session.code, token: session.token }); }
  else if (invite) { if (stored) persistSession(null); session = null; mode = 'multi'; homeEntry = 'join'; joinCode = invite; renderHome(); }
} catch (error) { show('home'); $('#home-form').innerHTML = '<div class="card"><h1>資料尚未就緒</h1><p>請重試載入資料。</p><button data-action="reload-page">重試載入</button></div>'; message(`無法初始化：${error.message}`); }
