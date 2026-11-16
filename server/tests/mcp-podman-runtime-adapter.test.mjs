import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMcpPodmanServer } from '../mcp-podman-runtime-adapter.mjs';

function server(overrides = {}) {
  return {
    id: 'server-123',
    transport: 'stdio',
    status: 'pending',
    authMode: 'none',
    ...overrides,
  };
}

function dependencies({ registered = server(), connect = async () => {}, tools = [{ name: 'ping' }] } = {}) {
  const calls = [];
  const transport = {
    async close() { calls.push('transport.close'); },
  };
  class Client {
    constructor(info) { calls.push(['client.new', info]); }
    async connect(value) { calls.push('client.connect'); assert.equal(value, transport); return connect(); }
    async listTools() { calls.push('client.listTools'); return { tools }; }
    async callTool(params) { calls.push(['client.callTool', params]); return { content: [] }; }
    async close() { calls.push('client.close'); }
  }
  return {
    calls,
    options: {
      serverId: 'server-123',
      profile: Object.freeze({ image: 'registry.example/mcp@sha256:abc' }),
      getServer: (id) => id === 'server-123' ? registered : null,
      Client,
      transportFactory: () => transport,
    },
  };
}

test('Podman adapter connects, exposes MCP operations and closes both resources', async () => {
  const { calls, options } = dependencies();
  const adapter = await connectMcpPodmanServer(options);
  assert.equal(adapter.transport, 'podman-rootless');
  assert.deepEqual((await adapter.listTools()).tools, [{ name: 'ping' }]);
  await adapter.callTool({ name: 'ping', arguments: {} });
  await adapter.close();
  await adapter.close();
  assert.equal(calls.filter((call) => call === 'client.close').length, 1);
  assert.equal(calls.filter((call) => call === 'transport.close').length, 1);
  await assert.rejects(adapter.listTools(), { code: 'MCP_CLIENT_CLOSED' });
});

test('Podman adapter treats an already-closed SDK connection as a completed client shutdown', async () => {
  const { options, calls } = dependencies();
  let transportClosed = false;
  options.Client = class {
    async connect() {}
    async close() {
      const error = new Error('Connection closed');
      error.code = 'CONNECTION_CLOSED';
      throw error;
    }
  };
  options.transportFactory = () => ({
    async close() { transportClosed = true; calls.push('transport.close.after-exit'); },
  });
  const adapter = await connectMcpPodmanServer(options);
  await adapter.close();
  assert.equal(transportClosed, true);
  assert.ok(calls.includes('transport.close.after-exit'));
});

test('Podman adapter refuses unregistered, non-stdio and authenticated servers', async () => {
  const missing = dependencies();
  missing.options.getServer = () => null;
  await assert.rejects(connectMcpPodmanServer(missing.options), { code: 'MCP_SERVER_NOT_FOUND' });

  const remote = dependencies({ registered: server({ transport: 'http' }) });
  await assert.rejects(connectMcpPodmanServer(remote.options), { code: 'MCP_TRANSPORT_MISMATCH' });

  const authenticated = dependencies({ registered: server({ authMode: 'bearer', credentialRef: 'vault:secret' }) });
  await assert.rejects(connectMcpPodmanServer(authenticated.options), { code: 'MCP_PODMAN_CREDENTIAL_CHANNEL_UNAVAILABLE' });
  assert.equal(authenticated.calls.length, 0);
});

test('Podman adapter closes client and transport when initialization fails', async () => {
  const { calls, options } = dependencies({
    connect: async () => { throw new Error('connection refused'); },
  });
  await assert.rejects(connectMcpPodmanServer(options), { code: 'MCP_PODMAN_CONNECT_FAILED' });
  assert.ok(calls.includes('client.close'));
  assert.ok(calls.includes('transport.close'));
});

test('Podman adapter closes resources after initialization timeout', async () => {
  const { calls, options } = dependencies({
    connect: () => new Promise(() => {}),
  });
  options.connectTimeoutMs = 100;
  await assert.rejects(connectMcpPodmanServer(options), { code: 'MCP_PODMAN_CONNECT_TIMEOUT' });
  assert.ok(calls.includes('client.close'));
  assert.ok(calls.includes('transport.close'));
});


test('Podman adapter fails closed when the official SDK is missing or malformed', async () => {
  const missing = dependencies();
  await assert.rejects(
    connectMcpPodmanServer({
      ...missing.options,
      Client: undefined,
      loadSdk: async () => { throw new Error('module missing'); },
    }),
    { code: 'MCP_SDK_NOT_INSTALLED' },
  );

  const malformed = dependencies();
  await assert.rejects(
    connectMcpPodmanServer({
      ...malformed.options,
      Client: undefined,
      loadSdk: async () => ({ Client: null }),
    }),
    { code: 'MCP_SDK_CONSTRUCTORS_REQUIRED' },
  );
  assert.equal(malformed.calls.length, 0);
});

test('Podman adapter validates the initialization deadline before creating resources', async () => {
  const { calls, options } = dependencies();
  let transportCreated = false;
  await assert.rejects(
    connectMcpPodmanServer({
      ...options,
      connectTimeoutMs: 99,
      transportFactory: () => { transportCreated = true; return {}; },
    }),
    TypeError,
  );
  assert.equal(transportCreated, false);
  assert.equal(calls.length, 0);
});


test('Podman adapter starts client and transport shutdown together when SDK close hangs', async () => {
  const { options, calls } = dependencies();
  let transportClosed = false;
  const hangingClient = class {
    async connect() {}
    async listTools() { return { tools: [] }; }
    async callTool() { return {}; }
    close() {
      calls.push('client.close.hanging');
      return new Promise(() => {});
    }
  };
  options.Client = hangingClient;
  options.closeTimeoutMs = 100;
  options.transportFactory = () => ({
    async close() {
      calls.push('transport.close.concurrent');
      transportClosed = true;
    },
  });
  const adapter = await connectMcpPodmanServer(options);
  await assert.rejects(adapter.close(), { code: 'MCP_PODMAN_CLOSE_TIMEOUT' });
  assert.equal(transportClosed, true);
  assert.ok(calls.includes('client.close.hanging'));
});
