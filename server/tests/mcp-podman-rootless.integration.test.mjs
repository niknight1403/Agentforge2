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
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
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
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.deepEqual(after, before, 'the integration runner must leave no MCP container behind');
});


test('rootless Podman runtimes are isolated per server and one stop leaves the other alive', {
  skip: !image,
  timeout: 90_000,
}, async () => {
  const listContainers = () => execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const before = listContainers();
  const makeAdapter = () => {
    const serverId = randomUUID();
    const profile = Object.freeze({
      backend: 'podman-rootless', image,
      memoryBytes: 256 * 1024 * 1024, cpuQuotaMicros: 50_000,
      pidsLimit: 64, timeoutMs: 30_000, network: 'none',
      rootlessRequired: true, readOnlyRootRequired: true,
      noNewPrivilegesRequired: true, dropAllCapabilitiesRequired: true,
      hubDataMountsAllowed: false, runtimeSocketAllowed: false,
    });
    return connectMcpPodmanServer({
      serverId, profile,
      onProcessExit: (event) => console.error('MCP_PROCESS_EXIT_DIAGNOSTIC', JSON.stringify(event)),
      getServer: (id) => id === serverId
        ? { id, transport: 'stdio', status: 'pending', authMode: 'none' }
        : null,
    });
  };
  const first = await makeAdapter();
  const second = await makeAdapter();
  try {
    assert.ok((await first.listTools()).tools.some((tool) => tool.name === 'healthcheck'));
    assert.ok((await second.listTools()).tools.some((tool) => tool.name === 'healthcheck'));
    await first.close();
    const remaining = listContainers();
    assert.equal(remaining.length, before.length + 1,
      'stopping one server must leave exactly the other new container running');
    const survivor = remaining.find((name) => !before.includes(name));
    const survivorState = JSON.parse(execFileSync('/usr/bin/podman', [
      'inspect', survivor, '--format', '{{json .State}}',
    ], { encoding: 'utf8' }));
    assert.equal(survivorState.Status, 'running',
      `the second container must remain running after first.close(); state=${JSON.stringify(survivorState)}`);
    const result = await second.callTool({ name: 'healthcheck', arguments: {} });
    assert.equal(result.content?.[0]?.text, 'rootless-podman-ok');
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
  assert.deepEqual(listContainers(), before, 'both isolated containers must be removed after shutdown');
});

test('rootless Podman container crash is observable and cleanup removes the exited container', {
  skip: !image,
  timeout: 90_000,
}, async () => {
  const before = execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const serverId = randomUUID();
  const profile = Object.freeze({
    backend: 'podman-rootless', image,
    memoryBytes: 256 * 1024 * 1024, cpuQuotaMicros: 50_000,
    pidsLimit: 64, timeoutMs: 30_000, network: 'none',
    rootlessRequired: true, readOnlyRootRequired: true,
    noNewPrivilegesRequired: true, dropAllCapabilitiesRequired: true,
    hubDataMountsAllowed: false, runtimeSocketAllowed: false,
  });
  const adapter = await connectMcpPodmanServer({
    serverId, profile,
    onProcessExit: (event) => console.error('MCP_PROCESS_EXIT_DIAGNOSTIC', JSON.stringify(event)),
    getServer: (id) => id === serverId
      ? { id, transport: 'stdio', status: 'pending', authMode: 'none' }
      : null,
  });
  try {
    const crashObserved = await Promise.race([
      adapter.callTool({ name: 'crash', arguments: {} }).then(
        () => false,
        () => true,
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    assert.equal(crashObserved, true, 'the MCP client must observe the container process crash');
  } finally {
    await adapter.close();
  }
  const after = execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(after, before, 'crashed MCP container must not remain in Podman storage');
});


test('runtime deadline force-removes a SIGTERM-resistant rootless container', {
  skip: !image,
  timeout: 30_000,
}, async () => {
  const listContainers = () => execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8', timeout: 5_000 }).trim().split('\\n').filter(Boolean).sort();
  const before = listContainers();
  const serverId = randomUUID();
  const profile = Object.freeze({
    backend: 'podman-rootless', image,
    memoryBytes: 256 * 1024 * 1024, cpuQuotaMicros: 50_000,
    pidsLimit: 64, timeoutMs: 1_000, network: 'none',
    rootlessRequired: true, readOnlyRootRequired: true,
    noNewPrivilegesRequired: true, dropAllCapabilitiesRequired: true,
    hubDataMountsAllowed: false, runtimeSocketAllowed: false,
  });
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const adapter = await connectMcpPodmanServer({
    serverId, profile,
    onProcessExit: (event) => resolveExit(event),
    getServer: (id) => id === serverId
      ? { id, transport: 'stdio', status: 'pending', authMode: 'none' }
      : null,
  });
  // This tool never responds and ignores SIGTERM. The only expected shutdown
  // trigger is the deployment-owned runtime deadline, which must force-remove
  // the named container without waiting for the outstanding MCP request.
  void adapter.callTool({ name: 'resist', arguments: {} }).catch(() => {});
  const exitEvent = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  assert.ok(exitEvent, 'the deployment-owned runtime deadline must terminate the Podman process');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(listContainers(), before,
    'the SIGTERM-resistant container must be force-removed at its runtime deadline');
});
