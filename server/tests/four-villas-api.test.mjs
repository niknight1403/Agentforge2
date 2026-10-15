import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 30000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'vf-four-villas-'));
const ROOT = resolve(import.meta.dirname, '../..');
let child;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: join(DIR, 'four.db'), VF_WORKSPACE: join(DIR, 'workspace'), VF_VILLA_SLOTS: '2', VF_RATE_WAIT_MS: '1', PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* startet noch */ }
    await sleep(100);
  }
  throw new Error('Hub nicht gestartet');
});
after(() => { child?.kill('SIGTERM'); rmSync(DIR, { recursive: true, force: true }); });

test('Vier Villen inklusive Filmstudio werden slotbegrenzt eingereiht', async () => {
  const ideas = [
    ['Filmstudio', 'Ein digitales Filmstudio für Drehbuch, Produktionsplanung, Schnitt und Veröffentlichung.'],
    ['Produktstudio', 'Ein kleines Produkt mit validierter Zielgruppe und klarer Roadmap bauen.'],
    ['Analysewerkstatt', 'Ein bestehendes Konzept analysieren und mit Tests verbessern.'],
    ['Marketingstudio', 'Eine Kampagne planen, messen und iterativ optimieren.']
  ];
  const villas = [];
  for (const [name, idea] of ideas) {
    const response = await post('/api/villas', { name, idea, agentCount: 3 });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    villas.push(body.villaId);
  }
  const starts = [];
  for (const id of villas) {
    const response = await post(`/api/villas/${id}/orchestrate`, { concurrency: 4, maxTasks: 12, maxRounds: 1 });
    assert.equal(response.status, 202);
    starts.push(await response.json());
  }
  const queuedStart = starts.filter((s) => s.queued).length;
  assert.ok(queuedStart >= 1, `mindestens eine Villa muss warten: ${JSON.stringify(starts)}`);
  const scheduler = await (await fetch(`${BASE}/api/scheduler`)).json();
  assert.ok(scheduler.active.length <= 2, `aktive Villen überschreiten Slotlimit: ${JSON.stringify(scheduler)}`);
  assert.ok(scheduler.queued >= 0);
  assert.ok(villas.includes(starts[0].scheduler.active[0]) || starts[0].started, 'erste Villa wurde nicht gestartet');
  for (const id of villas) await post(`/api/villas/${id}/stop`, {});
});
