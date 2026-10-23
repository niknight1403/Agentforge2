// Scheduler-Tests: weiteste Villa zuerst, Slot-Grenze, Nachruecken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-sched-')), 'test.db');
// Drei manuell gestartete Villen muessen parallel laufen koennen.
process.env.VF_VILLA_SLOTS = '3';
const { db, now } = await import('../db.mjs');
const { villaRanking, enqueueVillas, configureScheduler, schedulerStatus, cancelScheduledVilla, scheduleVilla, _resetScheduler } = await import('../scheduler.mjs');

function villa(name, done, open, failed = 0) {
  const t = now();
  const id = Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(name, 'i', 'RUNNING', t, t).lastInsertRowid);
  const add = (status, n) => { for (let i = 0; i < n; i++) db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 't', 'd', status, 5, t, t); };
  add('DONE', done); add('PENDING', open); add('FAILED', failed);
  return id;
}

test('Rangfolge: meister Fortschritt zuerst, Fehler kosten', () => {
  const low = villa('Anfang', 1, 9);
  const high = villa('Fast fertig', 9, 1);
  const clean = villa('Sauber', 5, 5, 0);
  const faulty = villa('Fehlerhaft', 5, 5, 4);
  const order = villaRanking().map((r) => r.id);
  assert.ok(order.indexOf(high) < order.indexOf(low), 'weiteste vorn');
  assert.ok(order.indexOf(clean) < order.indexOf(faulty), 'bei gleichem Fortschritt: Fehler zurueck');
});

test('Slot-Grenze: 3 gleichzeitig, weiteste zuerst, Rest rueckt nach', async () => {
  _resetScheduler();
  const a = villa('A', 1, 9);
  const b = villa('B', 9, 1);
  const c = villa('C', 5, 5);
  const d = villa('D', 8, 2);
  const started = [];
  let peak = 0, current = 0;
  const releases = new Map();
  configureScheduler({ start: (id) => new Promise((resolve) => {
    started.push(id); current += 1; peak = Math.max(peak, current);
    releases.set(id, () => { current -= 1; resolve(); });
  }) });
  enqueueVillas([a, b, c, d]);
  assert.deepEqual(started, [b, d, c], 'die drei weitesten starten');
  assert.equal(schedulerStatus().queued, 1);
  releases.get(b)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c, a], 'B fertig -> A rueckt nach');
  releases.get(d)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c, a], 'D fertig, kein weiterer Lauf wartet');
  releases.get(c)(); releases.get(a)();
  await new Promise((r) => setImmediate(r));
  assert.ok(peak <= 3, `Spitze ${peak} ueber Grenze`);
});

test('Einzelstopp entfernt nur die gewaehlte Villa aus der Warteschlange', () => {
  _resetScheduler();
  const a = villa('Aktiv A', 1, 2), b = villa('Aktiv B', 2, 1), c = villa('Aktiv C', 3, 1), queued = villa('Wartend', 0, 5);
  configureScheduler({ start: () => new Promise(() => {}) });
  enqueueVillas([a, b, c, queued]);
  assert.equal(schedulerStatus().active.length, 3);
  assert.deepEqual(schedulerStatus().queue, [queued]);
  assert.equal(cancelScheduledVilla(queued), true);
  assert.equal(cancelScheduledVilla(queued), false);
  assert.equal(schedulerStatus().queued, 0);
  _resetScheduler();
});

test('Doppeltes Einreihen startet nur einmal', async () => {
  _resetScheduler();
  const v = villa('Einmal', 3, 3);
  let calls = 0;
  configureScheduler({ start: () => { calls += 1; return new Promise(() => {}); } });
  enqueueVillas([v]); enqueueVillas([v]);
  assert.equal(calls, 1);
});


test('persistenter Villenfokus laesst nur Test Villa laufen', async () => {
  _resetScheduler();
  const other = villa('Andere Villa', 0, 2);
  const target = villa('Test Villa', 0, 2);
  await import('../scripts/focus-test-villa.mjs');
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(other).autonomy, 0);
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(other).status, 'PAUSED');
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(target).autonomy, 1);
  const started = [];
  configureScheduler({ start: async (id) => { started.push(id); return new Promise(() => {}); } });
  assert.equal(schedulerStatus().slots, 1);
  assert.equal(schedulerStatus().focusVillaId, target);
  assert.equal(enqueueVillas([other, target]).active[0], target);
  assert.equal(scheduleVilla(other).reason, 'FOCUS_VILLA_ONLY');
  assert.deepEqual(started, [target]);
  db.prepare('DELETE FROM control_settings WHERE key=?').run('villaFocusId');
  _resetScheduler();
});
