import { buildMcpPodmanRunSpec } from './mcp-podman-rootless-runner.mjs';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_PROFILES = 128;
const PROFILE_KEYS = new Set([
  'image', 'memoryBytes', 'cpuQuotaMicros', 'pidsLimit', 'timeoutMs',
  'network', 'rootlessRequired', 'readOnlyRootRequired',
  'noNewPrivilegesRequired', 'dropAllCapabilitiesRequired',
  'hubDataMountsAllowed', 'runtimeSocketAllowed',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseProfiles(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw fail('MCP_ROOTLESS_PROFILE_POLICY_NOT_CONFIGURED',
      'Per-server rootless MCP execution is disabled: deployment profile policy is not configured');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) {
    throw fail('MCP_ROOTLESS_PROFILE_POLICY_INVALID', 'Rootless MCP profile policy exceeds 64 KiB');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw fail('MCP_ROOTLESS_PROFILE_POLICY_INVALID', 'Rootless MCP profile policy must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => key !== 'profiles')
    || !Array.isArray(parsed.profiles) || parsed.profiles.length > MAX_PROFILES) {
    throw fail('MCP_ROOTLESS_PROFILE_POLICY_INVALID',
      'Rootless MCP profile policy must contain only a bounded profiles array');
  }
  return parsed.profiles;
}

/**
 * Resolves immutable, deployment-owned runner profiles by registered server ID.
 * Registry fields (command, args, cwd, config, endpoint and credentials) are
 * intentionally never read. A profile is validated before it can be returned.
 */
export function createMcpRootlessProfileProvider({ env = process.env } = {}) {
  if (!env || typeof env !== 'object') throw new TypeError('env must be an object');

  return function profileForServer(serverId) {
    const id = String(serverId ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw fail('MCP_ROOTLESS_PROFILE_SERVER_ID_INVALID', 'A registered server UUID is required');
    }
    const definitions = parseProfiles(env.MCP_ROOTLESS_RUNNER_PROFILES_JSON);
    const matches = definitions.filter((item) => item && item.serverId === id);
    if (matches.length !== 1) {
      throw fail('MCP_ROOTLESS_PROFILE_NOT_FOUND',
        'Registered MCP server must have exactly one deployment-owned rootless runner profile');
    }
    const definition = matches[0];
    if (Object.keys(definition).some((key) => key !== 'serverId' && key !== 'profile')
      || !definition.profile || typeof definition.profile !== 'object'
      || Array.isArray(definition.profile)
      || Object.keys(definition.profile).some((key) => !PROFILE_KEYS.has(key))) {
      throw fail('MCP_ROOTLESS_PROFILE_POLICY_INVALID',
        'Rootless MCP profile contains unsupported deployment settings');
    }
    const profile = Object.freeze({ ...definition.profile });
    try {
      buildMcpPodmanRunSpec({ profile });
    } catch {
      throw fail('MCP_ROOTLESS_PROFILE_POLICY_INVALID',
        'Deployment-owned rootless MCP profile violates isolation or resource requirements');
    }
    return profile;
  };
}
