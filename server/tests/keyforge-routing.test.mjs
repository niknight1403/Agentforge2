import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'keyforge-routing-')), 'hub.db');
process.env.VF_LLM_FREE_ONLY = '1';
const [{ db }, keyforge, llm, config] = await Promise.all([
  import('../db.mjs'), import('../keyforge.mjs'), import('../llm.mjs'), import('../llm-config.mjs')
]);

function mockCompletion() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {}, body: JSON.parse(init?.body || '{}') });
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'route-ok' } }],
      model: calls.at(-1).body.model,
      usage: { total_tokens: 3 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('KeyForge registriert Groq als kostenlose, nutzbare Providerroute', async () => {
  db.prepare('INSERT INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('GROQ_API_KEY', 'gsk_test-route-key');
  const mock = mockCompletion();
  try {
    const result = await keyforge.keyforgeTick();
    assert.equal(result.actions.length, 2);
    const rows = db.prepare('SELECT provider,base_url,model,key_env,is_free FROM routes ORDER BY priority').all();
    assert.deepEqual(rows.map((r) => r.provider), ['groq', 'groq']);
    assert.ok(rows.every((r) => r.is_free === 1 && config.isFreeRoute(r)));
    assert.equal(llm.routingStatus().routes.filter((r) => r.eligible).length, 2);
    const response = await llm.chat([{ role: 'user', content: 'test' }]);
    assert.equal(response.content, 'route-ok');
    assert.match(mock.calls.at(-1).url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
    assert.equal(mock.calls.at(-1).headers.Authorization, 'Bearer gsk_test-route-key');
  } finally { mock.restore(); }
});

test('Gemini-KeyForge nutzt die aktuelle Free-Lite-Route; xAI ohne Modell wird übersprungen', async () => {
  db.exec('DELETE FROM routes; DELETE FROM secrets;');
  db.prepare('INSERT INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('GEMINI_API_KEY', 'AIza-test-route-key');
  db.prepare('INSERT INTO secrets(name,value,updated_at) VALUES (?,?,0)').run('XAI_API_KEY', 'xai-test-route-key');
  const mock = mockCompletion();
  try {
    const result = await keyforge.keyforgeTick();
    assert.equal(result.actions.length, 1);
    const route = db.prepare('SELECT provider,model,is_free FROM routes').get();
    assert.equal(route.provider, 'gemini-openai');
    assert.equal(route.model, 'gemini-3.1-flash-lite');
    assert.equal(route.is_free, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM keyforge_log WHERE action='unconfigured'").get().n, 1);
  } finally { mock.restore(); }
});
