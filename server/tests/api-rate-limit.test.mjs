/**
 * Rate-Limit fuer schreibende Anfragen: ein eigener Hub mit
 * VF_RATE_LIMIT=5 muss nach fuenf Schreibvorgaengen pro Minute mit 429
 * abweisen, GET bleibt frei.
 */
import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 12901;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), 'vf-rate-')), 'hub.db');
const NODE = process.execPath;

let hub;
let hubLog = '';
before(async () => {
  hub = spawn(process.execPath, [...process.execArgv, 'server/server.mjs'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: { ...process.env, VF_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', VF_RESUME: '0', VF_RATE_LIMIT: '5' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  hub.stdout.on('data', (d) => { hubLog += d; });
  hub.stderr.on('data', (d) => { hubLog += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Hub ist nicht hochgefahren. Log:\n${hubLog.slice(-800)}`);
});

after(() => hub?.kill());

test('Schreibende Anfragen werden nach dem Limit mit 429 abgewiesen', async () => {
  // Fuenf Schreibvorgaenge gehen durch (kleine ungueltige Bodies reichen),
  // der sechste fliegt raus, GET bleibt frei.
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${BASE}/api/villas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: '' })
    });
    if (r.status === 429) {
      saw429 = true;
      assert.ok(r.headers.get('retry-after'), 'Retry-After fehlt');
      break;
    }
    assert.ok([400, 201].includes(r.status), `unerwartet: ${r.status}`);
  }
  assert.ok(saw429, 'Limit wurde nie erreicht — Deckel greift nicht');

  const get = await fetch(`${BASE}/api/health`);
  assert.equal(get.status, 200, 'GET wurde mit-limitiert');
});
