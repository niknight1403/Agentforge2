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


test('runtime deadline force-removes a SIGTERM-resistant rootless Podman container', {
  skip: !image,
  timeout: 90_000,
}, async () => {
  const listContainers = () => execFileSync('/usr/bin/podman', [
    'ps', '--all', '--filter', 'name=agentforge-mcp-', '--format', '{{.Names}}',
  ], { encoding: 'utf8', timeout: 5_000 }).trim().split('\\n').filter(Boolean).sort();
  const before = listContainers();
  const serverId = randomUUID();
  const profile = Object.freeze({
    backend: 'podman-rootless', image,
    memoryBytes: 256 * 1024 * 1024, cpuQuotaMicros: 50_000,
    pidsLimit: 64, timeoutMs: 2_000, network: 'none',
    rootlessRequired: true, readOnlyRootRequired: true,
    noNewPrivilegesRequired: true, dropAllCapabilitiesRequired: true,
    hubDataMountsAllowed: false, runtimeSocketAllowed: false,
  });
  const adapter = await connectMcpPodmanServer({
    serverId, profile,
    getServer: (id) => id === serverId
      ? { id, transport: 'stdio', status: 'pending', authMode: 'none' }
      : null,
  });

  try {
    const pending = adapter.callTool({ name: 'resist', arguments: {} }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const deadline = Date.now() + 30_000;
    const isNewContainerPresent = () => listContainers().some((name) => !before.includes(name));
    let observedContainer = false;
    while (Date.now() < deadline) {
      if (isNewContainerPresent()) {
        observedContainer = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(observedContainer, true,
      'the fixture container must be observed before testing its deadline cleanup');

    let removed = false;
    while (Date.now() < deadline) {
      if (!isNewContainerPresent()) {
        removed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(removed, true,
      'runtime deadline must force-remove the container even when PID 1 ignores SIGTERM');
    const requestOutcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 2_000)),
    ]);
    assert.equal(requestOutcome, 'rejected',
      'the MCP request must be rejected when its runtime is forcibly retired');
  } finally {
    await adapter.close();
  }
  assert.deepEqual(listContainers(), before,
    'deadline teardown must leave no rootless MCP container behind');
});
