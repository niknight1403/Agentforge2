/**
 * Wartung: pruneOldData raeumt Audit-Eintraege und Nachrichten auf,
 * die aelter als `days` Tage sind. Trockenlauf zaehlt nur.
 * Reiner In-Prozess-Test gegen die echte SQLite-Datei.
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.mjs';
import { pruneOldData } from '../maintenance.mjs';

const DAY = 86400000;
const now = Date.now();

function seed() {
  db.prepare('DELETE FROM audit').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('Prune-Villa', 'x', 'CREATED', now, now);
  const villaId = db.prepare('SELECT id FROM villas ORDER BY id DESC').get().id;
  const ins = db.prepare('INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,1)');
  ins.run(now - 400 * DAY, villaId, null, 'listDir', '{}', 'alt');
  ins.run(now - 400 * DAY, villaId, null, 'readFile', '{}', 'alt');
  ins.run(now, villaId, null, 'readFile', '{}', 'neu');
  const insM = db.prepare("INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,'x',?)");
  insM.run(villaId, 1, 'user', now - 400 * DAY);
  insM.run(villaId, 1, 'assistant', now);
  return villaId;
}

test('Ungueltige days: Fehler mit Meldung', () => {
  for (const bad of [0, -5, 'abc', 4000, null]) {
    const r = pruneOldData({ days: bad });
    assert.equal(r.ok, false);
    assert.match(r.error, /days muss zwischen 1 und 3650/);
  }
});

test('Trockenlauf zaehlt, loescht nichts', () => {
  seed();
  const r = pruneOldData({ days: 100, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.deleted.audit, 2);
  assert.equal(r.deleted.messages, 1);
  assert.equal(r.deleted.total, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit').get().c, 3, 'nichts geloescht');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 2, 'nichts geloescht');
});

test('Echter Lauf loescht nur Altes', () => {
  seed();
  const r = pruneOldData({ days: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.equal(r.deleted.audit, 2);
  assert.equal(r.deleted.messages, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit').get().c, 1, 'nur der neue Eintrag bleibt');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 1, 'nur die neue Nachricht bleibt');
  // Nochmals laufen: nichts mehr zu tun.
  const r2 = pruneOldData({ days: 100 });
  assert.equal(r2.deleted.total, 0);
});

test('days=3650 als Obergrenze ist erlaubt', () => {
  seed();
  const r = pruneOldData({ days: 3650 });
  assert.equal(r.ok, true);
});
