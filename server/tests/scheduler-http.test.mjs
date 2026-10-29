import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'vf-scheduler-http-'));
process.env.VF_DB=join(dir,'db');
const {db,now}=await import('../db.mjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));

test('HTTP start, queue and stop preserve per-villa state and unfinished work',{timeout:15000},async()=>{
 let entered;const inferenceStarted=new Promise(r=>entered=r);
 const llm=http.createServer((req,res)=>{req.resume();entered();});
 await new Promise(r=>llm.listen(0,'127.0.0.1',r));
 const local=`http://127.0.0.1:${llm.address().port}/v1`;
 db.exec('DELETE FROM routes');db.prepare("INSERT INTO routes(name,provider,base_url,model,priority) VALUES ('local-test','ollama',?,'test',0)").run(local);
 const ids=[1,2].map(i=>{
  const id=Number(db.prepare("INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,'PAUSED',0,?,?)").run(`HTTP ${i}`,'Research scope',now(),now()).lastInsertRowid);
  db.prepare("INSERT INTO agents(villa_id,name,role,status,system_prompt,created_at,last_active_at) VALUES (?,'Worker','RESEARCHER','IDLE','Use tools.',?,?)").run(id,now(),now());
  db.prepare("INSERT INTO tasks(villa_id,title,description,status,created_at,updated_at) VALUES (?,'Research','Rolle: RESEARCHER.','PENDING',?,?)").run(id,now(),now());return id;
 });
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server/server.mjs'],{cwd:resolve(import.meta.dirname,'../..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',VF_WORKSPACE:join(dir,'work'),VF_RESUME:'0',VF_OPEN_MODE:'1',VF_LLM_FREE_ONLY:'0',VF_VILLA_SLOTS:'1'},stdio:'ignore'});
 const call=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()};};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await call('/api/health')).status===200){ready=true;break;}}catch{}await pause(50);}assert.ok(ready,'Hub starts');
  const first=await call(`/api/villas/${ids[0]}/orchestrate`,{concurrency:1});
  assert.equal(first.status,202);assert.equal(first.body.alreadyRunning,false);assert.equal(first.body.runToCompletion,true);
  await Promise.race([inferenceStarted,pause(2000).then(()=>{throw Error('No LLM call');})]);
  const second=await call(`/api/villas/${ids[1]}/orchestrate`,{runToCompletion:false});
  assert.equal(second.body.queued,true);assert.equal(second.body.runToCompletion,false);assert.equal(second.body.alreadyRunning,false);
  const villas=(await call('/api/villas')).body;
  assert.equal(villas.find(v=>v.id===ids[0]).executing,1);assert.equal(villas.find(v=>v.id===ids[1]).queued,1);assert.equal(villas.find(v=>v.id===ids[0]).retry,null);
  await call(`/api/villas/${ids[1]}/stop`,{});await call(`/api/villas/${ids[0]}/stop`,{});
  let status;for(let i=0;i<50;i++){status=(await call('/api/scheduler')).body;if(!status.active.length)break;await pause(20);}
  assert.deepEqual(status.active,[]);assert.deepEqual(status.queue,[]);assert.deepEqual(status.retrying,[]);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE villa_id=?').get(ids[0]).status,'PENDING');
 }finally{
  child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(1000).then(()=>child.kill('SIGKILL'))]);llm.closeAllConnections();await new Promise(r=>llm.close(r));
 }
});
