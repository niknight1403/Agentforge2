import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.ok(spec.args.includes('--userns=auto'));
  assert.ok(spec.args.includes('--user=65532:65532'));
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

test('Podman executable and container name must be Hub-controlled', () => {
  assert.throws(() => buildMcpPodmanRunSpec({
    podmanPath: 'podman', profile: profile(),
  }), { code: 'MCP_PODMAN_PATH_INVALID' });
  assert.throws(() => buildMcpPodmanRunSpec({
    profile: profile(), containerName: 'attacker-controlled',
  }), { code: 'MCP_PODMAN_CONTAINER_NAME_INVALID' });
});

test('rootless probe rejects an installation that reports rootful mode', async () => {
  const fakeSpawn = () => {
    const { EventEmitter } = awaitImportShim();
    return null;
  };
  // A malformed/missing runtime must never be treated as available.
  await assert.rejects(probeMcpPodmanRootless({
    podmanPath: '/usr/bin/podman',
    spawnProcess: () => { throw new Error('not installed'); },
  }), { code: 'MCP_PODMAN_UNAVAILABLE' });
});
