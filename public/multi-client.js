import { SoloEngine } from './solo-engine.js';
import { selectQuestions } from './solo-game.js';

const newId=()=>crypto.randomUUID();
export class MultiplayerHTTP {
  constructor({manifest,data,capture,storage,fetch:fetcher=(...args)=>globalThis.fetch(...args),engineFactory=(...args)=>new SoloEngine(...args),document:doc=globalThis.document}={}) {
    Object.assign(this,{manifest,data,capture,fetcher,engineFactory,doc});
    try{this.storage=storage??globalThis.sessionStorage;}catch{}
    this.readyState=0;this.queue=[];this.bufferedAmount=0;this.generation=0;this.offset=0;this.draftPoints=[];this.detailsCache=new Map();
    this.hidden=Boolean(doc?.hidden);this.visibility=()=>this.setHidden(Boolean(doc.hidden));doc?.addEventListener('visibilitychange',this.visibility);
    queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}});
  }
  get versions(){return{dataVersion:this.manifest.dataVersion,rulesVersion:this.manifest.rulesVersion,runtimeVersion:this.manifest.runtimeVersion};}
  now(){return Date.now()+this.offset;}
  plan(settings){const selected=selectQuestions(this.data,settings,Math.random,'multi');return{settings:selected.settings,questions:selected.questions,versions:this.versions};}
  emit(value){if(this.readyState===1)this.onmessage?.({data:JSON.stringify(value)});}
  message(message,type='error'){this.emit({type,message});}
  async request(input,signal) {
    // Visibility only aborts GET polls; a POST times out independently and retries its receipt ID.
    signal=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
    const response=await this.fetcher(input.url||'/api/room',{method:input.url?'GET':'POST',signal,
      headers:{...(!input.url?{'Content-Type':'application/json'}:{}),...(this.session?.token?{Authorization:`Bearer ${this.session.token}`}:{})},
      ...(!input.url?{body:JSON.stringify(input)}:{})});
    let value;try{value=await response.json();}catch{throw Object.assign(new Error('服務暫時無法回應，請稍後重試。'),{code:'unavailable',status:response.status});}
    if(!response.ok)throw Object.assign(new Error(value.message||'請求失敗，請稍後重試。'),{code:value.error,status:response.status});
    return value;
  }
  async command(input) {
    const body={requestId:newId(),code:this.session?.code,metadata:this.summary?.metadata,gameId:this.summary?.game,questionId:this.summary?.round,revision:this.summary?.plan,...input};
    const canRetry=()=>this.readyState===1&&(!this.final||['replay','leave'].includes(body.type));
    // A lost reply must retry the same operation, especially create, join and submit.
    for(let attempt=0;;attempt++){
      try{const value=await this.request(body);if(!this.final||['replay','leave','resume'].includes(body.type))this.apply(value);return value;}
      catch(error){if(error.status||attempt>=1||!canRetry())throw error;await new Promise(resolve=>setTimeout(resolve,1000));if(!canRetry())throw error;}
    }
  }
  apply(value) {
    if(this.readyState!==1)return;
    if(value.session){this.session=value.session;this.emit({type:'session',...value.session});}
    if(value.closed){this.stopPolling();this.emit({type:'left'});return;}
    const s=value.summary;if(!s)return;
    if(value.receipt&&this.pending?.submissionId===value.receipt.submission_id){this.pending=null;this.localError=null;this.removePending();}
    if(this.summary?.room===s.room&&this.summary.version>s.version)return;
    const changed=this.summary?.round!==s.round,oldGame=this.summary?.game;
    this.offset=s.now-Date.now();this.summary=s;
    if(value.details){this.details=value.details;this.metadataVersion=s.metadata;}
    if(!this.details||this.metadataVersion!==s.metadata)return;
    if(changed){this.roundLoad=null;this.detailsCache.clear();this.draftPoints=[];this.localError=null;this.lastPhase=null;}
    if(this.pending&&(this.pending.gameId!==s.game||this.pending.questionId!==s.round||s.phase!=='playing')){
      this.pending=null;this.calculating=false;this.removePending();
    }
    if(!this.pending&&s.phase==='playing')this.restorePending();
    if(s.phase==='results'){
      this.stopPolling();this.final=true;
      this.engine?.close();this.engine=null;this.engineKey=null;this.detailsCache.clear();this.roundLoad=null;
      for(const item of this.queue.splice(0))item.resolve(false);
    }else if(this.final&&(s.phase==='lobby'||oldGame!==s.game)){this.final=false;}
    this.publish();this.schedulePoll();
  }
  publish() {
    const s=this.summary,d=this.details;if(!s||!d||this.readyState!==1)return;
    const players=d.players.map(p=>{const flags=s.players.find(v=>v[0]===p.seat)||[p.seat,0,0,1,null];return{...p,ready:Boolean(flags[1]),loaded:Boolean(flags[2]),left:Boolean(flags[3]),submitted:Boolean(flags[4]),online:true,spectator:false};});
    const me=players.find(p=>p.seat===s.you);if(!me)return;
    if(!this.session.id){this.session={...this.session,id:me.id,mode:'multi'};this.emit({type:'session',...this.session});}
    let phase=s.phase==='reveal'?'reveal-scores':s.phase;
    if(s.phase==='playing')phase=this.now()<s.start?'countdown':this.localError?'error':this.pending||me.submitted||this.now()>=s.deadline?'scoring':'answering';
    const id=d.questions[s.index],region=this.data.regions.find(r=>r.id===id),current=d.rounds.find(r=>r.id===s.round),settings=d.settings;
    const extent=settings.challenge==='village'?this.data.regions.find(r=>r.id===settings.town)?.bounds:settings.challenge==='town'&&settings.scope==='county'?this.data.regions.find(r=>r.id===settings.county)?.bounds:this.data.bounds;
    const q=s.round?{id:s.round,regionId:id,name:region?.name||id,number:s.index+1,count:d.questions.length,start:s.start,deadline:s.deadline,extent:extent||this.data.bounds,
      points:this.pending?.points||this.draftPoints,revision:0,locked:Boolean(this.pending||me.submitted||this.now()>=s.deadline),checking:this.calculating,
      results:current?.results||null,voided:current?.voided||false,neutralNames:region?.neutralNames||[],scoredAt:s.now,nextAt:null}:null;
    const state={type:'state',free:true,code:d.code,mode:'multi',rulesVersion:d.versions.rulesVersion,phase,gameId:s.game,hostId:players.find(p=>p.seat===s.host)?.id,you:me.id,players,settings,settingsRevision:s.plan,
      serverNow:this.now(),question:q,notices:[],expiresAt:s.expires,localFailure:this.localError,canReportFailure:this.localError==='calculation'&&(this.pending?.attempts||0)>=2,
      error:this.localError==='upload'?'圈選與成績已保留，請重新送出。':'背景計分失敗，原筆跡與作答時間已保留，請重新計分。',
      roundStandings:d.roundStandings,cumulativeStandings:d.cumulativeStandings,standings:s.phase==='results'?d.cumulativeStandings:null,
      history:s.phase==='results'?d.rounds.map(r=>({...r,name:this.data.regions.find(q=>q.id===r.regionId)?.name||r.regionId})):null};
    this.state=state;this.lastPhase=phase;this.emit(state);
  }
  async loadEngine() {
    const d=this.details,key=`${this.summary.room}:${this.summary.plan}`;
    if(this.engineKey!==key){this.engine?.close();this.engineKey=key;this.engine=this.engineFactory(this.manifest,this.data,d.questions);}
    if(JSON.stringify(d.versions)!==JSON.stringify(this.versions))throw new Error('遊戲圖資或計分版本不同，請重新整理。');
    await this.engine.ready();return this.engine;
  }
  draft(points){if(this.summary?.phase==='playing'&&!this.pending&&!this.state?.players.find(p=>p.id===this.state.you)?.submitted&&this.now()<this.summary.deadline)this.draftPoints=points.map(p=>p.slice());}
  tick() {
    const s=this.summary;if(this.readyState!==1||!s||s.phase!=='playing'||this.hidden)return;
    const me=this.state?.players.find(p=>p.id===this.state.you);
    if(this.now()>=s.deadline&&!this.pending&&!me?.submitted){this.freeze(this.capture?.()||this.draftPoints,true);return;}
    if(this.lastPhase==='countdown'&&this.now()>=s.start)this.publish();
  }
  storageKey(){return`circle-pending:${this.session?.code}`;}
  persistPending(){try{if(!this.storage)throw new Error();this.storage.setItem(this.storageKey(),JSON.stringify(this.pending));return true;}catch{this.message('瀏覽器無法暫存本題；請保持此分頁開啟，直到顯示已收件。');return false;}}
  removePending(){try{this.storage?.removeItem(this.storageKey());}catch{}}
  restorePending(){
    try{const p=JSON.parse(this.storage?.getItem(this.storageKey())||'null');if(p&&p.gameId===this.summary.game&&p.questionId===this.summary.round&&Array.isArray(p.points)&&p.points.length<=2048){
      this.pending=p;this.draftPoints=p.points;queueMicrotask(()=>{if(this.readyState===1&&this.pending===p&&!this.hidden){if(p.answer)this.upload();else this.compute();}});
    }}catch{this.removePending();}
  }
  freeze(points,expired=false) {
    const s=this.summary;if(!s||s.phase!=='playing'||this.pending||this.now()<s.start||this.state?.players.find(p=>p.id===this.state.you)?.submitted)return;
    this.pending={gameId:s.game,questionId:s.round,regionId:this.details.questions[s.index],submissionId:newId(),points:points.map(p=>p.slice()),elapsed:expired?this.details.settings.seconds*1000:Math.max(0,Math.min(this.details.settings.seconds*1000,this.now()-s.start)),attempts:0};
    this.persistPending();this.compute();
  }
  async compute() {
    const p=this.pending;if(!p||this.calculating)return;
    this.calculating=true;this.localError=null;p.attempts++;this.persistPending();this.publish();
    try {
      const engine=await this.loadEngine(),value=await engine.score(p.regionId,p.points,this.data.playBounds);
      if(this.pending!==p||this.readyState!==1)return;
      const r=value.result,status=r.status==='valid'?'ok':r.status==='unanswered'?'unanswered':'invalid';
      this.detailsCache.set(`${p.questionId}:${this.session.id}`,value);
      p.answer={submissionId:p.submissionId,points:p.points,status,score:status==='ok'?r.score:0,elapsed:status==='ok'?p.elapsed:this.details.settings.seconds*1000};
      this.persistPending();this.calculating=false;await this.upload();
    }catch{if(this.pending===p&&this.readyState===1){this.localError='calculation';this.calculating=false;this.publish();this.schedulePoll();}}
  }
  async upload() {
    const p=this.pending;if(!p?.answer||this.uploading===p||this.readyState!==1)return;
    this.uploading=p;this.localError=null;this.publish();
    try{await this.command({type:'submit',gameId:p.gameId,questionId:p.questionId,answer:p.answer});}
    catch(error){if(this.pending===p){if(['round_closed','round_changed'].includes(error.code)){this.pending=null;this.removePending();await this.syncOnce();this.message(error.message);}else{this.localError='upload';this.message(error.message);}}}
    finally{if(this.uploading===p)this.uploading=null;this.publish();this.schedulePoll();}
  }
  retry(){if(this.pending?.answer)return this.upload();return this.compute();}
  reportFailure(){const p=this.pending;if(!p||this.localError!=='calculation'||p.attempts<2)return; p.answer={submissionId:p.submissionId,points:p.points,status:'calculation_failed',score:null,elapsed:p.elapsed};this.persistPending();return this.upload();}
  send(bytes) {
    const m=JSON.parse(bytes);if(this.readyState!==1)return Promise.resolve(false);
    if(m.type==='draft'){this.draft(m.points||[]);return Promise.resolve(true);}
    if(m.type==='submit'){this.freeze(m.points||this.draftPoints,this.now()>=this.summary.deadline);return Promise.resolve(true);}
    if(m.type==='retry'){this.retry();return Promise.resolve(true);}
    if(m.type==='calculation-failed'){this.reportFailure();return Promise.resolve(true);}
    if(m.type==='resume'&&m.token)this.session={code:m.code,token:m.token};
    if(m.type==='leave')this.removePending();
    if(this.final&&!['replay','leave','resume'].includes(m.type))return Promise.resolve(false);
    return new Promise(resolve=>{this.queue.push({message:m,resolve});this.drain();});
  }
  async drain() {
    if(this.running||this.readyState!==1)return;this.running=true;
    try{while(this.queue.length&&this.readyState===1){const {message:m,resolve}=this.queue.shift();
      try{
        if(m.type==='replay'&&this.state.hostId!==this.state.you){await this.syncOnce();if(this.summary.phase==='results')this.message('房主尚未返回大廳，請稍後再查看。','info');}
        else{const extra=['create','settings','replay'].includes(m.type)?this.plan(m.settings||this.details.settings):['join','loaded'].includes(m.type)?{versions:this.versions}:{};await this.command({...m,...extra});}
        resolve(true);
      }catch(error){if(['room_closed','identity_lost'].includes(error.code)){this.stopPolling();this.emit({type:'removed',message:error.message});}
        else{this.message(error.message);if(['round_changed','state_changed'].includes(error.code))await this.syncOnce().catch(()=>{});}resolve(false);}
    }}finally{this.running=false;this.schedulePoll();}
  }
  stopPolling(){this.generation++;clearTimeout(this.timer);this.timer=null;this.pollController?.abort();}
  schedulePoll() {
    clearTimeout(this.timer);this.timer=null;
    if(this.readyState!==1||!this.session||!this.summary||this.hidden||this.final)return;
    const s=this.summary,me=this.state?.players.find(p=>p.id===this.state.you);
    let delay=s.phase==='lobby'||s.phase==='reveal'?4500:2500;
    if(s.phase==='playing'&&!me?.submitted&&this.now()<s.deadline)delay=s.deadline-this.now()+100;
    const generation=this.generation;
    this.timer=setTimeout(async()=>{
      if(generation!==this.generation)return;
      this.pollController=new AbortController();
      try{await this.syncOnce(this.pollController.signal);}
      catch(error){if(error.name!=='AbortError'){
        if(['room_closed','identity_lost'].includes(error.code)){this.stopPolling();this.emit({type:'removed',message:error.message});return;}
        this.message(error.message);if(error.status===429){this.stopPolling();return;}
      }}finally{if(generation===this.generation)this.schedulePoll();}
    },delay);
  }
  async syncOnce(signal){if(!this.session)return;const generation=this.generation;const value=await this.request({url:`/api/room?${new URLSearchParams({code:this.session.code,metadata:this.metadataVersion??-1})}`},signal);if(generation===this.generation)this.apply(value);return value;}
  setHidden(hidden){this.hidden=hidden;this.stopPolling();if(!hidden&&this.readyState===1&&!this.final){this.tick();this.syncOnce().then(()=>{if(this.pending?.answer)this.upload();else if(this.pending&&!this.calculating&&!this.localError)this.compute();}).catch(error=>this.message(error.message)).finally(()=>this.schedulePoll());}}
  async roundAsset(asset,player) {
    const s=this.summary,q=s.round,game=s.game,regionId=this.details.questions[s.index];
    if(!this.roundLoad){
      const load=this.request({url:`/api/round?${new URLSearchParams({code:this.session.code,game,question:q})}`}).catch(async error=>{
        if(this.roundLoad===load)this.roundLoad=null;
        if(this.readyState!==1||this.final||this.summary.game!==game||this.summary.round!==q)throw new DOMException('回合已更新','AbortError');
        if(error.code==='round_changed'){await this.syncOnce();throw new DOMException('回合已更新','AbortError');}throw error;
      });this.roundLoad=load;
    }
    const packet=await this.roundLoad;
    if(this.summary.round!==q)throw new DOMException('回合已更新','AbortError');
    if(asset==='drawings')return this.details.players.map(p=>({...p,points:packet.drawings.find(a=>a.id===p.id)?.points||[]}));
    const engine=await this.loadEngine();
    if(asset==='target'||asset==='neutral'){
      const k=`${q}:geometry`;if(!this.detailsCache.has(k))this.detailsCache.set(k,engine.geometry(regionId).catch(error=>{this.detailsCache.delete(k);throw error;}));
      return(await this.detailsCache.get(k))[asset];
    }
    const cacheKey=`${q}:${player}`;
    if(!this.detailsCache.has(cacheKey))this.detailsCache.set(cacheKey,await engine.score(regionId,packet.drawings.find(a=>a.id===player)?.points||[],this.data.playBounds));
    const value=this.detailsCache.get(cacheKey);return{...value.result,neutral:value.neutral};
  }
  close(){this.readyState=3;this.stopPolling();this.engine?.close();this.doc?.removeEventListener('visibilitychange',this.visibility);for(const item of this.queue.splice(0))item.resolve(false);}
}
