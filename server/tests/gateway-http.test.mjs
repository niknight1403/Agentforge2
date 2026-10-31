import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-gateway-http-')),'test.db');
process.env.PORT=String(42100+Math.floor(Math.random()*300));
process.env.HOST='127.0.0.1';
process.env.VF_GATEWAY_JWT_SECRET='gateway-test-secret-minimum-length-32-bytes';
delete process.env.REDIS_URL;
const {db,now}=await import('../db.mjs');
const {upsertUser}=await import('../auth.mjs');
const {server}=await import('../server.mjs');
after(()=>server.close());
const BASE=`http://127.0.0.1:${process.env.PORT}`;
async function api(path,method='GET',token,body,extra={}){const r=await fetch(BASE+path,{method,headers:{...(token?{'authorization':`Bearer ${token}`}:{ }),...(body?{'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}

test('gateway JWT and Redis-backed API key enforce scope and immediate revocation over HTTP',async()=>{
  upsertUser({email:'gateway-admin@example.test',password:'correct-horse-123',role:'admin',plan:'pro'});
  const login=await api('/api/auth/login','POST',null,{email:'gateway-admin@example.test',password:'correct-horse-123'});
  assert.equal(login.status,200);
  const t=now(),villaId=Number(db.prepare('INSERT INTO villas(name,idea,status,created_at,updated_at) VALUES (?,?,?,?,?)').run('API Villa','Test API','PAUSED',t,t).lastInsertRowid);
  const minted=await api('/api/admin/gateway-token','POST',login.body.token,{role:'reader',villaIds:[villaId]});
  assert.equal(minted.status,201);
  assert.deepEqual(minted.body.scopes,['villas:read']);
  const list=await api('/api/v1/gateway/villas','GET',minted.body.token);
  assert.equal(list.status,200);assert.equal(list.body.length,1);assert.equal(list.body[0].id,villaId);
  const denied=await api(`/api/v1/gateway/villas/${villaId}/start`,'POST',minted.body.token);
  assert.equal(denied.status,403);
  const created=await api('/api/v1/gateway-keys','POST',login.body.token,{label:'test',role:'reader',villaIds:[villaId]});
  assert.equal(created.status,201);
  assert.ok(created.body.key.startsWith('vf_live_'));
  assert.equal((await api('/api/v1/gateway/villas','GET',null,null,{'x-api-key':created.body.key})).status,200);
  assert.equal((await api(`/api/v1/gateway-keys/${created.body.id}`,'DELETE',login.body.token)).status,200);
  assert.equal((await api('/api/v1/gateway/villas','GET',null,null,{'x-api-key':created.body.key})).status,401);
});

test('fleet diagnostics require admin auth and never disclose prompts',async()=>{
 assert.equal((await api('/api/admin/villa-diagnostics')).status,401);
 upsertUser({email:'diagnostic-reader@example.test',password:'correct-horse-123',role:'user',plan:'free'});
 const reader=await api('/api/auth/login','POST',null,{email:'diagnostic-reader@example.test',password:'correct-horse-123'});
 assert.equal((await api('/api/admin/villa-diagnostics','GET',reader.body.token)).status,403);
 const admin=await api('/api/auth/login','POST',null,{email:'gateway-admin@example.test',password:'correct-horse-123'});
 const result=await api('/api/admin/villa-diagnostics','GET',admin.body.token);
 assert.equal(result.status,200);assert.equal(result.body.readOnly,true);assert.ok(Array.isArray(result.body.villas));assert.ok(Array.isArray(result.body.media));assert.doesNotMatch(JSON.stringify(result.body),/system_prompt|template_hash|secret_env/);
});

test('capability requests are admin-only and never start or enable a paused Villa',async()=>{
 const t=now(),villaId=Number(db.prepare('INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('Pause behalten','Export als echte App-Funktion','PAUSED',0,t,t).lastInsertRowid);
 assert.equal((await api(`/api/villas/${villaId}/capabilities`)).status,401);
 const admin=await api('/api/auth/login','POST',null,{email:'gateway-admin@example.test',password:'correct-horse-123'});
 const out=await api(`/api/villas/${villaId}/capabilities`,'POST',admin.body.token,{id:'verified-export',kind:'feature',title:'Dateiexport entwickeln',goal:'Erzeuge einen nutzbaren JSON-Export im existierenden Projekt.',acceptance:'Ein ausfuehrbarer Test prueft die tatsaechlichen exportierten Daten.'});
 assert.equal(out.status,201);assert.equal(out.body.status,'proposed');assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(villaId).autonomy,0);
 const status=await api(`/api/villas/${villaId}/capabilities`,'GET',admin.body.token);assert.equal(status.body.runsWithVilla,false);assert.ok((await api('/api/health')).body.capabilities.includes('capability-autopilot-v1'));
});
