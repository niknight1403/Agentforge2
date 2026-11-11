import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('DeepAgent private HTTP endpoints reject unauthenticated requests', async (t) => {
  const port = 18000 + (process.pid % 10000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      VF_ADMIN_EMAIL: 'deepagent-auth-test@example.invalid',
      VF_ADMIN_PASSWORD: 'test-only-password-never-reused',
      VF_RESUME: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  });

  let ready = false;
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, `Hub did not become ready: ${lastError?.message || ''}\n${output}`);

  const requests = [
    ['GET', '/api/deep/projects'],
    ['POST', '/api/deep/projects'],
    ['POST', '/api/deep/projects/1/chat']
  ];
  for (const [method, path] of requests) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined
    });
    assert.equal(response.status, 401, `${method} ${path} should require login`);
    assert.match((await response.json()).error, /Login erforderlich/i);
  }
});
