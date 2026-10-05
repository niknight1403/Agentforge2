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
import { VERSION } from '../version.mjs';
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

test('Stats: Zaehler und Laufzustand stimmen', async () => {
  const r = await fetch(`${BASE}/api/stats`);
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.version, VERSION, 'Stats meldet die zentrale Version');
  assert.ok(st.uptimeSec >= 0);
  assert.ok(Number.isInteger(st.villas) && st.villas >= 1, 'Villa-Zaehler fehlt');
  assert.ok(st.tasks.total >= 1, 'Aufgaben-Zaehler fehlt');
  assert.ok(Array.isArray(st.runningVillas), 'runningVillas muss Array sein');
  assert.ok(st.limits && typeof st.limits.ratePerMinute === 'number');
  const rh = st.routesHealth;
  assert.ok(rh, 'routesHealth fehlt in /api/stats');
  assert.equal(typeof rh.ok, 'number');
  assert.equal(typeof rh.fail, 'number');
  assert.ok(Array.isArray(rh.cooling), 'cooling muss Array sein');
  assert.equal(typeof rh.configured, 'number');
  assert.ok(rh.configured >= 0, 'configured darf nicht negativ sein');
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

test('SSE-Replay: Last-Event-ID liefert verpasste Ereignisse nach', { timeout: 10000 }, async () => {
  // Ereignis erzeugen, das kein verbundener Client sieht.
  const v = await post(`/api/villas`, { name: 'Replay-Villa', idea: 'SSE-Replay-Test', agentCount: 4 });
  const villa = await v.json();

  const ac = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  const reader = stream.body.getReader();
  const readOne = async () => {
    let buf = '';
    for (;;) {
      const { value } = await reader.read();
      buf += Buffer.from(value).toString('utf8');
      const m = buf.match(/^id: (\d+)\ndata: ([^\n]*)\n\n/m);
      if (m) return { id: Number(m[1]), data: JSON.parse(m[2]) };
    }
  };
  const first = await readOne();

  // Zweites Ereignis, wieder ohne Client — danach Reconnect ab first.id.
  const v2 = await post(`/api/villas`, { name: 'Nach-Reconnect', idea: 'SSE-Replay-Test 2', agentCount: 4 });
  const villa2 = await v2.json();
  const replayed = await fetch(`${BASE}/api/events`, { headers: { 'Last-Event-ID': String(first.id) } });
  const replayReader = replayed.body.getReader();
  let txt = '';
  for (;;) {
    const chunk = await Promise.race([
      replayReader.read(),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 4000))
    ]);
    if (chunk.timeout) break;
    if (chunk.done) break;
    txt += Buffer.from(chunk.value).toString('utf8');
    if (txt.includes(String(villa2.villaId))) break;
  }
  ac.abort();
  replayReader.cancel().catch(() => {});

  assert.ok(txt.includes(String(villa2.villaId)), 'verpasstes Ereignis wurde nicht nachgeliefert');
  const ids = [...txt.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
  assert.ok(ids.length >= 1 && ids.every((x) => x > first.id), 'Replay darf nur neuere Events bringen');
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

test('DELETE: Villa verschwindet sauber mitsamt Daten', async () => {
  const cr = await fetch(`${BASE}/api/villas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Weg damit', idea: 'Loeschtest', agentCount: 4 })
  });
  assert.equal(cr.status, 201);
  const villa = await cr.json();

  const del = await fetch(`${BASE}/api/villas/${villa.villaId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted, villa.villaId);

  const detail = await fetch(`${BASE}/api/villas/${villa.villaId}`);
  assert.equal(detail.status, 404, 'geloeschte Villa ist noch abrufbar');

  // Unbekannte ID: 404 statt 200.
  const miss = await fetch(`${BASE}/api/villas/999999`, { method: 'DELETE' });
  assert.equal(miss.status, 404);
});

test('Export: kompletter JSON-Download der Villa', async () => {
  const r = await fetch(`${BASE}/api/villas/${villaId}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /attachment/, 'Download-Header fehlt');
  const data = await r.json();
  assert.equal(data.app, 'VillaForge');
  assert.equal(data.villa.id, villaId);
  assert.ok(Array.isArray(data.agents) && data.agents.length >= 1);
  assert.ok(Array.isArray(data.tasks) && data.tasks.length >= 1);
  assert.ok(data.exported_at, 'Zeitstempel fehlt');

  const miss = await fetch(`${BASE}/api/villas/999999/export`);
  assert.equal(miss.status, 404);
});

test('Orchestrate: unsinnige Parameter werden mit 400 abgelehnt', async () => {
  const bad = await post(`/api/villas/${villaId}/orchestrate`, { concurrency: 999 });
  assert.equal(bad.status, 400);
  const badRounds = await post(`/api/villas/${villaId}/orchestrate`, { maxRounds: 0 });
  assert.equal(badRounds.status, 400);
});

test('Retry-Endpunkte: FAILED-Aufgaben zurueck in die Warteschlange', async () => {
  // Rein ueber HTTP: kein direkter DB-Zugriff (kein 'database is locked' in CI).
  const patch = (taskId, body) => fetch(`${BASE}/api/villas/${villaId}/tasks/${taskId}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tasksOf = async () => {
    const r = await fetch(`${BASE}/api/villas/${villaId}/tasks`);
    const d = await r.json();
    return Array.isArray(d) ? d : (d.tasks || []);
  };

  // Alle Aufgaben kuenstlich scheitern lassen (wie nach einem Offline-Durchhaenger)
  await post(`/api/villas/${villaId}/stop`, {});
  let tasks = await tasksOf();
  // Stopp settle lassen: RUNNING-Aufgaben wuerden PATCH mit 409 ablehnen.
  for (let i = 0; i < 20 && tasks.some((t0) => t0.status === 'RUNNING'); i++) {
    await sleep(150);
    tasks = await tasksOf();
  }
  assert.ok(tasks.length >= 1, 'Testvorbedingung: mindestens eine Aufgabe');
  assert.ok(!tasks.some((t0) => t0.status === 'RUNNING'), 'RUNNING-Aufgaben muessen nach Stopp settle sein');
  for (const tsk of tasks) {
    const r = await patch(tsk.id, { status: 'FAILED', result: 'offline' });
    assert.equal(r.status, 200, `PATCH auf FAILED fuer Task ${tsk.id} fehlgeschlagen`);
  }
  tasks = await tasksOf();
  assert.ok(tasks.every((t2) => t2.status === 'FAILED'), 'Alle Aufgaben muessen FAILED sein');

  // Nur-FAILED-Retry auf Nicht-FAILED ablehnen
  const r404 = await post(`/api/villas/${villaId}/tasks/999999/retry`, {});
  assert.equal(r404.status, 404);

  // Einzel-Retry: FAILED -> Warteschlange, Lauf startet (PENDING oder schon RUNNING)
  const taskId = tasks[0].id;
  const r1 = await post(`/api/villas/${villaId}/tasks/${taskId}/retry`, {});
  assert.equal(r1.status, 202);
  assert.equal((await r1.json()).requeued, true);
  // Retry-Ereignisse landen im Audit-Protokoll (Nachvollziehbarkeit).
  const log = await fetch(`${BASE}/api/villas/${villaId}/audit?limit=100`);
  const auditBody = await log.json();
  const entries = Array.isArray(auditBody) ? auditBody : (auditBody.entries || []);
  assert.ok(entries.some((e) => e.tool === 'retry_task'), 'Einzel-Retry muss im Audit stehen');
  assert.ok(JSON.stringify(entries).includes(String(taskId)), 'Audit muss die Task-Id nennen');
  await post(`/api/villas/${villaId}/stop`, {});
  const st1 = (await tasksOf()).find((t3) => t3.id === taskId)?.status;
  assert.ok(['PENDING', 'RUNNING', 'DONE'].includes(st1), `Status nach Retry unklar: ${st1}`);

  // Noch eine Aufgabe FAILED setzen (der Lauf kann einige erledigt haben)
  await post(`/api/villas/${villaId}/stop`, {});
  tasks = await tasksOf();
  for (const tsk of tasks.filter((t4) => t4.status === 'DONE')) {
    await patch(tsk.id, { status: 'FAILED', result: 'offline' });
  }
  const r2 = await post(`/api/villas/${villaId}/retry-failed`, {});
  assert.equal(r2.status, 202);
  const body2 = await r2.json();
  assert.ok(Number(body2.requeued) >= 1, 'retry-failed muss mindestens eine Aufgabe requeueen');
  const log2 = await fetch(`${BASE}/api/villas/${villaId}/audit?limit=100`);
  const ab2 = await log2.json();
  const entries2 = Array.isArray(ab2) ? ab2 : (ab2.entries || []);
  assert.ok(entries2.some((e) => e.tool === 'retry_failed'), 'Sammel-Retry muss im Audit stehen');
  await post(`/api/villas/${villaId}/stop`, {});
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
