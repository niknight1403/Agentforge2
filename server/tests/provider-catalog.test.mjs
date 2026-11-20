import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.VF_TEST='1';
process.env.VF_DB=join(mkdtempSync(join(tmpdir(),'vf-provider-catalog-')),'db.sqlite');
process.env.VF_LLM_FREE_ONLY='1';

const { FREE_ROUTE_CATALOG } = await import('../routes.mjs');
const { db } = await import('../db.mjs');
const { cascadeDefaults, syncCascadeRoutes, syncFreeRouteFlags, isFreeRoute, routeProvider, seedRouteCatalog, isLocalRoute, isTrustedSelfHostedRoute } = await import('../llm-config.mjs');
const { resolveKey, routeRpm } = await import('../llm.mjs');

test('fresh route seed enables only verified free/local routes',()=>{
  const seeded=seedRouteCatalog();
  assert.equal(seeded.seeded,FREE_ROUTE_CATALOG.length);
  const rows=db.prepare('SELECT provider,base_url,model,is_free,enabled FROM routes').all();
  assert.equal(rows.length,FREE_ROUTE_CATALOG.length);
  for(const row of rows){
    assert.equal(Number(row.enabled),Number(isFreeRoute(row)),`unsafe default enablement: ${row.provider}/${row.model}`);
    assert.equal(Number(row.is_free),Number(isFreeRoute(row)));
  }
  assert.equal(seedRouteCatalog().seeded,0,'seed must not overwrite existing administrator state');
});

test('startup sync registers every configured OpenAI-compatible provider catalog route',()=>{
  const defaults=cascadeDefaults();
  const expected=FREE_ROUTE_CATALOG.filter(route=>route.baseUrl);
  for(const route of expected){
    assert.ok(defaults.some(item=>item.base_url===route.baseUrl&&item.model===route.model),`missing ${route.provider}/${route.model}`);
  }
  syncCascadeRoutes();
  syncFreeRouteFlags();
  const rows=db.prepare('SELECT provider,base_url,model FROM routes').all();
  for(const route of expected){
    assert.ok(rows.some(row=>row.base_url===route.baseUrl&&row.model===route.model),`route not persisted: ${route.provider}/${route.model}`);
  }
});

test('Pollinations keyless route is present and enabled on first startup sync',()=>{
  syncCascadeRoutes();syncFreeRouteFlags();
  const route=db.prepare("SELECT * FROM routes WHERE provider='pollinations' AND base_url='https://text.pollinations.ai/openai'").get();
  assert.ok(route);
  assert.equal(route.key_env,'');
  assert.equal(Number(route.is_free),1);
  assert.equal(Number(route.enabled),1);
  assert.equal(isFreeRoute(route),true);
});

test('paid, credit-based and unknown providers are registered but disabled by default',()=>{
  syncCascadeRoutes();syncFreeRouteFlags();
  for(const provider of ['cerebras','mistral','sambanova','nvidia','zhipu','chutes','hyperbolic','together','huggingface','xai','fal']){
    const route=db.prepare('SELECT * FROM routes WHERE provider=? LIMIT 1').get(provider);
    if(!route)continue; // optional endpoint presets such as Modal may require explicit configuration.
    assert.equal(Number(route.is_free),0,`${provider} must not be labelled permanently free`);
    assert.equal(Number(route.enabled),0,`${provider} must require explicit administrator opt-in`);
  }
});

test('catalog sync is idempotent and never re-enables an administrator-disabled free route',()=>{
  syncCascadeRoutes();syncFreeRouteFlags();
  const route=db.prepare("SELECT id FROM routes WHERE provider='pollinations'").get();
  db.prepare('UPDATE routes SET enabled=0 WHERE id=?').run(route.id);
  const before=db.prepare('SELECT COUNT(*) AS count FROM routes').get().count;
  assert.equal(syncCascadeRoutes().added,0);
  syncFreeRouteFlags();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM routes').get().count,before);
  assert.equal(Number(db.prepare('SELECT enabled FROM routes WHERE id=?').get(route.id).enabled),0);
});

test('Gemini OpenAI-compatible routes honor the documented VF_RPM_GEMINI override',()=>{
  const previous=process.env.VF_RPM_GEMINI;
  try{
    process.env.VF_RPM_GEMINI='3';
    assert.equal(routeRpm({provider:'gemini-openai',base_url:'https://generativelanguage.googleapis.com/v1beta/openai',model:'gemini-3.1-flash-lite'}),3);
  }finally{
    if(previous===undefined)delete process.env.VF_RPM_GEMINI;else process.env.VF_RPM_GEMINI=previous;
  }
});

test('remote self-hosted Ollama endpoints require an explicit trusted-host allowlist',()=>{
  const previous=process.env.VF_LLM_TRUSTED_SELF_HOSTED_HOSTS;
  const remote={provider:'ollama',base_url:'https://ollama.example.test/v1',model:'llama3.2:3b'};
  try{
    delete process.env.VF_LLM_TRUSTED_SELF_HOSTED_HOSTS;
    assert.equal(isLocalRoute(remote),false);
    assert.equal(isTrustedSelfHostedRoute(remote),false);
    assert.equal(isFreeRoute(remote),false,'remote Ollama must not be assumed free');
    process.env.VF_LLM_TRUSTED_SELF_HOSTED_HOSTS='other.example.test, ollama.example.test';
    assert.equal(isTrustedSelfHostedRoute(remote),true);
    assert.equal(isFreeRoute(remote),true);
    assert.equal(isLocalRoute({provider:'ollama',base_url:'http://127.0.0.1:11434/v1'}),true);
  }finally{
    if(previous===undefined)delete process.env.VF_LLM_TRUSTED_SELF_HOSTED_HOSTS;else process.env.VF_LLM_TRUSTED_SELF_HOSTED_HOSTS=previous;
  }
});

test('provider host inference covers the integrated API families',()=>{
  const cases={
    'https://api.sambanova.ai/v1':'sambanova',
    'https://integrate.api.nvidia.com/v1':'nvidia',
    'https://open.bigmodel.cn/api/paas/v4':'zhipu',
    'https://llm.chutes.ai/v1':'chutes',
    'https://api.hyperbolic.xyz/v1':'hyperbolic',
    'https://api.together.xyz/v1':'together',
    'https://text.pollinations.ai/openai':'pollinations',
    'https://fal.run/openrouter/router/openai/v1':'fal',
    'https://my-workspace--llm.modal.run/v1':'modal'
  };
  for(const [base_url,provider] of Object.entries(cases)){
    assert.equal(routeProvider({provider:'openai-compatible',base_url}),provider,base_url);
  }
});

test('Hugging Face credential aliases resolve from either supported secret name',()=>{
  db.prepare("INSERT INTO secrets(name,value,updated_at) VALUES ('HF_TOKEN','hf-test-secret',0) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run();
  assert.equal(resolveKey('HUGGINGFACE_API_KEY'),'hf-test-secret');
  db.prepare("INSERT INTO secrets(name,value,updated_at) VALUES ('GOOGLE_API_KEY','google-test-secret',0) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run();
  assert.equal(resolveKey('GEMINI_API_KEY'),'google-test-secret');
});

test('Modal custom route is included only for credential-free HTTPS modal.run endpoints',()=>{
  const previous=process.env.MODAL_BASE_URL;
  try{
    process.env.MODAL_BASE_URL='https://agentforge--inference.modal.run/v1';
    assert.ok(cascadeDefaults().some(route=>route.provider==='modal'&&route.base_url===process.env.MODAL_BASE_URL));
    process.env.MODAL_BASE_URL='https://127.0.0.1/v1';
    assert.ok(!cascadeDefaults().some(route=>route.provider==='modal'));
    process.env.MODAL_BASE_URL='https://agentforge--inference.modal.run/v1?token=do-not-allow';
    assert.ok(!cascadeDefaults().some(route=>route.provider==='modal'));
  }finally{
    if(previous===undefined)delete process.env.MODAL_BASE_URL;else process.env.MODAL_BASE_URL=previous;
  }
});
