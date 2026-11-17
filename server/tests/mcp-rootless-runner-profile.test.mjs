import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpRunnerProfileProvider,
  assertMcpRootlessRunnerAvailable,
} from '../mcp-rootless-runner-profile.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const profile = (overrides = {}) => ({
  id: 'trusted-node',
  image: 'registry.example/mcp-node@' + digest,
  memoryBytes: 256 * 1024 * 1024,
  cpuQuotaMicros: 50_000,
  pidsLimit: 64,
  timeoutMs: 30_000,
  network: 'none',
  ...overrides,
});
const config = (profiles = [profile()]) => ({
  MCP_ROOTLESS_RUNNER_PROFILES_JSON: JSON.stringify({
    backend: 'podman-rootless',
    profiles,
  }),
});

test('rootless runner profile provider fails closed when deployment config is absent', () => {
  assert.throws(() => createMcpRunnerProfileProvider({ env: {} }), {
    code: 'MCP_ROOTLESS_RUNNER_NOT_CONFIGURED',
  });
});

test('accepts only immutable-image, bounded, network-disabled profiles', () => {
  const provider = createMcpRunnerProfileProvider({ env: config() });
  const value = provider.get('trusted-node');
  assert.equal(value.rootlessRequired, true);
  assert.equal(value.readOnlyRootRequired, true);
  assert.equal(value.noNewPrivilegesRequired, true);
  assert.equal(value.dropAllCapabilitiesRequired, true);
  assert.equal(value.hubDataMountsAllowed, false);
  assert.equal(value.runtimeSocketAllowed, false);
  assert.equal(value.network, 'none');
  assert.equal(provider.list().length, 1);
  assert.ok(Object.isFrozen(value));
});

test('rejects mutable image tags, network access, weak limits and duplicate ids', () => {
  for (const bad of [
    profile({ image: 'registry.example/mcp-node:latest' }),
    profile({ network: 'bridge' }),
    profile({ memoryBytes: 1024 }),
    profile({ cpuQuotaMicros: 1_000_001 }),
    profile({ pidsLimit: 1 }),
    profile({ timeoutMs: 0 }),
  ]) {
    assert.throws(() => createMcpRunnerProfileProvider({ env: config([bad]) }), {
      code: 'MCP_RUNNER_PROFILE_INVALID',
    });
  }
  assert.throws(() => createMcpRunnerProfileProvider({
    env: config([profile(), profile()]),
  }), { code: 'MCP_RUNNER_PROFILE_INVALID' });
});

test('rejects arbitrary profile fields and unknown profile ids', () => {
  assert.throws(() => createMcpRunnerProfileProvider({
    env: config([profile({ command: '/bin/sh' })]),
  }), { code: 'MCP_RUNNER_PROFILE_INVALID' });
  const provider = createMcpRunnerProfileProvider({ env: config() });
  assert.throws(() => provider.get('not-configured'), {
    code: 'MCP_RUNNER_PROFILE_NOT_FOUND',
  });
});

test('never reports runner availability until a real backend is implemented', () => {
  assert.throws(() => assertMcpRootlessRunnerAvailable({
    env: { MCP_ROOTLESS_RUNNER_ENABLED: 'true' },
    probe: async () => ({ rootless: true }),
  }), { code: 'MCP_ROOTLESS_RUNNER_UNAVAILABLE' });
  assert.throws(() => assertMcpRootlessRunnerAvailable({
    env: { MCP_ROOTLESS_RUNNER_ENABLED: 'false' },
    probe: async () => ({}),
  }), { code: 'MCP_ROOTLESS_RUNNER_DISABLED' });
});
