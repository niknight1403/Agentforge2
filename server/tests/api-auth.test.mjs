/**
 * Auth-Integrationstest: mit gesetztem VF_TOKEN muessen alle API-Endpunkte
 * einen Bearer-Token verlangen; Health bleibt offen. Ohne VF_TOKEN aendert
 * sich nichts (Rueckwaertskompatibilitaet).
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 29000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-auth-')), 'auth.db');
const ROOT = resolve(import.meta.dirname, '../..');
const TOKEN = 'e2e-token-geheim-42';

let child = null;
let sawLog = '';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0', VF_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* noch nicht oben */ }
    await sleep(250);
  }
  throw new Error(`Hub startet nicht. Log:\n${sawLog.slice(-600)}`);
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* tmp */ }
  }
});

test('Health bleibt ohne Token offen', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
});

test('Ohne Token: API-Endpunkte liefern 401', async () => {
  for (const path of ['/api/villas', '/api/routes', '/api/secrets', '/api/tools']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 401, `${path} nicht geschuetzt`);
  }
  const post = await fetch(`${BASE}/api/villas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
});

test('Falscher Token wird abgelehnt', async () => {
  const res = await fetch(`${BASE}/api/villas`, { headers: { Authorization: 'Bearer falsch' } });
  assert.equal(res.status, 401);
});

test('Richtiger Token gewaehrt Zugang', async () => {
  const res = await fetch(`${BASE}/api/villas`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
});

test('Token erscheint nie im Server-Log', async () => {
  await fetch(`${BASE}/api/villas`, { headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  assert.ok(!sawLog.includes(TOKEN), 'Token wurde geloggt!');
});

test('SSE-Stream ist ebenfalls geschuetzt', async () => {
  const res = await fetch(`${BASE}/api/events`);
  assert.equal(res.status, 401);
  const ok = await fetch(`${BASE}/api/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  ok.body.cancel();
});
