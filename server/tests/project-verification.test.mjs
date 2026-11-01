import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'verified-'));
process.env.VF_DB=join(dir,'db');process.env.VF_WORKSPACE=join(dir,'workspace');
const {db,now}=await import('../db.mjs');
const {PHASES,maturity,developCycle}=await import('../product.mjs');
const {ownProjectDir,projectDirectory,verifyProjectRuntime,projectReadiness}=await import('../project-verification.mjs');
const {runQualityGate,createVilla,executeTask,insertAgent}=await import('../agents.mjs');
function villa(){const id=Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,1,?,?)').run('Demo','Echte App','RUNNING',now(),now()).lastInsertRowid);for(const ph of PHASES)for(const m of ph.musts)db.prepare("INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,?,'DONE',?,?)").run(id,m.title,now(),now());return id;}
function project(id,scripts={build:'node build.mjs',test:'node test.mjs',smoke:'node smoke.mjs'}){const p=ownProjectDir(id);mkdirSync(p,{recursive:true});writeFileSync(join(p,'index.mjs'),'export const value=1;');writeFileSync(join(p,'package.json'),JSON.stringify({scripts}));return p;}
test('Erledigte Aufgabentitel ergeben ohne Implementierung niemals 100/100',()=>{const id=villa(),m=maturity(id);assert.equal(m.planScore,100);assert.ok(m.score<=25);assert.equal(m.verified,false);assert.ok(m.blockers.length);});
test('Kanonischer Projektordner ist project/, nicht der darüberliegende Berichtsordner',()=>{const id=villa();project(id);assert.equal(projectDirectory(id),ownProjectDir(id));});
test('Build, Tests und echter Smoke-Befehl sind alle erforderlich',async()=>{
 const id=villa();project(id);const run=async(_,__,args)=>({ok:args[1]!=='smoke',output:'test output'});
 const out=await verifyProjectRuntime(id,{runner:run});assert.equal(out.ok,false);assert.equal(out.checks.smoke.status,'failed');assert.ok(maturity(id).score<100);
});
test('Erfolgreicher Nachweis gilt nur für den unveränderten Quellstand und läuft ab',async()=>{
 const id=villa(),p=project(id);await verifyProjectRuntime(id,{runner:async()=>({ok:true})});assert.equal(maturity(id).score,100);assert.equal(projectReadiness(id).verified,true);
 writeFileSync(join(p,'index.mjs'),'throw Error("kaputt");');assert.equal(projectReadiness(id).verified,false);assert.ok(maturity(id).score<100);
 await verifyProjectRuntime(id,{runner:async()=>({ok:true})});db.prepare('UPDATE project_verifications SET verified_at=0 WHERE villa_id=?').run(id);assert.equal(projectReadiness(id).verified,false);
});
test('Platzhaltertests und fehlende Skripte zählen nicht als Abnahme',async()=>{const id=villa();project(id,{build:'echo fertig',test:'exit 0'});const result=await verifyProjectRuntime(id,{runner:async()=>{throw Error('should not run');}});assert.equal(result.ok,false);assert.equal(result.checks.build.status,'missing');});
test('Fehlende Abnahme erzeugt deduplizierte Reparaturarbeit und wird nach falschem DONE erneut geöffnet',()=>{
 const id=villa();developCycle(id);developCycle(id);let rows=db.prepare("SELECT * FROM tasks WHERE villa_id=? AND title LIKE '[VERIFICATION]%' ").all(id);assert.equal(rows.length,1);db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(rows[0].id);developCycle(id);assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(rows[0].id).status,'PENDING');
});
test('Q-GATE-Retry darf fehlende Tests nicht umgehen',async()=>{const id=villa();project(id,{build:'node build.mjs'});const gate=await runQualityGate(id,{title:'Implementieren [Q-GATE]'},'Fertig');assert.equal(gate.passed,false);});
test('Totaler LLM-Ausfall legt keine scheinbar fertig geplante neue Villa an',async()=>{
 db.exec('DELETE FROM routes');const before=db.prepare('SELECT COUNT(*) n FROM villas').get().n;await assert.rejects(createVilla({name:'Kein Modell',idea:'App'}),e=>e.code==='LLM_UNAVAILABLE');assert.equal(db.prepare('SELECT COUNT(*) n FROM villas').get().n,before);
});
test('LLM-Ausfall lässt eine Aufgabe offen statt sie als DONE zu zählen',async()=>{
 const id=villa();insertAgent(id,'Coder','CODER',null,0);const taskId=Number(db.prepare("INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,'Code implementieren','RUNNING',?,?)").run(id,now(),now()).lastInsertRowid);
 await assert.rejects(executeTask(id,db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)),e=>e.code==='LLM_UNAVAILABLE');assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'PENDING');
});
test('Prüfbefehle laufen wirklich: roter Nutzerfluss verhindert 100, reparierter Nutzerfluss besteht',async()=>{
 const id=villa(),p=project(id);
 writeFileSync(join(p,'build.mjs'),'import {value} from "./index.mjs"; if(value!==1)throw Error("build");');
 writeFileSync(join(p,'test.mjs'),'import assert from "node:assert/strict"; import {value} from "./index.mjs"; assert.equal(value,1);');
 writeFileSync(join(p,'smoke.mjs'),'throw Error("Nutzerfluss defekt");');
 assert.equal((await verifyProjectRuntime(id)).ok,false);assert.ok(maturity(id).score<100);
 writeFileSync(join(p,'smoke.mjs'),'import assert from "node:assert/strict"; import {value} from "./index.mjs"; assert.equal(value+1,2);');
 assert.equal((await verifyProjectRuntime(id)).ok,true);assert.equal(maturity(id).score,100);
});
test('Noch offene Produktaufgaben sperren 100 trotz technisch erfolgreicher Prüfungen',async()=>{
 const id=villa();project(id);await verifyProjectRuntime(id,{runner:async()=>({ok:true})});
 db.prepare("INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,'Fehlendes Kernfeature','PENDING',?,?)").run(id,now(),now());
 assert.ok(maturity(id).score<100);assert.equal(maturity(id).verified,false);
});

test('Eigenständige Web-Artefakte passieren den produktiven 90-Punkte-Q-Gate erst mit sicheren, kleinen Inline-Apps',async()=>{
 const id=villa(),root=project(id);writeFileSync(join(root,'index.html'),'<!doctype html><script>const ready=true;</script>');
 const safe=await verifyProjectRuntime(id,{runner:async()=>({ok:true})});assert.equal(safe.checks.quality.status,'passed');assert.equal(safe.checks.quality.score,100);
 writeFileSync(join(root,'index.html'),'<!doctype html><script>eval("1");document.write("x");</script>');
 const unsafe=await verifyProjectRuntime(id,{runner:async()=>({ok:true})});assert.equal(unsafe.checks.quality.status,'failed');assert.ok(unsafe.checks.quality.score<90);assert.equal(projectReadiness(id).verified,false);
});


test('Konstante Erfolgsausgabe ersetzt weder Build noch expliziten Prüfbefehl',async()=>{
 const id=villa(),root=project(id,{build:`node -e "console.log('Build successful')"`,test:'node test.mjs',smoke:'node smoke.mjs'});
 let commands=[];const runner=async(_,binary,args)=>{commands.push([binary,...args]);return {ok:true};};
 let out=await verifyProjectRuntime(id,{runner});assert.equal(out.ok,false);assert.equal(out.checks.build.status,'missing');assert.equal(commands.length,2);
 writeFileSync(join(root,'villaforge.verify.json'),JSON.stringify({build:{binary:'node',args:['-e',"console.log('Build successful')"]}}));
 commands=[];out=await verifyProjectRuntime(id,{runner});assert.equal(out.ok,false);assert.equal(out.checks.build.status,'missing');assert.equal(commands.length,2);
 writeFileSync(join(root,'villaforge.verify.json'),JSON.stringify({build:{binary:'node',args:['-e',"require('node:assert/strict').equal(1,1)"]}}));
 out=await verifyProjectRuntime(id,{runner});assert.equal(out.checks.build.status,'passed');
});
