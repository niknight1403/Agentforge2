import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMcpPodmanTransport } from '../mcp-podman-transport.mjs';

const profile = {
  image: 'registry.example/mcp-server@sha256:' + 'b'.repeat(64),
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
};

function fakeSpawn(calls, existsCode = 1) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 2_000_000 + calls.length;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    if (args[0] === 'run') {
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('finish', () => {
        child.exitCode = 0;
        child.emit('exit', 0);
      });
      queueMicrotask(() => child.emit('spawn'));
    } else {
      queueMicrotask(() => {
        child.exitCode = args[0] === 'container' ? existsCode : 0;
        child.emit('close', child.exitCode);
      });
    }
    return child;
  };
}

test('Podman transport probes rootless runtime, starts without shell and closes idempotently', async () => {
  const calls = [];
  const transport = createMcpPodmanTransport({
    profile,
    podmanPath: '/usr/bin/podman',
    spawnProcess: fakeSpawn(calls),
    probe: async () => ({ available: true, rootless: true }),
  });
  await transport.start();
  assert.equal(calls[0].command, '/usr/bin/podman');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args[0], 'run');
  assert.ok(calls[0].args.includes('--network=none'));
  await Promise.all([transport.close(), transport.close()]);
  assert.equal(calls.filter((call) => call.args[0] === 'container').length, 1);
  assert.equal(calls.some((call) => call.args[0] === 'rm'), false);
});

test('Podman transport force-removes a container that remains after transport close', async () => {
  const calls = [];
  const transport = createMcpPodmanTransport({
    profile,
    podmanPath: '/usr/bin/podman',
    spawnProcess: fakeSpawn(calls, 0),
    probe: async () => ({ available: true, rootless: true }),
  });
  await transport.start();
  await transport.close();
  assert.ok(calls.some((call) => call.args[0] === 'rm'
    && call.args[1] === '--force'));
});

test('Podman transport refuses to start if rootless capability is not verified', async () => {
  const calls = [];
  const transport = createMcpPodmanTransport({
    profile,
    podmanPath: '/usr/bin/podman',
    spawnProcess: fakeSpawn(calls),
    probe: async () => ({ available: false, rootless: false }),
  });
  await assert.rejects(transport.start(), { code: 'MCP_PODMAN_NOT_ROOTLESS' });
  assert.equal(calls.length, 0);
});
