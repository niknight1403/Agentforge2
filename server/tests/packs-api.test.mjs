/**
 * Pack-Endpunkte ueber HTTP: /api/packs, /api/tool-packs und der Schalter
 * PATCH /api/packs/:id. Hier wird geprueft, dass die Oberflaeche wirklich
 * steuern kann — und dass die Wirkung bis in /api/tools und /api/stats reicht.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 22000 + Math.floor(Math.random() * 6000);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'vf-packs-'));
const DB = join(DIR, 'packs.db');
const ROOT = resolve(import.meta.dirname, '../..');

let child = null;
let sawLog = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (path) => fetch(`${BASE}${path}`).then((r) => r.json());
const patch = (path, body) => fetch(`${BASE}${path}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: DB, VF_WORKSPACE: join(DIR, 'workspace'), PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* noch nicht oben */ }
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

test('GET /api/packs liefert Feature- und Werkzeug-Packs', async () => {
  const state = await get('/api/packs');
  assert.ok(Array.isArray(state.features) && state.features.length > 0);
  assert.ok(Array.isArray(state.tools) && state.tools.length > 0);
  assert.equal(state.master.enabled, true);
  assert.ok(state.features.every((f) => typeof f.enabled === 'boolean'));
  assert.ok(state.tools.every((t) => Array.isArray(t.tools) && t.tools.length > 0));
});

test('GET /api/tool-packs liefert die gebuendelten Werkzeuge', async () => {
  const packs = await get('/api/tool-packs');
  assert.equal(packs.master.enabled, true);
  assert.ok(packs.packs.length >= 5);
  const execution = packs.packs.find((p) => p.id === 'ausfuehrung');
  assert.deepEqual(execution.tools, ['project_run']);
  assert.equal(execution.effective, true);
  assert.deepEqual(packs.blocked, []);
});

test('PATCH /api/packs/:id schaltet ab und wieder an', async () => {
  const off = await patch('/api/packs/recherche', { enabled: false });
  assert.equal(off.status, 200);
  const body = await off.json();
  assert.equal(body.pack.enabled, false);
  assert.ok(body.state.blocked.includes('recherche'));

  const tools = await get('/api/tools');
  const webFetch = tools.find((t) => t.name === 'web_fetch');
  assert.equal(webFetch.enabled, false, 'web_fetch muesste gesperrt sein');
  assert.equal(webFetch.pack, 'recherche');
  // Andere Werkzeuge bleiben frei.
  assert.equal(tools.find((t) => t.name === 'memory_write').enabled, true);

  const stats = await get('/api/stats');
  assert.ok(stats.packs.blocked.includes('recherche'), 'Statistik meldet die Sperre nicht');

  const on = await patch('/api/packs/recherche', { enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual((await get('/api/packs')).blocked, []);
});

test('Hauptschalter sperrt alle Werkzeuge auf einmal', async () => {
  const off = await patch('/api/packs/werkzeuge', { enabled: false });
  assert.equal(off.status, 200);
  const tools = await get('/api/tools');
  assert.ok(tools.every((t) => t.enabled === false), 'nicht alle Werkzeuge gesperrt');
  const packs = await get('/api/tool-packs');
  assert.equal(packs.master.enabled, false);
  assert.equal(packs.blocked.length, packs.packs.length);

  await patch('/api/packs/werkzeuge', { enabled: true });
  assert.ok((await get('/api/tools')).every((t) => t.enabled === true));
});

test('ungueltige Schaltversuche werden sauber abgewiesen', async () => {
  assert.equal((await patch('/api/packs/gibt-es-nicht', { enabled: false })).status, 404);
  assert.equal((await patch('/api/packs/recherche', { enabled: 'ja' })).status, 400);
  const noBody = await fetch(`${BASE}/api/packs/recherche`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noBody.status, 400);
});

test('abgeschalteter Rat antwortet mit 409 statt zu laufen', async () => {
  const villa = await fetch(`${BASE}/api/villas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rat-Test', idea: 'Rat abschalten', agentCount: 3 })
  }).then((r) => r.json());
  assert.ok(villa.villaId);

  await patch('/api/packs/council', { enabled: false });
  const blocked = await fetch(`${BASE}/api/villas/${villa.villaId}/council`, { method: 'POST' });
  assert.equal(blocked.status, 409);
  const body = await blocked.json();
  assert.match(body.error, /Rat der Agenten/);

  await patch('/api/packs/council', { enabled: true });
  const again = await fetch(`${BASE}/api/villas/${villa.villaId}/council`, { method: 'POST' });
  assert.notEqual(again.status, 409, 'Rat liess sich nicht wieder einschalten');
});
