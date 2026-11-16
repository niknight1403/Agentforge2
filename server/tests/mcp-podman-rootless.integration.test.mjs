import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connectMcpPodmanServer } from '../mcp-podman-runtime-adapter.mjs';

const image = process.env.MCP_PODMAN_INTEGRATION_IMAGE;

test('real rootless Podman initializes MCP, lists and calls a tool, then removes its container', {
  skip: !image,
  timeout: 90_000,
}, async () => {
  const before = execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
  const serverId = randomUUID();
  const profile = Object.freeze({
    backend: 'podman-rootless',
    image,
    memoryBytes: 256 * 1024 * 1024,
    cpuQuotaMicros: 50_000,
    pidsLimit: 64,
    timeoutMs: 30_000,
    network: 'none',
    rootlessRequired: true,
    readOnlyRootRequired: true,
    noNewPrivilegesRequired: true,
    dropAllCapabilitiesRequired: true,
    hubDataMountsAllowed: false,
    runtimeSocketAllowed: false,
  });
  const adapter = await connectMcpPodmanServer({
    serverId,
    profile,
    getServer: (id) => id === serverId
      ? { id, transport: 'stdio', status: 'pending', authMode: 'none' }
      : null,
  });

  try {
    const tools = await adapter.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'healthcheck'));
    const result = await adapter.callTool({ name: 'healthcheck', arguments: {} });
    assert.equal(result.content?.[0]?.text, 'rootless-podman-ok');
  } finally {
    await adapter.close();
  }

  const after = execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
  assert.deepEqual(after, before, 'the integration runner must leave no MCP container behind');
});
