import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'cascade-')),'db');
const {createCascade,LlmUnavailableError}=await import('../llm-cascade.mjs');
const {syncCascadeRoutes}=await import('../llm-config.mjs');
const {db}=await import('../db.mjs');
const {chat,resolveKey}=await import('../llm.mjs');
function route(id,provider,key_env='',extra={}){return {id,name:provider,provider,base_url:`http://${provider}`,model:'test',key_env,priority:id,...extra};}
const answer={content:'Echte Antwort',model:'test'};
test('Primary -> Secondary -> Backup -> Local: fixe Kaskade trotz anderer Priorität',async()=>{
 const rows=[route(1,'ollama'),route(2,'huggingface'),route(3,'groq'),route(4,'gemini')],seen=[];
 const run=createCascade({routes:()=>rows,key:()=>true,call:async r=>{seen.push(r.provider);if(r.provider!=='ollama')throw Object.assign(new Error('failure'),{status:429});return answer;}});
 const out=await run([]);assert.deepEqual(seen,['gemini','groq','huggingface','ollama']);assert.equal(out.offline,false);assert.equal(out.failovers.length,3);
});
test('Fehlende Keys, Cooldowns und Offline-Einträge werden ohne Netzwerkaufruf übersprungen',async()=>{
 const seen=[];const run=createCascade({routes:()=>[route(1,'gemini','MISSING'),route(2,'groq','',{cooldown_until:Date.now()+60000}),route(3,'offline'),route(4,'ollama')],key:()=>'',call:async r=>{seen.push(r.provider);return answer;}});
 assert.equal((await run([])).content,answer.content);assert.deepEqual(seen,['ollama']);
});
test('Kein Schlaf vor Failover; Timeout, 429, 5xx und leere Antworten fallen durch',async()=>{
 for(const err of [Object.assign(new Error('429'),{status:429}),Object.assign(new Error('500'),{status:503}),Object.assign(new Error('timeout'),{name:'TimeoutError'})]){
  const seen=[];const run=createCascade({routes:()=>[route(1,'gemini'),route(2,'ollama')],key:()=>'',call:async(r,_,opts)=>{seen.push(r.id);assert.ok(opts.timeoutMs<=90000);if(r.id===1)throw err;return answer;}});
  await run([]);assert.deepEqual(seen,[1,2]);
 }
 const run=createCascade({routes:()=>[route(1,'gemini'),route(2,'ollama')],key:()=>'',call:async r=>r.id===1?{content:''}:answer});assert.equal((await run([])).offline,false);
});
test('Vollausfall erzeugt 503 statt erfundener Planer-Antwort oder Token-Abrechnung',async()=>{
 const run=createCascade({routes:()=>[route(1,'ollama')],key:()=>'',call:async()=>{throw new Error('private-key-must-not-leak');}});
 await assert.rejects(run([]),e=>e instanceof LlmUnavailableError&&e.statusCode===503&&!JSON.stringify(e).includes('private-key'));
 db.exec('DELETE FROM routes');await assert.rejects(chat([{role:'user',content:'Baue ein Projekt'}]),e=>e.code==='LLM_UNAVAILABLE');
});
test('Lokaler Parallelitätsdeckel blockiert nicht den unabhängigen Reserve-Endpunkt',async()=>{
 let release;const wait=new Promise(r=>release=r);const rows=[route(1,'ollama'),route(2,'lmstudio')];
 const run=createCascade({routes:()=>rows,key:()=>'',call:async r=>r.id===1?(await wait,answer):answer});
 const first=run([]);const second=await run([]);assert.equal(second.failovers[0].code,'BUSY');release();await first;
});
test('Keine doppelten Requests für denselben Endpoint und dasselbe Modell',async()=>{
 let n=0;const r=route(1,'gemini');const run=createCascade({routes:()=>[r,{...r,id:2}],key:()=>'',call:async()=>{n++;throw Error('down');}});
 await assert.rejects(run([]));assert.equal(n,1);
});
test('Kaskade ist dauerhaft und idempotent; deaktivierte Einträge bleiben deaktiviert',()=>{
 db.exec('DELETE FROM routes');assert.ok(syncCascadeRoutes().added>=4);assert.equal(syncCascadeRoutes().added,0);
 db.prepare('UPDATE routes SET enabled=0 WHERE name=?').run('Cascade: Ollama local');syncCascadeRoutes();assert.equal(db.prepare('SELECT enabled FROM routes WHERE name=?').get('Cascade: Ollama local').enabled,0);
 db.prepare('INSERT OR REPLACE INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('GOOGLE_API_KEY','test-only');assert.equal(resolveKey('GEMINI_API_KEY'),'test-only');
});
test('Cloud-Zeitbudget reserviert Kapazität für das lokale Modell',async()=>{
 let time=0;const seen=[];const rows=[route(1,'gemini'),route(2,'groq'),route(3,'huggingface'),route(4,'ollama')];
 const run=createCascade({routes:()=>rows,key:()=>'',clock:()=>time,call:async r=>{seen.push(r.provider);if(r.provider!=='ollama'){time+=24000;throw Error('timeout');}return answer;}});
 await run([]);assert.deepEqual(seen,['gemini','ollama']);
});
test('Abgelaufener Schlüssel wird nicht mit jedem Modell desselben Providers erneut versucht',async()=>{
 const rows=[route(1,'gemini','KEY',{model:'a'}),route(2,'gemini','ALIAS',{model:'b'}),route(3,'ollama')];let seen=[];
 const run=createCascade({routes:()=>rows,key:()=> 'same-test-key',call:async r=>{seen.push(r.id);if(r.id!==3)throw Object.assign(Error('unauthorized'),{status:401});return answer;}});
 await run([]);assert.deepEqual(seen,[1,3]);seen=[];await run([]);assert.deepEqual(seen,[3]);
});
