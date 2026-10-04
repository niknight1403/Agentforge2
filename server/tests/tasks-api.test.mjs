/**
 * Aufgaben-API: GET /api/villas/:id/tasks (Statusfilter, Deckelung)
 * und PATCH /api/villas/:id/tasks/:taskId (Status, Prioritaet, Ergebnis).
 * Laufende Aufgaben duerfen nicht weg-RUNNING-gesetzt werden (409).
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 23000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-tasks-')), 't.db');
const ROOT = resolve(import.meta.dirname, '../..');

let child = null;
let sawLog = '';
let villaId = 0;
let taskCount = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Hub nicht erreichbar. Log:\n${sawLog.slice(-800)}`);
}

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  await waitForHub();

  const r = await api('/api/villas', { method: 'POST', body: JSON.stringify({ name: 'Task-API', idea: 'Aufgaben testen', agentCount: 4 }) });
  assert.equal(r.status, 201, `Villa-Anlage: ${JSON.stringify(r.body)}`);
  villaId = r.body.villaId;
  const det = await api(`/api/villas/${villaId}`);
  taskCount = det.body.tasks.length;
  assert.ok(taskCount > 0, 'Villa sollte Aufgaben aus dem Plan haben');
});

after(() => {
  if (child?.exitCode === null) child.kill('SIGTERM');
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
});

test('GET tasks: alle, mit Statusfilter, mit Fehlerfaellen', async () => {
  const all = await api(`/api/villas/${villaId}/tasks`);
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body));
  assert.equal(all.body.length, taskCount);
  assert.ok(all.body.every((t) => t.villa_id === villaId));

  const pending = await api(`/api/villas/${villaId}/tasks?status=PENDING`);
  assert.equal(pending.status, 200);
  assert.ok(pending.body.every((t) => t.status === 'PENDING'));

  const bad = await api(`/api/villas/${villaId}/tasks?status=QUATSCH`);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /status muss einer aus/);

  const missing = await api('/api/villas/999999/tasks');
  assert.equal(missing.status, 404);
});

test('PATCH task: Prioritaet, Status und Ergebnis', async () => {
  const tasks = (await api(`/api/villas/${villaId}/tasks?status=PENDING`)).body;
  const target = tasks[0];
  assert.ok(target);

  const r = await api(`/api/villas/${villaId}/tasks/${target.id}`, {
    method: 'PATCH', body: JSON.stringify({ priority: 2, result: 'von Hand erledigt', status: 'DONE' })
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.priority, 2);
  assert.equal(r.body.task.status, 'DONE');
  assert.equal(r.body.task.result, 'von Hand erledigt');

  // In der gefilterten PENDING-Liste taucht sie nicht mehr auf.
  const pending = await api(`/api/villas/${villaId}/tasks?status=PENDING`);
  assert.ok(!pending.body.some((t) => t.id === target.id));
});

test('PATCH task: 400/404-Faelle', async () => {
  const tasks = (await api(`/api/villas/${villaId}/tasks?status=PENDING`)).body;
  const target = tasks[0];

  const unknown = await api(`/api/villas/${villaId}/tasks/999999`, { method: 'PATCH', body: JSON.stringify({ status: 'DONE' }) });
  assert.equal(unknown.status, 404);

  const badStatus = await api(`/api/villas/${villaId}/tasks/${target.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FERTIG' }) });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.body.error, /status muss einer aus/);

  const badPriority = await api(`/api/villas/${villaId}/tasks/${target.id}`, { method: 'PATCH', body: JSON.stringify({ priority: 42 }) });
  assert.equal(badPriority.status, 400);

  const badField = await api(`/api/villas/${villaId}/tasks/${target.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Neu' }) });
  assert.equal(badField.status, 400);
  assert.match(badField.body.error, /nur status, priority und result/);

  const empty = await api(`/api/villas/${villaId}/tasks/${target.id}`, { method: 'PATCH', body: '{}' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /keine Aenderung/);
});
