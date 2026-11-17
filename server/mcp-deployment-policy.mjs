import process from 'node:process';
import { realpathSync } from 'node:fs';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parsePolicy(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw fail('MCP_LAUNCH_POLICY_NOT_CONFIGURED', 'External MCP stdio startup is disabled: MCP_STDIO_LAUNCH_POLICY_JSON is not configured');
  }
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    throw fail('MCP_LAUNCH_POLICY_INVALID', 'MCP stdio launch policy exceeds 64 KiB');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw fail('MCP_LAUNCH_POLICY_INVALID', 'MCP_STDIO_LAUNCH_POLICY_JSON must contain valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => key !== 'executables')
    || !Array.isArray(parsed.executables) || parsed.executables.length > 32) {
    throw fail('MCP_LAUNCH_POLICY_INVALID', 'Launch policy must contain only an executables array with at most 32 entries');
  }
  return parsed.executables;
}

/**
 * Deployment-owned, fail-closed policy provider.
 *
 * JSON shape:
 * {
 *   "executables": [{
 *     "path": "/usr/bin/node",
 *     "workingDirectories": ["/srv/mcp"],
 *     "allowedEnvironmentKeys": ["NODE_ENV"],
 *     "allowedArgs": [["/srv/mcp/server.mjs"]],
 *     "credentialEnvKey": "MCP_SERVER_TOKEN"
 *   }]
 * }
 *
 * Arguments are exact-match allowlisted per executable. The registry can
 * never add executables, working directories, environment keys, or arguments.
 */
export function createMcpDeploymentPolicyProvider({
  env = process.env,
  realpath = realpathSync,
} = {}) {
  if (!env || typeof env !== 'object' || typeof realpath !== 'function') {
    throw new TypeError('env and realpath dependencies are required');
  }

  return function policyFor(server) {
    if (!server || typeof server.command !== 'string') {
      throw fail('MCP_LAUNCH_POLICY_INVALID', 'Registered MCP server has no executable command');
    }
    const definitions = parsePolicy(env.MCP_STDIO_LAUNCH_POLICY_JSON);
    const matches = definitions.filter((item) => item && item.path === server.command);
    if (matches.length !== 1) {
      throw fail('MCP_EXECUTABLE_NOT_ALLOWED', 'Registered MCP executable is not uniquely allowlisted by deployment policy');
    }
    const item = matches[0];
    const stringArray = (value, label, max = 64) => {
      if (!Array.isArray(value) || value.length > max
        || value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.includes('\0'))) {
        throw fail('MCP_LAUNCH_POLICY_INVALID', label + ' must be a bounded array of non-empty strings');
      }
      return [...value];
    };
    const allowedExecutables = [realpath(item.path)];
    const allowedWorkingDirectories = stringArray(item.workingDirectories, 'workingDirectories', 32).map(realpath);
    const allowedEnvironmentKeys = stringArray(item.allowedEnvironmentKeys ?? [], 'allowedEnvironmentKeys', 64);
    const allowedArgs = item.allowedArgs;
    if (!Array.isArray(allowedArgs) || allowedArgs.length < 1 || allowedArgs.length > 128) {
      throw fail('MCP_LAUNCH_POLICY_INVALID', 'allowedArgs must contain one or more exact argument arrays');
    }
    const normalizedArgs = allowedArgs.map((args) => stringArray(args, 'allowedArgs entry', 64));
    const credentialEnvKey = item.credentialEnvKey ?? null;
    if (credentialEnvKey !== null
      && (typeof credentialEnvKey !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnvKey))) {
      throw fail('MCP_LAUNCH_POLICY_INVALID', 'credentialEnvKey must be a valid uppercase environment key');
    }
    const allowedKeys = new Set(allowedEnvironmentKeys);
    if (credentialEnvKey) allowedKeys.add(credentialEnvKey);
    return Object.freeze({
      realpath,
      allowedExecutables,
      allowedWorkingDirectories,
      allowedEnvironmentKeys: [...allowedKeys],
      validateArgs: (_executable, args) => normalizedArgs.some((allowed) =>
        allowed.length === args.length && allowed.every((value, index) => value === args[index])),
      ...(credentialEnvKey ? { credentialEnvKey } : {}),
    });
  };
}
