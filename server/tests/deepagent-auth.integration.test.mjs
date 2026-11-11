import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { TMP } from './_env.mjs';
import { createUser, createSession } from '../auth.mjs';

test('DeepAgent endpoints require login and isolate projects, chat and files by owner', async (t) => {
  const userA = createUser({ email: 'deepagent-owner-a@example.invalid', password: 'test-only-password-a', role: 'user' });
  const userB = createUser({ email: 'deepagent-owner-b@example.invalid', password: 'test-only-password-b', role: 'user' });
  const tokenA = createSession(userA.id);
  const tokenB = createSession(userB.id);
  process.env.DEEP_DIR = join(TMP, 'deep-projects');
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
  assert.equal(ready, true, `Hub did not become ready: ${lastError?.message || ''}\\n${output}`);

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  for (const [method, path] of [
    ['GET', '/api/deep/projects'],
    ['POST', '/api/deep/projects'],
    ['POST', '/api/deep/projects/1/chat']
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined
    });
    assert.equal(response.status, 401, `${method} ${path} should require login`);
  }

  const createdResponse = await fetch(`${base}/api/deep/projects`, {
    method: 'POST',
    headers: { ...auth(tokenA), 'Content-Type': 'application/json' },
    body: JSON.stringify({ idea: 'Eine private Projekt-App mit getrennten Benutzerbereichen' })
  });
  const createdText = await createdResponse.text();
  assert.equal(createdResponse.status, 200, createdText);
  const created = JSON.parse(createdText);
  assert.ok(created.id > 0);
  const projectId = created.id;

  const ownerList = await fetch(`${base}/api/deep/projects`, { headers: auth(tokenA) });
  assert.equal(ownerList.status, 200);
  assert.ok((await ownerList.json()).some((project) => project.id === projectId));

  const otherList = await fetch(`${base}/api/deep/projects`, { headers: auth(tokenB) });
  assert.equal(otherList.status, 200);
  assert.ok(!(await otherList.json()).some((project) => project.id === projectId));

  for (const [method, path, body] of [
    ['GET', `/api/deep/projects/${projectId}`],
    ['GET', `/api/deep/projects/${projectId}/completion`],
    ['POST', `/api/deep/projects/${projectId}/chat`, { message: 'Fremdes Projekt lesen' }],
    ['POST', `/api/deep/projects/${projectId}/files`, { name: 'leak.txt', mime: 'text/plain', data: Buffer.from('secret').toString('base64') }],
    ['DELETE', `/api/deep/projects/${projectId}`]
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { ...auth(tokenB), 'Content-Type': 'application/json' } : auth(tokenB),
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status, 404, `User B must not access ${method} ${path}`);
  }

  const upload = await fetch(`${base}/api/deep/projects/${projectId}/files`, {
    method: 'POST',
    headers: { ...auth(tokenA), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'private.txt', mime: 'text/plain', data: Buffer.from('owner-only').toString('base64') })
  });
  assert.equal(upload.status, 200);
  const file = await upload.json();
  const ownerFile = await fetch(`${base}${file.url}`, { headers: auth(tokenA) });
  assert.equal(ownerFile.status, 200);
  assert.equal(await ownerFile.text(), 'owner-only');
  const otherFile = await fetch(`${base}${file.url}`, { headers: auth(tokenB) });
  assert.equal(otherFile.status, 404);

  const ownerDetail = await fetch(`${base}/api/deep/projects/${projectId}`, { headers: auth(tokenA) });
  assert.equal(ownerDetail.status, 200);
  const otherDelete = await fetch(`${base}/api/deep/projects/${projectId}`, { method: 'DELETE', headers: auth(tokenB) });
  assert.equal(otherDelete.status, 404);
  const ownerDelete = await fetch(`${base}/api/deep/projects/${projectId}`, { method: 'DELETE', headers: auth(tokenA) });
  assert.equal(ownerDelete.status, 200);
});
