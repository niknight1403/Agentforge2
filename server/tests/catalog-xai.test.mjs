import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_ROUTE_CATALOG } from '../routes.mjs';

test('Kaskade enthaelt xAI Grok als key-gestuetzte Route', () => {
  const xai = FREE_ROUTE_CATALOG.filter((r) => r.provider === 'xai');
  assert.equal(xai.length, 1, 'genau eine xAI-Route im Katalog');
  const r = xai[0];
  assert.equal(r.baseUrl, 'https://api.x.ai/v1');
  assert.equal(r.keyEnv, 'XAI_API_KEY');
  assert.ok(r.model && r.model.length > 0, 'Modellname gesetzt');
  assert.equal(typeof r.priority, 'number');
});

test('Kaskade deckt die geforderten Provider ab (OpenRouter, Gemini, Grok, Ollama)', () => {
  const providers = new Set(FREE_ROUTE_CATALOG.map((r) => r.provider));
  for (const p of ['openrouter', 'gemini-openai', 'xai', 'ollama']) {
    assert.ok(providers.has(p), 'Provider fehlt: ' + p);
  }
});

test('Offline-Fallback existiert als Code-Pfad in llm.mjs', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../llm.mjs', import.meta.url), 'utf8');
  assert.match(src, /offline/i, 'llm.mjs muss einen Offline-Pfad kennen');
});

test('Keine API-Keys im Katalog, nur Env-Namen', () => {
  for (const r of FREE_ROUTE_CATALOG) {
    assert.ok(!/sk-|AIza|^xai-/.test(String(r.keyEnv)), 'keyEnv darf nur ein Env-Name sein');
  }
});
