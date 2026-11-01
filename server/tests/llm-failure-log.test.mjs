import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('LlmUnavailableError traegt die versuchten Routen unter attempts', async () => {
  const { createCascade } = await import('../llm-cascade.mjs');
  const routes = [
    { id: 1, name: 'lokal-a', provider: 'ollama', base_url: 'http://127.0.0.1:11434', model: 'm', enabled: 1, cooldown_until: 0 },
    { id: 2, name: 'lokal-b', provider: 'ollama', base_url: 'http://127.0.0.1:11435', model: 'm', enabled: 1, cooldown_until: 0 }
  ];
  const cascade = createCascade({
    routes: () => routes,
    key: () => '',
    call: async () => { throw Object.assign(new Error('down'), { code: 'CONNECTION_ERROR' }); },
    clock: () => Date.now(),
    freeOnly: () => false
  });
  const error = await cascade([{ role: 'user', content: 'hallo' }], { priority: 'interactive', totalTimeoutMs: 5000 }).catch((e) => e);
  assert.equal(error.code, 'LLM_UNAVAILABLE');
  assert.ok(Array.isArray(error.attempts) && error.attempts.length > 0, 'attempts muss die Fehlversuche enthalten');
  assert.equal(error.attempts[0].code, 'CONNECTION_ERROR');
  assert.ok(typeof error.attempts[0].route === 'string');
});
