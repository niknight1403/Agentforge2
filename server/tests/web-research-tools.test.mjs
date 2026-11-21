import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../agents.mjs';

const ctx = { villaId: 1, agentId: 1 };

test('Websuche wechselt bei HTTP-Fehler der ersten Stufe auf Lite', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return { ok: false, status: 429 };
    return { ok: true, status: 200, text: async () => '<a href="https://example.org/article">Beleg</a>' };
  };
  try {
    const result = await runTool(ctx, 'web_search', { query: 'recherche' });
    assert.match(result, /example\.org\/article/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test('Websuche lehnt ueberlange Anfragen ohne Netzwerkzugriff ab', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Netzwerk darf nicht benutzt werden'); };
  try { assert.match(await runTool(ctx, 'web_search', { query: 'x'.repeat(501) }), /zu lang/); }
  finally { globalThis.fetch = original; }
});

test('Webabruf lehnt lokale Adressen und Zugangsdaten ohne Netzwerkzugriff ab', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Netzwerk darf nicht benutzt werden'); };
  try {
    for (const url of ['http://127.0.0.1/admin', 'http://[::1]/', 'http://localhost/', 'https://user:password@example.org/']) {
      assert.match(await runTool(ctx, 'web_fetch', { url }), /erlaubt/);
    }
  } finally { globalThis.fetch = original; }
});
