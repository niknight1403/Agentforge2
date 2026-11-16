import process from 'node:process';

const MAX_PROFILE_BYTES = 32 * 1024;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedString(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw fail('MCP_RUNNER_PROFILE_INVALID', label + ' must be a bounded non-empty string');
  }
  return value;
}

/**
 * Reads deployment-owned rootless runner profiles.
 *
 * This module deliberately does not spawn a runtime. It validates the
 * deployment contract only; execution remains unavailable until a backend
 * with capability probing and adversarial integration coverage is installed.
 *
 * JSON:
 * {
 *   "backend": "podman-rootless",
 *   "profiles": [{
 *     "id": "trusted-node",
 *     "image": "registry.example/mcp-node@sha256:<64 hex>",
 *     "memoryBytes": 268435456,
 *     "cpuQuotaMicros": 50000,
 *     "pidsLimit": 64,
 *     "timeoutMs": 30000,
 *     "network": "none"
 *   }]
 * }
 */
export function createMcpRunnerProfileProvider({
  env = process.env,
  maxProfiles = 32,
} = {}) {
  if (!env || typeof env !== 'object' || !Number.isInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 128) {
    throw new TypeError('env and a bounded maxProfiles value are required');
  }

  let parsed;
  try {
    const raw = env.MCP_ROOTLESS_RUNNER_PROFILES_JSON;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw fail('MCP_ROOTLESS_RUNNER_NOT_CONFIGURED', 'Rootless MCP runner profiles are not configured');
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_PROFILE_BYTES) {
      throw fail('MCP_RUNNER_PROFILE_INVALID', 'Runner profile configuration exceeds 32 KiB');
    }
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error?.code) throw error;
    throw fail('MCP_RUNNER_PROFILE_INVALID', 'Runner profile configuration must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => !['backend', 'profiles'].includes(key))
    || parsed.backend !== 'podman-rootless'
    || !Array.isArray(parsed.profiles) || parsed.profiles.length > maxProfiles) {
    throw fail('MCP_RUNNER_PROFILE_INVALID', 'Only the podman-rootless backend and a bounded profiles array are supported');
  }

  const profiles = new Map();
  for (const item of parsed.profiles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => ![
        'id', 'image', 'memoryBytes', 'cpuQuotaMicros', 'pidsLimit', 'timeoutMs', 'network',
      ].includes(key))) {
      throw fail('MCP_RUNNER_PROFILE_INVALID', 'Runner profile contains unsupported fields');
    }
    const id = boundedString(item.id, 'profile id', 64);
    if (!PROFILE_ID.test(id) || profiles.has(id)) {
      throw fail('MCP_RUNNER_PROFILE_INVALID', 'Runner profile ids must be unique lowercase identifiers');
    }
    const image = boundedString(item.image, 'image reference', 512);
    if (!image.includes('@') || !DIGEST.test(image.slice(image.lastIndexOf('@') + 1))) {
      throw fail('MCP_RUNNER_PROFILE_INVALID', 'Runner images must be pinned by immutable sha256 digest');
    }
    const limits = [
      ['memoryBytes', item.memoryBytes, 64 * 1024 * 1024, 2 * 1024 * 1024 * 1024],
      ['cpuQuotaMicros', item.cpuQuotaMicros, 10_000, 1_000_000],
      ['pidsLimit', item.pidsLimit, 16, 512],
      ['timeoutMs', item.timeoutMs, 1_000, 300_000],
    ];
    for (const [name, value, min, max] of limits) {
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw fail('MCP_RUNNER_PROFILE_INVALID', name + ' is outside the permitted range');
      }
    }
    if (item.network !== 'none') {
      throw fail('MCP_RUNNER_PROFILE_INVALID', 'Only network=none is currently supported by the fail-closed profile schema');
    }
    profiles.set(id, Object.freeze({
      id, image,
      memoryBytes: item.memoryBytes,
      cpuQuotaMicros: item.cpuQuotaMicros,
      pidsLimit: item.pidsLimit,
      timeoutMs: item.timeoutMs,
      network: 'none',
      rootlessRequired: true,
      readOnlyRootRequired: true,
      noNewPrivilegesRequired: true,
      dropAllCapabilitiesRequired: true,
      hubDataMountsAllowed: false,
      runtimeSocketAllowed: false,
    }));
  }

  return Object.freeze({
    backend: 'podman-rootless',
    get(profileId) {
      if (typeof profileId !== 'string' || !profiles.has(profileId)) {
        throw fail('MCP_RUNNER_PROFILE_NOT_FOUND', 'No deployment-owned rootless runner profile matches this server');
      }
      return profiles.get(profileId);
    },
    list() {
      return [...profiles.values()];
    },
  });
}

export function assertMcpRootlessRunnerAvailable({ env = process.env, probe } = {}) {
  if (env.MCP_ROOTLESS_RUNNER_ENABLED !== 'true') {
    throw fail('MCP_ROOTLESS_RUNNER_DISABLED', 'Rootless MCP runner is not enabled by deployment configuration');
  }
  if (typeof probe !== 'function') {
    throw fail('MCP_ROOTLESS_RUNNER_UNAVAILABLE', 'Rootless MCP runner capability probe is not installed');
  }
  throw fail('MCP_ROOTLESS_RUNNER_UNAVAILABLE', 'Rootless MCP runner backend is not implemented; shared-Hub execution is not a fallback');
}
