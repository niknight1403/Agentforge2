import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-delete-')), 'test.db');
process.env.PORT = String(42000 + Math.floor(Math.random() * 5000));
process.env.HOST = '127.0.0.1';

const { db, now } = await import('../db.mjs');
const { upsertUser } = await import('../auth.mjs');
const { server } = await import('../server.mjs');

after(() => server.close());

const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { ...opts, headers });
  return { status: r.status, body: await r.json() };
}

test('DELETE /api/villas/:id liefert 404 bei nicht existierender Villa', async () => {
  upsertUser({ email: 'admin-del@example.com', password: 'pass1234', role: 'admin', plan: 'pro' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin-del@example.com', password: 'pass1234' }) });
  const token = login.body.token;

  const res = await api('/api/villas/999999', { method: 'DELETE' }, token);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Villa nicht gefunden');
});

test('DELETE /api/villas/:id loescht Villa mit Kaskade ueber Untertabellen', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin-del@example.com', password: 'pass1234' }) });
  const token = login.body.token;

  const t = now();
  const villaId = Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('Delete-Me Villa', 'Test-Idee', 'PAUSED', t, t).lastInsertRowid);

  db.prepare('INSERT INTO tasks (villa_id, title, description, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(villaId, 'Task 1', 'Desc', t, t);
  db.prepare('INSERT INTO tasks (villa_id, title, description, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(villaId, 'Task 2', 'Desc', t, t);

  db.prepare('INSERT INTO agents (villa_id, name, created_at, last_active_at) VALUES (?,?,?,?)')
    .run(villaId, 'Agent 1', t, t);

  db.prepare('INSERT INTO memories (villa_id, title, content, created_at) VALUES (?,?,?,?)')
    .run(villaId, 'Mem 1', 'Content', t);

  db.prepare('INSERT INTO messages (villa_id, agent_id, role, content, created_at) VALUES (?,?,?,?,?)')
    .run(villaId, 1, 'user', 'Hallo', t);

  db.prepare('INSERT INTO audit (ts, villa_id, tool) VALUES (?,?,?)')
    .run(t, villaId, 'test_tool');

  db.prepare('INSERT INTO reports (villa_id, title, content, created_at) VALUES (?,?,?,?)')
    .run(villaId, 'Report 1', 'Content', t);

  db.prepare('INSERT INTO council (villa_id, round, created_at) VALUES (?,?,?)')
    .run(villaId, 1, t);

  const res = await api(`/api/villas/${villaId}`, { method: 'DELETE' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.deleted, villaId);
  assert.equal(res.body.counts.tasks, 2);
  assert.equal(res.body.counts.agents, 1);
  assert.equal(res.body.counts.memories, 1);
  assert.equal(res.body.counts.messages, 1);
  assert.equal(res.body.counts.audit, 1);
  assert.equal(res.body.counts.reports, 1);
  assert.equal(res.body.counts.council, 1);

  // Verifizieren, dass Villa und Unterdaten in DB nicht mehr existieren
  const checkVilla = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  assert.equal(checkVilla, undefined);

  const checkTasks = db.prepare('SELECT COUNT(*) c FROM tasks WHERE villa_id = ?').get(villaId).c;
  assert.equal(checkTasks, 0);
});

test('DELETE /api/villas/:id stoppt laufende Villa vor dem Loeschen', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin-del@example.com', password: 'pass1234' }) });
  const token = login.body.token;

  const t = now();
  const villaId = Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('Running Villa', 'Test', 'RUNNING', t, t).lastInsertRowid);

  const res = await api(`/api/villas/${villaId}`, { method: 'DELETE' }, token);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.deleted, villaId);

  const checkVilla = db.prepare('SELECT * FROM villas WHERE id = ?').get(villaId);
  assert.equal(checkVilla, undefined);
});
