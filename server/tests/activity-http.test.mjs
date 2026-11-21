import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vf-activity-api-'));
const dbPath = join(dir, 'hub.db');
const port = 37000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let child;
let writer;
let authHeaders;

async function activity(headers = authHeaders) {
  const response = await fetch(base + '/api/system/activity', { headers });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  process.env.VF_DB = dbPath;
  const { db } = await import('../db.mjs');
  const { upsertUser, createSession } = await import('../auth.mjs');
  const admin = upsertUser({ email: 'activity-admin@example.test', password: 'test-password-activity', role: 'admin' });
  authHeaders = { Authorization: 'Bearer ' + createSession(admin.id) };
  db.close();
  child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, VF_DB: dbPath, VF_WORKSPACE: join(dir, 'work'),
      HOST: '127.0.0.1', PORT: String(port), VF_RESUME: '0',
      VF_OPEN_MODE: '1', VF_RATE_WAIT_MS: '1' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  writer = new DatabaseSync(dbPath);
});

after(async () => {
  writer?.close();
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolveExit => {
      child.once('exit', resolveExit);
      setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 1500).unref();
    });
  }
  rmSync(dir, { recursive: true, force: true });
});

test('activity heartbeat is UNKNOWN without work, ACTIVE on task progress, and STALE when old', async () => {
  const denied = await activity({});
  assert.equal(denied.status, 403, 'endpoint must reject unauthenticated callers even in open mode');
  let result = await activity();
  assert.equal(result.status, 200);
  assert.equal(result.body.activityState, 'UNKNOWN');
  assert.equal(result.body.activityAt, null);
  assert.equal(result.body.activityAgeMs, null);
  await fetch(base + '/api/stats');
  result = await activity();
  assert.equal(result.body.activityState, 'UNKNOWN', 'polling stats must not create activity');

  const timestamp = Date.now();
  const villaId = Number(writer.prepare(
    "INSERT INTO villas(name,idea,status,autonomy,created_at,updated_at) VALUES (?,?,?,1,?,?)"
  ).run('Activity test', 'Heartbeat fixture', 'PAUSED', timestamp, timestamp).lastInsertRowid);
  writer.prepare('UPDATE villas SET updated_at=? WHERE id=?').run(timestamp, villaId);
  result = await activity();
  assert.equal(result.body.activityState, 'UNKNOWN', 'Villa metadata is not work activity');
  writer.prepare(
    "INSERT INTO tasks(villa_id,title,description,status,created_at,updated_at) VALUES (?,?,?,'RUNNING',?,?)"
  ).run(villaId, 'Fresh task', 'Progress fixture', timestamp, timestamp);

  result = await activity();
  assert.equal(result.body.activityState, 'ACTIVE');
  assert.ok(result.body.activityAt >= timestamp);
  assert.equal(result.body.counts.runningTasks, 1);

  writer.prepare('UPDATE tasks SET updated_at=? WHERE villa_id=?').run(Date.now() - 2 * 60 * 60 * 1000, villaId);
  result = await activity();
  assert.equal(result.body.activityState, 'STALE');
  assert.ok(result.body.activityAgeMs >= 90 * 60 * 1000);
});
