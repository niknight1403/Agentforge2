import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRpm } from '../llm.mjs';

test('RPM budgets are selected by provider identity, not display name', () => {
  const keys = ['VF_RPM_GROQ', 'VF_RPM_XAI', 'VF_RPM_GEMINI', 'VF_RPM_DEFAULT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.VF_RPM_GROQ = '17';
    process.env.VF_RPM_XAI = '4';
    process.env.VF_RPM_GEMINI = '7';
    process.env.VF_RPM_DEFAULT = '31';
    assert.equal(routeRpm({ name: 'My renamed endpoint', provider: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1' }), 17);
    assert.equal(routeRpm({ name: 'Custom xAI alias', provider: 'xai', base_url: 'https://api.x.ai/v1' }), 4);
    assert.equal(routeRpm({ name: 'Gemini proxy name', provider: 'gemini-openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' }), 7);
    assert.equal(routeRpm({ name: 'Unclassified route', provider: 'openai-compatible', base_url: 'https://example.com/v1' }), 31);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
