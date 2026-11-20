import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP } from './_env.mjs';
import { createUser, createSession, destroyToken } from '../auth.mjs';

test('DeepAgent endpoints require login and isolate projects, chat and files by owner', async (t) => {
  const userA = createUser({ email: 'deepagent-owner-a@example.invalid', password: 'test-only-password-a', role: 'user' });
  const userB = createUser({ email: 'deepagent-owner-b@example.invalid', password: 'test-only-password-b', role: 'user' });
  const unlimitedUser = createUser({ email: 'deepagent-unlimited@example.invalid', password: 'test-only-unlimited-password', role: 'user', isUnlimited: true });
  const adminUser = createUser({ email: 'deepagent-admin@example.invalid', password: 'test-only-admin-password', role: 'admin' });
  const tokenA = createSession(userA.id);
  const tokenB = createSession(userB.id);
  const unlimitedToken = createSession(unlimitedUser.id);
  const adminToken = createSession(adminUser.id);
  process.env.DEEP_DIR = join(TMP, 'deep-projects');
  const port = 18000 + (process.pid % 10000);
  const base = `http://127.0.0.1:${port}`;
  const script = [
    "import { db } from './server/db.mjs';",
    "import { linkDeepProjectVilla } from './server/deepagent.mjs';",
    "import { insertAgent } from './server/agents.mjs';",
    "import { createPersona } from './server/persona-packs.mjs';",
    "process.stdin.setEncoding('utf8');",
    "let pending = '';",
    "process.stdin.on('data', (chunk) => {",
    "  pending += chunk;",
    "  let newline;",
    "  while ((newline = pending.indexOf('\\n')) >= 0) {",
    "    const line = pending.slice(0, newline);",
    "    pending = pending.slice(newline + 1);",
    "    if (!line) continue;",
    "    try {",
    "      const command = JSON.parse(line);",
    "      if (command.type === 'linkVilla') {",
    "        const ts = Date.now();",
    "        const id = Number(db.prepare('INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('Deep · Private Project A', 'Private project idea belonging to user A', 'PLANNING', 12, 1, ts, ts).lastInsertRowid);",
    "        linkDeepProjectVilla(Number(command.projectId), id);",
    "        const agentId = insertAgent(id, 'Private Agent A', 'WORKER');",
    "        const personaId = createPersona(id, {name: 'Private Persona A'}).id;",
    "        process.stdout.write('__TEST_VILLA_LINKED__' + id + ':' + agentId + ':' + personaId + '\\n');",
    "      }",
    "    } catch (error) { process.stdout.write('__TEST_VILLA_ERROR__' + String(error.message || error) + '\\n'); }",
    "  }",
    "});",
    "await import('./server/server.mjs');"
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
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
  const unlimitedInventory = await fetch(`${base}/api/system/runtime-capabilities`, { headers: auth(unlimitedToken) });
  assert.equal(unlimitedInventory.status, 403, 'unlimited billing quota must not grant administrator access');
  const adminInventory = await fetch(`${base}/api/system/runtime-capabilities`, { headers: auth(adminToken) });
  assert.equal(adminInventory.status, 200, 'administrator role must access the runtime capability inventory');
  const adminInventoryBody = await adminInventory.json();
  assert.ok(Array.isArray(adminInventoryBody.capabilities));
  assert.match(adminInventoryBody.note, /not proof/i, 'inventory availability must not be presented as product verification');
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

  let privateAgentId = 0;
  let privatePersonaId = 0;
  const villaId = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`Test Villa insert timed out: ${output}`));
    }, 3000);
    const onData = () => {
      const linked = /__TEST_VILLA_LINKED__([0-9]+):([0-9]+):([0-9]+)/.exec(output);
      const failed = /__TEST_VILLA_ERROR__(.*)/.exec(output);
      if (linked) {
        privateAgentId = Number(linked[2]);
        privatePersonaId = Number(linked[3]);
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve(Number(linked[1]));
      } else if (failed) { clearTimeout(timeout); child.stdout.off('data', onData); reject(new Error(failed[1])); }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ type: 'linkVilla', projectId }) + '\n');
  });
  const ownerVillas = await fetch(`${base}/api/villas`, { headers: auth(tokenA) }).then((response) => response.json());
  const otherVillas = await fetch(`${base}/api/villas`, { headers: auth(tokenB) }).then((response) => response.json());
  const adminVillas = await fetch(`${base}/api/villas`, { headers: auth(adminToken) }).then((response) => response.json());
  assert.ok(ownerVillas.some((villa) => Number(villa.id) === villaId), 'project owner can see the linked Villa');
  assert.ok(!otherVillas.some((villa) => Number(villa.id) === villaId), 'another user cannot discover the private Villa or idea');
  assert.ok(adminVillas.some((villa) => Number(villa.id) === villaId), 'administrators retain access to linked Villen');
  const ownerVillaDetail = await fetch(`${base}/api/villas/${villaId}`, { headers: auth(tokenA) });
  const otherVillaDetail = await fetch(`${base}/api/villas/${villaId}`, { headers: auth(tokenB) });
  assert.equal(ownerVillaDetail.status, 200, 'project owner can read the linked Villa detail');
  assert.equal(otherVillaDetail.status, 404, 'another user cannot read private Villa detail by guessing its id');
  const otherStudio = await fetch(base + '/api/studio/villas/' + villaId, {headers: auth(tokenB)});
  assert.equal(otherStudio.status, 404, 'private Villa studio data is owner-scoped');
  const otherAgentChat = await fetch(base + '/api/agents/' + privateAgentId + '/chat', {
    method: 'POST',
    headers: {...auth(tokenB), 'Content-Type': 'application/json'},
    body: JSON.stringify({message: 'read private Villa agent'})
  });
  assert.equal(otherAgentChat.status, 404, 'another user cannot chat with an agent in a private Villa');
  const otherCast = await fetch(base + '/api/cast?villaId=' + villaId, {headers: auth(tokenB)});
  assert.equal(otherCast.status, 404, 'private cast overview is owner-scoped');
  const otherPersona = await fetch(base + '/api/personas/' + privatePersonaId, {headers: auth(tokenB)});
  assert.equal(otherPersona.status, 404, 'private persona details are owner-scoped');
  const otherEvolution = await fetch(base + '/api/evolution/villas/' + villaId, {headers: auth(tokenB)});
  assert.equal(otherEvolution.status, 404, 'private Villa evolution state is owner-scoped');
  const otherTelemetry = await fetch(base + '/api/metrics/telemetry?villaId=' + villaId, {headers: auth(tokenB)});
  assert.equal(otherTelemetry.status, 404, 'private Villa telemetry is owner-scoped');
  const numericAliasDetail = await fetch(`${base}/api/villas/${villaId}e0`, { headers: auth(tokenB) });
  const numericAliasReport = await fetch(`${base}/api/villas/${villaId}e0/reports`, { headers: auth(tokenB) });
  assert.equal(numericAliasDetail.status, 404, 'non-canonical numeric aliases cannot bypass Villa ownership checks');
  assert.equal(numericAliasReport.status, 404, 'report handlers use the same validated Villa id');

  const ownerStats = await fetch(`${base}/api/stats`, { headers: auth(tokenA) }).then((response) => response.json());
  const otherStats = await fetch(`${base}/api/stats`, { headers: auth(tokenB) }).then((response) => response.json());
  const adminStats = await fetch(`${base}/api/stats`, { headers: auth(adminToken) }).then((response) => response.json());
  assert.ok(ownerStats.maturity.some((villa) => Number(villa.villaId) === villaId));
  assert.ok(!otherStats.maturity.some((villa) => Number(villa.villaId) === villaId), 'stats must not reveal another owner\'s Villa name or id');
  assert.ok(adminStats.maturity.some((villa) => Number(villa.villaId) === villaId), 'administrators retain full stats visibility');

  const previewDir = join(TMP, 'deep-projects', String(projectId), 'dist');
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(previewDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script><script type="module" src="//cdn.example.test/app.js"></script></body></html>');
  mkdirSync(join(previewDir, 'assets'), { recursive: true });
  writeFileSync(join(previewDir, 'assets', 'app.css'), "body{color:#123456}.hero{background-image:url('/assets/hero.png')}@import '/assets/theme.css';");
  writeFileSync(join(previewDir, 'assets', 'app.js'), 'window.__deepPreviewSmoke = true;');

  const previewPath = `${base}/api/deep/projects/${projectId}/preview/dist/assets/app.js`;
  const previewPreflight = await fetch(previewPath, {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization'
    }
  });
  assert.equal(previewPreflight.status, 204);
  assert.equal(previewPreflight.headers.get('access-control-allow-origin'), '*');
  assert.match(previewPreflight.headers.get('access-control-allow-headers') || '', /authorization/i);
  const anonymousPreview = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/index.html`);
  assert.equal(anonymousPreview.status, 401, 'public CORS preflight must not make the actual preview public');
  const otherPreview = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/index.html`, { headers: auth(tokenB) });
  assert.equal(otherPreview.status, 404, 'a different project owner cannot access this preview');

  const ownerPreview = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/index.html`, { headers: auth(tokenA) });
  assert.equal(ownerPreview.status, 200);
  assert.equal(ownerPreview.headers.get('access-control-allow-origin'), '*');
  const ownerHtml = await ownerPreview.text();
  assert.match(ownerHtml, /assets\/app\.css/);
  assert.match(ownerHtml, /src="assets\/app\.js"/);
  assert.match(ownerHtml, /src="\/\/cdn\.example\.test\/app\.js"/, 'protocol-relative CDN URLs must remain unchanged');
  const ownerCss = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/assets/app.css`, { headers: auth(tokenA) });
  assert.equal(ownerCss.status, 200);
  assert.match(ownerCss.headers.get('content-type') || '', /text\/css/);
  const ownerCssText = await ownerCss.text();
  assert.match(ownerCssText, /url\(['"]?\/api\/deep\/projects\/\d+\/preview\/dist\/assets\/hero\.png['"]?\)/);
  assert.match(ownerCssText, /@import ['"]\/api\/deep\/projects\/\d+\/preview\/dist\/assets\/theme\.css['"]/);

  // Root-level assets are their own preview root; do not duplicate the assets/ segment.
  const rootAssetsDir = join(TMP, 'deep-projects', String(projectId), 'assets');
  mkdirSync(rootAssetsDir, { recursive: true });
  writeFileSync(join(rootAssetsDir, 'app.css'), "body{background:url('/assets/root-hero.png')}@import '/assets/root-theme.css';");
  writeFileSync(join(rootAssetsDir, 'root-hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(rootAssetsDir, 'root-theme.css'), 'body{color:#123456}');
  const rootCss = await fetch(`${base}/api/deep/projects/${projectId}/preview/assets/app.css`, { headers: auth(tokenA) });
  assert.equal(rootCss.status, 200);
  const rootCssText = await rootCss.text();
  assert.match(rootCssText, /url\(['"]?\/api\/deep\/projects\/\d+\/preview\/assets\/root-hero\.png['"]?\)/);
  assert.match(rootCssText, /@import ['"]\/api\/deep\/projects\/\d+\/preview\/assets\/root-theme\.css['"]/);
  assert.doesNotMatch(rootCssText, /\/preview\/assets\/assets\//);
  const rootHero = await fetch(`${base}/api/deep/projects/${projectId}/preview/assets/root-hero.png`, { headers: auth(tokenA) });
  assert.equal(rootHero.status, 200);

  const ownerJs = await fetch(`${base}/api/deep/projects/${projectId}/preview/dist/assets/app.js`, { headers: auth(tokenA) });
  assert.equal(ownerJs.status, 200);
  assert.match(ownerJs.headers.get('content-type') || '', /javascript/);
  assert.equal(ownerJs.headers.get('access-control-allow-origin'), '*');
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

  // Deleting the Deep project must not turn its surviving Villa into shared data.
  const ownerVillaAfterDelete = await fetch(`${base}/api/villas/${villaId}`, { headers: auth(tokenA) });
  const otherVillaAfterDelete = await fetch(`${base}/api/villas/${villaId}`, { headers: auth(tokenB) });
  assert.equal(ownerVillaAfterDelete.status, 200, 'the original owner retains access to the surviving Villa');
  assert.equal(otherVillaAfterDelete.status, 404, 'deleting the project must not expose its Villa to another user');

  const ownerVillasAfterDelete = await fetch(`${base}/api/villas`, { headers: auth(tokenA) }).then((response) => response.json());
  const otherVillasAfterDelete = await fetch(`${base}/api/villas`, { headers: auth(tokenB) }).then((response) => response.json());
  assert.ok(ownerVillasAfterDelete.some((villa) => Number(villa.id) === villaId));
  assert.ok(!otherVillasAfterDelete.some((villa) => Number(villa.id) === villaId));
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
    import { userStore } from './server/auth.mjs';
    process.stdin.setEncoding('utf8');
    const eventId = 'sse-revocation-probe';
    process.stdin.on('data', () => userStore.run({ id: 999, role: 'ADMIN' }, () => bus.emit('event', {
      type: 'tool', ts: Date.now(), villaId: 99, taskId: eventId, tool: 'project_write',
      args: { content: 'private source code' }, prompt: 'private project prompt'
    })));
    await import('./server/server.mjs');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', VF_RESUME: '0' },
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

  const createPayloadReader = (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingFrames = [];
    return async (predicate = () => true) => {
      while (true) {
        if (pendingFrames.length) {
          const frame = pendingFrames.shift();
          const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
          if (data) {
            const payload = JSON.parse(data.slice(5).trim());
            if (predicate(payload)) return payload;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream closed before test event arrived');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        pendingFrames.push(...frames);
      }
    };
  };
  const nextUserPayload = createPayloadReader(userResponse);
  const nextAdminPayload = createPayloadReader(adminResponse);
  const eventId = 'sse-revocation-probe';
  const isProbeEvent = (payload) => payload.taskId === eventId;
  const userPayloadPromise = nextUserPayload(isProbeEvent);
  const adminPayloadPromise = nextAdminPayload(isProbeEvent);
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

    destroyToken(adminToken);
    const revokedAdminPayloadPromise = nextAdminPayload(isProbeEvent);
    child.stdin.write('emit\n');
    const revokedAdminPayload = await revokedAdminPayloadPromise;
    assert.equal(revokedAdminPayload.args, undefined, 'revoked admin sessions must stop receiving raw tool arguments');
    assert.equal(revokedAdminPayload.prompt, undefined, 'revoked admin sessions must stop receiving raw prompts');
  } finally {
    clearTimeout(eventTimeout);
    userAbort.abort();
    adminAbort.abort();
  }
});
