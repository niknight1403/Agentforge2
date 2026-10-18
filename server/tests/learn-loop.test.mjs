/**
 * Sprint 7 (v1.38.0) — Selbst-Lern-Loop.
 *
 * Fehlschlaege und Qualitaetstor-Risse werden als LESSON-Erinnerung
 * (Wichtigkeit 7) im Villa-Gedaechtnis verewigt. Da memoryContext() die
 * wichtigsten Erinnerungen in jeden Agenten-Prompt spielt, lernt das
 * gesamte Team aus jedem Fehler — ohne zusaetzliche LLM-Kosten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lern-'));
process.env.VF_DB = join(tmp, 'test.db');
process.env.VF_WORKSPACE = join(tmp, 'ws');

const { db, now } = await import('../db.mjs');
const { recordLesson, memoryContext } = await import('../agents.mjs');

const t = now();
db.prepare("INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES ('Lern-Villa','x','CREATED',10,1,?,?)").run(t, t);
const villaId = Number(db.prepare('SELECT id FROM villas ORDER BY id DESC LIMIT 1').get().id);

test('recordLesson schreibt eine LESSON-Erinnerung mit Wichtigkeit 7', () => {
  recordLesson(villaId, 1, 'Lehre: Login bauen', 'npm test scheiterte: Token-Expiry nicht behandelt.');
  const m = db.prepare("SELECT * FROM memories WHERE kind = 'LESSON'").get();
  assert.ok(m, 'LESSON fehlt');
  assert.equal(m.importance, 7);
  assert.equal(m.villa_id, villaId);
  assert.equal(m.scope, 'villa');
  assert.match(m.content, /Token-Expiry/);
});

test('Lehren fliessen in den Kontext der Agenten (memoryContext)', () => {
  const ctx = memoryContext(villaId, 1);
  assert.match(ctx, /Token-Expiry/, 'Lehre muss im Prompt-Kontext auftauchen');
});

test('executeTask nutzt den Lern-Loop an beiden Fehlerstellen', () => {
  const src = readFileSync(new URL('../agents.mjs', import.meta.url), 'utf8');
  const gate = src.indexOf('Lehre: ${task.title}`, `npm test');
  const fail = src.indexOf('Lehre: ${task.title}`, `Aufgabe schlug fehl');
  assert.ok(gate > 0, 'Q-GATE-Riss schreibt eine Lehre');
  assert.ok(fail > 0, 'fehlgeschlagener Lauf schreibt eine Lehre');
  assert.ok(src.includes('export function recordLesson'), 'Helper exportiert');
});
