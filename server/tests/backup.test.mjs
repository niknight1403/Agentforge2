/**
 * Backup: GET /api/backup liefert den kompletten Hub als JSON-Dump
 * (alle Villen mit Agenten, Aufgaben, Gedaechtnis, Berichten, Nachrichten).
 * Jedes Element des villas-Arrays ist direkt per POST /api/villas/import
 * wiederherstellbar — genau das prueft der Roundtrip hier.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 24000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-backup-')), 'b.db');
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

test('Backup enthaelt alle Villen im Import-Format und Roundtrip klappt', async () => {
  // Zwei Villen anlegen.
  for (const name of ['Backup-A', 'Backup-B']) {
    const res = await fetch(`${BASE}/api/villas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, idea: `Idee ${name}`, agentCount: 4 })
    });
    assert.equal(res.status, 201);
  }

  const res = await fetch(`${BASE}/api/backup`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /villaforge-backup-\d{4}-\d{2}-\d{2}\.json/);
  const backup = await res.json();

  assert.equal(backup.app, 'VillaForge');
  assert.equal(backup.villaCount, 2);
  assert.equal(backup.villas.length, 2);
  const names = backup.villas.map((e) => e.villa.name).sort();
  assert.deepEqual(names, ['Backup-A', 'Backup-B']);
  for (const entry of backup.villas) {
    assert.ok(Array.isArray(entry.agents) && entry.agents.length > 0);
    assert.ok(Array.isArray(entry.tasks));
    assert.ok(Array.isArray(entry.memories));
  }

  // Roundtrip: erstes Backup-Element als neue Villa importieren.
  const imp = await fetch(`${BASE}/api/villas/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backup.villas[0])
  });
  assert.equal(imp.status, 201);
  const out = await imp.json();
  assert.ok(out.villaId > 0);
  assert.equal(out.counts.agents, backup.villas[0].agents.length);
});
