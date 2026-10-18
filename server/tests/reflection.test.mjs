/**
 * Sprint 4 (v1.35.0) — Reflexions-Loop.
 *
 * Nach jeder echten Modell-Antwort prueft der Agent seine eigene Antwort
 * in einem zweiten kurzen Lauf gegen die Aufgabe und liefert die verbesserte
 * Fassung. Offline-Antworten, Fehler und abgeschaltete Packs fallen sanft
 * auf die Original-Antwort zurueck.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'refl-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { runAgent, insertAgent } = await import('../agents.mjs');
const { setPackEnabled } = await import('../packs.mjs');

const t = now();
db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('R-Villa','Reflexion','CREATED',100,1,?,?)").run(t, t);
const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
const agentId = insertAgent(villaId, 'Coder-001', 'CODER');
const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);

// FAL-aehnliche Route mit Mock-Fetch: jede Runde liefert die naechste Antwort.
db.prepare("INSERT INTO secrets (name, value, updated_at) VALUES ('REFL_KEY','k',0)").run();
db.prepare(
  "INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,1,1,10,1,'NEW',0,0,0)"
).run('Mock-Route', 'fal', 'https://mock.local/v1', 'mock-model', 'REFL_KEY');

function mockChat(responses) {
  const orig = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const content = JSON.stringify(responses[Math.min(i++, responses.length - 1)]);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], model: 'mock-model' }), { status: 200 });
  };
  return () => { globalThis.fetch = orig; return i; };
}

test('Reflexion verbessert eine schwache Antwort (IMPROVE -> bessere Fassung)', async () => {
  const restore = mockChat([
    { final: 'Erste duenne Antwort.' },
    { verdict: 'IMPROVE', final: 'Vollstaendige, konkrete und gepruefte Antwort mit allen Punkten.' }
  ]);
  try {
    const out = await runAgent(agent, 'Baue einen Login.', { villaId });
    assert.equal(out.reflection, 'improved');
    assert.match(out.answer, /Vollstaendige/);
    assert.ok(out.trace.some((e) => e.reflection === 'improved'));
    assert.equal(restore(), 2, 'zwei Modellaufufe: Antwort + Reflexion');
  } finally { restore(); }
});

test('Reflexion bestaetigt eine gute Antwort (OK -> Original bleibt)', async () => {
  const restore = mockChat([
    { final: 'Sauber durchgearbeitete Loesung mit allen Akzeptanzkriterien.' },
    { verdict: 'OK', final: 'Sauber durchgearbeitete Loesung mit allen Akzeptanzkriterien.' }
  ]);
  try {
    const out = await runAgent(agent, 'Baue einen Login.', { villaId });
    assert.equal(out.reflection, 'ok');
    assert.match(out.answer, /Sauber durchgearbeitete/);
  } finally { restore(); }
});

test('Reflexions-Pack aus: nur ein Modellauf, keine Selbstkritik', async () => {
  setPackEnabled('reflexion', false);
  const restore = mockChat([{ final: 'Antwort ohne Spiegel.' }]);
  try {
    const out = await runAgent(agent, 'Baue einen Login.', { villaId });
    assert.equal(restore(), 1, 'kein zweiter Lauf');
    assert.notEqual(out.reflection, 'improved');
  } finally {
    restore();
    setPackEnabled('reflexion', true);
  }
});

test('Defektes Reflexions-JSON faellt sanft auf die Original-Antwort zurueck', async () => {
  const orig = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    i++;
    if (i === 1) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ final: 'Solide Original-Antwort.' }) } }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'kein json, gar nichts' } }] }), { status: 200 });
  };
  try {
    const out = await runAgent(agent, 'Baue einen Login.', { villaId });
    assert.match(out.answer, /Solide Original-Antwort/);
    assert.ok(out.trace.some((e) => e.reflection === 'skipped' || e.final === true));
  } finally { globalThis.fetch = orig; }
});
