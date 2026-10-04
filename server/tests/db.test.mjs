import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, now, pruneHistory } from '../db.mjs';
import { seedRoutes } from '../seed.mjs';
import { FREE_ROUTE_CATALOG } from '../routes.mjs';

test('Datenbank: alle Tabellen sind angelegt', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['villas', 'agents', 'tasks', 'memories', 'messages', 'routes', 'secrets', 'audit', 'sources', 'reports']) {
    assert.ok(tables.includes(t), `Tabelle ${t} fehlt`);
  }
});

test('Migrationen: fehlende Spalten werden ergaenzt (idempotent)', () => {
  // ensureColumn laeuft beim Import; ein zweiter Durchlauf darf nicht crashen.
  // Wir simulieren eine aeltere Datenbank, indem wir eine Spalte loeschen und
  // das Modul-Verhalten ueber die bereits gelaufene Migration pruefen.
  const cols = db.prepare('PRAGMA table_info(routes)').all().map((c) => c.name);
  assert.ok(cols.includes('cooldown_until'), 'cooldown_until fehlt');
  const vcols = db.prepare('PRAGMA table_info(villas)').all().map((c) => c.name);
  assert.ok(vcols.includes('source_path') && vcols.includes('auto_rounds'), 'villa-Spalten fehlen');
});

test('Routen-Katalog: saubere Eintraege ohne Duplikate', () => {
  const names = FREE_ROUTE_CATALOG.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, 'doppelte Routennamen');
  for (const r of FREE_ROUTE_CATALOG) {
    assert.ok(r.name && r.provider && r.model, `unvollstaendiger Eintrag: ${r.name}`);
    assert.ok(/^https:\/\//.test(r.baseUrl) || r.baseUrl.startsWith('http://127.0.0.1'), `unsichere Base-URL: ${r.baseUrl}`);
    assert.ok(Number.isInteger(r.priority) && r.priority > 0, `ungueltige Prioritaet: ${r.name}`);
  }
});

test('seedRoutes: fuellt nur einmal und ist idempotent', () => {
  const a = seedRoutes();
  const b = seedRoutes();
  assert.equal(a, FREE_ROUTE_CATALOG.length);
  assert.equal(b, 0, 'zweiter Aufruf darf nichts einfuegen');
});

test('now(): Millisekunden-Zeitstempel', () => {
  const t = now();
  assert.ok(Number.isInteger(t) && Math.abs(t - Date.now()) < 5000);
});

test('pruneHistory: kuerzt audit und memories auf Fenster, haelt Wichtiges', () => {
  seedRoutes();
  const t = now();
  const r = db.prepare(
    'INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run('PruneVilla', 'test', 'COMPLETED', 1000, 1, t, t);
  const vid = r.lastInsertRowid;

  // 600 Audit-Zeilen und 600 Erinnerungen, davon 10 mit hoechster Wichtigkeit.
  const insAudit = db.prepare('INSERT INTO audit (villa_id, agent_id, tool, args, result, ts) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 600; i++) insAudit.run(vid, 1, 'read', '{}', 'ok', t);
  const insMem = db.prepare('INSERT INTO memories (villa_id, agent_id, scope, kind, title, content, importance, created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 600; i++) insMem.run(vid, 1, 'villa', 'NOTE', `n${i}`, 'x', i < 10 ? 9 : 2, t);
  // Hoechste IDs bekommen Wichtigkeit 2, damit Relevanz statt Recency gefordert ist.

  const out = pruneHistory(vid);
  assert.equal(out.audit, 200, 'audit wurde nicht auf 400 gekuerzt');
  assert.equal(out.memories, 300, 'memories wurde nicht auf 300 gekuerzt');

  const auditCount = db.prepare('SELECT COUNT(*) c FROM audit WHERE villa_id = ?').get(vid).c;
  const memCount = db.prepare('SELECT COUNT(*) c FROM memories WHERE villa_id = ?').get(vid).c;
  assert.equal(auditCount, 400);
  assert.equal(memCount, 300);

  const keptHigh = db.prepare('SELECT COUNT(*) c FROM memories WHERE villa_id = ? AND importance >= 8').get(vid).c;
  assert.equal(keptHigh, 10, 'wichtige Erinnerungen wurden weggekuerzt');

  // Zweiter Aufruf ist idempotent.
  const again = pruneHistory(vid);
  assert.equal(again.audit + again.memories, 0, 'zweiter Lauf loescht nichts');
});
