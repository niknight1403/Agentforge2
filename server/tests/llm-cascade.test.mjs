import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'cascade-')),'db');
process.env.VF_LLM_FREE_ONLY='0';
const {createCascade,LlmUnavailableError}=await import('../llm-cascade.mjs');
const {syncCascadeRoutes,syncFreeRouteFlags,isFreeRoute,routeTier}=await import('../llm-config.mjs');
const {db}=await import('../db.mjs');
const {chat,resolveKey,routingStatus}=await import('../llm.mjs');
function route(id,provider,key_env='',extra={}){return {id,name:provider,provider,base_url:`http://${provider}`,model:'test',key_env,priority:id,...extra};}
function makeCascade(options){return createCascade({freeOnly:false,...options});}
const answer={content:'Echte Antwort',model:'test'};
test('Quality-Rollen eskalieren Cloud-first und fallen lokal zurück',async()=>{
 const rows=[route(1,'ollama'),route(2,'huggingface'),route(3,'groq'),route(4,'gemini')],seen=[];
 const run=makeCascade({routes:()=>rows,key:()=>true,call:async r=>{seen.push(r.provider);if(r.provider!=='ollama')throw Object.assign(new Error('failure'),{status:429});return answer;}});
 const out=await run([],{role:'ARCHITECT'});assert.deepEqual(seen,['gemini','groq','huggingface','ollama']);assert.equal(out.offline,false);assert.equal(out.failovers.length,3);
});
test('Routine-Rollen nutzen lokale Modelle zuerst; FALLBACK erzwingt Cloud-Eskalation',async()=>{
 const rows=[route(1,'gemini'),route(2,'ollama')];let seen=[];
 const run=makeCascade({routes:()=>rows,key:()=>'',call:async r=>{seen.push(r.provider);return answer;}});
 await run([],{role:'DOCUMENTER'});assert.deepEqual(seen,['ollama']);
 seen=[];await run([],{role:'DOCUMENTER',strategy:'FALLBACK'});assert.deepEqual(seen,['gemini']);
});
test('Fehlende Keys, Cooldowns und Offline-Einträge werden ohne Netzwerkaufruf übersprungen',async()=>{
 const seen=[];const run=makeCascade({routes:()=>[route(1,'gemini','MISSING'),route(2,'groq','',{cooldown_until:Date.now()+60000}),route(3,'offline'),route(4,'ollama')],key:()=>'',call:async r=>{seen.push(r.provider);return answer;}});
 assert.equal((await run([])).content,answer.content);assert.deepEqual(seen,['ollama']);
});
test('Kein Schlaf vor Failover; Timeout, 429, 5xx und leere Antworten fallen durch',async()=>{
 for(const err of [Object.assign(new Error('429'),{status:429}),Object.assign(new Error('500'),{status:503}),Object.assign(new Error('timeout'),{name:'TimeoutError'})]){
  const seen=[];const run=makeCascade({routes:()=>[route(1,'gemini'),route(2,'ollama')],key:()=>'',call:async(r,_,opts)=>{seen.push(r.id);assert.ok(opts.timeoutMs<=90000);if(r.id===1)throw err;return answer;}});
  await run([],{strategy:'FALLBACK'});assert.deepEqual(seen,[1,2]);
 }
 const run=makeCascade({routes:()=>[route(1,'gemini'),route(2,'ollama')],key:()=>'',call:async r=>r.id===1?{content:''}:answer});assert.equal((await run([],{strategy:'FALLBACK'})).offline,false);
});
test('Vollausfall erzeugt 503 statt erfundener Planer-Antwort oder Token-Abrechnung',async()=>{
 const run=makeCascade({routes:()=>[route(1,'ollama')],key:()=>'',call:async()=>{throw new Error('private-key-must-not-leak');}});
 await assert.rejects(run([]),e=>e instanceof LlmUnavailableError&&e.statusCode===503&&!JSON.stringify(e).includes('private-key'));
 db.exec('DELETE FROM routes');await assert.rejects(chat([{role:'user',content:'Baue ein Projekt'}]),e=>e.code==='LLM_UNAVAILABLE');
});
test('Lokaler Parallelitätsdeckel reiht Requests ein statt parallele Villen als BUSY zu stoppen',async()=>{
 let release;const wait=new Promise(r=>release=r);const rows=[route(1,'ollama'),route(2,'lmstudio')];let calls=0;
 const run=makeCascade({routes:()=>rows,key:()=>'',call:async r=>{if(r.id===1){calls++;await wait;}return answer;}});
 const first=run([]);const second=run([]);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 release();const [a,b]=await Promise.all([first,second]);assert.equal(calls,2);assert.equal(a.failovers.length,0);assert.equal(b.failovers.length,0);
});
test('Keine doppelten Requests für denselben Endpoint und dasselbe Modell',async()=>{
 let n=0;const r=route(1,'gemini');const run=makeCascade({routes:()=>[r,{...r,id:2}],key:()=>'',call:async()=>{n++;throw Error('down');}});
 await assert.rejects(run([]));assert.equal(n,1);
});
test('Kaskade ist dauerhaft und idempotent; deaktivierte Einträge bleiben deaktiviert',()=>{
 db.exec('DELETE FROM routes');assert.ok(syncCascadeRoutes().added>=8);assert.equal(syncCascadeRoutes().added,0);
 assert.equal(db.prepare('SELECT model FROM routes WHERE name=?').get('Cascade: Gemini').model,'gemini-3.1-flash-lite');
 assert.equal(db.prepare('SELECT model FROM routes WHERE name=?').get('Cascade: Cerebras').model,'gpt-oss-120b');
 assert.equal(db.prepare('SELECT model FROM routes WHERE name=?').get('Cascade: Mistral').model,'mistral-small-latest');
 db.prepare('UPDATE routes SET enabled=0 WHERE name=?').run('Cascade: Ollama local');syncCascadeRoutes();assert.equal(db.prepare('SELECT enabled FROM routes WHERE name=?').get('Cascade: Ollama local').enabled,0);
 db.prepare('INSERT OR REPLACE INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('GOOGLE_API_KEY','test-only');assert.equal(resolveKey('GEMINI_API_KEY'),'test-only');
});
test('Startup-Migration korrigiert irreführende Free-Flags bestehender Route-Datensätze',()=>{
 db.exec('DELETE FROM routes');
 db.prepare('INSERT INTO routes(name,provider,base_url,model,is_free) VALUES (?,?,?,?,?)').run('Gemini','gemini-openai','https://generativelanguage.googleapis.com/v1beta/openai','gemini-3.1-flash-lite',0);
 db.prepare('INSERT INTO routes(name,provider,base_url,model,is_free) VALUES (?,?,?,?,?)').run('Cerebras trial','cerebras','https://api.cerebras.ai/v1','gpt-oss-120b',1);
 assert.deepEqual(syncFreeRouteFlags(),{updated:2});
 assert.equal(db.prepare('SELECT is_free FROM routes WHERE name=?').get('Gemini').is_free,1);
 assert.equal(db.prepare('SELECT is_free FROM routes WHERE name=?').get('Cerebras trial').is_free,0);
 assert.equal(syncFreeRouteFlags().updated,0);
});
test('Cloud-Zeitbudget reserviert Kapazität für das lokale Modell',async()=>{
 let time=0;const seen=[];const rows=[route(1,'gemini'),route(2,'groq'),route(3,'huggingface'),route(4,'ollama')];
 const run=makeCascade({routes:()=>rows,key:()=>'',clock:()=>time,call:async r=>{seen.push(r.provider);if(r.provider!=='ollama'){time+=24000;throw Error('timeout');}return answer;}});
 await run([],{strategy:'FALLBACK'});assert.deepEqual(seen,['gemini','ollama']);
});
test('Abgelaufener Schlüssel wird nicht mit jedem Modell desselben Providers erneut versucht',async()=>{
 const rows=[route(1,'gemini','KEY',{model:'a'}),route(2,'gemini','ALIAS',{model:'b'}),route(3,'ollama')];let seen=[];
 const run=makeCascade({routes:()=>rows,key:()=> 'same-test-key',call:async r=>{seen.push(r.id);if(r.id!==3)throw Object.assign(Error('unauthorized'),{status:401});return answer;}});
 await run([],{strategy:'FALLBACK'});assert.deepEqual(seen,[1,3]);seen=[];await run([],{strategy:'FALLBACK'});assert.deepEqual(seen,[3]);
});
test('Free-only mode uses approved free routes and skips paid or unknown cloud routes',async()=>{
 const rows=[
  {...route(1,'gemini'),model:'gemini-3.1-flash-lite'},
  {...route(2,'gemini'),model:'gemini-3.5-pro'},
  {...route(3,'cerebras'),model:'gpt-oss-120b'},
  {...route(4,'cerebras'),model:'paid-model'},
  {...route(5,'groq'),model:'openai/gpt-oss-120b'},
  {...route(6,'mistral'),model:'mistral-small-latest'},
  {...route(7,'mistral'),model:'mistral-large-latest'},
  {...route(8,'openrouter'),model:'openrouter/free'},
  {...route(9,'openrouter'),model:'anthropic/claude-sonnet'},
  {...route(10,'huggingface'),model:'meta-llama/Llama-3.3-70B-Instruct'},
  route(11,'xai'),route(12,'ollama')
 ];
 const seen=[];const run=createCascade({freeOnly:true,routes:()=>rows,key:()=>true,call:async r=>{seen.push(r.id);if(r.id!==12)throw Error('temporary');return answer;}});
 await run([],{strategy:'FALLBACK'});assert.deepEqual(seen,[1,5,8,12]);
 assert.equal(isFreeRoute({...route(20,'cerebras'),model:'qwen-3.8-27b'}),false);
 assert.equal(isFreeRoute({...route(21,'mistral'),model:'mistral-small-latest'}),false);
 assert.equal(isFreeRoute({...route(22,'gemini'),model:'gemini-3.5-flash-lite'}),false);
 assert.equal(isFreeRoute({...route(23,'openai-compatible'),base_url:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b'}),true);
 assert.equal(isFreeRoute({...route(24,'openai-compatible'),base_url:'https://router.huggingface.co/v1',model:'openai/gpt-oss-120b:cerebras'}),false);
});

test('Lernende Kaskade bevorzugt pro Prioritätsgruppe die bewährte schnellere Route',async()=>{
 const rows=[route(1,'groq','',{priority:2,weight:0.5,lat_ms:900}),route(2,'groq','',{priority:2,weight:1.8,lat_ms:180})];
 assert.equal(routeTier(rows[0]),routeTier(rows[1]));
 const seen=[];const run=makeCascade({routes:()=>rows,key:()=>'',call:async r=>{seen.push(r.id);return answer;}});
 await run([]);assert.deepEqual(seen,[2]);
});
test('Routing readiness marks blocked paid routes ineligible',()=>{
 process.env.VF_LLM_FREE_ONLY='1';db.exec('DELETE FROM routes');
 db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,priority) VALUES (?,?,?,?,?,?)').run('Paid route','xai','https://api.x.ai/v1','grok-latest','XAI_API_KEY',1);
 db.prepare('INSERT INTO routes(name,provider,base_url,model,key_env,priority) VALUES (?,?,?,?,?,?)').run('Local route','ollama','http://127.0.0.1:11434/v1','llama3.2:3b','',2);
 const routes=routingStatus().routes;
 assert.equal(routes.find(r=>r.name==='Paid route').eligible,false);
 assert.equal(routes.find(r=>r.name==='Local route').eligible,true);
 process.env.VF_LLM_FREE_ONLY='0';
});

test('Status und Kaskade zeigen dieselbe lokale Routine- und Qualitätsreihenfolge',async()=>{
 const {orderCascadeRoutes}=await import('../llm-cascade.mjs');
 const rows=[route(1,'ollama'),route(2,'groq'),route(3,'gemini')];
 assert.equal(orderCascadeRoutes(rows,{strategy:'LOCAL_FIRST',freeOnlyMode:false})[0].provider,'ollama');
 const quality=orderCascadeRoutes(rows,{role:'CODER',freeOnlyMode:false});
 assert.notEqual(quality[0].provider,'ollama');
 assert.equal(quality.at(-1).provider,'ollama');
});
