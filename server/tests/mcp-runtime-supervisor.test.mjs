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
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
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
  assert.equal(servers.get('one').status, 'pending');
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

test('runtime supervisor tears down an adapter when discovery fails', async () => {
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

test('stop cancels an in-flight startup and the late adapter is always closed', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let releaseConnect;
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async ({ serverId }) => {
      await new Promise((resolve) => { releaseConnect = resolve; });
      return fakeAdapter(serverId, () => { closeCount += 1; });
    },
    discover: async () => { throw new Error('must not discover a cancelled runtime'); },
  });
  const starting = supervisor.startServer('one');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = supervisor.stopServer('one');
  releaseConnect();
  await assert.rejects(starting, { code: 'MCP_RUNTIME_START_CANCELLED' });
  assert.equal(await stopping, true);
  assert.equal(closeCount, 1);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});

test('runtime supervisor closes and resets a server stopped during tool discovery', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let releaseDiscovery;
  let discoveryStarted;
  const started = new Promise((resolve) => { discoveryStarted = resolve; });
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => fakeAdapter(serverId, () => { closeCount += 1; }),
    discover: async ({ serverId }) => {
      discoveryStarted();
      await new Promise((resolve) => { releaseDiscovery = resolve; });
      servers.set(serverId, { ...servers.get(serverId), status: 'active' });
    },
  });
  const starting = supervisor.startServer('one');
  await started;
  const stopping = supervisor.stopServer('one');
  releaseDiscovery();
  await assert.rejects(starting, { code: 'MCP_RUNTIME_START_CANCELLED' });
  assert.equal(await stopping, true);
  assert.equal(closeCount, 1);
  assert.equal(servers.get('one').status, 'pending');
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});

test('runtime supervisor closes an adapter that is bound to a different server', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    connect: async () => fakeAdapter('foreign', () => { closeCount += 1; }),
    discover: async () => { throw new Error('foreign adapter must never reach discovery'); },
  });
  await assert.rejects(supervisor.startServer('one'), { code: 'MCP_RUNTIME_ADAPTER_INVALID' });
  assert.equal(closeCount, 1);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});

test('a concurrent restart waits for teardown instead of reusing a closing client', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let connects = 0;
  let releaseClose;
  let closeStarted;
  const closing = new Promise((resolve) => { closeStarted = resolve; });
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => {
      connects += 1;
      const generation = connects;
      return {
        ...fakeAdapter(serverId),
        async close() {
          if (generation === 1) {
            closeStarted();
            await new Promise((resolve) => { releaseClose = resolve; });
          }
        },
      };
    },
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });

  const first = await supervisor.startServer('one');
  const stopping = supervisor.stopServer('one');
  await closing;
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
  assert.deepEqual(supervisor.getSnapshot().stoppingServerIds, ['one']);
  const restarting = supervisor.startServer('one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 1, 'new process must not start before old process is closed');
  releaseClose();
  assert.equal(await stopping, true);
  const second = await restarting;
  assert.notEqual(second, first);
  assert.equal(connects, 2);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, ['one']);
  await supervisor.closeAll();
});

test('duplicate stop requests share one teardown operation', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let releaseClose;
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => ({
      ...fakeAdapter(serverId),
      async close() {
        closeCount += 1;
        await new Promise((resolve) => { releaseClose = resolve; });
      },
    }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('one');
  const firstStop = supervisor.stopServer('one');
  const secondStop = supervisor.stopServer('one');
  assert.equal(firstStop, secondStop);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCount, 1);
  releaseClose();
  assert.equal(await firstStop, true);
  assert.equal(await secondStop, true);
});

test('approved tool execution is only routed through the connected supervised client', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let received;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => fakeAdapter(serverId),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
    executeTool: async (input) => { received = input; return { ok: true }; },
  });
  await assert.rejects(
    supervisor.executeApprovedTool({ serverId: 'one', toolName: 'ping' }),
    { code: 'MCP_RUNTIME_NOT_CONNECTED' },
  );
  const adapter = await supervisor.startServer('one');
  const result = await supervisor.executeApprovedTool({
    serverId: 'one', toolName: 'ping', arguments: { value: 7 }, timeoutMs: 900,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(received.client, adapter);
  assert.equal(received.serverId, 'one');
  assert.equal(received.toolName, 'ping');
  assert.deepEqual(received.arguments, { value: 7 });
  assert.equal(received.timeoutMs, 900);
  await supervisor.stopServer('one');
  await assert.rejects(
    supervisor.executeApprovedTool({ serverId: 'one', toolName: 'ping' }),
    { code: 'MCP_RUNTIME_NOT_CONNECTED' },
  );
});

test('runtime capacity remains occupied until the old child has fully closed', async () => {
  const servers = new Map([
    ['one', { id: 'one', transport: 'stdio', status: 'pending' }],
    ['two', { id: 'two', transport: 'stdio', status: 'pending' }],
  ]);
  let releaseClose;
  const supervisor = createMcpRuntimeSupervisor({
    maxConcurrent: 1,
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => ({
      ...fakeAdapter(serverId),
      async close() {
        if (serverId === 'one') await new Promise((resolve) => { releaseClose = resolve; });
      },
    }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('one');
  const stopping = supervisor.stopServer('one');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(supervisor.startServer('two'), { code: 'MCP_RUNTIME_CAPACITY_REACHED' });
  releaseClose();
  await stopping;
  const second = await supervisor.startServer('two');
  assert.equal(second.serverId, 'two');
  await supervisor.closeAll();
});

test('the reconciliation loop closes disabled runtimes and is stopped by closeAll', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => fakeAdapter(serverId, () => { closeCount += 1; }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('one');
  servers.set('one', { ...servers.get('one'), status: 'disabled' });
  supervisor.startReconciliationLoop({
    intervalMs: 100,
    onError: (error) => { throw error; },
  });
  // The loop tick is asynchronous; wait for its first close to complete.
  for (let attempt = 0; attempt < 20 && closeCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(closeCount, 1);
  assert.equal(supervisor.getSnapshot().reconciliationLoopRunning, true);
  await supervisor.closeAll();
  assert.equal(supervisor.getSnapshot().reconciliationLoopRunning, false);
});

test('a non-cancelled connection failure is recorded in registry status', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status, options = {}) => {
      servers.set(id, { ...servers.get(id), status, lastErrorCode: options.errorCode ?? null });
    },
    connect: async () => { throw Object.assign(new Error('spawn rejected'), { code: 'MCP_EXECUTABLE_NOT_ALLOWED' }); },
    discover: async () => { throw new Error('discovery must not run'); },
  });
  await assert.rejects(supervisor.startServer('one'), { code: 'MCP_EXECUTABLE_NOT_ALLOWED' });
  assert.equal(servers.get('one').status, 'failed');
  assert.equal(servers.get('one').lastErrorCode, 'MCP_EXECUTABLE_NOT_ALLOWED');
  assert.deepEqual(supervisor.getSnapshot().startingServerIds, []);
});

test('a transport close failure marks the runtime degraded and propagates the error', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status, options = {}) => {
      servers.set(id, { ...servers.get(id), status, lastErrorCode: options.errorCode ?? null });
    },
    connect: async ({ serverId }) => ({
      ...fakeAdapter(serverId),
      async close() { throw Object.assign(new Error('transport close failed'), { code: 'MCP_TRANSPORT_CLOSE_FAILED' }); },
    }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('one');
  await assert.rejects(supervisor.stopServer('one'), { code: 'MCP_TRANSPORT_CLOSE_FAILED' });
  assert.equal(servers.get('one').status, 'degraded');
  assert.equal(servers.get('one').lastErrorCode, 'MCP_TRANSPORT_CLOSE_FAILED');
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
  assert.deepEqual(supervisor.getSnapshot().stoppingServerIds, []);
});

test('runtime shutdown drains an active approved tool call before closing its transport', async () => {
  const servers = new Map([['one', { id: 'one', transport: 'stdio', status: 'pending' }]]);
  let releaseExecution;
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  let closed = false;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => ({
      ...fakeAdapter(serverId),
      async close() { closed = true; },
    }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
    executeTool: async () => {
      executionStarted();
      return new Promise((resolve) => { releaseExecution = resolve; });
    },
  });
  await supervisor.startServer('one');
  const execution = supervisor.executeApprovedTool({ serverId: 'one', toolName: 'slow-tool' });
  await started;
  const stopping = supervisor.stopServer('one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'transport must remain alive while a tool call is in flight');
  assert.deepEqual(supervisor.getSnapshot().stoppingServerIds, ['one']);
  assert.deepEqual(supervisor.getSnapshot().activeExecutions, { one: 1 });
  releaseExecution({ ok: true });
  assert.deepEqual(await execution, { ok: true });
  assert.equal(await stopping, true);
  assert.equal(closed, true);
  assert.deepEqual(supervisor.getSnapshot().activeExecutions, {});
});

test('registry reconciliation paginates beyond the default first 100 servers', async () => {
  const servers = new Map([['last', { id: 'last', transport: 'stdio', status: 'pending' }]]);
  const offsets = [];
  let closeCount = 0;
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: ({ limit, offset }) => {
      offsets.push(offset);
      if (offset === 0) {
        return Array.from({ length: limit }, (_, index) => ({
          id: `page-one-${index}`, status: 'pending',
        }));
      }
      return [{ id: 'last', status: 'disabled' }];
    },
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => fakeAdapter(serverId, () => { closeCount += 1; }),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  await supervisor.startServer('last');
  servers.set('last', { ...servers.get('last'), status: 'disabled' });
  const result = await supervisor.reconcile();
  assert.deepEqual(offsets, [0, 500]);
  assert.deepEqual(result.staleServerIds, ['last']);
  assert.equal(result.stopped, 1);
  assert.equal(closeCount, 1);
});

test('reconciliation closes connected runtimes when registry state is degraded, failed, pending or transport changes', async () => {
  const servers = new Map([
    ['degraded', { id: 'degraded', transport: 'stdio', status: 'pending' }],
    ['failed', { id: 'failed', transport: 'stdio', status: 'pending' }],
    ['pending', { id: 'pending', transport: 'stdio', status: 'pending' }],
    ['remote', { id: 'remote', transport: 'stdio', status: 'pending' }],
  ]);
  const closed = [];
  const supervisor = createMcpRuntimeSupervisor({
    getServer: (id) => servers.get(id) ?? null,
    listServers: () => [...servers.values()],
    setStatus: (id, status) => servers.set(id, { ...servers.get(id), status }),
    connect: async ({ serverId }) => fakeAdapter(serverId, () => closed.push(serverId)),
    discover: async ({ serverId }) => servers.set(serverId, { ...servers.get(serverId), status: 'active' }),
  });
  for (const id of servers.keys()) await supervisor.startServer(id);
  servers.set('degraded', { ...servers.get('degraded'), status: 'degraded' });
  servers.set('failed', { ...servers.get('failed'), status: 'failed' });
  servers.set('pending', { ...servers.get('pending'), status: 'pending' });
  servers.set('remote', { ...servers.get('remote'), transport: 'http' });
  const result = await supervisor.reconcile();
  assert.equal(result.stopped, 4);
  assert.deepEqual(closed.sort(), ['degraded', 'failed', 'pending', 'remote']);
  assert.deepEqual(supervisor.getSnapshot().connectedServerIds, []);
});
