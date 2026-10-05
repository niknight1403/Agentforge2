/**
 * Tests fuer Auto-Resume nach Kontingent-Erschoepfung (Sprint 65).
 *
 * Szenario: ein Lauf endet PAUSED, weil ALLE echten Routen nur mit 429
 * geantwortet haben (Tageslimit leer, Schluessel aber gueltig). Der Hub
 * merkt sich das am Task (quota_blocked) und an der Villa (auto_retry_at)
 * und nimmt den Lauf spaeter VON SELBST wieder auf.
 */
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { createVilla, isQuotaOnlyFailure, AUTO_RETRY_MS } from '../agents.mjs';
import { autoResumeQuotaVillas } from '../maintenance.mjs';

seedRoutes();

async function makePausedVilla() {
  const v = await createVilla({ name: 'Quota-Test', idea: 'Eine Testvilla', agentCount: 2 });
  db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now(), v.villaId);
  return v.villaId;
}

function addTask(villaId, { status = 'FAILED', quotaBlocked = 1 } = {}) {
  const agent = db.prepare('SELECT id FROM agents WHERE villa_id = ? LIMIT 1').get(villaId);
  db.prepare('INSERT INTO tasks (villa_id, agent_id, title, description, status, quota_blocked, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(villaId, agent.id, 'Testaufgabe', 'Beschreibung', status, quotaBlocked, now(), now());
  return db.prepare('SELECT id FROM tasks WHERE villa_id = ? ORDER BY id DESC LIMIT 1').get(villaId).id;
}

test('isQuotaOnlyFailure: reine 429-Warnung ist Kontingent, 401 nicht', () => {
  assert.equal(isQuotaOnlyFailure({ offline: true, warning: 'Route fehlgeschlagen: HTTP 429 Rate limit reached' }), true);
  assert.equal(isQuotaOnlyFailure({ offline: true, warning: 'HTTP 429 Tageslimit leer' }), true);
  // Ungueltiger Schluessel ist KEIN Kontingentfall — nicht automatisch neu starten.
  assert.equal(isQuotaOnlyFailure({ offline: true, warning: 'HTTP 401 Missing Authentication header' }), false);
  assert.equal(isQuotaOnlyFailure({ offline: true, warning: 'HTTP 403 forbidden' }), false);
  // Hartfehler und bewusst offline gehen nicht in den Auto-Resume.
  assert.equal(isQuotaOnlyFailure({ offline: true, error: 'Boom' }), false);
  assert.equal(isQuotaOnlyFailure({ offline: true, intentional: true, warning: 'HTTP 429' }), false);
  assert.equal(isQuotaOnlyFailure({ warning: 'HTTP 429' }), false);
  assert.equal(isQuotaOnlyFailure(null), false);
});

test('AUTO_RETRY_MS: Wartezeit ist eine Stunde', () => {
  assert.equal(AUTO_RETRY_MS, 60 * 60_000);
});

test('autoResumeQuotaVillas: faellige Villa wird automatisch fortgesetzt', async () => {
  const villaId = await makePausedVilla();
  const taskId = addTask(villaId);
  db.prepare('UPDATE villas SET auto_retry_at = ? WHERE id = ?').run(now() - 1000, villaId);

  let started = null;
  const out = autoResumeQuotaVillas({
    orchestrate: (id, opts) => { started = { id, opts }; return Promise.resolve(); },
    isRunning: () => false,
  });

  assert.deepEqual(out.resumed, [villaId], 'Villa wurde fortgesetzt');
  assert.equal(started?.id, villaId, 'Orchestrierung angestossen');
  assert.equal(started?.opts.adaptive, true, 'adaptiver Lauf');
  const task = db.prepare('SELECT status, quota_blocked FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.status, 'PENDING', 'Aufgabe zurueck in die Warteschlange');
  assert.equal(task.quota_blocked, 0, 'Flag beim Requeue gecleart');
  const villa = db.prepare('SELECT auto_retry_at FROM villas WHERE id = ?').get(villaId);
  assert.equal(villa.auto_retry_at, 0, 'Timer zurueckgesetzt');
  const audit = db.prepare("SELECT COUNT(*) c FROM audit WHERE villa_id = ? AND tool = 'auto_resume'").get(villaId).c;
  assert.equal(audit, 1, 'Audit-Eintrag auto_resume geschrieben');
});

test('autoResumeQuotaVillas: noch nicht faellige Villa bleibt liegen', async () => {
  const villaId = await makePausedVilla();
  addTask(villaId);
  db.prepare('UPDATE villas SET auto_retry_at = ? WHERE id = ?').run(now() + 600_000, villaId);
  const out = autoResumeQuotaVillas({ orchestrate: () => Promise.resolve(), isRunning: () => false });
  assert.deepEqual(out.resumed, [], 'nichts fortgesetzt');
  assert.equal(out.checked, 0, 'nicht faellig, nicht mal geprueft');
});

test('autoResumeQuotaVillas: laufende Villa wird uebersprungen', async () => {
  const villaId = await makePausedVilla();
  const taskId = addTask(villaId);
  db.prepare('UPDATE villas SET auto_retry_at = ? WHERE id = ?').run(now() - 1000, villaId);
  const out = autoResumeQuotaVillas({ orchestrate: () => Promise.resolve(), isRunning: () => true });
  assert.deepEqual(out.skipped, [villaId], 'laufende Villa uebersprungen');
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.status, 'FAILED', 'Aufgabe unberuehrt');
  // Timer wieder aufraeumen, damit der fällige Eintrag nicht in den
  // naechsten Test hineinwaechst.
  db.prepare('UPDATE villas SET auto_retry_at = 0 WHERE id = ?').run(villaId);
});

test('autoResumeQuotaVillas: normale FAILED-Aufgaben werden NICHT angefasst', async () => {
  const villaId = await makePausedVilla();
  const taskId = addTask(villaId, { quotaBlocked: 0 }); // echter inhaltlicher Fehlschlag
  db.prepare('UPDATE villas SET auto_retry_at = ? WHERE id = ?').run(now() - 1000, villaId);
  const out = autoResumeQuotaVillas({ orchestrate: () => Promise.resolve(), isRunning: () => false });
  assert.deepEqual(out.cleared, [villaId], 'Timer aufgegriffen und gecleart');
  assert.deepEqual(out.resumed, [], 'kein Auto-Start bei echten Fehlern');
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.status, 'FAILED', 'echte FAILED-Aufgabe bleibt FAILED');
});

test('autoResumeQuotaVillas: gemischte Fehler starten nur die Kontingent-Aufgaben', async () => {
  const villaId = await makePausedVilla();
  const quotaTask = addTask(villaId, { quotaBlocked: 1 });
  const realTask = addTask(villaId, { quotaBlocked: 0 });
  db.prepare('UPDATE villas SET auto_retry_at = ? WHERE id = ?').run(now() - 1000, villaId);
  const out = autoResumeQuotaVillas({ orchestrate: () => Promise.resolve(), isRunning: () => false });
  assert.deepEqual(out.resumed, [villaId]);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(quotaTask).status, 'PENDING');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(realTask).status, 'FAILED');
});
