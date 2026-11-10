/**
 * Villa-Audit-Befund 2026-11-10: Villen standen auf COMPLETED, waehrend
 * weiterhin 3, 77 bzw. 88 Aufgaben offen waren. Der Abschlussstatus muss
 * ehrlich sein, sonst meldet jede Abnahme Erfolg ohne Substanz.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-completion-')), 'test.db');
const { db, now } = await import('../db.mjs');
const { reconcileCompletionStates } = await import('../completion-state.mjs');
const { assessVillaConfiguration } = await import('../villa-configuration.mjs');
const { enqueueVillas } = await import('../scheduler.mjs');

function addVilla(status, autonomy = 1) {
  const t = now();
  return Number(db.prepare('INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(`Villa ${status} ${Math.random().toString(36).slice(2, 7)}`, 'Idee mit Nutzerfluss', status, 1000, autonomy, t, t).lastInsertRowid);
}
function addTask(villaId, status) {
  const t = now();
  db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(villaId, `Aufgabe ${status}`, 'Detail', status, 5, t, t);
}

test('COMPLETED mit offener Aufgabe wird ehrlich auf PAUSED zurueckgesetzt', () => {
  const villaId = addVilla('COMPLETED');
  addTask(villaId, 'DONE');
  addTask(villaId, 'PENDING');
  addTask(villaId, 'RUNNING');

  const { reopened } = reconcileCompletionStates();
  assert.deepEqual(reopened.find((r) => r.villaId === villaId), { villaId, openTasks: 2 });
  const villa = db.prepare('SELECT status, autonomy FROM villas WHERE id=?').get(villaId);
  assert.equal(villa.status, 'PAUSED');
  assert.equal(villa.autonomy, 1, 'Autonomie des Besitzers bleibt unveraendert');
});

test('COMPLETED ohne offene Aufgaben bleibt COMPLETED, fremde Status bleiben unberuehrt', () => {
  const fertig = addVilla('COMPLETED');
  addTask(fertig, 'DONE');
  addTask(fertig, 'CANCELLED');
  const laufend = addVilla('RUNNING');
  addTask(laufend, 'PENDING');

  const { reopened } = reconcileCompletionStates();
  assert.ok(!reopened.some((r) => r.villaId === fertig), 'fertige Villa bleibt fertig');
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(fertig).status, 'COMPLETED');
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(laufend).status, 'RUNNING', 'laufende Villa wird nicht angefasst');
});

test('Abstimmung ist idempotent', () => {
  const villaId = addVilla('COMPLETED');
  addTask(villaId, 'READY');
  reconcileCompletionStates();
  const second = reconcileCompletionStates();
  assert.ok(!second.reopened.some((r) => r.villaId === villaId), 'zweiter Lauf aendert nichts mehr');
});

test('Scheduler-Startentscheidung stimmt den Abschluss mit ab (Verdrahtung)', () => {
  const villaId = addVilla('COMPLETED');
  addTask(villaId, 'PENDING');
  enqueueVillas([]);
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(villaId).status, 'PAUSED', 'pump() korrigiert den Status');
});

test('Audit-Befund completion_consistency verschwindet nach der Abstimmung', () => {
  const villaId = addVilla('COMPLETED');
  addTask(villaId, 'DONE');
  addTask(villaId, 'PENDING');
  const villa = db.prepare('SELECT * FROM villas WHERE id=?').get(villaId);
  const before = assessVillaConfiguration({
    villa,
    agents: [],
    taskCounts: { DONE: 1, PENDING: 1 },
    tools: [],
    product: { verified: true },
    missionAvailable: false
  });
  assert.equal(before.checks.find((c) => c.code === 'completion_consistency')?.status, 'blocked');

  reconcileCompletionStates();

  const after = assessVillaConfiguration({
    villa: db.prepare('SELECT * FROM villas WHERE id=?').get(villaId),
    agents: [],
    taskCounts: { DONE: 1, PENDING: 1 },
    tools: [],
    product: { verified: true },
    missionAvailable: false
  });
  assert.equal(after.checks.find((c) => c.code === 'completion_consistency'), undefined, 'kein Widerspruch mehr');
});
