/**
 * Villa-Import: ein Export-JSON (GET /api/villas/:id/export) wird per
 * POST /api/villas/import als neue Villa angelegt — mit neuen IDs,
 * harten Mengenbegrenzungen und intakten Verknuepfungen
 * (parent_id, agent_id) ueber eine ID-Map.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 21500 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-import-')), 'imp.db');
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

test('Gueltiger Import: neue Villa mit Agenten, Aufgaben, Gedaechtnis, Berichten', async () => {
  const payload = {
    exported_at: 1700000000000,
    app: 'VillaForge',
    version: '1.4.0',
    villa: { id: 42, name: 'Alte Villa', idea: 'Eine Test-Idee', status: 'COMPLETED', max_agents: 50, source_path: '' },
    agents: [
      { id: 10, name: 'DeepAgent', role: 'ROOT', is_root: 1, system_prompt: 'sei klug', autonomy_level: 5 },
      { id: 11, name: 'Worker-001', role: 'WORKER', parent_id: 10 },
      { id: 12, name: 'Builder-002', role: 'BUILDER', parent_id: 11 }
    ],
    tasks: [
      { id: 1, villa_id: 42, agent_id: 11, title: 'Setup', description: 'Repo aufsetzen', status: 'DONE', priority: 3, result: 'ok', created_at: 1700000000000, updated_at: 1700000001000 },
      { id: 2, villa_id: 42, agent_id: 12, title: 'Tests', description: 'Tests schreiben', status: 'PENDING', priority: 4 }
    ],
    memories: [{ id: 5, villa_id: 42, agent_id: 10, scope: 'villa', kind: 'DECISION', title: 'Projektplan', content: 'Plan A', importance: 9 }],
    reports: [{ id: 7, villa_id: 42, kind: 'ANALYSIS', title: 'Analyse', content: 'Alles gut', data: '' }],
    messages: [
      { id: 1, villa_id: 42, agent_id: 10, role: 'user', content: 'Hallo', created_at: 1700000002000 },
      { id: 2, villa_id: 42, agent_id: 10, role: 'assistant', content: 'Hi!', created_at: 1700000003000 }
    ]
  };
  const res = await fetch(`${BASE}/api/villas/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.ok(Number.isInteger(out.villaId) && out.villaId > 0);
  assert.equal(out.counts.agents, 3);
  assert.equal(out.counts.tasks, 2);
  assert.equal(out.counts.memories, 1);
  assert.equal(out.counts.reports, 1);
  assert.equal(out.counts.messages, 2);

  // Detail pruefen: alles verknuepft, Status/Texte erhalten.
  const det = await (await fetch(`${BASE}/api/villas/${out.villaId}`)).json();
  assert.equal(det.villa.name, 'Alte Villa');
  assert.equal(det.villa.status, 'CREATED');
  assert.equal(det.agents.length, 3);
  const root = det.agents.find((a) => a.is_root === 1);
  assert.ok(root, 'Wurzel-Agent fehlt');
  assert.equal(root.system_prompt, 'sei klug');
  assert.equal(det.agents.filter((a) => a.is_root === 1).length, 1, 'nur ein Wurzel-Agent');
  assert.equal(det.tasks.length, 2);
  assert.equal(det.tasks.find((t) => t.title === 'Setup').status, 'DONE');
  const importedTask = det.tasks.find((t) => t.title === 'Tests');
  assert.ok(importedTask.agent_id, 'agent_id sollte gemappt sein');
  assert.equal(det.memories[0].title, 'Projektplan');
  assert.equal(det.reports.length, 1);

  // Nachrichten landen beim (neuen) Wurzel-Agent.
  const msgs = await (await fetch(`${BASE}/api/villas/${out.villaId}/messages`)).json();
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((x) => x.agent_id === root.id));
});

test('Name-Override beim Import', async () => {
  const payload = { villa: { name: 'Original', idea: 'Idee 2' }, agents: [], tasks: [], memories: [], reports: [], messages: [] };
  const res = await fetch(`${BASE}/api/villas/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, name: 'Neuer Name' })
  });
  assert.equal(res.status, 201);
  const out = await res.json();
  const det = await (await fetch(`${BASE}/api/villas/${out.villaId}`)).json();
  assert.equal(det.villa.name, 'Neuer Name');
  assert.equal(det.agents.length, 1, 'ohne Agenten im Export wird ein Wurzel-Agent angelegt');
});

test('Ungueltiges Format: 400 mit klarer Meldung', async () => {
  const r1 = await fetch(`${BASE}/api/villas/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ foo: 1 }) });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /villa-Objekt fehlt/);

  const r2 = await fetch(`${BASE}/api/villas/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ villa: { name: 'X' } }) });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /idea fehlt/);
});

test('Kein Wurzel-Agent im Import → DeepAgent wird angelegt', async () => {
  const payload = {
    villa: { name: 'Ohne Root', idea: 'Idee 3' },
    agents: [{ id: 3, name: 'Nur-Worker', role: 'WORKER' }],
    tasks: [], memories: [], reports: [], messages: []
  };
  const res = await fetch(`${BASE}/api/villas/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  assert.equal(res.status, 201);
  const out = await res.json();
  const det = await (await fetch(`${BASE}/api/villas/${out.villaId}`)).json();
  assert.equal(det.agents.length, 2);
  assert.ok(det.agents.some((a) => a.is_root === 1 && a.name === 'DeepAgent'));
});
