import path from 'node:path';
import { isIP } from 'node:net';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireString(value, label, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw fail('MCP_INVALID_LAUNCH_CONFIG', `${label} must be a non-empty bounded string`);
  }
  return value;
}

/**
 * Validates a stdio launch request. This function never spawns a process.
 * The caller must pass the returned argv directly to spawn with shell:false
 * and must enforce OS/container isolation independently.
 */
export function validateStdioLaunch({ command, args = [], cwd, env = {} } = {}, policy = {}) {
  const executableInput = requireString(command, 'command', 1024);
  if (!path.isAbsolute(executableInput) || path.resolve(executableInput) !== executableInput) {
    throw fail('MCP_EXECUTABLE_NOT_ABSOLUTE', 'stdio executable must be a normalized absolute path');
  }
  if (typeof policy.realpath !== 'function') {
    throw fail('MCP_REALPATH_REQUIRED', 'stdio policy requires a trusted realpath resolver to prevent symlink escapes');
  }
  let executable;
  let workingDirectory;
  let realRoots;
  try {
    executable = policy.realpath(executableInput);
    workingDirectory = policy.realpath(requireString(cwd, 'cwd', 2048));
    realRoots = (policy.allowedWorkingDirectories ?? []).map((root) => policy.realpath(root));
  } catch {
    throw fail('MCP_PATH_RESOLUTION_FAILED', 'stdio executable, working directory and sandbox roots must resolve on disk');
  }
  if (!path.isAbsolute(executable) || !path.isAbsolute(workingDirectory)) {
    throw fail('MCP_PATH_RESOLUTION_FAILED', 'resolved stdio paths must be absolute');
  }
  const allowedExecutables = new Set((policy.allowedExecutables ?? []).map((item) => policy.realpath(item)));
  if (!allowedExecutables.has(executable)) {
    throw fail('MCP_EXECUTABLE_NOT_ALLOWED', 'stdio executable is not on the administrator allowlist');
  }
  if (!realRoots.some((root) => isWithin(root, workingDirectory))) {
    throw fail('MCP_WORKDIR_NOT_ALLOWED', 'stdio working directory is outside approved sandbox roots');
  }
  if (!Array.isArray(args) || args.length > (policy.maxArgs ?? 64)) {
    throw fail('MCP_INVALID_ARGUMENTS', 'stdio arguments exceed the configured limit');
  }
  if (args.some((arg) => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))) {
    throw fail('MCP_INVALID_ARGUMENTS', 'stdio arguments must be bounded strings without NUL bytes');
  }
  if (typeof policy.validateArgs !== 'function' || policy.validateArgs(executable, args) !== true) {
    throw fail('MCP_ARGUMENT_POLICY_REJECTED', 'stdio arguments did not pass the command-specific policy');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw fail('MCP_INVALID_ENV', 'stdio environment must be an object');
  }
  const allowedEnv = new Set(policy.allowedEnvironmentKeys ?? []);
  const safeEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allowedEnv.has(key)) throw fail('MCP_ENV_KEY_NOT_ALLOWED', `stdio environment key ${key} is not allowlisted`);
    if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
      throw fail('MCP_INVALID_ENV', `stdio environment value for ${key} is invalid`);
    }
    safeEnv[key] = value;
  }
  return { command: executable, args: [...args], cwd: workingDirectory, env: safeEnv, shell: false };
}

/**
 * Validates both the DNS result and the address set that the transport MUST
 * pin at connect time. It does not resolve DNS or create a socket itself.
 */
export function validateRemoteEndpoint({ url, resolvedAddresses } = {}, policy = {}) {
  let parsed;
  try { parsed = new URL(requireString(url, 'url', 4096)); } catch (error) {
    if (error.code) throw error;
    throw fail('MCP_INVALID_REMOTE_URL', 'remote MCP URL is invalid');
  }
  const allowedProtocols = policy.allowInsecureTransport ? ['https:', 'wss:', 'http:', 'ws:'] : ['https:', 'wss:'];
  if (!allowedProtocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw fail('MCP_REMOTE_SCHEME_REJECTED', 'remote MCP transport must use an approved secure scheme without credentials or fragments');
  }
  const host = parsed.hostname.toLowerCase();
  if (!new Set(policy.allowedHosts ?? []).has(host)) {
    throw fail('MCP_REMOTE_HOST_NOT_ALLOWED', 'remote MCP host is not on the administrator allowlist');
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80);
  if (!new Set(policy.allowedPorts ?? [443]).has(port)) {
    throw fail('MCP_REMOTE_PORT_NOT_ALLOWED', 'remote MCP port is not on the administrator allowlist');
  }
  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length < 1 || resolvedAddresses.length > 16) {
    throw fail('MCP_DNS_RESULT_REQUIRED', 'one to sixteen resolved IP addresses are required before connecting');
  }
  const pinned = [...new Set(resolvedAddresses)];
  const allowedAddresses = new Set(policy.allowedResolvedAddresses ?? []);
  for (const address of pinned) {
    if (typeof address !== 'string' || !isIP(address) || !allowedAddresses.has(address)) {
      throw fail('MCP_RESOLVED_ADDRESS_NOT_ALLOWED', 'every resolved IP address must be explicitly allowlisted');
    }
  }
  return { url: parsed.toString(), hostname: host, port, pinnedAddresses: pinned };
}
