/**
 * Opt-in live smoke test for the keyless Pollinations route.
 * Run with: VF_POLLINATIONS_LIVE=1 npm run test:pollinations
 * Uses a temporary database, strips provider credentials, and never touches production.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.VF_POLLINATIONS_LIVE !== '1') {
  console.log('SKIP: set VF_POLLINATIONS_LIVE=1 to run the external keyless-provider smoke test.');
  process.exit(0);
}

const ROOT = resolve(import.meta.dirname, '../..');
const DB = join(tmpdir(), `vf-pollinations-smoke-${process.pid}.db`);
const PORT = 20000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server/server.mjs'], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || tmpdir(),
    NODE_ENV: 'test',
    VF_TEST: '1',
    VF_DB: DB,
    PORT: String(PORT),
    VF_LLM_FREE_ONLY: '1',
    VF_LLM_TIMEOUT_MS: '20000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
let cleaned = false;
function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  child.kill('SIGTERM');
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(DB + suffix, { force: true }); } catch { /* temporary file */ }
  }
  process.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error('Hub exited before becoming healthy.');
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) { ready = true; break; }
    } catch { /* startup still in progress */ }
    await sleep(400);
  }
  if (!ready) throw new Error('Hub health endpoint did not become ready.');

  const createdResponse = await fetch(`${BASE}/api/villas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Pollinations-Live-Smoke', idea: 'Keyless inference verification', agentCount: 3 }),
    signal: AbortSignal.timeout(10000)
  });
  if (!createdResponse.ok) throw new Error(`Villa creation failed: HTTP ${createdResponse.status}`);
  const created = await createdResponse.json();
  const villaId = Number(created.villaId);
  if (!Number.isSafeInteger(villaId) || villaId <= 0) throw new Error('Villa creation returned no valid villaId.');

  const chatResponse = await fetch(`${BASE}/api/villas/${villaId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Reply with exactly: Pollinations keyless route works.' }),
    signal: AbortSignal.timeout(30000)
  });
  const result = await chatResponse.json().catch(() => null);
  if (!chatResponse.ok) throw new Error(`Chat failed: HTTP ${chatResponse.status}`);
  if (result?.offline !== false || result?.route !== 'Pollinations Text (keyless)'
      || typeof result?.answer !== 'string' || !result.answer.trim()) {
    throw new Error('No verified Pollinations answer (route, answer, offline=false) was returned.');
  }
  console.log(`PASS: ${result.route} | model=${result.model || 'unknown'} | offline=false`);
  console.log(`Answer: ${result.answer.slice(0, 180).replace(/\\s+/g, ' ')}`);
  cleanup(0);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  console.error('Hub log tail:\\n' + log.slice(-2500));
  cleanup(1);
}
