import './_env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vf-openhands-api-'));
const port = 37000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      VF_DB: join(dir, 'hub.db'),
      VF_WORKSPACE: join(dir, 'work'),
      HOST: '127.0.0.1',
      PORT: String(port),
      VF_RESUME: '0',
      VF_OPEN_MODE: '1',
      OPENHANDS_CANVAS_URL: 'https://canvas.example.test/canvas#private-fragment'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Hub startup failed');
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(() => { child.kill('SIGKILL'); r(); }, 1500).unref();
    });
  }
  rmSync(dir, { recursive: true, force: true });
});

test('OpenHands Canvas integration endpoint returns a sanitized, configured browser URL', async () => {
  const response = await fetch(`${base}/api/integrations/openhands`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    enabled: true,
    url: 'https://canvas.example.test/canvas',
    state: 'configured'
  });
});
