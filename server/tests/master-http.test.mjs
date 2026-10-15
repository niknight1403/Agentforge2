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
test('Master API: status, create, retry, history, suggestions and archive preview',async()=>{
 assert.equal((await call('/api/master/status')).status,200);
 const request={message:'Erstelle Villa "Master Test": Prüfe den vollständigen Ablauf',requestId:'http-master-create-123'};
 const first=await call('/api/master/chat',request);assert.equal(first.status,200);assert.equal(first.body.ok,true);assert.equal(first.body.steps[0].type,'create_villa');
 const second=await call('/api/master/chat',request);assert.deepEqual(second,first);
 const villas=await call('/api/villas');assert.equal(villas.body.length,1);assert.equal(villas.body[0].autonomy,0);
 assert.equal((await call('/api/master/messages')).body.length,2);
 assert.equal((await call('/api/master/history')).body.length,2);
 assert.equal((await call('/api/master/turn/http-master-create-123')).body.answer,first.body.answer);
 assert.ok(Array.isArray((await call('/api/master/suggestions')).body));
 assert.equal((await call('/api/master/duplicates/archive',{})).body.preserved,true);
 const malformed=await call('/api/master/chat',{message:'Status',requestId:'x'});assert.equal(malformed.status,400);
});
