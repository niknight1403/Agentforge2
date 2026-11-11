import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.MCP_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');

const { registerMcpServer } = await import('../mcp-registry.mjs');
const { connectMcpStdioServer } = await import('../mcp-stdio-runtime-adapter.mjs');

const policy = {
  realpath: (value) => path.resolve(value),
  allowedExecutables: ['/usr/bin/node'],
  allowedWorkingDirectories: ['/srv/mcp-sandboxes'],
  allowedEnvironmentKeys: ['LANG'],
  validateArgs: (_command, args) => args.length === 0,
};

function register(name, overrides = {}) {
  return registerMcpServer({
    name,
    transport: 'stdio',
    command: '/usr/bin/node',
    cwd: '/srv/mcp-sandboxes/demo',
    args: [],
    config: { env: { LANG: 'C.UTF-8' } },
    ...overrides,
  });
}

test('stdio adapter connects an SDK client with policy-validated launch settings', async () => {
  const server = register('stdio-adapter-success');
  let transportOptions;
  let connected = false;
  let closed = false;
  class FakeTransport {
    constructor(options) { transportOptions = options; }
    async close() { closed = true; }
  }
  class FakeClient {
    constructor(info) { assert.equal(info.name, 'agentforge2-hub'); }
    async connect(transport) { assert.ok(transport instanceof FakeTransport); connected = true; }
    async listTools() { return { tools: [{ name: 'ping' }] }; }
    async callTool(params) { return { content: [{ type: 'text', text: params.name }] }; }
    async close() { closed = true; }
  }

  const adapter = await connectMcpStdioServer({
    serverId: server.id, policy, Client: FakeClient, StdioClientTransport: FakeTransport,
  });
  assert.equal(connected, true);
  assert.equal(adapter.serverId, server.id);
  assert.equal(adapter.transport, 'stdio');
  assert.deepEqual(transportOptions, {
    command: '/usr/bin/node',
    args: [],
    cwd: '/srv/mcp-sandboxes/demo',
    env: { LANG: 'C.UTF-8', HOME: '', LOGNAME: '', PATH: '', SHELL: '', TERM: '', USER: '' },
  });
  assert.deepEqual(await adapter.listTools(), { tools: [{ name: 'ping' }] });
  assert.deepEqual(await adapter.callTool({ name: 'ping', arguments: {} }), {
    content: [{ type: 'text', text: 'ping' }],
  });
  await adapter.close();
  assert.equal(closed, true);
  await assert.rejects(adapter.listTools(), { code: 'MCP_CLIENT_CLOSED' });
});

test('stdio adapter rejects a registered server that is not stdio', async () => {
  const server = register('stdio-adapter-transport-mismatch', { transport: 'http', url: 'https://mcp.example.test/mcp' });
  await assert.rejects(connectMcpStdioServer({
    serverId: server.id, policy, Client: class {}, StdioClientTransport: class {},
  }), { code: 'MCP_TRANSPORT_MISMATCH' });
});

test('stdio adapter requires SDK constructors and fails closed on policy rejection', async () => {
  const server = register('stdio-adapter-policy-reject', { command: '/bin/sh' });
  await assert.rejects(connectMcpStdioServer({ serverId: server.id, policy }), { code: 'MCP_SDK_CONSTRUCTORS_REQUIRED' });
  await assert.rejects(connectMcpStdioServer({
    serverId: server.id, policy, Client: class {}, StdioClientTransport: class {},
  }), { code: 'MCP_EXECUTABLE_NOT_ALLOWED' });
});

test('stdio adapter closes a client when the SDK connection fails', async () => {
  const server = register('stdio-adapter-connect-failure');
  let closed = false;
  class FakeTransport {}
  class FakeClient {
    async connect() { throw new Error('simulated connect failure'); }
    async close() { closed = true; }
  }
  await assert.rejects(connectMcpStdioServer({
    serverId: server.id, policy, Client: FakeClient, StdioClientTransport: FakeTransport,
  }), { code: 'MCP_CONNECT_FAILED' });
  assert.equal(closed, true);
});

test('stdio adapter times out SDK connection and tears it down', async () => {
  const server = register('stdio-adapter-connect-timeout');
  let closed = false;
  class FakeTransport {}
  class FakeClient {
    connect() { return new Promise(() => {}); }
    async close() { closed = true; }
  }
  await assert.rejects(connectMcpStdioServer({
    serverId: server.id, policy, Client: FakeClient, StdioClientTransport: FakeTransport,
    connectTimeoutMs: 100,
  }), { code: 'MCP_CONNECT_TIMEOUT' });
  assert.equal(closed, true);
});
