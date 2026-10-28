import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import {
  initDlq, isolateFailedWorkflow, ingestFailedEvent, restartFailedWorkflow,
  dlqTick, dlqStatus, MAX_ATTEMPTS,
} from '../event-dlq.mjs';

initDlq();

function freshTask(status = 'FAILED', retry = 3, villa = 902) {
  const t = Date.now();
  const info = db.prepare(`INSERT INTO tasks (villa_id, agent_id, title, description, status, priority, result, created_at, updated_at)
    VALUES (?,?,?,?,?,5,?,?,?)`).run(villa, 1, 'DLQ-Testaufgabe', 'x', status, 'Testfehler', t, t);
  const id = Number(info.lastInsertRowid);
  try { db.prepare('UPDATE tasks SET retry_count = ? WHERE id = ?').run(retry, id); } catch { /* Spalte optional */ }
  return id;
}

test('isolateFailedWorkflow legt genau einen offenen Eintrag je Task+Code an', () => {
  const taskId = freshTask();
  const first = isolateFailedWorkflow({ villaId: 902, taskId, code: 'E_BOOM', message: 'kaputt' });
  assert.equal(first.ok, true);
  const second = isolateFailedWorkflow({ villaId: 902, taskId, code: 'E_BOOM', message: 'wieder kaputt' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, 'zweiter Fehlschlag erhoeht nur den Zaehler');
  assert.equal(second.id, first.id);
  const row = db.prepare('SELECT attempts FROM event_dlq WHERE id = ?').get(first.id);
  assert.equal(row.attempts, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_dlq WHERE task_id = ? AND code = ?').get(taskId, 'E_BOOM').n, 1);
});

test('ingestFailedEvent isoliert nur echte Fehlschlaege', () => {
  const taskId = freshTask();
  assert.equal(ingestFailedEvent({ id: 'ev1', type: 'agent.step.started', villaId: 902, taskId }).skipped, true);
  assert.equal(ingestFailedEvent({ id: 'ev2', type: 'llm.completed', provider: 'groq' }).skipped, true);
  const hit = ingestFailedEvent({ id: 'ev3', type: 'agent.failed', villaId: 902, taskId, code: 'AGENT_CRASH' });
  assert.equal(hit.ok, true);
  assert.ok(hit.id > 0);
});

test('ingestFailedEvent erkennt task.updated mit Status FAILED', () => {
  const taskId = freshTask();
  const hit = ingestFailedEvent({ id: 'ev4', type: 'task.updated', villaId: 902, taskId, status: 'FAILED', code: 'X' });
  assert.equal(hit.ok, true);
  assert.ok(hit.id > 0);
});

test('restartFailedWorkflow reiht Task wieder ein und schliesst den Eintrag', () => {
  const taskId = freshTask('FAILED', 3);
  const created = isolateFailedWorkflow({ villaId: 902, taskId, code: 'E_RESTART', message: 'x' });
  const out = restartFailedWorkflow(created.id);
  assert.equal(out.ok, true);
  assert.equal(out.taskRequeued, true);
  const task = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.status, 'PENDING');
  assert.equal(task.retry_count, 4);
  const entry = db.prepare('SELECT status FROM event_dlq WHERE id = ?').get(created.id);
  assert.equal(entry.status, 'REQUEUED');
  assert.equal(restartFailedWorkflow(created.id).ok, false, 'zweiter Requeue ist nicht erlaubt');
});

test('dlqTick isoliert erschoepfte Tasks und reiht sie automatisch neu ein', () => {
  const before = dlqStatus({ limit: 1 });
  const taskId = freshTask('FAILED', 3, 903);
  const tick = dlqTick({ limit: 20, autoRestart: true });
  assert.equal(tick.ok, true);
  assert.ok(tick.isolated >= 1, 'erschoepfter Task muss isoliert werden');
  const entry = db.prepare("SELECT status FROM event_dlq WHERE task_id = ? AND code = 'TASK_RETRY_EXHAUSTED'").get(taskId);
  assert.ok(['OPEN', 'REQUEUED'].includes(entry.status), 'Task muss im DLQ landen');
  assert.ok(dlqStatus({ limit: 1 }).byStatus.OPEN >= 0);
});

test('dlqTick eskaliert nach MAX_ATTEMPTS statt endlos zu wiederholen', () => {
  const taskId = freshTask('FAILED', 9, 904);
  const created = isolateFailedWorkflow({ villaId: 904, taskId, code: 'E_HARD', message: 'hartnaeckig' });
  db.prepare('UPDATE event_dlq SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, created.id);
  const tick = dlqTick({ limit: 50, autoRestart: true });
  assert.equal(tick.ok, true);
  const entry = db.prepare('SELECT status FROM event_dlq WHERE id = ?').get(created.id);
  assert.equal(entry.status, 'ESCALATED');
  const alert = db.prepare('SELECT severity FROM event_alerts WHERE dlq_id = ?').get(created.id);
  assert.ok(alert, 'Eskalation muss einen Alert erzeugen');
  assert.equal(alert.severity, 'critical');
  assert.ok(dlqStatus({ limit: 5 }).escalated >= 1);
});

test('Modul wirft nie: defekte Eingaben liefern Fehlerobjekte', () => {
  assert.equal(isolateFailedWorkflow({}).ok, true, 'leerer Aufruf bleibt erlaubt (Sammelplatz)');
  assert.equal(restartFailedWorkflow(999999).ok, false);
  assert.equal(ingestFailedEvent(null).ok, false);
  assert.equal(typeof dlqStatus().byStatus, 'object');
});
