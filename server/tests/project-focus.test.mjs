// Projekt-Fokus: erst die priorisierten Villen fertigstellen, andere warten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-focus-')), 'test.db');
process.env.VF_VILLA_SLOTS = '3';
const { db, now } = await import('../db.mjs');
const focus = await import('../project-focus.mjs');
const sched = await import('../scheduler.mjs');

function villa(name, status = 'RUNNING', open = 3, done = 1) {
  const t = now();
  const id = Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(name, 'i', status, t, t).lastInsertRowid);
  const add = (st, n) => { for (let i = 0; i < n; i++) db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 't', 'd', st, 5, t, t); };
  add('DONE', done); add('PENDING', open);
  return id;
}

// Der Scheduler bekommt einen Stub als Starter: kein echter Lauf im Test.
function reset() {
  focus.clearVillaFocus({ reason: 'test' });
  sched._resetScheduler();
  sched.configureScheduler({ start: async () => {} });
}

test('ohne Fokus darf jede Villa starten', () => {
  reset();
  const id = villa('Frei');
  assert.equal(focus.focusActive(), false);
  assert.equal(focus.focusDecision(id).allowed, true);
  assert.equal(focus.focusStatus().active, false);
});

test('Fokus steht: nur die Fokus-Villen duerfen starten', () => {
  reset();
  const a = villa('Projekt A');
  const b = villa('Projekt B');
  const other = villa('Nebenprojekt');
  focus.setVillaFocus([a, b], { reason: 'Nikos zwei Projekte zuerst' });
  assert.equal(focus.focusActive(), true);
  assert.equal(focus.focusDecision(a).allowed, true);
  assert.equal(focus.focusDecision(b).allowed, true);
  const denied = focus.focusDecision(other);
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'FOCUS_ACTIVE');
  assert.match(denied.message, new RegExp('#' + a));
});

test('Fokus blockiert den Start im Scheduler mit Grund statt still', () => {
  reset();
  const a = villa('Projekt A');
  const other = villa('Nebenprojekt');
  focus.setVillaFocus([a]);
  const refused = sched.scheduleVilla(other, { runToCompletion: true });
  assert.equal(refused.refused, other);
  assert.equal(refused.refusedCode, 'FOCUS_ACTIVE');
  assert.ok(!refused.queue.includes(other), 'abgelehnte Villa landet nicht in der Warteschlange');
  assert.match(String(refused.refusedMessage), /Projekt-Fokus aktiv/);
});

test('Fokus-Villa wird normal angenommen', () => {
  reset();
  const a = villa('Projekt A');
  focus.setVillaFocus([a]);
  const status = sched.scheduleVilla(a, { runToCompletion: true });
  assert.equal(status.refused, undefined);
  assert.ok(status.active.includes(a) || status.queue.includes(a));
});

test('Status zeigt Fortschritt je Fokus-Villa', () => {
  reset();
  const a = villa('Projekt A', 'RUNNING', 4, 1);
  const b = villa('Projekt B', 'RUNNING', 2, 7);
  const status = focus.setVillaFocus([a, b], { reason: 'Auftrag' });
  assert.equal(status.open, 6);
  assert.equal(status.villas.length, 2);
  assert.equal(status.villas[0].open, 4);
  assert.equal(status.villas[1].open, 2);
  assert.equal(status.ready_to_release, false);
  assert.equal(status.reason, 'Auftrag');
  assert.ok(status.since > 0);
});

test('Fokus loest sich auf, sobald alle Fokus-Villen fertig sind', () => {
  reset();
  const a = villa('Projekt A', 'COMPLETED', 0, 9);
  const b = villa('Projekt B', 'COMPLETED', 0, 4);
  focus.setVillaFocus([a, b]);
  assert.equal(focus.focusStatus().ready_to_release, true);
  const released = focus.releaseFocusIfComplete();
  assert.equal(released.active, false);
  assert.equal(focus.focusActive(), false);
  const other = villa('Nebenprojekt');
  assert.equal(focus.focusDecision(other).allowed, true);
});

test('Eine offene Aufgabe haelt den Fokus', () => {
  reset();
  const a = villa('Projekt A', 'COMPLETED', 0, 5);
  const b = villa('Projekt B', 'RUNNING', 1, 5);
  focus.setVillaFocus([a, b]);
  const released = focus.releaseFocusIfComplete();
  assert.equal(released.active, true);
  assert.equal(released.ready_to_release, false);
});

test('Fokus auf unbekannte Villa wird abgelehnt', () => {
  reset();
  assert.throws(() => focus.setVillaFocus([999999]), /Unbekannte Villa/);
  assert.equal(focus.focusActive(), false);
});

test('Doppelte und ungueltige IDs werden bereinigt', () => {
  reset();
  const a = villa('Projekt A');
  const status = focus.setVillaFocus([a, a, 0, -3, '7x']);
  assert.deepEqual(status.villaIds, [a]);
});

test('Verlauf belegt Setzen und Aufheben', () => {
  reset();
  const a = villa('Projekt A');
  focus.setVillaFocus([a], { reason: 'erst A' });
  focus.clearVillaFocus({ reason: 'fertig' });
  const history = focus.focusHistory(5);
  assert.equal(history[0].action, 'clear');
  assert.equal(history[0].reason, 'fertig');
  assert.equal(history[1].action, 'set');
  assert.deepEqual(JSON.parse(history[1].villa_ids), [a]);
});

test('Scheduler-Status nennt den Projekt-Fokus', () => {
  reset();
  const a = villa('Projekt A');
  focus.setVillaFocus([a]);
  assert.deepEqual(sched.schedulerStatus().projectFocus, [a]);
  focus.clearVillaFocus();
  assert.deepEqual(sched.schedulerStatus().projectFocus, []);
});
