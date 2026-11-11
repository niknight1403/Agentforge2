import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

process.env.MCP_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');

const { registerMcpServer } = await import('../mcp-registry.mjs');
const { connectMcpStdioServer } = await import('../mcp-stdio-runtime-adapter.mjs');

let Client;
let StdioClientTransport;
let sdkAvailable = true;
try {
  ({ Client } = await import('@modelcontextprotocol/client'));
  ({ StdioClientTransport } = await import('@modelcontextprotocol/client/stdio'));
} catch {
  sdkAvailable = false;
}

test('official MCP SDK completes a real disposable stdio handshake and tool call', {
  skip: !sdkAvailable && 'Install the pinned @modelcontextprotocol/client package to run this integration test',
  timeout: 15_000,
}, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agentforge-mcp-stdio-'));
  const node = realpathSync(process.execPath);
  const serverSource = String.raw`
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
    rl.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { process.exitCode = 2; return; }
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentforge-disposable-stdio', version: '1.0.0' }
        }});
      } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
          name: 'ping', description: 'Return pong', inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }]}});
      } else if (message.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });
      } else if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    });
  `;
  const server = registerMcpServer({
    name: 'official-sdk-disposable-stdio-integration',
    transport: 'stdio',
    command: node,
    cwd,
    args: ['-e', serverSource],
    config: { env: { LANG: 'C.UTF-8' } },
  });
  const policy = {
    realpath: (value) => realpathSync(value),
    allowedExecutables: [node],
    allowedWorkingDirectories: [cwd],
    allowedEnvironmentKeys: ['LANG'],
    validateArgs: (_command, args) => args.length === 2 && args[0] === '-e' && args[1] === serverSource,
  };

  let adapter;
  try {
    adapter = await connectMcpStdioServer({
      serverId: server.id,
      policy,
      Client,
      StdioClientTransport,
      connectTimeoutMs: 8_000,
    });
    const discovered = await adapter.listTools();
    assert.deepEqual(discovered.tools.map((tool) => tool.name), ['ping']);
    const result = await adapter.callTool({ name: 'ping', arguments: {} });
    assert.equal(result.content?.[0]?.text, 'pong');
  } finally {
    if (adapter) await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
