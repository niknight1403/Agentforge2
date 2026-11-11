import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMcpServer, getMcpServer, listMcpTools, setMcpServerStatus } from '../mcp-registry.mjs';
import { discoverMcpServerTools } from '../mcp-transport-discovery.mjs';

function server(name) { return registerMcpServer({ name, transport: 'stdio', command: '/usr/bin/node' }); }

test('discovery persists tools and activates only after successful tools/list', async () => {
  const item = server('discovery-success');
  const result = await discoverMcpServerTools({ serverId: item.id, client: { async listTools() { return { tools: [
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'search_web', description: 'Search the web', inputSchema: { type: 'object' } },
  ] }; } } });
  assert.equal(result.count, 2);
  assert.equal(getMcpServer(item.id).status, 'active');
  assert.deepEqual(listMcpTools({ serverId: item.id }).map((tool) => tool.capabilities), [['filesystem'], ['network']]);
});

test('malformed snapshot does not partially replace tools and marks server failed', async () => {
  const item = server('discovery-atomic');
  await discoverMcpServerTools({ serverId: item.id, client: { async listTools() { return { tools: [{ name: 'safe_read' }] }; } } });
  await assert.rejects(discoverMcpServerTools({ serverId: item.id, client: { async listTools() { return { tools: [{ name: 'new_tool' }, { name: 'new_tool' }] }; } } }), { code: 'MCP_INVALID_TOOL_NAME' });
  assert.deepEqual(listMcpTools({ serverId: item.id }).map((tool) => tool.name), ['safe_read']);
  assert.equal(getMcpServer(item.id).status, 'failed');
});

test('disabled servers are rejected before listTools', async () => {
  const item = server('discovery-disabled');
  setMcpServerStatus(item.id, 'disabled');
  let called = false;
  await assert.rejects(discoverMcpServerTools({ serverId: item.id, client: { async listTools() { called = true; return { tools: [] }; } } }), { code: 'MCP_SERVER_DISABLED' });
  assert.equal(called, false);
});

test('discovery timeout closes a stalled client', async () => {
  const item = server('discovery-timeout');
  let closed = false;
  await assert.rejects(discoverMcpServerTools({ serverId: item.id, timeoutMs: 100, client: { listTools() { return new Promise(() => {}); }, async close() { closed = true; } } }), { code: 'MCP_DISCOVERY_TIMEOUT' });
  assert.equal(closed, true);
  assert.equal(getMcpServer(item.id).status, 'failed');
});


test('discovery rejects a client bound to another server before listTools', async () => {
  const item = server('discovery-client-binding');
  let called = false;
  await assert.rejects(discoverMcpServerTools({
    serverId: item.id,
    client: { serverId: 'different-server', async listTools() { called = true; return { tools: [] }; } },
  }), { code: 'MCP_CLIENT_SERVER_MISMATCH' });
  assert.equal(called, false);
  assert.equal(getMcpServer(item.id).status, 'pending');
});
