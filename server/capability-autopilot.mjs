/** Capability-gap extension of the existing development cycle. No timer, provider registry or dynamic eval. */
import {db,now} from './db.mjs';
import {getSetting} from './control-store.mjs';
import {canUseTool} from './packs.mjs';
import {projectReadiness,projectDirectory} from './project-verification.mjs';
import {realpathSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {emit} from './events.mjs';
db.exec(`CREATE TABLE IF NOT EXISTS capability_requests(
 villa_id INTEGER NOT NULL,capability_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
 goal TEXT NOT NULL,acceptance TEXT NOT NULL,status TEXT NOT NULL,observations INTEGER NOT NULL DEFAULT 1,
 task_id INTEGER,review_task_id INTEGER,attempts INTEGER NOT NULL DEFAULT 0,last_task_status TEXT NOT NULL DEFAULT '',
 evidence TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(villa_id,capability_id));`);
const ident=/^[a-z][a-z0-9_-]{2,63}$/;
const text=(v,key,max,min=12)=>{if(typeof v!=='string'||v.trim().length<min||v.length>max)throw Error('CAPABILITY_INVALID_'+key);return v.trim();};
function villa(id){const row=db.prepare('SELECT id,status,autonomy FROM villas WHERE id=?').get(Number(id));if(!row)throw Error('VILLA_NOT_FOUND');return row;}
export function requestCapability(villaId,input,{observed=false}={}){
 const v=villa(villaId),id=String(input.id||'');if(!ident.test(id))throw Error('CAPABILITY_INVALID_ID');
 if(!['feature','tool','integration'].includes(input.kind))throw Error('CAPABILITY_INVALID_KIND');
 const title=text(input.title,'TITLE',160,4),goal=text(input.goal,'GOAL',1600),acceptance=text(input.acceptance,'ACCEPTANCE',1600);
 const old=db.prepare('SELECT * FROM capability_requests WHERE villa_id=? AND capability_id=?').get(v.id,id);
 if(old){
  if(old.status==='needs_configuration'&&old.kind==='integration'&&input.kind!=='integration'){
   db.prepare("UPDATE capability_requests SET kind=?,goal=?,acceptance=?,status='proposed',updated_at=? WHERE villa_id=? AND capability_id=?").run(input.kind,goal,acceptance,now(),v.id,id);
   return capabilityStatus(v.id).requests.find(r=>r.id===id);
  }
  const observations=Math.min(1000,old.observations+1),promote=old.status==='observed'&&(observations>=2||!observed);
  db.prepare('UPDATE capability_requests SET observations=?,status=?,updated_at=? WHERE villa_id=? AND capability_id=?').run(observations,promote?'proposed':old.status,now(),v.id,id);
  return capabilityStatus(v.id).requests.find(r=>r.id===id);
 }
 if(db.prepare('SELECT COUNT(*) n FROM capability_requests WHERE villa_id=?').get(v.id).n>=50)throw Error('CAPABILITY_REQUEST_LIMIT');
 const status=input.kind==='integration'?'needs_configuration':observed?'observed':'proposed';
 db.prepare('INSERT INTO capability_requests(villa_id,capability_id,kind,title,goal,acceptance,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(v.id,id,input.kind,title,goal,acceptance,status,now(),now());
 emit('report',{villaId:v.id,kind:'CAPABILITY_GAP',capabilityId:id,status});
 return capabilityStatus(v.id).requests.find(r=>r.id===id);
}
export function observeMissingTool(villaId,name){
 if(!/^[a-z][a-z0-9_]{2,45}$/.test(String(name||'')))return;
 if(!db.prepare('SELECT id FROM villas WHERE id=?').get(Number(villaId)))return;
 return requestCapability(villaId,{id:'tool-'+name,kind:'tool',title:'Projektwerkzeug '+name,goal:'Pruefe anhand der Originalidee, ob '+name+' benoetigt wird. Falls ja, implementiere einen projektlokalen Adapter mit strengem Ein-/Ausgabeschema; andernfalls dokumentiere eine vorhandene Alternative.',acceptance:'Adapter und Negativtests existieren und laufen. Keine dynamische Hub-Ausfuehrung oder Registrierung ungeprueften Codes; unabhaengiger Review und Build/Test/Smoke sind Pflicht.'},{observed:true});
}
export function capabilityStatus(villaId){
 const v=villa(villaId),enabled=Number(getSetting('capabilityAutopilot',1))===1;
 const rows=db.prepare('SELECT * FROM capability_requests WHERE villa_id=? ORDER BY created_at,capability_id').all(v.id);
 const readiness=rows.some(r=>r.status==='validated')?projectReadiness(v.id):null;
 const fresh=r=>{try{return readiness?.verified&&JSON.parse(r.evidence).fingerprint===readiness.fingerprint;}catch{return false;}};
 const requests=rows.map(r=>({id:r.capability_id,kind:r.kind,title:r.title,goal:r.goal,acceptance:r.acceptance,status:r.status==='validated'&&!fresh(r)?'evidence_stale':r.status,taskId:r.task_id,reviewTaskId:r.review_task_id,attempts:r.attempts,observations:r.observations,validated:r.status==='validated'&&!!fresh(r),evidenceAvailable:!!r.evidence}));
 return {enabled,runsWithVilla:enabled&&v.autonomy===1&&['RUNNING','WAITING_FOR_MODEL'].includes(v.status),requests,limits:{newTasksPerCycle:2,requestsPerVilla:50,maxFailedAttempts:3},policy:{paidRoutes:false,automaticCredentials:false,automaticHubCodeRegistration:false},note:'Projektlokale Erweiterungen werden erst mit aktuellem Build/Test/Smoke, Dateien und unabhaengigem Review validiert. Produktabnahme bleibt separat.'};
}
function task(villaId,title,description){
 const existing=db.prepare('SELECT id FROM tasks WHERE villa_id=? AND title=? ORDER BY id LIMIT 1').get(villaId,title);if(existing)return Number(existing.id);
 return Number(db.prepare("INSERT INTO tasks(villa_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,'PENDING',2,?,?)").run(villaId,title,description,now(),now()).lastInsertRowid);
}
export function reconcileCapabilities(villaId){
 const state=capabilityStatus(villaId);if(!state.runsWithVilla||!canUseTool('capability_request').allowed||!canUseTool('task_create').allowed)return {added:0};
 let added=0;
 for(const r of db.prepare('SELECT * FROM capability_requests WHERE villa_id=? ORDER BY created_at,capability_id').all(Number(villaId))){
  if(r.status==='validated'){
   if(state.requests.find(x=>x.id===r.capability_id)?.validated)continue;
   const stamp=now();db.prepare("UPDATE capability_requests SET status='awaiting_review',review_task_id=NULL,updated_at=? WHERE villa_id=? AND capability_id=?").run(stamp,Number(villaId),r.capability_id);r.status='awaiting_review';r.review_task_id=null;r.updated_at=stamp;
  }
  if(['dismissed','needs_configuration','observed'].includes(r.status))continue;
  const work=r.task_id?db.prepare('SELECT * FROM tasks WHERE villa_id=? AND id=?').get(Number(villaId),r.task_id):null;
  if(work){
   if(r.attempts>=3){if(['PENDING','READY'].includes(work.status))db.prepare("UPDATE tasks SET status='CANCELLED',updated_at=? WHERE villa_id=? AND id=?").run(now(),Number(villaId),work.id);db.prepare("UPDATE capability_requests SET status='blocked',updated_at=? WHERE villa_id=? AND capability_id=?").run(now(),Number(villaId),r.capability_id);continue;}
   if(work.status==='CANCELLED'){db.prepare("UPDATE capability_requests SET status='dismissed',updated_at=? WHERE villa_id=? AND capability_id=?").run(now(),Number(villaId),r.capability_id);continue;}
   if(work.status==='FAILED'){
    const attempts=r.attempts+(r.last_task_status!=='FAILED'?1:0);
    db.prepare("UPDATE capability_requests SET status='blocked',attempts=?,last_task_status='FAILED',updated_at=? WHERE villa_id=? AND capability_id=?").run(attempts,now(),Number(villaId),r.capability_id);continue;
   }
   if(work.status==='DONE'){
    let reviewId=r.review_task_id;
    if(!reviewId&&added<2){reviewId=task(Number(villaId),`Capability Review [${r.capability_id}] ${r.updated_at}`,'Rolle: REVIEWER\nGoal: Pruefe unabhaengig '+r.title+'.\nAbnahme: '+r.acceptance+'\nConstraints: Nicht selbst implementieren oder einen Textabschluss als Nachweis akzeptieren. Lies Implementierung und Tests, fuehre project_run fuer Build, Tests und Smoke aus.\nFormat: Dateien, Pruefbefehle und belegte Ergebnisse. Danach capability_verify mit id, testPath und artifactPath aufrufen; ein fehlgeschlagenes Gate bleibt offen.\nFailure Handling: Konkreten Befund dokumentieren und sicher stoppen.');added++;}
    db.prepare("UPDATE capability_requests SET status='awaiting_review',review_task_id=?,last_task_status='DONE',updated_at=? WHERE villa_id=? AND capability_id=?").run(reviewId||null,now(),Number(villaId),r.capability_id);continue;
   }
   db.prepare("UPDATE capability_requests SET status='implementing',last_task_status=?,updated_at=? WHERE villa_id=? AND capability_id=?").run(work.status,now(),Number(villaId),r.capability_id);continue;
  }
  if(r.attempts>=3||added>=2||r.status!=='proposed')continue;
  const id=task(Number(villaId),`Capability Implementierung [${r.capability_id}]`,'Rolle: CODER\nGoal: '+r.goal+'\nAkzeptanz: '+r.acceptance+'\nConstraints: Bestehendes Projekt erweitern. Keine neuen Providerkonten, Kosten, Hostrechte oder ungetestete Hub-Plugins. Freigegebene Werkzeuge verwenden.\nFormat: Vollstaendige Projektdateien, Akzeptanztests und lauffaehiger Export.\nFailure Handling: Maximal drei begruendete Reparaturversuche, danach konkrete Blockermeldung; bei fehlenden externen Ressourcen keine Scheinloesung.');
  db.prepare("UPDATE capability_requests SET task_id=?,status='implementing',updated_at=? WHERE villa_id=? AND capability_id=?").run(id,now(),Number(villaId),r.capability_id);added++;
 }
 return {added};
}
function evidenceFile(root,path){
 if(typeof path!=='string'||!path||isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw Error('CAPABILITY_EVIDENCE_PATH');
 const file=resolve(root,path),canonical=realpathSync(file),rel=relative(realpathSync(root),canonical);
 if(rel.startsWith('..')||isAbsolute(rel)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size<1||lstatSync(file).size>2*1024*1024)throw Error('CAPABILITY_EVIDENCE_PATH');
 return {path:rel,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')};
}
export function verifyCapability(villaId,id,{testPath,artifactPath},agentId){
 const r=db.prepare('SELECT * FROM capability_requests WHERE villa_id=? AND capability_id=?').get(Number(villaId),String(id));if(!r)throw Error('CAPABILITY_NOT_FOUND');
 const work=db.prepare('SELECT status,agent_id FROM tasks WHERE villa_id=? AND id=?').get(Number(villaId),r.task_id);
 const review=db.prepare('SELECT status,agent_id FROM tasks WHERE villa_id=? AND id=?').get(Number(villaId),r.review_task_id);
 const reviewer=db.prepare('SELECT role FROM agents WHERE villa_id=? AND id=?').get(Number(villaId),Number(agentId));
 if(work?.status!=='DONE'||!work.agent_id||Number(work.agent_id)===Number(agentId)||!['REVIEWER','TESTER','VERIFIER','INTEGRATOR'].includes(reviewer?.role)||!r.review_task_id||Number(review?.agent_id)!==Number(agentId)||!['RUNNING','REVIEW','DONE'].includes(review?.status))throw Error('CAPABILITY_INDEPENDENT_REVIEW_REQUIRED');
 const readiness=projectReadiness(Number(villaId));if(!readiness.verified)throw Error('CAPABILITY_BUILD_TEST_SMOKE_REQUIRED');
 if(!/(?:^|\/)(?:tests?\/|test_)|\.(?:test|spec)\./.test(String(testPath)))throw Error('CAPABILITY_ACCEPTANCE_TEST_REQUIRED');
 const root=projectDirectory(Number(villaId)),test=evidenceFile(root,testPath),artifact=evidenceFile(root,artifactPath);
 if(test.path===artifact.path)throw Error('CAPABILITY_DISTINCT_ARTIFACT_REQUIRED');
 const evidence={test,artifact,reviewerId:Number(agentId),fingerprint:readiness.fingerprint,verifiedAt:now()};
 db.prepare("UPDATE capability_requests SET status='validated',evidence=?,updated_at=? WHERE villa_id=? AND capability_id=?").run(JSON.stringify(evidence),now(),Number(villaId),String(id));
 emit('report',{villaId:Number(villaId),kind:'CAPABILITY_VALIDATED',capabilityId:String(id)});
 return {id:String(id),status:'validated',scope:'project',evidence};
}
export function capabilityBlockers(villaId){return capabilityStatus(villaId).requests.filter(r=>r.status!=='observed'&&!r.validated).map(r=>`Faehigkeit ${r.id}: ${r.status}; Abnahme offen`);}
export function observeProjectFailure(villaId,result){
 if(!db.prepare('SELECT id FROM villas WHERE id=?').get(Number(villaId)))return;
 if(!/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|No module named|command not found|ENOENT/.test(String(result?.error||'')+' '+String(result?.output||'')))return;
 return requestCapability(villaId,{id:'project-dependencies',kind:'tool',title:'Fehlende Projekt-Abhaengigkeit reparieren',goal:'Ein echter Projektlauf meldet eine fehlende Abhaengigkeit oder ein fehlendes Programm. Pruefe den vorhandenen Stack und repariere den projektlokalen Adapter oder die deklarierte Abhaengigkeit innerhalb freigegebener Werkzeuge. Fehlende Hostrechte oder externe Ressourcen ehrlich melden.',acceptance:'Die urspruenglich fehlgeschlagene Projektpruefung sowie Build, Tests und Smoke laufen nachweisbar. Manifest und Akzeptanztest sind vorhanden; keine unbeauftragte Installation oder Aenderung am Host.'});
}
