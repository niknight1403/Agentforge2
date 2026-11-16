import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpAdminApi } from '../mcp-admin-api.mjs';

function fixture() {
  const servers = new Map([['server_1', {
    id: 'server_1', name: 'local tools', transport: 'stdio', status: 'pending',
    credentialRef: 'vault-secret-ref', config: { featureFlag: true },
  }]]);
  const tools = new Map([['tool_1', { id: 'tool_1', serverId: 'server_1', name: 'ping', policyStatus: 'pending' }]]);
  const calls = [];
  const registry = {
    registerMcpServer(input) {
      const server = { ...input, id: 'server_2', status: 'pending' };
      servers.set(server.id, server);
      return server;
    },
    listMcpServers: () => [...servers.values()],
    getMcpServer: (id) => servers.get(id) ?? null,
    listMcpTools: ({ serverId }) => [...tools.values()].filter((tool) => tool.serverId === serverId),
    setMcpToolPolicy(id, status, reason) {
      const tool = tools.get(id);
      if (!tool) return null;
      const updated = { ...tool, policyStatus: status, reason };
      tools.set(id, updated);
      return updated;
    },
    setMcpServerStatus(id, status) {
      const server = servers.get(id);
      servers.set(id, { ...server, status });
    },
    removeMcpServer(id) { return servers.delete(id); },
  };
  const supervisor = {
    async startServer(id) { calls.push(['start', id]); },
    async stopServer(id) { calls.push(['stop', id]); },
    getSnapshot: () => ({ connectedServerIds: [] }),
  };
  return { api: createMcpAdminApi({ registry, supervisor }), servers, tools, calls };
}

test('MCP admin API denies non-admin callers before touching registry', async () => {
  const { api, calls } = fixture();
  const result = await api({ method: 'GET', pathname: '/api/admin/mcp/servers' });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
});

test('MCP admin API never returns credential references or server config', async () => {
  const { api } = fixture();
  const result = await api({ method: 'GET', pathname: '/api/admin/mcp/servers', isAdmin: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.servers[0].credentialRef, undefined);
  assert.equal(result.body.servers[0].config, undefined);
});

test('MCP admin API redacts URL userinfo, path, query, fragments and process arguments', async () => {
  const { api, servers } = fixture();
  servers.set('remote_1', {
    id: 'remote_1', name: 'remote', transport: 'http', status: 'pending',
    url: 'https://alice:password@example.test/private/token-path?access_token=secret#fragment',
    command: '/usr/bin/node', cwd: '/srv/mcp',
    args: ['--token=secret-value'],
    credentialRef: 'vault-secret-ref',
    config: { env: { TOKEN: 'secret-value' } },
  });
  const result = await api({ method: 'GET', pathname: '/api/admin/mcp/servers', isAdmin: true });
  const remote = result.body.servers.find((server) => server.id === 'remote_1');
  assert.equal(remote.url, 'https://example.test');
  assert.equal(remote.argumentCount, 1);
  assert.equal(remote.args, undefined);
  assert.equal(remote.command, undefined);
  assert.equal(remote.cwd, undefined);
  assert.equal(remote.credentialRef, undefined);
  assert.equal(remote.config, undefined);
  assert.doesNotMatch(JSON.stringify(remote), /password|access_token|secret-value|token-path|fragment/);
});

test('MCP admin API registers only bounded server definitions and rejects caller launch policy', async () => {
  const { api } = fixture();
  const created = await api({
    method: 'POST', pathname: '/api/admin/mcp/servers', isAdmin: true,
    body: { name: 'new stdio', transport: 'stdio', command: '/usr/bin/node', cwd: '/srv/mcp', args: [] },
  });
  assert.equal(created.status, 201);
  const rejected = await api({
    method: 'POST', pathname: '/api/admin/mcp/servers', isAdmin: true,
    body: { name: 'bad', transport: 'stdio', command: '/bin/sh', cwd: '/', args: [], policy: { allowedExecutables: ['/bin/sh'] } },
  });
  assert.equal(rejected.status, 400);
});

test('MCP admin API explicitly starts, stops and disables through the supervisor', async () => {
  const { api, servers, calls } = fixture();
  const started = await api({ method: 'POST', pathname: '/api/admin/mcp/servers/server_1/start', isAdmin: true });
  assert.equal(started.status, 202);
  const disabled = await api({ method: 'POST', pathname: '/api/admin/mcp/servers/server_1/disable', isAdmin: true });
  assert.equal(disabled.status, 200);
  assert.equal(servers.get('server_1').status, 'disabled');
  assert.deepEqual(calls, [['start', 'server_1'], ['stop', 'server_1']]);
});

test('MCP admin API changes tool policy only through the registry policy gate', async () => {
  const { api, tools } = fixture();
  const result = await api({
    method: 'POST', pathname: '/api/admin/mcp/tools/tool_1/policy', isAdmin: true,
    body: { policyStatus: 'approved', reason: 'reviewed' },
  });
  assert.equal(result.status, 200);
  assert.equal(tools.get('tool_1').policyStatus, 'approved');
});

test('MCP admin API stops a runtime before removing its registry entry', async () => {
  const { api, servers, calls } = fixture();
  const result = await api({ method: 'DELETE', pathname: '/api/admin/mcp/servers/server_1', isAdmin: true });
  assert.equal(result.status, 200);
  assert.equal(servers.has('server_1'), false);
  assert.deepEqual(calls, [['stop', 'server_1']]);
});

test('MCP admin API returns 503 when the runtime refuses startup without per-server isolation', async () => {
  const { api } = fixture();
  const blockedApi = createMcpAdminApi({
    registry: {
      registerMcpServer: () => null,
      listMcpServers: () => [],
      getMcpServer: (id) => id === 'server_1'
        ? { id, transport: 'stdio', status: 'pending' }
        : null,
      listMcpTools: () => [],
      setMcpToolPolicy: () => null,
      setMcpServerStatus: () => {},
      removeMcpServer: () => true,
    },
    supervisor: {
      async startServer() {
        throw Object.assign(new Error('Per-server isolation is required'), {
          code: 'MCP_PER_SERVER_ISOLATION_REQUIRED',
        });
      },
      async stopServer() {},
      getSnapshot: () => ({ connectedServerIds: [] }),
    },
  });
  const result = await blockedApi({
    method: 'POST',
    pathname: '/api/admin/mcp/servers/server_1/start',
    isAdmin: true,
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'MCP_PER_SERVER_ISOLATION_REQUIRED');
});


test('MCP admin API maps Podman startup and cleanup failures to 503', async () => {
  const runtimeCodes = [
    'MCP_PODMAN_CONNECT_TIMEOUT',
    'MCP_PODMAN_CONNECT_FAILED',
    'MCP_PODMAN_CLEANUP_FAILED',
    'MCP_PODMAN_CONTROL_TIMEOUT',
    'MCP_SDK_CONSTRUCTORS_REQUIRED',
  ];
  for (const code of runtimeCodes) {
    const api = createMcpAdminApi({
      registry: {
        registerMcpServer: () => null,
        listMcpServers: () => [],
        getMcpServer: (id) => id === 'server_1'
          ? { id, transport: 'stdio', status: 'pending' }
          : null,
        listMcpTools: () => [],
        setMcpToolPolicy: () => null,
        setMcpServerStatus: () => {},
        removeMcpServer: () => true,
      },
      supervisor: {
        async startServer() {
          throw Object.assign(new Error('Podman runtime unavailable'), { code });
        },
        async stopServer() {},
        getSnapshot: () => ({ connectedServerIds: [] }),
      },
    });
    const result = await api({
      method: 'POST',
      pathname: '/api/admin/mcp/servers/server_1/start',
      isAdmin: true,
    });
    assert.equal(result.status, 503, code);
    assert.equal(result.body.code, code);
  }
});
