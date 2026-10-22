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
 process.env.GEMINI_API_KEY = 'test-fixture-placeholder';
 db.prepare('INSERT INTO routes(name,provider,base_url,model,priority,key_env) VALUES (?,?,?,?,?,?)').run('Test primary','gemini',primary,'cloud-model',1,'GEMINI_API_KEY');
 db.prepare('INSERT INTO routes(name,provider,base_url,model,priority) VALUES (?,?,?,?,?)').run('Test local','ollama',local,'auto',2);
 const out=await chat([{role:'user',content:'test'}]);assert.equal(out.offline,false);assert.equal(model,'installed-model');assert.equal(out.content,'Fixture model response');assert.equal(calls,1);
 const row=db.prepare('SELECT cooldown_until,fail FROM routes WHERE name=?').get('Test primary');assert.ok(row.cooldown_until>Date.now()+170000);assert.equal(row.fail,1);
 await chat([{role:'user',content:'again'}]);assert.equal(calls,1,'Cooldown darf nicht sofort erneut versucht werden');
});
