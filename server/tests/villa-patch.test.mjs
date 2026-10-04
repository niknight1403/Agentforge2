/**
 * Villa-Bearbeitung: PATCH /api/villas/:id aendert name, idea oder mode
 * (Teil-Update). Unbekannte Felder und leere Pflichtwerte werden mit 400
 * abgewiesen, fehlende Villa mit 404.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 22500 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-patch-')), 'p.db');
const ROOT = resolve(import.meta.dirname, '../..');

let child = null;
let sawLog = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHub(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Hub nicht erreichbar. Log:\n${sawLog.slice(-800)}`);
}

async function makeVilla(name) {
  const res = await fetch(`${BASE}/api/villas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, idea: 'Patch-Test-Idee', agentCount: 4 })
  });
  assert.equal(res.status, 201);
  return (await res.json()).villaId;
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
});

after(() => {
  if (child?.exitCode === null) child.kill('SIGTERM');
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
});

test('Name und Idee einzeln aendern (Teil-Update)', async () => {
  const id = await makeVilla('Vorher');
  let res = await fetch(`${BASE}/api/villas/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nachher' })
  });
  assert.equal(res.status, 200);
  let villa = (await res.json()).villa;
  assert.equal(villa.name, 'Nachher');
  assert.equal(villa.idea, 'Patch-Test-Idee', 'idea darf unberuehrt bleiben');

  res = await fetch(`${BASE}/api/villas/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idea: 'Neue Idee' })
  });
  assert.equal(res.status, 200);
  villa = (await res.json()).villa;
  assert.equal(villa.idea, 'Neue Idee');
  assert.equal(villa.name, 'Nachher', 'name darf unberuehrt bleiben');
});

test('Leerer Body aendert nichts (200 ok)', async () => {
  const id = await makeVilla('Stabil');
  const res = await fetch(`${BASE}/api/villas/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  const villa = (await res.json()).villa;
  assert.equal(villa.name, 'Stabil');
});

test('Unzulaessige Aenderungen: 400', async () => {
  const id = await makeVilla('Regeln');
  const cases = [
    { body: { name: '' }, match: /name darf nicht leer/ },
    { body: { idea: '' }, match: /idea darf nicht leer/ },
    { body: { mode: 'FALSCH' }, match: /mode muss BUILD oder ANALYZE/ },
    { body: { status: 'COMPLETED' }, match: /nur name, idea und mode/ }
  ];
  for (const c of cases) {
    const res = await fetch(`${BASE}/api/villas/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.body)
    });
    assert.equal(res.status, 400, `Body ${JSON.stringify(c.body)} haette 400 geben muessen`);
    assert.match((await res.json()).error, c.match);
  }
});

test('Unbekannte Villa: 404', async () => {
  const res = await fetch(`${BASE}/api/villas/999999`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' })
  });
  assert.equal(res.status, 404);
});
