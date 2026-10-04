/**
 * Audit-API: GET /api/villas/:id/audit liefert das Werkzeug-Protokoll
 * einer Villa mit Pagination (limit/offset) und Gesamtzahl. Die
 * Detailansicht bleibt bei den letzten 200 fix; hier geht es um Blaettern.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import { db } from '../db.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 24000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.VF_DB;
const ROOT = resolve(import.meta.dirname, '../..');

let child = null;
let sawLog = '';
let villaId = 0;
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

  const r = await api('/api/villas', { method: 'POST', body: JSON.stringify({ name: 'Audit-API', idea: 'Audit pruefen', agentCount: 4 }) });
  assert.equal(r.status, 201, `Villa-Anlage: ${JSON.stringify(r.body)}`);
  villaId = r.body.villaId;

  // Audit-Eintraege deterministisch saeen (Offline-Lauf ruft keine Werkzeuge).
  const ins = db.prepare('INSERT INTO audit (ts, villa_id, agent_id, tool, args, result, allowed) VALUES (?,?,?,?,?,?,1)');
  for (let i = 0; i < 12; i++) ins.run(Date.now(), villaId, null, i % 2 ? 'readFile' : 'writeFile', '{}', `Ergebnis ${i}`);
});

after(() => {
  if (child?.exitCode === null) child.kill('SIGTERM');
});

test('Audit liefert Eintraege mit Gesamtzahl und Pagination-Feldern', async () => {
  const r = await api(`/api/villas/${villaId}/audit`);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.villaId, villaId);
  assert.equal(b.limit, 100);
  assert.equal(b.offset, 0);
  assert.ok(Array.isArray(b.entries));
  assert.ok(b.total >= b.entries.length, 'total deckt die Eintraege ab');
  assert.equal(b.total, 12, 'gesaete Audit-Zeilen sind vollstaendig');
  assert.ok(b.entries.length >= 1, 'mindestens ein Eintrag in der ersten Seite');
  for (const e of b.entries) {
    assert.equal(e.villa_id, villaId);
    assert.ok(e.tool, 'Eintrag braucht ein Werkzeug');
  }
  // Neueste zuerst.
  const ids = b.entries.map((e) => e.id);
  assert.deepEqual([...ids].sort((a, c) => c - a), ids, 'Audit absteigend sortiert');
});

test('limit/offset blaettern durch das Protokoll, Deckelung greift', async () => {
  const first = await api(`/api/villas/${villaId}/audit?limit=2`);
  assert.equal(first.body.entries.length, Math.min(2, first.body.total));
  const second = await api(`/api/villas/${villaId}/audit?limit=2&offset=2`);
  assert.equal(second.body.offset, 2);
  // Offset hinter dem Ende liefert eine leere Seite, kein Fehler.
  const far = await api(`/api/villas/${villaId}/audit?limit=10&offset=99999`);
  assert.equal(far.status, 200);
  assert.deepEqual(far.body.entries, []);
  // limit wird auf 500 gedeckelt (kein 500er durch Riesenabfragen).
  const huge = await api(`/api/villas/${villaId}/audit?limit=99999`);
  assert.equal(huge.body.limit, 500);
});

test('Unbekannte Villa und fremde Methoden werden abgewiesen', async () => {
  const r = await api('/api/villas/99999/audit');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /nicht gefunden/);
  const bad = await api(`/api/villas/${villaId}/audit`, { method: 'DELETE' });
  assert.equal(bad.status, 404, 'DELETE ist kein gueltiger Auditauf');
});
