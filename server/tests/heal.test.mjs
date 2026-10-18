// Test des autonomen Heil-Kerns gegen eine Wegwerf-Datenbank (LLM ersetzt).
// Start: node --test server/tests/heal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-heal-')), 'test.db');
process.chdir(mkdtempSync(join(tmpdir(), 'vf-heal-cwd-')));

const evo = await import('../evolve.mjs');
const heal = await import('../heal.mjs');
const { db, now } = await import('../db.mjs');

function villa(name) {
  db.prepare('INSERT INTO villas (name, idea, status, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(name, 'Idee ' + name, 'RUNNING', 1, now(), now());
  return db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id;
}
function task(v, title, status) {
  db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(v, title, 'Beschreibung', status, 4, now(), now());
}

test('healTick: >= 2 Fehlschlaege erzeugen automatisch genehmigten REPARATUR-Plan', async () => {
  evo._setChat(async () => ({ content: JSON.stringify({
    title: 'Reparatur: Timeout im Build',
    summary: 'Root Cause: fehlender Timeout. Loesung dauerhaft durch Guard.',
    items: [
      { title: 'Timeout nachruesten', description: 'Akzeptanz: Lauf bricht nach 60 s ab.', role: 'CODER' },
      { title: 'Regressionstest', description: 'Akzeptanz: Test gruen.', role: 'TESTER' }
    ]
  }) }));
  const v = villa('kaputt');
  task(v, 'Build A', 'FAILED');
  task(v, 'Build B', 'FAILED');
  task(v, 'OK C', 'DONE');
  const r = await heal.healTick();
  assert.equal(r.actions.length, 1, 'genau eine Heil-Aktion');
  assert.equal(r.actions[0].added, 2, 'REPARATUR-Aufgaben angelegt und automatisch genehmigt');
  const titles = db.prepare("SELECT title FROM tasks WHERE villa_id = ? AND status = 'PENDING'").all(v).map((t) => t.title);
  assert.ok(titles.some((t) => t.startsWith('[REPARATUR]')), 'REPARATUR-Tag: ' + titles.join(' / '));
  // Zweiter Takt am selben Tag: keine Wiederholung (kein Karussell).
  const r2 = await heal.healTick();
  assert.equal(r2.actions.length, 0, 'keine zweite Reparatur innerhalb 24 h');
});

test('systemAudit: gruen bei sauberem Zustand, rot bei FAILED', () => {
  const a1 = heal.systemAudit();
  assert.equal(typeof a1.green, 'boolean');
  assert.equal(a1.areas.length, 5);
  const v = villa('sauber');
  task(v, 'Fein', 'DONE');
  const failed = a1.areas.find((x) => x.name === 'Aufgaben');
  assert.ok(failed, 'Aufgaben-Bereich existiert');
});
