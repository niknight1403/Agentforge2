import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agentforge2LlmRouteClient } from '../free-route-client.mjs';
const route = { id: 1, name: 'local', provider: 'ollama', model: 'qwen', enabled: true, available: true, priority: 1, status: 'OK', successes: 1, failures: 0, cooldownUntil: 0 };
const body = { mode: 'FREE_ONLY', routes: [route] };
test('reads canonical API only; expires routes and invalidates on refresh failure', async () => {
  let now = 1000, fail = false;
  const client = new Agentforge2LlmRouteClient({ baseUrl: 'https://example.org', token: 'test-token', freshnessMs: 10, clock: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/free-routes'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      if (fail) throw new Error('secret-provider-message');
      return { ok: true, json: async () => body };
    } });
  assert.deepEqual(client.availableProviders(), []);
  await client.refresh(); assert.equal(client.availableProviders().length, 1);
  const copy = client.getSnapshot(); copy.routes[0].enabled = false;
  assert.equal(client.availableProviders().length, 1);
  now += 10; assert.deepEqual(client.availableProviders(), []);
  await client.refresh(); fail = true;
  await assert.rejects(client.refresh(), /Route snapshot refresh failed/);
  assert.deepEqual(client.availableProviders(), []);
});
test('rejects unsafe origins, budgets, duplicate or paid snapshots', async () => {
  for (const baseUrl of ['http://remote.test', 'https://user:pass@example.org', 'file:///tmp/a']) assert.throws(() => new Agentforge2LlmRouteClient({ baseUrl }));
  assert.throws(() => new Agentforge2LlmRouteClient({ baseUrl: 'https://example.org', timeoutMs: 0 }));
  for (const data of [{ ...body, mode: 'PAID' }, { ...body, routes: [route, route] }, { ...body, routes: [{ ...route, enabled: 'yes' }] }]) {
    const client = new Agentforge2LlmRouteClient({ baseUrl: 'http://[::1]', fetchImpl: async () => ({ ok: true, json: async () => data }) });
    await assert.rejects(client.refresh()); assert.deepEqual(client.availableProviders(), []);
  }
});
test('coalesces concurrent refresh without sharing mutable snapshots', async () => {
  let count = 0;
  const client = new Agentforge2LlmRouteClient({ baseUrl: 'https://example.org', fetchImpl: async () => { count++; return { ok: true, json: async () => body }; } });
  const [a, b] = await Promise.all([client.refresh(), client.refresh()]);
  assert.equal(count, 1); a.routes.length = 0; assert.equal(b.routes.length, 1);
});
test('real HTTP transport rejects redirects and honors timeout', async () => {
  let mode = 'ok';
  const server = createServer((req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { location: '/other' }); res.end(); return; }
    assert.equal(req.url, '/api/free-routes');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new Agentforge2LlmRouteClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 200 });
    await client.refresh(); assert.equal(client.availableProviders().length, 1);
    mode = 'redirect'; await assert.rejects(client.refresh()); assert.equal(client.getSnapshot().stale, true);
    mode = 'timeout'; await assert.rejects(client.refresh());
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
