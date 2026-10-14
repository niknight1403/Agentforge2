/**
 * Statische Dateien mit ETag: erster Abruf liefert 200 + ETag,
 * If-None-Match mit demselben ETag liefert 304 ohne Body,
 * ein abweichender ETag liefert wieder 200.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 21500 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-etag-')), 't.db');
const ROOT = resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let sawLog = '';

before(async () => {
  child = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { sawLog += d; });
  child.stderr.on('data', (d) => { sawLog += d; });
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Hub nicht erreichbar. Log:\n${sawLog.slice(-800)}`);
});

after(() => { if (child?.exitCode === null) child.kill('SIGTERM'); });

test('Erster Abruf: 200 mit ETag, Wiederholung: 304', async () => {
  const first = await fetch(`${BASE}/index.html`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag fehlt im ersten Abruf');
  assert.ok(first.headers.get('content-type').includes('text/html'));

  const again = await fetch(`${BASE}/index.html`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304, 'gleicher ETag muss 304 liefern');
  assert.equal(again.headers.get('etag'), etag, '304 traegt denselben ETag');
  assert.equal((await again.text()).length, 0, '304 hat keinen Body');
});

test('Abweichender ETag liefert weiterhin die Datei', async () => {
  const r = await fetch(`${BASE}/index.html`, { headers: { 'If-None-Match': '"alt-123"' } });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('<!DOCTYPE'), 'Body fehlt');
});

test('CSS und JS tragen ebenfalls ETags', async () => {
  for (const path of ['/styles.css', '/app.js', '/ui-state.js']) {
    const r = await fetch(`${BASE}${path}`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('etag'), `ETag fehlt fuer ${path}`);
  }
});

