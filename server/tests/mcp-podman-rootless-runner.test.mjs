import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildMcpPodmanRunSpec,
  probeMcpPodmanRootless,
} from '../mcp-podman-rootless-runner.mjs';

const profile = (overrides = {}) => ({
  image: 'registry.example/mcp-server@sha256:' + 'a'.repeat(64),
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
  ...overrides,
});

test('Podman launch spec is shell-free, rootless and has no host mounts or network', () => {
  const spec = buildMcpPodmanRunSpec({
    podmanPath: '/usr/bin/podman',
    profile: profile(),
    containerName: 'agentforge-mcp-12345678-1234-1234-1234-123456789abc',
  });
  assert.equal(spec.command, '/usr/bin/podman');
  assert.equal(spec.shell, false);
  assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'ignore']);
  assert.ok(spec.args.includes('--network=none'));
  assert.ok(spec.args.includes('--read-only'));
  assert.ok(spec.args.includes('--cap-drop=ALL'));
  assert.ok(spec.args.includes('--security-opt=no-new-privileges'));
  assert.ok(spec.args.includes('--userns=auto:size=1024'));
  assert.ok(spec.args.includes('--user=1000:1000'));
  assert.ok(spec.args.includes('--pids-limit=64'));
  assert.ok(spec.args.includes('--memory=268435456'));
  assert.ok(spec.args.includes('--cpus=0.50'));
  assert.ok(!spec.args.some((arg) => arg === '-v' || arg === '--volume'
    || arg.startsWith('--volume=') || arg.startsWith('--mount=')));
  assert.ok(!spec.args.some((arg) => arg.startsWith('--env')
    || arg.startsWith('--env-file')));
  assert.equal(spec.args.at(-1), profile().image);
});

test('Podman launch spec rejects mutable images and weakened security profile', () => {
  for (const bad of [
    profile({ image: 'registry.example/mcp-server:latest' }),
    profile({ network: 'bridge' }),
    profile({ rootlessRequired: false }),
    profile({ readOnlyRootRequired: false }),
    profile({ noNewPrivilegesRequired: false }),
    profile({ dropAllCapabilitiesRequired: false }),
    profile({ hubDataMountsAllowed: true }),
    profile({ runtimeSocketAllowed: true }),
  ]) {
    assert.throws(() => buildMcpPodmanRunSpec({ profile: bad }), {
      code: 'MCP_PODMAN_PROFILE_INVALID',
    });
  }
});

test('Podman launch spec rejects unbounded or invalid resource settings', () => {
  for (const bad of [
    profile({ memoryBytes: 0 }),
    profile({ memoryBytes: 4 * 1024 * 1024 * 1024 + 1 }),
    profile({ memoryBytes: 1.5 }),
    profile({ cpuQuotaMicros: 0 }),
    profile({ cpuQuotaMicros: 400_001 }),
    profile({ pidsLimit: -1 }),
    profile({ pidsLimit: 257 }),
    profile({ timeoutMs: 999 }),
    profile({ timeoutMs: 300_001 }),
  ]) {
    assert.throws(() => buildMcpPodmanRunSpec({ profile: bad }), {
      code: 'MCP_PODMAN_PROFILE_INVALID',
    });
  }
});

test('Podman launch spec accepts documented resource boundaries', () => {
  const minimum = buildMcpPodmanRunSpec({
    profile: profile({
      memoryBytes: 16 * 1024 * 1024,
      cpuQuotaMicros: 10_000,
      pidsLimit: 1,
      timeoutMs: 1_000,
    }),
  });
  assert.ok(minimum.args.includes('--memory=16777216'));
  assert.ok(minimum.args.includes('--cpus=0.10'));
  assert.ok(minimum.args.includes('--pids-limit=1'));
  assert.equal(minimum.timeoutMs, 1_000);

  const maximum = buildMcpPodmanRunSpec({
    profile: profile({
      memoryBytes: 4 * 1024 * 1024 * 1024,
      cpuQuotaMicros: 400_000,
      pidsLimit: 256,
      timeoutMs: 300_000,
    }),
  });
  assert.ok(maximum.args.includes('--memory=4294967296'));
  assert.ok(maximum.args.includes('--cpus=4.00'));
  assert.ok(maximum.args.includes('--pids-limit=256'));
  assert.equal(maximum.timeoutMs, 300_000);
});

test('Podman executable and container name must be Hub-controlled', () => {
  assert.throws(() => buildMcpPodmanRunSpec({
    podmanPath: 'podman', profile: profile(),
  }), { code: 'MCP_PODMAN_PATH_INVALID' });
  assert.throws(() => buildMcpPodmanRunSpec({
    profile: profile(), containerName: 'attacker-controlled',
  }), { code: 'MCP_PODMAN_CONTAINER_NAME_INVALID' });
});

function fakePodmanSpawn(info, { code = 0, output } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end(output ?? JSON.stringify(info));
    child.emit('close', code);
  });
  return child;
}

test('rootless probe accepts only an explicit rootless Podman report', async () => {
  const result = await probeMcpPodmanRootless({
    podmanPath: '/usr/bin/podman',
    spawnProcess: (_command, args, options) => {
      assert.deepEqual(args, ['info', '--format', 'json']);
      assert.equal(options.shell, false);
      return fakePodmanSpawn({ host: { security: { rootless: true } } });
    },
  });
  assert.deepEqual(result, { available: true, rootless: true });
});

test('rootless probe rejects rootful, invalid and unavailable runtimes', async () => {
  await assert.rejects(probeMcpPodmanRootless({
    podmanPath: '/usr/bin/podman',
    spawnProcess: () => fakePodmanSpawn({ host: { security: { rootless: false } } }),
  }), { code: 'MCP_PODMAN_NOT_ROOTLESS' });
  await assert.rejects(probeMcpPodmanRootless({
    podmanPath: '/usr/bin/podman',
    spawnProcess: () => fakePodmanSpawn({}, { output: '{invalid' }),
  }), { code: 'MCP_PODMAN_INFO_INVALID' });
  await assert.rejects(probeMcpPodmanRootless({
    podmanPath: '/usr/bin/podman',
    spawnProcess: () => { throw new Error('not installed'); },
  }), { code: 'MCP_PODMAN_UNAVAILABLE' });
});
