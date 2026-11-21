import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmRequestTimeoutMs } from '../llm.mjs';

test('xAI reasoning gets a longer bounded default timeout', () => {
  const previousXai = process.env.VF_XAI_TIMEOUT_MS;
  const previousGeneral = process.env.VF_LLM_TIMEOUT_MS;
  try {
    delete process.env.VF_XAI_TIMEOUT_MS;
    process.env.VF_LLM_TIMEOUT_MS = '15000';
    assert.equal(llmRequestTimeoutMs({ provider: 'xai' }), 360000);
    assert.equal(llmRequestTimeoutMs({ provider: 'groq' }), 15000);
    process.env.VF_XAI_TIMEOUT_MS = '240000';
    assert.equal(llmRequestTimeoutMs({ provider: 'xai' }), 240000);
    process.env.VF_XAI_TIMEOUT_MS = '99999999';
    assert.equal(llmRequestTimeoutMs({ provider: 'xai' }), 3600000);
    assert.equal(llmRequestTimeoutMs({ provider: 'xai' }, { timeoutMs: 30000 }), 30000);
  } finally {
    if (previousXai === undefined) delete process.env.VF_XAI_TIMEOUT_MS;
    else process.env.VF_XAI_TIMEOUT_MS = previousXai;
    if (previousGeneral === undefined) delete process.env.VF_LLM_TIMEOUT_MS;
    else process.env.VF_LLM_TIMEOUT_MS = previousGeneral;
  }
});
