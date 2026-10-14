/**
 * HTTP-Vertrag der neuen Endpunkte: /api/scheduler, /api/tools(/meta),
 * /api/villas/:id/project/* (fs-tools) und die Lastangaben in /api/health.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 28000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'vf-sched-'));
const PROJ = join(DIR, 'proj');
const ROOT = resolve(import.meta.dirname, '../..');
let child = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(`${BASE}${p}`);
const post = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

before(async () => {
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(join(PROJ, 'hello.txt'), 'Hallo Villa, suche mich: NADELSPITZE');
  writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node check.mjs' } }));
  writeFileSync(join(PROJ, 'check.mjs'), "console.log('gruen');");
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: join(DIR, 't.db'), VF_WORKSPACE: join(DIR, 'ws'), PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: 'ignore'
  });
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try { if ((await get('/api/health')).ok) return; } catch { /* noch nicht oben */ }
    await sleep(250);
  }
  throw new Error('Hub nicht gestartet');
});
after(() => { child?.kill(); rmSync(DIR, { recursive: true, force: true }); });

test('Health meldet Lastgrenzen und Scheduler', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.ok, true);
  assert.ok(h.llm && h.llm.max >= 1);
  assert.ok(h.cmd && h.cmd.max >= 1);
  assert.ok(h.scheduler && h.scheduler.slots >= 1);
});

test('/api/scheduler liefert Rangliste und Slots', async () => {
  const s = await (await get('/api/scheduler')).json();
  assert.ok(Array.isArray(s.ranking));
  assert.ok(s.slots >= 1);
  assert.ok(s.llm && s.cmd);
});

test('/api/tools bleibt ein Array, /api/tools/meta nennt erlaubte Befehle', async () => {
  const t = await (await get('/api/tools')).json();
  assert.ok(Array.isArray(t), 'Abwaertskompatibel: Array');
  const meta = await (await get('/api/tools/meta')).json();
  assert.ok(meta.commands.some((c) => c.startsWith('npm')));
});

test('Projekt-Werkzeuge: lesen, suchen, pruefen - und kein Ausbruch', async () => {
  const v = await (await post('/api/villas', { name: 'Proj', idea: 'Testprojekt fuer Werkzeuge', agentCount: 2 })).json();
  const id = v.villaId ?? v.id;
  assert.ok(id, 'Villa angelegt');

  // Ohne Quellprojekt: klare Fehlermeldung statt Absturz.
  assert.equal((await get(`/api/villas/${id}/project/summary`)).status, 409);

  const setSrc = await post(`/api/villas/${id}/source`, { path: PROJ });
  assert.ok(setSrc.ok, 'Quelle gesetzt');

  const tree = await (await get(`/api/villas/${id}/project/tree`)).json();
  assert.ok(JSON.stringify(tree).includes('hello.txt'));

  const found = await (await get(`/api/villas/${id}/project/search?q=NADELSPITZE`)).json();
  assert.ok(JSON.stringify(found.hits).includes('hello.txt'));

  const read = await (await get(`/api/villas/${id}/project/read?path=hello.txt`)).json();
  assert.ok(JSON.stringify(read).includes('NADELSPITZE'));

  // Ausbruchsversuch darf keinen Inhalt ausserhalb liefern.
  const evil = await get(`/api/villas/${id}/project/read?path=../../../../etc/passwd`);
  const evilText = await evil.text();
  assert.ok(!evilText.includes('root:'), 'Pfad-Ausbruch muss scheitern');

  const check = await post(`/api/villas/${id}/project/check`, { binary: 'npm', args: ['test'] });
  const out = await check.json();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.output.includes('gruen'));

  // Nicht erlaubte Programme werden abgelehnt.
  const bad = await post(`/api/villas/${id}/project/check`, { binary: 'rm', args: ['-rf', '/'] });
  assert.equal(bad.status, 422);
});
