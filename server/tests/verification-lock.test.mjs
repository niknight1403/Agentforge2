import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'vf-verification-lock-'));
process.env.VF_DB=join(temp,'db.sqlite');
process.env.VF_WORKSPACE=join(temp,'workspace');
const {db,now}=await import('../db.mjs');
const {lockVilla,unlockVilla,isVillaLocked,villaLock}=await import('../verification-lock.mjs');
const {verifyProjectRuntime,projectDirectory}=await import('../project-verification.mjs');
const {runTool}=await import('../agents.mjs');

function villa(path=''){
 return Number(db.prepare('INSERT INTO villas(name,idea,status,source_path,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run('Sperr-Villa','Entwickle eine Web-App.','RUNNING',path,'BUILD',now(),now()).lastInsertRowid);
}

/** Projekt mit echtem Quellstand und drei pruefbaren Befehlen. */
function project(id){
 const dir=join(temp,`proj-${id}`);
 mkdirSync(join(dir,'src'),{recursive:true});
 writeFileSync(join(dir,'src','index.js'),'export const value = 42;\n');
 const cmd={binary:'node',args:['ok']};
 writeFileSync(join(dir,'villaforge.verify.json'),JSON.stringify({build:cmd,tests:cmd,smoke:cmd}));
 return dir;
}

test('Sperre gilt pro Villa, nur der Eigentuemer loest sie',()=>{
 assert.equal(isVillaLocked(41),false);
 lockVilla(41,'verification');
 assert.equal(isVillaLocked(41),true);
 assert.equal(isVillaLocked(42),false);
 assert.equal(villaLock(41).by,'verification');
 assert.equal(unlockVilla(41,'fremder-halter'),false);
 assert.equal(isVillaLocked(41),true);
 assert.equal(unlockVilla(41,'verification'),true);
 assert.equal(isVillaLocked(41),false);
});

test('Abnahme haelt den Quellstand gesperrt und gibt ihn danach frei',async()=>{
 const id=villa(project(51));
 const gesehen=[];
 const runner=async ()=>{ gesehen.push(isVillaLocked(id)); return {ok:true,output:'ok'}; };
 const out=await verifyProjectRuntime(id,{runner});
 assert.equal(out.ok,true,String(out.blockers));
 assert.deepEqual(gesehen,[true,true,true]);
 assert.equal(isVillaLocked(id),false);
});

test('Schreibwerkzeuge werden waehrend der Abnahme mit klarer Auskunft abgewiesen',async()=>{
 const dir=project(52);
 const id=villa(dir);
 lockVilla(id,'verification');
 const ziel=join(dir,'src','gesperrt.js');
 const antwort=await runTool({villaId:id,agentId:0},'project_write',{path:'src/gesperrt.js',content:'export const x = 1;'});
 assert.match(String(antwort),/Quellstand gesperrt/);
 assert.equal(existsSync(ziel),false);
 unlockVilla(id,'verification');
 const danach=await runTool({villaId:id,agentId:0},'project_write',{path:'src/gesperrt.js',content:'export const x = 1;'});
 assert.match(String(danach),/geschrieben/);
 assert.ok(existsSync(join(projectDirectory(id),'src','gesperrt.js')),String(danach));
});
