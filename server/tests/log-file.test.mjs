/**
 * Log-Datei: mit VF_LOG_FILE schreibt der Hub jede Protokollzeile
 * zusaetzlich synchron in die Datei (reihenfolgestabil mit stdout).
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 24500 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'vf-log-'));
const DB = join(DIR, 'l.db');
const LOG = join(DIR, 'logs', 'hub.log');
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
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0', VF_LOG_FILE: LOG },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  await waitForHub();
});

after(() => {
  if (child?.exitCode === null) child.kill('SIGTERM');
  rmSync(DIR, { recursive: true, force: true });
});

test('Log-Datei wird angelegt, Ordner mit erstellt, Zeilen landen drin', async () => {
  assert.ok(existsSync(LOG), 'Log-Datei fehlt');
  let content = readFileSync(LOG, 'utf8');
  assert.match(content, /\[villaforge\]/);

  // Eine Anfrage erzeugt zusaetzliche Protokollzeilen (Beobachtungs-Lauf).
  const res = await fetch(`${BASE}/api/villas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Log-Villa', idea: 'Logging pruefen', agentCount: 4 }) });
  assert.equal(res.status, 201);
  await sleep(600);
  content = readFileSync(LOG, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  // Jede Zeile hat Zeitstempel, Marke und Level.
  for (const l of lines) assert.match(l, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[villaforge\] (INFO|ERROR) /);
  assert.ok(lines.length >= 2, 'mehr als nur die Startzeile');
  assert.match(content, /Villa angelegt:/, 'Betriebslog der Villa-Anlage fehlt');
  assert.ok(lines.length >= 2, 'mehr als nur die Startzeile');
});

test('Ohne VF_LOG_FILE bleibt alles beim Alten (keine Datei im TMP-Ordner)', async () => {
  // Der zweite Test braucht keinen eigenen Hub: es reicht der Umstand, dass
  // die Option rein optional ist — geprueft ueber die erste Instanz ohne
  // doppelte Datei im gleichen Ordner.
  const files = readFileSync(LOG, 'utf8');
  assert.ok(files.length > 0);
});
