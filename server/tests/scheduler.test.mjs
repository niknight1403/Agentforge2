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

test('Slot-Grenze: drei Startanforderungen laufen parallel, Queue bleibt FIFO', async () => {
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
  assert.deepEqual(started, [a, b, c], 'die ersten drei Anforderungen starten unveraendert');
  assert.equal(schedulerStatus().queued, 1);
  releases.get(b)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [a, b, c, d], 'B fertig -> D rueckt nach');
  releases.get(d)();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [a, b, c, d], 'D fertig, kein weiterer Lauf wartet');
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

test('produktionsfokus aktiviert CyberSarah und Revenue Engine, entfernt Legacy-Villen', async () => {
  _resetScheduler();
  const other = villa('Andere Villa', 2, 2);
  const a = villa('CyberSarah Villa', 2, 2);
  const b = villa('Autonomous Revenue Engine - Target 7K EUR MRR', 1, 3);
  const legacyNew = villa('testneu', 1, 2);
  const legacyOld = villa('Test Villa', 0, 1);
  const rootId = Number(db.prepare('INSERT INTO agents (villa_id,name,role,is_root,created_at,last_active_at) VALUES (?,?,?,?,?,?)').run(a, 'DeepAgent', 'ROOT', 1, now(), now()).lastInsertRowid);
  db.prepare('INSERT INTO messages (villa_id,agent_id,role,content,created_at) VALUES (?,?,?,?,?)').run(legacyOld, 999, 'user', 'remove me', now());

  await import('../scripts/focus-test-villa.mjs');

  assert.equal(db.prepare('SELECT id FROM villas WHERE id=?').get(legacyNew), undefined);
  assert.equal(db.prepare('SELECT id FROM villas WHERE id=?').get(legacyOld), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE villa_id=?').get(legacyOld).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE villa_id=?').get(legacyOld).count, 0);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(other).autonomy, 0);
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(other).status, 'PAUSED');
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(a).autonomy, 1);
  assert.equal(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(b).autonomy, 1);
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(a).status, 'RUNNING');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agents WHERE villa_id=? AND is_root=1').get(a).count, 1);
  assert.equal(db.prepare('SELECT id FROM agents WHERE id=?').get(rootId).id, rootId);
  assert.equal(db.prepare("SELECT value FROM control_settings WHERE key='villaFocusId'").get(), undefined);

  const started = [];
  configureScheduler({ start: async (id) => { started.push(id); return new Promise(() => {}); } });
  db.prepare("INSERT OR REPLACE INTO control_settings(key,value) VALUES ('villaFocusId',?)").run(String(a));
  assert.equal(schedulerStatus().slots, 3, 'Fokus darf die Parallel-Slots nicht reduzieren');
  const enq = enqueueVillas([other, a, b]);
  assert.ok(enq.active.includes(a) && enq.active.includes(b), 'beide Produktionsvillaen laufen');
  assert.ok(db.prepare('SELECT autonomy FROM villas WHERE id=?').get(other).autonomy === 0, 'geparkte Villa bleibt autonomy 0');
  db.prepare('DELETE FROM control_settings');
  _resetScheduler();
});


test('Finish-before-rotation mode persists per villa for restarts', async () => {
  _resetScheduler();
  const { villaRunToCompletion, setVillaRunToCompletion } = await import('../scheduler.mjs');
  const a = villa('Abschluss A', 0, 2);
  const b = villa('Abschluss B', 0, 2);
  assert.equal(villaRunToCompletion(a), false);
  assert.equal(setVillaRunToCompletion(a, true), true);
  assert.equal(villaRunToCompletion(a), true);
  assert.equal(villaRunToCompletion(b), false, 'finish mode must be isolated per villa');
  setVillaRunToCompletion(a, false);
  assert.equal(villaRunToCompletion(a), false);
});

test('Neustart setzt den gespeicherten Abschlussmodus fuer jede Villa fort', async () => {
  _resetScheduler();
  const { setVillaRunToCompletion } = await import('../scheduler.mjs');
  const { configureResumeScheduler } = await import('../resume.mjs');
  const id = villa('Wiederaufnahme Abschluss', 1, 2);
  setVillaRunToCompletion(id, true);
  let received;
  configureResumeScheduler({ start: async (villaId, options) => { received = { villaId, options }; } });
  enqueueVillas([id]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.villaId, id);
  assert.equal(received.options.runToCompletion, true);
  assert.equal(received.options.concurrency, 0);
  _resetScheduler();
});

test('Modellausfall wartet mit Backoff und kann per Stopp abgebrochen werden', async () => {
  _resetScheduler();
  const id = villa('Route wartet', 0, 1);
  db.prepare('UPDATE villas SET autonomy=1 WHERE id=?').run(id);
  configureScheduler({ start: async () => ({ retryAfterMs: 15_000 }) });
  enqueueVillas([id]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(schedulerStatus().retrying, [id]);
  assert.equal(db.prepare('SELECT status FROM villas WHERE id=?').get(id).status, 'WAITING_FOR_MODEL');
  assert.equal(cancelScheduledVilla(id), true);
  assert.deepEqual(schedulerStatus().retrying, []);
  _resetScheduler();
});

test('Modell-wartende Villen werden nach einem Hub-Neustart direkt wieder eingereiht', async () => {
  _resetScheduler();
  db.prepare("UPDATE villas SET autonomy=0 WHERE status IN ('RUNNING','WAITING_FOR_MODEL')").run();
  const id = villa('Route nach Neustart', 0, 1);
  db.prepare("UPDATE villas SET status='WAITING_FOR_MODEL', autonomy=1 WHERE id=?").run(id);
  const { resumePendingVillas } = await import('../resume.mjs');
  const started = [];
  const result = resumePendingVillas({ start: async (villaId, options) => { started.push({ villaId, options }); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result.villas, [id]);
  assert.equal(started[0].villaId, id);
  _resetScheduler();
});
