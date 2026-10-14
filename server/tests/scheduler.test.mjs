/**
 * Tests fuer den Villa-Scheduler (scheduler.mjs) und die DB-Indizes.
 * Ziel: die weitesten Villen laufen zuerst, hoechstens VF_VILLA_SLOTS
 * gleichzeitig, der Rest rueckt nach.
 */
import './_env.mjs';
process.env.VF_VILLA_SLOTS = '2';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../db.mjs';
import { villaRanking, enqueueVillas, configureScheduler, schedulerStatus, _resetScheduler } from '../scheduler.mjs';

function villa(name, done, open, failed = 0) {
  const t = now();
  const id = Number(db.prepare(
    'INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)'
  ).run(name, 'idee', 'RUNNING', t, t).lastInsertRowid);
  const add = (status, n) => {
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO tasks (villa_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, `t${i}`, status, t, t);
    }
  };
  add('DONE', done); add('PENDING', open); add('FAILED', failed);
  return id;
}

test('Rangfolge: Villa mit dem meisten Fortschritt steht vorn', () => {
  const low = villa('Anfang', 1, 9);
  const high = villa('Fast fertig', 9, 1);
  const mid = villa('Mitte', 5, 5);
  const order = villaRanking().map((r) => r.id).filter((id) => [low, mid, high].includes(id));
  assert.deepEqual(order, [high, mid, low]);
});

test('Fehler kosten Rang bei gleichem Fortschritt', () => {
  const clean = villa('Sauber', 5, 5, 0);
  const faulty = villa('Fehlerhaft', 5, 5, 4);
  const order = villaRanking().map((r) => r.id);
  assert.ok(order.indexOf(clean) < order.indexOf(faulty));
});

test('Hoechstens 2 Villen gleichzeitig, weiteste zuerst, Rest rueckt nach', async () => {
  _resetScheduler();
  const a = villa('A', 1, 9);
  const b = villa('B', 9, 1);
  const c = villa('C', 5, 5);
  const d = villa('D', 8, 2);

  const started = [];
  let current = 0;
  let peak = 0;
  const releases = new Map();
  configureScheduler({
    start: (id) => new Promise((resolve) => {
      started.push(id);
      current += 1; peak = Math.max(peak, current);
      releases.set(id, () => { current -= 1; resolve(); });
    })
  });

  enqueueVillas([a, b, c, d]);
  // Erste zwei Slots: die zwei weitesten (B=9/10, D=8/10).
  assert.deepEqual(started, [b, d]);
  assert.equal(schedulerStatus().queued, 2);

  releases.get(b)();           // B fertig -> naechstweiteste (C) rueckt nach
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c]);

  releases.get(d)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [b, d, c, a]);

  releases.get(c)(); releases.get(a)();
  await new Promise((r) => setImmediate(r));
  assert.ok(peak <= 2, `Spitze war ${peak}`);
  assert.equal(schedulerStatus().active.length, 0);
  assert.equal(schedulerStatus().queued, 0);
});

test('Doppeltes Einreihen startet eine Villa nur einmal', async () => {
  _resetScheduler();
  const v = villa('Einmalig', 3, 3);
  let calls = 0;
  configureScheduler({ start: () => { calls += 1; return new Promise(() => {}); } });
  enqueueVillas([v]); enqueueVillas([v]);
  assert.equal(calls, 1);
});

test('Indizes auf villa_id existieren (gegen Vollscans im Event-Loop)', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  for (const need of ['idx_tasks_villa_status', 'idx_agents_villa', 'idx_memories_villa', 'idx_messages_villa', 'idx_audit_villa', 'idx_reports_villa']) {
    assert.ok(names.includes(need), `Index fehlt: ${need}`);
  }
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE villa_id = ? AND status IN ('PENDING','READY') ORDER BY priority, id")
    .all(1).map((r) => r.detail).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX/i, `Plan nutzt keinen Index: ${plan}`);
});
