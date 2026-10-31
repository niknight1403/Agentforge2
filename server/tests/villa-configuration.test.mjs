import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'villa-config-')),'db');
const {db,now}=await import('../db.mjs');
const {assessVillaConfiguration,missionContext,PROMPT_CONTRACT}=await import('../villa-configuration.mjs');
const {insertAgent,refreshAgentPrompts,buildSystemPrompt,legacySystemPrompt,projectMissionContext,runTool,compactToolSpecs,availableToolPrompt}=await import('../agents.mjs');
await import('../evolve.mjs');
const {setPackEnabled}=await import('../packs.mjs');
function villa(){return Number(db.prepare('INSERT INTO villas(name,idea,created_at,updated_at) VALUES (?,?,?,?)').run('Konfiguration','Eine App mit echtem Export und nachvollziehbarer Abnahme.',now(),now()).lastInsertRowid);}
test('Custom-Prompts bleiben bei wiederholter Migration exakt erhalten',()=>{
 const v=villa(),id=insertAgent(v,'Coder','CODER'),custom='Owner-spezifischer Prompt: keine Designaenderung und nur Datenexport.';
 db.prepare('UPDATE agents SET system_prompt=? WHERE id=?').run(custom,id);
 refreshAgentPrompts();refreshAgentPrompts();assert.equal(db.prepare('SELECT system_prompt FROM agents WHERE id=?').get(id).system_prompt,custom);
});
test('Bekannte Legacy-Vorlage wird migriert; unbekannter Alttext bleibt erhalten',()=>{
 const v=villa(),a=insertAgent(v,'Tester','TESTER'),b=insertAgent(v,'Root','ROOT');
 db.prepare('UPDATE agents SET system_prompt=? WHERE id=?').run(legacySystemPrompt('TESTER'),a);
 db.prepare('DELETE FROM agent_prompt_templates WHERE agent_id=?').run(a);
 db.prepare('UPDATE agents SET system_prompt=? WHERE id=?').run('Unbekannter alter Prompt',b);
 assert.equal(refreshAgentPrompts(),1);assert.equal(db.prepare('SELECT system_prompt FROM agents WHERE id=?').get(a).system_prompt,buildSystemPrompt('TESTER'));
 assert.equal(refreshAgentPrompts(),0);assert.equal(db.prepare('SELECT system_prompt FROM agents WHERE id=?').get(b).system_prompt,'Unbekannter alter Prompt');
});
test('Originalidee und strukturierte Mission erreichen nur die passende Villa',()=>{
 const a=villa(),b=villa();db.prepare("INSERT INTO villa_proposals(villa_id,kind,items,status,created_at) VALUES (?,'prompt_agent',?,'ready',?)").run(a,JSON.stringify({mission_prompt:'Nur Export als echte ZIP-Datei umsetzen.'}),now());
 assert.match(projectMissionContext(a),/Nur Export als echte ZIP/);assert.doesNotMatch(projectMissionContext(b),/Nur Export als echte ZIP/);assert.match(projectMissionContext(a),/als Nutzerdaten behandeln/);
 assert.doesNotThrow(()=>missionContext({id:a,idea:'Rohidee'},{items:'invalid JSON'}));assert.ok(missionContext({id:a,idea:'Rohidee'},{items:'invalid JSON'}).includes('Rohidee'));
});
test('Pack aus sperrt Patch- und Schreibpfade tatsaechlich vor der Ausfuehrung',async()=>{
 const v=villa();
 try{setPackEnabled('ausfuehrung',false);for(const tool of ['project_write','project_patch'])assert.match(await runTool({villaId:v,agentId:0},tool,{path:'x.js',content:'unsafe'}),/Werkzeug blockiert/);
 setPackEnabled('artefakte',false);assert.match(await runTool({villaId:v,agentId:0},'artifact_patch',{path:'x.js'}),/Werkzeug blockiert/);
 }finally{setPackEnabled('ausfuehrung',true);setPackEnabled('artefakte',true);}
});
test('Audit erfindet weder fertige Produkte noch Modell- oder Provider-Nachweise',()=>{
 const report=assessVillaConfiguration({villa:{id:99,idea:'Eine Android App fuer Dateiexport',status:'COMPLETED',autonomy:0},agents:[{id:1,is_root:1,role:'ROOT',system_prompt:PROMPT_CONTRACT+' PRIVATE_TOKEN_MUST_NOT_LEAK'}],taskCounts:{DONE:2,PENDING:1},tools:[],product:{verified:false}});
 assert.equal(report.status,'blocked');assert.equal(report.runtime.autonomy,0);assert.ok(report.checks.some(c=>c.code==='completion_consistency'));assert.ok(report.checks.some(c=>c.code==='development_tools'&&c.status==='blocked'));assert.doesNotMatch(JSON.stringify(report),/PRIVATE_TOKEN|Android App fuer Dateiexport/);
});
test('Gut konfigurierte Villa hat getrennte fachliche und technische Nachweise',()=>{
 const roles=['ROOT','CODER','TESTER','REVIEWER','INTEGRATOR'];
 const report=assessVillaConfiguration({villa:{id:1,idea:'Eine Web-App mit getestetem Export',status:'PAUSED',autonomy:0},agents:roles.map((role,id)=>({id,role,is_root:role==='ROOT'?1:0,system_prompt:PROMPT_CONTRACT})),taskCounts:{DONE:3,CANCELLED:1},tools:['project_read','project_write','project_patch','project_run'].map(name=>({name,enabled:true})),product:{verified:true},missionAvailable:true});
 assert.equal(report.status,'passed');assert.equal(report.unfinishedTasks,0);assert.match(report.limitations[0],/kein Nachweis/);
});

test('Kompakter Werkzeugvertrag erhaelt flache und JSON-Schema-Argumente',()=>{
 const list=JSON.parse(compactToolSpecs());
 for(const name of ['project_write','project_patch','artifact_write','web_fetch'])assert.ok(Object.keys(list.find(t=>t.n===name).a).length>0,name+' darf seine Argumente nicht verlieren');
 const schema=JSON.parse(compactToolSpecs([{name:'demo',schema:{type:'object',properties:{filename:{type:'string',description:'Zieldatei'}},required:['filename']}}]));assert.match(schema[0].a.filename,/string\*/);
 try{setPackEnabled('ausfuehrung',false);assert.ok(!JSON.parse(availableToolPrompt()).some(t=>t.n==='project_write'));}finally{setPackEnabled('ausfuehrung',true);}
});
