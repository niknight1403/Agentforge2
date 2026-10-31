import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const tmp=mkdtempSync(join(tmpdir(),'capability-'));
process.env.VF_DB=join(tmp,'db');process.env.VF_WORKSPACE=join(tmp,'workspace');
const {db,now}=await import('../db.mjs');
const {requestCapability,reconcileCapabilities,capabilityStatus,verifyCapability}=await import('../capability-autopilot.mjs');
const {runTool,insertAgent,setSource}=await import('../agents.mjs');
const {ownProjectDir,verifyProjectRuntime}=await import('../project-verification.mjs');
const {setSetting}=await import('../control-store.mjs');
const {setPackEnabled}=await import('../packs.mjs');
function villa(status='RUNNING',autonomy=1){return Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('Capability App','Eine Software mit verlaesslichem JSON-Dateiexport.',status,autonomy,now(),now()).lastInsertRowid);}
function need(id='json-export',kind='feature'){return {id,kind,title:'JSON-Export implementieren',goal:'Erweitere die vorhandene App um einen nachweisbar funktionierenden JSON-Export.',acceptance:'Ein echter Akzeptanztest prueft Exportinhalt und Fehlerfaelle. Build, Tests und Smoke sind bestanden.'};}
test('Anfragen sind schema-validiert, dedupliziert und erzeugen allein keine Ausfuehrung',()=>{
 const v=villa();requestCapability(v,need());requestCapability(v,need());assert.equal(capabilityStatus(v).requests.length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE villa_id=?').get(v).n,0);
 assert.throws(()=>requestCapability(v,need('../escape')),/INVALID_ID/);assert.throws(()=>requestCapability(v,{...need(),goal:'x'}),/INVALID_GOAL/);
});
test('Bestehender Entwicklungszyklus legt maximal zwei Auftraege an und respektiert Pause/Stop',()=>{
 const v=villa();for(let i=0;i<5;i++)requestCapability(v,need('export-'+i));
 assert.equal(reconcileCapabilities(v).added,2);assert.equal(reconcileCapabilities(v).added,2);assert.equal(reconcileCapabilities(v).added,1);assert.equal(reconcileCapabilities(v).added,0);
 const paused=villa('PAUSED',0);requestCapability(paused,need());assert.equal(reconcileCapabilities(paused).added,0);assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(paused).autonomy,0);
 setSetting('capabilityAutopilot',0);const off=villa();requestCapability(off,need());assert.equal(reconcileCapabilities(off).added,0);setSetting('capabilityAutopilot',1);
});
test('Pack-Sperre und fehlende externe Konfiguration werden nicht umgangen',()=>{
 const v=villa();requestCapability(v,need());requestCapability(v,need('image-renderer','integration'));
 try{setPackEnabled('planung',false);assert.equal(reconcileCapabilities(v).added,0);}finally{setPackEnabled('planung',true);}
 assert.equal(reconcileCapabilities(v).added,1);assert.equal(capabilityStatus(v).requests.find(r=>r.id==='image-renderer').status,'needs_configuration');assert.equal(capabilityStatus(v).policy.paidRoutes,false);
});
test('Wiederholtes unbekanntes Tool wird eine begrenzte projektlokale Luecke, keine globale Registrierung',async()=>{
 const v=villa();await runTool({villaId:v,agentId:0},'pdf_exporter',{});assert.equal(capabilityStatus(v).requests[0].status,'observed');assert.equal(reconcileCapabilities(v).added,0);
 await runTool({villaId:v,agentId:0},'pdf_exporter',{});assert.equal(reconcileCapabilities(v).added,1);assert.equal(capabilityStatus(v).policy.automaticHubCodeRegistration,false);
});
test('Fehlende Medienroute wird gemeldet, ohne Rendern oder neue Zugangsdaten zu behaupten',async()=>{
 delete process.env.FAL_KEY;const v=villa();const out=await runTool({villaId:v,agentId:0},'media_generate',{type:'video',prompt:'Eine echte Produktdemo'});
 assert.match(out,/Medienroute fehlgeschlagen/);const r=capabilityStatus(v).requests.find(r=>r.id==='media-video');assert.equal(r.status,'needs_configuration');assert.equal(reconcileCapabilities(v).added,0);
});
test('DONE-Text genuegt nicht; unabhängiger Reviewer und echte aktuelle Ausfuehrungsnachweise sind Pflicht',async()=>{
 const v=villa(),coder=Number(insertAgent(v,'Coder','CODER')),reviewer=Number(insertAgent(v,'Reviewer','REVIEWER'));requestCapability(v,need());reconcileCapabilities(v);
 let r=capabilityStatus(v).requests[0];db.prepare("UPDATE tasks SET status='DONE',agent_id=? WHERE id=?").run(coder,r.taskId);reconcileCapabilities(v);r=capabilityStatus(v).requests[0];assert.equal(r.status,'awaiting_review');
 assert.throws(()=>verifyCapability(v,r.id,{testPath:'export.test.mjs',artifactPath:'index.mjs'},coder),/INDEPENDENT_REVIEW/);
 db.prepare("UPDATE tasks SET status='RUNNING',agent_id=? WHERE id=?").run(reviewer,r.reviewTaskId);
 assert.throws(()=>verifyCapability(v,r.id,{testPath:'export.test.mjs',artifactPath:'index.mjs'},reviewer),/BUILD_TEST_SMOKE/);
 const root=ownProjectDir(v);mkdirSync(root,{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{build:'node build.mjs',test:'node export.test.mjs',smoke:'node smoke.mjs'}}));
 writeFileSync(join(root,'index.mjs'),'export function encode(value){return JSON.stringify(value);}\n');
 writeFileSync(join(root,'export.test.mjs'),"import assert from 'node:assert/strict';import {encode} from './index.mjs';assert.equal(encode({ok:true}),'{\"ok\":true}');assert.throws(()=>encode({x:1n}));\n");
 writeFileSync(join(root,'build.mjs'),"import {encode} from './index.mjs';if(!encode({build:true}))throw Error('build failed');\n");
 writeFileSync(join(root,'smoke.mjs'),"import {encode} from './index.mjs';if(JSON.parse(encode({ready:true})).ready!==true)throw Error('smoke failed');\n");
 const result=await verifyProjectRuntime(v);assert.equal(result.ok,true,JSON.stringify(result));
 assert.throws(()=>verifyCapability(v,r.id,{testPath:'../secret.test.mjs',artifactPath:'index.mjs'},reviewer),/PATH/);
 const accepted=verifyCapability(v,r.id,{testPath:'export.test.mjs',artifactPath:'index.mjs'},reviewer);assert.equal(accepted.scope,'project');assert.equal(capabilityStatus(v).requests[0].validated,true);
 writeFileSync(join(root,'index.mjs'),'export const broken=true;');assert.equal(capabilityStatus(v).requests[0].validated,false);assert.equal(capabilityStatus(v).requests[0].status,'evidence_stale');
});
test('Gescheiterte Auftraege erzeugen keine neue Retry-Schlange und bleiben begrenzt',()=>{
 const v=villa();requestCapability(v,need());reconcileCapabilities(v);const r=capabilityStatus(v).requests[0];
 for(let i=0;i<3;i++){db.prepare("UPDATE tasks SET status='PENDING' WHERE id=?").run(r.taskId);reconcileCapabilities(v);db.prepare("UPDATE tasks SET status='FAILED' WHERE id=?").run(r.taskId);reconcileCapabilities(v);}
 db.prepare("UPDATE tasks SET status='PENDING' WHERE id=?").run(r.taskId);assert.equal(reconcileCapabilities(v).added,0);assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(r.taskId).status,'CANCELLED');assert.equal(capabilityStatus(v).requests[0].status,'blocked');
});

test('Offene Pflichtfaehigkeiten blockieren Produktabnahme und Ultra-Release auch bei DONE-Titeln',async()=>{
 const {maturity}=await import('../product.mjs');const {ultraStatus}=await import('../ultra-agent.mjs');
 const v=villa();requestCapability(v,need('required-video','integration'));
 const product=maturity(v);assert.equal(product.verified,false);assert.ok(product.blockers.some(x=>x.includes('required-video')));assert.equal(ultraStatus(v).gatePassed,false);
});

test('Externe Luecke kann nach Einrichtung zur pruefbaren Projektintegration werden, niemals direkt validated',()=>{
 const v=villa();requestCapability(v,need('media-adapter','integration'));assert.equal(reconcileCapabilities(v).added,0);
 const r=requestCapability(v,need('media-adapter','tool'));assert.equal(r.status,'proposed');assert.equal(r.validated,false);assert.equal(reconcileCapabilities(v).added,1);
});

test('Ein echter Missing-Module-Projektfehler wird als Integrationsbedarf erfasst ohne rohe Logs zu speichern',async()=>{
 const v=villa(),root=ownProjectDir(v);mkdirSync(root,{recursive:true});setSource(v,root);writeFileSync(join(root,'missing.mjs'),"import 'vf-private-fixture-module-not-installed';\n");
 const out=await runTool({villaId:v,agentId:0},'project_run',{binary:'node',args:['missing.mjs']});assert.match(out,/ERR_MODULE_NOT_FOUND/);
 const gap=capabilityStatus(v).requests.find(r=>r.id==='project-dependencies');assert.equal(gap.status,'proposed');assert.doesNotMatch(JSON.stringify(gap),/vf-private-fixture-module/);
});
