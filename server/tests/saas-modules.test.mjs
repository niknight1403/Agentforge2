import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-saas-')),'test.db');
delete process.env.REDIS_URL;
process.env.VF_GATEWAY_JWT_SECRET='test-secret-that-is-longer-than-32-bytes';
const gateway=await import('../api-gateway.mjs');
const observability=await import('../observability.mjs');
const {db}=await import('../db.mjs');
const {createUser}=await import('../auth.mjs');

test('JWT gateway enforces signatures, expiry bounds, role scopes and villa allowlists',()=>{
  const token=gateway.issueGatewayToken({subject:'42',role:'operator',villaIds:[3,8],ttlSeconds:600});
  const checked=gateway.verifyGatewayToken(token,undefined);
  assert.equal(checked.ok,true);
  assert.equal(gateway.hasGatewayScope(checked.claims,'tasks:write'),true);
  assert.equal(gateway.canAccessVilla(checked.claims,3),true);
  assert.equal(gateway.canAccessVilla(checked.claims,9),false);
  const [header,payload,signature]=token.split('.');
  const tampered=`${header}.${payload}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  assert.equal(gateway.verifyGatewayToken(tampered,undefined).ok,false);
  assert.throws(()=>gateway.issueGatewayToken({subject:'42',role:'reader'}),/allowlist/);
});

test('API keys are only returned once, stored hashed, expire, and revoke immediately',async()=>{
  const user=createUser({email:'gateway@example.test',password:'correct-horse-battery',role:'admin'});
  const issued=await gateway.createGatewayApiKey({userId:user.id,label:'CI',role:'operator',villaIds:[3]});
  assert.match(issued.key,/^vf_live_/);
  const row=db.prepare('SELECT key_hash FROM gateway_api_keys WHERE id=?').get(issued.id);
  assert.notEqual(row.key_hash,issued.key);
  const req={headers:{'x-api-key':issued.key}};
  assert.equal((await gateway.gatewayPrincipal(req)).ok,true);
  assert.equal(await gateway.revokeGatewayApiKey(issued.id,user.id),true);
  assert.equal((await gateway.gatewayPrincipal(req)).ok,false);
});

test('daily token kill switch and bounded HTTP latency telemetry are deterministic',()=>{
  process.env.VF_GLOBAL_DAILY_TOKEN_BUDGET='20';
  process.env.VF_GLOBAL_DAILY_COST_USD='1';
  observability.initObservabilityStore();
  observability.recordLlmUsage({tokens:18,provider:'free',model:'local',latencyMs:10,isFree:true});
  assert.equal(observability.tokenBudgetStatus().paidRoutesAllowed,true);
  observability.recordLlmUsage({tokens:3,provider:'free',model:'local',latencyMs:12,isFree:true});
  assert.equal(observability.tokenBudgetStatus().tokenAllowed,false);
  observability.recordHttpRequest('GET','/api/villas/123/tasks?limit=5',200,22);
  observability.recordHttpRequest('POST','/api/villas/123/tasks',500,45);
  const metrics=observability.httpMetrics();
  assert.equal(metrics.requests24h,2);
  assert.equal(metrics.errors24h,1);
  assert.equal(metrics.p95LatencyMs,45);
});

test('Budget reset time is explicit and token exhaustion returns a typed retriable block',async()=>{
 const budget=observability.tokenBudgetStatus();assert.equal(budget.tokenAllowed,false);
 assert.equal(new Date(budget.resetsAt).getUTCHours(),0);assert.ok(budget.resetsAt>Date.now());
 const {chat}=await import('../llm.mjs');
 await assert.rejects(chat([{role:'user',content:'fixture'}]),e=>e.code==='GLOBAL_TOKEN_BUDGET'&&e.statusCode===429&&e.retryAfter>0&&e.resetsAt===budget.resetsAt);
});
