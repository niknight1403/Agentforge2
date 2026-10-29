import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-cancel-')),'db');
process.env.VF_LLM_FREE_ONLY='0';
const {db,now}=await import('../db.mjs');
const {orchestrate,stopVilla,isRunning}=await import('../agents.mjs');

test('Sprint 8 integration: stop aborts an in-flight LLM and preserves the unfinished task',async()=>{
 const id=Number(db.prepare("INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,1,?,?)").run('Abort integration','Research a small idea','PAUSED',now(),now()).lastInsertRowid);
 db.prepare("INSERT INTO tasks(villa_id,title,description,status,created_at,updated_at) VALUES (?,?,?,'PENDING',?,?)").run(id,'Research','Rolle: RESEARCHER.',now(),now());
 db.prepare("INSERT INTO agents(villa_id,name,role,status,system_prompt,created_at,last_active_at) VALUES (?,?,?,'IDLE',?,?,?)").run(id,'Researcher','RESEARCHER','Respond using tools.',now(),now());
 db.exec('DELETE FROM routes');
 db.prepare("INSERT INTO routes(name,provider,base_url,model,enabled) VALUES ('abort-local','ollama','http://127.0.0.1:11434/v1','test',1)").run();
 const original=globalThis.fetch;let entered;const started=new Promise(r=>entered=r);
 globalThis.fetch=async(_,opts)=>new Promise((resolve,reject)=>{entered();opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});});
 try{
  const work=orchestrate(id,{concurrency:1,runToCompletion:true});
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('LLM not entered')),2000).unref())]);
  assert.equal(stopVilla(id),true);
  await Promise.race([work,new Promise((_,reject)=>setTimeout(()=>reject(Error('stop did not abort')),1000).unref())]);
  assert.equal(isRunning(id),false);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE villa_id=?').get(id).status,'PENDING');
 }finally{stopVilla(id);globalThis.fetch=original;}
});
