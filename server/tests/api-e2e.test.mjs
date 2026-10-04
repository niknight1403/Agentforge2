/**
 * End-to-End-Integrationstest: der echte Hub laeuft als Kindprozess auf einer
 * frischen Temp-DB und wird ausschliesslich ueber HTTP getestet, genau wie es
 * Web-UI und Android-App tun.
 *
 * Ablauf: Server starten -> Health -> Statische Dateien -> Validierungsfehler
 * -> Villa anlegen -> Detail -> Chat (Offline) -> SSE-Live-Ereignisse ->
 * Orchestrierung bis COMPLETED -> Stop -> Cleanup.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 21000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-e2e-')), 'e2e.db');
const ROOT = resolve(import.meta.dirname, '../..');

let child = null;
let sawLog = '';

function cleanup() {
  if (child && child.exitCode === null) child.kill('SIGTERM');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHub(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* noch nicht oben */ }
    await sleep(250);
  }
  throw new Error(`Hub ist nicht erreichbar. Log:\n${sawLog.slice(-800)}`);
}

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  child.on('exit', (code) => { if (code && code !== 0 && Date.now() - START < 25000) console.error('Hub endete vorzeitig mit Code', code); });
  await waitForHub();
});

const START = Date.now();

after(() => {
  cleanup();
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* tmp */ }
  }
});

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

test('Health: Server meldet Version und Routen', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.routes > 0, 'Routen-Katalog nicht geseedet');
});

test('Statisch: Index-Seite mit VillaForge-Titel', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('VillaForge'), 'Titel fehlt');
});

test('Statisch: Pfad-Ausbruch und unbekannte Datei werden abgelehnt', async () => {
  const escape = await fetch(`${BASE}/%2e%2e/%2e%2e/package.json`);
  assert.equal(escape.status, 404, 'Traversal wurde erlaubt');
  assert.notEqual((await escape.text()).length, 0);
  const missing = await fetch(`${BASE}/gibt-es-nicht.html`);
  assert.equal(missing.status, 404);
});

test('Villa-POST: Validierung greift ueber HTTP', async () => {
  const bad = await post('/api/villas', { idea: '' });
  assert.equal(bad.status, 400);
  const err = await bad.json();
  assert.ok(err.error);

  const tooMany = await post('/api/villas', { idea: 'x', agentCount: 5000 });
  assert.equal(tooMany.status, 400);

  const broken = await fetch(`${BASE}/api/villas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kein json' });
  assert.equal(broken.status, 400, 'kaputtes JSON muss 400 sein, nicht 500');
});

let villaId = null;

test('Villa anlegen: 201 mit Plan und Agenten', async () => {
  const res = await post('/api/villas', { name: 'E2E Villa', idea: 'Ein kleiner Tracker fuer Einkaufslisten', agentCount: 6 });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.villaId > 0);
  assert.ok(data.rootId > 0);
  assert.ok(data.plan.tasks.length >= 8);
  villaId = data.villaId;
});

test('Villa-Detail: Agenten, Aufgaben, Status', async () => {
  const res = await fetch(`${BASE}/api/villas/${villaId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.villa.id, villaId);
  assert.ok(data.agents.length >= 3, 'Agentenpool fehlt');
  assert.ok(data.tasks.length >= 8, 'Aufgaben fehlen');
  assert.equal(typeof data.running, 'boolean');

  const missing = await fetch(`${BASE}/api/villas/999999`);
  assert.equal(missing.status, 404);
});

test('Chat: Offline-Antwort mit Trace', async () => {
  const res = await post(`/api/villas/${villaId}/chat`, { message: 'Nenne einen ersten Schritt fuer die Einkaufsliste.' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.answer.length > 10, 'Antwort zu duenn');
  assert.equal(data.offline, true, 'ohne Key muss Offline antworten');
  assert.ok(Array.isArray(data.trace));

  const empty = await post(`/api/villas/${villaId}/chat`, { message: '' });
  assert.equal(empty.status, 400);
});

test('SSE: Live-Ereignisse treffen beim Client ein', async () => {
  // Stream OEFFNEN, bevor das Ereignis ausgeloest wird.
  const ac = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);

  const reader = stream.body.getReader();
  const seen = [];
  const readLoop = (async () => {
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try { seen.push(JSON.parse(line.slice(6))); } catch { /* Teilchunk */ }
        }
      }
    }
  })();

  // Ereignis ausloesen: Orchestrierung starten erzeugt villa- und task-Events.
  const started = await post(`/api/villas/${villaId}/orchestrate`, { concurrency: 2, maxRounds: 1 });
  assert.equal(started.status, 202);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (seen.some((e) => e.type === 'villa') || seen.some((e) => e.type === 'task')) break;
    await sleep(250);
  }
  ac.abort();
  await readLoop.catch(() => {});
  assert.ok(seen.some((e) => e.type === 'villa'), 'villa-Event fehlt im SSE-Stream');
});

test('Orchestrierung: laeuft bis COMPLETED (Offline-Modus)', async () => {
  // Der Lauf wurde im SSE-Test gestartet; auf Abschluss pollen.
  const deadline = Date.now() + 90000;
  let status = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/villas/${villaId}`);
    const data = await res.json();
    status = data.villa.status;
    if (status === 'COMPLETED' || status === 'PAUSED' || status === 'FAILED') break;
    await sleep(750);
  }
  assert.equal(status, 'COMPLETED', `Lauf endete nicht sauber (Status: ${status}). Log:\n${sawLog.slice(-600)}`);

  const detail = await (await fetch(`${BASE}/api/villas/${villaId}`)).json();
  assert.ok(detail.tasks.length > 0);
});

test('Villa-Liste ist gedeckelt und seitbar', async () => {
  // Zusaetzliche Villas ueber die echte API anlegen (Offline-Planer, schnell).
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/api/villas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Liste ${i}`, idea: 'Paginierungstest', agentCount: 3 })
    });
    assert.equal(r.status, 201);
  }
  const all = await fetch(`${BASE}/api/villas`);
  const arr = await all.json();
  assert.ok(Array.isArray(arr), 'Antwort muss ein Array bleiben');
  assert.ok(arr.length <= 50, 'Standard-Deckel 50 greift nicht');
  assert.ok(all.headers.get('x-total-count') >= 13, 'X-Total-Count fehlt');

  const small = await fetch(`${BASE}/api/villas?limit=3&offset=3`);
  const page = await small.json();
  assert.equal(page.length, 3);
  assert.equal(small.headers.get('x-limit'), '3');
  assert.equal(small.headers.get('x-offset'), '3');

  const cap = await fetch(`${BASE}/api/villas?limit=9999`);
  assert.equal(cap.headers.get('x-limit'), '200', 'Limit-Deckel greift nicht');
});

test('Orchestrate: unsinnige Parameter werden mit 400 abgelehnt', async () => {
  const bad = await post(`/api/villas/${villaId}/orchestrate`, { concurrency: 999 });
  assert.equal(bad.status, 400);
  const badRounds = await post(`/api/villas/${villaId}/orchestrate`, { maxRounds: 0 });
  assert.equal(badRounds.status, 400);
});

test('Stop-Endpunkt und sauberes Herunterfahren', async () => {
  const res = await post(`/api/villas/${villaId}/stop`, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.stopped, 'boolean');

  // Der Prozess muss noch leben und antworten.
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);
});
