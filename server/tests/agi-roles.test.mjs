/**
 * Sprint 3 (v1.34.0) — AGI-Agenten-Quintett.
 *
 * Fuenf spezialisierte Denker rolls ergaenzen die Villa:
 * STRATEGIST (Szenarien/Entscheidungen), REASONER (Kausalitaet/Tiefe),
 * SYNTHESIZER (Querschnitt-Veredelung), OPTIMIZER (Engpass-Hebel),
 * VERIFIER (Behauptungs-Pruefung). Sie werden beim Anlegen neuer Villen
 * verteilt, von guessRole automatisch erkannt und beim Start per
 * PROMPT_VERSION-Migration in bestehende Villen nachgezogen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'agi-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { ROLES, buildSystemPrompt, PROMPT_VERSION, refreshAgentPrompts, insertAgent, createVilla, legacySystemPrompt } = await import('../agents.mjs');
(await import('../agents.mjs'))._setPlanningChat(async()=>({content:JSON.stringify({summary:'Test plan',tasks:[{title:'Test-App implementieren',description:'Akzeptanz: Tests laufen',role:'CODER'}]})}));
const { db, now } = await import('../db.mjs');

const QUINTETT = ['STRATEGIST', 'REASONER', 'SYNTHESIZER', 'OPTIMIZER', 'VERIFIER'];

test('AGI-Quintett und Profi-Rolle sind Teil des Rollen-Katalogs (18 Rollen gesamt)', () => {
  assert.equal(ROLES.length, 18);
  assert.ok(ROLES.includes('PROFI'), 'PROFI fehlt');
  for (const r of QUINTETT) assert.ok(ROLES.includes(r), `${r} fehlt`);
});

test('Jede AGI-Rolle hat einen scharfen Brief mit Auftrag und Pruefkriterium', () => {
  for (const r of QUINTETT) {
    const prompt = buildSystemPrompt(r);
    assert.ok(prompt.length > 200, `${r}-Brief zu duenn`);
    assert.match(prompt, /Rolle: /);
    assert.match(prompt, /Qualitaetsregeln/);
    assert.ok(prompt.includes('Bevorzugte Werkzeuge'), `${r} ohne Werkzeug-Empfehlung`);
  }
});

test('guessRole-Verhalten ueber insertAgent: AGI-Rollen sind anlegbar und suchbar', () => {
  const t = now();
  db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('AGI-Villa','Test','CREATED',100,1,?,?)").run(t, t);
  const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);
  for (const r of QUINTETT) {
    const id = insertAgent(villaId, `${r}-001`, r);
    const row = db.prepare('SELECT role, system_prompt FROM agents WHERE id = ?').get(id);
    assert.equal(row.role, r);
    assert.ok(row.system_prompt.includes(r), 'Prompt nennt die Rolle');
  }
});

test('PROMPT_VERSION erhoeht: Migration frischt veraltete Prompts auf (idempotent)', () => {
  assert.ok(PROMPT_VERSION >= 3);
  // Zwei Agenten mit absichtlich veraltetem Prompt simulieren den Live-Bestand.
  for(const role of ['STRATEGIST','VERIFIER'])db.prepare('UPDATE agents SET system_prompt=? WHERE role=?').run(legacySystemPrompt(role),role);
  const first = refreshAgentPrompts();
  assert.ok(first >= 2, 'veraltete Prompts sollten aktualisiert werden');
  const strat = db.prepare("SELECT system_prompt FROM agents WHERE role = 'STRATEGIST' LIMIT 1").get();
  assert.ok(strat.system_prompt.includes('Szenarien'), 'STRATEGIST hat den neuen Brief');
  const second = refreshAgentPrompts();
  assert.equal(second, 0, 'zweite Migration darf nichts aendern');
});

test('Neue Villen bekommen AGI-Rollen in den Pool', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM agents').get().c;
  const v = await createVilla({ name: 'Quintett-Villa', idea: 'Eine Testidee', agentCount: 17 });
  const roles = db.prepare('SELECT role FROM agents WHERE villa_id = ?').all(v.villaId).map((r) => r.role);
  for (const r of QUINTETT) assert.ok(roles.includes(r), `${r} fehlt im neuen Pool`);
});
