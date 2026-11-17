import process from 'node:process';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The current stdio adapter launches inside the Hub's own UID, mounts and
 * network namespace. Require an explicit operator acknowledgement before
 * permitting that shared trust boundary. This is NOT per-server isolation.
 */
export function assertMcpSharedNamespaceOptIn({ env = process.env } = {}) {
  if (!env || typeof env !== 'object') {
    throw new TypeError('env must be an object');
  }
  if (env.MCP_STDIO_ALLOW_SHARED_HUB_NAMESPACE !== 'true') {
    throw fail(
      'MCP_PER_SERVER_ISOLATION_REQUIRED',
      'MCP stdio startup is blocked: per-server OS/container isolation is not configured. For trusted servers only, explicitly acknowledge the shared Hub namespace with MCP_STDIO_ALLOW_SHARED_HUB_NAMESPACE=true.',
    );
  }
  return Object.freeze({
    mode: 'shared-hub-namespace',
    isolatedPerServer: false,
    untrustedServersAllowed: false,
  });
}
