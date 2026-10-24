import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,readdir,stat,cp,rm } from 'node:fs/promises';
import { join,resolve,relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { buildStatic } from './build-static.js';
import { prepareSoloRelease,SOLO_SOURCE_FILES } from './prepare-solo-release.js';

export const FREE_ASSETS={directory:'./client',binding:'ASSETS',run_worker_first:['/api/*'],not_found_handling:'404-page'};

export async function checkStaticLimits(root) {
  let count=0,largest={bytes:0,path:''};
  for(const entry of await readdir(root,{recursive:true,withFileTypes:true}))if(entry.isFile()){
    const path=join(entry.parentPath,entry.name),bytes=(await stat(path)).size;count++;
    assert.ok(bytes<=25*1024*1024,`Static Assets 單檔超過 25 MiB：${path}`);
    if(bytes>largest.bytes)largest={path:relative(root,path).replaceAll('\\','/'),bytes};
  }
  assert.ok(count<=20000,`Static Assets 檔案數 ${count} 超過 Free 20,000 上限`);
  return{files:count,largest};
}
export async function buildFreeLocal(out='.cache/cloudflare-free-local') {
  out=resolve(out);await mkdir(out,{recursive:true});const client=join(out,'client');buildStatic(client);
  await writeFile(join(client,'environment.json'),JSON.stringify({multiplayer:'local',url:null,transport:'poll',protocol:3}));
  const bundle=await build({stdin:{contents:`import {createFreeWorker} from ${JSON.stringify(resolve('server/free-rooms.js').replaceAll('\\','/'))}; export default createFreeWorker();`,resolveDir:out},
    outfile:join(out,'server.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'warning'});
  assert.deepEqual(Object.keys(bundle.metafile.inputs).sort(),['<stdin>','server/free-rooms.js','shared/rules.js'],'Worker 僅可包含進入點、房間 API 與共用規則');
  const worker=await readFile(join(out,'server.js'),'utf8');
  assert.ok(Buffer.byteLength(worker)<=64*1024*1024,'Worker 超過 64 MiB 上限');
  return{root:out,client,schema:resolve('server/free-schema.sql'),workerBytes:Buffer.byteLength(worker),assets:await checkStaticLimits(client)};
}
export const FREE_SOURCE_FILES=[...SOLO_SOURCE_FILES,'server/free-rooms.js','server/free-schema.sql','scripts/build-cloudflare.js','scripts/start-sites-local.js'];
export async function buildFreeRelease(out,previous) {
  out=resolve(out);await mkdir(out,{recursive:true});assert.equal((await readdir(out)).length,0,'發布輸出必須為全新空目錄');
  const prepared=await buildFreeLocal(join(out,'prepared')),client=join(out,'client');
  const evidence=prepareSoloRelease(client,previous,FREE_SOURCE_FILES,{freshSite:true});
  await cp(join(prepared.root,'server.js'),join(out,'worker.js'));
  assert.equal(prepared.root,join(out,'prepared'));await rm(prepared.root,{recursive:true});
  await writeFile(join(client,'environment.json'),JSON.stringify({multiplayer:'local',url:null,transport:'poll',protocol:3}));
  await mkdir(join(out,'migrations'));await cp('server/free-schema.sql',join(out,'migrations/0001_free_rooms.sql'));
  await writeFile(join(out,'wrangler.json'),JSON.stringify({name:'circle-taiwan',main:'worker.js',compatibility_date:'2026-05-15',
    assets:FREE_ASSETS,
    d1_databases:[{binding:'DB',database_name:'circle-taiwan-rooms',database_id:'00000000-0000-0000-0000-000000000000',migrations_dir:'./migrations'}],
    workers_dev:true,observability:{enabled:true,head_sampling_rate:1,logs:{invocation_logs:false}}},null,2)+'\n');
  const report={...evidence,architecture:'Cloudflare Static Assets + client scoring + D1',workerBytes:prepared.workerBytes,assets:await checkStaticLimits(client),deployed:false};
  await writeFile(join(out,'release.json'),JSON.stringify(report,null,2)+'\n');return{directory:out,...report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{output:{type:'string'},previous:{type:'string'},local:{type:'boolean'}}});
  console.log(JSON.stringify(values.local?await buildFreeLocal(values.output):await buildFreeRelease(values.output||'.cache/cloudflare-release-'+Date.now(),values.previous),null,2));
}
