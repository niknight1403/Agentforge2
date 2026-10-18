// Regressionstest gegen den App-OutOfMemoryError: Endpunkte duerfen keine
// unbegrenzten JSON-Pakete liefern. Start: node --test server/tests/api-payload.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-payload-')), 'test.db');
process.env.PORT = String(41771 + Math.floor(Math.random() * 200));
process.env.HOST = '127.0.0.1';
process.env.VF_VILLA_SLOTS = '2';

const { db, now } = await import('../db.mjs');
const { upsertUser } = await import('../auth.mjs');
const { server } = await import('../server.mjs'); // startet den Hub auf PORT
// Sonst haengt der Testprozess am offenen Listener fest.
after(() => server.close());

const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function api(path, opts = {}, token) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { ...opts, headers });
  return { status: r.status, body: await r.json() };
}

test('Villa-Detail bleibt klein, egal wie viele Tasks existieren', async () => {
  upsertUser({ email: 't@example.com', password: 'geheim123', role: 'admin', plan: 'pro' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 't@example.com', password: 'geheim123' }) });
  assert.equal(login.status, 200, 'Login klappt');
  const token = login.body.token;
  assert.ok(token, 'Token kommt');

  const t = now();
  const id = Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('OOM-Villa', 'i', 'PAUSED', t, t).lastInsertRowid);
  const BIG = 'x'.repeat(6000);
  for (let i = 0; i < 1200; i++) {
    db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, `Task ${i}`, 'd', i % 3 === 0 ? 'DONE' : 'PENDING', 5, BIG, t, t);
  }

  const detail = await api(`/api/villas/${id}`, {}, token);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.tasks.length <= 800, `tasks begrenzt: ${detail.body.tasks.length}`);
  assert.ok(detail.body.tasks.every((x) => (x.result || '').length <= 500), 'Result nur als Vorschau');
  assert.ok(detail.body.taskCounts, 'taskCounts vorhanden');
  const payload = JSON.stringify(detail.body);
  assert.ok(payload.length < 2_000_000, `Detail-Payload klein: ${(payload.length / 1024).toFixed(0)} KB`);

  const list = await api(`/api/villas/${id}/tasks?limit=500`, {}, token);
  assert.equal(list.status, 200);
  assert.ok(list.body.length <= 500);
  assert.ok(list.body.every((x) => (x.result || '').length <= 2000), 'Task-Liste begrenzt Result');

  const villaList = await api('/api/villas', {}, token);
  assert.equal(villaList.status, 200);
  assert.ok(Array.isArray(villaList.body));
});
