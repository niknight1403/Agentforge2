import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRpm, resolveKey } from '../llm.mjs';
import { routeProvider } from '../llm-config.mjs';

test('RPM budgets are selected by provider identity, not display name', () => {
  const keys = ['VF_RPM_GROQ', 'VF_RPM_XAI', 'VF_RPM_GEMINI', 'VF_RPM_SAMBANOVA', 'VF_RPM_POLLINATIONS', 'VF_RPM_DEFAULT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.VF_RPM_GROQ = '17';
    process.env.VF_RPM_XAI = '4';
    process.env.VF_RPM_GEMINI = '7';
    process.env.VF_RPM_SAMBANOVA = '9';
    process.env.VF_RPM_POLLINATIONS = '4';
    process.env.VF_RPM_DEFAULT = '31';
    assert.equal(routeRpm({ name: 'My renamed endpoint', provider: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1' }), 17);
    assert.equal(routeRpm({ name: 'Custom xAI alias', provider: 'xai', base_url: 'https://api.x.ai/v1' }), 4);
    assert.equal(routeRpm({ name: 'Gemini proxy name', provider: 'gemini-openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' }), 7);
    assert.equal(routeRpm({ name: 'SambaNova alias', provider: 'openai-compatible', base_url: 'https://api.sambanova.ai/v1' }), 9);
    assert.equal(routeRpm({ name: 'NVIDIA alias', provider: 'openai-compatible', base_url: 'https://integrate.api.nvidia.com/v1' }), 6);
    assert.equal(routeRpm({ name: 'Pollinations keyless', provider: 'openai-compatible', base_url: 'https://text.pollinations.ai/openai' }), 4);
    assert.equal(routeRpm({ name: 'Unclassified route', provider: 'openai-compatible', base_url: 'https://example.com/v1' }), 31);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('provider host inference covers every additional catalog API', () => {
  const cases = [
    ['sambanova', 'https://api.sambanova.ai/v1'],
    ['nvidia', 'https://integrate.api.nvidia.com/v1'],
    ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'],
    ['chutes', 'https://llm.chutes.ai/v1'],
    ['hyperbolic', 'https://api.hyperbolic.xyz/v1'],
    ['together', 'https://api.together.xyz/v1'],
    ['fal', 'https://fal.run/openrouter/router/openai/v1'],
    ['pollinations', 'https://text.pollinations.ai/openai'],
    ['ollama', 'https://ollama.cybersarah-ki.com/v1'],
  ];
  for (const [provider, base_url] of cases) {
    assert.equal(routeProvider({ provider: 'openai-compatible', base_url }), provider, base_url);
  }
});

test('Gemini and Hugging Face credential aliases resolve in both directions', () => {
  const keys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'gemini-alias-secret';
    assert.equal(resolveKey('GEMINI_API_KEY'), 'gemini-alias-secret');
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'google-alias-secret';
    assert.equal(resolveKey('GOOGLE_API_KEY'), 'google-alias-secret');

    delete process.env.HUGGINGFACE_API_KEY;
    process.env.HF_TOKEN = 'hf-alias-secret';
    assert.equal(resolveKey('HUGGINGFACE_API_KEY'), 'hf-alias-secret');
    delete process.env.HF_TOKEN;
    process.env.HUGGINGFACE_API_KEY = 'huggingface-alias-secret';
    assert.equal(resolveKey('HF_TOKEN'), 'huggingface-alias-secret');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
