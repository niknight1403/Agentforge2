import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'vf-master-api-'));
const port=34000+Math.floor(Math.random()*3000),base=`http://127.0.0.1:${port}`;
let child;
async function call(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()};}
before(async()=>{
 process.env.VF_DB=join(dir,'hub.db');
 const {db}=await import('../db.mjs');
 db.prepare('INSERT INTO routes(name,provider,base_url,model,enabled) VALUES (?,?,?,?,?)').run('test-offline','offline','','offline',1);
 db.close();
 child=spawn(process.execPath,['server/server.mjs'],{cwd:resolve(import.meta.dirname,'../..'),env:{...process.env,VF_DB:join(dir,'hub.db'),VF_WORKSPACE:join(dir,'work'),HOST:'127.0.0.1',PORT:String(port),VF_RESUME:'0',VF_OPEN_MODE:'1',VF_RATE_WAIT_MS:'1'},stdio:'ignore'});
 for(let i=0;i<150;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Hub startup failed');
});
after(async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},1500).unref();});}rmSync(dir,{recursive:true,force:true});});
test('Master API: status, honest LLM outage, stable retry, history, suggestions and archive',async()=>{
 assert.equal((await call('/api/master/status')).status,200);
 const request={message:'Erstelle Villa "Master Test": Prüfe den vollständigen Ablauf',requestId:'http-master-create-123'};
 const first=await call('/api/master/chat',request);assert.equal(first.status,503);assert.equal(first.body.ok,false);assert.equal(first.body.code,'LLM_UNAVAILABLE');assert.equal(first.body.steps[0].type,'create_villa');
 const second=await call('/api/master/chat',request);assert.deepEqual(second,first);
 const villas=await call('/api/villas');assert.equal(villas.body.length,0);
 assert.equal((await call('/api/master/messages')).body.length,2);
 assert.equal((await call('/api/master/history')).body.length,2);
 assert.equal((await call('/api/master/turn/http-master-create-123')).body.answer,first.body.answer);
 assert.ok(Array.isArray((await call('/api/master/suggestions')).body));
 assert.ok(Array.isArray((await call('/api/master/duplicates/archive',{})).body.archived));
 const unavailable=await call('/api/master/chat',{message:'Erkläre mir in zwei Sätzen, wie eine bestehende Villa gestartet wird.',requestId:'http-master-unavailable-123'});assert.equal(unavailable.status,503);assert.equal(unavailable.body.code,'LLM_UNAVAILABLE');assert.ok(Array.isArray(unavailable.body.routeAttempts));
 const malformed=await call('/api/master/chat',{message:'Status',requestId:'x'});assert.equal(malformed.status,400);
});

test('Master actions: mobile controls are validated and restricted',async()=>{
 const action=(type,args,confirmation='')=>call('/api/master/actions',{action:{type,args},confirmation});
 let response=await action('set_pack',{id:'monitoring',enabled:false});
 assert.equal(response.status,200);
 let status=(await call('/api/master/status')).body;
 assert.equal(status.packs.features.find(p=>p.id==='monitoring').enabled,false);
 await action('set_pack',{id:'monitoring',enabled:true});
 status=(await call('/api/master/status')).body;
 assert.equal(status.packs.features.find(p=>p.id==='monitoring').enabled,true);
 const tool=status.tools[0];
 assert.ok(tool?.name);
 assert.equal((await action('set_tool',{name:tool.name,enabled:false})).status,200);
 assert.equal((await call('/api/master/status')).body.tools.find(t=>t.name===tool.name).enabled,false);
 await action('set_tool',{name:tool.name,enabled:true});
 assert.equal((await action('upsert_skill',{id:'mobile_skill',title:'App-Hilfe',instructions:'Erkläre den nächsten Schritt.',enabled:true})).status,200);
 assert.equal((await call('/api/master/status')).body.skills.find(s=>s.id==='mobile_skill').enabled,1);
 assert.equal((await action('upsert_connector',{id:'unsafe',title:'Intern',endpoint:'http://127.0.0.1/private',enabled:true})).status,400);
 assert.equal((await action('upsert_connector',{id:'public_json',title:'Beispiel',endpoint:'https://example.com/data.json',enabled:true})).status,200);
 assert.equal((await call('/api/master/status')).body.connectors.find(c=>c.id==='public_json').last_status,'configured');
 assert.equal((await action('start_villa',{villaId:1})).status,400);
});
