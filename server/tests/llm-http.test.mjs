import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'llm-http-')),'db');
const {db}=await import('../db.mjs');
const {chat}=await import('../llm.mjs');
const servers=[];
after(()=>servers.forEach(s=>s.close()));
async function listen(handler){const s=http.createServer(handler);servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}/v1`;}
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','retry-after':'180'});res.end(JSON.stringify(data));};
test('Reale HTTP-Kaskade: 429 -> lokale Modell-Erkennung -> Chat; Retry-After bleibt erhalten',async()=>{
 let calls=0,model;
 const primary=await listen((_,r)=>{calls++;send(r,429,{error:'rate limited'});});
 const local=await listen((req,res)=>{
  if(req.url==='/v1/models')return send(res,200,{data:[{id:'installed-model'}]});
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{model=JSON.parse(body).model;send(res,200,{choices:[{message:{content:'Fixture model response'}}],model,usage:{total_tokens:4}});});
 });
 db.exec('DELETE FROM routes');
 db.prepare('INSERT INTO routes(name,provider,base_url,model,priority) VALUES (?,?,?,?,?)').run('Test primary','gemini',primary,'cloud-model',1);
 db.prepare('INSERT INTO routes(name,provider,base_url,model,priority) VALUES (?,?,?,?,?)').run('Test local','ollama',local,'auto',2);
 const out=await chat([{role:'user',content:'test'}]);assert.equal(out.offline,false);assert.equal(model,'installed-model');assert.equal(out.content,'Fixture model response');assert.equal(calls,1);
 const row=db.prepare('SELECT cooldown_until,fail FROM routes WHERE name=?').get('Test primary');assert.ok(row.cooldown_until>Date.now()+170000);assert.equal(row.fail,1);
 await chat([{role:'user',content:'again'}]);assert.equal(calls,1,'Cooldown darf nicht sofort erneut versucht werden');
});

test('Rate-limited credentials do not open the circuit for another configured credential',async()=>{
 let rejected=0,accepted=0;
 const endpoint=await listen((req,res)=>{
  req.resume();
  if(req.headers.authorization==='Bearer fixture-blocked'){rejected++;return send(res,429,{error:'quota'});}
  accepted++;return send(res,200,{choices:[{message:{content:'Configured healthy credential works'}}]});
 });
 db.exec('DELETE FROM routes');
 db.prepare('INSERT OR REPLACE INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('CIRCUIT_BAD_FIXTURE','fixture-blocked');
 db.prepare('INSERT OR REPLACE INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('CIRCUIT_GOOD_FIXTURE','fixture-healthy');
 const add=db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,priority) VALUES (?,?,?,?,?,?)');
 add.run('Quota exhausted','groq',endpoint,'one','CIRCUIT_BAD_FIXTURE',1);
 add.run('Independent credential','groq',endpoint,'two','CIRCUIT_GOOD_FIXTURE',2);
 const old=process.env.VF_LLM_FREE_ONLY;process.env.VF_LLM_FREE_ONLY='0';
 try{
  const outputs=await Promise.all(Array.from({length:3},()=>chat([{role:'user',content:'fixture'}],{strategy:'FALLBACK'})));
  assert.equal(outputs.length,3);assert.ok(outputs.every(x=>x.content==='Configured healthy credential works'));
  assert.equal(rejected,3);assert.equal(accepted,3);
 }finally{if(old===undefined)delete process.env.VF_LLM_FREE_ONLY;else process.env.VF_LLM_FREE_ONLY=old;}
});

test('Local discovery and completion share a single provider deadline',async()=>{
 const endpoint=await listen((req,res)=>{
  req.resume();
  setTimeout(()=>send(res,200,req.url.endsWith('/models')?{data:[{id:'deadline-fixture'}]}:{choices:[{message:{content:'too late'}}]}),130);
 });
 db.exec('DELETE FROM routes');db.prepare('INSERT INTO routes(name,provider,base_url,model,priority) VALUES (?,?,?,?,?)').run('Shared deadline','ollama',endpoint,'auto',1);
 const started=Date.now();
 await assert.rejects(chat([{role:'user',content:'fixture'}],{timeoutMs:200}),e=>e.code==='LLM_UNAVAILABLE'&&e.attempts[0].code==='TIMEOUT');
 assert.ok(Date.now()-started<600,'model discovery must not create a second full timeout');
});
