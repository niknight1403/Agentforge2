import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerMcpServer, getMcpServer, listMcpServers, updateMcpServer,
  setMcpServerStatus, removeMcpServer, replaceMcpServerTools,
  listMcpTools, setMcpToolPolicy, claimMcpRegistryEvents, markMcpRegistryEventPublished,
} from '../mcp-registry.mjs';

test('registry validates and persists stdio and remote transport definitions', () => {
  const stdio = registerMcpServer({ name: 'local-files', transport: 'stdio', command: 'node', args: ['server.js'] });
  assert.equal(stdio.status, 'pending');
  assert.equal(stdio.command, 'node');
  const remote = registerMcpServer({ name: 'remote-search', transport: 'http', url: 'https://mcp.example.test/rpc', authMode: 'bearer', credentialRef: 'vault:search' });
  assert.equal(remote.url, 'https://mcp.example.test/rpc');
  assert.equal(remote.credentialRef, 'vault:search');
  assert.equal(listMcpServers().length, 2);
});

test('registry rejects invalid URLs, unsupported transports and inline secrets', () => {
  assert.throws(() => registerMcpServer({ name: 'bad', transport: 'http', url: 'file:///etc/passwd' }), /URL/);
  assert.throws(() => registerMcpServer({ name: 'bad2', transport: 'mqtt', url: 'https://example.test' }), /transport/);
  assert.throws(() => registerMcpServer({ name: 'bad3', transport: 'http', url: 'https://user:pass@example.test' }), /URL/);
  assert.throws(() => registerMcpServer({ name: 'bad4', transport: 'http', url: 'https://example.test', config: { api_key: 'leak' } }), /Sensitive field/);
  assert.throws(() => registerMcpServer({ name: 'auth-missing-ref', transport: 'http', url: 'https://example.test', authMode: 'oauth2' }), /credentialRef/);
});

test('registry enforces unique names and supports lifecycle status changes', () => {
  const server = registerMcpServer({ name: 'unique-server', transport: 'stdio', command: 'node' });
  assert.throws(() => registerMcpServer({ name: 'unique-server', transport: 'stdio', command: 'node' }));
  assert.equal(setMcpServerStatus(server.id, 'active').status, 'active');
  assert.equal(setMcpServerStatus(server.id, 'degraded', { errorCode: 'E_TIMEOUT' }).consecutiveFailures, 1);
  assert.equal(setMcpServerStatus(server.id, 'active').consecutiveFailures, 0);
  assert.throws(() => setMcpServerStatus(server.id, 'unknown'));
});

test('tool discovery preserves approval only when the input schema is unchanged', () => {
  const server = registerMcpServer({ name: 'tool-server', transport: 'stdio', command: 'node' });
  let tools = replaceMcpServerTools(server.id, [{ name: 'read_pdf', description: 'Read PDF', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, capabilities: ['filesystem', 'pdf'] }]);
  const id = tools[0].id;
  assert.equal(tools[0].policyStatus, 'pending');
  setMcpToolPolicy(id, 'approved', 'read-only allowlist');
  tools = replaceMcpServerTools(server.id, [{ name: 'read_pdf', description: 'Read PDF', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, capabilities: ['filesystem', 'pdf'] }]);
  assert.equal(tools[0].policyStatus, 'approved');
  tools = replaceMcpServerTools(server.id, [{ name: 'read_pdf', inputSchema: { type: 'object', required: ['path'] } }]);
  assert.equal(tools[0].policyStatus, 'pending');
  assert.equal(tools[0].policyReason, 'schema_changed');
});

test('tool discovery is atomic and removes tools no longer advertised', () => {
  const server = registerMcpServer({ name: 'atomic-server', transport: 'stdio', command: 'node' });
  replaceMcpServerTools(server.id, [{ name: 'first' }]);
  assert.throws(() => replaceMcpServerTools(server.id, [{ name: 'second' }, { name: 'second' }]));
  assert.deepEqual(listMcpTools({ serverId: server.id }).map((tool) => tool.name), ['first']);
  assert.deepEqual(replaceMcpServerTools(server.id, [{ name: 'second' }]).map((tool) => tool.name), ['second']);
});

test('registry event outbox is claimable and idempotently marked published', () => {
  const server = registerMcpServer({ name: 'outbox-server', transport: 'stdio', command: 'node' });
  const events = claimMcpRegistryEvents();
  assert.ok(events.some((event) => event.serverId === server.id && event.type === 'mcp.server.registered'));
  const event = events.find((item) => item.serverId === server.id);
  assert.equal(markMcpRegistryEventPublished(event.id), true);
  assert.equal(markMcpRegistryEventPublished(event.id), false);
});

test('registry supports update and cascade delete', () => {
  const server = registerMcpServer({ name: 'update-server', transport: 'stdio', command: 'node' });
  replaceMcpServerTools(server.id, [{ name: 'write_file' }]);
  const updated = updateMcpServer(server.id, { transport: 'stdio', command: 'node', config: { mode: 'safe' } });
  assert.equal(updated.status, 'pending');
  assert.equal(listMcpTools({ serverId: server.id })[0].policyStatus, 'pending');
  assert.equal(removeMcpServer(server.id), true);
  assert.equal(getMcpServer(server.id), null);
  assert.equal(listMcpTools({ serverId: server.id }).length, 0);
});


test('schema fingerprints are canonical across object key ordering', () => {
  const server = registerMcpServer({ name: 'canonical-schema-server', transport: 'stdio', command: 'node' });
  const first = replaceMcpServerTools(server.id, [{
    name: 'lookup', inputSchema: { type: 'object', properties: { alpha: { type: 'string' }, beta: { type: 'number' } } },
  }])[0];
  setMcpToolPolicy(first.id, 'approved', 'reviewed');
  const second = replaceMcpServerTools(server.id, [{
    name: 'lookup', inputSchema: { properties: { beta: { type: 'number' }, alpha: { type: 'string' } }, type: 'object' },
  }])[0];
  assert.equal(second.schemaHash, first.schemaHash);
  assert.equal(second.policyStatus, 'approved');
});

test('invalid capability metadata rolls back the entire discovery snapshot', () => {
  const server = registerMcpServer({ name: 'capability-validation-server', transport: 'stdio', command: 'node' });
  replaceMcpServerTools(server.id, [{ name: 'safe_read' }]);
  assert.throws(() => replaceMcpServerTools(server.id, [
    { name: 'valid_candidate' },
    { name: 'invalid_candidate', capabilities: [''] },
  ]), /capabilities/);
  assert.deepEqual(listMcpTools({ serverId: server.id }).map((tool) => tool.name), ['safe_read']);
});
