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
 const artifacts={taste:{statements:[
  {claim:'Niko will reine Entwicklungsarbeit ohne Marketingpflicht',evidence:{source:'repo:commits'}},
  {claim:'Niko zahlt nur fuer belegten Nutzen, nicht fuer Reichweite',evidence:{source:'https://github.com/niknight1403/CyberSarah-Control-Center'}},
  {claim:'Niko bevorzugt Android-Apps mit sofort nutzbarem Build',evidence:{source:'feedback:apk'}}]},
  spion:{competitors:[
  {name:'A',observation:'Baut Web-Apps direkt im Browser ohne lokale Installation.',source:'https://a.example',date:'2026-10-20'},
  {name:'B',observation:'Exportiert Projekte als ZIP fuer den eigenen Rechner.',source:'https://b.example',date:'2026-10-21'}]}};
 const report=assessVillaConfiguration({villa:{id:1,idea:'Eine Web-App mit getestetem Export',status:'PAUSED',autonomy:0},agents:roles.map((role,id)=>({id,role,is_root:role==='ROOT'?1:0,system_prompt:PROMPT_CONTRACT})),taskCounts:{DONE:3,CANCELLED:1},tools:['project_read','project_write','project_patch','project_run'].map(name=>({name,enabled:true})),product:{verified:true},missionAvailable:true,artifacts});
 assert.equal(report.status,'passed');assert.equal(report.unfinishedTasks,0);assert.match(report.limitations[0],/kein Nachweis/);
 assert.equal(report.handoverEvidence.ready,true);
});

test('Kompakter Werkzeugvertrag erhaelt flache und JSON-Schema-Argumente',()=>{
 const list=JSON.parse(compactToolSpecs());
 for(const name of ['project_write','project_patch','artifact_write','web_fetch'])assert.ok(Object.keys(list.find(t=>t.n===name).a).length>0,name+' darf seine Argumente nicht verlieren');
 const schema=JSON.parse(compactToolSpecs([{name:'demo',schema:{type:'object',properties:{filename:{type:'string',description:'Zieldatei'}},required:['filename']}}]));assert.match(schema[0].a.filename,/string\*/);
 try{setPackEnabled('ausfuehrung',false);assert.ok(!JSON.parse(availableToolPrompt()).some(t=>t.n==='project_write'));}finally{setPackEnabled('ausfuehrung',true);}
});

test('Prompt-Experte nutzt injizierte Kaskade und erzeugt nur validierte Vorschlaege',async()=>{
 const {refineVillaPrompts}=await import('../prompt-refinement.mjs');
 const v=villa(),before=db.prepare('SELECT COUNT(*) n FROM tasks').get().n,original=db.prepare('SELECT idea,vision FROM villas WHERE id=?').get(v);
 const data={vision:'Eine praezise Vision fuer den sicheren Dateiexport.',mission_prompt:PROMPT_CONTRACT,next_steps:['Export implementieren und mit echter Datei pruefen.','Fehlerfall testen und den Exitcode dokumentieren.','Archiv oeffnen und den Nutzerfluss bestaetigen.']};
 const result=await refineVillaPrompts({limit:10,chatFn:async(_,opts)=>{assert.ok(opts.totalTimeoutMs<=60000);return {content:JSON.stringify(data)};}});
 assert.ok(result.some(r=>r.villaId===v&&r.status==='proposal_saved'));assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);assert.deepEqual(db.prepare('SELECT idea,vision FROM villas WHERE id=?').get(v),original);
 const again=await refineVillaPrompts({limit:10,chatFn:async()=>{throw Error('must not call for an existing proposal');}});assert.ok(!again.some(r=>r.villaId===v));
});
test('Ungueltige Missionsantwort und konkurrierende Bearbeitung ueberschreiben keine Nutzerdaten',async()=>{
 const {refineVillaPrompts,validateMission}=await import('../prompt-refinement.mjs');assert.throws(()=>validateMission({vision:'x'}),/MISSION_SCHEMA_INVALID/);
 const v=villa();
 const report=await refineVillaPrompts({limit:10,chatFn:async()=>{db.prepare('UPDATE villas SET idea=? WHERE id=?').run('Vom Owner gerade aktualisierte Originalidee mit neuen Anforderungen.',v);return {content:JSON.stringify({vision:'Eine praezise Vision fuer den sicheren Dateiexport.',mission_prompt:PROMPT_CONTRACT,next_steps:['Erster Schritt mit echter Pruefung.','Zweiter Schritt mit echter Pruefung.','Dritter Schritt mit echter Pruefung.']})};}});
 assert.ok(report.some(r=>r.villaId===v&&r.status==='skipped_concurrent_edit'));assert.equal(db.prepare("SELECT COUNT(*) n FROM villa_proposals WHERE villa_id=?").get(v).n,0);
});

test('Uebergabe ohne TASTE/SPION bleibt ein Hinweis, nicht falsch rot',async()=>{
 const report=assessVillaConfiguration({villa:{id:7,idea:'Eine Web-App mit getestetem Export',status:'PAUSED',autonomy:0},agents:[{id:1,is_root:1,role:'ROOT',system_prompt:PROMPT_CONTRACT}],taskCounts:{DONE:1},tools:[],product:{verified:true}});
 const codes=report.checks.map(c=>c.code);
 assert.ok(codes.includes('taste_profile')&&codes.includes('spion_observation'));
 assert.equal(report.checks.find(c=>c.code==='taste_profile').status,'warning');
 assert.equal(report.handoverEvidence,null);
});

test('Uebergebene Artefakte mit Belegen passieren, unbelegte blockieren',async()=>{
 const base={villa:{id:8,idea:'Eine Web-App mit getestetem Export',status:'PAUSED',autonomy:0},agents:[{id:1,is_root:1,role:'ROOT',system_prompt:PROMPT_CONTRACT}],taskCounts:{DONE:1},tools:[],product:{verified:true}};
 const taste={statements:[
  {claim:'Niko will reine Entwicklungsarbeit ohne Marketingpflicht',evidence:{source:'repo:commits'}},
  {claim:'Niko zahlt nur fuer belegten Nutzen, nicht fuer Reichweite',evidence:{source:'https://github.com/niknight1403/CyberSarah-Control-Center'}},
  {claim:'Niko bevorzugt Android-Apps mit sofort nutzbarem Build',evidence:{source:'feedback:apk'}}]};
 const spion={competitors:[
  {name:'A',observation:'Baut Web-Apps direkt im Browser ohne lokale Installation.',source:'https://a.example',date:'2026-10-20'},
  {name:'B',observation:'Exportiert Projekte als ZIP fuer den eigenen Rechner.',source:'https://b.example',date:'2026-10-21'}]};
 const good=assessVillaConfiguration({...base,artifacts:{taste,spion}});
 assert.equal(good.checks.find(c=>c.code==='taste_profile').status,'pass');
 assert.equal(good.checks.find(c=>c.code==='spion_observation').status,'pass');
 assert.deepEqual(good.handoverEvidence,{ready:true,blockers:[]});
 const bad=assessVillaConfiguration({...base,artifacts:{taste,spion:{competitors:[]}}});
 assert.equal(bad.checks.find(c=>c.code==='spion_observation').status,'blocked');
 assert.equal(bad.status,'blocked');
});
