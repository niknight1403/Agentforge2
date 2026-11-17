import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.MCP_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
const { db } = await import('../db.mjs');
const { registerMcpServer, replaceMcpServerTools, setMcpToolPolicy, setMcpServerStatus } = await import('../mcp-registry.mjs');
const { executeApprovedMcpTool } = await import('../mcp-tool-execution.mjs');

function setup(name) {
  const server = registerMcpServer({ name, transport: 'stdio', command: '/usr/bin/node' });
  const [tool] = replaceMcpServerTools(server.id, [{ name: 'safe_lookup', inputSchema: { type: 'object' } }]);
  return { server, tool };
}

test('execution requires active server and explicit tool approval', async () => {
  const { server, tool } = setup('exec-approval-gate');
  let called = false;
  const client = { serverId: server.id, async callTool() { called = true; return { content: [] }; } };
  await assert.rejects(executeApprovedMcpTool({ serverId: server.id, toolName: tool.name, client }), { code: 'MCP_SERVER_NOT_ACTIVE' });
  setMcpServerStatus(server.id, 'active');
  await assert.rejects(executeApprovedMcpTool({ serverId: server.id, toolName: tool.name, client }), { code: 'MCP_TOOL_NOT_APPROVED' });
  assert.equal(called, false);
});

test('approved tool executes with bounded JSON arguments and returns SDK result', async () => {
  const { server, tool } = setup('exec-approved');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  const expected = { content: [{ type: 'text', text: 'ok' }] };
  let call;
  const result = await executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name, arguments: { query: 'hello' },
    client: { serverId: server.id, async callTool(value) { call = value; return expected; } },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(call, { name: tool.name, arguments: { query: 'hello' } });
  const row = db.prepare('SELECT * FROM mcp_tool_execution_audit WHERE server_id=? ORDER BY created_at DESC LIMIT 1').get(server.id);
  assert.equal(row.outcome, 'success');
  assert.match(row.arguments_sha256, /^[a-f0-9]{64}$/);
});

test('execution rejects oversized arguments and records a denial without calling the client', async () => {
  const { server, tool } = setup('exec-size-limit');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  let called = false;
  await assert.rejects(executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name, arguments: { payload: 'x'.repeat(70 * 1024) },
    client: { serverId: server.id, async callTool() { called = true; return {}; } },
  }), { code: 'MCP_INVALID_TOOL_ARGUMENTS' });
  assert.equal(called, false);
  const row = db.prepare('SELECT * FROM mcp_tool_execution_audit WHERE server_id=? ORDER BY created_at DESC LIMIT 1').get(server.id);
  assert.equal(row.outcome, 'denied');
});

test('execution times out and audits the failure', async () => {
  const { server, tool } = setup('exec-timeout');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  await assert.rejects(executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name, timeoutMs: 100,
    client: { serverId: server.id, callTool() { return new Promise(() => {}); } },
  }), { code: 'MCP_TOOL_EXECUTION_TIMEOUT' });
  const row = db.prepare('SELECT * FROM mcp_tool_execution_audit WHERE server_id=? ORDER BY created_at DESC LIMIT 1').get(server.id);
  assert.equal(row.outcome, 'timeout');
});

test('execution rejects oversized SDK results and audits failure', async () => {
  const { server, tool } = setup('exec-result-limit');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  await assert.rejects(executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name,
    client: { serverId: server.id, async callTool() { return { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }] }; } },
  }), { code: 'MCP_TOOL_RESULT_INVALID' });
  const row = db.prepare('SELECT * FROM mcp_tool_execution_audit WHERE server_id=? ORDER BY created_at DESC LIMIT 1').get(server.id);
  assert.equal(row.outcome, 'failed');
});

test('execution rejects non-JSON argument values before calling the client', async () => {
  const { server, tool } = setup('exec-json-values');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  let called = false;
  const client = { serverId: server.id, async callTool() { called = true; return {}; } };
  for (const argumentsValue of [
    { nested: new Date() },
    { nested: undefined },
    { nested: Number.POSITIVE_INFINITY },
    { nested: 1n },
  ]) {
    await assert.rejects(executeApprovedMcpTool({
      serverId: server.id, toolName: tool.name, arguments: argumentsValue, client,
    }), { code: 'MCP_INVALID_TOOL_ARGUMENTS' });
  }
  const circular = {};
  circular.self = circular;
  await assert.rejects(executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name, arguments: circular, client,
  }), { code: 'MCP_INVALID_TOOL_ARGUMENTS' });
  assert.equal(called, false);
  const rows = db.prepare("SELECT outcome FROM mcp_tool_execution_audit WHERE server_id=?").all(server.id);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.outcome === 'denied'));
});

test('execution rejects a client bound to a different registered server', async () => {
  const { server, tool } = setup('exec-client-binding');
  setMcpToolPolicy(tool.id, 'approved', 'reviewed');
  setMcpServerStatus(server.id, 'active');
  let called = false;
  await assert.rejects(executeApprovedMcpTool({
    serverId: server.id, toolName: tool.name,
    client: { serverId: 'another-server', async callTool() { called = true; return {}; } },
  }), { code: 'MCP_CLIENT_SERVER_MISMATCH' });
  assert.equal(called, false);
});
