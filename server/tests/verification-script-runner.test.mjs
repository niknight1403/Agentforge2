/**
 * Villa 34 blieb an "Exit 127: sh: 1: jest: not found" haengen: das Gate
 * startete einen Prüfbefehl, dessen Läufer im Projekt nicht existiert und im
 * Gate auch nicht nachgeladen werden darf. Diese Tests halten die Vorprüfung
 * fest, damit der Fehler als Umgebungsbefund mit klarer Handlungsanweisung
 * ankommt statt als undurchsichtiger Shell-Fehler in der Reparaturschleife.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const dir=mkdtempSync(join(tmpdir(),'runner-'));
process.env.VF_DB=join(dir,'db');process.env.VF_WORKSPACE=join(dir,'workspace');
const {db,now}=await import('../db.mjs');
const {PHASES}=await import('../product.mjs');
const {ownProjectDir,verifyProjectRuntime,npmScriptRunner,missingScriptRunner}=await import('../project-verification.mjs');

function villa(){
 const id=Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,1,?,?)').run('Runner','Echte App','RUNNING',now(),now()).lastInsertRowid);
 for(const ph of PHASES)for(const m of ph.musts)db.prepare("INSERT INTO tasks(villa_id,title,status,created_at,updated_at) VALUES (?,?,'DONE',?,?)").run(id,m.title,now(),now());
 return id;
}
function project(id,scripts){
 const p=ownProjectDir(id);mkdirSync(p,{recursive:true});
 writeFileSync(join(p,'index.mjs'),'export const value=1;');
 writeFileSync(join(p,'package.json'),JSON.stringify({scripts}));
 return p;
}

test('erkennt den Läufer eines npm-Skripts',()=>{
 assert.equal(npmScriptRunner('jest --ci'),'jest');
 assert.equal(npmScriptRunner('  cross-env NODE_ENV=test vitest run'),'vitest');
 assert.equal(npmScriptRunner('node tests/run.mjs'),'node');
 assert.equal(npmScriptRunner(''),null);
});

test('fehlender Läufer wird erkannt, vorhandener nicht',()=>{
 const root=mkdtempSync(join(tmpdir(),'runner-check-'));
 mkdirSync(join(root,'node_modules','.bin'),{recursive:true});
 writeFileSync(join(root,'node_modules','.bin','vitest'),'#!/bin/sh\n');
 assert.equal(missingScriptRunner(root,'jest'),'jest');
 assert.equal(missingScriptRunner(root,'vitest run'),null);
 assert.equal(missingScriptRunner(root,'node tests/run.mjs'),null);
});

test('Prüfung meldet fehlenden Läufer als Umgebungsbefund statt Exit 127',async()=>{
 const id=villa();
 project(id,{build:'node build.mjs',test:'jest',smoke:'node smoke.mjs'});
 let testGestartet=false;
 const run=async(_,__,args)=>{if(args.includes('test'))testGestartet=true;return{ok:true,output:'ok'};};
 const out=await verifyProjectRuntime(id,{runner:run});
 assert.equal(out.ok,false);
 assert.equal(out.checks.tests.status,'environment');
 assert.equal(out.checks.tests.runner,'jest');
 assert.match(out.checks.tests.reason,/node:test/);
 assert.equal(testGestartet,false,'der Befehl darf gar nicht erst gestartet werden');
 assert.ok(out.blockers.some(b=>/jest/.test(b)));
});

test('vorhandener Läufer läuft normal weiter',async()=>{
 const id=villa();
 const root=project(id,{build:'node build.mjs',test:'vitest run',smoke:'node smoke.mjs'});
 mkdirSync(join(root,'node_modules','.bin'),{recursive:true});
 writeFileSync(join(root,'node_modules','.bin','vitest'),'#!/bin/sh\n');
 const run=async()=>({ok:true,output:'ok'});
 const out=await verifyProjectRuntime(id,{runner:run});
 assert.equal(out.checks.tests.status,'passed');
});
