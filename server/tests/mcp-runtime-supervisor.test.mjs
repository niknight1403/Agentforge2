import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpRuntimeSupervisor } from '../mcp-runtime-supervisor.mjs';

function fakeAdapter(serverId, onClose = () => {}) {
  return {
    serverId,
    async listTools() { return { tools: [] }; },
    async callTool() { return {}; },
    async close() { onClose(); },
  };
}

test('runtime supervisor starts once, discovers tools, and reuses an existing connection', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let connects = 0;
  let discoveries = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async ({ serverId }) => { connects += 1; return fakeAdapter(serverId); },
    discover: async ({ serverId, client }) => {
      assert.equal(serverId, 'one');
      assert.equal(client.serverId, 'one');
      discoveries += 1;
      servers.set('one', { ...servers.get('one'), status: 'active' });
    },
  });

  const first = await supervisor.startServer('one');
  const second = await supervisor.startServer('one');
  assert.equal(first, second);
  assert.equal(connects, 1);
  assert.equal(discoveries, 1);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, ['one']);
  assert.equal((await supervisor.closeAll()).closed, 1);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});

test('runtime supervisor rejects disabled, missing and unsupported servers', async () => {
  const servers = new Map([
    ['disabled', { id: 'disabled', transport: 'stdio', status: 'disabled' }],
    ['remote', { id: 'remote', transport: 'http', status: 'pending' }],
  ]);
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async ({ serverId }) => fakeAdapter(serverId),
    discover: async () => {},
  });
  await assert.rejects(supervisor.startServer('missing'), { code: 'MCP_SERVER_NOT_FOUND' });
  await assert.rejects(supervisor.startServer('disabled'), { code: 'MCP_SERVER_DISABLED' });
  await assert.rejects(supervisor.startServer('remote'), { code: 'MCP_TRANSPORT_UNSUPPORTED' });
});

test('runtime supervisor enforces the concurrency limit across connected and starting runtimes', async () => {
  const servers = new Map([
    ['one', { id: 'one', transport: 'stdio', status: 'pending' }],
    ['two', { id: 'two', transport: 'stdio', status: 'pending' }],
  ]);
  let release;
  const connect = async ({ serverId }) => {
    if (serverId === 'one') await new Promise((resolve) => { release = resolve; });
    return fakeAdapter(serverId);
  };
  const supervisor = createMcpRuntimeSupervisor({
    maxConcurrent: 1,
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect,
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  const pending = supervisor.startServer('one');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(supervisor.startServer('two'), { code: 'MCP_RUNTIME_CAPACITY_REACHED' });
  release();
  await pending;
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, ['one']);
  await supervisor.closeAll();
});

test('runtime supervisor closes a runtime when registry reconciliation sees disabled or removed servers', async () => {
  const servers = new Map([
    ['disabled', { id: 'disabled', transport: 'stdio', status: 'pending' }],
    ['removed', { id: 'removed', transport: 'stdio', status: 'pending' }],
  ]);
  const closed = [];
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async ({ serverId }) => fakeAdapter(serverId, () => closed.push(serverId)),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('disabled');
  await supervisor.startServer('removed');
  servers.set('disabled', { ...servers.get('disabled'), status: 'disabled' });
  servers.delete('removed');
  const result = await supervisor.reconcile();
  assert.equal(result.stopped, 2);
  assert.deepEqual(closed.sort(), ['disabled', 'removed']);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});

test('runtime supervisor tears down an adapter if discovery fails or the server is disabled during startup', async () => {
  let closeCount = 0;
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async ({ serverId }) => fakeAdapter(serverId, () => { closeCount += 1; }),
    discover: async () => { throw Object.assign(new Error('discovery failed'), { code: 'MCP_DISCOVERY_FAILED' }); },
  });
  await assert.rejects(supervisor.startServer('one'), { code: 'MCP_DISCOVERY_FAILED' });
  assert.equal(closeCount, 1);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});
