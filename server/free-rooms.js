import { COUNTS, TIMES, MAX_POINTS, standings } from '../shared/rules.js';

const TTL = 30 * 60 * 1000, BUFFER = 6000, GRACE = 10000, BODY_LIMIT = 128 * 1024;
const COLORS = ['#D55E00', '#0072B2', '#CC79A7', '#9A7300', '#5B3F8C', '#009E73', '#B14444', '#495057'];
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (message, status = 400, code = 'invalid') => Object.assign(new Error(message), { status, code });
const ident = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const key = () => crypto.randomUUID();
function nickname(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 16 || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('暱稱需為 1～16 個可顯示字元');
  return value.trim();
}
function plan(input) {
  const s = input.settings, q = input.questions, v = input.versions;
  if (!s || !COUNTS.multi.includes(s.count) || !TIMES.includes(s.seconds) || !Number.isInteger(s.capacity) || s.capacity < 2 || s.capacity > 8 ||
    !['county', 'town', 'village'].includes(s.challenge) || !['easy', 'hard'].includes(s.difficulty) || !['mainland', 'county', 'town'].includes(s.scope)) throw fail('遊戲設定無效');
  if (!Array.isArray(q) || !q.length || q.length > s.count || new Set(q).size !== q.length || q.some(id => typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id))) throw fail('題目清單無效');
  if (!v || ['dataVersion', 'rulesVersion', 'runtimeVersion'].some(k => typeof v[k] !== 'string' || v[k].length > 128 || !v[k])) throw fail('圖資版本無效');
  const settings = { challenge: s.challenge, difficulty: s.difficulty, scope: s.scope, county: String(s.county || '').slice(0,40), town: String(s.town || '').slice(0,40), count:s.count, seconds:s.seconds, capacity:s.capacity };
  return [JSON.stringify(settings), JSON.stringify(q), JSON.stringify(v)];
}
function answer(input, room) {
  const a = input.answer, seconds = JSON.parse(room.settings).seconds;
  if (!a || !ident(a.submissionId) || !['ok','invalid','unanswered','calculation_failed'].includes(a.status) || !Array.isArray(a.points) || a.points.length > MAX_POINTS) throw fail('交卷格式無效');
  for (const p of a.points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 1e8 || Math.abs(p[1]) > 1e8) throw fail('交卷格式無效');
  }
  if (!Number.isFinite(a.elapsed) || a.elapsed < 0 || a.elapsed > seconds * 1000) throw fail('作答時間無效');
  if (a.status === 'ok' && (!Number.isFinite(a.score) || a.score < 0 || a.score > 100 || a.points.length < 3)) throw fail('成績格式無效');
  return { ...a, score: a.status === 'calculation_failed' ? null : a.status === 'ok' ? a.score : 0,
    elapsed: ['invalid','unanswered'].includes(a.status) ? seconds * 1000 : a.elapsed };
}

export function createFreeWorker({ now = Date.now, logError = error => console.error('Room API failure', error) } = {}) {
  const cleanup = async env => env.DB.prepare('DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 8)').bind(now()).run();
  function sweep(env, ctx) { const job = cleanup(env).catch(logError); if (ctx?.waitUntil) ctx.waitUntil(job); return job; }
  const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
  async function read(env, code, token, version, includeDetails = true) {
    // Keep metadata and sealed scores in the same snapshot across replay/next transactions.
    const [rs, ps, answers] = await env.DB.batch([
      stmt(env, 'SELECT * FROM rooms WHERE code = ?', code),
      stmt(env, 'SELECT p.*, a.status AS answer_status FROM room_players p JOIN rooms r ON r.id=p.room_id LEFT JOIN room_answers a ON a.room_id=r.id AND a.game_id=r.game_id AND a.round_id=r.round_id AND a.player_id=p.id WHERE r.code=? ORDER BY p.seat', code),
      ...(includeDetails ? [stmt(env,"SELECT a.round_id,a.round_index,a.player_id,a.status,a.score,a.elapsed FROM room_answers a JOIN rooms r ON a.room_id=r.id AND a.game_id=r.game_id WHERE r.code=? AND r.metadata_version<>? AND (a.round_index<r.round_index OR r.phase IN ('reveal','results')) ORDER BY a.round_index",code,Number.isFinite(Number(version))?Number(version):-1)] : [])
    ]);
    const r = rs.results[0], players = ps.results;
    if (!r || r.expires_at <= now()) throw fail('房間已過期或關閉，請重新開房。', 410, 'room_closed');
    const me = players.find(p => p.token === token && !p.left);
    if (!me) throw fail('房間身分已失效，請重新加入。', 403, 'identity_lost');
    const summary = { room:r.id, game:r.game_id, round:r.round_id, phase:r.phase, index:r.round_index, start:r.start_at, deadline:r.deadline,
      expires:r.expires_at, now:now(), version:r.version, metadata:r.metadata_version, plan:r.plan_version,
      host:players.find(p=>p.id===r.host_id)?.seat, you:me.seat, players:players.map(p=>[p.seat,p.ready,p.loaded_version===r.plan_version?1:0,p.left,p.answer_status||null]) };
    if (new TextEncoder().encode(JSON.stringify(summary)).byteLength > 1024) throw new Error('Room summary exceeds 1 KiB');
    const response = { summary };
    if (includeDetails && Number(version) !== r.metadata_version) {
      const questions = JSON.parse(r.questions), settings = JSON.parse(r.settings);
      const roster = players.filter(p=>r.phase === 'lobby' ? !p.left : p.in_game).map(p=>({id:p.id,seat:p.seat,name:p.name,color:COLORS[p.seat],left:Boolean(p.left)}));
      const rows = answers.results;
      const rounds = [];
      for (const a of rows) {
        let round = rounds.find(q=>q.id===a.round_id);
        if (!round) { round={id:a.round_id,regionId:questions[a.round_index],index:a.round_index,results:{}};rounds.push(round); }
        round.results[a.player_id]={status:a.status,score:a.score,elapsed:a.elapsed};
      }
      for (const round of rounds) round.voided=Object.values(round.results).some(a=>a.status==='calculation_failed');
      const current = rounds.find(q=>q.id===r.round_id);
      response.details = { code:r.code,settings,questions,versions:JSON.parse(r.versions),players:roster,rounds,
        roundStandings:current?standings(roster,[current],settings.seconds,'multi'):null,
        cumulativeStandings:rounds.length?standings(roster,rounds,settings.seconds,'multi'):null };
    }
    return { response, room:r, player:me, players };
  }
  async function command(env, input, token, ctx) {
    const at=now(), until=at+TTL, type=input.type;
    if (!ident(input.requestId)) throw fail('請求識別無效');
    if (type==='create') {
      await cleanup(env);
      const [settings,questions,versions]=plan(input), name=nickname(input.nickname), id=key(), player=key(), secret=key()+key();
      const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let attempt=0;attempt<5;attempt++) {
        const code=Array.from(crypto.getRandomValues(new Uint8Array(6)),b=>alphabet[b%32]).join('');
        await env.DB.batch([
          stmt(env,"INSERT OR IGNORE INTO rooms(id,code,creation_key,host_id,settings,questions,versions,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM rooms)<64",id,code,input.requestId,player,settings,questions,versions,until),
          stmt(env,'INSERT OR IGNORE INTO room_players(room_id,id,token,join_key,name,seat) SELECT ?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM rooms WHERE id=?)',id,player,secret,input.requestId,name,id)
        ]);
        const row=await stmt(env,'SELECT r.code,p.id,p.token FROM rooms r JOIN room_players p ON p.id=r.host_id WHERE r.creation_key=?',input.requestId).first();
        if (row) return { ...(await read(env,row.code,row.token)).response,session:{code:row.code,id:row.id,token:row.token,mode:'multi'} };
      }
      throw fail('目前房間已滿，請稍後再試。',503,'rooms_full');
    }
    const code=String(input.code||'').toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) throw fail('請輸入六碼房號');
    if (type==='join') {
      const r=await stmt(env,'SELECT * FROM rooms WHERE code=?',code).first();
      if (!r || r.expires_at<=at) throw fail('房間已過期或關閉。',410,'room_closed');
      if (r.phase!=='lobby') throw fail('本局已開始，請等待下局再加入。',409,'game_started');
      if (JSON.stringify(input.versions)!==r.versions) throw fail('遊戲版本不同，請重新整理後再加入。',409,'version_mismatch');
      const name=nickname(input.nickname),id=key(),secret=key()+key(),capacity=JSON.parse(r.settings).capacity;
      await env.DB.batch([
        stmt(env,"INSERT OR IGNORE INTO room_players(room_id,id,token,join_key,name,seat) SELECT ?,?,?,?,?,(SELECT MIN(value) FROM json_each('[0,1,2,3,4,5,6,7]') WHERE value NOT IN(SELECT seat FROM room_players WHERE room_id=?)) WHERE EXISTS(SELECT 1 FROM rooms WHERE id=? AND phase='lobby' AND expires_at>? AND plan_version=?) AND (SELECT COUNT(*) FROM room_players WHERE room_id=?)<?",r.id,id,secret,input.requestId,name,r.id,r.id,at,r.plan_version,r.id,capacity),
        stmt(env,'UPDATE rooms SET expires_at=?,metadata_version=metadata_version+1,version=version+1 WHERE id=? AND changes()=1',until,r.id)
      ]);
      const p=await stmt(env,'SELECT id,token FROM room_players WHERE room_id=? AND join_key=?',r.id,input.requestId).first();
      if (!p) throw fail('房間已開始或參賽席位已滿。',409,'seats_full');
      return { ...(await read(env,code,p.token)).response,session:{code,id:p.id,token:p.token,mode:'multi'} };
    }
    const initial=await read(env,code,token,input.metadata,false),r=initial.room,p=initial.player;
    const host=()=>{if(p.id!==r.host_id)throw fail('只有房主可以操作。',403,'host_only');};
    const round=()=>{if(input.gameId!==r.game_id||input.questionId!==r.round_id)throw fail('回合已更新。',409,'round_changed');};
    const active="id=? AND expires_at>?";
    if (type==='resume' || type==='poll') return (await read(env,code,token,input.metadata)).response;
    if (type==='leave' || type==='kick') {
      if(type==='kick')host();
      const target=type==='kick'?input.playerId:p.id;
      if(target===r.host_id){await stmt(env,'DELETE FROM rooms WHERE id=? AND host_id=?',r.id,p.id).run();return{closed:true};}
      await env.DB.batch([
        stmt(env,"DELETE FROM room_players WHERE room_id=? AND id=? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND phase='lobby')",r.id,target,r.id),
        stmt(env,'UPDATE room_players SET left=1,ready=0 WHERE room_id=? AND id=?',r.id,target),
        stmt(env,'UPDATE rooms SET metadata_version=metadata_version+1,version=version+1 WHERE id=?',r.id)
      ]);
      if(type==='leave')return{closed:true};
    } else if(type==='settings' || type==='replay') {
      host();const [settings,questions,versions]=plan(input);
      if(JSON.parse(settings).capacity<initial.players.filter(player=>!player.left).length)throw fail('容量不能少於目前玩家人數。');
      if(type==='settings' && input.revision!==r.plan_version)throw fail('設定已更新，請重新確認。',409,'state_changed');
      if(type==='replay' && input.gameId!==r.game_id)throw fail('本局已更新。',409,'round_changed');
      const expected=type==='settings'?'lobby':'results';
      const result=await env.DB.batch([
        stmt(env,`UPDATE rooms SET settings=?,questions=?,versions=?,phase='lobby',game_id=NULL,round_id=NULL,round_index=0,start_at=NULL,deadline=NULL,plan_version=plan_version+1,metadata_version=metadata_version+1,version=version+1,expires_at=? WHERE ${active} AND phase=? AND version=?`,settings,questions,versions,until,r.id,at,expected,r.version),
        stmt(env,'UPDATE room_players SET ready=0,loaded_version=0,in_game=0 WHERE room_id=? AND changes()>0',r.id),
        stmt(env,"DELETE FROM room_answers WHERE room_id=? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND phase='lobby' AND plan_version=?)",r.id,r.id,r.plan_version+1),
        stmt(env,"DELETE FROM room_players WHERE room_id=? AND left=1 AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND phase='lobby')",r.id,r.id)
      ]);
      if(!result[0].meta.changes)throw fail('房間狀態已更新，請重新確認。',409,'state_changed');
    } else if(type==='loaded' || type==='ready') {
      if(input.revision!==r.plan_version)throw fail('設定已更新，請重新載入。',409,'state_changed');
      if(type==='loaded' && JSON.stringify(input.versions)!==r.versions)throw fail('圖資版本不同，請重新整理。',409,'version_mismatch');
      await env.DB.batch([
        stmt(env,`UPDATE room_players SET ${type==='loaded'?'loaded_version=?':'ready=?'} WHERE room_id=? AND id=? AND left=0 AND EXISTS(SELECT 1 FROM rooms WHERE ${active} AND phase='lobby' AND plan_version=?) AND ${type==='loaded'?'loaded_version<>?':'loaded_version=? AND ready<>?'}`,
          type==='loaded'?r.plan_version:input.ready?1:0,r.id,p.id,r.id,at,r.plan_version,r.plan_version,...(type==='ready'?[input.ready?1:0]:[])),
        stmt(env,'UPDATE rooms SET version=version+1,expires_at=? WHERE id=? AND changes()=1',until,r.id)
      ]);
    } else if(type==='start') {
      host();const game=key(),question=key(),deadline=at+BUFFER+JSON.parse(r.settings).seconds*1000;
      const results=await env.DB.batch([
        stmt(env,`UPDATE rooms SET phase='playing',game_id=?,round_id=?,round_index=0,start_at=?,deadline=?,version=version+1,metadata_version=metadata_version+1,expires_at=? WHERE ${active} AND phase='lobby' AND plan_version=? AND (SELECT COUNT(*) FROM room_players WHERE room_id=rooms.id AND left=0)>=2 AND NOT EXISTS(SELECT 1 FROM room_players WHERE room_id=rooms.id AND left=0 AND (ready=0 OR loaded_version<>rooms.plan_version))`,game,question,at+BUFFER,deadline,until,r.id,at,input.revision),
        stmt(env,'UPDATE room_players SET in_game=1 WHERE room_id=? AND left=0 AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND game_id=?)',r.id,r.id,game)
      ]);
      if(!results[0].meta.changes)throw fail('所有參賽者須載入並準備完成後才能開始。',409,'not_ready');
    } else if(type==='submit') {
      const a=answer(input,r),points=JSON.stringify(a.points);
      const previous=await stmt(env,'SELECT submission_id,status,score,elapsed FROM room_answers WHERE room_id=? AND game_id=? AND round_id=? AND player_id=?',r.id,input.gameId,input.questionId,p.id).first();
      if(previous){if(previous.submission_id!==a.submissionId)throw fail('本題已交卷，不能覆寫。',409,'answer_locked');return{...(await read(env,code,token,input.metadata)).response,receipt:previous};}
      round();
      const result=await env.DB.batch([
        stmt(env,"INSERT OR IGNORE INTO room_answers(room_id,game_id,round_id,round_index,player_id,submission_id,status,score,elapsed,points) SELECT r.id,r.game_id,r.round_id,r.round_index,?,?,?,?,?,? FROM rooms r JOIN room_players p ON p.room_id=r.id AND p.id=? WHERE r.id=? AND r.game_id=? AND r.round_id=? AND r.phase='playing' AND r.start_at<=? AND r.expires_at>? AND p.in_game=1 AND p.left=0",p.id,a.submissionId,a.status,a.score,a.elapsed,points,p.id,r.id,input.gameId,input.questionId,at,at),
        stmt(env,"UPDATE rooms SET phase=CASE WHEN (SELECT COUNT(*) FROM room_answers WHERE room_id=rooms.id AND round_id=rooms.round_id)=(SELECT COUNT(*) FROM room_players WHERE room_id=rooms.id AND in_game=1) THEN 'reveal' ELSE phase END, metadata_version=metadata_version+CASE WHEN (SELECT COUNT(*) FROM room_answers WHERE room_id=rooms.id AND round_id=rooms.round_id)=(SELECT COUNT(*) FROM room_players WHERE room_id=rooms.id AND in_game=1) THEN 1 ELSE 0 END,version=version+1,expires_at=? WHERE id=? AND changes()=1",until,r.id)
      ]);
      const receipt=await stmt(env,'SELECT submission_id,status,score,elapsed FROM room_answers WHERE room_id=? AND game_id=? AND round_id=? AND player_id=?',r.id,input.gameId,input.questionId,p.id).first();
      if(!receipt || receipt.submission_id!==a.submissionId)throw fail('回合已封存，無法補交。',409,'round_closed');
      const response=(await read(env,code,token,input.metadata)).response;
      if(result[0].meta.changes && response.summary.phase==='reveal')sweep(env,ctx);
      return{...response,receipt};
    } else if(type==='force-settle') {
      host();round();if(at<r.deadline+GRACE)throw fail('寬限時間結束後才能強制結算。',409,'grace_active');
      await env.DB.batch([
        stmt(env,"INSERT OR IGNORE INTO room_answers(room_id,game_id,round_id,round_index,player_id,submission_id,status,score,elapsed,points) SELECT r.id,r.game_id,r.round_id,r.round_index,p.id,'forced:'||p.id,'forced_missing',0,?,NULL FROM rooms r JOIN room_players p ON p.room_id=r.id AND p.in_game=1 WHERE r.id=? AND r.game_id=? AND r.round_id=? AND r.phase='playing' AND r.expires_at>? AND r.deadline+10000<=?",JSON.parse(r.settings).seconds*1000,r.id,r.game_id,r.round_id,at,at),
        stmt(env,"UPDATE rooms SET phase='reveal',metadata_version=metadata_version+1,version=version+1,expires_at=? WHERE id=? AND game_id=? AND round_id=? AND phase='playing' AND expires_at>? AND deadline+10000<=?",until,r.id,r.game_id,r.round_id,at,at)
      ]);sweep(env,ctx);
    } else if(type==='next' || type==='force-next') {
      host();round();const last=r.round_index+1>=JSON.parse(r.questions).length,question=last?null:key();
      const result=await env.DB.batch([
        stmt(env,"UPDATE rooms SET phase=?,round_id=?,round_index=?,start_at=?,deadline=?,version=version+1,metadata_version=metadata_version+1,expires_at=? WHERE id=? AND game_id=? AND round_id=? AND phase='reveal' AND expires_at>?",last?'results':'playing',question,r.round_index+(last?0:1),last?null:at+BUFFER,last?null:at+BUFFER+JSON.parse(r.settings).seconds*1000,until,r.id,r.game_id,r.round_id,at),
        stmt(env,'UPDATE room_answers SET points=NULL WHERE room_id=? AND round_id=? AND changes()=1',r.id,r.round_id)
      ]);
      if(!result[0].meta.changes)throw fail('回合已更新。',409,'round_changed');
      if(last)sweep(env,ctx);
    } else throw fail('不支援這項操作。');
    return (await read(env,code,token,input.metadata)).response;
  }
  return { async fetch(request,env,ctx) {
    try {
      const url=new URL(request.url),token=request.headers.get('Authorization')?.replace(/^Bearer /,'');
      if(url.pathname==='/api/health')return json({ok:true,architecture:'client-scoring-d1',protocol:3});
      if(url.pathname==='/api/round' && request.method==='GET') {
        const code=url.searchParams.get('code');
        const [room,answers]=await env.DB.batch([
          stmt(env,'SELECT r.*,p.id AS player_id,p.in_game,p.left FROM rooms r LEFT JOIN room_players p ON p.room_id=r.id AND p.token=? WHERE r.code=?',token||'',code),
          stmt(env,"SELECT a.player_id,a.points FROM room_answers a JOIN rooms r ON a.room_id=r.id AND a.game_id=r.game_id AND a.round_id=r.round_id WHERE r.code=? AND r.phase='reveal'",code)
        ]);
        const r=room.results[0];
        if(!r||r.expires_at<=now())throw fail('房間已過期或關閉，請重新開房。',410,'room_closed');
        if(!r.player_id||r.left)throw fail('房間身分已失效，請重新加入。',403,'identity_lost');
        if(r.game_id!==url.searchParams.get('game')||r.round_id!==url.searchParams.get('question'))throw fail('回合已更新。',409,'round_changed');
        if(r.phase!=='reveal')throw fail('尚未揭曉。',409,'not_revealed');
        if(!r.in_game)throw fail('不是本局參賽者。',403,'identity_lost');
        // points is written only by JSON.stringify after answer validation; sealed missing answers use NULL.
        const drawings=answers.results.map(a=>`{"id":${JSON.stringify(a.player_id)},"points":${a.points||'[]'}}`).join(',');
        return new Response(`{"gameId":${JSON.stringify(r.game_id)},"questionId":${JSON.stringify(r.round_id)},"drawings":[${drawings}]}`, {
          headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
        });
      }
      if(url.pathname!=='/api/room')throw fail('找不到這個入口。',404,'not_found');
      if(request.method==='GET')return json((await read(env,url.searchParams.get('code'),token,url.searchParams.get('metadata'))).response);
      if(request.method!=='POST'||!request.headers.get('Content-Type')?.startsWith('application/json'))throw fail('請使用 JSON POST。',415);
      if(request.headers.get('Origin') && request.headers.get('Origin')!==url.origin)throw fail('來源不符。',403);
      const chunks=[];let size=0;
      if(request.body)for await(const chunk of request.body){size+=chunk.byteLength;if(size>BODY_LIMIT)throw fail('訊息過大。',413);chunks.push(chunk);}
      let input;try{input=JSON.parse(await new Blob(chunks).text());}catch{throw fail('JSON 格式錯誤。');}
      if(!input||typeof input!=='object'||Array.isArray(input))throw fail('訊息格式錯誤。');
      return json(await command(env,input,token,ctx));
    } catch(error) {
      if(!error.status)logError(error);
      return json({error:error.code||'unavailable',message:error.status?error.message:'服務暫時無法使用，請稍後重試。'},error.status||503);
    }
  } };
}
