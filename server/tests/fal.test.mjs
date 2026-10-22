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
const { mediaCapabilities, generateMedia } = await import('../media.mjs');
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

test('Capability-Register meldet jede Medienroute und den ehrlichen Status', () => {
  db.prepare("UPDATE secrets SET value = '' WHERE name = 'FAL_KEY'").run();
  const caps = mediaCapabilities();
  for (const id of ['app_development', 'image_generation', 'image_editing', 'video_generation', 'audio_generation', 'live_performance']) {
    assert.ok(caps.some((c) => c.id === id), `Capability ${id} fehlt`);
  }
  assert.equal(caps.find((c) => c.id === 'video_generation').status, 'needs_provider');
  assert.match(caps.find((c) => c.id === 'video_generation').action, /FAL_KEY/);
});

test('media_prepare erstellt ein klares Video-Produktionspaket ohne Rendering vorzutäuschen', async () => {
  db.prepare("UPDATE secrets SET value = '' WHERE name = 'FAL_KEY'").run();
  const out = await runTool({ villaId: 9, agentId: 1 }, 'media_prepare', { type: 'video', title: 'Launch Clip', prompt: 'Produktdemo für Musiker', durationSeconds: 20 });
  assert.match(out, /kein gerendertes Medium/);
  const file = join(WORKSPACE, 'villa-9', 'media-video-Launch-Clip.md');
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  assert.match(text, /Shotlist/);
  assert.match(text, /Rendering ausstehend/);
});

test('fal.ai-Routen rendern und speichern Video sowie Audio mit passendem Dateityp', async () => {
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('FAL_KEY', 'fal-test-key', 0) ON CONFLICT(name) DO UPDATE SET value='fal-test-key'").run();
  for (const [type, model, url, mime, bytes] of [
    ['video', 'fal-ai/wan/v2.7/text-to-video', 'https://cdn.fal.test/clip.mp4', 'video/mp4', [0, 0, 0, 24]],
    ['audio', 'minimax/music-3', 'https://cdn.fal.test/track.mp3', 'audio/mpeg', [73, 68, 51]],
  ]) {
    const calls = [];
    const result = await generateMedia({ villaId: 10, type, prompt: 'Testproduktion', filename: `test-${type}`, fetchImpl: async (target, init) => {
      calls.push({ url: String(target), init });
      if (String(target) === `https://fal.run/${model}`) return new Response(JSON.stringify({ [type]: { url } }), { status: 200 });
      if (String(target) === url) return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': mime } });
      throw new Error(`Unexpected request ${target}`);
    }});
    assert.equal(result.type, type);
    assert.match(result.path, new RegExp(`test-${type}\\.${type === 'video' ? 'mp4' : 'mp3'}$`));
    assert.equal(calls[0].init.headers.Authorization, 'Key fal-test-key');
    assert.equal(readFileSync(join(WORKSPACE, result.path)).length, bytes.length);
  }
});

test('Bildbearbeitung braucht eine öffentliche HTTPS-Quelle und blockt lokale Ziele', async () => {
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('FAL_KEY', 'fal-test-key', 0) ON CONFLICT(name) DO UPDATE SET value='fal-test-key'").run();
  await assert.rejects(() => generateMedia({ villaId: 11, type: 'image_edit', prompt: 'Stil ändern', sourceImageUrl: 'http://127.0.0.1/private.png' }), /Sicherheitsgründen/);
  await assert.rejects(() => generateMedia({ villaId: 11, type: 'image_edit', prompt: 'Stil ändern', sourceImageUrl: 'https://example.com/image.png', fetchImpl: async () => new Response(JSON.stringify({ images: [{ url: 'http://localhost/private.png' }] }), { status: 200 }) }), /Sicherheitsgründen/);
});

test('Medien-Pack schaltet das Werkzeug echt ab', () => {
  setPackEnabled('medien', false);
  assert.equal(canUseTool('media_generate').allowed, false);
  setPackEnabled('medien', true);
  assert.equal(canUseTool('media_generate').allowed, true);
});
