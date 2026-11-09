import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { chat } from './llm.mjs';
import { db, now } from './db.mjs';
import { redisTryAck, redisTryClaimStale, redisTryCreateConsumerGroup, redisTryReadConsumerGroup, redisTryStreamAdd } from './redis.mjs';
import { runCommand } from './fs-tools.mjs';
import { GENERATION_STREAM, GENERATION_GROUP, parseGenerationOutput, generationPrompt, generationEvent } from './generation-engine.mjs';

const CONSUMER=String(process.env.AGENTFORGE_GENERATION_CONSUMER||`${hostname().replace(/[^a-zA-Z0-9:_-]/g,'-')}:${process.pid}`);
const WORKSPACE=resolve(process.env.AGENTFORGE_GENERATION_WORKSPACE||'server/data/generated');
const sleep=ms=>new Promise(resolveP=>setTimeout(resolveP,ms));

db.exec(`
 CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY, request_id TEXT UNIQUE, project_id TEXT, status TEXT NOT NULL,
  workspace TEXT NOT NULL, manifest TEXT, error_code TEXT, commit_sha TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS generation_checkpoints (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
 );
`);

async function publish(type,taskId,metadata={}) {
 const event=generationEvent(type,taskId,metadata);
 await redisTryStreamAdd(GENERATION_STREAM,{type,json:JSON.stringify(event),eventId:event.taskId+':'+type+':'+event.at,at:event.at});
}

function inputFrom(event) {
 const p=event?.payload||event?.data||event||{};
 const prompt=String(p.prompt||p.idea||p.request||'').trim();
 const taskId=String(p.taskId||p.requestId||event?.id||'').slice(0,100);
 const projectId=p.projectId==null?'':String(p.projectId).slice(0,100);
 if(!prompt || !taskId) throw Object.assign(new Error('PROMPT_OR_TASK_ID_MISSING'),{code:'PROMPT_OR_TASK_ID_MISSING'});
 if(prompt.length>9000) throw Object.assign(new Error('PROMPT_TOO_LONG'),{code:'PROMPT_TOO_LONG'});
 return {prompt,taskId,projectId};
}

async function checkpoint(jobId,stage,metadata={}) {
 const id=randomUUID(), safe={};
 for(const [k,v] of Object.entries(metadata)) if(['files','bytes','attempt','build','tests','errorCode'].includes(k)) safe[k]=v;
 db.prepare('INSERT INTO generation_checkpoints(id,job_id,stage,metadata,created_at) VALUES(?,?,?,?,?)').run(id,jobId,stage,JSON.stringify(safe),now());
 await publish('CHECKPOINT_SAVED',jobId,{checkpointId:id,step:stage});
}

async function generate({prompt,taskId,projectId}) {
 const existing=db.prepare('SELECT * FROM generation_jobs WHERE request_id=?').get(taskId);
 if(existing?.status==='COMPLETED') { await publish('STREAM_COMPLETE',taskId,{status:'COMPLETED',workspace:existing.workspace}); return; }
 const jobId=existing?.id||randomUUID();
 const workspace=join(WORKSPACE,jobId);
 mkdirSync(workspace,{recursive:true});
 db.prepare(`INSERT INTO generation_jobs(id,request_id,project_id,status,workspace,created_at,updated_at)
 VALUES(?,?,?,'RUNNING',?,?,?) ON CONFLICT(request_id) DO UPDATE SET status='RUNNING',updated_at=excluded.updated_at`)
 .run(jobId,taskId,projectId,workspace,now(),now());
 try {
  let generated=null,lastFailure='';
  for(let attempt=1;attempt<=3;attempt++) {
   const result=await chat([{role:'system',content:'Erzeuge sichere, modulare Full-Stack-Codebasen als JSON.'},{role:'user',content:generationPrompt(prompt,lastFailure)}],{role:'CODER',priority:'background'});
   const raw=String(result?.content||'');
   try { generated=parseGenerationOutput(raw); break; }
   catch(error) { lastFailure=String(error?.code||error?.message||'INVALID_OUTPUT'); if(attempt===3) throw error; }
  }
  await publish('PROJECT_PLANNED',taskId,{projectId,files:generated.files.length});
  await checkpoint(jobId,'PROJECT_PLANNED',{files:generated.files.length,bytes:generated.bytes});
  for(const file of generated.files) {
   const target=join(workspace,file.path);
   mkdirSync(dirname(target),{recursive:true});
   writeFileSync(target,file.content,{encoding:'utf8',flag:'wx'});
  }
  writeFileSync(join(workspace,'project_manifest.json'),JSON.stringify({...generated.manifest,requestId:taskId,projectId,generatedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  await publish('SCAFFOLD_GENERATED',taskId,{projectId,files:generated.files.length,bytes:generated.bytes});
  await checkpoint(jobId,'SCAFFOLD_GENERATED',{files:generated.files.length,bytes:generated.bytes});
  const packageJson=join(workspace,'package.json');
  let build={ok:false,skipped:true,error:'NO_PACKAGE_MANIFEST'};
  let tests={ok:false,skipped:true,error:'NO_PACKAGE_MANIFEST'};
  if(existsSync(packageJson)) {
   const pkg=JSON.parse((await import('node:fs')).readFileSync(packageJson,'utf8'));
   if(pkg.scripts?.build) build=await runCommand(workspace,'npm',['run','build'],120000);
   if(pkg.scripts?.test) tests=await runCommand(workspace,'npm',['test'],120000);
  }
  if(build.ok && tests.ok) {
   await publish('CONTAINER_TEST_PASSED',taskId,{projectId});
  } else {
   const failure=[build.error,tests.error].filter(Boolean).join(' | ').slice(0,700)||'BUILD_OR_TEST_NOT_CONFIGURED';
   await publish('CONTAINER_TEST_FAILED',taskId,{projectId,errorCode:failure.slice(0,120)});
   // No blind mutation: return the bounded diagnostics to the PEER reviewer in a fresh LLM repair request.
   const repair=await chat([{role:'system',content:'Du bist Reviewer. Gib ausschließlich ein JSON-Objekt mit files:[{path,content}] zurück. Korrigiere nur Build-/Testfehler. Keine Secrets, keine Installationsskripte.'},{role:'user',content:`Fehler: ${failure}\nProjektdateien: ${generated.files.map(f=>f.path).join(', ')}\nAufgabe: ${prompt.slice(0,3000)}`}],{role:'REVIEWER',priority:'background'});
   let patch;
   try { patch=parseGenerationOutput(JSON.stringify({files:JSON.parse(String(repair?.content||'{}')).files})); }
   catch { throw Object.assign(new Error('REVIEW_REPAIR_OUTPUT_INVALID'),{code:'REVIEW_REPAIR_OUTPUT_INVALID'}); }
   for(const file of patch.files) {
    const target=join(workspace,file.path);
    mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,file.content,{encoding:'utf8'});
   }
   if(existsSync(packageJson)) {
    const pkg=JSON.parse((await import('node:fs')).readFileSync(packageJson,'utf8'));
    if(pkg.scripts?.build) build=await runCommand(workspace,'npm',['run','build'],120000);
    if(pkg.scripts?.test) tests=await runCommand(workspace,'npm',['test'],120000);
   }
   if(!build.ok || !tests.ok) throw Object.assign(new Error('GENERATION_QUALITY_GATE_FAILED'),{code:'GENERATION_QUALITY_GATE_FAILED'});
   await publish('CONTAINER_TEST_PASSED',taskId,{projectId,repairApplied:true});
  }
  if(!build.ok || !tests.ok) throw Object.assign(new Error('GENERATION_BUILD_OR_TEST_NOT_VERIFIED'),{code:'GENERATION_BUILD_OR_TEST_NOT_VERIFIED'});
  const deployManifest={status:'NOT_DEPLOYED',reason:'Deployment requires an explicitly configured target and verified production credentials.',workspace,projectId,workerCommit:process.env.GITHUB_SHA||null,build:'passed',tests:'passed',createdAt:new Date().toISOString()};
  writeFileSync(join(workspace,'deploy-manifest.json'),JSON.stringify(deployManifest,null,2)+'\n',{flag:'wx'});
  const result={manifest:generated.manifest,workspace,projectId,build:'passed',tests:'passed',deployManifest};
  db.prepare("UPDATE generation_jobs SET status='COMPLETED',manifest=?,updated_at=? WHERE id=?").run(JSON.stringify(result),now(),jobId);
  await checkpoint(jobId,'COMPLETED',{build:result.build,tests:result.tests});
  await publish('STREAM_COMPLETE',taskId,{status:'COMPLETED',workspace,projectId,build:result.build,tests:result.tests,workerCommit:deployManifest.workerCommit,deployManifest:'deploy-manifest.json'});
 } catch(error) {
  const code=String(error?.code||'GENERATION_FAILED').slice(0,100);
  db.prepare("UPDATE generation_jobs SET status='FAILED',error_code=?,updated_at=? WHERE id=?").run(code,now(),jobId);
  await publish('STREAM_COMPLETE',taskId,{status:'FAILED',errorCode:code});
  throw error;
 }
}

export async function startGenerationWorker({signal}={}) {
 const created=await redisTryCreateConsumerGroup(GENERATION_STREAM,GENERATION_GROUP);
 if(created==null) throw new Error('GENERATION_REDIS_UNAVAILABLE');
 console.log('[generation-worker] listening',{stream:GENERATION_STREAM,group:GENERATION_GROUP,consumer:CONSUMER});
 while(!signal?.aborted) {
  let rows=await redisTryClaimStale(GENERATION_STREAM,GENERATION_GROUP,CONSUMER,{minIdleMs:60000,count:5});
  if(!rows?.length) rows=await redisTryReadConsumerGroup(GENERATION_STREAM,GENERATION_GROUP,CONSUMER,{count:5});
  if(!rows?.length) { await sleep(750); continue; }
  for(const row of rows) {
   if(!row.event) { await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id); continue; }
   const event=row.event;
   if(!['PROJECT_GENERATION_REQUESTED','project.generate'].includes(event.type)) { await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id); continue; }
   try { await generate(inputFrom(event)); await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id); }
   catch(error) { console.error('[generation-worker] task failed',{code:error?.code||'GENERATION_FAILED'}); /* leave pending for XAUTOCLAIM recovery */ }
  }
 }
}

if(import.meta.url===`file://${process.argv[1]}`) {
 const controller=new AbortController();
 process.once('SIGINT',()=>controller.abort()); process.once('SIGTERM',()=>controller.abort());
 startGenerationWorker({signal:controller.signal}).catch(error=>{console.error('[generation-worker] stopped:',error?.code||error.message);process.exitCode=1;});
}
