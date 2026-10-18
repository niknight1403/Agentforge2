// Wartungstests: Historien-Rotation und Altdaten-Bereinigung gegen eine
// Wegwerf-Datenbank. Start: node --test server/tests/maintenance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-maint-')), 'test.db');
const { db, now } = await import('../db.mjs');
const { pruneHistory, pruneOldData, maintenanceTick, dbSize } = await import('../maintenance.mjs');

function villa(name) {
  const r = db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(name, 'i', 'RUNNING', now(), now());
  return Number(r.lastInsertRowid);
}
function audit(v, n) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,?)').run(now(), v, 0, 'x', '', '', 1);
}
function mem(v, n, imp) {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)').run(v, 0, 'villa', 'FACT', 't', 'c', imp, now());
}
function msg(v, n, ageDays = 0) {
  const ts = now() - ageDays * 86_400_000;
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, tool, created_at) VALUES (?,?,?,?,?,?)').run(v, 0, 'user', 'x', null, ts);
}

test('pruneHistory kuerzt auf Fenster, Wichtiges ueberlebt', () => {
  const v = villa('Rotation');
  audit(v, 500);
  mem(v, 250, 5);
  mem(v, 100, 9); // ueberlebt immer (350 gesamt > 300er-Fenster)
  const r = pruneHistory(v, { keepAudit: 400, keepMemories: 300 });
  assert.ok(r.audit >= 100, `audit geloescht: ${r.audit}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit WHERE villa_id = ?').get(v).c, 400);
  const total = db.prepare('SELECT COUNT(*) c FROM memories WHERE villa_id = ?').get(v).c;
  assert.equal(total, 300, 'memories auf Fenster gekuerzt');
  const vital = db.prepare('SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND importance >= 8').get(v).c;
  assert.equal(vital, 100, 'wichtige Erinnerungen (importance>=8) ueberleben');
});

test('pruneHistory kuerzt Chatverlaeufe je Villa auf das letzte Fenster', () => {
  const v = villa('Chat');
  msg(v, 700);
  const r = pruneHistory(v, { keepMessages: 500 });
  assert.equal(r.messages, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE villa_id = ?').get(v).c, 500);
});

test('pruneOldData loescht nur Altes, Trockenlauf zaehlt nur', () => {
  const v = villa('Alt');
  const alt = villa('Frisch');
  msg(v, 10, 45); // 45 Tage alt
  msg(alt, 10, 1);
  const dry = pruneOldData({ days: 30, dryRun: true });
  assert.equal(dry.deleted.messages, 10);
  const dryAfter = db.prepare('SELECT COUNT(*) c FROM messages WHERE villa_id IN (?,?)').get(v, alt).c;
  assert.equal(dryAfter, 20, 'Trockenlauf loescht nichts');
  const real = pruneOldData({ days: 30 });
  assert.equal(real.deleted.messages, 10);
  assert.equal(real.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE villa_id IN (?,?)').get(v, alt).c, 10, 'nur Altes geloescht');
});

test('maintenanceTick fasst alles zusammen und meldet DB-Groesse', () => {
  const v = villa('Tick');
  audit(v, 600); msg(v, 5, 40);
  const r = maintenanceTick({ days: 30 });
  assert.equal(r.ok, true);
  assert.ok(r.villas >= 3, 'mind. die Testvillen');
  assert.ok(r.rotated.audit >= 200);
  assert.ok(r.db.main >= 0 && r.db.wal >= 0, 'dbSize liefert Zahlen');
});

test('pruneOldData lehnt unsinnige Tage ab', () => {
  assert.equal(pruneOldData({ days: 0 }).ok, false);
  assert.equal(pruneOldData({ days: 9999 }).ok, false);
});
