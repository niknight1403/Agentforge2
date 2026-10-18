/**
 * Sprint 9 (v1.39.0) — Externe Integrationen.
 *
 * Bewertung der Wunschliste (2026-10-14 recherchiert):
 *   - HuggingFace: OpenAI-kompatibler Router, Free-Tier — SINNERVOLL,
 *     als LLM-Route integriert (keyEnv HUGGINGFACE_API_KEY).
 *   - Fireflies.ai: GraphQL-API, Token noetig — als Werkzeug (Meetings
 *     mit Aktionspunkten als Villa-Kontext), Token-gated.
 *   - Asana: REST-API mit Personal Access Token, Free-Tier — als
 *     Werkzeuge (Projekte listen, Aufgaben anlegen), Token-gated.
 *   - Scite (Zitations-API, kostenpflichtig/Nische), Granola (keine
 *     oeffentliche API), ProductLane (keine freie API) und Supabase
 *     (Hub laeuft bereits auf eigener SQLite-VM) — NICHT integriert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'extern-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { FREE_ROUTE_CATALOG } = await import('../routes.mjs');
const { db, now } = await import('../db.mjs');
const { runTool } = await import('../agents.mjs');
const { setPackEnabled, canUseTool } = await import('../packs.mjs');

test('HuggingFace-Route steht im Katalog mit Router-Endpoint', () => {
  const r = FREE_ROUTE_CATALOG.find((x) => x.provider === 'huggingface');
  assert.ok(r, 'huggingface-Route fehlt');
  assert.equal(r.baseUrl, 'https://router.huggingface.co/v1');
  assert.equal(r.keyEnv, 'HUGGINGFACE_API_KEY');
  assert.ok(r.priority >= 1, 'gueltige Prioritaet');
});

test('Fireflies-Werkzeug ohne Token gibt eine klare Anleitung', async () => {
  const out = await runTool({ villaId: 1, agentId: 1 }, 'fireflies_transcripts', { limit: 3 });
  assert.match(out, /Kein FIREFLIES_API_KEY/);
  assert.match(out, /Secret/);
});

test('Fireflies-Werkzeug liest Meetings mit Aktionspunkten (mit Token)', async () => {
  db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('FIREFLIES_API_KEY','ff-token',0)").run();
  const orig = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (url, init) => {
    payload = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { user: { recent_transcripts: [
      { title: 'Kickoff CSC', date: '2026-10-14', action_items: [{ description: 'API-Key generieren' }] },
      { title: 'Weekly', date: '2026-10-13', action_items: [] }
    ] } } }), { status: 200 });
  };
  try {
    const out = await runTool({ villaId: 1, agentId: 1 }, 'fireflies_transcripts', { limit: 2 });
    assert.ok(payload.url.includes('api.fireflies.ai/graphql'));
    assert.equal(payload.body.variables.limit, 2);
    assert.match(out, /Kickoff CSC/);
    assert.match(out, /API-Key generieren/);
    assert.match(out, /Weekly \(2026-10-13\): keine Aktionspunkte/);
  } finally { globalThis.fetch = orig; }
});

test('Asana: Projekte listen und Aufgabe anlegen (mit und ohne Projekt-GID)', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/projects')) return new Response(JSON.stringify({ data: [{ name: 'CSC-Produkt', gid: '120001', archived: false }] }), { status: 200 });
    if (String(url).includes('/workspaces')) return new Response(JSON.stringify({ data: [{ name: 'Villa', gid: '777' }] }), { status: 200 });
    if (String(url).endsWith('/tasks') && init.method === 'POST') {
      const body = JSON.parse(init.body).data;
      return new Response(JSON.stringify({ data: { name: body.name, gid: '9001' } }), { status: 200 });
    }
    throw new Error('unerwartet: ' + url);
  };
  try {
    // Ohne Token: Anleitung
    const hint = await runTool({ villaId: 1, agentId: 1 }, 'asana_list_projects', {});
    assert.match(hint, /Kein ASANA_PAT/);
    db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('ASANA_PAT','pat-token',0)").run();
    // Projekte listen
    const list = await runTool({ villaId: 1, agentId: 1 }, 'asana_list_projects', { limit: 10 });
    assert.match(list, /CSC-Produkt \(gid 120001\)/);
    // Aufgabe mit Projekt-GID
    const withGid = await runTool({ villaId: 1, agentId: 1 }, 'asana_create_task', { name: 'Sprint 9 verifizieren', notes: 'Alle Tests gruen', project_gid: '120001' });
    assert.match(withGid, /gid 9001/);
    const withBody = JSON.parse(calls.find((c) => c.init?.method === 'POST').init.body).data;
    assert.deepEqual(withBody.projects, ['120001']);
    // Aufgabe ohne GID -> erster Workspace
    calls.length = 0;
    const noGid = await runTool({ villaId: 1, agentId: 1 }, 'asana_create_task', { name: 'Backlog pflegen', notes: 'x' });
    assert.match(noGid, /gid 9001/);
    const noBody = JSON.parse(calls.find((c) => c.init?.method === 'POST').init.body).data;
    assert.equal(noBody.workspace, '777');
  } finally { globalThis.fetch = orig; }
});

test('Extern-Pack schaltet alle drei Werkzeuge gemeinsam', () => {
  setPackEnabled('extern', false);
  for (const t of ['fireflies_transcripts', 'asana_list_projects', 'asana_create_task']) {
    assert.equal(canUseTool(t).allowed, false);
  }
  setPackEnabled('extern', true);
  for (const t of ['fireflies_transcripts', 'asana_list_projects', 'asana_create_task']) {
    assert.equal(canUseTool(t).allowed, true);
  }
});
