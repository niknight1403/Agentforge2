import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { chat } from './llm.mjs';
import { db, now } from './db.mjs';
import { redisTryAck, redisTryClaimStale, redisTryCreateConsumerGroup, redisTryReadConsumerGroup, redisTryStreamAdd } from './redis.mjs';
import { runGenerationChecks } from './fs-tools.mjs';
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
 const messageId=await redisTryStreamAdd(GENERATION_STREAM,{type,json:JSON.stringify(event),eventId:event.taskId+':'+type+':'+event.at,at:event.at});
 if(!messageId) throw Object.assign(new Error('GENERATION_EVENT_PUBLISH_FAILED'),{code:'GENERATION_EVENT_PUBLISH_FAILED'});
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
 if(existing?.status==='COMPLETED') { await publish('STREAM_COMPLETE',taskId,{status:'COMPLETED',workspace:existing.workspace}); return true; }
 const jobId=existing?.id||randomUUID();
 const workspace=join(WORKSPACE,jobId);
 if(existing?.status==='RUNNING' && now()-Number(existing.updated_at)<10*60_000) return false;
 if(existing && existing.status!=='COMPLETED') rmSync(workspace,{recursive:true,force:true});
 mkdirSync(workspace,{recursive:true});
 db.prepare(`INSERT INTO generation_jobs(id,request_id,project_id,status,workspace,created_at,updated_at)
 VALUES(?,?,?,'RUNNING',?,?,?) ON CONFLICT(request_id) DO UPDATE SET status='RUNNING',manifest=NULL,error_code=NULL,updated_at=excluded.updated_at`)
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
  const checks=await runGenerationChecks(workspace,120000);
  let build={ok:checks.ok,error:checks.ok?null:checks.error||'BUILD_FAILED'};
  let tests={ok:checks.ok,error:checks.ok?null:checks.error||'TEST_FAILED'};
  if(build.ok && tests.ok) {
   await publish('CONTAINER_TEST_PASSED',taskId,{projectId});
   await checkpoint(jobId,'CONTAINER_TEST_PASSED',{build:'passed',tests:'passed'});
  } else {
   const failure=[checks.stage,checks.error,checks.output].filter(Boolean).join(' | ').slice(0,700)||'BUILD_OR_TEST_NOT_CONFIGURED';
   await publish('CONTAINER_TEST_FAILED',taskId,{projectId,errorCode:failure.slice(0,120)});
   await checkpoint(jobId,'CONTAINER_TEST_FAILED',{errorCode:String(checks.stage||checks.error||'BUILD_FAILED').slice(0,100)});
   const repair=await chat([{role:'system',content:'Du bist Reviewer. Gib ausschließlich ein JSON-Objekt mit files:[{path,content}] zurück. Korrigiere nur Build-/Testfehler. Keine Secrets, keine Installationsskripte.'},{role:'user',content:`Fehler: ${failure}\\nProjektdateien: ${generated.files.map(f=>f.path).join(', ')}\\nAufgabe: ${prompt.slice(0,3000)}`}],{role:'REVIEWER',priority:'background'});
   let patch;
   try { patch=parseGenerationOutput(JSON.stringify({files:JSON.parse(String(repair?.content||'{}')).files})); }
   catch { throw Object.assign(new Error('REVIEW_REPAIR_OUTPUT_INVALID'),{code:'REVIEW_REPAIR_OUTPUT_INVALID'}); }
   for(const file of patch.files) {
    const target=join(workspace,file.path);
    mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,file.content,{encoding:'utf8'});
   }
   const repaired=await runGenerationChecks(workspace,120000);
   build={ok:repaired.ok,error:repaired.ok?null:repaired.error||'BUILD_FAILED'};
   tests={ok:repaired.ok,error:repaired.ok?null:repaired.error||'TEST_FAILED'};
   if(!build.ok || !tests.ok) throw Object.assign(new Error('GENERATION_QUALITY_GATE_FAILED'),{code:'GENERATION_QUALITY_GATE_FAILED'});
   await publish('CONTAINER_TEST_PASSED',taskId,{projectId,repairApplied:true});
   await checkpoint(jobId,'CONTAINER_TEST_PASSED',{build:'passed',tests:'passed',repairApplied:true});
  }
  const deployManifest={status:'NOT_DEPLOYED',reason:'Deployment requires an explicitly configured target and verified production credentials.',workspace,projectId,workerCommit:process.env.GITHUB_SHA||null,build:'passed',tests:'passed',createdAt:new Date().toISOString()};
  writeFileSync(join(workspace,'deploy-manifest.json'),JSON.stringify(deployManifest,null,2)+'\n',{flag:'wx'});
  const result={manifest:generated.manifest,workspace,projectId,build:'passed',tests:'passed',deployManifest};
  db.prepare("UPDATE generation_jobs SET status='COMPLETED',manifest=?,updated_at=? WHERE id=?").run(JSON.stringify(result),now(),jobId);
  await checkpoint(jobId,'COMPLETED',{build:result.build,tests:result.tests});
  await publish('STREAM_COMPLETE',taskId,{status:'COMPLETED',workspace,projectId,build:result.build,tests:result.tests,workerCommit:deployManifest.workerCommit,deployManifest:'deploy-manifest.json'});
  return true;
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
   try { const finished=await generate(inputFrom(event)); if(finished!==false) await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id); }
   catch(error) {
    const code=String(error?.code||'GENERATION_FAILED');
    console.error('[generation-worker] task failed',{code});
    // Invalid payloads cannot become valid through retry. Acknowledge them
    // instead of reclaiming the same poison message forever.
    if(['PROMPT_OR_TASK_ID_MISSING','PROMPT_TOO_LONG'].includes(code)) {
     await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id);
     continue;
    }
    try {
     const parsed=inputFrom(event);
     const terminal=db.prepare("SELECT status FROM generation_jobs WHERE request_id=?").get(parsed.taskId);
     if(terminal?.status==='FAILED') await redisTryAck(GENERATION_STREAM,GENERATION_GROUP,row.id);
    } catch { /* leave transiently incomplete work pending for recovery */ }
   }
  }
 }
}

if(import.meta.url===`file://${process.argv[1]}`) {
 const controller=new AbortController();
 process.once('SIGINT',()=>controller.abort()); process.once('SIGTERM',()=>controller.abort());
 startGenerationWorker({signal:controller.signal}).catch(error=>{console.error('[generation-worker] stopped:',error?.code||error.message);process.exitCode=1;});
}
