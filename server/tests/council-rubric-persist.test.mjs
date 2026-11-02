import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'rat-rubrik-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { runCouncil, listCouncil } = await import('../council.mjs');
const { insertAgent } = await import('../agents.mjs');

function seedVilla(name) {
  const t = now();
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?, 'Eine Idee mit genug Laenge fuer den Rat der Agenten','CREATED',100,1,?,?)").run(name, t, t);
  return Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
}

const agentReply = (name, text) => ({ answer: `ERKENNTNIS: Lehre von ${name}.\nVORSCHLAG: ${text}` });

function chatWith(rubricReply) {
  return async (msgs) => {
    const sys = msgs[0].content;
    if (sys.includes('Bewertungs-Synthese')) return { content: rubricReply };
    const who = sys.includes('Arbeiter-1') ? 'Arbeiter-1' : 'Arbeiter-2';
    const text = who === 'Arbeiter-1'
      ? 'Kennzahlen-Dashboard mit Beleg aus echten Buchungen bauen'
      : 'Oberflaeche saisonal umfaerben';
    return agentReply(who, text);
  };
}

function seed(name) {
  const villaId = seedVilla(name);
  insertAgent(villaId, 'Arbeiter-1', 'CODER');
  insertAgent(villaId, 'Arbeiter-2', 'WORKER');
  return villaId;
}

test('Rat speichert Rubrik-Bewertungen und Minderheitenvoten dauerhaft', async () => {
  const villaId = seed('Rubrik-Villa');
  const rubric = JSON.stringify({ ranked: [
    { agent: 'Arbeiter-1', impact: 9, effort: 2, nutzen: 5, machbarkeit: 4, belegbarkeit: 5, differenzierung: 4 },
    { agent: 'Arbeiter-2', impact: 3, effort: 5, nutzen: 2, machbarkeit: 4, belegbarkeit: 1, differenzierung: 2 },
  ] });
  const result = await runCouncil(villaId, { participants: 2, chatFn: chatWith(rubric) });

  assert.equal(result.rating.rated, true);
  assert.equal(result.ranked[0].agent, 'Arbeiter-1');
  assert.equal(result.ranked[0].rated, true);
  assert.equal(result.dissent.length, 1);
  assert.equal(result.dissent[0].agent, 'Arbeiter-2');
  assert.equal(result.dissent[0].weakestDimension, 'belegbarkeit');

  const stored = listCouncil(villaId, 1)[0];
  assert.equal(stored.scores.rated, true);
  assert.equal(stored.scores.entries.length, 2);
  assert.equal(stored.dissent[0].agent, 'Arbeiter-2');
  const row = db.prepare('SELECT scores, dissent FROM council WHERE id = ?').get(stored.id);
  assert.match(row.scores, /belegbarkeit/);
  assert.match(row.dissent, /Arbeiter-2/);
});

test('Ohne auswertbare Bewertung werden keine erfundenen Werte gespeichert', async () => {
  const villaId = seed('Unbewertete Villa');
  const result = await runCouncil(villaId, { participants: 2, chatFn: chatWith('Das Modell antwortet frei statt JSON.') });

  assert.equal(result.rating.rated, false);
  assert.equal(result.ranked.every((r) => r.rated === false), true);
  assert.equal(result.ranked.every((r) => r.score === null), true);
  assert.equal(result.dissent.length >= 1, true);
  assert.match(result.dissent[0].reason, /nicht bewertet/);

  const stored = listCouncil(villaId, 1)[0];
  assert.equal(stored.scores.rated, false);
  assert.match(String(stored.scores.reason), /kein gueltiges JSON|nicht auswertbar/);
  assert.equal(stored.proposals.every((p) => p.impact === null && p.score === null), true);
});

test('Die Runde liefert trotzdem einen Vorschlag als Aufgabe, damit die Villa nicht stillsteht', async () => {
  const villaId = seed('Stillstand-Villa');
  const result = await runCouncil(villaId, { participants: 2, chatFn: chatWith('kein json') });
  assert.equal(result.proposals, 2);
  assert.equal(result.tasksCreated >= 1, true);
});
