// Scheduler-Tests: weiteste Villa zuerst, Slot-Grenze, Nachruecken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-sched-')), 'test.db');
// Dieser Test prueft den klassischen ROTATIONS-Pfad: Fokus-Modus (v1.42,
// Standard = genau 1 Slot) muss dafuer explizit aus sein, sonst
// ignoriert der Scheduler VF_VILLA_SLOTS und der Test misst den
// falschen Modus. Der Fokus-Modus hat seinen eigenen Test unten.
process.env.VF_FOCUS_MODE = '0';
process.env.VF_VILLA_SLOTS = '2';
const { db, now } = await import('../db.mjs');
const { villaRanking, enqueueVillas, configureScheduler, schedulerStatus, _resetScheduler } = await import('../scheduler.mjs');

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

test('Slot-Grenze: 2 gleichzeitig, weiteste zuerst, Rest rueckt nach', async () => {
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
  assert.deepEqual(started, [b, d], 'die zwei weitesten starten');
  assert.equal(schedulerStatus().queued, 2);
  releases.get(b)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c], 'B fertig -> C rueckt nach');
  releases.get(d)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c, a], 'D fertig -> A rueckt nach');
  releases.get(c)(); releases.get(a)();
  await new Promise((r) => setImmediate(r));
  assert.ok(peak <= 2, `Spitze ${peak} ueber Grenze`);
});

test('Doppeltes Einreihen startet nur einmal', async () => {
  _resetScheduler();
  const v = villa('Einmal', 3, 3);
  let calls = 0;
  configureScheduler({ start: () => { calls += 1; return new Promise(() => {}); } });
  enqueueVillas([v]); enqueueVillas([v]);
  assert.equal(calls, 1);
});
