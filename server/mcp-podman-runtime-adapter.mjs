import { getMcpServer } from './mcp-registry.mjs';
import { createMcpPodmanTransport } from './mcp-podman-transport.mjs';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(
        'MCP_PODMAN_CONNECT_TIMEOUT',
        'Rootless Podman MCP initialization exceeded its deadline',
      )), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Connects only to a deployment-pinned image through a rootless Podman
 * transport. Registry command/args/cwd/config and credentials are never read
 * or passed to the container. Until a dedicated credential protocol exists,
 * authenticated registry entries are rejected.
 */
export async function connectMcpPodmanServer({
  serverId,
  profile,
  getServer = getMcpServer,
  Client,
  loadSdk = async () => {
    const sdk = await import('@modelcontextprotocol/client');
    return { Client: sdk.Client };
  },
  clientInfo = { name: 'agentforge2-hub', version: '1.0.0' },
  connectTimeoutMs = 15_000,
  closeTimeoutMs = 10_000,
  transportFactory = createMcpPodmanTransport,
  onProcessExit,
} = {}) {
  const id = String(serverId ?? '');
  const server = getServer(id);
  if (!server) throw fail('MCP_SERVER_NOT_FOUND', 'MCP server is not registered');
  if (server.transport !== 'stdio') throw fail('MCP_TRANSPORT_MISMATCH', 'Only stdio MCP registrations can use the Podman image runtime');
  if (server.status === 'disabled') throw fail('MCP_SERVER_DISABLED', 'Disabled MCP servers cannot be connected');
  if (server.authMode !== 'none' || server.credentialRef) {
    throw fail('MCP_PODMAN_CREDENTIAL_CHANNEL_UNAVAILABLE',
      'Authenticated MCP servers remain disabled until a scoped runner credential channel is implemented');
  }
  if (typeof loadSdk !== 'function' || typeof transportFactory !== 'function') {
    throw new TypeError('loadSdk and transportFactory must be functions');
  }
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 120_000) {
    throw new TypeError('connectTimeoutMs must be an integer between 100 and 120000');
  }
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 100 || closeTimeoutMs > 120_000) {
    throw new TypeError('closeTimeoutMs must be an integer between 100 and 120000');
  }
  if (Client === undefined) {
    let sdk;
    try { sdk = await loadSdk(); } catch {
      throw fail('MCP_SDK_NOT_INSTALLED', 'Install the pinned @modelcontextprotocol/client production dependency');
    }
    Client = sdk?.Client;
  }
  if (typeof Client !== 'function') throw fail('MCP_SDK_CONSTRUCTORS_REQUIRED', 'The official MCP SDK Client constructor is required');

  const transport = transportFactory({ profile, onProcessExit });
  const client = new Client(clientInfo);
  let closed = false;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      // Start both shutdown paths immediately. An SDK close that never settles
      // must not prevent the transport from killing its child process/container.
      const closeResults = await Promise.allSettled([
        Promise.resolve().then(() => client.close()),
        Promise.resolve().then(() => transport.close()),
      ]);
      // A process that has already exited closes the transport before the
      // caller reaches close(). The SDK then rejects client.close() with
      // CONNECTION_CLOSED; that is an expected terminal state, not a cleanup
      // failure. Transport cleanup errors must still be surfaced.
      const [clientResult, transportResult] = closeResults;
      if (transportResult.status === 'rejected') throw transportResult.reason;
      if (clientResult.status === 'rejected'
        && clientResult.reason?.code !== 'CONNECTION_CLOSED') {
        throw clientResult.reason;
      }
    })();
    closePromise = withTimeout(closePromise, closeTimeoutMs).catch((error) => {
      if (error?.code === 'MCP_PODMAN_CONNECT_TIMEOUT') {
        throw fail('MCP_PODMAN_CLOSE_TIMEOUT', 'MCP Podman client and transport did not finish closing before the deadline');
      }
      throw error;
    });
    return closePromise;
  };

  try {
    await withTimeout(client.connect(transport), connectTimeoutMs);
    return Object.freeze({
      serverId: id,
      transport: 'podman-rootless',
      async listTools() {
        if (closed) throw fail('MCP_CLIENT_CLOSED', 'MCP Podman client is closed');
        return client.listTools();
      },
      async callTool(params) {
        if (closed) throw fail('MCP_CLIENT_CLOSED', 'MCP Podman client is closed');
        return client.callTool(params);
      },
      close,
    });
  } catch (error) {
    try { await close(); } catch { /* preserve startup failure */ }
    if (error?.code) throw error;
    throw fail('MCP_PODMAN_CONNECT_FAILED', 'Rootless Podman MCP connection failed');
  }
}
