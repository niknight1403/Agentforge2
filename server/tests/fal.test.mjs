/**
 * Sprint 2 (v1.33.0) — Fal.ai-Integration.
 *
 * 1. LLM-Route: OpenAI-kompatibler OpenRouter-Router auf fal.run, aber mit
 *    "Authorization: Key"-Header statt Bearer.
 * 2. Werkzeug media_generate: erzeugt Bilder (FLUX u. a.) und speichert sie
 *    als Artefakt im Villa-Workspace — Muendigkeits- und Marketing-Schub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fal-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');
process.env.VF_LLM_FREE_ONLY = '0'; // route-auth tests exercise the full provider catalog

const { FREE_ROUTE_CATALOG } = await import('../routes.mjs');
const { db } = await import('../db.mjs');
const { chat } = await import('../llm.mjs');
const { runTool, WORKSPACE } = await import('../agents.mjs');
const { setPackEnabled, canUseTool } = await import('../packs.mjs');

test('Katalog enthaelt die Fal.ai-LLM-Route mit Key-Env und fal.run-Basis', () => {
  const fal = FREE_ROUTE_CATALOG.find((r) => r.provider === 'fal');
  assert.ok(fal, 'fal-Route fehlt im Katalog');
  assert.equal(fal.keyEnv, 'FAL_KEY');
  assert.match(fal.baseUrl, /^https:\/\/fal\.run\/openrouter/);
  assert.equal(typeof fal.priority, 'number');
});

test('chat() sendet Authorization: Key an Fal-Routen (nicht Bearer)', async () => {
  db.prepare(
    "INSERT INTO secrets (name, value, updated_at) VALUES ('FAL_KEY', 'fal-test-key', 0)"
  ).run();
  db.prepare(
    "INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,1,1,10,1,'NEW',0,0,0)"
  ).run('Fal.ai Test', 'fal', 'https://fal.run/openrouter/router/openai/v1', 'google/gemma-4-31b-it:free', 'FAL_KEY');

  let seen = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), auth: init?.headers?.Authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hallo vom Fal-Router' } }], model: 'gemma' }), { status: 200 });
  };
  try {
    const out = await chat([{ role: 'user', content: 'Test' }], {});
    assert.equal(out.content, 'Hallo vom Fal-Router');
    assert.equal(seen.url, 'https://fal.run/openrouter/router/openai/v1/chat/completions');
    assert.equal(seen.auth, 'Key fal-test-key');
    assert.equal(seen.body.model, 'google/gemma-4-31b-it:free');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('media_generate erzeugt ein Bild und legt es im Workspace ab', async () => {
  db.prepare(
    "INSERT INTO secrets (name, value, updated_at) VALUES ('FAL_KEY', 'fal-test-key', 0) ON CONFLICT(name) DO UPDATE SET value='fal-test-key'"
  ).run();
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith('https://fal.run/')) {
      assert.equal(init.headers.Authorization, 'Key fal-test-key');
      assert.equal(JSON.parse(init.body).prompt, 'Ein Logo fuer die Villa');
      return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal.test/logo.png' }] }), { status: 200 });
    }
    if (String(url) === 'https://cdn.fal.test/logo.png') {
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    }
    throw new Error('unerwarteter Fetch: ' + url);
  };
  try {
    const out = await runTool({ villaId: 1, agentId: 1 }, 'media_generate', { prompt: 'Ein Logo fuer die Villa', filename: 'logo' });
    assert.match(out, /logo\.png/);
    assert.ok(calls.some((u) => u.startsWith('https://fal.run/fal-ai/flux/schnell')));
    assert.ok(existsSync(join(WORKSPACE, 'villa-1', 'logo.png')));
    assert.equal(readFileSync(join(WORKSPACE, 'villa-1', 'logo.png')).length, 4);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('media_generate blockt sauber ohne FAL_KEY (freundliche Meldung)', async () => {
  db.prepare("UPDATE secrets SET value = '' WHERE name = 'FAL_KEY'").run();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('darf nicht aufgerufen werden'); };
  try {
    const out = await runTool({ villaId: 1, agentId: 1 }, 'media_generate', { prompt: 'x' });
    assert.match(out, /FAL_KEY/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Medien-Pack schaltet das Werkzeug echt ab', () => {
  setPackEnabled('medien', false);
  assert.equal(canUseTool('media_generate').allowed, false);
  setPackEnabled('medien', true);
  assert.equal(canUseTool('media_generate').allowed, true);
});
