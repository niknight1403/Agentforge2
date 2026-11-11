import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    stdio: ['pipe', 'pipe', 'pipe']
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
  const runtimeInventory = await fetch(`${base}/api/system/runtime-capabilities`, { headers: auth(tokenA) });
  assert.equal(runtimeInventory.status, 403, 'non-admin users must not access runtime capability inventory');
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

  const previewDir = join(TMP, 'deep-projects', String(projectId), 'dist');
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(previewDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>');
  mkdirSync(join(previewDir, 'assets'), { recursive: true });
  writeFileSync(join(previewDir, 'assets', 'app.css'), 'body{color:#123456}');
  writeFileSync(join(previewDir, 'assets', 'app.js'), 'window.__deepPreviewSmoke = true;');

  const ownerPreview = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/index.html`, { headers: auth(tokenA) });
  assert.equal(ownerPreview.status, 200);
  assert.match(await ownerPreview.text(), /assets\/app\.css/);
  const ownerCss = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/assets/app.css`, { headers: auth(tokenA) });
  assert.equal(ownerCss.status, 200);
  assert.match(ownerCss.headers.get('content-type') || '', /text\/css/);
  assert.equal(await ownerCss.text(), 'body{color:#123456}');
  const ownerJs = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/assets/app.js`, { headers: auth(tokenA) });
  assert.equal(ownerJs.status, 200);
  assert.match(ownerJs.headers.get('content-type') || '', /javascript/);
  assert.equal(await ownerJs.text(), 'window.__deepPreviewSmoke = true;');

  const ownerList = await fetch(`${base}/api/deep/projects`, { headers: auth(tokenA) });
  assert.equal(ownerList.status, 200);
  assert.ok((await ownerList.json()).some((project) => project.id === projectId));

  const otherList = await fetch(`${base}/api/deep/projects`, { headers: auth(tokenB) });
  assert.equal(otherList.status, 200);
  assert.ok(!(await otherList.json()).some((project) => project.id === projectId));

  for (const [method, path, body] of [
    ['GET', `/api/deep/projects/${projectId}`],
    ['GET', `/api/deep/projects/${projectId}/completion`],
    ['POST', `/api/deep/projects/${projectId}/develop`, {}],
    ['POST', `/api/deep/projects/${projectId}/bootstrap`, {}],
    ['GET', `/api/deep/projects/${projectId}/preview/dist/index.html`],
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


test('HTTP SSE endpoint sanitizes authenticated users and preserves raw admin events', async (t) => {
  const suffix = String(process.pid);
  const user = createUser({ email: `sse-user-${suffix}@example.invalid`, password: 'sse-test-password', role: 'user' });
  const admin = createUser({ email: `sse-admin-${suffix}@example.invalid`, password: 'sse-test-password', role: 'admin' });
  const userToken = createSession(user.id);
  const adminToken = createSession(admin.id);
  const port = 20000 + (process.pid % 10000);
  const base = `http://127.0.0.1:${port}`;
  const script = `
    import { bus } from './server/events.mjs';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => bus.emit('event', {
      type: 'tool', ts: Date.now(), villaId: 99, tool: 'project_write',
      args: { content: 'private source code' }, prompt: 'private project prompt'
    }));
    await import('./server/server.mjs');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', VF_RESUME: '0' },
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
  assert.equal(ready, true, `SSE Hub did not become ready: ${lastError?.message || ''}\\n${output}`);

  const userAbort = new AbortController();
  const adminAbort = new AbortController();
  const userResponse = await fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${userToken}` }, signal: userAbort.signal
  });
  const adminResponse = await fetch(`${base}/api/events`, {
    headers: { Authorization: `Bearer ${adminToken}` }, signal: adminAbort.signal
  });
  assert.equal(userResponse.status, 200);
  assert.equal(adminResponse.status, 200);
  assert.match(userResponse.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(adminResponse.headers.get('content-type') || '', /text\/event-stream/);

  const nextPayload = async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream closed before test event arrived');
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (data) return JSON.parse(data.slice(5).trim());
      }
    }
  };
  const userPayloadPromise = nextPayload(userResponse);
  const adminPayloadPromise = nextPayload(adminResponse);
  const eventTimeout = setTimeout(() => { userAbort.abort(); adminAbort.abort(); }, 8000);
  child.stdin.write('emit\n');
  try {
    const [userPayload, adminPayload] = await Promise.all([userPayloadPromise, adminPayloadPromise]);
    assert.equal(userPayload.type, 'tool');
    assert.equal(userPayload.villaId, 99);
    assert.equal(userPayload.args, undefined, 'authenticated non-admin must not receive tool arguments');
    assert.equal(userPayload.prompt, undefined, 'authenticated non-admin must not receive prompts');
    assert.deepEqual(adminPayload.args, { content: 'private source code' });
    assert.equal(adminPayload.prompt, 'private project prompt');
  } finally {
    clearTimeout(eventTimeout);
    userAbort.abort();
    adminAbort.abort();
  }
});
