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
const { cascadeDefaults, syncCascadeRoutes, syncFreeRouteFlags, isFreeRoute, routeProvider } = await import('../llm-config.mjs');

test('startup sync registers every configured OpenAI-compatible provider catalog route',()=>{
  const defaults=cascadeDefaults();
  const expected=FREE_ROUTE_CATALOG.filter(route=>route.baseUrl);
  for(const route of expected){
    assert.ok(defaults.some(item=>item.base_url===route.baseUrl&&item.model===route.model&&item.provider===route.provider),`missing ${route.provider}/${route.model}`);
  }
  syncCascadeRoutes();
  syncFreeRouteFlags();
  const rows=db.prepare('SELECT provider,base_url,model FROM routes').all();
  for(const route of expected){
    assert.ok(rows.some(row=>row.provider===route.provider&&row.base_url===route.baseUrl&&row.model===route.model),`route not persisted: ${route.provider}/${route.model}`);
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
