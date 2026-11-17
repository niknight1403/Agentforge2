import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpRootlessProfileProvider } from '../mcp-rootless-profile-registry.mjs';

const serverId = '12345678-1234-4234-8234-123456789abc';
const validProfile = () => ({
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
});
const policy = (profiles) => JSON.stringify({ profiles });

test('profile provider resolves only an exact registered server ID', () => {
  const resolve = createMcpRootlessProfileProvider({
    env: { MCP_ROOTLESS_RUNNER_PROFILES_JSON: policy([{ serverId, profile: validProfile() }]) },
  });
  const result = resolve(serverId);
  assert.equal(result.image, validProfile().image);
  assert.ok(Object.isFrozen(result));
  assert.throws(() => resolve('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
    code: 'MCP_ROOTLESS_PROFILE_NOT_FOUND',
  });
});

test('profile provider rejects missing, duplicate and malformed deployment policy', () => {
  assert.throws(() => createMcpRootlessProfileProvider({
    env: {},
  })(serverId), { code: 'MCP_ROOTLESS_PROFILE_POLICY_NOT_CONFIGURED' });
  assert.throws(() => createMcpRootlessProfileProvider({
    env: { MCP_ROOTLESS_RUNNER_PROFILES_JSON: '{bad json' },
  })(serverId), { code: 'MCP_ROOTLESS_PROFILE_POLICY_INVALID' });
  assert.throws(() => createMcpRootlessProfileProvider({
    env: { MCP_ROOTLESS_RUNNER_PROFILES_JSON: policy([
      { serverId, profile: validProfile() }, { serverId, profile: validProfile() },
    ]) },
  })(serverId), { code: 'MCP_ROOTLESS_PROFILE_NOT_FOUND' });
});

test('profile provider rejects registry-controlled and weakened runtime settings', () => {
  const badProfiles = [
    { ...validProfile(), command: '/bin/sh' },
    { ...validProfile(), network: 'bridge' },
    { ...validProfile(), image: 'registry.example/mcp-server:latest' },
    { ...validProfile(), memoryBytes: Number.MAX_SAFE_INTEGER },
  ];
  for (const profile of badProfiles) {
    const resolve = createMcpRootlessProfileProvider({
      env: { MCP_ROOTLESS_RUNNER_PROFILES_JSON: policy([{ serverId, profile }]) },
    });
    assert.throws(() => resolve(serverId), {
      code: 'MCP_ROOTLESS_PROFILE_POLICY_INVALID',
    });
  }
});

test('profile provider rejects unknown top-level and malformed server identity', () => {
  const resolve = createMcpRootlessProfileProvider({
    env: { MCP_ROOTLESS_RUNNER_PROFILES_JSON: JSON.stringify({
      profiles: [{ serverId, profile: validProfile() }],
      fallback: { image: 'untrusted' },
    }) },
  });
  assert.throws(() => resolve(serverId), {
    code: 'MCP_ROOTLESS_PROFILE_POLICY_INVALID',
  });
  assert.throws(() => resolve('../other-server'), {
    code: 'MCP_ROOTLESS_PROFILE_SERVER_ID_INVALID',
  });
});
