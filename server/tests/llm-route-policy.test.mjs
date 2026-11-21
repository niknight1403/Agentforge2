import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLlmRouteInput } from '../llm-route-policy.mjs';

test('allows only canonical HTTPS provider endpoints and provider-specific key aliases', () => {
  assert.deepEqual(validateLlmRouteInput({
    provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY'
  }), {
    ok: true, provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY'
  });
  assert.equal(validateLlmRouteInput({
    provider: 'gemini-openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GOOGLE_API_KEY'
  }).ok, true);
  assert.equal(validateLlmRouteInput({
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: ''
  }).ok, true);
});

test('rejects attacker-controlled hosts, protocols, paths, credentials and secret aliases', () => {
  const invalid = [
    { provider: 'groq', baseUrl: 'https://attacker.example/openai/v1', keyEnv: 'GROQ_API_KEY' },
    { provider: 'groq', baseUrl: 'http://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
    { provider: 'groq', baseUrl: 'https://api.groq.com.evil.example/openai/v1', keyEnv: 'GROQ_API_KEY' },
    { provider: 'groq', baseUrl: 'https://user:pass@api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
    { provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1?token=secret', keyEnv: 'GROQ_API_KEY' },
    { provider: 'groq', baseUrl: 'https://api.groq.com/v1', keyEnv: 'OPENAI_API_KEY' },
    { provider: 'openai-compatible', baseUrl: 'https://attacker.example/v1', keyEnv: 'OPENAI_API_KEY' },
    { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434/v1', keyEnv: '' },
    { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', keyEnv: 'ANY_SECRET' }
  ];
  for (const input of invalid) assert.equal(validateLlmRouteInput(input).ok, false, JSON.stringify(input));
});

test('rejects custom Modal endpoints until deployment ownership is independently approved', () => {
  assert.equal(validateLlmRouteInput({
    provider: 'modal', baseUrl: 'https://workspace--app.modal.run/v1', keyEnv: 'MODAL_API_KEY'
  }).error, 'CUSTOM_MODAL_ENDPOINT_REQUIRES_DEPLOYMENT_APPROVAL');
});

test('rejects nonstandard ports on public provider hosts', () => {
  assert.equal(validateLlmRouteInput({
    provider: 'groq', baseUrl: 'https://api.groq.com:8443/openai/v1', keyEnv: 'GROQ_API_KEY'
  }).error, 'ENDPOINT_PORT_NOT_ALLOWED');
});

test('allows the canonical keyless Pollinations endpoint', () => {
  assert.deepEqual(validateLlmRouteInput({
    provider: 'pollinations', baseUrl: 'https://text.pollinations.ai/openai', keyEnv: ''
  }), {
    ok: true, provider: 'pollinations', baseUrl: 'https://text.pollinations.ai/openai', keyEnv: ''
  });
});
